/**
 * THE POWER-OFF PATH WAITS FOR AN INSTALL TOO (user decision, 2026-11-11).
 *
 * User, verbatim: "重启之前要看有没有插件在安装，这个动作我想起来关机也要，所以
 * 你要把关机那边也覆盖上". The restart gate already consults the external
 * blockers (the plugin market, and the plugin files); the sleep gate is the one
 * choke point every power-off exit funnels into, so it consults the very same
 * function. These tests pin that contract without ever touching a machine: the
 * blocker reaches the gate through `runtime.externalBlockers`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { sleepGate } from '../index.js'

/** A runtime that would otherwise let the machine go. */
function baseRuntime(overrides = {}) {
  return {
    pendingRestart: () => false,
    busyAgents: () => [],
    ...overrides,
  }
}

const filesBlocker = {
  sessionId: null,
  kind: 'plugin-files',
  reason: 'plugin-files',
  label: '插件文件',
  name: '插件文件正在变动',
}

const marketBlocker = {
  sessionId: null,
  kind: 'market-install',
  reason: 'plugin-install',
  label: '插件市场',
  name: '插件市场正在安装插件',
}

test('a plugin install in progress holds the power-off path', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [filesBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'plugin-files')
  assert.equal(Array.isArray(gate.blockedBy), true)
  assert.equal(gate.blockedBy.length, 1)
  // The label the user sees is the one the blocker carried, not a generic one.
  assert.equal(gate.blockedBy[0].label, '插件文件')
  assert.equal(gate.blockedBy[0].kind, 'plugin-files')
})

test('the market keeps its own reason, so the two causes stay distinguishable', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [marketBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'plugin-install')
})

test('both at once: the first reason wins and BOTH are reported', () => {
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [marketBlocker, filesBlocker] }))
  assert.equal(gate.allow, false)
  assert.equal(gate.blockedBy.length, 2)
  assert.deepEqual(gate.blockedBy.map((entry) => entry.kind), ['market-install', 'plugin-files'])
})

test('an external blocker is NOT turned into a cancel: the gate only says no', () => {
  // Whatever runs the countdown decides what to do with a refusal — the gate
  // must not clear the intent itself, so the shutdown resumes by itself once
  // the install settles. A `cancelled`/`abort` field here would be a bug.
  const gate = sleepGate(baseRuntime({ externalBlockers: () => [filesBlocker] }))
  assert.equal('cancelled' in gate, false)
  assert.equal('abort' in gate, false)
  assert.equal(gate.allow, false)
})

test('a runtime without the hook (older harness, unit tests) still works', () => {
  // The hook is optional on purpose: sleepGate is also used by callers that
  // never wired the market probe, and a missing function must not throw.
  const gate = sleepGate(baseRuntime())
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate, null)
})

test('a throwing hook is treated as "no blockers", not as a reason to refuse', () => {
  // Fail-open on a broken probe: a bug in the market probe must never pin the
  // machine on forever.
  const gate = sleepGate(baseRuntime({
    externalBlockers: () => {
      throw new Error('probe exploded')
    },
  }))
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate.reason, 'plugin-files')
})

// ---------------------------------------------------------------------------
// A GOAL THAT IS STILL GOING IS WORK (user report, 2026-11-11):
// "有一个目标在跑，但是呢，他自己停了下来，然后直接就关机了".
// A goal drives itself one round at a time; between two rounds the session has
// no running turn, so a busy-only check called it idle and the machine went
// down mid-work. The power-off path cannot park a goal the way the restart
// does, so it has to WAIT.
// ---------------------------------------------------------------------------

test('an armed goal holds the power-off path even between two of its rounds', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => [{ sessionId: 'session-g', goal: { id: 'goal-1' } }],
  }))
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'goal-active')
  assert.equal(gate.blockedBy.length, 1)
  assert.equal(gate.blockedBy[0].kind, 'goal-active')
  assert.equal(gate.blockedBy[0].sessionId, 'session-g')
})

test('the goal reason never masquerades as an install reason', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => [{ sessionId: 'session-g', goal: { id: 'goal-1' } }],
  }))
  assert.notEqual(gate.reason, 'plugin-install')
  assert.notEqual(gate.reason, 'plugin-files')
})

test('a throwing goal probe fails open instead of pinning the machine', () => {
  const gate = sleepGate(baseRuntime({
    busyGoals: () => {
      throw new Error('goal service exploded')
    },
  }))
  assert.equal(typeof gate, 'object')
  assert.notEqual(gate.reason, 'goal-active')
})

test('no goals means the goal branch is skipped entirely', () => {
  const gate = sleepGate(baseRuntime({ busyGoals: () => [] }))
  assert.notEqual(gate.reason, 'goal-active')
})

