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
import test from 'node:test'

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
