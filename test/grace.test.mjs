/**
 * Tests for the grace window: the extra wait after the last conversation
 * finished, before the host is really RESTARTED.
 *
 * The plugin can only see the DSH agents. Other plugins (a memory plugin
 * that writes its notes a few seconds after the conversation ended, a
 * summary, an MCP callback) queue their work with a timer of their own —
 * work that is invisible here. Without a grace window the host may restart
 * right in the middle of that write.
 *
 * The grace window is therefore:
 *
 *   - a CONFIG value (`restartGraceMs`, default 0 seconds, offered as
 *     0 / 5 / 10 / 20 / 30 / 60 seconds);
 *   - honoured by the RESTART path only — the graceful shutdown has a
 *     VISIBLE countdown instead, and that countdown IS its wait;
 *   - anchored at the last observed conversation activity, so new activity
 *     during the wait starts the timer over;
 *   - reported by the status interfaces (`graceMs` + `quietForMs`).
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, DEFAULTS, normalizeConfig } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/**
 * The key of the shutdown reserve that no longer exists.
 *
 * It is built from two parts on purpose: the whole plugin must not mention
 * the key any more — the tests included — so the needle itself may not
 * appear in any file of this repository.
 */
const REMOVED_SHUTDOWN_KEY = ['sleep', 'GraceMs'].join('')

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-grace-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Replace `Date.now` with a clock the test drives.
 *
 * The gate, the quiet window and the grace all measure time with
 * `Date.now()`, so the test has to own the clock.
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
 * A fake Cordis context: the live agents, the timers, the event handlers and
 * the routes.
 */
function createContext({ agents = [], services = {} } = {}) {
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
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => agents, roots: () => agents, get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
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
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return {
    ctx,
    routes,
    timers,
    /** Fire every event handler of one event (the plugin's activity signal). */
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

/** What the restart gate answers right now. */
function gateVerdictOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(
    fakeRequest('GET', undefined, `${HEALTH_PATH}?gate=1`),
    res,
  )
  return JSON.parse(res.body)
}

/** What the state route answers right now. */
function stateOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(
    fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`),
    res,
  )
  return JSON.parse(res.body)
}

/** What the sleep route answers right now. */
function sleepStatusOf(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), res)
  return JSON.parse(res.body)
}

/** Arm the graceful shutdown. */
async function armSleep(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  return JSON.parse(res.body)
}

/** Fire every 1s timer of the plugin (the sleep controller ticks on them). */
function fireTicks(timers) {
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
}

test('the restart reserve has its own default', () => {
  // A restart is a daily operation, so no extra wait.
  assert.equal(DEFAULTS.restartGraceMs, 0, 'the restart reserve defaults to none')
  assert.equal(normalizeConfig({}).restartGraceMs, 0)
  // The shutdown has NO reserve of its own any more: its visible countdown
  // is the wait before the machine goes off.
  assert.equal(
    Object.prototype.hasOwnProperty.call(DEFAULTS, REMOVED_SHUTDOWN_KEY),
    false,
    'the removed shutdown reserve must not be a configuration key any more',
  )
  assert.equal(normalizeConfig({})[REMOVED_SHUTDOWN_KEY], undefined)
  // A hand-edited profile value is snapped onto the nearest offered choice.
  assert.equal(normalizeConfig({ restartGraceMs: 7000 }).restartGraceMs, 5000)
  assert.equal(normalizeConfig({ restartGraceMs: 20000 }).restartGraceMs, 20000)
  assert.equal(normalizeConfig({ restartGraceMs: 15000 }).restartGraceMs, 10000)
  assert.equal(normalizeConfig({ restartGraceMs: 0 }).restartGraceMs, 0)
  // A wrong value falls back to the default.
  assert.equal(normalizeConfig({ restartGraceMs: -1 }).restartGraceMs, 0)
  assert.equal(normalizeConfig({ restartGraceMs: 'nonsense' }).restartGraceMs, 0)
})

test('an old shutdown reserve in the profile is ignored', () => {
  // A profile that still carries the removed key must not break the boot —
  // and the key must not come back to life.
  const config = normalizeConfig({ restartGraceMs: 10000, [REMOVED_SHUTDOWN_KEY]: 60000 })
  assert.equal(config.restartGraceMs, 10000, 'the restart reserve keeps its own value')
  assert.equal(config[REMOVED_SHUTDOWN_KEY], undefined, 'the removed key stays gone')
  assert.equal(
    Object.keys(config).includes(REMOVED_SHUTDOWN_KEY),
    false,
    'the removed key must not appear in the effective configuration',
  )
})

test('without a grace the restart behaves exactly as before', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('no-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
  })

  const verdict = gateVerdictOf(routes)
  assert.equal(verdict.allowRestart, true, 'no extra wait')
  assert.equal(verdict.gate.reason, 'quiet')
  assert.equal(verdict.graceMs, 0)
})

test('with a grace of ten seconds the restart waits for it', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 10000,
  })

  // 9.9 seconds after the last conversation finished: too early.
  clock.value += 9900
  const early = gateVerdictOf(routes)
  assert.equal(early.allowRestart, false, 'the grace must hold the restart back')
  assert.equal(early.gate.reason, 'settling')
  assert.equal(early.gate.quietForMs, 9900)
  assert.equal(early.graceMs, 10000, 'the grace window is reported')
  assert.equal(early.effectiveSettleMs, 10000, 'the gate uses the longer window')

  // 10.1 seconds: the grace is over, the restart may go.
  clock.value += 200
  const late = gateVerdictOf(routes)
  assert.equal(late.allowRestart, true, 'the restart may fire once the grace is over')
  assert.equal(late.gate.reason, 'quiet')
  assert.equal(late.gate.quietForMs, 10100)
})

test('a heartbeat does not restart the grace window, but real work holds it back', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('reset'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 10000,
  })

  // FIVE SECONDS IN, the interface synchronises: `agent/status` fires. That is a
  // heartbeat, not work (user decision, 2026-11-02): it must NOT move
  // `lastActivityAt`, so the window keeps counting from the real activity.
  clock.value += 5000
  fire('agent/status', { agent: { id: 'sess-a' }, status: 'idle' })

  // Five seconds later the window is exactly ten seconds old - it filled, and the
  // heartbeat did not hold it open.
  clock.value += 5000
  const filled = gateVerdictOf(routes)
  assert.equal(filled.gate.quietForMs, 10000, 'the heartbeat must not re-arm the window')
  assert.equal(filled.allowRestart, true, 'so the grace is over and the restart may go')

  // THE OTHER DIRECTION: a conversation that is really running is work, and work
  // holds the restart back however long the window has been open.
  const busyClock = patchNow({ value: 1_700_000_000_000 }, t)
  const busy = createContext({ agents: [{ id: 'sess-busy', status: 'running' }] })
  apply(busy.ctx, {
    stateFile: tempStateFile('busy-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 10000,
    forceRestartWhenBusy: false,
  })

  busyClock.value += 30000
  const held = gateVerdictOf(busy.routes)
  assert.equal(held.allowRestart, false, 'a real turn must never be interrupted, whatever the grace says')
  assert.match(
    JSON.stringify(held.gate),
    /sess-busy/,
    'and the gate names the conversation that is working: ' + JSON.stringify(held.gate),
  )
})

test('the graceful shutdown goes straight into the countdown', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, timers } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('sleep-no-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    // The restart reserve is NOT the one the shutdown waits for — not even a
    // huge one: the visible countdown is the wait.
    restartGraceMs: 60000,
    sleepCountdownSeconds: 20,
  })

  const armed = await armSleep(routes)
  assert.equal(armed.phase, 'countdown', 'the countdown starts at once')
  assert.equal(armed.remainingMs, 20000, 'the whole countdown is there')
  assert.deepEqual(armed.blockers, [], 'nobody is busy')
  assert.doesNotMatch(armed.message, /再等/, 'the machine must not wait in silence')
  assert.match(armed.message, /倒数/, 'the machine counts down on screen')

  // A tick later it is still counting down — there is no hidden window.
  clock.value += 1000
  fireTicks(timers)
  const counting = sleepStatusOf(routes)
  assert.equal(counting.phase, 'countdown')
  assert.equal(counting.remainingMs, 19000)
})

test('the state route reports the grace and the quiet window', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('state'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
  })

  clock.value += 3000
  const state = stateOf(routes)
  assert.equal(state.graceMs, 10000)
  assert.equal(state.quietForMs, 3000)
  assert.equal(state.effectiveSettleMs, 10000, 'the grace is longer than the settle window')
  assert.equal(state.settleMs, 2000, 'the settle window is still reported')
})

test('the choice route takes the grace and refuses a value that is not offered', async () => {
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

  const res = fakeResponse()
  routeOf(routes, '/__dsh_autorestart/choice').handler(
    fakeRequest('POST', { restartGraceMs: 20000 }, '/__dsh_autorestart/choice'),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, applied: 'config', restartGraceMs: 20000 })
  assert.equal(edits.length, 1, 'the profile row must be edited exactly once')
  assert.equal(edits[0].restartGraceMs, 20000)

  // A value that is not offered is refused, and nothing is written.
  const refused = fakeResponse()
  routeOf(routes, '/__dsh_autorestart/choice').handler(
    fakeRequest('POST', { restartGraceMs: 7000 }, '/__dsh_autorestart/choice'),
    refused,
  )
  await settle()
  assert.equal(refused.statusCode, 400)
  assert.equal(JSON.parse(refused.body).ok, false)
  assert.equal(edits.length, 1, 'a refused answer must not write anything')
})

/* ------------------------------------------------------------------ *
 * The client half.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** A tiny React stand-in: enough for the classic client script. */
function createReactHarness() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []

  const slotAt = (index) => {
    while (hooks.length <= index) {
      hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return hooks[index]
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = { current: initial }
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }

  const render = (Component, props) => {
    cursor = 0
    pendingEffects = []
    const tree = Component(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const { slot, fn } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    }
    return tree
  }

  return { React, render }
}

/** Every node of a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/**
 * Load the classic client script in a sandbox and mount the settings section.
 *
 * @param {{ status?: object, language?: string }} options
 */
function mountSettings({ status = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const state = { status }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/choice') && init && init.body) {
        // The Host takes the answer and reports it back on the next poll —
        // under the names the status route uses (`restartGraceMs` and
        // `countdownSeconds`).
        const written = JSON.parse(init.body)
        const next = { ...(state.status || {}) }
        if (typeof written.restartGraceMs === 'number') next.restartGraceMs = written.restartGraceMs
        if (typeof written.sleepCountdownSeconds === 'number') next.countdownSeconds = written.sleepCountdownSeconds
        state.status = next
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, applied: 'config', ...written }),
        })
      }
      if (target.includes('/sleep')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => state.status || {} })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, choiceUrl: '/__dsh_autorestart/choice' }),
      })
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the client script must register itself with the module loader')

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)

  const dictionaries = {}
  const slots = new Map()
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (namespace, value) => {
        dictionaries[namespace] = value
      },
      bind: (namespace) => (key) => {
        const table = (dictionaries[namespace] || {})[language] || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      inject: (name, thunk) => {
        const list = slots.get(name) || []
        list.push(thunk)
        slots.set(name, list)
      },
      entries: () => [],
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  const componentOf = (id) => {
    for (const list of slots.values()) {
      for (const thunk of list) {
        const produced = thunk()
        const entry = (produced && typeof produced.next === 'function')
          ? produced.next().value
          : produced
        if (entry && entry.registration && entry.registration.id === id) return entry.Component
      }
    }
    assert.fail(`the component ${id} must be registered`)
  }

  return {
    dictionaries,
    fetches,
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
    render: (id, props) => harness.render(componentOf(id), props || {}),
  }
}

test('the settings section offers the restart wait and the shutdown countdown', async () => {
  const mounted = mountSettings({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 20,
      restartGraceMs: 0,
    },
  })

  const panel = await mounted.settled('dsh-autorestart')
  assert.ok(panel, 'the settings section must be rendered')

  // The groups, in this order: the restart settings come first, the shutdown
  // settings after them, then the supervisor (the self-start record), then
  // the rescue kit (the scripts for a host that does not come up) and finally
  // the "report a problem" group.
  const groups = walk(panel).filter(
    (node) => node.type === 'div' && typeof node.props['data-dsh-autorestart-group'] === 'string',
  )
  assert.deepEqual(
    groups.map((node) => node.props['data-dsh-autorestart-group']),
    ['restart', 'shutdown', 'supervisor', 'report'],
    'the restart group must come before the shutdown group',
  )
  assert.equal(textOf(groups[0].children[0]), '重启相关设置', 'the restart group has a visible title')
  assert.equal(textOf(groups[1].children[0]), '关机相关设置', 'the shutdown group has a visible title')
  assert.equal(textOf(groups[2].children[0]), '开机自启', 'the supervisor group has a visible title')
  assert.equal(textOf(groups[3].children[0]), '遇到问题', 'the report group has a visible title')

  // The restart group carries three controls, the shutdown group exactly one.
  const restartControls = walk(groups[0]).filter((node) => node.type === 'select' || node.type === 'input')
  assert.deepEqual(
    restartControls.map((node) => node.props['data-dsh-autorestart-setting']),
    ['restartGraceMs', 'backupOnRestart', 'backupIncludePlugins', 'maxBackups'],
    'the restart group carries the wait, the two backup switches and the copy limit',
  )
  const shutdownControls = walk(groups[1]).filter((node) => node.type === 'select' || node.type === 'input')
  assert.deepEqual(
    shutdownControls.map((node) => node.props['data-dsh-autorestart-setting']),
    ['sleepCountdownSeconds'],
    'the shutdown group carries the countdown',
  )

  const selects = walk(panel).filter((node) => node.type === 'select')
  const restart = selects.find((node) => node.props['data-dsh-autorestart-setting'] === 'restartGraceMs')
  const countdown = selects.find((node) => node.props['data-dsh-autorestart-setting'] === 'sleepCountdownSeconds')
  assert.ok(restart, 'the restart wait must have a dropdown')
  assert.ok(countdown, 'the shutdown countdown must have a dropdown')
  assert.equal(restart.props.value, '0', 'the restart wait of the Host is shown')
  assert.equal(countdown.props.value, '20', 'the countdown of the Host is shown')
  const options = walk(restart).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, ['0', '5', '10', '20', '30', '60'], 'the six offered windows')
  assert.deepEqual(
    walk(countdown).filter((node) => node.type === 'option').map((node) => node.props.value),
    ['0', '10', '20', '30', '60'],
    'the countdown offers its own five lengths',
  )

  // The two labels tell the two situations apart.
  const shown = textOf(panel)
  assert.match(shown, /重启前等待/, `the restart label must be there: ${shown}`)
  assert.match(shown, /关机倒数秒数/, `the shutdown label must be there: ${shown}`)
  assert.match(shown, /重启没有倒数环节/, `the restart hint must explain the restart: ${shown}`)
  assert.match(shown, /屏幕上会显示这段倒数/, `the shutdown hint must explain the countdown: ${shown}`)

  // Choosing another value writes it into the profile configuration.
  restart.props.onChange({ target: { value: '20' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1, 'the choice must be written once')
  assert.deepEqual(JSON.parse(posts[0].init.body), { restartGraceMs: 20000 })

  // And it is read back from the Host.
  const again = mounted.render('dsh-autorestart')
  const selectsAgain = walk(again).filter((node) => node.type === 'select')
  const restartAgain = selectsAgain.find((node) => node.props['data-dsh-autorestart-setting'] === 'restartGraceMs')
  assert.equal(restartAgain.props.value, '20', 'the new value is read back')
})

test('the copy of the settings lives in the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.ok(zh.settings.restartGrace, 'the zh locale must carry the restart texts')
  assert.ok(zh.settings.seconds, 'the zh locale must carry the countdown texts')
  assert.ok(en.settings.restartGrace, 'the en locale must carry the restart texts')
  assert.ok(en.settings.seconds, 'the en locale must carry the countdown texts')
  // The two group titles.
  assert.equal(zh.settings.groups.restart, '重启相关设置')
  assert.equal(zh.settings.groups.shutdown, '关机相关设置')
  assert.ok(en.settings.groups.restart, 'the en locale must carry the group titles')
  assert.ok(en.settings.groups.shutdown, 'the en locale must carry the group titles')
  // The two labels.
  assert.equal(zh.settings.restartGrace.label, '重启前等待')
  assert.equal(zh.settings.seconds.label, '关机倒数秒数')
  assert.match(zh.settings.restartGrace.hint, /重启没有倒数环节/, 'the zh restart copy must explain the restart')
  assert.match(zh.settings.seconds.hint, /屏幕上会显示这段倒数/, 'the zh countdown copy must explain the countdown')
  assert.match(en.settings.restartGrace.hint, /no countdown/, 'the en restart copy must explain the restart')
  assert.match(en.settings.seconds.hint, /countdown is shown on screen/, 'the en countdown copy must explain the countdown')
  // The removed shutdown reserve is gone from both locale files.
  assert.equal(
    Object.prototype.hasOwnProperty.call(zh.settings, 'sleepGrace'),
    false,
    'the zh locale must not carry the removed shutdown reserve',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(en.settings, 'sleepGrace'),
    false,
    'the en locale must not carry the removed shutdown reserve',
  )
})
