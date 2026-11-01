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

  // Ask for two explicitly: pruning removes what exceeds the limit, EXCEPT the
  // oldest, which is now permanent.
  const removed = pruneBackups(backups, 2);
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
  assert.equal(markKnownGood(path.join(backups, stamps[0]), { reason: 'boot-ok', version: '0.8.5' }), true);

  // Ask for ONE copy: even then the known-good one survives.
  const removed = pruneBackups(backups, 1);
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

  assert.equal(markKnownGood(snapshot.dir, { reason: 'boot-ok', version: '0.8.5' }), true);
  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD);
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
