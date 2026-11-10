/**
 * A GOAL A RESTART DISARMED MUST BE GIVEN BACK (bug, 2026-11-11).
 *
 * User, verbatim: "刚刚重启的时候，这个目标没有被触发继续". The boot pass only
 * looks at sessions that already carry `pendingResume`; disarming a goal for the
 * restart never set one, so the session sat idle with its goal disarmed and
 * `recover_now` answered `no-pending-recovery`.
 *
 * The disarmed/parked records are written BEFORE the restart and survive it, so
 * `recoverableSessions` now adopts the ones from THIS restart before it looks
 * for pending work. These tests pin that, without a host and without a restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { recoverableSessions } from '../lib/checkpoint.js'

/** The smallest state the selector reads. */
function stateWith(overrides = {}) {
  return {
    sessions: {},
    ...overrides,
  }
}

test('a goal disarmed by THIS restart becomes pending work again', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt: 1500, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, 'session-a')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('the parked-goals map is adopted too, with its own timestamp field', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    parkedGoals: {
      'session-b': { goalId: 'goal-2', parkedAt: 1200, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.deepEqual(pending.map((entry) => entry.sessionId), ['session-b'])
})

test('a goal disarmed BEFORE this restart is history, not pending work', () => {
  // Otherwise every boot would resurrect sessions from days ago.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-old': { goalId: 'goal-old', disarmedAt: 999, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('a goal that was already given back is not adopted twice', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-c': { goalId: 'goal-3', disarmedAt: 1500, resumedAt: 1800 },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('without a restart request the adoption is skipped (nothing to attribute)', () => {
  const state = stateWith({
    disarmedGoals: {
      'session-d': { goalId: 'goal-4', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})

test('an already running session is left alone: it needs no recovery nudge', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-e': { sessionId: 'session-e', running: true, updatedAt: 1500 },
    },
    disarmedGoals: {
      'session-e': { goalId: 'goal-5', disarmedAt: 1500, resumedAt: null },
    },
  })
  const pending = recoverableSessions(state, { now: 2000 })
  assert.equal(pending.length, 1)
  // Adopted or not, the session is recovered exactly once and keeps running.
  assert.equal(pending[0].sessionId, 'session-e')
  assert.equal(pending[0].running, true)
})

test('the prototype keys the session maps guard against are never adopted', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      __proto__: { goalId: 'goal-evil', disarmedAt: 1500, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [])
})
