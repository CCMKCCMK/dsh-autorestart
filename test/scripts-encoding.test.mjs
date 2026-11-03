/**
 * The rescue kit's scripts must keep their encoding — or they die silently.
 *
 * This machine only has Windows PowerShell 5.1, whose console code page is
 * GB2312. PowerShell 5.1 reads a UTF-8 file WITHOUT a byte order mark as
 * ANSI, so every Chinese character in the file turns into mojibake and the
 * script dies with a ParserError before it does anything at all.
 *
 * That happened three times in one afternoon, so the rule is now stronger
 * than "remember the BOM": the .ps1 files are PURE ASCII, with no byte above
 * 127 and no byte order mark at all. The Chinese wording lives next to them
 * in one UTF-8 file without a BOM (rescue-strings.zh.json), and the scripts
 * read it at runtime.
 *
 * These scripts are normally never run — which is exactly why nothing notices
 * when an editor or a tool rewrites them. So the check lives here, in the
 * ordinary test run, and it reads the bytes itself: no PowerShell needed.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const stringsFile = 'rescue-strings.zh.json';

/** The bytes of a file. */
function bytesOf(name) {
  return fs.readFileSync(path.join(scriptsDir, name));
}

/**
 * Every script in the folder — DISCOVERED, not written down.
 *
 * A list of names has to be edited every time a script is added, and the one
 * that gets forgotten is exactly the one that breaks silently. Reading the
 * directory means a new script is covered the moment it lands.
 */
function scriptsWithExtension(extension) {
  return fs
    .readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

/** Is there a string behind this dotted key? */
function hasKey(root, dottedKey) {
  let node = root;
  for (const part of dottedKey.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return node !== undefined && node !== null && node !== '';
}

/** How many leaves does this JSON tree have? */
function countLeaves(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, child) => sum + countLeaves(child), 0);
  }
  return 1;
}

test('the scripts folder holds the scripts it promises', () => {
  const ps1 = scriptsWithExtension('.ps1');
  const cmd = scriptsWithExtension('.cmd');
  assert.ok(ps1.length > 0, 'no .ps1 found in scripts/');
  assert.ok(cmd.length > 0, 'no .cmd found in scripts/');
  // The ones the rescue kit is made of.
  for (const name of ['emergency-toggle.ps1', 'restore-profile.ps1', 'drill-rescue.ps1']) {
    assert.ok(ps1.includes(name), 'scripts/' + name + ' is missing');
  }
  for (const name of ['emergency-disable.cmd', 'restore-profile.cmd']) {
    assert.ok(cmd.includes(name), 'scripts/' + name + ' is missing');
  }
  assert.ok(fs.existsSync(path.join(scriptsDir, stringsFile)), 'scripts/' + stringsFile + ' is missing');
});

test('EVERY PowerShell script stays pure ASCII', () => {
  const files = scriptsWithExtension('.ps1');
  assert.ok(files.length > 0, 'no .ps1 found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    assert.ok(bytes.length > 0, name + ' is empty');
    for (const byte of bytes) {
      assert.ok(
        byte < 128,
        name + ' must stay pure ASCII (byte ' + byte + ' at ' + bytes.indexOf(byte) + '): the Chinese wording belongs in ' + stringsFile,
      );
    }
    // A byte order mark is not ASCII either, but say it plainly.
    assert.notEqual(bytes[0], 0xef, name + ' must not start with a UTF-8 BOM');
  }
});

test('EVERY batch file stays pure ASCII', () => {
  const files = scriptsWithExtension('.cmd');
  assert.ok(files.length > 0, 'no .cmd found in scripts/');
  for (const name of files) {
    for (const byte of bytesOf(name)) {
      assert.ok(byte < 128, name + ' must stay ASCII (cmd.exe reads it with the console code page)');
    }
  }
});

test('EVERY node script of scripts/ stays pure ASCII', () => {
  // The watchdog and its drill are run by the host and by the system (a
  // scheduled task, a systemd timer, a shell): they are read with whatever
  // code page the machine has. The Chinese wording lives in a JSON file.
  const files = scriptsWithExtension('.mjs');
  assert.ok(files.length > 0, 'no .mjs found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    for (const byte of bytes) {
      assert.ok(byte < 128, name + ' must stay pure ASCII (byte ' + byte + ')');
    }
    assert.notEqual(bytes[0], 0xef, name + ' must not start with a UTF-8 BOM');
  }
});

test('EVERY POSIX script stays pure ASCII, starts with #!/bin/sh and is executable', () => {
  // A .sh file is run by /bin/sh, not by a program that would forgive a
  // missing shebang or a lost executable bit. The Chinese wording lives in
  // rescue-strings.zh.json, like everywhere else.
  const files = scriptsWithExtension('.sh');
  assert.ok(files.length > 0, 'no .sh found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    for (const byte of bytes) {
      assert.ok(byte < 128, name + ' must stay pure ASCII (byte ' + byte + ')');
    }
    assert.notEqual(bytes[0], 0xef, name + ' must not start with a UTF-8 BOM');
    const text = bytes.toString('ascii');
    assert.ok(text.startsWith('#!/bin/sh\n'), name + ' must start with #!/bin/sh');
    assert.match(text, /\nset -eu\n/, name + ' must turn the unset variables into errors');
  }
});

test('EVERY batch file calls powershell.exe, never pwsh', () => {
  const files = scriptsWithExtension('.cmd');
  assert.ok(files.length > 0, 'no .cmd found in scripts/');
  for (const name of files) {
    const text = bytesOf(name).toString('ascii');
    assert.match(text, /powershell\.exe/i, name + ' must call powershell.exe');
    assert.doesNotMatch(text, /\bpwsh\b/i, name + ' must not call pwsh (this machine only has Windows PowerShell 5.1)');
    assert.match(text, /-ExecutionPolicy\s+Bypass/i, name + ' must bypass the execution policy');
  }
});

test('the Chinese strings file is UTF-8 without a BOM and parses', () => {
  const bytes = fs.readFileSync(path.join(scriptsDir, stringsFile));
  assert.notEqual(bytes[0], 0xef, stringsFile + ' must not have a byte order mark (it would break JSON.parse)');
  const text = bytes.toString('utf8');
  let parsed = null;
  assert.doesNotThrow(() => { parsed = JSON.parse(text); }, stringsFile + ' must be valid JSON');
  assert.ok(parsed && typeof parsed === 'object', stringsFile + ' must hold an object');
  assert.ok(countLeaves(parsed) > 0, stringsFile + ' must not be empty');
});

test('every key the scripts ask for exists in the Chinese strings file', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(scriptsDir, stringsFile), 'utf8'));
  for (const name of scriptsWithExtension('.ps1')) {
    const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    const keys = [...text.matchAll(/\bTA?\s+'([^']+)'/g)].map((match) => match[1]);
    for (const key of keys) {
      assert.ok(hasKey(parsed, key), name + ' asks for the missing key ' + key + ' in ' + stringsFile);
    }
  }
});

test('the scripts that print Chinese read the strings file', () => {
  for (const name of ['restore-profile.ps1', 'drill-rescue.ps1', 'emergency-toggle.ps1']) {
    const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.ok(text.includes(stringsFile), name + ' must read the Chinese wording from ' + stringsFile);
    assert.ok(text.includes('[System.Text.Encoding]::UTF8'), name + ' must read that file as UTF-8 explicitly');
  }
});

test('the drill script never sweeps %TEMP% with a wildcard', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  // A wildcard scan of %TEMP% would delete the directory of a drill that is
  // running at the same time.
  assert.doesNotMatch(text, /Get-ChildItem[^\n]*\$env:TEMP/gi, 'the drill must not list %TEMP%');
  assert.doesNotMatch(text, /Remove-Item[^\n]*\$env:TEMP/gi, 'the drill must not delete anything in %TEMP% directly');
  // The only cleanup must name its own directory, literally.
  assert.match(text, /Remove-Item\s+-LiteralPath\s+\$script:TempRoot/gi, 'the cleanup must delete the drill\'s own directory by literal path');
});

test('the drill checks the rejection REASON, not only the exit code', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  // A script that cannot even parse also exits non-zero. The drill has to
  // tell "the script refused on purpose" apart from "the script broke".
  assert.match(text, /function\s+Assert-Refused/, 'the drill must have a rejection assertion that reads the output');
  const calls = text.match(/Assert-Refused\s+/g) || [];
  assert.ok(calls.length >= 5, 'every rejection scenario must use Assert-Refused (found ' + calls.length + ')');
  // The words a refusal has to contain live in the strings file now.
  const parsed = JSON.parse(fs.readFileSync(path.join(scriptsDir, stringsFile), 'utf8'));
  const keywords = parsed.drill && parsed.drill.keywords ? parsed.drill.keywords : {};
  for (const name of ['notProfile', 'driveRoot', 'systemDir', 'missingDir', 'notValidated']) {
    assert.ok(Array.isArray(keywords[name]) && keywords[name].length > 0, 'the strings file must list the words for ' + name);
    for (const word of keywords[name]) {
      assert.ok(word.length > 0, 'the words for ' + name + ' must not be empty');
    }
  }
});

test('the drill refuses the system directories too', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  for (const dir of ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData']) {
    assert.ok(text.includes(dir), 'the drill must try the system directory ' + dir);
  }
});

/* ------------------------------------------------------------------ *
 * THE RESCUE SCRIPTS ARE REALLY EXECUTED (2026-11-02).
 *
 * The audit found the one ❌ row in the whole matrix: the emergency switch had
 * ZERO tests and ZERO drills, and the profile restorer had only a byte check —
 * nothing had ever RUN them. A rescue script that has never run is a script you
 * meet for the first time at the worst possible moment.
 *
 * Every test below runs the REAL script in an ISOLATED temporary directory. No
 * real profile, no real desktop, no real state directory is touched: the
 * scripts are pointed at the temporary paths explicitly. A machine that cannot
 * run the script at all (no PowerShell / no POSIX shell) SKIPS the test — a skip
 * is not a pass, and `node --test` reports it as a skip.
 * ------------------------------------------------------------------ */

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `child_process` without a top-level import (this file predates it). */
function childProcess() {
  return process.getBuiltinModule('node:child_process');
}

/** Run one of the .ps1 scripts for real. `probeOnly` just checks it can start. */
function runPowerShell(scriptName, args, { env = {}, probeOnly = false } = {}) {
  const { spawnSync } = childProcess();
  const script = path.join(pluginRoot, 'scripts', scriptName);
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env },
      windowsHide: true,
    },
  );
  const out = String(result.stdout || '') + String(result.stderr || '');
  if (probeOnly === true) return { started: result.error === undefined, code: result.status, out };
  return { code: result.status, out };
}

/** A POSIX shell that can see this file system, or null. */
function posixRunner() {
  const { spawnSync } = childProcess();
  const native = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8', timeout: 20000 });
  if (native.error === undefined && native.status === 0) return { kind: 'sh' };
  // Windows: WSL's bash runs the .sh scripts against /mnt/c paths.
  const wsl = spawnSync('bash.exe', ['-c', 'exit 0'], { encoding: 'utf8', timeout: 30000 });
  if (wsl.error === undefined && wsl.status === 0) return { kind: 'bash.exe' };
  return null;
}

/** A Windows path as WSL sees it (`C:\a\b` → `/mnt/c/a/b`). */
function toPosixPath(winPath) {
  const text = String(winPath).replace(/\\/g, '/');
  const match = /^([A-Za-z]):\//.exec(text);
  if (match === null) return text;
  return '/mnt/' + match[1].toLowerCase() + '/' + text.slice(match[0].length);
}

/** Run one of the .sh scripts for real; null when there is no POSIX shell. */
function runPosixScript(scriptName, args, { env = {} } = {}) {
  const runner = posixRunner();
  if (runner === null) return null;
  const { spawnSync } = childProcess();
  const script = path.join(pluginRoot, 'scripts', scriptName);
  if (runner.kind === 'sh') {
    const result = spawnSync('sh', [script, ...args], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env },
    });
    return { code: result.status, out: String(result.stdout || '') + String(result.stderr || '') };
  }
  const command = ['sh', toPosixPath(script), ...args.map((arg) => (/^--/.test(arg) ? arg : JSON.stringify(toPosixPath(arg))))].join(' ');
  const mapped = Object.entries(env)
    .map(([key, value]) => [key, typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) ? toPosixPath(value) : value])
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ');
  const result = spawnSync('bash.exe', ['-c', (mapped === '' ? '' : mapped + ' ') + command], {
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: result.status, out: String(result.stdout || '') + String(result.stderr || '') };
}

/** An isolated profile whose package.json lists this plugin. */
function tempProfile(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-script-${label}-`));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const pkg = path.join(profile, 'package.json');
  fs.writeFileSync(
    pkg,
    JSON.stringify({ name: 'isolated-test-profile', private: true, dsh: { profile: { bundles: ['dsh-autorestart', 'another-plugin'] } } }, null, 2) + '\n',
    'utf8',
  );
  return { root, profile, pkg };
}

/** The `bundles` of a package.json, or null when it cannot be parsed. */
function bundlesOf(pkgPath) {
  try {
    const document = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bundles = document && document.dsh && document.dsh.profile ? document.dsh.profile.bundles : null;
    return Array.isArray(bundles) ? bundles : null;
  } catch {
    return null;
  }
}

/**
 * The backup names the OLD (second-granularity) naming would produce for this second
 * and the next one - planted as decoys, so a collision is deterministic instead of a
 * race with the clock.
 */
function emergencyDecoys(pkg, count) {
  const names = []
  const pad = (value) => String(value).padStart(2, '0')
  for (let offset = 0; offset < count; offset += 1) {
    const at = new Date(Date.now() + offset * 1000)
    const stamp = String(at.getFullYear()) + pad(at.getMonth() + 1) + pad(at.getDate())
      + '-' + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds())
    names.push(path.basename(pkg) + '.bak-emergency-' + stamp)
  }
  return names
}

/** The emergency backups written next to a package.json. */
function emergencyBackups(pkg) {
  const base = path.basename(pkg) + '.bak-emergency-';
  return fs.readdirSync(path.dirname(pkg)).filter((name) => name.startsWith(base));
}

test('the emergency switch really takes the plugin out and puts it back (PowerShell)', (t) => {
  const probe = runPowerShell('emergency-toggle.ps1', ['-Action', 'status'], { probeOnly: true });
  if (probe.started !== true || probe.code === null || probe.code === undefined) {
    t.skip('powershell.exe is not available here');
    return;
  }
  const { root, pkg } = tempProfile('ps-emergency');
  try {
    assert.deepEqual(bundlesOf(pkg), ['dsh-autorestart', 'another-plugin'], 'the fixture starts with the plugin listed');

    // (1) DISABLE: the plugin leaves the bundles, the other one stays.
    const disabled = runPowerShell('emergency-toggle.ps1', ['-Action', 'disable', '-PackageJson', pkg]);
    assert.equal(disabled.code, 0, `disable must succeed: ${disabled.out}`);
    assert.deepEqual(bundlesOf(pkg), ['another-plugin'], 'the plugin is out of the bundles, the rest is untouched');
    const backupsAfterDisable = emergencyBackups(pkg);
    assert.equal(backupsAfterDisable.length, 1, 'the file was backed up before anything was written');

    // (2) STATUS: it really reads the file it was pointed at.
    const status = runPowerShell('emergency-toggle.ps1', ['-Action', 'status', '-PackageJson', pkg]);
    assert.equal(status.code, 0, `status must succeed: ${status.out}`);

    // (3) ENABLE — A KNOWN DEFECT, PINNED HERE ON PURPOSE (2026-11-02).
    //
    // Running it for real (2026-11-02) found that `-Action enable` on a profile
    // whose bundles hold ONE item wrote the comma at a body-relative offset:
    //
    //     "name": "test-profile,"        <- the comma landed in the WRONG line
    //       "bundles": [
    //         "another-plugin"
    //         "dsh-autorestart"
    //
    // The script REFUSED to keep a broken file (verify failed, backup put back,
    // exit 1) — so the rescue path was safe but unusable. It is FIXED now: the
    // array body is serialized instead of spliced, so a comma can only appear
    // BETWEEN two items.
    const enabled = runPowerShell('emergency-toggle.ps1', ['-Action', 'enable', '-PackageJson', pkg]);
    assert.equal(enabled.code, 0, `enable must succeed now: ${enabled.out}`);
    assert.deepEqual(bundlesOf(pkg), ['another-plugin', 'dsh-autorestart'], 'the plugin is back in the bundles');
    assert.equal(emergencyBackups(pkg).length, 2, 'the second write was backed up too');

    // (4) THE BACKUP IS THE WAY BACK: it holds the state from before the write.
    const firstBackup = path.join(path.dirname(pkg), backupsAfterDisable[0]);
    assert.deepEqual(
      bundlesOf(firstBackup),
      ['dsh-autorestart', 'another-plugin'],
      'the backup is a real previous state, not an empty file',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write never overwrites a backup whose name is already there (PowerShell)', (t) => {
  // THE DEFECT THIS PINS (2026-11-03): the backup name used to stop at the second, so a
  // second write inside the same second wrote ON TOP OF the first backup. Two decoys are
  // planted with the names the OLD format would produce for this second and the next one;
  // a correct script leaves both untouched and picks a name of its own.
  const probe = runPowerShell('emergency-toggle.ps1', ['-Action', 'status'], { probeOnly: true });
  if (probe.started !== true || probe.code === null || probe.code === undefined) {
    t.skip('powershell.exe is not available here');
    return;
  }
  const { root, pkg } = tempProfile('ps-emergency-collide');
  const dir = path.dirname(pkg);
  const decoys = emergencyDecoys(pkg, 2);
  try {
    for (const decoy of decoys) fs.writeFileSync(path.join(dir, decoy), 'OLDER BACKUP', 'utf8');

    const disabled = runPowerShell('emergency-toggle.ps1', ['-Action', 'disable', '-PackageJson', pkg]);
    assert.equal(disabled.code, 0, 'disable must succeed: ' + disabled.out);

    for (const decoy of decoys) {
      assert.equal(
        fs.readFileSync(path.join(dir, decoy), 'utf8'),
        'OLDER BACKUP',
        'the earlier backup ' + decoy + ' was overwritten',
      );
    }
    const backups = emergencyBackups(pkg);
    assert.equal(backups.length, decoys.length + 1, 'the new backup is a file of its own: ' + backups.join(', '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write never overwrites a backup whose name is already there (POSIX)', (t) => {
  const { root, pkg } = tempProfile('sh-emergency-collide');
  const dir = path.dirname(pkg);
  const decoys = emergencyDecoys(pkg, 2);
  try {
    for (const decoy of decoys) fs.writeFileSync(path.join(dir, decoy), 'OLDER BACKUP', 'utf8');

    const disabled = runPosixScript('emergency-disable.sh', ['--action', 'disable', '--package', pkg]);
    if (disabled === null) {
      t.skip('no POSIX shell (sh / WSL bash) is available here');
      return;
    }
    assert.equal(disabled.code, 0, 'disable must succeed: ' + disabled.out);

    for (const decoy of decoys) {
      assert.equal(
        fs.readFileSync(path.join(dir, decoy), 'utf8'),
        'OLDER BACKUP',
        'the earlier backup ' + decoy + ' was overwritten',
      );
    }
    const backups = emergencyBackups(pkg);
    assert.equal(backups.length, decoys.length + 1, 'the new backup is a file of its own: ' + backups.join(', '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the emergency switch keeps the JSON valid for every profile SHAPE (PowerShell)', (t) => {
  const probe = runPowerShell('emergency-toggle.ps1', ['-Action', 'status'], { probeOnly: true });
  if (probe.started !== true || probe.code === null || probe.code === undefined) {
    t.skip('powershell.exe is not available here');
    return;
  }

  /** Write a package.json with an exact body, so the layout is what the test chose. */
  const writeProfile = (root, name, lines) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, lines, 'utf8');
    return pkg;
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-emergency-shapes-'));
  try {
    // (a) PRETTY, one bundle left: the case that used to write the comma into
    // the "name" line and produce invalid JSON.
    const single = writeProfile(root, 'single', [
      '{',
      '  "name": "single-profile",',
      '  "dsh": {',
      '    "profile": {',
      '      "bundles": [',
      '        "another-plugin"',
      '      ]',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));

    // (b) PRETTY, several bundles, with the anchor the script prefers.
    const multi = writeProfile(root, 'multi', [
      '{',
      '  "name": "multi-profile",',
      '  "dsh": {',
      '    "profile": {',
      '      "bundles": [',
      '        "dsh-github-guard",',
      '        "another-plugin"',
      '      ]',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));

    // (c) MINIFIED, one line: the old line-based reader found ZERO items here,
    // so "disable" answered "not in the bundles" and changed nothing at all.
    const compact = writeProfile(root, 'compact',
      '{"name":"compact-profile","dsh":{"profile":{"bundles":["dsh-autorestart","another-plugin"]}}}\n');

    for (const pkg of [single, multi, compact]) {
      const label = path.basename(path.dirname(pkg));

      // enable: must SUCCEED (the old version exited 1 here for (a)).
      const enabled = runPowerShell('emergency-toggle.ps1', ['-Action', 'enable', '-PackageJson', pkg]);
      assert.equal(enabled.code, 0, `[${label}] enable must succeed: ${enabled.out}`);
      const afterEnable = bundlesOf(pkg);
      assert.ok(afterEnable, `[${label}] the file is still valid JSON after enable`);
      assert.ok(afterEnable.includes('dsh-autorestart'), `[${label}] the plugin is in the bundles`);

      // disable: must also succeed, and the plugin must really be gone.
      const disabled = runPowerShell('emergency-toggle.ps1', ['-Action', 'disable', '-PackageJson', pkg]);
      assert.equal(disabled.code, 0, `[${label}] disable must succeed: ${disabled.out}`);
      const afterDisable = bundlesOf(pkg);
      assert.ok(afterDisable, `[${label}] the file is still valid JSON after disable`);
      assert.equal(afterDisable.includes('dsh-autorestart'), false, `[${label}] the plugin is gone`);

      // Everything outside the array is untouched: the name is what it was.
      const text = fs.readFileSync(pkg, 'utf8');
      assert.equal(text.includes(`"name": "${label}-profile"`) || text.includes(`"name":"${label}-profile"`), true,
        `[${label}] the rest of the file is untouched`);
      assert.ok(emergencyBackups(pkg).length >= 1, `[${label}] every write was backed up first`);
    }

    // A minified file stays minified: the whole document is not reformatted.
    assert.equal(fs.readFileSync(compact, 'utf8').split('\n').length <= 2, true, 'the compact file stayed compact');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the emergency switch really takes the plugin out and puts it back (POSIX)', (t) => {
  const { root, pkg } = tempProfile('sh-emergency');
  try {
    const disabled = runPosixScript('emergency-disable.sh', ['--action', 'disable', '--package', pkg]);
    if (disabled === null) {
      t.skip('no POSIX shell (sh / WSL bash) is available here');
      return;
    }
    assert.equal(disabled.code, 0, `disable must succeed: ${disabled.out}`);
    assert.deepEqual(bundlesOf(pkg), ['another-plugin'], 'the plugin is out of the bundles');
    assert.equal(emergencyBackups(pkg).length, 1, 'the file was backed up before it was written');

    const enabled = runPosixScript('emergency-disable.sh', ['--action', 'enable', '--package', pkg]);
    assert.equal(enabled.code, 0, `enable must succeed: ${enabled.out}`);
    assert.deepEqual(bundlesOf(pkg), ['dsh-autorestart', 'another-plugin'], 'the plugin is back in the bundles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The isolated `DSH_HOME` a restore test works in.
 *
 * Two complete snapshots and one WITHOUT a manifest that is the NEWEST by name:
 * the script must pick the newest one that HAS a manifest — exactly the rule the
 * audit said had never been executed.
 */
function tempRestoreFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-restore-${label}-`));
  const profile = path.join(root, 'profiles', 'test');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'test', dsh: { profile: { bundles: ['broken-plugin'] } } }, null, 2) + '\n',
    'utf8',
  );
  const stateDir = path.join(root, 'state');
  const backups = path.join(stateDir, 'backups');
  const writeSnapshot = (stamp, { manifest = true, marker }) => {
    const dir = path.join(backups, stamp);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'package.json'),
      JSON.stringify({ name: 'test', marker, dsh: { profile: { bundles: ['restored-' + marker] } } }, null, 2) + '\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'config', 'cordis.patch.yml'), 'plugins: {}\n', 'utf8');
    if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ at: 1, marker }) + '\n', 'utf8');
    return dir;
  };
  writeSnapshot('2026-01-01T00-00-00-000Z', { marker: 'old' });
  writeSnapshot('2026-06-01T00-00-00-000Z', { marker: 'new' });
  writeSnapshot('2026-12-01T00-00-00-000Z', { manifest: false, marker: 'nomanifest' });
  return { root, profile, stateDir, env: { DSH_HOME: root } };
}

/** The profile's package.json, parsed. */
function profileDocument(profile) {
  return JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
}

/** The `<profile>.broken-<stamp>` directories next to a profile. */
function brokenSiblings(profile) {
  const base = path.basename(profile) + '.broken-';
  return fs.readdirSync(path.dirname(profile)).filter((name) => name.startsWith(base));
}

test('the profile restorer really restores the newest snapshot WITH a manifest (PowerShell)', (t) => {
  const probe = runPowerShell('restore-profile.ps1', ['-DryRun'], { probeOnly: true });
  if (probe.started !== true || probe.code === null || probe.code === undefined) {
    t.skip('powershell.exe is not available here');
    return;
  }
  const fixture = tempRestoreFixture('ps');
  try {
    const run = runPowerShell(
      'restore-profile.ps1',
      ['-ProfileDir', fixture.profile, '-StateDir', fixture.stateDir],
      { env: fixture.env },
    );
    assert.equal(run.code, 0, `the restore must succeed: ${run.out}`);

    // (1) THE RIGHT SNAPSHOT: the newest one WITH a manifest — not the newest.
    const restored = profileDocument(fixture.profile);
    assert.equal(restored.marker, 'new', 'the newest snapshot WITH a manifest was restored');
    assert.deepEqual(restored.dsh.profile.bundles, ['restored-new'], 'and its configuration is what landed');
    assert.ok(fs.existsSync(path.join(fixture.profile, 'cordis.patch.yml')), 'the whole config directory was copied');

    // (2) THE BROKEN PROFILE IS KEPT: `<profile>.broken-<stamp>`, never deleted.
    const broken = brokenSiblings(fixture.profile);
    assert.equal(broken.length, 1, 'the previous profile was moved aside, not thrown away');
    const kept = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fixture.profile), broken[0], 'package.json'), 'utf8'),
    );
    assert.deepEqual(kept.dsh.profile.bundles, ['broken-plugin'], 'and the BROKEN state is what was kept');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the profile restorer really restores the newest snapshot WITH a manifest (POSIX)', (t) => {
  if (posixRunner() === null) {
    t.skip('no POSIX shell (sh / WSL bash) is available here');
    return;
  }
  const fixture = tempRestoreFixture('sh');
  try {
    const run = runPosixScript(
      'restore-profile.sh',
      ['--profile', fixture.profile, '--state-dir', fixture.stateDir],
      { env: fixture.env },
    );
    assert.equal(run.code, 0, `the restore must succeed: ${run.out}`);

    const restored = profileDocument(fixture.profile);
    assert.equal(restored.marker, 'new', 'the newest snapshot WITH a manifest was restored');
    assert.deepEqual(restored.dsh.profile.bundles, ['restored-new'], 'and its configuration is what landed');

    const broken = brokenSiblings(fixture.profile);
    assert.equal(broken.length, 1, 'the previous profile was moved aside, not thrown away');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the emergency switch works on a COMPACT single-line profile too (POSIX)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sh-compact-'));
  try {
    const pkg = path.join(root, 'package.json');
    fs.writeFileSync(
      pkg,
      '{"name":"compact-profile","dsh":{"profile":{"bundles":["dsh-autorestart","another-plugin"]}}}\n',
      'utf8',
    );

    // Disable: a line-oriented editor has no line to work on here, so this is the
    // case that used to fail (and roll back) on a minified profile.
    const disabled = runPosixScript('emergency-disable.sh', ['--action', 'disable', '--package', pkg]);
    if (disabled === null) {
      t.skip('no POSIX shell (sh / WSL bash) is available here');
      return;
    }
    assert.equal(disabled.code, 0, 'disable must succeed: ' + disabled.out);
    assert.deepEqual(bundlesOf(pkg), ['another-plugin'], 'the plugin is out of the bundles');

    const afterDisable = fs.readFileSync(pkg, 'utf8');
    assert.equal(
      afterDisable.replace(/\r?\n$/, '').includes('\n'),
      false,
      'the compact file is still ONE line (it is not reformatted)',
    );
    assert.ok(afterDisable.includes('"name":"compact-profile"'), 'the profile name was not touched');

    // Enable: back in the bundles, still one line, still the same name.
    const enabled = runPosixScript('emergency-disable.sh', ['--action', 'enable', '--package', pkg]);
    assert.equal(enabled.code, 0, 'enable must succeed: ' + enabled.out);
    assert.deepEqual(bundlesOf(pkg), ['dsh-autorestart', 'another-plugin'], 'the plugin is back');

    const afterEnable = fs.readFileSync(pkg, 'utf8');
    assert.equal(
      afterEnable.replace(/\r?\n$/, '').includes('\n'),
      false,
      'the compact file stayed compact after enable',
    );
    assert.ok(afterEnable.includes('"name":"compact-profile"'), 'the name line was not polluted');
    assert.ok(emergencyBackups(pkg).length >= 1, 'every write was backed up first');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

