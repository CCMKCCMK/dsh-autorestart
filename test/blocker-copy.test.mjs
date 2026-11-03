/**
 * Tests for the copy of the blockers and for the title resolution.
 *
 * The defect the real machine showed: three busy sessions without a title
 * produced "等 3 个会话收工（会话、会话、会话），收工后开始倒数。" — a list of
 * three identical generic names says nothing and looks like a bug. And the
 * titles were never resolved at all, because the session list names its rows
 * `sessionId` (not `id`) and carries the title as a PROJECTION
 * (`projections.values.title`), not as a `title` field of its own.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { createSleepController } from '../lib/sleep.js'

const SLEEP_PATH = '/__dsh_autorestart/sleep'

/* ------------------------------------------------------------------ *
 * The copy of the waiting line.
 * ------------------------------------------------------------------ */

/**
 * A controller with a fake clock, a fake timer and a fake shutdown.
 *
 * @param {{ busy?: any[], titles?: Record<string, string>, countdownSeconds?: number }} options
 */
function createController({ busy = [], titles = {}, countdownSeconds = 20 } = {}) {
  let clock = 1000
  const timers = []
  const shutdowns = []
  const controller = createSleepController({
    now: () => clock,
    busyAgents: () => busy,
    gate: () => ({ allow: true, blockedBy: busy }),
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
  return { controller, timers, shutdowns }
}

/** A busy session with a title. */
function named(sessionId, label) {
  return { sessionId, kind: 'session', label, name: label, parentTitle: null, title: label }
}

/** A busy session without a title: no label, no name — nothing to show. */
function nameless(sessionId) {
  return { sessionId, kind: 'session', label: null, name: '', parentTitle: null, title: '' }
}

test('every busy session with a title: the names are listed', () => {
  const harness = createController({
    busy: [named('a', '甲'), named('b', '乙'), named('c', '丙')],
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting')
  assert.equal(
    status.message,
    '等 3 个任务收工（甲、乙、丙），收工后开始倒数。',
    `the names belong in the line: ${status.message}`,
  )
  assert.doesNotMatch(status.message, /会话、会话/, 'a list of generic names is not a list')
})

test('no title at all: the parenthetical is left out', () => {
  const harness = createController({
    busy: [nameless('a'), nameless('b'), nameless('c')],
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting')
  assert.equal(
    status.message,
    '等 3 个任务收工，收工后开始倒数。',
    `without a name the whole parenthetical goes: ${status.message}`,
  )
  assert.doesNotMatch(status.message, /（/, 'no empty parenthetical either')
  assert.doesNotMatch(status.message, /会话、会话/, 'a list of generic names is not a list')
  // The blockers themselves carry no invented name either.
  assert.equal(status.blockers[0].label, null)
  assert.equal(status.blockers[0].name, '')
  assert.equal(status.blockers[0].title, '')
})

test('one busy session without a title: the count, no parenthetical', () => {
  const harness = createController({ busy: [nameless('a')] })
  const status = harness.controller.arm()
  assert.equal(status.message, '等 1 个任务收工，收工后开始倒数。', status.message)
  assert.doesNotMatch(status.message, /（/, 'no empty parenthetical either')
})

test('one busy session with a title: the singular form', () => {
  const harness = createController({ busy: [named('a', '甲')] })
  const status = harness.controller.arm()
  assert.equal(status.message, '等「甲」收工，收工后开始倒数。', status.message)
})

test('one named and one nameless session: no parenthetical', () => {
  const harness = createController({ busy: [named('a', '甲'), nameless('b')] })
  const status = harness.controller.arm()
  assert.equal(status.message, '等 2 个任务收工，收工后开始倒数。', status.message)
  assert.doesNotMatch(status.message, /（/, 'a half-named list is no list')
})

test('a countdown of zero seconds says "immediately" instead', () => {
  const harness = createController({ busy: [named('a', '甲')], countdownSeconds: 0 })
  const status = harness.controller.arm()
  assert.equal(status.message, '等「甲」收工，收工后立即关机。', status.message)
})

/* ------------------------------------------------------------------ *
 * The title resolution.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-copy-${label}-`))
  return path.join(dir, 'state.json')
}

/** A fake response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request with a JSON body. */
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

/**
 * A fake Cordis context with a session controller and one busy agent.
 *
 * @param {{ sessionRows?: any[], busySessionId?: string }} options
 */
function createContext({ sessionRows = [], busySessionId = 'sess-a' } = {}) {
  const routes = []
  const tools = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const agent = { id: busySessionId, status: 'running', session: { header: { id: busySessionId } } }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [agent], roots: () => [agent], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'sessionController') {
        return { list: () => Promise.resolve({ items: sessionRows }) }
      }
      return undefined
    },
  }
  return { ctx, routes, tools }
}

/** Arm the shutdown and read the blockers the Host reports. */
async function armAndReadBlockers(ctx, routes) {
  const route = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(route, `the sleep route ${SLEEP_PATH} must be registered`)
  const res = fakeResponse()
  route.handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  const payload = JSON.parse(res.body)
  return payload
}

test('the title comes from the projection of the session list', async () => {
  const { ctx, routes } = createContext({
    sessionRows: [{
      sessionId: 'sess-a',
      // The real shape: the title is a PROJECTION value.
      projections: { kind: 'sequenced', asOfSeq: 12, values: { title: '写代码' } },
    }],
  })
  apply(ctx, { stateFile: tempStateFile('projection'), recoveryDelayMs: 0, enabled: true, restartGraceMs: 0 })

  // The first read fills the cache (the list is asynchronous).
  await armAndReadBlockers(ctx, routes)
  const payload = await armAndReadBlockers(ctx, routes)
  assert.equal(payload.blockers.length, 1)
  assert.equal(payload.blockers[0].label, '写代码', 'the real title must be used')
  assert.equal(payload.blockers[0].name, '写代码')
  assert.match(payload.message, /「写代码」/, `the name belongs in the line: ${payload.message}`)
})

test('a row without a projection still carries a plain title', async () => {
  const { ctx, routes } = createContext({
    sessionRows: [{ sessionId: 'sess-a', title: '重构解析器' }],
  })
  apply(ctx, { stateFile: tempStateFile('plain'), recoveryDelayMs: 0, enabled: true, restartGraceMs: 0 })
  await armAndReadBlockers(ctx, routes)
  const payload = await armAndReadBlockers(ctx, routes)
  assert.equal(payload.blockers[0].label, '重构解析器', 'the plain title must be used')
})

test('an older row shape names its session "id"', async () => {
  const { ctx, routes } = createContext({
    sessionRows: [{ id: 'sess-a', title: '旧形状' }],
  })
  apply(ctx, { stateFile: tempStateFile('old'), recoveryDelayMs: 0, enabled: true, restartGraceMs: 0 })
  await armAndReadBlockers(ctx, routes)
  const payload = await armAndReadBlockers(ctx, routes)
  assert.equal(payload.blockers[0].label, '旧形状', 'the old shape must work too')
})

test('without a title the blocker carries no name at all', async () => {
  const { ctx, routes } = createContext({
    sessionRows: [{ sessionId: 'sess-a' }],
  })
  apply(ctx, { stateFile: tempStateFile('none'), recoveryDelayMs: 0, enabled: true, restartGraceMs: 0 })
  await armAndReadBlockers(ctx, routes)
  const payload = await armAndReadBlockers(ctx, routes)
  assert.equal(payload.blockers[0].label, null)
  assert.equal(payload.blockers[0].name, '', 'no invented generic name')
  assert.equal(payload.blockers[0].title, '')
  assert.doesNotMatch(payload.message, /（会话、会话/, 'never a list of generic names')
})

/* ------------------------------------------------------------------ *
 * The tool output schema.
 * ------------------------------------------------------------------ */

/**
 * Whether one value matches one declared schema node.
 *
 * The Host validates a tool's output against its declared schema, and a
 * mismatch makes the WHOLE tool fail. The schema dialect has no type
 * arrays: "string or null" is declared as a `oneOf`.
 *
 * @param {any} value
 * @param {any} node
 * @returns {boolean}
 */
function matchesSchema(value, node) {
  if (!node || typeof node !== 'object') return true
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((branch) => matchesSchema(value, branch)).length
    return matches === 1
  }
  switch (node.type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}

test('the status tool accepts a blocker whose title is null', () => {
  const { ctx, tools } = createContext({ sessionRows: [] })
  apply(ctx, { stateFile: tempStateFile('schema'), recoveryDelayMs: 0, enabled: true })
  const status = tools.find((tool) => tool.name === 'continuum_status')
  assert.ok(status, 'the continuum_status tool must be registered')
  const result = status.execute({})

  // The busy session has no title: its label and its parent fields are null.
  const blocked = result.blockedBy
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].label, null, 'the title could not be resolved')
  assert.equal(blocked[0].parentTitle, null)
  assert.equal(blocked[0].parentSessionId, null)

  // Every value must match the declared schema, or the tool output is
  // rejected and the whole tool breaks.
  const properties = status.output.schema.properties
  for (const entry of blocked) {
    for (const [key, value] of Object.entries(entry)) {
      const node = properties.blockedBy.items.properties[key]
      if (!node) continue
      assert.equal(
        matchesSchema(value, node),
        true,
        `blockedBy.${key} (${JSON.stringify(value)}) does not match the declared schema`,
      )
    }
  }
})
