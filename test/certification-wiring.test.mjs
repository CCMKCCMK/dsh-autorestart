/**
 * THE CERTIFICATION IS WIRED TO THE CHECKS (2026-11-01, strict mode phase 2).
 *
 * WHY THIS FILE EXISTS: phase 1 gave every copy an evidence slot and made
 * `markKnownGood` refuse to certify without one. Phase 2 answers the NEXT
 * question — "is this boot allowed to certify anything?" — and writes the answer
 * into the copy:
 *
 *   1. ALL FOUR startup checks (listener / routes / plugin / recovery) must have
 *      RUN and passed. A check that did not run is not a pass;
 *   2. the source says what was really checked (`full-checks` after the boot
 *      checks, `command-probe` after the health probe — never the other one);
 *   3. whether the boot had to be rescued is recorded as true / false / null,
 *      and `null` ("not recorded") is never written as `false`;
 *   4. `backupsInfo()` hands the evidence to the interface, and an old copy
 *      without any of it reads as "not certified" instead of throwing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRuntime, detectBootIntervention, normalizeConfig, verifyRestartBoot } from '../index.js';
import {
  backupsRoot,
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
  decideBootCertification,
  RESTART_CHECK_NAMES,
  writeRestartVerdict,
  RESTART_RESULTS,
} from '../lib/restart-verdict.js';

/* ------------------------------------------------------------------ *
 * The decision itself: four checks or nothing.
 * ------------------------------------------------------------------ */

/** The four checks, all passing, as `collectBootChecks` produces them. */
function passingChecks() {
  return RESTART_CHECK_NAMES.map((name) => ({ name, ok: true, detail: name + ' is fine' }));
}

test('all four startup checks running and passing is the ONLY way to full-checks', () => {
  const decision = decideBootCertification(passingChecks());
  assert.equal(decision.certified, true);
  assert.equal(decision.certifiedBy, BOOT_CHECK_SOURCE);
  assert.equal(decision.certifiedBy, 'full-checks');
  assert.deepEqual(decision.passed, [...RESTART_CHECK_NAMES]);
  assert.deepEqual(decision.failed, []);
  assert.deepEqual(decision.missing, []);
  assert.match(decision.reason, /all four startup checks passed/);
});

test('one failing startup check blocks the certification, and is NAMED', () => {
  for (const broken of RESTART_CHECK_NAMES) {
    const checks = passingChecks().map((check) => (check.name === broken
      ? { ...check, ok: false, detail: broken + ' went wrong' }
      : check));
    const decision = decideBootCertification(checks);
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
  const decision = decideBootCertification(partial);
  assert.equal(decision.certified, false, 'a shorter list is not a proof');
  assert.equal(decision.certifiedBy, 'none');
  assert.deepEqual(decision.missing, ['plugin', 'recovery']);
  assert.match(decision.reason, /did not run: plugin, recovery/);

  // Nothing ran at all.
  const empty = decideBootCertification([]);
  assert.equal(empty.certified, false);
  assert.deepEqual(empty.missing, [...RESTART_CHECK_NAMES]);
  assert.equal(decideBootCertification(null).certified, false);
});

test('a check that is not one of the four also has to pass', () => {
  const withExtra = [...passingChecks(), { name: 'cookies', ok: false, detail: 'the cookie clear failed' }]
  const decision = decideBootCertification(withExtra)
  assert.equal(decision.certified, false, 'a failing extra check is not a clean boot')
  assert.deepEqual(decision.extraFailed, ['cookies'])
  assert.match(decision.reason, /cookies/)
});

test('a check reported twice counts as failed when one of the two failed', () => {
  const twice = [...passingChecks(), { name: 'routes', ok: false, detail: 'a route was refused' }]
  const decision = decideBootCertification(twice)
  assert.equal(decision.certified, false, 'a report that disagrees with itself is not a pass')
  assert.deepEqual(decision.failed, ['routes'])
});

/* ------------------------------------------------------------------ *
 * The intervention: true / false / null, and never a rounded-down false.
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
 */
function bootRuntime({ stateFile }) {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateFile,
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

test('a boot whose four checks passed certifies the copy — with the evidence', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);

  // A watchdog report saying nothing was restored: a recorded "no".
  fs.writeFileSync(path.join(values.stateDir, 'last-watchdog-report.json'), JSON.stringify({
    at: new Date().toISOString(),
    restored: false,
  }), 'utf8');

  const record = await verifyRestartBoot(bootRuntime({ stateFile: values.stateFile, checks: null }), { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.OK);

  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.kind, KIND_KNOWN_GOOD, 'the four checks certified the copy');
  assert.equal(meta.certifiedBy, 'full-checks');
  assert.ok(Number.isFinite(Date.parse(meta.certifiedAt)));
  assert.equal(meta.contentScope, 'config-only');
  assert.equal(meta.intervention, false, 'the recorder said nothing had to step in');
});

test('a boot that had to be RESCUED is still certified, and carries intervention=true', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);

  // The watcher restored the profile during this very restart, then the host
  // came up. The evidence has to say so — the copy may be certified, and the
  // SELECTOR decides later whether a rescued copy is good enough.
  fs.writeFileSync(path.join(values.stateDir, 'last-rollback.json'), JSON.stringify({
    ok: false,
    at: new Date().toISOString(),
    rolledBack: true,
    reason: 'the new instance never came up',
    restored: ['cordis.patch.yml'],
  }), 'utf8');

  await verifyRestartBoot(bootRuntime({ stateFile: values.stateFile, checks: null }), { timeoutMs: 50 });
  const meta = readBackupMeta(snapshot.dir);
  assert.equal(meta.certifiedBy, 'full-checks', 'the boot DID verify itself — the evidence is kept');
  assert.equal(meta.intervention, true, 'and the rescue is recorded, so it can be excluded later');
});

test('a boot with ONE failing check certifies nothing, and the meta is untouched', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  const runtime = bootRuntime({ stateFile: values.stateFile, checks: null });
  // Exactly one check fails (the recovery step); the other three pass.
  runtime.recovery = { ran: true, ok: false, detail: 'the boot recovery failed' };
  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 });
  assert.equal(record.result, RESTART_RESULTS.FAILED);

  assert.equal(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'), before, 'meta.json is byte-for-byte unchanged');
  assert.equal(readBackupMeta(snapshot.dir).kind, KIND_SNAPSHOT, 'the copy stays unproven');
  assert.equal(readBackupMeta(snapshot.dir).certifiedBy, 'none');
});

test('a boot whose recovery check never reported certifies nothing', async (t) => {
  const values = fixture(t);
  const snapshot = await pendingRestart(values);
  const before = fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8');

  // `recovery: null` is "this check did not report anything" — not a pass.
  const runtime = bootRuntime({ stateFile: values.stateFile });
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
