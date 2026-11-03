/**
 * Tests for the quiet window: "the host must stay quiet for N ms before a
 * restart may fire".
 *
 * THE DEFECT
 *
 * The window was reset by EVERY session event. The host emits session events
 * continuously while the interface polls and synchronises (measured on the
 * real machine: one every 2-3 seconds), so a window longer than that
 * interval could never fill: the restart never fired, however long the user
 * waited. The grace window of ten seconds (raised in 0.6.0) was enough to
 * make the restart impossible.
 *
 * THE FIX
 *
 * The window measures the time since the last REAL work:
 *   - `lastBusyAt`: the last moment a conversation was seen working (a
 *     running turn or a queued message) — the hard guarantee, never relaxed;
 *   - `lastActivityAt`: the last real activity signal (a turn that started or
 *     ended, a message that was queued, a session event that says work
 *     happened).
 *
 * A routine session event (a title, a projection, a context request) is not
 * activity any more.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { isWorkSessionEvent, sessionEventType } from '../lib/activity.js'

const HEALTH_PATH = '/__dsh_autorestart/health'

/* ------------------------------------------------------------------ *
 * The pure policy (lib/activity.js).
 * ------------------------------------------------------------------ */

test('a routine session event is not activity', () => {
  for (const type of [
    'session/title',
    'session/title-llm-request',
    'request/context',
    'request/header',
    'job/registered',
    'job/settled',
    'model/selection',
    'permission/preset',
    'sandbox/mode',
    'schedule/change',
    'working-directory/change',
    'workspace/changes',
    'subagent/catalog',
    'deliverables/presented',
    'feedback/record',
    'plan/mode',
    'image/offload',
    'session/end-seed',
    'agent-preset/selected',
  ]) {
    assert.equal(isWorkSessionEvent({ type }), false, `${type} must not count as work`)
    assert.equal(isWorkSessionEvent({ event: { type } }), false, `${type} must not count as work`)
  }
})

test('a session event that says work happened IS activity', () => {
  for (const type of [
    'user/message',
    'assistant/message',
    'assistant/attempt',
    'tool/call',
    'tool/result',
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'command/run',
    'agent/inbox/spliced',
    'team/message/queued',
    'tool-workflow/run-start',
    'compaction/start',
    'llm/retry',
  ]) {
    assert.equal(isWorkSessionEvent({ type }), true, `${type} must count as work`)
    assert.equal(isWorkSessionEvent({ event: { type } }), true, `${type} must count as work`)
  }
})

test('an event whose type cannot be read is not activity', () => {
  // The rule is one-sided: when in doubt the plugin would rather restart a
  // little early than never restart at all.
  assert.equal(isWorkSessionEvent(undefined), false)
  assert.equal(isWorkSessionEvent(null), false)
  assert.equal(isWorkSessionEvent({}), false)
  assert.equal(isWorkSessionEvent({ type: '' }), false)
  assert.equal(isWorkSessionEvent({ type: 42 }), false)
  assert.equal(isWorkSessionEvent({ event: {} }), false)
  assert.equal(sessionEventType({ event: { type: 'tool/call' } }), 'tool/call')
  assert.equal(sessionEventType({ nothing: true }), null)
})

/* ------------------------------------------------------------------ *
 * The Host half (index.js).
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-quiet-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Replace `Date.now` with a clock the test drives.
 *
 * @param {{ value: number }} clock
 * @param {object} t the test context
 */
function patchNow(clock, t) {
  const real = Date.now
  Date.now = () => clock.value
  t.after(() => { Date.now = real })
  return clock
}

/**
 * A fake Cordis context: the live agents, the timers, the tools, the routes
 * and the event handlers.
 */
function createContext({ agents = [] } = {}) {
  const routes = []
  const timers = []
  const tools = []
  const logs = []
  const handlers = new Map()
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: {
      info: (...parts) => logs.push({ level: 'info', text: parts.map(String).join(' ') }),
      warn: (...parts) => logs.push({ level: 'warn', text: parts.map(String).join(' ') }),
      error: (...parts) => logs.push({ level: 'error', text: parts.map(String).join(' ') }),
    },
    fiber: { state: 2 },
    agents: { list: () => agents, roots: () => agents, get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
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
  return {
    ctx,
    routes,
    timers,
    tools,
    logs,
    /** Fire every handler of one event. */
    fire: (event, payload) => {
      for (const handler of handlers.get(event) || []) handler(payload)
    },
  }
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

/** A GET request from the loopback. */
function fakeRequest(url) {
  return {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this },
  }
}

/** The route of a freshly applied plugin. */
function routeOf(routes, routePath) {
  const route = routes.find((entry) => entry.path === routePath)
  assert.ok(route, `the route ${routePath} must be registered`)
  return route
}

/** What the restart gate answers right now. */
function gateVerdictOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(fakeRequest(`${HEALTH_PATH}?gate=1`), res)
  return JSON.parse(res.body)
}

/** What the state route answers right now. */
function stateOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(fakeRequest(`${HEALTH_PATH}?state=1`), res)
  return JSON.parse(res.body)
}

/** A session that is working right now. */
function runningAgent(id) {
  return { id, status: 'running', session: { id }, inbox: { nextTurn: [], nextStep: [] } }
}

/** Ask for a restart, exactly like the `continuum_restart` tool does. */
function requestRestart(tools) {
  const tool = tools.find((entry) => entry.name === 'continuum_restart')
  assert.ok(tool, 'the continuum_restart tool must be registered')
  tool.execute({ reason: 'install the plugin update' }, { agent: { id: 'sess-x', status: 'running' } })
}

test('routine session events every two seconds do not keep the restart waiting', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('routine'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  // The interface polls and synchronises: a routine session event every two
  // seconds, forever. Before the fix each of them reset the quiet window, so
  // the window (ten seconds here) could never fill.
  const seen = []
  for (let round = 1; round <= 20; round += 1) {
    clock.value += 2000
    fire('session/event', { session: { id: 'sess-ui' }, event: { type: 'session/title' } })
    const verdict = gateVerdictOf(routes)
    seen.push({ round, allow: verdict.allowRestart, reason: verdict.gate.reason, quietForMs: verdict.quietForMs })
  }

  // The window fills: after ten seconds of quiet the restart may go.
  const allowed = seen.find((entry) => entry.allow === true)
  assert.ok(allowed, `the quiet window must fill: ${JSON.stringify(seen)}`)
  assert.ok(allowed.round >= 5, `the grace of ten seconds must still be honoured: ${JSON.stringify(seen)}`)
  assert.equal(allowed.reason, 'quiet')
})

test('the grace window of ten seconds still holds the restart back', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('grace-hold'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  // Eight seconds of quiet: not enough for a grace of ten seconds.
  clock.value += 8000
  fire('session/event', { event: { type: 'request/context' } })
  const early = gateVerdictOf(routes)
  assert.equal(early.allowRestart, false, 'the grace must hold the restart back')
  assert.equal(early.gate.reason, 'settling')
  assert.equal(early.gate.blockedBy.length, 0, 'nobody is busy — the window is the reason')
  assert.equal(early.effectiveSettleMs, 10000)

  // Two seconds later the grace is over.
  clock.value += 2000
  const late = gateVerdictOf(routes)
  assert.equal(late.allowRestart, true, 'the grace is over')
  assert.equal(late.gate.reason, 'quiet')
})

test('without a grace the window is the settle window alone', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('no-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 0,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  clock.value += 1000
  fire('session/event', { event: { type: 'session/title' } })
  const early = gateVerdictOf(routes)
  assert.equal(early.allowRestart, false, 'the settle window holds the restart back')
  assert.equal(early.effectiveSettleMs, 2000)

  clock.value += 1500
  const late = gateVerdictOf(routes)
  assert.equal(late.allowRestart, true, 'the settle window is over')
  assert.equal(late.gate.reason, 'quiet')
})

test('a session event that says work happened DOES reset the window', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('work'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 0,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  clock.value += 5000
  const before = gateVerdictOf(routes)
  assert.equal(before.allowRestart, true, 'the window is full')

  // A message was written: the window starts over.
  clock.value += 100
  fire('session/event', { event: { type: 'user/message' } })
  const after = gateVerdictOf(routes)
  assert.equal(after.allowRestart, false, 'real work starts the window over')
  assert.ok(after.quietForMs < 1000, `the window must start over: ${after.quietForMs}`)
})

test('a conversation that is really running blocks the restart for ever', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const agent = runningAgent('sess-busy')
  const { ctx, routes, tools, fire } = createContext({ agents: [agent] })
  apply(ctx, {
    stateFile: tempStateFile('running'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  // Every two seconds the agent reports that it is running.
  for (let round = 1; round <= 20; round += 1) {
    clock.value += 2000
    fire('agent/status', { agent, status: 'running' })
    fire('session/event', { event: { type: 'assistant/message' } })
    const verdict = gateVerdictOf(routes)
    assert.equal(verdict.allowRestart, false, `the running conversation must block (round ${round})`)
    assert.equal(verdict.gate.reason, 'conversation-active')
    assert.equal(verdict.gate.blockedBy.length, 1)
    assert.equal(verdict.gate.blockedBy[0].sessionId, 'sess-busy')
  }
})

test('the gate and the state route agree, and the reason explains an empty blocker list', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('consistent'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    queuedGraceMs: 60000,
  })
  requestRestart(tools)

  // A window that is not full yet: no blocker, but the restart is not allowed.
  clock.value += 1000
  fire('session/event', { event: { type: 'session/title' } })
  const gate = gateVerdictOf(routes)
  const state = stateOf(routes)
  assert.equal(gate.allowRestart, false)
  assert.equal(state.allowRestart, false)
  assert.equal(state.reason, gate.gate.reason, 'both routes report the same reason')
  assert.equal(state.reason, 'settling', 'an empty blocker list with the window not full says so')
  assert.deepEqual(state.blockedBy, [])

  // And when the window is full, both routes allow the restart.
  clock.value += 10000
  const gateLater = gateVerdictOf(routes)
  const stateLater = stateOf(routes)
  assert.equal(gateLater.allowRestart, true)
  assert.equal(stateLater.allowRestart, true)
  assert.equal(stateLater.reason, 'quiet')
})

test('the pending restart says in the log why the gate says no', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, timers, tools, logs, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('diagnostic'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    queuedGraceMs: 60000,
    deferPollMs: 250,
  })
  requestRestart(tools)

  clock.value += 3000
  fire('session/event', { event: { type: 'session/title' } })
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 250) timer.fn()
  }

  const diagnostic = logs.filter((entry) => entry.text.includes('restart gate:'))
  assert.ok(diagnostic.length >= 1, `the gate must say what it decided: ${JSON.stringify(logs.map((l) => l.text))}`)
  assert.match(diagnostic[0].text, /action=/)
  assert.match(diagnostic[0].text, /reason=/)
  assert.match(diagnostic[0].text, /busyCount=0/)
  assert.match(diagnostic[0].text, /effectiveSettleMs=10000/)
})
