/**
 * THE `__proto__` PROTOTYPE POLLUTION (and the cross-site request that could
 * reach a state-changing route).
 *
 * The report: a session id of `__proto__` made `state.sessions` hand out
 * `Object.prototype` ITSELF, so every field the checkpoint wrote on that
 * "entry" landed in the prototype of the whole process. The same key, written
 * with a plain assignment, rewrote the prototype of the map itself.
 *
 * Two guards close it:
 *   1. the checkpoint only ever reads and writes OWN properties of the session
 *      map, and a session id of `__proto__` / `constructor` / `prototype` is
 *      refused at every entry point (the tools and the routes);
 *   2. a route that CHANGES state only accepts `application/json`, so a
 *      cross-site simple request (a form post, or `text/plain`) cannot reach
 *      it at all.
 *
 * Every test below fails on the old implementation.
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
  clearSession,
  createEmptyState,
  entryFor,
  handoffRecord,
  isForbiddenSessionId,
  markIdle,
  markPendingResume,
  markRunning,
  normalizeState,
  pruneSessions,
  setDisarmedGoal,
  setParkedGoal,
  setRecoveryOutcome,
  stampResumedGoal,
} from '../lib/checkpoint.js'

/** The ids that must never become a key of a session-keyed map. */
const HOSTILE_IDS = ['__proto__', 'constructor', 'prototype']

/** Create a temporary state-file path per test. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-proto-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/** A fake live Agent good enough for goal lookups and ids. */
function fakeAgent(id) {
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followup() {},
  }
}

/**
 * Build a fake Cordis context. `withRoutes` adds a web server that records
 * every registered route; the tools are recorded either way.
 */
function makeFake({ agents = [], services = {}, withRoutes = false } = {}) {
  const tools = []
  const routes = []
  const timeouts = []
  const created = []
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
    on: () => () => {},
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
    emit: () => {},
  }
  return { ctx, tools, routes, timeouts, created }
}

/** A request stand-in for a route call. */
function fakeRequest(body, {
  method = 'POST',
  remoteAddress = '127.0.0.1',
  contentType = 'application/json',
} = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const handlers = {}
  return {
    method,
    url: '/__dsh_autorestart/route',
    headers: contentType === null ? {} : { 'content-type': contentType },
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

/** The route of a freshly applied plugin whose path ends with `suffix`. */
function routeEnding(routes, suffix) {
  const route = routes.find((entry) => typeof entry.path === 'string' && entry.path.endsWith(suffix))
  assert.ok(route, `the ${suffix} route must be registered`)
  return route
}

// ---------------------------------------------------------------------------
// 1. the checkpoint itself: the prototype of the process stays clean
// ---------------------------------------------------------------------------

test('a session id of __proto__ never reaches the prototype of the process', () => {
  const state = { sessions: {} }
  markRunning(state, { sessionId: '__proto__' })
  markIdle(state, '__proto__')
  setRecoveryOutcome(state, '__proto__', { action: 'prompt-continuation' })
  markPendingResume(state, { sessionId: '__proto__', reason: 'host restart' })

  // The old implementation wrote every one of these fields onto
  // `Object.prototype` itself.
  assert.equal({}.pendingResume, undefined)
  assert.equal({}.interrupted, undefined)
  assert.equal({}.running, undefined)
  assert.equal({}.lastRecoveryAction, undefined)
  assert.equal({}.resumeAttempts, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'pendingResume'), false)
})

test('entryFor answers a fresh ordinary entry for the id __proto__', () => {
  const state = { sessions: {} }
  const entry = entryFor(state, '__proto__')

  // NOT `Object.prototype` itself (that was the bug).
  assert.notEqual(entry, Object.prototype)
  assert.equal(Object.getPrototypeOf(entry), Object.prototype, 'the entry is an ordinary object')
  assert.equal(entry.sessionId, '__proto__')

  // The map keeps its own prototype: it was rewritten before.
  assert.equal(Object.getPrototypeOf(state.sessions), Object.prototype)
  assert.notEqual(Object.getPrototypeOf(state.sessions), entry)
})

test('the other prototype keys are ordinary sessions as well', () => {
  for (const id of HOSTILE_IDS) {
    const state = { sessions: {} }
    const entry = entryFor(state, id)
    assert.notEqual(entry, Object.prototype, `${id} must not answer Object.prototype`)
    assert.notEqual(entry, Object, `${id} must not answer the Object constructor`)
    assert.equal(Object.getPrototypeOf(entry), Object.prototype)
    assert.equal(Object.getPrototypeOf(state.sessions), Object.prototype)
  }
})

test('a session map never answers an inherited property', () => {
  const state = createEmptyState(1_700_000_000_000)
  // The bare reads of the hostile keys must not hand out anything inherited.
  assert.equal(state.sessions['__proto__'], undefined)
  assert.equal(state.sessions['constructor'], undefined)
  assert.equal(state.sessions['prototype'], undefined)
  assert.equal(Object.getPrototypeOf(state.sessions), Object.prototype)
})

test('the readers and the clearer of a session never touch the prototype', () => {
  const state = { sessions: {} }
  entryFor(state, 'sess-1')
  clearSession(state, '__proto__')
  assert.equal(handoffRecord(state, '__proto__'), null)
  assert.equal({}.pendingResume, undefined)
  assert.equal({}.handoff, undefined)
})

test('a state file that carries a __proto__ session is repaired, not copied', () => {
  const raw = JSON.parse('{"version":1,"sessions":{"__proto__":{"sessionId":"__proto__","pendingResume":true}}}')
  const { state, repaired } = normalizeState(raw)
  assert.equal(repaired, true, 'the poisoned entry is reported as a repair')
  assert.equal(Object.keys(state.sessions).includes('__proto__'), false)
  assert.equal(Object.getPrototypeOf(state.sessions), Object.prototype)
})

test('isForbiddenSessionId names exactly the prototype keys', () => {
  for (const id of HOSTILE_IDS) assert.equal(isForbiddenSessionId(id), true, `${id} must be forbidden`)
  assert.equal(isForbiddenSessionId('session-1'), false)
  assert.equal(isForbiddenSessionId(''), false)
  assert.equal(isForbiddenSessionId(undefined), false)
})

test('the shadow of a session map survives every delete path', () => {
  const now = Date.now()

  // `setDisarmedGoal` drops the LEGACY parked record of the same session.
  const parked = { sessions: {} }
  setParkedGoal(parked, '__proto__', { goalId: 'g1' })
  setDisarmedGoal(parked, '__proto__', { goalId: 'g1' })
  assert.notEqual(parked.parkedGoals['__proto__'], Object.prototype,
    'parkedGoals lost its shadow: a bare read hands out Object.prototype')

  // `pruneSessions` drops the resumed goal records of the same maps.
  const disarmed = { sessions: {} }
  setDisarmedGoal(disarmed, '__proto__', { goalId: 'g1' })
  stampResumedGoal(disarmed, '__proto__', { resumedAt: 1 })
  pruneSessions(disarmed, { maxSessions: 10, maxAgeMs: 1, now: now + 10_000_000 })
  assert.notEqual(disarmed.disarmedGoals['__proto__'], Object.prototype,
    'disarmedGoals lost its shadow')

  // ...and the session map itself.
  const sessions = { sessions: {} }
  entryFor(sessions, 'sess-1')
  pruneSessions(sessions, { maxSessions: 1, maxAgeMs: 1, now: now + 10_000_000 })
  assert.notEqual(sessions.sessions['__proto__'], Object.prototype,
    'sessions lost its shadow')
})

// ---------------------------------------------------------------------------
// 2. the tools: a hostile session id is refused, and nothing is written
// ---------------------------------------------------------------------------

test('the three lifecycle tools refuse a prototype session id and write nothing', async () => {
  const { file } = tempStateFile('tools')
  const fake = makeFake({ agents: [fakeAgent('sess-1')] })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const recoverNow = fake.tools.find((tool) => tool.name === 'continuum_recover_now')
  const handoff = fake.tools.find((tool) => tool.name === 'continuum_handoff')
  const parkGoal = fake.tools.find((tool) => tool.name === 'continuum_park_goal')
  assert.ok(recoverNow && handoff && parkGoal, 'the three tools must be registered')

  for (const id of HOSTILE_IDS) {
    const recovered = await recoverNow.execute({ sessionId: id, force: true })
    assert.equal(recovered.ok, false, `${id} must be refused by continuum_recover_now`)
    assert.equal(recovered.results[0].action, 'refused')
    assert.equal(recovered.results[0].detail, 'invalid-session-id')

    const handed = await handoff.execute({ sessionId: id })
    assert.equal(handed.ok, false, `${id} must be refused by continuum_handoff`)
    assert.equal(handed.error, 'invalid-session-id')

    const parked = parkGoal.execute({ sessionId: id })
    assert.equal(parked.ok, false, `${id} must be refused by continuum_park_goal`)
    assert.equal(parked.disarmed, false)
    assert.equal(parked.reason, 'invalid-session-id')
  }

  // Nothing was written, and the prototype of the process is clean.
  assert.equal(fake.created.length, 0, 'no handoff session was created')
  assert.equal({}.pendingResume, undefined)
  assert.equal({}.interrupted, undefined)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(written.sessions), [])
})

// ---------------------------------------------------------------------------
// 3. the routes: a hostile session id is refused, and nothing is written
// ---------------------------------------------------------------------------

test('the routes that take a session id refuse a prototype session id', async () => {
  const { file } = tempStateFile('routes')
  const fake = makeFake({ agents: [fakeAgent('sess-1')], withRoutes: true })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const suffixes = ['/park', '/recover', '/handoff', '/cancel']
  for (const suffix of suffixes) {
    const route = routeEnding(fake.routes, suffix)
    for (const id of HOSTILE_IDS) {
      const res = fakeResponse()
      route.handler(fakeRequest({ sessionId: id }), res)
      await settle()
      assert.equal(res.statusCode, 400, `${suffix} must refuse ${id}`)
      const payload = JSON.parse(res.body)
      assert.equal(payload.ok, false)
      assert.equal(payload.error, 'invalid-session-id')
    }
  }

  assert.equal({}.pendingResume, undefined)
  assert.equal({}.interrupted, undefined)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(written.sessions), [])
})

// ---------------------------------------------------------------------------
// 4. the routes that change state only accept JSON
// ---------------------------------------------------------------------------

test('a state-changing route refuses a cross-site simple request with 415', async () => {
  const { file } = tempStateFile('content-type')
  const fake = makeFake({ agents: [fakeAgent('sess-1')], withRoutes: true })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await settle()

  // The parts of the record a route could change when it acts.
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  const suffixes = [
    '/park',
    '/recover',
    '/handoff',
    '/cancel',
    '/choice',
    '/announcements',
    '/backup-limit',
    '/supervisor',
    '/rollback-to',
    '/plugin-restore',
  ]
  for (const suffix of suffixes) {
    const route = routeEnding(fake.routes, suffix)
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const res = fakeResponse()
      route.handler(fakeRequest({ sessionId: 'sess-1', feature: 'sleep' }, { contentType }), res)
      await settle()
      assert.equal(res.statusCode, 415, `${suffix} must answer 415 for ${contentType}`)
      const payload = JSON.parse(res.body)
      assert.equal(payload.ok, false)
      assert.equal(payload.error, 'unsupported-media-type')
    }
  }

  // Nothing was written: the body was never even read.
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(after.sessions), Object.keys(before.sessions))
  assert.equal(after.restart, before.restart)
  assert.equal(after.seenFeatureVersions && Object.keys(after.seenFeatureVersions).length, 0)
  assert.equal({}.pendingResume, undefined)
})

test('the 403 loopback refusal still comes first', async () => {
  const { file } = tempStateFile('loopback')
  const fake = makeFake({ agents: [fakeAgent('sess-1')], withRoutes: true })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const route = routeEnding(fake.routes, '/recover')
  const res = fakeResponse()
  route.handler(fakeRequest({ sessionId: 'sess-1' }, { remoteAddress: '203.0.113.7', contentType: 'text/plain' }), res)
  await settle()
  assert.equal(res.statusCode, 403, 'a remote peer is still refused with 403, not with 415')
  assert.equal(res.body, '{"ok":false,"error":"loopback-only"}')
})

test('a JSON request is still accepted by a state-changing route', async () => {
  const { file } = tempStateFile('json-ok')
  const fake = makeFake({ agents: [fakeAgent('sess-1')], withRoutes: true })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  // The recover route accepts a request with `application/json` (there is
  // nothing pending, so it answers that there was nothing to do).
  const route = routeEnding(fake.routes, '/recover')
  const res = fakeResponse()
  route.handler(fakeRequest({ sessionId: 'sess-1' }), res)
  await settle()
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
})
