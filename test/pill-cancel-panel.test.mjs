/**
 * The manual cancel of the pending-restart capsule.
 *
 * The capsule is 22px high and ONE line wide: a name in it is a name that
 * gets clipped away, and "double click to cancel" would be a hint the
 * capsule has no room for. So:
 *
 *   - clicking the capsule opens a small panel (the status of the pending
 *     restart + the way out of it); a DOUBLE click is only an ALIAS for that
 *     panel and NEVER cancels anything;
 *   - the panel's button opens a CONFIRMATION (no timeout, no countdown);
 *     only the confirmation sends the request;
 *   - the request withdraws THIS session's own restart request (the Host's
 *     `/cancel` route, `scope: "mine"`): the other sessions keep theirs;
 *   - the capsule's own text never carries a hint ("双击", "取消", …): the
 *     panel is the discoverability.
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
// The client script publishes its pure helpers on the global namespace.
import '../client.js'

// ------------------------------------------------------------------ *
// The client half.
// ------------------------------------------------------------------ */

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

/** The CAPSULE (not the panel that floats above it). */
function capsuleOf(pill) {
  return walk(pill).find((node) => node.props && node.props['aria-haspopup'] === 'dialog')
}

/** The copy of the capsule itself. */
function capsuleCopy(pill) {
  return textLeaves(capsuleOf(pill)).join('')
}

/** The panel of the capsule, if it is open. */
function panelOf(pill) {
  return walk(pill).find((node) => node.props && node.props['data-dsh-autorestart-panel'] === 'true')
}

/** The confirmation box inside the panel, if it is open. */
function confirmOf(pill) {
  return walk(pill).find((node) => node.props && node.props['data-dsh-autorestart-confirm'] === 'true')
}

/** The button whose text is `label`. */
function buttonWithText(pill, label) {
  return walk(pill).find((node) => node.type === 'button' && textOf(node).trim() === label)
}

/**
 * Mount the client with a mutable state and a recording fetch.
 *
 * The `/cancel` route answers with `cancelAnswer` (the tests change it), the
 * health route with `health`.
 *
 * @param {{ health?: object, cancelAnswer?: object, language?: string }} options
 */
function mountClient({ health = {}, cancelAnswer = null, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const dictionaries = {}
  const slots = new Map()
  const requests = []
  const documentListeners = new Map()
  const state = {
    health: { ...health },
    cancel: cancelAnswer || { ok: true, cancelled: false, remainingRequesters: 1, sessionId: 'sess-x' },
  }

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
      // The outside-click listener of the panel.
      addEventListener: (name, handler) => {
        if (!documentListeners.has(name)) documentListeners.set(name, new Set())
        documentListeners.get(name).add(handler)
      },
      removeEventListener: (name, handler) => {
        const set = documentListeners.get(name)
        if (set) set.delete(handler)
      },
    },
    fetch: (url, options) => {
      const target = String(url)
      requests.push({ url: target, options: options || null })
      const body = target.includes('/cancel')
        ? state.cancel
        : (target.includes('/sleep') ? {} : state.health)
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
    requests,
    state,
    /** The answer of the `/cancel` route. */
    setCancelAnswer: (answer) => { state.cancel = answer },
    /** The state the Host reports. */
    setHealth: (next) => { state.health = { ...next } },
    /** Fire a click on the document (an outside click). */
    clickOutside: () => {
      for (const handler of documentListeners.get('click') || []) handler({ type: 'click' })
    },
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

/** The requests the client sent to the cancel route (the health poll does not count). */
function cancelRequests(mounted) {
  return mounted.requests.filter((request) => request.url.includes('/cancel'))
}

/** The state the Host reports: a pending restart this session waits for. */
function pendingState(overrides = {}) {
  return {
    ok: true,
    pendingRestart: true,
    waiters: ['sess-x', 'sess-y'],
    blockedBy: [
      { sessionId: 'sess-y', kind: 'session', label: '写代码', name: '写代码', reason: 'running' },
      { sessionId: 'sess-z', kind: 'session', label: '调研', name: '调研', reason: 'running' },
    ],
    allowRestart: false,
    cancelUrl: '/__dsh_autorestart/cancel',
    ...overrides,
  }
}

/** A click event that stops the propagation (like the browser's). */
function clickEvent() {
  return { type: 'click', stopPropagation: () => {}, preventDefault: () => {} }
}

/** Mount the capsule of the given session. */
async function mountPill(props = { sessionId: 'sess-x' }, options = {}) {
  const mounted = mountClient({ health: pendingState(), ...options })
  const pill = await mounted.settled('autorestart-restart-pill', props)
  return { mounted, pill }
}

test('clicking the capsule opens the panel', async () => {
  const { mounted, pill } = await mountPill()
  assert.equal(panelOf(pill), undefined, 'the panel starts closed')
  capsuleOf(pill).props.onClick(clickEvent())
  const opened = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const panel = panelOf(opened)
  assert.ok(panel, 'the click opens the panel')
  assert.equal(panel.props.role, 'dialog', 'the panel is a dialog')
  assert.ok(panel.props['aria-label'], 'the panel is labelled')
  assert.match(textOf(panel), /还在等 2 个会话/, `the panel says what the restart waits for: ${textOf(panel)}`)
  assert.match(textOf(panel), /还有 1 个会话也在等这次重启/, `the panel says who else waits: ${textOf(panel)}`)
})

test('a double click opens the SAME panel and never cancels anything', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onDoubleClick(clickEvent())
  const opened = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(panelOf(opened), 'the double click opens the panel')
  assert.equal(confirmOf(opened), undefined, 'the double click does not open a confirmation')
  assert.equal(cancelRequests(mounted).length, 0, 'the double click sends no request')
})

test('the capsule text carries NO hint about the cancel', async () => {
  const { pill } = await mountPill()
  const copy = capsuleCopy(pill)
  assert.doesNotMatch(copy, /双击/, `the capsule names no double click: ${copy}`)
  assert.doesNotMatch(copy, /取消/, `the capsule names no cancel: ${copy}`)
  assert.doesNotMatch(copy, /click/i, `the capsule carries no click hint: ${copy}`)
  assert.ok(copy.length <= 30, `the capsule stays short: ${copy.length} characters — ${copy}`)
})

test('Esc closes the panel without cancelling anything', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(panelOf(current), 'the panel is open')
  capsuleOf(current).props.onKeyDown({ type: 'keydown', key: 'Escape', stopPropagation: () => {}, preventDefault: () => {} })
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.equal(panelOf(current), undefined, 'Esc closes the panel')
  assert.equal(cancelRequests(mounted).length, 0, 'Esc cancels nothing')
})

test('a click outside the panel closes it', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(panelOf(current), 'the panel is open')
  mounted.clickOutside()
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.equal(panelOf(current), undefined, 'the outside click closes the panel')
  assert.equal(cancelRequests(mounted).length, 0, 'the outside click cancels nothing')
})

test('the button of the panel only opens the confirmation — it sends no request', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const button = buttonWithText(current, '取消我的这次重启')
  assert.ok(button, 'the panel has the cancel button')
  button.props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const confirm = confirmOf(current)
  assert.ok(confirm, 'the button opens the confirmation')
  assert.match(textOf(confirm), /取消你的这次重启？/, `the confirmation asks: ${textOf(confirm)}`)
  assert.match(textOf(confirm), /还有 1 个会话也在等这次重启/, `it says who else waits: ${textOf(confirm)}`)
  assert.equal(cancelRequests(mounted).length, 0, 'the first click sends NO request')
})

test('the confirmation has NO timeout: it stays until the user decides', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(confirmOf(current), 'the confirmation is open')
  // Many renders later it is still open: nothing times it out.
  for (let i = 0; i < 5; i += 1) {
    current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  }
  assert.ok(confirmOf(current), 'the confirmation is still open')
  assert.equal(cancelRequests(mounted).length, 0, 'nothing was cancelled')
})

test('「再想想」 closes the confirmation and sends no request', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const dismiss = buttonWithText(current, '再想想')
  assert.ok(dismiss, 'the confirmation has the dismiss button')
  dismiss.props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.equal(confirmOf(current), undefined, 'the confirmation is closed')
  assert.ok(panelOf(current), 'the panel stays open')
  assert.equal(cancelRequests(mounted).length, 0, '「再想想」 sends no request')
})

test('the confirmation sends the own request', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '确认取消').props.onClick(clickEvent())
  await new Promise((resolve) => setTimeout(resolve, 10))
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.equal(cancelRequests(mounted).length, 1, `the confirmation sends the request: ${JSON.stringify(cancelRequests(mounted))}`)
  const request = cancelRequests(mounted)[0]
  assert.equal(request.url, '/__dsh_autorestart/cancel')
  assert.equal(request.options.method, 'POST')
  const body = JSON.parse(request.options.body)
  assert.equal(body.sessionId, 'sess-x', 'the request carries the own session')
  assert.equal(body.scope, 'mine', 'the request withdraws only the own request')
})

test('the panel has NO "cancel everybody" button', async () => {
  const { mounted, pill } = await mountPill()
  capsuleOf(pill).props.onClick(clickEvent())
  const opened = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const text = textOf(panelOf(opened))
  assert.doesNotMatch(text, /所有人|everyone/, `the panel never offers a mass cancel: ${text}`)
  const buttons = walk(opened).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.deepEqual(buttons, ['取消我的这次重启'], `the panel has one button: ${JSON.stringify(buttons)}`)
})

test('without a known session the copy explains it and nothing is sent', async () => {
  // The capsule itself only shows for a session it knows (it is "this session
  // waits"), so the unknown-session case is a guard: the client must never
  // send a request it cannot identify, and the copy has to say so.
  const api = globalThis.__dshAutorestartClient
  assert.ok(api, 'the client publishes its pure helpers')
  const zh = (key) => (api.dictionaries.zh[key] !== undefined ? api.dictionaries.zh[key] : key)
  assert.equal(
    api.cancelFailureText({ reason: 'no-session-id' }, zh),
    '当前会话未知，无法只撤自己。',
    'the unknown session has its own copy',
  )
  assert.equal(
    api.cancelFailureText({ reason: 'not-a-requester' }, zh),
    '这个会话没有请求这次重启，所以什么都没取消。',
    'the refusal has its own copy',
  )
  assert.equal(
    api.cancelFailureText({}, zh),
    '没能取消这次重启。',
    'an unknown failure still says something',
  )
  // The route refuses such a request as well (no session id -> no cancel).
  const { cancelRoute } = mountPlugin('unknown-session')
  const answer = await callCancel(cancelRoute, { scope: 'mine' })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.reason, 'session-id-required')
})

test('a failure shows the readable reason in the panel', async () => {
  const mounted = mountClient({
    health: pendingState(),
    cancelAnswer: {
      ok: false,
      cancelled: false,
      reason: 'not-a-requester',
      error: '这个会话没有请求这次重启，所以什么都没取消。',
      remainingRequesters: 1,
    },
  })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '确认取消').props.onClick(clickEvent())
  await new Promise((resolve) => setTimeout(resolve, 10))
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const panel = panelOf(current)
  assert.ok(panel, 'the panel stays open')
  assert.match(textOf(panel), /这个会话没有请求这次重启/, `the reason is readable: ${textOf(panel)}`)
  assert.equal(confirmOf(current), undefined, 'the confirmation is closed')
})

test('the capsule disappears when the restart is really gone', async () => {
  const mounted = mountClient({
    health: pendingState(),
    cancelAnswer: { ok: true, cancelled: true, remainingRequesters: 0, sessionId: 'sess-x' },
  })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '确认取消').props.onClick(clickEvent())
  await new Promise((resolve) => setTimeout(resolve, 10))
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.equal(capsuleOf(current), undefined, 'the capsule is gone when the restart is over')
})

test('the capsule stays and the panel counts the sessions that are left', async () => {
  const mounted = mountClient({
    health: pendingState(),
    cancelAnswer: { ok: true, cancelled: false, remainingRequesters: 3, sessionId: 'sess-x' },
  })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  capsuleOf(pill).props.onClick(clickEvent())
  let current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '取消我的这次重启').props.onClick(clickEvent())
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  buttonWithText(current, '确认取消').props.onClick(clickEvent())
  await new Promise((resolve) => setTimeout(resolve, 10))
  current = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(capsuleOf(current), 'the capsule stays while the restart is pending for the others')
  const panel = panelOf(current)
  assert.ok(panel, 'the panel stays open')
  assert.match(textOf(panel), /还剩 3 个会话在等/, `the panel counts what is left: ${textOf(panel)}`)
})

test('the copy of the panel lives in the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const api = globalThis.__dshAutorestartClient
  assert.ok(api, 'the client publishes its pure helpers')
  // The locale files are the MIRROR of the dictionaries: every key of the
  // client is in the file under the same name.
  const panelKeys = Object.keys(api.dictionaries.zh).filter((key) => key.startsWith('cancel'))
  for (const key of panelKeys) {
    assert.equal(api.dictionaries.zh[key], zh[key], `zh.${key} must match the client copy`)
    assert.equal(api.dictionaries.en[key], en[key], `en.${key} must match the client copy`)
  }
  assert.ok(panelKeys.length >= 20, 'the panel copy is complete')
})

// ------------------------------------------------------------------ *
// The route half.
// ------------------------------------------------------------------ */

function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-cancel-route-' + label + '-'))
  return { dir, file: path.join(dir, 'state.json') }
}

function createFakeContext({ services = {}, runningAgents = [] } = {}) {
  const tools = []
  const listeners = new Map()
  const timeouts = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => undefined, warn: () => undefined, error: () => undefined }),
    fiber: { state: 2 },
    agents: {
      list: () => runningAgents,
      roots: () => runningAgents,
      get: (id) => runningAgents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    get: (name) => services[name],
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
    interval: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    provide: () => undefined,
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, timeouts }
}

/** The plugin with a web server that keeps the registered routes. */
function mountPlugin(label) {
  const { file } = tempStateFile(label)
  const routes = []
  const fake = createFakeContext()
  fake.ctx.get = (name) => {
    if (name === 'webServer') {
      return {
        register: (route) => { routes.push(route) },
        getOrigin: () => 'http://127.0.0.1:1234',
        tapIndex: () => {},
      }
    }
    return undefined
  }
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancelRoute = routes.find((route) => route.path === '/__dsh_autorestart/cancel')
  assert.ok(cancelRoute, `the cancel route must be registered: ${routes.map((r) => r.path).join(', ')}`)
  return { file, routes, restart, cancelRoute }
}

/** Call the cancel route with a body. */
async function callCancel(route, body, method = 'POST') {
  let payload = ''
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on: (event, handler) => {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {})))
      if (event === 'end') handler()
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader: (key, value) => { res.headers[key] = value },
    end: (text) => { payload = text },
  }
  route.handler(req, res)
  await new Promise((resolve) => setTimeout(resolve, 20))
  let parsed = null
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  return { statusCode: res.statusCode, body: parsed }
}

test('the cancel route withdraws only that session', async () => {
  const { file, restart, cancelRoute } = mountPlugin('mine')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  restart.execute({ reason: 'b' }, { agent: { id: 'sess-b', status: 'running' } })

  const answer = await callCancel(cancelRoute, { sessionId: 'sess-a', scope: 'mine' })

  assert.equal(answer.statusCode, 200)
  assert.equal(answer.body.ok, true, `the request works: ${JSON.stringify(answer.body)}`)
  assert.equal(answer.body.cancelled, false, 'the restart of the other session stays')
  assert.equal(answer.body.remainingRequesters, 1)
  assert.equal(answer.body.sessionId, 'sess-a')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(state.restart, 'the restart is still pending')
  assert.deepEqual(state.restart.requesters.map((entry) => entry.sessionId), ['sess-b'])
  assert.equal(state.restart.bySessionId, 'sess-b')
})

test('the cancel route refuses a body without a session id', async () => {
  const { file, restart, cancelRoute } = mountPlugin('no-session')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))

  const answer = await callCancel(cancelRoute, { scope: 'mine' })

  assert.equal(answer.statusCode, 400)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.reason, 'session-id-required')
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.restart, before.restart, 'the pending restart is untouched')
})

test('the cancel route refuses a session that did not request the restart', async () => {
  const { file, restart, cancelRoute } = mountPlugin('not-a-requester')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))

  const answer = await callCancel(cancelRoute, { sessionId: 'sess-z', scope: 'mine' })

  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.reason, 'not-a-requester')
  assert.match(answer.body.error, /did not request/i, `the reason is readable: ${answer.body.error}`)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.restart, before.restart, 'the pending restart is untouched')
  assert.equal(after.sessions['sess-a'].pendingResume, true, 'the requester still waits')
})

test('the cancel route refuses to cancel for everybody', async () => {
  const { file, restart, cancelRoute } = mountPlugin('scope-all')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))

  const answer = await callCancel(cancelRoute, { sessionId: 'sess-a', scope: 'all' })

  assert.equal(answer.statusCode, 400)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.reason, 'scope-not-allowed')
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.restart, before.restart, 'the pending restart is untouched')
})

test('the cancel route cancels the restart when the caller was the last requester', async () => {
  const { file, restart, cancelRoute } = mountPlugin('last')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })

  const answer = await callCancel(cancelRoute, { sessionId: 'sess-a', scope: 'mine' })

  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.cancelled, true, 'the restart is really gone')
  assert.equal(answer.body.remainingRequesters, 0)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.restart, null)
  assert.equal(state.phase, 'idle')
  assert.equal(state.sessions['sess-a'], undefined, 'the waiter is released')
})
