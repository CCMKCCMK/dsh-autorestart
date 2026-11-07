/**
 * THE SEED MUST NOT DUPLICATE A COPY THAT ALREADY HOLDS THIS BOOT (2026-11-07).
 *
 * WHAT HAPPENED ON THE REAL MACHINE (timeline read off the disk):
 *
 *   16:19:18  the pre-restart copy `08-19-18-328Z` is written
 *             (842 files / 296,859,493 B, 7 plugins) — NOT certified yet;
 *   16:20:23  the replacing instance boots, `seedFirstInstallBackup` asks
 *             `latestKnownGood()`, gets null (nothing is certified at that
 *             instant) and writes a 92 KB configuration-only duplicate
 *             `08-20-23-952Z` (`trigger: first-install`);
 *   16:20:33  the boot check only NOW stamps `boot.contentMatched` on
 *             `08-19-18` — ten seconds too late for the decision above.
 *
 * The result: every boot grew the list by one copy that was guaranteed to be a
 * duplicate, so "how many backups" stopped meaning "how often did the
 * configuration really change".
 *
 * THE FIX PINNED HERE: the seed asks a FACT about bytes — does the newest
 * COMPLETE copy already hold the content this boot is running? — instead of
 * asking for a grade (`known-good`). CERTIFICATION IS NOT RELAXED: a copy still
 * only becomes `known-good` when a boot proves it came up with matching
 * content; the seed merely stops copying what is already copied.
 *
 *   · uncertified copy whose content matches → NO seed (`present`)
 *   · empty backups directory               → seed (`seeded`)
 *   · a copy that does NOT match this boot  → still seeds (the machine needs a
 *     copy of what it is running)
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { seedFirstInstallBackup } from '../index.js'
import {
  BACKUP_TRIGGERS,
  KIND_KNOWN_GOOD,
  createBackup,
  latestKnownGood,
  readBackupMeta,
} from '../lib/backup.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * A profile the pre-restart copy can really carry: the configuration at its root
 * (the real layout — a copy keeps the same three files under `config/`) AND a
 * LINKED plugin, so the copy holds a plugin tree under `node_modules-link/`.
 *
 * WHY THE LINK MATTERS (2026-11-07, t26): a copy that carries no plugin tree is
 * NOT a baseline for a plugin-carrying profile — the pre-restart comparison skips
 * it on purpose. A fixture whose "pre-restart copy" held nothing but configuration
 * would therefore exercise the wrong path.
 *
 * @returns {{ profile: string, linked: boolean }}
 */
function profileWith(t, root) {
  const profile = path.join(root, 'profile')
  const source = path.join(root, 'demo-source')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"demo-plugin","version":"1.0.0"}\n', 'utf8')
  fs.writeFileSync(path.join(source, 'index.js'), 'export default 1\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['demo-plugin'] } } }, null, 2) + '\n',
    'utf8',
  )
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  let linked = true
  try {
    fs.symlinkSync(source, path.join(profile, 'node_modules', 'demo-plugin'), 'junction')
  } catch {
    linked = false
  }
  return { profile, linked }
}

/** A state directory with its backups root. */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-seed-${label}-`))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(backups, { recursive: true })
  return { dir, backups }
}

/** The bare runtime `seedFirstInstallBackup` reads (state, file, boot flag, log). */
function seedRuntime(setup) {
  return {
    state: {},
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

/** Write ONE complete, uncertified pre-restart copy of `profile` (the real shape). */
async function writePreRestartCopy(profile, backups) {
  const written = await createBackup({
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    kind: KIND_KNOWN_GOOD,
    trigger: BACKUP_TRIGGERS.PRE_RESTART,
  })
  assert.equal(written.ok, true, 'the fixture copy was written: ' + String(written.error))
  return written.dir
}

/** The copies on disk (the number the user reads as "how many backups"). */
function copyNames(backups) {
  try {
    return fs.readdirSync(backups, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * ① THE BUG: an uncertified copy that already matches must not be duplicated.
 * ------------------------------------------------------------------ */

test('① a boot-time seed is NOT written when an uncertified copy already holds this profile', async (t) => {
  const setup = fixture(t, 'match')
  const seededProfile = profileWith(t, setup.dir)
  if (seededProfile.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  const profile = seededProfile.profile
  const preRestart = await writePreRestartCopy(profile, setup.backups)

  // THE PRECONDITION OF THE BUG: nothing is certified at this instant, so the
  // old criterion ("is there a known-good copy?") says "no copy at all".
  assert.equal(latestKnownGood(setup.backups), null, 'nothing is certified yet')
  assert.notEqual(readBackupMeta(preRestart).kind, undefined, 'the copy does carry its identity')

  const before = copyNames(setup.backups)
  assert.equal(before.length, 1, 'the pre-restart copy is the only directory')

  const runtime = seedRuntime(setup)
  const answer = await seedFirstInstallBackup(runtime, { backupOnRestart: true }, { profileDir: profile })

  assert.equal(answer.result, 'present', 'a copy that matches this boot already exists')
  assert.equal(answer.dir, preRestart, 'and the answer names it')
  assert.deepEqual(copyNames(setup.backups), before, 'NO second directory: the 92 KB duplicate is not written')
  assert.equal(runtime.state.firstInstallBackup.result, 'present', 'the health payload says the same thing')
})

/* ------------------------------------------------------------------ *
 * ② NOTHING ON DISK → the seed is written (the first install really is one).
 * ------------------------------------------------------------------ */

test('② an empty backups directory still gets its first-install seed', async (t) => {
  const setup = fixture(t, 'empty')
  const seededProfile = profileWith(t, setup.dir)
  if (seededProfile.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  const profile = seededProfile.profile
  assert.deepEqual(copyNames(setup.backups), [], 'nothing on disk')

  const runtime = seedRuntime(setup)
  const answer = await seedFirstInstallBackup(runtime, { backupOnRestart: true }, { profileDir: profile })

  assert.equal(answer.result, 'seeded', 'a first install really is one')
  assert.equal(typeof answer.dir, 'string', 'and it names the copy it wrote')
  assert.equal(fs.existsSync(answer.dir), true, 'the directory is on disk')
  assert.equal(copyNames(setup.backups).length, 1, 'exactly one copy')
  assert.equal(readBackupMeta(answer.dir).trigger, BACKUP_TRIGGERS.FIRST_INSTALL, 'with the first-install trigger')
})

/* ------------------------------------------------------------------ *
 * ③ A COPY THAT DOES NOT MATCH IS NOT A SUBSTITUTE for a copy of what runs.
 * ------------------------------------------------------------------ */

test('③ a stale copy does not suppress the seed: the machine still records what it runs', async (t) => {
  const setup = fixture(t, 'stale')
  const seededProfile = profileWith(t, setup.dir)
  if (seededProfile.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions, so no plugin is linked')
    return
  }
  const profile = seededProfile.profile
  const preRestart = await writePreRestartCopy(profile, setup.backups)

  // The configuration moved on after that copy was taken (an edit while the
  // host was down): the copy no longer holds what this boot loaded.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n  - id: added\n', 'utf8')

  const runtime = seedRuntime(setup)
  const answer = await seedFirstInstallBackup(runtime, { backupOnRestart: true }, { profileDir: profile })

  assert.equal(answer.result, 'seeded', 'a copy of the RUNNING configuration is what the seed is for')
  assert.notEqual(answer.dir, preRestart, 'and it is a new directory, not the stale one')
  assert.equal(copyNames(setup.backups).length, 2, 'so the stale copy and the seed both exist')
})
