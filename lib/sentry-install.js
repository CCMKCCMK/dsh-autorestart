/**
 * dsh-autorestart - install / uninstall / inspect the SENTRY.
 *
 * The plugin side of the night watchman. Like `lib/supervisor-install.js` this
 * module GENERATES the commands and never runs one on its own: the running is
 * done here, but only through an injected executor, so a test can prove that
 * a dry run executes NOTHING (a test that registers a real scheduled task
 * would be a test that edits the machine it runs on).
 *
 * THE FOUR RULES:
 *
 *   1. **Nothing without the user's nod.** `confirmed: true` is required; a
 *      call without it only produces a PLAN and writes nothing at all.
 *   2. **The interpreter is a real node.** `resolveSupervisorNode` is reused -
 *      `process.execPath` is the Electron client of the desktop app, and a
 *      login record that names it as the interpreter would open a whole second
 *      client instead of running the script.
 *   3. **The record is read back.** "schtasks said it worked" is not "the task
 *      is there": the task is queried again, exactly like the supervisor
 *      install does it.
 *   4. **A failure leaves nothing behind.** A half-installed watchman that
 *      starts a stale process at the next login is worse than none, so a
 *      failure rolls back and WRITES DOWN what is left (with the commands that
 *      finish it by hand).
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  buildSentryConfig,
  isProcessAlive,
  readCleanExit,
  readConfig,
  readReport,
  readTextFile,
  sentryPaths,
  writeConfig,
  writeJsonFile,
  SENTRY_TASK_NAME,
  SENTRY_CONFIG_VERSION,
} from './sentry.js'
import { resolveSupervisorNode } from './supervisor.js'
import { runCommand, stepCommandLine } from './supervisor-install.js'

/** The error code of a platform the sentry cannot watch (it is Windows-only). */
export const UNSUPPORTED_PLATFORM = 'unsupported-platform'

/** The error code of a machine without a usable node interpreter. */
export const NODE_INTERPRETER_ERROR = 'node-interpreter-not-found'

/** The error code of a call that did not carry the user's confirmation. */
export const NOT_CONFIRMED = 'not-confirmed'

/** The error code of an installation without a state directory. */
export const STATE_DIR_REQUIRED = 'state-dir-required'

/** The error code of a task that could not be registered. */
export const TASK_CREATE_FAILED = 'task-create-failed'

/**
 * The files the kit is made of: `[target name in the kit, source inside the
 * package]`.
 *
 * IT MUST MATCH WHAT `supervisor/sentry.js` REALLY NEEDS. The daemon itself
 * imports nothing but `node:` builtins; the three files next to it are the
 * two scripts of the rescue kit (the cookie cleanup and the profile restore)
 * plus the Chinese wording the restore script reads at run time. A file that
 * is listed here but missing from the package fails the installation instead of
 * failing silently on the night it is needed.
 */
export const SENTRY_KIT_FILES = Object.freeze([
  Object.freeze({ target: 'sentry.js', source: ['supervisor', 'sentry.js'] }),
  Object.freeze({ target: 'clear-dsh-auth-cookies.mjs', source: ['scripts', 'clear-dsh-auth-cookies.mjs'] }),
  Object.freeze({ target: 'restore-profile.ps1', source: ['scripts', 'restore-profile.ps1'] }),
  Object.freeze({ target: 'rescue-strings.zh.json', source: ['scripts', 'rescue-strings.zh.json'] }),
])

/** The directory of this package (the modules live one level down). */
function packageDir() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.dirname(here)
}

/**
 * The absolute path of a file of this package.
 *
 * @param {string[]} relative
 * @returns {string}
 */
export function packagedPath(relative) {
  return path.join(packageDir(), ...(Array.isArray(relative) ? relative : [String(relative)]))
}

/**
 * The command line that starts the sentry.
 *
 * @param {{ nodePath?: string, scriptPath?: string, configPath?: string }} [options]
 * @returns {string}
 */
export function sentryCommandLine({ nodePath = '', scriptPath = '', configPath = '' } = {}) {
  const node = String(nodePath ?? '')
  const script = String(scriptPath ?? '')
  const config = String(configPath ?? '')
  if (node === '' || script === '') return ''
  return '"' + node + '" "' + script + '" --config "' + config + '"'
}

/**
 * The arguments of `schtasks /Create` for the sentry.
 *
 * `/SC ONLOGON` and `/RL LIMITED`: it must start when the user logs in (not
 * when the machine boots - a boot task would run as SYSTEM and read the wrong
 * home directory), and it must need no administrator.
 *
 * @param {{ nodePath?: string, scriptPath?: string, configPath?: string, taskName?: string }} [options]
 * @returns {string[]}
 */
export function sentryTaskCreateArgs({
  nodePath = '',
  scriptPath = '',
  configPath = '',
  taskName = SENTRY_TASK_NAME,
} = {}) {
  return [
    '/Create',
    '/TN', taskName,
    '/TR', sentryCommandLine({ nodePath, scriptPath, configPath }),
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
  ]
}

/**
 * The arguments of `schtasks /Query` (the read-back).
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function sentryTaskQueryArgs({ taskName = SENTRY_TASK_NAME } = {}) {
  return ['/Query', '/TN', taskName, '/FO', 'LIST']
}

/**
 * The arguments of `schtasks /Delete`.
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function sentryTaskDeleteArgs({ taskName = SENTRY_TASK_NAME } = {}) {
  return ['/Delete', '/TN', taskName, '/F']
}

/**
 * The content of the `.cmd` that the startup folder gets when the scheduled
 * task is refused.
 *
 * `start ""` detaches it from the console, so no window stays open in front of
 * the user. The text is pure ASCII with CRLF lines: cmd.exe reads it with the
 * console code page, and a Chinese character in it would turn into mojibake.
 *
 * @param {{ nodePath?: string, scriptPath?: string, configPath?: string }} [options]
 * @returns {string}
 */
export function sentryStartupCmdContent({ nodePath = '', scriptPath = '', configPath = '' } = {}) {
  const command = sentryCommandLine({ nodePath, scriptPath, configPath })
  return [
    '@echo off',
    'rem dsh-autorestart: start the sentry (the night watchman) at login.',
    'start "" ' + command,
    '',
  ].join('\r\n')
}

/**
 * The startup folder of this machine (empty when there is none).
 *
 * @param {{ env?: object, platform?: string }} [options]
 * @returns {string}
 */
export function defaultStartupDir({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return ''
  const appData = env && typeof env.APPDATA === 'string' ? env.APPDATA : ''
  if (appData === '') return ''
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/**
 * What an installation WOULD do. Nothing is written and nothing is run.
 *
 * @param {{
 *   platform?: string, nodePath?: string, execPath?: string, stateDir?: string,
 *   profileDir?: string, startupDir?: string, appImageName?: string,
 *   appExecPath?: string, env?: object, existsSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   kind: 'windows-schtasks'|'windows-startup'|'none', steps: object[],
 *   error: string|null, reason: string, notes: string[], nodePath: string,
 *   configPath: string, scriptPath: string, command: string, startupDir: string,
 *   commands: string[],
 * }}
 */
export function planSentryInstall(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const paths = sentryPaths(stateDir)
  const notes = []
  const base = {
    kind: 'none',
    steps: [],
    error: null,
    reason: '',
    notes,
    nodePath: '',
    configPath: paths.config,
    scriptPath: paths.runtime,
    command: '',
    startupDir: '',
    commands: [],
  }

  if (platform !== 'win32') {
    return {
      ...base,
      error: UNSUPPORTED_PLATFORM,
      reason: 'the sentry watches the Windows desktop client (tasklist + a login task); on ' + platform + ' it has nothing to watch',
    }
  }
  if (stateDir === '') {
    return { ...base, error: STATE_DIR_REQUIRED, reason: 'the sentry needs a state directory outside the profile' }
  }

  // The interpreter must be a REAL node: the executable of the desktop app is
  // the Electron client, and a login record that names it starts the whole
  // client instead of the script.
  const interpreter = resolveSupervisorNode({
    nodePath: options.nodePath,
    execPath: typeof options.execPath === 'string' && options.execPath !== '' ? options.execPath : process.execPath,
    platform,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
  })
  if (interpreter.ok !== true) {
    return { ...base, error: NODE_INTERPRETER_ERROR, reason: interpreter.reason }
  }
  const nodePath = interpreter.path
  const startupDir = typeof options.startupDir === 'string' && options.startupDir !== ''
    ? options.startupDir
    : defaultStartupDir({ env: options.env, platform })
  const command = sentryCommandLine({ nodePath, scriptPath: paths.runtime, configPath: paths.config })
  const startupPath = startupDir === '' ? '' : path.join(startupDir, SENTRY_TASK_NAME + '.cmd')

  const steps = [
    {
      kind: 'windows-schtasks',
      description: 'register the scheduled task that starts the sentry at login',
      file: 'schtasks',
      args: sentryTaskCreateArgs({ nodePath, scriptPath: paths.runtime, configPath: paths.config }),
      nodePath,
      command,
    },
    {
      kind: 'verify',
      description: 'read the scheduled task back',
      file: 'schtasks',
      args: sentryTaskQueryArgs(),
      nodePath,
      command,
    },
    {
      kind: 'windows-startup',
      description: 'put a .cmd into the startup folder (the fallback when tasks are not allowed)',
      path: startupPath,
      content: sentryStartupCmdContent({ nodePath, scriptPath: paths.runtime, configPath: paths.config }),
      nodePath,
      command,
    },
  ]

  notes.push('the sentry lives in ' + paths.dir + ', outside the profile, so the official profile cleanup cannot remove it')
  if (startupDir === '') notes.push('the startup folder was not found; only the scheduled task is possible')
  notes.push('the scheduled task is read back after it is created; a refused task falls back to the startup folder')

  return {
    ...base,
    kind: 'windows-schtasks',
    steps,
    error: null,
    reason: 'a scheduled task starts the sentry at login; the startup folder is the fallback when tasks are not allowed',
    nodePath,
    startupDir,
    commands: [stepCommandLine(steps[0])],
  }
}

/**
 * The commands that finish a cleanup by hand.
 *
 * @param {object[]} steps
 * @returns {string[]}
 */
export function manualCommands(steps) {
  if (Array.isArray(steps) !== true) return []
  return steps.map((step) => stepCommandLine(step)).filter((line) => line !== '')
}

/**
 * Write down an installation that had to be rolled back.
 *
 * The file lives NEXT TO the sentry directory (`<stateDir>/sentry-pending-cleanup.json`),
 * so writing it cannot bring that directory back to life.
 *
 * @param {string} stateDir
 * @param {{ reason?: string, failed?: object[], manual?: string[] }} [payload]
 * @returns {{ ok: boolean, path: string, pending: object|null, error: string|null }}
 */
export function writePendingCleanup(stateDir, payload = {}) {
  const paths = sentryPaths(typeof stateDir === 'string' ? stateDir : '')
  const pending = {
    createdAt: new Date().toISOString(),
    reason: typeof payload.reason === 'string' ? payload.reason : 'sentry-install-rollback-incomplete',
    failed: Array.isArray(payload.failed) ? payload.failed : [],
    manual: Array.isArray(payload.manual) ? payload.manual.map(String) : [],
    directory: paths.dir,
  }
  const written = writeJsonFile(paths.pendingCleanup, pending)
  return { ok: written.ok, path: written.path, pending, error: written.error }
}

/**
 * Copy the kit next to the daemon.
 *
 * @param {{
 *   paths: object, readSourceFn?: Function, writeFileFn?: Function, mkdirFn?: Function,
 * }} options
 * @returns {{ ok: boolean, copied: string[], error: string|null }}
 */
export function copyKit(options = {}) {
  const paths = options.paths && typeof options.paths === 'object' ? options.paths : sentryPaths('')
  const readSource = typeof options.readSourceFn === 'function'
    ? options.readSourceFn
    : (relative) => fs.readFileSync(packagedPath(relative))
  const writeFile = typeof options.writeFileFn === 'function'
    ? options.writeFileFn
    : (target, buffer) => fs.writeFileSync(target, buffer)
  const mkdir = typeof options.mkdirFn === 'function'
    ? options.mkdirFn
    : (target) => fs.mkdirSync(target, { recursive: true })
  const copied = []
  try {
    mkdir(paths.kit)
  } catch (error) {
    return { ok: false, copied, error: 'the kit directory could not be created: ' + String(error && error.message ? error.message : error) }
  }
  for (const entry of SENTRY_KIT_FILES) {
    let buffer = null
    try {
      buffer = readSource(entry.source)
    } catch (error) {
      return {
        ok: false,
        copied,
        error: 'the kit file ' + entry.target + ' is missing from the package: ' + String(error && error.message ? error.message : error),
      }
    }
    try {
      writeFile(path.join(paths.kit, entry.target), buffer)
      copied.push(entry.target)
    } catch (error) {
      return {
        ok: false,
        copied,
        error: 'the kit file ' + entry.target + ' could not be written: ' + String(error && error.message ? error.message : error),
      }
    }
  }
  return { ok: true, copied, error: null }
}

/**
 * Install the sentry.
 *
 * The order is fixed: the FILES first (the daemon, the configuration), then
 * the login record. When the record cannot be registered the files are taken
 * away again and what is left is written down.
 *
 * @param {{
 *   stateDir?: string, profileDir?: string, platform?: string, nodePath?: string,
 *   execPath?: string, appExecPath?: string, appImageName?: string,
 *   startupDir?: string, healthPath?: string, portFile?: string,
 *   intervalMs?: number, graceMs?: number, startTimeoutMs?: number,
 *   maxAttempts?: number, maxRescuesPerHour?: number, rescueWindowMs?: number,
 *   confirmed?: boolean, dryRun?: boolean, env?: object,
 *   execFileSyncFn?: Function, existsSyncFn?: Function, readSourceFn?: Function,
 *   writeFileFn?: Function, mkdirFn?: Function, rmSyncFn?: Function,
 * }} [options]
 * @returns {object}
 */
export function installSentry(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const paths = sentryPaths(stateDir)
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const writeFile = typeof options.writeFileFn === 'function'
    ? options.writeFileFn
    : (target, buffer) => fs.writeFileSync(target, buffer)
  const mkdir = typeof options.mkdirFn === 'function'
    ? options.mkdirFn
    : (target) => fs.mkdirSync(target, { recursive: true })
  const rm = typeof options.rmSyncFn === 'function'
    ? options.rmSyncFn
    : (target) => fs.rmSync(target, { recursive: true, force: true })

  const plan = planSentryInstall({
    platform,
    nodePath: options.nodePath,
    execPath: options.execPath,
    stateDir,
    profileDir: options.profileDir,
    startupDir: options.startupDir,
    appImageName: options.appImageName,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
  })

  const base = {
    ok: false,
    kind: plan.kind,
    installed: false,
    degraded: false,
    steps: [],
    error: plan.error ?? null,
    reason: plan.reason,
    plan,
    config: null,
    notes: plan.notes,
    commands: plan.commands,
    pending: null,
  }

  if (plan.error) return base

  // THE USER'S NOD. Without it (or in a dry run) this call produces the plan
  // and nothing else: no directory, no file, no command.
  if (options.dryRun === true || options.confirmed !== true) {
    return {
      ...base,
      ok: options.dryRun === true,
      steps: plan.steps,
      error: options.dryRun === true ? null : NOT_CONFIRMED,
      reason: options.dryRun === true
        ? 'dry run: nothing was written and no command was run'
        : 'the installation needs the confirmation card (confirmed: true)',
    }
  }

  const rollback = (error, extra) => {
    const failed = []
    if (extra && extra.taskCreated === true) {
      const deleted = runCommand('schtasks', sentryTaskDeleteArgs(), { execFileSyncFn: exec })
      failed.push({ kind: 'rollback-schtasks', ok: deleted.ok, error: deleted.error })
    }
    for (const target of extra && Array.isArray(extra.startupFiles) ? extra.startupFiles : []) {
      try {
        rm(target)
        failed.push({ kind: 'rollback-startup', ok: true, error: null })
      } catch (rollbackError) {
        failed.push({ kind: 'rollback-startup', ok: false, error: String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError) })
      }
    }
    try {
      rm(paths.dir)
    } catch (cleanupError) {
      failed.push({ kind: 'rollback-directory', ok: false, error: String(cleanupError && cleanupError.message ? cleanupError.message : cleanupError) })
    }
    const leftover = failed.filter((step) => step.ok !== true)
    let pending = null
    if (leftover.length > 0) {
      const written = writePendingCleanup(stateDir, {
        reason: 'sentry-install-rollback-incomplete',
        failed: leftover,
        manual: [
          'schtasks ' + sentryTaskDeleteArgs().join(' '),
          'rmdir /s /q "' + paths.dir + '"',
        ],
      })
      pending = written.pending
    }
    return { ...base, ok: false, error, steps: failed, pending }
  }

  // (1) The kit AND the daemon itself. The login record names
  // `<stateDir>/sentry/sentry.js`, so the daemon must really be there - the
  // kit copy alone would leave a record pointing at a file that does not
  // exist, which only shows up on the night it is needed.
  const readSource = typeof options.readSourceFn === 'function'
    ? options.readSourceFn
    : (relative) => fs.readFileSync(packagedPath(relative))
  const kit = copyKit({ paths, readSourceFn: readSource, writeFileFn: writeFile, mkdirFn: mkdir })
  if (kit.ok !== true) return rollback('the kit could not be copied: ' + String(kit.error))
  try {
    mkdir(paths.dir)
    writeFile(paths.runtime, readSource(['supervisor', 'sentry.js']))
  } catch (error) {
    return rollback('the sentry script could not be copied: ' + String(error && error.message ? error.message : error))
  }

  // (2) The configuration.
  const config = buildSentryConfig({
    now: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    appExecPath: typeof options.appExecPath === 'string' ? options.appExecPath : '',
    appImageName: options.appImageName,
    profileDir: options.profileDir,
    stateDir,
    nodePath: plan.nodePath,
    portFile: options.portFile,
    intervalMs: options.intervalMs,
    graceMs: options.graceMs,
    startTimeoutMs: options.startTimeoutMs,
    maxAttempts: options.maxAttempts,
    maxRescuesPerHour: options.maxRescuesPerHour,
    rescueWindowMs: options.rescueWindowMs,
    healthPath: options.healthPath,
  })
  const written = writeConfig(paths.config, config)
  if (written.ok !== true) return rollback('the configuration could not be written: ' + String(written.error))

  // (3) The login record.
  const steps = []
  let kind = 'windows-schtasks'
  let degraded = false
  const startupFiles = []
  const create = runCommand('schtasks', sentryTaskCreateArgs({
    nodePath: plan.nodePath,
    scriptPath: paths.runtime,
    configPath: paths.config,
  }), { execFileSyncFn: exec })
  steps.push({
    kind: 'windows-schtasks',
    description: 'register the scheduled task of the sentry',
    ok: create.ok,
    error: create.error,
  })
  if (create.ok === true) {
    // "It answered" is not "it is there".
    const query = runCommand('schtasks', sentryTaskQueryArgs(), { execFileSyncFn: exec })
    steps.push({ kind: 'verify', description: 'read the scheduled task back', ok: query.ok, error: query.error })
    if (query.ok !== true) {
      return rollback('the scheduled task was created but cannot be queried: ' + String(query.error), { taskCreated: true })
    }
  } else {
    // The degradation: the startup folder needs no rights at all.
    if (plan.startupDir === '') {
      return rollback(
        TASK_CREATE_FAILED + ': the task was refused (' + String(create.error) + ') and there is no startup folder on this machine',
        { taskCreated: false },
      )
    }
    degraded = true
    kind = 'windows-startup'
    const content = sentryStartupCmdContent({
      nodePath: plan.nodePath,
      scriptPath: paths.runtime,
      configPath: paths.config,
    })
    const targets = [paths.startupCmd, path.join(plan.startupDir, SENTRY_TASK_NAME + '.cmd')]
    for (const target of targets) {
      try {
        mkdir(path.dirname(target))
        writeFile(target, content)
        startupFiles.push(target)
        steps.push({ kind: 'windows-startup', description: 'write ' + target, ok: true, error: null })
      } catch (error) {
        return rollback(
          TASK_CREATE_FAILED + ': the task was refused (' + String(create.error) + ') and the startup file ' + target + ' could not be written',
          { taskCreated: false, startupFiles },
        )
      }
    }
    if (exists(path.join(plan.startupDir, SENTRY_TASK_NAME + '.cmd')) !== true) {
      return rollback(
        TASK_CREATE_FAILED + ': the startup file was written but is not there',
        { taskCreated: false, startupFiles },
      )
    }
  }

  // (4) The configuration says how it is registered, so the status can tell.
  config.kind = kind
  config.version = SENTRY_CONFIG_VERSION
  writeConfig(paths.config, config)

  return {
    ...base,
    ok: true,
    kind,
    degraded,
    installed: true,
    steps,
    error: null,
    config,
    reason: degraded
      ? 'the scheduled task was not allowed; the startup folder is used instead'
      : plan.reason,
  }
}

/**
 * Uninstall the sentry. Idempotent: an installation that is not there is not
 * an error.
 *
 * @param {{
 *   stateDir?: string, platform?: string, startupDir?: string, dryRun?: boolean,
 *   execFileSyncFn?: Function, existsSyncFn?: Function, rmSyncFn?: Function,
 *   killFn?: Function, isAliveFn?: Function,
 * }} [options]
 * @returns {{ ok: boolean, steps: object[], error: string|null, pending: object|null, reason: string }}
 */
export function uninstallSentry(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const paths = sentryPaths(stateDir)
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const rm = typeof options.rmSyncFn === 'function'
    ? options.rmSyncFn
    : (target) => fs.rmSync(target, { recursive: true, force: true })
  const kill = typeof options.killFn === 'function'
    ? options.killFn
    : (pid) => process.kill(pid)
  const alive = typeof options.isAliveFn === 'function' ? options.isAliveFn : isProcessAlive
  const startupDir = typeof options.startupDir === 'string' && options.startupDir !== ''
    ? options.startupDir
    : defaultStartupDir({ env: options.env, platform })

  const steps = []
  const base = { ok: false, steps, error: null, pending: null, reason: '' }
  if (stateDir === '') return { ...base, error: 'uninstallSentry requires stateDir' }

  const locks = readTextFile(paths.lock).text
  let pid = 0
  try {
    const parsed = JSON.parse(locks)
    pid = parsed && Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : 0
  } catch {
    pid = 0
  }
  const startupPaths = [paths.startupCmd]
  if (startupDir !== '') startupPaths.push(path.join(startupDir, SENTRY_TASK_NAME + '.cmd'))

  const planSteps = [
    { kind: 'stop', description: 'stop the sentry process' + (pid > 0 ? ' (pid ' + pid + ')' : '') },
    { kind: 'windows-schtasks', description: 'delete the scheduled task', file: 'schtasks', args: sentryTaskDeleteArgs() },
    ...startupPaths.map((target) => ({ kind: 'windows-startup', description: 'remove ' + target, path: target })),
    { kind: 'cleanup', description: 'remove the sentry directory ' + paths.dir, path: paths.dir },
  ]

  if (options.dryRun === true) {
    return { ...base, ok: true, steps: planSteps, reason: 'dry run: nothing was changed' }
  }

  if (pid > 0 && alive(pid) === true) {
    try {
      kill(pid)
      steps.push({ kind: 'stop', description: 'stop the sentry process', ok: true, error: null })
    } catch (error) {
      steps.push({
        kind: 'stop',
        description: 'stop the sentry process',
        ok: false,
        error: String(error && error.message ? error.message : error),
      })
    }
  } else {
    steps.push({ kind: 'stop', description: 'no sentry process is running', ok: true, error: null })
  }

  if (platform === 'win32') {
    const deleted = runCommand('schtasks', sentryTaskDeleteArgs(), { execFileSyncFn: exec })
    // A task that is not there cannot be deleted: that is a success, not an
    // error (an uninstall must be idempotent).
    steps.push({
      kind: 'windows-schtasks',
      description: 'delete the scheduled task',
      ok: deleted.ok || /cannot find|not found|does not exist|no such/i.test(String(deleted.error)),
      error: deleted.ok ? null : deleted.error,
    })
  }

  for (const target of startupPaths) {
    if (exists(target) !== true) {
      steps.push({ kind: 'windows-startup', description: 'there is no ' + target, ok: true, error: null })
      continue
    }
    try {
      rm(target)
      steps.push({ kind: 'windows-startup', description: 'remove ' + target, ok: exists(target) !== true, error: null })
    } catch (error) {
      steps.push({
        kind: 'windows-startup',
        description: 'remove ' + target,
        ok: false,
        error: String(error && error.message ? error.message : error),
      })
    }
  }

  try {
    rm(paths.dir)
  } catch {
    /* the check below reports it */
  }
  steps.push({
    kind: 'cleanup',
    description: 'remove the sentry directory',
    ok: exists(paths.dir) !== true,
    error: exists(paths.dir) === true ? 'the sentry directory is still there' : null,
  })

  const failed = steps.filter((step) => step.ok !== true)
  if (failed.length > 0) {
    const written = writePendingCleanup(stateDir, {
      reason: 'sentry-uninstall-incomplete',
      failed: failed.map((step) => ({ kind: step.kind, description: step.description, error: step.error })),
      manual: manualCommands(planSteps),
    })
    return {
      ...base,
      ok: false,
      steps,
      error: 'the uninstall did not finish; the pending cleanup was written to ' + written.path,
      pending: written.pending,
    }
  }

  // Nothing is left: a to-do list from an earlier attempt would be a lie.
  try {
    fs.rmSync(paths.pendingCleanup, { force: true })
  } catch {
    /* nothing else to do */
  }
  return { ...base, ok: true, steps, error: null, pending: null, reason: 'the sentry is gone' }
}

/**
 * What the plugin knows about the sentry. Never throws: a file that cannot be
 * read is reported as "not read".
 *
 * @param {{
 *   stateDir?: string, platform?: string, execFileSyncFn?: Function,
 *   existsSyncFn?: Function, now?: number,
 * }} [options]
 * @returns {{
 *   installed: boolean, running: boolean, taskPresent: boolean|null,
 *   config: object|null, lastRescue: object|null, lastLogLine: string,
 *   cleanExit: object|null, tasks: object[], reason: string,
 *   configPath: string, directory: string, lockPid: number|null,
 * }}
 */
export function sentryStatus(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const paths = sentryPaths(stateDir)
  const tasks = []

  const configRead = stateDir === ''
    ? { ok: false, config: null, error: 'no state directory' }
    : readConfig(paths.config)
  tasks.push({ kind: 'config', ok: configRead.ok === true, error: configRead.error })

  const runtimeThere = stateDir !== '' && exists(paths.runtime) === true
  tasks.push({ kind: 'runtime', ok: runtimeThere, error: runtimeThere ? null : 'the sentry script is not there' })
  const kitThere = stateDir !== '' && exists(paths.clearCookiesScript) === true && exists(paths.restoreScript) === true
  tasks.push({ kind: 'kit', ok: kitThere, error: kitThere ? null : 'the kit is incomplete' })

  let lockPid = null
  let running = false
  if (stateDir !== '') {
    try {
      const parsed = JSON.parse(readTextFile(paths.lock).text)
      lockPid = parsed && Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null
    } catch {
      lockPid = null
    }
    running = lockPid !== null && isProcessAlive(lockPid)
  }
  tasks.push({ kind: 'running', ok: running, error: running ? null : 'the sentry is not running' })

  let taskPresent = null
  if (platform === 'win32') {
    const query = runCommand('schtasks', sentryTaskQueryArgs(), { execFileSyncFn: exec })
    taskPresent = query.ok === true
    tasks.push({
      kind: 'task',
      ok: taskPresent,
      error: taskPresent ? null : String(query.error),
    })
  }

  const lastRescueRead = stateDir === '' ? { report: null } : readReport(paths.report)
  const cleanExitRead = stateDir === '' ? { cleanExit: null } : readCleanExit(paths.cleanExit)
  let lastLogLine = ''
  if (stateDir !== '') {
    const log = readTextFile(paths.log)
    if (log.ok === true) {
      const lines = log.text.split(/\r?\n/).filter((line) => line.trim() !== '')
      lastLogLine = lines.length > 0 ? lines[lines.length - 1] : ''
    }
  }

  const installed = configRead.ok === true && runtimeThere && kitThere
  const problems = tasks.filter((step) => step.ok !== true && step.kind !== 'running' && step.kind !== 'task')
  let reason = ''
  if (stateDir === '') reason = 'there is no state directory, so nothing can be said about the sentry'
  else if (installed !== true) reason = 'the sentry is not installed (' + problems.map((step) => step.kind + ': ' + String(step.error)).join('; ') + ')'
  else if (running !== true) reason = 'the sentry is installed but not running right now'
  else reason = 'the sentry is installed and running'
  if (platform !== 'win32') reason += '; the sentry only watches the Windows desktop client'

  return {
    installed,
    running,
    taskPresent,
    config: configRead.config,
    lastRescue: lastRescueRead.report,
    lastLogLine,
    cleanExit: cleanExitRead.cleanExit,
    tasks,
    reason,
    configPath: paths.config,
    directory: paths.dir,
    lockPid,
    checkedAt: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    homeDir: os.homedir(),
  }
}
