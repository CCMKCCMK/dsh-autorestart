/**
 * WHAT CAN THE RUNNING HOST SEE, AND WHAT DID IT STOP SEEING?
 *
 * A plugin can be present on disk and still do nothing: it never registered, or
 * its fibre died quietly. There is no single "is every plugin alive?" API, but
 * three surfaces together cover what a plugin can actually DO:
 *
 *   tools          - plugins that provide tools (codekg, vault, release-board…)
 *   clientModules  - plugins that draw something in the interface
 *   packages       - packages that register a schema
 *
 * A plugin that provides no tool, draws nothing and registers nothing has also
 * done nothing, so these three layers are enough for the practical cases.
 *
 * THIS MODULE ONLY COLLECTS AND COMPARES. It never decides "a plugin is broken",
 * it never repairs anything and it imports nothing from the host: everything it
 * needs comes in through `ctx`. It runs on the boot path, so it must never throw.
 */

/** The three surfaces, in a stable order. */
export const WATCH_LAYERS = Object.freeze(['tools', 'clientModules', 'packages'])

/**
 * Turn whatever a service returned into a plain list of names.
 *
 * The three surfaces do not share a shape, and their shape may change between
 * host versions. Rather than hard-coding one, accept the shapes that mean
 * something and return `null` for anything that does not - `null` says "I could
 * not see this layer", which the comparison treats as "no news", never as "gone".
 *
 * @param {unknown} value
 * @returns {string[]|null}
 */
export function toNameList(value) {
  if (value === null || value === undefined) return null
  const pick = (item) => {
    if (typeof item === 'string') return item.trim() === '' ? null : item
    if (item === null || typeof item !== 'object') return null
    for (const key of ['name', 'id', 'key', 'label']) {
      const candidate = item[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
    return null
  }
  const clean = (list) => {
    const out = []
    const seen = new Set()
    for (const item of list) {
      const name = pick(item)
      if (name === null) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
    return out.sort()
  }
  try {
    if (Array.isArray(value)) return clean(value)
    if (value instanceof Map) return clean([...value.keys()])
    if (value instanceof Set) return clean([...value])
    if (typeof value === 'object') {
      // A map keyed by name: the keys ARE the names.
      return clean(Object.keys(value))
    }
  } catch {
    return null
  }
  return null
}

/** Call one surface and normalise it; any failure becomes `null`. */
function readLayer(read, map = toNameList) {
  try {
    const raw = read()
    return map(raw)
  } catch {
    return null
  }
}

/**
 * Collect the three lists from a live Cordis context.
 *
 * Every layer is independent: a missing service, a service that throws, or a
 * shape nothing recognises only makes THAT layer `null`. The other two are still
 * collected, because a partial picture beats no picture on the boot path.
 *
 * @param {object} ctx
 * @param {{ now?: number }} [options]
 * @returns {{ at: number, tools: string[]|null, clientModules: string[]|null, packages: string[]|null }}
 */
/**
 * Read one optional service from the context.
 *
 * `ctx.get(name)` is Cordis' OFFICIAL door for OPTIONAL access: a service that is
 * not there answers `undefined` instead of making the plugin refuse to activate.
 * A plain `ctx.name` only works for services this plugin declared in `inject`,
 * which is a HARD dependency - measured on the real host, `ctx.clientModules` and
 * `ctx.typert` were both `undefined` while `ctx.tools` worked, because only
 * `tools` is in the inject list.
 *
 * Declaring the other two in `inject` would be the wrong fix: this plugin is the
 * one that brings a dead host back, so it must never refuse to load just because
 * an optional monitoring surface is missing.
 *
 * Older hosts without `ctx.get` fall back to the property; neither path throws.
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {unknown}
 */
function serviceOf(ctx, name) {
  const safe = ctx !== null && typeof ctx === 'object' ? ctx : {}
  try {
    if (typeof safe.get === 'function') return safe.get(name)
  } catch {
    // A `get` that throws is the same as a service that is not there.
    return undefined
  }
  return safe[name]
}

export function collectCapabilities(ctx, { now = Date.now() } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  return {
    at,
    tools: readLayer(() => {
      const service = serviceOf(ctx, 'tools')
      if (!service || typeof service.schemas !== 'function') return undefined
      return service.schemas()
    }),
    clientModules: readLayer(() => {
      const service = serviceOf(ctx, 'clientModules')
      if (!service || typeof service.graph !== 'function') return undefined
      return service.graph()
    }),
    packages: readLayer(() => {
      const service = serviceOf(ctx, 'typert')
      if (!service || typeof service.listPackages !== 'function') return undefined
      return service.listPackages()
    }),
  }
}

/** A snapshot is usable only when it is an object with a timestamp. */
function isSnapshot(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(Number(value.at))
}

/**
 * What did the host STOP seeing since `previous`?
 *
 * Only disappearances count. A plugin the user just installed is normal and is
 * not reported. An empty or unreadable snapshot reports nothing at all, so the
 * very first boot after installing this plugin is silent instead of alarming.
 *
 * @param {object|null} previous
 * @param {object|null} current
 * @returns {{ at: number|null, layers: Record<string, { removed: string[] }>, removedTotal: number, hasDisappearances: boolean }}
 */
export function compareCapabilities(previous, current) {
  const layers = {}
  for (const layer of WATCH_LAYERS) layers[layer] = { removed: [] }

  const before = isSnapshot(previous) ? previous : null
  const after = isSnapshot(current) ? current : null
  // No previous snapshot: nothing to compare against. Nothing is "missing".
  if (before === null || after === null) {
    return { at: after === null ? null : Number(after.at), layers, removedTotal: 0, hasDisappearances: false }
  }

  let removedTotal = 0
  for (const layer of WATCH_LAYERS) {
    const was = before[layer]
    const is = after[layer]
    // Either side unreadable means "no news" for that layer - never an alarm.
    if (Array.isArray(was) !== true || Array.isArray(is) !== true) continue
    const now = new Set(is)
    const removed = was.filter((name) => typeof name === 'string' && now.has(name) !== true).sort()
    layers[layer] = { removed }
    removedTotal += removed.length
  }

  return {
    at: Number(after.at),
    layers,
    removedTotal,
    hasDisappearances: removedTotal > 0,
  }
}

/**
 * The layers that lost something, as a flat, printable list.
 *
 * Still only a statement of fact ("this name was here and is not any more"); it
 * does not claim the plugin is broken.
 *
 * @param {ReturnType<typeof compareCapabilities>} comparison
 * @returns {Array<{ layer: string, name: string }>}
 */
export function listDisappearances(comparison) {
  const out = []
  if (comparison === null || typeof comparison !== 'object') return out
  const layers = comparison.layers !== null && typeof comparison.layers === 'object' ? comparison.layers : {}
  for (const layer of WATCH_LAYERS) {
    const entry = layers[layer]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry.removed) !== true) continue
    for (const name of entry.removed) {
      if (typeof name === 'string') out.push({ layer, name })
    }
  }
  return out
}
