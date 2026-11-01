/**
 * THE CERTIFICATION IS WIRED TO THE CHECKS **AND TO THE CONTENT** (2026-11-01,
 * strict mode phase 3).
 *
 * WHY THIS FILE EXISTS: phase 1 gave every copy an evidence slot and made
 * `markKnownGood` refuse to certify without one. Phase 2 answered the NEXT
 * question — "is this boot allowed to certify anything?" — and wrote the answer
 * into the copy. Phase 3 replaced the判断 rule with a hard physical fact:
 *
 *   1. the snapshot's `contentFingerprint` and the fingerprint of the
 *      configuration running NOW must BOTH exist and be EQUAL. A difference means
 *      the disk was written to between the two boots (a restore, a hand edit,
 *      another writer), so this boot proved other content and the copy stays
 *      unproven. A missing fingerprint refuses too — no proof beats a guess;
 *   2. ALL FOUR startup checks (listener / routes / plugin / recovery) must have
 *      RUN and passed. A check that did not run is not a pass;
 *   3. the source says what was really checked (`full-checks` after the boot
 *      checks, `command-probe` after the health probe — never the other one);
 *   4. whether the boot had to be rescued is still recorded as true / false /
 *      null, and `null` ("not recorded") is never written as `false` — but it is
 *      NO LONGER part of the decision (phase 3): on the real machine the copy
 *      `2026-11-01T12-04-33-777Z` said `intervention=false` while that boot had
 *      actually been restored first, so "who intervened" is not measurable and
 *      "is the content the same" is;
 *   5. `backupsInfo()` hands the evidence to the interface, and an old copy
 *      without any of it reads as "not certified" instead of throwing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createRuntime,
  detectBootIntervention,
  normalizeConfig,
  profileConfigFingerprint,
  verifyRestartBoot,
} from '../index.js';
import {
  backupsRoot,
  contentFingerprintOf,
  createBackup,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  markKnownGood,
  META_NAME,
  readBackupMeta,
} from '../lib/backup.js';
import {
  BOOT_CHECK_SOURCE,
  buildRestartVerdict,
  compareConfigurationFingerprints,
  decideBootCertification,
  decideProbeCertification,
  FINGERPRINT_LOG_CHARS,
  FINGERPRINT_STATES,
  PROBE_CHECK_SOURCE,
  RESTART_CHECK_NAMES,
  shortFingerprint,
  writeRestartVerdict,
  RESTART_RESULTS,
} from '../lib/restart-verdict.js';

/* ------------------------------------------------------------------ *
 * The decision itself: the fingerprint gate first, the four checks second.
 * ------------------------------------------------------------------ */

/** The four checks, all passing, as `collectBootChecks` produces them. */
function passingChecks() {
  return RESTART_CHECK_NAMES.map((name) => ({ name, ok: true, detail: name + ' is fine' }));
}

/** What the snapshot's meta.json recorded when the copy was taken. */
const SNAPSHOT_FINGERPRINT = 'sha256:' + 'a'.repeat(64)
/** A different content entirely — a hand edit, a restore, another writer. */
const OTHER_FINGERPRINT = 'sha256:' + 'b'.repeat(64)

/** The two fingerprints of a boot that really ran on the snapshot's content. */
function sameContent() {
  return { snapshotFingerprint: SNAPSHOT_FINGERPRINT, currentFingerprint: SNAPSHOT_FINGERPRINT };
}

test('all four checks passing ON THE SAME CONTENT is the only way to full-checks', () => {
  const decision = decideBootCertification(passingChecks(), sameContent());
  assert.equal(decision.certified, true);
  assert.equal(decision.certifiedBy, BOOT_CHECK_SOURCE);
  assert.equal(decision.certifiedBy, 'full-checks');
  assert.deepEqual(decision.passed, [...RESTART_CHECK_NAMES]);
  assert.deepEqual(decision.failed, []);
  assert.deepEqual(decision.missing, []);
  assert.match(decision.reason, /all four startup checks passed/);
  // The content that was proven travels with the decision.
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.EQUAL);
  assert.equal(decision.fingerprintsEqual, true);
  assert.equal(decision.snapshotFingerprint, SNAPSHOT_FINGERPRINT);
  assert.equal(decision.currentFingerprint, SNAPSHOT_FINGERPRINT);
  assert.match(decision.reason, /exactly the configuration the snapshot holds/);
});

test('four passing checks on DIFFERENT content certify NOTHING — the configuration moved under the boot', () => {
  // THIS IS THE REAL-MACHINE FAILURE, reduced to two strings: the snapshot holds
  // one content, this boot runs another (it was restored / edited in between), so
  // the boot proves the OTHER content and the snapshot is not proven by it.
  const decision = decideBootCertification(passingChecks(), {
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    currentFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(decision.certified, false);
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.MISMATCH);
  assert.equal(decision.fingerprintsEqual, false);
  // All FOUR checks really passed: the refusal comes from the content, so the
  // reason has to say exactly that and not "something did not pass".
  assert.deepEqual(decision.passed, [...RESTART_CHECK_NAMES]);
  assert.deepEqual(decision.failed, []);
  assert.deepEqual(decision.missing, []);
  assert.match(
    decision.reason,
    /the configuration was changed between the two boots \(a restore, a manual edit or another writer\): this copy was never proven/,
  );
  // Both values are in the reason (short form), so the reader sees WHICH differ.
  assert.match(decision.reason, /sha256:aaaaa/);
  assert.match(decision.reason, /sha256:bbbbb/);
});

test('a snapshot without a fingerprint certifies nothing (an old copy is not "probably fine")', () => {
  const decision = decideBootCertification(passingChecks(), { currentFingerprint: OTHER_FINGERPRINT });
  assert.equal(decision.certified, false);
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.SNAPSHOT_MISSING);
  assert.equal(decision.snapshotFingerprint, null);
  assert.match(decision.reason, /the snapshot has no contentFingerprint/);
  assert.match(decision.reason, /taken before fingerprints existed/);
});

test('a boot that cannot fingerprint its own configuration certifies nothing', () => {
  // The profile directory is unknown (or unreadable): the running content cannot
  // be named, so "it is the same as the snapshot" cannot be shown.
  const decision = decideBootCertification(passingChecks(), { snapshotFingerprint: SNAPSHOT_FINGERPRINT });
  assert.equal(decision.certified, false);
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.CURRENT_MISSING);
  assert.equal(decision.currentFingerprint, null);
  assert.match(decision.reason, /could not fingerprint its own configuration/);
});

test('with NO fingerprint at all — the old call shape — nothing is certified', () => {
  const decision = decideBootCertification(passingChecks());
  assert.equal(decision.certified, false, 'four passing checks alone are not a proof any more');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.BOTH_MISSING);
  assert.match(decision.reason, /neither side has a configuration fingerprint/);

  // Empty / non-string values are "not recorded", never a fingerprint.
  const emptyStrings = decideBootCertification(passingChecks(), { snapshotFingerprint: '', currentFingerprint: '   ' });
  assert.equal(emptyStrings.certified, false);
  assert.equal(emptyStrings.fingerprintState, FINGERPRINT_STATES.BOTH_MISSING);
  const numbers = decideBootCertification(passingChecks(), { snapshotFingerprint: 42, currentFingerprint: null });
  assert.equal(numbers.certified, false);
  assert.equal(numbers.fingerprintState, FINGERPRINT_STATES.BOTH_MISSING);
});

test('identical fingerprints and ONE check that did not run: still nothing', () => {
  const partial = passingChecks().slice(0, 2);
  const decision = decideBootCertification(partial, sameContent());
  assert.equal(decision.certified, false, 'a shorter list is not a proof');
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.EQUAL, 'the content is fine — the checks are not');
  assert.deepEqual(decision.missing, ['plugin', 'recovery']);
  assert.match(decision.reason, /did not run: plugin, recovery/);
});

test('one failing startup check blocks the certification, and is NAMED', () => {
  for (const broken of RESTART_CHECK_NAMES) {
    const checks = passingChecks().map((check) => (check.name === broken
      ? { ...check, ok: false, detail: broken + ' went wrong' }
      : check));
    const decision = decideBootCertification(checks, sameContent());
    assert.equal(decision.certified, false, broken + ' must block the certification');
    assert.equal(decision.certifiedBy, 'none');
    assert.deepEqual(decision.failed, [broken], 'the failing check is named');
    assert.match(decision.reason, new RegExp(broken));
    // The detail is kept: the report has to be able to say WHAT went wrong.
    const detail = decision.details.find((entry) => entry.name === broken);
    assert.equal(detail.ok, false);
    assert.equal(detail.detail, broken + ' went wrong');
  }
});

test('checks that did NOT run are not a pass — the boot keeps the copy unproven', () => {
  // `resumeOnBoot` off, or a probe that never reached the checks: whatever the
  // reason, two passing checks are not four checks.
  const partial = passingChecks().slice(0, 2);
  const decision = decideBootCertification(partial, sameContent());
  assert.equal(decision.certified, false, 'a shorter list is not a proof');
  assert.equal(decision.certifiedBy, 'none');
  assert.deepEqual(decision.missing, ['plugin', 'recovery']);
  assert.match(decision.reason, /did not run: plugin, recovery/);

  // Nothing ran at all.
  const empty = decideBootCertification([], sameContent());
  assert.equal(empty.certified, false);
  assert.deepEqual(empty.missing, [...RESTART_CHECK_NAMES]);
  assert.equal(decideBootCertification(null, sameContent()).certified, false);
  // And with no fingerprint either, the content side refuses as well.
  assert.equal(decideBootCertification([]).certified, false);
});

test('a check that is not one of the four also has to pass', () => {
  const withExtra = [...passingChecks(), { name: 'cookies', ok: false, detail: 'the cookie clear failed' }]
  const decision = decideBootCertification(withExtra, sameContent())
  assert.equal(decision.certified, false, 'a failing extra check is not a clean boot')
  assert.deepEqual(decision.extraFailed, ['cookies'])
  assert.match(decision.reason, /cookies/)
});

test('a check reported twice counts as failed when one of the two failed', () => {
  const twice = [...passingChecks(), { name: 'routes', ok: false, detail: 'a route was refused' }]
  const decision = decideBootCertification(twice, sameContent())
  assert.equal(decision.certified, false, 'a report that disagrees with itself is not a pass')
  assert.deepEqual(decision.failed, ['routes'])
});

test('a changed configuration AND a failed check are reported as BOTH facts', () => {
  const broken = passingChecks().map((check) => (check.name === 'routes'
    ? { ...check, ok: false, detail: 'a route was refused' }
    : check));
  const decision = decideBootCertification(broken, {
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    currentFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(decision.certified, false);
  assert.match(decision.reason, /the configuration was changed between the two boots/);
  assert.match(decision.reason, /failed: routes/);
});

test('the fingerprint comparison on its own names the five outcomes', () => {
  const equal = compareConfigurationFingerprints(sameContent());
  assert.equal(equal.equal, true);
  assert.equal(equal.state, FINGERPRINT_STATES.EQUAL);
  assert.equal(equal.reason, null, 'a match has nothing to explain');

  const mismatch = compareConfigurationFingerprints({
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    currentFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(mismatch.equal, false);
  assert.equal(mismatch.snapshotShort.length, FINGERPRINT_LOG_CHARS, 'the log value is short, not the whole digest');
  assert.equal(mismatch.currentShort.length, FINGERPRINT_LOG_CHARS);
  assert.notEqual(mismatch.snapshotShort, mismatch.currentShort);
  assert.equal(shortFingerprint(null), '(none)', '"nothing recorded" is visible as such');
  assert.equal(shortFingerprint(''), '(none)');
});

/* ------------------------------------------------------------------ *
 * The SECOND path of the same rule: command mode (the health probe).
 *
 * WHY THESE TESTS EXIST: the first path (app mode) got the fingerprint gate in
 * `c419846`; the command-mode path kept the old shape and stamped the snapshot as
 * `command-probe` as soon as the probe answered. "A probe answered" says nothing
 * about whether the configuration in the snapshot can boot, so the same content
 * gate has to apply — and the two paths must not be able to disagree in wording
 * either, which is what the last assertion here pins.
 * ------------------------------------------------------------------ */

test('a health probe on the SAME content certifies the copy — as `command-probe`', () => {
  const decision = decideProbeCertification(sameContent());
  assert.equal(decision.certified, true);
  assert.equal(decision.certifiedBy, PROBE_CHECK_SOURCE);
  assert.equal(decision.certifiedBy, 'command-probe', 'the source says what really happened: a probe answered');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.EQUAL);
  assert.equal(decision.fingerprintsEqual, true);
  assert.equal(decision.snapshotFingerprint, SNAPSHOT_FINGERPRINT);
  assert.equal(decision.currentFingerprint, SNAPSHOT_FINGERPRINT);
  assert.match(decision.reason, /the health probe answered and this boot runs exactly the configuration the snapshot holds/);
});

test('a health probe that answered on a CHANGED configuration certifies NOTHING', () => {
  // THE SECOND PATH OF THE REAL-MACHINE FAILURE: the probe answered (an instance
  // was up), but the configuration on disk is not the one in the snapshot — it was
  // restored / edited / rewritten in between. Certifying that copy is how a broken
  // state becomes the "safe" one (the copy 2026-11-01T12-04-33-777Z).
  const decision = decideProbeCertification({
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    currentFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(decision.certified, false);
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.MISMATCH);
  assert.equal(decision.fingerprintsEqual, false);
  assert.match(
    decision.reason,
    /the configuration was changed between the two boots \(a restore, a manual edit or another writer\): this copy was never proven/,
  );
  // Both values are in the reason (short form), so the reader sees WHICH differ.
  assert.match(decision.reason, /sha256:aaaaa/);
  assert.match(decision.reason, /sha256:bbbbb/);

  // THE TWO PATHS REFUSE WITH THE SAME SENTENCE (no check problems on the app-mode
  // side, so only the content half can be the reason): one rule, one wording.
  const bootDecision = decideBootCertification(passingChecks(), {
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    currentFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(decision.reason, bootDecision.reason, 'command mode and app mode must not disagree about the news');
});

test('a health probe cannot certify a snapshot that has no fingerprint', () => {
  const decision = decideProbeCertification({ currentFingerprint: OTHER_FINGERPRINT });
  assert.equal(decision.certified, false, 'an old copy is not "probably fine" because a probe answered');
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.SNAPSHOT_MISSING);
  assert.equal(decision.snapshotFingerprint, null);
  assert.match(decision.reason, /^the copy stays unproven: /);
  assert.match(decision.reason, /the snapshot has no contentFingerprint/);
});

test('a health probe cannot certify when the running configuration cannot be fingerprinted', () => {
  const decision = decideProbeCertification({ snapshotFingerprint: SNAPSHOT_FINGERPRINT });
  assert.equal(decision.certified, false);
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.CURRENT_MISSING);
  assert.equal(decision.currentFingerprint, null);
  assert.match(decision.reason, /could not fingerprint its own configuration/);
});

test('with NO fingerprint at all the probe certifies nothing (the old call shape is not a pass)', () => {
  // THE SHAPE THE OLD CODE HAD: only the snapshot's own fingerprint was available
  // and nothing was compared — `decideProbeCertification()` with no input is that
  // case, and it refuses.
  const decision = decideProbeCertification();
  assert.equal(decision.certified, false, 'a probe answering alone is not a proof');
  assert.equal(decision.certifiedBy, 'none');
  assert.equal(decision.fingerprintState, FINGERPRINT_STATES.BOTH_MISSING);
  assert.match(decision.reason, /neither side has a configuration fingerprint/);

  // Empty / non-string values are "not recorded", never a fingerprint.
  const empty = decideProbeCertification({ snapshotFingerprint: '   ', currentFingerprint: '' });
  assert.equal(empty.certified, false);
  assert.equal(empty.fingerprintState, FINGERPRINT_STATES.BOTH_MISSING);
  assert.equal(decideProbeCertification({ snapshotFingerprint: 42, currentFingerprint: null }).certified, false);
});

/* ------------------------------------------------------------------ *
 * The intervention: true / false / null, and never a rounded-down false.
 *
 * STILL TESTED, NO LONGER DECIDING (phase 3): `detectBootIntervention` remains
 * the recorder of "who helped this boot" — it is written into the meta for later
 * investigation — but the certification is decided by the fingerprint comparison.
 * The real machine is the reason: the copy 2026-11-01T12-04-33-777Z recorded
 * `intervention=false` while that boot had actually been restored first.
 * ------------------------------------------------------------------ */

/** A state directory with nothing in it. */
function stateDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-wiring-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('a restore on record during this restart is intervention=true', (t) => {
  const dir = stateDir(t);
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, 'last-rollback.json'), JSON.stringify({
    ok: false,
    at: new Date(Date.now()).toISOString(),
    rolledBack: true,
    rollbackError: null,
    reason: 'the new instance never came up',
    backupDir: 'C:\\backups\\2026-11-01T00-00-00-000Z',
    restored: ['cordis.patch.yml'],
    appStarted: true,
  }), 'utf8');

  const answer = detectBootIntervention(dir, { sinceMs: since });
  assert.equal(answer.intervention, true);
  assert.match(answer.reason, /restored by rollback-report/);
  assert.equal(answer.sources.length, 2, 'both recorders are always reported');
});

test('the watchdog report counts as an intervention too', (t) => {
  const dir = stateDir(t);
  fs.writeFileSync(path.join(dir, 'last-watchdog-report.json'), JSON.stringify({
    at: new Date().toISOString(),
    result: 'restored',
    restored: true,
    relaunched: true,
  }), 'utf8');
  const answer = detectBootIntervention(dir, { sinceMs: Date.now() - 1000 });
  assert.equal(answer.intervention, true);
  assert.match(answer.reason, /watchdog-report/);
});

test('a recorder that says "nothing was restored" is a real FALSE', (t) => {
  const dir = stateDir(t);
  fs.writeFileSync(path.join(dir, 'last-watchdog-report.json'), JSON.stringify({
    at: new Date().toISOString(),
    result: 'not-needed',
    restored: false,
    relaunched: false,
  }), 'utf8');
  const answer = detectBootIntervention(dir, { sinceMs: Date.now() - 1000 });
  assert.equal(answer.intervention, false, 'a recorder spoke and said no');
  assert.match(answer.reason, /no restore was recorded/);
});

test('nothing to read is UNKNOWN (null), never false', (t) => {
  const dir = stateDir(t);
  const answer = detectBootIntervention(dir, { sinceMs: Date.now() - 1000 });
  assert.equal(answer.intervention, null, 'silence is not "it did not happen"');
  assert.match(answer.reason, /no restorer has recorded anything/);
});

test('a report that cannot be read is UNKNOWN (null), never false', (t) => {
  const dir = stateDir(t);
  fs.writeFileSync(path.join(dir, 'last-rollback.json'), '{ not json at all', 'utf8');
  const answer = detectBootIntervention(dir, { sinceMs: Date.now() - 1000 });
  assert.equal(answer.intervention, null);
  assert.match(answer.reason, /cannot be read/);
});

test('a restore from an EARLIER restart is not an intervention in this one', (t) => {
  const dir = stateDir(t);
  fs.writeFileSync(path.join(dir, 'last-rollback.json'), JSON.stringify({
    at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    rolledBack: true,
  }), 'utf8');
  const answer = detectBootIntervention(dir, { sinceMs: Date.now() - 1000 });
  assert.equal(answer.intervention, false, 'the reports are never deleted, so the time decides');
  assert.match(answer.reason, /older than this restart/);
});

test('a restore with no restart time to compare against is UNKNOWN', (t) => {
  const dir = stateDir(t);
  fs.writeFileSync(path.join(dir, 'last-rollback.json'), JSON.stringify({
    at: new Date().toISOString(),
    rolledBack: true,
  }), 'utf8');
  const answer = detectBootIntervention(dir, { sinceMs: null });
  assert.equal(answer.intervention, null, 'a restore that cannot be dated to this boot is not a yes');
});

/* ------------------------------------------------------------------ *
 * Through the real boot path: verifyRestartBoot.
 * ------------------------------------------------------------------ */

/** A profile-looking tree, a state directory and the backups root of it. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-wired-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  const stateDirPath = path.join(base, 'storage');
  fs.mkdirSync(stateDirPath, { recursive: true });
  return {
    base,
    profile,
    stateDir: stateDirPath,
    stateFile: path.join(stateDirPath, 'state.json'),
    backups: backupsRoot(stateDirPath),
  };
}

/**
 * The runtime `verifyRestartBoot` needs. The four checks are read off it, so the
 * test drives them the way the real boot does (`webPort` for `listener`,
 * `registeredRoutes` for `routes`, `bootId` for `plugin`, `recovery` for
 * `recovery`) — no injection points of its own.
 *
 * `profileDir` is the shape the real runtime exposes (`{ dir, source }`): the
 * fingerprint of THIS directory is the "configuration that is running now" side
 * of the certification. `warnings` collects what the boot reported, so a test can
 * read the refusal instead of trusting that it happened.
 */
function bootRuntime({ stateFile, profileDir = null }) {
  const warnings = [];
  return {
    log: {
      info: () => {},
      warn: (message, detail) => warnings.push({ message, detail }),
      error: () => {},
    },
    warnings,
    stateFile,
    profileDir: { dir: typeof profileDir === 'string' ? profileDir : null, source: 'test' },
    bootId: 'boot-wiring',
    webPort: 1234,
    registeredRoutes: [{ path: '/__dsh_autorestart/health' }],
    state: { phase: 'idle', restart: null, sessions: {} },
    pageHeartbeat: true,
    systemPrompt: true,
    recovery: { ran: true, ok: true, detail: 'the boot recovery finished' },
    manualRestartBlocks: 0,
    tools: [],
    toolErrors: [],
    recordRestartVerdict: (input, options) => {
      const verdict = buildRestartVerdict({ ...input, bootId: 'boot-wiring' });
      writeRestartVerdict(path.dirname(stateFile), verdict);
      void options;
      return verdict;
    },
  };
}

/** One unproven snapshot plus a pending restart record that points at it. */
async function pendingRestart(fixtureValues) {
  const snapshot = await createBackup({
    slimBackup: false,
    profileDir: fixtureValues.profile,
    backupsDir: fixtureValues.backups,
    includePlugins: false,
    now: 5_000,
    kind: KIND_SNAPSHOT,
  });
  assert.equal(snapshot.ok, true);
  writeRestartVerdict(fixtureValues.stateDir, buildRestartVerdict({
    result: RESTART_RESULTS.PENDING,
    startedAt: Date.now() - 1000,
    snapshot: { requested: true, taken: true, dir: snapshot.dir, stamp: snapshot.stamp },
  }));
  return snapshot;
}

test('the live-profile fingerprint and the snapshot fingerprint are the SAME stream (drift guard)', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  // lib/backup.js owns the input stream (name + length + content), index.js reads
  // the live profile with a copy of it. If either side ever changes, THIS fails —
  // which is the only thing that keeps the comparison from quietly comparing
  // apples with oranges.
  assert.equal(
    profileConfigFingerprint(values.profile),
    contentFingerprintOf(snapshot.dir),
    'the two readers must produce the same fingerprint for the same content',
  );
  // One byte of one config file is enough to move it.
  const before = profileConfigFingerprint(values.profile);
  fs.writeFileSync(path.join(values.profile, 'cordis.patch.yml'), 'rows: []\n', 'utf8');
  assert.notEqual(profileConfigFingerprint(values.profile), before, 'an edited profile has a different fingerprint');
  // "Nothing to fingerprint" is null, never a digest of nothing: that digest would
  // equal the fingerprint of an empty copy and certify a boot that proved nothing.
  const emptyProfile = path.join(values.base, 'empty-profile');
  fs.mkdirSync(emptyProfile, { recursive: true });
  assert.equal(profileConfigFingerprint(emptyProfile), null);
  assert.equal(profileConfigFingerprint(''), null);
  assert.equal(profileConfigFingerprint(null), null);
});

test('a boot whose four checks passed certifies the copy — with the evidence', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);

  // A watchdog report saying nothing was restored: a recorded "no".
  fs.writeFileSync(path.join(values.stateDir, 'last-watchdog-report.json'), JSON.stringify({
    at: new Date().toISOString(),
    restored: false,
  }), 'utf8');

  const runtime = bootRuntime({ stateFile: values.stateFile, profileDir: values.profile });
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.OK);

  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD, 'the four checks on the SAME content certified the copy');
  assert.equal(meta.certifiedBy, 'full-checks');
  assert.ok(Number.isFinite(Date.parse(meta.certifiedAt)));
  assert.equal(meta.contentScope, 'config-only');
  assert.equal(
    meta.contentFingerprint,
    contentFingerprintOf(snapshot.dir),
    'the content that was proven is the content the copy really holds',
  );
  assert.equal(meta.intervention, false, 'the recorder said nothing had to step in');
  assert.deepEqual(
    runtime.warnings.filter((entry) => /stays UNPROVEN/.test(String(entry.message))),
    [],
    'nothing had to be reported as unproven',
  );
});

test('a boot that came up on OTHER content certifies NOTHING — the 2026-11-01 incident', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  // The host came up — but only after the profile was written to (a restore, a
  // hand edit, anything): the configuration on disk is no longer the one in the
  // snapshot. This is exactly how the copy 2026-11-01T12-04-33-777Z (70-byte
  // cordis.patch.yml, certified as full-checks, intervention=false) came to be.
  fs.writeFileSync(path.join(values.profile, 'cordis.patch.yml'), 'rows:\n  - id: oops\n', 'utf8');

  const runtime = bootRuntime({ stateFile: values.stateFile, profileDir: values.profile });
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  // The restart itself DID work — the four checks really passed.
  assert.equal(record.result, RESTART_RESULTS.OK);
  assert.deepEqual(record.checks.filter((check) => check.ok !== true), []);

  // …and the copy is still not certified, and its meta is byte-for-byte untouched.
  assert.equal(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'), before, 'meta.json is unchanged');
  assert.equal(readBackupMeta(snapshot.dir).kind, KIND_SNAPSHOT, 'the copy stays unproven');
  assert.equal(readBackupMeta(snapshot.dir).certifiedBy, 'none');

  const refusal = runtime.warnings.find((entry) => /stays UNPROVEN/.test(String(entry.message)));
  assert.ok(refusal, 'the refusal is REPORTED, not silent');
  assert.match(
    String(refusal.message),
    /the configuration was changed between the two boots \(a restore, a manual edit or another writer\): this copy was never proven/,
  );
  assert.equal(refusal.detail.fingerprintState, FINGERPRINT_STATES.MISMATCH);
  // The report shows WHICH two values were compared, in short form.
  assert.equal(refusal.detail.snapshotFingerprint.length, FINGERPRINT_LOG_CHARS);
  assert.equal(refusal.detail.currentFingerprint.length, FINGERPRINT_LOG_CHARS);
  assert.notEqual(refusal.detail.snapshotFingerprint, refusal.detail.currentFingerprint);
});

test('a boot that was rescued but really ran on the snapshot content is still certified', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);

  // The watcher restored a copy during this very restart, then the host came up —
  // and the content it came up on happens to BE the snapshot content (the restore
  // put exactly this back). The physical fact holds, so the copy is proven; the
  // rescue is RECORDED (so a later selector can still refuse it) but it is not the
  // criterion any more.
  fs.writeFileSync(path.join(values.stateDir, 'last-rollback.json'), JSON.stringify({
    ok: false,
    at: new Date().toISOString(),
    rolledBack: true,
    reason: 'the new instance never came up',
    restored: ['cordis.patch.yml'],
  }), 'utf8');

  const runtime = bootRuntime({ stateFile: values.stateFile, profileDir: values.profile });
  await verifyRestartBoot(runtime, { timeoutMs: 50 });
  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.certifiedBy, 'full-checks', 'the content was the same, so the copy is proven');
  assert.equal(meta.intervention, true, 'and the rescue is recorded, so it can be excluded later');
});

test('a boot that cannot name its own configuration certifies nothing', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  // No profile directory is known (`runtime.profileDir.dir` is null): the running
  // content cannot be fingerprinted, so "it is the snapshot content" is unproven.
  const runtime = bootRuntime({ stateFile: values.stateFile });
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.OK, 'the boot itself was fine');

  assert.equal(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'), before, 'meta.json is unchanged');
  assert.equal(readBackupMeta(snapshot.dir).certifiedBy, 'none', 'no proof beats a guessed one');
  const refusal = runtime.warnings.find((entry) => /stays UNPROVEN/.test(String(entry.message)));
  assert.ok(refusal, 'the refusal is reported');
  assert.equal(refusal.detail.fingerprintState, FINGERPRINT_STATES.CURRENT_MISSING);
  assert.match(String(refusal.message), /could not fingerprint its own configuration/);
});

test('a boot with ONE failing check certifies nothing, and the meta is untouched', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  // The content is the same on both sides: the refusal here comes from the check,
  // so the two causes stay distinguishable.
  const runtime = bootRuntime({ stateFile: values.stateFile, profileDir: values.profile });
  // Exactly one check fails (the recovery step); the other three pass.
  runtime.recovery = { ran: true, ok: false, detail: 'the boot recovery failed' };
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.FAILED);

  assert.equal(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'), before, 'meta.json is byte-for-byte unchanged');
  assert.equal(readBackupMeta(snapshot.dir).kind, KIND_SNAPSHOT, 'the copy stays unproven');
  assert.equal(readBackupMeta(snapshot.dir).certifiedBy, 'none');
  // The certification is not even ATTEMPTED for a failed boot: the record already
  // reports the failing check, and `decideBootCertification` is the stricter gate
  // that runs on the boot that did verify itself. (Its own "a check did not run"
  // dimension is covered directly above, at the decision level.)
  assert.equal(
    runtime.warnings.filter((entry) => /stays UNPROVEN/.test(String(entry.message))).length,
    0,
    'nothing was certified and nothing claimed to be',
  );
});

test('a boot whose recovery check never reported certifies nothing', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  // `recovery: null` is "this check did not report anything" — not a pass.
  const runtime = bootRuntime({ stateFile: values.stateFile, profileDir: values.profile });
  runtime.recovery = null;
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.FAILED);

  assert.equal(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'), before, 'meta.json is byte-for-byte unchanged');
  assert.equal(readBackupMeta(snapshot.dir).kind, KIND_SNAPSHOT, 'the copy stays unproven');
  assert.equal(readBackupMeta(snapshot.dir).certifiedBy, 'none');
});

/* ------------------------------------------------------------------ *
 * The report exit: backupsInfo carries the evidence.
 * ------------------------------------------------------------------ */

/** A Cordis context just big enough for `createRuntime`. */
function hostContext() {
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, disarm: () => undefined, pause: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  };
}

test('backupsInfo hands certifiedBy / certifiedAt / contentScope / intervention to the interface', async (t) => {
  const values = fixture(t);
  const backups = values.backups;
  fs.mkdirSync(backups, { recursive: true });

  // A certified copy, written the way the boot path writes it.
  const certified = await createBackup({
    slimBackup: false,
    profileDir: values.profile,
    backupsDir: backups,
    includePlugins: false,
    now: 9_000,
  });
  assert.equal(certified.ok, true);
  markKnownGood(certified.dir, {
    reason: 'boot-ok',
    certifiedBy: 'full-checks',
    certifiedAt: '2026-11-01T10:00:00.000Z',
    intervention: true,
  });

  // An OLD copy: meta without any evidence field at all.
  const old = path.join(backups, '2026-01-01T00-00-00-000Z');
  fs.mkdirSync(path.join(old, 'config'), { recursive: true });
  fs.writeFileSync(path.join(old, 'config', 'cordis.patch.yml'), 'rows: []\n', 'utf8');
  fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ at: 1_000, bytes: 12, files: ['cordis.patch.yml'], includePlugins: false }), 'utf8');
  fs.writeFileSync(path.join(old, META_NAME), JSON.stringify({ kind: 'known-good', at: 1_000, version: '0.8.5' }), 'utf8');

  const runtime = createRuntime(hostContext(), normalizeConfig({
    stateFile: values.stateFile,
    backupOnRestart: true,
    maxBackups: 5,
  }), { env: { isDesktopApp: false, appExePath: null } });

  const info = runtime.backupsInfo();
  assert.equal(info.count, 2, 'both copies are listed');

  const newest = info.items.find((item) => item.dir === certified.dir);
  assert.ok(newest, 'the certified copy is in the list');
  assert.equal(newest.certifiedBy, 'full-checks');
  assert.equal(newest.certified, true);
  assert.equal(newest.certifiedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(newest.contentScope, 'config-only');
  assert.equal(newest.intervention, true, 'a rescued boot is visible to the interface');

  const oldest = info.items.find((item) => item.dir === old);
  assert.ok(oldest, 'the old copy is in the list too');
  assert.equal(oldest.certifiedBy, 'none', 'an old copy is shown as NOT certified');
  assert.equal(oldest.certified, false);
  assert.equal(oldest.certifiedAt, null);
  assert.equal(oldest.contentScope, null);
  assert.equal(oldest.intervention, null, 'unrecorded, and shown as unrecorded');
});

test('backupsInfo reports an unrecorded intervention as null, and a "no" as false', async (t) => {
  const values = fixture(t);
  fs.mkdirSync(values.backups, { recursive: true });

  const untouched = await createBackup({
    slimBackup: false,
    profileDir: values.profile,
    backupsDir: values.backups,
    includePlugins: false,
    now: 11_000,
  });
  const clean = await createBackup({
    slimBackup: false,
    profileDir: values.profile,
    backupsDir: values.backups,
    includePlugins: false,
    now: 12_000,
  });
  markKnownGood(clean.dir, { reason: 'boot-ok', certifiedBy: 'command-probe', intervention: false });

  const runtime = createRuntime(hostContext(), normalizeConfig({
    stateFile: values.stateFile,
    backupOnRestart: true,
    maxBackups: 5,
  }), { env: { isDesktopApp: false, appExePath: null } });

  const info = runtime.backupsInfo();
  const unknownOne = info.items.find((item) => item.dir === untouched.dir);
  const knownOne = info.items.find((item) => item.dir === clean.dir);
  assert.equal(unknownOne.intervention, null, 'nothing recorded is null, not false');
  assert.equal(unknownOne.certifiedBy, 'none');
  assert.equal(knownOne.intervention, false, 'a recorded "no" stays false');
  assert.equal(knownOne.certifiedBy, 'command-probe');
});
