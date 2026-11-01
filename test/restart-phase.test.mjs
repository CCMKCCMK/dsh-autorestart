/**
 * THE FOUR STAGES OF A RESTART — the tests behind the report
 * "I clicked restart and nothing happened for ten seconds".
 *
 * The plan of this file follows the complaint, not the code:
 *
 *   1. the first stage is VISIBLE at once (well under a second, from the state
 *      file and from the state route);
 *   2. the snapshot phase reports the bytes that were really copied, and they
 *      only ever grow;
 *   3. a cancel during the snapshot stops the copy, removes the half-written
 *      backup and keeps the host alive;
 *   4. once the host is restarting a cancel is REFUSED, with the reason;
 *   5. a slow copy says so (five minutes, or a minute without a byte) instead of
 *      pretending to be busy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, createRuntime, normalizeConfig, takePreRestartSnapshot } from '../index.js';
import { backupStamp, createBackup, listBackups, markKnownGood } from '../lib/backup.js';
import { cancelRestart, createEmptyState, readState, requestRestart, setRestartPhase, writeState } from '../lib/checkpoint.js';
import {
  describeRestartPhase,
  SLOW_STALL_MS,
  SLOW_TOTAL_MS,
} from '../lib/restart-phase.js';

/** A temporary directory, removed when the test ends. */
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-phase-' + label + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  });
  return dir;
}

/** A profile with a plugin tree of `count` files (each `size` bytes). */
function makeProfile(root, { count = 60, size = 4096 } = {}) {
  const profile = path.join(root, 'profile');
  const modules = path.join(profile, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'plugins: []\n', 'utf8');
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(modules, 'plugin-' + index + '.js'), 'x'.repeat(size), 'utf8');
  }
  return profile;
}

/** The fake Cordis context: enough services for `apply()` to register routes. */
function fakeContext({ routes = [], tools = [] } = {}) {
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
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
      guard: () => () => {},
    },
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

/** A response object good enough for the JSON routes. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = String(body ?? '');
    },
  };
}

// (1) THE FIRST STAGE IS IMMEDIATE -------------------------------------------------

test('the click makes phase="waiting" readable at once (well under a second)', async (t) => {
  const dir = tempDir(t, 'waiting');
  const stateFile = path.join(dir, 'state.json');
  const routes = [];
  const tools = [];
  apply(fakeContext({ routes, tools }), { stateFile, enabled: true, recoveryDelayMs: 0 });

  const restartTool = tools.find((definition) => (definition.name || '').includes('restart'))
  assert.ok(restartTool, 'the restart tool is registered')

  const started = Date.now()
  restartTool.execute({ reason: 'the phase test', resume: true }, { agent: { id: 'sess-phase' } })
  const elapsed = Date.now() - started

  // The checkpoint on disk carries the stage: the interface polls the state
  // route, which reads exactly this file, so "on disk" IS "on screen".
  const read = readState(stateFile, Date.now())
  assert.equal(read.existed, true)
  assert.ok(read.state.restartPhase, 'the stage was written by the click itself')
  assert.equal(read.state.restartPhase.phase, 'waiting')
  assert.ok(elapsed < 1000, 'the stage was written in ' + elapsed + ' ms')

  // And the state route (the surface the pill polls) reports it the same way.
  const health = routes.find((route) => route.path === '/__dsh_autorestart/health')
  const response = fakeResponse()
  health.handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.restartPhase.phase, 'waiting')
  assert.equal(payload.restartPhase.cancellable, true)
  assert.equal(payload.restartPhase.cancelReason, null)
  assert.match(payload.restartPhase.text.zh, /正在等待所有会话空闲/)
  assert.match(payload.restartPhase.text.en, /Waiting for every conversation/)
})

// (2) THE PROGRESS IS REAL ---------------------------------------------------------

test('the snapshot reports the real bytes, and they only grow', async (t) => {
  const root = tempDir(t, 'progress');
  const profile = makeProfile(root)
  const backups = path.join(root, 'backups')
  const samples = []
  const result = await createBackup({ slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 1_700_000_000_000,
    onProgress: (progress) => samples.push({ ...progress }),
  })
  assert.equal(result.ok, true)
  assert.ok(samples.length >= 2, 'the copy reported progress ' + samples.length + ' time(s)')

  // The numbers are the files that really landed, not an animation.
  let previous = -1
  for (const sample of samples) {
    assert.ok(sample.bytes >= previous, 'the byte counter never went backwards (' + previous + ' -> ' + sample.bytes + ')')
    previous = sample.bytes
  }
  const last = samples[samples.length - 1]
  assert.ok(last.bytes > 0, 'some bytes were copied')
  assert.equal(last.bytes, result.bytes, 'the last report equals what the backup wrote')
  // The denominator was measured before the copy, so a percentage is honest.
  assert.ok(result.totalBytes >= result.bytes, 'the total is at least what was copied')
  assert.ok(result.fileCount >= 60, 'the plugin files were counted')
  assert.ok(last.total >= last.bytes)
})

// (3) A CANCEL DURING THE SNAPSHOT -------------------------------------------------

test('a cancel during the snapshot stops the copy and leaves no half-written backup', async (t) => {
  const root = tempDir(t, 'cancel');
  const profile = makeProfile(root, { count: 80 });
  const backups = path.join(root, 'backups');
  let copied = 0
  const result = await createBackup({ slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 1_700_000_000_100,
    onProgress: () => {
      copied += 1
    },
    // "The user pressed cancel" after the second progress report.
    shouldCancel: () => copied >= 2,
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.ok, false)
  // NOTHING is left behind: no half snapshot that looks restorable.
  assert.equal(result.dir, null)
  const leftovers = fs.existsSync(backups) ? listBackups(backups) : []
  assert.deepEqual(leftovers, [], 'no backup directory survived the cancel')
})

test('a cancelled snapshot never turns into a restart (the host stays up)', async (t) => {
  const root = tempDir(t, 'cancel-host');
  const profile = makeProfile(root, { count: 40 });
  const commands = []
  const stateFile = path.join(root, 'state.json')
  const ctx = fakeContext()
  const config = normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  })
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: false, appExePath: null },
    // The real snapshot entry, with a cancel that fires immediately: exactly
    // what a click in the middle of the copy looks like.
    snapshot: (options) => takePreRestartSnapshot({ ...options, profile: { dir: profile, source: 'test' }, shouldCancel: () => true }),
    runCommand: async ({ command }) => {
      commands.push(command)
      return { ok: true, command, exitCode: 0, timedOut: false }
    },
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  })
  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-cancel' })
  await runtime.executeRestart()

  assert.deepEqual(commands, [], 'the restart command was NOT run')
  assert.equal(runtime.state.restart, null, 'the cancelled request was withdrawn, not retried')
  assert.ok(!runtime.state.restartPhase, 'the stage was cleared (no spinner left behind)')
  // The checkpoint on disk agrees: nothing was left armed for a restart.
  const onDisk = readState(stateFile, Date.now())
  assert.equal(onDisk.state.restart, null)
  assert.equal(onDisk.state.restartPhase, null)
})

// (4) A CANCEL AFTER THE HOST IS GOING DOWN IS REFUSED -----------------------------

test('a cancel in the "restarting" stage is refused, with the reason', async (t) => {
  const dir = tempDir(t, 'refused');
  const stateFile = path.join(dir, 'state.json');
  // A checkpoint of THIS process (the boot therefore is not a new one).
  const state = createEmptyState(Date.now())
  state.bootPid = process.pid
  state.bootId = 'the-current-boot'
  writeState(stateFile, state)

  const routes = [];
  const runtime = apply(fakeContext({ routes }), { stateFile, enabled: true, recoveryDelayMs: 0 });
  // THE STAGE UNDER TEST BELONGS TO A RUNNING RESTART, so the RUNNING runtime
  // writes it. (Since 0.8.5 a 'restarting' stage found on disk at boot is reset
  // instead of being inherited — a stage must not outlive its action, which is
  // exactly the hang that was reported.)

  runtime.markRestartStage('restarting', { reason: 'test: restart under way' })

  const cancel = routes.find((route) => route.path === '/__dsh_autorestart/cancel')
  assert.ok(cancel, 'the cancel route is registered')
  const response = fakeResponse()
  const request = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    on: (event, handler) => {
      if (event === 'data') handler(JSON.stringify({ sessionId: 'sess-late', scope: 'mine' }))
      if (event === 'end') handler()
    },
  }
  cancel.handler(request, response)
  await new Promise((resolve) => { setTimeout(resolve, 50) })

  assert.equal(response.statusCode, 409, 'the refusal is an explicit 409, not a silent no')
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.cancelled, false)
  assert.equal(payload.reason, 'not-cancellable')
  assert.equal(payload.stage, 'restarting')
  assert.match(payload.error, /already restarting/)
})

// (5) A SLOW COPY SAYS SO ------------------------------------------------------------

test('a slow copy is reported as slow instead of pretending to be busy', () => {
  const startedAt = 1_700_000_000_000
  // Five minutes in, still copying.
  const slowTotal = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 900, bytes: 80 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + SLOW_TOTAL_MS - 5000 },
    now: startedAt + SLOW_TOTAL_MS,
  })
  assert.equal(slowTotal.slow, 'total')
  // The slow branch names the SAME subject as the card: it is the DSH pre-restart
  // backup that is slow, never a nameless "backup".
  assert.match(slowTotal.text.zh, /DSH 重启前备份比预期慢（可能磁盘很忙），还在继续/)
  assert.doesNotMatch(slowTotal.text.zh, /正在备份/, 'no bare "正在备份" in the slow line either')
  assert.match(slowTotal.text.en, /DSH pre-restart backup/)
  assert.match(slowTotal.text.en, /slower than expected/)

  // The byte counter has not moved for a minute.
  const stalled = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 10, bytes: 2 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + 2000 },
    now: startedAt + 2000 + SLOW_STALL_MS,
  })
  assert.equal(stalled.slow, 'stalled')
  assert.match(stalled.text.zh, /DSH 重启前备份比预期慢/)
  assert.doesNotMatch(stalled.text.zh, /正在备份/)

  // A healthy copy shows the measured bytes and an estimate — and no slow line.
  const healthy = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 400, bytes: 78 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + 9900 },
    now: startedAt + 10000,
  })
  assert.equal(healthy.slow, null)
  assert.equal(healthy.progress.percent, 50)
  // THE ONE VOICE: the settings page and the tooltip say what the card says —
  // "DSH 重启前备份中" — and never the nameless "正在备份".
  assert.match(healthy.text.zh, /DSH 重启前备份中/)
  assert.doesNotMatch(healthy.text.zh, /正在备份/)
  assert.match(healthy.text.zh, /已完成 78 MB/)
  assert.match(healthy.text.en, /Backing up before DSH restart/)
  assert.doesNotMatch(healthy.text.en, /configuration and the plugins/)
  assert.match(healthy.text.en, /78 MB done/)
  assert.ok(healthy.estimateSeconds !== null && healthy.estimateSeconds > 0)

  // Before the first measurement the text claims no number at all.
  const waiting = describeRestartPhase({ phase: 'snapshotting', startedAt, now: startedAt + 10 })
  assert.equal(waiting.progress, null)
  assert.equal(waiting.estimateSeconds, null)
  assert.doesNotMatch(waiting.text.zh, /预计/)
  assert.match(waiting.text.zh, /^DSH 重启前备份中…$/, 'the sentence says what it is, then stops')
  assert.doesNotMatch(waiting.text.zh, /正在备份/)
})

// (6) THE STAGE CANNOT OUTLIVE THE ACTION --------------------------------------------
//
// THE REPORT (user, 2026-10-29): a restart was postponed right after the copy
// (another conversation became active), the stage stayed 'snapshotting', and the
// centred card kept saying "DSH 重启前备份中" for ever. Three things must hold now:
//   a. 'snapshotting' exists only while files are copied;
//   b. every postponement writes 'waiting' (with the reason);
//   c. a stage left on disk is reset at boot instead of being inherited.

test('a copy that is followed by a refused restart goes back to waiting', async (t) => {
  const root = tempDir(t, 'deferred-after-copy');
  const profile = makeProfile(root, { count: 12 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const ctx = fakeContext();
  const config = normalizeConfig({
    stateFile,
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  });
  // What the stage was at the moments that matter: arming the watchdog happens
  // IMMEDIATELY after the copy, so 'snapshotting' must already be over there.
  //
  // THE WATCHDOG NEEDS A KNOWN-GOOD COPY (user decision, 2026-10-30): it restores
  // a state a boot has already proven, never the snapshot of this restart. The
  // runtime therefore only reaches `armWatchdog` when one exists - so the test
  // lays one down first, exactly the way `markKnownGood` marks it after a boot.
  const knownGoodDir = path.join(backups, backupStamp(Date.now() - 60 * 60 * 1000));
  fs.mkdirSync(path.join(knownGoodDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(knownGoodDir, 'config', 'cordis.patch.yml'), 'plugins: []\n', 'utf8');
  fs.writeFileSync(
    path.join(knownGoodDir, 'manifest.json'),
    JSON.stringify({ at: Date.now() - 60 * 60 * 1000, bytes: 12, files: ['cordis.patch.yml'], includePlugins: false }),
    'utf8',
  );
  // THE COPY HAS TO CARRY EVIDENCE NOW (2026-11-01): a promotion names WHAT was
  // checked. The fixture therefore certifies the copy by hand — the same thing a
  // real boot does once the call site passes its check result in.
  assert.equal(
    markKnownGood(knownGoodDir, { reason: 'test', certifiedBy: 'manual-rollback' }).promoted,
    true,
    'the test copy is marked known-good',
  );
  const stageWhenArming = [];
  let copyFinished = 0;
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: true, appExePath: 'C:\\fake\\DeepSeek Harness.exe' },
    snapshot: async () => {
      copyFinished += 1;
      return { ok: true, backup: { ok: true, dir: backups }, profileDir: profile, files: 12, bytes: 40 * 1024, total: 40 * 1024 };
    },
    armWatchdog: () => {
      stageWhenArming.push(runtime.restartStageInfo().phase);
      return { ok: false, tier: 'none', reason: 'the test arms nothing' };
    },
    // The detached helper refuses because a conversation is active again.
    // (Scheduled SYNCHRONOUSLY by the runtime, so the result must not be a promise.)
    scheduleDetached: () => ({ ok: false, error: 'the idle gate denied the restart' }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-deferred' });
  await runtime.executeRestart();

  assert.equal(copyFinished, 1, 'the copy really ran');
  assert.deepEqual(stageWhenArming, ['restarting'], 'the stage left snapshotting the moment the copy returned');
  const stage = runtime.restartStageInfo();
  assert.equal(stage.phase, 'waiting', 'the postponed restart is back to waiting, not snapshotting');
  assert.match(String(stage.reason), /^deferred: /, 'and it says why');
  assert.equal(runtime.state.phase, 'deferred');
  // The checkpoint on disk agrees — this is what the interface reads.
  const onDisk = readState(stateFile, Date.now());
  assert.equal(onDisk.state.restartPhase.phase, 'waiting');
  assert.notEqual(onDisk.state.restartPhase.phase, 'snapshotting');
});

test('a conversation that becomes active while the helper waits sends the stage back to waiting', async (t) => {
  const root = tempDir(t, 'gate-denied');
  const profile = makeProfile(root, { count: 6 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const timers = [];
  const ctx = fakeContext();
  // The gate watchdog is the ONLY ctx.timeout of a runtime that was not applied,
  // so capturing it is exactly the "the helper did not kill us" signal.
  ctx.timeout = (fn) => {
    timers.push(fn);
    return () => {};
  };
  const config = normalizeConfig({
    stateFile,
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  });
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: true, appExePath: 'C:\\fake\\DeepSeek Harness.exe' },
    snapshot: async () => ({ ok: true, backup: { ok: true, dir: backups }, profileDir: profile, files: 6, bytes: 20 * 1024, total: 20 * 1024 }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    scheduleDetached: () => ({ ok: true, pid: 1234 }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-gate' });
  await runtime.executeRestart();

  assert.equal(runtime.restartStageInfo().phase, 'restarting', 'the host is on its way out');
  assert.equal(timers.length, 1, 'the gate watchdog was armed');

  // A conversation became active at the last moment: the helper refused to kill
  // this process, so the restart is postponed right here.
  timers[0]();

  const stage = runtime.restartStageInfo();
  assert.equal(stage.phase, 'waiting', 'the stage went back to waiting instead of hanging');
  assert.match(String(stage.reason), /^deferred: /);
  assert.equal(runtime.state.phase, 'deferred');
  // …and what the interface reads is the same thing.
  assert.equal(runtime.restartStageBrief().phase, 'waiting');
  assert.match(String(runtime.restartStageBrief().reason), /gate/);
});

test('a stage left on disk does not survive into the next process', async (t) => {
  const dir = tempDir(t, 'stale-boot');
  const stateFile = path.join(dir, 'state.json');
  const state = createEmptyState(Date.now());
  // ANOTHER process wrote this stage and then died before it could end it.
  state.bootPid = 424242;
  state.bootId = 'the-process-that-died';
  setRestartPhase(state, { phase: 'snapshotting', now: Date.now() });
  writeState(stateFile, state);

  const runtime = apply(fakeContext(), { stateFile, enabled: true, recoveryDelayMs: 0 });

  // A new process is up and nothing is copied here: never 'snapshotting'.
  assert.notEqual(runtime.restartStageInfo().phase, 'snapshotting');
  assert.ok(
    runtime.restartStageInfo().phase === 'back' || runtime.restartStageInfo().phase === 'waiting',
    `a boot rewrites the leftover stage, got ${runtime.restartStageInfo().phase}`,
  );
});

test('a stage left by the same process is reset on a plugin reload', async (t) => {
  const dir = tempDir(t, 'stale-reload');
  const stateFile = path.join(dir, 'state.json');
  const state = createEmptyState(Date.now());
  state.bootPid = process.pid;
  state.bootId = 'the-current-boot';
  setRestartPhase(state, { phase: 'restarting', now: Date.now() });
  writeState(stateFile, state);

  const runtime = apply(fakeContext(), { stateFile, enabled: true, recoveryDelayMs: 0 });

  assert.equal(runtime.restartStageInfo().phase, 'waiting', 'the reload does not inherit the stage');
  assert.match(String(runtime.restartStageInfo().reason), /^boot: /);
});

// (7) A RESTART THAT IS NOT HAPPENING MAY NOT BE CALLED "restarting" --------------
//
// THE REPORT (user, 2026-10-30, with a screenshot): after the backup the card said
// "正在重启…" for 25 s while nothing was restarting — the helper was still waiting
// for its own idle re-check. 'restarting' may only mean "the kill is under way".

test('a conversation that starts right after the copy postpones the restart in the same tick', async (t) => {
  const root = tempDir(t, 'busy-after-copy');
  const profile = makeProfile(root, { count: 8 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const commands = [];
  // The agents the gate sees: empty at the click, busy the moment the copy starts
  // (which is exactly "another conversation began during the backup").
  const agents = [];
  const ctx = fakeContext();
  ctx.agents.list = () => agents.map((id) => ({ id, status: 'running' }));
  const config = normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  });
  const stageWhenArming = [];
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: async () => {
      // A conversation became active WHILE the files were copied.
      agents.push('sess-arrived-during-copy');
      return { ok: true, backup: { ok: true, dir: backups }, profileDir: profile, files: 8, bytes: 30 * 1024, total: 30 * 1024 };
    },
    runCommand: async ({ command }) => {
      commands.push(command);
      return { ok: true, command, exitCode: 0, timedOut: false };
    },
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => {
      stageWhenArming.push(runtime.restartStageInfo().phase);
      return { ok: false, tier: 'none', reason: 'the test arms nothing' };
    },
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-busy' });
  await runtime.executeRestart();

  // NOT ONE TICK of "restarting": the gate is re-checked the moment the copy ends.
  assert.deepEqual(commands, [], 'the restart command was never run');
  assert.deepEqual(stageWhenArming, [], 'the watchdog was never armed');
  const stage = runtime.restartStageInfo();
  assert.equal(stage.phase, 'waiting', 'the stage is waiting, not restarting');
  assert.match(String(stage.reason), /^deferred: conversation-active after snapshot/);
  assert.equal(runtime.state.phase, 'deferred');
  // The interface reads the same thing off the wire.
  assert.equal(runtime.restartStageBrief().phase, 'waiting');
});

test('a conversation that starts while the kill is being carried out degrades within 500 ms', async (t) => {
  const root = tempDir(t, 'busy-while-restarting');
  const profile = makeProfile(root, { count: 5 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const agents = [];
  const intervals = [];
  const ctx = fakeContext();
  ctx.agents.list = () => agents.map((id) => ({ id, status: 'running' }));
  // The re-check of the idle gate is an interval: capture it (and its period).
  ctx.interval = (fn, ms) => {
    intervals.push({ fn, ms });
    return () => {};
  };
  const config = normalizeConfig({
    stateFile,
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  });
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: true, appExePath: 'C:\\fake\\DeepSeek Harness.exe' },
    snapshot: async () => ({ ok: true, backup: { ok: true, dir: backups }, profileDir: profile, files: 5, bytes: 20 * 1024, total: 20 * 1024 }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    scheduleDetached: () => ({ ok: true, pid: 4321 }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-restarting' });
  await runtime.executeRestart();
  assert.equal(runtime.restartStageInfo().phase, 'restarting', 'the host is on its way out');

  // The idle gate is watched while the helper waits — 300–500 ms is the window.
  const watch = intervals.find((entry) => entry.ms >= 300 && entry.ms <= 500);
  assert.ok(watch, `the gate is re-checked every 300–500 ms, saw ${intervals.map((e) => e.ms).join('/')}`);

  // …and a conversation starts right then.
  agents.push('sess-arrived-while-restarting');
  watch.fn();

  const stage = runtime.restartStageInfo();
  assert.equal(stage.phase, 'waiting', 'the false "restarting" is withdrawn at once');
  assert.match(String(stage.reason), /^deferred: conversation-active while restarting/);
  assert.equal(runtime.state.phase, 'deferred', 'the retry is scheduled again');
});

// (8) ONE REQUEST, ONE SNAPSHOT ------------------------------------------------------
//
// THE REPORT (user, 2026-10-30): the copy finished, a conversation postponed the
// restart, and the retry copied the whole 205 MB again. The snapshot is the
// rollback point of THIS restart and does not expire while the restart waits.

/** A runtime whose snapshot really writes a backup into `<root>/backups`. */
function makeReuseRuntime(t, { root, profile, stateFile, backups, agents, counter }) {
  const ctx = fakeContext();
  ctx.agents.list = () => agents.map((id) => ({ id, status: 'running' }));
  const config = normalizeConfig({
    stateFile,
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  });
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: true, appExePath: 'C:\\fake\\DeepSeek Harness.exe' },
    snapshot: async ({ onProgress }) => {
      counter.copies += 1;
      const backup = await createBackup({ slimBackup: false,
        profileDir: profile,
        backupsDir: backups,
        includePlugins: true,
        now: 1_700_000_000_000 + counter.copies * 1000,
      });
      if (typeof onProgress === 'function') onProgress({ files: backup.fileCount, bytes: backup.bytes, total: backup.totalBytes });
      // A conversation starts WHILE the files are copied: the restart will be
      // postponed right after the copy.
      agents.push('sess-arrived-during-copy-' + counter.copies);
      return { backup, profileDir: profile, profile: { dir: profile, source: 'test' }, requested: true, durationMs: 0, error: null };
    },
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    scheduleDetached: () => ({ ok: true, pid: 4242 }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  });
  return runtime;
}

test('a postponed restart reuses the snapshot it already took (no second copy)', async (t) => {
  const root = tempDir(t, 'reuse-snapshot');
  const profile = makeProfile(root, { count: 8 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const agents = [];
  const counter = { copies: 0 };
  const runtime = makeReuseRuntime(t, { root, profile, stateFile, backups, agents, counter });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-reuse' });
  await runtime.executeRestart();
  assert.equal(counter.copies, 1, 'the first attempt copied the profile');
  const firstSnapshot = runtime.state.restart && runtime.state.restart.snapshot;
  assert.ok(firstSnapshot && typeof firstSnapshot.dir === 'string', 'the snapshot of this request is remembered');
  assert.equal(runtime.restartStageInfo().phase, 'waiting', 'the restart was postponed after the copy');
  const bytesAfterDeferral = runtime.restartStageInfo().snapshotBytes;
  assert.equal(bytesAfterDeferral, firstSnapshot.bytes, 'the stage keeps the size of that snapshot');

  // The conversation ends: the retry must NOT copy again.
  agents.length = 0;
  await runtime.executeRestart();
  assert.equal(counter.copies, 1, 'the retry did not copy the profile a second time');
  assert.equal(listBackups(backups).length, 1, 'no second snapshot directory was produced');
  assert.equal(runtime.restartStageInfo().snapshotBytes, bytesAfterDeferral, 'and the size did not change');
  const stage = runtime.restartStageInfo();
  assert.ok(stage.phase === 'restarting' || stage.phase === 'waiting', `the retry went on, got ${stage.phase}`);
});

test('after the request is withdrawn, the next restart copies again', async (t) => {
  const root = tempDir(t, 'reuse-cancel');
  const profile = makeProfile(root, { count: 5 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const agents = [];
  const counter = { copies: 0 };
  const runtime = makeReuseRuntime(t, { root, profile, stateFile, backups, agents, counter });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-cancel' });
  await runtime.executeRestart();
  assert.equal(counter.copies, 1);

  // The user calls the pending restart off.
  cancelRestart(runtime.state, { now: Date.now() });
  assert.equal(runtime.state.restart, null, 'the request is gone');
  assert.equal(listBackups(backups).length, 1, 'the snapshot of the withdrawn request stays on disk');

  // A NEW request starts from scratch: nothing of the old one is reused.
  agents.length = 0;
  requestRestart(runtime.state, { reason: 'phase test again', bySessionId: 'sess-cancel' });
  await runtime.executeRestart();
  assert.equal(counter.copies, 2, 'the new request copied the profile again');
});

test('a snapshot directory that disappeared is not reused', async (t) => {
  const root = tempDir(t, 'reuse-deleted');
  const profile = makeProfile(root, { count: 5 });
  const stateFile = path.join(root, 'state.json');
  const backups = path.join(root, 'backups');
  const agents = [];
  const counter = { copies: 0 };
  const runtime = makeReuseRuntime(t, { root, profile, stateFile, backups, agents, counter });

  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-deleted' });
  await runtime.executeRestart();
  assert.equal(counter.copies, 1);
  const saved = runtime.state.restart.snapshot;
  fs.rmSync(saved.dir, { recursive: true, force: true });

  agents.length = 0;
  await runtime.executeRestart();
  assert.equal(counter.copies, 2, 'the missing directory forced a fresh copy');
});
