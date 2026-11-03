// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_IMAGE_NAME,
  DEFAULT_RELAUNCH_DELAY_SECONDS,
  DEFAULT_ROLLBACK_COPY_TIMEOUT_MS,
  DEFAULT_ROLLBACK_TIMEOUT_MS,
  DEFAULT_TASK_NAME,
  buildCustomCommand,
  buildGateScript,
  buildRestartCommand,
  buildWatchScript,
  buildWmiRestartCommand,
  detectEnvironment,
  looksLikeWatchScript,
  runCommandNow,
  scheduleDetachedRestart,
  sweepLegacyWatcherScripts,
} from '../lib/restart.js';

const APP_EXE = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
const RUNTIME_NODE =
  'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';

test('detectEnvironment reports the desktop app exe and the host pid chain', () => {
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: APP_EXE,
    pid: 4321,
    ppid: 1234,
    env: {},
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    'appExePath',
    'execPath',
    'hostPid',
    'isDesktopApp',
    'killPid',
    'mainPid',
    'pid',
    'platform',
    'ppid',
  ]);
  assert.equal(environment.platform, 'win32');
  assert.equal(environment.pid, 4321);
  assert.equal(environment.ppid, 1234);
  assert.equal(environment.hostPid, 4321);
  assert.equal(environment.mainPid, 1234);
  assert.equal(environment.killPid, 1234);
  assert.equal(environment.execPath, APP_EXE);
  assert.equal(environment.isDesktopApp, true);
  assert.equal(environment.appExePath, APP_EXE);
});

test('detectEnvironment does not mistake the bundled node of the app for the app', () => {
  // The PATH of this runtime mentions the desktop app — the FILE NAME does not.
  // It is the node the app ships, and a hosted deployment may run with it: it
  // is NOT the desktop app, and it must get a restart command like any other
  // hosted host.
  const environment = detectEnvironment({ platform: 'win32', execPath: RUNTIME_NODE, env: {}, pid: 1, ppid: 2 });
  assert.equal(environment.isDesktopApp, false);
  assert.equal(environment.appExePath, null);
});

test('detectEnvironment judges the desktop app by its FILE NAME, never by its path', () => {
  // 1) The desktop app: the file name IS the app.
  const desktop = detectEnvironment({
    platform: 'win32',
    execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    env: {},
    pid: 1,
    ppid: 2,
  });
  assert.equal(desktop.isDesktopApp, true);
  assert.equal(desktop.appExePath, 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe');

  // 2) The node the app ships: the path mentions the app, the file name does not.
  const bundled = detectEnvironment({ platform: 'win32', execPath: RUNTIME_NODE, env: {}, pid: 1, ppid: 2 });
  assert.equal(bundled.isDesktopApp, false);
  assert.equal(bundled.appExePath, null);

  // 3) A plain node.
  const plain = detectEnvironment({ platform: 'linux', execPath: '/usr/bin/node', env: {}, pid: 1, ppid: 2 });
  assert.equal(plain.isDesktopApp, false);
  assert.equal(plain.appExePath, null);

  // 4) The hyphenated file name is the same app.
  const hyphen = detectEnvironment({
    platform: 'win32',
    execPath: 'C:\\apps\\deepseek-harness.exe',
    env: {},
    pid: 1,
    ppid: 2,
  });
  assert.equal(hyphen.isDesktopApp, true);
  assert.equal(hyphen.appExePath, 'C:\\apps\\deepseek-harness.exe');
});

test('detectEnvironment believes the process tree when the file name cannot answer', () => {
  // The desktop host runs the Electron binary as node: it carries the marker
  // AND its parent is the Electron shell.
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: RUNTIME_NODE,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    pid: 10,
    ppid: 100,
    readChain: () => [{ pid: 100, ppid: 90, imageName: 'DeepSeek Harness.exe', commandLine: '' }],
  });
  assert.equal(environment.isDesktopApp, true);
  // The binary itself is NOT the app launcher: an unknown binary is never
  // started again by the plugin.
  assert.equal(environment.appExePath, null);
});

test('detectEnvironment does not believe a shell that only inherited the marker', () => {
  // A terminal that the desktop app spawned is not the desktop app: the chain
  // leaves the Electron family at the shell.
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: RUNTIME_NODE,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    pid: 10,
    ppid: 100,
    readChain: () => [
      { pid: 100, ppid: 90, imageName: 'powershell.exe', commandLine: '' },
      { pid: 90, ppid: 80, imageName: 'DeepSeek Harness.exe', commandLine: '' },
    ],
  });
  assert.equal(environment.isDesktopApp, false);
  assert.equal(environment.appExePath, null);
});

test('detectEnvironment stays silent when the process tree cannot be read', () => {
  // An unreadable chain is not evidence AGAINST the desktop app: this signal
  // simply says nothing, and the file name keeps the last word.
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: RUNTIME_NODE,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    pid: 10,
    ppid: 100,
    readChain: () => [],
  });
  assert.equal(environment.isDesktopApp, false);

  const desktop = detectEnvironment({
    platform: 'win32',
    execPath: APP_EXE,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    pid: 10,
    ppid: 100,
    readChain: () => [],
  });
  assert.equal(desktop.isDesktopApp, true, 'an unreadable chain never denies the desktop verdict');
});

test('detectEnvironment does not read the process tree when the file name already answers', () => {
  let asked = 0;
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: APP_EXE,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    pid: 10,
    ppid: 100,
    readChain: () => {
      asked += 1;
      return [];
    },
  });
  assert.equal(environment.isDesktopApp, true);
  assert.equal(asked, 0, 'the file name is enough: the process tree is not read');
});

test('detectEnvironment does not pretend a plain node install is the desktop app', () => {
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: 'C:\\nodejs\\node.exe',
    env: {},
    pid: 1,
    ppid: 2,
  });
  assert.equal(environment.isDesktopApp, false);
  assert.equal(environment.appExePath, null);
  assert.equal(environment.killPid, 2);
});

test('buildRestartCommand produces the exact verified detached cmd line', () => {
  const command = buildRestartCommand({ appExePath: APP_EXE });
  const expected =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "${DEFAULT_IMAGE_NAME}" /T /F & start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`;
  assert.equal(command, expected);
  assert.equal(command.includes('& taskkill /IM "DeepSeek Harness.exe" /T /F & start "" '), true);
  assert.ok(
    command.includes("Start-Process -FilePath '" + APP_EXE + "'"),
    'the relaunch goes through ShellExecute, so the host never inherits the helper console',
  );
});

test('buildRestartCommand honours the delay, image name and missing exe', () => {
  assert.equal(buildRestartCommand({ appExePath: APP_EXE, relaunchDelaySeconds: 0 }).includes('ping -n 1 '), true);
  assert.equal(buildRestartCommand({ appExePath: APP_EXE, relaunchDelaySeconds: 9 }).includes('ping -n 10 '), true);
  assert.equal(
    buildRestartCommand({ appExePath: APP_EXE, taskkillImageName: 'Other App.exe' }).includes(
      'taskkill /IM "Other App.exe" /T /F',
    ),
    true,
  );
  const noExe = buildRestartCommand({});
  assert.equal(noExe.includes("Start-Process -FilePath ''"), true);
});

test('buildWmiRestartCommand escapes the cmd line for PowerShell', () => {
  const command = buildRestartCommand({ appExePath: "C:\\O'Brien\\app.exe", relaunchDelaySeconds: 2 });
  const wmi = buildWmiRestartCommand(command);
  assert.equal(wmi.file, 'powershell.exe');
  assert.deepEqual(wmi.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  // Two escaping layers: the inner `Start-Process -FilePath '...'` argument and the
  // outer `CommandLine = '...'` literal the WMI call carries.
  assert.equal(wmi.args[3].includes("O''''Brien"), true);
  assert.equal(wmi.args[3].includes('Invoke-CimMethod -ClassName Win32_Process -MethodName Create'), true);
  assert.equal(wmi.args[3].includes('CommandLine = '), true);
});

test('scheduleDetachedRestart dry-run plans WMI + schtasks without executing', () => {
  const result = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.method, 'wmi');
  assert.equal(result.error, null);

  const expectedCommand =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`;
  assert.equal(result.command, expectedCommand);

  assert.equal(Array.isArray(result.commands), true);
  assert.deepEqual(result.commands.map((entry) => entry.method), ['wmi', 'schtasks-create', 'schtasks-run']);

  // Primary WMI invocation.
  assert.equal(result.commands[0].file, 'powershell.exe');
  assert.equal(result.commands[0].args.includes('-Command'), true);
  assert.equal(result.commands[0].args.join(' ').includes('Invoke-CimMethod'), true);
  assert.equal(result.commands[0].args.join(' ').includes('Win32_Process'), true);
  assert.equal(result.commands[0].args.join(' ').includes('MethodName Create'), true);

  // Fallback one-shot scheduled task.
  assert.deepEqual(result.schtasksCreate, [
    '/Create',
    '/SC',
    'ONCE',
    '/ST',
    '23:59',
    '/TN',
    DEFAULT_TASK_NAME,
    '/TR',
    expectedCommand,
    '/F',
  ]);
  assert.deepEqual(result.schtasksRun, ['/Run', '/TN', DEFAULT_TASK_NAME]);
});

test('scheduleDetachedRestart dry-run refuses to plan a restart without an exe', () => {
  const result = scheduleDetachedRestart({ dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, true);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /appExePath/);
  assert.equal(typeof result.command, 'string');
});

test('scheduleDetachedRestart dry-run honours task name and delay', () => {
  const result = scheduleDetachedRestart({
    appExePath: APP_EXE,
    taskName: 'dsh-autorestart-test',
    relaunchDelaySeconds: 2,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.schtasksCreate.includes('dsh-autorestart-test'), true);
  assert.equal(result.schtasksRun.includes('dsh-autorestart-test'), true);
  assert.equal(result.command.includes('ping -n 3 127.0.0.1'), true);
});

test('runCommandNow dry-run reports the command without spawning', async () => {
  const command = buildRestartCommand({ appExePath: APP_EXE });
  const result = await runCommandNow({ command, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.command, command);
  assert.equal(result.pid, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);

  const missing = await runCommandNow({ dryRun: true });
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.error, 'string');
});

test('buildCustomCommand expands {pid} {ppid} {app} placeholders', () => {
  const command = buildCustomCommand({
    template: 'launch {app} --owner {pid} --parent {ppid}',
    pid: 10,
    ppid: 20,
    appExePath: 'C:\\App.exe',
  });
  assert.equal(command, 'launch C:\\App.exe --owner 10 --parent 20');
  assert.equal(buildCustomCommand({ template: '{pid}-{pid}', pid: 7 }), '7-7');
  assert.equal(buildCustomCommand({ template: '{app}|{pid}', pid: null, appExePath: null }), '|');
  assert.equal(buildCustomCommand({}), '');
  assert.equal(buildCustomCommand({ template: 'plain command' }), 'plain command');
});

test('buildGateScript re-checks the idle gate before killing anything', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const script = buildGateScript({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 4,
    gateUrl,
    taskkillImageName: 'DeepSeek Harness.exe',
  });
  assert.equal(script.includes('\r\n'), true, 'a .cmd script must use CRLF lines');
  assert.equal(script.startsWith('@echo off\r\n'), true);
  assert.equal(script.includes('ping -n 5 127.0.0.1 >nul'), true);
  assert.equal(script.includes(gateUrl), true);
  assert.equal(script.includes('Invoke-RestMethod'), true);
  assert.equal(script.includes('allowRestart'), true);
  const gateIndex = script.indexOf('Invoke-RestMethod');
  const killIndex = script.indexOf('taskkill');
  const startIndex = script.indexOf('start ""');
  assert.ok(gateIndex > 0 && gateIndex < killIndex, 'the gate check must come before taskkill');
  assert.ok(killIndex < startIndex, 'the kill must come before the relaunch');
  assert.equal(script.includes('taskkill /IM "DeepSeek Harness.exe" /T /F'), true);
  assert.equal(script.includes("Start-Process -FilePath '" + APP_EXE + "'"), true);
  assert.equal(script.includes('exit /b 0'), true, 'a denied gate must abort without killing');
  // The delay is the ping count minus one, as in the inline command.
  assert.equal(buildGateScript({ appExePath: APP_EXE, gateUrl, relaunchDelaySeconds: 0 }).includes('ping -n 1 '), true);
});

test('scheduleDetachedRestart gate dry-run plans the helper script without writing it', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const scriptPath = path.join(os.tmpdir(), 'dsh-autorestart-gate-' + process.pid, 'restart-1.cmd');
  const result = scheduleDetachedRestart({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 2,
    gateUrl,
    scriptPath,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.gated, true);
  assert.equal(result.scriptPath, scriptPath);
  assert.equal(result.command, 'cmd.exe /c "' + scriptPath + '"');
  assert.equal(typeof result.script, 'string');
  assert.equal(result.script.includes(gateUrl), true);
  assert.equal(result.script.includes('Invoke-RestMethod'), true);
  assert.equal(result.script.includes('taskkill /IM "DeepSeek Harness.exe" /T /F'), true);
  assert.equal(result.script.includes("Start-Process -FilePath '" + APP_EXE + "'"), true);
  assert.equal(result.commands.length, 3);
  assert.equal(fs.existsSync(scriptPath), false, 'a dry run must write no files');
  assert.equal(fs.existsSync(path.dirname(scriptPath)), false, 'a dry run must create no directories');

  // A gate URL without a script path is refused, never thrown.
  const missing = scheduleDetachedRestart({ appExePath: APP_EXE, gateUrl, dryRun: true });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /scriptPath/);

  // Ungated scheduling keeps the exact inline command.
  const plain = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  assert.equal(plain.gated, false);
  assert.equal(plain.script, null);
  assert.equal(plain.scriptPath, null);
});

// ---------------------------------------------------------------------------
// Rollback watcher: runs right after the relaunch, waits for the host to answer
// its health route, and puts the pre-restart snapshot back when it never does.
// ---------------------------------------------------------------------------

test('buildWatchScript waits for the NEW instance, rolls the snapshot back and starts nothing', () => {
  const script = buildWatchScript({
    healthUrl: 'http://127.0.0.1:51004/__dsh_autorestart/health',
    healthPath: '/__dsh_autorestart/health',
    portFile: 'C:/state/access.json',
    expectedBootId: 'boot-old',
    outcomeFile: 'C:/state/restart-outcome.json',
    backupDir: 'C:/state/backups/2026-10-25T12-00-00-000Z',
    profileDir: 'C:/Users/x/.dsh/profiles/desktop',
    reportPath: 'C:/state/last-rollback.json',
    appExePath: APP_EXE,
    timeoutMs: 90000,
    rollbackTimeoutMs: 120000,
    since: '2026-10-25T12:00:00.000Z',
    selfCleanPaths: ['C:/state/restart-3-watch.ps1', 'C:/state/restart-3.cmd'],
  });

  assert.equal(script.includes('\r\n'), true, 'the watcher uses CRLF lines');
  assert.ok(script.includes('Invoke-RestMethod'), 'it polls the health route');
  assert.ok(script.includes('AddMilliseconds(90000)'), 'it honours the configured timeout');

  // THE PORT OF THE NEW INSTANCE, not the port of the old one: the desktop app
  // listens on a random port, so the old one is worthless.
  assert.ok(script.includes("'C:/state/access.json'"), 'it reads the instance record');
  assert.ok(script.includes("'boot-old'"), 'it knows the boot id of the instance it replaces');
  assert.ok(
    script.includes("'http://127.0.0.1:' + $record.port + $healthPath"),
    'the health URL is built from the port the NEW instance published',
  );
  assert.ok(script.includes('$record.bootId -ne $expected'), 'it waits for a DIFFERENT instance');

  // The restore is bounded: a robocopy that hangs is given up.
  assert.ok(script.includes('robocopy $src $dst /E'), 'it restores the configuration files');
  assert.ok(script.includes('robocopy $src $dst /MIR'), 'it restores the plugin tree');
  assert.ok(script.includes('Wait-Job $job -Timeout 120'), 'the restore has a time limit');
  assert.ok(script.includes('Stop-Job $job'), 'a restore that hangs is stopped');
  assert.ok(script.includes('rollbackError'), 'the reason is written into the report');

  assert.ok(script.includes('last-rollback.json'), 'it writes the report where the plugin reads it');
  assert.ok(
    script.includes('UTF8Encoding($false)'),
    'the report must be written without a BOM (the plugin parses it with JSON.parse)',
  );
  assert.ok(script.includes('[datetime]'), 'the crash log is filtered to this restart');

  // NO SECOND COPY OF THE HOST. The old behaviour launched a second app next
  // to the one that was already starting up.
  assert.equal(
    script.includes('Start-Process'),
    false,
    'the rollback branch must not start a second copy of the host',
  );
  assert.ok(script.includes('appStarted = $false'), 'the report says that nothing was started');

  // The watcher cleans up after itself.
  assert.ok(script.includes('Remove-Item -LiteralPath $p -Force'), 'it removes its helper files');
  assert.ok(script.includes("'C:/state/restart-3-watch.ps1'"), 'the watcher script is cleaned up');
  assert.ok(script.includes("'C:/state/restart-3.cmd'"), 'the gate script is cleaned up');

  // The marker of a decision the plugin made itself.
  assert.ok(script.includes('$marker.decided -eq $true'), 'it stands down when the plugin decided');

  assert.equal(DEFAULT_ROLLBACK_TIMEOUT_MS, 90000);
  assert.equal(DEFAULT_ROLLBACK_COPY_TIMEOUT_MS, 120000);
});

test('the gated helper runs the watcher only after the relaunch', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const watchPath = 'C:/state/restart-3-watch.ps1';
  const script = buildGateScript({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 2,
    gateUrl,
    watchScriptPath: watchPath,
  });
  const startIndex = script.indexOf('start ""');
  const watchIndex = script.indexOf('powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File');
  assert.ok(startIndex > 0, 'the relaunch is still there');
  assert.ok(watchIndex > startIndex, 'the watcher starts after the relaunch');
  assert.ok(
    script.includes('powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File'),
    'the watcher runs as its own hidden process, so the helper console closes right away',
  );
  assert.ok(script.includes(watchPath));

  const plain = buildGateScript({ appExePath: APP_EXE, relaunchDelaySeconds: 2, gateUrl });
  assert.equal(plain.includes('ExecutionPolicy'), false, 'without a watcher the helper is unchanged');
});

test('a planned restart refuses a watcher path without its text', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const scriptPath = path.join(os.tmpdir(), 'dsh-ar-watch-dry', 'restart-1.cmd');
  const watchScriptPath = path.join(os.tmpdir(), 'dsh-ar-watch-dry', 'restart-1-watch.ps1');

  const missing = scheduleDetachedRestart({
    appExePath: APP_EXE,
    gateUrl,
    scriptPath,
    watchScriptPath,
    dryRun: true,
  });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /watchScript/);

  const planned = scheduleDetachedRestart({
    appExePath: APP_EXE,
    gateUrl,
    scriptPath,
    watchScriptPath,
    watchScript: '# watcher',
    dryRun: true,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.watchScriptPath, watchScriptPath);
  assert.ok(String(planned.script).includes(watchScriptPath));
  assert.equal(fs.existsSync(path.dirname(scriptPath)), false, 'a dry run still writes nothing');
});

/* ------------------------------------------------------------------ *
 * THE FILES THE OLD BUILDS LEFT BEHIND (2026-11-02).
 *
 * Every build before this one wrote `restart-<n>-watch.ps1` on EVERY platform.
 * The script is PowerShell, so on Linux/WSL it could never run — it just stayed
 * on disk. A real WSL machine had seven of them (restart-4/5/6/7/8/9/16), which
 * is why "leftover files = 0" was failing before a release.
 *
 * The sweep is deliberately narrow: name + content + age, and never on Windows.
 * ------------------------------------------------------------------ */

/** A body that looks like the watcher `buildWatchScript` writes. */
const WATCH_SCRIPT_BODY = [
  'param(',
  '  [string] $PortFile = ""',
  ')',
  '$ErrorActionPreference = "Stop"',
  'Start-Sleep -Seconds 4',
  '# dsh-autorestart: put the known-good copy back',
].join('\n');

/** Make a state directory with the given files (name → body). */
function sweepFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-sweep-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  // Backdate everything: a file written a moment ago is protected on purpose.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const name of Object.keys(files)) fs.utimesSync(path.join(dir, name), old, old);
  return dir;
}

test('the non-Windows sweep removes ONLY the watcher scripts the plugin left behind', (t) => {
  const dir = sweepFixture({
    'restart-4-watch.ps1': WATCH_SCRIPT_BODY,
    'restart-16-watch.ps1': WATCH_SCRIPT_BODY,
    // Same name, but NOT our script (a user's own file): kept.
    'restart-99-watch.ps1': 'Write-Host "my own script"\n',
    // Our script's name is not this one: kept.
    'last-watchdog-report.json': '{"result":"armed"}',
    'state.json': '{}',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = sweepLegacyWatcherScripts(dir, { platform: 'linux' });

  assert.deepEqual(result.removed.sort(), ['restart-16-watch.ps1', 'restart-4-watch.ps1']);
  assert.deepEqual(result.kept.sort(), ['restart-99-watch.ps1']);
  assert.equal(result.scanned, 3, 'only the three matching names were even looked at');
  assert.equal(result.skipped, false);
  assert.equal(result.error, null);
  // The files are really gone, the others really are not.
  assert.equal(fs.existsSync(path.join(dir, 'restart-4-watch.ps1')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restart-16-watch.ps1')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restart-99-watch.ps1')), true);
  assert.equal(fs.existsSync(path.join(dir, 'last-watchdog-report.json')), true);
});

test('a watcher script written a moment ago is left alone (a process may be starting)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'restart-17-watch.ps1'), WATCH_SCRIPT_BODY, 'utf8');

  const result = sweepLegacyWatcherScripts(dir, { platform: 'linux' });
  assert.deepEqual(result.removed, [], 'nothing is removed in the first minute');
  assert.deepEqual(result.kept, ['restart-17-watch.ps1']);
  assert.equal(fs.existsSync(path.join(dir, 'restart-17-watch.ps1')), true);
});

test('the sweep does nothing at all on Windows', (t) => {
  const dir = sweepFixture({ 'restart-4-watch.ps1': WATCH_SCRIPT_BODY });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = sweepLegacyWatcherScripts(dir, { platform: 'win32' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /Windows/);
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(path.join(dir, 'restart-4-watch.ps1')), true, 'on Windows the file stays');
});

test('a missing state directory is not an error, and looksLikeWatchScript is strict', () => {
  const missing = sweepLegacyWatcherScripts(path.join(os.tmpdir(), 'dsh-does-not-exist-' + Date.now()), {
    platform: 'linux',
  });
  assert.equal(missing.skipped, true);
  assert.equal(missing.error, null, 'a directory that does not exist yet is not a failure');

  assert.equal(looksLikeWatchScript(WATCH_SCRIPT_BODY), true);
  assert.equal(looksLikeWatchScript('Write-Host "hi"'), false, 'no param()/Start-Sleep/marker: not ours');
  assert.equal(looksLikeWatchScript(''), false);
});