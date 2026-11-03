/**
 * THE TWO ENDS MUST NOT LIE TO EACH OTHER.
 *
 * The desktop app and the hosted web host are two different worlds, and the
 * supervisor must behave in both:
 *
 *   - **the desktop app** brings ITSELF back up (`restartMode: app`). A login
 *     record that starts the supervisor would start a SECOND client at every
 *     login, so the desktop host REFUSES the installation — and it refuses it
 *     before a single step is generated. Its status must not say "the restart
 *     is not available": the restart works, the app does it itself.
 *   - **the hosted host** may install a supervisor, but the record must start
 *     a REAL node interpreter. The application executable is never used as a
 *     stand-in for node (it would open the whole client again).
 *
 * NOTHING here touches the machine: the platform commands are answered by a
 * fake executor, so no scheduled task and no startup file is ever created on
 * the machine that runs the tests.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DESKTOP_RESTART_REASON,
  DESKTOP_SUPERVISOR_ERROR,
  DESKTOP_SUPERVISOR_REASON,
  installSupervisor,
  NODE_INTERPRETER_ERROR,
  planSupervisorInstall,
  supervisorPaths,
  supervisorStatus,
} from '../lib/supervisor.js'
import { isNodeExecutable, resolveNodeInterpreter } from '../lib/node-runtime.js'

/** The executable of the desktop app (the Electron client). */
const APP_EXE = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'

/** The node that runs these tests — a real one, and it exists. */
const REAL_NODE = process.execPath

/**
 * A fake executor that records every call.
 *
 * @returns {Function}
 */
function fakeExecutor() {
  const calls = []
  const fn = (file, args) => {
    calls.push({ file, args: Array.isArray(args) ? args.map(String) : [] })
    return ''
  }
  fn.calls = calls
  return fn
}

/**
 * A state directory and a startup folder for one test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} label
 */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-desktop-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const stateDir = path.join(base, 'state')
  const startupDir = path.join(base, 'startup')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(startupDir, { recursive: true })
  return { base, stateDir, startupDir }
}

/**
 * The command of the first step of a plan (what the record would start).
 *
 * @param {any} step
 * @returns {string}
 */
function commandOf(step) {
  if (step && typeof step.command === 'string') return step.command
  const args = step && Array.isArray(step.args) ? step.args : []
  const index = args.indexOf('/TR')
  return index >= 0 ? args[index + 1] : ''
}

/* ------------------------------------------------------------------ *
 * THE DESKTOP END
 * ------------------------------------------------------------------ */

test('the desktop app is REFUSED a "start at login" record (it would open a second client)', () => {
  const plan = planSupervisorInstall({
    platform: 'win32',
    isDesktopApp: true,
    nodePath: APP_EXE,
    execPath: APP_EXE,
    supervisorPath: 'C:\\state\\supervisor\\supervisor.js',
    configPath: 'C:\\state\\supervisor\\supervisor.json',
  })

  assert.equal(plan.error, DESKTOP_SUPERVISOR_ERROR)
  assert.equal(plan.error, 'desktop-manages-itself')
  assert.equal(plan.reason, DESKTOP_SUPERVISOR_REASON)
  assert.equal(plan.reason, 'the desktop app relaunches itself; a supervisor would start a second copy')
  assert.deepEqual(plan.steps, [], 'no step may be generated on the desktop')
  assert.equal(plan.kind, 'none')
  assert.equal(JSON.stringify(plan).includes('DeepSeek Harness.exe'), false, 'the app executable is nowhere in the plan')
})

test('the desktop app installs NOTHING: no command runs, no file is written', (t) => {
  const { stateDir, startupDir } = fixture(t, 'install-refused')
  const exec = fakeExecutor()

  const result = installSupervisor({
    stateDir,
    startupDir,
    platform: 'win32',
    isDesktopApp: true,
    confirmed: true,
    nodePath: APP_EXE,
    execPath: APP_EXE,
    argv: [APP_EXE],
    execArgv: [],
    cwd: 'C:\\app',
    env: {},
    execFileSyncFn: exec,
    copySupervisor: () => '// would never be written',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, DESKTOP_SUPERVISOR_ERROR)
  assert.equal(result.installed, false)
  assert.deepEqual(result.steps, [], 'there is no step that could be run')
  assert.equal(exec.calls.length, 0, 'no command was run')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'no supervisor script was written')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).config), false, 'no configuration was written')
  assert.equal(fs.readdirSync(startupDir).length, 0, 'the startup folder stayed empty')
})

test('the desktop app says the restart IS available (it restarts itself)', () => {
  const status = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-desktop-status-does-not-exist'),
    env: {},
    platform: 'win32',
    isDesktopApp: true,
  })

  assert.equal(status.mode, 'app')
  assert.equal(status.restartCapable, true, 'the desktop app relaunches itself')
  assert.equal(status.reason, DESKTOP_RESTART_REASON)
  assert.equal(status.reason, 'the desktop app relaunches itself (restartMode: app)')
  assert.equal(status.selfReplay, 'n/a')
  assert.equal(status.mode === 'unknown', false, 'the desktop app is not "nobody knows"')
})

test('a hosted host without a supervisor still says "unknown" (only the desktop changed)', () => {
  const status = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-hosted-status-does-not-exist'),
    env: {},
    platform: 'win32',
    isDesktopApp: false,
  })
  assert.equal(status.mode, 'unknown')
  assert.equal(status.restartCapable, false)
})

/* ------------------------------------------------------------------ *
 * THE HOSTED END
 * ------------------------------------------------------------------ */

test('the hosted host starts the supervisor with a REAL node, not with the app executable', () => {
  assert.equal(isNodeExecutable(REAL_NODE), true, 'the test runs on a real node')
  assert.equal(isNodeExecutable(APP_EXE), false, 'the app executable is not an interpreter')

  const plan = planSupervisorInstall({
    platform: 'win32',
    isDesktopApp: false,
    nodePath: REAL_NODE,
    execPath: REAL_NODE,
    supervisorPath: 'C:\\state\\supervisor\\supervisor.js',
    configPath: 'C:\\state\\supervisor\\supervisor.json',
  })

  assert.equal(plan.error, null)
  assert.ok(plan.steps.length > 0, 'the hosted host gets a plan')
  const first = plan.steps[0]
  assert.equal(first.nodePath, REAL_NODE, 'the first step names the node interpreter')
  assert.equal(fs.existsSync(first.nodePath), true, 'the node interpreter really exists')
  assert.equal(first.command.startsWith('"' + REAL_NODE + '"'), true, 'the command starts the node interpreter')
  assert.equal(commandOf(first).startsWith('"' + REAL_NODE + '"'), true)
  assert.equal(JSON.stringify(plan.steps).includes('DeepSeek Harness.exe'), false, 'the app executable is nowhere')
})

test('the hosted installation registers a record that starts node', (t) => {
  const { stateDir, startupDir } = fixture(t, 'hosted-install')
  const exec = fakeExecutor()

  const result = installSupervisor({
    stateDir,
    startupDir,
    platform: 'win32',
    isDesktopApp: false,
    confirmed: true,
    nodePath: REAL_NODE,
    execPath: REAL_NODE,
    argv: ['C:\\nodejs\\node.exe', 'C:\\dsh\\bin\\dsh', 'web', '--port', '5601'],
    execArgv: [],
    cwd: 'C:\\dsh',
    env: {},
    execFileSyncFn: exec,
    copySupervisor: () => '// fake supervisor',
  })

  assert.equal(result.ok, true, String(result.error))
  const created = exec.calls.find((call) => call.args[0] === '/Create')
  assert.ok(created, 'the record was registered')
  const command = created.args[created.args.indexOf('/TR') + 1]
  assert.equal(command.startsWith('"' + REAL_NODE + '"'), true, 'the record starts the node interpreter')
  assert.equal(command.includes('DeepSeek Harness.exe'), false, 'the record never names the app executable')
})

test('without a node interpreter the installation is REFUSED, and the reason says so', (t) => {
  const { stateDir, startupDir } = fixture(t, 'no-node')
  const exec = fakeExecutor()

  const options = {
    platform: 'win32',
    isDesktopApp: false,
    nodePath: APP_EXE,
    execPath: APP_EXE,
    env: { PATH: '' },
    existsSyncFn: () => false,
  }

  const plan = planSupervisorInstall({
    ...options,
    supervisorPath: path.join(stateDir, 'supervisor', 'supervisor.js'),
    configPath: path.join(stateDir, 'supervisor', 'supervisor.json'),
  })
  assert.equal(plan.error, NODE_INTERPRETER_ERROR)
  assert.equal(plan.error, 'node-interpreter-not-found')
  assert.match(String(plan.reason), /node/i)
  assert.deepEqual(plan.steps, [], 'no step is generated without an interpreter')
  assert.equal(JSON.stringify(plan).includes('DeepSeek Harness.exe'), false, 'the app executable is nowhere')

  const result = installSupervisor({
    ...options,
    stateDir,
    startupDir,
    confirmed: true,
    argv: [APP_EXE],
    execArgv: [],
    cwd: 'C:\\app',
    execFileSyncFn: exec,
    copySupervisor: () => '// would never be written',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, NODE_INTERPRETER_ERROR)
  assert.equal(exec.calls.length, 0, 'no command was run')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'nothing was written')
})

test('the node of the installation is found before the PATH', () => {
  const installDir = 'C:\\Program Files\\DeepSeek Harness'
  const bundled = path.join(
    installDir,
    'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
  )
  const found = resolveNodeInterpreter({
    platform: 'win32',
    execPath: path.join(installDir, 'DeepSeek Harness.exe'),
    env: { PATH: 'C:\\Windows\\system32' },
    existsSyncFn: (candidate) => candidate === bundled,
  })
  assert.equal(found.ok, true)
  assert.equal(found.path, bundled)
  assert.equal(found.source, 'install-dir')
})
