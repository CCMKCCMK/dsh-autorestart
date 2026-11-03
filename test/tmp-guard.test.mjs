/**
 * THE SANDBOXES ARE REMOVED, AND ONLY OURS ARE (2026-11-03).
 *
 * The suite used to leave one temporary directory per test behind on every run:
 * 34 448 of them / 4.17 GB on this machine. `test/_tmp-guard.mjs` now remembers every
 * directory THIS process creates under the OS temp directory and deletes exactly
 * those when the process ends - on success and on failure alike.
 *
 * These tests pin the two properties that make that safe:
 *   1. what this process created is gone after cleanup;
 *   2. what it did NOT create is left alone (no scanning, no mass deletion).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cleanupTempDirsNow, createdTempDirs, installTempDirGuard } from './_tmp-guard.mjs'

test('a directory this process created is recorded, then removed', () => {
  installTempDirGuard()
  const before = createdTempDirs().length
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-tmpguard-'))
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'x', 'utf8')

  assert.equal(fs.existsSync(dir), true, 'the directory exists while the test runs')
  assert.ok(createdTempDirs().length > before, 'and the guard remembered it')
  assert.ok(createdTempDirs().includes(path.resolve(dir)), 'by its resolved path')

  const removed = cleanupTempDirsNow()
  assert.ok(removed.includes(path.resolve(dir)), 'cleanup reports what it removed')
  assert.equal(fs.existsSync(dir), false, 'and the directory is really gone')
})

test('a directory this process did NOT create is never touched', () => {
  // A directory of exactly the shape the suite creates, but made here with a plain
  // mkdir - so it is NOT in the guard's set. This is the stand-in for a directory a
  // previous run left behind, or one another test runner is using right now.
  const foreign = path.join(os.tmpdir(), 'dsh-ar-tmpguard-foreign-' + process.pid)
  fs.mkdirSync(foreign, { recursive: true })
  fs.writeFileSync(path.join(foreign, 'payload.txt'), 'keep me', 'utf8')

  const removed = cleanupTempDirsNow()

  assert.equal(removed.includes(path.resolve(foreign)), false, 'it was not in the set, so nothing removed it')
  assert.equal(fs.existsSync(foreign), true, 'the foreign directory survives the cleanup')

  fs.rmSync(foreign, { recursive: true, force: true })
})

test('the guard is installed once and does not stack patches', () => {
  installTempDirGuard()
  installTempDirGuard()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-tmpguard-once-'))
  assert.ok(createdTempDirs().includes(path.resolve(dir)), 'still recorded after repeated installs')
  cleanupTempDirsNow()
  assert.equal(fs.existsSync(dir), false, 'and still removed')
})
