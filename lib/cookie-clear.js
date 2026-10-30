/**
 * dsh-autorestart - the command that removes the STALE handshake cookies.
 *
 * WHY THIS EXISTS:
 *
 * The desktop app mints ONE `dsh-auth-*` cookie per launch. The name carries
 * the random port, the cookie lives 30 days (Max-Age=2592000), and a cookie
 * does NOT carry a port - so the browser sends ALL of them, on every request,
 * to 127.0.0.1.
 *
 * The host answers with Node's default max header size of 16384 bytes. With 71
 * cookies the Cookie header alone is 16188 bytes; add the browser's own headers
 * and the request is 16559 bytes -> the host answers 431 (Request Header
 * Fields Too Large), the desktop app reports the misleading "desktop welcome:
 * Web authentication failed" and dies on startup. The crash loop then trips
 * the official native-fatal recovery, which wipes the profile and drops every
 * plugin but two.
 *
 * Measured on this machine with the real cookies and the real browser headers:
 *   70 cookies -> 16331 bytes -> 200 OK
 *   71 cookies -> 16559 bytes -> 431 Request Header Fields Too Large
 *
 * WHERE IT RUNS: between the kill and the relaunch. Only then has Chromium
 * left, and only then is the cookie jar unlocked.
 *
 * WHAT IT MATCHES (widened, user decision 2026-10-30): every `dsh-auth-%`
 * cookie of `127.0.0.1`, WHATEVER its path. The official code that mints them
 * always writes `Path=/`, but a leftover cookie with another path would still
 * be sent to `127.0.0.1` and would still count against the 16 KB header — and
 * a missed deletion costs far more than a deleted one. Nothing else in the jar
 * is ever addressed.
 *
 * The command is EMPTY when the interpreter or the script cannot be found: the
 * restart then behaves exactly as it did before, and a cleanup that cannot run
 * never blocks a restart.
 *
 * This module is the SINGLE source of the command: the plugin and the
 * verification script both build it here, so a verification can never prove
 * something the plugin does not actually do.
 *
 * THE RESULT IS WRITTEN DOWN: the cleanup script writes
 * `<stateDir>/last-cookie-clear.json` (`{at, ok, removed, reason}`) because it
 * is the only process that can know how many rows it deleted, and the health
 * route reports that record. It is the result of the LAST cleanup, never a
 * live count: the cookie jar is locked by the running browser, so a live count
 * would be a guess dressed as a fact.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNodeInterpreter } from './node-runtime.js';

/** The directory this very file lives in - the plugin directory. */
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The cleanup script, next to the other rescue scripts. */
export const COOKIE_CLEAR_SCRIPT_NAME = 'clear-dsh-auth-cookies.mjs';

/** How long the cleanup may run before it is killed, in milliseconds. */
const CLEANUP_TIMEOUT_MS = 20000;

/** The file the cleanup script writes its result into (inside the state dir). */
export const COOKIE_CLEAR_REPORT_NAME = 'last-cookie-clear.json';

/** The version of that record. */
export const COOKIE_CLEAR_REPORT_VERSION = 1;

/**
 * The path of the cleanup result.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function cookieClearReportPath(stateDir) {
  const root = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (root === '') return '';
  return path.join(root, COOKIE_CLEAR_REPORT_NAME);
}

/**
 * Write the result of a cleanup.
 *
 * The four fields the health route and the settings page read are `at`, `ok`,
 * `removed` and `reason`; the version and the ISO time are there so a human
 * reading the file does not have to convert an epoch.
 *
 * @param {string} stateDir
 * @param {{ at?: number, ok?: boolean, removed?: number|null, reason?: string }} [payload]
 * @returns {{ ok: boolean, path: string, report: object|null, error: string|null }}
 */
export function writeCookieClearReport(stateDir, payload = {}) {
  const target = cookieClearReportPath(stateDir);
  if (target === '') {
    return { ok: false, path: '', report: null, error: 'there is no state directory to write the result into' };
  }
  const at = Number.isFinite(Number(payload.at)) ? Number(payload.at) : Date.now();
  const report = {
    version: COOKIE_CLEAR_REPORT_VERSION,
    at,
    atIso: new Date(at).toISOString(),
    ok: payload.ok === true,
    removed: Number.isFinite(Number(payload.removed)) ? Math.max(0, Math.trunc(Number(payload.removed))) : null,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.tmp';
    // No byte order mark: every reader of this file is JSON.parse.
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, target);
    return { ok: true, path: target, report, error: null };
  } catch (error) {
    return {
      ok: false,
      path: target,
      report,
      error: error && error.message ? String(error.message) : String(error),
    };
  }
}

/**
 * Read the result of the last cleanup.
 *
 * A file that is not there is an ANSWER ("no cleanup has run yet"), not an
 * error: the very first launch of a fresh installation has none.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, report: object|null, error: string|null }}
 */
export function readCookieClearReport(stateDir) {
  const target = cookieClearReportPath(stateDir);
  if (target === '') return { ok: false, report: null, error: 'there is no state directory to read the result from' };
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    const missing = error && error.code === 'ENOENT';
    return {
      ok: false,
      report: null,
      error: missing ? 'no cleanup has run yet' : (error && error.message ? String(error.message) : String(error)),
    };
  }
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, report: null, error: 'the cleanup result is not an object' };
    }
    return { ok: true, report: parsed, error: null };
  } catch (error) {
    return {
      ok: false,
      report: null,
      error: 'the cleanup result cannot be parsed: ' + (error && error.message ? String(error.message) : String(error)),
    };
  }
}

/**
 * The cleanup result as the health route reports it.
 *
 * TWO HONESTY RULES, both written down here so nobody "improves" them later:
 *
 *   1. the numbers are those of the LAST cleanup, never a live count. The
 *      cookie jar is an open SQLite database of a RUNNING browser; reading it
 *      while Chromium holds it either fails or (worse) reports a number that
 *      is already stale. `live` is therefore always `null`, and the note says
 *      why.
 *   2. "no cleanup has run yet" and "the cleanup could not run" are different
 *      answers, and neither is reported as success.
 *
 * @param {object|null} report the parsed `last-cookie-clear.json`, if any
 * @param {{ readError?: string|null }} [meta]
 * @returns {{
 *   at: number|null, atIso: string|null, ok: boolean|null, removed: number|null,
 *   reason: string, live: null, liveNote: string, source: string,
 * }}
 */
export function summarizeCookieClear(report, meta = {}) {
  const source = 'last-cookie-clear.json';
  const liveNote = 'the live number of cookies cannot be read: the cookie jar belongs to the running browser and is locked; this is the result of the last cleanup';
  const record = report && typeof report === 'object' ? report : null;
  if (record === null) {
    return {
      at: null,
      atIso: null,
      ok: null,
      removed: null,
      reason: typeof meta.readError === 'string' && meta.readError !== ''
        ? String(meta.readError)
        : 'no cleanup has run yet',
      live: null,
      liveNote,
      source,
    };
  }
  const at = Number.isFinite(Number(record.at)) ? Number(record.at) : null;
  return {
    at,
    atIso: typeof record.atIso === 'string' ? record.atIso : (at === null ? null : new Date(at).toISOString()),
    ok: record.ok === true,
    removed: Number.isFinite(Number(record.removed)) ? Number(record.removed) : null,
    reason: typeof record.reason === 'string' ? record.reason : '',
    live: null,
    liveNote,
    source,
  };
}

/**
 * Escape a value for a single-quoted PowerShell string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function psQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

/**
 * Build the command that removes the stale handshake cookies.
 *
 * @param {{
 *   pluginDir?: string,
 *   execPath?: string,
 *   platform?: string,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {string} the command, or '' when it cannot be built
 */
export function buildCookieClearCommand(options = {}) {
  try {
    const pluginDir = typeof options.pluginDir === 'string' && options.pluginDir !== ''
      ? options.pluginDir
      : PLUGIN_DIR;
    const script = path.join(pluginDir, 'scripts', COOKIE_CLEAR_SCRIPT_NAME);
    if (!fs.existsSync(script)) return '';
    const interpreter = resolveNodeInterpreter({
      execPath: typeof options.execPath === 'string' ? options.execPath : process.execPath,
      platform: typeof options.platform === 'string' ? options.platform : process.platform,
    });
    if (!interpreter.ok) return '';
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : CLEANUP_TIMEOUT_MS;
    // The cleanup runs as its own hidden process with a wait timeout: if it
    // hangs, it is killed and the relaunch continues anyway.
    return 'powershell.exe -NoProfile -NonInteractive -Command '
      + '"$p = Start-Process -FilePath ' + psQuote(interpreter.path)
      + ' -ArgumentList ' + psQuote(script)
      + ' -WindowStyle Hidden -PassThru; if ($null -ne $p) { if (-not $p.WaitForExit(' + timeoutMs + ')) { $p.Kill() } }"';
  } catch {
    return '';
  }
}
