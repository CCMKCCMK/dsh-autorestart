/**
 * THE SETTINGS PAGE AFTER THE REARRANGEMENT (user decision, 2026-11-11).
 *
 * The user asked for the whole page in ONE shape:
 *
 *   - every setting is a row: the title on the left, the control on the right,
 *     a thin line between two rows;
 *   - every explanation is folded behind ONE 「查看说明」 entry (the words are
 *     no longer spread under the titles);
 *   - the three checkboxes are SLIDING SWITCHES: a real checkbox (so the
 *     keyboard can reach it and the space bar can flip it) plus a track and a
 *     dot;
 *   - the 「上次重启」 row is gone from the page — but the launcher that
 *     really ran is still reported by the Host (the data pipe is not cut);
 *   - the 「更多设置」 block stands on its own, after the shutdown settings,
 *     closed by default.
 *
 * These tests are the contract for that. They look at the rendered tree, so
 * they say what the page really draws.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Load the classic client script in a sandbox and mount the settings section.
 *
 * @param {{ status?: object, language?: string }} options
 */
function mountSettings({ status = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const state = { status }
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
      fetches.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/choice') && init && init.body) {
        // The Host takes the answer and reports it back on the next poll.
        const written = JSON.parse(init.body)
        const next = { ...(state.status || {}) }
        if (typeof written.restartGraceMs === 'number') next.restartGraceMs = written.restartGraceMs
        if (typeof written.sleepCountdownSeconds === 'number') next.countdownSeconds = written.sleepCountdownSeconds
        if (typeof written.backupOnRestart === 'boolean') next.backupOnRestart = written.backupOnRestart
        if (typeof written.backupIncludePlugins === 'boolean') next.backupIncludePlugins = written.backupIncludePlugins
        if (typeof written.pluginFilesWatch === 'boolean') {
          next.pluginFiles = { ...(state.status.pluginFiles || {}), watched: written.pluginFilesWatch }
        }
        state.status = next
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, applied: 'config', ...written }),
        })
      }
      if (target.includes('/sleep')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => state.status || {} })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, choiceUrl: '/__dsh_autorestart/choice' }),
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

/** A storage that keeps nothing (the settings page does not need it). */
function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
    clear: () => { values.clear() },
  }
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

/** Whether two dependency lists are the same. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
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

/** The rows of the settings page (the ones with a setting key). */
function rowsOf(panel) {
  return walk(panel).filter(
    (node) => typeof node.props['data-dsh-autorestart-row'] === 'string',
  )
}

/** The input of one setting. */
function inputOf(panel, key) {
  const found = walk(panel).find(
    (node) => node.type === 'input' && node.props['data-dsh-autorestart-setting'] === key,
  )
  assert.ok(found, `the setting ${key} must have an input`)
  return found
}

/* ------------------------------------------------------------------ *
 * 1. THE SLIDING SWITCHES.
 * ------------------------------------------------------------------ */

test('every checkbox is a sliding switch: a real checkbox, a track and a dot', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: true, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')

  for (const key of ['backupOnRestart', 'backupIncludePlugins', 'pluginFilesWatch']) {
    const input = inputOf(panel, key)
    // The checkbox itself is the control: the keyboard reaches it and the
    // space bar flips it. Only its look is replaced.
    assert.equal(input.props.type, 'checkbox', `${key} is a native checkbox`)
    assert.equal(input.props.disabled, false, `${key} is usable`)
    assert.equal(
      String(input.props.className).includes('dsh-autorestart-settings__switch-input'),
      true,
      `${key} wears the switch class`,
    )

    // The track and the dot sit next to it.
    const wrap = walk(panel).find(
      (node) => node.type === 'span'
        && String(node.props.className) === 'dsh-autorestart-settings__switch'
        && walk(node).includes(input),
    )
    assert.ok(wrap, `${key} has a switch around it`)
    const track = walk(wrap).find(
      (node) => node.type === 'span'
        && String(node.props.className) === 'dsh-autorestart-settings__switch-track',
    )
    assert.ok(track, `${key} has a track`)
    const dot = walk(track).find(
      (node) => node.type === 'span'
        && String(node.props.className) === 'dsh-autorestart-settings__switch-dot',
    )
    assert.ok(dot, `${key} has a dot`)

    // The title is a real label for the checkbox: clicking the title flips
    // it, and a screen reader reads the title as the name of the control.
    const title = walk(panel).find(
      (node) => (node.type === 'label' || node.type === 'span')
        && node.props.htmlFor === input.props.id,
    )
    assert.ok(title, `${key} has a title that labels the checkbox`)
    assert.equal(typeof input.props.id, 'string', `${key} has an id to be labelled by`)
  }
})

test('a switch can be clicked and writes exactly the request of before', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: true, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')

  inputOf(panel, 'backupOnRestart').props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  let posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1, 'the click is written once')
  assert.deepEqual(
    JSON.parse(posts[0].init.body),
    { backupOnRestart: false },
    'the request carries the same key and the same value as before',
  )

  inputOf(panel, 'backupIncludePlugins').props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 2, 'the second click is written too')
  assert.deepEqual(
    JSON.parse(posts[1].init.body),
    { backupIncludePlugins: false },
    'the plugin scope is written with its own key',
  )

  inputOf(panel, 'pluginFilesWatch').props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 3, 'the watchdog is written too')
  assert.deepEqual(
    JSON.parse(posts[2].init.body),
    { pluginFilesWatch: false },
    'the watchdog keeps its boolean key',
  )
})

test('a switch that is disabled cannot be clicked (a save is running)', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: false, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')
  // Without a pre-restart backup there is nothing to extend: the scope
  // switch is greyed out.
  assert.equal(inputOf(panel, 'backupIncludePlugins').props.disabled, true, 'the scope is greyed out')
  assert.equal(inputOf(panel, 'backupOnRestart').props.disabled, false, 'the backup switch stays usable')
})

/* ------------------------------------------------------------------ *
 * 2. THE ROWS: one shape everywhere, the words folded away.
 * ------------------------------------------------------------------ */

test('every setting is a row: the title on the left, the control on the right', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: true, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const rows = rowsOf(panel)
  assert.ok(rows.length >= 8, `the page has rows (found ${rows.length})`)
  for (const row of rows) {
    const main = row.children.find(
      (child) => String(child.props.className) === 'dsh-autorestart-settings__row-main',
    )
    assert.ok(main, `${row.props['data-dsh-autorestart-row']} has a left column`)
    const title = main.children.find(
      (child) => child.type === 'label' || child.type === 'span',
    )
    assert.ok(title, `${row.props['data-dsh-autorestart-row']} has a title`)
    const control = row.children.find(
      (child) => String(child.props.className) === 'dsh-autorestart-settings__row-control',
    )
    assert.ok(control, `${row.props['data-dsh-autorestart-row']} has a right column`)
    assert.ok(
      control.children.length > 0,
      `${row.props['data-dsh-autorestart-row']} has a control on the right`,
    )
    // A row that SETS something carries a real control (a dropdown, a
    // switch, a number box); a row that only READS something shows its
    // value on the right.
    const sets = walk(control).some((node) => ['select', 'input'].includes(node.type))
    const reads = walk(control).some((node) => ['span', 'code', 'button'].includes(node.type))
    assert.ok(sets || reads, `${row.props['data-dsh-autorestart-row']} says something on the right`)
  }
})

test('every explanation sits behind one 「查看说明」 entry, closed by default', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: true, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const folds = walk(panel).filter(
    (node) => node.type === 'details'
      && typeof node.props['data-dsh-autorestart-row-help'] === 'string',
  )
  assert.ok(folds.length >= 8, `every row has a fold (found ${folds.length})`)
  for (const fold of folds) {
    assert.equal(fold.props.open, undefined, 'a fold starts closed')
    const summary = fold.children.find((child) => child.type === 'summary')
    assert.ok(summary, 'the fold has a summary')
    assert.equal(textOf(summary), '查看说明', 'the summary says exactly 「查看说明」')
  }

  // The words themselves are in the tree (only `<details>` hides them), so
  // opening the fold never re-mounts a control.
  const backupFold = folds.find(
    (fold) => fold.props['data-dsh-autorestart-row-help'] === 'backupOnRestart',
  )
  assert.ok(backupFold, 'the backup row has its fold')
  assert.equal(
    textOf(backupFold).includes('什么时候会备份？'),
    true,
    'the explanation of the backup row is inside the fold',
  )
  assert.equal(
    textOf(backupFold).includes('插件'),
    true,
    'and it still says what the copy holds',
  )
})

/* ------------------------------------------------------------------ *
 * 3. THE 「上次重启」 ROW IS GONE — THE DATA PIPE IS NOT.
 * ------------------------------------------------------------------ */

test('the 「上次重启」 row is gone from the page', async () => {
  const mounted = mountSettings({
    status: {
      backupOnRestart: true,
      lastLaunch: { launcher: 'wscript', fallbackReason: '', shimLeftBehind: false },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const rows = walk(panel).filter(
    (node) => node.props['data-dsh-autorestart-window'] === 'last-launch',
  )
  assert.equal(rows.length, 0, 'the row is not drawn any more')
  assert.equal(textOf(panel).includes('上次重启'), false, 'and its title is nowhere on the page')
})

test('the words of the removed row are gone from the dictionary too', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: { load: () => {} },
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
    navigator: { language: 'zh-CN' },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const api = sandbox.__dshAutorestartClient

  for (const key of [
    'settings.window.lastLabel',
    'settings.window.lastWscript',
    'settings.window.lastHidden',
    'settings.window.lastForeground',
    'settings.window.lastUnknown',
    'settings.window.lastFallback',
    'settings.window.shimLeft',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(api.dictionaries.zh, key),
      false,
      `${key} is not in the dictionary any more`,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(api.dictionaries.en, key),
      false,
      `${key} is not in the English dictionary any more`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * 4. THE 「更多设置」 BLOCK STANDS ON ITS OWN.
 * ------------------------------------------------------------------ */

test('the 「更多设置」 block stands after the shutdown settings, closed by default', async () => {
  const mounted = mountSettings({
    status: { backupOnRestart: true, backupIncludePlugins: true },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const advanced = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-advanced'] === 'section',
  )
  assert.ok(advanced, 'the block is there')
  assert.equal(advanced.props.open, undefined, 'it starts closed')

  // Its position: after the shutdown settings, before 「遇到问题」.
  const order = walk(panel)
    .filter((node) => typeof node.props['data-dsh-autorestart-group'] === 'string')
    .map((node) => node.props['data-dsh-autorestart-group'])
  assert.deepEqual(
    order,
    ['restart', 'shutdown', 'advanced', 'supervisor', 'report'],
    'the block stands between the shutdown settings and the report',
  )

  // Its four rows are the very same rows as everywhere else.
  const inner = rowsOf(advanced).map((row) => row.props['data-dsh-autorestart-row'])
  assert.deepEqual(
    inner,
    ['restartWindow', 'pluginFilesWatch', 'pluginFilesStableMs', 'pluginFilesMaxBlockMs'],
    'the block carries the restart window and the plugin-folder watchdog',
  )
  for (const row of rowsOf(advanced)) {
    assert.ok(
      row.children.some(
        (child) => String(child.props.className) === 'dsh-autorestart-settings__row-control',
      ),
      `${row.props['data-dsh-autorestart-row']} has the same right column`,
    )
    assert.ok(
      walk(row).some((node) => node.type === 'details' && node.props['data-dsh-autorestart-row-help']),
      `${row.props['data-dsh-autorestart-row']} has the same fold`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * 5. THE DEFAULT IS THE BACKGROUND — AND A STORED FOREGROUND IS KEPT.
 * ------------------------------------------------------------------ */

test('the restart helper runs in the background unless the machine chose otherwise', async () => {
  const silent = mountSettings({ status: { backupOnRestart: true } })
  const panel = await silent.settled('dsh-autorestart')
  const choice = walk(panel).find(
    (node) => node.type === 'select'
      && node.props['data-dsh-autorestart-setting'] === 'restartWindow',
  )
  assert.ok(choice, 'the restart window has a dropdown')
  assert.equal(
    choice.props.value,
    'background',
    'a machine that never chose anything gets the background behaviour',
  )

  // A machine that already stored `foreground` keeps it.
  const stored = mountSettings({ status: { backupOnRestart: true, restartWindow: 'foreground' } })
  const storedPanel = await stored.settled('dsh-autorestart')
  const storedChoice = walk(storedPanel).find(
    (node) => node.type === 'select'
      && node.props['data-dsh-autorestart-setting'] === 'restartWindow',
  )
  assert.equal(
    storedChoice.props.value,
    'foreground',
    'an explicitly stored foreground is not overwritten by the new default',
  )
})

/* ------------------------------------------------------------------ *
 * 6. THE TWO SCALES OF THE WATCHDOG (user decision, 2026-11-11).
 *
 * The user read the page and said: the two durations have no subject, they
 * do not look like they belong to the switch above them, and nobody should
 * have to type a number. So they became dropdowns of the usual lengths, they
 * are drawn as the CHILDREN of the switch, and they go grey when that switch
 * is off.
 * ------------------------------------------------------------------ */

/** The 「更多设置」 block of the settings page. */
function advancedBlock(panel) {
  const found = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-advanced'] === 'section',
  )
  assert.ok(found, 'the 「更多设置」 block must be there')
  return found
}

/** The dropdown of one setting. */
function selectOf(panel, key) {
  const found = walk(panel).find(
    (node) => node.type === 'select' && node.props['data-dsh-autorestart-setting'] === key,
  )
  assert.ok(found, `the setting ${key} must have a dropdown`)
  return found
}

/** The options of a dropdown: their values and their texts. */
function optionsOf(select) {
  return walk(select)
    .filter((node) => node.type === 'option')
    .map((node) => ({ value: node.props.value, text: textOf(node) }))
}

/** The row of one setting. */
function rowOf(panel, key) {
  const found = walk(panel).find((node) => node.props['data-dsh-autorestart-row'] === key)
  assert.ok(found, `the setting ${key} must have a row`)
  return found
}

test('the two durations are dropdowns of the usual lengths', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  const stable = selectOf(panel, 'pluginFilesStableMs')
  assert.deepEqual(
    optionsOf(stable).map((option) => option.value),
    ['5000', '10000', '15000', '30000', '60000'],
    'the seconds are the usual lengths',
  )
  assert.deepEqual(
    optionsOf(stable).map((option) => option.text),
    ['5 秒', '10 秒', '15 秒', '30 秒', '60 秒'],
    'and they say how long they are',
  )
  assert.equal(stable.props.value, '15000', 'the default is 15 seconds')

  const max = selectOf(panel, 'pluginFilesMaxBlockMs')
  assert.deepEqual(
    optionsOf(max).map((option) => option.value),
    ['300000', '600000', '1800000', '3600000'],
    'the minutes are the usual lengths',
  )
  assert.deepEqual(
    optionsOf(max).map((option) => option.text),
    ['5 分钟', '10 分钟', '30 分钟', '60 分钟'],
    'and they say how long they are',
  )
  assert.equal(max.props.value, '300000', 'the default is 5 minutes')
})

test('a length that is not one of the usual ones stays in the list as 「当前值」', async () => {
  const mounted = mountSettings({
    status: {
      backupOnRestart: true,
      pluginFiles: { watched: true, stableMs: 7000, maxBlockMs: 900000 },
    },
  })
  const panel = await mounted.settled('dsh-autorestart')

  const stable = selectOf(panel, 'pluginFilesStableMs')
  const stableOptions = optionsOf(stable)
  assert.equal(stableOptions.length, 6, 'the length in force is appended to the usual ones')
  assert.equal(stableOptions[5].value, '7000', 'the appended option carries the length in force')
  assert.equal(stable.props.value, '7000', 'and it is the one that is selected')
  assert.equal(stableOptions[5].text.includes('当前值'), true, 'the appended option says so')
  assert.equal(stableOptions[5].text.includes('7 秒'), true, 'and it says which length it is')

  const max = selectOf(panel, 'pluginFilesMaxBlockMs')
  assert.equal(max.props.value, '900000', 'the other length is kept as it is too')
  const maxOptions = optionsOf(max)
  assert.equal(maxOptions.length, 5, 'its length is appended as well')
  assert.equal(maxOptions[4].value, '900000', 'the appended option carries it')
  assert.equal(maxOptions[4].text.includes('当前值'), true, 'and it says so as well')
  assert.equal(maxOptions[4].text.includes('15 分钟'), true, 'and it says which length it is')
})

test('choosing a length writes the milliseconds', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  selectOf(panel, 'pluginFilesStableMs').props.onChange({ target: { value: '30000' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  selectOf(panel, 'pluginFilesMaxBlockMs').props.onChange({ target: { value: '1800000' } })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 2, 'both choices are written')
  assert.deepEqual(
    JSON.parse(posts[0].init.body),
    { pluginFilesStableMs: 30000 },
    'the request is in milliseconds, and the key did not change',
  )
  assert.deepEqual(
    JSON.parse(posts[1].init.body),
    { pluginFilesMaxBlockMs: 1800000 },
    'the same for the other length',
  )
})

test('the two durations are drawn as the children of the switch above them', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true, pluginFiles: { watched: true } } })
  const panel = await mounted.settled('dsh-autorestart')

  // There are TWO subordinate blocks on the page now (the plugin-folder scales
  // and the backup's 「include plugins」 row), so pick the one that holds them.
  const subrows = walk(panel)
    .filter((node) => String(node.props.className) === 'dsh-autorestart-settings__subrows')
    .find((node) => walk(node).some(
      (inner) => inner.props['data-dsh-autorestart-row'] === 'pluginFilesStableMs',
    ))
  assert.ok(subrows, 'the two durations sit in a block of their own')
  assert.deepEqual(
    subrows.children.map((child) => child.props['data-dsh-autorestart-row']),
    ['pluginFilesStableMs', 'pluginFilesMaxBlockMs'],
    'the block holds the two durations',
  )
  // The switch is their PARENT, not one of them.
  const watch = rowOf(panel, 'pluginFilesWatch')
  assert.equal(
    walk(watch).some((node) => node.props['data-dsh-autorestart-row'] === 'pluginFilesStableMs'),
    false,
    'the switch row does not contain the durations',
  )
  // The titles say WHO they wait for.
  assert.equal(
    textOf(rowOf(panel, 'pluginFilesStableMs')).includes('等待插件没有文件改动多少秒，就算装完'),
    true,
    'the first title has a subject',
  )
  assert.equal(
    textOf(rowOf(panel, 'pluginFilesMaxBlockMs')).includes('最多等插件安装多久'),
    true,
    'the second title has a subject',
  )
})

test('the switch off greys the two durations, and the page says why', async () => {
  const off = mountSettings({
    status: { backupOnRestart: true, pluginFiles: { watched: false } },
  })
  const panel = await off.settled('dsh-autorestart')
  for (const key of ['pluginFilesStableMs', 'pluginFilesMaxBlockMs']) {
    assert.equal(selectOf(panel, key).props.disabled, true, `${key} is greyed out while the switch is off`)
    const row = rowOf(panel, key)
    assert.equal(
      String(row.props.className).includes('dsh-autorestart-settings__row--off'),
      true,
      `${key} is marked as off`,
    )
    assert.equal(row.props['aria-disabled'], 'true', `${key} says it is disabled`)
  }
  // The sentence that explains the switch lives WITH the switch (user decision,
  // 2026-11-11): it talks about the switch, so it belongs to its row.
  assert.equal(
    textOf(rowOf(panel, 'pluginFilesWatch')).includes('关掉上面那个开关时，这两项不起作用'),
    true,
    'the switch row explains what happens to the two rows below it',
  )

  const on = mountSettings({
    status: { backupOnRestart: true, pluginFiles: { watched: true } },
  })
  const onPanel = await on.settled('dsh-autorestart')
  for (const key of ['pluginFilesStableMs', 'pluginFilesMaxBlockMs']) {
    assert.equal(selectOf(onPanel, key).props.disabled, false, `${key} is usable again`)
  }
})

test('each duration explains what it is for, in the words of the user', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  const stable = textOf(rowOf(panel, 'pluginFilesStableMs'))
  assert.equal(
    stable.includes('插件安装时，文件是一个一个写进来的，中间会有停顿。这里设定：插件目录连续这么多秒没有新的文件变动，就当作装完了，重启或关机可以继续。'),
    true,
    'the seconds explain what the quiet time is for',
  )

  const max = textOf(rowOf(panel, 'pluginFilesMaxBlockMs'))
  assert.equal(
    max.includes('这是兜底：万一插件安装卡住了（比如网络断了、安装进程卡死），也不会永远等下去——最多等这么久；超过这个时间就照常重启或关机，不再等它。'),
    true,
    'the minutes explain that a stuck install is not waited for for ever',
  )
  // The three things the user asked for are all in there.
  assert.equal(max.includes('兜底'), true, 'it is the safety net')
  assert.equal(max.includes('卡住'), true, 'it says what it is there for')
  assert.equal(max.includes('不会永远等下去'), true, 'and that it never waits for ever')
})

test('the backup fold carries the same title as every other fold', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')
  const fold = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-backup'] === 'section',
  )
  assert.ok(fold, 'the backup fold is there')
  const summary = fold.children.find((child) => child.type === 'summary')
  assert.ok(summary, 'the backup fold has a title')
  assert.equal(textOf(summary), '备份信息', 'the backup fold says what is inside it')

  // And its content is still there.
  const inside = new Set(walk(fold).map((node) => node.props && node.props['data-dsh-autorestart-backup'])
    .filter((value) => typeof value === 'string'))
  for (const key of ['list', 'count', 'keep', 'limit-select']) {
    assert.equal(inside.has(key), true, `"${key}" is still inside the fold`)
  }
})

/* ------------------------------------------------------------------ *
 * 7. THE BACKUP BLOCK, ROUND THREE (user decision, 2026-11-11).
 *
 * The user read the second round on screen and said two things: the fold
 * called 「查看说明」 repeats the words of every other row and does not say
 * that it is about backups, and 「备份包含已安装插件」 looks like a sibling of
 * the backup switch although it only means something when that switch is on.
 * ------------------------------------------------------------------ */

/** The 「备份信息」 fold of the settings page. */
function backupFold(panel) {
  const found = walk(panel).find(
    (node) => node.type === 'details' && node.props['data-dsh-autorestart-backup'] === 'section',
  )
  assert.ok(found, 'the backup fold must be there')
  return found
}

/** Every subordinate block of the page. */
function subrowBlocks(panel) {
  return walk(panel).filter(
    (node) => String(node.props.className) === 'dsh-autorestart-settings__subrows',
  )
}

test('the backup fold says what is inside it, not 「查看说明」 again', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  const summary = backupFold(panel).children.find((child) => child.type === 'summary')
  assert.ok(summary, 'the backup fold has a title')
  assert.equal(textOf(summary), '备份信息', 'the fold says it is about backups')

  // No other fold on the page may carry that same wording either — the point
  // was that two folds were called the same thing.
  const otherSummaries = walk(panel)
    .filter((node) => node.type === 'summary')
    .filter((node) => node !== summary)
    .map((node) => textOf(node))
  assert.equal(
    otherSummaries.includes('备份信息'),
    false,
    `only the backup fold says 「备份信息」: ${JSON.stringify(otherSummaries)}`,
  )
})

test('「备份包含已安装插件」 is drawn as a child of the backup switch', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  const blocks = subrowBlocks(panel)
  assert.equal(blocks.length, 2, 'the page has two subordinate blocks: the watchdog scales and the backup row')
  const backupBlock = blocks.find((block) => walk(block).some(
    (inner) => inner.props['data-dsh-autorestart-row'] === 'backupIncludePlugins',
  ))
  assert.ok(backupBlock, 'the 「include plugins」 row sits in a subordinate block')
  assert.deepEqual(
    backupBlock.children.map((child) => child.props['data-dsh-autorestart-row']),
    ['backupIncludePlugins'],
    'that block holds exactly that one row',
  )
  // The switch above it is NOT inside the block: the block is its child.
  assert.equal(
    walk(rowOf(panel, 'backupOnRestart')).some(
      (inner) => inner.props['data-dsh-autorestart-row'] === 'backupIncludePlugins',
    ),
    false,
    'the backup switch row does not contain the 「include plugins」 row',
  )
  // Both blocks use the very same class, so they look the same.
  const watchdogBlock = blocks.find((block) => walk(block).some(
    (inner) => inner.props['data-dsh-autorestart-row'] === 'pluginFilesStableMs',
  ))
  assert.ok(watchdogBlock, 'the watchdog scales have their block too')
  assert.equal(
    String(watchdogBlock.props.className),
    String(backupBlock.props.className),
    'the two blocks are styled by the same class',
  )
})

test('the backup switch off disables 「备份包含已安装插件」, and the page says why', async () => {
  const off = mountSettings({ status: { backupOnRestart: false } })
  const panel = await off.settled('dsh-autorestart')

  const row = rowOf(panel, 'backupIncludePlugins')
  assert.equal(
    String(row.props.className).includes('dsh-autorestart-settings__row--off'),
    true,
    'the row is marked as off while the backup switch is off',
  )
  assert.equal(row.props['aria-disabled'], 'true', 'and says it is disabled')
  const control = walk(row).find(
    (node) => node.props['data-dsh-autorestart-setting'] === 'backupIncludePlugins',
  )
  assert.ok(control, 'the row has its switch')
  assert.equal(control.props.disabled, true, 'the switch is not clickable')
  assert.equal(
    textOf(row).includes('关掉上面那个开关（重启前备份）时，这一项不起作用'),
    true,
    'and the row explains what the switch above it does',
  )

  const on = mountSettings({ status: { backupOnRestart: true } })
  const onPanel = await on.settled('dsh-autorestart')
  const onControl = walk(rowOf(onPanel, 'backupIncludePlugins')).find(
    (node) => node.props['data-dsh-autorestart-setting'] === 'backupIncludePlugins',
  )
  assert.equal(onControl.props.disabled, false, 'it is usable again when the backup is on')
  assert.equal(
    String(rowOf(onPanel, 'backupIncludePlugins').props.className).includes('__row--off'),
    false,
    'and it is not marked as off',
  )
})

test('the minutes are four lengths, and the dropdown is wide enough for them', async () => {
  const mounted = mountSettings({ status: { backupOnRestart: true } })
  const panel = await mounted.settled('dsh-autorestart')

  const max = selectOf(panel, 'pluginFilesMaxBlockMs')
  assert.deepEqual(
    optionsOf(max).map((option) => option.value),
    ['300000', '600000', '1800000', '3600000'],
    'the minutes are 5 / 10 / 30 / 60 — one and three are gone',
  )
  assert.equal(optionsOf(max).length, 4, 'and nothing else is offered')
  assert.equal(max.props.value, '300000', 'the default is still 5 minutes')

  // The seconds did not move.
  assert.deepEqual(
    optionsOf(selectOf(panel, 'pluginFilesStableMs')).map((option) => option.value),
    ['5000', '10000', '15000', '30000', '60000'],
    'the seconds keep their five lengths',
  )
})

test('the stylesheet gives the control column and the dropdowns more room', async () => {
  const css = fs.readFileSync(
    new URL('../client.js', import.meta.url),
    'utf8',
  )
  assert.equal(
    css.includes('grid-template-columns:minmax(0,1fr) 260px;'),
    true,
    'the control column is 260px wide, not 220px',
  )
  assert.equal(
    css.includes('grid-template-columns:minmax(0,1fr) 220px;'),
    false,
    'the old 220px column is gone',
  )
  assert.equal(
    /\.dsh-autorestart-settings__row-control > \.dsh-autorestart-settings__select\{[^}]*min-width:200px/.test(css),
    true,
    'and a dropdown never shrinks below 200px',
  )
})
