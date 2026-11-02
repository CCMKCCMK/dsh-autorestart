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
 *   - only a directory that is missing BOTH is a victim — one of the two makes
 *     it something else and it is kept;
 *   - `.staging-*` (a backup being written right now) and complete backups are
 *     never touched;
 *   - the sweep has a hard budget and reports what it did (count + bytes);
 *   - a backup never contains `.git`, and still contains the plugin's own files.
 *
 * Everything runs in a temp directory: the user's real 1.78 GB is NOT touched
 * here — deleting that is a decision for the operator, not for a test.
 */

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

test('complete backups and anything with ONE of the two are kept', (t) => {
  const root = tempRoot(t)
  const complete = makeComplete(root, '2026-11-01T13-33-42-271Z')

  // Manifest but no configuration: not a victim (only BOTH missing is).
  const manifestOnly = path.join(root, 'manifest-only')
  fs.mkdirSync(manifestOnly, { recursive: true })
  fs.writeFileSync(path.join(manifestOnly, MANIFEST_NAME), '{}', 'utf8')

  // A configuration but no manifest: also not a victim.
  const configOnly = path.join(root, 'config-only')
  fs.mkdirSync(path.join(configOnly, CONFIG_DIR), { recursive: true })
  fs.writeFileSync(path.join(configOnly, CONFIG_DIR, 'cordis.patch.yml'), 'a: 1\n', 'utf8')

  const answer = removeIncompleteBackups(root)

  assert.deepEqual(answer.removed, [], 'nothing was deleted: ' + String(answer.reason))
  assert.equal(fs.existsSync(complete), true)
  assert.equal(fs.existsSync(manifestOnly), true)
  assert.equal(fs.existsSync(configOnly), true)
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
