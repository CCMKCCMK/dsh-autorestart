import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  cleanupLegacyWatchdogArtifacts,
  LEGACY_WATCHDOG_FILES,
  LEGACY_WATCHDOG_TASK,
  LEGACY_WATCHDOG_UNIT,
} from '../lib/legacy-cleanup.js'

/**
 * A fake fs: only the files that are "there" exist, and every removal is
 * remembered.
 */
function fakeFs(presentNames) {
  const present = new Set(presentNames)
  const removed = []
  return {
    removed,
    existsSync(file) {
      return present.has(path.basename(file))
    },
    rmSync(file) {
      removed.push(path.basename(file))
      present.delete(path.basename(file))
    },
  }
}

/** A fake exec: every call is remembered, every call succeeds. */
function fakeExec() {
  const calls = []
  return {
    calls,
    exec(file, args) {
      calls.push({ file, args })
      return { ok: true, error: null }
    },
  }
}

const STATE_DIR = '/state/dsh-autorestart'

test('the five files of 0.8.6 are removed when they are all there', () => {
  const fsImpl = fakeFs([...LEGACY_WATCHDOG_FILES])
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'win32',
    exec: exec.exec,
    fs: fsImpl,
  })

  assert.equal(answer.removedFiles.length, 5, 'every file of 0.8.6 is gone')
  for (const name of LEGACY_WATCHDOG_FILES) {
    assert.ok(answer.removedFiles.includes(name), `${name} is reported as removed`)
    assert.ok(fsImpl.removed.includes(name), `${name} was really removed`)
  }
  assert.equal(answer.error, null, 'nothing went wrong')
})

test('a file that is not there is skipped, the others are removed', () => {
  const fsImpl = fakeFs(['watchdog-pending.json', 'watchdog.pid'])
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'linux',
    exec: exec.exec,
    fs: fsImpl,
  })

  assert.equal(answer.removedFiles.length, 2, 'only the two files that were there')
  assert.deepEqual(answer.removedFiles.sort(), ['watchdog-pending.json', 'watchdog.pid'])
  assert.equal(fsImpl.removed.length, 2, 'the other three were never touched')
})

test('on Windows the one-off scheduled task is deleted', () => {
  const fsImpl = fakeFs([])
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'win32',
    exec: exec.exec,
    fs: fsImpl,
  })

  assert.equal(exec.calls.length, 1, 'exactly one command')
  const call = exec.calls[0]
  assert.equal(call.file, 'schtasks')
  assert.ok(call.args.includes('/Delete'))
  assert.ok(call.args.includes('/TN'))
  assert.ok(call.args.includes(LEGACY_WATCHDOG_TASK))
  assert.ok(call.args.includes('/F'))
  assert.deepEqual(answer.removedUnits, [LEGACY_WATCHDOG_TASK], 'the task is reported as removed')
  assert.equal(answer.error, null)
})

test('on Linux the systemd unit is stopped and reset', () => {
  const fsImpl = fakeFs([])
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'linux',
    exec: exec.exec,
    fs: fsImpl,
  })

  assert.equal(exec.calls.length, 2, 'stop and reset-failed')
  for (const call of exec.calls) {
    assert.equal(call.file, 'systemctl')
    assert.ok(call.args.includes('--user'))
    assert.ok(call.args.includes(LEGACY_WATCHDOG_UNIT))
  }
  assert.ok(exec.calls[0].args.includes('stop'))
  assert.ok(exec.calls[1].args.includes('reset-failed'))
  assert.deepEqual(answer.removedUnits, [LEGACY_WATCHDOG_TASK], 'the unit is reported as removed')
  assert.equal(answer.error, null)
})

test('a command that fails is swallowed and reported', () => {
  const fsImpl = fakeFs([])
  const failing = () => {
    throw new Error('schtasks is not here')
  }

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'win32',
    exec: failing,
    fs: fsImpl,
  })

  assert.ok(answer.error, 'the failure is reported')
  assert.equal(answer.removedUnits.length, 0, 'nothing was removed')
  assert.equal(answer.removedFiles.length, 0)
})

test('a command that answers "not ok" is reported too, and never throws', () => {
  const fsImpl = fakeFs([])
  const notOk = () => ({ ok: false, error: 'no such task' })

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'win32',
    exec: notOk,
    fs: fsImpl,
  })

  assert.ok(answer.error, 'the failure is reported')
  assert.equal(answer.removedUnits.length, 0)
})

test('a file that cannot be removed is reported and the rest goes on', () => {
  const broken = {
    existsSync: () => true,
    rmSync: () => {
      throw new Error('the file is locked')
    },
  }
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    stateDir: STATE_DIR,
    platform: 'win32',
    exec: exec.exec,
    fs: broken,
  })

  assert.ok(answer.error, 'the failure is reported')
  assert.equal(answer.removedFiles.length, 0)
  assert.equal(exec.calls.length, 1, 'the scheduling item was still tried')
})

test('without a state directory nothing is removed and nothing throws', () => {
  const fsImpl = fakeFs([...LEGACY_WATCHDOG_FILES])
  const exec = fakeExec()

  const answer = cleanupLegacyWatchdogArtifacts({
    platform: 'win32',
    exec: exec.exec,
    fs: fsImpl,
  })

  assert.equal(answer.removedFiles.length, 0, 'no directory, no files')
  assert.equal(fsImpl.removed.length, 0)
  assert.equal(answer.error, null)
})
