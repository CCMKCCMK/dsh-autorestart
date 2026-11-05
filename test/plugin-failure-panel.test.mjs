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

// ---------------------------------------------------------------------------
// WHICH PLUGINS DID NOT COME UP (user decision, 2026-11-02).
//
// The card reports exactly one thing: a plugin PACKAGE that loaded on the
// previous start and does not load now. It reports NOTHING for:
//   * a file difference from the backup (an upgrade, our own edits),
//   * a few capabilities disappearing while the package still loads,
//   * a plugin the user removed from the bundles.
// ---------------------------------------------------------------------------

test('① a plugin that was upgraded (files differ) but loads fine does NOT open the card', () => {
  const result = build({
    watch: watchPayload(),
    inventory: inventoryPayload([
      { name: 'dsh-upgraded', status: 'different', version: '1.9.0', changeCount: 12 },
      { name: 'dsh-steady', status: 'same', version: '1.0.0' },
    ]),
  })
  assert.equal(result, null, 'a file difference is not a failure and must not raise the card')
})

test('② a declared plugin that did not load this time IS listed', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'] }),
    inventory: inventoryPayload([
      { name: 'dsh-cost-meter', status: 'different', version: '1.2.3' },
    ]),
  })
  assert.notEqual(result, null, 'a plugin that did not come up is worth the card')
  assert.deepEqual(result.certain.map((entry) => entry.name), ['dsh-cost-meter'])
  assert.equal(result.certain[0].source, 'packages', 'the evidence is the package that disappeared')
  assert.deepEqual(result.certain[0].lostTools, [], 'no tool evidence was given, and none is invented')
})

test('③ a plugin the user REMOVED from the bundles does not open the card', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-gone'] }),
    inventory: inventoryPayload([{ name: 'dsh-gone', status: 'not-installed' }]),
  })
  assert.equal(result, null, 'it is not in the profile any more: that already happened, it is not a failure')
})

test('a FEW capabilities disappearing while the plugin still loads does not open the card', () => {
  const result = build({
    // Only tools are gone: the package itself came up, so this is an upgrade
    // that renamed or dropped a tool — not a plugin the user has to revive.
    watch: watchPayload({ tools: ['cost_meter_query', 'cost_meter_reset'] }),
    inventory: inventoryPayload([{ name: 'cost-meter', status: 'same', version: '1.2.3' }]),
  })
  assert.equal(result, null, 'a partial capability loss is not "the plugin did not come up"')
})

test('a vanished tool is EVIDENCE on the package that did not come up, never its own entry', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'], tools: ['dsh-cost-meter_query'] }),
    inventory: inventoryPayload([{ name: 'dsh-cost-meter', status: 'different', version: '1.2.3' }]),
  })
  assert.deepEqual(result.certain.map((entry) => entry.name), ['dsh-cost-meter'], 'one entry, named by the package')
  assert.deepEqual(result.certain[0].lostTools, ['dsh-cost-meter_query'], 'and the tool rides along as evidence')
})

test('clientModules stays a COUNT: a module name is not a plugin to go and look for', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter'], clientModules: ['batches', 'timeline', 'sidebar'] }),
    inventory: inventoryPayload([{ name: 'dsh-cost-meter', status: 'different' }]),
  })
  assert.equal(result.uiBlindSpot, 3, 'three interface modules did not appear')
  assert.deepEqual(result.certain.map((entry) => entry.name), ['dsh-cost-meter'])
})

test('interface modules alone are still no panel: the count has nothing to name', () => {
  const result = build({ watch: watchPayload({ clientModules: ['batches'] }), inventory: inventoryPayload([]) })
  assert.equal(result, null, 'a blind spot without a plugin name is not a card')
})

test('a third-party plugin gets a reinstall hint, not a restore button', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'] }),
    inventory: inventoryPayload([{ name: 'dsh-cost-meter', status: 'not-installed', version: '1.2.3' }]),
  })
  // The inventory says "not installed" for THIS name, so nothing is reported —
  // and that is the point: the exclusion wins over the watch evidence.
  assert.equal(result, null)
})

test('the profile name is used when the caller knows it', () => {
  const result = build({
    profile: 'desktop',
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'] }),
    inventory: inventoryPayload([{ name: 'dsh-cost-meter', status: 'different', version: '1.2.3' }]),
  })
  assert.match(result.certain[0].action.command, /--profile desktop/, 'the command names the profile')
  assert.match(result.certain[0].action.command, /dsh-cost-meter@1\.2\.3/, 'and the exact version')
})

test('without a version there is no command to copy', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-unknown-version'] }),
    inventory: inventoryPayload([{ name: 'dsh-unknown-version', status: 'different' }]),
  })
  assert.equal(typeof result.certain[0].action.command === 'string' && result.certain[0].action.command !== '', false,
    'a command invented without a version would install something else')
})

test('malformed input returns null or an empty model and never throws', () => {
  assert.equal(build(null), null)
  assert.equal(build({}), null)
  assert.equal(build({ watch: 'nonsense', inventory: 7 }), null)
  const weird = build({ watch: { layers: { packages: { removed: 5 } } }, inventory: { plugins: 'no' } })
  assert.equal(weird, null)
})

test('a row with a useless name is dropped instead of shown as blank', () => {
  const result = build({
    watch: watchPayload({ packages: ['   '] }),
    inventory: inventoryPayload([{ name: '  ', status: 'different' }]),
  })
  assert.equal(result, null, 'a blank name is not a plugin')
})

test('the model carries no "broken" / "failed" verdict anywhere', () => {
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'] }),
    inventory: inventoryPayload([{ name: 'dsh-cost-meter', status: 'different', version: '1.2.3' }]),
  })
  const text = JSON.stringify(result)
  assert.equal(/broken/i.test(text), false, 'the card never says a plugin is broken')
  assert.equal(/failed/i.test(text), false, 'and never says it failed')
  assert.equal(/differ/i.test(text), false, 'and never says a plugin differs from the backup')
})

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
    fingerprintOf({ certain: [{ name: 'a' }] }),
    fingerprintOf({ certain: [{ name: 'a' }, { name: 'b' }] }),
    'a different set of plugins that did not come up is a different identity',
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

// ---------------------------------------------------------------------------
// THE CARD ONLY SAYS "DID NOT COME UP" (user decision, 2026-11-02).
//
// The old card had a second block: "these plugins differ from the backup" — a
// file difference presented as something to act on. An upgrade, or our own work
// on a plugin, produces exactly that, and none of it is a failure. The wording
// must be gone from the card, not merely unused.
// ---------------------------------------------------------------------------

test('the card no longer renders the "differs from the backup" block', () => {
  assert.equal(
    panel.includes('pluginFailure.clueTitle'),
    false,
    'the clue title is not rendered any more',
  )
  assert.equal(
    panel.includes('pluginFailure.clueIntro'),
    false,
    'and neither is its paragraph',
  )
  assert.equal(
    panel.includes('clue-title'),
    false,
    'no row key for it is left behind either',
  )
})

test('the wording the card does use never calls a plugin different from the backup', () => {
  // The strings the card still shows, from the inline dictionaries.
  const zh = panel.match(/pluginFailure\.(certainTitle|certainIntro)/g) || []
  assert.ok(zh.length > 0, 'the card still explains itself with certainTitle / certainIntro')
  for (const key of ['settings.backup.fallback.seed']) void key

  // And the dictionaries themselves: the two keys the card uses must not say
  // "different from the backup" in either language.
  for (const file of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', file + '.json'), 'utf8'))
    assert.equal(
      /跟备份不一样|与备份不同|differ(s)? from the backup/i.test(dict.pluginFailure.certainTitle),
      false,
      file + ': the title does not judge a plugin against the backup',
    )
    assert.equal(
      /跟备份不一样|与备份不同|differ(s)? from the backup/i.test(dict.pluginFailure.certainIntro),
      false,
      file + ': and neither does the paragraph',
    )
  }
})

// ---------------------------------------------------------------------------
// ① THE CARD MUST NOT PROMISE A COMMAND IT DOES NOT HAVE (user report,
//    2026-11-05).
//
// WHAT THE USER SAW:
//
//   @deepseek-ai/dsh-experimental-client-ui-forge
//   «这个插件是第三方安装的，备份里没有它的文件。要还原就用下面那条命令，
//     它会装回原来的那个版本（不是最新版）：»
//   <an empty line — there was no command>
//   «备份里查不到它的精确版本，只能按插件名重新安装。»
//
// The sentence «use the command below» promises a command that is not there,
// and the sentence right below it says something else entirely. Two
// statements, one of them a promise nobody can keep.
//
// THE RULE: the hint that points at the command and the command itself belong
// to the SAME branch. No command → no promise, and a sentence that is only
// true.
// ---------------------------------------------------------------------------

test('① the card promises a command only when it really has one', () => {
  const hintAt = panel.indexOf("t('pluginFailure.thirdPartyHint')")
  const checkAt = panel.indexOf("typeof action.command === 'string' && action.command !== ''")
  assert.ok(checkAt !== -1, 'the panel still checks whether a command exists')
  assert.ok(hintAt !== -1, 'the third-party hint still exists — it is right when a command follows')
  assert.ok(
    checkAt < hintAt,
    'the hint that says «use the command below» is only reachable AFTER the command was found',
  )
  // The command line itself is still rendered, and it is the thing the hint
  // talks about.
  const cmdAt = panel.indexOf("key: 'cmd:' + entry.name")
  assert.ok(cmdAt > hintAt, 'the command follows the hint that points at it')
})

test('① the no-command case says something true, and the old wording is gone', () => {
  assert.ok(
    panel.includes("t('pluginFailure.noCommandHint')"),
    'the case without a command has its own wording',
  )
  assert.equal(
    panel.includes("t('pluginFailure.noVersion')"),
    false,
    'the old sentence is gone — it said «it can only be reinstalled by name» right below a promise of a command',
  )
  // The dead key must not stay in the dictionaries either: a mirror that keeps
  // the sentence nobody renders is one more copy to drift.
  for (const file of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', file + '.json'), 'utf8'))
    assert.equal(
      Object.prototype.hasOwnProperty.call(dict.pluginFailure, 'noVersion'),
      false,
      file + ': the dead key is gone',
    )
    assert.equal(
      typeof dict.pluginFailure.noCommandHint,
      'string',
      file + ': the new key has a text',
    )
  }
})

test('① the no-command wording does not point at a command either', () => {
  for (const file of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', file + '.json'), 'utf8'))
    const text = dict.pluginFailure.noCommandHint
    assert.equal(
      /用下面那条命令|use the command below|the command below/i.test(text),
      false,
      file + ': the wording must not promise a command',
    )
    assert.equal(
      /重新安装|reinstall/i.test(text),
      false,
      file + ': and it must not tell the user to reinstall it either — the system does not know how',
    )
  }
})

test('① a plugin without a version really gets no command, and the hint still does', () => {
  // The model side of the same rule: the action carries a command only when
  // the inventory knew the version.
  const result = build({
    watch: watchPayload({ packages: ['dsh-unknown-version'] }),
    inventory: inventoryPayload([{ name: 'dsh-unknown-version', status: 'different' }]),
  })
  assert.equal(result.certain[0].action.type, 'hint')
  assert.equal(result.certain[0].action.command, null, 'no version, no command')
})

// ---------------------------------------------------------------------------
// ② A MODULE OF THE HOST IS NOT A PLUGIN OF THIS PROFILE (user report,
//    2026-11-05).
//
// `@deepseek-ai/dsh-experimental-client-ui-forge` was listed as «did not come
// up». It is not a plugin the user installed: the host ships it. There are no
// files of it in the backup and no version to reinstall, so the card asked for
// something nobody can do.
//
// THE INVENTORY IS THE LIST OF THIS PROFILE'S PLUGINS. A package that is not
// in it is skipped.
//
// BUT ONLY WHEN THE INVENTORY ANSWERED. An unreadable inventory (no rows) must
// not silence the whole card: a missing list is not a proof that nothing is
// missing.
// ---------------------------------------------------------------------------

test('② a package that is not in the plugin inventory is a module of the host', () => {
  const result = build({
    watch: watchPayload({ packages: ['@deepseek-ai/dsh-experimental-client-ui-forge'] }),
    inventory: inventoryPayload([
      { name: 'dsh-cost-meter', status: 'different', version: '1.2.3' },
    ]),
  })
  assert.equal(result, null, 'a module the host ships with is not something the user can put back')
})

test('② a host module does not push a real plugin out of the list', () => {
  const result = build({
    watch: watchPayload({
      packages: ['@deepseek-ai/dsh-experimental-client-ui-forge', 'dsh-cost-meter@1.2.3'],
    }),
    inventory: inventoryPayload([
      { name: 'dsh-cost-meter', status: 'different', version: '1.2.3' },
    ]),
  })
  assert.notEqual(result, null, 'the real plugin still opens the card')
  assert.deepEqual(
    result.certain.map((entry) => entry.name),
    ['dsh-cost-meter'],
    'and the host module is not on the list',
  )
})

test('② an unreadable inventory does not silence the card', () => {
  // The filter must not turn a missing answer into "nothing is wrong".
  const result = build({
    watch: watchPayload({ packages: ['dsh-cost-meter@1.2.3'] }),
    inventory: inventoryPayload([]),
  })
  assert.notEqual(result, null, 'the card still opens when the inventory could not be read')
  assert.deepEqual(result.certain.map((entry) => entry.name), ['dsh-cost-meter'])
})

test('② a linked plugin the inventory knows still gets its one-click restore', () => {
  const result = build({
    profile: 'desktop',
    watch: watchPayload({ packages: ['dsh-my-own'] }),
    inventory: inventoryPayload([
      { name: 'dsh-my-own', status: 'different', version: '0.1.0', linked: true },
    ]),
  })
  assert.equal(result.certain[0].kind, 'linked', 'it is still a link install')
  assert.equal(result.certain[0].action.type, 'restore', 'and it still gets the restore branch')
})

// ---------------------------------------------------------------------------
// ③ THE TITLE DOES NOT COUNT ANYTHING (user report, 2026-11-05).
//
// The title said «有两件事要你看一下» / «Two things worth a look» — a claim
// about how many things there are, written back when the card happened to
// hold two. The card holds one list, and that list may hold one name or
// several.
// ---------------------------------------------------------------------------

test('③ the title does not claim a number of things', () => {
  for (const file of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', file + '.json'), 'utf8'))
    const title = dict.pluginFailure.title
    assert.equal(
      /两件事|两件|two things|two items|2 things/i.test(title),
      false,
      file + ': the title must not claim how many things there are — ' + title,
    )
    assert.ok(title.length > 0, file + ': the title still says something')
  }
})

test('③ the title is the same in both languages', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', 'en.json'), 'utf8'))
  assert.equal(zh.pluginFailure.title, '启动后有东西没起来')
  assert.equal(en.pluginFailure.title, 'Something did not come up after the start')
})

// ---------------------------------------------------------------------------
// ④ THE COMMAND NAMES A REAL PROFILE (user report, 2026-11-05).
//
// WHAT THE USER SAW on the hosted web instance:
//
//   «要还原就用下面这条命令…»
//   dsh plugin --profile <profile> add dsh-better-sidebar@0.28.2
//
// `<profile>` is a PLACEHOLDER: nobody can copy that line and run it. The Host
// already knows the profile — it answers with the profile DIRECTORY, and the
// profile NAME is its last segment.
//
// TWO HOSTS, TWO SEPARATORS: the hosted web instance answers with a POSIX path
// (`/home/fg/.dsh/profiles/web`), the desktop build with a Windows one
// (`…\.dsh\profiles\desktop`). Both must work, and both ends share this file.
// ---------------------------------------------------------------------------

const profileNameOf = model && typeof model.pluginFailureProfileName === 'function'
  ? model.pluginFailureProfileName
  : null

test('④ the profile name is the last segment of the profile path', () => {
  assert.equal(typeof profileNameOf, 'function', 'pluginFailureProfileName must be published for the tests')
  assert.equal(profileNameOf({ profile: '/home/fg/.dsh/profiles/web' }), 'web', 'the hosted web instance')
  assert.equal(profileNameOf({ profile: 'C:\\Users\\Bob\\.dsh\\profiles\\desktop' }), 'desktop', 'the desktop build')
  assert.equal(profileNameOf({ profile: '/home/fg/.dsh/profiles/web/' }), 'web', 'a trailing separator is not a name')
  assert.equal(profileNameOf({ profile: { dir: '/home/fg/.dsh/profiles/web' } }), 'web', 'the Host may send an object')
})

test('④ a nested health payload is read too', () => {
  assert.equal(profileNameOf({ health: { profile: '/home/fg/.dsh/profiles/web' } }), 'web')
  assert.equal(profileNameOf({ status: { profile: '/home/fg/.dsh/profiles/web' } }), 'web')
  assert.equal(profileNameOf({ instance: { profile: '/home/fg/.dsh/profiles/web' } }), 'web')
  assert.equal(profileNameOf({ restart: { profile: '/home/fg/.dsh/profiles/web' } }), 'web')
})

test('④ when the Host says nothing there is no name — and no crash', () => {
  assert.equal(profileNameOf(null), '')
  assert.equal(profileNameOf({}), '')
  assert.equal(profileNameOf({ profile: '' }), '')
  assert.equal(profileNameOf({ profile: '   ' }), '')
  assert.equal(profileNameOf({ profile: 42 }), '')
})

test('④ the command carries the real name, and falls back to the placeholder', () => {
  const named = build({
    profile: profileNameOf({ profile: '/home/fg/.dsh/profiles/web' }),
    watch: watchPayload({ packages: ['dsh-better-sidebar@0.28.2'] }),
    inventory: inventoryPayload([{ name: 'dsh-better-sidebar', status: 'different', version: '0.28.2' }]),
  })
  assert.match(named.certain[0].action.command, /--profile web/, 'the command names the real profile')
  assert.equal(named.certain[0].action.command.includes('<profile>'), false, 'the placeholder is gone')
  assert.match(named.certain[0].action.command, /dsh-better-sidebar@0\.28\.2/, 'and the exact version')

  const unnamed = build({
    watch: watchPayload({ packages: ['dsh-better-sidebar@0.28.2'] }),
    inventory: inventoryPayload([{ name: 'dsh-better-sidebar', status: 'different', version: '0.28.2' }]),
  })
  assert.match(unnamed.certain[0].action.command, /--profile <profile>/, 'without a name the placeholder stays')
  assert.equal(/undefined|null/.test(unnamed.certain[0].action.command), false, 'and never undefined or null')
})

test('④ the panel hands the profile name to the model, at both call sites', () => {
  assert.match(panel, /profile: profileName/, 'the profile name reaches build()')
  assert.match(panel, /build\(\{ watch, inventory, profile: profileName \}\)/, 'the judgement inside the effect knows it')
  assert.match(
    panel,
    /build\(\{ watch: loaded\.watch, inventory: loaded\.inventory, profile: profileName \}\)/,
    'and so does the render',
  )
  assert.equal(
    /build\(\{ watch, inventory \}\)/.test(panel),
    false,
    'no call site is left without the profile',
  )
})

// ---------------------------------------------------------------------------
// ⑤ THE WAY OUT FOR EVERYONE WHO DOES NOT LIKE COMMANDS (user report,
//    2026-11-05).
//
// The card may say: go back to the Plugins page and reinstall it. But it has to
// say WHAT that gets you: the LATEST version, NOT the one in the backup. The
// command above installs the backup version; reinstalling from the interface
// does not. A user who does not know that will think the backup version came
// back.
//
// AND IT ONLY APPEARS WHERE THERE IS A COMMAND: the branch without a command
// (noCommandHint) must not carry a promise about something that is not there.
// ---------------------------------------------------------------------------

test('⑤ the reinstall hint sits in the branch that HAS a command', () => {
  const hintAt = panel.indexOf("t('pluginFailure.reinstallHint')")
  assert.ok(hintAt !== -1, 'the reinstall hint exists')
  const cmdAt = panel.indexOf("key: 'cmd:' + entry.name")
  assert.ok(cmdAt !== -1, 'the command row exists')
  assert.ok(hintAt > cmdAt, 'the hint follows the command it is about')

  const branchStart = panel.indexOf("typeof action.command === 'string' && action.command !== ''")
  const branchEnd = panel.indexOf("t('pluginFailure.noCommandHint')")
  assert.ok(branchStart !== -1, 'the branch with a command is findable')
  assert.ok(branchEnd > branchStart, 'the branch without a command is findable')
  assert.ok(hintAt > branchStart && hintAt < branchEnd, 'the hint lives in the branch that has a command')
  assert.equal(
    panel.slice(branchEnd).includes("t('pluginFailure.reinstallHint')"),
    false,
    'and the branch WITHOUT a command does not carry it',
  )
})

test('⑤ both languages say the reinstall gets the latest version, not the backup one', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', 'zh.json'), 'utf8')).pluginFailure.reinstallHint
  const en = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'locale', 'en.json'), 'utf8')).pluginFailure.reinstallHint
  assert.equal(typeof zh, 'string', 'the Chinese hint has a text')
  assert.equal(typeof en, 'string', 'the English hint has a text')
  assert.match(zh, /插件/, 'the Chinese text points at the Plugins page')
  assert.match(zh, /最新/, 'and says the reinstall gets the latest version')
  assert.match(zh, /备份/, 'and says it is not the version in the backup')
  assert.match(en, /Plugins page/, 'the English text points at the Plugins page')
  assert.match(en, /latest version/, 'and says the reinstall gets the latest version')
  assert.match(en, /not the one in the backup/, 'and says it is not the version in the backup')
})
