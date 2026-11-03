/**
 * `health.backups.available` MUST BE A REAL COUNT (2026-11-03).
 *
 * The number used to be a constant 0: it was computed by running
 * `isUsableRestorePoint` over the PROJECTION the settings page reads, and that
 * projection carries neither `boot` nor `trigger` - the only two facts the qualifier
 * looks at. So on every machine "how many copies can I fall back to" was 0, however
 * many restorable copies were on disk.
 *
 * These tests pin both halves of the repair:
 *   1. the qualifier needs the full record, and refuses a projection (root cause);
 *   2. the count the health payload reports equals the qualifier's answer on the
 *      full records, and agrees with `selectRestoreTarget` - one judgement, not two.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { isUsableRestorePoint, listBackupIdentities } from '../lib/backup.js'
import { selectRestoreTarget } from '../lib/watchdog.js'

/** The fields the settings page actually receives (no `boot`, no `trigger`). */
function projectLikeHealth(identity) {
  return {
    name: identity.name,
    dir: identity.dir,
    at: identity.at,
    atLocal: identity.atLocal,
    bytes: identity.bytes,
    files: identity.files,
    includePlugins: identity.includePlugins,
    kind: identity.kind,
    version: identity.version,
    certifiedBy: identity.certifiedBy,
    certificationEvidence: identity.certificationEvidence,
    certifiedAt: identity.certifiedAt,
    contentScope: identity.contentScope,
    intervention: identity.intervention,
    certified: identity.certified === true,
    plugins: null,
    localized: null,
    thirdParty: null,
  }
}

/**
 * The three shapes that matter, as real directories, written the way the plugin
 * writes them: a manifest plus a `meta.json` per copy.
 */
function fixtureBackups() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-available-'))
  const backups = path.join(root, 'backups')
  const write = (stamp, meta) => {
    const dir = path.join(backups, stamp)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      stamp,
      at: 1_761_000_000_000,
      version: '0.8.6',
      files: 3,
      bytes: 128,
      includePlugins: false,
    }), 'utf8')
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
    return dir
  }

  // (a) A copy proven by a matching boot, with no rescue recorded: restorable.
  write('20261101T010000Z', {
    at: 1_761_000_000_000,
    version: '0.8.6',
    trigger: 'pre-restart',
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks', at: '2026-11-01T00:59:00.000Z', loadFailures: [] },
    certifiedBy: 'full-checks',
    certificationEvidence: 'fingerprint-match',
    contentFingerprint: 'abc123',
    contentScope: 'config-only',
    intervention: false,
  })

  // (b) The legacy shape: proven by full checks, rescue explicitly recorded as none.
  write('20261101T020000Z', {
    at: 1_761_000_100_000,
    version: '0.8.6',
    trigger: 'pre-restart',
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks', at: '2026-11-01T01:59:00.000Z', loadFailures: [] },
    certifiedBy: 'full-checks',
    certificationEvidence: 'fingerprint-match',
    contentFingerprint: 'def456',
    contentScope: 'config-only',
    intervention: false,
  })

  // (c) A copy whose boot HAD to be rescued: the content matched, but the system
  //     intervened to get there, so this is not something to fall back to.
  write('20261101T030000Z', {
    at: 1_761_000_200_000,
    version: '0.8.6',
    trigger: 'pre-restart',
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks', at: '2026-11-01T02:59:00.000Z', loadFailures: [] },
    certifiedBy: 'full-checks',
    certificationEvidence: 'fingerprint-match',
    contentFingerprint: 'ghi789',
    contentScope: 'config-only',
    intervention: true,
  })

  return { root, backups }
}

/** A plugin instance whose state file lives next to the fixture backups. */
function runtimeFor(root) {
  const stateFile = path.join(root, 'state.json')
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: () => undefined,
  }
  return apply(ctx, { stateFile, recoveryDelayMs: 0, enabled: true, settleMs: 0 })
}

test('the qualifier needs the full record: a projection can never say yes', () => {
  const { root } = fixtureBackups()
  const identities = listBackupIdentities(path.join(root, 'backups'))
  assert.equal(identities.length, 3, 'three copies on disk')

  const usable = identities.filter((entry) => isUsableRestorePoint(entry) === true)
  assert.equal(usable.length, 2, 'the two proven copies are restorable; the seed is not')

  // The old feeding: the same qualifier over the page projection. This is the bug,
  // reproduced on purpose - every answer is false because the evidence is missing.
  const onProjection = identities.filter((entry) => isUsableRestorePoint(projectLikeHealth(entry)) === true)
  assert.equal(
    onProjection.length,
    0,
    'the projection carries no boot and no trigger, so the qualifier cannot answer yes',
  )
  assert.equal(
    projectLikeHealth(identities[0]).boot,
    undefined,
    'and the projection really has no boot field at all - not a null one',
  )
})

test('health.backups.available counts the restorable copies, per copy', () => {
  const { root } = fixtureBackups()
  const runtime = runtimeFor(root)
  const info = runtime.backupsInfo()

  assert.equal(info.count, 3, 'three readable copies')
  assert.equal(info.available, 2, 'the two proven copies are available; the seed is not')

  // Spelled out per copy so a regression cannot hide behind an equal-looking total.
  const identities = listBackupIdentities(path.join(root, 'backups'))
  const byName = new Map(identities.map((entry) => [entry.name, entry]))
  const recovered = byName.get('20261101T010000Z')
  const legacy = byName.get('20261101T020000Z')
  const seed = byName.get('20261101T030000Z')
  assert.equal(isUsableRestorePoint(recovered), true, 'the boot-proven copy is restorable')
  assert.equal(isUsableRestorePoint(legacy), true, 'the legacy full-checks copy is restorable')
  assert.equal(isUsableRestorePoint(seed), false, 'the seed records no rescue decision, so it is not')
})

test('available and selectRestoreTarget judge the same set of copies', () => {
  const { root } = fixtureBackups()
  const runtime = runtimeFor(root)
  const info = runtime.backupsInfo()
  const identities = listBackupIdentities(path.join(root, 'backups'))

  const choice = selectRestoreTarget({
    candidates: identities.map((entry) => ({
      dir: entry.dir,
      name: entry.name,
      at: entry.at,
      boot: entry.boot,
      intervention: entry.intervention,
      certifiedBy: entry.certifiedBy,
      certificationEvidence: entry.certificationEvidence,
    })),
  })

  assert.equal(info.available, 2, 'two copies are restorable')
  assert.ok(choice.target !== null, 'the watchdog finds a restore point')
  assert.equal(choice.strict, false, 'and it did not need the unrecorded fallback')
  assert.equal(
    choice.excluded.length,
    1,
    'exactly one copy was refused - the same one the count leaves out',
  )
  assert.match(
    String(choice.excluded[0].name),
    /20261101T030000Z/,
    'the refused copy is the seed, which is the copy the count does not include',
  )
})

test('the install seed counts through its trigger, not through a boot', () => {
  // A fresh state directory: the plugin takes the install-time copy on boot. That
  // copy has no `boot` at all - it was taken before anything ran - and it is still
  // a restore point, because its `trigger` says what it is. This is the one shape
  // where the qualifier says yes WITHOUT a boot record, and it must keep working:
  // counting it as 0 would send a fresh install into "nothing to restore from".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-available-seed-'))
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  const runtime = runtimeFor(root)
  const info = runtime.backupsInfo()

  assert.equal(info.count, 1, 'the install seed is the only copy')
  assert.equal(info.available, 1, 'and it is available - through its trigger, not a boot')

  const seed = listBackupIdentities(path.join(root, 'backups'))[0]
  assert.equal(seed.boot, null, 'the seed carries no boot record at all')
  assert.equal(isUsableRestorePoint(seed), true, 'yet the qualifier accepts it: trigger === first-install')
})
