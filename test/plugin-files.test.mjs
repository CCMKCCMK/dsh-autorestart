/**
 * The market-independent signal: "somebody is touching the plugin files".
 *
 * These cases pin the four decisions that keep it from becoming a nuisance:
 *   1. the first sample after a start is a BASELINE, never a change (otherwise a
 *      restart would block itself for the stable window);
 *   2. a real change opens an episode and blocks;
 *   3. the episode ends `stableMs` after the LAST change, so a false positive
 *      clears itself instead of dragging on;
 *   4. a single episode never outlives `maxBlockMs`, so a stuck install cannot
 *      pin the host shut.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  PLUGIN_FILES_MAX_BLOCK_MS,
  PLUGIN_FILES_STABLE_MS,
  describeFilesEpisode,
  emptyFilesState,
  filesBlocker,
  filesChanging,
  readFingerprint,
  sampleFingerprint,
} from '../lib/plugin-files.js'

function fsStub(files) {
  return {
    statSync(path) {
      const hit = files[path]
      if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { mtimeMs: hit.mtimeMs ?? 1, size: hit.size ?? 1 }
    },
    readdirSync(path) {
      const hit = files[path]
      if (!Array.isArray(hit)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return hit
    },
  }
}

test('the first sample is a baseline: no episode, no blocker', () => {
  const first = sampleFingerprint(emptyFilesState(), 'pkg=1|lock=1|mods=1#3', { now: 1000 })
  assert.equal(first.changed, false)
  assert.equal(first.firstChangeAt, 0)
  assert.equal(filesChanging(first, { now: 1000 }), false)
  assert.equal(filesBlocker(first, { now: 1000 }), null)
})

test('a changed fingerprint opens an episode and blocks', () => {
  const base = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  const moved = sampleFingerprint(base, 'B', { now: 2000 })
  assert.equal(moved.changed, true)
  assert.equal(moved.firstChangeAt, 2000)
  assert.equal(moved.lastChangeAt, 2000)
  assert.equal(filesChanging(moved, { now: 2000 }), true)
  assert.equal(filesChanging(moved, { now: 2000 + PLUGIN_FILES_STABLE_MS - 1 }), true)
})

test('the episode ends stableMs after the LAST change, not after the first', () => {
  let state = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  state = sampleFingerprint(state, 'B', { now: 5000 })
  state = sampleFingerprint(state, 'C', { now: 9000 })
  // 15 s after the first change, but only 6 s after the last one: still changing.
  assert.equal(filesChanging(state, { now: 14000 }), true)
  // 15 s after the LAST change: quiet again.
  assert.equal(filesChanging(state, { now: 9000 + PLUGIN_FILES_STABLE_MS }), false)
})

test('an episode that never settles is capped by maxBlockMs', () => {
  let state = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  let at = 1000
  // Keep the file moving every second for longer than the cap.
  for (let i = 0; i < 400; i++) {
    at += 1000
    state = sampleFingerprint(state, `F${i}`, { now: at })
  }
  assert.equal(filesChanging(state, { now: at, maxBlockMs: PLUGIN_FILES_MAX_BLOCK_MS }), false)
  // The API is honoured: a huge cap keeps it blocked.
  assert.equal(filesChanging(state, { now: at, maxBlockMs: PLUGIN_FILES_MAX_BLOCK_MS * 100 }), true)
})

test('the blocker names the three watched files and its own reason', () => {
  const state = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  const live = sampleFingerprint(state, 'B', { now: 2000 })
  const blocker = filesBlocker(live, { now: 2500 })
  assert.equal(blocker.kind, 'plugin-files')
  assert.equal(blocker.reason, 'plugin-files')
  assert.deepEqual(blocker.files, ['package.json', 'pnpm-lock.yaml', 'node_modules'])
  assert.match(describeFilesEpisode(live, { now: 2500 }), /plugin files changed/)
})

test('readFingerprint changes when node_modules gains an entry', () => {
  const profile = 'C:/profile'
  const pkg = join(profile, 'package.json')
  const lock = join(profile, 'pnpm-lock.yaml')
  const mods = join(profile, 'node_modules')
  const before = fsStub({
    [pkg]: { mtimeMs: 100, size: 10 },
    [lock]: { mtimeMs: 200, size: 20 },
    [mods]: [{ name: 'a' }, { name: 'b' }],
  })
  const after = fsStub({
    [pkg]: { mtimeMs: 100, size: 10 },
    [lock]: { mtimeMs: 200, size: 20 },
    [mods]: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  })
  const a = readFingerprint(profile, before)
  const b = readFingerprint(profile, after)
  assert.notEqual(a, b)
  assert.equal(readFingerprint(profile, before), a)
})

test('a profile directory that is absent yields null and clears any episode', () => {
  assert.equal(readFingerprint('', fsStub({})), null)
  const live = sampleFingerprint(sampleFingerprint(emptyFilesState(), 'A', { now: 1000 }), 'B', { now: 2000 })
  const cleared = sampleFingerprint(live, null, { now: 2500 })
  assert.equal(cleared.firstChangeAt, 0)
  assert.equal(filesChanging(cleared, { now: 2600 }), false)
})

test('an absent path is still a comparable state, and appearing counts as a change', () => {
  const profile = 'C:/p'
  const empty = fsStub({})
  const installed = fsStub({
    [join(profile, 'package.json')]: { mtimeMs: 5, size: 5 },
    [join(profile, 'pnpm-lock.yaml')]: { mtimeMs: 6, size: 6 },
    [join(profile, 'node_modules')]: [{ name: 'x' }],
  })
  assert.match(readFingerprint(profile, empty), /absent/)
  assert.notEqual(readFingerprint(profile, empty), readFingerprint(profile, installed))
})
