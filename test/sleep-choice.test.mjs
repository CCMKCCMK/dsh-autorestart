/**
 * Tests for the choice route with the graceful-sleep answer.
 *
 * `POST {prefix}/choice` used to carry ONE answer: whether the pre-restart
 * backup also snapshots the installed plugins. It now also carries the answer
 * to the second install question: whether the graceful-sleep button is shown.
 *
 * The route must stay BACKWARD COMPATIBLE: the old request (only
 * `includePlugins`) must still work exactly as before, and asking for one key
 * must never write the other one.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** The route that persists the choices. */
const CHOICE_PATH = '/__dsh_autorestart/choice'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** Create a temporary state directory per test. */
function tempStateDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-choice-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/**
 * A fake Cordis context: it records the registered routes and the profile
 * edits the configEditor service receives.
 */
function createContext({ services = {} } = {}) {
  const routes = []
  const warnings = []
  const edits = []
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
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes, warnings, edits }
}

/** A configEditor stand-in that records every edit of this plugin's row. */
function createEditor(edits, row = {}) {
  return {
    entries: () => ([{ options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: { ...row } } }]),
    edit: async (entry, change) => {
      edits.push({
        rowId: entry && entry.options ? entry.options.id : null,
        next: change({ ...row }, {}),
      })
    },
  }
}

/** Minimal Node response stand-in for the route handlers. */
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
function fakeRequest(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: CHOICE_PATH,
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

/** The choice route of a freshly applied plugin. */
function choiceRoute(routes) {
  const route = routes.find((entry) => entry.path === CHOICE_PATH)
  assert.ok(route, `the choice route ${CHOICE_PATH} must be registered`)
  return route
}

test('the old answer (only includePlugins) still works exactly as before', async () => {
  const { file } = tempStateDir('legacy')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: false }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, applied: 'config', includePlugins: false })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].next.backupIncludePlugins, false)
  assert.ok(
    !('showSleepButton' in edits[0].next),
    'the sleep answer must not be written when it was not asked for',
  )
})

test('only includePlugins writes only the backup scope', async () => {
  const { file } = tempStateDir('only-plugins')
  const edits = []
  const { ctx, routes } = createContext({
    services: { configEditor: createEditor(edits, { showSleepButton: true }) },
  })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: true }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, 'config')
  assert.equal(payload.includePlugins, true)
  assert.equal(payload.showSleepButton, undefined, 'the sleep answer must not be echoed back')
  assert.equal(edits[0].next.backupIncludePlugins, true)
  assert.equal(edits[0].next.showSleepButton, true, 'the untouched key must keep its value')
})

test('only showSleepButton writes only the sleep answer', async () => {
  const { file } = tempStateDir('only-sleep')
  const edits = []
  const { ctx, routes } = createContext({
    services: { configEditor: createEditor(edits, { backupIncludePlugins: true }) },
  })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { showSleepButton: false }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, 'config')
  assert.equal(payload.showSleepButton, false)
  assert.equal(payload.includePlugins, undefined, 'the backup answer must not be echoed back')
  assert.equal(edits[0].next.showSleepButton, false)
  assert.equal(
    edits[0].next.backupIncludePlugins,
    true,
    'the untouched key must keep its value',
  )
  assert.ok(
    !('backupIncludePlugins' in edits[0].next) || edits[0].next.backupIncludePlugins === true,
    'the backup scope must not be overwritten',
  )
})

test('both answers at once are both written', async () => {
  const { file } = tempStateDir('both')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: false, showSleepButton: true }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    applied: 'config',
    includePlugins: false,
    showSleepButton: true,
  })
  assert.equal(edits.length, 1, 'both answers must land in ONE edit')
  assert.equal(edits[0].next.backupIncludePlugins, false)
  assert.equal(edits[0].next.showSleepButton, true)
})

test('the settings of the configuration page are written into the profile row', async () => {
  const { file } = tempStateDir('settings')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(
    fakeRequest('POST', { sleepCountdownSeconds: 30 }),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, 'config')
  assert.equal(payload.sleepCountdownSeconds, 30)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].next.sleepCountdownSeconds, 30)

  // The running instance takes the new values at once: the status route
  // reports them.
  const state = fakeResponse()
  const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(sleep, 'the sleep route must be registered')
  sleep.handler(fakeRequest('GET'), state)
  await settle()
  const status = JSON.parse(state.body)
  assert.equal(status.countdownSeconds, 30)
})

test('the pre-restart backup scope is written into the profile row', async () => {
  const { file } = tempStateDir('backup-scope')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(
    fakeRequest('POST', { backupOnRestart: false, backupIncludePlugins: false }),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, 'config')
  assert.equal(payload.backupOnRestart, false)
  assert.equal(payload.backupIncludePlugins, false)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].next.backupOnRestart, false)
  assert.equal(edits[0].next.backupIncludePlugins, false)

  // The running instance takes the new values at once: the status route
  // reports them (that is where the settings page reads them back from).
  const state = fakeResponse()
  const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(sleep, 'the sleep route must be registered')
  sleep.handler(fakeRequest('GET'), state)
  await settle()
  const status = JSON.parse(state.body)
  assert.equal(status.backupOnRestart, false)
  assert.equal(status.backupIncludePlugins, false)
})

test('an invalid setting is refused with 400 and nothing is written', async () => {
  const { file } = tempStateDir('invalid-settings')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  for (const body of [
    { sleepCountdownSeconds: 15 },
    { sleepCountdownSeconds: '20' },
    { backupOnRestart: 'yes' },
    { backupOnRestart: 1 },
    { backupIncludePlugins: 'true' },
    { backupIncludePlugins: null },
  ]) {
    const res = fakeResponse()
    choiceRoute(routes).handler(fakeRequest('POST', body), res)
    await settle()
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be refused`)
    assert.equal(JSON.parse(res.body).ok, false)
  }
  assert.equal(edits.length, 0, 'nothing may be written into the profile configuration')
})

test('an empty body is refused with 400 and nothing is written', async () => {
  const { file } = tempStateDir('empty')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  for (const body of [{}, { unrelated: true }]) {
    const res = fakeResponse()
    choiceRoute(routes).handler(fakeRequest('POST', body), res)
    await settle()
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be refused`)
    assert.equal(JSON.parse(res.body).ok, false)
  }
  assert.equal(edits.length, 0, 'nothing may be written into the profile configuration')
})

test('a non-boolean answer is refused with 400 and nothing is written', async () => {
  const { file } = tempStateDir('invalid')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  for (const invalid of ['true', 1, 0, null, {}, []]) {
    const res = fakeResponse()
    choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: invalid }), res)
    await settle()
    assert.equal(res.statusCode, 400, `includePlugins=${JSON.stringify(invalid)} must be refused`)
    assert.equal(JSON.parse(res.body).ok, false)

    const other = fakeResponse()
    choiceRoute(routes).handler(fakeRequest('POST', { showSleepButton: invalid }), res)
    await settle()
    assert.equal(res.statusCode, 400, `showSleepButton=${JSON.stringify(invalid)} must be refused`)
  }
  assert.equal(edits.length, 0, 'nothing may be written into the profile configuration')
})

test('a malformed answer next to a legal one still refuses the whole request', async () => {
  const { file } = tempStateDir('mixed')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: true, showSleepButton: 'yes' }), res)
  await settle()
  assert.equal(res.statusCode, 400)
  assert.equal(edits.length, 0, 'a malformed key must not write the legal one either')
})

test('without a configEditor both answers land in the fallback file', async () => {
  const { dir, file } = tempStateDir('fallback')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: false, showSleepButton: false }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    applied: 'fallback-file',
    includePlugins: false,
    showSleepButton: false,
  })
  const fallback = path.join(dir, 'install-choice.json')
  assert.ok(fs.existsSync(fallback), 'the fallback file must be written')
  const recorded = JSON.parse(fs.readFileSync(fallback, 'utf8'))
  assert.equal(recorded.includePlugins, false)
  assert.equal(recorded.showSleepButton, false)
})

test('a later answer does not erase the earlier one', async () => {
  const { dir, file } = tempStateDir('additive')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const first = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: true }), first)
  await settle()
  assert.equal(first.statusCode, 200)

  const second = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { showSleepButton: true }), second)
  await settle()
  assert.equal(second.statusCode, 200)

  const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'install-choice.json'), 'utf8'))
  assert.equal(recorded.includePlugins, true, 'the backup scope must survive')
  assert.equal(recorded.showSleepButton, true)
})
