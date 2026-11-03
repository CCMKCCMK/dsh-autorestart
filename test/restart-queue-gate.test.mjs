/**
 * THE QUEUED RESTART MUST FINALLY HAPPEN (user report, 2026-11-02).
 *
 * The user asked for a restart, every conversation went idle, and nothing happened
 * for twelve minutes. The gate record showed `restartGate.at` frozen at the moment
 * the in-memory intent went away, and `quietResetBy: "agent-status"` on every
 * heartbeat. Two silent defects:
 *
 *   1. `tick()` began with `if (!state.restart) { stopPolling(); return }`. The
 *      queued request lives in its OWN record file, so once the intent was gone the
 *      poller killed itself and the gate was never evaluated again;
 *   2. `noteActivity('agent-status')` moved `lastActivityAt`, and the quiet window is
 *      `max(lastActivityAt, lastBusyAt)` - a 2-3 s heartbeat therefore re-armed a
 *      10 s window that could never fill.
 *
 * WHAT THESE TESTS ASSERT: the GATE's own decision (allow / wait, and what it says
 * is blocking), never whether an interval happens to be alive. Stopping the poller
 * once the gate has allowed the restart is the CORRECT next step, so timer liveness
 * is not a fact worth pinning - the decision is.
 *
 * The setup goes through the production entry: a restart is queued by the real
 * `continuum_restart` tool (which arms the poller itself), and the clock, the
 * interval and the timeout are the host's.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'

/** A temporary state directory for one plugin instance. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-queue-${label}-`))
  return path.join(dir, 'state.json')
}

/** Replace `Date.now` with a clock the test drives (no real waiting). */
function patchNow(clock, t) {
  const real = Date.now
  Date.now = () => clock.value
  t.after(() => { Date.now = real })
  return clock
}

/**
 * A fake Cordis context that KEEPS what the plugin registers: the tool
 * registrations (so a restart can be queued the production way) and every timer
 * (so a tick can be driven without waiting).
 */
function createContext({ agents = [], log = [] } = {}) {
  const routes = []
  const timers = []
  const tools = new Map()
  const handlers = new Map()
  const webServer = {
    register: (route) => { routes.push(route); return () => {} },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const record = (level) => (message, detail) => { log.push({ level, message, detail }) }
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    fiber: { state: 2 },
    agents: { list: () => agents, roots: () => agents, get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: {
      register: (tool) => { if (tool && tool.name) tools.set(tool.name, tool); return () => {} },
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
    log,
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

/** A loopback GET. */
function fakeRequest(url) {
  return { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, on() { return this } }
}

/** The health route's answer for `?gate=1` - the gate's decision, verbatim. */
function gateOf(routes) {
  const route = routes.find((entry) => entry.path === HEALTH_PATH)
  assert.ok(route, 'the health route must be registered')
  const res = fakeResponse()
  route.handler(fakeRequest(`${HEALTH_PATH}?gate=1`), res)
  return JSON.parse(res.body)
}

/** The poll timers the host still holds for this plugin. */
function liveTimers(timers) {
  return timers.filter((timer) => timer.disposed === false)
}

/**
 * Run one poll tick the way the host's interval would.
 *
 * Returns false when no timer is armed, and that is NOT a failure: once the gate
 * allows the restart, stopping the poller is the correct next step.
 */
function tick(timers) {
  const live = liveTimers(timers)
  if (live.length === 0) return false
  live[live.length - 1].fn()
  return true
}

/** Queue a restart through the REAL tool - which also arms the poller. */
async function queueRestart(tools) {
  const tool = tools.get('continuum_restart')
  assert.ok(tool, 'the continuum_restart tool must be registered')
  await tool.execute({ reason: 'test' }, { agent: null })
}

/* ------------------------------------------------------------------ *
 * ① THE INTENT GOES AWAY, THE REQUEST DOES NOT - AND THE POLLER SURVIVES.
 * ------------------------------------------------------------------ */

test('① a queued restart keeps its poller after the intent is gone, and is finally allowed', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, timers, tools, log } = createContext()
  const runtime = apply(ctx, {
    stateFile: tempStateFile('poller'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
  })

  // THE PRODUCTION ENTRY: the tool records the request and arms the poller.
  await queueRestart(tools)
  assert.ok(liveTimers(timers).length > 0, 'queuing a restart arms the poll timer')

  // THE DECOUPLING THE USER HIT: the request record still says `pending`, the
  // in-memory intent is gone. That pair of facts used to make the poller kill
  // itself on the very next tick.
  assert.ok(runtime.state.restart !== null && runtime.state.restart !== undefined, 'the intent exists right after queuing')
  runtime.state.restart = null

  // THE PAGE MUST NOT GO SILENT WHEN THE INTENT IS LOST (user report: the bubble
  // vanished and the user believed nothing was queued). This is the function the
  // interface reads, so assert it directly.
  const queuedView = runtime.restartRequestInfo()
  assert.equal(queuedView.pending, true, 'the queued request is still pending after the intent is gone')

  // ONE tick: with the fix it adopts the queued request and keeps polling.
  assert.equal(tick(timers), true, 'there is a queued request, so a tick must have run')
  assert.ok(liveTimers(timers).length > 0, 'the poller must NOT stop while a request is queued')
  assert.ok(
    runtime.state.restart !== null && runtime.state.restart !== undefined,
    'the queued request is adopted back into the intent so the gate has something to decide about',
  )

  // Now let the settle window fill with NO session events at all.
  clock.value += 61000
  tick(timers)

  const gate = gateOf(routes)
  assert.equal(
    gate.allowRestart,
    true,
    'with nobody working the gate must allow the restart: ' + JSON.stringify(gate.gate),
  )
  assert.equal(gate.gate.reason, 'quiet', 'and say why: the settle window filled')

  // The adoption is a repair, so it is on record.
  assert.ok(
    log.some((entry) => entry.level === 'warn' && /adopt/i.test(String(entry.message))),
    'adopting a queued request is logged, not silent',
  )
})

/* ------------------------------------------------------------------ *
 * ② HEARTBEATS DO NOT HOLD THE WINDOW OPEN.
 * ------------------------------------------------------------------ */

test('② agent-status heartbeats do not keep the quiet window from filling', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, timers, tools, fire } = createContext()
  apply(ctx, { stateFile: tempStateFile('heartbeat'), recoveryDelayMs: 0, enabled: true, settleMs: 10000 })

  await queueRestart(tools)

  // Thirty seconds of the interface's own synchronisation: one heartbeat every two
  // seconds. None of it is work, so the window must fill anyway.
  for (let second = 0; second < 30; second += 2) {
    clock.value += 2000
    fire('agent/status', { agent: { id: 'sess-a' }, status: 'idle' })
    tick(timers)
  }

  const gate = gateOf(routes)
  assert.equal(gate.allowRestart, true, 'heartbeats must not prevent the restart for ever')
  assert.ok(
    gate.gate.quietForMs >= 10000,
    'the quiet window really did fill despite the heartbeats: ' + gate.gate.quietForMs,
  )
  // THE DECISION ITSELF, not an interval: once the gate allows the restart the
  // poller is stopped on purpose, so liveness proves nothing here.
  assert.equal(gate.gate.reason, 'quiet', 'and the gate names the filled window as its reason')
})

/* ------------------------------------------------------------------ *
 * ③ REAL WORK STILL HOLDS IT BACK - NEVER A MISFIRED RESTART.
 * ------------------------------------------------------------------ */

test('③ a conversation that is really running keeps the gate at wait', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const running = { id: 'sess-busy', status: 'running' }
  const { ctx, routes, timers, tools } = createContext({ agents: [running] })
  apply(ctx, {
    stateFile: tempStateFile('busy'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  await queueRestart(tools)
  clock.value += 120000 // two minutes of a real turn, far past any window
  tick(timers)

  const gate = gateOf(routes)
  assert.equal(
    gate.allowRestart,
    false,
    'a running conversation must never be restarted out from under itself',
  )
  // THE GATE NAMES WHAT BLOCKS IT: that is the fact the interface shows the user.
  assert.ok(Array.isArray(gate.gate.blockedBy), 'the gate reports what is blocking it')
  assert.match(JSON.stringify(gate.gate.blockedBy), /sess-busy/, 'and names the running conversation')
  assert.notEqual(gate.gate.action, 'restart', 'it must not reach the restart action')
})
