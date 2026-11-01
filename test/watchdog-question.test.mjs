/**
 * THE WATCHDOG QUESTION (2026-11-01).
 *
 * Before this, `watchdogEnabled: true` was a value written into the source: the
 * feature was on, but the user had never been asked. These tests pin the three
 * things that make "asked once, and the answer is honoured" true:
 *
 *   1. never asked  -> ON  (a rescue feature must not switch itself off)
 *   2. answered no  -> the watchdog really is not armed
 *   3. answered once -> NEVER asked again, whatever the plugin version is
 *
 * (3) WAS THE OPPOSITE UNTIL THE SAME DAY: the question used to come back on
 * every release, because the recorded answer named the version it was given for.
 * The user asked for that to stop — being asked the same yes/no on every upgrade
 * is a nuisance rather than a decision, and an answer given once (including
 * "no") is the answer. The tests below pin the new rule; see the note in
 * section 3 for exactly which assertion was flipped and why.
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
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false, 'and it is never asked again')
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
// 3. answered once -> never asked again, whatever the version is (2026-11-01)
//
// THIS SECTION REPLACES "a new plugin version asks the question again". That was
// the behaviour until the user reversed it, and the old test pinned the old rule
// exactly; it was FLIPPED ON PURPOSE, not weakened. The old assertion said
// `shouldAskWatchdog(dir, '1.1.0') === true` after an answer recorded for
// '1.0.0'; the rule it named has been deleted from the product, so asserting it
// would now pin a bug. The two things the old test protected are still asserted,
// one each: "a later version is not a new question" (below) and "the answer the
// user gave still governs the arming while nothing re-asks".
// ---------------------------------------------------------------------------

test('a new plugin version does NOT ask again once the user has answered', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '1.0.0' })
    assert.equal(shouldAskWatchdog(dir, '1.1.0'), false, 'the version changed, and it is still not asked')
    // ...and the answer still governs the arming.
    assert.equal(watchdogAllowed(dir, {}), false, 'the answered no is still honoured')
  })
})

// The five cases the product rule is stated in, one test each.

test('never answered at all: it is asked', () => {
  withStateDir((dir) => {
    // No install-choice.json: a fresh profile.
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), true, 'nothing was ever chosen, so ask')
  })
})

test('answered ON: it is not asked again', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: true, askedForPluginVersion: '1.0.0' })
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false, 'the answer is on record, so nothing to ask')
    assert.equal(shouldAskWatchdog(dir, '9.9.9'), false, 'and a very different version does not reopen it')
  })
})

test('answered OFF: it is not asked again either', () => {
  withStateDir((dir) => {
    // "No" is an answer, not a default to re-open on the next upgrade.
    writeInstallChoice(dir, { watchdog: false, askedForPluginVersion: '1.0.0' })
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false, 'the answer is on record, so nothing to ask')
    assert.equal(shouldAskWatchdog(dir, '9.9.9'), false, 'and a very different version does not reopen it')
  })
})

test('answered for an older version: the version change alone does not ask again', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdog: true, askedForPluginVersion: '0.8.7' })
    assert.equal(shouldAskWatchdog(dir, '0.9.0'), false, 'answered 0.8.7, now running 0.9.0: still not asked')
    // The version that was answered for is still RECORDED (it is worth knowing
    // when the question was answered); it just no longer decides anything.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'install-choice.json'), 'utf8'))
    assert.equal(saved.askedForPluginVersion, '0.8.7', 'and the record is kept')
  })
})

test('upgrading from a build that had no watchdog key asks exactly once', () => {
  withStateDir((dir) => {
    // The real shape of an older install: a choice file with no watchdog key.
    fs.writeFileSync(path.join(dir, 'install-choice.json'),
      JSON.stringify({ includePlugins: true, at: '2026-10-26T06:26:16.335Z' }))
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), true, 'never answered before this question existed, so ask')
    // Until the user answers, the same build asks again: only an ANSWER stops it.
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), true, 'unanswered stays unanswered')
    // Once the answer is written down, the next boot of the very same version
    // must not ask: the upgrade is the last time this question is ever seen.
    writeInstallChoice(dir, { watchdog: true, askedForPluginVersion: '1.0.0' })
    assert.equal(shouldAskWatchdog(dir, '1.0.0'), false, 'answered on the upgrade, so the next boot is quiet')
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
