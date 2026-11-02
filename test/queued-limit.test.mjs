/**
 * Tests for the upper bound of a QUEUED inbox message, and for the long wait
 * that replaces the silent "we are still waiting" loop.
 *
 * THE DEFECT
 *
 * A queued message (an inbox entry nobody has claimed) used to block the
 * restart for EVER: the idle gate counted it as busy and the hard deadline
 * only warned. The real case was a fresh, empty conversation in the UI with
 * one unclaimed message in its inbox — the restart never fired.
 *
 * THE FIX (two halves)
 *
 *   1. a queued message only blocks the restart until the grace window
 *      (`queuedGraceMs`) is over; after that it is stuck, it stops blocking
 *      and the session that holds it is named in the log. A RUNNING session
 *      always blocks — under every grace setting;
 *   2. after the hard deadline the plugin does not pretend that everything is
 *      fine: it reports a LONG wait (a log line, rate limited, and a
 *      `longWait` block in the state payload) while KEEPING the user's restart
 *      request alive.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, DEFAULTS, normalizeConfig } from '../index.js'
import { createQueuedTracker, DEFAULT_QUEUED_GRACE_MS } from '../lib/queued.js'

const HEALTH_PATH = '/__dsh_autorestart/health'

/* ------------------------------------------------------------------ *
 * The tracker (lib/queued.js) — the pure policy.
 * ------------------------------------------------------------------ */

test('the queued grace is a config value with a default of one minute', () => {
  assert.equal(DEFAULT_QUEUED_GRACE_MS, 60000)
  assert.equal(DEFAULTS.queuedGraceMs, 60000, 'the default is one minute')
  assert.equal(normalizeConfig({}).queuedGraceMs, 60000)
  assert.equal(normalizeConfig({ queuedGraceMs: 5000 }).queuedGraceMs, 5000)
  assert.equal(normalizeConfig({ queuedGraceMs: 0 }).queuedGraceMs, 0)
  // A wrong or negative value falls back to the default.
  assert.equal(normalizeConfig({ queuedGraceMs: -1 }).queuedGraceMs, 60000)
  assert.equal(normalizeConfig({ queuedGraceMs: 'nonsense' }).queuedGraceMs, 60000)
  assert.equal(normalizeConfig({ queuedGraceMs: Number.NaN }).queuedGraceMs, 60000)
})

test('a message that is queued for 30 seconds still blocks the restart', () => {
  let clock = 1_000
  const tracker = createQueuedTracker({ now: () => clock })
  const first = tracker.observe('s1', true, 60000)
  assert.equal(first.blocking, true, 'a fresh queue blocks')
  assert.equal(first.becameStale, false)
  assert.equal(first.firstSeenAt, 1_000)

  clock += 30_000
  const later = tracker.observe('s1', true, 60000)
  assert.equal(later.blocking, true, 'thirty seconds is still inside the grace')
  assert.equal(later.becameStale, false)
  assert.equal(later.ageMs, 30_000)
  assert.equal(later.firstSeenAt, 1_000, 'the timer does not restart on every poll')
})

test('a message that stays queued past the grace stops blocking the restart', () => {
  let clock = 1_000
  const tracker = createQueuedTracker({ now: () => clock })
  tracker.observe('s1', true, 60000)

  clock += 60_000
  const stale = tracker.observe('s1', true, 60000)
  assert.equal(stale.blocking, false, 'the stuck message must not block the restart')
  assert.equal(stale.becameStale, true, 'the transition is reported once')
  assert.equal(stale.ageMs, 60_000)

  // The next poll says nothing new: the transition happened already.
  clock += 1_000
  const again = tracker.observe('s1', true, 60000)
  assert.equal(again.blocking, false)
  assert.equal(again.becameStale, false, 'the log must not repeat itself every poll')
})

test('a grace of zero keeps the old behaviour: a queued message blocks for ever', () => {
  let clock = 1_000
  const tracker = createQueuedTracker({ now: () => clock })
  tracker.observe('s1', true, 0)
  clock += 10 * 60_000
  const later = tracker.observe('s1', true, 0)
  assert.equal(later.blocking, true, 'without an upper bound the queue blocks for ever')
  assert.equal(later.becameStale, false, 'nothing is ever stale without an upper bound')
})

test('a session that is no longer queued loses its timer', () => {
  let clock = 1_000
  const tracker = createQueuedTracker({ now: () => clock })
  tracker.observe('s1', true, 60000)
  assert.equal(tracker.size(), 1)

  // The message was claimed: the record is dropped.
  tracker.observe('s1', false, 60000)
  assert.equal(tracker.size(), 0, 'the record of a drained queue is dropped')

  // A NEW queue counts from zero again.
  clock += 30_000
  const fresh = tracker.observe('s1', true, 60000)
  assert.equal(fresh.firstSeenAt, clock, 'the timer starts over')
  assert.equal(fresh.blocking, true)
})

/* ------------------------------------------------------------------ *
 * The Host half (index.js).
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-queued-${label}-`))
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
 * A fake Cordis context: the live agents, the timers, the tools and the
 * routes. The log lines are collected, so a test can assert what the plugin
 * said.
 */
function createContext({ agents = [], services = {} } = {}) {
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
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return {
    ctx,
    routes,
    timers,
    tools,
    logs,
    /** The log lines of one level. */
    said: (level) => logs.filter((entry) => entry.level === level).map((entry) => entry.text),
  }
}

/** A session with an unclaimed message in its inbox. */
function queuedAgent(id) {
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextTurn: [{ text: 'hello' }], nextStep: [] },
  }
}

/** A session that is working right now. */
function runningAgent(id) {
  return {
    id,
    status: 'running',
    session: { id },
    inbox: { nextTurn: [], nextStep: [] },
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

/** Fire the defer poller of the plugin (the tick of the restart gate). */
function fireDeferPoll(timers) {
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 250) timer.fn()
  }
}

test('a queued message blocks the restart inside the grace window', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext({ agents: [queuedAgent('sess-queued')] })
  apply(ctx, {
    stateFile: tempStateFile('inside'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
    queuedGraceMs: 60000,
  })

  const first = gateVerdictOf(routes)
  assert.equal(first.allowRestart, false, 'the queued message holds the restart back')
  assert.equal(first.gate.blockedBy.length, 1)
  assert.equal(first.gate.blockedBy[0].sessionId, 'sess-queued')
  assert.equal(first.gate.blockedBy[0].reason, 'queued')
  assert.equal(first.queuedGraceMs, 60000, 'the upper bound is reported')

  // Thirty seconds later it is still inside the grace window.
  clock.value += 30_000
  const later = gateVerdictOf(routes)
  assert.equal(later.allowRestart, false, 'thirty seconds is still inside the grace')
  assert.equal(later.gate.blockedBy[0].reason, 'queued')
})

test('a queued message that nobody claims stops blocking the restart and is named', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, said } = createContext({ agents: [queuedAgent('sess-stuck')] })
  apply(ctx, {
    stateFile: tempStateFile('stale'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
    queuedGraceMs: 60000,
  })

  // The first poll remembers the session.
  gateVerdictOf(routes)

  clock.value += 61_000
  const later = gateVerdictOf(routes)
  assert.equal(later.allowRestart, true, 'the stuck message must not hold the restart back')
  assert.deepEqual(later.gate.blockedBy, [], 'the stuck session is not a blocker any more')

  // The log says WHICH session holds the queue.
  const warnings = said('warn').filter((line) => line.includes('sess-stuck'))
  assert.equal(warnings.length, 1, `the stuck session must be named once: ${JSON.stringify(said('warn'))}`)
  assert.match(warnings[0], /no longer blocks the restart/, warnings[0])
})

test('without an upper bound a queued message blocks the restart for ever', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext({ agents: [queuedAgent('sess-queued')] })
  apply(ctx, {
    stateFile: tempStateFile('nograce'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
    queuedGraceMs: 0,
  })

  gateVerdictOf(routes)
  clock.value += 10 * 60_000
  const later = gateVerdictOf(routes)
  assert.equal(later.allowRestart, false, 'the old behaviour is kept when the bound is off')
  assert.equal(later.gate.blockedBy[0].sessionId, 'sess-queued')
  assert.equal(later.queuedGraceMs, 0)
})

test('a RUNNING session always blocks the restart, under every grace setting', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  for (const grace of [60000, 0, 1]) {
    const { ctx, routes } = createContext({ agents: [runningAgent('sess-busy')] })
    apply(ctx, {
      stateFile: tempStateFile(`running-${grace}`),
      recoveryDelayMs: 0,
      enabled: true,
      settleMs: 0,
      restartGraceMs: 0,
      queuedGraceMs: grace,
    })

    gateVerdictOf(routes)
    clock.value += 10 * 60_000
    const later = gateVerdictOf(routes)
    assert.equal(later.allowRestart, false, `a running session blocks (grace ${grace})`)
    assert.equal(later.gate.blockedBy.length, 1, `a running session is a blocker (grace ${grace})`)
    assert.equal(later.gate.blockedBy[0].reason, 'running', `the reason is "running" (grace ${grace})`)
  }
})

test('a session that starts working loses its queue timer and gets a new one', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const agent = queuedAgent('sess-mixed')
  const { ctx, routes } = createContext({ agents: [agent] })
  apply(ctx, {
    stateFile: tempStateFile('mixed'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
    queuedGraceMs: 60000,
  })

  // The queue starts counting.
  gateVerdictOf(routes)
  clock.value += 30_000

  // The session starts working: the message is claimed, so the timer of the
  // queue is dropped.
  agent.status = 'running'
  agent.inbox.nextTurn = []
  const working = gateVerdictOf(routes)
  assert.equal(working.allowRestart, false, 'a running session blocks')
  assert.equal(working.gate.blockedBy[0].reason, 'running')

  // The session is queued again: the timer starts from zero, so the message
  // blocks for another full grace window.
  clock.value += 10_000
  agent.status = 'idle'
  agent.inbox.nextTurn = [{ text: 'again' }]
  const requeued = gateVerdictOf(routes)
  assert.equal(requeued.allowRestart, false, 'the new queue blocks again')
  assert.equal(requeued.gate.blockedBy[0].reason, 'queued')

  // Sixty seconds after the NEW queue it is over — the old timer did not
  // carry over.
  clock.value += 60_000
  const stale = gateVerdictOf(routes)
  assert.equal(stale.allowRestart, true, 'the new queue had its own grace window')
  assert.deepEqual(stale.gate.blockedBy, [])
})

test('the state route reports the upper bound of a queued message', (t) => {
  patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('state'),
    recoveryDelayMs: 0,
    enabled: true,
    queuedGraceMs: 45000,
  })
  assert.equal(stateOf(routes).queuedGraceMs, 45000)
})

test('after the hard deadline the restart waits visibly and keeps the request', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, tools, timers, said } = createContext({ agents: [runningAgent('sess-hold')] })
  const file = tempStateFile('long-wait')
  apply(ctx, {
    stateFile: file,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
    deferPollMs: 250,
    deferSoftMs: 1000,
    deferHardMs: 2000,
    queuedGraceMs: 60000,
  })

  // The user asks for a restart.
  const restart = tools.find((tool) => tool.name === 'continuum_restart')
  assert.ok(restart, 'the continuum_restart tool must be registered')
  restart.execute({ reason: 'install the plugin update' }, { agent: { id: 'sess-hold', status: 'running' } })

  // The hard deadline is over: the tick reports a long wait.
  clock.value += 5000
  fireDeferPoll(timers)

  const warnings = said('warn').filter((line) => line.includes('still holds it'))
  assert.equal(warnings.length, 1, `the long wait must be logged once: ${JSON.stringify(said('warn'))}`)
  assert.match(warnings[0], /the restart has been waiting/, warnings[0])

  // The request is KEPT: nothing is cancelled and no requester is released.
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.notEqual(state.restart, null, 'the pending restart must survive the long wait')
  assert.equal(state.phase, 'deferred', 'the restart is still deferred, not given up')
  assert.equal(state.sessions['sess-hold'].pendingResume, true, 'the requester is not released')

  // The state payload says what is going on.
  const payload = stateOf(routes)
  assert.ok(payload.longWait, 'the state payload carries the long wait')
  assert.equal(payload.longWait.reason, 'waiting-for-conversations')
  assert.equal(typeof payload.longWait.since, 'number')
  assert.ok(payload.longWait.blockedBy.length >= 1, 'the long wait names the blocker')
  assert.equal(payload.longWait.blockedBy[0].sessionId, 'sess-hold')

  // The log is rate limited: the next tick (three seconds later) is quiet.
  clock.value += 3000
  fireDeferPoll(timers)
  const again = said('warn').filter((line) => line.includes('still holds it'))
  assert.equal(again.length, 1, 'the line must not repeat every poll')

  // A minute later it says it again — the wait is still going on.
  clock.value += 60_000
  fireDeferPoll(timers)
  const later = said('warn').filter((line) => line.includes('still holds it'))
  assert.equal(later.length, 2, 'the line comes back after a minute')
})

test('without a long wait the state payload carries none', (t) => {
  patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: tempStateFile('no-long-wait'), recoveryDelayMs: 0, enabled: true })
  assert.equal(stateOf(routes).longWait, null)
})

/* ------------------------------------------------------------------ *
 * The client half (client.js).
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
 * Load the classic client script in a sandbox and mount the pending-restart
 * pill, with the state payload the test wants.
 *
 * @param {{ state?: object, language?: string }} options
 */
function mountPill({ state = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const dictionaries = {}
  const slots = new Map()
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
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => state,
    }),
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
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

test('the bubble shows one more line while the restart waits for a long time', async () => {
  const mounted = mountPill({
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
      longWait: {
        since: 1_700_000_000_000,
        reason: 'waiting-for-conversations',
        waitedMs: 192_000,
        blockedBy: [{ sessionId: 'sess-hold', kind: 'session', label: '写代码', name: '写代码' }],
      },
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(pill, 'the pill must be rendered')
  const note = walk(pill).find((node) => node.props && node.props['data-dsh-autorestart-long-wait'] === 'true')
  assert.ok(note, 'the long wait must have its own line')
  const text = textOf(note)
  assert.match(text, /已等/, `the line says how long it waits: ${text}`)
  // The capsule is ONE clipped line: it quotes the duration in the compact
  // form and the COUNT of the tasks — never a name.
  assert.match(text, /3 分钟/, `the line quotes the duration: ${text}`)
  assert.match(text, /1 项任务在跑/, `the line counts the tasks: ${text}`)
  assert.doesNotMatch(text, /写代码/, `the line names no blocker: ${text}`)
  // The name is in the tooltip of the capsule.
  assert.match(note.props.title, /写代码/, `the tooltip names the blocker: ${note.props.title}`)
})

test('without a long wait the bubble shows no extra line', async () => {
  const mounted = mountPill({
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(pill, 'the pill must be rendered')
  const note = walk(pill).find((node) => node.props && node.props['data-dsh-autorestart-long-wait'] === 'true')
  assert.equal(note, undefined, 'there is no extra line without a long wait')
})

test('the long-wait line exists in both languages', async () => {
  const chinese = mountPill({
    language: 'zh',
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
      longWait: {
        since: 1,
        reason: 'waiting-for-conversations',
        waitedMs: 192_000,
        blockedBy: [{ sessionId: 'sess-hold', kind: 'session', label: '写代码', name: '写代码' }],
      },
    },
  })
  const zh = await chinese.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const zhText = textOf(walk(zh).find((node) => node.props && node.props['data-dsh-autorestart-long-wait'] === 'true'))

  const english = mountPill({
    language: 'en',
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
      longWait: {
        since: 1,
        reason: 'waiting-for-conversations',
        waitedMs: 192_000,
        blockedBy: [{ sessionId: 'sess-hold', kind: 'session', label: 'coding', name: 'coding' }],
      },
    },
  })
  const en = await english.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const enText = textOf(walk(en).find((node) => node.props && node.props['data-dsh-autorestart-long-wait'] === 'true'))

  assert.match(zhText, /[一-鿿]/, 'the Chinese line is Chinese')
  assert.match(enText, /[A-Za-z]/, 'the English line is English')
  assert.match(enText, /waiting for/, enText)
  assert.match(enText, /1 task\(s\) running/, enText)
  // The capsule names no blocker: the name is in the tooltip.
  assert.doesNotMatch(enText, /coding/, enText)
  const enNote = walk(en).find((node) => node.props && node.props['data-dsh-autorestart-long-wait'] === 'true')
  assert.match(enNote.props.title, /coding/, `the tooltip names the blocker: ${enNote.props.title}`)
})

test('the bubble says that it is waiting for the quiet window', async () => {
  const mounted = mountPill({
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
      // No blocker, but the gate is closed because the quiet window is not
      // full yet. The bubble must say that, not "waiting for N tasks".
      reason: 'settling',
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(pill, 'the pill must be rendered')
  const text = textOf(pill)
  assert.match(text, /还在等这段安静期/, `the bubble says what it waits for: ${text}`)
  assert.doesNotMatch(text, /等待 \d+ 个任务/, 'no conversation blocks the restart')
})

test('the bubble says that it waits for the other sessions when one blocks', async () => {
  const mounted = mountPill({
    state: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [{ sessionId: 'sess-hold', kind: 'session', label: '写代码', name: '写代码', reason: 'running' }],
      allowRestart: false,
      reason: 'conversation-active',
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(pill, 'the pill must be rendered')
  const text = textOf(pill)
  assert.match(text, /等待 1 个会话/, `the bubble counts the blocker: ${text}`)
  assert.doesNotMatch(text, /还在等这段安静期/, 'the quiet window is not the reason')
})
