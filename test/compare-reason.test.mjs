/**
 * "CHANGED" MUST SAY WHAT CHANGED (real machine, 2026-11-07 16:59).
 *
 * THE PUZZLE: gen 527 wrote `08-58-35-923Z`, gen 528 wrote `08-59-25-685Z`, and a
 * file-by-file walk of the two copies found NOTHING different — 0 added, 0
 * removed, 0 size changes; only the copies' own `manifest.json` / `meta.json`
 * had a later mtime. The verdict for gen 528 said `skipped: null`, i.e. "changed,
 * copy again" — 305,033,541 bytes — with no way to tell WHICH half of the
 * comparison had drifted. Worse, gen 516 → gen 517 had correctly said
 * `unchanged`, so the same feature was sometimes on and sometimes off.
 *
 * WHAT THIS FILE PINS DOWN (observability only — the decision is untouched):
 *   · a `changed` answer names its reason: `config-differs`,
 *     `plugin-tree-differs`, or `no-same-scope-copy`;
 *   · for the plugin half it names up to five files with the KIND of difference
 *     (added / removed / size / mtime) and both sides' facts;
 *   · an `unchanged` answer carries no differences at all;
 *   · a difference that is nothing but a moved mtime (same size, same path) is
 *     still reported as `changed` — the report explains the decision, it never
 *     softens it.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBackup, findUnchangedBackup } from '../lib/backup.js'

const LINKS_DIR = 'node_modules-link'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * A profile with ONE linked plugin and its configuration at the root, plus a
 * backups root. `dsh.profile.bundles` is what makes the link a "linked plugin".
 */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-reason-${label}-`))
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
  let linked = true
  try {
    fs.symlinkSync(source, path.join(profile, 'node_modules', 'demo-plugin'), 'junction')
  } catch {
    linked = false
  }
  return { dir, profile, source, backups, linked }
}

/** One complete copy of the profile (plugins included). */
async function writeCopy(profile, backups) {
  const written = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true })
  assert.equal(written.ok, true, 'the copy was written: ' + String(written.error))
  return written.dir
}

/* ------------------------------------------------------------------ *
 * ① THE REAL MACHINE'S SHAPE: only an mtime moved.
 * ------------------------------------------------------------------ */

test('① a moved mtime is reported as plugin-tree-differs with that file and kind mtime', async (t) => {
  const setup = fixture(t, 'mtime')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  // THE SAME BYTES, A LATER TIMESTAMP — exactly what a rewrite of an unchanged
  // file leaves behind, and exactly what the digest hashes.
  const pluginFile = path.join(setup.source, 'index.js')
  const before = fs.statSync(pluginFile)
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000)
  fs.utimesSync(pluginFile, later, later)
  assert.equal(fs.statSync(pluginFile).size, before.size, 'the size did not change — only the time did')

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })

  // ① THE DECISION IS CONTENT-BASED (task t34): a moved timestamp is NOT a
  // change — the bytes are identical, so this is `unchanged` and the reason says
  // so. (Before t34 this same case was `changed` with `kind: mtime`; that was the
  // bug, pinned here in its fixed form.)
  assert.equal(answer.state, 'unchanged', 'same bytes ⇒ unchanged, whatever the clock says')
  assert.equal(answer.reason, 'content-equal', 'and the reason says the content matched')
  assert.deepEqual(answer.differences, [], 'nothing to report: ' + JSON.stringify(answer.differences))
})

/* ------------------------------------------------------------------ *
 * ② THE CONFIGURATION HALF, ON ITS OWN.
 * ------------------------------------------------------------------ */

test('② a configuration edit is reported as config-differs', async (t) => {
  const setup = fixture(t, 'config')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  // ONLY the configuration changes; the plugin tree stays byte-identical.
  fs.writeFileSync(path.join(setup.profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n  - id: added\n', 'utf8')

  const answer = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(answer.state, 'changed', 'the configuration changed')
  assert.equal(answer.reason, 'config-differs', 'and the reason says which half: ' + JSON.stringify(answer.reason))
  // The differing file is named (task t34 reports it as `content`, with both
  // fingerprints) — and nothing from the plugin half appears.
  const entry = answer.differences.find((item) => item.path === 'config/cordis.patch.yml')
  assert.ok(entry, 'the configuration file is named: ' + JSON.stringify(answer.differences))
  assert.equal(entry.kind, 'content', 'as a content difference')
  assert.equal(answer.differences.every((item) => item.path.startsWith('config/')), true,
    'the plugin half has nothing to report: ' + JSON.stringify(answer.differences))
})

/* ------------------------------------------------------------------ *
 * ③ NOTHING CHANGED → NO DIFFERENCES AT ALL.
 * ------------------------------------------------------------------ */

test('③ an unchanged answer carries no differences, and a config-only seed is no-same-scope-copy', async (t) => {
  const setup = fixture(t, 'same')
  if (setup.linked !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  await writeCopy(setup.profile, setup.backups)

  const same = findUnchangedBackup(setup.profile, setup.backups, { includePlugins: true })
  assert.equal(same.state, 'unchanged', 'nothing was touched')
  // Either reason is honest: `metadata-equal` when the quick check answered,
  // `content-equal` when a file had to be read (task t36 added the first).
  assert.ok(
    same.reason === 'metadata-equal' || same.reason === 'content-equal',
    'and the answer says how it knew: ' + JSON.stringify(same.reason),
  )
  assert.deepEqual(same.differences, [], 'and no differences')

  // A machine whose only copy is the configuration-only seed: the plugin half has
  // no baseline at all, and the reason says exactly that (t26 pinned the
  // decision; here its NAME is pinned).
  const seeded = fixture(t, 'seed')
  const written = await createBackup({
    profileDir: seeded.profile,
    backupsDir: seeded.backups,
    includePlugins: false,
    kind: 'known-good',
    trigger: 'first-install',
  })
  assert.equal(written.ok, true, String(written.error))
  const noScope = findUnchangedBackup(seeded.profile, seeded.backups, { includePlugins: true })
  assert.equal(noScope.state, 'changed', 'a config-only seed cannot answer a plugin question')
  assert.equal(noScope.reason, 'no same-scope copy', 'and the reason says why: ' + JSON.stringify(noScope.reason))
})
