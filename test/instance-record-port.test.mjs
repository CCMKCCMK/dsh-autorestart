/**
 * THE INSTANCE RECORD MUST CARRY THE REAL PORT ON A HOST THAT HAS NO
 * `getOrigin()` (2026-11-13, dsh 0.2.0-rc.2).
 *
 * `@deepseek-ai/dsh-host-webserver` declares `get port()` and NOT
 * `getOrigin()`. The plugin read the port out of the origin string only, so on
 * that host `runtime.webPort` stayed 0 and `access.json` was published with
 * `port: 0`.
 *
 * Everything that reads that record then fails, and all of it fails silently
 * until a timeout expires:
 *
 *   - the rollback watcher needs `record.port` before it polls the new
 *     instance, so it never sees the host come back;
 *   - `waitForHealthyInstance` requires `port > 0`, so the in-process
 *     confirmation never succeeds either.
 *
 * Both paths end the same way: the restart is judged FAILED after
 * `rollbackTimeoutMs` (90 s) and the pre-restart snapshot is restored over the
 * live profile — which reverts configuration written after that snapshot, so
 * the configuration the user just added disappears.
 *
 * The tests that cover the restart paths all fake a `webServer` WITH
 * `getOrigin`, which is why none of them ever saw this. These tests fake the
 * real shape instead: `port` only.
 */

import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const ACCESS_FILE = 'access.json'

/** A fresh directory that the plugin may use as its state directory. */
function stateDirectory(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsa-port-${label}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A Cordis context whose `webServer` looks exactly like the shipped one:
 * `register`, `port` and no `getOrigin`.
 *
 * @param {object} options
 * @returns {object} the fake context
 */
function fakeContext({ port = 43210, withGetOrigin = false } = {}) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    port,
  }
  // The broken shape is the DEFAULT here: adding `getOrigin` is the exception,
  // so a future host that drops it again is covered by the same file.
  if (withGetOrigin) webServer.getOrigin = () => `http://127.0.0.1:${port}`
  return {
    ctx: {
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      fiber: { state: 2 },
      agents: { list: () => [], roots: () => [], get: () => undefined },
      goals: { get: () => undefined, resume: () => undefined },
      tools: { register: () => () => {}, guard: () => () => {} },
      on: () => () => {},
      effect: (fn) => {
        fn()
        return () => {}
      },
      interval: () => () => {},
      timeout: () => () => {},
      get: (name) => (name === 'webServer' ? webServer : undefined),
    },
    routes,
    webServer,
  }
}

/** Run `apply` with a state file inside the temporary directory. */
function boot(t, { port = 43210, withGetOrigin = false, label = 'boot' } = {}) {
  const dir = stateDirectory(t, label)
  const stateFile = path.join(dir, 'state.json')
  const fake = fakeContext({ port, withGetOrigin })
  apply(fake.ctx, {
    stateFile,
    restartMode: 'command',
    // No restart is requested here: this file is about the record written at
    // boot, not about executing a restart.
    restartCommand: 'echo no-restart-in-this-test',
    // Keep every watcher out of the way: nothing may be registered or armed.
    autoReloadPage: false,
  })
  return { dir, stateFile, fake }
}

/** Read the instance record, or null when it is not there yet. */
function readAccess(dir) {
  const file = path.join(dir, ACCESS_FILE)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('a host with `port` but no `getOrigin()` publishes its REAL port', (t) => {
  const { dir } = boot(t, { port: 43210, label: 'real-port' })
  const record = readAccess(dir)
  assert.ok(record, 'the instance record was published')
  assert.equal(
    record.port,
    43210,
    'the record carries the bound port (port 0 makes every restart confirmation fail)',
  )
})

test('a host that DOES expose `getOrigin()` still wins over the bare port', (t) => {
  const { dir } = boot(t, { port: 43210, withGetOrigin: true, label: 'origin' })
  const record = readAccess(dir)
  assert.ok(record, 'the instance record was published')
  // `getOrigin()` is the richer source (it also yields the access link), so the
  // fallback must not override a port that was already resolved from it.
  assert.equal(record.port, 43210, 'the origin-derived port is kept')
})

test('the published port is never 0, which no reader can use', (t) => {
  const { dir } = boot(t, { port: 43210, label: 'never-zero' })
  const record = readAccess(dir)
  assert.ok(record, 'the instance record was published')
  assert.notEqual(record.port, 0, 'port 0 means "unknown" to the watcher and the health probe')
  assert.ok(Number(record.port) > 0, 'the record holds a usable port')
})

test('a host that reports port 0 (OS-assigned, not yet known) is not invented', (t) => {
  // `--port 0` lets the OS pick; if the service still reports 0 there is
  // nothing to publish, and pretending a port exists would be worse than
  // saying "unknown" — a wrong port makes the watcher poll someone else.
  const { dir } = boot(t, { port: 0, label: 'unknown' })
  const record = readAccess(dir)
  assert.ok(record, 'the instance record is still written at boot')
  assert.equal(record.port, 0, 'no port is invented')
})
