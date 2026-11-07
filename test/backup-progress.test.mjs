/**
 * THE COPY REPORTS WHAT IT REALLY MOVES (2026-11-06).
 *
 * WHAT WAS WRONG ON THE REAL MACHINE: the copy of a linked plugin went into
 * `node_modules-link/<name>` WITHOUT a progress callback, so the interface sat
 * at "89 KB / 0%" while 258 MB were being written. The denominator was the
 * WHOLE profile, measured before the copy started — a slim backup copies the
 * configuration and the linked plugins only, so that number could never be
 * reached even when the copy was done.
 *
 * THE TWO RULES PINNED HERE:
 *   1. the copy of a LINKED plugin REPORTS while it runs (several times, with
 *      growing numbers), and
 *   2. the denominator is WHAT THIS BACKUP REALLY COPIES — so the copy ends at
 *      100% instead of at a number that can never be reached.
 *
 * The fixture is built so that both are provable: the linked plugin has 60
 * files (so the copy reports more than once) and the profile ALSO holds a
 * third-party plugin that this backup never copies (so a denominator that
 * counts it is visibly too big).
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { createBackup } from '../lib/backup.js'

/** How many files the linked plugin holds (the copy reports every 25). */
const LINK_FILES = 60

/** How big one file of the linked plugin is. */
const LINK_FILE_BYTES = 1024

/** The third-party plugin: published as-is, so this backup never copies it. */
const THIRD_PARTY_BYTES = 200 * 1024

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-progress-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

/**
 * A profile with ONE linked plugin (a working checkout) and one third-party
 * plugin (installed from npm, not edited here — so it is only named).
 */
function makeProfile(root) {
  const profile = path.join(root, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'probe-profile', dsh: { profile: { bundles: ['dsh-linked'] } } }, null, 2),
    'utf8',
  )
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

  // THE LINKED PLUGIN: enough files that the copy reports more than once.
  const source = path.join(root, 'plugin-source')
  fs.mkdirSync(source, { recursive: true })
  for (let index = 0; index < LINK_FILES; index += 1) {
    fs.writeFileSync(path.join(source, 'f' + index + '.js'), 'x'.repeat(LINK_FILE_BYTES), 'utf8')
  }
  // THE THIRD-PARTY PLUGIN: a big file this backup must NOT copy.
  const thirdParty = path.join(profile, 'node_modules', 'third-party')
  fs.mkdirSync(thirdParty, { recursive: true })
  fs.writeFileSync(path.join(thirdParty, 'index.js'), 'y'.repeat(THIRD_PARTY_BYTES), 'utf8')

  fs.symlinkSync(source, path.join(profile, 'node_modules', 'dsh-linked'), 'junction')
  return { profile, source }
}

/** The bytes the configuration alone takes — the copies report it first. */
function configBytesOf(profile) {
  let total = 0
  for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']) {
    total += fs.statSync(path.join(profile, name)).size
  }
  return total
}

test('the copy of a LINKED plugin reports while it runs, and it ends at 100%', async (t) => {
  const root = tempRoot(t)
  const { profile } = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const reports = []
  const result = await createBackup({
    profileDir: profile,
    backupsDir,
    includePlugins: true,
    onProgress: (progress) => { reports.push({ ...progress }) },
  })
  assert.equal(result.ok, true, String(result.error))

  // ① IT REPORTED SEVERAL TIMES.
  assert.ok(reports.length >= 3, 'the copy reported more than once: ' + reports.length)

  // ② THE NUMBERS ONLY EVER GROW.
  for (let index = 1; index < reports.length; index += 1) {
    assert.ok(
      reports[index].bytes >= reports[index - 1].bytes,
      'the bytes never go back: ' + JSON.stringify(reports.slice(index - 1, index + 1)),
    )
    assert.ok(
      reports[index].files >= reports[index - 1].files,
      'the file count never goes back: ' + JSON.stringify(reports.slice(index - 1, index + 1)),
    )
  }

  // ③ THE REPORTS ARE ABOUT THE LINKED PLUGIN, NOT ONLY THE CONFIGURATION.
  const configBytes = configBytesOf(profile)
  const duringLink = reports.filter((entry) => entry.bytes > configBytes)
  assert.ok(
    duringLink.length >= 2,
    'the copy of the linked plugin reported while it ran: ' + duringLink.length + ' reports',
  )
  const linkBytes = duringLink[duringLink.length - 1].bytes - configBytes
  assert.ok(
    linkBytes > 0 && linkBytes <= LINK_FILES * LINK_FILE_BYTES,
    'the reported link bytes are the ones really copied: ' + linkBytes,
  )

  // ④ THE DENOMINATOR IS WHAT THIS BACKUP REALLY COPIES.
  const last = reports[reports.length - 1]
  assert.ok(
    last.total < THIRD_PARTY_BYTES,
    'the third-party tree is not part of what this backup copies: ' + last.total,
  )
  assert.ok(
    last.total >= LINK_FILES * LINK_FILE_BYTES,
    'but the linked plugin is: ' + last.total,
  )

  // ⑤ AND THE COPY ENDS AT 100%.
  assert.equal(last.bytes, last.total, 'the copy ends at 100%: ' + last.bytes + ' of ' + last.total)
  assert.equal(last.files, last.filesTotal, 'and the file count ends at 100% too')
  const percent = last.total > 0 ? Math.round((last.bytes / last.total) * 100) : 0
  assert.equal(percent, 100, 'the percentage the interface shows is 100')
})

test('the linked plugin really is in the copy, and the third-party one is not', async (t) => {
  const root = tempRoot(t)
  const { profile } = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const result = await createBackup({ profileDir: profile, backupsDir, includePlugins: true })
  assert.equal(result.ok, true, String(result.error))

  const copied = path.join(result.dir, 'node_modules-link', 'dsh-linked')
  assert.equal(fs.existsSync(path.join(copied, 'f0.js')), true, 'the linked plugin is in the copy')
  assert.equal(fs.existsSync(path.join(copied, 'f' + (LINK_FILES - 1) + '.js')), true, 'all of it')
  assert.equal(
    fs.existsSync(path.join(result.dir, 'node_modules', 'third-party')),
    false,
    'the third-party plugin is NOT copied — it is reinstallable from the lock file',
  )
})

/* ------------------------------------------------------------------ *
 * A FAST BACKUP GETS A RECEIPT, NOT A BAR (2026-11-07, t20)
 *
 * THE REAL MACHINE: the pre-restart copy took 997 ms. The card drew the bar
 * for one frame and switched to 「正在重启…」, so the user never learned that a
 * backup had been taken. The user decided: under two seconds, NO BAR — one
 * line 「已备份 274.5 MB」 instead, and the restart line takes over after half
 * a second. Two seconds and over keeps the bar exactly as it was.
 *
 * The decision is one pure function of the stage the Host already writes
 * (`startedAt`, `at`, `snapshotBytes`, `reason`), so nothing is guessed and no
 * request is added.
 * ------------------------------------------------------------------ */

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

/** The real machine's numbers: 289 908 164 bytes is 276.5 MB. */
const REAL_TOTAL_BYTES = 289_908_164

/** The real machine's numbers: 997 ms for 287 860 164 bytes. */
const REAL_STARTED_AT = 1_791_000_000_000
const REAL_BYTES = 287_860_164

test('⑯ while the copy runs: no bar, the title says 「备份中，共 276.5 MB」', () => {
  const api = loadClient()
  // ① THE COPY IS RUNNING: no bar, and the title states the real total.
  const copying = api.restartBackupCard({
    phase: 'snapshotting',
    progress: { bytes: 12_900_000, total: REAL_TOTAL_BYTES, percent: 5 },
    snapshotBytes: 12_900_000,
  })
  assert.equal(copying.copying, true, 'the copy is running')
  assert.equal(copying.finished, false, 'and it has not finished')
  assert.equal('showBar' in copying, false, 'there is no bar to draw any more')
  assert.equal(copying.totalBytes, REAL_TOTAL_BYTES, 'the title states the total the Host reported')
  assert.equal(api.formatOverlaySize(copying.totalBytes), '276.5 MB', '289 908 164 bytes is 276.5 MB')

  // THE SENTENCE, in both dictionaries, with that size.
  const size = api.formatOverlaySize(copying.totalBytes)
  assert.equal(
    api.dictionaries.zh['restart.overlay.backingUp'].replace('{size}', size),
    '备份中，共 276.5 MB',
    'the Chinese title',
  )
  assert.equal(
    api.dictionaries.en['restart.overlay.backingUp'].replace('{size}', size),
    'Backing up, 276.5 MB in total',
    'and the English one',
  )

  // ①b NO TOTAL YET (the first sample has not arrived): a plain sentence.
  const noTotal = api.restartBackupCard({ phase: 'snapshotting', progress: null })
  assert.equal(noTotal.copying, true, 'the copy is still running')
  assert.equal(noTotal.totalBytes, null, 'nothing measured yet')
  assert.equal(api.dictionaries.zh['restart.overlay.backingUpUnknown'], '备份中…', 'the fallback title')
})

test('⑯ the copy is over: 「备份完成，正在重启…」 — the same for 1 s and for 60 s', () => {
  const api = loadClient()

  // NO CLOCK: the two stages below differ by 59 seconds and read the same.
  const quick = api.restartBackupCard({ phase: 'restarting', reason: 'snapshot done', startedAt: 0, at: 1000 })
  const slow = api.restartBackupCard({ phase: 'restarting', reason: 'snapshot done', startedAt: 0, at: 60_000 })
  for (const [label, card] of [['1 s', quick], ['60 s', slow]]) {
    assert.equal(card.copying, false, label + ': the copy is not running')
    assert.equal(card.finished, true, label + ': and it finished')
  }

  assert.equal(api.dictionaries.zh['restart.overlay.backupDone'], '备份完成，正在重启…', 'the Chinese title')
  assert.equal(api.dictionaries.en['restart.overlay.backupDone'], 'Backup done, restarting…', 'and the English one')
  assert.notEqual(
    api.dictionaries.zh['restart.overlay.backupDone'],
    api.dictionaries.zh['restart.overlay.restarting'],
    'the finished line is not the old 「正在重启…」 sentence',
  )

  // NOTHING TIME-BASED IS LEFT IN THE CLIENT.
  assert.equal(api.RESTART_FAST_BACKUP_MS, undefined, 'the old two-second threshold is gone')
  assert.equal(api.RESTART_BACKUP_RECEIPT_MS, undefined, 'and so is the 500 ms receipt')
  assert.equal('restart.overlay.backedUp' in api.dictionaries.zh, false, 'the old receipt key is gone too')
})

test('⑯ a failed or skipped backup never says 备份完成', () => {
  const api = loadClient()

  // SKIPPED ON PURPOSE (a manual rollback carries its own undo copy).
  const skipped = api.restartBackupCard({
    phase: 'restarting',
    reason: 'no snapshot for this restart (manual rollback)',
    snapshotBytes: null,
  })
  assert.equal(skipped.finished, false, 'nothing was copied, so nothing finished')
  assert.equal(skipped.copying, false, 'and nothing is being copied')

  // CANCELLED WHILE THE FILES WERE BEING COPIED.
  const cancelled = api.restartBackupCard({
    phase: 'waiting',
    reason: 'the restart was cancelled while the snapshot was being written',
  })
  assert.equal(cancelled.finished, false, 'a cancelled copy is not a finished one')

  // A STAGE THAT SAYS NOTHING CLAIMS NOTHING.
  const idle = api.restartBackupCard({ phase: 'waiting' })
  assert.equal(idle.finished, false, 'and an empty stage claims nothing')
  assert.equal(idle.copying, false, 'it is not copying either')
})
