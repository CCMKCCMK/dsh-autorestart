import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectCapabilities,
  compareCapabilities,
  listDisappearances,
  toNameList,
  WATCH_LAYERS,
} from '../lib/plugin-watch.js'

/**
 * Self-contained fixtures: a fake Cordis context exposing exactly the three
 * services this collector reads, so the test never touches a real host.
 */
function makeCtx({ tools, clientModules, packages, throwOn = [] } = {}) {
  const boom = (name, value) => {
    if (throwOn.includes(name)) throw new Error(name + ' blew up')
    return value
  }
  return {
    tools: {
      schemas: () => boom('tools', tools),
    },
    clientModules: {
      graph: () => boom('clientModules', clientModules),
    },
    typert: {
      listPackages: () => boom('packages', packages),
    },
  }
}

const AT = Date.UTC(2026, 10, 1, 8, 0, 0)

// ---------------------------------------------------------------------------
// ① the three layers are collected
// ---------------------------------------------------------------------------

test('collectCapabilities reads all three surfaces', () => {
  const ctx = makeCtx({
    // A map keyed by tool name, which is what `schemas()` looks like.
    tools: { codekg_query: {}, 'vault_list': {}, release_board: {} },
    // A graph whose nodes carry their own names.
    clientModules: [{ name: 'dsh-autorestart-panel' }, { name: 'dsh-cost-meter' }],
    packages: ['dsh-autorestart', 'dsh-codekg'],
  })

  const found = collectCapabilities(ctx, { now: AT })
  assert.equal(found.at, AT, 'the timestamp comes from the caller')
  assert.deepEqual(found.tools, ['codekg_query', 'release_board', 'vault_list'], 'tool names, sorted')
  assert.deepEqual(found.clientModules, ['dsh-autorestart-panel', 'dsh-cost-meter'], 'interface modules')
  assert.deepEqual(found.packages, ['dsh-autorestart', 'dsh-codekg'], 'registered packages')
  assert.deepEqual(Object.keys(found).sort(), ['at', 'clientModules', 'packages', 'tools'])
})

test('WATCH_LAYERS names exactly the three surfaces', () => {
  assert.deepEqual([...WATCH_LAYERS], ['tools', 'clientModules', 'packages'])
})

// ---------------------------------------------------------------------------
// ② one broken layer never takes the others down
// ---------------------------------------------------------------------------

test('a missing service makes only that layer null', () => {
  const ctx = {
    tools: { schemas: () => ({ alpha: {} }) },
    // no clientModules at all
    typert: { listPackages: () => ['pkg-a'] },
  }
  const found = collectCapabilities(ctx, { now: AT })
  assert.equal(found.clientModules, null, 'the missing service is null')
  assert.deepEqual(found.tools, ['alpha'], 'the other layers are still collected')
  assert.deepEqual(found.packages, ['pkg-a'])
})

test('a service that throws makes only that layer null', () => {
  const ctx = makeCtx({
    tools: { alpha: {} },
    clientModules: [{ name: 'ui' }],
    packages: ['pkg-a'],
    throwOn: ['tools'],
  })
  const found = collectCapabilities(ctx, { now: AT })
  assert.equal(found.tools, null, 'the throwing layer is null')
  assert.deepEqual(found.clientModules, ['ui'], 'and the rest survives')
  assert.deepEqual(found.packages, ['pkg-a'])
})

test('a service that returns a shape nothing recognises becomes null, not a crash', () => {
  const ctx = makeCtx({
    tools: 42,
    clientModules: 'a string is not a graph',
    packages: { 'pkg-a': {} },
  })
  const found = collectCapabilities(ctx, { now: AT })
  assert.equal(found.tools, null, 'a number is not a list of tools')
  assert.equal(found.clientModules, null, 'a string is not a list of modules')
  assert.deepEqual(found.packages, ['pkg-a'], 'a keyed map still works')
})

test('collectCapabilities never throws, whatever it is handed', () => {
  for (const ctx of [undefined, null, {}, 42, 'nope', [], { tools: null }]) {
    let found
    assert.doesNotThrow(() => {
      found = collectCapabilities(ctx, { now: AT })
    }, String(ctx) + ': must not throw')
    assert.equal(typeof found.at, 'number')
    for (const layer of WATCH_LAYERS) {
      assert.equal(found[layer] === null || Array.isArray(found[layer]), true, layer + ' is a list or null')
    }
  }
})

test('toNameList accepts the shapes a host may hand over', () => {
  assert.deepEqual(toNameList(['b', 'a']), ['a', 'b'])
  assert.deepEqual(toNameList({ b: 1, a: 2 }), ['a', 'b'])
  assert.deepEqual(toNameList([{ name: 'x' }, { id: 'y' }, { key: 'z' }]), ['x', 'y', 'z'])
  assert.deepEqual(toNameList(['dup', 'dup']), ['dup'], 'duplicates collapse')
  assert.equal(toNameList(null), null)
  assert.equal(toNameList(undefined), null)
  assert.equal(toNameList(7), null)
})

// ---------------------------------------------------------------------------
// ③ only disappearances are reported
// ---------------------------------------------------------------------------

test('compareCapabilities reports what disappeared and says nothing about additions', () => {
  const previous = { at: AT - 1000, tools: ['alpha', 'beta'], clientModules: ['ui-old'], packages: ['pkg-a'] }
  const current = { at: AT, tools: ['beta', 'gamma'], clientModules: ['ui-old', 'ui-new'], packages: ['pkg-a', 'pkg-b'] }

  const comparison = compareCapabilities(previous, current)
  assert.deepEqual(comparison.layers.tools.removed, ['alpha'], 'the tool that vanished')
  assert.deepEqual(comparison.layers.clientModules.removed, [], 'additions are not a problem')
  assert.deepEqual(comparison.layers.packages.removed, [], 'a newly installed package is normal')
  assert.equal(comparison.removedTotal, 1)
  assert.equal(comparison.hasDisappearances, true)
})

test('two identical snapshots report nothing', () => {
  const snapshot = { at: AT, tools: ['a'], clientModules: ['u'], packages: ['p'] }
  const comparison = compareCapabilities(snapshot, { ...snapshot, at: AT + 1000 })
  assert.equal(comparison.removedTotal, 0)
  assert.equal(comparison.hasDisappearances, false)
  for (const layer of WATCH_LAYERS) assert.deepEqual(comparison.layers[layer].removed, [])
})

// ---------------------------------------------------------------------------
// ④ an empty or unreadable snapshot never produces a false alarm
// ---------------------------------------------------------------------------

test('the first run reports nothing at all', () => {
  const current = { at: AT, tools: ['a', 'b'], clientModules: ['u'], packages: ['p'] }
  for (const previous of [null, undefined, {}, { at: 'not-a-number' }, 42, 'nope']) {
    const comparison = compareCapabilities(previous, current)
    assert.equal(comparison.hasDisappearances, false, JSON.stringify(previous) + ': must not alarm')
    assert.equal(comparison.removedTotal, 0)
    for (const layer of WATCH_LAYERS) assert.deepEqual(comparison.layers[layer].removed, [])
  }
})

test('a layer that could not be read this time reports nothing', () => {
  const previous = { at: AT - 1000, tools: ['alpha'], clientModules: ['ui'], packages: ['pkg-a'] }
  // `tools` could not be read now: that is "no news", not "alpha is gone".
  const current = { at: AT, tools: null, clientModules: [], packages: ['pkg-a'] }

  const comparison = compareCapabilities(previous, current)
  assert.deepEqual(comparison.layers.tools.removed, [], 'an unreadable layer is never an alarm')
  assert.deepEqual(comparison.layers.clientModules.removed, ['ui'], 'a readable empty layer still counts')
  assert.equal(comparison.removedTotal, 1)
})

// ---------------------------------------------------------------------------
// ⑤ the result survives a JSON round trip
// ---------------------------------------------------------------------------

test('a collected snapshot is plain data', () => {
  const ctx = makeCtx({
    tools: { alpha: {} },
    clientModules: [{ name: 'ui' }],
    packages: ['pkg-a'],
  })
  const found = collectCapabilities(ctx, { now: AT })
  const round = JSON.parse(JSON.stringify(found))
  assert.deepEqual(round, found, 'JSON round trip is lossless')
  for (const layer of WATCH_LAYERS) {
    for (const name of found[layer]) assert.equal(typeof name, 'string')
  }
  assert.equal(typeof found.at, 'number')
})

test('a comparison is plain data too', () => {
  const comparison = compareCapabilities(
    { at: AT - 1, tools: ['alpha'], clientModules: [], packages: [] },
    { at: AT, tools: [], clientModules: [], packages: [] },
  )
  assert.deepEqual(JSON.parse(JSON.stringify(comparison)), comparison)
})

test('listDisappearances flattens the layers and never invents a verdict', () => {
  const comparison = compareCapabilities(
    { at: AT - 1, tools: ['alpha', 'beta'], clientModules: ['ui'], packages: [] },
    { at: AT, tools: ['beta'], clientModules: [], packages: [] },
  )
  const flat = listDisappearances(comparison)
  assert.deepEqual(flat, [
    { layer: 'tools', name: 'alpha' },
    { layer: 'clientModules', name: 'ui' },
  ], 'every disappearance, and only disappearances')
  // The report states a fact; it must not carry a "broken" verdict.
  assert.equal(Object.keys(flat[0]).sort().join(','), 'layer,name')
  assert.deepEqual(listDisappearances(null), [])
})

// ---------------------------------------------------------------------------
// THE REAL HOST ROUTE: ctx.get(name), not ctx.name
//
// Measured on the real machine (2026-11-01): `ctx.tools` worked because it is in
// the inject list, but `ctx.clientModules` and `ctx.typert` were both undefined -
// they are never injected, and this plugin must NEVER inject them (a hard
// dependency on an optional monitoring surface would stop the rescue plugin from
// loading at all). `ctx.get(name)` is the official optional door.
// ---------------------------------------------------------------------------

test('the services are read through ctx.get, which is how a real host exposes them', () => {
  // A host context where ONLY ctx.get works: the properties are absent, exactly
  // like the real machine.
  const services = {
    tools: { schemas: () => ({ alpha: {} }) },
    clientModules: { graph: () => [{ name: 'ui-panel' }] },
    // The SERVICE is named `typert`; the LAYER it feeds is reported as `packages`.
    typert: { listPackages: () => ['pkg-a'] },
  }
  const asked = []
  const ctx = {
    get: (name) => { asked.push(name); return services[name] },
  }

  const found = collectCapabilities(ctx, { now: AT })
  assert.deepEqual(found.tools, ['alpha'], 'the tool layer is read through ctx.get')
  assert.deepEqual(found.clientModules, ['ui-panel'], 'the interface layer TOO - this was null on the real host')
  assert.deepEqual(found.packages, ['pkg-a'], 'and the package layer as well')
  // The SERVICE names are asked for: `typert` is the service, `packages` is the layer it feeds.
  assert.deepEqual(asked.sort(), ['clientModules', 'tools', 'typert'], 'every layer asked ctx.get for its own service name')
})

test('an older host without ctx.get falls back to plain properties', () => {
  const ctx = {
    tools: { schemas: () => ({ alpha: {} }) },
    clientModules: { graph: () => ['ui'] },
    typert: { listPackages: () => ['pkg-a'] },
  }
  const found = collectCapabilities(ctx, { now: AT })
  assert.deepEqual(found.tools, ['alpha'])
  assert.deepEqual(found.clientModules, ['ui'])
  assert.deepEqual(found.packages, ['pkg-a'])
})

test('ctx.get is preferred over a property of the same name', () => {
  const ctx = {
    get: (name) => (name === 'tools' ? { schemas: () => ({ fromGet: {} }) } : undefined),
    tools: { schemas: () => ({ fromProperty: {} }) },
  }
  const found = collectCapabilities(ctx, { now: AT })
  assert.deepEqual(found.tools, ['fromGet'], 'ctx.get wins: it is the documented route')
})

test('a layer ctx.get cannot answer stays null and never becomes an empty list', () => {
  const ctx = { get: () => undefined }
  const found = collectCapabilities(ctx, { now: AT })
  for (const layer of WATCH_LAYERS) {
    assert.equal(found[layer], null, layer + ' must stay null, not [] - "unread" is not "empty"')
    assert.notDeepEqual(found[layer], [], layer + ' must never degrade into an empty list')
  }
})

test('a ctx.get that throws does not take the other layers down', () => {
  const ctx = {
    get: (name) => {
      if (name === 'tools') throw new Error('service exploded')
      if (name === 'clientModules') return { graph: () => ['ui'] }
      return { listPackages: () => ['pkg-a'] }
    },
  }
  const found = collectCapabilities(ctx, { now: AT })
  assert.equal(found.tools, null, 'the throwing layer is null')
  assert.deepEqual(found.clientModules, ['ui'], 'the others still work')
  assert.deepEqual(found.packages, ['pkg-a'])
})

test('a host whose ctx.get knows nothing, and a host with no ctx at all, both stay quiet', () => {
  for (const ctx of [{ get: () => undefined }, {}, null, undefined]) {
    const found = collectCapabilities(ctx, { now: AT })
    assert.equal(found.tools, null)
    assert.equal(found.clientModules, null)
    assert.equal(found.packages, null)
  }
})
