/**
 * dsh-autorestart — the plugin side of the supervisor.
 *
 * The plugin does four things with the supervisor: INSTALL it, UNINSTALL it,
 * ASK about its state, and ASK it to restart the host. Everything else (the
 * daemon itself) lives in `supervisor/supervisor.js` and runs OUTSIDE the
 * host — the plugin cannot be the thing that brings the host back, because
 * the plugin dies with the host.
 *
 * THE THREE RULES OF THIS FILE:
 *
 *   1. **The installation is idempotent.** Installing twice leaves exactly ONE
 *      record (the task name / the unit name / the startup file name are
 *      fixed, and the scheduled task is created with `/F`). A second
 *      supervisor is impossible: the daemon takes an exclusive lock.
 *   2. **The installation is reversible.** The previous `restartMode` /
 *      `restartCommand` are saved before anything is changed, and the
 *      uninstall puts them back. When a step of the uninstall fails, the
 *      pending cleanup is WRITTEN DOWN (never silently dropped) so the user
 *      can finish it by hand.
 *   3. **Nothing is installed without the user's nod.** The caller (the
 *      confirmation card) has to pass `confirmed: true`; without it the
 *      installation only produces a PLAN (the dry run).
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { inspectExternalSupervisor } from './supervisor-config.js'
import { isNodeExecutable, resolveNodeInterpreter } from './node-runtime.js'
import { classifyStartup, STARTUP_MODES } from './startup-mode.js'
import { planAutostartAdvice } from './autostart-advice.js'

/** The name of the directory the supervisor lives in (inside the state dir). */
export const SUPERVISOR_DIR_NAME = 'supervisor'

/** The name of the file that says "the uninstall did not finish". */
export const UNINSTALL_PENDING_NAME = 'UNINSTALL-PENDING.json'

/** The version of the supervisor configuration this plugin writes. */
export const SUPERVISOR_CONFIG_VERSION = 1

/** The environment marker that says "a supervisor started me". */
export const SUPERVISED_ENV = 'DSH_AUTORESTART_SUPERVISED'

/** The environment marker that carries the supervisor's pid. */
export const SUPERVISOR_PID_ENV = 'DSH_AUTORESTART_SUPERVISOR_PID'

/**
 * The error code of a host that manages ITSELF (the desktop app).
 *
 * The desktop app brings itself back up (`restartMode: app`). A login record
 * that starts the supervisor would start a SECOND client at every login: the
 * record names the application executable, and the application executable
 * opens the whole client again. So the desktop host refuses the installation
 * — and it refuses it before a single step is generated.
 */
export const DESKTOP_SUPERVISOR_ERROR = 'desktop-manages-itself'

/** The reason that goes with {@link DESKTOP_SUPERVISOR_ERROR}. */
export const DESKTOP_SUPERVISOR_REASON =
  'the desktop app relaunches itself; a supervisor would start a second copy'

/** The error code of a host without a usable node interpreter. */
export const NODE_INTERPRETER_ERROR = 'node-interpreter-not-found'

/**
 * The error code of a host whose startup mode forbids a second supervisor.
 *
 * Only a `bare` host (nobody manages it) may get the supervisor of this
 * plugin: an external supervisor, a container or an unknown starter would end
 * up with two hosts fighting over the same port.
 */
export const STARTUP_NOT_INSTALLABLE = 'startup-not-installable'

/**
 * The error code of a WSL instance without systemd.
 *
 * There is no "at login" inside such a distribution: the plugin hands out
 * the two ways out (turn systemd on inside WSL, or let Windows start the
 * distribution) and installs nothing.
 */
export const WSL_NO_SYSTEMD = 'wsl-no-systemd'

/** The reason the desktop app reports for its own restart capability. */
export const DESKTOP_RESTART_REASON = 'the desktop app relaunches itself (restartMode: app)'

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/**
 * Every path the supervisor uses inside the state directory.
 *
 * @param {string} stateDir
 * @returns {{
 *   dir: string, script: string, config: string, lock: string, pid: string,
 *   control: string, log: string, rollbackRequest: string, pendingUninstall: string,
 * }}
 */
export function supervisorPaths(stateDir) {
  const dir = path.join(String(stateDir ?? ''), SUPERVISOR_DIR_NAME)
  return {
    dir,
    script: path.join(dir, 'supervisor.js'),
    config: path.join(dir, 'supervisor.json'),
    lock: path.join(dir, 'supervisor.lock'),
    pid: path.join(dir, 'supervisor.pid'),
    control: path.join(dir, 'control.json'),
    log: path.join(dir, 'supervisor.log'),
    rollbackRequest: path.join(dir, 'rollback-request.json'),
    // The to-do list of a cleanup that did not finish. It lives NEXT TO the
    // supervisor directory, not inside it: the cleanup removes that directory,
    // and a list inside it would either be deleted with it or bring the
    // directory back to life (which is what happened before).
    pendingUninstall: path.join(String(stateDir ?? ''), UNINSTALL_PENDING_NAME),
  }
}

/**
 * The path of the supervisor script inside THIS plugin package.
 *
 * @returns {string}
 */
export function packagedSupervisorPath() {
  return new URL('../supervisor/supervisor.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

/**
 * The configuration of the supervisor.
 *
 * @param {{
 *   execPath?: string, execArgv?: string[], argv?: string[], cwd?: string,
 *   env?: object, profileEnv?: object, port?: number, healthUrl?: string,
 *   profileDir?: string, stateDir?: string, ownerUser?: string,
 *   timings?: object, previous?: object, mode?: string, generation?: number,
 * }} [options]
 * @returns {object}
 */
export function buildSupervisorConfig(options = {}) {
  return {
    version: SUPERVISOR_CONFIG_VERSION,
    installedAt: new Date().toISOString(),
    ownerUser: typeof options.ownerUser === 'string' ? options.ownerUser : '',
    execPath: typeof options.execPath === 'string' ? options.execPath : '',
    execArgv: Array.isArray(options.execArgv) ? options.execArgv.map(String) : [],
    argv: Array.isArray(options.argv) ? options.argv.map(String) : [],
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    env: options.env && typeof options.env === 'object' ? options.env : {},
    profileEnv: options.profileEnv && typeof options.profileEnv === 'object' ? options.profileEnv : {},
    port: Number.isFinite(Number(options.port)) ? Number(options.port) : 0,
    healthUrl: typeof options.healthUrl === 'string' ? options.healthUrl : '',
    profileDir: typeof options.profileDir === 'string' ? options.profileDir : '',
    stateDir: typeof options.stateDir === 'string' ? options.stateDir : '',
    control: { type: 'tcp', host: '127.0.0.1', port: 0 },
    timings: {
      restartDelayMs: 1000,
      restartDelayMaxMs: 30000,
      startTimeoutMs: 90000,
      killGraceMs: 15000,
      portFreeTimeoutMs: 30000,
      ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
    },
    previous: options.previous && typeof options.previous === 'object' ? options.previous : null,
    mode: options.mode === 'external' ? 'external' : 'installed',
    // Which form was actually registered (it can differ from the plan when the
    // scheduled task was refused and the startup folder took over).
    kind: typeof options.kind === 'string' && options.kind !== '' ? options.kind : null,
    generation: Number.isFinite(Number(options.generation)) ? Number(options.generation) : 1,
  }
}

/**
 * Write the supervisor configuration.
 *
 * @param {string} stateDir
 * @param {object} config
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeSupervisorConfig(stateDir, config) {
  const paths = supervisorPaths(stateDir)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    const temporary = paths.config + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', 'utf8')
    fs.renameSync(temporary, paths.config)
    return { ok: true, path: paths.config, error: null }
  } catch (error) {
    return { ok: false, path: paths.config, error: errorText(error) }
  }
}

/**
 * Read the supervisor configuration.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, config: object|null, error: string|null }}
 */
export function readSupervisorConfig(stateDir) {
  const paths = supervisorPaths(stateDir)
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { ok: false, config: null, error: 'the configuration is not an object' }
    return { ok: true, config: parsed, error: null }
  } catch (error) {
    return { ok: false, config: null, error: errorText(error) }
  }
}

/**
 * Write the rollback request the daemon reads when the host does not come back.
 *
 * @param {string} stateDir
 * @param {{ backupDir: string, profileDir: string, generation?: number, reason?: string }} request
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeRollbackRequest(stateDir, request) {
  const paths = supervisorPaths(stateDir)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.rollbackRequest, JSON.stringify({
      backupDir: String(request && request.backupDir ? request.backupDir : ''),
      profileDir: String(request && request.profileDir ? request.profileDir : ''),
      generation: Number.isFinite(Number(request && request.generation)) ? Number(request.generation) : 0,
      reason: String(request && request.reason ? request.reason : 'plugin-restart'),
      requestedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
    return { ok: true, path: paths.rollbackRequest, error: null }
  } catch (error) {
    return { ok: false, path: paths.rollbackRequest, error: errorText(error) }
  }
}

/**
 * Read the rollback request.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRollbackRequest(stateDir) {
  const paths = supervisorPaths(stateDir)
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.rollbackRequest, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Is this instance the one the supervisor started?
 *
 * The ENVIRONMENT MARKER is the authoritative evidence: the daemon injects it
 * into the host it starts. The pid file is the second hand (it also carries
 * the address of the control channel); the process tree is NOT used — a
 * daemon that `exec`s the host, or a daemon that died first, leaves the host
 * re-parented to pid 1, so the parent chain proves nothing.
 *
 * @param {{ env?: object, stateDir?: string }} [options]
 * @returns {{ supervised: boolean, reason: string, control: object|null, pid: number|null }}
 */
export function detectSupervisor(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const marker = env[SUPERVISED_ENV]
  const markerPid = Number(env[SUPERVISOR_PID_ENV])
  let control = null
  let pid = Number.isFinite(markerPid) && markerPid > 0 ? markerPid : null
  if (stateDir !== '') {
    const paths = supervisorPaths(stateDir)
    try {
      control = JSON.parse(fs.readFileSync(paths.control, 'utf8'))
    } catch {
      control = null
    }
    try {
      const written = Number(fs.readFileSync(paths.pid, 'utf8').trim())
      if (Number.isFinite(written) && written > 0) pid = written
    } catch {
      /* the pid file is optional */
    }
  }
  if (marker === '1' || marker === 'true') {
    return { supervised: true, reason: 'the supervisor started this instance', control, pid }
  }
  if (control !== null && pid !== null) {
    return {
      supervised: false,
      reason: 'a supervisor is installed, but this instance was not started by it',
      control,
      pid,
    }
  }
  return { supervised: false, reason: 'this instance was not started by a supervisor', control, pid }
}

/**
 * Is a process alive?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  const number = Number(pid)
  if (!Number.isFinite(number) || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/**
 * Ask the supervisor to do something over its control channel.
 *
 * @param {{ stateDir?: string, control?: object, action?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, response: object|null, error: string|null }>}
 */
export function requestSupervisorAction(options = {}) {
  const action = typeof options.action === 'string' && options.action !== '' ? options.action : 'restart'
  let control = options.control && typeof options.control === 'object' ? options.control : null
  if (control === null && typeof options.stateDir === 'string' && options.stateDir !== '') {
    try {
      control = JSON.parse(fs.readFileSync(supervisorPaths(options.stateDir).control, 'utf8'))
    } catch {
      control = null
    }
  }
  if (!control || control.type !== 'tcp' || !Number.isFinite(Number(control.port)) || Number(control.port) <= 0) {
    return Promise.resolve({ ok: false, response: null, error: 'the supervisor has no control channel' })
  }
  const timeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : 5000
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const socket = net.connect({ port: Number(control.port), host: String(control.host || '127.0.0.1') })
    let buffer = ''
    const timer = setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        /* nothing else to do */
      }
      done({ ok: false, response: null, error: 'the supervisor did not answer in time' })
    }, timeout)
    socket.on('connect', () => {
      try {
        socket.write(JSON.stringify({ action }) + '\n')
      } catch {
        /* the timeout below reports it */
      }
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      let response = null
      try {
        response = JSON.parse(buffer.slice(0, index))
      } catch {
        response = null
      }
      try {
        socket.destroy()
      } catch {
        /* nothing else to do */
      }
      done({ ok: Boolean(response && response.ok === true), response, error: null })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      done({ ok: false, response: null, error: errorText(error) })
    })
  })
}

/**
 * The node interpreter the supervisor is started with.
 *
 * A name that IS a node interpreter is taken as it is (the caller knows what
 * it wants); anything else — the Electron client of the desktop app, a
 * wrapper — is looked up on the machine. When nothing is found the caller
 * refuses the installation: the application executable is never used as a
 * stand-in for node.
 *
 * @param {{
 *   nodePath?: string,
 *   execPath?: string,
 *   platform?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{ ok: boolean, path: string, source: string, reason: string }}
 */
export function resolveSupervisorNode(options = {}) {
  const given = String(options.nodePath ?? '')
  if (isNodeExecutable(given)) {
    return { ok: true, path: given, source: 'given', reason: '' }
  }
  return resolveNodeInterpreter({
    execPath: typeof options.execPath === 'string' && options.execPath !== '' ? options.execPath : process.execPath,
    platform: options.platform,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
  })
}

/**
 * Write down what a cleanup did not finish.
 *
 * The list lives NEXT TO the supervisor directory, so writing it cannot bring
 * that directory back to life. It is written ONLY when there is really
 * something left — a list that says "nothing is left" is a lie the user
 * would act on.
 *
 * @param {string} stateDir
 * @param {{ failed: Array<object>, manual: string[], reason?: string }} payload
 * @returns {{ ok: boolean, path: string, pending: object|null, error: string|null }}
 */
export function writePendingCleanup(stateDir, payload) {
  const paths = supervisorPaths(stateDir)
  const pending = {
    createdAt: new Date().toISOString(),
    reason: typeof payload.reason === 'string' ? payload.reason : 'cleanup-incomplete',
    failed: Array.isArray(payload.failed) ? payload.failed : [],
    manual: Array.isArray(payload.manual) ? payload.manual.map(String) : [],
    directory: paths.dir,
  }
  try {
    fs.mkdirSync(path.dirname(paths.pendingUninstall), { recursive: true })
    fs.writeFileSync(paths.pendingUninstall, JSON.stringify(pending, null, 2) + '\n', 'utf8')
    return { ok: true, path: paths.pendingUninstall, pending, error: null }
  } catch (error) {
    return { ok: false, path: paths.pendingUninstall, pending, error: errorText(error) }
  }
}

/**
 * The commands that finish a cleanup by hand.
 *
 * @param {Array<{ file?: string, args?: string[], path?: string }>} steps
 * @returns {string[]}
 */
export function manualCleanupCommands(steps) {
  if (!Array.isArray(steps)) return []
  return steps.map((step) => stepCommandLine(step)).filter((line) => line !== '')
}

/**
 * The plan of an installation (what WOULD be changed).
 *
 * @param {{
 *   platform?: string, nodePath?: string, supervisorPath?: string, configPath?: string,
 *   homeDir?: string, startupDir?: string, user?: string, kind?: string,
 *   isDesktopApp?: boolean, execPath?: string,
 *   startup?: object, host?: { kind?: string, suspect?: boolean, distro?: string, evidence?: string },
 * }} options
 * @returns {{
 *   kind: string,
 *   steps: Array<object>,
 *   degraded: boolean,
 *   compose: string|null,
 *   nodePath: string,
 *   error: string|null,
 *   reason: string,
 *   notes?: string[],
 *   commands?: string[],
 *   options?: Array<object>,
 * }}
 */
export function planSupervisorInstall(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform

  // (1) THE DESKTOP APP BRINGS ITSELF BACK UP. A login record that starts
  // the supervisor would open a SECOND client at every login (it names the
  // application executable, and that executable opens the whole client). So
  // the plan of the desktop host is EMPTY and says why.
  if (options.isDesktopApp === true) {
    return {
      kind: 'none',
      steps: [],
      degraded: false,
      compose: null,
      nodePath: '',
      error: DESKTOP_SUPERVISOR_ERROR,
      reason: DESKTOP_SUPERVISOR_REASON,
    }
  }

  // (2) THE STARTUP MODE. Only a `bare` host (nobody manages it) may get the
  // supervisor of this plugin: an external supervisor, a container or an
  // unknown starter would end up with TWO hosts fighting over the same port.
  const startup = options.startup && typeof options.startup === 'object' ? options.startup : null
  if (startup !== null && startup.canInstallSupervisor !== true) {
    return {
      kind: 'none',
      steps: [],
      degraded: false,
      compose: null,
      nodePath: '',
      error: STARTUP_NOT_INSTALLABLE,
      reason: typeof startup.suggestion === 'string' && startup.suggestion !== ''
        ? startup.suggestion
        : 'the startup mode "' + String(startup.mode) + '" does not allow a supervisor of this plugin',
    }
  }

  // (3) THE INTERPRETER MUST BE A REAL NODE. `process.execPath` is the
  // Electron client in the desktop app; a login record that names it as the
  // interpreter starts the whole client again. The interpreter is resolved,
  // and when there is none the installation is refused with the reason.
  const interpreter = resolveSupervisorNode({
    nodePath: options.nodePath,
    execPath: options.execPath,
    platform,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
  })
  if (!interpreter.ok) {
    return {
      kind: 'none',
      steps: [],
      degraded: false,
      compose: null,
      nodePath: '',
      error: NODE_INTERPRETER_ERROR,
      reason: interpreter.reason,
    }
  }
  const nodePath = interpreter.path

  const detected = detectInitSystems({
    platform,
    homeDir: options.homeDir,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
    execFileSyncFn: options.execFileSyncFn,
  })
  const steps = buildInstallSteps({
    platform,
    kind: options.kind,
    nodePath,
    supervisorPath: options.supervisorPath,
    configPath: options.configPath,
    homeDir: options.homeDir,
    startupDir: options.startupDir,
    user: options.user,
  })
  // (4) THE PLATFORM GUIDE. Every hosted platform gets ITS OWN advice:
  // Windows (a scheduled task, with the startup folder as the fallback),
  // Linux (a systemd user unit + the linger hint), WSL (a user unit + the
  // linger, or the two ways out when there is no systemd at all), a container
  // (the orchestrator) and the unknown host (nothing, and no guessing).
  const host = options.host && typeof options.host === 'object' ? options.host : null
  const advice = planAutostartAdvice({
    host,
    platform,
    hasSystemd: detected.systemdUser,
    container: options.container === true,
    user: options.user,
    distro: host !== null ? host.distro : '',
    command: supervisorCommandLine({
      nodePath,
      supervisorPath: options.supervisorPath,
      configPath: options.configPath,
    }),
  })

  if (host !== null && host.kind === 'wsl' && !detected.systemdUser) {
    // No systemd in WSL: there is no "at login" to register. The two ways
    // out are handed to the user — the plugin changes nothing, and it NEVER
    // suggests Docker/Compose here (the orchestrator of WSL is Windows).
    return {
      kind: 'wsl-manual',
      steps: [],
      degraded: false,
      compose: null,
      nodePath,
      error: WSL_NO_SYSTEMD,
      reason: advice.reason,
      notes: advice.notes,
      commands: advice.commands,
      options: advice.options,
    }
  }

  if (platform !== 'win32' && !detected.systemdUser) {
    return {
      kind: 'none',
      steps: [],
      degraded: false,
      compose: composeFragment({ ...options, nodePath }),
      nodePath,
      error: null,
      reason: detected.reason,
      notes: advice.notes,
      commands: advice.commands,
      options: advice.options,
    }
  }
  return {
    kind: platform === 'win32' ? 'windows-schtasks' : (options.kind === 'systemd-system' ? 'systemd-system' : 'systemd-user'),
    steps,
    degraded: false,
    compose: null,
    nodePath,
    error: null,
    reason: advice.reason,
    notes: advice.notes,
    commands: advice.commands,
    options: advice.options,
  }
}

/**
 * Install the supervisor.
 *
 * The order is fixed: the FILES first (the daemon, the configuration), then
 * the autostart record. When the record cannot be registered, the files are
 * removed again — a half-installed supervisor must not stay behind.
 *
 * @param {{
 *   stateDir?: string,
 *   profileDir?: string,
 *   nodePath?: string,
 *   execPath?: string,
 *   execArgv?: string[],
 *   argv?: string[],
 *   cwd?: string,
 *   env?: object,
 *   profileEnv?: object,
 *   port?: number,
 *   healthUrl?: string,
 *   ownerUser?: string,
 *   timings?: object,
 *   previous?: object|null,
 *   platform?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   user?: string,
 *   kind?: string,
 *   isDesktopApp?: boolean,
 *   confirmed?: boolean,
 *   dryRun?: boolean,
 *   execFileSyncFn?: Function,
 *   existsSyncFn?: Function,
 *   copySupervisor?: Function,
 *   log?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean, kind: string, installed: boolean, degraded: boolean,
 *   steps: Array<object>, error: string|null, reason: string, config: object|null,
 *   compose: string|null, plan: object|null,
 * }}
 */
export function installSupervisor(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const paths = supervisorPaths(stateDir)
  const homeDir = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const startupDir = typeof options.startupDir === 'string'
    ? options.startupDir
    : (process.env.APPDATA
      ? path.join(String(process.env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : '')
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const requestedNodePath = typeof options.nodePath === 'string' && options.nodePath !== ''
    ? options.nodePath
    : (typeof options.execPath === 'string' && options.execPath !== '' ? options.execPath : process.execPath)

  const plan = planSupervisorInstall({
    platform,
    nodePath: requestedNodePath,
    execPath: typeof options.execPath === 'string' && options.execPath !== '' ? options.execPath : process.execPath,
    isDesktopApp: options.isDesktopApp === true,
    startup: options.startup,
    // WHICH MACHINE IS THIS? WSL is not a Linux: the "start at login" there is
    // a different thing (and the Docker/Compose answer is a wrong one).
    host: options.host,
    supervisorPath: paths.script,
    configPath: paths.config,
    homeDir,
    startupDir,
    user: options.user,
    kind: options.kind,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
    execFileSyncFn: options.execFileSyncFn,
  })

  const base = {
    ok: false,
    kind: plan.kind,
    installed: false,
    degraded: false,
    steps: [],
    error: plan.error ?? null,
    reason: plan.reason,
    config: null,
    compose: plan.compose,
    // The advice of the WSL branch (the linger command, the two ways out).
    notes: Array.isArray(plan.notes) ? plan.notes : [],
    commands: Array.isArray(plan.commands) ? plan.commands : [],
    options: Array.isArray(plan.options) ? plan.options : [],
    plan,
  }

  if (stateDir === '') return { ...base, error: 'installSupervisor requires stateDir' }
  // The plan refused: the desktop app manages itself, or there is no node
  // interpreter to start the supervisor with. Nothing is written and no
  // command is run — the refusal happens BEFORE the files are copied.
  if (plan.error) {
    return { ...base, error: plan.error, reason: plan.reason }
  }
  if (plan.kind === 'none') {
    return {
      ...base,
      error: 'this machine has no "start at login" mechanism: ' + plan.reason,
    }
  }
  // The interpreter the record really uses (a real node, never the app exe).
  const nodePath = plan.nodePath

  // The plan is what the confirmation card shows. Without the user's nod
  // nothing is written at all.
  if (options.dryRun === true || options.confirmed !== true) {
    return {
      ...base,
      ok: options.dryRun === true,
      steps: plan.steps,
      reason: options.dryRun === true
        ? 'dry run: nothing was written'
        : 'the installation needs the confirmation card',
      error: options.dryRun === true ? null : 'the installation needs the confirmation card',
    }
  }

  // (1) The files.
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    const source = typeof options.copySupervisor === 'function'
      ? options.copySupervisor()
      : fs.readFileSync(packagedSupervisorPath())
    const temporary = paths.script + '.tmp'
    fs.writeFileSync(temporary, source)
    fs.renameSync(temporary, paths.script)
  } catch (error) {
    return { ...base, error: 'the supervisor script could not be copied: ' + errorText(error) }
  }

  const config = buildSupervisorConfig({
    execPath: options.execPath,
    execArgv: options.execArgv,
    argv: options.argv,
    cwd: options.cwd,
    env: options.env,
    profileEnv: options.profileEnv,
    port: options.port,
    healthUrl: options.healthUrl,
    profileDir: options.profileDir,
    stateDir,
    ownerUser: options.ownerUser,
    timings: options.timings,
    previous: options.previous,
    mode: 'installed',
  })
  const written = writeSupervisorConfig(stateDir, config)
  if (!written.ok) {
    return { ...base, error: 'the supervisor configuration could not be written: ' + written.error }
  }

  // (2) The autostart record.
  const steps = []
  let kind = plan.kind
  let degraded = false
  let error = null

  if (platform === 'win32') {
    const task = buildInstallSteps({
      platform,
      nodePath,
      supervisorPath: paths.script,
      configPath: paths.config,
      startupDir,
    })
    const taskStep = task[0]
    const fallbackStep = task[1]
    const created = runCommand(taskStep.file, taskStep.args, { execFileSyncFn: exec })
    steps.push({ kind: taskStep.kind, description: taskStep.description, ok: created.ok, error: created.error })
    if (created.ok) {
      // "It answered" is not "it is there": the record is verified.
      const query = runCommand('schtasks', ['/Query', '/TN', SUPERVISOR_TASK_NAME], { execFileSyncFn: exec })
      steps.push({ kind: 'verify', description: 'check that the scheduled task exists', ok: query.ok, error: query.error })
      if (!query.ok) {
        error = 'the scheduled task was created but cannot be queried: ' + String(query.error)
      }
    } else {
      // The degradation: the startup folder needs no rights at all.
      log('the scheduled task was refused; falling back to the startup folder: ' + String(created.error))
      degraded = true
      kind = 'windows-startup'
      try {
        fs.mkdirSync(path.dirname(fallbackStep.path), { recursive: true })
        fs.writeFileSync(fallbackStep.path, fallbackStep.content, 'utf8')
        steps.push({ kind: fallbackStep.kind, description: fallbackStep.description, ok: true, error: null })
      } catch (fallbackError) {
        error = 'the scheduled task was refused (' + String(created.error)
          + ') and the startup folder could not be written: ' + errorText(fallbackError)
      }
    }
  } else {
    const unit = buildInstallSteps({
      platform,
      kind: options.kind,
      nodePath,
      supervisorPath: paths.script,
      configPath: paths.config,
      homeDir,
      user: options.user,
    })
    for (const step of unit) {
      if (step.kind === 'systemd-user' || step.kind === 'systemd-system') {
        try {
          fs.mkdirSync(path.dirname(step.path), { recursive: true })
          fs.writeFileSync(step.path, step.content, 'utf8')
          steps.push({ kind: step.kind, description: step.description, ok: true, error: null })
        } catch (writeError) {
          error = 'the unit file could not be written: ' + errorText(writeError)
          steps.push({ kind: step.kind, description: step.description, ok: false, error: errorText(writeError) })
          break
        }
        continue
      }
      const answer = runCommand(step.file, step.args, { execFileSyncFn: exec })
      steps.push({ kind: step.kind, description: step.description, ok: answer.ok, error: answer.error })
      if (!answer.ok) {
        error = step.description + ' failed: ' + String(answer.error)
        break
      }
    }
  }

  if (error !== null) {
    // Nothing may stay half-installed: the record that was written is taken
    // away again — and the report says what the rollback did. A failed
    // installation that leaves an enabled unit behind would start a stale
    // supervisor at the next login, so the rollback is not optional.
    const rollback = buildUninstallSteps({ platform, kind, homeDir, startupDir })
    for (const step of rollback) {
      if (step.path) {
        try {
          fs.rmSync(step.path, { force: true })
          steps.push({ kind: 'rollback-' + step.kind, description: step.description, ok: true, error: null })
        } catch (rollbackError) {
          steps.push({ kind: 'rollback-' + step.kind, description: step.description, ok: false, error: errorText(rollbackError) })
        }
        continue
      }
      if (!step.file) continue
      const answer = runCommand(step.file, step.args, { execFileSyncFn: exec })
      steps.push({ kind: 'rollback-' + step.kind, description: step.description, ok: answer.ok, error: answer.error })
    }
    try {
      fs.rmSync(paths.dir, { recursive: true, force: true })
    } catch {
      /* the report says what is left */
    }
    const leftOver = steps
      .filter((step) => String(step.kind).startsWith('rollback-') && step.ok === false)
    if (leftOver.length > 0) {
      // The rollback did not finish either: what is left is written down, so
      // the user can finish it by hand instead of finding a stale unit later.
      // (The step that failed the installation is NOT residue — the rollback
      // took it away again.)
      writePendingCleanup(stateDir, {
        reason: 'install-rollback-incomplete',
        failed: leftOver.map((step) => ({ kind: step.kind, description: step.description, error: step.error })),
        manual: manualCleanupCommands(rollback),
      })
    }
    return { ...base, kind, degraded, steps, error, config }
  }

  // The kind is known now (it may have changed through the degradation), so the
  // configuration is written again with it.
  config.kind = kind
  writeSupervisorConfig(stateDir, config)

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
 * Uninstall the supervisor and give the machine back to the user.
 *
 * @param {{
 *   stateDir?: string,
 *   platform?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   dryRun?: boolean,
 *   execFileSyncFn?: Function,
 *   stopSupervisor?: Function,
 *   log?: Function,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean, steps: Array<object>, error: string|null,
 *   pending: object|null, previous: object|null,
 * }>}
 */
export async function uninstallSupervisor(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const paths = supervisorPaths(stateDir)
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : null
  const homeDir = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const startupDir = typeof options.startupDir === 'string'
    ? options.startupDir
    : (process.env.APPDATA
      ? path.join(String(process.env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : '')

  const config = readSupervisorConfig(stateDir)
  const kind = config.ok && config.config && typeof config.config.kind === 'string'
    ? config.config.kind
    : (platform === 'win32' ? 'windows-schtasks' : 'systemd-user')
  const previous = config.ok && config.config && config.config.previous && typeof config.config.previous === 'object'
    ? config.config.previous
    : null

  const steps = buildUninstallSteps({ platform, kind, homeDir, startupDir })
  const base = {
    ok: false,
    steps: [],
    error: null,
    pending: null,
    previous,
  }
  if (stateDir === '') return { ...base, error: 'uninstallSupervisor requires stateDir' }

  if (options.dryRun === true) {
    return { ...base, ok: true, steps, error: null, reason: 'dry run: nothing was changed' }
  }

  const done = []

  // (1) Stop the supervisor. The control channel is the polite way; the pid
  // is the fallback.
  const stop = typeof options.stopSupervisor === 'function'
    ? options.stopSupervisor
    : (args) => requestSupervisorAction(args)
  const stopped = await stop({ stateDir, action: 'stop' })
  if (!stopped || stopped.ok !== true) {
    log('the supervisor did not stop through its control channel: ' + String(stopped && stopped.error))
  }
  done.push({ kind: 'stop', description: 'stop the supervisor', ok: true, error: null })

  // (2) The autostart record.
  for (const step of steps) {
    if (step.path) {
      try {
        fs.rmSync(step.path, { force: true })
        done.push({ kind: step.kind, description: step.description, ok: true, error: null })
      } catch (error) {
        done.push({ kind: step.kind, description: step.description, ok: false, error: errorText(error) })
      }
      continue
    }
    const answer = runCommand(step.file, step.args, { execFileSyncFn: exec })
    done.push({ kind: step.kind, description: step.description, ok: answer.ok, error: answer.error })
  }

  // (3) The state directory of the supervisor. The report must match the
  // machine: the directory is really gone, or it is not.
  let cleanupError = null
  try {
    fs.rmSync(paths.dir, { recursive: true, force: true })
  } catch (error) {
    cleanupError = errorText(error)
  }
  const directoryGone = !fs.existsSync(paths.dir)
  done.push({
    kind: 'cleanup',
    description: 'remove the supervisor directory',
    ok: cleanupError === null && directoryGone,
    error: cleanupError === null && directoryGone
      ? null
      : (cleanupError ?? 'the supervisor directory is still there'),
  })

  const failed = done.filter((step) => step.ok !== true)
  if (failed.length > 0) {
    // The uninstall did not finish: what is left is written down, with the
    // commands that finish it by hand. A half-removed record that still
    // starts a stale supervisor would be worse than a written-down list.
    // The list lives NEXT TO the supervisor directory, so writing it cannot
    // bring that directory back to life.
    const written = writePendingCleanup(stateDir, {
      reason: 'uninstall-incomplete',
      failed: failed.map((step) => ({ kind: step.kind, description: step.description, error: step.error })),
      manual: manualCleanupCommands(steps),
    })
    return {
      ...base,
      ok: false,
      steps: done,
      error: 'the uninstall did not finish; the pending cleanup was written to ' + written.path,
      pending: written.pending,
    }
  }

  // Nothing is left: a to-do list from an earlier attempt would be a lie.
  try {
    fs.rmSync(paths.pendingUninstall, { force: true })
  } catch {
    /* nothing else to do */
  }
  return { ...base, ok: true, steps: done, error: null, pending: null }
}

/**
 * The startup classification as the status reports it.
 *
 * It is the answer of the startup matrix: the mode, the EVIDENCE the verdict
 * rests on (so the user can see WHY the plugin says what it says), and what
 * the plugin may do about it.
 *
 * @param {object|null|undefined} startup
 * @returns {{
 *   mode: string, kind: string, evidence: string, selfReplay: string,
 *   canInstallSupervisor: boolean, detachCommand: boolean, suggestion: string,
 * }|null}
 */
export function startupSummary(startup) {
  if (!startup || typeof startup !== 'object') return null
  return {
    mode: typeof startup.mode === 'string' ? startup.mode : STARTUP_MODES.UNKNOWN,
    kind: typeof startup.kind === 'string' ? startup.kind : '',
    evidence: typeof startup.evidence === 'string' ? startup.evidence : '',
    selfReplay: typeof startup.selfReplay === 'string' ? startup.selfReplay : 'unknown',
    canInstallSupervisor: startup.canInstallSupervisor === true,
    detachCommand: startup.detachCommand === true,
    suggestion: typeof startup.suggestion === 'string' ? startup.suggestion : '',
  }
}

/**
 * What the plugin knows about the supervisor.
 *
 * THREE SOURCES, ONE ANSWER:
 *
 *   1. the plugin's OWN supervisor (the marker in the environment and the
 *      configuration file it wrote);
 *   2. an EXTERNAL supervisor (systemd, pm2, a `supervise-*.sh` script of the
 *      user) — the parent chain of this very process;
 *   3. the configured mode (`external` = "my own way", `off`).
 *
 * The second one used to be missing here: the status answered "nothing is
 * known about how this host is started" while the parent chain plainly said
 * `/bin/bash /home/fg/supervise-web.sh`. That is not a cosmetic gap — a host
 * that somebody else supervises must NOT be restarted by a self-replay (the
 * supervisor starts it again, and the replay would start a SECOND host on the
 * same port). So the external supervisor is detected here, reported with its
 * evidence, and the self-replay is refused.
 *
 * @param {{
 *   stateDir?: string,
 *   env?: object,
 *   platform?: string,
 *   mode?: string,
 *   ppid?: number,
 *   isDesktopApp?: boolean,
 *   inspectExternal?: Function,
 *   execFileSyncFn?: Function,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   mode: 'app'|'installed'|'external'|'unknown'|'off',
 *   kind: string|null,
 *   installed: boolean,
 *   running: boolean,
 *   supervised: boolean,
 *   restartCapable: boolean,
 *   reason: string,
 *   external: { kind: string, evidence: string, commandLine: string }|null,
 *   selfReplay: 'allowed'|'refused'|'unknown'|'n/a',
 *   detail: object,
 * }}
 */
export function supervisorStatus(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  // The desktop app brings ITSELF back up: it is not a host that waits for
  // somebody else, and it is never "unknown".
  const isDesktopApp = options.isDesktopApp === true
  const detected = detectSupervisor({ env: options.env, stateDir })
  const config = readSupervisorConfig(stateDir)
  const paths = supervisorPaths(stateDir)
  const installed = config.ok && config.config !== null
  const running = detected.pid !== null && isProcessAlive(detected.pid)
  const kind = installed && config.config && typeof config.config.kind === 'string' ? config.config.kind : null
  const configuredMode = typeof options.mode === 'string' ? options.mode : (installed && config.config ? config.config.mode : 'auto')

  // WHO ELSE IS IN CHARGE? The parent chain of this very process is the
  // evidence (Linux: `/proc/<ppid>/cmdline`). The inspection never throws and
  // always answers — with a reason when it found nothing.
  let external = null
  let externalReason = ''
  try {
    const inspect = typeof options.inspectExternal === 'function'
      ? options.inspectExternal
      : inspectExternalSupervisor
    const found = inspect({
      env: options.env,
      platform,
      ppid: options.ppid,
    })
    externalReason = found && typeof found.reason === 'string' ? found.reason : ''
    if (found && typeof found.kind === 'string' && found.kind !== '') {
      external = {
        kind: found.kind,
        evidence: typeof found.evidence === 'string' ? found.evidence : '',
        commandLine: typeof found.commandLine === 'string' ? found.commandLine : '',
      }
    }
  } catch (error) {
    externalReason = 'the supervisor detection failed: ' + errorText(error)
  }

  let mode = 'unknown'
  let reason = 'nothing is known about how this host is started'
  if (isDesktopApp) {
    // THE DESKTOP APP BRINGS ITSELF BACK UP (`restartMode: app`). It is NOT
    // "nobody knows": the app knows, and the restart works. Reporting
    // "unknown" here would tell the user that the restart is unavailable
    // while the app is restarting itself all the time — so the desktop host
    // answers first and never falls through to "unknown".
    mode = 'app'
    reason = DESKTOP_RESTART_REASON
  } else if (configuredMode === 'external') {
    // The user said so: their own way of starting this host.
    mode = 'external'
    reason = 'this host is started by your own way'
  } else if (installed) {
    mode = 'installed'
    reason = running
      ? 'the supervisor of this plugin is running'
      : 'the supervisor of this plugin is installed but not running'
  } else if (detected.supervised) {
    mode = 'installed'
    reason = 'this instance was started by a supervisor'
  } else if (external !== null) {
    // Somebody else is in charge. The plugin must not start a second copy.
    mode = 'external'
    reason = `this host is started by an external supervisor (${external.kind}, ${external.evidence})`
  } else if (configuredMode === 'off') {
    mode = 'off'
    reason = 'the automatic restart is switched off'
  } else if (externalReason !== '') {
    // "Nothing is known" is NOT "a bare host": the plugin says so instead of
    // pretending it may replay its own command.
    reason = 'it could not be established who starts this host: ' + externalReason
  }

  // The restart can only work when SOMEBODY brings the host back: the
  // supervisor of this plugin, the one of the user — or the desktop app
  // itself, which relaunches its own process.
  const restartCapable = isDesktopApp
    || detected.supervised
    || mode === 'external'
    || (mode === 'installed' && running)

  // May the plugin write a command that starts THIS host again? Only when it
  // is in charge itself. With an external supervisor the answer is a plain
  // "no" (the supervisor starts the host again) — and when nothing is known
  // the answer is "unknown", never a silent "yes".
  let selfReplay = 'unknown'
  if (mode === 'app') selfReplay = 'n/a'
  else if (mode === 'installed') selfReplay = 'allowed'
  else if (mode === 'external' || mode === 'off') selfReplay = 'refused'

  // A conflict is a real double-start risk: the supervisor of this plugin is
  // registered AND somebody else is in charge. Both would start the host.
  const conflict = installed && external !== null
  const finalReason = conflict
    ? reason + ' — and an external supervisor (' + external.kind + ') is in charge as well: both would start this host, so one of them has to go'
    : reason

  return {
    mode,
    kind,
    installed,
    running,
    supervised: detected.supervised,
    restartCapable,
    reason: finalReason,
    external,
    selfReplay,
    // HOW THIS HOST WAS STARTED (the startup matrix): the mode, the evidence
    // the verdict rests on, and what the plugin may do about it.
    startup: startupSummary(options.startup),
    // THE PLATFORM GUIDE: how "start at login" works HERE (Windows / Linux /
    // WSL / container), with the commands the user can copy.
    autostart: options.autostart && typeof options.autostart === 'object'
      ? options.autostart
      : null,
    detail: {
      detected: detected.reason,
      pid: detected.pid,
      control: detected.control,
      configPath: paths.config,
      // The evidence of the external supervisor (and WHY nothing was found).
      externalReason,
      externalChecked: external !== null ? [external.evidence] : [],
      conflict,
      pendingUninstall: (() => {
        try {
          return fs.existsSync(paths.pendingUninstall)
        } catch {
          return false
        }
      })(),
      // What the user has to run by hand when the uninstall did not finish.
      pendingCommands: (() => {
        try {
          const raw = fs.readFileSync(paths.pendingUninstall, 'utf8')
          const parsed = JSON.parse(raw)
          return parsed && Array.isArray(parsed.manual) ? parsed.manual.map(String) : []
        } catch {
          return []
        }
      })(),
    },
  }
}


/* ------------------------------------------------------------------ *
 * THE "START AT LOGIN" RECORDS (moved here from lib/supervisor-install.js).
 *
 * This module GENERATES the commands and the unit files. It never runs
 * them: the running of a command is the job of this module, and the
 * tests check the generated commands against a fake executor - so the
 * tests never register anything on the machine they run on.
 * ------------------------------------------------------------------ */

/**
 * dsh-autorestart — the platform "start at login" records of the supervisor.
 *
 * This module GENERATES the commands and the unit files. It never runs
 * them: the running of a command is the job of `lib/supervisor.js`, and the
 * tests check the generated commands against a fake executor — so the tests
 * never register anything on the machine they run on.
 *
 * THE FORMS (and why):
 *
 *   - **Windows / scheduled task** (`schtasks /SC ONLOGON /RL LIMITED`):
 *     the default. It needs NO administrator (a service would), it runs in the
 *     user's own session, and it starts when the user LOGS IN (not when the
 *     machine boots — a boot task would need `/ru SYSTEM`, and then the host
 *     would read the WRONG home directory).
 *     `/F` makes it idempotent: installing twice does not create a second
 *     task. `/ru`, `/NP` and `/IT` are deliberately NOT passed: `/NP` needs
 *     the "log on as batch job" right that ordinary users do not have, and
 *     `/IT` kills the task when the user logs off.
 *   - **Windows / startup folder** (a `.cmd` in the Startup folder): the
 *     DEGRADATION when the scheduled task cannot be created (some machines
 *     forbid ordinary users from creating tasks). Same zero rights, same
 *     "start at login" semantics.
 *   - **Linux / systemd user unit** (`~/.config/systemd/user/…`): the
 *     default on Linux and WSL. `systemctl --user` needs no administrator.
 *   - **Linux / systemd system unit** (`/etc/systemd/system/…`): only an
 *     EXPLICIT choice ("install it as a system service"), because it needs
 *     root — and it must carry `User=` so the host does not read root's home
 *     directory.
 *
 * A machine WITHOUT a system service manager (a container, a WSL without
 * systemd) has no "start at login" at all: there is no form to register, so
 * the plugin refuses and leaves the start command to the user.
 *
 * ESM only, Node builtins only.
 */


/** The name of the autostart record (a scheduled task, a systemd unit). */
export const SUPERVISOR_TASK_NAME = 'dsh-autorestart-web'

/** The kinds the plugin knows. */
export const SUPERVISOR_KINDS = Object.freeze([
  'windows-schtasks',
  'windows-startup',
  'systemd-user',
  'systemd-system',
])

/** @param {unknown} value */
function installErrorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/**
 * The command line that starts the supervisor.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string}
 */
export function supervisorCommandLine({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const node = String(nodePath ?? '')
  const supervisor = String(supervisorPath ?? '')
  const config = String(configPath ?? '')
  if (node === '' || supervisor === '') return ''
  return `"${node}" "${supervisor}" --config "${config}"`
}

/**
 * The arguments of `schtasks /Create` that register the supervisor.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string, taskName?: string }} options
 * @returns {string[]}
 */
export function windowsTaskCreateArgs({
  nodePath = '',
  supervisorPath = '',
  configPath = '',
  taskName = SUPERVISOR_TASK_NAME,
} = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '/Create',
    '/TN', taskName,
    '/SC', 'ONLOGON',
    '/TR', command,
    '/RL', 'LIMITED',
    '/F',
  ]
}

/**
 * The arguments of `schtasks /Query` that check the record.
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function windowsTaskQueryArgs({ taskName = SUPERVISOR_TASK_NAME } = {}) {
  return ['/Query', '/TN', taskName]
}

/**
 * The arguments of `schtasks /Delete` that remove the record.
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function windowsTaskDeleteArgs({ taskName = SUPERVISOR_TASK_NAME } = {}) {
  return ['/Delete', '/TN', taskName, '/F']
}

/**
 * The path of the `.cmd` in the startup folder (the Windows degradation).
 *
 * @param {{ startupDir?: string, taskName?: string }} [options]
 * @returns {string}
 */
export function windowsStartupCmdPath({ startupDir = '', taskName = SUPERVISOR_TASK_NAME } = {}) {
  const dir = String(startupDir ?? '')
  if (dir === '') return ''
  return path.join(dir, taskName + '.cmd')
}

/**
 * The content of the `.cmd` in the startup folder.
 *
 * `start ""` detaches the supervisor from the console, so the window closes
 * right away (a console parked in front of the user is not acceptable).
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string} the script text (CRLF lines)
 */
export function windowsStartupCmdContent({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '@echo off',
    'rem dsh-autorestart: start the supervisor when the user logs in.',
    'start "" ' + command,
    '',
  ].join('\r\n')
}

/**
 * The path of the systemd USER unit.
 *
 * A systemd path is ALWAYS a POSIX path, so it is built with POSIX
 * separators — even when the plugin runs on Windows (a WSL instance is
 * configured from a Windows host more often than not).
 *
 * @param {{ homeDir?: string, taskName?: string }} [options]
 * @returns {string}
 */
export function systemdUserUnitPath({ homeDir = '', taskName = SUPERVISOR_TASK_NAME } = {}) {
  const home = String(homeDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (home === '') return ''
  return home + '/.config/systemd/user/' + taskName + '.service'
}

/**
 * The content of the systemd USER unit.
 *
 * `StartLimit*` belongs to `[Unit]` (systemd.unit(5)), not to `[Service]`.
 * `Restart=always` only covers the supervisor itself (the supervisor never
 * exits by itself), and `systemctl stop` does NOT restart it — so the
 * uninstall is clean.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string} the unit text
 */
export function systemdUserUnitContent({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '[Unit]',
    'Description=dsh-autorestart web supervisor',
    '# StartLimit* must be written in the Unit section (systemd.unit(5)), not in the Service section.',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    'ExecStart=' + command,
    'Restart=always',
    'RestartSec=3',
    'Environment=DSH_AUTORESTART_SUPERVISED=1',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/**
 * The content of the systemd SYSTEM unit.
 *
 * It needs `User=` (and the matching `HOME`): without it the unit would run
 * as root and the host would read ROOT's home directory — a different
 * profile, a different port file, a different everything.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string, user?: string, homeDir?: string }} options
 * @returns {string} the unit text
 */
export function systemdSystemUnitContent({
  nodePath = '',
  supervisorPath = '',
  configPath = '',
  user = '',
  homeDir = '',
} = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  const lines = [
    '[Unit]',
    'Description=dsh-autorestart web supervisor',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    'ExecStart=' + command,
    'Restart=always',
    'RestartSec=3',
    'Environment=DSH_AUTORESTART_SUPERVISED=1',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
  ]
  if (user !== '') lines.push('User=' + user)
  if (homeDir !== '') {
    lines.push('Environment=HOME=' + homeDir)
    lines.push('Environment=USER=' + (user || ''))
  }
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '')
  return lines.join('\n')
}

/**
 * The arguments of the systemd commands the plugin uses.
 *
 * THE PROGRAM IS NOT PART OF THE ARGUMENTS. A step carries the program in
 * `file` and the arguments in `args`, so `systemctl` must NOT appear in the
 * arguments as well: `systemctl systemctl --user daemon-reload` is a command
 * nobody can run ("Unknown command verb systemctl"), and it made the whole
 * "install at login" fail on every Linux machine.
 *
 * @param {{ taskName?: string, system?: boolean }} [options]
 * @returns {{
 *   daemonReload: string[],
 *   enable: string[],
 *   disable: string[],
 *   isActive: string[],
 * }}
 */
export function systemdArgs({ taskName = SUPERVISOR_TASK_NAME, system = false } = {}) {
  const scope = system ? ['--system'] : ['--user']
  const unit = taskName + '.service'
  return {
    daemonReload: [...scope, 'daemon-reload'],
    enable: [...scope, 'enable', '--now', unit],
    disable: [...scope, 'disable', '--now', unit],
    isActive: [...scope, 'is-active', '--quiet', unit],
  }
}

/**
 * The arguments of a command, without a repeated program name.
 *
 * A step carries the program in `file` and the arguments in `args`. When the
 * arguments repeat the program (`['systemctl', '--user', …]` for the file
 * `systemctl`), the command would run as `systemctl systemctl …` and fail.
 * The repetition is dropped here, so such a mistake can never reach the
 * machine — and the command line that is reported to the user is the one
 * that really runs.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {string[]}
 */
export function normalizeCommandArgs(file, args) {
  const list = Array.isArray(args) ? args.map(String) : []
  if (list.length < 2) return list
  const program = path.basename(String(file ?? '')).toLowerCase()
  const first = path.basename(list[0]).toLowerCase()
  if (program !== '' && first === program) return list.slice(1)
  return list
}

/**
 * The command line of a step (what the user can run by hand).
 *
 * @param {{ file?: string, args?: string[], path?: string }} step
 * @returns {string}
 */
export function stepCommandLine(step) {
  if (!step || typeof step !== 'object') return ''
  if (typeof step.file === 'string' && step.file !== '') {
    return [step.file, ...normalizeCommandArgs(step.file, step.args)].join(' ')
  }
  if (typeof step.path === 'string' && step.path !== '') return 'delete ' + step.path
  return ''
}

/**
 * Run one command and report what happened (never throws).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ execFileSyncFn?: Function, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null }}
 */
export function runCommand(file, args, options = {}) {
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  if (typeof exec !== 'function') {
    return { ok: false, code: null, stdout: '', stderr: '', error: 'no executor' }
  }
  // The program is in `file`; the arguments must not repeat it.
  const commandArgs = normalizeCommandArgs(file, args)
  try {
    // `stdio: ['ignore','pipe','pipe']` + a timeout: a command that asks for a
    // password gets EOF on stdin instead of hanging for ever.
    const stdout = exec(file, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 20000,
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: '', error: null }
  } catch (error) {
    const code = error && Number.isFinite(Number(error.status)) ? Number(error.status) : null
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = error && typeof error.stderr === 'string' ? error.stderr : ''
    return { ok: false, code, stdout, stderr, error: installErrorText(error) }
  }
}

/**
 * What this machine offers.
 *
 * NOTHING is registered here: the detection only LOOKS. The permission of a
 * scheduled task is probed by really creating it during the installation (it
 * is idempotent) — the MS documentation is ambiguous about whether an
 * ordinary user may create a task, so the plugin asks the machine instead of
 * assuming.
 *
 * @param {{
 *   platform?: string,
 *   homeDir?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 *   execFileSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   platform: string,
 *   schtasks: boolean,
 *   startupFolder: string|null,
 *   systemdUser: boolean,
 *   systemdSystem: boolean,
 *   container: boolean,
 *   reason: string,
 * }}
 */
export function detectInitSystems(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const home = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync

  if (platform === 'win32') {
    const startupDir = env.APPDATA
      ? path.join(String(env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : ''
    const startupFolder = startupDir !== '' && exists(startupDir) ? startupDir : null
    return {
      platform: 'win32',
      // Whether `schtasks` MAY create a task is NOT probed here: the
      // documentation is ambiguous about ordinary users, so the INSTALLATION
      // asks the machine (it runs the idempotent `/Create` and falls back when
      // it is refused). What is reported here is whether the tool is there at
      // all — and the fallback that exists when it is not.
      schtasks: exec !== null,
      startupFolder,
      systemdUser: false,
      systemdSystem: false,
      container: false,
      reason: startupFolder === null
        ? 'the startup folder was not found'
        : 'a scheduled task is the default; the startup folder is the fallback',
    }
  }

  // POSIX: is there a system service manager at all?
  const systemdPresent = exists('/run/systemd/system')
  let systemdUser = false
  if (systemdPresent && exec !== null) {
    const answer = runCommand('systemctl', ['--user', 'is-system-running'], { execFileSyncFn: exec })
    // `is-system-running` answers "degraded" with a non-zero code when the
    // manager is up but some unit failed — that still means the manager works.
    systemdUser = answer.code !== null && answer.code <= 1
  }
  const container = exists('/.dockerenv') || exists('/run/.containerenv')
  const reason = !systemdPresent
    ? 'this machine has no system service manager (a container, or a WSL without systemd)'
    : (systemdUser
      ? 'a systemd user manager is available'
      : 'systemd is present but the user manager is not reachable')
  return {
    platform,
    schtasks: false,
    startupFolder: null,
    systemdUser,
    systemdSystem: systemdPresent,
    container,
    reason,
  }
}

/**
 * The ordered list of steps that install the supervisor.
 *
 * The list is the CONTRACT: the installer walks it and stops at the first
 * step that fails. The Windows list has a degradation built in (the
 * scheduled task, then the startup folder), the POSIX list has none (there is
 * no second way to register a user unit).
 *
 * @param {{
 *   platform?: string,
 *   kind?: string,
 *   nodePath?: string,
 *   supervisorPath?: string,
 *   configPath?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   user?: string,
 *   taskName?: string,
 * }} options
 * @returns {Array<{ kind: string, description: string, file?: string, args?: string[], unit?: string, path?: string, nodePath?: string, command?: string }>}
 */
export function buildInstallSteps(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const taskName = typeof options.taskName === 'string' && options.taskName !== '' ? options.taskName : SUPERVISOR_TASK_NAME
  const nodePath = String(options.nodePath ?? '')
  const supervisorPath = String(options.supervisorPath ?? '')
  const configPath = String(options.configPath ?? '')
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  const steps = []
  if (platform === 'win32') {
    steps.push({
      kind: 'windows-schtasks',
      description: 'register a scheduled task that starts the supervisor at login',
      file: 'schtasks',
      args: windowsTaskCreateArgs({ nodePath, supervisorPath, configPath, taskName }),
      // The interpreter and the command it starts: both are reported so the
      // caller (and the tests) can see that the record starts a REAL node and
      // not the application executable.
      nodePath,
      command,
    })
    steps.push({
      kind: 'windows-startup',
      description: 'put a .cmd into the startup folder (the fallback when tasks are not allowed)',
      path: windowsStartupCmdPath({ startupDir: String(options.startupDir ?? ''), taskName }),
      content: windowsStartupCmdContent({ nodePath, supervisorPath, configPath }),
      nodePath,
      command,
    })
    return steps
  }
  const unit = options.kind === 'systemd-system'
    ? systemdSystemUnitContent({ nodePath, supervisorPath, configPath, user: String(options.user ?? ''), homeDir: String(options.homeDir ?? '') })
    : systemdUserUnitContent({ nodePath, supervisorPath, configPath })
  const args = systemdArgs({ taskName, system: options.kind === 'systemd-system' })
  steps.push({
    kind: options.kind === 'systemd-system' ? 'systemd-system' : 'systemd-user',
    description: 'write the systemd unit',
    path: options.kind === 'systemd-system'
      ? '/etc/systemd/system/' + taskName + '.service'
      : systemdUserUnitPath({ homeDir: String(options.homeDir ?? ''), taskName }),
    content: unit,
    nodePath,
    command,
  })
  steps.push({ kind: 'daemon-reload', description: 'reload the systemd units', file: 'systemctl', args: args.daemonReload })
  steps.push({ kind: 'enable', description: 'enable and start the unit', file: 'systemctl', args: args.enable })
  steps.push({ kind: 'verify', description: 'check that the unit is active', file: 'systemctl', args: args.isActive })
  return steps
}

/**
 * The ordered list of steps that uninstall the supervisor.
 *
 * @param {{
 *   platform?: string,
 *   kind?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   taskName?: string,
 * }} [options]
 * @returns {Array<{ kind: string, description: string, file?: string, args?: string[], path?: string }>}
 */
export function buildUninstallSteps(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const taskName = typeof options.taskName === 'string' && options.taskName !== '' ? options.taskName : SUPERVISOR_TASK_NAME
  const steps = []
  if (platform === 'win32') {
    if (options.kind === 'windows-startup') {
      steps.push({
        kind: 'windows-startup',
        description: 'remove the .cmd from the startup folder',
        path: windowsStartupCmdPath({ startupDir: String(options.startupDir ?? ''), taskName }),
      })
      return steps
    }
    steps.push({
      kind: 'windows-schtasks',
      description: 'delete the scheduled task',
      file: 'schtasks',
      args: windowsTaskDeleteArgs({ taskName }),
    })
    return steps
  }
  const args = systemdArgs({ taskName, system: options.kind === 'systemd-system' })
  steps.push({ kind: 'disable', description: 'stop and disable the unit', file: 'systemctl', args: args.disable })
  steps.push({
    kind: 'unit-file',
    description: 'remove the unit file',
    path: options.kind === 'systemd-system'
      ? '/etc/systemd/system/' + taskName + '.service'
      : systemdUserUnitPath({ homeDir: String(options.homeDir ?? ''), taskName }),
  })
  steps.push({ kind: 'daemon-reload', description: 'reload the systemd units', file: 'systemctl', args: args.daemonReload })
  return steps
}

/**
 * The compose fragment for a machine without a service manager.
 *
 * A container has no "start at login": the only correct answer is the
 * orchestrator's own restart policy.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string}
 */
export function composeFragment({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    'services:',
    '  dsh:',
    '    image: <your dsh image>',
    '    command: ["' + String(nodePath) + '", "' + String(supervisorPath) + '", "--config", "' + String(configPath) + '"]',
    '    restart: always',
  ].join('\n')
}
