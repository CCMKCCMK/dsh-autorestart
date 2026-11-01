/**
 * dsh-autorestart watchdog: the one-off process that watches the relaunch.
 *
 * The tiers (a Windows scheduled task, a systemd user timer, a detached
 * process of our own) differ only in HOW this file is made to run. What it
 * does is always the same, and it lives in lib/watchdog.js:
 *
 *   wait for the ready marker -> ask again -> is an instance alive? -> take
 *   the lock -> (up to maxAttempts times) ask again -> CLEAR THE STALE
 *   HANDSHAKE COOKIES -> restore the snapshot -> start the host again -> wait
 *   for the ready marker -> report.
 *
 * This file only provides the parts that touch the machine: the health probe,
 * the cookie cleanup, the restore command, the start-again command, and the
 * lock.
 *
 * NOTHING MAY EXIT SILENTLY. On 2026-10-30 this process never ran a single
 * line (the registered task started the desktop executable instead of node,
 * through an extra `cmd /c`), and the report still said `armed` for days: the
 * watchdog was dead and nothing said so. Every way out of this file therefore
 * leaves a report behind - a failure to LOAD the plugin included:
 *
 *   stage 'import' - the modules could not be loaded;
 *   stage 'config' - there is no state directory, or no pending marker;
 *   stage 'flow'   - the flow ran and could not rescue the host;
 *   stage 'relaunch' - the flow could not even start the host again.
 *
 * It is ASCII on purpose (like every other script of this plugin): the
 * console reads it with the code page of the machine.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where this file lives (`<plugin>/scripts/watchdog.mjs`). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The plugin directory. */
const PLUGIN_DIR = path.dirname(HERE);

/** The report file name (the plugin, the supervisor and the UI read it). */
const REPORT_NAME = 'last-watchdog-report.json';
/** The names of the scheduling items this plugin uses (one name each). */
const TASK_NAME = 'dsh-autorestart-watchdog';
const UNIT_ID = 'dsh-autorestart-watchdog';

/**
 * The state directory of the plugin when nothing was passed.
 *
 * It is only used to leave a report on the "there is no --state-dir" path: a
 * watchdog that cannot even say where its state lives still has to say that
 * it refused, in the place the plugin reads.
 */
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.dsh', 'storages', 'dsh-autorestart');

/**
 * The file a REFUSAL is written to when the state directory is unknown.
 *
 * WHY NOT `last-watchdog-report.json` (2026-10-30, review finding F3): the old
 * code called `reportAndWarn(DEFAULT_STATE_DIR, ...)` on this path, so a run
 * that had no `--state-dir` OVERWROTE the report of the last REAL rescue with
 * its own "I never started" note (t6 drill, measured: a 320-byte rescue record
 * replaced by a 586-byte refusal). A refusal is not a rescue result and must
 * never be filed as one - so it goes to a file of its own, in a directory that
 * is NOT the installation (`DSH_WATCHDOG_REFUSAL_DIR`, else the temp dir).
 */
const REFUSAL_NAME = 'dsh-autorestart-watchdog-refusal.json';

/**
 * Where a refusal record may be written (never the plugin state directory).
 *
 * @returns {string}
 */
function refusalDir() {
  const override = typeof process.env.DSH_WATCHDOG_REFUSAL_DIR === 'string'
    ? process.env.DSH_WATCHDOG_REFUSAL_DIR.trim()
    : '';
  return override !== '' ? override : os.tmpdir();
}

/**
 * Write the record of a refusal, and never throw while doing it.
 *
 * @param {{ result?: string, stage?: string, error?: string, reason?: string }} fields
 * @returns {string} the path it was written to ('' when it could not be written)
 */
function writeRefusalRecord(fields = {}) {
  const dir = refusalDir();
  const target = path.join(dir, REFUSAL_NAME);
  const record = {
    at: new Date().toISOString(),
    result: typeof fields.result === 'string' ? fields.result : 'skipped',
    stage: typeof fields.stage === 'string' ? fields.stage : 'config',
    error: typeof fields.error === 'string' ? fields.error : null,
    reason: typeof fields.reason === 'string' ? fields.reason : null,
    // Say where it WOULD have been written, so an operator can finish by hand.
    stateDirWhenKnown: null,
    note: 'this run never started: it is NOT a rescue result and must not overwrite last-watchdog-report.json',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(record, null, 2), 'utf8');
    return target;
  } catch {
    return '';
  }
}

/**
 * WHERE THE RUN STOOD when it ended: 'import' | 'config' | 'flow' | 'relaunch'.
 * It is a module-level value because the crash handlers below have to name the
 * stage the process was in when it died.
 */
let stage = 'config';
/** The state directory as soon as it is known (the crash handlers use it). */
let resolvedStateDir = DEFAULT_STATE_DIR;

/**
 * The value of a command line flag.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string}
 */
function valueOf(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const next = args[index + 1];
  return typeof next === 'string' && !next.startsWith('--') ? next : '';
}

/**
 * Write a report, and never throw while doing it.
 *
 * This is the raw writer on purpose: it has to work when the plugin modules
 * could NOT be loaded (that is the 'import' failure this file has to report).
 *
 * @param {string} stateDir
 * @param {object} report
 * @returns {boolean} whether the report is on disk now
 */
function writeReportFile(stateDir, report) {
  const where = typeof stateDir === 'string' && stateDir !== '' ? stateDir : DEFAULT_STATE_DIR;
  try {
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, REPORT_NAME), JSON.stringify(report, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The report of a run that never got as far as the flow.
 *
 * The shape is the same as the one the flow writes (the plugins and the UI
 * read the same file): nothing is renamed, and the fields that cannot be known
 * yet say so (`maxAttempts: 0`, `attempts: 0`).
 *
 * @param {{
 *   result?: string,
 *   stage?: string,
 *   error?: string,
 *   reason?: string,
 *   tier?: string,
 * }} fields
 * @returns {object}
 */
function startupReport(fields = {}) {
  const error = typeof fields.error === 'string' ? fields.error : null;
  const reason = typeof fields.reason === 'string' ? fields.reason : null;
  return {
    at: new Date().toISOString(),
    result: fields.result || 'failed',
    tier: fields.tier || 'none',
    tierReason: '',
    arbiter: 'v2',
    waitedMs: 0,
    rechecked: false,
    healthCheck: 'unknown',
    healthDetail: null,
    health: null,
    extraRound: false,
    restored: false,
    relaunched: false,
    ready: false,
    error: error === null ? reason : error,
    stage: fields.stage || 'config',
    // The flow never ran, so no attempt was allowed and none was made.
    maxAttempts: 0,
    attempts: 0,
    cookieClear: null,
    attemptLog: [],
    reason,
  };
}

/**
 * Say why this process did not rescue anything, on the disk AND on stderr.
 *
 * @param {string} stateDir
 * @param {object} fields
 * @returns {boolean} whether the report is on disk now
 */
function reportAndWarn(stateDir, fields) {
  const report = startupReport(fields);
  const wrote = writeReportFile(stateDir, report);
  const text = report.error || report.reason || 'the watchdog did not run';
  console.error(
    'dsh-autorestart watchdog: ' + text
    + (wrote ? '' : ' (and no report could be written to ' + stateDir + ')'),
  );
  return wrote;
}

/**
 * A crash is not an excuse to leave no trace.
 *
 * @param {string} kind
 * @param {unknown} error
 */
function onFatal(kind, error) {
  const detail = error && error.message ? error.message : String(error);
  stage = stage === '' ? 'flow' : stage;
  reportAndWarn(resolvedStateDir, {
    result: 'failed',
    stage,
    error: kind + ': ' + detail,
    reason: kind + ': ' + detail,
  });
  process.exit(1);
}

process.on('uncaughtException', (error) => onFatal('uncaught exception', error));
process.on('unhandledRejection', (reason) => onFatal('unhandled rejection', reason));

/**
 * Ask a health route whether it is alive.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function healthOk(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = http.get(url, { timeout: timeoutMs }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            done(parsed && parsed.ok === true);
          } catch {
            done(false);
          }
        });
      });
      request.on('timeout', () => { request.destroy(); done(false); });
      request.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * Every health URL that could answer for this host, most trustworthy first.
 *
 * The NEW instance of the desktop app listens on a RANDOM port, so the URL the
 * old instance knew (`pending.healthUrl`) is usually worthless after a
 * restart. The new instance publishes its own port in the instance record
 * (`pending.portFile`), and that record is asked REGARDLESS of its boot id: any
 * host that answers this route is a host that must not be restored.
 *
 * @param {object} pending
 * @returns {string[]}
 */
function healthCandidates(pending) {
  const healthPath = pending.healthPath || '/__dsh_autorestart/health';
  const urls = [];
  const add = (url) => {
    if (typeof url === 'string' && url !== '' && !urls.includes(url)) urls.push(url);
  };
  // (1) The port the running instance published about itself.
  if (pending.portFile) {
    try {
      const record = JSON.parse(fs.readFileSync(pending.portFile, 'utf8'));
      const port = Number(record && record.port);
      if (Number.isFinite(port) && port > 0) add('http://127.0.0.1:' + port + healthPath);
    } catch {
      // No record yet: the host may not have written it.
    }
  }
  // (2) A port the plugin put into the pending marker itself.
  const own = Number(pending.port);
  if (Number.isFinite(own) && own > 0) add('http://127.0.0.1:' + own + healthPath);
  // (3) The URL of the instance that is being replaced (last resort: it is the
  //     OLD port, but a host that never went down still answers on it).
  add(pending.healthUrl);
  return urls;
}

/**
 * The instance record the plugin writes at boot (port, pid, boot id).
 *
 * @param {string} file
 * @returns {object|null}
 */
function readInstanceRecord(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is that process still there?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * ASK THE HOST ITSELF: is it alive?
 *
 * This is the last question before a restore (see step 3b of
 * lib/watchdog.js), and it is asked again before every further attempt. It
 * answers:
 *
 *   'healthy'   -- a health route answered `{"ok":true}`, or an instance of the
 *                 NEW boot is clearly running: DO NOT RESTORE, DO NOT START
 *   'unhealthy' -- every known URL was asked and none answered, and no instance
 *                 of the new boot is running: a restore/start may go ahead
 *   'unknown'   -- there was no URL to ask at all (no instance record, no
 *                 health URL): the caller waits one more round
 *
 * @param {object} pending
 * @returns {Promise<{ state: string, detail: string|null }>}
 */
async function askHealth(pending) {
  const urls = healthCandidates(pending);
  for (const url of urls) {
    if (await healthOk(url)) return { state: 'healthy', detail: 'the health route answered: ' + url };
  }
  const record = readInstanceRecord(pending.portFile);
  if (record && record.pid && record.bootId !== pending.expectedBootId && isAlive(record.pid)) {
    return { state: 'healthy', detail: 'the instance of the new boot is running (pid ' + record.pid + ')' };
  }
  if (urls.length === 0) return { state: 'unknown', detail: null };
  return { state: 'unhealthy', detail: 'no health route answered (' + urls.length + ' asked), no live instance' };
}

/**
 * Is an instance of the host alive?
 *
 * @param {object} pending
 * @returns {Promise<boolean>}
 */
async function probeAlive(pending) {
  const record = readInstanceRecord(pending.portFile);
  if (record && record.bootId && record.port && record.bootId !== pending.expectedBootId) {
    const url = 'http://127.0.0.1:' + record.port + (pending.healthPath || '/__dsh_autorestart/health');
    if (await healthOk(url)) return true;
  }
  if (pending.healthUrl) {
    if (await healthOk(pending.healthUrl)) return true;
  }
  return false;
}

/**
 * Run a command and report whether it worked.
 *
 * @param {{ file?: string, args?: string[] }|null} command
 * @returns {{ ok: boolean, error: string|null }}
 */
function runCommand(command) {
  if (!command || typeof command.file !== 'string' || command.file === '') {
    return { ok: false, error: 'there is no command to run' };
  }
  try {
    execFileSync(command.file, Array.isArray(command.args) ? command.args : [], {
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Start the host again (it must survive this process).
 *
 * @param {{ file?: string, args?: string[] }|null} command
 * @returns {{ ok: boolean, error: string|null }}
 */
function startAgain(command) {
  if (!command || typeof command.file !== 'string' || command.file === '') {
    return { ok: false, error: 'there is no command to start the host' };
  }
  try {
    const child = spawn(command.file, Array.isArray(command.args) ? command.args : [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// (0) The state directory.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const fromArgs = valueOf(argv, '--state-dir');
const fromEnv = typeof process.env.DSH_WATCHDOG_STATE_DIR === 'string' ? process.env.DSH_WATCHDOG_STATE_DIR : '';
const stateDir = fromArgs !== '' ? fromArgs : fromEnv;

if (stateDir === '') {
  // A watchdog that does not know where the markers live cannot watch
  // anything - and "it did nothing" must not be invisible.
  //
  // BUT IT MUST NOT FILE ITSELF AS A RESCUE RESULT (review finding F3): the
  // state directory is UNKNOWN here, so writing `last-watchdog-report.json`
  // would mean writing into the default installation's directory and
  // overwriting the report of the last REAL rescue with this refusal. The
  // refusal goes to its own file (outside the installation) plus stderr.
  const reason = 'no state directory (--state-dir or DSH_WATCHDOG_STATE_DIR): nothing could be watched';
  const refusalPath = writeRefusalRecord({ result: 'skipped', stage: 'config', error: reason, reason });
  console.error(
    'dsh-autorestart watchdog: ' + reason
    + ' (refusal recorded at ' + (refusalPath === '' ? 'nothing: the refusal record could not be written' : refusalPath) + ')',
  );
  process.exit(2);
}
resolvedStateDir = stateDir;

// ---------------------------------------------------------------------------
// (1) The plugin modules. A plugin that cannot be loaded is a watchdog that
//     cannot rescue anything - and it says so on disk, not only on a console
//     nobody is looking at.
// ---------------------------------------------------------------------------

let watchdog = null;
let schedule = null;
let cookieClear = null;
let nodeRuntime = null;
try {
  watchdog = await import('../lib/watchdog.js');
  schedule = await import('../lib/watchdog-schedule.js');
  cookieClear = await import('../lib/cookie-clear.js');
  nodeRuntime = await import('../lib/node-runtime.js');
} catch (error) {
  const detail = error && error.message ? error.message : String(error);
  reportAndWarn(stateDir, {
    result: 'failed',
    stage: 'import',
    error: detail,
    reason: 'the plugin could not be loaded: ' + detail,
  });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// (2) The cookie cleanup (step 1 of the task: BEFORE the host is started).
// ---------------------------------------------------------------------------

/**
 * Remove the stale `dsh-auth-*` handshake cookies.
 *
 * The cleanup script (scripts/clear-dsh-auth-cookies.mjs) always exits 0: a
 * restart must never be blocked by a cleanup that could not run. So `ok` here
 * means "the cleanup process ran to its end", NOT "cookies were deleted" - the
 * script writes its own count into clear-cookies.log, and `removed` stays null
 * because this runner did not measure it. A count that was never measured is
 * reported as not measured.
 *
 * The interpreter is RESOLVED (lib/node-runtime.js), never `process.execPath`:
 * inside the desktop app that is the app executable, which would start a
 * second client instead of running the script.
 *
 * @returns {{ ok: boolean, removed: number|null, error: string|null }}
 */
function clearStaleCookies() {
  const script = path.join(PLUGIN_DIR, 'scripts', cookieClear.COOKIE_CLEAR_SCRIPT_NAME);
  if (!fs.existsSync(script)) {
    return { ok: false, removed: null, error: 'the cleanup script is not installed: ' + script };
  }
  const interpreter = nodeRuntime.resolveNodeInterpreter({
    execPath: process.execPath,
    platform: process.platform,
  });
  if (interpreter.ok !== true) {
    return { ok: false, removed: null, error: interpreter.reason || 'no node interpreter was found' };
  }
  try {
    execFileSync(interpreter.path, [script], {
      timeout: 60000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return { ok: true, removed: null, error: null };
  } catch (error) {
    return { ok: false, removed: null, error: error && error.message ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// (3) The pending marker. No marker: nothing to watch - and still a trace.
// ---------------------------------------------------------------------------

// THE MARKER IS READ WITH ITS REASON (review finding F4): "there is no marker"
// and "there is a marker this file cannot read" are different answers, and the
// second one used to be reported as the first - the process cleaned up its
// scheduling item and exited 0 while looking like a run that had done its job.
const pendingState = watchdog.readPendingState(stateDir);
if (pendingState.state === 'corrupt') {
  reportAndWarn(stateDir, {
    result: 'failed',
    stage: 'config',
    error: 'the pending marker exists but cannot be read: ' + String(pendingState.error || 'unknown reason'),
    reason: 'the pending marker exists but cannot be read (nothing was restored)',
  });
  console.error('dsh-autorestart watchdog: the pending marker exists but cannot be read - nothing was restored');
  process.exit(2);
}

const pending = pendingState.pending;
if (!pending) {
  // Nothing to watch: the plugin decided on its own, or another watchdog is
  // already on it. The scheduling item still goes: a task that fires once and
  // then stays in the task scheduler is garbage.
  try {
    schedule.removeScheduleItem({ tier: 'scheduled-task', taskName: TASK_NAME });
    schedule.removeScheduleItem({ tier: 'systemd-run', unitId: UNIT_ID });
  } catch {
    // It was never there.
  }
  // The empty exit is written down: on 2026-10-30 this path deleted the task
  // and left not one line behind, so nobody could tell it had ever run.
  reportAndWarn(stateDir, {
    result: 'skipped',
    stage: 'config',
    error: 'no pending marker: there was nothing to watch',
    reason: 'no pending marker',
  });
  console.log('dsh-autorestart watchdog: no pending marker - nothing to watch');
  process.exit(0);
}

const lockFile = path.join(stateDir, watchdog.LOCK_NAME);
stage = 'flow';

// WHAT MAY BE PUT BACK, read from the marker through the SAME normalizer the
// flow uses, so the CLI and the flow cannot disagree about which copy is the
// target (2026-11-01: the field used to be called `snapshotDir` and was in fact
// the certified copy, not a snapshot).
const restoreTarget = watchdog.restoreTargetInfoOf(pending);

const report = await watchdog.runWatchdogFlow({
  pending,
  stateDir,
  deps: {
    probeAlive: () => probeAlive(pending),
    // THE LAST QUESTION BEFORE ANY RESTORE: ask the health route itself. A
    // host that answers must never be rolled back, even when it forgot to
    // write the ready marker.
    askHealth: () => askHealth(pending),
    // BEFORE the host is started again: the stale handshake cookies go. A
    // host that is started with them dies again with 431.
    clearCookies: () => clearStaleCookies(),
    // STRICT MODE (2026-11-01): with no trusted restore point this refuses
    // instead of restoring something. The flow already stops before calling it;
    // this is the second lock on the same door, because restoring an unknown
    // copy is the one mistake this whole feature must not make.
    runRestore: () => {
      if (restoreTarget.blocked === true || restoreTarget.dir === '') {
        return {
          ok: false,
          error: 'no trusted restore point: ' + (restoreTarget.reason || 'nothing to restore'),
          copied: [],
          links: [],
        };
      }
      return pending.restoreCommand
        ? runCommand(pending.restoreCommand)
        : watchdog.restoreFromSnapshot({ restoreTargetDir: restoreTarget.dir, profileDir: pending.profileDir });
    },
    runRelaunch: () => startAgain(pending.relaunchCommand),
    acquireLock: () => watchdog.acquireLock(lockFile),
    releaseLock: () => watchdog.releaseLock(lockFile),
    removeSchedule: () => {
      schedule.removeScheduleItem({
        tier: pending.tier,
        taskName: pending.taskName,
        unitId: pending.unitId,
        pidPath: pending.pidPath,
      });
    },
  },
});

// The report itself is written by the flow (from its finally), so it exists
// whatever the result was. This is only the console summary.
console.log(
  'dsh-autorestart watchdog: ' + report.result
  + ' (tier ' + report.tier + ', attempt ' + report.attempts + '/' + report.maxAttempts + ')',
);
if (report.cookieClear) {
  console.log('  cookie cleanup: ' + (report.cookieClear.ok === true ? 'ran' : 'FAILED: ' + report.cookieClear.error));
}
if (report.error) console.log('  ' + report.error);
process.exit(report.result === 'failed' ? 1 : 0);
