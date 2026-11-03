/**
 * CLEAN UP WHAT 0.8.x's WATCHDOG LEFT BEHIND (0.9.0).
 *
 * 0.9.0 removed the watchdog and the rescue scripts. A machine that was armed by
 * 0.8.6 keeps three things that nothing reads any more:
 *
 *   1. a one-shot scheduled task (Windows) or a transient systemd unit (Linux)
 *      whose command line points at `scripts/watchdog.mjs` - a file this version
 *      no longer ships, so the task can only fail when it fires;
 *   2. `watchdog-pending.json`, the marker that told the old watchdog a restart
 *      was in flight;
 *   3. `watchdog-ready.json` / `watchdog-disarm.json` / `last-watchdog-report.json`,
 *      the state files the old flow wrote while it worked.
 *
 * None of that is dangerous, but a scheduled task that can only fail is noise a
 * user cannot explain, and the state files make the storage directory look like
 * the feature is still there. So the first boot of 0.9.0 removes them, once.
 *
 * It NEVER throws: a cleanup that fails must not keep the host from starting. Every
 * failure is reported in the returned `error` instead.
 */

import fsDefault from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** The state files the 0.8.x watchdog wrote and 0.9.0 does not read. */
export const LEGACY_WATCHDOG_FILES = Object.freeze([
  'watchdog-pending.json',
  'watchdog-ready.json',
  'watchdog-disarm.json',
  'last-watchdog-report.json',
  'watchdog.pid',
])

/** The one-shot unit / task name the 0.8.x watchdog registered. */
export const LEGACY_WATCHDOG_UNIT = 'dsh-autorestart-watchdog'

/** Run one command and never throw; `ok` says whether it exited 0. */
function runQuietly(exec, command, args) {
  try {
    const answer = exec(command, args)
    if (answer !== null && typeof answer === 'object') {
      return { ok: answer.status === 0 || answer.ok === true, error: null }
    }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/** The default runner: a real process, output discarded, never throws. */
function defaultExec(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', windowsHide: true })
}

/**
 * Remove the leftovers of the 0.8.x watchdog, once.
 *
 * @param {{
 *   stateDir?: string,
 *   platform?: string,
 *   exec?: (command: string, args: string[]) => object|null,
 *   fs?: object,
 * }} [options]
 * @returns {{ removedFiles: string[], removedUnits: string[], error: string|null }}
 */
export function sweepLegacyWatchdogArtifacts({
  stateDir = '',
  platform = process.platform,
  exec = defaultExec,
  fs = fsDefault,
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : ''
  const removedFiles = []
  const removedUnits = []
  const problems = []
  if (dir === '') {
    return { removedFiles, removedUnits, error: 'the state directory is unknown' }
  }
  for (const name of LEGACY_WATCHDOG_FILES) {
    const full = path.join(dir, name)
    try {
      if (typeof fs.existsSync === 'function' && fs.existsSync(full) !== true) continue
      fs.rmSync(full, { force: true })
      removedFiles.push(name)
    } catch (error) {
      problems.push(name + ': ' + (error && error.message ? error.message : String(error)))
    }
  }
  if (platform === 'win32') {
    // A missing task makes schtasks exit non-zero; that is the normal "nothing to
    // clean" answer, so it is not reported as a problem.
    const answer = runQuietly(exec, 'schtasks', ['/Delete', '/TN', LEGACY_WATCHDOG_UNIT, '/F'])
    if (answer.ok === true) removedUnits.push(LEGACY_WATCHDOG_UNIT)
  } else {
    const stop = runQuietly(exec, 'systemctl', ['--user', 'stop', LEGACY_WATCHDOG_UNIT + '.service'])
    runQuietly(exec, 'systemctl', ['--user', 'reset-failed', LEGACY_WATCHDOG_UNIT + '.service'])
    if (stop.ok === true) removedUnits.push(LEGACY_WATCHDOG_UNIT + '.service')
  }
  return {
    removedFiles,
    removedUnits,
    error: problems.length > 0 ? problems.join('; ') : null,
  }
}
