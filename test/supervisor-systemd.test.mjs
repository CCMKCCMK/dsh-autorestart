/**
 * THE LINUX PATH OF THE SUPERVISOR.
 *
 * On Linux the "install at login" is a systemd user unit, and the unit is
 * registered with `systemctl`. The bug this file guards against is the
 * DOUBLE-SPLICED PROGRAM NAME: a step carries the program in `file` and the
 * arguments in `args`, so `file: 'systemctl'` with
 * `args: ['systemctl', '--user', …]` runs
 *
 *     systemctl systemctl --user daemon-reload
 *
 * which every systemd answers with "Unknown command verb systemctl". The
 * "install at login" therefore failed on EVERY Linux machine — the unit file
 * was written, but it was never enabled.
 *
 * NOTHING here touches the machine: the platform commands are answered by a
 * fake executor that records the full argv, so no systemd unit is ever
 * created on the machine that runs the tests.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  installSupervisor,
  supervisorPaths,
  uninstallSupervisor,
} from '../lib/supervisor.js'
import {
  buildInstallSteps,
  buildUninstallSteps,
  normalizeCommandArgs,
  stepCommandLine,
  SUPERVISOR_TASK_NAME,
  systemdUserUnitPath,
} from '../lib/supervisor-install.js'

const NODE = '/usr/bin/node'
const UNIT = SUPERVISOR_TASK_NAME + '.service'

/**
 * A fake executor that records the FULL argv (the program and its arguments).
 *
 * @param {Record<string, unknown>} [rules]
 */
function fakeExecutor(rules = {}) {
  const calls = []
  const fn = (file, args) => {
    const argv = [String(file), ...(Array.isArray(args) ? args.map(String) : [])]
    calls.push(argv)
    const line = argv.join(' ')
    const rule = rules[line] !== undefined
      ? rules[line]
      : (rules[argv.slice(1).join(' ')] !== undefined ? rules[argv.slice(1).join(' ')] : (rules[file] !== undefined ? rules[file] : rules.default))
    if (rule === 'fail') {
      const error = new Error('Command failed: ' + line)
      error.status = 1
      error.stderr = 'Unknown command verb.'
      throw error
    }
    return ''
  }
  fn.calls = calls
  Object.defineProperty(fn, 'lines', { get: () => calls.map((argv) => argv.join(' ')) })
  return fn
}

/**
 * A state directory and a home directory for one test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} label
 */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-systemd-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const stateDir = path.join(base, 'state')
  const homeDir = path.join(base, 'home')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  return { base, stateDir, homeDir }
}

/**
 * The options of a Linux installation.
 *
 * @param {{ stateDir: string, homeDir: string, exec: Function }} options
 */
function linuxInstallOptions({ stateDir, homeDir, exec }) {
  return {
    stateDir,
    homeDir,
    platform: 'linux',
    confirmed: true,
    nodePath: NODE,
    execPath: NODE,
    argv: ['/usr/bin/node', '/usr/local/bin/dsh', 'web', '--port', '5601'],
    execArgv: [],
    cwd: '/home/fg',
    env: {},
    execFileSyncFn: exec,
    // The machine has a systemd user manager (and no container).
    existsSyncFn: (target) => target === '/run/systemd/system',
    copySupervisor: () => '// fake supervisor',
  }
}

test('no step ever repeats the program name (the "systemctl systemctl" bug)', () => {
  const install = buildInstallSteps({
    platform: 'linux',
    nodePath: NODE,
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
  })
  const uninstall = buildUninstallSteps({ platform: 'linux', homeDir: '/home/fg' })
  for (const step of [...install, ...uninstall]) {
    if (!step.file) continue
    // The program is in `file`; the arguments must NOT carry it.
    assert.equal(step.args.filter((part) => part === 'systemctl').length, 0, step.kind)
    // The full command line: the program comes first, and only once.
    const argv = [step.file, ...step.args]
    assert.equal(argv[0], 'systemctl', 'the program comes first: ' + argv.join(' '))
    assert.equal(argv.filter((part) => part === 'systemctl').length, 1, 'the program is repeated: ' + argv.join(' '))
    assert.equal(
      normalizeCommandArgs(step.file, step.args).filter((part) => part === 'systemctl').length,
      0,
      step.kind,
    )
  }
  // The command line that is shown to the user is the one that really runs.
  assert.equal(
    stepCommandLine(install.find((step) => step.kind === 'enable')),
    'systemctl --user enable --now ' + UNIT,
  )
})

test('the Windows steps do not repeat the program name either', () => {
  const install = buildInstallSteps({
    platform: 'win32',
    nodePath: 'C:\\nodejs\\node.exe',
    supervisorPath: 'C:\\state\\supervisor.js',
    configPath: 'C:\\state\\supervisor.json',
    startupDir: 'C:\\Startup',
  })
  const uninstall = buildUninstallSteps({ platform: 'win32' })
  for (const step of [...install, ...uninstall]) {
    if (!step.file) continue
    const argv = [step.file, ...step.args]
    assert.equal(argv[0], 'schtasks')
    assert.equal(argv.filter((part) => part === 'schtasks').length, 1, 'the program is repeated: ' + argv.join(' '))
    assert.equal(step.args.filter((part) => part === 'schtasks').length, 0, step.kind)
  }
  // The startup folder is a file, not a command.
  assert.equal(install[1].file, undefined)
})

test('a Linux installation runs the three systemd commands and writes the unit', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'install')
  const exec = fakeExecutor()

  const result = installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))

  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.kind, 'systemd-user')

  // THE PROGRAM COMES FIRST, AND ONLY ONCE.
  for (const argv of exec.calls) {
    assert.equal(argv[0], 'systemctl', 'the program comes first: ' + argv.join(' '))
    assert.equal(argv.filter((part) => part === 'systemctl').length, 1, 'the program is repeated: ' + argv.join(' '))
  }
  assert.ok(exec.lines.includes('systemctl --user daemon-reload'))
  assert.ok(exec.lines.includes('systemctl --user enable --now ' + UNIT))
  assert.ok(exec.lines.includes('systemctl --user is-active --quiet ' + UNIT))
  assert.equal(exec.lines.some((line) => line.includes('systemctl systemctl')), false)

  // The unit is really there.
  const unitPath = systemdUserUnitPath({ homeDir })
  assert.equal(fs.existsSync(unitPath), true, 'the unit file was written')
  assert.ok(fs.readFileSync(unitPath, 'utf8').includes('ExecStart="/usr/bin/node"'))
})

test('an installation that fails half way ROLLS BACK what it wrote', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'rollback')
  const exec = fakeExecutor({ ['systemctl --user enable --now ' + UNIT]: 'fail' })

  const result = installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))

  assert.equal(result.ok, false, 'the installation failed')
  assert.match(String(result.error), /enable and start the unit failed/)
  // The unit file that was written before the failure is gone again.
  const unitPath = systemdUserUnitPath({ homeDir })
  assert.equal(fs.existsSync(unitPath), false, 'the unit file was rolled back')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).dir), false, 'the supervisor directory was rolled back')
  // The rollback is REPORTED, not swallowed.
  const rollback = result.steps.filter((step) => String(step.kind).startsWith('rollback-'))
  assert.ok(rollback.length > 0, 'the rollback is in the report')
  assert.ok(rollback.some((step) => step.kind === 'rollback-unit-file' && step.ok === true))
  // The unit was disabled again, so nothing starts at the next login.
  assert.ok(exec.lines.includes('systemctl --user disable --now ' + UNIT))
  // Nothing is left over: the rollback worked, so there is no to-do list.
  assert.equal(fs.existsSync(supervisorPaths(stateDir).pendingUninstall), false)
})

test('an installation whose unit file cannot be written fails without crashing', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'unwritable')
  const exec = fakeExecutor()
  // A FILE where the directory of the unit has to be: the write must fail
  // with an error, not with a crash.
  fs.mkdirSync(path.join(homeDir, '.config'), { recursive: true })
  fs.writeFileSync(path.join(homeDir, '.config', 'systemd'), 'not a directory', 'utf8')

  const result = installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))

  assert.equal(result.ok, false)
  assert.match(String(result.error), /unit file could not be written/)
  assert.equal(fs.existsSync(supervisorPaths(stateDir).dir), false)
})

test('a clean uninstall leaves NOTHING behind', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'uninstall')
  const exec = fakeExecutor()

  const installed = installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))
  assert.equal(installed.ok, true, String(installed.error))

  const removed = await uninstallSupervisor({
    stateDir,
    homeDir,
    platform: 'linux',
    execFileSyncFn: exec,
    stopSupervisor: async () => ({ ok: true }),
  })

  assert.equal(removed.ok, true, String(removed.error))
  assert.equal(fs.existsSync(supervisorPaths(stateDir).dir), false, 'the supervisor directory is gone')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).pendingUninstall), false, 'no to-do list is left')
  assert.equal(fs.existsSync(systemdUserUnitPath({ homeDir })), false, 'the unit file is gone')
  for (const argv of exec.calls) {
    assert.equal(argv.filter((part) => part === 'systemctl').length, 1, 'the program is repeated: ' + argv.join(' '))
  }
  assert.ok(exec.lines.includes('systemctl --user disable --now ' + UNIT))
  assert.ok(exec.lines.includes('systemctl --user daemon-reload'))
})

test('an uninstall that cannot disable the record says so and writes the to-do list', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'pending')
  const exec = fakeExecutor()

  installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))

  const blocked = fakeExecutor({ ['systemctl --user disable --now ' + UNIT]: 'fail' })
  const removed = await uninstallSupervisor({
    stateDir,
    homeDir,
    platform: 'linux',
    execFileSyncFn: blocked,
    stopSupervisor: async () => ({ ok: true }),
  })

  assert.equal(removed.ok, false, 'the uninstall did not finish')
  assert.ok(removed.pending, 'the to-do list is reported')
  const disable = removed.steps.find((step) => step.kind === 'disable')
  assert.equal(disable.ok, false, 'a failed disable must not pretend to have worked')
  // The to-do list is written next to the supervisor directory — NOT inside
  // it, so writing it cannot bring the directory back to life.
  const paths = supervisorPaths(stateDir)
  assert.equal(fs.existsSync(paths.pendingUninstall), true, 'the to-do list was written')
  assert.equal(path.dirname(paths.pendingUninstall), path.dirname(paths.dir), 'the list lives next to the directory')
  assert.equal(fs.existsSync(paths.dir), false, 'the supervisor directory is really gone')
  const cleanup = removed.steps.find((step) => step.kind === 'cleanup')
  assert.equal(cleanup.ok, true, 'the cleanup step must match the state of the machine')
  // The list names the command the user has to run — and it is the real one.
  const written = JSON.parse(fs.readFileSync(paths.pendingUninstall, 'utf8'))
  assert.ok(written.manual.some((line) => line === 'systemctl --user disable --now ' + UNIT))
  assert.equal(written.manual.some((line) => line.includes('systemctl systemctl')), false)
})

test('the to-do list of an earlier attempt is gone after a clean uninstall', async (t) => {
  const { stateDir, homeDir } = fixture(t, 'stale')
  const exec = fakeExecutor()

  installSupervisor(linuxInstallOptions({ stateDir, homeDir, exec }))

  // A list from an earlier, failed attempt.
  const paths = supervisorPaths(stateDir)
  fs.writeFileSync(paths.pendingUninstall, JSON.stringify({ manual: ['stale'] }), 'utf8')

  const removed = await uninstallSupervisor({
    stateDir,
    homeDir,
    platform: 'linux',
    execFileSyncFn: exec,
    stopSupervisor: async () => ({ ok: true }),
  })

  assert.equal(removed.ok, true, String(removed.error))
  assert.equal(fs.existsSync(paths.pendingUninstall), false, 'a stale to-do list is removed')
})
