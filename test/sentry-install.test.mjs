/**
 * The installer of the sentry (`lib/sentry-install.js`) - and the two things
 * that must never drift:
 *
 *   1. `supervisor/sentry.js` imports NOTHING from the plugin. It is copied to
 *      `<stateDir>/sentry/sentry.js` and runs there; a plugin import would make
 *      the whole watchman fail exactly when it is needed (a cleaned profile, a
 *      rolled-back plugin tree). The assertion reads the source as TEXT.
 *   2. the decision function of the daemon and the tested copy in
 *      `lib/sentry.js` answer the SAME table of cases in the SAME way. The two
 *      functions are duplicated on purpose (the daemon cannot import the
 *      plugin), so a table is the only honest way to keep them equal.
 *
 * Nothing here registers a task, kills a process or touches a real profile:
 * every command goes through an injected executor, and every file lives in a
 * temporary directory.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  NODE_INTERPRETER_ERROR,
  SENTRY_KIT_FILES,
  UNSUPPORTED_PLATFORM,
  copyKit,
  installSentry,
  packagedPath,
  planSentryInstall,
  sentryCommandLine,
  sentryStartupCmdContent,
  sentryStatus,
  sentryTaskCreateArgs,
  sentryTaskDeleteArgs,
  sentryTaskQueryArgs,
  uninstallSentry,
  writePendingCleanup,
} from '../lib/sentry-install.js'
import {
  decideRescue as libDecideRescue,
  nextBackoffMs as libNextBackoffMs,
  parseTasklistOutput as libParseTasklistOutput,
  profileLooksSanitized as libProfileLooksSanitized,
  readConfig,
  sentryPaths,
} from '../lib/sentry.js'
import {
  decideRescue as runtimeDecideRescue,
  nextBackoffMs as runtimeNextBackoffMs,
  parseTasklistOutput as runtimeParseTasklistOutput,
  profileLooksSanitized as runtimeProfileLooksSanitized,
} from '../supervisor/sentry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)

/** A temporary directory that is removed afterwards. */
function tempDir(t, name = 'dsh-sentry-install-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the run is over anyway */
    }
  })
  return dir
}

/**
 * An executor that RECORDS every call.
 *
 * `refuse` makes it throw the way `schtasks` does when the user is not allowed
 * to create a task: a non-zero exit with a message on stderr.
 */
function fakeExec({ refuse = false, stdout = '' } = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push({ file, args: [...args] })
    if (refuse) {
      const error = new Error('ERROR: Access is denied.')
      error.status = 1
      error.stderr = 'ERROR: Access is denied.'
      throw error
    }
    return stdout
  }
  exec.calls = calls
  return exec
}

/** A configuration that is only used to build the command line. */
function planOptions(dir, overrides = {}) {
  return {
    platform: 'win32',
    nodePath: path.join(dir, 'node.exe'),
    execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    stateDir: dir,
    profileDir: path.join(dir, 'profile'),
    startupDir: path.join(dir, 'Startup'),
    appExecPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The plan: the command line, the interpreter, the platform.
// ---------------------------------------------------------------------------

test('planSentryInstall: a real node, the absolute sentry script, --config, ONLOGON', (t) => {
  const dir = tempDir(t)
  const plan = planSentryInstall(planOptions(dir))
  assert.equal(plan.kind, 'windows-schtasks')
  assert.equal(plan.error, null)
  assert.equal(plan.nodePath, path.join(dir, 'node.exe'))

  const create = plan.steps.find((step) => step.kind === 'windows-schtasks')
  assert.ok(create, 'the plan must register a scheduled task')
  assert.equal(create.file, 'schtasks')
  const args = create.args
  assert.ok(args.includes('/Create'))
  assert.ok(args.includes(SENTRY_TASK_LITERAL), 'the task name must be the documented one')
  assert.equal(args[args.indexOf('/SC') + 1], 'ONLOGON')
  assert.equal(args[args.indexOf('/RL') + 1], 'LIMITED')
  assert.ok(args.includes('/F'), 'the task must be idempotent')

  const command = args[args.indexOf('/TR') + 1]
  const scriptPath = sentryPaths(dir).runtime
  assert.ok(command.includes(path.join(dir, 'node.exe')), 'the command must name the node interpreter')
  assert.ok(command.includes(scriptPath), 'the command must name the absolute sentry script')
  assert.ok(command.includes('--config'), 'the command must pass --config')
  assert.ok(command.includes(sentryPaths(dir).config), 'the command must name the configuration file')
  assert.ok(
    command.includes(scriptPath.replace(/\\/g, '\\')),
    'the script path must be the absolute one under <stateDir>/sentry',
  )
  assert.ok(scriptPath.includes(path.join(dir, 'sentry')), 'the script lives under <stateDir>/sentry')
})

/** The literal task name (kept out of the plan so the test reads as prose). */
const SENTRY_TASK_LITERAL = 'dsh-autorestart-sentry'

test('planSentryInstall: DeepSeek Harness.exe is NEVER used as the interpreter', (t) => {
  const dir = tempDir(t)
  const plan = planSentryInstall(planOptions(dir))
  const create = plan.steps.find((step) => step.kind === 'windows-schtasks')
  const command = create.args[create.args.indexOf('/TR') + 1]
  assert.equal(command.includes('DeepSeek Harness.exe'), false, 'the app executable must not be the interpreter')
  assert.equal(plan.nodePath.endsWith('DeepSeek Harness.exe'), false)
})

test('planSentryInstall: no node on the machine means no plan', (t) => {
  const dir = tempDir(t)
  const plan = planSentryInstall({
    platform: 'win32',
    nodePath: '',
    // The desktop client IS the app executable, and there is no bundled node
    // and nothing on the PATH: the plan must refuse instead of registering a
    // task that would open a second client.
    execPath: path.join(dir, 'DeepSeek Harness.exe'),
    stateDir: dir,
    env: { PATH: '' },
    existsSyncFn: () => false,
  })
  assert.equal(plan.kind, 'none')
  assert.equal(plan.error, NODE_INTERPRETER_ERROR)
  assert.deepEqual(plan.steps, [])
})

test('planSentryInstall: every other platform is refused, and says why', (t) => {
  const dir = tempDir(t)
  for (const platform of ['linux', 'darwin']) {
    const plan = planSentryInstall({ platform, nodePath: '/usr/bin/node', stateDir: dir })
    assert.equal(plan.kind, 'none')
    assert.equal(plan.error, UNSUPPORTED_PLATFORM)
    assert.deepEqual(plan.steps, [])
    assert.match(plan.reason, /Windows/)
  }
})

test('planSentryInstall: no state directory means no plan', () => {
  const plan = planSentryInstall({ platform: 'win32', nodePath: 'C:\\node\\node.exe', stateDir: '' })
  assert.equal(plan.kind, 'none')
  assert.ok(plan.error)
})

test('the schtasks arguments are the documented ones', () => {
  const args = sentryTaskCreateArgs({
    nodePath: 'C:\\node\\node.exe',
    scriptPath: 'C:\\state\\sentry\\sentry.js',
    configPath: 'C:\\state\\sentry\\sentry.json',
  })
  assert.deepEqual(args.slice(0, 4), ['/Create', '/TN', 'dsh-autorestart-sentry', '/TR'])
  assert.equal(args[args.indexOf('/SC') + 1], 'ONLOGON')
  assert.deepEqual(sentryTaskQueryArgs(), ['/Query', '/TN', 'dsh-autorestart-sentry', '/FO', 'LIST'])
  assert.deepEqual(sentryTaskDeleteArgs(), ['/Delete', '/TN', 'dsh-autorestart-sentry', '/F'])
})

test('sentryCommandLine: quotes every part (a path with spaces is normal)', () => {
  const line = sentryCommandLine({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\state dir\\sentry\\sentry.js',
    configPath: 'C:\\state dir\\sentry\\sentry.json',
  })
  assert.equal(
    line,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\state dir\\sentry\\sentry.js" --config "C:\\state dir\\sentry\\sentry.json"',
  )
})

test('the startup .cmd is pure ASCII with CRLF lines and a detached start', () => {
  const content = sentryStartupCmdContent({
    nodePath: 'C:\\node\\node.exe',
    scriptPath: 'C:\\state\\sentry\\sentry.js',
    configPath: 'C:\\state\\sentry\\sentry.json',
  })
  for (const character of content) {
    assert.ok(character.charCodeAt(0) < 128, 'the .cmd must stay pure ASCII: ' + character)
  }
  assert.ok(content.includes('\r\n'), 'the .cmd must use CRLF')
  assert.match(content, /start "" /)
  // Every line break must be a CRLF one: a lone LF makes the .cmd unreadable
  // for cmd.exe.
  assert.doesNotMatch(content, /(?<!\r)\n/, 'every line must end with CRLF')
})

// ---------------------------------------------------------------------------
// The kit: it must be the files the daemon really needs, and they must ship.
// ---------------------------------------------------------------------------

test('the kit holds the daemon and the two scripts it runs', () => {
  const targets = SENTRY_KIT_FILES.map((entry) => entry.target)
  assert.ok(targets.includes('sentry.js'))
  assert.ok(targets.includes('clear-dsh-auth-cookies.mjs'))
  assert.ok(targets.includes('restore-profile.ps1'))
  assert.ok(targets.includes('rescue-strings.zh.json'))
  // Every listed file must really be in this package, or the installation
  // would fail on the night it is needed instead of here.
  for (const entry of SENTRY_KIT_FILES) {
    assert.ok(fs.existsSync(packagedPath(entry.source)), 'the kit source is missing: ' + entry.source.join('/'))
  }
})

test('copyKit: copies every kit file into <stateDir>/sentry/kit', (t) => {
  const dir = tempDir(t)
  const paths = sentryPaths(dir)
  const answer = copyKit({ paths })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.copied.sort(), SENTRY_KIT_FILES.map((entry) => entry.target).sort())
  for (const entry of SENTRY_KIT_FILES) {
    assert.ok(fs.existsSync(path.join(paths.kit, entry.target)))
  }
})

test('package.json ships everything the kit needs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(files.includes('supervisor/sentry.js'), 'files must include supervisor/sentry.js')
  assert.ok(files.includes('lib/**/*.js'), 'files must include the library')
  assert.ok(files.includes('scripts/*.mjs'), 'files must include the cookie script')
  assert.ok(files.includes('scripts/*.ps1'), 'files must include the restore script')
  assert.ok(files.includes('scripts/rescue-strings.zh.json'), 'files must include the wording of the restore')
  assert.ok(files.includes('docs/*.md'), 'files must include docs/sentry.md')
})

// ---------------------------------------------------------------------------
// THE TEXT ASSERTION: the daemon imports only node builtins.
// ---------------------------------------------------------------------------

test('supervisor/sentry.js imports nothing but node: builtins', () => {
  const source = fs.readFileSync(path.join(pluginDir, 'supervisor', 'sentry.js'), 'utf8')
  const specifiers = []
  const pattern = /^\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/gm
  let match = pattern.exec(source)
  while (match !== null) {
    specifiers.push(match[1])
    match = pattern.exec(source)
  }
  assert.ok(specifiers.length > 0, 'the file must import something (fs, path, http, child_process)')
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:'),
      'supervisor/sentry.js must import only node builtins, found: ' + specifier,
    )
  }
  // A relative import would be a plugin import, and the file runs from
  // <stateDir>/sentry/sentry.js where no plugin file exists.
  assert.doesNotMatch(source, /from\s+['"]\.\.?\//, 'no relative import may appear in the daemon')
  assert.doesNotMatch(source, /require\(/, 'no require in an ESM daemon')
})

test('supervisor/sentry.js is pure ASCII without a byte order mark', () => {
  const bytes = fs.readFileSync(path.join(pluginDir, 'supervisor', 'sentry.js'))
  assert.notEqual(bytes[0], 0xef, 'the daemon must not start with a UTF-8 BOM')
  for (const byte of bytes) {
    assert.ok(byte < 128, 'the daemon must stay pure ASCII (byte ' + byte + ')')
  }
})

// ---------------------------------------------------------------------------
// THE PARITY TABLE: the daemon and the tested copy must agree.
// ---------------------------------------------------------------------------

test('decideRescue: the daemon and lib/sentry.js agree on one table of cases', () => {
  const cases = [
    { name: 'idle', input: { now: 1000, processCount: 1, downSince: null } },
    { name: 'wait-no-down-since', input: { now: 1000, processCount: 0, downSince: null } },
    { name: 'wait-grace', input: { now: 1000, processCount: 0, downSince: 900, graceMs: 90000 } },
    {
      name: 'stand-down-intentional',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, cleanExitAt: 99000, graceMs: 90000 },
    },
    {
      name: 'rescue-after-old-clean-exit',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, cleanExitAt: 50000, graceMs: 90000 },
    },
    {
      name: 'stand-down-restart-in-flight',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, watchdogPending: true, graceMs: 90000 },
    },
    {
      name: 'stand-down-budget',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, attemptsInWindow: 3, maxRescuesPerHour: 3, graceMs: 90000 },
    },
    {
      name: 'give-up',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, attemptsThisBurst: 3, maxAttempts: 3, graceMs: 90000 },
    },
    {
      name: 'rescue',
      input: { now: 200000, processCount: 0, downSince: 100000, lastSeenRunningAt: 100000, graceMs: 90000 },
    },
    {
      name: 'idle-with-everything-else-true',
      input: { now: 200000, processCount: 2, downSince: 100000, cleanExitAt: 199000, watchdogPending: true, attemptsInWindow: 9 },
    },
  ]
  for (const entry of cases) {
    assert.deepEqual(
      runtimeDecideRescue(entry.input),
      libDecideRescue(entry.input),
      'the daemon and the library disagree on: ' + entry.name,
    )
  }
})

test('parseTasklistOutput: the daemon and the library agree', () => {
  const texts = [
    '"DeepSeek Harness.exe","42","Console","1","123,456 K"\r\n',
    'INFO: No tasks are running which match the specified criteria.\r\n',
    '',
    '"a.exe","1","Console","1","1 K"\r\n"a.exe","2","Console","1","1 K"\r\n',
    'INFO: Invalid argument/option - x\r\n',
  ]
  for (const text of texts) {
    assert.deepEqual(
      runtimeParseTasklistOutput(text, 'DeepSeek Harness.exe'),
      libParseTasklistOutput(text, 'DeepSeek Harness.exe'),
    )
  }
})

test('profileLooksSanitized and nextBackoffMs: the daemon and the library agree', () => {
  const profiles = [
    { currentPackageText: '{"dsh":{"profile":{"bundles":["a"]}}}', backupPackageText: '{"dsh":{"profile":{"bundles":["a"]}}}' },
    { currentPackageText: '{"dsh":{"profile":{"bundles":[]}}}', backupPackageText: '{"dsh":{"profile":{"bundles":["a"]}}}' },
    { currentPackageText: 'broken', backupPackageText: '' },
    { currentPackageText: '{"dsh":{"profile":{"bundles":["a"]}}}', currentPatchText: '[]', backupPatchText: 'insert:\n  - id: a\n' },
  ]
  for (const profile of profiles) {
    assert.deepEqual(runtimeProfileLooksSanitized(profile), libProfileLooksSanitized(profile))
  }
  for (const attempt of [1, 2, 3, 5, 20]) {
    assert.equal(runtimeNextBackoffMs(attempt), libNextBackoffMs(attempt))
  }
})

// ---------------------------------------------------------------------------
// The installation: nothing without the nod, and the degradation.
// ---------------------------------------------------------------------------

test('installSentry: confirmed != true writes NOTHING and runs NOTHING', (t) => {
  const dir = tempDir(t)
  const exec = fakeExec()
  const answer = installSentry({ ...planOptions(dir), execFileSyncFn: exec })
  assert.equal(answer.ok, false)
  assert.equal(answer.installed, false)
  assert.equal(exec.calls.length, 0, 'no command may run without the confirmation card')
  assert.equal(fs.existsSync(sentryPaths(dir).dir), false, 'no directory may be created without the card')
  assert.ok(answer.steps.length > 0, 'the plan is still handed to the caller')
})

test('installSentry: a dry run writes NOTHING and runs NOTHING', (t) => {
  const dir = tempDir(t)
  const exec = fakeExec()
  const answer = installSentry({ ...planOptions(dir), dryRun: true, confirmed: true, execFileSyncFn: exec })
  assert.equal(answer.ok, true)
  assert.equal(answer.installed, false)
  assert.equal(exec.calls.length, 0, 'a dry run may not run a command')
  assert.equal(fs.existsSync(sentryPaths(dir).dir), false, 'a dry run may not create a directory')
})

test('installSentry: a refused task degrades to the startup folder', (t) => {
  const dir = tempDir(t)
  const exec = fakeExec({ refuse: true })
  const answer = installSentry({ ...planOptions(dir), confirmed: true, execFileSyncFn: exec })
  assert.equal(answer.ok, true)
  assert.equal(answer.installed, true)
  assert.equal(answer.degraded, true)
  assert.equal(answer.kind, 'windows-startup')
  assert.ok(exec.calls.length > 0, 'the task creation must have been attempted')

  const paths = sentryPaths(dir)
  // The kit, the configuration and the .cmd are really on disk.
  assert.ok(fs.existsSync(paths.runtime), 'the daemon must be copied')
  assert.ok(fs.existsSync(paths.clearCookiesScript))
  assert.ok(fs.existsSync(paths.restoreScript))
  assert.ok(fs.existsSync(paths.startupCmd), 'the .cmd must be written in the sentry directory')
  assert.ok(fs.existsSync(path.join(dir, 'Startup', 'dsh-autorestart-sentry.cmd')), 'the .cmd must reach the startup folder')

  const cmdBytes = fs.readFileSync(paths.startupCmd)
  for (const byte of cmdBytes) assert.ok(byte < 128, 'the .cmd must stay pure ASCII')
  assert.notEqual(cmdBytes[0], 0xef, 'the .cmd must not have a BOM')

  const config = readConfig(paths.config)
  assert.equal(config.ok, true)
  assert.equal(config.config.kind, 'windows-startup', 'the configuration must say how it is registered')
  assert.equal(config.config.appImageName, 'DeepSeek Harness.exe')
  assert.equal(config.config.maxRescuesPerHour, 3)
})

test('installSentry: an allowed task is registered AND read back', (t) => {
  const dir = tempDir(t)
  const exec = fakeExec({ stdout: 'SUCCESS: The scheduled task "dsh-autorestart-sentry" has successfully been created.' })
  const answer = installSentry({ ...planOptions(dir), confirmed: true, execFileSyncFn: exec })
  assert.equal(answer.ok, true)
  assert.equal(answer.degraded, false)
  assert.equal(answer.kind, 'windows-schtasks')
  const files = exec.calls.map((call) => call.file)
  assert.ok(files.includes('schtasks'))
  const verbs = exec.calls.map((call) => call.args[0])
  assert.ok(verbs.includes('/Create'), 'the task must be created')
  assert.ok(verbs.includes('/Query'), 'the task must be read back')
  assert.ok(
    exec.calls.some((call) => call.args.includes('/FO') && call.args.includes('LIST')),
    'the read-back must ask for the list format',
  )
  assert.equal(fs.existsSync(path.join(dir, 'Startup', 'dsh-autorestart-sentry.cmd')), false, 'no fallback when the task worked')
})

test('installSentry: the configuration carries the timers, the profile and the port file', (t) => {
  const dir = tempDir(t)
  const portFile = path.join(dir, 'state', 'access.json')
  const answer = installSentry({
    ...planOptions(dir),
    confirmed: true,
    execFileSyncFn: fakeExec(),
    portFile,
    graceMs: 12345,
    intervalMs: 999,
    now: 1_700_000_000_000,
  })
  assert.equal(answer.ok, true)
  const config = readConfig(sentryPaths(dir).config)
  assert.equal(config.config.graceMs, 12345)
  assert.equal(config.config.intervalMs, 999)
  assert.equal(config.config.portFile, portFile)
  assert.equal(config.config.profileDir, path.join(dir, 'profile'))
  assert.equal(config.config.stateDir, dir)
  assert.equal(config.config.installedAt, new Date(1_700_000_000_000).toISOString())
})

test('installSentry: a kit file that is missing fails the installation instead of being skipped', (t) => {
  const dir = tempDir(t)
  const exec = fakeExec()
  const answer = installSentry({
    ...planOptions(dir),
    confirmed: true,
    execFileSyncFn: exec,
    readSourceFn: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(answer.ok, false)
  assert.match(String(answer.error), /kit could not be copied/)
  assert.equal(exec.calls.length, 0, 'no command may run when the files cannot be put down')
  assert.equal(fs.existsSync(sentryPaths(dir).dir), false, 'the half-installed directory must be taken away again')
})

test('writePendingCleanup: the to-do list lives NEXT TO the sentry directory', (t) => {
  const dir = tempDir(t)
  const written = writePendingCleanup(dir, { reason: 'test', failed: [{ kind: 'x', ok: false }], manual: ['rmdir /s /q x'] })
  assert.equal(written.ok, true)
  assert.equal(written.path, path.join(dir, 'sentry-pending-cleanup.json'))
  assert.equal(fs.existsSync(path.join(dir, 'sentry')), false, 'writing the list must not create the directory')
  const parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'))
  assert.deepEqual(parsed.manual, ['rmdir /s /q x'])
})

// ---------------------------------------------------------------------------
// The uninstall and the status: idempotent, and never a throw.
// ---------------------------------------------------------------------------

test('uninstallSentry: a dry run changes nothing', (t) => {
  const dir = tempDir(t)
  const paths = sentryPaths(dir)
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.config, '{}', 'utf8')
  const exec = fakeExec()
  const answer = uninstallSentry({ stateDir: dir, platform: 'win32', dryRun: true, execFileSyncFn: exec, startupDir: path.join(dir, 'Startup') })
  assert.equal(answer.ok, true)
  assert.equal(exec.calls.length, 0)
  assert.ok(fs.existsSync(paths.config), 'a dry run may not delete anything')
})

test('uninstallSentry: an installation that is not there is not an error', (t) => {
  const dir = tempDir(t)
  // `schtasks /Delete` on a task that does not exist: that is what the machine
  // answers, and an idempotent uninstall must read it as success.
  const missing = (file, args) => {
    const error = new Error('ERROR: The system cannot find the file specified.')
    error.status = 1
    error.stderr = 'ERROR: The system cannot find the file specified.'
    throw error
  }
  const answer = uninstallSentry({
    stateDir: dir,
    platform: 'win32',
    execFileSyncFn: missing,
    startupDir: path.join(dir, 'Startup'),
  })
  assert.equal(answer.ok, true, 'an idempotent uninstall of nothing must succeed')
  assert.equal(fs.existsSync(sentryPaths(dir).dir), false)
  assert.equal(answer.pending, null)
})

test('uninstallSentry: a real installation is removed, lock and all', (t) => {
  const dir = tempDir(t)
  const paths = sentryPaths(dir)
  const exec = fakeExec()
  installSentry({ ...planOptions(dir), confirmed: true, execFileSyncFn: exec })
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: 999999 }), 'utf8')
  const answer = uninstallSentry({
    stateDir: dir,
    platform: 'win32',
    execFileSyncFn: exec,
    startupDir: path.join(dir, 'Startup'),
    isAliveFn: () => false,
  })
  assert.equal(answer.ok, true)
  assert.equal(fs.existsSync(paths.dir), false, 'the sentry directory must be gone')
  assert.ok(exec.calls.some((call) => call.args[0] === '/Delete'), 'the task must be deleted')
})

test('sentryStatus: nothing installed is reported, not thrown', (t) => {
  const dir = tempDir(t)
  const status = sentryStatus({ stateDir: dir, platform: 'linux', execFileSyncFn: fakeExec(), now: 1000 })
  assert.equal(status.installed, false)
  assert.equal(status.running, false)
  assert.equal(status.lastRescue, null)
  assert.equal(status.cleanExit, null)
  assert.equal(status.checkedAt, 1000)
  assert.ok(status.tasks.length > 0, 'the status must say what it looked at')
  assert.match(status.reason, /nothing can be said|not installed/)
})

test('sentryStatus: an installation is reported with its configuration and its report', (t) => {
  const dir = tempDir(t)
  const paths = sentryPaths(dir)
  installSentry({ ...planOptions(dir), confirmed: true, execFileSyncFn: fakeExec() })
  fs.writeFileSync(paths.report, JSON.stringify({ at: 1, action: 'rescue', ready: true }), 'utf8')
  fs.writeFileSync(paths.cleanExit, JSON.stringify({ at: 42 }), 'utf8')
  fs.writeFileSync(paths.log, '2026-10-30T00:00:00.000Z round: idle\n', 'utf8')
  const status = sentryStatus({ stateDir: dir, platform: 'win32', execFileSyncFn: fakeExec(), now: 2000 })
  assert.equal(status.installed, true)
  assert.equal(status.taskPresent, true)
  assert.equal(status.config.kind, 'windows-schtasks')
  assert.equal(status.lastRescue.ready, true)
  assert.equal(status.cleanExit.at, 42)
  assert.match(status.lastLogLine, /round: idle/)
})
