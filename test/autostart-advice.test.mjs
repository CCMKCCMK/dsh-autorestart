/**
 * THE "START AT LOGIN" GUIDE OF EVERY PLATFORM.
 *
 * The guide is not only for WSL: EVERY hosted platform has to say how
 * "start at login" works there — the scheduled task on Windows, the systemd
 * user unit on Linux, the two ways out inside WSL, the orchestrator in a
 * container, and nothing at all when nobody can tell.
 *
 * The rules that matter:
 *   - the record names a REAL node (never the application executable);
 *   - inside WSL there is NEVER a Docker/Compose answer;
 *   - a host that is only GUESSED to be WSL gets no automatic anything.
 *
 * NOTHING here touches the machine: the platform commands are answered by a
 * fake executor.
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
  planSupervisorInstall,
  supervisorPaths,
  supervisorStatus,
} from '../lib/supervisor.js'
import { planAutostartAdvice } from '../lib/autostart-advice.js'
import { detectHostKind, HOST_KINDS } from '../lib/host-kind.js'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SUPERVISOR = 'C:\\state\\dsh-autorestart\\supervisor\\supervisor.js'
const CONFIG = 'C:\\state\\dsh-autorestart\\supervisor\\supervisor.json'

/**
 * A fake executor that records every call.
 *
 * @param {{ failCreate?: boolean }} [options]
 */
function fakeExecutor(options = {}) {
  const calls = []
  const fn = (file, args) => {
    const list = Array.isArray(args) ? args.map(String) : []
    calls.push({ file, args: list })
    if (options.failCreate === true && file === 'schtasks' && list[0] === '/Create') {
      const error = new Error('ERROR: Access is denied.')
      error.status = 1
      error.stderr = 'ERROR: Access is denied.'
      throw error
    }
    return ''
  }
  fn.calls = calls
  return fn
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} label
 */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-advice-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const stateDir = path.join(base, 'state')
  const startupDir = path.join(base, 'startup')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(startupDir, { recursive: true })
  return { base, stateDir, startupDir }
}

test('WSL with systemd: the unit is installed AND the linger is named', () => {
  const plan = planSupervisorInstall({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
    user: 'fg',
    host: { kind: HOST_KINDS.WSL, distro: 'Ubuntu-22.04', evidence: 'WSL_DISTRO_NAME' },
    // The machine has a systemd user manager.
    existsSyncFn: (target) => target === '/run/systemd/system',
  })

  assert.equal(plan.error, null)
  assert.equal(plan.kind, 'systemd-user')
  assert.ok(plan.steps.length > 0, 'the unit is still installed')
  // THE LINGER: without it the unit only starts after a login.
  assert.ok(
    plan.commands.includes('loginctl enable-linger fg'),
    'the linger command is copyable: ' + JSON.stringify(plan.commands),
  )
  assert.match(plan.reason, /loginctl enable-linger/)
  assert.match(plan.reason, /开机自启/)
})

test('WSL without systemd: TWO ways out, and NEVER a docker/compose answer', () => {
  const plan = planSupervisorInstall({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
    user: 'fg',
    host: { kind: HOST_KINDS.WSL, distro: 'Ubuntu-22.04', evidence: 'WSL_DISTRO_NAME' },
    // No systemd on this machine.
    existsSyncFn: () => false,
  })

  assert.equal(plan.error, 'wsl-no-systemd')
  assert.deepEqual(plan.steps, [], 'nothing is installed')
  assert.equal(plan.compose, null, 'NO compose fragment inside WSL')

  const text = [plan.reason, ...plan.notes, ...plan.commands, ...plan.options.map((o) => o.command + ' ' + o.cost)].join('\n')
  assert.equal(/docker/i.test(text), false, 'WSL never gets a Docker answer')
  assert.equal(/compose/i.test(text), false, 'WSL never gets a Compose answer')

  // The two ways out, with their costs.
  assert.equal(plan.options.length, 2)
  const [systemd, windows] = plan.options
  assert.match(systemd.command, /wsl\.conf/)
  assert.match(systemd.command, /systemd=true/)
  assert.match(systemd.command, /wsl --shutdown/)
  assert.match(systemd.cost, /系统配置改动/)
  assert.match(windows.command, /wsl\.exe -d Ubuntu-22\.04 -e/)
  assert.equal(windows.recommended, true, 'the Windows side is the recommended way')
  assert.match(windows.cost, /Windows 侧操作/)
  assert.match(windows.cost, /开机自启/)
})

test('a SUSPECTED WSL gets a hint only — the plugin changes nothing', () => {
  const plan = planSupervisorInstall({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
    user: 'fg',
    // Only the mounted Windows drive says "WSL": that is a hint, not a proof.
    host: { kind: HOST_KINDS.WSL, suspect: true, distro: 'Ubuntu-22.04', evidence: '/mnt/c/Windows/System32/shutdown.exe' },
    existsSyncFn: () => false,
  })

  assert.equal(plan.error, 'wsl-no-systemd')
  assert.deepEqual(plan.steps, [], 'nothing is installed')
  assert.equal(plan.compose, null)
  assert.match(plan.reason, /没把握/)
  assert.match(plan.reason, /手动选一条/)
  assert.match(plan.reason, /不会替你改任何系统配置/)
})

test('LINUX (not WSL) keeps its behaviour: a systemd user unit and the linger hint', () => {
  const plan = planSupervisorInstall({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
    user: 'fg',
    host: { kind: HOST_KINDS.LINUX, evidence: 'process.platform' },
    existsSyncFn: (target) => target === '/run/systemd/system',
  })

  assert.equal(plan.error, null)
  assert.equal(plan.kind, 'systemd-user')
  assert.ok(plan.steps.length > 0)
  assert.ok(plan.commands.includes('loginctl enable-linger fg'), 'the linger hint is there')
  assert.match(plan.reason, /systemd 用户服务/)
})

test('WINDOWS: the record names a REAL node — never the app executable', () => {
  const plan = planSupervisorInstall({
    platform: 'win32',
    nodePath: NODE,
    supervisorPath: SUPERVISOR,
    configPath: CONFIG,
    startupDir: 'C:\\Startup',
    host: { kind: HOST_KINDS.WINDOWS, evidence: 'process.platform' },
  })

  const task = plan.steps.find((step) => step.kind === 'windows-schtasks')
  assert.ok(task, 'the scheduled task is the first form')
  assert.ok(task.args.includes('/SC') && task.args.includes('ONLOGON'), 'it starts at login')
  assert.ok(task.args.includes('/RL') && task.args.includes('LIMITED'), 'no administrator rights')
  const command = task.args[task.args.indexOf('/TR') + 1]
  assert.equal(command, '"' + NODE + '" "' + SUPERVISOR + '" --config "' + CONFIG + '"')
  assert.equal(command.includes('DeepSeek Harness.exe'), false, 'never the app executable')
  // The guide says so too.
  assert.match(plan.reason, /计划任务/)
  assert.match(plan.reason, /启动文件夹/)
})

test('WINDOWS: a refused scheduled task degrades to a startup-folder .cmd with the real node', (t) => {
  const { stateDir, startupDir } = fixture(t, 'windows-degrade')
  const exec = fakeExecutor({ failCreate: true })

  const result = installSupervisor({
    stateDir,
    startupDir,
    platform: 'win32',
    confirmed: true,
    nodePath: NODE,
    execPath: NODE,
    argv: [NODE, 'C:\\dsh\\bin\\dsh', 'web'],
    execArgv: [],
    cwd: 'C:\\dsh',
    env: {},
    host: { kind: HOST_KINDS.WINDOWS, evidence: 'process.platform' },
    execFileSyncFn: exec,
    copySupervisor: () => '// fake',
  })

  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.degraded, true, 'the task was refused → the startup folder')
  const file = path.join(startupDir, 'dsh-autorestart-web.cmd')
  assert.equal(fs.existsSync(file), true, 'the .cmd was written')
  const content = fs.readFileSync(file, 'utf8')
  assert.ok(content.includes('"' + NODE + '"'), 'the .cmd starts the REAL node: ' + content)
  assert.ok(
    content.includes(supervisorPaths(stateDir).script),
    'the .cmd runs the supervisor script: ' + content,
  )
  assert.equal(content.includes('DeepSeek Harness.exe'), false, 'never the app executable')
})

test('the guide of the three platforms is readable in the status', () => {
  const windows = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-advice-status-does-not-exist'),
    env: {},
    platform: 'win32',
    autostart: planAutostartAdvice({ host: { kind: HOST_KINDS.WINDOWS }, platform: 'win32' }),
  })
  assert.equal(windows.autostart.kind, 'windows-task')
  assert.match(windows.autostart.reason, /计划任务/)

  const linux = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-advice-status-does-not-exist'),
    env: {},
    platform: 'linux',
    autostart: planAutostartAdvice({ host: { kind: HOST_KINDS.LINUX }, platform: 'linux', hasSystemd: true, user: 'fg' }),
  })
  assert.equal(linux.autostart.kind, 'linux-systemd')
  assert.match(linux.autostart.reason, /systemd 用户服务/)
  assert.ok(linux.autostart.commands.includes('loginctl enable-linger fg'))

  const wsl = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-advice-status-does-not-exist'),
    env: {},
    platform: 'linux',
    autostart: planAutostartAdvice({
      host: { kind: HOST_KINDS.WSL, distro: 'Ubuntu-22.04' },
      platform: 'linux',
      hasSystemd: false,
      user: 'fg',
    }),
  })
  assert.equal(wsl.autostart.kind, 'wsl-manual')
  assert.equal(wsl.autostart.options.length, 2)
  const text = JSON.stringify(wsl.autostart)
  assert.equal(/docker/i.test(text), false, 'WSL never gets a Docker answer')
  assert.equal(/compose/i.test(text), false, 'WSL never gets a Compose answer')
})

test('a container gets the orchestrator fragment, and no supervisor', () => {
  const advice = planAutostartAdvice({ container: true, platform: 'linux' })
  assert.equal(advice.kind, 'container')
  assert.equal(advice.canInstall, false)
  assert.match(advice.reason, /编排器/)
})

test('the host detection is the one of the shutdown (one answer, one place)', () => {
  const wsl = detectHostKind({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    readFile: () => '',
    exists: () => false,
  })
  assert.equal(wsl.kind, HOST_KINDS.WSL)
  assert.equal(wsl.suspect, false)
  assert.equal(wsl.evidence, 'WSL_DISTRO_NAME')

  const suspect = detectHostKind({
    platform: 'linux',
    env: {},
    readFile: () => 'Linux version 5.15 (gcc)',
    exists: (target) => target === '/mnt/c/Windows/System32/shutdown.exe',
  })
  assert.equal(suspect.kind, HOST_KINDS.WSL)
  assert.equal(suspect.suspect, true, 'only the mounted drive: a hint, not a proof')

  const linux = detectHostKind({
    platform: 'linux',
    env: {},
    readFile: () => 'Linux version 5.15 (gcc)',
    exists: () => false,
  })
  assert.equal(linux.kind, HOST_KINDS.LINUX)
})

test('the supervisor directory of a WSL host without systemd stays empty', (t) => {
  const { stateDir, startupDir } = fixture(t, 'wsl-empty')
  const exec = fakeExecutor()
  const result = installSupervisor({
    stateDir,
    startupDir,
    platform: 'linux',
    confirmed: true,
    nodePath: '/usr/bin/node',
    execPath: '/usr/bin/node',
    argv: ['/usr/bin/node', 'dsh', 'web'],
    execArgv: [],
    cwd: '/home/fg',
    env: {},
    homeDir: '/home/fg',
    user: 'fg',
    host: { kind: HOST_KINDS.WSL, distro: 'Ubuntu-22.04' },
    existsSyncFn: () => false,
    execFileSyncFn: exec,
    copySupervisor: () => '// fake',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'wsl-no-systemd')
  assert.equal(exec.calls.length, 0, 'no command was run')
  assert.equal(fs.existsSync(supervisorPaths(stateDir).script), false, 'nothing was written')
})
