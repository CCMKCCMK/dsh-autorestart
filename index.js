/**
 * dsh-autorestart —cross-restart continuation for DeepSeek Harness.
 *
 * The plugin keeps a small durable checkpoint under `<DSH_HOME>/storages/dsh-autorestart/`
 * describing which sessions were in flight. After a host restart it:
 *   1. resumes the interrupted session's agent through `ctx.sessionController.resolveAgent`,
 *   2. re-arms a durable goal when the session had one (the goal round driver then
 *      starts the next round automatically), or
 *   3. injects one clearly-marked continuation prompt so the agent picks the work back up.
 *
 * It also registers tools the agent can call to request an idle-aware graceful restart
 * (`continuum_restart`), inspect the lifecycle (`continuum_status`) and cancel a pending
 * restart (`continuum_cancel_restart`).
 *
 * Deliberately dependency-free: only Node builtins and relative modules, so a
 * profile-installed bundle resolves without any `@deepseek-ai/*` package links.
 *
 * @module dsh-autorestart
 */

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCapabilities, compareCapabilities, listDisappearances } from './lib/plugin-watch.js'

import {
  armSleep,
  beginBoot,
  cancelOwnRestart,
  cancelRestart,
  clearSleep,
  disarmedRecord,
  disarmedGoalEntry,
  entryFor,
  handoffRecord,
  isForbiddenSessionId,
  markIdle,
  markPendingResume,
  markRunning,
  parkedRecord,
  pruneSessions,
  readState,
  recordOnboarding,
  recoverableSessions,
  requestRestart,
  sessionEntry,
  setContextOverflow,
  setDisarmedGoal,
  setGoal,
  setHandoff,
  setRecoveryOutcome,
  setPhase,
  setRestartPhase,
  setRestartProgress,
  clearRestartPhase,
  stampResumedGoal,
  writeState,
} from './lib/checkpoint.js'
import {
  cancelRefusalReason,
  describeRestartPhase,
  RESTART_PHASES,
} from './lib/restart-phase.js'
import {
  bootPlan,
  composeHandoff,
  contextOverflow,
  continuationPrompt,
  describeState,
  GOAL_BLOCK_REASONS,
  HANDOFF_DEFAULT_MAX_CHARS,
  restartDecision,
  restartGate,
  selectGoalDisarms,
} from './lib/lifecycle.js'
import {
  backupsRoot,
  backupPluginDirIn,
  BACKUP_LIMIT_MAX,
  BACKUP_LIMIT_MIN,
  backupLimitInfo,
  // WHAT PUT A COPY ON DISK, AND WHAT THE BOOT AFTER IT REPORTED (2026-11-02):
  // the fact vocabulary that replaced the old "is this copy safe" register. The
  // call sites below state these instead of a stamp.
  BACKUP_TRIGGERS,
  BOOT_OBSERVATIONS,
  CERTIFIED_BY,
  claimRollbackLock,
  manifestPluginsOf,
  clearRollbackReport,
  CONFIG_DIR,
  CONFIG_FILES,
  contentFingerprintOf,
  contentScopeOf,
  countIncompleteBackups,
  createBackup,
  DEFAULT_MAX_BACKUPS,
  enabledBundlesOf,
  isRestoreEligible,
  isUsableRestorePoint,
  KIND_KNOWN_GOOD,
  KIND_SNAPSHOT,
  latestKnownGood,
  LEGACY_RESTORE_REFUSAL,
  normalizeRestoreRefusal,
  RESTORE_REFUSAL,
  LINKS_DIR,
  listBackupIdentities,
  listBackups,
  markKnownGood,
  PLUGINS_DIR,
  planBackupLimit,
  pruneBackups,
  readBackupMeta,
  readManifest,
  readRollbackReport,
  releaseRollbackLock,
  removeIncompleteBackups,
  restoreBackup,
  ROLLBACK_LOCK_NAME,
  sweepIncompleteBackups,
  ROLLBACK_REPORT_NAME,
  validateBackupLimit,
} from './lib/backup.js'
import {
  accessFilePath,
  readAccessRecord,
  resolveAccessUrl,
  writeAccessRecord,
} from './lib/access.js'
import {
  detectInitSystems,
  detectSupervisor,
  installSupervisor,
  planSupervisorInstall,
  readSupervisorConfig,
  requestSupervisorAction,
  supervisorPaths,
  supervisorStatus,
  uninstallSupervisor,
  writeRollbackRequest,
} from './lib/supervisor.js'
import { classifyStartup } from './lib/startup-mode.js'
import { detectHostKind } from './lib/host-kind.js'
import { planAutostartAdvice } from './lib/autostart-advice.js'
import { buildDiagnostics, ISSUE_URL_BASE, SUPPORT_EMAIL } from './lib/diagnostics.js'
import { countBlockerTasks } from './lib/blockers.js'
import {
  buildDryRunPlan,
  composeRestartFragment,
  deriveStartCommand,
  detectContainer,
  detectExternalSupervisor,
  inspectExternalSupervisor,
  pickFreePort,
} from './lib/supervisor-config.js'
import {
  buildRestartVerdict,
  buildSnapshotRecord,
  decideBootCertification,
  decideProbeCertification,
  evaluateRestartChecks,
  localIsoTime,
  readRestartVerdict,
  RESTART_RESULTS,
  shortFingerprint,
  summarizeRestartVerdict,
  writeRestartVerdict,
} from './lib/restart-verdict.js'
import { waitForHealthyInstance } from './lib/health.js'
import { findPluginFailures, mergeFailuresByPlugin } from './lib/plugin-failure.js'
import { inventory as pluginInventory, pluginDetail as pluginInventoryDetail, comparePlugin, PLUGIN_STATUS } from './lib/plugin-compare.js'
import {
  applyPluginRecovery,
  buildRecoveryReport,
  detectPluginRecovery,
  findLatestStartupLog,
  markHandled,
  planPluginRecovery,
  readRecoveryReport,
  readRecoveryState,
  readRestoreHistory,
  recordAttempt,
  resetRecoveryCycle,
  restoreOnePlugin,
  summarizeRecoveryReport,
  summarizeRestoreHistory,
  writeRecoveryReport,
  writeRecoveryState,
} from './lib/plugin-recover.js'
import {
  buildCustomCommand,
  buildWatchScript,
  confirmWatcherAlive,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_ROLLBACK_COPY_TIMEOUT_MS,
  DEFAULT_ROLLBACK_TIMEOUT_MS,
  detectEnvironment,
  isProcessAlive,
  launchDetachedWatcher,
  readProcessChain,
  runCommandNow,
  scheduleDetachedRestart,
  sweepLegacyWatcherScripts,
  writeTextFileAtomic,
} from './lib/restart.js'
import { compareSemver } from './lib/semver.js'
import { buildCookieClearCommand, readCookieClearReport, summarizeCookieClear } from './lib/cookie-clear.js'
import { cleanupLegacyWatchdogArtifacts } from './lib/legacy-cleanup.js'
import { isWorkSessionEvent } from './lib/activity.js'
import {
  createQueuedTracker,
  DEFAULT_QUEUED_GRACE_MS,
  normalizeQueuedGraceMs,
} from './lib/queued.js'
import {
  createSleepController,
  COUNTDOWN_CHOICES,
  DEFAULT_COUNTDOWN_SECONDS,
  detectShutdownPlan,
  planInvocation,
  runShutdown,
  snapCountdownChoice,
} from './lib/sleep.js'

/**
 * THE PLUGIN DIRECTORY — where this very file lives.
 *
 * The rescue scripts (restore-profile.cmd, emergency-disable.cmd) sit next to
 * it. The settings page shows the user that REAL path, so the path is taken
 * from here and never guessed: nothing assumes `node_modules/dsh-autorestart`
 * and nothing assumes a profile layout.
 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The RESTART reserve: how long the host waits after the LAST conversation
 * finished before it is really restarted.
 *
 * This plugin can only see the DSH agents. Other plugins (a memory plugin
 * that writes its notes a few seconds after the conversation ended, a summary,
 * an MCP callback) queue their work with a timer of their own — work that is
 * invisible here. A short, configurable reserve window is left for it.
 *
 * The reserve belongs to the RESTART only: a restart is a daily operation, so
 * it should happen as soon as the conversations are done. Default: none.
 *
 * The graceful shutdown has NO reserve of its own: it has a VISIBLE countdown
 * (`sleepCountdownSeconds`), and that countdown IS the wait before the
 * machine goes off. A second, invisible window next to it would only say the
 * same thing twice — so there is none.
 *
 * The values are the ones the settings page offers (in milliseconds).
 */
const GRACE_CHOICES_MS = Object.freeze([0, 5000, 10000, 20000, 30000, 60000])

/** The RESTART reserve that is used when nothing was configured. */
const DEFAULT_RESTART_GRACE_MS = 0

/**
 * How often the "the restart is waiting for a long time" line may be logged.
 *
 * The restart gate polls every few seconds, so an unthrottled line would
 * flood the log with the same sentence. Once a minute is enough to say that
 * the wait is still going on.
 */
const LONG_WAIT_LOG_INTERVAL_MS = 60000
/**
 * HOW LONG A QUEUED RESTART MAY GO UNMENTIONED (user decision, 2026-11-02:
 * "this is a silent failure, and last time I could not even find out why").
 *
 * Past this, every tick logs ONE line naming the gate decision, the sessions
 * that still hold the restart and what keeps resetting the quiet window - at
 * most once a minute per request, so a 3 s poll does not flood the log. Silence
 * is what cost the user two rounds last time; a repeated line is the lesser
 * evil, and the interval keeps it readable.
 */
const RESTART_QUEUE_SILENCE_MS = 60000
/** At most one queue diagnostic per minute per request (see `queueDiagLog`). */
const RESTART_QUEUE_DIAG_INTERVAL_MS = 60000

/**
 * The marker the plugin writes when it has decided the restart ITSELF.
 *
 * The rollback watcher is the fallback for the case that the plugin dies
 * with the host (a hosted restart kills the very process the plugin runs in).
 * When the plugin survives the restart command, it decides alone — and writes
 * this marker, so the watcher stands down instead of rolling back a restart
 * that was fine.
 */
const RESTART_OUTCOME_FILE = 'restart-outcome.json'

/**
 * The name of the rollback report of a restart that the plugin decided itself.
 *
 * It is the same file the detached watcher writes (`last-rollback.json`), so
 * the interface shows the rollback either way.
 */
const RESTART_REPORT_NAME = ROLLBACK_REPORT_NAME

/**
 * Resolve the connection service of the host, when it provides one.
 *
 * The connection service signs the access URL of the running host (the boot
 * token). It is optional: a host without it still gets the plain origin.
 *
 * @param {any} ctx
 * @returns {any|null}
 */
function resolveConnectionService(ctx) {
  try {
    if (ctx && ctx.connection && typeof ctx.connection.authenticatedUrl === 'function') return ctx.connection
  } catch {}
  try {
    if (ctx && typeof ctx.get === 'function') {
      const service = ctx.get('connection')
      if (service && typeof service.authenticatedUrl === 'function') return service
    }
  } catch {}
  return null
}

/**
 * The access link of the running instance, or null.
 *
 * @param {any} runtime
 * @returns {string|null}
 */
function accessUrlOf(runtime) {
  try {
    const record = runtime.accessRecord
    if (record && typeof record.url === 'string' && record.url !== '') return record.url
  } catch {}
  return null
}

/**
 * Publish the instance record of the running host.
 *
 * The record carries three things that nobody else knows:
 *
 *   - the PORT this instance listens on (the desktop app uses a random one,
 *     so the port of the previous instance is worthless);
 *   - the BOOT ID of this instance, so a watcher can tell "the new instance"
 *     from "the old one";
 *   - the ACCESS LINK with the boot token, so the user finds the working link
 *     after a restart instead of being locked out by a 401.
 *
 * The file is written with the mode 0600: it holds a secret.
 *
 * @param {any} ctx the plugin context
 * @param {any} runtime the runtime of this plugin
 * @param {object} config the normalized config
 * @param {string} origin the origin of the web server (`protocol//host:port`)
 * @returns {{ ok: boolean, path: string|null, url: string|null, error: string|null }}
 */
function publishInstanceRecord(ctx, runtime, config, origin) {
  const stateDir = path.dirname(runtime.stateFile)
  try {
    const { url, token } = resolveAccessUrl({
      origin,
      connection: resolveConnectionService(ctx),
    })
    const written = writeAccessRecord({
      stateDir,
      bootId: runtime.bootId,
      pid: process.pid,
      port: runtime.webPort,
      url,
      token,
    })
    if (!written.ok) {
      runtime.log.warn('could not publish the instance record:', written.error)
      return { ok: false, path: written.path, url, error: written.error }
    }
    runtime.log.info('the instance record was published', {
      path: written.path,
      port: runtime.webPort,
      // The token itself is a secret: the record carries it, the log only
      // says that there is one.
      hasToken: Boolean(token),
    })
    return { ok: true, path: written.path, url, error: null }
  } catch (error) {
    runtime.log.warn('could not publish the instance record:', String(error))
    return { ok: false, path: null, url: null, error: String(error) }
  }
}

/**
 * Snap a reserve value onto the nearest offered choice.
 *
 * A profile that carries a value that is not offered (a hand-edited row, an
 * older build) must not break the boot: the value is snapped onto the
 * nearest choice, exactly like the countdown length is.
 *
 * @param {unknown} value
 * @param {number} [fallback] the value used when the input is not a number
 * @returns {number} one of {@link GRACE_CHOICES_MS}
 */
function snapGraceChoice(value, fallback = DEFAULT_RESTART_GRACE_MS) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw < 0) return fallback
  let best = GRACE_CHOICES_MS[0]
  let bestDistance = Math.abs(raw - best)
  for (const choice of GRACE_CHOICES_MS) {
    const distance = Math.abs(raw - choice)
    if (distance < bestDistance) {
      best = choice
      bestDistance = distance
    }
  }
  return best
}

/**
 * The version of this plugin, as a fallback.
 *
 * The real version is read from the plugin's own package.json (see
 * `pluginVersion()`), but a bundled installation may not ship that file — so
 * the constant below is the last resort. A test keeps the two in sync.
 */
const PLUGIN_VERSION_FALLBACK = '0.9.1'

/**
 * The version of the graceful-shutdown FEATURE, not the version of the package.
 *
 * The one-time announcement is bound to this constant. It used to follow the
 * version in package.json, and that made every release resurrect the card the
 * user had already answered (0.5.0 -> 0.6.1 brought "收工关机" back). A release
 * is not news about the feature, so the two are decoupled.
 *
 * WHEN TO RAISE IT: only when the feature itself changed so much that the
 * user has to hear about it again (the shutdown became a completely different
 * thing, the button moved to another place, ...). Any new value works: the
 * recorded version no longer matches, so the announcement is shown once more.
 *
 * WHEN NOT TO RAISE IT: a release, a bug fix, a small addition, a new option
 * that the documentation explains. None of those deserve a card that
 * interrupts the user a second time.
 */
const SLEEP_FEATURE_VERSION = '0.5.0'

/**
 * The version of the self-starting supervisor ("开机自启守护").
 *
 * The one-time question about it is bound to this version: a release never
 * brings an answered question back.
 */
const SUPERVISOR_FEATURE_VERSION = '0.7.0'

/** The cached version of this plugin (read once per process). */
let pluginVersionCache = null

/**
 * The version of this plugin (the PACKAGE version).
 *
 * It says which release is installed - not what the user has been told about.
 * The feature announcements are bound to `SLEEP_FEATURE_VERSION`, so a release
 * never brings an answered announcement back.
 *
 * @returns {string}
 */
function pluginVersion() {
  if (pluginVersionCache !== null) return pluginVersionCache
  let version = PLUGIN_VERSION_FALLBACK
  try {
    const raw = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.version === 'string' && parsed.version.trim() !== '') {
      version = parsed.version.trim()
    }
  } catch {
    // The package.json is not readable (a bundled build): the fallback is the
    // version that was shipped with this build.
  }
  pluginVersionCache = version
  return version
}

/**
 * The features that are announced ONCE, after an upgrade.
 *
 * The install prompt only ever reaches a fresh installation, so an
 * installation that already existed would never learn about a new feature.
 * Every entry of this list is therefore announced once per FEATURE version:
 * the announcement is shown until the user presses "知道了", and the Host
 * records the feature version it has shown, so it never comes back.
 *
 * The version of an entry is the version of the FEATURE, never the version of
 * the package - see `SLEEP_FEATURE_VERSION`.
 *
 * @returns {{ feature: string, version: string }[]}
 */
function featureAnnouncements() {
  return [
    // The graceful shutdown ("收工关机") and its moon button.
    { feature: 'sleep', version: SLEEP_FEATURE_VERSION },
    // The self-starting supervisor ("开机自启守护").
    { feature: 'supervisor', version: SUPERVISOR_FEATURE_VERSION },
  ]
}

/**
 * Whether the user has already seen the announcement of one feature.
 *
 * The record is the version that was announced when the user answered. It
 * counts as seen as soon as it is NOT OLDER than the current feature version
 * - not only when it is exactly that version:
 *
 *   - the announcement used to carry the version of the PACKAGE, so a user
 *     who answered it on the release 0.6.1 recorded "0.6.1" while the feature
 *     itself stands at "0.5.0". With an equality check that record would
 *     look stale, and the very same card would be shown to a user who already
 *     dismissed it;
 *   - a record that is not a version at all counts as seen as well: a broken
 *     record must not make the card come back for ever.
 *
 * A missing record counts as NOT seen: a missing record must never swallow an
 * announcement.
 *
 * @param {unknown} recorded the version in the state file
 * @param {string} current the current feature version
 * @returns {boolean} true when the user has seen it
 */
function isFeatureSeen(recorded, current) {
  if (typeof recorded !== 'string' || recorded.trim() === '') return false
  const order = compareSemver(recorded, current)
  if (order === null) return true
  return order >= 0
}

/**
 * `@deepseek-ai/schemastery` resolves inside modules that live in the dsh installation,
 * but NOT from this bundle: a profile-installed bundle is a symlink into the user's
 * workspace, so Node resolves bare specifiers against the workspace realpath and never
 * finds the Host's `node_modules`. Load it dynamically, with the running installation
 * as an explicit fallback, so `Config` is still a real schema (and the tests, which run
 * under a plain `node`, still import this module).
 */
let schemastery
let schemasterySource = 'unresolved'
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
  schemasterySource = 'bare-specifier'
} catch {
  schemastery = undefined
}
if (schemastery === undefined) {
  for (const candidate of schemasteryCandidates()) {
    try {
      const loaded = await import(candidate)
      schemastery = loaded.default ?? loaded
      schemasterySource = candidate
      break
    } catch {}
  }
}

/** Absolute file URLs where the running dsh installation keeps schemastery. */
function schemasteryCandidates() {
  const rel = ['dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs']
  const out = []
  const push = (root) => {
    if (typeof root !== 'string' || root.trim() === '') return
    const file = path.join(root, ...rel)
    try {
      out.push(new URL(`file:///${file.replace(/\\/g, '/')}`).href)
    } catch {}
  }
  try {
    if (process.resourcesPath) {
      push(path.join(process.resourcesPath, 'app.asar'))
      push(path.join(process.resourcesPath, 'app.asar.unpacked'))
    }
  } catch {}
  for (const arg of process.argv.slice(1)) {
    if (typeof arg !== 'string') continue
    const index = arg.indexOf('app.asar')
    if (index < 0) continue
    push(arg.slice(0, index + 'app.asar'.length))
  }
  return [...new Set(out)]
}

/** Loader row id for this plugin. */
export const name = 'dsh-autorestart'

/** How many recovery batches (maxSessions sessions each) one boot may run. */
const RECOVERY_MAX_BATCHES = 5

/** Default pause between two recovery batches (ms). */
const DEFAULT_RECOVERY_BATCH_DELAY_MS = 1200

/** How many extra `resolveAgent` attempts one boot makes per session. */
const RESOLVE_RETRY_ATTEMPTS = 2

/** Default pause between two `resolveAgent` attempts (ms). */
const DEFAULT_RESUME_RETRY_DELAY_MS = 1000

/**
 * How long a session-title lookup stays cached (ms).
 *
 * The client polls the health route every 2s; the session list is read at
 * most every 5s so a poll storm never turns into a session-list storm.
 */
const SESSION_TITLE_CACHE_MS = 5000

/** Sleep for `ms`; never rejects. */
function delay(ms) {
  const wait = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  if (wait === 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, wait)
  })
}

/**
 * Hard dependencies. `sessionController` is declared as a dependency because a
 * session that is NOT live in this process can only be resumed through it
 * (`resolveAgent`) or, as a fallback, through `prompt` (which resumes the cold
 * session and admits the message in one step). It is still looked up
 * defensively so a composition that provides it late still resumes.
 */
export const inject = ['agents', 'goals', 'tools', 'timer', 'systemPrompt', 'sessionController']

/**
 * Validated loader row config. Exported so the Plugin Manager / config editor can show
 * the real schema and project defaults; `normalizeConfig` still re-applies the same
 * defaults for direct `apply()` calls in tests.
 *
 * Every key carries a one-sentence description, so the settings page explains what
 * each knob does instead of showing a bare name.
 *
 * Construction is guarded: a wrong/foreign schemastery fallback must never turn a
 * missing schema into a failed plugin activation, and the coarsened `schemasterySource`
 * is reported by the health route instead of an absolute install path.
 */
function buildConfigSchema() {
  if (schemastery === undefined) return undefined
  try {
    return schemastery.object({
      enabled: schemastery.boolean().default(true)
        .description('Master switch: when false the plugin loads but does nothing.'),
      stateFile: schemastery.string().default('')
        .description('Absolute path of the durable checkpoint file; empty means <DSH_HOME>/storages/dsh-autorestart/state.json.'),
      resumeOnBoot: schemastery.boolean().default(true)
        .description('Resume interrupted sessions automatically after the host starts again.'),
      recoveryDelayMs: schemastery.number().min(0).default(6000)
        .description('Milliseconds the plugin waits after boot before it recovers interrupted sessions.'),
      maxSessions: schemastery.number().step(1).min(1).default(4)
        .description('How many interrupted sessions one recovery pass resumes.'),
      maxResumeAttempts: schemastery.number().step(1).min(1).default(2)
        .description('How often a single session is retried before the recovery gives up on it.'),
      deferPollMs: schemastery.number().min(250).default(3000)
        .description('Milliseconds between two restart-gate checks.'),
      // KEPT FOR CONFIGURATION COMPATIBILITY, NO LONGER USED (user decision,
      // 2026-11-02). A pending restart has NO deadline: it waits until every
      // conversation is idle. These two numbers used to announce a "long wait"
      // and then look like an expiry date; both are now ignored, and they stay
      // in the schema only so existing configuration files keep loading.
      deferSoftMs: schemastery.number().min(0).default(300000)
        .description('No longer used: a pending restart has no deadline. Kept so existing configuration files stay valid.'),
      deferHardMs: schemastery.number().min(0).default(900000)
        .description('No longer used: a pending restart has no deadline and never gives up. Kept so existing configuration files stay valid.'),
      deferPolicy: schemastery.union(['auto', 'wait']).default('auto')
        .description('How a pending restart treats a busy conversation: auto waits for it, wait blocks until every conversation is idle.'),
      // forceRestartWhenBusy INTERRUPTS a running conversation — it is not a
      // deadline and must never be described as one (user decision, 2026-11-02).
      forceRestartWhenBusy: schemastery.boolean().default(false)
        .description('Restart even while a conversation is still running: the running conversations are interrupted. Off by default.'),
      restartMode: schemastery.union(['app', 'command']).default('app')
        .description('How the host is restarted: app relaunches the desktop app, command runs restartCommand.'),
      restartCommand: schemastery.string().default('')
        .description('Shell command used when restartMode is "command"; empty means there is no custom command.'),
      relaunchDelaySeconds: schemastery.number().min(0).default(2)
        .description('Seconds between the kill of the old host and the relaunch of the new one.'),
      // quiet window that must pass after the last conversation activity
      settleMs: schemastery.number().min(0).default(2000)
        .description('Milliseconds the host must stay quiet after the last conversation activity before a restart may fire.'),
      // The grace window: the extra wait after the last conversation finished.
      // Other plugins queue work with timers of their own (a memory plugin
      // writing its notes, a summary, an MCP callback) and that work is
      // invisible here — so a short, configurable grace window is left for it.
      // The RESTART reserve: the extra wait after the last conversation
      // finished, before the host is really restarted. A restart is a daily
      // operation, so the default is none (0 / 5 / 10 / 20 / 30 / 60 seconds).
      restartGraceMs: schemastery.number().min(0).default(DEFAULT_RESTART_GRACE_MS)
        .description('Milliseconds to wait after the last conversation finished before the host is really RESTARTED: the reserve for work other plugins queue with a timer (0 / 5 / 10 / 20 / 30 / 60 seconds, default 0 = no extra wait).'),
      // The graceful shutdown has no reserve of its own: the visible countdown
      // (sleepCountdownSeconds) IS the wait before the machine goes off.
      // The upper bound of a QUEUED inbox message: a message that nobody
      // claims within this window is stuck, and it stops blocking the restart.
      // Without it a single unclaimed message kept the restart pending for
      // ever (the "the restart never happens" defect).
      queuedGraceMs: schemastery.number().min(0).default(DEFAULT_QUEUED_GRACE_MS)
        .description('Milliseconds an unclaimed (queued) inbox message may block the restart: a message that is still unclaimed after this window is treated as stuck and no longer blocks the restart (0 = no upper bound, the old behaviour; default 60000).'),
      autoReloadPage: schemastery.boolean().default(true)
        .description('Reload the web page automatically when the host boot token changes.'),
      blockManualRestart: schemastery.boolean().default(true)
        .description('Block shell commands that would kill or relaunch DeepSeek Harness by hand.'),
      healthPath: schemastery.string().default('/__dsh_autorestart/health')
        .description('HTTP path of the read-only health route used by the client UI and by verification scripts.'),
      continuationText: schemastery.string().default('')
        .description('Custom text injected as the continuation message; empty means the built-in notice.'),
      // pause between two recovery batches (each batch resumes maxSessions sessions)
      recoveryBatchDelayMs: schemastery.number().min(0).default(1200)
        .description('Milliseconds between two recovery batches.'),
      // pause between two resolveAgent attempts inside one boot
      resumeRetryDelayMs: schemastery.number().min(0).default(1000)
        .description('Milliseconds between two resolveAgent attempts inside one boot.'),
      // pre-restart snapshot + automatic rollback when the host never comes back
      backupOnRestart: schemastery.boolean().default(true)
        .description('Take a snapshot of the profile configuration before every restart, so you always have a copy to roll back to by hand.'),
      // include the installed plugin tree in the snapshot (bigger, but it makes a
      // rollback of "a plugin upgrade broke the boot" possible)
      backupIncludePlugins: schemastery.boolean().default(true)
        .description('Include the installed plugin tree in that snapshot: about 117 MB and roughly 3 extra seconds, so a broken plugin upgrade can be rolled back by hand as well.'),
      watchEnabled: schemastery.boolean().default(true)
        .description('After boot, record what the loaded plugins provide and compare it with the previous record'),
      watchDelayMs: schemastery.number().step(1).min(0).default(8000)
        .description('How long the watch waits after boot so plugins that load late are not reported as gone'),
      // THE RANGE AND THE DEFAULT COME FROM ONE PLACE (2026-11-02): this line used
      // to say `.min(1)` with a default of 2 while its own description said
      // "default 3", the validator refused anything below 2 and the dropdown
      // offered 2..10 - four numbers, one setting. `BACKUP_LIMIT` in lib/backup.js
      // is the only source now, and a test pins that changing it moves all of them.
      maxBackups: schemastery.number().step(1)
        .min(BACKUP_LIMIT_MIN)
        .max(BACKUP_LIMIT_MAX)
        .default(DEFAULT_MAX_BACKUPS)
        .description('How many snapshots are kept (2 by default, 2 to 10 allowed). Older ones are deleted automatically, except the newest one and the one whose restart record says the instance came up with matching content; the first-install snapshot is kept only while there is room.'),
      rollbackTimeoutMs: schemastery.number().min(1000).default(90000)
        .description('Milliseconds the detached watcher waits for the relaunched host before it restores the snapshot.'),
      // The self-starting supervisor: a separate process that brings the host
      // back when it dies. See the "开机自启" section of the settings.
      supervisorMode: schemastery.union(['auto', 'installed', 'external', 'off']).default('auto')
        .description('Who starts this host: auto = nobody decided yet, installed = the supervisor of this plugin, external = your own way, off = no automatic start.'),
      supervisorKind: schemastery.union([
        schemastery.const(''),
        schemastery.const('windows-schtasks'),
        schemastery.const('windows-startup'),
        schemastery.const('systemd-user'),
        schemastery.const('systemd-system'),
      ]).default('')
        .description('Which form of the self-start record was installed (empty = the default of this platform).'),
      supervisorRestartDelayMs: schemastery.number().min(0).default(3000)
        .description('Milliseconds the supervisor waits before it starts the host again after it died.'),
      supervisorRestartDelayMaxMs: schemastery.number().min(0).default(30000)
        .description('The upper bound of that delay: the supervisor backs off further with every failed start, but never longer than this.'),
      supervisorStartTimeoutMs: schemastery.number().min(1000).default(90000)
        .description('Milliseconds the supervisor waits for the host to answer its health route before it restores the snapshot.'),
      supervisorKillGraceMs: schemastery.number().min(0).default(15000)
        .description('Milliseconds the supervisor waits between asking the host to stop and killing it.'),
      supervisorPort: schemastery.number().min(0).default(0)
        .description('The port the supervisor waits for to become free before it starts the host (0 = the port of the current instance).'),
      supervisorAutoInstall: schemastery.boolean().default(false)
        .description('Whether the one-time question may install the supervisor without asking again.'),
      // graceful shutdown ("收工关机"): wait for every conversation, count down, then
      // switch the REAL host machine off (a WSL host shuts Windows down, not the distro)
      showSleepButton: schemastery.boolean().default(true)
        .description('是否在左侧栏最底部、设置按钮旁边显示「收工关机」按钮：关掉之后界面上不再有这个按钮，关机接口也不再被界面调用。'),
      // The countdown length is a DROPDOWN: a union of the offered choices
      // projects into an enum (the settings page renders a select, not a
      // number field). `loose()` keeps an old profile value from breaking
      // the boot — the value is snapped onto a choice in normalizeConfig.
      sleepCountdownSeconds: schemastery.union(COUNTDOWN_CHOICES.map((value) => schemastery.const(value)))
        .default(DEFAULT_COUNTDOWN_SECONDS)
        .loose()
        .description('收工关机的倒计时秒数（下拉框：0 / 10 / 20 / 30 / 60 秒，默认 20；0 表示不倒数、立即关机，但仍会先等所有会话收工）。'),
      sleepCommand: schemastery.string().default('')
        .description('自定义关机命令：留空表示按系统自动识别（Windows / WSL / Linux / macOS），填了就用这条命令代替自动识别。'),
    })
  } catch (error) {
    schemasterySource = `construction-failed: ${String(error)}`
    return undefined
  }
}

export const Config = buildConfigSchema()

/** Every config key and its default; a partial row config is merged over this. */
const DEFAULTS = {
  enabled: true,
  stateFile: '',
  resumeOnBoot: true,
  recoveryDelayMs: 6000,
  maxSessions: 4,
  maxResumeAttempts: 2,
  deferPollMs: 3000,
  deferSoftMs: 300000,
  deferHardMs: 900000,
  deferPolicy: 'auto',
  // default false: never force a restart over a running conversation
  forceRestartWhenBusy: false,
  restartMode: 'app',
  restartCommand: '',
  relaunchDelaySeconds: 2,
  settleMs: 2000,
  restartGraceMs: DEFAULT_RESTART_GRACE_MS,
  // The upper bound of a queued (unclaimed) inbox message: after this time it
  // is treated as stuck and stops blocking the restart. 0 switches the
  // protection off (the old behaviour: a queued message blocks for ever).
  queuedGraceMs: DEFAULT_QUEUED_GRACE_MS,
  autoReloadPage: true,
  blockManualRestart: true,
  healthPath: '/__dsh_autorestart/health',
  continuationText: '',
  // Pre-restart snapshot + automatic rollback. The plugin copies the profile
  // configuration (and, unless disabled, the installed plugin tree) before every
  // restart; when the relaunched host never answers its health route, the
  // detached watcher puts the snapshot back and launches the host again.
  backupOnRestart: true,
  backupIncludePlugins: true,
  maxBackups: DEFAULT_MAX_BACKUPS,
  // THE PLUGIN WATCH (2026-11-01): after the host has settled, take one reading
  // of what the loaded plugins actually provide (tools, interface modules,
  // registered packages) and compare it with the previous reading. It reports
  // only what is NO LONGER there - a new plugin is not news.
  watchEnabled: true,
  watchDelayMs: 8000,
  rollbackTimeoutMs: 90000,
  // How long the restart command may run before the plugin stops waiting for
  // it, and how long ONE restore step may take before the watcher gives up.
  restartCommandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  rollbackCopyTimeoutMs: DEFAULT_ROLLBACK_COPY_TIMEOUT_MS,
  // The self-starting supervisor.
  supervisorMode: 'auto',
  supervisorKind: '',
  supervisorRestartDelayMs: 3000,
  supervisorRestartDelayMaxMs: 30000,
  supervisorStartTimeoutMs: 90000,
  supervisorKillGraceMs: 15000,
  supervisorPort: 0,
  supervisorAutoInstall: false,
  // Graceful shutdown ("收工关机"): the button at the foot of the left sidebar,
  // the countdown before the machine is switched off and the optional custom
  // shutdown command (empty = the host is detected automatically).
  showSleepButton: true,
  sleepCountdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
  sleepCommand: '',
}

/** Merge a loader row config over {@link DEFAULTS}, dropping wrong-typed values. */
function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return config
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === typeof DEFAULTS[key]) config[key] = value
  }
  // Optional recovery knobs: they are not part of the published default set,
  // so they only appear when the row config sets them.
  for (const key of ['recoveryBatchDelayMs', 'resumeRetryDelayMs']) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) config[key] = value
  }
  if (config.deferPolicy !== 'auto' && config.deferPolicy !== 'wait') config.deferPolicy = 'auto'
  if (config.restartMode !== 'app' && config.restartMode !== 'command') config.restartMode = 'app'
  const watchDelay = Number(config.watchDelayMs)
  config.watchDelayMs = Number.isFinite(watchDelay) && watchDelay >= 0 ? Math.trunc(watchDelay) : 8000
  const maxBackups = Number(config.maxBackups)
  config.maxBackups = Number.isFinite(maxBackups) && maxBackups >= 1 ? Math.trunc(maxBackups) : DEFAULT_MAX_BACKUPS
  const rollbackTimeout = Number(config.rollbackTimeoutMs)
  config.rollbackTimeoutMs =
    Number.isFinite(rollbackTimeout) && rollbackTimeout >= 1000 ? Math.trunc(rollbackTimeout) : 90000
  // How long the restart command may run, and how long ONE restore step may
  // take. Both are bounded, so neither a hung command nor a hung `robocopy`
  // can hold the restart for ever.
  const commandTimeout = Number(config.restartCommandTimeoutMs)
  config.restartCommandTimeoutMs =
    Number.isFinite(commandTimeout) && commandTimeout >= 1000 ? Math.trunc(commandTimeout) : DEFAULT_COMMAND_TIMEOUT_MS
  const copyTimeout = Number(config.rollbackCopyTimeoutMs)
  config.rollbackCopyTimeoutMs =
    Number.isFinite(copyTimeout) && copyTimeout >= 1000 ? Math.trunc(copyTimeout) : DEFAULT_ROLLBACK_COPY_TIMEOUT_MS
  // The supervisor knobs: a wrong value must not break the boot, it falls back
  // to the documented default.
  if (!['auto', 'installed', 'external', 'off'].includes(config.supervisorMode)) config.supervisorMode = 'auto'
  if (!['', 'windows-schtasks', 'windows-startup', 'systemd-user', 'systemd-system'].includes(config.supervisorKind)) {
    config.supervisorKind = ''
  }
  const supervisorDelay = Number(config.supervisorRestartDelayMs)
  config.supervisorRestartDelayMs = Number.isFinite(supervisorDelay) && supervisorDelay >= 0 ? Math.trunc(supervisorDelay) : 3000
  const supervisorDelayMax = Number(config.supervisorRestartDelayMaxMs)
  config.supervisorRestartDelayMaxMs =
    Number.isFinite(supervisorDelayMax) && supervisorDelayMax >= 0 ? Math.trunc(supervisorDelayMax) : 30000
  const supervisorStartTimeout = Number(config.supervisorStartTimeoutMs)
  config.supervisorStartTimeoutMs =
    Number.isFinite(supervisorStartTimeout) && supervisorStartTimeout >= 1000 ? Math.trunc(supervisorStartTimeout) : 90000
  const supervisorKillGrace = Number(config.supervisorKillGraceMs)
  config.supervisorKillGraceMs =
    Number.isFinite(supervisorKillGrace) && supervisorKillGrace >= 0 ? Math.trunc(supervisorKillGrace) : 15000
  const supervisorPort = Number(config.supervisorPort)
  config.supervisorPort = Number.isFinite(supervisorPort) && supervisorPort >= 0 ? Math.trunc(supervisorPort) : 0
  if (typeof config.supervisorAutoInstall !== 'boolean') config.supervisorAutoInstall = false
  // The countdown of the graceful shutdown is one of the offered choices: a
  // profile that still carries an old value (15, 45, …) is snapped onto the
  // nearest one instead of breaking, and 0 means "no countdown at all".
  config.sleepCountdownSeconds = snapCountdownChoice(config.sleepCountdownSeconds)
  // The restart reserve is one of the offered choices as well: a hand-edited
  // profile value is snapped onto the nearest one instead of breaking.
  config.restartGraceMs = snapGraceChoice(config.restartGraceMs, DEFAULT_RESTART_GRACE_MS)
  // The upper bound of a queued message is a plain number: a wrong or negative
  // value falls back to the default, and 0 switches the protection off.
  config.queuedGraceMs = normalizeQueuedGraceMs(config.queuedGraceMs)
  if (typeof config.sleepCommand !== 'string') config.sleepCommand = ''
  if (typeof config.showSleepButton !== 'boolean') config.showSleepButton = true
  return config
}

/** Resolve the health-route path (shared by the route and the restart gate URL). */
function resolveHealthPath(config) {
  return typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : '/__dsh_autorestart/health'
}

/**
 * Resolve the park-route path: a sibling of the health route, under the same
 * prefix (the health path without its last segment).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveParkPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/park`
}

/**
 * Resolve the recovery-route path: a sibling of the health route, under the same
 * prefix (`POST /recover` retries the boot recovery for the pending sessions).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveRecoverPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/recover`
}

/**
 * Resolve the handoff-route path: a sibling of the health route, under the same
 * prefix (`POST /handoff` hands an over-limit session off to a fresh session).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveHandoffPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/handoff`
}

/**
 * Resolve the manual-rollback route path: a sibling of the health route, under
 * the same prefix (`POST /rollback-to` restores ONE backup the user picked).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveManualRollbackPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/rollback-to`
}

/**
 * Resolve the single-plugin restore path: a sibling of the health route, under
 * the same prefix (`POST /plugin-restore` puts ONE failed plugin back from the
 * last known-good backup — the button in the popup).
 *
 * @param {object} config
 * @returns {string}
 */
function resolvePluginRestorePath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/plugin-restore`
}

/**
 * The read-only inventory route: `GET <prefix>/plugin-inventory`.
 *
 * Same prefix as the health and restore routes, so the browser has one base to
 * remember. It writes nothing — the settings page reads it, the human decides,
 * and `POST <prefix>/plugin-restore` performs the one write.
 *
 * @param {object} config
 * @returns {string}
 */
const PLUGIN_WATCH_FILE = 'plugin-watch.json'

function resolvePluginWatchPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return prefix + '/plugin-watch'
}

function readPluginWatchReport(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, PLUGIN_WATCH_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * ONE READING: compare what is visible now with the previous reading, then
 * OVERWRITE it. Only one history entry is kept on purpose - this is a
 * "what changed since last boot" question, not a time series.
 *
 * Returns the comparison, or null when the watch is switched off.
 * Never throws: this runs on the boot path.
 */
function runPluginWatchOnce(ctx, runtime, config) {
  try {
    if (config.watchEnabled !== true) return null
    const stateDir = resolveStateDir(config)
    const previous = readPluginWatchReport(stateDir)
    // Every service is handed over as it is; the collector turns a missing one
    // into null for THAT layer only, so one absent service never hides the rest.
    const current = collectCapabilities(ctx, { now: Date.now() })
    const comparison = compareCapabilities(previous, current)
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(
        path.join(stateDir, PLUGIN_WATCH_FILE),
        JSON.stringify({ ...current, comparison, disappeared: listDisappearances(comparison) }),
        'utf8',
      )
    } catch (error) {
      runtime.log.warn('the plugin watch could not save its reading:', String(error))
    }
    return comparison
  } catch (error) {
    // The watch is a convenience; it must never take the plugin down with it.
    try {
      runtime.log.warn('the plugin watch failed to run:', String(error))
    } catch {}
    return null
  }
}

/**
 * Run the watch once, LATE. Plugins load in an arbitrary order, so reading
 * immediately would report "not loaded yet" as "disappeared".
 *
 * The timer is unref'ed: without that the process cannot exit while it waits,
 * which would hang the host and every test run.
 */
function schedulePluginWatch(ctx, runtime, config) {
  try {
    if (config.watchEnabled !== true) return null
    const delay = Number(config.watchDelayMs)
    const waitMs = Number.isFinite(delay) && delay >= 0 ? Math.trunc(delay) : 8000
    const timer = setTimeout(() => { runPluginWatchOnce(ctx, runtime, config) }, waitMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  } catch (error) {
    try {
      runtime.log.warn('the plugin watch could not be scheduled:', String(error))
    } catch {}
    return null
  }
}

/**
 * GET <prefix>/plugin-watch - the last reading, as plain facts.
 *
 * The payload describes WHAT IS NO LONGER VISIBLE. It never says a plugin is
 * broken or that something failed: this layer cannot know that, and saying it
 * would be a guess dressed up as a finding.
 */
function buildPluginWatchRoute(ctx, runtime, config) {
  const routePath = resolvePluginWatchPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      if (req && req.method && req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'GET')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      try {
        if (config.watchEnabled !== true) {
          answer({ ok: true, available: false, reason: 'watch-disabled' })
          return
        }
        const saved = readPluginWatchReport(resolveStateDir(config))
        if (saved === null || !Number.isFinite(Number(saved.at))) {
          answer({ ok: true, available: false, reason: 'no-reading-yet' })
          return
        }
        const comparison = saved.comparison !== null && typeof saved.comparison === 'object'
          ? saved.comparison
          : { at: Number(saved.at), layers: {}, removedTotal: 0, hasDisappearances: false }
        answer({
          ok: true,
          available: true,
          at: Number(saved.at),
          atLocal: new Date(Number(saved.at)).toISOString(),
          layers: comparison.layers !== null && typeof comparison.layers === 'object' ? comparison.layers : {},
          disappeared: Array.isArray(saved.disappeared) ? saved.disappeared : [],
          removedTotal: Number.isFinite(Number(comparison.removedTotal)) ? Number(comparison.removedTotal) : 0,
          hasDisappearances: comparison.hasDisappearances === true,
        })
      } catch (error) {
        answer({ ok: true, available: false, reason: 'unreadable' })
      }
    },
  }
}

function resolvePluginInventoryPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/plugin-inventory`
}

/**
 * The answer of one restore attempt, in the wire shape the popup reads.
 *
 * Every failure is an HTTP 200 with `ok:false` and a `reason`: "no backup for
 * this plugin" is an ANSWER, not a server error, and a browser that gets a 500
 * cannot tell it apart from a crashed host.
 *
 * @param {object} result
 * @returns {object}
 */
export function pluginRestorePayload(result) {
  const source = result && typeof result === 'object' ? result : {}
  return {
    ok: source.ok === true,
    plugin: typeof source.plugin === 'string' ? source.plugin : null,
    mode: typeof source.mode === 'string' ? source.mode : null,
    restoredFrom: typeof source.restoredFrom === 'string' ? source.restoredFrom : null,
    restoredAt: Number.isFinite(Number(source.restoredAt)) ? Math.trunc(Number(source.restoredAt)) : null,
    backupKind: typeof source.backupKind === 'string' ? source.backupKind : null,
    needsRestart: source.needsRestart === true,
    changed: source.changed === true,
    evidence: source.evidence && typeof source.evidence === 'object'
      ? {
        renamedFrom: typeof source.evidence.renamedFrom === 'string' ? source.evidence.renamedFrom : null,
        renamedTo: typeof source.evidence.renamedTo === 'string' ? source.evidence.renamedTo : null,
      }
      : null,
    at: Number.isFinite(Number(source.at)) ? Math.trunc(Number(source.at)) : null,
    atIso: typeof source.atIso === 'string' ? source.atIso : null,
    reason: typeof source.reason === 'string' ? source.reason : '',
  }
}

/**
 * Resolve the choice-route path: a sibling of the health route, under the same
 * prefix (`POST /choice` persists the one-time install choice of the user).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveChoicePath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/choice`
}

/**
 * Resolve the backup-limit-route path: a sibling of the health route, under the
 * same prefix (`POST /backup-limit` writes the "how many copies to keep" answer
 * and applies it immediately).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveBackupLimitPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/backup-limit`
}

/**
 * Resolve the supervisor-route path: a sibling of the health route, under the
 * same prefix (`POST /supervisor` installs, uninstalls and reports the
 * self-starting supervisor).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveSupervisorPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/supervisor`
}

/**
 * Resolve the sleep-route path: a sibling of the health route, under the same
 * prefix (`GET /sleep` reports the state of the graceful sleep, `POST /sleep`
 * arms or cancels it).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveSleepPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/sleep`
}

/**
 * Resolve the cancel-route path: a sibling of the health route, under the same
 * prefix (`POST /cancel` withdraws ONE session's own restart request).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveCancelPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/cancel`
}

/**
 * Resolve the announcements-route path: a sibling of the health route, under
 * the same prefix (`GET /announcements` reports the feature announcements the
 * user has not seen yet, `POST /announcements` records that it saw one).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveAnnouncementsPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/announcements`
}

/**
 * The blocking sessions with the reason each one blocks: a session that is
 * held by an armed goal reports `goal-active` (that goal can be disarmed), a
 * goal whose round budget is spent reports `goal-exhausted`, and the original
 * busy reason is kept as `busyReason`.
 *
 * Never throws: a goal lookup must never break a status report.
 *
 * @param {object} runtime
 * @param {any} blockedBy
 * @returns {any[]}
 */
function goalAwareBlockingDetails(runtime, blockedBy) {
  const list = Array.isArray(blockedBy) ? blockedBy : []
  const reasons = new Map()
  try {
    const { disarms, reported } = selectGoalDisarms(list, {
      getGoal: (sessionId) => runtime.goalFor(sessionId),
      disarmedGoals: runtime.disarmedGoalRecords(),
      parkedGoals: runtime.parkedGoalRecords(),
    })
    for (const item of disarms) reasons.set(item.sessionId, GOAL_BLOCK_REASONS.ACTIVE)
    for (const item of reported) reasons.set(item.sessionId, item.reason)
  } catch {
    // A goal lookup must never break the status report.
  }
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const reason = reasons.get(entry.sessionId)
    if (!reason) return entry
    return { ...entry, busyReason: entry.reason, reason }
  })
}

/**
 * The goal records this plugin keeps, in both shapes: the current disarmed-goal
 * records (`goalId` / `disarmedAt` / `resumedAt`, written by
 * `ctx.goals.disarm`) and the LEGACY parked-goal records written by the
 * previous pause-based build (`goalId` / `parkedAt` / `resumedAt`).
 *
 * The status field is still called `parkedGoals` so an older client keeps
 * working; `kind` tells the two shapes apart.
 *
 * @param {object} runtime
 * @returns {{sessionId: string, kind: 'disarmed'|'parked', goalId: string|null, disarmedAt: number|null, parkedAt: number|null, resumedAt: number|null, resumed: boolean}[]}
 */
function parkedGoalList(runtime) {
  const out = []
  const collect = (records, kind, atKey) => {
    for (const [sessionId, record] of Object.entries(records || {})) {
      if (!record || typeof record !== 'object') continue
      out.push({
        sessionId,
        kind,
        goalId: record.goalId != null ? String(record.goalId) : null,
        disarmedAt: kind === 'disarmed' && Number.isFinite(record.disarmedAt) ? record.disarmedAt : null,
        parkedAt: kind === 'parked' && Number.isFinite(record[atKey]) ? record[atKey] : null,
        resumedAt: record.resumedAt != null ? record.resumedAt : null,
        resumed: record.resumedAt != null,
      })
    }
  }
  collect(runtime.disarmedGoalRecords(), 'disarmed', 'disarmedAt')
  collect(runtime.parkedGoalRecords(), 'parked', 'parkedAt')
  return out
}

/**
 * The self-reported outcome of the last recovery attempt, per session, plus the
 * sessions that can still be recovered. Used by `continuum_status` and by the
 * `?state=1` route so a stuck recovery is visible without reading the log.
 *
 * @param {object} state
 * @returns {{sessionId: string, action: string|null, detail: string|null, pending: boolean, attempts: number, error: string|null}[]}
 */
function recoveryList(state) {
  const out = []
  try {
    const sessions = state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
      ? state.sessions
      : {}
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.lastRecoveryAction == null && entry.pendingResume !== true) continue
      out.push({
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId,
        action: entry.lastRecoveryAction != null ? String(entry.lastRecoveryAction) : null,
        detail: entry.lastRecoveryDetail != null ? String(entry.lastRecoveryDetail) : null,
        pending: entry.pendingResume === true,
        attempts: Number.isFinite(entry.resumeAttempts) ? entry.resumeAttempts : 0,
        error: entry.lastResumeError != null ? String(entry.lastResumeError) : null,
      })
    }
  } catch {}
  return out
}

/**
 * The per-session handoff / context-overflow diagnostics of the checkpoint.
 *
 * Both records are the durable "this session outgrew the model window" markers:
 * a handed-off session was replaced by a fresh one, an over-limit session is
 * refused by the automatic resume path. `recoverableSessions` skips both, so the
 * status has to report them from the raw entries or they would be invisible.
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {{sessionId: string, handedOffTo: string|null, handoffAt: number|null, carriedChars: number|null, handedOff: boolean, overContextLimit: boolean, contextOverflow: object|null, lastRecoveryAction: string|null, lastRecoveryDetail: string|null}[]}
 */
function diagnosticSessions(state, { limit = 50 } = {}) {
  const out = []
  try {
    const sessions = state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
      ? state.sessions
      : {}
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== 'object') continue
      const handoff = entry.handoff && typeof entry.handoff === 'object' ? entry.handoff : null
      const overflow = entry.contextOverflow && typeof entry.contextOverflow === 'object'
        && entry.contextOverflow.over === true
        ? entry.contextOverflow
        : null
      if (handoff === null && overflow === null) continue
      out.push({
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId,
        handedOff: handoff !== null,
        handedOffTo: handoff && typeof handoff.handedOffTo === 'string' ? handoff.handedOffTo : null,
        handoffAt: handoff && Number.isFinite(handoff.handoffAt) ? handoff.handoffAt : null,
        carriedChars: handoff && Number.isFinite(handoff.carriedChars) ? handoff.carriedChars : null,
        overContextLimit: overflow !== null,
        contextOverflow: overflow === null ? null : {
          inputTokens: Number.isFinite(overflow.inputTokens) ? overflow.inputTokens : null,
          contextWindow: Number.isFinite(overflow.contextWindow) ? overflow.contextWindow : null,
          detail: typeof overflow.detail === 'string' ? overflow.detail : null,
          detectedAt: Number.isFinite(overflow.detectedAt) ? overflow.detectedAt : null,
        },
        lastRecoveryAction: entry.lastRecoveryAction != null ? String(entry.lastRecoveryAction) : null,
        lastRecoveryDetail: entry.lastRecoveryDetail != null ? String(entry.lastRecoveryDetail) : null,
      })
      if (out.length >= limit) break
    }
  } catch {}
  return out
}

/** Resolve the durable checkpoint path. */
function resolveStateFile(config) {
  if (typeof config.stateFile === 'string' && config.stateFile.trim() !== '') {
    return path.resolve(config.stateFile)
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const resolved = path.join(home, 'storages', 'dsh-autorestart', 'state.json')
  assertNotTheRealUserStateFileUnderTest(resolved)
  return resolved
}

/**
 * REFUSE TO LET A TEST RUN WRITE INTO THE REAL USER STATE DIRECTORY (2026-11-03).
 *
 * A test that forgot to pass `stateFile` fell through to the default above and wrote
 * the machine's own `access.json` / `watchdog-ready.json` - with the test's fake port
 * (1234) in them. The watchdog reads that port to decide whether the host is alive, so
 * a test run could leave it probing a port that does not exist. Same class of accident
 * as the desktop shortcut one (`isInsideTempDir` in lib/rescue-paths.js).
 *
 * This is LOUD on purpose: a silent skip would hide the missing `stateFile` for ever.
 *
 * @param {string} resolved the state file the default rules produced
 */
function assertNotTheRealUserStateFileUnderTest(resolved) {
  if (!process.env.NODE_TEST_CONTEXT) return
  // READ ONCE AT MODULE LOAD, NOT NOW: a test is allowed to redirect the home
  // directory (`USERPROFILE` / `HOME`) to imitate another machine, and reading that
  // redirect here would move BOTH sides of the comparison to the test's own fake
  // home - the guard would then fire on a harmless write. The value below is
  // captured when this module is imported, before any test body can change it.
  const homedir = REAL_USER_HOME_AT_LOAD
  if (homedir === '') return
  const real = path.join(homedir, '.dsh', 'storages', 'dsh-autorestart', 'state.json')
  const normal = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  if (normal(resolved) !== normal(real)) return
  throw new Error(
    'refusing to use the REAL user state directory while running tests: '
    + real
    + ' - pass an explicit stateFile (a temporary directory) instead. '
    + 'Writing here would overwrite the user\'s access.json / watchdog-ready.json '
    + 'with the fake port a test uses, and the watchdog would then probe the wrong port.',
  )
}

/** The real user home as it was when this module loaded (see the guard above). */
const REAL_USER_HOME_AT_LOAD = (() => {
  try {
    return typeof os.homedir === 'function' ? os.homedir() : ''
  } catch {
    return ''
  }
})()

/**
 * The directory the plugin owns its durable state in.
 *
 * It is the directory of the checkpoint file, so a custom `stateFile` moves the
 * whole state directory with it (the backups live next to it as well).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveStateDir(config) {
  return path.dirname(resolveStateFile(config))
}

/**
 * The file the DEGRADED choice path writes to.
 *
 * It is only used when the official `configEditor` service is unavailable: the
 * profile configuration stays the single source of truth, and this file is the
 * last-resort record of a choice the Host could not persist yet.
 */
const INSTALL_CHOICE_FILE = 'install-choice.json'

/**
 * Read the recorded install choice from the fallback file.
 *
 * @param {string} stateDir
 * @returns {{ includePlugins: boolean|null, backupOnRestart: boolean|null, showSleepButton: boolean|null, sleepCountdownSeconds: number|null, restartGraceMs: number|null }|null}
 */
function readInstallChoice(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, INSTALL_CHOICE_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      includePlugins: typeof parsed.includePlugins === 'boolean' ? parsed.includePlugins : null,
      backupOnRestart: typeof parsed.backupOnRestart === 'boolean' ? parsed.backupOnRestart : null,
      showSleepButton: typeof parsed.showSleepButton === 'boolean' ? parsed.showSleepButton : null,
      sleepCountdownSeconds: typeof parsed.sleepCountdownSeconds === 'number'
        ? parsed.sleepCountdownSeconds
        : null,
      restartGraceMs: typeof parsed.restartGraceMs === 'number' ? parsed.restartGraceMs : null,
      askedForPluginVersion: typeof parsed.askedForPluginVersion === 'string'
        ? parsed.askedForPluginVersion
        : null,
    }
  } catch {
    return null
  }
}

/**
 * Write the install choice into the fallback file.
 *
 * The file is written ADDITIVELY: a choice about the sleep button must not
 * erase the recorded backup scope (and the other way round).
 *
 * @param {string} stateDir
 * @param {{ includePlugins?: boolean, backupOnRestart?: boolean, showSleepButton?: boolean, sleepCountdownSeconds?: number, restartGraceMs?: number }} values
 * @returns {string} the file that was written
 */
function writeInstallChoice(stateDir, values) {
  const file = path.join(stateDir, INSTALL_CHOICE_FILE)
  const current = readInstallChoice(stateDir) || {
    includePlugins: null,
    backupOnRestart: null,
    showSleepButton: null,
    sleepCountdownSeconds: null,
    restartGraceMs: null,
    askedForPluginVersion: null,
  }
  const payload = {
    includePlugins: typeof values.includePlugins === 'boolean' ? values.includePlugins : current.includePlugins,
    backupOnRestart: typeof values.backupOnRestart === 'boolean' ? values.backupOnRestart : current.backupOnRestart,
    showSleepButton: typeof values.showSleepButton === 'boolean' ? values.showSleepButton : current.showSleepButton,
    sleepCountdownSeconds: typeof values.sleepCountdownSeconds === 'number'
      ? values.sleepCountdownSeconds
      : current.sleepCountdownSeconds,
    restartGraceMs: typeof values.restartGraceMs === 'number'
      ? values.restartGraceMs
      : current.restartGraceMs,
    askedForPluginVersion: typeof values.askedForPluginVersion === 'string'
      ? values.askedForPluginVersion
      : current.askedForPluginVersion,
    at: new Date().toISOString(),
  }
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

/**
 * The version of THIS plugin, for "did it change since we asked?".
 */
function pluginVersionNow() {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return parsed && typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}


/**
 * Resolve the effective `backupIncludePlugins` value and where it came from.
 *
 * The profile row config always wins: it is the single source of truth (the
 * settings page and the one-time install prompt write the same key). Only when
 * the row config does not set the key at all does the degraded fallback file
 * get a say, and only when it does not exist does the built-in default apply.
 *
 * @param {object|null|undefined} rawConfig the loader row config, as received
 * @param {string} stateDir
 * @returns {{ includePlugins: boolean, source: 'config'|'fallback-file'|'default' }}
 */
export function resolveBackupIncludePlugins(rawConfig, stateDir) {
  if (rawConfig && typeof rawConfig === 'object'
    && Object.prototype.hasOwnProperty.call(rawConfig, 'backupIncludePlugins')
    && typeof rawConfig.backupIncludePlugins === 'boolean') {
    return { includePlugins: rawConfig.backupIncludePlugins, source: 'config' }
  }
  const fallback = typeof stateDir === 'string' && stateDir !== '' ? readInstallChoice(stateDir) : null
  if (fallback !== null && fallback.includePlugins !== null) {
    return { includePlugins: fallback.includePlugins, source: 'fallback-file' }
  }
  return { includePlugins: DEFAULTS.backupIncludePlugins, source: 'default' }
}

/**
 * Resolve the effective `backupOnRestart` value and where it came from.
 *
 * The same rule as the backup scope: the profile row config wins, the degraded
 * fallback file fills the gap, and the built-in default applies when neither
 * says anything.
 *
 * @param {object|null|undefined} rawConfig the loader row config, as received
 * @param {string} stateDir
 * @returns {{ backupOnRestart: boolean, source: 'config'|'fallback-file'|'default' }}
 */
export function resolveBackupOnRestart(rawConfig, stateDir) {
  if (rawConfig && typeof rawConfig === 'object'
    && Object.prototype.hasOwnProperty.call(rawConfig, 'backupOnRestart')
    && typeof rawConfig.backupOnRestart === 'boolean') {
    return { backupOnRestart: rawConfig.backupOnRestart, source: 'config' }
  }
  const fallback = typeof stateDir === 'string' && stateDir !== '' ? readInstallChoice(stateDir) : null
  if (fallback !== null && fallback.backupOnRestart !== null) {
    return { backupOnRestart: fallback.backupOnRestart, source: 'fallback-file' }
  }
  return { backupOnRestart: DEFAULTS.backupOnRestart, source: 'default' }
}

/**
 * Resolve the effective `showSleepButton` value and where it came from.
 *
 * The same rule as the backup scope: the profile row config wins, the degraded
 * fallback file fills the gap, and the built-in default applies when neither
 * says anything.
 *
 * @param {object|null|undefined} rawConfig the loader row config, as received
 * @param {string} stateDir
 * @returns {{ showSleepButton: boolean, source: 'config'|'fallback-file'|'default' }}
 */
export function resolveShowSleepButton(rawConfig, stateDir) {
  if (rawConfig && typeof rawConfig === 'object'
    && Object.prototype.hasOwnProperty.call(rawConfig, 'showSleepButton')
    && typeof rawConfig.showSleepButton === 'boolean') {
    return { showSleepButton: rawConfig.showSleepButton, source: 'config' }
  }
  const fallback = typeof stateDir === 'string' && stateDir !== '' ? readInstallChoice(stateDir) : null
  if (fallback !== null && fallback.showSleepButton !== null) {
    return { showSleepButton: fallback.showSleepButton, source: 'fallback-file' }
  }
  return { showSleepButton: DEFAULTS.showSleepButton, source: 'default' }
}

/**
 * Resolve the profile directory the running host was started from.
 *
 * The host process does NOT necessarily carry `DSH_PROFILE_DIR` / `DSH_PROFILE`
 * (those are injected into shell commands, not into the host environment), so this
 * walks four independent sources and reports which one answered:
 *
 *   1. `DSH_PROFILE_DIR` — the host exported it.
 *   2. `DSH_HOME` + `DSH_PROFILE`.
 *   3. `--profile <name>` / `--profile=<name>` on the host command line.
 *   4. the only profile whose `dsh.profile.bundles` lists this plugin.
 *
 * "I CANNOT TELL" IS NOT "THERE IS NO PROFILE" (2026-11-02): when MORE THAN ONE
 * profile lists this plugin, nothing is picked and the source says `ambiguous`
 * (with the count) — the page must then say «多个 profile，备份和回滚已暂停»
 * instead of claiming there is nothing to back up.
 *
 * @returns {{ dir: string|null, source: string, candidates: number }}
 */
function resolveProfileDirDetailed() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = path.resolve(explicit.trim())
    if (fs.existsSync(dir)) return { dir, source: 'DSH_PROFILE_DIR', candidates: 1 }
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : ''
  const profile = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : ''
  if (home !== '' && profile !== '') {
    const dir = path.join(home, 'profiles', profile)
    if (fs.existsSync(dir)) return { dir, source: 'DSH_HOME/DSH_PROFILE' }
  }
  // The host may have been started with an explicit --profile flag instead.
  const argv = Array.isArray(process.argv) ? process.argv : []
  let fromArgv = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    if (arg === '--profile' && index + 1 < argv.length) fromArgv = String(argv[index + 1] ?? '')
    else if (arg.startsWith('--profile=')) fromArgv = arg.slice('--profile='.length)
  }
  const root = home !== '' ? home : path.join(os.homedir(), '.dsh')
  if (fromArgv.trim() !== '') {
    const dir = path.join(root, 'profiles', fromArgv.trim())
    if (fs.existsSync(dir)) return { dir, source: 'host --profile flag' }
  }
  // Last resort: the only profile that lists this plugin as a bundle.
  try {
    const profilesDir = path.join(root, 'profiles')
    const matches = []
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // THE RESCUE'S OWN LEFTOVERS ARE NOT CANDIDATES (measured on the real
      // desktop profile, 2026-11-03): `restore-profile` and the rollback path
      // keep the profile they replaced as `<name>.broken-<stamp>` by design, and
      // every one of those still carries a package.json that lists this plugin.
      // Counting them turned "which profile am I" into `ambiguous` for anyone who
      // had ever been rescued - and an ambiguous answer means the watchdog cannot
      // arm at all (`armOutcome: failed`, "there is no profile directory to
      // restore into"). With the two leftovers moved out of `profiles/`, the same
      // build armed immediately (tier scheduled-task, arbiter v2).
      if (entry.name.includes('.broken-') || entry.name.includes('.partial-')) continue
      const candidate = path.join(profilesDir, entry.name)
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'))
        const bundles = manifest && manifest.dsh && manifest.dsh.profile
          && Array.isArray(manifest.dsh.profile.bundles)
          ? manifest.dsh.profile.bundles
          : []
        if (bundles.includes(name)) matches.push(candidate)
      } catch {}
    }
    if (matches.length === 1) return { dir: matches[0], source: 'profile bundles scan', candidates: 1 }
    // MORE THAN ONE: the "must not guess" case, and it SAYS so.
    if (matches.length > 1) return { dir: null, source: 'ambiguous', candidates: matches.length }
  } catch {}
  return { dir: null, source: 'unknown', candidates: 0 }
}

/** The profile directory, or null when it cannot be resolved. */
function resolveProfileDir() {
  return resolveProfileDirDetailed().dir
}

/**
 * The profile of this host, in the shape the health payload reports.
 *
 * EXPORTED so a test can prove the three cases (resolved / ambiguous / none)
 * without starting a host: the page's «多个 profile» warning depends on the
 * difference between "ambiguous" and "none", and a difference nobody tests is a
 * difference that quietly disappears.
 *
 * @returns {{ profile: string|null, profileDirSource: string, profileCandidates: number }}
 */
export function profileDirInfo() {
  try {
    const info = resolveProfileDirDetailed()
    return {
      profile: info.dir,
      profileDirSource: info.source,
      profileCandidates: info.candidates,
    }
  } catch {
    return { profile: null, profileDirSource: 'unknown', profileCandidates: 0 }
  }
}

/**
 * THE BACKUPS DIRECTORY.
 *
 * It is built in exactly ONE place: the snapshot writes here, and the
 * settings page reads here. Two places would mean two answers to "where do
 * the backups live".
 *
 * @param {string} dir the state directory
 * @returns {string}
 */
function backupsDirFor(dir) {
  return backupsRoot(typeof dir === 'string' ? dir : '')
}

/**
 * THE REPORTED KIND OF PLUGIN FAILURE (user decision, 2026-11-01).
 *
 * A plugin that fails to IMPORT does not keep the host from booting: the entry
 * silently never activates and the feature behind it 404s. The startup log says
 * so (`<plugin>: failed to import: …`). This pass reads that verdict, puts the
 * plugin back to the copy of the newest KNOWN-GOOD backup and asks for ONE
 * restart so the restored copy is what the next boot loads.
 *
 * IT DOES NOT TAKE OVER THE PROCESS-LEVEL FAILURE. A boot that does not come up
 * at all is the pre-restart snapshot plus the watchdog (lib/watchdog.js,
 * lib/restart.js); this pass only runs inside a host that IS up, and it never
 * arms a second restart mechanism — it asks through `requestRestart`, the same
 * entry the tool and the routes use.
 *
 * THE ONE RESTART BUDGET: only a pass that really changed files asks for a
 * restart. `no-backup`, `duplicate`, `already-consistent` and `needs-human` all
 * change nothing, so they ask for nothing (a restart that cannot change the
 * outcome only costs the user another boot).
 *
 * @param {{
 *   stateDir?: string,
 *   profileDir?: string,
 *   backupsDir?: string,
 *   logsDir?: string,
 *   bootAt?: number,
 *   now?: number,
 *   fs?: object,
 *   enabledPlugins?: string[]|null,
 *   copy?: Function|null,
 *   attemptLimit?: number,
 *   logPath?: string|null,
 *   requestRestart?: Function|null,
 * }} [options]
 * @returns {object|null} the outcome of the pass (null when it could not run)
 */
export function runPluginRecovery(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir.trim() : ''
  if (stateDir === '') return null
  const fsImpl = options.fs && typeof options.fs === 'object' ? options.fs : fs
  const now = Number.isFinite(Number(options.now)) ? Math.trunc(Number(options.now)) : Date.now()
  const bootAt = Number.isFinite(Number(options.bootAt)) ? Math.trunc(Number(options.bootAt)) : now
  const outcome = collectPluginRecovery({ ...options, stateDir, fs: fsImpl, now, bootAt })
  if (!outcome || outcome.ran !== true) return outcome
  if (outcome.changed !== true) return outcome
  // ONE RESTART, THROUGH THE EXISTING ENTRY. Never a second mechanism: the
  // caller supplies the same `requestRestart` the tool and the routes use.
  let requested = false
  if (typeof options.requestRestart === 'function') {
    const changedPlugins = outcome.actions
      .filter((action) => action && action.changed === true)
      .map((action) => action.plugin)
    try {
      requested = options.requestRestart({
        reason: 'a plugin failed to load, so the copy whose restart record says it came up with matching content was put back: '
          + changedPlugins.join(', '),
        plugins: changedPlugins,
      }) !== false
    } catch {
      requested = false
    }
  }
  const report = { ...outcome.report, restartRequested: requested === true }
  if (writeRecoveryReport(stateDir, report, { fs: fsImpl })) outcome.report = report
  outcome.restartRequested = requested === true
  return outcome
}

/**
 * The detection + restore + bookkeeping half of {@link runPluginRecovery}.
 *
 * Split out on purpose: this half never asks for a restart, so a test can drive
 * every decision without registering anything on the machine.
 *
 * @param {object} [options] see {@link runPluginRecovery}
 * @returns {object|null}
 */
export function collectPluginRecovery(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir.trim() : ''
  if (stateDir === '') return null
  const fsImpl = options.fs && typeof options.fs === 'object' ? options.fs : fs
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir.trim() : ''
  const backupsDir = typeof options.backupsDir === 'string' ? options.backupsDir.trim() : ''
  const logsDir = typeof options.logsDir === 'string' && options.logsDir !== ''
    ? options.logsDir
    : resolveStartupLogsDir()
  const now = Number.isFinite(Number(options.now)) ? Math.trunc(Number(options.now)) : Date.now()
  const bootAt = Number.isFinite(Number(options.bootAt)) ? Math.trunc(Number(options.bootAt)) : now
  const attemptLimit = Number.isFinite(Number(options.attemptLimit)) && Number(options.attemptLimit) >= 1
    ? Math.trunc(Number(options.attemptLimit))
    : 1
  const recoveryState = readRecoveryState(stateDir, { fs: fsImpl })

  // (1) WHICH LOG: the PREVIOUS boot's own log. The log of the boot that is
  // looking for failures cannot hold its own audit verdict yet, and an older
  // one would dig up an already handled incident.
  const log = typeof options.logPath === 'string' && options.logPath !== ''
    ? { name: path.basename(options.logPath), path: options.logPath, at: null, mtime: 0, size: 0 }
    : findLatestStartupLog(logsDir, { before: bootAt, fs: fsImpl })
  if (log === null) {
    return {
      ran: false,
      found: false,
      changed: false,
      needsHuman: false,
      restartRequested: false,
      report: null,
      log: null,
      actions: [],
      failures: [],
      reason: 'no finished boot log was found, so there is nothing to judge',
    }
  }
  let text = ''
  try {
    text = String(fsImpl.readFileSync(log.path, 'utf8'))
  } catch (error) {
    return {
      ran: false,
      found: false,
      changed: false,
      needsHuman: false,
      restartRequested: false,
      report: null,
      log: log.path,
      actions: [],
      failures: [],
      reason: 'the startup log could not be read: ' + (error && error.message ? error.message : String(error)),
    }
  }

  // (2) DETECT. Lines stamped before the boot this log belongs to are not new
  // information: they are the loop guard against reading the same verdict
  // forever.
  const sinceMs = Number.isFinite(Number(log.at)) ? Number(log.at) : null
  const failures = findPluginFailures(text, {
    sinceMs,
    logAt: Number.isFinite(Number(log.mtime)) && log.mtime > 0 ? Math.trunc(log.mtime) : null,
    now,
  })
  const named = mergeFailuresByPlugin(failures)

  if (named.length === 0) {
    // ONE CLEAN BOOT ENDS THE CYCLE: the plugin that failed before now loads, so
    // the attempt budget and the handled fingerprints start over.
    const reset = resetRecoveryCycle(recoveryState, { now })
    if (reset.reset) writeRecoveryState(stateDir, recoveryState, { fs: fsImpl })
    return {
      ran: true,
      found: false,
      changed: false,
      needsHuman: false,
      restartRequested: false,
      report: null,
      log: log.path,
      actions: [],
      failures: [],
      reset,
      reason: 'the previous boot reported no plugin failure',
    }
  }

  // (3) PLAN: the newest backup that has PROVEN it can boot is the only source.
  const knownGood = backupsDir === '' ? null : latestKnownGood(backupsDir)
  const enabledPlugins = options.enabledPlugins === undefined
    ? readEnabledPlugins(profileDir)
    : options.enabledPlugins
  const plan = planPluginRecovery({
    failures: named,
    backupDir: knownGood && typeof knownGood.dir === 'string' ? knownGood.dir : null,
    profileDir,
    backupMeta: null,
    enabledPlugins,
    recovery: recoveryState,
    attemptLimit,
    fs: fsImpl,
  })

  // (4) APPLY: the evidence rename and the copy, nothing else.
  const applied = applyPluginRecovery({
    plan,
    profileDir,
    now,
    fs: fsImpl,
    copy: typeof options.copy === 'function' ? options.copy : null,
  })

  // (5) BOOKKEEPING. An ATTEMPT is spent only by a restore that really happened
  // (that is the plugin-level loop guard), and the failure is marked HANDLED
  // only when files were really changed: a decision that changed nothing has to
  // stay visible on the next boot instead of disappearing behind "handled".
  for (const action of applied.actions) {
    if (action && action.changed === true) {
      recordAttempt(recoveryState, action.plugin, { now })
      markHandled(recoveryState, { fingerprint: action.fingerprint, plugin: action.plugin, now })
    }
  }

  const report = buildRecoveryReport({
    at: now,
    log: log.path,
    failures: named,
    actions: applied.actions,
    restartRequested: false,
    needsHuman: applied.needsHuman === true,
    backupDir: plan.backupDir,
    backupKind: plan.backupKind,
    restoredAt: plan.restoredAt,
  })
  writeRecoveryReport(stateDir, report, { fs: fsImpl })
  writeRecoveryState(stateDir, recoveryState, { fs: fsImpl })

  return {
    ran: true,
    found: true,
    changed: applied.changed === true,
    needsHuman: applied.needsHuman === true,
    restartRequested: false,
    report,
    log: log.path,
    plan,
    actions: applied.actions,
    failures: named,
    state: recoveryState,
    reason: applied.changed === true
      ? 'the failed plugin was restored from the backup whose restart record says it came up with matching content'
      : 'the failure was recognised but nothing was changed',
  }
}

/**
 * Where this machine writes its startup logs (`<DSH_HOME>/logs`).
 *
 * @returns {string}
 */
export function resolveStartupLogsDir() {
  try {
    return path.join(dshHomeDir({ env: process.env }), 'logs')
  } catch {
    return ''
  }
}

/**
 * The plugins this profile enables: the dependencies of its package.json, the
 * bundles the profile turns on, and what is really installed.
 *
 * WHY THE INSTALLED TREE IS INCLUDED: a startup log names ENTRY ids, which are
 * not always package names, so a list built only from package.json would call a
 * perfectly installed plugin "unknown" and refuse to restore it. The installed
 * tree is the honest answer to "is this plugin part of this profile?".
 *
 * @param {string} profileDir
 * @returns {string[]|null} null when nothing could be read (no filtering then)
 */
export function readEnabledPlugins(profileDir) {
  const dir = typeof profileDir === 'string' ? profileDir.trim() : ''
  if (dir === '') return null
  const names = new Set()
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text)
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = parsed && typeof parsed === 'object' ? parsed[key] : null
      if (block && typeof block === 'object') {
        for (const name of Object.keys(block)) names.add(name)
      }
    }
    for (const name of enabledBundlesOf(text)) names.add(name)
  } catch {}
  for (const sub of [PLUGINS_DIR, LINKS_DIR]) {
    const root = path.join(dir, sub)
    let entries = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = String(entry)
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        // A scope directory is not a plugin: the packages inside it are.
        try {
          for (const scoped of fs.readdirSync(path.join(root, name))) {
            names.add(name + '/' + String(scoped))
          }
        } catch {}
        continue
      }
      names.add(name)
    }
  }
  return names.size === 0 ? null : [...names]
}

/**
 * THE FIRST-INSTALL BACKUP (user decision, 2026-10-30).
 *
 * A machine that has never restarted has no backup at all, so a boot that fails
 * after the plugin is installed has nothing to roll back to. The FIRST boot of a
 * NEW host process therefore seeds one known-good copy of the profile.
 *
 * Two rules keep it honest:
 *   - a plugin RELOAD is not an installation: `runtime.isNewBoot` must be true,
 *     and nothing is written on a reload;
 *   - a machine that already has a known-good copy gets no second seed.
 *
 * A failure is NOT silent: it is recorded on `runtime.firstInstallBackup` (and
 * in the checkpoint, so it survives the next boot) and the health route reports
 * it, because a machine with no backup must be able to say so.
 *
 * @param {object} runtime
 * @param {object} [config]
 * @param {{ profileDir?: string }} [overrides] the profile to copy (tests pass it)
 * @returns {Promise<object|null>} the record that was written (null = nothing to do)
 */
export async function seedFirstInstallBackup(runtime, config = {}, overrides = {}) {
  const state = runtime && runtime.state && typeof runtime.state === 'object' ? runtime.state : null
  if (state === null) return null
  if (runtime.isNewBoot !== true) return null
  // NO BACKUPS AT ALL: the user switched the pre-restart snapshot off, so a
  // backup is not wanted either.
  if (config.backupOnRestart === false) return null
  const stateDir = path.dirname(String(runtime.stateFile ?? ''))
  const backupsDir = backupsDirFor(stateDir)
  // BOOT-TIME SWEEP (2026-11-02). The sweep inside `createBackup` runs only when
  // a backup is WRITTEN, so a machine whose pre-restart backup path itself fails
  // never cleans up after itself: the real machine kept 24 complete-looking
  // directories that held no manifest and no configuration, 1.78 GB in total.
  // The boot is the one moment that always happens, so the sweep belongs here as
  // well. A refusal is recorded, never fatal: the host coming up does not depend
  // on deleting stale directories.
  let bootHygiene = null
  try {
    bootHygiene = removeIncompleteBackups(backupsDir)
  } catch (error) {
    bootHygiene = {
      removed: [],
      bytes: 0,
      error: error && error.message ? String(error.message) : String(error),
    }
  }
  state.bootHygiene = bootHygiene
  if (bootHygiene && Array.isArray(bootHygiene.removed) && bootHygiene.removed.length > 0) {
    try {
      runtime.log.warn('removed backup directories that were not backups', {
        count: bootHygiene.removed.length,
        bytes: bootHygiene.bytes,
        names: bootHygiene.removed.slice(0, 10),
      })
    } catch {}
  }
  /**
   * Record the outcome where the interface can see it.
   *
   * @param {object} value
   * @returns {object}
   */
  const record = (value) => {
    state.firstInstallBackup = value
    runtime.firstInstallBackup = value
    persistSafely(runtime)
    return value
  }
  const existing = latestKnownGood(backupsDir)
  if (existing !== null) {
    return record({ result: 'present', at: Date.now(), dir: existing.dir, bytes: null, error: null })
  }
  /**
   * Report that this machine has NO backup, with the reason.
   *
   * @param {string} error
   * @returns {object}
   */
  const failed = (error) => {
    const value = { result: RESTORE_REFUSAL.NO_USABLE_BACKUP, at: Date.now(), dir: null, bytes: null, error: String(error) }
    try {
      runtime.log.warn('the first-install backup could not be written: this machine has nothing to roll back to', { error: String(error) })
    } catch {}
    return record(value)
  }
  const profileDir = typeof overrides.profileDir === 'string' && overrides.profileDir !== ''
    ? overrides.profileDir
    : resolveProfileDir()
  if (profileDir === null) return failed('the profile directory could not be resolved')
  const maxBackups = Number(config.maxBackups)
  let result = null
  try {
    result = await createBackup({
      profileDir,
      backupsDir,
      // CONFIGURATION ONLY. The seed exists so a fresh installation has
      // something to roll back to at once; the plugin tree (the 117 MB part)
      // comes with the snapshot of the first restart, which is promoted to
      // known-good as soon as that restart proves it boots.
      includePlugins: false,
      maxBackups: Number.isFinite(maxBackups) && maxBackups >= 1 ? Math.trunc(maxBackups) : DEFAULT_MAX_BACKUPS,
      kind: KIND_KNOWN_GOOD,
      // WHAT PUT THIS COPY THERE, as a fact (2026-11-02): the fresh installation.
      // The old `reason: 'first-install'` free-text field is gone from the record;
      // this is the field a reader can compare against, and it is also what makes
      // the seed restorable without ever calling it "safe".
      trigger: BACKUP_TRIGGERS.FIRST_INSTALL,
      version: runtime.pluginVersion ?? PLUGIN_VERSION_FALLBACK,
      bootId: runtime.bootId ?? null,
    })
  } catch (error) {
    return failed(error && error.message ? error.message : String(error))
  }
  if (!result || result.ok !== true || typeof result.dir !== 'string' || result.dir === '') {
    return failed(result && result.error ? result.error : 'the first-install backup was not written')
  }
  return record({
    result: 'seeded',
    at: Date.now(),
    dir: result.dir,
    bytes: Number.isFinite(result.bytes) ? result.bytes : null,
    error: null,
  })
}

/**
 * The pre-restart snapshot: copy the profile into `<stateDir>/backups/<stamp>/`
 * and clear the rollback report an older boot may have left behind.
 *
 * This is the ONE backup entry of the plugin. EVERY restart mode takes its
 * snapshot through this function — the desktop app relaunch AND the custom
 * restart command — so a hosted host that is restarted by a command is just as
 * recoverable as the desktop app. The configuration files decide whether every
 * bundle loads, so a snapshot is what makes a "the host does not come back"
 * rollback possible at all.
 *
 * A failing backup never blocks the restart: the reason is logged and the
 * caller continues without a rollback point. It is NOT silent though: the
 * facts of the snapshot (was one asked for, was one taken, which directory,
 * how long it took, which older snapshots were pruned) travel with the answer,
 * so the restart record can tell the operator what the rollback net is.
 *
 * @param {{
 *   config?: object,
 *   stateDir?: string,
 *   log?: { warn: Function },
 *   profile?: { dir?: string|null, source?: string },
 *   createBackup?: Function,
 * }} [options]
 * @returns {{
 *   backup: object|null,
 *   profileDir: string|null,
 *   profile: { dir: string|null, source: string },
 *   requested: boolean,
 *   durationMs: number,
 *   error: string|null,
 * }}
 */
export async function takePreRestartSnapshot({
  config = {},
  stateDir = '',
  log = console,
  profile = null,
  createBackup: createBackupFn = createBackup,
  // The REAL progress of the copy, and the way out of it: both are handed to
  // the backup itself, so the numbers on screen are the numbers on disk.
  onProgress = null,
  shouldCancel = null,
  // Slim by default; pass false to snapshot the whole plugin tree.
  slimBackup = true,
} = {}) {
  const startedAt = Date.now()
  const info = profile && typeof profile === 'object'
    ? { dir: profile.dir ?? null, source: profile.source ?? 'unknown' }
    : { dir: null, source: 'unknown' }
  const profileDir = typeof info.dir === 'string' && info.dir.trim() !== '' ? info.dir : null
  // The snapshot is optional: the operator can turn it off entirely.
  if (config.backupOnRestart !== true) {
    return { backup: null, profileDir, profile: info, requested: false, durationMs: 0, error: null }
  }
  if (profileDir === null) {
    log.warn('no profile directory is known; skipping the pre-restart backup', { source: info.source })
    return {
      backup: null,
      profileDir: null,
      profile: info,
      requested: true,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: 'no profile directory is known',
    }
  }
  let backup = null
  try {
    backup = await createBackupFn({
    slimBackup,
      profileDir,
      backupsDir: backupsDirFor(stateDir),
      includePlugins: config.backupIncludePlugins !== false,
      maxBackups: config.maxBackups,
      onProgress: typeof onProgress === 'function' ? onProgress : null,
      shouldCancel: typeof shouldCancel === 'function' ? shouldCancel : null,
    })
  } catch (error) {
    // A backup that throws must not take the restart down with it.
    backup = { ok: false, error: String(error) }
  }
  const durationMs = Math.max(0, Date.now() - startedAt)
  if (backup && backup.cancelled === true) {
    // The user called it off: the half-written snapshot was already removed by
    // the copy loop, and there is nothing to report as a rollback point.
    log.warn('the pre-restart backup was cancelled by the user', { durationMs })
    return {
      backup,
      profileDir,
      profile: info,
      requested: true,
      durationMs,
      cancelled: true,
      error: null,
    }
  }
  if (backup && backup.ok === true) {
    log.warn('pre-restart backup written', {
      dir: backup.dir,
      stamp: backup.stamp,
      at: backup.at,
      atLocal: backup.atLocal,
      durationMs,
      bytes: backup.bytes,
      includePlugins: backup.includePlugins,
      pruned: backup.pruned,
      profileDirSource: info.source,
    })
    // WHERE THE DISK SPACE WENT (2026-11-01): the sweep that removes directories
    // holding neither a manifest nor a configuration reports what it did, so a
    // 1.78 GB pile cannot quietly grow back.
    if (backup.hygiene && Array.isArray(backup.hygiene.removed) && backup.hygiene.removed.length > 0) {
      log.warn('removed incomplete backup directories', {
        removed: backup.hygiene.removed.length,
        bytes: backup.hygiene.bytes,
        names: backup.hygiene.removed.slice(0, 10),
        capped: backup.hygiene.capped === true,
        skipped: Array.isArray(backup.hygiene.skipped) ? backup.hygiene.skipped.length : 0,
      })
    }
    // A report from an older boot must not be mistaken for this one.
    clearRollbackReport(stateDir)
  } else {
    log.warn('the pre-restart backup failed; continuing without a rollback point', {
      error: backup && backup.error ? backup.error : 'unknown error',
    })
  }
  return {
    backup,
    profileDir,
    profile: info,
    requested: true,
    durationMs,
    error: backup && backup.ok === true ? null : (backup && backup.error ? backup.error : 'unknown error'),
  }
}

/** A logger that never throws and never requires a particular Cordis logger shape. */
function createLogger(ctx) {
  const logger = ctx.logger
  const pick = (level) => {
    if (logger && typeof logger[level] === 'function') return logger[level].bind(logger)
    if (typeof logger === 'function') {
      try {
        const scoped = logger('dsh-autorestart')
        if (scoped && typeof scoped[level] === 'function') return scoped[level].bind(scoped)
      } catch {}
      return (...parts) => logger('dsh-autorestart', ...parts)
    }
    return level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  }
  const emit = (level, parts) => {
    let message
    try {
      message = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
    } catch {
      message = parts.map(String).join(' ')
    }
    try {
      pick(level)(`[dsh-autorestart] ${message}`)
    } catch {}
  }
  return {
    info: (...parts) => emit('info', parts),
    warn: (...parts) => emit('warn', parts),
    error: (...parts) => emit('error', parts),
  }
}

/** Whether this agent is a root session (subagent sessions are not resumed on boot). */
function isRootAgent(ctx, agent) {
  try {
    const roots = ctx.agents.roots()
    if (!Array.isArray(roots)) return true
    return roots.includes(agent)
  } catch {
    return true
  }
}

/**
 * Resolve the official `configEditor` service, or null when it is unavailable.
 *
 * The service is optional: the plugin must load in a composition that does not
 * provide it, and the one-time install choice then falls back to a file.
 *
 * @param {object} ctx
 * @returns {any|null}
 */
function resolveConfigEditor(ctx) {
  try {
    if (ctx && ctx.configEditor && typeof ctx.configEditor.edit === 'function') return ctx.configEditor
  } catch {}
  try {
    if (ctx && typeof ctx.get === 'function') {
      const service = ctx.get('configEditor')
      if (service && typeof service.edit === 'function') return service
    }
  } catch {}
  return null
}

/**
 * Find this plugin's own row among the profile entries.
 *
 * The service hands out the LOADER's own entries, so the row id lives in
 * `entry.options.id` (the id the bundle layer inserts: `dsh-autorestart`).
 * A projected entry (the shape the settings UI shows) carries the same id as
 * `patchId` or `id`, so both are accepted as well.
 *
 * @param {any} editor the configEditor service
 * @returns {any|null} the entry, or null when this plugin has no row
 */
function findOwnEntry(editor) {
  let entries = []
  try {
    entries = typeof editor.entries === 'function' ? editor.entries() : []
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const options = entry.options && typeof entry.options === 'object' ? entry.options : null
    const candidates = [
      options ? options.id : undefined,
      entry.patchId,
      entry.id,
    ]
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue
      if (String(candidate) === name) return entry
    }
  }
  return null
}

/**
 * THE FATE OF THE LAST RESTART REQUEST — one durable record, one vocabulary.
 *
 * WHY THIS EXISTS (real-host report, hosted `dsh web` on WSL/5601): `POST /park`
 * answered `pendingRestart: true, restartRequested: true`, and afterwards
 * `state.restart` was `null`, the generation had not moved, no restart had
 * happened and `last-restart-verdict.json` had no new record. Nothing anywhere
 * said what had become of that request — the operator could only observe that
 * the request was gone.
 *
 * The request is dropped in exactly six places in this file (see
 * `dropRestartRequest`, which every one of them now calls). Before this record
 * existed, four of them wrote only a log line and two wrote nothing at all — and
 * a log line is not a record: it rotates, it is not in the state directory, and
 * the UI/health surfaces never see it.
 *
 * The verdict file (`last-restart-verdict.json`) is NOT reused for this: its
 * `result` vocabulary is `pending` / `ok` / `failed` — it describes a restart
 * that HAPPENED, and a cancellation is not one. Writing `pending` there would
 * claim a restart is in flight that never was.
 */
export const RESTART_REQUEST_FILE = 'last-restart-request.json'

/** What can happen to a restart request. */
export const RESTART_REQUEST_STATES = Object.freeze({
  /** Accepted, nobody has executed it yet (the gate is waiting). */
  QUEUED: 'queued',
  /** The gate postponed it; the request is STILL ALIVE (never a cancel). */
  DEFERRED: 'deferred',
  /** The restart is being carried out (snapshot / arm / command). */
  EXECUTING: 'executing',
  /** The request was withdrawn; `reason` + `by` + `at` say why, who, when. */
  CANCELLED: 'cancelled',
})

/**
 * @param {string} stateDir
 * @returns {string} where the record of the last restart request lives
 */
export function restartRequestPath(stateDir) {
  return path.join(String(stateDir ?? ''), RESTART_REQUEST_FILE)
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The record of one restart request, normalized.
 *
 * Every field is deliberately flat and nullable: this file is read by a human
 * with `cat`, by the health route and by `continuum_status`, and none of them
 * should have to know the internals of the checkpoint.
 *
 * @param {{
 *   result?: string,
 *   reason?: string|null,
 *   by?: string|null,
 *   restart?: object|null,
 *   now?: number,
 *   extra?: object,
 * }} [input]
 * @returns {object}
 */
export function buildRestartRequestRecord({
  result = RESTART_REQUEST_STATES.QUEUED,
  reason = null,
  by = null,
  restart = null,
  now = Date.now(),
  extra = {},
} = {}) {
  const known = Object.values(RESTART_REQUEST_STATES)
  const request = isPlainObject(restart) ? restart : {}
  const requestedAt = Number.isFinite(request.requestedAt) ? Number(request.requestedAt) : null
  const at = Number.isFinite(now) ? Number(now) : Date.now()
  const requesters = Array.isArray(request.requesters)
    ? request.requesters
      .map((entry) => (isPlainObject(entry) && typeof entry.sessionId === 'string' ? entry.sessionId : null))
      .filter((id) => typeof id === 'string' && id !== '')
    : []
  return {
    version: 1,
    // WHICH REQUEST this is about: the generation of the checkpoint request.
    generation: Number.isFinite(request.generation) ? Math.trunc(request.generation) : null,
    result: known.includes(result) ? result : RESTART_REQUEST_STATES.QUEUED,
    // WHY it was postponed / cancelled — the sentence the operator needs.
    reason: typeof reason === 'string' && reason !== '' ? reason : null,
    // WHO did it: 'tool', 'route', 'boot', 'gate', 'rollback', 'snapshot-cancel', …
    by: typeof by === 'string' && by !== '' ? by : null,
    // WHEN (epoch + the wall clock the operator reads).
    at,
    atLocal: localIsoTime(at),
    requestedAt,
    requestedAtLocal: localIsoTime(requestedAt),
    // HOW LONG the request was alive before this record was written.
    waitedMs: requestedAt === null ? null : Math.max(0, at - requestedAt),
    attempts: Number.isFinite(request.attempt) ? Math.trunc(request.attempt) : 0,
    snapshotTaken: Boolean(request.snapshot),
    // WHICH DIRECTORY that snapshot is (2026-11-02). A bare `true` cannot be
    // checked later, and a copy CAN disappear after it was written — the prune
    // used to delete the newest one. With the name on record, a reader can say
    // "the copy that restart took is gone now" instead of repeating "taken".
    snapshotDir: isPlainObject(request.snapshot) && typeof request.snapshot.dir === 'string' && request.snapshot.dir !== ''
      ? request.snapshot.dir
      : null,
    requesters,
    bySessionId: typeof request.bySessionId === 'string' && request.bySessionId !== '' ? request.bySessionId : null,
    ...extra,
  }
}

/**
 * Write the record (atomically: temporary file + rename, so a half-written
 * record is never read).
 *
 * @param {string} stateDir
 * @param {object} record
 * @param {{ writeFile?: Function, rename?: Function, mkdir?: Function }} [io]
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeRestartRequestRecord(stateDir, record, {
  writeFile = (target, content) => fs.writeFileSync(target, content, 'utf8'),
  rename = (from, to) => fs.renameSync(from, to),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : ''
  if (dir === '') return { ok: false, path: '', error: 'there is no state directory to write the request record into' }
  const target = restartRequestPath(dir)
  const temporary = target + '.tmp-' + crypto.randomBytes(6).toString('hex')
  try {
    mkdir(dir)
    writeFile(temporary, JSON.stringify(record, null, 2) + '\n')
    rename(temporary, target)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return { ok: false, path: target, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * Read the record of the last restart request. Never throws: a missing or
 * corrupt file is `null` (there is nothing to report).
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRestartRequestRecord(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : ''
  if (dir === '') return null
  try {
    let text = fs.readFileSync(restartRequestPath(dir), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * THE HONEST ANSWER about the restart request: what the park response, the
 * health route and `continuum_status` report.
 *
 * The three answers are deliberately different words, because they are three
 * different situations:
 *
 *   - `queued`    — accepted, waiting for the idle gate;
 *   - `deferred`  — the gate postponed it, and it is STILL waiting (there is no
 *                   end time: it waits until every conversation is done);
 *   - `cancelled` — it will not happen; `reason`/`by`/`at` say why, who, when.
 *
 * @param {{ restart?: object|null, record?: object|null, now?: number }} [input]
 * @returns {object}
 */
export function summarizeRestartRequest({ restart = null, record = null, now = Date.now() } = {}) {
  const live = isPlainObject(restart) ? restart : null
  const last = isPlainObject(record) ? record : null
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  if (live !== null) {
    // A live request: the RECORD tells whether it was ever postponed, and for
    // which reason. A record about a different request is stale and ignored.
    const sameRequest = last !== null
      && (last.requestedAt === null || last.requestedAt === live.requestedAt)
    const deferred = sameRequest && last.result === RESTART_REQUEST_STATES.DEFERRED
    const requestedAt = Number.isFinite(live.requestedAt) ? Number(live.requestedAt) : null
    return {
      state: deferred ? RESTART_REQUEST_STATES.DEFERRED : RESTART_REQUEST_STATES.QUEUED,
      pending: true,
      reason: deferred ? last.reason : null,
      by: deferred ? last.by : null,
      at: deferred ? last.at : null,
      atLocal: deferred ? last.atLocal : null,
      requestedAt,
      requestedAtLocal: requestedAt === null ? null : localIsoTime(requestedAt),
      // How long the user has been waiting ALREADY.
      waitedMs: requestedAt === null ? null : Math.max(0, at - requestedAt),
      // NO DEADLINE, ON PURPOSE (user decision, 2026-11-02): a pending restart has
      // no expiry. It waits until the idle gate allows it or the user withdraws
      // it — nothing else ends it, and nothing pretends to.
      waitsUntilIdle: true,
      requesters: Array.isArray(live.requesters)
        ? live.requesters.map((entry) => (isPlainObject(entry) ? entry.sessionId : null)).filter(Boolean)
        : [],
      note: deferred
        ? 'the gate postponed this restart; the request is kept and retried until the conversations are done — there is no deadline'
        : 'the request is queued; it runs as soon as the idle gate allows it, however long that takes',
    }
  }
  if (last === null) {
    return { state: 'none', pending: false, reason: null, by: null, at: null, atLocal: null, note: 'no restart was ever requested' }
  }
  // THE REQUEST IS STILL QUEUED EVEN THOUGH THE INTENT IS GONE (t26).
  //
  // A record that says `queued` or `deferred` is the user's request, and the
  // interface must keep saying so after the in-memory intent has been lost - that
  // is exactly when the page said "nothing is queued" and the user believed it.
  const recordedFate = typeof last.result === 'string' ? last.result : ''
  if (recordedFate === RESTART_REQUEST_STATES.QUEUED || recordedFate === RESTART_REQUEST_STATES.DEFERRED) {
    const deferred = recordedFate === RESTART_REQUEST_STATES.DEFERRED
    const requestedAt = Number.isFinite(last.requestedAt) ? last.requestedAt : null
    return {
      state: recordedFate,
      pending: true,
      reason: deferred && typeof last.reason === 'string' ? last.reason : null,
      by: deferred && typeof last.by === 'string' ? last.by : null,
      at: deferred && Number.isFinite(last.at) ? last.at : null,
      atLocal: deferred && typeof last.atLocal === 'string' ? last.atLocal : null,
      requestedAt,
      requestedAtLocal: requestedAt === null ? null : localIsoTime(requestedAt),
      waitedMs: requestedAt === null ? null : Math.max(0, at - requestedAt),
      waitsUntilIdle: true,
      requesters: Array.isArray(last.requesters) ? last.requesters : [],
      note: deferred
        ? 'the gate postponed this restart and the request is kept; it is retried until the conversations are done'
        : 'this restart is still queued; it runs as soon as the idle gate allows it',
    }
  }
  // No live request: the record of the LAST one is the whole answer.
  return {
    state: last.result === RESTART_REQUEST_STATES.CANCELLED
      ? RESTART_REQUEST_STATES.CANCELLED
      : (last.result === RESTART_REQUEST_STATES.EXECUTING ? RESTART_REQUEST_STATES.EXECUTING : 'none'),
    pending: false,
    reason: typeof last.reason === 'string' ? last.reason : null,
    by: typeof last.by === 'string' ? last.by : null,
    at: Number.isFinite(last.at) ? last.at : null,
    atLocal: typeof last.atLocal === 'string' ? last.atLocal : null,
    requestedAt: Number.isFinite(last.requestedAt) ? last.requestedAt : null,
    requestedAtLocal: typeof last.requestedAtLocal === 'string' ? last.requestedAtLocal : null,
    waitedMs: Number.isFinite(last.waitedMs) ? last.waitedMs : null,
    requesters: Array.isArray(last.requesters) ? last.requesters : [],
    note: last.result === RESTART_REQUEST_STATES.CANCELLED
      ? 'this restart request was withdrawn; reason, who and when are in this record'
      : 'the last restart request is no longer pending',
  }
}

/**
 * DID THIS BOOT CONSUME THE PENDING RESTART, OR IS IT STILL WAITING FOR ONE?
 *
 * The boot recovery pass used to clear a pending restart unconditionally ("a
 * restart requested before the last shutdown has been consumed by this boot").
 * That is true only when the old instance had really STARTED the restart. A
 * request that was merely QUEUED (deferred by the idle gate, nothing executed:
 * `attempt === 0`, no snapshot) was never consumed by anything — dropping it on
 * the next boot is exactly the silent disappearance this change removes.
 *
 * The rule, in one place:
 *
 *   - the old instance executed it (`attempt > 0` or a snapshot was taken) →
 *     this boot replaced that instance: the request is CONSUMED, drop it with a
 *     record;
 *   - never executed and still FRESH → keep it, it is still what the user asked
 *     for;
 *   - never executed and older than `freshMs` → do not restart the host for a
 *     request from another day: drop it WITH a record.
 *
 * @param {{ restart?: object|null, now?: number, freshMs?: number }} [input]
 * @returns {{ action: 'none'|'keep'|'drop', why: string, detail: string }}
 */
export function decidePendingRestartOnBoot({
  restart = null,
  now = Date.now(),
  freshMs = RESTART_VERDICT_FRESH_MS,
} = {}) {
  const request = isPlainObject(restart) ? restart : null
  if (request === null) {
    return { action: 'none', why: 'no-restart-pending', detail: 'nothing was pending' }
  }
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const requestedAt = Number.isFinite(request.requestedAt) ? Number(request.requestedAt) : 0
  const attempts = Number.isFinite(request.attempt) ? Math.trunc(request.attempt) : 0
  const executed = attempts > 0 || Boolean(request.snapshot)
  if (executed) {
    return {
      action: 'drop',
      why: 'consumed-by-boot',
      detail: 'the previous instance had already started this restart (attempts ' + attempts + ')',
    }
  }
  const age = at - requestedAt
  const window = Number.isFinite(freshMs) ? Number(freshMs) : RESTART_VERDICT_FRESH_MS
  if (age <= window) {
    return {
      action: 'keep',
      why: 'never-executed-and-fresh',
      detail: 'queued ' + Math.max(0, age) + ' ms ago and never executed; this boot carries it out',
    }
  }
  return {
    action: 'drop',
    why: 'stale-never-executed',
    detail: 'queued ' + Math.max(0, age) + ' ms ago (> ' + window + ' ms) and never executed',
  }
}

/**
 * The plugin's whole runtime state.
 *
 * @param {object} ctx
 * @param {object} config the normalized config
 * @param {{
 *   backupChoiceSource?: string,
 *   env?: object,
 *   snapshot?: Function,
 *   runCommand?: Function,
 *   scheduleDetached?: Function,
 *   launchWatcher?: Function,
 *   probeInstance?: Function,
 * }} [options] `env` replaces parts of the detected environment and the
 *   functions replace the side-effecting primitives of the restart path. They
 *   exist so a restart can be exercised without spawning a process or touching
 *   the real profile; production never passes them.
 */
export function createRuntime(ctx, config, options = {}) {
  const log = createLogger(ctx)
  const env = {
    ...detectEnvironment(),
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
  }
  // The ONE pre-restart snapshot entry: every restart mode uses it.
  const snapshotFn = typeof options.snapshot === 'function' ? options.snapshot : takePreRestartSnapshot
  const runCommandFn = typeof options.runCommand === 'function' ? options.runCommand : runCommandNow
  const scheduleDetachedFn = typeof options.scheduleDetached === 'function'
    ? options.scheduleDetached
    : scheduleDetachedRestart
  // The rollback watcher is started OUTSIDE the host process, so it survives the
  // death of the host — which is what a hosted restart does.
  const launchWatcherFn = typeof options.launchWatcher === 'function'
    ? options.launchWatcher
    : launchDetachedWatcher
  // The health confirmation of the new instance (in-process; the detached
  // watcher has its own, outside the host).
  const probeInstanceFn = typeof options.probeInstance === 'function'
    ? options.probeInstance
    : waitForHealthyInstance
  const stateFile = resolveStateFile(config)

  // THE LEFTOVERS OF 0.8.6 (2026-11-03): a machine that upgraded from 0.8.6
  // still carries the watchdog's one-off scheduled task (a systemd user unit
  // on Linux) and its state files. The 0.9.0 code does not know them, so it
  // cleans them up ONCE - here, where the state directory is known and before
  // anything else reads or writes it.
  try {
    const legacy = cleanupLegacyWatchdogArtifacts({
      stateDir: path.dirname(stateFile),
      platform: env.platform,
    })
    if (legacy.removedFiles.length > 0 || legacy.removedUnits.length > 0) {
      log.warn('the leftovers of the 0.8.6 watchdog were removed: '
        + legacy.removedFiles.join(', ')
        + (legacy.removedUnits.length > 0 ? ' / ' + legacy.removedUnits.join(', ') : ''))
    }
  } catch (error) {
    // The cleanup never throws; this is only the belt to that pair of braces.
    log.warn('the legacy cleanup could not run:', String(error))
  }

  const loaded = readState(stateFile, Date.now())
  if (loaded.corrupt) {
    log.warn(`checkpoint ${stateFile} is unreadable (${loaded.error || 'parse error'}); starting from a fresh state`)
  } else if (loaded.repaired) {
    log.warn(`checkpoint ${stateFile} needed repair; unknown or invalid fields were dropped`)
  }
  let state = loaded.state
  const boot = beginBoot(state, { pid: process.pid, now: Date.now() })
  state = boot.state
  const bootId = state.bootId

  // THE INSTANCE RECORD exists from the first moment of this boot: it carries
  // the boot id (which tells the rollback watcher that this instance is the
  // one being replaced). As soon as the web server is known, the record is
  // written again — with the port of this instance and its access link.
  try {
    writeAccessRecord({
      stateDir: path.dirname(stateFile),
      bootId,
      pid: process.pid,
    })
  } catch (error) {
    log.warn('could not write the instance record:', String(error))
  }

  let pollTimer
  let recoverTimer
  let disposed = false
  let lastPersistError
  /**
   * The tool registrations that failed. A failed registration is recorded and
   * logged, never thrown: the plugin still loads and the other tools still work.
   */
  const toolErrors = []
  /**
   * The routes of this plugin that the web server accepted, and the ones it
   * refused. The boot check of the restart record reports them.
   */
  const registeredRoutes = []
  const routeErrors = []

  const persist = () => {
    try {
      writeState(stateFile, writeProfileDirFact(state, resolveProfileDirDetailed(), Date.now()), Date.now())
      lastPersistError = undefined
    } catch (error) {
      if (lastPersistError !== String(error)) {
        lastPersistError = String(error)
        log.warn(`could not write checkpoint ${stateFile}:`, String(error))
      }
    }
  }

  const stopPolling = () => {
    if (typeof pollTimer === 'function') {
      try {
        pollTimer()
      } catch {}
      pollTimer = undefined
    }
  }

  const startPolling = () => {
    if (pollTimer !== undefined) return
    pollTimer = ctx.interval(() => {
      try {
        tick()
      } catch (error) {
        log.warn('defer tick failed:', String(error))
      }
    }, Math.max(250, config.deferPollMs))
  }

  /** When the last conversation activity was observed; the settle window starts here. */
  let lastActivityAt = Date.now()

  /**
   * When a busy conversation was seen for the last time.
   *
   * The quiet window measures the time since the last REAL work: a running
   * turn or a queued message. The host polls the agent list every few
   * seconds, so this marker follows the work exactly — and it is NOT reset by
   * the routine session events the interface produces while it synchronises
   * (those used to reset the window every 2-3 seconds, so a window longer
   * than that interval could never fill and the restart never fired).
   */
  let lastBusyAt = 0

  /**
   * When the "the restart is waiting for a long time" line was logged last.
   *
   * The gate polls every few seconds, so the line is rate limited: at most one
   * per minute for the SAME restart request. A new request (`requestedAt`
   * changed) logs right away.
   */
  let longWaitLog = { at: 0, requestedAt: 0 }
/** The last "this restart is still queued" line: one per minute per request. */
let queueDiagLog = { at: 0, requestedAt: 0 }

  /**
   * When the diagnostic line of the restart gate was logged last.
   *
   * The gate is evaluated every few seconds, so the line is rate limited to
   * once a minute: it says what the gate decided and why, which is the first
   * thing to look at when "the restart never happens" is reported.
   */
  let lastDecisionLogAt = 0

  /**
   * WHO reset the quiet window last — DIAGNOSTICS ONLY (2026-11-02).
   *
   * `lastActivityAt` is what the settle window counts from. Until now nothing
   * recorded WHICH event moved it, so "the restart never fires" could only be
   * guessed at: a member's status report, the interface syncing, a queued
   * message — all three look identical from the outside.
   *
   * This records the source of the last reset. It changes NO decision: the
   * callers below were already calling `noteActivity()`, and they still call it
   * exactly where they did before. The only new thing is the label.
   */
  let quietReset = { by: 'none', at: 0, sessionId: null, isSubagent: false }

  /** The reset source as the payloads expose it (flat keys, easy to read). */
  const quietResetInfo = () => ({
    quietResetBy: quietReset.by,
    quietResetAt: quietReset.at,
    quietResetSessionId: quietReset.sessionId,
    quietResetIsSubagent: quietReset.isSubagent,
  })

  /**
   * THE LAST GATE DECISION, as it was written down.
   *
   * `null` means no decision has been recorded on this machine yet. It is never
   * invented: an absent record is reported as absent.
   *
   * WHY ITS OWN FILE (`restart-gate.json` next to the state file): the state
   * document is rebuilt from a whitelist on every boot, so any extra key put
   * there is dropped — and it also marks the state as "repaired", which is a
   * false alarm. A separate file keeps the two concerns apart.
   */
  let lastGateRecord = null

  /** Where the gate record lives. */
  const gateRecordPath = () => path.join(path.dirname(stateFile), 'restart-gate.json')

  /** The record of the previous boots; null when there is none (or it is broken). */
  const readGateRecordFile = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(gateRecordPath(), 'utf8'))
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /** Write the record down. A failure is logged, never thrown: this is diagnostics. */
  const writeGateRecordFile = (record) => {
    try {
      fs.writeFileSync(gateRecordPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      log.warn('could not write the restart-gate record:', String(error))
      return false
    }
  }

  /**
   * The last gate decision: what it was, why, who blocked it, how long the
   * request had waited and how many attempts there were — plus the reset source
   * AS IT WAS at that decision (the live one is reported separately, next to it,
   * so the two are never confused).
   *
   * `null` when the gate has not decided anything on this machine yet.
   */
  const restartGateInfo = () => {
    const recorded = lastGateRecord !== null ? lastGateRecord : readGateRecordFile()
    return recorded === null ? null : { ...recorded }
  }

  /**
   * Record REAL conversation activity (a turn that started or ended, a message
   * that was queued, a session event that says work happened).
   *
   * The routine session events of the interface do NOT go through here: they
   * would keep the quiet window from ever filling.
   *
   * @param {'agent-status'|'session-event'|'inbox-inserted'} [source] where the
   *   activity came from (diagnostics only — the window moves either way)
   * @param {{ sessionId?: string|null, isSubagent?: boolean }} [detail] what it
   *   was about, when the caller knows
   */
  const noteActivity = (source = 'session-event', detail = {}) => {
    const now = Date.now()
    // A ROUTINE HEARTBEAT IS NOT WORK (2026-11-02). The host pulses
    // `agent/status` every few seconds per session; the docstring above always
    // claimed those pulses do not reach here, and they did (see the
    // `agent/status` hook: `runtime.noteActivity('agent-status', ...)`). Since
    // `quietSince()` reads this marker, every pulse re-armed the settle window -
    // a 10 s window could never fill against a 2-3 s heartbeat, so the restart
    // never fired. The heartbeat is still recorded for the diagnostics (who
    // reset the window, and when); it just does not count as work.
    if (source === 'agent-status') {
      quietReset = {
        by: source,
        at: now,
        sessionId: detail.sessionId === undefined || detail.sessionId === null ? null : String(detail.sessionId),
        isSubagent: detail.isSubagent === true,
      }
      return
    }
    lastActivityAt = now
    quietReset = {
      by: source,
      at: lastActivityAt,
      sessionId: detail.sessionId === undefined || detail.sessionId === null ? null : String(detail.sessionId),
      isSubagent: detail.isSubagent === true,
    }
  }

  /** Queued inbox messages an agent still has to process (nextTurn / nextStep). */
  const pendingInboxCount = (agent) => {
    let count = 0
    try {
      const inbox = agent && agent.inbox
      if (!inbox) return 0
      for (const key of ['nextTurn', 'nextStep']) {
        const queue = inbox[key]
        if (Array.isArray(queue) && queue.length > 0) count += queue.length
      }
      if (count === 0 && inbox.hasPending === true) count = 1
    } catch {}
    return count
  }

  /**
   * A short human-readable duration for the log ("45s", "2m 5s", "1h 3m").
   *
   * @param {number} ms
   * @returns {string}
   */
  const describeWait = (ms) => {
    const total = Math.max(0, Math.round(Number(ms) || 0))
    const seconds = Math.floor(total / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
      const rest = seconds % 60
      return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
    }
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  }

  /**
   * The readable names of the sessions that hold the restart.
   *
   * A session without a title falls back to its id: the log has to say WHO
   * holds the restart, and an empty name would say nothing.
   *
   * @param {any[]} blockedBy
   * @returns {string}
   */
  const describeBlockers = (blockedBy) => {
    const list = Array.isArray(blockedBy) ? blockedBy : []
    const names = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const name = typeof entry.name === 'string' && entry.name.trim() !== ''
        ? entry.name.trim()
        : (typeof entry.label === 'string' && entry.label.trim() !== ''
          ? entry.label.trim()
          : String(entry.sessionId || ''))
      if (name === '') continue
      names.push(name)
    }
    if (names.length === 0) return 'another conversation'
    if (names.length === 1) return names[0]
    return names.join(', ')
  }

  /**
   * Whether this agent is a subagent (a delegated child), and which session
   * created it.
   *
   * The origin is the ONLY reliable marker: a forked session also carries a
   * parent session, but it is a top-level conversation, not a subagent.
   *
   * @param {any} agent
   * @returns {string|null} the parent session id, or null when this is not a
   *   subagent
   */
  const subagentParentOf = (agent) => {
    try {
      if (!agent || typeof agent !== 'object') return null
      const session = agent.session && typeof agent.session === 'object' ? agent.session : null
      const header = session && session.header && typeof session.header === 'object' ? session.header : null
      const origin = agent.origin != null ? agent.origin : (header ? header.origin : undefined)
      if (origin !== 'subagent') return null
      const parent = agent.parentId != null
        ? agent.parentId
        : agent.parentSessionId != null
          ? agent.parentSessionId
          : (header ? header.parentSession : undefined)
      if (parent == null || parent === '') return null
      return String(parent)
    } catch {
      return null
    }
  }

  /**
   * The readable identity of one blocker: WHAT it is (a session or a
   * subagent) and HOW it is called.
   *
   * A subagent has no title of its own, so it is named after the session that
   * created it ("<that session>'s subagent"). A raw session id never reaches
   * the interface: an unknown name is a generic one.
   *
   * @param {string} sessionId
   * @param {any} agent
   * @returns {{ kind: 'session'|'subagent', label: string|null, name: string, parentTitle: string|null, parentSessionId: string|null }}
   */
  const describeBlocker = (sessionId, agent) => {
    const parent = agent ? subagentParentOf(agent) : null
    if (parent === null) {
      let title = null
      try { title = sessionTitle(sessionId) } catch { /* a missing title is not a problem */ }
      const label = title ? String(title) : null
      return {
        kind: 'session',
        // The label is the title of the session itself.
        label,
        // The full name of the blocker: its title — or NOTHING when it has no
        // title. A generic name ("会话") says nothing and would end up in the
        // interface as "会话「会话」" or as a list of three identical
        // entries; the client decides what to write when the name is empty.
        name: label || '',
        parentTitle: null,
        parentSessionId: null,
      }
    }
    let parentTitle = null
    try { parentTitle = sessionTitle(parent) } catch { /* a missing title is not a problem */ }
    const title = parentTitle ? String(parentTitle) : null
    return {
      kind: 'subagent',
      // The label is the title of the session that created it: the UI shows
      // "子智能体（<that title>）".
      label: title,
      // The full name of the blocker: "<that session>'s subagent".
      name: title ? `${title}的子智能体` : '子智能体',
      parentTitle: title,
      parentSessionId: parent,
    }
  }

  /**
   * The tracker of the QUEUED messages.
   *
   * It remembers for how long a session has had an unclaimed inbox message, so
   * a message that nobody claims stops blocking the restart instead of
   * blocking it for ever. A session that is RUNNING is never judged here: a
   * live turn always blocks, under every grace setting.
   */
  const queuedTracker = createQueuedTracker()

  /** The sessions the tracker saw in the last round (for the cleanup). */
  const queuedSessions = new Set()

  /**
   * Every conversation that is still working, subagents and teammates included.
   * 'running' is a live turn; 'queued' is inbox work that has not started yet.
   *
   * A queued message only blocks the restart until the grace window
   * (`queuedGraceMs`) is over: after that it is stuck — nobody will ever claim
   * it — so it stops blocking the restart and is named in the log. A running
   * conversation ALWAYS blocks.
   *
   * Every entry carries the kind of the blocker and a readable name, so the
   * interface can tell a session from a subagent and never has to show a raw
   * session id.
   */
  const busyAgents = () => {
    const out = []
    let agents = []
    try {
      agents = ctx.agents.list() || []
    } catch {
      agents = []
    }
    const seen = new Set()
    for (const agent of agents) {
      try {
        if (!agent || !agent.id) continue
        const sessionId = String(agent.id)
        seen.add(sessionId)
        const described = describeBlocker(sessionId, agent)
        if (agent.status === 'running') {
          // A live turn ALWAYS blocks the restart — under every grace
          // setting. The queued timer of that session is dropped: the work is
          // being done, so it is not a stuck queue.
          queuedTracker.forget(sessionId)
          out.push({ sessionId, reason: 'running', ...described })
        } else if (pendingInboxCount(agent) > 0) {
          const observed = queuedTracker.observe(sessionId, true, config.queuedGraceMs)
          if (observed.becameStale) {
            // The message has been waiting longer than the grace window and
            // nobody claimed it: it is stuck. The session is named here, so
            // the user can see WHICH conversation holds the queue.
            log.warn(
              `the queued message of session ${sessionId} has been waiting ${describeWait(observed.ageMs)} and nobody claimed it; it no longer blocks the restart`,
              {
                sessionId,
                ageMs: observed.ageMs,
                queuedGraceMs: config.queuedGraceMs,
              },
            )
          }
          if (observed.blocking) out.push({ sessionId, reason: 'queued', ...described })
        } else {
          // No queued work any more: the timer of that session is dropped, so
          // a NEW queue starts counting from zero.
          queuedTracker.observe(sessionId, false, config.queuedGraceMs)
        }
      } catch {}
    }
    // A session that is gone (closed) drops its record as well.
    for (const sessionId of queuedSessions) {
      if (!seen.has(sessionId)) queuedTracker.forget(sessionId)
    }
    queuedSessions.clear()
    for (const sessionId of seen) queuedSessions.add(sessionId)
    // Real work is still going on: the quiet window starts over. This is the
    // marker that makes the quiet window measure "since the last real work"
    // instead of "since the last session event of any kind".
    if (out.length > 0) lastBusyAt = Date.now()
    return out
  }

  /**
   * The disarmed-goal records of the checkpoint: one entry per session whose
   * goal this plugin disarmed and has not re-armed yet.
   */
  const disarmedGoalRecords = () => (
    state.disarmedGoals && typeof state.disarmedGoals === 'object' ? state.disarmedGoals : {}
  )

  /**
   * The LEGACY (pause-based) parked-goal records of the checkpoint. They are
   * still read so a goal the previous build paused can be resumed once.
   */
  const parkedGoalRecords = () => (
    state.parkedGoals && typeof state.parkedGoals === 'object' ? state.parkedGoals : {}
  )

  /** The live agent of a session, or undefined when it is not attached. */
  const liveAgent = (sessionId) => {
    if (!sessionId) return undefined
    try {
      if (ctx.agents && typeof ctx.agents.get === 'function') {
        const agent = ctx.agents.get(sessionId)
        if (agent) return agent
      }
    } catch {}
    return undefined
  }

  /** The live goal of a session, or undefined when it has none. */
  const goalFor = (sessionId, agent) => {
    const target = agent || liveAgent(sessionId)
    if (!target) return undefined
    try {
      return ctx.goals.get(target)
    } catch {
      return undefined
    }
  }

  /**
   * Disarm the goal of one session so a pending restart can proceed.
   *
   * `ctx.goals.disarm(agent)` removes the process-local continuation authority
   * WITHOUT touching the durable goal: the goal stays `active`, the round that
   * is running right now still finishes normally (no turn is cancelled and
   * nothing is lost), but the goal round driver will not start another round.
   * That is what lets the session go idle so the restart can proceed; after the
   * boot the goal is re-armed through `ctx.goals.resume(...)`.
   *
   * Never throws: a failed disarm is reported instead of propagated, so it can
   * never break the restart gate.
   */
  const disarmGoal = (sessionId, agent) => {
    // A session id like `__proto__` would land on the prototype of the
    // session map: it is refused, and NOTHING is written.
    if (isForbiddenSessionId(sessionId)) {
      return { sessionId, disarmed: false, reason: 'invalid-session-id', error: 'invalid-session-id' }
    }
    const target = agent || liveAgent(sessionId)
    if (!target) {
      return { sessionId, disarmed: false, reason: GOAL_BLOCK_REASONS.NO_AGENT, error: 'session-not-live' }
    }
    const goal = goalFor(sessionId, target)
    if (!goal || typeof goal !== 'object') return { sessionId, disarmed: false, reason: 'no-goal' }
    const goalId = goal.id == null ? null : String(goal.id)
    const { disarms, reported } = selectGoalDisarms([{ sessionId }], {
      getGoal: () => goal,
      disarmedGoals: disarmedGoalRecords(),
      parkedGoals: parkedGoalRecords(),
    })
    if (disarms.length === 0) {
      const reason = reported.length > 0 ? reported[0].reason : 'goal-not-disarmable'
      return { sessionId, disarmed: false, goalId, reason }
    }
    const goals = ctx.goals
    if (!goals || typeof goals.disarm !== 'function') {
      return { sessionId, disarmed: false, goalId, reason: 'disarm-unavailable', error: 'goals.disarm is not available' }
    }
    let outcome
    try {
      outcome = goals.disarm(target)
    } catch (error) {
      return { sessionId, disarmed: false, goalId, reason: 'disarm-failed', error: describeError(error) }
    }
    const onDisarmed = () => {
      setDisarmedGoal(state, sessionId, { goalId, disarmedAt: Date.now() })
      persist()
      log.info(`disarmed goal ${goalId} of session ${sessionId}; the running round still finishes and the goal is re-armed after the restart`)
    }
    if (outcome && typeof outcome.then === 'function') {
      outcome.then(onDisarmed, (error) => {
        log.warn(`could not disarm goal ${goalId} of session ${sessionId}:`, describeError(error))
      })
      return { sessionId, disarmed: true, goalId, reason: GOAL_BLOCK_REASONS.ACTIVE, pending: true }
    }
    onDisarmed()
    return { sessionId, disarmed: true, goalId, reason: GOAL_BLOCK_REASONS.ACTIVE }
  }

  /**
   * The live SESSION of a session id: the readable conversation surface
   * (`deriveMessages` / `requestHeader` / `requestContext` / `snapshotEvents`).
   * Falls back to the live agent's session when the sessions service is absent.
   */
  const liveSession = (sessionId) => {
    if (!sessionId) return undefined
    try {
      const sessions = ctx.get('sessions')
      if (sessions && typeof sessions.get === 'function') {
        const session = sessions.get(String(sessionId))
        if (session) return session
      }
    } catch {}
    const agent = liveAgent(sessionId)
    return agent && agent.session ? agent.session : undefined
  }

  /** Read the readable surface of one live session. Never throws. */
  const readSession = (sessionId) => {
    const session = liveSession(sessionId)
    if (!session) return { session: undefined, messages: undefined, header: undefined, requestContext: undefined, events: undefined }
    const read = (fn) => {
      try {
        return typeof session[fn] === 'function' ? session[fn]() : undefined
      } catch {
        return undefined
      }
    }
    return {
      session,
      messages: read('deriveMessages'),
      header: read('requestHeader'),
      requestContext: read('requestContext'),
      events: read('snapshotEvents'),
    }
  }

  /**
   * The context-overflow verdict of a session, from its LIVE surface only.
   *
   * Evidence: the newest assistant message `usage.inputTokens` versus the
   * session's `contextWindow`, or a recent turn / event that failed with a
   * context-window error. Unknown numbers never mean overflow, so an unknown
   * session keeps the normal resume path. Never throws.
   */
  const overflowFor = (sessionId) => {
    const unknown = { over: false, inputTokens: null, contextWindow: null, detail: null }
    try {
      const read = readSession(sessionId)
      if (!read.session) return unknown
      const info = read.requestContext
      const contextWindow = info && typeof info === 'object' && Number.isFinite(info.contextWindow) ? info.contextWindow : null
      return contextOverflow({ messages: read.messages, contextWindow, events: read.events })
    } catch {
      return unknown
    }
  }

  /**
   * Hand an over-limit session off to a fresh, usable session.
   *
   * A session whose conversation outgrew the model window can neither continue
   * nor be compacted: every request fails with "context window exceeds limit",
   * and the compaction request needs the same oversized context. The handoff
   * carries what still fits — the goal objective, the checkpoint reasons and a
   * bounded tail of the conversation — into a NEW live agent/session, then marks
   * the old session and disarms its goal so it stops issuing doomed requests.
   *
   * Nothing is created when the source cannot be read.
   *
   * @param {{ sessionId?: string, maxChars?: number, callerAgent?: object }} [options]
   * @returns {Promise<object>} `{ ok, sessionId, carriedChars, instruction }`
   */
  const handoff = async ({ sessionId, maxChars, callerAgent } = {}) => {
    const requested = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
    const sourceId = requested !== null ? requested : (callerAgent && callerAgent.id ? String(callerAgent.id) : null)
    if (sourceId === null) {
      return { ok: false, error: 'no-session', instruction: 'No source session: pass sessionId, or call this tool from the session that should be handed off.' }
    }
    // A session id like `__proto__` would land on the prototype of the
    // session map: it is refused, and NOTHING is written.
    if (isForbiddenSessionId(sourceId)) {
      return {
        ok: false,
        error: 'invalid-session-id',
        sourceSessionId: sourceId,
        detail: `"${sourceId}" is not a usable session id.`,
      }
    }
    const read = readSession(sourceId)
    if (!read.session) {
      return {
        ok: false,
        error: 'source-session-not-live',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} is not live in this process, so its conversation cannot be read and no handoff was created.`,
      }
    }
    if (read.messages === undefined) {
      return {
        ok: false,
        error: 'source-unreadable',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} did not expose its messages, so no handoff was created.`,
      }
    }
    const header = read.header
    const cwd = header && typeof header.cwd === 'string' && path.isAbsolute(header.cwd) ? header.cwd : null
    if (cwd === null) {
      return {
        ok: false,
        error: 'source-cwd-unknown',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} has no absolute working directory in its header, so a new session could not be created for the handoff.`,
      }
    }

    const goal = goalFor(sourceId)
    const objective = goal && typeof goal === 'object'
      ? [goal.objective, goal.title, goal.description].find((value) => typeof value === 'string' && value.trim() !== '') ?? null
      : null
    const entry = sessionEntry(state, sourceId)
    const goalLabel = entry && entry.goal && entry.goal.goalId != null
      ? String(entry.goal.goalId)
      : (goal && goal.id != null ? String(goal.id) : null)
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : HANDOFF_DEFAULT_MAX_CHARS
    const composed = composeHandoff({
      sessionId: sourceId,
      objective,
      goalLabel,
      reasons: entry && Array.isArray(entry.reasons) ? entry.reasons : [],
      messages: read.messages,
      maxChars: budget,
    })

    const newSessionId = 'session-' + crypto.randomUUID()
    let created
    try {
      created = await ctx.agents.create({
        sessionId: newSessionId,
        meta: { cwd, parentSession: sourceId, createdAt: Date.now() },
      })
    } catch (error) {
      const detail = describeError(error)
      log.warn(`could not create the handoff session for ${sourceId}:`, detail)
      return {
        ok: false,
        error: 'create-failed',
        sourceSessionId: sourceId,
        detail,
        instruction: `The new session could not be created (${detail}); session ${sourceId} is unchanged.`,
      }
    }
    let newAgent = created && typeof created === 'object' ? (created.agent ?? created.handle ?? created) : undefined
    if (!newAgent || typeof newAgent.followup !== 'function' || newAgent.id === undefined) newAgent = liveAgent(newSessionId)
    if (!newAgent || typeof newAgent.followup !== 'function') {
      return {
        ok: false,
        error: 'handoff-agent-unavailable',
        sourceSessionId: sourceId,
        sessionId: newSessionId,
        instruction: `The new session ${newSessionId} exposes no agent to deliver the handoff text to; session ${sourceId} is unchanged.`,
      }
    }
    const continueId = newAgent.id === undefined || newAgent.id === null ? newSessionId : String(newAgent.id)
    try {
      newAgent.followup(createContinuationMessage(composed.text, {
        summary: 'handoff of a session that exceeded the model context window',
      }))
    } catch (error) {
      const detail = describeError(error)
      log.warn(`the handoff text was rejected for ${continueId}:`, detail)
      return {
        ok: false,
        error: 'deliver-failed',
        sourceSessionId: sourceId,
        sessionId: continueId,
        detail,
        instruction: `The handoff text could not be delivered to ${continueId} (${detail}); session ${sourceId} is unchanged.`,
      }
    }

    const at = Date.now()
    setHandoff(state, sourceId, { handedOffTo: continueId, handoffAt: at, carriedChars: composed.carriedChars })
    setRecoveryOutcome(state, sourceId, { action: 'handed-off', detail: `handed off to ${continueId}`, now: at })
    persist()

    // (e) the over-limit session must stop issuing doomed requests.
    let disarmedGoal = false
    try {
      const result = disarmGoal(sourceId, requested === null ? callerAgent : undefined)
      disarmedGoal = result.disarmed === true
    } catch (error) {
      log.warn(`could not disarm the goal of the handed-off session ${sourceId}:`, describeError(error))
    }
    log.info(`handed session ${sourceId} off to ${continueId} (${composed.carriedChars} characters carried)`)
    return {
      ok: true,
      sourceSessionId: sourceId,
      sessionId: continueId,
      carriedChars: composed.carriedChars,
      carriedTailChars: composed.tailChars,
      disarmedGoal,
      instruction: `Continue the work in the new session ${continueId}. The old session ${sourceId} is kept and marked as handed off: its goal is disarmed and it is never auto-resumed again.`,
    }
  }

  /**
   * Disarm the goals of the sessions that block the pending restart.
   *
   * A goal-driven session keeps its own agent busy (the goal round driver
   * starts the next round within milliseconds), so the restart gate would never
   * open. Disarming removes that authority: the CURRENT round finishes
   * normally, no new round starts, the session goes idle and the next poll sees
   * a quiet host. Goals are never paused and no turn is ever cancelled.
   */
  const disarmBlockingGoals = (busy) => {
    const restart = state.restart
    if (!restart) return { disarmed: [], reported: [] }
    if (restart.parkGoals === false) return { disarmed: [], reported: [], skipped: 'park-goals-disabled' }
    const list = Array.isArray(busy) ? busy : []
    if (list.length === 0) return { disarmed: [], reported: [] }
    const { disarms, reported } = selectGoalDisarms(list, {
      getGoal: (sessionId) => goalFor(sessionId),
      disarmedGoals: disarmedGoalRecords(),
      parkedGoals: parkedGoalRecords(),
    })
    const disarmed = []
    for (const item of disarms) {
      try {
        const result = disarmGoal(item.sessionId)
        if (result.disarmed) disarmed.push(result)
        else log.warn(`could not disarm the goal of session ${item.sessionId}: ${result.reason}${result.error ? ` (${result.error})` : ''}`)
      } catch (error) {
        log.warn(`disarming the goal of session ${item.sessionId} failed:`, describeError(error))
      }
    }
    return { disarmed, reported }
  }

  /**
   * The goals THIS queued restart disarmed, so withdrawing the request can put
   * them back (sessionId → { goalId, disarmedAt, reason }).
   */
  const queuedGoalDisarms = new Map()

  /** What the queued restarts took away, for the status surfaces. */
  const queuedGoalDisarmList = () => [...queuedGoalDisarms.entries()].map(([sessionId, entry]) => ({
    sessionId,
    goalId: entry.goalId,
    disarmedAt: entry.disarmedAt,
    reason: entry.reason,
  }))

  /**
   * DISARM THE GOAL OF THE SESSION THAT ASKED FOR THE RESTART — AT ONCE.
   *
   * Real reading (restart-gate.json, 2026-11-02): a restart asked for by a
   * goal-driven session waited 39 minutes with `attempts: 0`. The gate was fine
   * — `action: "allow", reason: "no-agent-running", quietForMs: 12412` the
   * moment the root session really stopped. The deadlock was elsewhere: the goal
   * round driver starts the next round a few seconds after the last one ended,
   * so the 10-second settle window never filled. Waiting for "the busy session
   * to go idle" cannot work: between two rounds it IS idle, and the next round
   * starts first.
   *
   * So the disarm happens when the request is QUEUED, not when the gate finally
   * opens (by then the request has been waiting forever):
   *   - the round that is running right now still finishes normally;
   *   - no new round starts;
   *   - the quiet window fills, the gate allows, the restart happens;
   *   - after the restart the existing boot recovery re-arms the goal.
   *
   * A session WITHOUT a goal is untouched: `disarmGoal` answers `no-goal` and
   * nothing is written.
   *
   * @param {string|string[]} sessionIds the requester(s)
   * @param {{ reason?: string }} [options]
   */
  const disarmQueuedRestartGoals = (sessionIds, { reason = 'restart-queued' } = {}) => {
    const list = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
    const disarmed = []
    const reported = []
    for (const raw of list) {
      const sessionId = raw === undefined || raw === null ? '' : String(raw)
      if (sessionId === '') continue
      // 'settings' is the page itself, not a conversation: it has no goal.
      if (sessionId === 'settings') continue
      if (queuedGoalDisarms.has(sessionId)) continue
      try {
        const result = disarmGoal(sessionId)
        if (result.disarmed === true) {
          queuedGoalDisarms.set(sessionId, {
            goalId: result.goalId === undefined ? null : result.goalId,
            disarmedAt: Date.now(),
            reason,
          })
          // WHY this goal is disarmed, written into the record next to the
          // timestamp: `disarmedAt` alone cannot tell a restart from a rescue.
          const record = disarmedGoalEntry(state, sessionId)
          if (record && typeof record === 'object') record.reason = reason
          disarmed.push(result)
        } else {
          reported.push(result)
        }
      } catch (error) {
        reported.push({ sessionId, disarmed: false, reason: 'disarm-failed', error: describeError(error) })
      }
    }
    if (disarmed.length > 0) persist()
    return { disarmed, reported }
  }

  /**
   * PUT BACK THE GOALS A QUEUED RESTART TOOK AWAY (the withdraw path).
   *
   * A cancelled restart must not leave the session standing still for ever: the
   * goal is re-armed here, immediately, with the revision it has NOW (a stale
   * revision is refused loudly, never silently).
   *
   * @param {{ reason?: string }} [options]
   */
  const rearmQueuedRestartGoals = ({ reason = 'restart-cancelled' } = {}) => {
    const resumed = []
    const failed = []
    for (const [sessionId, entry] of [...queuedGoalDisarms.entries()]) {
      const target = liveAgent(sessionId)
      const goal = target ? goalFor(sessionId, target) : null
      if (!target || !goal || typeof goal !== 'object' || !ctx.goals || typeof ctx.goals.resume !== 'function') {
        // Nothing to resume (the session is gone, or it never had a goal): the
        // record goes, so it cannot be reported as pending for ever.
        queuedGoalDisarms.delete(sessionId)
        failed.push({ sessionId, goalId: entry.goalId, reason: target ? 'no-goal' : 'session-not-live' })
        continue
      }
      try {
        ctx.goals.resume(target, { id: goal.id, revision: goal.revision })
        stampResumedGoal(state, sessionId, { resumedAt: Date.now() })
        queuedGoalDisarms.delete(sessionId)
        resumed.push({ sessionId, goalId: goal.id, reason })
        log.info(`re-armed goal ${goal.id} of session ${sessionId}: the restart was withdrawn (${reason})`)
      } catch (error) {
        failed.push({ sessionId, goalId: goal.id, reason: 'resume-failed', error: describeError(error) })
        log.warn(`could not re-arm goal ${goal.id} of session ${sessionId} after the restart was withdrawn:`, describeError(error))
      }
    }
    if (resumed.length > 0) persist()
    return { resumed, failed }
  }

  const anyAgentRunning = () => busyAgents().length > 0

  /**
   * Whether a restart is still pending.
   *
   * A pending restart goes FIRST: the graceful shutdown waits for it — and for
   * the sessions that resume with it. The shutdown intent survives the
   * restart, so the machine goes off after everything is done.
   *
   * @returns {boolean}
   */
  const pendingRestart = () => state.restart !== null && state.restart !== undefined

  /**
   * The moment the quiet window started.
   *
   * It is the LATER of the two markers:
   *   - `lastActivityAt`: the last real activity signal (a turn that started
   *     or ended, a message that was queued);
   *   - `lastBusyAt`: the last moment a conversation was seen working (a
   *     running turn or a queued message).
   *
   * The routine session events of the interface (a title, a projection, a
   * context request) are NOT activity: they arrive every two to three
   * seconds, so counting them would keep the quiet window from ever filling
   * — and the restart would never fire.
   *
   * @returns {number} a timestamp in milliseconds
   */
  const quietSince = () => Math.max(lastActivityAt, lastBusyAt)

  /** How long the host has been quiet (no real conversation activity at all). */
  const quietForMs = () => Math.max(0, Date.now() - quietSince())

  /**
   * The RESTART reserve: how much longer the host waits after the last
   * conversation finished before it is really restarted.
   *
   * A restart is a daily operation, so the default is none: the host restarts
   * as soon as the conversations are done and the settle window has passed.
   */
  const graceMs = () => config.restartGraceMs

  /**
   * The quiet window the restart gate really uses.
   *
   * It is the settle window, but never shorter than the grace window: the
   * grace is the *extra* wait on top of the settle, not a replacement.
   */
  const effectiveSettleMs = () => Math.max(config.settleMs, config.restartGraceMs)

  /** The two-layer restart gate: no busy conversation AND a quiet window. */
  const gate = () => restartGate(state, {
    busyAgents: busyAgents(),
    lastActivityAt: quietSince(),
    now: Date.now(),
    settleMs: effectiveSettleMs(),
  })

  /**
   * The description of a LONG wait, or null when nothing holds the restart.
   *
   * THERE IS NO THRESHOLD (user decision, 2026-11-02). The old version only called
   * the wait "long" once a hard deadline had passed — which made the user wait in
   * silence for fifteen minutes before the page admitted anything, and made the
   * plugin look like it had given up. A restart that is held by a conversation is
   * a wait from the first second: the page shows how long it has been waiting,
   * why, and who holds it.
   *
   * @param {number} [now]
   * @returns {{ since: number, reason: string, waitedMs: number, blockedBy: any[] }|null}
   */
  const longWaitInfo = (now = Date.now()) => {
    const restart = state.restart
    if (!restart || typeof restart !== 'object') return null
    const requestedAt = Number.isFinite(restart.requestedAt) ? restart.requestedAt : 0
    if (requestedAt <= 0) return null
    const verdict = gate()
    if (verdict.allow) return null
    const blockedBy = goalAwareBlockingDetails(runtime, verdict.blockedBy)
    if (blockedBy.length === 0) return null
    return {
      since: requestedAt,
      reason: 'waiting-for-conversations',
      waitedMs: Math.max(0, now - requestedAt),
      blockedBy,
    }
  }

  /**
   * Cached session titles, used to label the blocking sessions in the
   * client's "pending restart" details panel.
   *
   * This is strictly best effort: the health route is a read-only probe that
   * must never fail, so a missing session controller, a rejected list call or
   * a session without a title simply means "no title" (the field is omitted).
   * The list is read at most every SESSION_TITLE_CACHE_MS, and the refresh
   * runs detached (the route handler is synchronous and never blocks on it).
   */
  const titleCache = { at: 0, titles: new Map(), inFlight: false }

  /**
 * The title of one row of the session list.
 *
 * The title is a PROJECTION: the summary row carries it under
 * `projections.values.title` (the same place `dsh-session-reference` reads it
 * from), not under a `title` field of its own. A plain `title`/`name` is
 * accepted too, so a list with a different shape still works.
 *
 * @param {any} item one row of the session list
 * @returns {string} the title, or '' when the row carries none
 */
const titleOfSummary = (item) => {
  try {
    if (!item || typeof item !== 'object') return ''
    const projections = item.projections && typeof item.projections === 'object'
      ? item.projections
      : null
    const values = projections && projections.values && typeof projections.values === 'object'
      ? projections.values
      : null
    const candidates = [
      values ? values.title : undefined,
      item.title,
      item.name,
    ]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const title = candidate.trim()
      if (title !== '') return title
    }
    return ''
  } catch {
    return ''
  }
}

/** Store the titles of one session-list answer. Never throws. */
  const applySessionTitles = (payload) => {
    const items = payload && Array.isArray(payload.items)
      ? payload.items
      : (Array.isArray(payload) ? payload : [])
    const titles = new Map()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      // The session list names its rows `sessionId` (`id` is an older shape).
      const rawId = item.sessionId !== undefined && item.sessionId !== null
        ? item.sessionId
        : item.id
      const id = rawId === undefined || rawId === null ? '' : String(rawId)
      if (!id) continue
      const title = titleOfSummary(item)
      if (title) titles.set(id, title)
    }
    titleCache.titles = titles
  }

  /** Kick off one session-list read. Never throws and never blocks the caller. */
  const refreshSessionTitles = () => {
    if (titleCache.inFlight) return
    titleCache.at = Date.now()
    let controller
    try {
      controller = ctx.get('sessionController')
    } catch {
      return
    }
    if (!controller || typeof controller.list !== 'function') return
    titleCache.inFlight = true
    const settle = (payload) => {
      titleCache.inFlight = false
      try {
        applySessionTitles(payload)
      } catch {
        // A malformed answer is ignored; the panel simply shows no title.
      }
    }
    let payload
    try {
      payload = controller.list({})
    } catch {
      titleCache.inFlight = false
      return
    }
    if (payload && typeof payload.then === 'function') {
      payload.then(settle, () => { titleCache.inFlight = false })
      return
    }
    settle(payload)
  }

  /** The cached title of one session, or undefined when it is unknown. */
  const sessionTitle = (sessionId) => {
    try {
      if (sessionId === undefined || sessionId === null) return undefined
      const id = String(sessionId)
      if (!id) return undefined
      if (Date.now() - titleCache.at >= SESSION_TITLE_CACHE_MS) refreshSessionTitles()
      const title = titleCache.titles.get(id)
      return title ? title : undefined
    } catch {
      return undefined
    }
  }

  const flushSessions = async () => {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.flush !== 'function') {
      log.warn('sessions.flush is unavailable; the pre-restart durability flush is skipped')
      return
    }
    for (const agent of ctx.agents.list()) {
      try {
        await sessions.flush(agent.session)
      } catch (error) {
        log.warn(`sessions.flush failed for ${agent.id}:`, String(error))
      }
    }
  }

  /**
   * Release the continuation request of the sessions that asked for the current
   * restart (cancel / give-up paths). Requests are coalesced into ONE restart, so
   * releasing only the last requester would leave the others pinned as pending.
   *
   * `only` releases EXACTLY those sessions — that is how one session withdraws
   * its own request without touching the requests of the other sessions.
   *
   * @param {string[]|null} [only] the sessions to release; null = every requester
   */
  const releaseRequesters = (only = null) => {
    const ids = new Set()
    if (Array.isArray(only)) {
      for (const sessionId of only) {
        if (typeof sessionId === 'string' && sessionId) ids.add(sessionId)
      }
    } else {
      const restart = state.restart
      if (!restart) return
      if (Array.isArray(restart.requesters)) {
        for (const requester of restart.requesters) {
          if (requester && typeof requester.sessionId === 'string' && requester.sessionId) ids.add(requester.sessionId)
        }
      }
      if (typeof restart.bySessionId === 'string' && restart.bySessionId) ids.add(restart.bySessionId)
    }
    for (const sessionId of ids) {
      const entry = sessionEntry(state, sessionId)
      if (!entry) continue
      entry.pendingResume = false
      entry.interrupted = false
      markIdle(state, sessionId, { now: Date.now() })
    }
  }

  /** Roll back a scheduled restart: back off, and give up instead of looping forever. */
  const rollbackRestart = (reason) => {
    if (!state.restart) return
    state.restart.failedAttempts = (Number(state.restart.failedAttempts) || 0) + 1
    if (state.restart.failedAttempts >= 2) {
      log.error('restart could not be scheduled twice; cancelling the pending restart instead of retrying forever:', reason)
      // THE REQUEST IS GONE, SO IT SAYS SO: reason + who + when go into
      // last-restart-request.json (this used to be a log line and nothing else).
      dropRestartRequest({
        reason: 'the restart could not be scheduled twice: ' + String(reason),
        by: 'rollback',
        extra: { failedAttempts: state.restart.failedAttempts },
      })
      return
    }
    // A retry is scheduled: the stage goes back to waiting, WITH the reason, so
    // no surface keeps showing the step that already ended.
    deferRestartStage(String(reason))
    recordRestartRequestFate(RESTART_REQUEST_STATES.DEFERRED, {
      reason: 'the restart could not be scheduled (retrying once): ' + String(reason),
      by: 'rollback',
      extra: { failedAttempts: state.restart.failedAttempts },
    })
    setPhase(state, 'deferred')
    if (state.restart.attempt > 0) state.restart.attempt -= 1
    // Back off before the next attempt: no tight retry loop on a broken scheduler.
    state.restart.notBefore = Date.now() + Math.max(5000, config.deferPollMs * 4)
    persist()
    startPolling()
    log.error('restart could not be scheduled; retrying once after a short backoff:', reason)
  }

  /**
   * Recovery timer for a scheduled restart. If this process is still alive after the
   * helper's delay, the helper refused to kill (the idle gate denied it): roll back
   * to 'deferred' and poll again instead of leaving the phase stuck at 'restarting'.
   */
  const armGateRecoveryTimer = () => {
    try {
      ctx.timeout(() => {
        if (disposed || !state.restart || state.phase !== 'restarting') return
        const aborts = (Number(state.restart.gateAborts) || 0) + 1
        state.restart.gateAborts = aborts
        if (state.restart.attempt > 0) state.restart.attempt -= 1
        // The helper refused to kill this process (a conversation is active): the
        // restart is postponed, so the stage must say 'waiting' — this is the
        // exact path that left the backup card on screen for ever.
        deferRestartStage('detached helper denied the idle gate', {
          blocked: countBlockerTasks(gate().blockedBy),
        })
        recordRestartRequestFate(RESTART_REQUEST_STATES.DEFERRED, {
          reason: 'the detached helper denied the idle gate (the request is kept)',
          by: 'gate-recovery',
          extra: { gateAborts: aborts },
        })
        setPhase(state, 'deferred')
        if (aborts > 20) {
          log.error('the detached helper aborted on the idle gate more than 20 times; the next attempt is scheduled UNGATED:', { gateAborts: aborts })
        } else {
          log.warn('the detached restart helper did not kill this process (idle gate denied); waiting for the next quiet window', { gateAborts: aborts })
        }
        persist()
        startPolling()
      }, Math.max(1000, (config.relaunchDelaySeconds + 20) * 1000))
    } catch (error) {
      log.warn('could not arm the restart gate recovery timer:', String(error))
    }
  }

  /** The loopback URL the detached helper re-checks immediately before killing. */
  const restartGateUrl = () => {
    const port = runtime.webPort
    if (!Number.isFinite(port) || port <= 0) return null
    return 'http://127.0.0.1:' + port + resolveHealthPath(config) + '?gate=1'
  }

  /** The plain health URL the rollback watcher polls after the relaunch. */
  const restartHealthUrl = () => {
    const port = runtime.webPort
    if (!Number.isFinite(port) || port <= 0) return null
    return 'http://127.0.0.1:' + port + resolveHealthPath(config)
  }

  /**
   * The state directory of this plugin (the checkpoint, the backups, the
   * instance record and the helper scripts live next to each other).
   */
  const stateDirOf = () => path.dirname(stateFile)

  /**
   * THE STAGE LINE of a restart ("waiting / backing up / restarting / back").
   *
   * It is written ONCE per stage change and persisted IMMEDIATELY, because the
   * whole point of it is the first second after the click: a stage that reaches
   * the interface only after the 156 MB snapshot would tell the user nothing
   * about the ten seconds they spent wondering whether the button worked.
   *
   * @param {string} phase one of RESTART_PHASES
   * @param {{ blocked?: number, now?: number }} [options]
   * @returns {object|null} the recorded stage
   */
  /**
   * HOW OFTEN THE IDLE GATE IS RE-CHECKED WHILE THE HOST WAITS TO BE KILLED.
   *
   * THE REPORT (user, 2026-10-30): after the backup the card said "正在重启…" for
   * 25 s while nothing was restarting — the helper was still waiting for its own
   * idle re-check, and only THEN did the stage go back to 'waiting'. 300–500 ms
   * is the window the owner asked for: a restart that is not going to happen must
   * be downgraded before anybody reads the old word.
   */
  const RESTART_BUSY_CHECK_MS = 350
  let restartBusyTimer = null

  /** Stop the re-check of the idle gate (idempotent). */
  const stopRestartBusyWatch = () => {
    if (restartBusyTimer === null) return
    try {
      restartBusyTimer()
    } catch {
      // The timer belongs to a disposed fiber already.
    }
    restartBusyTimer = null
  }

  /**
   * WHILE THE STAGE SAYS 'restarting', NOBODY MAY BECOME BUSY UNNOTICED.
   *
   * 'restarting' is a CLAIM: from here on the only thing left is the process
   * being killed. A conversation that starts while the helper waits makes that
   * claim false, so it is withdrawn at once (the gate is re-checked four times a
   * second) instead of being discovered by the helper half a minute later.
   */
  const armRestartBusyWatch = () => {
    stopRestartBusyWatch()
    restartBusyTimer = ctx.interval(() => {
      if (disposed) return stopRestartBusyWatch()
      const record = state.restartPhase
      // Only a stage that still claims 'restarting' is watched: every other
      // stage already says the truth.
      if (!record || typeof record !== 'object' || record.phase !== 'restarting') {
        return stopRestartBusyWatch()
      }
      if (!state.restart) return stopRestartBusyWatch()
      let verdict
      try {
        verdict = gate()
      } catch {
        return undefined
      }
      if (verdict && verdict.allow === true) return undefined
      log.warn('a conversation became active while the restart was being carried out; the stage goes back to waiting', {
        reason: verdict ? verdict.reason : null,
        blockedBy: verdict ? verdict.blockedBy : null,
      })
      deferRestartStage('conversation-active while restarting', {
        blocked: verdict && Array.isArray(verdict.blockedBy) ? countBlockerTasks(verdict.blockedBy) : 0,
      })
      recordRestartRequestFate(RESTART_REQUEST_STATES.DEFERRED, {
        reason: 'a conversation became active while the restart was being carried out (the request is kept)',
        by: 'busy-watch',
      })
      setPhase(state, 'deferred')
      persist()
      startPolling()
      return stopRestartBusyWatch()
    }, RESTART_BUSY_CHECK_MS)
    return restartBusyTimer
  }

  const markRestartStage = (phase, { blocked = 0, now = Date.now(), reason = null, snapshotBytes } = {}) => {
    if (!RESTART_PHASES.includes(phase)) return null
    const record = setRestartPhase(state, { phase, blocked, now, reason, snapshotBytes })
    persist()
    return record
  }

  /**
   * REMEMBER THE SNAPSHOT THIS REQUEST ALREADY TOOK.
   *
   * THE REPORT (user, 2026-10-30): the copy finished, a conversation postponed the
   * restart, and the retry started copying the whole 205 MB again. The snapshot is
   * the rollback point of THIS restart; it does not get stale because the restart
   * had to wait. It is stored on the request, so withdrawing or carrying out the
   * request throws it away by itself.
   *
   * @param {object} snapshot the value the snapshot entry returned
   */
  const rememberSnapshot = (snapshot) => {
    if (!state.restart || typeof state.restart !== 'object') return
    const backup = snapshot && typeof snapshot === 'object' && snapshot.backup && typeof snapshot.backup === 'object'
      ? snapshot.backup
      : null
    if (!backup || backup.ok !== true || typeof backup.dir !== 'string' || backup.dir === '') return
    const number = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
    state.restart.snapshot = {
      // The request this copy belongs to: a different request must start over.
      requestedAt: Number.isFinite(state.restart.requestedAt) ? state.restart.requestedAt : 0,
      dir: backup.dir,
      profileDir: typeof snapshot.profileDir === 'string' && snapshot.profileDir !== '' ? snapshot.profileDir : null,
      files: number(backup.files),
      bytes: number(backup.bytes),
      total: number(backup.totalBytes) || number(backup.bytes),
      at: Date.now(),
    }
    persist()
    log.info('the pre-restart snapshot of this request is remembered; a retry reuses it', {
      dir: backup.dir,
      bytes: state.restart.snapshot.bytes,
    })
  }

  /**
   * THE SNAPSHOT THIS REQUEST ALREADY PAID FOR, if it is still usable.
   *
   * All three conditions must hold, or the restart copies again:
   *   1. it belongs to THE SAME request (same `requestedAt`),
   *   2. the backup directory is still there,
   *   3. its manifest is readable and reports the size that was recorded — a
   *      half-deleted or replaced directory never passes for a rollback point.
   *
   * @returns {object|null}
   */
  const reusableSnapshot = () => {
    const request = state.restart
    if (!request || typeof request !== 'object') return null
    const saved = request.snapshot
    if (!saved || typeof saved !== 'object') return null
    if (!Number.isFinite(saved.requestedAt) || !Number.isFinite(request.requestedAt)) return null
    if (saved.requestedAt !== request.requestedAt) return null
    if (typeof saved.dir !== 'string' || saved.dir === '') return null
    try {
      if (!fs.existsSync(saved.dir)) return null
      const manifest = readManifest(saved.dir)
      if (!manifest || typeof manifest !== 'object') return null
      if (Number.isFinite(manifest.bytes) && Number.isFinite(saved.bytes) && manifest.bytes !== saved.bytes) return null
    } catch {
      return null
    }
    return saved
  }

  /** The size this request's snapshot already has, for the stage record. */
  const knownSnapshotBytes = () => {
    const saved = state.restart && state.restart.snapshot
    return saved && typeof saved === 'object' && Number.isFinite(saved.bytes) ? saved.bytes : null
  }

  /**
   * Send the stage BACK TO WAITING — the one way a postponed restart is recorded.
   *
   * WHY (user report, 2026-10-29): a restart that had already written
   * 'snapshotting' and was then postponed (a conversation became active again,
   * the detached helper refused to kill this process, a retry was scheduled)
   * left that stage on disk. The interface drew a card for a copy that had long
   * finished, and the card never went away. Every deferral now goes through
   * here, so the stage always says the truth: waiting.
   *
   * @param {string} reason why the restart was postponed
   * @param {{ blocked?: number }} [options]
   * @returns {object|null} the recorded stage
   */
  const deferRestartStage = (reason, { blocked = 0 } = {}) => {
    const text = typeof reason === 'string' && reason !== '' ? 'deferred: ' + reason : 'deferred'
    const count = Number.isFinite(blocked) ? blocked : 0
    // A request that already took its snapshot keeps saying how big it is: the
    // number is a fact of this restart and does not expire while it waits.
    return markRestartStage('waiting', { blocked: count, reason: text, snapshotBytes: knownSnapshotBytes() })
  }

  /**
   * Record the REAL progress of the running snapshot (files and bytes).
   *
   * The copy loop calls this between files; the checkpoint is written with a
   * small throttle, because a state write per copied file would slow the copy
   * down for no gain. The in-memory record is always current, so a `state=1`
   * poll that arrives between two writes still sees the newest numbers.
   *
   * @param {{ files?: number, bytes?: number, total?: number, filesTotal?: number, now?: number }} progress
   */
  let lastProgressPersist = 0
  const recordSnapshotProgress = (progress) => {
    const now = Date.now()
    const record = setRestartProgress(state, { ...progress, now })
    if (now - lastProgressPersist >= 250) {
      lastProgressPersist = now
      persist()
    }
    return record
  }

  /** Forget the stage (cancel, or a restart that could not be started). */
  const clearRestartStage = () => {
    if (clearRestartPhase(state)) persist()
  }

  /**
   * THE COPY A RECORD NAMES, CHECKED AGAINST THE DISK (user report, 2026-11-02).
   *
   * A restart really did write its snapshot (161 MB, manifest, under `backups/`)
   * and a later prune deleted it — the records then still said "taken" while the
   * list showed the copies from the day before. `pruneBackups` no longer deletes
   * the newest copy, but a record must not go on claiming a rollback point that
   * is not there any more either: a rollback point the user is told about and
   * cannot use is worse than being told there is none.
   *
   * @returns {boolean|null} true/false, or null when the record names no directory
   */
  const snapshotStillOnDisk = (dir) => {
    const target = typeof dir === 'string' ? dir.trim() : ''
    if (target === '') return null
    try {
      return fs.existsSync(target) === true
    } catch {
      return false
    }
  }

  /**
   * The record of the fate of the LAST restart request (see RESTART_REQUEST_FILE
   * at the top of this file). It is read lazily, so a request that was cancelled
   * by an EARLIER instance is still visible after a reload.
   */
  let lastRestartRequest = null
  const restartRequestPathOf = () => restartRequestPath(stateDirOf())
  const restartRequestOutcome = () => {
    if (lastRestartRequest === null) lastRestartRequest = readRestartRequestRecord(stateDirOf())
    const record = lastRestartRequest
    if (!record || typeof record !== 'object' || record.snapshotTaken !== true) return record
    // The record says a copy was taken. Is it still there? A record from an
    // older build names no directory (`null`) — then there is nothing to check.
    if (snapshotStillOnDisk(record.snapshotDir) !== false) return record
    return { ...record, snapshotTaken: false, snapshotMissing: true }
  }

  /**
   * THE QUEUED RESTART AS A STANDING STATE, NOT A TOAST (user decision, 2026-11-02:
   * "the bubble disappears when the page refreshes, so I thought it was not queued
   * at all").
   *
   * Re-derived on every read, so a page that remounts tomorrow still shows it. The
   * field names are the contract with the settings page (ui-dev renders them; this
   * file only promises them):
   *   pending        true while a request is queued
   *   since          when it was asked for (ms epoch) | null
   *   waitedMs       how long ago that was
   *   overThreshold  waitedMs >= thresholdMs: show it loudly
   *   thresholdMs    60000 - sent so the page does not hard-code it
   *   gateAction     allow | wait | none (what the gate last decided)
   *   gateReason     the gate's own reason word
   *   waitingReason  waiting-for-conversations | waiting-for-quiet | restarting | no-restart-pending
   *   blockedBy      [{ sessionId, reason, label }]
   *   blockedByName  ["<label> (running)"] - ready for a sentence
   *   quietResetBy   what last reset the quiet window ('agent-status' = heartbeat)
   *   quietResetAt   when it last happened
   *   quietForMs     how quiet it is right now
   *   settleMs       how quiet it has to be
   *   canRestartNow  the page may offer "restart now"
   *   restartNowTool the tool that bypasses the gate
   *   summary        ONE human sentence for logs and for the page
   */
  const restartQueueStatus = (now = Date.now()) => {
    const info = restartRequestInfo()
    const pending = !!(info && info.pending === true)
    const since = info && Number.isFinite(info.requestedAt) ? info.requestedAt : null
    const waitedMs = since === null ? 0 : Math.max(0, now - since)
    const record = lastGateRecord
    const gateAction = record && typeof record.action === 'string' ? record.action : 'none'
    const blocked = record && Array.isArray(record.blockedBy) ? record.blockedBy : []
    const blockedBy = blocked.map((entry) => ({
      sessionId: entry && entry.sessionId !== undefined ? entry.sessionId : null,
      reason: entry && typeof entry.reason === 'string' ? entry.reason : 'busy',
      label: entry && typeof entry.label === 'string' ? entry.label : ((entry && entry.sessionId) || null),
    }))
    const blockedByName = blockedBy.map((entry) => (entry.label || entry.sessionId || '?') + ' (' + entry.reason + ')')
    let waitingReason = 'no-restart-pending'
    if (pending) {
      if (state.phase === 'restarting') waitingReason = 'restarting'
      else if (blockedBy.length > 0) waitingReason = 'waiting-for-conversations'
      else waitingReason = 'waiting-for-quiet'
    }
    const overThreshold = pending && waitedMs >= RESTART_QUEUE_SILENCE_MS
    const summary = pending
      ? 'the restart has been queued for ' + describeWait(waitedMs)
        + (blockedByName.length > 0
          ? ' because ' + blockedByName.join(', ') + ' has not finished'
          : ' and is waiting for ' + Math.max(0, effectiveSettleMs() - Math.max(0, now - quietSince())) + ' ms of quiet')
      : 'no restart is queued'
    return {
      pending,
      since,
      waitedMs,
      overThreshold,
      thresholdMs: RESTART_QUEUE_SILENCE_MS,
      gateAction,
      gateReason: record && typeof record.reason === 'string' ? record.reason : null,
      waitingReason,
      blockedBy,
      blockedByName,
      quietResetBy: quietReset.by,
      quietResetAt: quietReset.at,
      quietForMs: Math.max(0, now - quietSince()),
      settleMs: effectiveSettleMs(),
      canRestartNow: pending,
      restartNowTool: 'continuum_restart',
      summary,
    }
  }

  /** The honest answer about the restart request (queued / deferred / cancelled). */
  const restartRequestInfo = () => summarizeRestartRequest({
    restart: state.restart,
    record: restartRequestOutcome(),
    now: Date.now(),
  })

  /**
   * HOW the idle gate treats a busy conversation — and, above all, the fact that
   * there is NO deadline (user decision, 2026-11-02).
   *
   * The old shape of this answer carried `deadlineAt` / `deadlineInMs` /
   * `deadlineCutsTheRequest`, and every reader of it (including the captain)
   * understood "the deadline has passed" as "the request is void". It never was:
   * a waiting restart has no expiry. The name is kept so no caller changes, but
   * the answer now says only what is true: how the wait behaves.
   */
  const restartDeadlineInfo = (restart) => ({
    policy: typeof config.deferPolicy === 'string' ? config.deferPolicy : 'auto',
    // The ONE thing that can act on a busy conversation, and it interrupts it.
    forceRestartWhenBusy: config.forceRestartWhenBusy === true,
    // There is no soft window and no hard deadline any more.
    waitsForever: true,
    requestedAt: restart !== null && isPlainObject(restart) && Number.isFinite(restart.requestedAt)
      ? Number(restart.requestedAt)
      : Date.now(),
  })

  /**
   * Write down what happened to the restart request — the ONE place that writes
   * `last-restart-request.json`.
   *
   * @param {string} result one of RESTART_REQUEST_STATES
   * @param {{ reason?: string|null, by?: string|null, extra?: object, restart?: object|null }} [options]
   *   `restart` defaults to the request that is pending RIGHT NOW; a caller that
   *   drops the request first (the "withdraw my own" paths, where `cancelOwnRestart`
   *   clears it) passes the request it saw before.
   */
  const recordRestartRequestFate = (result, { reason = null, by = null, extra = {}, restart = undefined } = {}) => {
    const request = restart === undefined ? state.restart : restart
    const record = buildRestartRequestRecord({
      result,
      reason,
      by,
      restart: request,
      now: Date.now(),
      extra: { ...restartDeadlineInfo(request), ...extra },
    })
    const written = writeRestartRequestRecord(stateDirOf(), record)
    lastRestartRequest = record
    if (written.ok !== true) {
      log.warn('could not write the restart-request record:', written.error)
    }
    return { record, written }
  }

  /**
   * THE ONE WAY A RESTART REQUEST IS DROPPED — and it always leaves a record.
   *
   * WHY ONE CHOKE POINT (real-host report, hosted `dsh web` on 5601): a request
   * answered by `POST /park` disappeared — no restart, no bumped generation, no
   * verdict, no reason. The request was cleared in six different places, and not
   * one of them wrote a record of it:
   *
   *   1. the boot recovery pass, "nothing to recover" (index.js:recoverAfterRestart);
   *   2. the boot recovery pass, end of the batch loop (same function);
   *   3. `rollbackRestart` giving up after two failed scheduling attempts;
   *   4. `tick` on the gate's `give-up` answer;
   *   5. the snapshot cancelled while the profile was being copied;
   *   6. the explicit cancels (the tool, the `/cancel` route).
   *
   * They all come through here now: clear the stage, release the waiters,
   * cancel, persist, stop polling — and WRITE DOWN reason + who + when, so the
   * question "what happened to my restart?" has an answer after the fact.
   *
   * @param {{ reason?: string, by?: string, extra?: object }} options
   * @returns {{ dropped: boolean, record: object|null }}
   */
  const dropRestartRequest = ({ reason = '', by = '', extra = {} } = {}) => {
    const restart = state.restart
    if (!restart) return { dropped: false, record: null }
    const text = typeof reason === 'string' && reason !== '' ? reason : 'no reason was given'
    const who = typeof by === 'string' && by !== '' ? by : 'unknown'
    const { record } = recordRestartRequestFate(RESTART_REQUEST_STATES.CANCELLED, { reason: text, by: who, extra })
    // The stage of a request that is gone must not draw a card for it.
    clearRestartStage()
    releaseRequesters()
    cancelRestart(state, { now: Date.now() })
    // THE GOALS THE WAITING RESTART TOOK AWAY COME BACK NOW. A withdrawn
    // request must not leave a session standing still: the disarm exists only
    // for the duration of the wait.
    const rearmed = rearmQueuedRestartGoals({ reason: 'the restart request was withdrawn (' + text + ')' })
    for (const item of rearmed.failed) {
      log.warn(`could not re-arm the goal of session ${item.sessionId} after the withdrawal: ${item.reason}`)
    }
    persist()
    stopPolling()
    log.warn('the restart request is withdrawn: ' + text, {
      by: who,
      generation: record.generation,
      waitedMs: record.waitedMs,
      record: restartRequestPathOf(),
    })
    return { dropped: true, record }
  }

  /**
   * Read the whole record in one line (used by the diagnostics surfaces).
   *
   * @returns {object} the summary of the restart request
   */
  const restartRequestSummary = () => restartRequestInfo()

  /**
   * The stage as every surface shows it (state route, health route, client).
   *
   * @returns {object} the described stage (always an object, never null)
   */
  const restartStageInfo = () => {
    const record = state.restartPhase
    const blocked = (() => {
      try {
        return countBlockerTasks(gate().blockedBy)
      } catch {
        return 0
      }
    })()
    return describeRestartPhase({
      phase: record && typeof record === 'object' ? record.phase : 'idle',
      startedAt: record && typeof record === 'object' ? record.startedAt : null,
      at: record && typeof record === 'object' ? record.at : null,
      progress: record && typeof record === 'object' ? record.progress : null,
      blocking: record && typeof record === 'object' && Number.isFinite(record.blocked) ? record.blocked : blocked,
      // The measured size of the pre-restart snapshot: it survives the stage
      // change, so a page that missed the copy can still report it.
      snapshotBytes: record && typeof record === 'object' ? record.snapshotBytes : null,
      // WHY the stage is what it is ("deferred: conversation-active", "snapshot
      // done", …), so a postponed restart can be told from a running one.
      reason: record && typeof record === 'object' ? record.reason : null,
      now: Date.now(),
    })
  }

  /**
   * A cancel request that arrived while the snapshot was being written.
   *
   * The backup loop asks this between files: the copy stops, its half-written
   * directory is removed, and the host never restarts. A flag (not a thrown
   * error) because the loop is synchronous and must finish its bookkeeping.
   */
  let snapshotCancelRequested = false
  const requestSnapshotCancel = () => {
    snapshotCancelRequested = true
    return true
  }
  const snapshotCancelled = () => snapshotCancelRequested === true
  const resetSnapshotCancel = () => {
    snapshotCancelRequested = false
  }


  /**
   * The durable record of the last restart: the snapshot that was taken, the
   * verdict of the new instance and its four boot checks.
   *
   * @returns {object|null} the summary (null when no restart happened yet)
   */
  const lastRestartVerdict = () => {
    const verdict = summarizeRestartVerdict(readRestartVerdict(stateDirOf()))
    if (!verdict || !isPlainObject(verdict.snapshot) || verdict.snapshot.taken !== true) return verdict
    // THE COPY IT NAMES MAY BE GONE (see `snapshotStillOnDisk`): then this
    // report must not offer it as a rollback point. `missing` is an addition,
    // not a rewrite — the directory and its time stay readable.
    if (snapshotStillOnDisk(verdict.snapshot.dir) !== false) return verdict
    return { ...verdict, snapshot: { ...verdict.snapshot, taken: false, missing: true } }
  }

  /**
   * The version of THIS plugin (the one the user runs).
   *
   * It delegates to the module-level reader ON PURPOSE: a local copy used to
   * look for `../package.json`, which is one directory ABOVE the plugin, so
   * every answer was `unknown` — and the health route reported that instead of
   * the version that is really loaded.
   *
   * @returns {string}
   */
  const ownVersion = () => pluginVersion()

  /**
   * Write (or update) the durable record of the restart.
   *
   * The record is written by BOTH halves of a restart: the instance that is
   * replaced writes the `pending` half (with the snapshot), the instance that
   * replaces it writes the final verdict. `skipIfFinalized` keeps the older
   * instance from overwriting a verdict that the new one already wrote.
   *
   * @param {object} [patch] the fields to change
   * @param {{ skipIfFinalized?: boolean }} [options]
   * @returns {object|null} the record that is on disk now
   */
  const recordRestartVerdict = (patch = {}, options = {}) => {
    const dir = stateDirOf()
    let current = null
    try {
      current = readRestartVerdict(dir)
    } catch {
      current = null
    }
    if (options.skipIfFinalized === true
      && current !== null
      && current.bootId !== null
      && current.result !== RESTART_RESULTS.PENDING) {
      return current
    }
    const merged = buildRestartVerdict({ ...(current ?? {}), ...patch })
    const written = writeRestartVerdict(dir, merged)
    if (!written.ok) log.warn('could not write the restart record:', written.error)
    return merged
  }

  /**
   * WHICH MACHINE IS THIS?
   *
   * The same answer the graceful shutdown uses (`lib/host-kind.js`): Windows,
   * WSL, a real Linux, a macOS. It matters for the autostart: inside WSL the
   * "start at login" is a different thing (a systemd user unit + the linger,
   * or a task on the Windows side), and the Docker/Compose answer of a
   * container is simply wrong there.
   *
   * @returns {object} the host (kind, evidence, suspect, distro)
   */
  const hostKindOf = () => detectHostKind({ platform: env.platform, env: process.env })

  /**
   * THE PLATFORM GUIDE: how "start at login" works on THIS machine.
   *
   * Windows (a scheduled task, with the startup folder as the fallback),
   * Linux (a systemd user unit + the linger hint), WSL (the same, or the two
   * ways out when there is no systemd), a container (the orchestrator) and the
   * unknown host (nothing, and no guessing). The answer is computed ONCE
   * (the machine does not change while the host runs) and the settings page
   * reads it.
   *
   * @returns {object} the advice (kind, reason, notes, commands, options)
   */
  let cachedAutostart = null
  const autostartAdviceOf = () => {
    if (cachedAutostart !== null) return cachedAutostart
    const host = hostKindOf()
    const init = detectInitSystems({ platform: env.platform, homeDir: os.homedir() })
    cachedAutostart = planAutostartAdvice({
      host,
      platform: env.platform,
      hasSystemd: init.systemdUser,
      container: detectContainer({ env: process.env }).container,
      user: typeof process.env.USER === 'string' ? process.env.USER : '',
      distro: host.distro,
    })
    return cachedAutostart
  }

  /**
   * WHAT IS ON DISK RIGHT NOW: the backups of this host.
   *
   * The settings page shows it ("what is backed up right now"), so the facts
   * have to come from the disk and not from the browser: the browser may not
   * even see the disk. Only the DIRECTORY is read — the manifest of every
   * copy — because one copy can be 150 MB and its contents are never walked.
   *
   * WHAT EACH COPY IS travels with it (user decision, 2026-10-30): only a copy
   * a boot has proven is a rollback target (`known-good`), the snapshot of a
   * restart is not (`snapshot`), and a copy without an identity file was never
   * proven (`unknown`). The browser cannot read `meta.json`, so the identity is
   * resolved HERE and handed to the interface with the numbers.
   *
   * @returns {{ dir: string, max: number, count: number, items: Array<object> }}
   */
  const backupsInfo = () => {
    const dir = backupsDirFor(stateDirOf())
    // THE FULL RECORDS, KEPT APART FROM THE PROJECTION (2026-11-03).
    //
    // `available` used to be counted on the PROJECTED items below, which carry the
    // fields the settings page needs and nothing else - no `boot`, no `trigger`. The
    // qualifier (`isUsableRestorePoint`) needs exactly those two, so it could never
    // say yes on a projection: the number was a constant 0 no matter how many
    // restorable copies were on disk. The projection stays as it is (the health
    // payload does not grow internal facts); the COUNT is taken from these records.
    const identities = listBackupIdentities(dir)
    const items = identities.map((item) => ({
      name: item.name,
      dir: item.dir,
      at: item.at,
      atLocal: item.atLocal,
      bytes: item.bytes,
      files: item.files,
      includePlugins: item.includePlugins,
      // 'known-good' | 'snapshot' | 'unknown' — never a guess: it is the
      // identity the copy itself carries.
      kind: item.kind,
      version: item.version,
      // WHY THIS COPY COUNTS AS SAFE (2026-11-01): the evidence travels inside
      // the copy (`meta.json`), and the settings page cannot read that file — so
      // the facts are resolved HERE and handed over with the numbers. An old copy
      // that has none of these fields arrives as `'none'` / `null` — not as an
      // error, and above all not as "safe": the interface shows "not certified".
      certifiedBy: item.certifiedBy,
      // WHICH CRITERION BACKED IT (2026-11-01), so the settings page can show the
      // one difference the user must be able to see: a copy proven by the
      // fingerprint comparison vs. a copy stamped by the OLD criterion, whose seal
      // cannot be checked any more (and is therefore not used as a restore point).
      certificationEvidence: item.certificationEvidence,
      certifiedAt: item.certifiedAt,
      contentScope: item.contentScope,
      // true / false / null — `null` means "not recorded", and the interface has
      // to show exactly that instead of guessing.
      intervention: item.intervention,
      certified: item.certified === true,
      // THE COPY'S OWN PLUGIN LIST (user report, 2026-11-02): what really went
      // into `node_modules-link/` of THIS copy. `null` = the copy is too old to
      // say (the page then scans the directory instead of believing a number),
      // `[]` = it holds no plugin files at all, which is the honest answer for a
      // config-only or slim copy.
      plugins: manifestPluginsOf(item.dir),
      // WHAT IS AND IS NOT INSIDE THIS COPY (user decision, 2026-11-02):
      // `localized` = plugins that were edited here and are therefore complete
      // in the copy; `thirdParty` = plugins installed as published, named but
      // not copied, because a reinstall brings back exactly those versions.
      localized: manifestPluginsOf(item.dir) === null
        ? null
        : manifestPluginsOf(item.dir).filter((entry) => entry.source === 'localized').length,
      thirdParty: (() => {
        const manifest = readManifest(item.dir)
        return manifest !== null && Array.isArray(manifest.thirdParty) ? manifest.thirdParty.length : null
      })(),
    }))
    return {
      dir,
      max: config.maxBackups,
      // TWO COUNTED THINGS, NAMED SEPARATELY (2026-11-02): the page printed
      // "current N copies" from the copies that have a manifest, while the prune
      // counted EVERY directory in the backups root - so a machine with an
      // unfinished directory showed one number and behaved like another. `count`
      // keeps its old meaning (readable copies); the two numbers a sentence may
      // quote are now here, named:
      //   available   - copies that can be restored right now, i.e. the ones the
      //                 system may act on (`isUsableRestorePoint`); "how many
      //                 fallbacks do I have" must count this one;
      //   directories - everything in the backups root, unfinished included;
      //                 this is what the prune counts against the limit.
      // COUNTED ON THE FULL RECORDS, NOT ON THE PROJECTION (2026-11-03).
      //
      // This line used to read `items.filter(...)`. `items` is the projection the
      // settings page reads, and it carries neither `boot` nor `trigger` - the two
      // facts `isUsableRestorePoint` needs - so the number was a constant 0 on every
      // machine, however many restorable copies it held. Same qualifier as the
      // watchdog (`lib/watchdog.js`) and the rollback helper (`lib/backup.js`), now
      // fed the records that actually contain the evidence.
      available: identities.filter((entry) => isUsableRestorePoint(entry) === true).length,
      directories: items.length + countIncompleteBackups(dir).incomplete,
      count: items.length,
      // THE RANGE AND THE DEFAULT, SENT INSTEAD OF HARD-CODED (2026-11-02): the
      // page must not carry its own copy of 2..10 - that is how the numbers
      // drifted apart in the first place. It reads this block.
      limit: backupLimitInfo(),
      // HOW MANY DIRECTORIES ARE NOT COPIES (2026-11-02): without this a machine
      // with three directories and two copies looks like a broken count. It is
      // not — one directory never finished, and this number names it.
      incomplete: countIncompleteBackups(dir).incomplete,
      // The same two counts for the NEWEST copy: that is the one a user rolls
      // back to, and the one the settings page talks about.
      localized: items.length > 0 ? items[0].localized : 0,
      thirdParty: items.length > 0 ? items[0].thirdParty : 0,
      items,
    }
  }

  /** The receipt of the last manual rollback, next to the checkpoint. */
  const MANUAL_ROLLBACK_RECEIPT = 'last-manual-rollback.json'

  /**
   * RESTORE ONE BACKUP THE USER PICKED (user decision, 2026-10-30).
   *
   * The automatic rollback only ever restores the newest PROVEN copy — but the
   * user may know better ("the version from last week worked"). So they may pick
   * any copy in the list, and the plugin restores exactly that one. Three rules
   * keep that safe:
   *
   *   1. THE INPUT IS A NAME, NOT A PATH. It has to match a name this host
   *      reports from `listBackupIdentities()`, so `../`, a drive letter or any
   *      separator is refused before anything is read — a traversal never even
   *      becomes a lookup.
   *   2. THE CURRENT STATE IS SAVED FIRST. A snapshot of the profile as it is
   *      right now is written before anything is overwritten, so a manual
   *      rollback is itself undoable. Without that snapshot nothing is restored.
   *   3. THE RESTART IS THE NORMAL ONE. The plugin never kills the host itself:
   *      it writes the receipt and requests a restart, exactly like the pill.
   *
   * @param {{ name?: string }} [request]
   * @returns {Promise<{ ok: boolean, status: number, error?: string|null, receipt?: object }>}
   */
  const manualRollback = async ({ name } = {}) => {
    // THIS PATH DOES NOT CHECK WHETHER THE COPY IS A GOOD RESTORE POINT, AND THAT
    // IS A PRODUCT DECISION, NOT AN OVERSIGHT (user decision, 2026-11-02).
    //
    // Every other restore path asks the system's own question first - "does this
    // copy's record say the instance came up with matching content, and was no
    // rescue needed" (`isUsableRestorePoint` in lib/backup.js) - because nobody is
    // choosing, so the system must choose safely. Here somebody IS choosing: the
    // user, looking at the list with the facts written next to each copy, saying
    // "put that one back". Refusing because a stamp is missing, or because that
    // copy's own boot failed, would be the plugin overriding the person who can see
    // the situation. The user picked: which copy is restored is their call and
    // their consequence.
    //
    // SO: no eligibility gate, no "are you sure" duplication of the page's own
    // confirmation, and no quiet upgrade of this path to the automatic rule. It is
    // pinned by a test (`test/manual-rollback-exemption.test.mjs`) that an
    // intervened-on copy is still accepted here - if somebody adds a gate, that test
    // goes red and this comment is the argument they have to answer.
    //
    // WHAT IT DOES KEEP: the plain-name check below (the listing is the allow-list,
    // so a name from outside it cannot walk the filesystem), and the undo copy taken
    // before anything is overwritten (see the `pruneEnabled: false` snapshot below -
    // taking the undo copy must not prune, or the copy it exists to protect could be
    // deleted by its own creation).
    const requested = typeof name === 'string' ? name.trim() : ''
    if (requested === '') {
      return { ok: false, status: 400, error: 'a backup name is required' }
    }
    // ① A PLAIN NAME, on purpose: the list is the allow-list.
    if (
      requested.includes('/')
      || requested.includes('\\')
      || requested.includes('..')
      || path.isAbsolute(requested)
      || requested !== path.basename(requested)
    ) {
      log.warn('the manual rollback was refused: the name is not a plain backup name:', requested)
      return { ok: false, status: 400, error: 'the name is not a backup name' }
    }
    const backupsDir = backupsDirFor(stateDirOf())
    const target = listBackupIdentities(backupsDir).find((entry) => entry.name === requested)
    if (!target || typeof target.dir !== 'string' || target.dir === '') {
      log.warn('the manual rollback was refused: there is no such backup:', requested)
      return { ok: false, status: 404, error: 'there is no such backup' }
    }
    const profile = resolveProfileDirDetailed()
    const profileDir = typeof profile.dir === 'string' ? profile.dir : ''
    if (profileDir === '') {
      log.warn('the manual rollback was refused: the profile directory is unknown')
      return { ok: false, status: 409, error: 'the profile directory is unknown' }
    }
    // ② THE WAY BACK, taken first. A manual rollback that cannot save the
    // current state is not offered at all.
    let safety = null
    try {
      safety = await createBackup({
      slimBackup: true,
        profileDir,
        backupsDir,
        includePlugins: config.backupIncludePlugins !== false,
        maxBackups: config.maxBackups,
        // NO TRIMMING HERE (2026-11-02): this copy is written in the MIDDLE of a
        // rollback, and a prune at this moment can delete the very copy the user
        // picked — measured on the real fixtures: the undo copy pushed the list
        // over the limit, the picked copy was the only unprotected one, and the
        // restore then failed with "the backup directory does not exist". The
        // next regular backup trims the list as usual.
        pruneEnabled: false,
        kind: KIND_SNAPSHOT,
        // WHAT PUT THIS COPY THERE, as a fact (2026-11-02): the undo copy of a
        // manual rollback. The old `reason: 'before-manual-rollback'` said the same
        // thing in a free-text field, which is the field that used to be read as a
        // label of quality.
        trigger: BACKUP_TRIGGERS.MANUAL_ROLLBACK,
        version: ownVersion(),
        bootId,
      })
    } catch (error) {
      safety = { ok: false, error: String(error) }
    }
    if (!safety || safety.ok !== true) {
      const reason = safety && safety.error ? safety.error : 'unknown error'
      log.error('the manual rollback was refused: the current state could not be saved first:', reason)
      return { ok: false, status: 409, error: 'the current state could not be saved first: ' + reason }
    }
    // ONE restore at a time: the detached watchdog takes the same lock.
    const lock = claimRollbackLock(stateDirOf())
    if (!lock.ok) {
      log.warn('the manual rollback stands down: another rollback is already running:', lock.error)
      return { ok: false, status: 409, error: 'another rollback is already running' }
    }
    let restored = null
    try {
      // ③ THE COPY THE USER PICKED — not the newest, not the proven one.
      restored = restoreBackup({ backupDir: target.dir, profileDir })
    } catch (error) {
      restored = { ok: false, restored: [], error: String(error) }
    } finally {
      releaseRollbackLock(stateDirOf())
    }
    const ok = Boolean(restored && restored.ok === true)
    const receipt = {
      at: new Date().toISOString(),
      name: target.name,
      dir: target.dir,
      kind: target.kind,
      version: target.version ?? null,
      restored: restored && Array.isArray(restored.restored) ? restored.restored : [],
      ok,
      error: ok ? null : ((restored && restored.error) || 'the restore failed'),
      // The copy taken right before the restore: the manual rollback can be
      // undone with it, even if the picked one was older than the hardware.
      safetySnapshot: typeof safety.dir === 'string' ? safety.dir : null,
      restartRequested: false,
    }
    const writeReceipt = () => {
      try {
        fs.writeFileSync(
          path.join(stateDirOf(), MANUAL_ROLLBACK_RECEIPT),
          JSON.stringify(receipt, null, 2),
          'utf8',
        )
      } catch (error) {
        log.warn('could not write the manual rollback receipt:', String(error))
      }
    }
    // ④ THE RECEIPT, before anything else happens: the next boot reads it.
    writeReceipt()
    if (!ok) {
      log.error('the manual rollback could not restore the copy:', receipt.error)
      return { ok: false, status: 500, error: receipt.error, receipt }
    }
    // ⑤ A NORMAL RESTART (the same request the pill makes). The plugin does not
    // kill anything itself; the restored profile is what comes back up.
    //
    // WITHOUT A SNAPSHOT OF ITS OWN (user decision, 2026-11-02): the state this
    // restart brings back up is the copy the user just picked, and ② above has
    // already written the undo copy of the live state. Copying the profile again
    // here produced a duplicate of the restored state and pushed the older, still
    // useful copies out of the list — the user said no to exactly that. So this
    // request carries `skipBackup`, and the executor honours it.
    requestRestart(state, {
      reason: 'manual rollback to ' + target.name,
      bySessionId: 'settings',
      resume: false,
      skipBackup: true,
      now: Date.now(),
    })
      markRestartStage('waiting')
      persist()
      // A request that was accepted says so, with the policy the gate uses:
      // the record is what makes "queued / deferred / cancelled" answerable.
      recordRestartRequestFate(RESTART_REQUEST_STATES.QUEUED, {
        reason: 'manual rollback to ' + target.name,
        by: 'manual-rollback',
      })
      startPolling()
    receipt.restartRequested = true
    writeReceipt()
    log.warn('the manual rollback was done; a restart was requested', {
      name: target.name,
      kind: target.kind,
      restored: receipt.restored,
      safetySnapshot: receipt.safetySnapshot,
    })
    return { ok: true, status: 200, receipt }
  }

  /**
   * THE LAST COOKIE CLEANUP, as the health route and the settings page see it.
   *
   * WHY IT IS A RECORD AND NOT A COUNT. The stale `dsh-auth-*` cookies are what
   * make the desktop app die on startup (71 of them -> a 16559-byte Cookie
   * header -> 431 -> "Web authentication failed" -> the official recovery
   * wipes the profile). The cleanup runs BETWEEN the kill and the relaunch,
   * inside its own process, and it is the only thing that knows how many rows
   * it deleted — so it WRITES that down (`last-cookie-clear.json`) and this
   * function reads it back.
   *
   * The live number of cookies is NOT reported, and must not be: the jar is an
   * open SQLite database of a RUNNING browser. Reading it would either fail or
   * report a number that is stale before it reaches the browser. "No cleanup
   * has run yet" is its own answer, never a fake success.
   *
   * @returns {object} `{at, atIso, ok, removed, reason, live, liveNote, source}`
   */
  const cookieClearInfo = () => {
    const read = readCookieClearReport(stateDirOf())
    return summarizeCookieClear(read.report, { readError: read.ok === true ? null : read.error })
  }

  /**
   * THE DIAGNOSTICS of "report a problem".
   *
   * One generator, on the host: the browser copies the text it gets, so the
   * two can never drift. It carries the facts a bug report needs — and NOT
   * the access token of this instance (the generator only copies the fields
   * it knows, and everything it copies is redacted again).
   *
   * @returns {string}
   */
  const diagnosticsText = () => buildDiagnostics({
    version: ownVersion(),
    platform: env.platform,
    hostKind: hostKindOf().kind,
    isDesktopApp: env.isDesktopApp === true,
    startup: startupModeOf(),
    supervisor: supervisorStatusOf(),
    restartMode: config.restartMode,
    lastRestart: lastRestartVerdict(),
    stateDir: stateDirOf(),
  })

  /**
   * HOW THIS HOST WAS STARTED (the startup matrix).
   *
   * The answer decides what the plugin may do: only a `bare` host (nobody
   * manages it) may get the supervisor of this plugin or a self-replay
   * command. Everything else — an external supervisor, a container, the
   * desktop app, or a host whose starter cannot be established — must not
   * lead to a second host.
   *
   * @returns {object} the classification (mode, kind, evidence, …)
   */
  const startupModeOf = () => classifyStartup({
    platform: env.platform,
    env: process.env,
    ppid: process.ppid,
    isDesktopApp: env.isDesktopApp === true,
    supervised: detectSupervisor({ env: process.env, stateDir: stateDirOf() }).supervised,
    container: detectContainer({ env: process.env }).container,
    argv: process.argv,
    execPath: process.execPath,
    readChain: readProcessChain,
  })

  /**
   * What the plugin knows about the supervisor.
   *
   * The parent chain of this very process is part of the answer: a host that
   * somebody ELSE supervises (systemd, pm2, a `supervise-*.sh` script) must
   * not be restarted by a self-replay — the supervisor starts it again, and a
   * second host on the same port is a double start.
   *
   * @returns {object} the status (mode, kind, installed, running, restartCapable)
   */
  const supervisorStatusOf = () => supervisorStatus({
    stateDir: stateDirOf(),
    env: process.env,
    platform: env.platform,
    mode: config.supervisorMode,
    ppid: process.ppid,
    // The desktop app brings ITSELF back up (`restartMode: app`): it is not
    // "nobody knows", and the restart is available.
    isDesktopApp: env.isDesktopApp === true,
    // HOW this host was started (the startup matrix), with its evidence.
    startup: startupModeOf(),
    // THE PLATFORM GUIDE: how "start at login" works here (Windows / Linux /
    // WSL / container), with the commands the user can copy.
    autostart: autostartAdviceOf(),
  })

  /**
   * The start command the supervisor would use.
   *
   * This is the PLAIN command line of this very process: the interpreter, its
   * own arguments and the script it runs. The full derivation (with the
   * refusal rules) belongs to the "E" step; this is the honest minimum the
   * supervisor needs to be able to start the host again.
   *
   * @returns {{ execPath: string, execArgv: string[], argv: string[], cwd: string }}
   */
  const supervisorStartCommand = () => ({
    execPath: process.execPath,
    execArgv: Array.isArray(process.execArgv) ? process.execArgv.map(String) : [],
    argv: Array.isArray(process.argv) ? process.argv.slice(1).map(String) : [],
    cwd: process.cwd(),
  })

  /**
   * The environment the supervisor hands to the host it starts.
   *
   * Only a WHITELIST is inherited (the daemon does that too): the host's own
   * internal variables must not leak into the next start, or the profile would
   * drift.
   *
   * @returns {Record<string, string>}
   */
  const supervisorEnv = () => {
    const env = {}
    const source = process.env || {}
    for (const key of [
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'SystemRoot',
      'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
      'NUMBER_OF_PROCESSORS', 'WSLENV', 'WSL_DISTRO_NAME', 'WSL_INTEROP',
    ]) {
      const value = source[key]
      if (typeof value === 'string' && value !== '') env[key] = value
    }
    // The two variables that say WHICH profile this host belongs to.
    if (typeof source.DSH_HOME === 'string' && source.DSH_HOME !== '') env.DSH_HOME = source.DSH_HOME
    if (typeof source.DSH_PROFILE === 'string' && source.DSH_PROFILE !== '') env.DSH_PROFILE = source.DSH_PROFILE
    return env
  }

  /**
   * Install the supervisor.
   *
   * @param {{ confirmed?: boolean, dryRun?: boolean }} [options]
   * @returns {object} the outcome (ok, kind, steps, error, plan)
   */
  const installSupervisorNow = (options = {}) => {
    const stateDir = stateDirOf()
    const profile = resolveProfileDirDetailed()
    const start = supervisorStartCommand()
    const result = installSupervisor({
      stateDir,
      profileDir: profile.dir,
      platform: env.platform,
      confirmed: options.confirmed === true,
      dryRun: options.dryRun === true,
      // The desktop app manages itself: a login record would start a SECOND
      // client at every login, so the installation is refused there.
      isDesktopApp: env.isDesktopApp === true,
      // The startup matrix: only a `bare` host (nobody manages it) may get
      // the supervisor of this plugin.
      startup: startupModeOf(),
      // WHICH MACHINE IS THIS? (WSL is not a Linux: the autostart there is a
      // different thing, and the Docker/Compose answer is a wrong one.)
      host: hostKindOf(),
      nodePath: process.execPath,
      execPath: start.execPath,
      execArgv: start.execArgv,
      argv: start.argv,
      cwd: start.cwd,
      env: supervisorEnv(),
      profileEnv: {
        ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
        ...(process.env.DSH_PROFILE ? { DSH_PROFILE: process.env.DSH_PROFILE } : {}),
      },
      port: config.supervisorPort > 0 ? config.supervisorPort : (runtime.webPort || 0),
      healthUrl: restartHealthUrl() ?? '',
      ownerUser: typeof process.env.USER === 'string' ? process.env.USER : (typeof process.env.LOGNAME === 'string' ? process.env.LOGNAME : ''),
      timings: {
        restartDelayMs: config.supervisorRestartDelayMs,
        restartDelayMaxMs: config.supervisorRestartDelayMaxMs,
        startTimeoutMs: config.supervisorStartTimeoutMs,
        killGraceMs: config.supervisorKillGraceMs,
      },
      kind: config.supervisorKind,
      // The previous way of starting the host: the uninstall puts it back.
      previous: { restartMode: config.restartMode, restartCommand: config.restartCommand },
      log: (message) => log.warn(message),
    })
    if (result.ok) {
      log.warn('the supervisor was installed', { kind: result.kind, degraded: result.degraded })
    } else {
      log.error('the supervisor was not installed:', result.error)
    }
    return result
  }

  /**
   * Uninstall the supervisor and give the machine back to the user.
   *
   * @returns {Promise<object>} the outcome (ok, steps, error, pending, previous)
   */
  const uninstallSupervisorNow = async () => {
    const result = await uninstallSupervisor({
      stateDir: stateDirOf(),
      platform: env.platform,
      log: (message) => log.warn(message),
    })
    if (result.ok) {
      log.warn('the supervisor was uninstalled', { previous: result.previous })
    } else {
      log.error('the supervisor could not be removed completely:', result.error)
    }
    return result
  }

  /**
   * Record the answer of the one-time question about the supervisor.
   *
   * @param {string} choice 'install' | 'external' | 'dismissed'
   * @param {object} [previous] the values that were in effect before
   * @returns {object} the recorded answer
   */
  const recordSupervisorChoice = (choice, previous = null) => {
    const record = recordOnboarding(state, {
      feature: 'supervisor',
      version: SUPERVISOR_FEATURE_VERSION,
      choice,
      previous,
      now: Date.now(),
    })
    persist()
    return record
  }

  /**
   * Derive the command that starts this host again — or say why there is
   * none. Nothing is written: this is the dry run (B).
   *
   * @param {{ fixedPort?: number }} [options]
   * @returns {Promise<object>} the derivation (the plan of what WOULD be written)
   */
  const deriveStartCommandNow = async (options = {}) => {
    const detected = detectSupervisor({ env: process.env, stateDir: stateDirOf() })
    const external = detectExternalSupervisor({
      ppid: process.ppid,
      env: process.env,
      platform: env.platform,
    })
    const container = detectContainer({ env: process.env })
    const init = detectInitSystems({ platform: env.platform, homeDir: os.homedir() })
    // A random port has to be FIXED, or the cookie of the browser dies with
    // every restart. The port is picked once and then written down.
    let fixedPort = Number(options.fixedPort) > 0 ? Number(options.fixedPort) : 0
    if (fixedPort === 0 && config.supervisorPort > 0) fixedPort = config.supervisorPort
    if (fixedPort === 0 && Number(runtime.webPort) > 0 && config.supervisorPort === 0) {
      // The port of the running instance is the best candidate: it is the one
      // the browser knows.
      fixedPort = Number(runtime.webPort)
    }
    const derivation = deriveStartCommand({
      execPath: process.execPath,
      execArgv: process.execArgv,
      argv: process.argv,
      cwd: process.cwd(),
      platform: env.platform,
      env: process.env,
      pid: process.pid,
      isDesktopApp: env.isDesktopApp === true,
      webPort: runtime.webPort || 0,
      supervised: detected.supervised === true,
      externalSupervisor: external,
      container: container.container,
      // THE STARTUP MATRIX: it decides whether a self-replay is possible at
      // all (and whether the command must be detached from its session).
      startup: startupModeOf(),
      hasInit: env.platform === 'win32' ? true : init.systemdUser,
      fixedPort,
      currentRestartMode: config.restartMode,
      currentRestartCommand: config.restartCommand,
      healthPath: resolveHealthPath(config),
    })
    const plan = buildDryRunPlan(derivation)
    return {
      ...plan,
      derivation,
      externalSupervisor: external,
      container: container.container,
      initReason: init.reason,
      // The fragment a container needs (there is no "at login" there).
      compose: derivation.reason === 'container-no-init' && derivation.argv
        ? composeRestartFragment(derivation.argv)
        : null,
    }
  }

  /**
   * Write the derived command into the profile configuration — only after the
   * user confirmed the dry run.
   *
   * @param {{ derivation?: object }} [options]
   * @returns {Promise<object>} the outcome
   */
  const applyDerivedCommand = async (options = {}) => {
    const derivation = options.derivation && typeof options.derivation === 'object'
      ? options.derivation
      : await deriveStartCommandNow()
    if (!derivation || derivation.ok !== true || !derivation.writes) {
      return {
        ok: false,
        error: 'nothing-to-write',
        reason: derivation ? derivation.reason : 'unknown',
      }
    }
    const previous = {
      restartMode: config.restartMode,
      restartCommand: config.restartCommand,
    }
    try {
      await runtime.applyConfigChoice({
        restartMode: derivation.writes.restartMode,
        restartCommand: derivation.writes.restartCommand,
      })
    } catch (error) {
      return { ok: false, error: describeError(error), reason: derivation.reason }
    }
    // The values that were in effect are kept, so the undo can put them back.
    recordSupervisorChoice('external', previous)
    log.warn('the derived restart command was written', {
      mode: derivation.writes.restartMode,
      reason: derivation.reason,
    })
    return { ok: true, writes: derivation.writes, previous, reason: derivation.reason }
  }

  /**
   * Put the previous start command back (the undo).
   *
   * @returns {Promise<object>} the outcome
   */
  const revertDerivedCommand = async () => {
    const record = state.onboarding
    const previous = record && typeof record === 'object' ? record.previous : null
    if (!previous || typeof previous.restartMode !== 'string') {
      return { ok: false, error: 'nothing-to-revert' }
    }
    try {
      await runtime.applyConfigChoice({
        restartMode: previous.restartMode,
        restartCommand: previous.restartCommand === null ? '' : previous.restartCommand,
      })
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
    log.warn('the previous restart command was put back', previous)
    return { ok: true, previous }
  }

  /**
   * Write the marker that tells the rollback watcher "the plugin has decided
   * on its own — stand down".
   *
   * The watcher is the fallback for the case that the plugin dies with the
   * host. When the plugin SURVIVES the restart command it decides alone, and
   * this marker keeps the watcher from rolling back a restart that was fine.
   *
   * @param {{ decided: boolean, ok?: boolean, reason?: string }} outcome
   * @returns {boolean} whether the marker was written
   */
  const writeRestartOutcome = (outcome) => {
    const file = path.join(stateDirOf(), RESTART_OUTCOME_FILE)
    try {
      fs.writeFileSync(file, JSON.stringify({
        decided: true,
        ok: outcome && outcome.ok === true,
        reason: outcome && typeof outcome.reason === 'string' ? outcome.reason : '',
        at: new Date().toISOString(),
        bootId,
      }, null, 2), 'utf8')
      return true
    } catch (error) {
      log.warn('could not write the restart outcome marker:', String(error))
      return false
    }
  }

  /**
   * Write the rollback report of a restart that FAILED, so the interface can
   * say what happened.
   *
   * The report has the same shape as the one the detached watcher writes, so
   * there is exactly ONE place that reads it.
   *
   * @param {{ rolledBack: boolean, reason: string, backupDir?: string|null, restored?: string[] }} details
   * @returns {boolean} whether the report was written
   */
  /**
   * A REPORT WRITTEN BY AN OLDER BUILD SPEAKS THE OLD WORD (2026-11-02).
   *
   * `no-known-good` was renamed to `no-usable-backup` for a reason worth keeping:
   * the old token claimed the copies on disk were "not good", while all the code
   * knows is that none was USABLE (no record of a boot). Report files written
   * before the rename still carry the old word, and a reader that shrugged at it
   * would turn history into "unknown error" - the rename must not cost the user
   * their past. Only a LEADING token is rewritten; the sentence after it is left
   * exactly as it was written.
   */
  const normalizeReportReason = (reason) => {
    if (typeof reason !== 'string' || reason === '') return '';
    const colon = reason.indexOf(':');
    if (colon <= 0) return reason;
    if (reason.slice(0, colon).trim() !== LEGACY_RESTORE_REFUSAL) return reason;
    return normalizeRestoreRefusal(LEGACY_RESTORE_REFUSAL) + reason.slice(colon);
  }
  const writeRestartReport = (details) => {
    const file = path.join(stateDirOf(), RESTART_REPORT_NAME)
    try {
      fs.writeFileSync(file, JSON.stringify({
        ok: false,
        at: new Date().toISOString(),
        waitedMs: 0,
        rolledBack: details.rolledBack === true,
        rollbackError: details.rolledBack === true ? null : details.reason,
        reason: details.reason,
        backupDir: details.backupDir ?? null,
        restored: Array.isArray(details.restored) ? details.restored : [],
        // The plugin restores the files; it never starts a second host.
        appStarted: false,
      }, null, 2), 'utf8')
      return true
    } catch (error) {
      log.warn('could not write the rollback report:', String(error))
      return false
    }
  }

  /**
   * Put the pre-restart snapshot back over the live profile.
   *
   * This is the in-process half of the rollback: it runs when the plugin
   * itself can see that the restart failed (the restart command did not
   * start, or the new instance never answered). The detached watcher does
   * the same thing when the plugin died with the host.
   *
   * @param {{ backup: any, profileDir: string|null, reason: string }} details
   * @returns {{ rolledBack: boolean, restored: string[], error: string|null }}
   */
  const rollbackInProcess = ({ backup, profileDir, reason }) => {
    const restored = []
    // ONLY a backup that a boot has already proven may be rolled back to. The
    // snapshot taken right before THIS restart may be the broken state itself
    // (the user edited a plugin and then restarted), so it is never the target.
    const knownGood = latestKnownGood(backupsDirFor(stateDirOf()))
    const targetDir = knownGood && typeof knownGood.dir === 'string' ? knownGood.dir : ''
    if (targetDir === '') {
      log.error('the restart failed and no copy has a restart record saying it came up, so there is nothing to roll back to:', reason)
      writeRestartReport({ rolledBack: false, reason: RESTORE_REFUSAL.NO_USABLE_BACKUP + ': ' + reason, backupDir: null, restored })
      return { rolledBack: false, restored, error: RESTORE_REFUSAL.NO_USABLE_BACKUP }
    }
    if (typeof profileDir !== 'string' || profileDir === '') {
      log.error('the restart failed and the profile directory is unknown:', reason)
      writeRestartReport({ rolledBack: false, reason, backupDir: backup.dir, restored })
      return { rolledBack: false, restored, error: 'the profile directory is unknown' }
    }
    // THE LOCK: the detached watcher may be restoring the snapshot at the same
    // time. Exactly ONE of them copies the files — two copies at once would
    // write the same files (117 MB of plugin tree) at the same time.
    const lock = claimRollbackLock(stateDirOf())
    if (!lock.ok) {
      log.warn('another rollback is already running; this one stands down:', lock.error)
      return { rolledBack: false, restored, error: lock.error }
    }
    let result = null
    try {
      result = restoreBackup({ backupDir: targetDir, profileDir })
    } catch (error) {
      result = { ok: false, restored: [], error: String(error) }
    } finally {
      releaseRollbackLock(stateDirOf())
    }
    if (result && result.ok === true) {
      log.warn('the backup whose restart record says it came up with matching content was restored:', {
        reason,
        restored: result.restored,
        backupDir: targetDir,
      })
      writeRestartReport({ rolledBack: true, reason, backupDir: targetDir, restored: result.restored })
      return { rolledBack: true, restored: result.restored, error: null }
    }
    const error = (result && result.error) || 'the restore failed'
    log.error('the backup whose restart record says it came up could not be restored:', reason, error)
    writeRestartReport({ rolledBack: false, reason, backupDir: targetDir, restored })
    return { rolledBack: false, restored, error }
  }

  /**
   * Arm the rollback watcher: the process that confirms the new instance and
   * puts the snapshot back when it never comes.
   *
   * The watcher is started OUTSIDE the host process, because the restart
   * command usually kills the host itself — in that case the plugin cannot
   * confirm anything any more, and the watcher is the only safety net left.
   *
   * @param {{ backup: any, profileDir: string|null, gateScriptPath?: string|null }} details
   * @returns {Promise<{ ok: boolean, method: string, error: string|null, scriptPath: string|null, verified: string, pid: number|null }>}
   */
  const armRollbackWatcher = async ({ backup, profileDir, gateScriptPath = null }) => {
    // The watcher must restore a state a boot has already proven. The snapshot
    // of the restart it is guarding may be the broken state itself.
    const knownGood = latestKnownGood(backupsDirFor(stateDirOf()))
    const targetDir = knownGood && typeof knownGood.dir === 'string' ? knownGood.dir : ''
    if (targetDir === '') {
      log.warn('no copy has a restart record saying it came up with matching content: the automatic rollback is not armed')
      return { ok: false, method: 'none', error: RESTORE_REFUSAL.NO_USABLE_BACKUP, scriptPath: null, verified: 'nothing', pid: null }
    }
    if (typeof profileDir !== 'string' || profileDir === '') {
      log.warn('the profile directory is unknown: the automatic rollback is not armed')
      return { ok: false, method: 'none', error: 'the profile directory is unknown', scriptPath: null, verified: 'nothing', pid: null }
    }
    const stateDir = stateDirOf()
    // THE V1 WATCHER IS POWERSHELL (2026-11-02): on a machine that is not
    // Windows the file could never run, so it is not written at all. Older
    // builds wrote it anyway and left it behind — a real WSL machine had seven
    // of them. Reporting "no automatic rollback" is honest; leaving an
    // executable-looking script nobody can run is not.
    if (env.platform !== 'win32') {
      log.warn(
        'the rollback watcher is a PowerShell script: this platform cannot run it, so nothing is written (there is NO automatic rollback for this restart)',
      )
      return {
        ok: false,
        method: 'none',
        error: 'the v1 rollback watcher is a PowerShell script and this platform has no PowerShell',
        scriptPath: null,
        verified: 'nothing',
        pid: null,
      }
    }
    const scriptPath = path.join(stateDir, 'restart-' + state.generation + '-watch.ps1')
    const script = buildWatchScript({
      // The fallback health URL (the port of the OLD instance). It is only
      // used when the host publishes no instance record at all.
      healthUrl: restartHealthUrl() ?? '',
      healthPath: resolveHealthPath(config),
      // The instance record: the port of the NEW instance and its boot id.
      portFile: accessFilePath(stateDir),
      expectedBootId: bootId,
      outcomeFile: path.join(stateDir, RESTART_OUTCOME_FILE),
      backupDir: targetDir,
      profileDir,
      reportPath: path.join(stateDir, ROLLBACK_REPORT_NAME),
      lockFile: path.join(stateDir, ROLLBACK_LOCK_NAME),
      timeoutMs: config.rollbackTimeoutMs,
      rollbackTimeoutMs: config.rollbackCopyTimeoutMs,
      since: new Date().toISOString(),
      selfCleanPaths: [scriptPath, gateScriptPath].filter(Boolean),
    })
    const written = writeTextFileAtomic(scriptPath, script)
    if (!written.ok) {
      log.error('could not write the rollback watcher:', written.error)
      return { ok: false, method: 'none', error: written.error, scriptPath, verified: 'nothing', pid: null }
    }
    const result = launchWatcherFn({
      watchScriptPath: scriptPath,
      platform: env.platform,
    })
    if (!result || result.ok !== true) {
      log.error('could not start the rollback watcher:', (result && result.error) || 'unknown error')
      return {
        ok: false,
        method: (result && result.method) || 'none',
        error: (result && result.error) || null,
        scriptPath,
        verified: 'nothing',
        pid: null,
      }
    }
    // SOMEBODY HAS TO BE WAITING (2026-11-02). `result.ok` only says the launcher
    // accepted the command. When it reported a pid, the process is CONFIRMED a
    // moment later: a watcher that dies right after its start is not a safety
    // net, and the report must say so instead of "armed".
    let verification = 'launcher'
    let pid = Number.isFinite(result.pid) ? Number(result.pid) : null
    if (pid !== null) {
      let check = null
      try {
        check = await confirmWatcherAlive({
          pid,
          waitMs: 250,
          isAlive: isProcessAlive,
          sleep: (ms) => new Promise((resolve) => {
            const timer = setTimeout(resolve, ms)
            if (timer && typeof timer.unref === 'function') timer.unref()
          }),
        })
      } catch (error) {
        check = { confirmed: false, alive: false, pid, reason: String(error) }
      }
      if (check.confirmed !== true) {
        log.error('the rollback watcher did not survive its start:', check.reason)
        return {
          ok: false,
          method: (result && result.method) || 'none',
          error: 'the rollback watcher did not survive its start: ' + check.reason,
          scriptPath,
          verified: 'gone',
          pid,
        }
      }
      verification = 'alive'
    }
    log.warn('the rollback watcher is armed', {
      scriptPath,
      method: result.method,
      pid,
      verification,
      timeoutMs: config.rollbackTimeoutMs,
    })
    return { ok: true, method: result.method, error: null, scriptPath, verified: verification, pid }
  }

  /** Execute the restart now; the detached helper survives our own death. */
  const executeRestart = async () => {
    stopPolling()
    if (!state.restart) return
    try {
      await flushSessions()
    } catch {}
    // Re-check the gate AFTER the flush and BEFORE anything is killed or scheduled:
    // another conversation may have started while the sessions were being written.
    // This re-check also protects the ungated fallback (>20 gate aborts) and the
    // forceRestartWhenBusy path: even when the detached helper cannot re-check the
    // gate itself, a busy conversation is never killed here.
    // Last chance to park a goal-driven session: without it the detached
    // helper would refuse to kill the process and the restart would wait.
    try {
      disarmBlockingGoals(busyAgents())
    } catch (error) {
      log.warn('could not disarm the goals of the blocking sessions:', String(error))
    }
    const verdict = gate()
    if (!verdict.allow) {
      log.info('restart deferred: a conversation is still active or the host is settling', {
        reason: verdict.reason,
        blockedBy: verdict.blockedBy,
        quietForMs: verdict.quietForMs,
      })
      // Postponed BEFORE the copy: the stage goes back to waiting (with the
      // reason and a fresh timestamp), so no card survives the deferral.
      deferRestartStage(verdict.reason || 'conversation-active', {
        blocked: countBlockerTasks(verdict.blockedBy),
      })
      recordRestartRequestFate(RESTART_REQUEST_STATES.DEFERRED, {
        reason: 'the idle gate postponed the restart: ' + String(verdict.reason || 'conversation-active'),
        by: 'idle-gate',
      })
      persist()
      startPolling()
      return
    }
    setPhase(state, 'restarting')
    state.restart.attempt += 1
    persist()
    // THE REQUEST IS BEING CARRIED OUT: from here the record says so, so "it
    // was executing and then nothing came back" is distinguishable after the
    // fact from "it was never executed".
    recordRestartRequestFate(RESTART_REQUEST_STATES.EXECUTING, {
      reason: 'the idle gate allowed the restart; the snapshot / arming / command follows',
      by: 'execute-restart',
      extra: { attempt: state.restart.attempt },
    })
    log.warn('executing graceful restart', { generation: state.generation, pid: process.pid })
    try {
      // How the host is restarted: the custom command, or the desktop app.
      const useCustomCommand = config.restartMode === 'command' && config.restartCommand.trim() !== ''
      const canRelaunchDesktop = Boolean(env.isDesktopApp && env.appExePath)
      if (!useCustomCommand && !canRelaunchDesktop) {
        // No restart method at all (the host is not the desktop app and there is
        // no custom command): nothing is restarted, so nothing is snapshotted
        // either — there is no rollback point for a restart that never happens.
        log.warn('no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place')
        rollbackRestart('no restart method available')
        return
      }

      // ONE snapshot for EVERY restart mode: the profile is copied BEFORE
      // anything is killed, no matter how the host is restarted. The desktop
      // app relaunch and the custom restart command share this single entry, so
      // a hosted host that is restarted by a command is just as recoverable as
      // the desktop app.
      //
      // THE STAGE IS ON SCREEN BEFORE THE COPY STARTS, and the copy reports the
      // files and bytes it really writes. That is the fix of "I clicked restart
      // and nothing happened for ten seconds": the ten seconds ARE the snapshot,
      // and now they say so.
      const stateDir = path.dirname(stateFile)
      resetSnapshotCancel()
      // NO COPY FOR THIS REQUEST (user decision, 2026-11-02).
      //
      // A restart that carries out a MANUAL ROLLBACK must not snapshot: ② of
      // `manualRollback` has just written the undo copy of the live state, and
      // what is on disk now is the copy the user picked — copying the profile
      // again only makes a duplicate of it and prunes the older, still useful
      // copies out of the list. The request carries the fact (`skipBackup`), so
      // this is not inferred from its reason text.
      //
      // ONLY THE COPY IS SKIPPED. The profile directory is still resolved and
      // handed on, so the watchdog is armed through exactly the same branch as a
      // restart that takes no snapshot because the operator turned
      // `backupOnRestart` off: it still brings a host back up after a restart
      // that never answered, and its report says there is no trusted restore
      // point of this attempt.
      const skipBackup = state.restart.skipBackup === true
      // HAS THIS REQUEST ALREADY PAID FOR ITS SNAPSHOT? (user report, 2026-10-30:
      // the copy finished, a conversation postponed the restart, and the retry
      // copied all 205 MB again.) Then it is reused as it is: same request, same
      // directory, same manifest. A request that asks for NO copy never looks at
      // that record: there is nothing to reuse.
      const paid = skipBackup ? null : reusableSnapshot()
      let cancelled = false
      let snapshot = null
      if (skipBackup) {
        const skipProfile = runtimeProfileDirFor(options)
        const skipProfileDir = typeof skipProfile.dir === 'string' ? skipProfile.dir : null
        snapshot = {
          backup: null,
          profileDir: skipProfileDir,
          profile: {
            dir: skipProfileDir,
            source: typeof skipProfile.source === 'string' ? skipProfile.source : 'unknown',
          },
          // NOT requested: the record must not say "asked for, did not happen".
          requested: false,
          // The deliberate skip, named, so nothing downstream mistakes it for a
          // failed copy.
          skipped: true,
          durationMs: 0,
          error: null,
        }
        log.warn('this restart takes no pre-restart backup: it carries out a manual rollback', {
          reason: state.restart && typeof state.restart.reason === 'string' ? state.restart.reason : null,
          profileDir: skipProfileDir,
        })
      } else if (paid !== null) {
        log.warn('reusing the snapshot this restart already took; not copying the profile again', {
          dir: paid.dir,
          bytes: paid.bytes,
        })
        snapshot = {
          backup: {
            ok: true,
            dir: paid.dir,
            bytes: paid.bytes,
            totalBytes: paid.total,
            fileCount: paid.files,
            reused: true,
          },
          profileDir: paid.profileDir,
          profile: { dir: paid.profileDir, source: 'reused' },
          requested: true,
          durationMs: 0,
          error: null,
          reused: true,
        }
      } else {
        markRestartStage('snapshotting')
        try {
          snapshot = await snapshotFn({
            config,
            stateDir,
            log,
            profile: runtimeProfileDirFor(options),
            onProgress: (progress) => {
              recordSnapshotProgress(progress)
            },
            shouldCancel: () => snapshotCancelled(),
          })
        } finally {
          // The flag belongs to ONE snapshot; a stale `true` would cancel the
          // next restart before it began.
          const wasCancelled = snapshotCancelled()
          resetSnapshotCancel()
          // Two ways a copy can be called off: the flag this process set (the
          // cancel route) or the snapshot reporting it itself. Both mean the same
          // thing, and both must stop the restart.
          cancelled = wasCancelled || (snapshot !== null && typeof snapshot === 'object' && snapshot.cancelled === true)
        }
        // Remember it: if this restart is postponed now, the retry must not copy
        // the profile a second time.
        if (!cancelled) rememberSnapshot(snapshot)
      }
      if (cancelled) {
        // The user called it off while the files were being copied: the
        // half-written snapshot is already gone (createBackup removes it), the
        // host does not restart, and the request is WITHDRAWN — a restart the
        // user cancelled must not be retried five seconds later.
        log.warn('the restart was cancelled while the snapshot was being written')
        dropRestartRequest({
          reason: 'the restart was cancelled while the snapshot was being written',
          by: 'snapshot-cancel',
        })
        return
      }
      // A COPY THAT IS DONE IS NOT A RESTART YET (user report, 2026-10-30): "the
      // backup finished, and then the card said 正在重启 for 25 s while nothing was
      // restarting". The gate is re-checked HERE, in the same tick, so a
      // conversation that started during the copy postpones the restart at once
      // instead of being discovered by the helper half a minute later.
      const afterCopy = gate()
      if (!afterCopy || afterCopy.allow !== true) {
        const why = afterCopy && typeof afterCopy.reason === 'string' && afterCopy.reason !== ''
          ? afterCopy.reason
          : 'conversation-active'
        log.info('restart deferred right after the snapshot: a conversation is active again', {
          reason: why,
          blockedBy: afterCopy ? afterCopy.blockedBy : null,
        })
        deferRestartStage('conversation-active after snapshot: ' + why, {
          blocked: afterCopy && Array.isArray(afterCopy.blockedBy) ? countBlockerTasks(afterCopy.blockedBy) : 0,
        })
        recordRestartRequestFate(RESTART_REQUEST_STATES.DEFERRED, {
          reason: 'a conversation became active right after the snapshot: ' + why,
          by: 'idle-gate-after-snapshot',
          extra: { snapshotReused: paid !== null },
        })
        setPhase(state, 'deferred')
        persist()
        startPolling()
        return
      }
      // THE INVARIANT (user report, 2026-10-29): 'snapshotting' exists ONLY while
      // files are being copied. The moment the copy returns — copied, cancelled
      // or thrown — the stage leaves it. Everything after this point (arming the
      // watchdog, the supervisor hand-off, the command) is "the restart is being
      // executed", and a deferral from here on goes back to 'waiting'.
      markRestartStage('restarting', {
        reason: skipBackup ? 'no snapshot for this restart (manual rollback)' : 'snapshot done',
      })
      // The snapshot is the rollback point of BOTH branches.
      const backup = snapshot && snapshot.backup ? snapshot.backup : null
      const profilePick = pickProfileDirForArm({ runtime: runtimeProfileDirFor(options), persisted: readProfileDirFact(state), snapshot: snapshot && snapshot.profileDir ? snapshot.profileDir : null, exists: (dir) => fs.existsSync(dir) }), profileDir = profilePick.dir

      // THE DURABLE RESTART RECORD. The instance that is being replaced
      // writes the "pending" half BEFORE it runs the restart command: the
      // snapshot it took (directory, local time, duration, which older
      // snapshots were pruned) and the generation. The instance that replaces
      // it rewrites the record as `ok` / `failed` after it has checked itself
      // (see `verifyRestartBoot`). If the new instance never comes up, the
      // record stays `pending` — which is exactly what has to be visible.
      // ONE clock for the whole attempt: the moment this restart STARTED is what
      // separates "a restore that belongs to this attempt" from an older one, so
      // it is read once here and reused at the promotion site below.
      const restartStartedAt = Date.now()
      recordRestartVerdict({
        result: RESTART_RESULTS.PENDING,
        mode: useCustomCommand ? 'command' : 'app',
        generation: state.generation,
        requestedAt: state.restart && Number.isFinite(state.restart.requestedAt)
          ? state.restart.requestedAt
          : null,
        startedAt: restartStartedAt,
        previousBootId: bootId,
        bootId: null,
        reason: state.restart && typeof state.restart.reason === 'string' ? state.restart.reason : null,
        snapshot: buildSnapshotRecord({
          requested: snapshot && snapshot.requested === true,
          backup,
          profileDir,
          durationMs: snapshot && Number.isFinite(snapshot.durationMs) ? snapshot.durationMs : null,
          // A DELIBERATE skip says so: without this the record fell back to the
          // generic "the snapshot was not taken", which reads like a copy that
          // failed. This one was not asked for, and the reason is a fact.
          error: snapshot && snapshot.error
            ? snapshot.error
            : (skipBackup
              ? 'no pre-restart backup on purpose: this restart carries out a manual rollback, and the undo copy that rollback wrote is its rollback point'
              : null),
        }),
        checks: [],
      })
      // The marker of an EARLIER decision must not confuse this restart's
      // watcher: it would stand down before it even looked at the new
      // instance. It is removed BEFORE the watcher is armed.
      try {
        fs.rmSync(path.join(stateDir, RESTART_OUTCOME_FILE), { force: true })
      } catch {}

      if (useCustomCommand) {
        // (0) THE C ROUTE. When the supervisor of this plugin started this
        // instance, the restart is asked of the SUPERVISOR (over its control
        // channel) — not of a command. The supervisor kills the host, starts
        // it again and puts the snapshot back if it does not come.
        const detected = detectSupervisor({ env: process.env, stateDir })
        if (detected.supervised) {
          if (backup && backup.ok === true) {
            writeRollbackRequest(stateDir, {
              backupDir: backup.dir,
              profileDir: profileDir ?? '',
              generation: state.generation,
              reason: 'plugin-restart',
            })
          }
          const asked = await requestSupervisorAction({ stateDir, action: 'restart' })
          if (asked && asked.ok === true) {
            log.warn('the restart was handed to the supervisor of this plugin')
            return
          }
          log.error(
            'the supervisor did not accept the restart request; falling back to the restart command:',
            asked ? asked.error : 'unknown error',
          )
        }

        const command = buildCustomCommand({
          template: config.restartCommand,
          pid: process.pid,
          ppid: process.ppid,
          appExePath: env.appExePath || '',
        })
        log.warn('running custom restart command:', command)

        // (1) THE SAFETY NET. The restart command usually kills THIS process
        // (that is what restarting the host means), so the plugin cannot
        // confirm anything once the command runs. The watcher is started
        // BEFORE the command: it waits for the new instance outside the host
        // and puts the snapshot back when the new instance never comes.
        //
        // It is NOT armed when the supervisor of this plugin is in charge:
        // that one restores the snapshot itself, and two of them would write
        // the same files at the same time.
        if (detected.supervised !== true) {
          // THE V1 WATCHER IS AWAITED *AND* VERIFIED (2026-11-02). The result
          // used to be dropped on the floor, so the report said "armed" even
          // when the watcher never started. Now: launched + confirmed -> armed;
          // anything else -> "there is no automatic rollback" with the reason.
          const v1 = await armRollbackWatcher({ backup, profileDir })
          if (v1.ok !== true) {
            log.error('there is NO automatic rollback for this restart:', v1.error)
          }
        }
        try {
          // (2) THE COMMAND, with a real success judgement. The old code only
          // looked at "the spawn did not throw", so a command that does not
          // exist or that exits with an error was reported as a successful
          // restart.
          //
          // FROM HERE ON THE RESTART CANNOT BE CANCELLED, and the interface says
          // so: the host is on its way out.
          markRestartStage('restarting')
          // A command that takes a while must not keep claiming "restarting" once
          // a conversation is active again (the reason is remembered and the card
          // turns into "restart postponed").
          armRestartBusyWatch()
          const outcome = await runCommandFn({
            command,
            timeoutMs: config.restartCommandTimeoutMs,
          })
          if (!outcome || outcome.ok !== true) {
            const reason = (outcome && outcome.error) || 'the restart command failed'
            log.error('the restart command failed; the pre-restart snapshot is restored:', reason)
            rollbackInProcess({ backup, profileDir, reason })
            writeRestartOutcome({ decided: true, ok: false, reason })
            recordRestartVerdict({
              result: RESTART_RESULTS.FAILED,
              verifiedAt: Date.now(),
              reason,
              checks: [{ name: 'command', ok: false, detail: reason }],
            })
            return
          }
          if (outcome.timedOut === true) {
            log.warn(
              `the restart command is still running after ${config.restartCommandTimeoutMs}ms; `
              + 'the new instance is confirmed by the rollback watcher',
              { command, timeoutMs: config.restartCommandTimeoutMs },
            )
          } else {
            log.warn('the restart command finished', { command, exitCode: outcome.exitCode ?? null })
          }

          // (3) THE HEALTH CONFIRMATION — only possible when this process
          // survived the command. The new instance publishes its own port and
          // its own boot id; the confirmation waits for THAT instance and not
          // for the one that is being replaced.
          const confirmed = await probeInstanceFn({
            accessFile: accessFilePath(stateDir),
            expectedBootId: bootId,
            healthPath: resolveHealthPath(config),
            timeoutMs: config.rollbackTimeoutMs,
          })
          if (confirmed && confirmed.ok === true) {
            log.warn('the new instance answered its health route:', confirmed)
            // THE SNAPSHOT MAY BE CERTIFIED — by the HEALTH PROBE, which is what
            // this path actually proved (2026-11-01). The four startup checks do
            // not run here: this instance is the OLD one, which survived its own
            // restart command, so the proof it has is "the new instance answers".
            // The certifying source therefore says exactly that (`command-probe`)
            // instead of borrowing the name of a check that never ran.
            //
            // 但「新实例答了健康路由」并不等于「重启前那份配置能起来」（2026-11-01，本插件第二条同型路径）：
            //   - 探活可能是**旧实例**答的（端口/引导号没换、或新实例根本起在别的配置上）；
            //   - 配置可能在快照与这次探活之间被换过（还原、手改、别的写入者）。
            // 只要这两件事有任何一件发生，把重启前那份记成「探活成功时跑的就是这一份」，
            // 就是 12-04-33 那次事故的翻版（坏配置被认证，随后被「还原」覆盖回去）。
            // 所以这里和 app 模式那条（verifyRestartBoot -> decideBootCertification）用**同一条判据**：
            //   快照侧的指纹 == 此刻磁盘上这份配置的指纹，两侧都存在且相等才盖章。
            //   快照侧「没有记录值」不再自动等于「没证据」：meta 里没有就**现算一次**再比
            //   （`snapshotConfigFingerprint`，app 模式那条也用它，两条路径不许各写一套）。
            //   没指纹 ≠ 内容不对 —— 老备份只是当初没拍照，补拍一张再比，内容对不上才拒绝。
            // 判据本身在 lib/restart-verdict.js 里（decideProbeCertification），两处共用同一个比对函数，
            // 不许在这里另写一套——两条路径的口径一旦分叉，先坏的那条没人会发现。
            //
            // WHERE THE TWO SIDES COME FROM (为什么是这两个值，不是别的)：
            //   - 快照侧：`snapshotConfigFingerprint(backup.dir)` —— meta.json 里**当初记下**的指纹优先；
            //     没有（老备份，那份 meta 比这个字段还老）就**现算**：读副本自己的 `config/` 算一张。
            //     没指纹 ≠ 内容不对：当初没拍照，不等于内容可疑；文件还在就能补拍一张再比。
            //     不给它补，等于「升级一次就把用户手里那份能回退的备份全收走」——这是本插件最不该做的事。
            //     代价：早先刻意只读 meta，是为了防「事后被改过的副本自证」；现算让这层防护弱了一点
            //     （要同时把副本和现役配置改成同一份内容才能骗过，而那时「这份内容能起来」本来就是真的）。
            //     取舍写在这里的唯一出处：`snapshotConfigFingerprint` 的注释。
            //   - 现役侧：`profileConfigFingerprint(profileDir)`，读的是**这次运行所用的 profile 根目录**里的
            //     cordis.patch.yml / package.json / pnpm-lock.yaml。这个 `profileDir` 来自本函数的
            //     `snapshot.profileDir`，而它和 app 模式用的 `runtime.profileDir.dir`（getter 同样调用
            //     resolveProfileDirDetailed()）是**同一个解析器**的结果，所以两侧指的是同一个目录、同一个布局
            //     （profile 根目录，不是副本里的 config/ 子目录）。
            //   - 时机：command 模式下这段跑在**旧宿主进程**里（见上面 5746 附近那段注释），此刻磁盘上的配置
            //     就是新实例启动时读的那一份；之后若有人又写了配置，指纹就会不一致——那正是要拒绝的时候。
            // 拿不到任何一侧的可靠指纹时**一律拒绝**：宁可没有可回退的那一份，也不许盖错章。
            if (backup && typeof backup.dir === 'string' && backup.dir !== '') {
              const side = snapshotConfigFingerprint(backup.dir)
              if (side.source === FINGERPRINT_SOURCES.UNAVAILABLE) {
                // 「现算失败」不是「内容不一致」：副本目录没了、config/ 读不出文件，说明这份副本
                // **读都读不出来**，不是「内容对不上」。两句话让读日志的人去查完全不同的东西，
                // 所以这里单独报，绝不复用 mismatch 的措辞。
                log.warn('the snapshot of this restart stays UNPROVEN: ' + side.reason, {
                  dir: backup.dir,
                  mode: 'command',
                  certifiedBy: CERTIFIED_BY.NONE,
                  fingerprintState: FINGERPRINT_STATE_UNREADABLE,
                  fingerprintSource: side.source,
                  computeError: side.computeError,
                  // Said out loud: the probe DID answer, and that is not enough.
                  probeAnswered: true,
                })
              } else {
                const currentFingerprint = profileConfigFingerprint(profileDir)
                const decision = decideProbeCertification({ snapshotFingerprint: side.fingerprint, currentFingerprint })
                // 日志必须能分辨这一侧的指纹是「当初记的」还是「现在算的」，见 `fingerprintSourceNote`。
                const sourceNote = fingerprintSourceNote(side.source)
                if (decision.certified !== true) {
                  // NOTHING is promoted and the meta is NOT touched — including in
                  // the computed case: the value computed for THIS comparison is not
                  // stored back into the copy's meta. Same wording as the app-mode
                  // refusal (`... stays UNPROVEN: <reason>`), so an operator reading
                  // the log cannot tell the two paths apart by accident — and the two
                  // short fingerprints say WHICH differ.
                  log.warn('the snapshot of this restart stays UNPROVEN: ' + decision.reason + sourceNote, {
                    dir: backup.dir,
                    mode: 'command',
                    certifiedBy: decision.certifiedBy,
                    fingerprintState: decision.fingerprintState,
                    fingerprintSource: side.source,
                    snapshotFingerprint: shortFingerprint(decision.snapshotFingerprint),
                    currentFingerprint: shortFingerprint(decision.currentFingerprint),
                    // Said out loud: the probe DID answer, and that is not enough.
                    probeAnswered: true,
                  })
                } else {
                  const intervention = detectBootIntervention(stateDir, { sinceMs: restartStartedAt })
                  const promoted = markKnownGood(backup.dir, {
                    // THE FACTS, NOT A VERDICT (user decision, 2026-11-02): what was
                    // really observed on that boot — it came up, it was running
                    // exactly the content this copy holds, and the observation was
                    // the health probe (the four startup checks do NOT run on this
                    // path, so they are not named). The copy's own record then
                    // answers "was this ever booted, and on what" without ever
                    // claiming the plugins inside are good.
                    observedBy: BOOT_OBSERVATIONS.HEALTH_PROBE,
                    hostStarted: true,
                    // `fingerprintsEqual` IS the criterion, taken from the decision
                    // itself so a refusal can never be written as a match.
                    contentMatched: decision.fingerprintsEqual === true,
                    // No check ran on this path, so nobody looked at plugin load
                    // failures: `null` ("not recorded"), never an empty list that
                    // would read as "there were none".
                    loadFailures: null,
                    // The content that was PROVEN is the fingerprint that was compared —
                    // recorded in the meta, or computed from the copy when the meta had
                    // none. Either way THIS is the value the comparison accepted.
                    contentFingerprint: decision.snapshotFingerprint,
                    contentScope: contentScopeOf(backup.dir),
                    intervention: intervention.intervention,
                  })
                  log.info('the snapshot of this restart is recorded as booted: the health probe answered and this boot runs exactly the snapshot content' + sourceNote, {
                    dir: backup.dir,
                    mode: 'command',
                    promoted: promoted.promoted,
                    certifiedBy: decision.certifiedBy,
                    certificationEvidence: decision.certificationEvidence,
                    fingerprintState: decision.fingerprintState,
                    fingerprintSource: side.source,
                    snapshotFingerprint: shortFingerprint(decision.snapshotFingerprint),
                    currentFingerprint: shortFingerprint(decision.currentFingerprint),
                    intervention: intervention.intervention,
                    interventionReason: intervention.reason,
                    // Recorded, not part of the decision — same as the app-mode path.
                    interventionUsedAsEvidence: false,
                  })
                }
              }
            } else {
              // The probe answered but this restart took no snapshot: there is
              // nothing to certify, and inventing one would be the old mistake.
              log.warn('the new instance answered, but this restart took no snapshot, so no copy got a matching-content record')
            }
            writeRestartOutcome({ decided: true, ok: true, reason: 'the new instance answered' })
            recordRestartVerdict({
              result: RESTART_RESULTS.OK,
              verifiedAt: Date.now(),
              reason: 'the new instance answered',
              checks: [{ name: 'command', ok: true, detail: 'the new instance answered its health route' }],
            }, { skipIfFinalized: true })
            return
          }
          const reason = (confirmed && confirmed.reason) || 'the new instance never answered'
          log.error('the new instance did not come up; the pre-restart snapshot is restored:', reason)
          rollbackInProcess({ backup, profileDir, reason })
          writeRestartOutcome({ decided: true, ok: false, reason })
          recordRestartVerdict({
            result: RESTART_RESULTS.FAILED,
            verifiedAt: Date.now(),
            reason,
            checks: [{ name: 'command', ok: false, detail: reason }],
          })
        } catch (error) {
          // The command has already run: a retry would restart the host a
          // SECOND time. The snapshot is restored and the reason is reported.
          const reason = 'the hosted restart failed: ' + String(error)
          log.error(reason)
          rollbackInProcess({ backup, profileDir, reason })
          writeRestartOutcome({ decided: true, ok: false, reason })
          recordRestartVerdict({
            result: RESTART_RESULTS.FAILED,
            verifiedAt: Date.now(),
            reason,
            checks: [{ name: 'command', ok: false, detail: reason }],
          })
        }
      } else {
        const aborts = Number(state.restart.gateAborts) || 0
        const url = aborts > 20 ? null : restartGateUrl()
        if (aborts > 20) {
          log.error('falling back to an UNGATED restart after repeated idle-gate aborts', { gateAborts: aborts })
        } else if (url === null) {
          log.warn('the web server port is unknown; scheduling an UNGATED restart (the helper cannot re-check the idle gate)')
        }
        // The snapshot was already taken above (the shared entry).
        const healthUrl = restartHealthUrl()
        const gateScriptPath = url === null ? null : path.join(stateDir, 'restart-' + state.generation + '.cmd')
        // The watcher does NOT need the port of the old instance (it reads the
        // port of the NEW one from the instance record), so it is armed as
        // soon as there is a snapshot and a profile directory.
        //
        // The watcher does NOT need the port of the old instance (it reads the
        // port of the NEW one from the instance record), so it is armed as
        // soon as there is a snapshot and a profile directory.
        const watchScriptPath = backup && backup.ok === true && profileDir !== null
          ? path.join(stateDir, 'restart-' + state.generation + '-watch.ps1')
          : null
        const watchScript = watchScriptPath === null
          ? null
          : buildWatchScript({
            // The fallback URL of the OLD instance. The watcher uses the port
            // of the NEW instance (from the instance record) — the desktop
            // app listens on a random port, so the old one is worthless.
            healthUrl,
            healthPath: resolveHealthPath(config),
            portFile: accessFilePath(stateDir),
            expectedBootId: bootId,
            outcomeFile: path.join(stateDir, RESTART_OUTCOME_FILE),
            backupDir: backup.dir,
            profileDir,
            reportPath: path.join(stateDir, ROLLBACK_REPORT_NAME),
            lockFile: path.join(stateDir, ROLLBACK_LOCK_NAME),
            timeoutMs: config.rollbackTimeoutMs,
            rollbackTimeoutMs: config.rollbackCopyTimeoutMs,
            // Only a crash log written after this point belongs to this restart.
            since: new Date().toISOString(),
            // The watcher removes the helper scripts when it ends.
            selfCleanPaths: [watchScriptPath, gateScriptPath].filter(Boolean),
          })
        const result = scheduleDetachedFn({
          appExePath: env.appExePath,
          relaunchDelaySeconds: config.relaunchDelaySeconds,
          gateUrl: url,
          scriptPath: gateScriptPath,
          watchScriptPath,
          watchScript,
          cookieClearCommand: buildCookieClearCommand(),
        })
        log.warn('scheduled detached restart:', result)
        if (!result || result.ok !== true) {
          deferRestartStage((result && result.error) || 'detached restart refused')
          rollbackRestart((result && result.error) || 'detached restart refused')
        } else {
          // The helper is scheduled: the host is going down, and from here on a
          // cancel would be a promise this plugin cannot keep.
          markRestartStage('restarting')
          // THE 25-SECOND LIE (user report, 2026-10-30): the helper waits for its
          // own idle re-check, so this is exactly the window in which a
          // conversation can start. Watch it every 350 ms.
          armRestartBusyWatch()
          armGateRecoveryTimer()
        }
      }
    } catch (error) {
      rollbackRestart(String(error))
    }
  }

  /**
   * The queued request from its own record, or null when nothing is queued.
   *
   * `restartRequestInfo()` already answers "is a restart queued" for the
   * interface; this is the same answer, used by the poller itself, so the timer
   * and the page can never disagree about whether a request is pending.
   */
  const queuedRestartRecord = () => {
    try {
      // THE RECORD FILE IS THE TRUTH (user decision, 2026-11-02, t26).
      //
      // The in-memory intent and the queued record come apart - that is the exact
      // state the user's machine sat in for twelve minutes: the record said
      // `pending`, the intent was gone. Asking `restartRequestInfo()` first cannot
      // see that, because it answers `pending: true` only while the intent exists;
      // the poller therefore adopted nothing and killed itself. So read the FILE,
      // and treat the two live fates (queued / deferred) as still-pending.
      const record = readRestartRequestRecord(stateDirOf())
      if (record === null || typeof record !== 'object') return null
      const fate = typeof record.result === 'string' ? record.result : ''
      if (fate !== RESTART_REQUEST_STATES.QUEUED && fate !== RESTART_REQUEST_STATES.DEFERRED) return null
      return record
    } catch {
      return null
    }
  }

  /**
   * Rebuild the in-memory restart intent from the queued record.
   *
   * `restartDecision` needs `state.restart` to decide anything at all (it answers
   * `no-restart-pending` otherwise), so a queued request whose intent went away
   * could never be executed. Adopting it restores the ONLY thing the gate reads:
   * when it was asked for. It is logged once, because an adopted request is a
   * repair, and repairs should be visible.
   */
  const adoptQueuedRestart = (info) => {
    const requestedAt = Number.isFinite(info && info.requestedAt) ? info.requestedAt : Date.now()
    state.restart = {
      requestedAt,
      attempt: 0,
      notBefore: 0,
      adopted: true,
    }
    persist()
    log.warn(
      `the restart was still queued but its in-memory record was gone; it was adopted (asked for ${new Date(requestedAt).toISOString()}) so the idle gate can decide again`,
      { requestedAt },
    )
  }

  /** One decision tick while a restart is pending. */
  const tick = () => {
    if (disposed) return
    if (!state.restart) {
      // THE QUEUE OUTLIVES THE IN-MEMORY INTENT (bug, 2026-11-02).
      //
      // This branch used to stop the poller and return whenever `state.restart`
      // was gone - but the queued request lives in its own record
      // (`last-restart-request.json`), and `pending` there can be true while the
      // intent is empty. Once that happened the timer was DEAD: no gate
      // evaluation, no log, nothing. That is the "silent failure" the user hit -
      // the restart stayed queued for twelve minutes with `restartGate.at` frozen
      // at the moment the intent went away.
      //
      // The fix is the contract: while a request is pending there is ALWAYS a
      // timer, and the gate keeps deciding. When only the record is left, the
      // intent is rebuilt from it so the gate has something to decide about.
      const queued = queuedRestartRecord()
      if (queued === null) {
        stopPolling()
        return
      }
      adoptQueuedRestart(queued)
    }
    const now = Date.now()
    const busy = busyAgents()
    // A goal-driven session blocks the restart forever: park its goal BEFORE the
    // gate decides that it is blocked, so the next poll sees an idle session.
    if (busy.length > 0) {
      try {
        disarmBlockingGoals(busy)
      } catch (error) {
        log.warn('could not disarm the goals of the blocking sessions:', String(error))
      }
    }
    const decision = restartDecision(state, {
      anyAgentRunning: busy.length > 0,
      busyAgents: busy,
      lastActivityAt: quietSince(),
      settleMs: effectiveSettleMs(),
      now,
      // NO softMs / hardMs: the gate has no deadlines any more (2026-11-02).
      policy: config.deferPolicy,
      forceRestartWhenBusy: config.forceRestartWhenBusy,
    })
    if (decision.log) log.info(decision.log)
    // THE GATE, WRITTEN DOWN (diagnostics only, 2026-11-02).
    //
    // Until now the only trace of a decision was the rate-limited log line
    // below, so "I asked for a restart and nothing happened" could not be
    // answered after the fact — it had to be guessed (and a wrong guess cost
    // two rounds). This record is persisted with the state and exposed by
    // health / continuum_status, together with WHO was resetting the quiet
    // window at that moment.
    //
    // It RECORDS the decision. It does not take part in it.
    try {
      const requestedAt = state.restart && Number.isFinite(state.restart.requestedAt)
        ? state.restart.requestedAt
        : now
      const record = {
        at: now,
        // `allow` means "the gate let the restart through" (the decision says
        // `restart`); every other outcome — wait / warn / long-wait — is a
        // wait, because the restart has not happened.
        action: decision.action === 'restart' ? 'allow' : 'wait',
        reason: typeof decision.reason === 'string' ? decision.reason : 'unknown',
        blockedBy: busy.map((entry) => ({
          sessionId: entry && entry.sessionId !== undefined && entry.sessionId !== null
            ? String(entry.sessionId)
            : null,
          reason: entry && typeof entry.reason === 'string' ? entry.reason : 'busy',
        })),
        quietForMs: Math.max(0, now - quietSince()),
        settleMs: effectiveSettleMs(),
        // How long the request has been waiting (from its own requestedAt).
        queueMs: Math.max(0, now - requestedAt),
        attempts: state.restart && Number.isFinite(state.restart.attempt) ? state.restart.attempt : 0,
        ...quietResetInfo(),
      }
      lastGateRecord = record
      writeGateRecordFile(record)
    } catch (error) {
      log.warn('could not record the restart gate:', String(error))
    }
    // The diagnostic line of the pending restart: what the gate decided and
    // why. It is rate limited (once a minute) so the 3s poll does not flood
    // the log, and it is the first thing to look at when "the restart never
    // happens" is reported.
    // NOTHING ABOUT A QUEUED RESTART STAYS UNMENTIONED (user decision, 2026-11-02:
    // "this is a silent failure - last time I could not even find out why").
    //
    // The line below is rate limited for the whole plugin; this one is about the
    // REQUEST. Once it has been queued longer than RESTART_QUEUE_SILENCE_MS, the
    // tick says - at most once a minute per request - what the gate decided, who
    // still holds the restart, and what keeps resetting the quiet window. That is
    // the sentence whose absence made the last incident uninvestigable.
    try {
      const queuedInfo = restartRequestInfo()
      if (queuedInfo && queuedInfo.pending === true) {
        const queuedAt = Number.isFinite(queuedInfo.requestedAt) ? queuedInfo.requestedAt : now
        const queuedFor = Math.max(0, now - queuedAt)
        const lastAt = queueDiagLog.requestedAt === queuedAt ? queueDiagLog.at : 0
        if (queuedFor >= RESTART_QUEUE_SILENCE_MS && now - lastAt >= RESTART_QUEUE_DIAG_INTERVAL_MS) {
          queueDiagLog = { at: now, requestedAt: queuedAt }
          const names = busy.map((entry) => (entry && (entry.label || entry.name || entry.sessionId)) || '?')
          log.warn(
            `the restart has been queued for ${describeWait(queuedFor)}: gate=${decision.reason || decision.action}`
              + `, blockedBy=[${names.join(', ') || 'nothing'}]`
              + `, quietForMs=${Math.max(0, now - quietSince())} of settleMs=${effectiveSettleMs()}`
              + `, quietResetBy=${quietReset.by}`
              + (busy.length === 0 ? ' - nobody is working; the quiet window has simply not filled yet' : ''),
            {
              queuedForMs: queuedFor,
              gateAction: decision.action,
              gateReason: decision.reason,
              blockedBy: busy.map((entry) => ({
                sessionId: entry && entry.sessionId !== undefined && entry.sessionId !== null ? String(entry.sessionId) : null,
                reason: entry && typeof entry.reason === 'string' ? entry.reason : 'busy',
                label: entry && typeof entry.label === 'string' ? entry.label : null,
              })),
              quietForMs: Math.max(0, now - quietSince()),
              settleMs: effectiveSettleMs(),
              quietResetBy: quietReset.by,
              quietResetAt: quietReset.at,
            },
          )
        }
      }
    } catch (error) {
      log.warn('could not describe the queued restart:', String(error))
    }
    if (now - lastDecisionLogAt >= LONG_WAIT_LOG_INTERVAL_MS) {
      lastDecisionLogAt = now
      log.info(
        `restart gate: action=${decision.action} reason=${decision.reason} busyCount=${busy.length} quietForMs=${Math.max(0, now - quietSince())} effectiveSettleMs=${effectiveSettleMs()}`,
        {
          action: decision.action,
          reason: decision.reason,
          busyCount: busy.length,
          quietForMs: Math.max(0, now - quietSince()),
          effectiveSettleMs: effectiveSettleMs(),
        },
      )
    }
    switch (decision.action) {
      case 'wait':
        return
      case 'long-wait': {
        // A conversation still holds the restart. The request is KEPT — the user
        // asked for a restart, it must never be dropped silently — and the wait
        // is VISIBLE from the first second: a clear log line (rate limited, so
        // the 3s poll does not flood the log) and the `longWait` block of the
        // state payload. There is no deadline and nothing ever expires.
        const requestedAt = Number.isFinite(state.restart.requestedAt) ? state.restart.requestedAt : now
        const waitedMs = Math.max(0, now - requestedAt)
        const lastAt = longWaitLog.requestedAt === requestedAt ? longWaitLog.at : 0
        if (now - lastAt >= LONG_WAIT_LOG_INTERVAL_MS) {
          longWaitLog = { at: now, requestedAt }
          log.warn(
            `the restart has been waiting for ${describeWait(waitedMs)}; ${describeBlockers(decision.blockedBy)} still holds it — cancel the restart or wait for that work to finish`,
            {
              waitedMs,
              blockedBy: decision.blockedBy,
              reason: decision.reason,
            },
          )
        }
        return
      }
      case 'restart':
      case 'force-restart': {
        void executeRestart()
        return
      }
      case 'give-up': {
        log.warn('giving up on the pending restart:', decision.reason)
        // The gate only says this when the operator opted in
        // (`forceRestartWhenBusy`) and the forced attempt was already spent —
        // so the reason is part of the record, with who ended it.
        dropRestartRequest({
          reason: 'the idle gate gave up: ' + String(decision.reason || 'give-up'),
          by: 'idle-gate',
          extra: { forceRestartWhenBusy: config.forceRestartWhenBusy === true },
        })
        return
      }
      default:
        return
    }
  }

  /**
   * Persist one or more user choices into the profile row of this plugin.
   *
   * The official `configEditor` service is the primary path: the choice goes
   * into the profile row of this plugin, so the settings page and the one-time
   * prompts read and write the same key (one source of truth). When the service
   * is unavailable the choice degrades to a file in the plugin's state
   * directory and a warning is logged, so the choice is never silently lost.
   *
   * @param {{ backupOnRestart?: boolean, backupIncludePlugins?: boolean, showSleepButton?: boolean, sleepCountdownSeconds?: number, restartGraceMs?: number }} changes
   * @returns {Promise<{ applied: 'config'|'fallback-file' }>}
   */
  const persistConfigChoice = async (changes) => {
    // The profile row and the degraded fallback file use different key names for
    // the backup scope: the row carries the plugin's own key
    // (`backupIncludePlugins`), the file the short one (`includePlugins`).
    const wanted = {}
    const fallback = {}
    if (typeof changes.backupIncludePlugins === 'boolean') {
      wanted.backupIncludePlugins = changes.backupIncludePlugins
      fallback.includePlugins = changes.backupIncludePlugins
    }
    if (typeof changes.backupOnRestart === 'boolean') {
      wanted.backupOnRestart = changes.backupOnRestart
      fallback.backupOnRestart = changes.backupOnRestart
    }
    if (typeof changes.showSleepButton === 'boolean') {
      wanted.showSleepButton = changes.showSleepButton
      fallback.showSleepButton = changes.showSleepButton
    }
    if (typeof changes.sleepCountdownSeconds === 'number') {
      wanted.sleepCountdownSeconds = changes.sleepCountdownSeconds
      fallback.sleepCountdownSeconds = changes.sleepCountdownSeconds
    }
    if (typeof changes.restartGraceMs === 'number') {
      wanted.restartGraceMs = changes.restartGraceMs
      fallback.restartGraceMs = changes.restartGraceMs
    }
    // HOW MANY COPIES TO KEEP (2026-11-02). The range is validated by the route
    // and by `validateBackupLimit`; the value that reaches here is already a
    // whole number inside the range, and an out-of-range value is refused with a
    // reason instead of being written.
    if (typeof changes.maxBackups === 'number') {
      wanted.maxBackups = changes.maxBackups
      fallback.maxBackups = changes.maxBackups
    }
    const editor = resolveConfigEditor(ctx)
    if (editor !== null) {
      try {
        const entry = findOwnEntry(editor)
        if (entry !== null) {
          await editor.edit(entry, (current) => {
            const base = current && typeof current === 'object' ? { ...current } : {}
            return { ...base, ...wanted }
          })
          // The Loader reconciles the row, but the running instance must not
          // keep the old value until that happens.
          for (const [key, value] of Object.entries(wanted)) config[key] = value
          log.info(`the choice was written into the profile configuration: ${JSON.stringify(wanted)}`)
          return { applied: 'config' }
        }
        log.warn(`the configEditor service has no profile row for ${name}; the choice degrades to ${INSTALL_CHOICE_FILE}`)
      } catch (error) {
        log.warn(`could not write the choice into the profile configuration: ${describeError(error)}`)
      }
    } else {
      log.warn(`the configEditor service is unavailable; the choice degrades to ${INSTALL_CHOICE_FILE}`)
    }
    const file = path.join(path.dirname(stateFile), INSTALL_CHOICE_FILE)
    try {
      writeInstallChoice(path.dirname(stateFile), fallback)
    } catch (error) {
      throw new Error(`could not write the choice to ${file}: ${describeError(error)}`)
    }
    for (const [key, value] of Object.entries(wanted)) config[key] = value
    log.warn(`the choice was written to ${file} instead of the profile configuration`)
    return { applied: 'fallback-file' }
  }

  /**
   * The feature announcements the user has not seen yet.
   *
   * A feature is pending when the recorded version is OLDER than the current
   * one: a user who has seen the announcement of the feature version 0.5.0
   * never sees it again - not with the next release of the plugin, because
   * the announcement follows the FEATURE and not the package. A user who
   * answered the card on an intermediate release (the announcement used to
   * carry the package version) has seen it as well: a record that is not
   * older than the current version never brings the card back.
   *
   * A feature without a record is always pending - a missing record must
   * never swallow an announcement.
   *
   * @returns {{ feature: string, version: string }[]}
   */
  const pendingAnnouncements = () => {
    const seen = state.seenFeatureVersions && typeof state.seenFeatureVersions === 'object'
      ? state.seenFeatureVersions
      : {}
    return featureAnnouncements().filter((entry) => !isFeatureSeen(seen[entry.feature], entry.version))
  }

  /**
   * Record that the user has seen the announcement of one feature.
   *
   * The record lives in the checkpoint file, so it survives a restart of the
   * Host: an announcement that was shown once does not come back with the
   * next boot.
   *
   * @param {string} feature the id of the feature
   * @returns {string[]} the features that are recorded now
   */
  const markFeatureSeen = (feature) => {
    const id = typeof feature === 'string' ? feature.trim() : ''
    if (id === '') return []
    const known = featureAnnouncements().find((entry) => entry.feature === id)
    if (!known) return []
    if (!state.seenFeatureVersions || typeof state.seenFeatureVersions !== 'object') {
      state.seenFeatureVersions = {}
    }
    state.seenFeatureVersions[id] = known.version
    persist()
    return Object.keys(state.seenFeatureVersions).sort()
  }

  /**
   * Record that the user has seen the announcement of EVERY feature.
   *
   * This is what the one-time install prompt does: it already explains the
   * features to a fresh installation, so no announcement may follow it.
   *
   * @returns {string[]} the features that are recorded now
   */
  const markAllFeaturesSeen = () => {
    const seen = new Set()
    for (const entry of featureAnnouncements()) {
      for (const id of markFeatureSeen(entry.feature)) seen.add(id)
    }
    return Array.from(seen).sort()
  }

  const runtime = {
    get state() {
      return state
    },
    get bootId() {
      return bootId
    },
    /**
     * THE STATE DIRECTORY of this boot — the checkpoint, the watchdog markers
     * and the scheduling-item leftovers all live in it.
     *
     * It is exposed ON PURPOSE: the health route is a module-level function
     * and used to read the directory from a variable that only existed inside
     * this factory. The lookup threw `ReferenceError: stateDirOf is not
     * defined` on every request, an empty `catch {}` ate it, and a healthy
     * host left an armed watchdog behind (the 0.8.2 incident). Anything a
     * route needs must be reachable through `runtime`, never through a
     * closure it cannot see.
     */
    get stateDir() {
      return path.dirname(stateFile)
    },
    /**
     * The version of the plugin that is actually LOADED in this process.
     *
     * The health route reports it so a real-machine check can tell "the new
     * code is running" from "the old code is still loaded".
     */
    get pluginVersion() {
      return ownVersion()
    },
    /**
     * THE LAST PLUGIN-FAILURE RECOVERY, as the popup may show it.
     *
     * ONE SOURCE: the report the boot pass wrote, and ONLY when it describes
     * THIS boot. A report written before this process started is a leftover from
     * a previous start — the real machine had one stuck at 10:39:59 carrying 188
     * fake failures — and is returned as `null` so it stops being shown.
     *
     * THE IN-PROCESS DETECTION THAT USED TO COME FIRST IS GONE (user decision,
     * 2026-11-01). It was built on `ctx.get('tools').execute(...)`, which the host
     * refuses during boot: that call wants a whole execution context (token /
     * callId / rootCallId / signal / agent plus `arguments`), not a tool name and
     * its arguments. Measured on the real machine, every argument shape answered
     * the same `tool execution arguments must be losslessly JSON-serializable`.
     * The plugin cannot obtain that context at boot, so the route is closed.
     *
     * What is left is what always worked: the report on disk, and a manual
     * single-plugin restore from the backup.
     *
     * NEVER THROWS: this runs inside a health route.
     *
     * @returns {object|null}
     */
    pluginRecoveryInfo() {
      try {
        const report = readRecoveryReport(stateDirOf())
        if (!report || typeof report !== 'object') return null
        const uptimeMs = typeof process.uptime === 'function' ? process.uptime() * 1000 : 0
        const bootAt = Date.now() - Math.round(uptimeMs)
        const at = Number(report.at)
        // A report written BEFORE this process started describes a different
        // boot. Showing it is what kept 188 fake failures on screen.
        if (Number.isFinite(at) && at < bootAt) return null
        return summarizeRecoveryReport(report)
      } catch {
        return null
      }
    },
    /**
     * THE ONLY REMAINING WRITER INTO THE PROFILE: put ONE plugin back, because a
     * human pressed the button (user decision, 2026-11-01).
     *
     * The boot pass no longer restores anything — it reports and stops. This is
     * the "只把这一个插件恢复到上一个备份版本" action, and it never touches a
     * second plugin: the name comes from the request, not from a log.
     *
     * Never throws: a restore that cannot run comes back as `ok:false` with a
     * `reason`, which is an answer the popup can show.
     *
     * @param {string} plugin the one plugin to put back
     * @returns {object} `{ ok, plugin, mode, restoredFrom, restoredAt, backupKind, needsRestart, … }`
     */
    pluginRestore(plugin) {
      const at = Date.now()
      try {
        const profileDir = runtime.profileDir && typeof runtime.profileDir.dir === 'string'
          ? runtime.profileDir.dir
          : ''
        return restoreOnePlugin({
          stateDir: stateDirOf(),
          profileDir,
          backupsDir: profileDir === '' ? '' : backupsDirFor(stateDirOf()),
          plugin,
          now: at,
        })
      } catch (error) {
        return {
          ok: false,
          plugin: typeof plugin === 'string' ? plugin : '',
          mode: null,
          restoredFrom: null,
          restoredAt: null,
          backupKind: null,
          needsRestart: false,
          changed: false,
          evidence: null,
          at,
          atIso: new Date(at).toISOString(),
          reason: 'the restore failed: ' + String(error && error.message ? error.message : error),
        }
      }
    },
    /**
     * The newest restore a human asked for (what health carries so the popup can
     * say "already put back, restart to load it").
     *
     * @returns {object|null}
     */
    pluginRestoreInfo() {
      try {
        return summarizeRestoreHistory(readRestoreHistory(stateDirOf()))
      } catch {
        return null
      }
    },
    // THE STAGE OF A RESTART, as every surface reads it. `markRestartStage`
    // writes it and persists immediately (that is what makes the first stage
    // appear within the first second after the click), `recordSnapshotProgress`
    // carries the REAL bytes of the running copy, and `restartStageInfo` is the
    // single description (text included) that the state route, the health route
    // and the settings page share.
    markRestartStage,
    /**
     * Reset a stage that cannot be true in THIS process (boot / plugin reload).
     *
     * WHY (user report, 2026-10-29): the stage lives in the checkpoint, so a
     * 'snapshotting' or 'restarting' written by an earlier attempt can be read
     * back by a process in which nothing is being copied and nothing is going
     * down. The interface would then draw a card for an action that is not
     * happening — the card that never went away. A stage that describes an
     * action must not outlive the process that performed it.
     *
     * @param {string} reason why it is being reset ("boot", "plugin reload", …)
     * @returns {object|null} the recorded stage, or null when nothing was stale
     */
    resetStaleStage(reason) {
      const record = state.restartPhase
      const phase = record && typeof record === 'object' ? record.phase : null
      if (phase !== 'snapshotting' && phase !== 'restarting') return null
      let blocked = 0
      try {
        blocked = countBlockerTasks(gate().blockedBy)
      } catch {
        blocked = 0
      }
      return markRestartStage('waiting', {
        blocked,
        reason: reason ? 'boot: ' + reason : 'boot',
      })
    },
    recordSnapshotProgress,
    clearRestartStage,
    restartStageInfo,
    // THE FATE OF THE RESTART REQUEST: the tool, the routes and the boot pass all
    // go through these, and every one of them leaves a record (see
    // RESTART_REQUEST_FILE).
    recordRestartRequestFate,
    dropRestartRequest,
    restartRequestInfo,
    // THE STANDING QUEUE STATE (2026-11-02): pending / waitedMs / overThreshold /
    // blockedBy / quietResetBy / summary - see `restartQueueStatus`.
    restartQueueStatus,
    restartRequestSummary,
    restartRequestOutcome,
    requestSnapshotCancel,
    snapshotCancelled,
    resetSnapshotCancel,
    /**
     * The stage of a restart, cut down for the health route (no long texts).
     *
     * @returns {object} `{ phase, at, blocking, progress, slow, cancellable }`
     */
    restartStageBrief() {
      const info = restartStageInfo()
      return {
        phase: info.phase,
        at: info.at,
        elapsedMs: info.elapsedMs,
        // How many tasks still hold the gate: the centred overlay prints the
        // number, so it travels as a number and not only inside `text`.
        blocking: info.blocking,
        // The size of the pre-restart snapshot, on every stage (bytes).
        snapshotBytes: info.snapshotBytes,
        // Why this stage ("deferred: …" = the restart went back to waiting).
        reason: info.reason,
        progress: info.progress === null
          ? null
          : { files: info.progress.files, bytes: info.progress.bytes, total: info.progress.total, percent: info.progress.percent, ageMs: info.progress.ageMs },
        slow: info.slow,
        cancellable: info.cancellable,
        cancelReason: info.cancelReason,
      }
    },
    /**
     * Where the effective `backupIncludePlugins` value came from:
     * `config` (the profile row), `fallback-file` (the degraded path) or
     * `default` (nothing was ever chosen).
     */
    get backupChoiceSource() {
      return options.backupChoiceSource || 'default'
    },
    get isNewBoot() {
      return boot.isNewBoot
    },
    /**
     * Where the pre-restart backup will be taken from, and which source answered.
     * `dir` is null when no source could resolve it (the backup is then skipped).
     */
    get profileDir() {
      return resolveProfileDirDetailed()
    },
    /**
     * The rollback report the detached watcher left behind, or null.
     *
     * It means the previous restart never brought the host back and the snapshot
     * taken before that restart was restored. Read once per process: the next
     * restart clears it.
     */
    get lastRollback() {
      const report = readRollbackReport(path.dirname(stateFile))
      if (!report || report.ok !== false) return null
      const tail = typeof report.crashTail === 'string' ? report.crashTail : ''
      return {
        at: typeof report.at === 'string' ? report.at : null,
        waitedMs: Number.isFinite(report.waitedMs) ? report.waitedMs : null,
        rolledBack: report.rolledBack === true,
        backupDir: typeof report.backupDir === 'string' ? report.backupDir : null,
        // WHY the restart failed. Without it the interface can only say "it was
        // rolled back", which is the half of the story the user needs most.
        // AN OLD REPORT SPEAKS THE OLD WORD (2026-11-02): `no-known-good:` was
        // renamed to `no-usable-backup:` because the old word judged the copies
        // ("not good") when all the code knows is that none was USABLE. A report
        // written before the rename still has to read as the same conclusion, so
        // the token is normalized here instead of surfacing as an unknown error.
        reason: normalizeReportReason(
          typeof report.reason === 'string'
            ? report.reason
            : (typeof report.rollbackError === 'string' ? report.rollbackError : ''),
        ),
        crashLog: typeof report.crashLog === 'string' ? report.crashLog : null,
        crashTail: tail.length > 4000 ? tail.slice(-4000) : tail,
      }
    },
    /**
     * The instance record of the running host: the port it listens on and the
     * access link (with the boot token) that still works.
     *
     * After a restart the OLD link answers 401 — the boot token is created per
     * process — so this is the link the user needs to get back into the
     * interface.
     */
    get accessRecord() {
      const read = readAccessRecord(path.dirname(stateFile))
      return read && read.ok === true ? read.record : null
    },
    /**
     * What the plugin knows about the self-starting supervisor: who starts
     * this host (the supervisor of this plugin / the user's own way / nobody)
     * and whether the restart can actually work.
     */
    supervisorStatus: supervisorStatusOf,
    /**
     * HOW this host was started (the startup matrix): the mode, the evidence
     * and what the plugin may do about it.
     */
    startupMode: startupModeOf,
    /**
     * WHAT IS ON DISK RIGHT NOW: the backups of this host.
     */
    backupsInfo,
    // RESTORE ONE COPY THE USER PICKED (they may know better than "the newest
    // proven one"): save the current state, restore the picked copy, request a
    // normal restart.
    manualRollback,
    // THE LAST COOKIE CLEANUP (the stale `dsh-auth-*` cookies that make the
    // desktop app die on startup). It is the result the cleanup script wrote
    // down, never a live count: the jar is locked by the running browser.
    cookieClearInfo,
    /**
     * THE DIAGNOSTICS of "report a problem" (the text the user copies).
     */
    diagnostics: diagnosticsText,
    /**
     * WHICH MACHINE IS THIS? (Windows / WSL / Linux / macOS) — the same
     * answer the graceful shutdown uses.
     */
    hostKind: hostKindOf,
    /**
     * Install the supervisor. `confirmed` must be true: the confirmation card
     * is what says "yes".
     */
    installSupervisor: installSupervisorNow,
    /**
     * Remove the supervisor and give the machine back to the user.
     */
    uninstallSupervisor: uninstallSupervisorNow,
    /**
     * Record the answer of the one-time question about the supervisor.
     */
    recordSupervisorChoice: recordSupervisorChoice,
    /**
     * Derive the command that starts this host again (the dry run: nothing is
     * written).
     */
    deriveStartCommand: deriveStartCommandNow,
    /**
     * Write the derived command into the profile configuration (only after
     * the user confirmed it).
     */
    applyDerivedCommand: applyDerivedCommand,
    /**
     * Put the previous start command back (the undo).
     */
    revertDerivedCommand: revertDerivedCommand,
    /**
     * The answer of the one-time question about the supervisor (null when it
     * was never answered).
     */
    get onboardingChoice() {
      const record = state.onboarding
      if (!record || typeof record !== 'object') return null
      if (record.feature !== 'supervisor') return null
      return {
        feature: record.feature,
        version: record.version,
        choice: record.choice,
        answeredAt: record.answeredAt,
      }
    },
    /**
     * Whether the one-time question about the supervisor may be asked.
     *
     * ONLY for the HOSTED hosts: the desktop app brings itself back up
     * (`restartMode: app`), so asking a hosted user "shall I install a
     * supervisor?" would be noise there.
     *
     * And NEVER when somebody else is already in charge: a second supervisor
     * would fight over the port with the first one — that is the double start
     * the whole external-supervisor detection exists to prevent.
     */
    get supervisorOffer() {
      if (env.isDesktopApp) return false
      const record = state.onboarding
      if (record && typeof record === 'object' && record.feature === 'supervisor') return false
      try {
        const status = supervisorStatusOf()
        if (status && status.mode === 'external') return false
      } catch {}
      return true
    },
    env,
    stateFile,
    log,
    persist,
    /**
     * Persist one or more user choices into the profile row of this plugin.
     *
     * @param {{ backupOnRestart?: boolean, backupIncludePlugins?: boolean, showSleepButton?: boolean, sleepCountdownSeconds?: number }} changes
     * @returns {Promise<{ applied: 'config'|'fallback-file' }>}
     */
    applyConfigChoice: (changes) => persistConfigChoice(changes),
    /**
     * The feature announcements the user has not seen yet.
     *
     * @returns {{ feature: string, version: string }[]}
     */
    pendingAnnouncements,
    /**
     * Record that the user has seen the announcement of one feature.
     *
     * @param {string} feature
     * @returns {string[]} the features that are recorded now
     */
    markFeatureSeen,
    /**
     * Record that the user has seen the announcement of every feature.
     *
     * @returns {string[]} the features that are recorded now
     */
    markAllFeaturesSeen,
    /**
     * Persist the user's one-time install choice: whether the pre-restart
     * backup also snapshots the installed plugin tree.
     *
     * @param {boolean} includePlugins
     * @returns {Promise<{ applied: 'config'|'fallback-file', includePlugins: boolean }>}
     */
    async applyBackupChoice(includePlugins) {
      const result = await persistConfigChoice({ backupIncludePlugins: includePlugins === true })
      return { applied: result.applied, includePlugins: includePlugins === true }
    },
    /**
     * Persist whether the graceful-sleep button is shown in the main UI.
     *
     * @param {boolean} showSleepButton
     * @returns {Promise<{ applied: 'config'|'fallback-file', showSleepButton: boolean }>}
     */
    async applySleepButtonChoice(showSleepButton) {
      const result = await persistConfigChoice({ showSleepButton: showSleepButton === true })
      return { applied: result.applied, showSleepButton: showSleepButton === true }
    },
    toolErrors,
    /**
     * The routes of this plugin that the web server accepted, and the ones it
     * refused. The boot check reports them: a host that came up without its
     * routes is NOT a healthy host.
     */
    registeredRoutes,
    routeErrors,
    /**
     * The outcome of the boot recovery pass of THIS boot:
     * `{ ran, ok, detail }`. `ran` is false when the recovery is switched off.
     */
    recovery: null,
    /**
     * The durable record of the last restart (the snapshot that was taken and
     * the verdict of the instance that came up).
     */
    lastRestartVerdict,
    recordRestartVerdict,
    startPolling,
    stopPolling,
    tick,
    anyAgentRunning,
    /**
     * Whether a restart is still pending (the graceful shutdown waits for it).
     *
     * @returns {boolean}
     */
    pendingRestart,
    /**
     * How long the host has been quiet (no REAL conversation activity: a
     * running turn, a queued message, a turn that started or ended).
     *
     * The routine session events of the interface do not count.
     *
     * @returns {number}
     */
    quietForMs,
    /**
     * The moment the quiet window started.
     *
     * @returns {number} a timestamp in milliseconds
     */
    quietSince,
    /**
     * THE LAST GATE DECISION (diagnostics only, 2026-11-02): what the
     * pending-restart gate decided, why, who was blocking it, how long the
     * request had waited and how many execution attempts there were.
     *
     * `null` when the gate has not decided anything on this machine yet.
     *
     * @returns {object|null}
     */
    restartGateInfo,
    /**
     * WHO reset the quiet window last — the event type, the session and whether
     * that session was a subagent (diagnostics only).
     *
     * @returns {{ quietResetBy: string, quietResetAt: number, quietResetSessionId: string|null, quietResetIsSubagent: boolean }}
     */
    quietResetInfo,
    /**
     * The RESTART reserve: the extra wait after the last conversation
     * finished, before the host is really restarted.
     *
     * @returns {number} milliseconds
     */
    graceMs,
    /**
     * The quiet window the restart gate really uses: the settle window, but
     * never shorter than the grace window.
     *
     * @returns {number} milliseconds
     */
    effectiveSettleMs,
    executeRestart,
    flushSessions,
    releaseRequesters,
    markDisposed: () => {
    stopRestartBusyWatch()
      disposed = true
    },
    noteActivity,
    busyAgents,
    gate,
    /**
     * The description of a long wait (null when there is none).
     *
     * @param {number} [now]
     * @returns {{ since: number, reason: string, waitedMs: number, blockedBy: any[] }|null}
     */
    longWaitInfo,
    /**
     * The upper bound of a queued (unclaimed) inbox message.
     *
     * @returns {number} milliseconds
     */
    queuedGraceMs: () => config.queuedGraceMs,
    sessionTitle,
    disarmGoal,
    disarmBlockingGoals,
    /**
     * Disarm the goal of the session(s) that asked for the pending restart, the
     * moment the request is queued (so a goal-driven session stops starting new
     * rounds and the quiet window can fill).
     *
     * @param {string|string[]} sessionIds
     * @param {{ reason?: string }} [options]
     */
    disarmQueuedRestartGoals,
    /**
     * Re-arm the goals a queued restart took away — the withdraw path: a
     * cancelled restart must not leave a session standing still.
     *
     * @param {{ reason?: string }} [options]
     */
    rearmQueuedRestartGoals,
    /** What the queued restarts took away (for the status surfaces). */
    queuedGoalDisarmList,
    disarmedGoalRecords,
    parkedGoalRecords,
    goalFor,
    handoffRecord: (sessionId) => handoffRecord(state, sessionId),
    overflowFor,
    readSession,
    handoff,
    boot,
    /**
     * Re-run the boot recovery for the still-pending sessions, right now.
     *
     * This is the retry path behind `continuum_recover_now` and the POST
     * `/recover` route: a session whose agent was not live yet, or whose
     * `goals.resume` failed, can be retried without waiting for the next boot.
     * Every attempt reports its own action/detail, exactly like the boot pass.
     *
     * @param {string} [sessionId] one session, or every pending session
     * @param {{ force?: boolean }} [options] `force` re-opens one explicit session
     *   (clearing a stale over-limit record and the attempt counter) before retrying
     * @returns {Promise<object[]>} one outcome per attempted session
     */
    async recoverNow(sessionId, { force = false } = {}) {
      const target = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
      // A session id like `__proto__` would land on the prototype of the
      // session map: it is refused, and NOTHING is written.
      if (target !== null && isForbiddenSessionId(target)) {
        return [{ sessionId: target, action: 'refused', detail: 'invalid-session-id' }]
      }
      if (force === true && target !== null) {
        // ONLY the own entry is read: a bare `state.sessions[target]` would
        // hand out `Object.prototype` itself for the id `__proto__`.
        const entry = sessionEntry(state, target)
        if (entry) {
          // An explicit retry re-checks the live evidence, so a stale record must
          // not keep the session out of recovery, and the attempt counter resets.
          entry.pendingResume = true
          entry.interrupted = true
          entry.pendingSince = Date.now()
          entry.resumeAttempts = 0
          entry.lastResumeError = null
          setContextOverflow(state, target, { over: false })
          // Clear the durable "never resume again" marker directly: calling the
          // handoff writer here would CREATE one (and clear pendingResume again).
          entry.handoff = null
          runtime.persist()
          log.info(`forced recovery for ${target}: cleared stale over-limit/handoff marks and the attempt counter`)
        }
      }
      const pending = recoverableSessions(state, {}).filter((entry) => (
        target === null ? true : String(entry.sessionId) === target
      ))
      if (pending.length === 0 && target !== null) {
        return [{ sessionId: target, action: 'nothing', detail: 'no-pending-recovery' }]
      }
      const results = []
      for (const entry of pending) {
        try {
          results.push(await recoverSession(ctx, runtime, entry, config))
        } catch (error) {
          const detail = describeError(error)
          setRecoveryOutcome(state, entry.sessionId, { action: 'prompt-failed', detail })
          results.push({ sessionId: entry.sessionId, action: 'prompt-failed', detail })
        }
      }
      try {
        runtime.persist()
      } catch {}
      return results
    },
  }
  return runtime
}

/**
 * Build the continuation message handed to `agent.followup`.
 *
 * This mirrors the shipped `createUserMessage` shape (`{id, role:'user', content, source}`,
 * frozen) without importing `@deepseek-ai/dsh-llm`, which a profile-installed bundle
 * cannot resolve. The `continuum` source kind keeps it distinguishable from a human
 * message: it is NOT human authority.
 *
 * @param {string} text
 * @param {{ summary?: string }} [options] one-line label of what this notice is
 * @returns {object} a frozen user message
 */
function createContinuationMessage(text, { summary } = {}) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'continuum',
      form: 'notice',
      summary: typeof summary === 'string' && summary.trim() !== ''
        ? summary.trim()
        : 'automatic continuation after a DeepSeek Harness restart',
    }),
  })
}

/**
 * Render an error-ish value (a thrown exception, a `{ code, message }` payload or
 * a plain string) as one short diagnostic string.
 * @param {unknown} value
 * @returns {string}
 */
function describeError(value) {
  if (value === null || value === undefined) return 'unknown error'
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const code = typeof value.code === 'string' && value.code !== '' ? value.code : null
    const message = typeof value.message === 'string' && value.message !== '' ? value.message : null
    if (code && message) return `${code}: ${message}`
    if (code) return code
    if (message) return message
  }
  try {
    return String(value)
  } catch {
    return 'unknown error'
  }
}

/**
 * Record the self-reported outcome of one recovery attempt for a session.
 *
 * Every return path of `recoverSession` calls this: a recovery that did nothing
 * must say WHY it did nothing, otherwise a stuck session is invisible in
 * `continuum_status` and in the `?state=1` route.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {string} action short action label (`resume-disarmed-goal`, …)
 * @param {string|null} [detail] short human-readable reason
 */
function noteRecovery(state, sessionId, action, detail = null) {
  try {
    setRecoveryOutcome(state, sessionId, { action, detail: detail == null ? null : String(detail) })
  } catch {}
}

/**
 * Decide what a session needs after a restart and do exactly that.
 * At-most-once per boot: the resume attempt is persisted before any side effect.
 */
async function recoverSession(ctx, runtime, entry, config) {
  const log = runtime.log
  const state = runtime.state
  const sessionId = entry.sessionId
  const attemptCap = Number.isFinite(config.maxResumeAttempts) ? config.maxResumeAttempts : 2
  if (entry.resumeAttempts >= attemptCap) {
    // Retry budget exhausted: stop treating this session as recoverable so a
    // broken session can never make every boot retry forever. The failure stays
    // visible in continuum_status instead of being dropped silently.
    entry.pendingResume = false
    entry.interrupted = false
    entry.lastResumeError = entry.lastResumeError || 'resume attempts exhausted'
    noteRecovery(state, sessionId, 'nothing', 'resume-attempts-exhausted')
    runtime.persist()
    log.info(`giving up on session ${sessionId}: resume attempts exhausted`, { lastResumeError: entry.lastResumeError })
    return { sessionId, action: 'nothing', detail: 'resume-attempts-exhausted', error: entry.lastResumeError }
  }

  // CONTEXT-OVERFLOW GUARD. A session whose conversation outgrew the model window
  // can neither continue nor be compacted (the compaction request needs the same
  // oversized context): every request to it fails with "context window exceeds
  // limit". Re-arming its goal or queueing a continuation message into it can
  // therefore only fail, so the guard runs BEFORE the goal re-arm and before the
  // disarm decision. Evidence: a verdict an earlier pass already recorded, or the
  // LIVE session (the newest assistant message's `usage.inputTokens` versus the
  // session's `contextWindow`, or a recent context-window failure). Unknown
  // numbers never block the normal path.
  const recordedOverflow = entry.contextOverflow && entry.contextOverflow.over === true
    ? entry.contextOverflow
    : null
  // The LIVE session is authoritative. A record is only a fallback for a session
  // this process cannot read at all; a record whose evidence no longer holds (for
  // example a false positive from an older detector) is cleared instead of
  // keeping the session out of recovery forever.
  let liveReadable = false
  try {
    const read = runtime.readSession(sessionId)
    liveReadable = Boolean(read && read.session)
  } catch {
    liveReadable = false
  }
  let overflow = null
  if (liveReadable) {
    try {
      overflow = runtime.overflowFor(sessionId)
    } catch {
      overflow = null
    }
    if ((!overflow || overflow.over !== true) && recordedOverflow !== null) {
      setContextOverflow(state, sessionId, { over: false })
      runtime.persist()
      log.info(`cleared a stale over-limit record for ${sessionId}: the live session is not over the window`)
    }
  } else if (recordedOverflow !== null) {
    overflow = {
      over: true,
      inputTokens: Number.isFinite(recordedOverflow.inputTokens) ? recordedOverflow.inputTokens : null,
      contextWindow: Number.isFinite(recordedOverflow.contextWindow) ? recordedOverflow.contextWindow : null,
      detail: typeof recordedOverflow.detail === 'string' && recordedOverflow.detail !== ''
        ? recordedOverflow.detail
        : 'the session is over the model context window (recorded by an earlier recovery)',
    }
  }
  if (overflow && overflow.over === true) {
    const detail = typeof overflow.detail === 'string' && overflow.detail !== ''
      ? overflow.detail
      : 'the session is over the model context window'
    setContextOverflow(state, sessionId, {
      over: true,
      inputTokens: overflow.inputTokens,
      contextWindow: overflow.contextWindow,
      detail,
      detectedAt: Date.now(),
    })
    // Out of the automatic resume path for good: the goal is NOT re-armed, no
    // continuation message is queued, and `recoverableSessions` skips an
    // over-limit entry from now on. The recovery attempt is still reported.
    entry.pendingResume = false
    entry.interrupted = false
    noteRecovery(state, sessionId, 'context-overflow', detail)
    runtime.persist()
    log.warn(`session ${sessionId} is over the model context window and is NOT re-armed: hand it off with continuum_handoff`, { detail })
    return { sessionId, action: 'context-overflow', detail, overContextLimit: true }
  }

  // Persist the attempt BEFORE any side effect, so a crash cannot double-resume and
  // a failing resume still counts against the budget.
  entry.resumeAttempts += 1
  entry.lastResumeAt = Date.now()
  runtime.persist()

  let agent
  try {
    agent = ctx.agents.get(sessionId)
  } catch {
    agent = undefined
  }

  if (agent === undefined) {
    // Resolve the controller defensively: the declared dependency first, then the
    // optional lookup (a late-provided service still resumes this way).
    let controller = null
    let controllerPath = 'none'
    try {
      if (ctx.sessionController && typeof ctx.sessionController === 'object') {
        controller = ctx.sessionController
        controllerPath = 'inject'
      }
    } catch {}
    if (controller === null) {
      try {
        const viaGet = ctx.get('sessionController')
        if (viaGet && typeof viaGet === 'object') {
          controller = viaGet
          controllerPath = 'get'
        }
      } catch {}
    }
    const canResolve = Boolean(controller) && typeof controller.resolveAgent === 'function'
    const canPrompt = Boolean(controller) && typeof controller.prompt === 'function'

    // Fallback: the controller prompt RESUMES a cold session and admits the
    // message in one step, so it can replace resolveAgent + followup entirely.
    if (!canResolve) {
      if (canPrompt) {
        const text = continuationPrompt(entry, {
          reason: (Array.isArray(entry.reasons) && entry.reasons[entry.reasons.length - 1]) || 'host restart',
          override: config.continuationText,
        })
        try {
          await controller.prompt({
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          })
          entry.pendingResume = false
          entry.running = false
          entry.interrupted = false
          entry.lastResumeError = null
          noteRecovery(state, sessionId, 'resume-via-prompt', `sessionController.prompt (${controllerPath})`)
          runtime.persist()
          log.info(`resumed ${sessionId} through sessionController.prompt (${controllerPath})`)
          return { sessionId, action: 'resume-via-prompt', detail: `sessionController.prompt (${controllerPath})`, controllerPath }
        } catch (error) {
          const detail = describeError(error)
          entry.lastResumeError = detail
          noteRecovery(state, sessionId, 'prompt-failed', detail)
          runtime.persist()
          log.warn(`sessionController.prompt failed for ${sessionId}:`, detail)
          return { sessionId, action: 'prompt-failed', detail, error: detail, controllerPath }
        }
      }
      const detail = controller === null
        ? 'the session controller is not reachable (neither the declared inject nor ctx.get returned it)'
        : 'the session controller exposes neither resolveAgent nor prompt'
      log.warn('sessionController is unavailable; cannot resume', sessionId, detail)
      noteRecovery(state, sessionId, 'session-controller-unavailable', detail)
      runtime.persist()
      return { sessionId, action: 'session-controller-unavailable', detail, controllerPath }
    }
    // A freshly reloaded profile can expose the live agent a moment after the
    // state file was written, so a THROWN error is retried inside the same boot
    // (up to RESOLVE_RETRY_ATTEMPTS extra attempts).
    // A returned `{ error }` is the controller's STABLE answer (the session is
    // gone): it is final and is NOT retried, so one boot makes exactly ONE
    // persistent attempt per session and `resumeAttempts` grows once per boot.
    let result
    let lastError = null
    let thrown = false
    const retries = RESOLVE_RETRY_ATTEMPTS
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        result = await controller.resolveAgent(sessionId)
        lastError = result && result.error ? describeError(result.error) : null
        thrown = false
      } catch (error) {
        result = undefined
        lastError = describeError(error)
        thrown = true
      }
      if (!lastError) break
      if (!thrown) break
      if (attempt < retries) {
        log.warn(`resolveAgent failed for ${sessionId} (attempt ${attempt + 1}); retrying:`, lastError)
        await recoveryDelay(config.resumeRetryDelayMs)
      }
    }
    if (lastError) {
      // Keep pendingResume: the session stays recoverable on a later boot (or a
      // later continuum_recover_now retry), but the failure is visible instead of
      // vanishing.
      entry.lastResumeError = lastError
      noteRecovery(state, sessionId, 'agent-not-live', lastError)
      runtime.persist()
      log.warn(`could not resume ${sessionId}:`, lastError)
      return { sessionId, action: 'agent-not-live', detail: lastError, error: lastError }
    }
    agent = result && result.agent
    if (agent) {
      noteRecovery(state, sessionId, 'resume-via-resolve-agent', `sessionController.resolveAgent (${controllerPath})`)
      runtime.persist()
    }
  }
  if (!agent) {
    entry.lastResumeError = 'resolveAgent returned no agent'
    noteRecovery(state, sessionId, 'agent-not-live', entry.lastResumeError)
    runtime.persist()
    return { sessionId, action: 'agent-not-live', detail: entry.lastResumeError, error: entry.lastResumeError }
  }

  let goal
  let goalLookupError = null
  try {
    goal = ctx.goals.get(agent)
  } catch (error) {
    goalLookupError = describeError(error)
    log.warn(`goals.get failed for ${sessionId}:`, goalLookupError)
  }
  if (!goal || typeof goal !== 'object') {
    goal = undefined
    if (goalLookupError === null) goalLookupError = 'goals.get returned no goal'
  }

  const disarmed = disarmedRecord(state, sessionId)
  const legacyParked = parkedRecord(state, sessionId)
  let resumeError = null
  let resumeAction = null

  // (1) The goal THIS plugin disarmed before the restart: it is still durably
  // `active` and only its activation is `disarmed`, so re-arming it with its
  // current revision lets the goal round driver continue the work.
  if (goal && disarmed && goal.phase === 'active' && goal.activation === 'disarmed' && disarmed.goalId === goal.id) {
    resumeAction = 'resume-disarmed-goal'
  }

  // (2) The goal the PREVIOUS (pause-based) build PAUSED: we paused it, so we may
  // resume it. A goal the USER paused has no record and must stay paused.
  if (resumeAction === null && goal && legacyParked && goal.phase === 'paused' && legacyParked.goalId === goal.id) {
    resumeAction = 'resume-paused-goal'
  }

  // (3) The already proven boot path: an active goal whose continuation authority
  // is gone is re-armed (the host may have disarmed it on shutdown).
  if (
    resumeAction === null
    && goal
    && goal.phase === 'active'
    && goal.activation === 'disarmed'
    && goal.roundsStarted < goal.maxGoalRounds
  ) {
    resumeAction = 'rearm-goal'
  }

  if (resumeAction !== null) {
    try {
      ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
      // The goal is armed again: stamp the record(s) of this session with the
      // resume timestamp, so the status shows the goal as resumed (the record is
      // reporting only — it never decides whether a goal may be disarmed).
      stampResumedGoal(state, sessionId, { resumedAt: Date.now() })
      entry.pendingResume = false
      entry.running = false
      entry.interrupted = false
      entry.lastResumeError = null
      entry.goal = { goalId: goal.id, goalRevision: goal.revision + 1, phase: 'active' }
      noteRecovery(state, sessionId, resumeAction, `goal ${goal.id} is armed again`)
      runtime.persist()
      log.info(`${resumeAction}: goal ${goal.id} of session ${sessionId} is armed again; the goal round driver continues the work`)
      return { sessionId, action: resumeAction, goalId: goal.id, detail: `goal ${goal.id} is armed again` }
    } catch (error) {
      // Stale revision or an exhausted round budget: fall back to the
      // continuation message and KEEP the record, so a later boot (or a manual
      // continuum_recover_now retry) can try to resume the goal again.
      resumeError = describeError(error)
      entry.lastResumeError = resumeError
      log.warn(`could not resume goal ${goal.id} of ${sessionId} (${resumeAction}):`, resumeError)
    }
  }

  if (!entry.pendingResume && !entry.interrupted) {
    if (resumeError) {
      entry.lastResumeError = resumeError
      noteRecovery(state, sessionId, resumeAction || 'nothing', `resume failed: ${resumeError}`)
      runtime.persist()
      return { sessionId, action: resumeAction || 'nothing', detail: `resume failed: ${resumeError}`, error: resumeError }
    }
    noteRecovery(state, sessionId, resumeAction || 'nothing', resumeAction ? 'goal handled, session not pending' : 'session-not-pending')
    runtime.persist()
    return { sessionId, action: resumeAction || 'nothing', detail: 'session-not-pending' }
  }

  // A failed goal lookup is not a reason to skip the session: the continuation
  // message still makes progress, and the reason is recorded for the operator.
  let pendingAction = 'prompt-continuation'
  let pendingDetail = resumeError ? `goal resume failed: ${resumeError}` : 'continuation message queued'
  if (goal === undefined) {
    pendingAction = 'goal-lookup-failed'
    pendingDetail = `${goalLookupError || 'goals.get returned no goal'}; continuation message queued`
  }

  // Inject exactly one continuation message through the live agent's inbox. The
  // Remote-facing `sessionController.prompt` is NOT usable here: its in-process
  // signature is `prompt(request, signal)` and it hardcodes a human `user` source.
  if (typeof agent.followup !== 'function') {
    log.warn('the resumed agent exposes no followup(); cannot inject the continuation prompt')
    noteRecovery(state, sessionId, 'prompt-failed', 'the agent exposes no followup()')
    runtime.persist()
    return { sessionId, action: 'prompt-failed', detail: 'the agent exposes no followup()' }
  }
  const text = continuationPrompt(entry, {
    reason: (Array.isArray(entry.reasons) && entry.reasons[entry.reasons.length - 1]) || 'host restart',
    override: config.continuationText,
  })
  try {
    agent.followup(createContinuationMessage(text))
  } catch (error) {
    const detail = describeError(error)
    log.warn(`continuation message rejected for ${sessionId}:`, detail)
    noteRecovery(state, sessionId, 'prompt-failed', detail)
    runtime.persist()
    return { sessionId, action: 'prompt-failed', detail }
  }
  entry.pendingResume = false
  entry.running = false
  entry.interrupted = false
  entry.lastResumeError = resumeError
  noteRecovery(state, sessionId, pendingAction, pendingDetail)
  runtime.persist()
  log.info(`queued a continuation message for session ${sessionId}`)
  return { sessionId, action: pendingAction, detail: pendingDetail }
}

/**
 * THE PENDING RESTART AT BOOT — consumed, kept, or dropped with a record.
 *
 * WHY THIS IS A FUNCTION AND NOT AN `if` (real-host report, hosted `dsh web` on
 * 5601): the recovery pass cleared `state.restart` on EVERY boot with the
 * comment "a restart that was requested before the last shutdown has been
 * consumed by this boot" — a claim it never checked. A request that was merely
 * QUEUED (postponed by the idle gate, nothing executed) was not consumed by
 * anything, so booting the plugin silently threw the user's request away: no
 * restart, no generation bump, no verdict, no reason. That is the disappearance.
 *
 * Now the decision is explicit (`decidePendingRestartOnBoot`), and the two
 * "drop" outcomes leave a record behind.
 *
 * @param {object} runtime
 */
export function settlePendingRestartOnBoot(runtime) {
  const state = runtime.state
  const log = runtime.log
  if (!state.restart) return { action: 'none', why: 'no-restart-pending' }
  const decision = decidePendingRestartOnBoot({ restart: state.restart, now: Date.now() })
  if (decision.action === 'keep') {
    // The request of an earlier instance that never got as far as executing:
    // this boot carries it out. Saying it in the log is not enough — the record
    // says it too, and polling is re-armed so it really happens.
    log.warn('a restart request was queued before this boot and never executed; this boot carries it out', {
      why: decision.why,
      detail: decision.detail,
      requestedAt: state.restart.requestedAt,
    })
    recordRestartRequestFateSafe(runtime, 'queued', {
      reason: 'the request survived a boot without having been executed (' + decision.why + ')',
      by: 'boot-recovery',
    })
    try {
      runtime.startPolling()
    } catch (error) {
      log.warn('could not re-arm the restart polling for the request of the earlier boot:', String(error))
    }
    return { action: 'keep', why: decision.why }
  }
  log.warn('the pending restart of the earlier boot is settled: ' + decision.why, { detail: decision.detail })
  const dropped = dropRestartRequestSafe(runtime, {
    reason: 'the boot settled this request: ' + decision.why + ' (' + decision.detail + ')',
    by: 'boot-recovery',
  })
  return { action: dropped.dropped ? 'drop' : 'none', why: decision.why }
}

/**
 * `recordRestartRequestFate` on the runtime, without throwing when the runtime
 * is a test double that does not have it.
 *
 * @param {object} runtime
 * @param {string} result
 * @param {{ reason?: string|null, by?: string|null }} [options]
 */
function recordRestartRequestFateSafe(runtime, result, options = {}) {
  if (!runtime || typeof runtime.recordRestartRequestFate !== 'function') return null
  try {
    return runtime.recordRestartRequestFate(result, options)
  } catch {
    return null
  }
}

/**
 * `dropRestartRequest` on the runtime, tolerating a runtime that lacks it.
 *
 * @param {object} runtime
 * @param {{ reason?: string, by?: string }} [options]
 */
function dropRestartRequestSafe(runtime, options = {}) {
  if (!runtime || typeof runtime.dropRestartRequest !== 'function') {
    // Last resort (a runtime without the choke point): still cancel, but never
    // silently — the log line names the reason.
    if (runtime && runtime.state && runtime.state.restart) {
      cancelRestart(runtime.state, { now: Date.now() })
      if (typeof runtime.persist === 'function') runtime.persist()
    }
    return { dropped: false, record: null }
  }
  try {
    return runtime.dropRestartRequest(options)
  } catch {
    return { dropped: false, record: null }
  }
}

/** The boot recovery pass. Runs once per host boot, bounded and idempotent. */
async function recoverAfterRestart(ctx, runtime, config) {
  const log = runtime.log
  const state = runtime.state
  const plan = bootPlan(state, { resumeOnBoot: config.resumeOnBoot, limit: config.maxSessions })
  if (!plan.recover) {
    setPhase(state, 'idle')
    // NOT "a pending restart was consumed by this boot": that is only true when
    // the old instance had started it. See settlePendingRestartOnBoot.
    settlePendingRestartOnBoot(runtime)
    persistSafely(runtime)
    log.info('no interrupted work to recover')
    return { recovered: [], phase: 'idle' }
  }
  setPhase(state, 'recovering')
  persistSafely(runtime)
  log.info('recovering after restart:', {
    generation: state.generation,
    sessions: plan.sessions.map((entry) => entry.sessionId),
    restartWasPending: plan.restartWasPending,
  })

  // Recover in batches of `maxSessions` and keep going until nothing recoverable
  // is left: one coalesced restart can leave more pending sessions than a single
  // batch, and every requester must be woken in THIS boot, not the next one.
  const results = []
  const batchSize = Math.max(1, Number.isFinite(config.maxSessions) ? Math.trunc(config.maxSessions) : 4)
  const maxBatches = 5
  const batchDelayMs = Number.isFinite(config.recoveryBatchDelayMs) ? config.recoveryBatchDelayMs : 1200
  const attempted = new Set()
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const pending = recoverableSessions(state, {})
      .filter((entry) => !attempted.has(entry.sessionId))
      .slice(0, batchSize)
    if (pending.length === 0) break
    if (batch > 0) {
      log.info('recovery batch', { batch: batch + 1, sessions: pending.map((entry) => entry.sessionId) })
    }
    for (const entry of pending) {
      attempted.add(entry.sessionId)
      try {
        results.push(await recoverSession(ctx, runtime, entry, config))
      } catch (error) {
        log.warn(`recovery failed for ${entry.sessionId}:`, String(error))
        results.push({ sessionId: entry.sessionId, action: 'threw' })
      }
    }
    // Pause between batches so the resumed turns can start before the next wave.
    if (batch + 1 < maxBatches && recoverableSessions(state, {}).some((entry) => !attempted.has(entry.sessionId))) {
      await recoveryDelay(batchDelayMs)
    }
  }

  // The recovery of the sessions is over; the restart request of the earlier
  // instance gets the SAME treatment as in the "nothing to recover" branch: it is
  // kept when it was never executed and is still fresh, and dropped WITH a
  // record otherwise. It used to be cancelled here unconditionally and silently.
  settlePendingRestartOnBoot(runtime)
  setPhase(state, 'running')
  // Never cap away recoverable work: keep every pending entry, only expire
  // finished ones by age so an unfinished backlog still recovers next boot.
  pruneSessions(state, {
    maxSessions: Infinity,
    now: Date.now(),
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  })
  const leftover = recoverableSessions(state, {})
  if (leftover.length > 0) {
    log.warn('recovery left sessions pending after the batch cap; they stay checkpointed for the next boot', {
      pending: leftover.map((entry) => entry.sessionId),
      batches: maxBatches,
      maxSessions: config.maxSessions,
    })
  }
  persistSafely(runtime)
  log.info('recovery finished:', results)
  return { recovered: results, phase: 'running' }
}

/**
 * How long a pending restart record stays fresh enough to be finished by
 * THIS boot. A record that is older belongs to a restart of another day — it
 * stays `pending`, because that restart really was never confirmed.
 */
export const RESTART_VERDICT_FRESH_MS = 30 * 60 * 1000

/**
 * The four checks the instance that replaced the old one runs on itself.
 *
 * They answer the question the operator actually has after a restart: "did
 * the new host really come up?" — and each of them is a fact about THIS boot,
 * not about the old one:
 *
 *   - `listener` — the host listens on a known port;
 *   - `routes`  — the routes of this plugin were accepted by the web server;
 *   - `plugin`  — the plugin itself is alive in this boot;
 *   - `recovery`— the boot recovery pass finished (or was not needed).
 *
 * @param {object} runtime
 * @returns {Array<{ name: string, ok: boolean, detail: string }>}
 */
export function collectBootChecks(runtime) {
  const checks = []

  const port = Number(runtime && runtime.webPort)
  checks.push({
    name: 'listener',
    ok: Number.isFinite(port) && port > 0,
    detail: Number.isFinite(port) && port > 0
      ? 'the host listens on port ' + port
      : 'the host does not listen on a known port',
  })

  const registered = Array.isArray(runtime && runtime.registeredRoutes) ? runtime.registeredRoutes : []
  const routeErrors = Array.isArray(runtime && runtime.routeErrors) ? runtime.routeErrors : []
  checks.push({
    name: 'routes',
    ok: registered.length > 0 && routeErrors.length === 0,
    detail: registered.length === 0
      ? 'no route of this plugin was registered'
      : registered.length + ' route(s) registered'
        + (routeErrors.length > 0 ? ', ' + routeErrors.length + ' refused' : ''),
  })

  const bootId = runtime && typeof runtime.bootId === 'string' ? runtime.bootId : ''
  const toolErrors = Array.isArray(runtime && runtime.toolErrors) ? runtime.toolErrors : []
  checks.push({
    name: 'plugin',
    ok: bootId !== '' && toolErrors.length === 0,
    detail: bootId === ''
      ? 'the plugin did not register a boot id'
      : 'the plugin is alive (boot ' + bootId + ')'
        + (toolErrors.length > 0 ? ', ' + toolErrors.length + ' tool(s) failed' : ''),
  })

  const recovery = runtime && runtime.recovery && typeof runtime.recovery === 'object'
    ? runtime.recovery
    : null
  checks.push({
    name: 'recovery',
    ok: recovery === null ? false : recovery.ok === true,
    detail: recovery === null
      ? 'the boot recovery did not report anything'
      : (typeof recovery.detail === 'string' && recovery.detail !== '' ? recovery.detail : 'the boot recovery finished'),
  })

  return checks
}

/**
 * THE TWO RECORDS THAT SAY "THIS BOOT NEEDED HELP".
 *
 * WHY THIS EXISTS (2026-11-01, strict mode): a copy may be certified even when
 * the boot it came from was rescued — the evidence is kept, and the SELECTOR
 * decides later whether such a copy is good enough. But "kept" only works if
 * somebody writes the fact down, and the fact lives in the reports the two
 * restorers already leave behind:
 *
 *   - `last-rollback.json`, written by the detached watcher and by the plugin
 *     itself when it restores the profile (`rolledBack`);
 *   - `last-watchdog-report.json`, written by the watchdog v2 (`restored`).
 *
 * NEITHER FILE IS TOUCHED HERE. Changing the restore decision is a later step;
 * this only reads what the restorers already said.
 *
 * THREE ANSWERS, ON PURPOSE:
 *   true   a restore is on record and it happened during THIS restart;
 *   false  the recorders were read and none of them reports a restore — a real
 *          "no", not a shrug;
 *   null   nothing on disk can answer (no recorder has written yet, a report
 *          cannot be read, or this boot cannot say when it started). `null` is
 *          NEVER rounded down to `false`: "we do not know" is a different fact
 *          from "it did not happen", and the selector has to be able to tell
 *          them apart.
 *
 * @param {string} stateDir
 * @param {{ sinceMs?: number|null }} [options] the start of the restart that produced this boot
 * @returns {{ intervention: boolean|null, reason: string, sources: Array<object> }}
 */
export function detectBootIntervention(stateDir, { sinceMs = null } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : ''
  if (dir === '') return { intervention: null, reason: 'there is no state directory to read', sources: [] }
  // ONLY A REAL NUMBER COUNTS. `Number(null)` is 0, so a loose check would quietly
  // turn "this boot cannot say when it started" into "everything counts", and a
  // restore from last week would be reported as an intervention in this boot.
  const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : null
  const candidates = [
    {
      name: 'rollback-report',
      file: path.join(dir, ROLLBACK_REPORT_NAME),
      restored: (record) => record.rolledBack === true,
    },
  ]
  const sources = []
  for (const candidate of candidates) {
    let exists = false
    try {
      exists = fs.existsSync(candidate.file) === true
    } catch {
      exists = false
    }
    if (exists !== true) {
      sources.push({ name: candidate.name, state: 'missing', at: null, restored: false })
      continue
    }
    let record = null
    try {
      let text = fs.readFileSync(candidate.file, 'utf8')
      // Windows PowerShell writes UTF-8 with a BOM; JSON.parse rejects it.
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const parsed = JSON.parse(text)
      record = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      record = null
    }
    if (record === null) {
      // A report that exists but cannot be read is NOT "nothing happened".
      return {
        intervention: null,
        reason: 'the ' + candidate.name + ' exists but cannot be read',
        sources,
      }
    }
    const at = (() => {
      if (typeof record.at === 'string' && record.at.trim() !== '') {
        const parsed = Date.parse(record.at)
        return Number.isFinite(parsed) ? parsed : null
      }
      if (Number.isFinite(record.at)) return Number(record.at)
      return null
    })()
    sources.push({ name: candidate.name, state: 'read', at, restored: candidate.restored(record) === true })
  }
  const read = sources.filter((source) => source.state === 'read')
  if (read.length === 0) {
    // Neither recorder has written anything: nobody can say whether this boot
    // needed help, and silence must not be read as "no".
    return { intervention: null, reason: 'no restorer has recorded anything yet', sources }
  }
  const restorations = read.filter((source) => source.restored === true)
  if (restorations.length === 0) {
    return { intervention: false, reason: 'no restore was recorded for this boot', sources }
  }
  if (since === null) {
    return {
      intervention: null,
      reason: 'a restore is on record, but this boot does not know when its restart started',
      sources,
    }
  }
  // A restore from an EARLIER cycle is history, not an intervention in this one:
  // the reports are never deleted, so the time is what separates the two.
  const relevant = restorations.filter((source) => source.at === null || source.at >= since)
  if (relevant.length === 0) {
    return {
      intervention: false,
      reason: 'the recorded restore is older than this restart',
      sources,
    }
  }
  return {
    intervention: true,
    reason: 'this boot was restored by ' + relevant.map((source) => source.name).join(', '),
    sources,
  }
}

/**
 * THE FINGERPRINT OF THE CONFIGURATION THAT IS ON DISK **RIGHT NOW**.
 *
 * WHY THIS EXISTS: certifying a copy asks ONE question — "is the content in the
 * snapshot the content this boot is running?" — and the snapshot side of that
 * answer is `contentFingerprintOf(snapshotDir)`, which reads
 * `<snapshot>/config/<name>`. The LIVE profile keeps the same three files at its
 * ROOT, so that reader cannot be pointed at it; reading the live profile is what
 * turns the comparison into a physical fact instead of a guess.
 *
 * WHY THE FORMAT IS REPEATED HERE instead of imported: the input stream belongs to
 * lib/backup.js (CONFIG_FILES, each hashed as name + length + content so two
 * different name/content splits can never produce the same stream). That module
 * is not part of this change, and copying the profile into a temporary tree just
 * to reuse the reader would write to disk on every boot. The two formats are
 * therefore PINNED TO EACH OTHER BY A TEST (test/certification-wiring.test.mjs,
 * "the drift guard"): if either side ever changes, that test fails instead of the
 * comparison quietly comparing apples with oranges.
 *
 * `null` — not a digest — when there is nothing to fingerprint: an unknown profile
 * directory, or one that holds NONE of the three files. A digest over
 * "everything missing" would equal the fingerprint of an empty copy and would
 * certify a boot that proved nothing at all.
 *
 * @param {string|null|undefined} profileDir the profile whose configuration is running
 * @returns {string|null} `sha256:<hex>`, or null when nothing could be read
 */
export function profileConfigFingerprint(profileDir) {
  const dir = typeof profileDir === 'string' ? profileDir.trim() : ''
  if (dir === '') return null
  const hash = crypto.createHash('sha256')
  let read = 0
  for (const name of CONFIG_FILES) {
    let text = null
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      text = null
    }
    if (text === null) {
      hash.update(name + '\u0000missing\u0000')
      continue
    }
    read += 1
    hash.update(name + '\u0000' + Buffer.byteLength(text, 'utf8') + '\u0000' + text)
  }
  if (read === 0) return null
  return 'sha256:' + hash.digest('hex')
}

/** The three answers to "where does the snapshot side of the comparison come from?". */
export const FINGERPRINT_SOURCES = Object.freeze({
  /** `meta.json` recorded one when the copy was taken — the original shape. */
  RECORDED: 'recorded',
  /** `meta.json` has none (the copy is older than the field), so it was computed NOW. */
  COMPUTED: 'computed',
  /** No recorded one AND none could be computed (the copy is gone / unreadable). */
  UNAVAILABLE: 'unavailable',
})

/**
 * The fingerprint state reported when the answer is `unavailable`.
 *
 * WHY A NAME OF ITS OWN instead of reusing `snapshot-missing`: the two mean
 * different things to the reader. "The snapshot has no fingerprint" is a fact
 * about an old copy; "the fingerprint could not be computed" is a fact about a
 * copy we could not read. Folding them together would report a computation
 * failure under the name of a content question — exactly what must not happen.
 */
export const FINGERPRINT_STATE_UNREADABLE = 'snapshot-unreadable'

/**
 * THE SNAPSHOT SIDE OF THE FINGERPRINT COMPARISON — recorded, computed, or nothing.
 *
 * THE RULE THE USER SETTLED (2026-11-01, 升级用户不许丢救援能力):
 *
 *   没指纹 ≠ 内容不对。A copy whose meta.json was written before fingerprints
 *   existed is NOT suspicious — nobody took its picture, that is all. The
 *   fingerprint is computed FROM the file contents, so as long as the copy is
 *   still on disk it can be taken again, right now, and then compared. What the
 *   comparison refuses is CONTENT that differs, never AGE.
 *
 * WHY COMPUTING IS THE SECOND CHOICE AND NOT THE FIRST: a recorded fingerprint is
 * evidence from the moment of the copy; a computed one is the copy describing
 * itself. So `meta.json` wins whenever it has an answer, and the computation only
 * fills the gap an old copy leaves.
 *
 * WHAT COMPUTING GIVES UP (said out loud, not hidden): the earlier rule read the
 * meta ONLY, so a copy edited after the fact could not certify itself — it would
 * show the recorded value, which no longer matched anything. With a computed
 * fallback that protection is weaker: an old copy (no recorded value) that was
 * edited after the fact now gets a fingerprint of its EDITED content, and if that
 * content also happens to be what the host is running, it certifies. Fooling it
 * takes editing the copy AND the live profile to the same content — at which
 * point "this content boots" is true anyway, which is the whole claim a
 * certification makes. The trade is deliberate: it buys back "the upgrade does
 * not take away every booted copy a user had".
 *
 * NOTHING IS WRITTEN HERE. The computed value is used for THIS decision only and
 * is never stored back into the meta: the field in `meta.json` is "what was
 * recorded when the copy was taken", and writing a value into it afterwards would
 * turn "I computed this" into "this was witnessed", which is the difference
 * between evidence and a copy vouching for itself.
 *
 * "COULD NOT COMPUTE" IS NOT "CONTENT DIFFERS": `contentFingerprintOf` always
 * returns a digest (a copy with none of the three files hashes the "missing"
 * markers), and that digest is worthless — it would equal the fingerprint of any
 * other empty copy. So the copy is checked first: an unknown / missing /
 * unreadable directory, or a `config/` in which NONE of the three files can be
 * read, is reported as `unavailable` with a reason that says the copy could not
 * be read. The caller must report it as a computation failure, never as a
 * mismatch — the two send the reader hunting for different things.
 *
 * @param {string|null|undefined} backupDir the copy this restart came from
 * @param {{ meta?: object|null }} [options] already-read meta (avoids a second read)
 * @returns {{
 *   fingerprint: string|null,
 *   source: string,
 *   computeError: string|null,
 *   readableFiles: number,
 *   reason: string|null,
 * }}
 */
export function snapshotConfigFingerprint(backupDir, { meta = null } = {}) {
  const dir = typeof backupDir === 'string' ? backupDir.trim() : ''
  const recordedMeta = meta !== null && typeof meta === 'object'
    ? meta
    : (dir === '' ? null : readBackupMeta(dir))
  const recorded = recordedMeta !== null && typeof recordedMeta.contentFingerprint === 'string'
    ? recordedMeta.contentFingerprint.trim()
    : ''
  if (recorded !== '') {
    // The original path: nothing is recomputed, nothing is second-guessed.
    // (`readableFiles: 0` here is literal: in this branch the copy is not read.)
    return {
      fingerprint: recorded,
      source: FINGERPRINT_SOURCES.RECORDED,
      computeError: null,
      readableFiles: 0,
      reason: null,
    }
  }
  const unavailable = (computeError) => ({
    fingerprint: null,
    source: FINGERPRINT_SOURCES.UNAVAILABLE,
    computeError,
    readableFiles: 0,
    reason: 'the snapshot holds no recorded contentFingerprint and no fingerprint could be computed from it either ('
      + computeError + '): this is a COMPUTATION failure — the copy could not be read, so its content was never '
      + 'compared and nothing about it is disproven',
  })
  if (dir === '') {
    return unavailable('the snapshot directory is not even named')
  }
  let stats = null
  try {
    stats = fs.statSync(dir)
  } catch (error) {
    return unavailable('the snapshot directory is missing or unreadable ('
      + String(error && error.code ? error.code : error) + ')')
  }
  if (!stats.isDirectory()) {
    return unavailable('the snapshot path is not a directory')
  }
  // One readable file is enough for a real answer; none at all is not "an empty
  // copy", it is "this is not a copy" — see the docstring.
  let readableFiles = 0
  for (const name of CONFIG_FILES) {
    try {
      fs.readFileSync(path.join(dir, CONFIG_DIR, name), 'utf8')
      readableFiles += 1
    } catch {}
  }
  if (readableFiles === 0) {
    return unavailable('none of the configuration files (' + CONFIG_FILES.join(', ') + ') could be read inside '
      + path.join(dir, CONFIG_DIR))
  }
  return {
    fingerprint: contentFingerprintOf(dir),
    source: FINGERPRINT_SOURCES.COMPUTED,
    computeError: null,
    readableFiles,
    reason: null,
  }
}

/**
 * HOW A FINGERPRINT WAS OBTAINED, said in the log line that carries the verdict.
 *
 * WHY IT MUST BE SAID: a computed value and a recorded one are the same kind of
 * string, so without this sentence a later reader cannot tell "this copy was
 * fingerprinted when it was taken" apart from "this fingerprint was taken during
 * the certification, from a copy nobody photographed". The first says the copy has
 * not been touched since; the second says what it holds NOW. Only one of those is
 * true of any given copy, and the log must not leave the reader to guess which.
 *
 * The `recorded` case adds nothing: it is the normal shape, and every existing
 * sentence already reads as if the value came from the meta.
 *
 * @param {unknown} source one of FINGERPRINT_SOURCES
 * @returns {string} a sentence to append to the reason, or an empty string
 */
export function fingerprintSourceNote(source) {
  if (source === FINGERPRINT_SOURCES.COMPUTED) {
    return ' (the snapshot side was COMPUTED just now from the copy\'s own config/: its meta.json has no '
      + 'contentFingerprint, so this fingerprint describes what the copy holds NOW, not what was recorded when '
      + 'it was taken)'
  }
  return ''
}

/**
 * Finish the durable restart record.
 *
 * The instance that replaced the old one reads the `pending` record, runs the
 * four boot checks and writes the final verdict (`ok` / `failed`) with the
 * time it verified itself and how long the whole restart took.
 *
 * Nothing is written when there is no pending record (this boot was not the
 * result of a restart) or when the pending record belongs to another day.
 *
 * CERTIFICATION IS PART OF THIS: when all four checks passed, the snapshot the
 * pending record points at is a candidate — and it is promoted only if its
 * `contentFingerprint` EQUALS the fingerprint of the configuration this boot is
 * running (`profileConfigFingerprint`). A difference means the disk was written to
 * between the two boots (restore / hand edit / another writer), so this boot proved
 * other content and the snapshot stays unproven.
 *
 * A copy older than the fingerprint field is NOT refused for being old: its
 * fingerprint is COMPUTED from the copy's own `config/` (`snapshotConfigFingerprint`)
 * and then compared exactly like a recorded one. 没指纹 ≠ 内容不对 — 老备份只是当初
 * 没拍照，补拍一张再比；不补，升级一次就把用户手里那份能回退的备份全收走了。 What still
 * refuses is CONTENT that differs, and a reference that cannot even be computed
 * (missing / unreadable copy), which is reported as a computation failure — never
 * as a mismatch. The computed value is NOT written back into the meta.
 *
 * @param {object} runtime
 * @param {{ timeoutMs?: number, now?: number, sleep?: Function }} [options]
 * @returns {Promise<object|null>} the record that is on disk now
 */
export async function verifyRestartBoot(runtime, options = {}) {
  const log = runtime.log
  const stateDir = path.dirname(runtime.stateFile)
  const pending = readRestartVerdict(stateDir)
  if (pending === null) return null
  if (pending.result !== RESTART_RESULTS.PENDING) return pending
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : 15000
  const sleep = typeof options.sleep === 'function' ? options.sleep : recoveryDelay
  const started = now()
  // The web server may still be coming up: the checks need its port and its
  // routes, so they wait — but only for a bounded while.
  while (now() - started < timeoutMs) {
    const port = Number(runtime.webPort)
    const registered = Array.isArray(runtime.registeredRoutes) ? runtime.registeredRoutes.length : 0
    if (Number.isFinite(port) && port > 0 && registered > 0) break
    await sleep(250)
  }
  const checks = collectBootChecks(runtime)
  const evaluated = evaluateRestartChecks(checks)
  const verifiedAt = now()
  const record = runtime.recordRestartVerdict({
    result: evaluated.ok ? RESTART_RESULTS.OK : RESTART_RESULTS.FAILED,
    verifiedAt,
    durationMs: pending.startedAt !== null ? Math.max(0, verifiedAt - pending.startedAt) : null,
    bootId: runtime.bootId,
    checks,
    reason: evaluated.ok
      ? 'the new instance came up and every check passed'
      : 'the new instance came up, but ' + evaluated.failed.join(', ') + ' failed',
  })
  if (record !== null) {
    if (evaluated.ok) {
      log.warn('the new instance verified itself:', { durationMs: record.durationMs, checks })
      // THIS SNAPSHOT HAS NOW PROVEN IT BOOTS — but "it boots" is the verdict of
      // THIS restart, and certification is a DIFFERENT question (2026-11-01):
      // it may only happen when this boot ran on EXACTLY the content the snapshot
      // holds. `decideBootCertification` answers that one, and it refuses a list
      // that is merely non-empty: a boot that skipped the checks proves nothing
      // about the configuration.
      const snapshotDir = pending && pending.snapshot && typeof pending.snapshot.dir === 'string'
        ? pending.snapshot.dir
        : ''
      if (snapshotDir !== '') {
        // THE TWO FINGERPRINTS, both obtained HERE, from the two places that really
        // hold them:
        //   - the snapshot side: what its meta.json RECORDED when the copy was
        //     taken — and, for a copy older than that field, one COMPUTED from the
        //     copy's own `config/` right now (`snapshotConfigFingerprint`).
        //     没指纹 ≠ 内容不对：升级上来的老备份不是可疑，只是当初没拍照；文件还在，
        //     就能补拍一张再比。不给它补，等于升级一次就把用户那份能回退的备份全收走。
        //     代价（现算放弃了「事后被改过的副本不能自证」这层防护）写在
        //     `snapshotConfigFingerprint` 的注释里，那里是唯一的出处。
        //   - the current side is the configuration on disk in this very boot.
        const side = snapshotConfigFingerprint(snapshotDir)
        if (side.source === FINGERPRINT_SOURCES.UNAVAILABLE) {
          // 「算不出来」不是「内容不一致」，这句话必须说准：报成不一致，读日志的人
          // 会去查「谁改过这次配置」；真正的事实是这份副本读不出来了（目录没了、
          // config/ 读不出文件）。两件事让人去查的地方完全不同。
          log.warn('the snapshot of this restart stays UNPROVEN: ' + side.reason, {
            dir: snapshotDir,
            fingerprintState: FINGERPRINT_STATE_UNREADABLE,
            fingerprintSource: side.source,
            computeError: side.computeError,
          })
        } else {
          const liveProfileDir = runtime.profileDir && typeof runtime.profileDir.dir === 'string'
            ? runtime.profileDir.dir
            : ''
          const currentFingerprint = profileConfigFingerprint(liveProfileDir)
          const decision = decideBootCertification(checks, { snapshotFingerprint: side.fingerprint, currentFingerprint })
          // Said in the reason itself, so the log line names how the snapshot side
          // was obtained: `recorded` (taken when the copy was made) or `computed`
          // (taken just now, from a copy that never had one).
          const sourceNote = fingerprintSourceNote(side.source)
          if (decision.certified !== true) {
            // NOTHING is promoted and the meta is NOT touched — including in the
            // computed case: the value computed for THIS comparison is not stored
            // back into the copy's meta (see `snapshotConfigFingerprint`).
            log.warn('the snapshot of this restart stays UNPROVEN: ' + decision.reason + sourceNote, {
              dir: snapshotDir,
              fingerprintState: decision.fingerprintState,
              fingerprintSource: side.source,
              // SHORT VALUES ONLY: the point is "which one differs from which",
              // and twelve characters say that without flooding the log.
              snapshotFingerprint: shortFingerprint(decision.snapshotFingerprint),
              currentFingerprint: shortFingerprint(decision.currentFingerprint),
              failed: decision.failed,
              missing: decision.missing,
              extraFailed: decision.extraFailed,
            })
          } else {
            // 为什么 `intervention` 继续写、但**不再参与判据**（真机证据，2026-11-01）：
            // 兜底那份 `2026-11-01T12-04-33-777Z` 的 meta 里 `intervention=false`，可那次
            // 宿主其实是先被还原过才起来的 —— 说明「谁介入过」这件事**检测不准**（没检测到
            // 不等于没发生）。而「这次启动跑的配置 == 快照里那份」是当场能算的硬事实，所以
            // 判据换成指纹比对；intervention 只留作事后排查的线索，写而不判。
            // 也正因如此：指纹一致 + 四检全过才会走到这里，restore 改过盘就一定不一致。
            const intervention = detectBootIntervention(stateDir, { sinceMs: pending.startedAt })
            const promoted = markKnownGood(snapshotDir, {
              // THE FACTS, NOT A VERDICT (user decision, 2026-11-02): that boot came
              // up, it was running exactly the content this copy holds, and the four
              // startup checks are what looked at it. "插件可用" is not one of those
              // three answers, and the record no longer pretends to give it.
              observedBy: BOOT_OBSERVATIONS.STARTUP_CHECKS,
              hostStarted: true,
              contentMatched: decision.fingerprintsEqual === true,
              // DID ANY PLUGIN FAIL TO LOAD on that boot: the `plugin` check is the
              // one that carries it, and this promotion only runs when every check
              // passed — so the honest answer here is an empty list, not "unknown".
              // (It is recorded anyway, so a future boot that reports failures has
              // somewhere to put them instead of a field nobody writes.)
              loadFailures: checks
                .filter((check) => check.name === 'plugin' && check.ok !== true)
                .map((check) => ({ plugin: null, version: null, error: check.detail })),
              // The content that was PROVEN is the fingerprint that was compared —
              // recorded in the meta, or computed from the copy when the meta had
              // none. This is the "补封条" channel: an OLD copy whose meta recorded
              // no fingerprint gets one computed from its own `config/` and is then
              // recorded exactly like a fresh one, so an upgrade does not take away
              // the copies a user already had. What it never does is record a copy
              // whose content did NOT match: `decideBootCertification` refuses those.
              contentFingerprint: decision.snapshotFingerprint,
              contentScope: contentScopeOf(snapshotDir),
              intervention: intervention.intervention,
            })
            log.info('the snapshot of this restart is recorded as booted: the four startup checks passed and this boot runs exactly the snapshot content' + sourceNote, {
              dir: snapshotDir,
              promoted: promoted.promoted,
              certifiedBy: decision.certifiedBy,
              certificationEvidence: decision.certificationEvidence,
              fingerprintSource: side.source,
              contentFingerprint: shortFingerprint(decision.snapshotFingerprint),
              intervention: intervention.intervention,
              interventionReason: intervention.reason,
              // Said out loud so nobody re-reads this line as "the intervention was
              // checked": it is recorded, it is not part of the decision any more.
              interventionUsedAsEvidence: false,
            })
          }
        }
      }
    } else {
      log.error('the new instance did NOT come up cleanly:', {
        durationMs: record.durationMs,
        failed: evaluated.failed,
        checks,
      })
    }
  }
  return record
}

/** Promise-based pause used by boot recovery (batching + resolveAgent retries). */
function recoveryDelay(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (wait === 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, wait)
  })
}

/** Persist without letting a checkpoint failure escape into the boot path. */
function persistSafely(runtime) {
  try {
    runtime.persist()
  } catch {}
}

/**
 * BUILD the model-facing lifecycle tools — the definitions themselves, without
 * registering anything.
 *
 * It is a separate function for one reason: a tool's output schema is STRICT
 * (`additionalProperties: false`), and a single key the schema does not name
 * makes the whole return value invalid — the host then answers the model with
 * "tool returned invalid output" while the action itself already happened (see
 * `continuum_restart` below; that is exactly the bug this split lets a test
 * pin down). The test drives these definitions directly and compares every key
 * `execute()` returns with the declared `properties`, so "returned a field and
 * forgot to declare it" fails in CI instead of in front of the user.
 *
 * @param {object} runtime the runtime `createRuntime` returned.
 * @param {object} config the normalized plugin config.
 * @returns {object[]} the tool definitions, in registration order.
 */
export function buildLifecycleTools(runtime, config) {
  const log = runtime.log

  const definitions = []

  /** Collect one tool definition (registration happens in `registerTools`). */
  const tool = (definition) => {
    definitions.push(definition)
  }

  const textOutput = (schema, render) => ({ schema, render })

  /**
   * The blocking sessions with the reason each one blocks: a session that is
   * held by an armed goal reports `goal-active`, a goal whose round budget is
   * used up reports `goal-exhausted`, and the original busy reason is kept as
   * `busyReason`.
   */
  const blockingDetails = (blockedBy) => goalAwareBlockingDetails(runtime, blockedBy)

  /** The goals this plugin parked, with the outcome of the resume. */
  const parkedGoalDetails = () => parkedGoalList(runtime)

  tool({
    name: 'continuum_restart',
    description:
      'Ask DeepSeek Harness to restart gracefully: the restart waits until EVERY conversation is idle '
      + '(no running turn and no queued inbox work, other sessions, subagents and teammates included) and '
      + 'the host has been quiet for settleMs (default 2000 ms); a pending restart waits for that gate '
      + 'and has NO deadline (forceRestartWhenBusy interrupts a running conversation instead). '
      + 'forceRestartWhenBusy is enabled, otherwise the restart keeps waiting for the other conversations. '
      + 'Other conversations are never killed mid-turn: the detached helper re-checks this idle gate '
      + 'over loopback immediately before it kills the process. After the restart this '
      + 'plugin resumes this session and continues the work automatically. A goal-driven session is '
      + 'DISARMED before the restart (pass parkGoals:false to turn that off): disarming only removes the '
      + 'process-local continuation authority, so the round that is running right now still finishes normally '
      + '(no turn is cancelled and nothing is lost), no new round starts, and after the restart the goal is '
      + 're-armed and continues. A goal whose round budget is spent cannot be continued and is reported '
      + 'instead. Write your final message '
      + 'in this turn, then stop calling tools — the restart fires as soon as the turn goes idle. '
      + 'Use it only when a restart is genuinely required (for example to load an installed plugin update).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Why the restart is needed; recorded in the checkpoint and shown in the log.' },
        resume: { type: 'boolean', description: 'Resume this session after the restart (default true).' },
        defer_seconds: { type: 'number', description: 'Optional extra seconds to wait before the first idle check.' },
        parkGoals: { type: 'boolean', description: 'Disarm the goal of a goal-driven session before the restart (default true). Disarming keeps the durable goal active and lets the current round finish; after the restart the goal is re-armed and continues. With false no goal is disarmed, so a goal-driven session may keep the restart waiting.' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['accepted', 'generation', 'phase', 'willResume'],
        properties: {
          accepted: { type: 'boolean' },
          generation: { type: 'integer' },
          phase: { type: 'string' },
          willResume: { type: 'boolean' },
          // WHAT HAPPENED TO THE REQUEST (queued / deferred / cancelled), in
          // the words the record uses — the same value `continuum_status`
          // reports below.
          //
          // IT MUST BE DECLARED HERE, and this is the whole point of the
          // entry: a tool output schema is STRICT (`additionalProperties:
          // false`), so ONE key the schema does not name makes the ENTIRE
          // return value invalid. `execute()` below has returned
          // `restartRequest` since the request record was introduced, but the
          // schema never learned about it — so every successful call answered
          // "tool returned invalid output" while the restart itself went
          // through. That is the worst shape a bug can take: the error reads
          // as "the action did not happen", the caller retries or works
          // around it, and the action HAS happened. More keys will be added to
          // this answer over time; whoever adds one adds it here too.
          //
          // `null` is allowed even though `restartRequestInfo()` always
          // answers with an object today ("state: none" IS an answer, not a
          // missing value): it is the honest type of the field, and a stricter
          // one would only wait for the day a helper starts answering null.
          // This dialect has no `type: [...]` unions, hence the `oneOf`.
          restartRequest: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          note: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}, exec) {
      const state = runtime.state
      const now = Date.now()
      const agent = exec && exec.agent
      const sessionId = agent && agent.id ? String(agent.id) : undefined
      const resume = args.resume !== false
      const parkGoals = args.parkGoals !== false
      requestRestart(state, {
        reason: typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'agent requested restart',
        bySessionId: sessionId,
        resume,
        parkGoals,
        now,
      })
      // THE REQUESTER'S GOAL GOES NOW, not when the gate opens (2026-11-02).
      //
      // A goal-driven session starts its next round a few seconds after the
      // last one ended, so the settle window never fills and "wait until every
      // conversation is idle" waits for ever (real reading: 39 minutes,
      // `attempts: 0`). Taking the goal away HERE removes the authority that
      // starts round N+1; the round that is running still finishes normally.
      //
      // Nothing happens for a session without a goal (the helper answers
      // `no-goal`), and `parkGoals: false` still means "do not touch goals".
      const queuedDisarm = parkGoals === true && sessionId
        ? runtime.disarmQueuedRestartGoals([sessionId], { reason: 'restart-queued' })
        : { disarmed: [], reported: [] }
      if (queuedDisarm.disarmed.length > 0) {
        for (const item of queuedDisarm.disarmed) {
          log.info(`goal ${item.goalId} of session ${item.sessionId} is disarmed while the restart waits: no new round starts, the running one still finishes`)
        }
      }
      if (sessionId && resume) {
        const entry = sessionEntry(state, sessionId)
        markPendingResume(state, {
          sessionId,
          reason: 'agent-requested restart',
          goalId: entry && entry.goal ? entry.goal.goalId : undefined,
          now,
        })
      }
      if (typeof args.defer_seconds === 'number' && Number.isFinite(args.defer_seconds) && args.defer_seconds > 0) {
        state.restart.requestedAt = now + Math.min(args.defer_seconds, 3600) * 1000
      }
      // THE FIRST STAGE, RIGHT NOW — not when the backup starts. The interface
      // polls this out of the state route, so the click produces a visible
      // answer in well under a second.
      runtime.markRestartStage('waiting', { blocked: countBlockerTasks(runtime.gate().blockedBy) })
      runtime.persist()
      // The accepted request lands in the record at once (queued + the deadlines
      // of the gate), so the tool's answer and the file say the same thing.
      runtime.recordRestartRequestFate(RESTART_REQUEST_STATES.QUEUED, {
        reason: typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'agent requested restart',
        by: 'tool:restart',
        extra: { sessionId: sessionId || null },
      })
      runtime.startPolling()
      log.info('restart requested', { generation: state.generation, sessionId, resume, parkGoals })
      return {
        accepted: true,
        generation: state.generation,
        phase: state.phase,
        willResume: resume && Boolean(sessionId),
        // WHAT HAPPENS NEXT, in the words the record uses: a request is not a
        // restart yet — it is queued until the idle gate allows it.
        restartRequest: runtime.restartRequestInfo(),
        note: parkGoals
          ? 'The restart runs at the next safe point (all agents idle). Keep this reply short; the session resumes afterwards.'
          : 'The restart runs at the next safe point (all agents idle), but no goal is parked: a goal-driven session keeps its own agent busy and may therefore keep the restart waiting.',
      }
    },
  })

  tool({
    name: 'continuum_status',
    description:
      'Report the dsh-autorestart lifecycle: whether a restart is pending, which sessions were '
      + 'checkpointed as interrupted or continuation-pending, why each blocking session blocks '
      + '("goal-active" = an armed goal keeps it busy, "goal-exhausted" = its goal can no longer be '
      + 'resumed), the goals this plugin disarmed, how long the host has been quiet and how long '
      + 'the grace window is (the extra wait after the last conversation finished, for work other '
      + 'plugins queue with a timer), the last recovery action/detail per session, '
      + 'whether a session was handed off to a fresh session (target session id and time) or is over '
      + 'the model context window (such a session is never auto-resumed), whether the pre-restart '
      + 'backup also snapshots the installed plugins (backupIncludePlugins), the '
      + 'resolved state-file path, and the detected restart environment. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_sessions: { type: 'boolean', description: 'Include the per-session checkpoint entries (default true).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          stateFile: { type: 'string' },
          phase: { type: 'string' },
          generation: { type: 'integer' },
          pendingRestart: { type: 'boolean' },
          gateAllow: { type: 'boolean' },
          // THE GATE, WRITTEN DOWN (diagnostics only, 2026-11-02): the last
          // decision of the pending-restart gate and who was resetting the quiet
          // window at that moment. `restartGate` is null when the gate has not
          // decided anything yet on this machine — the field is declared here
          // because this schema is strict, and an undeclared key would refuse
          // the whole tool.
          restartGate: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          // The boot sweep of the rollback watcher scripts the old builds left
          // on a non-Windows machine: what was removed, what was kept, and why
          // the sweep was skipped (Windows, no directory yet).
          watcherHygiene: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        backupHygiene: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          quietResetBy: { type: 'string' },
          quietResetAt: { type: 'number' },
          quietResetSessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          quietResetIsSubagent: { type: 'boolean' },
          quietForMs: { type: 'number' },
          graceMs: { type: 'number' },
          effectiveSettleMs: { type: 'number' },
          queuedGraceMs: { type: 'number' },
          blockedBy: {
            type: 'array',
            items: {
              type: 'object',
              // Every blocker says WHAT it is (`session` or `subagent`) and
              // HOW it is called (`label`: the title of the session, or of the
              // session that created the subagent).
              //              // The title fields are NULLABLE: a session whose title could not
              // be resolved reports `null`, and a strict schema would reject
              // the whole tool output for it. The tool schema has no type
              // arrays, so "string or null" is declared as a `oneOf`.
              properties: {
                sessionId: { type: 'string' },
                reason: { type: 'string' },
                busyReason: { type: 'string' },
                kind: { type: 'string', enum: ['session', 'subagent', 'restart-pending'] },
                label: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                name: { type: 'string' },
                parentTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                parentSessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
          parkedGoals: { type: 'array', items: { type: 'object' } },
          recovery: { type: 'array', items: { type: 'object' } },
          handoffs: { type: 'array', items: { type: 'object' } },
          profileDir: { type: 'string' },
          profileDirSource: { type: 'string' },
          backupIncludePlugins: { type: 'boolean' },
          lastRollback: { type: 'object' },
          // THE REPORTED KIND OF PLUGIN FAILURE (user decision, 2026-11-01): what
          // the last boot found in the startup log, what was put back from the
          // known-good backup and to which point in time. DECLARED HERE TOO,
          // because this schema is strict: an undeclared key would be refused
          // and the whole tool would stop answering. It is OMITTED (never null)
          // when this machine never had such an incident.
          pluginRecovery: { type: 'object' },
          // The last restart: the snapshot that was taken before it and the
          // verdict of the instance that came up.
          lastRestart: { type: 'object' },
          // WHAT HAPPENED TO THE RESTART REQUEST: queued / deferred / cancelled,
          // with the reason, who ended it and when (RESTART_REQUEST_FILE). The
          // field is declared here because this schema is strict — an undeclared
          // key would refuse the whole tool.
          restartRequest: { type: 'object' },
        // THE QUEUED RESTART AS A STANDING STATE (2026-11-02): pending, waitedMs,
        // overThreshold, blockedBy, quietResetBy, summary. Declared here because
        // this route answers with a STRICT schema: an undeclared key is a test
        // failure, which is exactly how the missing field would be noticed.
        restartQueue: { type: 'object' },
          // The access link of the running instance (with the boot token).
          accessUrl: { type: 'string' },
          environment: { type: 'object' },
          sessions: { type: 'array', items: { type: 'object' } },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    execute(args = {}) {
      const state = runtime.state
      const includeSessions = args.include_sessions !== false
      const verdict = runtime.gate()
      return {
        ok: true,
        summary: describeState(state),
        stateFile: runtime.stateFile,
        phase: state.phase,
        generation: state.generation,
        pendingRestart: state.restart !== null,
        // WHAT HAPPENED TO THE REQUEST (queued / deferred / cancelled, with the
        // reason, who ended it and when). This is the answer to "I asked for a
        // restart and nothing happened, and nothing said why".
        restartRequest: runtime.restartRequestInfo(),
        // THE STANDING STATE OF THE QUEUE (user decision, 2026-11-02): pending,
        // for how long, what the gate decided, who holds it and what keeps
        // resetting the quiet window - re-derived on every read, so the page can
        // show it after a remount instead of a toast that vanishes. See
        // `restartQueueStatus` for the field contract.
        restartQueue: runtime.restartQueueStatus(),
        gateAllow: verdict.allow,
        quietForMs: Math.round(verdict.quietForMs),
        // DIAGNOSTICS (2026-11-02): what the gate decided the last time it ran
        // (action / reason / blockedBy / quietForMs / settleMs / queueMs /
        // attempts) and which event reset the quiet window. This is the answer
        // to "the restart never fires, and nothing says why".
        restartGate: runtime.restartGateInfo(),
        ...runtime.quietResetInfo(),
        // THE OLD ROLLBACK SCRIPT SWEEP (2026-11-02): what this boot removed
        // from the state directory, what it kept, and why it was skipped.
        watcherHygiene: runtime.watcherHygiene ?? null,
        backupHygiene: runtime.backupHygiene ?? null,
        // The RESTART reserve (the extra wait after the last conversation
        // finished) and the quiet window the gate really uses.
        graceMs: runtime.graceMs(),
        effectiveSettleMs: runtime.effectiveSettleMs(),
        // The upper bound of a queued (unclaimed) inbox message.
        queuedGraceMs: runtime.queuedGraceMs(),
        blockedBy: blockingDetails(verdict.blockedBy),
        parkedGoals: parkedGoalDetails(),
        recovery: recoveryList(state),
        handoffs: diagnosticSessions(state),
        // Where the pre-restart backup comes from (null dir = it would be skipped).
        profileDirSource: runtime.profileDir.source,
        ...(runtime.profileDir.dir ? { profileDir: runtime.profileDir.dir } : {}),
        // Whether the pre-restart backup also snapshots the installed plugins.
        backupIncludePlugins: config.backupIncludePlugins !== false,
        // Present only when the previous restart had to be rolled back.
        ...(runtime.lastRollback ? { lastRollback: runtime.lastRollback } : {}),
        // THE LAST RESTART: the snapshot that was taken before it (directory,
        // LOCAL time, duration, pruned) and the verdict of the instance that
        // came up (the four boot checks). Present only when a restart
        // happened — otherwise there is nothing to report.
        ...(runtime.lastRestartVerdict() ? { lastRestart: runtime.lastRestartVerdict() } : {}),
        // THE LAST PLUGIN-FAILURE RECOVERY (the REPORTED kind): which plugin did
        // not load, what was put back from the known-good backup and to which
        // point in time. Omitted (not null) when this machine never had one.
        ...(runtime.pluginRecoveryInfo() ? { pluginRecovery: runtime.pluginRecoveryInfo() } : {}),
        // The access link of THIS instance (with the boot token). The boot
        // token is created per process, so the link the browser holds answers
        // 401 after a restart — this is the link that still works.
        ...(accessUrlOf(runtime) ? { accessUrl: accessUrlOf(runtime) } : {}),
        environment: {
          platform: runtime.env.platform,
          isDesktopApp: runtime.env.isDesktopApp,
          appExePath: runtime.env.appExePath,
          pid: runtime.env.pid,
          ppid: runtime.env.ppid,
          restartMode: config.restartMode,
        },
        ...(includeSessions
          ? {
              sessions: [
                ...recoverableSessions(state, { limit: 50 }).map((entry) => ({
                  ...entry,
                  // Diagnostics: the last resolveAgent failure for this session (null when healthy).
                  lastResumeError: entry.lastResumeError ?? null,
                  handedOff: false,
                  overContextLimit: false,
                })),
                // A handed-off or over-limit session is out of the automatic resume
                // path, so it is listed here instead of vanishing from the report.
                ...diagnosticSessions(state, { limit: 50 }),
              ],
            }
          : {}),
      }
    },
  })

  tool({
    name: 'continuum_park_goal',
    description:
      'Disarm the durable goal of a session so a pending restart can proceed: a goal-driven '
      + 'session keeps its own agent busy forever (the goal round driver starts the next round '
      + 'immediately), so the restart would wait forever behind it. Disarming only removes the '
      + 'process-local continuation authority: the goal stays active, the round that is running '
      + 'right now still finishes normally (no turn is cancelled and nothing is lost), and no new '
      + 'round starts. After the next restart the goal is re-armed automatically and continues. '
      + 'Without a sessionId the goal of the calling session is disarmed. A goal whose round budget '
      + 'is spent can never be continued, so it is reported instead of disarmed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'The session whose goal should be disarmed (default: the calling session).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'disarmed'],
        properties: {
          ok: { type: 'boolean' },
          disarmed: { type: 'boolean' },
          sessionId: { type: 'string' },
          goalId: { type: 'string' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}, exec) {
      const agent = exec && exec.agent
      const callerId = agent && agent.id ? String(agent.id) : undefined
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      const sessionId = requested !== '' ? requested : callerId
      if (!sessionId) {
        return { ok: false, disarmed: false, reason: 'no-session' }
      }
      // A session id like `__proto__` would land on the prototype of the
      // session map: it is refused, and NOTHING is written.
      if (isForbiddenSessionId(sessionId)) {
        return { ok: false, disarmed: false, sessionId, reason: 'invalid-session-id' }
      }
      const result = runtime.disarmGoal(sessionId, sessionId === callerId ? agent : undefined)
      const payload = {
        ok: true,
        disarmed: result.disarmed === true,
        sessionId,
        reason: result.reason,
      }
      if (result.goalId !== undefined && result.goalId !== null) payload.goalId = String(result.goalId)
      if (result.error) payload.error = String(result.error)
      return payload
    },
  })

  tool({
    name: 'continuum_recover_now',
    description:
      'Retry the post-restart recovery RIGHT NOW instead of waiting for the next restart. Use it when '
      + 'a session is still stuck after a restart: its goal has not been re-armed yet, or its agent was '
      + 'not live when the boot recovery ran. Optional sessionId retries one session; without one every '
      + 'pending session is retried. Returns, per session, the action that was taken (for example '
      + '"resume-disarmed-goal", "resume-paused-goal", "rearm-goal", "prompt-continuation", '
      + '"agent-not-live", "goal-lookup-failed", "nothing") and a short detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Retry only this session (default: every pending session).' },
        force: {
          type: 'boolean',
          description: 'Re-open this explicit session before retrying: clears a stale over-limit / handoff mark and resets the attempt counter.',
        },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'results'],
        properties: {
          ok: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object' } },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    async execute(args = {}) {
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      // A session id like `__proto__` would land on the prototype of the
      // session map: it is refused, and NOTHING is written.
      if (isForbiddenSessionId(requested)) {
        return { ok: false, results: [{ sessionId: requested, action: 'refused', detail: 'invalid-session-id' }] }
      }
      const results = await runtime.recoverNow(requested !== '' ? requested : undefined, { force: args.force === true })
      return { ok: true, results }
    },
  })

  tool({
    name: 'continuum_handoff',
    description:
      'Hand a session whose conversation exceeded the model context window off to a FRESH session. '
      + 'Such a session is dead: every request to it fails with "context window exceeds limit", and '
      + 'compacting it needs the same oversized context. The handoff carries the goal objective, the '
      + 'recorded checkpoint reasons and a bounded tail of the conversation (default 20000 characters, '
      + '`maxChars`) into a new live session in the same working directory, marks the old session as '
      + 'handed off (so it is never auto-resumed again) and disarms its goal. The old session and its '
      + 'conversation are kept, untouched. Without `sessionId` the calling session is handed off. It '
      + 'reports the new session id, how many characters were carried, and what the human should do.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'The over-limit session to hand off (default: the calling session).' },
        maxChars: { type: 'number', description: 'Character budget of the carried conversation tail (default 20000).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          sourceSessionId: { type: 'string' },
          carriedChars: { type: 'number' },
          carriedTailChars: { type: 'number' },
          disarmedGoal: { type: 'boolean' },
          error: { type: 'string' },
          detail: { type: 'string' },
          instruction: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    async execute(args = {}, exec) {
      const agent = exec && exec.agent
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      return runtime.handoff({
        sessionId: requested !== '' ? requested : undefined,
        maxChars: typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
          ? args.maxChars
          : undefined,
        callerAgent: agent,
      })
    },
  })

  tool({
    name: 'continuum_cancel_restart',
    description:
      'Cancel a restart requested through continuum_restart. By default ONLY the calling session\'s own request is '
      + 'withdrawn (scope "mine"): the other sessions that asked for the same restart keep it. Use scope "all" to '
      + 'cancel the request for EVERYONE ("nobody restarts any more"). Does nothing when no restart is pending.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['mine', 'all'],
          description: 'Whose request to cancel: "mine" (the default) withdraws only the calling session\'s own request and leaves the requests of the other sessions alone; "all" cancels the request for every session.',
        },
        reason: { type: 'string', description: 'Optional note recorded in the log.' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'cancelled'],
        properties: {
          ok: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          scope: { type: 'string' },
          remainingRequesters: { type: 'integer' },
          sessionId: { type: 'string' },
          phase: { type: 'string' },
          error: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}, exec) {
      const state = runtime.state
      const now = Date.now()
      const scope = args.scope === 'all' ? 'all' : 'mine'
      const agent = exec && exec.agent
      const sessionId = agent && agent.id ? String(agent.id) : ''
      const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : ''

      // How many sessions are waiting for the pending restart.
      const requesterCount = () => {
        const restart = state.restart
        if (!restart) return 0
        const ids = new Set()
        if (Array.isArray(restart.requesters)) {
          for (const requester of restart.requesters) {
            if (requester && typeof requester.sessionId === 'string' && requester.sessionId) ids.add(requester.sessionId)
          }
        }
        if (typeof restart.bySessionId === 'string' && restart.bySessionId) ids.add(restart.bySessionId)
        return ids.size
      }

      if (scope === 'all') {
        // The explicit "nobody restarts any more": the whole request goes.
        const hadPending = state.restart !== null
        if (hadPending) {
          // Through the choke point, so the withdrawal is recorded (reason +
          // "who" = the tool + when) instead of only logged.
          runtime.dropRestartRequest({
            reason: 'continuum_cancel_restart scope "all": ' + (reason || '(no reason was given)'),
            by: 'tool:cancel-all',
            extra: { sessionId },
          })
        } else {
          runtime.stopPolling()
          runtime.persist()
        }
        if (hadPending) log.info('pending restart cancelled for EVERYONE:', reason || '(no reason)')
        return { ok: true, cancelled: hadPending, scope: 'all', remainingRequesters: 0, phase: state.phase }
      }

      // scope "mine": withdraw ONLY the calling session's request.
      if (state.restart === null) {
        // Nothing is pending: the tool does nothing, as before.
        return { ok: true, cancelled: false, scope: 'mine', remainingRequesters: 0, phase: state.phase }
      }
      if (sessionId === '') {
        // The calling session is unknown: refuse instead of guessing. A
        // silent "cancel everything" is exactly the accident this scope
        // exists to prevent.
        log.warn('the restart request of the calling session could not be withdrawn: the calling session is unknown; nothing was cancelled')
        return {
          ok: false,
          cancelled: false,
          scope: 'mine',
          remainingRequesters: requesterCount(),
          phase: state.phase,
          error: 'The calling session is unknown, so its own request cannot be identified. Nothing was cancelled. Call this tool from the session that requested the restart, or pass scope "all" to cancel the request for everyone.',
        }
      }
      // The request as it is BEFORE the withdrawal: `cancelOwnRestart` clears it,
      // and the record must still name who had asked and when.
      const pendingBefore = state.restart
      const outcome = cancelOwnRestart(state, { sessionId, now })
      if (!outcome.removed) {
        log.warn(`session ${sessionId} did not request the pending restart; nothing was cancelled`)
        return {
          ok: false,
          cancelled: false,
          scope: 'mine',
          remainingRequesters: outcome.remaining,
          sessionId,
          phase: state.phase,
          error: 'This session did not request the pending restart, so nothing was cancelled. Pass scope "all" to cancel the request for every session.',
        }
      }
      // Release ONLY this session's continuation request: the other sessions
      // stay pinned for the restart they asked for.
      runtime.releaseRequesters([sessionId])
      if (outcome.cancelled) {
        // The last requester left: the restart is really over. `cancelOwnRestart`
        // already dropped `state.restart`, so the record is written here (the
        // request is gone before the choke point could see it).
        runtime.recordRestartRequestFate(RESTART_REQUEST_STATES.CANCELLED, {
          reason: 'the last requester withdrew its restart request: ' + (reason || '(no reason was given)'),
          by: 'tool:cancel-mine',
          extra: { sessionId },
          restart: pendingBefore,
        })
        runtime.stopPolling()
        // The restart is over, so the reason for the disarm is over too: the
        // goals taken away while it waited come back NOW, not at the next boot
        // (a cancelled restart must never leave a session standing still).
        const rearmed = runtime.rearmQueuedRestartGoals({ reason: 'the last requester withdrew its restart request' })
        for (const item of rearmed.failed) {
          log.warn(`could not re-arm the goal of session ${item.sessionId} after the withdrawal: ${item.reason}`)
        }
        log.info(`session ${sessionId} withdrew the last restart request; the pending restart is cancelled`, reason || '')
      } else {
        log.info(`session ${sessionId} withdrew its restart request; ${outcome.remaining} requester(s) remain`)
      }
      runtime.persist()
      return {
        ok: true,
        cancelled: outcome.cancelled,
        scope: 'mine',
        remainingRequesters: outcome.remaining,
        sessionId,
        phase: state.phase,
      }
    },
  })

  tool({
    name: 'continuum_supervisor',
    description:
      'Inspect and manage the self-starting supervisor of this plugin (the process that brings the host back when it '
      + 'dies). action "status" reports who starts this host (the supervisor of this plugin / your own way / nobody) '
      + 'and whether the restart can work at all; action "plan" reports what an installation WOULD change without '
      + 'touching anything; action "install" and action "uninstall" need confirmed: true, because they really change '
      + 'the machine (a scheduled task or a systemd user unit that starts the supervisor at login).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'plan', 'dry-run', 'install', 'uninstall', 'apply', 'revert'],
          description: 'What to do: "status" (read-only), "plan" (what the installation would change), "dry-run" (the command this host would be restarted with, and why it may not be derivable), "install"/"uninstall" (the real thing, they need confirmed: true), "apply" (write the derived restart command after the user confirmed the dry run) and "revert" (put the previous command back).',
        },
        confirmed: {
          type: 'boolean',
          description: 'Required for "install" and "uninstall": the user confirmed the card that says what would change.',
        },
        choice: {
          type: 'string',
          enum: ['install', 'external', 'dismissed'],
          description: 'The answer of the one-time question about the supervisor (recorded so the question is never asked twice).',
        },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          kind: { type: 'string' },
          degraded: { type: 'boolean' },
          reason: { type: 'string' },
          error: { type: 'string' },
          supervisor: { type: 'object' },
          steps: { type: 'array', items: { type: 'object' } },
          previous: { type: 'object' },
          pending: { type: 'object' },
          // THE DRY RUN ANSWERS (2026-10-30 repair): the branch below returns
          // these seven values, and `additionalProperties: false` means every
          // one of them must be DECLARED here — an undeclared key is a schema
          // violation the registry refuses, not a cosmetic detail.
          // `command`, `writes` and `compose` are OMITTED when they are null
          // (a null value would violate `{type:'string'}` / `{type:'object'}`),
          // and the client already renders `dryRun.command || fallback`.
          level: { type: 'string' },
          mode: { type: 'string' },
          command: { type: 'string' },
          plan: { type: 'array', items: { type: 'object' } },
          needsConfirmation: { type: 'boolean' },
          writes: { type: 'object' },
          compose: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    async execute(args = {}) {
      const action = typeof args.action === 'string' ? args.action.trim() : 'status'
      const supervisor = runtime.supervisorStatus()
      if (action === 'status') {
        return { ok: true, action, supervisor }
      }
      if (action === 'dry-run' || action === 'derive') {
        // B: the dry run. It reports what WOULD be written; it writes nothing.
        //
        // ONLY DECLARED KEYS LEAVE THIS BRANCH. A nullable value is left OUT
        // instead of being sent as `null`: the output schema is strict
        // (`additionalProperties: false`, plain `{type: …}`), so `null` under
        // `{type:'string'}` would be refused exactly like an undeclared key.
        const plan = await runtime.deriveStartCommand()
        const answer = {
          ok: plan.ok === true,
          action,
          level: typeof plan.level === 'string' ? plan.level : '',
          mode: typeof plan.mode === 'string' ? plan.mode : '',
          reason: typeof plan.reason === 'string' ? plan.reason : '',
          plan: Array.isArray(plan.plan) ? plan.plan : [],
          needsConfirmation: plan.needsConfirmation !== false,
          supervisor,
        }
        if (typeof plan.command === 'string') answer.command = plan.command
        if (plan.writes && typeof plan.writes === 'object') answer.writes = plan.writes
        if (typeof plan.compose === 'string') answer.compose = plan.compose
        return answer
      }
      if (action === 'plan') {
        const plan = planSupervisorInstall({
          platform: runtime.env.platform,
          // The desktop app manages itself: the plan is refused there, and no
          // step is generated that could be run by accident.
          isDesktopApp: runtime.env.isDesktopApp === true,
          // The startup matrix: only a `bare` host may get a supervisor.
          startup: runtime.startupMode(),
          // WHICH MACHINE IS THIS? (WSL is not a Linux.)
          host: runtime.hostKind(),
          nodePath: process.execPath,
          execPath: process.execPath,
          supervisorPath: supervisorPaths(path.dirname(runtime.stateFile)).script,
          configPath: supervisorPaths(path.dirname(runtime.stateFile)).config,
          kind: config.supervisorKind,
        })
        return {
          ok: plan.error ? false : true,
          action,
          kind: plan.kind,
          reason: plan.reason,
          error: plan.error ?? undefined,
          steps: plan.steps,
          supervisor,
        }
      }
      if (action === 'install' && runtime.env.isDesktopApp === true) {
        // The desktop app manages itself: a login record would open a SECOND
        // client at every login. The refusal comes BEFORE the confirmation, so
        // the user is never asked to confirm something that cannot happen.
        return {
          ok: false,
          action,
          error: 'desktop-manages-itself',
          reason: 'the desktop app relaunches itself; a supervisor would start a second copy',
          steps: [],
          supervisor,
        }
      }
      if (args.confirmed !== true) {
        // The card is what says "yes": without it the machine is not touched.
        return {
          ok: false,
          action,
          error: 'confirmation-required',
          reason: 'the installation and the uninstallation change the machine, so the user has to confirm the card first',
          supervisor,
        }
      }
      if (action === 'install') {
        const choice = typeof args.choice === 'string' ? args.choice : ''
        if (choice !== '') runtime.recordSupervisorChoice(choice)
        const result = runtime.installSupervisor({ confirmed: true })
        return {
          ok: result.ok === true,
          action,
          kind: result.kind,
          degraded: result.degraded,
          reason: result.reason,
          error: result.error ?? undefined,
          steps: result.steps,
          supervisor: runtime.supervisorStatus(),
        }
      }
      const result = await runtime.uninstallSupervisor()
      return {
        ok: result.ok === true,
        action,
        reason: result.ok === true ? 'the supervisor was removed' : undefined,
        error: result.error ?? undefined,
        steps: result.steps,
        previous: result.previous ?? undefined,
        pending: result.pending ?? undefined,
        supervisor: runtime.supervisorStatus(),
      }
    },
  })

  return definitions
}

/** Register the model-facing lifecycle tools (see `buildLifecycleTools`). */
function registerTools(ctx, runtime, config) {
  /**
   * Register one tool.
   *
   * The disposer returned by `ctx.tools.register` is handed to `ctx.effect`, so
   * the HOST owns it: when the plugin row is disabled (or the plugin is
   * hot-reloaded) the fiber disposes the effect and the tool is unregistered
   * together with the HTTP routes. Registering it bare would leave the tools of
   * the OLD instance registered (and the new instance's registration would fail
   * as a duplicate), so the host could serve the tools of an instance whose
   * routes are already gone.
   *
   * A failed registration is recorded in `runtime.toolErrors` and logged; it is
   * never thrown, so one broken tool can never stop the plugin from loading.
   */
  for (const definition of buildLifecycleTools(runtime, config)) {
    const name = definition && definition.name ? String(definition.name) : null
    try {
      ctx.effect(
        () => ctx.tools.register(definition),
        `dsh-autorestart: tool ${name ?? 'unknown'}`,
      )
    } catch (error) {
      runtime.toolErrors.push({ tool: name, error: describeError(error) })
      runtime.log.warn(`could not register tool ${name}:`, String(error))
    }
  }
}

/**
 * Inject a tiny boot-token heartbeat into the served index. A `dsh web` page keeps its
 * WebSocket after the host process dies; when the backend comes back with a new
 * `bootId`, the page reloads itself instead of staying frozen on a dead connection.
 *
 * @param {string} html
 * @param {string} bootId
 * @param {string} routePath
 * @returns {string}
 */
function injectPageHeartbeat(html, bootId, routePath) {
  if (typeof html !== 'string') return html
  if (html.includes('data-dsh-autorestart-heartbeat')) return html
  const script = [
    '<script data-dsh-autorestart-heartbeat>',
    `window.__DSH_AUTORESTART_BOOT__=${JSON.stringify(bootId)};`,
    '(function(){try{var boot=window.__DSH_AUTORESTART_BOOT__;if(!boot)return;',
    'var t=setInterval(function(){fetch(',
    JSON.stringify(routePath),
    ",{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){",
    'if(!j||!j.bootId)return;if(j.bootId!==boot){clearInterval(t);location.reload();}}).catch(function(){});',
    '},4000);}catch(e){}})();',
    '</script>',
  ].join('')
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

/**
 * The system-prompt section that makes the restart policy discoverable to every agent:
 * call `continuum_restart` instead of killing the app by hand. This is a real Host hook,
 * so it applies without touching any AGENTS.md.
 */
const AUTORESTART_PROMPT = [
  '## Restart policy (dsh-autorestart)',
  '- When DeepSeek Harness itself must restart (for example to load an installed or updated plugin bundle), do NOT kill or relaunch the app yourself with pwsh/taskkill/Stop-Process/npm scripts. A hard guard blocks such commands anyway (denials mention `blockManualRestart`).',
  '- Call the `continuum_restart` tool instead (optional arguments: `reason`, `resume`, `defer_seconds`, `parkGoals`). It waits until every conversation is idle (no running turn — a running turn ALWAYS blocks; an inbox message nobody claimed blocks only until `queuedGraceMs`, default 60000 ms, after which it is treated as stuck and no longer blocks) AND the host has been quiet for `settleMs` (default 2000 ms); the detached helper re-checks that gate immediately before killing, so other conversations are never killed mid-turn. It then relaunches the app, and after boot this plugin resumes the session and continues the work automatically.',
  '- A goal-driven session is DISARMED automatically before the restart (its current round still finishes, nothing is lost), because such a session would otherwise keep the restart waiting forever: disarming only removes the process-local continuation authority, so no new round starts and the session goes idle. After the restart the goal is re-armed and continues. A goal whose round budget is spent cannot be continued and is reported instead. You can disarm your own goal on demand with `continuum_park_goal`, and retry a stuck recovery with `continuum_recover_now`.',
  '- Persist anything the next turn needs before restarting (workspace files, `todo_write`, goal state); do not rely on in-memory state.',
  '- Inspect the lifecycle with `continuum_status`; cancel a pending restart with `continuum_cancel_restart`. Its default scope is `mine`: it withdraws ONLY the calling session\'s own request and leaves the requests of the other sessions alone (a restart request is coalesced, so several sessions can wait for the same restart). Use `scope: "all"` to cancel the request for EVERYONE.',
  '- A session whose context exceeds the model window can be handed off to a fresh session with `continuum_handoff` (it carries the goal objective, the recorded reasons and a bounded tail of the conversation); this plugin refuses to auto-resume such a session, so hand it off instead of retrying it.',
  '- For multi-turn objectives prefer a durable goal (`create_goal`): after a restart the plugin re-arms it and the goal round driver keeps producing rounds. No goal is required for restart continuation — without one the plugin injects a single continuation message that continues the work in a fresh turn.',
].join('\n')

/** Register the restart-policy section in the global system prompt. */
function registerSystemPrompt(ctx, runtime) {
  let systemPrompt
  try {
    systemPrompt = ctx.get('systemPrompt')
  } catch {
    systemPrompt = undefined
  }
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    runtime.log.warn('systemPrompt.section is unavailable; the restart policy will not be advertised to agents')
    return false
  }
  let order = 1000
  try {
    if (typeof systemPrompt.getSectionOrder === 'function') {
      const base = systemPrompt.getSectionOrder('HARNESS_IDENTITY')
      if (Number.isFinite(base)) order = base + 1
    }
  } catch {}
  try {
    ctx.effect(
      () => systemPrompt.section({
        name: 'dsh-autorestart:restart-policy',
        order,
        interpolate: false,
        text: AUTORESTART_PROMPT,
      }),
      'dsh-autorestart: system prompt section',
    )
    runtime.systemPrompt = true
    return true
  } catch (error) {
    runtime.log.warn('could not register the system prompt section:', String(error))
    return false
  }
}

/**
 * Tools whose parsed arguments can carry a shell command or runnable code. Kept narrow
 * on purpose: a file write or a web request mentioning "taskkill" must never be blocked.
 */
const COMMAND_TOOL_PATTERN = /(pwsh|powershell|bash|shell|terminal|run_code|code|exec|subprocess|command|script|workflow)/i

/** Anything that can end the DSH process or start a replacement one. */
const KILL_VERB_PATTERN = /\b(taskkill|stop-process|pkill|kill|shutdown|restart-computer|stop-computer|terminate|kill-port)\b|process\.kill|\.kill\(|\bwmic\b[^\n]*\bdelete\b|\bschtasks\b/i

/** The desktop application this plugin restarts (also the wildcard/loose process-name forms). */
const APP_NAME_PATTERN = /deepseek[\s_-]?harness|deep[\W_]{0,4}harness/i

/** A generic DeepSeek process selector next to a kill verb. */
const DEEPSEEK_PATTERN = /\bdeepseek\b/i

/** Operating-system shutdown/reboot forms that always take DSH down with them. */
const OS_SHUTDOWN_PATTERN = /\bshutdown\b[^\n]*?(?:\/r|\/s|\/p|-r|-s|-h)\b|\b(?:restart-computer|stop-computer)\b/i

/** Returned to the model when the guard denies a manual restart. */
const MANUAL_RESTART_DENIAL = [
  'Blocked by dsh-autorestart: shutting down or relaunching DeepSeek Harness by hand is disabled by the',
  'plugin\'s restart policy. Use the `continuum_restart` tool instead: it waits until every agent is',
  'idle, relaunches the app through a detached helper, and resumes this session afterwards.',
  'If a manual restart is genuinely required, set `blockManualRestart: false` in the dsh-autorestart',
  'row config (or ask the user to do it).',
].join(' ')

/** Recursively collect string leaves from parsed tool arguments. */
function collectArgumentStrings(value, out = [], depth = 0) {
  if (value === null || value === undefined) return out
  if (typeof value === 'string') {
    if (value.length > 0 && value.length <= 200_000) out.push(value)
    return out
  }
  if (depth >= 4) return out
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentStrings(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectArgumentStrings(item, out, depth + 1)
  }
  return out
}

/**
 * Decide whether one pending tool call would manually stop or relaunch DSH.
 *
 * @param {{ name?: string, arguments?: unknown } | null | undefined} exec
 * @param {{ pid?: number, ppid?: number }} [options]
 * @returns {string | null} a short hit description, or null when the call is fine
 */
export function detectManualRestart(exec, { pid = process.pid, ppid = process.ppid, webPort = 0 } = {}) {
  if (!exec || typeof exec.name !== 'string') return null
  if (!COMMAND_TOOL_PATTERN.test(exec.name)) return null
  const pidRe = pid > 0 ? new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`) : null
  const ppidRe = ppid > 0 ? new RegExp(`(^|[^0-9])${ppid}([^0-9]|$)`) : null
  const portRe = webPort > 0 ? new RegExp(`(^|[^0-9])${webPort}([^0-9]|$)`) : null
  for (const text of collectArgumentStrings(exec.arguments)) {
    if (OS_SHUTDOWN_PATTERN.test(text)) return 'operating-system shutdown/reboot would take DSH down'
    if (!KILL_VERB_PATTERN.test(text)) continue
    if (portRe !== null && /\bkill-?port\b/i.test(text) && portRe.test(text)) {
      return 'port-kill of the DSH web server'
    }
    if (APP_NAME_PATTERN.test(text)) return 'process kill/relaunch command naming DeepSeek Harness'
    if (DEEPSEEK_PATTERN.test(text)) return 'process kill command selecting a DeepSeek process'
    if (/\bschtasks\b/i.test(text) && /\/(run|create)\b/i.test(text) && /\b(dsh|deepseek|autorestart)\b/i.test(text)) {
      return 'scheduled-task restart of DSH'
    }
    if (pidRe !== null && pidRe.test(text)) return 'process kill command naming the current DSH host pid'
    if (ppidRe !== null && ppidRe.test(text)) return 'process kill command naming the parent app pid'
  }
  return null
}

/**
 * Register a global tool guard: a model that tries to restart DSH with a shell command is
 * stopped before dispatch and told to use `continuum_restart`. This is the hard complement
 * to the advisory system-prompt section.
 */
function registerManualRestartGuard(ctx, runtime, config) {
  runtime.manualRestartBlocks = 0
  if (config.blockManualRestart === false) {
    runtime.log.info('manual-restart guard is disabled by config')
    return
  }
  const tools = ctx.tools
  if (!tools || typeof tools.guard !== 'function') {
    runtime.log.warn('tools.guard is unavailable; manual DSH restarts are only discouraged by prompt, not blocked')
    return
  }
  try {
    // The disposer is owned by the fiber (like the tools and the routes), so a
    // re-applied plugin never leaves a guard of an old instance behind.
    ctx.effect(
      () => tools.guard((exec) => {
        const hit = detectManualRestart(exec, { webPort: runtime.webPort ?? 0 })
        if (hit === null) return undefined
        runtime.manualRestartBlocks += 1
        runtime.log.warn(`blocked a manual DSH restart attempt (${hit}) through tool "${exec.name}"; steering the agent to continuum_restart`)
        return MANUAL_RESTART_DENIAL
      }),
      'dsh-autorestart: manual-restart guard',
    )
  } catch (error) {
    runtime.log.warn('could not register the manual-restart guard:', String(error))
  }
}

/**
 * Is this request admitted by the host's connection service, i.e. is it an
 * authenticated browser request? A hosted `dsh web` deployment reaches the
 * health route from a remote browser, so a loopback-only check would refuse
 * the pending-restart marker the UI polls for. When the connection service is
 * missing the previous loopback-only behaviour is kept, and the check never
 * throws.
 *
 * @param {unknown} ctx - the plugin context.
 * @param {unknown} req - the incoming request.
 * @returns {boolean} true when the request may proceed.
 */
function admittedByConnection(ctx, req) {
  try {
    let connection
    try {
      if (ctx && ctx.connection && typeof ctx.connection.requestRejection === 'function') {
        connection = ctx.connection
      }
    } catch {}
    if (!connection) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const service = ctx.get('connection')
          if (service && typeof service.requestRejection === 'function') connection = service
        }
      } catch {}
    }
    if (!connection) return false
    // `requestRejection` inspects the request headers and answers a refusal
    // status (401/403), or nothing at all when the request may proceed.
    const rejection = connection.requestRejection(req)
    return rejection === undefined || rejection === null
  } catch {
    return false
  }
}

/**
 * Read a small JSON request body. Never throws: an unreadable or malformed
 * body simply becomes an empty object.
 *
 * @param {any} req
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') {
      resolve({})
      return
    }
    let size = 0
    let settled = false
    const chunks = []
    const finish = (text) => {
      if (settled) return
      settled = true
      try {
        const raw = String(text || '').trim()
        if (raw === '') {
          resolve({})
          return
        }
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    }
    req.on('data', (chunk) => {
      size += typeof chunk === 'string' ? chunk.length : (chunk && chunk.length ? chunk.length : 0)
      if (size > maxBytes) {
        finish('')
        return
      }
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    })
    req.on('end', () => finish(chunks.join('')))
    req.on('error', () => finish(''))
  })
}

/**
 * The content type of a request, lowercased and without its parameters.
 *
 * @param {object} req
 * @returns {string}
 */
function requestContentType(req) {
  const headers = req && typeof req.headers === 'object' && req.headers !== null ? req.headers : {};
  const raw = headers['content-type'] ?? headers['Content-Type'] ?? '';
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  return value.split(';')[0].trim().toLowerCase();
}

/**
 * The guard of every route that CHANGES state.
 *
 * A cross-site "simple request" (a form POST, or a fetch that sends
 * `text/plain`) is sent by the browser WITHOUT a preflight, so a page on
 * another site could reach a route that parks a goal, hands a session off or
 * recovers one. A request that declares `application/json` is NOT a simple
 * request: the browser asks the server first, and a server that answers
 * anything but a CORS allow-list refuses it. So the content type is the
 * switch that keeps another site from changing this host's state.
 *
 * The route answers 415 and changes NOTHING when the content type is not
 * `application/json`.
 *
 * @param {object} req
 * @param {object} res
 * @returns {boolean} true when the request may go on
 */
function requireJsonContentType(req, res) {
  if (requestContentType(req) === 'application/json') return true;
  res.statusCode = 415
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({
    ok: false,
    error: 'unsupported-media-type',
    detail: 'This route changes state, so it only accepts application/json.',
  }))
  return false;
}

/**
 * Refuse a session id that must never become a key of the session map.
 *
 * `__proto__` (and `constructor` / `prototype`) are inherited properties of
 * every object: a session id like that would make the map hand out
 * `Object.prototype` instead of a session, and the fields written on it would
 * land in the prototype of the whole process. The route answers 400 and
 * changes NOTHING.
 *
 * @param {object} res
 * @param {string} sessionId
 * @returns {boolean} true when the request may go on
 */
function refuseForbiddenSessionId(res, sessionId) {
  res.statusCode = 400
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({
    ok: false,
    error: 'invalid-session-id',
    detail: `"${sessionId}" is not a usable session id.`,
  }))
  return false;
}

/**
 * The ids of the sessions that currently block a pending restart.
 *
 * @param {object} runtime
 * @returns {string[]}
 */
function blockingSessionIds(runtime) {
  const ids = []
  try {
    const verdict = runtime.gate()
    const blockedBy = Array.isArray(verdict.blockedBy) ? verdict.blockedBy : []
    for (const entry of blockedBy) {
      if (!entry || typeof entry !== 'object') continue
      const id = entry.sessionId == null ? '' : String(entry.sessionId)
      if (id && !ids.includes(id)) ids.push(id)
    }
  } catch {}
  return ids
}

/**
 * Build the POST route that disarms the goal of a session.
 *
 * It uses the same authentication rule as the health route (loopback OR a
 * request the connection service admits) and answers JSON only.
 */
function buildParkRoute(ctx, runtime, config) {
  const routePath = resolveParkPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        // A session id like `__proto__` would land on the prototype of the
        // session map: it is refused here, before anything is written.
        if (isForbiddenSessionId(sessionId)) {
          refuseForbiddenSessionId(res, sessionId)
          return
        }
        const restart = body.restart === true
        // Without a session id every session that blocks a pending restart is
        // parked, so the restart can proceed.
        const targets = sessionId !== '' ? [sessionId] : blockingSessionIds(runtime)
        const disarmed = []
        const reported = []
        for (const target of targets) {
          try {
            const result = runtime.disarmGoal(target)
            if (result.disarmed) disarmed.push(result)
            else reported.push(result)
          } catch (error) {
            reported.push({ sessionId: target, disarmed: false, reason: 'disarm-failed', error: describeError(error) })
          }
        }
        if (restart && sessionId !== '') {
          // The session becomes a requester of the pending restart: the restart
          // proceeds and the session continues afterwards.
          requestRestart(runtime.state, {
            reason: 'disarm route requested a restart',
            bySessionId: sessionId,
            resume: true,
            now: Date.now(),
          })
          // The same rule as the tool: the goal of the session that asked is
          // taken away while the restart waits, so the round driver cannot keep
          // the quiet window from filling.
          const queuedDisarm = runtime.disarmQueuedRestartGoals([sessionId], { reason: 'restart-queued' })
          for (const item of queuedDisarm.disarmed) disarmed.push(item)
          for (const item of queuedDisarm.reported) reported.push(item)
          // The first stage, in the same breath as the request: the answer to
          // this POST is already "waiting for the sessions", never silence.
          runtime.markRestartStage('waiting', { blocked: blockingSessionIds(runtime).length })
          runtime.persist()
          // THE REQUEST IS IN THE RECORD AS SOON AS IT EXISTS: `restartRequested:
          // true` used to mean only "it was written down somewhere". The record
          // (and the answer below) says what will happen to it.
          runtime.recordRestartRequestFate('queued', {
            reason: 'the park route requested a restart for ' + sessionId,
            by: 'route:park',
            extra: { sessionId },
          })
          runtime.startPolling()
        }
        // WHAT THE ANSWER MEANS, spelled out: a request is queued, not done. And
        // if the LAST request was withdrawn, that is reported here as well — a
        // caller must never have to guess why the earlier restart never came.
        const restartRequest = runtime.restartRequestInfo()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: true,
          disarmed,
          reported,
          pendingRestart: runtime.state.restart !== null,
          restartRequested: restart === true && sessionId !== '',
          restartRequest,
          lastRestartRequest: runtime.restartRequestOutcome(),
        }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/cancel` route: withdraw ONE session's own restart request.
 *
 * It is the sibling of the `/park` route next to the health route and uses the
 * same authentication rule (loopback OR a request the connection service
 * admits). Body: `{ "sessionId": string, "scope"?: "mine" }`.
 *
 * The route NEVER cancels the request of everybody: `scope: "all"` is
 * refused, that operation belongs to the tool (where the caller says it out
 * loud). The answer reports what happened: `{ ok, cancelled, reason,
 * remainingRequesters, sessionId }`.
 *
 * @param {object} ctx
 * @param {object} runtime
 * @param {object} config
 */
function buildCancelRoute(ctx, runtime, config) {
  const routePath = resolveCancelPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        // A session id like `__proto__` would land on the prototype of the
        // session map: it is refused here, before anything is written.
        if (isForbiddenSessionId(sessionId)) {
          refuseForbiddenSessionId(res, sessionId)
          return
        }
        const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'mine'
        const answer = (statusCode, value) => {
          res.statusCode = statusCode
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(value))
        }
        if (scope !== 'mine') {
          // "Cancel everybody" is a tool operation: the route says no.
          answer(400, {
            ok: false,
            cancelled: false,
            reason: 'scope-not-allowed',
            error: 'This route can only withdraw one session\'s own request (scope "mine").',
            remainingRequesters: 0,
            sessionId,
          })
          return
        }
        if (sessionId === '') {
          answer(400, {
            ok: false,
            cancelled: false,
            reason: 'session-id-required',
            error: 'The session id is required: without it the own request cannot be identified.',
            remainingRequesters: 0,
            sessionId: '',
          })
          return
        }
        // THE STAGE DECIDES WHETHER A CANCEL IS HONEST.
        //
        // While the snapshot is being written the copy is stopped between two
        // files and its half-written directory is removed — the host never
        // restarts. Once the host is on its way out (`restarting`) a cancel
        // would be a promise this plugin cannot keep, so it is REFUSED with the
        // reason, and the button is greyed out on the same answer.
        const stage = runtime.restartStageInfo()
        if (stage.cancellable !== true) {
          const reason = cancelRefusalReason(stage.phase) || 'the host is already restarting'
          runtime.log.warn(`the cancel route refused the request of session ${sessionId}: ${reason}`)
          answer(409, {
            ok: false,
            cancelled: false,
            reason: 'not-cancellable',
            stage: stage.phase,
            error: reason,
            remainingRequesters: 0,
            sessionId,
          })
          return
        }
        // The request as it is BEFORE the withdrawal (see the tool): the record
        // must still name who had asked and when it was requested.
        const pendingBefore = runtime.state.restart
        const outcome = cancelOwnRestart(runtime.state, { sessionId, now: Date.now() })
        if (!outcome.removed) {
          // Nothing was changed: the caller is not a requester (or the
          // request is already gone). The reason says which.
          const error = outcome.reason === 'not-a-requester'
            ? 'This session did not request the pending restart, so nothing was cancelled.'
            : outcome.reason === 'no-restart-pending'
              ? 'There is no pending restart to cancel.'
              : 'The own request could not be identified, so nothing was cancelled.'
          runtime.log.warn(`the cancel route refused the request of session ${sessionId}: ${outcome.reason}`)
          answer(200, {
            ok: false,
            cancelled: false,
            reason: outcome.reason,
            error,
            remainingRequesters: outcome.remaining,
            sessionId,
          })
          return
        }
        // Release ONLY this session's continuation request.
        runtime.releaseRequesters([sessionId])
        if (outcome.cancelled) {
          // The whole restart is off. If the snapshot is being written right
          // now, the copy stops at the next file and removes its half-written
          // directory (the host never restarts); otherwise the stage just goes.
          if (stage.phase === 'snapshotting') runtime.requestSnapshotCancel()
          runtime.clearRestartStage()
          // `cancelOwnRestart` already dropped `state.restart`, so the record is
          // written here: the route withdrew the LAST request (reason + who +
          // when), which used to be an info line in the log and nothing more.
          runtime.recordRestartRequestFate('cancelled', {
            reason: 'the last requester withdrew its restart request through the cancel route',
            by: 'route:cancel',
            extra: { sessionId },
            restart: pendingBefore,
          })
          runtime.stopPolling()
        }
        runtime.persist()
        runtime.log.info(
          outcome.cancelled
            ? `session ${sessionId} withdrew the last restart request through the cancel route; the pending restart is cancelled`
            : `session ${sessionId} withdrew its restart request through the cancel route; ${outcome.remaining} requester(s) remain`,
        )
        answer(200, {
          ok: true,
          cancelled: outcome.cancelled,
          reason: outcome.reason,
          remainingRequesters: outcome.remaining,
          sessionId,
        })
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/recover` route: retry the post-restart recovery for the
 * still-pending sessions right now.
 *
 * It is the sibling of the `/park` route next to the health route and uses the
 * same authentication rule (loopback OR a request the connection service
 * admits). Body: `{ "sessionId"?: string }`; without one every pending session
 * is retried. The answer reports, per session, the recovery action and detail.
 */
function buildRecoverRoute(ctx, runtime, config) {
  const routePath = resolveRecoverPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        // A session id like `__proto__` would land on the prototype of the
        // session map: it is refused here, before anything is written.
        if (isForbiddenSessionId(sessionId)) {
          refuseForbiddenSessionId(res, sessionId)
          return
        }
        const results = await runtime.recoverNow(sessionId !== '' ? sessionId : undefined, { force: body.force === true })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, results }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/handoff` route: hand an over-limit session off to a fresh
 * session (the same operation as the `continuum_handoff` tool).
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "sessionId"?: string, "maxChars"?: number }`; without a session id the
 * request is refused, because a route call has no calling session to default to.
 * The answer reports the new session id and the number of carried characters.
 */
function buildHandoffRoute(ctx, runtime, config) {
  const routePath = resolveHandoffPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        // A session id like `__proto__` would land on the prototype of the
        // session map: it is refused here, before anything is written.
        if (isForbiddenSessionId(sessionId)) {
          refuseForbiddenSessionId(res, sessionId)
          return
        }
        if (sessionId === '') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({
            ok: false,
            error: 'no-session',
            instruction: 'Pass { "sessionId": "<id>" }: this route has no calling session to default to.',
          }))
          return
        }
        const result = await runtime.handoff({
          sessionId,
          maxChars: typeof body.maxChars === 'number' && Number.isFinite(body.maxChars) && body.maxChars > 0
            ? body.maxChars
            : undefined,
        })
        res.statusCode = result && result.ok === true ? 200 : 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: result && result.ok === true,
          sessionId: result ? result.sessionId : undefined,
          sourceSessionId: result ? result.sourceSessionId : sessionId,
          carriedChars: result ? result.carriedChars : undefined,
          error: result ? result.error : 'handoff-failed',
          instruction: result ? result.instruction : undefined,
        }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/rollback-to` route: restore ONE backup the user picked.
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "name": "<backup directory name>" }`. The name has to be one this host
 * reports from the backup list — the route never takes a path, so `../` and
 * absolute paths are refused before anything is read. The answer carries the
 * receipt (what was restored, and the snapshot taken right before it):
 *
 *   - 400 when no name / not a plain backup name was given,
 *   - 404 when there is no such backup,
 *   - 409 when the current state could not be saved first, or when another
 *     rollback (the detached watchdog) holds the lock,
 *   - 500 when the restore itself failed,
 *   - 200 with `{ ok: true, receipt }` when the copy is back AND a normal
 *     restart has been requested.
 */
function buildManualRollbackRoute(ctx, runtime, config) {
  const routePath = resolveManualRollbackPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const result = await runtime.manualRollback({ name: body.name })
        const status = result && Number.isFinite(result.status) ? result.status : 400
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: result ? result.ok === true : false,
          error: result && result.error ? result.error : null,
          receipt: result && result.receipt ? result.receipt : null,
          restartRequested: Boolean(result && result.receipt && result.receipt.restartRequested),
        }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the single-plugin restore route — the button in the popup.
 *
 * `POST /plugin-restore` with `{ "plugin": "<name>" }` puts THAT ONE plugin back
 * from the last known-good backup and nothing else:
 *
 *   - a real copy in the backup overwrites the live directory (`overwrite`);
 *   - a `link:` installation is replaced by the backup's copied contents
 *     (`replace-link`);
 *   - in both cases the live tree is RENAMED to `<name>.broken-<ts>` first, so
 *     the broken version stays on disk as evidence — nothing is ever deleted;
 *   - a plugin that already equals the backup answers `already-consistent`,
 *     writes nothing and asks for no restart (idempotent: pressing twice is
 *     harmless);
 *   - no backup, an unknown name, or a failed copy answers `ok:false` with a
 *     `reason` AND HTTP 200 — "there is no backup for this plugin" is an
 *     answer, not a server error.
 *
 * It is the ONLY path that still writes into the profile, and it only runs
 * because a human pressed the button (the boot pass looks and reports, it does
 * not act — see the boot section further down).
 *
 * The answer is `{ ok, plugin, mode, restoredFrom, restoredAt, backupKind,
 * needsRestart }` plus the evidence and the timestamp; every attempt is also
 * appended to `<stateDir>/plugin-restore-history.json` (newest 20).
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits).
 */
function buildPluginRestoreRoute(ctx, runtime, config) {
  const routePath = resolvePluginRestorePath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : ''
        if (plugin === '') {
          answer({ ...pluginRestorePayload({ ok: false, plugin: '', reason: 'the body must name one plugin: { "plugin": "<name>" }' }) })
          return
        }
        const result = runtime.pluginRestore(plugin)
        // A restore that changed nothing is reported, not hidden: the popup
        // shows the reason next to the plugin.
        runtime.pluginRestores = (runtime.pluginRestores ?? 0) + 1
        if (result && result.ok === true && result.changed === true) {
          runtime.log.info('one plugin was put back from the backup as asked', {
            plugin,
            mode: result.mode,
            restoredAt: result.restoredAt,
            needsRestart: result.needsRestart === true,
          })
        } else if (result && result.ok !== true) {
          runtime.log.warn('a plugin could not be put back from the backup:', {
            plugin,
            reason: result.reason,
          })
        }
        answer(pluginRestorePayload(result))
      }).catch((error) => {
        answer(pluginRestorePayload({ ok: false, plugin: '', reason: describeError(error) }))
      })
    },
  }
}

/**
 * Build the announcements route: the one-time announcement of a new feature.
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits).
 *
 *   - `GET` answers `{ ok: true, pending: [{ feature, version }] }`: the
 *     announcements the user has not seen yet (an empty list when there is
 *     nothing new — a fresh installation is asked at the install prompt, so
 *     it never gets an announcement);
 *   - `POST` with `{ "feature": "sleep" }` records that the user has seen
 *     that announcement and answers `{ ok: true, seen: [...] }`.
 *
 * The record lives in the checkpoint file, so an announcement that was shown
 * once never comes back — not with the next boot and not with the next
 * release of the plugin. Only a new FEATURE version (see
 * `SLEEP_FEATURE_VERSION`) brings it back, on purpose.
 */
/**
 * THE INVENTORY ROUTE — the settings page's data source (user decision, 2026-11-01).
 *
 * GET, read-only, loopback-only like every other route of this plugin. Without a
 * query it answers the whole list; with `?plugin=<name>` it answers that one
 * plugin's file-level differences.
 *
 * WHAT A DIFFERENCE MEANS: it finds a changed, deleted or never-backed-up file.
 * It does NOT find a plugin whose files are all correct but which fails while
 * loading. The payload therefore never says "broken" — it says `status`, and the
 * settings page is expected to present it as a first-pass signal.
 *
 * CACHED FOR 60 s, keyed by the plugin name, because walking 120 plugin trees is
 * a stat per file and the page may be opened several times in a row.
 */
/**
 * THE PLUGIN LIST AS THE PAGE MUST SEE IT (user report, 2026-11-02).
 *
 * Two corrections on top of `inventory()`:
 *
 * 1. WHERE THE COPY IS. `inventory()` picks `node_modules-link/<name>` or
 *    `node_modules/<name>` from the LIVE install shape. When that shape changed
 *    after the copy was taken, a perfectly good copy was reported as missing:
 *    `dsh-codekg`'s files sat in `node_modules-link/dsh-codekg` while the page
 *    said "the backup has no copy of this plugin". The copy is asked FIRST now
 *    (`backupPluginDirIn`: its own manifest → directory scan → live flag), and
 *    the comparison is repeated only when the first answer was "missing".
 * 2. HOW IT WAS INSTALLED. The page lists hand-written plugins one by one and
 *    merges everything else into two sentences — and those sentences must be
 *    TRUE. A name in the profile's `dependencies` came from npm (its files are
 *    not copied; it is reinstalled), while a bundle that is neither linked nor a
 *    dependency is shipped with DSH itself (nothing to back up).
 *
 * Never throws: an unreadable profile package.json only loses the distinction
 * (everything becomes `builtin`, and the page then says "不需要备份", which is the
 * safe side — it must not claim we have files we do not have).
 */
export function describePluginsForPage(list, { profileDir = '', backupDir = '' } = {}) {
  const dependencies = (() => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
      const deps = manifest && manifest.dependencies && typeof manifest.dependencies === 'object'
        ? manifest.dependencies
        : {}
      return new Set(Object.keys(deps))
    } catch {
      return new Set()
    }
  })()
  const plugins = Array.isArray(list) ? list : []
  return plugins.map((plugin) => {
    const name = plugin && typeof plugin.name === 'string' ? plugin.name : ''
    const linked = plugin.linked === true
    const install = linked ? 'link' : (dependencies.has(name) ? 'npm' : 'builtin')
    const described = { ...plugin, install }
    if (name === '' || backupDir === '') return described
    if (plugin.status !== PLUGIN_STATUS.MISSING) return described
    // A SECOND LOOK — only where the first answer was the damaging one.
    const copyDir = backupPluginDirIn(backupDir, name, { linked })
    if (typeof copyDir !== 'string' || copyDir === '') return described
    const retried = comparePlugin({
      liveDir: path.join(profileDir, PLUGINS_DIR, name),
      backupDir: copyDir,
    })
    if (retried.status === PLUGIN_STATUS.MISSING) return described
    return {
      ...described,
      status: retried.status,
      changeCount: retried.changeCount,
      truncated: retried.truncated === true,
    }
  })
}

function buildPluginInventoryRoute(ctx, runtime, config) {
  const routePath = resolvePluginInventoryPath(config)
  const ttlMs = 60000
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      if (req && req.method && req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'GET')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      try {
        const url = req && typeof req.url === 'string' ? req.url : ''
        const queryIndex = url.indexOf('?')
        const query = queryIndex < 0 ? '' : url.slice(queryIndex + 1)
        let plugin = ''
        for (const part of query.split('&')) {
          const equals = part.indexOf('=')
          if (equals < 0) continue
          if (decodeURIComponent(part.slice(0, equals)) !== 'plugin') continue
          try {
            plugin = decodeURIComponent(part.slice(equals + 1)).trim()
          } catch {
            plugin = part.slice(equals + 1).trim()
          }
        }
        const cacheKey = plugin === '' ? 'inventory' : 'detail:' + plugin
        const now = Date.now()
        const cache = runtime.pluginInventoryCache && typeof runtime.pluginInventoryCache === 'object'
          ? runtime.pluginInventoryCache
          : {}
        const hit = cache[cacheKey]
        if (hit && typeof hit.at === 'number' && now - hit.at < ttlMs && hit.value !== undefined) {
          answer(hit.value)
          return
        }
        const profileDir = runtime.profileDir && typeof runtime.profileDir.dir === 'string' ? runtime.profileDir.dir : ''
        const backupsDir = profileDir === '' ? '' : backupsDirFor(runtime.stateDir)
        const value = plugin === ''
          ? (() => {
            const inventory = pluginInventory({ profileDir, backupsDir, now })
            return {
              ok: true,
              kind: 'inventory',
              ...inventory,
              plugins: describePluginsForPage(inventory.plugins, {
                profileDir,
                backupDir: typeof inventory.backupDir === 'string' ? inventory.backupDir : '',
              }),
            }
          })()
          : { ok: true, kind: 'detail', ...pluginInventoryDetail({ profileDir, backupsDir, plugin }) }
        runtime.pluginInventoryCache = { ...cache, [cacheKey]: { at: now, value } }
        answer(value)
      } catch (error) {
        // A read-only route that cannot read is an ANSWER, not a 500: the page
        // must be able to say "unknown" instead of showing nothing.
        answer({
          ok: false,
          kind: 'inventory',
          backupAt: null,
          plugins: [],
          reason: String(error && error.message ? error.message : error),
        })
      }
    },
  }
}

function buildAnnouncementsRoute(ctx, runtime, config) {
  const routePath = resolveAnnouncementsPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      if (method === 'GET') {
        answer({ ok: true, pending: runtime.pendingAnnouncements() })
        return
      }
      if (method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'GET, POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const feature = typeof body.feature === 'string' ? body.feature.trim() : ''
        if (feature === '') {
          answer({
            ok: false,
            error: 'feature-required',
            instruction: 'Send { "feature": "sleep" }.',
          }, 400)
          return
        }
        const known = featureAnnouncements().some((entry) => entry.feature === feature)
        if (!known) {
          answer({
            ok: false,
            error: 'unknown-feature',
            instruction: `Send { "feature": ${featureAnnouncements().map((entry) => `"${entry.feature}"`).join(' | ')} }.`,
          }, 400)
          return
        }
        answer({ ok: true, seen: runtime.markFeatureSeen(feature) })
      }).catch((error) => {
        answer({ ok: false, error: describeError(error) }, 400)
      })
    },
  }
}

/**
 * Build the POST `/choice` route: persist the one-time install choice of the
 * user (whether the pre-restart backup also snapshots the installed plugins),
 * the answer to the one-time question whether the graceful-sleep button is
 * shown, and the settings of the configuration page (how long the countdown
 * runs, whether the pre-restart backup is taken at all and whether that
 * backup includes the installed plugins).
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "includePlugins"?: boolean, "backupIncludePlugins"?: boolean,
 *   "backupOnRestart"?: boolean, "showSleepButton"?: boolean,
 *   "sleepCountdownSeconds"?: 0 | 10 | 20 | 30 | 60 }` — at least one
 * of the keys must be present, and a key that IS present must carry a valid
 * value. Anything else is refused with a 400 and NOTHING is written.
 *
 * The answer is `{ ok: true, applied: 'config' | 'fallback-file', ... }`:
 * `applied` says where the choice landed — the profile configuration (the
 * official path) or the degraded fallback file. Only the keys that were asked
 * for are echoed back, plus the effective `countdownSeconds` so the settings
 * page can read them back at once.
 */
/**
 * POST /backup-limit — HOW MANY COPIES TO KEEP, AND THE CLEANUP THAT FOLLOWS.
 *
 * The settings page asks a question the answer to which is a NUMBER, and the
 * user expects the answer to take effect NOW ("确认后立即删除"). So the route
 * does three things in order:
 *
 *   1. validates the number (`validateBackupLimit`, never a silent clamp);
 *   2. persists it through the same `applyConfigChoice` path as every other
 *      config answer, so the profile row and the running config agree;
 *   3. prunes the backups directory IMMEDIATELY and reports what really
 *      happened — the real `removed` list, the requested number, and how many
 *      copies are actually kept now. A certified copy is never deleted, so the
 *      kept count can be HIGHER than the request; `keptWillExceedRequest` says
 *      so instead of pretending the request won.
 *
 * @param {object} ctx
 * @param {object} runtime
 * @param {object} config
 * @returns {{ kind: string, path: string, handler: Function }}
 */
function buildBackupLimitRoute(ctx, runtime, config) {
  const routePath = resolveBackupLimitPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const verdict = validateBackupLimit(body.maxBackups)
        if (!verdict.ok) {
          // NO WRITE, NO CLAMP: the caller sent something the plugin will not
          // store, and the reason goes back so the page can say what is wrong.
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'invalid-maxBackups',
            reason: verdict.reason,
            min: BACKUP_LIMIT_MIN,
            max: BACKUP_LIMIT_MAX,
          }))
          return
        }
        const applied = await runtime.applyConfigChoice({ maxBackups: verdict.value })
        // THE CLEANUP IS PART OF THE ANSWER: the user just said "keep N", so the
        // directory has to look like that BEFORE the page redraws.
        const backupsDir = backupsDirFor(resolveStateDir(config))
        const pruned = pruneBackups(backupsDir, verdict.value)
        const items = listBackups(backupsDir).map((item) => ({
          ...item,
          certified: isRestoreEligible(readBackupMeta(item.dir)),
        }))
        const plan = planBackupLimit({ requested: verdict.value, items })
        runtime.log.info(
          `the copy limit is ${verdict.value}: ${pruned.removed.length} removed, ${plan.keepCount} kept`,
        )
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: true,
          applied: applied.applied,
          maxBackups: verdict.value,
          removed: pruned.removed,
          prunedReason: pruned.reason,
          requested: plan.requested,
          kept: plan.keepCount,
          certifiedKept: plan.certifiedKept,
          keptWillExceedRequest: plan.keptWillExceedRequest,
          min: BACKUP_LIMIT_MIN,
          max: BACKUP_LIMIT_MAX,
        }))
      }).catch((error) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

function buildChoiceRoute(ctx, runtime, config) {
  const routePath = resolveChoicePath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const hasInclude = Object.prototype.hasOwnProperty.call(body, 'includePlugins')
        const hasBackupInclude = Object.prototype.hasOwnProperty.call(body, 'backupIncludePlugins')
        const hasBackup = Object.prototype.hasOwnProperty.call(body, 'backupOnRestart')
        const hasShow = Object.prototype.hasOwnProperty.call(body, 'showSleepButton')
        const hasSeconds = Object.prototype.hasOwnProperty.call(body, 'sleepCountdownSeconds')
        const hasGrace = Object.prototype.hasOwnProperty.call(body, 'restartGraceMs')
        const hasAskedVersion = Object.prototype.hasOwnProperty.call(body, 'askedForPluginVersion')
        if (!hasInclude && !hasBackupInclude && !hasBackup && !hasShow && !hasSeconds && !hasGrace && !hasAskedVersion) {
          // No key was asked for: there is nothing to persist.
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'no-choice',
            instruction: 'Send { "includePlugins": true | false } and/or { "backupIncludePlugins": true | false } and/or { "backupOnRestart": true | false } and/or { "showSleepButton": true | false } and/or { "sleepCountdownSeconds": 0 | 10 | 20 | 30 | 60 } and/or { "restartGraceMs": 0 | 5000 | 10000 | 20000 | 30000 | 60000 } and/or { "askedForPluginVersion": "1.2.3" }.',
          }))
          return
        }
        if (hasInclude && typeof body.includePlugins !== 'boolean') {
          // Nothing is written for a malformed choice: the caller's answer
          // must not change the profile configuration.
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'includePlugins-must-be-boolean',
            instruction: 'Send { "includePlugins": true | false }.',
          }))
          return
        }
        if (hasBackupInclude && typeof body.backupIncludePlugins !== 'boolean') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'backupIncludePlugins-must-be-boolean',
            instruction: 'Send { "backupIncludePlugins": true | false }.',
          }))
          return
        }
        if (hasBackup && typeof body.backupOnRestart !== 'boolean') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'backupOnRestart-must-be-boolean',
            instruction: 'Send { "backupOnRestart": true | false }.',
          }))
          return
        }
        if (hasShow && typeof body.showSleepButton !== 'boolean') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'showSleepButton-must-be-boolean',
            instruction: 'Send { "showSleepButton": true | false }.',
          }))
          return
        }
        if (hasSeconds && COUNTDOWN_CHOICES.indexOf(body.sleepCountdownSeconds) === -1) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'sleepCountdownSeconds-must-be-offered',
            instruction: `Send { "sleepCountdownSeconds": ${COUNTDOWN_CHOICES.join(' | ')} }.`,
          }))
          return
        }
        if (hasGrace && GRACE_CHOICES_MS.indexOf(body.restartGraceMs) === -1) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'restartGraceMs-must-be-offered',
            instruction: `Send { "restartGraceMs": ${GRACE_CHOICES_MS.join(' | ')} }.`,
          }))
          return
        }
        if (hasAskedVersion && typeof body.askedForPluginVersion !== 'string') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'askedForPluginVersion-must-be-string',
            instruction: 'Send { "askedForPluginVersion": "1.2.3" }.',
          }))
          return
        }
        const changes = {}
        // The route field is `includePlugins`, the configuration key is
        // `backupIncludePlugins` (the profile row keeps the plugin's own name).
        if (hasInclude) changes.backupIncludePlugins = body.includePlugins === true
        if (hasBackupInclude) changes.backupIncludePlugins = body.backupIncludePlugins === true
        if (hasBackup) changes.backupOnRestart = body.backupOnRestart === true
        if (hasShow) changes.showSleepButton = body.showSleepButton === true
        if (hasSeconds) changes.sleepCountdownSeconds = body.sleepCountdownSeconds
        if (hasGrace) changes.restartGraceMs = body.restartGraceMs
        const result = await runtime.applyConfigChoice(changes)
        // THE PLUGIN VERSION THE USER WAS ASKED FOR. It lives in
        // install-choice.json (where readInstallChoice() looks for it), so it is
        // written here and not through applyConfigChoice.
        //
        // resolveStateDir(), NOT path.dirname(config.stateFile): the default
        // stateFile is '' and path.dirname('') is '.', so that spelling wrote
        // the file into the process working directory - which is exactly why
        // the panel said "saved" while the real state dir never changed.
        if (hasAskedVersion) {
          writeInstallChoice(resolveStateDir(config), {
            askedForPluginVersion: body.askedForPluginVersion,
          })
        }
        // The one-time install prompt explained the features to the user, so
        // the announcement of a fresh installation must not follow it.
        //
        // Only the install prompt sends `includePlugins` and `showSleepButton`
        // (the settings page writes `backupIncludePlugins`,
        // `backupOnRestart` and `sleepCountdownSeconds`), so these two keys
        // are exactly the "the install question was answered" moment.
        if (hasInclude || hasShow) {
          const seen = runtime.markAllFeaturesSeen()
          if (seen.length > 0) {
            runtime.log.info(`the install question marked the feature announcements as seen: ${seen.join(', ')}`)
          }
        }
        const answer = { ok: true, applied: result.applied }
        if (hasInclude) answer.includePlugins = body.includePlugins === true
        if (hasBackupInclude) answer.backupIncludePlugins = body.backupIncludePlugins === true
        if (hasBackup) answer.backupOnRestart = body.backupOnRestart === true
        if (hasShow) answer.showSleepButton = body.showSleepButton === true
        if (hasSeconds) answer.sleepCountdownSeconds = body.sleepCountdownSeconds
        if (hasGrace) answer.restartGraceMs = body.restartGraceMs
        if (hasAskedVersion) answer.askedForPluginVersion = body.askedForPluginVersion
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(answer))
      }).catch((error) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * The route of the self-starting supervisor.
 *
 * Three actions, and NOTHING happens without the confirmation:
 *
 *   - `status` — who starts this host and whether the restart can work;
 *   - `plan` — what the installation WOULD change (the dry run: it writes
 *     nothing and runs nothing);
 *   - `install` / `uninstall` — the real thing, and they need `confirmed: true`
 *     (the confirmation card is what says "yes").
 *
 * @param {object} ctx the plugin context
 * @param {any} runtime the runtime of this plugin
 * @param {object} config the normalized config
 * @returns {object} the route
 */

function buildSupervisorRoute(ctx, runtime, config) {
  const routePath = resolveSupervisorPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        if (action === 'status') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ ok: true, action, supervisor: runtime.supervisorStatus() }))
          return
        }
        if (action === 'plan' || action === 'install-plan') {
          // The installation plan: what the registration WOULD do. Nothing is
          // written and nothing is run.
          const plan = planSupervisorInstall({
            platform: runtime.env.platform,
            // The desktop app manages itself: there is no plan there.
            isDesktopApp: runtime.env.isDesktopApp === true,
            // The startup matrix: only a `bare` host may get a supervisor.
            startup: runtime.startupMode(),
            // WHICH MACHINE IS THIS? (WSL is not a Linux.)
            host: runtime.hostKind(),
            nodePath: process.execPath,
            execPath: process.execPath,
            supervisorPath: supervisorPaths(path.dirname(runtime.stateFile)).script,
            configPath: supervisorPaths(path.dirname(runtime.stateFile)).config,
            kind: config.supervisorKind,
          })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: plan.error ? false : true,
            action,
            plan,
            error: plan.error ?? null,
            reason: plan.reason,
            supervisor: runtime.supervisorStatus(),
          }))
          return
        }
        if (action === 'dry-run' || action === 'derive') {
          // B: the dry run. It shows what WOULD be written and runs nothing.
          const plan = await runtime.deriveStartCommand()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ ok: true, action, plan, supervisor: runtime.supervisorStatus() }))
          return
        }
        if (action === 'apply' || action === 'revert') {
          if (body.confirmed !== true) {
            // The dry run is the confirmation: without it nothing is written.
            res.statusCode = 400
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({
              ok: false,
              error: 'confirmation-required',
              instruction: 'Send { "action": "' + action + '", "confirmed": true } after the user confirmed the dry run.',
            }))
            return
          }
          const result = action === 'apply'
            ? await runtime.applyDerivedCommand()
            : await runtime.revertDerivedCommand()
          res.statusCode = result.ok === true ? 200 : 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: result.ok === true,
            action,
            error: result.error ?? null,
            writes: result.writes ?? null,
            previous: result.previous ?? null,
            reason: result.reason ?? null,
            supervisor: runtime.supervisorStatus(),
          }))
          return
        }
        if (action === 'external') {
          // "I keep my own way": nothing is installed, but the answer is
          // recorded — so the plugin knows that a supervisor is already there
          // and never installs a second one.
          runtime.recordSupervisorChoice('external')
          try {
            await runtime.applyConfigChoice({ supervisorMode: 'external' })
          } catch (error) {
            runtime.log.warn('the supervisor mode could not be written:', String(error))
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ ok: true, action, supervisor: runtime.supervisorStatus() }))
          return
        }
        if (action === 'install' || action === 'uninstall') {
          if (action === 'install' && runtime.env.isDesktopApp === true) {
            // The desktop app manages itself: a login record would open a
            // SECOND client at every login. The refusal comes BEFORE the
            // confirmation, so nothing is asked of the user.
            res.statusCode = 400
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({
              ok: false,
              action,
              error: 'desktop-manages-itself',
              reason: 'the desktop app relaunches itself; a supervisor would start a second copy',
              steps: [],
              supervisor: runtime.supervisorStatus(),
            }))
            return
          }
          if (body.confirmed !== true) {
            // The confirmation card is what says "yes": without it nothing is
            // changed on the machine.
            res.statusCode = 400
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({
              ok: false,
              error: 'confirmation-required',
              instruction: 'Send { "action": "' + action + '", "confirmed": true } after the user confirmed the card.',
            }))
            return
          }
          if (action === 'install') {
            const choice = typeof body.choice === 'string' ? body.choice : ''
            if (choice !== '') runtime.recordSupervisorChoice(choice)
            const result = runtime.installSupervisor({ confirmed: true })
            res.statusCode = result.ok ? 200 : 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({
              ok: result.ok === true,
              action,
              kind: result.kind,
              degraded: result.degraded,
              steps: result.steps,
              error: result.error,
              reason: result.reason,
              supervisor: runtime.supervisorStatus(),
            }))
            return
          }
          const result = await runtime.uninstallSupervisor()
          res.statusCode = result.ok ? 200 : 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: result.ok === true,
            action,
            steps: result.steps,
            error: result.error,
            pending: result.pending,
            previous: result.previous,
            supervisor: runtime.supervisorStatus(),
          }))
          return
        }
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: false,
          error: 'unknown-action',
          instruction: 'Send { "action": "status" | "plan" | "install" | "uninstall" }.',
        }))
      }).catch((error) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Is the graceful sleep a dry run?
 *
 * With `DSH_AUTORESTART_SLEEP_DRYRUN=1` the plugin reports the command it
 * WOULD run and never runs it. That is what makes the feature testable on a
 * live machine.
 *
 * @returns {boolean}
 */
function sleepDryRun() {
  return process.env.DSH_AUTORESTART_SLEEP_DRYRUN === '1'
}

/**
 * The gate of the graceful sleep: the ONE question is "is any conversation
 * still working?".
 *
 * It is deliberately NOT the restart gate: that one also demands a quiet
 * settle window, and a settle window longer than the countdown would push the
 * power-off back by whole countdown periods (every restart of the countdown
 * would also claim that somebody started working again, which is not what
 * happened). The sleep feature counts down on screen itself, so it only needs
 * the busy check — and it keeps `settleMs` out of the picture entirely.
 *
 * The shutdown has NO invisible reserve of its own: the visible countdown
 * (`sleepCountdownSeconds`) IS the wait before the machine goes off, and it is
 * on screen, so the user can see it and cancel it. A second, hidden window
 * next to it would only say the same thing twice.
 *
 * The restart gate itself is untouched: the restart feature keeps its quiet
 * window exactly as it was (plus its own restart reserve).
 *
 * @param {object} runtime
 * @returns {{ allow: boolean, reason: 'busy'|'quiet', blockedBy: any[] }}
 */
function sleepGate(runtime) {
  // A pending restart goes FIRST: the shutdown waits for it — and for the
  // sessions that resume with it. The intent survives the restart, so the
  // machine goes off after everything is done, not before.
  let pending = false
  try {
    pending = typeof runtime.pendingRestart === 'function' && runtime.pendingRestart() === true
  } catch {
    pending = false
  }
  if (pending) {
    return {
      allow: false,
      reason: 'restart-pending',
      blockedBy: [{
        sessionId: 'restart-pending',
        kind: 'restart-pending',
        label: '待执行的重启',
        name: '待执行的重启',
      }],
    }
  }
  let busy = []
  try {
    busy = runtime.busyAgents()
  } catch {
    busy = []
  }
  const list = Array.isArray(busy) ? busy : []
  if (list.length > 0) return { allow: false, reason: 'busy', blockedBy: list }
  // Nobody is busy and no restart is pending: the countdown may run. There is
  // no invisible reserve — the countdown on screen is the wait.
  return { allow: true, reason: 'quiet', blockedBy: [] }
}

/**
 * The FINAL plan of the graceful sleep: what will really be executed, and how
 * the host describes itself in the status JSON.
 *
 * Two rules:
 *   1. `supported` follows the plan that will be executed, NOT the detected
 *      one: a machine whose platform could not be detected is still perfectly
 *      usable when the operator configured a command of their own.
 *   2. the reported `kind`/`label` belong to that same plan, so the status
 *      never says "this machine has no reliable way to switch off" while a
 *      command is about to run.
 *
 * @param {object} plan the detected plan
 * @param {object} config
 * @returns {object} the effective plan
 */
function effectiveSleepPlan(plan, config) {
  const invocation = planInvocation(plan, {
    sleepCommand: config.sleepCommand,
    platform: plan.platform,
  })
  const custom = invocation.source === 'sleepCommand'
  const detectedKind = typeof plan.kind === 'string' ? plan.kind : 'unsupported'
  // A CONTAINER IS NOT A MACHINE THIS FEATURE CAN SWITCH OFF (2026-11-02): its
  // plan carries no command, so it is treated like an unsupported platform —
  // the operator's own `sleepCommand` is then the only way, and the label says
  // "your own command" instead of borrowing a promise from a dead plan.
  const detected = detectedKind !== 'unsupported' && detectedKind !== 'container'
  const command = typeof invocation.command === 'string' && invocation.command !== '' ? invocation.command : null
  const label = custom
    ? (detected ? `执行你指定的关机命令（${plan.label}）` : '执行你指定的关机命令')
    : plan.label
  const kind = custom
    // A custom command on a platform we could not classify: the machine is
    // real, the mechanism is the operator's own — it is NOT "unsupported".
    ? (detected ? detectedKind : 'custom')
    : detectedKind
  return {
    ...invocation,
    kind,
    label,
    // The short phrase the countdown message talks about.
    shortLabel: custom ? '执行你指定的关机命令' : plan.label,
    // The final plan decides whether the feature may run at all.
    supported: command !== null,
  }
}

/**
 * Build the graceful-sleep service: the detected host plan plus the state
 * machine that waits for the conversations, counts down and switches the
 * machine off.
 *
 * The busy check is the runtime's own `busyAgents()`, so the sleep feature and
 * the restart feature agree on what "every conversation is idle" means. The
 * gate itself is the sleep-specific one (no settle window): the sleep feature
 * counts down on screen itself.
 *
 * `options.sleepNow` and `options.sleepSpawn` replace the clock and the
 * process spawner, so the whole flow can be driven without waiting and
 * without ever touching the machine. Production never passes them.
 *
 * @param {object} ctx
 * @param {object} runtime
 * @param {object} config
 * @param {{ sleepNow?: () => number, sleepSpawn?: Function }} [options]
 * @returns {{ plan: object, controller: object, invocation: () => object }}
 */
function createSleepService(ctx, runtime, config, options = {}) {
  const plan = detectShutdownPlan({ platform: process.platform, env: process.env })
  // The configured command (if any) replaces the detected one; the final plan
  // is what decides whether the feature may run and what the UI is told.
  const invocation = () => effectiveSleepPlan(plan, config)
  const gate = () => sleepGate(runtime)
  const final = invocation()
  const now = typeof options.sleepNow === 'function' ? options.sleepNow : () => Date.now()
  const spawn = typeof options.sleepSpawn === 'function' ? options.sleepSpawn : undefined
  const buildController = (seconds) => createSleepController({
    now,
    busyAgents: () => runtime.busyAgents(),
    gate,
    titleOf: (sessionId) => runtime.sessionTitle(sessionId),
    // The shutdown has NO invisible reserve: the countdown on screen IS the
    // wait before the machine goes off. The controller keeps the parameter for
    // compatibility, but the plugin never injects a window — and it never
    // injects the RESTART reserve either.
    graceMs: () => 0,
    // A pending restart goes first: the shutdown waits for it.
    restartPending: () => {
      const pending = runtime.pendingRestart()
      if (!pending) return { pending: false, blockers: [] }
      return {
        pending: true,
        blockers: [{
          sessionId: 'restart-pending',
          kind: 'restart-pending',
          label: '待执行的重启',
          name: '待执行的重启',
        }],
      }
    },
    // The intent is spent when the machine went off, when the shutdown failed
    // and when the user cancelled it: the checkpoint must not keep it.
    onDisarm: (reason) => {
      try {
        clearSleep(runtime.state)
        runtime.persist()
        runtime.log.info('the shutdown intent was cleared:', reason)
      } catch (error) {
        runtime.log.warn('could not clear the shutdown intent:', String(error))
      }
    },
    countdownSeconds: seconds,
    hostLabel: final.shortLabel,
    supported: final.supported,
    log: runtime.log,
    // The timer belongs to the plugin: `ctx.interval` is disposed with it.
    setInterval: (fn, ms) => ctx.interval(fn, ms),
    clearInterval: (handle) => {
      try {
        if (typeof handle === 'function') handle()
      } catch {}
    },
    shutdown: () => runShutdown(invocation(), {
      spawn,
      dryRun: sleepDryRun(),
      log: runtime.log,
      // The gate is checked ONE more time right before the machine is closed —
      // with the SAME sleep gate (a busy conversation still stops it).
      gate,
    }),
  })
  // The countdown length belongs to the CONFIGURATION, and the configuration
  // page can change it while the plugin runs. The controller is rebuilt as
  // soon as the new length is known — but never while a countdown is running:
  // that one keeps the length it was started with.
  let active = buildController(config.sleepCountdownSeconds)
  let activeSeconds = config.sleepCountdownSeconds
  const current = () => {
    const seconds = config.sleepCountdownSeconds
    if (seconds === activeSeconds) return active
    if (active.status().armed) return active
    active.dispose()
    active = buildController(seconds)
    activeSeconds = seconds
    return active
  }
  const liveController = {
    arm: (...args) => current().arm(...args),
    cancel: (...args) => current().cancel(...args),
    tick: (...args) => current().tick(...args),
    status: (...args) => current().status(...args),
    dispose: (...args) => current().dispose(...args),
  }
  return {
    plan,
    get controller() {
      return liveController
    },
    invocation,
    /**
     * Arm the shutdown AND remember the intent.
     *
     * The intent lives in the checkpoint file, so it survives a restart: a
     * shutdown asked for while a restart is pending waits for that restart —
     * and for the sessions that resume with it.
     *
     * @returns {object} the sleep status
     */
    arm: () => {
      try {
        armSleep(runtime.state, {
          armedAt: Date.now(),
          countdownSeconds: config.sleepCountdownSeconds,
        })
        runtime.persist()
      } catch (error) {
        runtime.log.warn('could not record the shutdown intent:', String(error))
      }
      return liveController.arm()
    },
    /**
     * Cancel the shutdown: the intent is gone for good (the disarm hook of
     * the controller clears the checkpoint).
     *
     * @returns {object} the sleep status
     */
    cancel: () => liveController.cancel(),
    /**
     * The recorded shutdown intent, if there is one.
     *
     * @returns {{ armed: true, armedAt: number, countdownSeconds: number|null }|null}
     */
    intent: () => runtime.state.sleep,
    /**
     * Arm the shutdown from a recorded intent (the boot restore).
     *
     * @returns {object} the sleep status
     */
    restore: () => liveController.arm(),
  }
}

/**
 * The state of the graceful sleep, in the shape the client renders it.
 *
 * @param {{ plan: object, controller: object, invocation: () => object }} sleep
 * @param {object} config
 * @param {object} [runtime] the runtime (for the quiet window)
 * @returns {object}
 */
function sleepStatusPayload(sleep, config, runtime) {
  const status = sleep.controller.status()
  const invocation = sleep.invocation()
  const intent = typeof sleep.intent === 'function' ? sleep.intent() : null
  return {
    ok: true,
    phase: status.phase,
    armed: status.armed,
    showSleepButton: config.showSleepButton !== false,
    countdownSeconds: status.countdownSeconds,
    // The RESTART reserve is reported next to the countdown, so the settings
    // page can show it. The shutdown itself has NO invisible reserve: the
    // visible countdown is the wait before the machine goes off.
    restartGraceMs: config.restartGraceMs,
    quietForMs: runtime && typeof runtime.quietForMs === 'function' ? runtime.quietForMs() : 0,
    // When the shutdown was armed: the intent has to survive a restart, so the
    // time is reported for the troubleshooting.
    armedAt: intent && typeof intent.armedAt === 'number' ? intent.armedAt : null,
    /**
     * The pre-restart backup scope, straight from the effective configuration:
     * the settings page reads its two switches from here.
     */
    backupOnRestart: config.backupOnRestart !== false,
    backupIncludePlugins: config.backupIncludePlugins !== false,
    remainingMs: status.remainingMs,
    blockers: status.blockers,
    host: {
      platform: invocation.platform || process.platform,
      kind: invocation.kind,
      label: invocation.label,
      source: invocation.source,
      // Machine-readable: the host was only recognized as WSL because the
      // Windows drive is mounted (a hint, not a proof). The UI and the tests
      // read this instead of guessing from the Chinese label.
      suspect: invocation.suspect === true,
    },
    dryRun: sleepDryRun(),
    message: status.message,
    lastRun: status.lastRun,
  }
}

/**
 * Build the `/sleep` route: `GET` reports the state of the graceful sleep,
 * `POST` arms or cancels it.
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "action": "arm" | "cancel" }`; anything else is refused with a 400.
 *
 * There is NO ticket and no extra header: the desktop client and the hosted
 * web client drive the very same route, so a request carries nothing but the
 * action itself.
 */
function buildSleepRoute(ctx, runtime, config, sleep) {
  const routePath = resolveSleepPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      if (method === 'GET') {
        answer(sleepStatusPayload(sleep, config, runtime))
        return
      }
      if (method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'GET, POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      // A route that changes state only accepts JSON: a cross-site simple
      // request (a form post, or text/plain) must not be able to reach it.
      if (!requireJsonContentType(req, res)) return
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        if (action !== 'arm' && action !== 'cancel') {
          answer({
            ok: false,
            error: 'unknown-action',
            instruction: 'Send { "action": "arm" | "cancel" }.',
          }, 400)
          return
        }
        if (action === 'arm') {
          // The intent is recorded too: it survives a restart.
          sleep.arm()
        } else {
          sleep.cancel()
        }
        answer(sleepStatusPayload(sleep, config, runtime))
      }).catch((error) => {
        answer({ ok: false, error: describeError(error) }, 400)
      })
    },
  }
}

/** Expose a tiny read-only health route for humans and verification scripts. */

function registerHealthRoute(ctx, runtime, config, sleep) {
  const routePath = typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : '/__dsh_autorestart/health'
  const route = {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const state = runtime.state
      if (typeof req.url === 'string' && req.url.includes('gate=1')) {
        // The detached restart helper asks this immediately before it kills anything.
        const verdict = runtime.gate()
        let agentCount = 0
        try {
          agentCount = ctx.agents.list().length
        } catch {}
        const gateBody = JSON.stringify({
          ok: true,
          allowRestart: verdict.allow,
          gate: {
            allow: verdict.allow,
            reason: verdict.reason,
            blockedBy: verdict.blockedBy,
            quietForMs: verdict.quietForMs,
          },
          phase: state.phase,
          generation: state.generation,
          pendingRestart: state.restart !== null,
          settleMs: config.settleMs,
          // The RESTART reserve and the quiet window the gate really uses:
          // both are needed to tell "waiting for the reserve" from "somebody
          // is busy".
          graceMs: config.restartGraceMs,
          effectiveSettleMs: runtime.effectiveSettleMs(),
          // The upper bound of a queued (unclaimed) inbox message: after this
          // window it stops blocking the restart.
          queuedGraceMs: config.queuedGraceMs,
          quietForMs: typeof verdict.quietForMs === 'number' ? verdict.quietForMs : 0,
          // The number of TASKS the restart waits for: a session and its own
          // subagents are ONE task, exactly as the left sidebar counts them.
          busyCount: countBlockerTasks(verdict.blockedBy),
          agentCount,
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(gateBody)
        return
      }
      if (typeof req.url === 'string' && req.url.includes('state=1')) {
        // A client UI polls this to show a "pending restart" banner for a session.
        // Read-only: it never mutates the checkpoint and never fails the request.
        let stateBody
        try {
          const live = runtime.state
          const restart = live.restart
          const pendingRestart = restart !== null
          const waiters = []
          const seen = new Set()
          const addWaiter = (value) => {
            if (value === null || value === undefined) return
            const id = String(value)
            if (!id || seen.has(id)) return
            seen.add(id)
            waiters.push(id)
          }
          if (restart && typeof restart === 'object') {
            if (Array.isArray(restart.requesters)) {
              for (const requester of restart.requesters) {
                if (!requester || typeof requester !== 'object') continue
                addWaiter(requester.sessionId)
              }
            }
            addWaiter(restart.bySessionId)
          }
          if (pendingRestart && live.sessions && typeof live.sessions === 'object') {
            for (const [sessionId, entry] of Object.entries(live.sessions)) {
              if (!entry || typeof entry !== 'object') continue
              if (entry.pendingResume !== true) continue
              addWaiter(typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId)
            }
          }
          const verdict = runtime.gate()
          // The restart stage (waiting / snapshotting / restarting / back), the
          // real snapshot progress and the "is a cancel still honest" answer —
          // computed ONCE per answer so every field of the payload agrees.
          const stage = runtime.restartStageInfo()
          // Best effort: label the blocking sessions with their titles when the
          // session controller knows them. The title is optional, so an entry
          // without one is sent exactly as the gate produced it. The goal
          // reason (`goal-active` / `goal-exhausted`) is attached as well, so
          // the client can tell a goal-driven blocker from a busy session.
          // A blocker that is not an object (an empty string still reported by
          // an older route, a null) is not a blocker: it has no session and no
          // name, and rendering one produced the bare ",," the user saw. It is
          // dropped HERE, so the interface never receives one.
          const blockedBy = goalAwareBlockingDetails(runtime, verdict.blockedBy)
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => {
              const title = runtime.sessionTitle(entry.sessionId)
              return title ? { ...entry, title } : entry
            })
          stateBody = JSON.stringify({
            ok: true,
            pendingRestart,
            phase: live.phase,
            generation: live.generation,
            // WHAT HAPPENED TO THE REQUEST: queued / deferred / cancelled, with
            // the reason, who ended it and when. Without this a vanished restart
            // request is a fact nobody can look up.
            restartRequest: runtime.restartRequestInfo(),
            waiters,
            blockedBy,
            // THE ONE NUMBER both client surfaces read: the capsule and the
            // panel it opens. Counting the blockers in the browser is what made
            // "1 个会话在忙" sit next to "还在等 0 个任务" — the two surfaces
            // counted different filtered copies of the same list (user report,
            // 2026-10-29). A blocker without a readable name is still a task.
            busyCount: countBlockerTasks(verdict.blockedBy),
            allowRestart: verdict.allow === true,
            // WHY the gate says what it says. Without this, "allowRestart is
            // false and blockedBy is empty" looks like a contradiction: the
            // reason tells the two apart (an empty blocker list with the
            // reason "settling" means the quiet window is not full yet).
            reason: typeof verdict.reason === 'string' ? verdict.reason : 'unknown',
            quietForMs: typeof verdict.quietForMs === 'number' ? verdict.quietForMs : 0,
            settleMs: config.settleMs,
            // THE GATE, WRITTEN DOWN (diagnostics only, 2026-11-02): the last
            // decision of the pending-restart gate — action, reason, who blocked
            // it, how long the request has waited, how many attempts — plus WHO
            // was resetting the quiet window at that moment. Without it "the
            // restart never fires" is a fact nobody can look up; with it, the
            // cause is one field away.
            restartGate: runtime.restartGateInfo(),
            ...runtime.quietResetInfo(),
            // THE OLD ROLLBACK SCRIPT SWEEP (2026-11-02): what the boot removed
            // (`removed` names), what it left alone (`kept`), and whether the
            // platform made it a no-op (`skipped` + `reason`). Without it the
            // answer to "are there leftovers?" would be a guess again.
            watcherHygiene: runtime.watcherHygiene ?? null,
            backupHygiene: runtime.backupHygiene ?? null,
            // The RESTART reserve and the quiet window the gate really uses.
            graceMs: config.restartGraceMs,
            effectiveSettleMs: runtime.effectiveSettleMs(),
            // The upper bound of a queued (unclaimed) inbox message.
            queuedGraceMs: config.queuedGraceMs,
            // The long wait: present only when the restart passed the hard
            // deadline while a conversation was still running. It says how
            // long the restart has been waiting, why, and who holds it — the
            // request itself is never dropped.
            longWait: runtime.longWaitInfo(),
            // THE STAGE OF THE RESTART, for the pill and the settings page:
            // which of the four stages is on screen, the real copy progress of
            // the snapshot, whether it is going slower than expected, and
            // whether a cancel would still be honest (`cancellable`).
            restartPhase: stage,
            // The copy progress on its own as well, so a client that only wants
            // the numbers does not have to walk the stage object.
            progress: stage.progress,
            // THE FIRST-INSTALL BACKUP: what happened when this machine looked for a
            // known-good backup and found none (user decision, 2026-10-30).
            // Absent when nothing was ever tried, so an old client sees no change.
            ...(live.firstInstallBackup ? { firstInstallBackup: live.firstInstallBackup } : {}),
            updatedAt: live.updatedAt,
            // The park route, so the client never has to guess the prefix, and
            // the goals this plugin already disarmed (they are re-armed after
            // the restart).
            parkUrl: resolveParkPath(config),
            recoverUrl: resolveRecoverPath(config),
            // The route that withdraws ONE session's own restart request (the
            // manual "cancel my restart" of the pill).
            cancelUrl: resolveCancelPath(config),
            // THE ROUTE OF THE MANUAL ROLLBACK: POST a backup NAME and this
            // host saves the current state, restores that copy and restarts.
            rollbackUrl: resolveManualRollbackPath(config),
            // The route that persists the one-time install choice, plus the
            // value that is effective right now.
            choiceUrl: resolveChoicePath(config),
            // The route that reports (and records) the one-time feature
            // announcements, so the client never has to guess the prefix.
            announcementsUrl: resolveAnnouncementsPath(config),
            pluginVersion: pluginVersionNow(),
            backupOnRestart: config.backupOnRestart !== false,
            backupIncludePlugins: config.backupIncludePlugins !== false,
            // WHICH PROFILE THIS HOST BELONGS TO (2026-11-02). The backups and
            // the rollback are PER PROFILE, so the page has to be able to tell
            // three cases apart: a resolved profile, "several profiles, I cannot
            // pick one" (`profileDirSource: 'ambiguous'`) and "there is none".
            // Without these fields the multi-profile warning could never appear.
            ...profileDirInfo(),
            // WHAT IS ON DISK RIGHT NOW: the backups of this host (the count,
            // the local time, the size, whether the plugins are in it and
            // where it lives). The browser cannot read the disk, so the Host
            // reads it — only the directory, never the contents.
            backups: runtime.backupsInfo(),
            // THE REPORTED KIND OF PLUGIN FAILURE: what the last boot found in
            // the startup log, what was put back from the known-good backup and
            // to which point in time. Always present (null = never had one), so
            // the interface can tell "no incident" from "the field is missing".
            pluginRecovery: runtime.pluginRecoveryInfo(),
            // THE LAST RESTORE A HUMAN ASKED FOR (user decision, 2026-11-01):
            // the popup's "put THIS one plugin back" writes it, and the answer
            // says which plugin, from which backup, and whether a restart is
            // needed to load it. Absent when nobody ever asked.
            ...(runtime.pluginRestoreInfo() ? { pluginRestore: runtime.pluginRestoreInfo() } : {}),
            // THE LAST COOKIE CLEANUP: `{at, atIso, ok, removed, reason}` of the
            // run that happened between the kill and the relaunch. `removed` is
            // the number of stale `dsh-auth-*` cookies deleted BY THAT RUN — it
            // is NOT a live count, and cannot be: the cookie jar of a running
            // browser is locked, so a live number would be a guess.
            cookieClear: runtime.cookieClearInfo(),
            // THE RESTART COMMAND that is in effect: what is written, and what
            // an undo would restore. The settings page shows it in a folded
            // "for a technical colleague" section.
            restart: {
              mode: config.restartMode,
              command: typeof config.restartCommand === 'string' ? config.restartCommand : '',
              written: typeof config.restartCommand === 'string' && config.restartCommand !== '',
              canRevert: Boolean(
                live.onboarding
                && typeof live.onboarding === 'object'
                && live.onboarding.previous
                && typeof live.onboarding.previous.restartMode === 'string',
              ),
              previous: live.onboarding && typeof live.onboarding === 'object' && live.onboarding.previous
                ? live.onboarding.previous
                : null,
            },
            parkedGoals: parkedGoalList(runtime),
            recovery: recoveryList(live),
            // THE ACCESS LINK of this instance (with the boot token). The boot
            // token is created per process, so the link the browser holds
            // answers 401 after a restart. The client needs the new link to
            // get the user back into the interface.
            accessUrl: accessUrlOf(runtime),
            // The supervisor: who starts this host, and whether the restart
            // can work at all.
            supervisor: runtime.supervisorStatus(),
            // WHICH END this is. The browser side serves the desktop app AND
            // the hosted web host, so it may not assume one of them: the
            // desktop app brings itself back up (there is nothing to install
            // there), while the hosted host may ask for a supervisor.
            instance: {
              isDesktopApp: runtime.env.isDesktopApp === true,
              platform: runtime.env.platform,
            },
            // THE LAST RESTART: the snapshot that was taken before it (the
            // directory, its LOCAL time, how long it took, which older
            // snapshots were pruned) and the verdict of the instance that came
            // up (the four checks). Without it a restart has no visible
            // result at all.
            lastRestart: runtime.lastRestartVerdict(),
            // Whether the one-time question about the supervisor may be asked.
            supervisorOffer: runtime.supervisorOffer,
            // The answer of the one-time question about the supervisor (null
            // while it was never answered).
            onboarding: runtime.onboardingChoice,
            // The route that installs, uninstalls and reports the supervisor.
            supervisorUrl: resolveSupervisorPath(config),
            // "REPORT A PROBLEM": the diagnostic text (built by ONE generator on
            // the host, so the browser and the host can never drift) and the
            // two places a report can go.
            diagnostics: runtime.diagnostics(),
            report: {
              email: SUPPORT_EMAIL,
              issueUrlBase: ISSUE_URL_BASE,
            },
          })
        } catch {
          // The banner must never break the health route: fall back to "no restart".
          stateBody = JSON.stringify({
            ok: true,
            pendingRestart: false,
            waiters: [],
            blockedBy: [],
            allowRestart: false,
            reason: 'unknown',
            quietForMs: 0,
            queuedGraceMs: config.queuedGraceMs,
            longWait: null,
            parkUrl: resolveParkPath(config),
            recoverUrl: resolveRecoverPath(config),
            cancelUrl: resolveCancelPath(config),
            // THE ROUTE OF THE MANUAL ROLLBACK: POST a backup NAME and this
            // host saves the current state, restores that copy and restarts.
            rollbackUrl: resolveManualRollbackPath(config),
            choiceUrl: resolveChoicePath(config),
            announcementsUrl: resolveAnnouncementsPath(config),
            pluginVersion: pluginVersionNow(),
            backupOnRestart: config.backupOnRestart !== false,
            backupIncludePlugins: config.backupIncludePlugins !== false,
            parkedGoals: [],
            recovery: [],
            pluginRecovery: null,
          })
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(stateBody)
        return
      }
      const probeIndex = typeof req.url === 'string' && req.url.includes('probeIndex=1')
      const body = JSON.stringify({
        ok: true,
        plugin: name,
        // The version of the code that is LOADED (not the fallback constant):
        // a real-machine check can tell "the new build is running" from "the
        // old one is still in memory".
        version: runtime.pluginVersion ?? PLUGIN_VERSION_FALLBACK,
        bootId: runtime.bootId,
        pid: process.pid,
        phase: state.phase,
        generation: state.generation,
        pendingRestart: state.restart !== null,
        updatedAt: state.updatedAt,
        pageHeartbeat: runtime.pageHeartbeat === true,
        systemPrompt: runtime.systemPrompt === true,
        manualRestartBlocks: runtime.manualRestartBlocks ?? 0,
        indexTaps: runtime.indexTaps ?? 0,
        configSchema: Config !== undefined,
        // THE LAST COOKIE CLEANUP, on the short route as well: a script (or the
        // user) can see whether the stale `dsh-auth-*` cookies were really
        // removed before the relaunch, without opening the interface. The
        // numbers are those of the last run, never a live count (the jar of a
        // running browser is locked).
        cookieClear: runtime.cookieClearInfo(),
        // THE REPORTED KIND OF PLUGIN FAILURE: which plugin did not load, what
        // the known-good backup put back and to which point in time. Null when
        // this machine never had one; the PROCESS-LEVEL failure is NOT reported
        // here (that is the rollback report and the watchdog).
        pluginRecovery: runtime.pluginRecoveryInfo(),
        // THE LAST RESTORE A HUMAN ASKED FOR (the popup's button): "this one
        // plugin was put back from that backup at that time, restart to load it".
        ...(runtime.pluginRestoreInfo() ? { pluginRestore: runtime.pluginRestoreInfo() } : {}),
        // THE FIRST-INSTALL BACKUP: what happened when this machine looked for a
        // known-good backup and found none (user decision, 2026-10-30). Absent
        // when nothing was ever tried.
        ...(state.firstInstallBackup ? { firstInstallBackup: state.firstInstallBackup } : {}),
        // THE RESTART STAGE, read from the health route as well: a script (or a
        // user watching the console) can tell "waiting" from "backing up 120 MB
        // of 156 MB" without opening the interface.
        restartPhase: runtime.restartStageBrief(),
        progress: runtime.restartStageBrief().progress,
        schemastery: Config === undefined
          ? (schemastery === undefined ? 'unresolved' : 'construction-failed')
          : (schemasterySource === 'bare-specifier' ? 'bare' : 'asar-fallback'),
        ...(probeIndex
          ? {
            probeIndex: injectPageHeartbeat(
              '<html><head></head><body>probe</body></html>',
              runtime.bootId,
              routePath,
            ),
          }
          : {}),
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    },
  }

  const attempt = (target) => {
    let webServer
    try {
      webServer = target.get('webServer')
    } catch {
      return false
    }
    if (!webServer || typeof webServer.register !== 'function') return false
    const parkRoute = buildParkRoute(ctx, runtime, config)
    const recoverRoute = buildRecoverRoute(ctx, runtime, config)
    const handoffRoute = buildHandoffRoute(ctx, runtime, config)
    const choiceRoute = buildChoiceRoute(ctx, runtime, config)
    const cancelRoute = buildCancelRoute(ctx, runtime, config)
    const manualRollbackRoute = buildManualRollbackRoute(ctx, runtime, config)
    const pluginRestoreRoute = buildPluginRestoreRoute(ctx, runtime, config)
  const pluginInventoryRoute = buildPluginInventoryRoute(ctx, runtime, config)
    const announcementsRoute = buildAnnouncementsRoute(ctx, runtime, config)
    const supervisorRoute = buildSupervisorRoute(ctx, runtime, config)
    const sleepRoute = sleep ? buildSleepRoute(ctx, runtime, config, sleep) : null
    try {
      const origin = typeof webServer.getOrigin === 'function' ? String(webServer.getOrigin()) : ''
      const portMatch = /:(\d+)\/?$/.exec(origin)
      if (portMatch) runtime.webPort = Number(portMatch[1])
      // THE INSTANCE RECORD. The new instance publishes its own port and its
      // own access link (with the boot token), so:
      //   - the rollback watcher learns the port of the NEW instance instead
      //     of guessing the (random) port of the old one;
      //   - the user finds the access link of the new instance after a
      //     restart, instead of being locked out by a 401.
      publishInstanceRecord(ctx, runtime, config, origin)
    } catch {}
    // The routes of this plugin. Every one of them is remembered: the boot
    // check of the restart record reports "the routes are there" — a host
    // that came up without them is not a healthy host.
    const routes = [
      { name: 'health', route },
      { name: 'park', route: parkRoute },
      { name: 'recover', route: recoverRoute },
      { name: 'handoff', route: handoffRoute },
      { name: 'choice', route: choiceRoute },
      { name: 'cancel', route: cancelRoute },
      { name: 'manual-rollback', route: manualRollbackRoute },
      { name: 'announcements', route: announcementsRoute },
      { name: 'supervisor', route: supervisorRoute },
    ]
    if (sleepRoute !== null) routes.push({ name: 'sleep', route: sleepRoute })
    // THE SINGLE-PLUGIN RESTORE comes LAST ON PURPOSE. The order of the routes
    // above is part of what the boot check reports (and what the tests pin), so
    // a new route is APPENDED instead of being pushed into the middle of it.
    routes.push({ name: 'plugin-restore', route: pluginRestoreRoute })
    // ...and the read-only inventory the settings page reads (2026-11-01).
    routes.push({ name: 'plugin-inventory', route: pluginInventoryRoute })
    // ...and what the loaded plugins stopped providing (2026-11-01).
    routes.push({ name: 'plugin-watch', route: buildPluginWatchRoute(ctx, runtime, config) });
    // ...and the "how many copies to keep" answer, which prunes the directory
    // immediately after it is written (2026-11-02). APPENDED for the same reason
    // as the two routes above: the order of the earlier ones is pinned by tests.
    routes.push({ name: 'backup-limit', route: buildBackupLimitRoute(ctx, runtime, config) });
    // One late reading per boot; the timer is unref'ed so it never holds the
    // process open.
    // Kept LOCAL on purpose: the timer belongs to this boot and nothing else
    // needs to see it (a field on `runtime` leaked into payloads that compare it).
    schedulePluginWatch(ctx, runtime, config)
    for (const entry of routes) {
      try {
        target.effect(() => webServer.register(entry.route), 'dsh-autorestart: ' + entry.name + ' route')
        runtime.registeredRoutes.push(entry.name)
      } catch (error) {
        // A duplicate registration means another load of this plugin already owns it.
        runtime.log.warn('could not register the ' + entry.name + ' route:', String(error))
        runtime.routeErrors.push({ route: entry.name, error: String(error) })
      }
    }
    if (config.autoReloadPage !== false && typeof webServer.tapIndex === 'function') {
      try {
        target.effect(
          () => webServer.tapIndex((html) => {
            runtime.indexTaps = (runtime.indexTaps ?? 0) + 1
            return injectPageHeartbeat(html, runtime.bootId, routePath)
          }),
          'dsh-autorestart: page heartbeat',
        )
        runtime.pageHeartbeat = true
      } catch (error) {
        runtime.log.warn('could not inject the page heartbeat:', String(error))
      }
    }
    return true
  }

  if (attempt(ctx)) return
  // At boot this plugin may activate before the webserver row: retry briefly instead
  // of silently giving up (that is exactly how a boot-time 404 happened once).
  let tries = 0
  let stop
  stop = ctx.interval(() => {
    tries += 1
    if (attempt(ctx) || tries >= 30) {
      try {
        stop()
      } catch {}
    }
  }, 2000)
}

/** Wire event listeners that keep the checkpoint current. */
function trackAgents(ctx, runtime, config) {
  const log = runtime.log
  const state = runtime.state

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      // DIAGNOSTICS ONLY (2026-11-02): the label says WHERE this reset came
      // from. The call itself is in exactly the place it always was — the
      // window moves for the same events, in the same order, as before.
      runtime.noteActivity('agent-status', {
        sessionId: agent && agent.id ? String(agent.id) : null,
        isSubagent: agent && agent.id ? isRootAgent(ctx, agent) === false : false,
      })
      if (!agent || !agent.id) return
      if (!isRootAgent(ctx, agent)) return
      const now = Date.now()
      if (status === 'running') {
        const existing = sessionEntry(state, String(agent.id))
        markRunning(state, {
          sessionId: String(agent.id),
          reason: 'turn',
          goalId: existing && existing.goal ? existing.goal.goalId : undefined,
          now,
        })
      } else {
        markIdle(state, String(agent.id), { now })
      }
      runtime.persist()
    } catch (error) {
      log.warn('checkpoint update failed:', String(error))
    }
  })

  // A session event only restarts the settle window when it says that WORK
  // happened (a message, a tool, a turn). The host produces session events
  // every two to three seconds while the interface polls and synchronises —
  // counting those as activity kept the quiet window from ever filling, so a
  // restart with a grace window of ten seconds NEVER fired. When the type of
  // an event cannot be read, it is not activity: the plugin would rather
  // restart a little early than never restart at all.
  //
  // The hard guarantee is elsewhere and untouched: a conversation that is
  // really running blocks the restart through `busyAgents()`, which is never
  // relaxed.
  ctx.on('session/event', (payload) => {
    try {
      if (!isWorkSessionEvent(payload)) return
      runtime.noteActivity('session-event')
    } catch {}
  })

  ctx.on('agent/inbox/inserted', () => {
    try {
      runtime.noteActivity('inbox-inserted')
    } catch {}
  })

  ctx.on('goal/changed', ({ agent, change }) => {
    try {
      if (!agent || !agent.id || !change || !change.goal) return
      if (!isRootAgent(ctx, agent)) return
      setGoal(state, String(agent.id), {
        goalId: change.goal.id,
        goalRevision: change.goal.revision,
        phase: change.goal.phase,
        now: Date.now(),
      })
      runtime.persist()
    } catch (error) {
      log.warn('goal checkpoint update failed:', String(error))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (!agent || !agent.id) return
      if (!isRootAgent(ctx, agent)) return
      const entry = sessionEntry(state, String(agent.id))
      if (entry && entry.running) {
        // An agent that disappears mid-turn is an interruption worth resuming later.
        entry.running = false
        entry.interrupted = true
        entry.pendingResume = true
        entry.pendingSince = Date.now()
        runtime.persist()
      }
    } catch {}
  })

  // Seed the checkpoint with agents that were already running at activation (hot
  // reload or late mount), so an unexpected restart can still recover them.
  try {
    const now = Date.now()
    let seeded = 0
    for (const agent of ctx.agents.list()) {
      if (!agent || !agent.id) continue
      if (!isRootAgent(ctx, agent)) continue
      if (agent.status !== 'running') continue
      const existing = sessionEntry(state, String(agent.id))
      if (existing && (existing.pendingResume || existing.interrupted)) continue
      markRunning(state, { sessionId: String(agent.id), reason: 'turn', now })
      seeded += 1
    }
    if (seeded > 0) {
      runtime.persist()
      log.info(`seeded ${seeded} running session(s) into the checkpoint`)
    }
  } catch {}
}

/**
 * Plugin entry point.
 * @param ctx - Cordis plugin context.
 * @param rawConfig - the loader row config (merged over the built-in defaults).
 * @param {{
 *   sleepNow?: () => number,
 *   sleepSpawn?: Function,
 * }} [options] - the injectable primitives of the graceful sleep: they replace
 *   the clock and the process spawner, so the whole flow can be driven without
 *   waiting and without ever touching the machine. Production never passes them.
 */
export function apply(ctx, rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig)
  // The one-time install choice lives in the profile row config (the single
  // source of truth). Only when the row does not set the key at all does the
  // degraded fallback file get a say.
  //
  // RESOLVED FROM THE RAW CONFIG (2026-11-03): `normalizeConfig` only copies the
  // keys the plugin publishes in its defaults, so `stateFile` - a diagnostic knob
  // that is deliberately not published - was dropped before this line. The three
  // choice files were therefore always read from the DEFAULT state directory, even
  // when the caller had pointed the plugin somewhere else: a test run read and
  // rewrote the user's real directory. `rawConfig` still carries `stateFile`.
  const stateDir = resolveStateDir(rawConfig)
  const choice = resolveBackupIncludePlugins(rawConfig, stateDir)
  config.backupIncludePlugins = choice.includePlugins
  // The same rule for the pre-restart backup itself: the profile row decides,
  // the fallback file fills the gap, the built-in default applies otherwise.
  const backupChoice = resolveBackupOnRestart(rawConfig, stateDir)
  config.backupOnRestart = backupChoice.backupOnRestart
  // The same rule for the graceful-sleep button: the profile row decides, the
  // fallback file fills the gap, the built-in default applies otherwise.
  const sleepChoice = resolveShowSleepButton(rawConfig, stateDir)
  config.showSleepButton = sleepChoice.showSleepButton
  const runtime = createRuntime(ctx, config, {
    backupChoiceSource: choice.source,
  })
  const log = runtime.log
  // The graceful sleep: the host plan and the state machine that waits for the
  // conversations, counts down and switches the machine off.
  const sleep = createSleepService(ctx, runtime, config, options)

  log.info('activated', {
    stateFile: runtime.stateFile,
    isNewBoot: runtime.isNewBoot,
    phase: runtime.state.phase,
    pid: process.pid,
    desktopApp: runtime.env.isDesktopApp,
    appExePath: runtime.env.appExePath,
    configSchema: Config !== undefined,
    backupOnRestart: config.backupOnRestart,
    backupIncludePlugins: config.backupIncludePlugins,
    backupChoiceSource: choice.source,
    showSleepButton: config.showSleepButton,
    sleepChoiceSource: sleepChoice.source,
    // The FINAL plan: what the sleep feature would really do.
    sleepHost: sleep.invocation().kind,
    sleepSource: sleep.invocation().source,
    sleepSupported: sleep.invocation().supported,
  })
  if (Config === undefined) {
    log.warn('Config schema is unavailable in this build (schemastery could not be loaded); configuration still works through cordis.patch.yml and the built-in defaults')
  }

  if (!config.enabled) {
    log.info('plugin is disabled by config')
    return
  }

  // Record this boot in the checkpoint even when there is nothing to recover.
  persistSafely(runtime)

  // THE LAST STAGE OF THE RESTART: this host IS the new one, so the interface
  // says "back — carrying on". Written here (not after the recovery) so a boot
  // that finds nothing to resume still shows the end of the story instead of a
  // spinner left over from the old process.
  if (runtime.isNewBoot) {
    runtime.markRestartStage('back')
  } else {
    // The SAME process is loading the plugin again: a stage left on disk by an
    // earlier attempt ('snapshotting' / 'restarting') describes an action that is
    // not running in this process, so it is reset instead of being inherited
    // (user report, 2026-10-29: a card that never went away).
    runtime.resetStaleStage('plugin reload')
  }

  // THE FIRST-INSTALL BACKUP (user decision, 2026-10-30): a machine that has never
  // restarted has nothing a failed boot could roll back to, so a NEW host
  // process seeds one known-good copy. A reload seeds nothing, and the seed is
  // fire-and-forget: the boot path never waits for a 117 MB copy.
  void seedFirstInstallBackup(runtime, config).catch((error) => {
    log.warn('the first-install backup failed:', String(error))
  })

  // THE FILES THE OLD BUILDS LEFT BEHIND (2026-11-02). Every build before this
  // one wrote `restart-<n>-watch.ps1` on EVERY platform, and on Linux/WSL the
  // script could never run — it stayed on disk instead. A real WSL machine had
  // seven of them, which is why "leftover files = 0" was failing.
  //
  // The sweep is conservative on purpose (name + content + age, and never on
  // Windows), and it is reported rather than silent: a rescue path that deletes
  // files quietly is a worse bug than a leftover.
  let watcherHygiene = null
  try {
    watcherHygiene = sweepLegacyWatcherScripts(path.dirname(String(runtime.stateFile ?? '')), {
      platform: runtime.env.platform,
    })
  } catch (error) {
    watcherHygiene = {
      skipped: false,
      reason: null,
      removed: [],
      kept: [],
      scanned: 0,
      error: error && error.message ? String(error.message) : String(error),
    }
  }
  runtime.watcherHygiene = watcherHygiene
  // THE BACKUP DIRECTORIES THAT NEVER FINISHED (2026-11-02). The existing
  // sweeper only ran from the first-install path (new boot + snapshots on), so
  // an ordinary restart cleaned nothing and a directory left by a backup that
  // died mid-write stayed forever — a real machine had three directories while
  // the page said two copies. This one runs on EVERY boot.
  let backupHygiene = null
  try {
    backupHygiene = sweepIncompleteBackups(backupsDirFor(resolveStateDir(config)))
  } catch (error) {
    backupHygiene = {
      skipped: false,
      reason: null,
      removed: [],
      kept: [],
      scanned: 0,
      bytes: 0,
      error: error && error.message ? String(error.message) : String(error),
    }
  }
  runtime.backupHygiene = backupHygiene
  if (Array.isArray(backupHygiene.removed) && backupHygiene.removed.length > 0) {
    log.warn('removed backup directories that never finished', {
      count: backupHygiene.removed.length,
      bytes: backupHygiene.bytes,
      names: backupHygiene.removed,
    })
  }
  if (Array.isArray(watcherHygiene.removed) && watcherHygiene.removed.length > 0) {
    log.warn('removed rollback watcher scripts this platform cannot run', {
      count: watcherHygiene.removed.length,
      names: watcherHygiene.removed,
    })
  } else if (watcherHygiene.error !== null) {
    log.warn('could not sweep the old rollback watcher scripts:', watcherHygiene.error)
  }

  trackAgents(ctx, runtime, config)

  // The boot recovery pass is the plugin's primary boot duty, so it is scheduled
  // BEFORE the auxiliary timers (the health-route registration retry below): a
  // fallback registered later must never shadow or postpone the recovery pass.
  //
  // The recorded shutdown intent is restored AFTER the recovery: a shutdown
  // that was asked for before the restart must wait for the work that resumes
  // with it — the machine goes off after everything is done, not before.
  const restoreSleepIntent = () => {
    const intent = sleep.intent()
    if (!intent || intent.armed !== true) return
    log.info('the shutdown intent survived the restart; the machine goes off after the work is done', {
      armedAt: intent.armedAt,
    })
    sleep.restore()
  }
  if (runtime.isNewBoot && config.resumeOnBoot) {    runtime.recoverTimer = ctx.timeout(() => {
      recoverAfterRestart(ctx, runtime, config)
        .then(() => {
          runtime.recovery = { ran: true, ok: true, detail: 'the boot recovery finished' }
          restoreSleepIntent()
        })
        .catch((error) => {
          log.warn('boot recovery failed:', String(error))
          runtime.recovery = { ran: true, ok: false, detail: 'the boot recovery failed: ' + String(error) }
          restoreSleepIntent()
        })
        // THE VERDICT OF THE RESTART. The instance that replaced the old one
        // checks itself (listener / routes / plugin / recovery) and writes the
        // result into the durable restart record. Without this the four
        // checks would live nowhere and a failed restart would look like a
        // successful one.
        .then(() => verifyRestartBoot(runtime))
        .catch((error) => {
          log.warn('the boot verification failed:', String(error))
        })
    }, Math.max(0, config.recoveryDelayMs))
  } else {
    // No recovery pass: the intent is restored right away (a hot reload must
    // not lose it either).
    runtime.recovery = {
      ran: false,
      ok: true,
      detail: runtime.isNewBoot
        ? 'the boot recovery is switched off'
        : 'this is not a new boot',
    }
    restoreSleepIntent()
  }

  registerTools(ctx, runtime, config)
  registerManualRestartGuard(ctx, runtime, config)
  registerSystemPrompt(ctx, runtime)
  registerHealthRoute(ctx, runtime, config, sleep)

  // THE REPORTED KIND OF PLUGIN FAILURE — LOOK ONLY (user decision, 2026-11-01).
  //
  // The pass runs here on purpose: AFTER everything above is in place and BEFORE
  // the ready marker below, so the popup can show what the previous boot found.
  //
  // IT LOOKS AT THE PREVIOUS BOOT'S LOG AND WRITES THE REPORT. THAT IS ALL.
  //
  //   - it does NOT restore anything (`applyPluginRecovery` is never called from
  //     here): DSH already drops a broken entry and boots normally — measured at
  //     22 s on the desktop and 2.0–2.6 s on hosted `dsh web`, with the profile's
  //     `package.json` byte-identical and no repeated restarts under
  //     `supervise-web.sh`. An automatic restore only added a second writer into
  //     the profile at boot;
  //   - it does NOT ask for a restart (`requestRestart` is never called from
  //     here): "关就是关" — a boot never starts another boot.
  //
  // The USER decides: the popup names the plugin and its error and offers
  // "put THIS one plugin back from the last backup", which goes through
  // POST <healthPath>/plugin-restore — the only remaining writer.
  //
  // IT NEVER TOUCHES THE PROCESS-LEVEL FAILURE: a host that does not come up is
  // the snapshot + the watchdog. This is the "up, but one entry silently did
  // not activate" case only.
  if (runtime.isNewBoot) {
    try {
      // THE SOURCE: THE STARTUP LOG.
      //
      // This is the pass that always worked where the host writes a verdict (a
      // hosted `dsh web` instance does). The two in-process routes that were
      // tried on top of it — the live cordis registry and
      // `ctx.get('tools').execute('plugin_manager', …)` — are GONE (user
      // decision, 2026-11-01): the registry reports its own internals rather than
      // activation state, and the tool call is refused during boot because it
      // wants a whole execution context the plugin cannot obtain. Neither was
      // ever able to name a plugin that had not activated, so neither is missed.
      {
        const detection = detectPluginRecovery({
          stateDir: runtime.stateDir,
          backupsDir: runtime.profileDir.dir ? backupsDirFor(runtime.stateDir) : '',
          logsDir: resolveStartupLogsDir(),
          // The moment this process started: only a log written BEFORE it
          // describes a boot that finished.
          bootAt: Date.now() - Math.round((typeof process.uptime === 'function' ? process.uptime() : 0) * 1000),
          now: Date.now(),
        })
        runtime.pluginRecovery = detection
        if (detection && detection.ran === true && detection.found === true) {
          log.warn('the previous boot reported a plugin failure (nothing was changed: the popup offers a restore)', {
            log: detection.log,
            plugins: detection.failures.map((failure) => failure.plugin).filter((name) => typeof name === 'string'),
            backupKind: detection.backupKind,
            restoredAt: detection.restoredAt,
          })
        }
      }
    } catch (error) {
      // NEVER SILENT: a pass that could not run must be visible, not pretend
      // that the machine is healthy.
      runtime.pluginRecovery = {
        ran: false,
        ok: false,
        reason: 'the plugin-failure detection failed: ' + String(error && error.message ? error.message : error),
      }
      log.warn('the plugin-failure detection failed:', String(error))
    }
  }

  ctx.effect(() => () => {
    runtime.markDisposed()
    runtime.stopPolling()
    // The countdown timer belongs to the plugin: it must not survive it.
    sleep.controller.dispose()
    persistSafely(runtime)
  }, 'dsh-autorestart lifecycle')

  // The runtime is handed back so a test can look at — and drive — the very
  // object the routes use (the cancel route is decided by ITS stage). Nothing in
  // the plugin system reads this value.
  return runtime
}

export {
  readInstallChoice,
  writeInstallChoice,
}

export {
  DEFAULTS,
  normalizeConfig,
  resolveStateFile,
  resolveStateDir,
  resolveChoicePath,
  resolveSleepPath,
  resolveAnnouncementsPath,
  featureAnnouncements,
  pluginVersion,
  PLUGIN_VERSION_FALLBACK,
  SLEEP_FEATURE_VERSION,
  SUPERVISOR_FEATURE_VERSION,
}

/**
 * THE PROFILE DIRECTORY, WITHOUT THE MANIFEST (2026-11-03, t65).
 *
 * The directory is a fact of the runtime, and a test may point it at a
 * profile of its own; production never does.
 *
 * @param {{ profileDir?: string }} options
 * @returns {{ dir: string|null, source: string }}
 */
const runtimeProfileDirFor = (options) => (options && typeof options.profileDir === 'string' && options.profileDir !== ''
  ? { dir: options.profileDir, source: 'override' }
  : resolveProfileDirDetailed())

/**
 * THE PROFILE DIRECTORY FACT AND THE THREE WAYS TO IT (2026-11-03, t72/t73).
 *
 * 1. THE RUNNING HOST - it knows the directory it booted with.
 * 2. THE PERSISTED RECORD - what the last good boot wrote down.
 * 3. THE SNAPSHOT - what the copy recorded.
 *
 * The first one that works wins. When NONE of them works, the three reasons
 * are returned SEPARATELY, so the report can say what each way failed with -
 * not the same sentence three times.
 *
 * @param {{
 *   runtime?: { dir?: string, source?: string }|null,
 *   persisted?: { dir?: string, at?: number, source?: string }|null,
 *   snapshot?: string|null,
 *   exists?: (dir: string) => boolean,
 * }} options
 * @returns {{ dir: string|null, source: string, reasons: string[] }}
 */
function pickProfileDirForArm({ runtime = null, persisted = null, snapshot = null, exists = null } = {}) {
  const reasons = [];
  const existsFn = typeof exists === 'function' ? exists : () => true;
  const dirOf = (value) => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof value.dir === 'string') return value.dir.trim();
    return '';
  };

  // 1) THE RUNNING HOST.
  const runtimeDir = dirOf(runtime);
  if (runtimeDir !== '') {
    return { dir: runtimeDir, source: 'the running host', reasons: [] };
  }
  const runtimeSource = runtime && typeof runtime.source === 'string' && runtime.source.trim() !== ''
    ? runtime.source.trim()
    : 'unknown';
  reasons.push('the running host does not know the profile directory (' + runtimeSource + ')');

  // 2) THE PERSISTED RECORD. A record that points at a directory that is gone
  // is NOT silently ignored and NOT silently accepted: it is said out loud.
  const persistedDir = dirOf(persisted);
  if (persistedDir === '') {
    reasons.push('there is no persisted profile directory in the checkpoint');
  } else if (!existsFn(persistedDir)) {
    reasons.push('the persisted record points at ' + persistedDir + ', but that directory does not exist');
  } else {
    return { dir: persistedDir, source: 'the persisted record', reasons: [] };
  }

  // 3) THE SNAPSHOT.
  const snapshotDir = dirOf(snapshot);
  if (snapshotDir === '') {
    reasons.push('the snapshot does not record a profile directory');
  } else {
    return { dir: snapshotDir, source: 'the snapshot', reasons: [] };
  }

  return { dir: null, source: 'unknown', reasons };
}

/**
 * THE DSH HOME: where the profiles and the state live.
 *
 * The plugin resolves it the same way (`DSH_HOME`, otherwise `~/.dsh`).
 *
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
function dshHomeDir({ env = process.env, home = os.homedir() } = {}) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (explicit !== '') return normalizePath(explicit);
  return normalizePath(path.join(home, '.dsh'));
}

/**
 * A full path without a trailing separator.
 *
 * @param {string} target
 * @returns {string}
 */
function normalizePath(target) {
  const raw = typeof target === 'string' ? target.trim() : '';
  if (raw === '') return '';
  let resolved = path.resolve(raw);
  // "C:\" keeps its separator (it is the root), anything longer loses it.
  if (resolved.length > 3) resolved = resolved.replace(/[\\/]+$/, '');
  return resolved;
}

// THE PROFILE DIRECTORY FACT (the checkpoint keeps it).
import { readProfileDirFact, writeProfileDirFact } from './lib/checkpoint.js';
