/**
 * A GOAL A RESTART DISARMED MUST BE GIVEN BACK (bug, 2026-11-11).
 *
 * User, verbatim: "刚刚重启的时候，这个目标没有被触发继续". The boot pass only
 * looks at sessions that already carry `pendingResume`; disarming a goal for the
 * restart never set one, so the session sat idle with its goal disarmed and
 * `recover_now` answered `no-pending-recovery`.
 *
 * The disarmed/parked records are written BEFORE the restart and survive it, so
 * `recoverableSessions` now adopts the ones from THIS restart before it looks
 * for pending work. These tests pin that, without a host and without a restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { recoverableSessions } from '../lib/checkpoint.js'

/** The smallest state the selector reads. */
function stateWith(overrides = {}) {
  return {
    sessions: {},
    ...overrides,
  }
}

test('a goal disarmed by THIS restart becomes pending work again', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    // The session existed (it was idle when the host went down): a record
    // WITHOUT a session is an orphan and is dropped.
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: 1500 },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt: 1500, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, 'session-a')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('the parked-goals map is adopted too, with its own timestamp field', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-b': { sessionId: 'session-b', running: false, updatedAt: 1500 },
    },
    parkedGoals: {
      'session-b': { goalId: 'goal-2', parkedAt: 1200, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.deepEqual(pending.map((entry) => entry.sessionId), ['session-b'])
})

test('a record without a session is an orphan: it is dropped, not adopted', () => {
  // The session is gone, so the record can never be given back: adopting it
  // would only create a GHOST entry — a session that never existed, woken up
  // by a record of a goal nobody can resume.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-gone': { goalId: 'goal-9', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [], 'an orphan record must not create a ghost session')
  assert.equal(state.disarmedGoals['session-gone'], undefined, 'the orphan record is dropped with the session')
})

test('a goal disarmed BEFORE this restart is history, not pending work', () => {
  // Otherwise every boot would resurrect sessions from days ago.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-old': { goalId: 'goal-old', disarmedAt: 999, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('a goal that was already given back is not adopted twice', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-c': { goalId: 'goal-3', disarmedAt: 1500, resumedAt: 1800 },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('without a restart request the adoption is skipped (nothing to attribute)', () => {
  const state = stateWith({
    disarmedGoals: {
      'session-d': { goalId: 'goal-4', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('an already running session is left alone: it needs no recovery nudge', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-e': { sessionId: 'session-e', running: true, updatedAt: 1500 },
    },
    disarmedGoals: {
      'session-e': { goalId: 'goal-5', disarmedAt: 1500, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.equal(pending.length, 1)
  // Adopted or not, the session is recovered exactly once and keeps running.
  assert.equal(pending[0].sessionId, 'session-e')
  assert.equal(pending[0].running, true)
})

test('the prototype keys the session maps guard against are never adopted', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      __proto__: { goalId: 'goal-evil', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('a session that is over the model context window is never adopted', () => {
  // The over-limit marker is an OBJECT (`{ over: true, ... }`), not a boolean.
  // The old check (`entry.contextOverflow === true`) never matched it, so an
  // over-limit session was adopted and re-armed on every single boot.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-big': {
        sessionId: 'session-big',
        updatedAt: 1500,
        contextOverflow: { over: true, inputTokens: 200000, contextWindow: 128000 },
      },
    },
    disarmedGoals: {
      'session-big': { goalId: 'goal-1', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [], 'an over-limit session must never be resurrected')
})

// ---------------------------------------------------------------------------
// THE BOOT ITSELF MUST GIVE THE GOAL BACK (bug, 2026-11-11).
//
// The boot pass computed its plan FIRST and returned early when the plan said
// "nothing to recover". But the plan only looks at sessions that ALREADY carry
// `pendingResume`, and the adoption — the thing that writes that mark for a
// goal the restart disarmed and never gave back — ran later. So the boot ended
// before the adoption could ever happen, and a session whose only pending work
// was a disarmed goal sat idle until somebody typed `recover_now`.
//
// THIS TEST GOES THROUGH THE REAL PLUGIN: the boot recovery pass of a host
// that just restarted, with the checkpoint of the previous boot on disk.
// ---------------------------------------------------------------------------

/**
 * A temporary checkpoint file that holds the state of the previous boot.
 *
 * @param {string} label
 * @param {object} state the state of the previous boot
 * @returns {string} the path of the checkpoint file
 */
function tempStateFile(label, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-boot-${label}-`))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(state), 'utf8')
  return file
}

/**
 * A fake Cordis context that remembers the boot timer, so the test can fire it.
 *
 * With `agent` + `goal` it also models a LIVE session: the goal can be read,
 * the goal can be re-armed (`resumed`), and a continuation message would be
 * recorded in `injected` instead of being sent.
 */
function createContext({ agent = null, goal = null, resumed = [], injected = [], warnings = [] } = {}) {
  const routes = []
  const timers = []
  const handlers = new Map()
  const timeouts = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const live = agent === null ? undefined : agent
  if (live && typeof live.followup !== 'function') {
    live.followup = (message) => { injected.push(message) }
  }
  const agents = live === undefined ? [] : [live]
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((entry) => entry.id === id),
    },
    goals: {
      get: (target) => (target && goal ? goal : undefined),
      resume: (target, revision) => { resumed.push({ id: target && target.id, revision }) },
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
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, timers, timeouts, resumed, injected, warnings }
}

/** Let the boot recovery promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('the boot gives back a goal the restart disarmed, with nothing else pending', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('adopt', {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 3,
    phase: 'running',
    // The restart that took the goal away is still on the record.
    restart: { requestedAt: now - 5000, attempt: 0, notBefore: 0 },
    // NOTHING is running and NOTHING is queued: the only pending work in the
    // whole profile is the goal this restart disarmed. The session itself
    // exists (it was idle when the host went down) — a record WITHOUT a
    // session is an orphan and is dropped.
    sessions: {
      'session-x': { sessionId: 'session-x', running: false, updatedAt: now },
    },
    disarmedGoals: {
      'session-x': { goalId: 'goal-1', disarmedAt: now - 4000, resumedAt: null },
    },
  })

  const { ctx, timeouts } = createContext()
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  // The boot recovery pass is the first thing the plugin schedules on a new
  // boot: fire it.
  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await settle()

  const entry = runtime.state.sessions['session-x']
  assert.ok(entry, 'the session of the disarmed goal must be in the checkpoint after the boot')
  assert.equal(entry.pendingResume, true, 'the goal must be given back: the session is pending work again')
  assert.equal(entry.goal.goalId, 'goal-1', 'and it is the goal the restart disarmed')
})

// ---------------------------------------------------------------------------
// A GOAL THE USER STOPPED MUST NOT BE WOKEN UP (bug, 2026-11-11).
//
// `continuum_park_goal` leaves a disarm record; if the user PAUSES that goal
// afterwards, the record is stale: adopting it queues a continuation message
// and WAKES the session the user deliberately silenced. There are two guards,
// and BOTH of them are needed:
//
//   1. the ADOPTION does not queue a stopped goal at all, and
//   2. the CONTINUATION is not injected into a stopped goal either (the session
//      may have been queued before the goal was paused).
// ---------------------------------------------------------------------------

/** The checkpoint of a host that restarted with a disarmed goal behind. */
function bootStateWith(now, { sessions = idleSession(now) } = {}) {
  return {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 3,
    phase: 'running',
    // The restart that took the goal away is still on the record.
    restart: { requestedAt: now - 5000, attempt: 0, notBefore: 0 },
    sessions,
    disarmedGoals: {
      'session-x': { goalId: 'goal-1', disarmedAt: now - 4000, resumedAt: null },
    },
  }
}

/**
 * The session of the disarmed goal: it existed, it was idle when the host went
 * down, and it is neither running nor queued. A record WITHOUT a session is an
 * orphan and is dropped — so the fixture has to carry the session.
 */
function idleSession(now) {
  return { 'session-x': { sessionId: 'session-x', running: false, updatedAt: now } }
}

/** Fire the boot recovery pass and let it settle. */
async function runBoot(runtime, timeouts) {
  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await settle()
  return runtime
}

test('a goal the user PAUSED is neither adopted nor woken up', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('paused', bootStateWith(now))
  const resumed = []
  const injected = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-x', status: 'idle' },
    // The user stopped this goal after the plugin disarmed it.
    goal: { id: 'goal-1', revision: 1, phase: 'paused', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
    resumed,
    injected,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const entry = runtime.state.sessions['session-x']
  assert.equal(entry === undefined || entry.pendingResume !== true, true,
    'a paused goal must not become pending work again')
  assert.deepEqual(resumed, [], 'a paused goal must not be re-armed')
  assert.deepEqual(injected, [], 'a paused goal must not get a continuation message')
})

test('the CONTROL: the goal the plugin disarmed is given back', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('armed', bootStateWith(now))
  const resumed = []
  const injected = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-x', status: 'idle' },
    // The plugin's own disarm: the goal is still `active`, it only lost its
    // continuation authority. This is the goal the boot has to GIVE BACK.
    goal: { id: 'goal-1', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
    resumed,
    injected,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  assert.equal(resumed.length, 1, 'the goal of a disarmed session is given back')
  assert.deepEqual(injected, [], 'the re-armed goal continues on its own: no continuation message needed')
})

test('the CONTROL: a session whose goal is still armed is recovered as before', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('still-armed', bootStateWith(now))
  const resumed = []
  const injected = []
  const warnings = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-x', status: 'idle' },
    goal: { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
    resumed,
    injected,
    warnings,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const entry = runtime.state.sessions['session-x']
  assert.ok(entry, 'the session was adopted by the boot')
  assert.equal(injected.length >= 1, true,
    'the work continues: the session got its continuation message — ' + JSON.stringify({ entry, warnings }))
  assert.deepEqual(resumed, [], 'an armed goal needs no re-arming')
})

test('a session the user paused keeps quiet even when the restart interrupted it', async () => {  // The session was RUNNING when the host went down: the boot marks it as
  // pending work, and the recovery would inject a continuation. The goal is
  // paused now — the user stopped it — so the session must stay quiet.
  const now = Date.now()
  const stateFile = tempStateFile('paused-running', bootStateWith(now, {
    sessions: {
      'session-x': { sessionId: 'session-x', running: true, updatedAt: now - 6000 },
    },
  }))
  const resumed = []
  const injected = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-x', status: 'idle' },
    goal: { id: 'goal-1', revision: 1, phase: 'paused', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
    resumed,
    injected,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  assert.deepEqual(injected, [], 'no continuation message may wake a session the user paused')
  assert.deepEqual(resumed, [], 'and its goal must not be re-armed either')
})

test('a record without a session is an orphan: it is dropped, not adopted', async () => {
  // The session is gone, so the record can never be given back: adopting it
  // would only create a GHOST entry — a session that never existed, woken up
  // by a record of a goal nobody can resume. The record is dropped with the
  // session, so it does not come back on every boot.
  const now = Date.now()
  const stateFile = tempStateFile('orphan', bootStateWith(now, { sessions: {} }))
  const resumed = []
  const injected = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-x', status: 'idle' },
    goal: { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
    resumed,
    injected,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  assert.equal(runtime.state.sessions['session-x'], undefined, 'an orphan record must not create a ghost session')
  assert.equal(runtime.state.disarmedGoals['session-x'], undefined, 'the orphan record is dropped with the session')
  assert.deepEqual(resumed, [], 'and nothing is re-armed')
  assert.deepEqual(injected, [], 'and no continuation message is injected')
})
