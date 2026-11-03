/**
 * The rescue kit in the settings page: where the scripts are, how to copy
 * that path, and the desktop shortcut.
 *
 * The rules this pins down:
 *
 *   - the PATHS come from the Host (it resolved the plugin directory for
 *     itself) — the browser never guesses them, and nothing assumes
 *     `node_modules/dsh-autorestart`;
 *   - "copy the path" goes through the clipboard WITH its fallback (a refused
 *     clipboard gives the text back, so the path is never lost);
 *   - the desktop shortcut is written ONLY when the user asks for it: reading
 *     the settings page writes nothing to the desktop;
 *   - a machine without a desktop is a normal case, not a crash.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  classifyShortcutFailure,
  createDesktopShortcut,
  decodeRegistryOutput,
  desktopDir,
  desktopLocation,
  desktopShortcutContent,
  desktopShortcutPath,
  expandEnvironment,
  isAsciiText,
  parseRegistryDesktop,
  rescueInfo,
  rescueScriptNames,
  rescueScriptPaths,
  shortcutCreationScript,
  DESKTOP_SHORTCUT_NAME,
  DESKTOP_SOURCES,
  RESCUE_SCRIPT_NAMES,
  SHORTCUT_FAILURE,
} from '../lib/rescue-paths.js';

/**
 * Load the client script the way the browser evaluates it.
 *
 * @param {{ language?: string }} options the browser language
 */
function loadClient({ language = 'zh-CN' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const sandbox = {
    window: {
      __ModuleLoader__: { load: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    navigator: { language },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  return sandbox.__dshAutorestartClient;
}

// ---------------------------------------------------------------------------
// 1) The paths come from the Host
// ---------------------------------------------------------------------------

test('the rescue paths come from the Host, not from the browser', () => {
  const api = loadClient();
  const paths = api.rescuePathsFor({
    rescue: {
      restoreProfile: 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\restore-profile.cmd',
      emergencyDisable: 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\emergency-disable.cmd',
    },
  });
  assert.equal(paths.length, 2);
  assert.equal(paths[0].key, 'restoreProfile');
  assert.equal(paths[0].path, 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\restore-profile.cmd');
  assert.equal(paths[1].key, 'emergencyDisable');
  assert.equal(paths[1].path, 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\emergency-disable.cmd');
});

test('a path that the Host did not send is not shown', () => {
  const api = loadClient();
  // The array comes from another realm (the vm), so it is compared by length.
  assert.equal(api.rescuePathsFor({}).length, 0);
  assert.equal(api.rescuePathsFor({ rescue: { restoreProfile: '   ' } }).length, 0);
  assert.equal(api.rescuePathsFor(null).length, 0);
  // Only one of the two: the other one is simply not offered.
  const one = api.rescuePathsFor({ rescue: { restoreProfile: 'C:\\a\\restore-profile.cmd' } });
  assert.equal(one.length, 1);
  assert.equal(one[0].key, 'restoreProfile');
});

test('the plugin directory is the source of the script paths', () => {
  const pluginDir = path.join('C:', 'profiles', 'desktop', 'node_modules', 'dsh-autorestart')
  const paths = rescueScriptPaths(pluginDir, 'win32')
  const names = rescueScriptNames('win32')
  assert.equal(paths.restoreProfile, path.join(pluginDir, 'scripts', names.restoreProfile))
  assert.equal(paths.emergencyDisable, path.join(pluginDir, 'scripts', names.emergencyDisable))
  // The scripts live NEXT to the plugin, not in a guessed layout.
  assert.ok(paths.restoreProfile.includes(path.join('scripts', 'restore-profile.cmd')))
})

// ---------------------------------------------------------------------------
// 2) "Copy the path" goes through the clipboard WITH its fallback
// ---------------------------------------------------------------------------

test('the copy button uses the clipboard, and falls back when it refuses', async () => {
  const api = loadClient();
  const written = [];
  const ok = await api.copyReportText('C:\\a\\restore-profile.cmd', {
    clipboard: { writeText: async (text) => { written.push(text) } },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.fallback, false);
  assert.deepEqual(written, ['C:\\a\\restore-profile.cmd']);

  // A refused clipboard: the text comes back, so the path is never lost.
  const refused = await api.copyReportText('C:\\a\\restore-profile.cmd', {
    clipboard: { writeText: async () => { throw new Error('denied') } },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.fallback, true);
  assert.equal(refused.text, 'C:\\a\\restore-profile.cmd');

  // No clipboard at all (an insecure context).
  const none = await api.copyReportText('C:\\a\\restore-profile.cmd', { clipboard: null });
  assert.equal(none.fallback, true);
  assert.equal(none.text, 'C:\\a\\restore-profile.cmd');
});

// ---------------------------------------------------------------------------
// 3) The desktop shortcut: only when the user asks for it
// ---------------------------------------------------------------------------

test('reading the settings writes NOTHING to the desktop', () => {
  // THE OLD VERSION OF THIS TEST WAS A FAKE GREEN: it collected `calls` in a
  // local array that NOTHING ever pushed to, then asserted the array was empty —
  // an assertion that cannot fail, whatever the code does. It proved nothing.
  //
  // This version watches the real thing: a real (temporary) desktop directory,
  // read by the real code, must still hold exactly the files it held before.
  // If `rescueInfo` ever learns to write a shortcut while merely being read,
  // this test goes red.
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-readonly-'))
  const desktop = path.join(desktopRoot, 'Desktop')
  try {
    // One file that is already there, so "unchanged" is not the same as "empty".
    fs.mkdirSync(desktop, { recursive: true })
    const marker = path.join(desktop, 'existing-file.txt')
    fs.writeFileSync(marker, 'untouched\n', 'utf8')
    const before = fs.readdirSync(desktop).sort()

    const info = rescueInfo({
      pluginDir: 'C:\\plugin',
      env: { USERPROFILE: desktopRoot },
      platform: 'win32',
      // The registry is NOT read: the fallback (`%USERPROFILE%\Desktop`, a real
      // directory here) is what the test wants to watch, and no real registry
      // key may be consulted.
      readRegistry: () => '',
      exists: (target) => fs.existsSync(target),
    })

    // Prove the code really resolved a desktop, otherwise "nothing was written"
    // would be true for the trivial reason that it looked nowhere.
    assert.equal(info.desktopDir, desktop, 'the desktop directory was really resolved')
    assert.equal(info.shortcutExists, false)
    assert.deepEqual(
      fs.readdirSync(desktop).sort(),
      before,
      'reading the settings must not create a single file on the desktop',
    )
    assert.equal(fs.readFileSync(marker, 'utf8'), 'untouched\n', 'and it must not touch what is there')
  } finally {
    fs.rmSync(desktopRoot, { recursive: true, force: true })
  }
})

test('the shortcut is created when the user asks for it — a .lnk that starts the script', () => {
  const created = [];
  const result = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    exists: () => true,
    createLink: (options) => { created.push(options); return { ok: true, error: null } },
  });
  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  // A `.lnk` SINCE 2026-11-02: Windows refuses an icon on a `.cmd`, and the
  // blank white page it made was what the user could not recognise.
  assert.match(result.name, /\.lnk$/);
  assert.equal(result.name, DESKTOP_SHORTCUT_NAME);
  assert.equal(created[0].linkPath, desktopShortcutPath('C:\\Users\\Tester\\Desktop'));
  assert.equal(created[0].targetPath, 'C:\\plugin\\scripts\\restore-profile.cmd');
  assert.equal(created[0].iconPath, 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe');
});

test('the .lnk carries the icon of DSH — and no icon at all is not a failure', () => {
  const script = shortcutCreationScript({
    linkPath: 'C:\\Users\\Tester\\Desktop\\DSH 出事了双击这里.lnk',
    targetPath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  });
  assert.match(script, /New-Object -ComObject WScript\.Shell/, 'the shell writes the shortcut, not a hand-rolled file format');
  assert.match(script, /\.TargetPath = 'C:\\plugin\\scripts\\restore-profile\.cmd'/);
  assert.match(script, /\.IconLocation = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness\.exe,0'/, 'the icon the user will see');
  // THE WRITE COMES FIRST, THEN THE REFRESH (user report, 2026-11-02: "still no
  // icon"). `Save()` alone is not enough: Explorer draws from its own cache, so
  // the script tells the shell that this one item changed.
  assert.match(script, /\.Save\(\)/, 'the shortcut is written');
  assert.match(script, /SHChangeNotify\(0x00002000, 0x0001/, 'and the shell is told to re-read that item');
  assert.ok(
    script.indexOf('.Save()') < script.indexOf('SHChangeNotify'),
    'the refresh happens after the file exists, never before',
  );

  // THE ICON IS OPTIONAL: no executable (a hosted install) means no icon line —
  // and the shortcut is still created instead of failing.
  const noIcon = shortcutCreationScript({ linkPath: 'C:\\a.lnk', targetPath: 'C:\\b.cmd', iconPath: '' });
  assert.equal(noIcon.includes('IconLocation'), false, 'no icon line when there is no icon');
  const created = [];
  const result = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: '',
    exists: () => true,
    createLink: (options) => { created.push(options); return { ok: true, error: null } },
  });
  assert.equal(result.ok, true, 'a missing icon never fails the shortcut');
  assert.equal(created[0].iconPath, '');

  // A single quote in a path must not break the PowerShell command.
  const quoted = shortcutCreationScript({ linkPath: "C:\\O'Brien\\x.lnk", targetPath: 'C:\\t.cmd', iconPath: '' });
  assert.ok(quoted.includes("'C:\\O''Brien\\x.lnk'"), `a quote is escaped by doubling it: ${quoted}`);
});

test('the shortcut content is pure ASCII and only starts the script', () => {
  const content = desktopShortcutContent('C:\\plugin\\scripts\\restore-profile.cmd', { home: '' });
  assert.equal(isAsciiText(content), true, 'a .cmd file is read with the console code page');
  assert.equal(content, '@echo off\r\nstart "" "C:\\plugin\\scripts\\restore-profile.cmd"\r\n');
  // The home prefix becomes %USERPROFILE%: the file stays ASCII even when the
  // user name holds characters a .cmd file cannot carry.
  const withHome = desktopShortcutContent('C:\\Users\\Tester\\plugin\\scripts\\restore-profile.cmd', { home: 'C:\\Users\\Tester' });
  assert.equal(isAsciiText(withHome), true);
  assert.ok(withHome.includes('%USERPROFILE%'));
});

test('a shortcut that could not be created is refused and CLASSIFIED, never half-written', () => {
  const made = [];
  const blocked = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    exists: () => true,
    createLink: () => { made.push('called'); throw new Error('Access is denied by group policy') },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorKind, SHORTCUT_FAILURE.blocked, 'a policy that says no is its own answer');
  assert.notEqual(blocked.error, '');
  assert.deepEqual(made, ['called'], 'the attempt was made; nothing else happened');

  // Anything else is a write that did not work — a different sentence for the user.
  const broken = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    exists: () => true,
    createLink: () => { throw new Error('ENOSPC: no space left on device') },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.errorKind, SHORTCUT_FAILURE.writeFailed);
  assert.equal(classifyShortcutFailure(new Error('disk full')), SHORTCUT_FAILURE.writeFailed);
  assert.equal(classifyShortcutFailure(new Error('Access is denied')), SHORTCUT_FAILURE.blocked);
  assert.equal(classifyShortcutFailure(new Error('EPERM: operation not permitted')), SHORTCUT_FAILURE.blocked);
});

// ---------------------------------------------------------------------------
// 4) A machine without a desktop is a normal case
// ---------------------------------------------------------------------------

test('without a desktop the settings page says so and nothing crashes', () => {
  const api = loadClient();
  const info = rescueInfo({
    pluginDir: 'C:\\plugin',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: () => false,
  });
  assert.equal(info.desktopDir, '', 'there is no desktop here');
  assert.equal(info.shortcutPath, '');
  assert.equal(info.shortcutExists, false);
  // The paths are still there — that is the whole point of the section.
  const paths = api.rescuePathsFor({ rescue: info });
  assert.equal(paths.length, 2);
  // The shortcut cannot be created, and that is reported, not thrown.
  const result = createDesktopShortcut({
    desktop: info.desktopDir,
    restoreProfilePath: info.restoreProfile,
    home: '',
    writeFile: () => { throw new Error('must not be called') },
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.error, '');
});

test('the desktop is found where the machine really keeps it', () => {
  // OneDrive moves the desktop folder: the first candidate that exists wins.
  const found = desktopDir({
    env: { USERPROFILE: 'C:\\Users\\Tester', OneDrive: 'C:\\Users\\Tester\\OneDrive' },
    platform: 'win32',
    exists: (target) => target === 'C:\\Users\\Tester\\OneDrive\\Desktop',
    readRegistry: () => '',
  });
  assert.equal(found, 'C:\\Users\\Tester\\OneDrive\\Desktop');
  // Nothing there at all: no desktop.
  const none = desktopDir({
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: () => false,
    readRegistry: () => '',
  });
  assert.equal(none, '');
});

test('the desktop is read from the registry FIRST — a desktop on D: is found anyway', () => {
  // The user moved the desktop to another drive (user report, 2026-11-02): the
  // three guessed candidates are all wrong, and only the registry knows.
  const moved = desktopLocation({
    env: { USERPROFILE: 'C:\\Users\\Tester', MOVED: 'D:' },
    platform: 'win32',
    exists: (target) => target === 'D:\\我的桌面',
    readRegistry: () => '%MOVED%\\我的桌面',
  });
  assert.equal(moved.dir, 'D:\\我的桌面', 'the environment variable inside the registry value is expanded');
  assert.equal(moved.source, DESKTOP_SOURCES.registry, 'and the page can say so');

  // The registry wins EVEN WHEN a candidate exists: it is the only authority.
  const both = desktopLocation({
    env: { USERPROFILE: 'C:\\Users\\Tester', MOVED: 'D:' },
    platform: 'win32',
    exists: () => true,
    readRegistry: () => '%MOVED%\\桌面',
  });
  assert.equal(both.dir, 'D:\\桌面');
  assert.equal(both.source, DESKTOP_SOURCES.registry);

  // An unreadable or empty registry falls back to the candidates, with the
  // source that really answered.
  const fallback = desktopLocation({
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: (target) => target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => '',
  });
  assert.equal(fallback.dir, 'C:\\Users\\Tester\\Desktop');
  assert.equal(fallback.source, DESKTOP_SOURCES.profile);

  // A registry value that points at a folder that does not exist is not the
  // desktop: writing there would put the shortcut somewhere nobody looks.
  const ghost = desktopLocation({
    env: { USERPROFILE: 'C:\\Users\\Tester', MOVED: 'D:' },
    platform: 'win32',
    exists: (target) => target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => '%MOVED%\\gone',
  });
  assert.equal(ghost.dir, 'C:\\Users\\Tester\\Desktop');
  assert.equal(ghost.source, DESKTOP_SOURCES.profile);

  // Nothing at all: the empty answer is still labelled.
  const none = desktopLocation({
    env: {},
    platform: 'win32',
    exists: () => false,
    readRegistry: () => '',
  });
  assert.equal(none.dir, '');
  assert.equal(none.source, DESKTOP_SOURCES.none);
});

test('`reg query` output is parsed, and %VARS% are expanded case-insensitively', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Desktop',
    '    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads',
    '',
  ].join('\r\n');
  assert.equal(parseRegistryDesktop(output), '%USERPROFILE%\\Desktop', 'row 1 is the wrong one');
  assert.equal(parseRegistryDesktop(''), '');
  assert.equal(parseRegistryDesktop('garbage'), '');
  assert.equal(parseRegistryDesktop(null), '');

  assert.equal(expandEnvironment('%USERPROFILE%\\Desktop', { userprofile: 'C:\\Users\\Tester' }), 'C:\\Users\\Tester\\Desktop');
  assert.equal(expandEnvironment('%MOVED%\\桌面', { MOVED: 'D:' }), 'D:\\桌面');
  // An unknown name is left alone: failing the exists-check is the honest end.
  assert.equal(expandEnvironment('%NOPE%\\x', {}), '%NOPE%\\x');
});

test('a Chinese desktop path survives the console code page', () => {
  // MEASURED ON THE REAL MACHINE: `reg.exe` writes in the OEM code page, so a
  // desktop named `G:\桌面` reached the reader as mojibake and the exists-check
  // threw the right answer away — the reported "my desktop is on D: and the
  // shortcut is not there" bug. The decoder keeps the path intact.
  // GBK bytes of 桌面 are D7 C0 C3 E6.
  assert.equal(decodeRegistryOutput(Buffer.from([0xd7, 0xc0, 0xc3, 0xe6])), '桌面', 'GBK is decoded when UTF-8 is invalid');
  assert.equal(decodeRegistryOutput(Buffer.from('G:\\桌面', 'utf8')), 'G:\\桌面', 'valid UTF-8 is left alone');
  assert.equal(decodeRegistryOutput('plain text'), 'plain text');
  assert.equal(decodeRegistryOutput(null), '');

  // ...and the whole location chain then accepts it, instead of falling back to
  // the guessed %USERPROFILE%\Desktop.
  const resolved = desktopLocation({
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: (target) => target === 'G:\\桌面' || target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => decodeRegistryOutput(Buffer.from([0x47, 0x3a, 0x5c, 0xd7, 0xc0, 0xc3, 0xe6])),
  });
  assert.equal(resolved.dir, 'G:\\桌面');
  assert.equal(resolved.source, DESKTOP_SOURCES.registry);
});

// ---------------------------------------------------------------------------
// The texts of the section
// ---------------------------------------------------------------------------

test('the section says which script is which, and warns about the running host', () => {
  const api = loadClient();
  for (const language of ['zh-CN', 'en-US']) {
    const t = api.makeTranslate(null)
    const keys = [
      'settings.groups.rescue',
      'settings.rescue.hint',
      'settings.rescue.restoreProfile',
      'settings.rescue.emergencyDisable',
      'settings.rescue.copyPath',
      'settings.rescue.reveal',
      'settings.rescue.which',
      'settings.rescue.warning',
      'settings.rescue.shortcut',
      'settings.rescue.shortcutDone',
      'settings.rescue.noDesktop',
    ]
    for (const key of keys) {
      const text = t(key)
      assert.notEqual(text, key, key + ' must have a text (' + language + ')')
      assert.ok(text.length > 0, key + ' must not be empty (' + language + ')')
    }
  }
});

test('the warning says the scripts are for a host that does not come up', () => {
  // The language follows the browser when the Host says nothing.
  const zh = loadClient({ language: 'zh-CN' }).makeTranslate(null)('settings.rescue.warning')
  const en = loadClient({ language: 'en-US' }).makeTranslate(null)('settings.rescue.warning')
  assert.match(zh, /打不开/)
  assert.match(en, /does not come up/)
  // The warning must warn about overwriting a running configuration.
  assert.match(zh, /覆盖/)
  assert.match(en, /overwrites/)
})

// ---------------------------------------------------------------------------
// The automatic rollback: what this machine can do
// ---------------------------------------------------------------------------

test('the settings line says what the automatic rollback does — and what is lost', () => {
  const zh = loadClient({ language: 'zh-CN' }).makeTranslate(null)
  const en = loadClient({ language: 'en-US' }).makeTranslate(null)
  // Available.
  assert.match(zh('settings.rescue.rollbackOk'), /自动回滚：可用/)
  assert.match(en('settings.rescue.rollbackOk'), /Automatic rollback: available/)
  // Not available: the line must say what is LOST and where to go.
  assert.match(zh('settings.rescue.rollbackBlocked'), /不可用/)
  assert.match(zh('settings.rescue.rollbackBlocked'), /会丢失/)
  assert.match(zh('settings.rescue.rollbackBlocked'), /还原脚本/)
  assert.match(en('settings.rescue.rollbackBlocked'), /not available/)
  assert.match(en('settings.rescue.rollbackBlocked'), /What you lose/)
  assert.match(en('settings.rescue.rollbackBlocked'), /restore script/)
  // Not checked yet.
  assert.match(zh('settings.rescue.rollbackUnknown'), /还不知道/)
  assert.match(en('settings.rescue.rollbackUnknown'), /not known yet/)
})

test('the warning about the missing rollback waits for the user once', () => {
  const api = loadClient()
  // Blocked and never shown: the warning is waiting.
  assert.equal(api.watchdogNoticeFor({ tier: 'none' }), true)
  // Shown already: no nagging.
  assert.equal(api.watchdogNoticeFor({ tier: 'none', warnedAt: 12345 }), false)
  // A machine that CAN run the watchdog: nothing to say.
  assert.equal(api.watchdogNoticeFor({ tier: 'scheduled-task' }), false)
  assert.equal(api.watchdogNoticeFor({ tier: 'systemd-run' }), false)
  assert.equal(api.watchdogNoticeFor({ tier: 'detached-process' }), false)
  assert.equal(api.watchdogNoticeFor(null), false)
  assert.equal(api.watchdogNoticeFor({}), false)
})

test('the tier is named in the language of the user', () => {
  const api = loadClient()
  const zh = api.makeTranslate(null)
  const en = loadClient({ language: 'en-US' }).makeTranslate(null)
  assert.match(zh('settings.rescue.tierScheduledTask'), /计划任务/)
  assert.match(en('settings.rescue.tierScheduledTask'), /scheduled task/)
  assert.match(zh('settings.rescue.tierSystemdRun'), /systemd/)
  assert.match(zh('settings.rescue.tierDetachedProcess'), /后台进程/)
  assert.match(en('settings.rescue.tierNone'), /no way/)
})

// ---------------------------------------------------------------------------
// The rescue kit of THIS platform: a path to a file that is not there is worse
// than no path at all.
// ---------------------------------------------------------------------------

test('Windows gets the .cmd scripts, POSIX gets the .sh ones', () => {
  const windows = rescueInfo({ pluginDir: 'C:\\plugin', platform: 'win32', env: {}, exists: () => false })
  assert.match(windows.restoreProfile, /restore-profile\.cmd$/)
  assert.match(windows.emergencyDisable, /emergency-disable\.cmd$/)

  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const posix = rescueInfo({ pluginDir: '/plugin', platform, env: {}, exists: () => false })
    assert.match(posix.restoreProfile, /restore-profile\.sh$/)
    assert.match(posix.emergencyDisable, /emergency-disable\.sh$/)
    assert.doesNotMatch(posix.restoreProfile, /\.cmd$/)
  }
})

test('the desktop shortcut is only offered where it can work', () => {
  const windows = rescueInfo({
    pluginDir: 'C:\\plugin',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    exists: (target) => target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => '',
  })
  assert.equal(windows.desktopDir, 'C:\\Users\\Tester\\Desktop')
  assert.match(windows.shortcutPath, /\.lnk$/)
  assert.equal(windows.shortcutName, DESKTOP_SHORTCUT_NAME)
  assert.equal(windows.desktopSource, DESKTOP_SOURCES.profile, 'the page can say WHERE it found the desktop')

  // On POSIX there is no shortcut to offer: no path, no button — and the page is
  // TOLD which platform it is, so it can explain itself instead of going blank.
  const posix = rescueInfo({
    pluginDir: '/plugin',
    platform: 'linux',
    env: { HOME: '/home/tester' },
    exists: (target) => target === '/home/tester/Desktop',
  })
  assert.equal(posix.desktopDir, '')
  assert.equal(posix.shortcutPath, '')
  assert.equal(posix.platform, 'linux')
})

test('the settings page shows the scripts of this platform and nothing else', () => {
  const api = loadClient()
  const windows = api.rescuePathsFor({
    rescue: {
      restoreProfile: 'C:\\plugin\\scripts\\restore-profile.cmd',
      emergencyDisable: 'C:\\plugin\\scripts\\emergency-disable.cmd',
    },
  })
  assert.equal(windows.length, 2)
  assert.ok(windows.every((entry) => entry.path.endsWith('.cmd')))

  const posix = api.rescuePathsFor({
    rescue: {
      restoreProfile: '/plugin/scripts/restore-profile.sh',
      emergencyDisable: '/plugin/scripts/emergency-disable.sh',
    },
  })
  assert.equal(posix.length, 2)
  assert.ok(posix.every((entry) => entry.path.endsWith('.sh')))
})
