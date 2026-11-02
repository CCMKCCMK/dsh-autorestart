/**
 * dsh-autorestart - THE SENTRY: the night watchman that lives outside the
 * plugin, outside the profile, and outside the host.
 *
 * WHY IT EXISTS (the failure nobody could get out of):
 *
 *   On 2026-10-30 the desktop client was found in a state DSH itself cannot
 *   recover from: no process, the profile emptied by the official
 *   `sanitizeProfile` (`dsh.profile.bundles` gone, `cordis.patch.yml` = `[]`),
 *   and the plugin itself removed together with the rest of the profile. Every
 *   other safety net of this plugin lives INSIDE the host or INSIDE the
 *   profile, so all of them were gone at the same moment. This file is the one
 *   that is not.
 *
 * STANDALONE BY CONTRACT. This file is copied to `<stateDir>/sentry/sentry.js`
 * and runs from there. It therefore imports NOTHING from the plugin - only
 * `node:` builtins. A test reads this file as text and asserts that, because a
 * plugin import here would make the whole watchman fail exactly when it is
 * needed (a rolled-back or cleaned plugin tree).
 *
 * WHAT IT DOES, once every `intervalMs`:
 *
 *   1. counts the processes of the desktop client (`tasklist`);
 *   2. running -> remember the moment, drop the burst counter, sleep;
 *   3. gone -> remember since when, decide (see `decideRescue`);
 *   4. rescue, in THIS order, and only in this order:
 *        a. remove the stale `dsh-auth-*` cookies (an over-long Cookie header
 *           is what makes the client die on startup);
 *        b. inspect the profile; if it was reduced to an empty shell, restore
 *           the newest snapshot;
 *        c. start the client, detached;
 *        d. wait for it (process + health route) and write the report.
 *   5. every round and every action goes to `sentry.log`, and every rescue
 *      writes `last-rescue.json` with a field list that may never change.
 *
 * WHAT IT MUST NEVER DO:
 *
 *   - `taskkill`. It never kills a host: a hostile watchman that kills is worse
 *     than no watchman (and the user's own restart is not its business).
 *   - start a second client while one is running (that is why an unreadable
 *     process count means "wait", never "rescue");
 *   - come back after the user closed DSH on purpose (clean-exit marker);
 *   - race a restart the plugin is already watching;
 *   - touch anything in the profile except the restore, and anything in the
 *     browser except the `dsh-auth-*` cookies.
 *
 * Usage:
 *   node sentry.js --config <stateDir>/sentry/sentry.json
 *   node sentry.js --config <...> --once      (one round, JSON on stdout)
 *   node sentry.js --config <...> --status    (status JSON, then exit)
 *
 * Pure ASCII, no byte order mark: this file is read with whatever code page the
 * machine has when it is started at login.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

/** The name of the autostart record. */
export const SENTRY_TASK_NAME = 'dsh-autorestart-sentry'

/** The directory (inside the state dir) this file is copied into. */
export const SENTRY_DIR_NAME = 'sentry'

/** The directory that holds the copied scripts. */
export const KIT_DIR_NAME = 'kit'

/** The configuration of the sentry. */
export const SENTRY_CONFIG_NAME = 'sentry.json'

/** The single-instance lock. */
export const SENTRY_LOCK_NAME = 'sentry.lock'

/** The log. */
export const SENTRY_LOG_NAME = 'sentry.log'

/** The report of the last rescue. */
export const SENTRY_REPORT_NAME = 'last-rescue.json'

/** The marker the plugin writes when the user closed DSH on purpose. */
export const SENTRY_CLEAN_EXIT_NAME = 'clean-exit.json'

/** The durable counters (so a restarted sentry keeps its budget). */
export const SENTRY_STATE_NAME = 'sentry-state.json'

/** The cookie cleanup of the kit. */
export const KIT_CLEAR_COOKIES_NAME = 'clear-dsh-auth-cookies.mjs'

/** The profile restore of the kit. */
export const KIT_RESTORE_SCRIPT_NAME = 'restore-profile.ps1'

/** The version of the configuration this file understands. */
export const SENTRY_CONFIG_VERSION = 1

/** The image name of the desktop client, when nothing else is known. */
export const DEFAULT_IMAGE_NAME = 'DeepSeek Harness.exe'

/** The health route of the plugin. */
export const HEALTH_PATH = '/__dsh_autorestart/health'

/** How often the process table is read. */
export const DEFAULT_INTERVAL_MS = 30000

/** How long the host may be gone before it counts as a crash. */
export const DEFAULT_GRACE_MS = 90000

/** How long a started host gets to answer. */
export const DEFAULT_START_TIMEOUT_MS = 90000

/** How many starts one burst of downtime may produce. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** How many rescues one hour may produce. */
export const DEFAULT_MAX_RESCUES_PER_HOUR = 3

/** The window of the rescue budget. */
export const DEFAULT_RESCUE_WINDOW_MS = 3600000

/** The first wait of the backoff. */
export const DEFAULT_BACKOFF_BASE_MS = 5000

/** The cap of the backoff. */
export const DEFAULT_BACKOFF_MAX_MS = 120000

/**
 * How much earlier than "the host was last seen alive" a clean exit may be
 * written and still count as "the user meant it".
 */
export const CLEAN_EXIT_SLACK_MS = 5000

/** The log grows to this size before it is rotated away. */
export const MAX_LOG_BYTES = 1024 * 1024

/** The marker the plugin writes when a restart is being watched. */
export const WATCHDOG_PENDING_NAME = 'watchdog-pending.json'

/** The durable record of one restart. */
export const RESTART_VERDICT_NAME = 'last-restart-verdict.json'

/** How long a "a restart is in flight" marker is believed. */
export const DEFAULT_PENDING_WINDOW_MS = 600000

/** The fields of the rescue report. FROZEN: never rename one. */
export const RESCUE_REPORT_FIELDS = Object.freeze([
  'at',
  'action',
  'reason',
  'cleared',
  'restored',
  'launched',
  'ready',
  'errors',
  'durationMs',
])

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

/**
 * A number, or null when there is really no number.
 *
 * `Number(null)` and `Number('')` are both 0 - which would silently turn "this
 * never happened" into "this happened at the epoch". Every optional moment of
 * the decision goes through here, so `null` stays `null`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Read a text file, without a byte order mark.
 *
 * @param {string} file
 * @returns {{ ok: boolean, text: string, error: string|null }}
 */
export function readTextFile(file) {
  const target = typeof file === 'string' ? file.trim() : ''
  if (target === '') return { ok: false, text: '', error: 'readTextFile requires a path' }
  try {
    const text = fs.readFileSync(target, 'utf8')
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, error: null }
  } catch (error) {
    return { ok: false, text: '', error: errorText(error) }
  }
}

/**
 * Every path this file uses inside the state directory.
 *
 * @param {string} stateDir
 * @returns {object}
 */
export function sentryPaths(stateDir) {
  const root = String(stateDir ?? '')
  const dir = path.join(root, SENTRY_DIR_NAME)
  const kit = path.join(dir, KIT_DIR_NAME)
  return {
    dir,
    config: path.join(dir, SENTRY_CONFIG_NAME),
    lock: path.join(dir, SENTRY_LOCK_NAME),
    log: path.join(dir, SENTRY_LOG_NAME),
    report: path.join(dir, SENTRY_REPORT_NAME),
    cleanExit: path.join(dir, SENTRY_CLEAN_EXIT_NAME),
    state: path.join(dir, SENTRY_STATE_NAME),
    runtime: path.join(dir, 'sentry.js'),
    kit,
    clearCookiesScript: path.join(kit, KIT_CLEAR_COOKIES_NAME),
    restoreScript: path.join(kit, KIT_RESTORE_SCRIPT_NAME),
  }
}

/**
 * The command line of the daemon.
 *
 * @param {string[]} argv
 * @returns {{ configPath: string|null, once: boolean, status: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : []
  let configPath = null
  let once = false
  let status = false
  let help = false
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index] ?? '')
    if (arg === '--config' || arg === '-c') {
      configPath = typeof list[index + 1] === 'string' ? list[index + 1] : null
      index += 1
      continue
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length)
      continue
    }
    if (arg === '--once') {
      once = true
      continue
    }
    if (arg === '--status') {
      status = true
      continue
    }
    if (arg === '--help' || arg === '-h') help = true
  }
  return { configPath, once, status, help }
}

/**
 * Split ONE line of `tasklist /FO CSV`.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const cells = []
  const text = String(line ?? '')
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === ',') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell)
  return cells.map((entry) => entry.trim())
}

/**
 * Count the processes that match an image name, out of `tasklist` output.
 *
 * The "no tasks are running" answer of tasklist is a SENTENCE, not an empty
 * table, and it must be read as 0 processes instead of as one row.
 *
 * @param {string} text
 * @param {string} [imageName]
 * @returns {{ count: number, pids: number[] }}
 */
export function parseTasklistOutput(text, imageName = '') {
  const raw = typeof text === 'string' ? text : ''
  const wanted = String(imageName ?? '').trim().toLowerCase()
  const pids = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('"') === false) continue
    const cells = splitCsvLine(trimmed)
    if (cells.length < 2) continue
    if (wanted !== '' && cells[0].toLowerCase() !== wanted) continue
    const pid = Number(cells[1])
    if (Number.isInteger(pid) !== true || pid <= 0) continue
    if (pids.includes(pid)) continue
    pids.push(pid)
  }
  return { count: pids.length, pids }
}

/**
 * The bundles a profile package.json lists.
 *
 * @param {string} packageJsonText
 * @returns {{ ok: boolean, bundles: string[], error: string|null }}
 */
export function countBundles(packageJsonText) {
  const text = typeof packageJsonText === 'string'
    ? (packageJsonText.charCodeAt(0) === 0xfeff ? packageJsonText.slice(1) : packageJsonText)
    : ''
  if (text.trim() === '') return { ok: false, bundles: [], error: 'the package.json text is empty' }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, bundles: [], error: 'the package.json cannot be parsed: ' + errorText(error) }
  }
  const profile = parsed && typeof parsed === 'object' ? parsed.dsh : null
  const container = profile && typeof profile === 'object' ? profile.profile : null
  const raw = container && typeof container === 'object' ? container.bundles : null
  const bundles = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim() !== '') bundles.push(entry.trim())
    }
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    bundles.push(raw.trim())
  }
  return { ok: true, bundles, error: null }
}

/**
 * Does this `cordis.patch.yml` text hold anything at all?
 *
 * @param {unknown} patchText
 * @returns {boolean}
 */
export function patchHasContent(patchText) {
  const text = typeof patchText === 'string' ? patchText.trim() : ''
  if (text === '') return false
  if (/^\[\s*\]$/.test(text)) return false
  if (/^null$/.test(text) || /^---\s*$/.test(text)) return false
  const meaningful = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && trimmed.startsWith('#') === false
  })
  if (meaningful.length === 0) return false
  return !(meaningful.length === 1 && /^\[\s*\]$/.test(meaningful[0]))
}

/**
 * Does the profile look like it was reduced to an empty shell?
 *
 * @param {{ currentPackageText?: string, backupPackageText?: string, currentPatchText?: string, backupPatchText?: string }} [input]
 * @returns {{ sanitized: boolean, reason: string }}
 */
export function profileLooksSanitized(input = {}) {
  const current = countBundles(input.currentPackageText)
  const backup = countBundles(input.backupPackageText)
  if (current.ok !== true) {
    return {
      sanitized: true,
      reason: 'the current package.json is missing or cannot be parsed (' + String(current.error) + ')',
    }
  }
  if (current.bundles.length === 0 && backup.ok === true && backup.bundles.length > 0) {
    return {
      sanitized: true,
      reason: 'dsh.profile.bundles is empty while the newest backup lists ' + backup.bundles.length + ' bundle(s)',
    }
  }
  const currentPatch = patchHasContent(input.currentPatchText)
  const backupPatch = patchHasContent(input.backupPatchText)
  if (currentPatch !== true && backupPatch === true) {
    return {
      sanitized: true,
      reason: 'cordis.patch.yml holds nothing while the newest backup still has a patch',
    }
  }
  return { sanitized: false, reason: 'the profile still lists its bundles and its patch' }
}

/**
 * THE DECISION: may the host be started, and if not, why not?
 *
 * The order is FIXED (see `lib/sentry.js`, which is the tested copy of this
 * same function, and `test/sentry-install.test.mjs`, which compares the two on
 * one table of cases):
 *
 *   1. running -> idle; 2. down since when is unknown -> wait;
 *   3. still inside the grace period -> wait; 4. the user closed it ->
 *   stand-down-intentional; 5. a restart is in flight ->
 *   stand-down-restart-in-flight; 6. the hourly budget is spent ->
 *   stand-down-budget; 7. this burst is over -> give-up; 8. rescue.
 *
 * The caller must never pass an UNKNOWN process count: an unreadable count is
 * not a count of zero, and a second client next to a running one is the one
 * accident this watchman must never cause.
 *
 * @param {object} [input]
 * @returns {{ action: string, reason: string }}
 */
export function decideRescue(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : 0
  const graceMs = positiveNumber(input.graceMs, DEFAULT_GRACE_MS)
  const maxRescues = positiveNumber(input.maxRescuesPerHour, DEFAULT_MAX_RESCUES_PER_HOUR)
  const maxAttempts = positiveNumber(input.maxAttempts, DEFAULT_MAX_ATTEMPTS)

  if (Number(input.processCount) > 0) {
    return { action: 'idle', reason: 'the host is running (' + Number(input.processCount) + ' process(es))' }
  }

  const downSince = numberOrNull(input.downSince)
  if (downSince === null) {
    return { action: 'wait', reason: 'the host is gone; the moment it went away is recorded first' }
  }

  if (now - downSince < graceMs) {
    return {
      action: 'wait',
      reason: 'the host has been gone for ' + Math.max(0, Math.trunc(now - downSince)) + 'ms, the grace period is ' + graceMs + 'ms',
    }
  }

  const lastSeen = numberOrNull(input.lastSeenRunningAt)
  const cleanExit = numberOrNull(input.cleanExitAt)
  if (cleanExit !== null) {
    const reference = lastSeen === null ? downSince : lastSeen
    if (cleanExit >= reference - CLEAN_EXIT_SLACK_MS) {
      return {
        action: 'stand-down-intentional',
        reason: 'the host was closed on purpose (clean exit at ' + cleanExit + ')',
      }
    }
  }

  if (input.watchdogPending === true) {
    return { action: 'stand-down-restart-in-flight', reason: 'a restart is in flight and somebody else is watching it' }
  }

  const inWindow = Number.isFinite(Number(input.attemptsInWindow)) ? Math.trunc(Number(input.attemptsInWindow)) : 0
  if (inWindow >= maxRescues) {
    return {
      action: 'stand-down-budget',
      reason: inWindow + ' rescue(s) already happened in the budget window of ' + maxRescues,
    }
  }

  const burst = Number.isFinite(Number(input.attemptsThisBurst)) ? Math.trunc(Number(input.attemptsThisBurst)) : 0
  if (burst >= maxAttempts) {
    return {
      action: 'give-up',
      reason: 'the host was started ' + burst + ' time(s) in this burst and does not stay up (limit ' + maxAttempts + ')',
    }
  }

  return { action: 'rescue', reason: 'the host is gone and no rule stands the sentry down' }
}

/**
 * The wait before the next start of a burst (doubles, then caps).
 *
 * @param {number} attempt
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number}
 */
export function nextBackoffMs(attempt, options = {}) {
  const base = positiveNumber(options.baseMs, DEFAULT_BACKOFF_BASE_MS)
  const max = positiveNumber(options.maxMs, DEFAULT_BACKOFF_MAX_MS)
  const number = Number.isFinite(Number(attempt)) ? Math.max(1, Math.trunc(Number(attempt))) : 1
  let delay = base
  for (let index = 1; index < number; index += 1) {
    if (delay >= max) return max
    delay *= 2
  }
  return Math.min(max, delay)
}

/**
 * Is this pid alive? (EPERM means "somebody else's" - still alive.)
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  const number = Number(pid)
  if (Number.isFinite(number) !== true || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/**
 * Read a JSON file (a file that cannot be read is a file that is not there).
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readJsonFile(file) {
  const read = readTextFile(file)
  if (read.ok !== true) return null
  try {
    const parsed = JSON.parse(read.text)
    return parsed && typeof parsed === 'object' && Array.isArray(parsed) === false ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the configuration of the sentry.
 *
 * @param {string} configPath
 * @returns {{ ok: boolean, config: object|null, error: string|null }}
 */
export function readConfig(configPath) {
  const file = typeof configPath === 'string' ? configPath.trim() : ''
  if (file === '') return { ok: false, config: null, error: 'readConfig requires a path' }
  const parsed = readJsonFile(file)
  if (parsed === null) return { ok: false, config: null, error: 'the configuration cannot be read: ' + file }
  return { ok: true, config: parsed, error: null }
}

/**
 * Read the clean-exit marker.
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readCleanExit(file) {
  return readJsonFile(file)
}

/**
 * Take the exclusive lock. A lock of a DEAD owner is taken over.
 *
 * @param {string} lockPath
 * @param {{ pid?: number, isAlive?: (pid: number) => boolean }} [options]
 * @returns {{ ok: boolean, stale: boolean, error: string|null, owner: number }}
 */
export function acquireLock(lockPath, options = {}) {
  const file = typeof lockPath === 'string' ? lockPath.trim() : ''
  if (file === '') return { ok: false, stale: false, error: 'acquireLock requires a path', owner: 0 }
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid
  const alive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    /* it may already be there */
  }
  const write = () => {
    const handle = fs.openSync(file, 'wx')
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid, at: new Date().toISOString() }), 'utf8')
    } finally {
      try {
        fs.closeSync(handle)
      } catch {
        /* the owner is what matters */
      }
    }
  }
  try {
    write()
    return { ok: true, stale: false, error: null, owner: pid }
  } catch {
    const existing = readJsonFile(file)
    const owner = existing && Number.isFinite(Number(existing.pid)) ? Number(existing.pid) : 0
    if (owner > 0 && alive(owner)) {
      return { ok: false, stale: false, error: 'another sentry is already running (pid ' + owner + ')', owner }
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* the takeover below reports the failure */
    }
    try {
      write()
      return { ok: true, stale: true, error: null, owner: pid }
    } catch (error) {
      return { ok: false, stale: false, error: errorText(error), owner }
    }
  }
}

/**
 * Release the lock.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
export function releaseLock(lockPath) {
  try {
    fs.rmSync(String(lockPath ?? ''), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Append one line to the log and rotate it when it grew too big.
 *
 * @param {string} logPath
 * @param {string} line
 * @returns {boolean}
 */
export function appendLog(logPath, line) {
  const file = typeof logPath === 'string' ? logPath.trim() : ''
  if (file === '') return false
  const text = new Date().toISOString() + ' ' + String(line ?? '') + '\n'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_LOG_BYTES) fs.rmSync(file, { force: true })
    } catch {
      /* there is no log yet */
    }
    fs.appendFileSync(file, text, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * The rescue report, with its frozen field list.
 *
 * @param {object} [input]
 * @returns {object}
 */
export function buildRescueReport(input = {}) {
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now()
  return {
    at,
    atIso: new Date(at).toISOString(),
    action: typeof input.action === 'string' ? input.action : 'rescue',
    reason: typeof input.reason === 'string' ? input.reason : '',
    cleared: input.cleared && typeof input.cleared === 'object' ? input.cleared : null,
    restored: input.restored && typeof input.restored === 'object' ? input.restored : null,
    launched: input.launched && typeof input.launched === 'object' ? input.launched : null,
    ready: input.ready === true,
    errors: Array.isArray(input.errors) ? input.errors.map(String) : [],
    durationMs: Number.isFinite(Number(input.durationMs)) ? Math.max(0, Math.trunc(Number(input.durationMs))) : 0,
  }
}

/**
 * Write the rescue report (never throws).
 *
 * @param {string} file
 * @param {object} report
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeReport(file, report) {
  const target = typeof file === 'string' ? file.trim() : ''
  if (target === '') return { ok: false, path: '', error: 'writeReport requires a path' }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = target + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(buildRescueReport(report), null, 2) + '\n', 'utf8')
    fs.renameSync(temporary, target)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return { ok: false, path: target, error: errorText(error) }
  }
}

/**
 * Is a restart of the plugin in flight?
 *
 * @param {{ stateDir?: string, now?: number, windowMs?: number }} [options]
 * @returns {{ pending: boolean, reason: string }}
 */
export function readRestartInFlight(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const windowMs = positiveNumber(options.windowMs, DEFAULT_PENDING_WINDOW_MS)
  if (stateDir === '') return { pending: false, reason: 'no state directory' }

  const pendingFile = path.join(stateDir, WATCHDOG_PENDING_NAME)
  const marker = readJsonFile(pendingFile)
  if (marker !== null) {
    const written = Date.parse(typeof marker.at === 'string' ? marker.at : '')
    if (Number.isFinite(written) === false || now - written <= windowMs) {
      return { pending: true, reason: 'the watchdog pending marker is there' }
    }
    return { pending: false, reason: 'the watchdog pending marker is stale' }
  }

  const verdict = readJsonFile(path.join(stateDir, RESTART_VERDICT_NAME))
  if (verdict !== null && verdict.result === 'pending') {
    const started = Date.parse(typeof verdict.startedAt === 'string' ? verdict.startedAt : '')
    if (Number.isFinite(started) === false || now - started <= windowMs) {
      return { pending: true, reason: 'the last restart verdict is still pending' }
    }
    return { pending: false, reason: 'the last restart verdict is stale' }
  }
  return { pending: false, reason: 'no restart is in flight' }
}

/**
 * Read the durable counters of this sentry.
 *
 * @param {string} file
 * @returns {object}
 */
export function readState(file) {
  const parsed = readJsonFile(file)
  const attempts = parsed && Array.isArray(parsed.attempts) ? parsed.attempts : []
  return {
    downSince: numberOrNull(parsed && parsed.downSince),
    lastSeenRunningAt: numberOrNull(parsed && parsed.lastSeenRunningAt),
    attemptsThisBurst: parsed && Number.isFinite(Number(parsed.attemptsThisBurst))
      ? Math.max(0, Math.trunc(Number(parsed.attemptsThisBurst)))
      : 0,
    attempts: attempts.map(Number).filter((entry) => Number.isFinite(entry)),
  }
}

/**
 * Write the durable counters.
 *
 * @param {string} file
 * @param {object} state
 * @returns {boolean}
 */
export function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(String(file)), { recursive: true })
    const temporary = String(file) + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    fs.renameSync(temporary, String(file))
    return true
  } catch {
    return false
  }
}

/**
 * How many processes of the desktop client are running?
 *
 * An unreadable answer is reported as `count: null` - the caller must treat it
 * as "unknown", never as "zero".
 *
 * @param {string} imageName
 * @param {{ execFileSyncFn?: Function }} [options]
 * @returns {{ count: number|null, pids: number[], error: string|null }}
 */
export function countProcesses(imageName, options = {}) {
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const image = typeof imageName === 'string' && imageName !== '' ? imageName : DEFAULT_IMAGE_NAME
  try {
    const output = exec('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    const parsed = parseTasklistOutput(String(output ?? ''), image)
    return { count: parsed.count, pids: parsed.pids, error: null }
  } catch (error) {
    return { count: null, pids: [], error: errorText(error) }
  }
}

/**
 * Ask the health route of the plugin whether the host is alive.
 *
 * The URL is the LOOPBACK one without a token: the health route answers
 * loopback requests without authentication, so the sentry never needs (and
 * never sees) the boot token.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function probeHealth(url, options = {}) {
  const target = typeof url === 'string' ? url.trim() : ''
  if (target === '') return Promise.resolve(false)
  const timeout = positiveNumber(options.timeoutMs, 5000)
  return new Promise((resolve) => {
    let settled = false
    const done = (healthy) => {
      if (settled) return
      settled = true
      resolve(healthy)
    }
    let request
    try {
      request = http.get(target, { timeout }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            done(body && body.ok === true)
          } catch {
            done(false)
          }
        })
        response.on('error', () => done(false))
      })
    } catch {
      done(false)
      return
    }
    request.on('timeout', () => {
      try {
        request.destroy()
      } catch {
        /* nothing else to do */
      }
      done(false)
    })
    request.on('error', () => done(false))
  })
}

/**
 * The health URL of the running host, built from the port file the plugin
 * writes (`<stateDir>/access.json`).
 *
 * @param {{ portFile?: string, healthPath?: string }} config
 * @returns {string}
 */
export function healthUrlOf(config) {
  const portFile = typeof config.portFile === 'string' ? config.portFile : ''
  if (portFile === '') return ''
  const record = readJsonFile(portFile)
  const port = record && Number.isFinite(Number(record.port)) ? Number(record.port) : 0
  if (port <= 0) return ''
  const healthPath = typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : HEALTH_PATH
  return 'http://127.0.0.1:' + port + healthPath
}

/**
 * The newest snapshot, with the two profile texts the health check needs.
 *
 * The snapshots live in `<stateDir>/backups/<stamp>/config/...` and the newest
 * one is the one with the highest stamp - the directory names are sortable by
 * design (`backupStamp` in `lib/backup.js`).
 *
 * @param {string} stateDir
 * @returns {{ dir: string, packageText: string, patchText: string }}
 */
export function newestBackup(stateDir) {
  const root = path.join(String(stateDir ?? ''), 'backups')
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return { dir: '', packageText: '', patchText: '' }
  }
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const dir = path.join(root, names[index])
    const packageFile = path.join(dir, 'config', 'package.json')
    if (fs.existsSync(packageFile) !== true) continue
    return {
      dir,
      packageText: readTextFile(packageFile).text,
      patchText: readTextFile(path.join(dir, 'config', 'cordis.patch.yml')).text,
    }
  }
  return { dir: '', packageText: '', patchText: '' }
}

/**
 * The texts of the profile that is on disk right now.
 *
 * @param {string} profileDir
 * @returns {{ packageText: string, patchText: string }}
 */
export function currentProfileTexts(profileDir) {
  const dir = typeof profileDir === 'string' ? profileDir : ''
  if (dir === '') return { packageText: '', patchText: '' }
  return {
    packageText: readTextFile(path.join(dir, 'package.json')).text,
    patchText: readTextFile(path.join(dir, 'cordis.patch.yml')).text,
  }
}

/**
 * Run one command and report what happened (never throws).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ execFileSyncFn?: Function, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, code: number|null, stdout: string, error: string|null }}
 */
export function runCommand(file, args, options = {}) {
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  try {
    const stdout = exec(file, Array.isArray(args) ? args.map(String) : [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: positiveNumber(options.timeoutMs, 180000),
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), error: null }
  } catch (error) {
    return {
      ok: false,
      code: error && Number.isFinite(Number(error.status)) ? Number(error.status) : null,
      stdout: error && typeof error.stdout === 'string' ? error.stdout : '',
      error: errorText(error),
    }
  }
}

/**
 * The interpreter this file is running under (a real node, by construction).
 *
 * @returns {string}
 */
export function currentNodePath() {
  return process.execPath
}

/**
 * Step (a) of a rescue: remove the stale `dsh-auth-*` cookies.
 *
 * Only the kit script is run; the sentry itself never opens the cookie jar.
 *
 * @param {{ paths: object, config: object, execFileSyncFn?: Function, existsSyncFn?: Function }} options
 * @returns {{ ok: boolean, skipped: boolean, code: number|null, error: string|null }}
 */
export function clearCookies(options = {}) {
  const paths = options.paths && typeof options.paths === 'object' ? options.paths : {}
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const script = typeof paths.clearCookiesScript === 'string' ? paths.clearCookiesScript : ''
  if (script === '' || exists(script) !== true) {
    return { ok: false, skipped: true, code: null, error: 'the cookie cleanup script is not in the kit' }
  }
  const node = typeof options.config.nodePath === 'string' && options.config.nodePath !== ''
    ? options.config.nodePath
    : process.execPath
  const answer = runCommand(node, [script], { execFileSyncFn: options.execFileSyncFn })
  return { ok: answer.ok, skipped: false, code: answer.code, error: answer.error }
}

/**
 * Step (b) of a rescue: put the newest snapshot back when the profile was
 * emptied.
 *
 * NOTHING is restored when the profile looks healthy - a restore moves the
 * current profile away, and doing that to a working profile would be worse
 * than the disease.
 *
 * @param {{
 *   paths: object, config: object, existsSyncFn?: Function, execFileSyncFn?: Function,
 *   readTextFileFn?: Function,
 * }} options
 * @returns {{ attempted: boolean, ok: boolean, skipped: boolean, reason: string, error: string|null }}
 */
export function restoreProfile(options = {}) {
  const paths = options.paths && typeof options.paths === 'object' ? options.paths : {}
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const profileDir = typeof config.profileDir === 'string' ? config.profileDir : ''
  const stateDir = typeof config.stateDir === 'string' ? config.stateDir : ''
  if (profileDir === '' || stateDir === '') {
    return { attempted: false, ok: false, skipped: true, reason: 'the configuration carries no profileDir/stateDir', error: null }
  }
  const current = currentProfileTexts(profileDir)
  const backup = newestBackup(stateDir)
  const verdict = profileLooksSanitized({
    currentPackageText: current.packageText,
    backupPackageText: backup.packageText,
    currentPatchText: current.patchText,
    backupPatchText: backup.patchText,
  })
  if (verdict.sanitized !== true) {
    return { attempted: false, ok: true, skipped: true, reason: verdict.reason, error: null }
  }
  const script = typeof paths.restoreScript === 'string' ? paths.restoreScript : ''
  if (script === '' || exists(script) !== true) {
    // Skipped is NOT success: the report says "not restored" and why.
    return {
      attempted: false,
      ok: false,
      skipped: false,
      reason: 'the profile looks emptied (' + verdict.reason + ') but the restore script is not in the kit',
      error: 'the restore script is not in the kit',
    }
  }
  const answer = runCommand('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-ProfileDir', profileDir,
    '-StateDir', stateDir,
  ], { execFileSyncFn: options.execFileSyncFn })
  return {
    attempted: true,
    ok: answer.ok,
    skipped: false,
    reason: verdict.reason,
    error: answer.ok ? null : String(answer.error),
  }
}

/**
 * Step (c) of a rescue: start the client, detached, with no window of ours.
 *
 * @param {{ config: object, spawnFn?: Function, existsSyncFn?: Function }} options
 * @returns {{ ok: boolean, pid: number|null, execPath: string, error: string|null }}
 */
export function launchHost(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const execPath = typeof config.appExecPath === 'string' ? config.appExecPath : ''
  if (execPath === '') return { ok: false, pid: null, execPath, error: 'the configuration carries no appExecPath' }
  if (exists(execPath) !== true) {
    return { ok: false, pid: null, execPath, error: 'the application executable is not there any more: ' + execPath }
  }
  try {
    const child = spawnFn(execPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    if (child && typeof child.unref === 'function') child.unref()
    return { ok: true, pid: child && Number.isFinite(Number(child.pid)) ? Number(child.pid) : null, execPath, error: null }
  } catch (error) {
    return { ok: false, pid: null, execPath, error: errorText(error) }
  }
}

/**
 * Step (d) of a rescue: wait until the started host is really there.
 *
 * @param {{
 *   config: object, countProcessesFn?: Function, probeFn?: Function,
 *   sleep?: Function, now?: () => number,
 * }} options
 * @returns {Promise<{ ready: boolean, waitedMs: number, reason: string }>}
 */
export async function waitForReady(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const count = typeof options.countProcessesFn === 'function' ? options.countProcessesFn : countProcesses
  const probe = typeof options.probeFn === 'function' ? options.probeFn : probeHealth
  const now = typeof options.now === 'function' ? options.now : Date.now
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const timeout = positiveNumber(config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)
  const imageName = typeof config.appImageName === 'string' && config.appImageName !== ''
    ? config.appImageName
    : DEFAULT_IMAGE_NAME
  const started = now()
  const deadline = started + timeout
  let last = 'the host did not appear'
  while (now() <= deadline) {
    const counted = count(imageName)
    if (Number(counted.count) > 0) {
      const url = healthUrlOf(config)
      if (url === '') return { ready: true, waitedMs: Math.max(0, now() - started), reason: 'the process is there (no port file: the process is the check)' }
      if (await probe(url, { timeoutMs: 5000 }) === true) {
        return { ready: true, waitedMs: Math.max(0, now() - started), reason: 'the process and the health route are there' }
      }
      last = 'the process is there but the health route does not answer'
    } else if (counted.count === null) {
      last = 'the process table could not be read: ' + String(counted.error)
    }
    await sleep(2000)
  }
  return { ready: false, waitedMs: Math.max(0, now() - started), reason: last }
}

/**
 * ONE round of the watchman.
 *
 * @param {{
 *   config: object, paths: object, state?: object, log?: (line: string) => void,
 *   now?: () => number, countProcessesFn?: Function, spawnFn?: Function,
 *   probeFn?: Function, execFileSyncFn?: Function, sleep?: Function,
 *   existsSyncFn?: Function, stateStore?: { read: Function, write: Function },
 * }} options
 * @returns {Promise<object>} the round result (what `--once` prints)
 */
export async function runRound(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}
  const paths = options.paths && typeof options.paths === 'object'
    ? options.paths
    : sentryPaths(typeof config.stateDir === 'string' ? config.stateDir : '')
  const count = typeof options.countProcessesFn === 'function' ? options.countProcessesFn : countProcesses
  const state = options.state && typeof options.state === 'object' ? options.state : {}
  const stateStore = options.stateStore && typeof options.stateStore === 'object' ? options.stateStore : null
  const imageName = typeof config.appImageName === 'string' && config.appImageName !== ''
    ? config.appImageName
    : DEFAULT_IMAGE_NAME
  const at = now()

  const counted = count(imageName)
  const processCount = Number(counted.count)
  const known = Number.isFinite(processCount)
  const result = {
    at,
    atIso: new Date(at).toISOString(),
    processCount: known ? processCount : null,
    pids: Array.isArray(counted.pids) ? counted.pids : [],
    action: 'wait',
    reason: '',
    rescue: null,
    errors: counted.error ? [String(counted.error)] : [],
  }

  if (known !== true) {
    // An unreadable process table is NOT a count of zero: starting a second
    // client next to a running one is the one accident this watchman must
    // never cause.
    result.action = 'wait'
    result.reason = 'the process table could not be read: ' + String(counted.error)
    log('round: ' + result.reason)
    return result
  }

  if (processCount > 0) {
    state.lastSeenRunningAt = at
    state.downSince = null
    state.attemptsThisBurst = 0
    if (stateStore) stateStore.write(state)
    result.action = 'idle'
    result.reason = 'the host is running (' + processCount + ' process(es))'
    log('round: ' + result.reason)
    return result
  }

  if (numberOrNull(state.downSince) === null) {
    state.downSince = at
    if (stateStore) stateStore.write(state)
  }
  const cleanExit = readCleanExit(paths.cleanExit)
  const cleanExitAt = cleanExit && Number.isFinite(Number(cleanExit.at)) ? Number(cleanExit.at) : null
  const inFlight = readRestartInFlight({ stateDir: typeof config.stateDir === 'string' ? config.stateDir : '', now: at })
  const window = positiveNumber(config.rescueWindowMs, DEFAULT_RESCUE_WINDOW_MS)
  const recent = (Array.isArray(state.attempts) ? state.attempts : [])
    .map(Number)
    .filter((entry) => Number.isFinite(entry) && at - entry <= window)
  state.attempts = recent
  const verdict = decideRescue({
    now: at,
    processCount,
    downSince: state.downSince,
    lastSeenRunningAt: state.lastSeenRunningAt,
    graceMs: positiveNumber(config.graceMs, DEFAULT_GRACE_MS),
    cleanExitAt,
    watchdogPending: inFlight.pending === true,
    attemptsInWindow: recent.length,
    maxRescuesPerHour: positiveNumber(config.maxRescuesPerHour, DEFAULT_MAX_RESCUES_PER_HOUR),
    attemptsThisBurst: state.attemptsThisBurst,
    maxAttempts: positiveNumber(config.maxAttempts, DEFAULT_MAX_ATTEMPTS),
  })
  result.action = verdict.action
  result.reason = verdict.reason
  log('round: ' + verdict.action + ' (' + verdict.reason + ')')
  if (verdict.action !== 'rescue') return result

  // ---- the rescue, in the fixed order ----
  const startedAt = now()
  const errors = []
  const cleared = clearCookies({ paths, config, execFileSyncFn: options.execFileSyncFn, existsSyncFn: options.existsSyncFn })
  if (cleared.skipped !== true && cleared.ok !== true) errors.push('cookie cleanup: ' + String(cleared.error))
  log('rescue: cookies ' + (cleared.skipped === true ? 'skipped (' + String(cleared.error) + ')' : (cleared.ok ? 'ok' : 'failed')))

  const restored = restoreProfile({
    paths,
    config,
    execFileSyncFn: options.execFileSyncFn,
    existsSyncFn: options.existsSyncFn,
  })
  if (restored.error) errors.push('restore: ' + String(restored.error))
  log('rescue: restore ' + (restored.attempted === true ? (restored.ok ? 'ok' : 'failed') : 'skipped') + ' (' + restored.reason + ')')

  const launched = launchHost({ config, spawnFn: options.spawnFn, existsSyncFn: options.existsSyncFn })
  if (launched.ok !== true) errors.push('launch: ' + String(launched.error))
  log('rescue: launch ' + (launched.ok ? ('pid ' + String(launched.pid)) : ('failed: ' + String(launched.error))))

  state.attemptsThisBurst = (Number(state.attemptsThisBurst) || 0) + 1
  state.attempts = [...recent, startedAt]
  state.downSince = null
  if (stateStore) stateStore.write(state)

  let ready = { ready: false, waitedMs: 0, reason: 'the host was never started' }
  if (launched.ok === true) {
    ready = await waitForReady({
      config,
      countProcessesFn: count,
      probeFn: options.probeFn,
      sleep: options.sleep,
      now: options.now,
    })
    if (ready.ready !== true) errors.push('ready: ' + ready.reason)
    else {
      state.lastSeenRunningAt = now()
      state.attemptsThisBurst = 0
      if (stateStore) stateStore.write(state)
    }
  }

  const report = buildRescueReport({
    at: startedAt,
    action: 'rescue',
    reason: verdict.reason,
    cleared: { attempted: cleared.skipped !== true, ok: cleared.ok === true, code: cleared.code, error: cleared.error },
    restored,
    launched,
    ready: ready.ready === true,
    errors,
    durationMs: Math.max(0, now() - startedAt),
  })
  const written = writeReport(paths.report, report)
  if (written.ok !== true) log('rescue: the report could not be written: ' + String(written.error))
  log('rescue: ' + (ready.ready === true ? 'recovered' : 'failed') + ' in ' + report.durationMs + 'ms')
  result.rescue = report
  return result
}

/**
 * The main loop. NOTHING may leave it: a watchman that exits on an error is
 * no watchman at all.
 *
 * @param {{
 *   config: object, paths?: object, log?: (line: string) => void,
 *   sleep?: Function, now?: () => number, rounds?: number,
 *   countProcessesFn?: Function, spawnFn?: Function, probeFn?: Function,
 *   execFileSyncFn?: Function, existsSyncFn?: Function,
 * }} options
 * @returns {Promise<{ ok: boolean, rounds: number, reason: string }>}
 */
export async function runSentry(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const stateDir = typeof config.stateDir === 'string' && config.stateDir !== ''
    ? config.stateDir
    : ''
  const paths = options.paths && typeof options.paths === 'object' ? options.paths : sentryPaths(stateDir)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const interval = positiveNumber(config.intervalMs, DEFAULT_INTERVAL_MS)
  const limit = Number.isFinite(Number(options.rounds)) && Number(options.rounds) > 0
    ? Math.trunc(Number(options.rounds))
    : Infinity

  const state = readState(paths.state)
  const stateStore = {
    read: () => state,
    write: (next) => writeState(paths.state, next),
  }

  let rounds = 0
  while (rounds < limit) {
    try {
      await runRound({
        config,
        paths,
        state,
        stateStore,
        log,
        now: options.now,
        countProcessesFn: options.countProcessesFn,
        spawnFn: options.spawnFn,
        probeFn: options.probeFn,
        execFileSyncFn: options.execFileSyncFn,
        existsSyncFn: options.existsSyncFn,
        sleep,
      })
    } catch (error) {
      // An exception in one round must not end the watch: the next round may
      // well be the one that matters.
      log('round failed: ' + errorText(error))
    }
    rounds += 1
    if (rounds >= limit) break
    await sleep(interval)
  }
  return { ok: true, rounds, reason: 'the sentry stopped after ' + rounds + ' round(s)' }
}

/**
 * The status of the sentry, as `--status` prints it.
 *
 * @param {{ config: object, paths: object, now?: () => number, countProcessesFn?: Function, execFileSyncFn?: Function }} options
 * @returns {object}
 */
export function sentryStatus(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const paths = options.paths && typeof options.paths === 'object' ? options.paths : sentryPaths(String(config.stateDir ?? ''))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const count = typeof options.countProcessesFn === 'function' ? options.countProcessesFn : countProcesses
  const imageName = typeof config.appImageName === 'string' && config.appImageName !== ''
    ? config.appImageName
    : DEFAULT_IMAGE_NAME
  const counted = count(imageName)
  const lock = readJsonFile(paths.lock)
  const lockPid = lock && Number.isFinite(Number(lock.pid)) ? Number(lock.pid) : null
  let lastLogLine = ''
  try {
    const lines = readTextFile(paths.log).text.split(/\r?\n/).filter((line) => line.trim() !== '')
    lastLogLine = lines.length > 0 ? lines[lines.length - 1] : ''
  } catch {
    lastLogLine = ''
  }
  const cleanExit = readCleanExit(paths.cleanExit)
  return {
    at: now(),
    configPath: typeof paths.config === 'string' ? paths.config : '',
    running: lockPid !== null && isProcessAlive(lockPid),
    lockPid,
    processCount: Number.isFinite(Number(counted.count)) ? Number(counted.count) : null,
    cleanExitAt: cleanExit && Number.isFinite(Number(cleanExit.at)) ? Number(cleanExit.at) : null,
    lastRescue: readJsonFile(paths.report),
    lastLogLine,
    state: readState(paths.state),
    restartInFlight: readRestartInFlight({ stateDir: String(config.stateDir ?? ''), now: now() }),
    config,
  }
}

/**
 * The entry point.
 *
 * `--once` and `--status` ALWAYS exit 0: the verdict is in the JSON, and a
 * non-zero exit would make the drill (and any caller) read "the tool broke"
 * where the answer is "there was nothing to do".
 *
 * @param {string[]} [argv]
 * @param {{ print?: (line: string) => void, printError?: (line: string) => void }} [io]
 * @returns {Promise<{ code: number, result: object|null }>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const print = typeof io.print === 'function' ? io.print : (line) => console.log(line)
  const printError = typeof io.printError === 'function' ? io.printError : (line) => console.error(line)
  const args = parseArgs(argv)
  if (args.help) {
    print('usage: node sentry.js --config <sentry.json> [--once] [--status]')
    return { code: 0, result: null }
  }
  if (!args.configPath) {
    printError('the sentry needs --config <sentry.json>')
    return { code: args.once || args.status ? 0 : 2, result: null }
  }
  const read = readConfig(args.configPath)
  if (read.ok !== true) {
    const failure = { ok: false, error: String(read.error), configPath: args.configPath }
    if (args.once || args.status) print(JSON.stringify(failure, null, 2))
    else printError('the sentry configuration could not be read: ' + String(read.error))
    return { code: args.once || args.status ? 0 : 2, result: failure }
  }
  const config = read.config
  const stateDir = typeof config.stateDir === 'string' && config.stateDir !== ''
    ? config.stateDir
    : path.dirname(path.dirname(String(args.configPath)))
  const paths = sentryPaths(stateDir)
  const log = (line) => {
    appendLog(paths.log, line)
    if (args.once !== true && args.status !== true) print(line)
  }

  if (args.status) {
    const status = sentryStatus({ config: { ...config, stateDir }, paths })
    print(JSON.stringify(status, null, 2))
    return { code: 0, result: status }
  }

  if (args.once) {
    const state = readState(paths.state)
    const round = await runRound({
      config: { ...config, stateDir },
      paths,
      state,
      stateStore: { read: () => state, write: (next) => writeState(paths.state, next) },
      log,
    })
    print(JSON.stringify(round, null, 2))
    return { code: 0, result: round }
  }

  const lock = acquireLock(paths.lock)
  if (lock.ok !== true) {
    log('another sentry holds the lock: ' + String(lock.error))
    printError('another sentry is already running: ' + String(lock.error))
    return { code: 0, result: { ok: false, reason: String(lock.error) } }
  }
  if (lock.stale === true) log('the lock of a dead sentry was taken over')
  log('the sentry is up (pid ' + process.pid + ', interval ' + String(config.intervalMs) + 'ms)')
  const stop = () => {
    log('the sentry is asked to stop')
    releaseLock(paths.lock)
    process.exit(0)
  }
  try {
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch {
    /* a platform without signals */
  }
  try {
    return { code: 0, result: await runSentry({ config: { ...config, stateDir }, paths, log, rounds: Infinity }) }
  } catch (error) {
    // Even a broken loop is written down instead of thrown away.
    log('the loop failed: ' + errorText(error))
    return { code: 1, result: { ok: false, reason: errorText(error) } }
  } finally {
    releaseLock(paths.lock)
  }
}

// This file is a script AND a module: the tests import the pure pieces, the
// scheduler runs it.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    return path.resolve(entry) === path.resolve(decodeURIComponent(self))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  // `--once` must ALWAYS exit 0: the verdict is in the JSON, and a non-zero
  // exit would turn "there was nothing to do" into "the tool broke".
  void main().then(
    (answer) => {
      process.exitCode = typeof answer.code === 'number' ? answer.code : 0
    },
    (error) => {
      console.error(String(error && error.message ? error.message : error))
      process.exitCode = 0
    },
  )
}
