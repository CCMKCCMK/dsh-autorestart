/**
 * dsh-autorestart — "which plugin did not load?" (the REPORTED kind of failure).
 *
 * WHY THIS MODULE EXISTS. A plugin that fails to import does not always keep the
 * host from booting: the host comes up, the entry silently never activates, and
 * the feature behind it simply 404s. The startup log says so, in a handful of
 * lines. This module turns that text into structured failures; nothing else.
 *
 * EVERYTHING HERE IS PURE: text in, array out. No file system, no DSH, no npm.
 * The caller decides which log to read (lib/plugin-recover.js owns the file
 * discovery) and what to do about the answer.
 *
 * THE FOUR LINE SHAPES THIS RECOGNISES (all four were seen in real startup logs
 * and in the diagnostic dump of a boot audit):
 *
 *   1. `dsh: warning: 1 entry did not activate`      — the aggregate warning
 *   2. `<plugin>: failed to import: <error>`         — the import error itself
 *   3. `<plugin>: import failed ...`                  — the same, other wording
 *   4. `- <plugin>: loading`                           — an entry still loading
 *                                                        when the audit ran, i.e.
 *                                                        it never activated
 *
 * EVERYTHING ELSE IS IGNORED, on purpose. In particular the process-level dump
 * (`dsh: startup failed: 2 required plugins did not activate` followed by the
 * `Failed plugins (1):` block with `Package:` / `Error:` lines) is NOT this
 * module's business: a boot that does not come up is the existing watchdog's
 * failure, not a plugin to be swapped out. Recognising it here would make the
 * two mechanisms fight over the same incident.
 *
 * @module dsh-autorestart/lib/plugin-failure
 */

import crypto from 'node:crypto';

/**
 * How much of one error message is kept.
 *
 * A stack trace of thirty frames is useless on a card and unreadable in a JSON
 * report; the first line plus a little context is what tells a user what broke.
 */
export const MAX_ERROR_CHARS = 240;

/** How long the raw log line is kept for the report. */
export const MAX_TEXT_CHARS = 400;

/** The kinds this parser distinguishes (they end up in the report). */
export const FAILURE_KINDS = Object.freeze({
  /** `<plugin>: failed to import: <error>` */
  FAILED_TO_IMPORT: 'failed-to-import',
  /** `<plugin>: import failed ...` */
  IMPORT_FAILED: 'import-failed',
  /** `- <plugin>: loading` (never activated) */
  NOT_ACTIVATED: 'not-activated',
  /** `dsh: warning: N entry did not activate` (names no plugin) */
  WARNING: 'warning',
});

/**
 * The aggregate warning line: `dsh: warning: 1 entry did not activate`.
 *
 * It names no plugin, so it cannot be recovered on its own — but it is the line
 * that says "look at the lines around me", and dropping it would make a report
 * say "no failure found" next to the host's own warning.
 *
 * @type {RegExp}
 */
const WARNING_LINE = /^(?:dsh:\s*)?(?:warning:\s*)?(\d+)\s+entr(?:y|ies)\s+(?:did not activate|failed to activate|was not activated)\b/i;

/**
 * `<plugin>: failed to import: <error>` / `<plugin>: import failed: <error>`.
 *
 * The optional `- ` bullet is what the audit's list uses, and the optional
 * `(required)` / `(optional)` suffix is what the process-level dump uses.
 *
 * @type {RegExp}
 */
const IMPORT_FAILED_LINE = /^(?:dsh:\s*)?[-*]?\s*([@A-Za-z0-9_][\w@./-]*)\s*(?:\((?:required|optional)\))?\s*:\s*(failed to import|import failed)\b\s*:?\s*(.*)$/i;

/**
 * `- <plugin>: loading` — the entry was still loading when the audit ran.
 *
 * A plugin in this state did not activate; the line is a failure even though it
 * carries no error message. The match is anchored at the end of the line on
 * purpose: `dsh: loading profile web` is the host talking about its own work,
 * not a plugin that never activated.
 *
 * @type {RegExp}
 */
const LOADING_LINE = /^(?:dsh:\s*)?[-*]?\s*([@A-Za-z0-9_][\w@./-]*)\s*(?:\((?:required|optional)\))?\s*:\s*loading\b\s*$/i;

/**
 * Names that belong to the HOST, never to a plugin.
 *
 * `dsh: <something>` is the host's own prefix; treating `dsh` as a plugin name
 * would try to restore the harness itself.
 *
 * @type {Set<string>}
 */
const RESERVED_NAMES = new Set(['dsh', 'harness', 'node', 'npm']);

/** An ISO timestamp at the start of a line (the host's own log prefix). */
const ISO_PREFIX = /^\[?(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?\]?/;

/** A bare clock at the start of a line: `[15:33:37]`. */
const CLOCK_PREFIX = /^\[(\d{2}):(\d{2}):(\d{2})\]/;

/**
 * The timestamp prefix of a log line, as it is STRIPPED before matching.
 *
 * A real startup log prefixes each line with its time; the patterns below only
 * describe the message, so the timestamp is removed first (and read separately
 * by {@link parseLogLineTime}).
 *
 * @type {RegExp}
 */
const TIMESTAMP_PREFIX = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?\]?[ \t]*/;

/** A bracketed clock prefix: `[15:33:37] `. */
const CLOCK_ONLY_PREFIX = /^\[\d{2}:\d{2}:\d{2}\][ \t]*/;

/**
 * Drop the timestamp a log line starts with (and any `dsh: ` host prefix), so
 * the message patterns can be anchored at the message itself.
 *
 * @param {string} line
 * @returns {string}
 */
function messageOf(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  return text.replace(TIMESTAMP_PREFIX, '').replace(CLOCK_ONLY_PREFIX, '').trim();
}

/**
 * Trim one value to a bounded, single-line string.
 *
 * Control characters are dropped (a log line may carry an ANSI colour code, and
 * a JSON report with escape sequences in it is unreadable), whitespace is
 * collapsed, and an over-long value is cut with an ellipsis so the caller can
 * tell "short" from "shortened".
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clipText(value, max = MAX_ERROR_CHARS) {
  const text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.trunc(Number(max)) : MAX_ERROR_CHARS;
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, Math.max(0, limit - 1)) + '…';
}

/**
 * The FIRST line of an error message — the part that says what broke.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function errorFirstLine(value) {
  const text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') || '';
  return clipText(first, MAX_ERROR_CHARS);
}

/**
 * The time a log line carries, in milliseconds (null when it carries none).
 *
 * Two prefixes are recognised because two forms are common: the host's ISO
 * prefix and a bracketed clock. A bare clock has no date, so TODAY's date (taken
 * from `now`) is used — it is only ever compared against other lines of the same
 * file, so the day boundary is the only inaccuracy, and a log does not span days.
 *
 * @param {string} line
 * @param {number} [now]
 * @returns {number|null}
 */
export function parseLogLineTime(line, now = Date.now()) {
  const text = typeof line === 'string' ? line : '';
  const iso = ISO_PREFIX.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second, fraction = '', zone = 'Z'] = iso;
    const millis = fraction === '' ? '000' : (fraction + '000').slice(0, 3);
    const normalizedZone = zone === 'Z' || zone === undefined
      ? 'Z'
      : (zone.includes(':') ? zone : zone.slice(0, 3) + ':' + zone.slice(3));
    const stamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${normalizedZone}`);
    if (Number.isFinite(stamp)) return stamp;
    return null;
  }
  const clock = CLOCK_PREFIX.exec(text);
  if (clock) {
    const base = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
    base.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3]), 0);
    const stamp = base.getTime();
    return Number.isFinite(stamp) ? stamp : null;
  }
  return null;
}

/**
 * THE FINGERPRINT of one failure: "the same failure seen twice".
 *
 * Built from the plugin, the FIRST LINE of the error and the log time (rounded
 * to the second, so a re-read of the same file produces the same value). It is
 * what makes "this exact failure was already handled" decidable across boots:
 * the same old log line read again next boot yields the same fingerprint, so it
 * is NOT treated as a new incident and does not trigger another restore.
 *
 * The error TEXT is deliberately reduced to its first line: stack traces differ
 * between runs (line numbers, addresses), the message does not.
 *
 * @param {{ plugin?: string|null, error?: string|null, at?: number|null }} failure
 * @returns {string}
 */
export function failureFingerprint(failure = {}) {
  const plugin = typeof failure.plugin === 'string' ? failure.plugin : '';
  const error = errorFirstLine(failure.error);
  const at = Number.isFinite(Number(failure.at)) ? String(Math.floor(Number(failure.at) / 1000)) : '';
  return crypto.createHash('sha1').update([plugin, error, at].join('\u0000')).digest('hex').slice(0, 16);
}

/**
 * Recognise the plugin failures of one startup log.
 *
 * @param {string} text the log text
 * @param {{
 *   sinceMs?: number|null,
 *   logAt?: number|null,
 *   now?: number,
 *   dedupe?: boolean,
 * }} [options]
 *   `sinceMs` — lines stamped EARLIER than this are not new information and are
 *   dropped (the caller passes the start of the boot the log belongs to). An
 *   entry whose time cannot be determined is KEPT: throwing it away would hide
 *   the only record of the failure.
 *   `logAt` — the fallback time for a line without a timestamp (normally the
 *   log file's mtime).
 *   `dedupe` — drop repeated fingerprints inside the same text (default true).
 * @returns {Array<{
 *   plugin: string|null,
 *   error: string,
 *   line: number,
 *   text: string,
 *   at: number|null,
 *   kind: string,
 *   fingerprint: string,
 * }>}
 */
export function findPluginFailures(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return [];
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null;
  const logAt = Number.isFinite(Number(options.logAt)) ? Number(options.logAt) : null;
  const dedupe = options.dedupe !== false;

  const lines = source.split(/\r?\n/);
  const failures = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = typeof lines[index] === 'string' ? lines[index] : '';
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    // The timestamp (and the `dsh: ` host prefix) is dropped before matching, so
    // a real prefixed log line and a bare one are the same message.
    const message = messageOf(trimmed);

    /** @type {{ plugin: string|null, error: string, kind: string, matched: string }|null} */
    let found = null;

    const warning = WARNING_LINE.exec(message);
    if (warning) {
      // No plugin is named: the aggregate line is a SIGNAL (kind 'warning') and
      // the recovery planner never acts on it — there is nothing to swap.
      found = {
        plugin: null,
        error: clipText(`warning: ${warning[1]} entry/entries did not activate`),
        kind: FAILURE_KINDS.WARNING,
        matched: trimmed,
      };
    }

    if (found === null) {
      const failed = IMPORT_FAILED_LINE.exec(message);
      if (failed) {
        let detail = typeof failed[3] === 'string' ? failed[3].trim() : '';
        if (detail === '') {
          // The message may sit on the next (indented) line of the log.
          for (let look = index + 1; look < Math.min(lines.length, index + 4); look += 1) {
            const next = typeof lines[look] === 'string' ? lines[look] : '';
            if (next.trim() === '') continue;
            if (!/^\s+/.test(next)) break;
            detail = next.trim();
            break;
          }
        }
        found = {
          plugin: failed[1],
          error: clipText(detail === '' ? 'the import failed without a message' : detail),
          kind: /failed to import/i.test(failed[2])
            ? FAILURE_KINDS.FAILED_TO_IMPORT
            : FAILURE_KINDS.IMPORT_FAILED,
          matched: trimmed,
        };
      }
    }

    if (found === null) {
      const loading = LOADING_LINE.exec(message);
      if (loading) {
        found = {
          plugin: loading[1],
          error: clipText('the entry was still loading when the startup audit ran: it never activated'),
          kind: FAILURE_KINDS.NOT_ACTIVATED,
          matched: trimmed,
        };
      }
    }

    // Anything else is not a plugin failure this module knows (a stack frame, a
    // config line, the process-level dump, the usual chatter): ignored.
    if (found === null) continue;
    // `dsh: …` is the HOST talking: the harness itself is not a plugin to swap.
    if (typeof found.plugin === 'string' && RESERVED_NAMES.has(found.plugin.toLowerCase())) continue;

    const at = parseLogLineTime(trimmed, now) ?? logAt;
    if (sinceMs !== null && at !== null && at < sinceMs) continue;

    const entry = {
      plugin: found.plugin,
      error: found.error,
      line: index + 1,
      text: clipText(trimmed, MAX_TEXT_CHARS),
      at: at === null ? null : Math.trunc(at),
      kind: found.kind,
      fingerprint: '',
    };
    entry.fingerprint = failureFingerprint(entry);
    if (dedupe && seen.has(entry.fingerprint)) continue;
    seen.add(entry.fingerprint);
    failures.push(entry);
  }

  return failures;
}

/**
 * The plugins a failure list really names, one entry per plugin, newest first.
 *
 * Several lines can describe the SAME plugin (the aggregate warning, an import
 * error, a "still loading" line). The recovery works per plugin, and the BEST
 * description is the one that carries an error message — so a silent
 * "did not activate" line never overwrites a real error.
 *
 * @param {Array<object>} failures
 * @returns {Array<object>}
 */
export function mergeFailuresByPlugin(failures = []) {
  const byPlugin = new Map();
  for (const failure of Array.isArray(failures) ? failures : []) {
    if (!failure || typeof failure !== 'object') continue;
    const plugin = typeof failure.plugin === 'string' ? failure.plugin : '';
    // An aggregate warning names no plugin: it can never be restored, and it is
    // not merged into anybody (it is reported on its own).
    const key = plugin === '' ? `\u0000warning:${failure.line}:${failure.fingerprint}` : plugin;
    const previous = byPlugin.get(key);
    if (previous === undefined) {
      byPlugin.set(key, failure);
      continue;
    }
    const previousHasError = typeof previous.kind === 'string'
      && previous.kind !== FAILURE_KINDS.NOT_ACTIVATED
      && previous.kind !== FAILURE_KINDS.WARNING;
    const currentHasError = typeof failure.kind === 'string'
      && failure.kind !== FAILURE_KINDS.NOT_ACTIVATED
      && failure.kind !== FAILURE_KINDS.WARNING;
    if (!previousHasError && currentHasError) byPlugin.set(key, failure);
  }
  return [...byPlugin.values()];
}
