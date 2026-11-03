/**
 * The supervisor: the daemon, the installation, the uninstallation.
 *
 * NOTHING here touches the machine: the platform commands are answered by a
 * FAKE EXECUTOR that records every call, so the tests can assert the exact
 * sequence (and so no scheduled task and no systemd unit is ever created on
 * the machine that runs the tests).
 *
 * The three things the task asks for are covered here:
 *
 *   - the installation is IDEMPOTENT (installing twice leaves ONE record);
 *   - the uninstallation leaves NO RESIDUE;
 *   - a machine that refuses the scheduled task DEGRADES to the startup
 *     folder instead of failing.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CONFIG_FILES as PLUGIN_CONFIG_FILES } from '../lib/backup.js'
import {
  buildSupervisorConfig,
  detectSupervisor,
  installSupervisor,
  readSupervisorConfig,
  supervisorPaths,
  supervisorStatus,
  uninstallSupervisor,
  writeRollbackRequest,
  readRollbackRequest,
} from '../lib/supervisor.js'
import { SUPERVISOR_TASK_NAME } from '../lib/supervisor-install.js'
import {
  acquireLock,
  buildChildEnv,
  buildControlResponse,
  CONFIG_FILES,
  nextRestartDelay,
  parseArgs,
  releaseLock,
  restoreSnapshot,
  shouldResetBackoff,
  SUPERVISED_ENV,
  SUPERVISOR_PID_ENV,
} from '../supervisor/supervisor.js'

const NODE = '/usr/bin/node'

/**
 * A fake executor that also remembers what was "created" on the machine.
 *
 * @param {{ failCreate?: boolean, failDelete?: boolean }} [options]
 */
function fakeExecutor(options = {}) {
  const calls = []
  const tasks = new Map()
  const fn = (file, args) => {
    const list = Array.isArray(args) ? args.map(String) : []
    calls.push({ file, args: list })
    if (file === 'schtasks' && list[0] === '/Create') {
      if (options.failCreate === true) {
        const error = new Error('ERROR: Access is denied.')
        error.status = 1
        error.stderr = 'ERROR: Access is denied.'
        throw error
      }
      const name = list[list.indexOf('/TN') + 1]
      // `/F` overwrites: the record is keyed by its name, so a second
      // installation cannot create a second one.
      tasks.set(name, (tasks.get(name) || 0) + 1)
      return ''
    }
    if (file === 'schtasks' && list[0] === '/Query') {
      const name = list[list.indexOf('/TN') + 1]
      if (!tasks.has(name)) {
        const error = new Error('ERROR: The system cannot find the file specified.')
        error.status = 1
        throw error
      }
      return 'TaskName: ' + name
    }
    if (file === 'schtasks' && list[0] === '/Delete') {
      if (options.failDelete === true) {
        const error = new Error('ERROR: Access is denied.')
        error.status = 1
        throw error
      }
      const name = list[list.indexOf('/TN') + 1]
      tasks.delete(name)
      return ''
    }
    return ''
  }
  fn.calls = calls
  fn.tasks = tasks
  return fn
}

/** A state directory and a startup folder for one test. */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-sup-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const stateDir = path.join(base, 'state')
  const startupDir = path.join(base, 'startup')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(startupDir, { recursive: true })
  return { base, stateDir, startupDir }
}

/** The options every installation in these tests uses. */
function installOptions(stateDir, startupDir, extra = {}) {
  return {
    stateDir,
    startupDir,
    platform: 'win32',
    confirmed: true,
    nodePath: NODE,
    execPath: NODE,
    argv: ['/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601', '--no-open'],
    execArgv: [],
    cwd: '/home/fg',
    healthUrl: 'http://127.0.0.1:5601/__dsh_autorestart/health',
    port: 5601,
    profileDir: '/home/fg/.dsh/profiles/web',
    homeDir: '/home/fg',
    env: {},
    previous: { restartMode: 'command', restartCommand: '/home/fg/restart-web.sh' },
    ...extra,
  }
}

test('the installation is IDEMPOTENT: installing twice leaves ONE record', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'idempotent')
  const exec = fakeExecutor()

  const first = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))
  assert.equal(first.ok, true, String(first.error))
  assert.equal(first.kind, 'windows-schtasks')
  assert.equal(first.installed, true)
  assert.equal(exec.tasks.size, 1, 'exactly one scheduled task exists')

  const second = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))
  assert.equal(second.ok, true, String(second.error))
  assert.equal(exec.tasks.size, 1, 'the second installation did not create a second task')
  assert.equal(
    exec.tasks.get(SUPERVISOR_TASK_NAME),
    2,
    'the same task name was written twice (the second one overwrites the first)',
  )

  // The files of the supervisor are there exactly once.
  const paths = supervisorPaths(stateDir)
  assert.ok(fs.existsSync(paths.script), 'the supervisor script was copied')
  assert.ok(fs.existsSync(paths.config), 'the configuration was written')
  const config = readSupervisorConfig(stateDir)
  assert.equal(config.ok, true)
  assert.equal(config.config.argv.length, 5)
  assert.deepEqual(config.config.previous, { restartMode: 'command', restartCommand: '/home/fg/restart-web.sh' })
})

test('a machine that refuses the scheduled task DEGRADES to the startup folder', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'degrade')
  const exec = fakeExecutor({ failCreate: true })

  const result = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.degraded, true, 'the installation fell back')
  assert.equal(result.kind, 'windows-startup')

  // THE CALL SEQUENCE: the task was tried first, the startup folder second.
  const created = exec.calls.filter((call) => call.args[0] === '/Create')
  assert.equal(created.length, 1, 'the scheduled task was tried exactly once')
  const startupFile = path.join(startupDir, SUPERVISOR_TASK_NAME + '.cmd')
  assert.ok(fs.existsSync(startupFile), 'the .cmd of the startup folder was written')
  assert.ok(fs.readFileSync(startupFile, 'utf8').includes('start ""'), 'the .cmd starts the supervisor')
  assert.match(String(result.reason), /startup folder/)
})

test('a machine that refuses BOTH forms does not pretend it worked', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'refused')
  const exec = fakeExecutor({ failCreate: true })
  // The startup folder cannot be written either.
  const result = installSupervisor(installOptions(stateDir, startupDir, {
    execFileSyncFn: exec,
    copySupervisor: () => {
      throw new Error('the disk is full')
    },
  }))
  assert.equal(result.ok, false)
  assert.match(String(result.error), /could not be copied/)
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'nothing was left behind')
})

test('a dry run writes NOTHING', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'dryrun')
  const exec = fakeExecutor()
  const result = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec, dryRun: true }))
  assert.equal(result.ok, true)
  assert.equal(result.installed, false)
  assert.ok(result.steps.length > 0, 'the plan is reported')
  assert.equal(exec.calls.length, 0, 'no command was run')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'no file was written')
})

test('without the confirmation nothing is installed', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'unconfirmed')
  const exec = fakeExecutor()
  const result = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec, confirmed: false }))
  assert.equal(result.ok, false)
  assert.match(String(result.error), /confirmation card/)
  assert.equal(exec.calls.length, 0, 'no command was run')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'no file was written')
})

test('the uninstallation leaves NO RESIDUE', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'uninstall')
  const exec = fakeExecutor()
  const installed = installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))
  assert.equal(installed.ok, true, String(installed.error))
  const paths = supervisorPaths(stateDir)
  assert.ok(fs.existsSync(paths.dir))

  const removed = await uninstallSupervisor({
    stateDir,
    startupDir,
    platform: 'win32',
    execFileSyncFn: exec,
    stopSupervisor: async () => ({ ok: true }),
  })
  assert.equal(removed.ok, true, String(removed.error))
  assert.equal(fs.existsSync(paths.dir), false, 'the supervisor directory is gone')
  assert.equal(fs.existsSync(paths.pendingUninstall), false, 'nothing is pending')
  assert.equal(exec.tasks.size, 0, 'the scheduled task is gone')
  // The previous start command is handed back to the caller (it writes it
  // into the profile again).
  assert.deepEqual(removed.previous, { restartMode: 'command', restartCommand: '/home/fg/restart-web.sh' })
})

test('an uninstallation that cannot finish WRITES DOWN what is left', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'pending')
  const exec = fakeExecutor()
  installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))

  const removed = await uninstallSupervisor({
    stateDir,
    startupDir,
    platform: 'win32',
    execFileSyncFn: fakeExecutor({ failDelete: true }),
    stopSupervisor: async () => ({ ok: true }),
  })
  assert.equal(removed.ok, false)
  assert.ok(removed.pending, 'the pending cleanup is reported')
  const paths = supervisorPaths(stateDir)
  assert.ok(fs.existsSync(paths.pendingUninstall), 'the pending cleanup is written down')
  const pending = JSON.parse(fs.readFileSync(paths.pendingUninstall, 'utf8'))
  assert.ok(Array.isArray(pending.failed))
  assert.ok(pending.manual.some((line) => line.includes('schtasks')), 'the manual command is listed')
})

test('the status says who starts the host and whether the restart can work', async (t) => {
  const { stateDir, startupDir } = fixture(t, 'status')
  const exec = fakeExecutor()

  const unknown = supervisorStatus({ stateDir, env: {} })
  assert.equal(unknown.mode, 'unknown')
  assert.equal(unknown.restartCapable, false, 'without a supervisor the host does not come back')

  installSupervisor(installOptions(stateDir, startupDir, { execFileSyncFn: exec }))
  const installed = supervisorStatus({ stateDir, env: {} })
  assert.equal(installed.mode, 'installed')
  assert.equal(installed.installed, true)
  assert.equal(installed.kind, 'windows-schtasks')

  // An instance the supervisor started: the environment marker is the proof.
  const supervised = supervisorStatus({
    stateDir,
    env: { [SUPERVISED_ENV]: '1', [SUPERVISOR_PID_ENV]: '4242' },
  })
  assert.equal(supervised.supervised, true)
  assert.equal(supervised.restartCapable, true, 'the supervisor brings the host back')

  // The user keeps their own way: their supervisor does the job.
  const external = supervisorStatus({ stateDir, env: {}, mode: 'external' })
  assert.equal(external.mode, 'external')
  assert.equal(external.restartCapable, true)
})

test('the environment marker is the authoritative evidence', () => {
  const detected = detectSupervisor({ env: { [SUPERVISED_ENV]: '1', [SUPERVISOR_PID_ENV]: '99' } })
  assert.equal(detected.supervised, true)
  assert.equal(detected.pid, 99)

  const manual = detectSupervisor({ env: {} })
  assert.equal(manual.supervised, false)
  assert.match(manual.reason, /not started by a supervisor/)
})

test('the daemon inherits a WHITELIST and marks the host as supervised', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/fg',
    DSH_HOME: '/home/fg/.dsh',
    DSH_PROFILE: 'web',
    SECRET_TOKEN: 'nope',
  }, { supervisorPid: 4711, generation: 3 })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/fg')
  assert.equal(env.DSH_HOME, undefined, 'the host variables of the parent are NOT inherited')
  assert.equal(env.DSH_PROFILE, undefined)
  assert.equal(env.SECRET_TOKEN, undefined)
  assert.equal(env[SUPERVISED_ENV], '1')
  assert.equal(env[SUPERVISOR_PID_ENV], '4711')
  assert.equal(env.DSH_AUTORESTART_GENERATION, '3')
})

test('the backoff doubles, is capped and is reset only by a healthy start', () => {
  assert.equal(nextRestartDelay(1000, { baseMs: 1000, maxMs: 30000 }), 2000)
  assert.equal(nextRestartDelay(16000, { baseMs: 1000, maxMs: 30000 }), 30000)
  assert.equal(nextRestartDelay(30000, { baseMs: 1000, maxMs: 30000 }), 30000, 'the cap holds')
  assert.equal(shouldResetBackoff(true), true, 'a healthy start resets the delay')
  assert.equal(shouldResetBackoff(false), false, 'a start that died again keeps the delay')
})

test('the lock keeps a second supervisor away, and a dead one is taken over', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-lock-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const lock = path.join(base, 'supervisor.lock')

  const first = acquireLock(lock, { pid: 111 })
  assert.equal(first.ok, true)
  assert.equal(first.stale, false)

  // A LIVE owner blocks the second one.
  const second = acquireLock(lock, { pid: 222, isAlive: () => true })
  assert.equal(second.ok, false)
  assert.match(String(second.error), /already running/)

  // A DEAD owner does not: the lock is taken over.
  const third = acquireLock(lock, { pid: 333, isAlive: () => false })
  assert.equal(third.ok, true)
  assert.equal(third.stale, true)
  assert.equal(releaseLock(lock), true)
})

test('the control channel answers the three known actions', () => {
  assert.deepEqual(buildControlResponse({ action: 'ping' }), { ok: true, action: 'ping', error: null })
  assert.deepEqual(buildControlResponse({ action: 'restart' }), { ok: true, action: 'restart', error: null })
  assert.deepEqual(buildControlResponse({ action: 'stop' }), { ok: true, action: 'stop', error: null })
  assert.equal(buildControlResponse({ action: 'rm -rf' }).ok, false)
  assert.equal(buildControlResponse(null).ok, false)
})

test('the daemon reads its configuration from the command line', () => {
  assert.deepEqual(parseArgs(['--config', '/state/supervisor.json']), { configPath: '/state/supervisor.json', help: false })
  assert.deepEqual(parseArgs(['--config=/state/supervisor.json']), { configPath: '/state/supervisor.json', help: false })
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs([]).configPath, null)
})

test('the daemon puts the snapshot back when the host never comes back', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-restore-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  const backup = path.join(base, 'backup', 'config')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(backup, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'broken\n', 'utf8')
  fs.writeFileSync(path.join(backup, 'cordis.patch.yml'), 'good\n', 'utf8')
  fs.writeFileSync(path.join(backup, 'package.json'), '{"name":"demo"}\n', 'utf8')

  const restored = restoreSnapshot({ backupDir: path.join(base, 'backup'), profileDir: profile })
  assert.equal(restored.ok, true, String(restored.error))
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'good\n')
  assert.ok(restored.restored.includes('cordis.patch.yml'))
})

test('the daemon and the plugin agree about the files a rollback puts back', () => {
  assert.deepEqual([...CONFIG_FILES].sort(), [...PLUGIN_CONFIG_FILES].sort())
})

test('the rollback request is written where the daemon reads it', (t) => {
  const { stateDir } = fixture(t, 'rollback-request')
  const written = writeRollbackRequest(stateDir, {
    backupDir: '/state/backups/2026',
    profileDir: '/home/fg/.dsh/profiles/web',
    generation: 4,
    reason: 'plugin-restart',
  })
  assert.equal(written.ok, true, String(written.error))
  const request = readRollbackRequest(stateDir)
  assert.equal(request.backupDir, '/state/backups/2026')
  assert.equal(request.profileDir, '/home/fg/.dsh/profiles/web')
  assert.equal(request.generation, 4)
})

test('the supervisor configuration carries what the daemon needs', () => {
  const config = buildSupervisorConfig({
    execPath: '/usr/bin/node',
    argv: ['dsh', 'web'],
    port: 5601,
    healthUrl: 'http://127.0.0.1:5601/__dsh_autorestart/health',
    stateDir: '/state',
    ownerUser: 'fg',
  })
  assert.equal(config.version, 1)
  assert.equal(config.execPath, '/usr/bin/node')
  assert.equal(config.port, 5601)
  assert.equal(config.ownerUser, 'fg')
  assert.equal(config.control.type, 'tcp')
  assert.equal(config.control.host, '127.0.0.1')
  assert.equal(config.mode, 'installed')
  assert.equal(config.timings.restartDelayMaxMs, 30000)
})
