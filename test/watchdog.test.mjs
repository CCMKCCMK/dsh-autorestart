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
  reportPath,
  runWatchdogFlow,
  writePending,
  writeReady,
  writeReport,
} from '../lib/watchdog.js';

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
  assert.match(String(report.error), /sentry/, 'and says what has to take over now');
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
