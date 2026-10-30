/**
 * REGISTERING THE WATCHDOG — one way per tier.
 *
 * The tiers differ in ONE thing only: how the watchdog is made to run later.
 * Everything after that (wait, re-check, restore, start again, report) is the
 * same code for every tier — see lib/watchdog.js.
 *
 * Each registration says what it did:
 *
 *   - the Windows task is read back after it was registered (and deleted
 *     completely afterwards);
 *   - the systemd unit is reset (`reset-failed`) when it is over, so it does
 *     not lie around as a failed unit;
 *   - the detached process writes its pid into the state directory, and the
 *     process is READ BACK to prove that it is really running.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isNodeExecutable, resolveNodeInterpreter } from './node-runtime.js';
import { defaultExec, TIERS } from './watchdog-tier.js';

/**
 * THE LAUNCHER OF THE WATCHDOG — why this section exists.
 *
 * A one-off Windows task used to be registered as
 *
 *     <Command>cmd</Command>
 *     <Arguments>/c "<host exe>" "<watchdog script>" --state-dir "<dir>"</Arguments>
 *
 * and that command line was broken twice over (both findings are from the
 * incident of 2026-10-30, see support/dsh-crash-20261030):
 *
 *   1. THE INTERPRETER WAS THE HOST. The command started `DeepSeek Harness.exe`
 *      with a script argument, and the environment of a scheduled task does
 *      NOT carry `ELECTRON_RUN_AS_NODE=1`, so it started a second copy of the
 *      CLIENT instead of running the script as node;
 *   2. THE EXTRA `cmd /c` ATE THE QUOTES. With six quotes on the line, cmd
 *      strips the outer pair and the first token ends at
 *      `...\Programs\DeepSeek` — the task exits with 9009 and the script never
 *      runs a line.
 *
 * The watchdog therefore never ran, while the report kept saying `armed`.
 *
 * The rule that follows is now mechanical, not a habit:
 *
 *   - the task runs a REAL node interpreter, RESOLVED (lib/node-runtime.js) —
 *     never `process.execPath`, which is the app executable in the desktop app;
 *   - the XML carries the interpreter path in `<Command>` and the script plus
 *     its arguments in `<Arguments>`: there is no shell in between, so there
 *     is nothing that could strip a quote;
 *   - when no node interpreter exists the registration is REFUSED with a
 *     reason. The app executable is never used as a stand-in for node.
 *
 * A command line that needs a shell (a redirection, a pipe) still goes through
 * `cmd /c`, and it says so (`form: 'shell'`): the drill scripts of this plugin
 * register such tasks on purpose.
 */

/** The tokens cmd.exe understands and node does not. */
const SHELL_TOKENS = Object.freeze(['>', '>>', '<', '|', '||', '&&', '&', '2>', '1>', '2>&1']);

/**
 * Split a command line into its arguments, respecting double quotes.
 *
 * It is deliberately small: the strings this module receives are built by this
 * plugin (an interpreter path, a script path, a state directory), not by a
 * user typing a shell line.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitCommandLine(text) {
  const source = String(text ?? '');
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of source) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Does this token only make sense to a shell?
 *
 * @param {string} token
 * @returns {boolean}
 */
function isShellToken(token) {
  return SHELL_TOKENS.includes(String(token ?? ''));
}

/**
 * Is this token the path of a script node can run?
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isNodeScriptPath(token) {
  return /\.(cjs|mjs|js)$/i.test(String(token ?? '').trim());
}

/**
 * The interpreter a watchdog task must run: ALWAYS a real node.
 *
 * This is the pure function the incident demanded: it takes the executable of
 * the running process (which is the desktop client in the desktop app) and
 * answers with a node interpreter, or with a REASON and a refusal. It never
 * answers with the application executable.
 *
 * @param {{
 *   execPath?: string,
 *   platform?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{ ok: boolean, path: string, source: string, reason: string, tried: string[] }}
 */
export function resolveWatchdogInterpreter(options = {}) {
  const answer = resolveNodeInterpreter(options);
  const found = typeof answer.path === 'string' ? answer.path : '';
  if (answer.ok !== true || found === '') {
    return {
      ok: false,
      path: '',
      source: '',
      reason: answer.reason || 'no node interpreter was found',
      tried: Array.isArray(answer.tried) ? answer.tried : [],
    };
  }
  if (!isNodeExecutable(found)) {
    // Belt and braces: the resolver is not allowed to answer with the client
    // executable, and this is the place that would notice if it ever did.
    return {
      ok: false,
      path: '',
      source: '',
      reason: 'the resolved interpreter is not node: ' + found
        + ' — the application executable is never used as a stand-in for node',
      tried: Array.isArray(answer.tried) ? answer.tried : [],
    };
  }
  return { ok: true, path: found, source: answer.source || '', reason: '', tried: answer.tried || [] };
}

/**
 * The plan of "how does this task start something".
 *
 * THREE forms are possible, and the caller gets told which one it got:
 *
 *   exec  — `<Command>` is the program, `<Arguments>` are its arguments. No
 *           shell is involved, so no quote can be stripped. The program is a
 *           resolved node interpreter unless it already IS node.
 *   shell — the command line needs cmd.exe (a redirection, a pipe): the old
 *           `cmd /c` form. It is used only when the command really asks for it.
 *
 * Returns `{ ok:false, reason }` when a node interpreter is needed and none
 * exists — the caller must then REFUSE the registration.
 *
 * @param {string|string[]|{file?: string, args?: string[]}} command
 * @param {{
 *   execPath?: string,
 *   platform?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   form: 'exec'|'shell',
 *   file: string,
 *   args: string[],
 *   commandLine: string,
 *   reason: string,
 *   tried: string[],
 * }}
 */
export function planTaskCommand(command, options = {}) {
  const refused = (reason, tried, form = 'exec', file = '', args = []) => ({
    ok: false,
    form,
    file,
    args,
    commandLine: '',
    reason,
    tried: Array.isArray(tried) ? tried : [],
  });

  // (a) The argv form: `{ file, args }` (and an array of tokens).
  let tokens = [];
  if (Array.isArray(command)) {
    tokens = command.map((entry) => String(entry));
  } else if (command && typeof command === 'object') {
    const file = typeof command.file === 'string' ? command.file : '';
    if (file === '') return refused('the command carries no program to run', []);
    const args = Array.isArray(command.args) ? command.args.map((entry) => String(entry)) : [];
    tokens = [file, ...args];
  } else if (typeof command === 'string') {
    tokens = splitCommandLine(command);
  }
  if (tokens.length === 0) return refused('there is no command to run', []);

  // (b) A command line that only a shell can run keeps the shell: the drill
  //     scripts of this plugin register `echo ... > file` tasks on purpose.
  if (typeof command === 'string' && tokens.some(isShellToken)) {
    return {
      ok: true,
      form: 'shell',
      file: 'cmd',
      args: ['/c', String(command)],
      commandLine: 'cmd /c ' + String(command),
      reason: 'the command line needs a shell (a redirection or a pipe)',
      tried: [],
    };
  }

  // (c) Already node? Then it runs as it is — but a BARE `node` is not an
  //     absolute path, and a scheduled task must not depend on the PATH it
  //     happens to see: it is resolved like every other interpreter.
  const first = tokens[0];
  if (isNodeExecutable(first)) {
    const args = tokens.slice(1);
    let file = first;
    if (!path.isAbsolute(first)) {
      const resolved = resolveWatchdogInterpreter(options);
      if (resolved.ok === true) file = resolved.path;
    }
    return {
      ok: true,
      form: 'exec',
      file,
      args,
      commandLine: quoteArgv([file, ...args]),
      reason: '',
      tried: [],
    };
  }

  // (d) Everything else has to become "node <script> <args>".
  //
  //     The first token is the program of the caller: it may be the client
  //     executable (`DeepSeek Harness.exe`), or the script itself, or nothing
  //     at all. Whatever it was, the payload is a node script plus arguments,
  //     and only a resolved node interpreter may run it.
  const payload = isNodeScriptPath(first) ? tokens : tokens.slice(1);
  const scriptIndex = payload.findIndex(isNodeScriptPath);
  if (scriptIndex === -1) {
    // A plain program invocation (`notepad.exe`, `echo something`): there is no
    // node script in it, so nothing has to be re-interpreted.
    return {
      ok: true,
      form: 'shell',
      file: 'cmd',
      args: ['/c', typeof command === 'string' ? String(command) : quoteArgv(tokens)],
      commandLine: 'cmd /c ' + (typeof command === 'string' ? String(command) : quoteArgv(tokens)),
      reason: 'the command line carries no node script: it is run as it is',
      tried: [],
    };
  }
  const interpreter = resolveWatchdogInterpreter(options);
  if (interpreter.ok !== true) {
    return refused(interpreter.reason, interpreter.tried);
  }
  return {
    ok: true,
    form: 'exec',
    file: interpreter.path,
    args: payload,
    commandLine: quoteArgv([interpreter.path, ...payload]),
    reason: '',
    tried: interpreter.tried,
  };
}

/**
 * Quote one argument the way Windows splits a command line again
 * (`CommandLineToArgvW` rules).
 *
 * @param {string} value
 * @returns {string}
 */
export function quoteArg(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  // Backslashes only matter in front of a quote, and at the very end.
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return '"' + escaped + '"';
}

/**
 * A whole command line out of tokens.
 *
 * @param {string[]} tokens
 * @returns {string}
 */
export function quoteArgv(tokens) {
  return (Array.isArray(tokens) ? tokens : []).map(quoteArg).join(' ');
}

/**
 * The `{ file, args }` of "run that node script with a resolved node".
 *
 * One call, so nobody has to remember the two things that broke the watchdog:
 * `process.execPath` is not node, and the script must not be handed to a shell.
 *
 * @param {{
 *   scriptPath: string,
 *   args?: string[],
 *   execPath?: string,
 *   platform?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 * }} options
 * @returns {{ ok: boolean, file: string, args: string[], reason: string, tried: string[] }}
 */
export function buildWatchdogTaskCommand({
  scriptPath = '',
  args = [],
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
  existsSyncFn = undefined,
} = {}) {
  const script = typeof scriptPath === 'string' ? scriptPath : '';
  if (script === '') {
    return { ok: false, file: '', args: [], reason: 'there is no script to run', tried: [] };
  }
  const interpreter = resolveWatchdogInterpreter({ execPath, platform, env, existsSyncFn });
  if (interpreter.ok !== true) {
    return { ok: false, file: '', args: [], reason: interpreter.reason, tried: interpreter.tried };
  }
  return {
    ok: true,
    file: interpreter.path,
    args: [script, ...(Array.isArray(args) ? args.map((entry) => String(entry)) : [])],
    reason: '',
    tried: interpreter.tried,
  };
}

/**
 * The XML of a one-off Windows task.
 *
 * Two things are easy to get wrong, and both are learned the hard way:
 *
 *   - a one-off task needs an `EndBoundary`: without it the task has no end
 *     and the registration is refused;
 *   - `MultipleInstancesPolicy` must be `IgnoreNew`: a second instance of the
 *     watchdog would fight the first one over the same lock.
 *
 * `<Command>` is the PROGRAM (an absolute interpreter path for the watchdog)
 * and `<Arguments>` are its arguments. Neither is wrapped in another shell:
 * cmd.exe is what ate the quotes that killed the watchdog on 2026-10-30.
 *
 * @param {{
 *   startIso: string,
 *   endIso: string,
 *   command: string|string[]|{file?: string, args?: string[]}|{form?: string, file: string, args?: string[]},
 *   description?: string,
 *   planOptions?: object,
 * }} options
 * @returns {string}
 */
export function buildScheduledTaskXml({ startIso, endIso, command, description = 'dsh-autorestart watchdog', planOptions = {} }) {
  const exec = execOfCommand(command, planOptions);
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>' + escape(description) + '</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <StartBoundary>' + escape(startIso) + '</StartBoundary>',
    '      <EndBoundary>' + escape(endIso) + '</EndBoundary>',
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + escape(exec.file) + '</Command>',
    '      <Arguments>' + escape(exec.arguments) + '</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * The `<Command>`/`<Arguments>` of a task, planned and quoted.
 *
 * @param {*} command
 * @param {object} planOptions
 * @returns {{ file: string, arguments: string }}
 */
function execOfCommand(command, planOptions = {}) {
  const isPlan = command !== null
    && typeof command === 'object'
    && !Array.isArray(command)
    && typeof command.file === 'string'
    && command.file !== '';
  const plan = isPlan
    ? {
      ok: true,
      file: command.file,
      args: Array.isArray(command.args) ? command.args.map((entry) => String(entry)) : [],
    }
    : planTaskCommand(command, planOptions);
  if (plan.ok !== true) {
    throw new Error('the task cannot be built: ' + (plan.reason || 'there is no command to run'));
  }
  return { file: plan.file, arguments: quoteArgv(plan.args) };
}

/**
 * Register the one-off Windows task and read it back.
 *
 * The command is PLANNED first (see `planTaskCommand`): when the task needs a
 * node interpreter and none exists, the registration is refused with the
 * reason and nothing is written to the machine. The application executable is
 * never used as a stand-in.
 *
 * @param {{
 *   taskName: string,
 *   startIso: string,
 *   endIso: string,
 *   command: string|string[]|{file?: string, args?: string[]},
 *   xmlPath: string,
 *   exec?: Function,
 *   writeFile?: Function,
 *   removeFile?: Function,
 *   planOptions?: object,
 * }} options
 * @returns {{ ok: boolean, taskName: string, error: string|null, steps: Array<object> }}
 */
export function registerScheduledTask({
  taskName,
  startIso,
  endIso,
  command,
  xmlPath,
  exec = defaultExec,
  writeFile = (target, content) => fs.writeFileSync(target, content, 'utf8'),
  removeFile = (target) => fs.rmSync(target, { force: true }),
  planOptions = {},
}) {
  const steps = [];
  const step = (kind, ok, detail) => {
    steps.push({ kind, ok, detail: detail === undefined ? null : detail });
    return ok;
  };
  // (0) WHAT RUNS THE TASK. Refused before anything is written when no real
  //     node interpreter can be found: a task that would start the client
  //     executable (or nothing at all) is not a watchdog.
  let xml = '';
  try {
    xml = buildScheduledTaskXml({ startIso, endIso, command, planOptions });
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    step('plan', false, reason);
    return { ok: false, taskName, error: reason, steps };
  }
  step('plan', true, 'the task runs a program directly (no shell in between)');
  try {
    writeFile(xmlPath, xml);
  } catch (error) {
    step('write-xml', false, error && error.message ? error.message : String(error));
    return { ok: false, taskName, error: 'the task description could not be written', steps };
  }
  step('write-xml', true, xmlPath);
  const created = exec('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
  if (!step('create', created.ok, created.ok ? 'the task was registered' : created.error)) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: created.error || 'the task was refused', steps };
  }
  // The read back: "it answered" is not "it is there".
  const query = exec('schtasks', ['/Query', '/TN', taskName, '/XML']);
  if (!step('verify', query.ok, query.ok ? 'the task was read back' : query.error)) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: query.error || 'the task cannot be read back', steps };
  }
  const start = /<StartBoundary>([^<]+)<\/StartBoundary>/i.exec(query.stdout || '');
  const end = /<EndBoundary>([^<]+)<\/EndBoundary>/i.exec(query.stdout || '');
  const triggerOk = start !== null && String(start[1]).slice(0, 16) === String(startIso).slice(0, 16);
  if (!step('trigger', triggerOk, 'expected ' + startIso + ', got ' + (start ? start[1] : 'nothing'))) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: 'the task was registered with another trigger', steps };
  }
  if (!step('end-boundary', end !== null, 'a one-off task needs an EndBoundary')) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: 'the task has no end boundary', steps };
  }
  const ignoreNew = /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/i.test(query.stdout || '');
  step('ignore-new', ignoreNew, 'a second instance must not fight the first one');
  removeFile(xmlPath);
  return { ok: true, taskName, error: null, steps };
}

/**
 * Delete the one-off Windows task completely.
 *
 * @param {{ taskName: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function removeScheduledTask({ taskName, exec = defaultExec }) {
  const answer = exec('schtasks', ['/Delete', '/TN', taskName, '/F']);
  return { ok: answer.ok === true, error: answer.ok ? null : (answer.error || 'the task could not be deleted') };
}

/**
 * The local time of a moment, in the format the task XML wants.
 *
 * A one-off task is triggered by a LOCAL time: an ISO time with a `Z` would
 * be read as UTC and the task would fire hours later (or never).
 *
 * @param {Date|number} when
 * @returns {string}
 */
export function localIso(when) {
  const date = when instanceof Date ? when : new Date(Number(when) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear()
    + '-' + pad(date.getMonth() + 1)
    + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours())
    + ':' + pad(date.getMinutes())
    + ':' + pad(date.getSeconds());
}

/**
 * Register a systemd user timer.
 *
 * @param {{ unitId: string, delaySeconds: number, command: string[], exec?: Function }} options
 * @returns {{ ok: boolean, unitId: string, error: string|null }}
 */
export function registerSystemdRun({ unitId, delaySeconds, command, exec = defaultExec }) {
  const seconds = Math.max(1, Math.trunc(Number(delaySeconds) || 1));
  const argv = Array.isArray(command) ? command.map((entry) => String(entry)) : [String(command ?? '')];
  const answer = exec('systemd-run', [
    '--user',
    '--on-active=' + seconds + 's',
    '--unit=' + unitId,
    '--',
    ...argv,
  ]);
  return { ok: answer.ok === true, unitId, error: answer.ok ? null : (answer.error || 'systemd-run refused') };
}

/**
 * Clean the systemd unit up (a failed unit would stay in the list).
 *
 * @param {{ unitId: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function cleanupSystemdUnit({ unitId, exec = defaultExec }) {
  const answer = exec('systemctl', ['--user', 'reset-failed', unitId]);
  return { ok: answer.ok === true, error: answer.ok ? null : (answer.error || null) };
}

/**
 * Start the watchdog as a background process of our own.
 *
 * The pid is written into the state directory (so the process can be cleaned
 * up later) and the process is READ BACK: a background job that died at once
 * is not a watchdog.
 *
 * @param {{
 *   delaySeconds: number,
 *   command: string,
 *   pidPath: string,
 *   exec?: Function,
 *   writeFile?: Function,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {{ ok: boolean, pid: number, pidPath: string, error: string|null }}
 */
export function registerDetachedProcess({
  delaySeconds,
  command,
  pidPath,
  exec = defaultExec,
  writeFile = (target, content) => fs.writeFileSync(target, content, 'utf8'),
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
}) {
  const seconds = Math.max(0, Math.trunc(Number(delaySeconds) || 0));
  // `setsid` detaches the process from this session: it survives the restart
  // that is about to happen.
  const shell = "setsid nohup sh -c 'sleep " + seconds + "; " + command + "' >/dev/null 2>&1 & echo $!";
  const answer = exec('sh', ['-c', shell]);
  if (!answer.ok) {
    return { ok: false, pid: 0, pidPath, error: answer.error || 'the background process could not be started' };
  }
  const pid = Number.parseInt(String(answer.stdout || '').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, pid: 0, pidPath, error: 'the background process did not report a pid' };
  }
  try {
    writeFile(pidPath, String(pid) + '\n', 'utf8');
  } catch {
    // The pid file is a convenience; the watchdog itself is running.
  }
  if (!isAlive(pid)) {
    return { ok: false, pid, pidPath, error: 'the background process is not running' };
  }
  return { ok: true, pid, pidPath, error: null };
}

/**
 * Stop the background process of our own (when it is still around).
 *
 * @param {{ pidPath: string, kill?: Function, readPid?: Function }} options
 * @returns {{ ok: boolean, pid: number, error: string|null }}
 */
export function removeDetachedProcess({
  pidPath,
  kill = (pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* it is gone */ } },
  readPid = () => {
    try {
      return Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    } catch {
      return 0;
    }
  },
}) {
  const pid = readPid();
  if (!Number.isFinite(pid) || pid <= 0) return { ok: true, pid: 0, error: null };
  kill(pid);
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    // The file is gone on the next run anyway.
  }
  return { ok: true, pid, error: null };
}

/**
 * Remove the scheduling item of a tier.
 *
 * @param {{ tier: string, taskName?: string, unitId?: string, pidPath?: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function removeScheduleItem({ tier, taskName = '', unitId = '', pidPath = '', exec = defaultExec }) {
  if (tier === TIERS.SCHEDULED_TASK) return removeScheduledTask({ taskName, exec });
  if (tier === TIERS.SYSTEMD_RUN) return cleanupSystemdUnit({ unitId, exec });
  if (tier === TIERS.DETACHED_PROCESS) return removeDetachedProcess({ pidPath });
  return { ok: true, error: null };
}

/**
 * Where the pid of the background process is written.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function detachedPidPath(stateDir) {
  return path.join(stateDir, 'watchdog.pid');
}
