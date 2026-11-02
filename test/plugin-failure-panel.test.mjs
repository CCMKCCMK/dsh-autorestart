/**
 * The panel's DATA MODEL only - the JSX is not touched by this file.
 *
 * `client.js` publishes its pure helpers on the global namespace (the same
 * convention `test/pill-cancel-panel.test.mjs` uses), so importing it here gives
 * us the model without a browser and without React.
 *
 * The rule this file exists to protect: the panel may say "these functions did
 * not come up" and "these plugins differ from the backup", and NOTHING ELSE. It
 * must never say a plugin is broken or failed to load, because neither data
 * source can tell us that.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import '../client.js'

const model = globalThis.__dshAutorestartClient
const build = model && typeof model.buildPluginFailureModel === 'function'
  ? model.buildPluginFailureModel
  : null

/** A watch payload shaped like the real route's answer. */
function watchPayload({ tools = [], packages = [], clientModules = [], at = 1_700_000_000_000 } = {}) {
  return {
    ok: true,
    available: true,
    at,
    layers: {
      tools: { removed: tools },
      clientModules: { removed: clientModules },
      packages: { removed: packages },
    },
    disappeared: [],
    hasDisappearances: tools.length + packages.length + clientModules.length > 0,
  }
}

/** An inventory payload shaped like the real route's answer. */
function inventoryPayload(rows) {
  return { ok: true, plugins: rows }
}

// ---------------------------------------------------------------------------
// The helper is actually published.
// ---------------------------------------------------------------------------

test('client.js publishes the model builder for the tests', () => {
  assert.equal(typeof build, 'function', 'buildPluginFailureModel must be reachable from the global namespace')
})

// ---------------------------------------------------------------------------
// ① both blocks are merged, and each keeps its own meaning
// ---------------------------------------------------------------------------

test('the two sources become two separate blocks', () => {
  const result = build({
    watch: watchPayload({ tools: ['codekg_query'], packages: ['@deepseek-ai/dsh-vault#host'] }),
    inventory: inventoryPayload([
      { name: 'dsh-cost-meter', status: 'different', version: '1.2.3', changeCount: 4 },
      { name: 'dsh-steady', status: 'same', version: '1.0.0' },
    ]),
  })

  assert.equal(result.certain.length, 2, 'two functions did not come up')
  assert.deepEqual(
    result.certain.map((entry) => entry.name).sort(),
    ['@deepseek-ai/dsh-vault', 'codekg'],
    'a tool name is folded to its owner, a package keeps its name',
  )
  // The two blocks are separate: a clue is NOT a certainty.
  assert.equal(result.clues.length, 1, 'only the `different` row is a clue')
  assert.equal(result.clues[0].name, 'dsh-cost-meter')
  assert.equal(result.clues[0].source, 'inventory')
  // A `same` row is not a clue.
  assert.equal(result.clues.some((entry) => entry.name === 'dsh-steady'), false)
})

test('a clue never leaks into the certain block, and vice versa', () => {
  const result = build({
    watch: watchPayload({ tools: ['release_board_publish'] }),
    inventory: inventoryPayload([{ name: 'dsh-other', status: 'different', version: '9.9.9' }]),
  })
  assert.deepEqual(result.certain.map((entry) => entry.name), ['release'])
  assert.deepEqual(result.clues.map((entry) => entry.name), ['dsh-other'])
})

// ---------------------------------------------------------------------------
// ② nothing to report -> no panel at all
// ---------------------------------------------------------------------------

test('with nothing to report the model is null, not an empty shell', () => {
  assert.equal(build({ watch: watchPayload(), inventory: inventoryPayload([]) }), null)
  assert.equal(build({ watch: watchPayload(), inventory: inventoryPayload([{ name: 'x', status: 'same' }]) }), null)
  assert.equal(build({}), null)
})

// ---------------------------------------------------------------------------
// ③ clientModules can NEVER name a plugin
// ---------------------------------------------------------------------------

test('clientModules becomes a count and never a list entry', () => {
  // The real machine reports four module names here, not plugin names.
  const result = build({
    watch: watchPayload({ tools: ['codekg_query'], clientModules: ['batches', 'entries', 'release'] }),
    inventory: inventoryPayload([]),
  })

  assert.equal(result.uiBlindSpot, 3, 'three interface modules did not appear')
  const allNames = [...result.certain, ...result.clues].map((entry) => entry.name)
  for (const moduleName of ['batches', 'entries', 'release']) {
    assert.equal(allNames.includes(moduleName), false, moduleName + ' must never be listed as a plugin')
  }
})

test('interface modules alone are still worth a panel, but only as a number', () => {
  const result = build({ watch: watchPayload({ clientModules: ['batches'] }), inventory: inventoryPayload([]) })
  // No certain item and no clue -> no panel, but the blind spot is recorded on
  // whatever the caller does get. (A blind spot alone must not raise an alarm:
  // the module may just not be loaded yet.)
  assert.equal(result, null, 'a blind spot alone is not news')
  const withReal = build({
    watch: watchPayload({ tools: ['a_b'], clientModules: ['batches'] }),
    inventory: inventoryPayload([]),
  })
  assert.equal(withReal.uiBlindSpot, 1)
})

// ---------------------------------------------------------------------------
// ④⑤ the action depends on who wrote the plugin
// ---------------------------------------------------------------------------

test('a third-party plugin gets a hint with the exact version, never a restore', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([{ name: '@scope/third-party', status: 'different', version: '2.4.6' }]),
    profile: 'demo',
  })
  const clue = result.clues[0]
  assert.equal(clue.kind, 'third-party')
  assert.equal(clue.action.type, 'hint')
  assert.notEqual(clue.action.type, 'restore')
  assert.equal(clue.action.command, 'dsh plugin --profile demo add @scope/third-party@2.4.6')
})

test('a hand-written (link) plugin gets the restore action', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([{ name: 'my-own-plugin', status: 'different', version: '0.1.0', kind: 'link' }]),
  })
  const clue = result.clues[0]
  assert.equal(clue.kind, 'linked')
  assert.equal(clue.action.type, 'restore')
  assert.equal(clue.action.command, undefined, 'a restore carries no install command')
})

// ---------------------------------------------------------------------------
// ⑥ no version -> no invented command
// ---------------------------------------------------------------------------

test('without a version there is no command, only a note', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([{ name: 'dsh-unknown', status: 'different' }]),
  })
  const clue = result.clues[0]
  assert.equal(clue.action.type, 'hint')
  assert.equal(clue.action.command, null, 'no version means no command - never a guess')
  assert.equal(typeof clue.action.note, 'string')
  assert.ok(clue.action.note.length > 0, 'and the note says why')
})

test('the profile name is used when the caller knows it', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([{ name: 'pkg', status: 'different', version: '1.0.0' }]),
    profile: 'desktop',
  })
  assert.equal(result.clues[0].action.command, 'dsh plugin --profile desktop add pkg@1.0.0')
})

// ---------------------------------------------------------------------------
// ⑦ malformed input never throws
// ---------------------------------------------------------------------------

test('malformed input returns null or an empty model and never throws', () => {
  const inputs = [
    undefined, null, 42, 'nope', [],
    { watch: null, inventory: null },
    { watch: 42, inventory: 'nope' },
    { watch: { layers: 42 }, inventory: { plugins: 'nope' } },
    { watch: { disappeared: [null, 42, {}] }, inventory: { plugins: [null, 42, {}] } },
    { watch: { layers: { tools: { removed: 'not-an-array' } } }, inventory: { plugins: [] } },
  ]
  for (const input of inputs) {
    let result
    assert.doesNotThrow(() => { result = build(input) }, JSON.stringify(input) + ': must not throw')
    assert.equal(result === null || typeof result === 'object', true)
  }
})

test('a row with a useless name is dropped instead of shown as blank', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([{ name: '   ', status: 'different', version: '1.0.0' }, { status: 'different' }]),
  })
  assert.equal(result, null, 'no usable name means no entry')
})

// ---------------------------------------------------------------------------
// The model carries facts only - no verdict words
// ---------------------------------------------------------------------------

test('the model carries no "broken" / "failed" verdict anywhere', () => {
  const result = build({
    watch: watchPayload({ tools: ['codekg_query'] }),
    inventory: inventoryPayload([{ name: 'dsh-x', status: 'different', version: '1.0.0' }]),
  })
  const text = JSON.stringify(result).toLowerCase()
  for (const forbidden of ['broken', 'failed', 'failure', 'crash']) {
    assert.equal(text.includes(forbidden), false, 'the model must not claim ' + forbidden)
  }
})

// ---------------------------------------------------------------------------
// The locale says the same thing in both languages
// ---------------------------------------------------------------------------

test('the locale carries the two new block titles and no "did not load" wording', () => {
  for (const file of ['../locale/zh.json', '../locale/en.json']) {
    const raw = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    const keys = JSON.parse(raw).pluginFailure
    assert.equal(typeof keys.certainTitle, 'string', file + ' needs certainTitle')
    assert.equal(typeof keys.clueTitle, 'string', file + ' needs clueTitle')
    assert.equal(typeof keys.dismiss, 'string')
    const all = JSON.stringify(keys)
    // The old wording claimed knowledge we do not have.
    assert.equal(/加载成功/.test(all), false, file + ' must not claim a load failure')
    assert.equal(/loaded successfully/i.test(all), false, file + ' must not claim a load failure')
  }
})

test('both language files carry exactly the same pluginFailure keys', () => {
  const zh = Object.keys(JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8')).pluginFailure).sort()
  const en = Object.keys(JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')).pluginFailure).sort()
  assert.deepEqual(en, zh, 'the two locales must stay in step')
})

// ---------------------------------------------------------------------------
// THE FLOATING CARD'S LAYOUT (user report, 2026-11-02).
//
// Two things were wrong in the card that reports "two things worth a look":
//   1. the title was printed TWICE — once by the card header and again as the
//      first paragraph of the body;
//   2. «全部恢复» and «知道了» sat at the BOTTOM of the list, where they read as if
//      they belonged to the LAST plugin in it.
// Card-level actions belong to the header (title left, buttons right); the
// per-plugin button («只恢复 <plugin>») must stay inside that plugin's own row.
//
// WHY THIS READS THE SOURCE INSTEAD OF RENDERING: the overlay has no render
// harness here (the panel is registered into a slot from `apply()`). These
// assertions pin the STRUCTURE the renderer consumes — one title call, actions
// passed in `actions` rather than pushed into `rows`, and the header rendering
// those actions inside its own container.
// ---------------------------------------------------------------------------

const clientDir = path.dirname(fileURLToPath(import.meta.url))
const clientSource = fs.readFileSync(path.join(clientDir, '..', 'client.js'), 'utf8')

/** The text of one function body, from its `function NAME(` to the matching brace. */
function functionBodyOf(name) {
  const start = clientSource.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' must exist in client.js')
  let depth = 0
  let index = clientSource.indexOf('{', start)
  const open = index
  for (; index < clientSource.length; index += 1) {
    if (clientSource[index] === '{') depth += 1
    if (clientSource[index] === '}') {
      depth -= 1
      if (depth === 0) return clientSource.slice(open, index + 1)
    }
  }
  assert.fail(name + ' has no matching closing brace')
}

const panel = functionBodyOf('PluginFailurePanel')
const card = functionBodyOf('OverlayCard')

test('the card title is printed once: the duplicate body line is gone', () => {
  const titleCalls = panel.split("t('pluginFailure.title')").length - 1
  assert.equal(titleCalls, 1, 'the title is used exactly once — as the card header title')
  assert.equal(
    panel.includes("key: 'title'"),
    false,
    'no body paragraph repeats the title any more',
  )
})

test('「全部恢复」and「知道了」are card-level actions, not list rows', () => {
  assert.match(panel, /const actions = \[\]/, 'the panel builds an actions array for the header')
  assert.match(panel, /actions\.push\(h\('button', \{/, 'its buttons are pushed into that array')
  // The ONLY button left in the list is the per-plugin one; the two card-level
  // buttons are pushed into `actions` instead.
  const rowsButtons = panel.split("rows.push(h('button'").length - 1
  const actionButtons = panel.split("actions.push(h('button'").length - 1
  assert.equal(rowsButtons, 1, 'exactly one button stays in the list (the per-plugin one)')
  assert.equal(actionButtons, 2, 'and the two card-level buttons live in the header actions')
  assert.ok(
    panel.includes("'data-dsh-autorestart-plugin-failure': 'restore-all'"),
    'restore-all carries its own marker',
  )
  assert.ok(
    panel.includes("'data-dsh-autorestart-plugin-failure': 'dismiss'"),
    'dismiss carries its own marker',
  )
  assert.match(panel, /actions,/, 'and the array is handed to the card')
  assert.match(panel, /h\(OverlayCard, \{/, 'the panel renders the card component directly')
})

test('the per-plugin button stays inside its own row', () => {
  assert.match(
    panel,
    /rows\.push\(h\('button', \{[^}]*key: 'cta:' \+ entry\.name/s,
    '«只恢复 <plugin>» is still a row of that plugin',
  )
  assert.equal(
    actionsSectionIncludes("key: 'cta:'"),
    false,
    'and it is NOT lifted into the header actions',
  )

  function actionsSectionIncludes(needle) {
    const start = panel.indexOf('const actions = []')
    const end = panel.indexOf('return h(OverlayCard')
    assert.ok(start !== -1 && end > start, 'the actions section must be findable')
    return panel.slice(start, end).includes(needle)
  }
})

test('the header owns the actions and the title can truncate', () => {
  assert.match(card, /'data-dsh-autorestart-overlay-header': id/, 'the header is addressable')
  const headerAt = card.indexOf("'data-dsh-autorestart-overlay-header'")
  const actionsAt = card.indexOf("'data-dsh-autorestart-overlay-actions'")
  assert.ok(actionsAt > headerAt, 'the actions container sits inside the header element')
  assert.match(
    card.slice(headerAt, actionsAt),
    /data-dsh-autorestart-overlay-header/,
    'the header wraps the actions (not the other way round)',
  )
  assert.match(card, /textOverflow: 'ellipsis'/, 'the title truncates instead of pushing the buttons out')
  assert.match(card, /whiteSpace: 'nowrap'/, 'the title stays on one line')
  assert.match(card, /flexWrap: 'nowrap'/, 'the buttons never wrap onto a second line')
  assert.match(card, /flex: '1 1 auto'/, 'the title takes the free space')
  assert.match(card, /flex: '0 0 auto'/, 'and the buttons keep their width')
})


// ---------------------------------------------------------------------------
// ⑤ THE CARD IS A RESTART RESULT, NOT A MONITOR (user decision, 2026-11-02).
//
// It used to fetch plugin-watch and plugin-inventory on every refresh of the
// shared payload, so it could pop up in the middle of a session. The judgement
// now belongs to a BOOT: it runs once, the result is recorded under a key that
// carries the boot identity, and nothing — file changes, plugin installs, the
// payload polling, a page refresh — judges again inside that same boot. A new
// boot (the next restart) judges again.
//
// The three helpers below are real functions the panel calls; the effect that
// spends them is checked at the source level because this repository has no
// render harness for the overlay slot.
// ---------------------------------------------------------------------------

const bootIdOf = model && typeof model.pluginFailureBootId === 'function' ? model.pluginFailureBootId : null
const judgedKeyOf = model && typeof model.pluginFailureJudgedKey === 'function' ? model.pluginFailureJudgedKey : null
const fingerprintOf = model && typeof model.pluginFailureFingerprint === 'function' ? model.pluginFailureFingerprint : null

test('the boot identity is read from the health payload, bootId first', () => {
  assert.equal(typeof bootIdOf, 'function', 'pluginFailureBootId must be published for the tests')
  assert.equal(bootIdOf({ bootId: 'boot-a' }), 'boot-a')
  assert.equal(bootIdOf({ generation: 7 }), '7', 'generation is the fallback and becomes text')
  assert.equal(bootIdOf({ bootId: 'boot-a', generation: 7 }), 'boot-a', 'bootId wins over generation')
  assert.equal(bootIdOf({ health: { bootId: 'nested' } }), 'nested', 'a nested payload is accepted too')
  assert.equal(bootIdOf({ health: { generation: 3 } }), '3', 'and so is a nested generation')
  assert.equal(bootIdOf({ bootId: '   ' }), '', 'a blank identity is no identity')
  assert.equal(bootIdOf(null), '')
  assert.equal(bootIdOf({}), '')
})

test('① the record is per boot: one key for one boot, a different key for the next', () => {
  assert.equal(typeof judgedKeyOf, 'function', 'pluginFailureJudgedKey must be published for the tests')
  assert.equal(judgedKeyOf('boot-a'), judgedKeyOf('boot-a'), 'the same boot always looks in the same place')
  assert.notEqual(judgedKeyOf('boot-a'), judgedKeyOf('boot-b'), 'a new boot cannot see the old record')
  assert.match(judgedKeyOf('boot-a'), /boot-a/, 'the key carries the boot identity')
  assert.equal(judgedKeyOf(''), judgedKeyOf(''), 'a Host that says nothing still gets one stable key')
})

test('the fingerprint names the report, so one boot can be recognised after a refresh', () => {
  assert.equal(typeof fingerprintOf, 'function', 'pluginFailureFingerprint must be published')
  assert.equal(fingerprintOf(null), '')
  assert.equal(
    fingerprintOf({ certain: [{ name: 'b' }, { name: 'a' }], clues: [{ name: 'z' }] }),
    fingerprintOf({ certain: [{ name: 'a' }, { name: 'b' }], clues: [{ name: 'z' }] }),
    'the order of the payloads does not change the identity',
  )
  assert.notEqual(
    fingerprintOf({ certain: [{ name: 'a' }], clues: [] }),
    fingerprintOf({ certain: [{ name: 'a' }], clues: [{ name: 'z' }] }),
    'a different report is a different identity',
  )
})

test('②③④ the panel judges once per boot, records it, and never polls again', () => {
  // ② a judgement already recorded for this boot stops the effect before it
  assert.ok(
    panel.includes('if (judgedRecord(judgedKey) !== null) return undefined'),
    'the effect returns early when this boot was already judged',
  )
  // ④ the effect is keyed on the BOOT, not on the live payload that keeps
  // refreshing — that is what used to make it a monitor.
  assert.match(panel, /\}, \[judgedKey\]\)/, 'the effect depends on the boot identity alone')
  assert.equal(
    /\}, \[info\]\)/.test(panel),
    false,
    'nothing re-runs the judgement when the shared payload refreshes',
  )
  assert.equal(
    /setInterval\(/.test(panel),
    false,
    'no timer: the judgement is an event, not a poll',
  )
  // ① a mount that arrives after the judgement shows nothing
  assert.match(
    panel,
    /if \(!judgedHere && judgedRecord\(judgedKey\) !== null\) return null/,
    'a second mount of the same boot stays silent',
  )
  // The judgement is recorded even when it has nothing to report — otherwise a
  // file changed later in the same boot would make the card appear.
  assert.match(
    panel,
    /window\.localStorage\.setItem\(judgedKey/,
    'the boot record is written by the judgement itself',
  )
  assert.match(panel, /setJudgedHere\(true\)/, 'and the panel knows the judgement was its own')
  // ③ dismiss is boot-scoped as well.
  const dismissAt = panel.indexOf('const dismiss = () => {')
  assert.notEqual(dismissAt, -1, 'the dismiss handler is still there')
  const dismissBody = panel.slice(dismissAt, dismissAt + 700)
  assert.match(dismissBody, /judgedKey/, 'dismissing writes the boot record too')
  assert.match(dismissBody, /PLUGIN_FAILURE_DISMISS_KEY/, 'and keeps the single-report fingerprint')
})

// ---------------------------------------------------------------------------
// ① NO DEAD HELPER LEFT BEHIND (2026-11-02).
//
// backupFallbackText drew the one-line-per-unverified-copy view. That view is
// gone (unverified copies are not listed at all any more), so the helper had no
// caller. Keeping it would be a loaded gun: the next person to see it would wire
// it back into the page. It must stay deleted, and nothing may reference it.
// ---------------------------------------------------------------------------

test('the dead helper backupFallbackText is gone, and nothing references it', () => {
  assert.equal(
    clientSource.includes('backupFallbackText'),
    false,
    'the helper and every mention of it are gone from client.js',
  )
})

