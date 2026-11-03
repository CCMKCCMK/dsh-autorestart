/**
 * THE FIRST SAFE COPY AND THE PROMOTION (user decision, 2026-10-30) — the
 * index.js half of the backup semantics.
 *
 * Two producers of a known-good copy, and NOTHING about the old rollback path:
 *
 *   1. the FIRST boot of a NEW host process seeds one known-good copy, so a
 *      fresh installation has something to roll back to. A plugin RELOAD is not
 *      an installation and seeds nothing;
 *   2. a restart that came up CAN promote THE SNAPSHOT IT TOOK to known-good —
 *      the content proved it boots — but ONLY once the caller states which check
 *      backed it (2026-11-01). "The reboot came up" alone no longer certifies
 *      anything, because it cannot tell whether the reboot recovered on its own
 *      or was rescued by a human. A failed boot promotes nothing, as before;
 *   3. the default number of kept copies is 3 (lib/backup.js's constant).
 *
 * A failure is never silent: `state.firstInstallBackup` says `'no-known-good'`
 * and carries the reason, and the health route reports it.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, seedFirstInstallBackup, verifyRestartBoot } from '../index.js';
import {
  BACKUP_TRIGGERS,
  backupsRoot,
  BOOT_OBSERVATIONS,
  createBackup,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  latestKnownGood,
  markKnownGood,
  META_NAME,
  readBackupMeta,
} from '../lib/backup.js';
import { buildRestartVerdict, writeRestartVerdict, RESTART_RESULTS } from '../lib/restart-verdict.js'
import { selectRestoreTarget } from '../lib/watchdog.js';
import { DEFAULTS, normalizeConfig } from '../index.js';

/** A profile-looking tree, a state directory and the backups root of it. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-seed-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  const stateDir = path.join(base, 'storage');
  fs.mkdirSync(stateDir, { recursive: true });
  return { base, profile, stateDir, stateFile: path.join(stateDir, 'state.json'), backups: backupsRoot(stateDir) };
}

/** A runtime stand-in with only what the seeding needs. */
function fakeRuntime({ stateFile, isNewBoot = true }) {
  const warnings = []
  const state = { phase: 'idle', restart: null, sessions: {} }
  let persisted = 0
  return {
    state,
    stateFile,
    isNewBoot,
    bootId: 'boot-test-1',
    pluginVersion: '0.8.5',
    log: {
      info: () => {},
      warn: (message, detail) => warnings.push({ message, detail }),
      error: () => {},
    },
    persist: () => { persisted += 1 },
    warnings,
    persistedCount: () => persisted,
  }
}

/* ------------------------------------------------------------------ *
 * ① A first boot with no known-good copy seeds one.
 * ------------------------------------------------------------------ */

test('① the first boot of a new process seeds a known-good copy', async (t) => {
  const { profile, stateFile, backups } = fixture(t);
  const runtime = fakeRuntime({ stateFile });

  const record = await seedFirstInstallBackup(runtime, { maxBackups: 3 }, { profileDir: profile });

  assert.equal(record.result, 'seeded', 'the seed was written');
  assert.equal(runtime.state.firstInstallBackup.result, 'seeded', 'and reported on the state');
  assert.equal(runtime.firstInstallBackup.result, 'seeded');
  const newest = latestKnownGood(backups);
  assert.ok(newest, 'a known-good copy exists now');
  assert.equal(newest.dir, record.dir);
  assert.equal(readBackupMeta(newest.dir).kind, KIND_KNOWN_GOOD, 'the seed IS known-good, not a snapshot');
  // WHAT THE RECORD SAYS NOW (2026-11-02): what put the copy there, and — the
  // honest half — that no boot has been observed on it. The free-text
  // `reason: 'first-install'` was a sentence about a decision; the trigger is the
  // fact behind it.
  assert.equal(readBackupMeta(newest.dir).trigger, BACKUP_TRIGGERS.FIRST_INSTALL);
  assert.equal(readBackupMeta(newest.dir).boot, null, 'nothing has booted on the seed, and it says so');
  assert.equal(readBackupMeta(newest.dir).version, '0.8.5', 'the version it was seeded with');
  assert.ok(fs.existsSync(path.join(record.dir, 'config', 'cordis.patch.yml')), 'the copy really holds the profile');
});

/* ------------------------------------------------------------------ *
 * ② A plugin reload is not an installation.
 * ------------------------------------------------------------------ */

test('② a plugin reload seeds nothing, even when there is no known-good copy', async (t) => {
  const { profile, stateFile, backups } = fixture(t);
  const runtime = fakeRuntime({ stateFile, isNewBoot: false });

  const record = await seedFirstInstallBackup(runtime, {}, { profileDir: profile });

  assert.equal(record, null, 'a reload does nothing');
  assert.equal(fs.existsSync(backups) ? fs.readdirSync(backups).length : 0, 0, 'no backup was written');
  assert.equal(runtime.state.firstInstallBackup, undefined, 'and nothing is recorded');
  assert.equal(runtime.persistedCount(), 0, 'the checkpoint is not even touched');
});

test('② a machine that already has a known-good copy is not seeded twice', async (t) => {
  const { profile, stateFile, backups } = fixture(t);
  const runtime = fakeRuntime({ stateFile });
  const first = await seedFirstInstallBackup(runtime, {}, { profileDir: profile });
  assert.equal(first.result, 'seeded');

  const runtime2 = fakeRuntime({ stateFile })
  const second = await seedFirstInstallBackup(runtime2, {}, { profileDir: profile })
  assert.equal(second.result, 'present', 'a known-good copy is already there');
  assert.equal(second.dir, first.dir, 'the existing one is reported');
  assert.equal(fs.readdirSync(backups).length, 1, 'no second copy was written');
});

/* ------------------------------------------------------------------ *
 * ③ / ④ The snapshot is promoted only when the boot really worked.
 * ------------------------------------------------------------------ */

/**
 * A runtime good enough for verifyRestartBoot, with a pending record on disk.
 *
 * `profileDir` is the profile whose configuration is RUNNING in this boot: the
 * certification compares its fingerprint with the one the snapshot recorded, so a
 * fixture that does not name it can never be certified (which is the point of the
 * 2026-11-01 rule, not a test detail).
 */
function bootRuntime({ stateFile, snapshotDir, checksOk, profileDir = null }) {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateFile,
    profileDir: { dir: typeof profileDir === 'string' ? profileDir : null, source: 'test' },
    bootId: 'boot-test-2',
    webPort: 1234,
    registeredRoutes: [{ path: '/__dsh_autorestart/health' }],
    state: { phase: 'idle', restart: null, sessions: {} },
    // The four boot checks: one entry each, so `checksOk` decides the verdict.
    pageHeartbeat: checksOk,
    systemPrompt: checksOk,
    recovery: { ran: true, ok: checksOk, detail: checksOk ? 'the boot recovery finished' : 'the boot recovery failed' },
    manualRestartBlocks: 0,
    tools: [],
    toolErrors: [],
    recordRestartVerdict: (input, options) => {
      const verdict = buildRestartVerdict({ ...input, bootId: 'boot-test-2' })
      writeRestartVerdict(path.dirname(stateFile), verdict)
      void options
      return verdict
    },
    // The snapshot the pending record points at.
    snapshotDir,
  };
}

test('③ a restart that came up leaves its snapshot UNPROVEN until the caller states what was checked', async (t) => {
  const { profile, stateDir, stateFile, backups } = fixture(t);
  // The copy a restart really takes: a plain, UNPROVEN snapshot (not the seed).
  const snapshot = await createBackup({ slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: false,
    now: 1_000,
    kind: KIND_SNAPSHOT,
  })
  assert.equal(snapshot.ok, true)
  assert.equal(readBackupMeta(snapshot.dir).kind, KIND_SNAPSHOT, 'a pre-restart copy starts unproven')
  assert.equal(latestKnownGood(backups), null, 'and it is not a rollback target yet')

  const runtime = bootRuntime({ stateFile, snapshotDir: snapshot.dir, checksOk: true, profileDir: profile })
  writeRestartVerdict(stateDir, buildRestartVerdict({
    result: RESTART_RESULTS.PENDING,
    startedAt: Date.now() - 1000,
    snapshot: { requested: true, taken: true, dir: snapshot.dir, stamp: snapshot.stamp },
  }))

  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 })
  assert.equal(record.result, RESTART_RESULTS.OK, 'the boot verified itself')

  // THE CERTIFICATION IS WIRED TO THE CONTENT NOW (2026-11-01, phase 3). Before,
  // "the boot came up" was enough to promote — which is exactly how a rescued boot
  // certified a broken copy. The rule is: the snapshot's recorded fingerprint must
  // EQUAL the fingerprint of the configuration running now, and all four startup
  // checks must have run and passed. Here the profile was not touched between the
  // snapshot and the boot, so the content identity holds and the copy is promoted.
  const certified = readBackupMeta(snapshot.dir)
  assert.equal(certified.kind, KIND_KNOWN_GOOD, 'the snapshot is the known-booted copy now')
  assert.equal(certified.certifiedBy, 'full-checks', 'and it says which observation is behind it')
  // WHAT THE RECORD SAYS (2026-11-02): when the copy was taken, what put it there,
  // and what that boot reported — three answers a reader can check, instead of the
  // word "boot-ok" that read like a promise about the plugins inside.
  assert.equal(certified.trigger, BACKUP_TRIGGERS.PRE_RESTART, 'it was taken before the restart it belongs to')
  assert.equal(certified.boot.started, true, 'and the host really came up after it')
  assert.equal(certified.boot.observedBy, BOOT_OBSERVATIONS.STARTUP_CHECKS, 'watched by the four startup checks')
  assert.equal(certified.boot.contentMatched, true, 'running exactly the content the copy holds')
  assert.ok(Number.isFinite(Date.parse(certified.boot.at)), 'with the moment it was checked')
  // AN EMPTY LIST, NOT `null`: the four checks ran, and the `plugin` check is the
  // one that reports plugin load failures — so this boot CAN answer the question,
  // and the answer is "none". (`null` would mean nobody looked.)
  assert.deepEqual(certified.boot.loadFailures, [], 'this boot reported no plugin load failure')
  assert.equal(certified.contentScope, 'config-only', 'and the content the check applies to')
  // No restorer report is on disk in this fixture, so nobody can say whether this
  // boot needed help: `null` ("not recorded") — never a made-up `false`.
  assert.equal(certified.intervention, null, 'an unrecorded intervention stays unknown')
  assert.equal(certified.reason, null, 'the old verdict word is gone from the record')
  // AND NOTHING ON DISK CARRIES A VERDICT: the derivation belongs to this process.
  const raw = JSON.parse(fs.readFileSync(path.join(snapshot.dir, META_NAME), 'utf8'))
  for (const field of ['kind', 'reason', 'certifiedBy', 'certificationEvidence', 'certifiedAt']) {
    assert.equal(Object.prototype.hasOwnProperty.call(raw, field), false, `meta.json must not carry "${field}"`)
  }
  assert.equal(raw.boot.started, true)
  assert.equal(raw.boot.contentMatched, true)
  // A COPY WHOSE RESCUE NOBODY RECORDED IS NOT A RESTORE POINT (user decision,
  // 2026-11-02, t23/t25). The record must say `null` - never a made-up `false` -
  // and that is exactly why this reader refuses it: `null` is not a licence.
  // The narrow fallback that still lets such a machine recover itself lives in
  // `selectRestoreTarget`, and it says out loud that the rescue was never recorded.
  assert.equal(latestKnownGood(backups), null, 'an unrecorded rescue is not a restore point for this reader')
  const choice = selectRestoreTarget({
    candidates: [{
      dir: snapshot.dir,
      name: 'snapshot',
      boot: certified.boot,
      intervention: certified.intervention,
    }],
  })
  assert.equal(choice.target, snapshot.dir, 'the named fallback still lets that machine recover')
  assert.equal(choice.interventionUnknown, true, 'and it says the rescue was never recorded')
});

test('④ a failed boot promotes nothing', async (t) => {
  const { profile, stateDir, stateFile } = fixture(t);
  const seedRuntime = fakeRuntime({ stateFile })
  const seeded = await seedFirstInstallBackup(seedRuntime, {}, { profileDir: profile })

  // A SECOND copy, taken by a restart that did NOT come up: it must stay a
  // plain snapshot (the seed stays the only known-good one).
  const later = path.join(path.dirname(seeded.dir), '2026-10-30T10-00-00-000Z')
  fs.mkdirSync(path.join(later, 'config'), { recursive: true })
  fs.writeFileSync(path.join(later, 'manifest.json'), JSON.stringify({ at: 1, bytes: 1, files: [] }), 'utf8')
  fs.writeFileSync(path.join(later, 'meta.json'), JSON.stringify({ kind: KIND_SNAPSHOT }), 'utf8')

  const runtime = bootRuntime({ stateFile, snapshotDir: later, checksOk: false, profileDir: profile })
  writeRestartVerdict(stateDir, buildRestartVerdict({
    result: RESTART_RESULTS.PENDING,
    startedAt: Date.now() - 1000,
    snapshot: { requested: true, taken: true, dir: later, stamp: path.basename(later) },
  }))

  const record = await verifyRestartBoot(runtime, { timeoutMs: 50 })
  assert.equal(record.result, RESTART_RESULTS.FAILED, 'the boot did not verify itself');
  assert.equal(readBackupMeta(later).kind, KIND_SNAPSHOT, 'a failed boot promotes NOTHING');
  assert.equal(latestKnownGood(path.dirname(seeded.dir)).dir, seeded.dir, 'the seed is still the safe copy');
});

/* ------------------------------------------------------------------ *
 * ⑤ A failed seed is reported, not swallowed.
 * ------------------------------------------------------------------ */

test('⑤ a seed that cannot be written says so, with the reason', async (t) => {
  const { stateFile } = fixture(t);
  const runtime = fakeRuntime({ stateFile });
  // No such profile: the copy cannot be taken.
  const missing = path.join(os.tmpdir(), 'dsh-ar-no-profile-xyz')

  const record = await seedFirstInstallBackup(runtime, {}, { profileDir: missing })

  assert.equal(record.result, 'no-usable-backup');
  assert.equal(runtime.state.firstInstallBackup.result, 'no-usable-backup', 'the state says the machine has no usable copy');
  assert.equal(typeof runtime.state.firstInstallBackup.error, 'string');
  assert.ok(runtime.state.firstInstallBackup.error.length > 0, 'and why');
  assert.equal(latestKnownGood(backupsRoot(path.dirname(stateFile))), null, 'nothing was written');
});

/* ------------------------------------------------------------------ *
 * ⑥ TWO copies are the default now (design, 2026-11-02).
 * ------------------------------------------------------------------ */

test('⑥ the configuration default is two copies', () => {
  assert.equal(DEFAULTS.maxBackups, 2, 'the default of the config');
  assert.equal(normalizeConfig({}).maxBackups, 2, 'and after normalization');
  assert.equal(normalizeConfig({ maxBackups: 'nonsense' }).maxBackups, 2, 'a wrong value falls back to two');
  assert.equal(normalizeConfig({ maxBackups: 1 }).maxBackups, 1, 'an explicit value still wins');
  assert.equal(normalizeConfig({ maxBackups: 20 }).maxBackups, 20, 'and so does a bigger one');
});

/* ------------------------------------------------------------------ *
 * The plugin still activates: the seeding call site is wired and harmless.
 * ------------------------------------------------------------------ */

test('the plugin activates with the seeding wired in (no known-good on a first boot)', async (t) => {
  const { stateDir } = fixture(t)
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: () => undefined,
  }
  // `apply` must not throw with the seed enabled; the copy itself is allowed to
  // fail here (the test profile is not a real one) — the point is that the boot
  // path never waits for it and never breaks.
  assert.doesNotThrow(() => apply(ctx, { stateFile: path.join(stateDir, 'state.json'), resumeOnBoot: false }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(fs.existsSync(stateDir), 'the state directory is there')
});
