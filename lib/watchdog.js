/**
 * THE WATCHDOG — one flow, three ways to trigger it.
 *
 * The flow is the same everywhere; only the way the watchdog is made to run
 * differs (see lib/watchdog-tier.js and lib/watchdog-schedule.js). This file
 * is that flow:
 *
 *   1. wait for the READY marker (the new host wrote it after its health
 *      check passed);
 *   2. no marker? Wait a bit and ASK AGAIN — a host that is slow to start is
 *      not a host that is dead (the misjudgement protection);
 *   3. still nothing? Is an instance ALIVE? If one is listening, the rollback
 *      is not needed: stand down (the no-double-start protection);
 *   3b. THE LAST QUESTION BEFORE A RESTORE: ask the health route ITSELF
 *      (HTTP to 127.0.0.1:<port>). Only a host that does not answer may be
 *      rolled back. This is what keeps a host that forgot to write the marker
 *      — or could not write it — from being restored out from under itself.
 *      When there is no port to ask at all (no instance record, no health
 *      URL), one more round is waited and the leftovers are looked at again;
 *   4. take the shared lock (`rollback.lock`) — exactly ONE of us restores;
 *   5. THE PASS — up to `maxAttempts` times (3 by default, and NEVER endless):
 *        a. ask again whether the host came up or is alive (a host that came
 *           up between two attempts must not be started a second time);
 *        b. restore the snapshot on the first pass, and again on a later pass
 *           only when the restore itself failed (the snapshot is the same
 *           file tree: copying it twice would not change anything);
 *        c. CLEAR THE STALE HANDSHAKE COOKIES after the restore and before
 *           the start (see lib/cookie-clear.js: without it the relaunched
 *           host dies with 431 on its very first request);
 *        d. START THE HOST AGAIN and wait for the ready marker;
 *        e. not ready and attempts left? wait the backoff (15s, then 45s) and
 *           go back to (a);
 *   6. the marker came → `recovered`; the attempts ran out → `failed` with
 *      "tried N times, rely on the sentry"; a start that could not be issued
 *      at all → `failed` with `stage:'relaunch'`.
 *
 * A cleanup that fails never blocks a rescue (the cookie script exits 0 for
 * the same reason), but it is ALWAYS written into the report (`cookieClear`):
 * a cleanup that could not run must never look like one that did.
 *
 * Whatever happens, the scheduling item and the pending marker go; the report
 * stays — and it is written from the `finally`, so an exception inside the
 * flow still leaves a report behind.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The marker that says "a restart is coming, a watchdog is watching". */
export const PENDING_NAME = 'watchdog-pending.json';
/** The marker that says "the new host is up and healthy". */
export const READY_NAME = 'watchdog-ready.json';
/** The report of the last watchdog run. */
export const REPORT_NAME = 'last-watchdog-report.json';
/** The lock that both the plugin and the watchdog take before a restore. */
export const LOCK_NAME = 'rollback.lock';

/** How long the watchdog waits for the new host. */
export const DEFAULT_TIMEOUT_MS = 180000;
/** How long it waits before it asks again (the misjudgement protection). */
export const DEFAULT_RECHECK_MS = 20000;
/** How often it looks at the ready marker. */
export const DEFAULT_POLL_MS = 2000;
/** How long it waits for the host after the restore. */
export const DEFAULT_READY_TIMEOUT_MS = 90000;

/**
 * How many pass-and-start attempts one watchdog run may make.
 *
 * The flow used to be "one restore, one start, then stop". One start is not
 * enough: the desktop app can die while it boots (a 431 on its first request
 * killed it after 14 seconds on 2026-10-30), and a host that died is a host
 * that has to be started again. It is a NUMBER, not "as often as you like":
 * a run that never ends is a run that never reports.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The hard ceiling of `maxAttempts`.
 *
 * A pending marker is a file on disk, so a bad or hand-edited value must not
 * be able to turn the watchdog into an endless loop.
 */
export const MAX_ATTEMPTS_CEILING = 10;

/**
 * The waits BETWEEN two attempts, in milliseconds (15s, then 45s).
 *
 * The first wait is short (a host that died on its first request is worth
 * starting again at once); the second is longer (a host that dies twice is
 * dying for a reason, and hammering the disk with relaunches helps nobody).
 * The last entry repeats when there are more attempts than entries.
 */
export const DEFAULT_BACKOFF_MS = Object.freeze([15000, 45000]);

/**
 * How many attempts this run may make (the marker, clamped and defaulted).
 *
 * An OLD marker carries no `maxAttempts`: it is read as `DEFAULT_MAX_ATTEMPTS`,
 * never as "one" — a marker written before this field existed must not turn
 * the watchdog back into the one-shot process that failed on 2026-10-30.
 *
 * @param {object|null} pending
 * @returns {number}
 */
export function maxAttemptsOf(pending) {
  const raw = pending && typeof pending === 'object' ? pending.maxAttempts : undefined;
  const wanted = Number(raw);
  if (!Number.isFinite(wanted) || wanted < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS_CEILING, Math.trunc(wanted));
}

/**
 * The wait AFTER a given attempt (1-based), in milliseconds.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function backoffMsFor(attempt) {
  const index = Math.max(0, Math.trunc(Number(attempt) || 0) - 1);
  const table = DEFAULT_BACKOFF_MS;
  return table[Math.min(index, table.length - 1)];
}

/**
 * Write a JSON file (no BOM, so every reader can parse it).
 *
 * @param {string} file
 * @param {object} value
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Read a JSON file and say WHAT happened (a file that cannot be read is not
 * the same thing as a file that is not there).
 *
 * WHY THE THREE STATES (2026-10-30, review finding F4): the old reader returned
 * `null` for BOTH "there is no such file" and "the file cannot be parsed". The
 * watchdog therefore read a `watchdog-pending.json` that had been written BY
 * POWERSHELL (UTF-8 **with** a byte order mark) as "there is no pending marker",
 * cleaned up its scheduling item and exited 0 - looking like a run, doing
 * nothing at all. That is exactly the failure this whole file exists to
 * prevent, so "missing" and "corrupt" are separate answers now, and the byte
 * order mark is stripped before parsing.
 *
 * @param {string} file
 * @returns {{
 *   state: 'ok'|'missing'|'corrupt',
 *   value: object|null,
 *   error: string|null,
 * }}
 */
export function readJsonState(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'missing', value: null, error: null };
    }
    return {
      state: 'corrupt',
      value: null,
      error: 'the file exists but cannot be read: ' + (error && error.message ? error.message : String(error)),
    };
  }
  // Windows PowerShell 5.1 writes UTF-8 WITH a byte order mark, and
  // `JSON.parse` refuses a leading U+FEFF. Stripping it is not cosmetic: a
  // marker written by a rescue script has to be readable by this module.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      state: 'corrupt',
      value: null,
      error: 'the file cannot be parsed: ' + (error && error.message ? error.message : String(error)),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'corrupt', value: null, error: 'the file does not hold a JSON object' };
  }
  return { state: 'ok', value: parsed, error: null };
}

/**
 * Read a JSON file (the value, or null when there is nothing usable).
 *
 * The PLUGIN side keeps this shape: `readPending` / `readReady` / `readReport`
 * are imported by index.js, and a caller that only wants "the object or
 * nothing" must not have to unwrap a state machine. The watchdog CLI uses
 * {@link readJsonState} (and {@link readPendingState}) because it has to tell
 * "no marker" from "a marker it cannot read".
 *
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  return readJsonState(file).value;
}

/**
 * The pending marker WITH the reason it could not be used.
 *
 * @param {string} stateDir
 * @returns {{ state: 'ok'|'missing'|'corrupt', pending: object|null, error: string|null }}
 */
export function readPendingState(stateDir) {
  const read = readJsonState(pendingPath(stateDir));
  return { state: read.state, pending: read.value, error: read.error };
}

/**
 * The pending marker: what the watchdog has to know.
 *
 * @param {{
 *   tier?: string,
 *   tierReason?: string,
 *   taskName?: string,
 *   unitId?: string,
 *   pidPath?: string,
 *   snapshotDir?: string,
 *   profileDir?: string,
 *   restoreCommand?: object|null,
 *   relaunchCommand?: object|null,
 *   healthUrl?: string,
 *   healthPath?: string,
 *   portFile?: string,
 *   expectedBootId?: string|null,
 *   timeoutMs?: number,
 *   recheckMs?: number,
 *   readyTimeoutMs?: number,
 *   hostKind?: string,
 *   attempts?: number,
 *   maxAttempts?: number,
 *   now?: number,
 * }} options
 * @returns {object}
 */
export function buildPending({
  tier = 'none',
  tierReason = '',
  arbiter = 'v2',
  taskName = '',
  unitId = '',
  pidPath = '',
  snapshotDir = '',
  profileDir = '',
  restoreCommand = null,
  relaunchCommand = null,
  healthUrl = '',
  healthPath = '/__dsh_autorestart/health',
  portFile = '',
  expectedBootId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recheckMs = DEFAULT_RECHECK_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  hostKind = '',
  attempts = 1,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = Date.now(),
} = {}) {
  return {
    version: 1,
    at: new Date(now).toISOString(),
    tier,
    tierReason,
    arbiter,
    taskName,
    unitId,
    pidPath,
    snapshotDir,
    profileDir,
    restoreCommand,
    relaunchCommand,
    healthUrl,
    healthPath,
    portFile,
    expectedBootId,
    timeoutMs,
    recheckMs,
    readyTimeoutMs,
    hostKind,
    attempts,
    maxAttempts,
  };
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function pendingPath(stateDir) {
  return path.join(stateDir, PENDING_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function readyPath(stateDir) {
  return path.join(stateDir, READY_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function reportPath(stateDir) {
  return path.join(stateDir, REPORT_NAME);
}

/**
 * Write the pending marker.
 *
 * @param {string} stateDir
 * @param {object} pending
 */
export function writePending(stateDir, pending) {
  writeJson(pendingPath(stateDir), pending);
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readPending(stateDir) {
  return readJson(pendingPath(stateDir));
}

/**
 * Remove the pending marker (the watchdog is over).
 *
 * @param {string} stateDir
 */
export function clearPending(stateDir) {
  try {
    fs.rmSync(pendingPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Write the ready marker: "the new host is up".
 *
 * @param {string} stateDir
 * @param {{ bootId?: string, port?: number, at?: number }} [info]
 */
export function writeReady(stateDir, info = {}) {
  writeJson(readyPath(stateDir), {
    at: new Date(info.at ?? Date.now()).toISOString(),
    bootId: info.bootId ?? null,
    port: info.port ?? null,
  });
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReady(stateDir) {
  return readJson(readyPath(stateDir));
}

/**
 * Remove the ready marker (it belongs to one restart).
 *
 * @param {string} stateDir
 */
export function clearReady(stateDir) {
  try {
    fs.rmSync(readyPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Write the report of the last watchdog run.
 *
 * @param {string} stateDir
 * @param {object} report
 */
export function writeReport(stateDir, report) {
  writeJson(reportPath(stateDir), report);
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReport(stateDir) {
  return readJson(reportPath(stateDir));
}

/**
 * Take the lock (exactly one restore at a time).
 *
 * @param {string} lockFile
 * @param {{ now?: number, exists?: Function, mkdir?: Function, open?: Function }} [deps]
 * @returns {boolean}
 */
export function acquireLock(lockFile, { now = Date.now(), exists = fs.existsSync, mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }), open = null } = {}) {
  try {
    mkdir(path.dirname(lockFile));
    if (exists(lockFile)) {
      // A lock that is older than 10 minutes belongs to a process that died
      // in the middle of its restore: it must not block the rollback for ever.
      let age = 0;
      try {
        age = now - fs.statSync(lockFile).mtimeMs;
      } catch {
        age = 0;
      }
      if (age > 10 * 60 * 1000) fs.rmSync(lockFile, { force: true });
      else return false;
    }
    const handle = open === null
      ? fs.openSync(lockFile, 'wx')
      : open(lockFile);
    if (handle !== null && handle !== undefined && typeof handle.close === 'function') handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Give the lock back.
 *
 * @param {string} lockFile
 */
export function releaseLock(lockFile) {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Put the snapshot back.
 *
 * The same for every platform: the configuration files and the plugin tree
 * are copied out of the snapshot into the profile. (The profile is NOT
 * deleted first — the broken files are overwritten, so a half-restored
 * profile is never worse than the broken one.)
 *
 * @param {{ snapshotDir?: string, profileDir?: string, copy?: Function }} options
 * @returns {{ ok: boolean, error: string|null, copied: string[] }}
 */
export function restoreFromSnapshot({ snapshotDir = '', profileDir = '', copy = null } = {}) {
  const from = String(snapshotDir ?? '');
  const into = String(profileDir ?? '');
  if (from === '' || into === '') {
    return { ok: false, error: 'the snapshot or the profile directory is unknown', copied: [] };
  }
  const copied = [];
  const copyInto = copy === null
    ? (source, target) => { fs.cpSync(source, target, { recursive: true, force: true }); }
    : copy;
  try {
    for (const [part, target] of [['config', into], ['node_modules', path.join(into, 'node_modules')]]) {
      const source = path.join(from, part);
      if (!fs.existsSync(source)) continue;
      copyInto(source, target);
      copied.push(part);
    }
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      copied,
    };
  }
  return { ok: copied.length > 0, error: copied.length > 0 ? null : 'the snapshot carries nothing to restore', copied };
}

/**
 * Wait for the ready marker.
 *
 * @param {object} deps
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForReady(deps, timeoutMs) {
  const deadline = deps.now() + Math.max(0, timeoutMs);
  while (deps.now() < deadline) {
    if (deps.readReady()) return true;
    // The plugin may have decided on its own (the restart failed): stand down.
    if (deps.isWithdrawn && deps.isWithdrawn()) return false;
    await deps.sleep(Math.min(deps.pollMs, Math.max(0, deadline - deps.now())));
  }
  return deps.readReady() === true;
}

/**
 * Normalize the answer of the health question.
 *
 * The dependency may answer with a plain string ('healthy' | 'unhealthy' |
 * 'unknown') or with `{ state, detail }` — the CLI uses the second form, so the
 * report can say WHY the host was believed to be up (a health route answered, or
 * an instance of the new boot is clearly running).
 *
 * @param {unknown} value
 * @returns {{ state: string, detail: string|null }}
 */
function healthAnswer(value) {
  if (value && typeof value === 'object') {
    const state = typeof value.state === 'string' ? value.state : 'unknown';
    const detail = typeof value.detail === 'string' && value.detail !== '' ? value.detail : null;
    return { state, detail };
  }
  return { state: typeof value === 'string' ? value : 'unknown', detail: null };
}

/**
 * Normalize the answer of the cookie cleanup.
 *
 * The cleanup script always exits 0 (a restart must never be blocked by a
 * cleanup), so the answer of the runner means "the cleanup process finished",
 * not "cookies were deleted". `removed` is the count when the runner knows it
 * and `null` when it does not — a count that was never measured is reported as
 * not measured, never as 0.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, removed: number|null, error: string|null }}
 */
function cookieClearAnswer(value) {
  if (value === null || value === undefined) {
    return { ok: false, removed: null, error: 'the cookie cleanup was not run' };
  }
  if (typeof value === 'object') {
    const ok = value.ok === true;
    const count = Number(value.removed);
    const removed = value.removed === null || value.removed === undefined || !Number.isFinite(count)
      ? null
      : Math.trunc(count);
    const detail = typeof value.error === 'string' && value.error !== '' ? value.error : null;
    return { ok, removed, error: ok ? detail : (detail ?? 'the cookie cleanup failed') };
  }
  const ok = value === true;
  return { ok, removed: null, error: ok ? null : 'the cookie cleanup failed' };
}

/**
 * Run the cleanup, and never let it break the rescue.
 *
 * A thrown cleanup is an answer like any other: `{ ok:false, error }` — the
 * caller records it in the report and goes on to start the host, because a
 * host that starts with stale cookies is still better than a host that never
 * starts at all.
 *
 * @param {object} deps
 * @returns {Promise<{ ok: boolean, removed: number|null, error: string|null }>}
 */
async function runCookieClear(deps) {
  try {
    return cookieClearAnswer(await deps.clearCookies());
  } catch (error) {
    return {
      ok: false,
      removed: null,
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * THE FLOW.
 *
 * @param {{
 *   pending: object,
 *   stateDir?: string,
 *   deps?: object,
 * }} options
 * @returns {Promise<object>} the report
 */
export async function runWatchdogFlow({ pending, stateDir = '', deps = {} }) {
  const d = {
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollMs: DEFAULT_POLL_MS,
    readReady: () => readReady(stateDir),
    isWithdrawn: () => readPending(stateDir) === null,
    probeAlive: () => false,
    // THE HEALTH QUESTION (see step 3b): 'healthy' | 'unhealthy' | 'unknown'.
    // The CLI answers it with a real HTTP request; a flow test injects it.
    askHealth: () => 'unknown',
    runRestore: () => ({ ok: false, error: 'no restore command' }),
    runRelaunch: () => ({ ok: false, error: 'no relaunch command' }),
    // THE HANDSHAKE COOKIES (see lib/cookie-clear.js). The CLI runs the real
    // cleanup script; a flow test injects it. The default REFUSES instead of
    // pretending: a report that says "the cookies were cleared" when nobody
    // cleared them is worse than a report that says nobody tried.
    clearCookies: () => ({ ok: false, removed: null, error: 'no cookie cleanup is wired' }),
    acquireLock: () => true,
    releaseLock: () => {},
    removeSchedule: () => {},
    writeReport: (report) => writeReport(stateDir, report),
    ...deps,
  };
  const startedAt = d.now();
  const report = {
    at: new Date(startedAt).toISOString(),
    result: 'unknown',
    tier: pending && pending.tier ? pending.tier : 'none',
    tierReason: pending && pending.tierReason ? pending.tierReason : '',
    // WHO watched this restart. There is only ever one watchdog at a time
    // (see lib/watchdog-arbiter.js), and the report says which one it was.
    arbiter: pending && pending.arbiter ? pending.arbiter : 'v2',
    waitedMs: 0,
    rechecked: false,
    // What the health route of the host itself said before anything was
    // restored: 'healthy' (stood down), 'unhealthy' (really down) or
    // 'unknown' (there was no port to ask).
    healthCheck: 'unknown',
    healthDetail: null,
    health: null,
    extraRound: false,
    restored: false,
    relaunched: false,
    ready: false,
    error: null,
    // WHERE the run stood when it ended, so "the rescue failed" and "I never
    // got going" can never be confused: 'flow' (the flow ran), 'relaunch'
    // (the host could not be started again). The CLI writes 'import' and
    // 'config' for a run that could not even read its own marker.
    stage: 'flow',
    // HOW OFTEN this run was allowed to try, and how often it did.
    maxAttempts: maxAttemptsOf(pending),
    attempts: 0,
    // The LAST cookie cleanup, and one entry per attempt (never silent).
    cookieClear: null,
    attemptLog: [],
  };
  try {
    // (1) The new host writes the ready marker after its health check.
    const ready = await waitForReady(d, pending.timeoutMs);
    if (ready) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (2) ASK AGAIN. A host that is slow to start is not a host that is dead.
    report.rechecked = true;
    await d.sleep(Math.max(0, pending.recheckMs));
    if (d.readReady()) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (3) Is an instance ALIVE? Then there is nothing to restore.
    if (await d.probeAlive()) {
      report.result = 'abandoned';
      report.error = 'an instance is alive: the snapshot was not restored';
      return report;
    }

    // (3b) THE LAST QUESTION BEFORE A RESTORE: ask the health route itself.
    //
    // The marker is written by the plugin, so it can be missing while the host
    // is perfectly healthy (0.8.1: the write threw and the error was
    // swallowed). A restore of a live host is the worst thing this file can
    // do, so the host gets asked directly — and only a host that does not
    // answer may be rolled back.
    const health = healthAnswer(await d.askHealth());
    report.healthCheck = health.state;
    report.healthDetail = health.detail;
    if (health.state === 'healthy') {
      report.result = 'not-needed';
      report.health = 'healthy';
      report.error = 'the host answered: it is up, the snapshot was NOT restored'
        + (health.detail === null ? '' : ' (' + health.detail + ')');
      return report;
    }
    if (health.state === 'unknown') {
      // There was no port to ask (no instance record, no health URL). One more
      // round is waited, and the leftovers are looked at again: a host that is
      // still starting gets this last chance before anything is restored.
      report.extraRound = true;
      await d.sleep(Math.max(0, pending.recheckMs));
      if (d.readReady()) {
        report.result = 'not-needed';
        report.ready = true;
        return report;
      }
      if (d.isWithdrawn()) {
        report.result = 'decided';
        report.error = 'the plugin decided on its own: the watchdog stood down';
        return report;
      }
      if (await d.probeAlive()) {
        report.result = 'abandoned';
        report.error = 'an instance is alive: the snapshot was not restored';
        return report;
      }
      const lateHealth = healthAnswer(await d.askHealth());
      report.healthCheck = lateHealth.state;
      report.healthDetail = lateHealth.detail;
      if (lateHealth.state === 'healthy') {
        report.result = 'not-needed';
        report.health = 'healthy';
        report.error = 'the host answered: it is up, the snapshot was NOT restored'
          + (lateHealth.detail === null ? '' : ' (' + lateHealth.detail + ')');
        return report;
      }
    }

    // (4) The lock: exactly ONE of us restores.
    if (!d.acquireLock()) {
      report.result = 'abandoned';
      report.error = 'another rollback is already running';
      return report;
    }
    try {
      // (5) THE PASS: up to `maxAttempts` tries (3 by default, never endless).
      //
      // Every try AFTER the first asks the three questions of steps (1)-(3b)
      // again, because the world changed in between: the host we started may
      // have come up (a slow boot is not a dead host) and another instance may
      // be alive (a second start next to a running host is the double start
      // this whole file exists to prevent). The FIRST try does not ask again:
      // those three answers are a moment old and cannot have changed.
      //
      // The pass order is fixed and must stay that way:
      //   ready? -> alive? -> health? -> restore -> CLEAR THE COOKIES -> start -> wait
      let restoreNeeded = true;
      for (let attempt = 1; attempt <= report.maxAttempts; attempt += 1) {
        if (attempt > 1) {
          if (d.readReady()) {
            report.result = 'not-needed';
            report.ready = true;
            report.error = null;
            break;
          }
          if (d.isWithdrawn()) {
            report.result = 'decided';
            report.error = 'the plugin decided on its own: the watchdog stood down';
            break;
          }
          if (await d.probeAlive()) {
            report.result = 'abandoned';
            report.error = 'an instance is alive: the host was not started again';
            break;
          }
          const again = healthAnswer(await d.askHealth());
          report.healthCheck = again.state;
          report.healthDetail = again.detail;
          if (again.state === 'healthy') {
            report.result = 'not-needed';
            report.health = 'healthy';
            report.error = 'the host answered: it is up, it was NOT started again'
              + (again.detail === null ? '' : ' (' + again.detail + ')');
            break;
          }
          if (again.state === 'unknown') {
            // There is still no port to ask: one more round, then look again.
            await d.sleep(Math.max(0, pending.recheckMs));
            if (d.readReady()) {
              report.result = 'not-needed';
              report.ready = true;
              report.error = null;
              break;
            }
            if (d.isWithdrawn()) {
              report.result = 'decided';
              report.error = 'the plugin decided on its own: the watchdog stood down';
              break;
            }
            if (await d.probeAlive()) {
              report.result = 'abandoned';
              report.error = 'an instance is alive: the host was not started again';
              break;
            }
          }
        }

        report.attempts = attempt;
        const entry = {
          attempt,
          at: new Date(d.now()).toISOString(),
          restored: false,
          cookieClear: null,
          relaunched: false,
          ready: false,
          backoffMs: 0,
          error: null,
        };
        report.attemptLog.push(entry);

        // (d) Put the snapshot back. The first try always restores; a later
        // try restores again only when the restore itself failed, because the
        // snapshot is the same file tree and a second copy would change
        // nothing.
        if (restoreNeeded) {
          const restored = d.runRestore();
          report.restored = restored !== null && restored !== undefined && restored.ok === true;
          entry.restored = report.restored;
          if (!report.restored) {
            restoreNeeded = true;
            report.result = 'failed';
            report.error = restored && restored.error ? restored.error : 'the restore failed';
            entry.error = report.error;
            // Starting a host on a profile that was NOT restored only wastes
            // the pass: the next try restores again.
            if (attempt < report.maxAttempts) {
              const wait = backoffMsFor(attempt);
              entry.backoffMs = wait;
              await d.sleep(wait);
              continue;
            }
            break;
          }
          restoreNeeded = false;
        }

        // (e) THE HANDSHAKE COOKIES, AFTER the restore and BEFORE the start.
        //
        // The desktop app mints one `dsh-auth-*` cookie per launch, the cookie
        // lives 30 days, and the host answers 431 when the Cookie header
        // overflows (71 cookies, measured). Starting the host again with the
        // stale cookies therefore kills it again — that is what happened on
        // 2026-10-30. The cleanup runs once Chromium has left (the host is
        // confirmed dead above), and it never blocks the rescue: the script
        // itself always exits 0 for that reason. But it is ALWAYS written into
        // the report: a cleanup that could not run must never look like one
        // that did.
        const cookie = await runCookieClear(d);
        report.cookieClear = cookie;
        entry.cookieClear = cookie;
        if (!cookie.ok) {
          entry.error = 'the stale cookies could not be cleared: ' + (cookie.error || 'unknown reason');
        }

        // (f) Start the host again — but look at the marker ONE last time: the
        //     host may have finished its boot while the cleanup and the
        //     restore ran, and a host that is up must not be started again.
        if (d.readReady()) {
          report.result = 'not-needed';
          report.ready = true;
          report.error = 'the host came up while the watchdog was working: it was NOT started again';
          break;
        }
        const relaunched = d.runRelaunch();
        report.relaunched = relaunched !== null && relaunched !== undefined && relaunched.ok === true;
        entry.relaunched = report.relaunched;
        if (!report.relaunched) {
          report.result = 'failed';
          // "I could not start it" is not "the rescue failed after trying":
          // the report says where it stood.
          report.stage = 'relaunch';
          report.error = relaunched && relaunched.error ? relaunched.error : 'the host could not be started again';
          entry.error = report.error;
          break;
        }

        // (g) Did it come up this time?
        const readyAgain = await waitForReady(d, pending.readyTimeoutMs);
        report.ready = readyAgain;
        entry.ready = readyAgain;
        if (readyAgain) {
          report.result = 'recovered';
          report.error = null;
          break;
        }
        report.result = 'failed';
        report.error = 'the host did not come up after the restore';
        if (attempt < report.maxAttempts) {
          const wait = backoffMsFor(attempt);
          entry.backoffMs = wait;
          await d.sleep(wait);
        }
      }
      // The message of a run that ran out of attempts must SAY so: "failed"
      // alone would hide that the watchdog tried, and how often.
      if (report.result === 'failed' && report.stage === 'flow' && report.relaunched === true) {
        report.error = 'the host did not come up after ' + report.attempts + ' attempt(s) of '
          + report.maxAttempts + ' (last error: ' + String(report.error) + '): rely on the sentry';
      }
      if (report.result === 'unknown') {
        report.result = 'failed';
        report.error = 'the flow ended without an answer';
      }
    } finally {
      d.releaseLock();
    }
  } catch (error) {
    report.result = 'failed';
    report.error = error && error.message ? error.message : String(error);
  } finally {
    report.waitedMs = d.now() - startedAt;
    // The scheduling item and the pending marker go; the report stays.
    try {
      d.removeSchedule();
    } catch {
      // The scheduling item is cleaned up by the next run if this fails.
    }
    try {
      if (stateDir !== '') clearPending(stateDir);
    } catch {
      // It is gone either way.
    }
    d.writeReport(report);
  }
  return report;
}
