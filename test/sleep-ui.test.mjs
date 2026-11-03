/**
 * Tests for the client half of the graceful shutdown ("收工关机").
 *
 * `client.js` is a CLASSIC script: the client module loader evaluates the
 * bundle as a same-origin external classic script, so it has no ESM exports
 * (an `export` keyword would be a SyntaxError and would take the whole plugin
 * down). The four pure helpers are therefore published on the global
 * namespace, which a Node test can read right after the import:
 *
 *   import '../client.js'
 *   const api = globalThis.__dshAutorestartClient
 *
 * The file also ends in a host-side regression: the standby's last gate must
 * NOT wait for the restart settle window (`settleMs`), or a settle window
 * longer than the countdown would postpone the power-off for ever.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import '../client.js'
import { apply } from '../index.js'

/** The pure helpers the client publishes for the tests. */
const api = globalThis.__dshAutorestartClient

assert.ok(api, 'the client must publish its pure helpers on globalThis.__dshAutorestartClient')
assert.equal(typeof api.pickSleepCaption, 'function')
assert.equal(typeof api.shouldShowSleepButton, 'function')
assert.equal(typeof api.buildChoiceBody, 'function')
assert.equal(typeof api.formatRemainingMs, 'function')

/* ------------------------------------------------------------------ *
 * pickSleepCaption — one line per second of the countdown.
 * ------------------------------------------------------------------ */

test('every countdown second has its own caption', () => {
  const seen = new Map()
  for (let seconds = 20; seconds >= 1; seconds -= 1) {
    const caption = api.pickSleepCaption(seconds)
    assert.equal(typeof caption, 'string')
    assert.ok(caption.trim() !== '', `the caption of ${seconds} must not be empty`)
    assert.ok(
      !seen.has(caption),
      `the captions of ${seconds} and ${seen.get(caption)} must be different`,
    )
    seen.set(caption, seconds)
  }
  assert.equal(seen.size, 20, 'the twenty countdown captions must all differ')
})

test('a longer countdown has a line for every second', () => {
  // 30 and 60 seconds are offered in the settings: every one of their
  // seconds must show a text (the egg lines, or the generic fallback).
  for (const seconds of [60, 30]) {
    for (let remaining = seconds; remaining >= 1; remaining -= 1) {
      const caption = api.pickSleepCaption(remaining)
      assert.equal(typeof caption, 'string')
      assert.ok(caption.trim() !== '', `the caption of ${remaining}s must not be empty`)
    }
  }
  // Above the egg lines the generic line carries the remaining seconds.
  const english = api.pickSleepCaption(45, 'en')
  assert.match(english, /45/)
  assert.match(english, /seconds left/)
  const chinese = api.pickSleepCaption(45, 'zh')
  assert.match(chinese, /45/)
  assert.match(chinese, /还剩/)
})

test('the seconds outside the countdown fall back to one line', () => {
  const fallback = api.pickSleepCaption(0)
  assert.equal(typeof fallback, 'string')
  assert.ok(fallback.trim() !== '', 'the fallback must not be empty')
  assert.equal(api.pickSleepCaption(-1), fallback)
  assert.equal(api.pickSleepCaption(0), fallback)
  assert.equal(api.pickSleepCaption(99), fallback)
  assert.equal(api.pickSleepCaption(Number.NaN), fallback)
})

test('the caption follows the language and a custom dictionary', () => {
  const english = api.pickSleepCaption(3, 'en')
  const chinese = api.pickSleepCaption(3, 'zh')
  assert.notEqual(english, chinese, 'the two languages must not share one line')
  assert.match(english, /[A-Za-z]/)
  assert.match(chinese, /[一-鿿]/)
  assert.equal(
    api.pickSleepCaption(3, { 'sleep.countdown.caption.3': '自定义一行' }),
    '自定义一行',
    'a dictionary must win over the built-in text',
  )
})

/* ------------------------------------------------------------------ *
 * shouldShowSleepButton — the Host's truth wins.
 * ------------------------------------------------------------------ */

test('the button follows the Host status', () => {
  assert.equal(api.shouldShowSleepButton({ showSleepButton: true }), true)
  assert.equal(api.shouldShowSleepButton({ showSleepButton: false }), false)
  assert.equal(
    api.shouldShowSleepButton({ showSleepButton: false, phase: 'countdown' }),
    false,
    'an explicit false wins over everything else',
  )
})

test('an unsupported host hides the button, in both shapes', () => {
  assert.equal(api.shouldShowSleepButton({ phase: 'unsupported' }), false)
  assert.equal(api.shouldShowSleepButton({ host: { kind: 'unsupported' } }), false)
  assert.equal(
    api.shouldShowSleepButton({ phase: 'idle', host: { kind: 'unsupported' } }),
    false,
  )
  assert.equal(api.shouldShowSleepButton({ phase: 'idle', host: { kind: 'windows' } }), true)
  assert.equal(api.shouldShowSleepButton({ phase: 'countdown', host: { kind: 'wsl' } }), true)
})

test('an unknown status does not forbid the button', () => {
  assert.equal(api.shouldShowSleepButton(null), true)
  assert.equal(api.shouldShowSleepButton(undefined), true)
  assert.equal(api.shouldShowSleepButton('nonsense'), true)
  assert.equal(api.shouldShowSleepButton({}), true)
})

/* ------------------------------------------------------------------ *
 * buildChoiceBody — only the answers that were given.
 * ------------------------------------------------------------------ */

test('the choice body carries only the answers that were given', () => {
  assert.deepEqual(api.buildChoiceBody({ includePlugins: true }), { includePlugins: true })
  assert.deepEqual(api.buildChoiceBody({ showSleepButton: false }), { showSleepButton: false })
  assert.deepEqual(
    api.buildChoiceBody({ includePlugins: true, showSleepButton: false }),
    { includePlugins: true, showSleepButton: false },
  )
  assert.deepEqual(api.buildChoiceBody({}), {})
  assert.deepEqual(api.buildChoiceBody(), {})
  assert.deepEqual(
    api.buildChoiceBody({ includePlugins: 'yes', showSleepButton: 1 }),
    {},
    'a non-boolean answer is not sent',
  )
})

/* ------------------------------------------------------------------ *
 * formatRemainingMs — whole seconds, rounded up.
 * ------------------------------------------------------------------ */

test('the countdown is shown in whole seconds, rounded up', () => {
  assert.equal(api.formatRemainingMs(999), 1)
  assert.equal(api.formatRemainingMs(1000), 1)
  assert.equal(api.formatRemainingMs(1001), 2)
  assert.equal(api.formatRemainingMs(10_000), 10)
  assert.equal(api.formatRemainingMs(0), 0)
  assert.equal(api.formatRemainingMs(-5), 0)
  assert.equal(api.formatRemainingMs(Number.NaN), 0)
  assert.equal(api.formatRemainingMs(undefined), 0)
})

/* ------------------------------------------------------------------ *
 * The host half: the standby's last gate must not wait for settleMs.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-ui-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context: it collects the routes and hands out the countdown
 * timer, so the test can drive the seconds one by one.
 */
function createContext() {
  const routes = []
  const timers = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, timers }
}

/** A minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: '/__dsh_autorestart/sleep',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** Call the sleep route and return the parsed answer. */
async function callSleep(routes, method, body) {
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/sleep')
  assert.ok(route, 'the sleep route must be registered')
  const res = fakeResponse()
  route.handler(fakeRequest(method, body), res)
  await settle()
  return JSON.parse(res.body)
}

test('a settle window longer than the countdown never postpones the power-off', async () => {
  const { ctx, routes, timers } = createContext()
  const clockRef = { value: 1_700_000_000_000 }
  const powerOffs = []
  apply(ctx, {
    stateFile: tempStateFile('settle'),
    recoveryDelayMs: 0,
    enabled: true,
    // The restart gate would ask for 15 quiet seconds; the standby counts
    // down for 10 and must NOT wait for them.
    settleMs: 15000,
    // The restart reserve is a different knob (it waits for work this plugin
    // cannot see); this test is about the settle window.
    restartGraceMs: 0,
    sleepCountdownSeconds: 10,
  }, {
    sleepNow: () => clockRef.value,
    sleepSpawn: (command, args) => {
      powerOffs.push({ command, args })
      return { pid: 4242, unref() {} }
    },
  })

  const armed = await callSleep(routes, 'POST', { action: 'arm' })
  assert.equal(armed.phase, 'countdown')
  assert.equal(armed.remainingMs, 10000)

  for (let second = 1; second <= 9; second += 1) {
    clockRef.value += 1000
    for (const timer of timers) {
      if (!timer.disposed && timer.ms === 1000) timer.fn()
    }
  }
  assert.equal((await callSleep(routes, 'GET')).phase, 'countdown')
  assert.equal(powerOffs.length, 0, 'nothing may be closed before the countdown ends')

  clockRef.value += 1000
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
  const done = await callSleep(routes, 'GET')
  assert.equal(done.phase, 'shutting-down', 'the tenth second must close the machine')
  assert.equal(powerOffs.length, 1, 'the machine must be closed exactly once')

  // A few more seconds must not close it again.
  clockRef.value += 5000
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
  assert.equal(powerOffs.length, 1, 'the power-off must not repeat')
})
