/**
 * dsh-autorestart — put a FAILED PLUGIN back to the version that worked.
 *
 * The failure this module answers is the REPORTED one: an entry did not
 * activate, so the host is up but the feature behind the plugin 404s
 * (lib/plugin-failure.js reads that verdict out of the startup log). The
 * process-level failure — the host does not come up at all — is NOT this
 * module's business: that is the pre-restart snapshot and the watchdog.
 *
 * WHAT IT DOES, per failed plugin:
 *
 *   - the newest KNOWN-GOOD backup holds a real copy (`node_modules/<name>`)
 *     -> `overwrite`: the live directory is renamed aside as
 *        `<name>.broken-<ts>` (EVIDENCE: nothing is ever deleted) and the
 *        backup copy takes its place;
 *   - the backup holds the CONTENTS of a `link:` installation
 *     (`node_modules-link/<name>`, see lib/backup.js) -> `replace-link`: the
 *     live link is moved aside the same way and the copied contents take its
 *     place (the same meaning as the existing `force` restore rule);
 *   - the backup holds nothing for it -> `no-backup`: nothing is touched, the
 *     REASON is written down;
 *   - the plugin is not in the profile's enabled list -> `no-backup` as well
 *     (we do not write into a plugin tree we cannot account for).
 *
 * TWO LOOPS ARE POSSIBLE AND BOTH ARE STOPPED (user decision, 2026-11-01):
 *
 *   1. THE SAME OLD LOG LINE READ AGAIN. Every boot would "find" the line the
 *      previous boot left behind -> restore + restart, forever. Two guards:
 *      `findPluginFailures` drops lines older than the boot the log belongs to,
 *      and every failure carries a FINGERPRINT (plugin + first error line + log
 *      time) that is recorded as `handled` in `plugin-recovery.json`: one
 *      fingerprint is acted on ONCE (`duplicate` afterwards).
 *   2. THE CAUSE IS NOT IN THE PLUGIN (a missing peer dependency, a missing host
 *      capability). Swapping the version back cannot fix that, so the plugin
 *      would fail on every boot. Guard: one plugin is restored ONCE per cycle;
 *      a second failure of the same plugin reports `needs-human` and does NOT
 *      touch anything and does NOT request a restart. A boot whose log holds no
 *      plugin failure resets the cycle.
 *
 * AND IT IS IDEMPOTENT: before copying, the live directory is compared with the
 * backup copy (relative path + size + sha256 of every file). When they already
 * match there is nothing to restore, so nothing is copied and no restart is
 * asked for (`already-consistent`).
 *
 * ESM only, Node builtins only. The file system is injectable so every branch
 * (including the rename that leaves the evidence) is testable without touching
 * a real profile.
 *
 * @module dsh-autorestart/lib/plugin-recover
 */

import crypto from 'node:crypto';
import fsDefault from 'node:fs';
import path from 'node:path';

import {
  KIND_KNOWN_GOOD,
  LINKS_DIR,
  META_NAME,
  PLUGINS_DIR,
  latestKnownGood,
  readBackupMeta,
} from './backup.js';
import { failureFingerprint, findPluginFailures, mergeFailuresByPlugin } from './plugin-failure.js';

/** The durable bookkeeping of the recovery cycles (next to the checkpoint). */
export const RECOVERY_STATE_NAME = 'plugin-recovery.json';

/** The readable report of the last recovery (what the interface shows). */
export const RECOVERY_REPORT_NAME = 'last-plugin-recovery.json';

/** The version of the bookkeeping file's shape. */
export const RECOVERY_STATE_VERSION = 1;

/** How many handled fingerprints are remembered (oldest are dropped first). */
export const HANDLED_LIMIT = 64;

/** How many plugins one cycle may hold an attempt record for. */
export const ENTRY_LIMIT = 32;

/** How many restore attempts one plugin gets per cycle (hard requirement). */
export const DEFAULT_ATTEMPT_LIMIT = 1;

/**
 * The decisions a plan can carry.
 *
 * The first three are the restore modes of the contract; the rest are the
 * "nothing is touched, so nothing is restarted" answers.
 */
export const RECOVERY_MODES = Object.freeze({
  /** A real copy in the backup takes the place of the live directory. */
  OVERWRITE: 'overwrite',
  /** The contents of a `link:` installation take the place of the live link. */
  REPLACE_LINK: 'replace-link',
  /** The backup holds nothing for this plugin: nothing is touched. */
  NO_BACKUP: 'no-backup',
  /** The live directory already equals the backup copy: nothing to do. */
  ALREADY_CONSISTENT: 'already-consistent',
  /** This exact failure was already handled once: not a new incident. */
  DUPLICATE: 'duplicate',
  /** This plugin already used its one attempt: a human has to look. */
  NEEDS_HUMAN: 'needs-human',
  /**
   * THE BACKUP DELIBERATELY DOES NOT HOLD THIS PLUGIN (2026-11-01).
   *
   * A slim backup keeps only what cannot be fetched again: the configuration and
   * the plugins installed as links. A third-party plugin is NOT in it, so there is
   * nothing to copy back — the honest answer is "reinstall it", not "no backup".
   */
  NEEDS_ONLINE_REINSTALL: 'needs-online-reinstall',
});

/** The modes that really change files (and are therefore the only ones that restart). */
export const RESTORE_MODES = Object.freeze([
  RECOVERY_MODES.OVERWRITE,
  RECOVERY_MODES.REPLACE_LINK,
]);

/** How many files one idempotency comparison may hash. */
export const DIGEST_MAX_FILES = 400;

/** How large one file may be to be hashed for the comparison. */
export const DIGEST_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * A compact local stamp for the evidence directory: `20261101T073000`.
 *
 * The rename target is `<name>.broken-<ts>`, so the stamp must be file-system
 * safe on every platform: no colons (Windows refuses them), no spaces.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function recoveryStamp(now = Date.now()) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    'T',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

/**
 * The name the live directory is moved to when it is replaced.
 *
 * @param {string} plugin
 * @param {number} [now]
 * @returns {string} a plain directory name (never a path)
 */
export function brokenNameFor(plugin, now = Date.now()) {
  const name = typeof plugin === 'string' ? plugin.trim() : '';
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  return `${safe}.broken-${recoveryStamp(now)}`;
}

// ---------------------------------------------------------------------------
// The bookkeeping file (`<stateDir>/plugin-recovery.json`)
// ---------------------------------------------------------------------------

/** An empty bookkeeping record. */
export function createRecoveryState() {
  return { version: RECOVERY_STATE_VERSION, entries: [], handled: [] };
}

/**
 * Coerce anything read from disk into the bookkeeping shape.
 *
 * A file written by a future build, a hand-edited one or a half-written one must
 * never take the boot down: unknown fields are dropped and the rest is repaired.
 *
 * @param {unknown} raw
 * @returns {{ version: number, entries: Array<object>, handled: Array<object> }}
 */
export function normalizeRecoveryState(raw) {
  const state = createRecoveryState();
  if (!raw || typeof raw !== 'object') return state;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const plugin = typeof entry.plugin === 'string' ? entry.plugin.trim() : '';
    if (plugin === '') continue;
    if (state.entries.some((known) => known.plugin === plugin)) continue;
    if (state.entries.length >= ENTRY_LIMIT) break;
    state.entries.push({
      plugin,
      attempts: Number.isFinite(Number(entry.attempts)) && Number(entry.attempts) > 0
        ? Math.trunc(Number(entry.attempts))
        : 0,
      firstAt: Number.isFinite(Number(entry.firstAt)) ? Math.trunc(Number(entry.firstAt)) : null,
      lastAt: Number.isFinite(Number(entry.lastAt)) ? Math.trunc(Number(entry.lastAt)) : null,
      restartedAt: Number.isFinite(Number(entry.restartedAt)) ? Math.trunc(Number(entry.restartedAt)) : null,
    });
  }
  const handled = Array.isArray(raw.handled) ? raw.handled : [];
  for (const record of handled) {
    if (!record || typeof record !== 'object') continue;
    const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint.trim() : '';
    if (fingerprint === '') continue;
    if (state.handled.some((known) => known.fingerprint === fingerprint)) continue;
    state.handled.push({
      fingerprint,
      plugin: typeof record.plugin === 'string' && record.plugin !== '' ? record.plugin : null,
      at: Number.isFinite(Number(record.at)) ? Math.trunc(Number(record.at)) : null,
    });
  }
  // Only the newest records are kept: an unbounded list would grow with every
  // incident this machine ever had.
  if (state.handled.length > HANDLED_LIMIT) {
    state.handled = state.handled.slice(state.handled.length - HANDLED_LIMIT);
  }
  return state;
}

/**
 * Read the bookkeeping of the recovery cycles.
 *
 * A missing or unreadable file is NOT an error: it means "no cycle has run yet".
 *
 * @param {string} stateDir
 * @param {{ fs?: object }} [options]
 * @returns {{ version: number, entries: Array<object>, handled: Array<object>, corrupt: boolean }}
 */
export function readRecoveryState(stateDir, { fs = fsDefault } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  const empty = { ...createRecoveryState(), corrupt: false };
  if (dir === '') return empty;
  try {
    const text = fs.readFileSync(path.join(dir, RECOVERY_STATE_NAME), 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return { ...normalizeRecoveryState(parsed), corrupt: false };
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return { ...empty, corrupt: missing !== true };
  }
}

/**
 * Write the bookkeeping back. Never throws: a failed write only costs the loop
 * guard, and a boot must not die for it.
 *
 * @param {string} stateDir
 * @param {object} state
 * @param {{ fs?: object }} [options]
 * @returns {boolean} whether it was written
 */
export function writeRecoveryState(stateDir, state, { fs = fsDefault } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  const normalized = normalizeRecoveryState(state);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECOVERY_STATE_NAME), JSON.stringify(normalized, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * How many restore attempts one plugin has already used in this cycle.
 *
 * @param {object} state
 * @param {string} plugin
 * @returns {number}
 */
export function attemptsFor(state, plugin) {
  const name = typeof plugin === 'string' ? plugin : '';
  if (name === '' || !state || !Array.isArray(state.entries)) return 0;
  const entry = state.entries.find((candidate) => candidate.plugin === name);
  return entry && Number.isFinite(Number(entry.attempts)) ? Number(entry.attempts) : 0;
}

/**
 * May this plugin be restored again in this cycle?
 *
 * ATTEMPT 1 IS ALLOWED, ATTEMPT 2 IS REFUSED — that is the whole point: a plugin
 * that fails twice with a restored-good version has a cause outside the plugin,
 * and another restart would only cost the user another boot.
 *
 * @param {object} state
 * @param {string} plugin
 * @param {{ limit?: number }} [options]
 * @returns {{ allowed: boolean, attempts: number, limit: number, reason: string }}
 */
export function decideAttempt(state, plugin, { limit = DEFAULT_ATTEMPT_LIMIT } = {}) {
  const budget = Number.isFinite(Number(limit)) && Number(limit) >= 1
    ? Math.trunc(Number(limit))
    : DEFAULT_ATTEMPT_LIMIT;
  const attempts = attemptsFor(state, plugin);
  if (attempts >= budget) {
    return {
      allowed: false,
      attempts,
      limit: budget,
      reason: `this plugin already used its ${budget} restore attempt(s) in this cycle: `
        + 'the cause is probably not the plugin version (a missing peer dependency or a missing host '
        + 'capability is not fixed by swapping the copy back), so nothing is touched and a human has to look',
    };
  }
  return {
    allowed: true,
    attempts,
    limit: budget,
    reason: attempts === 0
      ? 'no restore attempt has been made for this plugin in this cycle'
      : `attempt ${attempts + 1} of ${budget}`,
  };
}

/**
 * Record that one plugin was restored (the attempt is spent NOW).
 *
 * @param {object} state
 * @param {string} plugin
 * @param {{ now?: number, restarted?: boolean }} [options]
 * @returns {object|null} the entry that was written
 */
export function recordAttempt(state, plugin, { now = Date.now(), restarted = false } = {}) {
  const target = state && typeof state === 'object' ? state : null;
  const name = typeof plugin === 'string' ? plugin.trim() : '';
  if (target === null || name === '') return null;
  if (!Array.isArray(target.entries)) target.entries = [];
  const at = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();
  let entry = target.entries.find((candidate) => candidate.plugin === name);
  if (!entry) {
    entry = { plugin: name, attempts: 0, firstAt: at, lastAt: at, restartedAt: null };
    target.entries.push(entry);
  }
  entry.attempts = Number(entry.attempts || 0) + 1;
  entry.lastAt = at;
  if (entry.firstAt === null || entry.firstAt === undefined) entry.firstAt = at;
  if (restarted === true) entry.restartedAt = at;
  if (target.entries.length > ENTRY_LIMIT) target.entries = target.entries.slice(target.entries.length - ENTRY_LIMIT);
  return entry;
}

/**
 * Was THIS exact failure already handled once?
 *
 * @param {object} state
 * @param {string} fingerprint
 * @returns {object|null} the record, or null
 */
export function handledRecord(state, fingerprint) {
  const wanted = typeof fingerprint === 'string' ? fingerprint.trim() : '';
  if (wanted === '' || !state || !Array.isArray(state.handled)) return null;
  return state.handled.find((record) => record.fingerprint === wanted) || null;
}

/**
 * Remember that one failure was handled (it is never acted on again).
 *
 * @param {object} state
 * @param {{ fingerprint?: string, plugin?: string|null, now?: number }} [options]
 * @returns {object|null} the record that was written
 */
export function markHandled(state, { fingerprint = '', plugin = null, now = Date.now() } = {}) {
  const target = state && typeof state === 'object' ? state : null;
  const value = typeof fingerprint === 'string' ? fingerprint.trim() : '';
  if (target === null || value === '') return null;
  if (!Array.isArray(target.handled)) target.handled = [];
  const existing = target.handled.find((record) => record.fingerprint === value);
  if (existing) return existing;
  const record = {
    fingerprint: value,
    plugin: typeof plugin === 'string' && plugin !== '' ? plugin : null,
    at: Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now(),
  };
  target.handled.push(record);
  if (target.handled.length > HANDLED_LIMIT) {
    target.handled = target.handled.slice(target.handled.length - HANDLED_LIMIT);
  }
  return record;
}

/**
 * End the cycle: one boot without any plugin failure proves the machine is fine.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {{ reset: boolean, entries: number, handled: number, at: number }}
 */
export function resetRecoveryCycle(state, { now = Date.now() } = {}) {
  const target = state && typeof state === 'object' ? state : createRecoveryState();
  const entries = Array.isArray(target.entries) ? target.entries.length : 0;
  const handled = Array.isArray(target.handled) ? target.handled.length : 0;
  target.version = RECOVERY_STATE_VERSION;
  target.entries = [];
  target.handled = [];
  return {
    reset: entries > 0 || handled > 0,
    entries,
    handled,
    at: Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// The startup logs (`<DSH_HOME>/logs/startup-*.log`)
// ---------------------------------------------------------------------------

/**
 * The boot time a startup log file name carries: `startup-<ISO>-<id>.log`.
 *
 * The name is the ONLY place a log dates itself without opening it, and it is
 * what makes "the lines of this log belong to THAT boot" decidable.
 *
 * @param {string} name
 * @returns {number|null}
 */
export function parseStartupLogName(name) {
  const text = typeof name === 'string' ? name : '';
  const match = /^startup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?Z/i.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = '000'] = match;
  const millis = (fraction + '000').slice(0, 3);
  const stamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Every startup log of this machine, newest first.
 *
 * @param {string} logsDir
 * @param {{ fs?: object }} [options]
 * @returns {Array<{ name: string, path: string, at: number|null, mtime: number, size: number }>}
 */
export function listStartupLogs(logsDir, { fs = fsDefault } = {}) {
  const dir = typeof logsDir === 'string' ? logsDir.trim() : '';
  if (dir === '') return [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const logs = [];
  for (const name of Array.isArray(names) ? names : []) {
    const text = typeof name === 'string' ? name : String(name);
    if (!/^startup-.*\.log$/i.test(text)) continue;
    const full = path.join(dir, text);
    let mtime = 0;
    let size = 0;
    try {
      const stat = fs.statSync(full);
      mtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : new Date(stat.mtime).getTime();
      size = Number.isFinite(stat.size) ? stat.size : 0;
    } catch {
      continue;
    }
    logs.push({ name: text, path: full, at: parseStartupLogName(text), mtime, size });
  }
  logs.sort((left, right) => (right.mtime - left.mtime) || (right.name < left.name ? -1 : 1));
  return logs;
}

/**
 * The log of the PREVIOUS boot — the one that can hold a plugin failure.
 *
 * WHY `before`: the host writes its own startup log from the first second of the
 * boot. Reading "the newest log" would therefore read the log of the boot that
 * is looking for failures — a log which cannot yet contain its own audit
 * verdict. Only a log written BEFORE this boot started describes a finished
 * boot, so that is the one that is read. It also keeps an older, already
 * handled incident from being dug up again.
 *
 * @param {string} logsDir
 * @param {{ before?: number|null, fs?: object }} [options]
 * @returns {{ name: string, path: string, at: number|null, mtime: number, size: number }|null}
 */
export function findLatestStartupLog(logsDir, { before = null, fs = fsDefault } = {}) {
  const logs = listStartupLogs(logsDir, { fs });
  if (logs.length === 0) return null;
  const cutoff = Number.isFinite(Number(before)) ? Number(before) : null;
  if (cutoff === null) return logs[0];
  const older = logs.find((log) => log.mtime <= cutoff);
  // No older log: this is the very first boot that logs at all, so there is no
  // finished boot to look at and nothing to recover.
  return older || null;
}

// ---------------------------------------------------------------------------
// Idempotency: is the live directory already the backup copy?
// ---------------------------------------------------------------------------

/**
 * A stable digest of a directory tree: relative path + size + sha256 per file.
 *
 * Files that cannot be read, a tree that is too large or one that is missing all
 * answer `ok: false` — "unknown", never "identical". A comparison that cannot be
 * made must not be reported as "nothing to do".
 *
 * @param {string} dir
 * @param {{ fs?: object, maxFiles?: number, maxFileBytes?: number }} [options]
 * @returns {{ ok: boolean, exists: boolean, files: number, bytes: number, digest: string|null, error: string|null }}
 */
export function treeDigest(dir, {
  fs = fsDefault,
  maxFiles = DIGEST_MAX_FILES,
  maxFileBytes = DIGEST_MAX_FILE_BYTES,
} = {}) {
  const root = typeof dir === 'string' ? dir.trim() : '';
  const empty = { ok: false, exists: false, files: 0, bytes: 0, digest: null, error: null };
  if (root === '') return { ...empty, error: 'treeDigest requires a directory' };
  let stat = null;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return missing ? { ...empty, error: null } : { ...empty, error: String(error) };
  }
  // A LINK is never "the same" as a copied tree: the whole point of the
  // replace-link mode is that the contents must take its place.
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink() === true) {
    return { ...empty, exists: true, error: 'the live entry is a link' };
  }
  if (typeof stat.isDirectory === 'function' && stat.isDirectory() !== true) {
    return { ...empty, exists: true, error: 'the live entry is not a directory' };
  }
  const rows = [];
  let files = 0;
  let bytes = 0;
  const walk = (current, relative) => {
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch (error) {
      throw new Error(`cannot read ${current}: ${error && error.message ? error.message : String(error)}`);
    }
    for (const name of names) {
      const entryName = typeof name === 'string' ? name : String(name);
      const full = path.join(current, entryName);
      const rel = relative === '' ? entryName : `${relative}/${entryName}`;
      const info = fs.lstatSync(full);
      if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink() === true) {
        rows.push(`${rel}\u0000link`);
        files += 1;
        continue;
      }
      if (typeof info.isDirectory === 'function' && info.isDirectory() === true) {
        walk(full, rel);
        continue;
      }
      const size = Number.isFinite(info.size) ? Number(info.size) : 0;
      if (size > maxFileBytes) {
        throw new Error(`${rel} is larger than the comparison limit`);
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      rows.push(`${rel}\u0000${size}\u0000${hash}`);
      files += 1;
      bytes += size;
      if (files > maxFiles) throw new Error(`more than ${maxFiles} files`);
    }
  };
  try {
    walk(root, '');
  } catch (error) {
    return {
      ok: false,
      exists: true,
      files,
      bytes,
      digest: null,
      error: error && error.message ? error.message : String(error),
    };
  }
  rows.sort();
  const digest = crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  return { ok: true, exists: true, files, bytes, digest, error: null };
}

/**
 * Is the live plugin directory already the backup copy?
 *
 * @param {string} liveDir
 * @param {string} backupDir
 * @param {{ fs?: object }} [options]
 * @returns {{ same: boolean, known: boolean, live: object, backup: object, reason: string }}
 */
export function sameAsBackup(liveDir, backupDir, { fs = fsDefault } = {}) {
  const live = treeDigest(liveDir, { fs });
  const backup = treeDigest(backupDir, { fs });
  if (live.ok !== true || backup.ok !== true) {
    return {
      same: false,
      known: false,
      live,
      backup,
      reason: 'the two trees could not be compared, so the copy is taken',
    };
  }
  if (live.digest === backup.digest) {
    return {
      same: true,
      known: true,
      live,
      backup,
      reason: `the live directory already equals the backup (${live.files} files, ${live.bytes} bytes)`,
    };
  }
  return {
    same: false,
    known: true,
    live,
    backup,
    reason: `the live directory differs from the backup (${live.files} files / ${live.bytes} bytes against ${backup.files} files / ${backup.bytes} bytes)`,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Where the backup keeps one plugin, and in which of the two shapes.
 *
 * @param {{ backupDir: string, plugin: string, fs?: object }} options
 * @returns {{ source: string|null, mode: string, reason: string }}
 */
export function locateBackupCopy({ backupDir, plugin, fs = fsDefault, slim = false, isLinkInstall = false } = {}) {
  const root = typeof backupDir === 'string' ? backupDir.trim() : '';
  const name = typeof plugin === 'string' ? plugin.trim() : '';
  if (root === '' || name === '') {
    return { source: null, mode: RECOVERY_MODES.NO_BACKUP, reason: 'no backup directory or no plugin name was given' };
  }
  const copied = path.join(root, PLUGINS_DIR, name);
  try {
    const info = fs.lstatSync(copied);
    const isLink = typeof info.isSymbolicLink === 'function' && info.isSymbolicLink() === true;
    if (isLink !== true && info.isDirectory() === true) {
      return {
        source: copied,
        mode: RECOVERY_MODES.OVERWRITE,
        reason: 'the backup holds a real copy of this plugin: it overwrites the live directory',
      };
    }
  } catch {
    /* nothing at the copied path: try the linked contents */
  }
  const linked = path.join(root, LINKS_DIR, name);
  try {
    const info = fs.lstatSync(linked);
    if (info.isDirectory() === true) {
      return {
        source: linked,
        mode: RECOVERY_MODES.REPLACE_LINK,
        reason: 'the backup holds the CONTENTS of a link: installation, so they take the place of the live link',
      };
    }
  } catch {
    /* nothing there either */
  }
  // A SLIM BACKUP DOES NOT HOLD THIRD-PARTY PLUGINS AT ALL. That is not a broken
  // backup and not a missing one — it is a backup that expects the plugin to be
  // reinstalled from package.json + pnpm-lock.yaml. Saying "no backup" would send
  // the user looking for a bug; this says what to do instead.
  //
  // Only reachable when the caller says the backup is slim, so every existing
  // recovery path answers exactly as it did before.
  if (slim === true && isLinkInstall !== true) {
    return {
      source: null,
      mode: RECOVERY_MODES.NEEDS_ONLINE_REINSTALL,
      reason: 'this backup keeps only the configuration and the hand-written link plugins; '
        + 'the plugin ' + name + ' has to be reinstalled (package.json + pnpm-lock.yaml)',
    };
  }
  return {
    source: null,
    mode: RECOVERY_MODES.NO_BACKUP,
    reason: 'the backup holds neither a copy nor the contents of this plugin',
  };
}

/**
 * Is a plugin part of what this profile enables?
 *
 * The names in a log are entry ids (`webserver`) while the profile lists package
 * names (`@deepseek-ai/dsh-host-webserver`); the package name's last segment is
 * therefore accepted as well, so a real entry is not dismissed as "unknown".
 *
 * @param {string[]|null} enabledPlugins
 * @param {string} plugin
 * @returns {boolean}
 */
export function isEnabledPlugin(enabledPlugins, plugin) {
  if (enabledPlugins === null || enabledPlugins === undefined) return true;
  if (!Array.isArray(enabledPlugins)) return true;
  if (enabledPlugins.length === 0) return true;
  const name = typeof plugin === 'string' ? plugin.trim() : '';
  if (name === '') return false;
  const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  for (const candidate of enabledPlugins) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value === '') continue;
    if (value === name) return true;
    if (value === short) return true;
    const candidateShort = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
    if (candidateShort === short) return true;
  }
  return false;
}

/**
 * Decide, per failed plugin, what should happen.
 *
 * NOTHING IS TOUCHED HERE. The plan only says what the restore would do; the
 * caller applies it (and the plan is what the tests drive).
 *
 * @param {{
 *   failures?: Array<object>,
 *   backupDir?: string|null,
 *   profileDir?: string,
 *   backupMeta?: object|null,
 *   enabledPlugins?: string[]|null,
 *   recovery?: object|null,
 *   attemptLimit?: number,
 *   fs?: object,
 * }} [options]
 * @returns {{
 *   backupDir: string|null,
 *   backupKind: string|null,
 *   restoredAt: number|null,
 *   actions: Array<object>,
 *   needsHuman: boolean,
 *   restorable: number,
 * }}
 */
export function planPluginRecovery({
  failures = [],
  backupDir = null,
  profileDir = '',
  backupMeta = null,
  enabledPlugins = null,
  recovery = null,
  attemptLimit = DEFAULT_ATTEMPT_LIMIT,
  fs = fsDefault,
} = {}) {
  const root = typeof backupDir === 'string' && backupDir.trim() !== '' ? backupDir.trim() : null;
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  // The identity of the backup: it is what the report says the plugin was
  // restored FROM ("restored to which point in time").
  const meta = backupMeta && typeof backupMeta === 'object'
    ? backupMeta
    : (root === null ? null : readBackupMeta(root));
  const backupKind = meta && typeof meta.kind === 'string' ? meta.kind : null;
  const restoredAt = meta && Number.isFinite(Number(meta.at)) ? Math.trunc(Number(meta.at)) : null;
  const state = recovery && typeof recovery === 'object' ? recovery : createRecoveryState();
  const actions = [];
  let needsHuman = false;
  let restorable = 0;

  for (const failure of Array.isArray(failures) ? failures : []) {
    if (!failure || typeof failure !== 'object') continue;
    const plugin = typeof failure.plugin === 'string' ? failure.plugin.trim() : '';
    if (plugin === '') continue;
    const fingerprint = typeof failure.fingerprint === 'string' && failure.fingerprint !== ''
      ? failure.fingerprint
      : failureFingerprint(failure);
    const base = {
      plugin,
      fingerprint,
      error: typeof failure.error === 'string' ? failure.error : '',
      failedAt: Number.isFinite(Number(failure.at)) ? Math.trunc(Number(failure.at)) : null,
      backupKind,
      restoredAt,
      restoredFrom: null,
      source: null,
      applied: false,
      changed: false,
      evidence: null,
      needsHuman: false,
      reason: '',
      mode: RECOVERY_MODES.NO_BACKUP,
    };

    // (1) THE SAME FAILURE, ALREADY HANDLED: the loop guard of the log line.
    if (handledRecord(state, fingerprint) !== null) {
      actions.push({
        ...base,
        mode: RECOVERY_MODES.DUPLICATE,
        reason: 'this exact failure was already handled in an earlier cycle: it is not a new incident, '
          + 'so nothing is restored and no restart is asked for',
      });
      continue;
    }

    // (2) THIS PLUGIN ALREADY USED ITS ONE ATTEMPT: report, never act.
    const decision = decideAttempt(state, plugin, { limit: attemptLimit });
    if (decision.allowed !== true) {
      needsHuman = true;
      actions.push({
        ...base,
        mode: RECOVERY_MODES.NEEDS_HUMAN,
        needsHuman: true,
        reason: decision.reason,
      });
      continue;
    }

    // (3) A PLUGIN THIS PROFILE DOES NOT ENABLE is not ours to write into.
    if (isEnabledPlugin(enabledPlugins, plugin) !== true) {
      actions.push({
        ...base,
        mode: RECOVERY_MODES.NO_BACKUP,
        reason: 'the plugin is not in the enabled plugin list of this profile: it is left exactly as it is',
      });
      continue;
    }

    // (4) NO BACKUP AT ALL: nothing to restore from.
    if (root === null) {
      actions.push({
        ...base,
        mode: RECOVERY_MODES.NO_BACKUP,
        reason: 'no copy on this machine has a restart record saying it came up with matching content, so there is nothing to restore from',
      });
      continue;
    }

    // (5) WHERE THE COPY IS (real copy, link contents, or nowhere).
    // A slim backup deliberately holds no node_modules. Ask the BACKUP which kind
  // it is instead of assuming: old full backups must keep working.
  const slim = !fs.existsSync(path.join(root, PLUGINS_DIR));
  const located = locateBackupCopy({ backupDir: root, plugin, fs, slim });
    if (located.source === null) {
      actions.push({ ...base, mode: RECOVERY_MODES.NO_BACKUP, reason: located.reason });
      continue;
    }

    restorable += 1;
    actions.push({
      ...base,
      mode: located.mode,
      // Where the copy comes from, and the identity of the backup it belongs to.
      source: located.source,
      restoredFrom: located.source,
      reason: located.reason,
    });
  }

  // A plan is only "human needed" when a plugin really ran out of attempts; a
  // duplicate or a missing backup is a normal outcome.
  return {
    backupDir: root,
    backupKind,
    restoredAt,
    actions,
    needsHuman,
    restorable,
  };
}

// ---------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------

/**
 * Copy a directory tree. The default is the platform's own recursive copy.
 *
 * @param {string} source
 * @param {string} destination
 * @param {{ fs?: object }} [options]
 * @returns {{ ok: boolean, error: string|null }}
 */
export function copyTree(source, destination, { fs = fsDefault } = {}) {
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Apply a plan: move the live directory aside (EVIDENCE, never a delete) and let
 * the backup copy take its place.
 *
 * The plan is NOT mutated: the returned actions are the record of what happened,
 * which is what the report and the tests read.
 *
 * @param {{
 *   plan: object,
 *   profileDir?: string,
 *   now?: number,
 *   fs?: object,
 *   copy?: Function|null,
 *   compare?: boolean,
 * }} [options]
 * @returns {{ changed: boolean, actions: Array<object>, needsHuman: boolean, restorable: number }}
 */
export function applyPluginRecovery({
  plan = null,
  profileDir = '',
  now = Date.now(),
  fs = fsDefault,
  copy = null,
  compare = true,
} = {}) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const actions = Array.isArray(source.actions) ? source.actions : [];
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const copyFn = typeof copy === 'function' ? copy : ((from, to) => copyTree(from, to, { fs }));
  const out = [];
  let changed = false;
  let needsHuman = source.needsHuman === true;

  for (const action of actions) {
    const record = { ...action, applied: false, changed: false, evidence: null };
    if (action.needsHuman === true) needsHuman = true;
    // Only the two restore modes touch the disk; everything else is a decision
    // that says "nothing happens" and is reported as it is.
    if (!RESTORE_MODES.includes(action.mode) || typeof action.source !== 'string') {
      out.push(record);
      continue;
    }
    if (profile === '') {
      out.push({ ...record, mode: RECOVERY_MODES.NO_BACKUP, reason: 'no profile directory was resolved, so nothing could be restored' });
      continue;
    }
    const livePath = path.join(profile, PLUGINS_DIR, action.plugin);
    // IDEMPOTENCY: an already restored plugin is not copied again, and — the
    // point of the whole check — no restart is asked for it.
    if (compare !== false) {
      const comparison = sameAsBackup(livePath, action.source, { fs });
      if (comparison.same === true) {
        out.push({
          ...record,
          mode: RECOVERY_MODES.ALREADY_CONSISTENT,
          reason: comparison.reason,
        });
        continue;
      }
      record.reason = comparison.reason;
    }
    let evidence = null;
    let livePresent = false;
    try {
      fs.lstatSync(livePath);
      livePresent = true;
    } catch {
      livePresent = false;
    }
    if (livePresent) {
      const brokenPath = path.join(profile, PLUGINS_DIR, brokenNameFor(action.plugin, now));
      try {
        // THE EVIDENCE. The broken tree is renamed, never deleted: a user (or a
        // colleague) must be able to look at what was really there.
        fs.renameSync(livePath, brokenPath);
        evidence = { renamedFrom: livePath, renamedTo: brokenPath };
      } catch (error) {
        out.push({
          ...record,
          applied: false,
          error: error && error.message ? error.message : String(error),
          reason: 'the live directory could not be moved aside, so it was left alone (nothing was deleted)',
        });
        continue;
      }
    }
    const copied = copyFn(action.source, livePath);
    if (copied && copied.ok === false) {
      out.push({
        ...record,
        applied: false,
        evidence,
        error: copied.error || 'the copy failed',
        reason: 'the backup copy could not be written: the live directory was left as it was',
      });
      continue;
    }
    changed = true;
    out.push({
      ...record,
      applied: true,
      changed: true,
      evidence,
      restoredFrom: action.source,
      reason: 'the backup copy now takes the place of the failed plugin',
    });
  }

  return { changed, actions: out, needsHuman, restorable: Number(source.restorable) || 0 };
}

// ---------------------------------------------------------------------------
// The report (`<stateDir>/last-plugin-recovery.json`)
// ---------------------------------------------------------------------------

/**
 * Build the readable report of one recovery pass.
 *
 * The shape is the contract with the interface: `at` / `atIso` (when), `failures`
 * (what the log said), `actions` (what was done, with `restoredAt` / `backupKind`
 * from the BACKUP'S OWN meta), `restartRequested` (whether a restart was asked
 * for) and `needsHuman` (whether somebody has to look).
 *
 * @param {{
 *   at?: number,
 *   atIso?: string|null,
 *   log?: string|null,
 *   failures?: Array<object>,
 *   actions?: Array<object>,
 *   restartRequested?: boolean,
 *   needsHuman?: boolean,
 *   backupDir?: string|null,
 *   backupKind?: string|null,
 *   restoredAt?: number|null,
 * }} [options]
 * @returns {object}
 */
export function buildRecoveryReport({
  at = Date.now(),
  atIso = null,
  log = null,
  failures = [],
  actions = [],
  restartRequested = false,
  needsHuman = false,
  backupDir = null,
  backupKind = null,
  restoredAt = null,
} = {}) {
  const when = Number.isFinite(Number(at)) ? Math.trunc(Number(at)) : Date.now();
  const failureList = (Array.isArray(failures) ? failures : []).map((failure) => ({
    plugin: typeof failure.plugin === 'string' ? failure.plugin : null,
    error: typeof failure.error === 'string' ? failure.error : '',
    at: Number.isFinite(Number(failure.at)) ? Math.trunc(Number(failure.at)) : null,
    kind: typeof failure.kind === 'string' ? failure.kind : null,
    fingerprint: typeof failure.fingerprint === 'string' ? failure.fingerprint : null,
  }));
  const actionList = (Array.isArray(actions) ? actions : []).map((action) => ({
    plugin: typeof action.plugin === 'string' ? action.plugin : '',
    mode: typeof action.mode === 'string' ? action.mode : RECOVERY_MODES.NO_BACKUP,
    restoredFrom: typeof action.restoredFrom === 'string' ? action.restoredFrom : null,
    restoredAt: Number.isFinite(Number(action.restoredAt)) ? Math.trunc(Number(action.restoredAt)) : restoredAt,
    backupKind: typeof action.backupKind === 'string' ? action.backupKind : backupKind,
    evidence: action.evidence && typeof action.evidence === 'object'
      ? {
        renamedFrom: typeof action.evidence.renamedFrom === 'string' ? action.evidence.renamedFrom : null,
        renamedTo: typeof action.evidence.renamedTo === 'string' ? action.evidence.renamedTo : null,
      }
      : null,
    applied: action.applied === true,
    changed: action.changed === true,
    needsHuman: action.needsHuman === true,
    reason: typeof action.reason === 'string' ? action.reason : '',
  }));
  return {
    at: when,
    atIso: typeof atIso === 'string' && atIso !== '' ? atIso : new Date(when).toISOString(),
    log: typeof log === 'string' && log !== '' ? log : null,
    backupDir: typeof backupDir === 'string' && backupDir !== '' ? backupDir : null,
    backupKind: typeof backupKind === 'string' ? backupKind : null,
    restoredAt: Number.isFinite(Number(restoredAt)) ? Math.trunc(Number(restoredAt)) : null,
    failures: failureList,
    actions: actionList,
    restartRequested: restartRequested === true,
    needsHuman: needsHuman === true,
    changed: actionList.some((action) => action.changed === true),
  };
}

/**
 * Write the report. Never throws: a report that cannot be written must not take
 * the boot down (the log line is the caller's job).
 *
 * @param {string} stateDir
 * @param {object} report
 * @param {{ fs?: object }} [options]
 * @returns {boolean} whether it was written
 */
export function writeRecoveryReport(stateDir, report, { fs = fsDefault } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '' || !report || typeof report !== 'object') return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECOVERY_REPORT_NAME), JSON.stringify(report, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the report of the last recovery (null when there is none).
 *
 * @param {string} stateDir
 * @param {{ fs?: object }} [options]
 * @returns {object|null}
 */
export function readRecoveryReport(stateDir, { fs = fsDefault } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    const text = fs.readFileSync(path.join(dir, RECOVERY_REPORT_NAME), 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The report, cut down to what a health answer carries.
 *
 * The health route is polled every couple of seconds, so the answer stays small:
 * the plugin names, the mode of each action and the two timestamps that answer
 * "what broke" and "restored to when".
 *
 * @param {object|null} report
 * @returns {object|null}
 */
export function summarizeRecoveryReport(report) {
  if (!report || typeof report !== 'object') return null;
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const actions = Array.isArray(report.actions) ? report.actions : [];
  return {
    at: Number.isFinite(Number(report.at)) ? Math.trunc(Number(report.at)) : null,
    atIso: typeof report.atIso === 'string' ? report.atIso : null,
    backupKind: typeof report.backupKind === 'string' ? report.backupKind : null,
    restoredAt: Number.isFinite(Number(report.restoredAt)) ? Math.trunc(Number(report.restoredAt)) : null,
    restartRequested: report.restartRequested === true,
    needsHuman: report.needsHuman === true,
    failures: failures.slice(0, 10).map((failure) => ({
      plugin: typeof failure.plugin === 'string' ? failure.plugin : null,
      error: typeof failure.error === 'string' ? failure.error : '',
    })),
    actions: actions.slice(0, 10).map((action) => ({
      plugin: typeof action.plugin === 'string' ? action.plugin : '',
      mode: typeof action.mode === 'string' ? action.mode : RECOVERY_MODES.NO_BACKUP,
      restoredAt: Number.isFinite(Number(action.restoredAt)) ? Math.trunc(Number(action.restoredAt)) : null,
      backupKind: typeof action.backupKind === 'string' ? action.backupKind : null,
      evidence: action.evidence && typeof action.evidence === 'object' && typeof action.evidence.renamedTo === 'string'
        ? { renamedTo: action.evidence.renamedTo }
        : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// AT BOOT: LOOK ONLY (user decision, 2026-11-01 — "只提示，不改文件")
// ---------------------------------------------------------------------------

/**
 * Read the previous boot's log, recognise the failed plugins and WRITE THE
 * REPORT. Nothing else.
 *
 * WHY THIS REPLACED THE AUTOMATIC RECOVERY: a plugin that fails to import never
 * stops the host from coming up — measured on the desktop (22 s) and on the
 * hosted `dsh web` instance (2.0–2.6 s), with the profile's `package.json`
 * byte-identical and no repeated restarts under `supervise-web.sh`. The host
 * already isolates a broken entry, so an automatic restore only added a second
 * writer into the profile at boot and an automatic restart on top of it.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE (both are asserted by the tests):
 *
 *   - it never calls {@link applyPluginRecovery} (no file inside the profile is
 *     touched, no `<plugin>.broken-<ts>` evidence is created);
 *   - it never calls `requestRestart` (a boot never asks for another boot).
 *
 * The only file it writes is the plugin's OWN report under `stateDir`
 * (`last-plugin-recovery.json`), which is what the health route and the popup
 * read.
 *
 * The two pure functions {@link planPluginRecovery} and
 * {@link applyPluginRecovery} stay public: {@link restoreOnePlugin} uses them
 * when the USER asks for one plugin to be put back.
 *
 * @param {{
 *   stateDir?: string,
 *   backupsDir?: string,
 *   logsDir?: string,
 *   bootAt?: number,
 *   now?: number,
 *   fs?: object,
 *   logPath?: string|null,
 *   write?: boolean,
 * }} [options]
 * @returns {object} the outcome (never null; `ran:false` carries a `reason`)
 */
export function detectPluginRecovery({
  stateDir = '',
  backupsDir = '',
  logsDir = '',
  bootAt = Date.now(),
  now = Date.now(),
  fs = fsDefault,
  logPath = null,
  write = true,
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  const at = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();
  const boot = Number.isFinite(Number(bootAt)) ? Math.trunc(Number(bootAt)) : at;
  const empty = {
    ran: false,
    found: false,
    changed: false,
    restartRequested: false,
    needsHuman: false,
    report: null,
    log: null,
    failures: [],
    backupDir: null,
    backupKind: null,
    restoredAt: null,
  };
  if (dir === '') return { ...empty, reason: 'no state directory was resolved' };

  // (1) WHICH LOG: the PREVIOUS boot's own log (never this one — its audit
  // verdict does not exist yet).
  const log = typeof logPath === 'string' && logPath !== ''
    ? { name: path.basename(logPath), path: logPath, at: null, mtime: 0, size: 0 }
    : findLatestStartupLog(logsDir, { before: boot, fs });
  if (log === null) {
    return { ...empty, reason: 'no finished boot log was found, so there is nothing to judge' };
  }
  let text = ''
  try {
    text = String(fs.readFileSync(log.path, 'utf8'));
  } catch (error) {
    return {
      ...empty,
      log: log.path,
      reason: 'the startup log could not be read: ' + (error && error.message ? error.message : String(error)),
    };
  }

  // (2) DETECT.
  const sinceMs = Number.isFinite(Number(log.at)) ? Number(log.at) : null;
  const failures = findPluginFailures(text, {
    sinceMs,
    logAt: Number.isFinite(Number(log.mtime)) && log.mtime > 0 ? Math.trunc(log.mtime) : null,
    now: at,
  });
  const named = mergeFailuresByPlugin(failures);
  if (named.length === 0) {
    return {
      ...empty,
      ran: true,
      log: log.path,
      reason: 'the previous boot reported no plugin failure',
    };
  }

  // (3) WHICH BACKUP THE USER COULD RESTORE FROM. Two cheap `lstat`s per plugin
  // less than a `sameAsBackup` digest, so the boot pays next to nothing for
  // saying "a backup exists / does not exist" in the popup.
  const knownGood = typeof backupsDir === 'string' && backupsDir.trim() !== ''
    ? latestKnownGood(backupsDir.trim())
    : null;
  const backupDir = knownGood && typeof knownGood.dir === 'string' ? knownGood.dir : null;
  const meta = backupDir === null ? null : readBackupMeta(backupDir);
  const backupKind = meta && typeof meta.kind === 'string' ? meta.kind : null;
  const restoredAt = meta && Number.isFinite(Number(meta.at)) ? Math.trunc(Number(meta.at)) : null;

  // (4) THE REPORT. `actions` stays EMPTY: nothing was done, and saying
  // "overwrite" here would claim a restore that never happened.
  const report = buildRecoveryReport({
    at,
    log: log.path,
    failures: named,
    actions: [],
    restartRequested: false,
    needsHuman: false,
    backupDir,
    backupKind,
    restoredAt,
  });
  if (write === true) writeRecoveryReport(dir, report, { fs });

  return {
    ran: true,
    found: true,
    changed: false,
    restartRequested: false,
    needsHuman: false,
    report,
    log: log.path,
    failures: named,
    backupDir,
    backupKind,
    restoredAt,
    reason: 'the previous boot reported a plugin failure: it is reported, nothing was changed',
  };
}

// ---------------------------------------------------------------------------
// ON DEMAND: restore exactly ONE plugin (the popup's own button)
// ---------------------------------------------------------------------------

/** The record of the restores a human asked for. */
export const RESTORE_HISTORY_NAME = 'plugin-restore-history.json';

/** How many of them are kept (newest first). */
export const RESTORE_HISTORY_LIMIT = 20;

/** An empty history. */
export function createRestoreHistory() {
  return { version: 1, entries: [] };
}

/**
 * Read the restore history. Never throws: a corrupt file is an empty history of
 * its own, not a broken popup.
 *
 * @param {string} stateDir
 * @param {{ fs?: object }} [options]
 * @returns {{ version: number, entries: Array<object> }}
 */
export function readRestoreHistory(stateDir, { fs = fsDefault } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return createRestoreHistory();
  try {
    const text = fs.readFileSync(path.join(dir, RESTORE_HISTORY_NAME), 'utf8');
    const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    return { version: 1, entries: entries.filter((entry) => entry && typeof entry === 'object') };
  } catch {
    return createRestoreHistory();
  }
}

/**
 * Append one restore to the history, newest first, capped.
 *
 * @param {string} stateDir
 * @param {object} entry
 * @param {{ fs?: object, limit?: number }} [options]
 * @returns {{ ok: boolean, entries: Array<object>, error: string|null }}
 */
export function appendRestoreHistory(stateDir, entry, { fs = fsDefault, limit = RESTORE_HISTORY_LIMIT } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : RESTORE_HISTORY_LIMIT;
  if (dir === '') return { ok: false, entries: [], error: 'no state directory was resolved' };
  const history = readRestoreHistory(dir, { fs });
  const entries = [entry, ...history.entries].filter((item) => item && typeof item === 'object').slice(0, cap);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RESTORE_HISTORY_NAME), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    return { ok: true, entries, error: null };
  } catch (error) {
    return { ok: false, entries, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * The newest restore, cut down to what the health answer carries.
 *
 * @param {{ entries?: Array<object> }|Array<object>|null} history
 * @returns {object|null}
 */
export function summarizeRestoreHistory(history) {
  const entries = Array.isArray(history)
    ? history
    : (history && Array.isArray(history.entries) ? history.entries : []);
  const first = entries.find((entry) => entry && typeof entry === 'object');
  if (!first) return null;
  return {
    at: Number.isFinite(Number(first.at)) ? Math.trunc(Number(first.at)) : null,
    atIso: typeof first.atIso === 'string' ? first.atIso : null,
    plugin: typeof first.plugin === 'string' ? first.plugin : null,
    mode: typeof first.mode === 'string' ? first.mode : null,
    ok: first.ok === true,
    changed: first.changed === true,
    needsRestart: first.needsRestart === true,
    backupKind: typeof first.backupKind === 'string' ? first.backupKind : null,
    restoredAt: Number.isFinite(Number(first.restoredAt)) ? Math.trunc(Number(first.restoredAt)) : null,
    reason: typeof first.reason === 'string' ? first.reason : '',
  };
}

/**
 * PUT ONE PLUGIN BACK — the only path that still writes into the profile, and
 * only because a human pressed the button.
 *
 * The difference to the removed automatic pass is the WHO and the ONE:
 *
 *   - it restores the plugin it was ASKED for, never the list a log suggests;
 *   - it skips the loop guards of the automatic pass on purpose (`duplicate` /
 *     `needs-human` are about "should the machine act on its own"); a person
 *     asking again is not a loop, and the idempotency check still protects the
 *     disk: a plugin that already equals the backup answers
 *     `already-consistent`, writes nothing and asks for no restart;
 *   - it writes `<stateDir>/plugin-restore-history.json` (newest 20) so the
 *     user can see afterwards what was put back and from when.
 *
 * @param {{
 *   stateDir?: string,
 *   profileDir?: string,
 *   backupsDir?: string,
 *   plugin?: string,
 *   now?: number,
 *   fs?: object,
 *   copy?: Function|null,
 *   historyLimit?: number,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   plugin: string,
 *   mode: string|null,
 *   restoredFrom: string|null,
 *   restoredAt: number|null,
 *   backupKind: string|null,
 *   needsRestart: boolean,
 *   changed: boolean,
 *   evidence: object|null,
 *   at: number,
 *   atIso: string,
 *   reason: string,
 * }}
 */
export function restoreOnePlugin({
  stateDir = '',
  profileDir = '',
  backupsDir = '',
  plugin = '',
  now = Date.now(),
  fs = fsDefault,
  copy = null,
  historyLimit = RESTORE_HISTORY_LIMIT,
} = {}) {
  const at = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();
  const name = typeof plugin === 'string' ? plugin.trim() : '';
  const state = typeof stateDir === 'string' ? stateDir.trim() : '';
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const base = {
    ok: false,
    plugin: name,
    mode: null,
    restoredFrom: null,
    restoredAt: null,
    backupKind: null,
    needsRestart: false,
    changed: false,
    evidence: null,
    at,
    atIso: new Date(at).toISOString(),
    reason: '',
  };
  const finish = (outcome) => {
    const entry = { ...base, ...outcome };
    // The history is a convenience, never a reason to fail the restore.
    const written = appendRestoreHistory(state, entry, { fs, limit: historyLimit });
    return { ...entry, history: { ok: written.ok === true, count: written.entries.length, error: written.error } };
  };

  if (name === '') return finish({ reason: 'no plugin name was given', mode: RECOVERY_MODES.NO_BACKUP });
  if (profile === '') return finish({ reason: 'no profile directory was resolved', mode: RECOVERY_MODES.NO_BACKUP });

  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  const knownGood = root === '' ? null : latestKnownGood(root);
  if (knownGood === null || typeof knownGood.dir !== 'string') {
    return finish({
      mode: RECOVERY_MODES.NO_BACKUP,
      reason: 'no copy on this machine has a restart record saying it came up with matching content, so there is nothing to restore from',
    });
  }
  const meta = readBackupMeta(knownGood.dir);
  const backupKind = meta && typeof meta.kind === 'string' ? meta.kind : null;
  const restoredAt = meta && Number.isFinite(Number(meta.at)) ? Math.trunc(Number(meta.at)) : null;

  // Same detection as above: old full backups keep working.
  const slim = !fs.existsSync(path.join(knownGood.dir, PLUGINS_DIR));
  const located = locateBackupCopy({ backupDir: knownGood.dir, plugin: name, fs, slim });
  if (located.source === null) {
    return finish({
      mode: RECOVERY_MODES.NO_BACKUP,
      reason: located.reason,
      backupKind,
      restoredAt,
    });
  }

  // ONE action, built by hand: no `handled` fingerprint and no attempt budget,
  // so a person can ask twice. The idempotency check inside the applier is the
  // only thing that decides "nothing to do".
  const plan = {
    backupDir: knownGood.dir,
    backupKind,
    restoredAt,
    needsHuman: false,
    restorable: 1,
    actions: [{
      plugin: name,
      fingerprint: '',
      error: '',
      failedAt: null,
      backupKind,
      restoredAt,
      restoredFrom: located.source,
      source: located.source,
      mode: located.mode,
      applied: false,
      changed: false,
      evidence: null,
      needsHuman: false,
      reason: located.reason,
    }],
  };
  const applied = applyPluginRecovery({ plan, profileDir: profile, now: at, fs, copy });
  const action = Array.isArray(applied.actions) && applied.actions.length > 0 ? applied.actions[0] : null;
  if (action === null) {
    return finish({ mode: located.mode, backupKind, restoredAt, reason: 'the restore produced no action' });
  }
  if (action.mode === RECOVERY_MODES.ALREADY_CONSISTENT) {
    return finish({
      ok: true,
      plugin: name,
      mode: RECOVERY_MODES.ALREADY_CONSISTENT,
      restoredFrom: located.source,
      restoredAt,
      backupKind,
      needsRestart: false,
      changed: false,
      reason: action.reason,
    });
  }
  if (action.changed !== true) {
    // A failed copy or a directory that could not be moved aside.
    return finish({
      mode: action.mode,
      restoredFrom: located.source,
      restoredAt,
      backupKind,
      evidence: action.evidence && typeof action.evidence === 'object' ? action.evidence : null,
      reason: action.error
        ? 'the restore failed: ' + String(action.error)
        : (action.reason || 'nothing was changed'),
    });
  }
  return finish({
    ok: true,
    plugin: name,
    mode: action.mode,
    restoredFrom: action.restoredFrom === undefined ? located.source : action.restoredFrom,
    restoredAt,
    backupKind,
    needsRestart: true,
    changed: true,
    evidence: action.evidence && typeof action.evidence === 'object' ? action.evidence : null,
    reason: 'the backup copy now takes the place of the failed plugin: restart so the next boot loads it',
  });
}

/**
 * The default backup directory name of a state directory — re-exported so the
 * caller does not have to know the layout (`lib/backup.js` owns it).
 */
export { META_NAME, KIND_KNOWN_GOOD, LINKS_DIR, PLUGINS_DIR };
