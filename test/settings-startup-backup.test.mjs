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
  limitAnswer = null,
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
      if (target.includes('/backup-limit')) {
        // The write of the copy limit. Its answer is what the page shows, so a
        // test that clicks the dropdown can check the number the Host confirmed.
        const answer = limitAnswer === null
          ? { ok: true, maxBackups: 3, removed: [], kept: 3, requested: 3, keptWillExceedRequest: false }
          : limitAnswer
        const status = typeof answer.status === 'number' ? answer.status : 200
        return Promise.resolve({ ok: status < 400, status, json: async () => answer })
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

test('the settings page shows the count, the local time and the path', async () => {
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
            // The Host still stamps a copy like this, but the page reads no
            // tier any more (2026-11-02): it renders like every other row.
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
  // HOW MANY EXIST — AND NOTHING MORE (user report, 2026-11-02): the line used to
  // add "可用于回退的 {m} 份", which implied a tier the list does not have any
  // more. Every row has its own button now, so the only honest number is the
  // number of copies.
  // THE COPY BLOCK IS TWO LINES (user report, 2026-11-02): line 1 says how many
  // copies there are and what they cost on disk, line 2 says the rule that bounds
  // them. The old "可用于回退的 {m} 份" half is still gone — every row has its own
  // button now, so the only honest number is the number of copies.
  assert.equal(
    value('count'),
    '当前 1 份，实际占用 117.7 MB。',
    'line 1: how many copies and the disk they take, in one sentence',
  )
  assert.equal(
    value('keep'),
    '最多保留 2 份，超出自动删最旧的那份。',
    'line 2: the retention rule, with the number in force',
  )
  assert.equal(value('time'), '2026-10-29 08:25', 'the local time, to the minute and without the offset')
  // THE PER-COPY SIZE AND SCOPE ROWS ARE GONE (user decision, 2026-11-02): the
  // row answers "which copy do I go back to", and a byte count next to the
  // button only pushed the button away. The TOTAL moved into line 1 above — the
  // unit that fits it is pinned there (117.7 MB).
  assert.deepEqual(backupValues(panel, 'size'), [], 'no per-copy size row any more')
  assert.deepEqual(backupValues(panel, 'plugins'), [], 'no per-copy plugin scope either')
  assert.equal(value('path'), 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups', 'where they live')
})

/* ------------------------------------------------------------------ *
 * THE BACKUP LIST, one ROW per backup (user decision, 2026-11-02).
 *
 * The list used to be split into "the safe copy" (a card) and everything else
 * (a fold or a grey count line). That split was a promise the plugin cannot
 * keep: a hosted instance never certifies anything, so the safe tier sat empty
 * while every real copy was demoted. Now each copy is ONE row — its local time
 * and a rollback button — and only the newest row carries the one sentence that
 * is true about it ("this is the state from before this restart").
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

test('the limit in force is stated ONCE — the dropdown is the only control', async () => {
  // THE NUMBER IS SAID ONCE (user report, 2026-11-02): the block used to say
  // "最多保留 2 份" twice — once as a bare fact and once inside a paragraph —
  // while the sentence the user came for was the rule below it. Now the rule
  // line IS the fact, and neither duplicate is drawn any more.
  //
  // The other half of the old report still holds: the number is changed by the
  // dropdown ON THIS PAGE, so a pointer to "the plugin config" beside it pointed
  // at a second door that does not exist.
  const cases = [
    { language: 'zh', expected: '最多保留 2 份，超出自动删最旧的那份。', guide: '在插件配置里改' },
    {
      language: 'en',
      expected: 'At most 2 copies are kept; the oldest one is deleted when there are more.',
      guide: 'change it in the plugin config',
    },
  ]
  for (const { language, expected, guide } of cases) {
    const mounted = mountSettings({
      ...(language === 'en' ? { language } : {}),
      info: {
        instance: { isDesktopApp: true, platform: 'win32' },
        supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
        backups: twoBackups(),
      },
    })
    const panel = await mounted.settled('dsh-autorestart')
    // ① The rule line carries the number in force — and nothing repeats it.
    assert.deepEqual(
      backupValues(panel, 'keep'),
      [expected],
      language + ': the limit is stated as a fact, once, on the rule line',
    )
    assert.deepEqual(backupValues(panel, 'max-effective'), [], language + ': the bare duplicate is gone')
    assert.deepEqual(backupValues(panel, 'purpose'), [], language + ': and so is the paragraph that repeated it')
    // ② The control really is on this page — that is what made the pointer wrong.
    assert.equal(
      marked(panel, 'data-dsh-autorestart-backup')
        .filter((node) => node.props['data-dsh-autorestart-backup'] === 'limit-select').length,
      1,
      language + ': the dropdown is here, so there is no other door to point at',
    )
    // ③ ...and the pointer to that other door is gone.
    assert.equal(
      textOf(panel).includes(guide),
      false,
      language + ': no pointer to the plugin config any more',
    )
  }
})

test('a backup names its time, and never prints a timezone offset', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)

  // ① EVERY COPY IS ONE ROW — its time and the way back (user decision,
  // 2026-11-02). The labelled "备份时间"/"备份大小" rows went with the tier: the
  // row is a copy, not a table of numbers.
  const groups = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(groups.length, 2, 'two copies, two rows')
  for (const [index, group] of groups.entries()) {
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    assert.equal(rows.length, 1, `backup ${index + 1} is exactly one row`)
  }
  assert.equal(text.includes('备份时间'), false, 'no per-copy time label any more')
  assert.equal(text.includes('备份大小'), false, 'no per-copy size label any more')

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

  // ③ Every row carries the button that goes back to THAT copy: a row without a
  // way back would be a dead end, and the list is the only door to a rollback.
  assert.deepEqual(
    backupValues(panel, 'rollback'),
    ['回退到这一份', '回退到这一份'],
    'one rollback button per copy, in the same order as the times',
  )
})

test('the size that is still on the page is the total, with the unit that fits it', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)

  // ③ THE PER-COPY SIZE ROW IS GONE (user decision, 2026-11-02), so what is left
  // to check is the TOTAL: 163577856 + 94208 bytes = 156.1 MB, printed with the
  // unit that fits it.
  assert.deepEqual(backupValues(panel, 'size'), [], 'no per-copy size row any more')
  assert.deepEqual(backupValues(panel, 'plugins'), [], 'no per-copy plugin scope either')
  assert.deepEqual(
    backupValues(panel, 'count'),
    ['当前 2 份，实际占用 156.1 MB。'],
    'the total footprint rides in line 1 now, with the unit that fits it',
  )
  assert.equal(text.includes('156.0'), false, `no pointless tenth: ${text}`)
  assert.equal(text.includes('0.1 MB'), false, 'the KB copy must not read as a fraction of a MB')
})

test('two backups are two rows, each with its time and its own rollback button', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  // ⑤ ONE row per backup, and the row is its time plus its own way back
  // (user decision, 2026-11-02). There is no per-copy 详情 fold any more: the
  // rows it used to hide (identity, who certified it, content scope,
  // intervention) are not drawn at all, so a fold would open onto nothing.
  const groups = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(groups.length, 2, 'two backups are two rows')
  const carried = []
  for (const [index, group] of groups.entries()) {
    assert.equal(
      String(group.props.className).includes('dsh-autorestart-settings__backup'),
      true,
      `the group of backup ${index + 1} has its own class`,
    )
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    assert.equal(rows.length, 1, `backup ${index + 1} is ONE row`)
    const row = rows[0]
    const time = walk(row).find((node) => node.props
      && node.props['data-dsh-autorestart-backup'] === 'time')
    assert.ok(time, `backup ${index + 1} names its time`)
    assert.equal(
      textOf(time),
      index === 0 ? '2026-10-29 22:08' : '2026-10-28 09:12',
      `backup ${index + 1} shows the local time of the copy it is`,
    )
    const button = walk(row).find((node) => node.props
      && node.props['data-dsh-autorestart-backup'] === 'rollback')
    assert.ok(button, `backup ${index + 1} offers its way back`)
    assert.equal(button.type, 'button', `the way back of backup ${index + 1} is a real button`)
    assert.equal(textOf(button), '回退到这一份', `backup ${index + 1} says what the button does`)
    assert.notEqual(button.props.disabled, true, `backup ${index + 1} can be restored: nothing is busy`)
    carried.push(button.props['data-backup-name'])
    assert.equal(
      walk(group).filter((node) => node.type === 'details').length,
      0,
      `backup ${index + 1} has no 详情 fold — there is no hidden row to open`,
    )
  }
  // The button names the copy it restores: a row carrying the wrong name would
  // restore the wrong copy, which is the one mistake here that cannot be undone.
  assert.deepEqual(
    carried,
    ['2026-10-29T14-08-46-000Z', '2026-10-28T01-12-30-000Z'],
    'newest first, and every button carries its own copy',
  )

  // THE BUTTON ONLY ASKS (user decision, 2026-10-30): pressing it opens the
  // confirmation that names the copy, and nothing is posted until that card is
  // confirmed — one click must never replace the current state.
  const secondButton = walk(groups[1]).find((node) => node.props
    && node.props['data-dsh-autorestart-backup'] === 'rollback')
  secondButton.props.onClick()
  const asked = mounted.render('dsh-autorestart')
  const confirmBody = marked(asked, 'data-dsh-autorestart-backup').find(
    (node) => node.props['data-dsh-autorestart-backup'] === 'rollback-confirm-body',
  )
  assert.ok(confirmBody, 'the confirmation appears')
  assert.ok(
    textOf(confirmBody).includes('2026-10-28 09:12'),
    `it names the copy that would be restored: ${textOf(confirmBody)}`,
  )
  assert.equal(
    mounted.fetches.filter((call) => String(call.url).includes('rollback')).length,
    0,
    'and nothing was posted: the click only opened the question',
  )


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

test('③ the page no longer promises a tier — the old 安全份 paragraphs are gone, the facts stay', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const text = textOf(panel)
  // THE TWO EXPLAINING PARAGRAPHS ARE GONE (user report, 2026-11-02). They said a
  // backup has "one of two identities" and that only a "safe" copy is ever rolled
  // back — while every row below has its own rollback button. That contradiction
  // is what made a user afraid to press the button on an older copy, so every
  // word of the old tier must not appear anywhere on the page — including the
  // ones that only ever lived in the dictionary (the tier's label, its heading,
  // and the certificate sentences that went with them: 认证于 / 认证判据).
  for (const phrase of ['安全份', '可用于回退', '认证依据', '未认证', '认证于', '认证判据', '已验证', '可放心回退', '已知可用', '身份']) {
    assert.equal(
      text.includes(phrase),
      false,
      `"${phrase}" is the old tier's wording — it must not be on the page: ${text}`,
    )
  }
  const staleNodes = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'identity-hint'
      || node.props['data-dsh-autorestart-backup'] === 'evidence-hint',
  )
  assert.equal(staleNodes.length, 0, 'and the two paragraphs are not drawn as orphan nodes either')

  // WHAT STAYS IS WHAT IS TRUE — checked verbatim, because these sentences
  // were verified against the real page and must not drift with the deletion.
  //
  // THE COPY BLOCK IS TWO LINES (user report, 2026-11-02): the count line now
  // also carries the disk the copies take, and the rule line carries the limit —
  // the paragraph that repeated that limit, and the bare "最多保留 3 份" fact,
  // are both gone.
  assert.match(
    backupValues(panel, 'count')[0] || '',
    /^当前 3 份，实际占用 [\d.]+ (B|KB|MB|GB)。$/,
    'line 1: the three copies and the disk they take together',
  )
  assert.equal(
    backupValues(panel, 'keep')[0],
    '最多保留 3 份，超出自动删最旧的那份。',
    'line 2: the retention rule, with the number in force',
  )
  assert.deepEqual(backupValues(panel, 'max-effective'), [], 'the bare duplicate of the limit is gone')
  assert.deepEqual(backupValues(panel, 'purpose'), [], 'and the paragraph that repeated it is gone too')
  assert.deepEqual(backupValues(panel, 'footprint'), [], 'the old separate footprint line is gone as well')
  assert.equal(
    backupValues(panel, 'kinds-local')[0],
    '链接安装（自己写的）和本地化过的插件（目录里有 .git）都已完整备份，可以回档。',
    'linked and localized plugins are in the copy in full',
  )
  assert.equal(
    backupValues(panel, 'kinds-third-party')[0],
    '第三方插件由插件作者维护，有异常建议重装',
    'third-party plugins: reinstall instead of rolling back',
  )
  assert.equal(
    backupValues(panel, 'limit-hint')[0],
    '备份会占用磁盘空间，建议尽量选更少的备份数。',
    'the disk-space hint, next to the dropdown',
  )
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
  // THE SAME TWO ROWS IN ENGLISH (2026-11-02): one local time and one way back
  // per copy, and the newest row carries the sentence in the page's language.
  // (The old per-copy "Backup time"/"Backup size" labels went with the size row,
  // so the row is checked by what it SAYS, not by a label next to it.)
  assert.deepEqual(
    backupValues(panel, 'time'),
    ['2026-10-29 22:08', '2026-10-28 09:12'],
    'the local time of each copy, never the directory name',
  )
  assert.deepEqual(
    backupValues(panel, 'rollback'),
    ['Roll back to this copy', 'Roll back to this copy'],
    'the way back is translated — never a key name, never Chinese',
  )
  assert.deepEqual(
    backupValues(panel, 'startup-hint'),
    ['This is the state at the most recent startup. DSH starting does not mean every plugin is healthy — a broken plugin is excluded and the host still boots. Which copy to roll back to is your call.'],
    'the one sentence is printed once, in English, on the copy taken at the most recent startup',
  )
  assert.deepEqual(backupValues(panel, 'size'), [], 'no per-copy size row in English either')
  assert.deepEqual(backupValues(panel, 'plugins'), [], 'no per-copy plugin scope in English either')
  assert.equal(/[+-]\d{2}:\d{2}/.test(text), false, 'no offset in English either')
})

/**
 * MANY COPIES ON DISK (user report, 2026-11-02: that machine had more than
 * fifteen of them). Under the old tiering the page opened with fifteen
 * sentences and pushed the one card that mattered off screen. Since 2026-11-02
 * every copy is one row, so the question this fixture answers is the opposite
 * one — and the one that can actually bite a user: is the tail still rendered,
 * or does the list quietly stop after a dozen?
 */
function manyUnverified(count) {
  const items = [
    {
      name: '2026-11-02T00-00-00-000Z',
      dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-11-02T00-00-00-000Z',
      at: 1793558400000,
      atLocal: '2026-11-02T08:00:00+08:00',
      bytes: 204800,
      configFiles: 3,
      includePlugins: true,
      version: '0.8.6',
      kind: 'known-good',
      certifiedBy: 'full-checks',
      certificationEvidence: 'fingerprint-match',
    },
  ]
  for (let index = 0; index < count; index += 1) {
    items.push({
      name: '2026-11-01T' + String(index).padStart(2, '0') + '-00-00-000Z',
      dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-11-01T' + String(index).padStart(2, '0'),
      at: 1793472000000 - index * 3600000,
      atLocal: '2026-11-01T' + String(index).padStart(2, '0') + ':00:00+08:00',
      bytes: 1024,
      configFiles: 3,
      includePlugins: false,
      kind: 'unverified',
      certifiedBy: 'none',
      certificationEvidence: 'none',
    })
  }
  return { dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups', max: 20, count: items.length, items }
}

test('seventeen copies are seventeen rows — the tail is never dropped', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: manyUnverified(16),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  // One proven copy + sixteen unverified ones. The unverified ones used to be
  // collapsed into a grey count line; now every one of them is a row you can
  // roll back to, so the number of rows IS the number of copies.
  assert.equal(items.length, 17, 'every copy on disk is a row — nothing is folded away or dropped')
  const times = backupValues(panel, 'time')
  assert.equal(times.length, 17, 'and every row names its own time')
  assert.equal(times[0], '2026-11-02 08:00', 'the newest copy comes first')
  assert.equal(times[16], '2026-11-01 15:00', 'the oldest copy is last — the tail is rendered, not truncated')
  assert.equal(
    backupValues(panel, 'rollback').length,
    17,
    'and every one of them carries its own way back',
  )
  assert.equal(
    backupValues(panel, 'startup-hint').length,
    1,
    'the sentence still appears exactly once, on the newest copy',
  )
  assert.match(
    backupValues(panel, 'count')[0] || '',
    /^当前 17 份，实际占用 [\d.]+ (B|KB|MB|GB)。$/,
    'and line 1 says how many copies there are, with what they take on disk',
  )
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

test('the rescue group is the SAME on both ends (plan B): the desktop entry becomes a copyable command', async () => {
  // PLAN B (user decision, 2026-11-02): the desktop build keeps its rescue entry,
  // and the hosted / web page shows the SAME group with the SAME title — only the
  // one entry that needs a desktop turns into a copyable command. The group is
  // never removed, and the "the web version has no desktop" excuse line is gone.
  const noDesktopKit = rescueKit({
    platform: 'linux',
    scriptsDir: '/plugin/scripts',
    restoreProfile: '/plugin/scripts/restore-profile.sh',
    emergencyDisable: '/plugin/scripts/emergency-disable.sh',
    desktopDir: '',
    desktopSource: 'none',
    shortcutPath: '',
    iconPath: '',
  })
  const hosted = mountSettings({
    info: {
      instance: { isDesktopApp: false, platform: 'linux' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: noDesktopKit,
    },
  })
  const hostedPanel = await hosted.settled('dsh-autorestart')

  // The group and its title are there — the same ones the desktop build shows.
  assert.match(textOf(hostedPanel), /桌面救援入口/, 'the same group title as on the desktop')
  assert.equal(rescueText(hostedPanel, 'no-desktop-platform'), '', 'no "the web version has no desktop" excuse line')
  assert.equal(rescueText(hostedPanel, 'shortcut-name'), '', 'no .lnk file name where there is no desktop')

  // THE ENTRY ITSELF: a copyable command instead of the desktop shortcut.
  assert.equal(
    rescueText(hostedPanel, 'command'),
    '/plugin/scripts/restore-profile.sh',
    'the entry is the restore command the Host resolved — not a made-up one',
  )
  assert.equal(
    marked(hostedPanel, 'data-dsh-autorestart-rescue')
      .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'copy-command').length,
    1,
    'and it can be copied',
  )
  assert.match(
    rescueText(hostedPanel, 'command-hint'),
    /效果和桌面上双击那个入口一样/,
    'the page says what this command does, in the same terms as the desktop entry',
  )

  // The paths are still rendered in full where there is no desktop entry.
  const paths = marked(hostedPanel, 'data-dsh-autorestart-rescue')
    .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'path')
    .map((node) => textOf(node))
  assert.deepEqual(
    paths,
    ['/plugin/scripts/restore-profile.sh', '/plugin/scripts/emergency-disable.sh'],
    'both paths ARE on the hosted page, in full',
  )

  // THE DESKTOP BUILD IS UNCHANGED: the `.lnk` row, the button, the fold.
  const desktop = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      rescue: rescueKit(),
    },
  })
  const desktopPanel = await desktop.settled('dsh-autorestart')
  assert.match(textOf(desktopPanel), /桌面救援入口/, 'the same title on the desktop')
  assert.notEqual(rescueText(desktopPanel, 'shortcut-name'), '', 'the desktop build still names the .lnk')
  assert.equal(
    marked(desktopPanel, 'data-dsh-autorestart-rescue')
      .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'command').length,
    0,
    'and it does NOT show the hosted command form',
  )
  assert.equal(
    walk(desktopPanel).filter((node) => node.type === 'details'
      && node.props && node.props['data-dsh-autorestart-rescue'] === 'paths-details').length,
    1,
    'the paths still sit behind 详情 where the desktop entry is the main door',
  )

  // THE SAME GROUP TITLES ON BOTH ENDS (plan B): the page is one page, not two.
  const titlesOf = (panel) => walk(panel)
    .filter((node) => node.props && typeof node.props.className === 'string'
      && node.props.className.includes('settings__group-title'))
    .map((node) => textOf(node))
  const shared = ['重启相关设置', '关机相关设置', '桌面救援入口', '遇到问题']
  for (const title of shared) {
    assert.ok(titlesOf(hostedPanel).includes(title), `the web page shows «${title}» like the desktop`)
    assert.ok(titlesOf(desktopPanel).includes(title), `the desktop shows «${title}»`)
  }
  // 开机自启 is the 0.8.5 design and MUST stay where it belongs: on the hosted
  // host (a desktop app manages its own start-up, so the block is hidden there).
  assert.ok(titlesOf(hostedPanel).includes('开机自启'), 'the web page keeps the start-at-login group')
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
  // PLAN B: with no desktop entry the paths are the only way out, so they are
  // rendered in full — there is no fold at all.
  assert.equal(
    walk(panel).filter((node) => node.type === 'details'
      && node.props && node.props['data-dsh-autorestart-rescue'] === 'paths-details').length,
    0,
    'the paths are never folded when the shortcut cannot be placed',
  )
  assert.notEqual(
    marked(panel, 'data-dsh-autorestart-rescue')
      .filter((node) => node.props['data-dsh-autorestart-rescue'] === 'path').length,
    0,
    'and they are on the page',
  )
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
  // rules, the rows with their way back, the path and the per-plugin recovery.
  // (`size` is deliberately absent: the per-copy size row went with the tier on
  // 2026-11-02, so a size node inside the fold would mean the old layout crept
  // back in.)
  const inside = new Set(walk(folds[0]).map((node) => node.props && node.props['data-dsh-autorestart-backup'])
    .filter((value) => typeof value === 'string'))
  for (const key of ['list', 'count', 'keep', 'time', 'rollback', 'startup-hint', 'path', 'copy-path']) {
    assert.equal(inside.has(key), true, `"${key}" is inside the fold`)
  }
  for (const gone of [
    'size',
    'kind',
    'certified',
    'intervention',
    'other-line',
    'others-summary',
    'list-details',
    // THE TWO EXPLAINING PARAGRAPHS WENT WITH THE TIER (user report, 2026-11-02):
    // they promised "only a safe copy is rolled back", which the list contradicts.
    'identity-hint',
    'evidence-hint',
  ]) {
    assert.equal(inside.has(gone), false, `"${gone}" is not drawn any more, so it cannot be inside the fold`)
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
 * A COPY FROM A FRESH INSTALL (user report, 2026-11-02).
 *
 * The host stamps the first-install seed with `kind: 'known-good'` and
 * `certifiedBy: 'seed'` — a label, not a proof — and the page used to call it
 * "安全份". The tier itself is gone (2026-11-02), so this fixture is kept for
 * the one case that still needs it: the page must draw such a copy like any
 * other copy, and never grade it.
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

test('hosted: the fold, the row-per-copy list and the absent version hold on a web host too', async () => {
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

  // (2) THE COPY IS ONE ROW with its time and its own button — the same rule as
  // on the desktop (2026-11-02). The page does not grade copies any more, so it
  // does not drop one either: a hosted instance certifies nothing, and hiding
  // every copy behind that fact left the user with no way back at all.
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(items.length, 1, 'the one copy is one row, not a count line')
  assert.deepEqual(backupValues(panel, 'time'), ['2026-10-31 09:00'], 'with the local time of that copy')
  assert.deepEqual(backupValues(panel, 'rollback'), ['回退到这一份'], 'and its own way back')
  assert.deepEqual(
    backupValues(panel, 'startup-hint').length,
    1,
    'and the one sentence, because it is also the newest copy',
  )
  assert.match(
    backupValues(panel, 'count')[0] || '',
    /^当前 1 份，实际占用 [\d.]+ (B|KB|MB|GB)。$/,
    'line 1 says how many copies there are — and nothing about a tier on a web host either',
  )

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

test('every copy on disk is one row — three copies are three rows, newest first', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(items.length, 3, 'three copies are three rows — none is demoted to a count line')
  assert.deepEqual(
    backupValues(panel, 'time'),
    ['2026-10-30 09:00', '2026-10-29 09:00', '2026-10-28 09:00'],
    'newest first, one local time per row',
  )
  assert.deepEqual(
    backupValues(panel, 'rollback'),
    ['回退到这一份', '回退到这一份', '回退到这一份'],
    'and every row carries its own way back',
  )
  // The three fixtures carry three DIFFERENT stamps (a proven copy, a snapshot, an
  // old unverified copy). The list must not react to any of them: the same row for
  // all, plus one sentence on the copy whose record says it is the latest — the
  // names are sorted, so 'startup-hint' sorts after 'rollback'.
  const expectedMarks = [
    ['item', 'rollback', 'startup-hint', 'time'],
    ['item', 'rollback', 'time'],
    ['item', 'rollback', 'time'],
  ]
  for (const [index, item] of items.entries()) {
    const names = [...new Set(walk(item)
      .map((node) => node.props && node.props['data-dsh-autorestart-backup'])
      .filter((value) => typeof value === 'string'))].sort()
    assert.deepEqual(
      names,
      expectedMarks[index],
      `copy ${index + 1} carries exactly its time, its button${index === 0 ? ' and the sentence' : ''}`,
    )
  }
})

test('only the copy taken at the most recent startup carries the sentence', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const hints = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'startup-hint',
  )
  assert.equal(hints.length, 1, 'one sentence, never three')
  assert.equal(
    textOf(hints[0]),
    '这是最近一次启动时的状态。DSH 能启动不代表插件都正常——坏掉的插件会被排除，主机照样起来。要回退到哪一份，请自己判断。',
    'verbatim, as the user worded it',
  )
  // It belongs to the copy WHOSE OWN RECORD SAYS IT IS THE LATEST — the state the
  // host last started from — and to no other. On an older copy the same sentence
  // would be a claim about a startup it has nothing to do with.
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.deepEqual(
    backupValues(panel, 'time'),
    ['2026-10-30 09:00', '2026-10-29 09:00', '2026-10-28 09:00'],
    'newest first, as the Host sorts them',
  )
  assert.equal(
    walk(items[0]).some((node) => node.props
      && node.props['data-dsh-autorestart-backup'] === 'startup-hint'),
    true,
    'the row of the copy with the latest take time carries the sentence',
  )
  for (const [index, item] of items.slice(1).entries()) {
    assert.equal(
      walk(item).some((node) => node.props
        && node.props['data-dsh-autorestart-backup'] === 'startup-hint'),
      false,
      `copy ${index + 2} carries no sentence about the most recent startup`,
    )
  }
})

test('the sentence follows the copy record, not the row it is drawn in', async () => {
  // THE RULE THE PAGE MUST OBEY (user decision, 2026-11-02): the sentence hangs
  // on the copy taken at the most recent startup, and that copy is found by ITS
  // OWN RECORD — never by "the first row of the list". A page that read the
  // position would silently move a claim about the last startup onto an older
  // copy the day the Host returns the copies in another order.
  //
  // So the fixture hands them over SHUFFLED: the copy with the latest take time
  // sits in the middle. The sentence must go with that copy and nothing else.
  const backups = threeIdentities()
  backups.items = [backups.items[1], backups.items[0], backups.items[2]]
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups,
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.deepEqual(
    backupValues(panel, 'time'),
    ['2026-10-29 09:00', '2026-10-30 09:00', '2026-10-28 09:00'],
    'the rows keep the order the Host sent them in — the newest copy is NOT first here',
  )
  const carriers = items
    .map((item, index) => ({
      index,
      carries: walk(item).some((node) => node.props
        && node.props['data-dsh-autorestart-backup'] === 'startup-hint'),
    }))
    .filter((entry) => entry.carries)
    .map((entry) => entry.index)
  assert.deepEqual(
    carriers,
    [1],
    'the sentence is on row 2 — the copy whose record says 2026-10-30, not on row 1',
  )
})

test('a copy carrying the old safe stamp is drawn like every other copy', async () => {
  // The Host still stamps copies with kind / certifiedBy / certificationEvidence
  // and a version. Until 2026-11-02 the page turned that into a "安全份" card
  // and demoted the rest, but the tier was a promise this plugin cannot keep (a
  // hosted instance certifies nothing, so the safe tier stayed empty forever).
  // What is pinned here is that the fields still arriving change NOTHING about
  // the rendering — including the strongest-looking stamp there is.
  const backups = threeIdentities()
  backups.items[0] = { ...backups.items[0], version: '9.9.9-version-marker' }
  backups.items[1] = {
    ...backups.items[1],
    kind: 'known-good',
    certifiedBy: 'full-checks',
    certificationEvidence: 'fingerprint-match',
  }
  backups.items[2] = { ...backups.items[2], kind: 'known-good', certifiedBy: 'seed', certificationEvidence: 'none' }
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups,
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const items = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(items.length, 3, 'three rows, whatever the stamps say')
  assert.deepEqual(
    backupValues(panel, 'rollback'),
    ['回退到这一份', '回退到这一份', '回退到这一份'],
    'every copy keeps its own way back — none is dropped for being unproven',
  )
  // No tier node is drawn at all: the page does not read these fields any more.
  const marks = new Set(marked(panel, 'data-dsh-autorestart-backup')
    .map((node) => node.props['data-dsh-autorestart-backup']))
  for (const gone of [
    'kind',
    'version',
    'certified',
    'certified-at',
    'certification-evidence',
    'scope',
    'intervention',
    'other',
    'other-line',
    'others-summary',
    'list-details',
  ]) {
    assert.equal(marks.has(gone), false, `no "${gone}" node is drawn any more`)
  }
  // ...and no row is labelled as safe or as verified, on any copy.
  for (const [index, item] of items.entries()) {
    assert.equal(textOf(item).includes('安全份'), false, `copy ${index + 1} is not labelled 安全份`)
    assert.equal(textOf(item).includes('已验证'), false, `copy ${index + 1} is not labelled 已验证`)
  }
  // THE OLD TIER'S WORDS MUST NOT COME BACK AT ALL (user report, 2026-11-02): the
  // two paragraphs that USED to explain 安全份 are gone, so the word has no
  // legitimate home on the page any more — a row, a badge or a re-added paragraph
  // that said it would now contradict the list and the button on every row.
  const occurrences = (text, needle) => String(text).split(needle).length - 1
  assert.equal(occurrences(textOf(panel), '安全份'), 0, 'no mention of the old tier is left')
  assert.equal(occurrences(textOf(panel), '可用于回退'), 0, 'and no "usable for rollback" half-count either')
  assert.equal(occurrences(textOf(panel), '认证依据'), 0, 'and nothing about "certified by"')
  assert.equal(occurrences(textOf(panel), '未认证'), 0, 'and nothing about "not certified"')
  assert.equal(
    textOf(panel).includes('9.9.9-version-marker'),
    false,
    'the plugin version is still not printed, even when the Host sends one',
  )
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

// ---------------------------------------------------------------------------
// THE COPY LIMIT IS EDITABLE (user decision, 2026-11-02).
//
// A dropdown writes maxBackups through the backup-limit route. Shrinking is the
// only dangerous direction, so it goes through a confirmation that names the
// copies it will delete; cancelling must send NOTHING.
// ---------------------------------------------------------------------------

function backupLocale(lang) {
  const dict = JSON.parse(fs.readFileSync(new URL('../locale/' + lang + '.json', import.meta.url), 'utf8'))
  return dict.settings.backup
}

test('the limit dropdown offers exactly 1-10 and shows the value in force', () => {
  const panel = functionBodyOfSettings()
  assert.match(panel, /\[2, 3, 4, 5, 6, 7, 8, 9, 10\]\.map/, 'the options are 2..10 - one copy is no fallback at all')
  assert.match(panel, /'data-dsh-autorestart-backup': 'limit-select'/, 'the select exists')
  assert.match(
    panel,
    /value: String\(limitValue === null \? backupsInfo\.max : limitValue\)/,
    'it is seeded with the effective value and replaced by the answer',
  )
})

test('the disk hint is verbatim, and sits to the RIGHT of the dropdown', async () => {
  assert.equal(backupLocale('zh').limitHint, '备份会占用磁盘空间，建议尽量选更少的备份数。')
  assert.equal(
    backupLocale('en').limitHint,
    'Backups take disk space, so it is best to keep as few copies as possible.',
  )
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  // THE WARNING MUST ARRIVE WITH THE CHOICE (user report, 2026-11-02): as its own
  // line BELOW the control it showed up after the number had been picked. So it
  // has to be a child of the SAME row as the select, positioned after it.
  const rows = walk(panel).filter(
    (node) => node.props && typeof node.props.className === 'string'
      && node.props.className.includes('dsh-autorestart-settings__backup-row'),
  )
  const limitRow = rows.find((row) => walk(row).some(
    (node) => node.props && node.props['data-dsh-autorestart-backup'] === 'limit-select',
  ))
  assert.ok(limitRow, 'the dropdown sits in a row')
  const children = limitRow.children || []
  const selectAt = children.findIndex(
    (node) => node.props && node.props['data-dsh-autorestart-backup'] === 'limit-select',
  )
  const hintAt = children.findIndex(
    (node) => node.props && node.props['data-dsh-autorestart-backup'] === 'limit-hint',
  )
  assert.notEqual(hintAt, -1, 'the disk warning is in that row, not on a line of its own')
  assert.equal(hintAt > selectAt, true, 'and it comes after the dropdown — to its right')
  assert.deepEqual(backupValues(panel, 'limit-hint'), [backupLocale('zh').limitHint], 'printed once, verbatim')
})

/**
 * THE BUG THE USER HIT (user report, 2026-11-02): "把「保留份数」从 2 改成 3，
 * 界面没有任何变化".
 *
 * The Host reports `healthUrl` as a FULL URL (`http://127.0.0.1:<port>/…/health`),
 * and the page derived the write route only from a value starting with `/`. It
 * resolved to `''`, `submitBackupLimit` returned BEFORE calling `fetch`, and the
 * page said nothing: no request, no message, no change. The dropdown moved, the
 * number did not — so this test pins all three things the user could not see:
 * one POST goes out, its body carries the picked number, and the number the page
 * shows afterwards is the one the Host confirmed.
 */
test('② 2 → 3 really writes the limit: one POST goes out and the number moves', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      // EXACTLY the shape the Host reports — an absolute URL, not a path.
      healthUrl: 'http://127.0.0.1:51949/__dsh_autorestart/health',
      backups: twoBackups(),
    },
    limitAnswer: { ok: true, maxBackups: 3, removed: [], kept: 3, requested: 3, keptWillExceedRequest: false },
  })
  const panel = await mounted.settled('dsh-autorestart')
  const selectOf = (tree) => marked(tree, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'limit-select',
  )[0]

  assert.equal(selectOf(panel).props.value, '2', 'the dropdown starts at the limit in force')

  selectOf(panel).props.onChange({ target: { value: '3' } })
  await new Promise((resolve) => setTimeout(resolve, 10))

  // ① A REQUEST REALLY GOES OUT — the whole bug was that none did.
  const posts = mounted.fetches.filter((call) => String(call.url).includes('/backup-limit'))
  assert.equal(posts.length, 1, 'exactly one write goes out (the bug sent none at all)')
  assert.equal(String(posts[0].url), '/__dsh_autorestart/backup-limit', 'to the sibling of the health route')
  assert.equal(posts[0].init.method, 'POST', 'as a write')
  assert.deepEqual(JSON.parse(posts[0].init.body), { maxBackups: 3 }, 'carrying the number the user picked')

  // ② ...AND THE NUMBER ON SCREEN REALLY MOVES.
  const after = mounted.render('dsh-autorestart')
  assert.equal(selectOf(after).props.value, '3', 'the dropdown shows the confirmed number at once')
  assert.deepEqual(
    marked(after, 'data-dsh-autorestart-backup').map((node) => node.props['data-dsh-autorestart-backup']).includes('limit-note'),
    true,
    'and the page says what happened instead of staying silent',
  )
  assert.equal(textOf(after).includes('现在保留 3 份'), true, `the note names the number kept: ${textOf(after)}`)
})

test('the write route survives every shape the Host reports health in', async () => {
  // A PATH, an ABSOLUTE URL and NOTHING AT ALL must all end at the same route.
  // The middle one is the shape the real Host sends, and it is the one that broke.
  const shapes = [
    { label: 'a path', info: { healthUrl: '/__dsh_autorestart/health?state=1' }, expected: '/__dsh_autorestart/backup-limit' },
    { label: 'an absolute URL', info: { healthUrl: 'http://127.0.0.1:51949/__dsh_autorestart/health' }, expected: '/__dsh_autorestart/backup-limit' },
    { label: 'an explicit backupLimitUrl', info: { backupLimitUrl: '/custom/backup-limit' }, expected: '/custom/backup-limit' },
  ]
  for (const shape of shapes) {
    const mounted = mountSettings({
      info: {
        instance: { isDesktopApp: true, platform: 'win32' },
        supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
        backups: twoBackups(),
        ...shape.info,
      },
    })
    const panel = await mounted.settled('dsh-autorestart')
    const select = marked(panel, 'data-dsh-autorestart-backup').filter(
      (node) => node.props['data-dsh-autorestart-backup'] === 'limit-select',
    )[0]
    select.props.onChange({ target: { value: '3' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const posts = mounted.fetches.filter((call) => String(call.url).includes('backup-limit'))
    assert.equal(posts.length, 1, shape.label + ': the write goes out')
    assert.equal(String(posts[0].url), shape.expected, shape.label + ': to the right route')
  }

  // ...and with no hint at all the derived default answers, so the page can
  // always write; it must never fall back to sending nothing.
  const bare = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: twoBackups(),
    },
  })
  const barePanel = await bare.settled('dsh-autorestart')
  marked(barePanel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'limit-select',
  )[0].props.onChange({ target: { value: '3' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    bare.fetches.filter((call) => String(call.url).includes('backup-limit')).length,
    1,
    'with no URL hint the page still writes instead of doing nothing',
  )
})

test('cancelling the confirmation sends no request at all', () => {
  const panel = functionBodyOfSettings()
  const cancelAt = panel.indexOf("'data-dsh-autorestart-backup': 'limit-cancel'")
  assert.notEqual(cancelAt, -1, 'the cancel button exists')
  const cancelBlock = panel.slice(cancelAt, cancelAt + 400)
  assert.equal(cancelBlock.includes('fetch('), false, 'it does not call the route')
  assert.equal(cancelBlock.includes('submitBackupLimit'), false, 'and does not submit either')
  assert.match(cancelBlock, /setLimitAsk\(null\)/, 'it only closes the confirmation')
})

test('the confirmation names the copies it deletes and the before/after counts', () => {
  const zh = backupLocale('zh').limitAsk
  assert.match(zh, /将删除 \{remove\} 份最旧的备份，删除后无法恢复/, 'it says how many and that it is final')
  assert.match(zh, /当前 \{from\} 份 → 保留 \{to\} 份/, 'and shows current -> kept')
  const panel = functionBodyOfSettings()
  assert.match(panel, /remove: backupItems\.length - wanted/, 'N comes from the real counts')
})

test('the answer is reported as it came back, including the protected copies', () => {
  assert.match(backupLocale('zh').limitDeleted, /已删除 \{removed\} 份/, 'the real deleted count')
  assert.match(backupLocale('zh').limitMore, /已选 \{requested\} 份，实际保留 \{kept\} 份/,
    'and the honest line, with no reason a copy could not be deleted')
  const panel = functionBodyOfSettings()
  assert.match(panel, /answer\.removed/, 'removed comes from the response')
  assert.match(panel, /keptWillExceedRequest === true/, 'the protected case is decided by the response')
  assert.match(panel, /answer\.reason/, 'a refusal is shown with the Host reason, unwritten')
})

/** The body of the settings component, for the assertions above. */
function functionBodyOfSettings() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('const submitBackupLimit')
  assert.notEqual(start, -1, 'the submit handler is there')
  // The handler sits in the state area and the control it serves renders further
  // down, so the slice runs to the end of the file rather than a fixed window.
  return source.slice(start)
}
