/**
 * dsh-autorestart — durable checkpoint store.
 *
 * Keeps one small JSON document in the DSH home directory that describes what
 * the host was doing when it stopped: the current boot identity, the restart
 * generation, and one entry per agent session that may need to be resumed.
 *
 * Design rules:
 *  - never throw while *reading*: a missing, unreadable or corrupt state file
 *    is reported and replaced by `createEmptyState()`.
 *  - never leave a half-written file: writes go to `<file>.tmp-<rand>` in the
 *    same directory and are then atomically renamed over the target.
 *  - every mutating helper below mutates `state` in place **and** returns it,
 *    so callers may treat the helpers as expressions.
 *
 * Goal records come in TWO shapes on purpose:
 *  - `state.disarmedGoals[sessionId] = { goalId, disarmedAt, resumedAt }` is the
 *    current shape: this plugin called `ctx.goals.disarm(agent)` before a
 *    restart, which keeps the durable goal `active` and can be re-armed with
 *    `ctx.goals.resume(...)` after the boot.
 *  - `state.parkedGoals[sessionId] = { goalId, parkedAt, resumedAt }` is the
 *    LEGACY shape written by the previous pause-based build. It is still read
 *    (and can still be cleared) so a goal that build paused is resumed once
 *    instead of being stranded in `paused` where only a human could undo it.
 *
 * ESM only, Node builtins only. No DSH / npm imports (profile-installed
 * bundles may not resolve them).
 */
/**
 * Coerce a recorded fact into the documented shape, or null when it is not one.
 *
 * @param {unknown} raw
 * @returns {{ dir: string, at: number, source: string }|null}
 */
function normalizeProfileDirFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dir = typeof raw.dir === 'string' ? raw.dir.trim() : '';
  if (dir === '') return null;
  const at = Number.isFinite(raw.at) ? Math.trunc(raw.at) : 0;
  const source = typeof raw.source === 'string' && raw.source.trim() !== '' ? raw.source.trim() : 'unknown';
  return { dir, at, source };
}

/**
 * The fact about the profile directory this host booted with.
 *
 * @param {{ dir?: string, source?: string }|null} resolved
 * @param {number} [now]
 * @returns {{ dir: string, at: number, source: string }|null}
 */
function profileDirFact(resolved, now = Date.now()) {
  if (!resolved || typeof resolved !== 'object') return null;
  const dir = typeof resolved.dir === 'string' ? resolved.dir.trim() : '';
  if (dir === '') return null;
  const source = typeof resolved.source === 'string' && resolved.source.trim() !== '' ? resolved.source.trim() : 'unknown';
  return { dir, at: now, source };
}
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PHASES, selectRecoverableSessions } from './lifecycle.js';
import { RESTART_PHASES } from './restart-phase.js';

/** Current on-disk schema version. */
export const STATE_VERSION = 1;

/** Hard cap on `entry.reasons` so the checkpoint cannot grow without bound. */
export const ENTRY_REASONS_LIMIT = 16;

/** Hard cap on `restart.requesters` (one entry per requesting session). */
export const REQUESTERS_LIMIT = 16;

/** Hard cap on the disarmed-goal records kept in the checkpoint. */
export const DISARMED_GOALS_LIMIT = 64;

/** Hard cap on the legacy (pause-based) parked-goal records. */
export const PARKED_GOALS_LIMIT = 64;

const RESTART_KEYS = new Set([
  'generation',
  'requestedAt',
  'reason',
  'bySessionId',
  'resume',
  'attempt',
  'softWarned',
  'failedAttempts',
  'notBefore',
  'requesters',
  'parkGoals',
  // THIS RESTART MUST NOT TAKE A SNAPSHOT (user decision, 2026-11-02).
  // The request that follows a manual rollback is exactly a restart of a state
  // that was JUST restored from a copy: snapshotting it again would push an
  // identical duplicate into the list (and squeeze the older, still useful
  // copies out of it). The undo copy of the rollback is the rollback point
  // already, so this restart carries the fact "no copy for me" on the request
  // itself — a flag, not an inference from the reason text.
  'skipBackup',
  // THE SNAPSHOT THIS REQUEST ALREADY TOOK. It lives on the request, so it is
  // dropped by itself when the request is withdrawn or carried out (the request
  // object is replaced / removed), and it survives a deferral — which is the whole
  // point: a 205 MB copy must not be repeated because a conversation interrupted
  // the restart (user report, 2026-10-30).
  'snapshot',
]);

const ENTRY_KEYS = new Set([
  'sessionId',
  'updatedAt',
  'running',
  'runningSince',
  'interrupted',
  'interruptedAt',
  'pendingResume',
  'pendingSince',
  'reasons',
  'goal',
  'resumeAttempts',
  'lastResumeAt',
  'lastResumeError',
  'lastRecoveryAction',
  'lastRecoveryDetail',
  'handoff',
  'contextOverflow',
]);

const GOAL_KEYS = new Set(['goalId', 'goalRevision', 'phase', 'updatedAt']);

/** Record written when a session was handed off to a fresh session. */
const HANDOFF_KEYS = new Set(['handedOffTo', 'handoffAt', 'carriedChars']);

/** Record written when the context-overflow guard decided a session is over the limit. */
const CONTEXT_OVERFLOW_KEYS = new Set(['over', 'inputTokens', 'contextWindow', 'detail', 'detectedAt']);

/** LEGACY record shape written by the pause-based build. */
const PARKED_GOAL_KEYS = new Set(['goalId', 'parkedAt', 'resumedAt']);

/**
 * Current record shape: written after a successful `ctx.goals.disarm()`.
 *
 * `reason` says WHY the goal was taken away ("restart-queued" when the pending
 * restart did it). The write side has been writing it since 2026-11-02, and a
 * whitelist that refused it silently threw the answer away on the next boot —
 * the record existed but could not be read. A field the plugin really writes
 * belongs in the shape it is normalized against.
 */
const DISARMED_GOAL_KEYS = new Set(['goalId', 'disarmedAt', 'resumedAt', 'reason']);

const TOP_LEVEL_KEYS = new Set([
  'version',
  'bootId',
  'bootPid',
  'bootStartedAt',
  'generation',
  'phase',
  'restartPhase',
  'restart',
  'sessions',
  'parkedGoals',
  'disarmedGoals',
  'seenFeatureVersions',
  'onboarding',
  'sleep',
  // The seed of the FIRST safe copy: what happened when a new host process
  // looked for a known-good backup and found none (user decision, 2026-10-30).
  'firstInstallBackup',
  // THE BOOT-TIME REPORTS (user decision, 2026-11-02). The Host writes both and
  // the next boot has to be able to read them back: the sweep of leftover
  // watcher scripts, and the state of the restart gate. A whitelist that refused
  // them threw the answer away on the very next boot — the record existed, but
  // could not be read.
  'watcherHygiene',
  'restartGate',
  'updatedAt',
  'profileDir',
]);

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @param {string} fallback */
function strOr(value, fallback = null) {
  return typeof value === 'string' ? value : fallback;
}

/** @param {unknown} value */
function nullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * @param {string} sessionId
 * @param {number} now
 * @returns {object} a fresh entry with the documented default shape
 */
function defaultEntry(sessionId, now = Date.now()) {
  return {
    sessionId,
    updatedAt: now,
    running: false,
    runningSince: null,
    interrupted: false,
    interruptedAt: null,
    pendingResume: false,
    pendingSince: null,
    reasons: [],
    goal: null,
    resumeAttempts: 0,
    lastResumeAt: null,
    lastResumeError: null,
    lastRecoveryAction: null,
    lastRecoveryDetail: null,
  };
}

/**
 * @param {number} [now]
 * @returns {object} an empty, valid state document
 */
export function createEmptyState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    bootId: null,
    bootPid: null,
    bootStartedAt: null,
    generation: 0,
    phase: 'idle',
    // WHICH STAGE THE RESTART IS IN (see lib/restart-phase.js): null when no
    // restart is under way, otherwise `{ phase, startedAt, at, progress }`.
    // It lives in the checkpoint (not in memory) so the interface can read it
    // out of the state route from the very first moment after the click.
    restartPhase: null,
    restart: null,
    sessions: {},
    seenFeatureVersions: {},
    onboarding: null,
    sleep: null,
    // THE PROFILE DIRECTORY THIS HOST BOOTED WITH (2026-11-03, t72): the
    // arming reads it back when the manifest cannot be parsed any more.
    profileDir: null,
    updatedAt: now,
  };
}

/**
 * Coerce the recorded restart stage into the documented shape.
 *
 * A record that does not describe one of the four stages is dropped: a broken
 * stage must never leave a spinner on screen for ever.
 *
 * @param {unknown} raw
 * @param {number} now
 * @returns {{ record: object|null, changed: boolean }}
 */
function normalizeRestartPhase(raw, now) {
  if (raw == null) return { record: null, changed: false };
  if (!isObject(raw)) return { record: null, changed: true };
  if (!RESTART_PHASES.includes(raw.phase)) return { record: null, changed: true };
  const startedAt = isFiniteNumber(raw.startedAt) ? raw.startedAt : now;
  const at = isFiniteNumber(raw.at) ? raw.at : startedAt;
  let progress = null;
  let changed = !isFiniteNumber(raw.startedAt) || !isFiniteNumber(raw.at);
  if (isObject(raw.progress)) {
    progress = {
      files: isFiniteNumber(raw.progress.files) ? Math.max(0, Math.trunc(raw.progress.files)) : 0,
      bytes: isFiniteNumber(raw.progress.bytes) ? Math.max(0, Math.trunc(raw.progress.bytes)) : 0,
      total: isFiniteNumber(raw.progress.total) ? Math.max(0, Math.trunc(raw.progress.total)) : 0,
      filesTotal: isFiniteNumber(raw.progress.filesTotal) ? Math.max(0, Math.trunc(raw.progress.filesTotal)) : 0,
      at: isFiniteNumber(raw.progress.at) ? raw.progress.at : at,
    };
  } else if (raw.progress != null) {
    changed = true;
  }
  const record = {
    phase: raw.phase,
    startedAt,
    at,
    progress,
    // HOW BIG THE PRE-RESTART BACKUP WAS. It is kept across the stage change on
    // purpose: a hosted profile can be 92 KB and the copy takes ~5 ms, so a page
    // that polls every 2 s would otherwise never learn that a backup happened
    // (user report, 2026-10-29). null = nothing was measured.
    snapshotBytes: isFiniteNumber(raw.snapshotBytes) ? Math.max(0, Math.trunc(raw.snapshotBytes)) : null,
    // WHY the stage is what it is ("deferred: conversation-active", "snapshot
    // done", …). A stage without a reason cannot be diagnosed after the fact —
    // and the hang this fixes was exactly an unexplained leftover stage.
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
    blocked: isFiniteNumber(raw.blocked) ? Math.max(0, Math.trunc(raw.blocked)) : 0,
  };
  return { record, changed };
}

/**
 * Record the stage the restart is in — the ONE thing the interface reads.
 *
 * Writing it is deliberately cheap and synchronous: it is called the moment the
 * user clicks, before any backup starts, so the first stage is on disk in
 * milliseconds rather than after ten seconds of copying.
 *
 * @param {object} state the checkpoint state (mutated in place)
 * @param {{ phase: string, now?: number, blocked?: number, restartStage?: boolean }} options
 * @returns {object|null} the recorded stage
 */
export function setRestartPhase(state, {
  phase,
  now = Date.now(),
  blocked = 0,
  restartStage = true,
  reason = null,
  // undefined = carry what the record already measured, null = forget it, a
  // number = this is the size of the snapshot this restart already paid for.
  snapshotBytes,
} = {}) {
  if (!isObject(state)) return null;
  if (!RESTART_PHASES.includes(phase)) return state.restartPhase ?? null;
  const moment = isFiniteNumber(now) ? now : Date.now();
  const previous = isObject(state.restartPhase) ? state.restartPhase : null;
  // A new restart starts its own clock; a stage change inside the same restart
  // keeps the start time, so "elapsed" is the whole restart and not one stage.
  const sameRestart = restartStage && previous !== null && RESTART_PHASES.includes(previous.phase)
    && !(phase === 'waiting' && previous.phase !== 'waiting');
  const startedAt = sameRestart ? previous.startedAt : moment;
  // THE SIZE OF THE SNAPSHOT, measured once and then CARRIED: the live byte
  // counter while the copy runs, the final size afterwards. A 92 KB profile is
  // copied in ~5 ms, so this number is the only thing a polling interface can
  // still say about a backup that really happened (user report, 2026-10-29).
  const measuredBytes = previous !== null && isFiniteNumber(previous.snapshotBytes)
    ? Math.max(0, Math.trunc(previous.snapshotBytes))
    : (previous !== null && isObject(previous.progress) && isFiniteNumber(previous.progress.bytes)
      ? Math.max(0, Math.trunc(previous.progress.bytes))
      : null);
  const record = {
    phase,
    startedAt,
    at: moment,
    // The progress of a previous stage is meaningless in the next one: the
    // snapshot numbers must not be shown while the host is restarting.
    progress: phase === 'snapshotting' && previous !== null && previous.phase === 'snapshotting'
      ? previous.progress
      : null,
    // A NEW restart starts with nothing measured; a stage change inside one
    // restart keeps the size it already has — and a caller that knows the size
    // (the request's own snapshot) may state it explicitly.
    snapshotBytes: snapshotBytes === null
      ? null
      : (isFiniteNumber(snapshotBytes) ? Math.max(0, Math.trunc(snapshotBytes)) : (sameRestart ? measuredBytes : null)),
    // WHY this stage (see normalizeRestartPhase): "deferred: <reason>" is what
    // tells a reader that the restart went back to waiting on purpose.
    reason: typeof reason === 'string' && reason !== '' ? reason : null,
    blocked: isFiniteNumber(blocked) ? Math.max(0, Math.trunc(blocked)) : 0,
  };
  state.restartPhase = record;
  state.updatedAt = moment;
  return record;
}

/**
 * Update the REAL snapshot progress (files and bytes that were copied).
 *
 * @param {object} state the checkpoint state (mutated in place)
 * @param {{ files?: number, bytes?: number, total?: number, filesTotal?: number, now?: number }} progress
 * @returns {object|null} the recorded stage
 */
export function setRestartProgress(state, { files = 0, bytes = 0, total = 0, filesTotal = 0, now = Date.now() } = {}) {
  if (!isObject(state)) return null;
  const moment = isFiniteNumber(now) ? now : Date.now();
  const previous = isObject(state.restartPhase) ? state.restartPhase : null;
  const number = (value) => (isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0);
  state.restartPhase = {
    phase: 'snapshotting',
    startedAt: previous !== null && isFiniteNumber(previous.startedAt) ? previous.startedAt : moment,
    at: moment,
    progress: {
      files: number(files),
      bytes: number(bytes),
      total: number(total),
      filesTotal: number(filesTotal),
      at: moment,
    },
    // The live byte counter IS the size of the snapshot so far: keeping it here
    // means the number survives the moment the copy ends.
    snapshotBytes: number(bytes),
    reason: previous !== null && typeof previous.reason === 'string' ? previous.reason : null,
    blocked: previous !== null && isFiniteNumber(previous.blocked) ? previous.blocked : 0,
  };
  state.updatedAt = moment;
  return state.restartPhase;
}

/**
 * Forget the stage (the restart was cancelled, or it failed before exiting).
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {boolean} whether a stage was cleared
 */
export function clearRestartPhase(state, { now = Date.now() } = {}) {
  if (!isObject(state)) return false;
  if (state.restartPhase == null) return false;
  state.restartPhase = null;
  state.updatedAt = isFiniteNumber(now) ? now : Date.now();
  return true;
}

/**
 * Normalize the record of the one-time questions.
 *
 * The record is `{ feature, version, answeredAt, choice }`: WHICH question was
 * answered (the id of the feature), the version of the question, when it was
 * answered, and WHAT the user chose.
 *
 * A broken record is DROPPED: a question whose answer cannot be read is
 * asked again — that is much better than a card that never comes back
 * because of a half-written file.
 *
 * @param {unknown} raw
 * @returns {{ onboarding: object|null, changed: boolean }}
 */
function normalizeOnboarding(raw) {
  if (raw == null) return { onboarding: null, changed: false };
  if (!isObject(raw)) return { onboarding: null, changed: true };
  const feature = nullableString(raw.feature);
  const version = nullableString(raw.version);
  const choice = nullableString(raw.choice);
  const answeredAt = nullableNumber(raw.answeredAt);
  if (feature === null || version === null || choice === null || answeredAt === null) {
    return { onboarding: null, changed: true };
  }
  // The values that were in effect BEFORE the answer: they are what the undo
  // puts back.
  const previous = isObject(raw.previous)
    ? {
      restartMode: nullableString(raw.previous.restartMode),
      restartCommand: nullableString(raw.previous.restartCommand),
    }
    : null;
  return { onboarding: { feature, version, choice, answeredAt, previous }, changed: false };
}

/**
 * Record the answer of a one-time question.
 *
 * @param {object} state the checkpoint state (mutated in place)
 * @param {{
 *   feature?: string,
 *   version?: string,
 *   choice?: string,
 *   previous?: { restartMode?: string, restartCommand?: string }|null,
 *   now?: number,
 * }} answer
 * @returns {object} the recorded answer
 */
export function recordOnboarding(state, {
  feature = '',
  version = '',
  choice = '',
  previous = null,
  now = Date.now(),
} = {}) {
  const record = {
    feature: String(feature ?? ''),
    version: String(version ?? ''),
    choice: String(choice ?? ''),
    answeredAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    previous: previous && typeof previous === 'object'
      ? {
        restartMode: typeof previous.restartMode === 'string' ? previous.restartMode : null,
        restartCommand: typeof previous.restartCommand === 'string' ? previous.restartCommand : null,
      }
      : null,
  };
  if (!state || typeof state !== 'object') return record;
  state.onboarding = record;
  return record;
}

/**
 * Normalize one persisted goal record. Unknown or wrong-typed fields are
 * dropped; `{ goal: null }` means "no goal recorded".
 * @param {unknown} raw
 * @returns {{ goal: object|null, changed: boolean }}
 */
function normalizeGoal(raw) {
  if (!isObject(raw)) {
    return { goal: null, changed: raw !== null && raw !== undefined };
  }
  let changed = false;
  for (const key of Object.keys(raw)) if (!GOAL_KEYS.has(key)) changed = true;

  const goal = {
    goalId: nullableString(raw.goalId),
    goalRevision: nullableNumber(raw.goalRevision),
    phase: nullableString(raw.phase),
    updatedAt: nullableNumber(raw.updatedAt),
  };
  if (!isFiniteNumber(raw.goalRevision) && raw.goalRevision != null) changed = true;
  if (typeof raw.phase !== 'string' && raw.phase != null) changed = true;
  if (typeof raw.goalId !== 'string' && raw.goalId != null) changed = true;
  if (goal.goalId === null && goal.goalRevision === null && goal.phase === null) {
    return { goal: null, changed: true };
  }
  return { goal, changed };
}

/**
 * Normalize the LEGACY parked-goal records written by the pause-based build:
 * one entry per session whose goal that build paused. A corrupt record is
 * dropped, never thrown on.
 *
 * @param {unknown} raw
 * @returns {{ parkedGoals: object|null, changed: boolean }}
 */
function normalizeParkedGoals(raw) {
  if (!isObject(raw)) {
    return { parkedGoals: null, changed: raw !== null && raw !== undefined };
  }
  const parkedGoals = {};
  let changed = false;
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      changed = true;
      continue;
    }
    for (const key of Object.keys(value)) if (!PARKED_GOAL_KEYS.has(key)) changed = true;
    const record = {
      goalId: nullableString(value.goalId),
      parkedAt: nullableNumber(value.parkedAt),
      resumedAt: nullableNumber(value.resumedAt),
    };
    if (typeof value.goalId !== 'string' && value.goalId != null) changed = true;
    if (value.parkedAt != null && !isFiniteNumber(value.parkedAt)) changed = true;
    if (value.resumedAt != null && !isFiniteNumber(value.resumedAt)) changed = true;
    if (record.goalId === null && record.parkedAt === null && record.resumedAt === null) {
      changed = true;
      continue;
    }
    parkedGoals[sessionId] = record;
  }
  return { parkedGoals, changed };
}

/**
 * Normalize the disarmed-goal records: one entry per session whose goal this
 * plugin disarmed (and has not resumed yet). A corrupt record is dropped.
 *
 * @param {unknown} raw
 * @returns {{ disarmedGoals: object|null, changed: boolean }}
 */
function normalizeDisarmedGoals(raw) {
  if (!isObject(raw)) {
    return { disarmedGoals: null, changed: raw !== null && raw !== undefined };
  }
  const disarmedGoals = {};
  let changed = false;
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      changed = true;
      continue;
    }
    for (const key of Object.keys(value)) if (!DISARMED_GOAL_KEYS.has(key)) changed = true;
    const record = {
      goalId: nullableString(value.goalId),
      disarmedAt: nullableNumber(value.disarmedAt),
      resumedAt: nullableNumber(value.resumedAt),
      // WHY the goal was taken away. Kept like the timestamps: a record whose
      // reason survives is the difference between "it was disarmed" and "it was
      // disarmed because a restart was queued".
      reason: nullableString(value.reason),
    };
    if (typeof value.goalId !== 'string' && value.goalId != null) changed = true;
    if (value.disarmedAt != null && !isFiniteNumber(value.disarmedAt)) changed = true;
    if (value.resumedAt != null && !isFiniteNumber(value.resumedAt)) changed = true;
    // A reason that is not a string is not a readable reason: drop the value
    // (the field itself is known, so this is not "an unknown key").
    if (typeof value.reason !== 'string' && value.reason != null) {
      record.reason = null;
      changed = true;
    }
    if (record.goalId === null && record.disarmedAt === null && record.resumedAt === null) {
      changed = true;
      continue;
    }
    disarmedGoals[sessionId] = record;
  }
  return { disarmedGoals, changed };
}

/**
 * Normalize the record of the feature announcements the user has already seen.
 *
 * The shape is `{ [feature]: version }`: the id of the feature and the version
 * of the plugin that announced it. A record whose version is not a string is
 * dropped — an unreadable record must never hide an announcement for ever,
 * so a broken entry makes the announcement show up again instead.
 *
 * @param {unknown} raw
 * @returns {{ seenFeatureVersions: Record<string, string>, changed: boolean }}
 */
function normalizeSeenFeatureVersions(raw) {
  if (!isObject(raw)) {
    return { seenFeatureVersions: {}, changed: raw !== null && raw !== undefined };
  }
  const seenFeatureVersions = {};
  let changed = false;
  for (const [feature, version] of Object.entries(raw)) {
    if (typeof version !== 'string' || version === '') {
      changed = true;
      continue;
    }
    seenFeatureVersions[feature] = version;
  }
  return { seenFeatureVersions, changed };
}

/**
 * Normalize the recorded shutdown intent.
 *
 * The intent is the user's "shut the machine down when the work is done" — it
 * has to survive a restart, so it lives in the checkpoint file. A record that
 * is broken is DROPPED: asking the user once more is much better than a
 * machine that switches itself off for ever because of a half-written file.
 *
 * @param {unknown} raw
 * @returns {{ sleep: { armed: true, armedAt: number, countdownSeconds: number|null }|null, changed: boolean }}
 */
function normalizeSleep(raw) {
  if (raw == null) return { sleep: null, changed: false };
  if (!isObject(raw)) return { sleep: null, changed: true };
  if (raw.armed !== true) return { sleep: null, changed: true };
  const armedAt = isFiniteNumber(raw.armedAt) ? raw.armedAt : null;
  if (armedAt === null) return { sleep: null, changed: true };
  const countdownSeconds = isFiniteNumber(raw.countdownSeconds) && raw.countdownSeconds >= 0
    ? Math.trunc(raw.countdownSeconds)
    : null;
  return {
    sleep: { armed: true, armedAt, countdownSeconds },
    changed: raw.countdownSeconds !== countdownSeconds,
  };
}

/**
 * Normalize the handoff record of a session: `{ handedOffTo, handoffAt, carriedChars }`.
 * A missing record stays `null`; a corrupt one is dropped instead of being thrown on.
 *
 * @param {unknown} raw
 * @returns {{ handoff: object|null, changed: boolean }}
 */
function normalizeHandoff(raw) {
  if (raw == null) return { handoff: null, changed: false };
  if (!isObject(raw)) return { handoff: null, changed: true };
  let changed = false;
  for (const key of Object.keys(raw)) if (!HANDOFF_KEYS.has(key)) changed = true;
  const handoff = {
    handedOffTo: nullableString(raw.handedOffTo),
    handoffAt: nullableNumber(raw.handoffAt),
    carriedChars: isFiniteNumber(raw.carriedChars) ? Math.trunc(raw.carriedChars) : null,
  };
  if (raw.carriedChars != null && !isFiniteNumber(raw.carriedChars)) changed = true;
  if (handoff.handedOffTo === null && handoff.handoffAt === null) return { handoff: null, changed: true };
  return { handoff, changed };
}

/**
 * Normalize the recorded context-overflow verdict of a session.
 *
 * @param {unknown} raw
 * @returns {{ contextOverflow: object|null, changed: boolean }}
 */
function normalizeContextOverflow(raw) {
  if (raw == null) return { contextOverflow: null, changed: false };
  if (!isObject(raw)) return { contextOverflow: null, changed: true };
  let changed = false;
  for (const key of Object.keys(raw)) if (!CONTEXT_OVERFLOW_KEYS.has(key)) changed = true;
  if (raw.over !== true) return { contextOverflow: null, changed: true };
  const contextOverflow = {
    over: true,
    inputTokens: nullableNumber(raw.inputTokens),
    contextWindow: nullableNumber(raw.contextWindow),
    detail: nullableString(raw.detail),
    detectedAt: nullableNumber(raw.detectedAt),
  };
  return { contextOverflow, changed };
}

/**
 * Normalize one persisted session entry.
 * @param {unknown} raw
 * @param {string} sessionId
 * @param {number} now
 * @returns {{ entry: object, changed: boolean }}
 */
function normalizeEntry(raw, sessionId, now) {
  const entry = defaultEntry(sessionId, now);
  if (!isObject(raw)) return { entry, changed: raw !== undefined };
  let changed = false;
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) changed = true;

  if (typeof raw.sessionId === 'string' && raw.sessionId) entry.sessionId = raw.sessionId;
  else if (raw.sessionId != null) changed = true;

  if (isFiniteNumber(raw.updatedAt)) entry.updatedAt = raw.updatedAt;
  else if (raw.updatedAt != null) changed = true;

  for (const key of ['running', 'interrupted', 'pendingResume']) {
    if (typeof raw[key] === 'boolean') entry[key] = raw[key];
    else if (raw[key] != null) changed = true;
  }

  for (const key of ['runningSince', 'interruptedAt', 'pendingSince', 'lastResumeAt']) {
    const value = nullableNumber(raw[key]);
    if (value !== null) entry[key] = value;
    else if (raw[key] != null) changed = true;
  }

  if (isFiniteNumber(raw.resumeAttempts) && raw.resumeAttempts >= 0) {
    entry.resumeAttempts = Math.trunc(raw.resumeAttempts);
  } else if (raw.resumeAttempts != null) {
    changed = true;
  }

  if (typeof raw.lastResumeError === 'string' && raw.lastResumeError.length > 0) {
    entry.lastResumeError = raw.lastResumeError;
  } else if (raw.lastResumeError != null) {
    changed = true;
  }

  for (const key of ['lastRecoveryAction', 'lastRecoveryDetail']) {
    if (typeof raw[key] === 'string' && raw[key].length > 0) entry[key] = raw[key];
    else if (raw[key] != null) changed = true;
  }

  if (Array.isArray(raw.reasons)) {
    const reasons = raw.reasons.filter((r) => typeof r === 'string' && r.length > 0);
    if (reasons.length !== raw.reasons.length) changed = true;
    entry.reasons = reasons.slice(-ENTRY_REASONS_LIMIT);
  } else if (raw.reasons != null) {
    changed = true;
  }

  const goal = normalizeGoal(raw.goal);
  entry.goal = goal.goal;
  if (goal.changed) changed = true;

  // Handoff / overflow records are only present when they were written: the
  // default entry shape stays as it was, so an older checkpoint reads unchanged.
  const handoff = normalizeHandoff(raw.handoff);
  if (handoff.handoff !== null) entry.handoff = handoff.handoff;
  if (handoff.changed) changed = true;

  const contextOverflow = normalizeContextOverflow(raw.contextOverflow);
  if (contextOverflow.contextOverflow !== null) entry.contextOverflow = contextOverflow.contextOverflow;
  if (contextOverflow.changed) changed = true;

  return { entry, changed };
}

/**
 * Normalize one restart requester record.
 *
 * @param {unknown} raw
 * @returns {{ sessionId: string, requestedAt: number, reason: string|null, resume: boolean }|null}
 *   `null` when the record is unusable (invalid entries are dropped).
 */
function normalizeRequester(raw) {
  if (!isObject(raw)) return null;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null;
  if (!sessionId) return null;
  return {
    sessionId,
    requestedAt: isFiniteNumber(raw.requestedAt) ? raw.requestedAt : 0,
    reason: nullableString(raw.reason),
    resume: raw.resume !== false,
  };
}

/**
 * Normalize the list of sessions that requested the current restart cycle.
 * Invalid and duplicate entries are dropped; the newest requester comes first.
 *
 * @param {unknown} raw
 * @returns {{ sessionId: string, requestedAt: number, reason: string|null, resume: boolean }[]}
 */
function normalizeRequesters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const requester = normalizeRequester(item);
    if (!requester || seen.has(requester.sessionId)) continue;
    seen.add(requester.sessionId);
    out.push(requester);
    if (out.length >= REQUESTERS_LIMIT) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ restart: object|null, changed: boolean }}
 */
/**
 * Coerce the "this request already took a snapshot" record.
 *
 * It is a pointer plus the numbers of that copy, and nothing else: the profile
 * itself lives in the backup directory, which is checked against the manifest
 * before it is used again.
 *
 * @param {unknown} raw
 * @returns {{ requestedAt: number, dir: string, profileDir: string|null, files: number, bytes: number, total: number, at: number }|null}
 */
function normalizeRestartSnapshot(raw) {
  if (!isObject(raw)) return null;
  if (typeof raw.dir !== 'string' || raw.dir === '') return null;
  const number = (value) => (isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0);
  return {
    requestedAt: number(raw.requestedAt),
    dir: raw.dir,
    profileDir: typeof raw.profileDir === 'string' && raw.profileDir !== '' ? raw.profileDir : null,
    files: number(raw.files),
    bytes: number(raw.bytes),
    total: number(raw.total),
    at: number(raw.at),
  };
}

function normalizeRestart(raw) {
  if (!isObject(raw)) return { restart: null, changed: raw !== null && raw !== undefined };
  let changed = false;
  for (const key of Object.keys(raw)) if (!RESTART_KEYS.has(key)) changed = true;

  const requesters = normalizeRequesters(raw.requesters);
  const restart = {
    generation: isFiniteNumber(raw.generation) && raw.generation >= 0 ? Math.trunc(raw.generation) : 0,
    requestedAt: isFiniteNumber(raw.requestedAt) ? raw.requestedAt : 0,
    reason: nullableString(raw.reason),
    bySessionId: nullableString(raw.bySessionId),
    resume: typeof raw.resume === 'boolean' ? raw.resume : true,
    attempt: isFiniteNumber(raw.attempt) && raw.attempt >= 0 ? Math.trunc(raw.attempt) : 0,
    softWarned: raw.softWarned === true,
    failedAttempts: isFiniteNumber(raw.failedAttempts) && raw.failedAttempts >= 0 ? Math.trunc(raw.failedAttempts) : 0,
    notBefore: isFiniteNumber(raw.notBefore) && raw.notBefore >= 0 ? raw.notBefore : 0,
    requesters,
    // Disarming the goals of goal-driven sessions is the default: a restart must
    // never deadlock behind a goal that keeps its own agent busy.
    parkGoals: raw.parkGoals !== false,
    // A restart that must not snapshot (the one that follows a manual rollback,
    // user decision 2026-11-02). It defaults to FALSE: every other restart keeps
    // taking its copy, and only a request that says so in bytes skips it.
    skipBackup: raw.skipBackup === true,
  };
  // The snapshot is only carried when there IS one: a checkpoint that never took
  // a snapshot must normalize to exactly the object it was.
  const snapshot = normalizeRestartSnapshot(raw.snapshot);
  if (snapshot !== null) restart.snapshot = snapshot;
  else if (raw.snapshot != null) changed = true;
  if (!isFiniteNumber(raw.generation) || raw.generation < 0) changed = true;
  if (!isFiniteNumber(raw.requestedAt)) changed = true;
  if (!isFiniteNumber(raw.attempt) || raw.attempt < 0) changed = true;
  if (raw.failedAttempts != null && (!isFiniteNumber(raw.failedAttempts) || raw.failedAttempts < 0)) changed = true;
  if (raw.notBefore != null && !isFiniteNumber(raw.notBefore)) changed = true;
  if (typeof raw.parkGoals !== 'boolean' && raw.parkGoals != null) changed = true;
  if (typeof raw.skipBackup !== 'boolean' && raw.skipBackup != null) changed = true;
  if (typeof raw.resume !== 'boolean' && raw.resume != null) changed = true;
  if (raw.requesters != null && !Array.isArray(raw.requesters)) changed = true;
  if (Array.isArray(raw.requesters) && requesters.length !== raw.requesters.length) changed = true;
  return { restart, changed };
}

/**
 * Coerce arbitrary JSON into a valid state document without ever throwing.
 *
 * @param {unknown} raw parsed JSON (or anything else)
 * @param {number} [now]
 * @returns {{ state: object, repaired: boolean }} `repaired` is true when any
 *   field was dropped, defaulted or retyped (the caller may want to rewrite).
 */
export function normalizeState(raw, now = Date.now()) {
  const state = createEmptyState(now);
  if (!isObject(raw)) {
    return { state, repaired: raw !== undefined };
  }
  let repaired = false;
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) repaired = true;

  if (raw.version !== STATE_VERSION) repaired = true;

  if (typeof raw.bootId === 'string' && raw.bootId) state.bootId = raw.bootId;
  else if (raw.bootId != null) repaired = true;

  if (isFiniteNumber(raw.bootPid)) state.bootPid = Math.trunc(raw.bootPid);
  else if (raw.bootPid != null) repaired = true;

  if (isFiniteNumber(raw.bootStartedAt)) state.bootStartedAt = raw.bootStartedAt;
  else if (raw.bootStartedAt != null) repaired = true;

  if (isFiniteNumber(raw.generation) && raw.generation >= 0) state.generation = Math.trunc(raw.generation);
  else if (raw.generation != null) repaired = true;

  if (typeof raw.phase === 'string' && PHASES.includes(raw.phase)) state.phase = raw.phase;
  else if (raw.phase != null) repaired = true;

  if (raw.restartPhase != null) {
    const recorded = normalizeRestartPhase(raw.restartPhase, now);
    state.restartPhase = recorded.record;
    if (recorded.changed) repaired = true;
  }

  if (isFiniteNumber(raw.updatedAt)) state.updatedAt = raw.updatedAt;
  else if (raw.updatedAt != null) repaired = true;

  if (raw.profileDir != null) {
    const fact = normalizeProfileDirFact(raw.profileDir);
    state.profileDir = fact;
    if (fact === null) repaired = true;
  }

  if (raw.restart != null) {
    const restart = normalizeRestart(raw.restart);
    state.restart = restart.restart;
    if (restart.changed) repaired = true;
  }

  if (isObject(raw.sessions)) {
    for (const [sessionId, value] of Object.entries(raw.sessions)) {
      const normalized = normalizeEntry(value, sessionId, now);
      state.sessions[sessionId] = normalized.entry;
      if (normalized.changed) repaired = true;
    }
  } else if (raw.sessions != null) {
    repaired = true;
  }

  // LEGACY: records written by the pause-based build. Kept verbatim so the
  // goals that build paused can still be resumed after the next boot.
  if (raw.parkedGoals != null) {
    const parked = normalizeParkedGoals(raw.parkedGoals);
    state.parkedGoals = parked.parkedGoals;
    if (parked.changed) repaired = true;
  }

  if (raw.disarmedGoals != null) {
    const disarmed = normalizeDisarmedGoals(raw.disarmedGoals);
    state.disarmedGoals = disarmed.disarmedGoals;
    if (disarmed.changed) repaired = true;
  }

  // The record of the feature announcements the user has already seen. It
  // survives a restart of the Host: an announcement that was shown once must
  // not come back with the next boot.
  if (raw.seenFeatureVersions != null) {
    const seen = normalizeSeenFeatureVersions(raw.seenFeatureVersions);
    state.seenFeatureVersions = seen.seenFeatureVersions;
    if (seen.changed) repaired = true;
  }

  // The recorded shutdown intent: it has to survive a restart, so the machine
  // goes off AFTER the restart and the work that resumed with it.
  if (raw.sleep != null) {
    const sleep = normalizeSleep(raw.sleep);
    state.sleep = sleep.sleep;
    if (sleep.changed) repaired = true;
  }

  // The answer of the one-time questions: it has to survive a restart, so a
  // question is never asked twice.
  if (raw.onboarding != null) {
    const onboarding = normalizeOnboarding(raw.onboarding);
    state.onboarding = onboarding.onboarding;
    if (onboarding.changed) repaired = true;
  }

  // THE FIRST SAFE COPY: what happened when this machine looked for a
  // known-good backup and found none. It survives a restart, so a machine with
  // NO safe copy can say so instead of looking healthy.
  if (raw.firstInstallBackup != null) {
    const seeded = normalizeFirstInstallBackup(raw.firstInstallBackup);
    if (seeded === null) repaired = true;
    else state.firstInstallBackup = seeded;
  }

  // THE SWEEP OF LEFTOVER WATCHER SCRIPTS: which files this platform could not
  // run and therefore removed. It survives a restart, so "leftover files = 0"
  // stays provable instead of being re-derived from an empty directory.
  if (raw.watcherHygiene != null) {
    const hygiene = normalizeWatcherHygiene(raw.watcherHygiene);
    if (hygiene === null) repaired = true;
    else state.watcherHygiene = hygiene;
  }

  // THE RESTART GATE: why the restart is (or is not) allowed right now. It is a
  // REPORT, not a permission — the live gate decides every time — but the answer
  // of the boot that wrote it must survive to the next boot.
  if (raw.restartGate != null) {
    const gate = normalizeRestartGate(raw.restartGate);
    if (gate === null) repaired = true;
    else state.restartGate = gate;
  }

  return { state, repaired };
}

/**
 * Normalize the report of the legacy-watcher sweep.
 *
 * A value that is not an object says nothing about the sweep, so it is dropped
 * (and the caller marks the state as repaired).
 *
 * @param {unknown} raw
 * @returns {{ skipped: boolean, reason: string|null, removed: string[], kept: string[], scanned: number, error: string|null }|null}
 */
function normalizeWatcherHygiene(raw) {
  if (!isObject(raw)) return null;
  /** @param {unknown} value */
  const names = (value) => (Array.isArray(value)
    ? value.filter((name) => typeof name === 'string' && name !== '')
    : []);
  return {
    skipped: raw.skipped === true,
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
    removed: names(raw.removed),
    kept: names(raw.kept),
    scanned: isFiniteNumber(raw.scanned) && raw.scanned >= 0 ? Math.trunc(raw.scanned) : 0,
    error: typeof raw.error === 'string' && raw.error !== '' ? raw.error : null,
  };
}

/**
 * Normalize the report of the restart gate.
 *
 * `allow` and `reason` are the answer; without both there is nothing to read, so
 * the record is dropped. `blockedBy` names the sessions that were in the way.
 *
 * @param {unknown} raw
 * @returns {{ allow: boolean, reason: string, blockedBy: Array<{ sessionId: string|null, reason: string }>, quietForMs: number }|null}
 */
function normalizeRestartGate(raw) {
  if (!isObject(raw)) return null;
  const reason = typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null;
  if (typeof raw.allow !== 'boolean' || reason === null) return null;
  const blockedBy = Array.isArray(raw.blockedBy)
    ? raw.blockedBy.filter((entry) => isObject(entry)).map((entry) => ({
      sessionId: typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : null,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    }))
    : [];
  return {
    allow: raw.allow,
    reason,
    blockedBy,
    quietForMs: isFiniteNumber(raw.quietForMs) && raw.quietForMs >= 0 ? raw.quietForMs : 0,
  };
}

/**
 * Normalize the record of the first-install safe copy.
 *
 * A record without a `result` says nothing, so it is dropped (and the caller
 * marks the state as repaired).
 *
 * @param {unknown} raw
 * @returns {{ result: string, at: number|null, dir: string|null, bytes: number|null, error: string|null }|null}
 */
function normalizeFirstInstallBackup(raw) {
  if (!isObject(raw)) return null;
  const result = typeof raw.result === 'string' && raw.result !== '' ? raw.result : null;
  if (result === null) return null;
  return {
    result,
    at: isFiniteNumber(raw.at) ? raw.at : null,
    dir: typeof raw.dir === 'string' && raw.dir !== '' ? raw.dir : null,
    bytes: isFiniteNumber(raw.bytes) ? raw.bytes : null,
    error: typeof raw.error === 'string' && raw.error !== '' ? raw.error : null,
  };
}

/**
 * Read a checkpoint from disk. Never throws and never creates directories.
 *
 * @param {string} filePath
 * @param {number} [now]
 * @returns {{ state: object, existed: boolean, corrupt: boolean, error: string|null, repaired: boolean }}
 *   `corrupt` is true only when the file exists but cannot be parsed; a
 *   missing file returns a fresh state with `existed: false`.
 */
export function readState(filePath, now = Date.now()) {
  let existed = false;
  let corrupt = false;
  let error = null;
  let raw = null;
  let parsed = false;

  try {
    const text = fs.readFileSync(filePath, 'utf8');
    existed = true;
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
      parsed = true;
    } catch (parseError) {
      corrupt = true;
      error = String(parseError && parseError.message ? parseError.message : parseError);
    }
  } catch (readError) {
    error = String(readError && readError.message ? readError.message : readError);
    if (readError && readError.code !== 'ENOENT') corrupt = true;
    try {
      existed = fs.existsSync(filePath);
    } catch {
      existed = false;
    }
    if (!existed) error = null;
  }

  if (!parsed) {
    return { state: createEmptyState(now), existed, corrupt, error, repaired: corrupt };
  }

  const normalized = normalizeState(raw, now);
  return {
    state: normalized.state,
    existed,
    corrupt,
    error,
    repaired: normalized.repaired,
  };
}

/**
 * Atomically persist a checkpoint. Creates the parent directory recursively.
 * Throws only on real I/O errors, and cleans up its temporary file when the
 * write or rename fails.
 *
 * @param {string} filePath
 * @param {object} state
 * @param {number} [now]
 * @returns {object} the same `state` (with `updatedAt` refreshed)
 */
export function writeState(filePath, state, now = Date.now()) {
  if (!isObject(state)) throw new TypeError('writeState requires a state object');
  state.updatedAt = now;

  // Serialize before touching the filesystem: a JSON failure must not leave a
  // limbo temp file behind.
  const payload = `${JSON.stringify(state, null, 2)}\n`;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      try {
        fs.fsyncSync(fd);
      } catch {
        /* fsync is a durability nicety, not a correctness requirement */
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
  return state;
}

/**
 * Register the current boot. A different `pid` means DSH was restarted, so any
 * session that was still running is converted into a pending resume.
 * Mutates `state` in place and returns `{ state, isNewBoot }`.
 *
 * @param {object} state
 * @param {{ pid: number, now?: number }} options
 * @returns {{ state: object, isNewBoot: boolean }}
 */
export function beginBoot(state, { pid, now = Date.now() } = {}) {
  const samePid = state.bootPid != null && state.bootPid === pid;
  if (samePid) return { state, isNewBoot: false };

  state.bootId = randomUUID();
  state.bootPid = pid == null ? null : pid;
  state.bootStartedAt = now;
  state.updatedAt = now;

  if (isObject(state.sessions)) {
    for (const entry of Object.values(state.sessions)) {
      if (!isObject(entry) || entry.running !== true) continue;
      entry.running = false;
      entry.runningSince = null;
      entry.interrupted = true;
      entry.interruptedAt = now;
      entry.pendingResume = true;
      entry.pendingSince = now;
      entry.updatedAt = now;
    }
  }

  return { state, isNewBoot: true };
}

/**
 * Get (or lazily create) the checkpoint entry for a session.
 * Mutates `state` in place.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {object} the entry
 */
export function entryFor(state, sessionId) {
  if (!isObject(state.sessions)) state.sessions = {};
  let entry = state.sessions[sessionId];
  if (!isObject(entry)) {
    entry = defaultEntry(sessionId, Date.now());
    state.sessions[sessionId] = entry;
  }
  return entry;
}

/** @param {object} entry @param {string} reason */
function pushReason(entry, reason) {
  if (!Array.isArray(entry.reasons)) entry.reasons = [];
  if (entry.reasons[entry.reasons.length - 1] === reason) return;
  entry.reasons.push(reason);
  if (entry.reasons.length > ENTRY_REASONS_LIMIT) {
    entry.reasons.splice(0, entry.reasons.length - ENTRY_REASONS_LIMIT);
  }
}

/**
 * Mark a session as actively running an agent turn.
 *
 * `pendingResume` / `pendingSince` are deliberately NOT cleared: a session that
 * asked for a restart and keeps working (or receives a new message) must still
 * be resumed once the host comes back.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ sessionId: string, goalId?: string|null, goalRevision?: number|null, reason?: string, now?: number }} options
 * @returns {object} state
 */
export function markRunning(state, { sessionId, goalId, goalRevision, reason, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  entry.running = true;
  entry.runningSince = now;
  entry.interrupted = false;
  entry.interruptedAt = null;
  entry.updatedAt = now;
  entry.lastResumeAt = entry.lastResumeAt ?? null;

  if (goalId != null || goalRevision != null) {
    entry.goal = {
      goalId: goalId == null ? entry.goal?.goalId ?? null : String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : entry.goal?.goalRevision ?? null,
      phase: entry.goal?.phase ?? null,
      updatedAt: now,
    };
  }
  if (typeof reason === 'string' && reason.trim()) pushReason(entry, reason.trim());

  state.updatedAt = now;
  return state;
}

/**
 * Mark a session as finished/idle. Entries with no goal and no pending resume
 * are removed to keep the checkpoint small.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ now?: number }} [options]
 * @returns {object} state
 */
export function markIdle(state, sessionId, { now = Date.now() } = {}) {
  if (!sessionId || !isObject(state.sessions)) return state;
  const entry = state.sessions[sessionId];
  if (!isObject(entry)) return state;
  entry.running = false;
  entry.runningSince = null;
  entry.updatedAt = now;
  state.updatedAt = now;
  // A handoff record must survive an idle transition: it is what keeps an
  // over-limit session out of the automatic resume path forever.
  if (isObject(entry.handoff)) return state;
  if (!entry.pendingResume && !entry.goal) delete state.sessions[sessionId];
  return state;
}

/**
 * Mark a session as needing a resume after a restart/interruption.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ sessionId: string, reason?: string, goalId?: string|null, goalRevision?: number|null, now?: number }} options
 * @returns {object} state
 */
export function markPendingResume(state, { sessionId, reason, goalId, goalRevision, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  const wasPending = entry.pendingResume === true;
  entry.running = false;
  entry.runningSince = null;
  entry.pendingResume = true;
  entry.resumeAttempts = 0;
  entry.lastResumeError = null;
  entry.pendingSince = now;
  entry.updatedAt = now;

  if (typeof reason === 'string' && reason.trim()) {
    pushReason(entry, reason.trim());
    entry.interrupted = true;
    if (!wasPending || entry.interruptedAt == null) entry.interruptedAt = now;
  }
  if (goalId != null || goalRevision != null) {
    entry.goal = {
      goalId: goalId == null ? entry.goal?.goalId ?? null : String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : entry.goal?.goalRevision ?? null,
      phase: entry.goal?.phase ?? null,
      updatedAt: now,
    };
  }

  state.updatedAt = now;
  return state;
}

/**
 * Forget a session entirely.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {object} state
 */
export function clearSession(state, sessionId) {
  if (!sessionId || !isObject(state.sessions)) return state;
  if (Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) {
    delete state.sessions[sessionId];
    state.updatedAt = Date.now();
  }
  return state;
}

/**
 * Record (or clear, with `goalId: null`) the goal attached to a session.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ goalId?: string|null, goalRevision?: number|null, phase?: string|null, now?: number }} options
 * @returns {object} state
 */
export function setGoal(state, sessionId, { goalId, goalRevision = null, phase = null, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  if (goalId == null) {
    entry.goal = null;
  } else {
    entry.goal = {
      goalId: String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : null,
      phase: typeof phase === 'string' ? phase : null,
      updatedAt: now,
    };
  }
  entry.updatedAt = now;
  state.updatedAt = now;
  return state;
}

/**
 * Record what the last recovery attempt did for a session. This is the
 * self-reporting half of the boot recovery: every attempt (including a plain
 * early return) leaves an action plus a short detail behind, so
 * `continuum_status` can explain why a session did not continue.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ action?: string|null, detail?: string|null, now?: number }} options
 * @returns {object} state
 */
export function setRecoveryOutcome(state, sessionId, { action = null, detail = null, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  entry.lastRecoveryAction = typeof action === 'string' && action.length > 0 ? action : null;
  entry.lastRecoveryDetail = typeof detail === 'string' && detail.length > 0 ? detail : null;
  entry.updatedAt = now;
  state.updatedAt = now;
  return state;
}

/**
 * Record that this plugin DISARMED the goal of a session before a restart.
 *
 * A disarmed goal stays durably `active`; the record only exists so the next
 * boot knows that re-arming it is safe and so `continuum_status` can report
 * what happened. It is REPORTING ONLY: it never decides whether a goal may be
 * disarmed (that is decided on the live goal state).
 *
 * The record of a session is OVERWRITTEN: a new disarm replaces the previous
 * one (kind `disarmed`, the new disarm timestamp, `resumedAt: null`), and the
 * LEGACY parked record of that session is dropped, so a record left over from
 * the pause-based build can never block a later disarm.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ goalId?: string|null, disarmedAt?: number }} [options]
 * @returns {object} state
 */
export function setDisarmedGoal(state, sessionId, { goalId = null, disarmedAt = Date.now() } = {}) {
  if (!sessionId) return state;
  if (!isObject(state.disarmedGoals)) state.disarmedGoals = {};
  state.disarmedGoals[String(sessionId)] = {
    goalId: goalId == null ? null : String(goalId),
    disarmedAt: isFiniteNumber(disarmedAt) ? disarmedAt : Date.now(),
    resumedAt: null,
  };
  // The current shape supersedes the LEGACY one for this session: one session
  // has ONE goal record, so a stale legacy record can never linger next to it.
  if (isObject(state.parkedGoals)) delete state.parkedGoals[String(sessionId)];
  state.updatedAt = Date.now();
  return state;
}

/**
 * Stamp the goal record(s) of a session with the resume timestamp: the goal was
 * re-armed by this plugin, so the status must show it as resumed.
 *
 * Both record shapes are stamped (the current disarmed record and the LEGACY
 * parked record), because either one can describe the goal that was re-armed.
 * A session without a record simply has nothing to stamp.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ resumedAt?: number }} [options]
 * @returns {object} state
 */
export function stampResumedGoal(state, sessionId, { resumedAt = Date.now() } = {}) {
  if (!sessionId) return state;
  const at = isFiniteNumber(resumedAt) ? resumedAt : Date.now();
  let changed = false;
  for (const records of [state.disarmedGoals, state.parkedGoals]) {
    if (!isObject(records)) continue;
    const record = records[String(sessionId)];
    if (!isObject(record)) continue;
    record.resumedAt = at;
    changed = true;
  }
  if (changed) state.updatedAt = at;
  return state;
}

/**
 * Clear the disarmed record of a session: the goal was re-armed. The record is
 * kept (with `resumedAt` set) so `continuum_status` can still report whether the
 * goal came back; a later disarm of the same session overwrites it.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ resumedAt?: number }} [options]
 * @returns {object} state
 */
export function clearDisarmedGoal(state, sessionId, { resumedAt = Date.now() } = {}) {
  if (!sessionId || !isObject(state.disarmedGoals)) return state;
  const record = state.disarmedGoals[String(sessionId)];
  if (!isObject(record)) return state;
  record.resumedAt = isFiniteNumber(resumedAt) ? resumedAt : Date.now();
  state.updatedAt = Date.now();
  return state;
}

/**
 * The disarmed-goal record of a session that was not resumed yet, or null.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {{ goalId: string|null, disarmedAt: number|null, resumedAt: number|null }|null}
 */
export function disarmedRecord(state, sessionId) {
  try {
    if (!isObject(state) || !isObject(state.disarmedGoals)) return null;
    const record = state.disarmedGoals[String(sessionId)];
    if (!isObject(record)) return null;
    if (record.resumedAt !== null && record.resumedAt !== undefined) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Record that the PREVIOUS (pause-based) build parked the goal of a session.
 * Kept for one purpose: the two goals that build paused must be resumable
 * after the next boot instead of being stranded in `paused`.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ goalId?: string|null, parkedAt?: number }} [options]
 * @returns {object} state
 */
export function setParkedGoal(state, sessionId, { goalId = null, parkedAt = Date.now() } = {}) {
  if (!sessionId) return state;
  if (!isObject(state.parkedGoals)) state.parkedGoals = {};
  state.parkedGoals[String(sessionId)] = {
    goalId: goalId == null ? null : String(goalId),
    parkedAt: isFiniteNumber(parkedAt) ? parkedAt : Date.now(),
    resumedAt: null,
  };
  state.updatedAt = Date.now();
  return state;
}

/**
 * Clear the LEGACY parked state of a session: the paused goal was resumed.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ resumedAt?: number }} [options]
 * @returns {object} state
 */
export function clearParkedGoal(state, sessionId, { resumedAt = Date.now() } = {}) {
  if (!sessionId || !isObject(state.parkedGoals)) return state;
  const record = state.parkedGoals[String(sessionId)];
  if (!isObject(record)) return state;
  record.resumedAt = isFiniteNumber(resumedAt) ? resumedAt : Date.now();
  state.updatedAt = Date.now();
  return state;
}

/**
 * The LEGACY parked-goal record of a session that was not resumed yet, or null.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {{ goalId: string|null, parkedAt: number|null, resumedAt: number|null }|null}
 */
export function parkedRecord(state, sessionId) {
  try {
    if (!isObject(state) || !isObject(state.parkedGoals)) return null;
    const record = state.parkedGoals[String(sessionId)];
    if (!isObject(record)) return null;
    if (record.resumedAt !== null && record.resumedAt !== undefined) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Record that a session was HANDED OFF to a fresh session.
 *
 * The record is the durable marker that this session must never be resumed
 * automatically again: its conversation is what made every request fail with
 * "context window exceeds limit", so replaying it can only fail again. Writing
 * the record therefore also clears the resume flags (the session stops blocking
 * a restart and stops being picked up by `recoverableSessions`).
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId the OLD (handed-off) session
 * @param {{ handedOffTo?: string|null, handoffAt?: number, carriedChars?: number|null }} [options]
 * @returns {object} state
 */
export function setHandoff(state, sessionId, { handedOffTo = null, handoffAt = Date.now(), carriedChars = null } = {}) {
  if (!sessionId) return state;
  const at = isFiniteNumber(handoffAt) ? handoffAt : Date.now();
  const entry = entryFor(state, sessionId);
  entry.handoff = {
    handedOffTo: handedOffTo == null ? null : String(handedOffTo),
    handoffAt: at,
    carriedChars: isFiniteNumber(carriedChars) ? Math.trunc(carriedChars) : null,
  };
  entry.pendingResume = false;
  entry.pendingSince = null;
  entry.running = false;
  entry.runningSince = null;
  entry.interrupted = false;
  entry.updatedAt = at;
  state.updatedAt = at;
  return state;
}

/**
 * The handoff record of a session, or null.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {{ handedOffTo: string|null, handoffAt: number|null, carriedChars: number|null }|null}
 */
export function handoffRecord(state, sessionId) {
  try {
    if (!isObject(state) || !isObject(state.sessions)) return null;
    const entry = state.sessions[String(sessionId)];
    if (!isObject(entry) || !isObject(entry.handoff)) return null;
    return entry.handoff;
  } catch {
    return null;
  }
}

/**
 * Record (or clear, with `over: false`) the context-overflow verdict of a
 * session. Kept on the entry so `continuum_status` can report an over-limit
 * session even after it is no longer live.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ over?: boolean, inputTokens?: number|null, contextWindow?: number|null, detail?: string|null, detectedAt?: number }} [options]
 * @returns {object} state
 */
export function setContextOverflow(state, sessionId, { over = false, inputTokens = null, contextWindow = null, detail = null, detectedAt = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  if (over !== true) {
    entry.contextOverflow = null;
  } else {
    entry.contextOverflow = {
      over: true,
      inputTokens: nullableNumber(inputTokens),
      contextWindow: nullableNumber(contextWindow),
      detail: nullableString(detail),
      detectedAt: isFiniteNumber(detectedAt) ? detectedAt : Date.now(),
    };
  }
  state.updatedAt = Date.now();
  return state;
}

/**
 * Open a deferred restart cycle (bumps `generation` exactly once per request).
 *
 * Several sessions may ask for a restart at the same time. The requests are
 * COALESCED into one restart cycle: `generation` is bumped and `restart` is
 * replaced, but every requester is kept in `restart.requesters` (newest first,
 * one entry per distinct session id, capped at {@link REQUESTERS_LIMIT}) and
 * marked as pending resume, so the boot recovery wakes ALL of them.
 *
 * `restart.bySessionId` still holds the last requester for compatibility.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ reason?: string, bySessionId?: string|null, resume?: boolean, parkGoals?: boolean, skipBackup?: boolean, now?: number }} options
 *   `skipBackup: true` marks a restart that MUST NOT take the pre-restart
 *   snapshot. It is off by default; the manual rollback sets it (user decision,
 *   2026-11-02) because the state this restart brings up was just restored from
 *   a copy, and copying it again only makes a duplicate that squeezes the older
 *   copies out of the list.
 * @returns {object} state
 */
export function requestRestart(state, { reason, bySessionId = null, resume = true, parkGoals = true, skipBackup = false, now = Date.now() } = {}) {
  const generation = (isFiniteNumber(state.generation) && state.generation >= 0 ? state.generation : 0) + 1;
  state.generation = generation;
  state.phase = 'deferred';

  const previous = isObject(state.restart) ? state.restart : null;
  const requesters = [];
  if (previous && Array.isArray(previous.requesters)) {
    for (const item of previous.requesters) {
      const requester = normalizeRequester(item);
      if (requester && !requesters.some((entry) => entry.sessionId === requester.sessionId)) {
        requesters.push(requester);
      }
    }
  }
  const sessionId = bySessionId == null ? null : String(bySessionId);
  const reasonText = typeof reason === 'string' && reason.length > 0 ? reason : null;
  if (sessionId) {
    const kept = requesters.filter((entry) => entry.sessionId !== sessionId);
    kept.unshift({ sessionId, requestedAt: now, reason: reasonText, resume: resume !== false });
    requesters.length = 0;
    requesters.push(...kept.slice(0, REQUESTERS_LIMIT));
  }

  state.restart = {
    generation,
    requestedAt: now,
    reason: reasonText,
    bySessionId: sessionId,
    resume: resume !== false,
    attempt: 0,
    softWarned: false,
    failedAttempts: 0,
    notBefore: 0,
    requesters,
    // A goal-driven session must not deadlock the restart: disarming its goal is
    // on by default and can be turned off per restart request.
    parkGoals: parkGoals !== false,
    // THIS REQUEST ASKS FOR NO SNAPSHOT (default: it does want one). The
    // restart that carries out a manual rollback sets it, so the state that was
    // just restored is not copied on top of the list a second time.
    skipBackup: skipBackup === true,
  };
  for (const requester of requesters) {
    if (requester.resume === false) continue;
    markPendingResume(state, {
      sessionId: requester.sessionId,
      reason: requester.reason ?? 'restart-requested',
      now,
    });
  }
  state.updatedAt = now;
  return state;
}

/**
 * Abandon a deferred restart.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {object} state
 */
export function cancelRestart(state, { now = Date.now() } = {}) {
  state.restart = null;
  state.phase = 'idle';
  state.updatedAt = now;
  return state;
}

/**
 * Withdraw ONE requester from a pending restart — "cancel MY restart".
 *
 * A restart request is COALESCED: several sessions may ask for the same
 * restart cycle, and every one of them is kept in `restart.requesters`. So
 * "withdraw the restart I asked for" must NOT take the other requesters
 * with it — that is how one session could cancel everybody's restart.
 *
 * The rules:
 *
 *   - the session must be a requester; if it is not, NOTHING is changed
 *     (`reason: 'not-a-requester'`) — never a silent "cancel everything";
 *   - the session id is required (`reason: 'no-session-id'` when it is
 *     missing) — it is never guessed;
 *   - the last requester leaving really cancels the restart (`cancelled:
 *     true`), with the same cleanup as {@link cancelRestart};
 *   - while other requesters remain, the restart stays and
 *     `restart.bySessionId` is re-pointed at the first of them when it
 *     pointed at the session that just left.
 *
 * Mutates `state` in place and returns the outcome.
 *
 * @param {object} state
 * @param {{ sessionId?: string|null, now?: number }} options
 * @returns {{ removed: boolean, cancelled: boolean, remaining: number, requesters: string[], reason: string }}
 */
export function cancelOwnRestart(state, { sessionId = null, now = Date.now() } = {}) {
  const restart = isObject(state.restart) ? state.restart : null;
  if (!restart) {
    return { removed: false, cancelled: false, remaining: 0, requesters: [], reason: 'no-restart-pending' };
  }
  const requesters = normalizeRequesters(restart.requesters);
  const ids = requesters.map((entry) => entry.sessionId);
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') {
    return { removed: false, cancelled: false, remaining: ids.length, requesters: ids, reason: 'no-session-id' };
  }
  // The requester list is the truth. The legacy fallback covers a state file
  // that knows only `bySessionId` (no requesters at all).
  const inList = ids.includes(id);
  const legacyOnly = !inList && requesters.length === 0 && restart.bySessionId === id;
  if (!inList && !legacyOnly) {
    return { removed: false, cancelled: false, remaining: ids.length, requesters: ids, reason: 'not-a-requester' };
  }
  const kept = requesters.filter((entry) => entry.sessionId !== id);
  if (kept.length === 0) {
    // The LAST requester left: the restart really goes away.
    cancelRestart(state, { now });
    return { removed: true, cancelled: true, remaining: 0, requesters: [], reason: 'cancelled' };
  }
  // Other sessions are still waiting for this restart: it stays.
  restart.requesters = kept;
  if (restart.bySessionId === id) {
    restart.bySessionId = kept[0].sessionId;
  }
  state.updatedAt = now;
  return {
    removed: true,
    cancelled: false,
    remaining: kept.length,
    requesters: kept.map((entry) => entry.sessionId),
    reason: 'withdrawn',
  };
}

/**
 * Record the shutdown intent: "switch the machine off when the work is done".
 *
 * The intent lives in the checkpoint file, so it survives a restart: a
 * shutdown that is asked for while a restart is pending waits for that
 * restart (and for the sessions that resume with it) before the machine goes
 * off.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ armedAt?: number, countdownSeconds?: number|null }} [options]
 * @returns {object} state
 */
export function armSleep(state, { armedAt = Date.now(), countdownSeconds = null } = {}) {
  state.sleep = {
    armed: true,
    armedAt: isFiniteNumber(armedAt) ? armedAt : Date.now(),
    countdownSeconds: isFiniteNumber(countdownSeconds) && countdownSeconds >= 0
      ? Math.trunc(countdownSeconds)
      : null,
  };
  state.updatedAt = state.sleep.armedAt;
  return state;
}

/**
 * Forget the shutdown intent: the machine stays on (or it already went off).
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {object} state
 */
export function clearSleep(state, { now = Date.now() } = {}) {
  if (state.sleep === null || state.sleep === undefined) return state;
  state.sleep = null;
  state.updatedAt = now;
  return state;
}

/**
 * Set the lifecycle phase, ignoring unknown values.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} phase
 * @returns {object} state
 */
export function setPhase(state, phase) {
  if (typeof phase === 'string' && PHASES.includes(phase)) {
    state.phase = phase;
    state.updatedAt = Date.now();
  }
  return state;
}

/**
 * Sessions that still need work after a boot, newest first.
 * Delegates to `lifecycle.selectRecoverableSessions` so there is one definition
 * of "recoverable" in the plugin.
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {object[]} entries (live references into `state.sessions`)
 */
export function recoverableSessions(state, { limit } = {}) {
  return selectRecoverableSessions(state, { limit });
}

/**
 * Prune one goal-record map: a resumed record is diagnostics only and is
 * dropped once it is older than `maxAgeMs`; a record that was never resumed is
 * NEVER dropped, because a later boot still has to resume that goal.
 *
 * @param {object} map
 * @param {{ now: number, maxAgeMs: number, atKey: string, limit: number }} options
 */
function pruneGoalRecords(map, { now, maxAgeMs, atKey, limit }) {
  for (const id of Object.keys(map)) {
    const record = map[id];
    if (!isObject(record)) {
      delete map[id];
      continue;
    }
    const resumedAt = isFiniteNumber(record.resumedAt) ? record.resumedAt : null;
    if (resumedAt !== null && resumedAt < now - maxAgeMs) delete map[id];
  }
  const ids = Object.keys(map);
  if (ids.length > limit) {
    const at = (id) => {
      const record = map[id];
      return isObject(record) && isFiniteNumber(record[atKey]) ? record[atKey] : 0;
    };
    ids.sort((a, b) => at(b) - at(a));
    for (const id of ids.slice(limit)) delete map[id];
  }
}

/**
 * Keep the goal records small (both shapes). Mutates `state` in place.
 *
 * @param {object} state
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 */
function pruneGoalRecordMaps(state, { now = Date.now(), maxAgeMs } = {}) {
  const age = isFiniteNumber(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 7 * 24 * 60 * 60 * 1000;
  if (isObject(state.disarmedGoals)) {
    pruneGoalRecords(state.disarmedGoals, { now, maxAgeMs: age, atKey: 'disarmedAt', limit: DISARMED_GOALS_LIMIT });
  }
  if (isObject(state.parkedGoals)) {
    pruneGoalRecords(state.parkedGoals, { now, maxAgeMs: age, atKey: 'parkedAt', limit: PARKED_GOALS_LIMIT });
  }
}

/**
 * Keep the checkpoint small: cap the session map by `updatedAt` (newest wins)
 * and optionally drop finished entries older than `maxAgeMs`. Running and
 * pending-resume sessions are never dropped by age.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ maxSessions?: number, now?: number, maxAgeMs?: number }} [options]
 * @returns {object} state
 */
export function pruneSessions(state, { maxSessions, now = Date.now(), maxAgeMs } = {}) {
  pruneGoalRecordMaps(state, { now, maxAgeMs });
  if (!isObject(state.sessions)) return state;
  const sessions = state.sessions;
  const ids = Object.keys(sessions);
  if (ids.length === 0) return state;

  const updatedAt = (id) => {
    const entry = sessions[id];
    return entry && isFiniteNumber(entry.updatedAt) ? entry.updatedAt : 0;
  };
  ids.sort((a, b) => updatedAt(b) - updatedAt(a));

  const cap = isFiniteNumber(maxSessions) && maxSessions >= 1 ? Math.trunc(maxSessions) : Infinity;
  const remove = new Set(ids.slice(cap));

  if (isFiniteNumber(maxAgeMs) && maxAgeMs > 0) {
    const cutoff = now - maxAgeMs;
    for (const id of ids) {
      const entry = sessions[id];
      if (!isObject(entry)) continue;
      if (entry.running === true || entry.pendingResume === true) continue;
      if (entry.goal) continue;
      // A handoff / overflow record is the durable "never auto-resume this
      // session again" marker: it is never dropped by age.
      if (isObject(entry.handoff) || isObject(entry.contextOverflow)) continue;
      if (isFiniteNumber(entry.updatedAt) && entry.updatedAt < cutoff) remove.add(id);
    }
  }

  for (const id of remove) delete sessions[id];
  if (remove.size > 0) state.updatedAt = now;
  return state;
}

/**
 * The profile directory this host booted with, as a FACT (2026-11-03, t72).
 *
 * @param {object} state
 * @returns {{ dir: string, at: number, source: string }|null}
 */
export function readProfileDirFact(state) {
  if (!isObject(state)) return null;
  return normalizeProfileDirFact(state.profileDir);
}

/**
 * Write the profile directory this host booted with into the checkpoint.
 *
 * A boot that does NOT know the profile directory never erases what an older
 * boot wrote down: the broken manifest must not be able to delete the one
 * fact that lets the watchdog find its way home.
 *
 * @param {object} state
 * @param {{ dir?: string, source?: string }|null} resolved
 * @param {number} [now]
 * @returns {object} the same state
 */
export function writeProfileDirFact(state, resolved, now = Date.now()) {
  if (!isObject(state)) return state;
  const fact = profileDirFact(resolved, now);
  if (fact !== null) state.profileDir = fact;
  return state;
}
