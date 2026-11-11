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

import { apply, normalizeConfig, resolveCountdownSeconds } from '../index.js'
import { COUNTDOWN_CHOICES } from '../lib/sleep.js'

/** The route that persists the choices. */
const CHOICE_PATH = '/__dsh_autorestart/choice'
const SLEEP_PATH = '/__dsh_autorestart/sleep'
const HEALTH_PATH = '/__dsh_autorestart/health'

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

/** The choice route of a freshly applied plugin. */
function choiceRoute(routes) {
  const route = routes.find((entry) => entry.path === CHOICE_PATH)
  assert.ok(route, `the choice route ${CHOICE_PATH} must be registered`)
  return route
}

/** What the state route answers right now (the settings page reads it). */
function stateOf(routes) {
  const route = routes.find((entry) => entry.path === HEALTH_PATH)
  assert.ok(route, `the health route ${HEALTH_PATH} must be registered`)
  const res = fakeResponse()
  route.handler({
    method: 'GET',
    url: `${HEALTH_PATH}?state=1`,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this },
  }, res)
  return JSON.parse(res.body)
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

// THE DEFAULT COUNTDOWN IS TEN SECONDS NOW (2026-11-11).
//
// The user asked for "关机改成默认 10 秒". The default only decides what a
// profile that NEVER set the countdown gets: a stored choice (the profile row,
// or the degraded `install-choice.json` fallback) must be read back exactly as
// it was saved. Nothing migrates a stored 20 / 30 / 60 onto the new default.
test('an explicitly stored countdown is never overwritten by the new default', async () => {
  for (const stored of [0, 10, 20, 30, 60]) {
    const { file } = tempStateDir(`stored-countdown-${stored}`)
    const { ctx, routes } = createContext()
    apply(ctx, {
      stateFile: file,
      recoveryDelayMs: 0,
      enabled: true,
      // What the profile row carries for a user who picked this length.
      sleepCountdownSeconds: stored,
    })

    const state = fakeResponse()
    const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
    assert.ok(sleep, 'the sleep route must be registered')
    sleep.handler(fakeRequest('GET'), state)
    await settle()
    assert.equal(
      JSON.parse(state.body).countdownSeconds,
      stored,
      `a stored ${stored} must be read back as ${stored}, not replaced by the default`,
    )
  }
})

test('a profile that never set the countdown gets the new ten-second default', async () => {
  const { file } = tempStateDir('default-countdown')
  const { ctx, routes } = createContext()
  // No `sleepCountdownSeconds` in the row: this is the "never set it" case.
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const state = fakeResponse()
  const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(sleep, 'the sleep route must be registered')
  sleep.handler(fakeRequest('GET'), state)
  await settle()
  assert.equal(JSON.parse(state.body).countdownSeconds, 10, 'the built-in default is ten seconds now')

  // The same two answers, one layer down: the row wins, the default fills in.
  assert.equal(normalizeConfig({}).sleepCountdownSeconds, 10, 'nothing stored → the default')
  for (const stored of [0, 20, 30, 60]) {
    assert.equal(
      normalizeConfig({ sleepCountdownSeconds: stored }).sleepCountdownSeconds,
      stored,
      `a stored ${stored} must survive normalizeConfig unchanged`,
    )
  }
})

// THE DEGRADED FALLBACK FILE WAS WRITTEN AND NEVER READ (bug, 2026-11-11).
//
// `persistConfigChoice` records the countdown in `install-choice.json` when the
// configEditor service is unavailable, and `readInstallChoice` reads it back —
// but no resolver ever put it into the effective value, so the choice was made,
// stored, and silently lost. The three levels are now explicitly pinned:
// profile row > fallback file > built-in default.

/** Write a degraded `install-choice.json` next to the state file. */
function writeFallbackChoice(dir, payload) {
  fs.writeFileSync(path.join(dir, 'install-choice.json'), JSON.stringify(payload), 'utf8')
}

test('the countdown resolver: the profile row wins over the fallback file', () => {
  const { dir } = tempStateDir('resolver-row')
  writeFallbackChoice(dir, { sleepCountdownSeconds: 30 })
  const resolved = resolveCountdownSeconds({ sleepCountdownSeconds: 20 }, dir)
  assert.equal(resolved.countdownSeconds, 20, 'the row is the single source of truth')
  assert.equal(resolved.source, 'config')
})

test('the countdown resolver: a row without the key falls back to the file', () => {
  const { dir } = tempStateDir('resolver-file')
  writeFallbackChoice(dir, { sleepCountdownSeconds: 30 })
  const resolved = resolveCountdownSeconds({ enabled: true }, dir)
  assert.equal(resolved.countdownSeconds, 30, 'the recorded choice must be read back, not lost')
  assert.equal(resolved.source, 'fallback-file')
})

test('the countdown resolver: neither level says anything → the built-in default', () => {
  const { dir } = tempStateDir('resolver-default')
  const resolved = resolveCountdownSeconds({}, dir)
  assert.equal(resolved.countdownSeconds, 10, 'the default is ten seconds')
  assert.equal(resolved.source, 'default')
  // A missing state directory is not an error either.
  assert.equal(resolveCountdownSeconds({}, '').source, 'default')
})

test('the countdown resolver: an unusable fallback value is ignored, not guessed', () => {
  // The file is hand-editable ("any JSON"): anything that is not one of the
  // offered lengths must be dropped so the next level decides.
  for (const junk of ['30', null, true, {}, [], 15, -5, 1e9, Number.NaN]) {
    const { dir } = tempStateDir('resolver-junk')
    writeFallbackChoice(dir, { sleepCountdownSeconds: junk })
    const resolved = resolveCountdownSeconds({}, dir)
    assert.equal(
      resolved.countdownSeconds,
      10,
      `${JSON.stringify(junk) ?? String(junk)} is not an offered length: the default must win`,
    )
    assert.equal(resolved.source, 'default')
  }
  // Every offered length, on the other hand, IS honoured.
  for (const offered of COUNTDOWN_CHOICES) {
    const { dir } = tempStateDir(`resolver-offered-${offered}`)
    writeFallbackChoice(dir, { sleepCountdownSeconds: offered })
    assert.equal(resolveCountdownSeconds({}, dir).countdownSeconds, offered)
  }
})

test('the countdown resolver: the row keeps its old-value snapping', () => {
  // A profile that still carries 15 is snapped onto the nearest offered length
  // by `normalizeConfig`; the resolver must not undo that.
  const { dir } = tempStateDir('resolver-snap')
  const resolved = resolveCountdownSeconds({ sleepCountdownSeconds: 15 }, dir)
  assert.equal(resolved.countdownSeconds, 20, '15 snaps up to 20, as it always did')
  assert.equal(resolved.source, 'config')
})

test('a countdown chosen while the configEditor was unavailable is read back after a restart', async () => {
  // The degraded path: the choice only exists in the fallback file.
  const { dir, file } = tempStateDir('degraded-restart')
  writeFallbackChoice(dir, { sleepCountdownSeconds: 30 })

  const { ctx, routes } = createContext()
  // No `configEditor` service in this context: exactly the degraded environment.
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const state = fakeResponse()
  const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(sleep, 'the sleep route must be registered')
  sleep.handler(fakeRequest('GET'), state)
  await settle()
  assert.equal(
    JSON.parse(state.body).countdownSeconds,
    30,
    'the stored choice must survive the restart, not fall back to the default',
  )
})

test('a stored row still wins over a stale fallback file on the next boot', async () => {
  const { dir, file } = tempStateDir('degraded-stale-file')
  writeFallbackChoice(dir, { sleepCountdownSeconds: 30 })
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepCountdownSeconds: 60 })

  const state = fakeResponse()
  const sleep = routes.find((entry) => entry.path === SLEEP_PATH)
  sleep.handler(fakeRequest('GET'), state)
  await settle()
  assert.equal(JSON.parse(state.body).countdownSeconds, 60, 'the row outranks the file')
})

test('the pre-restart backup scope is written into the profile row', async () => {  const { file } = tempStateDir('backup-scope')
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

// ---------------------------------------------------------------------------
// THE PLUGIN-FILES WATCHDOG MUST BE SAVEABLE (bug, 2026-11-11).
//
// The settings page shows three controls for the plugin-files watchdog — the
// switch, the stable window and the upper bound — and posts them to
// `POST {prefix}/choice`. But the route did not know the three keys: a body
// that carried only them fell through to `no-choice` and answered `400`, and
// `persistConfigChoice` had no branch for them either, so even a body that
// carried something else dropped these three on the floor. The settings could
// not be saved at all.
// ---------------------------------------------------------------------------

test('the three plugin-files settings are written into the profile row', async () => {
  const { file } = tempStateDir('files-save')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', {
    pluginFilesWatch: false,
    pluginFilesStableMs: 30000,
    pluginFilesMaxBlockMs: 600000,
  }), res)
  await settle()

  assert.equal(res.statusCode, 200, 'the settings of the watchdog must be accepted')
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(edits.length, 1, 'the profile row must be edited exactly once')
  assert.equal(edits[0].next.pluginFilesWatch, false)
  assert.equal(edits[0].next.pluginFilesStableMs, 30000)
  assert.equal(edits[0].next.pluginFilesMaxBlockMs, 600000)
})

test('the Host reports the new plugin-files values back', async () => {
  const { file } = tempStateDir('files-readback')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const before = stateOf(routes).pluginFiles
  assert.equal(before.watched, true)
  assert.equal(before.stableMs, 15000)
  assert.equal(before.maxBlockMs, 300000)

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', {
    pluginFilesWatch: false,
    pluginFilesStableMs: 45000,
    pluginFilesMaxBlockMs: 120000,
  }), res)
  await settle()
  assert.equal(res.statusCode, 200)

  // The settings page reads these three fields back from the Host.
  const after = stateOf(routes).pluginFiles
  assert.equal(after.watched, false, 'the switch must be the new value')
  assert.equal(after.stableMs, 45000, 'the stable window must be the new value')
  assert.equal(after.maxBlockMs, 120000, 'the upper bound must be the new value')
})

test('a malformed plugin-files value is refused and NOTHING is written', async () => {
  const { file } = tempStateDir('files-refuse')
  const edits = []
  const { ctx, routes } = createContext({ services: { configEditor: createEditor(edits) } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  // A switch that is not a boolean.
  const notBoolean = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { pluginFilesWatch: 'yes' }), notBoolean)
  await settle()
  assert.equal(notBoolean.statusCode, 400)
  assert.match(String(JSON.parse(notBoolean.body).error), /pluginFilesWatch/)

  // A duration that is not a number.
  const notANumber = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { pluginFilesStableMs: 'soon' }), notANumber)
  await settle()
  assert.equal(notANumber.statusCode, 400)
  assert.match(String(JSON.parse(notANumber.body).error), /pluginFilesStableMs/)

  // A negative duration.
  const negative = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { pluginFilesMaxBlockMs: -1 }), negative)
  await settle()
  assert.equal(negative.statusCode, 400)
  assert.match(String(JSON.parse(negative.body).error), /pluginFilesMaxBlockMs/)

  assert.equal(edits.length, 0, 'a refused answer must not write anything')
  // And the configuration is untouched.
  const files = stateOf(routes).pluginFiles
  assert.equal(files.watched, true)
  assert.equal(files.stableMs, 15000)
  assert.equal(files.maxBlockMs, 300000)
})

test('a hand-edited profile row cannot break the watchdog', () => {
  const config = normalizeConfig({
    pluginFilesWatch: 'yes',
    pluginFilesStableMs: -5,
    pluginFilesMaxBlockMs: 'soon',
  })
  assert.equal(config.pluginFilesWatch, true, 'a switch that is not a boolean falls back to "watch"')
  assert.equal(config.pluginFilesStableMs, 15000, 'a negative duration falls back to the default')
  assert.equal(config.pluginFilesMaxBlockMs, 300000, 'a duration that is not a number falls back to the default')

  const clamped = normalizeConfig({ pluginFilesStableMs: 1234.7, pluginFilesMaxBlockMs: 90000.2 })
  assert.equal(clamped.pluginFilesStableMs, 1234, 'a duration is a whole number of milliseconds')
  assert.equal(clamped.pluginFilesMaxBlockMs, 90000)
})
