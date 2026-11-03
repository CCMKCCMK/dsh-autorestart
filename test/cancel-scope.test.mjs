/**
 * Cancelling a restart: ONLY your own request, or everybody's.
 *
 * The accident the real machine showed (2026-10-28): a session wanted to
 * withdraw the restart IT had asked for, called `continuum_cancel_restart`
 * and took the restart requests of the OTHER sessions with it. A restart
 * request is COALESCED — several sessions may wait for the same restart — so
 * "cancel" has to say whose request it cancels.
 *
 * The rule under test:
 *
 *   - `scope: "mine"` (the DEFAULT) withdraws only the calling session's
 *     request; the restart stays while other requesters remain, and
 *     `restart.bySessionId` is re-pointed at one of them;
 *   - `scope: "all"` cancels the request for EVERYONE (the old behaviour);
 *   - a session that did not ask for the restart can NOT cancel it, and a
 *     call without a known calling session is refused instead of guessing:
 *     "cancel everything" must never be the fallback.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { cancelOwnRestart, createEmptyState, requestRestart } from '../lib/checkpoint.js'

function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-cancel-' + label + '-'))
  return { dir, file: path.join(dir, 'state.json') }
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

/** The state on disk. */
function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * A plugin with its tools, and the two tools under test.
 *
 * @param {string} label
 */
function mount(label) {
  const { file } = tempStateFile(label)
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart')
  assert.ok(restart, 'the continuum_restart tool must be registered')
  assert.ok(cancel, 'the continuum_cancel_restart tool must be registered')
  return { file, fake, restart, cancel }
}

test('withdrawing my own request leaves the request of the other session alone', () => {
  const { file, restart, cancel } = mount('mine-two')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  restart.execute({ reason: 'b' }, { agent: { id: 'sess-b', status: 'running' } })
  const before = readState(file)
  assert.deepEqual(before.restart.requesters.map((item) => item.sessionId), ['sess-b', 'sess-a'])

  const result = cancel.execute({ reason: 'changed my mind' }, { agent: { id: 'sess-a', status: 'running' } })

  assert.equal(result.ok, true, `the withdrawal succeeds: ${JSON.stringify(result)}`)
  assert.equal(result.scope, 'mine')
  assert.equal(result.cancelled, false, 'the restart itself is NOT cancelled')
  assert.equal(result.remainingRequesters, 1, 'the other requester is still waiting')

  const after = readState(file)
  assert.ok(after.restart, 'the restart is still pending')
  assert.deepEqual(
    after.restart.requesters.map((item) => item.sessionId),
    ['sess-b'],
    'only the calling session left the requesters',
  )
  assert.equal(after.restart.bySessionId, 'sess-b', 'bySessionId points at a requester that is left')
  assert.equal(after.phase, 'deferred', 'the restart is still deferred')
  assert.equal(after.sessions['sess-a'], undefined, 'the withdrawn session is released')
  assert.equal(after.sessions['sess-b'].pendingResume, true, 'the other session still waits for the restart')
})

test('withdrawing my own request cancels the restart when I was the last one', () => {
  const { file, restart, cancel } = mount('mine-last')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })

  const result = cancel.execute({ reason: 'changed my mind' }, { agent: { id: 'sess-a', status: 'running' } })

  assert.equal(result.ok, true)
  assert.equal(result.cancelled, true, 'the restart really goes away')
  assert.equal(result.remainingRequesters, 0)
  const after = readState(file)
  assert.equal(after.restart, null, 'the pending restart is gone')
  assert.equal(after.phase, 'idle', 'the phase is idle again')
  assert.equal(after.sessions['sess-a'], undefined, 'the waiter is released')
})

test('the default scope is "mine", not "all"', () => {
  const { file, restart, cancel } = mount('default-scope')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  restart.execute({ reason: 'b' }, { agent: { id: 'sess-b', status: 'running' } })

  // No scope at all: only my own request goes.
  const result = cancel.execute({ reason: 'changed my mind' }, { agent: { id: 'sess-a', status: 'running' } })

  assert.equal(result.scope, 'mine')
  assert.equal(result.cancelled, false)
  const after = readState(file)
  assert.ok(after.restart, 'the other session keeps its restart')
  assert.deepEqual(after.restart.requesters.map((item) => item.sessionId), ['sess-b'])
})

test('scope "all" cancels the request for EVERYONE', () => {
  const { file, restart, cancel } = mount('scope-all')
  for (const id of ['sess-a', 'sess-b', 'sess-c']) {
    restart.execute({ reason: 'reload' }, { agent: { id, status: 'running' } })
  }
  const before = readState(file)
  assert.equal(before.restart.requesters.length, 3)

  const result = cancel.execute({ reason: 'nobody restarts any more', scope: 'all' })

  assert.equal(result.ok, true)
  assert.equal(result.scope, 'all')
  assert.equal(result.cancelled, true, 'the whole request is cancelled')
  assert.equal(result.remainingRequesters, 0)
  const after = readState(file)
  assert.equal(after.restart, null, 'the pending restart is gone')
  assert.equal(after.phase, 'idle')
  for (const id of ['sess-a', 'sess-b', 'sess-c']) {
    assert.equal(after.sessions[id], undefined, 'every requester is released')
  }
})

test('a session that did not request the restart can NOT cancel it', () => {
  const { file, restart, cancel } = mount('not-a-requester')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  const before = readState(file)

  const result = cancel.execute({ reason: 'not mine' }, { agent: { id: 'sess-z', status: 'running' } })

  assert.equal(result.ok, false, 'the call is refused')
  assert.equal(result.cancelled, false, 'nothing was cancelled')
  assert.match(result.error, /did not request/i, `the error says why: ${result.error}`)
  const after = readState(file)
  assert.deepEqual(after.restart, before.restart, 'the pending restart is untouched')
  assert.equal(after.sessions['sess-a'].pendingResume, true, 'the requester still waits')
})

test('a call without a known calling session is refused, never a silent "cancel all"', () => {
  const { file, restart, cancel } = mount('no-session')
  restart.execute({ reason: 'a' }, { agent: { id: 'sess-a', status: 'running' } })
  restart.execute({ reason: 'b' }, { agent: { id: 'sess-b', status: 'running' } })
  const before = readState(file)

  const result = cancel.execute({ reason: 'who am I?' })

  assert.equal(result.ok, false, 'the call is refused')
  assert.equal(result.cancelled, false)
  assert.match(result.error, /calling session is unknown/i, `the error says why: ${result.error}`)
  const after = readState(file)
  assert.deepEqual(after.restart, before.restart, 'the pending restart is untouched')
  assert.equal(after.restart.requesters.length, 2)
})

test('cancelling when nothing is pending does nothing', () => {
  const { cancel } = mount('nothing-pending')
  const result = cancel.execute({ reason: 'never mind' }, { agent: { id: 'sess-a', status: 'running' } })
  assert.equal(result.ok, true)
  assert.equal(result.cancelled, false, 'there was nothing to cancel')
  assert.equal(result.remainingRequesters, 0)
})

test('the pure helper refuses a session that is not a requester', () => {
  const state = createEmptyState(1_000)
  requestRestart(state, { reason: 'a', bySessionId: 'a', now: 1_000 })
  const outcome = cancelOwnRestart(state, { sessionId: 'z', now: 2_000 })
  assert.equal(outcome.removed, false)
  assert.equal(outcome.reason, 'not-a-requester')
  assert.equal(outcome.remaining, 1)
  assert.ok(state.restart, 'the restart is untouched')
  assert.deepEqual(state.restart.requesters.map((item) => item.sessionId), ['a'])
})
