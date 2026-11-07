/**
 * THE NEW INSTANCE MUST NOT ERASE WHAT THE OLD ONE RECORDED (task t44).
 *
 * gen 539 on the real machine: the backup really was taken — 319,549,069 bytes in
 * 7,920 ms, `snapshot.taken: true`, `backupDir` named — and yet the verdict said
 * `executionEntered: false`, `branch: ""`, and the comparison's reason had decayed
 * to a generic value. A reader looking at that record concludes "nothing was
 * backed up", which is the opposite of the truth.
 *
 * THE RULE PINNED HERE: the boot-recovery write finishes the verdict, it does not
 * rewrite the facts. `branch` / `executionEntered` / `compareReason` /
 * `compareDifferences` come from the record already on disk; the newcomer only adds
 * `settledBy: 'boot-recovery'` (and the checks) to it.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyRestartBoot } from '../index.js'
import {
  RESTART_RESULTS,
  buildRestartVerdict,
  readRestartVerdict,
  writeRestartVerdict,
} from '../lib/restart-verdict.js'

/** A runtime just big enough for `verifyRestartBoot`, with the real writer. */
function makeRuntime(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-boot-verdict-'))
  t.after(() => { try { fs.rmSync(stateDir, { recursive: true, force: true }) } catch {} })
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }
  return {
    stateDir,
    runtime: {
      log: quiet,
      stateFile: path.join(stateDir, 'state.json'),
      bootId: 'boot-after',
      webPort: 0,
      registeredRoutes: [],
      recordRestartVerdict(patch = {}) {
        const current = readRestartVerdict(stateDir)
        const merged = buildRestartVerdict({ ...(current ?? {}), ...patch })
        writeRestartVerdict(stateDir, merged)
        return merged
      },
    },
  }
}

/** The record the OLD instance left behind (pending, main flow finished its half). */
function writePending(stateDir, patch) {
  const record = buildRestartVerdict({
    result: RESTART_RESULTS.PENDING,
    mode: 'app',
    generation: 539,
    startedAt: Date.now() - 8000,
    previousBootId: 'boot-before',
    bootId: null,
    ...patch,
  })
  writeRestartVerdict(stateDir, record)
  return record
}

const FAST = { timeoutMs: 5, sleep: async () => {} }

/* ------------------------------------------------------------------ *
 * ① THE MAIN FLOW'S FACTS SURVIVE THE BOOT WRITE.
 * ------------------------------------------------------------------ */

test('① the boot write keeps branch / executionEntered / compareReason / compareDifferences', async (t) => {
  const { stateDir, runtime } = makeRuntime(t)
  writePending(stateDir, {
    branch: 'changed-backed-up',
    branchReason: 'the comparison found a difference and the copy was written',
    branchGeneration: 538,
    executionEntered: true,
    settledBy: 'main-flow',
    compareReason: 'plugin-tree-differs',
    compareDifferences: [{ path: 'node_modules-link/x/index.js', kind: 'content' }],
    snapshot: { taken: true, dir: path.join(stateDir, 'backups', '2026-11-07T09-51-10-495Z'), bytes: 319549069 },
  })

  const record = await verifyRestartBoot(runtime, FAST)
  assert.ok(record, 'the boot wrote the verdict')

  // THE FACTS FROM THE OLD INSTANCE, UNCHANGED.
  assert.equal(record.branch, 'changed-backed-up', 'the branch is not wiped: ' + JSON.stringify(record.branch))
  assert.equal(record.executionEntered, true, 'the main flow did run — the record says so')
  assert.equal(record.branchGeneration, 538, 'and it keeps its generation')
  assert.equal(record.branchReason, 'the comparison found a difference and the copy was written')
  assert.equal(record.compareReason, 'plugin-tree-differs', 'the comparison reason survives')
  assert.deepEqual(
    record.compareDifferences,
    [{ path: 'node_modules-link/x/index.js', kind: 'content', live: null, copy: null }],
    'and so do the differences',
  )
  assert.equal(record.snapshot.taken, true, 'the snapshot is still reported as taken')
  assert.equal(record.snapshot.bytes, 319549069, 'with its real size')

  // AND THE NEWCOMER SAYS WHO FINISHED IT.
  assert.equal(record.settledBy, 'boot-recovery', 'the finisher is named: ' + JSON.stringify(record.settledBy))
  assert.notEqual(record.result, RESTART_RESULTS.PENDING, 'the verdict is no longer pending')
  assert.equal(typeof record.reason, 'string', 'and it says why: ' + JSON.stringify(record.reason))
})

/* ------------------------------------------------------------------ *
 * ② A RESTART THE MAIN FLOW NEVER RAN STILL SAYS SO — HONESTLY.
 * ------------------------------------------------------------------ */

test('② a restart the main flow never entered keeps executionEntered false and no branch', async (t) => {
  const { stateDir, runtime } = makeRuntime(t)
  writePending(stateDir, { snapshot: { taken: false } })

  const record = await verifyRestartBoot(runtime, FAST)
  assert.ok(record, 'the boot wrote the verdict')

  assert.equal(record.executionEntered, false, 'no main flow ⇒ false, and that is the truth here')
  assert.equal(record.branch, null, 'and no branch is invented: ' + JSON.stringify(record.branch))
  assert.equal(record.branchGeneration, null, 'no generation is invented either')
  assert.equal(record.settledBy, 'boot-recovery', 'the boot is the one who settled it')
  assert.equal(typeof record.reason, 'string', 'with a reason that can be read')
})
