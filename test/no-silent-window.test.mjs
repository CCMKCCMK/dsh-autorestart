/**
 * Tests for the shutdown window: the graceful shutdown has NO invisible
 * reserve any more.
 *
 * The user decided that the shutdown reserve was a duplicate: the graceful
 * shutdown already has a VISIBLE countdown (`sleepCountdownSeconds`), and
 * that countdown IS the wait before the machine goes off. A second, hidden
 * window next to it would only say the same thing twice — so it was removed.
 *
 * What is left:
 *
 *   - the RESTART reserve (`restartGraceMs`) — the restart has no countdown
 *     of its own, so it keeps the extra wait for the work this plugin
 *     cannot see;
 *   - the VISIBLE countdown of the shutdown — the wait before the machine
 *     goes off.
 *
 * These tests guard that the removed key is really gone (the whole
 * repository, the code included) and that the two windows do not influence
 * each other.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import { createEmptyState, requestRestart, writeState } from '../lib/checkpoint.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const CHOICE_PATH = '/__dsh_autorestart/choice'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/**
 * The key of the shutdown reserve that no longer exists.
 *
 * It is built from two parts on purpose: the whole plugin must not mention
 * the key any more — the tests included — so the needle itself may not
 * appear in any file of this repository.
 */
const REMOVED_SHUTDOWN_KEY = ['sleep', 'GraceMs'].join('')

/** The directory of the plugin (the parent of this test directory). */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-shutdown-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Every file of the plugin that may hold text.
 *
 * The `.git` directory and `node_modules` are skipped: they are not part of
 * the plugin.
 *
 * @returns {string[]} the paths, relative to the plugin directory
 */
function pluginFiles(dir = PLUGIN_DIR, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      pluginFiles(full, out)
      continue
    }
    out.push(path.relative(PLUGIN_DIR, full))
  }
  return out
}

/**
 * A fake Cordis context: the routes and the timers.
 */
function createContext({ services = {} } = {}) {
  const routes = []
  const timers = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
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
    get: (name) => (name === 'webServer' ? webServer : services[name]),
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

/** A request from the loopback. */
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

/** The route of a freshly applied plugin. */
function routeOf(routes, routePath) {
  const route = routes.find((entry) => entry.path === routePath)
  assert.ok(route, `the route ${routePath} must be registered`)
  return route
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** What the restart gate answers right now. */
function gateVerdictOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(fakeRequest('GET', undefined, `${HEALTH_PATH}?gate=1`), res)
  return JSON.parse(res.body)
}

/** What the shutdown route answers right now. */
function sleepStatusOf(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), res)
  return JSON.parse(res.body)
}

/** Ask the choice route to write one value. */
async function choose(routes, body) {
  const res = fakeResponse()
  routeOf(routes, CHOICE_PATH).handler(fakeRequest('POST', body, CHOICE_PATH), res)
  await settle()
  return { statusCode: res.statusCode, body: JSON.parse(res.body) }
}

/**
 * TEXT GUARD — NOT a behavioural test (2026-11-02).
 *
 * It greps every text file of the plugin for ONE removed key name. What it
 * catches: the old name coming back into the source (a copy-paste that would
 * make the page and the host disagree again).
 *
 * What it CANNOT catch (so nobody trusts it for more): the removed BEHAVIOUR
 * coming back under another name. A new `invisibleShutdownReserve` would pass
 * this test and change exactly the thing the user asked to remove.
 *
 * The behavioural guarantees are the tests below: the status payload carries no
 * reserve field, the choice route refuses the removed key, and the restart
 * reserve stays independent of the countdown.
 */
test('text guard: the removed shutdown reserve key appears nowhere in the plugin', () => {
  const hits = []
  for (const relative of pluginFiles()) {
    const full = path.join(PLUGIN_DIR, relative)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      // A file that is not text (an image) cannot hold the key.
      continue
    }
    if (text.includes(REMOVED_SHUTDOWN_KEY)) hits.push(relative)
  }
  assert.deepEqual(
    hits,
    [],
    `the removed key must not appear anywhere in the plugin: ${hits.join(', ')}`,
  )
})

test('the sleep status reports the countdown, not a silent window', () => {
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('status'),
    recoveryDelayMs: 0,
    enabled: true,
    restartGraceMs: 10000,
    sleepCountdownSeconds: 20,
  })

  const status = sleepStatusOf(routes)
  assert.equal(status.countdownSeconds, 20, 'the countdown is reported')
  assert.equal(status.restartGraceMs, 10000, 'the restart reserve is reported next to it')
  assert.equal(
    Object.prototype.hasOwnProperty.call(status, 'graceMs'),
    false,
    'the shutdown has no invisible window any more',
  )
})

/* ------------------------------------------------------------------ *
 * THE GATE, WRITTEN DOWN (2026-11-02).
 *
 * "I asked for a restart and nothing happened" used to be a fact nobody could
 * look up: the only trace was a log line, rate limited to one a minute. These
 * tests pin the two things the operator now gets instead — WHAT the gate decided
 * and WHO was resetting the quiet window. They assert the RECORD only; the
 * decision itself is unchanged (that is the point of the whole task).
 * ------------------------------------------------------------------ */

/** A context that REMEMBERS the event handlers the plugin registers. */
function createEventContext({ services = {}, agents = null } = {}) {
  const made = createContext({ services })
  const handlers = new Map()
  made.ctx.on = (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {}
  }
  if (agents !== null) made.ctx.agents = agents
  const fire = (name, payload) => {
    for (const fn of handlers.get(name) || []) fn(payload)
  }
  return { ...made, handlers, fire }
}

/**
 * The gate record the plugin wrote down (`restart-gate.json`, next to the state
 * file — its own file, because the state document is rebuilt from a whitelist on
 * every boot and would drop an extra key).
 */
function readGateRecord(stateFile) {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile), 'restart-gate.json'), 'utf8'))
}

/** Apply the plugin on a state file that already holds a pending restart. */
function applyPendingRestart(label) {
  const stateFile = tempStateFile(label)
  const state = createEmptyState()
  requestRestart(state, { reason: 'diagnostics', bySessionId: 'sess-root', now: Date.now() })
  writeState(stateFile, state)
  return { stateFile }
}

test('a SUBAGENT status report is recorded as the source that reset the window', () => {
  const { stateFile } = applyPendingRestart('reset-subagent')
  const subagent = { id: 'sess-sub' }
  const made = createEventContext({
    // The root list does NOT contain the subagent: exactly what a child session is.
    agents: { list: () => [], roots: () => [], get: () => undefined },
  })
  const runtime = apply(made.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })

  made.fire('agent/status', { agent: subagent, status: 'running' })
  runtime.tick()

  const recorded = readGateRecord(stateFile)
  assert.equal(recorded.quietResetBy, 'agent-status', 'the source of the reset is named')
  assert.equal(recorded.quietResetIsSubagent, true, 'and it says the session was a SUBAGENT')
  assert.equal(recorded.quietResetSessionId, 'sess-sub', 'with its id')
  assert.equal(typeof recorded.quietResetAt, 'number', 'and when it happened')
})

test('a ROOT session status report is not marked as a subagent', () => {
  const { stateFile } = applyPendingRestart('reset-root')
  const root = { id: 'sess-root' }
  const made = createEventContext({
    agents: { list: () => [root], roots: () => [root], get: () => root },
  })
  const runtime = apply(made.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })

  made.fire('agent/status', { agent: root, status: 'running' })
  runtime.tick()

  const recorded = readGateRecord(stateFile)
  assert.equal(recorded.quietResetBy, 'agent-status')
  assert.equal(recorded.quietResetIsSubagent, false, 'a root session is not a subagent')
  assert.equal(recorded.quietResetSessionId, 'sess-root')
})

test('a queued inbox message is recorded as its own source', () => {
  const { stateFile } = applyPendingRestart('reset-inbox')
  const made = createEventContext()
  const runtime = apply(made.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })

  made.fire('agent/inbox/inserted', { agent: { id: 'sess-x' } })
  runtime.tick()

  assert.equal(readGateRecord(stateFile).quietResetBy, 'inbox-inserted', 'the label says where it came from')
})

test('the gate record answers what it decided, and the health payload carries it', () => {
  const { stateFile } = applyPendingRestart('gate-record')
  const made = createEventContext()
  const runtime = apply(made.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })

  runtime.tick()

  const recorded = readGateRecord(stateFile)
  assert.equal(recorded.action, 'wait', 'nothing was allowed through in this test')
  assert.equal(recorded.reason, 'settling', 'the quiet window had not filled: that is the reason')
  assert.equal(recorded.settleMs, 60000, 'the window the gate really used')
  assert.equal(typeof recorded.quietForMs, 'number', 'how long the host had been quiet')
  assert.ok(Array.isArray(recorded.blockedBy), 'the blocker list is a list')
  assert.equal(typeof recorded.queueMs, 'number', 'how long the request has waited')
  assert.equal(recorded.attempts, 0, 'and how many execution attempts there were')

  // THE SAME RECORD IS REACHABLE FROM THE PAYLOAD the operator actually reads.
  const res = fakeResponse()
  routeOf(made.routes, HEALTH_PATH).handler(fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`), res)
  const payload = JSON.parse(res.body)
  assert.ok(payload.restartGate, 'the state payload carries the gate record')
  assert.equal(payload.restartGate.reason, 'settling')
  assert.equal(payload.restartGate.action, 'wait')
  assert.equal(payload.quietResetBy, 'none', 'and the flat reset fields sit next to it')
  assert.equal(payload.quietResetIsSubagent, false)
})

test('the gate record survives a host restart (it is read back from disk)', () => {
  const { stateFile } = applyPendingRestart('gate-persisted')
  const first = createEventContext()
  const firstRuntime = apply(first.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })
  firstRuntime.tick()
  const written = readGateRecord(stateFile)
  assert.equal(written.reason, 'settling', 'the first run wrote it')

  // A NEW boot of the plugin, on the same state directory: the record is still there.
  const second = createEventContext()
  apply(second.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })
  const res = fakeResponse()
  routeOf(second.routes, HEALTH_PATH).handler(fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`), res)
  const payload = JSON.parse(res.body)
  assert.ok(payload.restartGate, 'the next boot can still read the decision')
  assert.equal(payload.restartGate.reason, 'settling')
  assert.equal(payload.restartGate.at, written.at, 'and it is the same decision, not a new one')
})

test('the choice route refuses the removed key', async () => {
  const edits = []
  const { ctx, routes } = createContext({
    services: {
      configEditor: {
        entries: () => [{ options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: {} } }],
        edit: async (entry, change) => { edits.push(change({})) },
      },
    },
  })
  apply(ctx, { stateFile: tempStateFile('choice'), recoveryDelayMs: 0, enabled: true })

  // The removed key is not a choice any more: the route knows nothing about
  // it and writes nothing.
  const refused = await choose(routes, { [REMOVED_SHUTDOWN_KEY]: 30000 })
  assert.equal(refused.statusCode, 400, 'the removed key must not be accepted')
  assert.equal(refused.body.error, 'no-choice')
  assert.equal(edits.length, 0, 'a refused answer must not write anything')

  // The instruction of the route lists the keys that DO exist.
  const empty = await choose(routes, {})
  assert.equal(empty.statusCode, 400)
  assert.match(empty.body.instruction, /"restartGraceMs": 0 \| 5000 \| 10000 \| 20000 \| 30000 \| 60000/)
  assert.match(empty.body.instruction, /"sleepCountdownSeconds": 0 \| 10 \| 20 \| 30 \| 60/)
  assert.equal(
    empty.body.instruction.includes(REMOVED_SHUTDOWN_KEY),
    false,
    'the instruction must not mention the removed key',
  )
})

test('the restart reserve is independent of the shutdown countdown', () => {
  // The default: the gate waits for the settle window alone.
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('default'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    sleepCountdownSeconds: 20,
  })
  const plain = gateVerdictOf(routes)
  assert.equal(plain.effectiveSettleMs, 2000, 'the settle window alone is enough')
  assert.equal(plain.graceMs, 0, 'the restart reserve defaults to none')

  // A reserve of twenty seconds: the gate waits for it. The window the gate
  // really uses is `max(settleMs, restartGraceMs)` — the reserve REPLACES the
  // settle window when it is the longer one, it is not added to it.
  const second = createContext()
  apply(second.ctx, {
    stateFile: tempStateFile('reserve'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 20000,
    sleepCountdownSeconds: 20,
  })
  const reserved = gateVerdictOf(second.routes)
  assert.equal(reserved.graceMs, 20000, 'the restart reserve is reported')
  assert.equal(reserved.effectiveSettleMs, 20000, 'the gate waits for the longer window')

  // The countdown of the shutdown does not touch the restart window at all.
  const third = createContext()
  apply(third.ctx, {
    stateFile: tempStateFile('countdown'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    sleepCountdownSeconds: 60,
  })
  const counted = gateVerdictOf(third.routes)
  assert.equal(counted.effectiveSettleMs, 2000, 'the countdown does not change the restart window')
  assert.equal(counted.graceMs, 0, 'the countdown does not create a reserve')
})

// ------------------------------------------------------------------ *
// A FORCED RESTART IS AN ALLOW (user report, 2026-11-13).
//
// `restart-gate.json` is the one file an operator reads to find out why a restart
// did or did not happen. It mapped the decision with
// `decision.action === 'restart' ? 'allow' : 'wait'`, so a FORCED restart — which
// really does restart, over the running conversations — was written down as
// `wait`. The record then contradicted itself:
// `{action: "wait", reason: "force-restart-while-busy"}`. The user hit exactly
// that while debugging a restart that looked inexplicably stuck.
//
// `allow` must mean "the gate let the restart through", so it is true for both
// restart actions and false for every outcome that leaves the restart pending.
// ------------------------------------------------------------------ */

test('a forced restart is recorded as allow, not wait', () => {
  const { stateFile } = applyPendingRestart('gate-force')
  const root = { id: 'sess-root', status: 'running' }
  const made = createEventContext({
    agents: { list: () => [root], roots: () => [root], get: () => root },
  })
  const runtime = apply(made.ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 60000,
    forceRestartWhenBusy: true,
  })

  made.fire('agent/status', { agent: root, status: 'running' })
  // `tick()` is what evaluates the gate; `quietSince()` was just refreshed, so
  // without the force path this would settle into a wait.
  try {
    runtime.tick()
  } catch {
    // The force path may proceed to the restart command, which this fake host
    // does not provide. The RECORD is written before that, which is what is read.
  }

  const recorded = readGateRecord(stateFile)
  assert.equal(
    recorded.reason,
    'force-restart-while-busy',
    'the record names the force path as the reason',
  )
  assert.equal(
    recorded.action,
    'allow',
    'and it says the gate ALLOWED it — a forced restart is not a wait',
  )
})

test('an ordinary wait is still recorded as wait', () => {
  const { stateFile } = applyPendingRestart('gate-wait')
  const root = { id: 'sess-root', status: 'running' }
  const made = createEventContext({
    agents: { list: () => [root], roots: () => [root], get: () => root },
  })
  const runtime = apply(made.ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 60000 })

  made.fire('agent/status', { agent: root, status: 'running' })
  try {
    runtime.tick()
  } catch {
    // No restart command here either; only the record matters.
  }

  const recorded = readGateRecord(stateFile)
  assert.equal(recorded.action, 'wait', 'without the opt-in the gate really does wait')
})
