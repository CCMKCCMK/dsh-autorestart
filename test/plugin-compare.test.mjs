import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CHANGE_KIND,
  comparePlugin,
  inventory,
  listInstalledPlugins,
  MAX_CHANGES,
  PLUGIN_STATUS,
  pluginDetail,
  walkFiles,
} from '../lib/plugin-compare.js'

/** A throwaway directory that is removed afterwards. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-compare-' + label + '-'))
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

/** Write a file, creating its directory. */
function put(root, relPath, content) {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return full
}

/** A plugin tree: `{ 'index.js': 'aaa', 'lib/x.js': 'bb' }`. */
function putTree(root, files) {
  for (const [relPath, content] of Object.entries(files)) put(root, relPath, content)
}

// ---------------------------------------------------------------------------
// listInstalledPlugins
// ---------------------------------------------------------------------------

test('listInstalledPlugins reads dependencies AND enabled bundles, and marks what is not there', () => {
  const { dir, cleanup } = tempDir('list')
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-a': '1.0.0', 'dsh-b': '2.0.0' },
      dsh: { profile: { bundles: ['dsh-a', { name: 'dsh-c' }] } },
    }), 'utf8')
    put(dir, 'node_modules/dsh-a/package.json', JSON.stringify({ name: 'dsh-a', version: '1.0.0' }))
    put(dir, 'node_modules/dsh-c/package.json', JSON.stringify({ name: 'dsh-c', version: '3.1.4' }))
    // dsh-b is a dependency but has no directory.

    const listed = listInstalledPlugins(dir)
    assert.equal(listed.reason, '')
    const byName = Object.fromEntries(listed.plugins.map((plugin) => [plugin.name, plugin]))

    assert.deepEqual(Object.keys(byName).sort(), ['dsh-a', 'dsh-b', 'dsh-c'], 'deps and bundles are unioned')
    assert.equal(byName['dsh-a'].installed, true)
    assert.equal(byName['dsh-a'].version, '1.0.0')
    assert.equal(byName['dsh-a'].enabled, true, 'a dependency listed in bundles is enabled')

    assert.equal(byName['dsh-b'].installed, false, 'no directory = not installed')
    assert.equal(byName['dsh-b'].version, null)

    assert.equal(byName['dsh-c'].installed, true)
    assert.equal(byName['dsh-c'].version, '3.1.4')
    assert.equal(byName['dsh-c'].enabled, true, 'the `{ name }` spelling of a bundle counts too')
  } finally {
    cleanup()
  }
})

test('listInstalledPlugins never throws: a missing or unreadable profile is an empty list with a reason', () => {
  for (const input of [undefined, null, '', '   ', '/definitely/not/here']) {
    let listed
    assert.doesNotThrow(() => {
      listed = listInstalledPlugins(input)
    }, String(input) + ': must not throw')
    assert.deepEqual(listed.plugins, [])
    assert.equal(typeof listed.reason, 'string')
    assert.equal(listed.reason.length > 0, true, 'it says why')
  }
})

// ---------------------------------------------------------------------------
// comparePlugin — the four statuses the settings page renders
// ---------------------------------------------------------------------------

test('comparePlugin: same — identical paths and sizes', () => {
  const live = tempDir('same-live')
  const backup = tempDir('same-backup')
  try {
    const tree = { 'package.json': '{"name":"p"}', 'index.js': 'aaaa', 'lib/deep/x.js': 'bb' }
    putTree(live.dir, tree)
    putTree(backup.dir, tree)

    const compared = comparePlugin({ liveDir: live.dir, backupDir: backup.dir })
    assert.equal(compared.status, PLUGIN_STATUS.SAME)
    assert.deepEqual(compared.changes, [])
    assert.equal(compared.changeCount, 0)
    assert.equal(compared.liveCount, 3)
    assert.equal(compared.backupCount, 3)
    assert.equal(compared.truncated, false)
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

test('comparePlugin: different — added, removed and modified are told apart', () => {
  const live = tempDir('diff-live')
  const backup = tempDir('diff-backup')
  try {
    putTree(live.dir, {
      'package.json': '{"name":"p"}',   // same
      'index.js': 'aaaaaa',             // backup has 'aa' -> modified
      'extra.js': 'zz',                 // backup has none -> added
    })
    putTree(backup.dir, {
      'package.json': '{"name":"p"}',
      'index.js': 'aa',
      'gone.js': 'qq',                  // live has none -> removed
    })

    const compared = comparePlugin({ liveDir: live.dir, backupDir: backup.dir })
    assert.equal(compared.status, PLUGIN_STATUS.DIFFERENT)
    assert.equal(compared.changeCount, 3)
    const byPath = Object.fromEntries(compared.changes.map((change) => [change.path, change.kind]))
    assert.equal(byPath['extra.js'], CHANGE_KIND.ADDED)
    assert.equal(byPath['gone.js'], CHANGE_KIND.REMOVED)
    assert.equal(byPath['index.js'], CHANGE_KIND.MODIFIED)
    assert.equal(byPath['package.json'], undefined, 'an unchanged file is not a change')
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

test('comparePlugin: missing — the backup has no copy of this plugin', () => {
  const live = tempDir('missing-live')
  const backup = tempDir('missing-backup')
  try {
    putTree(live.dir, { 'index.js': 'aa' })
    const compared = comparePlugin({ liveDir: live.dir, backupDir: path.join(backup.dir, 'absent') })
    assert.equal(compared.status, PLUGIN_STATUS.MISSING)
    assert.equal(compared.reason.includes('no copy'), true)
    assert.deepEqual(compared.changes, [])
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

test('comparePlugin: not-installed — the profile has no directory for it', () => {
  const live = tempDir('notinst-live')
  const backup = tempDir('notinst-backup')
  try {
    putTree(backup.dir, { 'index.js': 'aa' })
    const compared = comparePlugin({ liveDir: path.join(live.dir, 'absent'), backupDir: backup.dir })
    assert.equal(compared.status, PLUGIN_STATUS.NOT_INSTALLED)
    assert.equal(compared.reason.includes('no directory'), true)
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

test('comparePlugin never throws, whatever it is handed', () => {
  const cases = [undefined, null, {}, { liveDir: 42 }, { liveDir: '', backupDir: '' }, { liveDir: '/nope', backupDir: '/nope' }]
  for (const input of cases) {
    let compared
    assert.doesNotThrow(() => {
      compared = comparePlugin(input)
    }, JSON.stringify(input) + ': must not throw')
    assert.equal(typeof compared.status, 'string')
    assert.equal(Array.isArray(compared.changes), true)
  }
})

// ---------------------------------------------------------------------------
// Performance red line: no hashing, and every walk is bounded
// ---------------------------------------------------------------------------

test('the comparison is path-set + size only: same size with different bytes is NOT a change', () => {
  const live = tempDir('size-live')
  const backup = tempDir('size-backup')
  try {
    // Same length, different content: a size-based comparison calls this the same,
    // and that is the documented trade-off (no hashing on a 295 MB backup).
    put(live.dir, 'index.js', 'aaaa')
    put(backup.dir, 'index.js', 'bbbb')
    const compared = comparePlugin({ liveDir: live.dir, backupDir: backup.dir })
    assert.equal(compared.status, PLUGIN_STATUS.SAME)
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

test('a walk that hits its limit says so instead of pretending to be complete', () => {
  const { dir, cleanup } = tempDir('bounded')
  try {
    for (let index = 0; index < 12; index += 1) put(dir, 'f' + index + '.js', 'x')
    const walked = walkFiles(dir, { maxFiles: 5 })
    assert.equal(walked.files.size, 5)
    assert.equal(walked.truncated, true, 'a short answer is flagged')
  } finally {
    cleanup()
  }
})

test('the change rows are capped but the count stays exact', () => {
  const live = tempDir('cap-live')
  const backup = tempDir('cap-backup')
  try {
    for (let index = 0; index < MAX_CHANGES + 25; index += 1) put(live.dir, 'f' + index + '.js', 'x')
    const compared = comparePlugin({ liveDir: live.dir, backupDir: backup.dir })
    assert.equal(compared.status, PLUGIN_STATUS.DIFFERENT)
    assert.equal(compared.changeCount, MAX_CHANGES + 25, 'the count is the real number')
    assert.equal(compared.changes.length, MAX_CHANGES, 'the rows are capped')
  } finally {
    live.cleanup()
    backup.cleanup()
  }
})

// ---------------------------------------------------------------------------
// inventory — the settings page's list
// ---------------------------------------------------------------------------

/** A profile plus one backup holding `backupFiles` per plugin. */
function makeProfileAndBackup({ plugins, backupPlugins, backupName = '20261101T024043Z', meta = true }) {
  const profile = tempDir('inv-profile')
  const backups = tempDir('inv-backups')
  fs.writeFileSync(path.join(profile.dir, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(plugins.map((plugin) => [plugin, '1.0.0'])),
    dsh: { profile: { bundles: plugins } },
  }), 'utf8')
  for (const plugin of plugins) {
    put(profile.dir, 'node_modules/' + plugin + '/package.json', JSON.stringify({ name: plugin, version: '1.0.0' }))
    put(profile.dir, 'node_modules/' + plugin + '/index.js', 'aaaa')
  }
  const backupDir = path.join(backups.dir, backupName)
  fs.mkdirSync(backupDir, { recursive: true })
  if (meta === true) fs.writeFileSync(path.join(backupDir, 'meta.json'), JSON.stringify({ at: 1761000000000, kind: 'known-good' }), 'utf8')
  for (const [plugin, files] of Object.entries(backupPlugins)) {
    for (const [relPath, content] of Object.entries(files)) put(backupDir, 'node_modules/' + plugin + '/' + relPath, content)
  }
  return {
    profile,
    backups,
    backupDir,
    cleanup() {
      profile.cleanup()
      backups.cleanup()
    },
  }
}

test('inventory measures every plugin against the NEWEST backup', () => {
  const made = makeProfileAndBackup({
    plugins: ['dsh-same', 'dsh-diff', 'dsh-absent'],
    backupPlugins: {
      'dsh-same': { 'package.json': '{"name":"dsh-same","version":"1.0.0"}', 'index.js': 'aaaa' },
      // dsh-diff: same file name, different size -> different
      'dsh-diff': { 'package.json': '{"name":"dsh-diff","version":"1.0.0"}', 'index.js': 'a' },
      // dsh-absent: never in the backup -> missing
    },
  })
  try {
    const inv = inventory({ profileDir: made.profile.dir, backupsDir: made.backups.dir, now: 1761000000000 })
    assert.equal(inv.backupAt, 1761000000000, 'the backup timestamp comes from its meta')
    assert.equal(inv.backupName, '20261101T024043Z')
    const byName = Object.fromEntries(inv.plugins.map((plugin) => [plugin.name, plugin]))

    assert.equal(byName['dsh-same'].status, PLUGIN_STATUS.SAME)
    assert.equal(byName['dsh-same'].changeCount, 0)
    assert.equal(byName['dsh-same'].backupVersion, '1.0.0')

    assert.equal(byName['dsh-diff'].status, PLUGIN_STATUS.DIFFERENT)
    assert.equal(byName['dsh-diff'].changeCount, 1)

    assert.equal(byName['dsh-absent'].status, PLUGIN_STATUS.MISSING)
    assert.equal(byName['dsh-absent'].backupVersion, null)
  } finally {
    made.cleanup()
  }
})

test('inventory with NO backup degrades honestly instead of throwing', () => {
  const made = makeProfileAndBackup({
    plugins: ['dsh-a'],
    backupPlugins: {},
    meta: false,
  })
  try {
    // An empty backups directory is the fresh-machine case.
    fs.rmSync(made.backupDir, { recursive: true, force: true })
    let inv
    assert.doesNotThrow(() => {
      inv = inventory({ profileDir: made.profile.dir, backupsDir: made.backups.dir })
    })
    assert.equal(inv.backupAt, null, 'no backup means no timestamp')
    assert.equal(inv.backupDir, null)
    assert.equal(inv.reason.includes('no backup'), true, 'and it says why')
    assert.equal(inv.plugins.length, 1, 'the installed plugins are still listed')
    assert.equal(inv.plugins[0].name, 'dsh-a')
    assert.equal(inv.plugins[0].status, PLUGIN_STATUS.UNKNOWN, 'no baseline = no verdict')
    assert.equal(inv.plugins[0].version, '1.0.0')
  } finally {
    made.cleanup()
  }
})

test('inventory never throws, whatever it is handed', () => {
  for (const input of [undefined, null, {}, { profileDir: 42 }, { profileDir: '/nope', backupsDir: '/nope' }]) {
    let inv
    assert.doesNotThrow(() => {
      inv = inventory(input)
    }, JSON.stringify(input) + ': must not throw')
    assert.equal(Array.isArray(inv.plugins), true)
    assert.equal(typeof inv.reason, 'string')
  }
})

// ---------------------------------------------------------------------------
// pluginDetail — the per-plugin drill-down
// ---------------------------------------------------------------------------

test('pluginDetail returns the change rows for one plugin', () => {
  const made = makeProfileAndBackup({
    plugins: ['dsh-x'],
    backupPlugins: { 'dsh-x': { 'package.json': '{"name":"dsh-x","version":"1.0.0"}', 'index.js': 'a' } },
  })
  try {
    const detail = pluginDetail({ profileDir: made.profile.dir, backupsDir: made.backups.dir, plugin: 'dsh-x' })
    assert.equal(detail.plugin, 'dsh-x')
    assert.equal(detail.status, PLUGIN_STATUS.DIFFERENT)
    assert.equal(detail.changeCount, 1)
    assert.equal(detail.changes[0].path, 'index.js')
    assert.equal(detail.changes[0].kind, CHANGE_KIND.MODIFIED)
  } finally {
    made.cleanup()
  }
})

test('pluginDetail without a name, or without a backup, still answers', () => {
  const made = makeProfileAndBackup({ plugins: ['dsh-x'], backupPlugins: {}, meta: false })
  try {
    fs.rmSync(made.backupDir, { recursive: true, force: true })
    const unnamed = pluginDetail({ profileDir: made.profile.dir, backupsDir: made.backups.dir, plugin: '  ' })
    assert.equal(unnamed.status, PLUGIN_STATUS.UNKNOWN)
    assert.equal(unnamed.reason.includes('no plugin name'), true)

    const noBackup = pluginDetail({ profileDir: made.profile.dir, backupsDir: made.backups.dir, plugin: 'dsh-x' })
    assert.equal(noBackup.status, PLUGIN_STATUS.UNKNOWN)
    assert.equal(noBackup.reason.includes('no backup'), true)
  } finally {
    made.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A DIRECTORY WITHOUT A TIMESTAMP IS NOT A BACKUP (2026-11-01)
//
// The name and the mtime are not enough: the half-written 06-06-50 directory had
// a perfect-looking name and the newest mtime of all, so it was picked as "the
// newest backup" and used as the baseline for the whole comparison.
// ---------------------------------------------------------------------------

test('inventory ignores a newer-looking directory that has no meta', () => {
  const made = makeProfileAndBackup({
    plugins: ['dsh-x'],
    backupPlugins: { 'dsh-x': { 'package.json': '{"name":"dsh-x","version":"1.0.0"}', 'index.js': 'aaaa' } },
    // A is the real one, and it is OLDER by name.
    backupName: '2026-11-01T06-03-33-796Z',
  })
  try {
    // B looks newer and has the newest mtime — but it was never finished.
    const half = path.join(made.backups.dir, '2026-11-01T06-06-50-945Z')
    fs.mkdirSync(path.join(half, 'node_modules-link'), { recursive: true })

    const inv = inventory({ profileDir: made.profile.dir, backupsDir: made.backups.dir })
    assert.equal(inv.backupName, '2026-11-01T06-03-33-796Z', 'the finished backup is the baseline')
    assert.equal(inv.backupDir, made.backupDir, 'and it is the one with meta.json')
    assert.notEqual(inv.backupDir, half, 'the unfinished directory is never chosen')
    // NOT DELETED, NOT MOVED: it simply does not compete.
    assert.equal(fs.existsSync(half), true, 'the unfinished directory is still on disk')
    assert.equal(inv.plugins[0].status, 'same', 'the comparison ran against the real backup')
  } finally {
    made.cleanup()
  }
})

test('a backup whose meta has no usable timestamp does not compete either', () => {
  const made = makeProfileAndBackup({
    plugins: ['dsh-x'],
    backupPlugins: { 'dsh-x': { 'package.json': '{"name":"dsh-x","version":"1.0.0"}', 'index.js': 'aaaa' } },
    backupName: '2026-11-01T06-03-33-796Z',
  })
  try {
    const odd = path.join(made.backups.dir, '2026-11-01T07-00-00-000Z')
    fs.mkdirSync(odd, { recursive: true })
    fs.writeFileSync(path.join(odd, 'meta.json'), JSON.stringify({ at: 'not-a-number' }), 'utf8')

    const inv = inventory({ profileDir: made.profile.dir, backupsDir: made.backups.dir })
    assert.equal(inv.backupName, '2026-11-01T06-03-33-796Z', 'a meta without a finite at is not a timestamp')
    assert.equal(fs.existsSync(odd), true, 'and the directory is still there')
  } finally {
    made.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A LINKED (hand-written) PLUGIN IS INSTALLED, NOT MISSING.
//
// Field incident 2026-11-01: \`dsh plugin add ./my-plugin\` writes a link into
// node_modules-link, so a plugin that only exists there was reported
// \`status: 'missing', backupVersion: null\`. The panel reads \`linked\` to decide
// whether to offer "restore from backup", so the wrong status silently removed
// the only button that could have fixed the plugin. Data that looks cosmetic
// was load-bearing.
// ---------------------------------------------------------------------------

/**
 * Build a profile with one LINKED plugin, the way a real profile has it.
 *
 * The real shape (verified on the machine, 2026-11-01):
 *   profile/node_modules/<name>  -> a SYMBOLIC LINK to the workspace
 *   profile/node_modules-link/   -> does not exist at all
 *   backups/<stamp>/node_modules-link/<name>/package.json  -> the real files
 *
 * Getting this wrong in the fixture is how the first attempt "passed" while the
 * machine still reported every linked plugin as missing.
 */
function linkFixture({ liveVersion = '1.10.3', backupVersion = '1.10.3', backupHasIt = true, changeLive = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-link-'))
  const profile = path.join(root, 'profile')
  const backups = path.join(root, 'backups')
  const backup = path.join(backups, '2026-11-01T00-00-00-000Z')
  // The plugin's real home: a directory OUTSIDE the profile, like the workspace.
  const workspace = path.join(root, 'workspace', 'dsh-codekg')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'dsh-codekg', version: liveVersion }))
  fs.writeFileSync(path.join(workspace, 'index.js'), 'export const a = 1\n')
  // And the profile holds only a SYMLINK to it.
  const nm = path.join(profile, 'node_modules')
  fs.mkdirSync(nm, { recursive: true })
  fs.symlinkSync(workspace, path.join(nm, 'dsh-codekg'), 'junction')
  // The BACKUP holds real files under node_modules-link.
  fs.mkdirSync(backup, { recursive: true })
  fs.writeFileSync(path.join(backup, 'meta.json'), JSON.stringify({ at: 1767225600000 }))
  if (backupHasIt) {
    const backupDir = path.join(backup, 'node_modules-link', 'dsh-codekg')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'package.json'), JSON.stringify({ name: 'dsh-codekg', version: backupVersion }))
    fs.writeFileSync(path.join(backupDir, 'index.js'), changeLive ? 'export const a = 2\n' : 'export const a = 1\n')
  }
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { 'dsh-codekg': 'link:../dsh-codekg' },
    dsh: { profile: { bundles: ['dsh-codekg'] } },
  }))
  return { root, profile, backups, workspace, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('a LINKED plugin is listed as installed with linked: true', () => {
  const fixture = linkFixture()
  try {
    const listed = listInstalledPlugins(fixture.profile)
    const row = listed.plugins.find((plugin) => plugin.name === 'dsh-codekg')
    assert.ok(row, 'the plugin is listed at all')
    assert.equal(row.installed, true, 'node_modules-link counts as installed')
    assert.equal(row.linked, true, 'and it is marked as a link install')
    assert.equal(row.version, '1.10.3', 'the version comes from the link directory manifest')
    assert.equal(fs.lstatSync(row.dir).isSymbolicLink(), true, 'the live path really is a symlink')
    assert.equal(path.basename(path.dirname(row.dir)), 'node_modules', 'and it lives in node_modules')
  } finally { fixture.cleanup() }
})

test('an ordinary npm plugin is linked: false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npm-'))
  try {
    const profile = path.join(root, 'profile')
    const dir = path.join(profile, 'node_modules', 'plain-plugin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'plain-plugin', version: '2.0.0' }))
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      name: 'profile',
      dependencies: { 'plain-plugin': '^2.0.0' },
      dsh: { profile: { bundles: [] } },
    }))
    const row = listInstalledPlugins(profile).plugins.find((plugin) => plugin.name === 'plain-plugin')
    assert.equal(fs.lstatSync(row.dir).isSymbolicLink(), false, 'an npm install is a REAL directory')
    assert.equal(row.linked, false, 'so it is not a link')
    assert.equal(row.installed, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a linked plugin that matches its backup is same, never missing', () => {
  const fixture = linkFixture()
  try {
    const result = inventory({ profileDir: fixture.profile, backupsDir: fixture.backups })
    const row = result.plugins.find((plugin) => plugin.name === 'dsh-codekg')
    assert.notEqual(row.status, 'missing', 'the backup HAS a copy under node_modules-link')
    assert.equal(row.status, 'same', 'identical files compare as same')
    assert.equal(row.linked, true)
    assert.equal(row.backupVersion, '1.10.3', 'the backup version is read from the link directory')
    assert.equal(row.version, '1.10.3')
  } finally { fixture.cleanup() }
})

test('a linked plugin whose files differ is different, and still reports both versions', () => {
  const fixture = linkFixture({ changeLive: true, backupVersion: '1.9.0' })
  try {
    const row = inventory({ profileDir: fixture.profile, backupsDir: fixture.backups })
      .plugins.find((plugin) => plugin.name === 'dsh-codekg')
    assert.equal(row.status, 'different', 'one file changed')
    assert.equal(row.linked, true)
    assert.equal(row.version, '1.10.3', 'the LIVE version')
    assert.equal(row.backupVersion, '1.9.0', 'the BACKUP version - they are allowed to differ')
  } finally { fixture.cleanup() }
})

test('a linked plugin the backup never had is still missing, with a null backup version', () => {
  const fixture = linkFixture({ backupHasIt: false })
  try {
    const row = inventory({ profileDir: fixture.profile, backupsDir: fixture.backups })
      .plugins.find((plugin) => plugin.name === 'dsh-codekg')
    assert.equal(row.status, 'missing', 'the backup really has no copy - this is the honest case')
    assert.equal(row.backupVersion, null, 'and no version is invented')
    assert.equal(row.linked, true, 'it is still our own plugin, so a reinstall hint is wrong')
  } finally { fixture.cleanup() }
})

test('no backup at all still carries linked, so the panel can classify the row', () => {
  const fixture = linkFixture()
  try {
    const row = inventory({ profileDir: fixture.profile, backupsDir: path.join(fixture.root, 'nope') })
      .plugins.find((plugin) => plugin.name === 'dsh-codekg')
    assert.equal(row.status, 'unknown')
    assert.equal(row.linked, true)
    assert.equal(row.backupVersion, null)
  } finally { fixture.cleanup() }
})
