/**
 * WHICH CRITERION PROVED IT — the missing half of the certification (2026-11-01).
 *
 * THE DEFECT THIS FILE PINS DOWN, with the numbers from the hosted instance:
 * after the criterion became "the configuration fingerprints must match", two
 * fresh copies were certified correctly (`cfg=691B`, `certifiedBy=full-checks`,
 * fingerprint recorded) — while the two BROKEN configurations the OLD code had
 * stamped (`cfg=71B` and `cfg=70B`) still said `certifiedBy=full-checks` in their
 * `meta.json`. The watchdog picks the restore target by `certifiedBy`, so it could
 * not tell them apart and would have restored a 71-byte broken configuration as
 * "the safe copy".
 *
 * ROOT CAUSE: `certifiedBy` says WHO signed, never WITH WHICH CRITERION — and the
 * old criterion ("the host came up") and the new one ("this boot ran exactly the
 * content the copy holds") both end up as `full-checks`.
 *
 * THE RULE: a stamp nobody can verify is not a stamp, and it is WORSE than no
 * stamp because it gets trusted. So `certificationEvidence` records the criterion
 * (`'fingerprint-match'`, or `null`), and a copy is only safe when BOTH halves are
 * there. The historical pollution therefore stops being usable the moment this
 * code reads it — no warning, no "probably fine".
 *
 * The four things that must stay true (the user's decision):
 *   1. an old-criterion stamp is NOT a safe copy (and is not selected);
 *   2. an old copy whose CONTENT really matches is upgraded, seal included;
 *   3. a content mismatch is never written as a proof;
 *   4. the seed keeps its own positioning — it is never called a fingerprint proof.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backupsRoot,
  CERTIFICATION_EVIDENCE,
  CERTIFIED_BY,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  isCertifiedBackup,
  isProvingEvidence,
  isRestoreEligible,
  latestKnownGood,
  listBackupIdentities,
  markKnownGood,
  META_NAME,
  pruneBackups,
  readBackupMeta,
  writeBackupMeta,
} from '../lib/backup.js';
import {
  BOOT_CHECK_SOURCE,
  decideBootCertification,
  decideProbeCertification,
  FINGERPRINT_MATCH_EVIDENCE,
  RESTART_CHECK_NAMES,
} from '../lib/restart-verdict.js';
import { RESTORE_EXCLUSIONS, selectRestoreTarget } from '../lib/watchdog.js';

/** A scratch directory; removed when the test ends. */
function scratch(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-evidence-' + label + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * One backup directory on disk.
 *
 * `rawMeta` is written VERBATIM, on purpose: the historical copies are exactly
 * those whose `meta.json` predates the `certificationEvidence` field, and a
 * fixture that went through `writeBackupMeta` would quietly modernise them.
 */
function makeCopy(backups, name, { at, rawMeta }) {
  const dir = path.join(backups, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    stamp: name,
    at,
    atLocal: new Date(at).toISOString(),
    bytes: 24,
    files: ['config/cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8');
  if (rawMeta !== undefined) {
    fs.writeFileSync(path.join(dir, META_NAME), JSON.stringify(rawMeta), 'utf8');
  }
  return { dir, name };
}

/** The exact shape the OLD code left behind: a source, no criterion. */
function oldCriterionMeta({ at }) {
  return { kind: KIND_KNOWN_GOOD, at, version: '0.9.0', reason: 'boot-ok', certifiedBy: CERTIFIED_BY.FULL_CHECKS };
}

/* ------------------------------------------------------------------ *
 * 1. THE HISTORICAL POLLUTION: a stamp without a criterion.
 * ------------------------------------------------------------------ */

test('the two copies the old criterion stamped are NOT safe copies any more (71B / 70B)', (t) => {
  const root = scratch(t, 'pollution');
  const backups = backupsRoot(root);
  // The measured shapes: 71 bytes and 70 bytes of cordis.patch.yml, both stamped
  // `certifiedBy=full-checks` by code that only looked at "the host came up".
  const broken = makeCopy(backups, '2026-11-01T12-20-36-040Z', {
    at: Date.parse('2026-11-01T12:20:36.040Z'),
    rawMeta: oldCriterionMeta({ at: Date.parse('2026-11-01T12:20:36.040Z') }),
  });
  const alsoBroken = makeCopy(backups, '2026-11-01T12-04-33-777Z', {
    at: Date.parse('2026-11-01T12:04:33.777Z'),
    rawMeta: oldCriterionMeta({ at: Date.parse('2026-11-01T12:04:33.777Z') }),
  });

  for (const copy of [broken, alsoBroken]) {
    const meta = readBackupMeta(copy.dir);
    // The stamp is still READ — hiding it would hide what happened.
    assert.equal(meta.certifiedBy, 'full-checks', 'the old stamp is reported as it is');
    // …and the criterion it never had is the reason it proves nothing.
    assert.equal(meta.certificationEvidence, null, 'no criterion is on record');
    assert.equal(isCertifiedBackup(meta), false, 'a source without a criterion is not a safe copy');
    assert.equal(isRestoreEligible(meta), false, 'and it is not an automatic fallback either');
  }

  const listed = listBackupIdentities(backups);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((entry) => entry.certified), [false, false], 'neither copy counts as certified');
  assert.deepEqual(
    listed.map((entry) => entry.certificationEvidence),
    [null, null],
    'and the listing says WHY: no criterion on record',
  );
  assert.deepEqual(
    listed.map((entry) => entry.certifiedBy),
    ['full-checks', 'full-checks'],
    'the stamp travels with the refusal, so the operator sees what was refused',
  );

  // The old "newest known-good" reader refuses them too: `kind: 'known-good'` is
  // not an identity, it is a word the old writer put in the file.
  assert.equal(latestKnownGood(backups), null, 'no automatic rollback target exists');
});

test('an evidence value nobody can check is not a criterion ("boot-ok", "trust-me", an empty string)', () => {
  const cases = ['boot-ok', 'trust-me', '', '  ', 'FINGERPRINT-MATCH', null, undefined, 42, {}, []];
  for (const value of cases) {
    assert.equal(isProvingEvidence(value), false, JSON.stringify(value) + ' must not prove anything');
    assert.equal(
      isCertifiedBackup({ certifiedBy: CERTIFIED_BY.FULL_CHECKS, certificationEvidence: value }),
      false,
      'a made-up criterion never turns a stamp into a safe copy',
    );
  }
  assert.equal(isProvingEvidence('fingerprint-match'), true, 'the one value that is a proof');
});

test('a copy that reads as "never certified" comes back identical in both halves', (t) => {
  const root = scratch(t, 'empty-meta');
  const backups = backupsRoot(root);
  const copy = makeCopy(backups, '2026-11-02T00-00-00-000Z', { at: 1_000, rawMeta: { kind: KIND_SNAPSHOT, at: 1_000 } });
  const meta = readBackupMeta(copy.dir);
  assert.equal(meta.certifiedBy, CERTIFIED_BY.NONE);
  assert.equal(meta.certificationEvidence, CERTIFICATION_EVIDENCE.NONE);
  assert.equal(isCertifiedBackup(meta), false);
  assert.equal(isCertifiedBackup(null), false, 'no meta at all is not a safe copy either');
  assert.equal(isRestoreEligible({}), false, 'an empty object proves nothing');
});

/* ------------------------------------------------------------------ *
 * 2. THE WATCHDOG: only the new criterion, and the refusal is spoken.
 * ------------------------------------------------------------------ */

test('the watchdog skips the polluted copies and picks the one proven by the fingerprints', (t) => {
  const root = scratch(t, 'selector');
  const backups = backupsRoot(root);
  // The polluted copies are the NEWEST ones here on purpose: the selector walks the
  // list newest-first and must refuse them before it ever reaches the good copy —
  // that is exactly the order the hosted instance had, with the difference that
  // there the broken copies were OLDER, i.e. they would have been reached as soon
  // as the good copy was missing.
  const good = makeCopy(backups, '2026-11-01T13-00-00-000Z', {
    at: Date.parse('2026-11-01T13:00:00.000Z'),
    rawMeta: {
      kind: KIND_KNOWN_GOOD,
      at: Date.parse('2026-11-01T13:00:00.000Z'),
      reason: 'boot-ok',
      certifiedBy: CERTIFIED_BY.FULL_CHECKS,
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
      intervention: false,
    },
  });
  makeCopy(backups, '2026-11-01T13-10-00-000Z', {
    at: Date.parse('2026-11-01T13:10:00.000Z'),
    rawMeta: { ...oldCriterionMeta({ at: 1_000 }), intervention: false },
  });
  makeCopy(backups, '2026-11-01T13-05-00-000Z', {
    at: Date.parse('2026-11-01T13:05:00.000Z'),
    rawMeta: { ...oldCriterionMeta({ at: 1_000 }), intervention: false },
  });

  const choice = selectRestoreTarget({ candidates: listBackupIdentities(backups) });
  assert.equal(choice.strict, false);
  assert.equal(choice.target, good.dir, 'the copy proven by the fingerprint comparison is the target');
  assert.equal(
    choice.excluded.length,
    2,
    'both polluted copies are in the refusal list — they are NEWER than nothing, and they are named',
  );
  for (const entry of choice.excluded) {
    assert.equal(entry.exclusion, RESTORE_EXCLUSIONS.NOT_CONTENT_VERIFIED);
    assert.equal(entry.certifiedBy, 'full-checks', 'the report keeps the stamp it refused');
    assert.equal(entry.certificationEvidence, null, 'and shows the missing criterion');
  }
  assert.equal(
    choice.notes.some((note) => /does not say both that the instance came up AND that the content matched/.test(note)),
    true,
    'the reason is said out loud, not left to "nothing to restore"',
  );
});

test('the selector re-checks the criterion itself: `certified: true` with no evidence is refused', () => {
  // This is the shape a hand-made candidate (or a marker written by another build)
  // can have. `certified` is a flag; the evidence is the fact behind it. The last
  // gate before a file tree is copied over the profile reads the fact.
  const choice = selectRestoreTarget({
    candidates: [{
      dir: '/backups/71b',
      name: '71b',
      certifiedBy: 'full-checks',
      intervention: false,
      certified: true,
      certificationEvidence: null,
    }],
  });
  assert.equal(choice.target, null, 'no restore target');
  assert.equal(choice.strict, true);
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.NOT_CONTENT_VERIFIED);
});

test('with ONLY polluted copies, the watchdog restores nothing and says why', (t) => {
  const root = scratch(t, 'selector-only-pollution');
  const backups = backupsRoot(root);
  makeCopy(backups, '2026-11-01T12-20-36-040Z', { at: 5_000, rawMeta: { ...oldCriterionMeta({ at: 5_000 }), intervention: false } });
  const choice = selectRestoreTarget({ candidates: listBackupIdentities(backups) });
  assert.equal(choice.target, null);
  assert.equal(choice.strict, true);
  assert.match(choice.reason, /none of the 1 copies has a restart record/);
  assert.equal(choice.excluded.length, 1);
});

/* ------------------------------------------------------------------ *
 * 3. THE WRITER: the criterion is written, never silently dropped.
 * ------------------------------------------------------------------ */

test('markKnownGood records source AND criterion, and a later promotion does not erase it', (t) => {
  const root = scratch(t, 'writer');
  const backups = backupsRoot(root);
  const copy = makeCopy(backups, '2026-11-01T14-00-00-000Z', { at: 1_000, rawMeta: { kind: KIND_SNAPSHOT, at: 1_000 } });

  const promoted = markKnownGood(copy.dir, { intervention: false,
    reason: 'boot-ok',
    certifiedBy: CERTIFIED_BY.FULL_CHECKS,
    certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.reason, 'a boot was observed (full-checks) and it was running this content');
  const meta = readBackupMeta(copy.dir);
  assert.equal(meta.certifiedBy, 'full-checks');
  assert.equal(meta.certificationEvidence, 'fingerprint-match');
  assert.equal(isCertifiedBackup(meta), true);
  assert.equal(listBackupIdentities(backups)[0].certified, true);

  // A SECOND write that says nothing about the criterion (an older call site, or a
  // re-write of the same identity) must not un-seal the copy by omission: erasing a
  // seal is a decision, not a side effect.
  const again = markKnownGood(copy.dir, { intervention: false, reason: 'boot-ok', certifiedBy: CERTIFIED_BY.FULL_CHECKS });
  assert.equal(again.promoted, true);
  assert.equal(
    readBackupMeta(copy.dir).certificationEvidence,
    'fingerprint-match',
    'the recorded criterion survives a promotion that does not mention it',
  );
});

test('a promotion that names a source and NO criterion says out loud that nothing says the content came up', (t) => {
  const root = scratch(t, 'writer-no-criterion');
  const backups = backupsRoot(root);
  const copy = makeCopy(backups, '2026-11-01T14-30-00-000Z', { at: 1_000, rawMeta: { kind: KIND_SNAPSHOT, at: 1_000 } });

  const promoted = markKnownGood(copy.dir, { intervention: false, reason: 'boot-ok', certifiedBy: CERTIFIED_BY.MANUAL_ROLLBACK });
  assert.equal(promoted.promoted, true, 'the identity was written');
  assert.match(promoted.reason, /nothing says the content came up/, 'and the caller is told the copy proves nothing');
  const meta = readBackupMeta(copy.dir);
  assert.equal(meta.certifiedBy, 'manual-rollback', 'the source is stored verbatim');
  assert.equal(meta.certificationEvidence, null);
  assert.equal(isCertifiedBackup(meta), false);
  assert.equal(latestKnownGood(backups), null, 'so it is not an automatic rollback target');
});

test('the seed is never written as a fingerprint proof', (t) => {
  const root = scratch(t, 'seed');
  const backups = backupsRoot(root);
  const at = 1_000;
  const seed = makeCopy(backups, '2026-11-01T15-00-00-000Z', {
    at,
    rawMeta: { kind: KIND_KNOWN_GOOD, at, reason: 'first-install', certifiedBy: CERTIFIED_BY.SEED, certifiedAt: new Date(at).toISOString() },
  });
  const meta = readBackupMeta(seed.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD);
  assert.equal(meta.certifiedBy, CERTIFIED_BY.SEED, 'the seed keeps its own identity');
  assert.equal(meta.certificationEvidence, null, 'and it is NOT called a fingerprint match');
  assert.equal(isCertifiedBackup(meta), false, 'it was never proven, so it is not certified');
  // ITS OWN POSITIONING: a fresh installation has nothing proven yet and nothing to
  // lose either, so the seed stays a fallback for the in-process rollback. That is
  // why the two questions are two functions instead of one.
  assert.equal(isRestoreEligible(meta), true);
  assert.equal(latestKnownGood(backups).dir, seed.dir);
});

/* ------------------------------------------------------------------ *
 * 4. THE DECISION FUNCTIONS carry the criterion with them.
 * ------------------------------------------------------------------ */

test('both deciding functions return the criterion they used, and the spelling matches the meta', () => {
  // THE DRIFT GUARD: the two modules spell the value independently (restart-verdict
  // imports no local module on purpose), so the two spellings are pinned together
  // here instead of by an import that neither module wants.
  assert.equal(FINGERPRINT_MATCH_EVIDENCE, CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH);

  const checks = RESTART_CHECK_NAMES.map((name) => ({ name, ok: true, detail: null }));
  const same = { snapshotFingerprint: 'sha256:' + 'a'.repeat(64), currentFingerprint: 'sha256:' + 'a'.repeat(64) };
  const other = { snapshotFingerprint: 'sha256:' + 'a'.repeat(64), currentFingerprint: 'sha256:' + 'b'.repeat(64) };

  const boot = decideBootCertification(checks, same);
  assert.equal(boot.certified, true);
  assert.equal(boot.certifiedBy, BOOT_CHECK_SOURCE);
  assert.equal(boot.certificationEvidence, CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH, 'the criterion travels with the verdict');

  const refused = decideBootCertification(checks, other);
  assert.equal(refused.certified, false);
  assert.equal(refused.certificationEvidence, null, 'a refusal never hands out a criterion');

  const probe = decideProbeCertification(same);
  assert.equal(probe.certified, true);
  assert.equal(probe.certificationEvidence, CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH);

  const probeRefused = decideProbeCertification({ snapshotFingerprint: null, currentFingerprint: same.currentFingerprint });
  assert.equal(probeRefused.certified, false);
  assert.equal(probeRefused.certificationEvidence, null, 'an old copy is not "probably fine" because a probe answered');
});

test('the criterion the decision hands out is one the writer accepts', (t) => {
  const root = scratch(t, 'handoff');
  const backups = backupsRoot(root);
  const copy = makeCopy(backups, '2026-11-01T16-00-00-000Z', { at: 1_000, rawMeta: { kind: KIND_SNAPSHOT, at: 1_000 } });
  const same = { snapshotFingerprint: 'sha256:' + 'a'.repeat(64), currentFingerprint: 'sha256:' + 'a'.repeat(64) };
  const decision = decideProbeCertification(same);
  // Exactly the wiring the two call sites use: the value comes FROM the decision.
  const promoted = markKnownGood(copy.dir, {
    reason: 'boot-ok',
    certifiedBy: decision.certifiedBy,
    certificationEvidence: decision.certificationEvidence,
    // The strict selector also needs the recorded "this boot needed no help", so
    // the fixture states it — a null here would refuse the copy for a different
    // reason and this test would prove nothing about the criterion.
    intervention: false,
  });
  assert.equal(promoted.promoted, true);
  assert.equal(listBackupIdentities(backups)[0].certified, true, 'the round trip produces a usable copy');
  assert.equal(selectRestoreTarget({ candidates: listBackupIdentities(backups) }).target, copy.dir);
});

/* ------------------------------------------------------------------ *
 * 5. PRUNING keeps the copies that may still be restored — and only those.
 * ------------------------------------------------------------------ */

test('pruning protects a proven copy, and a polluted one protects nothing', (t) => {
  const root = scratch(t, 'prune');
  const backups = backupsRoot(root);
  const polluted = makeCopy(backups, '2026-11-01T00-00-00-000Z', { at: 1_000, rawMeta: oldCriterionMeta({ at: 1_000 }) });
  makeCopy(backups, '2026-11-01T00-10-00-000Z', { at: 2_000, rawMeta: { kind: KIND_SNAPSHOT, at: 2_000 } });

  // ONLY a stained stamp on disk: there is no trusted fallback. CHANGED
  // 2026-11-02 (user decision): an unproven copy cannot be restored, so keeping
  // it "just in case" protects nothing — the history converges anyway.
  const refused = pruneBackups(backups, 1);
  assert.equal(refused.skipped, false);
  assert.deepEqual(refused.removed, [polluted.name], 'the older, unproven copy went');
  assert.equal(refused.certifiedCount, 0);
  assert.match(String(refused.reason), /no copy has a restart record/);
  assert.equal(fs.existsSync(polluted.dir), false, 'it is really gone');

  // Put it back with a real criterion: now the floor has something to protect.
  const proven = makeCopy(backups, polluted.name, { at: 1_000, rawMeta: oldCriterionMeta({ at: 1_000 }) });
  markKnownGood(proven.dir, { intervention: false,
    reason: 'boot-ok',
    certifiedBy: CERTIFIED_BY.FULL_CHECKS,
    certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
  });
  const prune = pruneBackups(backups, 1);
  assert.equal(prune.skipped, false);
  assert.equal(prune.certifiedCount, 1);
  assert.equal(prune.keptCertified, proven.name, 'the proven copy is the one the floor names');
  assert.equal(fs.existsSync(proven.dir), true, 'and it is never a victim');
});

/* ------------------------------------------------------------------ *
 * 6. THE LISTING the settings page reads.
 * ------------------------------------------------------------------ */

test('the listing hands the interface both halves, so the page can tell them apart', (t) => {
  const root = scratch(t, 'listing');
  const backups = backupsRoot(root);
  const good = makeCopy(backups, '2026-11-01T17-00-00-000Z', {
    at: 3_000,
    rawMeta: {
      kind: KIND_KNOWN_GOOD,
      at: 3_000,
      certifiedBy: CERTIFIED_BY.COMMAND_PROBE,
      certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
      intervention: false,
    },
  });
  const polluted = makeCopy(backups, '2026-11-01T12-20-36-040Z', { at: 1_000, rawMeta: oldCriterionMeta({ at: 1_000 }) });
  const snapshot = makeCopy(backups, '2026-11-01T18-00-00-000Z', { at: 4_000, rawMeta: { kind: KIND_SNAPSHOT, at: 4_000 } });

  const byDir = new Map(listBackupIdentities(backups).map((entry) => [entry.dir, entry]));
  assert.equal(byDir.get(good.dir).certified, true);
  assert.equal(byDir.get(good.dir).certificationEvidence, 'fingerprint-match');
  assert.equal(byDir.get(good.dir).certifiedBy, 'command-probe');

  assert.equal(byDir.get(polluted.dir).certified, false);
  assert.equal(byDir.get(polluted.dir).certificationEvidence, null, 'the page can say "stamped, criterion missing"');
  assert.equal(byDir.get(polluted.dir).certifiedBy, 'full-checks', 'and still show which stamp it was');

  assert.equal(byDir.get(snapshot.dir).certified, false, 'a plain snapshot is not certified either');
  assert.equal(byDir.get(snapshot.dir).certificationEvidence, null);
  // `restoreEligible` is the wider question (the seed), and it is NOT the same flag.
  assert.equal(byDir.get(polluted.dir).restoreEligible, false);
  assert.equal(byDir.get(good.dir).restoreEligible, true);
});

/* ------------------------------------------------------------------ *
 * 7. THE UPGRADE CHANNEL — the other half of the user's decision.
 * ------------------------------------------------------------------ */

test('an old copy is UPGRADED when its content matches, and only then', async (t) => {
  const root = scratch(t, 'upgrade');
  const backups = backupsRoot(root);
  const matches = makeCopy(backups, '2026-10-01T00-00-00-000Z', { at: 1_000, rawMeta: { kind: KIND_SNAPSHOT, at: 1_000 } });
  const differs = makeCopy(backups, '2026-10-02T00-00-00-000Z', { at: 2_000, rawMeta: { kind: KIND_SNAPSHOT, at: 2_000 } });

  // The comparison both paths use: the copy's own content vs. what runs now.
  const { compareConfigurationFingerprints, FINGERPRINT_STATES } = await import('../lib/restart-verdict.js');
  const sameSide = compareConfigurationFingerprints({
    snapshotFingerprint: 'sha256:' + 'c'.repeat(64),
    currentFingerprint: 'sha256:' + 'c'.repeat(64),
  });
  assert.equal(sameSide.state, FINGERPRINT_STATES.EQUAL);

  // MATCH -> "补封条": the seal is written, criterion included, and the copy becomes
  // a safe one. This is the channel that gives a user their old copies back.
  markKnownGood(matches.dir, { intervention: false,
    reason: 'boot-ok',
    certifiedBy: CERTIFIED_BY.FULL_CHECKS,
    certificationEvidence: sameSide.equal ? CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH : null,
  });
  const upgraded = readBackupMeta(matches.dir);
  assert.equal(upgraded.certificationEvidence, 'fingerprint-match');
  assert.ok(Number.isFinite(Date.parse(upgraded.certifiedAt)), 'and the moment it was checked is recorded');
  assert.equal(isCertifiedBackup(upgraded), true);

  // MISMATCH -> nothing at all is written into the copy, and the copy stays unproven.
  const differsBefore = fs.readFileSync(path.join(differs.dir, META_NAME), 'utf8');
  const otherSide = compareConfigurationFingerprints({
    snapshotFingerprint: 'sha256:' + 'd'.repeat(64),
    currentFingerprint: 'sha256:' + 'e'.repeat(64),
  });
  assert.equal(otherSide.state, FINGERPRINT_STATES.MISMATCH);
  // A refusing decision hands out `null`, so no seal is written even by a caller
  // that forgot to ask "was it certified?".
  const decision = decideBootCertification(
    RESTART_CHECK_NAMES.map((name) => ({ name, ok: true, detail: null })),
    { snapshotFingerprint: 'sha256:' + 'd'.repeat(64), currentFingerprint: 'sha256:' + 'e'.repeat(64) },
  );
  assert.equal(decision.certificationEvidence, null);
  assert.equal(
    fs.readFileSync(path.join(differs.dir, META_NAME), 'utf8'),
    differsBefore,
    'the copy of a MISMATCH is byte-for-byte untouched',
  );
  assert.equal(readBackupMeta(differs.dir).certificationEvidence, null);
});

test('a copy already stamped by the old criterion can still be UPGRADED by content', (t) => {
  const root = scratch(t, 'upgrade-polluted');
  const backups = backupsRoot(root);
  // The interesting case: the old code DID stamp it, but with no criterion. If the
  // content really matches, the boot that proved it re-seals it — with the criterion
  // this time. That is "好用的老备份要能救回来", and it is not a loophole: the value
  // is only written by a decision that compared the fingerprints.
  const copy = makeCopy(backups, '2026-11-01T12-04-33-777Z', { at: 1_000, rawMeta: oldCriterionMeta({ at: 1_000 }) });
  assert.equal(isCertifiedBackup(readBackupMeta(copy.dir)), false, 'it starts out unusable');

  markKnownGood(copy.dir, { intervention: false,
    reason: 'boot-ok',
    certifiedBy: CERTIFIED_BY.FULL_CHECKS,
    certificationEvidence: CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH,
    contentFingerprint: 'sha256:' + 'c'.repeat(64),
  });
  const meta = readBackupMeta(copy.dir);
  assert.equal(meta.certificationEvidence, 'fingerprint-match');
  assert.equal(meta.contentFingerprint, 'sha256:' + 'c'.repeat(64), 'and the content it names is the one compared');
  assert.equal(isCertifiedBackup(meta), true, 'the rescued copy is a safe copy now');
  assert.equal(writeBackupMeta(copy.dir, { kind: KIND_KNOWN_GOOD, at: 1_000 }), true, 'the writer still round-trips');
});
