/**
 * THE WATCHDOG — one flow, three ways to trigger it.
 *
 * The flow is the same everywhere; only the way the watchdog is made to run
 * differs (see lib/watchdog-tier.js and lib/watchdog-schedule.js). This file
 * is that flow:
 *
 *   1. wait for the READY marker (the new host wrote it after its health
 *      check passed);
 *   2. no marker? Wait a bit and ASK AGAIN — a host that is slow to start is
 *      not a host that is dead (the misjudgement protection);
 *   3. still nothing? Is an instance ALIVE? If one is listening, the rollback
 *      is not needed: stand down (the no-double-start protection);
 *   3b. THE LAST QUESTION BEFORE A RESTORE: ask the health route ITSELF
 *      (HTTP to 127.0.0.1:<port>). Only a host that does not answer may be
 *      rolled back. This is what keeps a host that forgot to write the marker
 *      — or could not write it — from being restored out from under itself.
 *      When there is no port to ask at all (no instance record, no health
 *      URL), one more round is waited and the leftovers are looked at again;
 *   4. take the shared lock (`rollback.lock`) — exactly ONE of us restores;
 *   5. THE PASS — up to `maxAttempts` times (3 by default, and NEVER endless):
 *        a. ask again whether the host came up or is alive (a host that came
 *           up between two attempts must not be started a second time);
 *        b. restore the snapshot on the first pass, and again on a later pass
 *           only when the restore itself failed (the snapshot is the same
 *           file tree: copying it twice would not change anything);
 *        c. CLEAR THE STALE HANDSHAKE COOKIES after the restore and before
 *           the start (see lib/cookie-clear.js: without it the relaunched
 *           host dies with 431 on its very first request);
 *        d. START THE HOST AGAIN and wait for the ready marker;
 *        e. not ready and attempts left? wait the backoff (15s, then 45s) and
 *           go back to (a);
 *   6. the marker came → `recovered`; the attempts ran out → `failed` with
 *      "tried N times, no further rollback will be attempted"; a start that
 *      could not be issued at all → `failed` with `stage:'relaunch'`.
 *
 * A cleanup that fails never blocks a rescue (the cookie script exits 0 for
 * the same reason), but it is ALWAYS written into the report (`cookieClear`):
 * a cleanup that could not run must never look like one that did.
 *
 * Whatever happens, the report is written FIRST, then the pending marker goes,
 * and only then the scheduling item — because `removeSchedule` can stop the very
 * service this process runs in (2026-11-01), and anything written after that
 * never reaches the disk. The report is written from the `finally`, so an
 * exception inside the flow still leaves a report behind.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CERTIFICATION_EVIDENCE,
  collectLinkedPlugins,
  decideLinkRestore,
  LINK_ACTIONS,
  LINKS_DIR,
  MANIFEST_NAME,
} from './backup.js';

/** The marker that says "a restart is coming, a watchdog is watching". */
export const PENDING_NAME = 'watchdog-pending.json';
/** The marker that says "the new host is up and healthy". */
export const READY_NAME = 'watchdog-ready.json';
/** The report of the last watchdog run. */
export const REPORT_NAME = 'last-watchdog-report.json';
/** The lock that both the plugin and the watchdog take before a restore. */
export const LOCK_NAME = 'rollback.lock';

/** How long the watchdog waits for the new host. */
export const DEFAULT_TIMEOUT_MS = 180000;
/** How long it waits before it asks again (the misjudgement protection). */
export const DEFAULT_RECHECK_MS = 20000;
/** How often it looks at the ready marker. */
export const DEFAULT_POLL_MS = 2000;
/** How long it waits for the host after the restore. */
export const DEFAULT_READY_TIMEOUT_MS = 90000;

/**
 * How many pass-and-start attempts one watchdog run may make.
 *
 * The flow used to be "one restore, one start, then stop". One start is not
 * enough: the desktop app can die while it boots (a 431 on its first request
 * killed it after 14 seconds on 2026-10-30), and a host that died is a host
 * that has to be started again. It is a NUMBER, not "as often as you like":
 * a run that never ends is a run that never reports.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * The hard ceiling of `maxAttempts`.
 *
 * A pending marker is a file on disk, so a bad or hand-edited value must not
 * be able to turn the watchdog into an endless loop.
 */
export const MAX_ATTEMPTS_CEILING = 10;

/**
 * HOW OFTEN THE WATCHDOG MAY PUT A COPY BACK = ONCE (user decision, 2026-11-01).
 *
 * Restoring the same directory again cannot change anything: the bytes are
 * identical, so a second and third restore of the same copy is the same attempt
 * repeated — measured on the real machine, three attempts restored the same copy
 * three times and failed the same way three times, which reads like "we tried
 * hard" while nothing new was tried at all.
 *
 * So: the restore happens at most once per run. The START may still be repeated
 * (`maxAttempts`), because a host that died for an unrelated reason can come up
 * on the next try.
 */
export const MAX_RESTORES = 1;

/**
 * The waits BETWEEN two attempts, in milliseconds (15s, then 45s).
 *
 * The first wait is short (a host that died on its first request is worth
 * starting again at once); the second is longer (a host that dies twice is
 * dying for a reason, and hammering the disk with relaunches helps nobody).
 * The last entry repeats when there are more attempts than entries.
 */
export const DEFAULT_BACKOFF_MS = Object.freeze([15000, 45000]);

/**
 * How many attempts this run may make (the marker, clamped and defaulted).
 *
 * An OLD marker carries no `maxAttempts`: it is read as `DEFAULT_MAX_ATTEMPTS`,
 * never as "one" — a marker written before this field existed must not turn
 * the watchdog back into the one-shot process that failed on 2026-10-30.
 *
 * @param {object|null} pending
 * @returns {number}
 */
export function maxAttemptsOf(pending) {
  const raw = pending && typeof pending === 'object' ? pending.maxAttempts : undefined;
  const wanted = Number(raw);
  if (!Number.isFinite(wanted) || wanted < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS_CEILING, Math.trunc(wanted));
}

/**
 * The wait AFTER a given attempt (1-based), in milliseconds.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function backoffMsFor(attempt) {
  const index = Math.max(0, Math.trunc(Number(attempt) || 0) - 1);
  const table = DEFAULT_BACKOFF_MS;
  return table[Math.min(index, table.length - 1)];
}

/**
 * Write a JSON file (no BOM, so every reader can parse it).
 *
 * @param {string} file
 * @param {object} value
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Read a JSON file and say WHAT happened (a file that cannot be read is not
 * the same thing as a file that is not there).
 *
 * WHY THE THREE STATES (2026-10-30, review finding F4): the old reader returned
 * `null` for BOTH "there is no such file" and "the file cannot be parsed". The
 * watchdog therefore read a `watchdog-pending.json` that had been written BY
 * POWERSHELL (UTF-8 **with** a byte order mark) as "there is no pending marker",
 * cleaned up its scheduling item and exited 0 - looking like a run, doing
 * nothing at all. That is exactly the failure this whole file exists to
 * prevent, so "missing" and "corrupt" are separate answers now, and the byte
 * order mark is stripped before parsing.
 *
 * @param {string} file
 * @returns {{
 *   state: 'ok'|'missing'|'corrupt',
 *   value: object|null,
 *   error: string|null,
 * }}
 */
export function readJsonState(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'missing', value: null, error: null };
    }
    return {
      state: 'corrupt',
      value: null,
      error: 'the file exists but cannot be read: ' + (error && error.message ? error.message : String(error)),
    };
  }
  // Windows PowerShell 5.1 writes UTF-8 WITH a byte order mark, and
  // `JSON.parse` refuses a leading U+FEFF. Stripping it is not cosmetic: a
  // marker written by a rescue script has to be readable by this module.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      state: 'corrupt',
      value: null,
      error: 'the file cannot be parsed: ' + (error && error.message ? error.message : String(error)),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'corrupt', value: null, error: 'the file does not hold a JSON object' };
  }
  return { state: 'ok', value: parsed, error: null };
}

/**
 * Read a JSON file (the value, or null when there is nothing usable).
 *
 * The PLUGIN side keeps this shape: `readPending` / `readReady` / `readReport`
 * are imported by index.js, and a caller that only wants "the object or
 * nothing" must not have to unwrap a state machine. The watchdog CLI uses
 * {@link readJsonState} (and {@link readPendingState}) because it has to tell
 * "no marker" from "a marker it cannot read".
 *
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  return readJsonState(file).value;
}

/**
 * The pending marker WITH the reason it could not be used.
 *
 * @param {string} stateDir
 * @returns {{ state: 'ok'|'missing'|'corrupt', pending: object|null, error: string|null }}
 */
export function readPendingState(stateDir) {
  const read = readJsonState(pendingPath(stateDir));
  return { state: read.state, pending: read.value, error: read.error };
}

/**
 * THE PENDING MARKER: what the watchdog has to know.
 *
 * `restoreTargetDir` USED TO BE CALLED `snapshotDir` AND THAT NAME LIED
 * (2026-11-01): the directory stored here is never the snapshot of this
 * restart — it is the copy the watchdog may restore, which since the strict mode
 * is "the newest copy that was CERTIFIED and that no system intervention is on
 * record for". The old name is still accepted as an input alias so a caller
 * that was not updated keeps working, but the marker itself only carries the
 * new name.
 *
 * `restoreBlocked` / `restoreBlockedReason` / `restoreCandidates` are written by
 * the ARMING side when it found no copy it is allowed to restore. The watchdog
 * must not restore in that case (strict mode: no trusted restore point), and the
 * report has to be able to say WHICH copies were looked at and why each was
 * refused — a rescue that quietly does nothing is the incident this whole change
 * is about.
 *
 * @param {{
 *   tier?: string,
 *   tierReason?: string,
 *   taskName?: string,
 *   unitId?: string,
 *   pidPath?: string,
 *   restoreTargetDir?: string,
 *   snapshotDir?: string,
 *   restoreBlocked?: boolean,
 *   restoreBlockedReason?: string,
 *   restoreCandidates?: Array<object>|null,
 *   profileDir?: string,
 *   restoreCommand?: object|null,
 *   relaunchCommand?: object|null,
 *   healthUrl?: string,
 *   healthPath?: string,
 *   portFile?: string,
 *   expectedBootId?: string|null,
 *   timeoutMs?: number,
 *   recheckMs?: number,
 *   readyTimeoutMs?: number,
 *   hostKind?: string,
 *   attempts?: number,
 *   maxAttempts?: number,
 *   now?: number,
 * }} options
 * @returns {object}
 */
export function buildPending({
  tier = 'none',
  tierReason = '',
  arbiter = 'v2',
  taskName = '',
  unitId = '',
  pidPath = '',
  restoreTargetDir = '',
  snapshotDir = '',
  restoreBlocked = false,
  restoreBlockedReason = '',
  restoreCandidates = null,
  profileDir = '',
  restoreCommand = null,
  relaunchCommand = null,
  healthUrl = '',
  healthPath = '/__dsh_autorestart/health',
  portFile = '',
  expectedBootId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recheckMs = DEFAULT_RECHECK_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  hostKind = '',
  attempts = 1,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = Date.now(),
} = {}) {
  const target = typeof restoreTargetDir === 'string' && restoreTargetDir !== ''
    ? restoreTargetDir
    : (typeof snapshotDir === 'string' ? snapshotDir : '')
  return {
    version: 1,
    at: new Date(now).toISOString(),
    tier,
    tierReason,
    arbiter,
    taskName,
    unitId,
    pidPath,
    restoreTargetDir: target,
    restoreBlocked: restoreBlocked === true || target === '',
    restoreBlockedReason: typeof restoreBlockedReason === 'string' ? restoreBlockedReason : '',
    restoreCandidates: Array.isArray(restoreCandidates) ? restoreCandidates : [],
    profileDir,
    restoreCommand,
    relaunchCommand,
    healthUrl,
    healthPath,
    portFile,
    expectedBootId,
    timeoutMs,
    recheckMs,
    readyTimeoutMs,
    hostKind,
    attempts,
    maxAttempts,
  };
}

/**
 * WHY A COPY MAY NOT BE RESTORED — one word per reason, so a report can group
 * them instead of repeating a sentence per copy.
 */
export const RESTORE_EXCLUSIONS = Object.freeze({
  /**
   * No certification evidence at all: an old copy, a snapshot nobody checked, OR
   * — since 2026-11-01 — a copy that carries a stamp (`certifiedBy=full-checks`)
   * but no criterion that can be re-checked. The last one is the historical
   * pollution: its stamp says who signed, never what was checked, so it is
   * refused exactly like a copy with no stamp at all. See
   * `CERTIFICATION_EVIDENCE` in lib/backup.js.
   */
  NOT_CERTIFIED: 'not-certified',
  /** The boot that certified it had to be rescued by the system. */
  INTERVENED: 'intervened',
  /** Certified, but nobody recorded whether that boot needed help. */
  INTERVENTION_UNKNOWN: 'intervention-unknown',
});

/**
 * CHOOSE THE ONE COPY THE WATCHDOG MAY RESTORE (2026-11-01, strict mode).
 *
 * The rule the user decided on: a copy may only be restored when it is CERTIFIED
 * — and "certified" now means BOTH halves: a real source AND a criterion that can
 * be re-checked (`certificationEvidence === 'fingerprint-match'`), as computed by
 * `isCertifiedBackup` in lib/backup.js. A copy that merely names a source is NOT
 * certified: the two broken configurations on the hosted instance (71B / 70B of
 * `cordis.patch.yml`, both stamped `certifiedBy=full-checks` by the old code) are
 * exactly that shape, and they must never be picked again.
 *
 * AND nothing on record may say the boot that certified it had to be rescued
 * (`intervention` is not true). Two consequences, both deliberate:
 *
 *   - `intervention === null` means "nobody recorded it". It is NOT treated as
 *     "no intervention": a certified copy whose provenance is unknown is not
 *     trusted, and the report says so in those words. That is the difference
 *     between "we checked" and "we did not hear otherwise".
 *   - `intervention === true` is refused even when `certifiedBy` is
 *     'full-checks'. A copy whose boot needed rescuing describes a state that
 *     was already being fixed by somebody else; restoring it would put the
 *     repaired state back under a config that broke.
 *
 * NO FALLBACK: when nothing qualifies, the answer is `target: null` with
 * `strict: true` and the full `excluded` list. It never degrades to "try the
 * newest copy anyway" — the user chose strict mode, and a silent fallback is
 * exactly how the bad copy got certified in the first place.
 *
 * @param {{ candidates?: Array<object> }} [options] the copies, newest first
 * @returns {{
 *   target: string|null,
 *   targetName: string|null,
 *   strict: boolean,
 *   reason: string,
 *   excluded: Array<{ dir: string|null, name: string|null, certifiedBy: string, certificationEvidence: string|null, intervention: boolean|null, exclusion: string }>,
 *   notes: string[],
 * }}
 */
export function selectRestoreTarget({ candidates = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const excluded = []
  const notes = []
  for (const candidate of list) {
    if (candidate === null || typeof candidate !== 'object') continue
    const dir = typeof candidate.dir === 'string' && candidate.dir !== '' ? candidate.dir : null
    const name = typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : null
    const certifiedBy = typeof candidate.certifiedBy === 'string' && candidate.certifiedBy !== ''
      ? candidate.certifiedBy
      : 'none'
    const intervention = typeof candidate.intervention === 'boolean' ? candidate.intervention : null
    // THE QUALIFICATION IS THE NEW `certified`, NOT `certifiedBy` (2026-11-01).
    //
    // `certified` comes from `listBackupIdentities`, i.e. from `isCertifiedBackup`:
    // a real source AND `certificationEvidence === 'fingerprint-match'`. The check
    // is repeated on the evidence itself because this function is the LAST gate
    // before a file tree is copied over the live profile, and it is also called
    // with candidates that did not come from today's listing (a marker written by
    // an older build). Trusting a `certified: true` flag alone would be the same
    // mistake in a new place — the flag is exactly as falsifiable as the stamp it
    // replaced.
    const certified = candidate.certified === true
      && candidate.certifiedBy !== 'none'
      && candidate.certificationEvidence === CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH
    if (certified !== true) {
      // 'none' is reported for a copy with no stamp at all; a copy that DOES name
      // a source but records no criterion keeps the name, because "it says
      // full-checks and I still refuse it" is the sentence the operator has to
      // read: it is exactly the historical pollution this change is about.
      excluded.push({
        dir,
        name,
        certifiedBy: certifiedBy === 'none' ? 'none' : certifiedBy,
        certificationEvidence: typeof candidate.certificationEvidence === 'string'
          ? candidate.certificationEvidence
          : null,
        intervention,
        exclusion: RESTORE_EXCLUSIONS.NOT_CERTIFIED,
      })
      if (certifiedBy !== 'none') {
        // SAID OUT LOUD, because this is the case the whole change is about: the
        // copy carries a stamp (`certifiedBy=full-checks`) and is still refused,
        // because no criterion was recorded for it. Silence here would read like
        // "there is nothing to restore", which is a different fact.
        notes.push(
          'a copy stamped by ' + certifiedBy + ' was not used: it records no verifiable certification'
            + ' criterion (a stamp nobody can check is not a stamp), so it is not trusted',
        )
      }
      continue
    }
    if (intervention === true) {
      excluded.push({ dir, name, certifiedBy, intervention, exclusion: RESTORE_EXCLUSIONS.INTERVENED })
      continue
    }
    if (intervention === null) {
      excluded.push({ dir, name, certifiedBy, intervention, exclusion: RESTORE_EXCLUSIONS.INTERVENTION_UNKNOWN })
      notes.push(
        'a copy certified by ' + certifiedBy + ' was not used: nobody recorded whether that boot had to be rescued',
      )
      continue
    }
    if (dir === null) {
      // A copy without a directory cannot be restored from, whatever it says.
      excluded.push({ dir, name, certifiedBy, intervention, exclusion: RESTORE_EXCLUSIONS.NOT_CERTIFIED })
      continue
    }
    if (excluded.length > 0) {
      notes.push(excluded.length + ' newer cop' + (excluded.length === 1 ? 'y was' : 'ies were')
        + ' skipped before this one (see the excluded list)')
    }
    return {
      target: dir,
      targetName: name,
      strict: false,
      reason: 'certified by ' + certifiedBy + ', and no system intervention is on record',
      excluded,
      notes,
    }
  }
  return {
    target: null,
    targetName: null,
    strict: true,
    reason: list.length === 0
      ? 'there is no backup at all, so there is no trusted restore point'
      : 'no backup qualifies: none of the ' + list.length + ' copies is certified AND free of a recorded intervention',
    excluded,
    notes,
  }
}

/**
 * WHAT THE MARKER SAYS ABOUT THE RESTORE — normalized, in one place.
 *
 * A marker WITHOUT `restoreTargetDir` was written by an older version, which
 * stored a "known-good" directory under `snapshotDir` and no certification
 * evidence at all. Reading such a marker as "restore it" would restore a copy
 * whose provenance nobody recorded — the strict answer is "blocked, and say
 * why".
 *
 * @param {object|null|undefined} pending
 * @returns {{ dir: string, blocked: boolean, reason: string, candidates: Array<object>, legacy: boolean }}
 */
export function restoreTargetInfoOf(pending) {
  const marker = pending !== null && pending !== undefined && typeof pending === 'object' ? pending : {}
  const dir = typeof marker.restoreTargetDir === 'string' ? marker.restoreTargetDir : ''
  const legacyDir = typeof marker.snapshotDir === 'string' ? marker.snapshotDir : ''
  const candidates = Array.isArray(marker.restoreCandidates) ? marker.restoreCandidates : []
  if (dir !== '') {
    return {
      dir,
      blocked: false,
      reason: typeof marker.restoreBlockedReason === 'string' ? marker.restoreBlockedReason : '',
      candidates,
      legacy: false,
    }
  }
  if (marker.restoreBlocked === true) {
    return {
      dir: '',
      blocked: true,
      reason: typeof marker.restoreBlockedReason === 'string' && marker.restoreBlockedReason !== ''
        ? marker.restoreBlockedReason
        : 'no backup qualifies as a trusted restore point',
      candidates,
      legacy: false,
    }
  }
  if (legacyDir !== '') {
    // An OLD marker: it names a directory, but records no certification and no
    // intervention. Strict mode says: do not restore it, and say why.
    return {
      dir: '',
      blocked: true,
      reason: 'this restart was armed by an older version, which recorded no certification evidence — the copy is not trusted',
      candidates,
      legacy: true,
    }
  }
  return {
    dir: '',
    blocked: true,
    reason: 'this restart was armed without a restore target',
    candidates,
    legacy: false,
  }
}


/**
 * @param {string} stateDir
 * @returns {string}
 */
export function pendingPath(stateDir) {
  return path.join(stateDir, PENDING_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function readyPath(stateDir) {
  return path.join(stateDir, READY_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function reportPath(stateDir) {
  return path.join(stateDir, REPORT_NAME);
}

/**
 * Write the pending marker.
 *
 * @param {string} stateDir
 * @param {object} pending
 */
export function writePending(stateDir, pending) {
  writeJson(pendingPath(stateDir), pending);
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readPending(stateDir) {
  return readJson(pendingPath(stateDir));
}

/**
 * Remove the pending marker (the watchdog is over).
 *
 * @param {string} stateDir
 */
export function clearPending(stateDir) {
  try {
    fs.rmSync(pendingPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Write the ready marker: "the new host is up".
 *
 * @param {string} stateDir
 * @param {{ bootId?: string, port?: number, at?: number }} [info]
 */
export function writeReady(stateDir, info = {}) {
  writeJson(readyPath(stateDir), {
    at: new Date(info.at ?? Date.now()).toISOString(),
    bootId: info.bootId ?? null,
    port: info.port ?? null,
  });
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReady(stateDir) {
  return readJson(readyPath(stateDir));
}

/**
 * Remove the ready marker (it belongs to one restart).
 *
 * @param {string} stateDir
 */
export function clearReady(stateDir) {
  try {
    fs.rmSync(readyPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * The time inside a marker, in milliseconds, or `null` when it carries none.
 *
 * `at` is written as an ISO string (see {@link writeReady}), but an older or
 * hand-written marker may carry milliseconds, so both are understood.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function markerAtMs(value) {
  if (value === null || typeof value !== 'object') return null;
  const raw = value.at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * DOES THIS READY MARKER BELONG TO THIS RESTART?
 *
 * THE BLOCKER THIS EXISTS FOR (2026-11-01, hosted web instance on port 5601):
 * the host was restarted with a broken profile and never came up. The ready
 * marker of the PREVIOUS boot was still on disk (written 09:54:21, the pending
 * marker of the new restart at 09:57:10 — 2m49s apart). {@link readReady} only
 * answered "there is a marker", the flow read that as "the new host is up",
 * waited 0 ms and reported `result: 'not-needed'` with
 * `restored: false, relaunched: false, attempts: 0` while `ss -ltn` showed no
 * listener on 5601 for more than two minutes. A rescue that does nothing must
 * not be indistinguishable from a rescue that was not needed.
 *
 * A ready marker is the receipt of ONE restart: it may only be believed when it
 * was written AT OR AFTER that restart's pending marker. An older marker is the
 * receipt of an earlier boot and says nothing about this one.
 *
 * Two deliberate leniencies, both to keep "a host that is up is never rolled
 * back" (the worst thing this file can do) intact:
 *   - a marker without a usable `at` (a rescue script wrote it by hand) cannot
 *     be attributed to a restart at all, so it is accepted as before;
 *   - a dependency that answers with a bare boolean (only a flow test injects
 *     one) carries no timestamp either, so it is accepted as before.
 * In both cases the flow still asks the health route before touching anything,
 * so a live host is protected by that answer instead of by the clock.
 *
 * @param {unknown} ready the value read from watchdog-ready.json (or a dep's answer)
 * @param {number|string|null|undefined} pendingAt the `at` of THIS restart's pending marker
 * @returns {boolean} true when the marker may be believed
 */
export function readyIsCurrent(ready, pendingAt) {
  if (!ready) return false;
  const since = markerAtMs({ at: pendingAt });
  if (since === null) return true;
  const atMs = markerAtMs(ready);
  if (atMs === null) return true;
  return atMs >= since;
}

/**
 * Write the report of the last watchdog run.
 *
 * @param {string} stateDir
 * @param {object} report
 */
export function writeReport(stateDir, report) {
  writeJson(reportPath(stateDir), report);
}

/** The `outcome` written when the host came up and the watchdog stood down. */
export const REPORT_OUTCOME_DISARMED = 'disarmed';

/**
 * WRITE THE ENDING OF A RESTART THAT WENT FINE (2026-11-01).
 *
 * WHAT WENT WRONG WITHOUT THIS: when a restart succeeded, nobody wrote anything.
 * The report kept the shape it had when the watchdog was ARMED (`result:'armed'`),
 * so `last-watchdog-report.json` said "armed" for a restart that had finished
 * hours earlier — while `health` honestly answered `ready:true` and
 * `scheduleRemoved:true`. Two sources, one of them frozen at the beginning.
 *
 * A report is a record of what HAPPENED, so the ending belongs in it: the host
 * came up, and the watchdog has nothing left to do.
 *
 * EVERY EXISTING FIELD IS PRESERVED VERBATIM (`...previous`): `tier`, `arbiter`,
 * `waitedMs`, `restored`, `relaunched`, `error`, … keep their names and their
 * meaning, because health, the settings page and the watchdog itself all read
 * this file. Only the ending is added, plus `previousResult`, so a reader can
 * still tell what the file said before this call.
 *
 * Never throws: a failed report must not take the boot down with it.
 *
 * @param {string} stateDir
 * @param {{
 *   now?: number,
 *   record?: object|null,
 * }} [options]
 * @returns {object|null} the merged report (null when there is no state directory)
 */
export function recordDisarmOutcome(stateDir, { now = Date.now(), record = null } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  const previous = (() => {
    try {
      const value = readReport(dir);
      return value !== null && typeof value === 'object' && Array.isArray(value) !== true ? value : {};
    } catch {
      return {};
    }
  })();
  const stamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const merged = {
    ...previous,
    // THE ENDING: the host is up, so nothing may roll it back.
    hostReady: true,
    disarmed: true,
    disarmedAt: new Date(stamp).toISOString(),
    outcome: REPORT_OUTCOME_DISARMED,
    // The old value is kept beside the new one: "it said armed, and then it was
    // disarmed" is a fact worth being able to read back.
    previousResult: typeof previous.result === 'string' ? previous.result : null,
    result: REPORT_OUTCOME_DISARMED,
    stage: REPORT_OUTCOME_DISARMED,
    ready: true,
    // WHAT THE DISARM ITSELF DID, including the probe tasks it cleaned up.
    disarm: record !== null && typeof record === 'object'
      ? {
        at: typeof record.at === 'string' ? record.at : null,
        source: typeof record.source === 'string' ? record.source : null,
        attempts: Number.isFinite(Number(record.attempts)) ? Number(record.attempts) : null,
        ok: record.ok === true,
        scheduleRemoved: record.scheduleRemoved === true
          ? true
          : (record.scheduleRemoved === false ? false : null),
        probesRemoved: record.probes && Array.isArray(record.probes.removed)
          ? record.probes.removed.slice(0, 50)
          : [],
        probesFailed: record.probes && Array.isArray(record.probes.failed)
          ? record.probes.failed.slice(0, 50)
          : [],
      }
      : null,
  };
  try {
    writeReport(dir, merged);
  } catch {
    // A report that cannot be written is not a reason to fail a boot.
  }
  return merged;
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReport(stateDir) {
  return readJson(reportPath(stateDir));
}

/**
 * Take the lock (exactly one restore at a time).
 *
 * @param {string} lockFile
 * @param {{ now?: number, exists?: Function, mkdir?: Function, open?: Function }} [deps]
 * @returns {boolean}
 */
export function acquireLock(lockFile, { now = Date.now(), exists = fs.existsSync, mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }), open = null } = {}) {
  try {
    mkdir(path.dirname(lockFile));
    if (exists(lockFile)) {
      // A lock that is older than 10 minutes belongs to a process that died
      // in the middle of its restore: it must not block the rollback for ever.
      let age = 0;
      try {
        age = now - fs.statSync(lockFile).mtimeMs;
      } catch {
        age = 0;
      }
      if (age > 10 * 60 * 1000) fs.rmSync(lockFile, { force: true });
      else return false;
    }
    const handle = open === null
      ? fs.openSync(lockFile, 'wx')
      : open(lockFile);
    if (handle !== null && handle !== undefined && typeof handle.close === 'function') handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Give the lock back.
 *
 * @param {string} lockFile
 */
export function releaseLock(lockFile) {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * The links a restore has to decide about, with everything the decision needs.
 *
 * It is the UNION of two lists, and both halves matter:
 *
 *   - the links the LIVE profile still has (`collectLinkedPlugins`), and
 *   - the links the BACKUP recorded (`manifest.json` → `links`).
 *
 * A plugin whose `node_modules` entry was deleted is gone from the first list
 * but still in the second — and that is exactly the case this feature exists
 * for ("the plugin that does the rescuing was removed with the profile").
 *
 * WHERE THE COPY COMES FROM is called `restoreTargetDir` (2026-11-01): it is the
 * copy the watchdog is allowed to restore, never "the snapshot of this restart"
 * — the old name said the wrong thing and invited exactly that confusion. The
 * old name is still accepted as an alias so an older caller keeps working.
 *
 * @param {{ restoreTargetDir?: string, snapshotDir?: string, profileDir?: string, collect?: Function }} [options]
 * @returns {Array<{
 *   name: string, target: string, targetExists: boolean, targetReadable: boolean,
 *   hasBackup: boolean, backupPath: string,
 * }>}
 */
export function linkPlanOf({ restoreTargetDir = '', snapshotDir = '', profileDir = '', collect = null } = {}) {
  const requested = typeof restoreTargetDir === 'string' && restoreTargetDir !== '' ? restoreTargetDir : snapshotDir;
  const snapshot = typeof requested === 'string' ? requested : '';
  const profile = typeof profileDir === 'string' ? profileDir : '';
  if (snapshot === '') return [];
  const gather = typeof collect === 'function' ? collect : collectLinkedPlugins;
  const live = (() => {
    try {
      const collected = gather({ profileDir: profile });
      return Array.isArray(collected && collected.links) ? collected.links : [];
    } catch {
      return [];
    }
  })();
  const manifestRead = readJsonState(path.join(snapshot, MANIFEST_NAME));
  const recorded = manifestRead.state === 'ok'
    && manifestRead.value !== null
    && Array.isArray(manifestRead.value.links)
    ? manifestRead.value.links
    : [];

  const plan = [];
  const seen = new Set();
  for (const link of live) {
    const name = typeof link.name === 'string' ? link.name : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const backupPath = path.join(snapshot, LINKS_DIR, name);
    plan.push({
      name,
      target: typeof link.target === 'string' ? link.target : '',
      targetExists: link.exists === true,
      targetReadable: link.readable === true,
      hasBackup: fs.existsSync(backupPath),
      backupPath,
    });
  }
  for (const link of recorded) {
    const name = link && typeof link.name === 'string' ? link.name : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const backupPath = path.join(snapshot, LINKS_DIR, name);
    plan.push({
      name,
      target: typeof link.target === 'string' ? link.target : '',
      // The entry is not in the live profile any more: it was deleted.
      targetExists: false,
      targetReadable: false,
      hasBackup: fs.existsSync(backupPath),
      backupPath,
    });
  }
  plan.sort((left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)));
  return plan;
}

/**
 * Put the snapshot back.
 *
 * The same for every platform: the configuration files and the plugin tree
 * are copied out of the snapshot into the profile. (The profile is NOT
 * deleted first — the broken files are overwritten, so a half-restored
 * profile is never worse than the broken one.)
 *
 * THE LINKED PLUGINS (2026-10-30). A `link:` installation puts a reparse point
 * in `node_modules/<name>`, so the tree copy above brings back the LINK and
 * nothing behind it. A host cannot start from a link whose target is gone, and
 * this plugin — the one doing the rescuing — is itself installed that way. The
 * decision is therefore made per link, with the SAME function the restore
 * script uses (`decideLinkRestore` in lib/backup.js), so a manual restore and
 * an automatic one cannot disagree:
 *
 *   - target there and readable, first attempt -> KEEP the link (the
 *     development directory keeps working);
 *   - target gone / unreadable, forced, or a later attempt -> REPLACE it with
 *     the contents the backup holds;
 *   - no backup content -> leave the link alone and say so (never delete what
 *     cannot be replaced).
 *
 * @param {{
 *   restoreTargetDir?: string, snapshotDir?: string, profileDir?: string, copy?: Function,
 *   attempts?: number, forceLinkPlugins?: boolean,
 *   collectLinks?: Function, decideLink?: Function,
 *   exists?: Function, removeLink?: Function,
 * }} options
 * @returns {{ ok: boolean, error: string|null, copied: string[], links: Array<object> }}
 */
export function restoreFromSnapshot({
  restoreTargetDir = '',
  snapshotDir = '',
  profileDir = '',
  copy = null,
  attempts = 1,
  forceLinkPlugins = false,
  collectLinks = null,
  decideLink = null,
  exists = null,
  removeLink = null,
} = {}) {
  const requested = typeof restoreTargetDir === 'string' && restoreTargetDir !== '' ? restoreTargetDir : snapshotDir;
  const from = String(requested ?? '');
  const into = String(profileDir ?? '');
  if (from === '' || into === '') {
    return { ok: false, error: 'the snapshot or the profile directory is unknown', copied: [], links: [] };
  }
  const copied = [];
  const linkReport = [];
  const copyInto = copy === null
    ? (source, target) => { fs.cpSync(source, target, { recursive: true, force: true }); }
    : copy;
  // A DANGLING reparse point is invisible to `fs.existsSync` (it follows the
  // link and the target is gone) but it IS an entry that `fs.cpSync` will try
  // to write into - which kills the whole process on Windows (0xC0000409).
  // `lstatSync` does not follow, so it answers "the entry is there".
  const isThere = typeof exists === 'function'
    ? exists
    : (target) => {
      try {
        fs.lstatSync(target);
        return true;
      } catch {
        return false;
      }
    };
  // The default remover deletes the REPARSE POINT, never the directory behind
  // it: on Windows `[System.IO.Directory]::Delete(path, false)` removes a
  // junction/symlink itself, while `rm -rf` would delete the target's contents
  // (that would take the development tree with it).
  const dropLink = typeof removeLink === 'function'
    ? removeLink
    : (target) => {
      try {
        fs.unlinkSync(target);
      } catch {
        fs.rmdirSync(target);
      }
    };
  // THE DEFAULT PLAN comes from lib/backup.js, so this file and the restore
  // script run the SAME decision (and the same rules) instead of two opinions
  // that drift apart. The CLI does not have to pass anything.
  const gather = typeof collectLinks === 'function'
    ? collectLinks
    : (input) => linkPlanOf({ snapshotDir: input.snapshotDir, profileDir: input.profileDir });
  const judge = typeof decideLink === 'function' ? decideLink : decideLinkRestore;

  // -------------------------------------------------------------------------
  // ORDER MATTERS, and it was measured the hard way: `fs.cpSync` into a
  // node_modules that still holds a DANGLING junction/junction-like reparse
  // point kills the Node process outright on Windows (0xC0000409, no stack, no
  // message, nothing written) - the probe is in the task report. So every link
  // whose target is gone is removed BEFORE the tree copy, and only then are the
  // contents of the backup put in its place.
  // -------------------------------------------------------------------------
  const planned = [];
  try {
    for (const link of gather({ snapshotDir: from, profileDir: into })) {
      const verdict = judge({
        targetExists: link.targetExists === true,
        targetReadable: link.targetReadable === true,
        hasBackup: link.hasBackup === true,
        force: forceLinkPlugins === true,
        attempts,
      });
      const entry = {
        name: link.name,
        target: link.target,
        hasBackup: link.hasBackup === true,
        backupPath: link.backupPath,
        action: verdict.action,
        reason: verdict.reason,
        replace: verdict.replace === true,
        cleared: false,
      };
      // A link that points nowhere is cleared whether or not a copy is going in:
      // leaving it there crashes the copy (above) and cannot start a host.
      const broken = link.targetExists !== true || link.targetReadable !== true;
      if (entry.replace === true || broken === true) {
        const livePath = path.join(into, 'node_modules', link.name);
        if (isThere(livePath)) {
          try {
            dropLink(livePath);
            entry.cleared = true;
          } catch (error) {
            entry.clearError = error && error.message ? error.message : String(error);
          }
        }
      }
      planned.push(entry);
    }
  } catch (error) {
    linkReport.push({ name: '', action: 'error', reason: error && error.message ? error.message : String(error) });
  }

  try {
    for (const [part, target] of [['config', into], ['node_modules', path.join(into, 'node_modules')]]) {
      const source = path.join(from, part);
      if (!fs.existsSync(source)) continue;
      copyInto(source, target);
      copied.push(part);
    }
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      copied,
      links: linkReport.concat(planned.map((entry) => ({
        name: entry.name,
        target: entry.target,
        action: entry.action,
        reason: entry.reason,
      }))),
    };
  }

  // THE LINKS, one decision each, after the tree is back. A failure here is
  // reported, never thrown: the configuration and the tree are already restored.
  for (const entry of planned) {
    const reported = { name: entry.name, target: entry.target, action: entry.action, reason: entry.reason };
    if (entry.replace === true && entry.hasBackup === true) {
      const livePath = path.join(into, 'node_modules', entry.name);
      try {
        if (isThere(livePath)) dropLink(livePath);
        copyInto(entry.backupPath, livePath);
        reported.replaced = true;
        copied.push(path.join('node_modules', entry.name));
      } catch (error) {
        reported.replaced = false;
        reported.error = error && error.message ? error.message : String(error);
      }
    } else if (entry.cleared === true) {
      // No copy to put back: the dead link is gone and the report says so.
      reported.cleared = true;
    }
    linkReport.push(reported);
  }

  return {
    ok: copied.length > 0,
    error: copied.length > 0 ? null : 'the snapshot carries nothing to restore',
    copied,
    links: linkReport,
  };
}

/**
 * Wait for the ready marker.
 *
 * @param {object} deps
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForReady(deps, timeoutMs) {
  const deadline = deps.now() + Math.max(0, timeoutMs);
  while (deps.now() < deadline) {
    if (deps.readReady()) return true;
    // The plugin may have decided on its own (the restart failed): stand down.
    if (deps.isWithdrawn && deps.isWithdrawn()) return false;
    await deps.sleep(Math.min(deps.pollMs, Math.max(0, deadline - deps.now())));
  }
  // `Boolean(...)`, NOT `=== true`: the real reader answers with the marker
  // OBJECT (or null), so `=== true` made this last look never count — a host
  // whose marker appeared exactly at the deadline was reported as not coming
  // up. The value has already been filtered through `readyIsCurrent` by the
  // caller (see runWatchdogFlow), so a marker of an EARLIER restart is `null`
  // here and cannot be counted either.
  return Boolean(deps.readReady());
}

/**
 * Normalize the answer of the health question.
 *
 * The dependency may answer with a plain string ('healthy' | 'unhealthy' |
 * 'unknown') or with `{ state, detail }` — the CLI uses the second form, so the
 * report can say WHY the host was believed to be up (a health route answered, or
 * an instance of the new boot is clearly running).
 *
 * @param {unknown} value
 * @returns {{ state: string, detail: string|null }}
 */
function healthAnswer(value) {
  if (value && typeof value === 'object') {
    const state = typeof value.state === 'string' ? value.state : 'unknown';
    const detail = typeof value.detail === 'string' && value.detail !== '' ? value.detail : null;
    return { state, detail };
  }
  return { state: typeof value === 'string' ? value : 'unknown', detail: null };
}

/**
 * Normalize the answer of the cookie cleanup.
 *
 * The cleanup script always exits 0 (a restart must never be blocked by a
 * cleanup), so the answer of the runner means "the cleanup process finished",
 * not "cookies were deleted". `removed` is the count when the runner knows it
 * and `null` when it does not — a count that was never measured is reported as
 * not measured, never as 0.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, removed: number|null, error: string|null }}
 */
function cookieClearAnswer(value) {
  if (value === null || value === undefined) {
    return { ok: false, removed: null, error: 'the cookie cleanup was not run' };
  }
  if (typeof value === 'object') {
    const ok = value.ok === true;
    const count = Number(value.removed);
    const removed = value.removed === null || value.removed === undefined || !Number.isFinite(count)
      ? null
      : Math.trunc(count);
    const detail = typeof value.error === 'string' && value.error !== '' ? value.error : null;
    return { ok, removed, error: ok ? detail : (detail ?? 'the cookie cleanup failed') };
  }
  const ok = value === true;
  return { ok, removed: null, error: ok ? null : 'the cookie cleanup failed' };
}

/**
 * Run the cleanup, and never let it break the rescue.
 *
 * A thrown cleanup is an answer like any other: `{ ok:false, error }` — the
 * caller records it in the report and goes on to start the host, because a
 * host that starts with stale cookies is still better than a host that never
 * starts at all.
 *
 * @param {object} deps
 * @returns {Promise<{ ok: boolean, removed: number|null, error: string|null }>}
 */
async function runCookieClear(deps) {
  try {
    return cookieClearAnswer(await deps.clearCookies());
  } catch (error) {
    return {
      ok: false,
      removed: null,
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * THE FLOW.
 *
 * @param {{
 *   pending: object,
 *   stateDir?: string,
 *   deps?: object,
 * }} options
 * @returns {Promise<object>} the report
 */
export async function runWatchdogFlow({ pending, stateDir = '', deps = {} }) {
  const d = {
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollMs: DEFAULT_POLL_MS,
    readReady: () => readReady(stateDir),
    isWithdrawn: () => readPending(stateDir) === null,
    probeAlive: () => false,
    // THE HEALTH QUESTION (see step 3b): 'healthy' | 'unhealthy' | 'unknown'.
    // The CLI answers it with a real HTTP request; a flow test injects it.
    askHealth: () => 'unknown',
    runRestore: () => ({ ok: false, error: 'no restore command' }),
    runRelaunch: () => ({ ok: false, error: 'no relaunch command' }),
    // THE HANDSHAKE COOKIES (see lib/cookie-clear.js). The CLI runs the real
    // cleanup script; a flow test injects it. The default REFUSES instead of
    // pretending: a report that says "the cookies were cleared" when nobody
    // cleared them is worse than a report that says nobody tried.
    clearCookies: () => ({ ok: false, removed: null, error: 'no cookie cleanup is wired' }),
    acquireLock: () => true,
    releaseLock: () => {},
    removeSchedule: () => {},
    writeReport: (report) => writeReport(stateDir, report),
    ...deps,
  };
  const startedAt = d.now();
  const report = {
    at: new Date(startedAt).toISOString(),
    result: 'unknown',
    tier: pending && pending.tier ? pending.tier : 'none',
    tierReason: pending && pending.tierReason ? pending.tierReason : '',
    // WHO watched this restart. There is only ever one watchdog at a time
    // (see lib/watchdog-arbiter.js), and the report says which one it was.
    arbiter: pending && pending.arbiter ? pending.arbiter : 'v2',
    waitedMs: 0,
    rechecked: false,
    // What the health route of the host itself said before anything was
    // restored: 'healthy' (stood down), 'unhealthy' (really down) or
    // 'unknown' (there was no port to ask).
    healthCheck: 'unknown',
    healthDetail: null,
    health: null,
    extraRound: false,
    restored: false,
    // WHICH COPY WAS RESTORED (2026-11-01). Until now the report said `restored:
    // true` and nothing else — "which copy did you put back?" was unanswerable
    // from the report, which is exactly the question a human asks afterwards.
    restoredFrom: null,
    // HOW OFTEN a restore was performed. It is 0 or 1 by design (see MAX_RESTORES):
    // restoring the SAME copy twice changes nothing, and doing it three times was
    // measured hitting the same wall three times.
    restores: 0,
    relaunched: false,
    ready: false,
    // THE STRICT-MODE ANSWER: when no copy qualifies, `strictMode` is true and
    // `restoreCandidates` holds every copy that was looked at, with the reason
    // each one was refused.
    strictMode: false,
    restoreTarget: null,
    restoreBlocked: false,
    restoreBlockedReason: null,
    restoreCandidates: [],
    // WAS THERE A READY MARKER AND WAS IT REFUSED? A marker of an EARLIER
    // restart (its `at` is before this restart's pending `at`) is read and
    // thrown away (see readyIsCurrent). The 2026-11-01 run said nothing at all
    // about this and looked like a run that had nothing to do, so the refusal
    // is REPORTED: `staleReadyIgnored` says it happened, `staleReadyAt` says
    // which marker it was.
    staleReadyIgnored: false,
    staleReadyAt: null,
    error: null,
    // WHERE the run stood when it ended, so "the rescue failed" and "I never
    // got going" can never be confused: 'flow' (the flow ran), 'relaunch'
    // (the host could not be started again). The CLI writes 'import' and
    // 'config' for a run that could not even read its own marker.
    stage: 'flow',
    // HOW OFTEN this run was allowed to try, and how often it did.
    maxAttempts: maxAttemptsOf(pending),
    attempts: 0,
    // The LAST cookie cleanup, and one entry per attempt (never silent).
    cookieClear: null,
    attemptLog: [],
  };
  // THE READY MARKER OF AN EARLIER RESTART IS NOT A RECEIPT OF THIS ONE.
  //
  // Every read of the marker inside this flow goes through `readCurrentReady`,
  // never through `d.readReady()` directly: a marker written BEFORE this
  // restart's pending marker (`pending.at`) belongs to the boot that was
  // replaced, and believing it is exactly the 2026-11-01 blocker — the host
  // never came up, the old marker said "it is up", the flow waited 0 ms and
  // reported `result: 'not-needed'` with nothing restored and nothing started
  // while port 5601 stayed empty for more than two minutes.
  const pendingAt = pending && pending.at !== undefined ? pending.at : null;
  // WHAT THE MARKER SAYS THIS RUN MAY RESTORE — read once, reported always.
  // It is filled in BEFORE the first look at the ready marker so the fields also
  // exist for a run that ends with "not-needed": an operator reading the report
  // should never have to guess whether a target existed.
  const target = restoreTargetInfoOf(pending);
  report.restoreTarget = target.dir === '' ? null : target.dir;
  report.restoreBlocked = target.blocked;
  report.restoreBlockedReason = target.reason === '' ? null : target.reason;
  report.restoreCandidates = target.candidates;
  const readCurrentReady = () => {
    const value = d.readReady();
    // "Nothing there yet" is not a refused marker: it is the normal first look.
    if (!value) return value;
    if (readyIsCurrent(value, pendingAt)) return value;
    report.staleReadyIgnored = true;
    report.staleReadyAt = typeof value.at === 'string' ? value.at : null;
    return null;
  };
  // `waitForReady` keeps its signature: it is handed the same dependencies with
  // ONE reader swapped for the filtered one, so a stale marker cannot make it
  // return true either.
  const readyDeps = { ...d, readReady: readCurrentReady };
  try {
    // (1) The new host writes the ready marker after its health check.
    const ready = await waitForReady(readyDeps, pending.timeoutMs);
    if (ready) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (2) ASK AGAIN. A host that is slow to start is not a host that is dead.
    report.rechecked = true;
    await d.sleep(Math.max(0, pending.recheckMs));
    if (readCurrentReady()) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (3) Is an instance ALIVE? Then there is nothing to restore.
    if (await d.probeAlive()) {
      report.result = 'abandoned';
      report.error = 'an instance is alive: the snapshot was not restored';
      return report;
    }

    // (3b) THE LAST QUESTION BEFORE A RESTORE: ask the health route itself.
    //
    // The marker is written by the plugin, so it can be missing while the host
    // is perfectly healthy (0.8.1: the write threw and the error was
    // swallowed). A restore of a live host is the worst thing this file can
    // do, so the host gets asked directly — and only a host that does not
    // answer may be rolled back.
    const health = healthAnswer(await d.askHealth());
    report.healthCheck = health.state;
    report.healthDetail = health.detail;
    if (health.state === 'healthy') {
      report.result = 'not-needed';
      report.health = 'healthy';
      report.error = 'the host answered: it is up, the snapshot was NOT restored'
        + (health.detail === null ? '' : ' (' + health.detail + ')');
      return report;
    }
    if (health.state === 'unknown') {
      // There was no port to ask (no instance record, no health URL). One more
      // round is waited, and the leftovers are looked at again: a host that is
      // still starting gets this last chance before anything is restored.
      report.extraRound = true;
      await d.sleep(Math.max(0, pending.recheckMs));
      if (readCurrentReady()) {
        report.result = 'not-needed';
        report.ready = true;
        return report;
      }
      if (d.isWithdrawn()) {
        report.result = 'decided';
        report.error = 'the plugin decided on its own: the watchdog stood down';
        return report;
      }
      if (await d.probeAlive()) {
        report.result = 'abandoned';
        report.error = 'an instance is alive: the snapshot was not restored';
        return report;
      }
      const lateHealth = healthAnswer(await d.askHealth());
      report.healthCheck = lateHealth.state;
      report.healthDetail = lateHealth.detail;
      if (lateHealth.state === 'healthy') {
        report.result = 'not-needed';
        report.health = 'healthy';
        report.error = 'the host answered: it is up, the snapshot was NOT restored'
          + (lateHealth.detail === null ? '' : ' (' + lateHealth.detail + ')');
        return report;
      }
    }

    // (4) THE LOCK: exactly ONE of us restores. And before it: STRICT MODE.
    //
    // A restore is only allowed when the marker names a copy the ARMING side was
    // allowed to pick — certified, and free of a recorded system intervention.
    // When it names none, the strict-mode decision the user took applies: do NOT
    // touch anything (no lock, no restore, no relaunch — a relaunch of a broken
    // profile is not a rescue), and say it out loud with the list of copies that
    // were refused, so a human knows exactly what to do next.
    //
    // "Not touching it" is NOT the same as staying silent: a run that ends
    // quietly looks like a run that found nothing to do, and that is how the bad
    // state stayed certified in the first place. (`target` is read at the top of
    // the flow, so the same fields are in a report that ends 'not-needed'.)
    if (target.dir === '' || target.blocked === true) {
      report.result = 'failed';
      report.stage = 'strict';
      report.strictMode = true;
      report.error = 'no trusted restore point: nothing was restored or started'
        + (target.reason === '' ? '' : ' (' + target.reason + ')');
      return report;
    }
    if (!d.acquireLock()) {
      report.result = 'abandoned';
      report.error = 'another rollback is already running';
      return report;
    }
    try {
      // (5) THE PASS: up to `maxAttempts` tries (3 by default, never endless).
      //
      // Every try AFTER the first asks the three questions of steps (1)-(3b)
      // again, because the world changed in between: the host we started may
      // have come up (a slow boot is not a dead host) and another instance may
      // be alive (a second start next to a running host is the double start
      // this whole file exists to prevent). The FIRST try does not ask again:
      // those three answers are a moment old and cannot have changed.
      //
      // The pass order is fixed and must stay that way:
      //   ready? -> alive? -> health? -> restore -> CLEAR THE COOKIES -> start -> wait
      let restoreNeeded = true;
      for (let attempt = 1; attempt <= report.maxAttempts; attempt += 1) {
        if (attempt > 1) {
          if (readCurrentReady()) {
            report.result = 'not-needed';
            report.ready = true;
            report.error = null;
            break;
          }
          if (d.isWithdrawn()) {
            report.result = 'decided';
            report.error = 'the plugin decided on its own: the watchdog stood down';
            break;
          }
          if (await d.probeAlive()) {
            report.result = 'abandoned';
            report.error = 'an instance is alive: the host was not started again';
            break;
          }
          const again = healthAnswer(await d.askHealth());
          report.healthCheck = again.state;
          report.healthDetail = again.detail;
          if (again.state === 'healthy') {
            report.result = 'not-needed';
            report.health = 'healthy';
            report.error = 'the host answered: it is up, it was NOT started again'
              + (again.detail === null ? '' : ' (' + again.detail + ')');
            break;
          }
          if (again.state === 'unknown') {
            // There is still no port to ask: one more round, then look again.
            await d.sleep(Math.max(0, pending.recheckMs));
            if (readCurrentReady()) {
              report.result = 'not-needed';
              report.ready = true;
              report.error = null;
              break;
            }
            if (d.isWithdrawn()) {
              report.result = 'decided';
              report.error = 'the plugin decided on its own: the watchdog stood down';
              break;
            }
            if (await d.probeAlive()) {
              report.result = 'abandoned';
              report.error = 'an instance is alive: the host was not started again';
              break;
            }
          }
        }

        report.attempts = attempt;
        const entry = {
          attempt,
          at: new Date(d.now()).toISOString(),
          restored: false,
          // WHICH COPY this attempt put back (null when it did not restore). A
          // report that only said "restored: true" could never answer "from
          // what", which is the first thing a human asks afterwards.
          restoredFrom: null,
          cookieClear: null,
          relaunched: false,
          ready: false,
          // The marker of an earlier restart was read and refused before this
          // attempt began: one entry says it, next to what this attempt did.
          staleReadyIgnored: report.staleReadyIgnored === true,
          backoffMs: 0,
          error: null,
        };
        report.attemptLog.push(entry);

        // (d) Put the copy back — AT MOST ONCE (2026-11-01).
        //
        // Restoring the SAME copy again cannot change anything: the bytes are
        // identical. Measured on the real machine, three attempts restored the
        // same copy three times and hit the same wall three times. So a restore
        // happens once; what may be repeated is the START (`relaunch`), because
        // a host that died for an unrelated reason can come up on the next try.
        if (restoreNeeded && report.restores < MAX_RESTORES) {
          const restored = d.runRestore();
          report.restores += 1;
          report.restored = restored !== null && restored !== undefined && restored.ok === true;
          entry.restored = report.restored;
          if (!report.restored) {
            restoreNeeded = false;
            report.result = 'failed';
            report.error = (restored && restored.error ? restored.error : 'the restore failed')
              + ': the restore is NOT retried (the same copy would be restored again)';
            entry.error = report.error;
            break;
          }
          restoreNeeded = false;
          // The copy the watchdog actually put back: what the marker armed, or
          // what the restore implementation reports it used.
          const used = restored && typeof restored.dir === 'string' && restored.dir !== ''
            ? restored.dir
            : target.dir;
          report.restoredFrom = used === '' ? null : used;
          entry.restoredFrom = report.restoredFrom;
        }

        // (e) THE HANDSHAKE COOKIES, AFTER the restore and BEFORE the start.
        //
        // The desktop app mints one `dsh-auth-*` cookie per launch, the cookie
        // lives 30 days, and the host answers 431 when the Cookie header
        // overflows (71 cookies, measured). Starting the host again with the
        // stale cookies therefore kills it again — that is what happened on
        // 2026-10-30. The cleanup runs once Chromium has left (the host is
        // confirmed dead above), and it never blocks the rescue: the script
        // itself always exits 0 for that reason. But it is ALWAYS written into
        // the report: a cleanup that could not run must never look like one
        // that did.
        const cookie = await runCookieClear(d);
        report.cookieClear = cookie;
        entry.cookieClear = cookie;
        if (!cookie.ok) {
          entry.error = 'the stale cookies could not be cleared: ' + (cookie.error || 'unknown reason');
        }

        // (f) Start the host again — but look at the marker ONE last time: the
        //     host may have finished its boot while the cleanup and the
        //     restore ran, and a host that is up must not be started again.
        if (readCurrentReady()) {
          report.result = 'not-needed';
          report.ready = true;
          report.error = 'the host came up while the watchdog was working: it was NOT started again';
          break;
        }
        const relaunched = d.runRelaunch();
        report.relaunched = relaunched !== null && relaunched !== undefined && relaunched.ok === true;
        entry.relaunched = report.relaunched;
        if (!report.relaunched) {
          report.result = 'failed';
          // "I could not start it" is not "the rescue failed after trying":
          // the report says where it stood.
          report.stage = 'relaunch';
          report.error = relaunched && relaunched.error ? relaunched.error : 'the host could not be started again';
          entry.error = report.error;
          break;
        }

        // (g) Did it come up this time?
        const readyAgain = await waitForReady(readyDeps, pending.readyTimeoutMs);
        report.ready = readyAgain;
        entry.ready = readyAgain;
        if (readyAgain) {
          report.result = 'recovered';
          report.error = null;
          break;
        }
        report.result = 'failed';
        report.error = 'the host did not come up after the restore';
        if (attempt < report.maxAttempts) {
          const wait = backoffMsFor(attempt);
          entry.backoffMs = wait;
          await d.sleep(wait);
        }
      }
      // The message of a run that ran out of attempts must SAY so: "failed"
      // alone would hide that the watchdog tried, and how often. It also has to
      // say that NOTHING ELSE WILL PICK IT UP: this is the last automatic step,
      // so a human has to look at the report. And it says WHICH copy was put
      // back and that the restore is not repeated — the two facts the reader
      // needs to decide what to do next.
      if (report.result === 'failed' && report.stage === 'flow' && report.relaunched === true) {
        report.error = 'the host did not come up after ' + report.attempts + ' attempt(s) of '
          + report.maxAttempts + ' (last error: ' + String(report.error) + '): the copy '
          + (report.restoredFrom === null ? '(unknown)' : String(report.restoredFrom))
          + ' was restored ONCE and is not restored again — no further rollback will be attempted';
      }
      if (report.result === 'unknown') {
        report.result = 'failed';
        report.error = 'the flow ended without an answer';
      }
    } finally {
      d.releaseLock();
    }
  } catch (error) {
    report.result = 'failed';
    report.error = error && error.message ? error.message : String(error);
  } finally {
    report.waitedMs = d.now() - startedAt;
    // ★ 收尾顺序是有理由的，不许调回去（2026-11-01 回归，由 14e9a6b 引入）。
    //
    // 为什么必须先写报告：最后一步 d.removeSchedule() 在 CLI 那条路上执行的是
    // `systemctl --user stop dsh-autorestart-watchdog.service` —— 那正是承载本
    // 进程的 service（见 scripts/watchdog.mjs 注进去的 removeSchedule）。service
    // 一停，systemd 就给这个进程发 SIGTERM，于是写在清理之后的报告永远到不了盘
    // 上：守夜人明明救成功了，客户打开报告看到的却还停在启动那一刻的 `armed`
    // （「武装好了，什么也没发生」）。这比没有守夜人更糟——下一次出问题，没人
    // 知道上一次是被救回来的。
    //
    // 所以顺序固定为：写报告 → 清 pending → 清理调度项（唯一可能终止自己的动作）。
    // test/watchdog-report-order.test.mjs 用「清理动作发生的那一刻，盘上必须已经
    // 是本次救援结果」守住这三行的顺序。
    try {
      d.writeReport(report);
    } catch (error) {
      // 报告写不出去是必须看得见的失败：stderr 一行日志 + 返回值上的字段，
      // CLI 用 reportWriteError 决定退出码。但不许因此跳过清理（调度项必须被
      // 清掉），所以这里只记录、不重抛。
      report.reportWritten = false;
      report.reportWriteError = error && error.message ? error.message : String(error);
      try {
        console.error(
          'dsh-autorestart watchdog: the report could not be written to '
          + (stateDir === '' ? '(no state directory)' : stateDir)
          + ': ' + report.reportWriteError,
        );
      } catch {
        // 连 stderr 都写不出去也不再抛：清理仍然要发生。
      }
    }
    try {
      if (stateDir !== '') clearPending(stateDir);
    } catch {
      // It is gone either way.
    }
    try {
      d.removeSchedule();
    } catch {
      // The scheduling item is cleaned up by the next run if this fails.
    }
  }
  return report;
}
