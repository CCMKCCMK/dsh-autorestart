/**
 * A ROLLBACK THAT COULD NOT WRITE ONE PLUGIN MUST SAY SO — AND FINISH LATER.
 *
 * THE REAL MACHINE (2026-11-07 16:49, rollback to B4): the receipt listed three
 * configuration files and six `node_modules-link/<plugin>` entries — and quietly
 * left out the seventh: `dsh-autorestart` itself. Its `index.js` stayed at
 * 16:22:12 while the other five were rewritten at 16:49:05–16:49:07. Replaying
 * the write gave the exact reason:
 *
 *   fs.cpSync(B4/node_modules-link/dsh-autorestart, <workspace>/plugins/dsh-autorestart,
 *             { recursive: true, force: true })
 *   → EIO, Access is denied. …\plugins\dsh-autorestart\assets
 *
 * The running host holds its own plugin files. That is a hard Windows fact and is
 * NOT something to force — but the failure was swallowed by a bare boolean, so
 * the interface could not tell "six came back" from "seven came back".
 *
 * WHAT THIS FILE PINS DOWN:
 *   · one plugin that cannot be written does not stop the others;
 *   · it lands in the receipt's `deferred` list with the real error — never in
 *     `restored`;
 *   · the receipt still succeeds (`ok: true`) because the rest came back;
 *   · the next boot writes it (the files are free by then) and clears the record;
 *   · a retry that fails again keeps the record, so health keeps showing it.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resumeDeferredRestore } from '../index.js'
import { restoreBackup, restoreLinkedPlugin } from '../lib/backup.js'

const LINKS_DIR = 'node_modules-link'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A temp root: `<dir>/{profile,workspace,backups}`. */
function fixture(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-deferred-${label}-`))
  t.after(() => {
    // A read-only directory would block the cleanup; restore the rights first.
    try { fs.chmodSync(path.join(dir, 'profile', 'node_modules', 'held-plugin'), 0o755) } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  const profile = path.join(dir, 'profile')
  const workspace = path.join(dir, 'workspace')
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(backups, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  return { dir, profile, workspace, backups }
}

/** Write a plugin directory (the code that a copy holds). */
function writePlugin(dir, text) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"' + path.basename(dir) + '","version":"1.0.0"}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'index.js'), text, 'utf8')
  return dir
}

/** A copy holding two linked plugins and one configuration file. */
function writeCopy(backups, names) {
  const backup = path.join(backups, 'copy-1')
  fs.mkdirSync(path.join(backup, 'config'), { recursive: true })
  fs.writeFileSync(path.join(backup, 'config', 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8')
  for (const name of names) writePlugin(path.join(backup, LINKS_DIR, name), '/* from the copy */\n')
  return backup
}

/** Link a workspace plugin into the profile; false when links are unsupported. */
function link(profile, name, target) {
  try {
    fs.symlinkSync(target, path.join(profile, 'node_modules', name), 'junction')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * ① ONE PLUGIN CANNOT BE WRITTEN: the others still come back, and it is named.
 * ------------------------------------------------------------------ */

test('① a plugin that cannot be written lands in deferred, the others still come back', async (t) => {
  const setup = fixture(t, 'partial')
  const free = writePlugin(path.join(setup.workspace, 'free-plugin'), '/* live, old */\n')
  const held = writePlugin(path.join(setup.workspace, 'held-plugin'), '/* live, old */\n')
  if (link(setup.profile, 'free-plugin', free) !== true || link(setup.profile, 'held-plugin', held) !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const backup = writeCopy(setup.backups, ['free-plugin', 'held-plugin'])

  // WHAT THE RUNNING HOST DOES TO ITSELF: make the destination really refuse the
  // write. A DIRECTORY sits where the copy has a FILE, so `fs.cpSync` fails with
  // the same shape of error the real machine got (EIO/EACCES/EISDIR) instead of
  // the test pretending. POSIX permissions are advisory on Windows, so this is
  // the portable way to make the copy genuinely fail.
  fs.rmSync(path.join(held, 'index.js'), { force: true })
  fs.mkdirSync(path.join(held, 'index.js'), { recursive: true })

  const answer = restoreBackup({ backupDir: backup, profileDir: setup.profile })

  // ① THE RECEIPT IS A SUCCESS — six of seven is a valid rollback.
  assert.equal(answer.ok, true, 'the rollback as a whole succeeded: ' + String(answer.error))

  // ② WHAT CAME BACK IS NAMED.
  assert.equal(answer.restored.includes(LINKS_DIR + '/free-plugin'), true,
    'the plugin that was free came back: ' + JSON.stringify(answer.restored))
  assert.equal(
    fs.readFileSync(path.join(free, 'index.js'), 'utf8').includes('from the copy'),
    true,
    'and its bytes really changed',
  )

  // ③ WHAT DID NOT COME BACK IS NAMED TOO — with the error, never as a success.
  assert.equal(answer.restored.includes(LINKS_DIR + '/held-plugin'), false,
    'a failed plugin is never reported as restored')
  const failed = answer.deferred.find((entry) => entry.name === LINKS_DIR + '/held-plugin')
  assert.ok(failed, 'it is in deferred: ' + JSON.stringify(answer.deferred))
  assert.equal(typeof failed.error, 'string', 'with the reason the filesystem gave')
  assert.ok(failed.error.length > 0, 'not an empty string: ' + JSON.stringify(failed.error))

  // ④ THE CONFIGURATION IS NOT AFFECTED BY A PLUGIN FAILURE.
  assert.equal(answer.restored.includes('cordis.patch.yml'), true, 'the configuration came back')

  // THE BLOCKER IS REMOVED (the host restarted, the files are free) so the retry
  // can write where it failed before.
  fs.rmdirSync(path.join(held, 'index.js'))

  // ⑤ ONE PLUGIN, ONE RETRY — what the boot path calls.
  const retried = restoreLinkedPlugin({ backupDir: backup, profileDir: setup.profile, name: LINKS_DIR + '/held-plugin' })
  assert.equal(retried.ok, true, 'the retry succeeds once the files are free: ' + String(retried.error))
  assert.equal(
    fs.readFileSync(path.join(held, 'index.js'), 'utf8').includes('from the copy'),
    true,
    'the deferred plugin really came back',
  )
})

/* ------------------------------------------------------------------ *
 * ② THE BOOT RETRY: success clears the record, failure keeps it.
 * ------------------------------------------------------------------ */

test('② the next boot retries the deferred plugins and clears what it recovered', async (t) => {
  const setup = fixture(t, 'deferred')
  const free = writePlugin(path.join(setup.workspace, 'free-plugin'), '/* live, old */\n')
  const held = writePlugin(path.join(setup.workspace, 'held-plugin'), '/* live, old */\n')
  if (link(setup.profile, 'free-plugin', free) !== true || link(setup.profile, 'held-plugin', held) !== true) {
    t.skip('this filesystem refuses symlinks/junctions')
    return
  }
  const backup = writeCopy(setup.backups, ['free-plugin', 'held-plugin'])
  // A DIRECTORY WHERE THE COPY HAS A FILE: this is the portable way to make the
  // copy genuinely fail (POSIX permissions are advisory on Windows).
  fs.rmSync(path.join(held, 'index.js'), { force: true })
  fs.mkdirSync(path.join(held, 'index.js'), { recursive: true })
  const first = restoreBackup({ backupDir: backup, profileDir: setup.profile })
  assert.equal(first.deferred.length, 1, 'exactly one plugin was deferred: ' + JSON.stringify(first.deferred))

  // THE STATE THE ROLLBACK WRITES (index.js does this; the shape is pinned here).
  const state = {
    deferredRestore: first.deferred.map((entry) => ({
      name: entry.name,
      error: entry.error,
      backupDir: backup,
      at: Date.now(),
      attempts: 0,
    })),
  }
  const runtime = {
    state,
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }

  // ① A RETRY WHILE THE FILES ARE STILL HELD KEEPS THE RECORD, with a new attempt
  // counter — a silent drop would be the old bug in a new place.
  const stillHeld = await resumeDeferredRestore(runtime, {}, { profileDir: setup.profile })
  assert.equal(stillHeld.restored.length, 0, 'nothing was recovered while the directory is unwritable')
  assert.equal(stillHeld.remaining.length, 1, 'and the record stays: ' + JSON.stringify(stillHeld.remaining))
  assert.equal(stillHeld.remaining[0].attempts, 1, 'the attempt is counted')
  assert.equal(typeof stillHeld.remaining[0].error, 'string', 'with the error of THIS attempt')
  assert.equal(runtime.state.deferredRestore.length, 1, 'the state file keeps the entry')

  // ② THE FILES ARE FREE (the host restarted) — the retry at the next boot wins.
  fs.rmdirSync(path.join(held, 'index.js'))
  const recovered = await resumeDeferredRestore(runtime, {}, { profileDir: setup.profile })
  assert.equal(recovered.restored.length, 1, 'the plugin came back: ' + JSON.stringify(recovered))
  assert.equal(recovered.restored[0], LINKS_DIR + '/held-plugin', 'and it is the one that was waiting')
  assert.equal(recovered.remaining.length, 0, 'nothing is left over')
  assert.deepEqual(runtime.state.deferredRestore, [], 'THE RECORD IS CLEARED')
  assert.equal(
    fs.readFileSync(path.join(held, 'index.js'), 'utf8').includes('from the copy'),
    true,
    'the bytes really changed this time',
  )
})

/* ------------------------------------------------------------------ *
 * ③ NOT A BOOT, NOT A RETRY — and no record, no work.
 * ------------------------------------------------------------------ */

test('③ a reload does not retry, and an empty record does nothing', async (t) => {
  const setup = fixture(t, 'noop')
  const state = {
    deferredRestore: [{ name: LINKS_DIR + '/x', error: 'held', backupDir: path.join(setup.backups, 'copy-1'), at: 1, attempts: 0 }],
  }
  const reload = {
    state: { ...state },
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  assert.equal(await resumeDeferredRestore(reload, {}, { profileDir: setup.profile }), null,
    'the same process still holds the files — retrying here would fail the same way')
  assert.equal(reload.state.deferredRestore.length, 1, 'and nothing was dropped by the reload')

  const empty = {
    state: { deferredRestore: [] },
    stateFile: path.join(setup.dir, 'state.json'),
    isNewBoot: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  assert.equal(await resumeDeferredRestore(empty, {}, { profileDir: setup.profile }), null,
    'an empty record means there is nothing to do')
})
