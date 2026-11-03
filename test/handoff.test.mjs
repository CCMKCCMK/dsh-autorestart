/**
 * SESSION HANDOFF (an over-limit session is replaced by a fresh one) and the
 * CONTEXT-OVERFLOW GUARD (an over-limit session is never auto-resumed).
 *
 * The handoff is driven through `apply()` with a fake Cordis context that mirrors
 * the surface the plugin touches (agents, goals, sessions, tools, webServer), so
 * the assertions cover the composed text, the checkpoint record, the goal disarm
 * and the boot recovery that has to skip the old session afterwards.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  createEmptyState,
  recoverableSessions,
  setDisarmedGoal,
  setGoal,
  markPendingResume,
  writeState,
} from '../lib/checkpoint.js'
import { HANDOFF_DEFAULT_MAX_CHARS, composeHandoff, contextOverflow } from '../lib/lifecycle.js'

/** Create a temporary state-file path per test. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-handoff-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/** Seed a checkpoint that looks like it came from a previous host process. */
function seedPreviousBoot(file, build) {
  const state = createEmptyState(Date.now() - 60_000)
  state.bootPid = 999_999
  state.bootId = 'previous-boot'
  state.phase = 'idle'
  build(state)
  writeState(file, state)
}

/** A fake live Agent good enough for goal lookups, ids and followup capture. */
function fakeAgent(id) {
  const followups = []
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followups,
    followup(message) {
      followups.push(message)
    },
  }
}

/** A fake readable session surface (`deriveMessages` / `requestHeader` / …). */
function fakeSession({ messages = [], contextWindow = null, cwd = null } = {}) {
  const workingDir = cwd === null ? path.join(os.tmpdir(), 'dsh-handoff-ws') : cwd
  return {
    deriveMessages: () => messages,
    requestHeader: () => ({ cwd: workingDir }),
    requestContext: () => (contextWindow === null ? {} : { contextWindow }),
    snapshotEvents: () => [],
  }
}

/** A fake goals service: one live goal per session, with disarm/resume transitions. */
function fakeGoals(goalsBySession, calls = { resume: [], disarm: [] }) {
  const view = (agent) => goalsBySession[String(agent && agent.id)]
  return {
    get: (agent) => view(agent),
    resume: (agent, ref) => {
      calls.resume.push({ sessionId: String(agent && agent.id), ref })
      const goal = view(agent)
      if (!goal) throw new Error('no goal for this session')
      goal.phase = 'active'
      goal.activation = 'armed'
      goal.revision += 1
      return goal
    },
    disarm: (agent) => {
      calls.disarm.push({ sessionId: String(agent && agent.id) })
      const goal = view(agent)
      if (!goal) throw new Error('no goal for this session')
      goal.activation = 'disarmed'
      return goal
    },
  }
}

/**
 * Build a fake Cordis context. `services` are resolved through `ctx.get(name)`;
 * `withRoutes` adds a web server that records every registered route.
 */
function makeFake({ agents = [], services = {}, withRoutes = false } = {}) {
  const tools = []
  const routes = []
  const timeouts = []
  const created = []
  const listeners = new Map()
  const allServices = { ...services }
  if (withRoutes) {
    allServices.webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
  }
  const ctx = {
    logger: Object.assign(() => undefined, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((agent) => String(agent.id) === String(id)),
      create: async (options) => {
        created.push(options)
        const agent = fakeAgent(options.sessionId)
        agents.push(agent)
        return { agent }
      },
    },
    goals: services.goals || { get: () => undefined, resume: () => undefined, disarm: () => undefined },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    get: (name) => allServices[name],
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    provide: () => {},
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, routes, timeouts, created }
}

/** Run one boot recovery by invoking the scheduled timeout callback. */
async function runBootRecovery(fake) {
  const pending = fake.timeouts.shift()
  assert.ok(pending, 'apply() must schedule a boot-recovery timer')
  pending.fn()
  await new Promise((resolve) => setTimeout(resolve, 25))
}

/** A POST request stand-in (the route reads its body through `on`). */
function fakeRequest(body, { method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const payload = JSON.stringify(body ?? {})
  const handlers = {}
  return {
    method,
    url: '/__dsh_autorestart/handoff',
    socket: { remoteAddress },
    on(event, handler) {
      handlers[event] = handler
      if (event === 'data') {
        setTimeout(() => {
          handler(payload)
          if (handlers.end) handlers.end()
        }, 0)
      }
      return this
    },
  }
}

/** A response stand-in that records status, headers and body. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

/** Settle the route's promise chain. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

/** The text of the single continuation message an agent received. */
function messageText(agent) {
  return agent.followups.map((message) => message.content.map((block) => block.text ?? '').join('\n')).join('\n')
}

// ---------------------------------------------------------------------------
// 1. the composed text: goal, then reasons (newest first), then a bounded tail
// ---------------------------------------------------------------------------

test('the handoff composes goal + reasons + a bounded tail within the character budget', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system preamble' }] },
    { role: 'user', content: [{ type: 'text', text: 'A'.repeat(400) }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'pwsh' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'LATEST-ANSWER' }] },
  ]
  const composed = composeHandoff({
    sessionId: 'sess-old',
    objective: 'ship the overflow guard',
    reasons: ['first reason', 'second reason'],
    messages,
    maxChars: 200,
  })

  // The two prepended lines.
  assert.match(composed.text, /trimmed continuation of an earlier session/)
  assert.match(composed.text, /exceeded the model context window/)
  assert.match(composed.text, /Old session id: sess-old/)

  // (i) goal objective, (ii) recorded reasons newest first, (iii) the tail.
  const goalAt = composed.text.indexOf('Goal objective: ship the overflow guard')
  const reasonsAt = composed.text.indexOf('Recorded checkpoint context')
  const tailAt = composed.text.indexOf('Trimmed tail')
  assert.ok(goalAt > 0, 'the goal objective is carried')
  assert.ok(goalAt < reasonsAt, 'the goal comes before the recorded reasons')
  assert.ok(reasonsAt < tailAt, 'the recorded reasons come before the conversation tail')
  assert.ok(
    composed.text.indexOf('second reason') < composed.text.indexOf('first reason'),
    'the recorded reasons are listed most recent first',
  )

  // The tail is the NEWEST content, and the budget is respected.
  assert.match(composed.text, /LATEST-ANSWER/)
  assert.match(composed.text, /tool call: pwsh/)
  assert.match(composed.text, /tool result: pwsh/)
  assert.ok(composed.tailChars <= 200, `the tail must respect the budget, got ${composed.tailChars}`)
  assert.ok(!composed.text.includes('A'.repeat(50)), 'the oversized older message is not carried')
  assert.equal(typeof composed.carriedChars, 'number')
  assert.equal(HANDOFF_DEFAULT_MAX_CHARS, 20000)
})

// ---------------------------------------------------------------------------
// 2. handoff through the model-facing tool
// ---------------------------------------------------------------------------

test('a source session without a live goal still hands off into a fresh session', async () => {
  const { file } = tempStateFile('no-goal')
  const old = fakeAgent('sess-old')
  const source = fakeSession({
    contextWindow: 128_000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'please continue the migration' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done with step one' }] },
    ],
  })
  const fake = makeFake({
    agents: [old],
    services: { sessions: { get: (id) => (String(id) === 'sess-old' ? source : undefined) } },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const handoff = fake.tools.find((tool) => tool.name === 'continuum_handoff')
  assert.ok(handoff, 'continuum_handoff must be registered')
  const result = await handoff.execute({ sessionId: 'sess-old', maxChars: 500 })

  assert.equal(result.ok, true)
  assert.ok(result.sessionId, 'the new session id is reported')
  assert.notEqual(result.sessionId, 'sess-old')
  assert.ok(result.carriedChars > 0)
  assert.match(result.instruction, /Continue the work in the new session/)

  // The new session is created in the source working directory, parented to it.
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0].sessionId, result.sessionId)
  assert.equal(fake.created[0].meta.parentSession, 'sess-old')
  assert.ok(path.isAbsolute(fake.created[0].meta.cwd), 'the meta cwd must be absolute')

  // The composed text is delivered to the NEW agent only, through the same
  // frozen `continuum` message the continuation prompt uses.
  const newAgent = fake.ctx.agents.get(result.sessionId)
  assert.equal(newAgent.followups.length, 1)
  const delivered = newAgent.followups[0]
  assert.equal(delivered.role, 'user')
  assert.equal(delivered.source.kind, 'continuum')
  assert.match(messageText(newAgent), /Goal objective:/)
  assert.match(messageText(newAgent), /Old session id: sess-old/)
  assert.equal(old.followups.length, 0, 'the old session is not prompted')
})

test('the handoff is recorded, the source goal is disarmed, and the boot recovery skips it', async () => {
  const { file } = tempStateFile('record')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-old', reason: 'host restart' })
    setGoal(state, 'sess-old', { goalId: 'goal-1', goalRevision: 3, phase: 'active' })
  })
  const old = fakeAgent('sess-old')
  const goals = {
    'sess-old': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
  }
  const calls = { resume: [], disarm: [] }
  const source = fakeSession({
    contextWindow: 128_000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'the work so far' }] }],
  })
  const services = {
    goals: fakeGoals(goals, calls),
    sessions: { get: (id) => (String(id) === 'sess-old' ? source : undefined) },
  }
  const fake = makeFake({ agents: [old], services })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const handoff = fake.tools.find((tool) => tool.name === 'continuum_handoff')
  const result = await handoff.execute({ sessionId: 'sess-old' })
  assert.equal(result.ok, true)
  assert.equal(result.disarmedGoal, true, 'the goal of the over-limit session is disarmed')
  assert.equal(calls.disarm.length, 1)
  assert.equal(goals['sess-old'].activation, 'disarmed')
  assert.equal(goals['sess-old'].phase, 'active', 'disarming keeps the durable goal active')

  // The durable record.
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entry = state.sessions['sess-old']
  assert.equal(entry.handoff.handedOffTo, result.sessionId)
  assert.equal(typeof entry.handoff.handoffAt, 'number')
  assert.equal(entry.handoff.carriedChars, result.carriedChars)
  assert.equal(entry.pendingResume, false)

  // A later boot must NOT resume the handed-off session any more.
  state.bootPid = 999_999
  state.bootId = 'previous-boot-2'
  writeState(file, state)
  old.followups.length = 0
  const second = makeFake({ agents: [old], services })
  apply(second.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(second)

  assert.equal(old.followups.length, 0, 'no continuation message is queued into the old session')
  assert.equal(calls.resume.length, 0, 'its goal is not re-armed')
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.sessions['sess-old'].handoff.handedOffTo, result.sessionId, 'the record survives')
  assert.deepEqual(recoverableSessions(after, {}), [], 'the handed-off session is out of the resume path')

  // The status lists it per session.
  const status = fake.tools.find((tool) => tool.name === 'continuum_status').execute({})
  const row = status.handoffs.find((item) => item.sessionId === 'sess-old')
  assert.ok(row, 'the handoff must be visible in the status output')
  assert.equal(row.handedOffTo, result.sessionId)
  assert.equal(typeof row.handoffAt, 'number')
  assert.equal(row.handedOff, true)
})

// ---------------------------------------------------------------------------
// 3. the context-overflow guard
// ---------------------------------------------------------------------------

test('an over-limit session is not re-armed and records context-overflow', async () => {
  const { file } = tempStateFile('overflow')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-big', reason: 'host restart' })
    setGoal(state, 'sess-big', { goalId: 'goal-1', goalRevision: 3, phase: 'active' })
    setDisarmedGoal(state, 'sess-big', { goalId: 'goal-1' })
  })
  const goals = {
    'sess-big': { id: 'goal-1', revision: 3, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  }
  const calls = { resume: [], disarm: [] }
  const source = fakeSession({
    contextWindow: 128_000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'an enormous conversation' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'still working' }], usage: { inputTokens: 200_000 } },
    ],
  })
  const fake = makeFake({
    agents: [fakeAgent('sess-big')],
    services: {
      goals: fakeGoals(goals, calls),
      sessions: { get: (id) => (String(id) === 'sess-big' ? source : undefined) },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(calls.resume.length, 0, 'the goal of an over-limit session is never re-armed')
  assert.equal(goals['sess-big'].activation, 'disarmed', 'the live goal is left alone')

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entry = state.sessions['sess-big']
  assert.equal(entry.lastRecoveryAction, 'context-overflow')
  assert.match(entry.lastRecoveryDetail, /200000/)
  assert.match(entry.lastRecoveryDetail, /128000/)
  assert.equal(entry.contextOverflow.over, true)
  assert.equal(entry.contextOverflow.inputTokens, 200_000)
  assert.equal(entry.contextOverflow.contextWindow, 128_000)
  assert.equal(entry.pendingResume, false, 'an over-limit session leaves the resume path')

  // A second pass cannot pick it up again.
  const recover = fake.tools.find((tool) => tool.name === 'continuum_recover_now')
  const again = await recover.execute({})
  assert.deepEqual(again.results, [])

  const status = fake.tools.find((tool) => tool.name === 'continuum_status').execute({})
  const row = status.handoffs.find((item) => item.sessionId === 'sess-big')
  assert.ok(row, 'the over-limit session must be visible in the status output')
  assert.equal(row.overContextLimit, true)
  assert.equal(row.contextOverflow.inputTokens, 200_000)
})

test('a normal session is still re-armed after the boot', async () => {
  const { file } = tempStateFile('normal')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-ok', reason: 'host restart' })
    setGoal(state, 'sess-ok', { goalId: 'goal-2', goalRevision: 1, phase: 'active' })
    setDisarmedGoal(state, 'sess-ok', { goalId: 'goal-2' })
  })
  const goals = {
    'sess-ok': { id: 'goal-2', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  }
  const calls = { resume: [], disarm: [] }
  const source = fakeSession({
    contextWindow: 128_000,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'small' }], usage: { inputTokens: 1000 } }],
  })
  const fake = makeFake({
    agents: [fakeAgent('sess-ok')],
    services: {
      goals: fakeGoals(goals, calls),
      sessions: { get: (id) => (String(id) === 'sess-ok' ? source : undefined) },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(calls.resume.length, 1, 'a session within the window is re-armed')
  assert.equal(goals['sess-ok'].activation, 'armed')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-ok'].lastRecoveryAction, 'resume-disarmed-goal')
  assert.equal(state.sessions['sess-ok'].contextOverflow, undefined)
})

// ---------------------------------------------------------------------------
// 4. the /handoff route
// ---------------------------------------------------------------------------

test('the handoff route requires the same authentication as the health route', async () => {
  const { file } = tempStateFile('route')
  const source = fakeSession({
    contextWindow: 128_000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'please continue' }] }],
  })
  const fake = makeFake({
    agents: [fakeAgent('sess-old')],
    services: { sessions: { get: (id) => (String(id) === 'sess-old' ? source : undefined) } },
    withRoutes: true,
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const route = fake.routes.find((entry) => entry.path === '/__dsh_autorestart/handoff')
  assert.ok(route, 'the handoff route must be registered next to the health route')

  // A remote peer that is neither loopback nor admitted is refused.
  const refused = fakeResponse()
  route.handler(fakeRequest({ sessionId: 'sess-old' }, { remoteAddress: '203.0.113.7' }), refused)
  await settle()
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.body, '{"ok":false,"error":"loopback-only"}')

  // A non-POST request is refused.
  const wrongMethod = fakeResponse()
  route.handler(fakeRequest({ sessionId: 'sess-old' }, { method: 'GET' }), wrongMethod)
  await settle()
  assert.equal(wrongMethod.statusCode, 405)

  // Loopback (the same admission the health route gives) succeeds.
  const accepted = fakeResponse()
  route.handler(fakeRequest({ sessionId: 'sess-old', maxChars: 400 }), accepted)
  await settle()
  assert.equal(accepted.statusCode, 200)
  const payload = JSON.parse(accepted.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.sessionId)
  assert.ok(payload.carriedChars > 0)

  // A browser request the connection service admits is allowed through as well.
  const admitted = tempStateFile('route-admitted')
  const allowed = makeFake({
    agents: [fakeAgent('sess-old')],
    services: {
      connection: { requestRejection: () => undefined },
      sessions: { get: (id) => (String(id) === 'sess-old' ? source : undefined) },
    },
    withRoutes: true,
  })
  apply(allowed.ctx, { stateFile: admitted.file, recoveryDelayMs: 0, enabled: true })
  const admittedRoute = allowed.routes.find((entry) => entry.path === '/__dsh_autorestart/handoff')
  const responded = fakeResponse()
  admittedRoute.handler(fakeRequest({ sessionId: 'sess-old' }, { remoteAddress: '203.0.113.7' }), responded)
  await settle()
  assert.notEqual(responded.statusCode, 403, 'an admitted browser request is not refused')
  assert.equal(responded.statusCode, 200)
})

// ---------------------------------------------------------------------------
// The context-overflow verdict must never be flipped by PROSE.
//
// A real incident: a tool result that merely quoted the phrase "context window
// exceeds limit" made the detector mark a healthy session over-limit, which took
// it out of the automatic resume path and then deleted its checkpoint entry.
// ---------------------------------------------------------------------------

test('a tool output that merely mentions the phrase does not mark the session over-limit', () => {
  const verdict = contextOverflow({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'why did that turn fail?' }] },
      {
        role: 'tool',
        content: 'grep output: 400 invalid params: context window exceeds limit (2013) — that is the error we saw earlier',
      },
    ],
    contextWindow: null,
    events: [],
  });
  assert.equal(verdict.over, false, 'prose in an ordinary message is not evidence');
});

test('token numbers are authoritative even when a message text mentions the phrase', () => {
  const verdict = contextOverflow({
    messages: [
      { role: 'assistant', usage: { inputTokens: 40_000 }, content: 'notes: context window exceeded last week' },
      { role: 'tool', content: 'context window exceeds limit (2013)' },
    ],
    contextWindow: 128_000,
    events: [],
  });
  assert.equal(verdict.over, false, 'the last request fit inside the window');
  assert.equal(verdict.inputTokens, 40_000);
});

test('a structured turn/end error IS evidence, and numbers still win when known', () => {
  const failed = contextOverflow({
    messages: [],
    contextWindow: null,
    events: [
      { type: 'turn/start', data: {} },
      {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: '400 invalid_request_error: invalid params, context window exceeds limit (2013)' } } },
      },
    ],
  });
  assert.equal(failed.over, true, 'a structured turn failure is real evidence');

  const numbersWin = contextOverflow({
    messages: [{ role: 'assistant', usage: { inputTokens: 10_000 } }],
    contextWindow: 128_000,
    events: [
      {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'context window exceeds limit' } } },
      },
    ],
  });
  assert.equal(numbersWin.over, false, 'known numbers decide, an older failure does not');
});

test('an over-limit numeric verdict is still reported', () => {
  const verdict = contextOverflow({
    messages: [{ role: 'assistant', usage: { inputTokens: 200_000 } }],
    contextWindow: 128_000,
    events: [],
  });
  assert.equal(verdict.over, true);
  assert.equal(verdict.inputTokens, 200_000);
  assert.equal(verdict.contextWindow, 128_000);
});
