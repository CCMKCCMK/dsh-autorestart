/**
 * The pure logic of the sentry (`lib/sentry.js`).
 *
 * Every judge here takes its inputs (now, processCount, ...) as arguments, so
 * these tests need no clock, no process table and no real profile: the whole
 * file is a table of situations and the verdict each one must produce.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CLEAN_EXIT_SLACK_MS,
  DEFAULT_GRACE_MS,
  RESCUE_REPORT_FIELDS,
  SENTRY_CONFIG_VERSION,
  SENTRY_DIR_NAME,
  SENTRY_TASK_NAME,
  appendLog,
  buildRescueReport,
  buildSentryConfig,
  countBundles,
  decideRescue,
  isProcessAlive,
  nextBackoffMs,
  parseTasklistOutput,
  patchHasContent,
  profileLooksSanitized,
  readCleanExit,
  readConfig,
  readReport,
  readRestartInFlight,
  sentryPaths,
  splitCsvLine,
  writeCleanExit,
  writeConfig,
  writeReport,
} from '../lib/sentry.js'

/** A temporary directory that is removed afterwards. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sentry-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the run is over anyway */
    }
  })
  return dir
}

/** The situation every `decideRescue` case starts from: gone, long enough. */
function baseCase(overrides = {}) {
  return {
    now: 1_000_000,
    processCount: 0,
    downSince: 1_000_000 - DEFAULT_GRACE_MS - 1000,
    lastSeenRunningAt: 1_000_000 - DEFAULT_GRACE_MS - 5000,
    graceMs: DEFAULT_GRACE_MS,
    cleanExitAt: null,
    watchdogPending: false,
    attemptsInWindow: 0,
    maxRescuesPerHour: 3,
    attemptsThisBurst: 0,
    maxAttempts: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// decideRescue: one test per action, the order of the rules matters.
// ---------------------------------------------------------------------------

test('decideRescue: a running host is idle', () => {
  const verdict = decideRescue(baseCase({ processCount: 2 }))
  assert.equal(verdict.action, 'idle')
  assert.match(verdict.reason, /running/)
})

test('decideRescue: without a "down since" the first round only waits', () => {
  const verdict = decideRescue(baseCase({ downSince: null }))
  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reason, /recorded/)
})

test('decideRescue: inside the grace period it waits', () => {
  const verdict = decideRescue(baseCase({ downSince: 1_000_000 - 1000 }))
  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reason, /grace period/)
})

test('decideRescue: a clean exit stands the sentry down (the user closed it)', () => {
  // The marker is written while the host shuts down, so it is a moment EARLIER
  // than the last time the host was seen alive: the slack covers that.
  const lastSeen = 900_000
  const verdict = decideRescue(baseCase({
    lastSeenRunningAt: lastSeen,
    cleanExitAt: lastSeen - CLEAN_EXIT_SLACK_MS,
  }))
  assert.equal(verdict.action, 'stand-down-intentional')
  assert.match(verdict.reason, /closed on purpose/)
})

test('decideRescue: an OLD clean exit does not protect a later crash', () => {
  const lastSeen = 900_000
  const verdict = decideRescue(baseCase({
    lastSeenRunningAt: lastSeen,
    cleanExitAt: lastSeen - CLEAN_EXIT_SLACK_MS - 1,
  }))
  assert.equal(verdict.action, 'rescue')
})

test('decideRescue: a restart that is already being watched stands it down', () => {
  const verdict = decideRescue(baseCase({ watchdogPending: true }))
  assert.equal(verdict.action, 'stand-down-restart-in-flight')
  assert.match(verdict.reason, /restart is in flight/)
})

test('decideRescue: a spent hourly budget stands it down', () => {
  const verdict = decideRescue(baseCase({ attemptsInWindow: 3, maxRescuesPerHour: 3 }))
  assert.equal(verdict.action, 'stand-down-budget')
  assert.match(verdict.reason, /budget window/)
})

test('decideRescue: a burst that already started the host enough gives up', () => {
  const verdict = decideRescue(baseCase({ attemptsThisBurst: 3, maxAttempts: 3 }))
  assert.equal(verdict.action, 'give-up')
  assert.match(verdict.reason, /does not stay up/)
})

test('decideRescue: otherwise it rescues', () => {
  const verdict = decideRescue(baseCase())
  assert.equal(verdict.action, 'rescue')
  assert.match(verdict.reason, /no rule stands the sentry down/)
})

test('decideRescue: the ORDER is fixed (a clean exit wins over a spent budget)', () => {
  const lastSeen = 900_000
  const verdict = decideRescue(baseCase({
    lastSeenRunningAt: lastSeen,
    cleanExitAt: lastSeen,
    attemptsInWindow: 99,
    attemptsThisBurst: 99,
    watchdogPending: true,
  }))
  assert.equal(verdict.action, 'stand-down-intentional')
})

test('decideRescue: the grace period wins over the clean-exit rule', () => {
  const verdict = decideRescue(baseCase({
    downSince: 1_000_000 - 10,
    cleanExitAt: 1_000_000 - 10,
  }))
  assert.equal(verdict.action, 'wait')
})

test('decideRescue: a restart in flight wins over a spent budget', () => {
  const verdict = decideRescue(baseCase({ watchdogPending: true, attemptsInWindow: 99 }))
  assert.equal(verdict.action, 'stand-down-restart-in-flight')
})

test('decideRescue: always answers with exactly two fields', () => {
  const verdict = decideRescue(baseCase())
  assert.deepEqual(Object.keys(verdict).sort(), ['action', 'reason'])
})

// ---------------------------------------------------------------------------
// tasklist parsing: the sentence, the quoted CSV, the commas inside a cell.
// ---------------------------------------------------------------------------

test('parseTasklistOutput: two processes are counted with their pids', () => {
  const text = [
    '"DeepSeek Harness.exe","4242","Console","1","123,456 K"',
    '"DeepSeek Harness.exe","4243","Console","1","98,765 K"',
    '',
  ].join('\r\n')
  const parsed = parseTasklistOutput(text, 'DeepSeek Harness.exe')
  assert.equal(parsed.count, 2)
  assert.deepEqual(parsed.pids, [4242, 4243])
})

test('parseTasklistOutput: the INFO sentence means ZERO processes', () => {
  const text = 'INFO: No tasks are running which match the specified criteria.\r\n'
  const parsed = parseTasklistOutput(text, 'DeepSeek Harness.exe')
  assert.equal(parsed.count, 0)
  assert.deepEqual(parsed.pids, [])
})

test('parseTasklistOutput: an empty answer means zero processes', () => {
  assert.equal(parseTasklistOutput('', 'x.exe').count, 0)
  assert.equal(parseTasklistOutput(undefined, 'x.exe').count, 0)
  assert.equal(parseTasklistOutput('   \r\n\r\n', 'x.exe').count, 0)
})

test('parseTasklistOutput: another image name is not counted', () => {
  const text = '"other.exe","11","Console","1","1,000 K"\r\n'
  assert.equal(parseTasklistOutput(text, 'DeepSeek Harness.exe').count, 0)
})

test('parseTasklistOutput: a header row is not a process', () => {
  const text = [
    'Image Name,PID,Session Name,Session#,Mem Usage',
    '"DeepSeek Harness.exe","707","Console","1","50,000 K"',
  ].join('\r\n')
  const parsed = parseTasklistOutput(text, 'DeepSeek Harness.exe')
  assert.equal(parsed.count, 1)
  assert.deepEqual(parsed.pids, [707])
})

test('parseTasklistOutput: a duplicated pid counts once', () => {
  const text = '"a.exe","5","Console","1","1 K"\r\n"a.exe","5","Console","1","1 K"\r\n'
  assert.deepEqual(parseTasklistOutput(text, 'a.exe').pids, [5])
})

test('splitCsvLine: quotes, doubled quotes and commas inside a cell', () => {
  assert.deepEqual(splitCsvLine('"a,b","2","say ""hi"""'), ['a,b', '2', 'say "hi"'])
})

// ---------------------------------------------------------------------------
// The bundles of a profile.
// ---------------------------------------------------------------------------

test('countBundles: a healthy package.json lists its bundles', () => {
  const text = JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart', 'other'] } } })
  const parsed = countBundles(text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.bundles, ['dsh-autorestart', 'other'])
})

test('countBundles: an emptied list is empty, not broken', () => {
  const parsed = countBundles(JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.bundles, [])
})

test('countBundles: a package.json without dsh is empty, not broken', () => {
  const parsed = countBundles(JSON.stringify({ name: 'profile' }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.bundles, [])
})

test('countBundles: text that is not JSON is broken', () => {
  const parsed = countBundles('{ not json')
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.bundles, [])
  assert.match(String(parsed.error), /cannot be parsed/)
})

test('countBundles: empty text is broken', () => {
  assert.equal(countBundles('').ok, false)
})

test('countBundles: a byte order mark does not break the parse', () => {
  const text = '\uFEFF' + JSON.stringify({ dsh: { profile: { bundles: ['one'] } } })
  assert.deepEqual(countBundles(text).bundles, ['one'])
})

// ---------------------------------------------------------------------------
// patchHasContent / profileLooksSanitized: the three shapes of 2026-10-30.
// ---------------------------------------------------------------------------

test('patchHasContent: an emptied patch has no content', () => {
  assert.equal(patchHasContent('[]'), false)
  assert.equal(patchHasContent('[]\n'), false)
  assert.equal(patchHasContent('[ ]'), false)
  assert.equal(patchHasContent('   '), false)
  assert.equal(patchHasContent(''), false)
  assert.equal(patchHasContent(null), false)
  assert.equal(patchHasContent('# only a comment\n'), false)
})

test('patchHasContent: a real patch has content', () => {
  assert.equal(patchHasContent('insert:\n  - id: dsh-autorestart\n'), true)
})

test('profileLooksSanitized: a healthy profile is not sanitized', () => {
  const verdict = profileLooksSanitized({
    currentPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    backupPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    currentPatchText: 'insert:\n  - id: dsh-autorestart\n',
    backupPatchText: 'insert:\n  - id: dsh-autorestart\n',
  })
  assert.equal(verdict.sanitized, false)
  assert.match(verdict.reason, /still lists/)
})

test('profileLooksSanitized: bundles emptied while the backup has some', () => {
  const verdict = profileLooksSanitized({
    currentPackageText: JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    backupPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    currentPatchText: 'insert:\n  - id: dsh-autorestart\n',
    backupPatchText: 'insert:\n  - id: dsh-autorestart\n',
  })
  assert.equal(verdict.sanitized, true)
  assert.match(verdict.reason, /bundles is empty/)
})

test('profileLooksSanitized: a package.json that cannot be parsed', () => {
  const verdict = profileLooksSanitized({
    currentPackageText: '{"name": "profile"',
    backupPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
  })
  assert.equal(verdict.sanitized, true)
  assert.match(verdict.reason, /missing or cannot be parsed/)
})

test('profileLooksSanitized: a missing package.json counts as sanitized', () => {
  const verdict = profileLooksSanitized({ currentPackageText: '' })
  assert.equal(verdict.sanitized, true)
})

test('profileLooksSanitized: a patch reduced to [] while the backup has one', () => {
  const verdict = profileLooksSanitized({
    currentPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    backupPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    currentPatchText: '[]\n',
    backupPatchText: 'insert:\n  - id: dsh-autorestart\n',
  })
  assert.equal(verdict.sanitized, true)
  assert.match(verdict.reason, /cordis\.patch\.yml holds nothing/)
})

test('profileLooksSanitized: an empty patch is fine when the backup is empty too', () => {
  const verdict = profileLooksSanitized({
    currentPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    backupPackageText: JSON.stringify({ dsh: { profile: { bundles: ['dsh-autorestart'] } } }),
    currentPatchText: '',
    backupPatchText: '',
  })
  assert.equal(verdict.sanitized, false)
})

// ---------------------------------------------------------------------------
// The backoff.
// ---------------------------------------------------------------------------

test('nextBackoffMs: doubles and caps', () => {
  assert.equal(nextBackoffMs(1), 5000)
  assert.equal(nextBackoffMs(2), 10000)
  assert.equal(nextBackoffMs(3), 20000)
  assert.equal(nextBackoffMs(10), 120000)
  assert.equal(nextBackoffMs(0), 5000)
  assert.equal(nextBackoffMs(-3), 5000)
  assert.equal(nextBackoffMs(Number.NaN), 5000)
})

test('nextBackoffMs: the base and the cap are injected', () => {
  assert.equal(nextBackoffMs(1, { baseMs: 1000, maxMs: 4000 }), 1000)
  assert.equal(nextBackoffMs(2, { baseMs: 1000, maxMs: 4000 }), 2000)
  assert.equal(nextBackoffMs(4, { baseMs: 1000, maxMs: 4000 }), 4000)
  assert.equal(nextBackoffMs(9, { baseMs: 1000, maxMs: 4000 }), 4000)
})

// ---------------------------------------------------------------------------
// The paths and the configuration.
// ---------------------------------------------------------------------------

test('sentryPaths: everything lives in <stateDir>/sentry, outside the profile', () => {
  const stateDir = path.join('C:', 'Users', 'someone', '.dsh', 'storages', 'dsh-autorestart')
  const paths = sentryPaths(stateDir)
  const dir = path.join(stateDir, SENTRY_DIR_NAME)
  assert.equal(paths.dir, dir)
  assert.equal(paths.config, path.join(dir, 'sentry.json'))
  assert.equal(paths.lock, path.join(dir, 'sentry.lock'))
  assert.equal(paths.log, path.join(dir, 'sentry.log'))
  assert.equal(paths.report, path.join(dir, 'last-rescue.json'))
  assert.equal(paths.cleanExit, path.join(dir, 'clean-exit.json'))
  assert.equal(paths.runtime, path.join(dir, 'sentry.js'))
  assert.equal(paths.kit, path.join(dir, 'kit'))
  assert.equal(paths.clearCookiesScript, path.join(dir, 'kit', 'clear-dsh-auth-cookies.mjs'))
  assert.equal(paths.restoreScript, path.join(dir, 'kit', 'restore-profile.ps1'))
  assert.equal(paths.restoreStrings, path.join(dir, 'kit', 'rescue-strings.zh.json'))
  assert.equal(paths.startupCmd, path.join(dir, 'dsh-autorestart-sentry.cmd'))
})

test('buildSentryConfig: the documented defaults', () => {
  const config = buildSentryConfig({
    now: 1_700_000_000_000,
    appExecPath: 'C:\\Program Files\\DSH\\DeepSeek Harness.exe',
    profileDir: 'C:\\Users\\someone\\.dsh\\profiles\\default',
    stateDir: 'C:\\Users\\someone\\.dsh\\storages\\dsh-autorestart',
    nodePath: 'C:\\node\\node.exe',
    portFile: 'C:\\state\\access.json',
  })
  assert.equal(config.version, SENTRY_CONFIG_VERSION)
  assert.equal(config.version, 1)
  assert.equal(config.installedAt, new Date(1_700_000_000_000).toISOString())
  assert.equal(config.appImageName, 'DeepSeek Harness.exe')
  assert.equal(config.intervalMs, 30000)
  assert.equal(config.graceMs, 90000)
  assert.equal(config.startTimeoutMs, 90000)
  assert.equal(config.maxAttempts, 3)
  assert.equal(config.maxRescuesPerHour, 3)
  assert.equal(config.rescueWindowMs, 3600000)
  assert.equal(config.healthPath, '/__dsh_autorestart/health')
  assert.equal(config.portFile, 'C:\\state\\access.json')
})

test('buildSentryConfig: the image name can be given', () => {
  const config = buildSentryConfig({ appExecPath: 'D:\\x\\dsh.exe', appImageName: 'dsh.exe' })
  assert.equal(config.appImageName, 'dsh.exe')
})

test('SENTRY_TASK_NAME is the name every other part expects', () => {
  assert.equal(SENTRY_TASK_NAME, 'dsh-autorestart-sentry')
})

// ---------------------------------------------------------------------------
// The files: configuration, clean exit, report, log.
// ---------------------------------------------------------------------------

test('writeConfig/readConfig: a round trip without a byte order mark', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'sentry.json')
  const config = buildSentryConfig({ now: 1_700_000_000_000, stateDir: dir })
  const written = writeConfig(file, config)
  assert.equal(written.ok, true)
  const bytes = fs.readFileSync(file)
  assert.notEqual(bytes[0], 0xef, 'the configuration must not start with a BOM')
  const read = readConfig(file)
  assert.equal(read.ok, true)
  assert.equal(read.config.graceMs, 90000)
})

test('readConfig: a missing file is an answer, not an exception', (t) => {
  const dir = tempDir(t)
  const read = readConfig(path.join(dir, 'nope.json'))
  assert.equal(read.ok, false)
  assert.equal(read.config, null)
  assert.ok(read.error)
})

test('writeCleanExit/readCleanExit: the marker the plugin writes', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'clean-exit.json')
  const written = writeCleanExit(file, { at: 1_700_000_000_000, reason: 'user-quit' })
  assert.equal(written.ok, true)
  const read = readCleanExit(file)
  assert.equal(read.ok, true)
  assert.equal(read.cleanExit.at, 1_700_000_000_000)
  assert.equal(read.cleanExit.reason, 'user-quit')
})

test('writeReport: the frozen field list is written', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'last-rescue.json')
  const written = writeReport(file, {
    at: 1_700_000_000_000,
    action: 'rescue',
    reason: 'gone',
    cleared: { ok: true },
    restored: { attempted: false, ok: true },
    launched: { ok: true, pid: 7 },
    ready: true,
    errors: [],
    durationMs: 1234,
  })
  assert.equal(written.ok, true)
  const read = readReport(file)
  assert.equal(read.ok, true)
  for (const field of RESCUE_REPORT_FIELDS) {
    assert.ok(field in read.report, 'the report must carry ' + field)
  }
  assert.equal(read.report.ready, true)
  assert.equal(read.report.durationMs, 1234)
})

test('buildRescueReport: a report always has every field', () => {
  const report = buildRescueReport({})
  for (const field of RESCUE_REPORT_FIELDS) {
    assert.ok(field in report, 'the report must carry ' + field)
  }
  assert.equal(report.ready, false)
  assert.deepEqual(report.errors, [])
})

test('appendLog: appends, and a log that grew too big is rotated', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'sentry.log')
  assert.equal(appendLog(file, 'first'), true)
  assert.equal(appendLog(file, 'second'), true)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /second/)

  // Grow it past the limit by hand and append once more: the file is rotated
  // (started over) instead of growing for ever.
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10), 'utf8')
  assert.equal(appendLog(file, 'after-rotation'), true)
  const after = fs.readFileSync(file, 'utf8')
  assert.equal(after.length < 1024 * 1024, true)
  assert.match(after, /after-rotation/)
})

test('appendLog: an unwritable path is reported, never thrown', () => {
  assert.equal(appendLog('', 'x'), false)
})

test('isProcessAlive: this process is alive, pid 0 is not', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(Number.NaN), false)
})

// ---------------------------------------------------------------------------
// "A restart is in flight".
// ---------------------------------------------------------------------------

test('readRestartInFlight: a fresh watchdog pending marker is believed', (t) => {
  const stateDir = tempDir(t)
  fs.writeFileSync(
    path.join(stateDir, 'watchdog-pending.json'),
    JSON.stringify({ at: new Date(1_000_000).toISOString() }),
    'utf8',
  )
  const answer = readRestartInFlight({ stateDir, now: 1_000_000 + 1000 })
  assert.equal(answer.pending, true)
})

test('readRestartInFlight: a stale marker does not block the rescue for ever', (t) => {
  const stateDir = tempDir(t)
  fs.writeFileSync(
    path.join(stateDir, 'watchdog-pending.json'),
    JSON.stringify({ at: new Date(1_000_000).toISOString() }),
    'utf8',
  )
  const answer = readRestartInFlight({ stateDir, now: 1_000_000 + 601_000 })
  assert.equal(answer.pending, false)
  assert.match(answer.reason, /stale/)
})

test('readRestartInFlight: a pending restart verdict is believed', (t) => {
  const stateDir = tempDir(t)
  fs.writeFileSync(
    path.join(stateDir, 'last-restart-verdict.json'),
    JSON.stringify({ result: 'pending', startedAt: new Date(1_000_000).toISOString() }),
    'utf8',
  )
  assert.equal(readRestartInFlight({ stateDir, now: 1_000_000 + 1000 }).pending, true)
})

test('readRestartInFlight: nothing there means nothing in flight', (t) => {
  const stateDir = tempDir(t)
  const answer = readRestartInFlight({ stateDir, now: 1_000_000 })
  assert.equal(answer.pending, false)
})

test('readRestartInFlight: a verdict that is ok is not a restart in flight', (t) => {
  const stateDir = tempDir(t)
  fs.writeFileSync(
    path.join(stateDir, 'last-restart-verdict.json'),
    JSON.stringify({ result: 'ok', startedAt: new Date(1_000_000).toISOString() }),
    'utf8',
  )
  assert.equal(readRestartInFlight({ stateDir, now: 1_000_000 + 1000 }).pending, false)
})
