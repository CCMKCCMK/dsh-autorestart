/**
 * Tests for the one-time install choice of the backup scope.
 *
 * The user is asked ONCE whether the pre-restart backup should also snapshot
 * the installed plugin tree. The answer is persisted through the official
 * `configEditor` service (the profile configuration is the single source of
 * truth), and the degraded path (no `configEditor`) falls back to a file in
 * the plugin's state directory.
 *
 * The client half is a classic script, so it is loaded in a sandbox with a
 * tiny React stand-in and a fake browser: that way the one-time prompt is
 * really rendered, really clicked and really observed.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, DEFAULTS } from '../index.js'

/** The browser-side key that records the one-time choice. */
const CHOICE_KEY = 'dsh-autorestart:backup-choice-v1'

/** The route that persists the choice. */
const CHOICE_PATH = '/__dsh_autorestart/choice'

/** Create a temporary state directory per test. */
function tempStateDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-choice-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/**
 * A fake Cordis context: it records the registered routes, the registered
 * tools and the warnings the plugin logs.
 */
function createContext({ services = {} } = {}) {
  const routes = []
  const warnings = []
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
    logger: {
      info: () => undefined,
      warn: (...parts) => {
        warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
      },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes, warnings, tools }
}

/** Minimal Node response stand-in for the route handlers. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body, url) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: url || CHOICE_PATH,
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

test('the choice route writes the answer into the profile configuration through the configEditor', async () => {
  const { dir, file } = tempStateDir('config')
  const edits = []
  const { ctx, routes } = createContext({
    services: {
      configEditor: {
        // The REAL shape of the service: it hands out the Loader's own
        // entries, and the row id lives in `entry.options.id`.
        entries: () => ([
          { options: { id: 'another-plugin', name: 'another-plugin', config: {} } },
          { options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: { backupOnRestart: true, maxBackups: 2 } } },
        ]),
        edit: async (entry, change) => {
          edits.push({
            rowId: entry && entry.options ? entry.options.id : null,
            next: change({ backupOnRestart: true, maxBackups: 2 }, { maxBackups: 2 }),
          })
        },
      },
    },
  })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: false }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, applied: 'config', includePlugins: false })
  assert.equal(edits.length, 1, 'the profile row must be edited exactly once')
  assert.equal(edits[0].rowId, 'dsh-autorestart', 'the row of THIS plugin must be edited')
  assert.equal(edits[0].next.backupIncludePlugins, false)
  assert.equal(edits[0].next.backupOnRestart, true, 'the other keys of the row must be preserved')
  assert.equal(
    fs.existsSync(path.join(dir, 'install-choice.json')),
    false,
    'the fallback file must not be written when the profile configuration took the answer',
  )
})

test('the choice route degrades to the fallback file and warns when the configEditor is unavailable', async () => {
  const { dir, file } = tempStateDir('fallback')
  const { ctx, routes, warnings } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: true }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, applied: 'fallback-file', includePlugins: true })
  const fallback = path.join(dir, 'install-choice.json')
  assert.ok(fs.existsSync(fallback), 'the fallback file must be written')
  assert.equal(JSON.parse(fs.readFileSync(fallback, 'utf8')).includePlugins, true)
  assert.ok(
    warnings.some((line) => /configEditor/.test(line)),
    `the degradation must be logged as a warning, got: ${JSON.stringify(warnings)}`,
  )
})

test('a non-boolean answer is refused with 400 and nothing is written at all', async () => {
  const { dir, file } = tempStateDir('invalid')
  const edits = []
  const { ctx, routes } = createContext({
    services: {
      configEditor: {
        entries: () => ([{ patchId: 'dsh-autorestart' }]),
        edit: async (entry, change) => {
          edits.push(change({}, {}))
        },
      },
    },
  })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  for (const invalid of ['true', 1, 0, null, undefined, {}, []]) {
    const res = fakeResponse()
    choiceRoute(routes).handler(fakeRequest('POST', { includePlugins: invalid }), res)
    await settle()
    assert.equal(res.statusCode, 400, `includePlugins=${JSON.stringify(invalid)} must be refused`)
    assert.equal(JSON.parse(res.body).ok, false)
  }
  assert.equal(edits.length, 0, 'nothing may be written into the profile configuration')
  assert.equal(
    fs.existsSync(path.join(dir, 'install-choice.json')),
    false,
    'nothing may be written into the fallback file',
  )
})

test('continuum_status reports the effective backup scope and declares it in the strict output schema', () => {
  const { file } = tempStateDir('status')
  const { ctx, tools } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, backupIncludePlugins: false })

  const status = tools.find((tool) => tool.name === 'continuum_status')
  assert.ok(status, 'continuum_status must be registered')
  assert.equal(status.output.schema.additionalProperties, false, 'the output schema is strict')
  assert.equal(status.output.schema.properties.backupIncludePlugins.type, 'boolean')

  const payload = status.execute({})
  assert.equal(payload.backupIncludePlugins, false, 'the effective value must be reported')
  for (const key of Object.keys(payload)) {
    assert.ok(key in status.output.schema.properties, `the reported field ${key} must be declared in the schema`)
  }
})

test('the profile row config decides the effective backup scope', () => {
  const withFalse = tempStateDir('scope-false')
  const falseCtx = createContext()
  apply(falseCtx.ctx, { stateFile: withFalse.file, recoveryDelayMs: 0, enabled: true, backupIncludePlugins: false })
  const falseTool = falseCtx.tools.find((tool) => tool.name === 'continuum_status')
  assert.equal(falseTool.execute({}).backupIncludePlugins, false)

  const withTrue = tempStateDir('scope-true')
  const trueCtx = createContext()
  apply(trueCtx.ctx, { stateFile: withTrue.file, recoveryDelayMs: 0, enabled: true, backupIncludePlugins: true })
  const trueTool = trueCtx.tools.find((tool) => tool.name === 'continuum_status')
  assert.equal(trueTool.execute({}).backupIncludePlugins, true)
})

test('the fallback file only fills the gap the profile row config leaves open', () => {
  const { dir, file } = tempStateDir('fallback-effective')
  fs.writeFileSync(path.join(dir, 'install-choice.json'), JSON.stringify({ includePlugins: false }))

  // The row config does not set the key: the recorded choice applies.
  const withoutRow = createContext()
  apply(withoutRow.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const withoutTool = withoutRow.tools.find((tool) => tool.name === 'continuum_status')
  assert.equal(withoutTool.execute({}).backupIncludePlugins, false)

  // The row config sets the key: it wins over the recorded choice.
  const withRow = createContext()
  apply(withRow.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, backupIncludePlugins: true })
  const withTool = withRow.tools.find((tool) => tool.name === 'continuum_status')
  assert.equal(withTool.execute({}).backupIncludePlugins, true)
})

test('every config key carries a one-sentence description, the four backup knobs included', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf('return schemastery.object({')
  assert.ok(start > 0, 'the config schema must be built')
  const end = source.indexOf('\n    })', start)
  assert.ok(end > start, 'the config schema must end')
  const body = source.slice(start, end)

  const keys = []
  const keyPattern = /(\w+):\s*schemastery\./g
  let match = keyPattern.exec(body)
  while (match !== null) {
    keys.push({ key: match[1], index: match.index })
    match = keyPattern.exec(body)
  }
  assert.ok(
    keys.length >= Object.keys(DEFAULTS).length,
    `the schema must declare every default key (${keys.length} < ${Object.keys(DEFAULTS).length})`,
  )

  for (let index = 0; index < keys.length; index += 1) {
    const chunk = body.slice(keys[index].index, index + 1 < keys.length ? keys[index + 1].index : body.length)
    const description = /\.description\('([^']*)'\)/.exec(chunk)
    assert.ok(description, `the config key ${keys[index].key} must carry a description`)
    assert.ok(description[1].length > 20, `the description of ${keys[index].key} must be a sentence`)
  }

  for (const key of ['backupOnRestart', 'backupIncludePlugins', 'maxBackups', 'rollbackTimeoutMs']) {
    assert.ok(keys.some((entry) => entry.key === key), `${key} must be part of the config schema`)
  }
  const includePlugins = body.slice(
    keys.find((entry) => entry.key === 'backupIncludePlugins').index,
    keys.find((entry) => entry.key === 'maxBackups').index,
  )
  assert.match(includePlugins, /3 extra seconds/, 'the description must state the time cost')
})

/* ------------------------------------------------------------------ *
 * The client half: the one-time prompt.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * A tiny React stand-in: enough for the classic client script.
 *
 * It keeps the hook state between renders, runs the effects after every
 * render and hands the rendered tree back to the test.
 */
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
 * Load the classic client script in a sandbox and mount the one-time prompt.
 *
 * @param {{ storage: object, fetches: object[], language?: string }} options
 */
function mountBackupChoicePanel({ storage, fetches, language = 'zh' }) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const styles = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
      localStorage: storage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => {
        const node = { tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }
        if (tag === 'style') styles.push(node)
        return node
      },
      head: {
        appendChild: (node) => {
          node.parentNode = sandbox.document.head
          return node
        },
        removeChild: () => {},
      },
    },
    fetch: (url, init) => {
      fetches.push({ url, init })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, choiceUrl: CHOICE_PATH }),
      })
    },
    console,
    setTimeout,
    clearTimeout,
    // The shared poll must not keep the test process alive.
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
      // More than one component may live in the same slot (the install prompt
      // and the new-feature announcement both sit in the composer dock).
      inject: (name, thunk) => {
        const list = slots.get(name) || []
        list.push(thunk)
        slots.set(name, list)
      },
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  const thunks = slots.get('conversation.input.dock') || []
  const thunk = thunks.find((entry) => entry().registration.id === 'autorestart-backup-choice')
  assert.ok(thunk, 'the prompt must be registered in the composer dock')
  const { Component } = thunk()
  return {
    render: () => harness.render(Component, {}),
    dictionaries,
    styles,
    registration: thunk,
  }
}

test('the one-time prompt asks the two questions once each', () => {
  const unanswered = createStorage()
  const fetches = []
  const mounted = mountBackupChoicePanel({ storage: unanswered, fetches })
  const tree = mounted.render()
  assert.ok(tree, 'the prompt must be rendered when no answer was recorded')
  assert.equal(tree.props.role, 'status', 'the prompt must be a status panel')
  assert.equal(tree.props['data-dsh-autorestart-choice-step'], 'backup', 'the first question comes first')

  // The backup question was answered, but the standby-button question was
  // NOT: the panel continues with the second question (it is asked once, on
  // its own — an installation that answered the backup question before that
  // question existed still has to be asked).
  const answered = createStorage({ [CHOICE_KEY]: 'plugins' })
  const second = mountBackupChoicePanel({ storage: answered, fetches: [] })
  const sleepStep = second.render()
  assert.ok(sleepStep, 'the second question must still be reachable')
  assert.equal(sleepStep.props['data-dsh-autorestart-choice-step'], 'sleep')

  // Every question answered: the prompt is gone for good.
  const both = createStorage({ [CHOICE_KEY]: 'plugins', 'dsh-autorestart:sleep-button-v1': 'keep' })
  const third = mountBackupChoicePanel({ storage: both, fetches: [] })
  assert.equal(third.render(), null, 'the prompt must not be rendered once every answer was recorded')
})

test('clicking an option records the answer, calls the Host and hides the prompt', () => {
  const storage = createStorage()
  const fetches = []
  const mounted = mountBackupChoicePanel({ storage, fetches })
  const tree = mounted.render()

  const options = walk(tree).filter((node) => node.type === 'button' && node.props['data-backup-choice'])
  assert.equal(options.length, 2, 'the prompt must offer exactly two options')
  const withPlugins = options.find((node) => node.props['data-backup-choice'] === 'plugins')
  assert.ok(withPlugins, 'the "include the plugins" option must exist')

  withPlugins.props.onClick()

  assert.equal(storage.getItem(CHOICE_KEY), 'plugins', 'the answer must be recorded in the browser')
  const calls = fetches.filter((call) => String(call.url).endsWith('/choice'))
  assert.equal(calls.length, 1, 'the choice route must be called exactly once')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { includePlugins: true })
  assert.equal(mounted.render(), null, 'the prompt must disappear after the answer')
})

test('the "configuration only" option answers the other way round', () => {
  const storage = createStorage()
  const fetches = []
  const mounted = mountBackupChoicePanel({ storage, fetches })
  const tree = mounted.render()

  const configOnly = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-backup-choice'] === 'config-only',
  )
  assert.ok(configOnly, 'the "configuration only" option must exist')
  configOnly.props.onClick()

  assert.equal(storage.getItem(CHOICE_KEY), 'config-only')
  const calls = fetches.filter((call) => String(call.url).endsWith('/choice'))
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].init.body), { includePlugins: false })
  assert.equal(mounted.render(), null, 'the prompt must disappear after the answer')
})

test('the prompt is a non-modal, closable panel that never disappears on its own', () => {
  const storage = createStorage()
  const mounted = mountBackupChoicePanel({ storage, fetches: [] })
  const tree = mounted.render()

  assert.equal(tree.type, 'div', 'the prompt must be an ordinary block, not a dialog')
  assert.equal(tree.props.role, 'status')
  assert.equal(tree.props['aria-modal'], undefined, 'the prompt must not be modal')
  assert.equal(tree.props.className, 'dsh-autorestart-choice')
  assert.equal(tree.props.tabIndex, 0, 'the prompt must be reachable with the keyboard')

  const close = walk(tree).find((node) => node.type === 'button' && node.props.className === 'dsh-autorestart-choice__close')
  assert.ok(close, 'the prompt must offer a × close control')
  assert.ok(close.props['aria-label'], 'the close control must carry an aria-label')

  // It does not disappear on its own: another render keeps it.
  assert.ok(mounted.render(), 'the prompt must stay until it is answered')
})

test('the × close control and the Esc key keep the default and record the answer', () => {
  const storage = createStorage()
  const mounted = mountBackupChoicePanel({ storage, fetches: [] })
  const tree = mounted.render()

  const close = walk(tree).find((node) => node.type === 'button' && node.props.className === 'dsh-autorestart-choice__close')
  assert.ok(close, 'the × close control must exist')
  close.props.onClick()
  assert.equal(storage.getItem(CHOICE_KEY), 'dismissed', 'closing must record the answer too')
  assert.equal(mounted.render(), null, 'the prompt must disappear after it was closed')

  // Esc does the same.
  const second = createStorage()
  const other = mountBackupChoicePanel({ storage: second, fetches: [] })
  const otherTree = other.render()
  assert.ok(otherTree.props.onKeyDown, 'the prompt must handle the keyboard')
  otherTree.props.onKeyDown({ key: 'Escape' })
  assert.equal(second.getItem(CHOICE_KEY), 'dismissed', 'Esc must record the answer too')
  assert.equal(other.render(), null, 'the prompt must disappear after Esc')
})

test('the prompt styles use the DSH theme tokens, not hard-coded colours', () => {
  const mounted = mountBackupChoicePanel({ storage: createStorage(), fetches: [] })
  mounted.render()
  const style = mounted.styles.find((node) => node.id === 'dsh-autorestart-choice')
  assert.ok(style, 'the prompt must inject its stylesheet')
  const tokens = style.textContent.match(/--dsw-alias-[a-z0-9-]+/g) || []
  const distinct = [...new Set(tokens)]
  assert.ok(distinct.length >= 2, `the stylesheet must use at least two theme tokens, got ${distinct.length}`)
  assert.ok(
    distinct.includes('--dsw-alias-border-l1'),
    'the surface must use the theme border token',
  )
  assert.ok(
    distinct.includes('--dsw-alias-bg-layer-1'),
    'the surface must use the theme background token',
  )
  assert.match(style.textContent, /@media \(max-width:1023px\)/, 'the prompt must adapt to a narrow window')
})

test('the choice route answers over real HTTP: 400 writes nothing, a legal answer flips the profile row, and the restore works', async () => {
  const { dir, file } = tempStateDir('http')
  const profileFile = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(
    profileFile,
    [
      '- id: dsh-autorestart',
      '  name: dsh-autorestart',
      '  config:',
      '    enabled: true',
      '    backupOnRestart: true',
      '    backupIncludePlugins: true',
      '',
    ].join('\n'),
    'utf8',
  )

  // A stand-in for the Host's configEditor: it rewrites THIS plugin's row in
  // the profile patch file, the way the real service persists a choice.
  const edits = []
  const configEditor = {
    // The REAL shape: the service hands out the Loader's own entries.
    entries: () => ([{ options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: { backupIncludePlugins: true } } }]),
    edit: async (entry, change) => {
      const next = change({ enabled: true, backupOnRestart: true, backupIncludePlugins: true }, {})
      edits.push(next)
      const yaml = fs.readFileSync(profileFile, 'utf8').replace(
        /^(\s*backupIncludePlugins:)\s*\S+$/m,
        `$1 ${next.backupIncludePlugins}`,
      )
      fs.writeFileSync(profileFile, yaml, 'utf8')
    },
  }

  const { ctx, routes } = createContext({ services: { configEditor } })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const server = http.createServer((req, res) => {
    const requestPath = (req.url || '').split('?')[0]
    const route = routes.find((entry) => entry.path === requestPath)
    if (!route) {
      res.statusCode = 404
      res.end('{"ok":false}')
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const post = (body) => fetch(`http://127.0.0.1:${port}${CHOICE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  try {
    const before = fs.readFileSync(profileFile, 'utf8')

    // 1) an illegal answer must be refused with 400 and change nothing.
    const bad = await post({ includePlugins: 'definitely-not-a-boolean' })
    assert.equal(bad.status, 400, 'a non-boolean must be refused')
    assert.equal(fs.readFileSync(profileFile, 'utf8'), before, 'the profile must not change')
    assert.equal(edits.length, 0, 'nothing may be written into the profile configuration')

    // 2) a legal answer must really change the profile configuration.
    const good = await post({ includePlugins: false })
    assert.equal(good.status, 200)
    assert.deepEqual(await good.json(), { ok: true, applied: 'config', includePlugins: false })
    assert.match(
      fs.readFileSync(profileFile, 'utf8'),
      /backupIncludePlugins: false/,
      'the profile row must really change',
    )

    // 3) the original value must be restorable right away.
    const back = await post({ includePlugins: true })
    assert.equal(back.status, 200)
    assert.deepEqual(await back.json(), { ok: true, applied: 'config', includePlugins: true })
    assert.match(
      fs.readFileSync(profileFile, 'utf8'),
      /backupIncludePlugins: true/,
      'the restore must work',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the option rows are clickable as a whole and carry the radio semantics', () => {
  const storage = createStorage()
  const fetches = []
  const mounted = mountBackupChoicePanel({ storage, fetches })
  const tree = mounted.render()

  const rows = walk(tree).filter((node) => node.props && node.props.role === 'radio')
  assert.equal(rows.length, 2, 'both options must be rows with the radio role')
  for (const row of rows) {
    assert.equal(row.props['aria-checked'], 'false', 'a radio row must declare aria-checked')
    assert.equal(row.props.tabIndex, 0, 'a radio row must be focusable')
    assert.ok(row.props.onClick, 'the whole row must be clickable')
    assert.ok(row.props.onKeyDown, 'the whole row must answer the keyboard')
  }

  // Clicking the ROW (not the button) records the answer.
  const plugins = rows.find((row) => row.props['data-backup-choice'] === 'plugins')
  plugins.props.onClick()
  assert.equal(storage.getItem(CHOICE_KEY), 'plugins', 'the row itself must record the answer')
  const calls = fetches.filter((call) => String(call.url).endsWith('/choice'))
  assert.equal(calls.length, 1, 'the row click must call the Host exactly once')
  assert.deepEqual(JSON.parse(calls[0].init.body), { includePlugins: true })
})

test('the primary option is recommended and both buttons say what they do', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const mounted = mountBackupChoicePanel({ storage: createStorage(), fetches: [] })
  const tree = mounted.render()

  // ① the buttons carry a concrete action, not a vague "choose".
  const buttons = walk(tree).filter((node) => node.type === 'button' && node.props.className.includes('__cta'))
  assert.equal(buttons.length, 2, 'both options must have their own button')
  const primary = buttons.find((node) => node.props.className.includes('--primary'))
  const secondary = buttons.find((node) => node.props.className.includes('--secondary'))
  assert.ok(primary && secondary, 'one primary and one secondary button are expected')
  assert.equal(primary.children[0], '用这个', 'the primary button must say what it does')
  assert.equal(secondary.children[0], '只备份配置', 'the secondary button must say what it does')
  assert.equal(zh.backupChoicePickPrimary, '用这个')
  assert.equal(zh.backupChoicePickSecondary, '只备份配置')

  // ② the "recommended" pill is on the primary option only.
  const badges = walk(tree).filter((node) => node.props && node.props.className === 'dsh-autorestart-choice__badge')
  assert.equal(badges.length, 1, 'only the recommended option carries the pill')
  assert.equal(badges[0].children[0], '推荐', 'the pill must say 推荐')
  assert.equal(zh.backupChoiceRecommended, '推荐')
  assert.equal(en.backupChoiceRecommended, 'Recommended')
  assert.equal(mounted.dictionaries.dshAutorestart.en.backupChoiceRecommended, 'Recommended')

  // ③ the stylesheet carries the breathing card and the radio semantics.
  const style = mounted.styles.find((node) => node.id === 'dsh-autorestart-choice')
  assert.match(style.textContent, /box-shadow/, 'the card must have a shadow')
  assert.match(style.textContent, /border-radius:12px/, 'the card must use the 12px radius')
  assert.match(style.textContent, /cursor:pointer/, 'the row must show a pointer cursor')
  assert.match(style.textContent, /@media \(max-width:640px\)/, 'the buttons must wrap on a narrow screen')
  const rows = walk(tree).filter((node) => node.props && node.props.role === 'radio')
  assert.ok(
    rows.length === 2 && rows.every((row) => row.props['aria-checked'] !== undefined),
    'the rows must expose aria-checked',
  )
})

test('both options share the "configuration" base and are never two parallel nouns', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const mounted = mountBackupChoicePanel({ storage: createStorage(), fetches: [] })
  const dictionaries = mounted.dictionaries.dshAutorestart

  // ① no copy presents the plugins and the configuration as two rivals.
  const zhCopy = [...Object.values(dictionaries.zh), ...Object.entries(dictionaries.zh).filter(([key]) => key.startsWith('backupChoice')).map(([, value]) => value)]
  for (const value of zhCopy) {
    assert.doesNotMatch(value, /插件\s*(或|还是|vs\.?)\s*配置/, `parallel wording: ${value}`)
    assert.doesNotMatch(value, /备份\s*插件/, `parallel wording: ${value}`)
  }
  const enCopy = [...Object.values(dictionaries.en), ...Object.entries(dictionaries.en).filter(([key]) => key.startsWith('backupChoice')).map(([, value]) => value)]
  for (const value of enCopy) {
    assert.doesNotMatch(value, /\bplugins?\b\s*(or|vs\.?)\s*\bconfiguration\b/i, `parallel wording: ${value}`)
  }

  // ② both option names carry the configuration base.
  assert.ok(zh.backupChoiceWithPlugins.includes('配置'), 'the first option must name the configuration')
  assert.ok(zh.backupChoiceConfigOnly.includes('配置'), 'the second option must name the configuration')
  assert.ok(dictionaries.zh.backupChoiceWithPlugins.includes('配置'))
  assert.ok(dictionaries.zh.backupChoiceConfigOnly.includes('配置'))
  assert.ok(en.backupChoiceWithPlugins.toLowerCase().includes('configuration'))
  assert.ok(en.backupChoiceConfigOnly.toLowerCase().includes('configuration'))
})

test('the two option texts live in the locale files and state the time cost', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

  assert.ok(zh.backupChoiceTitle, 'locale/zh.json must carry the backupChoice texts')
  assert.ok(en.backupChoiceTitle, 'locale/en.json must carry the backupChoice texts')

  assert.match(zh.backupChoiceWithPluginsHint, /3 秒/, 'the zh copy must state the extra time')
  assert.match(zh.backupChoiceWithPluginsHint, /117 MB/)
  assert.match(zh.backupChoiceConfigOnlyHint, /66 KB/)
  assert.match(zh.backupChoiceConfigOnlyHint, /瞬间完成/, 'the zh copy must say that the config-only backup is instant')

  assert.match(en.backupChoiceWithPluginsHint, /3 seconds/, 'the en copy must state the extra time')
  assert.match(en.backupChoiceWithPluginsHint, /117 MB/)
  assert.match(en.backupChoiceConfigOnlyHint, /66 KB/)
  assert.match(en.backupChoiceConfigOnlyHint, /instant/i, 'the en copy must say that the config-only backup is instant')

  // The footnote points at the settings section — the ONE place where these
  // answers can be changed (the plugin row no longer carries a form).
  assert.match(zh.backupChoiceFootnote, /自动重启与关机/, 'the zh copy must say where the answer can be changed')
  assert.match(en.backupChoiceFootnote, /Auto-restart & shut down/, 'the en copy must say where the answer can be changed')
  assert.doesNotMatch(
    zh.backupChoiceFootnote,
    /设置 → 插件/,
    'the footnote must not point at the old plugin row any more',
  )
  assert.doesNotMatch(
    en.backupChoiceFootnote,
    /Settings → Plugins/,
    'the footnote must not point at the old plugin row any more',
  )
})

test('the client renders exactly the texts of the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  // The locale files are the MIRROR of the client dictionaries: the same key
  // carries the same text.
  const keys = [
    'backupChoiceTitle',
    'backupChoiceBody',
    'backupChoiceWithPlugins',
    'backupChoiceWithPluginsHint',
    'backupChoiceConfigOnly',
    'backupChoiceConfigOnlyHint',
    'backupChoiceFootnote',
    'backupChoicePickPrimary',
    'backupChoicePickSecondary',
    'backupChoiceRecommended',
    'backupChoiceDismissAria',
  ]

  const mounted = mountBackupChoicePanel({ storage: createStorage(), fetches: [] })
  const dictionaries = mounted.dictionaries.dshAutorestart
  for (const key of keys) {
    assert.equal(dictionaries.zh[key], zh[key], `zh.${key} must match the client copy`)
    assert.equal(dictionaries.en[key], en[key], `en.${key} must match the client copy`)
  }

  const tree = mounted.render()
  const text = textOf(tree)
  assert.ok(text.includes(zh.backupChoiceWithPlugins), 'the panel must show the "configuration + plugins" option')
  assert.ok(text.includes(zh.backupChoiceConfigOnly), 'the panel must show the "configuration only" option')
  assert.ok(text.includes(zh.backupChoiceWithPluginsHint), 'the panel must show the time cost')
  assert.ok(text.includes(zh.backupChoiceFootnote), 'the panel must say where the answer can be changed')
})


// ---------------------------------------------------------------------------
// THE WATCHDOG ANSWER (2026-11-01) - the "saved" that saved nothing.
//
// Field report: the panel said "the watchdog is on" and install-choice.json was
// never touched. Two independent faults made that possible:
//   - the /choice route did not know the two keys, so it answered 400;
//   - the client never looked at the answer and printed "saved" anyway.
// These two tests pin both halves.
// ---------------------------------------------------------------------------

test('the watchdog answer is accepted and really written to install-choice.json', async () => {
  const { dir, file } = tempStateDir('watchdog')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  choiceRoute(routes).handler(
    fakeRequest('POST', { watchdog: true, askedForPluginVersion: '0.8.7' }),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 200, 'the route must not reject the watchdog keys')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.watchdog, true, 'the answer repeats what was stored')
  assert.equal(body.askedForPluginVersion, '0.8.7')

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'install-choice.json'), 'utf8'))
  assert.equal(saved.watchdog, true, 'the answer must land in the file the panel reads')
  assert.equal(saved.askedForPluginVersion, '0.8.7', 'and the version, or it asks again forever')
})

test('the watchdog answer survives as "no", and a non-boolean is refused', async () => {
  const { dir, file } = tempStateDir('watchdog-no')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const ok = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { watchdog: false, askedForPluginVersion: '1.0.0' }), ok)
  await settle()
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'install-choice.json'), 'utf8')).watchdog, false)

  const bad = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', { watchdog: 'yes' }), bad)
  await settle()
  assert.equal(bad.statusCode, 400, 'a non-boolean answer is refused')
  assert.equal(bad.body.includes('watchdog-must-be-boolean'), true)
})

test('the client never reports success it did not verify', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const panel = source.slice(source.indexOf('function WatchdogAskPanel'))
  const answerPart = panel.slice(0, panel.indexOf('const rows = ['))

  // 1. it must look at the response at all
  assert.match(answerPart, /response\.ok === true/, 'the panel must check response.ok')

  // 2. the failure path must record a failure, not an answer
  assert.match(answerPart, /saved = false/, 'the request starts out NOT saved')

  // 3. THE REGRESSION ITSELF: the old code called setAnswered('on'|'off')
  //    unconditionally, in both the success and the catch branch. That line must
  //    be gone: the verdict may only be set from `saved`.
  assert.equal(
    /setAnswered\(keepOn === true \? 'on' : 'off'\)/.test(answerPart),
    false,
    'the answer must never be recorded without checking the response',
  )
  assert.match(answerPart, /setAnswered\(saved === true/, 'the verdict comes from what was verified')
})