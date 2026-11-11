import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASES,
  bootPlan,
  continuationPrompt,
  describeState,
  isGoalRunning,
  isGoalStopped,
  restartDecision,
  restartGate,
  resumeStep,
  selectBusyGoals,
  selectRecoverableSessions,
} from '../lib/lifecycle.js';
import {
  createEmptyState,
  markPendingResume,
  markRunning,
  requestRestart,
} from '../lib/checkpoint.js';

const T = 1_700_000_000_000;
const SOFT = 300_000;
const HARD = 900_000;

/** A checkpoint with one deferred restart requested at T for session s1. */
function deferredState({ withGoal = false, now = T } = {}) {
  const state = createEmptyState(now);
  if (withGoal) markRunning(state, { sessionId: 's1', goalId: 'goal-1', goalRevision: 4, now });
  else markRunning(state, { sessionId: 's1', now });
  requestRestart(state, { reason: 'manual restart', bySessionId: 's1', now });
  return state;
}

test('PHASES is the frozen-by-convention phase list', () => {
  assert.deepEqual(PHASES, ['idle', 'deferred', 'restarting', 'recovering', 'running']);
  assert.equal(new Set(PHASES).size, PHASES.length);
});

test('bootPlan recovers pending sessions only when resumeOnBoot allows it', () => {
  const state = createEmptyState(T);
  markPendingResume(state, { sessionId: 'a', reason: 'interrupted', now: T + 20 });
  markPendingResume(state, { sessionId: 'b', reason: 'interrupted', now: T + 10 });
  markRunning(state, { sessionId: 'c', now: T + 30 });

  const plan = bootPlan(state, { limit: 2 });
  assert.equal(plan.recover, true);
  assert.equal(plan.phase, 'recovering');
  assert.equal(plan.restartWasPending, false);
  assert.deepEqual(plan.sessions.map((entry) => entry.sessionId), ['c', 'a']);

  const capped = bootPlan(state, { limit: 1 });
  assert.deepEqual(capped.sessions.map((entry) => entry.sessionId), ['c']);

  const disabled = bootPlan(state, { resumeOnBoot: false, limit: 2 });
  assert.equal(disabled.recover, false);
  assert.deepEqual(disabled.sessions, []);
  assert.equal(disabled.phase, 'idle');

  const idle = bootPlan(createEmptyState(T), {});
  assert.equal(idle.recover, false);
  assert.equal(idle.phase, 'idle');
});

test('bootPlan reports a pending restart without mutating the state', () => {
  const state = deferredState();
  const before = JSON.stringify(state);
  const plan = bootPlan(state, {});
  assert.equal(plan.restartWasPending, true);
  assert.equal(plan.recover, true);
  assert.equal(JSON.stringify(state), before);
});

test('restartDecision returns none when nothing is pending', () => {
  const decision = restartDecision(createEmptyState(T), { anyAgentRunning: false, now: T });
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'no-restart-pending');
});

test('restartDecision coalesces an in-progress restart', () => {
  const state = deferredState();
  state.phase = 'restarting';
  const busy = restartDecision(state, { anyAgentRunning: true, now: T + HARD * 10 });
  assert.equal(busy.action, 'none');
  assert.equal(busy.reason, 'restart-already-in-progress');
  const idle = restartDecision(state, { anyAgentRunning: false, now: T + 1 });
  assert.equal(idle.action, 'none');
});

test('restartDecision restarts immediately when no agent is running', () => {
  const decision = restartDecision(deferredState(), { anyAgentRunning: false, now: T + 1 });
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'no-agent-running');
});

// NO DEADLINES (user decision, 2026-11-02). A pending restart waits for the idle
// gate and nothing else: no soft window, no hard deadline, no timer, no default
// that ends it. These tests replace the old soft/hard-deadline expectations and
// pin the new rule: keep waiting, however long, until the gate opens or the user
// withdraws the request.

test('a busy conversation means LOOSE: the restart waits, with no window and no deadline', () => {
  const state = deferredState();
  // One millisecond after the request…
  const early = restartDecision(state, { anyAgentRunning: true, now: T + 1 });
  assert.equal(early.action, 'long-wait');
  assert.equal(early.reason, 'waiting-for-conversations');
  // …and one year later: exactly the same answer. Nothing expires.
  const late = restartDecision(state, { anyAgentRunning: true, now: T + 365 * 24 * 3600 * 1000 });
  assert.equal(late.action, 'long-wait');
  assert.equal(late.reason, 'waiting-for-conversations');
  assert.equal(typeof late.log, 'string');
});

test('the old softMs / hardMs values change nothing at all', () => {
  const state = deferredState();
  const withoutThem = restartDecision(state, { anyAgentRunning: true, now: T + 10 });
  const withThem = restartDecision(state, {
    anyAgentRunning: true,
    now: T + 10,
    softMs: 1,
    hardMs: 2,
  });
  // Even with the numbers set to "everything is overdue immediately", the answer
  // is the same: they are accepted for compatibility and ignored.
  assert.deepEqual({ ...withThem }, { ...withoutThem });
});

test('defer policy "wait" behaves exactly like "auto" while a conversation runs', () => {
  const state = deferredState();
  const wait = restartDecision(state, { anyAgentRunning: true, now: T + 10, policy: 'wait' });
  const auto = restartDecision(state, { anyAgentRunning: true, now: T + 10, policy: 'auto' });
  assert.equal(wait.action, 'long-wait');
  assert.equal(wait.reason, 'waiting-for-conversations');
  assert.equal(auto.action, 'long-wait', 'no policy makes the request expire or get killed');
});

test('by default a busy conversation is never interrupted, however long it takes', () => {
  const state = deferredState();
  assert.equal(state.phase, 'deferred');
  const decision = restartDecision(state, { anyAgentRunning: true, now: T + 900_000 });
  assert.equal(decision.action, 'long-wait');
  assert.equal(decision.reason, 'waiting-for-conversations');
  assert.equal(decision.blockedBy.length > 0, true, 'and it names whoever holds it');
  assert.equal(decision.waitingSince > 0, true, 'and since when');
});

test('forceRestartWhenBusy interrupts the running conversation — it is not a deadline', () => {
  const state = deferredState();
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + 1,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(decision.action, 'force-restart');
  assert.equal(decision.reason, 'force-restart-while-busy');
  assert.match(decision.log, /interrupts the running conversations/);
});

test('a forced restart that was already attempted gives up instead of looping', () => {
  const state = deferredState();
  state.restart.attempt = 1;
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + 1,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(decision.action, 'give-up');
  assert.equal(decision.reason, 'forced-restart-already-attempted');

  // Without the opt-in the pending restart keeps waiting instead of giving up.
  const waiting = restartDecision(state, { anyAgentRunning: true, now: T + 1, policy: 'auto' });
  assert.equal(waiting.action, 'long-wait');
  assert.equal(waiting.reason, 'waiting-for-conversations');
});

test('the force path needs the deferred phase — every other phase keeps waiting', () => {
  const state = deferredState();
  state.phase = 'running';
  const decision = restartDecision(state, { anyAgentRunning: true, now: T + 1, policy: 'auto' });
  assert.equal(decision.action, 'long-wait');
  assert.equal(decision.reason, 'waiting-for-conversations');

  const forced = restartDecision(state, {
    anyAgentRunning: true,
    now: T + 1,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(forced.action, 'long-wait');
  assert.equal(forced.reason, 'waiting-for-conversations');
});

test('resumeStep skips unknown sessions', () => {
  const step = resumeStep(createEmptyState(T), 'missing', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'skip');
  assert.equal(step.needAgent, false);
  assert.equal(step.reason, 'unknown-session');
});

test('resumeStep re-arms a recorded goal after an interrupted turn', () => {
  const state = deferredState({ withGoal: true });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'rearm-goal');
  assert.equal(step.needAgent, true);
  assert.equal(step.needsAgentResume, true);
  assert.equal(step.attempts, 0);
  assert.equal(step.maxAttempts, 2);
});

test('resumeStep prompts a continuation when no goal is recorded', () => {
  const state = deferredState({ withGoal: false });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'prompt-continuation');
  assert.equal(step.needAgent, true);
  assert.equal(step.needsAgentResume, true);
});

test('resumeStep on a live running session does not need a resume', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', goalId: 'g', now: T });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'rearm-goal');
  assert.equal(step.needsAgentResume, false);
});

test('resumeStep skips after the attempt cap', () => {
  const state = deferredState({ withGoal: true });
  state.sessions.s1.resumeAttempts = 2;
  const capped = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(capped.action, 'skip');
  assert.equal(capped.needAgent, false);
  assert.equal(capped.reason, 'resume-attempts-exhausted');

  const raised = resumeStep(state, 's1', { maxResumeAttempts: 3 });
  assert.equal(raised.action, 'rearm-goal');
});

test('continuationPrompt uses an override verbatim', () => {
  const entry = deferredState().sessions.s1;
  const override = '  keep going exactly as instructed  ';
  assert.equal(continuationPrompt(entry, { override, now: T }), override);
  // A whitespace-only override is ignored in favour of the built-in text.
  const built = continuationPrompt(entry, { override: '   ', now: T });
  assert.match(built, /<continuum_resume>/);
});

test('continuationPrompt default text names the host, time and reason', () => {
  const entry = deferredState({ withGoal: true }).sessions.s1;
  const text = continuationPrompt(entry, { reason: 'manual restart', now: T });
  assert.match(text, /^<continuum_resume>\n/);
  assert.match(text, /<\/continuum_resume>$/);
  assert.equal(text.includes(new Date(T).toISOString()), true);
  assert.equal(text.includes('manual restart'), true);
  assert.equal(text.includes('DeepSeek Harness'), true);
  assert.equal(text.split('\n').length, 4);

  const custom = continuationPrompt(entry, { now: T, appName: 'MyHost', reason: 'r' });
  assert.equal(custom.includes('MyHost'), true);
});

test('continuationPrompt falls back to the last recorded reason', () => {
  const state = deferredState();
  const entry = state.sessions.s1;
  assert.deepEqual(entry.reasons, ['manual restart']);
  const text = continuationPrompt(entry, { now: T });
  assert.equal(text.includes('manual restart'), true);
});

test('describeState is a one-line summary with phase/generation/pending', () => {
  const state = deferredState();
  state.sessions.s2 = {
    ...state.sessions.s1,
    sessionId: 's2',
    pendingResume: true,
  };
  const summary = describeState(state);
  assert.equal(summary.includes('\n'), false);
  assert.match(summary, /phase=deferred/);
  assert.match(summary, /generation=1/);
  assert.match(summary, /pending=2/);
  assert.match(summary, /s1/);
  assert.match(summary, /restart=attempt:0/);
  assert.equal(describeState(null), 'phase=unknown generation=0 pending=0');
});

test('selectRecoverableSessions is the shared definition used by checkpoint', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 'a', now: T + 1 });
  assert.deepEqual(selectRecoverableSessions(state, {}).map((entry) => entry.sessionId), ['a']);
  assert.deepEqual(selectRecoverableSessions(null, {}), []);
});


test('restartGate allows only when no conversation is busy and the host is quiet', () => {
  const busy = [{ sessionId: 'other', reason: 'running' }];
  const blocked = restartGate(createEmptyState(T), { busyAgents: busy, lastActivityAt: T, now: T + 1, settleMs: 4000 });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, 'conversation-active');
  assert.deepEqual(blocked.blockedBy, busy);
  assert.equal(blocked.quietForMs, 1);

  const settling = restartGate(createEmptyState(T), { busyAgents: [], lastActivityAt: T, now: T + 1500, settleMs: 4000 });
  assert.equal(settling.allow, false);
  assert.equal(settling.reason, 'settling');
  assert.deepEqual(settling.blockedBy, []);
  assert.equal(settling.quietForMs, 1500);

  const quiet = restartGate(createEmptyState(T), { busyAgents: [], lastActivityAt: T, now: T + 4000, settleMs: 4000 });
  assert.equal(quiet.allow, true);
  assert.equal(quiet.reason, 'quiet');
  assert.equal(quiet.quietForMs, 4000);

  // Queued inbox work blocks exactly like a running turn.
  const queued = restartGate(createEmptyState(T), {
    busyAgents: [{ sessionId: 'other', reason: 'queued' }],
    lastActivityAt: 0,
    now: T + 99999,
    settleMs: 0,
  });
  assert.equal(queued.allow, false);
  assert.equal(queued.reason, 'conversation-active');
});

test('restartDecision waits during the settle window and only force-restarts at the hard deadline when enabled', () => {
  const state = deferredState();
  const settling = restartDecision(state, {
    anyAgentRunning: false,
    lastActivityAt: T + 100,
    settleMs: 4000,
    now: T + 200,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(settling.action, 'wait');
  assert.equal(settling.reason, 'settling');

  const quiet = restartDecision(state, {
    busyAgents: [],
    lastActivityAt: T,
    settleMs: 4000,
    now: T + 5000,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(quiet.action, 'restart');
  assert.equal(quiet.reason, 'no-agent-running');

  // A queued conversation blocks the restart inside the soft window...
  const queuedBusy = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'queued' }],
    lastActivityAt: T,
    settleMs: 4000,
    now: T + 1000,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(queuedBusy.action, 'long-wait');
  assert.equal(queuedBusy.reason, 'waiting-for-conversations');

  // ...and only the explicit opt-in interrupts it.
  const forced = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'running' }],
    lastActivityAt: T + HARD,
    settleMs: 4000,
    now: T + HARD + 1,
    forceRestartWhenBusy: true,
  });
  assert.equal(forced.action, 'force-restart');
  assert.equal(forced.reason, 'force-restart-while-busy');

  // By default the same situation keeps waiting for the conversation to finish.
  const waiting = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'running' }],
    lastActivityAt: T + HARD,
    settleMs: 4000,
    now: T + HARD + 1,
  });
  assert.equal(waiting.action, 'long-wait');
  assert.equal(waiting.reason, 'waiting-for-conversations');
});

test('restartDecision defaults keep the previous idle behaviour', () => {
  const idle = restartDecision(deferredState(), { anyAgentRunning: false, now: T + 1 });
  assert.equal(idle.action, 'restart');
  assert.equal(idle.reason, 'no-agent-running');
  const busy = restartDecision(deferredState(), { anyAgentRunning: true, now: T + 1 });
  // A busy conversation means "still waiting", and it says so from the first
  // second: there is no window in which the page pretends nothing is happening.
  assert.equal(busy.action, 'long-wait');
  assert.equal(busy.reason, 'waiting-for-conversations');
});

// ---------------------------------------------------------------------------
// WHAT COUNTS AS "THE GOAL IS STILL GOING" (bug, 2026-11-11).
//
// The goal object is the HOST's: it carries `phase` (what the goal is doing)
// and `activation` (whether it still has the authority to drive itself). The
// power-off path read the booleans `activated` / `active` instead — fields the
// host never sets — so it never recognised a paused or a disarmed goal as
// "not running", and the machine could not be switched off.
//
// The end-to-end proof (the real plugin, the real sleep route) lives in
// `test/sleep-external-blockers.test.mjs`.
// ---------------------------------------------------------------------------

/** A goal of the shape the host really hands out. */
function goalOf(overrides = {}) {
  return {
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 10,
    ...overrides,
  };
}

test('an armed goal with rounds left is work in progress', () => {
  assert.equal(isGoalRunning(goalOf()), true);
});

test('a goal that is not running any more is not work in progress', () => {
  assert.equal(isGoalRunning(goalOf({ phase: 'paused' })), false, 'paused');
  assert.equal(isGoalRunning(goalOf({ phase: 'blocked' })), false, 'blocked');
  assert.equal(isGoalRunning(goalOf({ phase: 'complete' })), false, 'complete');
  assert.equal(isGoalRunning(goalOf({ phase: 'completed' })), false, 'completed');
  assert.equal(isGoalRunning(goalOf({ phase: 'done' })), false, 'done');
  assert.equal(isGoalRunning(goalOf({ activation: 'disarmed' })), false, 'disarmed');
  assert.equal(isGoalRunning(goalOf({ roundsStarted: 10, maxGoalRounds: 10 })), false, 'out of rounds');
  assert.equal(isGoalRunning(null), false, 'no goal at all');
});

test('a goal whose activation is missing counts as running (fail-closed)', () => {
  // THE TRADE-OFF (2026-11-11): the power-off gate would rather hold the
  // machine for a moment than switch it off while a goal may still be
  // running. The user sees the blocker on the shutdown card and can cancel it.
  // A goal that is plainly stopped (paused / blocked / complete) or plainly
  // without authority ('disarmed') never holds the host.
  assert.equal(isGoalRunning({ phase: 'active' }), true, 'an active goal without an activation is still work');
  assert.equal(isGoalRunning({ phase: 'active', activation: '' }), true, 'an empty activation is still work');
  assert.equal(isGoalRunning({}), true, 'a goal the host does not describe is treated as work, not as idle');
});

test('the activation is read the same way as the phase: trimmed and lower-cased', () => {
  assert.equal(isGoalRunning(goalOf({ activation: 'ARMED' })), true, 'ARMED is armed');
  assert.equal(isGoalRunning(goalOf({ activation: ' Armed ' })), true, 'padded and mixed case is armed');
  assert.equal(isGoalRunning(goalOf({ activation: 'DISARMED' })), false, 'DISARMED is disarmed');
  assert.equal(isGoalRunning(goalOf({ activation: ' Disarmed ' })), false, 'padded and mixed case is disarmed');
  assert.equal(isGoalRunning(goalOf({ phase: 'PAUSED' })), false, 'PAUSED is paused');
  assert.equal(isGoalRunning(goalOf({ phase: ' Active ' })), true, 'padded and mixed case is active');
});

test('a goal somebody stopped on purpose is "stopped", not merely "not running"', () => {
  assert.equal(isGoalStopped(goalOf({ phase: 'paused' })), true, 'paused');
  assert.equal(isGoalStopped(goalOf({ phase: 'blocked' })), true, 'blocked');
  assert.equal(isGoalStopped(goalOf({ phase: 'PAUSED' })), true, 'the phase is normalized');
  assert.equal(isGoalStopped(goalOf({ activation: 'paused' })), true, 'an activation that says paused');
  assert.equal(isGoalStopped(goalOf()), false, 'an armed, active goal is not stopped');
  // The plugin's OWN disarm is not "stopped": that goal is the one the boot has
  // to give back.
  assert.equal(isGoalStopped(goalOf({ activation: 'disarmed' })), false, 'disarmed is the plugin’s own disarm');
  assert.equal(isGoalStopped(null), false, 'no goal at all');
});

test('only the running goals are kept, and the session id must be there', () => {
  const busy = selectBusyGoals([
    { sessionId: 'session-a', goal: goalOf() },
    { sessionId: 'session-b', goal: goalOf({ phase: 'paused' }) },
    { sessionId: 'session-c', goal: goalOf({ activation: 'disarmed' }) },
    { sessionId: 'session-d', goal: goalOf({ phase: 'complete' }) },
    { sessionId: '', goal: goalOf() },
    { sessionId: 'session-e' },
    null,
  ]);
  assert.deepEqual(busy.map((entry) => entry.sessionId), ['session-a']);
  assert.equal(busy[0].goal.id, 'goal-1', 'the goal itself is carried along');
});
