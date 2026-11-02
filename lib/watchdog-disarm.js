/**
 * DISARMING THE WATCHDOG — the host is up, so nothing may roll it back.
 *
 * THE INCIDENT THIS FILE EXISTS FOR (0.8.1, 2026-10-29):
 *
 *   A restart armed the watchdog (`watchdog-pending.json` + a one-off Windows
 *   scheduled task). The new host came up and answered its own health route
 *   with 200 — and still the ready marker was never written, the pending
 *   marker stayed, and the scheduled task stayed `Ready`. Had nobody
 *   interfered, the watchdog would have restored the snapshot of a HEALTHY
 *   profile 90 seconds later.
 *
 *   The reason was not a filesystem problem at all: the health route read the
 *   state directory from a variable that only existed inside the runtime
 *   factory, so the lookup threw `ReferenceError: stateDirOf is not defined`
 *   on EVERY request. The `catch {}` around it swallowed that, and the
 *   "nothing may be left behind" branch never ran. Nobody could see it: the
 *   route still answered 200, and nothing was recorded anywhere.
 *
 * THE TWO RULES THAT FOLLOW FROM IT:
 *
 *   1. The ready marker comes FIRST and on its own. It is the one thing that
 *      stops a rollback, it must never depend on the scheduling item, and a
 *      failure to write it must be recorded (never swallowed).
 *   2. Removing the scheduling item is an OPERATION ON THE MACHINE
 *      (`schtasks`, `systemctl`, a kill). It can fail, so it is retried with a
 *      backoff, and when every attempt fails the record says so (and says with
 *      which error). A silently failed disarm is the incident all over again.
 *
 * Everything here is ESM and Node builtins only, and every effect is
 * injectable: a test drives the whole thing without touching the machine.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  clearPending,
  readPending,
  readReady,
  writeReady,
} from './watchdog.js';
import { removeLeftoverProbeTasks, removeScheduleItem } from './watchdog-schedule.js';
import { TIERS } from './watchdog-tier.js';

/** The file that records how the last disarm went. */
export const DISARM_FILE_NAME = 'watchdog-disarm.json';

/** How often the disarm is tried before it gives up (and says so). */
export const DEFAULT_DISARM_ATTEMPTS = 3;

/** The first wait between two attempts; it grows with every attempt. */
export const DEFAULT_DISARM_BACKOFF_MS = 120;

/** @param {string} stateDir */
export function disarmPath(stateDir) {
  return path.join(String(stateDir ?? ''), DISARM_FILE_NAME);
}

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/** @param {unknown} value */
function errorName(value) {
  if (value && typeof value.name === 'string' && value.name) return value.name;
  return 'Error';
}

/**
 * One failure, in the shape the diagnostics and the settings page show.
 *
 * @param {number} attempt
 * @param {string} step
 * @param {unknown} error
 */
function failure(attempt, step, error) {
  return { attempt, step, name: errorName(error), message: errorText(error) };
}

/**
 * The record of the last disarm (null when nothing was recorded yet).
 *
 * @param {string} stateDir
 * @returns {object|null}
 */export function readDisarmRecord(stateDir) {
  const file = disarmPath(stateDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the record (never throws: a failed disarm must not fail the host).
 *
 * @param {string} stateDir
 * @param {object} record
 */
export function writeDisarmRecord(stateDir, record) {
  const dir = String(stateDir ?? '');
  if (dir === '') return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(disarmPath(dir), JSON.stringify(record, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * STEP 1: the ready marker — "the new host is up".
 *
 * It is written even when there is no pending marker at all (an idle boot says
 * "this instance is alive"), and it is READ BACK: a write that returned is not
 * a marker that is there.
 *
 * @param {{
 *   stateDir?: string,
 *   bootId?: string,
 *   port?: number|null,
 *   now?: Function,
 *   read?: Function,
 *   write?: Function,
 * }} [options]
 * @returns {{ ok: boolean, wrote: boolean, error: unknown, detail: string }}
 */
export function markReady({
  stateDir = '',
  bootId = '',
  port = null,
  now = Date.now,
  read = readReady,
  write = writeReady,
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir : '';
  if (dir === '') {
    return { ok: false, wrote: false, error: null, detail: 'there is no state directory to write the marker into' };
  }
  const id = typeof bootId === 'string' ? bootId : '';
  let wrote = false;
  try {
    const existing = read(dir);
    if (id !== '' && existing !== null && existing.bootId === id) {
      // Already ours: this boot has marked itself.
      return { ok: true, wrote: false, error: null, detail: 'the ready marker of this boot is already there' };
    }
    const number = Number(port);
    write(dir, {
      bootId: id === '' ? null : id,
      port: Number.isFinite(number) && number > 0 ? number : null,
      at: now(),
    });
    wrote = true;
    const written = read(dir);
    if (id !== '' && (written === null || written.bootId !== id)) {
      return { ok: false, wrote, error: null, detail: 'the ready marker could not be read back' };
    }
    return { ok: true, wrote, error: null, detail: 'the ready marker was written' };
  } catch (error) {
    return { ok: false, wrote, error, detail: 'the ready marker could not be written: ' + errorText(error) };
  }
}

/**
 * WHICH scheduling item does this pending marker belong to?
 *
 * The tier is the source of truth; when it is unknown the names are used, so a
 * marker written by an older version is still cleaned up instead of blocking
 * the disarm for ever.
 *
 * @param {object|null} pending
 * @returns {{ tier: string, taskName: string, unitId: string, pidPath: string }}
 */
export function scheduleTargetOf(pending) {
  const source = pending && typeof pending === 'object' ? pending : {};
  const taskName = typeof source.taskName === 'string' ? source.taskName : '';
  const unitId = typeof source.unitId === 'string' ? source.unitId : '';
  const pidPath = typeof source.pidPath === 'string' ? source.pidPath : '';
  const known = new Set([TIERS.SCHEDULED_TASK, TIERS.SYSTEMD_RUN, TIERS.DETACHED_PROCESS]);
  let tier = typeof source.tier === 'string' ? source.tier : '';
  if (!known.has(tier)) {
    if (taskName !== '') tier = TIERS.SCHEDULED_TASK;
    else if (unitId !== '') tier = TIERS.SYSTEMD_RUN;
    else if (pidPath !== '') tier = TIERS.DETACHED_PROCESS;
    else tier = TIERS.NONE;
  }
  return { tier, taskName, unitId, pidPath };
}

/**
 * Read the pending marker without letting a broken read break the disarm.
 *
 * @param {Function} readPendingFn
 * @param {string} stateDir
 * @returns {object|null}
 */
function readPendingSafely(readPendingFn, stateDir) {
  try {
    const value = readPendingFn(stateDir);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

/**
 * Does the Windows task exist right now?
 *
 * `null` means "this machine cannot tell" (not Windows). It exists so the
 * disarm does not call a failed `schtasks /Delete` a failure when the task was
 * already gone — and does not call a refused delete a success.
 *
 * @param {string} taskName
 * @returns {boolean|null}
 */
export function defaultTaskExists(taskName) {
  if (process.platform !== 'win32') return null;
  if (typeof taskName !== 'string' || taskName === '') return false;
  try {
    execFileSync('schtasks', ['/Query', '/TN', taskName], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * ONE disarm attempt: the marker, then the two leftovers.
 *
 * Scheduled reminders: `attempt` numbers the record, `errors` collects every
 * failure of THIS attempt (so a partial result is never reported as clean).
 *
 * @param {{
 *   stateDir?: string,
 *   bootId?: string,
 *   port?: number|null,
 *   attempt?: number,
 *   now?: Function,
 *   read?: Function,
 *   write?: Function,
 *   readPendingFn?: Function,
 *   clearPendingFn?: Function,
 *   removeItem?: Function,
 *   taskExists?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   ready: boolean,
 *   pending: boolean,
 *   removed: { tier: string, ok: boolean, error: unknown }|null,
 *   errors: Array<{ attempt: number, step: string, name: string, message: string }>,
 * }}
 */
export function disarmOnce({
  stateDir = '',
  bootId = '',
  port = null,
  attempt = 1,
  now = Date.now,
  read = readReady,
  write = writeReady,
  readPendingFn = readPending,
  clearPendingFn = clearPending,
  removeItem = removeScheduleItem,
  taskExists = defaultTaskExists,
  removeProbes = removeLeftoverProbeTasks,
  pendingHint = null,
  platform = process.platform,
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir : '';
  const errors = [];
  if (dir === '') {
    errors.push(failure(attempt, 'state-dir', 'there is no state directory to disarm in'));
    return { ok: false, ready: false, pending: false, removed: null, errors };
  }

  // (1) THE MARKER. Nothing else in this function may run before it.
  const marked = markReady({ stateDir: dir, bootId, port, now, read, write });
  if (marked.ok !== true) {
    errors.push(failure(attempt, 'ready-marker', marked.error === null
      ? new Error(marked.detail)
      : marked.error));
  }

  // (2) THE PENDING MARKER + (3) THE SCHEDULING ITEM.
  //
  // They are handled separately ON PURPOSE: the marker can be gone (the first
  // attempt cleared it) while the scheduling item is still there (the delete
  // was refused). That is why a later attempt re-tries the removal from
  // `pendingHint` — the marker of the first attempt — instead of giving up.
  let pendingAfter = null;
  let removed = null;
  let pendingMarker = null;
  try {
    pendingMarker = readPendingFn(dir);
  } catch (error) {
    errors.push(failure(attempt, 'read-pending', error));
  }
  if (pendingMarker !== null && pendingMarker !== undefined) {
    try {
      clearPendingFn(dir);
    } catch (error) {
      errors.push(failure(attempt, 'clear-pending', error));
    }
    try {
      pendingAfter = readPendingFn(dir);
    } catch (error) {
      errors.push(failure(attempt, 'read-pending', error));
      pendingAfter = pendingMarker;
    }
    if (pendingAfter !== null && pendingAfter !== undefined) {
      errors.push(failure(attempt, 'clear-pending', new Error('the pending marker is still there after it was removed')));
    }
  }
  const scheduling = pendingMarker !== null && pendingMarker !== undefined
    ? pendingMarker
    : (pendingHint !== null && pendingHint !== undefined ? pendingHint : null);
  if (scheduling !== null) {
    const target = scheduleTargetOf(scheduling);
    const anywhere = target.taskName !== '' || target.unitId !== '' || target.pidPath !== '';
    if (target.tier !== TIERS.NONE && anywhere) {
      // "It answers" is not "it is gone", and a delete of something that is
      // already gone is not a failure. Only the Windows task can be asked
      // about (and only there is the distinction needed).
      let exists = null;
      if (target.tier === TIERS.SCHEDULED_TASK) {
        try {
          exists = typeof taskExists === 'function' ? taskExists(target.taskName) : null;
        } catch {
          exists = null;
        }
      }
      if (exists === false) {
        // Nothing to delete: another run (or the watchdog itself) was first.
        removed = { tier: target.tier, ok: true, error: null };
      } else {
        let answer = null;
        try {
          answer = removeItem(target);
        } catch (error) {
          errors.push(failure(attempt, 'remove-schedule', error));
        }
        if (answer !== null && answer !== undefined) {
          removed = {
            tier: target.tier,
            ok: answer.ok === true,
            error: answer.ok === true ? null : (answer.error || 'the scheduling item could not be removed'),
          };
          if (removed.ok !== true) {
            errors.push(failure(attempt, 'remove-schedule', new Error(String(removed.error))));
          }
        }
        let stillThere = null;
        if (target.tier === TIERS.SCHEDULED_TASK) {
          try {
            stillThere = typeof taskExists === 'function' ? taskExists(target.taskName) : null;
          } catch {
            stillThere = null;
          }
        }
        if (stillThere === true) {
          // A removal that CLAIMED success and left the task behind is the
          // dangerous case; a removal that already reported its failure needs
          // no second line for the same attempt.
          const alreadyReported = removed !== null && removed.ok !== true;
          removed = { tier: target.tier, ok: false, error: 'the scheduling item is still there' };
          if (!alreadyReported) {
            errors.push(failure(attempt, 'remove-schedule', new Error('the scheduling item is still there after it was removed')));
          }
        }
      }
    }
  }

  // (4) THE LEFTOVER CAPABILITY PROBES (2026-11-01).
  //
  // The capability probe (lib/scheduler-capability.js) registers a one-off task
  // and deletes it as its LAST step, so a crash, a kill or a refused delete
  // leaves it behind: two were found on the real machine, both `Ready`, neither
  // with a next run time. The old disarm only removed the watchdog item named by
  // the pending marker and never looked for them, so they accumulated one per
  // boot.
  //
  // A refusal here is recorded and NOT pushed into `errors`: those decide whether
  // the disarm itself counts as done, and the host being up does not depend on
  // cleaning a stale probe task. The caller logs it and the record carries it, so
  // "the cleanup did not work" is still visible.
  let probes = null;
  if (typeof removeProbes === 'function') {
    try {
      // THE PLATFORM TRAVELS WITH THE REQUEST (2026-11-02): off Windows there
      // are no scheduled tasks to clean, so the cleanup says `skipped` instead
      // of reporting a `schtasks` failure on every single boot.
      probes = removeProbes({ platform: typeof platform === 'string' && platform !== '' ? platform : process.platform });
    } catch (error) {
      probes = {
        ok: false,
        prefix: '',
        matched: [],
        removed: [],
        failed: [],
        skipped: false,
        reason: null,
        error: error && error.message ? String(error.message) : String(error),
      };
    }
  }

  const ready = (() => {
    try {
      const marker = read(dir);
      if (marker === null) return false;
      return typeof bootId !== 'string' || bootId === '' ? true : marker.bootId === bootId;
    } catch {
      return false;
    }
  })();
  const pendingLeft = pendingAfter !== null && pendingAfter !== undefined;
  const ok = errors.length === 0 && ready === true && pendingLeft === false
    && (removed === null || removed.ok === true);
  return { ok, ready, pending: pendingLeft, removed, errors, probes };
}

/**
 * DISARM, WITH RETRIES — "the host is up, so the watchdog has nothing to do".
 *
 * The first attempt runs SYNCHRONOUSLY up to the marker, so a caller inside an
 * HTTP route has the marker on disk before it answers. Only the retries wait.
 *
 * The record is always returned and (unless `writeRecord` is false) written to
 * `<stateDir>/watchdog-disarm.json`, so a failed disarm is visible afterwards
 * instead of being the silent state of 0.8.1.
 *
 * @param {{
 *   stateDir?: string,
 *   bootId?: string,
 *   port?: number|null,
 *   source?: string,
 *   attempts?: number,
 *   backoffMs?: number,
 *   sleep?: Function,
 *   now?: Function,
 *   read?: Function,
 *   write?: Function,
 *   readPendingFn?: Function,
 *   clearPendingFn?: Function,
 *   removeItem?: Function,
 *   taskExists?: Function,
 *   writeRecord?: boolean,
 *   log?: { warn?: Function, info?: Function }|null,
 * }} [options]
 * @returns {Promise<object>} the record
 */
export async function disarmWatchdog({
  stateDir = '',
  bootId = '',
  port = null,
  source = 'boot',
  attempts = DEFAULT_DISARM_ATTEMPTS,
  backoffMs = DEFAULT_DISARM_BACKOFF_MS,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = Date.now,
  read = readReady,
  write = writeReady,
  readPendingFn = readPending,
  clearPendingFn = clearPending,
  removeItem = removeScheduleItem,
  taskExists = defaultTaskExists,
  removeProbes = removeLeftoverProbeTasks,
  writeRecord = true,
  log = null,
  platform = process.platform,
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir : '';
  const wanted = Number.isFinite(Number(attempts)) && Number(attempts) > 0
    ? Math.trunc(Number(attempts))
    : DEFAULT_DISARM_ATTEMPTS;
  const wait = Number.isFinite(Number(backoffMs)) && Number(backoffMs) >= 0
    ? Math.trunc(Number(backoffMs))
    : DEFAULT_DISARM_BACKOFF_MS;

  const errors = [];
  let last = null;
  let used = 0;
  // The pending marker as it was BEFORE the first attempt: the scheduling item
  // it names must be retried even after the marker itself is gone (removing the
  // file can work while the `schtasks /Delete` is refused).
  const hint = readPendingSafely(readPendingFn, dir);
  for (let attempt = 1; attempt <= wanted; attempt += 1) {
    used = attempt;
    last = disarmOnce({
      stateDir: dir,
      bootId,
      port,
      attempt,
      now,
      read,
      write,
      readPendingFn,
      clearPendingFn,
      removeItem,
      taskExists,
      removeProbes,
      pendingHint: hint,
      platform,
    });
    errors.push(...last.errors);
    if (last.ok) break;
    if (attempt < wanted && wait > 0) {
      // A failed `schtasks /Delete` is usually a moment later fine (the task
      // scheduler holds a lock while the task is being started): back off.
      await sleep(wait * attempt);
    }
  }

  const record = {
    at: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
    source: String(source ?? 'boot'),
    bootId: typeof bootId === 'string' && bootId !== '' ? bootId : null,
    attempts: used,
    ok: last !== null && last.ok === true,
    ready: last !== null && last.ready === true,
    pending: last !== null && last.pending === true,
    tier: last !== null && last.removed !== null ? last.removed.tier : null,
    scheduleRemoved: last !== null && last.removed !== null ? last.removed.ok === true : null,
    scheduleError: last !== null && last.removed !== null && last.removed.error
      ? String(last.removed.error)
      : null,
    // THE LEFTOVER CAPABILITY PROBES: what the cleanup found and what it did.
    // Kept OUT of `errors` on purpose — a refused cleanup of a stale probe task
    // is not a failed disarm, but it must not be invisible either.
    probes: last !== null && last.probes !== null && last.probes !== undefined ? last.probes : null,
    errors,
  };
  if (writeRecord) writeDisarmRecord(dir, record);
  if (record.ok !== true && log && typeof log.warn === 'function') {
    log.warn('the watchdog could not be disarmed', {
      attempts: record.attempts,
      errors: record.errors.slice(0, 3),
    });
  }
  return record;
}
