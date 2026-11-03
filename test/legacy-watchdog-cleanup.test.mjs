import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LEGACY_WATCHDOG_FILES,
  LEGACY_WATCHDOG_UNIT,
  sweepLegacyWatchdogArtifacts,
} from '../lib/legacy-watchdog-cleanup.js'

/** A fake fs that remembers which paths exist and what was removed. */
function fakeFs(existing) {
  const present = new Set(existing)
  const removed = []
  return {
    removed,
    existsSync(target) {
      const name = target.split(/[\\/]/).pop()
      return present.has(name)
    },
    rmSync(target) {
      const name = target.split(/[\\/]/).pop()
      present.delete(name)
      removed.push(name)
    },
  }
}

/** A fake exec that records the calls and answers with a fixed status. */
function fakeExec(status = 0) {
  const calls = []
  const fn = (command, args) => {
    calls.push({ command, args })
    return { status }
  }
  fn.calls = calls
  return fn
}

test('every leftover file is removed when all of them exist', () => {
  const fs = fakeFs([...LEGACY_WATCHDOG_FILES])
  const exec = fakeExec(0)
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: 'C:/state', platform: 'win32', exec, fs })
  assert.equal(answer.removedFiles.length, LEGACY_WATCHDOG_FILES.length)
  assert.equal(answer.error, null)
  assert.deepEqual(answer.removedFiles.sort(), [...LEGACY_WATCHDOG_FILES].sort())
})

test('a file that is not there is skipped, not reported', () => {
  const fs = fakeFs(['watchdog-pending.json', 'watchdog.pid'])
  const exec = fakeExec(0)
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: 'C:/state', platform: 'win32', exec, fs })
  assert.deepEqual(answer.removedFiles.sort(), ['watchdog-pending.json', 'watchdog.pid'])
  assert.equal(answer.removedUnits.length, 1)
})

test('on Windows it deletes the one-shot task by name', () => {
  const fs = fakeFs([])
  const exec = fakeExec(0)
  sweepLegacyWatchdogArtifacts({ stateDir: 'C:/state', platform: 'win32', exec, fs })
  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0].command, 'schtasks')
  assert.deepEqual(exec.calls[0].args, ['/Delete', '/TN', LEGACY_WATCHDOG_UNIT, '/F'])
})

test('on Linux it stops the unit and clears its failed state', () => {
  const fs = fakeFs([])
  const exec = fakeExec(0)
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: '/home/u/.dsh/state', platform: 'linux', exec, fs })
  assert.equal(exec.calls.length, 2)
  assert.equal(exec.calls[0].command, 'systemctl')
  assert.deepEqual(exec.calls[0].args, ['--user', 'stop', LEGACY_WATCHDOG_UNIT + '.service'])
  assert.deepEqual(exec.calls[1].args, ['--user', 'reset-failed', LEGACY_WATCHDOG_UNIT + '.service'])
  assert.deepEqual(answer.removedUnits, [LEGACY_WATCHDOG_UNIT + '.service'])
})

test('a failing command is swallowed, not thrown', () => {
  const fs = fakeFs([])
  const exec = () => { throw new Error('schtasks is not on PATH') }
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: 'C:/state', platform: 'win32', exec, fs })
  assert.equal(answer.removedUnits.length, 0)
  assert.equal(answer.error, null, 'a missing task is the normal "nothing to clean" answer')
})

test('a failing removal is reported in error and does not stop the rest', () => {
  const present = new Set([...LEGACY_WATCHDOG_FILES])
  const removed = []
  const fs = {
    existsSync: (target) => present.has(target.split(/[\\/]/).pop()),
    rmSync(target) {
      const name = target.split(/[\\/]/).pop()
      if (name === 'watchdog-pending.json') throw new Error('EPERM')
      present.delete(name)
      removed.push(name)
    },
  }
  const exec = fakeExec(0)
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: 'C:/state', platform: 'win32', exec, fs })
  assert.match(String(answer.error), /EPERM/)
  assert.ok(removed.length >= 1, 'the remaining files are still removed')
})

test('an unknown state directory is refused instead of guessing', () => {
  const fs = fakeFs([])
  const exec = fakeExec(0)
  const answer = sweepLegacyWatchdogArtifacts({ stateDir: '', platform: 'win32', exec, fs })
  assert.deepEqual(answer.removedFiles, [])
  assert.equal(answer.error, 'the state directory is unknown')
  assert.equal(exec.calls.length, 0, 'nothing is executed when there is no directory')
})
