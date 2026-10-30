/**
 * dsh-autorestart - remove the stale handshake cookies of the desktop app.
 *
 * WHY THIS FILE EXISTS:
 *
 * The desktop app mints ONE session cookie per launch:
 *
 *   dsh-auth-<base64url(sha256(host:port))>
 *
 * The name carries the port and the port is random on every launch, so every
 * launch leaves a NEW cookie behind. The cookie lives 30 days (Max-Age=2592000)
 * and a cookie does NOT carry a port - so the browser sends ALL of them, on
 * every request, to 127.0.0.1.
 *
 * The host answers with Node's default max header size of 16384 bytes. With 71
 * cookies the Cookie header alone is 16188 bytes; add the browser's own headers
 * and the request is 16559 bytes -> the host answers 431 (Request Header Fields
 * Too Large), the desktop app reports the misleading "desktop welcome: Web
 * authentication failed" and dies on startup. The crash loop then triggers the
 * official native-fatal recovery, which wipes the profile.
 *
 * Measured on this machine (real cookies, real browser headers):
 *   70 cookies -> 16331 bytes -> 200 OK
 *   71 cookies -> 16559 bytes -> 431 Request Header Fields Too Large
 *
 * The restart helper runs this BETWEEN the kill and the relaunch: at that
 * moment Chromium has already exited and the database is not locked any more.
 *
 * THE MATCH IS DELIBERATELY WIDE (user decision, 2026-10-30):
 *
 *   host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'
 *
 * The official code that mints these cookies always writes `Path=/`, so the
 * old condition `path = '/'` looked safe - and it was one assumption away from
 * silently missing a cookie. A missed cookie still travels to 127.0.0.1 and
 * still counts against the 16 KB header, while deleting one cookie too many
 * costs a single re-login. The path is therefore NOT part of the condition.
 * Nothing else in the jar is addressed: another host, another prefix, another
 * column - all untouched.
 *
 * THE RESULT IS WRITTEN DOWN: this is the only process that knows how many
 * rows it deleted, so it writes `<stateDir>/last-cookie-clear.json`
 * (`{at, ok, removed, reason}`) and the plugin's health route reports it. The
 * state directory is `DSH_AUTORESTART_STATE_DIR` when it is set (a drill or a
 * test redirects it), otherwise the plugin's own state directory.
 *
 * RULES:
 *   - Only the dsh-auth-* cookies of 127.0.0.1 are touched. The rest of the
 *     jar is never read and never written.
 *   - The whole Cookies FILE is never deleted.
 *   - Every failure ends with exit code 0: a restart must never be blocked by
 *     a cleanup that could not run.
 *   - Pure ASCII, no byte order mark (see test/scripts-encoding.test.mjs).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The host whose cookies are addressed. */
const HOST_KEY = '127.0.0.1';

/** The name prefix the desktop app mints (`%` is the LIKE wildcard). */
const COOKIE_PREFIX = 'dsh-auth-%';

/** How many times the delete is retried while the database is still locked. */
export const RETRIES = 20;

/** How long the script waits between two attempts, in milliseconds. */
export const RETRY_DELAY_MS = 500;

/** The name of the file this script leaves its result in. */
export const REPORT_NAME = 'last-cookie-clear.json';

/** Where the outcome is written, so a failed cleanup is never silent. */
const LOG_DIR = path.join(os.homedir(), '.dsh', 'storages', 'dsh-autorestart');

/** The log file next to the result. */
const LOG_FILE = path.join(LOG_DIR, 'clear-cookies.log');

/**
 * The state directory this run belongs to.
 *
 * `DSH_AUTORESTART_STATE_DIR` exists so a drill (or a test) can point the
 * cleanup at its own directory instead of the real installation.
 *
 * @returns {string}
 */
export function stateDirOf() {
  const override = typeof process.env.DSH_AUTORESTART_STATE_DIR === 'string'
    ? process.env.DSH_AUTORESTART_STATE_DIR.trim()
    : '';
  return override === '' ? LOG_DIR : override;
}

/** The cookie jar of the desktop app. */
export function cookieJarPath() {
  const roaming = typeof process.env.APPDATA === 'string' && process.env.APPDATA !== ''
    ? process.env.APPDATA
    : path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
}

/**
 * Append one line to the log. Logging must never break the restart, so every
 * error here is swallowed on purpose.
 *
 * @param {string} line
 * @param {string} [logFile]
 */
export function log(line, logFile = LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch {
    // A log that cannot be written is not a reason to stop the restart.
  }
}

/**
 * Write the result of this run next to the state, so the plugin can report it.
 *
 * Written with `.tmp` + rename: a cleanup that is killed halfway must not leave
 * a truncated record behind (the health route would report a broken file).
 *
 * @param {{ stateDir?: string, at?: number, ok: boolean, removed: number|null, reason: string }} options
 * @returns {string} the path it was written to ('' when there is no state dir)
 */
export function writeResult({ stateDir = stateDirOf(), at = Date.now(), ok, removed, reason }) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return '';
  const target = path.join(dir, REPORT_NAME);
  const report = {
    version: 1,
    at,
    atIso: new Date(at).toISOString(),
    ok: ok === true,
    removed: Number.isFinite(Number(removed)) ? Math.max(0, Math.trunc(Number(removed))) : null,
    reason: typeof reason === 'string' ? reason : '',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temporary = target + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, target);
    return target;
  } catch {
    return '';
  }
}

/** Wait a moment. @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete the stale handshake cookies. Retries while the database is locked by
 * a Chromium that has not exited yet.
 *
 * The condition is `host_key` + `name LIKE` ONLY - see the header: a cookie
 * with another path would still be sent to 127.0.0.1, so the path is not part
 * of the match.
 *
 * @param {{
 *   jarPath?: string, retries?: number, retryDelayMs?: number,
 *   openDb?: Function,
 * }} [options]
 * @returns {Promise<{ ok: boolean, removed: number, error: string|null }>}
 */
export async function clearCookies(options = {}) {
  const jar = typeof options.jarPath === 'string' && options.jarPath !== '' ? options.jarPath : cookieJarPath();
  const retries = Number.isFinite(Number(options.retries)) && Number(options.retries) > 0
    ? Math.trunc(Number(options.retries))
    : RETRIES;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) && Number(options.retryDelayMs) >= 0
    ? Math.trunc(Number(options.retryDelayMs))
    : RETRY_DELAY_MS;
  const open = typeof options.openDb === 'function'
    ? options.openDb
    : async (target) => {
      const { DatabaseSync } = await import('node:sqlite');
      return new DatabaseSync(target);
    };
  let lastError = 'the cookie jar was never opened';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const db = await open(jar);
      try {
        const statement = db.prepare('delete from cookies where host_key = ? and name like ?');
        const info = statement.run(HOST_KEY, COOKIE_PREFIX);
        return { ok: true, removed: Number(info.changes || 0), error: null };
      } finally {
        if (db && typeof db.close === 'function') db.close();
      }
    } catch (error) {
      lastError = String((error && error.message) || error);
      if (attempt < retries) {
        await sleep(retryDelayMs);
      }
    }
  }
  return { ok: false, removed: 0, error: lastError };
}

/**
 * The whole job of this script: clear, write the result, log it.
 *
 * @param {{
 *   jarPath?: string, stateDir?: string, retries?: number, retryDelayMs?: number,
 *   logFile?: string, now?: number,
 * }} [options]
 * @returns {Promise<{ ok: boolean, removed: number, reason: string, reportPath: string }>}
 */
export async function run(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : stateDirOf();
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const result = await clearCookies({
    jarPath: options.jarPath,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
  });
  const reason = result.ok === true ? '' : String(result.error || 'the cleanup did not run');
  const reportPath = writeResult({
    stateDir,
    at: now,
    ok: result.ok === true,
    removed: result.removed,
    reason,
  });
  const jar = typeof options.jarPath === 'string' && options.jarPath !== '' ? options.jarPath : cookieJarPath();
  if (result.ok === true) {
    log('ok removed=' + result.removed + ' jar=' + jar, options.logFile || LOG_FILE);
  } else {
    log('skipped reason=' + reason + ' jar=' + jar, options.logFile || LOG_FILE);
  }
  return { ok: result.ok === true, removed: result.removed, reason, reportPath };
}

// The file is a script AND a module: the tests import the pieces above, the
// restart helper RUNS it. Only a direct run does the work.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    return path.resolve(entry) === path.resolve(decodeURIComponent(self));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await run();
  // Always 0: a restart is never blocked by this cleanup.
  process.exit(0);
}
