/**
 * The settings page: "what is backed up right now" and "how was this host
 * started".
 *
 * Two rules are pinned here:
 *
 *   - the DESKTOP client shows neither the startup block nor a command to
 *     derive: it brings itself back up and must never write a restart
 *     command;
 *   - the HOSTED client sees ONE plain line ("I remember you were started
 *     this way"), two small actions, and the command itself folded away — the
 *     command text is not in the page until somebody opens the fold.
 *
 * The backup list is read by the HOST (the browser cannot see the disk), and
 * it reads the directory only: one copy can be 150 MB, so its contents are
 * never walked.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { createRuntime, normalizeConfig } from '../index.js'
import { backupsRoot, listBackups, writeBackupMeta } from '../lib/backup.js'

/* ------------------------------------------------------------------ *
 * A tiny React stand-in and the client harness.
 * ------------------------------------------------------------------ */

/** Whether two dependency lists are the same. */
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

/**
 * Load the client script in a sandbox and mount the settings section.
 *
 * @param {{ info?: object, language?: string }} options the state payload the
 *   Host would report, and the language of the interface
 */
function mountSettings({
  info = {},
  language = 'zh',
  inventory = null,
  restoreAnswer = null,
  announcements = [],
  supervisor = null,
} = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  // The stylesheet the client injects (the settings panel lives in it), kept so
  // a test can read the rules it writes.
  const styles = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => { definition = value },
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
      head: {
        appendChild: (node) => {
          if (node && node.tag === 'style') styles.push({ id: node.id, text: node.textContent })
          node.parentNode = sandbox.document.head
          return node
        },
        removeChild: () => {},
      },
      querySelector: () => null,
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/health')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, pendingRestart: false, ...info }),
        })
      }
      if (target.includes('/plugin-inventory')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (inventory === null ? { ok: true, plugins: [] } : inventory),
        })
      }
      if (target.includes('/plugin-restore')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (restoreAnswer === null ? { ok: true } : restoreAnswer),
        })
      }
      if (target.includes('/announcements')) {
        // GET = which announcements the user has not answered yet; POST = the
        // acknowledgement of one of them.
        if (init && init.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, pending: announcements }) })
      }
      if (target.includes('/supervisor')) {
        // The route answers per action: `derive` / `dry-run` / `apply` /
        // `revert` / `install` / `uninstall`.
        const asked = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}
        const answer = supervisor && supervisor[asked.action]
          ? supervisor[asked.action]
          : { ok: true, action: asked.action }
        const status = typeof answer.status === 'number' ? answer.status : 200
        return Promise.resolve({
          ok: status < 400,
          status,
          json: async () => answer,
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false }),
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
    dictionaries,
    fetches,
    styles,
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
    render: (id, props) => harness.render(componentOf(id), props || {}),
  }
}

/** The nodes of the rendered tree that carry one `data-dsh-autorestart-*` key. */
function marked(panel, key) {
  return walk(panel).filter((node) => node.props && node.props[key] !== undefined)
}

/* ------------------------------------------------------------------ *
 * The panel.
 * ------------------------------------------------------------------ */

test('the desktop client shows no startup block at all', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      restart: { mode: 'app', command: '', written: false, canRevert: false, previous: null },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.ok(panel, 'the settings section must be rendered')

  // The desktop client brings itself back up: no startup line, no actions,
  // no fold, nothing that could write a restart command.
  const nodes = marked(panel, 'data-dsh-autorestart-supervisor')
  const keys = nodes.map((node) => node.props['data-dsh-autorestart-supervisor'])
  for (const forbidden of ['startup-status', 'derive', 'redetect', 'revert', 'apply', 'details', 'written', 'previous']) {
    assert.equal(keys.includes(forbidden), false, 'the desktop client must not show ' + forbidden)
  }
  assert.equal(textOf(panel).includes('我记下的启动方式'), false, 'no startup line at all')
  // The BACKUP group has its own folds now (user decision, 2026-11-02), so this
  // asks about the SUPERVISOR fold specifically — the one that must be absent.
  const folds = walk(panel).filter(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-supervisor'] === 'details',
  )
  assert.equal(folds.length, 0, 'no supervisor fold either')
})

test('an unknown host stays hidden — not shown and misleading', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'auto', installed: false },
      restart: { mode: 'command', command: '', written: false, canRevert: false, previous: null },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const status = marked(panel, 'data-dsh-autorestart-supervisor').filter(
    (node) => node.props['data-dsh-autorestart-supervisor'] === 'startup-status',
  )
  assert.equal(status.length, 1, 'the line is there')
  assert.equal(textOf(status[0]), '我看不出你是怎么启动的（我不猜，也不会自己乱拉）', 'the honest copy')
  // Nothing that writes a command.
  const writes = marked(panel, 'data-dsh-autorestart-supervisor').filter(
    (node) => node.props['data-dsh-autorestart-supervisor'] === 'apply'
      || node.props['data-dsh-autorestart-supervisor'] === 'derive',
  )
  assert.equal(writes.length, 0, 'an unknown host gets no button that writes a command')
})

test('a hosted host that somebody else supervises sees one line and two small actions', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: {
        mode: 'external',
        installed: false,
        startup: { mode: 'external', evidence: 'parent:1234: supervise.sh' },
      },
      restart: { mode: 'command', command: '', written: false, canRevert: false, previous: null },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const nodes = marked(panel, 'data-dsh-autorestart-supervisor')
  const status = nodes.filter((node) => node.props['data-dsh-autorestart-supervisor'] === 'startup-status')
  assert.equal(status.length, 1, 'exactly one line')
  assert.equal(textOf(status[0]), '我记下的启动方式：由你的脚本拉起（重启交给它，我不插手）', 'the plain copy')

  const redetect = nodes.filter((node) => node.props['data-dsh-autorestart-supervisor'] === 'redetect')
  assert.equal(redetect.length, 1, 'the "detect again" action')
  const revert = nodes.filter((node) => node.props['data-dsh-autorestart-supervisor'] === 'revert')
  assert.equal(revert.length, 1, 'the "undo" action')
  assert.equal(revert[0].props.disabled, true, 'nothing to undo → the button says so')

  // The command itself is folded away, and it is not in the page yet. The backup
  // group has its own folds, so the SUPERVISOR one is selected by its marker.
  const folds = walk(panel).filter(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-supervisor'] === 'details',
  )
  assert.equal(folds.length, 1, 'the supervisor fold exists')
  assert.equal(folds[0].props.open, undefined, 'the fold starts closed')
  assert.equal(textOf(folds[0].children[0]), '技术细节', 'the fold says "technical details"')
})

test('a bare host that has no command yet gets the "help me" button', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'auto', installed: false, startup: { mode: 'bare' } },
      restart: { mode: 'command', command: '', written: false, canRevert: false, previous: null },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const nodes = marked(panel, 'data-dsh-autorestart-supervisor')
  const status = nodes.filter((node) => node.props['data-dsh-autorestart-supervisor'] === 'startup-status')
  assert.equal(textOf(status[0]), '我还不知道怎么把你拉起来', 'the honest copy')
  const derive = nodes.filter((node) => node.props['data-dsh-autorestart-supervisor'] === 'derive')
  assert.equal(derive.length, 1, 'the "help me find out how to restart" button')
  assert.equal(textOf(derive[0]), '帮我看看怎么重启')
})

test('a bare host with a confirmed command says so', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'auto', installed: false, startup: { mode: 'bare' } },
      restart: { mode: 'command', command: 'node /srv/dsh/web.js', written: true, canRevert: true, previous: null },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const status = marked(panel, 'data-dsh-autorestart-supervisor').filter(
    (node) => node.props['data-dsh-autorestart-supervisor'] === 'startup-status',
  )
  assert.equal(textOf(status[0]), '我记下的启动方式：按你确认过的那条命令重启')
  const revert = marked(panel, 'data-dsh-autorestart-supervisor').filter(
    (node) => node.props['data-dsh-autorestart-supervisor'] === 'revert',
  )
  assert.equal(revert[0].props.disabled, false, 'there is something to undo')
})

test('the command text only appears after the fold was opened', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'auto', installed: false, startup: { mode: 'bare' } },
      restart: {
        mode: 'command',
        command: 'node /srv/dsh/web.js --port 5601',
        written: true,
        canRevert: true,
        previous: { restartMode: 'app', restartCommand: '' },
      },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  // The command is NOT in the page while the fold is closed.
  assert.equal(textOf(panel).includes('node /srv/dsh/web.js'), false, 'the command is not shown by default')
  const fold = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-supervisor'] === 'details',
  )
  assert.ok(fold, 'the fold exists')

  // The user opens it: the command is there.
  fold.props.onToggle({ target: { open: true } })
  const opened = mounted.render('dsh-autorestart')
  assert.equal(textOf(opened).includes('node /srv/dsh/web.js --port 5601'), true, 'the command is visible now')
  assert.equal(textOf(opened).includes('以下是插件实际会执行的命令'), true, 'the fold explains what it shows')
})

/* ------------------------------------------------------------------ *
 * The backups on disk.
 * ------------------------------------------------------------------ */

test('the backup list reads the directory, not the copies inside it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-backups-'))
  const backups = path.join(root, 'backups')
  fs.mkdirSync(backups, { recursive: true })

  // Two copies with their manifests — and a file that claims to be huge.
  const first = path.join(backups, '2026-10-29T00-25-20-000Z')
  const second = path.join(backups, '2026-10-28T00-25-20-000Z')
  fs.mkdirSync(path.join(first, 'node_modules'), { recursive: true })
  fs.mkdirSync(second, { recursive: true })
  fs.writeFileSync(path.join(first, 'node_modules', 'tiny.txt'), 'x', 'utf8')
  fs.writeFileSync(path.join(first, 'manifest.json'), JSON.stringify({
    at: 1793244300000,
    atLocal: '2026-10-29T08:25:20+08:00',
    bytes: 123456789,
    files: ['cordis.patch.yml', 'package.json'],
    includePlugins: true,
  }), 'utf8')
  fs.writeFileSync(path.join(second, 'manifest.json'), JSON.stringify({
    at: 1793157900000,
    atLocal: '2026-10-28T08:25:20+08:00',
    bytes: 1024,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')

  const items = listBackups(backups)
  assert.equal(items.length, 2, 'both copies are listed')
  assert.equal(items[0].name, '2026-10-29T00-25-20-000Z', 'the newest copy comes first')
  assert.equal(items[0].atLocal, '2026-10-29T08:25:20+08:00', 'the LOCAL time, not the UTC directory name')
  assert.equal(items[0].bytes, 123456789, 'the size comes from the manifest — the tree is never walked')
  assert.equal(items[0].includePlugins, true, 'the manifest says whether the plugins are in it')
  assert.equal(items[1].includePlugins, false)
  assert.equal(items[0].dir, path.join(backups, '2026-10-29T00-25-20-000Z'), 'where it lives')
})

test('the settings page shows the count, the local time, the size and the path', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: {
        dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups',
        max: 2,
        count: 1,
        items: [
          {
            name: '2026-10-29T00-25-20-000Z',
            dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-10-29T00-25-20-000Z',
            at: 1793244300000,
            atLocal: '2026-10-29T08:25:20+08:00',
            bytes: 123456789,
            files: 2,
            includePlugins: true,
            // A proven copy: only such a one is drawn as a card (2026-11-02).
            kind: 'known-good',
            certifiedBy: 'full-checks',
            certificationEvidence: 'fingerprint-match',
          },
        ],
      },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const nodes = marked(panel, 'data-dsh-autorestart-backup')
  const value = (key) => {
    const found = nodes.filter((node) => node.props['data-dsh-autorestart-backup'] === key)
    return found.length === 0 ? '' : textOf(found[0])
  }
  // HOW MANY ARE USABLE, next to how many exist (user decision, 2026-11-02).
  assert.equal(value('count'), '当前 1 份，可用于回退的 1 份', 'the count, and how many of them could save the user')
  assert.equal(value('keep'), '最多保留 2 份，超出自动删最旧的那份。', 'the keep limit')
  assert.equal(value('time'), '2026-10-29 08:25', 'the local time, to the minute and without the offset')
  assert.equal(value('size'), '117.7 MB', 'the size, with the tenth that says something')
  assert.equal(value('plugins'), '（含已装插件）', 'whether the plugins are in it')
  assert.equal(value('path'), 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups', 'where they live')
})

/* ------------------------------------------------------------------ *
 * THE BACKUP LIST, one GROUP per backup (user report, 2026-10-29).
 *
 * The old list was ONE run-on line — "2026-10-29 22:08:46+08:00 156.0 MB
 * 含已装插件" — which read as a string of numbers: no offset is needed (the
 * time IS the local clock), the time and the size ran into each other, and
 * the size had no name. Each backup is now two labelled rows, and two
 * backups are two groups with air between them.
 * ------------------------------------------------------------------ */

/** Two backups as the manifest reports them, rendered by the panel. */
function twoBackups() {
  return {
    dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups',
    max: 2,
    count: 2,
    items: [
      {
        name: '2026-10-29T14-08-46-000Z',
        dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-10-29T14-08-46-000Z',
        at: 1793244526000,
        atLocal: '2026-10-29T22:08:46+08:00',
        bytes: 163577856,
        files: 42,
        includePlugins: true,
        // A FULL CARD IS ONLY DRAWN FOR THE COPY THAT COULD BE USED (2026-11-02),
        // so the two fixtures are proven copies: this file is about the rows of a
        // card, not about which copies get one (that is pinned further down).
        kind: 'known-good',
        certifiedBy: 'full-checks',
        certificationEvidence: 'fingerprint-match',
      },
      {
        name: '2026-10-28T01-12-30-000Z',
        dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-10-28T01-12-30-000Z',
        at: 1793159550000,
        atLocal: '2026-10-28T09:12:30+08:00',
        bytes: 94208,
        files: 3,
        includePlugins: false,
        kind: 'known-good',
        certifiedBy: 'manual-rollback',
        certificationEvidence: 'fingerprint-match',
      },
    ],
  }
}

/** The rendered text of every node that carries one backup key, in order. */
function backupValues(panel, key) {
  return marked(panel, 'data-dsh-autorestart-backup')
    .filter((node) => node.props['data-dsh-autorestart-backup'] === key)
    .map((node) => textOf(node))
}

test('a backup names its time and its size, and never prints a timezone offset', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)

  // ① The two rows say WHAT they are.
  assert.ok(text.includes('备份时间'), `the time row must be labelled: ${text}`)
  assert.ok(text.includes('备份大小'), `the size row must be labelled: ${text}`)

  // ② No offset anywhere — it is the local clock of the machine that took it.
  assert.equal(/[+-]\d{2}:\d{2}/.test(text), false, `no timezone offset may be printed: ${text}`)
  assert.equal(text.includes('+08'), false, 'no +08 either')

  // To the minute: the seconds never say anything.
  assert.deepEqual(
    backupValues(panel, 'time'),
    ['2026-10-29 22:08', '2026-10-28 09:12'],
    'the local time, to the minute, without the offset',
  )
  assert.equal(/22:08:\d{2}/.test(text), false, 'no seconds')
})

test('the size is written with the unit that fits it, and no pointless .0', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)

  // ③ 156 MB, never 156.0 MB. ④ 92 KB stays in KB.
  assert.deepEqual(backupValues(panel, 'size'), ['156 MB', '92 KB'], 'the unit follows the byte count')
  assert.equal(text.includes('156.0'), false, `no pointless tenth: ${text}`)
  assert.equal(text.includes('0.1 MB'), false, '92 KB must not be shown as a fraction of a MB')

  // The plugin scope travels with the size (it explains the size), in brackets.
  assert.deepEqual(
    backupValues(panel, 'plugins'),
    ['（含已装插件）', '（不含已装插件）'],
    'whether the plugins are in it, right after the size',
  )
})

test('two backups are two spaced groups, each with a labelled time row and size row', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  // ⑤ ONE group per backup, with the two rows inside it.
  const groups = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(groups.length, 2, 'two backups are two groups')
  for (const [index, group] of groups.entries()) {
    assert.equal(
      String(group.props.className).includes('dsh-autorestart-settings__backup'),
      true,
      `the group of backup ${index + 1} has its own class`,
    )
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    // DEFAULT SINCE 2026-11-02: the four evidence rows are folded away, so only
    // the time and the size are on screen. The incident's lesson is kept by the
    // half below: opening 详情 must bring every row back.
    assert.equal(rows.length, 2, `backup ${index + 1} shows its time and size rows; the evidence rows are folded`)
    const fold = walk(group).find((node) => node.type === 'details'
      && node.props && node.props['data-dsh-autorestart-backup'] === 'list-details')
    assert.ok(fold, `backup ${index + 1} has a 详情 fold`)
    assert.equal(fold.props.open, undefined, `backup ${index + 1} starts folded: this boot was not rescued`)
    fold.props.onToggle({ target: { open: true } })
  }
  // OPENED: every row is there again — evidence is never unreachable.
  const opened = mounted.render('dsh-autorestart')
  const openedGroups = marked(opened, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  for (const [index, group] of openedGroups.entries()) {
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    assert.equal(rows.length, 6, `backup ${index + 1} shows all six rows once 详情 is opened`)
    const marks = new Set(walk(group)
      .map((node) => node.props && node.props['data-dsh-autorestart-backup'])
      .filter((value) => typeof value === 'string'))
    for (const name of ['time', 'size', 'certified', 'certification-evidence', 'certified-at', 'scope', 'intervention']) {
      assert.equal(marks.has(name), true, `backup ${index + 1} shows its "${name}" row once opened`)
    }
  }

  // ...and the stylesheet keeps two groups apart (>= 8px, as asked).
  const style = mounted.styles.find((entry) => entry.id === 'dsh-autorestart-sleep')
  assert.ok(style, 'the settings stylesheet must be injected')
  const spacing = /\.dsh-autorestart-settings__backup \+ \.dsh-autorestart-settings__backup\{margin-top:(\d+)px;\}/.exec(style.text)
  assert.ok(spacing, `two groups must be spaced on purpose: ${style.text.slice(0, 400)}`)
  assert.ok(Number(spacing[1]) >= 8, `the gap between two backups must be at least 8px: ${spacing[0]}`)
})

/* ------------------------------------------------------------------ *
 * THE IDENTITY OF EVERY COPY (user decision, 2026-10-30).
 *
 * Only a copy a boot has PROVEN may be rolled back to, so the list cannot
 * stop at "one more timestamp": every copy says WHAT it is. The identity comes
 * from the Host (the browser cannot read meta.json), and the words on the row
 * only mean something next to the rule — hence the paragraph above the list.
 * ------------------------------------------------------------------ */

/** The three identities as the Host reports them, newest first. */
function threeIdentities() {
  const dir = 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups'
  return {
    dir,
    max: 3,
    count: 3,
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
        certifiedBy: 'full-checks',
        certificationEvidence: 'fingerprint-match',
      },
      {
        name: '2026-10-29T01-00-00-000Z',
        dir: dir + '\\2026-10-29T01-00-00-000Z',
        at: 1793239200000,
        atLocal: '2026-10-29T09:00:00+08:00',
        bytes: 163577856,
        files: 42,
        includePlugins: true,
        kind: 'snapshot',
        version: null,
      },
      {
        name: '2026-10-28T01-00-00-000Z',
        dir: dir + '\\2026-10-28T01-00-00-000Z',
        at: 1793152800000,
        atLocal: '2026-10-28T09:00:00+08:00',
        bytes: 94208,
        files: 3,
        includePlugins: false,
        kind: 'unknown',
        version: null,
      },
    ],
  }
}

/** A Cordis context just big enough for `createRuntime`. */
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

/** One copy on disk: a manifest and the identity the Host resolves. */
function identityCopy(backups, stamp, { kind, version = null, bytes = 1024 } = {}) {
  const dir = path.join(backups, stamp)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    at: 1793325600000,
    atLocal: '2026-10-30T09:00:00+08:00',
    bytes,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  if (kind !== undefined) {
    assert.equal(writeBackupMeta(dir, { kind, at: 1793325600000, version }), true, 'the identity is written')
  }
  return dir
}

test('① every copy reports its own kind — known-good, snapshot or unknown', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-kinds-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const stateFile = path.join(base, 'state.json')
  const backups = backupsRoot(base)
  fs.mkdirSync(backups, { recursive: true })
  // Newest first on disk, one copy per identity — and the oldest one has NO
  // meta.json at all, which is exactly what a copy from before the identity
  // layer looks like.
  identityCopy(backups, '2026-10-30T01-00-00-000Z', { kind: 'known-good', version: '0.8.5' })
  identityCopy(backups, '2026-10-29T01-00-00-000Z', { kind: 'snapshot' })
  identityCopy(backups, '2026-10-28T01-00-00-000Z', {})

  const runtime = createRuntime(hostContext(), normalizeConfig({ stateFile, backupOnRestart: true, maxBackups: 3 }), {
    env: { isDesktopApp: false, appExePath: null },
  })
  const info = runtime.backupsInfo()
  assert.equal(info.count, 3, 'all three copies are listed')
  assert.deepEqual(
    info.items.map((item) => item.kind),
    ['known-good', 'snapshot', 'unknown'],
    'each copy carries the identity it really has — never a guess',
  )
  assert.equal(info.items[0].version, '0.8.5', 'the version the known-good copy was proven with')
  assert.equal(info.items[1].version, null, 'a snapshot was proven with nothing')
  assert.equal(info.items[2].version, null, 'an old copy carries no version')
  for (const item of info.items) {
    assert.equal(typeof item.dir, 'string', 'the interface still gets the path')
    assert.equal(typeof item.bytes, 'number', 'and the size')
    assert.equal(typeof item.at, 'number', 'and the time')
  }
})

test('② only the copy that could save the user is written out as a card', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  // ONE card, and it is the proven copy (user decision, 2026-11-02): the other
  // two are still listed, but as one small line each — the page must answer
  // "which copy saves me?" with exactly one card.
  assert.deepEqual(
    backupValues(panel, 'kind'),
    ['安全份'],
    'only the proven copy is drawn as a card, and it says what it is',
  )
  assert.deepEqual(
    backupValues(panel, 'version'),
    [],
    'no plugin version on a card — it reads like a downgrade notice and proves nothing',
  )
  assert.equal(textOf(panel).includes('版本 0.8.5'), false, 'the version is not printed anywhere')
  const lines = backupValues(panel, 'other-line')
  assert.equal(lines.length, 2, 'the two unproven copies are two small lines')
  assert.ok(lines[0].includes('2026-10-29 09:00'), `the snapshot names its time: ${lines[0]}`)
  assert.ok(lines[0].includes('156 MB'), `the snapshot names its size: ${lines[0]}`)
  assert.ok(lines[0].includes('不会被自动还原'), `the snapshot says it is never restored automatically: ${lines[0]}`)
  assert.ok(lines[1].includes('2026-10-28 09:00'), `the old copy names its time: ${lines[1]}`)
  assert.equal(
    marked(panel, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
    ).length,
    1,
    'only the copy that could be used offers the rollback — a seed or a snapshot must not be one click away',
  )
  // The identity leads the group: it decides whether the copy may be restored
  // at all, so it must not be buried under the numbers.
  // The evidence rows are folded by default (2026-11-02): this case reads them
  // in the OPENED state, because what it guards is that they exist and say the
  // right thing — not that they are on screen by default.
  for (const fold of walk(panel).filter((node) => node.type === 'details'
    && node.props && node.props['data-dsh-autorestart-backup'] === 'list-details')) {
    fold.props.onToggle({ target: { open: true } })
  }
  const openedPanel = mounted.render('dsh-autorestart')
  const groups = marked(openedPanel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(groups.length, 1, 'one proven copy, one card')
  for (const [index, group] of groups.entries()) {
    const first = walk(group).find((node) => node.props && node.props['data-dsh-autorestart-backup'] === 'kind')
    assert.ok(first, `backup ${index + 1} names its identity`)
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    // SIX ROWS SINCE 2026-11-01: the identity is followed by its evidence
    // (certified by / WHICH CRITERION / content scope / intervention), and the
    // time and size rows are still there — one each, as before.
    assert.equal(rows.length, 6, `backup ${index + 1} keeps the time row, the size row and the evidence rows`)
  }
  assert.deepEqual(
    backupValues(openedPanel, 'certified'),
    ['四项启动自检全过'],
    'the card says who proved it — and it is the proven copy',
  )
  assert.deepEqual(
    backupValues(openedPanel, 'certification-evidence'),
    ['指纹比对通过（新判据）'],
    'and WHICH criterion was checked, which is what makes the seal worth something',
  )
  assert.deepEqual(
    backupValues(openedPanel, 'intervention'),
    ['没有记录'],
    'an unrecorded intervention is shown as unrecorded, never as "no"',
  )
})

test('③ the paragraph above the list spells out the rules: 3 copies, only known-good is rolled back', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const hint = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'identity-hint',
  )
  assert.equal(hint.length, 1, 'the explanation exists exactly once')
  const text = textOf(hint[0])
  assert.ok(text.includes('保留 3 份'), `the retention rule is stated with the real number: ${text}`)
  assert.ok(text.includes('只会回滚安全份'), `only a known-good copy is rolled back: ${text}`)
  assert.ok(text.includes('第一次安装'), 'the first install seeds a known-good copy')
  assert.ok(text.includes('旧备份（未验证）'), 'an old copy is never rolled back automatically')
  assert.ok(text.includes('二次确认'), 'a manual rollback asks first')
  assert.ok(text.includes('重启'), 'and then restarts')
})

test('④ the identities speak English too, and the paragraph follows the language', async () => {
  const mounted = mountSettings({
    language: 'en',
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.deepEqual(
    backupValues(panel, 'kind'),
    ['Known good'],
    'the English user reads the same one card, under the same rule',
  )
  const lines = backupValues(panel, 'other-line')
  assert.equal(lines.length, 2, 'the two unproven copies are two small lines in English too')
  assert.ok(lines[0].includes('never restored automatically'), `and say what they are: ${lines[0]}`)
  const hint = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'identity-hint',
  )
  const text = textOf(hint[0])
  assert.ok(text.includes('known-good copy is rolled back'), `only known-good in English: ${text}`)
  assert.ok(text.includes('3 copies'), `the retention rule in English: ${text}`)
})

test('the backup list speaks English too', async () => {
  const mounted = mountSettings({
    language: 'en',
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)
  assert.ok(text.includes('Backup time'), `the English time label: ${text}`)
  assert.ok(text.includes('Backup size'), `the English size label: ${text}`)
  assert.deepEqual(backupValues(panel, 'plugins'), ['(plugins included)', '(plugins excluded)'])
  assert.deepEqual(backupValues(panel, 'size'), ['156 MB', '92 KB'])
  assert.equal(/[+-]\d{2}:\d{2}/.test(text), false, 'no offset in English either')
})

test('without a backup the page says so', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: { dir: 'C:\\backups', max: 2, count: 0, items: [] },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const empty = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'empty',
  )
  assert.equal(empty.length, 1, 'the empty state is there')
  assert.equal(textOf(empty[0]), '还没有备份；每次重启前会自动生成一份。')
})

/* ------------------------------------------------------------------ *
 * THE DESKTOP ENTRY OF THE RESCUE GROUP (user report, 2026-11-02).
 *
 * The shortcut was invisible in two ways: it was not where the user's desktop
 * really is, and a `.cmd` cannot carry an icon so it looked like a blank page.
 * The page therefore SAYS what it looks like and what it is for — and on a
 * platform without a desktop it says that instead of going blank.
 * ------------------------------------------------------------------ */

/** What the Host answers for the rescue kit. */
function rescueKit(overrides = {}) {
  return {
    pluginDir: 'C:\\plugin',
    platform: 'win32',
    scriptsDir: 'C:\\plugin\\scripts',
    restoreProfile: 'C:\\plugin\\scripts\\restore-profile.cmd',
    emergencyDisable: 'C:\\plugin\\scripts\\emergency-disable.cmd',
    desktopDir: 'C:\\Users\\Tester\\Desktop',
    desktopSource: 'registry',
    shortcutPath: 'C:\\Users\\Tester\\Desktop\\DSH 出事了双击这里.lnk',
    shortcutName: 'DSH 出事了双击这里.lnk',
    shortcutExists: false,
    iconPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    ...overrides,
  }
}

/** The rendered text of one rescue mark. */
function rescueText(panel, key) {
  const found = marked(panel, 'data-dsh-autorestart-rescue')
    .filter((node) => node.props['data-dsh-autorestart-rescue'] === key)
  return found.length === 0 ? '' : textOf(found[0])
}

test('the desktop entry shows its icon and its file name, and says what it is for', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  // ① WHAT IT LOOKS LIKE: the icon tile and the file name, before the button.
  assert.notEqual(rescueText(panel, 'shortcut-icon'), '', 'the icon is drawn, so the desktop entry is recognisable')
  assert.equal(rescueText(panel, 'shortcut-name'), 'DSH 出事了双击这里.lnk', 'and the exact file name is on screen')
  assert.match(rescueText(panel, 'shortcut-name'), /\.lnk$/, 'a .lnk — that is the format that can carry an icon')
  // ② REMINDER ONE: only for a host that does not come up.
  assert.match(rescueText(panel, 'shortcut-when'), /打不开/, 'the first reminder is on the page')
  assert.match(rescueText(panel, 'shortcut-when'), /不要点它/, 'and it says not to click it while DSH runs')
  // ③ REMINDER TWO: it rolls the whole environment back, not one plugin.
  assert.match(rescueText(panel, 'shortcut-scope'), /整个环境/, 'the second reminder is on the page')
  assert.match(rescueText(panel, 'shortcut-scope'), /不能只摘掉某一个插件/, 'and it sends one-plugin recovery elsewhere')
  // ④ The button is there, and it is still a button (nothing is written on load).
  assert.equal(rescueText(panel, 'shortcut'), '在桌面放一个快捷方式')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/rescue')).length,
    0,
    'loading the page neither writes nor asks the rescue route',
  )
})

test('a platform without a desktop says so instead of hiding the block', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit({
        platform: 'linux',
        scriptsDir: '/plugin/scripts',
        restoreProfile: '/plugin/scripts/restore-profile.sh',
        emergencyDisable: '/plugin/scripts/emergency-disable.sh',
        desktopDir: '',
        desktopSource: 'none',
        shortcutPath: '',
        iconPath: '',
      }),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = rescueText(panel, 'no-desktop-platform')
  assert.match(text, /网页版 \/ 服务器版没有桌面/, `the platform is named: ${text}`)
  assert.match(text, /\.sh/, 'and it points at the scripts that DO work here')
  assert.equal(rescueText(panel, 'shortcut'), '', 'no button where there is no desktop to put it on')
  assert.equal(rescueText(panel, 'no-desktop'), '', 'the "no desktop directory" line is for Windows, not for other platforms')

  // THE SENTENCE MUST NOT LIE (audit finding G1): "use the two .sh scripts
  // above" is only allowed when the paths are really rendered — on a platform
  // without a desktop they are the ONLY way out, so they are never folded.
  const paths = marked(panel, 'data-dsh-autorestart-rescue')
    .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'path')
    .map((node) => textOf(node))
  assert.deepEqual(
    paths,
    ['/plugin/scripts/restore-profile.sh', '/plugin/scripts/emergency-disable.sh'],
    'both .sh path ARE on the page, in full',
  )
  assert.equal(
    marked(panel, 'data-dsh-autorestart-rescue')
      .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'copy-path').length,
    2,
    'each one can be copied',
  )
  // ...and they are not hidden behind a fold on this platform.
  assert.equal(
    walk(panel).filter((node) => node.type === 'details'
      && node.props && node.props['data-dsh-autorestart-rescue'] === 'paths-details').length,
    0,
    'the paths are always visible where there is no desktop entry',
  )
})

test('on Windows the script paths are there too — folded, and always in the tree', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const paths = marked(panel, 'data-dsh-autorestart-rescue')
    .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'path')
    .map((node) => textOf(node))
  assert.deepEqual(paths, [
    'C:\\plugin\\scripts\\restore-profile.cmd',
    'C:\\plugin\\scripts\\emergency-disable.cmd',
  ], 'the real paths are rendered, not promised')
  const fold = walk(panel).find((node) => node.type === 'details'
    && node.props && node.props['data-dsh-autorestart-rescue'] === 'paths-details')
  assert.ok(fold, 'the paths sit behind 详情 on Windows — the shortcut is the main door there')
  assert.equal(fold.props.open, undefined, 'and it starts closed')
})

test('a Windows machine whose desktop cannot be found gets the manual instruction', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit({ desktopDir: '', desktopSource: 'none', shortcutPath: '', iconPath: '' }),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.match(rescueText(panel, 'no-desktop'), /没有桌面目录/)
  assert.equal(rescueText(panel, 'shortcut'), '', 'nothing to press without a desktop')
  // The two reminders stay: the block never shrinks into a dead end.
  assert.notEqual(rescueText(panel, 'shortcut-when'), '')
  assert.notEqual(rescueText(panel, 'shortcut-scope'), '')
  // AND THE PATHS ARE OPEN, because there is no button to use instead.
  const fold = walk(panel).find((node) => node.type === 'details'
    && node.props && node.props['data-dsh-autorestart-rescue'] === 'paths-details')
  assert.ok(fold, 'the fold exists')
  assert.equal(fold.props.open, true, 'and it opens itself when the shortcut cannot be placed')
})

/* ------------------------------------------------------------------ *
 * ONE FOLD FOR THE WHOLE EXPLANATION (user decision, 2026-11-02).
 *
 * The block answered too many questions at once and pushed the switches out
 * of sight. It is closed by default under one title — except on a boot the
 * watchdog had to rescue, where the one fact that matters must not be hidden.
 * ------------------------------------------------------------------ */

/** The one fold of the backup explanation, if the page drew it. */
function backupFold(panel) {
  return walk(panel).filter(
    (node) => node.type === 'details'
      && node.props && node.props['data-dsh-autorestart-backup'] === 'section',
  )
}

test('the whole backup explanation is one fold, closed by default', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const folds = backupFold(panel)
  assert.equal(folds.length, 1, 'one fold, not four')
  assert.equal(folds[0].props.open, undefined, 'it starts closed: the switches stay on screen')

  const summary = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'section-summary',
  )
  assert.equal(summary.length, 1, 'the fold has its own title')
  // The TITLE is the first child; a second, smaller line was added on
  // 2026-11-02 ("what is inside"), so the summary starts with the title instead
  // of being only it.
  assert.equal(summary[0].children[0], '备份说明及手动备份操作', 'the title the user asked for')
  assert.equal(
    textOf(summary[0]).startsWith('备份说明及手动备份操作'),
    true,
    `the title still leads the summary: ${textOf(summary[0])}`,
  )

  // EVERY word the task listed lives inside that one fold — the count and the
  // rules, the cards, the path and the per-plugin recovery.
  const inside = new Set(walk(folds[0]).map((node) => node.props && node.props['data-dsh-autorestart-backup'])
    .filter((value) => typeof value === 'string'))
  for (const key of ['list', 'count', 'keep', 'identity-hint', 'evidence-hint', 'time', 'size', 'path', 'copy-path']) {
    assert.equal(inside.has(key), true, `"${key}" is inside the fold`)
  }
  // ...and the per-plugin recovery too, which lives in its own key space.
  assert.equal(
    walk(folds[0]).filter((node) => node.props && node.props['data-dsh-autorestart-recovery'] === 'title').length,
    1,
    'the per-plugin recovery is inside the same fold',
  )
  // ...and the switches are NOT inside it: a switch inside a closed fold is a
  // setting nobody finds.
  assert.equal(inside.has('backupOnRestart'), false, 'the switches stay outside the fold')
})

test('a boot the watchdog rescued opens the fold and says so on the title', async () => {
  const backups = twoBackups()
  backups.items[0].intervention = true
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups,
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const folds = backupFold(panel)
  assert.equal(folds.length, 1)
  assert.equal(folds[0].props.open, true, 'an intervention must never be hidden behind a closed fold')
  const summary = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'section-summary',
  )
  assert.ok(textOf(summary[0]).includes('有（自动救援动过手）'), `the title says why it is open: ${textOf(summary[0])}`)
})

/* ------------------------------------------------------------------ *
 * THE SEED IS NOT A SAFE COPY (user report, 2026-11-02).
 *
 * The host stamps the first-install seed with `kind: 'known-good'` and
 * `certifiedBy: 'seed'` — a label, not a proof. The page called it "安全份",
 * which is the one thing it must never do.
 * ------------------------------------------------------------------ */

/** One seed (config only, never proven) and nothing else. */
function seedOnly(extra = {}) {
  return {
    dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups',
    max: 2,
    count: 1,
    items: [
      {
        name: '2026-10-31T01-00-00-000Z',
        dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-10-31T01-00-00-000Z',
        at: 1793412000000,
        atLocal: '2026-10-31T09:00:00+08:00',
        bytes: 69632,
        files: 3,
        includePlugins: false,
        kind: 'known-good',
        certifiedBy: 'seed',
        certificationEvidence: 'none',
        contentScope: 'config-only',
        ...extra,
      },
    ],
  }
}

test('the first-install seed is never shown as 安全份 — it is one line, with no button', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: seedOnly(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.deepEqual(backupValues(panel, 'kind'), [], 'a seed gets no card and no identity badge')
  // THE WEAK, MIXED ASSERTION IS SPLIT (2026-11-02). The old line was
  // `textOf(panel).includes('安全份') === true` — which only proved that the
  // four characters appear SOMEWHERE in the panel. It would pass just as well
  // if a card wrongly said 安全份, i.e. it could not fail on the very mistake
  // this test exists to catch.
  //
  // What is asserted now is where the word may live: inside the paragraphs that
  // EXPLAIN it (the identity hint and the certification hint), and nowhere else
  // — not in an item, not in a badge, not in a line.
  const occurrences = (text, needle) => String(text).split(needle).length - 1
  const hintMarkers = new Set(['identity-hint', 'evidence-hint'])
  const hints = marked(panel, 'data-dsh-autorestart-backup')
    .filter((node) => hintMarkers.has(node.props['data-dsh-autorestart-backup']))
  assert.ok(hints.length > 0, 'the rule is explained somewhere')
  const explained = hints.reduce((sum, node) => sum + occurrences(textOf(node), '安全份'), 0)
  assert.ok(explained > 0, 'the paragraphs do explain what a 安全份 is')
  assert.equal(
    occurrences(textOf(panel), '安全份'),
    explained,
    'every mention of 安全份 in the panel lives in an explaining paragraph — no badge, no card, no line',
  )
  const marks = marked(panel, 'data-dsh-autorestart-backup')
    .filter((node) => node.props['data-dsh-autorestart-backup'] === 'kind')
  assert.equal(marks.length, 0, 'no badge says 安全份 about a seed')
  const lines = backupValues(panel, 'other-line')
  assert.equal(lines.length, 1, 'the seed is one small line')
  assert.ok(
    lines[0].includes('另有一份首装备份（只含设置、未验证，仅在前一份不可用时才用）'),
    `the seed line says exactly what it is: ${lines[0]}`,
  )
  assert.ok(lines[0].includes('2026-10-31 09:00'), `with its time: ${lines[0]}`)
  assert.ok(lines[0].includes('68 KB'), `and its size: ${lines[0]}`)
  assert.equal(
    marked(panel, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
    ).length,
    0,
    'a seed offers no rollback button: restoring it must not be one click away',
  )
  assert.deepEqual(
    backupValues(panel, 'count'),
    ['当前 1 份，可用于回退的 0 份'],
    'the count is honest: nothing here could be used automatically',
  )
})

/* ------------------------------------------------------------------ *
 * THE SAME THREE RULES ON A HOSTED WEB HOST (2026-11-02).
 *
 * Every test above that pins the fold, the "安全份" rule and the removed plugin
 * version renders with `isDesktopApp: true`. The page is also what a `dsh web`
 * user sees, and that is a different `instance` record — so the same three
 * promises are asserted here with `isDesktopApp: false`, instead of assuming
 * the desktop rendering stands for both.
 * ------------------------------------------------------------------ */

test('hosted: the fold, the seed rule and the absent version hold on a web host too', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'external', installed: false, startup: { mode: 'external' } },
      // A version string the page must NOT print: it told the user nothing
      // about whether a copy is safe (user report, 2026-11-02).
      pluginVersion: '9.9.9-version-marker',
      backups: seedOnly(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  // (1) THE FOLD IS THERE, closed, with its own title.
  const folds = backupFold(panel)
  assert.equal(folds.length, 1, 'the backup block is one fold on a web host as well')
  assert.notEqual(folds[0].props.open, true, 'and it starts closed')

  // (2) THE SEED IS STILL NOT A 安全份: one line, no card, no badge, no button.
  assert.deepEqual(backupValues(panel, 'kind'), [], 'no badge says 安全份 about a seed')
  const lines = backupValues(panel, 'other-line')
  assert.equal(lines.length, 1, 'the seed is one small line here too')
  assert.ok(lines[0].includes('未验证'), `the line says it is unproven: ${lines[0]}`)
  assert.equal(
    marked(panel, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'rollback',
    ).length,
    0,
    'and no rollback button is offered for it',
  )
  assert.deepEqual(backupValues(panel, 'count'), ['当前 1 份，可用于回退的 0 份'], 'the count is honest')

  // (3) THE MEANINGLESS VERSION NUMBER IS NOT PRINTED — checked against a
  // marker value, so the assertion can fail if the page ever shows it again.
  assert.equal(
    textOf(panel).includes('9.9.9-version-marker'),
    false,
    'the plugin version must not be printed in the backup block',
  )
  assert.equal(
    marked(panel, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'version',
    ).length,
    0,
    'and no node carries a version any more',
  )
})

test('the same copy WITH a verifiable proof is a 安全份 card', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: seedOnly({ certifiedBy: 'full-checks', certificationEvidence: 'fingerprint-match' }),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.deepEqual(backupValues(panel, 'kind'), ['安全份'], 'the proof is what makes it safe — the kind is not')
  assert.deepEqual(backupValues(panel, 'other-line'), [], 'and then there is nothing to demote')
})

test('a known-good KIND without a checkable criterion is not a 安全份 either', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: seedOnly({ certifiedBy: 'full-checks', certificationEvidence: 'none' }),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.deepEqual(backupValues(panel, 'kind'), [], 'the old stamp that cannot be checked is not a safe copy')
  const lines = backupValues(panel, 'other-line')
  assert.equal(lines.length, 1, 'it is listed as one line, honestly')
  assert.ok(lines[0].includes('不会被自动还原'), `and says it is never restored automatically: ${lines[0]}`)
})

/* ------------------------------------------------------------------ *
 * THE PER-PLUGIN RECOVERY LIVES IN THAT FOLD (user report, 2026-11-02).
 *
 * "I dismissed the floating card, and after that the 只恢复 X button was gone."
 * The same state and the same route calls are mounted in the backup fold, so the
 * way back is where a user looks for it.
 * ------------------------------------------------------------------ */

/** What the inventory route answers while the check runs. */
function inventoryFixture() {
  return {
    ok: true,
    plugins: [
      { name: 'my-linked-plugin', status: 'different', linked: true, install: 'link' },
      // Installed from npm TODAY, but the copy holds its files from when it was
      // linked: it has to be listed (and never merged into "we did not back them
      // up") — this is the dsh-codekg report.
      { name: 'npm-but-in-copy', status: 'same', linked: false, install: 'npm' },
      { name: 'vendor-plugin', status: 'missing', linked: false, install: 'npm', version: '1.2.3' },
      { name: 'fine-plugin', status: 'same', linked: true, install: 'link' },
      { name: 'dsh-mnemon', status: 'missing', linked: false, install: 'builtin', version: '0.9.0' },
    ],
  }
}

test('the per-plugin recovery is inside the backup fold, and 只恢复 X really posts', async () => {
  const mounted = mountSettings({
    inventory: inventoryFixture(),
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  // The block is inside the fold, under its own title, and it does NOT talk to
  // the route until the button is pressed.
  const folds = backupFold(panel)
  assert.equal(
    walk(folds[0]).filter((node) => node.props && node.props['data-dsh-autorestart-recovery'] === 'title').length,
    1,
    'the recovery block lives inside the one fold',
  )
  const title = walk(folds[0]).find((node) => node.props && node.props['data-dsh-autorestart-recovery'] === 'title')
  assert.equal(textOf(title), '某个插件起不来？退回它的上一个版本')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/plugin-inventory')).length,
    0,
    'nothing is asked until the user presses 立即检查',
  )

  const check = walk(panel).find((node) => node.props && node.props['data-dsh-autorestart-recovery'] === 'check')
  assert.equal(textOf(check), '立即检查')
  check.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const checked = mounted.render('dsh-autorestart')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/plugin-inventory')).length,
    1,
    'one request, when the button was pressed',
  )

  const rows = marked(checked, 'data-dsh-autorestart-recovery')
  const names = rows.filter((node) => node.props['data-dsh-autorestart-recovery'] === 'name').map(textOf)
  // ONLY the plugins we hold files for are listed one by one (user decision,
  // 2026-11-02): a plugin the copy does not hold is merged into its sentence
  // instead. `npm-but-in-copy` IS listed — the copy has its files.
  assert.deepEqual(
    names,
    ['my-linked-plugin', 'npm-but-in-copy', 'fine-plugin'],
    'the plugins the copy holds have rows',
  )

  const restores = rows.filter((node) => node.props['data-dsh-autorestart-recovery'] === 'restore')
  assert.equal(restores.length, 1, 'only the plugin we hold files for offers a restore')
  assert.equal(textOf(restores[0]), '只恢复 my-linked-plugin', 'the button names the plugin')

  // THE TWO SENTENCES (user correction, 2026-11-02). The old wording
  // ("备份里只有名字和版本，重装即可") implied the copy held something; it holds
  // nothing, so the third-party line has to say exactly that.
  const thirdParty = rows.filter((node) => node.props['data-dsh-autorestart-recovery'] === 'third-party')
  assert.equal(thirdParty.length, 1, 'one sentence for the third-party plugins')
  assert.equal(
    textOf(thirdParty[0]),
    '另有 1 个第三方插件：我们没有备份它们，真出事时需要重新安装',
    'it says we did NOT back them up, and that they are reinstalled',
  )
  const builtin = rows.filter((node) => node.props['data-dsh-autorestart-recovery'] === 'builtin')
  assert.equal(builtin.length, 1, 'one sentence for the built-in plugins')
  assert.equal(
    textOf(builtin[0]),
    '另有 1 个内置插件：DSH 自带，不需要备份',
    'and the built-in line says no backup is needed — not "reinstall it"',
  )
  // The old wording is GONE, in both languages.
  const everything = textOf(checked)
  assert.equal(everything.includes('备份里只有名字和版本'), false, 'the misleading sentence is gone')
  assert.equal(everything.includes('only their name and version'), false, 'and so is its English twin')

  restores[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const posts = mounted.fetches.filter(
    (entry) => String(entry.url).includes('/plugin-restore') && entry.init && entry.init.method === 'POST',
  )
  assert.equal(posts.length, 1, 'exactly one restore request')
  assert.deepEqual(JSON.parse(posts[0].init.body), { plugin: 'my-linked-plugin' })
})

/* ------------------------------------------------------------------ *
 * A host that CANNOT restart (user decision, 2026-11-02 — option A).
 *
 * The plugin is useless on such a host, and that used to look exactly like a
 * healthy install. Three surfaces have to say it: a strip at the top, a
 * one-time card that offers the fix, and never a write without the click.
 * ------------------------------------------------------------------ */

/** A hosted web host with no `command` restart mode. */
function notConfigured(overrides = {}) {
  return {
    instance: { isDesktopApp: false, platform: 'linux' },
    supervisor: { mode: 'auto', installed: false, startup: { mode: 'bare' } },
    restart: { mode: 'app', command: '', written: false, canRevert: false, previous: null },
    ...overrides,
  }
}

/** A hosted web host that already has its restart command. */
function configured(overrides = {}) {
  return notConfigured({
    restart: {
      mode: 'command',
      command: 'node /srv/dsh/web.js --port 5601',
      written: true,
      canRevert: false,
      previous: null,
    },
    ...overrides,
  })
}

test('a web host with no restart command says so at the top, and mentions no write', async () => {
  const mounted = mountSettings({
    info: notConfigured(),
    // The Host says the card was already answered (only the sleep feature is
    // pending), so only the strip may appear.
    announcements: [{ feature: 'sleep', version: '9.9.9' }],
  })
  const panel = await mounted.settled('dsh-autorestart')

  const strip = marked(panel, 'data-dsh-autorestart-restart-missing')
  const text = strip.filter((node) => node.props['data-dsh-autorestart-restart-missing'] === 'text')
  assert.equal(text.length, 1, 'the strip is there')
  assert.match(textOf(text[0]), /还没有重启能力/, 'it says what is missing')
  assert.match(textOf(text[0]), /不会重启/, 'and what that costs')
  assert.match(textOf(text[0]), /不会在重启前备份/, 'including the backup')
  assert.match(textOf(text[0]), /配错了可以撤销/, 'the undo is promised up front')

  const fix = strip.filter((node) => node.props['data-dsh-autorestart-restart-missing'] === 'fix')
  assert.equal(fix.length, 1, 'one button, the action that fixes it')
  assert.equal(fix[0].props.disabled, false)

  // READING THE PAGE IS NOT A DECISION: nothing was derived, nothing written.
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/supervisor')).length,
    0,
    'no request may write (or even ask to write) without the click',
  )
  assert.equal(marked(panel, 'data-dsh-autorestart-restart-card').length, 0, 'the answered card stays away')
})

test('command mode with an empty command is still "no restart capability"', async () => {
  const mounted = mountSettings({
    info: notConfigured({
      restart: { mode: 'command', command: '   ', written: false, canRevert: false, previous: null },
    }),
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.equal(
    marked(panel, 'data-dsh-autorestart-restart-missing')
      .filter((node) => node.props['data-dsh-autorestart-restart-missing'] === 'text').length,
    1,
    'a blank command cannot restart anything',
  )
})

test('the desktop app is never told it has no restart capability — it relaunches itself', async () => {
  const mounted = mountSettings({
    info: notConfigured({ instance: { isDesktopApp: true, platform: 'win32' } }),
    announcements: [{ feature: 'restart-command', version: '9.9.9' }],
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.equal(marked(panel, 'data-dsh-autorestart-restart-missing').length, 0, 'no strip on the desktop app')
  assert.equal(marked(panel, 'data-dsh-autorestart-restart-card').length, 0, 'and no card')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/announcements')).length,
    0,
    'the question is not even asked there',
  )
})

test('the one-time card offers the fix, and only the click writes', async () => {
  const mounted = mountSettings({
    info: notConfigured(),
    announcements: [{ feature: 'restart-command', version: '9.9.9' }],
    supervisor: {
      'dry-run': {
        ok: true,
        action: 'dry-run',
        plan: { ok: true, command: 'node /srv/dsh/web.js --port 5601', reason: 'ok' },
      },
      apply: {
        ok: true,
        action: 'apply',
        writes: { restartMode: 'command', restartCommand: 'node /srv/dsh/web.js --port 5601' },
      },
    },
  })
  // The card comes from the announcements route, so the answer lands one render
  // later than the health payload.
  await mounted.settled('dsh-autorestart')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const panel = mounted.render('dsh-autorestart')

  const card = marked(panel, 'data-dsh-autorestart-restart-card')
  assert.equal(card.filter((node) => node.props['data-dsh-autorestart-restart-card'] === 'title').length, 1, 'the card is there')
  assert.equal(card.filter((node) => node.props['data-dsh-autorestart-restart-card'] === 'later').length, 1, 'and it can be put off')
  const fix = card.filter((node) => node.props['data-dsh-autorestart-restart-card'] === 'fix')
  assert.equal(fix.length, 1, 'exactly one way to accept')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/supervisor')).length,
    0,
    'showing the card writes nothing',
  )

  fix[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = mounted.render('dsh-autorestart')

  const asked = mounted.fetches
    .filter((entry) => String(entry.url).includes('/supervisor'))
    .map((entry) => JSON.parse(entry.init.body))
  assert.deepEqual(asked.map((entry) => entry.action), ['dry-run', 'apply'], 'derive + validate, THEN write')
  assert.equal(asked[0].confirmed, undefined, 'the dry run is not a confirmation')
  assert.equal(asked[1].confirmed, true, 'the write carries the explicit confirmation')

  // The strip is gone…
  assert.equal(marked(after, 'data-dsh-autorestart-restart-missing').length, 0, 'the warning goes away')
  // …and what is configured now is on the page.
  const written = marked(after, 'data-dsh-autorestart-restart-fixed')
    .filter((node) => node.props['data-dsh-autorestart-restart-fixed'] === 'command')
  assert.equal(written.length, 1, 'the configured command is shown')
  assert.equal(textOf(written[0]), 'node /srv/dsh/web.js --port 5601')

  // The Host recorded the answer, so the card never comes back.
  const acks = mounted.fetches.filter(
    (entry) => String(entry.url).includes('/announcements') && entry.init && entry.init.method === 'POST',
  )
  assert.equal(acks.length, 1, 'the card is marked as read')
  assert.deepEqual(JSON.parse(acks[0].init.body), { feature: 'restart-command' })
})

test('a derivation that cannot produce a command explains itself and writes nothing', async () => {
  const mounted = mountSettings({
    info: notConfigured(),
    supervisor: {
      'dry-run': { ok: true, action: 'dry-run', plan: { ok: false, command: '', reason: 'port-not-fixable' } },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const fix = marked(panel, 'data-dsh-autorestart-restart-missing')
    .find((node) => node.props['data-dsh-autorestart-restart-missing'] === 'fix')
  fix.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = mounted.render('dsh-autorestart')

  assert.deepEqual(
    mounted.fetches.filter((entry) => String(entry.url).includes('/supervisor'))
      .map((entry) => JSON.parse(entry.init.body).action),
    ['dry-run'],
    'a plan that is not usable never reaches the write',
  )
  const note = marked(after, 'data-dsh-autorestart-restart-missing')
    .find((node) => node.props['data-dsh-autorestart-restart-missing'] === 'note')
  assert.ok(note, 'the failure is said out loud')
  assert.match(textOf(note), /端口每次都变/, `the Host's reason in the user's words: ${textOf(note)}`)
  assert.equal(marked(after, 'data-dsh-autorestart-restart-fixed').length, 0, 'nothing pretends to be configured')
  // …and the manual route is still on the page.
  assert.ok(
    marked(after, 'data-dsh-autorestart-supervisor')
      .some((node) => node.props['data-dsh-autorestart-supervisor'] === 'redetect'),
    'the manual entry stays where it was',
  )
})

test('a host that already has its command is left alone', async () => {
  const mounted = mountSettings({
    info: configured(),
    announcements: [{ feature: 'restart-command', version: '9.9.9' }],
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.equal(marked(panel, 'data-dsh-autorestart-restart-missing').length, 0, 'no strip')
  assert.equal(marked(panel, 'data-dsh-autorestart-restart-card').length, 0, 'no card')
  assert.equal(
    mounted.fetches.filter((entry) => String(entry.url).includes('/announcements')).length,
    0,
    'the question does not even exist on a working host',
  )
})

test('more than one profile is said out loud, above the fold', async () => {
  const mounted = mountSettings({
    info: configured({ profile: { dir: null, source: 'unknown' } }),
  })
  const panel = await mounted.settled('dsh-autorestart')

  const notice = marked(panel, 'data-dsh-autorestart-backup')
    .filter((node) => node.props['data-dsh-autorestart-backup'] === 'multi-profile-text')
  assert.equal(notice.length, 1, 'the warning is there')
  assert.match(textOf(notice[0]), /检测到多个 profile/, 'it names the cause')
  assert.match(textOf(notice[0]), /备份和回滚已暂停/, 'and the consequence')
  assert.match(textOf(notice[0]), /DSH_PROFILE/, 'and how to fix it')

  // It is NOT hidden inside the fold: "backups are paused" must be readable
  // without opening anything.
  const fold = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-backup'] === 'section',
  )
  assert.ok(fold, 'the fold exists')
  assert.equal(
    walk(fold).some((node) => node.props['data-dsh-autorestart-backup'] === 'multi-profile-text'),
    false,
    'the warning sits above the fold, not inside it',
  )
})

test('a resolved profile shows no multi-profile warning', async () => {
  const mounted = mountSettings({
    info: configured({ profile: { dir: 'C:\\Users\\Tester\\.dsh\\profiles\\default', source: 'DSH_HOME/DSH_PROFILE' } }),
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.equal(
    marked(panel, 'data-dsh-autorestart-backup')
      .filter((node) => node.props['data-dsh-autorestart-backup'] === 'multi-profile-text').length,
    0,
    'nothing is claimed when the profile is known',
  )
})

test('the profile warning reads whichever shape the Host sends — and claims nothing when it says nothing', async () => {
  const warned = async (info) => {
    const mounted = mountSettings({ info: configured(info) })
    const panel = await mounted.settled('dsh-autorestart')
    return marked(panel, 'data-dsh-autorestart-backup')
      .filter((node) => node.props['data-dsh-autorestart-backup'] === 'multi-profile-text').length
  }
  // `profile: { dir: null }` (the runtime getter), a bare `profileDir` string,
  // and the profile recorded inside the last restart's verdict.
  assert.equal(await warned({ profile: { dir: null, source: 'unknown' } }), 1, 'profile: {dir: null}')
  assert.equal(await warned({ profileDir: { dir: null } }), 1, 'profileDir: {dir: null}')
  assert.equal(await warned({ lastRestart: { snapshot: { profile: { dir: null } } } }), 1, 'lastRestart.snapshot.profile')
  // No field at all = no claim. An older Host must not produce a scary line.
  assert.equal(await warned({}), 0, 'a Host that says nothing gets no warning')
  assert.equal(await warned({ profile: { dir: '', source: 'unknown' } }), 1, 'an empty dir cannot be backed up either')
})

test('the collapsed backup fold says what is inside it', async () => {
  const mounted = mountSettings({ info: configured() })
  const panel = await mounted.settled('dsh-autorestart')
  const note = marked(panel, 'data-dsh-autorestart-backup')
    .filter((node) => node.props['data-dsh-autorestart-backup'] === 'section-note')
  assert.equal(note.length, 1, 'the summary carries the line')
  assert.equal(textOf(note[0]), '内含：某个插件起不来？退回上一个版本', 'so the entry point is visible while folded')
})

test('the shortcut icon and the desktop .lnk come from one answer', async () => {
  const iconPath = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
  const withIcon = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit({ iconPath, iconName: 'DeepSeek Harness.exe', iconAvailable: true }),
    },
  })
  const shown = await withIcon.settled('dsh-autorestart')
  const tile = marked(shown, 'data-dsh-autorestart-rescue').find(
    (node) => node.props['data-dsh-autorestart-rescue'] === 'shortcut-icon',
  )
  assert.ok(tile, 'the icon tile is there')
  assert.equal(tile.props.title, iconPath, 'the page points at the same file the .lnk uses')
  assert.equal(tile.props['data-icon-source'], 'DeepSeek Harness.exe', 'and says which file it is')
  assert.equal(tile.props['data-icon-available'], 'true')

  // NO ICON AT ALL: the page says so instead of drawing a made-up one, and the
  // shortcut is still offered — an icon is a nicety, not a requirement.
  const withoutIcon = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit({ iconPath: '', iconName: '', iconAvailable: false }),
    },
  })
  const bare = await withoutIcon.settled('dsh-autorestart')
  const bareTile = marked(bare, 'data-dsh-autorestart-rescue').find(
    (node) => node.props['data-dsh-autorestart-rescue'] === 'shortcut-icon',
  )
  assert.equal(bareTile.props.title, '', 'no path is invented')
  assert.equal(bareTile.props['data-icon-source'], '', 'and no name either')
  assert.equal(bareTile.props['data-icon-available'], 'false')
  assert.equal(
    marked(bare, 'data-dsh-autorestart-rescue').filter(
      (node) => node.props['data-dsh-autorestart-rescue'] === 'shortcut',
    ).length,
    1,
    'the shortcut itself is still offered',
  )
})
