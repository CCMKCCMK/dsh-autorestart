/**
 * dsh-autorestart — Windows-first detached restart executor.
 *
 * VERIFIED DESIGN (2026-10): the Electron main process does NOT supervise the
 * Host child, and no plugin-callable restart IPC exists. Therefore the only
 * viable restart is a *fully detached* process that (a) waits a moment, (b)
 * kills the whole `DeepSeek Harness.exe` tree, and (c) relaunches the app. The
 * kill+relaunch must live in ONE synchronous `cmd.exe /c ... & ... & ...` line,
 * executed by a service that is not inside the dying Electron job object:
 * WMI `Win32_Process.Create` first, `schtasks` fallback.
 *
 * Nothing here throws: every failure is returned as `{ ok:false, error }`.
 * Unit tests only inspect the generated command strings and use `dryRun`.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * THE V1 ROLLBACK WATCHER IS A POWERSHELL SCRIPT (2026-11-02).
 *
 * `buildWatchScript` writes PowerShell, so the whole v1 path is a Windows path.
 * Older builds did not say so: they wrote `restart-<n>-watch.ps1` on EVERY
 * platform and then tried to launch it, which on Linux/WSL could only fail —
 * and left the file behind. A real WSL machine had SEVEN of them
 * (restart-4/5/6/7/8/9/16), which is why the release checklist item
 * "leftover files = 0" was failing.
 *
 * This pattern is the only name the plugin ever writes, so it is also the only
 * name the sweep below is allowed to touch.
 */
export const LEGACY_WATCH_SCRIPT_PATTERN = /^restart-\d+-watch\.ps1$/;

/**
 * Does this text look like OUR rollback watcher (and not like a user's file that
 * happens to have the same name)?
 *
 * The check is deliberately narrow: the three markers below all come from
 * `buildWatchScript`, and a file that misses any of them is left alone. A sweep
 * that deletes the wrong file in a rescue path is worse than a leftover.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWatchScript(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /param\s*\(/.test(text)
    && /Start-Sleep|Wait-Job/.test(text)
    && /_dsh_autorestart|dsh-autorestart/.test(text);
}

/**
 * Remove the watcher scripts the old builds left on a NON-Windows machine.
 *
 * Rules (all of them are "be conservative"):
 *   - Windows keeps everything: there those files really are used, and the one
 *     that is running right now must not be pulled from under it.
 *   - Only `restart-<digits>-watch.ps1` is considered.
 *   - The CONTENT must look like our watcher (`looksLikeWatchScript`).
 *   - A file modified in the last `minAgeMs` is skipped: a process that just
 *     wrote it may still be starting.
 *   - Nothing here throws: a failure is returned.
 *
 * @param {string} dir the plugin's state directory
 * @param {{ platform?: string, minAgeMs?: number, now?: number }} [options]
 * @returns {{ skipped: boolean, reason: string|null, removed: string[], kept: string[], scanned: number, error: string|null }}
 */
export function sweepLegacyWatcherScripts(
  dir,
  { platform = process.platform, minAgeMs = 60_000, now = Date.now() } = {},
) {
  const result = { skipped: false, reason: null, removed: [], kept: [], scanned: 0, error: null };
  if (platform === 'win32') {
    result.skipped = true;
    result.reason = 'not-applicable: on Windows these watcher scripts are really used, so none is removed';
    return result;
  }
  if (typeof dir !== 'string' || dir === '') {
    result.skipped = true;
    result.reason = 'no state directory to sweep';
    return result;
  }
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    // A directory that does not exist yet is not a failure: nothing was left.
    const code = error && error.code;
    if (code === 'ENOENT') {
      result.skipped = true;
      result.reason = 'no state directory yet';
      return result;
    }
    result.error = error && error.message ? String(error.message) : String(error);
    return result;
  }
  for (const name of names) {
    if (!LEGACY_WATCH_SCRIPT_PATTERN.test(name)) continue;
    result.scanned += 1;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) {
        result.kept.push(name);
        continue;
      }
      // Never touch a file that was just written: the writer may still be running.
      if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) {
        result.kept.push(name);
        continue;
      }
      if (!looksLikeWatchScript(readFileSync(file, 'utf8'))) {
        result.kept.push(name);
        continue;
      }
      unlinkSync(file);
      result.removed.push(name);
    } catch (error) {
      result.kept.push(name);
      result.error = error && error.message ? String(error.message) : String(error);
    }
  }
  return result;
}

/** Default name of the one-shot scheduled-task fallback. */
export const DEFAULT_TASK_NAME = 'dsh-autorestart-restart';

/** Default name of the one-shot scheduled task that runs the rollback watcher. */
export const DEFAULT_WATCH_TASK_NAME = 'dsh-autorestart-watch';

/**
 * How long the restart command may run before the plugin stops waiting for it.
 *
 * The command is the user's own: it usually returns in a second or two
 * (`systemctl --user restart …`, a small shell script). A command that starts
 * the host in the FOREGROUND never returns — that is not a failure, but the
 * plugin must not wait for it for ever, so the window is bounded and the
 * outcome is reported as "still running" instead of "failed".
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

/** Default image name that `taskkill` matches on Windows. */
export const DEFAULT_IMAGE_NAME = 'DeepSeek Harness.exe';

/** How long the detached command waits before killing the app, in seconds. */
export const DEFAULT_RELAUNCH_DELAY_SECONDS = 4;

/**
 * HOW THE RESTART HELPER IS STARTED (user decision, 2026-11-09).
 *
 * `foreground` — the helper `.cmd` is scheduled exactly as it always was: the
 * scheduler (WMI / schtasks / a detached spawn) starts `cmd.exe /c <script>`,
 * and that `cmd.exe` owns a console window while its `ping` delay runs.
 * This is the DEFAULT and its command line is byte for byte what it was.
 *
 * `background` — the very same helper is started through a tiny VBScript shim:
 * `wscript.exe //B <shim>.vbs`, and the shim runs
 * `CreateObject("WScript.Shell").Run "<cmd line>", 0, False`.
 * That form is the only one that satisfies BOTH promises:
 *
 *   1. NO window is ever created — `wscript.exe` is a GUI-subsystem process,
 *      so not even a console is allocated for it, and window style `0`
 *      (SW_HIDE) hides the helper `cmd.exe` it starts;
 *   2. nothing is activated — `Run` with style 0 never takes the focus, so a
 *      full-screen game is not switched away from. A window that merely
 *      "flashes and closes" is exactly what the user rejected.
 *
 * `False` means "do not wait": the shim ends at once and the helper carries on
 * on its own, so the shim can remove itself immediately (see
 * `buildWindowShimScript`).
 *
 * The FALLBACK for a machine whose policy forbids Windows Script Host is a
 * `powershell.exe -WindowStyle Hidden` wrapper (`buildHiddenPowerShellCommand`).
 * It is deliberately louder — PowerShell is a console process, so a window can
 * flash — which is why the launcher that was really used is recorded in the
 * restart report instead of being silently swapped in.
 */
export const RESTART_WINDOW_FOREGROUND = 'foreground';
export const RESTART_WINDOW_BACKGROUND = 'background';
export const RESTART_WINDOW_CHOICES = [RESTART_WINDOW_FOREGROUND, RESTART_WINDOW_BACKGROUND];

/**
 * The effective window mode. ANY value that is not exactly `background` is the
 * foreground mode: an old profile, a hand-edited row or a wrong type must never
 * throw, block a restart or change the default behaviour.
 *
 * @param {unknown} value
 * @returns {'foreground'|'background'}
 */
export function normalizeRestartWindow(value) {
  return value === RESTART_WINDOW_BACKGROUND ? RESTART_WINDOW_BACKGROUND : RESTART_WINDOW_FOREGROUND;
}

/**
 * The only name of a window shim the plugin ever writes.
 *
 * Same rule as `LEGACY_WATCH_SCRIPT_PATTERN`: a sweep must recognise its own
 * files by name AND content, so a user's `.vbs` in the same directory is never
 * touched.
 */
export const WINDOW_SHIM_PATTERN = /^restart-\d+-window\.vbs$/;

/**
 * Does this text look like OUR window shim?
 *
 * The markers all come from `buildWindowShimScript`: the WScript shell object,
 * the hidden-and-do-not-wait run, and the plugin's own comment banner.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWindowShim(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /WScript\.Shell/.test(text) && /, 0, False/.test(text) && /dsh-autorestart/.test(text);
}

/**
 * Build the VBScript shim that starts the restart helper without a window.
 *
 * WHY A SHIM AT ALL: the console window belongs to the helper `.cmd` that the
 * scheduler creates; a wrapper that hides only ITSELF (a `powershell -WindowStyle
 * Hidden`, a `start /min`) still lets that `cmd.exe` show up — and a visible
 * window that flashes for four seconds is exactly the complaint. WScript starts
 * the child with `SW_HIDE` and never activates it.
 *
 * THREE MODES, ONE FILE (user report, 2026-11-09 — the flash after the window
 * closed). The helper `.cmd` used to finish with `start "" powershell.exe
 * -WindowStyle Hidden …`: `powershell.exe` creates its console FIRST and hides it
 * afterwards, so a small window flashed exactly when the host was started again.
 * The same line also starts the rollback watcher, so it flashed twice. Both steps
 * therefore go back through this shim, by argument:
 *
 *   (no argument) — run the helper command line hidden (how the restart is armed).
 *   `launch`      — start the host with `Shell.Application.ShellExecute`. `wscript.exe`
 *                   is a GUI-subsystem process, so NO console is created at all.
 *                   If the call is refused the shim falls back to the hidden
 *                   PowerShell line, which can flash — that is why the report names
 *                   the fallback.
 *   `watch`       — start the rollback watcher hidden, for the same reason.
 *
 * THE FILE SURVIVES ITS FIRST RUN: the launch step re-enters this same script a
 * few seconds later, so a no-argument run must NOT delete it (that would pull the
 * script out from under the relaunch). `launch`/`watch` delete it when they end;
 * an aborted restart leaves it for `sweepRestartHelpers`, which is what the sweep
 * is for and what the report names.
 *
 * The command lines are cut into short chunks because a VBScript line is limited
 * to 1023 characters and the inline restart command (wait + kill + cleanup +
 * relaunch) can get long. Doubled quotes are never split: `""` is one escaped
 * quote, not two characters of the literal.
 *
 * @param {string} command the command line the foreground mode would schedule
 * @param {{ appExePath?: string|null, watchScriptPath?: string|null }} [options]
 * @returns {string} `.vbs` script text (CRLF line endings, pure ASCII)
 */
export function buildWindowShimScript(command, { appExePath = null, watchScriptPath = null } = {}) {
  const chunkSize = 200;
  const escapedValue = (value) => String(value == null ? '' : value).replace(/"/g, '""');
  /** One chunked VBScript string assignment (`name = name & "…"`). */
  const assignment = (name, value) => {
    const text = escapedValue(value);
    if (text === '') return [name + ' = ""'];
    const out = [name + ' = ""'];
    for (let index = 0; index < text.length;) {
      let end = Math.min(text.length, index + chunkSize);
      if (end < text.length && text[end - 1] === '"' && text[end] === '"') end += 1;
      out.push(name + ' = ' + name + ' & "' + text.slice(index, end) + '"');
      index = end;
    }
    return out;
  };
  const exe = typeof appExePath === 'string' && appExePath !== '' ? appExePath : '';
  const watch = typeof watchScriptPath === 'string' && watchScriptPath !== '' ? watchScriptPath : '';
  const lines = [
    "' dsh-autorestart: start the restart helper WITHOUT a window and WITHOUT taking the focus.",
    "' Window style 0 = hidden, False = do not wait for it.",
    "' No argument runs the helper; \"launch\" starts the host with Shell.Application.ShellExecute",
    "' (no console at all); \"watch\" starts the rollback watcher hidden.",
    'Option Explicit',
    'Dim shell, fso, app, mode, commandLine, launchTarget, launchFallback, watchCommand',
    'Set shell = CreateObject("WScript.Shell")',
  ];
  lines.push(...assignment('commandLine', command));
  if (exe !== '') {
    lines.push(...assignment('launchTarget', exe));
    lines.push(...assignment('launchFallback', relaunchFallbackLine(exe)));
  } else {
    lines.push('launchTarget = ""', 'launchFallback = ""');
  }
  if (watch !== '') {
    // The watcher is a `.ps1`: `powershell -File <path>`, hidden by WScript itself
    // (no `start` builtin exists here, and no console is created).
    lines.push(...assignment(
      'watchCommand',
      'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + watch + '"',
    ));
  } else {
    lines.push('watchCommand = ""');
  }
  lines.push(
    'If WScript.Arguments.length = 0 Then',
    '  On Error Resume Next',
    '  shell.Run commandLine, 0, False',
    '  If Err.Number <> 0 Then WScript.Quit 1',
    '  On Error GoTo 0',
    '  WScript.Quit 0',
    'End If',
    'mode = LCase(WScript.Arguments(0))',
    'If mode = "launch" And launchTarget <> "" Then',
    '  On Error Resume Next',
    '  Set app = CreateObject("Shell.Application")',
    '  app.ShellExecute launchTarget, "", "", "open", 1',
    '  If Err.Number <> 0 Then',
    '    Err.Clear',
    '    shell.Run launchFallback, 0, False',
    '  End If',
    '  On Error GoTo 0',
    'ElseIf mode = "watch" And watchCommand <> "" Then',
    '  On Error Resume Next',
    '  shell.Run watchCommand, 0, False',
    '  On Error GoTo 0',
    'End If',
    "' THE SHIM CLEANS UP AFTER ITSELF (best effort: the sweep names a leftover).",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'On Error Resume Next',
    'fso.DeleteFile WScript.ScriptFullName, True',
    'On Error GoTo 0',
    '',
  );
  return lines.join('\r\n');
}

/**
 * The FALLBACK launcher: the same command line, started by a hidden PowerShell
 * with `CreateNoWindow`, for a machine whose policy forbids Windows Script Host.
 *
 * The script is passed as `-EncodedCommand` (base64 of UTF-16LE), so a command
 * line that carries quotes, `&`, `>` or `<` needs no escaping layer at all.
 * `ProcessStartInfo.Arguments` is a raw string, so the child `cmd.exe` gets
 * exactly `/c <command>` — the same text the foreground mode hands to WMI.
 *
 * @param {string} command
 * @returns {string}
 */
export function buildHiddenPowerShellCommand(command) {
  const inner = [
    "$cmd = '" + psSingle(command) + "'",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    "$psi.FileName = 'cmd.exe'",
    "$psi.Arguments = '/c ' + $cmd",
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '[void][System.Diagnostics.Process]::Start($psi)',
  ].join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  return 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + encoded;
}

/**
 * The gate helper `.cmd` of one restart generation.
 *
 * Its name is fixed by the caller (`restart-<generation>.cmd`), so the pattern
 * is the whole identity on the name side; the content check below makes sure a
 * file that merely LOOKS like one is left alone.
 */
export const HELPER_SCRIPT_PATTERN = /^restart-\d+\.cmd$/;

/**
 * Does this text look like OUR gate helper?
 *
 * The two markers both come from `buildGateScript`: the `@echo off` first line
 * and the plugin's own `rem dsh-autorestart:` banner.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeGateHelper(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /^\s*@echo off/m.test(text) && /dsh-autorestart/.test(text);
}

/**
 * Remove the helper files an earlier restart left behind.
 *
 * TWO KINDS (2026-11-09):
 *
 *   1. the window shims of background restarts (`restart-<n>-window.vbs`);
 *   2. the gate helpers of EVERY restart (`restart-<n>.cmd`).
 *
 * MEASURED ON THE REAL MACHINE: 351 `restart-<n>.cmd` files in the state
 * directory (373 KB, written between 10-22 and 11-09) — one per restart, never
 * removed, because only the `.vbs` was swept. They can never be used again:
 * each one is written for one generation and runs a helper whose watcher is
 * already gone, so they were pure residue that the "leftover files = 0" release
 * check kept failing on.
 *
 * The sweep stays conservative, exactly like `sweepLegacyWatcherScripts`:
 * a strict name, a CONTENT that is ours, and never a file written in the last
 * `minAgeMs` (the scheduler may still be reading the `.cmd` it was given).
 * Nothing throws: every removal and every failure is counted and returned, so
 * the caller can put the numbers into its report.
 *
 * @param {string} dir the plugin's state directory
 * @param {{ minAgeMs?: number, now?: number }} [options]
 * @returns {{
 *   removed: string[], kept: string[], scanned: number,
 *   removedCmd: string[], removedVbs: string[], error: string|null,
 *   failed: number,
 * }}
 */
export function sweepRestartHelpers(dir, { minAgeMs = 60_000, now = Date.now() } = {}) {
  const result = {
    removed: [],
    kept: [],
    scanned: 0,
    removedCmd: [],
    removedVbs: [],
    error: null,
    failed: 0,
  };
  if (typeof dir !== 'string' || dir === '') return result;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = error && error.code;
    if (code !== 'ENOENT') result.error = error && error.message ? String(error.message) : String(error);
    return result;
  }
  for (const name of names) {
    const isShim = WINDOW_SHIM_PATTERN.test(name);
    const isHelper = HELPER_SCRIPT_PATTERN.test(name);
    if (!isShim && !isHelper) continue;
    result.scanned += 1;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) {
        result.kept.push(name);
        continue;
      }
      // Never touch a file that was just written: the scheduler may be starting
      // it, or `cmd.exe` may still be reading it.
      if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) {
        result.kept.push(name);
        continue;
      }
      const text = readFileSync(file, 'utf8');
      const ours = isShim ? looksLikeWindowShim(text) : looksLikeGateHelper(text);
      if (!ours) {
        result.kept.push(name);
        continue;
      }
      unlinkSync(file);
      result.removed.push(name);
      if (isShim) result.removedVbs.push(name);
      else result.removedCmd.push(name);
    } catch (error) {
      result.kept.push(name);
      result.failed += 1;
      result.error = error && error.message ? String(error.message) : String(error);
    }
  }
  return result;
}

/**
 * The old name of {@link sweepRestartHelpers} (it used to sweep the `.vbs`
 * shims only). Kept as an alias so an older caller cannot silently lose the
 * sweep; both now cover `.vbs` AND `.cmd`.
 *
 * @param {string} dir
 * @param {{ minAgeMs?: number, now?: number }} [options]
 * @returns {ReturnType<typeof sweepRestartHelpers>}
 */
export function sweepWindowShims(dir, options) {
  return sweepRestartHelpers(dir, options);
}

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/** Escape a value for a single-quoted PowerShell string. @param {unknown} value */
function psSingle(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The FILE NAMES of the desktop app's executable.
 *
 * The verdict is about the FILE NAME, never about the whole path: the desktop
 * app ships its own node INSIDE its installation directory
 * (`…\DeepSeek Harness\resources\runtime\…\node\bin\node.exe`), and a HOSTED
 * deployment that runs with that node is NOT the desktop app. The old rule (a
 * regex over the whole path) called every such host the desktop app, so the
 * derivation refused to write a restart command for it (`desktop-app`, nothing
 * to write) even though the host was a perfectly ordinary hosted one.
 */
const DESKTOP_EXE_NAMES = new Set(['deepseek harness']);

/**
 * The images that BREAK the parent chain.
 *
 * A shell between this process and the Electron shell means that SOMEBODY ELSE
 * started it (a terminal, a service, a scheduled task): the desktop app is not
 * in charge of this host, whatever the environment says.
 */
const SHELL_IMAGE_NAMES = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'conhost',
  'terminal',
  'windowsterminal',
  'wt',
  'nu',
  'alacritty',
  'wezterm-gui',
  'hyper',
]);

/** How far up the parent chain the plugin looks for the Electron shell. */
const MAX_ANCESTOR_DEPTH = 4;

/**
 * The FILE NAME of an executable — the last segment, whatever the separator.
 *
 * @param {unknown} execPath
 * @returns {string}
 */
export function executableBasename(execPath) {
  const text = typeof execPath === 'string' ? execPath.trim() : '';
  if (text === '') return '';
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * The name of an executable, normalized for comparison: lower case, without
 * the `.exe` suffix, and the separators (` `, `-`, `_`) folded into one space.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizedExecutableName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[-_\s]+/g, ' ')
    .trim();
}

/**
 * Is this the file name of the desktop app?
 *
 * `DeepSeek Harness.exe` and `deepseek-harness.exe` are the same app; a
 * `node.exe` that happens to live inside the app's directory is not.
 *
 * @param {unknown} execPath
 * @returns {boolean}
 */
export function isDesktopExecutableName(execPath) {
  return DESKTOP_EXE_NAMES.has(normalizedExecutableName(executableBasename(execPath)));
}

/**
 * What is known about one process (POSIX: /proc).
 *
 * @param {number} pid
 * @returns {{ pid: number, ppid: number, imageName: string, commandLine: string }|null}
 */
function readPosixProcessInfo(pid) {
  const number = Number(pid);
  if (!Number.isFinite(number) || number <= 0) return null;
  const base = '/proc/' + number;
  let status = '';
  try {
    status = readFileSync(base + '/status', 'utf8');
  } catch {
    return null;
  }
  const parent = /PPid:\s*(\d+)/.exec(status);
  let commandLine = '';
  try {
    const raw = readFileSync(base + '/cmdline');
    commandLine = (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw))
      .split('\0')
      .filter((part) => part !== '')
      .join(' ');
  } catch {
    commandLine = '';
  }
  let imageName = '';
  try {
    imageName = path.basename(readlinkSync(base + '/exe'));
  } catch {
    imageName = '';
  }
  if (imageName === '') {
    const first = commandLine.split(' ')[0] ?? '';
    imageName = executableBasename(first);
  }
  return {
    pid: number,
    ppid: parent ? Number(parent[1]) : 0,
    imageName,
    commandLine,
  };
}

/**
 * Parse the CSV table of `wmic process get …`.
 *
 * @param {string} text
 * @returns {Array<{ pid: number, ppid: number, imageName: string }>}
 */
function parseWmicProcessTable(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((part) => part.trim().toLowerCase());
  const nameIndex = header.indexOf('name');
  const ppidIndex = header.indexOf('parentprocessid');
  const pidIndex = header.indexOf('processid');
  if (nameIndex < 0 || ppidIndex < 0 || pidIndex < 0) return [];
  const last = Math.max(nameIndex, ppidIndex, pidIndex);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
    if (cells.length <= last) continue;
    const pid = Number(cells[pidIndex]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, ppid: Number(cells[ppidIndex]) || 0, imageName: cells[nameIndex] });
  }
  return rows;
}

/**
 * Parse the JSON table of the CIM query.
 *
 * @param {string} text
 * @returns {Array<{ pid: number, ppid: number, imageName: string }>}
 */
function parseCimProcessTable(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const pid = Number(entry.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number(entry.ParentProcessId) || 0,
      imageName: String(entry.Name ?? ''),
    });
  }
  return rows;
}

/**
 * Ask Windows for its processes: `wmic` first (it answers in ~150 ms), the CIM
 * query of PowerShell as the fallback for the versions that removed `wmic`.
 *
 * @returns {Array<{ pid: number, ppid: number, imageName: string }>}
 */
function queryWindowsProcesses() {
  try {
    const stdout = execFileSync(
      'wmic',
      ['process', 'get', 'Name,ParentProcessId,ProcessId', '/FORMAT:CSV'],
      { windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    const rows = parseWmicProcessTable(String(stdout ?? ''));
    if (rows.length > 0) return rows;
  } catch {
    // `wmic` is gone on the newer Windows versions: the CIM query below.
  }
  try {
    const stdout = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    return parseCimProcessTable(String(stdout ?? ''));
  } catch {
    // No process table: the parent chain stays unavailable (and silent).
  }
  return [];
}

/** The Windows process table — read once per process, then remembered. */
let windowsProcessTable = null;

/**
 * The whole Windows process table: the image name and the parent of every
 * process.
 *
 * @returns {Map<number, { pid: number, ppid: number, imageName: string }>}
 */
function readWindowsProcessTable() {
  if (windowsProcessTable !== null) return windowsProcessTable;
  const table = new Map();
  for (const row of queryWindowsProcesses()) {
    table.set(row.pid, row);
  }
  windowsProcessTable = table;
  return table;
}

/**
 * The parent chain of a process, nearest ancestor first.
 *
 * POSIX reads /proc (free); Windows reads the process table once. When the
 * platform offers neither, the chain is EMPTY — an unknown chain is not
 * evidence, it only means the chain cannot be used.
 *
 * @param {number} rootPid the pid to start from (the parent of this process)
 * @param {{ platform?: string }} [options]
 * @returns {Array<{ pid: number, ppid: number, imageName: string, commandLine?: string }>}
 */
export function readProcessChain(rootPid, { platform = process.platform } = {}) {
  const start = Number(rootPid);
  if (!Number.isFinite(start) || start <= 0) return [];
  const chain = [];
  const seen = new Set();
  let pid = start;
  while (pid > 0 && chain.length < MAX_ANCESTOR_DEPTH && !seen.has(pid)) {
    seen.add(pid);
    const info = platform === 'win32'
      ? readWindowsProcessTable().get(pid) ?? null
      : readPosixProcessInfo(pid);
    if (info === null) break;
    chain.push(info);
    pid = Number(info.ppid) || 0;
  }
  return chain;
}

/**
 * Is this process the child of the Electron shell of the desktop app?
 *
 * The desktop host is started by the Electron MAIN process, which runs the
 * Electron binary as node: the host therefore carries `ELECTRON_RUN_AS_NODE=1`
 * AND its parent is the Electron shell.
 *
 * The marker ALONE is not enough: a host that was started from a shell the
 * desktop app spawned inherits it too. The parent chain decides — and a chain
 * that cannot be read is simply not used (it never denies the desktop verdict,
 * it only stays silent).
 *
 * @param {{
 *   env?: object,
 *   ppid?: number,
 *   platform?: string,
 *   readChain?: Function,
 * }} [options]
 * @returns {{ isElectronShell: boolean, evidence: string }}
 */
export function detectElectronShell({
  env = process.env,
  ppid = process.ppid,
  platform = process.platform,
  readChain = readProcessChain,
} = {}) {
  const marker = String((env && typeof env === 'object' ? env.ELECTRON_RUN_AS_NODE : '') ?? '')
    .trim()
    .toLowerCase();
  if (marker !== '1' && marker !== 'true') return { isElectronShell: false, evidence: '' };
  let chain = [];
  try {
    chain = readChain(ppid, { platform });
  } catch {
    chain = [];
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    // The chain could not be read: this signal stays silent.
    return { isElectronShell: false, evidence: '' };
  }
  for (const ancestor of chain) {
    const image = normalizedExecutableName(ancestor && ancestor.imageName);
    if (image === '') continue;
    if (SHELL_IMAGE_NAMES.has(image)) break; // somebody else started this host
    if (DESKTOP_EXE_NAMES.has(image) || image === 'electron') {
      return {
        isElectronShell: true,
        evidence: 'ancestor ' + ancestor.pid + ': ' + ancestor.imageName,
      };
    }
  }
  return { isElectronShell: false, evidence: '' };
}

/**
 * Describe the runtime we are executing in.
 *
 * THE DESKTOP APP IS RECOGNISED BY THE FILE NAME OF THE EXECUTABLE.
 *
 * Verified: when the Host runs inside the desktop app, `process.execPath` is the
 * app launcher itself (`…\DeepSeek Harness\DeepSeek Harness.exe`, no CLI args
 * needed). Any other runtime is not a desktop app and has no app exe to launch.
 *
 * The whole PATH is never used: the desktop app ships its own node inside its
 * installation directory, and a hosted deployment that runs with that node
 * (`…\DeepSeek Harness\resources\runtime\…\node.exe`) is a hosted host, not the
 * desktop app. Judging it by the path sent every such host into the
 * "desktop app, nothing to do" branch — it never got a restart command.
 *
 * When the file name cannot answer the question, the harder evidence is used:
 * the desktop host is the child of the Electron main process (it runs the
 * Electron binary as node, so it carries `ELECTRON_RUN_AS_NODE=1` and its
 * parent is the Electron shell). A process tree that cannot be read never
 * denies the desktop verdict — it only stays silent.
 *
 * @param {{
 *   env?: object,
 *   execPath?: string,
 *   pid?: number,
 *   ppid?: number,
 *   platform?: string,
 *   readChain?: Function,
 * }} [overrides]
 * @returns {{
 *   platform: string,
 *   pid: number,
 *   ppid: number,
 *   execPath: string,
 *   isDesktopApp: boolean,
 *   appExePath: string|null,
 *   hostPid: number,
 *   mainPid: number,
 *   killPid: number,
 * }}
 */
export function detectEnvironment({
  env = process.env,
  execPath = process.execPath,
  pid = process.pid,
  ppid = process.ppid,
  platform = process.platform,
  readChain = readProcessChain,
} = {}) {
  const exe = typeof execPath === 'string' ? execPath : '';
  const nameIsDesktop = isDesktopExecutableName(exe);
  // The process tree is only consulted when the file name does not answer.
  const electron = nameIsDesktop
    ? { isElectronShell: false, evidence: '' }
    : detectElectronShell({ env, ppid, platform, readChain });
  const isDesktopApp = nameIsDesktop || electron.isElectronShell;
  return {
    platform,
    pid,
    ppid,
    execPath: exe,
    isDesktopApp,
    // The exe the plugin may launch again is the app launcher ITSELF. When
    // only the process tree says "desktop app", the binary is unknown — and
    // an unknown binary is never started again by the plugin.
    appExePath: nameIsDesktop ? exe : null,
    hostPid: pid,
    mainPid: ppid,
    killPid: ppid,
  };
}

/**
 * Build the one synchronous `cmd.exe` line that waits, kills the app tree and
 * relaunches it.
 *
 * Example (defaults):
 * `cmd.exe /c ping -n 5 127.0.0.1 >nul & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" "C:\...\DeepSeek Harness.exe"`
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 * }} [options]
 * @returns {string}
 */
/**
 * The command that relaunches the host WITHOUT letting it inherit the helper's
 * console.
 *
 * Launching the app with `start "" "<exe>"` attached it to the detached helper's
 * console, and Windows delivers `CTRL_CLOSE_EVENT` to every process attached to a
 * console when that console closes: closing the helper window (or the window going
 * away) therefore killed DSH itself. A hidden PowerShell `Start-Process` goes
 * through ShellExecute instead, so the relaunched host is a console-free process and
 * the helper window can close without touching it.
 *
 * THE FLASH (user report, 2026-11-09): `powershell.exe -WindowStyle Hidden` creates
 * its console FIRST and hides it afterwards, so background mode still flashed a
 * small window the moment the host was started again. With `shimPath` the step
 * becomes `wscript.exe //B "<shim>" launch` instead: `wscript.exe` is a GUI-subsystem
 * process (no console exists at all) and the shim starts the host through
 * Shell.Application.ShellExecute — the same ShellExecute, without the console. The
 * foreground mode passes no `shimPath` and keeps the historic line BYTE FOR BYTE.
 *
 * @param {string} exe
 * @param {{ shimPath?: string|null }} [options]
 * @returns {string}
 */
/**
 * The ShellExecute one-liner that starts the host again.
 *
 * MEASURED, 2026-11-09: `-WindowStyle Minimized` on the inner `Start-Process`
 * is IGNORED by the host. The command line really carries it (the `.cmd` proves
 * it), but DSH is an Electron app and decides for itself how its window shows
 * up — on the real machine it came up in front, not minimized. The launcher also
 * has no window flag of its own (`-V/--patch/--dump-config/--help` only; web
 * takes `--host/--port/--trusted-host`), so there is nothing to pass. The
 * option was therefore removed instead of shipped as a switch that does nothing.
 *
 * @param {string} exe
 * @param {{ shimPath?: string|null }} [options]
 * @returns {string}
 */
export function relaunchCommandLine(exe, { shimPath = null } = {}) {
  const shim = nonEmptyString(shimPath);
  if (shim !== null) return 'wscript.exe //B "' + shim + '" launch';
  const target = psSingle(typeof exe === 'string' ? exe : '');
  return "start \"\" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '"
    + target
    + "'";
}

/**
 * The PowerShell relaunch line WITHOUT the `start ""` prefix.
 *
 * Inside the shim there is no `cmd.exe`, so the `start` builtin does not exist;
 * `WScript.Shell.Run` hides the console itself. This is the fallback the shim
 * takes when `Shell.Application.ShellExecute` is refused — the same command the
 * foreground mode uses, minus the cmd builtin.
 *
 * @param {string} exe
 * @returns {string}
 */
export function relaunchFallbackLine(exe) {
  const target = psSingle(typeof exe === 'string' ? exe : '');
  return "powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '"
    + target
    + "'";
}

/**
 * Build the Windows one-liner the detached scheduler runs when no idle-gate script
 * is used: wait, kill, relaunch.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 *   cookieClearCommand?: string,
 * }} [options]
 * @returns {string}
 */
export function buildRestartCommand({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  taskkillImageName = DEFAULT_IMAGE_NAME,
  cookieClearCommand = '',
  relaunchShimPath = null,
} = {}) {
  const seconds =
    typeof relaunchDelaySeconds === 'number' && Number.isFinite(relaunchDelaySeconds) && relaunchDelaySeconds >= 0
      ? Math.trunc(relaunchDelaySeconds)
      : DEFAULT_RELAUNCH_DELAY_SECONDS;
  const image = nonEmptyString(taskkillImageName) ?? DEFAULT_IMAGE_NAME;
  const exe = typeof appExePath === 'string' ? appExePath : '';
  const clear = nonEmptyString(cookieClearCommand);
  // `ping -n N` where N = seconds + 1: one packet is sent immediately, so a
  // 4-second delay needs 5 pings. `>nul` keeps the detached console silent.
  const steps = [
    `cmd.exe /c ping -n ${seconds + 1} 127.0.0.1 >nul`,
    `taskkill /IM "${image}" /T /F`,
  ];
  // The cleanup runs AFTER the kill and BEFORE the relaunch: only then has
  // Chromium left, and only then is the cookie jar unlocked.
  if (clear !== null) steps.push(clear);
  steps.push(relaunchCommandLine(exe, { shimPath: relaunchShimPath }));
  return steps.join(' & ');
}

/**
 * The PowerShell command that creates a process via WMI. Processes created by
 * the WMI service provider are not ownered by the dying Electron job object, so
 * they survive the kill.
 *
 * @param {string} command
 * @returns {{ file: string, args: string[] }}
 */
export function buildWmiRestartCommand(command) {
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psSingle(command)}' } | Select-Object ReturnValue | ConvertTo-Json -Compress`,
    ],
  };
}

/**
 * Build the Windows `.cmd` helper the detached scheduler runs instead of the inline
 * one-liner whenever an idle-gate URL is available.
 *
 * The helper waits `relaunchDelaySeconds` (a `ping` delay, no external tools), then
 * re-checks the plugin's idle gate over loopback. If the gate denies the restart — or
 * the request fails — it aborts WITHOUT killing anything. Only an allowed gate
 * proceeds to `taskkill` and the relaunch.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   gateUrl?: string,
 *   taskkillImageName?: string,
 *   cookieClearCommand?: string,
 * }} [options]
 * @returns {string} `.cmd` script text (CRLF line endings, no BOM)
 */
export function buildGateScript({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  gateUrl = '',
  taskkillImageName = DEFAULT_IMAGE_NAME,
  watchScriptPath = null,
  cookieClearCommand = '',
  relaunchShimPath = null,
} = {}) {
  const seconds =
    typeof relaunchDelaySeconds === 'number' && Number.isFinite(relaunchDelaySeconds) && relaunchDelaySeconds >= 0
      ? Math.trunc(relaunchDelaySeconds)
      : DEFAULT_RELAUNCH_DELAY_SECONDS;
  const image = nonEmptyString(taskkillImageName) ?? DEFAULT_IMAGE_NAME;
  const exe = typeof appExePath === 'string' ? appExePath : '';
  const url = psSingle(nonEmptyString(gateUrl) ?? '');
  const gateArgument = "'" + url + "'";
  const gateLine = 'powershell.exe -NoProfile -NonInteractive -Command '
    + '"try { $r = Invoke-RestMethod -Uri '
    + gateArgument
    + ' -TimeoutSec 5; if ($r.allowRestart -ne $true) { exit 3 } } catch { exit 4 }"';
  const watch = nonEmptyString(watchScriptPath);
  const clear = nonEmptyString(cookieClearCommand);
  const lines = [
    '@echo off',
    'rem dsh-autorestart: wait, re-check the idle gate, then kill + relaunch DeepSeek Harness.',
    'ping -n ' + (seconds + 1) + ' 127.0.0.1 >nul',
    gateLine,
    'if errorlevel 1 exit /b 0',
    'taskkill /IM "' + image + '" /T /F',
    'ping -n 3 127.0.0.1 >nul',
  ];
  // The cleanup runs AFTER the kill and BEFORE the relaunch: only then has
  // Chromium left, and only then is the cookie jar unlocked.
  if (clear !== null) lines.push(clear);
  // THE FLASH (user report, 2026-11-09): `start "" powershell.exe -WindowStyle
  // Hidden` creates a console and hides it afterwards, so a small window flashed
  // when the host was started. With a shim path the step re-enters the shim in
  // `launch` mode instead: `wscript.exe` has no console at all and starts the host
  // through Shell.Application.ShellExecute.
  const shim = nonEmptyString(relaunchShimPath);
  lines.push(relaunchCommandLine(exe, { shimPath: shim }));
  if (watch !== null) {
    lines.push('rem dsh-autorestart: wait for the host to come back; roll the backup back when it does not.');
    // Launched as its own hidden process so the .cmd can end immediately: the
    // helper console must close as soon as the relaunch is issued (a visible
    // console window parked in front of the app is not acceptable), and the
    // watcher must survive that console closing.
    //
    // IT FLASHED TOO (same user report): it is the same
    // `start "" powershell.exe -WindowStyle Hidden` shape. In background mode the
    // shim starts it with `shell.Run …, 0, False`, which hides the console the
    // watcher's PowerShell would otherwise create.
    lines.push(shim !== null
      ? 'wscript.exe //B "' + shim + '" watch'
      : 'start "" powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + watch + '"');
  }
  lines.push('');
  return lines.join('\r\n');
}

/** How long the watcher waits for the relaunched host before it rolls back. */
export const DEFAULT_ROLLBACK_TIMEOUT_MS = 90000;

/**
 * How long ONE restore step (the configuration files, the plugin tree) may take
 * before the watcher gives it up.
 *
 * A `robocopy` of a 117 MB plugin tree can take a while, but it must never
 * hang the watcher for ever: a restore that does not finish in time is
 * abandoned and the reason is written into the rollback report.
 */
export const DEFAULT_ROLLBACK_COPY_TIMEOUT_MS = 120000;

/**
 * Build the PowerShell watcher the `.cmd` helper runs right after the relaunch.
 *
 * WHAT IT DOES NOW (and what it did wrong before):
 *
 *   - It does NOT poll the health route of the OLD instance any more. The
 *     desktop app listens on a RANDOM port (`--port 0`), so the port of the
 *     instance that is being replaced is worthless: the watcher waited for an
 *     answer that could never come, and then rolled back a perfectly healthy
 *     restart. The port of the NEW instance is read from the instance record
 *     (lib/access.js), which also carries the boot id — so the watcher knows
 *     that the answer comes from the instance that replaced the old one.
 *   - The restore runs with a TIME LIMIT. A `robocopy` that hangs is stopped,
 *     and the report says so.
 *   - The restore does NOT start a second copy of the host. The old behaviour
 *     (`Start-Process -FilePath $exe`) launched a SECOND app next to the one
 *     that was already starting up — two web servers, two ports, and a
 *     confusing window. The watcher only restores the files and writes the
 *     report; the host that was launched is left alone.
 *   - The watcher cleans up after itself: the helper script and the marker
 *     file are removed when it ends.
 *
 * The report is written WITHOUT a BOM even on PowerShell 5.1, because the
 * plugin parses it with JSON.parse.
 *
 * @param {{
 *   healthUrl?: string,
 *   healthPath?: string,
 *   portFile?: string,
 *   expectedBootId?: string|null,
 *   outcomeFile?: string,
 *   backupDir?: string,
 *   profileDir?: string,
 *   reportPath?: string,
 *   lockFile?: string,
 *   appExePath?: string|null,
 *   timeoutMs?: number,
 *   rollbackTimeoutMs?: number,
 *   since?: string|number|null,
 *   selfCleanPaths?: string[],
 * }} [options]
 * @returns {string} script text (CRLF line endings)
 */
export function buildWatchScript({
  healthUrl = '',
  healthPath = '/__dsh_autorestart/health',
  portFile = '',
  expectedBootId = null,
  outcomeFile = '',
  backupDir = '',
  profileDir = '',
  reportPath = '',
  lockFile = '',
  appExePath = null,
  timeoutMs = DEFAULT_ROLLBACK_TIMEOUT_MS,
  rollbackTimeoutMs = DEFAULT_ROLLBACK_COPY_TIMEOUT_MS,
  since = null,
  selfCleanPaths = [],
  windowMode = '',
  launcher = '',
  launchFallback = '',
  shimPath = '',
} = {}) {
  const timeout =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1000
      ? Math.trunc(timeoutMs)
      : DEFAULT_ROLLBACK_TIMEOUT_MS;
  const copyTimeout =
    typeof rollbackTimeoutMs === 'number' && Number.isFinite(rollbackTimeoutMs) && rollbackTimeoutMs >= 1000
      ? Math.trunc(rollbackTimeoutMs)
      : DEFAULT_ROLLBACK_COPY_TIMEOUT_MS;
  // `Wait-Job -Timeout` counts SECONDS.
  const copyTimeoutSeconds = Math.max(1, Math.ceil(copyTimeout / 1000));
  // Only a crash log written AFTER the restart is evidence about it: an older one
  // would blame last week's failure for this one.
  const sinceText = typeof since === 'string' && since.trim() !== ''
    ? since.trim()
    : (Number.isFinite(Number(since)) ? new Date(Number(since)).toISOString() : '');
  const quote = (value) => "'" + psSingle(typeof value === 'string' ? value : '') + "'";
  const expected = typeof expectedBootId === 'string' && expectedBootId !== '' ? expectedBootId : '';
  const cleanPaths = (Array.isArray(selfCleanPaths) ? selfCleanPaths : [])
    .filter((entry) => typeof entry === 'string' && entry !== '')
    .map((entry) => quote(entry));
  // THE FAILURE REPORT MUST NAME THE LAUNCHER (background mode only): the user
  // saw no window at all, so "which one really started" is the first question
  // afterwards. Foreground mode keeps the report byte for byte as it was.
  const launchFields = windowMode === RESTART_WINDOW_BACKGROUND
    ? '; window = $launchWindow; launcher = $launchLauncher; launchFallback = $launchFallback; shim = $launchShim'
    : '';
  const lines = [
    '# dsh-autorestart: wait for the relaunched host; roll the pre-restart backup back when it never answers.',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$health = ' + quote(nonEmptyString(healthUrl) ?? ''),
    '$healthPath = ' + quote(nonEmptyString(healthPath) ?? '/__dsh_autorestart/health'),
    '$portFile = ' + quote(nonEmptyString(portFile) ?? ''),
    '$expected = ' + quote(expected),
    '$outcome = ' + quote(nonEmptyString(outcomeFile) ?? ''),
    '$backup = ' + quote(nonEmptyString(backupDir) ?? ''),
    '$profile = ' + quote(nonEmptyString(profileDir) ?? ''),
    '$report = ' + quote(nonEmptyString(reportPath) ?? ''),
    // WHICH LAUNCHER WAS USED (background mode only): a restart the user could
    // not see must still be explainable afterwards. Foreground keeps the script
    // byte for byte as it was, so these lines exist only in background mode.
    ...(windowMode === RESTART_WINDOW_BACKGROUND
      ? [
        '$launchWindow = ' + quote(windowMode),
        '$launchLauncher = ' + quote(launcher),
        '$launchFallback = ' + quote(launchFallback),
        '$launchShim = ' + quote(shimPath),
      ]
      : []),
    '$deadline = (Get-Date).AddMilliseconds(' + timeout + ')',
    '$healthy = $false',
    '$decided = $false',
    '$newPort = 0',
    'while ((Get-Date) -lt $deadline) {',
    '  # The plugin may have decided on its own (the restart command failed): stand down.',
    "  if ($outcome -ne '' -and (Test-Path -LiteralPath $outcome)) {",
    '    $marker = $null',
    '    try { $marker = Get-Content -LiteralPath $outcome -Raw | ConvertFrom-Json } catch { $marker = $null }',
    '    if ($marker -and $marker.decided -eq $true) { $decided = $true; break }',
    '  }',
    '  # The NEW instance publishes its own port; the port of the old one is worthless.',
    "  if ($portFile -ne '' -and (Test-Path -LiteralPath $portFile)) {",
    '    $record = $null',
    '    try { $record = Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json } catch { $record = $null }',
    '    if ($record -and $record.bootId -and $record.bootId -ne $expected -and $record.port) {',
    "      $url = 'http://127.0.0.1:' + $record.port + $healthPath",
    '      try { $h = Invoke-RestMethod -Uri $url -TimeoutSec 5; if ($h.ok -eq $true) { $healthy = $true; $newPort = $record.port; break } } catch { }',
    '    }',
    '  } elseif ($health -ne \'\') {',
    '    # No instance record at all (a Host that does not publish one): the old URL.',
    '    try { $h = Invoke-RestMethod -Uri $health -TimeoutSec 5; if ($h.ok -eq $true) { $healthy = $true; break } } catch { }',
    '  }',
    '  Start-Sleep -Seconds 2',
    '}',
    'if ($decided -or $healthy) { exit 0 }',
    '$crashDir = Join-Path $env:APPDATA \'@deepseek-ai\\dsh-desktop\\logs\'',
    '$since = ' + quote(sinceText),
    '$crash = $null',
    'if ($since -ne \'\') { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Where-Object { $_.LastWriteTime -gt ([datetime]$since) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    'if (-not $crash) { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    "$tail = ''",
    'if ($crash) { $tail = ((Get-Content $crash.FullName -Tail 60) -join [char]10) }',
    '# THE LOCK: the plugin may be restoring the snapshot at the same time (it',
    '# saw that the restart failed). Exactly ONE of them restores the files.',
    '$lock = ' + quote(nonEmptyString(lockFile) ?? ''),
    '$locked = $false',
    'if ($lock -ne \'\') {',
    '  # A lock that is older than 10 minutes belongs to a process that died',
    '  # in the middle of its restore: it must not block the rollback for ever.',
    '  if (Test-Path -LiteralPath $lock) {',
    '    $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime',
    '    if ($age.TotalMinutes -gt 10) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }',
    '  }',
    '  try { $handle = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $handle.Close(); $locked = $true } catch { $locked = $false }',
    '}',
    '$rolledBack = $false',
    '$rollbackError = $null',
    'if (-not $locked) {',
    '  $rollbackError = \'another rollback is already running\'',
    '} else {',
    '  $configBackup = Join-Path $backup \'config\'',
    '  if (Test-Path $configBackup) {',
    '    $job = Start-Job -ScriptBlock { param($src, $dst) & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null } -ArgumentList $configBackup, $profile',
    '    if (Wait-Job $job -Timeout ' + copyTimeoutSeconds + ') { Receive-Job $job | Out-Null; $rolledBack = $true } else { Stop-Job $job; $rollbackError = \'the configuration restore did not finish within ' + copyTimeout + ' ms\' }',
    '    Remove-Job $job -Force',
    '  }',
    '  $pluginsBackup = Join-Path $backup \'node_modules\'',
    '  if (Test-Path $pluginsBackup) {',
    '    $job = Start-Job -ScriptBlock { param($src, $dst) & robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null } -ArgumentList $pluginsBackup, (Join-Path $profile \'node_modules\')',
    '    if (Wait-Job $job -Timeout ' + copyTimeoutSeconds + ') { Receive-Job $job | Out-Null; $rolledBack = $true } else { Stop-Job $job; $rollbackError = \'the plugin tree restore did not finish within ' + copyTimeout + ' ms\' }',
    '    Remove-Job $job -Force',
    '  }',
    '}',
    '$crashName = $null',
    'if ($crash) { $crashName = $crash.Name }',
    '# `appStarted` is always false: the rollback branch restores the files and',
    '# writes the report, it never launches a SECOND copy of the host.',
    '$payload = [ordered]@{ ok = $false; at = (Get-Date).ToString(\'o\'); waitedMs = ' + timeout + '; rolledBack = $rolledBack; rollbackError = $rollbackError; backupDir = $backup; newPort = $newPort; appStarted = $false; crashLog = $crashName; crashTail = $tail' + launchFields + ' }',
    '$json = $payload | ConvertTo-Json -Depth 4',
    '[System.IO.File]::WriteAllText($report, $json, (New-Object System.Text.UTF8Encoding($false)))',
    '# The watcher cleans up after itself (and releases the lock it holds).',
    'foreach ($p in @(' + cleanPaths.join(', ') + ')) {',
    '  if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }',
    '}',
    '# The lock is released by the party that HOLDS it — the one that stood',
    '# down must not take it away from the one that is restoring.',
    'if ($locked -and $lock -ne \'\') { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }',
    'exit 1',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * The command line that runs the rollback watcher as its own hidden process.
 *
 * @param {string} scriptPath
 * @param {{ executable?: string }} [options]
 * @returns {string}
 */
export function buildWatcherCommandLine(scriptPath, { executable = 'powershell.exe' } = {}) {
  const file = nonEmptyString(scriptPath);
  if (file === null) return '';
  return executable
    + ' -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'
    + file
    + '"';
}

/**
 * Write a helper script atomically: a temporary file + a rename, so a
 * half-written script can never be executed.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{ ok: boolean, error: string|null }}
 */
export function writeTextFileAtomic(file, text) {
  const target = nonEmptyString(file);
  if (target === null) return { ok: false, error: 'writeTextFileAtomic requires a path' };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.tmp';
    writeFileSync(temporary, String(text), { encoding: 'utf8' });
    renameSync(temporary, target);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: 'could not write ' + target + ': ' + errorText(error) };
  }
}

/**
 * Is this pid still alive?
 *
 * Best effort, never throws: `process.kill(pid, 0)` sends no signal, it only
 * asks the operating system whether the process exists. `EPERM` means "it
 * exists, but it is not mine" — still alive.
 *
 * @param {number|null} pid
 * @param {{ kill?: Function }} [options]
 * @returns {boolean}
 */
export function isProcessAlive(pid, { kill = process.kill } = {}) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    kill(value, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Did the rollback watcher really survive its own start?
 *
 * The POSIX launch only proves that `spawn` returned a pid: the detached child
 * may still die a moment later (a missing `node`, a script that cannot be read).
 * Waiting a moment and asking again is the difference between "armed" and
 * "probably armed" — and the caller is told which one it got.
 *
 * @param {{
 *   pid?: number|null,
 *   waitMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   isAlive?: (pid: number) => boolean,
 * }} [options]
 * @returns {Promise<{ confirmed: boolean, alive: boolean, pid: number|null, reason: string }>}
 */
export async function confirmWatcherAlive({
  pid = null,
  waitMs = 250,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  isAlive = isProcessAlive,
} = {}) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) {
    return { confirmed: false, alive: false, pid: null, reason: 'no pid was reported, so nothing could be confirmed' };
  }
  const wait = Number.isFinite(Number(waitMs)) && Number(waitMs) > 0 ? Math.trunc(Number(waitMs)) : 0;
  if (wait > 0) {
    try {
      await sleep(wait);
    } catch { /* a clock that fails must not turn into "confirmed" */ }
  }
  const alive = (() => {
    try {
      return isAlive(value) === true;
    } catch {
      return false;
    }
  })();
  return {
    confirmed: alive,
    alive,
    pid: value,
    reason: alive
      ? `the watcher process ${value} is alive`
      : `the watcher process ${value} is gone right after its start`,
  };
}

/**
 * Start the rollback watcher as a process that survives the death of the host.
 *
 * The watcher is the only thing that can confirm the new instance when the
 * restart command kills the host itself — which is exactly what a hosted
 * restart does. It is therefore started OUTSIDE the process tree of the host:
 *
 *   - on Windows through WMI (the same mechanism the detached restart uses),
 *     with a one-shot scheduled task as the fallback;
 *   - everywhere else through a detached child (POSIX `setsid`), which is in
 *     its own session and therefore immune to a kill of the host's process
 *     group.
 *
 * WHAT `ok: true` MEANS (2026-11-02): the launch mechanism accepted the command.
 * It does NOT mean "somebody is definitely waiting" — on POSIX the child may
 * still die a moment later, so the caller must confirm the pid
 * ({@link confirmWatcherAlive}) before it reports "the rollback is armed".
 *
 * @param {{
 *   watchScriptPath?: string|null,
 *   watchCommand?: string|null,
 *   taskName?: string,
 *   timeoutMs?: number,
 *   dryRun?: boolean,
 *   platform?: string,
 *   spawnFn?: Function,
 *   execFileSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   method: 'wmi'|'schtasks'|'spawn'|'none',
 *   command: string,
 *   error: string|null,
 *   dryRun: boolean,
 *   pid: number|null,
 *   spawnError: string|null,
 * }}
 */
export function launchDetachedWatcher({
  watchScriptPath = null,
  watchCommand = null,
  taskName = DEFAULT_WATCH_TASK_NAME,
  timeoutMs = 20000,
  dryRun = false,
  platform = process.platform,
  spawnFn = spawn,
  execFileSyncFn = execFileSync,
} = {}) {
  const command = nonEmptyString(watchCommand) ?? buildWatcherCommandLine(watchScriptPath);
  const task = nonEmptyString(taskName) ?? DEFAULT_WATCH_TASK_NAME;
  const base = {
    ok: false,
    method: /** @type {'wmi'|'schtasks'|'spawn'|'none'} */ ('none'),
    command,
    error: null,
    dryRun: dryRun === true,
    // The pid is what the caller needs to confirm that somebody is really
    // waiting: `ok: true` alone only says "the launcher accepted it".
    pid: /** @type {number|null} */ (null),
    spawnError: /** @type {string|null} */ (null),
  };
  if (command === '') {
    return { ...base, error: 'launchDetachedWatcher requires a watcher command' };
  }
  if (dryRun === true) {
    return { ...base, ok: true, method: 'none' };
  }

  if (platform === 'win32') {
    const wmiCommand = buildWmiRestartCommand(command);
    const schtasksCreate = ['/Create', '/SC', 'ONCE', '/ST', '23:59', '/TN', task, '/TR', command, '/F'];
    const schtasksRun = ['/Run', '/TN', task];
    const execOptions = { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' };
    let lastError = null;
    try {
      const stdout = execFileSyncFn(wmiCommand.file, wmiCommand.args, {
        ...execOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const match = /"ReturnValue"\s*:\s*(\d+)/.exec(String(stdout ?? ''));
      if (match !== null && Number(match[1]) !== 0) {
        throw new Error(`WMI Win32_Process.Create returned ReturnValue=${match[1]}`);
      }
      return { ...base, ok: true, method: 'wmi' };
    } catch (error) {
      lastError = errorText(error);
    }
    try {
      execFileSyncFn('schtasks', schtasksCreate, execOptions);
      execFileSyncFn('schtasks', schtasksRun, execOptions);
      return { ...base, ok: true, method: 'schtasks', error: lastError };
    } catch (error) {
      lastError = `${lastError ? `${lastError}; ` : ''}${errorText(error)}`;
    }
    // The last resort: a detached child. On Windows it shares the job object
    // of the host, so it may die with it — but a watcher that dies with the
    // host is better than no watcher at all.
    try {
      const child = spawnFn(command, { shell: true, detached: true, windowsHide: true, stdio: 'ignore' });
      if (typeof child.on === 'function') child.on('error', () => {});
      try {
        child.unref();
      } catch {
        /* nothing else to do */
      }
      if (typeof child.pid !== 'number') {
        return { ...base, method: 'spawn', error: lastError || 'the watcher could not be started' };
      }
      return { ...base, ok: true, method: 'spawn', error: lastError };
    } catch (error) {
      return { ...base, method: 'spawn', error: `${lastError ? `${lastError}; ` : ''}${errorText(error)}` };
    }
  }

  // POSIX: a detached child is its own session leader (setsid), so it survives
  // the death of the host — even when the host is killed as a process group.
  //
  // THE SPAWN ERROR IS NO LONGER SWALLOWED (2026-11-02): the old code attached
  // an empty `error` handler and returned `ok: true` as soon as a pid existed.
  // With `shell: true` a pid exists even when the real command cannot be
  // executed at all (a missing `node`, an unreadable script), so "the rollback
  // is armed" was reported for a watcher that never ran. The launch now returns
  // the pid and the caller CONFIRMS it (`confirmWatcherAlive`); the error
  // listener keeps the reason so a late failure is at least recorded.
  try {
    const child = spawnFn(command, { shell: true, detached: true, stdio: 'ignore' });
    const pid = child && typeof child.pid === 'number' ? child.pid : null;
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        base.spawnError = errorText(error);
      });
    }
    try {
      child.unref();
    } catch {
      /* nothing else to do */
    }
    if (pid === null) {
      return { ...base, method: 'spawn', error: 'the watcher could not be started' };
    }
    return { ...base, ok: true, method: 'spawn', pid };
  } catch (error) {
    return { ...base, method: 'spawn', error: errorText(error) };
  }
}

/**
 * Execute the detached restart. Primary method: WMI process creation. Fallback:
 * a one-shot scheduled task. Never throws.
 *
 * With `dryRun: true` nothing is executed (and no file is written): the planned
 * command and the exact WMI / schtasks invocations are returned for inspection.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 *   taskName?: string,
 *   timeoutMs?: number,
 *   dryRun?: boolean,
 *   gateUrl?: string|null,
 *   scriptPath?: string|null,
 *   cookieClearCommand?: string,
 *   restartWindow?: 'foreground'|'background',
 *   shimPath?: string|null,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   method: 'wmi'|'schtasks',
 *   command: string,
 *   error: string|null,
 *   dryRun: boolean,
 *   commands: Array<{ method: string, file: string, args: string[] }>,
 *   wmiCommand: { file: string, args: string[] },
 *   schtasksCreate: string[],
 *   schtasksRun: string[],
 *   gated: boolean,
 *   scriptPath: string|null,
 *   script: string|null,
 * }}
 */
export function scheduleDetachedRestart({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  taskkillImageName = DEFAULT_IMAGE_NAME,
  taskName = DEFAULT_TASK_NAME,
  timeoutMs = 20000,
  dryRun = false,
  gateUrl = null,
  scriptPath = null,
  watchScriptPath = null,
  watchScript = null,
  cookieClearCommand = '',
  restartWindow = RESTART_WINDOW_FOREGROUND,
  shimPath = null,
} = {}) {
  const task = nonEmptyString(taskName) ?? DEFAULT_TASK_NAME;
  const gate = nonEmptyString(gateUrl);
  const scriptFile = nonEmptyString(scriptPath);
  const watchFile = nonEmptyString(watchScriptPath);
  const watchText = typeof watchScript === 'string' ? watchScript : null;
  const clear = nonEmptyString(cookieClearCommand);
  const gated = gate !== null;
  // THE WINDOW MODE decides HOW the command is started and HOW the relaunch inside
  // it is issued — so it is resolved BEFORE the scripts are built (2026-11-09).
  const windowMode = normalizeRestartWindow(restartWindow);
  const shimFile = nonEmptyString(shimPath);
  const background = windowMode === RESTART_WINDOW_BACKGROUND;
  const relaunchShim = background ? shimFile : null;
  let script = null;
  let command;
  if (gated) {
    script = buildGateScript({
      appExePath,
      relaunchDelaySeconds,
      gateUrl: gate,
      taskkillImageName,
      watchScriptPath: watchFile,
      cookieClearCommand: clear,
      relaunchShimPath: relaunchShim,
    });
    command = scriptFile === null ? '' : 'cmd.exe /c "' + scriptFile + '"';
  } else {
    command = buildRestartCommand({
      appExePath,
      relaunchDelaySeconds,
      taskkillImageName,
      cookieClearCommand: clear,
      relaunchShimPath: relaunchShim,
    });
  }
  // `wscript` = the shim really was used (no window, no focus steal); WHICH
  // process the shim then starts is the separate `relaunch` answer below.
  let launcher = background ? 'wscript' : RESTART_WINDOW_FOREGROUND;
  let fallbackReason = null;
  // THE FALLBACK IS NAMED, not merely implemented: the shim tries
  // `Shell.Application.ShellExecute` first and drops back to this line only when
  // the call is refused, so the report says what the fallback WOULD be.
  const relaunchFallback = background ? 'powershell-hidden' : null;
  let shimScript = background && shimFile !== null
    ? buildWindowShimScript(command, { appExePath, watchScriptPath: watchFile })
    : null;
  let launchCommand = command;
  if (background) {
    if (shimFile === null) {
      // No place to write the shim: the hidden PowerShell wrapper is the honest
      // (and recorded) fallback instead of silently keeping the visible window.
      launcher = 'powershell-hidden';
      fallbackReason = 'no window shim path was given';
      launchCommand = buildHiddenPowerShellCommand(command);
    } else {
      launchCommand = 'wscript.exe //B "' + shimFile + '"';
    }
  }
  // WHAT HAPPENED TO A SHIM OF AN EARLIER RESTART. It removes itself, but a
  // deletion can fail (the file is held for a moment); such a leftover is
  // removed here so it cannot pile up, and the fact is reported.
  const cleanup = { removedOldShim: null, error: null };
  if (shimFile !== null) {
    try {
      if (existsSync(shimFile)) {
        unlinkSync(shimFile);
        cleanup.removedOldShim = shimFile;
      }
    } catch (error) {
      cleanup.error = 'could not remove a shim of an earlier restart: ' + errorText(error);
    }
  }

  /** The answer as it stands NOW: `launchCommand` may still change (fallback). */
  const resultBase = () => {
    const wmiPlan = buildWmiRestartCommand(launchCommand);
    const schtasksPlan = ['/Create', '/SC', 'ONCE', '/ST', '23:59', '/TN', task, '/TR', launchCommand, '/F'];
    return {
      ok: false,
      method: /** @type {'wmi'|'schtasks'} */ ('wmi'),
      command,
      error: null,
      dryRun: dryRun === true,
      commands: [
        { method: 'wmi', file: wmiPlan.file, args: wmiPlan.args },
        { method: 'schtasks-create', file: 'schtasks', args: schtasksPlan },
        { method: 'schtasks-run', file: 'schtasks', args: ['/Run', '/TN', task] },
      ],
      wmiCommand: wmiPlan,
      schtasksCreate: schtasksPlan,
      schtasksRun: ['/Run', '/TN', task],
      gated,
      scriptPath: scriptFile,
      script,
      watchScriptPath: watchFile,
      watchScript: watchText,
      // THE WINDOW: which mode was asked for, which launcher the plugin really
      // used (they differ after a fallback), the command line handed to the
      // scheduler, the shim, and what happened to the leftovers.
      window: windowMode,
      launcher,
      // HOW the host is started again, and what that step falls back to. A reader
      // of the report must be able to tell "no console was created" from "the
      // flashy PowerShell path ran" without reading any code.
      relaunch: background && launcher !== 'powershell-hidden' ? 'shell-execute' : 'powershell-hidden',
      relaunchFallback,
      launchCommand,
      shimPath: shimFile,
      shimScript,
      fallbackReason,
      cleanup,
    };
  };

  if (!nonEmptyString(appExePath)) {
    return { ...resultBase(), error: 'scheduleDetachedRestart requires appExePath' };
  }

  if (gated && scriptFile === null) {
    return { ...resultBase(), error: 'scheduleDetachedRestart requires scriptPath when gateUrl is set' };
  }

  if (watchFile !== null && watchText === null) {
    return { ...resultBase(), error: 'scheduleDetachedRestart requires watchScript when watchScriptPath is set' };
  }

  if (dryRun === true) {
    return { ...resultBase(), ok: true, dryRun: true };
  }

  if (watchFile !== null && watchText !== null) {
    // The watcher must exist before the .cmd runs it: same atomic write as the
    // gate script, so a half-written .ps1 can never be executed.
    const written = writeTextFileAtomic(watchFile, watchText);
    if (!written.ok) {
      return { ...resultBase(), error: 'could not write the rollback watcher: ' + written.error };
    }
  }

  if (gated) {
    // The helper must exist before the scheduler runs it: write it atomically
    // (tmp file + rename) so a half-written .cmd can never be executed.
    const written = writeTextFileAtomic(scriptFile, script);
    if (!written.ok) {
      return { ...resultBase(), error: 'could not write the gate script: ' + written.error };
    }
  }

  // THE SHIM, written before the scheduler starts it (atomic, like the .cmd).
  if (background && shimFile !== null && shimScript !== null) {
    const written = writeTextFileAtomic(shimFile, shimScript);
    if (!written.ok) {
      launcher = 'powershell-hidden';
      fallbackReason = 'the window shim could not be written: ' + written.error;
      launchCommand = buildHiddenPowerShellCommand(command);
      shimScript = null;
    }
  }

  const execOptions = { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' };
  let lastError = null;

  /** Start `cmd` the way the foreground mode always did: WMI first, then schtasks. */
  const launch = (cmd) => {
    const wmiPlan = buildWmiRestartCommand(cmd);
    const schtasksPlan = ['/Create', '/SC', 'ONCE', '/ST', '23:59', '/TN', task, '/TR', cmd, '/F'];
    // 1) Preferred: WMI-created process, outside the Electron job object.
    try {
      const stdout = execFileSync(wmiPlan.file, wmiPlan.args, {
        ...execOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const match = /"ReturnValue"\s*:\s*(\d+)/.exec(String(stdout ?? ''));
      if (match === null) {
        // The command exited successfully but the ReturnValue was not observable:
        // treat it as success (a schtasks fallback here could schedule a second
        // kill) while surfacing the uncertainty to the caller's log.
        return {
          ok: true,
          method: 'wmi',
          error: 'WMI returned no observable ReturnValue; assuming the detached process was created',
        };
      }
      if (Number(match[1]) !== 0) {
        throw new Error(`WMI Win32_Process.Create returned ReturnValue=${match[1]}`);
      }
      return { ok: true, method: 'wmi', error: null };
    } catch (error) {
      lastError = errorText(error);
    }
    // 2) Fallback: one-shot scheduled task.
    try {
      execFileSync('schtasks', schtasksPlan, execOptions);
      execFileSync('schtasks', ['/Run', '/TN', task], execOptions);
      return { ok: true, method: 'schtasks', error: lastError };
    } catch (error) {
      return {
        ok: false,
        method: 'schtasks',
        error: `${lastError ? `${lastError}; ` : ''}${errorText(error)}`,
      };
    }
  };

  let outcome = launch(launchCommand);
  if (outcome.ok !== true && background && launcher === 'wscript') {
    // THE FALLBACK IS RECORDED, NEVER SILENT: Windows Script Host is a policy
    // target on managed machines, and a refused shim must not cost the user the
    // restart. The hidden PowerShell wrapper still starts the SAME command line;
    // `launcher` and `fallbackReason` say which one really ran.
    launcher = 'powershell-hidden';
    fallbackReason = 'the window shim could not be started: ' + String(outcome.error || 'unknown');
    launchCommand = buildHiddenPowerShellCommand(command);
    lastError = outcome.error;
    outcome = launch(launchCommand);
  }
  return { ...resultBase(), ...outcome };
}

/**
 * Run a command string detached, or (with `dryRun`) just report it. Tests use
 * `dryRun` exclusively so they never kill or relaunch anything.
 *
 * THE SUCCESS OF THE RESTART IS NOT "THE COMMAND STARTED".
 *
 * The old implementation spawned the command with `stdio: 'ignore'`, threw
 * the `error` event away and answered `ok: true` as soon as the spawn
 * succeeded. A command that does not exist (`command not found`), a command
 * that exits with a non-zero code and a command that dies immediately were
 * all reported as a successful restart. The host was then "restarted" into
 * nothing, and nobody was told.
 *
 * This implementation answers with what actually happened:
 *
 *   - `exitCode` — the code the command ended with;
 *   - `timedOut` — the command was still running when the window closed
 *     (a command that starts the host in the foreground never returns, so this
 *     is NOT a failure — but it is not a success either);
 *   - `error` — the reason a failure happened (the command could not be
 *     started at all, or it exited with a non-zero code);
 *   - `output` — what the command printed (the tail of it), so the reason of a
 *     failure is readable in the log.
 *
 * @param {{
 *   command?: string,
 *   dryRun?: boolean,
 *   timeoutMs?: number,
 *   spawnFn?: Function,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   command: string|null,
 *   dryRun: boolean,
 *   pid: number|null,
 *   exitCode: number|null,
 *   signal: string|null,
 *   timedOut: boolean,
 *   error: string|null,
 *   output: string,
 * }>}
 */
export function runCommandNow({
  command,
  dryRun = false,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) {
    return Promise.resolve({
      ok: false,
      command: null,
      dryRun: dryRun === true,
      pid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: 'runCommandNow requires a command',
      output: '',
    });
  }
  if (dryRun === true) {
    return Promise.resolve({
      ok: true,
      command: text,
      dryRun: true,
      pid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: null,
      output: '',
    });
  }
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_COMMAND_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          clearTimeout(timer);
        } catch {
          /* nothing else to do */
        }
        timer = null;
      }
      resolve({
        ok: false,
        command: text,
        dryRun: false,
        pid: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: 'the restart command did not run',
        output,
        ...result,
      });
    };

    let child;
    try {
      child = spawnFn(text, {
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ error: 'the restart command could not be started: ' + errorText(error) });
      return;
    }
    if (!child) {
      finish({ error: 'the restart command could not be started' });
      return;
    }

    const collect = (chunk) => {
      output = (output + String(chunk ?? '')).slice(-4096);
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', collect);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', collect);

    // A spawn that fails (the command does not exist) is reported — never
    // swallowed. This is the defect the old implementation hid.
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        finish({ error: 'the restart command could not be started: ' + errorText(error) });
      });
      child.on('exit', (code, signal) => {
        const exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
        if (exitCode === 0) {
          finish({ ok: true, pid: child.pid ?? null, exitCode: 0, signal: signal ?? null, error: null });
          return;
        }
        const tail = output.trim();
        finish({
          ok: false,
          pid: child.pid ?? null,
          exitCode,
          signal: signal ?? null,
          error: 'the restart command exited with code ' + String(exitCode)
            + (tail === '' ? '' : ': ' + tail),
        });
      });
    }

    // The window: the command is given this long to finish. A command that
    // outlives it is NOT killed (it may be the host itself, running in the
    // foreground) — it is reported as "still running", and the caller decides.
    timer = setTimeout(() => {
      finish({
        ok: true,
        pid: child.pid ?? null,
        exitCode: null,
        signal: null,
        timedOut: true,
        error: null,
      });
    }, budget);

    try {
      child.unref();
    } catch {
      /* nothing else to do */
    }
  });
}

/**
 * Expand a user-provided restart command template. Unknown/none values become
 * empty strings so the command is at least syntactically valid.
 *
 * @param {{ template?: string, pid?: number, ppid?: number, appExePath?: string|null }} [options]
 * @returns {string}
 */
export function buildCustomCommand({ template, pid, ppid, appExePath } = {}) {
  if (typeof template !== 'string') return '';
  return template
    .split('{pid}')
    .join(pid == null ? '' : String(pid))
    .split('{ppid}')
    .join(ppid == null ? '' : String(ppid))
    .split('{app}')
    .join(appExePath == null ? '' : String(appExePath));
}
