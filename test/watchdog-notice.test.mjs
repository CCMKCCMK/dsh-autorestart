/**
 * THE WATCHDOG NOTICE (2026-11-01, user decision).
 *
 * The install-time popup used to ASK a question: "should the watchdog stay on?"
 * with two buttons ("keep it on" / "no, I will handle it"). That question was
 * wrong on its own terms:
 *
 *   - the watchdog SHIPS WITH THE PLUGIN, so "install it or not" is not a choice
 *     the user has;
 *   - an answer of "no" was then overruled by the settings-page switch anyway,
 *     so the two places contradicted each other.
 *
 * It is a NOTICE now: one "got it" button, shown once, and turning the watchdog
 * off is a settings-page decision (the only place that can do it).
 *
 * Three things must stay true, and they are what this file pins:
 *   1. it is still shown ONCE — acknowledging it stops it for good;
 *   2. acknowledging it does NOT record "the user turned the watchdog off"
 *      (`watchdog` stays untouched; only `watchdogNotified` is written);
 *   3. an OLD file that already carries an answer from the two-button prompt
 *      keeps its meaning: `watchdog: false` still means off.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readInstallChoice, shouldAskWatchdog, watchdogAllowed, writeInstallChoice } from '../index.js'

function withStateDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-notice-'))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('a fresh profile shows the notice, and the watchdog is on', () => {
  withStateDir((dir) => {
    assert.equal(shouldAskWatchdog(dir), true, 'nothing was shown yet')
    assert.equal(watchdogAllowed(dir, {}), true, 'and the watchdog ships on')
  })
})

test('acknowledging the notice records "was told" — not "turned it off"', () => {
  withStateDir((dir) => {
    // This is exactly what the single-button client sends.
    writeInstallChoice(dir, { watchdogNotified: true, askedForPluginVersion: '0.8.6' })

    const choice = readInstallChoice(dir)
    assert.equal(choice.watchdogNotified, true, 'the notice is recorded as shown')
    // THE HEART OF IT: no answer was fabricated. `watchdog` is still unset,
    // because the user was never asked anything.
    assert.equal(choice.watchdog, null, 'no "the user said no" may be written')

    // 1. it does not come back...
    assert.equal(shouldAskWatchdog(dir), false, 'the notice is shown once')
    // 2. ...and the watchdog is still on, because nothing was turned off.
    assert.equal(watchdogAllowed(dir, {}), true, 'telling somebody something does not disable the feature')
  })
})

test('the settings-page switch is still the only way to turn it off', () => {
  withStateDir((dir) => {
    // Acknowledging the notice, then switching it off on the settings page.
    writeInstallChoice(dir, { watchdogNotified: true })
    assert.equal(watchdogAllowed(dir, {}), true)
    writeInstallChoice(dir, { watchdog: false })
    assert.equal(watchdogAllowed(dir, {}), false, 'the config/choice still decides')
    assert.equal(shouldAskWatchdog(dir), false, 'and the notice stays quiet')
  })
})

test('an old "no" from the two-button prompt still means off', () => {
  withStateDir((dir) => {
    // A file written by the previous build: a real answer, and no notice marker.
    fs.writeFileSync(path.join(dir, 'install-choice.json'),
      JSON.stringify({ watchdog: false, askedForPluginVersion: '0.8.5' }))
    assert.equal(watchdogAllowed(dir, {}), false, 'the old answer keeps its meaning')
    assert.equal(shouldAskWatchdog(dir), false, 'and the old prompt is not asked again')
  })
})

test('config watchdogEnabled:false outranks everything', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdogNotified: true })
    assert.equal(watchdogAllowed(dir, { watchdogEnabled: false }), false)
  })
})

test('a second acknowledgement is harmless and keeps the marker', () => {
  withStateDir((dir) => {
    writeInstallChoice(dir, { watchdogNotified: true })
    writeInstallChoice(dir, { askedForPluginVersion: '0.8.6' })
    const choice = readInstallChoice(dir)
    assert.equal(choice.watchdogNotified, true, 'adding another key must not clear the marker')
    assert.equal(shouldAskWatchdog(dir), false)
  })
})
