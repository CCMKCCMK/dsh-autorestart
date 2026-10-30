/**
 * Pre-restart backup + rollback primitives.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backupsRoot,
  CONFIG_DIR,
  collectLinkedPlugins,
  createBackup,
  decideLinkRestore,
  enabledBundlesOf,
  LINK_ACTIONS,
  LINKS_DIR,
  listBackups,
  MANIFEST_NAME,
  PLUGINS_DIR,
  pruneBackups,
  readManifest,
  readRollbackReport,
  ROLLBACK_REPORT_NAME,
  restoreBackup,
  clearRollbackReport,
} from '../lib/backup.js';

/** A profile-looking tree and an empty backups directory. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-backup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js'), 'export default 1\n', 'utf8');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, profile, storage, backups: backupsRoot(storage) };
}

test('a backup copies the configuration files and the plugin tree', async (t) => {
  const { profile, storage, backups } = fixture(t);
  const first = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 1_000 });

  assert.equal(first.ok, true);
  assert.equal(first.includePlugins, true);
  assert.ok(first.dir && first.dir.startsWith(backups));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'cordis.patch.yml')));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'package.json')));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'pnpm-lock.yaml')));
  assert.ok(fs.existsSync(path.join(first.dir, PLUGINS_DIR, 'demo-plugin', 'lib', 'index.js')));

  const manifest = readManifest(first.dir);
  assert.equal(manifest.includePlugins, true);
  assert.equal(manifest.at, 1_000);
  assert.ok(manifest.files.includes(path.join(CONFIG_DIR, 'cordis.patch.yml')));
  assert.ok(manifest.files.includes('node_modules'));
  assert.ok(manifest.bytes > 0);
  assert.ok(fs.existsSync(path.join(storage, 'backups', first.stamp, MANIFEST_NAME)));
});

test('includePlugins=false keeps the backup to the configuration files', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: false, now: 2_000 });

  assert.equal(backup.ok, true);
  assert.equal(backup.includePlugins, false);
  assert.equal(fs.existsSync(path.join(backup.dir, PLUGINS_DIR)), false);
  assert.ok(fs.existsSync(path.join(backup.dir, CONFIG_DIR, 'cordis.patch.yml')));
  assert.equal(readManifest(backup.dir).includePlugins, false);
});

test('only the newest maxBackups snapshots are kept', async (t) => {
  const { profile, backups } = fixture(t);
  const stamps = [3_000, 4_000, 5_000, 6_000];
  for (const now of stamps) {
    const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 2, now });
    assert.equal(backup.ok, true);
  }

  const left = listBackups(backups).map((entry) => entry.name);
  assert.equal(left.length, 2, 'exactly two backups survive');
  const keptStamps = left.map((name) => {
    // The directory name is the ISO stamp with ':' and '.' replaced.
    return Date.parse(name.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
  }).sort((a, b) => a - b);
  assert.deepEqual(keptStamps, [5_000, 6_000], 'the two newest snapshots are the ones kept');
});

test('pruneBackups removes only what exceeds the limit', (t) => {
  const { backups } = fixture(t);
  for (const name of ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z']) {
    fs.mkdirSync(path.join(backups, name), { recursive: true });
  }
  const removed = pruneBackups(backups, 2);
  assert.deepEqual(removed, ['2026-01-01T00-00-00-000Z']);
  assert.deepEqual(listBackups(backups).map((entry) => entry.name), [
    '2026-01-03T00-00-00-000Z',
    '2026-01-02T00-00-00-000Z',
  ]);
});

test('restoreBackup puts the snapshot back over the live profile', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 7_000 });
  assert.equal(backup.ok, true);

  // Break the live profile the way a bad edit would.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8');
  fs.rmSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js'));

  const restored = restoreBackup({ backupDir: backup.dir, profileDir: profile });
  assert.equal(restored.ok, true);
  assert.ok(restored.restored.includes('cordis.patch.yml'));
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: demo\n');
  assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js')));
});

test('createBackup reports a missing profile instead of throwing', async () => {
  const result = await createBackup({ profileDir: path.join(os.tmpdir(), 'dsh-ar-does-not-exist-xyz'), backupsDir: path.join(os.tmpdir(), 'dsh-ar-b') });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /does not exist/);
});

test('the rollback report is read from disk, tolerating a BOM', (t) => {
  const { storage } = fixture(t);
  assert.equal(readRollbackReport(storage), null, 'no report yet');

  const report = {
    ok: false,
    at: '2026-10-25T12:00:00.000Z',
    waitedMs: 90000,
    rolledBack: true,
    backupDir: 'C:/x/backups/2026',
    crashLog: 'crash-2026-10-25.log',
    crashTail: 'phase: startup',
  };
  // Write it the way Windows PowerShell 5.1 would: with a BOM.
  fs.writeFileSync(path.join(storage, ROLLBACK_REPORT_NAME), '\uFEFF' + JSON.stringify(report), 'utf8');

  const parsed = readRollbackReport(storage);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rolledBack, true);
  assert.equal(parsed.crashTail, 'phase: startup');

  assert.equal(clearRollbackReport(storage), true);
  assert.equal(readRollbackReport(storage), null);
});

// ---------------------------------------------------------------------------
// THE LINKED PLUGINS (user decision, 2026-10-30).
//
// Five plugins on this machine are installed with `link:` (dsh-autorestart
// itself among them). The tree copy records the LINK and none of its contents,
// so the plugin that does the rescuing could not be put back. These tests pin
// down the collection, the copy and the four decisions.
// ---------------------------------------------------------------------------

/** A profile whose node_modules holds one real plugin and one linked plugin. */
function linkFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-link-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  const dev = path.join(base, 'dev', 'linked-plugin');
  fs.mkdirSync(path.join(profile, 'node_modules', 'real-plugin'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'node_modules', 'real-plugin', 'package.json'), '{"name":"real-plugin"}\n', 'utf8');
  fs.mkdirSync(path.join(dev, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'package.json'), '{"name":"linked-plugin"}\n', 'utf8');
  fs.writeFileSync(path.join(dev, 'lib', 'index.js'), 'export default 2\n', 'utf8');
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['real-plugin', 'linked-plugin'] } } }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'insert:\n  - id: demo\n', 'utf8');
  // A junction needs no administrator rights on Windows (a symlink does).
  fs.symlinkSync(dev, path.join(profile, 'node_modules', 'linked-plugin'), 'junction');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, profile, dev, storage, backups: backupsRoot(storage) };
}

test('enabledBundlesOf: the enabled bundles of a profile package.json', () => {
  const text = JSON.stringify({ dsh: { profile: { bundles: ['a', ' b ', ''] } } });
  assert.deepEqual(enabledBundlesOf(text), ['a', 'b']);
  assert.deepEqual(enabledBundlesOf('not json'), []);
  assert.deepEqual(enabledBundlesOf(''), []);
});

test('collectLinkedPlugins: a junction is found, a real directory is not', (t) => {
  const { profile } = linkFixture(t);
  const collected = collectLinkedPlugins({ profileDir: profile });
  assert.equal(collected.ok, true);
  assert.deepEqual(collected.enabled, ['real-plugin', 'linked-plugin']);
  assert.equal(collected.links.length, 1, 'only the junction is a link');
  const link = collected.links[0];
  assert.equal(link.name, 'linked-plugin');
  assert.equal(link.kind, 'junction', 'a Windows junction is reported as one');
  assert.equal(link.exists, true);
  assert.equal(link.readable, true);
  assert.equal(link.files, 2, 'the target holds two files');
  assert.ok(link.bytes > 0);
  assert.match(path.basename(link.target), /linked-plugin$/);
});

test('collectLinkedPlugins: a link that is NOT an enabled bundle is left out', (t) => {
  const { profile } = linkFixture(t);
  const collected = collectLinkedPlugins({ profileDir: profile, bundles: ['real-plugin'] });
  assert.deepEqual(collected.enabled, ['real-plugin']);
  assert.deepEqual(collected.links, [], 'a switched-off bundle is not something a restore needs');
});

test('collectLinkedPlugins: a link whose target is gone is recorded with exists:false', (t) => {
  const { profile, dev } = linkFixture(t);
  fs.rmSync(dev, { recursive: true, force: true });
  const collected = collectLinkedPlugins({ profileDir: profile });
  assert.equal(collected.links.length, 1);
  assert.equal(collected.links[0].exists, false, 'the entry is still a link, its target just is not there');
  assert.equal(collected.links[0].readable, false);
});

test('createBackup: the contents of a linked plugin go into the backup and into the manifest', async (t) => {
  const { profile, storage, backups } = linkFixture(t);
  const result = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 5_000 });
  assert.equal(result.ok, true, result.error);

  // The contents are in their own directory, not mixed into the real copies.
  const linkCopy = path.join(result.dir, LINKS_DIR, 'linked-plugin');
  assert.ok(fs.existsSync(linkCopy), 'node_modules-link/<name> holds the contents');
  assert.ok(fs.existsSync(path.join(linkCopy, 'package.json')));
  assert.ok(fs.existsSync(path.join(linkCopy, 'lib', 'index.js')));

  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, MANIFEST_NAME), 'utf8'));
  assert.ok(Array.isArray(manifest.links), 'the manifest carries the links');
  assert.equal(manifest.links.length, 1);
  const recorded = manifest.links[0];
  assert.equal(recorded.name, 'linked-plugin');
  assert.equal(recorded.kind, 'junction');
  assert.equal(recorded.exists, true);
  assert.equal(recorded.copied, true);
  assert.equal(recorded.files, 2, 'the file count of the copied contents');
  assert.ok(recorded.bytes > 0, 'the size of the copied contents');
  assert.equal(manifest.linkFiles, 2);
  assert.ok(manifest.linkBytes > 0);
  // The manifest keeps the fields its three readers already use.
  for (const field of ['stamp', 'at', 'profileDir', 'includePlugins', 'files', 'bytes', 'fileCount']) {
    assert.ok(field in manifest, 'the manifest keeps ' + field);
  }
  // And the tree copy is still there (the links themselves are recorded too).
  assert.ok(fs.existsSync(path.join(result.dir, PLUGINS_DIR, 'real-plugin', 'package.json')));
  assert.equal(storage === '' ? false : true, true);
});

test('decideLinkRestore: a healthy link is KEPT', () => {
  const verdict = decideLinkRestore({ targetExists: true, targetReadable: true, hasBackup: true });
  assert.equal(verdict.action, LINK_ACTIONS.KEPT);
  assert.equal(verdict.replace, false);
});

test('decideLinkRestore: a missing target is REPLACED by the backup contents', () => {
  const verdict = decideLinkRestore({ targetExists: false, hasBackup: true });
  assert.equal(verdict.action, LINK_ACTIONS.REPLACED);
  assert.equal(verdict.replace, true);
});

test('decideLinkRestore: force replaces even a healthy link, and a second attempt forces too', () => {
  assert.equal(decideLinkRestore({ targetExists: true, hasBackup: true, force: true }).action, LINK_ACTIONS.REPLACED);
  assert.equal(decideLinkRestore({ targetExists: true, hasBackup: true, attempts: 2 }).action, LINK_ACTIONS.REPLACED);
  assert.equal(decideLinkRestore({ targetExists: true, targetReadable: false, hasBackup: true }).action, LINK_ACTIONS.REPLACED);
});

test('decideLinkRestore: without a copy in the backup nothing is deleted', () => {
  const noBackup = decideLinkRestore({ targetExists: true, hasBackup: false });
  assert.equal(noBackup.action, LINK_ACTIONS.NO_BACKUP);
  assert.equal(noBackup.replace, false, 'never delete what cannot be put back');
  const gone = decideLinkRestore({ targetExists: false, hasBackup: false });
  assert.equal(gone.action, LINK_ACTIONS.TARGET_MISSING);
  assert.equal(gone.replace, false);
});

// ---------------------------------------------------------------------------
// THE ANSWER HAS TO MATCH THE MANIFEST (measured bug, 2026-10-30).
//
// On the real profile the manifest listed all five linked plugins and their
// contents had really been copied - while the object `createBackup` RETURNED
// said `links: []`. The success return spread the base object (whose
// placeholders are empty) and never overrode them with the local values, so a
// caller reading the answer would report "no linked plugins are backed up"
// about a backup that holds every one of them. The manifest was right and the
// answer was wrong; this test keeps the two together.
// ---------------------------------------------------------------------------

test('createBackup: the RETURNED links match the manifest links', async (t) => {
  const { profile, backups } = linkFixture(t);
  const result = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 6_000 });
  assert.equal(result.ok, true, result.error);

  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, MANIFEST_NAME), 'utf8'));
  assert.equal(result.links.length, manifest.links.length, 'the answer must not hide the links the manifest lists');
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].name, 'linked-plugin');
  assert.equal(result.links[0].copied, true);
  assert.equal(result.linkFiles, manifest.linkFiles, 'linkFiles agrees with the manifest');
  assert.equal(result.linkBytes, manifest.linkBytes, 'linkBytes agrees with the manifest');
  assert.ok(result.linkFiles > 0, 'the copy of the linked plugin really landed');
});
