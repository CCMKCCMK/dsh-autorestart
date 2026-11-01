/**
 * THE WATCHDOG QUESTION (2026-11-01).
 *
 * Before this, `watchdogEnabled: true` was a value written into the source: the
 * feature was on, but the user had never been asked. These tests pin the three
 * things that make "asked once, and the answer is honoured" true:
 *
 *   1. never asked  -> ON  (a rescue feature must not switch itself off)
 *   2. answered no  -> the watchdog really is not armed
 *   3. new version  -> the question comes back
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { shouldAskWatchdog, watchdogAllowed, writeInstallChoice } from '../index.js'

function withStateDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-ask-'))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 1. never asked -> ON
// ---------------------------------------------------------------------------

test('a profile that was never asked keeps the watchdog ON', () => {
  withStateDir((dir) => {
    // No install-choice.json at all.
    assert.equal(watchdogAllowed(dir, {}), true, 'no answer means ON')
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), true, 'and it is time to ask')
  })
})

test('an answer recorded before this question existed still means ON', () => {
  withStateDir((dir) => {
    // The real file on the machine today: only includePlugins, no watchdog key.
    fs.writeFileSync(path.join(dir, 'install-choice.json'),
      JSON.stringify({ includePlugins: true, at: '2026-10-26T06:26:16.335Z' }))
    assert.equal(watchdogAllowed(dir, {}), true, 'missing watchdog field must not mean off')
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), true, 'and it must be asked once')
  })
})

// ---------------------------------------------------------------------------
// 2. answered NO -> really not armed
// ---------------------------------------------------------------------------

test('answering no really turns the watchdog off', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '1.0.0' })
    assert.equal(watchdogAllowed(dir, {}), false, 'the answer wins over the written default')
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false, 'and it is not asked again for this version')
  })
})

test('answering yes keeps it on', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: true, askedForPluginVersion: '1.0.0' })
    assert.equal(watchdogAllowed(dir, {}), true)
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false)
  })
})

test('the config file saying false wins over everything', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: true, askedForPluginVersion: '1.0.0' })
    // Somebody edited the config on purpose: that is not an answer to be ignored.
    assert.equal(watchdogAllowed(dir, { watchdogEnabled: false }), false, 'an explicit off in the config wins')
  })
})

// ---------------------------------------------------------------------------
// 3. a new version asks again
// ---------------------------------------------------------------------------

test('a new plugin version asks the question again', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '1.0.0' })
    assert.equal(shouldAskWatchdog(dir, '1.1.0'), true, 'the version changed, so ask again')
    // ...and until the user answers, the OLD answer still governs the arming.
    assert.equal(watchdogAllowed(dir, {}), false, 'the answered no is still honoured while it asks')
  })
})

test('the recorded version and the answer survive a second write', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '1.0.0' })
    // A later, unrelated choice must not erase the watchdog answer.
    writeInstallChoice(dir, { includePlugins: true })
    assert.equal(watchdogAllowed(dir, {}), false, 'an unrelated write keeps the watchdog answer')
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false)
  })
})

// ---------------------------------------------------------------------------
// the file itself
// ---------------------------------------------------------------------------

test('the answer is written into install-choice.json under its own keys', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '2.3.4' })
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'install-choice.json'), 'utf8'))
    assert.equal(saved.watchdog, false)
    assert.equal(saved.askedForPluginVersion, '2.3.4')
    assert.equal(typeof saved.at, 'string', 'and the existing timestamp is still written')
  })
})
