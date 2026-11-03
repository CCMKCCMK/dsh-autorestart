/**
 * t6 — the task count of the pending-restart bubble.
 *
 * THE DEFECT THE USER REPORTED
 *
 * The left sidebar showed TWO busy conversations and the bubble said
 * "waiting for 3 tasks to finish". The live data explains it:
 *
 *     blockedBy: [1] session  (父会话 A)
 *                [2] subagent (父 = A)
 *                [3] subagent (父 = B)
 *
 * The bubble counted every BLOCKER, so a parent session and its own subagent
 * were counted twice. A subagent belongs to the session that spawned it, so
 * the sidebar counts them once — and so does the bubble.
 *
 * THE RULE (one rule, four surfaces)
 *
 *   - a session is a task of its own;
 *   - a subagent belongs to the session that created it, so a parent and its
 *     subagents are ONE task;
 *   - a subagent whose parent is only known by its TITLE joins the session
 *     with that title (the shutdown card reports the title but no id);
 *   - a subagent with no known parent is a task of its own;
 *   - a pending restart is not a task.
 *
 * The four surfaces that must agree:
 *
 *   1. the capsule ("等待 N 个会话");
 *   2. the long wait ("N 项任务在跑");
 *   3. the shutdown card ("还有 N 个任务在干活");
 *   4. the `busyCount` the Host reports on its gate route.
 *
 * THE TWO HALVES
 *
 * `lib/blockers.js` is the host half; `client.js` is the browser half (a
 * CLASSIC script cannot import an ES module). They MUST agree — the last
 * test of this file runs the same cases through both.
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
import {
  blockerTaskKeys,
  countBlockerTasks,
  countSubagentTasks,
} from '../lib/blockers.js'

// The client script is a CLASSIC script: it publishes its pure helpers on the
// global namespace as soon as it is evaluated.
import '../client.js'

const clientApi = globalThis.__dshAutorestartClient
assert.ok(clientApi, 'the client must publish its pure helpers on globalThis.__dshAutorestartClient')

/* ------------------------------------------------------------------ *
 * The shapes the Host really sends.
 * ------------------------------------------------------------------ */

/** A blocking session — shape A (the gate). */
function session(sessionId, label) {
  return {
    sessionId,
    reason: 'running',
    kind: 'session',
    label,
    name: label,
    parentTitle: null,
    parentSessionId: null,
  }
}

/** A blocking subagent — shape A (the gate): the parent is known by its id. */
function subagent(sessionId, parentSessionId, parentTitle) {
  return {
    sessionId,
    reason: 'running',
    kind: 'subagent',
    label: parentTitle,
    name: `${parentTitle}的子智能体`,
    parentTitle,
    parentSessionId,
  }
}

/** The same subagent in shape B (the shutdown card): NO `parentSessionId`. */
function cardSubagent(sessionId, parentTitle) {
  return {
    sessionId,
    kind: 'subagent',
    label: parentTitle,
    name: `${parentTitle}的子智能体`,
    parentTitle,
    title: parentTitle,
  }
}

/**
 * THE LIVE DATA of the report: a session, its own subagent and a subagent of
 * another session.
 */
const LIVE_BLOCKERS = [
  session('sess-a', '父会话A'),
  subagent('sess-child-a', 'sess-a', '父会话A'),
  subagent('sess-child-b', 'sess-b', '父会话B'),
]

/* ------------------------------------------------------------------ *
 * The rule itself.
 * ------------------------------------------------------------------ */

test('one parent and two subagents of two parents are TWO tasks', () => {
  assert.equal(countBlockerTasks(LIVE_BLOCKERS), 2, 'the parent and its own subagent are one task')
  assert.equal(
    countBlockerTasks([
      subagent('child-1', 'sess-a', '写代码'),
      subagent('child-2', 'sess-a', '写代码'),
      subagent('child-3', 'sess-b', '保险库'),
    ]),
    2,
    'two parents are two tasks, however many children they have',
  )
})

test('three subagents of ONE session are ONE task', () => {
  assert.equal(
    countBlockerTasks([
      subagent('child-1', 'sess-a', '写代码'),
      subagent('child-2', 'sess-a', '写代码'),
      subagent('child-3', 'sess-a', '写代码'),
    ]),
    1,
    'the team of one session is one task',
  )
})

test('three plain conversations are THREE tasks', () => {
  assert.equal(
    countBlockerTasks([
      session('sess-a', '会话一'),
      session('sess-b', '会话二'),
      session('sess-c', '会话三'),
    ]),
    3,
    'a conversation is a task of its own',
  )
})

test('a subagent whose parent is only known by its TITLE joins that session', () => {
  // Shape B: the card reports the parent's title but no id.
  const blockers = [
    session('sess-a', '写代码'),
    cardSubagent('child-1', '写代码'),
    cardSubagent('child-2', '写代码'),
  ]
  assert.equal(countBlockerTasks(blockers), 1, 'the title is enough to find the parent')
})

test('a subagent with no known parent is a task of its own', () => {
  assert.equal(
    countBlockerTasks([
      { sessionId: 'child-1', kind: 'subagent', label: null, name: '', parentTitle: null },
      { sessionId: 'child-2', kind: 'subagent', label: null, name: '', parentTitle: null },
    ]),
    2,
    'an orphan cannot be merged into anything',
  )
})

test('a pending restart is not a task', () => {
  assert.equal(
    countBlockerTasks([
      session('sess-a', '写代码'),
      { sessionId: 'restart-1', kind: 'restart-pending', label: null, name: '' },
    ]),
    1,
    'the pending restart is what the shutdown waits for, not a task of its own',
  )
})

test('only the tasks carried by subagents ALONE are counted as subagent tasks', () => {
  // The live data: the parent A works itself, the parent B only has a
  // subagent at work.
  assert.equal(countSubagentTasks(LIVE_BLOCKERS), 1, 'only the task of B is a subagent task')
  assert.equal(
    countSubagentTasks([
      session('sess-a', '写代码'),
      subagent('child-1', 'sess-a', '写代码'),
    ]),
    0,
    'a session that works itself is not a subagent task',
  )
})

/* ------------------------------------------------------------------ *
 * The browser half: the same rule, the same answers.
 * ------------------------------------------------------------------ */

test('the host and the browser count the same tasks', () => {
  const cases = [
    LIVE_BLOCKERS,
    [session('sess-a', '写代码'), subagent('child-1', 'sess-a', '写代码'), session('sess-b', '调研')],
    [session('sess-a', '写代码'), cardSubagent('child-1', '写代码')],
    [session('sess-a', '写代码'), session('sess-b', '调研'), session('sess-c', '发版')],
    [{ sessionId: 'child-1', kind: 'subagent', label: null, name: '' }],
    [],
  ]
  for (const blockers of cases) {
    assert.deepEqual(
      clientApi.blockerTaskKeys(blockers),
      blockerTaskKeys(blockers),
      `the two halves must give the same keys: ${JSON.stringify(blockers)}`,
    )
    assert.equal(
      clientApi.countBlockerTasks(blockers),
      countBlockerTasks(blockers),
      `the two halves must count the same: ${JSON.stringify(blockers)}`,
    )
    assert.equal(
      clientApi.countSubagentTasks(blockers),
      countSubagentTasks(blockers),
      `the two halves must count the subagent tasks the same: ${JSON.stringify(blockers)}`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * The browser surfaces.
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
    fetch: (url) => {
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
    /** Render, let the shared poll deliver the payload, render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

test('the capsule counts the tasks, not the blockers', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      allowRestart: false,
      waiters: ['sess-waiting'],
      blockedBy: LIVE_BLOCKERS,
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-waiting' })
  assert.ok(pill, 'the capsule must be shown while the restart waits')
  const text = textOf(pill)
  assert.match(text, /等待 2 个会话/, `the capsule counts the tasks: ${text}`)
  assert.doesNotMatch(text, /等待 3 个会话/, 'the parent and its own subagent are one task')
})

test('the long wait counts the same tasks', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-waiting'],
      blockedBy: [],
      allowRestart: false,
      longWait: {
        since: 1_700_000_000_000,
        reason: 'hard-deadline-waiting-for-conversations',
        waitedMs: 1_504_000,
        blockedBy: LIVE_BLOCKERS,
      },
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-waiting' })
  const text = textOf(pill)
  assert.match(text, /已等 25 分钟/, `the capsule says the duration: ${text}`)
  assert.match(text, /2 项任务在跑/, `the long wait counts the tasks: ${text}`)
})

test('the shutdown card counts the same tasks', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: LIVE_BLOCKERS,
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  assert.ok(card, 'the waiting card must be shown')
  const text = textOf(card)
  assert.match(text, /还有 2 个任务在干活/, `the card counts the tasks: ${text}`)
  // Only the task of the parent B is carried by a subagent ALONE.
  assert.match(text, /其中 1 个是子智能体/, `the subagent tasks are counted: ${text}`)
})

/* ------------------------------------------------------------------ *
 * The Host side: the `busyCount` of the gate route.
 * ------------------------------------------------------------------ */

/** A temporary state file (the plugin writes its checkpoint there). */
function tempStateFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-task-'))
  return path.join(dir, name + '.json')
}

/** A running conversation. */
function runningSession(id) {
  return { id, status: 'running', session: { id }, inbox: { nextStep: [], nextTurn: [] } }
}

/** A running subagent of a session. */
function runningSubagent(id, parentId) {
  return {
    id,
    status: 'running',
    origin: 'subagent',
    parentId,
    session: { id, header: { origin: 'subagent', parentSession: parentId } },
    inbox: { nextStep: [], nextTurn: [] },
  }
}

/** A fake Cordis context that records the routes. */
function createHostContext(agents) {
  const routes = []
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
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((agent) => String(agent.id) === String(id)),
    },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes }
}

/** Minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

test('the Host counts the tasks on its gate route too', () => {
  const file = tempStateFile('busy-count')
  const { ctx, routes } = createHostContext([
    runningSession('sess-a'),
    runningSubagent('sess-child-a', 'sess-a'),
    runningSubagent('sess-child-b', 'sess-b'),
  ])
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.gate.blockedBy.length, 3, 'three blockers are reported')
  assert.equal(payload.busyCount, 2, 'but they are TWO tasks: the parent and its subagent are one')
})
