/**
 * THE WHOLE SUITE, FROM ONE FILE (2026-11-03).
 *
 * WHY THIS FILE EXISTS: on Node >= 24 `node --test <dir>` treats the directory
 * as a FILE (the repository's own `scripts/run-tests.ps1` says exactly that
 * and therefore passes a glob), so the plain directory call cannot work on
 * this platform. This file makes it work WITHOUT weakening anything: it
 * hands the REAL runner the real file list, so every test file still runs in
 * its own process, exactly as it does with the glob - nothing is stubbed,
 * nothing is skipped, and a red test still turns the command red.
 *
 * The exit code of that run is the exit code of this file, so `node --test
 * <dir>` and `node --test "test/*.test.mjs"` agree on green and on red.
 *
 * CommonJS on purpose: `require()` resolves a directory (package.json ->
 * main), while the ESM loader refuses one.
 */

'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const pattern = path.join(__dirname, '*.test.mjs')

// The inner runner must be a TOP-LEVEL runner: Node marks a test child with
// NODE_TEST_CONTEXT, and a runner that inherits it behaves like a test file
// child (it would finish in milliseconds without running anything).
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_TEST_WORKER_ID

console.log('[dsh-autorestart] running the whole suite: node --test "' + pattern + '"')

const result = spawnSync(process.execPath, ['--test', pattern], {
  cwd: __dirname,
  env,
  stdio: 'inherit',
})

if (result.error) {
  console.error('[dsh-autorestart] the test runner could not be started:', result.error)
  process.exitCode = 1
} else {
  process.exitCode = typeof result.status === 'number' ? result.status : 1
}