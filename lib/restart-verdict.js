/**
 * dsh-autorestart — the durable record of ONE restart.
 *
 * A restart has TWO halves that live in two different processes:
 *
 *   - the instance that is being replaced takes the pre-restart snapshot and
 *     then dies (the restart command kills it — that IS what restarting the
 *     host means);
 *   - the instance that replaces it has to prove that it really came up.
 *
 * Neither half can write the whole truth on its own, so the record lives in a
 * FILE that both halves touch:
 *
 *   1. the OLD instance writes `result: 'pending'` BEFORE it runs the restart
 *      command — together with the snapshot it took (directory name, how long
 *      it took, which older snapshots were pruned);
 *   2. the NEW instance reads that record on boot, runs the four boot checks
 *      (listener / routes / plugin / recovery) and rewrites it as `ok` or
 *      `failed`, with the time it verified itself and how long the whole
 *      restart took.
 *
 * If the new instance never comes up, the file stays `pending` — which is
 * exactly what the operator has to see: a restart that was started and never
 * finished. A record that says nothing is worse than no record at all, so the
 * verdict is ALSO exposed by `/__dsh_autorestart/health?state=1` and by the
 * `continuum_status` tool.
 *
 * The time is reported in BOTH zones: the snapshot directory is named in UTC
 * (`2026-10-29T00-25-20-779Z`), while the operator reads the wall clock of
 * the machine (`08:25`). Comparing the two without a conversion is how a
 * perfectly fresh snapshot looks like an eight-hour-old leftover — so the
 * record carries the local time of the snapshot as well.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The file the verdict lives in (inside the state directory). */
export const RESTART_VERDICT_FILE = 'last-restart-verdict.json';

/** The three results a restart can have. */
export const RESTART_RESULTS = Object.freeze({
  /** The restart was started; nobody confirmed it yet. */
  PENDING: 'pending',
  /** The new instance came up and every check passed. */
  OK: 'ok',
  /** The new instance came up but something did not work. */
  FAILED: 'failed',
});

/** The four checks the new instance runs on itself. */
export const RESTART_CHECK_NAMES = Object.freeze(['listener', 'routes', 'plugin', 'recovery']);

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @param {string|null} fallback */
function nullableString(value, fallback = null) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** @param {unknown} value */
function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * The local time of an epoch, with the UTC offset — the time the operator
 * sees on the machine (`2026-10-29T08:25:20+08:00`).
 *
 * @param {number|null|undefined} at
 * @returns {string|null}
 */
export function localIsoTime(at) {
  if (!isFiniteNumber(at)) return null;
  const date = new Date(Number(at));
  if (Number.isNaN(date.getTime())) return null;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  const local = new Date(Number(at) + offsetMinutes * 60000).toISOString();
  return `${local.slice(0, 19)}${sign}${hours}:${minutes}`;
}

/**
 * The snapshot part of the verdict: WHICH snapshot was taken, how long it
 * took and which older snapshots were pruned.
 *
 * @param {{
 *   requested?: boolean,
 *   backup?: object|null,
 *   profileDir?: string|null,
 *   durationMs?: number|null,
 *   error?: string|null,
 * }} [input]
 * @returns {object}
 */
export function buildSnapshotRecord({
  requested = false,
  backup = null,
  profileDir = null,
  durationMs = null,
  error = null,
} = {}) {
  const taken = isObject(backup) && backup.ok === true;
  const stamp = taken ? nullableString(backup.stamp) : null;
  const at = taken ? nullableNumber(backup.at) : null;
  return {
    requested: requested === true,
    taken,
    dir: taken ? nullableString(backup.dir) : null,
    stamp,
    at,
    // The human-readable time of the snapshot: the directory name is UTC.
    atLocal: at === null ? null : localIsoTime(at),
    durationMs: isFiniteNumber(durationMs) ? Math.trunc(durationMs) : null,
    bytes: taken ? nullableNumber(backup.bytes) : null,
    files: taken && Array.isArray(backup.files) ? backup.files.map(String) : [],
    pruned: taken && Array.isArray(backup.pruned) ? backup.pruned.map(String) : [],
    profileDir: nullableString(profileDir),
    error: nullableString(error) ?? (taken ? null : (nullableString(isObject(backup) ? backup.error : null) ?? 'the snapshot was not taken')),
  };
}

/**
 * Normalize one boot check.
 *
 * @param {unknown} raw
 * @returns {{ name: string, ok: boolean, detail: string|null }}
 */
function normalizeCheck(raw) {
  if (!isObject(raw)) return { name: 'unknown', ok: false, detail: null };
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'unknown',
    ok: raw.ok === true,
    detail: nullableString(raw.detail),
  };
}

/**
 * Build a verdict record from a loose input.
 *
 * @param {{
 *   result?: string,
 *   mode?: string|null,
 *   generation?: number|null,
 *   requestedAt?: number|null,
 *   startedAt?: number|null,
 *   verifiedAt?: number|null,
 *   durationMs?: number|null,
 *   bootId?: string|null,
 *   previousBootId?: string|null,
 *   snapshot?: object|null,
 *   checks?: any[],
 *   reason?: string|null,
 *   now?: number,
 * }} [input]
 * @returns {object}
 */
export function buildRestartVerdict(input = {}) {
  const now = isFiniteNumber(input.now) ? Number(input.now) : Date.now();
  const result = input.result === RESTART_RESULTS.OK
    ? RESTART_RESULTS.OK
    : input.result === RESTART_RESULTS.FAILED
      ? RESTART_RESULTS.FAILED
      : RESTART_RESULTS.PENDING;
  const startedAt = nullableNumber(input.startedAt);
  const verifiedAt = nullableNumber(input.verifiedAt);
  const durationMs = isFiniteNumber(input.durationMs)
    ? Math.trunc(Number(input.durationMs))
    : (startedAt !== null && verifiedAt !== null ? Math.max(0, verifiedAt - startedAt) : null);
  const snapshot = isObject(input.snapshot) ? input.snapshot : buildSnapshotRecord({ requested: false });
  return {
    result,
    mode: nullableString(input.mode),
    generation: nullableNumber(input.generation),
    requestedAt: nullableNumber(input.requestedAt),
    startedAt,
    verifiedAt,
    durationMs,
    bootId: nullableString(input.bootId),
    previousBootId: nullableString(input.previousBootId),
    snapshot: {
      requested: snapshot.requested === true,
      taken: snapshot.taken === true,
      dir: nullableString(snapshot.dir),
      stamp: nullableString(snapshot.stamp),
      at: nullableNumber(snapshot.at),
      atLocal: nullableString(snapshot.atLocal),
      durationMs: nullableNumber(snapshot.durationMs),
      bytes: nullableNumber(snapshot.bytes),
      files: Array.isArray(snapshot.files) ? snapshot.files.map(String) : [],
      pruned: Array.isArray(snapshot.pruned) ? snapshot.pruned.map(String) : [],
      profileDir: nullableString(snapshot.profileDir),
      error: nullableString(snapshot.error),
    },
    checks: Array.isArray(input.checks) ? input.checks.map(normalizeCheck) : [],
    reason: nullableString(input.reason),
    // WHY THE RESTART WROTE NO NEW COPY (user decision, 2026-11-07). The
    // comparison before a restart either writes a copy or skips it because the
    // newest one already holds what the profile holds — and "no new backup"
    // has to be answerable from the record: `skipped: 'unchanged'` plus the
    // directory that was reused. Both stay null for every restart that really
    // copied (or never asked), which is what an older reader sees anyway.
    skipped: nullableString(input.skipped),
    backupDir: nullableString(input.backupDir),
    updatedAt: now,
  };
}

/**
 * The verdict of a set of checks: `ok` only when EVERY check passed.
 *
 * @param {any[]} checks
 * @returns {{ ok: boolean, failed: string[], passed: string[] }}
 */
export function evaluateRestartChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = []
  const passed = []
  for (const check of list) {
    const normalized = normalizeCheck(check)
    if (normalized.ok) passed.push(normalized.name)
    else failed.push(normalized.name)
  }
  return { ok: failed.length === 0 && list.length > 0, failed, passed }
}

/** The source that certifies a backup copy when the four checks all ran and passed. */
export const BOOT_CHECK_SOURCE = 'full-checks'

/**
 * THE CRITERION THAT PROVED THE COPY — the second half of the certification.
 *
 * WHY IT LIVES IN THIS MODULE AND NOT ONLY IN `lib/backup.js`: both deciding
 * functions here already answer "may this boot certify the copy it came from",
 * and they answer it with ONE criterion — the configuration fingerprints were
 * compared and matched. That answer is now part of the result, so a caller
 * cannot record "certified by full-checks" while forgetting WHAT was checked:
 * the label alone is exactly what made the two broken 71B/70B configurations on
 * the hosted instance indistinguishable from a proven copy (see
 * `CERTIFICATION_EVIDENCE` in lib/backup.js, which is where the field is stored).
 *
 * THE VALUE IS PINNED TO `backup.js` BY A TEST (test/certification-evidence.test.mjs):
 * this module deliberately imports no local module (it is the dependency-free
 * record layer), so the two spellings are kept identical by a drift guard rather
 * than by an import.
 */
export const FINGERPRINT_MATCH_EVIDENCE = 'fingerprint-match'

/**
 * The source that certifies a copy in **command mode** (the health probe answered).
 *
 * WHY IT IS NAMED HERE, next to the other source: the two certification paths
 * (app mode -> four checks, command mode -> health probe) ask the SAME content
 * question, so both answers belong in one module. Keeping the label next to the
 * rule is what stops a future caller from inventing a third, laxer rule.
 */
export const PROBE_CHECK_SOURCE = 'command-probe'

/** How many characters of a fingerprint a log line may show. */
export const FINGERPRINT_LOG_CHARS = 12

/**
 * The first characters of a fingerprint, for a log line or a reason.
 *
 * WHY SHORT: the point of logging both values is "which one differs from which",
 * and twelve characters answer that. The whole 64-character digest in every log
 * line makes the news unreadable and floods the log of every boot.
 *
 * `(none)` (not an empty string) when there is nothing to show: "this side has
 * no fingerprint" is exactly the fact the operator has to see.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shortFingerprint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return '(none)'
  return text.slice(0, FINGERPRINT_LOG_CHARS)
}

/** The five outcomes of comparing the two configuration fingerprints. */
export const FINGERPRINT_STATES = Object.freeze({
  /** Both sides name the same content: this boot ran on the snapshot content. */
  EQUAL: 'equal',
  /** Both exist and differ: the configuration was changed between the two boots. */
  MISMATCH: 'mismatch',
  /** The snapshot has no fingerprint (taken before fingerprints existed). */
  SNAPSHOT_MISSING: 'snapshot-missing',
  /** This boot could not fingerprint its own configuration. */
  CURRENT_MISSING: 'current-missing',
  /** Neither side has one: nothing to compare at all. */
  BOTH_MISSING: 'both-missing',
})

/** A fingerprint is a non-empty string; everything else is "not recorded". */
function normalizeFingerprint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text === '' ? null : text
}

/**
 * COMPARE the two configuration fingerprints — the hard physical fact.
 *
 * WHY A COMPARISON AND NOT A FLAG: `snapshotFingerprint` is the content the
 * snapshot holds; `currentFingerprint` is the content the host is running NOW.
 * If they differ, the configuration was written to between the two boots — by a
 * restore, by a hand edit, or by anything else on the machine — and a boot that
 * succeeded on THAT content says nothing about the content in the snapshot.
 * Nothing about "who touched what" is needed for this answer, which is the whole
 * reason it is trustworthy.
 *
 * @param {{ snapshotFingerprint?: unknown, currentFingerprint?: unknown }} [input]
 * @returns {{
 *   state: string,
 *   equal: boolean,
 *   snapshotFingerprint: string|null,
 *   currentFingerprint: string|null,
 *   snapshotShort: string,
 *   currentShort: string,
 *   reason: string|null,
 * }}
 */
export function compareConfigurationFingerprints({ snapshotFingerprint = null, currentFingerprint = null } = {}) {
  const snapshot = normalizeFingerprint(snapshotFingerprint)
  const current = normalizeFingerprint(currentFingerprint)
  let state = FINGERPRINT_STATES.EQUAL
  if (snapshot === null && current === null) state = FINGERPRINT_STATES.BOTH_MISSING
  else if (snapshot === null) state = FINGERPRINT_STATES.SNAPSHOT_MISSING
  else if (current === null) state = FINGERPRINT_STATES.CURRENT_MISSING
  else if (snapshot !== current) state = FINGERPRINT_STATES.MISMATCH
  const snapshotShort = shortFingerprint(snapshot)
  const currentShort = shortFingerprint(current)
  let reason = null
  if (state === FINGERPRINT_STATES.MISMATCH) {
    // THIS SENTENCE IS THE WHOLE POINT OF THE RULE, so it names the possible
    // causes instead of saying "did not pass": the reader has to be able to tell
    // "the configuration moved under us" apart from "a check went wrong".
    reason = 'the configuration was changed between the two boots (a restore, a manual edit or another writer): '
      + 'this copy was never proven (the snapshot holds ' + snapshotShort + ', this boot runs ' + currentShort + ')'
  } else if (state === FINGERPRINT_STATES.SNAPSHOT_MISSING) {
    reason = 'the snapshot has no contentFingerprint (it was taken before fingerprints existed), '
      + 'so nothing shows that this boot ran on the content it holds (this boot runs ' + currentShort + ')'
  } else if (state === FINGERPRINT_STATES.CURRENT_MISSING) {
    reason = 'this boot could not fingerprint its own configuration (the profile directory is unknown or unreadable), '
      + 'so it cannot be shown to be the content of the snapshot (' + snapshotShort + ')'
  } else if (state === FINGERPRINT_STATES.BOTH_MISSING) {
    reason = 'neither side has a configuration fingerprint: the snapshot was taken before fingerprints existed '
      + 'and this boot could not fingerprint its configuration'
  }
  return {
    state,
    equal: state === FINGERPRINT_STATES.EQUAL,
    snapshotFingerprint: snapshot,
    currentFingerprint: current,
    snapshotShort,
    currentShort,
    reason,
  }
}

/**
 * CAN THIS BOOT CERTIFY THE COPY IT CAME FROM? — the decision, not the label.
 *
 * WHY THIS LIVES HERE, next to the checks themselves: until now the four checks
 * only decided the verdict of "this restart" (`ok` / `failed`); the question
 * "may the copy that produced this boot now be called safe?" was answered
 * somewhere else — and the answer used to be "yes, unconditionally". The two
 * questions are not the same one, so the rule is spelled out here and the caller
 * cannot answer it by accident.
 *
 * THE RULE (2026-11-01, strict mode phase 3 — fingerprint first):
 *
 *   ① THE HARD GATE: the snapshot's `contentFingerprint` and the fingerprint of
 *      the configuration that is running NOW must BOTH exist and be EQUAL.
 *      A mismatch means the configuration was written to between the two boots
 *      (restore, hand edit, another writer), so this boot proved the OTHER
 *      content and the snapshot stays unproven. A missing fingerprint on either
 *      side is not a "probably fine": it is no proof at all, so it refuses too.
 *   ② then, and only then, ALL FOUR checks (`listener` / `routes` / `plugin` /
 *      `recovery`) must have RUN and passed. A check that did not run is NOT a
 *      pass: a boot that skipped them (`resumeOnBoot` off, a probe that never
 *      reached the checks) proves nothing about the configuration.
 *   ③ a check that ran and FAILED blocks the certification, and so does any
 *      OTHER check that failed — "the boot is clean" is not a subset test.
 *
 * WHY THE ORDER IS FINGERPRINT-FIRST: "the boot came up" and "the snapshot holds
 * good content" have NO causal link. If the snapshot held a broken configuration,
 * a successful boot is evidence that the configuration was RESTORED — the exact
 * opposite of evidence that the broken copy is safe. The only thing that ties this
 * boot to that copy is content identity, so that is what gets checked first.
 *
 * 为什么这条判据用「内容指纹」而不是 `intervention`（真机证据，2026-11-01）：
 * 托管实例备份 `2026-11-01T12-04-33-777Z` 被认证成 `certifiedBy=full-checks`、
 * 而它手里的 `config/cordis.patch.yml` 只有 70 字节（正常 691 字节，坏配置）；
 * 那份 meta 里的 `intervention` 记的是 `false` —— 可那次宿主其实是先被还原过才起来的。
 * 也就是说「谁介入过」这件事**测不准**（检测不到不等于没发生），抱着它盖章正是
 * 坏配置被认证的根因；而「这次启动跑的配置与快照里那份是不是同一份」是当场能算、
 * 不依赖任何检测的硬事实。所以 `intervention` 继续写进 meta 供事后排查，但**不再
 * 参与这里的判定**：不一致就是不一致，不许退化成「可以盖章，只标一下」。
 *
 * `evaluateRestartChecks` is deliberately NOT reused as the gate: it says `ok`
 * for any non-empty list of passing checks, which is right for the record
 * ("this restart worked") and wrong for certification ("these four things were
 * verified").
 *
 * The failure is never summarised away: `failed` / `missing` / `details` name
 * which of the four did not pass, and `fingerprintState` names which side of the
 * fingerprint comparison was missing or different, so the report can say it.
 *
 * @param {any[]} checks the checks the new instance ran on itself
 * @param {{ snapshotFingerprint?: unknown, currentFingerprint?: unknown }} [fingerprints]
 *   `snapshotFingerprint`: the `contentFingerprint` stored in the snapshot's meta.
 *   `currentFingerprint`: the fingerprint of the configuration on disk NOW.
 * @returns {{
 *   certified: boolean,
 *   certifiedBy: string,
 *   passed: string[],
 *   failed: string[],
 *   missing: string[],
 *   extraFailed: string[],
 *   details: Array<{ name: string, ok: boolean, detail: string|null }>,
 *   snapshotFingerprint: string|null,
 *   currentFingerprint: string|null,
 *   fingerprintState: string,
 *   fingerprintsEqual: boolean,
 *   reason: string,
 * }}
 */
export function decideBootCertification(checks, { snapshotFingerprint = null, currentFingerprint = null } = {}) {
  const list = Array.isArray(checks) ? checks : []
  // One entry per NAME: if the same check is reported twice and one of the two
  // failed, the failure wins — a report that disagrees with itself is not a pass.
  const byName = new Map()
  for (const raw of list) {
    const check = normalizeCheck(raw)
    if (check.name === 'unknown') continue
    const previous = byName.get(check.name)
    if (previous === undefined) {
      byName.set(check.name, check)
      continue
    }
    byName.set(check.name, {
      name: check.name,
      ok: previous.ok === true && check.ok === true,
      detail: check.ok === true ? previous.detail : check.detail,
    })
  }
  const passed = []
  const failed = []
  const missing = []
  const details = []
  for (const name of RESTART_CHECK_NAMES) {
    const found = byName.get(name)
    if (found === undefined) {
      missing.push(name)
      details.push({ name, ok: false, detail: 'this check did not run' })
      continue
    }
    if (found.ok === true) {
      passed.push(name)
      details.push({ name, ok: true, detail: found.detail })
      continue
    }
    failed.push(name)
    details.push({ name, ok: false, detail: found.detail })
  }
  const extraFailed = []
  for (const [name, check] of byName) {
    if (RESTART_CHECK_NAMES.includes(name)) continue
    if (check.ok === true) continue
    extraFailed.push(name)
    details.push({ name, ok: false, detail: check.detail })
  }
  // THE HARD GATE COMES FIRST (see the docstring): a boot that ran on a
  // DIFFERENT configuration than the snapshot holds proves nothing about the
  // snapshot, whatever the checks said.
  const fingerprints = compareConfigurationFingerprints({ snapshotFingerprint, currentFingerprint })
  const certified = fingerprints.equal === true
    && missing.length === 0
    && failed.length === 0
    && extraFailed.length === 0
  const checkProblems = []
  if (failed.length > 0) checkProblems.push('failed: ' + failed.join(', '))
  if (missing.length > 0) checkProblems.push('did not run: ' + missing.join(', '))
  if (extraFailed.length > 0) checkProblems.push('other check(s) failed: ' + extraFailed.join(', '))
  let reason
  if (certified) {
    reason = 'all four startup checks passed (' + RESTART_CHECK_NAMES.join(', ') + ')'
      + ', and this boot runs exactly the configuration the snapshot holds (' + fingerprints.snapshotShort + ')'
  } else if (fingerprints.state === FINGERPRINT_STATES.MISMATCH) {
    // The mismatch sentence already ends with "this copy was never proven", so
    // it stands on its own instead of being prefixed a second time. Any check
    // problem is appended: both halves of the news are true.
    reason = [fingerprints.reason, ...checkProblems].join('; ')
  } else {
    const parts = [fingerprints.reason, ...checkProblems]
      .filter((part) => typeof part === 'string' && part !== '')
    reason = 'the copy stays unproven: ' + (parts.length > 0 ? parts.join('; ') : 'no proof was produced')
  }
  return {
    certified,
    // The only source this module may ever certify with. A failed boot cannot
    // hand out `manual-rollback` or a seed: those come from elsewhere.
    certifiedBy: certified ? BOOT_CHECK_SOURCE : 'none',
    // AND THE CRITERION: the fingerprints were compared and matched — this is the
    // ONLY way a boot may certify, so it is the only evidence this path returns.
    // `null` on a refusal, so a caller that ignored `certified` cannot store a
    // stamp that a later reader would trust.
    certificationEvidence: certified ? FINGERPRINT_MATCH_EVIDENCE : null,
    passed,
    failed,
    missing,
    extraFailed,
    details,
    // The comparison travels with the decision so the caller can log WHICH two
    // values were compared (short values) without recomputing anything.
    snapshotFingerprint: fingerprints.snapshotFingerprint,
    currentFingerprint: fingerprints.currentFingerprint,
    fingerprintState: fingerprints.state,
    fingerprintsEqual: fingerprints.equal,
    reason,
  }
}

/**
 * MAY THE **HEALTH PROBE** OF A COMMAND-MODE RESTART CERTIFY THE COPY? — the
 * second path of the same rule.
 *
 * WHY THIS EXISTS (2026-11-01, the second path of the same defect): `c419846`
 * replaced the old criterion ("this restart came up") with "the snapshot's
 * fingerprint EQUALS the fingerprint of the configuration running now" — but only
 * on the app-mode path (`verifyRestartBoot` -> `decideBootCertification`). The
 * command-mode path kept the old shape: as soon as the health probe answered it
 * called `markKnownGood` with `contentFingerprint: contentFingerprintOf(copy)` —
 * a fingerprint of the COPY, never compared with anything. That is the same
 * mistake that produced the copy `2026-11-01T12-04-33-777Z`: a probe answering
 * proves that SOME instance answered a route, and it does NOT prove that the
 * configuration inside the snapshot can boot. The probe may have hit the old
 * instance, and the configuration may have been swapped in between.
 *
 * 中文口径（用户已拍板，2026-11-02 重申）：宁可没有可回退的那一份，也不许写错记录。
 * 探活成功 ≠ 重启前那份配置能起来；而「那次启动跑的配置，与副本里那份指纹相等」才是
 * 当场能算、能复查的事实——记录里写的就是这条事实，不再写「已认证 / 可用于回退」。
 *
 * THE RULE — identical in wording to `decideBootCertification`, because the two
 * paths must not be able to disagree:
 *
 *   ① both fingerprints exist and are EQUAL -> certify with `command-probe`;
 *   ② they differ -> no certification, and the reason says the configuration was
 *      changed between the two boots;
 *   ③ either side missing -> no certification. No proof beats a guessed one:
 *      "we could not compare" is an answer, and it is the refusing one.
 *
 * The caller has ALREADY established that the probe answered; this function only
 * answers the content question, so a future change to the probe cannot quietly
 * loosen the gate.
 *
 * @param {{ snapshotFingerprint?: unknown, currentFingerprint?: unknown }} [input]
 *   `snapshotFingerprint`: the `contentFingerprint` recorded in the snapshot's
 *   meta.json when the copy was taken (NOT recomputed from the copy later: a copy
 *   edited after the fact must not be able to certify itself).
 *   `currentFingerprint`: the fingerprint of the profile configuration on disk now.
 * @returns {{
 *   certified: boolean,
 *   certifiedBy: string,
 *   snapshotFingerprint: string|null,
 *   currentFingerprint: string|null,
 *   fingerprintState: string,
 *   fingerprintsEqual: boolean,
 *   reason: string,
 * }}
 */
export function decideProbeCertification({ snapshotFingerprint = null, currentFingerprint = null } = {}) {
  const fingerprints = compareConfigurationFingerprints({ snapshotFingerprint, currentFingerprint })
  const certified = fingerprints.equal === true
  let reason
  if (certified) {
    reason = 'the health probe answered and this boot runs exactly the configuration the snapshot holds ('
      + fingerprints.snapshotShort + ')'
  } else if (fingerprints.state === FINGERPRINT_STATES.MISMATCH) {
    // The mismatch sentence already ends with "this copy was never proven", so it
    // stands on its own — the same shape `decideBootCertification` produces.
    reason = fingerprints.reason
  } else {
    // "The probe answered" is deliberately NOT repeated here as a consolation: the
    // operator has to see why that fact does not help.
    reason = 'the copy stays unproven: ' + fingerprints.reason
  }
  return {
    certified,
    // The only source this path may ever certify with. A failed comparison cannot
    // hand out `full-checks`: the four checks do not run in command mode.
    certifiedBy: certified ? PROBE_CHECK_SOURCE : 'none',
    // The criterion, exactly as in `decideBootCertification`: the two fingerprints
    // were compared and matched. `null` when the comparison refused, so no caller
    // can turn a refusal into a criterion-free (and therefore untrustworthy) stamp.
    certificationEvidence: certified ? FINGERPRINT_MATCH_EVIDENCE : null,
    snapshotFingerprint: fingerprints.snapshotFingerprint,
    currentFingerprint: fingerprints.currentFingerprint,
    fingerprintState: fingerprints.state,
    fingerprintsEqual: fingerprints.equal,
    reason,
  }
}

/**
 * Write the verdict into the state directory (atomically: a temporary file
 * plus a rename, so a half-written record can never be read).
 *
 * @param {string} stateDir
 * @param {object} verdict
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeRestartVerdict(stateDir, verdict) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return { ok: false, path: '', error: 'writeRestartVerdict requires stateDir' };
  const target = path.join(dir, RESTART_VERDICT_FILE);
  const record = buildRestartVerdict(verdict)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, target)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return {
      ok: false,
      path: target,
      error: String(error && error.message ? error.message : error),
    }
  }
}

/**
 * Read the verdict of the last restart. Never throws: an unreadable or
 * corrupt record is reported as `null` (there is nothing to show).
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRestartVerdict(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    let text = fs.readFileSync(path.join(dir, RESTART_VERDICT_FILE), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!isObject(parsed)) return null
    return buildRestartVerdict(parsed)
  } catch {
    return null
  }
}

/**
 * Remove the verdict (used when a fresh restart cycle starts).
 *
 * @param {string} stateDir
 * @returns {boolean} whether a record was removed
 */
export function clearRestartVerdict(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, RESTART_VERDICT_FILE), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * The compact shape of the verdict that the health route and the status tool
 * report. It is deliberately flat: a UI (or a human with `curl`) has to read
 * it without knowing the internals.
 *
 * @param {object|null} verdict
 * @returns {object|null}
 */
export function summarizeRestartVerdict(verdict) {
  if (!isObject(verdict)) return null
  const record = buildRestartVerdict(verdict)
  const failed = record.checks.filter((check) => !check.ok).map((check) => check.name)
  return {
    result: record.result,
    mode: record.mode,
    generation: record.generation,
    requestedAt: record.requestedAt,
    startedAt: record.startedAt,
    verifiedAt: record.verifiedAt,
    durationMs: record.durationMs,
    bootId: record.bootId,
    previousBootId: record.previousBootId,
    snapshot: record.snapshot,
    checks: record.checks,
    failedChecks: failed,
    reason: record.reason,
    // THE COMPARISON'S OUTCOME travels with the verdict (2026-11-07): a restart
    // that found the profile already copied records `skipped: 'unchanged'` and
    // the directory it reused, so the settings page can say so instead of
    // leaving "why is there no new backup?" unanswered.
    skipped: record.skipped,
    backupDir: record.backupDir,
    updatedAt: record.updatedAt,
  }
}
