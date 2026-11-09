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
  HELPER_SCRIPT_PATTERN,
  RESTART_WINDOW_BACKGROUND,
  RESTART_WINDOW_CHOICES,
  RESTART_WINDOW_FOREGROUND,
  WINDOW_SHIM_PATTERN,
  buildCustomCommand,
  buildGateScript,
  buildHiddenPowerShellCommand,
  buildRestartCommand,
  buildWatchScript,
  buildWindowShimScript,
  buildWmiRestartCommand,
  detectEnvironment,
  looksLikeGateHelper,
  looksLikeWatchScript,
  looksLikeWindowShim,
  normalizeRestartWindow,
  relaunchCommandLine,
  runCommandNow,
  scheduleDetachedRestart,
  sweepLegacyWatcherScripts,
  sweepRestartHelpers,
  sweepWindowShims,
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

/* ------------------------------------------------------------------ *
 * THERE IS NO WINDOW-STYLE OPTION (measured, 2026-11-09).
 *
 * `-WindowStyle Minimized` was tried and removed: it really lands on the command
 * line (the `.cmd` proves it) but the host ignores it — DSH is an Electron app
 * and decides for itself how its window shows up, and the launcher has no window
 * flag of its own. These tests pin that the option is GONE, so nobody re-adds a
 * switch that cannot work.
 * ------------------------------------------------------------------ */

test('the relaunch command carries no window style and every restart step is intact', () => {
  const legacy =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`;

  const byDefault = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  assert.equal(byDefault.command, legacy, 'the restart command is byte for byte the command of 0.9.4');
  assert.equal(byDefault.launchCommand, legacy);
  // The removed option must not come back through the properties either.
  assert.equal(Object.prototype.hasOwnProperty.call(byDefault, 'launch'), false, 'there is no launch mode any more');
  assert.equal(/Minimized/.test(byDefault.command), false, 'the command never asks for a minimized window');

  // A stale key in somebody's profile is NOT an option: the planner ignores it.
  const staleKey = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true, restartLaunch: 'minimized' });
  assert.equal(staleKey.command, legacy, 'an unknown restartLaunch key must change nothing at all');
  assert.equal(staleKey.ok !== false, true, 'and it must never fail the plan');

  assert.equal(
    relaunchCommandLine(APP_EXE),
    `start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`,
  );
  // The helper keeps working with the window mode; only the host window style is gone.
  const shim = 'C:/state/restart-42-window.vbs';
  const background = scheduleDetachedRestart({
    appExePath: APP_EXE,
    dryRun: true,
    restartWindow: 'background',
    restartLaunch: 'minimized',
    shimPath: shim,
  });
  assert.equal(background.launchCommand, `wscript.exe //B "${shim}"`);
  assert.equal(background.window, 'background');
  assert.equal(/Minimized/.test(background.shimScript), false, 'the shim must not carry a dead flag either');
});

/* ------------------------------------------------------------------ *
 * THE RESTART WINDOW (user decision, 2026-11-09).
 *
 * `foreground` is the behaviour this plugin always had: the helper `.cmd` runs
 * in a visible console window. `background` starts the SAME helper through a
 * VBScript shim — `wscript.exe //B <shim>`, `Run <cmd>, 0, False` — so no
 * window is created at all and a full-screen app is never switched away from.
 * The foreground command line must stay byte for byte what it was.
 * ------------------------------------------------------------------ */

test('the window mode falls back to foreground for anything that is not "background"', () => {
  assert.deepEqual(RESTART_WINDOW_CHOICES, ['foreground', 'background']);
  assert.equal(normalizeRestartWindow('background'), RESTART_WINDOW_BACKGROUND);
  assert.equal(normalizeRestartWindow('foreground'), RESTART_WINDOW_FOREGROUND);
  for (const value of [undefined, null, '', 'Background', 'BACKGROUND', ' window ', 1, true, {}]) {
    assert.equal(
      normalizeRestartWindow(value),
      RESTART_WINDOW_FOREGROUND,
      `an illegal value (${String(value)}) must fall back instead of throwing`,
    );
  }
});

test('the foreground launch command is byte for byte the command of 0.9.5', () => {
  const legacy =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`;

  const byDefault = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  const explicit = scheduleDetachedRestart({
    appExePath: APP_EXE,
    dryRun: true,
    restartWindow: 'foreground',
  });
  const illegal = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true, restartWindow: 'nonsense' });

  for (const result of [byDefault, explicit, illegal]) {
    assert.equal(result.command, legacy, 'the logical restart command never changes');
    assert.equal(result.launchCommand, legacy, 'foreground hands exactly that command to the scheduler');
    assert.equal(result.launcher, 'foreground');
    assert.equal(result.window, 'foreground');
    assert.equal(result.shimPath, null);
    assert.equal(result.shimScript, null);
    assert.equal(result.fallbackReason, null);
    // The schedulers receive the SAME string they always received.
    assert.equal(result.schtasksCreate[result.schtasksCreate.indexOf('/TR') + 1], legacy);
  }
  // The two modes agree on the command they start; only the launcher differs.
  assert.equal(byDefault.command, explicit.command);
});

test('buildWindowShimScript runs the helper hidden, without waiting, and deletes itself', () => {
  const command = `cmd.exe /c ping -n 3 127.0.0.1 >nul & taskkill /IM "DeepSeek Harness.exe" /T /F`;
  const script = buildWindowShimScript(command);

  assert.equal(script.includes('\r\n'), true, 'a .vbs shim uses CRLF lines');
  assert.match(script, /Option Explicit/);
  assert.match(script, /Set shell = CreateObject\("WScript\.Shell"\)/);
  // THE TWO PROMISES: hidden window (0) and no waiting (False).
  assert.match(script, /shell\.Run commandLine, 0, False/);
  // The command line is carried as doubled-quote VBScript chunks, so a quote or
  // an `&` in the helper needs no second escaping layer.
  assert.ok(script.includes('cmd.exe /c ping -n 3 127.0.0.1 >nul & taskkill /IM ""DeepSeek Harness.exe"" /T /F'));
  // VBScript lines are limited to 1023 characters: the command is chunked.
  const longest = Math.max(...script.split('\r\n').map((line) => line.length));
  assert.ok(longest < 900, `no VBScript line may get near the 1023 limit, longest was ${longest}`);
  // THE SHIM CLEANS UP AFTER ITSELF.
  assert.match(script, /fso\.DeleteFile WScript\.ScriptFullName, True/);
  assert.equal(looksLikeWindowShim(script), true);
  assert.equal(looksLikeWindowShim('MsgBox "hello"'), false);
});

test('background mode plans a flash-free launcher and writes the shim', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-window-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shimPath = path.join(dir, 'restart-7-window.vbs');

  const planned = scheduleDetachedRestart({
    appExePath: APP_EXE,
    dryRun: true,
    restartWindow: 'background',
    shimPath,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.window, 'background');
  // THE FLASH IS GONE (user report, 2026-11-09): the host is started by the shim
  // through Shell.Application.ShellExecute — `wscript.exe` is a GUI process, so no
  // console exists at all. `powershell -WindowStyle Hidden` created one first.
  assert.equal(planned.launcher, 'wscript', 'the shim is still the launcher (and the settings page reads this)');
  assert.equal(planned.relaunch, 'shell-execute', 'and the HOST is started without any console');
  assert.equal(planned.relaunchFallback, 'powershell-hidden', 'the fallback is NAMED, not merely implemented');
  assert.equal(planned.launchCommand, 'wscript.exe //B "' + shimPath + '"');
  assert.equal(planned.shimPath, shimPath);
  assert.ok(String(planned.shimScript).includes(', 0, False'));
  assert.equal(fs.existsSync(shimPath), false, 'a dry run writes no shim');
  // The scheduled task runs the shim, never the visible helper command.
  assert.equal(planned.schtasksCreate[planned.schtasksCreate.indexOf('/TR') + 1], planned.launchCommand);
  assert.notEqual(planned.launchCommand, planned.command);

  // THE RELAUNCH STEP INSIDE THE HELPER asks the shim, in `launch` mode.
  assert.match(planned.command, new RegExp('wscript\\.exe //B "' + shimPath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '" launch'));
  // …and the flashy shape is NOT in it any more: no PowerShell starts the host.
  assert.equal(/powershell\.exe -WindowStyle Hidden -NoProfile -Command Start-Process/.test(planned.command), false,
    'background mode must not start the host through powershell: ' + planned.command);

  // Background mode without a place to write the shim falls back LOUDLY.
  const noShim = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true, restartWindow: 'background' });
  assert.equal(noShim.launcher, 'powershell-hidden');
  assert.equal(noShim.relaunch, 'powershell-hidden', 'no shim = the flashy path, and the report says so');
  assert.match(String(noShim.fallbackReason), /shim/i);
  assert.match(noShim.launchCommand, /powershell\.exe .* -WindowStyle Hidden -EncodedCommand /);
});

test('the shim carries the ShellExecute launch and its PowerShell fallback', () => {
  const shim = buildWindowShimScript('cmd.exe /c echo hi', {
    appExePath: APP_EXE,
    watchScriptPath: 'C:/state/restart-7-watch.ps1',
  });

  // THE FLASH-FREE LAUNCH: Shell.Application.ShellExecute(File, Arguments, Directory, Verb, Show).
  assert.match(shim, /Set app = CreateObject\("Shell\.Application"\)/);
  assert.match(shim, /app\.ShellExecute launchTarget, "", "", "open", 1/);
  assert.ok(shim.includes(APP_EXE), 'the shim knows which exe to start');
  // THE REAL FALLBACK: when ShellExecute is refused the hidden PowerShell line runs.
  assert.match(shim, /shell\.Run launchFallback, 0, False/);
  assert.ok(shim.includes(`powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '${APP_EXE}'`));
  // THE WATCHER IS STARTED THE SAME WAY: `start "" powershell …` flashed too.
  assert.match(shim, /shell\.Run watchCommand, 0, False/);
  assert.ok(
    shim.includes('powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File ""C:/state/restart-7-watch.ps1""'),
    'the watcher command is carried as a doubled-quote VBScript literal',
  );
  // Mode dispatch: no argument = run the helper; `launch` / `watch` = the two steps.
  assert.match(shim, /If WScript\.Arguments\.length = 0 Then/);
  assert.match(shim, /mode = LCase\(WScript\.Arguments\(0\)\)/);
  assert.equal(looksLikeWindowShim(shim), true, 'the sweep must still recognise its own file');
  // A shim built without an exe (unit call) must not pretend it can launch: the
  // launch branch is GUARDED on a non-empty target, so the dead line is harmless.
  const bare = buildWindowShimScript('cmd.exe /c echo hi');
  assert.match(bare, /launchTarget = ""/, 'no exe means no launch target');
  assert.match(bare, /If mode = "launch" And launchTarget <> "" Then/, 'and the launch branch is guarded');
});

test('the PowerShell fallback starts the SAME command line with no console window', () => {
  const command = `cmd.exe /c ping -n 3 127.0.0.1 >nul & taskkill /IM "DeepSeek Harness.exe" /T /F`;
  const line = buildHiddenPowerShellCommand(command);
  assert.match(line, /^powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand /);
  const encoded = line.slice(line.indexOf('-EncodedCommand ') + '-EncodedCommand '.length);
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(decoded.includes("$cmd = 'cmd.exe /c ping -n 3"), 'the command line is carried verbatim');
  assert.match(decoded, /\$psi\.FileName = 'cmd\.exe'/);
  assert.match(decoded, /\$psi\.Arguments = '\/c ' \+ \$cmd/);
  assert.match(decoded, /\$psi\.CreateNoWindow = \$true/);
  assert.match(decoded, /\$psi\.UseShellExecute = \$false/);
  // ASCII only: the command line travels through WMI/schtasks unquoted.
  assert.equal(/^[\x20-\x7e]+$/.test(line), true);
});

test('the helper sweep removes OLD .cmd and .vbs of ours, keeps foreign and fresh files, and counts them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-helper-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = buildWindowShimScript('cmd.exe /c echo hi');
  // The real gate helper text (what a restart actually leaves behind).
  const helper = buildGateScript({
    appExePath: APP_EXE,
    gateUrl: 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1',
  });
  const files = {
    // OURS, old: the 351-file pile the real machine had.
    'restart-546.cmd': helper,
    'restart-545.cmd': helper,
    'restart-3-window.vbs': shim,
    // A .cmd with our name but NOT our content: a user's file — kept.
    'restart-9.cmd': 'echo this is my own script\r\n',
    // A .vbs that is not ours: kept.
    'restart-9-window.vbs': 'MsgBox "my own script"',
    // Neither name matches: never looked at.
    'restart-4-watch.ps1': WATCH_SCRIPT_BODY,
    'restart.cmd': helper,
    'restart-x.cmd': helper,
    'restart-5.cmd.bak': helper,
    'notes.txt': 'hello',
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const name of Object.keys(files)) fs.utimesSync(path.join(dir, name), old, old);

  const result = sweepRestartHelpers(dir);
  assert.deepEqual(result.removed.sort(), ['restart-3-window.vbs', 'restart-545.cmd', 'restart-546.cmd']);
  assert.deepEqual(result.removedCmd.sort(), ['restart-545.cmd', 'restart-546.cmd'], 'the gate helpers go');
  assert.deepEqual(result.removedVbs, ['restart-3-window.vbs'], 'the shim goes too');
  assert.deepEqual(result.kept.sort(), ['restart-9-window.vbs', 'restart-9.cmd'], 'foreign content is never touched');
  assert.equal(result.scanned, 5, 'only the five matching names were even looked at');
  assert.equal(result.failed, 0);
  assert.equal(result.error, null);
  // The files are really gone; nothing else was touched.
  assert.equal(fs.existsSync(path.join(dir, 'restart-546.cmd')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restart-545.cmd')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restart-3-window.vbs')), false);
  for (const name of ['restart-9.cmd', 'restart-9-window.vbs', 'restart-4-watch.ps1', 'restart.cmd', 'restart-x.cmd', 'restart-5.cmd.bak', 'notes.txt']) {
    assert.equal(fs.existsSync(path.join(dir, name)), true, name + ' must survive the sweep');
  }

  // A file written a moment ago is protected: cmd.exe may still be reading it.
  fs.writeFileSync(path.join(dir, 'restart-547.cmd'), helper, 'utf8');
  fs.writeFileSync(path.join(dir, 'restart-5-window.vbs'), shim, 'utf8');
  const fresh = sweepRestartHelpers(dir);
  assert.deepEqual(fresh.removed, [], 'nothing is removed inside the 60 s window');
  assert.deepEqual(fresh.kept.sort(), ['restart-5-window.vbs', 'restart-547.cmd', 'restart-9-window.vbs', 'restart-9.cmd']);
  assert.equal(fresh.scanned, 4);

  // The name patterns are strict, and the old export sweeps BOTH kinds too
  // (it used to sweep only the .vbs).
  assert.equal(HELPER_SCRIPT_PATTERN.test('restart-546.cmd'), true);
  assert.equal(HELPER_SCRIPT_PATTERN.test('restart-546-window.vbs'), false);
  assert.equal(HELPER_SCRIPT_PATTERN.test('restart-546.cmd.bak'), false);
  assert.equal(WINDOW_SHIM_PATTERN.test('restart-546-window.vbs'), true);
  assert.equal(looksLikeGateHelper(helper), true);
  assert.equal(looksLikeGateHelper('echo hi'), false);
  fs.utimesSync(path.join(dir, 'restart-547.cmd'), old, old);
  fs.utimesSync(path.join(dir, 'restart-5-window.vbs'), old, old);
  const viaOldName = sweepWindowShims(dir);
  assert.deepEqual(
    viaOldName.removed.sort(),
    ['restart-5-window.vbs', 'restart-547.cmd'],
    'the old name must not silently go back to sweeping only the .vbs',
  );
});

test('a missing state directory is not an error for the helper sweep', () => {
  const missing = sweepRestartHelpers(path.join(os.tmpdir(), 'dsh-no-such-dir-' + Date.now()));
  assert.deepEqual(missing.removed, []);
  assert.equal(missing.scanned, 0);
  assert.equal(missing.error, null, 'a directory that does not exist yet is not a failure');
  assert.deepEqual(sweepRestartHelpers('').removed, []);
});

test('the background mode is recorded in the watcher report, foreground keeps its bytes', () => {
  const base = {
    healthUrl: 'http://127.0.0.1:51004/__dsh_autorestart/health',
    portFile: 'C:/state/access.json',
    outcomeFile: 'C:/state/restart-outcome.json',
    backupDir: 'C:/state/backups/old',
    profileDir: 'C:/Users/x/.dsh/profiles/desktop',
    reportPath: 'C:/state/last-rollback.json',
    lockFile: 'C:/state/rollback.lock',
  };
  const foreground = buildWatchScript(base);
  const background = buildWatchScript({
    ...base,
    windowMode: 'background',
    launcher: 'wscript',
    launchFallback: '',
    shimPath: 'C:/state/restart-7-window.vbs',
  });
  assert.equal(foreground.includes('$launchLauncher'), false, 'foreground keeps the old script verbatim');
  assert.equal(background.includes("$launchLauncher = 'wscript'"), true);
  assert.match(background, /; window = \$launchWindow; launcher = \$launchLauncher/);
  assert.ok(background.includes("$launchShim = 'C:/state/restart-7-window.vbs'"));
});