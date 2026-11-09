/**
 * dsh-autorestart — remove the backup leftovers of an older build.
 *
 * WHY THIS FILE EXISTS (2026-11-06):
 *
 * Older builds left directories under the backups root that carry no
 * `manifest.json`: a copy that never finished. On the real machine there were
 * 105 of them (23 966 MB), and every restart tried to delete them again.
 *
 * The plugin asks the user ONCE — a card with two answers: "delete them" or
 * "I will handle them myself". This script is the second answer: the user who
 * chose to handle it themselves runs this, sees the numbers first, and then
 * decides.
 *
 * IT IS THE SAME CODE THE CARD USES (`cleanupShellBackups` in lib/backup.js), so
 * the numbers this script reports and the numbers the card shows can never
 * disagree. Only the directories WITHOUT a manifest are touched: a copy that
 * has one is a backup, and a backup is never removed here.
 *
 * RULES:
 *   - The ONLY argument is `--dry-run` (report the numbers, delete nothing).
 *     There is NO path argument on purpose: a script that deletes directories
 *     must not be pointed at an arbitrary directory.
 *   - The backups root is the plugin's own state directory, never a path the
 *     user types.
 *   - The read-only attribute comes off before the delete (a tree that holds a
 *     read-only file used to stop the delete half way through), and every
 *     directory that will not go is NAMED with its reason.
 *   - Pure ASCII, no byte order mark (see test/scripts-encoding.test.mjs).
 */

import os from 'node:os'
import path from 'node:path'

import { cleanupShellBackups } from '../lib/backup.js'

/** Where the plugin's state lives when nothing says otherwise. */
const LOG_DIR = path.join(os.homedir(), '.dsh', 'storages', 'dsh-autorestart')

/** The one argument this script understands. */
export const DRY_RUN_FLAG = '--dry-run'

/** The usage line — also what an unknown argument answers with. */
export const USAGE = [
  'usage: node scripts/cleanup-shell-backups.mjs [--dry-run]',
  '',
  '  --dry-run   report how many leftover directories there are, delete nothing',
  '',
  'The leftovers are the directories under the backups root that carry no',
  'manifest.json. A copy that has one is a backup and is never touched here.',
].join('\n')

/**
 * Whether this process is a DRILL (or test) run.
 *
 * `DSH_AUTORESTART_DRILL` is the switch that unlocks the state-directory
 * override below. It is honoured ONLY as the exact value `1`, compared after
 * `trim()`: `0`, `true`, `yes`, an empty string and an unset variable all mean
 * "not a drill". Nothing else is accepted, so ` 1 ` works but `true` does not.
 *
 * @returns {boolean}
 */
export function drillEnabled() {
  const value = typeof process.env.DSH_AUTORESTART_DRILL === 'string'
    ? process.env.DSH_AUTORESTART_DRILL.trim()
    : ''
  return value === '1'
}

/**
 * The state directory this run belongs to.
 *
 * DRILL/TEST-ONLY GATE: `DSH_AUTORESTART_STATE_DIR` is NOT a general-purpose
 * redirect of the backups root (this script DELETES directories, so a value
 * that could be set by any same-user process would be a way to point the delete
 * at a tree of its choosing). It is honoured only while
 * `DSH_AUTORESTART_DRILL=1` is set in the same environment - a drill or a test.
 * Without that switch the run always lands in the plugin's own state directory.
 *
 * @returns {string}
 */
export function stateDirOf() {
  if (drillEnabled() !== true) return LOG_DIR
  const override = typeof process.env.DSH_AUTORESTART_STATE_DIR === 'string'
    ? process.env.DSH_AUTORESTART_STATE_DIR.trim()
    : ''
  return override === '' ? LOG_DIR : override
}

/**
 * The backups root of that state directory.
 *
 * @param {string} [stateDir]
 * @returns {string}
 */
export function backupsDirOf(stateDir = stateDirOf()) {
  return path.join(String(stateDir ?? ''), 'backups')
}

/**
 * A SIZE, WITH THE UNIT THAT FITS IT — gigabytes included, because the
 * leftovers of an old build are measured in gigabytes.
 *
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  if (value < 1024) return Math.round(value) + ' B'
  if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
  if (value < 1024 * 1024 * 1024) return String(Math.round((value / (1024 * 1024)) * 10) / 10) + ' MB'
  return String(Math.round((value / (1024 * 1024 * 1024)) * 10) / 10) + ' GB'
}

/**
 * THE ARGUMENTS — and only one of them.
 *
 * There is NO path argument on purpose: this script deletes directories, and a
 * script that deletes directories must not be pointed at an arbitrary one.
 *
 * @param {string[]} argv
 * @returns {{ ok: boolean, dryRun: boolean, error: string|null }}
 */
export function parseArgs(argv) {
  let dryRun = false
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (arg === DRY_RUN_FLAG) {
      dryRun = true
      continue
    }
    return {
      ok: false,
      dryRun: false,
      error: 'unknown argument: ' + String(arg) + ' (the only argument is ' + DRY_RUN_FLAG + ')',
    }
  }
  return { ok: true, dryRun, error: null }
}

/**
 * The whole job: count the leftovers, report them, and (unless this is a dry
 * run) delete them.
 *
 * @param {{ dryRun?: boolean, stateDir?: string, log?: (line: string) => void }} [options]
 * @returns {{
 *   ok: boolean, dryRun: boolean, count: number, bytes: number,
 *   removed: string[], failures: Array<{ name: string, error: string }>,
 *   freedBytes: number, reason: string,
 * }}
 */
export function run(options = {}) {
  const dryRun = options.dryRun === true
  const log = typeof options.log === 'function' ? options.log : () => {}
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : stateDirOf()
  const backupsDir = backupsDirOf(stateDir)
  const result = cleanupShellBackups(backupsDir, { dryRun })
  const failures = (Array.isArray(result.failures) ? result.failures : [])
    .map((entry) => ({
      name: entry && entry.name ? String(entry.name) : '',
      error: entry && entry.error ? String(entry.error) : 'unknown error',
    }))
  const reason = failures.length > 0
    ? failures.length + ' directories could not be removed: '
      + failures.map((entry) => entry.name + ' (' + entry.error + ')').join(', ')
    : ''
  log('leftovers: ' + result.count + ' directories, ' + formatSize(result.bytes))
  if (dryRun === true) {
    log('dry run: nothing was deleted (' + result.removed.length + ' directories would go)')
  } else {
    log('removed ' + result.removed.length + ' directories, freed ' + formatSize(result.freedBytes))
  }
  if (reason !== '') log(reason)
  return {
    ok: failures.length === 0,
    dryRun,
    count: result.count,
    bytes: result.bytes,
    removed: result.removed,
    failures,
    freedBytes: result.freedBytes,
    reason,
  }
}

// The file is a script AND a module: the tests import the pieces above, the
// user runs it. Only a direct run does the work.
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
  const args = parseArgs(process.argv.slice(2))
  if (args.ok !== true) {
    process.stderr.write(String(args.error) + '\n\n' + USAGE + '\n')
    process.exit(1)
  }
  const result = run({ dryRun: args.dryRun, log: (line) => process.stdout.write(line + '\n') })
  // A directory that would not go is reported, and the run still ends 0: the
  // leftovers are not the user's fault and a failed cleanup must not look like
  // a broken script.
  process.exit(0)
}
