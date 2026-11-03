/**
 * Coalescing tests: several sessions may request ONE restart. Every requester is
 * recorded on `restart.requesters`, released together on cancel, and woken by the
 * single boot recovery pass (which now drains several batches per boot).
 */
// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  createEmptyState,
  markPendingResume,
  markRunning,
  normalizeState,
  requestRestart,
  writeState,
} from '../lib/checkpoint.js'

function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-coalesce-' + label + '-'))
  return { dir, file: path.join(dir, 'state.json') }
}

function fakeAgent(id) {
  const followups = []
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followups,
    followup(message) {
      followups.push(message)
    },
  }
}

function createFakeContext({ services = {}, runningAgents = [] } = {}) {
  const tools = []
  const listeners = new Map()
  const timeouts = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => undefined, warn: () => undefined, error: () => undefined }),
    fiber: { state: 2 },
    agents: {
      list: () => runningAgents,
      roots: () => runningAgents,
      get: (id) => runningAgents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => {
        throw new Error('goals.resume not configured for this test')
      },
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    get: (name) => services[name],
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    provide: () => undefined,
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, timeouts }
}

async function runBootRecovery(fake) {
  const pending = fake.timeouts.shift()
  assert.ok(pending, 'apply() must schedule a boot-recovery timer')
  pending.fn()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function seedPreviousBoot(file, build) {
  const state = createEmptyState(Date.now() - 60_000)
  state.bootPid = 999_999
  state.bootId = 'previous-boot'
  build(state)
  writeState(file, state)
}

function pretendNewHostBoot(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  state.bootPid = 999_999
  state.bootId = 'previous-boot'
  fs.writeFileSync(file, JSON.stringify(state))
}

test('markRunning keeps a pending resume request intact', () => {
  const state = createEmptyState(1_000)
  markPendingResume(state, { sessionId: 's1', reason: 'restart-requested', now: 1_000 })
  markRunning(state, { sessionId: 's1', reason: 'turn started', now: 2_000 })
  const entry = state.sessions.s1
  assert.equal(entry.running, true)
  assert.equal(entry.pendingResume, true, 'a session that keeps working must still be resumed')
  assert.equal(entry.pendingSince, 1_000, 'the original pending timestamp survives')
  assert.equal(entry.interrupted, false)
})

test('three restart requests coalesce into one cycle with three requesters', () => {
  const state = createEmptyState(1_000)
  requestRestart(state, { reason: 'first', bySessionId: 'a', now: 1_000 })
  requestRestart(state, { reason: 'second', bySessionId: 'b', now: 2_000 })
  requestRestart(state, { reason: 'third', bySessionId: 'c', now: 3_000 })
  assert.equal(state.generation, 3)
  assert.equal(state.restart.bySessionId, 'c', 'the last requester stays in bySessionId')
  assert.deepEqual(state.restart.requesters.map((item) => item.sessionId), ['c', 'b', 'a'])
  for (const id of ['a', 'b', 'c']) assert.equal(state.sessions[id].pendingResume, true)
  const normalized = normalizeState(JSON.parse(JSON.stringify(state)), 4_000).state
  assert.deepEqual(normalized.restart.requesters.map((item) => item.sessionId), ['c', 'b', 'a'])
})

test('cancelling a coalesced restart with scope "all" releases every requester', () => {
  const { file } = tempStateFile('cancel-all')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart')
  for (const id of ['s-a', 's-b', 's-c']) restart.execute({ reason: 'reload' }, { agent: { id, status: 'running' } })
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(before.restart.requesters.length, 3)
  assert.equal(before.restart.bySessionId, 's-c')
  // The explicit "nobody restarts any more": the whole request goes.
  assert.equal(cancel.execute({ reason: 'no longer needed', scope: 'all' }).cancelled, true)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.restart, null)
  for (const id of ['s-a', 's-b', 's-c']) assert.equal(after.sessions[id], undefined, 'every requester is released')
})

test('boot recovery wakes more pending sessions than one batch', async () => {
  const { file } = tempStateFile('batches')
  seedPreviousBoot(file, (state) => {
    for (const id of ['s1', 's2', 's3']) markPendingResume(state, { sessionId: id, reason: 'restart-requested' })
  })
  const resolved = []
  const followups = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (sessionId) => {
          resolved.push(sessionId)
          const agent = fakeAgent(sessionId)
          followups.push(agent)
          return { agent }
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, maxSessions: 2, recoveryBatchDelayMs: 0, enabled: true })
  await runBootRecovery(fake)
  assert.equal(resolved.length, 3, 'batching wakes every pending session in this boot')
  for (const agent of followups) assert.equal(agent.followups.length, 1)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.values(after.sessions).every((entry) => entry.pendingResume === false), true)
})

test('a failing resolveAgent records lastResumeError and the cap clears the retry', async () => {
  const { file } = tempStateFile('failing')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 's-bad', reason: 'restart-requested' })
  })
  const makeBoot = () => createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async () => {
          throw new Error('boom')
        },
      },
    },
  })
  const bootConfig = { stateFile: file, recoveryDelayMs: 0, maxResumeAttempts: 2, resumeRetryDelayMs: 0, enabled: true }

  const boot1 = makeBoot()
  apply(boot1.ctx, bootConfig)
  await runBootRecovery(boot1)
  let loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(loaded.sessions['s-bad'].pendingResume, true, 'a failed resume stays pending for a later boot')
  assert.equal(loaded.sessions['s-bad'].resumeAttempts, 1)
  assert.match(loaded.sessions['s-bad'].lastResumeError, /boom/)

  pretendNewHostBoot(file)
  const boot2 = makeBoot()
  apply(boot2.ctx, bootConfig)
  await runBootRecovery(boot2)
  loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(loaded.sessions['s-bad'].pendingResume, true)
  assert.equal(loaded.sessions['s-bad'].resumeAttempts, 2)
  const status = boot2.tools.find((tool) => tool.name === 'continuum_status').execute({})
  assert.match(status.sessions[0].lastResumeError, /boom/, 'continuum_status exposes the resume error')

  pretendNewHostBoot(file)
  const boot3 = makeBoot()
  apply(boot3.ctx, bootConfig)
  await runBootRecovery(boot3)
  loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(loaded.sessions['s-bad'].pendingResume, false, 'the attempt cap stops the retry loop')
  assert.match(loaded.sessions['s-bad'].lastResumeError, /boom/, 'the last error stays recorded')
})
