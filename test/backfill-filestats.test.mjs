/**
 * THE COLD START OF THE QUICK CHECK (2026-11-07, task t37).
 *
 * t36 made an untouched profile free to compare — but only for copies that carry
 * the `size + mtime + inode` triples. Every copy written before t36 carries hashes
 * and no triples, and the real machine showed exactly that on gen 534:
 * `fileHashes: 861, fileStats: 0`. A profile that does not change never writes a
 * new copy, so it would stay on the slow path (read every byte, every restart)
 * forever — the fast layer would exist and never be used.
 *
 * THE FIX: the moment the comparison answers `unchanged`, the copy has just been
 * proven to hold exactly the live files, so their triples are recorded into that
 * copy's own manifest. Next restart is free.
 *
 * WHAT THIS FILE PINS DOWN:
 *   · the backfill happens, and the copy's manifest really gains `fileStats`;
 *   · the existing manifest fields survive untouched (hashes, files, stamps);
 *   · the next comparison answers `metadata-equal` with zero files read;
 *   · a copy that cannot be rewritten is not fatal — the answer stays `unchanged`.
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

function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-backfill-${label}-`))
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

/** A copy, with its `fileStats` removed — i.e. exactly what a t34-era copy looks like. */
async function writeOldCopy(profile, backups) {
  const written = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true })
  assert.equal(written.ok, true, 'the copy was written: ' + String(written.error))
  const manifestPath = path.join(written.dir, 'manifest.json')
  const manifest = readManifest(written.dir)
  assert.ok(manifest && manifest.fileHashes, 'the copy records hashes')
  delete manifest.fileStats
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { copyDir: written.dir, manifestPath, before: manifest }
}

/* ------------------------------------------------------------------ *
 * ① THE BACKFILL HAPPENS — AND ONLY ADDS THE TRIPLES.
 * ------------------------------------------------------------------ */

test('① an unchanged answer teaches an older copy the triples it never had', async (t) => {
  const setup = fixture(t, 'backfill')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const { copyDir, manifestPath, before } = await writeOldCopy(setup.profile, setup.backups)
  assert.equal(readManifest(copyDir).fileStats, undefined, 'the copy starts without triples')

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })

  // ① THE ANSWER IS UNCHANGED and the backfill is reported.
  assert.equal(answer.state, 'unchanged', 'nothing changed')
  assert.equal(answer.backfilled, true, 'and the copy was taught: ' + JSON.stringify(answer.backfillReason))

  // ② THE MANIFEST NOW CARRIES THE TRIPLES …
  const after = readManifest(copyDir)
  assert.ok(after && typeof after.fileStats === 'object', 'fileStats is written')
  const stat = after.fileStats[LINKS_DIR + '/demo-plugin/index.js']
  assert.ok(stat, 'the plugin file has a triple: ' + JSON.stringify(Object.keys(after.fileStats)))
  assert.equal(typeof stat.size, 'number', 'size')
  assert.equal(typeof stat.mtimeMs, 'number', 'mtimeMs')
  assert.equal(typeof stat.ino, 'number', 'ino')

  // ③ …AND NOTHING ELSE MOVED: every pre-existing field is preserved verbatim.
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key], before[key], 'the field survives untouched: ' + key)
  }
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'fileStats'].sort(), 'only fileStats was added')

  // ④ THE SNAPSHOT'S OWN FILES WERE NOT TOUCHED — only the manifest was rewritten.
  assert.equal(
    fs.readFileSync(path.join(copyDir, LINKS_DIR, 'demo-plugin', 'index.js'), 'utf8'),
    'export default 1\n',
    'the copied file still holds the same bytes',
  )
  assert.equal(fs.existsSync(manifestPath), true, 'and the manifest is still a file')
})

/* ------------------------------------------------------------------ *
 * ② THE NEXT COMPARISON IS FREE: metadata-equal, nothing read.
 * ------------------------------------------------------------------ */

test('② the next comparison of the same profile is answered without reading a byte', async (t) => {
  const setup = fixture(t, 'next')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeOldCopy(setup.profile, setup.backups)

  const first = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(first.backfilled, true, 'the first comparison paid and taught the copy')

  const second = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(second.state, 'unchanged', 'still nothing changed')
  assert.equal(second.reason, 'metadata-equal', 'and now the quick check answers: ' + JSON.stringify(second.reason))
  assert.equal(second.stats.hashed, 0, 'not one file was read: ' + JSON.stringify(second.stats))
  assert.ok(second.stats.fast > 0, 'all of them were answered by metadata: ' + JSON.stringify(second.stats))
  assert.equal(second.backfilled, false, 'and there was nothing left to teach')
  assert.equal(second.backfillReason, 'already-present', 'because the triples are there')
})

/* ------------------------------------------------------------------ *
 * ③ A COPY THAT CANNOT BE REWRITTEN IS NOT FATAL.
 * ------------------------------------------------------------------ */

test('③ a manifest that cannot be rewritten leaves the answer unchanged and does not throw', async (t) => {
  const setup = fixture(t, 'readonly')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const { copyDir, manifestPath } = await writeOldCopy(setup.profile, setup.backups)

  // MAKE THE MANIFEST UNWRITABLE. On Windows the read-only attribute is what
  // stops a write; where the filesystem ignores it the write would simply
  // succeed, and the test says so instead of pretending to have exercised the
  // failure branch.
  fs.chmodSync(manifestPath, 0o444)
  let writable = true
  try {
    const probe = fs.openSync(manifestPath, 'r+')
    fs.closeSync(probe)
  } catch {
    writable = false
  }

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })

  // THE ANSWER IS DECIDED BEFORE THE BACKFILL EVER RUNS, so it cannot be affected.
  assert.equal(answer.state, 'unchanged', 'an unwritable manifest is not a change')
  assert.equal(answer.reason, 'content-equal', 'the content check still answered: ' + JSON.stringify(answer.reason))
  assert.equal(readManifest(copyDir).fileStats, undefined, 'and no triples were invented')
  if (writable === false) {
    assert.equal(answer.backfilled, false, 'the failure is reported, not swallowed')
    assert.match(String(answer.backfillReason), /write-failed/, 'with the reason: ' + String(answer.backfillReason))
  }

  // Cleanup must not be defeated by the read-only attribute.
  try { fs.chmodSync(manifestPath, 0o666) } catch {}
})
