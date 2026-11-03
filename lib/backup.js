/**
 * dsh-autorestart — pre-restart backups.
 *
 * A restart can leave the host unable to boot: the profile configuration is what
 * decides whether every installed bundle loads, and the host's own rescue path
 * rewrites exactly those files when a boot fails. So the restart helper keeps a
 * snapshot of the profile (its configuration files, and — when enabled — the
 * installed plugin tree) and can put it back when the host does not come up.
 *
 * Everything here is synchronous and bounded: a backup is taken right before the
 * detached restart is scheduled, and only the newest `maxBackups` snapshots are
 * kept (older ones are removed so the disk never grows without a limit).
 *
 * The restore path used by the detached helper lives in the generated PowerShell
 * watcher (lib/restart.js); `restoreBackup` here is the same operation for tests
 * and for a manual recovery from inside the host.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { treeDigest } from './plugin-recover.js'
import path from 'node:path';

/** The profile files that decide whether the host can boot. */
export const CONFIG_FILES = Object.freeze(['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']);

/** The directory inside one backup that holds the configuration files. */
export const CONFIG_DIR = 'config';

/** The directory inside one backup that holds the installed plugin tree. */
export const PLUGINS_DIR = 'node_modules';

/**
 * The directory inside one backup that holds the CONTENTS of linked plugins.
 *
 * WHY A SEPARATE DIRECTORY (user decision, 2026-10-30). A plugin installed with
 * `link:` / a junction is not a copy: `node_modules/<name>` is a reparse point
 * pointing at a development directory. Copying it as part of the tree either
 * copies the LINK (and a restore would put back a link to a directory that may
 * be gone) or follows it into a tree that is not the profile's. The contents
 * are therefore kept apart, one directory per plugin, and the restore decides
 * per plugin whether the link can stay or the contents must take its place.
 */
export const LINKS_DIR = 'node_modules-link';

/**
 * NAMES NEVER COPIED INTO A BACKUP (2026-11-01).
 *
 * `.git` only, on purpose: it is rebuildable (clone/fetch) and it is the bulk of
 * a linked plugin — measured on the real machine, one plugin's history was 962
 * files / ~74 MB inside EVERY backup. Anything else (lock files, build output,
 * a stray `.cache`) is left alone: this list is not a place to guess.
 */
export const BACKUP_SKIP_NAMES = Object.freeze(['.git']);

/**
 * HOW MUCH A SINGLE JUNK SWEEP MAY DELETE (2026-11-01).
 *
 * A ceiling, not a target: on the real machine 24 directories / 1.78 GB had
 * piled up, and a boot path that silently deletes "however much it finds" is a
 * worse bug than the disk space. Over the ceiling the sweep stops and REPORTS.
 */
export const DEFAULT_JUNK_LIMITS = Object.freeze({
  dirs: 32,
  bytes: 2 * 1024 * 1024 * 1024,
});

/**
 * HOW OLD A DIRECTORY MUST BE BEFORE A SWEEP MAY JUDGE IT (2026-11-02).
 *
 * A copy that is still being written is not junk — it is unfinished work, and a
 * sweep that deletes it mid-write makes a backup vanish without a word. Two
 * minutes is comfortably longer than a copy takes, and short enough that the
 * leftovers of a crashed restart are reclaimed on the next boot.
 */
export const DEFAULT_HYGIENE_MIN_AGE_MS = 120_000;

/** The two kinds of reparse point this module knows. */
export const LINK_KINDS = Object.freeze({
  SYMLINK: 'symbolic-link',
  JUNCTION: 'junction',
});

/**
 * The outcomes of the link decision. They are also what the restore script
 * prints, one line per plugin - nothing is ever skipped silently.
 */
export const LINK_ACTIONS = Object.freeze({
  KEPT: 'kept',
  REPLACED: 'replaced',
  TARGET_MISSING: 'target-missing',
  NO_BACKUP: 'no-backup',
});

/**
 * THE RANGE AND THE DEFAULT THE SETTINGS PAGE OFFERS (user decision, 2026-11-02).
 *
 * ONE PLACE, ONE TRUTH: before this, four numbers described the same setting and
 * disagreed - `DEFAULT_MAX_BACKUPS = 2`, a schema description that said "default
 * 3", a schema bound of `.min(1)`, a validation floor of 2 and a dropdown of
 * 2..10. The user met that as "I set 3 copies and it did not take effect". They
 * all read from `BACKUP_LIMIT` now, and a test pins that changing it here moves
 * the schema bound, the validation floor and the reported range together.
 */
export const BACKUP_LIMIT = Object.freeze({ min: 2, default: 2, max: 10 });

/** The smallest limit a user may set (see `BACKUP_LIMIT`). */
export const BACKUP_LIMIT_MIN = BACKUP_LIMIT.min;
/** The largest limit a user may set. */
export const BACKUP_LIMIT_MAX = BACKUP_LIMIT.max;
/** What the setting is when nobody chose - also what the schema declares. */
export const DEFAULT_MAX_BACKUPS = BACKUP_LIMIT.default;

/** The block the settings page reads instead of hard-coding 2..10. */
export function backupLimitInfo() {
  return { min: BACKUP_LIMIT_MIN, max: BACKUP_LIMIT_MAX, default: DEFAULT_MAX_BACKUPS };
}

/**
 * WHY A RESTORE DID NOT HAPPEN - IN A WORD THAT DOES NOT JUDGE THE COPY
 * (user decision, 2026-11-02).
 *
 * The old value was `no-known-good`: a refusal whose name asserts that the copies
 * on disk were not good, which is a verdict the code is not in a position to give
 * (the watchdog refuses because *nobody recorded a boot*, not because the content
 * is bad). Neutral wording keeps the report honest: "there was no USABLE backup"
 * says what the system could act on.
 *
 * THE OLD VALUE IS STILL READ, AND ONLY READ. Installed builds and old report
 * files carry `no-known-good`; a reader that stopped understanding it would turn
 * every historical report into "unknown error", which is worse than the wording it
 * replaces. `normalizeRestoreRefusal` is that compatibility layer, and no code
 * path writes the old string any more (pinned by a test).
 */
export const RESTORE_REFUSAL = Object.freeze({
  NO_USABLE_BACKUP: 'no-usable-backup',
});

/** The value older builds wrote. Read compatibility only - never produced. */
export const LEGACY_RESTORE_REFUSAL = 'no-known-good';

/**
 * Map a refusal token (new or legacy) onto today's token.
 *
 * @param {unknown} value
 * @returns {string} the current token, or the trimmed input when it is neither
 */
export function normalizeRestoreRefusal(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === LEGACY_RESTORE_REFUSAL) return RESTORE_REFUSAL.NO_USABLE_BACKUP;
  return text;
}

/**
 * The refusal token a report's `reason` starts with, normalized.
 *
 * Reports are written as `'<token>: <sentence>'`; an old file says
 * `no-known-good: ...`, and this makes it read as the current token so nothing
 * downstream has to know history.
 *
 * @param {unknown} reason
 * @returns {string} '' when the text carries no token
 */
export function restoreRefusalOf(reason) {
  if (typeof reason !== 'string') return '';
  const colon = reason.indexOf(':');
  if (colon <= 0) return '';
  return normalizeRestoreRefusal(reason.slice(0, colon));
}

/**
 * IS THIS A LEGAL BACKUP LIMIT? `{ ok: true, value }` or `{ ok: false, reason }`.
 *
 * A reason, never a silent clamp: a UI that quietly turns 0 into 1 leaves the
 * user believing a number that was never applied.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: number }|{ ok: false, reason: string }}
 */
export function validateBackupLimit(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || Number.isFinite(value) !== true) {
    return { ok: false, reason: 'the copy limit must be a number' };
  }
  if (Number.isInteger(value) !== true) {
    return { ok: false, reason: 'the copy limit must be a whole number' };
  }
  if (value < BACKUP_LIMIT_MIN || value > BACKUP_LIMIT_MAX) {
    // THE FLOOR EXPLAINS ITSELF (user decision, 2026-11-02): one copy is the
    // scene from the restart that just happened, which may itself be the broken
    // one, so one copy is no fallback at all.
    const reason = value < BACKUP_LIMIT_MIN
      ? 'the copy limit must be at least ' + BACKUP_LIMIT_MIN
        + ': one copy is the state from the restart that just happened (which may itself be the broken one), so at least two are kept — that scene plus an earlier reference'
      : 'the copy limit must be at most ' + BACKUP_LIMIT_MAX;
    return { ok: false, reason };
  }
  return { ok: true, value };
}

/**
 * WHAT SHRINKING TO `requested` COPIES WOULD ACTUALLY DO.
 *
 * Certified copies are never deleted, so the number the user picked is a
 * REQUEST: the honest answer is "I asked for 2, 3 are kept because one of them
 * is certified". `keptWillExceedRequest` is that sentence in data form — the
 * page says it out loud instead of pretending the request won.
 *
 * @param {{ requested: number, items: Array<{ certified?: boolean }> }} input
 * @returns {{ requested: number, current: number, deleteCount: number, keepCount: number, certifiedKept: number, keptWillExceedRequest: boolean }}
 */
export function planBackupLimit(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const requested = Math.max(BACKUP_LIMIT_MIN, Math.min(BACKUP_LIMIT_MAX, Math.trunc(Number(source.requested) || 0)));
  const items = Array.isArray(source.items) ? source.items : [];
  const current = items.length;
  // A certified copy survives pruning, so the floor is how many of them exist.
  const certifiedKept = items.filter((item) => item !== null && typeof item === 'object' && item.certified === true).length;
  const floor = Math.max(requested, certifiedKept);
  const keepCount = Math.min(current, Math.max(floor, 0));
  return {
    requested,
    current,
    deleteCount: Math.max(0, current - keepCount),
    keepCount,
    certifiedKept,
    keptWillExceedRequest: keepCount > requested,
  };
}

/** The manifest written into every backup. */
export const MANIFEST_NAME = 'manifest.json';

/**
 * How many backups are kept by default.
 *
 * TWO (user decision, 2026-11-02: at most two copies — one verified "safe" copy
 * plus the newest unverified one, which replaces the old verified copy once it
 * passes its checks). It was TWENTY before, and that is exactly why a hosted
 * instance that never configured the value kept seventeen copies: nothing was
 * ever over the ceiling, so the prune never had a budget to spend.
 *
 * An explicit `maxBackups` in the profile still wins: this is a DEFAULT, not a
 * cap on what the user may ask for.
 *
 * The newest copy is never pruned whatever this number says, and neither is a copy
 * whose restart record says it came up with matching content — losing those would
 * leave the machine with nothing to roll back to.
 *
 * THE VALUE ITSELF LIVES IN `BACKUP_LIMIT` (2026-11-02): it used to be 2 here
 * while the schema description said "default 3", which is exactly the disagreement
 * the user hit. `DEFAULT_MAX_BACKUPS` is now an alias of that one source.
 */

/**
 * THE IDENTITY OF A BACKUP (user decision, 2026-10-30).
 *
 * A pre-restart snapshot is taken BEFORE the restart: it holds exactly the state
 * that is about to be tested, i.e. possibly the state that breaks the boot. So a
 * restore may only ever use a backup that HAS BOOTED: the known-good one.
 *
 * Two identities:
 *   'snapshot'    taken before a restart, not proven yet;
 *   'known-good'  a restart with this content really came up — or the seed taken
 *                 on first install (nothing to prove yet, nothing to lose either).
 *
 * A directory without a readable meta.json is 'unknown': it was written before
 * this rule existed and is NEVER used for an automatic rollback.
 */
export const META_NAME = 'meta.json';
export const KIND_SNAPSHOT = 'snapshot';
export const KIND_KNOWN_GOOD = 'known-good';
export const KIND_UNKNOWN = 'unknown';

/**
 * Coerce anything into one of the three identities.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeKind(raw) {
  if (raw === KIND_KNOWN_GOOD) return KIND_KNOWN_GOOD;
  if (raw === KIND_SNAPSHOT) return KIND_SNAPSHOT;
  return KIND_UNKNOWN;
}

/**
 * WHAT PUT THIS COPY ON DISK — the fact that replaced the old identity label
 * (user decision, 2026-11-02: "记录里也一起清掉").
 *
 * WHY THE LABEL IS GONE FROM THE FILE: `kind: 'known-good'` and
 * `certifiedBy: 'full-checks'` were written in a register that read like a
 * verdict ("this copy is the good one", "this copy is certified"). A user who
 * opened `meta.json` — or read a report built from it — was told the plugin had
 * vouched for the copy, while what had really been observed was one boot:
 * "after that restart the host came up, and it was running this content".
 * Those are different claims, and only the second one is provable.
 *
 * SO THE FILE NOW ANSWERS THREE QUESTIONS, ALL OF THEM FACTS:
 *   - when was this copy taken (`takenAt` / `at`),
 *   - what put it there (`trigger`),
 *   - what happened on the boot that followed, if one did (`boot.started`,
 *     `boot.contentMatched`, `boot.loadFailures`, `boot.intervention`).
 *
 * The old vocabulary is still DERIVED on read (see `verificationOf`), because
 * the selector and the reports above this layer were written against it, and
 * because every `meta.json` already on a machine speaks it. Derived, never
 * written: a value that only exists in this process cannot be mistaken for a
 * record by the next reader of the file.
 */
export const BACKUP_TRIGGERS = Object.freeze({
  /** The copy a fresh installation starts with (`reason: 'first-install'`). */
  FIRST_INSTALL: 'first-install',
  /** The snapshot taken before a restart, i.e. the state that is about to be tested. */
  PRE_RESTART: 'pre-restart',
  /** The copy taken before a manual rollback, so that rollback can be undone. */
  MANUAL_ROLLBACK: 'manual-rollback',
});

const TRIGGER_SET = new Set(Object.values(BACKUP_TRIGGERS));

/**
 * HOW THE BOOT THAT FOLLOWED WAS OBSERVED — again a fact, not a grade.
 *
 * "startup-checks" means the four startup checks ran on that boot; "health-probe"
 * means a command-mode restart got an answer from the health route and nothing
 * else was looked at; "manual-rollback" means a human rolled back and confirmed.
 * None of the three says the plugins in the copy are good, and the record does
 * not pretend otherwise.
 */
export const BOOT_OBSERVATIONS = Object.freeze({
  STARTUP_CHECKS: 'startup-checks',
  HEALTH_PROBE: 'health-probe',
  MANUAL_ROLLBACK: 'manual-rollback',
});

const BOOT_OBSERVATION_SET = new Set(Object.values(BOOT_OBSERVATIONS));

/** Coerce anything into one of the three triggers. */
function normalizeTrigger(raw) {
  return typeof raw === 'string' && TRIGGER_SET.has(raw) ? raw : null;
}

/**
 * WHAT PUT THIS COPY ON DISK, from whatever the caller could say about it.
 *
 * An explicit `trigger` wins. Otherwise it is read off the old-shaped inputs the
 * call sites still pass: `kind: 'known-good'` is the first-install seed (that is
 * the only copy born with that kind), `reason: 'before-manual-rollback'` is the
 * undo copy of a manual rollback, and everything else is a pre-restart snapshot.
 *
 * @param {{ trigger?: unknown, kind?: unknown, reason?: unknown }} [input]
 * @returns {string} one of BACKUP_TRIGGERS
 */
function triggerOf({ trigger = null, kind = null, reason = null } = {}) {
  const explicit = normalizeTrigger(trigger);
  if (explicit !== null) return explicit;
  if (normalizeKind(kind) === KIND_KNOWN_GOOD) return BACKUP_TRIGGERS.FIRST_INSTALL;
  if (reason === 'first-install') return BACKUP_TRIGGERS.FIRST_INSTALL;
  if (reason === 'before-manual-rollback') return BACKUP_TRIGGERS.MANUAL_ROLLBACK;
  return BACKUP_TRIGGERS.PRE_RESTART;
}

/** Was this copy written by a build that records facts (and not only a verdict)? */
function isFactRecord(record) {
  if (record === null || typeof record !== 'object') return false;
  if (normalizeTrigger(record.trigger) !== null) return true;
  return record.boot !== null && record.boot !== undefined && typeof record.boot === 'object';
}

/**
 * The plugin load failures a boot reported, as plain facts.
 *
 * `null` means NOT RECORDED — which is not the same answer as `[]` ("that boot
 * reported no load failure"), and must never be rounded down to it.
 */
function normalizeLoadFailures(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      return { plugin: null, version: null, error: String(entry ?? '') };
    }
    return {
      plugin: typeof entry.plugin === 'string' && entry.plugin !== '' ? entry.plugin : null,
      version: typeof entry.version === 'string' && entry.version !== '' ? entry.version : null,
      error: typeof entry.error === 'string' && entry.error !== '' ? entry.error : null,
    };
  });
}

/**
 * THE BOOT THAT FOLLOWED THIS COPY — the fact block, or `null` when no boot has
 * been observed for it yet.
 *
 * `started: null` is "nobody recorded whether the host came up"; `contentMatched`
 * is the answer to "was that boot running exactly the content this copy holds",
 * and `null` again means "not recorded". Both are kept three-valued on purpose:
 * the selector refuses an unknown answer, and a `false` invented for convenience
 * would be the same mistake as the stamp this replaces.
 *
 * @param {unknown} raw
 * @returns {{ started: boolean|null, at: string|null, observedBy: string|null, ranContent: string|null, contentMatched: boolean|null, loadFailures: Array<object>|null }|null}
 */
function bootFactsOf(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const observedBy = typeof raw.observedBy === 'string' && BOOT_OBSERVATION_SET.has(raw.observedBy)
    ? raw.observedBy
    : null;
  const ranContent = typeof raw.ranContent === 'string' && raw.ranContent.trim() !== ''
    ? raw.ranContent
    : null;
  return {
    started: typeof raw.started === 'boolean' ? raw.started : null,
    at: normalizeIsoTime(raw.at),
    observedBy,
    ranContent,
    contentMatched: typeof raw.contentMatched === 'boolean' ? raw.contentMatched : null,
    loadFailures: normalizeLoadFailures(raw.loadFailures),
  };
}

/**
 * THE OLD VOCABULARY, DERIVED — never written to a file.
 *
 * WHY IT STILL EXISTS AT ALL: the restore selector, the watchdog report and the
 * settings payload were written against `certifiedBy` / `certificationEvidence`,
 * and every `meta.json` already on a machine carries them. Translating the facts
 * into that shape ON READ is what lets the file be honest without a second
 * selector — the algorithm does not change, only where its input comes from.
 *
 * THE MAPPING IS ONE-TO-ONE, SO NOTHING IS LOOSENED:
 *   - `trigger: 'first-install'` -> `seed` (the seed's own positioning: it was
 *     never proven, and it is not recorded as if it had been);
 *   - a boot observed by the startup checks / the health probe / a manual
 *     rollback -> `full-checks` / `command-probe` / `manual-rollback`;
 *   - `'fingerprint-match'` only when that boot actually started AND was running
 *     the content this copy holds — i.e. exactly the old criterion;
 *   - anything else -> `'none'`, which is what an unrecorded answer has always
 *     meant here.
 *
 * `kind` is derived too: a copy with a boot on record is `known-good` (the old
 * writer's meaning of that kind), the first-install seed is `known-good`, and a
 * copy nobody has booted yet is `snapshot`.
 *
 * @param {object|null|undefined} record a parsed `meta.json`, new or old
 * @returns {{ certifiedBy: string, certificationEvidence: string|null, certifiedAt: string|null, kind: string }}
 */
function verificationOf(record) {
  const source = record !== null && typeof record === 'object' ? record : {};
  if (!isFactRecord(source)) {
    // AN OLD meta.json: read it as what it says, and read it as "no proof" when it
    // names a source but no criterion — the shape of the historical pollution.
    return {
      certifiedBy: normalizeCertifiedBy(source.certifiedBy),
      certificationEvidence: normalizeCertificationEvidence(source.certificationEvidence),
      certifiedAt: normalizeIsoTime(source.certifiedAt),
      kind: normalizeKind(source.kind),
    };
  }
  const trigger = normalizeTrigger(source.trigger) ?? BACKUP_TRIGGERS.PRE_RESTART;
  const boot = bootFactsOf(source.boot);
  let certifiedBy = CERTIFIED_BY.NONE;
  if (boot !== null && boot.observedBy === BOOT_OBSERVATIONS.STARTUP_CHECKS) certifiedBy = CERTIFIED_BY.FULL_CHECKS;
  else if (boot !== null && boot.observedBy === BOOT_OBSERVATIONS.HEALTH_PROBE) certifiedBy = CERTIFIED_BY.COMMAND_PROBE;
  else if (boot !== null && boot.observedBy === BOOT_OBSERVATIONS.MANUAL_ROLLBACK) certifiedBy = CERTIFIED_BY.MANUAL_ROLLBACK;
  else if (trigger === BACKUP_TRIGGERS.FIRST_INSTALL) certifiedBy = CERTIFIED_BY.SEED;
  const proven = boot !== null && boot.started === true && boot.contentMatched === true;
  return {
    certifiedBy,
    certificationEvidence: proven ? CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH : CERTIFICATION_EVIDENCE.NONE,
    certifiedAt: proven ? boot.at : null,
    kind: boot !== null || trigger === BACKUP_TRIGGERS.FIRST_INSTALL ? KIND_KNOWN_GOOD : KIND_SNAPSHOT,
  };
}

/**
 * WHY THIS COPY COUNTS AS SAFE — the evidence, stored inside the copy itself.
 *
 * WHY INSIDE THE COPY AND NOT IN A SEPARATE REGISTER: a known-good state is only
 * worth something if it survives together with the thing it certifies. A register
 * kept elsewhere can be lost, half-written, or keep pointing at a copy that has
 * since been pruned. So the evidence travels in `meta.json`, right next to the
 * identity it justifies.
 *
 * THE ROOT CAUSE THIS REPLACES (2026-11-01): `markKnownGood` stamped the
 * PRE-RESTART snapshot unconditionally, with the fixed reason 'boot-ok'. When
 * that boot only came up because a human intervened — or because the watchdog had
 * restored a backup — the state BEFORE the restart was already broken, and it got
 * certified as the safe one anyway. The watchdog then "restored" onto that broken
 * state and the report said everything was fine.
 *
 * Fedora greenboot / RAUC / Android A/B / Kubernetes all agree on the opposite
 * rule: what gets certified is the copy that is RUNNING NOW and was EXPLICITLY
 * CHECKED — never "whatever was lying around before the restart". Windows' Last
 * Known Good is the cautionary tale: after one successful logon the bad
 * configuration had become the LKG, and Microsoft ended up removing the feature.
 *
 * Five sources, so the report can answer "why is this copy considered safe?":
 *   'full-checks'      all four startup checks passed on this exact content;
 *   'command-probe'    the host answered its health route in command mode;
 *   'seed'             the first-install copy (nothing to prove yet, nothing to
 *                      lose either);
 *   'manual-rollback'  a human rolled back and confirmed the result;
 *   'none'             NOT certified. Every meta.json written before this layer
 *                      reads as 'none' — "unknown" is never rounded up to "good".
 */
export const CERTIFIED_BY = Object.freeze({
  FULL_CHECKS: 'full-checks',
  COMMAND_PROBE: 'command-probe',
  SEED: 'seed',
  MANUAL_ROLLBACK: 'manual-rollback',
  NONE: 'none',
});

/**
 * The four sources that really prove something. `'none'` is deliberately NOT in
 * here: a copy nobody checked is a candidate, not a fallback.
 */
const CERTIFYING_SOURCES = new Set([
  CERTIFIED_BY.FULL_CHECKS,
  CERTIFIED_BY.COMMAND_PROBE,
  CERTIFIED_BY.SEED,
  CERTIFIED_BY.MANUAL_ROLLBACK,
]);

/**
 * WHICH CRITERION PROVED IT — the second half of the evidence (2026-11-01).
 *
 * THE DEFECT THIS CLOSES, with the numbers from the hosted instance: after the
 * rule became "certify only when the configuration fingerprints match", two
 * fresh snapshots were correctly certified (`cfg=691B`, `certifiedBy=full-checks`,
 * fingerprint recorded) — but the two BROKEN configurations stamped by the OLD
 * code before that fix (`cfg=71B` and `cfg=70B`) still read
 * `certifiedBy=full-checks` in their `meta.json`. The watchdog picks the restore
 * target by `certifiedBy`, so it could not tell those two apart from the good
 * copy and would have restored a 71-byte broken configuration as "the safe one".
 *
 * ROOT CAUSE, in one sentence: `certifiedBy` says WHO signed, never WITH WHICH
 * CRITERION, and the old criterion ("the host came up") and the new one ("this
 * boot ran exactly the content the copy holds") both end up as `full-checks`.
 *
 * THE RULE THAT FOLLOWS: a stamp nobody can verify is not a stamp — and it is
 * WORSE than no stamp, because it gets trusted. So the criterion is recorded next
 * to the source, and a copy only counts as safe when BOTH are present:
 *
 *   'fingerprint-match'  the copy's configuration fingerprint was compared with
 *                        the fingerprint of the configuration that was really
 *                        running, and the two were equal;
 *   null                 no criterion on record: a stamp written before this
 *                        field existed (the historical pollution), or a copy
 *                        nobody ever certified.
 *
 * ONLY TWO VALUES, ON PURPOSE. The first-install seed is NOT a third kind here:
 * the seed is a copy taken before anything was proven, it is not a boot that was
 * checked, and folding it into 'fingerprint-match' would re-create exactly the
 * unverifiable stamp this field exists to remove. The seed keeps its own
 * positioning (see `isRestoreEligible`), which is a different question from
 * "has this copy been proven".
 */
export const CERTIFICATION_EVIDENCE = Object.freeze({
  FINGERPRINT_MATCH: 'fingerprint-match',
  NONE: null,
});

/** The one evidence value that proves a copy, in a Set for cheap membership. */
const PROVING_EVIDENCE = new Set([CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH]);

/**
 * Is this `certificationEvidence` value a proof?
 *
 * Reading an old `meta.json` must never throw and must never be promoted: a
 * missing field, an empty string, `'boot-ok'`, `'trust-me'` or anything else
 * unrecognised reads as `null` — "no criterion on record", which is NOT a proof.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isProvingEvidence(raw) {
  return typeof raw === 'string' && PROVING_EVIDENCE.has(raw);
}

/** Coerce anything into `'fingerprint-match'` or `null`. */
function normalizeCertificationEvidence(raw) {
  return isProvingEvidence(raw) ? raw : CERTIFICATION_EVIDENCE.NONE;
}

/**
 * MAY THIS COPY BE TREATED AS A SAFE ONE — the one definition, in one place.
 *
 * THE OLD DEFINITION IS DELIBERATELY GONE: `isCertifyingSource(certifiedBy)`
 * alone. It answers "does the field name a source the code knows?", which is
 * true of every copy the old code stamped with its criterion-free seal — the
 * 71B and 70B broken configurations included. Reading that as "safe" is what
 * would put a broken configuration back over a working profile.
 *
 * THE NEW DEFINITION NEEDS BOTH HALVES:
 *   - `certifiedBy` names a real source (not `'none'`, not missing), AND
 *   - `certificationEvidence === 'fingerprint-match'` (the criterion that can be
 *     re-checked was really applied).
 * A copy with a source but no criterion is NOT certified — it is historical
 * pollution, and the answer for it is "not trusted", never "trusted with a
 * warning": a warning is only read by whoever happens to look, while the
 * selector acts on the flag.
 *
 * WHY THIS IS THE SAFE DIRECTION: a false negative costs a fallback copy (the
 * fingerprint is recomputed and compared on the next boot, which is the upgrade
 * channel that brings good old copies back — see `snapshotConfigFingerprint`).
 * A false positive costs the profile, which is the whole point of a backup.
 *
 * @param {{ certifiedBy?: unknown, certificationEvidence?: unknown }|null|undefined} meta
 * @returns {boolean}
 */
export function isCertifiedBackup(meta) {
  const verification = verificationOf(meta);
  if (verification.certifiedBy === CERTIFIED_BY.NONE) return false;
  return verification.certificationEvidence === CERTIFICATION_EVIDENCE.FINGERPRINT_MATCH;
}

/**
 * MAY THIS COPY STILL BE USED AS THE AUTOMATIC FALLBACK — a wider question than
 * "is it certified".
 *
 * WHY THE SEED IS HERE AND NOT IN `isCertifiedBackup`: a fresh installation has
 * nothing proven yet and nothing to lose either, so the first-install copy is a
 * legitimate thing to roll back to — that is its own positioning, it is not a
 * proof, and it must not be recorded as one. That is the entire reason this
 * second predicate exists instead of folding the seed into `'fingerprint-match'`.
 *
 * EVERYTHING ELSE MUST BE CERTIFIED. A copy stamped by the old criterion has a
 * source but no criterion (§ `CERTIFICATION_EVIDENCE`), so it fails here too: it
 * is not a fallback, exactly like a copy nobody ever certified.
 *
 * @param {{ certifiedBy?: unknown, certificationEvidence?: unknown }|null|undefined} meta
 * @returns {boolean}
 */
export function isRestoreEligible(meta) {
  const verification = verificationOf(meta);
  if (verification.certifiedBy === CERTIFIED_BY.SEED) return true;
  return isCertifiedBackup(meta);
}

/**
 * Does this `certifiedBy` value prove a boot?
 *
 * Anything that is not one of the four sources — including a missing field, an
 * empty string and the literal `'none'` — is NOT certified. Reading an old meta
 * must never throw and must never be promoted: "we cannot tell" is an answer,
 * and it is the safe one.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isCertifyingSource(raw) {
  return typeof raw === 'string' && CERTIFYING_SOURCES.has(raw);
}

/** Coerce anything into one of the five certification sources. */
function normalizeCertifiedBy(raw) {
  return isCertifyingSource(raw) ? raw : CERTIFIED_BY.NONE;
}

/**
 * WHAT A COPY HOLDS — the scope the certification is about.
 *
 * WHY IT MATTERS: "this copy booted" is only meaningful together with "what was
 * in it". A configuration-only copy that booted says nothing about the plugin
 * tree; a slim copy says nothing about plugins that were never copied. The
 * report has to be able to say which of those it is instead of implying that
 * every copy holds everything.
 */
export const CONTENT_SCOPES = Object.freeze({
  CONFIG_ONLY: 'config-only',
  CONFIG_PLUGINS: 'config+plugins',
  CONFIG_LINKS: 'config+links',
  SLIM: 'slim',
});

const CONTENT_SCOPE_SET = new Set(Object.values(CONTENT_SCOPES));

/** An unknown scope string is `null`, never the field's neighbour by luck. */
function normalizeContentScope(raw) {
  return typeof raw === 'string' && CONTENT_SCOPE_SET.has(raw) ? raw : null;
}

/** A fingerprint is a non-empty string; everything else is "not recorded". */
function normalizeFingerprint(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Normalize a moment into an ISO string, or `null` when there is no moment.
 *
 * ISO ON PURPOSE: `at` is epoch milliseconds (a number, cheap to compare) while
 * this one is read by humans in a report, so it is stored the way it is shown.
 */
function normalizeIsoTime(raw, fallbackMs = null) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (Number.isFinite(raw)) return new Date(Number(raw)).toISOString();
  if (Number.isFinite(fallbackMs)) return new Date(Number(fallbackMs)).toISOString();
  return null;
}

/**
 * Read the identity of one backup directory.
 *
 * A missing or unreadable meta.json is NOT an error: it means the backup was
 * written before the identity layer existed, and the answer is `'unknown'`.
 *
 * TWO SHAPES, ONE ANSWER (2026-11-02). A `meta.json` on any machine today is one
 * of these:
 *   - facts  (`trigger` / `boot`) — written by this build;
 *   - verdict (`kind` / `reason` / `certifiedBy` / `certificationEvidence`) —
 *     written by older builds.
 * Both are read here, and the old vocabulary is DERIVED from the facts for the
 * readers above this layer (see `verificationOf`). Nothing throws, and a record
 * that cannot answer a question answers `null` — "not recorded" — never a guess:
 * an unknown judgement is kept as an unknown judgement and only ever read as a
 * fact.
 *
 * @param {string} backupDir
 * @returns {{ kind: string, at: number|null, takenAt: string|null, trigger: string|null, version: string|null, bootId: string|null, requestId: number|null, reason: string|null, upgradedAt: number|null, boot: object|null, certifiedBy: string, certificationEvidence: string|null, certifiedAt: string|null, contentFingerprint: string|null, contentScope: string|null, intervention: boolean|null }}
 */
/**
 * THE BOOT AN OLD RECORD REALLY DESCRIBES (2026-11-02).
 *
 * A meta written before this layer existed has no `boot` object: it has
 * `certifiedBy` / `certificationEvidence` / `certifiedAt`. Those three already said
 * two facts — "a boot was observed" and "(or not) that boot was running this
 * copy's content" — so an old record is READ as the observation it recorded. That
 * is the legacy translation path, and it is why changing the selector to facts
 * does not make every existing install unable to restore anything.
 *
 * A seed is NOT translated into a boot: it was taken before anything ran, so
 * saying "the instance came up" about it would be inventing an observation.
 *
 * @param {object|null} parsed a meta.json as it is on disk
 * @returns {object|null}
 */
export function legacyBootFactsOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!isCertifyingSource(parsed.certifiedBy)) return null;
  const source = normalizeCertifiedBy(parsed.certifiedBy);
  if (source === CERTIFIED_BY.SEED) return null;
  return {
    started: true,
    at: normalizeIsoTime(parsed.certifiedAt, Number.isFinite(parsed.at) ? parsed.at : null),
    observedBy: source === CERTIFIED_BY.FULL_CHECKS
      ? BOOT_OBSERVATIONS.STARTUP_CHECKS
      : (source === CERTIFIED_BY.COMMAND_PROBE
        ? BOOT_OBSERVATIONS.HEALTH_PROBE
        : BOOT_OBSERVATIONS.MANUAL_ROLLBACK),
    ranContent: normalizeFingerprint(parsed.contentFingerprint),
    contentMatched: isProvingEvidence(parsed.certificationEvidence),
    loadFailures: null,
  };
}

export function readBackupMeta(backupDir) {
  const empty = {
    kind: KIND_UNKNOWN,
    at: null,
    takenAt: null,
    trigger: null,
    version: null,
    bootId: null,
    requestId: null,
    reason: null,
    upgradedAt: null,
    // NO BOOT IS ON RECORD for a copy whose meta cannot be read: `null`, not an
    // empty boot object (which would say "a boot was observed and it told us
    // nothing").
    boot: null,
    // AN OLD meta.json HAS NONE OF THESE. It must read as "not certified" — not
    // as an error, and above all not as safe: those copies were written before
    // there was any evidence to store.
    certifiedBy: CERTIFIED_BY.NONE,
    // AND AN OLD meta.json HAS NO CRITERION EITHER — including the two broken
    // configurations the previous code stamped `certifiedBy=full-checks` on the
    // hosted instance. `null` is what turns those stamps into "not trusted"
    // instead of "trusted without a check" (see `isCertifiedBackup`).
    certificationEvidence: CERTIFICATION_EVIDENCE.NONE,
    certifiedAt: null,
    contentFingerprint: null,
    contentScope: null,
    intervention: null,
  };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(String(backupDir ?? ''), META_NAME), 'utf8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  // THE OLD VOCABULARY IS DERIVED HERE, ONCE, for both shapes.
  const verification = verificationOf(parsed);
  const boots = isFactRecord(parsed);
  return {
    kind: verification.kind,
    at: Number.isFinite(parsed.at) ? parsed.at : null,
    // A NEW RECORD SAYS WHEN IT WAS TAKEN IN ISO FORM. An old one did not, so the
    // answer falls back to the epoch value it does carry — the same moment, said
    // the way the newer field says it.
    takenAt: normalizeIsoTime(parsed.takenAt, Number.isFinite(parsed.at) ? parsed.at : null),
    // AN OLD SEED KEEPS WHAT IT IS: `certifiedBy: 'seed'` recorded "taken at
    // install time, before anything ran", which is exactly the `first-install`
    // trigger. Without this the prune could not tell the seed from any other old
    // copy when deciding what to spare.
    trigger: !boots && normalizeCertifiedBy(parsed.certifiedBy) === CERTIFIED_BY.SEED
      ? BACKUP_TRIGGERS.FIRST_INSTALL
      : (boots ? normalizeTrigger(parsed.trigger) ?? BACKUP_TRIGGERS.PRE_RESTART : null),
    version: typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null,
    bootId: typeof parsed.bootId === 'string' && parsed.bootId !== '' ? parsed.bootId : null,
    requestId: Number.isFinite(parsed.requestId) ? parsed.requestId : null,
    // `reason` IS ONLY READ, NEVER WRITTEN (2026-11-02): in a new record the
    // trigger and the boot facts say what it used to say, and saying it twice
    // would give the old wording a second life on disk.
    reason: typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : null,
    upgradedAt: Number.isFinite(parsed.upgradedAt) ? parsed.upgradedAt : null,
    // AN OLD RECORD'S `certifiedBy` IS READ AS THE BOOT IT DESCRIBED (see
    // `legacyBootFactsOf`): the selector and the prune read facts, and an old
    // record still has to answer "did this copy's content come up".
    boot: boots ? bootFactsOf(parsed.boot) : legacyBootFactsOf(parsed),
    certifiedBy: verification.certifiedBy,
    certificationEvidence: verification.certificationEvidence,
    certifiedAt: verification.certifiedAt,
    contentFingerprint: normalizeFingerprint(parsed.contentFingerprint),
    contentScope: normalizeContentScope(parsed.contentScope),
    intervention: typeof parsed.intervention === 'boolean' ? parsed.intervention : null,
  };
}

/**
 * Write the identity of one backup directory — AS FACTS.
 *
 * WHAT IS NO LONGER WRITTEN, AND WHY (user decision, 2026-11-02: "记录里也一起清
 * 掉"): `kind: 'known-good'`, `reason: 'boot-ok'`, `certifiedBy: 'full-checks'`,
 * `certificationEvidence`, `certifiedAt`. Every one of them read like a judgement
 * about the plugins in the copy ("this is the good one", "this is certified"),
 * while the only thing that had really been observed was one boot. A record that
 * cannot be distinguished from a promise is the wrong thing to leave on a user's
 * disk.
 *
 * WHAT IS WRITTEN INSTEAD: when it was taken, what triggered it, what it holds,
 * and what the boot that followed reported (`null` when there was none). See
 * `BACKUP_TRIGGERS` / `BOOT_OBSERVATIONS`.
 *
 * LEGACY INPUTS ARE STILL ACCEPTED AND TRANSLATED, not stored: the call sites and
 * the fixtures that still pass `kind` / `certifiedBy` are answering a question in
 * the old vocabulary, so the answer is converted into facts here instead of
 * being copied to disk. That is also what keeps old tests and old callers working
 * without letting the old wording survive in a file.
 *
 * Best effort: a backup whose meta cannot be written stays a usable `'unknown'`
 * one (it is never used for an AUTOMATIC rollback, but it is still on disk).
 *
 * @param {string} backupDir
 * @param {object} [meta] facts, or the legacy inputs they are translated from
 * @returns {boolean} whether it was written
 */
export function writeBackupMeta(backupDir, meta = {}) {
  const at = Number.isFinite(meta.at) ? meta.at : Date.now();
  let boot = bootFactsOf(meta.boot);
  // WHAT PUT THIS COPY THERE. An explicitly named trigger wins; an explicitly
  // "unknown" kind (or a word this build does not know) records NO trigger at all,
  // because the honest answer to "what is this copy?" is then "not recorded" — and
  // a record without a trigger reads back as `unknown`, exactly like a copy written
  // before this layer existed.
  const explicitTrigger = normalizeTrigger(meta.trigger);
  let triggerValue;
  if (explicitTrigger !== null) triggerValue = explicitTrigger;
  else if (normalizeKind(meta.kind) === KIND_UNKNOWN) triggerValue = null;
  else triggerValue = triggerOf({ kind: meta.kind, reason: meta.reason });
  // A LEGACY WRITE IS TRANSLATED HERE, NOT STORED (2026-11-02). `certifiedBy` named
  // who signed and `certificationEvidence` named the criterion; together they
  // already said two facts — "a boot was observed" and "(or not) it was running
  // this content" — so that is what gets written, and the sentence on disk is the
  // one that can be checked.
  if (boot === null && isCertifyingSource(meta.certifiedBy)) {
    const source = normalizeCertifiedBy(meta.certifiedBy);
    if (source === CERTIFIED_BY.SEED) {
      // The seed is not a boot: it was taken before anything ran. It keeps its own
      // positioning, which is exactly what the trigger says.
      triggerValue = BACKUP_TRIGGERS.FIRST_INSTALL;
    } else {
      boot = {
        // Every one of these inputs came from a promotion, i.e. from a boot that
        // had already come up — the one thing `reason: 'boot-ok'` used to say.
        started: true,
        at: normalizeIsoTime(meta.certifiedAt, at),
        observedBy: source === CERTIFIED_BY.FULL_CHECKS
          ? BOOT_OBSERVATIONS.STARTUP_CHECKS
          : (source === CERTIFIED_BY.COMMAND_PROBE
            ? BOOT_OBSERVATIONS.HEALTH_PROBE
            : BOOT_OBSERVATIONS.MANUAL_ROLLBACK),
        ranContent: normalizeFingerprint(meta.contentFingerprint),
        contentMatched: isProvingEvidence(meta.certificationEvidence),
        // Nobody recorded the plugin load failures through this shape of call.
        loadFailures: null,
      };
    }
  }
  const record = {
    at,
    takenAt: normalizeIsoTime(meta.takenAt, at),
    trigger: triggerValue,
    version: typeof meta.version === 'string' && meta.version !== '' ? meta.version : null,
    bootId: typeof meta.bootId === 'string' && meta.bootId !== '' ? meta.bootId : null,
    requestId: Number.isFinite(meta.requestId) ? meta.requestId : null,
    upgradedAt: Number.isFinite(meta.upgradedAt) ? meta.upgradedAt : null,
    // THE CONTENT, as it is: a digest of the configuration files and the scope of
    // what was copied. Both are facts about bytes, not grades.
    contentFingerprint: normalizeFingerprint(meta.contentFingerprint),
    contentScope: normalizeContentScope(meta.contentScope),
    // WHETHER THE BOOT THAT FOLLOWED NEEDED HELP. Three values: true / false /
    // null ("nobody recorded it").
    intervention: typeof meta.intervention === 'boolean' ? meta.intervention : null,
    boot,
  };
  try {
    fs.writeFileSync(path.join(String(backupDir ?? ''), META_NAME), JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The fingerprint of what a copy CONTAINS (configuration level).
 *
 * WHY A FINGERPRINT AND NOT JUST "THIS DIRECTORY": a certification is about a
 * CONTENT, not about a path. If the same directory is edited after the fact — a
 * half-finished hand edit is exactly how the 2026-11-01 incident started — then
 * "this copy booted" stops being true of what is in it now, and the fingerprint
 * is what makes that visible. It covers the files that decide whether the host
 * comes up, by name and by content, so editing one byte of one of them changes
 * the digest, and so does adding or removing one.
 *
 * The length is hashed in front of every content so that two different
 * name/content splits can never produce the same input stream.
 *
 * @param {string} backupDir
 * @returns {string} `sha256:<hex>` — never null, even for an empty copy
 */
export function contentFingerprintOf(backupDir) {
  const dir = typeof backupDir === 'string' ? backupDir : '';
  const hash = createHash('sha256');
  for (const name of CONFIG_FILES) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, CONFIG_DIR, name), 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      hash.update(name + '\u0000missing\u0000');
      continue;
    }
    hash.update(name + '\u0000' + Buffer.byteLength(text, 'utf8') + '\u0000' + text);
  }
  return 'sha256:' + hash.digest('hex');
}

/**
 * WHAT THIS COPY HOLDS — from what is really on disk in it.
 *
 * It describes the copy, it does not grade it: a `config-only` copy that booted
 * is a perfectly good answer for "the configuration boots", and a lie for "the
 * plugin tree boots". The report needs both halves to say anything true.
 *
 * `includePlugins` / `slim` are taken from the creator when they are known,
 * because the directory alone cannot tell a slim copy (third-party tree
 * deliberately left out, it is reinstallable from the lock file) from a full copy
 * of a profile that simply had no `node_modules`.
 *
 * @param {string} backupDir
 * @param {{ includePlugins?: boolean|null, slim?: boolean|null }} [options]
 * @returns {string} one of CONTENT_SCOPES
 */
export function contentScopeOf(backupDir, { includePlugins = null, slim = null } = {}) {
  const dir = typeof backupDir === 'string' ? backupDir.trim() : '';
  const manifest = dir === '' ? null : readManifest(dir);
  const pluginsRequested = includePlugins === null
    ? Boolean(manifest && manifest.includePlugins === true)
    : includePlugins === true;
  if (!pluginsRequested) return CONTENT_SCOPES.CONFIG_ONLY;
  let hasTree = false;
  try {
    hasTree = fs.existsSync(path.join(dir, PLUGINS_DIR)) === true;
  } catch {
    hasTree = false;
  }
  if (hasTree) return CONTENT_SCOPES.CONFIG_PLUGINS;
  let hasLinks = false;
  try {
    const linksDir = path.join(dir, LINKS_DIR);
    hasLinks = fs.existsSync(linksDir) === true && fs.readdirSync(linksDir).length > 0;
  } catch {
    hasLinks = false;
  }
  if (hasLinks) return CONTENT_SCOPES.CONFIG_LINKS;
  return slim === true ? CONTENT_SCOPES.SLIM : CONTENT_SCOPES.CONFIG_ONLY;
}

/**
 * IS THIS DIRECTORY A COMPLETE BACKUP? — the question nothing used to ask.
 *
 * WHAT WENT WRONG WITHOUT IT (2026-11-01): 23 directories under the real backups
 * root were listed, compared against and offered for restore while holding
 * **nothing but `node_modules-link/`**: no `config/`, no `manifest.json`, no
 * `meta.json`. Each reader had its own half-answer — `listBackups` skipped the
 * ones without a manifest, `contentScopeOf` guessed a scope from the pieces it
 * found — so "is this a backup?" was never answered in one place, and a
 * directory shaped like the incident could still be described as restorable.
 *
 * The answer is deliberately strict and cheap: a backup is complete when it has
 * a readable manifest AND at least one configuration file. It does NOT decide
 * whether the copy is TRUSTED (that is `isRestoreEligible`, which needs
 * certification) and it is not a content comparison — it only refuses to call a
 * gutted directory a backup.
 *
 * @param {string} backupDir
 * @returns {boolean}
 */
export function backupIsComplete(backupDir) {
  const dir = typeof backupDir === 'string' ? backupDir.trim() : '';
  if (dir === '') return false;
  const manifest = readManifest(dir);
  if (manifest === null) return false;
  for (const name of CONFIG_FILES) {
    try {
      if (fs.existsSync(path.join(dir, CONFIG_DIR, name)) === true) return true;
    } catch {
      // Keep looking: one unreadable entry does not answer for the others.
    }
  }
  return false;
}

/**
 * RECORD WHAT HAPPENED AFTER THIS COPY: the boot that followed it, if one did.
 *
 * THE NAME IS HISTORICAL (kept so the call sites and the fixtures that use it keep
 * working): this used to PROMOTE a copy to "known-good" and stamp it as safe. Since
 * 2026-11-02 it records FACTS — when the boot was observed, what looked at it, and
 * whether that boot was running exactly the content the copy holds — and nothing
 * about the plugins inside. "Is this copy good?" is not a question the file
 * answers any more; "did a boot on this content come up?" is.
 *
 * WHAT CHANGED AND WHY (2026-11-01): this used to promote unconditionally, with
 * a fixed reason. That is how a bad pre-restart state got certified: the boot
 * only came up because someone intervened, so "the copy from before that boot"
 * was the broken one. A record now requires the caller to say WHAT was observed:
 *
 *   - nothing stated (no legacy `certifiedBy`, no `observedBy`) → NOTHING is
 *     written, the meta is NOT rewritten, and the caller is told why. An old call
 *     site that still says `markKnownGood(dir, { reason: 'boot-ok' })` therefore
 *     degrades into "no boot on record" — the safe direction to fail in (better no
 *     fallback than a false one).
 *   - a real observation (`startup-checks` / `health-probe` / `manual-rollback`,
 *     or the legacy source name that means the same thing) → the facts are
 *     written: when it was observed, what was running, whether the content
 *     matched, and which plugin load failures that boot reported.
 *
 * The CONTENT never changes: "it booted on this content" IS the fact, and it is
 * written where the next rollback looks for it.
 *
 * The startup checks and the health probe are NOT interchangeable — a health probe
 * in command mode proves the process answers; the four startup checks prove the
 * routes, plugins and recovery work. Both are recorded as what they are, because
 * `observedBy` says which one looked.
 *
 * AND THE ANSWER TO "WAS IT THIS CONTENT" TRAVELS WITH IT (2026-11-01): a record
 * states `contentMatched: true` only when the copy's configuration was compared
 * with the one that really booted and the two were equal. A record that says
 * nothing about it still keeps the boot facts — the caller may need them — but the
 * copy is NOT a restore candidate afterwards, because `isCertifiedBackup` needs
 * both halves. Recording the source without the comparison is exactly the shape
 * the two broken configurations on the hosted instance had, so the difference MUST
 * be visible in the meta instead of assumed away.
 *
 * THE ONE THING THIS FUNCTION REFUSES TO DO: erase a comparison that is already on
 * record. `contentMatched` falls back to what the copy carries, so a later
 * promotion that says nothing about it cannot silently un-prove a proven copy.
 * Removing that record is a decision of its own, not a side effect of re-writing
 * the same file.
 *
 * @param {string} backupDir
 * @param {{
 *   reason?: string,                       (legacy, no longer stored)
 *   version?: string|null,
 *   bootId?: string|null,
 *   now?: number,
 *   certifiedBy?: string,                  (legacy input, translated)
 *   certificationEvidence?: any,           (legacy input, translated)
 *   certifiedAt?: string|number|null,      (legacy input → when the boot was seen)
 *   trigger?: string|null,
 *   observedBy?: string|null,
 *   hostStarted?: boolean|null,
 *   contentMatched?: boolean|null,
 *   loadFailures?: Array<object>|null,
 *   contentFingerprint?: string|null,
 *   contentScope?: string|null,
 *   intervention?: boolean|null,
 * }} [options]
 * @returns {{ promoted: boolean, reason: string, meta: object|null }}
 *   `promoted` is false whenever nothing was written — and `reason` always says
 *   why, so a caller that logs it is telling the truth when nothing happened.
 */
export function markKnownGood(backupDir, {
  // LEGACY, KEPT FOR THE CALLERS THAT STILL SPEAK IT (2026-11-02): `reason` is no
  // longer stored, and `certifiedBy` / `certificationEvidence` / `certifiedAt` are
  // translated into facts below instead of being written.
  reason = null,
  version = null,
  bootId = null,
  now = Date.now(),
  certifiedBy = null,
  certificationEvidence = null,
  certifiedAt = null,
  // THE FACTS A CALLER STATES TODAY (see `BACKUP_TRIGGERS` / `BOOT_OBSERVATIONS`).
  observedBy = null,
  hostStarted = null,
  contentMatched = null,
  loadFailures = null,
  trigger = null,
  contentFingerprint = null,
  contentScope = null,
  intervention = null,
} = {}) {
  // NO OBSERVATION, NO PROMOTION. Read the meta only to hand it back (untouched).
  // The two refusals are worded differently on purpose: "you told me nothing" and
  // "you told me something that proves nothing" are different mistakes, and the
  // log has to be able to tell them apart.
  //
  // A CALLER MAY STATE THE FACT INSTEAD OF THE OLD VERDICT (2026-11-02): passing
  // `observedBy` (one of BOOT_OBSERVATIONS) says what was really looked at on that
  // boot, and that is accepted in place of `certifiedBy`. Both inputs end up as the
  // same facts on disk; neither of them survives as a judgement.
  const statedObservation = typeof observedBy === 'string' && BOOT_OBSERVATION_SET.has(observedBy);
  if (!isCertifyingSource(certifiedBy) && !statedObservation) {
    const current = readBackupMeta(backupDir);
    const said = certifiedBy === undefined || certifiedBy === null
      ? 'no boot record was given, so nothing says the copy ever came up'
      : 'the source ' + JSON.stringify(String(certifiedBy)) + ' was given, but that does not record a boot';
    return { promoted: false, reason: said, meta: current };
  }
  const source = normalizeCertifiedBy(certifiedBy);
  const current = readBackupMeta(backupDir);
  const manifest = readManifest(backupDir);
  // Nothing to promote: neither an identity nor a manifest to stand on.
  if (manifest === null && current.kind === KIND_UNKNOWN) {
    return { promoted: false, reason: 'the copy has neither a readable meta.json nor a manifest', meta: current };
  }
  const at = current.at !== null ? current.at : (manifest && Number.isFinite(manifest.at) ? manifest.at : now);
  // THE OBSERVATION BEHIND THE OLD SOURCE NAME, translated: a legacy caller that
  // says "full-checks" is saying the four startup checks ran on that boot.
  const observationOfSource = (value) => {
    if (value === CERTIFIED_BY.FULL_CHECKS) return BOOT_OBSERVATIONS.STARTUP_CHECKS;
    if (value === CERTIFIED_BY.COMMAND_PROBE) return BOOT_OBSERVATIONS.HEALTH_PROBE;
    if (value === CERTIFIED_BY.MANUAL_ROLLBACK) return BOOT_OBSERVATIONS.MANUAL_ROLLBACK;
    return null;
  };
  const previousBoot = current.boot !== null && typeof current.boot === 'object' ? current.boot : null;
  // A SEED IS NOT A BOOT: the first-install copy was taken before anything ran, so
  // stating `seed` must not invent a boot record for it. Everything else is a
  // promotion that follows a boot, and the boot is what gets written down.
  const boot = source === CERTIFIED_BY.SEED
    ? previousBoot
    : {
      // "the host came up" — the one thing a promotion always implies, and the
      // legacy `reason: 'boot-ok'` used to say. A caller that knows better says so.
      started: typeof hostStarted === 'boolean' ? hostStarted : true,
      // WHEN IT WAS OBSERVED. The promotion is the moment the evidence appeared.
      at: normalizeIsoTime(certifiedAt, now),
      observedBy: statedObservation ? observedBy : observationOfSource(source),
      // WHAT WAS RUNNING: the fingerprint the comparison accepted, when the caller
      // passes it. `null` = not recorded.
      ranContent: normalizeFingerprint(contentFingerprint),
      // WAS IT THE CONTENT THIS COPY HOLDS — the old `fingerprint-match`, said as
      // the answer to a question. A copy that already carries a matched answer
      // keeps it when this promotion says nothing about it: re-writing the record
      // of a copy must never quietly un-prove it.
      contentMatched: typeof contentMatched === 'boolean'
        ? contentMatched
        : (isProvingEvidence(certificationEvidence) || previousBoot?.contentMatched === true),
      // THE PLUGIN LOAD FAILURES THAT BOOT REPORTED. `[]` = it reported none,
      // `null` = nobody looked. Never invented as an empty list.
      loadFailures: normalizeLoadFailures(loadFailures) ?? previousBoot?.loadFailures ?? null,
    };
  const written = writeBackupMeta(backupDir, {
    at,
    // WHEN THE COPY ITSELF WAS TAKEN — not when this record was rewritten.
    takenAt: current.takenAt,
    // WHAT PUT IT THERE. Stating the seed IS stating the trigger; otherwise the
    // trigger the copy already carries is preserved.
    trigger: source === CERTIFIED_BY.SEED
      ? BACKUP_TRIGGERS.FIRST_INSTALL
      : (normalizeTrigger(trigger) ?? current.trigger ?? BACKUP_TRIGGERS.PRE_RESTART),
    version: version !== null && version !== undefined ? version : current.version,
    bootId: bootId !== null && bootId !== undefined ? bootId : current.bootId,
    requestId: current.requestId,
    upgradedAt: now,
    boot,
    // The fingerprint is recomputed from THIS copy when the caller does not pass
    // one, so "the content on record" always names a real content. A fingerprint
    // already stored at creation time is kept when it matches nothing else.
    contentFingerprint: typeof contentFingerprint === 'string' && contentFingerprint !== ''
      ? contentFingerprint
      : (current.contentFingerprint || contentFingerprintOf(backupDir)),
    contentScope: typeof contentScope === 'string' && contentScope !== ''
      ? contentScope
      : (current.contentScope || contentScopeOf(backupDir)),
    // The intervention belongs to THIS boot. A caller that knows nothing passes
    // null and it stays null; it is never invented as `false`.
    intervention: typeof intervention === 'boolean' ? intervention : current.intervention,
  });
  if (!written) {
    return { promoted: false, reason: 'the meta.json of this copy could not be written', meta: current };
  }
  const meta = readBackupMeta(backupDir);
  // THE REASON SAYS WHICH OF THE TWO THINGS HAPPENED (2026-11-01): the facts were
  // recorded WITH a matched content, or WITHOUT one. A caller that logs this line
  // must not be able to read a criterion-free record as a success — that is the
  // reading that made the 71B copy look safe.
  return {
    promoted: true,
    reason: isCertifiedBackup(meta)
      ? 'a boot was observed (' + meta.certifiedBy + ') and it was running this content'
      : 'the source ' + (meta.certifiedBy === CERTIFIED_BY.NONE ? 'none' : meta.certifiedBy)
        + ' was recorded without a checkable criterion, so nothing says the content came up',
    meta,
  };
}

/**
 * MAY THIS COPY BE PUT BACK BY THE SYSTEM? (2026-11-02 - the ONE answer)
 *
 * TWO CALLERS USED TO DISAGREE, and this function exists to stop that:
 * `selectRestoreTarget` (the watchdog) read `boot.started && boot.contentMatched`,
 * while `latestKnownGood` (single-plugin recovery) read `kind === 'known-good'`
 * plus `restoreEligible` - two rulers over the same directory, so the same copy
 * could be "a restore point" to one path and "not a restore point" to the other.
 * A copy that one path would roll back to and the other would refuse is a bug the
 * user pays for at the worst possible moment.
 *
 * THE CRITERION IS RECORDED FACTS ONLY - never a stamp, never a verdict:
 *   - `boot.started === true`        the instance came up after this copy was taken;
 *   - `boot.contentMatched === true` what came up was this copy's content;
 *   - no rescue was needed (`intervention`), because a copy whose own boot had to
 *     be rescued has already shown it does not come up on its own.
 *
 * ON `intervention === null` (nobody recorded it): the contract names
 * `intervention !== true` as the bound, and this reads it the strict way - a
 * missing record is not a licence, it is `intervention-unrecorded`. That is the
 * reading the watchdog has always had and the one its tests pin; the other way
 * would mean the system restores what it could not check.
 *
 * OLD RECORDS: `readBackupMeta` translates a pre-boot record into the facts it
 * described (`legacyBootFactsOf`), so an old copy is judged by what its record
 * says - and a record that claims a check but carries no boot fact stays out.
 *
 * @param {object|null} meta a meta.json as `readBackupMeta` returns it
 * @returns {boolean}
 */
export function isUsableRestorePoint(meta) {
  if (meta === null || typeof meta !== 'object') return false;
  const boot = meta.boot;
  // THE INSTALL-TIME COPY IS A FACT, NOT A LABEL (see `trigger`): it was taken
  // before anything ran, so "did this content come up" has no answer to give -
  // and the machine that is now running is by definition the state the user
  // installed. It stays usable while it is still the record of that state.
  if (meta.trigger === BACKUP_TRIGGERS.FIRST_INSTALL) return true;
  if (boot === null || typeof boot !== 'object') return false;
  if (boot.started !== true || boot.contentMatched !== true) return false;
  // AN UNRECORDED RESCUE IS NOT A LICENCE (user decision, 2026-11-02): only an
  // explicit "no rescue was needed" counts. "nobody wrote it down" is
  // exactly the case where the system must not act on its own.
  return meta.intervention === false;
}

/**
 * Why `isUsableRestorePoint` said no - one sentence per reason, for reports.
 *
 * @param {object|null} meta
 * @returns {string|null} null when the copy IS usable
 */
export function restorePointRefusal(meta) {
  if (meta === null || typeof meta !== 'object') return 'no record of this copy could be read';
  const boot = meta.boot;
  if (boot === null || typeof boot !== 'object') {
    return 'it carries no record of a restart, so nobody knows whether its content ever came up';
  }
  if (boot.started !== true || boot.contentMatched !== true) {
    return 'its restart record does not say both that the instance came up AND that the content matched'
      + ' (started=' + (boot.started === true) + ', contentMatched=' + (boot.contentMatched === true) + ')';
  }
  if (meta.intervention === true) {
    return 'its own boot had to be rescued, so it has already shown it does not come up on its own';
  }
  if (meta.intervention !== false) {
    return 'nobody recorded whether that boot had to be rescued';
  }
  return null;
}

/**
 * THE NEWEST BACKUP THAT MAY STILL BE USED AS THE AUTOMATIC FALLBACK — the only
 * valid target of an automatic rollback.
 *
 * IT ASKS THE SAME QUESTION AS THE WATCHDOG (2026-11-02): `isUsableRestorePoint`,
 * over recorded facts. It used to ask `kind === 'known-good' && restoreEligible`,
 * which is a different ruler over the same directory - see the comment on that
 * function for why two rulers were a bug.
 *
 * @param {string} backupsDir the backups ROOT (the directory holding the copies)
 * @returns {object|null}
 */
export function latestKnownGood(backupsDir) {
  for (const entry of listBackupIdentities(backupsDir)) {
    if (isUsableRestorePoint(entry) === true) return entry;
  }
  return null;
}

/**
 * Every backup with its identity, newest first (what the settings page and the
 * health route show: identity, time, size, version).
 *
 * @param {string} backupsDir the backups ROOT
 * @returns {Array<object>}
 */
export function listBackupIdentities(backupsDir) {
  return listBackups(backupsDir).map((backup) => {
    const meta = readBackupMeta(backup.dir);
    return {
      ...backup,
      kind: meta.kind,
      version: meta.version,
      reason: meta.reason,
      requestId: meta.requestId,
      upgradedAt: meta.upgradedAt,
      // WHAT PUT IT THERE, AND WHAT THE BOOT AFTER IT REPORTED (2026-11-02): the
      // facts the settings page and the reports read. `trigger` is null only for a
      // record written before this layer existed; `boot` is null whenever no boot
      // has been observed for this copy.
      takenAt: meta.takenAt,
      trigger: meta.trigger,
      boot: meta.boot,
      // THE OLD VOCABULARY, DERIVED (2026-11-02): kept because the selector and
      // the reports above this layer read it, and because a copy written by an
      // older build only speaks it. It is never written to a file.
      certifiedBy: meta.certifiedBy,
      // THE EVIDENCE TRAVELS WITH THE LISTING. The report and the settings page
      // have to be able to say "safe because X, checked with Y, at T, this
      // content" — a bare kind:'known-good' is exactly the label that lied in the
      // incident.
      certifiedBy: meta.certifiedBy,
      // WHICH CRITERION, so the interface can show the difference the user must
      // see: a copy proven by the fingerprint comparison vs. a copy whose stamp
      // cannot be verified any more (and is therefore not used).
      certificationEvidence: meta.certificationEvidence,
      certifiedAt: meta.certifiedAt,
      contentFingerprint: meta.contentFingerprint,
      contentScope: meta.contentScope,
      intervention: meta.intervention,
      // THE ONE DEFINITION OF "SAFE" — both halves, see `isCertifiedBackup`.
      // Historical pollution (a source without a criterion) is `false` here, and
      // that is what the watchdog selector reads.
      certified: isCertifiedBackup(meta),
      // The wider question (a copy an automatic rollback may use): the seed is
      // included here and NOT in `certified`, because the seed was never proven
      // and must not be recorded as if it had been.
      restoreEligible: isRestoreEligible(meta),
    };
  });
}

/** The report the detached helper writes when it rolls a backup back. */
export const ROLLBACK_REPORT_NAME = 'last-rollback.json';

/** The lock that makes sure a snapshot is restored ONCE. */
export const ROLLBACK_LOCK_NAME = 'rollback.lock';

/**
 * Claim the right to restore the snapshot.
 *
 * TWO parties can want to restore the snapshot at the same time: the plugin
 * itself (it saw that the restart failed) and the detached watcher (the host
 * never came back). Both copy the same files over the profile — two copies at
 * once would write the same files at the same time, and the plugin tree is
 * 117 MB.
 *
 * The claim is atomic: the file is CREATED, never opened, so exactly ONE
 * caller gets it. The loser stands down.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function claimRollbackLock(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return { ok: false, path: '', error: 'claimRollbackLock requires stateDir' };
  const file = path.join(dir, ROLLBACK_LOCK_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the directory may already be there */
  }
  // A lock that is older than 10 minutes belongs to a process that died in the
  // middle of its restore: it must not block the rollback for ever.
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    /* no lock there: nothing to clean up */
  }
  try {
    const handle = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(handle, String(process.pid ?? ''), 'utf8');
    } catch {
      /* the owner is what matters, not the note inside the file */
    }
    try {
      fs.closeSync(handle);
    } catch {
      /* nothing else to do */
    }
    return { ok: true, path: file, error: null };
  } catch {
    return { ok: false, path: file, error: 'another rollback is already running' };
  }
}

/**
 * Release the rollback lock.
 *
 * @param {string} stateDir
 * @returns {boolean} whether a lock was removed
 */
export function releaseRollbackLock(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, ROLLBACK_LOCK_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A filesystem-safe timestamp for a backup directory name.
 *
 * The name is in UTC on purpose: it sorts chronologically and it does not
 * depend on the timezone of the machine. The price is that it does NOT look
 * like the wall clock the operator reads (`2026-10-29T00-25-20-779Z` is
 * 08:25 in Shanghai) — so the manifest and the restart record carry the local
 * time as well, and a fresh snapshot can never be mistaken for an old one.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function backupStamp(now = Date.now()) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * The local time of an epoch, with the UTC offset (`2026-10-29T08:25:20+08:00`).
 *
 * @param {number|null|undefined} at
 * @returns {string|null}
 */
export function backupLocalTime(at) {
  const value = Number(at);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  const local = new Date(value + offsetMinutes * 60000).toISOString();
  return `${local.slice(0, 19)}${sign}${hours}:${minutes}`;
}

/**
 * The backups directory that belongs to a state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function backupsRoot(stateDir) {
  return path.join(String(stateDir ?? ''), 'backups');
}

/** Recursively measure a directory; never throws. */
function directorySize(target) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(child);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    try {
      bytes += fs.statSync(child).size;
      files += 1;
    } catch {
      // A file that vanished between readdir and stat is simply not counted.
    }
  }
  return { bytes, files };
}

/**
 * Copy one entry (file or directory) into a destination directory.
 *
 * @returns {boolean} whether anything was copied
 */
function copyEntry(source, destination) {
  try {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.cpSync(source, destination, { recursive: true, force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Measure a tree so the copy can report a REAL total (files and bytes).
 *
 * The plugin tree of a desktop profile is ~150 MB; walking it costs a few tens
 * of milliseconds and it is the only way to say "154 MB of 156 MB done" instead
 * of making a number up.
 *
 * @param {string} target
 * @returns {{ files: number, bytes: number }}
 */
export function measureTree(target) {
  return directorySize(target);
}

/**
 * The bundles a profile's package.json enables (`dsh.profile.bundles`).
 *
 * @param {string} packageJsonText
 * @returns {string[]}
 */
export function enabledBundlesOf(packageJsonText) {
  const text = typeof packageJsonText === 'string'
    ? (packageJsonText.charCodeAt(0) === 0xfeff ? packageJsonText.slice(1) : packageJsonText)
    : '';
  if (text.trim() === '') return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const profile = parsed && typeof parsed === 'object' ? parsed.dsh : null;
  const container = profile && typeof profile === 'object' ? profile.profile : null;
  const raw = container && typeof container === 'object' ? container.bundles : null;
  const bundles = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim() !== '') bundles.push(entry.trim());
    }
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    bundles.push(raw.trim());
  }
  return bundles;
}

/**
 * The LINKED plugins of a profile: `node_modules` entries that are symbol
 * links / junctions pointing at a directory.
 *
 * WHY THIS EXISTS (user decision, 2026-10-30). Five plugins on this machine are
 * installed with `link:` - including dsh-autorestart itself. A backup that
 * copies `node_modules` as a tree records the LINKS and none of their contents,
 * so the plugin that does the rescuing could not be put back: a real gap, found
 * by measurement (118 real copies in the backup, 5 links, 0 linked plugins).
 *
 * Only bundles the profile ENABLES are collected: a link that is switched off is
 * not something a restore has to bring back.
 *
 * Every filesystem call is injected, so this is testable without a real profile.
 *
 * @param {{
 *   profileDir?: string,
 *   bundles?: string[]|null,
 *   lstatFn?: Function,
 *   readlinkFn?: Function,
 *   readFileFn?: Function,
 *   existsFn?: Function,
 *   readdirFn?: Function,
 *   measureFn?: Function,
 *   platform?: string,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   links: Array<{ name: string, target: string, kind: string, exists: boolean, readable: boolean, files: number, bytes: number }>,
 *   enabled: string[],
 *   error: string|null,
 * }}
 */
export function collectLinkedPlugins(options = {}) {
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir : '';
  const lstat = typeof options.lstatFn === 'function' ? options.lstatFn : (target) => fs.lstatSync(target);
  const readlink = typeof options.readlinkFn === 'function' ? options.readlinkFn : (target) => fs.readlinkSync(target);
  const readFile = typeof options.readFileFn === 'function' ? options.readFileFn : (target) => fs.readFileSync(target, 'utf8');
  const exists = typeof options.existsFn === 'function' ? options.existsFn : (target) => fs.existsSync(target);
  const readdir = typeof options.readdirFn === 'function'
    ? options.readdirFn
    : (target) => fs.readdirSync(target, { withFileTypes: true });
  const measure = typeof options.measureFn === 'function' ? options.measureFn : measureTree;
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;

  if (profileDir === '') {
    return { ok: false, links: [], enabled: [], error: 'collectLinkedPlugins requires profileDir' };
  }
  const pluginsDir = path.join(profileDir, PLUGINS_DIR);
  if (exists(pluginsDir) !== true) {
    return { ok: true, links: [], enabled: [], error: null };
  }
  // Which bundles the profile answers "yes" to. `null` means "no filter", which
  // the caller uses when the package.json itself is unreadable: a restore then
  // still knows about the links instead of silently dropping them.
  const enabled = Array.isArray(options.bundles)
    ? options.bundles.map(String)
    : (() => {
      try {
        return enabledBundlesOf(readFile(path.join(profileDir, 'package.json')));
      } catch {
        return null;
      }
    })();

  const links = [];
  let entries = [];
  try {
    entries = readdir(pluginsDir);
  } catch (error) {
    return {
      ok: false,
      links: [],
      enabled: enabled === null ? [] : enabled,
      error: 'the plugin directory cannot be read: ' + (error && error.message ? error.message : String(error)),
    };
  }
  for (const entry of entries) {
    const name = entry && typeof entry.name === 'string' ? entry.name : String(entry);
    if (name === '' || name.startsWith('.')) continue;
    if (enabled !== null && enabled.includes(name) !== true) continue;
    const full = path.join(pluginsDir, name);
    let info = null;
    try {
      info = lstat(full);
    } catch {
      continue;
    }
    if (!info || typeof info.isSymbolicLink !== 'function' || info.isSymbolicLink() !== true) continue;
    let raw = '';
    try {
      raw = String(readlink(full));
    } catch {
      raw = '';
    }
    // A Windows junction always reports an ABSOLUTE target; a symbol link keeps
    // whatever it was created with (this machine's five links are relative).
    // Node exposes no reparse tag, so this is the best distinction available -
    // and it only ever shows up as a label in the manifest.
    const kind = platform === 'win32' && path.isAbsolute(raw) ? LINK_KINDS.JUNCTION : LINK_KINDS.SYMLINK;
    const target = raw === ''
      ? ''
      : (path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(pluginsDir, raw));
    const targetExists = target !== '' && exists(target) === true;
    let readable = false;
    let files = 0;
    let bytes = 0;
    if (targetExists) {
      try {
        const measured = measure(target);
        files = Math.max(0, Number(measured && measured.files) || 0);
        bytes = Math.max(0, Number(measured && measured.bytes) || 0);
        readable = true;
      } catch {
        readable = false;
      }
    }
    links.push({ name, target, kind, exists: targetExists, readable, files, bytes });
  }
  links.sort((left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)));
  return { ok: true, links, enabled: enabled === null ? [] : enabled, error: null };
}

/**
 * WHICH INSTALLED PLUGINS ARE "LOCAL", AND WHICH ARE PUBLISHED AS-IS.
 *
 * The user's rule (2026-11-02) has exactly TWO reliable signals, and this
 * function uses nothing else:
 *
 *   1. the entry is a SYMBOLIC LINK (`node_modules/<name>` → somewhere else) —
 *      a hand-written plugin, installed with `link:`;
 *   2. the entry is a real npm directory that CONTAINS `.git` — it was cloned or
 *      re-inited and then edited here, so its contents exist nowhere else.
 *
 * Anything else is "third-party as published": reinstalling from the pinned
 * lockfile reproduces it byte for byte, so it is only LISTED (name + version),
 * never copied.
 *
 * What is deliberately NOT used: comparing the directory against the published
 * tarball. The lockfile records one integrity hash per PACKAGE, not per file, so
 * that comparison would need the tarball itself (network or npm cache) — an
 * answer that is sometimes available is not a判据. `.git` is skipped inside the
 * copy (BACKUP_SKIP_NAMES): the history is rebuildable.
 *
 * @param {{ profileDir?: string }} [options]
 * @returns {{ ok: boolean, localized: Array<{name: string, dir: string, version: string|null}>, thirdParty: Array<{name: string, version: string|null}>, error: string|null }}
 */
export function collectLocalPluginDirs(options = {}) {
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir : '';
  const empty = { ok: false, localized: [], thirdParty: [], error: null };
  if (profileDir === '') return { ...empty, error: 'collectLocalPluginDirs requires profileDir' };
  const pluginsDir = path.join(profileDir, PLUGINS_DIR);
  if (fs.existsSync(pluginsDir) !== true) return { ok: true, localized: [], thirdParty: [] };

  /** `<dir>/node_modules/*` plus one level of `@scope/*`. */
  const entriesOf = (base) => {
    try {
      return fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  const candidates = [];
  for (const entry of entriesOf(pluginsDir)) {
    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    if (name === '' || name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      // A scope is not a plugin: look one level deeper.
      const scopeDir = path.join(pluginsDir, name);
      for (const inner of entriesOf(scopeDir)) {
        const innerName = inner && typeof inner.name === 'string' ? inner.name : '';
        if (innerName === '' || innerName.startsWith('.')) continue;
        candidates.push({ name: name + '/' + innerName, dir: path.join(scopeDir, innerName) });
      }
      continue;
    }
    candidates.push({ name, dir: path.join(pluginsDir, name) });
  }

  const localized = [];
  const thirdParty = [];
  for (const candidate of candidates) {
    let info = null;
    try {
      info = fs.lstatSync(candidate.dir);
    } catch {
      continue;
    }
    // A LINK is the first signal, handled by collectLinkedPlugins; it is not
    // counted here so the two lists never describe the same plugin twice.
    if (info && typeof info.isSymbolicLink === 'function' && info.isSymbolicLink() === true) continue;
    if (!info || typeof info.isDirectory !== 'function' || info.isDirectory() !== true) continue;
    const hasGit = fs.existsSync(path.join(candidate.dir, '.git')) === true;
    const version = pluginVersionIn(candidate.dir);
    if (hasGit === true) {
      localized.push({ name: candidate.name, dir: candidate.dir, version });
    } else {
      thirdParty.push({ name: candidate.name, version });
    }
  }
  const byName = (left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0));
  localized.sort(byName);
  thirdParty.sort(byName);
  return { ok: true, localized, thirdParty, error: null };
}

/**
 * THE VERSION OF ONE PLUGIN DIRECTORY, or null.
 *
 * Read from the directory itself (`package.json`), never from the live profile:
 * the manifest describes the COPY, and half the point of a backup is that the
 * installed thing may already have moved on. Never throws.
 *
 * @param {string} pluginDir
 * @returns {string|null}
 */
function pluginVersionIn(pluginDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    return parsed && typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * MAY THE LINK STAY, OR MUST THE BACKUP CONTENT TAKE ITS PLACE?
 *
 * The same decision is used by the restore script and by the watchdog, so a
 * manual restore and an automatic one cannot disagree:
 *
 *   - the link target is there and readable  -> KEPT (the development directory
 *     keeps working, which is the whole point of a `link:` installation);
 *   - the target is gone / unreadable        -> REPLACED (a host cannot start
 *     from a plugin that is not there);
 *   - forced, or a second attempt            -> REPLACED (the first attempt is
 *     the link's chance; a plugin that already failed once is not given a
 *     third);
 *   - there is no backup content for it      -> TARGET_MISSING / NO_BACKUP and
 *     the link is left exactly as it is (we never delete what we cannot replace).
 *
 * @param {{
 *   targetExists?: boolean, targetReadable?: boolean, hasBackup?: boolean,
 *   force?: boolean, attempts?: number,
 * }} [options]
 * @returns {{ action: string, replace: boolean, reason: string }}
 */
export function decideLinkRestore(options = {}) {
  const targetExists = options.targetExists === true;
  const targetReadable = options.targetReadable !== false && targetExists === true;
  const hasBackup = options.hasBackup === true;
  const forced = options.force === true;
  const attempts = Number.isFinite(Number(options.attempts)) ? Math.trunc(Number(options.attempts)) : 1;

  if (!targetExists && !hasBackup) {
    return {
      action: LINK_ACTIONS.TARGET_MISSING,
      replace: false,
      reason: 'the link target is gone and the backup holds no content for this plugin',
    };
  }
  if (!hasBackup) {
    return {
      action: LINK_ACTIONS.NO_BACKUP,
      replace: false,
      reason: 'the backup holds no content for this plugin, so the link is left untouched',
    };
  }
  if (forced) {
    return { action: LINK_ACTIONS.REPLACED, replace: true, reason: 'forced: the backup content replaces the link' };
  }
  if (!targetExists) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'the link target is gone: the backup content takes its place',
    };
  }
  if (!targetReadable) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'the link target cannot be read: the backup content takes its place',
    };
  }
  if (attempts >= 2) {
    return {
      action: LINK_ACTIONS.REPLACED,
      replace: true,
      reason: 'attempt ' + attempts + ': the link was given its chance and the host still did not come up',
    };
  }
  return { action: LINK_ACTIONS.KEPT, replace: false, reason: 'the link target is there and readable: the link stays' };
}

/**
 * Copy a directory tree FILE BY FILE, reporting real progress and honouring a
 * cancel request.
 *
 * `fs.cpSync` (what this used to be) copies 150 MB in one call: no progress, no
 * cancel, and no way to tell a busy disk from a dead host. The loop below copies
 * one file at a time, adds up the bytes that really landed and asks the caller
 * between files whether it should stop.
 *
 * IT YIELDS TO THE EVENT LOOP on purpose: the copy runs inside the host
 * process, and a copy that never yields blocks the very route the "cancel"
 * button posts to — the user could not call it off even though the code says
 * they can. Every `yieldEveryFiles` files (and every `yieldEveryMs`
 * milliseconds) the loop waits one tick, so the server stays answerable and the
 * progress reaches the interface while the copy is running.
 *
 * @param {{
 *   source: string,
 *   destination: string,
 *   onProgress?: Function|null,
 *   shouldCancel?: Function|null,
 *   progressEveryFiles?: number,
 *   yieldEveryFiles?: number,
 *   yieldEveryMs?: number,
 *   yieldToEventLoop?: Function|null,
 *   now?: Function,
 * }} options
 * @returns {Promise<{ ok: boolean, files: number, bytes: number, cancelled: boolean, error: string|null }>}
 */
export async function copyTreeWithProgress({
  source,
  destination,
  onProgress = null,
  shouldCancel = null,
  // NAMES THAT MUST NOT BE COPIED AT ALL (2026-11-01). A `link:`-installed
  // plugin is a working checkout, so it carries its `.git` — measured on the
  // real machine: one linked plugin alone dragged 962 files / ~74 MB of history
  // into every single backup. `.git` is rebuildable by design (clone/fetch), so
  // it is not "a thing that cannot be fetched again" and does not belong in a
  // restore point.
  excludeNames = null,
  progressEveryFiles = 25,
  yieldEveryFiles = 40,
  yieldEveryMs = 120,
  yieldToEventLoop = null,
  now = Date.now,
} = {}) {
  const from = typeof source === 'string' ? source : '';
  const into = typeof destination === 'string' ? destination : '';
  if (from === '' || into === '') {
    return { ok: false, files: 0, bytes: 0, cancelled: false, error: 'copyTreeWithProgress requires a source and a destination' };
  }
  const pause = typeof yieldToEventLoop === 'function'
    ? yieldToEventLoop
    : () => new Promise((resolve) => { setImmediate(resolve); });
  const clock = typeof now === 'function' ? now : Date.now;
  const skip = new Set(
    Array.isArray(excludeNames)
      ? excludeNames.map((name) => String(name)).filter((name) => name !== '')
      : [],
  );
  let files = 0;
  let bytes = 0;
  let cancelled = false;
  let error = null;
  const tick = { files: 0, at: clock(), yielded: clock() };
  const report = () => {
    if (typeof onProgress !== 'function') return;
    tick.at = clock();
    try {
      onProgress({ files, bytes });
    } catch {
      // A broken progress callback must never fail the backup itself.
    }
  };

  const walk = async (sourceDir, targetDir) => {
    let entries;
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (failure) {
      // A directory that cannot be read is skipped, exactly like before: a
      // single unreadable plugin directory must not break the whole snapshot.
      error = error === null ? (failure && failure.message ? failure.message : String(failure)) : error;
      return;
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      /* it may already exist */
    }
    for (const entry of entries) {
      if (typeof shouldCancel === 'function' && shouldCancel() === true) {
        cancelled = true;
        return;
      }
      if (skip.size > 0 && skip.has(entry.name)) continue;
      const childSource = path.join(sourceDir, entry.name);
      const childTarget = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await walk(childSource, childTarget);
        if (cancelled) return;
        continue;
      }
      try {
        fs.copyFileSync(childSource, childTarget);
        files += 1;
        try {
          bytes += fs.statSync(childTarget).size;
        } catch {
          /* the size is advisory */
        }
      } catch (failure) {
        error = error === null ? (failure && failure.message ? failure.message : String(failure)) : error;
        continue;
      }
      tick.files += 1;
      const moment = clock();
      if (tick.files >= progressEveryFiles || moment - tick.at >= 150) {
        tick.files = 0;
        report();
      }
      if (moment - tick.yielded >= yieldEveryMs || tick.files >= yieldEveryFiles) {
        tick.yielded = moment;
        // eslint-disable-next-line no-await-in-loop
        await pause();
        if (typeof shouldCancel === 'function' && shouldCancel() === true) {
          cancelled = true;
          return;
        }
      }
    }
  };

  await walk(from, into);
  report();
  if (cancelled) return { ok: false, files, bytes, cancelled: true, error: null };
  return { ok: true, files, bytes, cancelled: false, error };
}

/**
 * Remove a half-written backup (a cancelled copy must not look like a snapshot).
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function removeBackupDir(dir) {
  const target = typeof dir === 'string' ? dir.trim() : '';
  if (target === '') return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the newest `maxBackups` backup directories — but never at the price
 * of the last trusted fallback.
 *
 * THREE FLOORS, in this order:
 *
 *  1. THE LAST CERTIFIED COPY IS NEVER REMOVED (2026-11-01). "Certified" means
 *     `isRestoreEligible`: a source AND the criterion that can be re-checked
 *     (`fingerprint-match`), or the first-install seed. Whatever the limit says,
 *     the newest such copy survives: it is the one thing a failed boot can be
 *     rolled back to. A copy stamped by the old criterion is NOT in this list any
 *     more — it is not a fallback, so keeping it "because it says certified"
 *     would protect exactly the copy nobody may restore.
 *  2. NO CERTIFIED COPY AT ALL → NOTHING IS REMOVED. This is the strict-mode
 *     decision: disk space is cheaper than deleting the only copy that might
 *     still come in handy, and the caller has to be able to tell the customer
 *     "there is no trusted restore point". The answer says so (`skipped`), so
 *     the upper layer can say it out loud instead of quietly doing nothing.
 *  3. The pre-existing floors stay as they were: the newest known-good copy and
 *     the oldest copy are never victims.
 *
 * WHAT THIS IS NOT: it is not "keep only the newest copy" and it is not a
 * smarter policy — it is a floor under the existing one.
 *
 * @param {string} backupsDir
 * @param {number} [maxBackups]
 * @returns {{
 *   removed: string[],
 *   skipped: boolean,
 *   reason: string|null,
 *   budget: number,
 *   certifiedCount: number,
 *   keptCertified: string|null,
 * }} `removed` keeps its old meaning (the names that were really deleted);
 *   `skipped` is true when the floor above decided to delete nothing.
 */
export function pruneBackups(backupsDir, maxBackups = DEFAULT_MAX_BACKUPS) {
  const limit = Number.isFinite(Number(maxBackups)) && Number(maxBackups) >= 1
    ? Math.trunc(Number(maxBackups))
    : DEFAULT_MAX_BACKUPS;
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { removed: [], skipped: false, reason: 'the backups directory could not be read', budget: 0, certifiedCount: 0, keptCertified: null };
  }
  try {
    const metas = new Map();
    for (const name of names) metas.set(name, readBackupMeta(path.join(backupsDir, name)));
    // THE COPIES THAT MAY STILL BE RESTORED, oldest first: `names` is already
    // sorted, so the last entry of this list is the newest such copy.
    //
    // THE DEFINITION IS `isRestoreEligible`, NOT "does the meta name a source"
    // (2026-11-01): a criterion-free stamp is not a fallback, so it must not be the
    // reason a copy is kept alive OR the reason pruning believes it has something
    // to protect.
    const certified = names.filter((name) => isRestoreEligible(metas.get(name)));
    if (certified.length === 0) {
      // NO SAFE COPY YET — AND THE HISTORY STILL HAS TO CONVERGE (2026-11-02).
      //
      // The old FLOOR 2 rule kept EVERYTHING when nothing was certified, "because
      // there is no trusted fallback to keep". That protection was aimed at the
      // wrong thing: an UNPROVEN copy cannot be restored at all (the user's own
      // words), so keeping it protects nothing and only spends disk. A hosted WSL
      // instance certifies nothing, so it accumulated FIFTEEN copies — one per
      // restart, never converging.
      //
      // The design is simple: at most `maxBackups` copies; once a proof exists one
      // of them is the proven one. With no proof at all only the newest
      // `maxBackups` copies stay.
      //
      // Deliberately NOT protected in this branch: the "oldest reference" copy
      // (it earns its place only as a comparison against a proven copy, and there
      // is none here) and anything else — with no proof, "keep it just in case"
      // keeps nothing.
      const overLimitBudget = Math.max(0, names.length - limit);
      const unit = limit === 1 ? 'copy' : 'copies';
      if (overLimitBudget === 0) {
        return {
          removed: [],
          skipped: false,
          reason: null,
          budget: 0,
          certifiedCount: 0,
          keptCertified: null,
        };
      }
      const keep = new Set(names.slice(Math.max(0, names.length - limit)));
      const overLimit = names.filter((name) => !keep.has(name));
      // A DIRECTORY THAT WAS NEVER FINISHED GOES FIRST: no manifest and no
      // timestamp means a leftover, not a point in time.
      const unfinished = overLimit.filter((name) => {
        const manifest = readManifest(path.join(backupsDir, name));
        const meta = metas.get(name);
        return manifest === null || !meta || !Number.isFinite(meta.at);
      });
      const finished = overLimit.filter((name) => !unfinished.includes(name));
      const victims = [...unfinished, ...finished].slice(0, overLimitBudget);
      const removed = [];
      for (const name of victims) {
        const target = path.join(backupsDir, name);
        try {
          fs.rmSync(target, { recursive: true, force: true });
          removed.push(name);
        } catch {
          // A backup that cannot be removed must not fail the restart.
        }
      }
      return {
        removed,
        skipped: false,
        reason: removed.length === 0
          ? 'nothing was removed: the ' + overLimitBudget + ' ' + unit + ' over the limit could not be deleted'
          : 'no copy has a restart record saying it came up with matching content: trimmed to the newest '
            + limit + ' ' + unit + ' anyway (a copy with no such record is not a fallback, so it is not kept just in case)',
        budget: overLimitBudget,
        certifiedCount: 0,
        keptCertified: null,
      };
    }
    const keptCertified = certified[certified.length - 1];
    // WHO IS PROTECTED IS A RECORDED FACT, NOT A VERDICT (2026-11-02).
    //
    // The old protection set was built out of wording: "the newest known-good
    // copy" and "the last certified one". Those are opinions the plugin wrote
    // about a copy; the user's point is that a backup is either a directory with
    // contents or it is not, and what the plugin may keep has to follow from what
    // actually happened, not from an adjective it awarded itself.
    //
    // So there are exactly two keepers, both facts:
    //   1. the NEWEST copy — the one this restart just wrote; deleting it is how
    //      the 2026-11-02 report happened at all (that is pinned by a test);
    //   2. the newest copy whose restart record says the instance CAME UP and the
    //      content MATCHED (`boot.started` + `boot.contentMatched`) — the one copy
    //      a failed boot can honestly fall back to.
    // The previous "last certified one" protection is GONE: it kept a copy alive
    // because of a label, and a label is not a reason to spend disk.
    //
    // A COPY WITH NO `meta.json` HAS NO FACTS AT ALL (2026-11-02): the real hosted
    // machine had two such directories; `metas.get(name)` returned null and the
    // old code read `null.kind`, which threw and killed the whole prune. A meta
    // that cannot be read is simply "not the booted copy".
    const bootedName = (() => {
      for (const name of names.slice().reverse()) {
        const meta = metas.get(name);
        const boot = meta && meta.boot;
        if (boot && boot.started === true && boot.contentMatched === true) return name;
      }
      return null;
    })();
    // THE OLDEST BACKUP IS *USUALLY* KEPT TOO (2026-11-01): it is the "how it
    // looked when this machine was still fine" reference, and losing it is what
    // made the comparison against a backup meaningless after three restarts.
    //
    // BUT IT IS A PREFERENCE, NOT A PROTECTION (2026-11-02). Two facts forced
    // that: (a) the newest copy must never be the victim — on the real machine it
    // was the ONLY unprotected candidate, so "trim to the limit" deleted the
    // snapshot the restart had just written while a 0.1 MB leftover survived;
    // (b) keeping the oldest copy absolutely makes the list unable to converge at
    // all when oldest, booted and newest are three different copies — exactly the
    // real machine, which would then never get back to `maxBackups`.
    //
    // THE FIRST-INSTALL COPY IS A PREFERENCE OF THE SAME WEIGHT (2026-11-02): it
    // used to be kept forever because its meta said `certifiedBy: 'seed'`. It is
    // the only copy of "what the machine looked like before anything happened",
    // so it is worth sparing — but only while there is room, exactly like the
    // oldest one. Nothing is kept forever on the strength of a label.
    //
    // A rollback that is IN PROGRESS is protected another way: its undo copy is
    // written with `pruneEnabled: false`, so no prune can touch the copy being
    // restored.
    const oldestName = names.length > 0 ? names[0] : null
    const newestName = names.length > 0 ? names[names.length - 1] : null
    const seedName = (() => {
      for (const name of names) {
        const meta = metas.get(name);
        if (!meta) continue;
        // WHAT PUT IT THERE is a fact written when the copy was made. A seed has
        // no boot record at all (nothing had run yet when it was taken), so
        // `trigger` is the honest way to recognise it — plus the legacy stamp for
        // metas written by an older build.
        if (meta.trigger === BACKUP_TRIGGERS.FIRST_INSTALL) return name;
        if (meta.certifiedBy === CERTIFIED_BY.SEED) return name;
      }
      return null;
    })();
    const hardProtected = new Set(
      [newestName, bootedName].filter((name) => typeof name === 'string'),
    )
    const budget = Math.max(0, names.length - limit)
    const rest = names.filter((name) => !hardProtected.has(name))
    // A COPY THAT CANNOT BE READ GOES FIRST (2026-11-02): no `meta.json` or no
    // manifest means it is not a point in time at all, so when the budget is
    // short it is never the thing worth keeping. This keeps the "oldest first"
    // order WITHIN each group, so the keepers above still mean what they meant.
    const unreadable = (name) => {
      const meta = metas.get(name);
      const manifest = readManifest(path.join(backupsDir, name));
      return meta === null || manifest === null || !Number.isFinite(meta.at);
    };
    const ordered = rest.filter(unreadable).concat(rest.filter((name) => !unreadable(name)));
    // THE TWO PREFERRED COPIES ARE SPARED ONLY WHEN THERE IS ROOM: sparing them
    // while the budget is larger than the remaining copies would leave the list
    // over the limit forever.
    const preferred = new Set(
      [oldestName, seedName].filter((name) => typeof name === 'string'),
    );
    const withoutPreferred = ordered.filter((name) => !preferred.has(name));
    const pool = withoutPreferred.length >= budget ? withoutPreferred : ordered;
    const victims = pool.slice(0, budget);
    const removed = [];
    for (const name of victims) {
      const target = path.join(backupsDir, name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(name);
      } catch {
        // A backup that cannot be removed must not fail the restart.
      }
    }
    // A budget nobody could be spent on (every candidate is protected) is reported
    // too: "nothing was deleted" is information, and silence would look like a
    // successful prune. The same goes for "the limit is still exceeded": with the
    // newest copy protected, a limit of 1 over three copies cannot be reached, and
    // saying nothing about it would look like a prune that did its job.
    const unit = budget === 1 ? 'copy' : 'copies';
    const remaining = names.length - removed.length;
    return {
      removed,
      skipped: false,
      reason: removed.length === 0 && budget > 0
        ? 'nothing was removed: all ' + budget + ' ' + unit + ' over the limit are kept (the newest copy, or the copy whose restart record says the instance came up with matching content)'
        : (remaining > limit
          ? 'the limit of ' + limit + ' was not reached: ' + remaining + ' copies remain, because the newest copy and the copy whose restart record says the instance came up with matching content are never deleted'
          : null),
      budget,
      certifiedCount: certified.length,
      keptCertified,
    };
  } catch (error) {
    // THE PRUNE MUST NEVER FAIL SILENTLY (2026-11-02). A real hosted machine
    // kept eighteen copies while `backups.max` was already 2, with an EMPTY
    // pruneReason: one old copy had no `meta.json`, `null.kind` threw inside the
    // known-good lookup, and the whole prune died before deleting anything. An
    // exception here is reported, never swallowed and never turned into "the
    // prune did not run".
    return {
      removed: [],
      skipped: false,
      reason: 'the prune failed: ' + (error && error.message ? String(error.message) : String(error)),
      budget: 0,
      certifiedCount: 0,
      keptCertified: null,
      failed: true,
    };
  }
}

/**
 * List the backups, newest first.
 *
 * Only the DIRECTORY is read: the name, the manifest and nothing else. The
 * backup tree can be 150 MB per copy, so its contents are never walked — the
 * manifest already carries the size, the file count and the local time.
 *
 * @param {string} backupsDir
 * @returns {Array<{name: string, dir: string, at: number|null, atLocal: string|null, bytes: number|null, files: number|null, includePlugins: boolean}>}
 */
export function listBackups(backupsDir) {
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    const dir = path.join(backupsDir, name);
    const manifest = readManifest(dir);
    const meta = readBackupMeta(dir);
    // A DIRECTORY THAT WAS NEVER FINISHED IS NOT A BACKUP.
    //
    // Measured on the real machine (2026-11-01): a half-written snapshot (no
    // manifest, no meta.json, only node_modules-link) was listed like any other,
    // so it could be picked as "the newest backup" and compared against. A backup
    // without a timestamp is not a point in time; it is a leftover.
    //
    // It is NOT removed here on purpose: whether to spend the disk space is a
    // separate decision (pruneBackups owns it), not a listing decision.
    const atSource = manifest && Number.isFinite(manifest.at)
      ? manifest
      : (meta && Number.isFinite(meta.at) ? meta : null);
    if (atSource === null) continue;
    const at = Number(atSource.at);
    out.push({
      name,
      dir,
      at,
      // The local time of the snapshot. The directory name is UTC on purpose,
      // so a fresh snapshot must never look like an old one.
      atLocal: manifest && typeof manifest.atLocal === 'string' && manifest.atLocal !== ''
        ? manifest.atLocal
        : (at === null ? null : backupLocalTime(at)),
      bytes: manifest && Number.isFinite(manifest.bytes) ? manifest.bytes : null,
      files: manifest && Array.isArray(manifest.files) ? manifest.files.length : null,
      includePlugins: Boolean(manifest && manifest.includePlugins === true),
    });
  }
  return out;
}

/**
 * Read one backup manifest.
 *
 * @param {string} backupDir
 * @returns {object|null}
 */
export function readManifest(backupDir) {
  try {
    const text = fs.readFileSync(path.join(String(backupDir ?? ''), MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * THE PLUGIN LIST A COPY RECORDS ABOUT ITSELF.
 *
 * `[]` means "this copy holds no plugin files" — true for a config-only copy and
 * for a slim one. `null` means "this copy is too old to say" (no `plugins` field
 * at all), and the caller must scan the directory instead of believing a count.
 *
 * @param {string} backupDir
 * @returns {Array<{ name: string, version: string|null, install: string }>|null}
 */
export function manifestPluginsOf(backupDir) {
  const manifest = readManifest(backupDir);
  if (manifest === null) return null;
  if (!Array.isArray(manifest.plugins)) return null;
  const out = [];
  for (const entry of manifest.plugins) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') continue;
    out.push({
      name,
      version: typeof entry.version === 'string' && entry.version !== '' ? entry.version : null,
      install: typeof entry.install === 'string' && entry.install !== '' ? entry.install : 'link',
      // HOW it got in, and therefore WHETHER it is in the copy: 'link' = written
      // by hand, 'localized' = an npm plugin edited here (it has a .git). The
      // page needs the difference to say which plugins it can roll back.
      source: entry.source === 'localized' ? 'localized' : 'link',
    });
  }
  return out;
}

/**
 * WHERE IS ONE PLUGIN INSIDE ONE COPY?
 *
 * THE 误报 THIS EXISTS FOR (user report, 2026-11-02): `dsh-codekg`'s files were
 * sitting in `node_modules-link/dsh-codekg` and the page still said "the backup
 * has no copy of this plugin", because the copy directory was picked from the
 * LIVE install shape (`node_modules/<name>` is a symlink?) — and that changes
 * independently of what the copy holds.
 *
 * So the answer comes from the copy itself, in this order:
 *   1. the manifest's own plugin list (a copy that recorded what it wrote);
 *   2. the directory itself (`node_modules-link/<name>` present = the files are
 *      there, whatever the manifest says — this is the scan fallback for older
 *      copies);
 *   3. the live flag, as the last resort (a copy with neither).
 *
 * @param {string} backupDir
 * @param {string} name
 * @param {{ linked?: boolean }} [options]
 * @returns {string}
 */
export function backupPluginDirIn(backupDir, name, options = {}) {
  const root = typeof backupDir === 'string' ? backupDir : '';
  const plugin = typeof name === 'string' ? name.trim() : '';
  if (root === '' || plugin === '') return '';
  const linkDir = path.join(root, LINKS_DIR, plugin);
  const installedDir = path.join(root, PLUGINS_DIR, plugin);
  const recorded = manifestPluginsOf(root);
  if (recorded !== null && recorded.some((entry) => entry.name === plugin)) return linkDir;
  try {
    if (fs.existsSync(linkDir) === true) return linkDir;
  } catch {
    // An unreadable directory is the next candidate's problem.
  }
  return options.linked === true ? linkDir : installedDir;
}

/**
 * Take one backup of the profile.
 *
 * `includePlugins` copies the whole installed plugin tree, which is what makes a
 * rollback of "a plugin upgrade broke the boot" actually possible; without it only
 * the configuration files are copied.
 *
 * THE COPY IS INTERRUPTIBLE AND MEASURED: `onProgress` is called with the files
 * and bytes that really landed (plus the measured total), and `shouldCancel` is
 * asked between files. A cancelled copy removes its own half-written snapshot,
 * so a cancel never leaves something that looks like a usable backup.
 *
 * Never throws: a backup that cannot be written is reported as `{ ok: false }` so
 * the caller can decide whether the restart may still proceed.
 *
 * @param {{
 *   profileDir: string,
 *   backupsDir: string,
 *   includePlugins?: boolean,
 *   maxBackups?: number,
 *   now?: number,
 *   kind?: string,
 *   reason?: string|null,
 *   version?: string|null,
 *   bootId?: string|null,
 *   requestId?: number|null,
 *   intervention?: boolean|null,
 *   onProgress?: ((progress: { files: number, bytes: number, total: number, filesTotal: number }) => void)|null,
 *   shouldCancel?: (() => boolean)|null,
 *   measure?: ((profileDir: string, includePlugins: boolean) => { files: number, bytes: number })|null,
 * }} options
 * @returns {{ ok: boolean, cancelled: boolean, dir: string|null, stamp: string|null, at: number|null, atLocal: string|null, kind: string, durationMs: number, bytes: number, totalBytes: number, fileCount: number, files: string[], includePlugins: boolean, pruned: string[], pruneSkipped: boolean, pruneReason: string|null, error: string|null }}
 */
export async function createBackup({
  profileDir,
  backupsDir,
  includePlugins = true,
  maxBackups = DEFAULT_MAX_BACKUPS,
  now = Date.now(),
  kind = KIND_SNAPSHOT,
  reason = null,
  // WHAT PUT THIS COPY ON DISK, stated directly (see `BACKUP_TRIGGERS`). A caller
  // that says nothing gets it derived from `kind` / `reason`, so every existing
  // call site keeps its meaning without passing anything new.
  trigger = null,
  version = null,
  bootId = null,
  requestId = null,
  // Did THIS boot need an intervention (the watchdog restored a copy, a human
  // had to step in)? The caller knows; `null` means "not recorded", which is not
  // the same answer as `false`.
  intervention = null,
  onProgress = null,
  shouldCancel = null,
  measure = null,
  linkProgress = null,
  // SLIM BACKUP, ON BY DEFAULT (user decision, 2026-11-01).
  //
  // Only the things that cannot be fetched again are stored: the configuration
  // and the plugins installed as links (i.e. the ones written by hand).
  // Third-party plugins are NOT copied - `config/pnpm-lock.yaml` pins every
  // version and integrity hash, so reinstalling restores EXACTLY the same
  // versions, not the latest ones.
  //
  // Measured on the real machine: a backup went from 308 MB to about 100 MB.
  // Pass `slimBackup: false` for the old, full behaviour.
  slimBackup = true,
  // WHETHER THIS COPY MAY TRIM THE LIST (default: yes, every regular backup keeps
  // the history at `maxBackups`). The manual rollback turns it OFF for its undo
  // copy (2026-11-02): that copy is written in the MIDDLE of a rollback, and a
  // prune there can delete the very copy the user is rolling back to — measured
  // on the real fixtures, where the safety copy pushed the list over the limit
  // and the picked copy was the one that went. The next regular backup trims.
  pruneEnabled = true,
} = {}) {
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  // A snapshot taken before a restart is NOT proven yet; only an explicit
  // 'known-good' (the first-install seed) starts out proven.
  const metaKind = kind === KIND_KNOWN_GOOD || kind === KIND_UNKNOWN ? kind : KIND_SNAPSHOT;
  const startedAt = Date.now();
  // WHERE THE TIME WENT (2026-11-01): the copy, the signatures and the linking
  // are timed separately, so "this backup took three minutes" can be answered
  // with a number instead of a guess.
  let copyMs = 0;
  const base = {
    ok: false,
    cancelled: false,
    dir: null,
    stamp: null,
    at: null,
    atLocal: null,
    kind: metaKind,
    durationMs: 0,
    bytes: 0,
    totalBytes: 0,
    fileCount: 0,
    files: [],
    includePlugins: includePlugins === true,
    links: [],
    linkFiles: 0,
    linkBytes: 0,
    // HOW MANY PLUGINS WERE COPIED AS "LOCAL", AND HOW MANY WERE ONLY LISTED
    // (user decision, 2026-11-02): a third-party plugin is reproducible from the
    // pinned lockfile, so it is named but not copied.
    localized: 0,
    thirdParty: 0,
    pruned: [],
    // WHY NOTHING WAS PRUNED, when nothing was: `skipped` marks the strict-mode
    // floor (no certified copy exists, so the history is left untouched).
    pruneSkipped: false,
    pruneReason: null,
    // WHERE THE TIME WENT: copying the tree, computing signatures, linking.
    timings: { copyMs: 0, signMs: 0, dedupMs: 0 },
    // DEDUP COUNTERS (2026-11-01): how many plugin copies were reused by hard
    // link instead of written again, and how many were really copied. `bytes`
    // keeps its old meaning (the LOGICAL size of the backup) - these two say
    // what it cost on disk.
    linked: 0,
    copied: 0,
    error: null,
  };
  if (profile === '') return { ...base, error: 'createBackup requires profileDir' };
  if (root === '') return { ...base, error: 'createBackup requires backupsDir' };
  if (!fs.existsSync(profile)) return { ...base, error: 'the profile directory does not exist' };

  // MEASURE FIRST: the progress report needs a denominator that is not made up.
  const measured = (() => {
    try {
      if (typeof measure === 'function') {
        const answer = measure(profile, includePlugins === true);
        return {
          files: Math.max(0, Number(answer && answer.files) || 0),
          bytes: Math.max(0, Number(answer && answer.bytes) || 0),
        };
      }
      const total = { files: 0, bytes: 0 };
      for (const name of CONFIG_FILES) {
        try {
          total.bytes += fs.statSync(path.join(profile, name)).size;
          total.files += 1;
        } catch {
          /* a missing config file is not a problem */
        }
      }
      if (includePlugins === true) {
        const tree = directorySize(path.join(profile, PLUGINS_DIR));
        total.bytes += tree.bytes;
        total.files += tree.files;
      }
      return total;
    } catch {
      return { files: 0, bytes: 0 };
    }
  })();

  const stamp = backupStamp(now);
  const stampDir = path.join(root, stamp);
  // STAGING (2026-11-01): everything is written into a hidden staging directory
  // and renamed into place only once the backup is complete. A half-written
  // backup can then never appear among the real ones.
  const dir = path.join(root, '.staging-' + stamp);
  const files = [];
  let bytes = 0;
  let fileCount = 0;
  let cancelled = false;
  const isCancelled = () => {
    if (cancelled === true) return true;
    if (typeof shouldCancel !== 'function') return false;
    try {
      if (shouldCancel() === true) {
        cancelled = true;
        return true;
      }
    } catch {
      // A broken cancel callback must not abort anything.
    }
    return false;
  };
  const report = (approx) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        files: fileCount,
        bytes,
        total: measured.bytes,
        filesTotal: measured.files,
        // The estimate is passed along so the caller does not have to redo the
        // arithmetic; it is null until there is a real measurement to divide.
        ...(approx ? { approximate: true } : {}),
      });
    } catch {
      // Progress reporting never fails a backup.
    }
  };

  try {
    fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  } catch (error) {
    return { ...base, stamp, totalBytes: measured.bytes, error: 'could not create the backup directory: ' + (error && error.message ? error.message : String(error)) };
  }

  let configBytes = 0;
  for (const name of CONFIG_FILES) {
    if (isCancelled()) break;
    const source = path.join(profile, name);
    if (!fs.existsSync(source)) continue;
    if (copyEntry(source, path.join(dir, CONFIG_DIR, name))) {
      files.push(path.join(CONFIG_DIR, name));
      fileCount += 1;
      try {
        configBytes += fs.statSync(path.join(dir, CONFIG_DIR, name)).size;
        bytes = configBytes;
      } catch {
        // Size reporting is advisory only.
      }
      report(false);
    }
  }

  // FILE-LEVEL COMPLETENESS FOR THE CONFIGURATION (2026-11-01).
  //
  // The gate further down only proves that the CONFIG DIRECTORY exists, and an
  // EMPTY config directory passes it. That is exactly the shape of the incident
  // that made this check exist: 23 backups on the real machine held nothing but
  // `node_modules-link/` — no configuration and no manifest — and every reader
  // treated them as ordinary copies. A backup whose configuration was silently
  // skipped is not a backup; it is a directory that looks like one.
  //
  // Every configuration file the SOURCE had must be in the copy. A source file
  // that is missing is not an error (a profile need not have a lock file); a
  // source file that exists and did NOT get copied is.
  const configSourceNames = [];
  for (const name of CONFIG_FILES) {
    try {
      if (fs.existsSync(path.join(profile, name)) === true) configSourceNames.push(name);
    } catch {
      // An unreadable source file is not one this backup can promise.
    }
  }
  const configNotCopied = configSourceNames.filter(
    (name) => files.includes(path.join(CONFIG_DIR, name)) !== true,
  );
  if (!cancelled && configNotCopied.length > 0) {
    removeBackupDir(dir);
    return {
      ...base,
      stamp,
      totalBytes: measured.bytes,
      error: 'the backup is incomplete: the configuration was not copied ('
        + configNotCopied.join(', ') + '), so the directory was removed',
      incomplete: true,
      missingConfig: configNotCopied,
    };
  }

  // SLIM BACKUP: the third-party tree is not copied at all (it is reinstallable).
  if (!cancelled && includePlugins === true && slimBackup !== true) {
    const source = path.join(profile, PLUGINS_DIR);
    if (fs.existsSync(source)) {
      const copyStartedAt = Date.now()
      const copied = await copyTreeWithProgress({
        source,
        destination: path.join(dir, PLUGINS_DIR),
        shouldCancel: isCancelled,
        onProgress: (progress) => {
          fileCount = files.length + progress.files;
          bytes = configBytes + progress.bytes;
          report(false);
        },
      });
      copyMs = Date.now() - copyStartedAt
      if (copied.cancelled) {
        cancelled = true;
      } else if (copied.ok || copied.files > 0) {
        files.push(PLUGINS_DIR);
        fileCount = files.length + copied.files;
        bytes = configBytes + copied.bytes;
      }
    }
  }

  // THE LINKED PLUGINS (user decision, 2026-10-30). `node_modules/<name>` is a
  // reparse point for a `link:` installation, so the tree copy above records
  // the LINK and none of its contents. The contents are copied into their own
  // directory, and the manifest says which plugin came from where - that is
  // what makes a linked plugin (this one included) restorable at all.
  let links = [];
  let linkFiles = 0;
  let linkBytes = 0;
  // The plugins that are only NAMED in the manifest (third-party as published).
  let thirdParty = [];
  if (!cancelled && includePlugins === true) {
    const collected = collectLinkedPlugins({ profileDir: profile });
    if (typeof linkProgress === 'function') {
      try {
        linkProgress(collected);
      } catch {
        // Reporting the links never fails a backup.
      }
    }
    for (const link of collected.links) {
      if (isCancelled()) break;
      const entry = { ...link, copied: false, copyError: null };
      if (link.exists !== true || link.readable !== true) {
        entry.copyError = 'the link target is missing or unreadable: it cannot be copied';
        links.push(entry);
        continue;
      }
      const copied = await copyTreeWithProgress({
        source: link.target,
        destination: path.join(dir, LINKS_DIR, link.name),
        shouldCancel: isCancelled,
        // NEVER THE HISTORY: `.git` is rebuildable and was the bulk of every
        // backup (962 files / ~74 MB for one linked plugin on the real machine).
        excludeNames: BACKUP_SKIP_NAMES,
      });
      if (copied.cancelled) {
        cancelled = true;
        break;
      }
      if (copied.ok !== true && copied.files === 0) {
        entry.copyError = copied.error || 'the link target could not be copied';
        links.push(entry);
        continue;
      }
      entry.copied = true;
      entry.files = copied.files;
      entry.bytes = copied.bytes;
      linkFiles += copied.files;
      linkBytes += copied.bytes;
      fileCount += copied.files;
      bytes += copied.bytes;
      files.push(path.join(LINKS_DIR, link.name));
      report(false);
      links.push(entry);
    }

    // LOCALIZED NPM PLUGINS (user decision, 2026-11-02).
    //
    // A plugin installed from npm and then EDITED here carries its own `.git`
    // (it was cloned or re-inited). Those edits exist nowhere else, so the tree
    // is copied exactly like a linked plugin — into `node_modules/<name>`, which
    // is where a restore looks for it. `.git` itself is skipped (rebuildable).
    //
    // An npm plugin WITHOUT `.git` is "as published": reinstalling reproduces
    // it, so it is only LISTED, never copied. A copy that cannot be written is
    // REPORTED (copyError), never silently skipped.
    const local = collectLocalPluginDirs({ profileDir: profile });
    for (const plugin of local.localized) {
      if (isCancelled()) break;
      const entry = {
        name: plugin.name,
        target: plugin.dir,
        kind: 'directory',
        exists: true,
        readable: true,
        files: 0,
        bytes: 0,
        copied: false,
        copyError: null,
        source: 'localized',
      };
      const copied = await copyTreeWithProgress({
        source: plugin.dir,
        destination: path.join(dir, PLUGINS_DIR, plugin.name),
        shouldCancel: isCancelled,
        excludeNames: BACKUP_SKIP_NAMES,
      });
      if (copied.cancelled) {
        cancelled = true;
        break;
      }
      if (copied.ok !== true && copied.files === 0) {
        entry.copyError = copied.error || 'the plugin directory could not be copied';
        links.push(entry);
        continue;
      }
      entry.copied = true;
      entry.files = copied.files;
      entry.bytes = copied.bytes;
      linkFiles += copied.files;
      linkBytes += copied.bytes;
      fileCount += copied.files;
      bytes += copied.bytes;
      files.push(path.join(PLUGINS_DIR, plugin.name));
      report(false);
      links.push(entry);
    }
    thirdParty = local.thirdParty;
  }

  if (cancelled) {
    removeBackupDir(dir);
    return {
      ...base,
      cancelled: true,
      stamp,
      totalBytes: measured.bytes,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: 'the backup was cancelled',
    };
  }

  // WHAT ACTUALLY WENT IN (user report, 2026-11-02).
  //
  // The page used to GUESS from the live profile whether a plugin is inside a
  // copy — and when the live install changed shape (a `link:` replaced by an
  // npm install, or the other way round), the guess said "the backup has no copy
  // of this plugin" while `node_modules-link/<name>` sat right there, complete.
  // The copy therefore RECORDS its own plugin list. An older copy without this
  // field is still read correctly: the interface scans the directory then.
  const copiedPlugins = includePlugins === true
    ? links
      .filter((entry) => entry.copied === true)
      .map((entry) => {
        const source = entry.source === 'localized' ? 'localized' : 'link'
        const inside = source === 'localized'
          ? path.join(dir, PLUGINS_DIR, entry.name)
          : path.join(dir, LINKS_DIR, entry.name)
        return {
          name: entry.name,
          // The VERSION OF THE COPY, not of whatever is installed now: the whole
          // point of the list is "what would come back if I restored this".
          version: pluginVersionIn(inside),
          // HOW it was installed, and WHY it is in the copy: a link is hand
          // written, a localized one is an npm plugin edited here.
          install: source === 'localized' ? 'npm' : 'link',
          source,
          kind: typeof entry.kind === 'string' ? entry.kind : '',
        }
      })
    : []

  const manifest = {
    stamp,
    at: Number(now),
    // The wall clock of the machine: the directory name above is UTC, and
    // without this line a fresh snapshot looks like an old leftover.
    atLocal: backupLocalTime(Number(now)),
    profileDir: profile,
    includePlugins: includePlugins === true,
    // THE PLUGINS THAT ARE NOT IN THE COPY, AND WHY (user decision, 2026-11-02):
    // installed from npm, never edited here, so a reinstall brings them back
    // exactly. They are named with their version so the page can say so plainly
    // instead of implying they can be rolled back.
    thirdParty: includePlugins === true
      ? thirdParty.map((entry) => ({ name: entry.name, version: entry.version ?? null }))
      : [],
    files,
    bytes,
    totalBytes: measured.bytes,
    fileCount,
    // THE LINKED PLUGINS: one entry per `link:` installation, with the target
    // it pointed at and what was really copied. Only ADDED to the manifest -
    // every existing field keeps its name and meaning, because three readers
    // (the restore script, the watchdog and lib/rescue.js) depend on them.
    links,
    linkFiles,
    linkBytes,
    // THE PLUGIN LIST OF THIS COPY: `{ name, version, install }` for every
    // plugin whose FILES are in `node_modules-link/`. A config-only or slim copy
    // honestly says `[]` — it really holds none.
    plugins: copiedPlugins,
  };
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (error) {
    return { ...base, stamp, files, bytes, totalBytes: measured.bytes, fileCount, error: 'could not write the backup manifest: ' + (error && error.message ? error.message : String(error)) };
  }

  // THE IDENTITY, right next to the manifest: what this copy is and where it
  // came from. Best effort — a copy whose meta cannot be written stays an
  // 'unknown' one on disk (never used for an automatic rollback).
  // INTEGRITY SELF-CHECK (2026-11-01): a backup that is quietly missing files is
  // worse than no backup — it looks restorable and is not. The copy above reports
  // how many files it wrote; the measurement at the start says how many the
  // profile holds. When the copy came up short, the half-written directory is
  // removed, no meta.json is written, and the caller is told why.
  // A backup must also still have its top-level pieces: losing a whole directory
  // is exactly the shape of the 2026-11-01 incident, and a file COUNT alone can
  // hide it when another directory gained files.
  // ONLY WHAT THE SOURCE HAD. A profile with no node_modules produces a backup
  // with no node_modules, and that is a complete backup, not a broken one.
  const requiredDirs = [CONFIG_DIR]
  // A SLIM BACKUP DELIBERATELY HAS NO node_modules: requiring it would judge a
  // perfectly good slim backup incomplete and throw it away.
  if (includePlugins === true && slimBackup !== true) {
    let sourceHasPlugins = false
    try {
      sourceHasPlugins = fs.existsSync(path.join(profile, PLUGINS_DIR)) === true
    } catch {
      sourceHasPlugins = false
    }
    if (sourceHasPlugins) requiredDirs.push(PLUGINS_DIR)
  }
  const missingDirs = []
  for (const name of requiredDirs) {
    try {
      if (fs.existsSync(path.join(dir, name)) !== true) missingDirs.push(name)
    } catch {
      missingDirs.push(name)
    }
  }
  if (!cancelled && missingDirs.length > 0) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // If it cannot be removed, the error below still says it is unusable.
    }
    return {
      ...base,
      stamp,
      totalBytes: measured.bytes,
      error: 'the backup is incomplete: missing ' + missingDirs.join(', ') + ', so the directory was removed',
      incomplete: true,
      missingDirs,
    }
  }
  // The measurement counts the WHOLE profile, node_modules included. A slim backup
  // deliberately leaves that tree out, so comparing against it would call every
  // slim backup incomplete. The comparison only makes sense for a full backup.
  if (!cancelled && includePlugins === true && slimBackup !== true && measured.files > 0 && fileCount < measured.files) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory that cannot be removed must not throw here; the error below
      // already tells the caller the backup is not usable.
    }
    return {
      ...base,
      stamp,
      totalBytes: measured.bytes,
      error: 'the backup is incomplete: wrote ' + fileCount + ' of ' + measured.files
        + ' files, so the directory was removed',
      incomplete: true,
      wroteFiles: fileCount,
      sourceFiles: measured.files,
    };
  }

  // DEDUP (user decision, 2026-11-01): a backup should record CHANGES, not the
  // number of restarts. After the tree has been copied, every plugin whose
  // content digest already exists in an OLDER backup is replaced - inside THIS
  // new backup only - by hard links to that older copy. Nothing older is ever
  // touched, and `bytes` keeps its old meaning (the logical size), so the
  // numbers the interface already shows do not move.
  writeBackupMeta(dir, {
    at: Number(now),
    // WHAT PUT THIS COPY THERE — the fact that replaced the old `kind` label and
    // the old `reason` string (2026-11-02). A copy taken here has NO BOOT on
    // record, so the record says nothing about one: `boot` stays null, and the
    // copy is a candidate at best, never "the good one".
    // The first-install copy keeps its own positioning through the trigger: it is
    // what a fresh installation has, and it was never proven.
    trigger: triggerOf({ trigger, kind: metaKind, reason }),
    version,
    bootId,
    requestId,
    // WHAT IT HOLDS, from the bytes that were just written: a later edit of the
    // same directory is then detectable instead of invisible.
    contentFingerprint: contentFingerprintOf(dir),
    contentScope: contentScopeOf(dir, { includePlugins: includePlugins === true, slim: slimBackup === true }),
    // WHETHER THIS RESTART NEEDED HELP is known to the caller, not here: an
    // unrecorded answer stays null (never `false`, which would claim we know).
    intervention: typeof intervention === 'boolean' ? intervention : null,
  });

  // ONLY A COMPLETE COPY MAY WEAR THE REAL NAME (2026-11-02). The rename below is
  // the one moment a copy becomes visible to every reader (`listBackups`,
  // `selectRestoreTarget`, `restore-profile.ps1` and the watchdog all look for a
  // manifest), so the copy is CHECKED here instead of trusted: a staging directory
  // that lost its manifest or its configuration on the way is removed and
  // reported, and it never appears under the name a real backup carries.
  //
  // WHY THIS EXISTS AT ALL: on the real machine 24 directories carrying a backup
  // stamp held nothing but `node_modules-link/` - no manifest, no configuration -
  // and every reader had to learn to skip them. A name that promises a backup and
  // delivers half of one is the bug this check removes.
  if (backupIsComplete(dir) !== true) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A half-written copy that cannot be removed is still not a backup.
    }
    return {
      ...base,
      stamp,
      totalBytes: measured.bytes,
      error: 'the backup is incomplete (no manifest or no configuration), so it was not published',
    };
  }

  // ATOMIC PUBLISH: only now does the backup get its real name.
  try {
    fs.renameSync(dir, stampDir);
  } catch (error) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A staging directory that cannot be removed is still not a backup.
    }
    return {
      ...base,
      stamp,
      totalBytes: measured.bytes,
      error: 'the finished backup could not be moved into place: '
        + String(error && error.message ? error.message : error),
    };
  }

  const prune = pruneEnabled === false
    ? { removed: [], skipped: false, reason: 'the caller asked for no trimming (a copy taken in the middle of a rollback)', budget: 0, certifiedCount: 0, keptCertified: null }
    : pruneBackups(root, maxBackups);
  // THE GARBAGE THAT WAS SITTING THERE (2026-11-01): on the real machine 24 of
  // the 25 directories held NEITHER a manifest NOR a configuration file — 1.78 GB
  // that could never be selected as a restore point. They are removed here, with
  // a hard budget, and what was removed travels back to the caller.
  const hygiene = removeIncompleteBackups(root);
  return {
    ...base,
    ok: true,
    timings: { copyMs, signMs: 0, dedupMs: 0 },
    dir: stampDir,
    stamp,
    at: Number(now),
    atLocal: manifest.atLocal,
    kind: metaKind,
    durationMs: Math.max(0, Date.now() - startedAt),
    bytes,
    totalBytes: measured.bytes,
    fileCount,
    files,
    // THE LOCAL VALUES, NOT THE BASE ONES: `...base` carries the EMPTY
    // placeholders (`links: []`, `linkFiles: 0`), so a caller that read
    // `result.links` was told "no linked plugins" while the manifest beside it
    // listed five and their contents had really been copied (measured on the
    // real profile, 2026-10-30: manifest 5 links / 1 217 files, return `[]`).
    // The manifest was right and the ANSWER was wrong.
    linkFiles,
    linkBytes,
    links,
    // HOW MANY PLUGINS WENT IN AS "LOCAL", AND HOW MANY WERE ONLY NAMED
    // (user decision, 2026-11-02). The page has to be able to say "three are
    // backed up, eleven are not and will be reinstalled" without re-reading the
    // manifest itself.
    localized: copiedPlugins.filter((entry) => entry.source === 'localized').length,
    thirdParty: manifest.thirdParty.length,
    // `pruned` KEEPS ITS OLD MEANING: the names that were really deleted. The
    // two new fields are the answer to "nothing was deleted — why?": when no
    // copy carries certification, pruning deliberately leaves everything alone
    // and the upper layer has to be able to say so instead of staying silent.
    pruned: prune.removed,
    pruneSkipped: prune.skipped,
    pruneReason: prune.reason,
    // WHAT THE JUNK SWEEP DID (count + bytes), so the caller can say out loud
    // where the disk space went instead of silently deleting things.
    hygiene,
  };
}

/**
 * Put a backup back over the live profile.
 *
 * The configuration files are copied over the existing ones; the plugin tree is
 * copied with `force` so the snapshot wins file by file. The caller decides what
 * to do with the host afterwards (the detached helper relaunches it).
 *
 * @param {{ backupDir: string, profileDir: string }} options
 * @returns {{ ok: boolean, restored: string[], error: string|null }}
 */
export function restoreBackup({ backupDir, profileDir } = {}) {
  const backup = typeof backupDir === 'string' ? backupDir.trim() : '';
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const restored = [];
  if (backup === '') return { ok: false, restored, error: 'restoreBackup requires backupDir' };
  if (profile === '') return { ok: false, restored, error: 'restoreBackup requires profileDir' };
  if (!fs.existsSync(backup)) return { ok: false, restored, error: 'the backup directory does not exist' };

  const configDir = path.join(backup, CONFIG_DIR);
  if (fs.existsSync(configDir)) {
    for (const name of CONFIG_FILES) {
      const source = path.join(configDir, name);
      if (!fs.existsSync(source)) continue;
      if (copyEntry(source, path.join(profile, name))) restored.push(name);
    }
  }
  const plugins = path.join(backup, PLUGINS_DIR);
  if (fs.existsSync(plugins) && copyEntry(plugins, path.join(profile, PLUGINS_DIR))) {
    restored.push(PLUGINS_DIR);
  }
  if (restored.length === 0) {
    return { ok: false, restored, error: 'the backup holds nothing that could be restored' };
  }
  return { ok: true, restored, error: null };
}

/**
 * Read the report the detached helper writes after a rolled-back boot.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    let text = fs.readFileSync(path.join(dir, ROLLBACK_REPORT_NAME), 'utf8');
    // Windows PowerShell 5.1 writes UTF-8 files with a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the rollback report once it has been reported.
 *
 * @param {string} stateDir
 * @returns {boolean} whether a report was removed
 */
export function clearRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, ROLLBACK_REPORT_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * REMOVE THE DIRECTORIES THAT ARE NOT BACKUPS AT ALL (2026-11-01).
 *
 * MEASURED ON THE REAL MACHINE: 25 directories under the backups root, 24 of
 * them holding **neither a manifest nor a configuration file** — 1.78 GB — while
 * the only usable copy was 0.1 MB. Those directories can never be selected as a
 * restore point (see `listBackups` / `backupIsComplete`), so all they did was
 * take up disk space forever.
 *
 * WHAT IS A VICTIM, EXACTLY: a directory that has NO `manifest.json` **AND** no
 * configuration file, that is older than `minAgeMs` (a copy being written right
 * now is left alone) and is not a dot entry. A manifest alone is enough to keep
 * a directory: a copy that only lacks `meta.json` predates it and is restorable.
 *
 * WHY THE CONFIGURATION NO LONGER SAVES A DIRECTORY (user decision, 2026-11-02):
 * the real machine kept producing directories that copied the whole plugin tree
 * (~150 MB, hundreds of files) and died before writing the manifest. They have a
 * configuration file, so the old rule spared them, and nothing could ever restore
 * from them. Without a manifest a directory is not a point in time — it is the
 * wreck of one — so the manifest is the only thing that decides, and anything
 * else is deleted once it is old enough.
 *
 * WHAT IS NEVER TOUCHED:
 *   - anything starting with `.` — that is `.staging-<stamp>`, a backup being
 *     written right now; deleting it would corrupt a concurrent backup;
 *   - anything that would pass `backupIsComplete`;
 *   - anything that is not a directory.
 *
 * BUDGET: a hard ceiling on both the number of directories and the bytes per
 * call (32 dirs / 2 GB by default). Once the ceiling is reached the rest is only
 * COUNTED (`skipped`) and reported — a boot path must never decide to delete an
 * unbounded amount of the user's disk.
 *
 * @param {string} backupsDir
 * @param {{ dirs?: number, bytes?: number, dryRun?: boolean }} [options]
 * @returns {{ scanned: number, removed: string[], skipped: string[], bytes: number, capped: boolean, reason: string }}
 */
export function removeIncompleteBackups(backupsDir, options) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const limitDirs = Number.isFinite(Number(settings.dirs)) && Number(settings.dirs) > 0
    ? Math.trunc(Number(settings.dirs))
    : DEFAULT_JUNK_LIMITS.dirs;
  const limitBytes = Number.isFinite(Number(settings.bytes)) && Number(settings.bytes) > 0
    ? Math.trunc(Number(settings.bytes))
    : DEFAULT_JUNK_LIMITS.bytes;
  const dryRun = settings.dryRun === true;
  // NO AGE GATE BY DEFAULT HERE, ON PURPOSE: this sweep runs (a) at the end of a
  // backup, where the copy that was just published carries a manifest and the one
  // being written is still `.staging-*` (excluded by name), and (b) at boot, when
  // this process is the only writer. The 120 s gate belongs to the boot sweep that
  // walks directories left behind by an EARLIER run (`sweepIncompleteBackups`).
  const minAgeMs = Number.isFinite(Number(settings.minAgeMs)) && Number(settings.minAgeMs) >= 0
    ? Math.trunc(Number(settings.minAgeMs))
    : 0;
  const now = Number.isFinite(Number(settings.now)) ? Number(settings.now) : Date.now();
  const out = { scanned: 0, removed: [], skipped: [], bytes: 0, capped: false, reason: '' };
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  if (root === '') {
    out.reason = 'no backups directory';
    return out;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    out.reason = 'the backups directory could not be read';
    return out;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() === true)
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    // `.staging-*` is a backup being written RIGHT NOW (and any other dot entry
    // is not ours to judge).
    if (name.startsWith('.')) continue;
    out.scanned += 1;
    const dir = path.join(root, name);
    const hasManifest = (() => {
      try {
        return fs.existsSync(path.join(dir, MANIFEST_NAME)) === true;
      } catch {
        return true; // unreadable → not provably manifest-less → keep it
      }
    })();
    // A MANIFEST IS WHAT MAKES A DIRECTORY A COPY (user decision, 2026-11-02).
    // Before this rule the test was "no manifest AND no configuration", which
    // spared exactly the shape that keeps appearing on real machines: a backup
    // that died after copying the plugin tree (hundreds of files, ~150 MB) but
    // before writing its manifest. Nothing can restore from it, `listBackups`
    // refuses to list it, and it stays on disk forever. A copy with a manifest
    // but no `meta.json` is a DIFFERENT case: it is restorable (old copies
    // legitimately predate `meta.json`), so it is kept and only counted.
    if (hasManifest === true) continue; // a copy
    const ageOk = (() => {
      try {
        return minAgeMs <= 0 || now - fs.statSync(dir).mtimeMs >= minAgeMs;
      } catch {
        return false; // the age cannot be established → do not delete
      }
    })();
    if (ageOk !== true) {
      out.skipped.push(name); // too young: a writer may be filling it right now
      continue;
    }
    const bytes = (() => {
      try {
        return directorySize(dir).bytes;
      } catch {
        return 0;
      }
    })();
    if (out.removed.length >= limitDirs || (out.bytes + bytes) > limitBytes) {
      out.capped = true;
      out.skipped.push(name);
      continue;
    }
    if (dryRun === true) {
      out.removed.push(name);
      out.bytes += bytes;
      continue;
    }
    if (removeBackupDir(dir) === true) {
      out.removed.push(name);
      out.bytes += bytes;
    } else {
      out.skipped.push(name);
    }
  }
  return out;
}

/**
 * REMOVE LEFTOVER STAGING DIRECTORIES (2026-11-01).
 *
 * A backup is written into `.staging-<stamp>` and renamed into place when it is
 * complete, so a crash mid-copy leaves a staging directory behind. Those are not
 * backups and must never be mistaken for one — but nothing else will ever clean
 * them up, so this does, at boot.
 *
 * It ONLY touches names starting with `.staging-`. A real backup directory is
 * never removed here, whatever state it is in.
 *
 * @param {string} backupsDir
 * @param {{ fs?: object }} [options]
 * @returns {{ removed: string[], reason: string }}
 */
export function cleanupStaleStaging(backupsDir, options) {
  // `null` must not throw either — this runs at boot.
  const { fs: fsLike = fs } = options !== null && typeof options === 'object' ? options : {}
  const out = { removed: [], reason: '' }
  try {
    const root = typeof backupsDir === 'string' ? backupsDir.trim() : ''
    if (root === '') {
      out.reason = 'no backups directory'
      return out
    }
    let entries = []
    try {
      entries = fsLike.readdirSync(root, { withFileTypes: true })
    } catch {
      out.reason = 'the backups directory could not be read'
      return out
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      if (entry.name.startsWith('.staging-') !== true) continue
      try {
        fsLike.rmSync(path.join(root, entry.name), { recursive: true, force: true })
        out.removed.push(entry.name)
      } catch {
        // A staging directory that will not go away is reported by its absence
        // from `removed`; it is never escalated into a failed boot.
      }
    }
    return out
  } catch (error) {
    out.reason = String(error && error.message ? error.message : error)
    return out
  }
}

/**
 * WHICH BACKUP DIRECTORIES ARE NOT USABLE COPIES (2026-11-02).
 *
 * A directory under `backups/` is a COPY only when it carries a manifest. One
 * without a manifest is either a leftover of a restart that died mid-write or
 * something else entirely — either way it is not a point in time, and
 * `listBackups` already refuses to list it. It stays on disk forever otherwise,
 * which is how a machine ended up with three directories while the page said
 * two copies.
 *
 * The judgement is deliberately narrow: a directory is a copy only when it
 * carries a manifest, and a copy with a manifest but no `meta.json` is merely
 * REPORTED (`incomplete`), never deleted — old copies legitimately predate
 * `meta.json`. Without a manifest nothing can restore from it, no matter how
 * many files it holds.
 *
 * @param {string} backupsDir
 * @returns {{ scanned: number, incomplete: number, names: string[] }}
 */
export function countIncompleteBackups(backupsDir) {
  const out = { scanned: 0, incomplete: 0, names: [] };
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  if (root === '') return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true || entry.name.startsWith('.') === true) continue;
    out.scanned += 1;
    const dir = path.join(root, entry.name);
    const hasManifest = (() => { try { return fs.existsSync(path.join(dir, MANIFEST_NAME)) === true; } catch { return true; } })();
    const hasMeta = (() => { try { return fs.existsSync(path.join(dir, META_NAME)) === true; } catch { return true; } })();
    if (hasManifest === true && hasMeta === true) continue;
    out.incomplete += 1;
    out.names.push(entry.name);
  }
  return out;
}

/**
 * REMOVE THE BACKUP DIRECTORIES THAT ARE PROVABLY JUNK, AT BOOT (2026-11-02).
 *
 * `removeIncompleteBackups` already exists, but it is called from the
 * first-install path, which only runs on a NEW boot with snapshots enabled — so
 * on an ordinary restart nothing swept, and a directory left behind by a backup
 * that died mid-write stayed forever (a real machine: three directories on disk,
 * two copies on the page).
 *
 * WHAT IS DELETED: a directory with NO manifest, whatever it holds — a copy that
 * died after writing hundreds of files but before its manifest is exactly that,
 * and it can never be restored (user decision, 2026-11-02).
 * WHAT IS KEPT: anything with a manifest (a copy missing only `meta.json` is old,
 * not broken), anything whose mtime is inside `minAgeMs` (a write may be in
 * flight), and dot entries (`.staging-*`).
 *
 * WHAT IT REPORTS: the names removed, the names kept, how many were scanned and
 * the BYTES RECLAIMED (summed before the deletion — afterwards there is nothing
 * left to measure).
 *
 * Nothing here throws: a failure is returned.
 *
 * @param {string} backupsDir
 * @param {{ minAgeMs?: number, now?: number }} [options]
 * @returns {{ skipped: boolean, reason: string|null, removed: string[], kept: string[], scanned: number, error: string|null }}
 */
export function sweepIncompleteBackups(backupsDir, { minAgeMs = DEFAULT_HYGIENE_MIN_AGE_MS, now = Date.now() } = {}) {
  const result = { skipped: false, reason: null, removed: [], kept: [], scanned: 0, bytes: 0, error: null };
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  if (root === '') {
    result.skipped = true;
    result.reason = 'no backups directory';
    return result;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      result.skipped = true;
      result.reason = 'no backups directory yet';
      return result;
    }
    result.error = error && error.message ? String(error.message) : String(error);
    return result;
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true || entry.name.startsWith('.') === true) continue;
    result.scanned += 1;
    const dir = path.join(root, entry.name);
    try {
      // A MANIFEST IS WHAT MAKES A DIRECTORY A COPY (user decision, 2026-11-02).
      // The rule used to be "no manifest AND nothing inside", which spared the one
      // shape that actually appears on real machines: a backup that copied the
      // plugin tree (hundreds of files, ~150 MB) and then never wrote its
      // manifest. It cannot be restored, it is not listed, and it stayed forever.
      // A copy with a manifest but no `meta.json` is NOT junk — old copies predate
      // `meta.json` and are restorable — so a manifest alone is enough to keep it.
      if (fs.existsSync(path.join(dir, MANIFEST_NAME)) === true) {
        result.kept.push(entry.name); // a copy (possibly one that only lacks meta.json)
        continue;
      }
      const stat = fs.statSync(dir);
      if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) {
        result.kept.push(entry.name); // maybe being written right now
        continue;
      }
      // COUNTED BEFORE THE DELETE: after it, the bytes are gone and the report
      // would have nothing to add up.
      const bytes = (() => {
        try {
          return directorySize(dir).bytes;
        } catch {
          return 0;
        }
      })();
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(entry.name);
      result.bytes += bytes;
    } catch (error) {
      result.kept.push(entry.name);
      result.error = error && error.message ? String(error.message) : String(error);
    }
  }
  return result;
}