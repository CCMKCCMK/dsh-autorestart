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

import { createBackup, contentDigestOf, findUnchangedBackup } from '../lib/backup.js'
// THE COMPARISON BEFORE A RESTART lives in this file too (see the last section):
// it drives the real restart path, so it needs the host-side runtime.
import { createRuntime, normalizeConfig } from '../index.js'
import { requestRestart } from '../lib/checkpoint.js'

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

test('⑯ while the copy runs: no bar, the title says 「配置有变化，正在备份，共 276.5 MB」', () => {
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

  // THE SENTENCE, in both dictionaries, with that size — both scopes.
  const size = api.formatOverlaySize(copying.totalBytes)
  assert.equal(
    api.dictionaries.zh['restart.overlay.changed'].replace('{size}', size),
    '配置和插件有变化，正在备份，共 276.5 MB',
    'the Chinese title (plugins in the copy)',
  )
  assert.equal(
    api.dictionaries.zh['restart.overlay.changedConfig'].replace('{size}', size),
    '配置有变化，正在备份，共 276.5 MB',
    'the Chinese title (configuration only)',
  )
  assert.equal(
    api.dictionaries.en['restart.overlay.changed'].replace('{size}', size),
    'Configuration and plugins changed, backing up 276.5 MB',
    'and the English one',
  )
  assert.equal(
    api.dictionaries.en['restart.overlay.changedConfig'].replace('{size}', size),
    'Configuration changed, backing up 276.5 MB',
    'and the English configuration-only one',
  )

  // ①b NO TOTAL YET (the first sample has not arrived): a plain sentence.
  const noTotal = api.restartBackupCard({ phase: 'snapshotting', progress: null })
  assert.equal(noTotal.copying, true, 'the copy is still running')
  assert.equal(noTotal.totalBytes, null, 'nothing measured yet')
  assert.equal(api.dictionaries.zh['restart.overlay.changedUnknown'], '配置和插件有变化，正在备份', 'the fallback title')
  assert.equal(api.dictionaries.zh['restart.overlay.changedUnknownConfig'], '配置有变化，正在备份', 'and its configuration-only form')

  // ①c THE COPY'S BRANCHES, verbatim (the copy the user confirmed on 2026-11-07).
  assert.equal(api.dictionaries.zh['restart.overlay.skipped'], '配置和插件没有变化，跳过备份，将执行重启')
  assert.equal(api.dictionaries.zh['restart.overlay.skippedConfig'], '配置没有变化，跳过备份，将执行重启')
  assert.equal(api.dictionaries.zh['restart.overlay.compareUnusable'], '无法比对配置和插件，仍会备份')
  assert.equal(api.dictionaries.zh['restart.overlay.compareUnusableConfig'], '无法比对配置，仍会备份')
  assert.equal(api.dictionaries.zh['restart.overlay.backupFailed'], '备份失败，重启继续进行')
  assert.equal(api.dictionaries.en['restart.overlay.backupFailed'], 'Backup failed, the restart continues')
  // NO 「正在比对」 CARD (user decision, 2026-11-09): 比对瞬时完成，不单独占一个阶段 —
  // the Host never stored a `comparing` phase, so the wording and the branch are gone.
  assert.equal(api.dictionaries.zh['restart.overlay.comparing'], undefined, 'no comparison wording left')
  assert.equal(api.dictionaries.zh['restart.overlay.comparingConfig'], undefined)
  assert.equal(api.dictionaries.en['restart.overlay.comparing'], undefined)
  assert.equal(api.dictionaries.en['restart.overlay.comparingConfig'], undefined)

  // ①d THE CARD'S STATE MACHINE follows those keys — and it no longer has a
  // comparison state at all.
  const copyCard = api.restartBackupCard({ phase: 'snapshotting', reason: 'config+plugins' })
  assert.equal(copyCard.copying, true, 'the copy is card ①')
  assert.equal(copyCard.comparing, undefined, 'there is no comparison state any more')
  assert.equal(copyCard.includePlugins, true, 'an OLD Host still states the scope inside the reason (fallback)')

  // THE SCOPE IS ITS OWN FIELD NOW (2026-11-09, user report): the copy stage has
  // no `+plugins` suffix — reading the scope from the suffix alone is what made
  // 「配置有变化，正在备份」 show up while the plugins were in the copy.
  const copyWithPlugins = api.restartBackupCard({
    phase: 'snapshotting',
    progress: { bytes: 1, total: 2 },
    includePlugins: true,
  })
  assert.equal(copyWithPlugins.copying, true, 'the copy is running')
  assert.equal(copyWithPlugins.includePlugins, true, 'the explicit field names the plugins, without any suffix')

  const copyConfigOnly = api.restartBackupCard({
    phase: 'snapshotting',
    progress: { bytes: 1, total: 2 },
    includePlugins: false,
  })
  assert.equal(copyConfigOnly.includePlugins, false, 'an explicit false keeps the configuration-only wording')

  // The FIELD beats the suffix; the suffix is only there for a Host that has no
  // field at all (0.9.4 and older).
  const fieldWins = api.restartBackupCard({ phase: 'snapshotting', reason: 'changed', includePlugins: true })
  assert.equal(fieldWins.includePlugins, true, 'the field is read first')
  const suffixOnly = api.restartBackupCard({ phase: 'snapshotting', reason: 'changed' })
  assert.equal(suffixOnly.includePlugins, false, 'no field and no suffix = configuration only')

  const skippedCard = api.restartBackupCard({ phase: 'restarting', reason: 'snapshot skipped: unchanged' })
  assert.equal(skippedCard.skipped, true, 'nothing was written: the card says so')
  assert.equal(skippedCard.finished, false, 'and it is not a finished copy')
  assert.equal(skippedCard.copying, false, 'and nothing is being copied')
})

test('⑯ the copy is over: 「备份完成，将执行重启」 — the same for 1 s and for 60 s', () => {
  const api = loadClient()

  // NO CLOCK: the two stages below differ by 59 seconds and read the same.
  const quick = api.restartBackupCard({ phase: 'restarting', reason: 'snapshot done', startedAt: 0, at: 1000 })
  const slow = api.restartBackupCard({ phase: 'restarting', reason: 'snapshot done', startedAt: 0, at: 60_000 })
  for (const [label, card] of [['1 s', quick], ['60 s', slow]]) {
    assert.equal(card.copying, false, label + ': the copy is not running')
    assert.equal(card.finished, true, label + ': and it finished')
  }

  assert.equal(api.dictionaries.zh['restart.overlay.backupDone'], '备份完成，将执行重启', 'the Chinese title')
  assert.equal(api.dictionaries.en['restart.overlay.backupDone'], 'Backup done, the restart will now proceed', 'and the English one')
  assert.notEqual(
    api.dictionaries.zh['restart.overlay.backupDone'],
    api.dictionaries.zh['restart.overlay.restarting'],
    'the finished line is not the old 「正在重启…」 sentence',
  )
  // ONE LINE, ONE CLAIM: the copy is over, so the finished line must not also
  // say a copy is running — that would be two states in one sentence.
  assert.doesNotMatch(api.dictionaries.zh['restart.overlay.backupDone'], /正在备份/)
  assert.doesNotMatch(api.dictionaries.en['restart.overlay.backupDone'], /backing up/i)

  // NOTHING TIME-BASED IS LEFT IN THE CLIENT.
  assert.equal(api.RESTART_FAST_BACKUP_MS, undefined, 'the old two-second threshold is gone')
  assert.equal(api.RESTART_BACKUP_RECEIPT_MS, undefined, 'and so is the 500 ms receipt')
  assert.equal('restart.overlay.backedUp' in api.dictionaries.zh, false, 'the old receipt key is gone too')
  assert.equal('restart.overlay.backingUp' in api.dictionaries.zh, false, 'and so is the old copy title')
  assert.equal('restart.overlay.backingUpUnknown' in api.dictionaries.zh, false, 'and its no-total fallback')
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

/* ------------------------------------------------------------------ *
 * THE COMPARISON BEFORE A RESTART (user decision, 2026-11-07) — moved here
 * verbatim from the throwaway ackup-dedupe.test.mjs when the task scope
 * closed: same four names, same assertions.
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * Fixtures: a profile the backup can really copy.
 * ------------------------------------------------------------------ */

/** The Cordis context the runtime needs (logging only). */
function hostContext() {
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, disarm: () => undefined, pause: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
}

/**
 * A profile whose plugin is LINKED (the case the copy really holds file by
 * file), a state directory and a backups root.
 *
 * The real layout (checked against `~/.dsh/profiles/desktop`): a profile keeps
 * `cordis.patch.yml`, `package.json` and `pnpm-lock.yaml` at its ROOT, stores
 * them under `config/` in a copy, and installs a linked plugin as a
 * `node_modules/<name>` junction whose source lives outside the profile. A slim
 * copy carries exactly that source under `node_modules-link/<name>`.
 */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-dedupe-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  const source = path.join(base, 'demo-source')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"demo-plugin","version":"1.0.0"}\n', 'utf8')
  fs.writeFileSync(path.join(source, 'index.js'), 'export default 1\n', 'utf8')
  // A FIXED, UNAMBIGUOUS TIME for the source tree: the digest reads modification
  // times at second resolution, so the fixture keeps them a quarter second away
  // from every boundary the copy could round across.
  const fixedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000 + 250)
  for (const name of ['package.json', 'index.js']) {
    fs.utimesSync(path.join(source, name), fixedAt, fixedAt)
  }
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['demo-plugin'] } } }, null, 2) + '\n',
    'utf8',
  )
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  let linked = true
  try {
    fs.symlinkSync(source, path.join(profile, 'node_modules', 'demo-plugin'), 'junction')
  } catch {
    linked = false
  }
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
  const stateDir = path.join(base, 'storage')
  fs.mkdirSync(stateDir, { recursive: true })
  return {
    base,
    profile,
    source,
    linked,
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    backups: path.join(stateDir, 'backups'),
  }
}

/** A runtime that really runs the snapshot path, with a command that never starts a process. */
function makeRuntime(setup, overrides = {}) {
  const commands = []
  const runtime = createRuntime(hostContext(), normalizeConfig({
    stateFile: setup.stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    ...overrides,
  }), {
    env: { isDesktopApp: false, appExePath: null },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    launchWatcher: () => ({ ok: false, method: 'none', error: 'the test launches no watcher', verified: 'nothing', pid: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
    // THE PROFILE IS THIS TEST'S OWN, named explicitly: the runtime would
    // otherwise resolve the profile of whoever runs the suite, and the copy
    // would be a real one.
    profileDir: setup.profile,
  })
  return { runtime, commands }
}

/** The copies on disk, oldest name first (the names are UTC timestamps). */
function copies(setup) {
  try {
    return fs.readdirSync(setup.backups).sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * ① ONE COPY FOR TWO RESTARTS.
 * ------------------------------------------------------------------ */

test('① the same profile restarted twice writes ONE copy; the second verdict says skipped=unchanged', async (t) => {
  const setup = fixture(t, 'same')

  const first = makeRuntime(setup)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  assert.deepEqual(first.commands, ['restart-the-host'], 'the first restart really ran')
  const afterFirst = copies(setup)
  assert.equal(afterFirst.length, 1, 'the first restart wrote one copy, got: ' + JSON.stringify(afterFirst))
  const keptDir = path.join(setup.backups, afterFirst[0])
  assert.equal(fs.existsSync(keptDir), true, 'and it is on disk')

  // SECOND RESTART — a fresh instance, exactly like the host that came back up,
  // on a profile nobody touched in between.
  const second = makeRuntime(setup)
  requestRestart(second.runtime.state, { reason: 'the second restart', bySessionId: 'sess-2' })
  await second.runtime.executeRestart()

  assert.deepEqual(second.commands, ['restart-the-host'], 'the second restart really ran too')
  assert.deepEqual(
    copies(setup),
    afterFirst,
    'NO new directory: the comparison found the newest copy already holding this profile',
  )

  const verdict = second.runtime.lastRestartVerdict()
  assert.ok(verdict, 'the second restart recorded its conclusion')
  assert.equal(verdict.skipped, 'unchanged', 'and says WHY no copy was written')
  assert.equal(verdict.backupDir, keptDir, 'naming the copy it reused')
  // THE ROLLBACK POINT OF THIS RESTART IS THAT COPY — a skipped run is not a
  // restart without a restore point.
  assert.equal(verdict.snapshot.taken, true, 'this restart still has a rollback point')
  assert.equal(verdict.snapshot.dir, keptDir, 'and it is the reused copy')
  assert.equal(verdict.snapshot.requested, true, 'the comparison was asked for and answered')
})

/* ------------------------------------------------------------------ *
 * ② A CHANGED PLUGIN FILE DEFEATS THE COMPARISON.
 * ------------------------------------------------------------------ */

test('② a plugin file that changed is a real difference: the next restart copies again', async (t) => {
  const setup = fixture(t, 'changed')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }

  const first = makeRuntime(setup)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  const afterFirst = copies(setup)
  assert.equal(afterFirst.length, 1, 'the first restart wrote one copy')
  // THE COPY REALLY HOLDS THE PLUGIN: `node_modules-link/<name>` is the file-by-file
  // copy of the linked source.
  assert.equal(
    fs.existsSync(path.join(setup.backups, afterFirst[0], 'node_modules-link', 'demo-plugin', 'index.js')),
    true,
    'the linked plugin was copied into the backup',
  )

  // THE EDIT: a file INSIDE the plugin the copy holds.
  const pluginFile = path.join(setup.source, 'index.js')
  fs.writeFileSync(pluginFile, 'export default 2\n', 'utf8')
  // A timestamp far enough in the future that no filesystem can round it away.
  const later = Date.now() + 2000
  fs.utimesSync(pluginFile, new Date(later), new Date(later))

  const second = makeRuntime(setup)
  requestRestart(second.runtime.state, { reason: 'the second restart', bySessionId: 'sess-2' })
  await second.runtime.executeRestart()

  const afterSecond = copies(setup)
  assert.equal(
    afterSecond.length,
    afterFirst.length + 1,
    'a changed plugin file must produce a FULL new copy, got: ' + JSON.stringify(afterSecond),
  )
  const verdict = second.runtime.lastRestartVerdict()
  assert.equal(verdict.skipped, null, 'nothing was skipped: a real difference was copied')
  assert.notEqual(verdict.backupDir, path.join(setup.backups, afterFirst[0]), 'the new copy is the newest one')
})

/* ------------------------------------------------------------------ *
 * ③ NO SWITCH = NO COMPARISON AND NO COPY.
 * ------------------------------------------------------------------ */

test('③ with backupOnRestart off the restart neither compares nor copies', async (t) => {
  const setup = fixture(t, 'off')
  const off = makeRuntime(setup, { backupOnRestart: false })
  requestRestart(off.runtime.state, { reason: 'the user asked for a restart', bySessionId: 'sess-1' })
  await off.runtime.executeRestart()

  assert.deepEqual(off.commands, ['restart-the-host'], 'the restart still happens')
  assert.deepEqual(copies(setup), [], 'and nothing was copied')

  // NEITHER STAGE IS DRAWN: no comparison state (none exists any more) and no
  // copy card. The restart goes straight to 「正在重启…」 (the phase title it
  // already had).
  const stage = off.runtime.restartStageInfo()
  assert.notEqual(stage.phase, 'snapshotting', 'nothing is being copied')
  assert.equal(stage.phase, 'restarting', 'it goes straight to the restart')

  const verdict = off.runtime.lastRestartVerdict()
  assert.equal(verdict.skipped, null, 'a switch that is off is not a "nothing changed" skip')
  assert.equal(verdict.backupDir, null, 'and there is no copy to name')
})

/* ------------------------------------------------------------------ *
 * ④ THE COMPARISON ITSELF — the unit the whole feature stands on.
 * ------------------------------------------------------------------ */

test('④ the comparison answers unchanged / changed / no-backup / unusable without blocking', async (t) => {
  const setup = fixture(t, 'compare')

  // ① NO COPY YET: a first restart has nothing to compare against.
  assert.equal(
    findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true }).state,
    'no-backup',
  )

  // ② A REAL COPY, THEN THE COMPARISON AGAINST IT.
  const first = makeRuntime(setup)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  const [name] = copies(setup)
  assert.ok(name, 'the first restart wrote the copy this compares against')

  const unchanged = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(unchanged.state, 'unchanged', 'the copy holds exactly what the profile holds')
  assert.equal(unchanged.dir, path.join(setup.backups, name), 'and it names that copy')
  assert.equal(unchanged.current, unchanged.previous, 'same digest, so there is nothing to copy')
  assert.equal(String(unchanged.current).startsWith('sha256:'), true, 'the digest is a sha256, as always')

  // THE SAME QUESTION WITHOUT THE PLUGINS: also unchanged (the configuration
  // half of the digest is the one the copies already record).
  assert.equal(
    findUnchangedBackup(setup.profile, setup.backups, { includePlugins: false }).state,
    'unchanged',
  )

  // ③ A CHANGED CONFIGURATION FILE IS A DIFFERENCE.
  fs.writeFileSync(
    path.join(setup.profile, 'cordis.patch.yml'),
    'rows:\n  - id: demo\n  - id: added\n',
    'utf8',
  )
  const changed = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(changed.state, 'changed', 'a config edit is a real change')
  assert.notEqual(changed.current, changed.previous, 'the digests differ')

  // ④ A COMPARISON THAT CANNOT BE MADE SAYS SO — it never throws and never
  // blocks the restart.
  const unusable = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true, limits: { files: 0 } })
  assert.equal(unusable.state, 'unusable', 'the budget was exhausted')
  assert.equal(typeof unusable.reason, 'string', 'and the reason travels with the answer: ' + unusable.reason)

  // ⑤ AN UNKNOWN PROFILE IS 'unusable' TOO, not a crash.
  assert.equal(contentDigestOf('', { includePlugins: true }).unusable, 'no-profile')
  assert.equal(findUnchangedBackup('', setup.backups).state, 'unusable')
})

/* ------------------------------------------------------------------ *
 * ⑤ THE DIGEST AND THE COPY SKIP THE SAME NAMES (real machine, 2026-11-07).
 *
 * WHAT WENT WRONG ON THE REAL MACHINE (second restart, 16:15): the content had
 * not changed at all and the restart still wrote `2026-11-07T08-15-39-308Z`
 * (294,817,675 bytes, `skipped` empty) next to the identical 08-14 copy. The
 * cause was a SCOPE mismatch inside the comparison itself:
 *
 *   source  218 files / 9,908,999 bytes
 *   copy    139 files / 5,601,116 bytes   (218 − 79 = 139, exactly the `.git`)
 *   `.git`   79 files / 4,307,883 bytes
 *
 * `copyTreeWithProgress` has always skipped `BACKUP_SKIP_NAMES` (`.git` — it is
 * rebuildable and it was the bulk of every backup), but `pluginTreeDigest` walked
 * the whole tree, so the two sides could never produce the same digest: every
 * restart said "changed" and took a full duplicate copy.
 *
 * THIS TEST PINS THE SAME SHAPE: a linked plugin whose source carries a `.git`
 * history of 79 files that the copy cannot have.
 * ------------------------------------------------------------------ */

/** The real history: 79 files inside `.git`, never copied. */
const GIT_HISTORY_FILES = 79

/** Write a `.git` history of `count` files under `dir` (a plain tree, no git needed). */
function writeGitHistory(dir, count) {
  const gitDir = path.join(dir, '.git')
  fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  for (let index = 0; index < count - 1; index += 1) {
    const bucket = String(index % 16).padStart(2, '0')
    fs.mkdirSync(path.join(gitDir, 'objects', bucket), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'objects', bucket, `obj-${index}`), `blob ${index}\n`, 'utf8')
  }
}

/** Count the regular files under `dir` (what both the digest and the copy walk). */
function countFilesUnder(dir) {
  let files = 0
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()
    const abs = rel === '' ? dir : path.join(dir, rel)
    let entries = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(rel === '' ? entry.name : rel + '/' + entry.name)
      else files += 1
    }
  }
  return files
}

test('⑤ a .git history the copy never takes does not make the profile "changed"', async (t) => {
  const setup = fixture(t, 'git')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  writeGitHistory(setup.source, GIT_HISTORY_FILES)

  const first = makeRuntime(setup)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  const [name] = copies(setup)
  assert.ok(name, 'the first restart wrote a copy')

  // THE SHAPE OF THE BUG: the source holds the history, the copy does not.
  const copiedTree = path.join(setup.backups, name, 'node_modules-link', 'demo-plugin')
  const sourceFiles = countFilesUnder(setup.source)
  const copyFiles = countFilesUnder(copiedTree)
  assert.equal(fs.existsSync(path.join(copiedTree, '.git')), false, 'the copy never takes .git')
  assert.equal(
    sourceFiles - copyFiles,
    GIT_HISTORY_FILES,
    `the copy is short by exactly the history: ${sourceFiles} vs ${copyFiles}`,
  )

  // THE ACCEPTANCE: the two sides are comparable, so this is "unchanged".
  const unchanged = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(unchanged.state, 'unchanged', 'a .git-only difference must NOT count as a change')
  assert.equal(unchanged.current, unchanged.previous, 'both digests are the same')
  assert.equal(unchanged.dir, path.join(setup.backups, name), 'and it names the copy it would reuse')

  // A REAL EDIT IS STILL SEEN (the skip list must not swallow everything).
  const pluginFile = path.join(setup.source, 'index.js')
  fs.writeFileSync(pluginFile, 'export default 3\n', 'utf8')
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 30_000 + 250)
  fs.utimesSync(pluginFile, later, later)
  const changed = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(changed.state, 'changed', 'editing a real file still counts as a change')
  assert.notEqual(changed.current, changed.previous, 'and the digests differ')

  // AND THE RESTART ITSELF AGREES: the edit produced exactly one new copy, and
  // that copy is not a "skipped" one.
  const second = makeRuntime(setup)
  requestRestart(second.runtime.state, { reason: 'the second restart', bySessionId: 'sess-2' })
  await second.runtime.executeRestart()
  const afterSecond = copies(setup)
  assert.equal(afterSecond.length, 2, 'the edit produced exactly one new copy: ' + JSON.stringify(afterSecond))
  assert.equal(second.runtime.lastRestartVerdict().skipped, null, 'a real edit is not a skip')
})

/* ------------------------------------------------------------------ *
 * ⑥ A CONFIG-ONLY COPY IS NOT A BASELINE FOR A PLUGIN-CARRYING PROFILE
 *   (real machine, 2026-11-07 — the DANGEROUS direction of the bug).
 *
 * WHAT HAPPENED: the newest copy was the first-install seed — `includePlugins:
 * false`, three configuration files, 92,888 bytes. The comparison took it as the
 * baseline, compared only the configuration, answered `unchanged`, and the
 * restart SKIPPED its copy — while `plugins/dsh-autorestart/index.js` had really
 * changed (source 575,255 bytes at 16:22:12 against the 573,584-byte file in the
 * copy taken at 16:06:12). A duplicate is annoying; a copy that was never taken
 * is a rollback point that no longer exists.
 *
 * THE RULE PINNED HERE: a candidate must have the SAME SCOPE as what this run
 * would copy. `config-only` copies are passed over; with no same-scope copy the
 * answer is `changed` (copy), never `unchanged`.
 * ------------------------------------------------------------------ */

/** A complete configuration-only copy — exactly what `seedFirstInstallBackup` writes. */
async function writeConfigOnlySeed(profile, backups) {
  const written = await createBackup({
    profileDir: profile,
    backupsDir: backups,
    includePlugins: false,
    kind: 'known-good',
    trigger: 'first-install',
  })
  assert.equal(written.ok, true, 'the seed was written: ' + String(written.error))
  return written.dir
}

test('⑥ a config-only seed cannot make a plugin-carrying profile look "unchanged"', async (t) => {
  const setup = fixture(t, 'seed-only')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  const seed = await writeConfigOnlySeed(setup.profile, setup.backups)
  assert.equal(fs.existsSync(path.join(seed, 'node_modules-link')), false, 'the seed holds no plugin tree')

  // ① THE SOURCE CHANGED (the real machine's case): must be `changed`.
  const pluginFile = path.join(setup.source, 'index.js')
  fs.writeFileSync(pluginFile, 'export default 42\n', 'utf8')
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 30_000 + 250)
  fs.utimesSync(pluginFile, later, later)
  const afterEdit = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(afterEdit.state, 'changed', 'a config-only seed cannot answer a plugin question')
  assert.equal(afterEdit.dir, null, 'and it is not offered as the baseline')

  // ② THE SOURCE IS UNCHANGED: STILL `changed`, because there is nothing to
  // compare the plugin tree against. Only a full copy may answer `unchanged`.
  const untouched = fixture(t, 'seed-only-fresh')
  if (untouched.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  await writeConfigOnlySeed(untouched.profile, untouched.backups)
  const firstAnswer = findUnchangedBackup(untouched.profile, untouched.backups, { includePlugins: true })
  assert.equal(firstAnswer.state, 'changed', 'no same-scope copy exists, so this run must copy')
  assert.equal(firstAnswer.dir, null, 'and no directory is named as the baseline')

  // ③ ONE REAL RESTART LATER a full copy exists — NOW `unchanged` is allowed
  // (the fix must not degrade into "copy every time").
  const first = makeRuntime(untouched)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  const secondAnswer = findUnchangedBackup(untouched.profile, untouched.backups, { includePlugins: true })
  assert.equal(secondAnswer.state, 'unchanged', 'with a same-scope copy the answer is honest again')
  assert.equal(typeof secondAnswer.dir, 'string', 'and it names that copy')
})

/* ------------------------------------------------------------------ *
 * ⑤ WHICH WAY DID THIS RESTART GO? (task t39)
 *
 * gen 537 on the real machine left nothing: no new backup directory and a verdict
 * file still naming the previous generation — so "did it skip, copy, fail to copy
 * or get postponed" could only be guessed. Every branch now names itself in the
 * record, written as the branch is entered (before anything can return early).
 * ------------------------------------------------------------------ */

test('⑤ every restart names the branch it took', async (t) => {
  // ① THE SWITCH IS OFF: no comparison, no copy — and the record says so.
  const offSetup = fixture(t, 'branch-off')
  const off = makeRuntime(offSetup, { backupOnRestart: false })
  requestRestart(off.runtime.state, { reason: 'the user asked for a restart', bySessionId: 'sess-1' })
  await off.runtime.executeRestart()
  const offVerdict = off.runtime.lastRestartVerdict()
  assert.equal(offVerdict.branch, 'backup-off', 'the branch is named: ' + JSON.stringify(offVerdict.branch))
  assert.equal(typeof offVerdict.branchReason, 'string', 'and why: ' + JSON.stringify(offVerdict.branchReason))
  assert.equal(typeof offVerdict.branchGeneration, 'number', 'and for which generation')
  assert.ok(
    offVerdict.branchTrail.some((entry) => entry.branch === 'backup-off'),
    'the trail carries it too: ' + JSON.stringify(offVerdict.branchTrail),
  )

  // ② NOTHING TO COMPARE AGAINST YET, SO IT COPIES — named as such.
  const setup = fixture(t, 'branch-steps')
  const first = makeRuntime(setup)
  requestRestart(first.runtime.state, { reason: 'the first restart', bySessionId: 'sess-1' })
  await first.runtime.executeRestart()
  const firstVerdict = first.runtime.lastRestartVerdict()
  assert.equal(firstVerdict.branch, 'changed-backed-up', 'a real copy: ' + JSON.stringify(firstVerdict.branch))
  assert.ok(
    firstVerdict.branchTrail.some((entry) => entry.branch === 'comparing'),
    'the trail shows it looked first: ' + JSON.stringify(firstVerdict.branchTrail.map((entry) => entry.branch)),
  )

  // ③ THE SAME PROFILE AGAIN: unchanged, and the record says which way.
  const second = makeRuntime(setup)
  requestRestart(second.runtime.state, { reason: 'the second restart', bySessionId: 'sess-2' })
  await second.runtime.executeRestart()
  const secondVerdict = second.runtime.lastRestartVerdict()
  assert.equal(typeof secondVerdict.branch, 'string', 'a branch is always named: ' + JSON.stringify(secondVerdict.branch))
  // THE HARD RULE (t40's high finding, closed by t42): one attempt writes its
  // record ONCE, so the branch and the skip flag can never disagree.
  assert.equal(
    secondVerdict.branch === 'unchanged',
    secondVerdict.skipped === 'unchanged',
    'branch and skipped agree: ' + JSON.stringify({ branch: secondVerdict.branch, skipped: secondVerdict.skipped }),
  )
  assert.equal(secondVerdict.executionEntered, true, 'and the record says the main flow ran')

  // ④ A REAL EDIT: changed, copied, and the copy count really went up — so no
  //    `changed-without-new-backup` warning is attached to this one.
  fs.writeFileSync(path.join(setup.source, 'index.js'), 'export default 3\n', 'utf8')
  const third = makeRuntime(setup)
  requestRestart(third.runtime.state, { reason: 'the third restart', bySessionId: 'sess-3' })
  await third.runtime.executeRestart()
  const thirdVerdict = third.runtime.lastRestartVerdict()
  assert.equal(thirdVerdict.branch, 'changed-backed-up', 'the edit is copied: ' + JSON.stringify(thirdVerdict.branch))
  assert.equal(thirdVerdict.branchWarning, null, 'and there is no contradiction to warn about')
})

/* ------------------------------------------------------------------ *
 * ⑰ THE BACKUP SCOPE, THROUGH THE WHOLE CHAIN (2026-11-09).
 *
 * The overlay reads "does this backup include the plugins" from
 * `restartPhase.includePlugins`. It was written from outside the record twice and
 * dropped both times: `setRestartPhase` rebuilds the record from a white list, and
 * `setRestartProgress` replaces it on every copy tick. This test walks the real
 * runtime: mark → state → stage info → progress tick → stage change.
 * ------------------------------------------------------------------ */

test('⑰ the backup scope survives the stage chain: mark → state → stage info → progress', async (t) => {
  const setup = fixture(t, 'scope')
  const { runtime } = makeRuntime(setup)

  // ① THE COPY STAGE states the scope, and the RECORD keeps it — that record is
  //    what the overlay reads.
  runtime.markRestartStage('snapshotting', { reason: 'changed', includePlugins: true })
  assert.equal(runtime.state.restartPhase.phase, 'snapshotting')
  assert.equal(runtime.state.restartPhase.includePlugins, true, 'the checkpoint record must keep the scope')
  assert.equal(runtime.restartStageInfo().includePlugins, true, 'and the stage info must report it')

  // ② A PROGRESS TICK REPLACES THE RECORD — the scope has to come through it.
  runtime.recordSnapshotProgress({ files: 2, bytes: 1024, total: 2048, filesTotal: 4 })
  assert.equal(runtime.state.restartPhase.phase, 'snapshotting', 'the tick still describes the copy')
  assert.equal(runtime.state.restartPhase.includePlugins, true, 'a progress tick must not drop the scope')
  assert.equal(runtime.restartStageInfo().includePlugins, true, 'nor may the stage info lose it')

  // ③ A STAGE CHANGE INSIDE THE SAME RESTART carries it (undefined = carry).
  runtime.markRestartStage('restarting', { reason: 'snapshot done' })
  assert.equal(runtime.state.restartPhase.includePlugins, true, 'a stage change inside the restart carries it')

  // ④ AN EXPLICIT false IS HONOURED — the configuration-only wording needs it.
  runtime.markRestartStage('snapshotting', { reason: 'changed', includePlugins: false })
  assert.equal(runtime.state.restartPhase.includePlugins, false)
  assert.equal(runtime.restartStageInfo().includePlugins, false, 'an explicit false is reported as false')

  // ⑤ NOTHING STATEMENT: a caller that says nothing leaves `null`, never a guess.
  runtime.markRestartStage('waiting', { reason: 'deferred: conversation-active', includePlugins: null })
  assert.equal(runtime.state.restartPhase.includePlugins, null, 'a stage nobody scoped reports null')
  assert.equal(runtime.restartStageInfo().includePlugins, null)
})
