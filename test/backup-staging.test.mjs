import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupStaleStaging,
  createBackup,
  listBackups,
  PLUGINS_DIR,
} from '../lib/backup.js'
import { locateBackupCopy, RECOVERY_MODES } from '../lib/plugin-recover.js'

/**
 * Self-contained fixtures: this file builds its own profile and backups directory
 * so it can be read (and run) on its own, without borrowing the older helpers.
 */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-staging-' + label + '-'))
}

function put(root, relPath, content) {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

/** A profile with configuration and one third-party plugin tree. */
function makeProfile({ withPlugins = true } = {}) {
  const dir = tempDir('profile')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-third-party': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-third-party'] } },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
  if (withPlugins === true) {
    put(dir, PLUGINS_DIR + '/dsh-third-party/package.json', '{"name":"dsh-third-party","version":"1.0.0"}')
    put(dir, PLUGINS_DIR + '/dsh-third-party/index.js', 'module.exports = 1;')
  }
  return dir
}

const now = (minute) => Date.UTC(2026, 10, 1, 1, minute, 0)

/** The real (published) backup directories — never the staging ones. */
function publishedDirs(backups) {
  try {
    return fs.readdirSync(backups, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.staging-') !== true)
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** The leftover staging directories. */
function stagingDirs(backups) {
  try {
    return fs.readdirSync(backups, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.staging-') === true)
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// ① slimBackup: true — only what cannot be fetched again
// ---------------------------------------------------------------------------

test('slimBackup: true copies the configuration and the link plugins, never node_modules', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    const result = await createBackup({ profileDir: profile, backupsDir: backups, slimBackup: true, now: now(1) })
    assert.equal(result.ok, true, 'the backup succeeded')

    assert.equal(fs.existsSync(path.join(result.dir, 'config')), true, 'config/ is there')
    assert.equal(fs.existsSync(path.join(result.dir, 'config', 'package.json')), true, 'with the profile manifest')
    assert.equal(fs.existsSync(path.join(result.dir, PLUGINS_DIR)), false, 'node_modules/ is NOT copied')
    // The manifest is written, and it describes the new, smaller scope.
    assert.equal(fs.existsSync(path.join(result.dir, 'manifest.json')), true, 'the manifest is written')
  } finally {
    cleanup(profile, backups)
  }
})

// ---------------------------------------------------------------------------
// ② slimBackup: false — the default, and it must stay exactly as it was
// ---------------------------------------------------------------------------

test('an explicit slimBackup: false still copies node_modules', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    const result = await createBackup({ profileDir: profile, backupsDir: backups, slimBackup: false, now: now(2) })
    assert.equal(result.ok, true)
    assert.equal(fs.existsSync(path.join(result.dir, PLUGINS_DIR)), true, 'node_modules/ is copied by default')
    assert.equal(
      fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'dsh-third-party', 'index.js')),
      true,
      'the third-party plugin is in the backup',
    )
  } finally {
    cleanup(profile, backups)
  }
})

// ---------------------------------------------------------------------------
// ③ a failed backup leaves ONLY staging; the published set never changes
// ---------------------------------------------------------------------------

test('a backup that cannot be published leaves no published directory behind', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    const first = await createBackup({ profileDir: profile, backupsDir: backups, now: now(3) })
    assert.equal(first.ok, true)
    const before = publishedDirs(backups)
    assert.equal(before.length, 1)

    // Make the publish step fail: renaming the staging directory into place.
    const originalRename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (String(from).includes('.staging-')) {
        throw Object.assign(new Error('simulated publish refusal'), { code: 'EACCES' })
      }
      return originalRename(from, to)
    }
    let second
    try {
      second = await createBackup({ profileDir: profile, backupsDir: backups, now: now(4) })
    } finally {
      fs.renameSync = originalRename
    }

    assert.equal(second.ok, false, 'the backup reports the failure')
    assert.equal(String(second.error).includes('could not be moved into place'), true, 'and says why')
    // THE PUBLISHED SET IS UNTOUCHED.
    assert.deepEqual(publishedDirs(backups), before, 'no new published directory appeared')
    // ...and the half-written staging is gone too, because the code removed it.
    assert.deepEqual(stagingDirs(backups), [], 'the staging directory was cleaned up')
  } finally {
    cleanup(profile, backups)
  }
})

// ---------------------------------------------------------------------------
// ④ leftover staging directories are removed, published ones are not
// ---------------------------------------------------------------------------

test('cleanupStaleStaging removes only .staging-* and never a real backup', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    const real = await createBackup({ profileDir: profile, backupsDir: backups, now: now(5) })
    assert.equal(real.ok, true)
    // A leftover from a crash mid-copy.
    fs.mkdirSync(path.join(backups, '.staging-2026-11-01T01-09-00-000Z'), { recursive: true })

    const answer = cleanupStaleStaging(backups)
    assert.deepEqual(answer.removed, ['.staging-2026-11-01T01-09-00-000Z'], 'the leftover is reported')
    assert.deepEqual(stagingDirs(backups), [], 'and it is gone')
    assert.deepEqual(publishedDirs(backups), [real.stamp], 'THE REAL BACKUP IS UNTOUCHED')
  } finally {
    cleanup(profile, backups)
  }
})

test('cleanupStaleStaging never throws, whatever it is handed', () => {
  for (const input of [undefined, null, '', '   ', '/definitely/not/here']) {
    let answer
    assert.doesNotThrow(() => {
      answer = cleanupStaleStaging(input)
    }, String(input) + ': must not throw')
    assert.deepEqual(answer.removed, [])
    assert.equal(typeof answer.reason, 'string')
  }
})

// ---------------------------------------------------------------------------
// ⑤ a self-check failure produces no published directory
// ---------------------------------------------------------------------------

test('a backup that fails its own integrity check is never published', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    // The measurement claims far more files than the copy can produce.
    const result = await createBackup({
      profileDir: profile,
      backupsDir: backups,
      // The file-count check only runs for a full backup, so the case uses one.
      slimBackup: false,
      now: now(6),
      measure: () => ({ files: 999, bytes: 999 }),
    })
    assert.equal(result.ok, false, 'it is not a backup')
    assert.equal(result.incomplete, true, 'and it says why')
    assert.deepEqual(publishedDirs(backups), [], 'NOTHING was published')
    assert.deepEqual(stagingDirs(backups), [], 'and no staging was left behind')
  } finally {
    cleanup(profile, backups)
  }
})

// ---------------------------------------------------------------------------
// ⑥ a slim backup answers "reinstall it", not "no backup"
// ---------------------------------------------------------------------------

test('a slim backup without the plugin says needs-online-reinstall, and keeps the old answer otherwise', () => {
  const backups = tempDir('slim')
  try {
    const backupDir = path.join(backups, '2026-11-01T01-00-00-000Z')
    fs.mkdirSync(path.join(backupDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ at: 1 }), 'utf8')

    const slim = locateBackupCopy({ backupDir, plugin: 'dsh-third-party', slim: true })
    assert.equal(slim.source, null)
    assert.equal(slim.mode, RECOVERY_MODES.NEEDS_ONLINE_REINSTALL, 'it says reinstall, not "no backup"')
    assert.equal(slim.reason.includes('reinstalled'), true, 'and says what to do')

    // A link plugin IS in a slim backup, so it is still restorable.
    fs.mkdirSync(path.join(backupDir, 'node_modules-link', 'dsh-hand-written'), { recursive: true })
    const linked = locateBackupCopy({ backupDir, plugin: 'dsh-hand-written', slim: true, isLinkInstall: true })
    assert.equal(linked.mode, RECOVERY_MODES.REPLACE_LINK, 'a hand-written plugin still comes back')

    // THE OLD ANSWER IS UNCHANGED when the caller does not say the backup is slim.
    const legacy = locateBackupCopy({ backupDir, plugin: 'dsh-third-party' })
    assert.equal(legacy.mode, RECOVERY_MODES.NO_BACKUP, 'the default path answers exactly as before')
  } finally {
    cleanup(backups)
  }
})

// ---------------------------------------------------------------------------
// staging is invisible to the published listing
// ---------------------------------------------------------------------------

test('a published backup is listed and its staging name is not', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    const result = await createBackup({ profileDir: profile, backupsDir: backups, now: now(7) })
    assert.equal(result.ok, true)
    const listed = listBackups(backups).map((entry) => entry.name)
    assert.deepEqual(listed, [result.stamp], 'the backup is listed under its real name')
    assert.equal(listed.some((name) => name.startsWith('.staging-')), false, 'no staging name is ever listed')
    assert.equal(fs.existsSync(result.dir), true)
    assert.equal(path.basename(result.dir), result.stamp, 'the returned directory is the published one')
  } finally {
    cleanup(profile, backups)
  }
})

test('the DEFAULT is a slim backup: no node_modules unless asked for', async () => {
  const profile = makeProfile()
  const backups = tempDir('backups')
  try {
    // No slimBackup flag at all — this is what a real restart does.
    const result = await createBackup({ profileDir: profile, backupsDir: backups, now: now(8) })
    assert.equal(result.ok, true)
    assert.equal(
      fs.existsSync(path.join(result.dir, PLUGINS_DIR)),
      false,
      'THE DEFAULT MUST NOT COPY node_modules: third-party plugins are reinstalled from the lock file',
    )
    assert.equal(fs.existsSync(path.join(result.dir, 'config')), true, 'the configuration is what a backup is for')
  } finally {
    cleanup(profile, backups)
  }
})
