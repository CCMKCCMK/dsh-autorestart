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
  RECOVERY_MODES,
  RECOVERY_REPORT_NAME,
  recordAttempt,
  recoveryStamp,
  resetRecoveryCycle,
  sameAsBackup,
  summarizeRecoveryReport,
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
