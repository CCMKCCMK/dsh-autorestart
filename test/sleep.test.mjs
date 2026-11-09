/**
 * Tests for the graceful shutdown ("收工关机") — the host half.
 *
 * The feature waits until every conversation is idle, counts down and then
 * switches the REAL machine off. The dangerous part is the host detection: a
 * WSL host must shut WINDOWS down, not the WSL distribution (shutting the
 * distro down leaves Windows running, so nothing was really switched off).
 *
 * Every dependency is injected, so the whole platform matrix and the whole
 * state machine are covered without touching this machine: the platform, the
 * environment, the file probes, the clock, the spawner and the timer are all
 * parameters of the functions under test.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  COUNTDOWN_CHOICES,
  createSleepController,
  detectShutdownPlan,
  normalizeCountdownSeconds,
  planInvocation,
  runShutdown,
  snapCountdownChoice,
  WSL_SHUTDOWN_EXE,
} from '../lib/sleep.js'
import { apply } from '../index.js'

/** The route that serves the graceful sleep. */
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** A /proc/version that belongs to a WSL kernel. */
const WSL_PROC_VERSION = 'Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) #1 SMP'

/** A /proc/version of a real Linux kernel. */
const LINUX_PROC_VERSION = 'Linux version 6.1.0-18-amd64 (debian-kernel@lists.debian.org) #1 SMP'

/**
 * The file probes of a machine that is NOT WSL: no env marker, a real Linux
 * kernel and no mounted Windows binary.
 */
function plainLinux() {
  return {
    readFile: (file) => {
      assert.equal(file, '/proc/version')
      return LINUX_PROC_VERSION
    },
    exists: () => false,
  }
}

/* ------------------------------------------------------------------ *
 * The platform matrix.
 * ------------------------------------------------------------------ */

test('Windows shuts the machine down with the built-in shutdown binary', () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  assert.equal(plan.kind, 'windows')
  assert.equal(plan.command, 'shutdown.exe')
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0'])
  assert.equal(plan.label, '关掉这台 Windows 电脑')
})

test('a WSL host shuts WINDOWS down, never the distribution', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    ...plainLinux(),
  })
  assert.equal(plan.kind, 'wsl')
  assert.equal(plan.command, WSL_SHUTDOWN_EXE)
  assert.equal(plan.command, '/mnt/c/Windows/System32/shutdown.exe')
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0'])
  assert.equal(plan.source, 'WSL_DISTRO_NAME')
  assert.match(plan.label, /WSL/)
  assert.match(plan.label, /Windows/)
})

test('the WSL environment markers are proof, the mounted drive is only a hint', () => {
  const byInterop = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_INTEROP: '/run/WSL/8_interop' },
    ...plainLinux(),
  })
  assert.equal(byInterop.kind, 'wsl')
  assert.equal(byInterop.source, 'WSL_INTEROP')
  assert.equal(byInterop.command, WSL_SHUTDOWN_EXE)

  const byKernel = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: (file) => {
      assert.equal(file, '/proc/version')
      return WSL_PROC_VERSION
    },
    exists: () => false,
  })
  assert.equal(byKernel.kind, 'wsl')
  assert.equal(byKernel.source, '/proc/version')
  assert.equal(byKernel.command, WSL_SHUTDOWN_EXE)

  const byMount = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => LINUX_PROC_VERSION,
    exists: (file) => file === WSL_SHUTDOWN_EXE,
  })
  assert.equal(byMount.kind, 'wsl')
  assert.equal(byMount.command, WSL_SHUTDOWN_EXE)
  // The mounted drive alone is only a HINT: the plan says so out loud.
  assert.equal(byMount.suspect, true)
  assert.match(byMount.source, /疑似 WSL/)
  assert.match(byMount.label, /疑似 WSL/)
})

test('a real Linux host shuts itself down', () => {
  const plan = detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() })
  assert.equal(plan.kind, 'linux')
  assert.equal(plan.command, 'systemctl')
  assert.deepEqual(plan.args, ['poweroff'])
  assert.equal(plan.label, '关闭这台 Linux 主机')
  assert.deepEqual(plan.fallbacks, [{ command: 'shutdown', args: ['-h', 'now'] }])
})

test('a Mac shuts itself down through osascript', () => {
  const plan = detectShutdownPlan({ platform: 'darwin', env: {} })
  assert.equal(plan.kind, 'macos')
  assert.equal(plan.command, 'osascript')
  assert.deepEqual(plan.args, ['-e', 'tell application "System Events" to shut down'])
  assert.equal(plan.label, '关闭这台 Mac')
})

test('an unknown platform is unsupported and has no command at all', () => {
  const plan = detectShutdownPlan({ platform: 'freebsd', env: {} })
  assert.equal(plan.kind, 'unsupported')
  assert.equal(plan.command, null)
  assert.deepEqual(plan.args, [])
  assert.deepEqual(plan.fallbacks, [])
})

test('no plan ever shuts the SUBSYSTEM down instead of the machine', () => {
  const plans = [
    detectShutdownPlan({ platform: 'win32', env: {} }),
    detectShutdownPlan({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...plainLinux() }),
    detectShutdownPlan({ platform: 'linux', env: { WSL_INTEROP: 'x' }, ...plainLinux() }),
    detectShutdownPlan({
      platform: 'linux',
      env: {},
      readFile: () => WSL_PROC_VERSION,
      exists: () => false,
    }),
    detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() }),
    detectShutdownPlan({ platform: 'darwin', env: {} }),
    detectShutdownPlan({ platform: 'freebsd', env: {} }),
  ]
  for (const plan of plans) {
    const text = JSON.stringify(plan)
    assert.doesNotMatch(text, /wsl\.exe/i, `the plan must never call wsl.exe: ${text}`)
    assert.doesNotMatch(text, /--shutdown/, `the plan must never use --shutdown: ${text}`)
    if (plan.kind === 'wsl') {
      assert.doesNotMatch(text, /systemctl/, `a WSL plan must never use systemctl: ${text}`)
    }
  }
})

test('the WSL fallbacks still reach Windows', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  assert.equal(plan.fallbacks.length, 2)
  assert.deepEqual(plan.fallbacks[0], {
    command: 'powershell.exe',
    args: ['-NoProfile', '-Command', 'Stop-Computer -Force'],
  })
  assert.deepEqual(plan.fallbacks[1], {
    command: 'cmd.exe',
    args: ['/c', 'shutdown.exe', '/s', '/f', '/t', '0'],
  })
})

test('the label is a sentence a Chinese user can read', () => {
  const labels = [
    detectShutdownPlan({ platform: 'win32', env: {} }).label,
    detectShutdownPlan({ platform: 'linux', env: { WSL_DISTRO_NAME: 'U' }, ...plainLinux() }).label,
    detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() }).label,
    detectShutdownPlan({ platform: 'darwin', env: {} }).label,
  ]
  for (const label of labels) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length >= 4, `the label must be a sentence: ${label}`)
    assert.match(label, /[一-鿿]/, `the label must be Chinese: ${label}`)
  }
  assert.equal(labels[0], '关掉这台 Windows 电脑')
  assert.match(labels[1], /WSL 里的 DSH → 关掉整台 Windows/)
})

/* ------------------------------------------------------------------ *
 * The custom command.
 * ------------------------------------------------------------------ */

test('a configured command replaces the detected one and says so', () => {
  const windows = detectShutdownPlan({ platform: 'win32', env: {} })
  const overridden = planInvocation(windows, { sleepCommand: 'my-shutdown.exe --now', platform: 'win32' })
  assert.equal(overridden.command, 'cmd.exe')
  assert.deepEqual(overridden.args, ['/c', 'my-shutdown.exe --now'])
  assert.equal(overridden.source, 'sleepCommand')
  assert.equal(overridden.detectedSource, 'process.platform')
  assert.equal(overridden.overridden, true)
  assert.equal(overridden.kind, 'windows', 'the host kind does not change')

  const linux = detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() })
  const shell = planInvocation(linux, { sleepCommand: 'do-reboot', platform: 'linux' })
  assert.equal(shell.command, '/bin/sh')
  assert.deepEqual(shell.args, ['-c', 'do-reboot'])
  assert.equal(shell.source, 'sleepCommand')
})

test('an empty custom command leaves the detected plan alone', () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const same = planInvocation(plan, { sleepCommand: '   ', platform: 'win32' })
  assert.equal(same.command, 'shutdown.exe')
  assert.deepEqual(same.args, ['/s', '/f', '/t', '0'])
  assert.equal(same.source, 'process.platform')
})

/* ------------------------------------------------------------------ *
 * The execution.
 * ------------------------------------------------------------------ */

test('a dry run reports the command and spawns nothing', async () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    dryRun: true,
  })
  assert.equal(calls.length, 0, 'a dry run must not spawn anything')
  assert.equal(result.executed, false)
  assert.equal(result.command, 'shutdown.exe')
  assert.deepEqual(result.args, ['/s', '/f', '/t', '0'])
  assert.equal(result.error, null)
})

test('the shutdown is spawned detached and unreferenced', async () => {
  const calls = []
  let unrefed = 0
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { pid: 4321, unref: () => { unrefed += 1 } }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'shutdown.exe')
  assert.deepEqual(calls[0].args, ['/s', '/f', '/t', '0'])
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  assert.equal(unrefed, 1, 'the child must be unrefed')
  assert.equal(result.executed, true)
  assert.equal(result.pid, 4321)
})

test('the gate is checked again right before the machine is closed', async () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const blocked = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    gate: () => ({ allow: false, reason: 'conversation-active' }),
  })
  assert.equal(calls.length, 0, 'a denied gate must not spawn anything')
  assert.equal(blocked.executed, false)
  assert.equal(blocked.error, 'gate-blocked')

  const allowed = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 2, unref() {} } },
    gate: () => ({ allow: true }),
  })
  assert.equal(calls.length, 1)
  assert.equal(allowed.executed, true)
})

test('a plan without a command never runs anything', async () => {
  const calls = []
  const result = await runShutdown(detectShutdownPlan({ platform: 'freebsd', env: {} }), {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
  })
  assert.equal(calls.length, 0)
  assert.equal(result.executed, false)
  assert.equal(result.error, 'no-shutdown-command')
})

/* ------------------------------------------------------------------ *
 * The state machine.
 * ------------------------------------------------------------------ */

/** A controller with a fake clock, a fake timer and a fake shutdown. */
function createController({
  busy = [],
  allow = true,
  countdownSeconds = 20,
  titles = {},
} = {}) {
  let clock = 1000
  const timers = []
  const shutdowns = []
  const state = { busy: [...busy], allow }
  const controller = createSleepController({
    now: () => clock,
    busyAgents: () => state.busy,
    gate: () => ({ allow: state.allow, blockedBy: state.busy }),
    titleOf: (sessionId) => titles[sessionId],
    countdownSeconds,
    shutdown: () => {
      shutdowns.push({ at: clock })
      return { ok: true, at: new Date(clock).toISOString(), command: 'shutdown.exe', args: ['/s'], executed: true, pid: 7, error: null }
    },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (handle) => {
      if (handle) handle.disposed = true
    },
  })
  return {
    controller,
    timers,
    shutdowns,
    state,
    advance: (ms) => { clock += ms },
  }
}

/**
 * The blocker entry the controller reports for a busy session.
 *
 * A blocker always says WHAT it is (`kind`) and HOW it is called (`label`):
 * a raw session id never reaches the interface.
 *
 * @param {string} sessionId
 * @param {string|null} label the title of the session (null when unknown)
 */
function blocker(sessionId, label) {
  return {
    sessionId,
    kind: 'session',
    label,
    // No title, no name: the host never invents a generic one (a list of
    // "会话、会话、会话" says nothing and looks like a bug).
    name: label === null ? '' : label,
    parentTitle: null,
    title: label === null ? '' : label,
  }
}

test('arming with nothing to do starts the countdown', () => {
  const harness = createController()
  const status = harness.controller.arm()
  assert.equal(status.phase, 'countdown')
  assert.equal(status.armed, true)
  assert.equal(status.countdownSeconds, 20)
  assert.equal(status.remainingMs, 20000)
  assert.deepEqual(status.blockers, [])
  assert.equal(harness.timers.length, 1, 'exactly one timer may run')
  assert.equal(harness.timers[0].disposed, false)
})

test('a busy conversation keeps the machine alive and is listed', () => {
  const harness = createController({
    busy: [{ sessionId: 'sess-a', reason: 'running' }],
    titles: { 'sess-a': '写代码的会话' },
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting')
  assert.equal(status.armed, true)
  assert.deepEqual(status.blockers, [blocker('sess-a', '写代码的会话')])
  assert.equal(harness.shutdowns.length, 0)
  assert.match(status.message, /写代码的会话/)
})

test('a blocker without a title never shows its session id', () => {
  const harness = createController({ busy: [{ sessionId: 'sess-b', reason: 'running' }] })
  const status = harness.controller.arm()
  assert.deepEqual(status.blockers, [blocker('sess-b', null)])
  for (const entry of status.blockers) {
    // The id is still reported (the client needs it), but it is never the
    // NAME the user reads.
    assert.notEqual(entry.label, entry.sessionId)
    assert.notEqual(entry.name, entry.sessionId)
    assert.notEqual(entry.title, entry.sessionId)
  }
})

test('the countdown runs down and closes the machine', () => {
  const harness = createController()
  harness.controller.arm()
  for (let step = 0; step < 20; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  const status = harness.controller.status()
  assert.equal(status.phase, 'shutting-down')
  assert.equal(status.remainingMs, 0)
  assert.equal(harness.shutdowns.length, 1, 'the machine must be closed exactly once')
  assert.ok(status.lastRun, 'the last run must be reported')
  assert.deepEqual(Object.keys(status.lastRun).sort(), ['args', 'at', 'command', 'error', 'executed', 'pid'])
  assert.equal(status.lastRun.command, 'shutdown.exe')
  assert.equal(status.lastRun.executed, true)
  assert.equal(status.lastRun.pid, 7)
  assert.equal(status.lastRun.error, null)
  assert.ok(harness.timers[0].disposed, 'the timer must be released when the machine is closed')
})

test('a conversation that starts working during the countdown stops the shutdown', () => {
  const harness = createController()
  harness.controller.arm()
  harness.advance(1000)
  harness.controller.tick()
  assert.equal(harness.controller.status().phase, 'countdown')

  // Somebody starts working again.
  harness.state.busy = [{ sessionId: 'sess-c', reason: 'running' }]
  harness.advance(1000)
  const status = harness.controller.tick()
  assert.equal(status.phase, 'waiting', 'the countdown must go back to waiting')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed')
  assert.deepEqual(status.blockers, [blocker('sess-c', null)])
  assert.match(status.message, /开始干活了/, 'the message must say who started working')
  assert.match(status.message, /任务/, 'the message counts tasks, never raw session ids')
  assert.doesNotMatch(status.message, /（/, 'a blocker without a title must not produce a parenthetical')
})

test('the gate is asked once more before the machine is closed', () => {
  const harness = createController()
  harness.controller.arm()
  harness.state.allow = false
  // Twenty ticks: the countdown reaches zero and the gate is asked.
  for (let step = 0; step < 20; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  const status = harness.controller.status()
  assert.equal(status.phase, 'waiting', 'a denied gate must send the machine back to waiting')
  assert.equal(harness.shutdowns.length, 0, 'a denied gate must not close the machine')

  // The machine stays alive while the gate keeps denying.
  for (let step = 0; step < 20; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  assert.equal(harness.shutdowns.length, 0, 'the machine must never be closed while the gate denies')
})

test('cancelling stops everything and leaves no timer behind', () => {
  const harness = createController()
  harness.controller.arm()
  assert.equal(harness.timers.length, 1)
  const status = harness.controller.cancel()
  assert.equal(status.phase, 'cancelled')
  assert.equal(status.armed, false)
  assert.equal(status.remainingMs, 0)
  assert.ok(harness.timers[0].disposed, 'the timer must be disposed on cancel')
})

test('a broken tick never takes the host down', () => {
  const warnings = []
  const controller = createSleepController({
    busyAgents: () => { throw new Error('the agent list exploded') },
    log: { warn: (...parts) => warnings.push(parts.join(' ')) },
    setInterval: () => ({}),
    clearInterval: () => {},
  })
  const status = controller.arm()
  assert.equal(status.phase, 'countdown')
  assert.ok(warnings.length > 0, 'the failure must be logged')
})

test('the countdown length is clamped into the supported range', () => {
  assert.equal(normalizeCountdownSeconds(0), 0, 'zero means no countdown at all')
  assert.equal(normalizeCountdownSeconds(-5), 0)
  assert.equal(normalizeCountdownSeconds(999), 120)
  assert.equal(normalizeCountdownSeconds(10), 10)
  assert.equal(normalizeCountdownSeconds('nonsense'), 20)
})

test('an old countdown value is snapped onto one of the offered choices', () => {
  // A profile that still carries a value the dropdown does not offer must
  // not break: the nearest offered length wins, a tie goes to the longer one.
  assert.equal(snapCountdownChoice(15), 20)
  assert.equal(snapCountdownChoice(45), 60)
  assert.equal(snapCountdownChoice('20'), 20)
  assert.equal(snapCountdownChoice(null), 20)
  assert.equal(snapCountdownChoice(undefined), 20)
  assert.equal(snapCountdownChoice(0), 0)
  assert.equal(snapCountdownChoice(10), 10)
  assert.equal(snapCountdownChoice(30), 30)
  assert.equal(snapCountdownChoice(60), 60)
  for (const value of [0, 10, 20, 30, 60]) {
    assert.equal(COUNTDOWN_CHOICES.indexOf(snapCountdownChoice(value)) !== -1, true)
  }
})

test('the countdown length is a DROPDOWN in the settings page', () => {
  // The settings page renders a select when the schema key is a union of
  // constants (the host projects it as an enum), not when it is a number.
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declaration = /sleepCountdownSeconds:\s*([^\n]*)\n/.exec(source)
  assert.ok(declaration, 'the schema must declare sleepCountdownSeconds')
  assert.match(
    declaration[1],
    /schemastery\.union\(/,
    'the countdown length must be a union of constants (a dropdown), not a number field',
  )
  assert.match(declaration[1], /COUNTDOWN_CHOICES/, 'the union must be built from the offered choices')
  assert.ok(
    !/schemastery\.number\(\)/.test(declaration[1]),
    'the countdown length must not be a free number field any more',
  )
  assert.deepEqual([...COUNTDOWN_CHOICES], [0, 10, 20, 30, 60], 'the dropdown offers exactly five values')
})

test('a countdown of zero seconds switches the machine off right away', () => {
  const harness = createController({ countdownSeconds: 0 })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'shutting-down', 'there is no countdown: the gate is asked at once')
  assert.equal(status.remainingMs, 0)
  assert.equal(harness.shutdowns.length, 1, 'the machine is closed exactly once')
  assert.match(status.message, /0 秒：立即关机/, 'the message must say that there is no countdown')
})

test('a countdown of zero seconds still waits for the busy conversations', () => {
  const harness = createController({
    countdownSeconds: 0,
    busy: [{ sessionId: 'sess-a', reason: 'running' }],
    titles: { 'sess-a': '写代码的会话' },
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting', 'a busy conversation blocks the shutdown')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed while somebody is working')
  assert.deepEqual(status.blockers, [blocker('sess-a', '写代码的会话')])

  // Once the conversation is done, the next tick switches the machine off.
  harness.state.busy = []
  harness.advance(1000)
  const after = harness.controller.tick()
  assert.equal(after.phase, 'shutting-down')
  assert.equal(harness.shutdowns.length, 1)
})

test('the shortest and the longest countdown show every second', () => {
  for (const seconds of [3, 120]) {
    const harness = createController({ countdownSeconds: seconds })
    const first = harness.controller.arm()
    assert.equal(first.remainingMs, seconds * 1000, 'the countdown starts with the full time')
    const visible = [Math.ceil(first.remainingMs / 1000)]
    for (let step = 0; step < seconds + 2 && harness.shutdowns.length === 0; step += 1) {
      harness.advance(1000)
      visible.push(Math.ceil(harness.controller.tick().remainingMs / 1000))
    }
    // The user sees every second down to one, and the machine is closed right
    // after the last one: there is no "0 seconds and instantly off" moment.
    assert.deepEqual(
      visible.slice(0, seconds),
      Array.from({ length: seconds }, (unused, index) => seconds - index),
      `the countdown of ${seconds}s must show ${seconds}..1`,
    )
    assert.equal(harness.shutdowns.length, 1, 'the machine is closed exactly once')
    assert.equal(harness.controller.status().phase, 'shutting-down')
  }
})

test('arming twice does not start a second timer', () => {
  const harness = createController()
  harness.controller.arm()
  harness.controller.arm()
  harness.controller.arm()
  assert.equal(harness.timers.length, 1, 'there must be exactly one timer')
  assert.equal(harness.timers[0].disposed, false)
  assert.equal(harness.controller.status().phase, 'countdown')
})

test('a disposed controller never touches the host again', () => {
  const harness = createController()
  harness.controller.arm()
  harness.advance(1000)
  harness.controller.tick()
  harness.controller.dispose()
  assert.ok(harness.timers[0].disposed, 'the timer must be released')

  const status = harness.controller.tick()
  assert.equal(status.phase, 'countdown', 'a tick after the dispose must do nothing')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed after the dispose')
  harness.controller.arm()
  assert.equal(harness.timers.length, 1, 'a disposed controller must not start a new timer')
  harness.advance(5000)
  harness.controller.tick()
  assert.equal(harness.shutdowns.length, 0, 'the machine must stay alive')
})

test('a dry run reports the command it WOULD run', async () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  let spawned = 0
  const result = await runShutdown(plan, {
    spawn: () => { spawned += 1; return { pid: 1, unref() {} } },
    dryRun: true,
  })
  assert.equal(spawned, 0)
  assert.equal(result.executed, false, 'a dry run never executes anything')
  assert.equal(result.command, 'shutdown.exe', 'the command is still reported')
  assert.deepEqual(result.args, ['/s', '/f', '/t', '0'])
  assert.equal(result.error, null)
})

test('an unsupported host never arms and never runs a command', () => {
  const shutdowns = []
  const controller = createSleepController({
    supported: false,
    shutdown: () => { shutdowns.push(true) },
    setInterval: () => ({}),
    clearInterval: () => {},
  })
  assert.equal(controller.status().phase, 'unsupported')
  const status = controller.arm()
  assert.equal(status.phase, 'unsupported')
  assert.equal(status.armed, false)
  assert.equal(shutdowns.length, 0)
})

/* ------------------------------------------------------------------ *
 * The route.
 * ------------------------------------------------------------------ */

/** A fake Cordis context that records the routes and the timers. */
function createContext({ runningAgents = [] } = {}) {
  const routes = []
  const warnings = []
  const timers = []
  const taps = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: (fn) => {
      taps.push(fn)
      return () => {}
    },
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => runningAgents, roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, warnings, timers, taps }
}

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/** A minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body, headers = { 'content-type': 'application/json' }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: SLEEP_PATH,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** The sleep route of a freshly applied plugin. */
function sleepRoute(routes) {
  const route = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(route, `the sleep route ${SLEEP_PATH} must be registered`)
  return route
}

test('the sleep route answers with exactly the agreed shape', async () => {
  const { file } = tempStateFile('shape')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(Object.keys(payload).sort(), [
    'armed', 'armedAt', 'backupIncludePlugins', 'backupOnRestart', 'blockers', 'countdownSeconds', 'dryRun', 'host', 'lastLaunch', 'lastRun', 'message', 'ok', 'phase', 'quietForMs', 'remainingMs', 'restartGraceMs', 'restartWindow', 'showSleepButton',
  ])
  assert.equal(payload.restartWindow, 'foreground', 'the restart helper runs in the foreground unless asked otherwise')
  assert.equal(payload.lastLaunch, null, 'nothing was restarted on this machine yet')
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, 'restartLaunch'),
    false,
    'the removed window-style option must not appear in the state either',
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'idle')
  assert.equal(payload.armed, false)
  assert.equal(payload.showSleepButton, true)
  assert.equal(payload.countdownSeconds, 20)
  assert.equal(payload.armedAt, null, 'no shutdown was armed yet')
  assert.equal(payload.restartGraceMs, 0, 'the restart reserve is reported next to it')
  assert.equal(typeof payload.quietForMs, 'number')
  assert.equal(payload.backupOnRestart, true, 'the pre-restart backup is on by default')
  assert.equal(payload.backupIncludePlugins, true, 'the plugin tree is part of the backup by default')
  assert.equal(payload.remainingMs, 0)
  assert.deepEqual(payload.blockers, [])
  assert.deepEqual(Object.keys(payload.host).sort(), ['kind', 'label', 'platform', 'source', 'suspect'])
  assert.equal(payload.host.platform, process.platform)
  const expected = detectShutdownPlan({ platform: process.platform, env: process.env })
  assert.equal(payload.host.kind, expected.kind, 'the reported host must be the detected host')
  assert.equal(payload.host.label, expected.label)
  assert.equal(payload.host.source, expected.source)
  assert.equal(payload.host.suspect, expected.suspect === true, 'the suspect flag must be machine readable')
  assert.equal(payload.dryRun, false)
  assert.equal(typeof payload.message, 'string')
  assert.equal(payload.lastRun, null)
})

test('arming waits for the busy conversations and lists them', async () => {
  const { file } = tempStateFile('busy')
  const busy = { id: 'sess-busy', status: 'running' }
  const { ctx, routes, timers } = createContext({ runningAgents: [busy] })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.phase, 'waiting')
  assert.equal(payload.armed, true)
  assert.deepEqual(payload.blockers, [blocker('sess-busy', null)])
  assert.equal(timers.length, 1, 'the countdown timer belongs to the plugin')
})

test('cancelling stops the countdown and releases the timer', async () => {
  const { file } = tempStateFile('cancel')
  const { ctx, routes, timers } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), fakeResponse())
  await settle()
  assert.equal(timers.length, 1)

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), res)
  await settle()
  const payload = JSON.parse(res.body)
  assert.equal(payload.phase, 'cancelled')
  assert.equal(payload.armed, false)
  assert.ok(timers[0].disposed, 'the timer must be disposed when the sleep is cancelled')
})
/* ------------------------------------------------------------------ *
 * The route: one plain request arms the machine. No ticket, no header.
 * ------------------------------------------------------------------ */

test('a bare arm request arms the machine — no ticket, no header', async () => {
  const { file } = tempStateFile('bare-arm')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  // Nothing but the action: no headers, no ticket, no ceremony.
  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.armed, true, 'a plain request arms the machine')
  assert.ok(
    payload.phase === 'countdown' || payload.phase === 'waiting',
    `the machine must be armed, got: ${payload.phase}`,
  )
})

test('a bare cancel request takes the machine back', async () => {
  const { file } = tempStateFile('bare-cancel')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), fakeResponse())
  await settle()

  const cancel = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), cancel)
  await settle()
  assert.equal(cancel.statusCode, 200)
  assert.equal(JSON.parse(cancel.body).armed, false)
})

test('the plugin never injects a ticket into the page', async () => {
  const { file } = tempStateFile('no-ticket')
  const { ctx, taps } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const html = taps
    .map((fn) => fn('<html><head><title>DSH</title></head><body>app</body></html>'))
    .join('')
  assert.ok(!html.includes('dsh-autorestart-sleep-ticket'), 'there is no ticket any more')
  assert.ok(!html.includes('__DSH_SLEEP_TICKET__'), 'there is no ticket variable any more')
})

/* ------------------------------------------------------------------ *
 * The new cases: a command that does not start, the fallbacks, the
 * WSL hint, and the client half (the button, the overlay, the second
 * install question).
 * ------------------------------------------------------------------ */

test('a command that does not start is a failure, not a success', async () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
    spawn: () => ({
      on(event, handler) {
        if (event === 'error') setTimeout(() => handler(new Error('spawn shutdown.exe ENOENT')), 0)
      },
      unref() {},
    }),
  })
  assert.equal(result.executed, false, 'a command that did not start is never "executed"')
  assert.equal(result.ok, false)
  assert.match(result.error, /spawn-failed/)
  assert.match(result.error, /ENOENT/)
})

test('the fallbacks are tried one after another when the main command does not start', async () => {
  const attempts = []
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  const result = await runShutdown(plan, {
    spawn: (command) => {
      attempts.push(command)
      const fails = attempts.length === 1
      return {
        pid: 99,
        on(event, handler) {
          if (event === 'error' && fails) setTimeout(() => handler(new Error(`spawn ${command} ENOENT`)), 0)
          if (event === 'spawn' && !fails) setTimeout(() => handler(), 0)
        },
        unref() {},
      }
    },
  })
  assert.equal(attempts.length, 2, 'the main command and the first fallback are tried')
  assert.equal(attempts[0], WSL_SHUTDOWN_EXE)
  assert.equal(attempts[1], 'powershell.exe')
  assert.equal(result.executed, true, 'the fallback that started counts')
  assert.equal(result.command, 'powershell.exe', 'the command that really started is reported')
})

test('every command failing is reported with the last error', async () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  const result = await runShutdown(plan, {
    spawn: (command) => ({
      on(event, handler) {
        if (event === 'error') setTimeout(() => handler(new Error(`nope ${command}`)), 0)
      },
      unref() {},
    }),
  })
  assert.equal(result.executed, false)
  assert.equal(result.ok, false)
  assert.match(result.error, /nope cmd\.exe/, 'the LAST error is the one that is reported')
})

test('the mounted Windows drive alone is only a hint, not proof', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => LINUX_PROC_VERSION,
    exists: (file) => file === WSL_SHUTDOWN_EXE,
  })
  assert.equal(plan.kind, 'wsl')
  assert.equal(plan.suspect, true, 'the plan must say that it only guesses')
  assert.match(plan.source, /疑似 WSL/)
  assert.match(plan.label, /疑似 WSL/)
})

test('a machine that was not quiet long enough is not reported as busy', () => {
  let clock = 1000
  const controller = createSleepController({
    now: () => clock,
    busyAgents: () => [],
    gate: () => ({ allow: false, reason: 'settling', blockedBy: [] }),
    shutdown: () => { throw new Error('the machine must not be closed') },
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) {
    clock += 1000
    controller.tick()
  }
  const status = controller.status()
  assert.equal(status.phase, 'waiting')
  assert.match(status.message, /还没安静够久/)
  assert.doesNotMatch(status.message, /有人开始干活/, 'nobody started working: the copy must not say so')
})

test('a shutdown command that does not start leaves the machine idle, not "shutting down"', async () => {
  const controller = createSleepController({
    busyAgents: () => [],
    shutdown: () => Promise.resolve({ ok: false, executed: false, error: 'spawn-failed: ENOENT' }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'idle', 'the state must not keep saying "shutting down"')
  assert.equal(status.armed, false)
  assert.equal(status.lastRun.executed, false)
  assert.match(status.lastRun.error, /spawn-failed/)
  assert.match(status.message, /没跑起来/)
})

test('a dry run goes back to idle and says what it WOULD have run', async () => {
  const controller = createSleepController({
    busyAgents: () => [],
    gate: () => ({ allow: true, blockedBy: [] }),
    shutdown: () => Promise.resolve({
      ok: true,
      at: new Date().toISOString(),
      command: 'shutdown.exe',
      args: ['/s', '/f', '/t', '0'],
      executed: false,
      pid: null,
      error: null,
      dryRun: true,
    }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'idle', 'a dry run must not leave the state at "shutting down"')
  assert.equal(status.armed, false, 'a dry run leaves nothing armed')
  assert.equal(status.remainingMs, 0)
  assert.match(status.message, /试运行/, 'the message must say that this was only a rehearsal')
  assert.match(status.message, /shutdown\.exe/, 'the message must name the command it would have run')
  assert.match(status.message, /不会真的关机/, 'the message must say that nothing was powered off')
  assert.equal(status.lastRun.dryRun, true, 'the last run must be marked as a dry run')
  assert.equal(status.lastRun.executed, false, 'a dry run never executes anything')
  assert.equal(status.lastRun.command, 'shutdown.exe')
  assert.deepEqual(status.lastRun.args, ['/s', '/f', '/t', '0'])
})

test('the last gate keeps the busy conversations in the waiting card', async () => {
  // The gate allows the countdown to end and denies the very last check, which
  // is the race a conversation that starts working in that exact moment wins.
  let gateCalls = 0
  const controller = createSleepController({
    busyAgents: () => [],
    gate: () => {
      gateCalls += 1
      return gateCalls === 1
        ? { allow: true, blockedBy: [] }
        : { allow: false, reason: 'busy', blockedBy: [{ sessionId: 'sess-late' }] }
    },
    titleOf: () => '收尾的会话',
    shutdown: () => Promise.resolve({ ok: false, executed: false, error: 'gate-blocked' }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'waiting', 'the machine must not be closed')
  assert.deepEqual(
    status.blockers,
    [blocker('sess-late', '收尾的会话')],
    'the waiting card must still know WHO is busy',
  )
  assert.match(status.message, /收尾的会话/)
  assert.doesNotMatch(status.message, /0 个会话/, 'the copy must never talk about zero busy sessions')
})

/* ------------------------------------------------------------------ *
 * The client half.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** A tiny React stand-in: enough for the classic client script. */
function createReactHarness() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  const slotAt = (index) => {
    while (hooks.length <= index) {
      hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return hooks[index]
  }
  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      return { current: initial }
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }
  const render = (Component, props) => {
    cursor = 0
    pendingEffects = []
    const tree = Component(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const { slot, fn } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    }
    return tree
  }
  return { React, render }
}

/** Every node of a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/** Let the pending promises settle. */
const settleClient = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Load the classic client script in a sandbox and mount its surfaces.
 *
 * @param {{ status?: object, storage?: object, language?: string, refuseArm?: object, failChoice?: boolean, sessionStorage?: object, fakeTimers?: boolean, sections?: { id: string, order: number }[] }} options
 *   `sections` are the settings sections other plugins registered before this
 *   one (the section order is computed from them).
 */
function mountClient({
  status = null,
  storage = createStorage(),
  language = 'zh',
  refuseArm = null,
  failChoice = false,
  sessionStorage = createStorage(),
  fakeTimers = false,
  sections = [],
} = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const polls = []
  const state = { status }
  // How often the page reloaded itself (the button must never do that).
  const reloads = { count: 0 }
  // The timers the client scheduled (only with `fakeTimers`): a test fires
  // them by hand instead of waiting for the real clock.
  const timers = []
  let timerId = 0
  const fakeSetTimeout = (fn, ms) => {
    timerId += 1
    timers.push({ id: timerId, fn, ms })
    return timerId
  }
  const fakeClearTimeout = (id) => {
    const index = timers.findIndex((entry) => entry.id === id)
    if (index !== -1) timers.splice(index, 1)
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      localStorage: storage,
      sessionStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => { reloads.count += 1 } },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => { node.parentNode = sandbox.document.head; return node }, removeChild: () => {} },
      querySelector: () => null,
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const action = init && init.body ? JSON.parse(init.body).action : null
      const isSleep = String(url).includes('/sleep')
      const isChoice = String(url).includes('/choice')
      // The configuration page writes its settings: the Host takes them into
      // the profile configuration and the next poll reports them back.
      if (isChoice && init && init.body) {
        if (failChoice) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ ok: false, error: 'config-write-failed' }),
          })
        }
        const written = JSON.parse(init.body)
        const next = { ...(state.status || {}) }
        if (typeof written.sleepCountdownSeconds === 'number') {
          next.countdownSeconds = written.sleepCountdownSeconds
        }
        if (typeof written.backupOnRestart === 'boolean') {
          next.backupOnRestart = written.backupOnRestart
        }
        if (typeof written.backupIncludePlugins === 'boolean') {
          next.backupIncludePlugins = written.backupIncludePlugins
        }
        state.status = next
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, applied: 'config', ...written }),
        })
      }
      // The host refuses the request (a failure the user must see).
      if (isSleep && action && refuseArm && (!refuseArm.action || refuseArm.action === action)) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({ ok: false, error: 'refused', ...refuseArm }),
        })
      }
      const body = isSleep
        ? (action === 'cancel'
          ? { ...(state.status || {}), phase: 'cancelled', armed: false }
          : (state.status || {}))
        : { ok: true, pendingRestart: false, choiceUrl: '/__dsh_autorestart/choice' }
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    },
    console,
    setTimeout: fakeTimers ? fakeSetTimeout : setTimeout,
    clearTimeout: fakeTimers ? fakeClearTimeout : clearTimeout,
    // The shared poll: the callback is kept, so a test can deliver a new
    // status without waiting for the real 2s tick.
    setInterval: (fn) => { polls.push(fn); return polls.length },
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)
  const dictionaries = {}
  const slots = new Map()
  // The entries other plugins registered in a slot before this one: the
  // section order is computed from them (the messager algorithm).
  const presetEntries = sections.map((entry) => ({
    options: { name: 'settings.section', id: entry.id, order: entry.order },
  }))
  const registeredEntries = []
  module.apply({
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
      bind: (namespace) => (key) => {
        const table = (dictionaries[namespace] || {})[language] || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      // More than one component may live in the same slot (the install prompt
      // and the new-feature announcement both sit in the composer dock).
      inject: (name, thunk) => {
        const list = slots.get(name) || []
        list.push({ thunk, done: false, result: undefined })
        slots.set(name, list)
      },
      // The DSH slots service: `entries(key)` returns the entries of that
      // slot, `register(options, component)` records one and returns its
      // disposer.
      entries: (key) => [
        ...presetEntries.filter((entry) => entry.options.name === key),
        ...registeredEntries.filter((entry) => entry.options.name === key),
      ],
      register: (registration, Component) => {
        const entry = { options: registration, Component }
        registeredEntries.push(entry)
        const dispose = () => {
          const index = registeredEntries.indexOf(entry)
          if (index !== -1) registeredEntries.splice(index, 1)
        }
        // The real `register()` returns its disposer; the tests need the
        // entry too, so the disposer carries it.
        dispose.entry = entry
        return dispose
      },
    },
  })
  const componentOf = (name, id) => {
    const list = slots.get(name)
    assert.ok(list && list.length > 0, `the slot ${name} must be registered`)
    for (const slot of list) {
      if (!slot.done) {
        const produced = slot.thunk()
        // The thunk may be a GENERATOR (the messager pattern): the DSH slots
        // service runs it through `ctx.effect`, which iterates the yielded
        // disposers. The first yield is the registration itself.
        slot.result = (produced && typeof produced.next === 'function')
          ? produced.next().value
          : produced
        slot.done = true
      }
      const entry = slot.result && slot.result.entry
      if (!entry) continue
      // Without an id the FIRST registration of the slot wins (that is the
      // order the plugin injects them in).
      if (id === undefined || entry.options.id === id) return entry
    }
    assert.fail(`the slot ${name} must yield its registration${id ? ` (${id})` : ''}`)
  }
  return {
    fetches,
    dictionaries,
    slots,
    reloads,
    timers,
    sessionStorage,
    // Fire every timer the client scheduled with this delay.
    fireTimers: (ms) => {
      const due = timers.filter((entry) => entry.ms === ms)
      timers.length = 0
      for (const entry of due) entry.fn()
      return due.length
    },
    setStatus: (next) => { state.status = next },
    // Deliver the new status the way the shared poll would.
    poll: async () => {
      for (const fn of polls) fn()
      await settleClient()
    },
    render: (name, props) => harness.render(componentOf(name).Component, props || {}),
    // The registration options of a slot (the entry the Host would read).
    slot: (name) => componentOf(name).options,
    // The registration options of the settings section.
    section: () => componentOf('settings.section').options,
    // Render, let the shared poll deliver the status, render again.
    settled: async (name, props) => {
      harness.render(componentOf(name).Component, props || {})
      await settleClient()
      return harness.render(componentOf(name).Component, props || {})
    },
  }
}

test('the countdown overlay comes back after a cancellation', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const first = await mounted.settled('shell.overlay')
  assert.ok(first, 'the countdown must be on screen')
  const cancel = walk(first).find(
    (node) => node.type === 'button' && textOf(node).includes('算了，别关'),
  )
  assert.ok(cancel, 'the countdown offers a cancel button')

  cancel.props.onClick()
  await settleClient()
  const posts = mounted.fetches.filter((call) => String(call.url).includes('/sleep') && call.init)
  assert.ok(posts.length >= 1, 'the cancel must reach the Host')
  assert.deepEqual(JSON.parse(posts[posts.length - 1].init.body), { action: 'cancel' })
  assert.equal(mounted.render('shell.overlay'), null, 'the overlay folds away once the Host confirms')

  // The NEXT countdown must show the overlay again: a cancellation may never
  // leave the layer folded away for good.
  mounted.setStatus({ ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] })
  await mounted.poll()
  const again = await mounted.settled('shell.overlay')
  assert.ok(again, 'the overlay must come back for the next countdown')
  assert.ok(textOf(again).includes('8'), 'the big number must be on screen again')
})

test('the second install question is reachable on its own', async () => {
  // The backup question was answered (on an earlier install), the shutdown
  // button question was not: the second question must still be asked.
  const storage = createStorage({ 'dsh-autorestart:backup-choice-v1': 'plugins' })
  const mounted = mountClient({ storage })
  const tree = await mounted.settled('conversation.input.dock')
  assert.ok(tree, 'the panel must be rendered')
  assert.equal(tree.props['data-dsh-autorestart-choice-step'], 'sleep', 'the second question must be the one on screen')
  assert.ok(walk(tree).some((node) => node.props && node.props['data-sleep-choice']), 'the sleep options must be there')
})

test('the button waits for the first poll before it appears', async () => {
  // The Host has not answered yet: the button must not flash.
  const mounted = mountClient({ status: { ok: true, phase: 'idle' } })
  assert.equal(mounted.render('sidebar.footer.action'), null, 'an unknown answer renders nothing')
  // The first poll has to arrive before the Host changes its mind.
  await settleClient()

  mounted.setStatus({ ok: true, phase: 'idle', showSleepButton: true })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button appears once the Host answered')
  assert.equal(button.type, 'button')

  mounted.setStatus({ ok: true, phase: 'idle', showSleepButton: false })
  await mounted.poll()
  assert.equal(
    await mounted.settled('sidebar.footer.action'),
    null,
    'a hidden button leaves no placeholder',
  )
})

test('the button lives at the foot of the sidebar, not in the conversation header', async () => {
  const mounted = mountClient({ status: { ok: true, phase: 'idle', showSleepButton: true } })
  await mounted.poll()

  // The new seat: the list slot at the foot of the left sidebar.
  assert.ok(
    mounted.slots.has('sidebar.footer.action'),
    'the button must be registered in sidebar.footer.action',
  )
  const registration = mounted.slot('sidebar.footer.action')
  assert.equal(registration.name, 'sidebar.footer.action')
  assert.equal(registration.id, 'autorestart-sleep-button', 'the list slot needs its own id')
  assert.equal(typeof registration.order, 'number', 'the list slot needs an order')

  // The old seat is gone for good: nothing may register there any more.
  assert.equal(
    mounted.slots.has('conversation.header.leading'),
    false,
    'the button must not be registered in the conversation header any more',
  )
})

test('the collapsed sidebar shows the icon only, the wide one the label', async () => {
  const mounted = mountClient({ status: { ok: true, phase: 'idle', showSleepButton: true } })
  await mounted.poll()

  const wide = await mounted.settled('sidebar.footer.action', { wide: true })
  assert.ok(wide, 'the wide column shows the button')
  assert.ok(textOf(wide).includes('收工关机'), 'the wide column shows the label')
  assert.ok(!wide.props.className.includes('--rail'), 'the wide column is not the rail')
  assert.ok(wide.props.title, 'the button always has a title')
  assert.ok(wide.props['aria-label'], 'the button always has an aria-label')

  const rail = await mounted.settled('sidebar.footer.action', { wide: false })
  assert.ok(rail, 'the narrow rail shows the button too')
  assert.ok(!textOf(rail).includes('收工关机'), 'the narrow rail shows the icon only')
  assert.ok(rail.props.className.includes('--rail'), 'the narrow rail uses the rail style')
  assert.ok(rail.props.title, 'the rail button still has a title')
  assert.ok(rail.props['aria-label'], 'the rail button still has an aria-label')
})

test('the moon button is a toggle: an armed shutdown is cancelled by the same click', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', armed: true, showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  assert.equal(button.props['data-armed'], 'true')
  button.props.onClick()
  await settleClient()
  const posts = mounted.fetches.filter((call) => String(call.url).includes('/sleep') && call.init)
  assert.ok(posts.length >= 1)
  assert.deepEqual(JSON.parse(posts[posts.length - 1].init.body), { action: 'cancel' }, 'an armed shutdown is cancelled')
})

test('the countdown is a floating card: it never covers the interface', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const card = await mounted.settled('shell.overlay')
  assert.ok(card, 'the countdown card must be on screen')

  // No full-screen mask: the card is a corner card, not a cover.
  assert.ok(
    !card.props.className.includes('mask'),
    'the countdown must not be a full-screen mask',
  )
  assert.equal(
    card.props.style && card.props.style.pointerEvents,
    'none',
    'the card lets every click through',
  )
  // Only the cancel button takes clicks.
  const cancel = walk(card).find((node) => node.type === 'button')
  assert.ok(cancel, 'the card still offers a way out')
  assert.equal(cancel.props.style && cancel.props.style.pointerEvents, 'auto')

  // The big number is still big: at least 72px.
  const number = walk(card).find((node) => String(node.props && node.props.className || '').includes('__number'))
  assert.ok(number, 'the big number must be on screen')
})

test('switching the conversation does not interrupt the countdown', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 20000, blockers: [] },
  })
  const first = await mounted.settled('shell.overlay')
  assert.ok(first, 'the countdown must be on screen')
  assert.ok(textOf(first).includes('20'), 'the countdown starts at 20 seconds')

  // A session switch re-renders the surfaces: the countdown keeps running.
  const again = mounted.render('shell.overlay')
  assert.ok(again, 'the countdown survives a re-render')
  assert.ok(textOf(again).includes('20'), 'the countdown is not reset by a re-render')
  assert.equal(
    again.props['data-dsh-autorestart-sleep-countdown'],
    'true',
    'the countdown card is still the countdown card',
  )
})

test('a countdown of zero seconds shows no card at all', async () => {
  // 0 means "no countdown": the machine goes off as soon as the gate opens,
  // so there is no number, no whale and no card.
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'countdown',
      showSleepButton: true,
      countdownSeconds: 0,
      remainingMs: 0,
      blockers: [],
    },
  })
  const card = await mounted.settled('shell.overlay')
  assert.equal(card, null, 'a countdown of zero seconds must not render a card')
})

test('the button title says how long the countdown lasts', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, countdownSeconds: 60, blockers: [] },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  assert.match(String(button.props.title), /60/, 'the title must carry the countdown length')
})

test('one click arms the machine: one request, no header, no reload', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')

  button.props.onClick()
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'one click must send exactly one arm request')
  // The desktop client and the hosted web client send exactly the same thing:
  // the action, and nothing else.
  assert.deepEqual(
    Object.keys(arms[0].init.headers).filter((key) => key.startsWith('x-dsh-')),
    [],
    'the request must not carry any custom header',
  )
  assert.deepEqual(JSON.parse(arms[0].init.body), { action: 'arm' })
  assert.equal(mounted.reloads.count, 0, 'the button must never reload the page')
})

test('a refused request is shown, never silent', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    refuseArm: { reason: 'not-armed', message: '关机命令没能启动。' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  const after = mounted.render('sidebar.footer.action')
  const shown = textOf(after)
  assert.ok(
    shown.includes('没能启动') || String(after.props.title || '').includes('没能启动'),
    `the refusal must be visible, got: ${shown} / ${after.props.title}`,
  )
  assert.equal(mounted.reloads.count, 0, 'a failure never reloads the page')
})

test('the plugin registers a section of its own in the settings page', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], countdownSeconds: 20 },
  })
  const slot = mounted.slots.get('settings.section')
  assert.ok(slot, 'the settings.section slot must be registered')
  const registration = mounted.section()
  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, 'dsh-autorestart')
  assert.equal(registration.locale, 'dshAutorestart')
  assert.equal(typeof registration.order, 'number')
  assert.equal(typeof registration.label, 'function')
  assert.equal(registration.label(), '自动重启与关机', 'the section carries the Chinese label')
  assert.equal(typeof registration.inject, 'function', 'the section injects its own props')
  assert.equal(typeof registration.inject().t, 'function', 'the translator is injected')
})

test('the section carries the English label in an English UI', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], countdownSeconds: 20 },
    language: 'en',
  })
  assert.equal(mounted.section().label(), 'Auto-restart & shut down')
})

test('the old plugin-details panel is gone — there is only ONE entrance', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], countdownSeconds: 20 },
  })
  assert.equal(
    mounted.slots.has('plugins.row.config'),
    false,
    'the row-config panel must not be registered any more',
  )
  assert.ok(mounted.slots.has('settings.section'), 'the settings section must be there instead')
})

test('the section sits right below the Agent presets', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    sections: [{ id: 'agent-presets', order: 10 }],
  })
  assert.equal(mounted.section().order, 11, 'the section follows the Agent presets')
})

test('without the Agent presets the section follows the sections that are there', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    sections: [{ id: 'other', order: 5 }],
  })
  assert.equal(mounted.section().order, 6, 'the section follows the last one')
})

test('an empty settings page puts the section at the end', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
  })
  assert.equal(mounted.section().order, 1000, 'the fallback order is the big number')
})

test('the section shows two titled groups, the restart one first', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 30,
      restartGraceMs: 0,
      backupOnRestart: true,
      backupIncludePlugins: false,
    },
  })
  const panel = await mounted.settled('settings.section')
  assert.ok(panel, 'the settings section must be rendered')

  // The groups, in this order: the restart settings come first, the shutdown
  // settings after them, then the supervisor (the self-starting record), then
  // the rescue kit (the scripts for a host that does not come up) and finally
  // the "report a problem" group.
  const groups = walk(panel).filter(
    (node) => node.type === 'div' && typeof node.props['data-dsh-autorestart-group'] === 'string',
  )
  assert.deepEqual(
    groups.map((node) => node.props['data-dsh-autorestart-group']),
    ['restart', 'shutdown', 'supervisor', 'report'],
    'the restart group must come before the shutdown group',
  )
  const titles = groups.map((group) => textOf(group.children[0]))
  assert.equal(titles[0], '重启相关设置', 'the restart group must have a visible title')
  assert.equal(titles[1], '关机相关设置', 'the shutdown group must have a visible title')
  assert.equal(titles[2], '开机自启', 'the supervisor group must have a visible title')
  assert.equal(titles[3], '遇到问题', 'the report group must have a visible title')

  // The restart group carries four controls plus the restart-window setting that
  // used to be a group of its own.
  const restartControls = walk(groups[0]).filter(
    (node) => node.type === 'select' || node.type === 'input',
  )
  assert.equal(restartControls.length, 5, 'the restart group has exactly five controls')
  const restartKeys = restartControls.map((node) => node.props['data-dsh-autorestart-setting'])
  assert.deepEqual(
    restartKeys,
    ['restartGraceMs', 'backupOnRestart', 'backupIncludePlugins', 'maxBackups', 'restartWindow'],
    'the restart group ends with the helper window setting, and nothing else',
  )

  // The shutdown group carries exactly one: the countdown.
  const shutdownControls = walk(groups[1]).filter(
    (node) => node.type === 'select' || node.type === 'input',
  )
  assert.equal(shutdownControls.length, 1, 'the shutdown group has exactly one control')
  assert.equal(
    shutdownControls[0].props['data-dsh-autorestart-setting'],
    'sleepCountdownSeconds',
    'the shutdown group carries the countdown',
  )

  // The dropdowns show the values the Host reports. Four of them now: the two
  // waits, the backup copy limit and the restart window.
  const selects = walk(panel).filter((node) => node.type === 'select')
  assert.equal(selects.length, 4, 'the section has exactly four dropdowns')
  const byKey = new Map(selects.map((node) => [node.props['data-dsh-autorestart-setting'], node]))
  assert.equal(byKey.get('restartGraceMs').props.value, '0', 'the restart wait the Host reports is shown')
  assert.equal(byKey.get('sleepCountdownSeconds').props.value, '30', 'the countdown the Host reports is shown')
  assert.equal(
    byKey.get('restartWindow').props.value,
    'foreground',
    'the restart window defaults to the foreground behaviour',
  )
  assert.equal(byKey.has('restartLaunch'), false, 'the removed window-style option has no dropdown')
  const secondsOptions = walk(byKey.get('sleepCountdownSeconds'))
    .filter((node) => node.type === 'option')
    .map((node) => node.props.value)
  assert.deepEqual(secondsOptions, ['0', '10', '20', '30', '60'])
  const graceOptions = walk(byKey.get('restartGraceMs'))
    .filter((node) => node.type === 'option')
    .map((node) => node.props.value)
  assert.deepEqual(graceOptions, ['0', '5', '10', '20', '30', '60'])

  // The two backup switches show the values the Host reports.
  const switches = walk(panel).filter((node) => node.type === 'input')
  assert.equal(switches.length, 2, 'the section has exactly two switches')
  const switchByKey = new Map(switches.map((node) => [node.props['data-dsh-autorestart-setting'], node]))
  assert.equal(switchByKey.get('backupOnRestart').props.checked, true)
  assert.equal(switchByKey.get('backupIncludePlugins').props.checked, false)

  // The labels and the explanation are on the page.
  const shown = textOf(panel)
  assert.ok(shown.includes('关机倒数秒数'), `the countdown label must be there: ${shown}`)
  assert.ok(shown.includes('重启前等待'), `the restart wait label must be there: ${shown}`)
  assert.ok(shown.includes('重启前备份'), `the label must be there: ${shown}`)
  assert.ok(shown.includes('备份包含已安装插件'), `the label must be there: ${shown}`)
  assert.ok(shown.includes('不含 profile 里的插件目录'), `the scope must be explained: ${shown}`)
})

test('the countdown length is written into the profile configuration and read back', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], countdownSeconds: 20 },
  })
  const panel = await mounted.settled('settings.section')
  const countdown = walk(panel).find(
    (node) => node.type === 'select'
      && node.props['data-dsh-autorestart-setting'] === 'sleepCountdownSeconds',
  )
  assert.ok(countdown, 'the countdown dropdown must be there')
  countdown.props.onChange({ target: { value: '60' } })
  await settleClient()

  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].init.body), { sleepCountdownSeconds: 60 })
  const after = mounted.render('settings.section')
  const again = walk(after).find(
    (node) => node.type === 'select'
      && node.props['data-dsh-autorestart-setting'] === 'sleepCountdownSeconds',
  )
  assert.equal(again.props.value, '60')
})

test('the pre-restart backup switch is written into the profile configuration and read back', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 20,
      backupOnRestart: true,
      backupIncludePlugins: true,
    },
  })
  const panel = await mounted.settled('settings.section')
  const switches = walk(panel).filter((node) => node.type === 'input')
  const backup = switches.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupOnRestart')
  backup.props.onChange({ target: { checked: false } })
  await settleClient()

  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1, 'the change must be written once')
  assert.deepEqual(JSON.parse(posts[0].init.body), { backupOnRestart: false })

  // The new value is read back from the Host.
  const after = mounted.render('settings.section')
  const again = walk(after).filter((node) => node.type === 'input')
  const againBackup = again.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupOnRestart')
  assert.equal(againBackup.props.checked, false, 'the page must show the value the Host took')
})

test('the backup scope switch is written into the profile configuration and read back', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 20,
      backupOnRestart: true,
      backupIncludePlugins: true,
    },
  })
  const panel = await mounted.settled('settings.section')
  const switches = walk(panel).filter((node) => node.type === 'input')
  const plugins = switches.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupIncludePlugins')
  plugins.props.onChange({ target: { checked: false } })
  await settleClient()

  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1, 'the change must be written once')
  assert.deepEqual(JSON.parse(posts[0].init.body), { backupIncludePlugins: false })

  const after = mounted.render('settings.section')
  const again = walk(after).filter((node) => node.type === 'input')
  const againPlugins = again.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupIncludePlugins')
  assert.equal(againPlugins.props.checked, false, 'the page must show the value the Host took')
})

test('without a pre-restart backup the plugin scope is greyed out', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 20,
      backupOnRestart: false,
      backupIncludePlugins: true,
    },
  })
  const panel = await mounted.settled('settings.section')
  const switches = walk(panel).filter((node) => node.type === 'input')
  const backup = switches.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupOnRestart')
  const plugins = switches.find((node) => node.props['data-dsh-autorestart-setting'] === 'backupIncludePlugins')
  assert.equal(backup.props.disabled, false, 'the backup switch itself stays usable')
  assert.equal(plugins.props.disabled, true, 'the plugin scope is greyed out without a backup')
})

test('a failed save shows the error in the section', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], countdownSeconds: 20 },
    failChoice: true,
  })
  const panel = await mounted.settled('settings.section')
  const selects = walk(panel).filter((node) => node.type === 'select')
  selects[0].props.onChange({ target: { value: '60' } })
  await settleClient()

  const after = mounted.render('settings.section')
  const shown = textOf(after)
  assert.ok(shown.includes('没能保存设置'), `the failure must be visible: ${shown}`)
  assert.ok(shown.includes('config-write-failed'), `the reason must be visible: ${shown}`)
})

/* ------------------------------------------------------------------ *
 * The rehearsal (dry run): the user must see what WOULD have run.
 * ------------------------------------------------------------------ */

/** A status that reports a finished rehearsal. */
function rehearsalStatus(extra = {}) {
  return {
    ok: true,
    phase: 'idle',
    showSleepButton: true,
    blockers: [],
    lastRun: {
      at: '2026-01-01T00:00:00.000Z',
      command: 'shutdown.exe',
      args: ['/s', '/f', '/t', '0'],
      executed: false,
      dryRun: true,
      error: null,
      ...extra,
    },
  }
}

test('a finished rehearsal says what it WOULD have run', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  const notice = mounted.render('shell.overlay')
  assert.ok(notice, 'the rehearsal must leave a note')
  const shown = textOf(notice)
  assert.ok(shown.includes('试运行'), `the note must say what it is, got: ${shown}`)
  assert.ok(shown.includes('shutdown.exe'), 'the command must be shown')
  assert.ok(shown.includes('/s'), 'the arguments must be shown')
  assert.equal(notice.props.style.pointerEvents, 'none', 'the note must never eat a click')
})

test('the note of a rehearsal can be closed', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  const notice = mounted.render('shell.overlay')
  const close = walk(notice).find((node) => node.type === 'button' && textOf(node).includes('知道了'))
  assert.ok(close, 'the note must offer a close button')
  close.props.onClick()
  await settleClient()
  assert.equal(mounted.render('shell.overlay'), null, 'the note must be gone')
})

test('the note of a rehearsal goes away after eight seconds', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  assert.ok(mounted.render('shell.overlay'), 'the note must be on screen')
  assert.equal(mounted.fireTimers(8000), 1, 'the note must disappear after eight seconds')
  assert.equal(mounted.render('shell.overlay'), null, 'the note must be gone')
})

test('a real failure is never reported as a rehearsal', async () => {
  const mounted = mountClient({
    status: rehearsalStatus({ dryRun: undefined, executed: false, error: 'spawn-failed' }),
    fakeTimers: true,
  })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  assert.equal(mounted.render('shell.overlay'), null, 'a failure must not leave a note')
})
