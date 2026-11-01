/**
 * THE ARMING OF THE SYSTEMD WATCHDOG — "a leftover must not degrade it for good".
 *
 * The real incident (hosted web instance on port 5601, WSL, real systemd log):
 *
 *     Failed to start transient timer unit: Unit dsh-autorestart-watchdog.timer
 *     already exists.
 *
 * The cleanup only ran `systemctl --user reset-failed`, which clears the failed
 * STATE of a unit — it does NOT stop a transient timer that is still waiting.
 * So the name stayed taken, the arming failed, `v2Armed` became false, the
 * arbiter fell back to the old v1 watcher (restore only, no relaunch) — and
 * because nothing ever stopped the leftover, EVERY later arming failed the same
 * way: one bad leftover degraded the watchdog permanently. Clearing the unit by
 * hand restored `tier=systemd-run / arbiter=v2` at once.
 *
 * These tests model systemd closely enough to prove the three claims:
 *
 *   1. the cleanup really STOPS the units (`stop`, not only `reset-failed`);
 *   2. a refused registration is retried exactly once after a forced cleanup;
 *   3. a cleanup that could not clear the unit is REPORTED, never swallowed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { planWatchdogArbiter } from '../lib/watchdog-arbiter.js';
import {
  ARM_OUTCOMES,
  armSystemdWatchdog,
  cleanupSystemdUnit,
  describeArmResult,
  removeScheduleItem,
  systemdUnitNames,
} from '../lib/watchdog-schedule.js';

const UNIT = 'dsh-autorestart-watchdog';
const TIMER = UNIT + '.timer';
const SERVICE = UNIT + '.service';
const COMMAND = ['/usr/bin/node', '/plugin/scripts/watchdog.mjs'];

/**
 * A systemd user manager, as far as this plugin can see it.
 *
 * `loaded` is the set of units the manager still knows: a transient timer that
 * was STOPPED is unloaded (that is exactly why `stop` frees the name), while
 * `reset-failed` on its own changes nothing about a unit that is still there.
 *
 * @param {{ timer?: boolean, service?: boolean, stopFailures?: number, refuseRegisters?: number }} [options]
 */
function fakeSystemd({ timer = false, service = false, stopFailures = 0, refuseRegisters = 0 } = {}) {
  const loaded = new Set();
  if (timer) loaded.add(TIMER);
  if (service) loaded.add(SERVICE);
  const state = { stopFailures, refuseRegisters, registers: 0, calls: [] };
  const notLoaded = (verb, unit) => ({
    ok: false,
    stdout: '',
    error: 'Command failed: systemctl --user ' + verb + ' ' + unit
      + '\nFailed to ' + (verb === 'stop' ? 'stop' : 'reset failed state of') + ' ' + unit
      + ': Unit ' + unit + ' not loaded.',
  });
  const exec = (file, args) => {
    state.calls.push([file, ...args].join(' '));
    if (file === 'systemctl') {
      const verb = args[1];
      const unit = args[2];
      if (verb !== 'stop' && verb !== 'reset-failed') return { ok: true, stdout: '', error: null };
      if (state.stopFailures > 0) {
        state.stopFailures -= 1;
        return {
          ok: false,
          stdout: '',
          error: 'Command failed: systemctl --user ' + verb + ' ' + unit
            + '\nFailed to ' + (verb === 'stop' ? 'stop' : 'reset failed state of') + ' ' + unit
            + ': Access denied',
        };
      }
      if (!loaded.has(unit)) return notLoaded(verb, unit);
      // `stop` is what unloads a transient unit; `reset-failed` keeps it.
      if (verb === 'stop') loaded.delete(unit);
      return { ok: true, stdout: '', error: null };
    }
    if (file === 'systemd-run') {
      state.registers += 1;
      if (state.refuseRegisters > 0) {
        state.refuseRegisters -= 1;
        return {
          ok: false,
          stdout: '',
          error: 'Failed to start transient timer unit: Unit ' + TIMER + ' already exists.',
        };
      }
      if (loaded.has(TIMER)) {
        return {
          ok: false,
          stdout: '',
          error: 'Failed to start transient timer unit: Unit ' + TIMER + ' already exists.',
        };
      }
      loaded.add(TIMER);
      return { ok: true, stdout: 'Running timer as unit: ' + TIMER, error: null };
    }
    return { ok: false, stdout: '', error: 'unexpected command: ' + file };
  };
  return { exec, loaded, state };
}

const timersIn = (loaded) => [...loaded].filter((unit) => unit.endsWith('.timer'));

// ---------------------------------------------------------------------------
// 1. THE CLEANUP REALLY STOPS
// ---------------------------------------------------------------------------

test('the cleanup STOPS the timer and the service before it resets them', () => {
  const systemd = fakeSystemd({ timer: true, service: true });
  const result = cleanupSystemdUnit({ unitId: UNIT, exec: systemd.exec });

  assert.deepEqual(systemd.state.calls, [
    'systemctl --user stop ' + TIMER,
    'systemctl --user stop ' + SERVICE,
    'systemctl --user reset-failed ' + TIMER,
    'systemctl --user reset-failed ' + SERVICE,
  ], 'stop comes first: reset-failed only clears the failed state of a unit that is still loaded');

  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(result.stopped, [TIMER, SERVICE], 'the report names what was really stopped');
  assert.deepEqual(result.residual, []);
  assert.equal(systemd.loaded.size, 0, 'after the cleanup the units are gone from the manager');
  assert.equal(result.steps.length, 4, 'every step is reported, none is folded into "ok"');
  for (const step of result.steps) {
    assert.ok(['done', 'absent', 'failed'].includes(step.outcome), 'unknown outcome: ' + step.outcome);
  }
});

test('a unit name with its suffix is cleaned as the same pair, not as "…timer.timer"', () => {
  const systemd = fakeSystemd({ timer: true });
  const result = cleanupSystemdUnit({ unitId: TIMER, exec: systemd.exec });
  assert.equal(systemd.state.calls[0], 'systemctl --user stop ' + TIMER);
  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(result.units, [TIMER, SERVICE]);
});

test('a clean machine is not reported as a broken cleanup', () => {
  const systemd = fakeSystemd();
  const result = cleanupSystemdUnit({ unitId: UNIT, exec: systemd.exec });
  // "Unit … not loaded" is systemd's normal answer when there was nothing to
  // clean: it must not look like a failure, and it must not look like a stop
  // either.
  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.steps.map((step) => step.outcome), ['absent', 'absent', 'absent', 'absent']);
});

test('the disarm path still gets ok/error out of the systemd tier', () => {
  const systemd = fakeSystemd({ timer: true });
  const removed = removeScheduleItem({ tier: 'systemd-run', unitId: UNIT, exec: systemd.exec });
  assert.equal(removed.ok, true, removed.error || '');
  assert.deepEqual(timersIn(systemd.loaded), [], 'the leftover timer is gone');
});

// ---------------------------------------------------------------------------
// 2. A LEFTOVER DOES NOT KEEP THE WATCHDOG AWAY
// ---------------------------------------------------------------------------

test('a timer of an earlier run is still waiting: the new arming succeeds and only ONE timer runs', () => {
  const systemd = fakeSystemd({ timer: true });
  const armed = armSystemdWatchdog({
    unitId: UNIT,
    delaySeconds: 30,
    command: COMMAND,
    exec: systemd.exec,
  });

  assert.equal(armed.ok, true, armed.error || '');
  assert.equal(armed.outcome, ARM_OUTCOMES.CLEANED_THEN_ARMED, 'the report says a leftover had to be stopped');
  assert.deepEqual(armed.cleanup.stopped, [TIMER], 'the stop that actually ran is named');
  assert.equal(armed.retried, false, 'no retry was needed: the cleanup freed the name');

  const stopIndex = systemd.state.calls.indexOf('systemctl --user stop ' + TIMER);
  const registerIndex = systemd.state.calls.findIndex((call) => call.startsWith('systemd-run '));
  assert.ok(stopIndex >= 0, 'the arming must STOP the leftover, not merely reset it');
  assert.ok(registerIndex > stopIndex, 'the stop happens before the registration');

  const registerCall = systemd.state.calls[registerIndex];
  assert.ok(registerCall.includes('--unit=' + UNIT), 'the unit keeps its one name: ' + registerCall);
  assert.ok(registerCall.includes('--on-active=30s'), registerCall);

  assert.deepEqual(timersIn(systemd.loaded), [TIMER], 'exactly one timer is running afterwards');
});

test('a registration refused by the name clash is saved by ONE forced cleanup and ONE retry', () => {
  const systemd = fakeSystemd({ timer: true, refuseRegisters: 1 });
  const armed = armSystemdWatchdog({
    unitId: UNIT,
    delaySeconds: 30,
    command: COMMAND,
    exec: systemd.exec,
  });

  assert.equal(armed.ok, true, armed.error || '');
  assert.equal(armed.outcome, ARM_OUTCOMES.ARMED_AFTER_RETRY, 'the report says the retry saved it');
  assert.equal(armed.retried, true);
  assert.equal(systemd.state.registers, 2, 'exactly two registrations: one attempt and one retry');
  assert.equal(armed.attempts.length, 2);
  assert.equal(armed.attempts[0].ok, false, 'the first attempt really was refused');
  assert.equal(armed.attempts[1].ok, true);
  assert.deepEqual(timersIn(systemd.loaded), [TIMER], 'still exactly one timer');
  assert.match(armed.detail, /already exists/, 'the reason of the first refusal is kept: ' + armed.detail);
});

test('the retry is bounded: a refusal that does not go away is never retried forever', () => {
  const systemd = fakeSystemd({ timer: true, refuseRegisters: 99 });
  const armed = armSystemdWatchdog({
    unitId: UNIT,
    delaySeconds: 30,
    command: COMMAND,
    exec: systemd.exec,
  });

  assert.equal(armed.ok, false);
  assert.equal(systemd.state.registers, 2, 'one attempt plus one retry — never a loop');
  assert.equal(armed.attempts.length, 2);
});

// ---------------------------------------------------------------------------
// 3. A CLEANUP THAT FAILED IS VISIBLE (the "no silent fallback" rule)
// ---------------------------------------------------------------------------

test('a cleanup that cannot clear the leftover is reported with the unit and the step', () => {
  // 8 failures = both cleanup runs of 4 steps fail, so the timer stays loaded.
  const systemd = fakeSystemd({ timer: true, service: true, stopFailures: 8 });
  const armed = armSystemdWatchdog({
    unitId: UNIT,
    delaySeconds: 30,
    command: COMMAND,
    exec: systemd.exec,
  });

  assert.equal(armed.ok, false);
  assert.equal(armed.outcome, ARM_OUTCOMES.CLEANUP_FAILED, 'the outcome says the cleanup — not systemd-run — is the problem');
  assert.equal(armed.cleanup.ok, false);
  assert.ok(armed.cleanup.residual.includes(TIMER), 'the residual unit is named: ' + JSON.stringify(armed.cleanup.residual));
  assert.ok(armed.cleanup.failedSteps.length > 0);
  assert.ok(
    armed.cleanup.failedSteps.some((step) => step.action === 'stop' && step.unit === TIMER),
    'the step that failed is named, not just "cleanup failed"',
  );
  assert.match(armed.error, new RegExp(TIMER.replace(/\./g, '\\.')), 'the error names the unit it could not free');
  assert.match(armed.detail, /residual/i);

  // The same facts must survive the trip into the report.
  const report = describeArmResult(armed);
  assert.equal(report.armOutcome, ARM_OUTCOMES.CLEANUP_FAILED);
  assert.ok(report.armResidualUnits.includes(TIMER), JSON.stringify(report.armResidualUnits));
  assert.ok(report.armFailedSteps.some((line) => line.includes('stop ' + TIMER)), JSON.stringify(report.armFailedSteps));
  assert.equal(report.armCleanup.ok, false);
  assert.ok(report.armError !== null, 'a failed arming always carries its error');
});

test('a registration that fails with a clean machine says so instead of blaming a phantom leftover', () => {
  const systemd = fakeSystemd({ refuseRegisters: 99 });
  const armed = armSystemdWatchdog({
    unitId: UNIT,
    delaySeconds: 30,
    command: COMMAND,
    exec: systemd.exec,
  });
  assert.equal(armed.ok, false);
  assert.equal(armed.outcome, ARM_OUTCOMES.FAILED, 'nothing was left over, so the cleanup is not the culprit');
  assert.equal(armed.cleanup.ok, true, 'the cleanup really did succeed');
  assert.match(armed.detail, /nothing to stop/);
});

test('the report of a tier without systemd units still says what happened', () => {
  const report = describeArmResult({ ok: false, error: 'schtasks refused', tier: 'scheduled-task' });
  assert.equal(report.armOutcome, ARM_OUTCOMES.FAILED);
  assert.equal(report.armError, 'schtasks refused');
  assert.deepEqual(report.armResidualUnits, []);
  assert.equal(report.armCleanup, null);

  const armed = describeArmResult({ ok: true, error: null, tier: 'scheduled-task' });
  assert.equal(armed.armOutcome, ARM_OUTCOMES.ARMED);
});

// ---------------------------------------------------------------------------
// 4. ONE FAILURE DOES NOT DEGRADE THE WATCHDOG FOR GOOD
// ---------------------------------------------------------------------------

test('after a failed arming the NEXT arming recovers on its own — no permanent v1 fallback', () => {
  const systemd = fakeSystemd({ timer: true, stopFailures: 8 });
  const first = armSystemdWatchdog({ unitId: UNIT, delaySeconds: 30, command: COMMAND, exec: systemd.exec });
  assert.equal(first.ok, false, 'the first arming fails while systemd refuses the stop');
  assert.equal(first.outcome, ARM_OUTCOMES.CLEANUP_FAILED);
  // That failure is what makes the arbiter fall back to the old v1 watcher.
  assert.equal(planWatchdogArbiter({ v2Armed: first.ok === true }).arbiter, 'v1');

  // The next restart runs in NEW process state: systemd answers normally again.
  systemd.state.stopFailures = 0;
  const second = armSystemdWatchdog({ unitId: UNIT, delaySeconds: 30, command: COMMAND, exec: systemd.exec });

  assert.equal(second.ok, true, second.error || 'the next arming must recover by itself');
  assert.equal(second.outcome, ARM_OUTCOMES.CLEANED_THEN_ARMED, 'it stops the leftover left by the failed run');
  assert.deepEqual(timersIn(systemd.loaded), [TIMER], 'exactly one timer afterwards');
  assert.equal(
    planWatchdogArbiter({ v2Armed: second.ok === true }).arbiter,
    'v2',
    'and the arbiter is v2 again: no permanent degradation to the old watcher',
  );
});

// ---------------------------------------------------------------------------
// 5. THE WIRING (index.js must use the arming that stops + retries)
// ---------------------------------------------------------------------------

test('the host arms the systemd tier through armSystemdWatchdog, not reset-failed + register', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('registered = armSystemdWatchdog({'),
    'the systemd tier must go through the arming that stops the leftover and retries once',
  );
  assert.ok(
    source.includes('command: [armCommand.file, ...armCommand.args]'),
    'the resolved interpreter stays argv[0] of the systemd command',
  );
  assert.equal(
    /cleanupSystemdUnit\(\{ unitId \}\);\s*registered = registerSystemdRun\(/.test(source),
    false,
    'the old "reset-failed, then register" pair must be gone',
  );
  assert.ok(
    source.includes("writeArbiterReport(ARBITERS.V1, arbiter.reason, 'none', watchdogArm)"),
    'the v1 fallback report carries the arming result (why v2 is not the arbiter)',
  );
  assert.ok(
    source.includes('writeArbiterReport(ARBITERS.V2, arbiter.reason, watchdogArm.tier, watchdogArm)'),
    'the v2 report carries the arming result too',
  );
  assert.ok(
    source.includes('...armReport,'),
    'the arm result returned to the caller carries the arm fields',
  );
  assert.ok(
    source.includes('residualUnits: armReport.armResidualUnits'),
    'the log of a failed arming names the residual unit',
  );
});

test('the unit names of one base are the timer and the service', () => {
  assert.deepEqual(systemdUnitNames(UNIT), { base: UNIT, timer: TIMER, service: SERVICE });
  assert.deepEqual(systemdUnitNames(TIMER), { base: UNIT, timer: TIMER, service: SERVICE });
  assert.deepEqual(systemdUnitNames(SERVICE), { base: UNIT, timer: TIMER, service: SERVICE });
  assert.deepEqual(systemdUnitNames(''), { base: '', timer: '', service: '' });
});
