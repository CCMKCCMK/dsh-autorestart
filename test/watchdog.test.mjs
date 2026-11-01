/**
 * THE WATCHDOG FLOW — the same for every tier.
 *
 * The rules that matter:
 *
 *   - a host that comes up late is NOT a dead host (ask again);
 *   - a host that is alive is never rolled back under (no double start);
 *   - exactly ONE restore at a time (the lock);
 *   - at most ONE restore and ONE start (then it stops and says 'failed').
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backoffMsFor,
  buildPending,
  clearPending,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ATTEMPTS_CEILING,
  maxAttemptsOf,
  readJsonState,
  readPending,
  readPendingState,
  readReport,
  readReady,
  readyIsCurrent,
  readyPath,
  reportPath,
  restoreFromSnapshot,
  runWatchdogFlow,
  writePending,
  writeReady,
  writeReport,
} from '../lib/watchdog.js';
// The REAL arm-path marker writer of index.js — the function `armWatchdog`
// calls before it registers anything. Imported (not copied) so the arm test
// exercises the code that runs in production.
import { writeRestartPending } from '../index.js';

/** Every directory this file created, so a FAILING test cannot leak one. */
const createdDirs = [];

/**
 * A directory of its own for every test.
 *
 * It is REGISTERED here as well as removed at the end of the test. The residue
 * check ("a run leaves nothing behind") failed on exactly this before: a test
 * that threw before its `fs.rmSync` line left its state directory in %TEMP%
 * for ever, and nothing said so.
 */
function tempDir(name) {
  const dir = path.join(os.tmpdir(), 'dsh-watchdog-test-' + name + '-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory that cannot be removed is not a test failure.
    }
  }
});

/**
 * The dependencies of a run, with everything stubbed out.
 *
 * @param {object} options
 */
function deps(options = {}) {
  const state = { restores: 0, relaunches: 0, released: 0, removed: 0 };
  const clock = { now: options.now ?? 0 };
  const base = {
    state,
    clock,
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    pollMs: 1000,
    readReady: () => options.ready === true,
    isWithdrawn: () => options.withdrawn === true,
    probeAlive: async () => options.alive === true,
    runRestore: () => { state.restores += 1; return options.restore ?? { ok: true }; },
    runRelaunch: () => { state.relaunches += 1; return options.relaunch ?? { ok: true }; },
    acquireLock: () => options.locked !== true,
    releaseLock: () => { state.released += 1; },
    removeSchedule: () => { state.removed += 1; },
    writeReport: () => {},
  };
  return base;
}

test('a host that comes up means: no restore at all', async () => {
  const dir = tempDir('not-needed');
  const d = deps({ ready: true });
  const pending = buildPending({ tier: 'systemd-run', tierReason: 'because', timeoutMs: 5000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'not-needed');
  assert.equal(d.state.restores, 0);
  assert.equal(d.state.relaunches, 0);
  assert.equal(report.tier, 'systemd-run', 'the report says which tier was used');
  assert.equal(report.tierReason, 'because', 'and why');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that comes up late is asked again, and not restored', async () => {
  const dir = tempDir('late');
  const d = deps({});
  // The ready marker appears only DURING the second look (after the first
  // wait ran out): a slow host is not a dead host.
  d.readReady = () => d.clock.now >= 6000;
  const pending = buildPending({ timeoutMs: 5000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'not-needed');
  assert.equal(report.rechecked, true, 'it asked again');
  assert.equal(d.state.restores, 0, 'a slow host is not a dead host');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that never comes up is restored and started again', async () => {
  const dir = tempDir('recovered');
  const d = deps({ alive: false });
  let readyAfter = false;
  d.runRelaunch = () => { d.state.relaunches += 1; readyAfter = true; return { ok: true }; };
  d.readReady = () => readyAfter;
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 5000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'recovered');
  assert.equal(report.restored, true);
  assert.equal(report.relaunched, true);
  assert.equal(d.state.restores, 1);
  assert.equal(d.state.relaunches, 1);
  assert.equal(d.state.released, 1, 'the lock is given back');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that stays down is restored ONCE and started at most maxAttempts times', async () => {
  const dir = tempDir('failed');
  const d = deps({ alive: false });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 3000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'failed');
  assert.equal(d.state.restores, 1, 'exactly one restore');
  // The flow used to stop after ONE start. One start is not enough (a host
  // died 14s after its start on 2026-10-30), so it tries again — but a NUMBER
  // of times, never "as often as it likes".
  assert.equal(report.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'the marker says how often it may try');
  assert.equal(report.attempts, DEFAULT_MAX_ATTEMPTS, 'it stopped at the ceiling instead of looping');
  assert.equal(d.state.relaunches, DEFAULT_MAX_ATTEMPTS, 'one start per attempt');
  assert.ok(report.error, 'the report says why');
  assert.match(String(report.error), /attempt/, 'the report names the number of attempts');
  // The message must say that NOTHING ELSE will pick it up (the sentry standby
  // was deleted on 2026-11-01, so it must not promise a rescuer that no longer
  // exists) — and it must not name that removed component any more.
  assert.match(String(report.error), /no further rollback will be attempted/, 'and says that this was the last automatic step');
  assert.doesNotMatch(String(report.error), /sentry/i, 'it points at nothing that no longer exists');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an OLD pending marker (no maxAttempts) still tries more than once', async () => {
  const dir = tempDir('old-marker');
  const d = deps({ alive: false });
  // A marker written by an older version has no maxAttempts field at all.
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000 });
  delete pending.maxAttempts;
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'an old marker is read as the default, never as one');
  assert.equal(d.state.relaunches, DEFAULT_MAX_ATTEMPTS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pass is bounded: a nonsense maxAttempts cannot make the watchdog endless', async () => {
  assert.equal(maxAttemptsOf({ maxAttempts: 0 }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsOf({ maxAttempts: -5 }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsOf({ maxAttempts: 'many' }), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsOf({}), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsOf(null), DEFAULT_MAX_ATTEMPTS);
  assert.equal(maxAttemptsOf({ maxAttempts: 2 }), 2, 'the plugin decides how often');
  assert.equal(maxAttemptsOf({ maxAttempts: 1000 }), MAX_ATTEMPTS_CEILING, 'and the ceiling holds');
  // The waits between two attempts grow, and the last one repeats.
  assert.equal(backoffMsFor(1), DEFAULT_BACKOFF_MS[0]);
  assert.equal(backoffMsFor(2), DEFAULT_BACKOFF_MS[1]);
  assert.equal(backoffMsFor(9), DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1]);
});

test('the stale cookies are cleared BEFORE the host is started again', async () => {
  const dir = tempDir('cookie-order');
  const d = deps({ alive: false });
  const order = [];
  d.clearCookies = async () => {
    order.push('clear');
    return { ok: true, removed: 7, error: null };
  };
  d.runRestore = () => { order.push('restore'); d.state.restores += 1; return { ok: true }; };
  d.runRelaunch = () => { order.push('relaunch'); d.state.relaunches += 1; return { ok: true }; };
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 1 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.deepEqual(order, ['restore', 'clear', 'relaunch'], 'restore, then the cleanup, then the start');
  assert.deepEqual(report.cookieClear, { ok: true, removed: 7, error: null }, 'what the cleanup did is in the report');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cookie cleanup that throws does NOT block the start (and is reported)', async () => {
  const dir = tempDir('cookie-broken');
  const d = deps({ alive: false });
  d.clearCookies = async () => {
    throw new Error('EBUSY: the cookie jar is locked');
  };
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 1 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(d.state.relaunches, 1, 'the host is started even when the cleanup failed');
  assert.equal(d.state.restores, 1);
  assert.equal(report.relaunched, true);
  assert.equal(report.cookieClear.ok, false, 'the failure is in the report, not swallowed');
  assert.match(String(report.cookieClear.error), /EBUSY/);
  assert.match(String(report.attemptLog[0].error), /cookie/i, 'the attempt log says it too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every attempt asks again: a host that came up is not started a second time', async () => {
  const dir = tempDir('attempts-ready');
  const d = deps({ alive: false });
  let launches = 0;
  let markerAppeared = false;
  d.readReady = () => markerAppeared;
  d.clearCookies = async () => ({ ok: true, removed: 0, error: null });
  d.askHealth = async () => 'unhealthy';
  d.runRelaunch = () => { launches += 1; d.state.relaunches += 1; return { ok: true }; };
  // The host that attempt 1 started finishes its boot WHILE the watchdog waits
  // between two attempts (a backoff wait, not a poll).
  d.sleep = async (ms) => {
    d.clock.now += ms;
    if (launches > 0 && ms >= DEFAULT_BACKOFF_MS[0]) markerAppeared = true;
  };
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 3 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  // Attempt 1 started the host; the marker appeared before attempt 2 could.
  assert.equal(report.result, 'not-needed');
  assert.equal(report.ready, true);
  assert.equal(d.state.relaunches, 1, 'a host that came up is NOT started again');
  assert.equal(report.attempts, 1, 'the second attempt was never made');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live instance makes the later attempts stand down instead of starting', async () => {
  const dir = tempDir('attempts-alive');
  const d = deps({ alive: false });
  let launches = 0;
  d.runRelaunch = () => { launches += 1; d.state.relaunches += 1; return { ok: true }; };
  // After the first start something IS alive: no second start.
  d.probeAlive = async () => launches > 0;
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 3 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'abandoned');
  assert.equal(launches, 1, 'no second instance next to a live one');
  assert.match(String(report.error), /alive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a start that cannot be issued is marked as such (stage relaunch)', async () => {
  const dir = tempDir('relaunch-failed');
  const d = deps({ alive: false });
  d.runRelaunch = () => ({ ok: false, error: 'the executable is gone' });
  const pending = buildPending({ timeoutMs: 1000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 3 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'failed');
  assert.equal(report.stage, 'relaunch', 'the report tells "could not start" from "could not rescue"');
  assert.match(String(report.error), /gone/);
  assert.equal(d.state.relaunches, 0, 'nothing was started');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an exception inside the flow STILL leaves a report on the disk', async () => {
  const dir = tempDir('throwing');
  const d = deps({ alive: false });
  d.writeReport = (report) => writeReport(dir, report);
  d.readReady = () => { throw new Error('EIO: the state directory is gone'); };
  const pending = buildPending({ timeoutMs: 0, recheckMs: 0, readyTimeoutMs: 0 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'failed');
  assert.match(String(report.error), /EIO/);
  const onDisk = readReport(dir);
  assert.ok(onDisk, 'the report is written from the finally, whatever threw');
  assert.equal(onDisk.result, 'failed');
  assert.match(String(onDisk.error), /EIO/);
  assert.equal(onDisk.stage, 'flow');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live instance is never rolled back under', async () => {
  const dir = tempDir('alive');
  const d = deps({ alive: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'abandoned');
  assert.equal(d.state.restores, 0, 'no double start');
  assert.match(String(report.error), /alive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rollback that is already running wins: the watchdog stands down', async () => {
  const dir = tempDir('locked');
  const d = deps({ alive: false, locked: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'abandoned');
  assert.equal(d.state.restores, 0);
  assert.match(String(report.error), /another rollback/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a plugin that decided on its own makes the watchdog stand down', async () => {
  const dir = tempDir('decided');
  const d = deps({ withdrawn: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'decided');
  assert.equal(d.state.restores, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the scheduling item and the pending marker go, the report stays', async () => {
  const dir = tempDir('cleanup');
  writePending(dir, buildPending({ tier: 'scheduled-task' }));
  const d = deps({ ready: true });
  d.writeReport = (report) => writeReport(dir, report);
  const report = await runWatchdogFlow({ pending: buildPending({}), stateDir: dir, deps: d });
  assert.equal(d.state.removed, 1, 'the scheduling item is removed');
  assert.equal(readPending(dir), null, 'the pending marker is gone');
  assert.ok(fs.existsSync(reportPath(dir)), 'the report is kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the markers live where they belong', () => {
  const dir = tempDir('markers');
  writePending(dir, buildPending({ tier: 'detached-process' }));
  assert.equal(readPending(dir).tier, 'detached-process');
  writeReady(dir, { bootId: 'b1', port: 1234 });
  assert.equal(readReady(dir).port, 1234);
  clearPending(dir);
  assert.equal(readPending(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A MARKER THAT CANNOT BE READ IS NOT A MISSING MARKER (review finding F4).
//
// The old reader answered `null` for both "there is no file" and "the file
// cannot be parsed". A `watchdog-pending.json` written by PowerShell (UTF-8
// WITH a byte order mark) therefore read as "nothing to watch": the process
// removed its scheduling item and exited 0, looking like a run that had done
// its job while nothing had been rescued. That is the shape of the 2026-10-30
// incident, so the two answers are separated here.
// ---------------------------------------------------------------------------

test('readJsonState: a byte order mark does not stop the parse', () => {
  const dir = tempDir('bom-ok');
  const file = path.join(dir, 'watchdog-pending.json');
  // Exactly what PowerShell 5.1 writes: BOM + valid JSON.
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ version: 1, tier: 'scheduled-task' }), 'utf8');
  const read = readJsonState(file);
  assert.equal(read.state, 'ok', 'a BOM-prefixed marker must be readable');
  assert.equal(read.value.tier, 'scheduled-task');
  assert.equal(read.error, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readPendingState: a BOM-prefixed pending marker IS a pending marker', () => {
  const dir = tempDir('bom-pending');
  fs.writeFileSync(
    path.join(dir, 'watchdog-pending.json'),
    '\uFEFF' + JSON.stringify(buildPending({ tier: 'scheduled-task', taskName: 'dsh-autorestart-watchdog' })),
    'utf8',
  );
  const read = readPendingState(dir);
  assert.equal(read.state, 'ok');
  assert.ok(read.pending, 'the BOM-prefixed marker is treated as pending work, not as absent');
  assert.equal(read.pending.taskName, 'dsh-autorestart-watchdog');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonState: "cannot be parsed" and "is not there" are DIFFERENT answers', () => {
  const dir = tempDir('corrupt-vs-missing');
  const corrupt = path.join(dir, 'watchdog-pending.json');
  fs.writeFileSync(corrupt, '{ this is not json', 'utf8');
  const broken = readJsonState(corrupt);
  assert.equal(broken.state, 'corrupt', 'a file that exists but cannot be parsed is corrupt');
  assert.match(String(broken.error), /cannot be parsed/);
  assert.equal(broken.value, null);

  const missingFile = path.join(dir, 'not-there.json');
  const missing = readJsonState(missingFile);
  assert.equal(missing.state, 'missing', 'a file that is not there is missing');
  assert.equal(missing.error, null, 'missing is not an error: it is the normal "nothing to watch"');
  assert.equal(missing.value, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readPendingState: a corrupt marker is reported as corrupt, not as missing', () => {
  const dir = tempDir('corrupt-pending');
  fs.writeFileSync(path.join(dir, 'watchdog-pending.json'), '{"tier": "scheduled-task"', 'utf8');
  const read = readPendingState(dir);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.pending, null);
  assert.match(String(read.error), /cannot be parsed/);
  // And the old accessor keeps its contract for the plugin side (index.js).
  assert.equal(readPending(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// THE LINKED PLUGINS IN THE RESCUE PATH (user decision, 2026-10-30).
//
// A `link:` plugin is a REPARSE POINT: copying node_modules back puts the link
// back and nothing behind it. The plugin that does the rescuing is installed
// that way, so a restore that cannot put it back is a restore that never runs.
// The decision is the one from lib/backup.js (decideLinkRestore), and these two
// tests are the two branches that matter at 3 a.m.: target there -> keep the
// link; target gone -> replace it with what the backup holds.
// ---------------------------------------------------------------------------

/**
 * A snapshot with one linked plugin, plus a profile that has the link.
 *
 * @param {string} name test name
 * @param {{ targetExists?: boolean }} [options]
 */
function linkRestoreFixture(name, options = {}) {
  const base = tempDir('link-' + name);
  const snapshot = path.join(base, 'snapshot');
  const profile = path.join(base, 'profile');
  const dev = path.join(base, 'dev', 'dsh-autorestart');
  const targetExists = options.targetExists !== false;

  // The backup: the tree copy (with the LINK in it) and the contents.
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, 'node_modules-link', 'dsh-autorestart'), { recursive: true });
  fs.writeFileSync(
    path.join(snapshot, 'node_modules-link', 'dsh-autorestart', 'package.json'),
    '{"name":"dsh-autorestart","version":"0.8.6"}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(snapshot, 'manifest.json'),
    JSON.stringify({
      stamp: '20261030-000000',
      links: [{ name: 'dsh-autorestart', target: dev, kind: 'junction', exists: targetExists }],
    }, null, 2),
    'utf8',
  );
  if (targetExists) {
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'package.json'), '{"name":"dsh-autorestart","dev":true}\n', 'utf8');
  }
  fs.symlinkSync(dev, path.join(profile, 'node_modules', 'dsh-autorestart'), 'junction');
  return { base, snapshot, profile, dev };
}

test('restoreFromSnapshot: a link whose target is still there is KEPT', (t) => {
  const { base, snapshot, profile } = linkRestoreFixture('kept');
  const result = restoreFromSnapshot({ snapshotDir: snapshot, profileDir: profile });
  assert.equal(result.links.length, 1, 'one line per linked plugin, never a silent skip');
  assert.equal(result.links[0].name, 'dsh-autorestart');
  assert.equal(result.links[0].action, 'kept');
  const live = path.join(profile, 'node_modules', 'dsh-autorestart');
  assert.equal(fs.lstatSync(live).isSymbolicLink(), true, 'the development link is untouched');
  fs.rmSync(base, { recursive: true, force: true });
});

test('restoreFromSnapshot: a link whose target is GONE is replaced by the backup contents', (t) => {
  const { base, snapshot, profile } = linkRestoreFixture('replaced', { targetExists: false });
  const result = restoreFromSnapshot({ snapshotDir: snapshot, profileDir: profile });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].action, 'replaced');
  assert.equal(result.links[0].replaced, true);
  const live = path.join(profile, 'node_modules', 'dsh-autorestart');
  assert.equal(fs.lstatSync(live).isSymbolicLink(), false, 'the dead link is gone');
  const packageJson = path.join(live, 'package.json');
  assert.ok(fs.existsSync(packageJson), 'the contents from the backup are there now');
  assert.match(fs.readFileSync(packageJson, 'utf8'), /"version":"0\.8\.6"/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('restoreFromSnapshot: forced, or a second attempt, replaces a healthy link too', (t) => {
  const forced = linkRestoreFixture('forced');
  const forcedResult = restoreFromSnapshot({
    snapshotDir: forced.snapshot,
    profileDir: forced.profile,
    forceLinkPlugins: true,
  });
  assert.equal(forcedResult.links[0].action, 'replaced');
  fs.rmSync(forced.base, { recursive: true, force: true });

  const second = linkRestoreFixture('attempt2');
  const secondResult = restoreFromSnapshot({
    snapshotDir: second.snapshot,
    profileDir: second.profile,
    attempts: 2,
  });
  assert.equal(secondResult.links[0].action, 'replaced', 'the link had its chance on the first attempt');
  fs.rmSync(second.base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A READY MARKER IS THE RECEIPT OF ONE RESTART, NOT A FACT ABOUT THE MACHINE
// (blocker reproduced on the real machine, 2026-11-01).
//
// What the hosted web instance on port 5601 had on disk:
//
//   - `watchdog-pending.json` (this restart's ticket)     09:57:10Z
//   - `watchdog-ready.json`  (the PREVIOUS boot's receipt) 09:54:21Z
//     {"at":"...09:54:21.208Z","bootId":"c344d6a9-...","port":5601}
//   - 2m49s apart, the host never came up (`ss -ltn`: nothing on 5601 for
//     more than two minutes while `dsh web` started and died again and again)
//   - the watchdog reported
//     {"result":"not-needed","ready":true,"restored":false,"relaunched":false,
//      "attempts":0} — it waited 0 ms and did nothing at all
//
// So the flow must (a) refuse a marker that provably belongs to an earlier
// restart, (b) still accept the marker THIS restart writes, and (c) the arm
// path must clear the earlier marker so the watchdog starts from a clean slate.
// ---------------------------------------------------------------------------

const PENDING_AT = Date.parse('2026-11-01T09:57:10.000Z');
const PREVIOUS_READY_AT = Date.parse('2026-11-01T09:54:21.000Z');
const PREVIOUS_BOOT_ID = 'c344d6a9-af4f-45a8-97ad-6705f65e6395';

/**
 * The dependencies of a run, stubbed out EXCEPT `readReady`: these tests are
 * about the marker on the disk, so the real reader is used and never overridden
 * (the `deps()` helper above answers `readReady` with a boolean, which is a
 * different question).
 *
 * @param {object} [overrides]
 */
function staleReadyDeps(overrides = {}) {
  const clock = { now: 0 };
  const state = { restores: 0, relaunches: 0, released: 0 };
  return {
    state,
    clock,
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    pollMs: 1000,
    isWithdrawn: () => false,
    probeAlive: async () => false,
    askHealth: async () => 'unhealthy',
    clearCookies: async () => ({ ok: true, removed: 0, error: null }),
    runRestore: () => { state.restores += 1; return { ok: true, error: null }; },
    runRelaunch: () => { state.relaunches += 1; return { ok: true, error: null }; },
    acquireLock: () => true,
    releaseLock: () => { state.released += 1; },
    removeSchedule: () => {},
    writeReport: () => {},
    ...overrides,
  };
}

test('the ready marker of the PREVIOUS boot does not count as "the host is up"', async () => {
  const dir = tempDir('stale-previous-boot');
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 1, now: PENDING_AT });
  writePending(dir, pending);
  // Exactly what the machine really had on disk during the incident.
  writeReady(dir, { at: PREVIOUS_READY_AT, bootId: PREVIOUS_BOOT_ID, port: 5601 });
  assert.ok(fs.existsSync(readyPath(dir)), 'the stale marker IS there — that is the whole point');

  const d = staleReadyDeps();
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.notEqual(report.result, 'not-needed', 'a 2m49s old marker must not be reported as "nothing to do"');
  assert.equal(report.ready, false, 'the host was not up');
  assert.equal(d.state.restores, 1, 'the snapshot was restored (the rescue actually ran)');
  assert.equal(d.state.relaunches, 1, 'and the host was started again');
  assert.equal(report.attempts, 1);
  assert.equal(report.result, 'failed', 'the host never came up: a failed rescue, not a quiet one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a refused ready marker is OBSERVABLE in the report (the 2026-11-01 run said nothing)', async () => {
  const dir = tempDir('stale-observable');
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 1, now: PENDING_AT });
  writePending(dir, pending);
  writeReady(dir, { at: PREVIOUS_READY_AT, bootId: PREVIOUS_BOOT_ID, port: 5601 });

  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: staleReadyDeps() });

  assert.equal(report.staleReadyIgnored, true, 'the report says a ready marker was read and refused');
  assert.equal(
    report.staleReadyAt,
    new Date(PREVIOUS_READY_AT).toISOString(),
    'and WHICH marker it was, so an operator can line it up with the earlier boot',
  );
  assert.equal(report.attemptLog[0].staleReadyIgnored, true, 'the attempt log carries it too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a marker that belongs to this restart is NOT called stale', async () => {
  const dir = tempDir('stale-current');
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 1000, maxAttempts: 1, now: PENDING_AT });
  writePending(dir, pending);
  writeReady(dir, { at: PENDING_AT + 5000, bootId: 'the-new-boot', port: 5601 });

  const d = staleReadyDeps();
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.equal(report.result, 'not-needed', 'the host really is up: nothing to do');
  assert.equal(report.ready, true);
  assert.equal(report.staleReadyIgnored, false, 'a current marker is not "ignored"');
  assert.equal(report.staleReadyAt, null);
  assert.equal(d.state.restores, 0, 'nothing was restored');
  assert.equal(d.state.relaunches, 0, 'no second instance was started');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the marker written AFTER the relaunch is accepted: the rescue reports "recovered"', async () => {
  const dir = tempDir('stale-recovered');
  // timeoutMs/readyTimeoutMs 0: the flow looks at the disk exactly once per
  // step, so the marker written by the relaunch is the ONLY thing that can make
  // the last look count.
  const pending = buildPending({ timeoutMs: 0, recheckMs: 0, readyTimeoutMs: 0, maxAttempts: 1, now: PENDING_AT });
  writePending(dir, pending);
  writeReady(dir, { at: PREVIOUS_READY_AT, bootId: PREVIOUS_BOOT_ID, port: 5601 });

  const d = staleReadyDeps();
  d.runRelaunch = () => {
    d.state.relaunches += 1;
    // The new host finishes its boot after being started again.
    writeReady(dir, { at: PENDING_AT + 20000, bootId: 'the-new-boot', port: 5601 });
    return { ok: true, error: null };
  };
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });

  assert.equal(report.result, 'recovered', 'the new marker was believed');
  assert.equal(report.ready, true);
  assert.equal(report.restored, true);
  assert.equal(report.relaunched, true);
  assert.equal(d.state.restores, 1);
  assert.equal(d.state.relaunches, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readyIsCurrent: the rule itself, including its deliberate leniencies', () => {
  // The blocker: earlier than the ticket -> refused.
  assert.equal(readyIsCurrent({ at: new Date(PREVIOUS_READY_AT).toISOString() }, PENDING_AT), false);
  // Written at the same millisecond -> this restart's (>=, not >).
  assert.equal(readyIsCurrent({ at: new Date(PENDING_AT).toISOString() }, PENDING_AT), true);
  assert.equal(readyIsCurrent({ at: new Date(PENDING_AT + 1).toISOString() }, PENDING_AT), true);
  // No marker at all -> not ready.
  assert.equal(readyIsCurrent(null, PENDING_AT), false);
  assert.equal(readyIsCurrent(undefined, PENDING_AT), false);
  // The pending marker carries no usable time: no lower bound, accepted as before.
  assert.equal(readyIsCurrent({ at: new Date(PREVIOUS_READY_AT).toISOString() }, null), true);
  // A marker without a usable `at` cannot be attributed to a restart at all
  // (a rescue script wrote it by hand): accepted, because the flow still asks
  // the health route before it touches anything.
  assert.equal(readyIsCurrent({ bootId: 'no-timestamp' }, PENDING_AT), true);
  // A dependency that answers with a bare boolean carries no timestamp either.
  assert.equal(readyIsCurrent(true, PENDING_AT), true);
});

test("arming writes this restart's marker and removes the earlier ready marker", () => {
  const dir = tempDir('stale-arm');
  // What the incident left behind: the receipt of the boot that is replaced.
  writeReady(dir, { at: PREVIOUS_READY_AT, bootId: PREVIOUS_BOOT_ID, port: 5601 });
  assert.ok(fs.existsSync(readyPath(dir)), 'the stale marker is there before the arm');

  const pending = buildPending({ tier: 'scheduled-task', taskName: 'dsh-autorestart-watchdog', now: PENDING_AT });
  writeRestartPending(dir, pending);

  assert.equal(fs.existsSync(readyPath(dir)), false, 'the ready marker of the earlier boot is GONE');
  assert.equal(readReady(dir), null, 'and it cannot be read as a marker any more');
  assert.equal(readPending(dir).at, pending.at, "while THIS restart's pending marker is on the disk");
  // What the watchdog now sees is "no marker yet": it waits.
  assert.equal(readyIsCurrent(readReady(dir), pending.at), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arming twice in a row is harmless (no marker is left behind the second time either)', () => {
  const dir = tempDir('stale-arm-twice');
  writeReady(dir, { at: PREVIOUS_READY_AT, bootId: PREVIOUS_BOOT_ID, port: 5601 });
  const first = buildPending({ tier: 'scheduled-task', now: PENDING_AT });
  writeRestartPending(dir, first);
  const second = buildPending({ tier: 'scheduled-task', now: PENDING_AT + 60000 });
  writeRestartPending(dir, second);
  assert.equal(fs.existsSync(readyPath(dir)), false);
  assert.equal(readPending(dir).at, second.at, 'the newest marker is the one on the disk');
  fs.rmSync(dir, { recursive: true, force: true });
});
