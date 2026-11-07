/**
 * THE LEFTOVERS OF 0.8.6 (2026-11-03).
 *
 * WHY THIS EXISTS: 0.9.0 removed the watchdog. A machine that upgraded from
 * 0.8.6 still carries what the watchdog left behind - one one-off scheduled
 * task on Windows (a systemd user unit on Linux) that points at the DELETED
 * `scripts/watchdog.mjs`, plus a few state files. The 0.9.0 code does not know
 * them, so on its own they would stay on the machine for ever: a task that
 * fires and finds nothing, and files nobody reads.
 *
 * So the plugin cleans them up ONCE, at startup, where the state directory is
 * known and before anything else touches it.
 *
 * TWO RULES THIS MODULE FOLLOWS:
 *
 *   1. IT NEVER THROWS. A cleanup that breaks the boot is worse than a
 *      leftover file. Every failure is reported in `error` and the work goes
 *      on.
 *   2. IT ONLY REMOVES WHAT IT KNOWS. The five file names below and the one
 *      task name are the whole list; nothing else is touched.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The state files the watchdog of 0.8.6 wrote into the state directory.
 * They are removed when they are there, and skipped when they are not.
 */
export const LEGACY_WATCHDOG_FILES = Object.freeze([
  'watchdog-pending.json',
  'watchdog-ready.json',
  'watchdog-disarm.json',
  'last-watchdog-report.json',
  'watchdog.pid',
])

/**
 * The name of the one-off scheduled task (Windows) and of the systemd user
 * unit (Linux, where the unit carries the `.service` suffix).
 */
export const LEGACY_WATCHDOG_TASK = 'dsh-autorestart-watchdog'

/** The systemd unit of the watchdog, as `systemctl --user` knows it. */
export const LEGACY_WATCHDOG_UNIT = `${LEGACY_WATCHDOG_TASK}.service`

/**
 * THE PROGRAMS THIS MODULE MAY RUN — and nothing else (2026-11-06).
 *
 * WHY THE NAME IS NOT THE CALLER'S WORD: the old `defaultExec(file, args)`
 * handed the caller's string straight to `execFileSync`, so whoever reached
 * this function decided what got executed. The static scan named that a
 * blocker ("the program name is chosen by an outside value"), and it was
 * right — a function that runs whatever it is told is a function that runs
 * whatever anyone can reach it with.
 *
 * Now the caller's word only SELECTS one of the programs below, and the
 * program that is finally executed is written out as a literal at the call
 * site. A name that is not in this map is REFUSED, not run.
 *
 * The map is frozen: nothing can add a program to it.
 */
const EXEC_PROGRAMS = Object.freeze({
  /** The Windows tool that owns the scheduled task. */
  schtasks: 'schtasks',
  /** The same tool under its file name — both spellings mean the same program. */
  'schtasks.exe': 'schtasks',
  /** The systemd tool that owns the user unit (Linux). */
  systemctl: 'systemctl',
})

/**
 * Run one of the known commands and report what happened (never throws).
 *
 * @param {string} file the name of a program in `EXEC_PROGRAMS` — nothing else runs
 * @param {string[]} args
 * @returns {{ ok: boolean, error: string|null }}
 */
function defaultExec(file, args) {
  const name = typeof file === 'string' ? file.trim().toLowerCase() : ''
  const program = EXEC_PROGRAMS[name]
  if (program === undefined) {
    // A NAME THAT IS NOT IN THE MAP IS NOT RUN — it is reported.
    return { ok: false, error: 'refusing to run an unknown program: ' + String(file) }
  }
  const options = {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    timeout: 20000,
  }
  try {
    // THE PROGRAM NAME IS A LITERAL HERE. The caller's word chose WHICH of the
    // two programs runs; it never became the program name.
    if (program === 'schtasks') {
      execFileSync('schtasks', args, options)
    } else {
      execFileSync('systemctl', args, options)
    }
    return { ok: true, error: null }
  } catch (error) {
    const text = error && typeof error.message === 'string' && error.message !== ''
      ? error.message
      : String(error)
    return { ok: false, error: text }
  }
}

/** The text of any thrown value, for the `error` field. */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message !== '') return value.message
  return String(value)
}

/**
 * Remove what the watchdog of 0.8.6 left behind.
 *
 * @param {{
 *   stateDir?: string,
 *   platform?: string,
 *   exec?: (file: string, args: string[]) => { ok?: boolean, error?: string|null },
 *   fs?: { existsSync?: Function, rmSync?: Function },
 * }} [options]
 * @returns {{ removedFiles: string[], removedUnits: string[], error: string|null }}
 */
export function cleanupLegacyWatchdogArtifacts({
  stateDir = '',
  platform = process.platform,
  exec = defaultExec,
  fs: fsImpl = fs,
} = {}) {
  const removedFiles = []
  const removedUnits = []
  let error = null

  const note = (text) => {
    if (error === null) error = text
  }

  // --- the state files: only the ones that are there ---
  const dir = typeof stateDir === 'string' ? stateDir : ''
  if (dir !== '') {
    for (const name of LEGACY_WATCHDOG_FILES) {
      const file = path.join(dir, name)
      try {
        const exists = typeof fsImpl.existsSync === 'function' ? fsImpl.existsSync(file) : false
        if (exists !== true) continue
        if (typeof fsImpl.rmSync !== 'function') {
          note('no way to remove ' + file)
          continue
        }
        fsImpl.rmSync(file, { force: true })
        removedFiles.push(name)
      } catch (failure) {
        note('could not remove ' + file + ': ' + errorText(failure))
      }
    }
  }

  // --- the scheduling item ---
  try {
    if (platform === 'win32') {
      const answer = exec('schtasks', ['/Delete', '/TN', LEGACY_WATCHDOG_TASK, '/F'])
      if (answer && answer.ok === true) removedUnits.push(LEGACY_WATCHDOG_TASK)
      else note('the scheduled task ' + LEGACY_WATCHDOG_TASK + ' could not be removed: ' + ((answer && answer.error) || 'unknown error'))
    } else {
      const stop = exec('systemctl', ['--user', 'stop', LEGACY_WATCHDOG_UNIT])
      if (stop && stop.ok === true) {
        const reset = exec('systemctl', ['--user', 'reset-failed', LEGACY_WATCHDOG_UNIT])
        if (reset && reset.ok === true) removedUnits.push(LEGACY_WATCHDOG_TASK)
        else note('the unit ' + LEGACY_WATCHDOG_UNIT + ' could not be reset: ' + ((reset && reset.error) || 'unknown error'))
      } else {
        note('the unit ' + LEGACY_WATCHDOG_UNIT + ' could not be stopped: ' + ((stop && stop.error) || 'unknown error'))
      }
    }
  } catch (failure) {
    note('the scheduling item could not be cleaned: ' + errorText(failure))
  }

  return { removedFiles, removedUnits, error }
}
