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
function mountSettings({ info = {}, language = 'zh' } = {}) {
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
  assert.equal(walk(panel).filter((node) => node.type === 'details').length, 0, 'no fold either')
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

  // The command itself is folded away, and it is not in the page yet.
  const folds = walk(panel).filter((node) => node.type === 'details')
  assert.equal(folds.length, 1, 'the fold exists')
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
  const fold = walk(panel).find((node) => node.type === 'details')
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
  assert.equal(value('count'), '当前 1 份', 'the count')
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
      },
      {
        name: '2026-10-28T01-12-30-000Z',
        dir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart\\backups\\2026-10-28T01-12-30-000Z',
        at: 1793159550000,
        atLocal: '2026-10-28T09:12:30+08:00',
        bytes: 94208,
        files: 3,
        includePlugins: false,
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
    // FIVE ROWS SINCE 2026-11-01: the three evidence rows (certified by,
    // certified at, content scope — plus the intervention row) join the time
    // and the size. The two that were already there are still exactly one each.
    assert.equal(rows.length, 5, `backup ${index + 1} keeps its time row, its size row and the evidence rows`)
    const marks = new Set(walk(group)
      .map((node) => node.props && node.props['data-dsh-autorestart-backup'])
      .filter((value) => typeof value === 'string'))
    for (const name of ['time', 'size', 'certified', 'certified-at', 'scope', 'intervention']) {
      assert.equal(marks.has(name), true, `backup ${index + 1} shows its "${name}" row`)
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

test('② the three identities are written out in plain Chinese on every row', async () => {
  const mounted = mountSettings({
    info: {
      instance: { isDesktopApp: true, platform: 'win32' },
      supervisor: { mode: 'app', installed: false, startup: { mode: 'desktop' } },
      backups: threeIdentities(),
    },
  })
  const panel = await mounted.settled('dsh-autorestart')
  assert.deepEqual(
    backupValues(panel, 'kind'),
    ['安全份', '本次快照', '旧备份（未验证）'],
    'the user reads what each copy is, in that order',
  )
  assert.deepEqual(
    backupValues(panel, 'version'),
    ['版本 0.8.5'],
    'the version is shown where it exists — and only there',
  )
  // The identity leads the group: it decides whether the copy may be restored
  // at all, so it must not be buried under the numbers.
  const groups = marked(panel, 'data-dsh-autorestart-backup').filter(
    (node) => node.props['data-dsh-autorestart-backup'] === 'item',
  )
  assert.equal(groups.length, 3, 'three copies, three groups')
  for (const [index, group] of groups.entries()) {
    const first = walk(group).find((node) => node.props && node.props['data-dsh-autorestart-backup'] === 'kind')
    assert.ok(first, `backup ${index + 1} names its identity`)
    const rows = walk(group).filter((node) => node.props
      && String(node.props.className).includes('dsh-autorestart-settings__backup-row'))
    // FIVE ROWS SINCE 2026-11-01: the identity is followed by its evidence
    // (certified by / certified at / content scope / intervention), and the time
    // and size rows are still there — one each, as before.
    assert.equal(rows.length, 5, `backup ${index + 1} keeps the time row, the size row and the evidence rows`)
    // An OLD copy has no evidence: the rows say "未认证" / "（没有记录）" instead of
    // disappearing, so the interface never implies a proof that does not exist.
    assert.deepEqual(
      backupValues(panel, 'certified'),
      ['未认证', '未认证', '未认证'],
      'a copy without evidence says it is not certified',
    )
    assert.deepEqual(
      backupValues(panel, 'intervention'),
      ['没有记录', '没有记录', '没有记录'],
      'an unrecorded intervention is shown as unrecorded, never as "no"',
    )
  }
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
    ['Known good', "This restart's snapshot", 'Old backup (unverified)'],
    'the English user reads the same three identities',
  )
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
