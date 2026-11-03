/**
 * THE TEST ENVIRONMENT MUST NEVER WRITE INTO THE USER'S REAL STATE DIRECTORY
 * (2026-11-03).
 *
 * A test that forgot its `stateFile` fell through to the default, which is the
 * machine's own `.dsh/storages/dsh-autorestart/state.json`. The plugin then wrote
 * `access.json` / `watchdog-ready.json` there with the test's fake port (1234). The
 * watchdog reads that port to decide whether the host is alive, so a test run could
 * leave it probing a port that does not exist.
 *
 * The guard in `resolveStateFile` refuses that LOUDLY (a silent skip would hide the
 * missing `stateFile` for ever). These tests pin the refusal and the reason.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

function fakeContext() {
  return {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: () => undefined,
  }
}

test('the real user state directory is REFUSED while tests are running', () => {
  const homedir = os.homedir()
  const realFile = path.join(homedir, '.dsh', 'storages', 'dsh-autorestart', 'state.json')

  const saved = process.env.NODE_TEST_CONTEXT
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  try {
    assert.throws(
      // No stateFile: exactly the mistake the guard exists for.
      () => apply(fakeContext(), { recoveryDelayMs: 0, enabled: true }),
      (error) => {
        assert.match(String(error.message), /refusing to use the REAL user state directory while running tests/)
        assert.ok(
          String(error.message).includes(realFile),
          'the message names the directory it refused: ' + String(error.message),
        )
        assert.match(String(error.message), /pass an explicit stateFile/)
        assert.match(String(error.message), /watchdog would then probe the wrong port/)
        return true
      },
    )
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = saved
  }
})

test('a temporary stateFile is accepted and declared to be honoured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-guard-'))
  const stateFile = path.join(dir, 'state.json')
  const runtime = apply(fakeContext(), { stateFile, recoveryDelayMs: 0, enabled: true })
  try {
    assert.equal(runtime.stateFile, stateFile, 'the temporary state file is what the runtime uses')
    assert.ok(!stateFile.startsWith(path.join(os.homedir(), '.dsh')), 'and it is not inside the real .dsh')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without the test signal the default directory is still allowed (production)', () => {
  const saved = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  const savedHome = process.env.DSH_HOME
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-prod-'))
  process.env.DSH_HOME = dir
  try {
    // A fake DSH_HOME keeps this from touching the real directory while proving the
    // guard stays out of the way when it is not a test run.
    const runtime = apply(fakeContext(), { recoveryDelayMs: 0, enabled: true })
    assert.equal(runtime.stateFile, path.join(dir, 'storages', 'dsh-autorestart', 'state.json'))
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = saved
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
