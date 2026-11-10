/**
 * dsh-autorestart — "is the plugin market installing something right now?".
 *
 * The market (`dshmarket`) installs and updates plugins: its pnpm run is
 * followed by retargeting, validation and a hot mount, and restarting the host
 * in the middle of that work leaves a half-installed plugin behind. The restart
 * gate knew nothing about it, so it happily killed the host.
 *
 * THE TRUTH IS NOT OUR DATA: the market owns one operation lock and publishes it
 * on its own status route (`GET /dsh-market/status`):
 *
 *   - `busy`   the ROUTE-LEVEL operation flag: true for the WHOLE operation,
 *              including the post-processing after pnpm exits;
 *   - `active` the narrower "pnpm is running right now" flag.
 *
 * PURE where it can be: `parseMarketStatus`, `applyMarketSample` and
 * `marketInstallStatus` transform a payload / a previous sample into a decision
 * and import nothing. Only `probeMarketStatus` touches the network, and it takes
 * its `fetch` and its clock from the caller.
 *
 * THE RULES, each one a decision:
 *   1. `busy` OR `active` means "the market is installing" (the narrower flag is
 *      a subset, so honouring both can only make the gate MORE careful).
 *   2. An unreadable answer is NOT an install: a timeout, a 404 (the market is
 *      not installed at all), a non-2xx answer or a body that is not an object
 *      all mean "nothing is being installed", and the restart proceeds exactly
 *      as it did before this feature existed. A probe that cannot see must never
 *      hold the host hostage.
 *   3. A busy answer is remembered, and when it ENDS the gate still waits a short
 *      cooldown (15 s by default): the market drains a queue of operations, and
 *      the gap between two of them is not a safe moment to kill the host.
 *   4. The probe is READ ONLY: one GET, no body, no retry, no mutation.
 *
 * ESM only, Node builtins only.
 */

/** The market's own status route. */
export const MARKET_STATUS_PATH = '/dsh-market/status'

/** The hard upper bound of one probe (ms): a caller can shorten it, never extend it. */
export const PROBE_TIMEOUT_MS = 800

/** How long the gate keeps waiting AFTER the market reported "not busy" again (ms). */
export const INSTALL_COOLDOWN_MS = 15000

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A trimmed string field, or ''. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A non-negative duration, falling back to `fallback`. */
function durationOf(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

/**
 * The state machine's empty state: nothing seen, nothing blocked.
 *
 * "We have not looked yet" and "we looked and it is idle" behave the same,
 * because a probe that has never run must not be able to hold a restart.
 *
 * @returns {{ busy: boolean, busyAt: number|null, packageName: string|null, phase: string|null, sampledAt: number|null, reachable: boolean }}
 */
export function emptyMarketState() {
  return { busy: false, busyAt: null, packageName: null, phase: null, sampledAt: null, reachable: false }
}

/**
 * Read one raw status payload into a SAMPLE.
 *
 * A payload that is not an object is not an install. The flags are read strictly
 * (`=== true`), so a truthy string such as `"false"` cannot turn a quiet market
 * into a blocking one.
 *
 * @param {unknown} payload the parsed body of `GET /dsh-market/status`
 * @returns {{ reachable: boolean, busy: boolean, packageName: string|null, phase: string|null, target: string|null }}
 */
export function parseMarketStatus(payload) {
  if (!isObject(payload)) {
    return { reachable: false, busy: false, packageName: null, phase: null, target: null }
  }
  const busy = payload.busy === true || payload.active === true
  const packageName = textOf(payload.currentPackage) || textOf(payload.target) || null
  const phase = textOf(payload.phase) || null
  const target = textOf(payload.target) || null
  return { reachable: true, busy, packageName, phase, target }
}

/**
 * Fold one sample into the probe state.
 *
 * `busyAt` is the LAST moment the market reported that it was working: the
 * cooldown is measured from there, which is what lets a quiet sample right after
 * a busy one still block.
 *
 * An UNREACHABLE sample changes nothing about `busyAt` — it is simply ignored —
 * so an unreachable probe decides nothing in either direction.
 *
 * @param {object} state
 * @param {object|null} sample
 * @param {{ now?: number }} [options]
 * @returns {{ busy: boolean, busyAt: number|null, packageName: string|null, phase: string|null, sampledAt: number|null, reachable: boolean }}
 */
export function applyMarketSample(state, sample, { now = Date.now() } = {}) {
  const previous = isObject(state) ? state : emptyMarketState()
  const at = isFiniteNumber(now) ? now : Date.now()
  const reachable = isObject(sample) && sample.reachable !== false
  if (!reachable) {
    return {
      busy: previous.busy === true,
      busyAt: isFiniteNumber(previous.busyAt) ? previous.busyAt : null,
      packageName: textOf(previous.packageName) || null,
      phase: textOf(previous.phase) || null,
      sampledAt: isFiniteNumber(previous.sampledAt) ? previous.sampledAt : null,
      reachable: false,
    }
  }
  const busy = sample.busy === true
  return {
    busy,
    busyAt: busy ? at : (isFiniteNumber(previous.busyAt) ? previous.busyAt : null),
    packageName: busy
      ? (textOf(sample.packageName) || textOf(previous.packageName) || null)
      : (textOf(previous.packageName) || null),
    phase: busy ? (textOf(sample.phase) || textOf(previous.phase) || null) : null,
    sampledAt: at,
    reachable: true,
  }
}

/**
 * Is the market installing something right now — or did it just stop?
 *
 * Pure: it only reads the state and the clock, so the gate can call it on every
 * tick without any side effect.
 *
 * @param {object} state
 * @param {{ now?: number, cooldownMs?: number }} [options]
 * @returns {{ installing: boolean, reason: 'busy'|'cooldown'|'idle'|'unknown', packageName: string|null, phase: string|null, cooldownUntil: number|null, cooldownRemainingMs: number, sampledAt: number|null }}
 */
export function marketInstallStatus(state, { now = Date.now(), cooldownMs = INSTALL_COOLDOWN_MS } = {}) {
  const current = isObject(state) ? state : emptyMarketState()
  const at = isFiniteNumber(now) ? now : Date.now()
  const cooldown = durationOf(cooldownMs, INSTALL_COOLDOWN_MS)
  const packageName = textOf(current.packageName) || null
  const phase = textOf(current.phase) || null
  const sampledAt = isFiniteNumber(current.sampledAt) ? current.sampledAt : null
  if (current.busy === true) {
    return { installing: true, reason: 'busy', packageName, phase, cooldownUntil: null, cooldownRemainingMs: 0, sampledAt }
  }
  const busyAt = isFiniteNumber(current.busyAt) ? current.busyAt : null
  if (busyAt !== null) {
    const until = busyAt + cooldown
    if (at < until) {
      return {
        installing: true,
        reason: 'cooldown',
        packageName,
        phase,
        cooldownUntil: until,
        cooldownRemainingMs: Math.max(0, until - at),
        sampledAt,
      }
    }
  }
  return {
    installing: false,
    reason: sampledAt === null && busyAt === null ? 'unknown' : 'idle',
    packageName: null,
    phase: null,
    cooldownUntil: null,
    cooldownRemainingMs: 0,
    sampledAt,
  }
}

/**
 * The loopback URL of the market's status route, or null when it is unknown.
 *
 * @param {number} port the host's own web port
 * @param {{ path?: string }} [options]
 * @returns {string|null}
 */
export function marketStatusUrl(port, { path = MARKET_STATUS_PATH } = {}) {
  const number = Number(port)
  if (!Number.isFinite(number) || number <= 0) return null
  const suffix = typeof path === 'string' && path.startsWith('/') ? path : MARKET_STATUS_PATH
  return 'http://127.0.0.1:' + Math.trunc(number) + suffix
}

/**
 * Ask the market, once.
 *
 * NEVER THROWS and NEVER HANGS: bounded by the hard 800 ms ceiling, and every
 * failure — a thrown fetch, a non-2xx answer, a body that is not JSON — answers
 * with an unreachable sample. READ ONLY: one GET, no body, no retry.
 *
 * @param {{ url: string|null, fetchImpl?: Function, timeoutMs?: number, now?: () => number }} options
 * @returns {Promise<object>}
 */
export async function probeMarketStatus({ url, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  let at = null
  try {
    const stamp = Number(clock())
    at = Number.isFinite(stamp) ? stamp : null
  } catch {
    at = null
  }
  const unreachable = (error, status = null) => ({
    reachable: false,
    busy: false,
    packageName: null,
    phase: null,
    target: null,
    status,
    error,
    at,
  })
  if (typeof url !== 'string' || url === '') return unreachable('no-url')
  const fetchFn = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
  if (fetchFn === null) return unreachable('no-fetch')

  const budget = Math.min(durationOf(timeoutMs, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS)
  let timer = null
  let controller = null
  try {
    controller = typeof AbortController === 'function' ? new AbortController() : null
  } catch {
    controller = null
  }
  const abort = () => {
    try {
      if (controller !== null) controller.abort()
    } catch {
      // An abort that fails is not an error: the request is already gone.
    }
  }
  try {
    timer = setTimeout(abort, budget)
    if (timer && typeof timer.unref === 'function') timer.unref()
  } catch {
    timer = null
  }
  try {
    const init = { method: 'GET', headers: { accept: 'application/json' } }
    if (controller !== null) init.signal = controller.signal
    const response = await fetchFn(url, init)
    const rawStatus = isObject(response) ? Number(response.status) : NaN
    const status = Number.isFinite(rawStatus) ? rawStatus : null
    if (!isObject(response) || response.ok !== true) {
      return unreachable('http-' + String(status === null ? 'error' : status), status)
    }
    let payload = null
    try {
      payload = typeof response.json === 'function' ? await response.json() : null
    } catch {
      payload = null
    }
    const sample = parseMarketStatus(payload)
    if (sample.reachable !== true) return unreachable('unreadable-body', status)
    return { ...sample, status, error: null, at }
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error)
    return unreachable(message === '' ? 'probe-failed' : message)
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch {
        // Nothing to clear.
      }
    }
  }
}

/**
 * ONE line for the log/diagnostics: what the probe saw and what it decided.
 *
 * @param {object} status
 * @returns {string}
 */
export function describeMarketInstall(status) {
  const current = isObject(status) ? status : {}
  const name = textOf(current.packageName)
  if (current.installing !== true) return 'the plugin market is not installing anything'
  if (current.reason === 'cooldown') {
    return 'the plugin market just finished'
      + (name === '' ? '' : ' ' + name)
      + '; waiting ' + Math.max(0, Math.round(Number(current.cooldownRemainingMs) || 0)) + ' ms in case the queue continues'
  }
  return 'the plugin market is installing' + (name === '' ? ' a plugin' : ' ' + name)
}
