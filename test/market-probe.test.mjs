/**
 * THE PLUGIN MARKET MUST FINISH BEFORE THE HOST RESTARTS (2026-11-10).
 *
 * The market installs a plugin with pnpm and then keeps the operation lock while
 * it retargets, validates and hot-mounts — a restart in that window leaves a
 * half-installed plugin behind. These tests pin the RULES of the probe: what
 * counts as "installing", that an unreadable answer never blocks, and the short
 * cooldown that bridges the gap between two operations of the market's queue.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import {
  INSTALL_COOLDOWN_MS,
  MARKET_STATUS_PATH,
  PROBE_TIMEOUT_MS,
  applyMarketSample,
  emptyMarketState,
  marketInstallStatus,
  marketStatusUrl,
  parseMarketStatus,
  probeMarketStatus,
} from '../lib/market-probe.js'
import { restartDecision, restartGate } from '../lib/lifecycle.js'

const T = 1_700_000_000_000
const URL_OK = 'http://127.0.0.1:1234/dsh-market/status'

/** A fetch stand-in that answers one payload. */
function answer(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => body })
}

/* ------------------------------------------------------------------ *
 * ① WHAT THE MARKET SEES IS WHAT THE GATE BLOCKS.
 * ------------------------------------------------------------------ */

test('the status route and its two flags are read as a sample', () => {
  assert.equal(MARKET_STATUS_PATH, '/dsh-market/status')
  assert.equal(PROBE_TIMEOUT_MS, 800, 'the hard ceiling of one probe')
  assert.equal(INSTALL_COOLDOWN_MS, 15000, 'the cooldown after the market finished')
  assert.equal(marketStatusUrl(1234), URL_OK)
  assert.equal(marketStatusUrl(0), null, 'a host without a web server has nothing to ask')
  assert.equal(marketStatusUrl(1234, { path: '/x/status' }), 'http://127.0.0.1:1234/x/status')

  const busy = parseMarketStatus({ busy: true, currentPackage: 'dsh-foo', phase: 'install' })
  assert.equal(busy.reachable, true)
  assert.equal(busy.busy, true)
  assert.equal(busy.packageName, 'dsh-foo')
  assert.equal(parseMarketStatus({ active: true }).busy, true, 'the narrower flag counts too')
  assert.equal(parseMarketStatus({ busy: false, active: false }).busy, false)
  assert.equal(parseMarketStatus({ busy: 'false' }).busy, false, 'a truthy string is not true')
  assert.equal(parseMarketStatus(null).reachable, false, 'not an object: nothing to read')
})

/* ------------------------------------------------------------------ *
 * ② BUSY BLOCKS, QUIET ALLOWS.
 * ------------------------------------------------------------------ */

test('a busy market blocks, an idle one does not', () => {
  const busySample = parseMarketStatus({ busy: true, currentPackage: 'dsh-foo' })
  const busy = applyMarketSample(emptyMarketState(), busySample, { now: T })
  const busyVerdict = marketInstallStatus(busy, { now: T })
  assert.equal(busyVerdict.installing, true)
  assert.equal(busyVerdict.reason, 'busy')
  assert.equal(busyVerdict.packageName, 'dsh-foo')

  const idle = applyMarketSample(emptyMarketState(), parseMarketStatus({ busy: false }), { now: T })
  assert.equal(marketInstallStatus(idle, { now: T }).installing, false)
  // "Never looked" is not a block either.
  assert.equal(marketInstallStatus(emptyMarketState(), { now: T }).installing, false)
})

/* ------------------------------------------------------------------ *
 * ③ A PROBE THAT CANNOT SEE NEVER BLOCKS.
 * ------------------------------------------------------------------ */

test('a failing, missing or unparseable answer means "not installing"', async () => {
  const thrown = await probeMarketStatus({
    url: URL_OK,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(thrown.reachable, false)
  assert.equal(thrown.busy, false)

  const missing = await probeMarketStatus({ url: URL_OK, fetchImpl: answer(null, { ok: false, status: 404 }) })
  assert.equal(missing.reachable, false, 'a host without the market answers 404')

  const garbage = await probeMarketStatus({
    url: URL_OK,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }),
  })
  assert.equal(garbage.reachable, false)

  const notAnObject = await probeMarketStatus({ url: URL_OK, fetchImpl: answer('hello') })
  assert.equal(notAnObject.reachable, false)

  const noUrl = await probeMarketStatus({ url: null })
  assert.equal(noUrl.reachable, false)

  for (const sample of [thrown, missing, garbage, notAnObject, noUrl]) {
    const state = applyMarketSample(emptyMarketState(), sample, { now: T })
    assert.equal(marketInstallStatus(state, { now: T }).installing, false, 'an unreadable market never holds the restart')
  }
})

/* ------------------------------------------------------------------ *
 * ④ THE COOLDOWN BETWEEN TWO OPERATIONS OF THE QUEUE.
 * ------------------------------------------------------------------ */

test('after a busy market the gate still waits the cooldown, then opens', () => {
  const busy = applyMarketSample(emptyMarketState(), parseMarketStatus({ busy: true }), { now: T })
  const quiet = applyMarketSample(busy, parseMarketStatus({ busy: false }), { now: T + 2000 })

  const inCooldown = marketInstallStatus(quiet, { now: T + 2000 })
  assert.equal(inCooldown.installing, true, 'the gap between two installs is not a safe moment')
  assert.equal(inCooldown.reason, 'cooldown')
  assert.equal(inCooldown.cooldownUntil, T + INSTALL_COOLDOWN_MS)

  assert.equal(marketInstallStatus(quiet, { now: T + INSTALL_COOLDOWN_MS - 1 }).installing, true)
  assert.equal(marketInstallStatus(quiet, { now: T + INSTALL_COOLDOWN_MS }).installing, false, 'the cooldown ends')

  // The cooldown is a KNOB, not a constant.
  assert.equal(marketInstallStatus(quiet, { now: T + 2000, cooldownMs: 500 }).installing, false)
})

test('one probe never waits longer than 800 ms, and a caller can only shorten it', async () => {
  const slow = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const started = Date.now()
  const sample = await probeMarketStatus({ url: URL_OK, fetchImpl: slow, timeoutMs: 100000 })
  const took = Date.now() - started
  assert.equal(sample.reachable, false)
  assert.ok(took < 1500, 'the request was aborted by the hard ceiling: ' + took + ' ms')
  assert.ok(took >= 700, 'and it really waited for the ceiling, not for a shorter one: ' + took + ' ms')
}, { timeout: 5000 })

/* ------------------------------------------------------------------ *
 * ⑤ THE GATE AND THE DECISION TAKE AN EXTERNAL BLOCKER.
 * ------------------------------------------------------------------ */

test('restartGate accepts an external blocker and keeps the session count empty', () => {
  const blocker = { sessionId: null, kind: 'market-install', reason: 'plugin-install' }
  const blocked = restartGate({}, {
    busyAgents: [],
    externalBlockers: [blocker],
    lastActivityAt: T,
    now: T + 60000,
    settleMs: 4000,
  })
  assert.equal(blocked.allow, false)
  assert.equal(blocked.reason, 'plugin-install')
  assert.deepEqual(blocked.blockedBy, [], 'the market is not a conversation: the task count stays 0')
  assert.deepEqual(blocked.externalBlockers, [blocker])

  // A conversation still wins the reason, and the count is unchanged.
  const both = restartGate({}, {
    busyAgents: [{ sessionId: 'sess-a', reason: 'running' }],
    externalBlockers: [blocker],
    lastActivityAt: T,
    now: T + 60000,
    settleMs: 4000,
  })
  assert.equal(both.reason, 'conversation-active')
  assert.equal(both.blockedBy.length, 1)

  // Without an external blocker nothing changed.
  const quiet = restartGate({}, { busyAgents: [], lastActivityAt: T, now: T + 60000, settleMs: 4000 })
  assert.equal(quiet.allow, true)
  assert.equal(quiet.reason, 'quiet')
})

test('restartDecision waits for the market instead of restarting', () => {
  const state = { phase: 'deferred', restart: { requestedAt: T, attempt: 0, notBefore: 0 } }
  const decision = restartDecision(state, {
    anyAgentRunning: false,
    busyAgents: [],
    externalBlockers: [{ sessionId: null, kind: 'market-install', reason: 'plugin-install' }],
    lastActivityAt: T,
    now: T + 60000,
    settleMs: 4000,
  })
  assert.equal(decision.action, 'long-wait', 'the tick must not execute a restart while the market installs')
  assert.equal(decision.reason, 'plugin-install')
  assert.deepEqual(decision.blockedBy, [])
})

/* ------------------------------------------------------------------ *
 * ⑥ THE ONE SENTENCE THE BUBBLE SHOWS.
 * ------------------------------------------------------------------ */

/** Load the classic client script the way the browser evaluates it. */
function loadClient({ language = 'zh-CN' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: { load: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
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
    navigator: { language },
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
  return sandbox.__dshAutorestartClient
}

test('the bubble and its tooltip say ONE sentence about the market, in both languages', () => {
  const zh = loadClient({ language: 'zh-CN' })
  const copy = zh.marketInstallCopy({ marketInstall: { installing: true, packageName: 'dsh-foo' } }, null)
  assert.equal(copy.installing, true)
  assert.match(copy.pill, /等插件市场装完插件后再重启/)
  assert.match(copy.tooltip, /等插件市场装完插件后再重启/)
  assert.doesNotMatch(copy.pill, /\d+%/, 'no progress bar, no number')
  assert.doesNotMatch(copy.pill, /按钮|点击/, 'no button, no instruction')

  // The gate's own word is enough (an older payload without the block).
  assert.equal(zh.marketInstallCopy({ reason: 'plugin-install' }, null).installing, true)
  // A quiet market says nothing at all.
  const quiet = zh.marketInstallCopy({ marketInstall: { installing: false } }, null)
  assert.equal(quiet.installing, false)
  assert.equal(quiet.pill, '')
  assert.equal(quiet.tooltip, '')

  const en = loadClient({ language: 'en-US' })
  const english = en.marketInstallCopy({ marketInstall: { installing: true } }, null)
  assert.match(english.pill, /plugin market/i)
  assert.doesNotMatch(english.pill, /等/, 'the English user never sees the Chinese sentence')
})
