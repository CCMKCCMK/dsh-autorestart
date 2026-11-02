/**
 * The safety net of a restart.
 *
 * FOUR defects are covered here, all of them about a restart that LOOKED
 * successful while nothing had happened:
 *
 *   1. THE STARTUP VERDICT (`lib/restart.js`). The old `runCommandNow` spawned
 *      the command with `stdio: 'ignore'`, threw the spawn error away and
 *      answered `ok: true` as soon as the spawn succeeded. A command that does
 *      not exist, a command that exits with an error and a command that dies
 *      immediately were all reported as a successful restart.
 *
 *   2. THE ROLLBACK SAFETY NET OF THE HOSTED BRANCH (`index.js`). The
 *      hosted mode (`restartMode: "command"`) took a snapshot and then ran the
 *      command — with nothing that confirmed the new instance and nothing
 *      that put the snapshot back when the new instance never came.
 *
 *   3. THE ACCESS LINK (`lib/access.js`). The boot token is created per
 *      process, so the link the browser holds answers 401 after a restart and
 *      the user is locked out of their own interface.
 *
 *   4. THE ROLLBACK MISJUDGEMENT OF THE DESKTOP BRANCH (`lib/restart.js`).
 *      The watcher polled the health route of the OLD instance — the desktop
 *      app listens on a RANDOM port, so that answer never came and a healthy
 *      restart was rolled back. The restore had no time limit, and the
 *      rollback branch started a SECOND copy of the host.
 *
 * Every test here drives the real code: the restart path of `createRuntime`
 * with the side-effecting primitives replaced, so nothing is spawned and no
 * process is killed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime, normalizeConfig, takePreRestartSnapshot } from '../index.js'
import { requestRestart } from '../lib/checkpoint.js'
import {
  backupStamp,
  claimRollbackLock,
  CONFIG_DIR,
  contentFingerprintOf,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  latestKnownGood,
  listBackupIdentities,
  markKnownGood,
  META_NAME,
  readBackupMeta,
  releaseRollbackLock,
} from '../lib/backup.js'
import { ACCESS_FILE_NAME, readAccessRecord, resolveAccessUrl, writeAccessRecord } from '../lib/access.js'
import { healthUrlForPort, probeHealth, waitForHealthyInstance } from '../lib/health.js'
import { FINGERPRINT_LOG_CHARS } from '../lib/restart-verdict.js'
import { buildWatcherCommandLine, launchDetachedWatcher, runCommandNow } from '../lib/restart.js'

const APP_EXE = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

/** A fake Cordis context: just enough for the runtime to exist and to log. */
function fakeContext() {
  const logs = []
  const record = (level) => (...parts) => {
    logs.push({
      level,
      text: parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '),
    })
  }
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: {
      get: () => undefined,
      disarm: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  return { ctx, logs }
}

/** A profile-looking tree plus the environment that points the host at it. */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-safety-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
  return { base, profile }
}

/** One state directory (the checkpoint and the backups live next to it). */
function stateDir(base, label) {
  const dir = path.join(base, `state-${label}`)
  fs.mkdirSync(dir, { recursive: true })
  return { dir, file: path.join(dir, 'state.json') }
}

/**
 * ONE KNOWN-GOOD COPY in the backups directory of a state directory.
 *
 * The rollback target is NOT "the snapshot taken right before this restart" any
 * more (user decision, 2026-10-30): that snapshot may be the broken state itself
 * — the user edits a plugin and then clicks restart. What is restored is the
 * newest copy a boot has already PROVEN. A test that expects a rollback (or a
 * watchdog) therefore has to hand the runtime such a copy first, exactly the way
 * `markKnownGood` marks it once a boot came up.
 *
 * @param {{ dir: string }} state the state directory the backups hang off
 * @param {{ patch?: string, at?: number, version?: string }} [options]
 * @returns {string} the directory of the known-good copy
 */
function seedKnownGood(state, options = {}) {
  const patch = typeof options.patch === 'string' ? options.patch : 'rows:\n  - id: known-good\n'
  const at = Number.isFinite(options.at) ? options.at : Date.now() - 60 * 60 * 1000
  const version = typeof options.version === 'string' ? options.version : '0.8.5'
  const dir = path.join(state.dir, 'backups', backupStamp(at))
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), patch, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      at,
      atLocal: new Date(at).toISOString(),
      bytes: patch.length,
      files: ['cordis.patch.yml'],
      includePlugins: false,
    }),
    'utf8',
  )
  // A COPY ONLY COUNTS AS SAFE WITH EVIDENCE (2026-11-01): the promotion has to
  // name what was checked, AND — since the watchdog only restores certified
  // copies whose boot needed no help — the fixture records `intervention: false`.
  // A copy whose intervention is `null` ("nobody recorded it") is deliberately
  // NOT restorable, so a fixture that wants a restorable copy has to say so.
  assert.equal(
    markKnownGood(dir, {
      reason: 'test',
      version,
      certifiedBy: 'manual-rollback',
      // AND THE CRITERION (2026-11-01): a source alone is not a safe copy any
      // more. The fixture describes a copy whose content was compared with what
      // really booted, which is the only shape an automatic rollback may use.
      certificationEvidence: 'fingerprint-match',
      intervention: false,
    }).promoted,
    true,
    'the test copy is marked known-good',
  );
  return dir
}

/** The config of a hosted host that is restarted by a custom command. */
function hostedConfig(stateFile, overrides = {}) {
  return normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 1. THE STARTUP VERDICT: the exit code, the time limit, the spawn error.
// ---------------------------------------------------------------------------

/**
 * A child process that behaves exactly as the test asks for.
 *
 * @param {{ code?: number|null, signal?: string|null, stdout?: string, stderr?: string, error?: Error|null, silent?: boolean }} [options]
 */
function fakeChild(options = {}) {
  const listeners = {}
  const outListeners = []
  const errListeners = []
  const child = {
    pid: 4242,
    stdout: { on: (event, fn) => { if (event === 'data') outListeners.push(fn) } },
    stderr: { on: (event, fn) => { if (event === 'data') errListeners.push(fn) } },
    on: (event, fn) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
    },
    unref: () => {},
  }
  if (options.silent !== true) {
    setTimeout(() => {
      if (options.stdout) outListeners.forEach((fn) => fn(options.stdout))
      if (options.stderr) errListeners.forEach((fn) => fn(options.stderr))
      if (options.error) {
        ;(listeners.error || []).forEach((fn) => fn(options.error))
        return
      }
      ;(listeners.exit || []).forEach((fn) => fn(
        options.code === undefined ? 0 : options.code,
        options.signal === undefined ? null : options.signal,
      ))
    }, 0)
  }
  return child
}

test('a restart command that cannot be started is reported, never swallowed', async () => {
  const result = await runCommandNow({
    command: 'definitely-not-a-command',
    spawnFn: () => fakeChild({ error: new Error('spawn ENOENT') }),
  })
  assert.equal(result.ok, false, 'a command that cannot start is NOT a successful restart')
  assert.match(String(result.error), /could not be started/)
  assert.match(String(result.error), /ENOENT/)
  assert.equal(result.exitCode, null)
  assert.equal(result.timedOut, false)
})

test('a restart command that exits with an error is reported with its exit code', async () => {
  const result = await runCommandNow({
    command: 'the-host-restart',
    spawnFn: () => fakeChild({ code: 3, stderr: 'unit is not running\n' }),
  })
  assert.equal(result.ok, false, 'a non-zero exit code is NOT a successful restart')
  assert.equal(result.exitCode, 3)
  assert.match(String(result.error), /exited with code 3/)
  assert.match(String(result.error), /unit is not running/, 'the output of the command is kept')
  assert.match(result.output, /unit is not running/)
})

test('a restart command that ends with code 0 is a successful restart', async () => {
  const result = await runCommandNow({
    command: 'the-host-restart',
    spawnFn: () => fakeChild({ code: 0 }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.error, null)
})

test('a restart command that outlives the time limit is reported as "still running"', async () => {
  const result = await runCommandNow({
    command: 'dsh-web-in-the-foreground',
    timeoutMs: 30,
    spawnFn: () => fakeChild({ silent: true }),
  })
  assert.equal(result.timedOut, true, 'the command is reported as still running')
  assert.equal(result.exitCode, null)
  assert.equal(result.ok, true, 'a command that runs in the foreground is not a failure')
  assert.equal(result.error, null)
})

test('the time limit of the restart command is bounded', async () => {
  const started = Date.now()
  await runCommandNow({
    command: 'dsh-web-in-the-foreground',
    timeoutMs: 40,
    spawnFn: () => fakeChild({ silent: true }),
  })
  assert.ok(Date.now() - started < 2000, 'the plugin does not wait for the command for ever')
})

// ---------------------------------------------------------------------------
// 2. THE ROLLBACK SAFETY NET OF THE HOSTED BRANCH.
// ---------------------------------------------------------------------------

/**
 * Drive the hosted restart path with every side effect replaced.
 *
 * @param {object} options
 */
async function runHostedRestart(t, options = {}) {
  const { base, profile } = fixture(t, options.label || 'hosted')
  const state = stateDir(base, options.label || 'hosted')
  // THE ROLLBACK NET HAS TO HAVE SOMETHING TO RESTORE: a known-good copy is laid
  // down first, exactly as a boot that came up would leave it. `knownGood: null`
  // is the "nothing was ever proven" case, where nothing may be restored.
  const knownGoodDir = options.knownGood === null
    ? null
    : seedKnownGood(state, options.knownGood === undefined ? {} : options.knownGood)
  const fake = fakeContext()
  const commands = []
  const watchers = []
  const probes = []
  const watchdogArms = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options_) => takePreRestartSnapshot(options_),
    runCommand: async ({ command }) => {
      commands.push(command)
      // The restart command is free to break the profile on its way out; the
      // rollback has to undo whatever it did.
      if (typeof options.onCommand === 'function') options.onCommand({ command, profile, state })
      return options.commandOutcome || { ok: true, command, exitCode: 0, timedOut: false }
    },
    launchWatcher: (options_) => {
      watchers.push(options_)
      return { ok: true, method: 'test', error: null }
    },
    // The NEW watchdog is injected: the test decides who is the arbiter, and
    // NOTHING is registered on the machine. By default v2 cannot run, so the
    // old watcher is the arbiter - the fallback path these tests are about.
    armWatchdog: (options_) => {
      watchdogArms.push(options_)
      return options.watchdogArm || { ok: false, tier: 'none', reason: 'the test forces the fallback' }
    },
    probeInstance: async (options_) => {
      probes.push(options_)
      return options.probeOutcome || { ok: true, reason: 'the new instance answered' }
    },
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-safety' })
  await runtime.executeRestart()
  return { base, profile, state, runtime, fake, commands, watchers, probes, watchdogArms, knownGoodDir }
}

test('the hosted branch arms the rollback watcher BEFORE the restart command runs', async (t) => {
  const { commands, watchers, probes, state, knownGoodDir } = await runHostedRestart(t, { label: 'armed' })
  assert.equal(commands.length, 1, 'the restart command ran exactly once')
  assert.equal(watchers.length, 1, 'the rollback watcher was armed exactly once')
  assert.equal(typeof watchers[0].watchScriptPath, 'string')
  assert.ok(
    fs.existsSync(watchers[0].watchScriptPath),
    'the watcher script is written before the command kills the host',
  )
  // THE ROLLBACK TARGET IS THE KNOWN-GOOD COPY, not the snapshot of this restart
  // (which may be the broken state itself): the script has to carry that path.
  assert.ok(
    fs.readFileSync(watchers[0].watchScriptPath, 'utf8').includes(knownGoodDir),
    'the watcher restores the known-good copy',
  )
  assert.equal(probes.length, 1, 'the new instance is confirmed once')
  assert.ok(fs.existsSync(path.join(state.dir, 'access.json')), 'the instance record exists')
})

test('when the watchdog v2 is armed, the old watcher is NOT started', async (t) => {
  // The two watchdogs take the same lock: the one that loses it gives up. If
  // v2 lost, the profile would be restored and nothing would be running.
  const { commands, watchers, probes, state, watchdogArms, knownGoodDir } = await runHostedRestart(t, {
    label: 'v2-wins',
    watchdogArm: { ok: true, tier: 'scheduled-task', reason: '' },
  })
  assert.equal(watchdogArms.length, 1, 'the new watchdog was armed once')
  // v2 rolls back the PROVEN state, not the snapshot this restart just took.
  assert.equal(watchdogArms[0].restoreTargetDir, knownGoodDir, 'v2 is told exactly which copy it may restore')
  assert.equal(watchers.length, 0, 'the old watcher is NOT started next to v2')
  assert.equal(commands.length, 1, 'the restart command still ran exactly once')
  assert.equal(probes.length, 1, 'the new instance is confirmed once')
  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-watchdog-report.json'), 'utf8'))
  assert.equal(report.arbiter, 'v2', 'the report names the arbiter')
})

test('the hosted branch rolls the snapshot back ONCE when the new instance never answers', async (t) => {
  const broken = 'rows:\n  - id: broken\n'
  const { profile, state, runtime, fake, commands, watchers, knownGoodDir } = await runHostedRestart(t, {
    label: 'failed',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    // The restart command breaks the configuration on its way out; the rollback
    // has to undo that — with the KNOWN-GOOD copy, the only proven state.
    onCommand: ({ profile: where }) => fs.writeFileSync(path.join(where, 'cordis.patch.yml'), broken, 'utf8'),
    probeOutcome: { ok: false, reason: 'the new instance never answered' },
  })

  assert.equal(commands.length, 1)

  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.equal(report.ok, false, 'the report says the restart failed')
  assert.equal(report.rolledBack, true, 'the known-good copy was restored')
  assert.equal(report.backupDir, knownGoodDir, 'the KNOWN-GOOD copy is the rollback target')
  assert.match(String(report.reason), /never answered/, 'the report says WHY')
  assert.equal(report.appStarted, false, 'no second copy of the host was started')
  assert.equal(watchers.length, 1, 'the watcher was armed exactly once — no second rollback')
  assert.equal(
    fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: known-good\n',
    'the profile holds the known-good state again',
  )
  assert.ok(Array.isArray(report.restored) && report.restored.includes('cordis.patch.yml'))

  const marker = JSON.parse(fs.readFileSync(path.join(state.dir, 'restart-outcome.json'), 'utf8'))
  assert.equal(marker.decided, true)
  assert.equal(marker.ok, false)

  assert.ok(
    fake.logs.some((entry) => entry.level === 'error' && entry.text.includes('did not come up')),
    'the failure is logged, never swallowed',
  )
  assert.equal(runtime.lastRollback.rolledBack, true)
  assert.match(String(runtime.lastRollback.reason), /never answered/)
})

test('the hosted branch restores the KNOWN-GOOD copy, never the snapshot of this restart', async (t) => {
  const { base, profile } = fixture(t, 'restore')
  const state = stateDir(base, 'restore')
  const knownGoodDir = seedKnownGood(state, { patch: 'rows:\n  - id: known-good\n' })
  const fake = fakeContext()
  // A profile that is ALREADY broken when the snapshot is taken: the snapshot of
  // this restart is the broken state itself, so it must never be the target.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: broken\n', 'utf8')
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => {
      // The restart command breaks the configuration on its way out.
      fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: broken\n', 'utf8')
      return { ok: true, command, exitCode: 0, timedOut: false }
    },
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: false, reason: 'the new instance never answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-restore' })
  await runtime.executeRestart()

  const restored = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(
    restored,
    'rows:\n  - id: known-good\n',
    'the KNOWN-GOOD content is put back — NOT the broken snapshot of this restart',
  )
  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.equal(report.rolledBack, true)
  assert.equal(report.backupDir, knownGoodDir, 'the report names the known-good copy')
  assert.ok(Array.isArray(report.restored) && report.restored.includes('cordis.patch.yml'))
  // And the copy this restart took stays a plain, unproven snapshot on disk: it
  // is never a rollback target, precisely because it may be the broken state.
  const snapshotOfThisRestart = listBackupIdentities(path.join(state.dir, 'backups'))
    .find((entry) => entry.dir !== knownGoodDir)
  assert.ok(snapshotOfThisRestart, 'this restart took its own snapshot')
  assert.equal(snapshotOfThisRestart.kind, KIND_SNAPSHOT, 'the snapshot of this restart is not a target')
})

test('the hosted branch does NOT roll back when the new instance answers', async (t) => {
  const { profile, state, runtime, fake, commands, watchers, probes, knownGoodDir } = await runHostedRestart(t, {
    label: 'healthy',
    knownGood: { patch: 'rows:\n  - id: old-known-good\n' },
    probeOutcome: { ok: true, reason: 'the new instance answered its health route' },
  })

  assert.equal(commands.length, 1, 'the restart command ran exactly once')
  assert.equal(watchers.length, 1, 'the watcher was armed exactly once')
  assert.equal(probes.length, 1, 'the new instance was confirmed once')
  assert.equal(
    fs.existsSync(path.join(state.dir, 'last-rollback.json')),
    false,
    'a healthy restart is NOT rolled back',
  )
  assert.equal(runtime.lastRollback, null)

  // THE PROMOTION IS WIRED TO THE PROBE NOW (2026-11-01) — and the source says
  // exactly what was proven. On this path the four startup checks do NOT run (the
  // old instance survived its own command and only sees "the new instance
  // answers"), so the certification must NOT borrow the name of a check that
  // never ran: it is `command-probe`, and nothing else.
  const newestKnownGood = latestKnownGood(path.join(state.dir, 'backups'))
  assert.ok(newestKnownGood, 'a restart whose probe answered leaves a certified copy')
  assert.equal(newestKnownGood.kind, KIND_KNOWN_GOOD)
  assert.notEqual(newestKnownGood.dir, knownGoodDir, 'the snapshot of THIS restart is the new safe copy')
  assert.equal(newestKnownGood.certifiedBy, 'command-probe', 'certified by the health probe, not by the four checks')
  assert.ok(Number.isFinite(Date.parse(newestKnownGood.certifiedAt)), 'with the moment it was confirmed')
  // A DEFINITE "NO": this restart armed a watchdog, whose report on disk says
  // `restored: false` — a recorder spoke, and it said nothing had to step in. That
  // is the `false` case; "not recorded" would be `null` and must not be written as
  // `false` (the unit tests in backup-identity.test.mjs pin both).
  assert.equal(newestKnownGood.intervention, false, 'the recorded answer is: nothing had to step in')

  // The profile is left exactly as the restart command left it.
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: demo\n')

  const marker = JSON.parse(fs.readFileSync(path.join(state.dir, 'restart-outcome.json'), 'utf8'))
  assert.equal(marker.decided, true, 'the watcher is told to stand down')
  assert.equal(marker.ok, true)

  assert.equal(
    fake.logs.some((entry) => entry.level === 'error'),
    false,
    'a healthy restart logs no error',
  )
})

// ---------------------------------------------------------------------------
// 2b. THE COMMAND-MODE CERTIFICATION: a probe answering is NOT a proof.
//
// WHY: until 2026-11-01 this path stamped the pre-restart snapshot as
// `command-probe` as soon as the health probe answered, recording the copy's OWN
// fingerprint and never comparing it with the configuration that was running.
// "A probe answered" does not prove that the content of the snapshot can boot —
// the probe may have hit the old instance, and the configuration may have been
// swapped in between (that is the copy 2026-11-01T12-04-33-777Z). The gate is now
// the same one the app-mode path uses: both fingerprints exist and are EQUAL.
// ---------------------------------------------------------------------------

/** The structured detail of a log line (the logger stringifies it as JSON). */
function logDetail(entry) {
  const text = String(entry && entry.text ? entry.text : '')
  const start = text.indexOf('{')
  assert.notEqual(start, -1, 'the log line carries a structured detail')
  return JSON.parse(text.slice(start))
}

/**
 * The snapshot THIS restart took.
 *
 * Two ways to name it, because the two moments differ: while the restart is
 * running only the plain snapshot exists (`knownGoodDir === null`), and after it
 * the copy may have BECOME known-good — then it is "the one that is not the seeded
 * copy". Both ways assert that exactly one candidate is found.
 *
 * @param {{ dir: string }} state
 * @param {string|null} [knownGoodDir]
 */
function snapshotOfThisRestart(state, knownGoodDir = null) {
  const entries = listBackupIdentities(path.join(state.dir, 'backups'))
  const entry = knownGoodDir === null
    ? entries.find((candidate) => candidate.kind === KIND_SNAPSHOT)
    : entries.find((candidate) => candidate.dir !== knownGoodDir)
  assert.ok(entry, 'this restart took its own snapshot')
  return entry
}

test('a probe that answered on the SAME configuration certifies it, and the fingerprint WAS compared', async (t) => {
  const { state, fake, knownGoodDir } = await runHostedRestart(t, { label: 'probe-equal' })
  const snapshot = snapshotOfThisRestart(state, knownGoodDir)

  const meta = readBackupMeta(snapshot.dir)
  assert.equal(meta.kind, KIND_KNOWN_GOOD, 'the probe answered on the snapshot content, so the copy is proven')
  assert.equal(meta.certifiedBy, 'command-probe', 'and the source says what proved it')
  assert.equal(
    meta.contentFingerprint,
    contentFingerprintOf(snapshot.dir),
    'the content that was proven is the content the copy really holds',
  )

  const certified = fake.logs.find((entry) => entry.level === 'info'
    && entry.text.includes('is recorded as booted: the health probe answered'))
  assert.ok(certified, 'the promotion is reported')
  const detail = logDetail(certified)
  assert.equal(detail.fingerprintState, 'equal');
  assert.equal(detail.snapshotFingerprint, detail.currentFingerprint, 'the two sides really were compared, and matched')
  assert.equal(detail.snapshotFingerprint.length, FINGERPRINT_LOG_CHARS, 'the log shows short values, not the whole digest')
  assert.equal(detail.interventionUsedAsEvidence, false, 'the rescue flag is recorded, not the criterion')
})

test('a probe that answered on a CHANGED configuration certifies NOTHING', async (t) => {
  const { state, fake, knownGoodDir } = await runHostedRestart(t, {
    label: 'probe-mismatch',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    // The configuration is written to between the snapshot and the probe — a
    // restore, a hand edit, another writer. The probe still answers (an instance
    // is up), and that is exactly the news that is NOT a proof.
    onCommand: ({ profile: where }) => fs.writeFileSync(
      path.join(where, 'cordis.patch.yml'),
      'rows:\n  - id: edited-after-the-snapshot\n',
      'utf8',
    ),
    probeOutcome: { ok: true, reason: 'the new instance answered its health route' },
  })

  const snapshot = snapshotOfThisRestart(state, knownGoodDir)
  const meta = readBackupMeta(snapshot.dir)
  assert.equal(meta.kind, KIND_SNAPSHOT, 'the copy stays unproven');
  assert.equal(meta.certifiedBy, 'none', 'an answered probe on other content is NOT a certification')
  assert.equal(
    latestKnownGood(path.join(state.dir, 'backups')).dir,
    knownGoodDir,
    'no NEW safe copy appeared — the older proven one is still the newest',
  )

  const refusal = fake.logs.find((entry) => entry.level === 'warn' && entry.text.includes('stays UNPROVEN'))
  assert.ok(refusal, 'the refusal is REPORTED, not silent')
  assert.match(
    refusal.text,
    /the configuration was changed between the two boots \(a restore, a manual edit or another writer\): this copy was never proven/,
  )
  const detail = logDetail(refusal)
  assert.equal(detail.fingerprintState, 'mismatch')
  assert.equal(detail.snapshotFingerprint.length, FINGERPRINT_LOG_CHARS)
  assert.equal(detail.currentFingerprint.length, FINGERPRINT_LOG_CHARS)
  assert.notEqual(detail.snapshotFingerprint, detail.currentFingerprint, 'the log shows WHICH two values differ')
  assert.equal(detail.probeAnswered, true, 'the log says the probe DID answer — and that it was not enough')

  // The restart itself still succeeded: only the certification was refused.
  const marker = JSON.parse(fs.readFileSync(path.join(state.dir, 'restart-outcome.json'), 'utf8'))
  assert.equal(marker.ok, true)
  assert.equal(
    fs.existsSync(path.join(state.dir, 'last-rollback.json')),
    false,
    'a refused certification is not a reason to roll anything back',
  )
})

test('a snapshot taken before fingerprints existed IS certified when its content is what this boot runs', async (t) => {
  const { state, fake, knownGoodDir } = await runHostedRestart(t, {
    label: 'probe-no-fingerprint',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    // An OLD copy: its meta.json has no `contentFingerprint` at all (it was taken
    // before fingerprints existed).
    //
    // 没指纹 ≠ 内容不对（2026-11-01，用户拍板）：这份副本不是可疑，只是当初没给它拍照。
    // 指纹是拿文件内容算出来的，文件还在，就能当场补拍一张再比 —— 内容正好等于此刻跑着的
    // 那份配置，所以它证明了自己，认证。不给它补，等于「升级一次就把用户手里的安全份全收走」。
    onCommand: ({ state: where }) => {
      const snapshot = snapshotOfThisRestart(where)
      const metaPath = path.join(snapshot.dir, META_NAME)
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      delete raw.contentFingerprint
      fs.writeFileSync(metaPath, JSON.stringify(raw), 'utf8')
    },
    probeOutcome: { ok: true, reason: 'the new instance answered its health route' },
  })

  const snapshot = snapshotOfThisRestart(state, knownGoodDir)
  const meta = readBackupMeta(snapshot.dir)
  assert.equal(meta.kind, KIND_KNOWN_GOOD, 'the computed fingerprint matched the running content, so the copy IS proven')
  assert.equal(meta.certifiedBy, 'command-probe', 'and the source says what proved it')
  assert.equal(
    meta.contentFingerprint,
    contentFingerprintOf(snapshot.dir),
    'the sealed value is the content that was compared',
  )

  const certified = fake.logs.find((entry) => entry.level === 'info'
    && entry.text.includes('is recorded as booted: the health probe answered'))
  assert.ok(certified, 'the promotion is reported')
  const detail = logDetail(certified)
  // THE LOG HAS TO NAME WHERE THE FINGERPRINT CAME FROM: `computed` (taken just
  // now from the copy) is not `recorded` (taken when the copy was made), and a
  // reader who cannot tell them apart would believe this copy always had one.
  assert.equal(detail.fingerprintSource, 'computed', 'the report says the snapshot side was COMPUTED')
  assert.match(certified.text, /COMPUTED just now/, 'and the sentence spells the consequence out')
  assert.equal(
    detail.snapshotFingerprint,
    detail.currentFingerprint,
    'the computed fingerprint really was compared with the running configuration',
  )
})

test('an OLD snapshot whose content does NOT match is not certified — and computing it writes nothing back', async (t) => {
  const { state, fake, knownGoodDir } = await runHostedRestart(t, {
    label: 'probe-old-mismatch',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    onCommand: ({ profile: where, state: stateDirPath }) => {
      // An old copy (no recorded fingerprint) whose content is NOT what the host
      // came up on: the configuration was written to between the two boots.
      const snapshot = snapshotOfThisRestart(stateDirPath)
      const metaPath = path.join(snapshot.dir, META_NAME)
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      delete raw.contentFingerprint
      fs.writeFileSync(metaPath, JSON.stringify(raw), 'utf8')
      fs.writeFileSync(path.join(where, 'cordis.patch.yml'), 'rows:\n  - id: edited-after-the-snapshot\n', 'utf8')
    },
    probeOutcome: { ok: true, reason: 'the new instance answered its health route' },
  })

  const snapshot = snapshotOfThisRestart(state, knownGoodDir)
  const meta = readBackupMeta(snapshot.dir)
  assert.equal(meta.kind, KIND_SNAPSHOT, 'a computed fingerprint that does not match proves nothing')
  assert.equal(meta.certifiedBy, 'none')
  // 现算只用于这一次判定，不回写 meta：这份副本以前没有指纹，判完也不该凭空多出一个。
  assert.equal(meta.contentFingerprint, null, 'the meta was NOT given a fingerprint it never had')

  const refusal = fake.logs.find((entry) => entry.level === 'warn' && entry.text.includes('stays UNPROVEN'))
  assert.ok(refusal, 'the refusal is reported')
  const detail = logDetail(refusal)
  assert.equal(detail.fingerprintState, 'mismatch')
  assert.equal(detail.fingerprintSource, 'computed', 'and the report says the compared value was computed just now')
  assert.match(refusal.text, /changed between the two boots/)
})

test('a snapshot whose fingerprint cannot be COMPUTED is a computation failure, not a content difference', async (t) => {
  const { state, fake, knownGoodDir } = await runHostedRestart(t, {
    label: 'probe-old-unreadable',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    onCommand: ({ state: stateDirPath }) => {
      // An old copy (no recorded fingerprint) whose content cannot be read at all:
      // `config/` is gone. This is NOT "the content differs" — nothing could be
      // compared, and the two send the reader looking for different things.
      const snapshot = snapshotOfThisRestart(stateDirPath)
      const metaPath = path.join(snapshot.dir, META_NAME)
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      delete raw.contentFingerprint
      fs.writeFileSync(metaPath, JSON.stringify(raw), 'utf8')
      fs.rmSync(path.join(snapshot.dir, CONFIG_DIR), { recursive: true, force: true })
    },
    probeOutcome: { ok: true, reason: 'the new instance answered its health route' },
  })

  const snapshot = snapshotOfThisRestart(state, knownGoodDir)
  const meta = readBackupMeta(snapshot.dir)
  assert.equal(meta.kind, KIND_SNAPSHOT, 'nothing is certified when nothing could be computed')
  assert.equal(meta.certifiedBy, 'none')

  const refusal = fake.logs.find((entry) => entry.level === 'warn' && entry.text.includes('stays UNPROVEN'))
  assert.ok(refusal, 'the refusal is reported')
  const detail = logDetail(refusal)
  assert.equal(detail.fingerprintState, 'snapshot-unreadable', 'its own state, so it is not read as "content differs"')
  assert.equal(detail.fingerprintSource, 'unavailable')
  assert.match(refusal.text, /COMPUTATION failure/, 'the log says the copy could not be read')
  assert.match(refusal.text, /could not be read/)
  assert.doesNotMatch(
    refusal.text,
    /changed between the two boots/,
    'and it does NOT claim the configuration was edited — that would be a different (false) diagnosis',
  )
})

test('a restart command that fails is reported and rolls the snapshot back', async (t) => {
  const { state, fake, commands, knownGoodDir } = await runHostedRestart(t, {
    label: 'bad-command',
    knownGood: { patch: 'rows:\n  - id: known-good\n' },
    commandOutcome: { ok: false, error: 'the restart command exited with code 3' },
  })
  assert.equal(commands.length, 1, 'the command ran exactly once')
  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.equal(report.ok, false)
  assert.equal(report.rolledBack, true, 'the known-good copy was restored')
  assert.equal(report.backupDir, knownGoodDir, 'the KNOWN-GOOD copy is the rollback target')
  assert.match(String(report.reason), /exited with code 3/)
  assert.ok(
    fake.logs.some((entry) => entry.level === 'error' && entry.text.includes('restart command failed')),
    'the failure is reported, never swallowed',
  )
})

test('the hosted branch asks the new instance, not the old one', async (t) => {
  const { probes, runtime } = await runHostedRestart(t, { label: 'new-instance' })
  assert.equal(probes.length, 1)
  assert.equal(
    probes[0].expectedBootId,
    runtime.bootId,
    'the confirmation waits for an instance that is NOT the one that is being replaced',
  )
  assert.equal(probes[0].healthPath, '/__dsh_autorestart/health')
  assert.ok(
    String(probes[0].accessFile).endsWith(ACCESS_FILE_NAME),
    'the confirmation reads the instance record (the port of the NEW instance)',
  )
})

// ---------------------------------------------------------------------------
// 3. THE ACCESS LINK: the user finds the working link after a restart.
// ---------------------------------------------------------------------------

test('the instance record carries the access link with the boot token', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-access-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))

  const written = writeAccessRecord({
    stateDir: base,
    bootId: 'boot-1',
    pid: 4242,
    port: 55537,
    url: 'http://127.0.0.1:55537/?token=secret-token',
    token: 'secret-token',
  })
  assert.equal(written.ok, true, String(written.error))
  const file = path.join(base, ACCESS_FILE_NAME)
  assert.ok(fs.existsSync(file))

  const record = readAccessRecord(base)
  assert.equal(record.ok, true)
  assert.equal(record.record.url, 'http://127.0.0.1:55537/?token=secret-token')
  assert.equal(record.record.token, 'secret-token')
  assert.equal(record.record.bootId, 'boot-1')
  assert.equal(record.record.port, 55537)

  // The file holds a secret, so it is readable by its owner only.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    assert.equal(mode, 0o600, `the instance record must be readable by its owner only (got ${mode.toString(8)})`)
  }
})

test('the access link is signed by the connection service when there is one', () => {
  const signed = resolveAccessUrl({
    origin: 'http://127.0.0.1:55537',
    connection: { authenticatedUrl: (base) => base + '/?token=abc' },
  })
  assert.equal(signed.url, 'http://127.0.0.1:55537/?token=abc')
  assert.equal(signed.token, 'abc')

  // Without a connection service the plain origin is still published.
  const plain = resolveAccessUrl({ origin: 'http://127.0.0.1:55537/' })
  assert.equal(plain.url, 'http://127.0.0.1:55537/')
  assert.equal(plain.token, null)

  // A connection service that throws must not cost the plain origin.
  const broken = resolveAccessUrl({
    origin: 'http://127.0.0.1:55537',
    connection: {
      authenticatedUrl: () => {
        throw new Error('no token today')
      },
    },
  })
  assert.equal(broken.url, 'http://127.0.0.1:55537/')
})

test('the health confirmation waits for the NEW instance and probes ITS port', async () => {
  const probed = []
  const result = await waitForHealthyInstance({
    accessFile: 'C:/state/access.json',
    expectedBootId: 'boot-old',
    healthPath: '/__dsh_autorestart/health',
    timeoutMs: 1000,
    intervalMs: 1,
    now: (() => {
      let tick = 0
      return () => {
        tick += 1
        return tick * 100
      }
    })(),
    sleep: async () => {},
    readRecord: () => ({
      ok: true,
      record: { bootId: 'boot-new', port: 51234, url: 'http://127.0.0.1:51234/?token=t' },
    }),
    probe: async ({ url }) => {
      probed.push(url)
      return { ok: true, status: 200, error: null }
    },
  })
  assert.equal(result.ok, true, String(result.reason))
  assert.equal(result.port, 51234)
  assert.deepEqual(probed, ['http://127.0.0.1:51234/__dsh_autorestart/health'])
  assert.equal(
    probed.some((url) => url.includes('51004')),
    false,
    'the port of the OLD instance is never probed',
  )
})

test('the health confirmation ignores the instance that is being replaced', async () => {
  const probed = []
  let tick = 0
  const result = await waitForHealthyInstance({
    accessFile: 'C:/state/access.json',
    expectedBootId: 'boot-old',
    timeoutMs: 500,
    intervalMs: 1,
    now: () => {
      tick += 1
      return tick * 100
    },
    sleep: async () => {},
    // The record still carries the boot id of the OLD instance.
    readRecord: () => ({ ok: true, record: { bootId: 'boot-old', port: 51004 } }),
    probe: async ({ url }) => {
      probed.push(url)
      return { ok: true, status: 200, error: null }
    },
  })
  assert.equal(result.ok, false, 'the old instance is not a successful restart')
  assert.deepEqual(probed, [], 'the old instance is never asked')
  assert.match(String(result.reason), /still the one that is being replaced/)
})

test('the health URL of a port is built on the loopback interface', () => {
  assert.equal(healthUrlForPort(55537, '/__dsh_autorestart/health'), 'http://127.0.0.1:55537/__dsh_autorestart/health')
  assert.equal(healthUrlForPort(0, '/x'), '', 'an unknown port has no health URL')
})

test('a health route that does not answer is not a success', async () => {
  const answer = await probeHealth({
    url: 'http://127.0.0.1:1/__dsh_autorestart/health',
    timeoutMs: 200,
    requestImpl: async () => ({ ok: false, status: 500, error: 'the health route answered with status 500' }),
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 500)
})

// ---------------------------------------------------------------------------
// 4. THE ROLLBACK MISJUDGEMENT OF THE DESKTOP BRANCH.
// ---------------------------------------------------------------------------

test('the browser follows the access link of the instance that is really running', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('resolveAccessRedirect'), 'the client knows the new access link')
  // The rule is enforced in one pure helper, so it is checked here.
  const module = await import('../client.js')
  const resolve = module.resolveAccessRedirect || globalThis.__dshAutorestartClient?.resolveAccessRedirect
  assert.equal(typeof resolve, 'function', 'the helper is exported')

  const current = 'http://127.0.0.1:5601/?token=old-token'
  assert.equal(
    resolve(current, 'http://127.0.0.1:5601/?token=new-token'),
    'http://127.0.0.1:5601/?token=new-token',
    'the stale link is replaced by the new one',
  )
  assert.equal(resolve(current, current), null, 'the same link is not followed again')
  assert.equal(resolve(current, 'http://127.0.0.1:5601/'), null, 'a link without a token is not followed')
  assert.equal(resolve(current, 'http://127.0.0.1:9999/?token=new'), null, 'another port is never followed')
  assert.equal(resolve(current, 'http://evil.example/?token=new'), null, 'another host is never followed')
  assert.equal(resolve('http://127.0.0.1:5601/', 'http://127.0.0.1:5601/?token=new'), null,
    'a page without a token is not reloaded for nothing')
})

// ---------------------------------------------------------------------------
// 5. THE ROLLBACK HAPPENS ONCE — even when the plugin and the watcher both
//    see the failure.
// ---------------------------------------------------------------------------

test('only ONE party may restore the snapshot', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-lock-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))

  const first = claimRollbackLock(base)
  assert.equal(first.ok, true, 'the first claim wins')
  assert.ok(fs.existsSync(first.path))

  const second = claimRollbackLock(base)
  assert.equal(second.ok, false, 'the second claim stands down')
  assert.match(String(second.error), /already running/)

  assert.equal(releaseRollbackLock(base), true)
  const third = claimRollbackLock(base)
  assert.equal(third.ok, true, 'the lock is released again')
})

test('a lock of a process that died does not block the rollback for ever', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-stale-lock-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))

  // A lock left behind by a process that was killed in the middle of its
  // restore: it is more than ten minutes old.
  const file = path.join(base, 'rollback.lock')
  fs.writeFileSync(file, '4711', 'utf8')
  const old = new Date(Date.now() - 30 * 60 * 1000)
  fs.utimesSync(file, old, old)

  const claim = claimRollbackLock(base)
  assert.equal(claim.ok, true, 'the stale lock is taken over')
  releaseRollbackLock(base)
})

test('the hosted branch stands down when the watcher is already restoring', async (t) => {
  const { base, profile } = fixture(t, 'locked')
  const state = stateDir(base, 'locked')
  // A known-good copy exists, so the rollback gets as far as the lock: it is the
  // LOCK — not a missing target — that makes this restart stand down.
  seedKnownGood(state, { patch: 'rows:\n  - id: known-good\n' })
  const fake = fakeContext()
  // The detached watcher holds the lock: it is already restoring the snapshot.
  const lock = claimRollbackLock(state.dir)
  assert.equal(lock.ok, true)

  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: false, reason: 'the new instance never answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-locked' })
  await runtime.executeRestart()

  // The profile was NOT touched a second time by the plugin.
  assert.equal(
    fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: demo\n',
    'the profile is not restored twice',
  )
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('another rollback is already running')),
    'the plugin says that it stood down',
  )
  releaseRollbackLock(state.dir)
})

test('a marker of an EARLIER decision does not stop the new watcher', async (t) => {
  const { base } = fixture(t, 'stale-marker')
  const state = stateDir(base, 'stale-marker')
  // The watcher is only armed for a PROVEN copy, so the known-good one has to
  // exist for this test to be about the marker at all.
  seedKnownGood(state)
  const fake = fakeContext()
  // The marker of a previous restart is still in the state directory.
  fs.writeFileSync(
    path.join(state.dir, 'restart-outcome.json'),
    JSON.stringify({ decided: true, ok: false, reason: 'the previous restart failed' }),
    'utf8',
  )

  const watchers = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: (options) => {
      watchers.push(options)
      return { ok: true, method: 'test', error: null }
    },
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-stale' })
  await runtime.executeRestart()

  assert.equal(watchers.length, 1, 'the watcher of THIS restart was armed')
  const marker = JSON.parse(fs.readFileSync(path.join(state.dir, 'restart-outcome.json'), 'utf8'))
  assert.equal(marker.ok, true, 'the marker is the decision of THIS restart')
  assert.notEqual(marker.reason, 'the previous restart failed')
})

// ---------------------------------------------------------------------------
// 5b. THE ROLLBACK TARGET IS THE NEWEST PROOF, NOT THE NEWEST COPY
//     (user decision, 2026-10-30).
// ---------------------------------------------------------------------------

test('a known-good copy OLDER than the snapshot of this restart is the one that is restored', async (t) => {
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
  const { profile, state, commands, watchers, knownGoodDir } = await runHostedRestart(t, {
    label: 'older-known-good',
    // Two days old on purpose: the snapshot of this restart is NEWER, and the
    // newer copy is exactly the one that must NOT be trusted.
    knownGood: { patch: 'rows:\n  - id: two-days-ago\n', at: twoDaysAgo },
    probeOutcome: { ok: false, reason: 'the new instance never answered' },
  })
  assert.equal(commands.length, 1, 'the restart command ran exactly once')
  assert.equal(watchers.length, 1, 'the watcher was armed exactly once')

  const backups = listBackupIdentities(path.join(state.dir, 'backups'))
  const snapshotOfThisRestart = backups.find((entry) => entry.dir !== knownGoodDir)
  assert.ok(snapshotOfThisRestart, 'this restart took its own snapshot')
  assert.equal(snapshotOfThisRestart.kind, KIND_SNAPSHOT, 'and it is unproven')
  assert.ok(
    snapshotOfThisRestart.name > path.basename(knownGoodDir),
    'the snapshot of this restart really is the NEWER copy',
  )

  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.equal(report.rolledBack, true)
  assert.equal(report.backupDir, knownGoodDir, 'the OLDER known-good copy is the rollback target')
  assert.equal(
    fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: two-days-ago\n',
    'the profile holds the older, proven state again',
  )
})

test('a rollback without a known-good copy restores NOTHING and says no-known-good', async (t) => {
  const brokenByCommand = 'rows:\n  - id: broken-by-command\n'
  const { profile, state, runtime, fake, watchers, watchdogArms, knownGoodDir } = await runHostedRestart(t, {
    label: 'no-known-good',
    knownGood: null,
    onCommand: ({ profile: where }) => fs.writeFileSync(path.join(where, 'cordis.patch.yml'), brokenByCommand, 'utf8'),
    probeOutcome: { ok: false, reason: 'the new instance never answered' },
  })
  assert.equal(knownGoodDir, null, 'the fixture really has no known-good copy')
  // WHAT CHANGED, AND WHY IT IS NOT A WEAKENING (2026-11-01, strict mode): the
  // watchdog USED to stay home entirely when no copy existed, which left the user
  // with a silent failure — nothing was armed, so nothing was ever written down
  // that said "there is no trusted restore point". It is armed now, WITH an empty
  // target and the blocked flag, so the run happens and the report says why. What
  // must still hold — and is asserted below — is that it restores NOTHING.
  assert.equal(watchdogArms.length, 1, 'the watchdog is armed so it can REPORT that nothing may be restored')
  assert.equal(watchdogArms[0].restoreTargetDir, '', 'but it is given no copy at all')
  assert.equal(watchdogArms[0].restoreBlocked, true, 'and it is told, in so many words, that it is blocked')
  assert.match(String(watchdogArms[0].restoreBlockedReason), /no backup qualifies/, 'including the reason')
  assert.match(
    String(watchdogArms[0].restoreBlockedReason),
    /not-content-verified/,
    'and which copies were refused, with why (this restart took one snapshot whose restart was never observed)',
  )
  assert.equal(watchers.length, 0, 'the old watcher is not started')

  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.equal(report.ok, false, 'the report says the restart failed')
  assert.equal(report.rolledBack, false, 'NOTHING was restored')
  assert.equal(report.backupDir, null, 'the report names no rollback target')
  assert.match(String(report.reason), /^no-known-good: /, 'the report says WHY nothing was restored')
  assert.match(String(report.reason), /never answered/, 'and it still says what went wrong')
  assert.deepEqual(report.restored, [], 'not a single file was touched')
  assert.equal(
    fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'),
    brokenByCommand,
    'the profile is left exactly as the restart command left it',
  )
  assert.equal(runtime.lastRollback.rolledBack, false)
  assert.equal(runtime.lastRollback.backupDir, null, 'the interface is told there is no rollback target')
  assert.ok(
    fake.logs.some((entry) => entry.level === 'error' && entry.text.includes('nothing to roll back to')),
    'the failure is logged, never swallowed',
  )
})

test('without a known-good copy the watchdog v2 is armed but told it may restore NOTHING', async (t) => {
  const { state, fake, watchers, watchdogArms } = await runHostedRestart(t, {
    label: 'no-known-good-v2',
    knownGood: null,
    // The injected v2 WOULD say yes. It is armed on purpose — a run that reports
    // "no trusted restore point, handle it manually" is what the user asked for —
    // but it is armed with NO target and a blocked flag, so it cannot put the
    // broken state back.
    watchdogArm: { ok: true, tier: 'scheduled-task', reason: '' },
    probeOutcome: { ok: false, reason: 'the new instance never answered' },
  })
  assert.equal(watchdogArms.length, 1, 'v2 is armed so its report can say that nothing may be restored')
  assert.equal(watchdogArms[0].restoreTargetDir, '', 'with no copy to restore')
  assert.equal(watchdogArms[0].restoreBlocked, true, 'and the strict-mode flag set')
  assert.equal(watchers.length, 0, 'the old watcher is not armed')
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('no trusted restore point')),
    'the plugin says out loud that the watchdog will not restore anything, and the report will repeat it',
  )
  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-rollback.json'), 'utf8'))
  assert.match(String(report.reason), /^no-known-good: /, 'and the report says no-known-good')
})

// ---------------------------------------------------------------------------
// 6. THE WATCHER IS STARTED OUTSIDE THE HOST.
// ---------------------------------------------------------------------------

test('the rollback watcher is started as a process of its own', () => {
  const command = buildWatcherCommandLine('C:/state/restart-3-watch.ps1')
  assert.ok(command.includes('powershell.exe'))
  assert.ok(command.includes('-File "C:/state/restart-3-watch.ps1"'))
  assert.ok(command.includes('-WindowStyle Hidden'), 'the watcher runs without a window')
  assert.equal(buildWatcherCommandLine(''), '', 'without a script there is no command')

  const planned = launchDetachedWatcher({
    watchScriptPath: 'C:/state/restart-3-watch.ps1',
    dryRun: true,
  })
  assert.equal(planned.ok, true)
  assert.equal(planned.dryRun, true)
  assert.ok(planned.command.includes('restart-3-watch.ps1'))

  const missing = launchDetachedWatcher({ dryRun: true })
  assert.equal(missing.ok, false, 'without a watcher there is nothing to start')
  assert.match(String(missing.error), /watcher command/)
})

test('the watcher is started detached on POSIX, so it survives the host', () => {
  let spawned = null
  const result = launchDetachedWatcher({
    watchScriptPath: '/state/restart-3-watch.ps1',
    platform: 'linux',
    spawnFn: (command, options) => {
      spawned = { command, options }
      return { pid: 777, on: () => {}, unref: () => {} }
    },
  })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.method, 'spawn')
  assert.equal(spawned.options.detached, true, 'the watcher is its own session leader')
  assert.equal(spawned.options.stdio, 'ignore')
})

