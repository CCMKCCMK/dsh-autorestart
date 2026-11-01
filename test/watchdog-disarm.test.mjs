/**
 * THE 0.8.2 INCIDENT, AS A TEST.
 *
 * What happened on a real machine (2026-10-29, 19:19–19:21):
 *
 *   A restart armed the watchdog (`watchdog-pending.json`, a one-off Windows
 *   scheduled task, the report said `armed`). The new host came up and
 *   answered its own health route with 200 — three times. The ready marker was
 *   NEVER written, the pending marker stayed, the scheduled task stayed
 *   `Ready`. Ninety seconds later the watchdog would have restored the
 *   snapshot of a perfectly healthy profile.
 *
 * The cause: the health route read the state directory through a variable that
 * only existed inside the runtime factory, so every request threw
 * `ReferenceError: stateDirOf is not defined` and the `catch {}` swallowed it.
 *
 * These tests are written so the OLD code fails them: the first one calls the
 * REAL health route of the plugin and demands the three side effects the
 * incident was missing (marker written, pending cleared, scheduling item
 * removed) plus a record that says it worked.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, PLUGIN_VERSION_FALLBACK } from '../index.js';
import { buildDiagnostics } from '../lib/diagnostics.js';

/** The copy a real arming would hand to the watchdog. */
const TARGET_DIR = '/tmp/dsh-ar-restore-target'
import {
  DEFAULT_DISARM_ATTEMPTS,
  disarmOnce,
  disarmWatchdog,
  markReady,
  readDisarmRecord,
  scheduleTargetOf,
} from '../lib/watchdog-disarm.js';
import {
  buildPending,
  pendingPath,
  readReady,
  readyPath,
  runWatchdogFlow,
  writePending,
  writeReady,
} from '../lib/watchdog.js';

/** Every directory this file created, so a FAILING test cannot leak one. */
const createdDirs = [];

/**
 * A temporary state directory.
 *
 * It is REGISTERED here, not only cleaned by the test itself: a test that
 * throws before its own cleanup used to leave its state directory in %TEMP%
 * for ever (the residue check of the drill found exactly that).
 */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-disarm-' + label + '-'));
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

/** The pending marker an armed watchdog leaves behind. */
function armedPending(dir, overrides = {}) {
  const pending = buildPending({ restoreTargetDir: TARGET_DIR,
    tier: 'scheduled-task',
    tierReason: 'a one-off Windows scheduled task',
    taskName: 'dsh-autorestart-watchdog',
    now: Date.now(),
    ...overrides,
  });
  writePending(dir, pending);
  return pending;
}

/**
 * The fake Cordis context the plugin's integration tests use: enough of the
 * service surface that `apply()` registers every route.
 */
function fakeContext(routes) {
  const services = {
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
      tapIndex: () => () => {},
    },
  };
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: (name) => services[name],
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

/** A response object good enough for the health route. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Wait for the background disarm to finish (it must never block the answer). */
async function settle(times = 12) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

test('the health route of a live host disarms the watchdog (the 0.8.1 incident)', async () => {
  const dir = tempDir('health-route');
  const stateFile = path.join(dir, 'state.json');
  const routes = [];
  apply(fakeContext(routes), { stateFile, enabled: true, recoveryDelayMs: 0 });

  // The watchdog was armed before the restart.
  armedPending(dir);
  assert.equal(fs.existsSync(pendingPath(dir)), true);

  const health = routes.find((route) => route.path === '/__dsh_autorestart/health');
  assert.ok(health, 'the plugin registers its health route');
  const response = fakeResponse();
  health.handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, response);

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  // The version that is really LOADED is reported (not a hard-coded fallback).
  assert.equal(body.version, PLUGIN_VERSION_FALLBACK);

  // (1) THE MARKER. This is what the incident was missing — and it must be on
  //     disk before the route answers, because it alone stops a rollback.
  const marker = readReady(dir);
  assert.ok(marker, 'the ready marker was written');
  assert.equal(marker.bootId, body.bootId);

  // (2) THE LEFTOVERS. The pending marker and the scheduling item go.
  await settle();
  assert.equal(fs.existsSync(pendingPath(dir)), false, 'the pending marker is gone');
  const record = readDisarmRecord(dir);
  assert.ok(record, 'the disarm left a record');
  assert.equal(record.ok, true);
  assert.equal(record.pending, false);
  assert.equal(record.ready, true);
  assert.equal(record.tier, 'scheduled-task');
  assert.deepEqual(record.errors, []);
});

test('the boot of a host disarms an armed watchdog without anybody asking', async () => {
  const dir = tempDir('boot');
  const stateFile = path.join(dir, 'state.json');
  const routes = [];
  // Armed BEFORE the host boots — the real order of a restart.
  armedPending(dir);
  apply(fakeContext(routes), { stateFile, enabled: true, recoveryDelayMs: 0 });

  await settle();
  assert.equal(fs.existsSync(readyPath(dir)), true, 'the boot wrote the ready marker');
  assert.equal(fs.existsSync(pendingPath(dir)), false, 'the boot cleared the pending marker');
  const record = readDisarmRecord(dir);
  assert.equal(record.ok, true);
  assert.equal(record.source, 'boot');
});

test('markReady writes the marker of this boot and keeps it', () => {
  const dir = tempDir('marker');
  const first = markReady({ stateDir: dir, bootId: 'boot-a', port: 51234 });
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  const written = readReady(dir);
  assert.equal(written.bootId, 'boot-a');
  assert.equal(written.port, 51234);
  // A second call for the SAME boot does not rewrite the file.
  const second = markReady({ stateDir: dir, bootId: 'boot-a', port: 51234 });
  assert.equal(second.ok, true);
  assert.equal(second.wrote, false);
  // A NEW boot overwrites the marker of the old one (it belongs to one restart).
  const third = markReady({ stateDir: dir, bootId: 'boot-b', port: null });
  assert.equal(third.wrote, true);
  assert.equal(readReady(dir).bootId, 'boot-b');
});

test('markReady reports a write it cannot do instead of pretending', () => {
  const answer = markReady({ stateDir: '', bootId: 'boot-a' });
  assert.equal(answer.ok, false);
  assert.match(answer.detail, /state directory/);
  const throwing = markReady({
    stateDir: '/not/a/directory/at/all',
    bootId: 'boot-a',
    write: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { name: 'Error' });
    },
  });
  assert.equal(throwing.ok, false);
  assert.equal(throwing.error.message, 'EACCES: permission denied');
});

test('the disarm retries a failing removal and then reports success', async () => {
  const dir = tempDir('retry');
  armedPending(dir);
  const calls = [];
  let deleted = false;
  const record = await disarmWatchdog({
    stateDir: dir,
    bootId: 'boot-a',
    attempts: DEFAULT_DISARM_ATTEMPTS,
    backoffMs: 0,
    sleep: async () => {},
    taskExists: () => deleted === false,
    removeItem: () => {
      calls.push('remove');
      // Fails twice (the task scheduler holds a lock), works on the third try.
      if (calls.length < 3) return { ok: false, error: 'the task could not be deleted' };
      deleted = true;
      return { ok: true, error: null };
    },
  });
  assert.equal(calls.length, 3, 'the removal was retried');
  assert.equal(record.ok, true);
  assert.equal(record.attempts, 3);
  // The failures of the earlier attempts are still visible: a retry that
  // worked does not erase the fact that something went wrong.
  assert.equal(record.errors.length, 2);
  assert.equal(record.errors[0].step, 'remove-schedule');
  assert.match(String(record.errors[0].message), /could not be deleted/);
});

test('a disarm that never works is recorded with its error, never swallowed', async () => {
  const dir = tempDir('failure');
  armedPending(dir);
  const record = await disarmWatchdog({
    stateDir: dir,
    bootId: 'boot-a',
    attempts: 3,
    backoffMs: 0,
    sleep: async () => {},
    taskExists: () => true,
    readPendingFn: () => {
      // A pending marker that cannot be removed (permissions): this is the
      // shape of the incident — a failure that used to be invisible.
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { name: 'Error' });
    },
  });
  assert.equal(record.ok, false);
  assert.equal(record.attempts, 3);
  assert.ok(record.errors.length >= 3, 'every attempt is recorded');
  assert.equal(record.errors[0].step, 'read-pending');
  assert.match(record.errors[0].message, /EBUSY/);
  // The record is on disk, so the failure survives the process.
  const onDisk = readDisarmRecord(dir);
  assert.equal(onDisk.ok, false);
  assert.equal(onDisk.errors[0].name, 'Error');
});

test('an already gone scheduling item is not a failure', async () => {
  const dir = tempDir('already-gone');
  armedPending(dir);
  const result = disarmOnce({
    stateDir: dir,
    bootId: 'boot-a',
    taskExists: () => false,
    removeItem: () => {
      throw new Error('the removal must not even be tried');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
  assert.equal(result.removed.ok, true);
});

test('the scheduling item is chosen by the pending marker, not by a hard-coded name', () => {
  assert.deepEqual(
    scheduleTargetOf({ tier: 'scheduled-task', taskName: 'mine' }),
    { tier: 'scheduled-task', taskName: 'mine', unitId: '', pidPath: '' },
  );
  // An older marker without a tier is still cleaned up.
  assert.equal(scheduleTargetOf({ taskName: 'mine' }).tier, 'scheduled-task');
  assert.equal(scheduleTargetOf({ unitId: 'dsh-autorestart-watchdog' }).tier, 'systemd-run');
  assert.equal(scheduleTargetOf({ pidPath: '/tmp/watchdog.pid' }).tier, 'detached-process');
  assert.equal(scheduleTargetOf({}).tier, 'none');
  assert.equal(scheduleTargetOf(null).tier, 'none');
});

test('a failed disarm shows up in the diagnostics text', () => {
  const text = buildDiagnostics({
    version: '0.8.2',
    platform: 'win32',
    watchdog: { tier: 'scheduled-task', available: true },
    watchdogDisarm: {
      ok: false,
      source: 'health-route',
      attempts: 3,
      pending: true,
      error: { step: 'remove-schedule', name: 'Error', message: 'access denied' },
    },
  });
  assert.match(text, /watchdog disarm: FAILED/);
  assert.match(text, /watchdog disarm source: health-route/);
  assert.match(text, /watchdog disarm attempts: 3/);
  assert.match(text, /watchdog disarm pending left: yes/);
  assert.match(text, /watchdog disarm error: Error: access denied/);
  // A host that never disarmed says so instead of saying nothing.
  assert.match(buildDiagnostics({}), /watchdog disarm: never ran/);
});

/**
 * Drive one watchdog flow with fake effects.
 *
 * @param {object} options
 */
async function flow(options) {
  const dir = options.dir;
  const pending = buildPending({ restoreTargetDir: TARGET_DIR,
    tier: 'scheduled-task',
    taskName: 'dsh-autorestart-watchdog',
    timeoutMs: 0,
    recheckMs: 0,
    readyTimeoutMs: 0,
    // ONE attempt here on purpose: these tests are about the QUESTIONS the flow
    // asks before it touches anything, not about how often it tries again (that
    // is covered in test/watchdog.test.mjs).
    maxAttempts: 1,
    now: Date.now(),
    ...(options.pending || {}),
  });
  writePending(dir, pending);
  const calls = { restore: 0, relaunch: 0, removeSchedule: 0, health: [] };
  const report = await runWatchdogFlow({
    pending,
    stateDir: dir,
    deps: {
      sleep: options.sleep || (async () => {}),
      probeAlive: options.probeAlive || (async () => false),
      askHealth: async () => {
        const answer = typeof options.askHealth === 'function' ? options.askHealth() : options.askHealth;
        calls.health.push(answer);
        return answer;
      },
      runRestore: () => {
        calls.restore += 1;
        return { ok: true, error: null };
      },
      runRelaunch: () => {
        calls.relaunch += 1;
        return { ok: true, error: null };
      },
      acquireLock: () => true,
      releaseLock: () => {},
      removeSchedule: () => {
        calls.removeSchedule += 1;
      },
    },
  });
  return { report, calls };
}

test('a host that answers the health route is NEVER restored (no marker needed)', async () => {
  const dir = tempDir('flow-healthy');
  const { report, calls } = await flow({ dir, askHealth: 'healthy' });
  assert.equal(report.result, 'not-needed');
  assert.equal(report.healthCheck, 'healthy');
  assert.equal(calls.restore, 0, 'nothing was restored');
  assert.equal(calls.relaunch, 0, 'no second instance was started');
  // The leftovers still go: the scheduling item and the pending marker.
  assert.equal(calls.removeSchedule, 1);
  assert.equal(fs.existsSync(pendingPath(dir)), false);
});

test('a host that answers nothing IS restored', async () => {
  const dir = tempDir('flow-down');
  const { report, calls } = await flow({ dir, askHealth: 'unhealthy' });
  assert.equal(report.healthCheck, 'unhealthy');
  assert.equal(calls.restore, 1, 'the restore ran');
  assert.equal(calls.relaunch, 1);
});

test('without any port to ask, one more round is waited before a restore', async () => {
  const dir = tempDir('flow-unknown');
  const { report, calls } = await flow({ dir, askHealth: 'unknown' });
  assert.equal(report.extraRound, true, 'the extra round ran');
  assert.equal(calls.health.length, 2, 'the health route was asked again');
  assert.equal(calls.restore, 1);
});

test('a live instance is a hard fact: the report says WHY it stood down', async () => {
  const dir = tempDir('flow-instance');
  const { report, calls } = await flow({
    dir,
    askHealth: { state: 'healthy', detail: 'the instance of the new boot is running (pid 4242)' },
  });
  assert.equal(report.result, 'not-needed');
  assert.equal(report.healthCheck, 'healthy');
  assert.match(String(report.healthDetail), /pid 4242/);
  assert.equal(calls.restore, 0);
});

test('the extra round gives a slow host its last chance (it writes the marker)', async () => {
  const dir = tempDir('flow-slow');
  const { report, calls } = await flow({
    dir,
    askHealth: 'unknown',
    // The host finishes its boot while the watchdog waits.
    sleep: async () => {
      writeReady(dir, { bootId: 'the-new-boot' });
    },
  });
  assert.equal(report.result, 'not-needed');
  assert.equal(report.ready, true);
  assert.equal(calls.restore, 0, 'the snapshot was not restored');
});
