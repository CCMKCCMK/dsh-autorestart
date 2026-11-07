/**
 * THE LEFTOVERS OF AN OLDER BUILD — ASKED ONCE, GONE FOR GOOD (2026-11-06).
 *
 * WHAT THIS FILE PINS DOWN:
 *
 *   1. THE SCAN COUNTS ONLY THE LEFTOVERS: a directory without a
 *      `manifest.json` is a copy that never finished. A directory WITH one is
 *      a backup, and the cleanup never touches it.
 *   2. THE STATE MACHINE OF THE QUESTION — three states, one card:
 *        · no marker + leftovers → the boot sweep leaves them ALONE (the card
 *          needs them to count them) and the card can be drawn;
 *        · 「清理掉」 → the leftovers go, the marker is written, the card is
 *          gone for good;
 *        · 「我自己处理」 → the marker is written, the card never comes back,
 *          and the boot sweep never touches those directories again.
 *   3. THE HOST DOES NOT PAY FOR THE CARD ON EVERY MOUNT: after the answer,
 *      a GET must not walk the leftover tree at all (not one stat of a file).
 *   4. THE DELETE HAPPENS OUTSIDE THE REQUEST: the click is answered at once
 *      and the receipt comes with a later GET.
 *   5. NOTHING IS LEFT ON THE SCREEN: the settings page gains NO entry and NO
 *      banner for this — the problem must disappear with the answer.
 *   6. THE CLI AND THE CARD SHARE THE CODE: `scripts/cleanup-shell-backups.mjs`
 *      reports the same numbers with `--dry-run`, and the real run removes
 *      exactly that many directories.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { spawn } from 'node:child_process'

import { apply, seedFirstInstallBackup } from '../index.js'
import {
  cleanupShellBackups,
  MANIFEST_NAME,
  scanShellBackups,
  shellBackupsHandled,
  shellBackupsHandledAction,
  shellBackupsMayBeSwept,
  markShellBackupsHandled,
  SHELL_BACKUPS_MARKER,
} from '../lib/backup.js'
import { parseArgs, run as runCleanup, formatSize } from '../scripts/cleanup-shell-backups.mjs'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A state directory with a backups root in it. */
function tempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-shell-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(backups, { recursive: true })
  return { dir, backups }
}

/**
 * A LEFTOVER: a directory with no manifest, only the link tree.
 *
 * `aged` makes it OLDER than the boot sweep's age gate (120 s) — without it
 * the sweep would keep the directory anyway ("a writer may be filling it right
 * now") and the test would prove nothing.
 */
function makeLeftover(backups, name, bytes = 128, aged = false) {
  const dir = path.join(backups, name, 'node_modules-link', 'some-plugin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), 'x'.repeat(bytes), 'utf8')
  if (aged) {
    const old = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(path.join(backups, name), old, old)
  }
  return path.join(backups, name)
}

/** A REAL COPY: it has a manifest, so nothing may ever delete it here. */
function makeCopy(backups, name) {
  const dir = path.join(backups, name)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'a: 1\n', 'utf8')
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ at: 1, files: [] }), 'utf8')
  return dir
}

/* ------------------------------------------------------------------ *
 * ① THE SCAN AND THE CLEANUP (the shared core)
 * ------------------------------------------------------------------ */

test('① the scan counts the leftovers and leaves the copies alone', (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200)
  const copy = makeCopy(setup.backups, '2026-11-03T10-00-00-000Z')

  const scan = scanShellBackups(setup.backups)

  assert.equal(scan.count, 2, 'the two leftovers are counted')
  assert.deepEqual(scan.names, ['2026-11-01T10-00-00-000Z', '2026-11-02T10-00-00-000Z'])
  assert.equal(scan.bytes, 300, 'and their size is added up')
  assert.equal(scan.names.includes('2026-11-03T10-00-00-000Z'), false, 'a copy is not a leftover')
  assert.equal(fs.existsSync(copy), true, 'the copy is still there')
})

test('① the scan can count WITHOUT measuring (the cheap way)', (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200)

  const scan = scanShellBackups(setup.backups, { measure: false })

  assert.equal(scan.count, 2, 'the count is the same')
  assert.equal(scan.bytes, null, 'but the size is not measured')
  assert.equal(scan.truncated, false)
})

test('① the cleanup deletes the leftovers and NOT ONE copy', (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z')
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z')
  const copy = makeCopy(setup.backups, '2026-11-03T10-00-00-000Z')

  const result = cleanupShellBackups(setup.backups)

  assert.equal(result.removed.length, 2, 'the two leftovers are gone')
  assert.deepEqual(result.failures, [], 'and nothing failed')
  assert.equal(fs.existsSync(copy), true, 'the copy with a manifest is untouched')
  assert.equal(scanShellBackups(setup.backups).count, 0, 'and a second scan finds nothing')
})

test('① a leftover with a READ-ONLY file in it is really deleted', (t) => {
  const setup = tempState(t)
  const leftover = makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z')
  const png = path.join(leftover, 'node_modules-link', 'some-plugin', 'logo.png')
  fs.writeFileSync(png, 'x'.repeat(64), 'utf8')
  fs.chmodSync(png, 0o444)

  const result = cleanupShellBackups(setup.backups)

  assert.equal(result.removed.length, 1, 'the leftover is gone')
  assert.deepEqual(result.failures, [], 'and nothing failed')
  assert.equal(fs.existsSync(leftover), false, 'the whole tree is gone, not only its first half')
})

test('① a directory that will NOT delete is reported with its reason', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the lock this test uses is a Windows behaviour')
    return
  }
  const setup = tempState(t)
  const leftover = makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z')
  // A child process that lives IN the directory: on Windows that directory
  // cannot be removed while the process is in it.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    cwd: leftover,
    stdio: 'ignore',
  })
  t.after(() => { try { child.kill() } catch {} })
  await new Promise((resolve) => { setTimeout(resolve, 500) })

  const result = cleanupShellBackups(setup.backups)

  assert.deepEqual(result.removed, [], 'nothing was removed')
  assert.equal(result.failures.length, 1, 'and the failure is reported: ' + JSON.stringify(result.failures))
  assert.equal(result.failures[0].name, '2026-11-01T10-00-00-000Z', 'the directory is named')
  assert.ok(String(result.failures[0].error).length > 0, 'with the reason why')
  assert.equal(fs.existsSync(leftover), true, 'and it really is still on disk')

  child.kill()
  await new Promise((resolve) => { setTimeout(resolve, 300) })
})

test('① the marker remembers what the user chose, and survives a restart', (t) => {
  const setup = tempState(t)
  assert.equal(shellBackupsHandled(setup.dir), false, 'nothing is remembered yet')
  assert.equal(shellBackupsHandledAction(setup.dir), null, 'and no answer is on record')
  assert.equal(shellBackupsMayBeSwept(setup.dir), false, 'so the plugin may not delete them')

  const written = markShellBackupsHandled(setup.dir, 'self')

  assert.equal(written, true, 'the marker was written')
  assert.equal(shellBackupsHandled(setup.dir), true, 'and it is remembered')
  assert.equal(shellBackupsHandledAction(setup.dir), 'self', 'together with the answer')
  assert.equal(shellBackupsMayBeSwept(setup.dir), false, '"I will handle them" means: do not touch them')
  assert.equal(
    fs.existsSync(path.join(setup.dir, SHELL_BACKUPS_MARKER)),
    true,
    'the marker is a file in the state directory — it survives a restart of the Host',
  )

  // 「清理掉」 is a consent to delete them.
  markShellBackupsHandled(setup.dir, 'clean')
  assert.equal(shellBackupsMayBeSwept(setup.dir), true, 'after "delete them" the plugin may clean them')
})

/* ------------------------------------------------------------------ *
 * ② THE ROUTE: what the client asks
 * ------------------------------------------------------------------ */

/** A context with a recording web server. */
function createContext() {
  const routes = []
  const webServer = {
    register: (route) => { routes.push(route); return () => {} },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: '/__dsh_autorestart/shell-backups',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
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

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Wait until something is true (the background cleanup needs a moment). */
async function settleUntil(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate() === true) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate() === true
}

/** The plugin with its routes, on a state directory of our own. */
function pluginWith(t, setup) {
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: path.join(setup.dir, 'state.json'),
    backupOnRestart: false,
    recoveryDelayMs: 0,
    enabled: true,
  })
  const route = routes.find((entry) => typeof entry.path === 'string' && entry.path.endsWith('/shell-backups'))
  assert.ok(route, 'the shell-backups route must be registered')
  return route
}

/** Ask the route and read the answer. */
async function ask(route, method, body) {
  const res = fakeResponse()
  route.handler(fakeRequest(method, body), res)
  await settle()
  return JSON.parse(res.body)
}

test('② the card is only for a machine that has something to decide', async (t) => {
  const setup = tempState(t)
  const route = pluginWith(t, setup)

  // NOTHING LEFT OVER: no card, no entry, nothing.
  const nothing = await ask(route, 'GET')
  assert.equal(nothing.pending, false, 'a machine without leftovers is never asked')
  assert.equal(nothing.count, 0)

  // TWO LEFTOVERS: now there is something to say.
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200)
  const answer = await ask(route, 'GET')
  assert.equal(answer.pending, true, 'the card appears')
  assert.equal(answer.count, 2, 'with the number of leftovers')
  assert.equal(answer.bytes, 300, 'and their size')
})

test('③ STATE 1 — nobody has answered: the boot sweep leaves the leftovers ALONE', async (t) => {
  const setup = tempState(t)
  // OLD leftovers: without the age gate the boot sweep would keep them anyway
  // and this test would prove nothing.
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100, true)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200, true)

  const route = pluginWith(t, setup)

  const after = scanShellBackups(setup.backups)
  assert.equal(after.count, 2, 'the boot sweep deleted nothing: the card needs them to count them')
  const answer = await ask(route, 'GET')
  assert.equal(answer.pending, true, 'and the card can be drawn')
  assert.equal(answer.count, 2, 'with the real number')
})

test('④ STATE 2 — 「清理掉」: the leftovers go, the marker is written, the card is gone', async (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100, true)
  const route = pluginWith(t, setup)

  const answer = await ask(route, 'POST', { action: 'clean' })

  assert.equal(answer.ok, true, 'the answer is accepted')
  assert.equal(answer.started, true, 'and the delete started')
  assert.equal(answer.pending, false, 'the question is closed at once')
  assert.equal(shellBackupsHandled(setup.dir), true, 'the marker is written: the answer is final')
  assert.equal(shellBackupsHandledAction(setup.dir), 'clean', 'and it says what was chosen')

  await settleUntil(() => scanShellBackups(setup.backups).count === 0)
  assert.equal(scanShellBackups(setup.backups).count, 0, 'the leftovers are gone')

  const after = await ask(route, 'GET')
  assert.equal(after.pending, false, 'the card never comes back')
  assert.equal(after.cleanup.state, 'done', 'and the job says it is finished')
  assert.equal(after.cleanup.removed, 1, 'the receipt names what was removed')
})

test('⑤ STATE 3 — 「我自己处理」: the boot sweep never touches them again', async (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100, true)
  const route = pluginWith(t, setup)

  const answer = await ask(route, 'POST', { action: 'self' })
  assert.equal(answer.ok, true)
  assert.equal(answer.handled, true, 'the answer was recorded')
  assert.equal(shellBackupsHandled(setup.dir), true, 'the marker is on disk — it survives a restart')
  // THE LEFTOVERS ARE STILL THERE: the user took over, nothing was deleted.
  assert.equal(fs.existsSync(path.join(setup.backups, '2026-11-01T10-00-00-000Z')), true)

  // AND THE CARD IS GONE — even though the leftovers are still on disk.
  const after = await ask(route, 'GET')
  assert.equal(after.pending, false, 'the question is never asked again')
  assert.equal(after.handled, true, 'and the answer is still remembered')

  // AND THE NEXT BOOT DOES NOT DELETE THEM: the user took over.
  const rebooted = pluginWith(t, setup)
  const still = scanShellBackups(setup.backups)
  assert.equal(still.count, 1, 'the boot sweep deleted nothing: "I will handle them" means that')
  const again = await ask(rebooted, 'GET')
  assert.equal(again.pending, false, 'and the card is still gone')
})

test('⑥ the GET after the answer does NOT walk the leftover tree', async (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  const route = pluginWith(t, setup)

  // COUNT THE STATS: `fs.statSync` is the call that walks a file tree. The
  // module object is shared, so the count is exact.
  const original = fs.statSync
  let stats = 0
  fs.statSync = (...args) => { stats += 1; return original(...args) }
  try {
    const before = await ask(route, 'GET')
    assert.equal(before.pending, true, 'the question is open')
    assert.ok(stats > 0, 'while the question is open, the size IS measured (' + stats + ' stats)')

    await ask(route, 'POST', { action: 'self' })

    stats = 0
    const after = await ask(route, 'GET')
    assert.equal(after.pending, false, 'the question is closed')
    assert.equal(after.count, 1, 'the count is still right')
    assert.equal(after.bytes, null, 'and the size is not measured any more')
    assert.equal(stats, 0, 'NOT ONE stat of a file: the leftover tree was not walked')
  } finally {
    fs.statSync = original
  }
})

test('⑦ the delete happens OUTSIDE the request: the click is answered at once', async (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 100)
  const route = pluginWith(t, setup)

  const answer = await ask(route, 'POST', { action: 'clean' })

  assert.equal(answer.ok, true)
  assert.equal(answer.cleanup.state, 'running', 'the answer goes out while the delete is still running')
  assert.equal(answer.cleanup.total, 2, 'and it knows how many there are')
  assert.equal(answer.removed, undefined, 'the receipt is NOT in this answer')

  // THE RECEIPT COMES WITH A LATER GET.
  await settleUntil(() => scanShellBackups(setup.backups).count === 0)
  const receipt = await ask(route, 'GET')
  assert.equal(receipt.cleanup.state, 'done', 'the job is finished')
  assert.equal(receipt.cleanup.removed, 2, 'and the receipt says what was removed')
  assert.equal(receipt.cleanup.failures.length, 0, 'and that nothing failed')
  assert.equal(scanShellBackups(setup.backups).count, 0, 'and the leftovers are gone')
})

test('⑦ an unknown action is refused and nothing is deleted', async (t) => {
  const setup = tempState(t)
  const leftover = makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  const route = pluginWith(t, setup)

  const answer = await ask(route, 'POST', { action: 'rm -rf /' })

  assert.equal(answer.ok, false)
  assert.equal(answer.error, 'unknown-action')
  assert.equal(fs.existsSync(leftover), true, 'nothing was deleted')
})

/* ------------------------------------------------------------------ *
 * ⑧ THE CLI SCRIPT: the same numbers, the same code
 * ------------------------------------------------------------------ */

test('⑧ the script takes ONE flag, and no path at all', () => {
  const dry = parseArgs(['--dry-run'])
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)

  const plain = parseArgs([])
  assert.equal(plain.ok, true)
  assert.equal(plain.dryRun, false)

  const path = parseArgs(['/some/where'])
  assert.equal(path.ok, false, 'a path argument is refused: this script deletes directories')
  assert.match(String(path.error), /unknown argument/)
})

test('⑧ --dry-run reports the numbers and deletes nothing', (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200)
  const copy = makeCopy(setup.backups, '2026-11-03T10-00-00-000Z')

  const lines = []
  const result = runCleanup({ dryRun: true, stateDir: setup.dir, log: (line) => lines.push(line) })

  assert.equal(result.count, 2, 'the same number the card would show')
  assert.equal(result.bytes, 300, 'and the same size')
  assert.equal(result.removed.length, 2, 'the dry run names what WOULD go')
  assert.equal(fs.existsSync(path.join(setup.backups, '2026-11-01T10-00-00-000Z')), true, 'but nothing was deleted')
  assert.equal(fs.existsSync(copy), true, 'and the copy is untouched')
  assert.ok(lines.some((line) => line.includes('2 directories')), 'the numbers are printed: ' + lines.join(' | '))
})

test('⑧ the real run removes exactly what the dry run reported, and a second scan is 0', (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  makeLeftover(setup.backups, '2026-11-02T10-00-00-000Z', 200)
  const copy = makeCopy(setup.backups, '2026-11-03T10-00-00-000Z')

  const dry = runCleanup({ dryRun: true, stateDir: setup.dir })
  const real = runCleanup({ dryRun: false, stateDir: setup.dir })

  assert.equal(real.removed.length, dry.removed.length, 'the dry run and the real run agree')
  assert.equal(real.removed.length, 2)
  assert.deepEqual(real.failures, [], 'and nothing failed')
  assert.equal(scanShellBackups(setup.backups).count, 0, 'a second scan finds nothing')
  assert.equal(fs.existsSync(copy), true, 'the copy with a manifest is still there')
})

test('⑧ the size is printed with the unit that fits it', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2 KB')
  assert.equal(formatSize(5 * 1024 * 1024), '5 MB')
  assert.equal(formatSize(23966.9 * 1024 * 1024), '23.4 GB')
})

/* ------------------------------------------------------------------ *
 * ⑨ NOTHING IS LEFT ON THE SCREEN
 * ------------------------------------------------------------------ */

test('⑨ the settings page gains NO entry and NO banner for the leftovers', async (t) => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const dictionaries = loadDictionaries(source)
  const settingsKeys = Object.keys(dictionaries.zh).filter((key) => key.startsWith('settings.'))
  const forbidden = settingsKeys.filter((key) => /shell|leftover|residual|cleanup|清理|残留/i.test(key))
  assert.deepEqual(forbidden, [], 'the settings page has no leftover/cleanup entry')

  // AND THE CARD IS A DOCK PANEL, NOT A SETTINGS SECTION.
  assert.ok(
    source.includes("id: 'autorestart-shell-backups'"),
    'the card is registered in the composer dock',
  )
  assert.equal(
    /settings\.section[\s\S]{0,400}autorestart-shell-backups/.test(source),
    false,
    'and it is not a settings section',
  )
})

/**
 * The two dictionaries of the client, read the way the browser evaluates it.
 *
 * @param {string} source
 * @returns {{ zh: Record<string, string>, en: Record<string, string> }}
 */
function loadDictionaries(source) {
  const zhStart = source.indexOf('const ZH = {')
  const enStart = source.indexOf('const EN = {')
  assert.ok(zhStart > 0 && enStart > zhStart, 'the dictionaries are in the client')
  const zhText = source.slice(zhStart, enStart)
  const enText = source.slice(enStart, source.indexOf('\n  }', enStart) + 4)
  return {
    zh: Object.fromEntries([...zhText.matchAll(/'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]])),
    en: Object.fromEntries([...enText.matchAll(/'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]])),
  }
}

test('⑨ the card has a text in both languages, and it says the numbers', async (t) => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const dictionaries = loadDictionaries(source)
  for (const language of ['zh', 'en']) {
    for (const key of [
      'shellBackups.title',
      'shellBackups.line1',
      'shellBackups.line1.noSize',
      'shellBackups.line2',
      'shellBackups.clean',
      'shellBackups.self',
      'shellBackups.cleaned',
      'shellBackups.cleanedNothing',
      'shellBackups.failed',
      'shellBackups.selfDone',
      'shellBackups.error',
      'shellBackups.working',
      'shellBackups.refused',
    ]) {
      const text = dictionaries[language][key]
      assert.equal(typeof text, 'string', language + ' has a text for ' + key)
      assert.equal(text.length > 0, true, language + ' has a text for ' + key)
    }
  }
  // THE NUMBER AND THE SIZE ARE IN THE COPY.
  assert.ok(dictionaries.zh['shellBackups.line1'].includes('{count}'), 'the count is in the sentence')
  assert.ok(dictionaries.zh['shellBackups.line1'].includes('{size}'), 'and the size')
  assert.ok(dictionaries.en['shellBackups.line1'].includes('{count}'), 'the count is in the sentence')
  assert.ok(dictionaries.en['shellBackups.line1'].includes('{size}'), 'and the size')
})

test('⑨ the refusal is a text of the user\'s language, not an English sentence', async (t) => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(
    source.includes('the Host refused the answer'),
    false,
    'no hardcoded English refusal may reach a Chinese user',
  )
  const dictionaries = loadDictionaries(source)
  assert.ok(dictionaries.zh['shellBackups.refused'].length > 0, 'the refusal has a Chinese text')
  assert.ok(dictionaries.en['shellBackups.refused'].length > 0, 'and an English one')
})

/* ------------------------------------------------------------------ *
 * ⑪ THE FIRST-INSTALL SWEEP ALSO HONOURS THE MARKER (2026-11-06)
 * ------------------------------------------------------------------ */

test('⑪ the first-install sweep leaves the leftovers alone while nobody has answered', async (t) => {
  const setup = tempState(t)
  // OLD leftovers: without the age gate the sweep would keep them anyway and
  // this test would prove nothing.
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100, true)
  const profile = path.join(setup.dir, 'profile')
  fs.mkdirSync(path.join(profile, 'config'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'config', 'cordis.patch.yml'), 'a: 1\n')
  const runtime = {
    state: {},
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }

  await seedFirstInstallBackup(runtime, { backupOnRestart: true }, { profileDir: profile })

  const after = scanShellBackups(setup.backups)
  assert.equal(
    after.count,
    1,
    'the first-install sweep deleted nothing: most machines hold fewer than 32 leftovers, and this ONE call used to delete them all before the card was ever asked',
  )

  // AND THE CARD CAN COUNT THEM.
  const route = pluginWith(t, setup)
  const answer = await ask(route, 'GET')
  assert.equal(answer.pending, true, 'so the card appears')
  assert.equal(answer.count, 1, 'with the real number')
})

test('⑪ after 「清理掉」 the first-install sweep MAY take the leftovers', async (t) => {
  const setup = tempState(t)
  makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100, true)
  const profile = path.join(setup.dir, 'profile')
  fs.mkdirSync(path.join(profile, 'config'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'config', 'cordis.patch.yml'), 'a: 1\n')
  const runtime = {
    state: {},
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  // THE USER SAID "清理掉": the marker says the plugin may take them.
  markShellBackupsHandled(setup.dir, 'clean')

  await seedFirstInstallBackup(runtime, { backupOnRestart: true }, { profileDir: profile })

  const after = scanShellBackups(setup.backups)
  assert.equal(after.count, 0, 'the leftovers are gone: the user asked for that')
})

test('⑪ the cleanup does NOT start when the marker cannot be written', async (t) => {
  const setup = tempState(t)
  const leftover = makeLeftover(setup.backups, '2026-11-01T10-00-00-000Z', 100)
  // THE MARKER CANNOT BE WRITTEN: a DIRECTORY sits where the file must go.
  fs.mkdirSync(path.join(setup.dir, SHELL_BACKUPS_MARKER), { recursive: true })
  const route = pluginWith(t, setup)

  const answer = await ask(route, 'POST', { action: 'clean' })

  assert.equal(answer.ok, false, 'the answer says that nothing was recorded')
  assert.equal(answer.recorded, false, 'and says it plainly')
  assert.equal(answer.started, false, 'and the delete did not start')
  assert.equal(answer.error, 'marker-not-written', 'with a clear reason')
  assert.equal(
    fs.existsSync(leftover),
    true,
    'nothing was deleted behind the user\'s back — the card would have asked again',
  )
})

/* ------------------------------------------------------------------ *
 * ⑩ THE CARD, CLIENT SIDE: TWO HOST SHAPES, ONE RECEIPT (2026-11-06)
 * ------------------------------------------------------------------ */

/**
 * Load the client script the way the browser evaluates it.
 *
 * @param {{ language?: string }} options the browser language
 */
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

/** The answer of the OLD host: the result is IN the answer. */
const OLD_HOST_ANSWER = {
  ok: true,
  action: 'clean',
  removed: ['2026-11-01T10-00-00-000Z', '2026-11-02T10-00-00-000Z'],
  failures: [],
  skipped: [],
  freedBytes: 4096,
  count: 0,
  bytes: 0,
  pending: false,
}

/** The answer of the NEW host: it says "running", the receipt comes later. */
const NEW_HOST_ANSWER = {
  ok: true,
  action: 'clean',
  started: true,
  running: true,
  pending: false,
  cleanup: { state: 'running', total: 2, done: 0, removed: 0, failures: [], freedBytes: 0 },
}

test('⑩ the OLD host: the answer of the click IS the receipt — the card is done at once', () => {
  const api = loadClient()
  assert.equal(api.shellCleanupAnswerIsFinal(OLD_HOST_ANSWER), true, 'the answer carries the result')
  const receipt = api.shellCleanupReceipt(OLD_HOST_ANSWER)
  assert.equal(receipt.removed, 2, 'the two removed directories')
  assert.equal(receipt.freedBytes, 4096, 'and the freed bytes')
  assert.deepEqual(receipt.failures, [], 'and no failure')
})

test('⑩ the NEW host: the answer says "running", so the card waits for the job', () => {
  const api = loadClient()
  assert.equal(api.shellCleanupAnswerIsFinal(NEW_HOST_ANSWER), false, 'the delete is still running')
  assert.equal(api.shellCleanupFinished({ cleanup: { state: 'running' } }), false, 'and the job is not done')
})

test('⑩ the NEW host: a finished job ends the card with the receipt', () => {
  const api = loadClient()
  const done = { cleanup: { state: 'done', total: 2, done: 2, removed: 2, failures: [], freedBytes: 4096 } }
  assert.equal(api.shellCleanupFinished(done), true, 'the job says it is done')
  const receipt = api.shellCleanupReceipt(done)
  assert.equal(receipt.removed, 2, 'the receipt says what was removed')
  assert.equal(receipt.freedBytes, 4096, 'and what was freed')
})

test('⑩ the OLD host GET (no cleanup field): nothing left to clean means done', () => {
  const api = loadClient()
  assert.equal(
    api.shellCleanupFinished({ ok: true, pending: false, count: 0, bytes: 0, handled: true }),
    true,
    'no question left and nothing left to clean: the cleanup is done',
  )
  assert.equal(
    api.shellCleanupFinished({ ok: true, pending: true, count: 3, bytes: 10, handled: false }),
    false,
    'but while the question is open it is not done',
  )
})

test('⑩ the card stops waiting after the ceiling, and says what to do', () => {
  const api = loadClient()
  assert.ok(api.SHELL_CLEANUP_POLL_LIMIT_MS <= 60000, 'the ceiling is at most a minute')
  assert.ok(api.SHELL_CLEANUP_POLL_LIMIT_MS >= 10000, 'and long enough to be useful')
  const start = 1000
  assert.equal(
    api.shellCleanupTimedOut(start, start + api.SHELL_CLEANUP_POLL_LIMIT_MS),
    true,
    'at the ceiling: stop waiting',
  )
  assert.equal(
    api.shellCleanupTimedOut(start, start + api.SHELL_CLEANUP_POLL_LIMIT_MS - 1),
    false,
    'before it: keep waiting',
  )
  assert.equal(api.shellCleanupTimedOut(start, start), false, 'a fresh wait is not a timeout')
})

test('⑩ the sentence of the timeout says that a refresh shows the result', () => {
  const zh = loadClient({ language: 'zh-CN' })
  const en = loadClient({ language: 'en-US' })
  const zhText = zh.makeTranslate(null)('shellBackups.maybeLater')
  const enText = en.makeTranslate(null)('shellBackups.maybeLater')
  assert.ok(zhText.length > 0, 'the Chinese user gets a sentence')
  assert.ok(enText.length > 0, 'and the English user gets one')
  assert.ok(zhText.includes('刷新'), 'the Chinese sentence says to refresh: ' + zhText)
  assert.ok(/refresh/i.test(enText), 'and the English one: ' + enText)
})

test('⑩ the card uses these decisions — they are not dead code', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const helper of [
    'shellCleanupAnswerIsFinal',
    'shellCleanupFinished',
    'shellCleanupTimedOut',
    'shellCleanupReceipt',
  ]) {
    assert.ok(source.includes(helper), helper + ' is used by the card')
  }
})

test('⑩ the card fits its text and keeps the look of the other dock cards', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes("'dsh-autorestart-announcement dsh-autorestart-announcement--fit'"),
    'the card keeps the dock card class and adds the fit modifier',
  )
  assert.ok(source.includes('.dsh-autorestart-announcement--fit{'), 'the modifier exists')
  assert.ok(/max-width:min\(40em,94vw\)/.test(source), 'the card is at most forty characters wide')
  assert.ok(source.includes('align-self:flex-start'), 'and it sits on the left, like its text')
  assert.ok(source.includes('overflow-wrap:anywhere'), 'a long directory name cannot scroll the card sideways')
})

/* ------------------------------------------------------------------ *
 * ⑫ THE CARD MUST COME BY ITSELF (2026-11-07)
 *
 * WHAT THIS SECTION PINS DOWN:
 *
 *   1. THE LEFTOVERS MAY SHOW UP LATE. The page is usually already open when
 *      the boot sweep finds them, and a user does not press "refresh" — for a
 *      user there is no such thing. So the panel WATCHES, and the card comes
 *      by itself: within ten seconds, without a reload.
 *   2. SILENCE IS THE DEFAULT: a machine without leftovers, and a machine that
 *      already answered, see NOTHING at all — no card, no entry, no banner.
 *   3. THE ANSWER ENDS THE WATCH: after the user pressed one of the two
 *      buttons, no further request goes to the Host.
 *   4. THE WATCH IS THROTTLED AND PAUSED: never faster than five seconds,
 *      never slower than ten, and nothing at all while the page is hidden —
 *      but the moment the page comes back, the check happens at once.
 *
 * The panel is really mounted here (the same tiny React stand-in the
 * announcement test uses), with a clock that only moves when this file says
 * so — so "ten seconds later" is a fact, not a hope.
 * ------------------------------------------------------------------ */

/** Let the promises of the client settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A clock with the two functions the client uses.
 *
 * @returns {object} the clock
 */
function createClock() {

  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, at: now + (Number.isFinite(Number(ms)) ? Number(ms) : 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    /**
     * Move the clock forward and run everything that is due.
     *
     * @param {number} ms how far to move
     */
    async advance(ms) {
      const target = now + Number(ms)
      for (;;) {
        let next = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (next === null || timer.at < next.timer.at || (timer.at === next.timer.at && id < next.id)) {
            next = { id, timer }
          }
        }
        if (next === null) break
        timers.delete(next.id)
        now = next.timer.at
        next.timer.fn()
        await flush()
      }
      now = target
      await flush()
    },
    pending: () => timers.size,
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * A tiny React stand-in: enough for the classic client script.
 *
 * @param {object} [options] how it should misbehave
 * @param {string} [options.throwOn] an element type that throws while it is
 *   drawn — the way a broken page behaves in a real browser
 * @returns {object} the harness
 */
function createReactHarness({ throwOn = '' } = {}) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []

  const slotAt = (index) => {
    while (hooks.length <= index) {
      hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return hooks[index]
  }

  const React = {
    createElement(type, props, ...children) {
      if (throwOn !== '' && type === throwOn) {
        throw new Error('the element ' + String(type) + ' cannot be drawn')
      }
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = { current: initial }
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }

  const render = (Component, props) => {
    cursor = 0
    pendingEffects = []
    const tree = Component(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const { slot, fn } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    }
    return tree
  }

  return { React, render }
}

/** Every node of a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(child => textOf(child)).join('')
}

/** NOTHING LEFT OVER, and nobody answered yet. */
const NOTHING_LEFT = {
  ok: true,
  pending: false,
  count: 0,
  bytes: null,
  truncated: false,
  handled: false,
  cleanup: { state: 'idle', total: 0, done: 0, removed: 0, failures: [], freedBytes: 0 },
}

/** THE QUESTION IS OPEN: two leftovers, one gigabyte. */
const QUESTION_OPEN = {
  ok: true,
  pending: true,
  count: 2,
  bytes: 1024 * 1024 * 1024,
  truncated: false,
  handled: false,
  cleanup: { state: 'idle', total: 0, done: 0, removed: 0, failures: [], freedBytes: 0 },
}

/** THE USER ALREADY ANSWERED: the marker is there, the question is closed. */
const ALREADY_ANSWERED = {
  ok: true,
  pending: false,
  count: 0,
  bytes: null,
  truncated: false,
  handled: true,
  cleanup: { state: 'idle', total: 0, done: 0, removed: 0, failures: [], freedBytes: 0 },
}

/** The answer of the click on the old host: the result is IN the answer. */
const CLICK_ANSWER = {
  ok: true,
  action: 'clean',
  removed: ['2026-11-01T10-00-00-000Z'],
  failures: [],
  skipped: [],
  freedBytes: 4096,
  count: 0,
  bytes: 0,
  pending: false,
}

/**
 * Mount the leftovers card on a clock the test owns.
 *
 * @param {object} options what the fake world answers
 * @param {object[]} options.answers the answers of the GET, one after another
 * @param {boolean} [options.hidden] whether the page is hidden
 * @param {string} [options.post] what the POST of the click answers:
 *   'ok' (the receipt is in the answer), 'slow' (it never answers on its own),
 *   'refused' (the Host says no) or 'network' (the connection breaks)
 * @param {string} [options.throwOnElement] an element type that throws while
 *   it is drawn
 */
function mountShellBackupsPanel({ answers, hidden = false, post = 'ok', throwOnElement = '' }) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const clock = createClock()
  let definition = null
  let answerIndex = 0
  let resolvePost = null
  const listeners = new Map()
  const fetches = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => { definition = value },
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      hidden,
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
      // A REAL DOM HOLDS MORE THAN ONE LISTENER PER EVENT — the card has two
      // (the watch and the clock of the receipt), and both must be called.
      addEventListener: (type, handler) => {
        const list = listeners.get(type) || []
        list.push(handler)
        listeners.set(type, list)
      },
      removeEventListener: (type, handler) => {
        const list = listeners.get(type) || []
        listeners.set(type, list.filter((entry) => entry !== handler))
      },
    },
    navigator: { language: 'zh-CN' },
    fetch: (url, init) => {
      const target = String(url)
      fetches.push({ url: target, init, at: clock.now() })
      if (target.includes('/shell-backups')) {
        const isPost = init && init.method === 'POST'
        if (isPost) {
          // THE CLICK, AND EVERY WAY IT CAN GO WRONG (2026-11-07).
          if (post === 'network') return Promise.reject(new Error('Failed to fetch'))
          if (post === 'refused') {
            return Promise.resolve({
              ok: false,
              status: 500,
              json: async () => ({ ok: false, error: 'not-allowed' }),
            })
          }
          if (post === 'slow') {
            return new Promise((resolve) => {
              resolvePost = () => resolve({
                ok: true,
                status: 200,
                json: async () => CLICK_ANSWER,
              })
            })
          }
          return Promise.resolve({ ok: true, status: 200, json: async () => CLICK_ANSWER })
        }
        const index = Math.min(answerIndex, answers.length - 1)
        answerIndex += 1
        return Promise.resolve({ ok: true, status: 200, json: async () => answers[index] })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    },
    console,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    // The receipt of a running cleanup is NOT what this section is about.
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the client script must register itself with the module loader')

  const harness = createReactHarness({ throwOn: throwOnElement })
  const module = definition.factory(() => harness.React)

  const dictionaries = {}
  const slots = new Map()
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
      bind: (namespace) => (key) => {
        const table = (dictionaries[namespace] || {}).zh || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      inject: (name, thunk) => {
        const list = slots.get(name) || []
        list.push(thunk)
        slots.set(name, list)
      },
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  const thunks = slots.get('conversation.input.dock') || []
  const thunk = thunks.find((entry) => {
    const { registration } = entry()
    return registration.id === 'autorestart-shell-backups'
  })
  assert.ok(thunk, 'the leftovers card must be registered in the composer dock')
  const { Component } = thunk()

  return {
    clock,
    fetches,
    dictionaries,
    /** The card as it is on the screen right now. */
    render: () => harness.render(Component, {}),
    /** The page came back / went away. */
    setHidden(value) {
      sandbox.document.hidden = value === true
      const list = listeners.get('visibilitychange') || []
      for (const handler of list) handler()
    },
    /** How many requests went to the Host. */
    getCalls: () => fetches.filter((call) => call.url.includes('/shell-backups')).length,
    /** How many clicks reached the Host. */
    posts: () => fetches.filter((call) => call.init && call.init.method === 'POST').length,
    /** Let a slow POST answer, when the test wants it to. */
    resolvePost() {
      if (typeof resolvePost === 'function') resolvePost()
    },
  }
}

test('⑫ the card comes by ITSELF: leftovers that show up later are found', async () => {
  const panel = mountShellBackupsPanel({ answers: [NOTHING_LEFT, QUESTION_OPEN] })

  // THE PAGE IS OPEN, AND THERE IS NOTHING TO SAY YET.
  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  assert.equal(panel.render(), null, 'and there is nothing on the screen while there is nothing to decide')
  assert.equal(panel.getCalls(), 1, 'the Host was asked once, at once')

  // TEN SECONDS LATER THE LEFTOVERS ARE THERE.
  await panel.clock.advance(10000)
  await flush()
  const tree = panel.render()
  assert.ok(tree, 'the card must come by itself: no reload, no user action')
  assert.equal(panel.getCalls() >= 2, true, 'the Host must have been asked again')
  assert.match(textOf(tree), /2/, 'the card says how many leftovers there are')

  // AND THE WATCH IS OVER: the card is up, there is nothing left to look for.
  const calls = panel.getCalls()
  await panel.clock.advance(60000)
  await flush()
  assert.equal(panel.getCalls(), calls, 'the watch stops once the card is on the screen')
})

test('⑫ a machine that already answered sees NOTHING at all', async () => {
  const panel = mountShellBackupsPanel({ answers: [ALREADY_ANSWERED] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  assert.equal(panel.render(), null, 'a machine that answered must not see the card')
  assert.equal(panel.getCalls(), 1, 'the Host was asked once')

  await panel.clock.advance(120000)
  await flush()
  assert.equal(panel.getCalls(), 1, 'and never again: the question is closed for good')
})

test('⑫ a machine without leftovers stays silent — and keeps watching', async () => {
  const panel = mountShellBackupsPanel({ answers: [NOTHING_LEFT, NOTHING_LEFT, QUESTION_OPEN] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  assert.equal(panel.render(), null, 'no leftovers, no card')
  assert.equal(panel.getCalls(), 1, 'the Host was asked once, at once')

  // THE WATCH GOES ON WHILE THERE IS NOTHING TO SHOW: the leftovers may show
  // up at any moment, and the card has to come by itself.
  await panel.clock.advance(10000)
  await flush()
  assert.equal(panel.getCalls() >= 2, true, 'the Host must be asked again')
  assert.ok(panel.render(), 'and when the leftovers are there, the card is up')
})

test('⑫ the answer ends the watch: no request goes to the Host any more', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  assert.ok(tree, 'the card must be up: there is something to decide')

  // THE USER PRESSES 「我自己处理」.
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'self',
  )
  assert.ok(button, 'the card must offer the 「我自己处理」 button')
  button.props.onClick()
  await flush()
  await flush()

  const calls = panel.getCalls()
  await panel.clock.advance(120000)
  await flush()
  assert.equal(panel.getCalls(), calls, 'after the answer the panel must not ask the Host again')
})

test('⑫ the watch is throttled: five seconds at the least, ten at the most', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const api = loadClient()
  assert.ok(api.SHELL_BACKUPS_WATCH_MS >= 5000, 'the watch must not be faster than five seconds')
  assert.ok(
    api.SHELL_BACKUPS_WATCH_MS <= 10000,
    'and it must not be slower than ten: the card has to come within ten seconds',
  )
  assert.ok(api.SHELL_BACKUPS_WATCH_MIN_MS >= 5000, 'the floor is five seconds')
  assert.ok(api.SHELL_BACKUPS_WATCH_MAX_MS <= 10000, 'the ceiling is ten seconds')
  assert.ok(
    source.includes('const SHELL_BACKUPS_WATCH_MS = '),
    'the distance between two checks is a named constant',
  )

  // AND THE REAL INTERVAL IS THE ONE THAT IS USED.
  const panel = mountShellBackupsPanel({ answers: [NOTHING_LEFT, NOTHING_LEFT, NOTHING_LEFT] })
  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  await panel.clock.advance(30000)
  await flush()
  const times = panel.fetches
    .filter((call) => !(call.init && call.init.method === 'POST'))
    .map((call) => call.at)
  assert.ok(times.length >= 2, 'the Host must have been asked more than once')
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(
      times[i] - times[i - 1] >= 5000,
      'two checks must be at least five seconds apart: ' + JSON.stringify(times),
    )
  }
})

test('⑫ a hidden page is not asked at all, and the check happens at once when it comes back', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], hidden: true })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  assert.equal(panel.getCalls(), 0, 'nobody sees a hidden page: the Host must not be asked')

  await panel.clock.advance(30000)
  await flush()
  assert.equal(panel.getCalls(), 0, 'and it must not be asked while the page stays hidden')

  // THE PAGE COMES BACK: THE CHECK HAPPENS AT ONCE.
  panel.setHidden(false)
  await flush()
  assert.equal(panel.getCalls(), 1, 'the check happens at once, not after another interval')
  await flush()
  assert.ok(panel.render(), 'and the card is up when the leftovers are there')
})

test('⑫ the receipt of a cleanup really works — the card says what happened', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  assert.ok(tree, 'the card must be up: there is something to decide')

  // THE USER PRESSES 「清理掉」 (the old host: the answer IS the receipt).
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()

  const after = panel.render()
  assert.ok(after, 'the card must show the receipt')
  assert.match(textOf(after), /已清理 1 个目录/, 'the receipt says what was removed')
})

/* ------------------------------------------------------------------ *
 * ⑬ THE CLICK MUST BE SEEN (2026-11-07)
 *
 * WHAT THIS SECTION PINS DOWN:
 *
 *   1. THE CLICK IS VISIBLE AT ONCE: the card says what it is doing and the
 *      buttons are disabled — a click that shows nothing looks like a broken
 *      button (that is what the user reported on the real machine).
 *   2. A FAILED CLICK IS A SENTENCE: a refusal, a broken connection and a
 *      page that throws while it draws all end in the same readable text, in
 *      the language of the user — never a silence, never an English sentence
 *      from the browser.
 *   3. A SECOND CLICK DOES NOTHING while the first one is running.
 * ------------------------------------------------------------------ */

test('⑬ the click is seen AT ONCE: the card says what it is doing', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'slow' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  assert.ok(tree, 'the card must be up')
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  assert.equal(button.props.disabled, false, 'the button starts enabled')

  // THE CLICK — and nothing is awaited: the card has to change NOW.
  button.props.onClick()
  const after = panel.render()
  assert.ok(after, 'the card must NOT vanish after the click')
  assert.match(textOf(after), /正在清理/, 'the card says it is cleaning')
  const busyButton = walk(after).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(busyButton, 'the button is still there')
  assert.equal(busyButton.props.disabled, true, 'and it is disabled while the work runs')
})

test('⑬ a refused click says so — in the language of the user', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'refused' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()

  const after = panel.render()
  assert.ok(after, 'the card must stay on the screen')
  assert.match(textOf(after), /没能完成清理/, 'the card says the cleanup did not happen')
  assert.match(textOf(after), /宿主没有接受这个操作/, 'and why it did not happen')
  // AND THE QUESTION STAYS OPEN: the user may try again.
  const retry = walk(after).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(retry, 'the button is there again')
  assert.equal(retry.props.disabled, false, 'and it is enabled again')
})

test('⑬ a broken connection says so too — and never in English', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'network' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()

  const after = panel.render()
  assert.ok(after, 'the card must stay on the screen')
  assert.match(textOf(after), /没能完成清理/, 'the card says the cleanup did not happen')
  assert.match(textOf(after), /请再试一次/, 'and what to do about it')
  assert.equal(
    /Failed to fetch/.test(textOf(after)),
    false,
    'the sentence of the browser must not leak into the card',
  )
})

test('⑬ a second click does nothing while the first one is running', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'slow' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  assert.equal(panel.posts(), 1, 'the Host was asked once')

  const after = panel.render()
  const again = walk(after).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(again, 'the button is still there')
  again.props.onClick()
  assert.equal(panel.posts(), 1, 'the Host must be asked exactly once')
})

test('⑬ a card that throws while it draws still says something', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], throwOnElement: 'h3' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  assert.ok(tree, 'the card must not vanish')
  assert.match(textOf(tree), /页面出了点问题/, 'it says that the page had a problem')
})

test('⑬ the sentence of a failure exists in both languages', () => {
  const zh = loadClient({ language: 'zh-CN' }).makeTranslate(null)
  const en = loadClient({ language: 'en-US' }).makeTranslate(null)

  assert.match(zh('shellBackups.error.cleanup'), /没能完成清理/, 'the Chinese sentence')
  assert.match(en('shellBackups.error.cleanup'), /Could not finish/, 'the English sentence')
  for (const key of [
    'shellBackups.error.failed',
    'shellBackups.error.broken',
    'shellBackups.workingSelf',
  ]) {
    assert.ok(zh(key).length > 0, key + ' has a Chinese text')
    assert.ok(en(key).length > 0, key + ' has an English text')
  }
})

test('⑬ the failure text tells a refusal from a broken line', () => {
  const api = loadClient()
  const zh = api.makeTranslate(null)

  const refused = api.shellCleanupFailureText({ refused: true }, zh)
  assert.match(refused, /宿主没有接受这个操作/, 'a refusal says what the host said')

  const broken = api.shellCleanupFailureText(new Error('Failed to fetch'), zh)
  assert.match(broken, /请再试一次/, 'a broken line asks for a retry')
  assert.equal(/Failed to fetch/.test(broken), false, 'and the browser sentence stays out of the card')
})

/* ------------------------------------------------------------------ *
 * ⑭ THE CARD GOES AWAY BY ITSELF (2026-11-07)
 *
 * WHAT THIS SECTION PINS DOWN:
 *
 *   1. A RECEIPT GETS THREE SECONDS: the work is done, the card has nothing
 *      left to say, and it goes without the user doing anything.
 *   2. AN ERROR GETS TEN: three seconds would swallow a sentence before it
 *      was read.
 *   3. THE CLOCK STARTS WHEN THE WORDS REALLY APPEAR — a card that vanishes
 *      while the cleanup is still running looks like a button that does
 *      nothing.
 *   4. NOTHING IS ASKED AFTERWARDS: the card may not turn into a background
 *      poller that lives for ever.
 * ------------------------------------------------------------------ */

test('⑭ the receipt disappears after three seconds — by itself', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()

  const withReceipt = panel.render()
  assert.ok(withReceipt, 'the receipt is on the screen')
  assert.match(textOf(withReceipt), /已清理 1 个目录/, 'the receipt says what happened')

  // THREE SECONDS — and the card is gone.
  await panel.clock.advance(3000)
  await flush()
  assert.equal(panel.render(), null, 'the card must disappear by itself')
})

test('⑭ nothing is asked after the card is gone', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN] })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()
  assert.ok(panel.render(), 'the receipt is on the screen')

  await panel.clock.advance(3000)
  await flush()
  assert.equal(panel.render(), null, 'the card must be gone')

  const calls = panel.getCalls()
  await panel.clock.advance(60000)
  await flush()
  assert.equal(panel.getCalls(), calls, 'the panel must not keep asking the Host')
})

test('⑭ an error stays ten seconds — three seconds must not swallow it', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'refused' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  await flush()
  await flush()
  assert.match(textOf(panel.render()), /没能完成清理/, 'the error is on the screen')

  // THREE SECONDS — the error must still be there.
  await panel.clock.advance(3000)
  await flush()
  assert.match(textOf(panel.render()), /没能完成清理/, 'the error is still there after three seconds')

  // TEN SECONDS — now it is gone.
  await panel.clock.advance(7000)
  await flush()
  assert.equal(
    /没能完成清理/.test(textOf(panel.render())),
    false,
    'the error is gone after ten seconds',
  )

  // AND NOTHING IS ASKED ANY MORE.
  const calls = panel.getCalls()
  await panel.clock.advance(60000)
  await flush()
  assert.equal(panel.getCalls(), calls, 'the panel must not keep asking the Host')
})

test('⑭ the clock starts when the receipt appears — not while it is cleaning', async () => {
  const panel = mountShellBackupsPanel({ answers: [QUESTION_OPEN], post: 'slow' })

  assert.equal(panel.render(), null, 'the card waits for the Host')
  await flush()
  const tree = panel.render()
  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-shell-backups'] === 'clean',
  )
  assert.ok(button, 'the card must offer the 「清理掉」 button')
  button.props.onClick()
  assert.match(textOf(panel.render()), /正在清理/, 'the card says it is cleaning')

  // THIRTY SECONDS OF "STILL CLEANING": the card must not vanish.
  await panel.clock.advance(30000)
  await flush()
  assert.ok(panel.render(), 'the card must NOT vanish while the work is running')

  // THE RECEIPT ARRIVES — and only now does the clock start.
  panel.resolvePost()
  await flush()
  await flush()
  const withReceipt = panel.render()
  assert.ok(withReceipt, 'the receipt is on the screen')
  assert.match(textOf(withReceipt), /已清理 1 个目录/, 'the receipt says what happened')

  await panel.clock.advance(3000)
  await flush()
  assert.equal(panel.render(), null, 'and three seconds later the card is gone')
})

test('⑭ the card waits three seconds for a receipt and ten for an error', () => {
  const api = loadClient()
  assert.equal(api.SHELL_CARD_RECEIPT_MS, 3000, 'the receipt gets three seconds')
  assert.equal(api.SHELL_CARD_ERROR_MS, 10000, 'an error gets ten: it has to be read')
})
