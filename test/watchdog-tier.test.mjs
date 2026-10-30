/**
 * WHICH WAY CAN THE WATCHDOG BE TRIGGERED?
 *
 * The picker is the one place that decides, so the warning in the settings
 * page and the watchdog that is really registered cannot drift apart.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandWorks,
  detectWatchdogCapabilities,
  pickWatchdogTier,
  TIERS,
  tierProvidesRollback,
  tierWithProof,
} from '../lib/watchdog-tier.js';
import {
  buildScheduledTaskXml,
  localIso,
  registerDetachedProcess,
  registerScheduledTask,
  registerSystemdRun,
  removeScheduledTask,
} from '../lib/watchdog-schedule.js';

test('Windows gets the scheduled task', () => {
  const picked = pickWatchdogTier({ platform: 'win32', hasSchtasks: true });
  assert.equal(picked.tier, TIERS.SCHEDULED_TASK);
  assert.ok(picked.reason.length > 0, 'the reason is part of the answer');
});

test('a Windows without schtasks gets nothing', () => {
  const picked = pickWatchdogTier({ platform: 'win32', hasSchtasks: false });
  assert.equal(picked.tier, TIERS.NONE);
  assert.equal(tierProvidesRollback(picked.tier), false);
});

test('Linux with systemd gets the systemd timer', () => {
  const picked = pickWatchdogTier({ platform: 'linux', hasSystemdRun: true, canDetach: true });
  assert.equal(picked.tier, TIERS.SYSTEMD_RUN);
  assert.equal(tierProvidesRollback(picked.tier), true);
});

test('Linux without systemd and without at gets the detached process', () => {
  const picked = pickWatchdogTier({ platform: 'linux', hasSystemdRun: false, hasAt: false, canDetach: true });
  assert.equal(picked.tier, TIERS.DETACHED_PROCESS);
  assert.match(picked.reason, /no systemd and no at/);
});

test('a machine with at still gets the detached process (and says why)', () => {
  const picked = pickWatchdogTier({ platform: 'linux', hasSystemdRun: false, hasAt: true, canDetach: true });
  assert.equal(picked.tier, TIERS.DETACHED_PROCESS);
  assert.match(picked.reason, /has at/);
});

test('a container that cannot detach a process gets nothing', () => {
  const picked = pickWatchdogTier({ platform: 'linux', hasSystemdRun: false, hasAt: false, canDetach: false });
  assert.equal(picked.tier, TIERS.NONE);
  assert.equal(tierProvidesRollback(picked.tier), false);
});

test('a machine with nothing at all gets nothing', () => {
  const picked = pickWatchdogTier({ platform: 'darwin', hasSystemdRun: false, hasAt: false, canDetach: false });
  assert.equal(picked.tier, TIERS.NONE);
});

test('the proof of the probe decides the Windows tier', () => {
  // The probe really registered a task and read it back: that IS the answer.
  assert.equal(tierWithProof({ platform: 'win32', probeOk: true }).tier, TIERS.SCHEDULED_TASK);
  // The probe was refused: no task, no tier.
  assert.equal(tierWithProof({ platform: 'win32', probeOk: false }).tier, TIERS.NONE);
  // On Linux the probe says nothing about systemd.
  assert.equal(tierWithProof({ platform: 'linux', probeOk: true, hasSystemdRun: true }).tier, TIERS.SYSTEMD_RUN);
});

test('the capabilities of a machine are read from the machine', () => {
  const asked = [];
  const exec = (file, args) => {
    asked.push(file);
    if (file === 'systemd-run') return { ok: true, stdout: 'systemd 249', error: null };
    if (file === 'setsid') return { ok: true, stdout: 'util-linux', error: null };
    return { ok: false, stdout: '', error: 'not found' };
  };
  const caps = detectWatchdogCapabilities({ platform: 'linux', exec });
  assert.equal(caps.hasSystemdRun, true);
  assert.equal(caps.canDetach, true);
  assert.equal(caps.hasAt, false);
  assert.equal(caps.hasSchtasks, false);
  assert.ok(asked.includes('systemd-run'));
  assert.ok(asked.includes('at'));
});

test('a command that fails is not there', () => {
  assert.equal(commandWorks(() => ({ ok: false, stdout: '', error: 'x' }), 'x', []), false);
  assert.equal(commandWorks(() => ({ ok: true, stdout: '', error: null }), 'x', []), true);
});

// ---------------------------------------------------------------------------
// The registrations
// ---------------------------------------------------------------------------

test('the task XML has an end boundary and ignores new instances', () => {
  const xml = buildScheduledTaskXml({
    startIso: '2026-10-29T18:00:00',
    endIso: '2026-10-29T18:10:00',
    command: 'node watchdog.mjs --state-dir C:\\state',
    // A command line that names a bare `node` is resolved to the absolute path
    // of a real interpreter: a scheduled task must not depend on its PATH.
    planOptions: { execPath: 'C:\\tools\\nodejs\\node.exe', platform: 'win32', env: { Path: '' } },
  });
  // A one-off task without an EndBoundary is refused by Windows.
  assert.match(xml, /<EndBoundary>2026-10-29T18:10:00<\/EndBoundary>/);
  assert.match(xml, /<StartBoundary>2026-10-29T18:00:00<\/StartBoundary>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  // NO SHELL IN BETWEEN: `cmd /c` is what stripped the quotes and turned the
  // first token into `...\Programs\DeepSeek` (exit code 9009).
  assert.doesNotMatch(xml, /<Command>\s*cmd\s*<\/Command>/, 'the task must not be wrapped in cmd');
  assert.match(xml, /<Command>C:\\tools\\nodejs\\node\.exe<\/Command>/, 'the interpreter is the program of the task');
});

test('the task is registered, read back and only accepted when the trigger is right', () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push(args[0]);
    if (args[0] === '/Create') return { ok: true, stdout: 'SUCCESS', error: null };
    if (args[0] === '/Query') {
      return {
        ok: true,
        stdout: '<Task><Triggers><TimeTrigger><StartBoundary>2026-10-29T18:00:00</StartBoundary>'
          + '<EndBoundary>2026-10-29T18:10:00</EndBoundary></TimeTrigger></Triggers>'
          + '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings></Task>',
        error: null,
      };
    }
    return { ok: true, stdout: '', error: null };
  };
  const written = [];
  const result = registerScheduledTask({
    taskName: 'dsh-watchdog-1',
    startIso: '2026-10-29T18:00:00',
    endIso: '2026-10-29T18:10:00',
    command: 'node watchdog.mjs',
    xmlPath: 'C:\\state\\task.xml',
    exec,
    writeFile: (target, content) => written.push({ target, content }),
    removeFile: () => {},
  });
  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(calls, ['/Create', '/Query']);
  assert.equal(written.length, 1);
});

test('a task with another trigger is refused', () => {
  const exec = (file, args) => {
    if (args[0] === '/Create') return { ok: true, stdout: '', error: null };
    return { ok: true, stdout: '<Task><StartBoundary>2000-01-01T00:00:00</StartBoundary></Task>', error: null };
  };
  const result = registerScheduledTask({
    taskName: 'dsh-watchdog-1',
    startIso: '2026-10-29T18:00:00',
    endIso: '2026-10-29T18:10:00',
    command: 'node watchdog.mjs',
    xmlPath: 'C:\\state\\task.xml',
    exec,
    writeFile: () => {},
    removeFile: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /another trigger/);
});

test('the task is deleted completely', () => {
  const calls = [];
  const exec = (file, args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', error: null }; };
  const result = removeScheduledTask({ taskName: 'dsh-watchdog-1', exec });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['/Delete /TN dsh-watchdog-1 /F']);
});

test('the systemd unit is registered with the delay and the unit name', () => {
  const calls = [];
  const exec = (file, args) => { calls.push({ file, args }); return { ok: true, stdout: '', error: null }; };
  const result = registerSystemdRun({
    unitId: 'dsh-watchdog-1',
    delaySeconds: 30,
    command: ['node', 'watchdog.mjs'],
    exec,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, 'systemd-run');
  assert.ok(calls[0].args.includes('--on-active=30s'));
  assert.ok(calls[0].args.includes('--unit=dsh-watchdog-1'));
  assert.deepEqual(calls[0].args.slice(-2), ['node', 'watchdog.mjs']);
});

test('the background process is started, and it must really be alive', () => {
  const alive = [];
  const written = [];
  const exec = (file, args) => {
    if (file === 'sh') return { ok: true, stdout: '4242\n', error: null };
    return { ok: false, stdout: '', error: 'no' };
  };
  const result = registerDetachedProcess({
    delaySeconds: 30,
    command: 'node watchdog.mjs',
    pidPath: 'C:\\state\\watchdog.pid',
    exec,
    writeFile: (target, content) => written.push({ target, content }),
    isAlive: (pid) => { alive.push(pid); return true; },
  });
  assert.equal(result.ok, true, result.error || '');
  assert.equal(result.pid, 4242);
  assert.deepEqual(alive, [4242], 'the process is read back');
  assert.equal(written[0].target, 'C:\\state\\watchdog.pid');
});

test('a background process that died at once is not a watchdog', () => {
  const exec = (file, args) => {
    if (file === 'sh') return { ok: true, stdout: '4242\n', error: null };
    return { ok: false, stdout: '', error: 'no' };
  };
  const result = registerDetachedProcess({
    delaySeconds: 30,
    command: 'node watchdog.mjs',
    pidPath: 'C:\\state\\watchdog.pid',
    exec,
    writeFile: () => {},
    isAlive: () => false,
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not running/);
});

test('the local time of a moment is local (a task must not fire hours later)', () => {
  const iso = localIso(new Date(2026, 9, 29, 18, 5, 30));
  assert.equal(iso, '2026-10-29T18:05:30');
  assert.ok(!iso.includes('Z'), 'no UTC marker: the task XML wants local time');
});
