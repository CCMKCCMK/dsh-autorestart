/**
 * WHAT HAPPENED TO MY RESTART REQUEST? — the fate of the request, always recorded.
 *
 * THE REAL INCIDENT (hosted `dsh web` on WSL, port 5601): `POST /park` answered
 * `{ ok: true, pendingRestart: true, restartRequested: true }`, and afterwards
 * `state.restart` was `null`, the generation had not moved, `last-restart-verdict.json`
 * had no new record and the host had not been restarted. Four park calls, two
 * restarts — and for the other two, NOTHING said why.
 *
 * These tests pin the three rules of the fix:
 *
 *   1. a request that is postponed is NOT dropped (the deferral is a wait, not a
 *      cancellation) and the record says `deferred` with the reason;
 *   2. every way a request can be withdrawn leaves a record — reason, who, when —
 *      (`last-restart-request.json`), also readable after a reload;
 *   3. a boot no longer throws a request away that was never executed: it keeps
 *      it when it is fresh, and drops it (with a record) only when the earlier
 *      instance had really started it, or when it is stale.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  apply,
  buildRestartRequestRecord,
  createRuntime,
  decidePendingRestartOnBoot,
  normalizeConfig,
  readRestartRequestRecord,
  RESTART_REQUEST_STATES,
  restartRequestPath,
  settlePendingRestartOnBoot,
  summarizeRestartRequest,
  writeRestartRequestRecord,
} from '../index.js';
import { requestRestart } from '../lib/checkpoint.js';

// ---------------------------------------------------------------------------
// A plugin instance on a temporary state file, with the tools it registers.
// ---------------------------------------------------------------------------

function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-request-' + label + '-'));
  return { dir, file: path.join(dir, 'state.json') };
}

function createFakeContext({ runningAgents = [] } = {}) {
  const tools = []
  const listeners = new Map()
  const timeouts = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => undefined, warn: () => undefined, error: () => undefined }),
    fiber: { state: 2 },
    agents: {
      list: () => runningAgents,
      roots: () => runningAgents,
      get: (id) => runningAgents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    get: () => undefined,
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    provide: () => undefined,
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, timeouts, listeners }
}

/** Mount the plugin on a temporary state file. */
function mount(label, options = {}) {
  const { dir, file } = tempStateFile(label)
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, ...options })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart')
  assert.ok(restart, 'the continuum_restart tool must be registered')
  assert.ok(cancel, 'the continuum_cancel_restart tool must be registered')
  return { dir, file, fake, restart, cancel }
}

const readState = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------------------------------------------------------------------------
// 1. THE RECORD ITSELF
// ---------------------------------------------------------------------------

test('the record of a request carries the reason, who ended it and when', () => {
  const { dir } = tempStateFile('record');
  const now = Date.parse('2026-11-01T12:00:00Z');
  const record = buildRestartRequestRecord({
    result: RESTART_REQUEST_STATES.CANCELLED,
    reason: 'the boot settled this request',
    by: 'boot-recovery',
    restart: {
      generation: 7,
      requestedAt: now - 5000,
      attempt: 0,
      requesters: [{ sessionId: 'sess-a' }],
    },
    now,
    extra: { waitsForever: true },
  })

  assert.equal(record.result, 'cancelled')
  assert.equal(record.reason, 'the boot settled this request')
  assert.equal(record.by, 'boot-recovery')
  assert.equal(record.at, now);
  assert.match(String(record.atLocal), /^2026-11-01T/, 'the local time is the one the operator reads');
  assert.equal(record.generation, 7);
  assert.equal(record.waitedMs, 5000, 'how long the request had been alive is part of the record');
  assert.deepEqual(record.requesters, ['sess-a']);
  assert.equal(record.waitsForever, true);

  const written = writeRestartRequestRecord(dir, record);
  assert.equal(written.ok, true, written.error || '');
  const back = readRestartRequestRecord(dir);
  assert.equal(back.result, 'cancelled');
  assert.equal(back.by, 'boot-recovery');
  assert.equal(back.reason, 'the boot settled this request');
  // The file really is in the state directory under the documented name.
  assert.ok(fs.existsSync(path.join(dir, 'last-restart-request.json')), 'the record has its own file');
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0, 'no temporary file is left behind');
});

test('a missing state directory is an error, not a silent success', () => {
  const written = writeRestartRequestRecord('', { result: 'queued' });
  assert.equal(written.ok, false);
  assert.match(String(written.error), /state directory/);
});

test('the summary tells queued from deferred from cancelled', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const live = { generation: 3, requestedAt: now - 10000, requesters: [{ sessionId: 'sess-a' }] };

  const queued = summarizeRestartRequest({ restart: live, record: null, now });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.pending, true);
  assert.equal(queued.waitedMs, 10000);

  const deferredRecord = buildRestartRequestRecord({
    result: RESTART_REQUEST_STATES.DEFERRED,
    reason: 'the idle gate postponed the restart: conversation-active',
    by: 'idle-gate',
    restart: live,
    now: now - 5000,
    extra: { waitsForever: true },
  });
  const deferred = summarizeRestartRequest({ restart: live, record: deferredRecord, now });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.pending, true, 'a postponed request is STILL pending');
  assert.match(String(deferred.reason), /conversation-active/);
  assert.equal(deferred.deadlineInMs, undefined, 'there is no deadline to report any more');
  assert.equal(deferred.deadlineCutsTheRequest, undefined, 'and nothing claims to cut it');

  const cancelledRecord = buildRestartRequestRecord({
    result: RESTART_REQUEST_STATES.CANCELLED,
    reason: 'the last requester withdrew its restart request',
    by: 'tool:cancel-all',
    restart: live,
    now,
  });
  const cancelled = summarizeRestartRequest({ restart: null, record: cancelledRecord, now });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.pending, false);
  assert.equal(cancelled.by, 'tool:cancel-all');
  assert.match(String(cancelled.reason), /withdrew/);

  const none = summarizeRestartRequest({ restart: null, record: null, now });
  assert.equal(none.state, 'none');
});

// ---------------------------------------------------------------------------
// 2. A REQUEST THAT IS POSTPONED IS NOT DROPPED
// ---------------------------------------------------------------------------

test('a parked restart request is queued, not "done" — and the record says so', () => {
  const { dir, file, restart } = mount('queued');

  const answer = restart.execute({ reason: 'reload the plugin' }, { agent: { id: 'sess-a', status: 'running' } });

  assert.equal(answer.accepted, true);
  assert.equal(answer.restartRequest.state, 'queued', 'accepted means QUEUED, not restarted');
  assert.equal(answer.restartRequest.pending, true);
  assert.equal(answer.restartRequest.deadlineCutsTheRequest, undefined, 'no deadline field is exposed at all');

  const state = readState(file);
  assert.ok(state.restart, 'the request is in the checkpoint');
  assert.equal(state.generation, 1, 'the generation counts the REQUEST (the restart itself comes later)');

  const record = readRestartRequestRecord(dir);
  assert.ok(record, 'the record file exists');
  assert.equal(record.result, 'queued');
  assert.equal(record.by, 'tool:restart');
  assert.equal(record.generation, 1);
  assert.equal(record.requestedAt, state.restart.requestedAt);
  assert.equal(record.waitsForever, true, 'and the record says the wait has no end time');
});

test('a postponed request stays alive and its record says "deferred" with the reason', () => {
  const { dir, file } = tempStateFile('deferred');
  const runtime = createRuntime(createFakeContext().ctx, normalizeConfig({ stateFile: file }));
  requestRestart(runtime.state, { reason: 'reload', bySessionId: 'sess-a', now: Date.now() - 1000 });
  runtime.persist();

  // The gate postpones it (this is exactly what executeRestart does after a
  // conversation becomes active again).
  runtime.recordRestartRequestFate('deferred', {
    reason: 'a conversation became active right after the snapshot: conversation-active',
    by: 'idle-gate-after-snapshot',
  });

  const state = readState(file);
  assert.ok(state.restart, 'the postponed request is still in the checkpoint — a deferral is not a cancel');
  const record = readRestartRequestRecord(dir);
  assert.equal(record.result, 'deferred');
  assert.match(String(record.reason), /conversation-active/);
  assert.equal(record.by, 'idle-gate-after-snapshot');

  const summary = runtime.restartRequestInfo();
  assert.equal(summary.state, 'deferred');
  assert.equal(summary.pending, true, 'the summary says it is still pending');
  assert.equal(summary.deadlineAt, undefined, 'and the deadline is gone, not hidden');
  // NOT ONE deadline field survives in the state payload (user decision,
  // 2026-11-02): the three names that made everybody read "the request is void".
  const deadlineKeys = Object.keys(summary).filter((key) => /deadline/i.test(key));
  assert.deepEqual(deadlineKeys, [], 'the state payload has no deadline field at all');
  assert.equal(summary.waitsUntilIdle, true, 'and it says what it does instead: wait until idle');
});

// ---------------------------------------------------------------------------
// 3. EVERY CANCEL LEAVES A REASON
// ---------------------------------------------------------------------------

test('cancelling for everyone leaves a record with reason, who and when', () => {
  const { dir, file, restart, cancel } = mount('cancel-all');
  restart.execute({ reason: 'reload' }, { agent: { id: 'sess-a', status: 'running' } });

  const answer = cancel.execute({ scope: 'all', reason: 'nobody restarts any more' });

  assert.equal(answer.cancelled, true);
  const state = readState(file);
  assert.equal(state.restart, null, 'the request is gone');
  assert.equal(state.phase, 'idle');

  const record = readRestartRequestRecord(dir);
  assert.ok(record, 'the withdrawal is recorded — this is the silence the incident was about');
  assert.equal(record.result, 'cancelled');
  assert.equal(record.by, 'tool:cancel-all');
  assert.match(String(record.reason), /nobody restarts any more/);
  assert.ok(Number.isFinite(record.at) && Number.isFinite(record.requestedAt), 'both moments are in the record');
});

test('withdrawing my own last request leaves a record too', () => {
  const { dir, file, restart, cancel } = mount('cancel-mine');
  restart.execute({ reason: 'reload' }, { agent: { id: 'sess-a', status: 'running' } });

  const answer = cancel.execute({ reason: 'changed my mind' }, { agent: { id: 'sess-a', status: 'running' } });
  assert.equal(answer.cancelled, true);
  assert.equal(readState(file).restart, null);

  const record = readRestartRequestRecord(dir);
  assert.equal(record.result, 'cancelled');
  assert.equal(record.by, 'tool:cancel-mine');
  assert.match(String(record.reason), /changed my mind/);
  assert.deepEqual(record.requesters, ['sess-a'], 'the record names who had asked');
});

// ---------------------------------------------------------------------------
// 4. A BOOT DOES NOT THROW A QUEUED REQUEST AWAY
// ---------------------------------------------------------------------------

test('the boot decision: executed → settled, fresh and never executed → kept, stale → settled', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const fresh = { requestedAt: now - 60_000, attempt: 0 };
  const executed = { requestedAt: now - 60_000, attempt: 2 };
  const withSnapshot = { requestedAt: now - 60_000, attempt: 0, snapshot: { dir: 'x', bytes: 1 } };
  const stale = { requestedAt: now - 60 * 60 * 1000, attempt: 0 };

  assert.equal(decidePendingRestartOnBoot({ restart: null, now }).action, 'none');
  assert.equal(decidePendingRestartOnBoot({ restart: executed, now }).action, 'drop');
  assert.equal(decidePendingRestartOnBoot({ restart: executed, now }).why, 'consumed-by-boot');
  assert.equal(decidePendingRestartOnBoot({ restart: withSnapshot, now }).action, 'drop');
  assert.equal(decidePendingRestartOnBoot({ restart: fresh, now }).why, 'never-executed-and-fresh');
  assert.equal(decidePendingRestartOnBoot({ restart: fresh, now }).action, 'keep');
  assert.equal(decidePendingRestartOnBoot({ restart: stale, now }).action, 'drop');
  assert.equal(decidePendingRestartOnBoot({ restart: stale, now }).why, 'stale-never-executed');
});

test('a boot KEEPS a queued request that was never executed (it used to disappear here)', () => {
  const { dir, file } = tempStateFile('boot-keep');
  const runtime = createRuntime(createFakeContext().ctx, normalizeConfig({ stateFile: file }));
  requestRestart(runtime.state, { reason: 'queued just before the boot', bySessionId: 'sess-a', now: Date.now() - 1000 });
  runtime.persist();
  const before = readState(file).restart;
  assert.equal(before.attempt, 0, 'nothing was executed');
  assert.equal(before.snapshot, undefined, 'no snapshot was taken');

  const result = settlePendingRestartOnBoot(runtime);

  assert.equal(result.action, 'keep', 'the boot must not throw this request away');
  const after = readState(file).restart;
  assert.ok(after, 'the request survived the boot');
  assert.equal(after.requestedAt, before.requestedAt, 'it is the same request');
  const record = readRestartRequestRecord(dir);
  assert.equal(record.result, 'queued');
  assert.equal(record.by, 'boot-recovery');
  assert.match(String(record.reason), /never executed|survived a boot/);
});

test('a boot SETTLES a request the earlier instance had already started — with a record', () => {
  const { dir, file } = tempStateFile('boot-settled');
  const runtime = createRuntime(createFakeContext().ctx, normalizeConfig({ stateFile: file }));
  requestRestart(runtime.state, { reason: 'reload', bySessionId: 'sess-a', now: Date.now() - 1000 });
  runtime.state.restart.attempt = 1; // the old instance had begun executing it
  runtime.persist();

  const result = settlePendingRestartOnBoot(runtime);

  assert.equal(result.action, 'drop');
  assert.equal(result.why, 'consumed-by-boot');
  assert.equal(readState(file).restart, null, 'the consumed request is gone');
  const record = readRestartRequestRecord(dir);
  assert.equal(record.result, 'cancelled');
  assert.equal(record.by, 'boot-recovery');
  assert.match(String(record.reason), /consumed-by-boot/);
});

test('the record survives a reload: a withdrawal is readable by the next instance', () => {
  const { dir, file, restart, cancel } = mount('reload');
  restart.execute({ reason: 'reload' }, { agent: { id: 'sess-a', status: 'running' } });
  cancel.execute({ scope: 'all', reason: 'stopped by hand' });

  // A fresh runtime on the same state directory (that is what a reload is).
  const runtime = createRuntime(createFakeContext().ctx, normalizeConfig({ stateFile: file }));
  const summary = runtime.restartRequestInfo();
  assert.equal(summary.state, 'cancelled');
  assert.equal(summary.by, 'tool:cancel-all');
  assert.match(String(summary.reason), /stopped by hand/);
  assert.ok(fs.existsSync(restartRequestPath(dir)));
  assert.equal(readRestartRequestRecord(dir).result, 'cancelled');
});

test('the number of silent ways to drop a request is zero (the wiring itself)', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // Every drop goes through the choke point, which always records.
  assert.ok(source.includes('const dropRestartRequest = ('), 'the one choke point exists');
  assert.ok(source.includes('recordRestartRequestFate(RESTART_REQUEST_STATES.CANCELLED'), 'the choke point records the withdrawal');
  // The boot no longer clears the pending restart on its own.
  assert.equal(
    /if \(state\.restart\) cancelRestart\(state, \{ now: Date\.now\(\) \}\)/.test(source),
    false,
    'the boot must not cancel a pending restart without deciding (and recording) it',
  );
  assert.ok(source.includes('settlePendingRestartOnBoot(runtime)'), 'both recovery branches use the decision');
  // The park answer tells the truth about what was accepted.
  assert.ok(source.includes('restartRequest,'), 'the park answer carries the request summary');
  assert.ok(source.includes('lastRestartRequest: runtime.restartRequestOutcome()'), 'and the record of the last one');
});
