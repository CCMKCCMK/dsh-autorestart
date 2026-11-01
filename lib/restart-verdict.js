/**
 * dsh-autorestart — the durable record of ONE restart.
 *
 * A restart has TWO halves that live in two different processes:
 *
 *   - the instance that is being replaced takes the pre-restart snapshot and
 *     then dies (the restart command kills it — that IS what restarting the
 *     host means);
 *   - the instance that replaces it has to prove that it really came up.
 *
 * Neither half can write the whole truth on its own, so the record lives in a
 * FILE that both halves touch:
 *
 *   1. the OLD instance writes `result: 'pending'` BEFORE it runs the restart
 *      command — together with the snapshot it took (directory name, how long
 *      it took, which older snapshots were pruned);
 *   2. the NEW instance reads that record on boot, runs the four boot checks
 *      (listener / routes / plugin / recovery) and rewrites it as `ok` or
 *      `failed`, with the time it verified itself and how long the whole
 *      restart took.
 *
 * If the new instance never comes up, the file stays `pending` — which is
 * exactly what the operator has to see: a restart that was started and never
 * finished. A record that says nothing is worse than no record at all, so the
 * verdict is ALSO exposed by `/__dsh_autorestart/health?state=1` and by the
 * `continuum_status` tool.
 *
 * The time is reported in BOTH zones: the snapshot directory is named in UTC
 * (`2026-10-29T00-25-20-779Z`), while the operator reads the wall clock of
 * the machine (`08:25`). Comparing the two without a conversion is how a
 * perfectly fresh snapshot looks like an eight-hour-old leftover — so the
 * record carries the local time of the snapshot as well.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The file the verdict lives in (inside the state directory). */
export const RESTART_VERDICT_FILE = 'last-restart-verdict.json';

/** The three results a restart can have. */
export const RESTART_RESULTS = Object.freeze({
  /** The restart was started; nobody confirmed it yet. */
  PENDING: 'pending',
  /** The new instance came up and every check passed. */
  OK: 'ok',
  /** The new instance came up but something did not work. */
  FAILED: 'failed',
});

/** The four checks the new instance runs on itself. */
export const RESTART_CHECK_NAMES = Object.freeze(['listener', 'routes', 'plugin', 'recovery']);

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @param {string|null} fallback */
function nullableString(value, fallback = null) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** @param {unknown} value */
function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * The local time of an epoch, with the UTC offset — the time the operator
 * sees on the machine (`2026-10-29T08:25:20+08:00`).
 *
 * @param {number|null|undefined} at
 * @returns {string|null}
 */
export function localIsoTime(at) {
  if (!isFiniteNumber(at)) return null;
  const date = new Date(Number(at));
  if (Number.isNaN(date.getTime())) return null;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  const local = new Date(Number(at) + offsetMinutes * 60000).toISOString();
  return `${local.slice(0, 19)}${sign}${hours}:${minutes}`;
}

/**
 * The snapshot part of the verdict: WHICH snapshot was taken, how long it
 * took and which older snapshots were pruned.
 *
 * @param {{
 *   requested?: boolean,
 *   backup?: object|null,
 *   profileDir?: string|null,
 *   durationMs?: number|null,
 *   error?: string|null,
 * }} [input]
 * @returns {object}
 */
export function buildSnapshotRecord({
  requested = false,
  backup = null,
  profileDir = null,
  durationMs = null,
  error = null,
} = {}) {
  const taken = isObject(backup) && backup.ok === true;
  const stamp = taken ? nullableString(backup.stamp) : null;
  const at = taken ? nullableNumber(backup.at) : null;
  return {
    requested: requested === true,
    taken,
    dir: taken ? nullableString(backup.dir) : null,
    stamp,
    at,
    // The human-readable time of the snapshot: the directory name is UTC.
    atLocal: at === null ? null : localIsoTime(at),
    durationMs: isFiniteNumber(durationMs) ? Math.trunc(durationMs) : null,
    bytes: taken ? nullableNumber(backup.bytes) : null,
    files: taken && Array.isArray(backup.files) ? backup.files.map(String) : [],
    pruned: taken && Array.isArray(backup.pruned) ? backup.pruned.map(String) : [],
    profileDir: nullableString(profileDir),
    error: nullableString(error) ?? (taken ? null : (nullableString(isObject(backup) ? backup.error : null) ?? 'the snapshot was not taken')),
  };
}

/**
 * Normalize one boot check.
 *
 * @param {unknown} raw
 * @returns {{ name: string, ok: boolean, detail: string|null }}
 */
function normalizeCheck(raw) {
  if (!isObject(raw)) return { name: 'unknown', ok: false, detail: null };
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'unknown',
    ok: raw.ok === true,
    detail: nullableString(raw.detail),
  };
}

/**
 * Build a verdict record from a loose input.
 *
 * @param {{
 *   result?: string,
 *   mode?: string|null,
 *   generation?: number|null,
 *   requestedAt?: number|null,
 *   startedAt?: number|null,
 *   verifiedAt?: number|null,
 *   durationMs?: number|null,
 *   bootId?: string|null,
 *   previousBootId?: string|null,
 *   snapshot?: object|null,
 *   checks?: any[],
 *   reason?: string|null,
 *   now?: number,
 * }} [input]
 * @returns {object}
 */
export function buildRestartVerdict(input = {}) {
  const now = isFiniteNumber(input.now) ? Number(input.now) : Date.now();
  const result = input.result === RESTART_RESULTS.OK
    ? RESTART_RESULTS.OK
    : input.result === RESTART_RESULTS.FAILED
      ? RESTART_RESULTS.FAILED
      : RESTART_RESULTS.PENDING;
  const startedAt = nullableNumber(input.startedAt);
  const verifiedAt = nullableNumber(input.verifiedAt);
  const durationMs = isFiniteNumber(input.durationMs)
    ? Math.trunc(Number(input.durationMs))
    : (startedAt !== null && verifiedAt !== null ? Math.max(0, verifiedAt - startedAt) : null);
  const snapshot = isObject(input.snapshot) ? input.snapshot : buildSnapshotRecord({ requested: false });
  return {
    result,
    mode: nullableString(input.mode),
    generation: nullableNumber(input.generation),
    requestedAt: nullableNumber(input.requestedAt),
    startedAt,
    verifiedAt,
    durationMs,
    bootId: nullableString(input.bootId),
    previousBootId: nullableString(input.previousBootId),
    snapshot: {
      requested: snapshot.requested === true,
      taken: snapshot.taken === true,
      dir: nullableString(snapshot.dir),
      stamp: nullableString(snapshot.stamp),
      at: nullableNumber(snapshot.at),
      atLocal: nullableString(snapshot.atLocal),
      durationMs: nullableNumber(snapshot.durationMs),
      bytes: nullableNumber(snapshot.bytes),
      files: Array.isArray(snapshot.files) ? snapshot.files.map(String) : [],
      pruned: Array.isArray(snapshot.pruned) ? snapshot.pruned.map(String) : [],
      profileDir: nullableString(snapshot.profileDir),
      error: nullableString(snapshot.error),
    },
    checks: Array.isArray(input.checks) ? input.checks.map(normalizeCheck) : [],
    reason: nullableString(input.reason),
    updatedAt: now,
  };
}

/**
 * The verdict of a set of checks: `ok` only when EVERY check passed.
 *
 * @param {any[]} checks
 * @returns {{ ok: boolean, failed: string[], passed: string[] }}
 */
export function evaluateRestartChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = []
  const passed = []
  for (const check of list) {
    const normalized = normalizeCheck(check)
    if (normalized.ok) passed.push(normalized.name)
    else failed.push(normalized.name)
  }
  return { ok: failed.length === 0 && list.length > 0, failed, passed }
}

/** The source that certifies a backup copy when the four checks all ran and passed. */
export const BOOT_CHECK_SOURCE = 'full-checks'

/**
 * CAN THIS BOOT CERTIFY THE COPY IT CAME FROM? — the decision, not the label.
 *
 * WHY THIS LIVES HERE, next to the checks themselves: until now the four checks
 * only decided the verdict of "this restart" (`ok` / `failed`); the question
 * "may the copy that produced this boot now be called safe?" was answered
 * somewhere else — and the answer used to be "yes, unconditionally". The two
 * questions are not the same one, so the rule is spelled out here and the caller
 * cannot answer it by accident.
 *
 * THE RULE (2026-11-01, strict mode):
 *
 *   - ALL FOUR checks (`listener` / `routes` / `plugin` / `recovery`) must have
 *     RUN and passed. A check that did not run is NOT a pass: a boot that
 *     skipped them (`resumeOnBoot` off, a probe that never reached the checks)
 *     proves nothing about the configuration.
 *   - A check that ran and FAILED blocks the certification, and so does any
 *     OTHER check that failed — "the boot is clean" is not a subset test.
 *   - `evaluateRestartChecks` is deliberately NOT reused as the gate: it says
 *     `ok` for any non-empty list of passing checks, which is right for the
 *     record ("this restart worked") and wrong for certification ("these four
 *     things were verified").
 *
 * The failure is never summarised away: `failed` / `missing` / `details` name
 * which of the four did not pass, so the report can say it.
 *
 * @param {any[]} checks the checks the new instance ran on itself
 * @returns {{
 *   certified: boolean,
 *   certifiedBy: string,
 *   passed: string[],
 *   failed: string[],
 *   missing: string[],
 *   extraFailed: string[],
 *   details: Array<{ name: string, ok: boolean, detail: string|null }>,
 *   reason: string,
 * }}
 */
export function decideBootCertification(checks) {
  const list = Array.isArray(checks) ? checks : []
  // One entry per NAME: if the same check is reported twice and one of the two
  // failed, the failure wins — a report that disagrees with itself is not a pass.
  const byName = new Map()
  for (const raw of list) {
    const check = normalizeCheck(raw)
    if (check.name === 'unknown') continue
    const previous = byName.get(check.name)
    if (previous === undefined) {
      byName.set(check.name, check)
      continue
    }
    byName.set(check.name, {
      name: check.name,
      ok: previous.ok === true && check.ok === true,
      detail: check.ok === true ? previous.detail : check.detail,
    })
  }
  const passed = []
  const failed = []
  const missing = []
  const details = []
  for (const name of RESTART_CHECK_NAMES) {
    const found = byName.get(name)
    if (found === undefined) {
      missing.push(name)
      details.push({ name, ok: false, detail: 'this check did not run' })
      continue
    }
    if (found.ok === true) {
      passed.push(name)
      details.push({ name, ok: true, detail: found.detail })
      continue
    }
    failed.push(name)
    details.push({ name, ok: false, detail: found.detail })
  }
  const extraFailed = []
  for (const [name, check] of byName) {
    if (RESTART_CHECK_NAMES.includes(name)) continue
    if (check.ok === true) continue
    extraFailed.push(name)
    details.push({ name, ok: false, detail: check.detail })
  }
  const certified = missing.length === 0 && failed.length === 0 && extraFailed.length === 0
  const reasons = []
  if (failed.length > 0) reasons.push('failed: ' + failed.join(', '))
  if (missing.length > 0) reasons.push('did not run: ' + missing.join(', '))
  if (extraFailed.length > 0) reasons.push('other check(s) failed: ' + extraFailed.join(', '))
  return {
    certified,
    // The only source this module may ever certify with. A failed boot cannot
    // hand out `manual-rollback` or a seed: those come from elsewhere.
    certifiedBy: certified ? BOOT_CHECK_SOURCE : 'none',
    passed,
    failed,
    missing,
    extraFailed,
    details,
    reason: certified
      ? 'all four startup checks passed (' + RESTART_CHECK_NAMES.join(', ') + ')'
      : 'the copy stays unproven: ' + reasons.join('; '),
  }
}

/**
 * Write the verdict into the state directory (atomically: a temporary file
 * plus a rename, so a half-written record can never be read).
 *
 * @param {string} stateDir
 * @param {object} verdict
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeRestartVerdict(stateDir, verdict) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return { ok: false, path: '', error: 'writeRestartVerdict requires stateDir' };
  const target = path.join(dir, RESTART_VERDICT_FILE);
  const record = buildRestartVerdict(verdict)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, target)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return {
      ok: false,
      path: target,
      error: String(error && error.message ? error.message : error),
    }
  }
}

/**
 * Read the verdict of the last restart. Never throws: an unreadable or
 * corrupt record is reported as `null` (there is nothing to show).
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRestartVerdict(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    let text = fs.readFileSync(path.join(dir, RESTART_VERDICT_FILE), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!isObject(parsed)) return null
    return buildRestartVerdict(parsed)
  } catch {
    return null
  }
}

/**
 * Remove the verdict (used when a fresh restart cycle starts).
 *
 * @param {string} stateDir
 * @returns {boolean} whether a record was removed
 */
export function clearRestartVerdict(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, RESTART_VERDICT_FILE), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * The compact shape of the verdict that the health route and the status tool
 * report. It is deliberately flat: a UI (or a human with `curl`) has to read
 * it without knowing the internals.
 *
 * @param {object|null} verdict
 * @returns {object|null}
 */
export function summarizeRestartVerdict(verdict) {
  if (!isObject(verdict)) return null
  const record = buildRestartVerdict(verdict)
  const failed = record.checks.filter((check) => !check.ok).map((check) => check.name)
  return {
    result: record.result,
    mode: record.mode,
    generation: record.generation,
    requestedAt: record.requestedAt,
    startedAt: record.startedAt,
    verifiedAt: record.verifiedAt,
    durationMs: record.durationMs,
    bootId: record.bootId,
    previousBootId: record.previousBootId,
    snapshot: record.snapshot,
    checks: record.checks,
    failedChecks: failed,
    reason: record.reason,
    updatedAt: record.updatedAt,
  }
}
