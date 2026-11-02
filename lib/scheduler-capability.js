/**
 * CAN THIS MACHINE CREATE A ONE-OFF SCHEDULED TASK?
 *
 * The automatic rollback of this plugin works through a scheduled task: the
 * host is restarted, and a task that fires a minute later brings it back if
 * it did not come up. On a machine where such a task cannot be created
 * (a corporate policy, a machine without the rights, a locked-down service
 * account) that safety net is silently missing — and the user has to be told
 * what they lose.
 *
 * WHAT THIS DOES NOT DO (on purpose):
 *
 *   - it does NOT design a fallback chain ("use the startup folder instead",
 *     "use a systemd timer instead", ...): the user decided against it;
 *   - it does NOT try to bypass the policy ("maybe another way works"): if
 *     the machine says no, the answer is no.
 *
 * It only DETECTS, once, and tells the truth.
 *
 * THE PROBE NEVER LEAVES A TASK BEHIND:
 *
 *   1. a task with a unique name is registered (it fires in two minutes and
 *      does nothing: `cmd /c exit 0`);
 *   2. it is read back and verified (the trigger is the one we asked for);
 *   3. it is deleted;
 *   4. it is read back AGAIN — the task must be gone.
 *
 * The verification is the XML of the task, not its human readable listing:
 * the XML has no translated words, so the check does not depend on the
 * language of the machine ("Ready" in English, "就绪" in Chinese).
 *
 * Everything that touches the system is injected, so a test never has to
 * create a real task.
 */

import { execFileSync } from 'node:child_process';

/** The scheduler works on this machine. */
export const SCHEDULER_OK = 'ok';
/** The scheduler is refused here — the automatic rollback is not available. */
export const SCHEDULER_BLOCKED = 'blocked';
/** Nobody checked yet. */
export const SCHEDULER_UNKNOWN = 'unknown';
/**
 * THE QUESTION DOES NOT APPLY HERE (2026-11-02).
 *
 * Only Windows has the one-off scheduled task this probe is about. The answer
 * used to be `ok` — a green tick for a check that never ran, which made the
 * page and the report claim something nobody had measured. `not-applicable` is
 * a DIFFERENT answer from `ok`: it never counts as "passed", and the caller
 * must say "this check does not apply on this machine" instead.
 */
export const SCHEDULER_NOT_APPLICABLE = 'not-applicable';

/** The name of the probe task. It is unique per run, so two probes cannot collide. */
export const PROBE_TASK_PREFIX = 'dsh-autorestart-capability-probe';

/**
 * The name of the probe task for this run.
 *
 * @param {number} now
 * @param {number|string} pid
 * @returns {string}
 */
export function probeTaskName(now = Date.now(), pid = 0) {
  const stamp = Math.trunc(Number(now) || 0).toString(36);
  const who = String(pid === 0 ? '0' : pid).replace(/[^A-Za-z0-9]/g, '');
  return `${PROBE_TASK_PREFIX}-${who}-${stamp}`;
}

/**
 * The trigger of the probe: two minutes from now, in the formats schtasks
 * wants and in the format the XML reports.
 *
 * @param {number} now
 * @returns {{ sd: string, st: string, iso: string }}
 */
export function probeTrigger(now = Date.now()) {
  const date = new Date(Math.trunc(Number(now) || 0) + 2 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return { sd: `${yyyy}/${mm}/${dd}`, st: `${hh}:${mi}`, iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}` };
}

/**
 * The default executor: run a command and report what it said.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, error: string|null }}
 */
function defaultExec(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
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
 * The trigger of the task, read out of its XML.
 *
 * @param {string} xml
 * @returns {string} the ISO start boundary, or an empty string
 */
export function readStartBoundary(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const match = /<StartBoundary>([^<]+)<\/StartBoundary>/i.exec(text);
  return match ? match[1].trim() : '';
}

/**
 * The trigger of the task, read out of its XML, compared with what we asked
 * for (the XML writes seconds, we asked without them).
 *
 * @param {string} xml
 * @param {string} expectedIso
 * @returns {boolean}
 */
export function triggerMatches(xml, expectedIso) {
  const boundary = readStartBoundary(xml);
  if (boundary === '') return false;
  return boundary.slice(0, 16) === String(expectedIso).slice(0, 16);
}

/**
 * Would the task fire?
 *
 * The XML does NOT always carry an `<Enabled>` element: a task without one is
 * enabled (that is the default), and only an explicit `false` disables it.
 * (A real run on a Chinese Windows answered with a `<TimeTrigger>` that has
 * no `<Enabled>` at all — a check that demanded `<Enabled>true</Enabled>` would
 * have called a perfectly working machine "blocked".)
 *
 * @param {string} xml
 * @returns {boolean}
 */
export function taskEnabled(xml) {
  const text = typeof xml === 'string' ? xml : '';
  return !/<Enabled>false<\/Enabled>/i.test(text);
}

/**
 * Does the task carry an action (is it a real one-off task)?
 *
 * @param {string} xml
 * @returns {boolean}
 */
export function taskHasAction(xml) {
  const text = typeof xml === 'string' ? xml : '';
  return /<Command>/i.test(text);
}

/**
 * THE PROBE.
 *
 * @param {{
 *   platform?: string,
 *   exec?: (file: string, args: string[]) => { ok: boolean, stdout: string, error: string|null },
 *   now?: number,
 *   taskName?: string,
 *   pid?: number|string,
 * }} [options]
 * @returns {{ scheduler: string, checkedAt: number, evidence: object }}
 */
export function probeSchedulerCapability({
  platform = process.platform,
  exec = defaultExec,
  now = Date.now(),
  taskName = probeTaskName(now, process.pid),
  pid = process.pid,
} = {}) {
  const checkedAt = Math.trunc(Number(now) || Date.now());
  const evidence = { platform, taskName, steps: [] };

  // Only Windows uses a one-off scheduled task. Everywhere else the question
  // does not apply — and the answer SAYS SO (`not-applicable`), because `ok`
  // was a green tick for a check that never ran (2026-11-02).
  if (platform !== 'win32') {
    return {
      scheduler: SCHEDULER_NOT_APPLICABLE,
      checkedAt,
      applicable: false,
      reason: 'not applicable: this platform does not use a one-off scheduled task',
      evidence: {
        ...evidence,
        applicable: false,
        note: 'not applicable: this platform does not use a one-off scheduled task',
      },
    };
  }

  const trigger = probeTrigger(checkedAt);
  const step = (kind, ok, detail) => {
    evidence.steps.push({ kind, ok, detail: detail === undefined ? null : detail });
    return ok;
  };

  // (0) Idempotence: a task of an earlier run (or of another instance) must
  //     not be in the way.
  const preClean = exec('schtasks', ['/Delete', '/TN', taskName, '/F']);
  step('pre-clean', true, preClean.ok ? 'deleted a leftover probe task' : 'no leftover probe task');

  try {
    // (1) Register the probe task: it fires in two minutes and does nothing.
    const created = exec('schtasks', [
      '/Create', '/TN', taskName, '/SC', 'ONCE', '/SD', trigger.sd, '/ST', trigger.st,
      '/TR', 'cmd /c exit 0', '/F',
    ]);
    if (!step('create', created.ok, created.ok ? 'the task was registered' : created.error)) {
      return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
    }

    // (2) Read it back: the trigger must be the one we asked for, and the
    //     task must be enabled (that is what "Ready" means in the XML).
    const query = exec('schtasks', ['/Query', '/TN', taskName, '/XML']);
    if (!step('verify', query.ok, query.ok ? 'the task was read back' : query.error)) {
      return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
    }
    if (!step('trigger', triggerMatches(query.stdout, trigger.iso), 'expected ' + trigger.iso + ', got ' + readStartBoundary(query.stdout))) {
      return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
    }
    if (!step('enabled', taskEnabled(query.stdout), 'the task would fire')) {
      return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
    }
    if (!step('action', taskHasAction(query.stdout), 'the task carries an action')) {
      return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
    }
  } catch (error) {
    step('error', false, error && error.message ? error.message : String(error));
    return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
  } finally {
    // (3) Delete it — ALWAYS, also when a step above failed. A registration
    //     that was refused can still have left a task behind (the command may
    //     have created it and then failed), so the cleanup is not conditional.
    const removed = exec('schtasks', ['/Delete', '/TN', taskName, '/F']);
    step('delete', removed.ok, removed.ok ? 'the probe task was deleted' : removed.error);
  }

  // (4) Read it back once more: it must be GONE. A task that survives the
  //     probe is a task the user would find in his task scheduler.
  const after = exec('schtasks', ['/Query', '/TN', taskName, '/XML']);
  const gone = !after.ok;
  step('gone', gone, gone ? 'the task is gone' : 'the task still exists: ' + after.error);
  if (!gone) {
    return { scheduler: SCHEDULER_BLOCKED, checkedAt, evidence };
  }

  return { scheduler: SCHEDULER_OK, checkedAt, evidence };
}

/**
 * Must the user be warned now?
 *
 * The warning is for ONE moment: the transition into "blocked". A machine
 * that was blocked and stays blocked does not nag, and a user who has seen it
 * is not asked again.
 *
 * @param {object|null} previous the capabilities before the check
 * @param {object|null} current the capabilities after the check
 * @returns {boolean}
 */
export function shouldWarnScheduler(previous, current) {
  if (!current || typeof current !== 'object') return false;
  if (current.scheduler !== SCHEDULER_BLOCKED) return false;
  if (current.warnedAt) return false;
  const before = previous && typeof previous === 'object' ? previous.scheduler : SCHEDULER_UNKNOWN;
  // Only the TRANSITION warns: from ok or unknown into blocked.
  return before !== SCHEDULER_BLOCKED;
}

/**
 * The capabilities with the warning marked as seen.
 *
 * @param {object} capabilities
 * @param {number} [now]
 * @returns {object}
 */
export function markSchedulerWarned(capabilities, now = Date.now()) {
  const record = capabilities && typeof capabilities === 'object' ? capabilities : {};
  if (record.warnedAt) return record;
  return { ...record, warnedAt: Math.trunc(Number(now) || Date.now()) };
}

/**
 * A capabilities record that says nothing yet.
 *
 * @returns {{ scheduler: string, checkedAt: number|null, evidence: object|null, warnedAt: number|null }}
 */
export function emptyCapabilities() {
  return { scheduler: SCHEDULER_UNKNOWN, checkedAt: null, evidence: null, warnedAt: null };
}

/**
 * Is the capabilities record readable?
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isCapabilities(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const scheduler = raw.scheduler;
  return scheduler === SCHEDULER_OK
    || scheduler === SCHEDULER_BLOCKED
    || scheduler === SCHEDULER_UNKNOWN
    || scheduler === SCHEDULER_NOT_APPLICABLE;
}
