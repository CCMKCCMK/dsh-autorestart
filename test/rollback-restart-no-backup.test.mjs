/**
 * THE RESTART THAT CARRIES OUT A MANUAL ROLLBACK TAKES NO SNAPSHOT
 * (user decision, 2026-11-02).
 *
 * WHAT WAS WRONG. `manualRollback` saves the live state first (the undo copy,
 * `trigger: manual-rollback`), restores the copy the user picked, and then
 * requests a normal restart. That restart had no way of saying "do not copy the
 * profile", so it snapshotted the state it was about to bring up — the content
 * that had JUST been restored from a copy. The user refused exactly that: the
 * duplicate takes a slot in the backup list and squeezes the older, still useful
 * copies out of it, while the undo copy of the rollback already IS the rollback
 * point of that restart.
 *
 * THE RULE PINNED HERE:
 *   1. the rollback request carries `skipBackup`, and the executor honours it —
 *      the shared snapshot entry is never called for that restart;
 *   2. THE PROOF IS ON DISK: the rollback adds exactly ONE backup directory (its
 *      undo copy) and the restart that follows adds NONE. The assertion compares
 *      the directory names before and after, so a copy under a new name cannot
 *      slip through;
 *   3. the ordinary restart still copies (the assertion above would otherwise be
 *      vacuous), and the flag defaults to false — an old checkpoint without the
 *      field reads back as "take the snapshot", never as "skip it";
 *   4. the rest of the safety net is untouched: only the COPY is skipped, the
 *      profile directory is still resolved so the watchdog is armed exactly as
 *      for a restart whose snapshot the operator switched off.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime, normalizeConfig, takePreRestartSnapshot } from '../index.js'
import { createEmptyState, readState, requestRestart, writeState } from '../lib/checkpoint.js'
import { backupsRoot, listBackupIdentities, writeBackupMeta } from '../lib/backup.js'

/* ------------------------------------------------------------------ *
 * The host half: a context that only logs, a profile, a state directory.
 * ------------------------------------------------------------------ */

/** A fake Cordis context: just enough for the runtime to exist, and it logs. */
function fakeContext() {
  const logs = []
  const record = (level) => (...parts) => {
    logs.push({
      level,
      text: parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '),
    })
  }
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: {
      get: () => undefined,
      disarm: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  return { ctx, logs }
}

/** A profile tree, the environment that points the host at it, and a state dir. */
function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-rollback-nobackup-${label}-`))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: current\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
  const stateDir = path.join(base, 'storage')
  fs.mkdirSync(stateDir, { recursive: true })
  return {
    base,
    profile,
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    backups: backupsRoot(stateDir),
  }
}

/** One copy on disk: a manifest, its identity, and the file it restores. */
function seedCopy(backups, stamp, { patch, kind = 'snapshot', version = null } = {}) {
  const dir = path.join(backups, stamp)
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), patch, 'utf8')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    at: 1793325600000,
    atLocal: '2026-10-30T09:00:00+00:00',
    bytes: patch.length,
    files: ['cordis.patch.yml'],
    includePlugins: false,
  }), 'utf8')
  assert.equal(writeBackupMeta(dir, { kind, at: 1793325600000, version }), true)
  return dir
}

/**
 * A hosted host restarted by a custom command, with every side effect replaced:
 * no process is killed, no restart command is run, no watcher is launched.
 */
function runtimeOn(setup) {
  const fake = fakeContext()
  const snapshots = []
  const commands = []
  const runtime = createRuntime(fake.ctx, normalizeConfig({
    stateFile: setup.stateFile,
    // A custom command makes `executeRestart` take the real host path instead of
    // bailing out with "no restart method available".
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    // The snapshot is ON: the skip has to come from the request, not from the
    // configuration, or this test would prove nothing.
    backupOnRestart: true,
    backupIncludePlugins: false,
    maxBackups: 5,
  }), {
    env: { isDesktopApp: false, appExePath: null },
    // THE SHARED SNAPSHOT ENTRY, spied but still the real implementation.
    snapshot: (options) => {
      snapshots.push(options)
      return takePreRestartSnapshot(options)
    },
    runCommand: ({ command }) => {
      commands.push(command)
      return { ok: true, command, pid: null }
    },
    // The watchdog is not armed on this machine (the test decides the arbiter),
    // and the old watcher is not launched either: nothing is written or spawned.
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test forces the fallback' }),
    launchWatcher: () => ({ ok: false, method: 'none', error: 'the test launches no watcher', verified: 'nothing', pid: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })
  return { runtime, fake, snapshots, commands }
}

/** The NAMES of the backup directories on disk, sorted. A count alone could
 *  hide "one removed, another added". */
function copyNames(backups) {
  return fs.existsSync(backups) ? fs.readdirSync(backups).sort() : []
}

/* ------------------------------------------------------------------ *
 * ① THE ROLLBACK RESTART WRITES NO BACKUP DIRECTORY.
 * ------------------------------------------------------------------ */

test('① the restart of a manual rollback takes no snapshot and adds no backup directory', async (t) => {
  const setup = fixture(t, 'skip')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', {
    patch: 'rows:\n  - id: old-target\n',
    kind: 'known-good',
    version: '0.8.5',
  })
  const { runtime, fake, snapshots, commands } = runtimeOn(setup)
  const before = copyNames(setup.backups)
  assert.equal(before.length, 1, 'the fixture starts with exactly one copy')

  /* ---- the rollback itself ---------------------------------------- */

  const result = await runtime.manualRollback({ name: '2026-10-20T01-00-00-000Z' })
  assert.equal(result.ok, true, String(result.error))
  // The undo copy is the ONE thing a rollback is allowed to add: without it the
  // rollback could not be undone. It is not the thing this test is about.
  assert.equal(typeof result.receipt.safetySnapshot, 'string', 'the undo copy exists')
  const afterRollback = copyNames(setup.backups)
  assert.equal(afterRollback.length, before.length + 1, 'the rollback added exactly its undo copy: ' + afterRollback.join(', '))
  assert.equal(
    afterRollback.filter((name) => !before.includes(name)).length,
    1,
    'and only that one: ' + afterRollback.join(', '),
  )

  // THE REQUEST carries the fact, so the executor does not have to read copy.
  assert.equal(result.receipt.restartRequested, true)
  assert.equal(runtime.state.restart.skipBackup, true, 'the rollback asks for no snapshot')
  assert.match(String(runtime.state.restart.reason), /manual rollback/)

  /* ---- the restart that follows it -------------------------------- */

  await runtime.executeRestart()

  assert.deepEqual(commands, ['restart-the-host'], 'the restart command still ran')
  assert.equal(
    snapshots.length,
    0,
    'the shared snapshot entry was NOT called for the rollback restart, got: '
      + JSON.stringify(snapshots.map((entry) => entry && entry.profile)),
  )
  const afterRestart = copyNames(setup.backups)
  assert.deepEqual(
    afterRestart,
    afterRollback,
    'NO backup directory appeared for the rollback restart: ' + afterRestart.join(', '),
  )
  assert.ok(
    fake.logs.some((entry) => entry.level === 'warn' && entry.text.includes('takes no pre-restart backup')),
    'and it says why, instead of a silent skip: ' + JSON.stringify(fake.logs.map((entry) => entry.text)),
  )
  // A copy that was recorded as "taken" would be a lie, and a copy reported as a
  // failure would be a different lie. The record says it was not asked for.
  const recordFile = path.join(setup.stateDir, 'last-restart.json')
  if (fs.existsSync(recordFile)) {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    const snapshot = record && record.snapshot ? record.snapshot : null
    if (snapshot !== null) {
      assert.equal(snapshot.taken, false, 'no snapshot is claimed for this restart')
      assert.equal(snapshot.dir, null, 'and no directory is named')
    }
  }
})

/* ------------------------------------------------------------------ *
 * ② THE CONTROL: an ordinary restart on the same machine still copies.
 *    Without it, ① would pass just as well if snapshots were broken.
 * ------------------------------------------------------------------ */

test('② an ordinary restart still snapshots, on the same machine and the same settings', async (t) => {
  const setup = fixture(t, 'control')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: old-target\n', kind: 'known-good' })
  const { runtime, snapshots, commands } = runtimeOn(setup)

  requestRestart(runtime.state, { reason: 'a normal restart', bySessionId: 'sess-normal' })
  assert.equal(runtime.state.restart.skipBackup, false, 'a normal request wants its snapshot')
  const before = copyNames(setup.backups)

  await runtime.executeRestart()

  assert.deepEqual(commands, ['restart-the-host'])
  assert.equal(snapshots.length, 1, 'the shared snapshot entry is used exactly once')
  const after = copyNames(setup.backups)
  assert.equal(after.length, before.length + 1, 'a new copy appeared: ' + after.join(', '))
  assert.equal(after.filter((name) => !before.includes(name)).length, 1, 'exactly one new copy')
})

/* ------------------------------------------------------------------ *
 * ③ THE FLAG ITSELF: off by default, and it survives the checkpoint.
 * ------------------------------------------------------------------ */

test('③ the flag is off unless asked for, and survives a write/read round trip', (t) => {
  const setup = fixture(t, 'flag')
  const now = Date.now()

  // (a) The default: every restart that does not say otherwise copies.
  const plain = createEmptyState(now)
  requestRestart(plain, { reason: 'ordinary', bySessionId: 's1', now })
  assert.equal(plain.restart.skipBackup, false, 'an ordinary request takes its snapshot')
  assert.equal(plain.restart.parkGoals, true, 'the neighbouring default is untouched')

  // (b) The fact survives a restart of the host: written, read back, still true.
  const skipping = createEmptyState(now)
  requestRestart(skipping, { reason: 'manual rollback to x', bySessionId: 'settings', resume: false, skipBackup: true, now })
  assert.equal(skipping.restart.skipBackup, true)
  writeState(setup.stateFile, skipping, now)
  const loaded = readState(setup.stateFile, now)
  assert.equal(loaded.corrupt, false, 'the checkpoint is readable')
  assert.equal(loaded.repaired, false, 'nothing had to be repaired')
  assert.equal(loaded.state.restart.skipBackup, true, 'the flag is still there after the round trip')
  assert.equal(loaded.state.restart.resume, false, 'and the rest of the request is untouched')

  // (c) AN OLD CHECKPOINT WITHOUT THE FIELD. It must read back as "take the
  // snapshot": a restart must never lose its rollback point because a field was
  // added to the schema.
  const old = {
    version: 1,
    bootId: 'boot-old',
    phase: 'deferred',
    generation: 3,
    restart: {
      generation: 3,
      requestedAt: now,
      reason: 'from an older build',
      bySessionId: 's2',
      resume: true,
      attempt: 0,
      softWarned: false,
      failedAttempts: 0,
      notBefore: 0,
      requesters: [{ sessionId: 's2', requestedAt: now, reason: 'from an older build', resume: true }],
      parkGoals: true,
    },
  }
  writeState(setup.stateFile, old, now)
  const upgraded = readState(setup.stateFile, now)
  assert.equal(upgraded.state.restart.skipBackup, false, 'a checkpoint without the field keeps its snapshot')
  assert.equal(upgraded.repaired, false, 'the new field is not treated as a repair')
})

/* ------------------------------------------------------------------ *
 * ④ ONLY THE COPY IS SKIPPED: the profile directory still reaches the watchdog.
 * ------------------------------------------------------------------ */

test('④ the watchdog is still armed for the rollback restart, with the profile as its target', async (t) => {
  const setup = fixture(t, 'watchdog')
  seedCopy(setup.backups, '2026-10-20T01-00-00-000Z', { patch: 'rows:\n  - id: old-target\n', kind: 'known-good' })
  const armed = []
  const fake = fakeContext()
  const runtime = createRuntime(fake.ctx, normalizeConfig({
    stateFile: setup.stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: false,
    maxBackups: 5,
  }), {
    env: { isDesktopApp: false, appExePath: null },
    snapshot: () => {
      throw new Error('the rollback restart must not snapshot')
    },
    runCommand: ({ command }) => ({ ok: true, command, pid: null }),
    armWatchdog: (options) => {
      armed.push(options)
      return { ok: true, tier: 'direct', reason: 'the test arms it' }
    },
    launchWatcher: () => ({ ok: false, method: 'none', error: 'the test launches no watcher', verified: 'nothing', pid: null }),
    probeInstance: async () => ({ ok: true, reason: 'the new instance answered' }),
  })

  const result = await runtime.manualRollback({ name: '2026-10-20T01-00-00-000Z' })
  assert.equal(result.ok, true, String(result.error))
  await runtime.executeRestart()

  assert.equal(armed.length, 1, 'the watchdog was armed once for the rollback restart')
  assert.equal(armed[0].profileDir, setup.profile, 'it knows which profile to restore into')
  // No copy of THIS restart exists, so there is no restore target of the attempt:
  // the watchdog is told the truth instead of being handed the just-restored
  // content as if it were a proven rollback point.
  assert.equal(armed[0].restoreBlocked, true, 'no trusted restore point of this attempt')
  assert.match(String(armed[0].restoreBlockedReason), /no snapshot/, 'and the reason says so')
})
