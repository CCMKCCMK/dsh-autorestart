// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STATE_VERSION,
  beginBoot,
  cancelRestart,
  clearSession,
  createEmptyState,
  entryFor,
  markIdle,
  markPendingResume,
  markRunning,
  normalizeState,
  pruneSessions,
  readState,
  recoverableSessions,
  requestRestart,
  setDisarmedGoal,
  setGoal,
  setPhase,
  writeState,
} from '../lib/checkpoint.js';
import { PHASES } from '../lib/lifecycle.js';

const T = 1_700_000_000_000;

/** Create an isolated temp dir cleaned up when the test ends. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-ckpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('createEmptyState has the documented defaults', () => {
  const now = 12345;
  const state = createEmptyState(now);
  assert.deepEqual(state, {
    version: STATE_VERSION,
    bootId: null,
    bootPid: null,
    bootStartedAt: null,
    generation: 0,
    phase: 'idle',
    // Which stage of a restart is on screen (null: none under way).
    restartPhase: null,
    restart: null,
    sessions: {},
    seenFeatureVersions: {},
    onboarding: null,
    sleep: null,
    // 2026-11-03 (t72/t73): the profile directory this host booted with, as a
    // FACT. The key was added by the fix, so THIS expectation follows the
    // change - it is not a regression.
    profileDir: null,
    updatedAt: now,
  });
});

test('writeState/readState round-trips and leaves no temp file behind', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'deeper', 'state.json');
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', goalId: 'goal-1', goalRevision: 7, reason: 'turn-start', now: T });

  writeState(file, state, T + 5);
  assert.equal(state.updatedAt, T + 5);
  assert.equal(fs.existsSync(file), true);

  const read = readState(file, T + 10);
  assert.equal(read.existed, true);
  assert.equal(read.corrupt, false);
  assert.equal(read.error, null);
  assert.equal(read.repaired, false);
  assert.equal(read.state.updatedAt, T + 5);
  assert.equal(read.state.sessions.s1.running, true);
  assert.equal(read.state.sessions.s1.runningSince, T);
  assert.deepEqual(read.state.sessions.s1.goal, {
    goalId: 'goal-1',
    goalRevision: 7,
    phase: null,
    updatedAt: T,
  });

  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('a missing state file reads as a fresh state, never throws', (t) => {
  const dir = tempDir(t);
  const read = readState(path.join(dir, 'does-not-exist.json'), T);
  assert.equal(read.existed, false);
  assert.equal(read.corrupt, false);
  assert.equal(read.error, null);
  assert.equal(read.repaired, false);
  assert.deepEqual(read.state, createEmptyState(T));
});

test('a corrupt state file reads as a fresh state and reports corrupt:true', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"version":1, "sessions": {', 'utf8');

  const read = readState(file, T);
  assert.equal(read.existed, true);
  assert.equal(read.corrupt, true);
  assert.equal(typeof read.error, 'string');
  assert.ok(read.error.length > 0);
  assert.deepEqual(read.state, createEmptyState(T));
  assert.equal(read.state.version, STATE_VERSION);
});

test('an empty state file is reported corrupt, not fatal', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '', 'utf8');
  const read = readState(file, T);
  assert.equal(read.existed, true);
  assert.equal(read.corrupt, true);
  assert.equal(read.state.phase, 'idle');
});

test('a failed atomic write throws and cleans up its temp file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('simulated EACCES on rename');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(() => writeState(file, createEmptyState(T), T), /simulated EACCES/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(fs.existsSync(file), false);
});

test('normalizeState repairs unknown JSON and wrong-typed fields', () => {
  const fresh = normalizeState(null, T);
  assert.equal(fresh.repaired, true);
  assert.deepEqual(fresh.state, createEmptyState(T));

  assert.equal(normalizeState('nope', T).repaired, true);
  assert.equal(normalizeState(42, T).repaired, true);
  assert.equal(normalizeState([], T).repaired, true);
  assert.equal(normalizeState(undefined, T).repaired, false);

  const raw = {
    version: 999,
    bootId: 12,
    bootPid: 'not-a-pid',
    bootStartedAt: 'yesterday',
    generation: -2,
    phase: 'bogus-phase',
    updatedAt: 'soon',
    unknownTopLevel: true,
    restart: { requestedAt: 'late', attempt: -1, weird: 1 },
    sessions: {
      s1: {
        running: 'yes',
        pendingResume: 1,
        updatedAt: 'x',
        reasons: 'nope',
        resumeAttempts: 1.7,
        goal: { goalId: 5, phase: 3, random: true },
        surplus: true,
      },
      s2: 'not-an-entry',
    },
  };

  const normalized = normalizeState(raw, T);
  assert.equal(normalized.repaired, true);
  const { state } = normalized;
  assert.equal(state.version, STATE_VERSION);
  assert.equal(state.bootId, null);
  assert.equal(state.bootPid, null);
  assert.equal(state.bootStartedAt, null);
  assert.equal(state.generation, 0);
  assert.equal(state.phase, 'idle');
  assert.equal(state.updatedAt, T);
  assert.equal(state.restart.generation, 0);
  assert.equal(state.restart.requestedAt, 0);
  assert.equal(state.restart.attempt, 0);
  assert.equal(state.restart.resume, true);
  assert.equal('weird' in state.restart, false);
  assert.equal(state.sessions.s1.running, false);
  assert.equal(state.sessions.s1.pendingResume, false);
  assert.equal(state.sessions.s1.updatedAt, T);
  assert.deepEqual(state.sessions.s1.reasons, []);
  assert.equal(state.sessions.s1.resumeAttempts, 1);
  assert.equal(state.sessions.s1.goal, null);
  assert.equal('surplus' in state.sessions.s1, false);
  assert.equal(state.sessions.s2.running, false);
});

test('normalizeState leaves a valid state untouched (repaired:false)', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', goalId: 'g', now: T });
  markPendingResume(state, { sessionId: 's2', reason: 'interrupted', now: T });
  requestRestart(state, { reason: 'manual', bySessionId: 's1', now: T + 1 });

  const normalized = normalizeState(JSON.parse(JSON.stringify(state)), T);
  assert.equal(normalized.repaired, false);
  assert.deepEqual(normalized.state, state);
});

test('beginBoot converts stale running sessions into pendingResume', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', reason: 'turn-start', now: T });
  markIdle(state, 's2', { now: T });

  const result = beginBoot(state, { pid: 1111, now: T + 100 });
  assert.equal(result.isNewBoot, true);
  assert.equal(state.bootPid, 1111);
  assert.equal(state.bootStartedAt, T + 100);
  assert.match(state.bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const entry = state.sessions.s1;
  assert.equal(entry.running, false);
  assert.equal(entry.runningSince, null);
  assert.equal(entry.interrupted, true);
  assert.equal(entry.interruptedAt, T + 100);
  assert.equal(entry.pendingResume, true);
  assert.equal(entry.pendingSince, T + 100);
  assert.equal(entry.updatedAt, T + 100);
});

test('beginBoot with the same pid is not a new boot', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', now: T });
  beginBoot(state, { pid: 2222, now: T + 100 });
  const bootId = state.bootId;
  const running = state.sessions.s1.running;

  const again = beginBoot(state, { pid: 2222, now: T + 999 });
  assert.equal(again.isNewBoot, false);
  assert.equal(state.bootId, bootId);
  assert.equal(state.bootStartedAt, T + 100);
  assert.equal(state.sessions.s1.running, running);
});

test('requestRestart bumps generation, defers, and marks bySessionId pending', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', goalId: 'g1', goalRevision: 3, now: T });

  requestRestart(state, { reason: 'user asked for restart', bySessionId: 's1', now: T + 50 });
  assert.equal(state.generation, 1);
  assert.equal(state.phase, 'deferred');
  assert.deepEqual(state.restart, {
    generation: 1,
    requestedAt: T + 50,
    reason: 'user asked for restart',
    bySessionId: 's1',
    resume: true,
    attempt: 0,
    softWarned: false,
    failedAttempts: 0,
    notBefore: 0,
    requesters: [
      { sessionId: 's1', requestedAt: T + 50, reason: 'user asked for restart', resume: true },
    ],
    parkGoals: true,
    // A restart takes its pre-restart snapshot unless the request says not to;
    // the fact is stored, so it is asserted here (user decision, 2026-11-02).
    skipBackup: false,
  });
  assert.equal(state.sessions.s1.running, false);
  assert.equal(state.sessions.s1.pendingResume, true);
  assert.equal(state.sessions.s1.resumeAttempts, 0);
  assert.deepEqual(state.sessions.s1.goal.goalId, 'g1');

  requestRestart(state, { reason: 'again', now: T + 60 });
  assert.equal(state.generation, 2);
  assert.equal(state.restart.generation, 2);

  cancelRestart(state, { now: T + 70 });
  assert.equal(state.restart, null);
  assert.equal(state.phase, 'idle');
  assert.equal(state.updatedAt, T + 70);
});

test('requestRestart with resume:false does not touch the session', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', now: T });
  requestRestart(state, { reason: 'quiet', bySessionId: 's1', resume: false, now: T + 1 });
  assert.equal(state.restart.resume, false);
  assert.equal(state.sessions.s1.running, true);
  assert.equal(state.sessions.s1.pendingResume, false);
});

test('markIdle drops entries without a goal or pending resume', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 'plain', reason: 'turn', now: T });
  markIdle(state, 'plain', { now: T + 10 });
  assert.equal('plain' in state.sessions, false);

  markRunning(state, { sessionId: 'goal', goalId: 'g1', now: T });
  markIdle(state, 'goal', { now: T + 10 });
  assert.equal(state.sessions.goal.running, false);
  assert.equal(state.sessions.goal.runningSince, null);

  markRunning(state, { sessionId: 'pending', now: T });
  markPendingResume(state, { sessionId: 'pending', reason: 'interrupted', now: T + 5 });
  markIdle(state, 'pending', { now: T + 10 });
  assert.equal(state.sessions.pending.pendingResume, true);

  assert.equal(markIdle(state, 'missing', { now: T }), state);
});

test('setGoal, setPhase, clearSession and entryFor behave', () => {
  const state = createEmptyState(T);
  const entry = entryFor(state, 's1');
  assert.deepEqual(Object.keys(entry).sort(), [
    'goal',
    'interrupted',
    'interruptedAt',
    'lastRecoveryAction',
    'lastRecoveryDetail',
    'lastResumeAt',
    'lastResumeError',
    'pendingResume',
    'pendingSince',
    'reasons',
    'resumeAttempts',
    'running',
    'runningSince',
    'sessionId',
    'updatedAt',
  ]);
  assert.equal(entry.lastResumeError, null, 'a fresh entry carries no resume error yet');
  assert.equal(entryFor(state, 's1'), entry);

  setGoal(state, 's1', { goalId: 'g1', goalRevision: 2, phase: 'active', now: T + 1 });
  assert.deepEqual(state.sessions.s1.goal, { goalId: 'g1', goalRevision: 2, phase: 'active', updatedAt: T + 1 });
  setGoal(state, 's1', { now: T + 2 });
  assert.equal(state.sessions.s1.goal, null);

  setPhase(state, 'bogus');
  assert.equal(state.phase, 'idle');
  setPhase(state, 'running');
  assert.equal(state.phase, 'running');
  for (const phase of PHASES) assert.equal(setPhase(state, phase).phase, phase);

  clearSession(state, 's1');
  assert.equal('s1' in state.sessions, false);
  assert.equal(clearSession(state, 's1'), state);
});

test('recoverableSessions returns running/pending entries newest first, capped', () => {
  const state = createEmptyState(T);
  state.sessions = {
    old: { ...entryFor(createEmptyState(T), 'old'), running: true, updatedAt: T + 10 },
    newer: { ...entryFor(createEmptyState(T), 'newer'), pendingResume: true, updatedAt: T + 30 },
    idle: { ...entryFor(createEmptyState(T), 'idle'), updatedAt: T + 40 },
    done: {
      ...entryFor(createEmptyState(T), 'done'),
      pendingResume: true,
      updatedAt: T + 50,
      done: true,
    },
    // A COMPLETE goal no longer means "session done": an interrupted turn still
    // deserves its continuation message.
    completedGoal: {
      ...entryFor(createEmptyState(T), 'completedGoal'),
      pendingResume: true,
      updatedAt: T + 60,
      goal: { goalId: 'g', goalRevision: 1, phase: 'complete', updatedAt: T },
    },
  };

  const all = recoverableSessions(state, {});
  assert.deepEqual(all.map((entry) => entry.sessionId), ['completedGoal', 'newer', 'old']);
  assert.deepEqual(recoverableSessions(state, { limit: 1 }).map((entry) => entry.sessionId), ['completedGoal']);
  assert.deepEqual(recoverableSessions(state, { limit: 0 }), []);
});

test('pruneSessions caps the map by updatedAt, keeping the newest', () => {
  const state = createEmptyState(T);
  for (let index = 1; index <= 5; index += 1) {
    state.sessions[`s${index}`] = {
      ...entryFor(createEmptyState(T), `s${index}`),
      updatedAt: T + index,
    };
  }
  pruneSessions(state, { maxSessions: 2, now: T + 100 });
  assert.deepEqual(Object.keys(state.sessions).sort(), ['s4', 's5']);
});

test('pruneSessions drops stale finished entries by age but keeps active ones', () => {
  const state = createEmptyState(T);
  state.sessions.stale = { ...entryFor(createEmptyState(T), 'stale'), updatedAt: T - 1000 };
  state.sessions.active = {
    ...entryFor(createEmptyState(T), 'active'),
    running: true,
    updatedAt: T - 5000,
  };
  state.sessions.fresh = { ...entryFor(createEmptyState(T), 'fresh'), updatedAt: T };

  pruneSessions(state, { now: T, maxAgeMs: 100 });
  assert.deepEqual(Object.keys(state.sessions).sort(), ['active', 'fresh']);
});

/* ------------------------------------------------------------------ *
 * WHAT A RELOAD MUST NOT THROW AWAY (2026-11-02).
 *
 * `normalizeState` rebuilds the document from a whitelist, so a field the
 * plugin WRITES but the whitelist does not know is silently dropped on the next
 * boot — the record exists, but the answer cannot be read any more. That is
 * exactly what happened to `disarmedGoals[sid].reason` (written since the
 * restart-queued disarm, and reported as 0 hits in a real state.json).
 * ------------------------------------------------------------------ */

test('the reason a goal was disarmed survives a reload, and nothing is "repaired"', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const state = createEmptyState(T);
  setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: T });
  // Exactly what the write side does after `setDisarmedGoal`.
  state.disarmedGoals['sess-goal'].reason = 'restart-queued';
  writeState(file, state, T);

  const read = readState(file, T + 10);
  const record = read.state.disarmedGoals['sess-goal'];
  assert.ok(record, 'the record itself is still there');
  assert.equal(record.goalId, 'goal-1');
  assert.equal(record.disarmedAt, T);
  assert.equal(
    record.reason,
    'restart-queued',
    'WHY the goal was disarmed is still readable after a reload',
  );
  assert.equal(read.repaired, false, 'a known field must not mark the whole state as repaired');
  assert.equal(read.corrupt, false);
});

test('a record from before the reason existed still loads (no forced migration)', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const legacy = {
    ...createEmptyState(T),
    disarmedGoals: { 'sess-old': { goalId: 'goal-0', disarmedAt: T, resumedAt: null } },
  };
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');

  const read = readState(file, T + 10);
  const record = read.state.disarmedGoals['sess-old'];
  assert.equal(record.goalId, 'goal-0');
  assert.equal(record.reason, null, 'a record with no reason is readable and has no reason');
  assert.equal(read.repaired, false, 'an older record is still a valid record');
});

test('a truly unknown field is still dropped (the whitelist was not widened blindly)', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const dirty = {
    ...createEmptyState(T),
    disarmedGoals: {
      'sess-goal': { goalId: 'goal-1', disarmedAt: T, reason: 'restart-queued', hacker: 'nope' },
    },
  };
  fs.writeFileSync(file, JSON.stringify(dirty), 'utf8');

  const read = readState(file, T + 10);
  const record = read.state.disarmedGoals['sess-goal'];
  assert.equal(record.reason, 'restart-queued', 'the known field is kept');
  assert.equal('hacker' in record, false, 'the unknown field is gone');
  assert.equal(read.repaired, true, 'and dropping it is honestly reported as a repair');
});

test('a reason that is not a string is dropped, and that IS a repair', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const broken = {
    ...createEmptyState(T),
    disarmedGoals: { 'sess-goal': { goalId: 'goal-1', disarmedAt: T, reason: 42 } },
  };
  fs.writeFileSync(file, JSON.stringify(broken), 'utf8');

  const read = readState(file, T + 10);
  const record = read.state.disarmedGoals['sess-goal'];
  assert.equal(record.goalId, 'goal-1', 'the rest of the record survives');
  assert.equal(record.reason, null, 'an unreadable reason is not passed on as if it were one');
  assert.equal(read.repaired, true);
});

// ---------------------------------------------------------------------------
// ② THE BOOT-TIME REPORTS SURVIVE A RESTART (2026-11-02).
//
// The Host writes watcherHygiene (the sweep of leftover watcher scripts) and
// restartGate (why the restart was or was not allowed) at boot. The whitelist
// used to refuse both, so the next boot threw the answers away: the record
// existed but could not be read. Unknown fields are STILL dropped.
// ---------------------------------------------------------------------------

test('watcherHygiene and restartGate are read back after a restart, without a repair', () => {
  const raw = {
    version: STATE_VERSION,
    updatedAt: 1_700_000_000_000,
    watcherHygiene: {
      skipped: false,
      reason: null,
      removed: ['restart-watch-1.ps1', 'restart-watch-2.ps1'],
      kept: [],
      scanned: 4,
      error: null,
    },
    restartGate: {
      allow: false,
      reason: 'conversation-active',
      blockedBy: [{ sessionId: 'session-a', reason: 'goal-active' }],
      quietForMs: 1200,
    },
  }
  const { state, repaired } = normalizeState(raw, 1_700_000_000_000)

  assert.equal(repaired, false, 'a well-formed record is not "repaired"')
  assert.deepEqual(state.watcherHygiene.removed, ['restart-watch-1.ps1', 'restart-watch-2.ps1'],
    'the sweep names the files it removed')
  assert.equal(state.watcherHygiene.scanned, 4)
  assert.equal(state.restartGate.allow, false)
  assert.equal(state.restartGate.reason, 'conversation-active')
  assert.deepEqual(state.restartGate.blockedBy, [{ sessionId: 'session-a', reason: 'goal-active' }])

  // ROUND TRIP: what is read back is written back unchanged, so the NEXT boot
  // reads the same answers again (that is the whole point of the whitelist).
  const again = normalizeState(state, 1_700_000_000_000)
  assert.equal(again.repaired, false, 'the second pass is still clean')
  assert.deepEqual(again.state.watcherHygiene, state.watcherHygiene)
  assert.deepEqual(again.state.restartGate, state.restartGate)

  // An UNKNOWN field is still dropped, and the drop is reported.
  const withJunk = normalizeState({ ...raw, somethingElse: 1 }, 1_700_000_000_000)
  assert.equal(withJunk.repaired, true, 'an unknown top-level key is still refused')
  assert.equal('somethingElse' in withJunk.state, false, 'and it does not reach the state')

  // A field that says nothing is dropped instead of half-kept.
  const broken = normalizeState({ version: STATE_VERSION, restartGate: { reason: 'quiet' } }, 1)
  assert.equal(broken.state.restartGate, undefined, 'a gate without allow is not a gate')
  assert.equal(broken.repaired, true, 'and dropping it is reported')
})

