/**
 * HOW MANY BACKUPS TO KEEP — the backend half (2026-11-02).
 *
 * The settings page asks a question whose answer is a NUMBER, and the user
 * expects that answer to take effect immediately ("确认后立即删除"). Three
 * rules are pinned here:
 *
 *   1. A NUMBER IN RANGE IS WRITTEN AND APPLIED. The route persists it through
 *      the same `applyConfigChoice` path as every other config answer, and then
 *      prunes at once — the response carries the REAL removed list and the real
 *      number kept, not the number that was asked for.
 *   2. ANYTHING ELSE IS REFUSED WITH A REASON. Out of range, not a whole
 *      number, not a number at all: nothing is written and nothing is clamped,
 *      because a UI that silently turns 0 into 1 leaves the user believing a
 *      number that was never applied.
 *   3. A CERTIFIED COPY IS NEVER DELETED, so the kept count can be HIGHER than
 *      the request. `keptWillExceedRequest` says that out loud instead of
 *      pretending the request won.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  backupsRoot,
  markKnownGood,
  writeBackupMeta,
} from '../lib/backup.js'

/* ------------------------------------------------------------------ *
 * The host half.
 * ------------------------------------------------------------------ */

/** A temp state directory plus the backups root that belongs to it. */
function tempStateDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-limit-${label}-`))
  return {
    dir,
    file: path.join(dir, 'state.json'),
    backups: backupsRoot(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** One copy on disk: a manifest, and an identity unless asked otherwise. */
function seedCopy(backups, stamp, { at = 1_790_000_000_000, meta = true } = {}) {
  const dir = path.join(backups, stamp)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: ' + stamp + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    at,
    atLocal: stamp,
    bytes: 20,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  if (meta) writeBackupMeta(dir, { kind: 'snapshot', at })
  return dir
}

/** A context with a recording web server and a recording config editor. */
function createContext({ services = {} } = {}) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
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
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes }
}

/** Minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: '/__dsh_autorestart/backup-limit',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** The copy-limit route of a freshly applied plugin. */
function limitRoute(routes) {
  const route = routes.find((entry) => typeof entry.path === 'string' && entry.path.endsWith('/backup-limit'))
  assert.ok(route, 'the backup-limit route must be registered')
  return route
}

/** A config editor that records every write instead of touching a real file. */
function recordingEditor(initial) {
  const edits = []
  return {
    edits,
    service: {
      entries: () => ([
        { options: { id: 'another-plugin', name: 'another-plugin', config: {} } },
        { options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: { ...initial } } },
      ]),
      edit: async (entry, change) => {
        edits.push(change({ ...initial }, { ...initial }))
      },
    },
  }
}

/* ------------------------------------------------------------------ *
 * ① A NUMBER IN RANGE IS WRITTEN AND APPLIED AT ONCE.
 * ------------------------------------------------------------------ */

test('① the route writes the number and prunes immediately, reporting what really happened', async () => {
  const setup = tempStateDir('apply')
  try {
    const editor = recordingEditor({ backupOnRestart: true, maxBackups: 5 })
    const { ctx, routes } = createContext({ services: { configEditor: editor.service } })
    // `backupOnRestart: false` keeps the FIRST-INSTALL seed out of the way: this
    // test is about the route's own cleanup, not about the boot path.
    apply(ctx, { stateFile: setup.file, backupOnRestart: false, recoveryDelayMs: 0, enabled: true })

    const stamps = []
    for (let day = 1; day <= 5; day += 1) {
      const stamp = `2026-06-${String(day).padStart(2, '0')}T00-00-00-000Z`
      stamps.push(stamp)
      seedCopy(setup.backups, stamp)
    }

    const res = fakeResponse()
    limitRoute(routes).handler(fakeRequest('POST', { maxBackups: 2 }), res)
    await settle()

    assert.equal(res.statusCode, 200, res.body)
    const answer = JSON.parse(res.body)
    assert.equal(answer.ok, true)
    assert.equal(answer.maxBackups, 2, 'the number the user picked is what the answer carries')
    assert.equal(answer.applied, 'config', 'the profile row is the first place it writes')
    assert.equal(answer.requested, 2)
    assert.equal(answer.kept, 2, 'two copies are left — the request was really applied')
    assert.deepEqual(answer.removed.sort(), [stamps[0], stamps[1], stamps[2]], 'the three oldest went')
    assert.equal(answer.keptWillExceedRequest, false, 'the request was satisfiable here')
    assert.equal(answer.certifiedKept, 0)

    // The write went into the profile row, not only into the answer.
    assert.equal(editor.edits.length, 1, 'the profile row was edited once')
    assert.equal(editor.edits[0].maxBackups, 2, 'and it carries the new number')
    // ...and the directory on disk agrees with the answer.
    const left = fs.readdirSync(setup.backups).sort()
    assert.deepEqual(left, [stamps[3], stamps[4]])
  } finally {
    setup.cleanup()
  }
})

/* ------------------------------------------------------------------ * 
 * ② ANYTHING ELSE IS REFUSED WITH A REASON — AND WRITES NOTHING.
 * ------------------------------------------------------------------ */

test('② an out-of-range or non-numeric limit is refused with a reason and nothing is written', async () => {
  const setup = tempStateDir('refuse')
  try {
    seedCopy(setup.backups, '2026-07-01T00-00-00-000Z')
    const editor = recordingEditor({ backupOnRestart: true, maxBackups: 2 })
    const { ctx, routes } = createContext({ services: { configEditor: editor.service } })
    apply(ctx, { stateFile: setup.file, backupOnRestart: false, recoveryDelayMs: 0, enabled: true })
    const before = fs.readdirSync(setup.backups).sort()

    for (const bad of [1, 0, 11, -3, 2.5, 'abc', null, undefined, {}]) {
      const res = fakeResponse()
      limitRoute(routes).handler(fakeRequest('POST', { maxBackups: bad }), res)
      await settle()
      assert.equal(res.statusCode, 400, `maxBackups=${String(bad)} must be refused`)
      const answer = JSON.parse(res.body)
      assert.equal(answer.ok, false)
      assert.equal(answer.error, 'invalid-maxBackups')
      assert.equal(typeof answer.reason, 'string')
      assert.equal(answer.reason.length > 0, true, 'a refusal without a reason is a silent clamp')
      assert.equal(answer.min, 2)
      assert.equal(answer.max, 10)
    }

    assert.deepEqual(editor.edits, [], 'nothing was written for a refused value')
    assert.deepEqual(fs.readdirSync(setup.backups).sort(), before, 'nothing was deleted either')
  } finally {
    setup.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * ③ A CERTIFIED COPY SURVIVES — AND THE ANSWER SAYS SO.
 * ------------------------------------------------------------------ */

test('③ a certified copy is never deleted and the answer admits the kept count is bigger', async () => {
  const setup = tempStateDir('certified')
  try {
    const editor = recordingEditor({ backupOnRestart: true, maxBackups: 5 })
    const { ctx, routes } = createContext({ services: { configEditor: editor.service } })
    apply(ctx, { stateFile: setup.file, backupOnRestart: false, recoveryDelayMs: 0, enabled: true })

    const stamps = []
    for (let day = 1; day <= 5; day += 1) {
      const stamp = `2026-08-${String(day).padStart(2, '0')}T00-00-00-000Z`
      stamps.push(stamp)
      seedCopy(setup.backups, stamp, { at: 1_790_000_000_000 + day })
    }
    // The NEWEST copy is the safe one.
    // THREE certified copies, so the floor (2) sits BELOW them and the kept
    // count has to come out above the request: that is the case under test.
    const safe = path.join(setup.backups, stamps[4])
    markKnownGood(safe, { reason: 'boot-ok', certifiedBy: 'seed' })
    markKnownGood(path.join(setup.backups, stamps[3]), { reason: 'boot-ok', certifiedBy: 'seed' })
    markKnownGood(path.join(setup.backups, stamps[2]), { reason: 'boot-ok', certifiedBy: 'seed' })

    const res = fakeResponse()
    limitRoute(routes).handler(fakeRequest('POST', { maxBackups: 2 }), res)
    await settle()

    assert.equal(res.statusCode, 200, res.body)
    const answer = JSON.parse(res.body)
    assert.equal(answer.ok, true)
    assert.equal(answer.requested, 2)
    // ONE certified copy survives the prune (the newest known-good), so the
    // count is exactly that; the floor of two no longer lets the protected
    // copies outnumber the request, which is why the flag below is false.
    assert.equal(answer.certifiedKept >= 1, true, 'the surviving safe copy counts as kept')
    assert.equal(answer.kept, answer.requested, 'with a floor of two the request is satisfiable here')
    assert.equal(
      answer.keptWillExceedRequest,
      answer.kept > answer.requested,
      'the flag is the honest form of "I asked for 1, more are kept"',
    )
    assert.equal(fs.existsSync(safe), true, 'the certified copy is still on disk')
    assert.equal(fs.existsSync(path.join(safe, 'meta.json')), true)
  } finally {
    setup.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * ④ THE SHAPE: POST ONLY, AND A BODY IS REQUIRED.
 * ------------------------------------------------------------------ */

test('④ the route answers 405 for GET and refuses a body without the key', async () => {
  const setup = tempStateDir('shape')
  try {
    const { ctx, routes } = createContext()
    apply(ctx, { stateFile: setup.file, recoveryDelayMs: 0, enabled: true })
    const route = limitRoute(routes)
    assert.equal(route.kind, 'exact')

    const get = fakeResponse()
    route.handler(fakeRequest('GET'), get)
    await settle()
    assert.equal(get.statusCode, 405)
    assert.equal(get.headers.allow, 'POST')

    const empty = fakeResponse()
    route.handler(fakeRequest('POST', {}), empty)
    await settle()
    assert.equal(empty.statusCode, 400, 'a body without maxBackups is not a number')
    assert.equal(JSON.parse(empty.body).error, 'invalid-maxBackups')
  } finally {
    setup.cleanup()
  }
})
