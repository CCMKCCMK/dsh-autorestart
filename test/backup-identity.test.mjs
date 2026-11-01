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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backupsRoot,
  CERTIFICATION_EVIDENCE,
  CERTIFIED_BY,
  contentFingerprintOf,
  contentScopeOf,
  CONTENT_SCOPES,
  createBackup,
  DEFAULT_MAX_BACKUPS,
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

test('① twenty backups are kept by default', () => {
  // A backup records CHANGES, not restarts (user decision, 2026-11-01): with
  // hard-link dedup the history costs almost nothing, so three was far too few.
  assert.equal(DEFAULT_MAX_BACKUPS, 20, 'twenty copies of history');
});

test('② pruning above the limit removes the OLDEST copies', async (t) => {
  const { profile, backups } = fixture(t);
  const made = [];
  for (const now of [1_000, 2_000, 3_000, 4_000, 5_000]) {
    const result = await takeBackup(profile, backups, now);
    assert.equal(result.ok, true);
    made.push(result);
  }

  // Five is far below the new default of twenty, so nothing is pruned yet.
  const left = names(backups);
  assert.equal(left.length, 5, 'five backups are well inside the default of twenty');
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
    markKnownGood(path.join(backups, stamps[0]), {
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

  // The rest of the pruning still happens: three of the four are gone.
  assert.equal(removed.length, 3, 'every other copy was pruned');
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
    markKnownGood(snapshot.dir, {
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
  assert.equal(meta.reason, 'boot-ok');
  assert.equal(meta.requestId, 7, 'the request that took it is kept');

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
  assert.equal(meta.reason, 'first install');
  assert.equal(latestKnownGood(backups).name, seed.stamp, 'the seed is the newest known-good');

  // A nonsense kind never silently becomes something else: a copy nobody
  // proved anything about is a snapshot.
  const odd = await takeBackup(profile, backups, 3_000, { kind: 'whatever' });
  assert.equal(odd.kind, KIND_SNAPSHOT);
});

test('writeBackupMeta keeps only the three identities', (t) => {
  const { backups } = fixture(t);
  const dir = rawBackup(backups, '2026-02-01T00-00-00-000Z');
  assert.equal(writeBackupMeta(dir, { kind: 'nonsense', version: '1.2.3' }), true);
  assert.equal(readBackupMeta(dir).kind, KIND_UNKNOWN, 'an unknown word is not an identity');
  assert.equal(writeBackupMeta(dir, { kind: KIND_SNAPSHOT }), true);
  assert.equal(readBackupMeta(dir).kind, KIND_SNAPSHOT);
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
  assert.equal(result.reason, 'certified by full-checks');

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
    const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 2_000 + index });
    assert.equal(backup.ok, true);
    assert.equal(markKnownGood(backup.dir, { reason: 'r-', certifiedBy: source }).promoted, true);
    const meta = readBackupMeta(backup.dir);
    assert.equal(meta.certifiedBy, source, 'the source is stored verbatim');
    assert.ok(Number.isFinite(Date.parse(meta.certifiedAt)), 'certifiedAt is a real ISO moment');
    seen.add(meta.certifiedBy);
  }
  assert.equal(seen.size, 4, 'a full check, a health probe, a seed and a manual rollback are four different answers');
});

test('⑦ the seed of a fresh installation is born certified, as "seed"', async (t) => {
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
  assert.equal(meta.certifiedBy, CERTIFIED_BY.SEED, 'the install seed is the one copy that may start out certified');
  assert.ok(Number.isFinite(Date.parse(meta.certifiedAt)));
});

test('⑦ markKnownGood promotes NOTHING without evidence, and does not rewrite meta', async (t) => {
  const { profile, backups } = certFixture(t);
  const backup = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, now: 4_000 });
  const metaFile = path.join(backup.dir, META_NAME);
  const before = fs.readFileSync(metaFile, 'utf8');

  // The old call shape: a reason, no evidence. This is what an old call site does.
  const legacy = markKnownGood(backup.dir, { reason: 'boot-ok' });
  assert.equal(legacy.promoted, false, 'a boot alone certifies nothing');
  assert.match(legacy.reason, /no certification/i);

  // Explicitly "none" is the same answer, with its own wording.
  const explicitNone = markKnownGood(backup.dir, { reason: 'boot-ok', certifiedBy: CERTIFIED_BY.NONE });
  assert.equal(explicitNone.promoted, false);
  assert.match(explicitNone.reason, /does not prove a boot/i);

  // A made-up source does not sneak through either.
  const invented = markKnownGood(backup.dir, { reason: 'boot-ok', certifiedBy: 'boot-ok' });
  assert.equal(invented.promoted, false);

  assert.equal(fs.readFileSync(metaFile, 'utf8'), before, 'meta.json is byte-for-byte unchanged');
  assert.equal(readBackupMeta(backup.dir).kind, KIND_SNAPSHOT, 'the copy is still unproven');
  assert.equal(latestKnownGood(backups), null, 'and no rollback target appeared');
});

test('⑦ markKnownGood on a directory with nothing in it refuses instead of throwing', (t) => {
  const { backups } = certFixture(t);
  const empty = path.join(backups, 'not-a-backup');
  fs.mkdirSync(empty, { recursive: true });

  const refused = markKnownGood(empty, { reason: 'boot-ok', certifiedBy: CERTIFIED_BY.FULL_CHECKS });
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
  assert.deepEqual(prune.removed, [stamps[2], stamps[3]], 'everything else that could go, went');
  assert.equal(fs.existsSync(path.join(backups, stamps[1])), true, 'the certified copy is still on disk');
  assert.equal(fs.existsSync(path.join(backups, stamps[0])), true, 'and the oldest reference is untouched as before');
});

test('⑦ with NO certified copy at all, pruning deletes nothing and says so', (t) => {
  const { backups } = certFixture(t);
  const stamps = [
    '2026-03-01T00-00-00-000Z',
    '2026-03-02T00-00-00-000Z',
    '2026-03-03T00-00-00-000Z',
  ];
  for (const stamp of stamps) certRawBackup(backups, stamp);

  const prune = pruneBackups(backups, 1);
  assert.deepEqual(prune.removed, [], 'not one copy was deleted');
  assert.equal(prune.skipped, true, 'and the answer says the floor kicked in');
  assert.match(String(prune.reason), /no certified backup/i, 'with the reason a report can repeat to the user');
  assert.equal(prune.certifiedCount, 0);
  assert.equal(prune.keptCertified, null);
  assert.equal(prune.budget, 2, 'the budget it refused to spend is reported too');
  assert.deepEqual(certNames(backups), stamps, 'every copy is still on disk');
});

test('⑦ createBackup reports a skipped prune instead of hiding it', async (t) => {
  const { profile, backups } = certFixture(t);
  const results = [];
  for (const now of [9_000, 10_000, 11_000]) {
    const result = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 1, now });
    assert.equal(result.ok, true);
    results.push(result);
  }
  // Nothing was ever certified, so the history is left alone on purpose...
  const last = results[results.length - 1];
  assert.deepEqual(last.pruned, [], 'nothing was pruned');
  assert.equal(last.pruneSkipped, true, 'because no copy carries evidence');
  assert.match(String(last.pruneReason), /no certified backup/i);
  assert.equal(certNames(backups).length, 3, 'all three copies survive the limit of one');

  // ...and once one copy is certified, the normal pruning resumes.
  const certifiedName = certNames(backups)[0];
  writeBackupMeta(path.join(backups, certifiedName), {
    kind: KIND_SNAPSHOT,
    at: 9_000,
    certifiedBy: CERTIFIED_BY.SEED,
  });
  // A limit of TWO (not one) on purpose: with a limit of one the pre-existing
  // "oldest first" order would have nothing left to spend the budget on but the
  // copy that was just taken, and THAT rule is not part of this change.
  const after = await createBackup({ slimBackup: false, profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 2, now: 12_000 });
  assert.equal(after.ok, true);
  assert.equal(after.pruneSkipped, false);
  assert.equal(after.pruneReason, null);
  assert.equal(after.pruned.length > 0, true, 'copies were pruned again now that a trusted copy exists');
  assert.equal(fs.existsSync(path.join(backups, certifiedName)), true, 'the certified copy is the one that stayed');
  assert.equal(fs.existsSync(after.dir), true, 'and the new copy is there as always');
  assert.equal(certNames(backups).length, 2, 'the certified copy plus the new one');
});
