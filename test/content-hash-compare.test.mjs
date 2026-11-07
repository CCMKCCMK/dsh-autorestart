/**
 * "IS IT THE SAME?" IS ANSWERED BY THE BYTES, NOT BY A TIMESTAMP (2026-11-07).
 *
 * THE REAL MACHINE: two copies were compared file by file and differed in
 * nothing — 0 added, 0 removed, 0 size changes — yet the next restart took a
 * 305 MB copy again. The digest hashed `path + size + round(mtime/1000)`, so a
 * rewrite that changed nothing still counted as a change. gen 516 → gen 517 had
 * correctly skipped, gen 527 → 528 did not: the feature was sometimes on and
 * sometimes off, which is the one thing a backup may never be.
 *
 * WHAT THIS FILE PINS DOWN (task t34 — content fingerprints):
 *   · a copy records a sha256 for every file it holds (configuration included);
 *   · `touch` alone (size and bytes identical, only the time moved) → `unchanged`;
 *   · one changed byte → `changed`, and the difference names that file;
 *   · an older copy WITHOUT per-file hashes still answers correctly (it reads
 *     both sides and says `content-equal-mtime-differs`);
 *   · a file that appeared or disappeared → `changed`.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBackup, findUnchangedBackup, readManifest } from '../lib/backup.js'

const LINKS_DIR = 'node_modules-link'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A profile with one LINKED plugin, its configuration at the root, and a backups root. */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-hash-${label}-`))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const profile = path.join(dir, 'profile')
  const source = path.join(dir, 'demo-source')
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(backups, { recursive: true })
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
  return { dir, profile, source, backups, linked }
}

/** One complete copy of the profile, plugins included. */
async function writeCopy(profile, backups) {
  const written = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true })
  assert.equal(written.ok, true, 'the copy was written: ' + String(written.error))
  return written.dir
}

/** Move a file's modification time forward without touching a byte of it. */
function touchForward(abs, seconds = 60) {
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000)
  fs.utimesSync(abs, later, later)
}

/* ------------------------------------------------------------------ *
 * ① THE COPY RECORDS CONTENT, AND A MERE TOUCH IS NOT A CHANGE.
 * ------------------------------------------------------------------ */

test('① a copy records sha256 per file, and touching a file is not a change', async (t) => {
  const setup = fixture(t, 'touch')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const copyDir = await writeCopy(setup.profile, setup.backups)

  // ① THE MANIFEST HOLDS THE BYTES' FINGERPRINTS — plugin files AND configuration.
  const manifest = readManifest(copyDir)
  const hashes = manifest && manifest.fileHashes
  assert.ok(hashes && typeof hashes === 'object', 'the copy records per-file hashes: ' + JSON.stringify(Object.keys(manifest ?? {})))
  assert.equal(typeof hashes['config/cordis.patch.yml'], 'string', 'the configuration is hashed too')
  assert.match(hashes['config/cordis.patch.yml'], /^sha256:[0-9a-f]{64}$/, 'as a sha256 digest')
  assert.equal(typeof hashes[LINKS_DIR + '/demo-plugin/index.js'], 'string', 'and so is every plugin file')

  // ② TOUCH ONLY: the bytes are identical, the time moved.
  touchForward(path.join(setup.source, 'index.js'))
  touchForward(path.join(setup.profile, 'cordis.patch.yml'))

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(answer.state, 'unchanged', 'same bytes ⇒ unchanged, whatever the clock says')
  assert.equal(answer.reason, 'content-equal', 'and the reason says the content matched')
  assert.deepEqual(answer.differences, [], 'nothing to report')
})

/* ------------------------------------------------------------------ *
 * ② ONE CHANGED BYTE IS A CHANGE — AND THE FILE IS NAMED.
 * ------------------------------------------------------------------ */

test('② one changed byte is a change, and the difference names that file', async (t) => {
  const setup = fixture(t, 'byte')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  // THE SAME LENGTH ON PURPOSE: a size-only comparison would call this "same".
  fs.writeFileSync(path.join(setup.source, 'index.js'), 'export default 2\n', 'utf8')

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(answer.state, 'changed', 'different bytes are a real change')
  assert.equal(answer.reason, 'plugin-tree-differs', 'and the plugin half is where it happened')
  const entry = answer.differences.find((item) => item.path === LINKS_DIR + '/demo-plugin/index.js')
  assert.ok(entry, 'the file is named: ' + JSON.stringify(answer.differences))
  assert.equal(entry.kind, 'content', 'the kind is content')
  assert.notEqual(entry.live.sha256, entry.copy.sha256, 'with both fingerprints, so it can be checked')
})

/* ------------------------------------------------------------------ *
 * ③ AN OLDER COPY WITHOUT HASHES STILL ANSWERS CORRECTLY.
 * ------------------------------------------------------------------ */

test('③ an older copy without per-file hashes falls back to reading both sides', async (t) => {
  const setup = fixture(t, 'old')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const copyDir = await writeCopy(setup.profile, setup.backups)

  // MAKE IT AN OLD COPY: rewrite the manifest without the hash map, exactly the
  // shape every copy on the real machine has today.
  const manifest = readManifest(copyDir)
  delete manifest.fileHashes
  fs.writeFileSync(path.join(copyDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  assert.equal(readManifest(copyDir).fileHashes, undefined, 'the copy no longer carries hashes')

  // ① TOUCH ONLY → still unchanged, through the content fallback.
  touchForward(path.join(setup.source, 'index.js'))
  const touched = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(touched.state, 'unchanged', 'the fallback reads both sides and agrees')
  assert.equal(touched.reason, 'content-equal-mtime-differs', 'and says why it was not a change')

  // ② A REAL EDIT → changed, and the difference is content, not a timestamp.
  fs.writeFileSync(path.join(setup.source, 'index.js'), 'export default 3\n', 'utf8')
  const edited = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(edited.state, 'changed', 'a real edit is still a change')
  const entry = edited.differences.find((item) => item.path === LINKS_DIR + '/demo-plugin/index.js')
  assert.ok(entry, 'the file is named: ' + JSON.stringify(edited.differences))
  assert.equal(entry.kind, 'content', 'reported as content, not as mtime')
})

/* ------------------------------------------------------------------ *
 * ④ A FILE THAT APPEARED OR DISAPPEARED IS A CHANGE.
 * ------------------------------------------------------------------ */

test('④ an added or removed file is a change, whichever side it is on', async (t) => {
  const setup = fixture(t, 'files')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const copyDir = await writeCopy(setup.profile, setup.backups)

  // ADDED: a new file in the live plugin.
  fs.writeFileSync(path.join(setup.source, 'added.js'), 'export default 0\n', 'utf8')
  const added = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(added.state, 'changed', 'a new file is a change')
  const addedEntry = added.differences.find((item) => item.path === LINKS_DIR + '/demo-plugin/added.js')
  assert.ok(addedEntry, 'the new file is named: ' + JSON.stringify(added.differences))
  assert.equal(addedEntry.kind, 'added', 'as added')

  // REMOVED: the same file gone again — now the COPY holds a file the profile does not.
  fs.rmSync(path.join(setup.source, 'added.js'), { force: true })
  const removed = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(removed.state, 'unchanged', 'back to the copy state')

  fs.rmSync(path.join(setup.source, 'package.json'), { force: true })
  const gone = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(gone.state, 'changed', 'a vanished file is a change')
  const goneEntry = gone.differences.find((item) => item.path === LINKS_DIR + '/demo-plugin/package.json')
  assert.ok(goneEntry, 'the vanished file is named: ' + JSON.stringify(gone.differences))
  assert.equal(goneEntry.kind, 'removed', 'as removed')
  assert.equal(fs.existsSync(copyDir), true, 'the copy itself was never touched')
})
