/**
 * B (the dry run) at the route level.
 *
 * The contract is a promise to the user:
 *
 *   - the dry run shows what WOULD be written and writes NOTHING;
 *   - only an EXPLICIT confirmation writes it;
 *   - the undo puts the previous values back.
 *
 * The tests prove it with the configEditor stand-in: it records every edit of
 * the plugin's row, so "nothing was written" is an assertion, not a promise.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const SUPERVISOR_PATH = '/__dsh_autorestart/supervisor'

/**
 * A temporary state file (the plugin writes its checkpoint there).
 *
 * IT RETURNS AN OBJECT, AND THAT MATTERS (2026-11-03): callers destructure
 * `const { file } = tempStateFile(...)`, so returning a bare string handed them
 * `undefined` - `stateFile` then fell back to the DEFAULT one, which is the machine's
 * real `.dsh/storages/dsh-autorestart/state.json`. That is how a test run rewrote the
 * user's own `access.json` / `watchdog-ready.json` with the fake port 1234.
 */
function tempStateFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-derive-'))
  return { dir, file: path.join(dir, name + '.json') }
}

/** A fake Cordis context that records the routes. */
function createContext({ services = {}, row = {} } = {}) {
  const routes = []
  const warnings = []
  const edits = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const configEditor = {
    entries: () => ([{ options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: { ...row } } }]),
    edit: async (entry, change) => {
      edits.push({ rowId: entry && entry.options ? entry.options.id : null, next: change({ ...row }, {}) })
    },
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'configEditor') return configEditor
      return services[name]
    },
  }
  return { ctx, routes, warnings, edits }
}

/** Minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request with a JSON body. */
function fakeRequest(body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    url: SUPERVISOR_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * Make this process look like a HOSTED host for the duration of a test.
 *
 * The derivation reads the LIVE command line and the LIVE environment of the
 * running process:
 *
 *   - a hosted host is started as `dsh web --port <port> --no-open`;
 *   - a hosted host carries NEITHER the Electron marker of the desktop app nor
 *     the desktop profile.
 *
 * The suite itself often runs INSIDE the desktop app (its process is a child of
 * the Electron shell), so the markers are dropped here. Otherwise the
 * derivation would — correctly — answer `desktop-app` ("the desktop app
 * restarts itself, there is no command to write") and there would be nothing
 * to write.
 *
 * The executable itself is NOT touched: the desktop app is recognised by the
 * FILE NAME of the executable, so the node the app ships (whose PATH mentions
 * the app) is a hosted host like any other.
 */
function withHostedHost(t) {
  const savedArgv = process.argv
  const savedEnv = {}
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.argv = [process.execPath, '/opt/dsh/lib/bin.js', 'web', '--port', '1234', '--no-open']
  t.after(() => {
    process.argv = savedArgv
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function supervisorRoute(routes) {
  const route = routes.find((entry) => entry.path === SUPERVISOR_PATH)
  assert.ok(route, `the supervisor route ${SUPERVISOR_PATH} must be registered`)
  return route
}

/** Apply the plugin and post one body to the supervisor route. */
async function post(routes, body) {
  const res = fakeResponse()
  supervisorRoute(routes).handler(fakeRequest(body), res)
  await settle()
  return res
}

test('the dry run shows the plan and writes NOTHING', async (t) => {
  withHostedHost(t)
  const { file } = tempStateFile('dry-run')
  const { ctx, routes, edits } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = await post(routes, { action: 'dry-run' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'dry-run')
  assert.ok(payload.plan, 'the plan is there')
  assert.ok(Array.isArray(payload.plan.plan), 'the plan carries its lines')
  assert.notEqual(payload.plan.reason, 'desktop-app', 'a hosted host is not the desktop app')
  assert.equal(edits.length, 0, 'the dry run writes no configuration')
})

test('the dry run needs NO confirmation, the writing does', async () => {
  const { file } = tempStateFile('confirm')
  const { ctx, routes, edits } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  // Without the confirmation the Host refuses.
  const refused = await post(routes, { action: 'apply' })
  assert.equal(refused.statusCode, 400)
  assert.equal(JSON.parse(refused.body).error, 'confirmation-required')
  assert.equal(edits.length, 0, 'nothing was written without the confirmation')

  const refusedRevert = await post(routes, { action: 'revert' })
  assert.equal(refusedRevert.statusCode, 400)
  assert.equal(edits.length, 0, 'the undo needs a confirmation too')
})

test('the confirmation writes the derived command into the profile configuration', async (t) => {
  // The derivation reads the LIVE command line and the LIVE environment of the
  // running host: the test therefore presents the ones a real hosted host has
  // (`dsh web --port <port> --no-open`, and none of the desktop markers).
  withHostedHost(t)
  const { file } = tempStateFile('apply')
  const { ctx, routes, edits } = createContext({
    row: { restartMode: 'command', restartCommand: 'the-old-command' },
  })
  apply(ctx, {
    stateFile: file,
    recoveryDelayMs: 0,
    enabled: true,
    // The values that are in effect NOW: they are what the undo puts back.
    restartMode: 'command',
    restartCommand: 'the-old-command',
  })

  const res = await post(routes, { action: 'apply', confirmed: true })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(edits.length, 1, 'the configuration was written exactly once')
  assert.equal(edits[0].rowId, 'dsh-autorestart')
  assert.equal(edits[0].next.restartMode, 'command')
  assert.ok(
    typeof edits[0].next.restartCommand === 'string' && edits[0].next.restartCommand !== '',
    'a restart command was written',
  )
  // The values that were in effect before are remembered: that is what the
  // undo puts back.
  assert.equal(payload.previous.restartCommand, 'the-old-command')
})

test('the undo puts the previous command back', async (t) => {
  // Same reason as the test above: the live command line and environment must
  // look like a real hosted host, otherwise the derivation refuses.
  withHostedHost(t)
  const { file } = tempStateFile('revert')
  const { ctx, routes, edits } = createContext({
    row: { restartMode: 'command', restartCommand: 'the-old-command' },
  })
  apply(ctx, {
    stateFile: file,
    recoveryDelayMs: 0,
    enabled: true,
    restartMode: 'command',
    restartCommand: 'the-old-command',
  })

  // First the command is written...
  const applied = await post(routes, { action: 'apply', confirmed: true })
  assert.equal(applied.statusCode, 200)
  assert.equal(edits.length, 1)

  // ...and then the undo puts the old one back.
  const reverted = await post(routes, { action: 'revert', confirmed: true })
  assert.equal(reverted.statusCode, 200)
  assert.equal(edits.length, 2)
  assert.equal(edits[1].next.restartCommand, 'the-old-command')
  assert.equal(edits[1].next.restartMode, 'command')
})

test('the supervisor route still answers the plain status', async () => {
  const { file } = tempStateFile('status')
  const { ctx, routes, edits } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = await post(routes, { action: 'status' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.supervisor, 'the supervisor status is there')
  assert.equal(edits.length, 0)
})
