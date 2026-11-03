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
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import childProcess from 'node:child_process';
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

/** What is in this directory? (Injected for the same reason as `defaultExists`.) */
function defaultList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
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
  // "no shortcut". The caller passes '' when this install has no icon of its own
  // (see `pluginShortcutIcon`) — and '' is what it gets instead of somebody
  // else's face.
  if (typeof iconPath === 'string' && iconPath.trim() !== '') {
    lines.push('$lnk.IconLocation = ' + powerShellQuote(iconPath.trim() + ',0'));
  }
  lines.push('$lnk.Save()');
  // TELL THE SHELL TO RE-READ THIS ONE FILE (user report, 2026-11-02: "the
  // shortcut still shows no icon"). `Save()` writes the `.lnk`, but Explorer
  // draws icons from its own per-file cache, and a shortcut that was created
  // while the icon file was missing (or broken — see `scripts/build-icon.mjs`)
  // keeps the cached blank page until that cache entry is invalidated.
  // `SHCNE_UPDATEITEM` on the shortcut's own path is the narrow way to say
  // "this item changed, look again": no cache rebuild, no Explorer restart, and
  // it costs one line in the same PowerShell call.
  lines.push(
    'Add-Type -Namespace DshRescueIcon -Name Shell -MemberDefinition '
    + powerShellQuote('[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern void SHChangeNotify(int eventId, uint flags, string item1, System.IntPtr item2);')
    + ' -ErrorAction SilentlyContinue',
  );
  lines.push(
    'if (-not [string]::IsNullOrEmpty(' + powerShellQuote(linkPath) + ')) { '
    + '[DshRescueIcon.Shell]::SHChangeNotify(0x00002000, 0x0001, ' + powerShellQuote(linkPath) + ', [System.IntPtr]::Zero) }',
  );
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
 * WHAT AN EXISTING `.lnk` CURRENTLY SAYS, without trusting anything cached.
 *
 * Windows keeps the icon path inside the `.lnk` and caches the picture by that path.
 * A shortcut written while an older icon was current therefore keeps drawing the
 * older picture for ever - nothing ever re-reads it from the plugin. Reading it back
 * is what makes that difference visible at all.
 *
 * @param {{ linkPath?: string, readLink?: (p: string) => object }} [options]
 * @returns {{ ok: boolean, exists: boolean, targetPath: string, iconLocation: string, error: string|null }}
 */
export function readShortcutLink({ linkPath = '', readLink = defaultReadShortcut } = {}) {
  const link = typeof linkPath === 'string' ? linkPath.trim() : '';
  if (link === '') {
    return { ok: false, exists: false, targetPath: '', iconLocation: '', error: 'no shortcut path' };
  }
  let raw;
  try {
    raw = readLink(link);
  } catch (error) {
    return {
      ok: false,
      exists: false,
      targetPath: '',
      iconLocation: '',
      error: error && error.message ? error.message : String(error),
    };
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, exists: false, targetPath: '', iconLocation: '', error: 'no answer from the shell' };
  }
  return {
    ok: raw.ok !== false,
    exists: raw.exists !== false,
    targetPath: typeof raw.targetPath === 'string' ? raw.targetPath : '',
    iconLocation: typeof raw.iconLocation === 'string' ? raw.iconLocation : '',
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

/**
 * MAKE THE DESKTOP SHORTCUT WEAR THE ICON THIS BUILD SHIPS (2026-11-03).
 *
 * The bug this closes: the `.lnk` is written only when the user presses the button,
 * so a shortcut created while an older icon was current keeps pointing at that older
 * picture for ever - the plugin reports the new icon, the desktop shows the old one,
 * and a host restart changes nothing because nothing ever re-writes the file.
 *
 * The rule, in one place:
 *
 *   - no `.lnk` -> nothing to do (putting files on the desktop is the button's job);
 *   - the `.lnk` already names the icon this build would use -> DO NOT WRITE, so a
 *     normal start neither touches the file nor refreshes the shell for nothing;
 *   - anything else -> rewrite it once, keeping `TargetPath` exactly as it was.
 *
 * No icon name is hard-coded here: `iconPath` comes from `ensureShortcutIcon()`,
 * whose file name is the CONTENT hash, so a rebuilt or replaced icon gets a new name
 * and this comparison notices by itself.
 *
 * @param {{
 *   linkPath?: string,
 *   iconPath?: string,
 *   readLink?: (p: string) => object,
 *   createLink?: (input: object) => object,
 * }} [options]
 * @returns {{ changed: boolean, reason: string, iconLocation: string, targetPath: string, error: string|null }}
 */
export function syncShortcutIcon({
  linkPath = '',
  iconPath = '',
  readLink = defaultReadShortcut,
  createLink = defaultCreateShortcut,
} = {}) {
  const link = typeof linkPath === 'string' ? linkPath.trim() : '';
  const icon = typeof iconPath === 'string' ? iconPath.trim() : '';
  const same = (reason, extra = {}) => ({
    changed: false,
    reason,
    iconLocation: extra.iconLocation ?? '',
    targetPath: extra.targetPath ?? '',
    error: extra.error ?? null,
  });
  if (link === '' || icon === '') return same('nothing-to-do');
  // NEVER POINT A REAL SHORTCUT AT A TEMPORARY FILE (2026-11-03).
  //
  // A test run keeps its state under `os.tmpdir()`. Without this guard, a suite that
  // boots the plugin would repoint the USER'S OWN desktop shortcut at an icon inside
  // a throwaway directory - the picture vanishes when that directory is cleaned, and
  // the test has silently edited the user's desktop. Production icons live in the
  // plugin's state directory, never in temp.
  if (isInsideTempDir(icon)) return same('icon-in-temp-dir');
  const wanted = icon + ',0';
  const current = readShortcutLink({ linkPath: link, readLink });
  if (current.exists !== true) return same('no-shortcut', { error: current.error });
  if (current.iconLocation === wanted) {
    return same('already-current', { iconLocation: current.iconLocation, targetPath: current.targetPath });
  }
  if (current.targetPath.trim() === '') {
    // Without the target there is nothing safe to preserve, so leave the file alone.
    return same('unreadable-target', { iconLocation: current.iconLocation, error: current.error });
  }
  try {
    const written = createLink({ linkPath: link, targetPath: current.targetPath, iconPath: icon });
    if (written && typeof written === 'object' && written.ok === false) {
      return same('write-failed', {
        iconLocation: current.iconLocation,
        targetPath: current.targetPath,
        error: written.error ?? 'the shortcut could not be rewritten',
      });
    }
  } catch (error) {
    return same('write-failed', {
      iconLocation: current.iconLocation,
      targetPath: current.targetPath,
      error: error && error.message ? error.message : String(error),
    });
  }
  notifyShellIconChanged();
  return { changed: true, reason: 'icon-repointed', iconLocation: wanted, targetPath: current.targetPath, error: null };
}

/** Ask the shell to drop the picture it cached for shortcut icons, best effort. */
function notifyShellIconChanged() {
  if (process.platform !== 'win32') return;
  try {
    childProcess.execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -Namespace Shell32 -Name F -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);\';'
        + '[Shell32.F]::SHChangeNotify(0x08000000, 0x0000, [System.IntPtr]::Zero, [System.IntPtr]::Zero)',
    ], { stdio: 'ignore', windowsHide: true });
  } catch {
    // A shell that will not repaint must not be able to fail a boot.
  }
}

/**
 * Is this path inside the OS temporary directory?
 *
 * `syncShortcutIcon` uses it to stay away from a file a test run will delete: a
 * shortcut must never be pointed at a picture that disappears with `%TEMP%`.
 *
 * @param {string} target
 * @returns {boolean}
 */
function isInsideTempDir(target) {
  try {
    const temp = os.tmpdir();
    if (typeof temp !== 'string' || temp === '') return false;
    const normal = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
    return normal(target).startsWith(normal(temp));
  } catch {
    return false;
  }
}

/**
 * Read `TargetPath` and `IconLocation` out of a real `.lnk` through `WScript.Shell`.
 *
 * @param {string} linkPath
 * @returns {{ ok: boolean, exists: boolean, targetPath: string, iconLocation: string, error: string|null }}
 */
function defaultReadShortcut(linkPath) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$p = ' + powerShellQuote(linkPath),
    'if (-not (Test-Path -LiteralPath $p)) { Write-Output \'{"exists":false}\'; exit 0 }',
    '$ws = New-Object -ComObject WScript.Shell',
    '$lnk = $ws.CreateShortcut($p)',
    '$o = @{ exists = $true; targetPath = [string]$lnk.TargetPath; iconLocation = [string]$lnk.IconLocation }',
    'Write-Output ($o | ConvertTo-Json -Compress)',
  ].join('; ');
  try {
    const out = childProcess.execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ps,
    ], { encoding: 'utf8', windowsHide: true });
    const parsed = JSON.parse(String(out).trim());
    return {
      ok: true,
      exists: parsed.exists === true,
      targetPath: typeof parsed.targetPath === 'string' ? parsed.targetPath : '',
      iconLocation: typeof parsed.iconLocation === 'string' ? parsed.iconLocation : '',
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      exists: false,
      targetPath: '',
      iconLocation: '',
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * WHERE THE PLUGIN'S OWN ICON IS (user decision, 2026-11-02).
 *
 * THE MISTAKE THIS FIXES: the desktop shortcut carried DSH'S OWN EXECUTABLE as
 * its icon. On the desktop a user who is trying to recover a broken host saw a
 * file that looked exactly like DSH itself — "is this the program, or the rescue
 * thing?" — which is the opposite of what a rescue entry is for.
 *
 * WHY A SHIPPED `.ico` AND NOT THE PNG OR THE SVG: the icon of a Windows `.lnk`
 * is read out of an icon container (`.ico` / `.exe` / `.dll`). A `.png` or an
 * `.svg` is not one, and pointing `IconLocation` at them renders a blank entry —
 * that is why the old code needed an executable at all. `assets/icon.ico` is the
 * plugin's own mark, drawn from the same artwork as `assets/icon-180.png`, so the
 * settings page and the `.lnk` name ONE file and it is the plugin's.
 *
 * NOTHING HERE IS GUESSED OR GENERATED: the file either ships with the plugin or
 * the answer is "no icon". Writing an icon at runtime would mean a file in the
 * state directory that the page would have to advertise before it exists.
 *
 * THE CANDIDATES ARE ORDERED, AND ALL ARE INSIDE THE PLUGIN DIRECTORY: a
 * repository that ships the icon at the root (`icon.ico`) works as well as the
 * packaged `assets/icon.ico`.
 */
export const SHIPPED_ICON_FILES = Object.freeze(['assets/icon.ico', 'icon.ico']);

/**
 * THE ICON'S FILE NAME CARRIES ITS CONTENT, AND THAT IS THE POINT
 * (user report, 2026-11-02, the second half of "still no icon").
 *
 * Explorer caches the icon it drew PER ICON FILE PATH. Measured on the real
 * machine: after the ICO was rebuilt correctly, a shortcut that kept pointing at
 * the SAME path kept drawing the cached garbage — rewriting the `.lnk`, even
 * deleting and recreating it, changed nothing; a shortcut created in a NEW
 * location with the new file drew the mark immediately. So an update that only
 * rewrote `assets/icon.ico` in place could never fix a single existing desktop.
 *
 * `scripts/build-icon.mjs` therefore ships `assets/icon-<sha8>.ico`: a new build
 * is a new path, which is a new cache entry, which is what makes the fix visible
 * without asking anyone to rebuild the icon cache.
 */
export const HASHED_ICON_PATTERN = /^icon-[0-9a-f]{8}\.ico$/i;

/**
 * THE ICON THE DESKTOP USES IS THE "RESCUE" ONE (user decision, 2026-11-02).
 *
 * The user picked a specific picture - the DSH artwork with a round restore badge
 * in the corner - out of several previews, so the shortcut must NOT fall back to
 * the plugin's own flame mark while that picture ships. `scripts/build-icon.mjs
 * --rescue` writes it as `assets/icon-rescue-<sha8>.ico`; the same content hash
 * also names the 256 px preview PNG, so "one build, two renderings" is checkable
 * rather than claimed.
 */
export const RESCUE_ICON_PATTERN = /^icon-rescue-[0-9a-f]{8}\.ico$/i;

/** The size the settings page is given as a data URI (see `iconDataUriFromIco`). */
export const RESCUE_PAGE_SIZE = 48;

/**
 * The settings page and the shortcut must show THE SAME PICTURE, not two drawings
 * that happen to look alike. Reading the 48 px entry straight out of the shipped
 * `.ico` and re-encoding it as a PNG guarantees that by construction: there is one
 * source file, and the page's bytes are decoded from the very entry the shell
 * picks when it draws the shortcut at that size.
 *
 * A 32-bpp ICO entry is a BITMAPINFOHEADER plus bottom-up BGRA rows and no AND
 * mask (the mask-free shape is what this build writes - see
 * `scripts/build-icon.mjs`).
 *
 * @param {string} icoPath
 * @param {{ size?: number, readFile?: (p: string) => Buffer }} [options]
 * @returns {{ dataUri: string, hash: string, size: number }|null} null when the
 *   entry is missing or unreadable - never a broken data URI
 */
export function iconDataUriFromIco(icoPath, { size = RESCUE_PAGE_SIZE, readFile = (p) => fs.readFileSync(p) } = {}) {
  let buffer
  try {
    buffer = readFile(icoPath)
  } catch {
    return null
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null
  const count = buffer.readUInt16LE(4)
  let entry = null
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16
    const width = buffer[at] === 0 ? 256 : buffer[at]
    if (width !== size) continue
    const bytes = buffer.readUInt32LE(at + 8)
    const offset = buffer.readUInt32LE(at + 12)
    if (offset + bytes > buffer.length || bytes < 40) continue
    entry = { offset, bytes }
    break
  }
  if (entry === null) return null
  const headerSize = buffer.readUInt32LE(entry.offset)
  if (headerSize !== 40) return null
  const width = buffer.readInt32LE(entry.offset + 4)
  const height = buffer.readInt32LE(entry.offset + 8) / 2
  if (width !== size || height !== size) return null
  const pixels = entry.offset + headerSize
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const sourceY = size - 1 - y // DIB rows are bottom-up
    for (let x = 0; x < size; x += 1) {
      const from = pixels + (sourceY * size + x) * 4
      const to = (y * size + x) * 4
      rgba[to] = buffer[from + 2] // B -> R
      rgba[to + 1] = buffer[from + 1]
      rgba[to + 2] = buffer[from]
      rgba[to + 3] = buffer[from + 3]
    }
  }
  const png = encodePng(rgba, size, size)
  return {
    dataUri: 'data:image/png;base64,' + png.toString('base64'),
    hash: crypto.createHash('sha256').update(png).digest('hex').slice(0, 8),
    size,
  }
}

/** Encode RGBA pixels as a PNG. `node:zlib` is all a zero-dependency PNG needs. */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (let index = 0; index < buffer.length; index += 1) {
      crc ^= buffer[index]
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * GIVE THE SHORTCUT ITS OWN COPY OF THE ICON, UNDER A CONTENT-ADDRESSED NAME
 * (user report, 2026-11-02, and the reason the obvious fix was not enough).
 *
 * MEASURED: `icon-<sha8>.ico` built by `scripts/build-icon.mjs` is correct — GDI+
 * decodes it to the artwork, and a `.lnk` that names a COPY of those exact bytes
 * renders the mark. The SAME BYTES read from the plugin's own `assets/` path
 * rendered a solid block, on a path that had never been used before. So what the
 * shell serves is not necessarily what the file says: an icon path that this
 * machine has already drawn once keeps being served from its cache, and no amount
 * of rebuilding the `.lnk` (rewriting it, deleting and recreating it) changes it.
 *
 * The way out is a path the shell has never seen: this copy lives in the plugin's
 * own state directory (`<DSH_HOME>/storages/dsh-autorestart/`), named after the
 * icon's content, so
 *   - a new build is a new name, which is a new cache entry;
 *   - the desktop is not littered with an extra file;
 *   - the copy can be deleted at any time (it is regenerated on demand).
 *
 * It is best effort: when it cannot be written, the caller keeps the asset path.
 *
 * @param {{
 *   sourceIcon?: string,
 *   stateDir?: string,
 *   exists?: (p: string) => boolean,
 *   readFile?: (p: string) => Buffer,
 *   writeFile?: (p: string, data: Buffer) => void,
 *   mkdir?: (p: string) => void,
 * }} [options]
 * @returns {string} the path to hand to `IconLocation`, or '' when there is nothing
 */
export function ensureShortcutIcon({
  sourceIcon = '',
  stateDir = '',
  exists = defaultExists,
  readFile = (target) => fs.readFileSync(target),
  writeFile = (target, data) => fs.writeFileSync(target, data),
  mkdir = (target) => fs.mkdirSync(target, { recursive: true }),
} = {}) {
  const source = typeof sourceIcon === 'string' ? sourceIcon.trim() : '';
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (source === '' || dir === '') return source;
  let bytes;
  try {
    bytes = readFile(source);
  } catch {
    return source;
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return source;
  // THE NAME IS THE CONTENT'S HASH, NOT THE PATH'S: a rebuilt icon at the same
  // path must still get a new name, or it lands on the cache entry that was
  // serving the old (broken) face and the fix is invisible.
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const target = path.join(dir, 'shortcut-icon-' + hash + '.ico');
  try {
    if (exists(target) === true) return target;
    mkdir(dir);
    writeFile(target, bytes);
    return exists(target) === true ? target : source;
  } catch {
    // A state directory that cannot be written must not cost the user the icon
    // it already had: the asset path stays as it is.
    return source;
  }
}

/**
 * The plugin's own icon file, or '' when this install has none.
 *
 * A HASHED NAME WINS (see `HASHED_ICON_PATTERN`): `assets/icon-<sha8>.ico` is
 * what the builder ships, and it must be preferred over any plain `icon.ico`
 * left behind by an older install — the plain one is exactly the path whose
 * stale cache entry made the shortcut look empty.
 *
 * @param {{ pluginDir?: string, exists?: (p: string) => boolean, list?: (dir: string) => string[] }} [options]
 * @returns {string} an absolute path that really exists, or ''
 */
export function pluginShortcutIcon({ pluginDir = '', exists = defaultExists, list = defaultList } = {}) {
  const dir = typeof pluginDir === 'string' ? pluginDir.trim() : '';
  if (dir === '') return '';
  const assetsDir = path.join(dir, 'assets');
  let names = [];
  try {
    names = list(assetsDir);
  } catch {
    names = [];
  }
  const sorted = (Array.isArray(names) ? names : []).filter((name) => typeof name === 'string');
  // (0) THE RESCUE ICON WINS (user decision, 2026-11-02): the picture the user
  // approved - the DSH artwork with the restore badge - is what a shortcut should
  // wear while the package ships it. Newest hashed name first.
  const rescue = sorted.filter((name) => RESCUE_ICON_PATTERN.test(name)).sort();
  if (rescue.length > 0) {
    const candidate = path.join(assetsDir, rescue[rescue.length - 1]);
    try {
      if (exists(candidate) === true) return candidate;
    } catch {
      // fall through to the plugin's own mark
    }
  }
  // (1) THE HASHED ONE, newest name first — one shipped icon per build.
  const hashed = sorted.filter((name) => HASHED_ICON_PATTERN.test(name)).sort();
  if (hashed.length > 0) {
    const candidate = path.join(assetsDir, hashed[hashed.length - 1]);
    try {
      if (exists(candidate) === true) return candidate;
    } catch {
      // fall through to the plain names
    }
  }
  // (2) AN OLDER INSTALL'S PLAIN NAME. Still better than no icon, and an old
  // package may not ship the hashed one yet.
  for (const relative of SHIPPED_ICON_FILES) {
    const candidate = path.join(dir, relative);
    try {
      if (exists(candidate) === true) return candidate;
    } catch {
      // An unreadable path is "no icon here", never a throw.
      continue;
    }
  }
  return '';
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
 * }} [options] `iconPath` is an EXPLICIT icon and wins when it is not empty.
 *   Left out (the production call), the plugin's OWN icon is resolved from
 *   `pluginDir` — the host's executable is never used as a fallback.
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
  list = defaultList,
  iconTransform = null,
  readFile = (target) => fs.readFileSync(target),
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
  if (icon === '') {
    // NOBODY NAMED ONE: the plugin's own mark (2026-11-02). It never falls back
    // to the executable of the host — that is what made the desktop entry look
    // like DSH itself, and "no icon" is the honest answer when this install
    // ships none.
    icon = pluginShortcutIcon({ pluginDir, exists, list });
  }
  if (icon !== '') {
    try {
      if (exists(icon) !== true) icon = '';
    } catch {
      icon = '';
    }
  }
  // A LAST STEP THE CALLER MAY ADD (the Host uses it to put the icon somewhere
  // the shell has never cached — see `ensureShortcutIcon`). Applied here, and not
  // at the `.lnk` writer, so the page and the shortcut keep naming ONE file.
  if (icon !== '' && typeof iconTransform === 'function') {
    try {
      const transformed = iconTransform(icon);
      if (typeof transformed === 'string' && transformed.trim() !== '') icon = transformed.trim();
    } catch {
      // keep the asset path
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
    // THE PAGE'S COPY OF THE PICTURE (user decision, 2026-11-02, "the page and the
    // shortcut must be the same image"): the 48 px entry is decoded OUT of the very
    // `.ico` the shortcut names and re-encoded as a PNG data URI. One source file,
    // so "same drawing" is a fact about the bytes, not a promise; `iconDataUriHash`
    // is that PNG's own content hash, so a test can pin it.
    ...(() => {
      if (icon === '') return { iconDataUri: '', iconDataUriHash: '', iconDataUriSize: 0 };
      const decoded = iconDataUriFromIco(icon, { readFile });
      if (decoded === null) return { iconDataUri: '', iconDataUriHash: '', iconDataUriSize: 0 };
      return {
        iconDataUri: decoded.dataUri,
        iconDataUriHash: decoded.hash,
        iconDataUriSize: decoded.size,
      };
    })(),
  };
}
