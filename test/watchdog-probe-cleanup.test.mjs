import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PROBE_TASK_PREFIX } from '../lib/scheduler-capability.js'
import { disarmOnce, disarmWatchdog } from '../lib/watchdog-disarm.js'
import { parseTaskNamesCsv, removeLeftoverProbeTasks } from '../lib/watchdog-schedule.js'
import { readReport, recordDisarmOutcome, writeReport } from '../lib/watchdog.js'

// WHAT THIS FILE PINS (2026-11-01).
//
//   1. The capability probe registers a one-off scheduled task and deletes it as
//      its LAST step, so a crash leaves it behind. Two such tasks were found on
//      the real machine (both `Ready`, neither with a next run time). The boot
//      disarm must clean them up — and must ONLY touch this plugin's own prefix:
//      a wildcard there would put other people's tasks in reach.
//
//   2. A restart that WENT FINE left `last-watchdog-report.json` saying `armed`
//      forever. The ending ("the host is up, the watchdog stood down") belongs in
//      the report, next to — never instead of — the fields readers already use.
//
// Every test here uses an INJECTED executor and a temp directory: the real
// scheduled tasks of this machine are never listed and never deleted.

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-probes-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

/** The names a fake `schtasks /Query /FO CSV /NH` answers with. */
const LISTING = [
  '"dsh-autorestart-capability-probe-4321-abc",N/A,Ready',
  '"dsh-autorestart-capability-probe-8765-def",N/A,Ready',
  // Our prefix WITHOUT the separator: not ours, must never be deleted.
  '"dsh-autorestart-capability-probeNOTOURS",N/A,Ready',
  '"dsh-autorestart-watchdog",N/A,Ready',
  '"Microsoft\\Windows\\Defrag\\ScheduledDefrag",N/A,Ready',
  '"SomeOtherApp",N/A,Disabled',
].join('\r\n')

function fakeExecutor() {
  const deleted = []
  const calls = []
  const exec = (file, args) => {
    calls.push([file, ...args])
    if (args[0] === '/Query') return { ok: true, stdout: LISTING, error: null }
    if (args[0] === '/Delete') {
      deleted.push(args[2])
      return { ok: true, stdout: '', error: null }
    }
    return { ok: false, stdout: '', error: 'unexpected call' }
  }
  return { exec, deleted, calls }
}

test('the probe cleanup removes OUR leftover probe tasks and nothing else', (t) => {
  const { exec, deleted } = fakeExecutor()
  const answer = removeLeftoverProbeTasks({ prefix: PROBE_TASK_PREFIX, exec })

  // Exactly the two probe tasks of this plugin.
  assert.deepEqual(answer.matched, [
    'dsh-autorestart-capability-probe-4321-abc',
    'dsh-autorestart-capability-probe-8765-def',
  ])
  assert.deepEqual(answer.removed, answer.matched)
  assert.deepEqual(deleted, answer.matched, 'only the matched names may ever be deleted')
  assert.equal(answer.ok, true)
  assert.equal(answer.error, null)

  // The negative half, spelled out: the watchdog task, a foreign prefix, a name
  // that merely STARTS with our text, and another vendor's task are untouched.
  for (const name of deleted) {
    assert.equal(name.startsWith(PROBE_TASK_PREFIX + '-'), true)
  }
  for (const name of ['dsh-autorestart-watchdog', 'SomeOtherApp',
    'Microsoft\\Windows\\Defrag\\ScheduledDefrag', 'dsh-autorestart-capability-probeNOTOURS']) {
    assert.equal(deleted.includes(name), false, name + ' must not be deleted')
  }
})

test('THE REAL MACHINE FORMAT: the CSV name has a LEADING BACKSLASH (2026-11-01)', (t) => {
  // Verbatim from this machine's `schtasks /Query /FO CSV /NH`:
  //   "\dsh-autorestart-capability-probe-14264-mvxfr2fo","N/A","Ready"
  //   "\dsh-autorestart-capability-probe-18520-mvxo3eug","N/A","Ready"
  // The root folder is reported with a backslash in front of the name, so a
  // plain startsWith(prefix) matched NOTHING: matched stayed empty, nothing was
  // deleted, and both tasks were still there afterwards. The earlier tests built
  // names WITHOUT the backslash, which is exactly why they were green while the
  // machine was not.
  const REAL = [
    '"\\dsh-autorestart-capability-probe-14264-mvxfr2fo","N/A","Ready"',
    '"\\dsh-autorestart-capability-probe-18520-mvxo3eug","N/A","Ready"',
    // A task inside a FOLDER whose LEAF name looks exactly like ours: it must
    // never be deleted just because the last segment matches.
    '"\\SomeFolder\\dsh-autorestart-capability-probe-x","N/A","Ready"',
    '"\\dsh-autorestart-watchdog","N/A","Ready"',
    '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"',
  ].join('\r\n')

  const deleted = []
  const exec = (file, args) => {
    if (args[0] === '/Query') return { ok: true, stdout: REAL, error: null }
    if (args[0] === '/Delete') {
      deleted.push(args[2])
      return { ok: true, stdout: '', error: null }
    }
    return { ok: false, stdout: '', error: 'unexpected call' }
  }

  const answer = removeLeftoverProbeTasks({ prefix: PROBE_TASK_PREFIX, exec })

  // Both real tasks are matched and deleted — by the name WITHOUT the slash,
  // which is the name they were registered under.
  assert.deepEqual(answer.matched, [
    'dsh-autorestart-capability-probe-14264-mvxfr2fo',
    'dsh-autorestart-capability-probe-18520-mvxo3eug',
  ])
  assert.deepEqual(deleted, answer.matched)
  assert.equal(answer.ok, true)

  // The folder task is refused and REPORTED, not silently dropped. (Every name
  // that still carries a backslash lands here — the Defrag task too — because
  // "inside a folder" is exactly the case this must never delete.)
  assert.equal(answer.skippedFolders.includes('SomeFolder\\dsh-autorestart-capability-probe-x'), true,
    'a task inside a folder must be reported as skipped')
  assert.equal(answer.skippedFolders.includes('Microsoft\\Windows\\Defrag\\ScheduledDefrag'), true)
  assert.equal(answer.skippedFolders.includes('dsh-autorestart-watchdog'), false,
    'a root-level name is not a folder entry')
  for (const name of deleted) {
    assert.equal(name.includes('\\'), false, 'a delete name never carries a folder path')
    assert.equal(name.startsWith(PROBE_TASK_PREFIX + '-'), true)
  }
  // ...and nothing that is not ours was touched.
  for (const foreign of ['SomeFolder\\dsh-autorestart-capability-probe-x',
    'dsh-autorestart-watchdog', 'Microsoft\\Windows\\Defrag\\ScheduledDefrag']) {
    assert.equal(deleted.some((name) => name.includes(foreign)), false, foreign + ' must not be deleted')
  }
})

test('a refused delete is reported, not thrown, and stops nothing', (t) => {
  const exec = (file, args) => {
    if (args[0] === '/Query') return { ok: true, stdout: LISTING, error: null }
    if (args[0] === '/Delete' && args[2] === 'dsh-autorestart-capability-probe-4321-abc') {
      return { ok: false, stdout: '', error: 'Access is denied.' }
    }
    if (args[0] === '/Delete') return { ok: true, stdout: '', error: null }
    return { ok: false, stdout: '', error: 'unexpected' }
  }
  const answer = removeLeftoverProbeTasks({ prefix: PROBE_TASK_PREFIX, exec })
  assert.equal(answer.ok, false)
  assert.deepEqual(answer.removed, ['dsh-autorestart-capability-probe-8765-def'])
  assert.deepEqual(answer.failed, [
    { taskName: 'dsh-autorestart-capability-probe-4321-abc', error: 'Access is denied.' },
  ])
})

test('an unreadable listing is an error, not a silent success', (t) => {
  const exec = () => ({ ok: false, stdout: '', error: 'the task scheduler is not available' })
  const answer = removeLeftoverProbeTasks({ prefix: PROBE_TASK_PREFIX, exec })
  assert.equal(answer.ok, false)
  assert.deepEqual(answer.removed, [])
  // The reason the executor gave is surfaced verbatim: "the scheduler said no"
  // is more useful than a rewrite of it.
  assert.match(String(answer.error), /task scheduler is not available/)
})

test('parseTaskNamesCsv reads the first column and ignores folder rows', () => {
  const names = parseTaskNamesCsv([
    'Folder: \\Microsoft',
    '"a","b"',
    '"with, comma","next"',
    'plain,ignored',
    '',
  ].join('\n'))
  assert.deepEqual(names, ['a', 'with, comma', 'plain'])
})

test('the boot disarm cleans up the probes and records what it did', async (t) => {
  const stateDir = tempDir(t)
  const probes = {
    ok: true,
    prefix: PROBE_TASK_PREFIX,
    matched: ['dsh-autorestart-capability-probe-1-a'],
    removed: ['dsh-autorestart-capability-probe-1-a'],
    failed: [],
    error: null,
  }
  const record = await disarmWatchdog({
    stateDir,
    bootId: 'boot-1',
    removeProbes: () => probes,
    writeRecord: true,
    attempts: 1,
  })
  // The probe cleanup is part of the record...
  assert.deepEqual(record.probes, probes)
  // ...and did not change what "disarmed" means.
  assert.equal(record.ok, true)
  assert.deepEqual(record.errors, [])
})

test('a probe cleanup failure does NOT fail the disarm', async (t) => {
  const stateDir = tempDir(t)
  const record = await disarmWatchdog({
    stateDir,
    bootId: 'boot-2',
    removeProbes: () => ({
      ok: false,
      prefix: PROBE_TASK_PREFIX,
      matched: ['dsh-autorestart-capability-probe-2-b'],
      removed: [],
      failed: [{ taskName: 'dsh-autorestart-capability-probe-2-b', error: 'Access is denied.' }],
      error: null,
    }),
    writeRecord: false,
    attempts: 1,
  })
  assert.equal(record.ok, true, 'a stale probe task is not a failed disarm')
  assert.deepEqual(record.errors, [])
  assert.equal(record.probes.ok, false)
  assert.deepEqual(record.probes.failed, [
    { taskName: 'dsh-autorestart-capability-probe-2-b', error: 'Access is denied.' },
  ])
})

test('disarmOnce hands the probe answer back to its caller', (t) => {
  const stateDir = tempDir(t)
  const answer = disarmOnce({
    stateDir,
    bootId: 'boot-3',
    removeProbes: () => ({
      ok: true, prefix: PROBE_TASK_PREFIX, matched: [], removed: [], failed: [], error: null,
    }),
  })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.probes.removed, [])
})

test('a successful restart writes its ending into the report, next to the old fields', (t) => {
  const stateDir = tempDir(t)
  // The shape the plugin leaves behind when it ARMS the watchdog.
  writeReport(stateDir, {
    at: '2026-11-01T10:00:00.000Z',
    result: 'armed',
    stage: 'flow',
    tier: 'scheduled-task',
    tierReason: 'the probe answered',
    arbiter: 'v2',
    waitedMs: 0,
    rechecked: false,
    restored: false,
    relaunched: false,
    ready: false,
    error: null,
  })

  const merged = recordDisarmOutcome(stateDir, {
    now: Date.parse('2026-11-01T10:05:00.000Z'),
    record: {
      at: '2026-11-01T10:05:00.000Z',
      source: 'boot',
      attempts: 1,
      ok: true,
      scheduleRemoved: true,
      probes: {
        ok: true,
        removed: ['dsh-autorestart-capability-probe-1-a'],
        failed: [],
      },
    },
  })

  const onDisk = readReport(stateDir)
  assert.deepEqual(onDisk, merged, 'the file and the return value must agree')

  // THE ENDING.
  assert.equal(onDisk.hostReady, true)
  assert.equal(onDisk.disarmed, true)
  assert.equal(onDisk.outcome, 'disarmed')
  assert.equal(onDisk.result, 'disarmed')
  assert.equal(onDisk.disarmedAt, '2026-11-01T10:05:00.000Z')

  // THE OLD FIELDS ARE ALL STILL THERE, with their meaning untouched.
  assert.equal(onDisk.tier, 'scheduled-task')
  assert.equal(onDisk.tierReason, 'the probe answered')
  assert.equal(onDisk.arbiter, 'v2')
  assert.equal(onDisk.waitedMs, 0)
  assert.equal(onDisk.restored, false)
  assert.equal(onDisk.relaunched, false)
  assert.equal(onDisk.error, null)
  assert.equal(onDisk.at, '2026-11-01T10:00:00.000Z')
  // And what it said before is readable beside what it says now.
  assert.equal(onDisk.previousResult, 'armed')

  // What the disarm did, including the probe cleanup.
  assert.equal(onDisk.disarm.ok, true)
  assert.equal(onDisk.disarm.scheduleRemoved, true)
  assert.deepEqual(onDisk.disarm.probesRemoved, ['dsh-autorestart-capability-probe-1-a'])
})

test('the ending can be written when there was no report at all', (t) => {
  const stateDir = tempDir(t)
  const merged = recordDisarmOutcome(stateDir, { now: 1793500000000 })
  assert.equal(merged.previousResult, null)
  assert.equal(merged.hostReady, true)
  assert.equal(readReport(stateDir).disarmed, true)
})

test('an old report without the new fields is still readable afterwards', (t) => {
  const stateDir = tempDir(t)
  // A report from an older version: no outcome, no previousResult, no disarm.
  writeReport(stateDir, { at: '2026-10-30T00:00:00.000Z', result: 'ok', ready: true, tier: 'none' })
  const merged = recordDisarmOutcome(stateDir, { now: 1793500000000 })
  assert.equal(merged.at, '2026-10-30T00:00:00.000Z', 'the original timestamp survives')
  assert.equal(merged.tier, 'none')
  assert.equal(merged.previousResult, 'ok')
  assert.equal(merged.disarm, null)
})
