/**
 * Tests for the readable identity of the things that block a restart.
 *
 * The user reported two things in the "pending restart" pill:
 *
 *   1. the count said "3 conversations" while some of them were SUBAGENTS
 *      (a subagent has no title of its own, so it showed up as `session-xxxx`);
 *   2. "conversation" is the wrong word: what is waited for are TASKS.
 *
 * So the Host now tells the client WHAT blocks the restart (`kind`: a session
 * or a subagent) and HOW it is called (`label`: the title of the session, or
 * of the session that created the subagent) — and the copy talks about tasks.
 * The DECISION is unchanged: a subagent still blocks the restart, and an idle
 * conversation still does not count.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-blocker-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context: the live agents, the titles of the sessions and the
 * routes the plugin registers.
 */
function createContext({ agents = [], titles = {} } = {}) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const sessionController = {
    list: () => ({
      items: Object.entries(titles).map(([id, title]) => ({ id, title })),
    }),
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents.filter((agent) => agent && agent.origin !== 'subagent'),
      get: (id) => agents.find((agent) => String(agent.id) === String(id)),
    },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'sessionController') return sessionController
      return undefined
    },
  }
  return { ctx, routes }
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

/** The blocking sessions the health route reports. */
async function blockedByOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(
    fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`),
    res,
  )
  await settle()
  return JSON.parse(res.body).blockedBy
}

/** The blockers the sleep route reports. */
async function sleepBlockersOf(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), res)
  await settle()
  return JSON.parse(res.body).blockers
}

test('a busy session blocks with its kind and its title', async () => {
  const { ctx, routes } = createContext({
    agents: [{ id: 'sess-a', status: 'running' }],
    titles: { 'sess-a': '写代码的会话' },
  })
  apply(ctx, { stateFile: tempStateFile('session'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].kind, 'session')
  assert.equal(blocked[0].label, '写代码的会话')
  assert.equal(blocked[0].name, '写代码的会话')
  assert.equal(blocked[0].reason, 'running')
})

test('a subagent is named after the session that created it, never after its id', async () => {
  const { ctx, routes } = createContext({
    agents: [
      { id: 'sess-parent', status: 'idle' },
      { id: 'sess-child', status: 'running', origin: 'subagent', parentId: 'sess-parent' },
    ],
    titles: { 'sess-parent': '写代码的会话', 'sess-child': '' },
  })
  apply(ctx, { stateFile: tempStateFile('subagent'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  assert.equal(blocked.length, 1, 'the idle parent does not block, the subagent does')
  assert.equal(blocked[0].kind, 'subagent')
  assert.equal(blocked[0].sessionId, 'sess-child')
  // The label is the title of the session that created it...
  assert.equal(blocked[0].label, '写代码的会话')
  assert.equal(blocked[0].parentTitle, '写代码的会话')
  assert.equal(blocked[0].parentSessionId, 'sess-parent')
  // ...and the full name says what it is.
  assert.equal(blocked[0].name, '写代码的会话的子智能体')
  for (const value of [blocked[0].label, blocked[0].name, blocked[0].title]) {
    assert.doesNotMatch(String(value), /sess-child/, 'a raw session id must never be shown')
  }
})

test('a subagent without a known parent title is called a subagent', async () => {
  const { ctx, routes } = createContext({
    agents: [
      { id: 'sess-child', status: 'running', origin: 'subagent', parentId: 'sess-gone' },
    ],
    titles: {},
  })
  apply(ctx, { stateFile: tempStateFile('orphan'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].kind, 'subagent')
  assert.equal(blocked[0].label, null)
  assert.equal(blocked[0].name, '子智能体')
  assert.doesNotMatch(blocked[0].name, /sess-/, 'a raw session id must never be shown')
})

test('the subagent of a session header is recognized as well', async () => {
  // The agent carries its session header: `origin` there is the marker, and
  // `parentSession` is the session that created it.
  const { ctx, routes } = createContext({
    agents: [{
      id: 'sess-child',
      status: 'running',
      session: { header: { origin: 'subagent', parentSession: 'sess-parent' } },
    }],
    titles: { 'sess-parent': '调研的会话' },
  })
  apply(ctx, { stateFile: tempStateFile('header'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].kind, 'subagent')
  assert.equal(blocked[0].label, '调研的会话')
  assert.equal(blocked[0].name, '调研的会话的子智能体')
})

test('a forked session is a top-level session, not a subagent', async () => {
  // A fork also carries a parent session, but its origin is empty: it is an
  // ordinary conversation and must not be called a subagent.
  const { ctx, routes } = createContext({
    agents: [{
      id: 'sess-fork',
      status: 'running',
      session: { header: { origin: '', parentSession: 'sess-parent' } },
    }],
    titles: { 'sess-fork': '分叉出来的会话' },
  })
  apply(ctx, { stateFile: tempStateFile('fork'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].kind, 'session')
  assert.equal(blocked[0].label, '分叉出来的会话')
})

test('the decision is unchanged: subagents block, idle conversations do not', async () => {
  const { ctx, routes } = createContext({
    agents: [
      { id: 'sess-idle', status: 'idle' },
      { id: 'sess-queued', status: 'idle', inbox: { nextTurn: [{ id: 'm1' }], nextStep: [] } },
      { id: 'sess-child', status: 'running', origin: 'subagent', parentId: 'sess-idle' },
    ],
    titles: { 'sess-idle': '空闲的会话' },
  })
  apply(ctx, { stateFile: tempStateFile('decision'), recoveryDelayMs: 0, enabled: true })

  const blocked = await blockedByOf(routes)
  const ids = blocked.map((entry) => entry.sessionId).sort()
  assert.deepEqual(ids, ['sess-child', 'sess-queued'], 'the idle session must not count')
  assert.equal(blocked.find((entry) => entry.sessionId === 'sess-child').kind, 'subagent')
  assert.equal(blocked.find((entry) => entry.sessionId === 'sess-queued').kind, 'session')
})

test('the sleep route reports the same kind and label', async () => {
  const { ctx, routes } = createContext({
    agents: [
      { id: 'sess-parent', status: 'idle' },
      { id: 'sess-child', status: 'running', origin: 'subagent', parentId: 'sess-parent' },
    ],
    titles: { 'sess-parent': '写代码的会话' },
  })
  apply(ctx, { stateFile: tempStateFile('sleep'), recoveryDelayMs: 0, enabled: true })

  // Arming the shutdown asks the gate: the subagent blocks it.
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  const payload = JSON.parse(res.body)

  assert.equal(payload.phase, 'waiting')
  const blockers = payload.blockers
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].kind, 'subagent')
  assert.equal(blockers[0].label, '写代码的会话')
  assert.equal(blockers[0].name, '写代码的会话的子智能体')
  assert.doesNotMatch(blockers[0].title, /sess-child/, 'a raw session id must never be shown')
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
 * Load the classic client script in a sandbox and mount one surface.
 *
 * @param {{ health?: object, status?: object, language?: string }} options
 */
function mountClient({ health = {}, status = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
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
      const target = String(url)
      const body = target.includes('/sleep') ? status : health
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
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
      // The entries other plugins registered in the slot before this one.
      entries: () => [],
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  /** The component registered under one id. */
  const componentOf = (id) => {
    for (const list of slots.values()) {
      for (const thunk of list) {
        const produced = thunk()
        // A thunk may be a GENERATOR (the settings section is): its first
        // yield is the registration.
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
    /** Render, let the shared poll deliver the payload, render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

test('the pill counts TASKS, not conversations', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      allowRestart: false,
      waiters: ['sess-waiting'],
      blockedBy: [
        { sessionId: 'sess-a', kind: 'session', label: '写代码', reason: 'running' },
        // A subagent of that very session: the label of a subagent IS the
        // title of the session that created it.
        { sessionId: 'sess-child', kind: 'subagent', label: '写代码', reason: 'running' },
        { sessionId: 'sess-b', kind: 'session', label: '调研', reason: 'queued' },
      ],
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-waiting' })
  assert.ok(pill, 'the pill must be shown while the restart waits')
  const text = textOf(pill)
  // TWO tasks: the session "写代码" and its own subagent are ONE task (the
  // sidebar counts them once), plus the session "调研".
  assert.match(text, /等待 2 个会话/, `the pill must count the tasks: ${text}`)
  assert.doesNotMatch(text, /等待 3 个会话/, 'a session and its own subagent are one task')
  assert.doesNotMatch(text, /会话占用/, 'the old wording must be gone')
  // The counted UNIT is still a task (a session and its own subagent are one),
  // and the sentence is the SHORT one: what must stay gone is the long line of
  // the composer row that was clipped away ("正在等待所有会话空闲…（还有 N 个会话在忙）").
  // t3 (2026-10-29) fixed the wording of the count to the user's own words —
  // "等待 N 个会话" on the capsule, "还在等 N 个会话" on its panel — so the bare
  // word 会话 is no longer banned; the LONG sentence still is.
  assert.doesNotMatch(text, /还有 \d+ 个会话在忙/, 'the old long sentence of the composer row is gone')
  assert.doesNotMatch(text, /正在等待所有会话空闲/, 'the old long sentence is gone')
})

test('the pill counts one task and no task the same way', async () => {
  const one = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      allowRestart: false,
      waiters: ['sess-waiting'],
      blockedBy: [{ sessionId: 'sess-a', kind: 'session', label: '写代码', reason: 'running' }],
    },
  })
  const onePill = await one.settled('autorestart-restart-pill', { sessionId: 'sess-waiting' })
  assert.match(textOf(onePill), /等待 1 个会话/)

  const none = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      allowRestart: true,
      waiters: ['sess-waiting'],
      blockedBy: [],
    },
  })
  const nonePill = await none.settled('autorestart-restart-pill', { sessionId: 'sess-waiting' })
  assert.match(textOf(nonePill), /空闲后自动重启/, 'without a blocker the pill says it is idle')
  assert.doesNotMatch(textOf(nonePill), /等待 \d+ 个会话/)
})

test('the waiting card tells a session and a subagent apart', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: [
        { sessionId: 'sess-a', kind: 'session', label: '写代码', name: '写代码', title: '写代码' },
        {
          sessionId: 'sess-child',
          kind: 'subagent',
          label: '写代码',
          name: '写代码的子智能体',
          title: '写代码',
        },
      ],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  assert.ok(card, 'the waiting card must be shown')
  const text = textOf(card)
  assert.match(text, /会话「写代码」正在运行/, `the session must be named: ${text}`)
  assert.match(text, /写代码的子智能体正在运行/, `the subagent must be named: ${text}`)
  assert.doesNotMatch(text, /子智能体（/, 'the subagent is not an annotation')
  assert.doesNotMatch(text, /sess-/, 'a raw session id must never be shown')
  // The count is about tasks: the session and its own subagent are ONE task
  // (the sidebar counts them once). And that task is not a "subagent task":
  // the session itself works, so the card has nothing to add.
  assert.match(text, /还有 1 个任务在干活/, `the count must talk about tasks: ${text}`)
  assert.doesNotMatch(text, /其中 \d+ 个是子智能体/, `the task is the session itself: ${text}`)
})

test('the waiting card says nothing about subagents when there are none', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: [{ sessionId: 'sess-a', kind: 'session', label: '写代码', title: '写代码' }],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const text = textOf(card)
  assert.match(text, /还有 1 个任务在干活/)
  assert.doesNotMatch(text, /子智能体/, 'there is no subagent to mention')
})

test('a blocker without a name still gets a line', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: [
        { sessionId: 'sess-a', kind: 'session', label: null },
        { sessionId: 'sess-child', kind: 'subagent', label: null },
      ],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const text = textOf(card)
  assert.match(text, /有一个任务正在运行/, `the session needs a line: ${text}`)
  assert.match(text, /有一个子智能体正在运行/, `the subagent needs a line: ${text}`)
  assert.doesNotMatch(text, /sess-/, 'a raw session id must never be shown')
  assert.doesNotMatch(text, /会话「会话」/, 'a generic name must never be shown as a title')
})

test('the card never shows a list of generic names', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      message: '等 3 个任务收工，收工后开始倒数。',
      blockers: [
        { sessionId: 'sess-a', kind: 'session', label: null, name: '' },
        { sessionId: 'sess-b', kind: 'session', label: null, name: '' },
        { sessionId: 'sess-c', kind: 'session', label: null, name: '' },
      ],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const text = textOf(card)
  assert.doesNotMatch(text, /（会话、会话/, 'a list of generic names looks like a bug')
  assert.doesNotMatch(text, /会话「会话」/, 'a generic name is not a title')
  assert.match(text, /还有 3 个任务在干活/, `the count is still there: ${text}`)
})

test('the copy of the card lives in the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.match(zh.sleep.waiting.count, /任务/, 'the zh copy must count tasks')
  assert.match(en.sleep.waiting.count, /task/, 'the en copy must count tasks')
  assert.ok(zh.sleep.waiting.subagents, 'the zh copy must mention the subagents')
  assert.ok(en.sleep.waiting.subagents, 'the en copy must mention the subagents')
  assert.doesNotMatch(zh.sleep.waiting.count, /会话/, 'the zh copy must not count conversations')
  assert.doesNotMatch(en.sleep.waiting.count, /session/, 'the en copy must not count conversations')
})
