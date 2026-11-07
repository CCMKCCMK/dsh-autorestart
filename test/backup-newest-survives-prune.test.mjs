/**
 * THE RESTART'S OWN SNAPSHOT MUST STILL BE THERE AFTERWARDS
 * (user report, 2026-11-02: "it says it took a snapshot, and the list still
 * shows yesterday's two copies").
 *
 * WHAT REALLY HAPPENED ON THE MACHINE (checked against the files, not guessed):
 *   - `last-restart-verdict.json` for generation 267 says `snapshot.taken: true`,
 *     `dir: …/backups/2026-11-02T13-02-51-890Z`, `bytes: 161490311`,
 *     `durationMs: 1418`, `error: null` — the copy WAS written and published;
 *   - `backups/` holds only `2026-11-01T13-33-42-271Z` (0.1 MB, no trigger, never
 *     proven) and `2026-11-01T23-14-17-160Z` (148.5 MB, the proven one);
 *   - `cordis.patch.yml` says `maxBackups: 2`.
 *
 * So the copy was not "never taken" and not "half written": it was DELETED by a
 * later prune. `pruneBackups` protected the oldest copy and the newest certified
 * one and then spent its whole budget on… the newest copy, because that was the
 * only one left unprotected. The restart threw away its own rollback point.
 *
 * The rules pinned here:
 *   1. the NEWEST copy is never a victim — whatever the limit is;
 *   2. the "oldest reference" is spared only when the budget can be met without
 *      it (it must never be the reason the newest one dies);
 *   3. a real restart path leaves its snapshot on disk with a manifest, a
 *      meta.json and `trigger: pre-restart`, and the number of copies matches
 *      `maxBackups`;
 *   4. a record must not keep claiming a copy that is gone: `snapshotTaken`
 *      becomes false and `snapshotMissing` says why.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildRestartRequestRecord,
  createRuntime,
  normalizeConfig,
  readRestartRequestRecord,
  restartRequestPath,
  writeRestartRequestRecord,
} from '../index.js'
import {
  BACKUP_TRIGGERS,
  MANIFEST_NAME,
  pruneBackups,
  readBackupMeta,
  readManifest,
  writeBackupMeta,
} from '../lib/backup.js'
import { writeRestartVerdict } from '../lib/restart-verdict.js'
import { requestRestart } from '../lib/checkpoint.js'

/* ------------------------------------------------------------------ *
 * Fixtures
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

/** A profile, a state directory and its backups root. */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-prune-${label}-`))
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
  const stateDir = path.join(base, 'storage')
  fs.mkdirSync(stateDir, { recursive: true })
  return { base, profile, stateDir, stateFile: path.join(stateDir, 'state.json'), backups: path.join(stateDir, 'backups') }
}

/**
 * THE TWO `meta.json` SHAPES THAT WERE REALLY ON THE MACHINE (read off the disk,
 * 2026-11-02 — not invented for the test):
 *
 *   - the first-install seed from Nov 1 21:33 (`certifiedBy: seed`,
 *     `contentScope: config-only`) — 0.1 MB;
 *   - the copy the boot on Nov 2 07:14 promoted (`certifiedBy: full-checks`,
 *     `certificationEvidence: fingerprint-match`, `contentScope: config+links`)
 *     — 148.5 MB.
 *
 * BOTH are restore-eligible, which is exactly why the newest copy was the only
 * unprotected one.
 */
const REAL_SEED_META = {
  kind: 'known-good',
  at: 1793540022271,
  version: '0.8.7',
  bootId: '7a07b24a-140e-45ce-9f96-7e09259b0b80',
  requestId: null,
  reason: 'first-install',
  upgradedAt: null,
  certifiedBy: 'seed',
  certificationEvidence: null,
  certifiedAt: '2026-11-01T13:33:42.271Z',
  contentFingerprint: 'sha256:7a48cabb51a22e65e607c4c9bc5cecad86fb64dbb45326e7cff2a4c415441be0',
  contentScope: 'config-only',
  intervention: null,
}

const REAL_PROVEN_META = {
  kind: 'known-good',
  at: 1793574857160,
  version: null,
  bootId: null,
  requestId: null,
  reason: 'boot-ok',
  upgradedAt: 1793574886355,
  certifiedBy: 'full-checks',
  certificationEvidence: 'fingerprint-match',
  certifiedAt: '2026-11-01T23:14:46.355Z',
  contentFingerprint: 'sha256:e05dde16bda04f7e7e034f52e31bda07ecec776ab9c441c1045291ff61f2e24c',
  contentScope: 'config+links',
  intervention: false,
}

/** One copy on disk: manifest, a meta.json exactly as the machine had it, and a config. */
function seedCopy(backups, name, { meta = null, bytes = 148_000_000 } = {}) {
  const dir = path.join(backups, name)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: ' + name + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({
    at: meta === null ? undefined : meta.at,
    atLocal: null,
    bytes,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  if (meta !== null) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

/** The three shapes that were on the real machine. */
const OLD_JUNK = '2026-11-01T13-33-42-271Z'
const PROVEN = '2026-11-01T23-14-17-160Z'
const TONIGHT = '2026-11-02T13-02-51-890Z'

function seedRealShapes(backups, { withTonight = false } = {}) {
  seedCopy(backups, OLD_JUNK, { meta: REAL_SEED_META, bytes: 102_400 })
  seedCopy(backups, PROVEN, { meta: REAL_PROVEN_META })
  if (withTonight) {
    seedCopy(backups, TONIGHT, {
      meta: { ...REAL_PROVEN_META, at: Date.UTC(2026, 10, 2, 13, 2, 51), certifiedBy: null, certificationEvidence: null },
      bytes: 161_490_311,
    })
  }
}

/* ------------------------------------------------------------------ *
 * ① THE EXACT REAL CASE: limit 2, three copies, the newest is TONIGHT'S.
 * ------------------------------------------------------------------ */

test('① with maxBackups 2 the prune deletes the unproven leftover, never the newest snapshot', (t) => {
  const setup = fixture(t, 'real')
  seedRealShapes(setup.backups, { withTonight: true })

  const result = pruneBackups(setup.backups, 2)

  // BEFORE the fix this exact call returned `removed: [TONIGHT]` — the restart's
  // own 161 MB snapshot — and left the 0.1 MB leftover behind.
  assert.deepEqual(result.removed, [OLD_JUNK], 'the unproven leftover is the victim: ' + JSON.stringify(result))
  const left = fs.readdirSync(setup.backups).sort()
  assert.deepEqual(left, [PROVEN, TONIGHT].sort(), 'the newest copy and the proven one are still there')
  assert.equal(fs.existsSync(path.join(setup.backups, TONIGHT, MANIFEST_NAME)), true, 'the newest copy is a real backup')
  assert.equal(fs.existsSync(path.join(setup.backups, OLD_JUNK)), false, 'the leftover really went')
})

test('① the newest copy survives even when the limit is smaller than the protected set', (t) => {
  const setup = fixture(t, 'limit-1')
  seedRealShapes(setup.backups, { withTonight: true })

  const result = pruneBackups(setup.backups, 1)

  assert.equal(result.removed.includes(TONIGHT), false, 'never the copy the restart just took')
  assert.equal(result.removed.includes(PROVEN), false, 'never the proven one either')
  const left = fs.readdirSync(setup.backups).sort()
  assert.deepEqual(left, [PROVEN, TONIGHT].sort(), 'what is left is exactly the two protected copies')
  assert.match(
    String(result.reason ?? ''),
    /not reached/,
    'and "the limit could not be reached" is said out loud instead of looking like a finished prune: ' + result.reason,
  )
})

/* ------------------------------------------------------------------ *
 * ② A REAL RESTART PATH: the copy is written, published, AND still there.
 * ------------------------------------------------------------------ */

test('② a real restart leaves its snapshot on disk with manifest, meta.json and trigger=pre-restart', async (t) => {
  const setup = fixture(t, 'restart')
  seedRealShapes(setup.backups)
  const before = fs.readdirSync(setup.backups).sort()

  const commands = []
  const runtime = createRuntime(hostContext(), normalizeConfig({
    stateFile: setup.stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
    // THE VALUE THE REAL MACHINE RUNS WITH.
    maxBackups: 2,
  }), {
    env: { isDesktopApp: false, appExePath: null },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    launchWatcher: () => ({ ok: false, method: 'none', error: 'the test launches no watcher', verified: 'nothing', pid: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })

  requestRestart(runtime.state, { reason: 'the user asked for a restart', bySessionId: 'sess-restart' })
  await runtime.executeRestart()

  assert.deepEqual(commands, ['restart-the-host'], 'the restart really ran')

  const after = fs.readdirSync(setup.backups).sort()
  const added = after.filter((name) => !before.includes(name))
  assert.equal(added.length, 1, 'exactly one new copy appeared: ' + JSON.stringify(after))
  const fresh = added[0]

  // THE ACCEPTANCE: the copy is there, complete, and identified.
  const freshDir = path.join(setup.backups, fresh)
  assert.equal(fs.existsSync(path.join(freshDir, MANIFEST_NAME)), true, 'the new copy carries a manifest')
  const manifest = readManifest(freshDir)
  assert.equal(manifest.profileDir, setup.profile, 'the manifest points at the profile that was copied')
  const meta = readBackupMeta(freshDir)
  assert.notEqual(meta, null, 'the new copy carries a meta.json (its identity)')
  assert.equal(meta.trigger, BACKUP_TRIGGERS.PRE_RESTART, 'and the trigger says what put it there')
  assert.equal(Number.isFinite(meta.at), true, 'with the moment it was taken')

  // THE LIMIT IS RESPECTED, AND THE NEW COPY IS ONE OF THE SURVIVORS.
  assert.equal(after.length, 2, 'maxBackups 2 means two copies, got: ' + JSON.stringify(after))
  assert.ok(after.includes(fresh), 'the copy this restart just took is still there: ' + fresh)
  assert.equal(after.includes(OLD_JUNK), false, 'the unproven leftover is the one that went')
  assert.ok(after.includes(PROVEN), 'the proven copy was not sacrificed')
})

/* ------------------------------------------------------------------ *
 * ③ A RECORD MUST NOT CLAIM A COPY THAT IS GONE.
 * ------------------------------------------------------------------ */

test('③ the request record names its snapshot, and stops claiming it once the copy is gone', (t) => {
  const setup = fixture(t, 'record')
  const dir = seedCopy(setup.backups, TONIGHT, {
    meta: { ...REAL_PROVEN_META, at: Date.UTC(2026, 10, 2, 13, 2, 51), certifiedBy: null, certificationEvidence: null },
    bytes: 161_490_311,
  })
  const runtime = createRuntime(hostContext(), normalizeConfig({ stateFile: setup.stateFile }), {
    env: { isDesktopApp: false, appExePath: null },
  })

  const record = buildRestartRequestRecord({
    result: 'cancelled',
    reason: 'consumed-by-boot',
    by: 'boot-recovery',
    restart: { generation: 267, requestedAt: Date.UTC(2026, 10, 2, 13, 2, 36), attempt: 1, snapshot: { dir, bytes: 161_490_311 } },
  })
  assert.equal(record.snapshotTaken, true)
  assert.equal(record.snapshotDir, dir, 'the directory is ON the record, so a reader can check it')

  writeRestartRequestRecord(setup.stateDir, record)
  assert.equal(readRestartRequestRecord(setup.stateDir).snapshotDir, dir)
  assert.equal(runtime.restartRequestOutcome().snapshotTaken, true, 'while the copy exists, "taken" is the truth')

  // THE COPY IS DELETED (what a prune used to do) — the record must follow.
  fs.rmSync(dir, { recursive: true, force: true })
  const after = runtime.restartRequestOutcome()
  assert.equal(after.snapshotTaken, false, 'a copy that is gone is not "taken" any more')
  assert.equal(after.snapshotMissing, true, 'and the reason is said out loud')
  assert.equal(after.snapshotDir, dir, 'the directory stays readable as history')
})

test('③ the restart verdict marks a vanished snapshot as taken:false + missing', (t) => {
  const setup = fixture(t, 'verdict')
  const dir = seedCopy(setup.backups, TONIGHT, {
    meta: { ...REAL_PROVEN_META, at: Date.UTC(2026, 10, 2, 13, 2, 51), certifiedBy: null, certificationEvidence: null },
    bytes: 161_490_311,
  })
  writeRestartVerdict(setup.stateDir, {
    result: 'ok',
    mode: 'app',
    generation: 267,
    startedAt: Date.UTC(2026, 10, 2, 13, 2, 53),
    snapshot: { requested: true, taken: true, dir, stamp: TONIGHT, bytes: 161_490_311 },
    checks: [{ name: 'listener', ok: true }],
    reason: 'the new instance came up',
  })
  const runtime = createRuntime(hostContext(), normalizeConfig({ stateFile: setup.stateFile }), {
    env: { isDesktopApp: false, appExePath: null },
  })

  const whileThere = runtime.lastRestartVerdict()
  assert.equal(whileThere.snapshot.taken, true, 'the copy exists, so the report says it was taken')
  assert.equal(whileThere.snapshot.dir, dir)

  fs.rmSync(dir, { recursive: true, force: true })
  const after = runtime.lastRestartVerdict()
  assert.equal(after.snapshot.taken, false, 'a snapshot that is no longer on disk is not offered as a rollback point')
  assert.equal(after.snapshot.missing, true, 'instead of silently looking like a usable copy')
  assert.equal(after.snapshot.dir, dir, 'the history is not rewritten')
  assert.equal(after.result, 'ok', 'and the restart itself is still reported as it was')
})

/* ------------------------------------------------------------------ *
 * ⑤ THE FIRST-INSTALL SEED MAY NOT HOLD THE "NEWEST COPY" SLOT.
 * ------------------------------------------------------------------ */

/**
 * One copy on disk, with the FACTS this build writes: a manifest and a
 * `meta.json` that says what put the copy there.
 */
function seedFactsCopy(backups, name, { trigger, at }) {
  const dir = path.join(backups, name)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: ' + name + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({
    at,
    atLocal: name,
    bytes: 1_000_000,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  writeBackupMeta(dir, { trigger, at })
  return dir
}

test('⑤ the first-install SEED does not hold the newest slot: the copy the restart took survives', (t) => {
  const setup = fixture(t, 'seed-slot')
  const OLDEST = '2026-11-01T10-00-00-000Z'
  const OLDER = '2026-11-01T12-00-00-000Z'
  const RESTART = '2026-11-02T10-00-00-000Z'
  // THE SEED WAS WRITTEN LAST — that is the whole point: the seed is taken
  // when the plugin first runs, the snapshot when the restart is scheduled.
  const SEED = '2026-11-03T10-00-00-000Z'

  seedFactsCopy(setup.backups, OLDEST, { trigger: BACKUP_TRIGGERS.PRE_RESTART, at: 1 })
  seedFactsCopy(setup.backups, OLDER, { trigger: BACKUP_TRIGGERS.PRE_RESTART, at: 2 })
  seedFactsCopy(setup.backups, RESTART, { trigger: BACKUP_TRIGGERS.PRE_RESTART, at: 3 })
  seedFactsCopy(setup.backups, SEED, { trigger: BACKUP_TRIGGERS.FIRST_INSTALL, at: 4 })

  const result = pruneBackups(setup.backups, 2)

  // BEFORE THE FIX this exact call returned `removed: [OLDER, RESTART]` — the
  // restart's own snapshot — because the seed sorted last and took the "the
  // newest copy is never a victim" slot.
  assert.equal(
    result.removed.includes(RESTART),
    false,
    'the copy the restart took is not a victim: ' + JSON.stringify(result.removed),
  )
  assert.deepEqual(result.removed, [OLDEST, OLDER], 'the two oldest copies went instead')
  assert.equal(
    fs.existsSync(path.join(setup.backups, RESTART)),
    true,
    'the restart snapshot is still on disk',
  )
  assert.equal(
    fs.existsSync(path.join(setup.backups, SEED)),
    true,
    'and the seed is spared too — it is preferred, and there was room',
  )
  assert.deepEqual(result.failures, [], 'and nothing failed')
  assert.equal(result.shellCount, 0, 'every directory here is a real copy')
})

/* ------------------------------------------------------------------ *
 * ④ THE FILE THE RECORD IS WRITTEN TO IS THE ONE THIS PLUGIN READS.
 * ------------------------------------------------------------------ */

test('④ the request record is written where the plugin reads it', (t) => {
  const setup = fixture(t, 'path')
  const record = buildRestartRequestRecord({ result: 'queued', restart: { generation: 1, requestedAt: Date.now() } })
  const written = writeRestartRequestRecord(setup.stateDir, record)
  assert.equal(written.ok, true, String(written.error))
  assert.equal(written.path, restartRequestPath(setup.stateDir), 'one writer, one path')
})
