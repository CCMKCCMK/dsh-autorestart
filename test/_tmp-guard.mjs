/**
 * TEMPORARY DIRECTORIES ARE REMOVED WHEN THE RUN ENDS (2026-11-03).
 *
 * The suite had been leaving one sandbox per test behind, on every run: 34 448
 * directories / 4.17 GB on this machine, and growing. Nothing deleted them, because
 * `fs.mkdtempSync` is the only thing that creates them and no test owned the cleanup.
 *
 * This module installs the cleanup once, for the whole process:
 *
 *   - every `fs.mkdtempSync` / `fs.mkdtemp` result that lies inside `os.tmpdir()` is
 *     REMEMBERED (import this module before anything creates a directory);
 *   - on exit - normal or thrown - each remembered directory is deleted.
 *
 * WHAT IT WILL NOT DO: it never scans the temp directory and never deletes anything
 * this process did not create. A directory that was already there (a previous run, or
 * another test runner working in parallel) is not in the set and is left alone.
 *
 * A test may call `cleanupTempDirsNow()` to prove the deletion works without waiting
 * for the process to end.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The directories THIS process created (and therefore may delete). */
const created = new Set()
let installed = false

function insideTemp(target) {
  try {
    const temp = os.tmpdir()
    if (typeof temp !== 'string' || temp === '') return false
    const normal = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
    return normal(target).startsWith(normal(temp))
  } catch {
    return false
  }
}

function remember(dir) {
  if (typeof dir !== 'string' || dir === '') return
  if (!insideTemp(dir)) return
  created.add(path.resolve(dir))
}

/** Delete every directory this process created; safe to call more than once. */
export function cleanupTempDirsNow() {
  const removed = []
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      // A directory that cannot be removed must not break the run; the exit hook
      // tries once more and then gives up.
    }
  }
  created.clear()
  return removed
}

/** The directories this process created so far (for assertions). */
export function createdTempDirs() {
  return [...created]
}

/** Install the patch and the exit hook. Idempotent. */
export function installTempDirGuard() {
  if (installed) return
  installed = true

  const realMkdtempSync = fs.mkdtempSync
  fs.mkdtempSync = function patchedMkdtempSync(prefix, options) {
    const dir = realMkdtempSync.call(fs, prefix, options)
    remember(dir)
    return dir
  }

  if (typeof fs.mkdtemp === 'function') {
    const realMkdtemp = fs.mkdtemp
    fs.mkdtemp = function patchedMkdtemp(prefix, options, callback) {
      const done = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? undefined : options
      if (typeof done !== 'function') return realMkdtemp.call(fs, prefix, opts)
      return realMkdtemp.call(fs, prefix, opts, (error, dir) => {
        if (!error) remember(dir)
        done(error, dir)
      })
    }
  }

  // THE FALLBACK: a test that throws, an assertion that fails, or a plain process
  // exit all end here, so the sandboxes are removed even when the run is red.
  process.on('exit', () => {
    cleanupTempDirsNow()
  })
}

installTempDirGuard()
