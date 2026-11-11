/**
 * THE POWER-OFF PATH WAITS FOR AN INSTALL TOO (user decision, 2026-11-11).
 *
 * User, verbatim: "重启之前要看有没有插件在安装，这个动作我想起来关机也要，所以
 * 你要把关机那边也覆盖上". The restart gate already consults the external
 * blockers (the plugin market, and the plugin files); the sleep gate is the one
 * choke point every power-off exit funnels into, so it consults the very same
 * function. These tests pin that contract without ever touching a machine: the
 * blocker reaches the gate through `runtime.externalBlockers`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, sleepGate } from '../index.js'

/** A runtime that would otherwise let the machine go. */
function baseRuntime(overrides = {}) {
  return {
    pendingRestart: () => false,
    busyAgents: () => [],
    ...overrides,
  }
}

const filesBlocker = {
  sessionId: null,
  kind: 'plugin-files',
  reason: 'plugin-files',
  label: '插件文件',
  name: '插件文件正在变动',
}

const marketBlocker = {
  sessionId: null,
  kind: 'market-install',
  reason: 'plugin-install',
  label: '插件市场',
  name: '插件市场正在安装插件',
}

test('a plugin install in progress holds the power-off path', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [filesBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'plugin-files')
  assert.equal(Array.isArray(gate.blockedBy), true)
  assert.equal(gate.blockedBy.length, 1)
  // The label the user sees is the one the blocker carried, not a generic one.
  assert.equal(gate.blockedBy[0].label, '插件文件')
  assert.equal(gate.blockedBy[0].kind, 'plugin-files')
})

test('the market keeps its own reason, so the two causes stay distinguishable', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [marketBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'plugin-install')
})

test('both at once: the first reason wins and BOTH are reported', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [marketBlocker, filesBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.blockedBy.length, 2)
  assert.deepEqual(gate.blockedBy.map((entry) => entry.kind), ['market-install', 'plugin-files'])
})

test('an external blocker is NOT turned into a cancel: the gate only says no', () => {
  // Whatever runs the countdown decides what to do with a refusal — the gate
  // must not clear the intent itself, so the shutdown resumes by itself once
  // the install settles. A `cancelled`/`abort` field here would be a bug.
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [filesBlocker] }))
  assert.equal('cancelled' in gate, false)
  assert.equal('abort' in gate, false)
  assert.equal(gate.allow, false)
})

test('a runtime without the hook (older harness, unit tests) still works', () => {
  // The hook is optional on purpose: sleepGate is also used by callers that
  // never wired the market probe, and a missing function must not throw.
  const gate = sleepGate(baseRuntime())
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate, null)
})

test('a throwing hook is treated as "no blockers", not as a reason to refuse', () => {
  // Fail-open on a broken probe: a bug in the market probe must never pin the
  // machine on forever.
  const gate = sleepGate(baseRuntime({
    externalBlockers: () => {
      throw new Error('probe exploded')
    },
  }))
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate.reason, 'plugin-files')
})

// ---------------------------------------------------------------------------
// A GOAL THAT IS STILL GOING IS WORK (user report, 2026-11-11):
// "有一个目标在跑，但是呢，他自己停了下来，然后直接就关机了".
// A goal drives itself one round at a time; between two rounds the session has
// no running turn, so a busy-only check called it idle and the machine went
// down mid-work. The power-off path cannot park a goal the way the restart
// does, so it has to WAIT.
// ---------------------------------------------------------------------------

test('an armed goal holds the power-off path even between two of its rounds', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => [{ sessionId: 'session-g', goal: { id: 'goal-1' } }],
  }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'goal-active')
  assert.equal(gate.blockedBy.length, 1)
  assert.equal(gate.blockedBy[0].kind, 'goal-active')
  assert.equal(gate.blockedBy[0].sessionId, 'session-g')
})

test('the goal reason never masquerades as an install reason', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => [{ sessionId: 'session-g', goal: { id: 'goal-1' } }],
  }))
  assert.notEqual(gate.reason, 'plugin-install')
  assert.notEqual(gate.reason, 'plugin-files')
})

test('a throwing goal probe fails open instead of pinning the machine', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => {
      throw new Error('goal service exploded')
    },
  }))
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate.reason, 'goal-active')
})

test('no goals means the goal branch is skipped entirely', () => {
  const gate = sleepGate(baseRuntime({ busyGoals: () => [] }))
  assert.notEqual(gate.reason, 'goal-active')
})

// ---------------------------------------------------------------------------
// THE REAL FIELDS OF A GOAL (bug, 2026-11-11):
// "有一个目标在跑，但是呢，他自己停了下来，然后直接就关机了".
//
// A goal object carries `phase` (what it is doing) and `activation` (whether it
// still has the authority to drive itself). The power-off path read the
// booleans `activated` / `active` instead — fields the Host never sets — so a
// goal somebody PAUSED and a goal a restart DISARMED both looked like work in
// progress.
//
// AND THE WHOLE BRANCH WAS DEAD CODE: `apply` named the local helper
// `goalBusySessions` directly, but that helper lives inside the runtime
// factory — every call threw `ReferenceError: goalBusySessions is not defined`,
// the gate swallowed it, and NO goal ever held the machine.
//
// THESE TESTS GO THROUGH THE REAL PLUGIN: the sleep route, the sleep service,
// the sleep controller and the very list of busy goals the production code
// builds. The units of the decision live in `test/lifecycle.test.mjs`.
// ---------------------------------------------------------------------------

const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-goal-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context with ONE live session that owns ONE goal.
 *
 * @param {object} goal the goal of that session
 */
function createContext(goal) {
  const routes = []
  const timers = []
  const handlers = new Map()
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const agents = [{ id: 'session-g', status: 'idle' }]
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((entry) => entry.id === id),
    },
    goals: {
      get: (agent) => (agent && agent.id === 'session-g' ? goal : undefined),
      resume: () => undefined,
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: (event, handler) => {
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, timers }
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
function fakeRequest(method, body, url) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: url || SLEEP_PATH,
    headers: { 'content-type': 'application/json' },
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

/** The route of a freshly applied plugin. */
function routeOf(routes, routePath) {
  const route = routes.find((entry) => entry.path === routePath)
  assert.ok(route, `the route ${routePath} must be registered`)
  return route
}

/** Fire every 1s timer of the plugin (the sleep controller ticks on them). */
function fireTicks(timers) {
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
}

/**
 * Arm the graceful shutdown, let the countdown run out and report what the
 * gate said.
 *
 * The countdown is zero seconds, so the very first tick asks the gate — the
 * same question the machine asks right before it goes off.
 *
 * @param {object} goal the goal of the live session
 * @returns {Promise<{ status: object, shutdowns: number }>}
 */
async function shutdownWithGoal(goal) {
  const shutdowns = []
  const { ctx, routes, timers } = createContext(goal)
  apply(
    ctx,
    {
      stateFile: tempStateFile('arm'),
      recoveryDelayMs: 0,
      enabled: true,
      settleMs: 0,
      sleepCountdownSeconds: 0,
    },
    // A spawner without events counts as "started" — and starts NOTHING.
    { sleepSpawn: () => { shutdowns.push(true); return { pid: 4242 } } },
  )
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  // One tick: the countdown is over, the gate is asked.
  fireTicks(timers)
  await settle()
  const after = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), after)
  return { status: JSON.parse(after.body), shutdowns: shutdowns.length }
}

test('a goal somebody PAUSED does not hold the power-off path', async () => {
  const { status, shutdowns } = await shutdownWithGoal({
    id: 'goal-1', revision: 1, phase: 'paused', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10,
  })
  assert.deepEqual(status.blockers, [], 'a paused goal is not work in progress: it must not hold the shutdown')
  assert.equal(shutdowns, 1, 'the machine is told to go off')
})

test('a goal that was DISARMED does not hold the power-off path', async () => {
  const { status, shutdowns } = await shutdownWithGoal({
    id: 'goal-1', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10,
  })
  assert.deepEqual(status.blockers, [], 'a disarmed goal has no continuation authority left')
  assert.equal(shutdowns, 1, 'the machine is told to go off')
})

test('a goal that is FINISHED does not hold the power-off path', async () => {
  const { status, shutdowns } = await shutdownWithGoal({
    id: 'goal-1', revision: 1, phase: 'complete', activation: 'armed', roundsStarted: 4, maxGoalRounds: 4,
  })
  assert.deepEqual(status.blockers, [], 'a finished goal is not work in progress')
  assert.equal(shutdowns, 1, 'the machine is told to go off')
})

test('an ARMED goal still holds the power-off path', async () => {
  const { status, shutdowns } = await shutdownWithGoal({
    id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10,
  })
  assert.equal(status.phase, 'waiting', 'the machine waits for the goal')
  assert.equal(status.blockers.length, 1, 'and it says who holds it')
  assert.equal(status.blockers[0].label, '目标', 'the blocker names the goal')
  assert.equal(status.blockers[0].sessionId, 'session-g')
  assert.equal(shutdowns, 0, 'and the machine does NOT go off')
})

