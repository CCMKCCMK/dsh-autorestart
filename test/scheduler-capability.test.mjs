/**
 * Can this machine create a one-off scheduled task?
 *
 * The automatic rollback of this plugin hangs on that answer, so the probe has
 * to be honest in both directions:
 *
 *   - it must never leave a task behind (the task is deleted and read back
 *     once more — a task that survives would show up in the user's task
 *     scheduler);
 *   - a machine that refuses must be reported as "blocked", never as a
 *     failure of the plugin: the plugin works, only the safety net is gone.
 *
 * The executor is FAKE here: no test ever creates a real task.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyCapabilities,
  isCapabilities,
  markSchedulerWarned,
  probeSchedulerCapability,
  probeTaskName,
  probeTrigger,
  readStartBoundary,
  SCHEDULER_BLOCKED,
  SCHEDULER_NOT_APPLICABLE,
  SCHEDULER_OK,
  SCHEDULER_UNKNOWN,
  shouldWarnScheduler,
  taskEnabled,
  taskHasAction,
  triggerMatches,
} from '../lib/scheduler-capability.js';

/**
 * The XML a REAL schtasks answered with (a Chinese Windows, 2026-10-29).
 *
 * It is copied from the real run on purpose: that XML carries NO <Enabled>
 * element at all, and a check that demanded `<Enabled>true</Enabled>` called a
 * perfectly working machine "blocked".
 */
function taskXml(iso) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Date>' + iso + '</Date>',
    '    <Author>PC\\Administrator</Author>',
    '    <URI>\\probe</URI>',
    '  </RegistrationInfo>',
    '  <Settings>',
    '    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    '  </Settings>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <StartBoundary>' + iso + '</StartBoundary>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>cmd</Command>',
    '      <Arguments>/c exit 0</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\r\n');
}

/**
 * A fake schtasks.
 *
 * @param {{ refuseCreate?: boolean, refuseDelete?: boolean, keepAfterDelete?: boolean, wrongTrigger?: boolean }} options
 */
function fakeSchtasks({ refuseCreate = false, refuseDelete = false, keepAfterDelete = false, wrongTrigger = false } = {}) {
  const calls = [];
  const state = { exists: false, iso: probeTrigger(Date.now()).iso };
  const exec = (file, args) => {
    calls.push({ file, args: args.slice() });
    const verb = args[0];
    if (verb === '/Create') {
      if (refuseCreate) return { ok: false, stdout: '', error: 'ERROR: Access is denied.' };
      state.exists = true;
      return { ok: true, stdout: 'SUCCESS', error: null };
    }
    if (verb === '/Query') {
      if (!state.exists) return { ok: false, stdout: '', error: 'ERROR: The system cannot find the file specified.' };
      const iso = wrongTrigger ? '2000-01-01T00:00' : state.iso;
      return { ok: true, stdout: taskXml(iso), error: null };
    }
    if (verb === '/Delete') {
      if (refuseDelete) return { ok: false, stdout: '', error: 'ERROR: Access is denied.' };
      if (!keepAfterDelete) state.exists = false;
      return { ok: true, stdout: 'SUCCESS', error: null };
    }
    return { ok: false, stdout: '', error: 'ERROR: unknown verb ' + verb };
  };
  return { exec, calls, state };
}

test('a probe that succeeds says ok AND leaves no task behind', () => {
  const fake = fakeSchtasks();
  const result = probeSchedulerCapability({ platform: 'win32', exec: fake.exec, now: Date.now() });
  assert.equal(result.scheduler, SCHEDULER_OK);
  assert.ok(result.checkedAt > 0);
  // The task was created, verified, deleted and read back once more.
  const kinds = result.evidence.steps.map((entry) => entry.kind);
  assert.deepEqual(kinds, ['pre-clean', 'create', 'verify', 'trigger', 'enabled', 'action', 'delete', 'gone']);
  // The last query must have FAILED: the task is gone.
  assert.equal(result.evidence.steps.at(-1).ok, true);
  assert.equal(fake.state.exists, false, 'no task may survive the probe');
  // There is a delete AFTER the create.
  const createAt = fake.calls.findIndex((call) => call.args[0] === '/Create');
  const deleteAt = fake.calls.findIndex((call) => call.args[0] === '/Delete' && fake.calls.indexOf(call) > createAt);
  assert.ok(deleteAt > createAt, 'the task must be deleted after it was created');
});

test('a refused registration says blocked AND still cleans up', () => {
  const fake = fakeSchtasks({ refuseCreate: true });
  const result = probeSchedulerCapability({ platform: 'win32', exec: fake.exec, now: Date.now() });
  assert.equal(result.scheduler, SCHEDULER_BLOCKED);
  // The cleanup runs even though the creation failed: a refused /Create can
  // still have left a task behind.
  const deletes = fake.calls.filter((call) => call.args[0] === '/Delete');
  assert.ok(deletes.length >= 2, 'the cleanup must be attempted (and the leftover cleaned)');
  assert.equal(fake.state.exists, false, 'no task may survive the probe');
  // The reason is on the record.
  const create = result.evidence.steps.find((entry) => entry.kind === 'create');
  assert.equal(create.ok, false);
  assert.match(String(create.detail), /Access is denied/);
});

test('a task that survives the probe is a failure, not a success', () => {
  const fake = fakeSchtasks({ keepAfterDelete: true });
  const result = probeSchedulerCapability({ platform: 'win32', exec: fake.exec, now: Date.now() });
  assert.equal(result.scheduler, SCHEDULER_BLOCKED);
  assert.equal(result.evidence.steps.at(-1).kind, 'gone');
  assert.equal(result.evidence.steps.at(-1).ok, false, 'the task still exists — that is not ok');
});

test('a task that would not fire is a failure too', () => {
  const fake = fakeSchtasks({ wrongTrigger: true });
  const result = probeSchedulerCapability({ platform: 'win32', exec: fake.exec, now: Date.now() });
  assert.equal(result.scheduler, SCHEDULER_BLOCKED);
  const trigger = result.evidence.steps.find((entry) => entry.kind === 'trigger');
  assert.equal(trigger.ok, false, 'the trigger must be the one we asked for');
});

test('the probe is idempotent: a leftover task of an earlier run is cleaned first', () => {
  const fake = fakeSchtasks();
  // The leftover of an earlier run is there before the probe starts.
  fake.state.exists = true;
  const result = probeSchedulerCapability({ platform: 'win32', exec: fake.exec, now: Date.now() });
  assert.equal(result.scheduler, SCHEDULER_OK);
  assert.equal(fake.calls[0].args[0], '/Delete', 'the leftover is deleted before anything else');
  assert.equal(fake.state.exists, false);
});

test('a platform without one-off tasks is not applicable, not blocked', () => {
  const fake = fakeSchtasks();
  const result = probeSchedulerCapability({ platform: 'linux', exec: fake.exec, now: Date.now() });
  // THE ANSWER IS NO LONGER `ok` (2026-11-02): a green tick for a check that
  // never ran is exactly what this probe must not produce. `ok` stays the word
  // for "we registered a task, read it back and deleted it again".
  assert.equal(result.scheduler, SCHEDULER_NOT_APPLICABLE);
  assert.notEqual(result.scheduler, SCHEDULER_OK);
  assert.equal(result.applicable, false);
  assert.match(result.reason, /not applicable/);
  assert.equal(result.evidence.applicable, false);
  assert.equal(fake.calls.length, 0, 'nothing is created on a platform that does not use them');
});

test('the trigger is two minutes ahead and the XML says it', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const trigger = probeTrigger(now);
  // schtasks wants the LOCAL time of this machine, so the trigger is compared
  // with the local time of the same moment.
  const local = new Date(now + 2 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  assert.equal(trigger.st, pad(local.getHours()) + ':' + pad(local.getMinutes()));
  assert.equal(trigger.sd, local.getFullYear() + '/' + pad(local.getMonth() + 1) + '/' + pad(local.getDate()));
  assert.equal(trigger.iso, local.getFullYear() + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate()) + 'T' + pad(local.getHours()) + ':' + pad(local.getMinutes()));
  const xml = taskXml(trigger.iso);
  assert.equal(readStartBoundary(xml), trigger.iso);
  assert.equal(triggerMatches(xml, trigger.iso), true);
  assert.equal(triggerMatches(xml, '2026-10-29T12:03'), false);
  // A task WITHOUT an <Enabled> element is enabled (that is the default) —
  // the real XML of a Chinese Windows looks exactly like that.
  assert.equal(taskEnabled(xml), true);
  assert.equal(taskEnabled('<Task><Settings><Enabled>false</Enabled></Settings></Task>'), false);
  // A task without an action is not a task that could run.
  assert.equal(taskHasAction(xml), true);
  assert.equal(taskHasAction('<Task><Triggers></Triggers></Task>'), false);
});

test('the task name is unique per run', () => {
  assert.notEqual(probeTaskName(1000, 42), probeTaskName(2000, 42));
  assert.match(probeTaskName(1000, 42), /^dsh-autorestart-capability-probe-42-/);
});

// ---------------------------------------------------------------------------
// The one-time warning
// ---------------------------------------------------------------------------

test('the warning is only for the TRANSITION into blocked', () => {
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_OK }, { scheduler: SCHEDULER_BLOCKED }), true);
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_UNKNOWN }, { scheduler: SCHEDULER_BLOCKED }), true);
  assert.equal(shouldWarnScheduler(null, { scheduler: SCHEDULER_BLOCKED }), true);
  // Already blocked: no nagging.
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_BLOCKED }, { scheduler: SCHEDULER_BLOCKED }), false);
  // Not blocked at all.
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_BLOCKED }, { scheduler: SCHEDULER_OK }), false);
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_OK }, { scheduler: SCHEDULER_OK }), false);
});

test('a user who has seen the warning is not asked again', () => {
  const seen = markSchedulerWarned({ scheduler: SCHEDULER_BLOCKED, checkedAt: 1 }, 5000);
  assert.equal(seen.warnedAt, 5000);
  assert.equal(shouldWarnScheduler({ scheduler: SCHEDULER_BLOCKED }, seen), false);
  // Marking it twice keeps the first moment.
  const again = markSchedulerWarned(seen, 9000);
  assert.equal(again.warnedAt, 5000);
});

test('the capabilities record starts as unknown and is readable', () => {
  const empty = emptyCapabilities();
  assert.equal(empty.scheduler, SCHEDULER_UNKNOWN);
  assert.equal(empty.warnedAt, null);
  assert.equal(isCapabilities(empty), true);
  assert.equal(isCapabilities(null), false);
  assert.equal(isCapabilities({ scheduler: 'nonsense' }), false);
});
