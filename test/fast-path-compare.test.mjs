/**
 * THE QUICK CHECK BEFORE THE CONTENT CHECK (2026-11-07, task t36).
 *
 * t34 made the comparison honest — it reads the bytes. But it read ALL of them on
 * every restart: ~300 MB, 1–2 s, for a profile that usually did not change at all.
 * Both mature tools put a cheaper layer in front of exactly that:
 *
 *   · rsync's "quick check" compares size + last-modified time and only `-c` reads
 *     content (the manual is explicit that reading "slows things down");
 *   · borg's files cache treats `size + mtime + inode` as proof the file was not
 *     touched — "the file is not read / chunked / hashed again".
 *
 * SO: the manifest now records the live file's `size + mtimeSec + inode` next to
 * its sha256. All three equal ⇒ the file cannot have different bytes ⇒ it is not
 * read (`reason: metadata-equal`). Anything else ⇒ the t34 content decision, which
 * is what keeps "touched but unchanged" at `unchanged`.
 *
 * THE RULE THIS FILE DEFENDS: the fast layer may only ever save IO. It must never
 * turn "content changed" into "unchanged", and it must never turn "only touched"
 * into `changed` — so a hit is proven by `stats.fast > 0 && stats.hashed === 0`.
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

/** A profile with one LINKED plugin and its configuration at the root. */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-fast-${label}-`))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const profile = path.join(dir, 'profile')
  const source = path.join(dir, 'demo-source')
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(backups, { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"demo-plugin","version":"1.0.0"}\n', 'utf8')
  fs.writeFileSync(path.join(source, 'index.js'), 'export default 1\n', 'utf8')
  fs.writeFileSync(path.join(source, 'extra.js'), 'export default 2\n', 'utf8')
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

/* ------------------------------------------------------------------ *
 * ① NOTHING TOUCHED: the quick check answers and nothing is read.
 * ------------------------------------------------------------------ */

test('① an untouched profile is answered by size+mtime+inode without reading a byte', async (t) => {
  const setup = fixture(t, 'same')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const copyDir = await writeCopy(setup.profile, setup.backups)

  // THE MANIFEST CARRIES THE TRIPLE, next to the hash.
  const manifest = readManifest(copyDir)
  assert.ok(manifest && typeof manifest.fileStats === 'object', 'the copy records live file stats')
  const stat = manifest.fileStats[LINKS_DIR + '/demo-plugin/index.js']
  assert.ok(stat, 'the plugin file is recorded: ' + JSON.stringify(Object.keys(manifest.fileStats)))
  assert.equal(typeof stat.size, 'number', 'with its size')
  // Milliseconds, not seconds: the same triple borg keeps, at the resolution the
  // filesystem really reports (a same-second rewrite must not look "equal").
  assert.equal(typeof stat.mtimeMs, 'number', 'its modification time in ms')
  assert.equal(typeof stat.ino, 'number', 'and its inode')
  assert.equal(typeof manifest.fileHashes[LINKS_DIR + '/demo-plugin/index.js'], 'string', 'and the hash stays too')

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })

  assert.equal(answer.state, 'unchanged', 'nothing was touched')
  // ① THE FAST PATH DID IT: files answered by metadata, and NOT ONE sha256 call.
  assert.equal(answer.reason, 'metadata-equal', 'the quick check is the reason: ' + JSON.stringify(answer.reason))
  assert.ok(answer.stats, 'the answer reports what it cost: ' + JSON.stringify(answer.stats))
  assert.ok(answer.stats.fast > 0, 'files were answered by the quick check: ' + JSON.stringify(answer.stats))
  assert.equal(answer.stats.hashed, 0, 'and no file had to be read: ' + JSON.stringify(answer.stats))
  assert.deepEqual(answer.differences, [], 'nothing to report')
})

/* ------------------------------------------------------------------ *
 * ② TOUCHED BUT UNCHANGED: the quick check fails, the content decides.
 * ------------------------------------------------------------------ */

test('② a moved timestamp falls back to the content check and is still unchanged', async (t) => {
  const setup = fixture(t, 'touch')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000)
  fs.utimesSync(path.join(setup.source, 'index.js'), later, later)

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })

  // ① STILL UNCHANGED — the core promise of t34 must survive the fast layer.
  assert.equal(answer.state, 'unchanged', 'same bytes ⇒ unchanged, whatever the clock says')
  assert.equal(answer.reason, 'content-equal', 'the content check had to answer: ' + JSON.stringify(answer.reason))
  // ② EXACTLY ONE file was read — the one whose timestamp moved.
  assert.equal(answer.stats.hashed, 1, 'only the touched file was hashed: ' + JSON.stringify(answer.stats))
  assert.ok(answer.stats.fast > 0, 'every other file was free: ' + JSON.stringify(answer.stats))
})

/* ------------------------------------------------------------------ *
 * ③ A REAL CHANGE IS STILL A CHANGE, WHATEVER THE QUICK CHECK SAYS.
 * ------------------------------------------------------------------ */

test('③ a changed size is a change, and a same-size edit is caught by content', async (t) => {
  const setup = fixture(t, 'change')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  // ① SIZE CHANGED: the quick check already disagrees, and the content hash
  // confirms it (the byte count differs too, so this is a `content` difference).
  fs.writeFileSync(path.join(setup.source, 'index.js'), 'export default 11\n', 'utf8')
  const grown = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(grown.state, 'changed', 'a longer file is a change')
  assert.equal(grown.reason, 'plugin-tree-differs', 'and it is in the plugin half')
  const grownEntry = grown.differences.find((item) => item.path === LINKS_DIR + '/demo-plugin/index.js')
  assert.ok(grownEntry, 'the file is named: ' + JSON.stringify(grown.differences))
  assert.equal(grownEntry.kind, 'content', 'caught by content, not by the timestamp alone')

  // ② THE SAME LENGTH, ONE DIFFERENT BYTE — in the SAME SECOND as the copy, so
  // size and mtime alone would say "unchanged". The content check is the only
  // thing standing between this and a silently lost edit.
  fs.writeFileSync(path.join(setup.source, 'index.js'), 'export default 12\n', 'utf8')
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000)
  fs.utimesSync(path.join(setup.source, 'index.js'), stamp, stamp)
  const sneaky = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(sneaky.state, 'changed', 'a same-size edit inside the same second is still a change')
  assert.ok(
    sneaky.differences.some((item) => item.path === LINKS_DIR + '/demo-plugin/index.js' && item.kind === 'content'),
    'and the content check is what found it: ' + JSON.stringify(sneaky.differences),
  )
})
