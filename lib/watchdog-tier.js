/**
 * HOW CAN THE WATCHDOG BE TRIGGERED ON THIS MACHINE?
 *
 * The watchdog is the safety net of the pre-restart backup: it waits for the
 * relaunched host, and when the host never answers, it puts the snapshot back
 * and starts the host again. To do that it has to RUN LATER, and "later" is
 * the part that differs between the machines:
 *
 *   1. `scheduled-task`  — a one-off Windows scheduled task (the desktop app
 *                           and `dsh web` on Windows);
 *   2. `systemd-run`    — a systemd user timer (`dsh web` on Linux, WSL with
 *                           systemd);
 *   3. `detached-process` — a background process of our own (containers, WSL
 *                           without systemd, everything else that can detach a
 *                           process).
 *
 * When NONE of them is available there is no safety net at all — and the user
 * has to be told, because "the automatic rollback" is a promise.
 *
 * ONE SOURCE OF TRUTH: `pickWatchdogTier` decides. The capability check of
 * the plugin (what the settings page shows) and the watchdog that is actually
 * registered ask THE SAME function, so the warning can never drift away from
 * the behaviour.
 */

import { execFileSync } from 'node:child_process';

/** The ways a watchdog can be triggered. */
export const TIERS = Object.freeze({
  SCHEDULED_TASK: 'scheduled-task',
  SYSTEMD_RUN: 'systemd-run',
  DETACHED_PROCESS: 'detached-process',
  NONE: 'none',
});

/** What each tier means, for the report and for the settings page. */
export const TIER_LABELS = Object.freeze({
  'scheduled-task': 'a one-off Windows scheduled task',
  'systemd-run': 'a systemd user timer',
  'detached-process': 'a detached background process',
  none: 'nothing on this machine',
});

/**
 * Run a command and report whether it worked.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, error: string|null }}
 */
export function defaultExec(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return { ok: true, stdout: typeof stdout === 'string' ? stdout : '', error: null };
  } catch (error) {
    return {
      ok: false,
      stdout: error && typeof error.stdout === 'string' ? error.stdout : '',
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * Is this command there?
 *
 * @param {Function} exec
 * @param {string} file
 * @param {string[]} args
 * @returns {boolean}
 */
export function commandWorks(exec, file, args) {
  const answer = exec(file, args);
  return answer !== null && answer !== undefined && answer.ok === true;
}

/**
 * WHAT THIS MACHINE CAN DO.
 *
 * @param {{ platform?: string, exec?: Function }} [options]
 * @returns {{ platform: string, hasSchtasks: boolean, hasSystemdRun: boolean, hasAt: boolean, canDetach: boolean }}
 */
export function detectWatchdogCapabilities({ platform = process.platform, exec = defaultExec } = {}) {
  const windows = platform === 'win32';
  return {
    platform,
    hasSchtasks: windows ? commandWorks(exec, 'schtasks', ['/?']) : false,
    hasSystemdRun: windows ? false : commandWorks(exec, 'systemd-run', ['--version']),
    hasAt: windows ? false : commandWorks(exec, 'at', ['--version']),
    // A REAL RUN, NOT A VERSION STRING (2026-11-02): `setsid --version` is a
    // util-linux answer. BusyBox's `setsid` has no such flag and exits non-zero,
    // so the old probe reported "this machine cannot detach a process" on a
    // machine where `setsid` works perfectly — and the watchdog silently lost
    // its only tier. `setsid true` asks the question that actually matters: can
    // a command be put into its own session here? (`true` does nothing, so
    // nothing is left behind either way.)
    canDetach: windows ? false : commandWorks(exec, 'setsid', ['true']),
  };
}

/**
 * WHICH TIER DOES THIS MACHINE GET?
 *
 * A pure function: it takes what the machine can do and says which tier to
 * use — and WHY. The reason goes into the report, so a reader of
 * `last-watchdog-report.json` knows what happened without guessing.
 *
 * @param {{
 *   platform?: string,
 *   hasSchtasks?: boolean,
 *   hasSystemdRun?: boolean,
 *   hasAt?: boolean,
 *   canDetach?: boolean,
 * }} [options]
 * @returns {{ tier: string, reason: string }}
 */
export function pickWatchdogTier({
  platform = process.platform,
  hasSchtasks = false,
  hasSystemdRun = false,
  hasAt = false,
  canDetach = false,
} = {}) {
  if (platform === 'win32') {
    if (hasSchtasks) {
      return {
        tier: TIERS.SCHEDULED_TASK,
        reason: 'this Windows can register a one-off scheduled task (schtasks)',
      };
    }
    return {
      tier: TIERS.NONE,
      reason: 'this Windows cannot register a scheduled task (schtasks is not usable here)',
    };
  }
  if (hasSystemdRun) {
    return {
      tier: TIERS.SYSTEMD_RUN,
      reason: 'systemd user timers are available here (systemd-run)',
    };
  }
  if (canDetach) {
    return {
      tier: TIERS.DETACHED_PROCESS,
      reason: 'there is no systemd here'
        + (hasAt
          ? ' (the machine has at, but the plugin starts a process of its own: no daemon, nothing to configure)'
          : ' (no systemd and no at): the plugin starts a process of its own'),
    };
  }
  return {
    tier: TIERS.NONE,
    reason: 'this machine can neither schedule a task nor detach a process of its own',
  };
}

/**
 * Does this tier give the user the automatic rollback?
 *
 * @param {string} tier
 * @returns {boolean}
 */
export function tierProvidesRollback(tier) {
  return typeof tier === 'string' && tier !== '' && tier !== TIERS.NONE;
}

/**
 * The tier from a capability record that ALSO carries a real proof.
 *
 * On Windows the plugin does not trust "the command is there": it really
 * registers a task and reads it back (see lib/scheduler-capability.js). That
 * proof is the answer to "hasSchtasks" — the same answer the watchdog uses
 * when it registers its own task.
 *
 * @param {{
 *   platform?: string,
 *   probeOk?: boolean|null,
 *   hasSystemdRun?: boolean,
 *   hasAt?: boolean,
 *   canDetach?: boolean,
 * }} options
 * @returns {{ tier: string, reason: string }}
 */
export function tierWithProof({ platform = process.platform, probeOk = null, hasSystemdRun = false, hasAt = false, canDetach = false } = {}) {
  const hasSchtasks = platform === 'win32'
    ? probeOk === true
    : false;
  return pickWatchdogTier({ platform, hasSchtasks, hasSystemdRun, hasAt, canDetach });
}
