/**
 * The rules of the rescue kit.
 *
 * These are the rules `scripts/restore-profile.ps1` obeys when it puts a
 * snapshot back over a broken profile. They live in `lib/rescue.js` so node can
 * import and test them directly; `scripts/drill-rescue.ps1` proves that the
 * PowerShell implementation behaves the same way.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backupsRootDir,
  brokenDirName,
  checkProfileTarget,
  checkRestoreTarget,
  dshHomeDir,
  describeSnapshot,
  forbiddenReason,
  inspectProfileDir,
  inspectSnapshotProfile,
  isInside,
  localStamp,
  normalizePath,
  PLUGINS_DIR,
  profilesRootDir,
  readSnapshotManifest,
  selectSnapshot,
  stateDirDir,
  validateRestoredProfile,
} from '../lib/rescue.js';

const isWindows = process.platform === 'win32';

/** A throwaway directory that cleans itself up. */
function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-rescue-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** A directory that looks like a DSH profile. */
function makeProfile(dir, { pluginVersion = '0.7.0', broken = false } = {}) {
  fs.mkdirSync(path.join(dir, PLUGINS_DIR, 'dsh-autorestart'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    broken
      ? '{ "name": "demo", oops '
      : JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['dsh-autorestart'] } } }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, PLUGINS_DIR, 'dsh-autorestart', 'package.json'),
    JSON.stringify({ name: 'dsh-autorestart', version: pluginVersion }),
    'utf8',
  );
  return dir;
}

/** A snapshot directory with a manifest, the way the plugin writes one. */
function makeSnapshot(backupsDir, name, { at = 1_000, includePlugins = true, withManifest = true } = {}) {
  const dir = path.join(backupsDir, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, PLUGINS_DIR, 'dsh-autorestart'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config', 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, PLUGINS_DIR, 'dsh-autorestart', 'package.json'),
    JSON.stringify({ name: 'dsh-autorestart', version: '0.7.0' }),
    'utf8',
  );
  if (withManifest) {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ stamp: name, at, atLocal: '2026-10-29T09:00:00+08:00', includePlugins }),
      'utf8',
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The directories
// ---------------------------------------------------------------------------

test('the DSH home follows DSH_HOME, otherwise the home directory', () => {
  assert.equal(dshHomeDir({ env: { DSH_HOME: 'C:\\dsh-home' }, home: 'C:\\Users\\Tester' }), 'C:\\dsh-home');
  assert.equal(dshHomeDir({ env: {}, home: path.join(path.sep, 'home', 'tester') }), normalizePath(path.join(path.sep, 'home', 'tester', '.dsh')));
});

test('the snapshots live next to the state file', () => {
  const env = { DSH_HOME: 'C:\\dsh-home' };
  const state = stateDirDir({ env });
  assert.equal(path.basename(state), 'dsh-autorestart');
  assert.equal(backupsRootDir({ env }), path.join(state, 'backups'));
  assert.equal(profilesRootDir({ env }), path.join('C:\\dsh-home', 'profiles'));
});

// ---------------------------------------------------------------------------
// The path gate
// ---------------------------------------------------------------------------

test('a drive root is never a valid target', () => {
  if (!isWindows) return;
  const reason = forbiddenReason('C:\\', { home: 'C:\\Users\\Tester', env: { SystemDrive: 'C:' } });
  assert.notEqual(reason, '');
  assert.match(reason, /drive root|filesystem root/);
});

test('a system directory is never a valid target', () => {
  if (!isWindows) return;
  const env = { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const home = 'C:\\Users\\Tester';
  assert.notEqual(forbiddenReason('C:\\Windows', { home, env }), '');
  assert.notEqual(forbiddenReason('C:\\Windows\\System32', { home, env }), '');
  assert.notEqual(forbiddenReason('C:\\Program Files', { home, env }), '');
  assert.notEqual(forbiddenReason('C:\\Program Files\\App', { home, env }), '');
  assert.notEqual(forbiddenReason('C:\\ProgramData', { home, env }), '');
});

test('the home directory itself is never a valid target', () => {
  const home = isWindows ? 'C:\\Users\\Tester' : path.join(path.sep, 'home', 'tester');
  assert.notEqual(forbiddenReason(home, { home, env: {} }), '');
});

test('another user profile is never a valid target', () => {
  if (!isWindows) return;
  const home = 'C:\\Users\\Tester';
  assert.notEqual(forbiddenReason('C:\\Users\\Somebody', { home, env: { SystemDrive: 'C:' } }), '');
});

test('by default only a profile under the profiles root may be restored', () => {
  const profilesRoot = path.join(path.sep, 'home', 'tester', '.dsh', 'profiles');
  const inside = path.join(profilesRoot, 'desktop');
  const outside = path.join(path.sep, 'home', 'tester', 'Documents');

  const allowed = checkProfileTarget(inside, { profilesRoot, env: {} });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.scope, 'profiles-root');

  const refused = checkProfileTarget(outside, { profilesRoot, env: {} });
  assert.equal(refused.ok, false);
  assert.notEqual(refused.error, '');
});

test('an explicitly named isolated directory is allowed, but a drive root never is', () => {
  const profilesRoot = path.join(path.sep, 'home', 'tester', '.dsh', 'profiles');
  const isolated = path.join(path.sep, 'tmp', 'drill', 'profile');

  const allowed = checkProfileTarget(isolated, { profilesRoot, env: {}, explicit: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.scope, 'explicit');

  if (isWindows) {
    const refused = checkProfileTarget('C:\\', { profilesRoot, env: { SystemDrive: 'C:' }, explicit: true });
    assert.equal(refused.ok, false);
  }
});

test('an empty target is refused', () => {
  const result = checkProfileTarget('   ', { env: {} });
  assert.equal(result.ok, false);
  assert.notEqual(result.error, '');
});

// ---------------------------------------------------------------------------
// The profile fingerprint
// ---------------------------------------------------------------------------

test('a profile is recognized by the dsh.profile section', (t) => {
  const base = scratch(t);
  const profile = makeProfile(path.join(base, 'profile'));
  const seen = inspectProfileDir(profile);
  assert.equal(seen.kind, 'profile');
  assert.ok(seen.markers.includes('package.json'));
  assert.ok(seen.markers.includes(PLUGINS_DIR));
});

test('a profile whose package.json is broken is still a (broken) profile', (t) => {
  const base = scratch(t);
  const profile = makeProfile(path.join(base, 'profile'), { broken: true });
  const seen = inspectProfileDir(profile);
  assert.equal(seen.kind, 'broken-profile');
  assert.notEqual(seen.reason, '');
});

test('a directory that is not a profile is not accepted', (t) => {
  const base = scratch(t);
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(inspectProfileDir(empty).kind, 'not-a-profile');

  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'package.json'), '{"name":"some-npm-package"}', 'utf8');
  assert.equal(inspectProfileDir(plain).kind, 'not-a-profile');
});

// ---------------------------------------------------------------------------
// The snapshot selection
// ---------------------------------------------------------------------------

test('the newest snapshot with a manifest wins', (t) => {
  const base = scratch(t);
  const backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  makeSnapshot(backups, '2026-10-29T01-00-00-000Z', { at: 1_000 });
  makeSnapshot(backups, '2026-10-29T02-00-00-000Z', { at: 2_000 });

  const selected = selectSnapshot(backups);
  assert.equal(selected.ok, true);
  assert.equal(selected.name, '2026-10-29T02-00-00-000Z');
  assert.equal(selected.candidates.length, 2);
});

test('a directory without a manifest is not a snapshot', (t) => {
  const base = scratch(t);
  const backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  makeSnapshot(backups, '2026-10-29T01-00-00-000Z', { at: 1_000 });
  // The newer directory has no manifest: it is not a snapshot.
  makeSnapshot(backups, '2026-10-29T02-00-00-000Z', { at: 2_000, withManifest: false });

  const selected = selectSnapshot(backups);
  assert.equal(selected.ok, true);
  assert.equal(selected.name, '2026-10-29T01-00-00-000Z');
  assert.equal(selected.candidates.length, 1);
});

test('no snapshot at all is an error, not a crash', (t) => {
  const base = scratch(t);
  const backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const selected = selectSnapshot(backups);
  assert.equal(selected.ok, false);
  assert.notEqual(selected.error, '');

  const missing = selectSnapshot(path.join(base, 'nope'));
  assert.equal(missing.ok, false);
  assert.notEqual(missing.error, '');
});

test('a manifest with a BOM is still read', (t) => {
  const base = scratch(t);
  const backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const dir = makeSnapshot(backups, '2026-10-29T01-00-00-000Z', { at: 1_000 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '\uFEFF{"at":123}', 'utf8');
  const manifest = readSnapshotManifest(dir);
  assert.ok(manifest);
  assert.equal(manifest.at, 123);
});

test('a snapshot that holds a real profile is accepted, one that does not is refused', (t) => {
  const base = scratch(t);
  const backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const good = makeSnapshot(backups, 'good', { at: 1_000 });
  const bad = makeSnapshot(backups, 'bad', { at: 2_000 });
  fs.writeFileSync(path.join(bad, 'config', 'package.json'), '{"name":"not-a-profile"}', 'utf8');

  assert.equal(inspectSnapshotProfile(good).ok, true);
  assert.equal(inspectSnapshotProfile(bad).ok, false);
  assert.notEqual(inspectSnapshotProfile(bad).reason, '');
});

// ---------------------------------------------------------------------------
// The broken directory and the read-back
// ---------------------------------------------------------------------------

test('the broken directory is named after the profile and a timestamp', () => {
  const name = brokenDirName(path.join(path.sep, 'home', 'tester', '.dsh', 'profiles', 'desktop'), Date.UTC(2026, 9, 29, 6, 10, 30));
  assert.match(name, /\.broken-\d{8}-\d{6}$/);
  assert.ok(name.startsWith(normalizePath(path.join(path.sep, 'home', 'tester', '.dsh', 'profiles', 'desktop'))));
});

test('the timestamp is a local one and sorts chronologically', () => {
  assert.match(localStamp(Date.UTC(2026, 9, 29, 6, 10, 30)), /^\d{8}-\d{6}$/);
  assert.ok(localStamp(1_000) < localStamp(2_000_000));
});

test('a restored profile is checked: package.json, bundles and the plugin version', (t) => {
  const base = scratch(t);
  const profile = makeProfile(path.join(base, 'profile'));
  const result = validateRestoredProfile(profile);
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.7.0');
  assert.equal(result.checks.filter((check) => check.status === 'failed').length, 0);
});

test('a restored profile whose package.json does not parse fails the check', (t) => {
  const base = scratch(t);
  const profile = makeProfile(path.join(base, 'profile'), { broken: true });
  const result = validateRestoredProfile(profile);
  assert.equal(result.ok, false);
  assert.notEqual(result.error, '');
});

test('a restored profile without bundles fails the check', (t) => {
  const base = scratch(t);
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo","dsh":{"profile":{"bundles":[]}}}', 'utf8');
  const result = validateRestoredProfile(profile);
  assert.equal(result.ok, false);
  const bundles = result.checks.find((check) => check.id === 'bundles');
  assert.equal(bundles.status, 'failed');
});

test('a profile without the plugin is skipped, not failed', (t) => {
  const base = scratch(t);
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo","dsh":{"profile":{"bundles":["other"]}}}', 'utf8');
  const result = validateRestoredProfile(profile);
  assert.equal(result.ok, true);
  const version = result.checks.find((check) => check.id === 'plugin-version');
  assert.equal(version.status, 'skipped');
});

test('a profile that LISTS the plugin but does not have it is a failure', (t) => {
  const base = scratch(t);
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // The configuration says dsh-autorestart is installed; the disk says no.
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo","dsh":{"profile":{"bundles":["dsh-autorestart"]}}}', 'utf8');
  const result = validateRestoredProfile(profile);
  assert.equal(result.ok, false);
  const version = result.checks.find((check) => check.id === 'plugin-version');
  assert.equal(version.status, 'failed');
  assert.match(version.detail, /dsh-autorestart/);
});

// ---------------------------------------------------------------------------
// The restore target: path gate + the directory has to be there + profile
// ---------------------------------------------------------------------------

test('the restore target has to exist: the kit never creates a profile', (t) => {
  const base = scratch(t);
  const missing = path.join(base, 'not-there-yet');
  const result = checkRestoreTarget(missing, { env: {}, explicit: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
  assert.equal(fs.existsSync(missing), false, 'the check must not create anything');
});

test('a broken profile is still a valid restore target', (t) => {
  const base = scratch(t);
  const profile = makeProfile(path.join(base, 'profile'), { broken: true });
  const result = checkRestoreTarget(profile, { env: {}, explicit: true });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'broken-profile');
});

test('a directory that is not a profile is not a valid restore target', (t) => {
  const base = scratch(t);
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const result = checkRestoreTarget(empty, { env: {}, explicit: true });
  assert.equal(result.ok, false);
});

test('a drive root is not a valid restore target, even when named explicitly', (t) => {
  if (!isWindows) return;
  const result = checkRestoreTarget('C:\\', { env: { SystemDrive: 'C:' }, explicit: true });
  assert.equal(result.ok, false);
});

test('a snapshot describes itself in words', () => {
  const described = describeSnapshot({ at: 1_000, atLocal: '2026-10-29T09:00:00+08:00', includePlugins: true });
  assert.equal(described.display, '2026-10-29 09:00');
  assert.equal(described.includePlugins, true);
});

// ---------------------------------------------------------------------------
// The path helpers
// ---------------------------------------------------------------------------

test('isInside does not count the parent itself', () => {
  assert.equal(isInside(path.join(path.sep, 'a', 'b', 'c'), path.join(path.sep, 'a', 'b')), true);
  assert.equal(isInside(path.join(path.sep, 'a', 'b'), path.join(path.sep, 'a', 'b')), false);
  assert.equal(isInside(path.join(path.sep, 'a', 'bc'), path.join(path.sep, 'a', 'b')), false);
});

test('normalizePath drops the trailing separator but keeps the root', () => {
  const joined = path.join(path.sep, 'a', 'b');
  assert.equal(normalizePath(joined + path.sep), path.resolve(joined));
  if (isWindows) assert.equal(normalizePath('C:\\'), 'C:\\');
});

// ---------------------------------------------------------------------------
// The delivered scripts
// ---------------------------------------------------------------------------

test('the rescue kit ships the three scripts it promises', () => {
  const scripts = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'scripts');
  const root = path.resolve(scripts);
  assert.ok(fs.existsSync(path.join(root, 'restore-profile.cmd')));
  assert.ok(fs.existsSync(path.join(root, 'restore-profile.ps1')));
  assert.ok(fs.existsSync(path.join(root, 'drill-rescue.ps1')));
});
