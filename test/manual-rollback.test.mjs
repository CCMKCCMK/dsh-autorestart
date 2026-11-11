/**
 * THE MANUAL ROLLBACK (user decision, 2026-10-30).
 *
 * The automatic rollback only ever restores the newest PROVEN copy — but the
 * user may know better ("the version from last week worked"), so the settings
 * page may restore ANY copy in the list. Four rules are pinned here:
 *
 *   1. ASKING IS A STATE, NOT A CLICK. The row button only opens the question;
 *      the route is called from the confirmation card and nowhere else, and a
 *      cancel posts nothing at all.
 *   2. THE CURRENT STATE IS SAVED FIRST. A snapshot of the profile as it is now
 *      is written BEFORE the picked copy is restored — so a manual rollback can
 *      itself be undone. The test proves the ORDER by content: the safety copy
 *      holds the new state, the profile ends with the old one.
 *   3. A NAME, NEVER A PATH. The input has to match a name the Host reports;
 *      `../`, a drive letter or a separator is refused before anything is read,
 *      and an unknown name is refused after the lookup.
 *   4. THE RESTART IS THE NORMAL ONE. The plugin requests it; it never kills the
 *      host itself.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, createRuntime, normalizeConfig } from '../index.js'
import {
  backupsRoot,
  claimRollbackLock,
  listBackupIdentities,
  readManifest,
  releaseRollbackLock,
  writeBackupMeta,
} from '../lib/backup.js'

/* ------------------------------------------------------------------ *
 * The host half.
 * ------------------------------------------------------------------ */

/** A profile, a state directory and the backups root of it. */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-manual-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: current\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
  const stateDir = path.join(base, 'storage')
  fs.mkdirSync(stateDir, { recursive: true })
  return {
    base,
    profile,
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    backups: backupsRoot(stateDir),
  }
}

/** One copy on disk: a manifest, its identity, and the file it restores. */
function seedCopy(backups, stamp, { patch, kind = 'snapshot', version = null } = {}) {
  const dir = path.join(backups, stamp)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), patch, 'utf8')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    at: 1793325600000,
    atLocal: '2026-10-30T09:00:00+08:00',
    bytes: patch.length,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  assert.equal(writeBackupMeta(dir, { kind, at: 1793325600000, version }), true)
  return dir
}

/** The Cordis context the runtime needs. */
function hostContext() {
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: {
      get: () => undefined,
      disarm: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
}

/** A runtime on that fixture. */
function runtimeOn(fixture_, overrides = {}) {
  return createRuntime(hostContext(), normalizeConfig({
    stateFile: fixture_.stateFile,
    backupOnRestart: true,
    backupIncludePlugins: false,
    maxBackups: 3,
    ...overrides,
  }), { env: { isDesktopApp: false, appExePath: null } })
}

/* ------------------------------------------------------------------ *
 * ② THE ORDER: save the current state, THEN restore, THEN restart.
 * ------------------------------------------------------------------ */

test('② a manual rollback saves the current state first, restores the picked copy, then restarts', async (t) => {
  const setup = fixture(t, 'order')
  const target = seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', {
    patch: 'rows:\n  - id: old-target\n',
    kind: 'known-good',
    version: '0.8.5',
  })
  const runtime = runtimeOn(setup)

  const result = await runtime.manualRollback({ name: '2026-10-20T01-00-00-000Z' })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.status, 200)

  // ① THE SAFETY COPY EXISTS — and it holds the state from BEFORE the restore,
  // which is the only proof that the order is "save, then overwrite".
  assert.equal(typeof result.receipt.safetySnapshot, 'string')
  assert.ok(fs.existsSync(result.receipt.safetySnapshot), 'the safety snapshot is on disk')
  const safetyManifest = readManifest(result.receipt.safetySnapshot)
  assert.ok(safetyManifest, 'the safety copy carries a manifest')
  assert.ok(
    result.receipt.safetySnapshot.startsWith(setup.backups + path.sep),
    'the safety copy lives in the backups directory of this host',
  )
  const safetyPatch = fs.readFileSync(
    path.join(result.receipt.safetySnapshot, 'config', 'cordis.patch.yml'),
    'utf8',
  )
  assert.equal(safetyPatch, 'rows:\n  - id: current\n', 'the safety copy keeps the CURRENT state')

  // ② THE PICKED COPY IS BACK over the profile.
  assert.equal(
    fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: old-target\n',
    'the profile holds the picked copy now',
  )
  assert.equal(result.receipt.name, '2026-10-20T01-00-00-000Z')
  assert.equal(result.receipt.dir, target)
  assert.equal(result.receipt.kind, 'known-good')
  assert.equal(result.receipt.version, '0.8.5')
  assert.ok(result.receipt.restored.includes('cordis.patch.yml'))

  // ③ A NORMAL RESTART was requested — the plugin does not kill anything itself.
  assert.equal(result.receipt.restartRequested, true)
  assert.ok(runtime.state.restart && typeof runtime.state.restart === 'object', 'a restart is pending')
  assert.match(String(runtime.state.restart.reason), /manual rollback/)
  assert.match(String(runtime.state.restart.reason), /2026-10-20T01-00-00-000Z/)

  // ④ The receipt is on disk, for the next boot.
  const receiptFile = path.join(setup.stateDir, 'last-manual-rollback.json')
  assert.ok(fs.existsSync(receiptFile), 'the receipt is written next to the checkpoint')
  const stored = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  assert.equal(stored.ok, true)
  assert.equal(stored.restartRequested, true)
})

test('② an OLDER copy than the newest known-good can be restored on purpose', async (t) => {
  const setup = fixture(t, 'older')
  seedCopy(setup.backups, '2026-10-25T01-00-00-000Z', { patch: 'rows:\n  - id: newest-proven\n', kind: 'known-good' })
  seedCopy(setup.backups, '2026-10-10T01-00-00-000Z', { patch: 'rows:\n  - id: old-and-unverified\n', kind: 'unknown' })
  const runtime = runtimeOn(setup)

  // The automatic rollback would never pick the unverified one — the user may.
  const result = await runtime.manualRollback({ name: '2026-10-10T01-00-00-000Z' })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.receipt.kind, 'unknown', 'the copy keeps the identity it has')
  assert.equal(
    fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: old-and-unverified\n',
    'the profile holds the copy the USER picked, not the newest proven one',
  )
})

/* ------------------------------------------------------------------ *
 * ③ A NAME THAT IS NOT IN THE LIST, OR NOT A NAME AT ALL.
 * ------------------------------------------------------------------ */

test('③ a path — or a traversal — is refused before anything is read', async (t) => {
  const setup = fixture(t, 'traversal')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: target\n' })
  const runtime = runtimeOn(setup)
  const before = fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8')
  const copiesBefore = listBackupIdentities(setup.backups).length

  for (const name of ['../2026-10-20T01-00-00-000Z', '..\\secrets', '/etc/passwd', 'C:\\Windows\\win.ini', 'a/b']) {
    const result = await runtime.manualRollback({ name })
    assert.equal(result.ok, false, `the name ${name} must be refused`)
    assert.equal(result.status, 400, `status of ${name}`)
    assert.match(String(result.error), /not a backup name/)
  }
  for (const name of ['', '   ', undefined, 42]) {
    const result = await runtime.manualRollback({ name })
    assert.equal(result.ok, false, 'an empty name is refused')
    assert.equal(result.status, 400)
  }

  assert.equal(
    fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8'),
    before,
    'the profile is untouched',
  )
  assert.equal(listBackupIdentities(setup.backups).length, copiesBefore, 'no copy was written either')
  assert.equal(runtime.state.restart, null, 'and no restart was requested')
})

test('③ a name that is simply not in the list is refused, without touching anything', async (t) => {
  const setup = fixture(t, 'unknown-name')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: target\n' })
  const runtime = runtimeOn(setup)

  const result = await runtime.manualRollback({ name: '2026-01-01T00-00-00-000Z' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
  assert.match(String(result.error), /no such backup/)
  assert.equal(
    fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: current\n',
    'the profile is untouched',
  )
  assert.equal(runtime.state.restart, null)
})

test('③ a rollback that is already running wins: the manual one stands down', async (t) => {
  const setup = fixture(t, 'locked')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: target\n' })
  const runtime = runtimeOn(setup)
  const lock = claimRollbackLock(setup.stateDir)
  assert.equal(lock.ok, true)

  const result = await runtime.manualRollback({ name: '2026-10-20T01-00-00-000Z' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.match(String(result.error), /another rollback is already running/)
  assert.equal(
    fs.readFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: current\n',
    'nothing was overwritten while the other rollback holds the lock',
  )
  releaseRollbackLock(setup.stateDir)
})

/* ------------------------------------------------------------------ *
 * THE ROUTE: POST /rollback-to, loopback only, POST only.
 * ------------------------------------------------------------------ */

/** Mount `apply()` and hand back the routes the plugin registered. */
function mountRoutes(t, label) {
  const setup = fixture(t, label)
  const routes = []
  const ctx = hostContext()
  ctx.get = (name) => (name === 'webServer'
    ? {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
      tapIndex: () => () => {},
      getOrigin: () => 'http://127.0.0.1:5601',
    }
    : undefined)
  apply(ctx, { stateFile: setup.stateFile, enabled: true, recoveryDelayMs: 0 })
  t.after(() => {
    try {
      releaseRollbackLock(setup.stateDir)
    } catch {}
  })
  const routeOf = (suffix) => routes.find((route) => String(route.path).endsWith(suffix))
  return { ...setup, routes, routeOf }
}

/** A request/response pair good enough for the JSON routes. */
function callRoute(route, { method = 'POST', body = null, remote = '127.0.0.1' } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json' },
    on: (event, fn) => {
      if (event === 'data') for (const chunk of chunks) fn(chunk)
      if (event === 'end') fn()
      return req
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body = String(value ?? '') },
  }
  route.handler(req, res)
  return new Promise((resolve) => setTimeout(() => {
    let json = null
    try {
      json = JSON.parse(res.body)
    } catch {}
    resolve({ status: res.statusCode, headers: res.headers, json, text: res.body })
  }, 20))
}

test('the rollback route exists, refuses other methods, and answers JSON', async (t) => {
  const mounted = mountRoutes(t, 'route')
  seedCopy(mounted.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: target\n' })
  const route = mounted.routeOf('/rollback-to')
  assert.ok(route, 'the manual rollback route is registered')
  assert.match(String(route.path), /^\/__dsh_autorestart\//)

  const refused = await callRoute(route, { method: 'GET' })
  assert.equal(refused.status, 405)
  assert.equal(refused.json.ok, false)
  assert.equal(refused.headers.allow, 'POST')
})

test('the rollback route refuses a path, an unknown name, and restores a real one', async (t) => {
  const mounted = mountRoutes(t, 'route-calls')
  seedCopy(mounted.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: target\n' })
  const route = mounted.routeOf('/rollback-to')

  const traversal = await callRoute(route, { body: { name: '../../etc/passwd' } })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.json.ok, false)
  assert.match(String(traversal.json.error), /not a backup name/)

  const unknown = await callRoute(route, { body: { name: '2026-01-01T00-00-00-000Z' } })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.ok, false)

  const done = await callRoute(route, { body: { name: '2026-10-20T01-00-00-000Z' } })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.json.ok, true)
  assert.equal(done.json.restartRequested, true)
  assert.equal(done.json.receipt.name, '2026-10-20T01-00-00-000Z')
  assert.equal(
    fs.readFileSync(path.join(mounted.profile, 'cordis.patch.yml'), 'utf8'),
    'rows:\n  - id: target\n',
    'the route really restored the copy',
  )
})

/* ------------------------------------------------------------------ *
 * The client half: asking is a state, and a cancel posts nothing.
 * ------------------------------------------------------------------ */

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

/** Whether two dependency lists are the same. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** A localStorage stand-in. */
function createStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

/** Every node of a rendered tree. */
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

/** Two copies as the Host reports them (t29's payload, plus the rollback URL). */
function backupPayload() {
  const dir = 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups'
  return {
    rollbackUrl: '/__dsh_autorestart/rollback-to',
    dir,
    max: 3,
    count: 2,
    items: [
      {
        name: '2026-10-30T01-00-00-000Z',
        dir: dir + '\\2026-10-30T01-00-00-000Z',
        at: 1793325600000,
        atLocal: '2026-10-30T09:00:00+08:00',
        bytes: 163577856,
        files: 42,
        includePlugins: true,
        kind: 'known-good',
        version: '0.8.5',
        // A CARD IS DRAWN ONLY FOR A PROVEN COPY (2026-11-02), and only a card
        // carries "回退到这一份" — so both fixtures are proven ones here. The rule
        // itself (a seed or a snapshot gets no button) is pinned in
        // settings-startup-backup.test.mjs.
        certifiedBy: 'full-checks',
        certificationEvidence: 'fingerprint-match',
      },
      {
        name: '2026-10-28T01-00-00-000Z',
        dir: dir + '\\2026-10-28T01-00-00-000Z',
        at: 1793152800000,
        atLocal: '2026-10-28T09:00:00+08:00',
        bytes: 94208,
        files: 3,
        includePlugins: false,
        kind: 'known-good',
        version: null,
        certifiedBy: 'manual-rollback',
        certificationEvidence: 'fingerprint-match',
      },
    ],
  }
}

/** Load the client script in a sandbox and mount the settings panel. */
function mountSettings({ info = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
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
      head: {
        appendChild: (node) => { node.parentNode = sandbox.document.head; return node },
        removeChild: () => {},
      },
      querySelector: () => null,
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init: init || {} })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, ...info }),
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
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
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
        const entry = (produced && typeof produced.next === 'function') ? produced.next().value : produced
        if (entry && entry.registration && entry.registration.id === id) return entry.Component
      }
    }
    assert.fail(`the component ${id} must be registered`)
  }

  return {
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

/** The nodes that carry one `data-dsh-autorestart-backup` key. */
function marked(panel, key) {
  return walk(panel).filter((node) => node.props && node.props[key] !== undefined)
}

/** Every POST to the rollback route the panel made. */
function rollbackPosts(mounted) {
  return mounted.fetches.filter((entry) => String(entry.url).includes('/rollback-to') && entry.init && entry.init.method === 'POST')
}

test('① the row button only ASKS — nothing is posted until the user confirms', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: backupPayload(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const buttons = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
  )
  assert.equal(buttons.length, 2, 'every copy offers the rollback')
  assert.equal(buttons[0].props['data-backup-name'], '2026-10-30T01-00-00-000Z')
  assert.equal(textOf(buttons[0]), '回退到这一份')

  // OPENING the question: no request, not even one.
  buttons[0].props.onClick()
  const asked = mounted.render('dsh-autorestart')
  assert.equal(rollbackPosts(mounted).length, 0, 'opening the card posts nothing')
  const card = marked(asked, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm',
  )
  assert.equal(card.length, 1, 'the confirmation card is on screen')
  const cardText = textOf(card[0])
  assert.ok(cardText.includes('2026-10-30 09:00'), `it names the copy: ${cardText}`)
  assert.ok(cardText.includes('当前状态会被它覆盖'), `it says what is replaced: ${cardText}`)
  assert.ok(cardText.includes('会自动重启'), `it says that a restart follows: ${cardText}`)
  // THE FACT THE USER ASKED FOR, PINNED VERBATIM (2026-11-02): the restart after
  // a rollback takes NO further backup. "A restart follows" alone would keep
  // passing while that promise went missing, so the sentence itself is checked.
  const restartLine = marked(asked, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm-restart',
  )
  assert.equal(restartLine.length, 1, 'the restart sentence is its own line on the card')
  assert.equal(
    textOf(restartLine[0]),
    '还原完成后会自动重启一次：回退前已自动存了一份可撤回的现场；回退后的这次重启不会再额外备份。重启期间这个页面会断开，回来后接着用。',
    'verbatim — including that this restart takes no extra backup',
  )
  assert.equal(
    textOf(restartLine[0]).includes('不会再额外备份'),
    true,
    'and that exact fact is in it, not only "a restart follows"',
  )

  // CANCEL: still nothing posted, and the card goes away.
  const cancel = marked(asked, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm-no',
  )
  assert.equal(cancel.length, 1)
  cancel[0].props.onClick()
  const cancelled = mounted.render('dsh-autorestart')
  assert.equal(rollbackPosts(mounted).length, 0, 'a cancel never posts')
  assert.equal(
    marked(cancelled, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm',
    ).length,
    0,
    'the card is gone',
  )
})

test('① a confirmation posts the NAME to the route and says what is happening', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: backupPayload(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const buttons = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
  )
  // The OLD one (second row): the user may restore a copy that is not the newest.
  buttons[1].props.onClick()
  const asked = mounted.render('dsh-autorestart')
  const yes = marked(asked, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm-yes',
  )
  assert.equal(yes.length, 1)
  yes[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))

  const posts = rollbackPosts(mounted)
  assert.equal(posts.length, 1, 'exactly one POST, after the confirmation')
  assert.equal(String(posts[0].url), '/__dsh_autorestart/rollback-to')
  assert.deepEqual(JSON.parse(posts[0].init.body), { name: '2026-10-28T01-00-00-000Z' })

  const after = mounted.render('dsh-autorestart')
  const note = marked(after, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-note',
  )
  assert.equal(note.length, 1, 'the panel says what is happening')
  assert.equal(textOf(note[0]), '已回退，正在重启…')
  assert.equal(
    marked(after, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm',
    ).length,
    0,
    'the card is gone once the rollback was accepted',
  )
})

test('④ the panel no longer writes the old tier out — and the true sentences stay', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: backupPayload(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)
  const value = (key) => {
    const found = marked(panel, 'data-dsh-autorestart-backup')
      .filter((node) => node.props['data-dsh-autorestart-backup'] === key)
    return found.length === 0 ? '' : textOf(found[0])
  }
  // THE OLD TIER'S WORDS ARE GONE (user report, 2026-11-02). They said a backup
  // has "one of two identities" and that only a "safe" copy is ever rolled back —
  // while every row on this page carries its own rollback button. A user who
  // believed that paragraph did not dare press the button on an older copy, so
  // the words must not be on the page at all: no badge, no line, no paragraph.
  // The middle group left the dictionary with the certificate vocabulary: the
  // source that "signed", the moment it was "checked" and the criterion behind it
  // are no longer keys at all, so a page that reintroduced any of them would fail
  // here as well.
  for (const word of [
    '安全份',
    '本次快照',
    '旧备份（未验证）',
    '只会回滚安全份',
    '认证依据',
    '未认证',
    '认证于',
    '认证判据',
    '已验证',
    '可放心回退',
    '已知可用',
  ]) {
    assert.equal(
      text.includes(word),
      false,
      `the panel must NOT say "${word}" any more: ${text.slice(0, 400)}`,
    )
  }
  // ...WHILE THE SENTENCES THAT ARE TRUE ARE STILL THERE, verbatim: the deletion
  // must not take them with it (they were checked against the real page). The copy
  // block is TWO lines now (user report, 2026-11-02): line 1 counts the copies and
  // the disk they take, line 2 states the rule — the paragraph and the bare fact
  // that repeated that rule are gone.
  assert.match(
    value('count'),
    /^当前 2 份，实际占用 [\d.]+ (B|KB|MB|GB)。$/,
    'line 1: the copies and the disk they take',
  )
  assert.equal(
    value('keep'),
    '最多保留 3 份，超出自动删最旧的那份。',
    'line 2: the retention rule, with the limit in force',
  )
  assert.equal(value('purpose'), '', 'the paragraph that repeated the limit is gone')
  assert.equal(value('max-effective'), '', 'and so is the bare duplicate of it')
  assert.equal(value('footprint'), '', 'and the separate footprint line it replaced')
  assert.equal(
    value('kinds-local'),
    '自己写的插件（直接放在本机目录里的）都已完整备份，可以回档。',
    'the plugins you wrote yourself are in the copy in full',
  )
  assert.equal(
    value('kinds-third-party'),
    '第三方插件由插件作者维护，有异常建议重装',
    'third-party plugins: reinstall, do not roll back',
  )
  assert.equal(
    value('limit-hint'),
    '备份会占用磁盘空间，建议尽量选更少的备份数。',
    'the disk-space hint, now beside the dropdown',
  )
})

test('④ the rollback speaks English too, and never shows a key name', async () => {
  const mounted = mountSettings({
    language: 'en',
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: backupPayload(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const buttons = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
  )
  assert.equal(textOf(buttons[0]), 'Roll back to this copy')
  buttons[0].props.onClick()
  const asked = mounted.render('dsh-autorestart')
  const cardText = textOf(marked(asked, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm',
  )[0])
  assert.ok(cardText.includes('A restart follows automatically'), cardText)
  assert.equal(/settings\.backup\./.test(textOf(asked)), false, 'no key name on screen')
})
