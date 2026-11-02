/**
 * dsh-autorestart - the SENTRY: the pure logic of the night watchman that
 * lives OUTSIDE the plugin.
 *
 * WHY IT EXISTS. On 2026-10-30 the desktop client ended up in a state nobody
 * could recover from by using DSH itself:
 *
 *   - 0 processes (the app was not running any more);
 *   - the official `sanitizeProfile` had emptied the profile: `dsh.profile.bundles`
 *     gone, `cordis.patch.yml` reduced to `[]`;
 *   - the plugin itself had been removed with the rest of the profile, so no
 *     plugin code was left to bring anything back.
 *
 * The supervisor (`supervisor/supervisor.js`) cannot help there: it is started
 * by the host, so it dies with the host. The sentry is the missing rung: a
 * standalone Node process, started at login by the system, that is NOT part of
 * the plugin tree and NOT part of the profile.
 *
 * THREE PROMISES (the user's three answers):
 *
 *   1. **It came back crashed -> make it come back.** A process count of 0 for
 *      longer than the grace period is a crash.
 *   2. **The settings were emptied -> put the last good state back.** Before
 *      starting anything, the profile is inspected; a profile that was reduced
 *      to an empty shell is restored from the newest snapshot.
 *   3. **The user closed it on purpose -> NEVER bounce it back.** The plugin
 *      writes `clean-exit.json` when it is asked to quit; a clean exit that is
 *      newer than the last time the host was seen alive stands the sentry down.
 *
 * WHY THE LOGIC LIVES HERE AND NOT IN THE DAEMON. `supervisor/sentry.js` is
 * copied to `<stateDir>/sentry/sentry.js` and may therefore import NOTHING
 * from the plugin (a wiped profile or a rolled-back plugin tree would take the
 * daemon with it). Everything that can be duplicated safely is duplicated
 * there; everything that must be TESTED lives here, with every judge taking
 * its inputs (now, processCount, ...) as arguments, so a test never needs a
 * clock, a process table or a real profile.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs'
import path from 'node:path'

/** The name of the autostart record the installer registers. */
export const SENTRY_TASK_NAME = 'dsh-autorestart-sentry'

/** The directory (inside the state dir) the sentry lives in. */
export const SENTRY_DIR_NAME = 'sentry'

/** The directory (inside the sentry dir) that holds the copied scripts. */
export const KIT_DIR_NAME = 'kit'

/** The configuration of the sentry. */
export const SENTRY_CONFIG_NAME = 'sentry.json'

/** The single-instance lock of the sentry. */
export const SENTRY_LOCK_NAME = 'sentry.lock'

/** The log of the sentry. */
export const SENTRY_LOG_NAME = 'sentry.log'

/** The report of the last rescue. */
export const SENTRY_REPORT_NAME = 'last-rescue.json'

/** The marker the plugin writes when the user closed DSH on purpose. */
export const SENTRY_CLEAN_EXIT_NAME = 'clean-exit.json'

/** The runtime, as it is called inside the sentry directory. */
export const SENTRY_SCRIPT_NAME = 'sentry.js'

/** The `.cmd` the startup folder gets when the scheduled task is refused. */
export const SENTRY_STARTUP_CMD_NAME = 'dsh-autorestart-sentry.cmd'

/** The to-do list of an installation that had to be rolled back. */
export const SENTRY_PENDING_CLEANUP_NAME = 'sentry-pending-cleanup.json'

/** The version of the sentry configuration this module writes. */
export const SENTRY_CONFIG_VERSION = 1

/** The cookie cleanup of the kit (copied from `scripts/`). */
export const KIT_CLEAR_COOKIES_NAME = 'clear-dsh-auth-cookies.mjs'

/** The profile restore of the kit (copied from `scripts/`). */
export const KIT_RESTORE_SCRIPT_NAME = 'restore-profile.ps1'

/** The Chinese wording of the restore script (copied from `scripts/`). */
export const KIT_RESTORE_STRINGS_NAME = 'rescue-strings.zh.json'

/** The image name of the desktop client, when nothing else is known. */
export const DEFAULT_IMAGE_NAME = 'DeepSeek Harness.exe'

/** The health route of the plugin. */
export const HEALTH_PATH = '/__dsh_autorestart/health'

/** How often the sentry looks at the process table. */
export const DEFAULT_INTERVAL_MS = 30000

/** How long the host may be gone before it counts as a crash. */
export const DEFAULT_GRACE_MS = 90000

/** How long a started host gets to answer before the rescue is a failure. */
export const DEFAULT_START_TIMEOUT_MS = 90000

/** How many starts one burst of downtime may produce. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** How many rescues one hour may produce. */
export const DEFAULT_MAX_RESCUES_PER_HOUR = 3

/** The window of the rescue budget. */
export const DEFAULT_RESCUE_WINDOW_MS = 3600000

/** The first wait of the backoff between two starts. */
export const DEFAULT_BACKOFF_BASE_MS = 5000

/** The cap of that backoff. */
export const DEFAULT_BACKOFF_MAX_MS = 120000

/**
 * How much earlier than "the host was last seen alive" a clean exit may be
 * written and still count as "the user meant it".
 *
 * The plugin writes the marker while it shuts down, so it is a moment EARLIER
 * than the last moment the host looked alive to the sentry, never later.
 */
export const CLEAN_EXIT_SLACK_MS = 5000

/** The log grows to this size before it is rotated away. */
export const MAX_LOG_BYTES = 1024 * 1024

/** The marker the plugin writes when a restart is being watched. */
export const WATCHDOG_PENDING_NAME = 'watchdog-pending.json'

/** The durable record of one restart (`result: 'pending'` = in flight). */
export const RESTART_VERDICT_NAME = 'last-restart-verdict.json'

/** How long a "a restart is in flight" marker is believed. */
export const DEFAULT_PENDING_WINDOW_MS = 600000

/** The fields of the rescue report. They are frozen: later work may not rename them. */
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
 * `Number(null)` is 0 and `Number('')` is 0 - which would silently turn "this
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
 * Windows PowerShell 5.1 writes UTF-8 WITH a BOM, and `JSON.parse` chokes on
 * it - a marker written by a script would be unreadable here otherwise.
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
 * Every path the sentry uses inside the state directory.
 *
 * The state directory is `%USERPROFILE%\.dsh\storages\dsh-autorestart`: it
 * lives OUTSIDE the profile, which is the whole point (the official cleanup
 * only touches the profile).
 *
 * @param {string} stateDir
 * @returns {{
 *   dir: string, config: string, lock: string, log: string, report: string,
 *   cleanExit: string, runtime: string, kit: string, clearCookiesScript: string,
 *   restoreScript: string, restoreStrings: string, startupCmd: string,
 *   pendingCleanup: string,
 * }}
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
    runtime: path.join(dir, SENTRY_SCRIPT_NAME),
    kit,
    clearCookiesScript: path.join(kit, KIT_CLEAR_COOKIES_NAME),
    restoreScript: path.join(kit, KIT_RESTORE_SCRIPT_NAME),
    restoreStrings: path.join(kit, KIT_RESTORE_STRINGS_NAME),
    // The `.cmd` this plugin can hand to the startup folder. It is WRITTEN
    // here first and then copied, so an uninstall always knows what to remove
    // even when the startup folder is not readable.
    startupCmd: path.join(dir, SENTRY_STARTUP_CMD_NAME),
    // The to-do list of a rolled-back installation. It lives NEXT TO the
    // sentry directory, so writing it cannot bring that directory back.
    pendingCleanup: path.join(root, SENTRY_PENDING_CLEANUP_NAME),
  }
}

/**
 * The configuration of the sentry.
 *
 * Every timer is spelled out so the numbers are visible in the file instead of
 * being buried in the daemon: an operator can raise `graceMs` without reading
 * any code.
 *
 * @param {{
 *   appExecPath?: string, appImageName?: string, profileDir?: string,
 *   stateDir?: string, nodePath?: string, portFile?: string,
 *   intervalMs?: number, graceMs?: number, startTimeoutMs?: number,
 *   maxAttempts?: number, maxRescuesPerHour?: number, rescueWindowMs?: number,
 *   healthPath?: string, now?: number,
 * }} [options]
 * @returns {object}
 */
export function buildSentryConfig(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const appExecPath = String(options.appExecPath ?? '')
  const appImageName = typeof options.appImageName === 'string' && options.appImageName !== ''
    ? options.appImageName
    : path.basename(appExecPath)
  return {
    version: SENTRY_CONFIG_VERSION,
    installedAt: new Date(now).toISOString(),
    appExecPath,
    appImageName,
    profileDir: String(options.profileDir ?? ''),
    stateDir: String(options.stateDir ?? ''),
    nodePath: String(options.nodePath ?? ''),
    intervalMs: positiveNumber(options.intervalMs, DEFAULT_INTERVAL_MS),
    graceMs: positiveNumber(options.graceMs, DEFAULT_GRACE_MS),
    startTimeoutMs: positiveNumber(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
    maxAttempts: positiveNumber(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    maxRescuesPerHour: positiveNumber(options.maxRescuesPerHour, DEFAULT_MAX_RESCUES_PER_HOUR),
    rescueWindowMs: positiveNumber(options.rescueWindowMs, DEFAULT_RESCUE_WINDOW_MS),
    healthPath: typeof options.healthPath === 'string' && options.healthPath.startsWith('/')
      ? options.healthPath
      : HEALTH_PATH,
    portFile: String(options.portFile ?? ''),
  }
}

/**
 * Read the configuration of the sentry (never throws).
 *
 * @param {string} configPath
 * @returns {{ ok: boolean, config: object|null, error: string|null }}
 */
export function readConfig(configPath) {
  const file = typeof configPath === 'string' ? configPath.trim() : ''
  if (file === '') return { ok: false, config: null, error: 'readConfig requires a path' }
  const read = readTextFile(file)
  if (read.ok !== true) return { ok: false, config: null, error: read.error }
  try {
    const parsed = JSON.parse(read.text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, config: null, error: 'the configuration is not an object' }
    }
    return { ok: true, config: parsed, error: null }
  } catch (error) {
    return { ok: false, config: null, error: 'the configuration cannot be parsed: ' + errorText(error) }
  }
}

/**
 * Write a JSON file atomically: a `.tmp` file is written and then renamed.
 *
 * A sentry that dies halfway through a write must never leave a truncated
 * `sentry.json` behind - the next start would refuse to run at all.
 *
 * @param {string} file
 * @param {object} value
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeJsonFile(file, value) {
  const target = typeof file === 'string' ? file.trim() : ''
  if (target === '') return { ok: false, path: '', error: 'writeJsonFile requires a path' }
  if (!value || typeof value !== 'object') {
    return { ok: false, path: target, error: 'writeJsonFile requires an object' }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = target + '.tmp'
    // No byte order mark: every reader of this file is JSON.parse.
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
    fs.renameSync(temporary, target)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return { ok: false, path: target, error: errorText(error) }
  }
}

/**
 * Write the configuration of the sentry.
 *
 * @param {string} configPath
 * @param {object} config
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeConfig(configPath, config) {
  return writeJsonFile(configPath, config)
}

/**
 * Split ONE line of `tasklist /FO CSV` into its cells.
 *
 * The cells are quoted and may hold commas (`"123,456 K"`), and a quote inside
 * a quoted cell is doubled - so `split(',')` is not an option.
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
 * TWO TRAPS this has to survive:
 *
 *   1. `tasklist` answers "no such process" with a SENTENCE, not with an empty
 *      table: `INFO: No tasks are running which match the specified criteria.`
 *      (localised on a Chinese Windows). A line that does not start with a
 *      quote is not a row, and it MUST not be counted as one.
 *   2. a cell may hold a comma (`"123,456 K"`), so the line is tokenised with
 *      quote awareness.
 *
 * @param {string} text the raw output of tasklist
 * @param {string} [imageName] only this image name counts (empty: any row)
 * @returns {{ count: number, pids: number[] }}
 */
export function parseTasklistOutput(text, imageName = '') {
  const raw = typeof text === 'string' ? text : ''
  const wanted = String(imageName ?? '').trim().toLowerCase()
  const pids = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    // The INFO sentence, a blank line and the header (unquoted in /NH output)
    // are not rows. Every real row of /FO CSV starts with a quote.
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
 * The bundles a profile package.json lists (`dsh.profile.bundles`).
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
 * An emptied patch is `[]`, or nothing but whitespace. A comment-only file is
 * still "nothing": the official cleanup writes `[]`, and that is the shape
 * this has to recognise.
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
 * THE THREE SHAPES seen on 2026-10-30, in the order they are checked:
 *
 *   1. the current `package.json` is missing or unparsable (the app cannot
 *      even know which plugins it wanted);
 *   2. `dsh.profile.bundles` is empty while the backup still lists some;
 *   3. `cordis.patch.yml` holds nothing (`[]`) while the backup still has a
 *      patch.
 *
 * All four texts are injected: this function never touches the disk.
 *
 * @param {{
 *   currentPackageText?: string, backupPackageText?: string,
 *   currentPatchText?: string, backupPatchText?: string,
 * }} [input]
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
 * THE DECISION: may the sentry start the host, and if not, why not?
 *
 * The order is FIXED and must stay fixed - every rule protects the one after
 * it, and a rule that is checked too late has already started a second host:
 *
 *   1. the host is running                          -> idle
 *   2. nobody knows since when it is gone           -> wait
 *   3. it has not been gone long enough             -> wait
 *   4. the user closed it on purpose                -> stand-down-intentional
 *   5. a restart of the plugin is in flight         -> stand-down-restart-in-flight
 *   6. the hourly budget of rescues is spent        -> stand-down-budget
 *   7. this burst has already started it enough     -> give-up
 *   8. otherwise                                    -> rescue
 *
 * The caller must NOT call this with an unknown process count: a count that
 * could not be read is not a count of 0, and starting a second host next to a
 * running one is the one accident this watchman must never cause.
 *
 * @param {{
 *   now?: number, processCount?: number, downSince?: number|null,
 *   lastSeenRunningAt?: number|null, graceMs?: number,
 *   cleanExitAt?: number|null, watchdogPending?: boolean,
 *   attemptsInWindow?: number, maxRescuesPerHour?: number,
 *   attemptsThisBurst?: number, maxAttempts?: number,
 * }} [input]
 * @returns {{ action: string, reason: string }}
 */
export function decideRescue(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : 0
  const graceMs = positiveNumber(input.graceMs, DEFAULT_GRACE_MS)
  const maxRescues = positiveNumber(input.maxRescuesPerHour, DEFAULT_MAX_RESCUES_PER_HOUR)
  const maxAttempts = positiveNumber(input.maxAttempts, DEFAULT_MAX_ATTEMPTS)

  // (1) It is running. Any rescue now would be a second copy of the client.
  if (Number(input.processCount) > 0) {
    return { action: 'idle', reason: 'the host is running (' + Number(input.processCount) + ' process(es))' }
  }

  // (2) The first round that sees it gone only records WHEN it went away.
  const downSince = numberOrNull(input.downSince)
  if (downSince === null) {
    return { action: 'wait', reason: 'the host is gone; the moment it went away is recorded first' }
  }

  // (3) The grace period: a client that is restarting itself by design, or a
  // login that has not finished, is not a crash.
  if (now - downSince < graceMs) {
    return {
      action: 'wait',
      reason: 'the host has been gone for ' + Math.max(0, Math.trunc(now - downSince)) + 'ms, the grace period is ' + graceMs + 'ms',
    }
  }

  // (4) THE USER'S OWN DECISION. The plugin writes the clean-exit marker while
  // it shuts down, so the marker is a moment EARLIER than the last moment the
  // sentry saw the host alive - hence the slack. A user who closes DSH must
  // not be scolded by a window that comes back on its own.
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

  // (5) A restart that the plugin itself is watching: starting the host here
  // as well would race the supervisor / the watchdog.
  if (input.watchdogPending === true) {
    return { action: 'stand-down-restart-in-flight', reason: 'a restart is in flight and somebody else is watching it' }
  }

  // (6) The hourly budget: a host that crashes in a loop must not become a
  // spawn loop.
  const inWindow = Number.isFinite(Number(input.attemptsInWindow)) ? Math.trunc(Number(input.attemptsInWindow)) : 0
  if (inWindow >= maxRescues) {
    return {
      action: 'stand-down-budget',
      reason: inWindow + ' rescue(s) already happened in the budget window of ' + maxRescues,
    }
  }

  // (7) This burst is over: the host was started and did not stay up.
  const burst = Number.isFinite(Number(input.attemptsThisBurst)) ? Math.trunc(Number(input.attemptsThisBurst)) : 0
  if (burst >= maxAttempts) {
    return {
      action: 'give-up',
      reason: 'the host was started ' + burst + ' time(s) in this burst and does not stay up (limit ' + maxAttempts + ')',
    }
  }

  // (8) Last chance to be useful.
  return { action: 'rescue', reason: 'the host is gone and no rule stands the sentry down' }
}

/**
 * The wait before the next start of a burst.
 *
 * The delay DOUBLES with the attempt number and is capped: a host that cannot
 * start must not be hammered.
 *
 * @param {number} attempt the number of the attempt that is about to happen (1 = first)
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
 * Read the clean-exit marker the plugin writes.
 *
 * @param {string} file
 * @returns {{ ok: boolean, cleanExit: object|null, error: string|null }}
 */
export function readCleanExit(file) {
  const read = readTextFile(file)
  if (read.ok !== true) return { ok: false, cleanExit: null, error: read.error }
  try {
    const parsed = JSON.parse(read.text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, cleanExit: null, error: 'the clean-exit marker is not an object' }
    }
    return { ok: true, cleanExit: parsed, error: null }
  } catch (error) {
    return { ok: false, cleanExit: null, error: 'the clean-exit marker cannot be parsed: ' + errorText(error) }
  }
}

/**
 * Write the clean-exit marker (the plugin's job; the daemon only reads it).
 *
 * @param {string} file
 * @param {{ at?: number, reason?: string, by?: string }} [payload]
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeCleanExit(file, payload = {}) {
  const at = Number.isFinite(Number(payload.at)) ? Number(payload.at) : Date.now()
  return writeJsonFile(file, {
    at,
    atIso: new Date(at).toISOString(),
    reason: typeof payload.reason === 'string' ? payload.reason : 'requested-by-user',
    by: typeof payload.by === 'string' ? payload.by : 'dsh-autorestart',
  })
}

/**
 * The rescue report, with the fields frozen for ever.
 *
 * @param {{
 *   at?: number, action?: string, reason?: string, cleared?: object|null,
 *   restored?: object|null, launched?: object|null, ready?: boolean,
 *   errors?: string[], durationMs?: number,
 * }} [input]
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
 * Read the report of the last rescue.
 *
 * @param {string} file
 * @returns {{ ok: boolean, report: object|null, error: string|null }}
 */
export function readReport(file) {
  const read = readTextFile(file)
  if (read.ok !== true) return { ok: false, report: null, error: read.error }
  try {
    const parsed = JSON.parse(read.text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, report: null, error: 'the report is not an object' }
    }
    return { ok: true, report: parsed, error: null }
  } catch (error) {
    return { ok: false, report: null, error: 'the report cannot be parsed: ' + errorText(error) }
  }
}

/**
 * Write the report of the last rescue.
 *
 * @param {string} file
 * @param {object} report
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeReport(file, report) {
  const normalized = buildRescueReport(report && typeof report === 'object' ? report : {})
  return writeJsonFile(file, normalized)
}

/**
 * Append one line to the log, and rotate it when it grew too big.
 *
 * A log that cannot be written is never an error: the sentry must keep
 * watching even on a full disk.
 *
 * @param {string} logPath
 * @param {string} line
 * @returns {boolean} whether the line was written
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
 * Is this pid alive?
 *
 * EPERM means "it exists and belongs to somebody else" - still alive.
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
 * Is a restart of the plugin in flight?
 *
 * TWO markers are believed, both written by the plugin, and both only while
 * they are FRESH: a marker from an hour ago describes a restart that is over
 * (or was never finished), and it must not block the rescue for ever.
 *
 * @param {{
 *   stateDir?: string, now?: number, windowMs?: number,
 *   readJson?: (file: string) => object|null, statMs?: (file: string) => number|null,
 * }} [options]
 * @returns {{ pending: boolean, reason: string }}
 */
export function readRestartInFlight(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const windowMs = positiveNumber(options.windowMs, DEFAULT_PENDING_WINDOW_MS)
  if (stateDir === '') return { pending: false, reason: 'no state directory' }
  const readJson = typeof options.readJson === 'function'
    ? options.readJson
    : (file) => {
      const read = readTextFile(file)
      if (read.ok !== true) return null
      try {
        const parsed = JSON.parse(read.text)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }
  const statMs = typeof options.statMs === 'function'
    ? options.statMs
    : (file) => {
      try {
        const stat = fs.statSync(file)
        const stamp = Number(stat.mtimeMs)
        return Number.isFinite(stamp) ? stamp : null
      } catch {
        return null
      }
    }

  const pendingFile = path.join(stateDir, WATCHDOG_PENDING_NAME)
  const marker = readJson(pendingFile)
  if (marker !== null) {
    const written = Date.parse(typeof marker.at === 'string' ? marker.at : '')
    const at = Number.isFinite(written) ? written : statMs(pendingFile)
    if (at === null || now - at <= windowMs) {
      return { pending: true, reason: 'the watchdog pending marker is there (' + pendingFile + ')' }
    }
    return { pending: false, reason: 'the watchdog pending marker is stale' }
  }

  const verdict = readJson(path.join(stateDir, RESTART_VERDICT_NAME))
  if (verdict !== null && typeof verdict.result === 'string' && verdict.result === 'pending') {
    const started = Date.parse(typeof verdict.startedAt === 'string' ? verdict.startedAt : '')
    const at = Number.isFinite(started) ? started : null
    if (at === null || now - at <= windowMs) {
      return { pending: true, reason: 'the last restart verdict is still pending' }
    }
    return { pending: false, reason: 'the last restart verdict is stale' }
  }
  return { pending: false, reason: 'no restart is in flight' }
}
