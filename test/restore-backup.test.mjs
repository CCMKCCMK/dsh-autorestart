/**
 * 回退 MUST BRING THE PLUGINS BACK (real machine, 2026-11-07 16:43).
 *
 * THE EXPERIMENT THAT FAILED: the copy `2026-11-07T08-43-22-616Z` held
 * `config/` + `node_modules-link/` + manifest — 847 files — and a probe comment
 * was really in it (`plugins/dsh-web-fetch-fallback/index.js`, 14,143 bytes,
 * sha1 21FEC7F7). The probe was then removed from the live file (14,067 bytes,
 * sha1 8108BA5D) and `POST /__dsh_autorestart/rollback-to` was called. The
 * receipt answered
 *
 *     ok: true, restored: [cordis.patch.yml, package.json, pnpm-lock.yaml]
 *
 * — THREE FILES, ZERO PLUGINS. The file was still 14,067 bytes afterwards: the
 * probe never came back.
 *
 * WHY: a slim copy keeps linked plugins under `node_modules-link/<name>`, and the
 * restore only ever looked at `backup/node_modules`. On that profile all seven
 * hand-written plugins are symbolic links into the workspace, so
 * `backup/node_modules` did not exist at all and the whole linked half of the
 * copy was skipped in silence.
 *
 * WHAT THIS FILE PINS DOWN:
 *   · a linked plugin is written back THROUGH its link, into the workspace
 *     directory behind it (the link itself survives — the install shape must not
 *     change during a rollback);
 *   · the restore only overwrites files the copy holds: `.git` and any file the
 *     copy does not know about stay exactly where they are (the target is a git
 *     checkout — deleting there would be a second, worse accident);
 *   · the receipt names what came back (`node_modules-link/<name>`), so the
 *     interface can show it;
 *   · a plugin installed as a REAL directory is restored the same way.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBackup, restoreBackup } from '../lib/backup.js'

const PROBE = '// RESTORE-PROBE-2026-11-07T08:43:08.486Z\n'
const LINKS_DIR = 'node_modules-link'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A temp root with `profile/`, `workspace/` (the link target) and `backups/`. */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-restore-${label}-`))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const profile = path.join(dir, 'profile')
  const workspace = path.join(dir, 'workspace')
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(backups, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  // THE BUNDLE LIST IS WHAT MAKES A LINK A "LINKED PLUGIN": the copy finds its
  // linked half through `dsh.profile.bundles`, not by guessing at junctions.
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['demo-plugin'] } } }, null, 2) + '\n',
    'utf8',
  )
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  return { dir, profile, workspace, backups }
}

/** Write a plugin directory carrying the probe; returns its path. */
function writePlugin(dir, probe) {
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo-plugin","version":"1.0.0"}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'index.js'), (probe === true ? PROBE : '') + 'export default 1\n', 'utf8')
  return dir
}

/** Link `profile/node_modules/<name>` at `target`; returns false when links are unsupported. */
function linkPlugin(profile, name, target) {
  try {
    fs.symlinkSync(target, path.join(profile, 'node_modules', name), 'junction')
    return true
  } catch {
    return false
  }
}

/** One complete copy of the profile, plugins included (the real shape). */
async function writeCopy(profile, backups) {
  const written = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true })
  assert.equal(written.ok, true, 'the copy was written: ' + String(written.error))
  return written.dir
}

/* ------------------------------------------------------------------ *
 * ① THE BUG: a linked plugin comes back through its link.
 * ------------------------------------------------------------------ */

test('① 回退 writes a linked plugin back into the directory behind its link', async (t) => {
  const setup = fixture(t, 'linked')
  const source = writePlugin(path.join(setup.workspace, 'demo-plugin'), true)
  if (linkPlugin(setup.profile, 'demo-plugin', source) !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const backup = await writeCopy(setup.profile, setup.backups)

  // THE PREMISE OF THE BUG: the copy holds the plugin under node_modules-link and
  // carries no node_modules at all (the real machine's shape).
  const copiedPlugin = path.join(backup, LINKS_DIR, 'demo-plugin', 'index.js')
  assert.equal(fs.existsSync(copiedPlugin), true, 'the copy holds the plugin')
  assert.equal(fs.readFileSync(copiedPlugin, 'utf8').includes('RESTORE-PROBE'), true, 'with the probe in it')
  assert.equal(fs.existsSync(path.join(backup, 'node_modules')), false, 'and no node_modules at all')

  // THE EXPERIMENT: the probe is removed from the live file, and a file the copy
  // never held appears next to it (a git checkout, not a scratch directory).
  fs.writeFileSync(path.join(source, 'index.js'), 'export default 1\n', 'utf8')
  fs.writeFileSync(path.join(source, 'only-live.md'), 'never backed up\n', 'utf8')

  const answer = restoreBackup({ backupDir: backup, profileDir: setup.profile })

  assert.equal(answer.ok, true, String(answer.error))
  assert.equal(answer.restored.includes(LINKS_DIR + '/demo-plugin'), true,
    'the receipt names the plugin: ' + JSON.stringify(answer.restored))
  assert.equal(answer.restored.includes('cordis.patch.yml'), true, 'and still names the configuration')

  // ① THE PROBE IS BACK, in the real directory behind the link.
  const liveText = fs.readFileSync(path.join(source, 'index.js'), 'utf8')
  assert.equal(liveText.includes('RESTORE-PROBE-2026-11-07T08:43:08.486Z'), true,
    'the probe came back: ' + JSON.stringify(liveText))

  // ② THE LINK IS STILL A LINK: a rollback must not turn the install into a copy.
  assert.equal(fs.lstatSync(path.join(setup.profile, 'node_modules', 'demo-plugin')).isSymbolicLink(), true,
    'the install shape survived the rollback')

  // ③ NOTHING WAS DELETED: `.git` and the file the copy never had are untouched.
  assert.equal(fs.existsSync(path.join(source, '.git', 'HEAD')), true, '.git is never deleted')
  assert.equal(fs.existsSync(path.join(source, 'only-live.md')), true, 'files the copy does not hold are left alone')
})

/* ------------------------------------------------------------------ *
 * ② THE OTHER SHAPE: a plugin installed as a REAL directory.
 * ------------------------------------------------------------------ */

test('② a plugin installed as a real directory is restored the same way', async (t) => {
  const setup = fixture(t, 'real')
  const installed = writePlugin(path.join(setup.profile, 'node_modules', 'demo-plugin'), true)

  // A copy built by hand: exactly the on-disk layout a slim copy has for a linked
  // plugin (the same layout this function has to understand).
  const backup = path.join(setup.backups, 'manual')
  fs.mkdirSync(path.join(backup, 'config'), { recursive: true })
  fs.writeFileSync(path.join(backup, 'config', 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  writePlugin(path.join(backup, LINKS_DIR, 'demo-plugin'), true)
  fs.writeFileSync(path.join(backup, 'manifest.json'), '{"includePlugins":true}\n', 'utf8')

  fs.writeFileSync(path.join(installed, 'index.js'), 'export default 1\n', 'utf8')
  fs.writeFileSync(path.join(installed, '.git', 'extra'), 'stays\n', 'utf8')

  const answer = restoreBackup({ backupDir: backup, profileDir: setup.profile })

  assert.equal(answer.ok, true, String(answer.error))
  assert.equal(answer.restored.includes(LINKS_DIR + '/demo-plugin'), true, JSON.stringify(answer.restored))
  assert.equal(
    fs.readFileSync(path.join(installed, 'index.js'), 'utf8').includes('RESTORE-PROBE'),
    true,
    'a real (non-linked) install is restored too',
  )
  assert.equal(fs.existsSync(path.join(installed, '.git', 'extra')), true, 'and its .git is left alone')
})

/* ------------------------------------------------------------------ *
 * ③ A PLUGIN MISSING FROM THE PROFILE IS NOT INVENTED, and the receipt
 *    still tells the truth about what it did.
 * ------------------------------------------------------------------ */

test('③ a copy of a plugin the profile no longer has is not restored into a new location', async (t) => {
  const setup = fixture(t, 'absent')
  const backup = path.join(setup.backups, 'manual')
  fs.mkdirSync(path.join(backup, 'config'), { recursive: true })
  fs.writeFileSync(path.join(backup, 'config', 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  writePlugin(path.join(backup, LINKS_DIR, 'gone-plugin'), true)

  const answer = restoreBackup({ backupDir: backup, profileDir: setup.profile })

  assert.equal(answer.ok, true, 'the configuration still came back: ' + String(answer.error))
  assert.equal(answer.restored.includes(LINKS_DIR + '/gone-plugin'), false,
    'nothing is claimed for a plugin the profile does not have: ' + JSON.stringify(answer.restored))
  assert.equal(fs.existsSync(path.join(setup.profile, 'node_modules', 'gone-plugin')), false,
    'and no directory was invented for it')
})
