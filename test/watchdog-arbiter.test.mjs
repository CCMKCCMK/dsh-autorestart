/**
 * ONE watchdog at a time.
 *
 * The plugin knows two watchdogs: the old one (v1: restores the snapshot, does
 * NOT start the host again) and the new one (v2: restores it AND starts the
 * host again). They take the same lock, so two of them at once is worse than
 * one — if v2 loses the lock, the profile is restored and nothing is running.
 *
 * These tests pin down that rule:
 *
 *   - v2 armed → the old watcher is NOT started (its spawner stays at 0);
 *   - v2 not available (tier none) → the old watcher takes over;
 *   - never both at the same time.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchDetachedWatcher } from '../lib/restart.js';
import { ARBITERS, armTheOneArbiter, planWatchdogArbiter } from '../lib/watchdog-arbiter.js';
import { buildPending, readReport, writeReport } from '../lib/watchdog.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A spawner that only counts. It never starts anything. */
function countingSpawner() {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args: Array.isArray(args) ? args.slice() : [] });
    return { on() { return this }, once() { return this }, unref() { return this } };
  };
  const execFileSyncFn = (file) => {
    calls.push({ command: file, args: [] });
    return '';
  };
  return { calls, spawnFn, execFileSyncFn };
}

test('the plan: v2 armed means the old watcher is not started', () => {
  const plan = planWatchdogArbiter({ v2Armed: true });
  assert.equal(plan.arbiter, ARBITERS.V2);
  assert.equal(plan.startV1, false);
  assert.match(plan.reason, /v2/);
});

test('the plan: v2 not available means the old watcher takes over', () => {
  const plan = planWatchdogArbiter({ v2Armed: false });
  assert.equal(plan.arbiter, ARBITERS.V1);
  assert.equal(plan.startV1, true);
});

test('the plan: the supervisor of the plugin means nobody watches', () => {
  const plan = planWatchdogArbiter({ v2Armed: false, supervised: true });
  assert.equal(plan.arbiter, ARBITERS.NONE);
  assert.equal(plan.startV1, false);
});

test('v2 armed: the old watcher command is NEVER spawned', () => {
  const spawner = countingSpawner();
  let v1Calls = 0;
  const result = armTheOneArbiter({
    v2Arm: () => ({ ok: true, tier: 'scheduled-task', reason: '' }),
    // The old watcher, with the spawner of the real code path injected.
    v1Arm: () => {
      v1Calls += 1;
      return launchDetachedWatcher({
        watchScriptPath: path.join(os.tmpdir(), 'watch.ps1'),
        platform: 'win32',
        spawnFn: spawner.spawnFn,
        execFileSyncFn: spawner.execFileSyncFn,
      });
    },
  });
  assert.equal(result.arbiter, ARBITERS.V2);
  assert.equal(result.v1Started, false);
  assert.equal(v1Calls, 0, 'the old watcher must not be armed next to v2');
  assert.equal(spawner.calls.length, 0, 'no watcher command may be spawned');
  assert.equal(result.v1, null);
});

test('v2 not available: the old watcher takes over', () => {
  const spawner = countingSpawner();
  let v1Calls = 0;
  const result = armTheOneArbiter({
    v2Arm: () => ({ ok: false, tier: 'none', reason: 'this machine cannot run the watchdog' }),
    v1Arm: () => {
      v1Calls += 1;
      return launchDetachedWatcher({
        watchScriptPath: path.join(os.tmpdir(), 'watch.ps1'),
        platform: 'win32',
        spawnFn: spawner.spawnFn,
        execFileSyncFn: spawner.execFileSyncFn,
      });
    },
  });
  assert.equal(result.arbiter, ARBITERS.V1);
  assert.equal(result.v1Started, true);
  assert.equal(v1Calls, 1, 'the old watcher must be armed when v2 cannot');
  assert.ok(result.v1 !== null);
  assert.equal(result.v2.tier, 'none');
});

test('never both at the same time: at most one watcher, at most one schedule item', () => {
  for (const v2Armed of [true, false]) {
    const spawner = countingSpawner();
    let v1Calls = 0;
    const result = armTheOneArbiter({
      v2Arm: () => ({ ok: v2Armed, tier: v2Armed ? 'scheduled-task' : 'none', reason: '' }),
      v1Arm: () => {
        v1Calls += 1;
        return launchDetachedWatcher({
          watchScriptPath: path.join(os.tmpdir(), 'watch.ps1'),
          platform: 'win32',
          spawnFn: spawner.spawnFn,
          execFileSyncFn: spawner.execFileSyncFn,
        });
      },
    });
    const watchers = (result.v2.ok === true ? 1 : 0) + (result.v1Started ? 1 : 0);
    assert.equal(watchers, 1, 'exactly one watcher may be armed');
    if (v2Armed) assert.equal(spawner.calls.length, 0);
  }
});

test('the report names the arbiter', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-arbiter-'));
  try {
    // The v2 watchdog copies the arbiter from the pending marker.
    const pending = buildPending({ tier: 'scheduled-task', arbiter: ARBITERS.V2 });
    assert.equal(pending.arbiter, 'v2');
    // The host writes the report when v1 is the arbiter.
    writeReport(stateDir, { at: new Date().toISOString(), result: 'armed', arbiter: ARBITERS.V1, tier: 'none' });
    const report = readReport(stateDir);
    assert.equal(report.arbiter, 'v1');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
