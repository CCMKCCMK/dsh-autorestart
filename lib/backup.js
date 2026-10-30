/**
 * dsh-autorestart — pre-restart backups.
 *
 * A restart can leave the host unable to boot: the profile configuration is what
 * decides whether every installed bundle loads, and the host's own rescue path
 * rewrites exactly those files when a boot fails. So the restart helper keeps a
 * snapshot of the profile (its configuration files, and — when enabled — the
 * installed plugin tree) and can put it back when the host does not come up.
 *
 * Everything here is synchronous and bounded: a backup is taken right before the
 * detached restart is scheduled, and only the newest `maxBackups` snapshots are
 * kept (older ones are removed so the disk never grows without a limit).
 *
 * The restore path used by the detached helper lives in the generated PowerShell
 * watcher (lib/restart.js); `restoreBackup` here is the same operation for tests
 * and for a manual recovery from inside the host.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The profile files that decide whether the host can boot. */
export const CONFIG_FILES = Object.freeze(['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']);

/** The directory inside one backup that holds the configuration files. */
export const CONFIG_DIR = 'config';

/** The directory inside one backup that holds the installed plugin tree. */
export const PLUGINS_DIR = 'node_modules';

/**
 * The directory inside one backup that holds the CONTENTS of linked plugins.
 *
 * WHY A SEPARATE DIRECTORY (user decision, 2026-10-30). A plugin installed with
 * `link:` / a junction is not a copy: `node_modules/<name>` is a reparse point
 * pointing at a development directory. Copying it as part of the tree either
 * copies the LINK (and a restore would put back a link to a directory that may
 * be gone) or follows it into a tree that is not the profile's. The contents
 * are therefore kept apart, one directory per plugin, and the restore decides
 * per plugin whether the link can stay or the contents must take its place.
 */
export const LINKS_DIR = 'node_modules-link';

/** The two kinds of reparse point this module knows. */
export const LINK_KINDS = Object.freeze({
  SYMLINK: 'symbolic-link',
  JUNCTION: 'junction',
});

/**
 * The outcomes of the link decision. They are also what the restore script
 * prints, one line per plugin - nothing is ever skipped silently.
 */
export const LINK_ACTIONS = Object.freeze({
  KEPT: 'kept',
  REPLACED: 'replaced',
  TARGET_MISSING: 'target-missing',
  NO_BACKUP: 'no-backup',
});

/** The manifest written into every backup. */
export const MANIFEST_NAME = 'manifest.json';

/**
 * How many backups are kept by default.
 *
 * THREE (user decision, 2026-10-30: "the current one plus the two before it"),
 * so a rollback can step one restart further back than the newest copy. The
 * newest KNOWN-GOOD backup is never pruned whatever this number says — losing
 * it would leave the machine with nothing to roll back to.
 */
export const DEFAULT_MAX_BACKUPS = 3;

/**
 * THE IDENTITY OF A BACKUP (user decision, 2026-10-30).
 *
 * A pre-restart snapshot is taken BEFORE the restart: it holds exactly the state
 * that is about to be tested, i.e. possibly the state that breaks the boot. So a
 * restore may only ever use a backup that HAS BOOTED: the known-good one.
 *
 * Two identities:
 *   'snapshot'    taken before a restart, not proven yet;
 *   'known-good'  a restart with this content really came up — or the seed taken
 *                 on first install (nothing to prove yet, nothing to lose either).
 *
 * A directory without a readable meta.json is 'unknown': it was written before
 * this rule existed and is NEVER used for an automatic rollback.
 */
export const META_NAME = 'meta.json';
export const KIND_SNAPSHOT = 'snapshot';
export const KIND_KNOWN_GOOD = 'known-good';
export const KIND_UNKNOWN = 'unknown';

/**
 * Coerce anything into one of the three identities.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeKind(raw) {
  if (raw === KIND_KNOWN_GOOD) return KIND_KNOWN_GOOD;
  if (raw === KIND_SNAPSHOT) return KIND_SNAPSHOT;
  return KIND_UNKNOWN;
}

/**
 * Read the identity of one backup directory.
 *
 * A missing or unreadable meta.json is NOT an error: it means the backup was
 * written before the identity layer existed, and the answer is `'unknown'`.
 *
 * @param {string} backupDir
 * @returns {{ kind: string, at: number|null, version: string|null, bootId: string|null, requestId: number|null, reason: string|null, upgradedAt: number|null }}
 */
export function readBackupMeta(backupDir) {
  const empty = {
    kind: KIND_UNKNOWN,
    at: null,
    version: null,
    bootId: null,
    requestId: null,
    reason: null,
    upgradedAt: null,
  };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(String(backupDir ?? ''), META_NAME), 'utf8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  return {
    kind: normalizeKind(parsed.kind),
    at: Number.isFinite(parsed.at) ? parsed.at : null,
    version: typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null,
    bootId: typeof parsed.bootId === 'string' && parsed.bootId !== '' ? parsed.bootId : null,
    requestId: Number.isFinite(parsed.requestId) ? parsed.requestId : null,
    reason: typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : null,
    upgradedAt: Number.isFinite(parsed.upgradedAt) ? parsed.upgradedAt : null,
  };
}

/**
 * Write the identity of one backup directory.
 *
 * Best effort: a backup whose meta cannot be written stays a usable `'unknown'`
 * one (it is never used for an AUTOMATIC rollback, but it is still on disk).
 *
 * @param {string} backupDir
 * @param {object} [meta]
 * @returns {boolean} whether it was written
 */
export function writeBackupMeta(backupDir, meta = {}) {
  const record = {
    kind: normalizeKind(meta.kind),
    at: Number.isFinite(meta.at) ? meta.at : Date.now(),
    version: typeof meta.version === 'string' && meta.version !== '' ? meta.version : null,
    bootId: typeof meta.bootId === 'string' && meta.bootId !== '' ? meta.bootId : null,
    requestId: Number.isFinite(meta.requestId) ? meta.requestId : null,
    reason: typeof meta.reason === 'string' && meta.reason !== '' ? meta.reason : null,
    upgradedAt: Number.isFinite(meta.upgradedAt) ? meta.upgradedAt : null,
  };
  try {
    fs.writeFileSync(path.join(String(backupDir ?? ''), META_NAME), JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * PROMOTE a snapshot to known-good — the restart that used it really came up.
 *
 * The CONTENT does not change: "it booted" IS the proof, and it is written where
 * the next rollback looks for it.
 *
 * @param {string} backupDir
 * @param {{ reason?: string, version?: string|null, bootId?: string|null, now?: number }} [options]
 * @returns {boolean}
 */
export function markKnownGood(backupDir, { reason = 'boot-ok', version = null, bootId = null, now = Date.now() } = {}) {
  const current = readBackupMeta(backupDir);
  const manifest = readManifest(backupDir);
  // Nothing to promote: neither an identity nor a manifest to stand on.
  if (manifest === null && current.kind === KIND_UNKNOWN) return false;
  return writeBackupMeta(backupDir, {
    kind: KIND_KNOWN_GOOD,
    at: current.at !== null ? current.at : (manifest && Number.isFinite(manifest.at) ? manifest.at : now),
    version: version !== null && version !== undefined ? version : current.version,
    bootId: bootId !== null && bootId !== undefined ? bootId : current.bootId,
    requestId: current.requestId,
    reason: current.kind === KIND_KNOWN_GOOD ? (current.reason || reason) : reason,
    upgradedAt: now,
  });
}

/**
 * THE NEWEST BACKUP THAT HAS PROVEN IT CAN BOOT — the only valid target of an
 * automatic rollback.
 *
 * Backups without a meta.json (`'unknown'`) are skipped on purpose: they were
 * written before the identity layer and were never proven.
 *
 * @param {string} backupsDir the backups ROOT (the directory holding the copies)
 * @returns {object|null}
 */
export function latestKnownGood(backupsDir) {
  for (const entry of listBackupIdentities(backupsDir)) {
    if (entry.kind === KIND_KNOWN_GOOD) return entry;
  }
  return null;
}

/**
 * Every backup with its identity, newest first (what the settings page and the
 * health route show: identity, time, size, version).
 *
 * @param {string} backupsDir the backups ROOT
 * @returns {Array<object>}
 */
export function listBackupIdentities(backupsDir) {
  return listBackups(backupsDir).map((backup) => {
    const meta = readBackupMeta(backup.dir);
    return {
      ...backup,
      kind: meta.kind,
      version: meta.version,
      reason: meta.reason,
      requestId: meta.requestId,
      upgradedAt: meta.upgradedAt,
    };
  });
}

/** The report the detached helper writes when it rolls a backup back. */
export const ROLLBACK_REPORT_NAME = 'last-rollback.json';

/** The lock that makes sure a snapshot is restored ONCE. */
export const ROLLBACK_LOCK_NAME = 'rollback.lock';

/**
 * Claim the right to restore the snapshot.
 *
 * TWO parties can want to restore the snapshot at the same time: the plugin
 * itself (it saw that the restart failed) and the detached watcher (the host
 * never came back). Both copy the same files over the profile — two copies at
 * once would write the same files at the same time, and the plugin tree is
 * 117 MB.
 *
 * The claim is atomic: the file is CREATED, never opened, so exactly ONE
 * caller gets it. The loser stands down.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function claimRollbackLock(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return { ok: false, path: '', error: 'claimRollbackLock requires stateDir' };
  const file = path.join(dir, ROLLBACK_LOCK_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the directory may already be there */
  }
  // A lock that is older than 10 minutes belongs to a process that died in the
  // middle of its restore: it must not block the rollback for ever.
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    /* no lock there: nothing to clean up */
  }
  try {
    const handle = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(handle, String(process.pid ?? ''), 'utf8');
    } catch {
      /* the owner is what matters, not the note inside the file */
    }
    try {
      fs.closeSync(handle);
    } catch {
      /* nothing else to do */
    }
    return { ok: true, path: file, error: null };
  } catch {
    return { ok: false, path: file, error: 'another rollback is already running' };
  }
}

/**
 * Release the rollback lock.
 *
 * @param {string} stateDir
 * @returns {boolean} whether a lock was removed
 */
export function releaseRollbackLock(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, ROLLBACK_LOCK_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A filesystem-safe timestamp for a backup directory name.
 *
 * The name is in UTC on purpose: it sorts chronologically and it does not
 * depend on the timezone of the machine. The price is that it does NOT look
 * like the wall clock the operator reads (`2026-10-29T00-25-20-779Z` is
 * 08:25 in Shanghai) — so the manifest and the restart record carry the local
 * time as well, and a fresh snapshot can never be mistaken for an old one.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function backupStamp(now = Date.now()) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * The local time of an epoch, with the UTC offset (`2026-10-29T08:25:20+08:00`).
 *
 * @param {number|null|undefined} at
 * @returns {string|null}
 */
export function backupLocalTime(at) {
  const value = Number(at);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  const local = new Date(value + offsetMinutes * 60000).toISOString();
  return `${local.slice(0, 19)}${sign}${hours}:${minutes}`;
}

/**
 * The backups directory that belongs to a state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function backupsRoot(stateDir) {
  return path.join(String(stateDir ?? ''), 'backups');
}

/** Recursively measure a directory; never throws. */
function directorySize(target) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(child);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    try {
      bytes += fs.statSync(child).size;
      files += 1;
    } catch {
      // A file that vanished between readdir and stat is simply not counted.
    }
  }
  return { bytes, files };
}

/**
 * Copy one entry (file or directory) into a destination directory.
 *
 * @returns {boolean} whether anything was copied
 */
function copyEntry(source, destination) {
  try {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.cpSync(source, destination, { recursive: true, force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Measure a tree so the copy can report a REAL total (files and bytes).
 *
 * The plugin tree of a desktop profile is ~150 MB; walking it costs a few tens
 * of milliseconds and it is the only way to say "154 MB of 156 MB done" instead
 * of making a number up.
 *
 * @param {string} target
 * @returns {{ files: number, bytes: number }}
 */
export function measureTree(target) {
  return directorySize(target);
}

/**
 * The bundles a profile's package.json enables (`dsh.profile.bundles`).
 *
 * @param {string} packageJsonText
 * @returns {string[]}
 */
export function enabledBundlesOf(packageJsonText) {
  const text = typeof packageJsonText === 'string'
    ? (packageJsonText.charCodeAt(0) === 0xfeff ? packageJsonText.slice(1) : packageJsonText)
    : '';
  if (text.trim() === '') return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const profile = parsed && typeof parsed === 'object' ? parsed.dsh : null;
  const container = profile && typeof profile === 'object' ? profile.profile : null;
  const raw = container && typeof container === 'object' ? container.bundles : null;
  const bundles = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim() !== '') bundles.push(entry.trim());
    }
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    bundles.push(raw.trim());
  }
  return bundles;
}

/**
 * The LINKED plugins of a profile: `node_modules` entries that are symbol
 * links / junctions pointing at a directory.
 *
 * WHY THIS EXISTS (user decision, 2026-10-30). Five plugins on this machine are
 * installed with `link:` - including dsh-autorestart itself. A backup that
 * copies `node_modules` as a tree records the LINKS and none of their contents,
 * so the plugin that does the rescuing could not be put back: a real gap, found
 * by measurement (118 real copies in the backup, 5 links, 0 linked plugins).
 *
 * Only bundles the profile ENABLES are collected: a link that is switched off is
 * not something a restore has to bring back.
 *
 * Every filesystem call is injected, so this is testable without a real profile.
 *
 * @param {{
 *   profileDir?: string,
 *   bundles?: string[]|null,
 *   lstatFn?: Function,
 *   readlinkFn?: Function,
 *   readFileFn?: Function,
 *   existsFn?: Function,
 *   readdirFn?: Function,
 *   measureFn?: Function,
 *   platform?: string,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   links: Array<{ name: string, target: string, kind: string, exists: boolean, readable: boolean, files: number, bytes: number }>,
 *   enabled: string[],
 *   error: string|null,
 * }}
 */
export function collectLinkedPlugins(options = {}) {
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir : '';
  const lstat = typeof options.lstatFn === 'function' ? options.lstatFn : (target) => fs.lstatSync(target);
  const readlink = typeof options.readlinkFn === 'function' ? options.readlinkFn : (target) => fs.readlinkSync(target);
  const readFile = typeof options.readFileFn === 'function' ? options.readFileFn : (target) => fs.readFileSync(target, 'utf8');
  const exists = typeof options.existsFn === 'function' ? options.existsFn : (target) => fs.existsSync(target);
  const readdir = typeof options.readdirFn === 'function'
    ? options.readdirFn
    : (target) => fs.readdirSync(target, { withFileTypes: true });
  const measure = typeof options.measureFn === 'function' ? options.measureFn : measureTree;
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;

  if (profileDir === '') {
    return { ok: false, links: [], enabled: [], error: 'collectLinkedPlugins requires profileDir' };
  }
  const pluginsDir = path.join(profileDir, PLUGINS_DIR);
  if (exists(pluginsDir) !== true) {
    return { ok: true, links: [], enabled: [], error: null };
  }
  // Which bundles the profile answers "yes" to. `null` means "no filter", which
  // the caller uses when the package.json itself is unreadable: a restore then
  // still knows about the links instead of silently dropping them.
  const enabled = Array.isArray(options.bundles)
    ? options.bundles.map(String)
    : (() => {
      try {
        return enabledBundlesOf(readFile(path.join(profileDir, 'package.json')));
      } catch {
        return null;
      }
    })();

  const links = [];
  let entries = [];
  try {
    entries = readdir(pluginsDir);
  } catch (error) {
    return {
      ok: false,
      links: [],
      enabled: enabled === null ? [] : enabled,
      error: 'the plugin directory cannot be read: ' + (error && error.message ? error.message : String(error)),
    };
  }
  for (const entry of entries) {
    const name = entry && typeof entry.name === 'string' ? entry.name : String(entry);
    if (name === '' || name.startsWith('.')) continue;
    if (enabled !== null && enabled.includes(name) !== true) continue;
    const full = path.join(pluginsDir, name);
    let info = null;
    try {
      info = lstat(full);
    } catch {
      continue;
    }
    if (!info || typeof info.isSymbolicLink !== 'function' || info.isSymbolicLink() !== true) continue;
    let raw = '';
    try {
      raw = String(readlink(full));
    } catch {
      raw = '';
    }
    // A Windows junction always reports an ABSOLUTE target; a symbol link keeps
    // whatever it was created with (this machine's five links are relative).
    // Node exposes no reparse tag, so this is the best distinction available -
    // and it only ever shows up as a label in the manifest.
    const kind = platform === 'win32' && path.isAbsolute(raw) ? LINK_KINDS.JUNCTION : LINK_KINDS.SYMLINK;
    const target = raw === ''
      ? ''
      : (path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(pluginsDir, raw));
    const targetExists = target !== '' && exists(target) === true;
    let readable = false;
    let files = 0;
    let bytes = 0;
    if (targetExists) {
      try {
        const measured = measure(target);
        files = Math.max(0, Number(measured && measured.files) || 0);
        bytes = Math.max(0, Number(measured && measured.bytes) || 0);
        readable = true;
      } catch {
        readable = false;
      }
    }
    links.push({ name, target, kind, exists: targetExists, readable, files, bytes });
  }
  links.sort((left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)));
  return { ok: true, links, enabled: enabled === null ? [] : enabled, error: null };
}

/**
 * MAY THE LINK STAY, OR MUST THE BACKUP CONTENT TAKE ITS PLACE?
 *
 * The same decision is used by the restore script and by the watchdog, so a
 * manual restore and an automatic one cannot disagree:
 *
 *   - the link target is there and readable  -> KEPT (the development directory
 *     keeps working, which is the whole point of a `link:` installation);
 *   - the target is gone / unreadable        -> REPLACED (a host cannot start
 *     from a plugin that is not there);
 *   - forced, or a second attempt            -> REPLACED (the first attempt is
 *     the link's chance; a plugin that already failed once is not given a
 *     third);
 *   - there is no backup content for it      -> TARGET_MISSING / NO_BACKUP and
 *     the link is left exactly as it is (we never delete what we cannot replace).
 *
 * @param {{
 *   targetExists?: boolean, targetReadable?: boolean, hasBackup?: boolean,
 *   force?: boolean, attempts?: number,
 * }} [options]
 * @returns {{ action: string, replace: boolean, reason: string }}
 */
export function decideLinkRestore(options = {}) {
  const targetExists = options.targetExists === true;
  const targetReadable = options.targetReadable !== false && targetExists === true;
  const hasBackup = options.hasBackup === true;
  const forced = options.force === true;
  const attempts = Number.isFinite(Number(options.attempts)) ? Math.trunc(Number(options.attempts)) : 1;

  if (!targetExists && !hasBackup) {
    return {
      action: LINK_ACTIONS.TARGET_MISSING,
      replace: false,
      reason: 'the link target is gone and the backup holds no content for this plugin',
    };
  }
  if (!hasBackup) {
    return {
      action: LINK_ACTIONS.NO_BACKUP,
      replace: false,
      reason: 'the backup holds no content for this plugin, so the link is left untouched',
    };
  }
  if (forced) {
    return { action: LINK_ACTIONS.REPLACED, replace: true, reason: 'forced: the backup content replaces the link' };
  }
  if (!targetExists) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'the link target is gone: the backup content takes its place',
    };
  }
  if (!targetReadable) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'the link target cannot be read: the backup content takes its place',
    };
  }
  if (attempts >= 2) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'attempt ' + attempts + ': the link was given its chance and the host still did not come up',
    };
  }
  return { action: LINK_ACTIONS.KEPT, replace: false, reason: 'the link target is there and readable: the link stays' };
}

/**
 * Copy a directory tree FILE BY FILE, reporting real progress and honouring a
 * cancel request.
 *
 * `fs.cpSync` (what this used to be) copies 150 MB in one call: no progress, no
 * cancel, and no way to tell a busy disk from a dead host. The loop below copies
 * one file at a time, adds up the bytes that really landed and asks the caller
 * between files whether it should stop.
 *
 * IT YIELDS TO THE EVENT LOOP on purpose: the copy runs inside the host
 * process, and a copy that never yields blocks the very route the "cancel"
 * button posts to — the user could not call it off even though the code says
 * they can. Every `yieldEveryFiles` files (and every `yieldEveryMs`
 * milliseconds) the loop waits one tick, so the server stays answerable and the
 * progress reaches the interface while the copy is running.
 *
 * @param {{
 *   source: string,
 *   destination: string,
 *   onProgress?: Function|null,
 *   shouldCancel?: Function|null,
 *   progressEveryFiles?: number,
 *   yieldEveryFiles?: number,
 *   yieldEveryMs?: number,
 *   yieldToEventLoop?: Function|null,
 *   now?: Function,
 * }} options
 * @returns {Promise<{ ok: boolean, files: number, bytes: number, cancelled: boolean, error: string|null }>}
 */
export async function copyTreeWithProgress({
  source,
  destination,
  onProgress = null,
  shouldCancel = null,
  progressEveryFiles = 25,
  yieldEveryFiles = 40,
  yieldEveryMs = 120,
  yieldToEventLoop = null,
  now = Date.now,
} = {}) {
  const from = typeof source === 'string' ? source : '';
  const into = typeof destination === 'string' ? destination : '';
  if (from === '' || into === '') {
    return { ok: false, files: 0, bytes: 0, cancelled: false, error: 'copyTreeWithProgress requires a source and a destination' };
  }
  const pause = typeof yieldToEventLoop === 'function'
    ? yieldToEventLoop
    : () => new Promise((resolve) => { setImmediate(resolve); });
  const clock = typeof now === 'function' ? now : Date.now;
  let files = 0;
  let bytes = 0;
  let cancelled = false;
  let error = null;
  const tick = { files: 0, at: clock(), yielded: clock() };
  const report = () => {
    if (typeof onProgress !== 'function') return;
    tick.at = clock();
    try {
      onProgress({ files, bytes });
    } catch {
      // A broken progress callback must never fail the backup itself.
    }
  };

  const walk = async (sourceDir, targetDir) => {
    let entries;
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (failure) {
      // A directory that cannot be read is skipped, exactly like before: a
      // single unreadable plugin directory must not break the whole snapshot.
      error = error === null ? (failure && failure.message ? failure.message : String(failure)) : error;
      return;
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      /* it may already exist */
    }
    for (const entry of entries) {
      if (typeof shouldCancel === 'function' && shouldCancel() === true) {
        cancelled = true;
        return;
      }
      const childSource = path.join(sourceDir, entry.name);
      const childTarget = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await walk(childSource, childTarget);
        if (cancelled) return;
        continue;
      }
      try {
        fs.copyFileSync(childSource, childTarget);
        files += 1;
        try {
          bytes += fs.statSync(childTarget).size;
        } catch {
          /* the size is advisory */
        }
      } catch (failure) {
        error = error === null ? (failure && failure.message ? failure.message : String(failure)) : error;
        continue;
      }
      tick.files += 1;
      const moment = clock();
      if (tick.files >= progressEveryFiles || moment - tick.at >= 150) {
        tick.files = 0;
        report();
      }
      if (moment - tick.yielded >= yieldEveryMs || tick.files >= yieldEveryFiles) {
        tick.yielded = moment;
        // eslint-disable-next-line no-await-in-loop
        await pause();
        if (typeof shouldCancel === 'function' && shouldCancel() === true) {
          cancelled = true;
          return;
        }
      }
    }
  };

  await walk(from, into);
  report();
  if (cancelled) return { ok: false, files, bytes, cancelled: true, error: null };
  return { ok: true, files, bytes, cancelled: false, error };
}

/**
 * Remove a half-written backup (a cancelled copy must not look like a snapshot).
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function removeBackupDir(dir) {
  const target = typeof dir === 'string' ? dir.trim() : '';
  if (target === '') return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the newest `maxBackups` backup directories.
 *
 * THE NEWEST KNOWN-GOOD BACKUP IS NEVER REMOVED (user decision, 2026-10-30): it
 * is the only copy a failed boot may be rolled back to, so the "oldest first"
 * order steps around it — even when it is the very last one left.
 *
 * @param {string} backupsDir
 * @param {number} [maxBackups]
 * @returns {string[]} the names that were removed
 */
export function pruneBackups(backupsDir, maxBackups = DEFAULT_MAX_BACKUPS) {
  const limit = Number.isFinite(Number(maxBackups)) && Number(maxBackups) >= 1
    ? Math.trunc(Number(maxBackups))
    : DEFAULT_MAX_BACKUPS;
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  // THE NEWEST KNOWN-GOOD IS NEVER REMOVED: it is the only thing a failed boot
  // can roll back to, so "the oldest first" has to step around it.
  const protectedName = (() => {
    for (const name of names.slice().reverse()) {
      const meta = readBackupMeta(path.join(backupsDir, name));
      if (meta.kind === KIND_KNOWN_GOOD) return name;
    }
    return null;
  })();
  const victims = [];
  const budget = Math.max(0, names.length - limit);
  for (const name of names) {
    if (victims.length >= budget) break;
    if (name === protectedName) continue;
    victims.push(name);
  }
  const removed = [];
  for (const name of victims) {
    const target = path.join(backupsDir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A backup that cannot be removed must not fail the restart.
    }
  }
  return removed;
}

/**
 * List the backups, newest first.
 *
 * Only the DIRECTORY is read: the name, the manifest and nothing else. The
 * backup tree can be 150 MB per copy, so its contents are never walked — the
 * manifest already carries the size, the file count and the local time.
 *
 * @param {string} backupsDir
 * @returns {Array<{name: string, dir: string, at: number|null, atLocal: string|null, bytes: number|null, files: number|null, includePlugins: boolean}>}
 */
export function listBackups(backupsDir) {
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    const dir = path.join(backupsDir, name);
    const manifest = readManifest(dir);
    const at = manifest && Number.isFinite(manifest.at) ? manifest.at : null;
    out.push({
      name,
      dir,
      at,
      // The local time of the snapshot. The directory name is UTC on purpose,
      // so a fresh snapshot must never look like an old one.
      atLocal: manifest && typeof manifest.atLocal === 'string' && manifest.atLocal !== ''
        ? manifest.atLocal
        : (at === null ? null : backupLocalTime(at)),
      bytes: manifest && Number.isFinite(manifest.bytes) ? manifest.bytes : null,
      files: manifest && Array.isArray(manifest.files) ? manifest.files.length : null,
      includePlugins: Boolean(manifest && manifest.includePlugins === true),
    });
  }
  return out;
}

/**
 * Read one backup manifest.
 *
 * @param {string} backupDir
 * @returns {object|null}
 */
export function readManifest(backupDir) {
  try {
    const text = fs.readFileSync(path.join(String(backupDir ?? ''), MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take one backup of the profile.
 *
 * `includePlugins` copies the whole installed plugin tree, which is what makes a
 * rollback of "a plugin upgrade broke the boot" actually possible; without it only
 * the configuration files are copied.
 *
 * THE COPY IS INTERRUPTIBLE AND MEASURED: `onProgress` is called with the files
 * and bytes that really landed (plus the measured total), and `shouldCancel` is
 * asked between files. A cancelled copy removes its own half-written snapshot,
 * so a cancel never leaves something that looks like a usable backup.
 *
 * Never throws: a backup that cannot be written is reported as `{ ok: false }` so
 * the caller can decide whether the restart may still proceed.
 *
 * @param {{
 *   profileDir: string,
 *   backupsDir: string,
 *   includePlugins?: boolean,
 *   maxBackups?: number,
 *   now?: number,
 *   kind?: string,
 *   reason?: string|null,
 *   version?: string|null,
 *   bootId?: string|null,
 *   requestId?: number|null,
 *   onProgress?: ((progress: { files: number, bytes: number, total: number, filesTotal: number }) => void)|null,
 *   shouldCancel?: (() => boolean)|null,
 *   measure?: ((profileDir: string, includePlugins: boolean) => { files: number, bytes: number })|null,
 * }} options
 * @returns {{ ok: boolean, cancelled: boolean, dir: string|null, stamp: string|null, at: number|null, atLocal: string|null, kind: string, durationMs: number, bytes: number, totalBytes: number, fileCount: number, files: string[], includePlugins: boolean, pruned: string[], error: string|null }}
 */
export async function createBackup({
  profileDir,
  backupsDir,
  includePlugins = true,
  maxBackups = DEFAULT_MAX_BACKUPS,
  now = Date.now(),
  kind = KIND_SNAPSHOT,
  reason = null,
  version = null,
  bootId = null,
  requestId = null,
  onProgress = null,
  shouldCancel = null,
  measure = null,
  linkProgress = null,
} = {}) {
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  // A snapshot taken before a restart is NOT proven yet; only an explicit
  // 'known-good' (the first-install seed) starts out proven.
  const metaKind = kind === KIND_KNOWN_GOOD || kind === KIND_UNKNOWN ? kind : KIND_SNAPSHOT;
  const startedAt = Date.now();
  const base = {
    ok: false,
    cancelled: false,
    dir: null,
    stamp: null,
    at: null,
    atLocal: null,
    kind: metaKind,
    durationMs: 0,
    bytes: 0,
    totalBytes: 0,
    fileCount: 0,
    files: [],
    includePlugins: includePlugins === true,
    links: [],
    linkFiles: 0,
    linkBytes: 0,
    pruned: [],
    error: null,
  };
  if (profile === '') return { ...base, error: 'createBackup requires profileDir' };
  if (root === '') return { ...base, error: 'createBackup requires backupsDir' };
  if (!fs.existsSync(profile)) return { ...base, error: 'the profile directory does not exist' };

  // MEASURE FIRST: the progress report needs a denominator that is not made up.
  const measured = (() => {
    try {
      if (typeof measure === 'function') {
        const answer = measure(profile, includePlugins === true);
        return {
          files: Math.max(0, Number(answer && answer.files) || 0),
          bytes: Math.max(0, Number(answer && answer.bytes) || 0),
        };
      }
      const total = { files: 0, bytes: 0 };
      for (const name of CONFIG_FILES) {
        try {
          total.bytes += fs.statSync(path.join(profile, name)).size;
          total.files += 1;
        } catch {
          /* a missing config file is not a problem */
        }
      }
      if (includePlugins === true) {
        const tree = directorySize(path.join(profile, PLUGINS_DIR));
        total.bytes += tree.bytes;
        total.files += tree.files;
      }
      return total;
    } catch {
      return { files: 0, bytes: 0 };
    }
  })();

  const stamp = backupStamp(now);
  const dir = path.join(root, stamp);
  const files = [];
  let bytes = 0;
  let fileCount = 0;
  let cancelled = false;
  const isCancelled = () => {
    if (cancelled === true) return true;
    if (typeof shouldCancel !== 'function') return false;
    try {
      if (shouldCancel() === true) {
        cancelled = true;
        return true;
      }
    } catch {
      // A broken cancel callback must not abort anything.
    }
    return false;
  };
  const report = (approx) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        files: fileCount,
        bytes,
        total: measured.bytes,
        filesTotal: measured.files,
        // The estimate is passed along so the caller does not have to redo the
        // arithmetic; it is null until there is a real measurement to divide.
        ...(approx ? { approximate: true } : {}),
      });
    } catch {
      // Progress reporting never fails a backup.
    }
  };

  try {
    fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  } catch (error) {
    return { ...base, stamp, totalBytes: measured.bytes, error: 'could not create the backup directory: ' + (error && error.message ? error.message : String(error)) };
  }

  let configBytes = 0;
  for (const name of CONFIG_FILES) {
    if (isCancelled()) break;
    const source = path.join(profile, name);
    if (!fs.existsSync(source)) continue;
    if (copyEntry(source, path.join(dir, CONFIG_DIR, name))) {
      files.push(path.join(CONFIG_DIR, name));
      fileCount += 1;
      try {
        configBytes += fs.statSync(path.join(dir, CONFIG_DIR, name)).size;
        bytes = configBytes;
      } catch {
        // Size reporting is advisory only.
      }
      report(false);
    }
  }

  if (!cancelled && includePlugins === true) {
    const source = path.join(profile, PLUGINS_DIR);
    if (fs.existsSync(source)) {
      const copied = await copyTreeWithProgress({
        source,
        destination: path.join(dir, PLUGINS_DIR),
        shouldCancel: isCancelled,
        onProgress: (progress) => {
          fileCount = files.length + progress.files;
          bytes = configBytes + progress.bytes;
          report(false);
        },
      });
      if (copied.cancelled) {
        cancelled = true;
      } else if (copied.ok || copied.files > 0) {
        files.push(PLUGINS_DIR);
        fileCount = files.length + copied.files;
        bytes = configBytes + copied.bytes;
      }
    }
  }

  // THE LINKED PLUGINS (user decision, 2026-10-30). `node_modules/<name>` is a
  // reparse point for a `link:` installation, so the tree copy above records
  // the LINK and none of its contents. The contents are copied into their own
  // directory, and the manifest says which plugin came from where - that is
  // what makes a linked plugin (this one included) restorable at all.
  let links = [];
  let linkFiles = 0;
  let linkBytes = 0;
  if (!cancelled && includePlugins === true) {
    const collected = collectLinkedPlugins({ profileDir: profile });
    if (typeof linkProgress === 'function') {
      try {
        linkProgress(collected);
      } catch {
        // Reporting the links never fails a backup.
      }
    }
    for (const link of collected.links) {
      if (isCancelled()) break;
      const entry = { ...link, copied: false, copyError: null };
      if (link.exists !== true || link.readable !== true) {
        entry.copyError = 'the link target is missing or unreadable: it cannot be copied';
        links.push(entry);
        continue;
      }
      const copied = await copyTreeWithProgress({
        source: link.target,
        destination: path.join(dir, LINKS_DIR, link.name),
        shouldCancel: isCancelled,
      });
      if (copied.cancelled) {
        cancelled = true;
        break;
      }
      if (copied.ok !== true && copied.files === 0) {
        entry.copyError = copied.error || 'the link target could not be copied';
        links.push(entry);
        continue;
      }
      entry.copied = true;
      entry.files = copied.files;
      entry.bytes = copied.bytes;
      linkFiles += copied.files;
      linkBytes += copied.bytes;
      fileCount += copied.files;
      bytes += copied.bytes;
      files.push(path.join(LINKS_DIR, link.name));
      report(false);
      links.push(entry);
    }
  }

  if (cancelled) {
    removeBackupDir(dir);
    return {
      ...base,
      cancelled: true,
      stamp,
      totalBytes: measured.bytes,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: 'the backup was cancelled',
    };
  }

  const manifest = {
    stamp,
    at: Number(now),
    // The wall clock of the machine: the directory name above is UTC, and
    // without this line a fresh snapshot looks like an old leftover.
    atLocal: backupLocalTime(Number(now)),
    profileDir: profile,
    includePlugins: includePlugins === true,
    files,
    bytes,
    totalBytes: measured.bytes,
    fileCount,
    // THE LINKED PLUGINS: one entry per `link:` installation, with the target
    // it pointed at and what was really copied. Only ADDED to the manifest -
    // every existing field keeps its name and meaning, because three readers
    // (the restore script, the watchdog and lib/rescue.js) depend on them.
    links,
    linkFiles,
    linkBytes,
  };
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (error) {
    return { ...base, stamp, files, bytes, totalBytes: measured.bytes, fileCount, error: 'could not write the backup manifest: ' + (error && error.message ? error.message : String(error)) };
  }

  // THE IDENTITY, right next to the manifest: what this copy is and where it
  // came from. Best effort — a copy whose meta cannot be written stays an
  // 'unknown' one on disk (never used for an automatic rollback).
  writeBackupMeta(dir, {
    kind: metaKind,
    at: Number(now),
    version,
    bootId,
    requestId,
    reason,
  });

  const pruned = pruneBackups(root, maxBackups);
  return {
    ...base,
    ok: true,
    dir,
    stamp,
    at: Number(now),
    atLocal: manifest.atLocal,
    kind: metaKind,
    durationMs: Math.max(0, Date.now() - startedAt),
    bytes,
    totalBytes: measured.bytes,
    fileCount,
    files,
    // THE LOCAL VALUES, NOT THE BASE ONES: `...base` carries the EMPTY
    // placeholders (`links: []`, `linkFiles: 0`), so a caller that read
    // `result.links` was told "no linked plugins" while the manifest beside it
    // listed five and their contents had really been copied (measured on the
    // real profile, 2026-10-30: manifest 5 links / 1 217 files, return `[]`).
    // The manifest was right and the ANSWER was wrong.
    linkFiles,
    linkBytes,
    links,
    pruned,
  };
}

/**
 * Put a backup back over the live profile.
 *
 * The configuration files are copied over the existing ones; the plugin tree is
 * copied with `force` so the snapshot wins file by file. The caller decides what
 * to do with the host afterwards (the detached helper relaunches it).
 *
 * @param {{ backupDir: string, profileDir: string }} options
 * @returns {{ ok: boolean, restored: string[], error: string|null }}
 */
export function restoreBackup({ backupDir, profileDir } = {}) {
  const backup = typeof backupDir === 'string' ? backupDir.trim() : '';
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const restored = [];
  if (backup === '') return { ok: false, restored, error: 'restoreBackup requires backupDir' };
  if (profile === '') return { ok: false, restored, error: 'restoreBackup requires profileDir' };
  if (!fs.existsSync(backup)) return { ok: false, restored, error: 'the backup directory does not exist' };

  const configDir = path.join(backup, CONFIG_DIR);
  if (fs.existsSync(configDir)) {
    for (const name of CONFIG_FILES) {
      const source = path.join(configDir, name);
      if (!fs.existsSync(source)) continue;
      if (copyEntry(source, path.join(profile, name))) restored.push(name);
    }
  }
  const plugins = path.join(backup, PLUGINS_DIR);
  if (fs.existsSync(plugins) && copyEntry(plugins, path.join(profile, PLUGINS_DIR))) {
    restored.push(PLUGINS_DIR);
  }
  if (restored.length === 0) {
    return { ok: false, restored, error: 'the backup holds nothing that could be restored' };
  }
  return { ok: true, restored, error: null };
}

/**
 * Read the report the detached helper writes after a rolled-back boot.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    let text = fs.readFileSync(path.join(dir, ROLLBACK_REPORT_NAME), 'utf8');
    // Windows PowerShell 5.1 writes UTF-8 files with a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the rollback report once it has been reported.
 *
 * @param {string} stateDir
 * @returns {boolean} whether a report was removed
 */
export function clearRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, ROLLBACK_REPORT_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}
