/**
 * STRICT MODE — THE WATCHDOG ONLY RESTORES WHAT IT MAY TRUST (2026-11-01).
 *
 * The user's decision, in one sentence: rescue only a copy that was VERIFIED and
 * that no system intervention was recorded for; when there is no such copy, do
 * not touch anything and SAY SO.
 *
 * Why this file exists: the previous behaviour restored "the newest known-good
 * copy", and `known-good` was a stamp a boot handed itself. A copy whose boot had
 * to be rescued therefore became the rescue target — the machine put a broken
 * state back and every report said it had gone well. These tests pin the three
 * rules that end that:
 *
 *   1. the target must be certified AND `intervention !== true`
 *      (`null` = "nobody recorded it" is NOT usable — it is not a yes),
 *   2. no qualified target → strict mode: no restore, no relaunch, and a report
 *      that names every refused copy with the reason,
 *   3. a restore happens at most ONCE, and the report says which copy it was.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPending,
  MAX_RESTORES,
  readReport,
  reportPath,
  RESTORE_EXCLUSIONS,
  restoreTargetInfoOf,
  runWatchdogFlow,
  selectRestoreTarget,
} from '../lib/watchdog.js';

/* ------------------------------------------------------------------ *
 * 1. The selector: certified AND not intervened.
 * ------------------------------------------------------------------ */

/** One backup candidate, newest first when several are listed. */
function candidate(dir, { certifiedBy = 'full-checks', intervention = false, certified = null, certificationEvidence = 'default' } = {}) {
  return {
    dir: '/backups/' + dir,
    name: dir,
    certifiedBy,
    // THE CRITERION (2026-11-01): a candidate that names a source but records no
    // criterion is exactly the historical pollution, so the fixture has to say
    // which one it is building. The default describes an ordinary proven copy.
    certificationEvidence: certificationEvidence === 'default'
      ? (certifiedBy === 'none' ? null : 'fingerprint-match')
      : certificationEvidence,
    intervention,
    certified: certified === null ? certifiedBy !== 'none' : certified,
  };
}

test('the newest certified copy with intervention=false IS the restore target', () => {
  const choice = selectRestoreTarget({
    candidates: [candidate('c', { intervention: false }), candidate('b'), candidate('a')],
  });
  assert.equal(choice.strict, false);
  assert.equal(choice.target, '/backups/c', 'the newest qualified copy wins');
  assert.equal(choice.targetName, 'c');
  assert.deepEqual(choice.excluded, [], 'nothing had to be refused');
  assert.match(choice.reason, /came up with matching content/);
  assert.match(choice.reason, /no system intervention is on record/);
});

test('a copy certified by full-checks whose boot needed rescuing is REFUSED', () => {
  // This is the case the whole change is about: the evidence says the boot was
  // rescued, so the state it points at is the state somebody was already fixing.
  const choice = selectRestoreTarget({
    candidates: [candidate('rescued', { certifiedBy: 'full-checks', intervention: true }), candidate('clean')],
  });
  assert.equal(choice.target, '/backups/clean', 'the rescued copy is skipped, the older clean one is used');
  assert.equal(choice.excluded.length, 1);
  assert.equal(choice.excluded[0].name, 'rescued');
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.INTERVENED);
  assert.equal(choice.excluded[0].intervention, true, 'the report carries the evidence, not just a verdict');
  assert.equal(choice.strict, false, 'one good copy is enough');
  assert.match(choice.notes[0], /skipped before this one/);
});

test('a copy whose unrecorded rescue is the ONLY thing on record is used under the named fallback', () => {
  // THE NAMED FALLBACK (user decision, 2026-11-02, t23): when every copy on the
  // machine has an unrecorded rescue - which is what a machine nobody ever had to
  // rescue looks like - the newest copy is used and the answer says so. Refusing it
  // would leave that machine with no restore point at the one moment it needs one.
  const choice = selectRestoreTarget({
    candidates: [candidate('unknown', { intervention: null })],
  });
  assert.equal(choice.target, '/backups/unknown', 'the copy is used under the named fallback');
  assert.equal(choice.strict, false, 'it is not the strict answer');
  assert.equal(choice.interventionUnknown, true, 'and the answer is flagged as unrecorded');
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.INTERVENTION_UNKNOWN);
  assert.match(
    choice.notes.join(' '),
    /NOBODY RECORDED whether that boot was rescued/,
    'the note says out loud that the rescue was never recorded',
  );
});

test('an uncertified copy is refused, whatever its intervention says', () => {
  const choice = selectRestoreTarget({
    candidates: [candidate('plain', { certifiedBy: 'none', intervention: false })],
  });
  assert.equal(choice.target, null);
  assert.equal(choice.excluded[0].exclusion, RESTORE_EXCLUSIONS.NOT_CONTENT_VERIFIED);
});

test('no candidates at all is strict mode with a reason that says so', () => {
  const choice = selectRestoreTarget({ candidates: [] });
  assert.equal(choice.strict, true);
  assert.equal(choice.target, null);
  assert.match(choice.reason, /there is no backup at all/);
  assert.deepEqual(choice.excluded, []);
});

test('the selection NEVER falls back to "try the newest one anyway"', () => {
  // Three copies, all refused, for three different reasons — and the answer is
  // still: nothing.
  const choice = selectRestoreTarget({
    candidates: [
      candidate('a', { certifiedBy: 'none' }),
      candidate('b', { intervention: true }),
      candidate('c', { intervention: null }),
    ],
  });
  assert.equal(choice.target, null, 'a strict fallback would put a broken state back');
  assert.equal(choice.strict, true);
  assert.deepEqual(choice.excluded.map((entry) => entry.exclusion), [
    RESTORE_EXCLUSIONS.NOT_CONTENT_VERIFIED,
    RESTORE_EXCLUSIONS.INTERVENED,
    RESTORE_EXCLUSIONS.INTERVENTION_UNKNOWN,
  ]);
  assert.match(choice.reason, /none of the 3 copies has a restart record saying the instance came up with matching content/);
});

/* ------------------------------------------------------------------ *
 * 2. The marker: what the flow reads.
 * ------------------------------------------------------------------ */

test('the marker names the restore target, and says when it is blocked', () => {
  const armed = buildPending({ restoreTargetDir: '/backups/ok', profileDir: '/profile' });
  assert.equal(armed.restoreTargetDir, '/backups/ok');
  assert.equal(armed.restoreBlocked, false);
  assert.equal(armed.snapshotDir, undefined, 'the misleading name is gone from the marker');

  const blocked = buildPending({
    restoreTargetDir: '',
    restoreBlocked: true,
    restoreBlockedReason: 'no backup qualifies',
    restoreCandidates: [{ name: 'a', exclusion: 'not-content-verified' }],
    profileDir: '/profile',
  });
  const info = restoreTargetInfoOf(blocked);
  assert.equal(info.dir, '');
  assert.equal(info.blocked, true);
  assert.equal(info.reason, 'no backup qualifies');
  assert.equal(info.candidates.length, 1, 'the refused copies travel with the marker');
});

test('a marker of an OLD version is not trusted either', () => {
  // It names a directory under the old field and carries no evidence at all.
  const info = restoreTargetInfoOf({ snapshotDir: '/backups/old', profileDir: '/profile' });
  assert.equal(info.dir, '', 'an old marker cannot prove the copy was certified');
  assert.equal(info.blocked, true);
  assert.equal(info.legacy, true);
  assert.match(info.reason, /armed by an older version/);
});

/* ------------------------------------------------------------------ *
 * 3. The flow: strict mode, restore-once, restoredFrom.
 * ------------------------------------------------------------------ */

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-strict-' + label + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The dependencies of a run, all stubbed — nothing touches the disk but the report. */
function deps(options = {}) {
  const state = { restores: 0, relaunches: 0, locks: 0, releases: 0 };
  const clock = { now: 0 };
  return {
    state,
    clock,
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    pollMs: 1000,
    readReady: () => options.ready === true,
    isWithdrawn: () => false,
    probeAlive: async () => false,
    askHealth: async () => 'unknown',
    clearCookies: async () => ({ ok: true, removed: 0, error: null }),
    runRestore: () => {
      state.restores += 1;
      return options.restore === undefined ? { ok: true, dir: options.restoreDir } : options.restore;
    },
    runRelaunch: () => { state.relaunches += 1; return options.relaunch ?? { ok: true }; },
    acquireLock: () => { state.locks += 1; return true; },
    releaseLock: () => { state.releases += 1; },
    removeSchedule: () => {},
    // NO `writeReport` STUB: the flow's own writer is what the interface reads,
    // so the tests assert the file on disk rather than a spy. A spy would let the
    // report and the file drift apart without anyone noticing.
  };
}

test('STRICT MODE: with no qualified copy nothing is restored, started or locked', async (t) => {
  const dir = tempDir(t, 'strict');
  const d = deps({});
  const pending = buildPending({
    restoreTargetDir: '',
    restoreBlocked: true,
    restoreBlockedReason: 'no backup qualifies: refused 2026-11-01T10-00-00-000Z (intervened)',
    restoreCandidates: [{ dir: '/backups/x', name: '2026-11-01T10-00-00-000Z', exclusion: 'intervened' }],
    profileDir: '/profile',
    timeoutMs: 1000,
    recheckMs: 1000,
    readyTimeoutMs: 1000,
  });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.equal(report.restores, 0, 'nothing was put back');
  assert.equal(d.state.restores, 0, 'the restore dependency was never called');
  assert.equal(d.state.relaunches, 0, 'and the host was not started again either');
  assert.equal(d.state.locks, 0, 'the strict-mode answer happens before the lock is even taken');
  assert.equal(report.result, 'failed', 'the result keeps its failure meaning');
  assert.equal(report.stage, 'strict');
  assert.equal(report.strictMode, true);
  assert.match(String(report.error), /no trusted restore point/);
  assert.match(String(report.error), /nothing was restored or started/);
  assert.equal(report.restoreCandidates.length, 1, 'every refused copy is in the report');
  assert.equal(report.restoreCandidates[0].exclusion, 'intervened');
  assert.equal(report.restoredFrom, null);

  // Written where the interface reads it.
  const onDisk = readReport(dir);
  assert.equal(onDisk.result, 'failed');
  assert.equal(onDisk.strictMode, true);
  assert.match(String(onDisk.error), /no trusted restore point/);
  assert.equal(onDisk.restoreCandidates[0].name, '2026-11-01T10-00-00-000Z');
});

test('a host that answers still wins over the strict-mode stop (nothing to restore is not a failure)', async (t) => {
  const dir = tempDir(t, 'strict-ready');
  const d = deps({ ready: true });
  const pending = buildPending({ restoreTargetDir: '', restoreBlocked: true, profileDir: '/profile', timeoutMs: 10 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'not-needed', 'a host that is up needs no restore at all');
  assert.equal(d.state.restores, 0);
  assert.equal(report.strictMode, false);
});

test('the restore happens ONCE and the report says WHICH copy', async (t) => {
  const dir = tempDir(t, 'once');
  const d = deps({});
  const pending = buildPending({
    restoreTargetDir: '/backups/good',
    profileDir: '/profile',
    timeoutMs: 1000,
    recheckMs: 1000,
    readyTimeoutMs: 1000,
    maxAttempts: 3,
  });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.equal(MAX_RESTORES, 1, 'the rule is one restore, by construction');
  assert.equal(d.state.restores, 1, 'restored once — not once per attempt');
  assert.equal(report.restores, 1);
  assert.equal(report.restoredFrom, '/backups/good', 'the report names the copy it put back');
  assert.equal(report.attempts, 3, 'the START was still tried three times');
  assert.equal(d.state.relaunches, 3, 'a start may be repeated; a restore may not');
  assert.deepEqual(
    report.attemptLog.map((entry) => entry.restored),
    [true, false, false],
    'only the first attempt restored anything',
  );
  assert.deepEqual(
    report.attemptLog.map((entry) => entry.restoredFrom),
    ['/backups/good', null, null],
    'each attempt says which copy IT restored, and null when it restored none',
  );
  assert.match(String(report.error), /restored ONCE/, 'the closing message says the restore is not retried');
  assert.match(String(report.error), /no further rollback will be attempted/);
});

test('a restore that FAILS is not retried either', async (t) => {
  const dir = tempDir(t, 'restore-failed');
  const d = deps({ restore: { ok: false, error: 'the copy could not be read' } });
  const pending = buildPending({
    restoreTargetDir: '/backups/good',
    profileDir: '/profile',
    timeoutMs: 1000,
    recheckMs: 1000,
    readyTimeoutMs: 1000,
    maxAttempts: 3,
  });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.equal(d.state.restores, 1, 'a failed restore is tried exactly once per run');
  assert.equal(d.state.relaunches, 0, 'a host is not started on a profile that was not restored');
  assert.equal(report.result, 'failed');
  assert.match(String(report.error), /the copy could not be read/);
  assert.match(String(report.error), /NOT retried/, 'and the report says why there is no second try');
  assert.equal(report.restoredFrom, null, 'nothing was put back, so no copy is named');
});

test('a restore that reports its own directory is believed', async (t) => {
  const dir = tempDir(t, 'reported-dir');
  const d = deps({ restore: { ok: true, dir: '/backups/from-the-restorer' } });
  const pending = buildPending({
    restoreTargetDir: '/backups/good',
    profileDir: '/profile',
    timeoutMs: 10,
    recheckMs: 10,
    readyTimeoutMs: 10,
    maxAttempts: 1,
  });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.restoredFrom, '/backups/from-the-restorer', 'what actually happened beats what was planned');
  assert.equal(report.attemptLog[0].restoredFrom, '/backups/from-the-restorer');
});

/* ------------------------------------------------------------------ *
 * 4. The report shape the interface reads.
 * ------------------------------------------------------------------ */

test('the report carries the strict-mode fields even when nothing went wrong', async (t) => {
  const dir = tempDir(t, 'shape');
  const d = deps({ ready: true });
  const report = await runWatchdogFlow({
    pending: buildPending({ restoreTargetDir: '/backups/good', profileDir: '/profile', timeoutMs: 10 }),
    stateDir: dir,
    deps: d,
  });
  assert.equal(report.restoreTarget, '/backups/good', 'the field the operator needs is always there');
  assert.equal(report.restoreBlocked, false);
  assert.equal(report.restoreBlockedReason, null);
  assert.deepEqual(report.restoreCandidates, []);
  assert.equal(report.restoredFrom, null);
  assert.equal(report.restores, 0);
  // The file on disk is the same object the flow returned.
  const onDisk = JSON.parse(fs.readFileSync(reportPath(dir), 'utf8'));
  assert.equal(onDisk.restoreTarget, '/backups/good');
  assert.equal(onDisk.result, 'not-needed');
});
