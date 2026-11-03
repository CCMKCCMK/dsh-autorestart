/**
 * t3 — ONE number on BOTH surfaces: the capsule and the panel it opens.
 *
 * THE DEFECT THE USER REPORTED (screenshot, 2026-10-29)
 *
 *     capsule: 待重启 · 空闲后自动重启  正在等待所有会话空闲…（还有 1 个会话在忙）
 *     panel:   这次重启还在等 0 个会话
 *
 * The real Host answered `GET /__dsh_autorestart/health?gate=1` with
 * `allowRestart=false busyCount=1 reason=conversation-active blockedBy=",,"`:
 * ONE task held the gate, and its blockers carried no readable name. The
 * capsule counted the blockers itself, the panel re-counted a FILTERED copy of
 * them (the own session dropped out, the nameless ones dropped out) — the same
 * pending restart was "1" on one line and "0" on the next.
 *
 * THE RULE THIS FILE PINS DOWN
 *
 *   1. one source: the Host publishes the count (`busyCount`) and BOTH surfaces
 *      read that value — a blocker without a readable name is still counted;
 *   2. no `,,`: an empty blocker never reaches the interface, and no surface
 *      renders an empty label;
 *   3. short copy: the panel says "还在等 N 个会话", the capsule "等待 N 个会话";
 *   4. the capsule opens THE panel, and that panel shows the same number.
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
import '../client.js'

const clientApi = globalThis.__dshAutorestartClient
assert.ok(clientApi, 'the client must publish its pure helpers on globalThis.__dshAutorestartClient')

/* ------------------------------------------------------------------ *
 * The shapes the Host really sends.
 * ------------------------------------------------------------------ */

/** The live blockers of the report: no name, no label — nothing to read. */
const NAMELESS = { sessionId: 'sess-other', reason: 'conversation-active', kind: 'session', label: '', name: '' }

/** One named blocking conversation. */
function named(sessionId, label) {
  return { sessionId, reason: 'conversation-active', kind: 'session', label, name: label }
}

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

/** The text leaves of a subtree, in order. */
function textLeaves(node, out = []) {
  if (!node || typeof node !== 'object') return out
  for (const child of node.children || []) {
    if (typeof child === 'string') out.push(child)
    else textLeaves(child, out)
  }
  return out
}

/** The CAPSULE of the composer row (not the panel that floats above it). */
function capsuleOf(pill) {
  return walk(pill).find((node) => node.props && node.props['aria-haspopup'] === 'dialog')
}

/** The copy of the capsule itself. */
function capsuleCopy(pill) {
  const capsule = capsuleOf(pill)
  return capsule ? textLeaves(capsule).join('') : ''
}

/** The panel of the capsule, if it is open. */
function panelOf(pill) {
  return walk(pill).find((node) => node.props && node.props['data-dsh-autorestart-panel'] === 'true')
}

/** A click event that stops the propagation (like the browser's). */
function clickEvent() {
  return { type: 'click', stopPropagation: () => {}, preventDefault: () => {} }
}

/** Mount the client with a state the Host reported. */
function mountClient(health) {
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
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => health }),
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
        const table = (dictionaries[namespace] || {}).zh || {}
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
    /** Render, let the shared poll deliver the payload, render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

/**
 * The state of every case below: THIS session asked for the restart.
 *
 * @param {object} overrides
 */
function pendingState(overrides = {}) {
  return {
    ok: true,
    pendingRestart: true,
    allowRestart: false,
    reason: 'conversation-active',
    waiters: ['sess-me'],
    blockedBy: [],
    cancelUrl: '/__dsh_autorestart/cancel',
    ...overrides,
  }
}

/** The number the panel claims to wait for ("还在等 N 个会话"). */
function panelCount(panel) {
  const text = textOf(panel)
  const match = /还在等 (\d+) 个会话/.exec(text)
  return match ? Number(match[1]) : null
}

/** The number the capsule claims to wait for ("等待 N 个会话"). */
function capsuleCount(pill) {
  const match = /等待 (\d+) 个会话/.exec(capsuleCopy(pill))
  return match ? Number(match[1]) : null
}

/** Open the panel the way a user does: a click on the capsule. */
async function openPanel(mounted, pill) {
  capsuleOf(pill).props.onClick(clickEvent())
  return mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
}

/* ------------------------------------------------------------------ *
 * The one source of the number.
 * ------------------------------------------------------------------ */

test('the Host number wins over a re-count of the blockers', () => {
  // The live payload: ONE task holds the gate, the blocker has no name at all.
  const info = pendingState({ busyCount: 1, blockedBy: ['', ''] })
  assert.equal(clientApi.waitingTaskCount(info, []), 1, 'the Host count is THE number')
  const nameless = pendingState({ busyCount: 1, blockedBy: [NAMELESS] })
  assert.equal(clientApi.waitingTaskCount(nameless), 1, 'a blocker without a name is still a task')
  // A payload of an older Host: no number, so the blockers are counted — on the
  // SAME list both surfaces use.
  const old = pendingState({ blockedBy: [named('a', '甲'), named('b', '乙')] })
  assert.equal(clientApi.waitingTaskCount(old, old.blockedBy), 2, 'without the Host number the list is counted')
  assert.equal(clientApi.waitingTaskCount(pendingState(), []), 0, 'nothing blocks, nothing is counted')
})

/* ------------------------------------------------------------------ *
 * ① busyCount=1 and a blockedBy full of empty strings: BOTH surfaces say 1.
 * ------------------------------------------------------------------ */

test('one busy task with unusable blockers is ONE on both surfaces', async () => {
  const mounted = mountClient(pendingState({ busyCount: 1, blockedBy: ['', '', NAMELESS] }))
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
  assert.ok(pill, 'the capsule must be shown while the restart waits')
  assert.equal(capsuleCount(pill), 1, `the capsule says ONE: ${capsuleCopy(pill)}`)

  const opened = await openPanel(mounted, pill)
  const panel = panelOf(opened)
  assert.ok(panel, 'the click opens the panel')
  assert.equal(panelCount(panel), 1, `the panel says ONE too: ${textOf(panel)}`)
  // The exact contradiction of the report: 1 next to 0.
  assert.notEqual(panelCount(panel), 0, 'the panel never says 0 while the capsule says 1')
  assert.equal(capsuleCount(opened), panelCount(panel), 'one number, two surfaces')
})

/* ------------------------------------------------------------------ *
 * ② blockedBy empty but busyCount=2: both surfaces say 2.
 * ------------------------------------------------------------------ */

test('an empty blocker list still shows the Host number — 2 on both surfaces', async () => {
  const mounted = mountClient(pendingState({ busyCount: 2, blockedBy: [] }))
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
  assert.equal(capsuleCount(pill), 2, `the capsule says TWO: ${capsuleCopy(pill)}`)

  const opened = await openPanel(mounted, pill)
  const panel = panelOf(opened)
  assert.ok(panel, 'the click opens the panel')
  assert.equal(panelCount(panel), 2, `the panel says TWO too: ${textOf(panel)}`)
  assert.equal(capsuleCount(opened), panelCount(panel), 'one number, two surfaces')
})

/* ------------------------------------------------------------------ *
 * ③ No ",," and no empty label, whatever the blockers look like.
 * ------------------------------------------------------------------ */

test('no surface renders an empty label or a bare ",,"', async () => {
  const cases = [
    pendingState({ busyCount: 1, blockedBy: ['', ''] }),
    pendingState({ busyCount: 2, blockedBy: [NAMELESS, NAMELESS] }),
    pendingState({ busyCount: 1, blockedBy: [named('a', '甲'), NAMELESS, ''] }),
    pendingState({ busyCount: 0, blockedBy: [] }),
  ]
  for (const health of cases) {
    const mounted = mountClient(health)
    const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
    assert.ok(pill, 'the capsule must be shown while the restart waits')
    const opened = await openPanel(mounted, pill)
    const panel = panelOf(opened)
    assert.ok(panel, 'the click opens the panel')
    for (const [surface, text] of [
      ['capsule', capsuleCopy(opened)],
      ['panel', textOf(panel)],
      ['tooltip', String(capsuleOf(opened).props.title || '')],
    ]) {
      assert.doesNotMatch(text, /,,/, `the ${surface} renders no ",,": ${text}`)
      assert.doesNotMatch(text, /、\s*、/, `the ${surface} renders no bare separator: ${text}`)
      assert.doesNotMatch(text, /：\s*(,|、|$)/, `the ${surface} renders no empty label: ${text}`)
    }
  }
})

/* ------------------------------------------------------------------ *
 * ④ The capsule and the panel take the number from the SAME place — and the
 *    capsule opens exactly that panel.
 * ------------------------------------------------------------------ */

test('the panel and the capsule always show the same number', async () => {
  for (const busyCount of [1, 2, 3]) {
    const mounted = mountClient(pendingState({ busyCount, blockedBy: [named('a', '甲'), NAMELESS] }))
    const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
    const opened = await openPanel(mounted, pill)
    const panel = panelOf(opened)
    assert.ok(panel, 'the capsule opens the panel')
    assert.equal(
      capsuleCount(opened),
      panelCount(panel),
      `the two surfaces must agree (busyCount=${busyCount}): ${capsuleCopy(opened)} / ${textOf(panel)}`,
    )
    assert.equal(panelCount(panel), busyCount, `the panel shows the Host number: ${textOf(panel)}`)
    // ④b: the copy is a SHORT sentence (≤12 characters), both surfaces.
    const panelSentence = /还在等 \d+ 个会话/.exec(textOf(panel))
    assert.ok(panelSentence, `the panel says what it waits for: ${textOf(panel)}`)
    assert.ok(panelSentence[0].length <= 12, `the panel sentence stays short: ${panelSentence[0]}`)
    const capsuleSentence = /等待 \d+ 个会话/.exec(capsuleCopy(opened))
    assert.ok(capsuleSentence, `the capsule says what it waits for: ${capsuleCopy(opened)}`)
    assert.ok(capsuleSentence[0].length <= 12, `the capsule sentence stays short: ${capsuleSentence[0]}`)
  }
})

test('a restart that waits for nobody shows no count on either surface', async () => {
  const mounted = mountClient(pendingState({ busyCount: 0, blockedBy: [] }))
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
  assert.equal(capsuleCount(pill), null, `the capsule claims no number: ${capsuleCopy(pill)}`)
  const opened = await openPanel(mounted, pill)
  const panel = panelOf(opened)
  assert.ok(panel, 'the click opens the panel')
  assert.equal(panelCount(panel), null, `the panel claims no number either: ${textOf(panel)}`)
  assert.doesNotMatch(textOf(panel), /还在等 0 个会话/, 'nobody is written as words, not as a zero')
})

/* ------------------------------------------------------------------ *
 * The Host half: the `?state=1` route the two surfaces actually poll.
 * ------------------------------------------------------------------ */

/** A temporary state file (the plugin writes its checkpoint there). */
function tempStateFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-count-')), name + '.json')
}

/** A running conversation (no title: the Host cannot name it). */
function runningSession(id) {
  return { id, status: 'running', session: { id }, inbox: { nextStep: [], nextTurn: [] } }
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

test('the state route publishes the ONE number the two surfaces read', () => {
  const file = tempStateFile('state-busy-count')
  const { ctx, routes } = createHostContext([runningSession('sess-a'), runningSession('sess-b')])
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.busyCount, 2, 'the state route carries the Host count the panel and the capsule read')
  assert.equal(payload.blockedBy.length, 2, 'both blockers are reported')
  for (const entry of payload.blockedBy) {
    assert.equal(typeof entry, 'object', 'a blocker is an object, never an empty string')
    assert.notEqual(entry, null, 'a blocker is an object, never a null')
  }
  // The same number the gate route reports: one fact, two routes.
  const gate = fakeResponse()
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, gate)
  assert.equal(JSON.parse(gate.body).busyCount, payload.busyCount, 'the two routes agree on the count')
})
