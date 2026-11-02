/**
 * Where the rescue scripts live, and the desktop shortcut that points at them.
 *
 * The rescue kit is for EVERYBODY who installed the plugin, not for the author:
 * when DSH does not come up, the user cannot open a README — they need a path
 * they can copy, and a file they can double-click on the desktop. So the
 * settings page shows the two scripts where they really are, and the desktop
 * shortcut is a file the user asks for.
 *
 * Everything here is pure (the file system is injected), so a test can pin it
 * down without touching a real desktop.
 *
 * THE PATH IS NEVER GUESSED: it comes from the plugin directory the Host
 * resolved for itself. Nothing here assumes `node_modules/dsh-autorestart`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The rescue scripts of each platform.
 *
 * A Windows user gets the `.cmd` files, a Linux/WSL/macOS user the `.sh`
 * ones. The other platform's scripts are NOT offered: a path to a file that
 * does not exist on this machine is worse than no path at all.
 */
export const RESCUE_SCRIPT_NAMES = Object.freeze({
  win32: Object.freeze({ restoreProfile: 'restore-profile.cmd', emergencyDisable: 'emergency-disable.cmd' }),
  posix: Object.freeze({ restoreProfile: 'restore-profile.sh', emergencyDisable: 'emergency-disable.sh' }),
});

/**
 * The script names of a platform.
 *
 * @param {string} platform
 * @returns {{ restoreProfile: string, emergencyDisable: string }}
 */
export function rescueScriptNames(platform) {
  return platform === 'win32' ? RESCUE_SCRIPT_NAMES.win32 : RESCUE_SCRIPT_NAMES.posix;
}

/**
 * The directory that holds the scripts of a plugin directory.
 *
 * @param {string} pluginDir the directory of the plugin itself
 * @returns {string}
 */
export function rescueScriptsDir(pluginDir) {
  const dir = typeof pluginDir === 'string' ? pluginDir.trim() : '';
  if (dir === '') return '';
  return path.join(dir, 'scripts');
}

/**
 * The absolute paths of the two rescue scripts.
 *
 * @param {string} pluginDir
 * @param {string} [platform]
 * @returns {{ restoreProfile: string, emergencyDisable: string }}
 */
export function rescueScriptPaths(pluginDir, platform = process.platform) {
  const scripts = rescueScriptsDir(pluginDir);
  if (scripts === '') return { restoreProfile: '', emergencyDisable: '' };
  const names = rescueScriptNames(platform);
  return {
    restoreProfile: path.join(scripts, names.restoreProfile),
    emergencyDisable: path.join(scripts, names.emergencyDisable),
  };
}

/**
 * The file the desktop shortcut is written as (the NAME may be Chinese).
 *
 * A `.lnk` SINCE 2026-11-02, and that is the whole point of the change: Windows
 * does not allow an icon on a `.cmd` file, so the old shortcut sat on the
 * desktop as a blank page nobody could recognise. A `.lnk` carries the icon of
 * the program it starts, and it is the format Explorer expects.
 */
export const DESKTOP_SHORTCUT_NAME = 'DSH 出事了双击这里.lnk';

/** The name an older build wrote. Only used to recognise a leftover file. */
export const LEGACY_SHORTCUT_NAME = 'DSH 出事了双击这里.cmd';

/** Where Windows records the REAL folder of the desktop. */
export const DESKTOP_FOLDER_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/** The value name of the desktop inside that key. */
export const DESKTOP_FOLDER_REGISTRY_VALUE = 'Desktop';

/**
 * WHERE the desktop directory came from — reported to the page, because "the
 * shortcut is on your desktop" is only believable when the page can also say
 * which desktop it means.
 */
export const DESKTOP_SOURCES = Object.freeze({
  registry: 'registry',
  profile: 'profile',
  onedrive: 'onedrive',
  home: 'home',
  none: 'none',
});

/** Does the path exist? (Injected so a test never touches the disk.) */
function defaultExists(target) {
  try {
    return fs.existsSync(target) === true;
  } catch {
    return false;
  }
}

/**
 * The desktop value out of `reg query` output — or an empty string.
 *
 * The output is one header line and one value line:
 *
 *   HKEY_CURRENT_USER\...\User Shell Folders
 *       Desktop    REG_EXPAND_SZ    %USERPROFILE%\Desktop
 *
 * `REG_EXPAND_SZ` means the value still holds `%USERPROFILE%`, so it is expanded
 * afterwards. Anything that does not look like this is `''` — a parse failure
 * must fall back to the candidates, never invent a path.
 *
 * @param {unknown} output the stdout of `reg query`
 * @returns {string}
 */
export function parseRegistryDesktop(output) {
  const text = typeof output === 'string' ? output : '';
  for (const line of text.split(/\r?\n/)) {
    const matched = /^\s+([^\s]+)\s+REG_[A-Z_]+\s+(.+?)\s*$/.exec(line);
    if (!matched) continue;
    if (matched[1].toLowerCase() !== DESKTOP_FOLDER_REGISTRY_VALUE.toLowerCase()) continue;
    return matched[2];
  }
  return '';
}

/**
 * Expand `%NAME%` against an environment, case-insensitively (Windows is).
 *
 * An unknown name is left as it is: a path with a weird `%…%` in it fails the
 * `exists` check afterwards, which is the honest outcome.
 *
 * @param {string} text
 * @param {object} env
 * @returns {string}
 */
export function expandEnvironment(text, env = process.env) {
  const value = typeof text === 'string' ? text : '';
  const source = env && typeof env === 'object' ? env : {};
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const wanted = String(name).toLowerCase();
    for (const [key, entry] of Object.entries(source)) {
      if (key.toLowerCase() === wanted && typeof entry === 'string') return entry;
    }
    return match;
  });
}

let registryCache = { at: 0, value: '' };
const REGISTRY_CACHE_MS = 60_000;

/**
 * Decode what a Windows console program wrote.
 *
 * MEASURED ON THE REAL MACHINE (2026-11-02): `reg.exe` writes its output in the
 * OEM code page — `G:\桌面` came back as `G:\\????` when decoded as UTF-8, the
 * path did not exist any more, and the reader fell back to the guessed
 * `%USERPROFILE%\Desktop`. That is EXACTLY the bug the user reported ("I moved
 * my desktop to another drive and the shortcut is not there"), only one layer
 * deeper than it looked: the registry WAS read, and its answer was destroyed by
 * the decoding.
 *
 * So: UTF-8 when it is valid, the OEM code page (GBK, the Windows console
 * default in this locale) when it is not, and never throw.
 *
 * @param {Buffer|string|null|undefined} input
 * @returns {string}
 */
export function decodeRegistryOutput(input) {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  let bytes;
  try {
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  } catch {
    return '';
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    // A runtime without the GBK table: the mangled text is still better than
    // nothing — the `exists` check afterwards decides.
    return utf8;
  }
}

/** The same key, read through PowerShell with an explicit UTF-8 output. */
function readRegistryViaPowerShell() {
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + "(Get-ItemProperty -Path '" + DESKTOP_FOLDER_REGISTRY_KEY.replace('HKCU\\', 'HKCU:\\') + "' -Name "
    + DESKTOP_FOLDER_REGISTRY_VALUE + ').' + DESKTOP_FOLDER_REGISTRY_VALUE;
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: 'pipe' });
  const value = String(output ?? '').trim();
  // An error line is not a path; the caller falls through to `reg`.
  if (value === '' || /^(Get-ItemProperty|At line|话|错误)/i.test(value)) return '';
  return value;
}

/** The same key, read through `reg query` (no PowerShell needed). */
function readRegistryViaReg() {
  const output = execFileSync('reg', ['query', DESKTOP_FOLDER_REGISTRY_KEY, '/v', DESKTOP_FOLDER_REGISTRY_VALUE], {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 4000,
  });
  return parseRegistryDesktop(decodeRegistryOutput(output));
}

/**
 * Read the desktop folder out of the registry, once a minute.
 *
 * Two readers, because the first one needs PowerShell and the second one needs
 * nothing: PowerShell answers in UTF-8 (so a Chinese path survives), `reg query`
 * is the fallback for a machine where PowerShell is blocked, decoded by
 * `decodeRegistryOutput`.
 *
 * CACHED because the settings page reads this on every render, and a subprocess
 * per render would be absurd; the cache is short enough that moving the desktop
 * is picked up without a restart.
 *
 * Never throws: no registry, no reader, a locked-down machine — all of it is
 * `''` and the caller falls back to the candidate directories.
 *
 * @returns {string} the raw (unexpanded) value, or ''
 */
export function defaultReadRegistryDesktop() {
  const now = Date.now();
  if (now - registryCache.at < REGISTRY_CACHE_MS) return registryCache.value;
  let value = '';
  const readers = [readRegistryViaPowerShell, readRegistryViaReg];
  for (const reader of readers) {
    try {
      const found = reader();
      if (typeof found === 'string' && found.trim() !== '') {
        value = found.trim();
        break;
      }
    } catch {
      // Try the next reader.
    }
  }
  registryCache = { at: now, value };
  return value;
}

/**
 * The desktop directory of this machine AND where it came from.
 *
 * THE ORDER IS THE POINT (user report, 2026-11-02): the registry is asked first,
 * because it is the ONLY place that knows the real answer — a desktop moved to
 * `D:\桌面` or renamed in the shell is simply not at `%USERPROFILE%\Desktop`,
 * and guessing there is what made the shortcut "disappear". The three
 * candidates stay as the fallback for machines where the key is unreadable.
 *
 * A value that does not exist as a directory is not accepted: an empty folder
 * name would make the button write somewhere the user never looks.
 *
 * @param {{
 *   env?: object,
 *   platform?: string,
 *   exists?: (p: string) => boolean,
 *   readRegistry?: () => string,
 * }} [options]
 * @returns {{ dir: string, source: string }}
 */
export function desktopLocation({
  env = process.env,
  platform = process.platform,
  exists = defaultExists,
  readRegistry = defaultReadRegistryDesktop,
} = {}) {
  const usable = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return false;
    try {
      return exists(candidate) === true;
    } catch {
      // A candidate that cannot be checked is not the desktop.
      return false;
    }
  }

  if (platform === 'win32' && typeof readRegistry === 'function') {
    let raw = '';
    try {
      raw = readRegistry();
    } catch {
      raw = '';
    }
    const expanded = expandEnvironment(raw, env);
    if (usable(expanded)) return { dir: expanded, source: DESKTOP_SOURCES.registry };
  }

  const candidates = [];
  if (platform === 'win32') {
    const profile = env.USERPROFILE || env.HOME || '';
    if (profile !== '') candidates.push({ dir: path.join(profile, 'Desktop'), source: DESKTOP_SOURCES.profile });
    // OneDrive moves the desktop folder; the shell still knows where it is.
    if (env.OneDrive) candidates.push({ dir: path.join(String(env.OneDrive), 'Desktop'), source: DESKTOP_SOURCES.onedrive });
  }
  const home = env.HOME || env.USERPROFILE || '';
  if (home !== '') candidates.push({ dir: path.join(home, 'Desktop'), source: DESKTOP_SOURCES.home });
  for (const candidate of candidates) {
    if (usable(candidate.dir)) return candidate;
  }
  return { dir: '', source: DESKTOP_SOURCES.none };
}

/**
 * The desktop directory of this machine — or an empty string when there is
 * none (a service, a container, a machine without a desktop).
 *
 * Kept as the old, narrow answer for every caller that only wants the path; the
 * page uses `desktopLocation` because it also has to say WHERE it came from.
 *
 * @param {{ env?: object, platform?: string, exists?: (p: string) => boolean, readRegistry?: () => string }} [options]
 * @returns {string}
 */
export function desktopDir(options = {}) {
  return desktopLocation(options).dir;
}

/**
 * Where the desktop shortcut would live (empty when there is no desktop).
 *
 * @param {string} desktop
 * @returns {string}
 */
export function desktopShortcutPath(desktop) {
  const dir = typeof desktop === 'string' ? desktop.trim() : '';
  if (dir === '') return '';
  return path.join(dir, DESKTOP_SHORTCUT_NAME);
}

/**
 * The content of the OLD `.cmd` shortcut.
 *
 * NOT USED ANY MORE (2026-11-02): the shortcut is a `.lnk` now, because Windows
 * refuses to put an icon on a `.cmd` and an unnamed white page on the desktop is
 * exactly what the user could not recognise. The function is kept — and still
 * pinned by a test — because the `.cmd` files a previous build wrote may still
 * be lying on somebody's desktop, and the escaping rules there are worth
 * keeping documented rather than rediscovered.
 *
 * @param {string} restoreProfilePath the absolute path of restore-profile.cmd
 * @param {{ home?: string }} [options]
 * @returns {string}
 */
export function desktopShortcutContent(restoreProfilePath, { home = '' } = {}) {
  const target = String(restoreProfilePath ?? '');
  const homeDir = typeof home === 'string' ? home.trim() : '';
  let written = target;
  if (homeDir !== '' && target.toLowerCase().startsWith(homeDir.toLowerCase() + path.sep)) {
    written = '%USERPROFILE%' + target.slice(homeDir.length);
  }
  return '@echo off\r\nstart "" "' + written + '"\r\n';
}

/**
 * Is this text pure ASCII?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAsciiText(text) {
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

/**
 * Quote one value for a PowerShell single-quoted string.
 *
 * A single quote inside a single-quoted string is written twice. That is the
 * whole escaping rule PowerShell needs here, and it is the ONLY place a path
 * from the machine reaches the script — so a path with `'` in it (an `O'Brien`
 * user name) cannot break the command.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function powerShellQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'";
}

/**
 * The PowerShell that creates the `.lnk` through `WScript.Shell`.
 *
 * WHY PowerShell AND NOT A BINARY WRITER: a `.lnk` is a COM binary format. The
 * shell already knows how to write it (`CreateShortcut(...).Save()`), so the
 * plugin asks the shell instead of re-implementing a file format — and the icon
 * comes with it, which is the entire point of the change.
 *
 * @param {{ linkPath?: string, targetPath?: string, iconPath?: string, description?: string }} [options]
 * @returns {string}
 */
export function shortcutCreationScript({ linkPath = '', targetPath = '', iconPath = '', description = 'DSH rescue' } = {}) {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    '$lnk = $ws.CreateShortcut(' + powerShellQuote(linkPath) + ')',
    '$lnk.TargetPath = ' + powerShellQuote(targetPath),
    '$lnk.WorkingDirectory = ' + powerShellQuote(targetPath === '' ? '' : path.dirname(String(targetPath))),
    '$lnk.Description = ' + powerShellQuote(description),
  ];
  // THE ICON IS OPTIONAL ON PURPOSE: an icon path that does not exist would make
  // `Save()` throw on some machines, and "no icon" is a far better outcome than
  // "no shortcut". The caller passes '' when it cannot name DSH's executable.
  if (typeof iconPath === 'string' && iconPath.trim() !== '') {
    lines.push('$lnk.IconLocation = ' + powerShellQuote(iconPath.trim() + ',0'));
  }
  lines.push('$lnk.Save()');
  return lines.join('; ');
}

/**
 * Create the shortcut for real, through `powershell.exe`.
 *
 * Never throws — the caller turns a failure into a human sentence and a manual
 * fallback (the script path is on the page anyway).
 *
 * @param {{ linkPath?: string, targetPath?: string, iconPath?: string }} [options]
 * @returns {{ ok: boolean, error: string|null }}
 */
export function defaultCreateShortcut({ linkPath = '', targetPath = '', iconPath = '' } = {}) {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', shortcutCreationScript({ linkPath, targetPath, iconPath }),
    ], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
    return { ok: true, error: null };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/** The three ways a shortcut can fail to appear, as the page describes them. */
export const SHORTCUT_FAILURE = Object.freeze({
  noDesktop: 'no-desktop',
  blocked: 'blocked',
  writeFailed: 'write-failed',
  unavailable: 'unavailable',
});

/**
 * Which KIND of failure is this?
 *
 * "Blocked" is the one that needs different words: a policy or a permission
 * said no, so trying again changes nothing and the user has to do it by hand.
 * Everything else is a write that did not work.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function classifyShortcutFailure(error) {
  const message = String(error && error.message ? error.message : (error ?? ''));
  if (/executionpolicy|execution policy|policy|denied|拒绝|受限制|not permitted|EPERM|EACCES|access is denied/i.test(message)) {
    return SHORTCUT_FAILURE.blocked;
  }
  return SHORTCUT_FAILURE.writeFailed;
}

/**
 * Create the desktop shortcut.
 *
 * NEVER automatic: the caller only gets here when the user pressed the button.
 * The shortcut is a `.lnk` that starts `restore-profile.cmd` and carries DSH's
 * own icon, so it is recognisable on the desktop.
 *
 * @param {{
 *   desktop?: string,
 *   restoreProfilePath?: string,
 *   iconPath?: string,
 *   createLink?: (options: { linkPath: string, targetPath: string, iconPath: string }) => ({ ok: boolean, error: string|null }|void),
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {{ ok: boolean, path: string, name: string, iconPath: string, errorKind: string|null, error: string|null }}
 */
export function createDesktopShortcut({
  desktop = '',
  restoreProfilePath = '',
  iconPath = '',
  createLink,
  exists = defaultExists,
} = {}) {
  const dir = typeof desktop === 'string' ? desktop.trim() : '';
  const icon = typeof iconPath === 'string' && iconPath.trim() !== '' && exists(iconPath) ? iconPath.trim() : '';
  if (dir === '') {
    return {
      ok: false,
      path: '',
      name: DESKTOP_SHORTCUT_NAME,
      iconPath: icon,
      errorKind: SHORTCUT_FAILURE.noDesktop,
      error: 'there is no desktop directory on this machine',
    };
  }
  const target = desktopShortcutPath(dir);
  const creator = typeof createLink === 'function' ? createLink : defaultCreateShortcut;
  try {
    const created = creator({
      linkPath: target,
      targetPath: String(restoreProfilePath ?? ''),
      iconPath: icon,
    });
    if (created && typeof created === 'object' && created.ok === false) {
      return {
        ok: false,
        path: target,
        name: DESKTOP_SHORTCUT_NAME,
        iconPath: icon,
        errorKind: classifyShortcutFailure(created.error),
        error: created.error ?? 'the shortcut could not be created',
      };
    }
  } catch (error) {
    return {
      ok: false,
      path: target,
      name: DESKTOP_SHORTCUT_NAME,
      iconPath: icon,
      errorKind: classifyShortcutFailure(error),
      error: error && error.message ? error.message : String(error),
    };
  }
  return { ok: true, path: target, name: DESKTOP_SHORTCUT_NAME, iconPath: icon, errorKind: null, error: null };
}

/**
 * Everything the settings page needs to show the rescue kit.
 *
 * @param {{
 *   pluginDir?: string,
 *   env?: object,
 *   platform?: string,
 *   exists?: (p: string) => boolean,
 *   iconPath?: string,
 *   readRegistry?: () => string,
 * }} [options]
 * @returns {{
 *   pluginDir: string,
 *   platform: string,
 *   scriptsDir: string,
 *   restoreProfile: string,
 *   emergencyDisable: string,
 *   desktopDir: string,
 *   desktopSource: string,
 *   shortcutPath: string,
 *   shortcutName: string,
 *   shortcutExists: boolean,
 *   iconPath: string,
 * }}
 */
export function rescueInfo({
  pluginDir = '',
  env = process.env,
  platform = process.platform,
  exists = defaultExists,
  iconPath = '',
  readRegistry = defaultReadRegistryDesktop,
} = {}) {
  const scripts = rescueScriptsDir(pluginDir);
  const names = rescueScriptNames(platform);
  // THE DESKTOP SHORTCUT IS A WINDOWS `.lnk`: on the other platforms there is
  // nothing to offer (and a dead path would be worse than none). Which platform
  // this is travels with the answer, so the page can SAY so instead of showing
  // an empty gap.
  const location = platform === 'win32' ? desktopLocation({ env, platform, exists, readRegistry }) : { dir: '', source: DESKTOP_SOURCES.none };
  const desktop = location.dir;
  const shortcut = desktopShortcutPath(desktop);
  let shortcutExists = false;
  if (shortcut !== '') {
    try {
      shortcutExists = exists(shortcut) === true;
    } catch {
      shortcutExists = false;
    }
  }
  let icon = typeof iconPath === 'string' ? iconPath.trim() : '';
  if (icon !== '') {
    try {
      if (exists(icon) !== true) icon = '';
    } catch {
      icon = '';
    }
  }
  return {
    pluginDir: typeof pluginDir === 'string' ? pluginDir : '',
    platform,
    scriptsDir: scripts,
    restoreProfile: scripts === '' ? '' : path.join(scripts, names.restoreProfile),
    emergencyDisable: scripts === '' ? '' : path.join(scripts, names.emergencyDisable),
    desktopDir: desktop,
    desktopSource: location.source,
    shortcutPath: shortcut,
    shortcutName: DESKTOP_SHORTCUT_NAME,
    shortcutExists,
    iconPath: icon,
    // ONE SOURCE FOR THE ICON (user decision, 2026-11-02): the desktop `.lnk`
    // and the settings page must show the SAME icon, and both must say the same
    // thing when there is none. `iconPath` is that single answer; the name is
    // only so the page can write down which file it used.
    iconName: icon === '' ? '' : path.basename(icon),
    iconAvailable: icon !== '',
  };
}
