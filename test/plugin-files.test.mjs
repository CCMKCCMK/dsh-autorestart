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

/**
 * The directory of the linked plugins, next to `node_modules` in the profile.
 *
 * It is spelled out here on purpose: the test must fail because the watchdog
 * does not SEE that directory — not because a constant is missing.
 */
const LINK_DIR = 'node_modules-link'

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

// ---------------------------------------------------------------------------
// THE EPISODE MUST END WHERE THE BLOCKER ENDS (bug, 2026-11-11).
//
// `firstChangeAt` is the moment the episode started and the cap is measured
// from it. The old code never cleared it, so the marker of the FIRST change of
// the process stayed in the state for ever: once the cap had released that
// episode, every LATER installation was measured against that old timestamp
// and was over the cap from the first second — the watchdog was dead for the
// rest of the process's life.
// ---------------------------------------------------------------------------

test('a finished episode clears its marker, so the NEXT install is seen again', () => {
  // The first installation: the files move, then they settle.
  let state = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  state = sampleFingerprint(state, 'B', { now: 2000 })
  assert.equal(state.firstChangeAt, 2000)
  assert.equal(filesChanging(state, { now: 2000 }), true)

  // The files settle: the blocker goes away and the marker is cleared.
  const settled = sampleFingerprint(state, 'B', { now: 2000 + PLUGIN_FILES_STABLE_MS })
  assert.equal(settled.firstChangeAt, 0, 'the episode is over, so its marker is gone')
  assert.equal(filesChanging(settled, { now: 2000 + PLUGIN_FILES_STABLE_MS }), false)

  // A SECOND installation, minutes later: it must be seen, not swallowed by
  // the marker of the first one.
  const second = sampleFingerprint(settled, 'C', { now: 600000 })
  assert.equal(second.firstChangeAt, 600000, 'the new episode starts at the new change')
  assert.equal(filesChanging(second, { now: 600000 }), true, 'the watchdog is alive again')
  assert.notEqual(filesBlocker(second, { now: 600000 }), null)
})

test('after the cap released the episode, the marker does not stay for ever', () => {
  // A stuck installation churns for longer than the cap.
  let state = sampleFingerprint(emptyFilesState(), 'A', { now: 1000 })
  let at = 1000
  for (let i = 0; i < 400; i++) {
    at += 1000
    state = sampleFingerprint(state, `F${i}`, { now: at })
  }
  assert.equal(filesChanging(state, { now: at, maxBlockMs: PLUGIN_FILES_MAX_BLOCK_MS }), false, 'the cap released it')

  // The churn stops and the files settle: the marker is cleared, so the next
  // installation is a fresh episode instead of an instant over-the-cap one.
  const quiet = sampleFingerprint(state, 'F399', { now: at + PLUGIN_FILES_STABLE_MS + 1000 })
  assert.equal(quiet.firstChangeAt, 0)

  const next = sampleFingerprint(quiet, 'G', { now: at + PLUGIN_FILES_STABLE_MS + 2000 })
  assert.equal(next.firstChangeAt, at + PLUGIN_FILES_STABLE_MS + 2000)
  assert.equal(filesChanging(next, { now: at + PLUGIN_FILES_STABLE_MS + 2000 }), true)
})

// ---------------------------------------------------------------------------
// THE LINKED PLUGINS COUNT TOO (2026-11-11).
//
// A plugin installed with `link:` / a junction is not a copy: the profile
// keeps the names of those plugins in `node_modules-link` next to
// `node_modules`. Installing one touches that directory and NOTHING of the
// three watched paths — so the watchdog was completely blind to it.
// ---------------------------------------------------------------------------

test('the fingerprint changes when a linked plugin appears', () => {
  const profile = 'C:/profile'
  const links = join(profile, LINK_DIR)
  const before = fsStub({
    [join(profile, 'package.json')]: { mtimeMs: 100, size: 10 },
    [join(profile, 'pnpm-lock.yaml')]: { mtimeMs: 200, size: 20 },
    [join(profile, 'node_modules')]: [{ name: 'a' }],
  })
  const after = fsStub({
    [join(profile, 'package.json')]: { mtimeMs: 100, size: 10 },
    [join(profile, 'pnpm-lock.yaml')]: { mtimeMs: 200, size: 20 },
    [join(profile, 'node_modules')]: [{ name: 'a' }],
    [links]: [{ name: 'dsh-my-plugin' }],
  })
  const a = readFingerprint(profile, before)
  const b = readFingerprint(profile, after)
  assert.notEqual(a, b, 'a linked plugin must be visible to the watchdog')
  assert.equal(readFingerprint(profile, after), b, 'and the reading is stable')
})
