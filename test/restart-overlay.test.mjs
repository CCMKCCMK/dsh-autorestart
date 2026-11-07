/**
 * THE RESTART STAGE ON THE INTERFACE — the centred overlay, and the short line
 * the composer row keeps.
 *
 * THE REPORT (user, 2026-10-29): the stage of a restart lived in the composer
 * row — one clipped line inside a 22px toolbar. On a window that is not very
 * wide it read "正在等待所有会话空闲…" and the rest was CUT OFF, so the one
 * thing the user needed (how many conversations still hold the restart, how
 * much of the backup is written) was exactly what the ellipsis ate.
 *
 * THE FIX, as this file pins it down:
 *
 *   1. the DETAIL moved to a CENTRED OVERLAY (320px, one short line):
 *      waiting = "等待会话空闲" + "还有 N 个会话",
 *      snapshotting = "备份中，共 40 MB" and then "备份完成，正在重启…"
 *      (no bar, no clock — user decision, 2026-11-07),
 *      restarting = "正在重启…", back = "已回来" for 1.5s and then gone;
 *   2. the composer row got SHORT again: one line, never a sentence, and the
 *      long text of the Host never appears there any more;
 *   3. the overlay is PER PAGE: it reads what its host reports and remembers
 *      nothing, so an interface that is opened again shows the real stage.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// The client script publishes its pure helpers on the global namespace.
import '../client.js'

const api = globalThis.__dshAutorestartClient

/* ------------------------------------------------------------------ *
 * A tiny React stand-in (the client half is a classic script).
 * ------------------------------------------------------------------ */

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => { values.set(String(key), String(value)) },
    removeItem: (key) => { values.delete(String(key)) },
    clear: () => { values.clear() },
  }
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

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

/** The node that carries `attribute` (undefined when absent). */
function findByAttribute(tree, attribute) {
  return walk(tree).find((node) => node.props && node.props[attribute] !== undefined)
}

/* ------------------------------------------------------------------ *
 * The Host payload: what `GET …/health?state=1` really answers.
 * ------------------------------------------------------------------ */

/** The long sentence the user could not read (kept as the tooltip only). */
const LONG_ZH = '正在等待所有会话空闲…（还有 2 个会话在忙）'
const LONG_EN = 'Waiting for every conversation to be idle… (2 conversations busy)'

/**
 * A pending restart this page waits for, with the stage the Host reports.
 *
 * @param {{ phase?: string, blocking?: number, progress?: object|null, blockedBy?: object[] }} [options]
 */
function statePayload({
  phase = 'waiting',
  pendingRestart = true,
  blocking = 2,
  progress = null,
  blockedBy = null,
  snapshotBytes = null,
  // When the Host last touched the stage: the staleness tests need a stage that
  // was last refreshed N seconds ago.
  at = Date.now(),
  // WHY the stage is what it is ("deferred: …" = the restart was postponed).
  reason = null,
  // The number of conversations that hold the gate (the Host publishes it).
  busyCount = null,
} = {}) {
  return {
    ok: true,
    pendingRestart,
    waiters: ['sess-x'],
    blockedBy: blockedBy || [
      { sessionId: 'sess-y', kind: 'session', label: '写代码', name: '写代码', reason: 'running' },
      { sessionId: 'sess-z', kind: 'session', label: '调研', name: '调研', reason: 'running' },
    ],
    allowRestart: false,
    reason: 'blocked',
    busyCount,
    restartPhase: {
      phase,
      at,
      elapsedMs: 3000,
      // The number the overlay prints: it travels as a NUMBER, not only inside
      // the sentence (a surface with room for two words must not parse a text).
      blocking,
      progress,
      // The size of the pre-restart snapshot, carried on EVERY stage (the Host
      // keeps it so a page that missed the copy can still report it).
      snapshotBytes,
      reason,
      slow: null,
      cancellable: phase === 'waiting' || phase === 'snapshotting',
      cancelReason: null,
      text: { zh: LONG_ZH, en: LONG_EN },
    },
  }
}

/** Mount the client with a mutable Host state. */
function mountClient({ health = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const dictionaries = {}
  const slots = new Map()
  const pollers = []
  // The cadence of every timer the store armed, in order: the tests read the last
  // one (2 s normally, 500 ms while a restart is moving).
  const periods = []
  const fetches = { count: 0 }
  // A held answer: while it is set, the next request stays in flight.
  let heldAnswer = null
  // The document listeners the client binds (visibilitychange).
  const docListeners = {}
  const state = { health: { ...health } }

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
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
      hidden: false,
      visibilityState: 'visible',
      addEventListener: (type, handler) => {
        docListeners[type] = handler
      },
      removeEventListener: () => {},
    },
    fetch: () => {
      fetches.count += 1
      const answer = { ok: true, status: 200, json: async () => state.health }
      if (heldAnswer !== null) return heldAnswer.then(() => answer)
      return Promise.resolve(answer)
    },
    console,
    setTimeout,
    clearTimeout,
    // The shared poll: its interval callback is kept, so a test can move the
    // Host on (a restart does not stand still while a page watches it).
    setInterval: (fn, ms) => {
      pollers.push(fn)
      periods.push(ms)
      return pollers.length
    },
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
        const entry = (produced && typeof produced.next === 'function')
          ? produced.next().value
          : produced
        if (entry && entry.registration && entry.registration.id === id) return entry.Component
      }
    }
    assert.fail(`the component ${id} must be registered`)
  }

  return {
    /** The state the Host reports. */
    setHealth: (next) => { state.health = { ...next } },
    /** The slot names the plugin registered (the overlay lives in shell.overlay). */
    slotNames: () => [...slots.keys()],
    /** Render once (and let a pending poll land), then render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
    /** ONE render, without a poll: this is what the FIRST frame shows. */
    firstFrame: (id) => harness.render(componentOf(id), {}),
    /** Let the shared poll land (one round), then render. */
    poll: async (id) => {
      for (const poller of pollers) poller()
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(componentOf(id), {})
    },
    /** Render without waiting for the poll (the timer tests need the same tree). */
    render: (id, props) => harness.render(componentOf(id), props || {}),
    /** The cadence of the LAST timer the shared poll armed (ms). */
    lastPeriod: () => (periods.length === 0 ? 0 : periods[periods.length - 1]),
    /** Every cadence it ever armed (the tests check the transitions). */
    periods: () => periods.slice(),
    /** How many state requests were made. */
    fetchCount: () => fetches.count,
    /** Hide or show the page (the browser sets document.hidden). */
    setHidden: (value) => {
      sandbox.document.hidden = value === true
      sandbox.document.visibilityState = value === true ? 'hidden' : 'visible'
    },
    /** Fire the visibilitychange the browser would fire. */
    fireVisibility: () => {
      const handler = docListeners.visibilitychange
      if (typeof handler === 'function') handler()
    },
    /** Hold the next answer in flight; the returned function releases it. */
    holdFetch: () => {
      let release = null
      heldAnswer = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        const pending = heldAnswer
        heldAnswer = null
        if (pending !== null) release()
        return pending
      }
    },
  }
}

/** The pill's visible capsule (not the tooltip, not the panel). */
function capsuleOf(pill) {
  return walk(pill).find((node) => node.props && node.props['aria-haspopup'] === 'dialog')
}

/** The one visible line of the composer row. */
function capsuleCopy(pill) {
  const capsule = capsuleOf(pill)
  assert.ok(capsule, 'the pill must be on screen')
  return textOf(capsule)
}

/** The CJK characters of a text (what a reader counts as 字). */
function cjkCount(text) {
  return [...String(text)].filter((character) => /[\u3400-\u9fff]/.test(character)).length
}

/* ------------------------------------------------------------------ *
 * 1. WHILE THE GATE WAITS THERE IS NO CARD AT ALL (the user's second report).
 * ------------------------------------------------------------------ */

test('phase=waiting (pending): the overlay is NOT drawn — the pill carries the count', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', pendingRestart: true, blocking: 2 }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')
  assert.equal(
    overlay,
    null,
    'nothing is in progress yet, so no card: "不是应该触发备份才触发吗？"',
  )

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const copy = capsuleCopy(pill)
  assert.match(copy, /^待重启 · 等待 2 个/, `the pill still says how many conversations hold it: ${copy}`)
})

test('the FIRST frame of a page never flashes a card', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 1024 * 1024, total: 2 * 1024 * 1024, percent: 50 } }),
  })
  // Before the first poll there is no state at all: the first frame is empty.
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null, 'no card on the very first frame')
})

test('no restart at all: an idle host draws nothing, ever', async () => {
  const mounted = mountClient({ health: { ok: true, pendingRestart: false } })
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null)
  assert.equal(await mounted.settled('autorestart-restart-overlay'), null)
})

/* ------------------------------------------------------------------ *
 * 2. The centred overlay: the backup, with the real numbers.
 * ------------------------------------------------------------------ */

test('phase=snapshotting: the overlay says 「备份中，共 40 MB」 — no bar, no percentage', async () => {
  const progress = {
    bytes: Math.round(12.3 * 1024 * 1024),
    total: 40 * 1024 * 1024,
    percent: 31,
    files: 120,
    filesTotal: 400,
  }
  const mounted = mountClient({ health: statePayload({ phase: 'snapshotting', progress }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')

  assert.ok(overlay, 'the overlay shows the backup')
  assert.equal(overlay.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting')
  const copy = textOf(overlay)
  // THE OWNER'S DECISION (2026-11-07): "从『备份中，共XXX MB』备份完就切换到
  // 『备份完成，正在重启…』，这样就不用考虑进度条的事情了". The title states the
  // REAL total (formatOverlaySize keeps the unit, so 40 MB never degrades to 0).
  assert.match(copy, /备份中，共 40 MB/, `the card states the total being copied: ${copy}`)
  assert.doesNotMatch(copy, /正在备份/, `no bare "正在备份" on the card any more: ${copy}`)
  // NO BAR AND NO PERCENTAGE (user decision): the page polls every 500 ms while
  // a restart moves and a 276.5 MB copy is over inside one or two polls, so a
  // bar can only ever be caught at 0–5% — the card measures nothing any more.
  assert.equal(findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-bar'), undefined, 'no progress bar')
  assert.equal(findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-size'), undefined, 'no running byte count')
  assert.equal(findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-percent'), undefined, 'no percentage')
  assert.doesNotMatch(copy, /%/, `no percentage in the text: ${copy}`)
  assert.doesNotMatch(copy, /12\.3 MB/, `the running byte count is gone: ${copy}`)
})

test('phase=snapshotting: before the first measurement no number is invented', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'snapshotting', progress: null }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')
  assert.ok(overlay)
  assert.match(textOf(overlay), /备份中…/)
  assert.doesNotMatch(textOf(overlay), /MB/, 'nothing is measured yet, so nothing is claimed')
  assert.equal(findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-size'), undefined)
})

/* ------------------------------------------------------------------ *
 * 3. restarting: the card stays.
 * ------------------------------------------------------------------ */

test('phase=restarting: the overlay does not disappear (the host is on its way out)', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }) })
  let overlay = await mounted.settled('autorestart-restart-overlay')
  assert.ok(overlay, 'the card is there')
  assert.match(textOf(overlay), /正在重启/, `the card says the host is restarting: ${textOf(overlay)}`)
  // Long after a "back" card would have folded away, the restarting card is
  // still on screen: nothing times it out.
  await new Promise((resolve) => setTimeout(resolve, 1700))
  overlay = mounted.render('autorestart-restart-overlay')
  assert.ok(overlay, 'the card is still there 1.7s later')
  assert.equal(overlay.props['data-dsh-autorestart-restart-overlay-phase'], 'restarting')
})

/* ------------------------------------------------------------------ *
 * 4. back: 1.5s and gone — and ONLY for a restart this page watched.
 * ------------------------------------------------------------------ */

test('phase=back: a page that watched the restart says 已回来 for 1.5s and then folds away', async () => {
  // The page follows a restart that is really running…
  const mounted = mountClient({
    health: statePayload({ phase: 'restarting', pendingRestart: true, blocking: 0, blockedBy: [] }),
  })
  assert.ok(await mounted.settled('autorestart-restart-overlay'), 'the restarting card is there')

  // …then the new host is up: the Host reports `back` and no pending restart.
  mounted.setHealth(statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }))
  const back = await mounted.poll('autorestart-restart-overlay')
  assert.ok(back, 'the card greets the user')
  assert.match(textOf(back), /已回来/, `the card says the user is back: ${textOf(back)}`)

  // Still there 1s later (the user has to be able to read it)…
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.ok(mounted.render('autorestart-restart-overlay'), 'the card is still there after 1s')

  // …and gone after 1.5s.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(
    mounted.render('autorestart-restart-overlay'),
    null,
    '"已回来" is a moment, not a state: the card is gone after 1.5s',
  )
})

test('phase=back left over in the state file: a fresh page draws NOTHING', async () => {
  // This is what a page finds when it is opened AFTER a restart: the old stage
  // is still in the state file and `pendingRestart` is false. A card that said
  // "已回来" now would be a lie about a restart from ten minutes ago.
  const mounted = mountClient({ health: statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null, 'not on the first frame')
  assert.equal(
    await mounted.settled('autorestart-restart-overlay'),
    null,
    'a leftover stage is not a running restart: no card at all',
  )
})

test('a leftover stage with no pending restart draws nothing either', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(await mounted.settled('autorestart-restart-overlay'), null, 'a stale stage is not an action')
})

/* ------------------------------------------------------------------ *
 * 5. Per page: the overlay shows what its host reports, and remembers nothing.
 * ------------------------------------------------------------------ */

test('the overlay is per page: a second page shows its own host state, not a remembered one', async () => {
  const first = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 1024 * 1024, total: 4 * 1024 * 1024, percent: 25 } }),
  })
  const firstCard = await first.settled('autorestart-restart-overlay')
  assert.equal(firstCard.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting')

  // Another page (a fresh mount) whose host has already finished, its state
  // file still holding the goodbye of that restart.
  const second = mountClient({ health: statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(
    await second.settled('autorestart-restart-overlay'),
    null,
    'the new page follows its own polling: it never replays an earlier page state',
  )
})

/* ------------------------------------------------------------------ *
 * 6. The composer row: ONE short line, never the long sentence.
 * ------------------------------------------------------------------ */

/** The pill of this page, rendered with a state. */
async function pillCopyFor(payload) {
  const mounted = mountClient({ health: payload })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  return capsuleCopy(pill)
}

test('the composer row says it in a SHORT line while the gate waits', async () => {
  const busy = await pillCopyFor(statePayload({ phase: 'waiting', blocking: 2 }))
  // The WORDING of the count belongs to the pending-restart capsule itself (it
  // is the same sentence the pill always had, "任务" or "会话" depending on the
  // task that owns it); what THIS task guarantees is that it stays ONE SHORT
  // LINE and that the count is still in it.
  assert.match(busy, /^待重启 · 等待 2 个/, `the count is still there, in one short line: ${busy}`)
  assert.doesNotMatch(busy, /[（]/, `no parenthetical in the pill: ${busy}`)

  const idle = await pillCopyFor(statePayload({ phase: 'waiting', blocking: 0, blockedBy: [] }))
  assert.equal(idle, '待重启 · 空闲后自动重启', `the idle line is the pre-restart line: ${idle}`)
})

test('the composer row shows the stage alone once the backup runs (and after it)', async () => {
  const snapshotting = await pillCopyFor(statePayload({
    phase: 'snapshotting',
    progress: { bytes: Math.round(12.3 * 1024 * 1024), total: 40 * 1024 * 1024, percent: 31 },
  }))
  assert.equal(snapshotting, '重启前备份中', `the backup is one short phrase: ${snapshotting}`)
  assert.ok(snapshotting.length <= 12, `and it stays short (<= 12): ${snapshotting.length}`)

  const restarting = await pillCopyFor(statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }))
  assert.equal(restarting, '正在重启…', `restarting is one word: ${restarting}`)

  const back = await pillCopyFor(statePayload({ phase: 'back', blocking: 0, blockedBy: [] }))
  assert.equal(back, '已回来', `and so is the return: ${back}`)
})

test('the composer row NEVER carries the long sentence that was cut off', async () => {
  const cases = [
    ['waiting', await pillCopyFor(statePayload({ phase: 'waiting', blocking: 2 }))],
    ['waiting-idle', await pillCopyFor(statePayload({ phase: 'waiting', blocking: 0, blockedBy: [] }))],
    ['snapshotting', await pillCopyFor(statePayload({
      phase: 'snapshotting',
      progress: { bytes: Math.round(12.3 * 1024 * 1024), total: 40 * 1024 * 1024, percent: 31 },
    }))],
    ['restarting', await pillCopyFor(statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }))],
    ['back', await pillCopyFor(statePayload({ phase: 'back', blocking: 0, blockedBy: [] }))],
  ]
  for (const [label, copy] of cases) {
    // The fragments of the sentence the user could not read (the host still
    // sends it as `text`, and it must stay out of this row).
    assert.doesNotMatch(copy, /会话空闲/, `${label}: no long sentence piece in the pill — ${copy}`)
    assert.doesNotMatch(copy, /（/, `${label}: no parenthetical in the pill — ${copy}`)
    assert.doesNotMatch(copy, /正在等待/, `${label}: no "waiting for…" sentence — ${copy}`)
    assert.doesNotMatch(copy, /MB/, `${label}: the megabytes belong to the overlay — ${copy}`)
    // ONE line, and short: at most 12 字 (the spaces, the separator and the
    // digits are not 字), and 16 visible characters in total.
    assert.ok(cjkCount(copy) <= 12, `${label}: at most 12 字 — ${copy} (${cjkCount(copy)})`)
    assert.ok(copy.length <= 16, `${label}: at most 16 visible characters — ${copy} (${copy.length})`)
  }
})

test('the long sentence of the Host is now only the tooltip of the pill', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', blocking: 2 }) })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const capsule = capsuleOf(pill)
  assert.match(textOf(capsule), /^待重启 · 等待 2 个/, 'the pill says the count, in one short line')
  // The detail is not lost: the tooltip still carries it (a hover, a screen
  // reader), and the overlay carries it on the interface itself.
  const withTitle = walk(pill).filter((node) => node.props && typeof node.props.title === 'string')
  assert.ok(withTitle.length > 0, 'the pill keeps its tooltip')
})

/* ------------------------------------------------------------------ *
 * 7. The pure helpers behind the copy.
 * ------------------------------------------------------------------ */

test('the composer copy of every stage is short, in BOTH languages', () => {
  const stages = ['snapshotting', 'restarting', 'back']
  for (const language of ['zh', 'en']) {
    const t = (key) => (api.dictionaries[language][key] !== undefined ? api.dictionaries[language][key] : key)
    for (const phase of stages) {
      const text = api.restartPillStageText({ phase }, t)
      assert.ok(text !== '', `${phase} has a text in ${language}`)
      assert.ok(text.length <= 12, `${phase}/${language}: ${text} is at most 12 characters`)
      assert.ok(cjkCount(text) <= 12, `${phase}/${language}: ${text} is at most 12 字`)
    }
    // `waiting` DELIBERATELY has no word of its own: the pill already says
    // "待重启 · 等待 N 个会话" / "待重启 · 空闲后自动重启" there.
    assert.equal(api.restartPillStageText({ phase: 'waiting' }, t), '')
    assert.equal(api.restartPillStageText({ phase: 'idle' }, t), '')
    assert.equal(api.restartPillStageText(null, t), '')
  }
})

test('the overlay has a title for the stages it draws, and the megabytes read like numbers', () => {
  for (const language of ['zh', 'en']) {
    const t = (key) => (api.dictionaries[language][key] !== undefined ? api.dictionaries[language][key] : key)
    for (const phase of ['snapshotting', 'restarting', 'back']) {
      assert.equal(api.isRestartOverlayPhase(phase), true)
      const title = api.restartOverlayTitle({ phase }, t)
      assert.ok(title !== '', `${phase} has an overlay title in ${language}`)
      // Not a paragraph: the card is 320px wide and shrinks its font, so a
      // short phrase fits — but nothing long enough to be cut may get in.
      assert.ok(title.length <= 40, `${phase}/${language}: ${title} is a short phrase`)
    }
    // No card is drawn while the gate merely waits, so there is no copy for it.
    assert.equal(api.isRestartOverlayPhase('waiting'), false)
    assert.equal(api.restartOverlayTitle({ phase: 'waiting' }, t), '')
    assert.equal(api.isRestartOverlayPhase('idle'), false)
    assert.equal(api.restartOverlayTitle({ phase: 'idle' }, t), '')
  }
  // THE UNIT FITS THE SIZE: a 92 KB profile is not "0 MB".
  assert.equal(api.formatOverlaySize(92 * 1024), '92 KB')
  assert.equal(api.formatOverlaySize(156 * 1024 * 1024), '156 MB')
  assert.equal(api.formatOverlaySize(Math.round(12.3 * 1024 * 1024)), '12.3 MB')
  assert.equal(api.formatOverlaySize(40 * 1024 * 1024), '40 MB')
  assert.equal(api.formatOverlaySize(0), '0 B')
  assert.equal(api.formatOverlaySize(512), '512 B')
  assert.equal(api.formatOverlaySize(null), '')
  assert.equal(api.formatOverlaySize(-1), '')
})

/* ------------------------------------------------------------------ *
 * 8. Where it is mounted: the shell overlay layer, never the composer.
 * ------------------------------------------------------------------ */

test('the overlay is registered in the shell overlay layer', () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', blocking: 1 }) })
  assert.deepEqual(
    mounted.slotNames().sort(),
    [
      'conversation.input.dock',
      'conversation.input.left',
      'plugins.bundle.config',
      'settings.section',
      'shell.overlay',
      'sidebar.footer.action',
      'sidebar.session.row.leading',
    ].sort(),
    'the surfaces of the plugin did not change: the overlay joins shell.overlay',
  )
})

/* ------------------------------------------------------------------ *
 * 9. The Host side: the count of blocking tasks really travels as a number.
 *
 * The overlay prints "还有 N 个会话" from `restartPhase.blocking`. If the Host
 * only put that number into its long sentence, the overlay would have to parse
 * a text — so this is checked on the payload the routes really answer with.
 * ------------------------------------------------------------------ */

test('the stage carried by the routes has the number of blocking tasks on it', async (t) => {
  const { apply } = await import('../index.js')
  const { describeRestartPhase } = await import('../lib/restart-phase.js')
  const os = await import('node:os')
  const path = await import('node:path')

  // (a) The pure description: the number is a field of its own.
  const waiting = describeRestartPhase({ phase: 'waiting', blocking: 3, now: 1_700_000_000_000 })
  assert.equal(waiting.blocking, 3, 'the count is reported as a number')
  assert.match(waiting.text.zh, /还有 3 个会话在忙/, 'the long sentence keeps it too')
  assert.equal(
    describeRestartPhase({ phase: 'restarting' }).blocking,
    null,
    'a stage that was given no count reports null, not a fake zero',
  )

  // (b) The state route (the surface the overlay polls): `?state=1` answers
  // with the stage, and the stage carries the number.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-overlay-route-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  })
  const routes = []
  const tools = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: {
      register: (definition) => { tools.push(definition); return () => {} },
      guard: () => () => {},
    },
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.push(route); return () => {} }, tapIndex: () => () => {} }
      : undefined),
    on: () => () => {},
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  apply(ctx, { stateFile: path.join(dir, 'state.json'), enabled: true, recoveryDelayMs: 0 })

  const restartTool = tools.find((definition) => (definition.name || '').includes('restart'))
  assert.ok(restartTool, 'the restart tool is registered')
  restartTool.execute({ reason: 'overlay test', resume: true }, { agent: { id: 'sess-overlay' } })

  const health = routes.find((route) => route.path === '/__dsh_autorestart/health')
  assert.ok(health, 'the health route is registered')
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = String(body ?? '') },
  }
  health.handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.restartPhase.phase, 'waiting')
  assert.equal(
    typeof payload.restartPhase.blocking,
    'number',
    'the number of blocking tasks is a field of the stage, not only a sentence',
  )
  assert.equal(payload.restartPhase.blocking, 0, 'no conversation is running in this test')
})

/* ------------------------------------------------------------------ *
 * 11. The Host's side of the gate: a REAL restart stays pending.
 *
 * The card needs `pendingRestart === true` AND a running stage. That is only
 * safe if the Host keeps the request pending for the whole restart — this pins
 * it down, so a later refactor cannot quietly hide a live card (or let a stale
 * stage draw one).
 * ------------------------------------------------------------------ */

test('a real restart keeps pendingRestart true while it snapshots and while it restarts', async (t) => {
  const { createRuntime, normalizeConfig } = await import('../index.js')
  const { requestRestart } = await import('../lib/checkpoint.js')
  const os = await import('node:os')
  const path = await import('node:path')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-overlay-gate-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  })

  const samples = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: (name) => (name === 'webServer'
      ? { register: () => () => {}, tapIndex: () => () => {} }
      : undefined),
    on: () => () => {},
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  const config = normalizeConfig({
    stateFile: path.join(dir, 'state.json'),
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  })
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: false, appExePath: null },
    // THE SNAPSHOT: while it runs, the payload a page would receive is
    // `{ phase: 'snapshotting', pendingRestart: true }` — the card's gate.
    snapshot: () => {
      samples.push({
        at: 'snapshot',
        phase: runtime.restartStageInfo().phase,
        pending: runtime.state.restart !== null,
      })
      // Call the copy off: this test only wants the sample, not a real restart.
      return { ok: true, cancelled: true, dir: null, backup: null, profileDir: null }
    },
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  })

  requestRestart(runtime.state, { reason: 'the overlay gate', bySessionId: 'sess-gate' })
  await runtime.executeRestart()

  assert.equal(samples.length, 1, 'the snapshot ran once')
  assert.equal(samples[0].phase, 'snapshotting', 'the card is @snapshotting while the copy runs')
  assert.equal(samples[0].pending, true, 'and the request is still PENDING: the card must be drawn')

  // The stage of the shutdown does NOT clear the request either: only a cancel
  // (or the next boot) does, so `{ phase: 'restarting', pendingRestart: true }`
  // is what the page sees while the host goes down.
  requestRestart(runtime.state, { reason: 'the overlay gate 2', bySessionId: 'sess-gate' })
  runtime.markRestartStage('restarting')
  assert.equal(runtime.state.restart !== null, true, 'the request survives the "restarting" stage')
  const stage = runtime.restartStageInfo()
  assert.equal(stage.phase, 'restarting')
  assert.equal(stage.cancellable, false)
})

test('the card states the total being copied, in BOTH languages', async () => {
  const progress = { bytes: 1024 * 1024, total: 2 * 1024 * 1024, percent: 50 }

  // Chinese: the total, in the user's own wording ("备份中，共 XXX MB").
  const zh = mountClient({ health: statePayload({ phase: 'snapshotting', progress }) })
  const zhCard = await zh.settled('autorestart-restart-overlay')
  const zhCopy = textOf(zhCard)
  assert.match(zhCopy, /备份中，共 2 MB/, `the card states the total: ${zhCopy}`)
  assert.doesNotMatch(zhCopy, /正在备份/, `and never the bare "正在备份": ${zhCopy}`)

  // English: the same sentence (locale/en.json mirrors the key).
  const en = mountClient({ health: statePayload({ phase: 'snapshotting', progress }), language: 'en' })
  const enCard = await en.settled('autorestart-restart-overlay')
  const enCopy = textOf(enCard)
  assert.match(enCopy, /Backing up, 2 MB in total/i, `the English card says it too: ${enCopy}`)
  // The bar is gone in both languages: the title carries the total instead.
  assert.equal(findByAttribute(enCard, 'data-dsh-autorestart-restart-overlay-bar'), undefined, 'and no bar in English either')

  // The composer row stays a WORD in both languages (never the sentence).
  const enPill = await mountClient({ health: statePayload({ phase: 'snapshotting', progress }), language: 'en' })
    .settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const enPillCopy = capsuleCopy(enPill)
  assert.equal(enPillCopy, 'Backing up…', `the English pill is a word: ${enPillCopy}`)
  assert.ok(enPillCopy.length <= 12, `and short: ${enPillCopy.length}`)
})

/* ------------------------------------------------------------------ *
 * 12. NO TIME FLOOR: the card lives exactly as long as the Host says.
 *
 * The owner's decision (2026-10-29): "浮层不用保底时间, 短就算了, 不用硬加长,
 * 之前是太长看的奇怪而已". So a 92 KB backup that takes 5 ms shows for 5 ms and
 * the next stage takes over at once — nothing here holds the card artificially.
 * ------------------------------------------------------------------ */

test('a copy that takes 5 ms is gone at once — no minimum shown time', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 92 * 1024, total: 92 * 1024, percent: 100 } }),
  })
  let card = await mounted.settled('autorestart-restart-overlay')
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting', 'the copy is on screen')
  assert.match(textOf(card), /92 KB/, `with the real size and unit: ${textOf(card)}`)

  // The copy is over: the very next poll shows the NEXT stage, not a held card.
  mounted.setHealth(statePayload({ phase: 'restarting', snapshotBytes: 92 * 1024 }))
  card = await mounted.poll('autorestart-restart-overlay')
  assert.equal(
    card.props['data-dsh-autorestart-restart-overlay-phase'],
    'restarting',
    'the restart card takes over immediately — there is no 800 ms floor',
  )
  assert.match(textOf(card), /正在重启/, `and it is the restart card: ${textOf(card)}`)
  // No receipt either: the card never claims "backup done" by itself.
  assert.doesNotMatch(textOf(card), /备份完成/, `no forced receipt: ${textOf(card)}`)
})

test('no time floor exists in the source any more', () => {
  const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(clientSource.includes('SNAPSHOT_MIN_VISIBLE_MS'), false, 'no minimum shown time')
  assert.equal(clientSource.includes('SNAPSHOT_DONE_MS'), false, 'no forced receipt duration')
  assert.equal(clientSource.includes('advanceOverlayClock'), false, 'no display clock')
  assert.equal(clientSource.includes('overlayClockDeadline'), false, 'no wake-up timer for a hold')
  // …and the Host never had one (it must not slow the restart down either).
  const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(indexSource.includes('SNAPSHOT_MIN_VISIBLE_MS'), false, 'no hold in the host')
})

/* ------------------------------------------------------------------ *
 * 13. A STALE STAGE CANNOT LEAVE A CARD ON SCREEN.
 *
 * The Host fix (0.8.5) puts every postponed restart back to 'waiting'. The card
 * still must not depend on that: a stage nobody refreshed is not evidence of
 * anything happening right now, and drawing it is exactly the "card that never
 * goes away" the user reported. Times are driven here, no real waiting.
 * ------------------------------------------------------------------ */

test('the stage is believed only while it keeps being refreshed (fake clock)', () => {
  const api = globalThis.__dshAutorestartClient;
  assert.equal(api.RESTART_STAGE_STALE_MS, 15000, '15 silent seconds make a stage stale');
  assert.equal(api.RESTART_SNAPSHOT_FRESH_MS, 10000, 'a copy refreshes at least every 10 s');

  const now = 1_700_000_000_000;
  const live = (stage) => api.isRestartStageLive(stage, now);

  // A copy that stopped reporting 15 s ago is not running any more.
  assert.equal(live({ phase: 'snapshotting', at: now - 15000 }), false, '15 s without a byte: no card');
  assert.equal(live({ phase: 'snapshotting', at: now - 15001 }), false);
  // A copy that reported 3 s ago is running.
  assert.equal(live({ phase: 'snapshotting', at: now - 3000 }), true, '3 s ago: the copy is alive');
  // The copy window is tighter than the general one: a copy silent for 11 s is out.
  assert.equal(live({ phase: 'snapshotting', at: now - 11000 }), false);
  assert.equal(live({ phase: 'snapshotting', at: now - 10000 }), true, 'exactly at the limit still counts');

  // The host going down has no progress of its own: the 15 s window applies.
  assert.equal(live({ phase: 'restarting', at: now - 14000 }), true);
  assert.equal(live({ phase: 'restarting', at: now - 16000 }), false, 'a restart that never happened is dropped');

  // The other phases never draw a card, and a stage without a timestamp cannot
  // be trusted to describe "now" at all.
  assert.equal(live({ phase: 'waiting', at: now }), false);
  assert.equal(live({ phase: 'back', at: now }), false);
  assert.equal(live({ phase: 'idle', at: now }), false);
  assert.equal(live({ phase: 'snapshotting' }), false, 'no timestamp: no card');
  assert.equal(live({ phase: 'snapshotting', at: 0 }), false);
  assert.equal(live(null), false);
})

test('a stale snapshot stage draws NOTHING, a fresh one draws the card', async () => {
  const api = globalThis.__dshAutorestartClient;
  const stale = mountClient({
    health: statePayload({
      phase: 'snapshotting',
      progress: { bytes: 92 * 1024, total: 92 * 1024, percent: 100 },
      // The stage was written 15 s ago and never refreshed after that.
      at: Date.now() - api.RESTART_STAGE_STALE_MS,
    }),
  });
  // still pendingRestart: the pill goes on saying "waiting", the card does not.
  assert.equal(await stale.settled('autorestart-restart-overlay'), null, 'the card is gone with the stale stage');

  const fresh = mountClient({
    health: statePayload({
      phase: 'snapshotting',
      progress: { bytes: 92 * 1024, total: 92 * 1024, percent: 100 },
      at: Date.now() - 3000,
    }),
  });
  const card = await fresh.settled('autorestart-restart-overlay');
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting');
  assert.match(textOf(card), /备份中，共/);
})

/* ------------------------------------------------------------------ *
 * 14. A POSTPONED RESTART SAYS SO — AND NEVER SAYS "正在重启".
 *
 * THE REPORT (user, 2026-10-30): after the backup the card claimed "正在重启…" for
 * 25 s while the host was only waiting for a conversation to end. Now the Host
 * degrades the stage within 350 ms and the card turns into the honest sentence.
 * ------------------------------------------------------------------ */

test('a postponed restart draws the honest card, never "正在重启"', async () => {
  const mounted = mountClient({
    health: statePayload({
      phase: 'waiting',
      blocking: 1,
      busyCount: 1,
      reason: 'deferred: conversation-active after snapshot: conversation-active',
    }),
  });
  const card = await mounted.settled('autorestart-restart-overlay');
  assert.ok(card, 'the postponed card is drawn (it is telling the truth)');
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-phase'], 'waiting');
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'deferred', 'the card names the postponement');
  const copy = textOf(card);
  assert.match(copy, /有新会话在跑，重启已暂缓/, `the interruption is named: ${copy}`);
  assert.match(copy, /等它结束会自动继续/, `and the retry is promised: ${copy}`);
  assert.match(copy, /已等 1 个会话/, `with the number of conversations in the way: ${copy}`);
  assert.doesNotMatch(copy, /正在重启/, `the old word must be gone: ${copy}`);
})

test('the postponed card is English too', async () => {
  const mounted = mountClient({
    language: 'en',
    health: statePayload({
      phase: 'waiting',
      busyCount: 2,
      reason: 'deferred: conversation-active while restarting',
    }),
  });
  const card = await mounted.settled('autorestart-restart-overlay');
  const copy = textOf(card);
  assert.match(copy, /A conversation just started — restart postponed/, `${copy}`);
  assert.match(copy, /It will retry automatically when idle/, `${copy}`);
  assert.doesNotMatch(copy, /Restarting/, `no "Restarting…" for a postponed restart: ${copy}`);
})

test('a real restarting stage still says "正在重启…"', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'restarting' }),
  });
  const card = await mounted.settled('autorestart-restart-overlay');
  const copy = textOf(card);
  assert.match(copy, /正在重启/, `a real kill still says so: ${copy}`);
  assert.doesNotMatch(copy, /重启已暂缓/, `and it is not the postponed card: ${copy}`);
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'restarting');
})

test('a waiting stage WITHOUT the deferred reason still draws nothing', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'waiting', reason: null }),
  });
  assert.equal(await mounted.settled('autorestart-restart-overlay'), null, 'ordinary waiting has no card');
})

test('the downgrade is visible on the very next render', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting' }) });
  let card = await mounted.settled('autorestart-restart-overlay');
  assert.match(textOf(card), /正在重启/);

  // The Host now says the restart was postponed (its own re-check found a session).
  mounted.setHealth(statePayload({ phase: 'waiting', reason: 'deferred: conversation-active while restarting' }));
  card = await mounted.poll('autorestart-restart-overlay');
  const copy = textOf(card);
  assert.match(copy, /重启已暂缓/, `the card flips at once: ${copy}`);
  assert.doesNotMatch(copy, /正在重启/, `and the old word does not survive a single frame: ${copy}`);
})

/* ------------------------------------------------------------------ *
 * 15. THE POLL FOLLOWS THE STATE: 500 ms while a restart is moving.
 *
 * THE REASON (owner's instruction, 2026-10-30): the card now changes its words
 * the moment the host postpones a restart — but a 2 s cadence still means up to
 * two seconds of the old word on screen. While a restart is moving the state is
 * asked four times as often; the moment it is over the shared poll goes back to
 * its ordinary pace, and a hidden tab asks nothing at all.
 * ------------------------------------------------------------------ */

test('the cadence is 500 ms while a restart is moving and 2 s otherwise (pure)', () => {
  const api = globalThis.__dshAutorestartClient;
  assert.equal(api.POLL_MS, 2000, 'the ordinary cadence is 2 s');
  assert.equal(api.POLL_FAST_MS, 500, 'the fast one is 500 ms');

  assert.equal(api.pollIntervalFor(statePayload({ phase: 'waiting' })), 500, 'a queued restart is moving');
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'snapshotting' })), 500);
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'restarting' })), 500);
  // The postponed restart is a 'waiting' stage too: that is the state the user
  // must see within a second.
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'waiting', reason: 'deferred: conversation-active' })), 500);

  // Nothing moving: the ordinary pace.
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'waiting', pendingRestart: false })), 2000);
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'back', pendingRestart: false })), 2000);
  assert.equal(api.pollIntervalFor(statePayload({ phase: 'restarting', pendingRestart: false })), 2000);
  assert.equal(api.pollIntervalFor(null), 2000);

  assert.equal(api.isRestartMoving(statePayload({ phase: 'snapshotting' })), true);
  assert.equal(api.isRestartMoving(statePayload({ phase: 'snapshotting', pendingRestart: false })), false);
});

test('a restart in progress speeds the poll up to 500 ms, the end puts it back to 2 s', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', pendingRestart: false }) });
  await mounted.settled('autorestart-restart-overlay');
  assert.equal(mounted.lastPeriod(), 2000, 'an idle page asks every 2 s');

  // The restart is requested: the stage is 'waiting' and something will happen.
  mounted.setHealth(statePayload({ phase: 'waiting' }));
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.lastPeriod(), 500, 'a queued restart is watched closely');

  mounted.setHealth(statePayload({ phase: 'snapshotting', progress: { bytes: 1024, total: 4096, percent: 25 } }));
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.lastPeriod(), 500, 'the copy is watched as closely');

  mounted.setHealth(statePayload({ phase: 'restarting' }));
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.lastPeriod(), 500, 'and so is the kill');

  // The restart is over (the page came back / it was withdrawn): ordinary pace.
  mounted.setHealth(statePayload({ phase: 'back', pendingRestart: false }));
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.lastPeriod(), 2000, 'the end puts the shared poll back to 2 s');
});

test('a hidden page asks nothing, and asks again the moment it is visible', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting' }) });
  await mounted.settled('autorestart-restart-overlay');
  const before = mounted.fetchCount();
  assert.ok(before > 0, 'the first fetch happened');

  mounted.setHidden(true);
  // The browser keeps firing the timer; the store must not spend a request.
  await mounted.poll('autorestart-restart-overlay');
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.fetchCount(), before, 'no request while the page is hidden');

  mounted.setHidden(false);
  mounted.fireVisibility();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(mounted.fetchCount() > before, 'coming back on screen asks at once');
});

test('one request at a time: a slow answer is never stacked up', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting' }) });
  await mounted.settled('autorestart-restart-overlay');
  const before = mounted.fetchCount();

  const release = mounted.holdFetch();
  await mounted.poll('autorestart-restart-overlay');
  await mounted.poll('autorestart-restart-overlay');
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.fetchCount(), before + 1, 'the ticks behind a slow answer are skipped');

  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await mounted.poll('autorestart-restart-overlay');
  assert.equal(mounted.fetchCount(), before + 2, 'and the poll continues after the answer landed');
});

/* ------------------------------------------------------------------ *
 * 16. THE POSTPONED CARD IS AN ANNOUNCEMENT: FOUR SECONDS, THEN IT FOLDS.
 *
 * THE REPORT (user, 2026-10-30): "after the interruption I still have a lot of
 * work to do — a card hovering for ever is in the way". The capsule keeps saying
 * the restart is pending; the card only announces the interruption.
 * ------------------------------------------------------------------ */

test('the postponed card folds away after 4 s (the capsule keeps the count)', async () => {
  const api = globalThis.__dshAutorestartClient;
  assert.equal(api.RESTART_DEFERRED_CARD_MS, 4000, 'the announcement lasts four seconds');

  const mounted = mountClient({
    health: statePayload({ phase: 'waiting', blocking: 1, busyCount: 1, reason: 'deferred: conversation-active after snapshot', at: 1000 }),
  });
  let card = await mounted.settled('autorestart-restart-overlay');
  assert.ok(card, 'the announcement is drawn at once');
  assert.match(textOf(card), /有新会话在跑，重启已暂缓/);

  // One more pass, so the announcement hook arms its four-second timer (in the
  // browser the setState of that hook re-renders by itself; the harness renders
  // only when it is asked to).
  card = mounted.render('autorestart-restart-overlay');
  assert.ok(card, 'the announcement is still there right after it was recorded');

  // …four seconds and a bit later it is gone, while the restart is STILL pending
  // (the capsule is what keeps saying so).
  await new Promise((resolve) => setTimeout(resolve, 4150));
  assert.equal(mounted.render('autorestart-restart-overlay'), null, 'the card folded away');
  assert.equal(mounted.pillText ? mounted.pillText() : '', '', 'the pill is a separate surface');

  // A NEW postponement (a new stage timestamp) announces itself again.
  mounted.setHealth(statePayload({ phase: 'waiting', busyCount: 1, reason: 'deferred: conversation-active while restarting', at: 2000 }));
  await mounted.poll('autorestart-restart-overlay');
  card = mounted.render('autorestart-restart-overlay');
  assert.ok(card, 'a second interruption announces itself again');
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'deferred');
})

test('a running stage is NOT folded away (only the announcement is)', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 2048, total: 4096, percent: 50 } }),
  });
  await mounted.settled('autorestart-restart-overlay');
  await new Promise((resolve) => setTimeout(resolve, 4200));
  const card = mounted.render('autorestart-restart-overlay');
  assert.ok(card, 'a copy that is still running keeps its card');
  assert.match(textOf(card), /备份中，共/);
})
