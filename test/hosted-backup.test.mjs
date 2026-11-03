/**
 * The pre-restart snapshot in the HOSTED mode (`restartMode: "command"`).
 *
 * The hosted host is not the desktop app: it is restarted by a custom command.
 * The snapshot — the copy of the profile that makes an automatic rollback
 * possible when the host does not come back — used to live inside the desktop
 * branch only, so a hosted restart left no rollback point at all.
 *
 * These tests drive the real restart path (`runtime.executeRestart()`), with
 * the environment and the side-effecting primitives (the restart command, the
 * detached scheduler) replaced, so nothing is spawned and nothing is killed.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime, normalizeConfig, takePreRestartSnapshot } from '../index.js'
import { requestRestart } from '../lib/checkpoint.js'
import { MANIFEST_NAME, readManifest } from '../lib/backup.js'

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-hosted-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8')
  // The profile is resolved from the environment, exactly like in production.
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

/** The config of a hosted host that is restarted by a custom command. */
function hostedConfig(stateFile, overrides = {}) {
  return normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    // The grace window (the extra wait after the last conversation) is a
    // different knob; these tests are about the snapshot, so it is off.
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    ...overrides,
  })
}

/** Ask for a restart, exactly like the `continuum_restart` tool does. */
function requestRestartNow(runtime) {
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-hosted' })
}

test('the hosted mode snapshots the profile before the restart command runs', async (t) => {
  const { base, profile } = fixture(t, 'command')
  const state = stateDir(base, 'command')
  const fake = fakeContext()
  const commands = []
  const snapshots = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    // The hosted host: not the desktop app.
    env: { isDesktopApp: false, appExePath: null },
    // The shared snapshot entry, spied but still the real implementation.
    snapshot: (options) => {
      snapshots.push(options)
      return takePreRestartSnapshot(options)
    },
    // The restart command is recorded instead of executed.
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The new watchdog is injected too: the test decides who is the arbiter
    // and NOTHING is registered on the machine.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.equal(snapshots.length, 1, 'the shared snapshot entry is used exactly once')
  assert.deepEqual(commands, ['restart-the-host'], 'the restart command ran')
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('pre-restart backup written')),
    'the snapshot is reported',
  )

  const backups = path.join(state.dir, 'backups')
  const stamps = fs.readdirSync(backups)
  assert.equal(stamps.length, 1, 'exactly one snapshot was written')
  const dir = path.join(backups, stamps[0])
  assert.ok(fs.existsSync(path.join(dir, 'config', 'cordis.patch.yml')), 'the patch is in the snapshot')
  assert.ok(fs.existsSync(path.join(dir, 'config', 'package.json')), 'the profile manifest is in the snapshot')
  assert.ok(fs.existsSync(path.join(dir, 'config', 'pnpm-lock.yaml')), 'the lockfile is in the snapshot')
  // SCOPE-DEFINING ASSERTION (inverted 2026-11-01): a backup keeps what cannot
  // be fetched again. The third-party tree is NOT copied - config/pnpm-lock.yaml
  // reinstalls exactly the same versions. This is the line that states the new
  // scope; the config assertions above still prove the snapshot itself is real.
  assert.equal(
    fs.existsSync(path.join(dir, 'node_modules', 'demo-plugin', 'package.json')),
    false,
    'the third-party plugin tree is deliberately NOT in the snapshot',
  )
  assert.ok(fs.existsSync(path.join(dir, MANIFEST_NAME)), 'the manifest is in the snapshot')
  const manifest = readManifest(dir)
  assert.equal(manifest.profileDir, profile, 'the manifest points at the profile that was snapshotted')
  assert.equal(manifest.includePlugins, true)
})

test('a snapshot that did NOT complete stops the restart instead of restarting into nothing', async (t) => {
  const { base } = fixture(t, 'cancelled')
  const state = stateDir(base, 'cancelled')
  const fake = fakeContext()
  const commands = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    // THE COPY DID NOT COMPLETE (user report, 2026-11-02): the restart used to
    // carry on anyway, which is how a machine ended up with a directory that had
    // copied the whole plugin tree but never wrote its manifest — a "backup" that
    // restores nothing. A restart into that void is worse than no restart.
    snapshot: () => ({ cancelled: true, backup: null }),
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.deepEqual(commands, [], 'the restart command must NOT run without a finished copy')
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('cancelled while the snapshot')),
    'and it says why it stopped: ' + JSON.stringify(fake.logs.map((entry) => entry.text)),
  )
  // NOTHING claims a backup name either: a half-written copy is not a rollback point.
  const backups = path.join(state.dir, 'backups')
  const published = fs.existsSync(backups)
    ? fs.readdirSync(backups).filter((name) => name.startsWith('.') !== true)
    : []
  assert.deepEqual(published, [], 'no directory carries a backup name after an unfinished copy')
})

test('the hosted mode takes no snapshot when backupOnRestart is false', async (t) => {
  const { base } = fixture(t, 'no-backup')
  const state = stateDir(base, 'no-backup')
  const fake = fakeContext()
  const commands = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file, { backupOnRestart: false }), {
    env: { isDesktopApp: false, appExePath: null },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The new watchdog is injected too: the test decides who is the arbiter
    // and NOTHING is registered on the machine.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.equal(fs.existsSync(path.join(state.dir, 'backups')), false, 'no snapshot was written')
  assert.deepEqual(commands, ['restart-the-host'], 'the restart command still ran')
})

test('the desktop app and the hosted command share ONE pre-restart snapshot entry', async (t) => {
  const { base, profile } = fixture(t, 'shared')
  const fake = fakeContext()
  const snapshots = []

  // The ONE entry, used by both restart modes.
  const snapshot = (options) => {
    snapshots.push(options)
    return takePreRestartSnapshot(options)
  }

  // (1) The hosted mode: the custom command restarts the host.
  const hosted = stateDir(base, 'hosted')
  const hostedCommands = []
  const hostedRuntime = createRuntime(fake.ctx, hostedConfig(hosted.file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot,
    runCommand: ({ command }) => {
      hostedCommands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The new watchdog is injected too: the test decides who is the arbiter
    // and NOTHING is registered on the machine.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(hostedRuntime)
  await hostedRuntime.executeRestart()

  // (2) The desktop mode: the app is relaunched by the detached helper.
  const desktop = stateDir(base, 'desktop')
  const scheduled = []
  const desktopRuntime = createRuntime(fake.ctx, hostedConfig(desktop.file, { restartMode: 'app' }), {
    env: { isDesktopApp: true, appExePath: APP_EXE },
    snapshot,
    scheduleDetached: (options) => {
      scheduled.push(options)
      return { ok: true, method: 'wmi', error: null }
    },
    // The old watcher is the arbiter here (the new one cannot run), so the
    // desktop mode still hands over its watcher script.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
  })
  // A known web port: the rollback watcher needs the health route.
  desktopRuntime.webPort = 51004
  requestRestartNow(desktopRuntime)
  await desktopRuntime.executeRestart()

  assert.equal(snapshots.length, 2, 'each restart uses the shared entry exactly once')
  assert.deepEqual(hostedCommands, ['restart-the-host'])
  assert.equal(scheduled.length, 1, 'the desktop mode still schedules the detached restart')

  // Both modes left exactly one snapshot of the same profile behind.
  for (const state of [hosted, desktop]) {
    const stamps = fs.readdirSync(path.join(state.dir, 'backups'))
    assert.equal(stamps.length, 1, 'exactly one snapshot per restart')
    assert.equal(readManifest(path.join(state.dir, 'backups', stamps[0])).profileDir, profile)
  }

  // The desktop mode keeps its rollback watcher: it restores the snapshot when
  // the relaunched host never answers.
  assert.ok(scheduled[0].watchScriptPath, 'the desktop mode still hands over a watcher script')
  assert.ok(scheduled[0].watchScript.includes(path.join(desktop.dir, 'backups')), 'the watcher knows the backup')
  assert.ok(scheduled[0].watchScript.includes(profile), 'the watcher knows the profile')
})

/**
 * TEXT GUARD — NOT a behavioural test (2026-11-02).
 *
 * It counts STRINGS in index.js: it can notice that one of these three markers
 * is written twice, or that it disappeared. It CANNOT prove that the snapshot is
 * taken exactly once at runtime — an alias, a second helper under another name,
 * or a copy of the logic in another module would all pass it.
 *
 * It stays for the one regression it really catches (a second top-level call
 * appearing under the same name). The BEHAVIOURAL proof lives in the snapshot
 * tests above: they drive `executeRestart` for real and count the backup
 * directories that end up on disk.
 */
test('text guard: the snapshot markers appear exactly once in index.js', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const count = (needle) => source.split(needle).length - 1
  assert.equal(count('snapshotFn('), 1, 'the shared snapshot entry is called from exactly one place')
  assert.equal(count('backupsRoot('), 1, 'the backups directory is built in exactly one place')
  assert.equal(count('pre-restart backup written'), 1, 'the snapshot is written in exactly one place')
})

test('a failed snapshot does not block the restart command', async (t) => {
  const { base, profile } = fixture(t, 'failed')
  const state = stateDir(base, 'failed')
  const fake = fakeContext()
  const commands = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file), {
    env: { isDesktopApp: false, appExePath: null },
    // A snapshot that failed: the restart must go on without a rollback point.
    snapshot: () => ({
      backup: { ok: false, error: 'the disk is full' },
      profileDir: profile,
      profile: { dir: profile, source: 'test' },
    }),
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The new watchdog is injected too: the test decides who is the arbiter
    // and NOTHING is registered on the machine.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.deepEqual(commands, ['restart-the-host'], 'the restart command ran even though the snapshot failed')
  assert.equal(fs.existsSync(path.join(state.dir, 'backups')), false)
})

test('the shared snapshot entry keeps the reason of a failed backup and never throws', async (t) => {
  const { base, profile } = fixture(t, 'entry')
  const state = stateDir(base, 'entry')
  const warnings = []
  const log = {
    warn: (...parts) => {
      warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    },
  }

  const failed = await takePreRestartSnapshot({ slimBackup: false,
    config: { backupOnRestart: true, backupIncludePlugins: true, maxBackups: 2 },
    stateDir: state.dir,
    log,
    profile: { dir: profile, source: 'test' },
    createBackup: () => ({ ok: false, error: 'the disk is full' }),
  })
  assert.equal(failed.backup.ok, false)
  assert.equal(failed.backup.error, 'the disk is full', 'the reason is preserved')
  assert.ok(
    warnings.some((text) => text.includes('the pre-restart backup failed') && text.includes('the disk is full')),
    'the reason is logged',
  )

  // A backup writer that throws must not take the restart down with it.
  const thrown = await takePreRestartSnapshot({ slimBackup: false,
    config: { backupOnRestart: true, backupIncludePlugins: true, maxBackups: 2 },
    stateDir: state.dir,
    log,
    profile: { dir: profile, source: 'test' },
    createBackup: () => {
      throw new Error('the backup writer exploded')
    },
  })
  assert.equal(thrown.backup.ok, false)
  assert.match(String(thrown.backup.error), /the backup writer exploded/)
})

test('the shared snapshot entry writes nothing when backupOnRestart is false', async () => {
  let called = 0
  const result = await takePreRestartSnapshot({ slimBackup: false,
    config: { backupOnRestart: false },
    stateDir: path.join(os.tmpdir(), 'dsh-ar-hosted-no-backup'),
    log: { warn: () => {} },
    profile: { dir: 'C:\\profiles\\demo', source: 'test' },
    createBackup: () => {
      called += 1
      return { ok: true }
    },
  })
  assert.equal(called, 0, 'the backup writer is not called at all')
  assert.equal(result.backup, null)
})

test('the hosted mode with an empty restart command takes no snapshot and restarts nothing', async (t) => {
  const { base } = fixture(t, 'empty-command')
  const state = stateDir(base, 'empty-command')
  const fake = fakeContext()
  const commands = []
  const snapshots = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file, { restartCommand: '   ' }), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => {
      snapshots.push(options)
      return takePreRestartSnapshot(options)
    },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The new watchdog is injected too: the test decides who is the arbiter
    // and NOTHING is registered on the machine.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.equal(snapshots.length, 0, 'no snapshot is taken for a restart that never happens')
  assert.deepEqual(commands, [], 'nothing was restarted')
  assert.equal(fs.existsSync(path.join(state.dir, 'backups')), false)
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('no restart method available')),
    'the reason is logged',
  )
})

test('the desktop app still falls back to the app relaunch when the command is empty', async (t) => {
  // The desktop app IS a restart method, so an empty restartCommand does not
  // stop it: the app is relaunched (and snapshotted) exactly as before.
  const { base } = fixture(t, 'desktop-empty-command')
  const state = stateDir(base, 'desktop-empty-command')
  const fake = fakeContext()
  const commands = []
  const scheduled = []
  const runtime = createRuntime(fake.ctx, hostedConfig(state.file, { restartCommand: '' }), {
    env: { isDesktopApp: true, appExePath: APP_EXE },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The new instance is confirmed without waiting for a real health route.
    // The NEW watchdog is injected too: the test decides that it could not be
    // armed, so NOTHING is registered on this machine and the old watcher (v1)
    // is the arbiter — which is exactly the fallback this test is about.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
    // The relaunch itself is injected: no real detached process, no scheduled
    // task, nothing on the machine.
    scheduleDetached: (options) => {
      scheduled.push(options)
      return { ok: true, method: 'wmi', error: null }
    },
  })
  runtime.webPort = 51004
  requestRestartNow(runtime)

  await runtime.executeRestart()

  assert.deepEqual(commands, [], 'the empty command was not run')
  assert.equal(scheduled.length, 1, 'the desktop app was relaunched instead')
  assert.equal(fs.existsSync(path.join(state.dir, 'backups')), true, 'the relaunch is snapshotted')

  // THE SAFETY NET, AS IT REALLY HAPPENED (2026-11-02).
  //
  // The old version of this test ended with a `schtasks /Delete` against the
  // REAL machine and a comment claiming a real one-off task had been armed —
  // while the watchdog had been forced to fail one line above. Two lies in one
  // test: nothing had been armed, and the cleanup could only ever delete
  // somebody else's task.
  //
  // What is true: v2 could not be armed, so v1 is the arbiter; the desktop
  // relaunch is handed the watcher script (the detached helper writes it when
  // it runs, which is why the file is NOT on disk here — the launcher is
  // injected).
  assert.ok(scheduled[0].watchScriptPath, 'the relaunch is handed a watcher script path')
  assert.match(String(scheduled[0].watchScriptPath), /-watch\.ps1$/, 'the v1 watcher script')
  assert.ok(
    String(scheduled[0].watchScriptPath).startsWith(state.dir),
    'and it lives in this state directory, not in a guessed one',
  )
  assert.ok(String(scheduled[0].watchScript || '').length > 0, 'the script has content')

  // The arbiter decision is on disk, so "who was watching" is not a guess.
  const report = JSON.parse(fs.readFileSync(path.join(state.dir, 'last-watchdog-report.json'), 'utf8'))
  assert.equal(report.arbiter, 'v1', 'the report says the old watcher took over')
  assert.equal(report.tier, 'none', 'and that no scheduled mechanism was used')
  assert.equal(report.result, 'armed', 'the report calls the old watcher armed')
  assert.match(
    String(report.tierReason || ''),
    /v2 is not available/,
    'and it says WHY: the new watchdog was not available',
  )
})
