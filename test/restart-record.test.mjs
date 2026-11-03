/**
 * The durable record of a restart.
 *
 * Three defects of the hosted mode are covered here — each one on BOTH ends
 * of the plugin (the web host `dsh web` and the desktop app), because the
 * same code has to serve both:
 *
 *   1. THE PRE-RESTART SNAPSHOT. Every restart takes one (unless the operator
 *      switched it off), and the record says WHICH snapshot: the directory,
 *      the LOCAL time (the directory name is UTC — that mismatch is what made
 *      a fresh snapshot look like an eight-hour-old leftover), how long it
 *      took and which older snapshots were pruned.
 *
 *   2. THE VERDICT OF THE NEW INSTANCE. The instance that replaced the old one
 *      checks itself (listener / routes / plugin / recovery) and writes the
 *      result into the record — `ok` or `failed`, with the time it verified
 *      itself and how long the restart took. A restart that never came up
 *      stays `pending`, and that is visible too.
 *
 *   3. THE EXTERNAL SUPERVISOR. A host that somebody else supervises
 *      (systemd, pm2, a `supervise-*.sh` script) must be reported as
 *      `external` — with the evidence — so the plugin never replays its own
 *      command next to it (two hosts, one port). And "nothing is known" is
 *      never silently treated as "a bare host".
 *
 * ESM only, Node builtins only.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  apply,
  collectBootChecks,
  createRuntime,
  normalizeConfig,
  takePreRestartSnapshot,
  verifyRestartBoot,
} from '../index.js'
import { requestRestart } from '../lib/checkpoint.js'
import {
  readRestartVerdict,
  RESTART_RESULTS,
  RESTART_VERDICT_FILE,
  writeRestartVerdict,
} from '../lib/restart-verdict.js'
import { supervisorStatus } from '../lib/supervisor.js'
import { detectExternalSupervisor, inspectExternalSupervisor } from '../lib/supervisor-config.js'

const APP_EXE = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

/** A fake Cordis context: enough for the runtime to exist, the tools to register and the routes to be recorded. */
function fakeContext({ origin = 'http://127.0.0.1:5601' } = {}) {
  const logs = []
  const tools = []
  const routes = []
  const timeouts = []
  const record = (level) => (...parts) => {
    logs.push({
      level,
      text: parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '),
    })
  }
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: {
      get: () => undefined,
      disarm: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} }, guard: () => () => {} },
    get: (name) => (name === 'webServer'
      ? {
          register: (route) => { routes.push(route); return () => {} },
          getOrigin: () => origin,
        }
      : undefined),
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    interval: () => () => {},
    timeout: (fn, ms) => { timeouts.push({ fn, ms }); return () => {} },
    provide: () => {},
    emit: () => {},
  }
  return { ctx, logs, tools, routes, timeouts }
}

/** A fake response for the health route. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A profile-looking tree plus the environment that points the host at it. */
function profileFixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-record-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
  const dir = path.join(base, 'state')
  fs.mkdirSync(dir, { recursive: true })
  return { base, profile, dir, file: path.join(dir, 'state.json') }
}

/** The config of a HOSTED host that is restarted by a custom command (`dsh web`). */
function hostedConfig(stateFile, overrides = {}) {
  return normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: '/home/fg/restart-web.sh',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    ...overrides,
  })
}

/** The config of the DESKTOP app (it brings itself back up). */
function desktopConfig(stateFile, overrides = {}) {
  return normalizeConfig({
    stateFile,
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    ...overrides,
  })
}

/**
 * A `/proc` that answers with the given files and ENOENT for everything else.
 *
 * @param {Record<string, string>} entries
 */
function fakeProc(entries) {
  return (file) => {
    const key = String(file)
    if (Object.prototype.hasOwnProperty.call(entries, key)) return entries[key]
    const error = new Error('ENOENT: no such file or directory, open ' + key)
    error.code = 'ENOENT'
    throw error
  }
}

// ---------------------------------------------------------------------------
// 1. THE PRE-RESTART SNAPSHOT — on both ends.
// ---------------------------------------------------------------------------

test('the WEB branch (restartMode: command) takes a snapshot before the restart command runs', async (t) => {
  const { profile, dir, file } = profileFixture(t, 'web-snapshot')
  const fake = fakeContext()
  const commands = []
  const runtime = createRuntime(fake.ctx, hostedConfig(file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => {
      commands.push(command)
      return { ok: true, command, exitCode: 0, timedOut: false }
    },
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-web' })
  await runtime.executeRestart()

  assert.equal(commands.length, 1, 'the restart command ran exactly once')

  // The snapshot is on disk, and it holds the profile.
  const backups = fs.readdirSync(path.join(dir, 'backups'))
  assert.equal(backups.length, 1, 'exactly one snapshot was taken')
  assert.ok(
    fs.existsSync(path.join(dir, 'backups', backups[0], 'config', 'cordis.patch.yml')),
    'the snapshot holds the configuration of the profile',
  )

  // And the record says WHICH snapshot: the directory, the time, the duration.
  const record = readRestartVerdict(dir)
  assert.ok(record, 'the restart record exists')
  assert.equal(record.result, RESTART_RESULTS.OK)
  assert.equal(record.mode, 'command', 'the record says HOW the host is restarted')
  assert.equal(record.snapshot.requested, true)
  assert.equal(record.snapshot.taken, true)
  assert.equal(record.snapshot.stamp, backups[0], 'the record names the snapshot directory')
  assert.equal(record.snapshot.dir, path.join(dir, 'backups', backups[0]))
  assert.ok(Number.isFinite(record.snapshot.at), 'the record carries the time of the snapshot')
  assert.ok(Number.isFinite(record.snapshot.durationMs), 'the record carries how long the snapshot took')
  assert.deepEqual(record.snapshot.pruned, [], 'nothing was pruned (there was only one snapshot)')
  assert.ok(fs.existsSync(path.join(profile, 'cordis.patch.yml')), 'the profile is still there')
})

test('the DESKTOP branch (restartMode: app) takes a snapshot too', async (t) => {
  const { dir, file } = profileFixture(t, 'desktop-snapshot')
  const fake = fakeContext()
  const scheduled = []
  const runtime = createRuntime(fake.ctx, desktopConfig(file), {
    env: { isDesktopApp: true, appExePath: APP_EXE },
    snapshot: (options) => takePreRestartSnapshot(options),
    scheduleDetached: (options) => {
      scheduled.push(options)
      return { ok: true, method: 'test', error: null }
    },
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-desktop' })
  await runtime.executeRestart()

  assert.equal(scheduled.length, 1, 'the detached restart was scheduled exactly once')
  const backups = fs.readdirSync(path.join(dir, 'backups'))
  assert.equal(backups.length, 1, 'the desktop branch takes a snapshot as well')
  const record = readRestartVerdict(dir)
  assert.equal(record.mode, 'app', 'the record says HOW the host is restarted')
  assert.equal(record.snapshot.taken, true)
  assert.equal(record.snapshot.stamp, backups[0])
})

test('the snapshot is switched off ONLY when backupOnRestart is false — and then the record says so', async (t) => {
  const { dir, file } = profileFixture(t, 'no-snapshot')
  const fake = fakeContext()
  const runtime = createRuntime(fake.ctx, hostedConfig(file, { backupOnRestart: false }), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-none' })
  await runtime.executeRestart()

  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'no snapshot was taken')
  const record = readRestartVerdict(dir)
  assert.equal(record.snapshot.requested, false, 'the record says that no snapshot was asked for')
  assert.equal(record.snapshot.taken, false)
})

test('the record carries the LOCAL time of the snapshot (the directory name is UTC)', async (t) => {
  const { dir, file } = profileFixture(t, 'local-time')
  const fake = fakeContext()
  const runtime = createRuntime(fake.ctx, hostedConfig(file), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: (options) => takePreRestartSnapshot(options),
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  requestRestart(runtime.state, { reason: 'test', bySessionId: 'sess-time' })
  await runtime.executeRestart()

  const record = readRestartVerdict(dir)
  assert.match(record.snapshot.stamp, /Z$/, 'the directory name is in UTC')
  assert.ok(record.snapshot.atLocal, 'the record carries the local time as well')
  assert.match(record.snapshot.atLocal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  // The two describe the SAME moment: the offset is the difference between them
  // (the local time has second precision, so a fraction of a second is left).
  const local = new Date(record.snapshot.atLocal)
  assert.ok(
    Math.abs(local.getTime() - record.snapshot.at) < 1000,
    'the local time and the epoch are the same moment',
  )
})

// ---------------------------------------------------------------------------
// 2. THE VERDICT OF THE NEW INSTANCE — on both ends.
// ---------------------------------------------------------------------------

/**
 * The instance that replaces the old one: it reads the pending record, runs
 * the four boot checks and writes the verdict.
 */
async function bootTheNewInstance(t, label, options = {}) {
  const { dir, file } = profileFixture(t, label)
  // THE COPY THE RECORD NAMES REALLY EXISTS (2026-11-02): the report now checks
  // the directory, so a fixture that only names a path would describe a snapshot
  // that is gone — and rightly be reported as such instead of "taken". It has to
  // be a complete copy as well (a manifest and a configuration), or the boot
  // sweep would delete the empty directory as junk.
  const snapshotDir = path.join(dir, 'backups', '2026-10-29T00-25-20-779Z')
  fs.mkdirSync(path.join(snapshotDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(snapshotDir, 'config', 'cordis.patch.yml'), 'rows: []\n', 'utf8')
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify({
    at: Date.now() - 3500,
    atLocal: '2026-10-29T08:25:20+08:00',
    bytes: 10,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  // The old instance wrote the "pending" half before it died.
  writeRestartVerdict(dir, {
    result: RESTART_RESULTS.PENDING,
    mode: options.mode || 'command',
    generation: 4,
    requestedAt: Date.now() - 4000,
    startedAt: Date.now() - 3000,
    previousBootId: 'the-boot-that-was-replaced',
    snapshot: { requested: true, taken: true, dir: snapshotDir, stamp: '2026-10-29T00-25-20-779Z', at: Date.now() - 3500 },
  })
  const fake = fakeContext({ origin: options.origin || 'http://127.0.0.1:5601' })
  apply(fake.ctx, {
    stateFile: file,
    recoveryDelayMs: 0,
    enabled: true,
    ...(options.config || {}),
  })
  // The boot recovery timer is the one of the plugin: it runs the recovery and
  // then the verification of this boot.
  assert.ok(fake.timeouts.length >= 1, 'the boot recovery is scheduled')
  fake.timeouts[0].fn()
  // The verification waits for the web server, so give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 120))
  return { fake, dir, file, record: readRestartVerdict(dir) }
}

test('the new instance writes the verdict of the restart into the durable record', async (t) => {
  const { record } = await bootTheNewInstance(t, 'verdict-ok')
  assert.ok(record, 'the record exists')
  assert.equal(record.result, RESTART_RESULTS.OK, 'the new instance came up cleanly')
  assert.ok(Number.isFinite(record.verifiedAt), 'the record says when it verified itself')
  assert.ok(Number.isFinite(record.durationMs), 'the record says how long the restart took')
  assert.ok(record.durationMs >= 0)
  assert.equal(record.bootId !== null, true, 'the record names the boot that verified itself')
  assert.deepEqual(
    record.checks.map((check) => check.name).sort(),
    ['listener', 'plugin', 'recovery', 'routes'],
    'the four checks are in the record',
  )
  assert.equal(
    record.checks.every((check) => check.ok === true),
    true,
    'every check passed',
  )
})

test('a failed boot check is VISIBLE in the record', async (t) => {
  const { dir, file } = profileFixture(t, 'verdict-failed')
  // The old instance wrote the "pending" half before it died.
  writeRestartVerdict(dir, {
    result: RESTART_RESULTS.PENDING,
    mode: 'command',
    generation: 4,
    startedAt: Date.now() - 3000,
  })
  const fake = fakeContext()
  // A host whose web server never came up: no port, no routes.
  const runtime = createRuntime(fake.ctx, hostedConfig(file), {
    env: { isDesktopApp: false, appExePath: null },
  })
  runtime.recovery = { ran: true, ok: true, detail: 'the boot recovery finished' }
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 })
  assert.ok(record, 'the record exists')
  assert.equal(record.result, RESTART_RESULTS.FAILED, 'the verdict is not silently "ok"')
  const failed = record.checks.filter((check) => check.ok !== true).map((check) => check.name)
  assert.ok(failed.includes('listener'), 'the failed check is named')
  assert.ok(failed.includes('routes'), 'the missing routes are named')
  assert.match(String(record.reason), /failed/)
})

test('a restart that never came up stays "pending" — and that is visible', async (t) => {
  const { dir, file } = profileFixture(t, 'verdict-pending')
  writeRestartVerdict(dir, {
    result: RESTART_RESULTS.PENDING,
    mode: 'command',
    generation: 4,
    startedAt: Date.now() - 90_000,
    snapshot: { requested: true, taken: true, stamp: '2026-10-29T00-25-20-779Z', at: Date.now() - 95_000 },
  })
  const fake = fakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const record = readRestartVerdict(dir)
  assert.equal(record.result, RESTART_RESULTS.PENDING, 'a restart nobody confirmed stays pending')
  assert.equal(record.verifiedAt, null, 'nobody verified it')
})

test('the verdict is readable from the health route and from continuum_status', async (t) => {
  const { fake, record } = await bootTheNewInstance(t, 'verdict-readable')
  assert.equal(record.result, RESTART_RESULTS.OK)

  // (a) the health route
  const res = fakeResponse()
  fake.routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.ok(payload.lastRestart, 'the health route reports the last restart')
  assert.equal(payload.lastRestart.result, RESTART_RESULTS.OK)
  assert.equal(payload.lastRestart.snapshot.stamp, '2026-10-29T00-25-20-779Z')
  assert.ok(Array.isArray(payload.lastRestart.checks))
  assert.equal(payload.lastRestart.checks.length, 4)

  // (b) the status tool
  const status = fake.tools.find((tool) => tool.name === 'continuum_status')
  assert.ok(status, 'continuum_status is registered')
  const answer = status.execute({})
  assert.ok(answer.lastRestart, 'continuum_status reports the last restart')
  assert.equal(answer.lastRestart.result, RESTART_RESULTS.OK)
  assert.equal(answer.lastRestart.snapshot.taken, true)
})

test('the four boot checks report what they looked at', () => {
  const checks = collectBootChecks({
    webPort: 5601,
    registeredRoutes: ['health', 'park'],
    routeErrors: [],
    bootId: 'boot-1',
    toolErrors: [],
    recovery: { ran: true, ok: true, detail: 'the boot recovery finished' },
  })
  assert.equal(checks.length, 4)
  assert.equal(checks.every((check) => check.ok === true), true)
  assert.match(checks[0].detail, /5601/)
  assert.match(checks[1].detail, /2 route/)
  assert.match(checks[3].detail, /recovery/)

  const broken = collectBootChecks({
    webPort: 0,
    registeredRoutes: [],
    routeErrors: [{ route: 'health', error: 'boom' }],
    bootId: '',
    toolErrors: [{ tool: 'continuum_restart', error: 'boom' }],
    recovery: null,
  })
  assert.equal(broken.every((check) => check.ok === false), true, 'every broken thing is reported')
})

// ---------------------------------------------------------------------------
// 3. THE EXTERNAL SUPERVISOR — Linux (with /proc) and Windows (without).
// ---------------------------------------------------------------------------

test('a parent that is a supervise-*.sh script IS an external supervisor', () => {
  const found = detectExternalSupervisor({
    env: {},
    platform: 'linux',
    ppid: 1300018,
    readFileSync: fakeProc({
      '/proc/1300018/cmdline': '/bin/bash\0/home/fg/supervise-web.sh',
      '/proc/1300018/status': 'Name:\tbash\nPPid:\t1300010\n',
    }),
  })
  assert.ok(found, 'the supervisor is found')
  assert.equal(found.kind, 'script')
  assert.equal(found.evidence, 'parent:1300018')
  assert.match(found.commandLine, /supervise-web\.sh/)
})

test('the supervisor is found even when it is the GRANDPARENT', () => {
  const found = detectExternalSupervisor({
    env: {},
    platform: 'linux',
    ppid: 4242,
    readFileSync: fakeProc({
      '/proc/4242/cmdline': '/usr/bin/node\0/bin/dsh\0web',
      '/proc/4242/status': 'Name:\tnode\nPPid:\t4241\n',
      '/proc/4241/cmdline': '/bin/bash\0/home/fg/supervise-web.sh',
      '/proc/4241/status': 'Name:\tbash\nPPid:\t1\n',
    }),
  })
  assert.ok(found, 'the supervisor is found')
  assert.equal(found.kind, 'script')
  assert.equal(found.evidence, 'ancestor:4241', 'the evidence names the ancestor')
})

test('the status of a host that somebody else supervises says "external" and refuses the self-replay', (t) => {
  const { dir } = profileFixture(t, 'external')
  const status = supervisorStatus({
    stateDir: dir,
    env: {},
    platform: 'linux',
    mode: 'auto',
    ppid: 1300018,
    inspectExternal: () => inspectExternalSupervisor({
      env: {},
      platform: 'linux',
      ppid: 1300018,
      readFileSync: fakeProc({
        '/proc/1300018/cmdline': '/bin/bash\0/home/fg/supervise-web.sh',
        '/proc/1300018/status': 'Name:\tbash\nPPid:\t1300010\n',
      }),
    }),
  })
  assert.equal(status.mode, 'external', 'the host is supervised by somebody else')
  assert.equal(status.restartCapable, true, 'the external supervisor brings the host back')
  assert.equal(status.selfReplay, 'refused', 'the plugin must NOT start a second copy')
  assert.ok(status.external, 'the evidence is reported')
  assert.equal(status.external.kind, 'script')
  assert.equal(status.external.evidence, 'parent:1300018')
  assert.match(status.reason, /external supervisor/)
})

test('a host whose supervisor cannot be identified is NOT silently a bare host', (t) => {
  const { dir } = profileFixture(t, 'unknown')
  const status = supervisorStatus({
    stateDir: dir,
    env: {},
    // Windows: there is no /proc, so nobody can be read.
    platform: 'win32',
    mode: 'auto',
    inspectExternal: () => inspectExternalSupervisor({ env: {}, platform: 'win32' }),
  })
  assert.equal(status.mode, 'unknown')
  assert.equal(status.selfReplay, 'unknown', 'the plugin does not claim it may replay itself')
  assert.equal(status.restartCapable, false, 'nothing guarantees that the host comes back')
  assert.match(status.reason, /could not be established/)
  assert.ok(status.detail.externalReason, 'the reason why nobody could be identified is reported')
})

test('the plugin does not offer its own supervisor while an external one is in charge', (t) => {
  const { dir, file } = profileFixture(t, 'offer')
  const fake = fakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, supervisorMode: 'auto' })
  const res = fakeResponse()
  fake.routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, res)
  const payload = JSON.parse(res.body)
  assert.ok(payload.supervisor, 'the supervisor status is reported')
  assert.ok(
    ['unknown', 'external', 'installed', 'off'].includes(payload.supervisor.mode),
    'the mode is one of the known ones',
  )
  assert.notEqual(payload.supervisor.selfReplay, 'allowed', 'an unidentified host is never a free replay')
})

test('the restart record file has a fixed, readable name', (t) => {
  const { dir } = profileFixture(t, 'name')
  writeRestartVerdict(dir, { result: RESTART_RESULTS.PENDING })
  assert.ok(
    fs.existsSync(path.join(dir, RESTART_VERDICT_FILE)),
    'the record lives in a fixed, known place',
  )
  assert.equal(RESTART_VERDICT_FILE, 'last-restart-verdict.json')
})

// ---------------------------------------------------------------------------
// 4. THE BROWSER SIDE: no install entry where it would cause a double start.
// ---------------------------------------------------------------------------

/** The client script, evaluated the way the browser evaluates it. */
function loadClient() {
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
      createElement: (tag) => ({
        tag, id: '', textContent: '', parentNode: null,
        setAttribute: () => {}, appendChild: () => {},
      }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
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

test('the browser side does not offer a supervisor where a second one would fight over the port', () => {
  const api = loadClient()
  assert.ok(api, 'the client publishes its helpers')
  const can = api.canOfferSupervisorInstall

  // The hosted host without any supervisor: the entry IS offered.
  assert.equal(can({ mode: 'unknown', installed: false }, { isDesktopApp: false }), true)

  // The desktop app brings itself back up: nothing to install.
  assert.equal(can({ mode: 'unknown', installed: false }, { isDesktopApp: true }), false)

  // Somebody else supervises the host: a second supervisor would fight over
  // the port, so it is NOT offered.
  assert.equal(can({ mode: 'external', installed: false }, { isDesktopApp: false }), false)

  // The automatic restart is switched off: nothing to install either.
  assert.equal(can({ mode: 'off', installed: false }, { isDesktopApp: false }), false)

  // A supervisor of this plugin IS installed: removing it must stay possible.
  assert.equal(can({ mode: 'installed', installed: true }, { isDesktopApp: true }), true)

  // THE STARTUP MATRIX has the final word: a host whose starter could not be
  // established gets NOTHING (the plugin would rather say "I cannot tell"
  // than start a second host).
  assert.equal(
    can({ mode: 'unknown', installed: false, startup: { mode: 'unknown', canInstallSupervisor: false } }, { isDesktopApp: false }),
    false,
  )

  // A bare host (nobody manages it) may get the supervisor.
  assert.equal(
    can({ mode: 'unknown', installed: false, startup: { mode: 'bare', canInstallSupervisor: true } }, { isDesktopApp: false }),
    true,
  )

  // The Host says nothing: the answer is "no" (never a silent "yes").
  assert.equal(can(null, null), false)
})
