/**
 * THE WATCHDOG HAS TO BE ABLE TO RUN AT ALL.
 *
 * On 2026-10-30 the watchdog never executed a single line. The one-off Windows
 * task it was registered under named the DESKTOP CLIENT as the interpreter
 * (`DeepSeek Harness.exe`) and wrapped the whole thing in `cmd /c "..." "..."`:
 *
 *   - a scheduled task inherits the user environment, which does NOT carry
 *     `ELECTRON_RUN_AS_NODE=1`, so the client executable started a SECOND COPY
 *     OF THE CLIENT instead of running the script as node;
 *   - cmd.exe strips the outer pair of six quotes, so the first token ended at
 *     `...\Programs\DeepSeek` and the task exited with 9009.
 *
 * The report kept saying `armed` while nothing watched anything. These tests
 * are about the two rules that came out of it:
 *
 *   1. the task runs a REAL node interpreter, RESOLVED (lib/node-runtime.js),
 *      never `process.execPath`; when there is no node, the registration is
 *      REFUSED with a reason instead of falling back to the client;
 *   2. the task XML carries the program in `<Command>` and the script plus its
 *      arguments in `<Arguments>`: no cmd.exe in between, so nothing can strip
 *      a quote. Paths with spaces survive untouched.
 *
 * The last section drives the real CLI (`scripts/watchdog.mjs`) and checks that
 * EVERY way out of it leaves a report behind.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildScheduledTaskXml,
  buildWatchdogTaskCommand,
  planTaskCommand,
  quoteArgv,
  registerScheduledTask,
  resolveWatchdogInterpreter,
  splitCommandLine,
} from '../lib/watchdog-schedule.js';
import { BUNDLED_NODE_RELATIVE_PATH } from '../lib/node-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
const cliPath = path.join(pluginDir, 'scripts', 'watchdog.mjs');

/** The executable the DESKTOP APP reports as `process.execPath`. */
const HOST_EXE = 'C:\\Users\\Some One\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
/** The node interpreter that ships with the installation. */
const BUNDLED_NODE = path.join(
  'C:\\Users\\Some One\\AppData\\Local\\Programs\\DeepSeek Harness',
  ...BUNDLED_NODE_RELATIVE_PATH,
);

/** Every directory this file created, so a FAILING test cannot leak one. */
const createdDirs = [];

/**
 * A directory of its own for every test (the name carries a SPACE on purpose).
 *
 * It is REGISTERED here, not only removed by the test itself: a test that
 * throws before its cleanup used to leave its state directory in %TEMP% for
 * ever (the residue check of the drill found exactly that).
 */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh watchdog ' + label + ' '));
  createdDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory that cannot be removed is not a test failure.
    }
  }
});

/**
 * Parse a Windows command line the way Windows itself does
 * (`CommandLineToArgvW`), so a stripped or doubled quote cannot pass unnoticed.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseWindowsCommandLine(text) {
  const args = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
    if (index >= text.length) break;
    let argument = '';
    let quoted = false;
    while (index < text.length) {
      const character = text[index];
      if (!quoted && (character === ' ' || character === '\t')) break;
      if (character === '"') {
        quoted = !quoted;
        index += 1;
        continue;
      }
      if (character === '\\') {
        let count = 0;
        while (index < text.length && text[index] === '\\') {
          count += 1;
          index += 1;
        }
        if (index < text.length && text[index] === '"') {
          argument += '\\'.repeat(count >> 1);
          if (count % 2 === 1) {
            argument += '"';
            index += 1;
          } else {
            index += 1;
            quoted = !quoted;
          }
        } else {
          argument += '\\'.repeat(count);
        }
        continue;
      }
      argument += character;
      index += 1;
    }
    args.push(argument);
  }
  return args;
}

/** The `<Command>`/`<Arguments>` of a generated task description. */
function taskParts(xml) {
  // The XML escapes the quotes and the ampersands; the task scheduler reads the
  // DECODED text, so the assertions have to look at the same thing Windows does.
  const decode = (value) => String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const command = /<Command>([^<]*)<\/Command>/.exec(xml);
  const arguments_ = /<Arguments>([^<]*)<\/Arguments>/.exec(xml);
  return {
    command: command === null ? '' : decode(command[1]),
    arguments: arguments_ === null ? '' : decode(arguments_[1]),
  };
}

/** What an `existsSync` stub answers with. */
function onlyThese(existing) {
  const wanted = existing.map((entry) => String(entry).toLowerCase());
  return (candidate) => wanted.includes(String(candidate).toLowerCase());
}

// ---------------------------------------------------------------------------
// 1. THE INTERPRETER: a resolved node, never the client executable
// ---------------------------------------------------------------------------

test('the client executable is resolved to the node of the installation', () => {
  const answer = resolveWatchdogInterpreter({
    execPath: HOST_EXE,
    platform: 'win32',
    env: { Path: '' },
    existsSyncFn: onlyThese([BUNDLED_NODE]),
  });
  assert.equal(answer.ok, true, answer.reason);
  assert.equal(answer.path, BUNDLED_NODE, 'the interpreter is the node that ships with the installation');
  assert.equal(answer.source, 'install-dir');
  assert.notEqual(answer.path, HOST_EXE, 'the application executable is never the interpreter');
});

test('without a bundled node the node of the PATH is used', () => {
  const fromPath = 'C:\\tools\\nodejs\\node.exe';
  const answer = resolveWatchdogInterpreter({
    execPath: HOST_EXE,
    platform: 'win32',
    env: { Path: 'C:\\Windows;C:\\tools\\nodejs' },
    existsSyncFn: onlyThese([fromPath]),
  });
  assert.equal(answer.ok, true, answer.reason);
  assert.equal(answer.path, fromPath);
  assert.equal(answer.source, 'path');
  assert.notEqual(answer.path, HOST_EXE);
});

test('a node process is its own interpreter', () => {
  const answer = resolveWatchdogInterpreter({
    execPath: 'C:\\tools\\nodejs\\node.exe',
    platform: 'win32',
    env: { Path: '' },
    existsSyncFn: () => false,
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.path, 'C:\\tools\\nodejs\\node.exe');
  assert.equal(answer.source, 'process');
});

test('NO node anywhere: the answer is a REFUSAL with a reason, not the client', () => {
  const answer = resolveWatchdogInterpreter({
    execPath: HOST_EXE,
    platform: 'win32',
    env: { Path: '' },
    existsSyncFn: () => false,
  });
  assert.equal(answer.ok, false, 'a missing interpreter is a refusal, never a stand-in');
  assert.equal(answer.path, '');
  assert.match(answer.reason, /node/i, 'the refusal says what is missing');
  assert.match(answer.reason, /never used as a stand-in/, 'and that the client is not used instead');
  assert.ok(Array.isArray(answer.tried) && answer.tried.length > 0, 'and where it looked');
});

// ---------------------------------------------------------------------------
// 2. THE TASK: <Command> is the interpreter, <Arguments> the script, no cmd
// ---------------------------------------------------------------------------

test('the registered task runs node directly (the 9009 command line, fixed)', () => {
  const dir = tempDir('plan');
  const script = path.join(pluginDir, 'scripts', 'watchdog.mjs');
  const stateDir = path.join(dir, 'state dir');
  // EXACTLY the string index.js used to hand to the task scheduler.
  const legacy = '"' + HOST_EXE + '" "' + script + '" --state-dir "' + stateDir + '"';
  const plan = planTaskCommand(legacy, {
    execPath: HOST_EXE,
    platform: 'win32',
    env: { Path: '' },
    existsSyncFn: onlyThese([BUNDLED_NODE]),
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.form, 'exec', 'no shell in between: cmd.exe is what ate the quotes');
  assert.equal(plan.file, BUNDLED_NODE, 'the program of the task is a real node');
  assert.deepEqual(plan.args, [script, '--state-dir', stateDir], 'the script and its arguments are the arguments');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the XML of that task has no cmd and keeps the spaces of every path', () => {
  const dir = tempDir('xml');
  const script = path.join(dir, 'watchdog script.mjs');
  const stateDir = path.join(dir, 'the state dir');
  const command = buildWatchdogTaskCommand({
    scriptPath: script,
    args: ['--state-dir', stateDir],
    execPath: HOST_EXE,
    platform: 'win32',
    env: { Path: '' },
    existsSyncFn: onlyThese([BUNDLED_NODE]),
  });
  assert.equal(command.ok, true, command.reason);
  const xml = buildScheduledTaskXml({
    startIso: '2026-10-30T19:00:00',
    endIso: '2026-10-30T19:30:00',
    command,
  });
  const parts = taskParts(xml);
  assert.doesNotMatch(xml, /<Command>\s*cmd\s*<\/Command>/i, 'there is no cmd.exe wrapper any more');
  assert.equal(parts.command, BUNDLED_NODE, '<Command> is the absolute interpreter path');
  // Windows splits <Arguments> itself: parsing it back proves nothing was
  // stripped, which is exactly what cmd.exe did to the old command line.
  assert.deepEqual(
    parseWindowsCommandLine(parts.arguments),
    [script, '--state-dir', stateDir],
    'the arguments survive the round trip with their spaces',
  );
  assert.ok(parts.arguments.includes('"' + script + '"'), 'the script path is quoted because it has spaces');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real path of THIS machine with a space survives the task XML', () => {
  // A REAL directory of this machine, not a made-up one: the path of the
  // running node carries no space, so the space is added where it hurts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh watchdog real space '));
  const script = path.join(pluginDir, 'scripts', 'watchdog.mjs');
  const plan = planTaskCommand(
    { file: process.execPath, args: [script, '--state-dir', dir] },
    { execPath: process.execPath, platform: process.platform, env: process.env },
  );
  assert.equal(plan.ok, true, plan.reason);
  const xml = buildScheduledTaskXml({ startIso: '2026-10-30T19:00:00', endIso: '2026-10-30T19:30:00', command: plan });
  const parts = taskParts(xml);
  assert.doesNotMatch(xml, /<Command>\s*cmd\s*<\/Command>/i);
  assert.match(dir, / /, 'the directory really carries a space');
  assert.deepEqual(parseWindowsCommandLine(parts.arguments), [script, '--state-dir', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing interpreter REFUSES the registration (nothing is registered)', () => {
  const dir = tempDir('refuse');
  const xmlPath = path.join(dir, 'task.xml');
  const calls = [];
  const written = [];
  const result = registerScheduledTask({
    taskName: 'dsh-autorestart-watchdog',
    startIso: '2026-10-30T19:00:00',
    endIso: '2026-10-30T19:30:00',
    command: '"' + HOST_EXE + '" "watchdog.mjs" --state-dir "' + dir + '"',
    xmlPath,
    exec: (file, args) => { calls.push(args[0]); return { ok: true, stdout: '', error: null }; },
    writeFile: (target, content) => written.push({ target, content }),
    removeFile: () => {},
    planOptions: { execPath: HOST_EXE, platform: 'win32', env: { Path: '' }, existsSyncFn: () => false },
  });
  assert.equal(result.ok, false, 'a task that would run the client is refused');
  assert.match(String(result.error), /node/i, 'and the reason names the missing interpreter');
  assert.deepEqual(calls, [], 'schtasks was never called');
  assert.equal(written.length, 0, 'and nothing was written to the machine');
  assert.equal(result.steps.at(-1).kind, 'plan', 'the refusal happens at the planning step');
  assert.equal(result.steps.at(-1).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a command line that needs a shell keeps one (the drill scripts)', () => {
  // `echo ... > file` cannot be run without cmd.exe, and the drill of this
  // plugin registers exactly such a task on purpose.
  const plan = planTaskCommand('echo fired > "C:\\tmp\\fired.txt"', { platform: 'win32' });
  assert.equal(plan.ok, true);
  assert.equal(plan.form, 'shell');
  assert.equal(plan.file, 'cmd');
  assert.deepEqual(plan.args.slice(0, 1), ['/c']);
});

test('a command line is split the way a shell splits it', () => {
  assert.deepEqual(splitCommandLine('"a b" c "d"'), ['a b', 'c', 'd']);
  assert.deepEqual(splitCommandLine('  spaced   out  '), ['spaced', 'out']);
  assert.deepEqual(splitCommandLine(''), []);
  assert.equal(quoteArgv(['a b', 'c']), '"a b" "c"');
});

// ---------------------------------------------------------------------------
// 3. THE CLI: every way out of it leaves a report
// ---------------------------------------------------------------------------

/** The field names every report must carry (added to, never removed from). */
const REPORT_FIELDS = [
  'at',
  'result',
  'tier',
  'tierReason',
  'arbiter',
  'waitedMs',
  'rechecked',
  'healthCheck',
  'healthDetail',
  'health',
  'extraRound',
  'restored',
  'relaunched',
  'ready',
  'error',
];

/** Run the watchdog CLI. */
function runCli(args, options = {}) {
  return spawnSync(process.execPath, [options.cli || cliPath, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
  });
}

/**
 * Run the watchdog CLI WITHOUT blocking this process.
 *
 * `spawnSync` freezes the event loop of the test, and the fake host of this
 * test lives in that event loop: it could never answer, and the watchdog would
 * (correctly) conclude that nothing is alive.
 *
 * @param {string[]} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runCliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the CLI: no pending marker still leaves a report (t1: it left nothing)', () => {
  const dir = tempDir('cli-empty');
  const result = runCli(['--state-dir', dir]);
  assert.equal(result.status, 0, result.stderr);
  const reportPath = path.join(dir, 'last-watchdog-report.json');
  assert.ok(fs.existsSync(reportPath), 'the report exists even when there was nothing to watch');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.result, 'skipped');
  assert.equal(report.stage, 'config');
  assert.match(String(report.reason), /pending/, 'the report says what was missing');
  for (const field of REPORT_FIELDS) {
    assert.ok(field in report, 'the report keeps the field ' + field);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI: a plugin that cannot be loaded writes a failure report (stage import)', () => {
  // A copy of the CLI in a directory WITHOUT lib/: the relative imports cannot
  // resolve, which is the "the plugin directory is gone" case.
  const dir = tempDir('cli-import');
  const copy = path.join(dir, 'scripts');
  fs.mkdirSync(copy, { recursive: true });
  fs.copyFileSync(cliPath, path.join(copy, 'watchdog.mjs'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const result = runCli(['--state-dir', stateDir], { cli: path.join(copy, 'watchdog.mjs') });
  assert.equal(result.status, 1, 'a watchdog that cannot load the plugin fails loudly');
  assert.ok(result.stderr.trim() !== '', 'and says why on stderr');
  const reportPath = path.join(stateDir, 'last-watchdog-report.json');
  assert.ok(fs.existsSync(reportPath), 'the failure report is on the disk, before the process exits');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.result, 'failed');
  assert.equal(report.stage, 'import');
  assert.ok(String(report.error).length > 0, 'the error says what could not be loaded');
  assert.equal(report.attempts, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI: a refusal NEVER overwrites the report of a real rescue (finding F3)', () => {
  const home = tempDir('cli-refusal');
  const refusalDir = path.join(home, 'refusals');
  // The report of a REAL rescue that happened earlier, in the default state
  // directory the CLI would otherwise write into.
  const defaultState = path.join(home, '.dsh', 'storages', 'dsh-autorestart');
  fs.mkdirSync(defaultState, { recursive: true });
  const reportPath = path.join(defaultState, 'last-watchdog-report.json');
  const rescueBytes = Buffer.from(
    JSON.stringify({ result: 'recovered', at: '2026-10-30T10:00:00.000Z', marker: 'a real rescue' }, null, 2),
    'utf8',
  );
  fs.writeFileSync(reportPath, rescueBytes);

  const result = runCli([], {
    env: {
      USERPROFILE: home,
      HOME: home,
      APPDATA: home,
      DSH_WATCHDOG_STATE_DIR: '',
      DSH_WATCHDOG_REFUSAL_DIR: refusalDir,
    },
  });
  assert.equal(result.status, 2, 'it refuses to run without a state directory');
  assert.match(result.stderr, /state directory/, 'and stderr says why');

  // THE POINT OF THE WHOLE FINDING: the rescue report is byte for byte the same.
  assert.ok(fs.existsSync(reportPath), 'the rescue report is still there');
  assert.deepEqual(
    fs.readFileSync(reportPath),
    rescueBytes,
    'the refusal must not touch last-watchdog-report.json',
  );

  // AND THE REASON IS STILL READABLE, in a file of its own.
  const refusalPath = path.join(refusalDir, 'dsh-autorestart-watchdog-refusal.json');
  assert.ok(fs.existsSync(refusalPath), 'the refusal leaves a record of its own');
  const refusal = JSON.parse(fs.readFileSync(refusalPath, 'utf8'));
  assert.equal(refusal.result, 'skipped');
  assert.equal(refusal.stage, 'config');
  assert.match(String(refusal.error), /state directory/);
  assert.match(String(refusal.note), /must not overwrite last-watchdog-report\.json/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the CLI: a refusal does not CREATE a report in the default state directory', () => {
  const home = tempDir('cli-refusal-fresh');
  const refusalDir = path.join(home, 'refusals');
  const result = runCli([], {
    env: {
      USERPROFILE: home,
      HOME: home,
      APPDATA: home,
      DSH_WATCHDOG_STATE_DIR: '',
      DSH_WATCHDOG_REFUSAL_DIR: refusalDir,
    },
  });
  assert.equal(result.status, 2);
  const reportPath = path.join(home, '.dsh', 'storages', 'dsh-autorestart', 'last-watchdog-report.json');
  assert.equal(
    fs.existsSync(reportPath),
    false,
    'a run that never started must not create a rescue report at all',
  );
  assert.ok(fs.existsSync(path.join(refusalDir, 'dsh-autorestart-watchdog-refusal.json')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('the CLI: a pending marker it cannot read is REPORTED, not treated as "nothing to watch" (finding F4)', () => {
  const dir = tempDir('cli-corrupt-pending');
  // A marker that exists but does not parse (a half-written file: the process
  // was killed while the plugin wrote it).
  fs.writeFileSync(path.join(dir, 'watchdog-pending.json'), '{"tier": "scheduled-task"', 'utf8');
  const result = runCli(['--state-dir', dir]);
  assert.equal(result.status, 2, 'a marker that cannot be read is a refusal, not a quiet exit 0');
  assert.match(result.stderr, /cannot be read/, 'stderr says what is wrong');
  const reportPath = path.join(dir, 'last-watchdog-report.json');
  assert.ok(fs.existsSync(reportPath), 'the reason is written down as well');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.result, 'failed');
  assert.equal(report.stage, 'config');
  assert.match(String(report.error), /exists but cannot be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI: a BOM-prefixed pending marker is real work, not an empty run', () => {
  const dir = tempDir('cli-bom-pending');
  // PowerShell 5.1 writes UTF-8 WITH a BOM: before the fix this read as "no
  // marker", the scheduling item was removed and the process exited 0.
  fs.writeFileSync(
    path.join(dir, 'watchdog-pending.json'),
    '\uFEFF' + JSON.stringify({
      version: 1,
      tier: 'scheduled-task',
      taskName: 'dsh-autorestart-watchdog',
      snapshotDir: path.join(dir, 'snapshot'),
      profileDir: path.join(dir, 'profile'),
      healthUrl: '',
      healthPath: '/__dsh_autorestart/health',
      timeoutMs: 0,
      recheckMs: 0,
      readyTimeoutMs: 0,
      maxAttempts: 1,
      arbiter: 'v2',
    }),
    'utf8',
  );
  const result = runCli(['--state-dir', dir]);
  const reportPath = path.join(dir, 'last-watchdog-report.json');
  assert.ok(fs.existsSync(reportPath), 'the run leaves a report');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  // It must NOT be the "no pending marker" answer: the marker was read.
  assert.notEqual(
    String(report.error || ''),
    'no pending marker: there was nothing to watch',
    'a BOM-prefixed marker must not be reported as absent',
  );
  assert.notEqual(result.status, 2, 'and it must not refuse (the marker was readable)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI: a host that answers the health route stops the rescue and is reported', async () => {
  const dir = tempDir('cli-healthy');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    fs.writeFileSync(
      path.join(dir, 'watchdog-pending.json'),
      JSON.stringify({
        version: 1,
        tier: 'scheduled-task',
        taskName: 'dsh-autorestart-watchdog',
        snapshotDir: path.join(dir, 'snapshot'),
        profileDir: path.join(dir, 'profile'),
        healthUrl: 'http://127.0.0.1:' + port + '/__dsh_autorestart/health',
        healthPath: '/__dsh_autorestart/health',
        timeoutMs: 0,
        recheckMs: 0,
        readyTimeoutMs: 0,
        maxAttempts: 1,
        arbiter: 'v2',
      }),
      'utf8',
    );
    const result = await runCliAsync(['--state-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'last-watchdog-report.json'), 'utf8'));
    // A host that answers is a host that must not be touched: the CLI asks its
    // health route through the real HTTP probe and stands down.
    assert.equal(report.result, 'abandoned', 'a host that answers is never restored');
    assert.match(String(report.error), /alive/);
    assert.equal(report.stage, 'flow');
    assert.equal(report.attempts, 0, 'nothing was started at all');
    assert.equal(report.relaunched, false);
    assert.equal(report.restored, false);
    for (const field of REPORT_FIELDS) {
      assert.ok(field in report, 'the report keeps the field ' + field);
    }
    assert.ok('cookieClear' in report, 'the new fields are there as well');
    assert.ok(Array.isArray(report.attemptLog));
    assert.equal(fs.existsSync(path.join(dir, 'watchdog-pending.json')), false, 'the marker goes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
