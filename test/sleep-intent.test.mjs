/**
 * Tests for the shutdown intent that survives a restart.
 *
 * The race the user reported: "I pressed the shutdown button, and all I got
 * was a restart — the machine is still on." The shutdown gate only looked at
 * the DSH agents, so a pending restart and the shutdown raced each other.
 *
 * The rule now: **a pending restart goes first.** The shutdown waits for it —
 * and for the sessions that resume with it — and the intent itself is written
 * into the checkpoint file, so it survives the restart.
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

const SLEEP_PATH = '/__dsh_autorestart/sleep'

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-intent-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context: the routes, the timers and the tools.
 */
function createContext({ agents = [] } = {}) {
  const routes = []
  const timers = []
  const tools = []
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
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, timers, tools }
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

/** Call the sleep route and return the parsed answer. */
async function callSleep(routes, method, body) {
  const route = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(route, `the sleep route ${SLEEP_PATH} must be registered`)
  const res = fakeResponse()
  route.handler(fakeRequest(method, body), res)
  await settle()
  return JSON.parse(res.body)
}

/** Fire every 1s timer of the plugin (the sleep controller ticks on them). */
function fireTicks(timers) {
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
}

/** The checkpoint file, as it is on disk. */
function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Apply the plugin with a shutdown that is intercepted (the real command
 * would switch the test machine off).
 */
function applyPlugin(ctx, file, overrides = {}) {
  const powerOffs = []
  apply(ctx, {
    stateFile: file,
    recoveryDelayMs: 0,
    enabled: true,
    // No reserve window here: these tests are about the restart, not the wait.
    restartGraceMs: 0,
    sleepCountdownSeconds: 20,
    ...overrides,
  }, {
    sleepSpawn: (command, args) => {
      powerOffs.push({ command, args })
      return { pid: 4242, unref() {} }
    },
  })
  return { powerOffs }
}

/** Ask for a restart, exactly like the `continuum_restart` tool does. */
function requestRestart(tools) {
  const tool = tools.find((entry) => entry.name === 'continuum_restart')
  assert.ok(tool, 'the continuum_restart tool must be registered')
  tool.execute({})
}

test('a pending restart keeps the shutdown from counting down', async () => {
  const file = tempStateFile('pending')
  const { ctx, routes, tools } = createContext()
  applyPlugin(ctx, file)
  requestRestart(tools)

  const armed = await callSleep(routes, 'POST', { action: 'arm' })
  assert.equal(armed.armed, true, 'the shutdown is armed')
  assert.equal(armed.phase, 'waiting', 'the countdown must not start')
  assert.equal(armed.remainingMs, 20000, 'the countdown is untouched')
  assert.match(armed.message, /等这次重启完成后再关机/, `the card says why: ${armed.message}`)

  // The blocker says WHAT it is: a pending restart, not a running task.
  assert.equal(armed.blockers.length, 1)
  assert.equal(armed.blockers[0].kind, 'restart-pending')
  assert.equal(armed.blockers[0].label, '待执行的重启')
  assert.equal(armed.blockers[0].name, '待执行的重启')

  // And the countdown really does not start: ticking changes nothing.
  fireTicks([])
  const still = await callSleep(routes, 'GET')
  assert.equal(still.phase, 'waiting')
  assert.equal(still.remainingMs, 20000)
})

test('the shutdown intent is written to the checkpoint and survives the restart', async () => {
  const file = tempStateFile('intent')
  const { ctx, routes, tools } = createContext()
  applyPlugin(ctx, file)
  requestRestart(tools)

  await callSleep(routes, 'POST', { action: 'arm' })
  const recorded = readState(file)
  assert.ok(recorded.sleep, 'the intent must be in the checkpoint file')
  assert.equal(recorded.sleep.armed, true)
  assert.equal(typeof recorded.sleep.armedAt, 'number')
  assert.equal(recorded.sleep.countdownSeconds, 20)

  // The restart happens: the pending restart is consumed (the boot recovery
  // clears it) — the INTENT must survive that.
  const cancel = tools.find((entry) => entry.name === 'continuum_cancel_restart')
  cancel.execute({ scope: 'all' })
  assert.equal(readState(file).restart, null, 'the pending restart is gone')

  // The intent is still there: the user did not press the button twice.
  const afterRestart = readState(file)
  assert.ok(afterRestart.sleep, 'the intent must survive the restart')
  assert.equal(afterRestart.sleep.armed, true)
})

test('once the restart is done the shutdown counts down', async () => {
  const file = tempStateFile('countdown')
  const { ctx, routes, timers, tools } = createContext()
  applyPlugin(ctx, file)
  requestRestart(tools)

  await callSleep(routes, 'POST', { action: 'arm' })
  assert.equal((await callSleep(routes, 'GET')).phase, 'waiting')

  // The restart is done (the boot recovery consumed it).
  tools.find((entry) => entry.name === 'continuum_cancel_restart').execute({ scope: 'all' })
  fireTicks(timers)

  const counting = await callSleep(routes, 'GET')
  assert.equal(counting.phase, 'countdown', 'the countdown starts once the restart is done')
  assert.equal(counting.remainingMs, 20000)
  assert.deepEqual(counting.blockers, [])
})

test('the intent is cleared once the machine went off', async () => {
  const file = tempStateFile('done')
  const { ctx, routes } = createContext()
  // A countdown of zero seconds: the machine goes off right away.
  const { powerOffs } = applyPlugin(ctx, file, { sleepCountdownSeconds: 0 })

  await callSleep(routes, 'POST', { action: 'arm' })
  assert.equal(powerOffs.length, 1, 'the shutdown command ran')
  assert.equal(readState(file).sleep, null, 'the intent must not survive the shutdown')
})

test('the intent is cleared when the user cancels', async () => {
  const file = tempStateFile('cancel')
  const { ctx, routes } = createContext()
  applyPlugin(ctx, file)

  await callSleep(routes, 'POST', { action: 'arm' })
  assert.ok(readState(file).sleep, 'the intent was recorded')

  const cancelled = await callSleep(routes, 'POST', { action: 'cancel' })
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(readState(file).sleep, null, 'the intent must be gone after the cancel')
})

test('the intent is restored after a restart', async () => {
  const file = tempStateFile('restore')
  // A checkpoint that carries the intent (the machine was switched off after
  // a restart with the shutdown still armed).
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    bootId: 'boot-1',
    bootPid: 1,
    bootStartedAt: Date.now(),
    generation: 1,
    phase: 'idle',
    restart: null,
    sessions: {},
    seenFeatureVersions: {},
    sleep: { armed: true, armedAt: Date.now() - 5000, countdownSeconds: 20 },
    updatedAt: Date.now(),
  }), 'utf8')

  const { ctx, routes } = createContext()
  applyPlugin(ctx, file)

  // The restore runs after the boot recovery (an async pass).
  await settle()
  const status = await callSleep(routes, 'GET')
  assert.equal(status.armed, true, 'the intent is restored')
  assert.equal(status.phase, 'countdown', 'it waits for the work, it does not switch off at once')
  assert.equal(status.armedAt > 0, true, 'the time the intent was armed is reported')
})

test('a broken intent record never hangs the machine for ever', async () => {
  const file = tempStateFile('broken')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    bootId: 'boot-1',
    bootPid: 1,
    bootStartedAt: Date.now(),
    generation: 1,
    phase: 'idle',
    restart: null,
    sessions: {},
    seenFeatureVersions: {},
    sleep: { armed: 'yes', armedAt: 'nonsense' },
    updatedAt: Date.now(),
  }), 'utf8')

  const { ctx, routes } = createContext()
  applyPlugin(ctx, file)

  const status = await callSleep(routes, 'GET')
  assert.equal(status.armed, false, 'a broken record must not arm the machine')
  assert.equal(readState(file).sleep, null, 'the broken record is dropped')
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
 * Load the classic client script in a sandbox and mount the waiting card.
 *
 * @param {{ status: object }} options
 */
function mountWaitingCard({ status }) {
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
    fetch: (url) => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/sleep') ? status : { ok: true, pendingRestart: false }),
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

  const dictionaries = {}
  const slots = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
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
    dictionaries,
    settled: async (id) => {
      const Component = componentOf(id)
      harness.render(Component, {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, {})
    },
  }
}

test('the waiting card says that the restart comes first', async () => {
  const mounted = mountWaitingCard({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      message: '等这次重启完成后再关机……',
      blockers: [{
        sessionId: 'restart-pending',
        kind: 'restart-pending',
        label: '待执行的重启',
        name: '待执行的重启',
      }],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  assert.ok(card, 'the waiting card must be shown')
  const text = textOf(card)
  assert.match(text, /等这次重启完成后再关机/, `the card says what it waits for: ${text}`)
  // A pending restart is not a task: it is never counted as one.
  assert.doesNotMatch(text, /个任务在干活/, 'the restart is not a running task')
})

test('the waiting card counts the tasks, not the pending restart', async () => {
  const mounted = mountWaitingCard({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      message: '等这次重启完成后再关机……',
      blockers: [
        {
          sessionId: 'restart-pending',
          kind: 'restart-pending',
          label: '待执行的重启',
          name: '待执行的重启',
        },
        { sessionId: 'sess-a', kind: 'session', label: '写代码', name: '写代码' },
      ],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const text = textOf(card)
  assert.match(text, /还有 1 个任务在干活/, `only the task is counted: ${text}`)
  assert.match(text, /会话「写代码」正在运行/, `the task is still listed: ${text}`)
})
