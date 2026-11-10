/**
 * dsh-autorestart — pure lifecycle decision logic.
 *
 * Nothing in this module touches the filesystem, timers, processes or the DSH
 * host: every function is a pure transformation of the checkpoint state plus
 * an options bag. That makes the "should we restart / what should we resume"
 * policy fully unit-testable, and keeps `index.js` thin.
 *
 * ESM only, Node builtins only. No imports from DSH or npm.
 */

/** Ordered lifecycle phases. `deferred` means a restart is waiting for idle. */
export const PHASES = ['idle', 'deferred', 'restarting', 'recovering', 'running'];

const DEFAULT_LIMIT = 4;

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {object} entry */
function isDoneEntry(entry) {
  if (!isObject(entry)) return true;
  if (entry.done === true) return true;
  // A handed-off session and an over-limit session are BOTH out of the
  // automatic resume path for good: replaying that conversation can only fail
  // with the same "context window exceeds limit" error.
  if (isObject(entry.handoff)) return true;
  if (isObject(entry.contextOverflow) && entry.contextOverflow.over === true) return true;
  // A COMPLETE / paused / blocked GOAL does not make the SESSION done: a turn that
  // was interrupted still deserves its continuation message. Only the explicit
  // `done` flag and the durable handoff / over-limit markers remove a session
  // from the automatic resume path. (Treating a completed goal as done used to
  // silently drop every restart continuation for those sessions.)
  return false;
}

/**
 * Shared implementation of `checkpoint.recoverableSessions` (kept here so the
 * checkpoint module only depends on this module in one direction).
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {object[]} entries where running || pendingResume, not done, newest first
 */
export function selectRecoverableSessions(state, { limit } = {}) {
  const sessions = isObject(state) && isObject(state.sessions) ? state.sessions : {};
  const out = [];
  for (const entry of Object.values(sessions)) {
    if (!isObject(entry)) continue;
    if (entry.running !== true && entry.pendingResume !== true) continue;
    if (isDoneEntry(entry)) continue;
    out.push(entry);
  }
  out.sort((a, b) => (isFiniteNumber(b.updatedAt) ? b.updatedAt : 0) - (isFiniteNumber(a.updatedAt) ? a.updatedAt : 0));
  const cap = isFiniteNumber(limit) && limit >= 0 ? Math.trunc(limit) : out.length;
  return out.slice(0, cap);
}

/**
 * Decide what the boot sequence should do. Does not mutate `state`.
 *
 * @param {object} state
 * @param {{ resumeOnBoot?: boolean, limit?: number }} [options]
 * @returns {{ recover: boolean, sessions: object[], restartWasPending: boolean, phase: 'recovering'|'idle' }}
 */
export function bootPlan(state, { resumeOnBoot = true, limit = DEFAULT_LIMIT } = {}) {
  const restartWasPending = isObject(state) && isObject(state.restart);
  const sessions = resumeOnBoot === false ? [] : selectRecoverableSessions(state, { limit });
  const recover = sessions.length > 0;
  return {
    recover,
    sessions,
    restartWasPending,
    phase: recover ? 'recovering' : 'idle',
  };
}

/**
 * Backwards-compatible bridge: derive a busy list from the legacy boolean option.
 *
 * @param {unknown} anyAgentRunning
 * @returns {{ sessionId: string|null, reason: string }[]}
 */
function legacyBusyAgents(anyAgentRunning) {
  return anyAgentRunning === true ? [{ sessionId: null, reason: 'running' }] : [];
}

/**
 * The two-layer anti-collision gate every restart path must pass.
 *
 * Layer 1 (`busyAgents`) blocks while ANY conversation is still working.
 * Layer 2 (`settleMs`) additionally requires a short quiet window.
 *
 * `externalBlockers` is the third source (2026-11-10): work that is going on
 * OUTSIDE the conversations and that a restart would break — the plugin market
 * installing a plugin. It blocks the gate but it is NOT a conversation: it never
 * enters `blockedBy` (the task count of the bubble consults exactly that list)
 * and it has its own field, so no surface can ever count the market as a session.
 *
 * @param {object} state
 * @param {{
 *   busyAgents?: { sessionId: string|null, reason: string }[],
 *   externalBlockers?: { reason?: string, kind?: string }[],
 *   lastActivityAt?: number,
 *   now?: number,
 *   settleMs?: number,
 * }} [options]
 * @returns {{
 *   allow: boolean,
 *   reason: string,
 *   blockedBy: { sessionId: string|null, reason: string }[],
 *   externalBlockers: any[],
 *   quietForMs: number,
 * }}
 */
export function restartGate(state, {
  busyAgents = [],
  externalBlockers = [],
  lastActivityAt = 0,
  now = Date.now(),
  settleMs = 4000,
} = {}) {
  void state; // uniform (state, options) signature with the other lifecycle policies
  const nowMs = isFiniteNumber(now) ? now : 0;
  const lastAt = isFiniteNumber(lastActivityAt) ? lastActivityAt : 0;
  const quietForMs = Math.max(0, nowMs - lastAt);
  const busy = Array.isArray(busyAgents) ? busyAgents.filter((entry) => isObject(entry)) : [];
  if (busy.length > 0) {
    return { allow: false, reason: 'conversation-active', blockedBy: busy, externalBlockers: [], quietForMs };
  }
  const external = Array.isArray(externalBlockers) ? externalBlockers.filter((entry) => isObject(entry)) : [];
  if (external.length > 0) {
    const first = external[0];
    const reason = typeof first.reason === 'string' && first.reason !== '' ? first.reason : 'external-blocker';
    return { allow: false, reason, blockedBy: [], externalBlockers: external, quietForMs };
  }
  const settle = isFiniteNumber(settleMs) && settleMs >= 0 ? settleMs : 4000;
  if (quietForMs < settle) {
    return { allow: false, reason: 'settling', blockedBy: [], externalBlockers: [], quietForMs };
  }
  return { allow: true, reason: 'quiet', blockedBy: [], externalBlockers: [], quietForMs };
}

/**
 * Why a session still keeps the restart waiting. `goal-active` is the only
 * reason that can be cleared by DISARMING the goal (`ctx.goals.disarm`, which
 * leaves the durable goal `active` but stops the round driver); every other
 * reason is only REPORTED, because disarming would be wrong or useless:
 *  - `goal-paused`   — somebody paused it (the model may not resume it),
 *  - `goal-blocked` / `goal-complete` / `goal-not-active` — not running work,
 *  - `goal-disarmed` — no continuation authority left to take away,
 *  - `goal-exhausted` — the round budget is spent, so it can never be resumed,
 *  - `goal-no-agent` — the session has no live agent to disarm through.
 *  - `goal-parked`   — LEGACY: the old "this plugin already handled it" reason.
 *    It is never produced any more: the live goal state decides, not a record.
 */
export const GOAL_BLOCK_REASONS = {
  ACTIVE: 'goal-active',
  PARKED: 'goal-parked',
  EXHAUSTED: 'goal-exhausted',
  PAUSED: 'goal-paused',
  BLOCKED: 'goal-blocked',
  COMPLETE: 'goal-complete',
  DISARMED: 'goal-disarmed',
  NOT_ACTIVE: 'goal-not-active',
  NO_AGENT: 'goal-no-agent',
};

/**
 * Decide which busy sessions must have their goal DISARMED before a pending
 * restart can proceed.
 *
 * The decision is taken on the LIVE goal view and on nothing else. A goal may
 * be disarmed ONLY when ALL of these hold:
 *  - the goal exists,
 *  - its phase is `active`,
 *  - its activation is `armed`,
 *  - `roundsStarted < maxGoalRounds` (a goal whose round budget is spent can
 *    never be resumed, so disarming it would strand the work).
 *
 * The checkpoint records (`disarmedGoals` / `parkedGoals`) are REPORTING ONLY:
 * they never veto the decision. A goal that was resumed — and is therefore
 * armed again — must be disarmable a second time, otherwise the restart waits
 * for a goal nobody can disarm any more (the exact deadlock this feature
 * exists to remove). The `disarmedGoals` / `parkedGoals` options are still
 * accepted for backwards compatibility, but they are not consulted.
 *
 * Disarming is safe because it only removes process-local continuation
 * authority: the durable goal stays `active`, the round that is running right
 * now still finishes normally, and `ctx.goals.resume(...)` re-arms it after the
 * restart.
 *
 * @param {{ sessionId: string, reason?: string }[]} busyAgents
 * @param {{
 *   getGoal?: (sessionId: string) => object|undefined,
 *   disarmedGoals?: object,
 *   parkedGoals?: object,
 * }} [options]
 * @returns {{
 *   disarms: { sessionId: string, goalId: string|null, revision: number|null, reason: string }[],
 *   reported: { sessionId: string, goalId: string|null, reason: string }[],
 * }}
 */
export function selectGoalDisarms(busyAgents, { getGoal, disarmedGoals, parkedGoals } = {}) {
  const disarms = [];
  const reported = [];
  const list = Array.isArray(busyAgents) ? busyAgents : [];
  // The records are reporting material only: they must never veto a disarm.
  void disarmedGoals;
  void parkedGoals;
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const sessionId = entry.sessionId == null ? '' : String(entry.sessionId);
    if (!sessionId) continue;
    let goal;
    try {
      goal = typeof getGoal === 'function' ? getGoal(sessionId) : undefined;
    } catch {
      goal = undefined;
    }
    if (!isObject(goal)) continue;
    const goalId = goal.id == null ? null : String(goal.id);
    // The LIVE goal decides. A checkpoint record (this plugin disarmed the goal
    // earlier, or the previous pause-based build parked it) is reporting material
    // only: it must never veto a disarm, or a goal that was resumed (and is armed
    // again) could never be disarmed a second time and the restart would wait for
    // it forever.
    const phase = typeof goal.phase === 'string' ? goal.phase : '';
    if (phase !== 'active') {
      const reason = phase === 'paused'
        ? GOAL_BLOCK_REASONS.PAUSED
        : phase === 'blocked'
          ? GOAL_BLOCK_REASONS.BLOCKED
          : phase === 'complete'
            ? GOAL_BLOCK_REASONS.COMPLETE
            : GOAL_BLOCK_REASONS.NOT_ACTIVE;
      reported.push({ sessionId, goalId, reason });
      continue;
    }
    if (goal.activation !== 'armed') {
      reported.push({ sessionId, goalId, reason: GOAL_BLOCK_REASONS.DISARMED });
      continue;
    }
    const roundsStarted = isFiniteNumber(goal.roundsStarted) ? goal.roundsStarted : 0;
    const maxGoalRounds = isFiniteNumber(goal.maxGoalRounds) ? goal.maxGoalRounds : Infinity;
    if (roundsStarted >= maxGoalRounds) {
      reported.push({ sessionId, goalId, reason: GOAL_BLOCK_REASONS.EXHAUSTED });
      continue;
    }
    disarms.push({
      sessionId,
      goalId,
      revision: isFiniteNumber(goal.revision) ? goal.revision : null,
      reason: GOAL_BLOCK_REASONS.ACTIVE,
    });
  }
  return { disarms, reported };
}

/**
 * The idle-aware restart policy. Call this on a poll timer (e.g. `deferPollMs`)
 * while `state.restart` exists.
 *
 * @param {object} state
 * @param {{
 *   anyAgentRunning?: boolean,
 *   busyAgents?: { sessionId: string|null, reason: string }[],
 *   lastActivityAt?: number,
 *   settleMs?: number,
 *   now?: number,
 *   softMs?: number,
 *   hardMs?: number,
 *   policy?: 'auto'|'wait'|string,
 *   forceRestartWhenBusy?: boolean,
 * }} [options]
 * @returns {{
 *   action: 'none'|'wait'|'warn'|'long-wait'|'restart'|'force-restart'|'give-up',
 *   reason: string,
 *   log?: string,
 *   markSoftWarned?: boolean,
 *   blockedBy?: { sessionId: string|null, reason: string }[],
 *   waitingSince?: number,
 * }}
 */
export function restartDecision(
  state,
  {
    anyAgentRunning = false,
    busyAgents,
    externalBlockers = [],
    lastActivityAt = 0,
    settleMs = 4000,
    now = Date.now(),
    softMs = 300_000,
    hardMs = 900_000,
    policy = 'auto',
    forceRestartWhenBusy = false,
  } = {},
) {
  const restart = isObject(state) && isObject(state.restart) ? state.restart : null;
  if (!restart) return { action: 'none', reason: 'no-restart-pending' };

  // Coalesce: never schedule the same restart twice.
  if (state.phase === 'restarting') return { action: 'none', reason: 'restart-already-in-progress' };

  const requestedAt = isFiniteNumber(restart.requestedAt) ? restart.requestedAt : 0;
  const attempt = isFiniteNumber(restart.attempt) ? restart.attempt : 0;
  const notBefore = isFiniteNumber(restart.notBefore) ? restart.notBefore : 0;

  // NO DEADLINES (user decision, 2026-11-02).
  //
  // `softMs` / `hardMs` stay in the option list so no caller has to change, and
  // they are IGNORED: a pending restart waits for the idle gate and nothing else.
  // There is no soft window, no hard deadline, no timer and no default that can
  // end the request — it ends in exactly two ways:
  //   1. the gate opens and the restart runs;
  //   2. the user withdraws it (the cancel route, handled by the caller).
  // The old design reported "the hard deadline has passed", which read like "the
  // request is void" — it never was, and it only confused everybody reading it.

  // Backoff after a failed scheduling attempt: wait without re-planning.
  if (notBefore > 0 && now < notBefore) return { action: 'wait', reason: 'restart-backoff' };

  // `defer_seconds` / a future requestedAt delays even an idle restart.
  if (requestedAt > now) return { action: 'wait', reason: 'restart-scheduled-in-future' };

  // Nobody is running an agent turn. The settle window still applies: a turn that
  // ended a moment ago, or a message queued just now, must not be killed.
  const busy = Array.isArray(busyAgents) ? busyAgents.filter((entry) => isObject(entry)) : legacyBusyAgents(anyAgentRunning);
  // THE MARKET IS INSTALLING SOMETHING (2026-11-10). It is not a conversation, so
  // it never reaches `busy` — but a restart would still break the install, so the
  // decision has to wait for it. This is the branch that makes the gate REAL: the
  // tick acts on `decision.action`, not on `restartGate()` alone, so leaving this
  // out would let the restart run while the gate said "no".
  const external = Array.isArray(externalBlockers) ? externalBlockers.filter((entry) => isObject(entry)) : [];
  if (external.length > 0 && busy.length === 0) {
    const first = external[0];
    const reason = typeof first.reason === 'string' && first.reason !== '' ? first.reason : 'external-blocker';
    return {
      action: 'long-wait',
      reason,
      log: 'dsh-autorestart: ' + reason + '; the restart keeps waiting until it is done',
      blockedBy: [],
      externalBlockers: external,
      waitingSince: requestedAt,
    };
  }
  if (busy.length === 0) {
    if (!restartGate(state, { busyAgents: busy, lastActivityAt, now, settleMs }).allow) {
      return { action: 'wait', reason: 'settling' };
    }
    return { action: 'restart', reason: 'no-agent-running' };
  }

  // Somebody is still running. The ONLY thing that may act on that is the explicit
  // opt-in `forceRestartWhenBusy` — it restarts OVER a running conversation, and
  // it says so in its own name. It is not a deadline and it is off by default.
  if (forceRestartWhenBusy === true && policy === 'auto' && state.phase === 'deferred') {
    if (attempt > 0) return { action: 'give-up', reason: 'forced-restart-already-attempted' };
    return {
      action: 'force-restart',
      reason: 'force-restart-while-busy',
      log: 'dsh-autorestart: forceRestartWhenBusy is enabled, so the restart interrupts the running conversations',
    };
  }

  // Everything else keeps waiting, for as long as it takes. The answer says so
  // explicitly — a long wait, with the sessions that hold it, and no end time.
  return {
    action: 'long-wait',
    reason: 'waiting-for-conversations',
    log: 'dsh-autorestart: conversations are still running; the restart keeps waiting until they are done',
    blockedBy: busy,
    waitingSince: requestedAt,
  };
}

/**
 * Derive the continuation step for one recovered session.
 *
 * The returned `action` is the *continuation* mode. When `needAgent` is true the
 * caller must first make sure an agent session exists/resumes, then apply the
 * action. `needsAgentResume` is true when the checkpoint shows the session was
 * interrupted while running (so it must be resumed rather than just prompted).
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ maxResumeAttempts?: number }} [options]
 * @returns {{ action: 'rearm-goal'|'prompt-continuation'|'skip', needAgent: boolean, needsAgentResume: boolean, reason: string, attempts: number, maxAttempts: number }}
 */
export function resumeStep(state, sessionId, { maxResumeAttempts = 2 } = {}) {
  const sessions = isObject(state) && isObject(state.sessions) ? state.sessions : {};
  // ONLY the own property is read: an inherited `__proto__` would hand out
  // `Object.prototype` itself, and every field written on that "entry" would
  // land in the prototype of the whole process.
  //
  // The own-property read is spelled out HERE instead of importing
  // `sessionEntry` from `checkpoint.js`: that module imports from this one, so
  // an import the other way round would be a cycle, and this module stays
  // free of imports (it is pure decision logic).
  const entry = Object.prototype.hasOwnProperty.call(sessions, sessionId) && isObject(sessions[sessionId])
    ? sessions[sessionId]
    : null;
  const max = isFiniteNumber(maxResumeAttempts) ? maxResumeAttempts : 0;

  if (!entry) {
    return {
      action: 'skip',
      needAgent: false,
      needsAgentResume: false,
      reason: 'unknown-session',
      attempts: 0,
      maxAttempts: max,
    };
  }

  const attempts = isFiniteNumber(entry.resumeAttempts) ? entry.resumeAttempts : 0;
  if (attempts >= max) {
    return {
      action: 'skip',
      needAgent: false,
      needsAgentResume: false,
      reason: 'resume-attempts-exhausted',
      attempts,
      maxAttempts: max,
    };
  }

  const hasGoal = isObject(entry.goal) && entry.goal.goalId != null;
  return {
    action: hasGoal ? 'rearm-goal' : 'prompt-continuation',
    needAgent: true,
    needsAgentResume: entry.running !== true,
    reason: hasGoal ? 'goal-recorded' : 'no-goal-recorded',
    attempts,
    maxAttempts: max,
  };
}

/**
 * Build the single user message that asks a recovered agent to continue.
 *
 * @param {object|null} entry
 * @param {{ reason?: string, appName?: string, now?: number, override?: string }} [options]
 * @returns {string} one user-message text
 */
export function continuationPrompt(
  entry,
  { reason, appName = 'DeepSeek Harness', now = Date.now(), override } = {},
) {
  if (typeof override === 'string' && override.trim().length > 0) return override;

  const recorded = isObject(entry) && Array.isArray(entry.reasons) ? entry.reasons : [];
  const fallbackReason = recorded.length > 0 ? recorded[recorded.length - 1] : 'unknown';
  const effectiveReason = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : fallbackReason;
  const iso = Number.isFinite(now) ? new Date(now).toISOString() : new Date().toISOString();

  return [
    '<continuum_resume>',
    `主机（${appName}）在 ${iso} 重启。你上一轮的会话被中断（原因：${effectiveReason}）。`,
    '请先检查当前工作区、未完成的 todo 列表与最近的工具结果，判断中断点，然后直接从中断处继续原任务：不要等待新的用户指令，不要重复已完成的工作，完成剩余步骤后再向用户说明结果。如果任务已经在中断前完成，请直接给出结论。',
    '</continuum_resume>',
  ].join('\n');
}

/**
 * Default character budget of the conversation tail a handoff carries.
 */
export const HANDOFF_DEFAULT_MAX_CHARS = 20000;

/** Tokens/characters of a message body, flattened to one plain-text line. */
function flattenText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** The tool name of one content block, or a generic label. */
function toolNameOf(block) {
  const candidates = [block.name, block.toolName, block.tool, block.id];
  if (isObject(block.data)) candidates.push(block.data.name, block.data.toolName);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return 'unknown-tool';
}

/**
 * Render one conversation message as plain-text lines. A text block becomes
 * `role: text`; a tool call / tool result becomes one short line with the tool
 * name only (tool payloads are never carried).
 *
 * @param {unknown} message
 * @returns {string[]}
 */
export function renderMessageLines(message) {
  if (!isObject(message)) return [];
  const role = typeof message.role === 'string' && message.role !== '' ? message.role : 'message';
  const out = [];
  const pushText = (text) => {
    const line = flattenText(text);
    if (line !== '') out.push(`${role}: ${line}`);
  };
  const content = message.content;
  if (typeof content === 'string') {
    pushText(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block === 'string') {
      pushText(block);
      continue;
    }
    if (!isObject(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type.includes('tool')) {
      const label = type.includes('result') ? 'tool result' : 'tool call';
      out.push(`${label}: ${toolNameOf(block)}`);
      continue;
    }
    if (typeof block.text === 'string') pushText(block.text);
  }
  return out;
}

/**
 * The tail of a conversation, newest message first, bounded by a character
 * budget. Rendering stops as soon as adding the next line would exceed the
 * budget; one oversized single line is truncated so a handoff always carries
 * something.
 *
 * @param {unknown} messages
 * @param {{ budget?: number }} [options]
 * @returns {{ lines: string[], chars: number }} `lines` are oldest first
 */
export function handoffTail(messages, { budget = HANDOFF_DEFAULT_MAX_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = isFiniteNumber(budget) && budget > 0 ? Math.trunc(budget) : HANDOFF_DEFAULT_MAX_CHARS;
  const picked = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const lines = renderMessageLines(list[i]);
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j];
      const cost = line.length + 1;
      if (chars + cost > limit) {
        if (chars === 0 && limit > 16) {
          const truncated = `${line.slice(0, limit - 1)}…`;
          picked.push(truncated);
          chars = truncated.length;
        }
        return { lines: picked.reverse(), chars };
      }
      picked.push(line);
      chars += cost;
    }
  }
  return { lines: picked.reverse(), chars };
}

/**
 * Compose the text a handoff carries into the fresh session, in this order:
 * (i) the goal objective, (ii) the recorded handoff context / reasons (most
 * recent first), (iii) the bounded tail of the earlier conversation (oldest
 * first), after one line saying this is a trimmed continuation and one line
 * naming the old session id.
 *
 * @param {{
 *   sessionId?: string|null,
 *   objective?: string|null,
 *   goalLabel?: string|null,
 *   reasons?: string[]|null,
 *   messages?: unknown,
 *   maxChars?: number,
 * }} [options]
 * @returns {{ text: string, carriedChars: number, tailChars: number, tailLines: number }}
 */
export function composeHandoff({
  sessionId = null,
  objective = null,
  goalLabel = null,
  reasons = null,
  messages = [],
  maxChars = HANDOFF_DEFAULT_MAX_CHARS,
} = {}) {
  const budget = isFiniteNumber(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : HANDOFF_DEFAULT_MAX_CHARS;
  const oldId = sessionId == null || sessionId === '' ? '(unknown)' : String(sessionId);
  const tail = handoffTail(messages, { budget });
  const lines = [
    '<continuum_handoff>',
    'This is a trimmed continuation of an earlier session whose earlier content could not be carried because it exceeded the model context window.',
    `Old session id: ${oldId}`,
  ];

  // (i) the goal objective
  const goalText = flattenText(objective);
  if (goalText !== '') lines.push(`Goal objective: ${goalText}`);
  else if (flattenText(goalLabel) !== '') lines.push(`Goal objective: (not recorded) — recorded goal ${flattenText(goalLabel)}`);
  else lines.push('Goal objective: (no goal recorded)');

  // (ii) the recorded handoff context of that session, most recent first
  const recorded = Array.isArray(reasons)
    ? reasons.filter((reason) => typeof reason === 'string' && flattenText(reason) !== '').map(flattenText)
    : [];
  if (recorded.length > 0) {
    lines.push('Recorded checkpoint context of that session (most recent first):');
    for (const reason of recorded.slice().reverse()) lines.push(`- ${reason}`);
  } else {
    lines.push('Recorded checkpoint context of that session: (none recorded)');
  }

  // (iii) the bounded tail of the conversation, oldest first
  if (tail.lines.length > 0) {
    lines.push(`Trimmed tail of the earlier conversation (${tail.lines.length} line(s), ${tail.chars} character(s), oldest first):`);
    for (const line of tail.lines) lines.push(line);
  } else {
    lines.push('Trimmed tail of the earlier conversation: (not available)');
  }

  lines.push('Continue the work from here: this handoff is the only context carried over from the earlier session.');
  lines.push('</continuum_handoff>');
  const text = lines.join('\n');
  return { text, carriedChars: text.length, tailChars: tail.chars, tailLines: tail.lines.length };
}

/** A phrase that identifies a failure caused by an oversized context. */
const CONTEXT_WINDOW_PATTERN = /context[ _-]?(?:window|length)|context_length_exceeded|maximum context/i;

/** A phrase that identifies an exceeded limit next to {@link CONTEXT_WINDOW_PATTERN}. */
const EXCEED_PATTERN = /exceed|overflow|too (?:long|large|many)|over the limit|maximum/i;

/** The joined text of one message (used for overflow evidence). */
function messageTextOf(message) {
  if (!isObject(message)) return '';
  const parts = [];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block === 'string') parts.push(block);
      else if (isObject(block) && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (typeof message.text === 'string') parts.push(message.text);
  return parts.join(' ');
}

/** The failure text of one event-ish object (shallow, never throws). */
function eventTextOf(event) {
  if (!isObject(event)) return '';
  const parts = [];
  for (const key of ['message', 'error', 'reason', 'text']) {
    const value = event[key];
    if (typeof value === 'string') parts.push(value);
    else if (isObject(value) && typeof value.message === 'string') parts.push(value.message);
  }
  if (isObject(event.data)) {
    for (const key of ['message', 'error', 'text']) {
      const value = event.data[key];
      if (typeof value === 'string') parts.push(value);
      else if (isObject(value) && typeof value.message === 'string') parts.push(value.message);
    }
  }
  return parts.join(' ');
}

/**
 * Decide whether a session is over the model context window.
 *
 * Evidence, in this order:
 *  1. the newest assistant message's `usage.inputTokens` versus the session's
 *     `contextWindow`: overflow when the used tokens EXCEED the window;
 *  2. a recent message / event whose text says the context window was exceeded.
 *
 * When the numbers are unknown, the verdict is NOT overflow: an unknown window
 * must never block the normal resume path.
 *
 * @param {{ messages?: unknown, contextWindow?: number|null, events?: unknown }} [options]
 * @returns {{ over: boolean, inputTokens: number|null, contextWindow: number|null, detail: string|null }}
 */
export function contextOverflow({ messages = [], contextWindow = null, events = [] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let inputTokens = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!isObject(message)) continue;
    const usage = message.usage;
    if (!isObject(usage)) continue;
    for (const key of ['inputTokens', 'promptTokens', 'input_tokens']) {
      if (isFiniteNumber(usage[key]) && usage[key] >= 0) {
        inputTokens = usage[key];
        break;
      }
    }
    if (inputTokens !== null) break;
  }
  const window = isFiniteNumber(contextWindow) && contextWindow > 0 ? contextWindow : null;

  // Numbers are authoritative: when the last request's token usage and the model
  // window are both known, they decide, and a mere MENTION of the phrase in a
  // tool result or in a pasted log can never flip the verdict.
  if (inputTokens !== null && window !== null) {
    if (inputTokens > window) {
      return {
        over: true,
        inputTokens,
        contextWindow: window,
        detail: `the last request used ${inputTokens} tokens, which exceeds the model context window of ${window}`,
      };
    }
    return {
      over: false,
      inputTokens,
      contextWindow: window,
      detail: `used ${inputTokens} of ${window} tokens`,
    };
  }

  // Without numbers, only a STRUCTURED turn failure counts: a `turn/end` event
  // whose reason is an error whose failure message says the context window was
  // exceeded. Free text in ordinary messages is never evidence.
  let failure = '';
  for (const event of (Array.isArray(events) ? events : [])) {
    if (!isObject(event) || event.type !== 'turn/end') continue;
    const reason = event.data && event.data.reason;
    if (!isObject(reason) || reason.kind !== 'error') continue;
    const error = reason.error;
    const message = error && typeof error.message === 'string' ? error.message : '';
    if (message === '') continue;
    if (CONTEXT_WINDOW_PATTERN.test(message) && EXCEED_PATTERN.test(message)) {
      failure = flattenText(message).slice(0, 200);
    }
  }

  if (failure !== '') {
    return {
      over: true,
      inputTokens,
      contextWindow: window,
      detail: `a turn failed with a context-window error: ${failure}`,
    };
  }
  return {
    over: false,
    inputTokens,
    contextWindow: window,
    detail: inputTokens !== null ? `used ${inputTokens} tokens (window unknown)` : null,
  };
}

/**
 * One-line human-readable summary for logs and the health endpoint.
 *
 * @param {object} state
 * @returns {string}
 */
export function describeState(state) {
  const phase = isObject(state) && typeof state.phase === 'string' ? state.phase : 'unknown';
  const generation = isObject(state) && isFiniteNumber(state.generation) ? state.generation : 0;
  const pending = selectRecoverableSessions(state, {});
  const ids = pending.map((entry) => (typeof entry.sessionId === 'string' ? entry.sessionId : '?')).join(', ');
  const restart = isObject(state) && isObject(state.restart)
    ? ` restart=attempt:${isFiniteNumber(state.restart.attempt) ? state.restart.attempt : 0}`
    : '';
  return `phase=${phase} generation=${generation} pending=${pending.length}${ids ? ` [${ids}]` : ''}${restart}`;
}
