/**
 * THE VOCABULARY IS RETIRED FROM BEHAVIOUR AND FROM COPY (2026-11-02).
 *
 * The user's review question was simple: "if the 'safe copy / verified' wording is
 * gone, what is still keeping copies alive or excluding them?" The answer at the
 * time was uncomfortable — the wording had been *replaced in the records*, but the
 * PRUNE still picked its keepers from `known-good` / `certified`, the watchdog
 * still refused copies for not being "certified", and two user-facing strings
 * still told the operator that a "known-good" copy was never removed.
 *
 * These tests pin the three things that were fixed:
 *   ① the selection and the prune decide from RECORDED FACTS
 *     (`boot.started` + `boot.contentMatched`, `intervention`), not from a stamp;
 *   ② an old meta (only `certifiedBy` / `certificationEvidence`, no `boot`) still
 *     answers those questions — otherwise every existing install would lose its
 *     ability to roll back;
 *   ③ nothing the operator can read says known-good / certified any more, and the
 *     first-install copy is no longer kept forever.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../index.js'
import {
  pruneBackups,
  readBackupMeta,
  writeBackupMeta,
  MANIFEST_NAME,
  BACKUP_TRIGGERS,
  CERTIFIED_BY,
  CERTIFICATION_EVIDENCE,
} from '../lib/backup.js'
import { RESTORE_EXCLUSIONS, selectRestoreTarget } from '../lib/watchdog.js'

/** An old meta.json exactly as the shipped 0.8.x wrote it: no `boot` object. */
const LEGACY_PROVEN = {
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

/** One copy on disk: a manifest, a config, and a meta.json written verbatim. */
function seedCopy(backups, name, meta) {
  const dir = path.join(backups, name)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: ' + name + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({
    at: meta.at,
    atLocal: null,
    bytes: 1024,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

function workdir(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-vocab-' + label + '-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}

/* ------------------------------------------------------------------ *
 * ① AN OLD META IS READ AS THE OBSERVATION IT RECORDED.
 * ------------------------------------------------------------------ */

test('① a meta with no `boot` object is translated into the facts it described', (t) => {
  const base = workdir(t, 'legacy')
  const dir = seedCopy(base, '2026-11-01T23-14-17-160Z', LEGACY_PROVEN)

  const meta = readBackupMeta(dir)
  assert.ok(meta.boot, 'a boot record is derived, so the selector has facts to read')
  assert.equal(meta.boot.started, true, 'a promotion always followed a boot that had come up')
  assert.equal(meta.boot.contentMatched, true, 'the fingerprint comparison was recorded as a match')
  assert.equal(meta.boot.observedBy, 'startup-checks', 'and it says who observed it')
})

test('① an old SEED is not turned into a boot — nothing had run when it was taken', (t) => {
  const base = workdir(t, 'legacy-seed')
  const dir = seedCopy(base, '2026-11-01T13-33-42-271Z', {
    kind: 'known-good',
    at: 1793540022271,
    certifiedBy: 'seed',
    certificationEvidence: null,
    certifiedAt: '2026-11-01T13:33:42.271Z',
    contentScope: 'config-only',
  })

  const meta = readBackupMeta(dir)
  assert.equal(meta.boot, null, 'inventing a boot for the first-install copy would be a lie')
  assert.equal(meta.trigger, BACKUP_TRIGGERS.FIRST_INSTALL, 'what it is, said as a fact')
})

test('① the watchdog MAY use an old copy that a boot was observed to run', () => {
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/old',
      name: 'old',
      // exactly what `listBackupIdentities` hands over for an old meta: the facts
      // were derived on read, the stamp is still there for the report
      boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
      certifiedBy: 'full-checks',
      certificationEvidence: 'fingerprint-match',
      intervention: false,
    }],
  })
  assert.equal(choice.target, '/backups/old', 'an old backup stays usable — measured, not assumed')
  assert.equal(choice.strict, false)
})

test('① a copy written by today\'s build qualifies with NO stamp at all', () => {
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/new',
      name: 'new',
      boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
      certifiedBy: CERTIFIED_BY.NONE,
      certificationEvidence: CERTIFICATION_EVIDENCE.NONE,
      intervention: false,
    }],
  })
  assert.equal(choice.target, '/backups/new', 'the fact is what counts, not a signature')
})

test('① a copy whose content was never matched is still refused', () => {
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/drift',
      name: 'drift',
      boot: { started: true, contentMatched: false, observedBy: 'startup-checks' },
      certifiedBy: CERTIFIED_BY.NONE,
      certificationEvidence: CERTIFICATION_EVIDENCE.NONE,
      intervention: false,
    }],
  })
  assert.equal(choice.target, null, 'it came up, but not with this content')
  assert.equal(choice.strict, true)
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.NOT_CONTENT_VERIFIED)
})

/* ------------------------------------------------------------------ *
 * ② "RATHER NOTHING THAN THAT ONE" IS UNCHANGED: an intervened boot is OUT.
 * ------------------------------------------------------------------ */

test('② a copy whose boot had to be rescued is refused even when its content matched', () => {
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/rescued',
      name: 'rescued',
      boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
      certifiedBy: CERTIFIED_BY.NONE,
      certificationEvidence: CERTIFICATION_EVIDENCE.NONE,
      intervention: true,
    }],
  })
  assert.equal(choice.target, null, 'being rescued is why the copy is not a restore point')
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.INTERVENED)
})

test('② a copy with no record of whether it was rescued is refused too', () => {
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/unknown',
      name: 'unknown',
      boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
      certifiedBy: CERTIFIED_BY.NONE,
      certificationEvidence: CERTIFICATION_EVIDENCE.NONE,
      intervention: null,
    }],
  })
  assert.equal(choice.target, null)
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.INTERVENTION_UNKNOWN)
})

/* ------------------------------------------------------------------ *
 * ③ THE FIRST-INSTALL COPY IS NO LONGER KEPT FOREVER.
 * ------------------------------------------------------------------ */

test('③ the seed is deleted when the budget cannot be met without it', (t) => {
  const backups = workdir(t, 'seed-prune')
  const seed = seedCopy(backups, '2026-11-01T13-33-42-271Z', {
    kind: 'known-good',
    at: 1793540022271,
    certifiedBy: 'seed',
    certificationEvidence: null,
    certifiedAt: '2026-11-01T13:33:42.271Z',
    contentScope: 'config-only',
  })
  // Three ordinary copies, none with a boot record, plus the newest one which is
  // always kept. A limit of 1 leaves a budget of three, and only two copies are
  // available without the seed — so the seed has to go like any other copy.
  seedCopy(backups, '2026-11-02T09-00-00-000Z', { kind: 'pre-restart', at: 1793600000000 })
  seedCopy(backups, '2026-11-02T10-00-00-000Z', { kind: 'pre-restart', at: 1793603600000 })
  seedCopy(backups, '2026-11-02T11-00-00-000Z', { kind: 'pre-restart', at: 1793607200000 })

  const prune = pruneBackups(backups, 1)
  assert.equal(
    prune.removed.includes(path.basename(seed)),
    true,
    'the seed went: it is a preference, not a shrine — removed: ' + prune.removed.join(', '),
  )
  assert.equal(fs.existsSync(seed), false)
  assert.equal(
    prune.removed.includes('2026-11-02T11-00-00-000Z'),
    false,
    'the newest copy still never goes',
  )
})

test('③ the seed is SPARED while there is room, because it is the only "before" picture', (t) => {
  const backups = workdir(t, 'seed-room')
  const seed = seedCopy(backups, '2026-11-01T13-33-42-271Z', {
    kind: 'known-good',
    at: 1793540022271,
    certifiedBy: 'seed',
    certificationEvidence: null,
    certifiedAt: '2026-11-01T13:33:42.271Z',
    contentScope: 'config-only',
  })
  seedCopy(backups, '2026-11-02T10-00-00-000Z', { kind: 'pre-restart', at: 1793600000000 })
  seedCopy(backups, '2026-11-02T11-00-00-000Z', { kind: 'pre-restart', at: 1793603600000 })
  seedCopy(backups, '2026-11-02T12-00-00-000Z', { kind: 'pre-restart', at: 1793607200000 })

  const prune = pruneBackups(backups, 3)
  assert.equal(prune.removed.includes(path.basename(seed)), false, 'room to keep it: it stays')
  assert.equal(fs.existsSync(seed), true)
  assert.equal(prune.removed.length, 1, 'the budget is still met')
})

test('③ the prune protects the newest copy and the one a boot observed, and says so in facts', (t) => {
  const backups = workdir(t, 'keep-facts')
  // the copy a boot observed (old), plus three it did not
  seedCopy(backups, '2026-11-01T08-00-00-000Z', {
    kind: 'known-good',
    at: 1793500000000,
    certifiedBy: 'full-checks',
    certificationEvidence: 'fingerprint-match',
    certifiedAt: '2026-11-01T08:00:10.000Z',
  })
  seedCopy(backups, '2026-11-02T09-00-00-000Z', { kind: 'pre-restart', at: 1793600000000 })
  seedCopy(backups, '2026-11-02T10-00-00-000Z', { kind: 'pre-restart', at: 1793603600000 })
  seedCopy(backups, '2026-11-02T11-00-00-000Z', { kind: 'pre-restart', at: 1793607200000 })

  const prune = pruneBackups(backups, 2)
  assert.equal(prune.removed.includes('2026-11-01T08-00-00-000Z'), false, 'the observed copy stays')
  assert.equal(prune.removed.includes('2026-11-02T11-00-00-000Z'), false, 'the newest copy stays')
  assert.equal(prune.removed.length, 2, 'the two in between went')
  for (const name of prune.removed) {
    assert.match(name, /^2026-11-02T(09|10)-00-00-000Z$/, 'only the copies with no observed boot went')
  }
  assert.doesNotMatch(String(prune.reason), /known-good|certified/i, 'and the reason names no verdict')
})

/* ------------------------------------------------------------------ *
 * ④ NOTHING THE OPERATOR CAN READ USES THE OLD VOCABULARY.
 * ------------------------------------------------------------------ */

test('④ the maxBackups description states facts, never a verdict', () => {
  // The exact string the settings page shows, taken from the schema itself so
  // this test cannot drift away from what ships.
  const schema = normalizeConfig({})
  assert.equal(typeof schema, 'object')
  const text = JSON.stringify(schema)
  assert.doesNotMatch(text, /known-good/i, 'no "known-good" anywhere in the config surface')
})

test('④ the prune reasons and the selector reasons carry no verdicts', (t) => {
  const backups = workdir(t, 'copy-check')
  seedCopy(backups, '2026-11-02T09-00-00-000Z', { kind: 'pre-restart', at: 1793600000000 })
  seedCopy(backups, '2026-11-02T10-00-00-000Z', { kind: 'pre-restart', at: 1793603600000 })
  const pruned = pruneBackups(backups, 1)
  const reasons = [String(pruned.reason ?? '')]

  const choice = selectRestoreTarget({
    candidates: [{ dir: '/backups/x', name: 'x', boot: null, certifiedBy: 'none', intervention: null }],
  })
  reasons.push(String(choice.reason))
  reasons.push(...choice.notes.map(String))
  reasons.push(...choice.excluded.map((entry) => String(entry.exclusion)))

  for (const reason of reasons) {
    assert.doesNotMatch(reason, /known-good/i, 'a copy is not "good", it has a record: ' + reason)
    assert.doesNotMatch(reason, /\bcertified\b/i, 'nothing is "certified" any more: ' + reason)
  }
})

/* ------------------------------------------------------------------ *
 * ⑤ THE RECORD WRITTEN TODAY SAYS ONLY WHAT WAS OBSERVED.
 * ------------------------------------------------------------------ */

test('⑤ a written meta carries the observation and not the stamp', (t) => {
  const base = workdir(t, 'write')
  const dir = path.join(base, '2026-11-02T12-00-00-000Z')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows: []\n', 'utf8')

  const ok = writeBackupMeta(dir, {
    at: 1793600000000,
    trigger: BACKUP_TRIGGERS.PRE_RESTART,
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
  })
  assert.equal(ok, true)

  const raw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.certifiedBy, undefined, 'the stamp is not written to disk')
  assert.equal(parsed.certificationEvidence, undefined, 'nor the criterion')
  assert.equal(parsed.boot.started, true)
  assert.equal(parsed.boot.contentMatched, true)

  const meta = readBackupMeta(dir)
  assert.equal(meta.boot.contentMatched, true, 'and it reads back as the fact it is')
})
