/**
 * THE IDENTITY OF A BACKUP — the library half of the 2026-10-30 backup
 * semantics (lib/backup.js only; nothing here drives a restart).
 *
 * WHY (user report, 2026-10-30): a pre-restart snapshot is taken BEFORE the
 * restart, i.e. it holds exactly the state that is about to be tested — the
 * state that may be what breaks the boot. Rolling a broken host back onto such
 * a copy would restore the very thing that failed. So every copy carries an
 * identity in `meta.json`:
 *
 *   'snapshot'    taken before a restart, NOT proven;
 *   'known-good'  a restart with this content really came up;
 *   'unknown'     no meta.json (written before this rule) — never used
 *                 automatically.
 *
 * What is pinned here:
 *   1. `DEFAULT_MAX_BACKUPS` is 3 (the current copy plus the two before it);
 *   2. pruning still throws away the OLDEST copies when the limit is exceeded;
 *   3. pruning NEVER throws away the newest known-good copy — not even when it
 *      is the oldest one on disk;
 *   4. a copy without a meta.json reads as 'unknown' and is never the answer of
 *      `latestKnownGood`;
 *   5. `markKnownGood` promotes a copy (keeping its version) and makes it the
 *      `latestKnownGood`;
 *   6. `createBackup` writes the identity (default `'snapshot'`) and accepts the
 *      other two kinds.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BACKUP_TRIGGERS,
  backupsRoot,
  BOOT_OBSERVATIONS,
  CERTIFICATION_EVIDENCE,
  CERTIFIED_BY,
  contentFingerprintOf,
  contentScopeOf,
  CONTENT_SCOPES,
  createBackup,
  DEFAULT_MAX_BACKUPS,
  isCertifiedBackup,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  KIND_UNKNOWN,
  latestKnownGood,
  listBackupIdentities,
  markKnownGood,
  META_NAME,
  pruneBackups,
  readBackupMeta,
  writeBackupMeta,
} from '../lib/backup.js';

/**
 * THE VERDICT WORDS THAT MUST NO LONGER BE WRITTEN TO A meta.json (2026-11-02).
 *
 * The user's decision was "记录里也一起清掉": a record may answer WHEN, WHAT
 * TRIGGERED IT and WHAT THE BOOT SAID, and may not answer "is this copy safe".
 * Asserting their ABSENCE is the only way a future edit cannot quietly bring the
 * old register back — the read side still derives those words, so nothing else
 * would notice.
 */
const VERDICT_FIELDS = ['kind', 'reason', 'certifiedBy', 'certificationEvidence', 'certifiedAt'];

/** The `meta.json` of a copy, parsed — what is really on disk. */
function rawMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, META_NAME), 'utf8'));
}

/** Every verdict word is gone from the file on disk. */
function assertFactsOnly(dir) {
  const raw = rawMeta(dir);
  for (const field of VERDICT_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(raw, field),
      false,
      `meta.json must not carry the verdict field "${field}"`,
    );
  }
  assert.equal(typeof raw.takenAt, 'string', 'it says WHEN the copy was taken');
  assert.equal(typeof raw.trigger, 'string', 'and WHAT put it there');
  return raw;
}

/** A profile-looking tree and an empty backups directory. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-identity-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, profile, storage, backups: backupsRoot(storage) };
}

/** One configuration-only backup at a fixed moment. */
function takeBackup(profile, backups, now, options = {}) {
  return createBackup({ slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: false,
    now,
    ...options,
  });
}

/** One backup directory with a manifest and nothing else (an old copy). */
function rawBackup(backups, stamp) {
  const dir = path.join(backups, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ at: 1, bytes: 10, files: [] }), 'utf8');
  return dir;
}

/** The stamps on disk, oldest first. */
function names(backups) {
  return fs.readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('① TWO backups are kept by default (the design: one safe + one newest)', () => {
  // CHANGED 2026-11-02 (design): at most two copies — one verified "safe" copy
  // plus the newest unverified one. It used to be twenty, which is exactly why a
  // hosted instance that was never configured kept seventeen copies and never
  // pruned: nothing was ever over the ceiling.
  assert.equal(DEFAULT_MAX_BACKUPS, 2, 'two copies: one safe, one newest');
});

test('② pruning above the limit removes the OLDEST copies', async (t) => {
  const { profile, backups } = fixture(t);
  const made = [];
  for (const now of [1_000, 2_000, 3_000, 4_000, 5_000]) {
    // An EXPLICIT limit: this test is about the ORDER of pruning, and the
    // default is two copies since 2026-11-02, so five would already be pruned.
    const result = await takeBackup(profile, backups, now, { maxBackups: 20 });
    assert.equal(result.ok, true);
    made.push(result);
  }

  // Five is far below the limit this test asked for, so nothing is pruned yet.
  const left = names(backups);
  assert.equal(left.length, 5, 'five backups are well inside the limit of twenty');
  for (const kept of made) {
    assert.equal(left.includes(kept.stamp), true, 'every copy survives');
  }

  // PRUNING NEEDS ONE CERTIFIED COPY TO EXIST AT ALL (2026-11-01, strict mode):
  // with no evidence anywhere, nothing is deleted. The fixture therefore
  // certifies the oldest copy — which the pre-existing "keep the oldest" floor
  // protects anyway — so the pruning SHAPE below is the one being checked.
  assert.equal(markKnownGood(made[0].dir, { reason: 'seed', certifiedBy: 'seed' }).promoted, true);

  // Ask for two explicitly: pruning removes what exceeds the limit, EXCEPT the
  // oldest, which is now permanent.
  const prune = pruneBackups(backups, 2);
  const removed = prune.removed;
  assert.equal(prune.skipped, false, 'the floor did not kick in: a certified copy exists');
  assert.equal(removed.includes(made[0].stamp), false, 'the oldest copy is permanently kept');
  const after = names(backups);
  assert.equal(after.includes(made[0].stamp), true, 'and it is still on disk');
  assert.equal(after.includes(made[4].stamp), true, 'the newest one survives');
  // Five copies, limit two: three victims. The oldest is protected, so the three
  // middle ones go and the survivors are the newest plus that permanent oldest.
  assert.equal(removed.length, 3, 'three copies were pruned');
  assert.equal(after.length, 2, 'the newest plus the permanent oldest survive');
  for (const middle of made.slice(1, 4)) {
    assert.equal(after.includes(middle.stamp), false, 'a middle copy was pruned');
  }
});

test('③ pruning NEVER removes the newest known-good copy', (t) => {
  const { backups } = fixture(t);
  // Four old copies; the OLDEST one is the known-good one — the hard case,
  // because the "oldest first" order would delete it on the very first step.
  const stamps = [
    '2026-01-01T00-00-00-000Z',
    '2026-01-02T00-00-00-000Z',
    '2026-01-03T00-00-00-000Z',
    '2026-01-04T00-00-00-000Z',
  ];
  for (const stamp of stamps) rawBackup(backups, stamp);
  // EVIDENCE IS NOW REQUIRED (2026-11-01): "a boot came up" has to say WHAT was
  // checked, so the fixture names the source instead of hoping for a stamp — and
  // since the criterion is part of the identity, it names that too: a copy with a
  // source and no criterion is the historical pollution, not a safe copy.
  assert.equal(
    markKnownGood(path.join(backups, stamps[0]), { intervention: false,
      reason: 'boot-ok',
      version: '0.8.5',
      certifiedBy: 'full-checks',
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
    }).promoted,
    true,
  );

  // Ask for ONE copy: even then the known-good one survives.
  const removed = pruneBackups(backups, 1).removed;
  assert.equal(removed.includes(stamps[0]), false, 'the known-good copy is never a victim');
  assert.equal(fs.existsSync(path.join(backups, stamps[0])), true, 'it is still on disk');
  assert.equal(latestKnownGood(backups).name, stamps[0], 'and it is still the rollback target');

  // The rest of the pruning still happens — BUT THE NEWEST COPY IS NOW SPARED TOO
  // (2026-11-02, user report: the restart's own snapshot was deleted while a
  // leftover survived). With four copies, a limit of 1 and two absolute keepers
  // (the oldest = the proven one, and the newest), exactly the two in between can
  // go — the limit cannot be reached, and the prune says so.
  assert.equal(removed.length, 2, 'every copy that could go, went');
  assert.equal(removed.includes(stamps[3]), false, 'the newest copy is never a victim either');
  assert.equal(fs.existsSync(path.join(backups, stamps[3])), true, 'it is still on disk');
});

test('④ a copy with no meta.json is "unknown" and never the rollback target', (t) => {
  const { backups } = fixture(t);
  const old = rawBackup(backups, '2026-01-01T00-00-00-000Z');
  rawBackup(backups, '2026-01-02T00-00-00-000Z');

  assert.equal(readBackupMeta(old).kind, KIND_UNKNOWN, 'no meta.json reads as unknown');
  assert.equal(fs.existsSync(path.join(old, META_NAME)), false, 'and nothing was invented on disk');
  assert.equal(latestKnownGood(backups), null, 'an unknown copy is not a rollback target');

  const identities = listBackupIdentities(backups);
  assert.deepEqual(identities.map((entry) => entry.kind), [KIND_UNKNOWN, KIND_UNKNOWN]);
});

test('⑤ markKnownGood promotes a copy and keeps its version', async (t) => {
  const { profile, backups } = fixture(t);
  const snapshot = await takeBackup(profile, backups, 1_000, { version: '0.8.5', requestId: 7, reason: 'before restart' });

  assert.equal(snapshot.kind, KIND_SNAPSHOT, 'a pre-restart copy starts unproven');
  assert.equal(latestKnownGood(backups), null, 'an unproven copy is not a rollback target');

  // EVIDENCE, NOT A STAMP (2026-11-01): the promotion now says which check backed
  // it AND which criterion was applied, so the meta can answer "why is this copy
  // safe?" afterwards.
  assert.equal(
    markKnownGood(snapshot.dir, { intervention: false,
      reason: 'boot-ok',
      version: '0.8.5',
      certifiedBy: 'full-checks',
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
    }).promoted,
    true,
  );
  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD);
  assert.equal(meta.certifiedBy, 'full-checks', 'the source that certified it');
  assert.equal(meta.certificationEvidence, CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH, 'and the criterion that was applied');
  assert.equal(meta.version, '0.8.5', 'the version it was proven with');
  // THE RECORD NOW SAYS WHAT HAPPENED, NOT A VERDICT (2026-11-02): what put the
  // copy there, and what the boot that followed it reported. `reason: 'boot-ok'`
  // said the same two things in one word that reads like a promise.
  assert.equal(meta.trigger, BACKUP_TRIGGERS.PRE_RESTART, 'it was taken before a restart');
  assert.equal(meta.boot.started, true, 'and the boot that followed came up');
  assert.equal(meta.boot.observedBy, BOOT_OBSERVATIONS.STARTUP_CHECKS, 'watched by the four startup checks');
  assert.equal(meta.boot.contentMatched, true, 'running exactly the content this copy holds');
  assert.equal(meta.reason, null, 'the old verdict word is gone from the record');
  assert.equal(meta.requestId, 7, 'the request that took it is kept');
  // AND THE FILE ITSELF carries no verdict: the derivation above belongs to this
  // process, never to the user's disk.
  const raw = assertFactsOnly(snapshot.dir);
  assert.equal(raw.trigger, BACKUP_TRIGGERS.PRE_RESTART);
  assert.equal(raw.boot.started, true);
  assert.equal(raw.boot.contentMatched, true);

  const newest = latestKnownGood(backups);
  assert.ok(newest, 'the promoted copy is the rollback target');
  assert.equal(newest.name, snapshot.stamp);
  assert.equal(newest.kind, KIND_KNOWN_GOOD);
  assert.equal(newest.version, '0.8.5');
});

test('⑥ createBackup writes the identity (snapshot by default) and can be seeded known-good', async (t) => {
  const { profile, backups } = fixture(t);
  const first = await takeBackup(profile, backups, 1_000);
  assert.equal(first.kind, KIND_SNAPSHOT, 'the default identity of a copy is snapshot');
  assert.equal(readBackupMeta(first.dir).kind, KIND_SNAPSHOT);
  assert.equal(readBackupMeta(first.dir).at, 1_000, 'the meta carries the moment of the copy');

  const seed = await takeBackup(profile, backups, 2_000, { kind: KIND_KNOWN_GOOD, reason: 'first install', version: '0.8.5' });
  assert.equal(seed.kind, KIND_KNOWN_GOOD);
  const meta = readBackupMeta(seed.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD);
  // WHAT IT SAYS NOW (2026-11-02): the trigger, and the honest "no boot yet" —
  // the free-text `reason` is no longer a place a copy's story is kept.
  assert.equal(meta.trigger, BACKUP_TRIGGERS.FIRST_INSTALL, 'the fresh installation put this copy there');
  assert.equal(meta.boot, null, 'and nothing has booted on it yet');
  assert.equal(latestKnownGood(backups).name, seed.stamp, 'the seed is the newest known-good');

  // A nonsense kind never silently becomes something else: a copy nobody
  // proved anything about is a snapshot.
  const odd = await takeBackup(profile, backups, 3_000, { kind: 'whatever' });
  assert.equal(odd.kind, KIND_SNAPSHOT);
});

test('writeBackupMeta writes FACTS, and translates the old vocabulary instead of storing it', (t) => {
  const { backups } = fixture(t);
  const dir = rawBackup(backups, '2026-02-01T00-00-00-000Z');
  // An unknown word is not an identity, and it does not become one: the record
  // says NOTHING about what the copy is (no trigger), which reads back as
  // 'unknown' — the same answer a copy written before this layer gives.
  assert.equal(writeBackupMeta(dir, { kind: 'nonsense', version: '1.2.3' }), true);
  assert.equal(readBackupMeta(dir).kind, KIND_UNKNOWN, 'an unknown word is not an identity');
  assert.equal(readBackupMeta(dir).trigger, null, 'and nothing is claimed about what put it there');
  assert.equal(readBackupMeta(dir).version, '1.2.3', 'the version survives');
  assert.equal(fs.existsSync(path.join(dir, META_NAME)), true, 'the record itself was still written');

  assert.equal(writeBackupMeta(dir, { kind: KIND_SNAPSHOT }), true);
  assert.equal(readBackupMeta(dir).kind, KIND_SNAPSHOT);
  assert.equal(readBackupMeta(dir).trigger, BACKUP_TRIGGERS.PRE_RESTART, 'a snapshot was taken before a restart');
  assert.equal(readBackupMeta(dir).boot, null, 'nothing was claimed about a boot');
  assertFactsOnly(dir);

  // THE OLD VOCABULARY IS INPUT, NEVER OUTPUT (2026-11-02): a caller that still
  // says `certifiedBy` is answering in the old words, so the answer is turned into
  // the fact it stands for — and the file is checked to prove nothing else leaked.
  assert.equal(
    writeBackupMeta(dir, {
      kind: KIND_KNOWN_GOOD,
      at: 1_000,
      certifiedBy: CERTIFIED_BY.FULL_CHECKS,
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
      certifiedAt: '2026-02-01T00:00:00.000Z',
    }),
    true,
  );
  const translated = readBackupMeta(dir);
  assert.equal(translated.boot.started, true, 'a stated source meant "that boot came up"');
  assert.equal(translated.boot.observedBy, BOOT_OBSERVATIONS.STARTUP_CHECKS, 'and it says what looked at it');
  assert.equal(translated.boot.contentMatched, true, 'and that it ran this content');
  assert.equal(translated.boot.at, '2026-02-01T00:00:00.000Z', 'the moment is the one the caller named');
  assert.equal(translated.certifiedBy, CERTIFIED_BY.FULL_CHECKS, 'the old vocabulary is derived back on read');
  assertFactsOnly(dir);
});

/* ==================================================================== *
 * THE EVIDENCE LAYER (2026-11-01, strict mode, phase 1).
 *
 * WHY THIS SECTION EXISTS: the incident shape was not "the backup was missing",
 * it was "the backup was certified without being checked". `markKnownGood`
 * stamped the PRE-RESTART snapshot as known-good with the fixed reason
 * 'boot-ok', and when that boot only came up because somebody intervened, the
 * bad state became the certified safe copy. The watchdog then restored onto it
 * and every report said everything was fine.
 *
 * What is pinned here:
 *   1. every copy carries its OWN evidence (source, time, content fingerprint,
 *      content scope, whether the boot needed help);
 *   2. an OLD meta.json (written before this layer) reads as "not certified" —
 *      no throw, no crash, and above all never "safe";
 *   3. `markKnownGood` no longer stamps anything by itself: with no evidence, or
 *      evidence of 'none', it reports "not promoted" and does not touch meta;
 *   4. pruning keeps the last certified copy, and deletes NOTHING when there is
 *      no certified copy at all — the decision is recorded in the answer, so the
 *      upper layer can tell the user instead of staying silent.
 * ==================================================================== */

/** A profile-looking tree (WITH a plugin tree) and an empty backups directory. */
function certFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-certified-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, profile, storage, backups: backupsRoot(storage) };
}

/** One finished copy (manifest, optional old-style meta) at a fixed name. */
function certRawBackup(backups, name, options = {}) {
  const dir = path.join(backups, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: ' + name + '\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ at: 1_000, atLocal: name, bytes: 10, files: ['cordis.patch.yml'], includePlugins: false }),
    'utf8',
  );
  if (options.meta !== undefined) {
    fs.writeFileSync(path.join(dir, META_NAME), JSON.stringify(options.meta), 'utf8');
  }
  return dir;
}

/** The names on disk, oldest first. */
function certNames(backups) {
  return fs.readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('⑦ an old meta.json (no evidence fields) reads as NOT certified, without throwing', (t) => {
  const { backups } = certFixture(t);
  // Exactly what the previous version wrote: identity, times, nothing else.
  const old = certRawBackup(backups, '2026-01-01T00-00-00-000Z', {
    meta: { kind: KIND_KNOWN_GOOD, at: 1_000, version: '0.8.5', reason: 'boot-ok' },
  });
  const bare = certRawBackup(backups, '2026-01-02T00-00-00-000Z');

  const meta = readBackupMeta(old);
  // The old fields keep their meaning...
  assert.equal(meta.kind, KIND_KNOWN_GOOD, 'the old identity is still read');
  assert.equal(meta.version, '0.8.5');
  // ...and the missing evidence is "we cannot tell", never "good".
  assert.equal(meta.certifiedBy, CERTIFIED_BY.NONE, 'no evidence means NOT certified');
  assert.equal(meta.certifiedAt, null);
  assert.equal(meta.contentFingerprint, null);
  assert.equal(meta.contentScope, null);
  assert.equal(meta.intervention, null, 'an unrecorded intervention is null, not false');

  // A directory with no meta.json at all takes the same path — no exception.
  assert.equal(readBackupMeta(bare).certifiedBy, CERTIFIED_BY.NONE);
  assert.equal(readBackupMeta(path.join(backups, 'does-not-exist')).certifiedBy, CERTIFIED_BY.NONE);

  // And the listing carries the verdict, so a report can say "unproven".
  const listed = listBackupIdentities(backups);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((entry) => entry.certified), [false, false]);
  assert.deepEqual(listed.map((entry) => entry.certifiedBy), [CERTIFIED_BY.NONE, CERTIFIED_BY.NONE]);
});

test('⑦ a nonsense value in the evidence fields degrades to "not certified"', (t) => {
  const { backups } = certFixture(t);
  const dir = certRawBackup(backups, '2026-01-03T00-00-00-000Z', {
    meta: {
      kind: KIND_SNAPSHOT,
      certifiedBy: 'trust-me',
      certifiedAt: 'yesterday-ish',
      contentFingerprint: 42,
      contentScope: 'everything',
      intervention: 'maybe',
    },
  });
  const meta = readBackupMeta(dir);
  assert.equal(meta.certifiedBy, CERTIFIED_BY.NONE, 'an unknown source is not a source');
  assert.equal(meta.certifiedAt, null, 'an unparseable moment is no moment');
  assert.equal(meta.contentFingerprint, null);
  assert.equal(meta.contentScope, null, 'an unknown scope is not one of the four');
  assert.equal(meta.intervention, null, 'a non-boolean intervention is unrecorded');
});

test('⑦ markKnownGood writes the evidence: source, time, fingerprint, scope, intervention', async (t) => {
  const { profile, backups } = certFixture(t);
  const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 1_000 });
  assert.equal(backup.ok, true);

  // A freshly taken copy is NOT certified: it was taken before anything was
  // proven. It does carry its own fingerprint and scope, though — those describe
  // the CONTENT, not a verdict about it.
  const before = readBackupMeta(backup.dir);
  assert.equal(before.kind, KIND_SNAPSHOT);
  assert.equal(before.certifiedBy, CERTIFIED_BY.NONE);
  assert.equal(before.certifiedAt, null);
  assert.match(String(before.contentFingerprint), /^sha256:[0-9a-f]{64}$/, 'the content is fingerprinted at creation');
  assert.equal(before.contentScope, CONTENT_SCOPES.CONFIG_ONLY, 'no plugin tree was copied');

  const certifiedAt = '2026-11-01T10:00:00.000Z';
  const result = markKnownGood(backup.dir, {
    reason: 'the four startup checks passed',
    version: '0.8.5',
    certifiedBy: CERTIFIED_BY.FULL_CHECKS,
    // THE CRITERION IS PART OF THE EVIDENCE (2026-11-01): the fingerprint of this
    // copy was compared with the configuration that really booted.
    certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
    certifiedAt,
    intervention: false,
  });
  assert.equal(result.promoted, true);
  assert.equal(result.reason, 'a boot was observed (full-checks) and it was running this content');

  const after = readBackupMeta(backup.dir);
  assert.equal(after.kind, KIND_KNOWN_GOOD);
  assert.equal(after.certifiedBy, CERTIFIED_BY.FULL_CHECKS, 'which check backed it');
  assert.equal(after.certificationEvidence, CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH, 'and WHICH criterion was applied');
  assert.equal(after.certifiedAt, certifiedAt, 'when it was checked');
  assert.equal(after.contentFingerprint, before.contentFingerprint, 'the same content that was certified');
  assert.equal(after.contentScope, CONTENT_SCOPES.CONFIG_ONLY);
  assert.equal(after.intervention, false, 'this boot needed no help');
  assert.equal(latestKnownGood(backups).dir, backup.dir, 'and it is the rollback target');
});

test('⑦ the four proving sources stay distinguishable', async (t) => {
  const { profile, backups } = certFixture(t);
  const sources = [
    CERTIFIED_BY.FULL_CHECKS,
    CERTIFIED_BY.COMMAND_PROBE,
    CERTIFIED_BY.SEED,
    CERTIFIED_BY.MANUAL_ROLLBACK,
  ];
  const seen = new Set();
  for (const [index, source] of sources.entries()) {
    // An EXPLICIT limit: the point here is the SOURCE of a proof, not pruning
    // (the default is two copies since 2026-11-02).
    const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 2_000 + index, maxBackups: 20 });
    assert.equal(backup.ok, true);
    assert.equal(markKnownGood(backup.dir, { intervention: false, reason: 'r-', certifiedBy: source }).promoted, true);
    const meta = readBackupMeta(backup.dir);
    // THE OLD SOURCE NAME SURVIVES THE ROUND TRIP, because it is derived from the
    // facts on read — but what stands on disk is the observation itself.
    assert.equal(meta.certifiedBy, source, 'the source is derived back from the fact that was stored');
    assertFactsOnly(backup.dir);
    if (source === CERTIFIED_BY.SEED) {
      assert.equal(meta.trigger, BACKUP_TRIGGERS.FIRST_INSTALL, 'a seed is a trigger, not a boot');
      assert.equal(meta.boot, null, 'and it claims no boot it never had');
    } else {
      const observed = source === CERTIFIED_BY.FULL_CHECKS
        ? BOOT_OBSERVATIONS.STARTUP_CHECKS
        : (source === CERTIFIED_BY.COMMAND_PROBE
          ? BOOT_OBSERVATIONS.HEALTH_PROBE
          : BOOT_OBSERVATIONS.MANUAL_ROLLBACK);
      assert.equal(meta.boot.observedBy, observed, 'the record names what really looked at that boot');
      assert.ok(Number.isFinite(Date.parse(meta.boot.at)), 'and when it did');
      assert.equal(meta.boot.contentMatched, false, 'a source with no criterion is still not a proof');
      assert.equal(isCertifiedBackup(meta), false, 'so the copy is not a restore candidate');
    }
    seen.add(meta.certifiedBy);
  }
  assert.equal(seen.size, 4, 'a full check, a health probe, a seed and a manual rollback are four different answers');
});

test('⑦ the seed of a fresh installation is born with its trigger, as "seed"', async (t) => {
  const { profile, backups } = certFixture(t);
  const seed = await createBackup({
    slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: false,
    kind: KIND_KNOWN_GOOD,
    reason: 'first-install',
    now: 3_000,
  });
  const meta = readBackupMeta(seed.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD);
  assert.equal(meta.certifiedBy, CERTIFIED_BY.SEED, 'the install seed is the one copy that may start out restorable');
  // A SEED HAS NO BOOT BEHIND IT, and the record now says exactly that instead of
  // carrying a `certifiedAt` that named a check nobody ran.
  assert.equal(meta.trigger, BACKUP_TRIGGERS.FIRST_INSTALL);
  assert.equal(meta.takenAt, new Date(3_000).toISOString(), 'when the fresh installation copied it');
  assert.equal(meta.boot, null);
  assert.equal(meta.certifiedAt, null, 'nothing was checked, so nothing claims to have been');
  assertFactsOnly(seed.dir);
});

test('⑦ markKnownGood promotes NOTHING without evidence, and does not rewrite meta', async (t) => {
  const { profile, backups } = certFixture(t);
  const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 4_000 });
  const metaFile = path.join(backup.dir, META_NAME);
  const before = fs.readFileSync(metaFile, 'utf8');

  // The old call shape: a reason, no evidence. This is what an old call site does.
  const legacy = markKnownGood(backup.dir, { reason: 'boot-ok' });
  assert.equal(legacy.promoted, false, 'a boot alone certifies nothing');
  assert.match(legacy.reason, /no boot record/i);

  // Explicitly "none" is the same answer, with its own wording.
  const explicitNone = markKnownGood(backup.dir, { intervention: false, reason: 'boot-ok', certifiedBy: CERTIFIED_BY.NONE });
  assert.equal(explicitNone.promoted, false);
  assert.match(explicitNone.reason, /does not record a boot/i);

  // A made-up source does not sneak through either.
  const invented = markKnownGood(backup.dir, { intervention: false, reason: 'boot-ok', certifiedBy: 'boot-ok' });
  assert.equal(invented.promoted, false);

  assert.equal(fs.readFileSync(metaFile, 'utf8'), before, 'meta.json is byte-for-byte unchanged');
  assert.equal(readBackupMeta(backup.dir).kind, KIND_SNAPSHOT, 'the copy is still unproven');
  assert.equal(latestKnownGood(backups), null, 'and no rollback target appeared');
});

test('⑦ markKnownGood on a directory with nothing in it refuses instead of throwing', (t) => {
  const { backups } = certFixture(t);
  const empty = path.join(backups, 'not-a-backup');
  fs.mkdirSync(empty, { recursive: true });

  const refused = markKnownGood(empty, { intervention: false, reason: 'boot-ok', certifiedBy: CERTIFIED_BY.FULL_CHECKS });
  assert.equal(refused.promoted, false, 'there is nothing to promote');
  assert.match(refused.reason, /neither a readable meta.json nor a manifest/i);
  assert.equal(fs.existsSync(path.join(empty, META_NAME)), false, 'and nothing was invented on disk');
});

test('⑦ the content fingerprint changes when the certified content is edited', async (t) => {
  const { profile, backups } = certFixture(t);
  const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 5_000 });
  const original = contentFingerprintOf(backup.dir);
  assert.equal(original, readBackupMeta(backup.dir).contentFingerprint);

  // A hand edit INSIDE the copy — the exact shape of "the same directory no
  // longer holds what was certified".
  fs.writeFileSync(path.join(backup.dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: demo\n  - id: broken\n', 'utf8');
  const edited = contentFingerprintOf(backup.dir);
  assert.notEqual(edited, original, 'one edited byte changes the fingerprint');
  assert.equal(readBackupMeta(backup.dir).contentFingerprint, original, 'the stored one still names what was certified');
});

test('⑦ the content scope describes what is really in the copy', async (t) => {
  const { profile, backups } = certFixture(t);
  const configOnly = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 6_000 });
  assert.equal(readBackupMeta(configOnly.dir).contentScope, CONTENT_SCOPES.CONFIG_ONLY);
  assert.equal(contentScopeOf(configOnly.dir), CONTENT_SCOPES.CONFIG_ONLY);

  const withPlugins = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: true, now: 7_000 });
  assert.equal(readBackupMeta(withPlugins.dir).contentScope, CONTENT_SCOPES.CONFIG_PLUGINS, 'the plugin tree was copied');
  assert.equal(contentScopeOf(withPlugins.dir), CONTENT_SCOPES.CONFIG_PLUGINS);

  // A slim copy deliberately leaves the third-party tree out.
  const slim = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 8_000 });
  assert.equal(slim.ok, true);
  assert.equal(readBackupMeta(slim.dir).contentScope, CONTENT_SCOPES.SLIM);
  assert.equal(contentScopeOf(slim.dir, { includePlugins: true, slim: true }), CONTENT_SCOPES.SLIM);
});

test('⑦ pruning never deletes the LAST certified copy, even when the limit says so', (t) => {
  const { backups } = certFixture(t);
  const stamps = [
    '2026-02-01T00-00-00-000Z',
    '2026-02-02T00-00-00-000Z',
    '2026-02-03T00-00-00-000Z',
    '2026-02-04T00-00-00-000Z',
  ];
  for (const stamp of stamps) certRawBackup(backups, stamp);
  // The certified one is a MIDDLE copy and it is NOT known-good: the only thing
  // standing between it and the "oldest first" order is the certification floor.
  // It is certified by source AND criterion (2026-11-01) — a source alone protects
  // nothing any more, exactly as it restores nothing any more.
  assert.equal(
    writeBackupMeta(path.join(backups, stamps[1]), {
      kind: KIND_SNAPSHOT,
      at: 1_000,
      certifiedBy: CERTIFIED_BY.COMMAND_PROBE,
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
      certifiedAt: '2026-02-02T00:00:00.000Z',
    }),
    true,
  );

  const prune = pruneBackups(backups, 1);
  assert.equal(prune.skipped, false, 'the floor did not have to stop everything');
  assert.equal(prune.keptCertified, stamps[1], 'the answer names the copy it protected');
  assert.equal(prune.certifiedCount, 1);
  // CHANGED 2026-11-02 (user report): the NEWEST copy is a keeper now. Before
  // this, the newest copy was the only unprotected candidate here and the prune
  // deleted it — which is how a restart threw away the snapshot it had just
  // written while yesterday's leftovers stayed. With the newest and the certified
  // one protected, the budget (3) is larger than the copies that may go (2), so
  // the "oldest reference" is sacrificed as well and the limit is met.
  assert.deepEqual(prune.removed, [stamps[0], stamps[2]], 'the copies that may go, went (oldest first)');
  assert.equal(fs.existsSync(path.join(backups, stamps[1])), true, 'the certified copy is still on disk');
  assert.equal(fs.existsSync(path.join(backups, stamps[3])), true, 'and the newest copy survived this time');
});

test('⑦ with NO certified copy at all, pruning still converges to the newest limit', (t) => {
  const { backups } = certFixture(t);
  const stamps = [
    '2026-03-01T00-00-00-000Z',
    '2026-03-02T00-00-00-000Z',
    '2026-03-03T00-00-00-000Z',
  ];
  for (const stamp of stamps) certRawBackup(backups, stamp);

  // CHANGED 2026-11-02 (user decision): an UNPROVEN copy cannot be restored, so
  // keeping it "just in case" protects nothing and only spends disk. A hosted
  // WSL instance never certifies anything and accumulated FIFTEEN copies — the
  // floor that kept everything is exactly what let that happen.
  const prune = pruneBackups(backups, 1);
  assert.deepEqual(prune.removed, [stamps[0], stamps[1]], 'the two oldest copies went');
  assert.equal(prune.skipped, false, 'the prune really ran');
  assert.match(String(prune.reason), /no copy has a restart record/i, 'and it says there is no proof');
  assert.equal(prune.certifiedCount, 0);
  assert.equal(prune.keptCertified, null);
  assert.equal(prune.budget, 2, 'the budget it spent is reported too');
  assert.deepEqual(certNames(backups), [stamps[2]], 'only the newest copy is left');
});

test('⑦ createBackup prunes and reports it even with no proof', async (t) => {
  const { profile, backups } = certFixture(t);
  const results = [];
  for (const now of [9_000, 10_000, 11_000]) {
    const result = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 1, now });
    assert.equal(result.ok, true);
    results.push(result);
  }
  // Nothing was ever certified — and the history converges anyway (2026-11-02).
  // Each write prunes as it goes, so the LAST write spends one unit of budget:
  // after the third copy there are two on disk and the limit is one.
  const last = results[results.length - 1];
  assert.equal(last.pruned.length, 1, 'the copy over the limit was pruned by that very write');
  assert.equal(last.pruneSkipped, false, 'a prune that ran is not reported as skipped');
  assert.match(String(last.pruneReason), /no copy has a restart record/i);
  assert.equal(certNames(backups).length, 1, 'only the newest copy is left');

  // Once one copy carries evidence the protected pruning takes over: the proven
  // copy stays and the budget is spent on the copies around it.
  const certifiedName = certNames(backups)[0];
  writeBackupMeta(path.join(backups, certifiedName), {
    kind: KIND_SNAPSHOT,
    at: 9_000,
    certifiedBy: CERTIFIED_BY.SEED,
  });
  // A limit of TWO on purpose: with a limit of one the pre-existing "oldest
  // first" order would have nothing to spend the budget on but the newest copy,
  // and THAT rule is not part of this change.
  const second = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 2, now: 12_000 });
  assert.equal(second.pruned.length, 0, 'nothing over the limit yet');
  const after = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 2, now: 13_000 });
  assert.equal(after.ok, true);
  assert.equal(after.pruneSkipped, false);
  assert.equal(after.pruneReason, null);
  assert.equal(after.pruned.length > 0, true, 'copies were pruned again now that a trusted copy exists');
  assert.equal(fs.existsSync(path.join(backups, certifiedName)), true, 'the certified copy is the one that stayed');
  assert.equal(fs.existsSync(after.dir), true, 'and the new copy is there as always');
  assert.equal(certNames(backups).length, 2, 'the certified copy plus the new one');
});

/* ------------------------------------------------------------------ *
 * THE CEILING, NOT ONLY THE FLOOR (2026-11-02).
 *
 * t24 fixed the floor: with no certified copy the prune used to delete nothing.
 * A real hosted instance still kept SEVENTEEN copies after that fix, because the
 * CEILING was `DEFAULT_MAX_BACKUPS = 20` — nothing was ever over it, so the
 * prune never had a budget. The design is two copies (one safe + one newest).
 * ------------------------------------------------------------------ */

test('a machine that never configured maxBackups converges to TWO on the next write', async (t) => {
  const { profile, backups } = certFixture(t);
  // THE REAL SHAPE OF THE BUG: seventeen unproven copies already on disk.
  for (let index = 0; index < 17; index += 1) {
    const day = String(index + 1).padStart(2, '0');
    certRawBackup(backups, `2026-04-${day}T00-00-00-000Z`);
  }
  assert.equal(certNames(backups).length, 17, 'seventeen copies to start with');

  // ONE ordinary write, with maxBackups simply NOT passed (the hosted profile
  // does not configure it). The prune runs inside that write. `now` is a real
  // 2026-04 moment so the new copy is genuinely the newest by name — the keep
  // list is by NAME, so a copy stamped older would be pruned immediately.
  const result = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: Date.parse('2026-04-20T00:00:00Z') });
  assert.equal(result.ok, true);
  const left = certNames(backups);
  assert.equal(left.length <= 2, true, `converged to at most two copies (got ${left.length})`);
  assert.equal(left.length, 2, 'exactly two: the new copy and the newest old one');
  assert.match(left[left.length - 1], /^2026-04-20/, 'the copy that was just written is one of them');
  assert.equal(result.pruned.length, 16, 'the other sixteen were removed by that same write');
  assert.match(String(result.pruneReason), /no copy has a restart record/i, 'and the reason is reported, not silent');
});

/* ------------------------------------------------------------------ *
 * A COPY THAT CANNOT BE READ MUST NOT KILL THE PRUNE (2026-11-02).
 *
 * The real hosted machine kept EIGHTEEN copies while `backups.max` was already
 * 2, with an EMPTY pruneReason. Two of those directories had no `meta.json`;
 * the known-good lookup read `metas.get(name).kind`, `null.kind` threw, and the
 * prune died before deleting anything — the silence looked exactly like "the
 * prune never ran".
 * ------------------------------------------------------------------ */

test('a copy with no meta.json does not break the prune (the eighteen-copy machine)', (t) => {
  const { backups } = certFixture(t);
  const stamps = [];
  for (let day = 1; day <= 18; day += 1) {
    stamps.push('2026-05-' + String(day).padStart(2, '0') + 'T00-00-00-000Z');
  }
  for (const stamp of stamps) certRawBackup(backups, stamp, { meta: { kind: KIND_SNAPSHOT, at: 1_000 } });
  // The two the real machine had: a manifest, NO `meta.json`.
  const noMeta = [stamps[2], stamps[5]];
  for (const name of noMeta) fs.rmSync(path.join(backups, name, META_NAME), { force: true });
  // ...and the newest copy is the safe one.
  markKnownGood(path.join(backups, stamps[17]), { reason: 'boot-ok', certifiedBy: CERTIFIED_BY.SEED });

  // THIS THREW A TypeError BEFORE THE FIX.
  const prune = pruneBackups(backups, 2);

  assert.equal(prune.failed, undefined, 'the prune did not fall into its own failure net');
  assert.equal(prune.budget, 16, 'eighteen copies, a limit of two');
  assert.equal(prune.removed.length, 16, 'the budget was really spent');
  const left = certNames(backups);
  assert.equal(left.length, 2, 'two copies are left, as the design says');
  assert.equal(left.includes(stamps[17]), true, 'the safe copy stayed');
  for (const name of noMeta) {
    assert.equal(
      fs.existsSync(path.join(backups, name)),
      false,
      'a copy that cannot be read is a delete candidate, not a blocker',
    );
  }
});

test('a prune that cannot delete anything says so instead of staying silent', (t) => {
  const { backups } = certFixture(t);
  for (const stamp of ['2026-07-01T00-00-00-000Z', '2026-07-02T00-00-00-000Z', '2026-07-03T00-00-00-000Z']) {
    certRawBackup(backups, stamp, { meta: { kind: KIND_SNAPSHOT, at: 1_000 } });
  }
  // Every removal fails: the run must still REPORT the budget it could not spend.
  const original = fs.rmSync;
  fs.rmSync = () => {
    throw new Error('boom-rm');
  };
  let prune;
  try {
    prune = pruneBackups(backups, 1);
  } finally {
    fs.rmSync = original;
  }
  assert.deepEqual(prune.removed, []);
  assert.equal(prune.budget > 0, true, 'there was a budget');
  assert.match(String(prune.reason), /nothing was removed/i, 'and the reason is not empty');
  assert.equal(certNames(backups).length, 3, 'nothing was really deleted');
});

