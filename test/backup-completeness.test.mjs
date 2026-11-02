import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONFIG_DIR,
  CONFIG_FILES,
  LINKS_DIR,
  MANIFEST_NAME,
  PLUGINS_DIR,
  backupIsComplete,
  backupPluginDirIn,
  createBackup,
  listBackups,
  manifestPluginsOf,
} from '../lib/backup.js'
import { describePluginsForPage } from '../index.js'

// WHAT THIS FILE PINS (2026-11-01 incident).
//
// On the real machine 23 directories under the backups root held NOTHING but
// `node_modules-link/`: no `config/`, no `manifest.json`, no `meta.json`. They
// were listed like ordinary copies and compared against, so "the last backup" was
// a directory that could not restore anything.
//
// Two things are pinned here:
//   1. a pre-restart-shaped backup DOES carry the configuration and the manifest;
//   2. a directory without the configuration is NOT a complete backup — not by
//      the predicate, and not by the listing.

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-completeness-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

/**
 * A profile shaped like the real one: the three configuration files at the
 * PROFILE ROOT (that is where a DSH profile keeps them) plus one plugin installed
 * as a link, declared in `dsh.profile.bundles` so the link is one the profile
 * answers "yes" to.
 */
function makeProfile(root, { linkedName = 'dsh-linked' } = {}) {
  const profileDir = path.join(root, 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'host: 127.0.0.1\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'probe-profile',
    dsh: { profile: { bundles: [linkedName] } },
  }, null, 2), 'utf8')
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  const target = path.join(root, 'plugin-source')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'index.js'), 'export const plugin = 1\n', 'utf8')
  const pluginsDir = path.join(profileDir, 'node_modules')
  fs.mkdirSync(pluginsDir, { recursive: true })
  fs.symlinkSync(target, path.join(pluginsDir, linkedName), 'junction')
  return profileDir
}

test('a pre-restart-shaped backup carries the configuration AND the manifest', async (t) => {
  const root = tempRoot(t)
  const profileDir = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  // The shape `takePreRestartSnapshot` uses: slim, plugins included.
  const result = await createBackup({ profileDir, backupsDir })

  assert.equal(result.ok, true, 'the backup must succeed: ' + String(result.error))
  assert.ok(result.dir, 'a directory must be reported')
  for (const name of CONFIG_FILES) {
    const written = path.join(result.dir, CONFIG_DIR, name)
    assert.equal(fs.existsSync(written), true, 'missing ' + CONFIG_DIR + '/' + name)
  }
  assert.equal(fs.existsSync(path.join(result.dir, MANIFEST_NAME)), true, 'missing the manifest')
  // Every configuration file that the source had is listed in the manifest.
  for (const name of CONFIG_FILES) {
    assert.ok(
      Array.isArray(result.files) && result.files.includes(path.join(CONFIG_DIR, name)),
      'the manifest must list ' + name,
    )
  }
  assert.equal(backupIsComplete(result.dir), true)
})

test('a directory holding only node_modules-link is NOT a complete backup', async (t) => {
  const root = tempRoot(t)
  const backupsDir = path.join(root, 'backups')
  const gutted = path.join(backupsDir, '2026-11-01T09-38-21-855Z')
  fs.mkdirSync(path.join(gutted, 'node_modules-link', 'dsh-autorestart'), { recursive: true })
  fs.writeFileSync(path.join(gutted, 'node_modules-link', 'dsh-autorestart', 'index.js'), 'x\n', 'utf8')

  // This is the exact shape of the 23 real directories.
  assert.equal(fs.existsSync(path.join(gutted, CONFIG_DIR)), false)
  assert.equal(fs.existsSync(path.join(gutted, MANIFEST_NAME)), false)
  assert.equal(backupIsComplete(gutted), false, 'a gutted directory must not pass the predicate')
  assert.deepEqual(listBackups(backupsDir), [], 'and it must not be listed as a backup')
})

test('a manifest WITHOUT the configuration is not a complete backup either', async (t) => {
  const root = tempRoot(t)
  const dir = path.join(root, 'manifest-only')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ at: 1, files: [] }), 'utf8')

  // Having a manifest is not enough: the configuration is what makes a copy
  // restorable, and an empty `config/` is still empty.
  assert.equal(backupIsComplete(dir), false)
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true })
  assert.equal(backupIsComplete(dir), false, 'an EMPTY config directory proves nothing')
  fs.writeFileSync(path.join(dir, CONFIG_DIR, CONFIG_FILES[0]), 'host: x\n', 'utf8')
  assert.equal(backupIsComplete(dir), true, 'a real configuration file does')
})

test('every configuration file the source had is in the copy (the silent-skip guard)', async (t) => {
  const root = tempRoot(t)
  const profileDir = makeProfile(root)
  const backupsDir = path.join(root, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const result = await createBackup({ profileDir, backupsDir })
  assert.equal(result.ok, true, String(result.error))

  // The failure mode that gutted 23 real directories was a copy that silently
  // produced nothing; the manifest is where that shows up first.
  for (const name of CONFIG_FILES) {
    const onDisk = path.join(result.dir, CONFIG_DIR, name)
    assert.equal(fs.existsSync(onDisk) && fs.statSync(onDisk).isFile(), true,
      'config/' + name + ' must be a real file in the backup')
    assert.equal(fs.statSync(onDisk).size, fs.statSync(path.join(profileDir, name)).size,
      'config/' + name + ' must have the source size')
  }
  assert.equal(backupIsComplete(result.dir), true)
  // And the backup is reachable through the ordinary listing, i.e. a reader that
  // only knows `listBackups` sees a usable copy.
  const listed = listBackups(backupsDir)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].dir, result.dir)
})

/* ------------------------------------------------------------------ *
 * THE COPY'S OWN LEDGER (user report, 2026-11-02).
 *
 * Two false statements had to stop:
 *   1. `dsh-codekg`'s files WERE in the copy (`node_modules-link/dsh-codekg`)
 *      and the page still said "the backup has no copy of this plugin";
 *   2. "另有 20 个第三方插件（备份里只有名字和版本，重装即可）" implied the copy held
 *      something — it held nothing.
 * ------------------------------------------------------------------ */

/** A profile with linked and/or plainly installed plugins, for the ledger tests. */
function makeLedgerProfile({ linked = [], plain = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-profile-'))
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true })
  for (const name of CONFIG_FILES) fs.writeFileSync(path.join(root, CONFIG_DIR, name), 'x\n', 'utf8')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: Object.fromEntries(plain.map((entry) => [entry.name, entry.version || '1.0.0'])),
    dsh: { profile: { bundles: [...linked, ...plain].map((entry) => entry.name) } },
  }), 'utf8')
  const pluginsDir = path.join(root, PLUGINS_DIR)
  fs.mkdirSync(pluginsDir, { recursive: true })
  for (const entry of linked) {
    const source = path.join(root, 'src-' + entry.name)
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: entry.name, version: entry.version || '0.1.0' }), 'utf8')
    fs.writeFileSync(path.join(source, 'index.js'), 'export default {}\n', 'utf8')
    fs.symlinkSync(source, path.join(pluginsDir, entry.name), 'dir')
  }
  for (const entry of plain) {
    const dir = path.join(pluginsDir, entry.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: entry.name, version: entry.version || '1.0.0' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default {}\n', 'utf8')
  }
  return root
}

test('a copy records the plugins it really wrote, with their own version', async () => {
  const profileDir = makeLedgerProfile({ linked: [{ name: 'dsh-codekg', version: '0.4.2' }] })
  const backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-backups-'))
  const created = await createBackup({
    profileDir,
    backupsDir,
    includePlugins: true,
    now: Date.parse('2026-11-02T10:00:00Z'),
  })
  assert.equal(created.ok, true, `the backup must be taken: ${created.error}`)

  const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, MANIFEST_NAME), 'utf8'))
  assert.deepEqual(
    manifest.plugins.map((entry) => ({ name: entry.name, version: entry.version, install: entry.install })),
    [{ name: 'dsh-codekg', version: '0.4.2', install: 'link' }],
    'the copy says which plugin files it holds — name, VERSION OF THE COPY, and how it was installed',
  )
  assert.equal(
    fs.existsSync(path.join(created.dir, LINKS_DIR, 'dsh-codekg', 'index.js')),
    true,
    'the manifest and the disk agree',
  )
})

test('a copy without plugin files says so, instead of looking like it holds some', async () => {
  const profileDir = makeLedgerProfile({ linked: [{ name: 'dsh-codekg' }] })
  const backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-backups-'))
  const created = await createBackup({ profileDir, backupsDir, includePlugins: false })
  assert.equal(created.ok, true, `the config-only backup must be taken: ${created.error}`)
  const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, MANIFEST_NAME), 'utf8'))
  assert.deepEqual(manifest.plugins, [], 'a configuration-only copy holds no plugin files, and says so')
})

test('an older copy without the field is read by scanning, not by believing a count', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-old-'))
  fs.writeFileSync(path.join(backupDir, MANIFEST_NAME), JSON.stringify({ at: 1, includePlugins: true }), 'utf8')
  assert.equal(manifestPluginsOf(backupDir), null, 'no `plugins` field = "this copy is too old to say"')

  // THE REGRESSION: the files are in node_modules-link, and the LIVE install is
  // no longer a link. Picking the directory from the live shape said "no copy of
  // this plugin" while the copy was complete.
  fs.mkdirSync(path.join(backupDir, LINKS_DIR, 'dsh-codekg'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, LINKS_DIR, 'dsh-codekg', 'index.js'), 'x', 'utf8')
  assert.equal(
    backupPluginDirIn(backupDir, 'dsh-codekg', { linked: false }),
    path.join(backupDir, LINKS_DIR, 'dsh-codekg'),
    'the directory on disk wins over the live install shape',
  )
  assert.equal(
    backupPluginDirIn(backupDir, 'other-plugin', { linked: false }),
    path.join(backupDir, PLUGINS_DIR, 'other-plugin'),
    'nothing invented for a plugin that is not there',
  )
  fs.writeFileSync(path.join(backupDir, MANIFEST_NAME), JSON.stringify({
    at: 1,
    includePlugins: true,
    plugins: [{ name: 'listed-plugin', version: '1.0.0', install: 'link' }],
  }), 'utf8')
  assert.deepEqual(manifestPluginsOf(backupDir), [{ name: 'listed-plugin', version: '1.0.0', install: 'link', source: 'link' }])
})

test('the page tells "in the backup" from "not in the backup" — dsh-codekg really is in there', () => {
  const profileDir = makeLedgerProfile({ plain: [{ name: 'dsh-codekg' }] })
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-copy-'))
  const copy = path.join(backupDir, LINKS_DIR, 'dsh-codekg')
  fs.mkdirSync(copy, { recursive: true })
  fs.writeFileSync(path.join(copy, 'index.js'), 'export default {}\n', 'utf8')

  const [described] = describePluginsForPage(
    [{ name: 'dsh-codekg', status: 'missing', linked: false, version: '1.0.0' }],
    { profileDir, backupDir },
  )
  assert.notEqual(described.status, 'missing', `the page must NOT say "备份里没有": ${JSON.stringify(described)}`)
  assert.equal(described.install, 'npm', 'and it is a plugin from npm, so it is classified as such')
})

test('built-in, third-party and hand-written plugins are told apart', () => {
  const profileDir = makeLedgerProfile({ linked: [{ name: 'mine' }], plain: [{ name: 'from-npm' }] })
  const described = describePluginsForPage([
    { name: 'mine', status: 'same', linked: true },
    { name: 'from-npm', status: 'missing', linked: false },
    { name: 'ships-with-dsh', status: 'missing', linked: false },
  ], { profileDir, backupDir: '' })
  assert.deepEqual(described.map((entry) => entry.install), ['link', 'npm', 'builtin'])
})

// ---------------------------------------------------------------------------
// LOCAL PLUGINS vs THIRD-PARTY AS PUBLISHED (user decision, 2026-11-02).
//
// Two — and only two — reliable signals make a plugin "local", i.e. something
// that cannot be fetched again and therefore has to be in the copy:
//   1. the entry is a symbolic link (hand-written, install === 'link');
//   2. the entry is a real npm directory that CONTAINS .git (it was cloned or
//      re-inited and then edited here).
// Everything else is "as published": named in the manifest, never copied.
// ---------------------------------------------------------------------------

function makeInstalledPlugin(profileDir, name, version, { git = false } = {}) {
  const dir = path.join(profileDir, PLUGINS_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const ' + 'plugin = 1' + '\n', 'utf8')
  if (git === true) {
    fs.mkdirSync(path.join(dir, '.git', 'refs'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main' + '\n', 'utf8')
  }
  return dir
}

test('a link, a localized npm plugin and a published npm plugin are told apart', async (t) => {
  const root = tempRoot(t)
  const profileDir = makeProfile(root) // contains the link 'dsh-linked'
  const localizedDir = makeInstalledPlugin(profileDir, 'dsh-mine', '1.4.0', { git: true })
  const publishedDir = makeInstalledPlugin(profileDir, 'dsh-published', '2.0.0', { git: false })
  assert.ok(fs.existsSync(path.join(localizedDir, '.git')), 'the fixture really has a .git')
  assert.equal(fs.existsSync(path.join(publishedDir, '.git')), false)

  const backupsDir = path.join(root, 'backups')
  const result = await createBackup({ profileDir, backupsDir })
  assert.equal(result.ok, true, result.error || 'the backup failed')

  // The RAW manifest, not the normishing getter: `source` is the field this
  // change introduced, and the getter keeps only name / version / install.
  const rawManifest = JSON.parse(fs.readFileSync(path.join(result.dir, MANIFEST_NAME), 'utf8'))
  const plugins = rawManifest.plugins
  assert.ok(Array.isArray(plugins), 'the copy records its own plugin list')
  const byName = new Map(plugins.map((entry) => [entry.name, entry]))

  // 1) the hand-written link, marked as such
  assert.equal(byName.get('dsh-linked').source, 'link', 'a link is copied as a link')
  // 2) the localized npm plugin: in the copy, marked localized, own version
  assert.equal(byName.get('dsh-mine').source, 'localized', 'an npm plugin with .git is local')
  assert.equal(byName.get('dsh-mine').version, '1.4.0', 'the version of the COPY, not of the live install')
  assert.equal(
    fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'dsh-mine', 'index.js')),
    true,
    'its files are really inside the copy',
  )
  // the history is never copied: it is rebuildable
  assert.equal(
    fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'dsh-mine', '.git')),
    false,
    '.git is skipped (BACKUP_SKIP_NAMES)',
  )
  // 3) the published plugin: named, not copied
  assert.equal(byName.has('dsh-published'), false, 'a third-party plugin is not in the plugin list')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(result.dir, MANIFEST_NAME), 'utf8')).thirdParty,
    [{ name: 'dsh-published', version: '2.0.0' }],
    'it is named with its version instead',
  )
  assert.equal(
    fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'dsh-published')),
    false,
    'and its files are NOT in the copy',
  )

  // The counts travel with the answer, so the page does not have to re-read the manifest.
  assert.equal(result.localized, 1, 'one localized plugin was copied')
  assert.equal(result.thirdParty, 1, 'one published plugin was only named')
})

test('without .git an npm plugin is published-as-is even when its files differ', async (t) => {
  const root = tempRoot(t)
  const profileDir = makeProfile(root)
  makeInstalledPlugin(profileDir, 'dsh-upgraded', '3.1.0')
  const result = await createBackup({ profileDir, backupsDir: path.join(root, 'backups') })
  assert.equal(result.ok, true, result.error || '')
  assert.equal(result.localized, 0, 'a file difference is not evidence of a local edit')
  assert.equal(result.thirdParty, 1)
  assert.equal(
    fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'dsh-upgraded')),
    false,
    'so it is not copied',
  )
})

// ---------------------------------------------------------------------------
// THE NORMALISED PLUGIN LIST KEEPS ITS SOURCE (user decision, 2026-11-02).
//
// The page reads the normalised list, not the raw manifest (it cannot read
// files). If that projection drops source, the page cannot tell a link from a
// localized npm plugin any more, and the three-way wording becomes a lie.
// ---------------------------------------------------------------------------

test('manifestPluginsOf keeps source, so the page can tell the three kinds apart', async (t) => {
  const root = tempRoot(t)
  const profileDir = makeProfile(root) // contains the link 'dsh-linked'
  const dir = path.join(profileDir, PLUGINS_DIR, 'dsh-mine')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-mine', version: '1.4.0' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const mine = 1' + String.fromCharCode(10), 'utf8')

  const result = await createBackup({ profileDir, backupsDir: path.join(root, 'backups') })
  assert.equal(result.ok, true, result.error || '')

  const plugins = manifestPluginsOf(result.dir)
  assert.ok(Array.isArray(plugins), 'the list is there')
  const byName = new Map(plugins.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('dsh-linked').source, 'link', 'a link is projected as a link')
  assert.equal(byName.get('dsh-mine').source, 'localized', 'a localized npm plugin keeps its source')
  assert.equal(byName.get('dsh-mine').install, 'npm', 'and its install kind')
})
