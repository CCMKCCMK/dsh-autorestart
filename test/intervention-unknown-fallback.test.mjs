/**
 * THE FIRST INCIDENT ON A FRESH INSTALL (user decision, 2026-11-02).
 *
 * A copy is usable when its record says the instance came up with matching content
 * AND that no rescue was needed (`intervention === false`). A machine that nobody
 * ever had to rescue cannot know the second fact yet: a restore report is written
 * when a restore was CONSIDERED, so the first restart's copy says
 * `intervention: null`. Refusing it would leave that machine with no restore point
 * at the one moment it needs one.
 *
 * The fallback that closes that hole is deliberately narrow, and these tests pin
 * every edge of it:
 *   - it fires ONLY when every refusal was `intervention` being unrecorded;
 *   - one copy that was actually rescued keeps the strict answer;
 *   - it takes the newest copy and SAYS that nobody recorded the rescue.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RESTORE_EXCLUSIONS, selectRestoreTarget } from '../lib/watchdog.js'
import { REPORT_NAME, writeReport } from '../lib/watchdog.js'

/** A provable copy whose rescue nobody recorded - the fresh-install shape. */
function unknownCopy(name, at) {
  return {
    dir: '/backups/' + name,
    name,
    at,
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
    intervention: null,
  }
}

/** A provable copy whose boot was NOT rescued. */
function cleanCopy(name, at) {
  return {
    dir: '/backups/' + name,
    name,
    at,
    boot: { started: true, contentMatched: true, observedBy: 'startup-checks' },
    intervention: false,
  }
}

/* ------------------------------------------------------------------ *
 * ② ALL CANDIDATES UNRECORDED + A NON-EMPTY DIRECTORY -> THE NEWEST ONE,
 *    AND THE ANSWER SAYS "unknown" OUT LOUD.
 * ------------------------------------------------------------------ */

test('② when every copy has an unrecorded rescue, the newest one is used and named as unrecorded', () => {
  const choice = selectRestoreTarget({
    // newest first, the order the callers hand over
    candidates: [unknownCopy('2026-11-02T12-00-00-000Z', 300), unknownCopy('2026-11-02T11-00-00-000Z', 200)],
  })

  assert.equal(
    choice.target,
    '/backups/2026-11-02T12-00-00-000Z',
    'the NEWEST copy is used, because a machine that was never rescued looks exactly like this',
  )
  assert.equal(choice.strict, false, 'it is not the strict answer')
  assert.equal(choice.interventionUnknown, true, 'and it is flagged as such for every reader')
  assert.match(String(choice.reason), /intervention unknown/i, 'the reason says the rescue was never recorded')
  assert.match(String(choice.reason), /nobody recorded/i, 'in words a human can act on')
  assert.match(String(choice.notes.join(' ')), /NOBODY RECORDED whether that boot was rescued/,
    'the note is explicit: this copy was NOT verified')
  // The refusal history is still there - nothing is hidden by the fallback.
  assert.equal(choice.excluded.length, 2, 'both refusals stay in the report')
  assert.equal(
    choice.excluded[0].exclusion,
    RESTORE_EXCLUSIONS.INTERVENTION_UNKNOWN,
    'and they say exactly why they were refused',
  )
})

/* ------------------------------------------------------------------ *
 * ③ ONE COPY THAT WAS ACTUALLY RESCUED KEEPS THE STRICT ANSWER.
 * ------------------------------------------------------------------ */

test('③ a copy whose boot WAS rescued blocks the fallback entirely', () => {
  const choice = selectRestoreTarget({
    candidates: [
      { ...unknownCopy('2026-11-02T12-00-00-000Z', 300), intervention: true },
      unknownCopy('2026-11-02T11-00-00-000Z', 200),
    ],
  })

  assert.equal(choice.target, null, 'a rescued boot must never be restored out of a fallback')
  assert.equal(choice.strict, true)
  assert.equal(choice.interventionUnknown, false)
  assert.equal(
    choice.excluded[0].exclusion,
    RESTORE_EXCLUSIONS.INTERVENED,
    'and the refusal names the rescue, not "unknown"',
  )
})

test('③ a copy whose content never came up blocks the fallback too', () => {
  const choice = selectRestoreTarget({
    candidates: [
      { ...unknownCopy('2026-11-02T12-00-00-000Z', 300), boot: { started: true, contentMatched: false } },
      unknownCopy('2026-11-02T11-00-00-000Z', 200),
    ],
  })

  assert.equal(choice.target, null, 'an unproven copy is not a restore point, fallback or not')
  assert.equal(choice.strict, true)
})

test('② a copy with a recorded clean boot still wins over the fallback', () => {
  const choice = selectRestoreTarget({
    candidates: [unknownCopy('2026-11-02T12-00-00-000Z', 300), cleanCopy('2026-11-02T11-00-00-000Z', 200)],
  })

  assert.equal(choice.target, '/backups/2026-11-02T11-00-00-000Z', 'the verified copy is preferred')
  assert.equal(choice.interventionUnknown, false, 'and no fallback was involved')
})

test('② nothing at all is still nothing - the fallback needs a directory', () => {
  const choice = selectRestoreTarget({ candidates: [] })
  assert.equal(choice.target, null)
  assert.equal(choice.strict, true)
  assert.match(String(choice.reason), /no backup at all/)
})

/* ------------------------------------------------------------------ *
 * ① A STAND-DOWN RUN LEAVES A REPORT BEHIND, SO THE NEXT BOOT CAN SAY
 *    "a restore was considered and none happened" -> intervention false.
 * ------------------------------------------------------------------ */

test('① a stand-down run writes the same report file the restore path writes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-standdown-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // The shape a stand-down produces: the field is the same `result`, and the value
  // says "not needed" rather than looking like a failure.
  const report = {
    at: new Date(1_700_000_000_000).toISOString(),
    outcome: 'stand-down',
    result: 'not-needed-reason',
    stage: 'gate',
    restored: [],
    reason: 'the host came up by itself, so nothing was restored',
  }
  writeReport(dir, report) // the writer returns void; the file on disk is the evidence

  const written = path.join(dir, REPORT_NAME)
  assert.equal(fs.existsSync(written), true, 'the STAND-DOWN report exists on disk: ' + REPORT_NAME)
  const parsed = JSON.parse(fs.readFileSync(written, 'utf8'))
  assert.equal(parsed.result, 'not-needed-reason', 'the same schema: a `result` value')
  assert.deepEqual(parsed.restored, [], 'and it says plainly that nothing was restored')
  assert.equal(parsed.outcome, 'stand-down', 'the outcome names the stand-down, it does not pretend to be a failure')
  assert.match(
    String(parsed.reason),
    /nothing was restored|came up/i,
    'so the next boot can read "a restore was considered, none happened" - which is a fact, not silence',
  )
})
