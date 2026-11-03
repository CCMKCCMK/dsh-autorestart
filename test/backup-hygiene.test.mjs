/**
 * BACKUP HYGIENE (2026-11-01): DEAD DIRECTORIES AND `.git`.
 *
 * MEASURED ON THE REAL MACHINE, two kinds of waste:
 *
 *   1. 25 directories under the backups root, 24 of them holding NEITHER a
 *      manifest NOR a configuration file — 1.78 GB — while the only usable copy
 *      was 0.1 MB. Nothing can ever restore from those, they are never selected,
 *      and nothing removed them.
 *   2. every backup carried the `.git` of each linked plugin (one plugin: 962
 *      files / ~74 MB of history, in EVERY copy). `.git` is rebuildable, so it is
 *      not one of "the things that cannot be fetched again".
 *
 * What must stay true (this is what the tests below pin):
 *   - a directory is a COPY only when it carries `manifest.json`; without one it
 *     is a victim no matter how many files it holds (user decision, 2026-11-02 —
 *     the 2026-11-02 residue was 497 files / ~150 MB with no manifest, and the
 *     older rule spared it because "it holds something");
 *   - a copy WITH a manifest is kept even when it lacks `meta.json`: old copies
 *     predate that file and still restore, so it is reported, never deleted;
 *   - `.staging-*` (a backup being written right now), anything younger than the
 *     sweep's age window, and complete backups are never touched;
 *   - the sweep has a hard budget and reports what it did (count + bytes);
 *   - a backup never contains `.git`, and still contains the plugin's own files.
 *
 * Everything runs in a temp directory: the user's real 1.78 GB is NOT touched
 * here — deleting that is a decision for the operator, not for a test.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BACKUP_SKIP_NAMES,
  CONFIG_DIR,
  MANIFEST_NAME,
  createBackup,
  removeIncompleteBackups,
} from '../lib/backup.js'

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-hygiene-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

/** A directory that looks like a backup: has a manifest and a config file. */
function makeComplete(root, name) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true })
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ at: 1, files: [] }), 'utf8')
  fs.writeFileSync(path.join(dir, CONFIG_DIR, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
  return dir
}

/** The shape that occupied 1.78 GB: only node_modules-link, nothing else. */
function makeGutted(root, name, payloadBytes = 1024) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'node_modules-link', 'some-plugin'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'node_modules-link', 'some-plugin', 'index.js'),
    'x'.repeat(payloadBytes),
    'utf8',
  )
  return dir
}

/** No directory under `root` may carry a PUBLISHED backup name unless it is complete. */
function assertNoPublishedIncomplete(root) {
  const published = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
  for (const name of published) {
    const dir = path.join(root, name)
    const hasManifest = fs.existsSync(path.join(dir, MANIFEST_NAME)) === true
    const hasConfig = fs.existsSync(path.join(dir, CONFIG_DIR)) === true
      && fs.readdirSync(path.join(dir, CONFIG_DIR)).length > 0
    assert.equal(
      hasManifest && hasConfig,
      true,
      name + ' carries a backup name but is not a complete backup',
    )
  }
  return published
}

test('(a) a backup CANCELLED while copying links leaves NO published directory', async (t) => {
  const root = tempRoot(t)
  const profile = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  let calls = 0
  const result = await createBackup({
    profileDir: profile,
    backupsDir,
    includePlugins: true,
    // Cancel as soon as the copy loop is really running (the first checks are
    // the caller's own; the loop asks again for every file it touches).
    shouldCancel: () => { calls += 1; return calls > 2 },
  })

  assert.equal(result.cancelled, true, 'the backup reports that it was cancelled')
  assert.equal(result.ok === true, false)
  // THE POINT: whatever is left may only be `.staging-*`, never a backup name.
  assertNoPublishedIncomplete(backupsDir)
  const leftovers = fs.readdirSync(backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  assert.deepEqual(leftovers, [], 'the half-written staging directory is removed as well')
})

test('(b) a copy FAILURE (source config vanishes mid-copy) leaves NO published directory', async (t) => {
  const root = tempRoot(t)
  const profile = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  // Deleting a configuration file between the "what does the source have" look
  // and the copy is exactly the race that produced a copy without a manifest.
  let reads = 0
  const result = await createBackup({
    profileDir: profile,
    backupsDir,
    includePlugins: true,
    now: () => {
      reads += 1
      if (reads === 3) {
        try { fs.rmSync(path.join(profile, 'package.json'), { force: true }) } catch {}
      }
      return Date.now()
    },
  })

  // Whether it published a complete copy or refused, it must never publish a
  // half one — that is the whole invariant.
  assertNoPublishedIncomplete(backupsDir)
  if (result.ok === true) {
    assert.equal(fs.existsSync(path.join(result.dir, MANIFEST_NAME)), true)
  }
})

test('(c) a profile MISSING its configuration never produces a published backup', async (t) => {
  const root = tempRoot(t)
  const profile = makeProfile(root, { withConfigs: false })
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const result = await createBackup({ profileDir: profile, backupsDir, includePlugins: true })

  assert.equal(result.ok === true, false, 'no configuration, no backup')
  assertNoPublishedIncomplete(backupsDir)
  assert.equal(
    fs.readdirSync(backupsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    0,
    'not even a staging directory is left behind',
  )
})

test('the BOOT sweep heals what an older build left behind, and reports the numbers', (t) => {
  const root = tempRoot(t)
  // What the real machine looked like: published names, links only, no manifest.
  makeGutted(root, '2026-11-01T16-10-51-253Z', 2048)
  makeGutted(root, '2026-11-01T16-16-13-898Z', 2048)
  const keep = makeComplete(root, '2026-11-01T13-33-42-271Z')

  const answer = removeIncompleteBackups(root)

  assert.deepEqual(answer.removed, ['2026-11-01T16-10-51-253Z', '2026-11-01T16-16-13-898Z'])
  assert.equal(answer.bytes >= 4096, true, 'the freed bytes are reported: ' + String(answer.bytes))
  assert.equal(answer.capped, false)
  assert.equal(fs.existsSync(keep), true, 'the one complete backup survives')
})

test('a directory with neither a manifest nor a configuration is removed', (t) => {
  const root = tempRoot(t)
  const victim = makeGutted(root, '2026-11-01T09-38-21-855Z', 2048)

  const answer = removeIncompleteBackups(root)

  assert.deepEqual(answer.removed, ['2026-11-01T09-38-21-855Z'])
  assert.equal(fs.existsSync(victim), false, 'the dead directory is gone')
  assert.ok(answer.bytes >= 2048, 'and its bytes are reported: ' + String(answer.bytes))
  assert.equal(answer.capped, false)
})

test('a manifest is what makes a directory a copy — anything else is a victim', (t) => {
  const root = tempRoot(t)
  const complete = makeComplete(root, '2026-11-01T13-33-42-271Z')

  // Manifest but no configuration file: kept. It is still a point in time, and a
  // copy that lost one file is not a reason to throw the moment away.
  const manifestOnly = path.join(root, 'manifest-only')
  fs.mkdirSync(manifestOnly, { recursive: true })
  fs.writeFileSync(path.join(manifestOnly, MANIFEST_NAME), '{}', 'utf8')

  // Configuration but NO manifest (user decision, 2026-11-02): this is exactly the
  // shape that filled the real machine — a copy that died after writing the plugin
  // tree. Nothing can restore from it, so it is a victim however much it holds.
  const configOnly = path.join(root, 'config-only')
  fs.mkdirSync(path.join(configOnly, CONFIG_DIR), { recursive: true })
  fs.writeFileSync(path.join(configOnly, CONFIG_DIR, 'cordis.patch.yml'), 'a: 1\n', 'utf8')

  const answer = removeIncompleteBackups(root)

  assert.deepEqual(answer.removed, ['config-only'], 'only the directory without a manifest goes')
  assert.equal(fs.existsSync(complete), true)
  assert.equal(fs.existsSync(manifestOnly), true, 'a manifest alone is enough to keep a directory')
  assert.equal(fs.existsSync(configOnly), false, 'a configuration without a manifest is not a copy')
})

test('a staging directory being written right now is NEVER touched', (t) => {
  const root = tempRoot(t)
  // This is a backup in flight: no manifest yet, no config yet — exactly the
  // shape that would look like junk one second before it is renamed into place.
  const staging = path.join(root, '.staging-2026-11-01T15-00-00-000Z')
  fs.mkdirSync(path.join(staging, 'node_modules-link', 'p'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'node_modules-link', 'p', 'index.js'), 'x\n', 'utf8')

  const answer = removeIncompleteBackups(root)

  assert.deepEqual(answer.removed, [])
  assert.equal(fs.existsSync(staging), true, 'a half-written backup is not garbage')
})

test('the sweep is bounded: over the budget it reports instead of deleting', (t) => {
  const root = tempRoot(t)
  makeGutted(root, 'a-1', 100)
  makeGutted(root, 'a-2', 100)
  makeGutted(root, 'a-3', 100)

  const answer = removeIncompleteBackups(root, { dirs: 2 })

  assert.equal(answer.removed.length, 2, 'exactly the budget')
  assert.deepEqual(answer.skipped, ['a-3'], 'the rest is only reported')
  assert.equal(answer.capped, true)
  assert.equal(fs.existsSync(path.join(root, 'a-3')), true, 'nothing beyond the budget is deleted')

  // A byte budget does the same, independently of the count.
  const root2 = tempRoot(t)
  makeGutted(root2, 'b-1', 4096)
  const byBytes = removeIncompleteBackups(root2, { bytes: 1024 })
  assert.deepEqual(byBytes.removed, [])
  assert.deepEqual(byBytes.skipped, ['b-1'])
  assert.equal(byBytes.capped, true)
})

test('a dry run deletes nothing and still reports what it would remove', (t) => {
  const root = tempRoot(t)
  const victim = makeGutted(root, 'c-1', 512)
  const answer = removeIncompleteBackups(root, { dryRun: true })
  assert.deepEqual(answer.removed, ['c-1'])
  assert.equal(fs.existsSync(victim), true, 'dryRun must not delete')
})

test('a backup of a linked plugin contains its files but NOT its .git', async (t) => {
  const root = tempRoot(t)
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'probe-profile',
    dsh: { profile: { bundles: ['dsh-linked'] } },
  }, null, 2), 'utf8')
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

  // The plugin is a working checkout: it has a source file AND a history.
  const pluginSource = path.join(root, 'plugin-source')
  fs.mkdirSync(path.join(pluginSource, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(pluginSource, '.git', 'objects'), { recursive: true })
  fs.writeFileSync(path.join(pluginSource, 'index.js'), 'export const x = 1\n', 'utf8')
  fs.writeFileSync(path.join(pluginSource, 'lib', 'helper.js'), 'export const y = 2\n', 'utf8')
  fs.writeFileSync(path.join(pluginSource, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  fs.writeFileSync(path.join(pluginSource, '.git', 'objects', 'blob'), 'history\n', 'utf8')

  const pluginsDir = path.join(profileDir, 'node_modules')
  fs.mkdirSync(pluginsDir, { recursive: true })
  fs.symlinkSync(pluginSource, path.join(pluginsDir, 'dsh-linked'), 'junction')

  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const result = await createBackup({ profileDir, backupsDir })
  assert.equal(result.ok, true, String(result.error))

  const copied = path.join(result.dir, 'node_modules-link', 'dsh-linked')
  // THE PLUGIN IS THERE...
  assert.equal(fs.existsSync(path.join(copied, 'index.js')), true, 'the plugin itself is backed up')
  assert.equal(fs.existsSync(path.join(copied, 'lib', 'helper.js')), true, 'and its other files too')
  // ...WITHOUT ITS HISTORY.
  assert.equal(fs.existsSync(path.join(copied, '.git')), false, '.git must not be copied')
  // And the list is exactly that one name — this is not a place to guess.
  assert.deepEqual([...BACKUP_SKIP_NAMES], ['.git'])
  // The source is untouched: excluding a name from the COPY never deletes it.
  assert.equal(fs.existsSync(path.join(pluginSource, '.git', 'HEAD')), true)
})

// ---------------------------------------------------------------------------
// A NAME THAT PROMISES A BACKUP (2026-11-02)
//
// The 24 dead directories on the real machine carried a BACKUP STAMP — the same
// name a usable copy carries. Every reader had to learn to skip them, which is
// the wrong place to put the check: the writer must never publish a copy that is
// not one. Two ways a copy can end up incomplete are pinned below.
// ---------------------------------------------------------------------------

/** A profile directory, with or without the three files a backup must carry. */
function makeProfile(root, { withConfigs = true } = {}) {
  const dir = path.join(root, 'profile')
  fs.mkdirSync(dir, { recursive: true })
  if (withConfigs) {
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe-profile"}\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  }
  return dir
}

/** Every entry that would be read as a backup (i.e. not a dot entry). */
function publishedDirs(root) {
  if (fs.existsSync(root) !== true) return []
  return fs.readdirSync(root).filter((name) => name.startsWith('.') !== true)
}

test('a copy that lost its configuration is never published under a backup name', async (t) => {
  const root = tempRoot(t)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  // A profile with NO configuration at all: there is nothing a restore could
  // put back, so the copy must not appear as a backup.
  const profileDir = makeProfile(root, { withConfigs: false })

  const result = await createBackup({ profileDir, backupsDir, includePlugins: false, maxBackups: 5 })

  assert.equal(result.ok, false, 'an incomplete copy is not a successful backup')
  assert.deepEqual(publishedDirs(backupsDir), [], 'and it did not keep a backup name')
})

test('a cancelled copy is never published under a backup name', async (t) => {
  const root = tempRoot(t)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const profileDir = makeProfile(root)

  const result = await createBackup({
    profileDir,
    backupsDir,
    includePlugins: false,
    maxBackups: 5,
    shouldCancel: () => true,
  })

  assert.notEqual(result.ok, true, 'a cancelled copy is not a successful backup')
  assert.deepEqual(publishedDirs(backupsDir), [], 'and it did not keep a backup name')
})

// THE BACKUP DIRECTORIES THAT NEVER FINISHED (2026-11-02).
//
// `removeIncompleteBackups` only ran from the first-install path, so an
// ordinary restart swept nothing and an empty shell left by a backup that died
// mid-write stayed on disk forever. A real machine had three directories while
// the page said two copies. `sweepIncompleteBackups` runs on every boot.
import { countIncompleteBackups, sweepIncompleteBackups } from '../lib/backup.js'

test('boot sweep: an empty leftover directory is removed and reported', (t) => {
  const root = tempRoot(t)
  const leftovers = path.join(root, 'backups')
  fs.mkdirSync(leftovers, { recursive: true })

  // The shape found on the real machine: a directory with no manifest, no
  // meta.json and nothing inside at all.
  const junk = path.join(leftovers, '2026-11-02T07-55-09-645Z')
  fs.mkdirSync(junk, { recursive: true })
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(junk, old, old)

  const kept = makeComplete(leftovers, '2026-11-02T07-20-00-000Z')
  // A copy that really is complete carries both files; makeComplete only
  // writes the manifest, so the meta.json is added here on purpose.
  fs.writeFileSync(path.join(kept, 'meta.json'), '{}', 'utf8')

  const report = sweepIncompleteBackups(leftovers)
  assert.equal(report.skipped, false, 'a readable directory is not skipped')
  assert.deepEqual(report.removed, ['2026-11-02T07-55-09-645Z'], 'the empty shell is named in removed')
  assert.equal(fs.existsSync(junk), false, 'and it is gone from disk')
  assert.equal(fs.existsSync(kept), true, 'a real copy is untouched')
  assert.equal(countIncompleteBackups(leftovers).incomplete, 0, 'nothing incomplete is left to explain')
})

test('boot sweep: a directory written moments ago is kept, not deleted', (t) => {
  const root = tempRoot(t)
  const leftovers = path.join(root, 'backups')
  fs.mkdirSync(leftovers, { recursive: true })

  // Empty, but its mtime is NOW: a backup may be writing into it this second,
  // and deleting a copy mid-write is worse than leaving one behind.
  const fresh = path.join(leftovers, '2026-11-02T08-00-00-000Z')
  fs.mkdirSync(fresh, { recursive: true })

  const report = sweepIncompleteBackups(leftovers)
  assert.deepEqual(report.removed, [], 'nothing was deleted')
  assert.deepEqual(report.kept, ['2026-11-02T08-00-00-000Z'], 'it is reported as kept')
  assert.equal(fs.existsSync(fresh), true, 'and it is still on disk for the writer to finish')
})

test('the count says which DIRECTORY is not a copy, so 3 directories / 2 copies is explainable', (t) => {
  const root = tempRoot(t)
  const leftovers = path.join(root, 'backups')
  fs.mkdirSync(leftovers, { recursive: true })
  const withMeta = (name) => {
    const dir = makeComplete(leftovers, name)
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}', 'utf8')
    return dir
  }
  withMeta('2026-11-02T07-20-00-000Z')
  withMeta('2026-11-02T07-40-00-000Z')
  // A directory with a manifest but no meta.json: reported, never deleted —
  // old copies legitimately predate meta.json.
  const legacy = makeComplete(leftovers, '2026-11-02T07-00-00-000Z')
  fs.rmSync(path.join(legacy, 'meta.json'), { force: true })

  const counted = countIncompleteBackups(leftovers)
  assert.equal(counted.scanned, 3, 'three directories')
  assert.equal(counted.incomplete, 1, 'one of them is not a usable copy')
  assert.deepEqual(counted.names, ['2026-11-02T07-00-00-000Z'])

  const report = sweepIncompleteBackups(leftovers)
  assert.deepEqual(report.removed, [], 'a copy missing only meta.json is never deleted')
  assert.equal(fs.existsSync(legacy), true, 'it stays on disk')
})

test('boot sweep: a directory with hundreds of files and NO manifest is reclaimed, bytes and all', (t) => {
  const root = tempRoot(t)
  const leftovers = path.join(root, 'backups')
  fs.mkdirSync(leftovers, { recursive: true })

  // EXACTLY the real machine's 2026-11-02 residue: a backup stamp, the whole
  // plugin tree copied in (497 files, ~150 MB), and no manifest — restorable by
  // nothing. The old sweep spared it because "it holds something"; that is the
  // rule this test exists to keep from coming back.
  const junk = path.join(leftovers, '2026-11-02T08-14-47-970Z')
  fs.mkdirSync(path.join(junk, 'node_modules-link', 'some-plugin'), { recursive: true })
  let payloadBytes = 0
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(
      path.join(junk, 'node_modules-link', 'some-plugin', 'f' + index + '.js'),
      'x'.repeat(100),
      'utf8',
    )
    payloadBytes += 100
  }
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(junk, old, old)

  const kept = makeComplete(leftovers, '2026-11-02T07-20-00-000Z')
  fs.writeFileSync(path.join(kept, 'meta.json'), '{}', 'utf8')

  const report = sweepIncompleteBackups(leftovers)

  assert.deepEqual(report.removed, ['2026-11-02T08-14-47-970Z'], 'the wreck is named in removed')
  assert.equal(fs.existsSync(junk), false, 'and the whole tree is gone from disk')
  assert.equal(
    report.bytes >= payloadBytes,
    true,
    'the reclaimed bytes are counted before the delete: ' + String(report.bytes),
  )
  assert.equal(fs.existsSync(kept), true, 'the real copy is untouched')
  assert.equal(countIncompleteBackups(leftovers).incomplete, 0, 'and nothing incomplete is left to explain')
})

test('boot sweep: a copy with a manifest but no meta.json is kept, only counted', (t) => {
  const root = tempRoot(t)
  const leftovers = path.join(root, 'backups')
  fs.mkdirSync(leftovers, { recursive: true })

  // An OLD copy: it predates `meta.json`, which is why it has none. It restores
  // perfectly well, so the sweep must not "clean" it away.
  const legacy = makeComplete(leftovers, '2026-11-02T06-00-00-000Z')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(legacy, old, old)

  const report = sweepIncompleteBackups(leftovers)

  assert.deepEqual(report.removed, [], 'a manifest is enough: it is a copy')
  assert.deepEqual(report.kept, ['2026-11-02T06-00-00-000Z'], 'and it is reported as kept')
  assert.equal(fs.existsSync(legacy), true, 'it stays on disk')
  assert.equal(countIncompleteBackups(leftovers).incomplete, 1, 'while the page still says it is not complete')
})