/**
 * Unit tests for lib/plugin-recover.js — the restore of a plugin that did not
 * load.
 *
 * Everything here runs against a SYNTHETIC backup directory and a synthetic
 * profile, so the four decisions (overwrite / replace-link / no-backup /
 * not-enabled), the evidence rename, the idempotency comparison, the attempt
 * budget and the report are all pinned without touching a real machine.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBackup, KIND_KNOWN_GOOD, writeBackupMeta } from '../lib/backup.js';
import { findPluginFailures } from '../lib/plugin-failure.js';
import {
  applyPluginRecovery,
  attemptsFor,
  brokenNameFor,
  buildRecoveryReport,
  createRecoveryState,
  decideAttempt,
  detectPluginRecovery,
  findLatestStartupLog,
  handledRecord,
  isEnabledPlugin,
  listStartupLogs,
  locateBackupCopy,
  markHandled,
  normalizeRecoveryState,
  parseStartupLogName,
  planPluginRecovery,
  readRecoveryReport,
  readRecoveryState,
  readRestoreHistory,
  RECOVERY_MODES,
  RECOVERY_REPORT_NAME,
  recordAttempt,
  recoveryStamp,
  resetRecoveryCycle,
  RESTORE_HISTORY_LIMIT,
  RESTORE_HISTORY_NAME,
  restoreOnePlugin,
  sameAsBackup,
  summarizeRecoveryReport,
  summarizeRestoreHistory,
  treeDigest,
  writeRecoveryReport,
  writeRecoveryState,
} from '../lib/plugin-recover.js';

/** A temporary directory per test. */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-recover-${label}-`));
}

/** Write one file, creating its directory. */
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/**
 * A synthetic known-good backup with a real copy of one plugin and the CONTENTS
 * of a linked one, plus the identity file the planner reads.
 */
function makeBackup(root, { copied = ['copied-plugin'], linked = ['linked-plugin'] } = {}) {
  const backupDir = path.join(root, 'backups', '20261101T000000Z');
  for (const name of copied) {
    writeFile(path.join(backupDir, 'node_modules', name, 'package.json'), `{"name":"${name}","version":"1.0.0"}`);
    writeFile(path.join(backupDir, 'node_modules', name, 'index.js'), 'export const good = true;\n');
  }
  for (const name of linked) {
    writeFile(path.join(backupDir, 'node_modules-link', name, 'package.json'), `{"name":"${name}","version":"0.9.0"}`);
    writeFile(path.join(backupDir, 'node_modules-link', name, 'index.js'), 'export const linked = true;\n');
  }
  writeBackupMeta(backupDir, {
    kind: KIND_KNOWN_GOOD,
    at: 1_761_000_000_000,
    version: '0.9.0',
    reason: 'boot-ok',
  });
  return backupDir;
}

/** A synthetic profile with one broken (live) copy of a plugin. */
function makeProfile(root, { name = 'copied-plugin', body = 'export const broken = true;\n' } = {}) {
  const profileDir = path.join(root, 'profile');
  writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { [name]: 'file:./broken' },
    dsh: { profile: { bundles: [] } },
  }, null, 2));
  writeFile(path.join(profileDir, 'node_modules', name, 'package.json'), `{"name":"${name}","version":"2.0.0-broken"}`);
  writeFile(path.join(profileDir, 'node_modules', name, 'index.js'), body);
  return profileDir;
}

/** The failure a log would produce for one plugin. */
function failureFor(plugin, error = 'Error: boom', at = 1_761_000_100_000) {
  const failures = findPluginFailures(`- ${plugin}: failed to import: ${error}`, { logAt: at });
  assert.equal(failures.length, 1);
  return failures[0];
}

// ---------------------------------------------------------------------------
// The four decisions
// ---------------------------------------------------------------------------

test('plan says overwrite when the backup holds a real copy', () => {
  const root = tempDir('overwrite');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin')],
    backupDir,
    profileDir,
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(plan.actions[0].source, path.join(backupDir, 'node_modules', 'copied-plugin'));
  // The identity of the backup travels with the decision: it is what the report
  // answers "restored to when" with.
  assert.equal(plan.backupKind, KIND_KNOWN_GOOD);
  assert.equal(plan.restoredAt, 1_761_000_000_000);
});

test('plan says replace-link when the backup only holds the contents of a link', () => {
  const root = tempDir('replace-link');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root, { name: 'linked-plugin' });
  const plan = planPluginRecovery({
    failures: [failureFor('linked-plugin')],
    backupDir,
    profileDir,
  });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.REPLACE_LINK);
  assert.equal(plan.actions[0].source, path.join(backupDir, 'node_modules-link', 'linked-plugin'));
});

test('plan says no-backup when the backup holds nothing for the plugin', () => {
  const root = tempDir('no-backup');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const plan = planPluginRecovery({
    failures: [failureFor('unknown-plugin')],
    backupDir,
    profileDir,
  });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.NO_BACKUP);
  assert.equal(plan.actions[0].source, null);
  assert.match(plan.actions[0].reason, /neither a copy nor the contents/);
  assert.equal(plan.restorable, 0, 'nothing can be restored, so nothing may restart');
});

test('plan says no-backup when the machine has no known-good backup at all', () => {
  const root = tempDir('no-backup-dir');
  const profileDir = makeProfile(root);
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin')],
    backupDir: null,
    profileDir,
  });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.NO_BACKUP);
  assert.match(plan.actions[0].reason, /no known-good backup/);
});

test('plan says no-backup for a plugin the profile does not enable', () => {
  const root = tempDir('not-enabled');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin')],
    backupDir,
    profileDir,
    enabledPlugins: ['some-other-plugin'],
  });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.NO_BACKUP);
  assert.match(plan.actions[0].reason, /not in the enabled plugin list/);
});

test('isEnabledPlugin accepts the short name of a scoped package', () => {
  assert.equal(isEnabledPlugin(null, 'anything'), true, 'no list = no filter');
  assert.equal(isEnabledPlugin(['@scope/thing'], '@scope/thing'), true);
  assert.equal(isEnabledPlugin(['@scope/thing'], 'thing'), true);
  assert.equal(isEnabledPlugin(['@scope/thing'], 'other'), false);
});

// ---------------------------------------------------------------------------
// The evidence: nothing is ever deleted
// ---------------------------------------------------------------------------

test('applyPluginRecovery renames the live directory aside and copies the backup back', () => {
  const root = tempDir('apply');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const now = 1_761_000_200_000;
  const renames = [];
  const copies = [];
  // A spy around the real fs: the rename ARGUMENTS are the contract ("the
  // evidence is <name>.broken-<ts> in node_modules, nothing deleted").
  const spyingFs = {
    ...fs,
    renameSync: (from, to) => {
      renames.push([from, to]);
      return fs.renameSync(from, to);
    },
  };
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin')],
    backupDir,
    profileDir,
    fs: spyingFs,
  });
  const applied = applyPluginRecovery({
    plan,
    profileDir,
    now,
    fs: spyingFs,
    copy: (from, to) => {
      copies.push([from, to]);
      fs.cpSync(from, to, { recursive: true, force: true });
      return { ok: true, error: null };
    },
  });
  const live = path.join(profileDir, 'node_modules', 'copied-plugin');
  const expectedBroken = path.join(profileDir, 'node_modules', brokenNameFor('copied-plugin', now));
  assert.deepEqual(renames, [[live, expectedBroken]], 'the broken tree is renamed, never removed');
  assert.match(path.basename(expectedBroken), /^copied-plugin\.broken-\d{8}T\d{6}$/);
  assert.equal(fs.existsSync(expectedBroken), true, 'the evidence is still on disk');
  assert.equal(
    fs.readFileSync(path.join(expectedBroken, 'index.js'), 'utf8'),
    'export const broken = true;\n',
    'the broken content is preserved, not deleted',
  );
  assert.deepEqual(copies, [[path.join(backupDir, 'node_modules', 'copied-plugin'), live]]);
  assert.equal(applied.changed, true);
  assert.equal(fs.readFileSync(path.join(live, 'index.js'), 'utf8'), 'export const good = true;\n');
  assert.equal(applied.actions[0].restoredFrom, path.join(backupDir, 'node_modules', 'copied-plugin'));
});

test('applyPluginRecovery removes the live LINK by moving it aside as well', () => {
  const root = tempDir('apply-link');
  const backupDir = makeBackup(root);
  const profileDir = path.join(root, 'profile');
  writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'profile' }));
  // A junction is not a copy: the whole point of replace-link.
  const target = path.join(root, 'linked-target');
  writeFile(path.join(target, 'index.js'), 'export const dev = true;\n');
  const link = path.join(profileDir, 'node_modules', 'linked-plugin');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  const plan = planPluginRecovery({
    failures: [failureFor('linked-plugin')],
    backupDir,
    profileDir,
  });
  const applied = applyPluginRecovery({ plan, profileDir, now: 1_761_000_300_000 });
  assert.equal(applied.changed, true);
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.REPLACE_LINK);
  const live = path.join(profileDir, 'node_modules', 'linked-plugin');
  assert.equal(fs.lstatSync(live).isSymbolicLink(), false, 'the live entry is now a real directory');
  assert.equal(fs.readFileSync(path.join(live, 'index.js'), 'utf8'), 'export const linked = true;\n');
  const aside = fs.readdirSync(path.join(profileDir, 'node_modules'))
    .filter((name) => name.startsWith('linked-plugin.broken-'));
  assert.equal(aside.length, 1, 'the link itself is kept as evidence');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an already identical plugin is NOT copied and NOT reported as changed', () => {
  const root = tempDir('idempotent');
  const backupDir = makeBackup(root);
  const profileDir = path.join(root, 'profile');
  // The live tree is EXACTLY the backup content (the restore already happened).
  fs.cpSync(
    path.join(backupDir, 'node_modules', 'copied-plugin'),
    path.join(profileDir, 'node_modules', 'copied-plugin'),
    { recursive: true, force: true },
  );
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin')],
    backupDir,
    profileDir,
  });
  let copyCalls = 0;
  const applied = applyPluginRecovery({
    plan,
    profileDir,
    copy: () => {
      copyCalls += 1;
      return { ok: true, error: null };
    },
  });
  assert.equal(copyCalls, 0, 'nothing is copied when the live directory already matches');
  assert.equal(applied.changed, false, 'nothing changed, so nothing may restart');
  assert.equal(applied.actions[0].mode, RECOVERY_MODES.ALREADY_CONSISTENT);
  assert.match(applied.actions[0].reason, /already equals the backup/);
});

test('treeDigest and sameAsBackup tell "same" from "different"', () => {
  const root = tempDir('digest');
  const one = path.join(root, 'one');
  const two = path.join(root, 'two');
  writeFile(path.join(one, 'a.js'), 'a');
  writeFile(path.join(two, 'a.js'), 'a');
  assert.equal(treeDigest(one).digest, treeDigest(two).digest);
  writeFile(path.join(two, 'a.js'), 'b');
  const comparison = sameAsBackup(one, two);
  assert.equal(comparison.same, false);
  assert.equal(comparison.known, true);
  assert.equal(sameAsBackup(one, path.join(root, 'missing')).known, false, 'a missing tree is unknown, never "same"');
});

// ---------------------------------------------------------------------------
// The attempt budget (the plugin-level loop guard)
// ---------------------------------------------------------------------------

test('the first attempt is allowed and the second is refused', () => {
  const state = createRecoveryState();
  const first = decideAttempt(state, 'p');
  assert.equal(first.allowed, true);
  assert.equal(first.attempts, 0);
  recordAttempt(state, 'p', { now: 1_761_000_400_000 });
  assert.equal(attemptsFor(state, 'p'), 1);
  const second = decideAttempt(state, 'p');
  assert.equal(second.allowed, false);
  assert.match(second.reason, /already used its 1 restore attempt/);
});

test('a refused attempt makes the plan "needs human" and touches nothing', () => {
  const root = tempDir('needs-human');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const recovery = createRecoveryState();
  recordAttempt(recovery, 'copied-plugin', { now: 1_761_000_400_000 });
  const plan = planPluginRecovery({
    failures: [failureFor('copied-plugin', 'Error: still broken')],
    backupDir,
    profileDir,
    recovery,
  });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.NEEDS_HUMAN);
  assert.equal(plan.actions[0].needsHuman, true);
  assert.equal(plan.needsHuman, true);
  const applied = applyPluginRecovery({ plan, profileDir });
  assert.equal(applied.changed, false);
  assert.equal(
    fs.readFileSync(path.join(profileDir, 'node_modules', 'copied-plugin', 'index.js'), 'utf8'),
    'export const broken = true;\n',
    'a plugin that already used its attempt is left alone',
  );
});

test('a handled fingerprint makes the plan say duplicate', () => {
  const root = tempDir('duplicate');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const failure = failureFor('copied-plugin');
  const recovery = createRecoveryState();
  markHandled(recovery, { fingerprint: failure.fingerprint, plugin: 'copied-plugin', now: 1_761_000_500_000 });
  assert.ok(handledRecord(recovery, failure.fingerprint));
  const plan = planPluginRecovery({ failures: [failure], backupDir, profileDir, recovery });
  assert.equal(plan.actions[0].mode, RECOVERY_MODES.DUPLICATE);
  assert.match(plan.actions[0].reason, /already handled/);
});

test('the bookkeeping survives a round trip and a broken file never breaks a boot', () => {
  const stateDir = tempDir('state');
  const state = createRecoveryState();
  recordAttempt(state, 'p', { now: 5, restarted: true });
  markHandled(state, { fingerprint: 'abc', plugin: 'p', now: 5 });
  assert.equal(writeRecoveryState(stateDir, state), true);
  const read = readRecoveryState(stateDir);
  assert.equal(read.corrupt, false);
  assert.equal(read.entries[0].plugin, 'p');
  assert.equal(read.entries[0].restartedAt, 5);
  assert.equal(read.handled[0].fingerprint, 'abc');
  fs.writeFileSync(path.join(stateDir, 'plugin-recovery.json'), '{not json', 'utf8');
  const broken = readRecoveryState(stateDir);
  assert.equal(broken.corrupt, true);
  assert.deepEqual(broken.entries, [], 'a corrupt file is reported, not thrown');
});

test('normalizeRecoveryState repairs unknown fields', () => {
  const normalized = normalizeRecoveryState({
    version: 99,
    entries: [{ plugin: 'a', attempts: '2', junk: true }, { plugin: '' }, null],
    handled: [{ fingerprint: 'x' }, { fingerprint: 'x' }, { nope: 1 }],
  });
  assert.equal(normalized.version, 1);
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].attempts, 2);
  assert.equal(normalized.handled.length, 1, 'a repeated fingerprint is kept once');
});

test('a clean boot resets the cycle', () => {
  const state = createRecoveryState();
  recordAttempt(state, 'p', { now: 1 });
  markHandled(state, { fingerprint: 'abc', plugin: 'p', now: 1 });
  const reset = resetRecoveryCycle(state, { now: 2 });
  assert.equal(reset.reset, true);
  assert.equal(reset.entries, 1);
  assert.equal(reset.handled, 1);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.handled, []);
  assert.equal(resetRecoveryCycle(state, { now: 3 }).reset, false, 'an empty cycle is not "reset" again');
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test('the report carries at / atIso / failures / actions / flags and the backup identity', () => {
  const root = tempDir('report');
  const backupDir = makeBackup(root);
  const profileDir = makeProfile(root);
  const at = 1_761_000_600_000;
  const failure = failureFor('copied-plugin');
  const plan = planPluginRecovery({ failures: [failure], backupDir, profileDir });
  const applied = applyPluginRecovery({ plan, profileDir, now: at });
  const report = buildRecoveryReport({
    at,
    failures: [failure],
    actions: applied.actions,
    restartRequested: true,
    needsHuman: applied.needsHuman,
    backupDir: plan.backupDir,
    backupKind: plan.backupKind,
    restoredAt: plan.restoredAt,
  });
  assert.equal(report.at, at);
  assert.equal(report.atIso, new Date(at).toISOString());
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].plugin, 'copied-plugin');
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(report.actions[0].restoredAt, 1_761_000_000_000, 'from the backup meta, not from the clock');
  assert.equal(report.actions[0].backupKind, KIND_KNOWN_GOOD);
  assert.ok(report.actions[0].restoredFrom.endsWith(path.join('node_modules', 'copied-plugin')));
  assert.equal(report.actions[0].evidence.renamedTo.includes('.broken-'), true);
  assert.equal(report.restartRequested, true);
  assert.equal(report.needsHuman, false);
  assert.equal(report.changed, true);

  const stateDir = tempDir('report-write');
  assert.equal(writeRecoveryReport(stateDir, report), true);
  assert.equal(fs.existsSync(path.join(stateDir, RECOVERY_REPORT_NAME)), true);
  const read = readRecoveryReport(stateDir);
  assert.equal(read.at, at);
  assert.equal(read.actions[0].plugin, 'copied-plugin');

  const summary = summarizeRecoveryReport(read);
  assert.equal(summary.at, at);
  assert.equal(summary.failures[0].plugin, 'copied-plugin');
  assert.equal(summary.actions[0].mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(summary.restartRequested, true);
  assert.equal(summarizeRecoveryReport(null), null);
});

test('a report of a decision that changed nothing says so', () => {
  const failure = failureFor('ghost-plugin');
  const report = buildRecoveryReport({
    at: 1,
    failures: [failure],
    actions: [{ plugin: 'ghost-plugin', mode: RECOVERY_MODES.NO_BACKUP, applied: false, changed: false, reason: 'nope' }],
    restartRequested: false,
    needsHuman: false,
  });
  assert.equal(report.restartRequested, false);
  assert.equal(report.changed, false);
});

// ---------------------------------------------------------------------------
// Log discovery and the two timestamps
// ---------------------------------------------------------------------------

test('parseStartupLogName reads the boot time out of the file name', () => {
  assert.equal(
    parseStartupLogName('startup-2026-10-31T15-33-37.501Z-e07a9932-22e8.log'),
    Date.parse('2026-10-31T15:33:37.501Z'),
  );
  assert.equal(parseStartupLogName('other.log'), null);
});

test('findLatestStartupLog only returns a log of a FINISHED boot', () => {
  const logsDir = tempDir('logs');
  const older = path.join(logsDir, 'startup-2026-10-31T10-00-00.000Z-aaa.log');
  const current = path.join(logsDir, 'startup-2026-10-31T12-00-00.000Z-bbb.log');
  writeFile(older, 'old');
  writeFile(current, 'current');
  fs.utimesSync(older, new Date('2026-10-31T10:00:05Z'), new Date('2026-10-31T10:00:05Z'));
  fs.utimesSync(current, new Date('2026-10-31T12:00:05Z'), new Date('2026-10-31T12:00:05Z'));
  const logs = listStartupLogs(logsDir);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].path, current, 'newest first');
  // This boot started at 12:00:00: the log written at 12:00:05 belongs to it,
  // so only the older one describes a finished boot.
  const finished = findLatestStartupLog(logsDir, { before: Date.parse('2026-10-31T12:00:00Z') });
  assert.equal(finished.path, older);
  // Not even a finished boot exists: nothing to judge.
  assert.equal(findLatestStartupLog(logsDir, { before: Date.parse('2026-10-31T09:00:00Z') }), null);
  assert.equal(findLatestStartupLog(path.join(logsDir, 'nope'), {}), null);
});

test('recoveryStamp is file-system safe', () => {
  const stamp = recoveryStamp(1_761_000_700_000);
  assert.match(stamp, /^\d{8}T\d{6}$/);
  assert.equal(brokenNameFor('@scope/plugin', 1_761_000_700_000), '@scope_plugin.broken-' + stamp);
});

test('locateBackupCopy reports both shapes and the empty case', () => {
  const root = tempDir('locate');
  const backupDir = makeBackup(root);
  assert.equal(locateBackupCopy({ backupDir, plugin: 'copied-plugin' }).mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(locateBackupCopy({ backupDir, plugin: 'linked-plugin' }).mode, RECOVERY_MODES.REPLACE_LINK);
  assert.equal(locateBackupCopy({ backupDir, plugin: 'ghost' }).mode, RECOVERY_MODES.NO_BACKUP);
});

// ---------------------------------------------------------------------------
// The caller wires these together: a full backup of a real profile shape still
// produces the manifest the planner reads.
// ---------------------------------------------------------------------------

test('a real createBackup produces the layout the planner looks for', async () => {
  const root = tempDir('create-backup');
  const profileDir = makeProfile(root);
  const backupsDir = path.join(root, 'backups');
  const result = await createBackup({
    profileDir,
    backupsDir,
    includePlugins: true,
    kind: KIND_KNOWN_GOOD,
    now: 1_761_000_800_000,
  });
  assert.equal(result.ok, true);
  const located = locateBackupCopy({ backupDir: result.dir, plugin: 'copied-plugin' });
  assert.equal(located.mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(located.source, path.join(result.dir, 'node_modules', 'copied-plugin'));
});

// ---------------------------------------------------------------------------
// CONVERGENCE (user decision, 2026-11-01): THE BOOT PASS ONLY LOOKS.
//
// "只提示，不改文件": the host already survives a broken plugin (measured at 22 s
// on the desktop and 2.0–2.6 s on hosted `dsh web`, profile byte-identical, no
// repeated restarts under the supervisor), so the boot pass must NOT restore
// anything and must NOT ask for a restart. These tests pin exactly that.
// ---------------------------------------------------------------------------

/**
 * The two instants the boot-pass fixtures own.
 *
 * `LOG_AT` is the moment the fixture's startup log DESCRIBES — and the mtime it
 * is pinned to. `BOOT_AT` is the boot the tests pretend to be, and it is strictly
 * LATER. The relation `LOG_AT < BOOT_AT` is what the boot pass depends on
 * (`log.mtime <= cutoff` in lib/plugin-recover.js) and it is asserted below
 * instead of being left to the calendar.
 */
const LOG_AT = Date.parse('2026-11-01T00:00:01.100Z');
const BOOT_AT = Date.parse('2026-11-01T01:00:00.000Z');

/**
 * Pin a startup log's mtime to the moment it DESCRIBES.
 *
 * WHY THIS EXISTS: the boot pass keeps a log only when its mtime is NOT LATER
 * than the boot under test (`log.mtime <= cutoff` — the behaviour under test,
 * left untouched). A file written by `writeFile` carries the REAL clock while
 * the boot time in these tests is a fixed date, so the whole group was green
 * only until the calendar passed that date: on 2026-11-01 everything here turned
 * red at 09:00 (+08:00) with not one byte of production code changed. Pinning
 * the mtime makes the fixture time-independent WITHOUT weakening anything — the
 * lookup still compares mtimes, it just compares two fixed instants now.
 *
 * @param {string} logPath
 * @param {number} [at]
 * @returns {number} the pinned mtime (ms)
 */
function pinLogTime(logPath, at = LOG_AT) {
  const when = new Date(at);
  fs.utimesSync(logPath, when, when);
  return at;
}

/** A startup log for the previous boot, in the state directory layout. */
function writeStartupLog(root, { plugin = 'copied-plugin', error = 'Error: boom', at = '2026-11-01T00:00:01.100Z' } = {}) {
  const logsDir = path.join(root, 'logs');
  const logPath = path.join(logsDir, 'startup-2026-11-01T00-00-00.000Z-aaaa.log');
  writeFile(logPath, [
    '2026-11-01T00:00:01.000Z dsh: warning: 1 entry did not activate',
    `${at} - ${plugin}: failed to import: ${error}`,
  ].join('\n'));
  pinLogTime(logPath);
  return { logsDir, logPath };
}

test('the boot-pass fixture pins its log strictly BEFORE the boot under test', () => {
  const root = tempDir('clock-guard');
  const { logsDir, logPath } = writeStartupLog(root);
  // The property the whole group relies on, asserted instead of assumed.
  assert.equal(LOG_AT < BOOT_AT, true, 'the fixture log is older than the boot it belongs to');
  const mtimeMs = fs.statSync(logPath).mtimeMs;
  assert.equal(mtimeMs < BOOT_AT, true, 'the log on disk is strictly older than the boot under test');
  // A small tolerance: some file systems round the mtime they store.
  assert.equal(Math.abs(mtimeMs - LOG_AT) < 5, true, 'the mtime really was pinned to the fixture instant');
  // And the pin does not break the lookup it is there for.
  const found = findLatestStartupLog(logsDir, { before: BOOT_AT });
  assert.ok(found, 'the log of the previous boot is still found');
  assert.equal(found.path, logPath);
});

/** sha256 of every file under one directory, keyed by relative path. */
function digestTree(dir) {
  const out = {}
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  if (fs.existsSync(dir)) walk(dir, '')
  return out
}

/** An fs wrapper that records every write, rename and copy. */
function spyingFs(sink) {
  return {
    readFileSync: fs.readFileSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: (target, options) => {
      sink.push({ op: 'mkdir', target: String(target) })
      return fs.mkdirSync(target, options)
    },
    writeFileSync: (target, data, options) => {
      sink.push({ op: 'write', target: String(target) })
      return fs.writeFileSync(target, data, options)
    },
    renameSync: (from, to) => {
      sink.push({ op: 'rename', target: String(to) })
      return fs.renameSync(from, to)
    },
    cpSync: (from, to, options) => {
      sink.push({ op: 'copy', target: String(to) })
      return fs.cpSync(from, to, options)
    },
    rmSync: (target, options) => {
      sink.push({ op: 'remove', target: String(target) })
      return fs.rmSync(target, options)
    },
    unlinkSync: (target) => {
      sink.push({ op: 'unlink', target: String(target) })
      return fs.unlinkSync(target)
    },
  }
}

test('THE BOOT PASS ONLY LOOKS: it reports the failure and writes nothing into the profile', () => {
  const root = tempDir('detect-only');
  const stateDir = path.join(root, 'state');
  const profileDir = makeProfile(root)
  // A backup that WOULD allow a restore: the proof is that it is not used.
  const backupsDir = path.join(root, 'backups')
  makeBackup(root)
  const { logsDir } = writeStartupLog(root)

  const before = digestTree(profileDir)
  const writes = []
  const outcome = detectPluginRecovery({
    stateDir,
    backupsDir,
    logsDir,
    bootAt: Date.parse('2026-11-01T01:00:00.000Z'),
    now: Date.parse('2026-11-01T01:00:05.000Z'),
    fs: spyingFs(writes),
  })

  assert.equal(outcome.ran, true);
  assert.equal(outcome.found, true);
  assert.equal(outcome.changed, false, 'a boot pass never changes a file');
  assert.equal(outcome.restartRequested, false, 'a boot pass never asks for a restart');
  // TWO entries by design: the aggregate "1 entry did not activate" warning names
  // no plugin (it can never be restored, so `mergeFailuresByPlugin` keeps it on
  // its own) and the named import error is the one the popup acts on.
  assert.equal(outcome.failures.length, 2);
  const named = outcome.failures.filter((entry) => entry.plugin === 'copied-plugin');
  assert.equal(named.length, 1);
  assert.match(named[0].error, /Error: boom/);
  assert.equal(outcome.backupKind, KIND_KNOWN_GOOD, 'the report still says which backup exists');
  assert.equal(outcome.restoredAt, 1_761_000_000_000);

  // (1) NOTHING WAS WRITTEN ANYWHERE BUT THE PLUGIN'S OWN STATE DIRECTORY.
  const outside = writes.filter((entry) => !entry.target.startsWith(stateDir))
  assert.deepEqual(outside, [], 'the only writer is the report under stateDir');
  assert.equal(writes.some((entry) => entry.op === 'rename'), false, 'no evidence rename');
  assert.equal(writes.some((entry) => entry.op === 'copy'), false, 'no copy');
  assert.equal(writes.some((entry) => entry.op === 'remove'), false, 'no delete');
  assert.equal(writes.some((entry) => entry.op === 'unlink'), false, 'no unlink');

  // (2) THE PROFILE IS BYTE-IDENTICAL: the broken copy is still the broken copy.
  assert.deepEqual(digestTree(profileDir), before, 'every file in the profile is unchanged');
  const nodeModules = fs.readdirSync(path.join(profileDir, 'node_modules'));
  assert.deepEqual(nodeModules, ['copied-plugin'], 'no <plugin>.broken-<ts> evidence directory');

  // (3) THE REPORT IS THE DELIVERABLE, AND IT CLAIMS NOTHING WAS DONE.
  const report = readRecoveryReport(stateDir);
  assert.ok(report, 'last-plugin-recovery.json is written');
  assert.equal(report.actions.length, 0, 'nothing was done, so no action is claimed');
  assert.equal(report.changed, false);
  assert.equal(report.restartRequested, false);
  const reported = report.failures.filter((entry) => entry.plugin === 'copied-plugin');
  assert.equal(reported.length, 1, 'the named plugin is in the report');
  assert.match(reported[0].error, /Error: boom/);

  // (4) THE AUTOMATIC-RESTORE BOOKKEEPING IS NOT TOUCHED EITHER: it has no
  // reader any more, and writing it would be a boot pass changing a file for
  // a decision it no longer takes.
  assert.equal(fs.existsSync(path.join(stateDir, 'plugin-recovery.json')), false);
});

test('a clean previous boot writes no report at all', () => {
  const root = tempDir('detect-clean');
  const stateDir = path.join(root, 'state');
  const logsDir = path.join(root, 'logs');
  const logPath = path.join(logsDir, 'startup-2026-11-01T00-00-00.000Z-bbbb.log');
  writeFile(logPath, '2026-11-01T00:00:01.000Z dsh web: up\n');
  // Same pin as every other boot-pass fixture: the mtime must not be "now".
  pinLogTime(logPath);
  const outcome = detectPluginRecovery({
    stateDir,
    backupsDir: '',
    logsDir,
    bootAt: BOOT_AT,
    now: Date.parse('2026-11-01T01:00:05.000Z'),
  });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.found, false);
  assert.equal(outcome.report, null);
  assert.equal(fs.existsSync(path.join(stateDir, RECOVERY_REPORT_NAME)), false);
});

test('the boot pass keeps the sinceMs guard: a line older than the log is not new news', () => {
  const root = tempDir('detect-since');
  const stateDir = path.join(root, 'state');
  const logsDir = path.join(root, 'logs');
  // The failure is stamped BEFORE the boot the log belongs to. `sinceMs` comes
  // from the timestamp in the log's own FILE NAME, which is the guard against
  // re-reading an incident forever.
  const logPath = path.join(logsDir, 'startup-2026-11-01T03-00-00.000Z-cccc.log');
  writeFile(logPath, '2026-11-01T02:00:00.000Z - copied-plugin: failed to import: Error: old\n');
  // Pinned to the moment the NAME describes — not to "now", which would have
  // made this test green only until the calendar passed 04:00Z.
  pinLogTime(logPath, Date.parse('2026-11-01T03:00:00.000Z'));
  const outcome = detectPluginRecovery({
    stateDir,
    backupsDir: '',
    logsDir,
    bootAt: Date.parse('2026-11-01T04:00:00.000Z'),
    now: Date.parse('2026-11-01T04:00:05.000Z'),
  });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.found, false, 'the old line is not a new incident');
  assert.deepEqual(outcome.failures, []);
});

// ---------------------------------------------------------------------------
// ON DEMAND: restore exactly ONE plugin (the popup's button).
// ---------------------------------------------------------------------------

test('restoreOnePlugin puts back exactly ONE plugin and leaves the rest untouched', () => {
  const root = tempDir('restore-one');
  const stateDir = path.join(root, 'state');
  const backupDir = makeBackup(root, { copied: ['plugin-a', 'plugin-b'], linked: [] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = path.join(root, 'profile');
  // Two plugins in the profile; only plugin-a is broken.
  writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'plugin-a': 'file:./a', 'plugin-b': 'file:./b' } }, null, 2));
  writeFile(path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: plugin-a\n');
  writeFile(path.join(profileDir, 'node_modules', 'plugin-a', 'index.js'), 'export const broken = true;\n');
  writeFile(path.join(profileDir, 'node_modules', 'plugin-b', 'index.js'), 'export const fine = true;\n');

  // The bytes that must NOT move: the other plugin and the profile's own config.
  const pinned = {
    'package.json': fs.readFileSync(path.join(profileDir, 'package.json')),
    'cordis.patch.yml': fs.readFileSync(path.join(profileDir, 'cordis.patch.yml')),
    'node_modules/plugin-b/index.js': fs.readFileSync(path.join(profileDir, 'node_modules', 'plugin-b', 'index.js')),
  };

  const result = restoreOnePlugin({
    stateDir,
    profileDir,
    backupsDir,
    plugin: 'plugin-a',
    now: 1_761_000_900_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plugin, 'plugin-a');
  assert.equal(result.mode, RECOVERY_MODES.OVERWRITE);
  assert.equal(result.changed, true);
  assert.equal(result.needsRestart, true);
  assert.equal(result.backupKind, KIND_KNOWN_GOOD);
  assert.equal(result.restoredAt, 1_761_000_000_000);
  assert.equal(result.restoredFrom, path.join(backupDir, 'node_modules', 'plugin-a'));

  // The plugin really was put back, and the broken one is kept as evidence.
  assert.equal(
    fs.readFileSync(path.join(profileDir, 'node_modules', 'plugin-a', 'index.js'), 'utf8'),
    'export const good = true;\n',
  );
  const names = fs.readdirSync(path.join(profileDir, 'node_modules'));
  assert.equal(names.filter((name) => name.startsWith('plugin-a.broken-')).length, 1);
  assert.match(result.evidence.renamedTo, /plugin-a\.broken-\d{8}T\d{6}$/);

  // ISOLATION: everything else is the very same bytes.
  for (const [rel, expected] of Object.entries(pinned)) {
    assert.deepEqual(fs.readFileSync(path.join(profileDir, rel)), expected, rel + ' is byte-identical');
  }
});

test('restoreOnePlugin replaces a link installation with the backup contents', () => {
  const root = tempDir('restore-link');
  const stateDir = path.join(root, 'state');
  makeBackup(root, { copied: [], linked: ['linked-plugin'] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = path.join(root, 'profile');
  writeFile(path.join(profileDir, 'node_modules', 'linked-plugin', 'index.js'), 'export const broken = true;\n');
  const result = restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: 'linked-plugin', now: 1_761_000_900_000 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, RECOVERY_MODES.REPLACE_LINK);
  assert.equal(result.changed, true);
  assert.equal(
    fs.readFileSync(path.join(profileDir, 'node_modules', 'linked-plugin', 'index.js'), 'utf8'),
    'export const linked = true;\n',
  );
});

test('restoreOnePlugin is idempotent: pressing twice changes nothing the second time', () => {
  const root = tempDir('restore-idempotent');
  const stateDir = path.join(root, 'state');
  makeBackup(root, { linked: [] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = makeProfile(root);

  const first = restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: 'copied-plugin', now: 1_761_000_900_000 });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);

  const afterFirst = digestTree(profileDir);
  const second = restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: 'copied-plugin', now: 1_761_001_000_000 });

  assert.equal(second.ok, true);
  assert.equal(second.mode, RECOVERY_MODES.ALREADY_CONSISTENT);
  assert.equal(second.changed, false);
  assert.equal(second.needsRestart, false, 'nothing moved, so nothing needs a restart');
  assert.deepEqual(digestTree(profileDir), afterFirst, 'not one byte moved');
  const evidence = fs.readdirSync(path.join(profileDir, 'node_modules')).filter((name) => name.includes('.broken-'));
  assert.equal(evidence.length, 1, 'no second evidence directory was created');
});

test('restoreOnePlugin answers ok:false with a reason when there is no backup for that plugin', () => {
  const root = tempDir('restore-nobackup');
  const stateDir = path.join(root, 'state');
  makeBackup(root, { copied: ['copied-plugin'], linked: [] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = makeProfile(root, { name: 'ghost-plugin' });
  const before = digestTree(profileDir);
  const result = restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: 'ghost-plugin' });
  assert.equal(result.ok, false);
  assert.equal(result.mode, RECOVERY_MODES.NO_BACKUP);
  assert.match(result.reason, /neither a copy nor the contents/);
  assert.equal(result.needsRestart, false);
  assert.deepEqual(digestTree(profileDir), before, 'nothing was touched');
});

test('restoreOnePlugin refuses an empty plugin name and a missing profile', () => {
  const root = tempDir('restore-guards');
  const stateDir = path.join(root, 'state');
  makeBackup(root, { linked: [] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = path.join(root, 'profile');
  const blank = restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: '   ' });
  assert.equal(blank.ok, false);
  assert.match(blank.reason, /no plugin name/);
  assert.match(
    restoreOnePlugin({ stateDir, profileDir: '', backupsDir, plugin: 'copied-plugin' }).reason,
    /no profile directory/,
  );
  // A real name with no backup for it is a different answer, not a guard.
  assert.match(
    restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: ' something-else ' }).reason,
    /neither a copy nor the contents/,
  );
});

test('plugin-restore-history.json keeps the newest 20 entries with every field', () => {
  const root = tempDir('restore-history');
  const stateDir = path.join(root, 'state');
  makeBackup(root, { linked: [] });
  const backupsDir = path.join(root, 'backups');
  const profileDir = makeProfile(root);

  for (let i = 0; i < 24; i += 1) {
    restoreOnePlugin({ stateDir, profileDir, backupsDir, plugin: 'copied-plugin', now: 1_761_000_000_000 + i * 1000 });
  }

  const history = readRestoreHistory(stateDir);
  assert.equal(history.entries.length, RESTORE_HISTORY_LIMIT, 'capped at 20');
  assert.equal(RESTORE_HISTORY_LIMIT, 20);
  // Newest first: the last call is at the top.
  assert.equal(history.entries[0].at, 1_761_000_000_000 + 23 * 1000);
  assert.equal(history.entries[19].at, 1_761_000_000_000 + 4 * 1000);
  for (const key of ['ok', 'plugin', 'mode', 'restoredFrom', 'restoredAt', 'backupKind', 'needsRestart', 'changed', 'at', 'atIso', 'reason']) {
    assert.ok(Object.prototype.hasOwnProperty.call(history.entries[0], key), 'entry carries ' + key);
  }
  // The newest one is the idempotent answer: the second press of the same
  // button in real life.
  assert.equal(history.entries[0].mode, RECOVERY_MODES.ALREADY_CONSISTENT);
});

test('summarizeRestoreHistory hands health the newest entry only', () => {
  const summary = summarizeRestoreHistory({
    entries: [
      { at: 1_761_000_900_000, atIso: '2026-11-01T09:35:00.000Z', plugin: 'p', mode: 'overwrite', ok: true, changed: true, needsRestart: true, backupKind: 'known-good', restoredAt: 1_761_000_000_000, reason: 'x', extra: 'dropped' },
      { at: 1, plugin: 'older' },
    ],
  });
  assert.equal(summary.plugin, 'p');
  assert.equal(summary.mode, 'overwrite');
  assert.equal(summary.needsRestart, true);
  assert.equal(summary.backupKind, 'known-good');
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'extra'), false, 'the summary stays small');
  assert.equal(summarizeRestoreHistory({ entries: [] }), null);
  assert.equal(summarizeRestoreHistory(null), null);
});

test('a corrupt history file never breaks the popup', () => {
  const root = tempDir('restore-history-broken');
  const stateDir = path.join(root, 'state');
  writeFile(path.join(stateDir, RESTORE_HISTORY_NAME), 'not json at all');
  assert.deepEqual(readRestoreHistory(stateDir).entries, []);
});

// ---------------------------------------------------------------------------
// THE BOOT BLOCK ITSELF — pinned at the source level so a later edit cannot
// quietly put the automatic restore (or a boot-time restart) back.
// ---------------------------------------------------------------------------

test('the boot block of index.js calls neither the automatic restore nor a restart', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (runtime.isNewBoot) {');
  const end = source.indexOf("runtime.disarmWatchdog('boot')");
  assert.ok(start > 0 && end > start, 'the boot block is findable');
  // Strip comments: the block EXPLAINS what it does not do, and prose must not
  // be mistaken for a call.
  const block = source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(block, /detectPluginRecovery\(/, 'the boot pass looks');
  assert.equal(/applyPluginRecovery\s*\(/.test(block), false, 'applyPluginRecovery is never called at boot');
  assert.equal(/requestRestart\s*\(/.test(block), false, 'a boot never asks for a restart');
  assert.equal(/runPluginRecovery\s*\(/.test(block), false, 'the automatic pass is not called at boot');
});

// ---------------------------------------------------------------------------
// THE SENTRY STANDBY IS GONE (user decision, 2026-11-01): "off means off".
// ---------------------------------------------------------------------------

test('the sentry standby is entirely gone and nothing imports it', () => {
  const pluginRoot = new URL('../', import.meta.url);
  for (const rel of ['lib/sentry.js', 'lib/sentry-install.js', 'supervisor/sentry.js', 'docs/sentry.md', 'test/sentry.test.mjs', 'test/sentry-install.test.mjs']) {
    assert.equal(fs.existsSync(new URL(rel, pluginRoot)), false, rel + ' is deleted');
  }
  // No source file imports a module named sentry (the word may still appear in
  // prose elsewhere; an IMPORT is what would keep it alive).
  const sources = ['index.js', 'client.js', 'lib/backup.js', 'lib/watchdog.js', 'lib/plugin-recover.js', 'lib/restart.js', 'supervisor/supervisor.js'];
  for (const rel of sources) {
    const text = fs.readFileSync(new URL(rel, pluginRoot), 'utf8');
    assert.equal(/from\s+['"][^'"]*sentry[^'"]*['"]/.test(text), false, rel + ' does not import sentry');
    assert.equal(/require\(['"][^'"]*sentry/.test(text), false, rel + ' does not require sentry');
  }
});
