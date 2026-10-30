/**
 * The stale-cookie cleanup must sit BETWEEN the kill and the relaunch.
 *
 * WHY THIS TEST EXISTS:
 *
 * The desktop app mints one `dsh-auth-*` cookie per launch. The name carries
 * the random port, the cookie lives 30 days, and a cookie does NOT carry a
 * port - so the browser sends ALL of them on every request to 127.0.0.1.
 *
 * With 71 of them the request header is 16559 bytes, the host answers 431
 * (Request Header Fields Too Large), and the app dies on startup with the
 * misleading "desktop welcome: Web authentication failed". Measured on this
 * machine: 70 cookies -> 200 OK, 71 cookies -> 431.
 *
 * The cleanup therefore has to run after the kill (Chromium must be gone, or
 * the cookie jar is still locked) and before the relaunch (a fresh launch must
 * start with a fresh jar). A cleanup that runs at the wrong moment either
 * cannot delete anything or deletes too late - and the second one is silent,
 * because the restart still works.
 *
 * So the ORDER is the contract, and it is asserted here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGateScript, buildRestartCommand } from '../lib/restart.js';
import {
  buildCookieClearCommand,
  COOKIE_CLEAR_SCRIPT_NAME,
  cookieClearReportPath,
  readCookieClearReport,
  summarizeCookieClear,
  writeCookieClearReport,
} from '../lib/cookie-clear.js';
import {
  clearCookies,
  run as runCleanup,
} from '../scripts/clear-dsh-auth-cookies.mjs';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(pluginDir, 'scripts', 'clear-dsh-auth-cookies.mjs');

const CLEAR = 'powershell.exe -NoProfile -NonInteractive -Command "$p = Start-Process -FilePath \'C:\\\\node.exe\' -ArgumentList \'C:\\\\scripts\\\\clear-dsh-auth-cookies.mjs\' -WindowStyle Hidden -PassThru; if ($null -ne $p) { if (-not $p.WaitForExit(20000)) { $p.Kill() } }"';
const APP = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';

/** The index of the first line that contains `needle`. @param {string[]} lines @param {string} needle */
function lineIndexOf(lines, needle) {
  return lines.findIndex((line) => line.includes(needle));
}

test('the cleanup runs AFTER the kill and BEFORE the relaunch', () => {
  const script = buildGateScript({ appExePath: APP, gateUrl: 'http://127.0.0.1:1234/', cookieClearCommand: CLEAR });
  const lines = script.split('\r\n');

  const kill = lineIndexOf(lines, 'taskkill /IM "DeepSeek Harness.exe" /T /F');
  const clear = lineIndexOf(lines, 'clear-dsh-auth-cookies.mjs');
  const relaunch = lineIndexOf(lines, '-Command Start-Process -FilePath');

  assert.ok(kill >= 0, 'the kill line is missing');
  assert.ok(clear >= 0, 'the cleanup line is missing');
  assert.ok(relaunch >= 0, 'the relaunch line is missing');

  assert.ok(kill < clear, 'the cleanup must run after the kill: before it the cookie jar is still locked');
  assert.ok(clear < relaunch, 'the cleanup must run before the relaunch: a fresh launch must start with a fresh jar');
});

test('the one-liner command keeps the same order', () => {
  const command = buildRestartCommand({ appExePath: APP, cookieClearCommand: CLEAR });
  const kill = command.indexOf('taskkill /IM "DeepSeek Harness.exe" /T /F');
  const clear = command.indexOf('clear-dsh-auth-cookies.mjs');
  const relaunch = command.indexOf('-Command Start-Process -FilePath');

  assert.ok(kill >= 0, 'the kill step is missing');
  assert.ok(clear >= 0, 'the cleanup step is missing');
  assert.ok(relaunch >= 0, 'the relaunch step is missing');
  assert.ok(kill < clear, 'the cleanup must run after the kill');
  assert.ok(clear < relaunch, 'the cleanup must run before the relaunch');
});

test('without a cleanup command the output is byte for byte the old one', () => {
  const expected = [
    '@echo off',
    'rem dsh-autorestart: wait, re-check the idle gate, then kill + relaunch DeepSeek Harness.',
    'ping -n 5 127.0.0.1 >nul',
    'powershell.exe -NoProfile -NonInteractive -Command "try { $r = Invoke-RestMethod -Uri \'\' -TimeoutSec 5; if ($r.allowRestart -ne $true) { exit 3 } } catch { exit 4 }"',
    'if errorlevel 1 exit /b 0',
    'taskkill /IM "DeepSeek Harness.exe" /T /F',
    'ping -n 3 127.0.0.1 >nul',
    'start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath \'\'',
    '',
  ].join('\r\n');

  assert.equal(buildGateScript(), expected, 'the default gate script must not change');
  assert.equal(buildGateScript({ cookieClearCommand: '' }), expected, 'an empty cleanup command changes nothing');
  assert.equal(buildGateScript({ cookieClearCommand: '   ' }), expected, 'a blank cleanup command changes nothing');
});

test('the one-liner command without a cleanup command is unchanged', () => {
  const expected = 'cmd.exe /c ping -n 5 127.0.0.1 >nul & taskkill /IM "DeepSeek Harness.exe" /T /F '
    + '& start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath \'\'';
  assert.equal(buildRestartCommand(), expected, 'the default one-liner must not change');
  assert.equal(buildRestartCommand({ cookieClearCommand: '' }), expected, 'an empty cleanup command changes nothing');
});

test('the generated script keeps CRLF line endings and carries no byte order mark', () => {
  const script = buildGateScript({ appExePath: APP, gateUrl: 'http://127.0.0.1:1234/', cookieClearCommand: CLEAR });
  assert.ok(script.includes('\r\n'), 'the .cmd must use CRLF');
  assert.equal(script.replace(/\r\n/g, '').includes('\n'), false, 'a bare LF would break the .cmd');
  assert.notEqual(script.charCodeAt(0), 0xfeff, 'the .cmd must not start with a byte order mark');
});

test('the cleanup script exists and stays pure ASCII', () => {
  assert.ok(fs.existsSync(scriptPath), 'scripts/clear-dsh-auth-cookies.mjs is missing');
  const bytes = fs.readFileSync(scriptPath);
  assert.ok(bytes.length > 0, 'the cleanup script is empty');
  for (const byte of bytes) {
    assert.ok(byte < 128, 'the cleanup script must stay pure ASCII (byte ' + byte + ')');
  }
  assert.notEqual(bytes[0], 0xef, 'the cleanup script must not start with a UTF-8 byte order mark');
});

test('the cleanup script only touches the dsh-auth cookies of 127.0.0.1', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(text.includes("'dsh-auth-%'"), 'the cleanup must address the dsh-auth cookies by name');
  assert.ok(text.includes("'127.0.0.1'"), 'the cleanup must address the cookies of 127.0.0.1');
  assert.ok(text.includes('delete from cookies where host_key = ?'), 'the cleanup must delete by host_key');
});

test('the cleanup script never deletes the whole cookie jar', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(!text.includes('unlinkSync'), 'the cleanup must never delete the cookie jar file');
  assert.ok(!text.includes('rmSync'), 'the cleanup must never delete the cookie jar file');
  assert.ok(!text.includes('rm('), 'the cleanup must never delete the cookie jar file');
});

test('the cleanup script always exits with 0 so a restart is never blocked', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(text.includes('process.exit(0)'), 'the cleanup must end with exit code 0');
  assert.ok(text.includes('RETRIES'), 'the cleanup must retry while the jar is still locked');
});

test('the cleanup script writes what it did to a log', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(text.includes('clear-cookies.log'), 'the cleanup must leave a trace in a log file');
});

test('the cleanup command names the cleanup script of THIS plugin', () => {
  const command = buildCookieClearCommand({ pluginDir: pluginDir, execPath: process.execPath, platform: process.platform });
  assert.ok(command !== '', 'the command must be built when the interpreter and the script are there');
  assert.ok(command.includes(COOKIE_CLEAR_SCRIPT_NAME), 'the command must name the cleanup script');
  assert.ok(command.includes('powershell.exe'), 'the command must run through powershell.exe');
  assert.ok(command.includes('WaitForExit'), 'the command must bound how long the cleanup may run');
});

test('without the cleanup script there is no cleanup command', () => {
  const command = buildCookieClearCommand({ pluginDir: path.join(pluginDir, 'there-is-no-such-directory') });
  assert.equal(command, '', 'a missing script must not produce a command that would fail later');
});

// ---------------------------------------------------------------------------
// THE WIDENED MATCH (user decision 2026-10-30): host + name prefix, no path.
//
// The old condition also required `path = '/'`. The official code always writes
// Path=/, so the condition looked safe - and it was one assumption away from
// silently MISSING a cookie. A missed cookie still travels to 127.0.0.1 and
// still counts against the 16 KB header, while deleting one too many costs a
// single re-login.
// ---------------------------------------------------------------------------

test('the delete condition is host + name prefix, and no longer the path', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(
    text.includes('delete from cookies where host_key = ? and name like ?'),
    'the cleanup must delete by host_key and name prefix',
  );
  assert.ok(!text.includes('path = ?'), 'the path must NOT be part of the condition');
  assert.ok(!/\bpath\s*=/.test(text.split('\n').filter((line) => line.includes('delete from')).join('\n')),
    'no path condition may survive in the delete statement');
});

/** A temp directory that is removed afterwards. */
function tempDir(t, label = 'dsh-cookie-clear-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the run is over anyway */
    }
  });
  return dir;
}

/**
 * A cookie jar with the rows this test needs.
 *
 * The real jar is a Chromium SQLite database; only `host_key`, `path` and
 * `name` take part in the condition, so those are the three columns.
 *
 * @returns {Promise<{ok: boolean, jarPath: string, reason: string}>}
 */
async function makeJar(dir) {
  const jarPath = path.join(dir, 'Cookies');
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    return { ok: false, jarPath, reason: 'node:sqlite is not available here: ' + String(error && error.message) };
  }
  const db = new DatabaseSync(jarPath);
  try {
    db.exec('create table cookies (host_key text, path text, name text)');
    const insert = db.prepare('insert into cookies (host_key, path, name) values (?, ?, ?)');
    insert.run('127.0.0.1', '/', 'dsh-auth-aaaaaaaa');
    // THE ONE THE OLD CONDITION MISSED: same host, same prefix, another path.
    insert.run('127.0.0.1', '/deep/link', 'dsh-auth-bbbbbbbb');
    insert.run('127.0.0.1', '/', 'session-other');
    insert.run('127.0.0.1', '/', 'dsh-authish');
    insert.run('example.com', '/', 'dsh-auth-cccccccc');
  } finally {
    db.close();
  }
  return { ok: true, jarPath, reason: '' };
}

/** The rows that are left, as `host|path|name`. */
async function readJar(jarPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(jarPath);
  try {
    return db
      .prepare('select host_key, path, name from cookies order by name')
      .all()
      .map((row) => [row.host_key, row.path, row.name].join('|'));
  } finally {
    db.close();
  }
}

test('a dsh-auth cookie with another path IS deleted; other hosts and prefixes are not', async (t) => {
  const dir = tempDir(t);
  const jar = await makeJar(dir);
  if (jar.ok !== true) {
    t.skip(jar.reason);
    return;
  }
  const result = await clearCookies({ jarPath: jar.jarPath, retries: 1, retryDelayMs: 0 });
  assert.equal(result.ok, true, 'the cleanup must succeed on a writable jar');
  assert.equal(result.removed, 2, 'both dsh-auth cookies of 127.0.0.1 must go, whatever their path');

  const left = await readJar(jar.jarPath);
  assert.deepEqual(
    left.sort(),
    ['127.0.0.1|/|dsh-authish', '127.0.0.1|/|session-other', 'example.com|/|dsh-auth-cccccccc'].sort(),
    'another prefix, another cookie and another host must be untouched',
  );
});

test('a cleanup that cannot open the jar reports a failure instead of pretending', async (t) => {
  const dir = tempDir(t);
  const result = await clearCookies({
    jarPath: path.join(dir, 'no-such-jar'),
    retries: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.removed, 0);
  assert.ok(result.error && result.error !== '', 'a failure must carry a reason');
});

// ---------------------------------------------------------------------------
// THE RESULT IS WRITTEN DOWN (observable / self-proving).
//
// The cleanup runs inside its own process between the kill and the relaunch, so
// it is the only thing that knows how many rows it deleted. It writes
// `last-cookie-clear.json` and the health route reports it. It is NEVER a live
// count: the jar of a running browser is locked.
// ---------------------------------------------------------------------------

test('the cleanup writes its result, and the plugin reads it back', async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  const jar = await makeJar(dir);
  if (jar.ok !== true) {
    t.skip(jar.reason);
    return;
  }
  const outcome = await runCleanup({
    jarPath: jar.jarPath,
    stateDir,
    retries: 1,
    retryDelayMs: 0,
    logFile: path.join(dir, 'clear-cookies.log'),
    now: 1_700_000_000_000,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.removed, 2);
  assert.equal(outcome.reportPath, cookieClearReportPath(stateDir), 'the result must land next to the state');

  const report = JSON.parse(fs.readFileSync(outcome.reportPath, 'utf8'));
  assert.equal(report.at, 1_700_000_000_000);
  assert.equal(report.ok, true);
  assert.equal(report.removed, 2, 'the number of deleted cookies is written down');
  assert.equal(report.reason, '');
  assert.notEqual(
    fs.readFileSync(outcome.reportPath)[0],
    0xef,
    'the result must not start with a byte order mark (it is read with JSON.parse)',
  );

  const read = readCookieClearReport(stateDir);
  assert.equal(read.ok, true);
  const summary = summarizeCookieClear(read.report);
  assert.equal(summary.at, 1_700_000_000_000);
  assert.equal(summary.ok, true);
  assert.equal(summary.removed, 2);
  assert.equal(summary.live, null, 'the live number of cookies must never be reported');
  assert.match(summary.liveNote, /locked/, 'and the reason it cannot be reported is spelled out');
});

test('a failed cleanup is written down as failed, with its reason', async (t) => {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  const outcome = await runCleanup({
    jarPath: path.join(dir, 'no-such-jar'),
    stateDir,
    retries: 1,
    retryDelayMs: 0,
    logFile: path.join(dir, 'clear-cookies.log'),
    now: 1_700_000_000_000,
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.reason !== '', 'the outcome must say why it did not work');
  const read = readCookieClearReport(stateDir);
  assert.equal(read.ok, true);
  assert.equal(read.report.ok, false, 'a failed cleanup must not be recorded as a success');
  assert.ok(String(read.report.reason).length > 0);
  const summary = summarizeCookieClear(read.report);
  assert.equal(summary.ok, false);
});

test('no cleanup yet is its own answer, never a fake success', (t) => {
  const dir = tempDir(t);
  const read = readCookieClearReport(dir);
  assert.equal(read.ok, false);
  assert.equal(read.report, null);
  const summary = summarizeCookieClear(read.report, { readError: read.error });
  assert.equal(summary.ok, null, 'nothing ran yet: not true, not false');
  assert.equal(summary.at, null);
  assert.equal(summary.live, null);
});

test('the result of a cleanup can be written and read without the cleanup itself', (t) => {
  const dir = tempDir(t);
  const written = writeCookieClearReport(dir, { at: 1_700_000_000_000, ok: true, removed: 7, reason: '' });
  assert.equal(written.ok, true);
  const read = readCookieClearReport(dir);
  assert.equal(read.report.removed, 7);
});

test('a broken result file is reported, not thrown', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(cookieClearReportPath(dir), '{ not json', 'utf8');
  const read = readCookieClearReport(dir);
  assert.equal(read.ok, false);
  assert.match(String(read.error), /cannot be parsed/);
  const summary = summarizeCookieClear(read.report, { readError: read.error });
  assert.equal(summary.ok, null);
});

test('the cleanup script keeps the result name the plugin reads', () => {
  const text = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(text.includes('last-cookie-clear.json'), 'the script must write the file the plugin reads');
  assert.ok(text.includes('DSH_AUTORESTART_STATE_DIR'), 'a drill must be able to redirect the state directory');
});
