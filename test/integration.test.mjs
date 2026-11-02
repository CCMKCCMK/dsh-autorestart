/**
 * Integration tests for the plugin entry point (`index.js`).
 *
 * These tests drive `apply()` with a fake Cordis context that mirrors the real
 * service surface the plugin touches (agents, goals, sessionController, tools,
 * timer, webServer). They assert the recovery decisions and the checkpoint side
 * effects, and that the three model-facing tools are registered with valid
 * schemas that the real registry would accept.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, detectManualRestart, normalizeConfig, planWatchdogArmCommand, PLUGIN_VERSION_FALLBACK, pluginVersion, resolveStateFile, runPluginRecovery } from '../index.js'
import { DEFAULTS } from '../index.js'
import { writeState, createEmptyState, entryFor, markPendingResume, markRunning, requestRestart, setDisarmedGoal, setGoal, setParkedGoal } from '../lib/checkpoint.js'
// THE HONESTY CHECKS (2026-11-02): sleep / scheduler / watchdog / restart /
// profile. They are cross-module by nature — each one asserts what the user is
// told when a subsystem does NOT work ("the shutdown was refused", "this check
// does not apply here", "nothing is waiting for the new host") — so they live
// next to the other integration assertions.
import { createSleepController, detectShutdownPlan, runShutdown } from '../lib/sleep.js'
import {
  probeSchedulerCapability,
  SCHEDULER_NOT_APPLICABLE,
  SCHEDULER_OK,
} from '../lib/scheduler-capability.js'
import { detectWatchdogCapabilities, pickWatchdogTier, TIERS } from '../lib/watchdog-tier.js'
import { AUTOSTART_ADVICE_KINDS, planAutostartAdvice } from '../lib/autostart-advice.js'
import { removeLeftoverProbeTasks } from '../lib/watchdog-schedule.js'
import { confirmWatcherAlive, isProcessAlive, launchDetachedWatcher } from '../lib/restart.js'
import { profileDirInfo } from '../index.js'

/** Create a temporary state-file path per test. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-it-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/**
 * The blocker entry the Host reports for a busy session.
 *
 * Every blocker says WHAT it is (`kind`) and HOW it is called (`label`): a
 * raw session id never reaches the interface.
 *
 * @param {string} sessionId
 * @param {string} reason why it blocks ('running' or 'queued')
 * @param {string|null} [label] the title of the session (null when unknown)
 */
function blocker(sessionId, reason, label = null) {
  return {
    sessionId,
    reason,
    kind: 'session',
    label,
    // No title, no name: the host never invents a generic one (a list of
    // "浼氳瘽銆佷細璇濄€佷細璇? says nothing and looks like a bug).
    name: label === null ? '' : label,
    parentTitle: null,
    parentSessionId: null,
  }
}

/**
 * Build a fake Cordis context. `services` are resolved through `ctx.get(name)`, so
 * the test can omit the optional web server or session controller.
 */
function createFakeContext({ services = {}, runningAgents = [] } = {}) {
  const tools = []
  const guards = []
  const listeners = new Map()
  const intervals = []
  const timeouts = []
  const effects = []
  const provided = new Map()

  const ctx = {
    logger: Object.assign((..._args) => undefined, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    fiber: { state: 2 },
    agents: {
      list: () => runningAgents,
      roots: () => runningAgents,
      get: (id) => runningAgents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => {
        throw new Error('goals.resume not configured for this test')
      },
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      guard: (guard) => {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    get: (name) => services[name],
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn, _label) => {
      const disposer = fn()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: (fn, ms) => {
      intervals.push({ fn, ms })
      return () => {
        const index = intervals.findIndex((entry) => entry.fn === fn)
        if (index >= 0) intervals.splice(index, 1)
      }
    },
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {
        const index = timeouts.findIndex((entry) => entry.fn === fn)
        if (index >= 0) timeouts.splice(index, 1)
      }
    },
    provide: (name, value) => {
      provided.set(name, value)
    },
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, guards, listeners, intervals, timeouts, effects, provided }
}

/** Seed a checkpoint that looks like it came from a previous host process. */
function seedPreviousBoot(file, build) {
  const state = createEmptyState(Date.now() - 60_000)
  state.bootPid = 999_999
  state.bootId = 'previous-boot'
  state.phase = 'idle'
  build(state)
  writeState(file, state)
}

/** A fake live Agent good enough for goal lookups, ids, and followup capture. */
function fakeAgent(id) {
  const followups = []
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followups,
    followup(message) {
      followups.push(message)
    },
  }
}

/** Run one recovery pass by invoking the scheduled timeout callback. */
async function runBootRecovery(fake) {
  const pending = fake.timeouts.shift()
  assert.ok(pending, 'apply() must schedule a boot-recovery timer')
  pending.fn()
  // The recovery callback is async; give its microtasks a chance to settle.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('normalizeConfig merges defaults and rejects wrong types', () => {
  const config = normalizeConfig({ recoveryDelayMs: 10, deferPolicy: 'bogus', enabled: 'no' })
  assert.equal(config.recoveryDelayMs, 10)
  assert.equal(config.deferPolicy, 'auto')
  assert.equal(config.enabled, true)
  assert.equal(config.maxSessions, 4)
  // A running conversation is never force-restarted unless this is explicitly enabled.
  assert.equal(normalizeConfig({}).forceRestartWhenBusy, false)
  assert.equal(DEFAULTS.forceRestartWhenBusy, false)
  assert.equal(normalizeConfig({ forceRestartWhenBusy: true }).forceRestartWhenBusy, true)
  assert.equal(normalizeConfig({ forceRestartWhenBusy: 'yes' }).forceRestartWhenBusy, false)
})

test('the countdown length is one of the offered choices', () => {
  // The settings page offers a dropdown, so only these five values exist.
  assert.deepEqual(DEFAULTS.sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({}).sleepCountdownSeconds, 20)
  for (const choice of [0, 10, 20, 30, 60]) {
    assert.equal(normalizeConfig({ sleepCountdownSeconds: choice }).sleepCountdownSeconds, choice)
  }
  // A profile that still carries an old value is snapped onto the nearest
  // offered one instead of breaking.
  assert.equal(normalizeConfig({ sleepCountdownSeconds: 15 }).sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: 45 }).sleepCountdownSeconds, 60)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: '20' }).sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: null }).sleepCountdownSeconds, 20)
})

test('resolveStateFile honours config and DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-test')
  try {
    assert.equal(
      resolveStateFile({ stateFile: '' }),
      path.join(process.env.DSH_HOME, 'storages', 'dsh-autorestart', 'state.json'),
    )
    const explicit = path.join(os.tmpdir(), 'explicit-state.json')
    assert.equal(resolveStateFile({ stateFile: explicit }), path.resolve(explicit))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('boot recovery re-arms a disarmed active goal instead of prompting', async () => {
  const { file } = tempStateFile('goal')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' })
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' })
    setGoal(state, 'sess-goal', { goalId: 'goal-1', goalRevision: 3, phase: 'active' })
  })

  const agent = fakeAgent('sess-goal')
  const resumeCalls = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (sessionId) => ({ agent }),
      },
    },
  })
  fake.ctx.goals.get = () => ({
    id: 'goal-1',
    revision: 3,
    phase: 'active',
    activation: 'disarmed',
    roundsStarted: 0,
    maxGoalRounds: 256,
  })
  fake.ctx.goals.resume = (target, ref) => {
    resumeCalls.push({ target, ref })
    return { id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }
  }

  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(resumeCalls.length, 1, 'the goal must be re-armed exactly once')
  assert.deepEqual(resumeCalls[0].ref, { id: 'goal-1', revision: 3 })
  assert.equal(agent.followups.length, 0, 'a re-armed goal must not also receive a continuation message')

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-goal'].pendingResume, false)
  assert.equal(state.sessions['sess-goal'].resumeAttempts, 1)
  assert.equal(state.phase, 'running')
})

test('boot recovery injects one continuation message when there is no goal', async () => {
  const { file } = tempStateFile('prompt')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-prompt', reason: 'app closed mid-turn' })
  })

  const agent = fakeAgent('sess-prompt')
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async () => ({ agent }),
      },
    },
  })

  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(agent.followups.length, 1, 'exactly one continuation message is queued')
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /continuum_resume/)
  assert.match(message.content[0].text, /app closed mid-turn/)
  assert.equal(message.source.kind, 'continuum')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.ok(Object.isFrozen(message), 'the queued message must be immutable')

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-prompt'].pendingResume, false)
})

test('a resolveAgent failure is counted and queues no continuation', async () => {
  const { file } = tempStateFile('resolve-error')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-err', reason: 'host restart' })
  })
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-err'].resumeAttempts, 1, 'a failed resume must still consume budget')
  assert.equal(state.sessions['sess-err'].pendingResume, true, 'it stays recoverable for the next boot')
})

test('boot recovery does nothing when the checkpoint has no interrupted session', async () => {
  const { file } = tempStateFile('empty')
  seedPreviousBoot(file, () => {})
  const resolved = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (id) => {
          resolved.push(id)
          return { agent: fakeAgent(id) }
        },
        prompt: async () => {
          throw new Error('must not prompt')
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)
  assert.deepEqual(resolved, [])
})

test('a session at its resume-attempt cap is skipped', async () => {
  const { file } = tempStateFile('cap')
  seedPreviousBoot(file, (state) => {
    const entry = entryFor(state, 'sess-cap')
    entry.pendingResume = true
    entry.resumeAttempts = 2
  })
  const resolved = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (id) => {
          resolved.push(id)
          return { agent: fakeAgent(id) }
        },
        prompt: async () => {
          throw new Error('must not prompt')
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, maxResumeAttempts: 2, enabled: true })
  await runBootRecovery(fake)
  assert.deepEqual(resolved, [])
})

test('completion of a second boot does not re-run recovery in the same process', async () => {
  const { file } = tempStateFile('same-boot')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const pid = state.bootPid
  assert.equal(typeof pid, 'number')
  assert.equal(fake.timeouts.length, 1, 'a fresh boot schedules one recovery pass')
  // Re-applying in the same process (hot reload) must not schedule another recovery.
  const second = createFakeContext()
  apply(second.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(second.timeouts.length, 0, 'a same-process reload must not recover again')
  const reloaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(reloaded.bootId, state.bootId)
  assert.equal(reloaded.bootPid, pid)
})

test('the lifecycle tools register with registry-acceptable definitions', () => {
  const { file } = tempStateFile('tools')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const names = fake.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'continuum_cancel_restart',
    'continuum_handoff',
    'continuum_park_goal',
    'continuum_recover_now',
    'continuum_restart',
    'continuum_status',
    'continuum_supervisor',
  ])
  for (const tool of fake.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.parameters.type, 'object')
  }
})

test('continuum_restart checkpoints the requesting session for continuation', () => {
  const { file } = tempStateFile('restart-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const result = restart.execute(
    { reason: 'load the installed plugin update' },
    { agent: { id: 'sess-restart', status: 'running' } },
  )
  assert.equal(result.accepted, true)
  assert.equal(result.willResume, true)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.phase, 'deferred')
  assert.equal(state.restart.bySessionId, 'sess-restart')
  assert.equal(state.sessions['sess-restart'].pendingResume, true)
  assert.ok(fake.intervals.length >= 1, 'the defer poller must start')
})

test('continuum_cancel_restart releases the pending continuation', () => {
  const { file } = tempStateFile('cancel-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart')
  restart.execute({ reason: 'test' }, { agent: { id: 'sess-cancel' } })
  // The default scope is "mine": the calling session withdraws its own
  // request. It was the only requester, so the restart really goes away.
  const result = cancel.execute({ reason: 'changed my mind' }, { agent: { id: 'sess-cancel' } })
  assert.equal(result.cancelled, true)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.restart, null)
  assert.equal(state.phase, 'idle')
  assert.equal(state.sessions['sess-cancel'], undefined)
})

test('continuum_status reports environment and checkpoint paths', () => {
  const { file } = tempStateFile('status-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const status = fake.tools.find((tool) => tool.name === 'continuum_status')
  const result = status.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.stateFile, file)
  assert.equal(typeof result.summary, 'string')
  assert.equal(result.pendingRestart, false)
  assert.equal(result.environment.platform, process.platform)
})

test('agent status changes are checkpointed and idle clears them', () => {
  const { file } = tempStateFile('status-events')
  const agent = fakeAgent('sess-live')
  agent.status = 'running'
  const fake = createFakeContext({ runningAgents: [agent] })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  // Activation seeds already-running agents.
  let state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-live'].running, true)

  agent.status = 'idle'
  fake.ctx.emit('agent/status', { agent, status: 'idle' })
  state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-live'], undefined)
})

test('the restart policy is registered as a global system-prompt section', () => {
  const { file } = tempStateFile('system-prompt')
  const sections = []
  const fake = createFakeContext({
    services: {
      systemPrompt: {
        section: (section) => {
          sections.push(section)
          return () => {}
        },
        getSectionOrder: (name) => {
          assert.equal(name, 'HARNESS_IDENTITY')
          return 10
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, 'dsh-autorestart:restart-policy')
  assert.equal(section.order, 11)
  assert.equal(section.interpolate, false)
  assert.match(section.text, /continuum_restart/)
  assert.match(section.text, /do NOT kill|do not kill/i)
  assert.match(section.text, /continuum_status/)
  // Discoverability must not depend on an AGENTS.md edit.
  assert.doesNotMatch(section.text, /AGENTS\.md/)
})

test('the served index gets a boot-token heartbeat for dsh web pages', () => {
  const { file } = tempStateFile('heartbeat')
  const taps = []
  const routes = []
  const fake = createFakeContext({
    services: {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
        tapIndex: (transform) => {
          taps.push(transform)
          return () => {}
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(routes.length, 14, '14 since the plugin-watch route (2026-11-01)')
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/__dsh_autorestart/health')
  assert.equal(routes[1].kind, 'exact')
  assert.equal(routes[1].path, '/__dsh_autorestart/park')
  assert.equal(routes[4].kind, 'exact')
  assert.equal(routes[4].path, '/__dsh_autorestart/choice')
  assert.equal(routes[5].kind, 'exact')
  assert.equal(routes[5].path, '/__dsh_autorestart/cancel')
  // The manual rollback sits right after the cancel route (2026-10-30).
  assert.equal(routes[6].kind, 'exact')
  assert.equal(routes[6].path, '/__dsh_autorestart/rollback-to')
  assert.equal(routes[7].kind, 'exact')
  assert.equal(routes[7].path, '/__dsh_autorestart/announcements')
  assert.equal(routes[8].kind, 'exact')
  assert.equal(routes[8].path, '/__dsh_autorestart/supervisor')
  assert.equal(routes[9].kind, 'exact')
  assert.equal(routes[9].path, '/__dsh_autorestart/rescue')
  assert.equal(routes[10].kind, 'exact')
  assert.equal(routes[10].path, '/__dsh_autorestart/sleep')
  assert.equal(taps.length, 1, 'the page gets the boot heartbeat')
  const html = taps.reduce(
    (page, tap) => tap(page),
    '<html><head></head><body>app</body></html>',
  )
  assert.match(html, /data-dsh-autorestart-heartbeat/)
  assert.match(html, /__DSH_AUTORESTART_BOOT__/)
  assert.match(html, /\/__dsh_autorestart\/health/)
  // There is no page ticket any more: the shutdown route needs no header.
  assert.ok(!html.includes('dsh-autorestart-sleep-ticket'), 'no ticket is injected into the page')
  assert.ok(!html.includes('__DSH_SLEEP_TICKET__'), 'no ticket variable is injected into the page')
  assert.ok(html.indexOf('data-dsh-autorestart-heartbeat') < html.indexOf('</head>'))
  // Idempotent: tapping the same document twice must not duplicate the script.
  assert.equal(
    taps.reduce((page, tap) => tap(page), html),
    html,
  )
})

test('autoReloadPage: false suppresses the heartbeat but keeps the health route', () => {
  const { file } = tempStateFile('no-heartbeat')
  const taps = []
  const routes = []
  const fake = createFakeContext({
    services: {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
        tapIndex: (transform) => {
          taps.push(transform)
          return () => {}
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, autoReloadPage: false })
  assert.equal(routes.length, 14, '14 since the plugin-watch route (2026-11-01)')
  assert.equal(taps.length, 0, 'without the heartbeat there is nothing to inject')
  const html = taps.length === 0 ? '<html><head></head><body>app</body></html>' : taps[0]('<html><head></head><body>app</body></html>')
  assert.doesNotMatch(html, /data-dsh-autorestart-heartbeat/, 'the heartbeat must stay off')
  assert.ok(!html.includes('dsh-autorestart-sleep-ticket'), 'there is no page ticket any more')
})

test('every exported default key is present in cordis.patch.yml (no dead knobs)', () => {
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const configBlock = patch.slice(patch.indexOf('config:'))
  for (const key of Object.keys(DEFAULTS)) {
    assert.match(configBlock, new RegExp(`\\b${key}:`), `cordis.patch.yml must document ${key}`)
  }
})

test('detectManualRestart blocks real restart attempts', () => {
  const blocked = [
    { name: 'pwsh', arguments: { command: 'taskkill /IM "DeepSeek Harness.exe" /T /F' } },
    { name: 'pwsh', arguments: { command: 'Get-Process -Name "DeepSeek Harness" | Stop-Process -Force' } },
    { name: 'pwsh', arguments: { command: 'Stop-Process -Name "DeepSeek*" -Force' } },
    { name: 'bash', arguments: { command: 'pkill -f "DeepSeek Harness"' } },
    { name: 'pwsh', arguments: { command: 'schtasks /Run /TN dsh-web' } },
    { name: 'pwsh', arguments: { command: 'Get-CimInstance Win32_Process -Filter "name=\'DeepSeek Harness.exe\'" | Invoke-CimMethod -MethodName Terminate' } },
    { name: 'run_code', arguments: { code: 'await import("node:child_process").then(m => m.execSync("taskkill /IM \\"DeepSeek Harness.exe\\" /F"))' } },
    { name: 'pwsh', arguments: { command: "Get-Process | ? {$_.ProcessName -like 'Deep*Harness*'} | Stop-Process" } },
    { name: 'bash', arguments: { command: 'pkill -f DeepSeek' } },
    { name: 'pwsh', arguments: { command: 'wmic process where name="DeepSeek Harness.exe" call terminate' } },
    { name: 'pwsh', arguments: { command: 'shutdown /r /t 0' } },
    { name: 'pwsh', arguments: { command: 'Restart-Computer -Force' } },
  ]
  for (const exec of blocked) {
    assert.ok(detectManualRestart(exec, { pid: 4242, ppid: 999 }), `must block ${exec.name}: ${JSON.stringify(exec.arguments)}`)
  }
  // Pid-targeted kills only match the live host pid / parent pid.
  assert.ok(detectManualRestart({ name: 'pwsh', arguments: { command: 'Stop-Process -Id 12345 -Force' } }, { pid: 12345, ppid: 999 }))
  assert.ok(detectManualRestart({ name: 'pwsh', arguments: { command: 'taskkill /PID 999 /F' } }, { pid: 12345, ppid: 999 }))
  // Port-targeted kills only match the port this Host actually serves.
  assert.ok(detectManualRestart({ name: 'bash', arguments: { command: 'npx kill-port 60909' } }, { pid: 4242, ppid: 999, webPort: 60909 }))
})

test('detectManualRestart leaves ordinary commands and other tools alone', () => {
  const allowed = [
    { name: 'pwsh', arguments: { command: 'echo hello' } },
    { name: 'pwsh', arguments: { command: 'git status' } },
    { name: 'pwsh', arguments: { command: 'echo taskkill is a windows command' } },
    { name: 'pwsh', arguments: { command: 'git commit -m "docs: mention taskkill in README"' } },
    { name: 'pwsh', arguments: { command: 'git commit -m "docs: note shutdown behavior"' } },
    { name: 'pwsh', arguments: { command: 'Stop-Process -Name notepad -Force' } },
    { name: 'pwsh', arguments: { command: 'shutdown --help' } },
    { name: 'pwsh', arguments: { command: 'Remove-Item ./tmp.txt' } },
    { name: 'bash', arguments: { command: 'kill -9 777' } },
    { name: 'bash', arguments: { command: 'npx kill-port 3000' } },
    { name: 'pwsh', arguments: { command: 'schtasks /Query /TN dsh-web' } },
    { name: 'write', arguments: { file_path: 'C:/x.md', content: 'taskkill /IM "DeepSeek Harness.exe" /F' } },
    { name: 'web_fetch', arguments: { url: 'https://example.com/taskkill' } },
    { name: 'read', arguments: { file_path: 'C:/notes/DeepSeek Harness.md' } },
    { name: 'continuum_restart', arguments: { reason: 'reload the plugin bundle' } },
  ]
  for (const exec of allowed) {
    assert.equal(detectManualRestart(exec, { pid: 4242, ppid: 999, webPort: 60909 }), null, `must allow ${exec.name}: ${JSON.stringify(exec.arguments)}`)
  }
})

test('the manual-restart guard is registered globally and denies with guidance', () => {
  const { file } = tempStateFile('guard')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(fake.guards.length, 1, 'one global guard is registered')
  const guard = fake.guards[0]
  const denial = guard({ name: 'pwsh', arguments: { command: 'taskkill /IM "DeepSeek Harness.exe" /T /F' } })
  assert.equal(typeof denial, 'string')
  assert.match(denial, /continuum_restart/)
  assert.match(denial, /blockManualRestart/)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'echo safe' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { file_path: 'a.txt' } }), undefined)
})

test('blockManualRestart: false disables the guard', () => {
  const { file } = tempStateFile('guard-off')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, blockManualRestart: false })
  assert.equal(fake.guards.length, 0)
})

/** Minimal Node response stand-in for the health route handler. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk);
    },
  };
}

/** A fake context whose web server records the registered routes. */
function contextWithRoutes(options = {}) {
  const routes = [];
  const fake = createFakeContext({
    ...options,
    services: {
      ...(options.services || {}),
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
    },
  });
  return { fake, routes };
}

test('the health route admits a remote peer the connection service accepts', () => {
  const { file } = tempStateFile('health-browser');
  const { fake, routes } = contextWithRoutes({
    services: {
      // The host admits this browser request: no refusal status at all.
      connection: { requestRejection: () => undefined },
    },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '203.0.113.7' } }, res);
  assert.equal(res.statusCode, 200, 'an admitted browser request must not be refused');
  assert.equal(JSON.parse(res.body).ok, true);
});

test('a remote peer that is neither loopback nor admitted keeps the refusal status', () => {
  const { file } = tempStateFile('health-refused');

  // The connection service refuses this browser request.
  const refused = contextWithRoutes({
    services: { connection: { requestRejection: () => 403 } },
  });
  apply(refused.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const a = fakeResponse();
  refused.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, a);
  assert.equal(a.statusCode, 403);
  assert.equal(a.body, '{"ok":false,"error":"loopback-only"}');

  // No connection service at all: the old loopback-only behaviour is kept.
  const bare = contextWithRoutes();
  apply(bare.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const b = fakeResponse();
  bare.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, b);
  assert.equal(b.statusCode, 403);

  // A throwing connection service must never break the route.
  const broken = contextWithRoutes({
    services: { connection: { requestRejection: () => { throw new Error('boom'); } } },
  });
  apply(broken.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const c = fakeResponse();
  broken.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, c);
  assert.equal(c.statusCode, 403);
});

test('the ?gate=1 probe refuses a restart while a conversation has queued inbox work', () => {
  const { file } = tempStateFile('gate-busy');
  const agent = fakeAgent('sess-queued');
  agent.inbox = { nextTurn: [{ id: 'm1' }], nextStep: [] };
  const { fake, routes } = contextWithRoutes({ runningAgents: [agent] });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  assert.equal(routes.length, 14, 'the health route must be registered (14 routes since the plugin-watch route)');
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.allowRestart, false);
  assert.equal(payload.gate.allow, false);
  assert.equal(payload.gate.reason, 'conversation-active');
  assert.deepEqual(payload.gate.blockedBy, [blocker('sess-queued', 'queued')]);
  assert.equal(payload.busyCount, 1);
  assert.equal(payload.agentCount, 1);
  assert.equal(typeof payload.settleMs, 'number');
});

test('the ?gate=1 probe allows the restart once every conversation is idle and quiet', () => {
  const { file } = tempStateFile('gate-idle');
  const { fake, routes } = contextWithRoutes();
  // The grace window is a different knob: this probe is about the idle gate,
  // so the extra wait is off here.
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, settleMs: 0, restartGraceMs: 0 });
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.allowRestart, true);
  assert.equal(payload.gate.reason, 'quiet');
  assert.deepEqual(payload.gate.blockedBy, []);
  assert.equal(payload.busyCount, 0);
  assert.equal(payload.settleMs, 0);
  assert.equal(payload.graceMs, 0, 'the grace window is reported');

  // The normal health payload is unchanged for non-gate requests.
  const normal = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, normal);
  const body = JSON.parse(normal.body);
  assert.equal(body.ok, true);
  assert.equal(body.plugin, 'dsh-autorestart');
  assert.equal(body.allowRestart, undefined);
});

test('the ?state=1 probe reports the pending-restart state a UI banner needs', () => {
  const { file } = tempStateFile('state-pending');
  seedPreviousBoot(file, (state) => {
    // Two sessions asked for the (coalesced) restart ...
    requestRestart(state, { reason: 'first', bySessionId: 'sess-state-a', now: Date.now() });
    requestRestart(state, { reason: 'second', bySessionId: 'sess-state-b', now: Date.now() });
    // ... and a third session is only waiting to be resumed.
    markPendingResume(state, { sessionId: 'sess-state-c', reason: 'interrupted', now: Date.now() });
  });
  const { fake, routes } = contextWithRoutes();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  assert.equal(routes.length, 14, 'the health route must be registered (14 routes since the plugin-watch route)');
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.pendingRestart, true);
  assert.ok(Array.isArray(payload.waiters));
  assert.deepEqual(
    [...payload.waiters].sort(),
    ['sess-state-a', 'sess-state-b', 'sess-state-c'],
    'every requester and every pending session is reported exactly once',
  );
  assert.equal(payload.waiters.length, 3, 'the waiters are deduplicated');
  assert.ok(payload.waiters.every((id) => typeof id === 'string'), 'the waiters are session id strings');
  assert.equal(typeof payload.settleMs, 'number');
  assert.equal(typeof payload.allowRestart, 'boolean');
  assert.equal(typeof payload.quietForMs, 'number');
  assert.ok(Array.isArray(payload.blockedBy));
  assert.equal(typeof payload.phase, 'string');
  assert.equal(typeof payload.generation, 'number');
  assert.equal(typeof payload.updatedAt, 'number');
});

test('continuum_status reports the restart gate verdict', () => {
  const { file } = tempStateFile('status-gate');
  const busy = fakeAgent('sess-status-busy');
  busy.status = 'running';
  const fake = createFakeContext({ runningAgents: [busy] });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const result = status.execute({});
  assert.equal(result.gateAllow, false);
  assert.deepEqual(result.blockedBy, [blocker('sess-status-busy', 'running')]);
  assert.equal(typeof result.quietForMs, 'number');
  const schema = status.output.schema.properties;
  assert.equal(schema.gateAllow.type, 'boolean');
  assert.equal(schema.quietForMs.type, 'number');
  assert.equal(schema.blockedBy.type, 'array');
  assert.equal(schema.blockedBy.items.properties.kind.enum.join(','), 'session,subagent,restart-pending');
  // The title fields are NULLABLE: a session whose title could not be
  // resolved reports null, and a strict schema would reject the whole tool
  // output for it. The tool schema has no type arrays, so "string or null" is
  // declared as a `oneOf`.
  assert.equal(schema.blockedBy.items.properties.label.type, undefined);
  assert.deepEqual(
    schema.blockedBy.items.properties.label.oneOf.map((branch) => branch.type).join(','),
    'string,null',
  );
  for (const key of ['label', 'parentTitle', 'parentSessionId', 'title']) {
    assert.deepEqual(
      schema.blockedBy.items.properties[key].oneOf.map((branch) => branch.type).join(','),
      'string,null',
      `${key} must accept null`,
    );
  }
});

/**
 * A fake goals service: one live goal per session, with the DISARM/resume
 * transitions of the real host. `disarm` removes the process-local continuation
 * authority without touching the durable phase or revision; `pause` is still
 * recorded so every test can prove the plugin never pauses a goal any more.
 */
function fakeGoalsService(goalsBySession, calls = { pause: [], resume: [], disarm: [] }) {
  const view = (agent) => goalsBySession[String(agent && agent.id)];
  return {
    get: (agent) => view(agent),
    disarm: (agent) => {
      if (calls.disarm) calls.disarm.push({ sessionId: String(agent && agent.id) });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      if (goal.disarmError) throw new Error(goal.disarmError);
      // Disarming leaves the durable phase AND the revision untouched.
      goal.activation = 'disarmed';
      return goal;
    },
    pause: (agent, ref) => {
      calls.pause.push({ sessionId: String(agent && agent.id), ref });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      goal.phase = 'paused';
      goal.activation = 'disarmed';
      goal.revision += 1;
      return goal;
    },
    resume: (agent, ref) => {
      calls.resume.push({ sessionId: String(agent && agent.id), ref });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      if (goal.resumeError) throw new Error(goal.resumeError);
      goal.phase = 'active';
      goal.activation = 'armed';
      goal.revision += 1;
      return goal;
    },
  };
}

/** A POST request stand-in for the park route. */
function postRequest(body, remoteAddress = '127.0.0.1') {
  const payload = JSON.stringify(body);
  const handlers = {};
  return {
    method: 'POST',
    url: '/__dsh_autorestart/park',
    socket: { remoteAddress },
    on(event, handler) {
      handlers[event] = handler;
      if (event === 'data') {
        setTimeout(() => {
          handler(payload);
          if (handlers.end) handlers.end();
        }, 0);
      }
      return this;
    },
  };
}

test('the disarm step disarms an armed goal and never pauses a goal or cancels a turn', () => {
  const { file } = tempStateFile('disarm-block');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  // Cancelling a turn would lose the running round: the plugin must never do it.
  const cancelled = [];
  fake.ctx.agents.cancel = (...args) => cancelled.push(args);
  fake.ctx.agents.interrupt = (...args) => cancelled.push(args);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const before = status.execute({});
  assert.equal(before.blockedBy.length, 1);
  assert.equal(before.blockedBy[0].reason, 'goal-active', 'an armed goal is reported as the blocker');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  const poll = fake.intervals[fake.intervals.length - 1];
  assert.ok(poll, 'the defer poller must start');
  poll.fn();

  assert.equal(calls.disarm.length, 1, 'the armed goal is disarmed exactly once');
  assert.equal(calls.pause.length, 0, 'a goal is never paused');
  assert.equal(cancelled.length, 0, 'the running turn is never cancelled');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  assert.equal(goals['sess-goal'].phase, 'active', 'disarming keeps the durable goal active');
  assert.equal(goals['sess-goal'].revision, 3, 'disarming does not bump the revision');

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].goalId, 'goal-1');
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null);
  assert.equal(state.parkedGoals, undefined, 'no legacy parked record is written');
});

test('a restart that turned parkGoals off disarms no goal', () => {
  const { file } = tempStateFile('disarm-off');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  const result = restart.execute({ reason: 'test', parkGoals: false }, { agent });
  assert.equal(result.accepted, true);
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'no goal is disarmed when parkGoals is false');
  assert.equal(goals['sess-goal'].activation, 'armed');
});

test('a goal whose round budget is spent is reported instead of disarmed', () => {  const { file } = tempStateFile('disarm-exhausted');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 10, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'an exhausted goal is never disarmed');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const after = status.execute({});
  assert.equal(after.blockedBy[0].reason, 'goal-exhausted');
});

test('a goal the user paused is not disarmed by the restart gate', () => {
  const { file } = tempStateFile('disarm-user-paused');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'a goal somebody else paused stays untouched');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  assert.equal(status.execute({}).blockedBy[0].reason, 'goal-paused');
});

test('after a boot a goal this plugin disarmed is resumed', async () => {
  const { file } = tempStateFile('disarm-resume');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 1, 'the disarmed goal is re-armed exactly once');
  assert.equal(calls.pause.length, 0, 'recovery never pauses a goal');
  assert.equal(goals['sess-goal'].activation, 'armed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the disarmed record is cleared by the resume');
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-disarmed-goal');
  assert.equal(typeof state.sessions['sess-goal'].lastRecoveryDetail, 'string');
});

test('a goal the previous pause-based build parked is resumed after the boot', async () => {
  const { file } = tempStateFile('legacy-parked-resume');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setParkedGoal(state, 'sess-goal', { goalId: 'goal-1', parkedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 1, 'the goal the previous build paused is resumed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.parkedGoals['sess-goal'].resumedAt > 0, 'the legacy record is cleared by the resume');
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-paused-goal');
});

test('a goal the user paused is NOT resumed after a boot', async () => {
  const { file } = tempStateFile('user-paused-not-resumed');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 0, 'a goal the plugin did not pause stays paused');
  assert.equal(agent.followups.length, 1, 'the session still gets the continuation message');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'prompt-continuation');
});

test('a failed resume of a disarmed goal falls back to the continuation message', async () => {
  const { file } = tempStateFile('disarm-resume-fail');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': {
      id: 'goal-1',
      revision: 5,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 2,
      maxGoalRounds: 10,
      resumeError: 'stale revision',
    },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(agent.followups.length, 1, 'the fallback continuation message is queued');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the disarmed record is kept for a later boot');
  assert.match(state.sessions['sess-goal'].lastResumeError, /stale revision/);
  assert.match(state.sessions['sess-goal'].lastRecoveryDetail, /stale revision/);
});

test('every early recovery return records an action and a detail', async () => {
  // (1) The session has no live agent (the controller reports it as gone).
  const gone = tempStateFile('early-agent-not-live');
  seedPreviousBoot(gone.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const notLive = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ error: 'session is gone' }) } },
  });
  apply(notLive.ctx, { stateFile: gone.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(notLive);
  let state = JSON.parse(fs.readFileSync(gone.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'agent-not-live');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /gone/);

  // (2) No session controller at all.
  const noController = tempStateFile('early-no-controller');
  seedPreviousBoot(noController.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const bare = createFakeContext();
  apply(bare.ctx, { stateFile: noController.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(bare);
  state = JSON.parse(fs.readFileSync(noController.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'session-controller-unavailable');
  assert.equal(typeof state.sessions['sess-early'].lastRecoveryDetail, 'string');

  // (3) The goal lookup throws: the session still gets the continuation message.
  const lookup = tempStateFile('early-goal-lookup');
  seedPreviousBoot(lookup.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-early');
  const brokenGoals = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  brokenGoals.ctx.goals = {
    get: () => {
      throw new Error('goals service exploded');
    },
    resume: () => {
      throw new Error('goals.resume must not be called');
    },
  };
  apply(brokenGoals.ctx, { stateFile: lookup.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(brokenGoals);
  assert.equal(agent.followups.length, 1, 'a failed goal lookup still makes progress');
  state = JSON.parse(fs.readFileSync(lookup.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'goal-lookup-failed');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /exploded/);

  // (4) The continuation message itself is rejected.
  const prompt = tempStateFile('early-prompt-failed');
  seedPreviousBoot(prompt.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const closed = fakeAgent('sess-early');
  closed.followup = () => {
    throw new Error('inbox closed');
  };
  const noPrompt = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent: closed }) } },
  });
  apply(noPrompt.ctx, { stateFile: prompt.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(noPrompt);
  state = JSON.parse(fs.readFileSync(prompt.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'prompt-failed');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /inbox closed/);
});

test('continuum_recover_now retries a stuck recovery', async () => {
  const { file } = tempStateFile('recover-now');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  let live = false;
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => (live ? { agent } : { error: 'not loaded yet' }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);
  let state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'agent-not-live');
  assert.equal(state.sessions['sess-goal'].pendingResume, true, 'the session stays recoverable');

  live = true;
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  assert.ok(tool, 'continuum_recover_now must be registered');
  const out = await tool.execute({});
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1, 'the pending session is retried');
  assert.equal(out.results[0].action, 'resume-disarmed-goal');
  assert.equal(goals['sess-goal'].activation, 'armed');
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-disarmed-goal');
});

test('continuum_recover_now reports a session that is not pending', async () => {
  const { file } = tempStateFile('recover-now-idle');
  const fake = createFakeContext();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  const out = await tool.execute({ sessionId: 'sess-missing' });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].sessionId, 'sess-missing');
  assert.equal(out.results[0].detail, 'no-pending-recovery');
});

test('the /recover route retries the recovery for a pending session', async () => {
  const { file } = tempStateFile('recover-route');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake, routes } = contextWithRoutes({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  // Consume the boot recovery first, so the route is the only retry path left.
  const pendingBoot = fake.timeouts.shift();
  assert.ok(pendingBoot);
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/recover');
  assert.ok(route, 'the /recover route must be registered');
  const res = fakeResponse();
  route.handler(postRequest({ sessionId: 'sess-goal' }), res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.results[0].action, 'resume-disarmed-goal');
  assert.equal(goals['sess-goal'].activation, 'armed');

  const wrongMethod = fakeResponse();
  route.handler({ method: 'GET', url: '/__dsh_autorestart/recover', socket: { remoteAddress: '127.0.0.1' } }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  const remote = fakeResponse();
  route.handler(postRequest({ sessionId: 'sess-goal' }, '203.0.113.7'), remote);
  assert.equal(remote.statusCode, 403);
});

test('a failing disarm never breaks the restart gate', () => {
  const { file } = tempStateFile('disarm-fail');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10, disarmError: 'goal is busy' },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  assert.doesNotThrow(() => fake.intervals[fake.intervals.length - 1].fn());
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const result = status.execute({});
  assert.equal(result.blockedBy.length, 1, 'the session still blocks, but the gate keeps working');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals, undefined, 'a failed disarm is not recorded');
});

test('continuum_park_goal disarms the goal of the calling session', () => {
  const { file } = tempStateFile('disarm-tool');
  const agent = fakeAgent('sess-tool');
  const goals = {
    'sess-tool': { id: 'goal-7', revision: 2, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 9 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const tool = fake.tools.find((entry) => entry.name === 'continuum_park_goal');
  const result = tool.execute({}, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.disarmed, true);
  assert.equal(result.goalId, 'goal-7');
  assert.equal(calls.disarm.length, 1);
  assert.equal(calls.pause.length, 0);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-tool'].goalId, 'goal-7');
});

test('continuum_park_goal reports a goal whose round budget is spent', () => {
  const { file } = tempStateFile('disarm-tool-exhausted');
  const agent = fakeAgent('sess-tool');
  const goals = {
    'sess-tool': { id: 'goal-7', revision: 2, phase: 'active', activation: 'armed', roundsStarted: 9, maxGoalRounds: 9 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const tool = fake.tools.find((entry) => entry.name === 'continuum_park_goal');
  const result = tool.execute({ sessionId: 'sess-tool' }, { agent });
  assert.equal(result.disarmed, false);
  assert.equal(result.reason, 'goal-exhausted');
  assert.equal(calls.disarm.length, 0);
});

test('the tools are owned by the plugin lifecycle: disposing it unregisters them', () => {
  const { file } = tempStateFile('tool-disposer');
  const fake = createFakeContext();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const names = fake.tools.map((tool) => tool.name);
  for (const name of [
    'continuum_restart',
    'continuum_status',
    'continuum_park_goal',
    'continuum_recover_now',
    'continuum_cancel_restart',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }

  // The host owns the disposer of every registration: the tools are registered
  // through ctx.effect (exactly like the HTTP routes), so they are released
  // together with the routes when the plugin is re-applied.
  assert.ok(
    fake.effects.length >= fake.tools.length,
    'every tool registration is owned by an effect, so its disposer reaches the host',
  );

  // Disposing the plugin (the host stops the fiber) releases the tools.
  for (const dispose of fake.effects) {
    if (typeof dispose === 'function') dispose();
  }
  assert.equal(fake.tools.length, 0, 'disposing the plugin unregisters the tools');
});

test('a goal that was armed again is disarmed again even when a stale record exists', () => {
  // REGRESSION: the plugin disarmed the goal before the last restart and the
  // goal was armed again afterwards (a resume), but the stale record was never
  // stamped. The old rule vetoed the disarm because of that record, so the
  // restart waited for the goal forever.
  const { file } = tempStateFile('stale-record-disarm');
  seedPreviousBoot(file, (state) => {
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();

  assert.equal(calls.disarm.length, 1, 'the armed goal is disarmed; the stale record never vetoes it');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the new disarm overwrites the record');
});

test('a goal that was resumed is disarmed again when it blocks the next restart', async () => {
  const { file } = tempStateFile('second-disarm');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  // The boot re-armed the goal, so it is armed again and blocks the next restart.
  assert.equal(calls.resume.length, 1, 'the goal is armed again after the boot');
  assert.equal(goals['sess-goal'].activation, 'armed');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();

  assert.equal(calls.disarm.length, 1, 'the resumed goal is disarmed again (the record never vetoes it)');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the new disarm overwrites the record');
  assert.equal(state.disarmedGoals['sess-goal'].goalId, 'goal-1');
});

test('a resumed goal is stamped in the record, so the status shows it as resumed', async () => {
  const { file } = tempStateFile('resume-stamp');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the resume is stamped in the record');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const reported = status.execute({}).parkedGoals.find((entry) => entry.sessionId === 'sess-goal');
  assert.equal(reported.kind, 'disarmed');
  assert.equal(reported.resumed, true, 'the status shows the goal as resumed');
});

test('the manual retry stamps the record of the goal it re-armed', async () => {
  const { file } = tempStateFile('recover-now-stamp');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  let live = false;
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => (live ? { agent } : { error: 'not loaded yet' }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  live = true;
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  const out = await tool.execute({});
  assert.equal(out.results[0].action, 'resume-disarmed-goal');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the manual retry stamps the resume too');
});

// ---------------------------------------------------------------------------
// The session controller is the only way to resume a session that is NOT live in
// this process. A real incident: it was read through the optional `ctx.get` and
// returned undefined, so every cold session reported "session-controller-unavailable"
// and was silently never resumed.
// ---------------------------------------------------------------------------

test('a controller that only exposes prompt resumes the session and admits the message', async () => {
  const { file } = tempStateFile('controller-prompt');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-cold', reason: 'turn' });
  });
  const prompts = [];
  const fake = createFakeContext({
    services: {
      sessionController: {
        prompt: async (request) => {
          prompts.push(request);
          return { accepted: true };
        },
      },
    },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(prompts.length, 1, 'prompt() is called exactly once');
  assert.equal(prompts[0].sessionId, 'sess-cold');
  assert.equal(prompts[0].mode, 'queue');
  assert.equal(typeof prompts[0].requestId, 'string', 'each call carries a fresh request id');
  assert.ok(prompts[0].content[0].text.includes('continuum_resume'), 'the continuation text is admitted');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'resume-via-prompt');
  assert.equal(state.sessions['sess-cold'].pendingResume, false, 'the session is done once the message is accepted');
});

test('a controller with neither resolveAgent nor prompt reports what is missing', async () => {
  const { file } = tempStateFile('controller-empty');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
  });
  const fake = createFakeContext({ services: { sessionController: {} } });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'session-controller-unavailable');
  assert.ok(
    state.sessions['sess-cold'].lastRecoveryDetail.includes('neither resolveAgent nor prompt'),
    'the detail names the missing methods, not just "unavailable"',
  );
  assert.equal(state.sessions['sess-cold'].pendingResume, true, 'the session stays recoverable');
});

test('the declared dependency wins over the optional lookup', async () => {
  const { file } = tempStateFile('controller-inject');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-cold');
  const prompts = [];
  const fake = createFakeContext({
    services: {
      // The optional lookup would take the prompt-only path.
      sessionController: { prompt: async (request) => { prompts.push(request); return { accepted: true }; } },
    },
  });
  // The declared dependency resolves an agent instead.
  fake.ctx.sessionController = { resolveAgent: async () => ({ agent }) };
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(prompts.length, 0, 'the optional path is not used when the dependency is present');
  assert.equal(agent.followups.length, 1, 'the continuation message goes to the resolved agent');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'goal-lookup-failed');
  assert.ok(state.sessions['sess-cold'].lastRecoveryDetail.includes('continuation message queued'));
});

test('force re-opens a session whose stale over-limit mark would otherwise skip it', async () => {
  const { file } = tempStateFile('force-recover');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-stale', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-stale', reason: 'turn' });
    // A false-positive record from the old detector: pendingResume already cleared.
    state.sessions['sess-stale'].pendingResume = false;
    state.sessions['sess-stale'].interrupted = false;
    state.sessions['sess-stale'].resumeAttempts = 2;
    state.sessions['sess-stale'].contextOverflow = {
      over: true,
      inputTokens: null,
      contextWindow: null,
      detail: 'a tool output mentioned the phrase',
      detectedAt: Date.now() - 1000,
    };
  });
  const agent = fakeAgent('sess-stale');
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  assert.ok(tool, 'continuum_recover_now must accept force');

  const before = await tool.execute({ sessionId: 'sess-stale' });
  assert.equal(before.results[0].detail, 'no-pending-recovery', 'without force the stale record still blocks it');

  const after = await tool.execute({ sessionId: 'sess-stale', force: true });
  assert.equal(after.results.length, 1);
  assert.notEqual(after.results[0].detail, 'no-pending-recovery', 'force re-opens the session');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-stale'].contextOverflow ?? null, null, 'the stale record is cleared');
  assert.equal(state.sessions['sess-stale'].resumeAttempts, 1, 'the attempt counter was reset before the retry');
  assert.equal(agent.followups.length, 1, 'the session got its continuation message');
});

// ---------------------------------------------------------------------------
// THE WATCHDOG COMMAND (2026-10-30): a resolved node, never the client exe,
// never a shell in between, and the pending marker carries `maxAttempts`.
//
// The arming code used to build the command line itself:
//   '"' + process.execPath + '" "' + script + '" --state-dir "' + stateDir + '"'
// In the desktop app `process.execPath` IS `DeepSeek Harness.exe`, so the
// one-off task started a whole second client and the watchdog never ran.
// ---------------------------------------------------------------------------

const APP_EXE = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

test('the watchdog arm command runs a REAL node, never the client executable', () => {
  const planned = planWatchdogArmCommand({
    scriptPath: 'C:\\plugin\\scripts\\watchdog.mjs',
    stateDir: 'C:\\state',
    execPath: process.execPath,
    platform: 'win32',
  })
  assert.equal(planned.ok, true, 'a real node interpreter is available in the tests')
  assert.equal(planned.file, process.execPath, 'the program of the task is the node interpreter');
  assert.notEqual(path.basename(planned.file).toLowerCase(), 'deepseek harness.exe');
  assert.deepEqual(planned.args, ['C:\\plugin\\scripts\\watchdog.mjs', '--state-dir', 'C:\\state']);
});

test('with no node interpreter the arm command REFUSES instead of falling back to the exe', () => {
  const planned = planWatchdogArmCommand({
    scriptPath: 'C:\\plugin\\scripts\\watchdog.mjs',
    stateDir: 'C:\\state',
    execPath: APP_EXE,
    platform: 'win32',
    env: { PATH: '' },
    existsSyncFn: () => false,
  })
  assert.equal(planned.ok, false, 'the desktop executable is never a stand-in for node')
  assert.equal(planned.file, '')
  assert.equal(planned.commandLine, '')
  assert.match(planned.reason, /node/)
  assert.doesNotMatch(planned.reason === '' ? 'x' : planned.reason, /^$/);
});

test('the arm command line is quoted and carries no cmd /c wrapper', () => {
  const planned = planWatchdogArmCommand({
    scriptPath: 'C:\\plugin dir\\scripts\\watchdog.mjs',
    stateDir: 'C:\\state dir',
    execPath: process.execPath,
    platform: 'win32',
  })
  assert.equal(planned.ok, true)
  assert.ok(planned.commandLine.startsWith('"'), 'the interpreter is quoted')
  assert.ok(planned.commandLine.includes('"C:\\plugin dir\\scripts\\watchdog.mjs"'), 'a path with a space stays quoted')
  assert.equal(planned.commandLine.includes('cmd /c'), false, 'no shell may sit between the task and node')
  assert.equal(planned.commandLine.includes('cmd.exe'), false, 'no shell may sit between the task and node')
  assert.equal(planned.commandLine.includes('DeepSeek Harness.exe'), false, 'the client must not appear at all')
});

test('armWatchdog no longer concatenates the command and passes {file, args} to the task', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // The old line, character for character: it must be gone.
  assert.equal(
    source.includes("'\"' + process.execPath + '\"'"),
    false,
    'the hand-built command line must be gone from the arming code',
  )
  assert.ok(source.includes('const armCommand = planWatchdogArmCommand({'), 'the arming code must call the planner')
  assert.ok(
    source.includes('command: { file: armCommand.file, args: armCommand.args }'),
    'the scheduled task must get {file, args}: the XML carries the program and the arguments separately',
  )
  assert.ok(
    source.includes('command: [armCommand.file, ...armCommand.args]'),
    'the systemd tier must get the resolved interpreter as argv[0]',
  )
  assert.ok(
    source.includes('command: armCommand.commandLine'),
    'the detached tier gets the quoted line built from the resolved interpreter',
  )
  assert.equal(
    /command:\s*watchdogCommand/.test(source),
    false,
    'no tier may use the old hand-built string',
  )
});

test('the pending marker the arming writes carries maxAttempts', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const call = source.slice(source.indexOf('const pending = buildPending({'));
  const pendingCall = call.slice(0, call.indexOf('})'))
  assert.match(pendingCall, /maxAttempts:\s*DEFAULT_MAX_ATTEMPTS/, 'the arming must not drop the bounded-attempt field')
});

test('the plugin reports the version of the package, and the health route reports the same', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginVersion(), pkg.version, 'the loaded plugin must report the package version')
  assert.equal(PLUGIN_VERSION_FALLBACK, pkg.version, 'the fallback must follow the package (a failed read must not lie)')
  // The version is NOT written down here a second time: a literal in a test is
  // a second place to forget during a release (0.8.7 bumped the package and the
  // fallback together, and this line was the only thing that disagreed). The
  // shape of the version is what matters.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the package carries a semantic version')

  // The health route is a custom route, so the version it reports is read from
  // the running plugin 鈥?the one thing a real machine can check.
  const { ctx, routes } = createRouteContext()
  apply(ctx, { stateFile: tempStateFile('health-version').file, recoveryDelayMs: 0, enabled: true })
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/health')
  assert.ok(route, 'the health route must be registered')
  const res = fakeResponse()
  route.handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, res)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const body = JSON.parse(res.body)
  assert.equal(body.version, pkg.version, 'the health route must report the package version')
});

test('the health route reports the LAST cookie cleanup, never a live count', async () => {
  const { dir, file } = tempStateFile('cookie-clear')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(typeof pkg.version, 'string')

  const { ctx, routes } = createRouteContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/health')
  assert.ok(route)

  const first = fakeResponse()
  route.handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, first)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const before = JSON.parse(first.body)
  assert.ok(before.cookieClear, 'the health route must report the cleanup state');
  assert.equal(before.cookieClear.ok, null, 'no cleanup ran yet: not a success, not a failure');
  assert.equal(before.cookieClear.live, null, 'a live count must never be reported');
  assert.match(String(before.cookieClear.liveNote), /locked/)

  // Now write the record the cleanup script would have written, and ask again.
  const { writeCookieClearReport } = await import('../lib/cookie-clear.js')
  writeCookieClearReport(dir, { at: 1_700_000_000_000, ok: true, removed: 5, reason: '' })
  const second = fakeResponse()
  route.handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, second)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const after = JSON.parse(second.body)
  assert.equal(after.cookieClear.ok, true)
  assert.equal(after.cookieClear.removed, 5, 'the number of cookies the LAST cleanup deleted')
  assert.equal(after.cookieClear.at, 1_700_000_000_000)
  assert.equal(after.cookieClear.live, null)
});

// ---------------------------------------------------------------------------
// The output schema of every tool is STRICT (`additionalProperties: false`):
// a key that is not declared is refused by the registry, so "the branch
// returns a value nobody declared" is a real break, not a cosmetic one
// (t7 finding F2: the dry run of `continuum_supervisor` returned seven
// undeclared fields).
//
// Only the READ-ONLY actions are executed here: `install` / `uninstall` /
// `apply` / `revert` register things on this machine and `continuum_restart`
// asks for a restart, so a test may not touch them.
// ---------------------------------------------------------------------------

const READ_ONLY_ACTIONS = ['status', 'plan', 'dry-run', 'derive']

test('every key a tool returns is declared in its output schema', async () => {
  const { file } = tempStateFile('tool-output-schema')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  let checked = 0
  for (const tool of fake.tools) {
    const schema = tool.output && tool.output.schema ? tool.output.schema : null
    assert.ok(schema, `${tool.name} must declare an output schema`)
    assert.equal(schema.additionalProperties, false, `${tool.name} must stay strict`)
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}

    const enumActions = tool.parameters
      && tool.parameters.properties
      && tool.parameters.properties.action
      && Array.isArray(tool.parameters.properties.action.enum)
      ? tool.parameters.properties.action.enum
      : []
    // The declared actions are the contract; the ones we may actually run are
    // the read-only ones (and only those exist on this tool today).
    const runnable = enumActions.filter((action) => READ_ONLY_ACTIONS.includes(action))
    if (runnable.length === 0) continue
    assert.ok(enumActions.length > 0)

    for (const action of runnable) {
      const value = await tool.execute({ action })
      assert.ok(value && typeof value === 'object', `${tool.name}(${action}) must answer with an object`)
      for (const key of Object.keys(value)) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(properties, key),
          `${tool.name}(${action}) returned "${key}", which its output schema does not declare`,
        )
        // A declared type must also accept the VALUE: `null` under
        // `{type:'string'}` is refused exactly like an undeclared key, so the
        // dry run omits a nullable answer instead of sending null.
        assert.notEqual(
          value[key],
          null,
          `${tool.name}(${action}).${key} must not be null (the schema declares ${JSON.stringify(properties[key])})`,
        )
      }
      checked += 1
    }
  }
  assert.ok(checked >= 3, 'the read-only actions of the supervisor tool must have been executed')
});

test('the dry run of the supervisor declares everything it returns', async () => {
  const { file } = tempStateFile('dry-run-schema')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const tool = fake.tools.find((entry) => entry.name === 'continuum_supervisor')
  assert.ok(tool, 'continuum_supervisor must be registered')
  const properties = tool.output.schema.properties

  const value = await tool.execute({ action: 'dry-run' })
  // The seven fields F2 was about: they are either declared or absent.
  for (const key of ['level', 'mode', 'command', 'plan', 'needsConfirmation', 'writes', 'compose']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, key),
        `the dry run returned "${key}" but the output schema does not declare it`,
      )
      assert.notEqual(value[key], null, `the dry run must omit "${key}" rather than send null`)
    }
  }
  for (const key of ['level', 'mode', 'plan', 'needsConfirmation']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(value, key),
      `the dry run must always carry "${key}" (it is never null)`,
    )
  }
  assert.equal(typeof value.needsConfirmation, 'boolean')
  assert.ok(Array.isArray(value.plan))
});

/** A fake Cordis context that collects the routes the plugin registers. */function createRouteContext() {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes }
}

// ---------------------------------------------------------------------------
// THE REPORTED KIND OF PLUGIN FAILURE (user decision, 2026-11-01)
//
// A plugin that fails to IMPORT does not keep the host from booting: the entry
// silently never activates. These tests drive the boot pass against a SYNTHETIC
// profile, backup and startup log, so every branch is checked without touching
// the machine, and they check the two hard rules:
//   - the restart is asked for ONLY when files really changed
//     (`no-backup` / `duplicate` / `already-consistent` / `needs-human` never
//     ask for one);
//   - <stateDir>/last-plugin-recovery.json is written with the whole report and
//     the identity of the backup it restored from.
// ---------------------------------------------------------------------------

/** Write one file, creating its directory. */
function writeAt(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/**
 * The two instants the plugin-recovery fixture owns.
 *
 * `RECOVERY_BOOT_AT` is the boot the tests pretend to be, `RECOVERY_LOG_AT` is
 * the moment the fixture's startup log DESCRIBES — and the mtime it is pinned to.
 * They are named instead of repeated so nobody can "fix" the wall-clock problem
 * by moving the boot time into the future: the log has to stay older than the
 * boot, and it does, forever.
 */
const RECOVERY_LOG_AT = Date.parse('2026-11-01T00:00:01.100Z');
const RECOVERY_BOOT_AT = Date.parse('2026-11-01T01:00:00.000Z');

/**
 * A synthetic profile + one known-good backup of it + one startup log that
 * reports `plugin` as failed, plus the state directory of the plugin.
 */
function pluginRecoveryFixture(label, { plugin = 'broken-plugin', error = 'Error: Cannot find module \'x\'', backup = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-plugin-recovery-${label}-`));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const profileDir = path.join(root, 'profile');
  writeAt(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { [plugin]: 'file:./x' } }));
  writeAt(path.join(profileDir, 'node_modules', plugin, 'package.json'), `{"name":"${plugin}","version":"2.0.0-broken"}`);
  writeAt(path.join(profileDir, 'node_modules', plugin, 'index.js'), 'export const broken = true;\n');

  const backupsDir = path.join(stateDir, 'backups');
  let backupDir = null;
  if (backup === true) {
    backupDir = path.join(backupsDir, '20261101T000000Z');
    writeAt(path.join(backupDir, 'node_modules', plugin, 'package.json'), `{"name":"${plugin}","version":"1.0.0"}`);
    writeAt(path.join(backupDir, 'node_modules', plugin, 'index.js'), 'export const good = true;\n');
    writeAt(path.join(backupDir, 'manifest.json'), JSON.stringify({ stamp: '20261101T000000Z', at: 1_761_000_000_000 }));
    writeAt(path.join(backupDir, 'meta.json'), JSON.stringify({
      kind: 'known-good',
      at: 1_761_000_000_000,
      version: '0.9.0',
      reason: 'boot-ok',
      // THE CRITERION (2026-11-01): a `known-good` KIND with no evidence is the
      // historical pollution — a stamp nobody can check. The fixture builds the
      // ordinary case (a copy whose configuration was compared with the boot that
      // ran on it), which is the only copy a recovery may restore from.
      certifiedBy: 'full-checks',
      certificationEvidence: 'fingerprint-match',
    }));
  }

  const logsDir = path.join(root, 'logs');
  const logName = 'startup-2026-11-01T00-00-00.000Z-aaaa.log';
  const logPath = path.join(logsDir, logName);
  writeAt(logPath, [
    `2026-11-01T00:00:01.000Z dsh: warning: 1 entry did not activate`,
    `2026-11-01T00:00:01.100Z - ${plugin}: failed to import: ${error}`,
  ].join('\n'));
  // THE WALL CLOCK MUST NOT DECIDE THESE TESTS.
  //
  // `findLatestStartupLog` keeps a log only when its mtime is NOT LATER than the
  // boot under test (`log.mtime <= cutoff` in lib/plugin-recover.js) — that is
  // the behaviour under test, and it stays exactly as it is. But a file written
  // by `writeAt` carries the REAL clock, while the boot time below is a fixed
  // date, so the fixture used to be green only until the calendar passed that
  // fixed moment: on 2026-11-01 the whole recovery group turned red at 09:00
  // (+08:00) although nothing in the code had changed.
  //
  // Pinning the mtime to the moment the log DESCRIBES (00:00:01.100Z — strictly
  // before every boot time the tests use) makes the fixture honest and
  // time-independent at once.
  fs.utimesSync(logPath, new Date(RECOVERY_LOG_AT), new Date(RECOVERY_LOG_AT));
  return {
    root,
    stateDir,
    profileDir,
    backupsDir,
    backupDir,
    logsDir,
    logPath,
    // The two instants the fixture guarantees: the log is pinned to one and the
    // tests boot at the other, so `logMtime < bootAt` never depends on "now".
    logMtime: RECOVERY_LOG_AT,
    bootAt: RECOVERY_BOOT_AT,
  };
}

test('the plugin-recovery fixture pins its log strictly BEFORE the boot under test', () => {
  const fixture = pluginRecoveryFixture('clock-guard');
  // The property the whole group relies on, asserted instead of assumed.
  assert.equal(fixture.logMtime < fixture.bootAt, true, 'the fixture owes a log older than the boot');
  const mtimeMs = fs.statSync(fixture.logPath).mtimeMs;
  assert.equal(
    mtimeMs < fixture.bootAt,
    true,
    'the log on disk is strictly older than the boot under test — not "now vs 09:00"',
  );
  // A small tolerance: some file systems round the mtime they store.
  assert.equal(Math.abs(mtimeMs - fixture.logMtime) < 5, true, 'the mtime really was pinned to the fixture instant');
});

test('the boot pass restores the failed plugin and writes last-plugin-recovery.json', () => {
  const fixture = pluginRecoveryFixture('restore');
  const restarts = [];
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    bootAt: Date.parse('2026-11-01T01:00:00.000Z'),
    now: Date.parse('2026-11-01T01:00:05.000Z'),
    requestRestart: (request) => {
      restarts.push(request);
      return true;
    },
  });

  assert.equal(outcome.ran, true);
  assert.equal(outcome.found, true);
  assert.equal(outcome.changed, true);
  assert.equal(restarts.length, 1, 'exactly one restart, through the existing entry');
  assert.deepEqual(restarts[0].plugins, ['broken-plugin']);

  const live = path.join(fixture.profileDir, 'node_modules', 'broken-plugin');
  assert.equal(fs.readFileSync(path.join(live, 'index.js'), 'utf8'), 'export const good = true;\n');
  const aside = fs.readdirSync(path.join(fixture.profileDir, 'node_modules'))
    .filter((name) => name.startsWith('broken-plugin.broken-'));
  assert.equal(aside.length, 1, 'the broken tree is kept as evidence');

  const reportFile = path.join(fixture.stateDir, 'last-plugin-recovery.json');
  assert.equal(fs.existsSync(reportFile), true, 'the report is written next to the checkpoint');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  for (const key of ['at', 'atIso', 'failures', 'actions', 'restartRequested', 'needsHuman']) {
    assert.ok(Object.prototype.hasOwnProperty.call(report, key), `the report must carry ${key}`);
  }
  assert.equal(report.restartRequested, true);
  assert.equal(report.needsHuman, false);
  assert.deepEqual(
    report.failures.map((failure) => failure.plugin),
    [null, 'broken-plugin'],
    'the aggregate warning and the named plugin are both reported (the warning names none)',
  );
  assert.match(report.failures[1].error, /Cannot find module/);
  assert.equal(report.actions.length, 1, 'only a named plugin can be acted on');
  assert.equal(report.actions[0].mode, 'overwrite');
  assert.equal(report.actions[0].backupKind, 'known-good', 'the identity comes from the backup meta');
  assert.equal(report.actions[0].restoredAt, 1_761_000_000_000, 'the point in time comes from the backup meta');
  assert.ok(report.actions[0].restoredFrom.includes(path.join('node_modules', 'broken-plugin')));
  assert.match(report.actions[0].evidence.renamedTo, /broken-plugin\.broken-\d{8}T\d{6}$/);

  // The bookkeeping of the cycle: one attempt, the failure handled.
  const state = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'plugin-recovery.json'), 'utf8'));
  assert.equal(state.entries[0].plugin, 'broken-plugin');
  assert.equal(state.entries[0].attempts, 1);
  assert.equal(state.handled.length, 1);
});

test('a second boot with the same old log asks for NO second restart (duplicate)', () => {
  const fixture = pluginRecoveryFixture('duplicate');
  const first = [];
  runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: (request) => {
      first.push(request);
      return true;
    },
  });
  assert.equal(first.length, 1);
  // The very same log is read again on the next boot: the fingerprint is already
  // handled, so the pass recognises it and touches nothing.
  const second = [];
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: (request) => {
      second.push(request);
      return true;
    },
  });
  assert.equal(second.length, 0, 'an already handled failure must not restart the host again');
  assert.equal(outcome.restartRequested, false);
  assert.equal(outcome.actions[0].mode, 'duplicate');
});

test('a plugin that already used its attempt asks for NO restart (needs human)', () => {
  const fixture = pluginRecoveryFixture('needs-human');
  const restarts = [];
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: (request) => {
      restarts.push(request);
      return true;
    },
    now: Date.parse('2026-11-01T02:00:00.000Z'),
  });
  assert.equal(outcome.changed, true);
  // Now the SAME plugin fails again in a NEW boot (different line => different
  // fingerprint) and the attempt budget refuses a second restore.
  const second = [];
  writeAt(fixture.logPath, [
    '2026-11-01T02:00:01.000Z - broken-plugin: failed to import: Error: still broken',
  ].join('\n'));
  const again = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    bootAt: Date.parse('2026-11-01T02:00:00.000Z'),
    requestRestart: (request) => {
      second.push(request);
      return true;
    },
    now: Date.parse('2026-11-01T03:00:00.000Z'),
  });
  assert.equal(second.length, 0, 'a plugin that already used its attempt must not restart again');
  assert.equal(again.changed, false);
  assert.equal(again.needsHuman, true);
  assert.equal(again.actions[0].mode, 'needs-human');
  assert.equal(again.report.restartRequested, false);
});

test('no known-good backup means no change and NO restart', () => {
  const fixture = pluginRecoveryFixture('no-backup', { backup: false });
  const restarts = [];
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: (request) => {
      restarts.push(request);
      return true;
    },
  });
  assert.equal(restarts.length, 0);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.restartRequested, false);
  assert.equal(outcome.actions[0].mode, 'no-backup');
  assert.equal(
    fs.readFileSync(path.join(fixture.profileDir, 'node_modules', 'broken-plugin', 'index.js'), 'utf8'),
    'export const broken = true;\n',
    'nothing is touched without a backup',
  );
});

test('an already identical plugin means no change and NO restart', () => {
  const fixture = pluginRecoveryFixture('already-consistent');
  // The live tree already IS the backup content: the restore already happened.
  fs.cpSync(
    path.join(fixture.backupDir, 'node_modules', 'broken-plugin'),
    path.join(fixture.profileDir, 'node_modules', 'broken-plugin'),
    { recursive: true, force: true },
  );
  const restarts = [];
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: (request) => {
      restarts.push(request);
      return true;
    },
  });
  assert.equal(restarts.length, 0, 'an idempotent pass must not restart the host');
  assert.equal(outcome.changed, false);
  assert.equal(outcome.actions[0].mode, 'already-consistent');
});

test('a clean previous log ends the cycle and writes no report', () => {
  const fixture = pluginRecoveryFixture('clean');
  writeAt(fixture.logPath, '2026-11-01T00:00:01.000Z dsh: listening on 127.0.0.1:57283');
  writeAt(path.join(fixture.stateDir, 'plugin-recovery.json'), JSON.stringify({
    version: 1,
    entries: [{ plugin: 'broken-plugin', attempts: 1, firstAt: 1, lastAt: 1, restartedAt: 1 }],
    handled: [{ fingerprint: 'abc', plugin: 'broken-plugin', at: 1 }],
  }));
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    logPath: fixture.logPath,
    requestRestart: () => {
      throw new Error('a clean boot must not restart');
    },
  });
  assert.equal(outcome.found, false);
  assert.equal(outcome.reset.reset, true);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'plugin-recovery.json'), 'utf8'));
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.handled, []);
  assert.equal(fs.existsSync(path.join(fixture.stateDir, 'last-plugin-recovery.json')), false);
});

test('the pass only reads a log of an EARLIER boot', () => {
  const fixture = pluginRecoveryFixture('previous-boot');
  // The log was written by THIS boot: its verdict cannot be trusted yet.
  fs.utimesSync(fixture.logPath, new Date('2026-11-01T01:00:04Z'), new Date('2026-11-01T01:00:04Z'));
  const outcome = runPluginRecovery({
    stateDir: fixture.stateDir,
    profileDir: fixture.profileDir,
    backupsDir: fixture.backupsDir,
    logsDir: fixture.logsDir,
    bootAt: Date.parse('2026-11-01T01:00:00.000Z'),
    requestRestart: () => {
      throw new Error('the log of this very boot must not restore anything');
    },
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason.includes('no finished boot log'), true);
});

test('health reports pluginRecovery, and the field is declared in the tool schema', () => {
  const { dir, file } = tempStateFile('plugin-recovery-health');
  const { ctx, routes } = createRouteContext();
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/health');
  assert.ok(route, 'the health route must be registered');

  // Nothing happened yet: the field exists and says so.
  const before = fakeResponse();
  route.handler({ url: '/__dsh_autorestart/health' }, before);
  const emptyBody = JSON.parse(before.body);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyBody, 'pluginRecovery'), true);
  assert.equal(emptyBody.pluginRecovery, null);

  // A report of the boot pass is what the route reports.
  // NOTE: the timestamp must be from THIS boot. A report written before this
  // process started is now treated as stale and answered with null (see the
  // "a stale report is not shown" test below) — so the fixture carries a
  // current `at` while every assertion below stays exactly as strict.
  const reportAt = Date.now();
  const report = {
    at: reportAt,
    atIso: new Date(reportAt).toISOString(),
    log: '/tmp/startup-2026-11-01T00-00-00.000Z-aaaa.log',
    backupDir: '/tmp/backups/20261101T000000Z',
    backupKind: 'known-good',
    restoredAt: 1_761_000_000_000,
    failures: [{ plugin: 'broken-plugin', error: "Error: Cannot find module 'x'", at: 1_761_000_800_000, kind: 'failed-to-import', fingerprint: 'f00' }],
    actions: [{ plugin: 'broken-plugin', mode: 'overwrite', restoredFrom: '/tmp/backups/20261101T000000Z/node_modules/broken-plugin', restoredAt: 1_761_000_000_000, backupKind: 'known-good', evidence: { renamedFrom: '/p/node_modules/broken-plugin', renamedTo: '/p/node_modules/broken-plugin.broken-20261101T010000' }, applied: true, changed: true, needsHuman: false, reason: '' }],
    restartRequested: true,
    needsHuman: false,
    changed: true,
  };
  writeAt(path.join(dir, 'last-plugin-recovery.json'), JSON.stringify(report, null, 2));

  const after = fakeResponse();
  route.handler({ url: '/__dsh_autorestart/health' }, after);
  const body = JSON.parse(after.body);
  assert.equal(body.pluginRecovery.at, reportAt);
  assert.equal(body.pluginRecovery.failures[0].plugin, 'broken-plugin');
  assert.equal(body.pluginRecovery.actions[0].mode, 'overwrite');
  assert.equal(body.pluginRecovery.restoredAt, 1_761_000_000_000);
  assert.equal(body.pluginRecovery.backupKind, 'known-good');
});

test('a STALE recovery report is not shown: one written before this boot answers null', () => {
  const { dir, file } = tempStateFile('plugin-recovery-stale');
  const { ctx, routes } = createRouteContext();
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/health');
  assert.ok(route, 'the health route must be registered');

  // THE REAL-MACHINE CASE (2026-11-01): `last-plugin-recovery.json` was left
  // behind by an EARLIER boot and carried 188 fake failures. Nothing overwrote
  // it — the boot pass writes nothing when it finds nothing — so without this
  // rule the popup keeps offering to "restore" healthy plugins forever.
  const staleAt = Date.now() - 60 * 60 * 1000;
  writeAt(path.join(dir, 'last-plugin-recovery.json'), JSON.stringify({
    at: staleAt,
    atIso: new Date(staleAt).toISOString(),
    failures: [{ plugin: 'timeout-policy', error: '' }],
    actions: [],
    restartRequested: false,
    needsHuman: false,
  }, null, 2));

  const after = fakeResponse();
  route.handler({ url: '/__dsh_autorestart/health' }, after);
  const body = JSON.parse(after.body);
  // The FIELD is still present — the interface must be able to tell "no
  // incident" from "the field is missing" — it just answers null.
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'pluginRecovery'), true);
  assert.equal(body.pluginRecovery, null, 'a report from before this boot is stale');
});

test('continuum_status carries pluginRecovery and declares it in the output schema', () => {
  const { dir, file } = tempStateFile('plugin-recovery-status');
  const fake = createFakeContext();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  assert.ok(status);
  const declared = status.output.schema.properties.pluginRecovery;
  assert.ok(declared, 'the strict output schema must declare pluginRecovery');
  assert.equal(declared.type, 'object');
  // Never null: the key is OMITTED when there is nothing to report.
  assert.equal(Object.prototype.hasOwnProperty.call(status.execute({}), 'pluginRecovery'), false);

  // Same rule as above: the report must belong to THIS boot, so `at` is current.
  // Every assertion below is unchanged in strength.
  const reportAt = Date.now();
  writeAt(path.join(dir, 'last-plugin-recovery.json'), JSON.stringify({
    at: reportAt,
    atIso: new Date(reportAt).toISOString(),
    failures: [{ plugin: 'broken-plugin', error: 'boom' }],
    actions: [{ plugin: 'broken-plugin', mode: 'overwrite', restoredAt: 1_761_000_000_000, backupKind: 'known-good' }],
    restartRequested: true,
    needsHuman: false,
  }, null, 2));

  const value = status.execute({});
  assert.ok(value.pluginRecovery, 'the tool must report the last recovery');
  assert.equal(value.pluginRecovery.failures[0].plugin, 'broken-plugin');
  assert.equal(value.pluginRecovery.restartRequested, true);
  for (const key of Object.keys(value)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(status.output.schema.properties, key),
      `continuum_status returned "${key}" which its schema does not declare`,
    );
  }
});

test('apply() runs the boot pass and records its outcome on the runtime', () => {
  const { file } = tempStateFile('plugin-recovery-wiring');
  const fake = createFakeContext();
  const runtime = apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  assert.ok(runtime.pluginRecovery && typeof runtime.pluginRecovery === 'object', 'the pass must run at boot');
  assert.equal(typeof runtime.pluginRecovery.ran, 'boolean');
});

/* ------------------------------------------------------------------ *
 * THE «IT WAS LYING» CASES (2026-11-02).
 *
 * Every test below asserts the FAILING branch first: what the user is told when
 * the subsystem does NOT work. Nothing here spawns a real shutdown, creates a
 * real task or touches a real systemd unit — every system call is injected.
 * ------------------------------------------------------------------ */

/** A child-process double that emits the events the code listens to. */
function honestChild(events) {
  return {
    pid: 4242,
    unref() {},
    on(event, handler) {
      const args = events[event];
      if (!args) return;
      setTimeout(() => handler(...args), 0);
    },
  };
}

const HONEST_SHUTDOWN_PLAN = { command: 'shutdown.exe', args: ['/s'], fallbacks: [] };

// (1) THE SHUTDOWN IS JUDGED BY ITS EXIT CODE.

test('a shutdown the system REFUSED is a failure, not "shutting down"', async () => {
  const result = await runShutdown(HONEST_SHUTDOWN_PLAN, {
    spawn: () => honestChild({ spawn: [], exit: [1], close: [1] }),
    exitTimeoutMs: 50,
  });
  assert.equal(result.ok, false, 'a refused shutdown is never "ok"');
  assert.equal(result.executed, false, 'the machine is still on, so nothing was executed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.exited, true);
  assert.match(result.error, /shutdown-refused/);
  assert.match(result.error, /code 1/, 'the code is in the sentence the user reads');
});

test('a shutdown that exits 0 is confirmed, and carries the code', async () => {
  const result = await runShutdown(HONEST_SHUTDOWN_PLAN, {
    spawn: () => honestChild({ spawn: [], exit: [0], close: [0] }),
    exitTimeoutMs: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.exited, true);
});

test('a shutdown command killed by a signal is refused too, and says so', async () => {
  const result = await runShutdown(HONEST_SHUTDOWN_PLAN, {
    spawn: () => honestChild({ spawn: [], exit: [null, 'SIGTERM'], close: [null, 'SIGTERM'] }),
    exitTimeoutMs: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.match(result.error, /shutdown-refused/);
  assert.match(result.error, /SIGTERM/);
});

test('a command still running when the wait runs out is "started", not "confirmed"', async () => {
  const result = await runShutdown(HONEST_SHUTDOWN_PLAN, {
    spawn: () => honestChild({ spawn: [] }),
    exitTimeoutMs: 20,
  });
  assert.equal(result.ok, true, 'it really did start');
  assert.equal(result.executed, true);
  assert.equal(result.stillRunning, true);
  assert.equal(result.exited, false, 'the exit code was never seen — the answer says so');
});

test('the next fallback is tried when the main command is refused', async () => {
  const attempts = [];
  const plan = {
    command: 'systemctl',
    args: ['poweroff'],
    fallbacks: [{ command: 'shutdown', args: ['-h', 'now'] }],
  };
  const result = await runShutdown(plan, {
    exitTimeoutMs: 50,
    spawn: (command) => {
      attempts.push(command);
      return command === 'systemctl'
        ? honestChild({ spawn: [], exit: [1], close: [1] })
        : honestChild({ spawn: [], exit: [0], close: [0] });
    },
  });
  assert.deepEqual(attempts, ['systemctl', 'shutdown']);
  assert.equal(result.ok, true);
  assert.equal(result.command, 'shutdown', 'the command that really worked is the one reported');
});

test('the state says "the system refused the shutdown" and goes back to idle', () => {
  const controller = createSleepController({
    now: () => 1000,
    busyAgents: () => [],
    gate: () => ({ allow: true, blockedBy: [] }),
    titleOf: () => undefined,
    countdownSeconds: 0,
    supported: true,
    shutdown: () => ({
      ok: false,
      at: '2026-11-02T00:00:00.000Z',
      command: 'shutdown.exe',
      args: ['/s'],
      executed: false,
      pid: 4242,
      error: 'shutdown-refused: the command exited with code 1',
      exitCode: 1,
      exited: true,
    }),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  controller.arm();
  const status = controller.tick();
  assert.equal(status.phase, 'idle', 'the machine did not go off, so nothing may keep saying "shutting down"');
  assert.equal(status.armed, false);
  assert.match(status.message, /关机被系统拒绝/);
  assert.match(status.message, /code 1/);
  assert.equal(status.lastRun.exitCode, 1, 'the exit code travels with the answer');
  controller.dispose();
});

// (2) THE SCHEDULER PROBE ON A NON-WINDOWS MACHINE.

test('the scheduler probe on POSIX is "not applicable", never "ok"', () => {
  const result = probeSchedulerCapability({
    platform: 'linux',
    exec: () => {
      throw new Error('exec must not be called off Windows');
    },
  });
  assert.equal(result.scheduler, SCHEDULER_NOT_APPLICABLE);
  assert.notEqual(result.scheduler, SCHEDULER_OK, 'a check that never ran may not carry the green tick');
  assert.equal(result.applicable, false);
  assert.match(result.reason, /not applicable/);
});

test('"not applicable" is never evidence for the Windows tier', () => {
  const none = pickWatchdogTier({ platform: 'linux' });
  assert.equal(none.tier, TIERS.NONE);
  assert.match(none.reason, /neither schedule a task nor detach/);
});

// (3) setsid IS PROBED BY RUNNING IT.

test('canDetach runs `setsid true` instead of asking for --version', () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    // BusyBox behaviour: `--version` is not supported, `true` works.
    if (file === 'setsid' && args[0] === '--version') return { ok: false, stdout: '', error: 'unrecognized option' };
    return { ok: true, stdout: '', error: null };
  };
  const caps = detectWatchdogCapabilities({ platform: 'linux', exec });
  assert.equal(caps.canDetach, true, '`setsid true` is the question that matters');
  assert.deepEqual(calls.find((entry) => entry[0] === 'setsid'), ['setsid', 'true']);
});

test('a machine whose setsid really fails has no detach tier', () => {
  const caps = detectWatchdogCapabilities({ platform: 'linux', exec: () => ({ ok: false, stdout: '', error: 'nope' }) });
  assert.equal(caps.canDetach, false);
  assert.equal(pickWatchdogTier({ platform: 'linux', canDetach: false }).tier, TIERS.NONE);
});

// (4) THE ADVICE MUST MATCH WHAT CAN BE INSTALLED.

test('Linux without systemd is NOT promised a systemd user service', () => {
  const advice = planAutostartAdvice({
    host: { kind: 'linux' },
    platform: 'linux',
    hasSystemd: false,
    user: 'tester',
  });
  assert.equal(advice.kind, AUTOSTART_ADVICE_KINDS.LINUX_NO_SYSTEMD);
  assert.equal(advice.canInstall, false, 'nothing can be installed without systemd');
  assert.match(advice.reason, /没有 systemd/);
  assert.ok(!advice.notes.some((line) => line.includes('systemd 用户服务')), 'the promise is gone');
  assert.ok(advice.notes.some((line) => line.includes('rc.local')), 'and the alternative is named');
  assert.deepEqual(advice.commands, [], 'no copy-paste command for an install that cannot happen');
});

test('Linux WITH systemd still gets the user service and the linger', () => {
  const advice = planAutostartAdvice({
    host: { kind: 'linux' },
    platform: 'linux',
    hasSystemd: true,
    user: 'tester',
  });
  assert.equal(advice.kind, AUTOSTART_ADVICE_KINDS.LINUX);
  assert.equal(advice.canInstall, true);
  assert.ok(advice.commands.some((line) => line.includes('enable-linger tester')));
});

// (5) THE PROBE CLEANUP IS SKIPPED OFF WINDOWS.

test('the probe-task cleanup is skipped off Windows and calls no schtasks', () => {
  const calls = [];
  const result = removeLeftoverProbeTasks({
    platform: 'linux',
    exec: (file, args) => {
      calls.push([file, ...args]);
      return { ok: false, stdout: '', error: 'schtasks: not found' };
    },
  });
  assert.deepEqual(calls, [], 'no fake fault may be produced on a machine without schtasks');
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not-applicable/);
  assert.equal(result.error, null, 'and it is not reported as an error');
});

test('on Windows the cleanup still runs (and a refusal is reported)', () => {
  const calls = [];
  const result = removeLeftoverProbeTasks({
    platform: 'win32',
    exec: (file, args) => {
      calls.push([file, ...args]);
      return { ok: false, stdout: '', error: 'access denied' };
    },
  });
  assert.equal(result.skipped, false);
  assert.ok(calls.some((entry) => entry[0] === 'schtasks' && entry.includes('/Query')));
  assert.equal(result.ok, false);
  assert.match(result.error, /access denied/);
});

// (6) SOMEBODY HAS TO BE WAITING.

test('a watcher pid that is gone right after its start is NOT confirmed', async () => {
  const dead = await confirmWatcherAlive({ pid: 4242, waitMs: 0, isAlive: () => false });
  assert.equal(dead.confirmed, false);
  assert.equal(dead.alive, false);
  assert.match(dead.reason, /gone/);

  const alive = await confirmWatcherAlive({ pid: 4242, waitMs: 0, isAlive: () => true });
  assert.equal(alive.confirmed, true);
});

test('no pid means no confirmation (never a silent "armed")', async () => {
  const check = await confirmWatcherAlive({ pid: null, waitMs: 0 });
  assert.equal(check.confirmed, false);
  assert.match(check.reason, /no pid/);
});

test('isProcessAlive is honest about a pid that does not exist', () => {
  assert.equal(isProcessAlive(process.pid), true, 'the test process itself is alive');
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(-1), false);
});

test('a POSIX watcher launch reports its pid, and says whether that proves anything', () => {
  const launched = launchDetachedWatcher({
    watchScriptPath: '/tmp/watch.ps1',
    platform: 'linux',
    spawnFn: () => ({ pid: 777, unref() {}, on() {} }),
  });
  assert.equal(launched.ok, true);
  assert.equal(launched.method, 'spawn');
  assert.equal(launched.pid, 777, 'the pid is what the caller confirms');
  // A launcher that cannot report a pid is a failure, not a success.
  const failed = launchDetachedWatcher({
    watchScriptPath: '/tmp/watch.ps1',
    platform: 'linux',
    spawnFn: () => ({ unref() {}, on() {} }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /could not be started/);
});

// (7) A CONTAINER IS NOT A LINUX MACHINE THAT CAN BE SWITCHED OFF.

test('a container gets "no reliable way to switch this machine off"', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
    readFile: () => 'Linux version 6.6.0',
    exists: (file) => file === '/run/.containerenv',
  });
  assert.equal(plan.kind, 'container');
  assert.equal(plan.command, null, 'nothing may be executed here');
  assert.equal(plan.label, '这台机器没有可靠的关机方式');
  assert.match(plan.reason, /container/);
});

test('a docker marker is enough too, and the run itself refuses to execute', async () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => 'Linux version 6.6.0',
    exists: (file) => file === '/.dockerenv',
  });
  assert.equal(plan.kind, 'container');
  const run = await runShutdown(plan, {
    spawn: () => {
      throw new Error('nothing may be spawned for a container');
    },
  });
  assert.equal(run.ok, false);
  assert.equal(run.executed, false);
  assert.equal(run.error, 'no-shutdown-command');
});

test('a plain Linux still gets the real shutdown plan', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => 'Linux version 6.6.0',
    exists: () => false,
  });
  assert.equal(plan.kind, 'linux');
  assert.equal(plan.command, 'systemctl');
  assert.equal(plan.label, '关闭这台 Linux 主机');
});

// (8) THE HEALTH PAYLOAD CAN SAY WHICH PROFILE (and why it cannot).

test('profileDirInfo tells "several profiles" apart from "no profile"', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-info-'));
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  };
  try {
    delete process.env.DSH_PROFILE;
    delete process.env.DSH_PROFILE_DIR;
    process.env.DSH_HOME = home;
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });

    // (a) NOTHING lists this plugin.
    const none = profileDirInfo();
    assert.equal(none.profile, null);
    assert.equal(none.profileDirSource, 'unknown');
    assert.equal(none.profileCandidates, 0);

    // (b) EXACTLY ONE profile lists it.
    const one = path.join(home, 'profiles', 'solo');
    fs.mkdirSync(one, { recursive: true });
    fs.writeFileSync(path.join(one, 'package.json'), JSON.stringify({
      name: 'solo',
      dsh: { profile: { bundles: ['dsh-autorestart'] } },
    }), 'utf8');
    const single = profileDirInfo();
    assert.equal(single.profile, one);
    assert.equal(single.profileDirSource, 'profile bundles scan');
    assert.equal(single.profileCandidates, 1);

    // (c) TWO profiles list it: nothing is picked, and the reason is explicit.
    const second = path.join(home, 'profiles', 'second');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({
      name: 'second',
      dsh: { profile: { bundles: ['dsh-autorestart'] } },
    }), 'utf8');
    const ambiguous = profileDirInfo();
    assert.equal(ambiguous.profile, null, 'guessing between two profiles is not allowed');
    assert.equal(ambiguous.profileDirSource, 'ambiguous');
    assert.equal(ambiguous.profileCandidates, 2);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
});

/* ------------------------------------------------------------------ *
 * THE GOAL IS TAKEN AWAY WHILE THE RESTART WAITS (2026-11-02).
 *
 * Real reading (`restart-gate.json`): a restart asked for by a goal-driven
 * session waited 39 minutes with `attempts: 0`. The gate was fine — it allowed
 * the restart 12.4 s after the root session really stopped. The deadlock was the
 * goal round driver: it starts the next round a few seconds after the last one
 * ended, so the 10 s settle window never filled.
 *
 * The fix: disarm WHEN THE REQUEST IS QUEUED, and give the goal back if the
 * request is withdrawn.
 * ------------------------------------------------------------------ */

/** An isolated state file plus a context whose goals service records calls. */
function queuedRestartFixture(label, { grantGoal = true } = {}) {
  const { file } = tempStateFile(label);
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = grantGoal
    ? { 'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 } }
    : {};
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  return { file, agent, goals, calls, fake };
}

test('a queued restart disarms the requester goal AT ONCE — before the gate runs', () => {
  const { file, agent, goals, calls, fake } = queuedRestartFixture('queue-disarm-now');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });

  // NO POLL IS RUN: the request alone is enough. That is the whole point — the
  // goal driver must not get the chance to start round N+1 while we wait.
  assert.equal(calls.disarm.length, 1, 'the goal is disarmed when the request is QUEUED, not when the gate opens');
  assert.equal(goals['sess-goal'].activation, 'disarmed', 'no new round can start');
  assert.equal(goals['sess-goal'].phase, 'active', 'the durable goal itself is untouched');
  assert.equal(goals['sess-goal'].revision, 3, 'and its revision is not bumped');
  assert.equal(calls.pause.length, 0, 'nothing is paused');

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].goalId, 'goal-1');
  assert.equal(
    state.disarmedGoals['sess-goal'].reason,
    'restart-queued',
    'the record says WHY the goal is disarmed (a rescue and a restart must not look the same)',
  );
  assert.equal(typeof state.disarmedGoals['sess-goal'].disarmedAt, 'number', 'and WHEN');
});

test('a session WITHOUT a goal is untouched by the queued restart', () => {
  const { file, agent, calls, fake } = queuedRestartFixture('queue-disarm-no-goal', { grantGoal: false });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  const result = restart.execute({ reason: 'test' }, { agent });

  assert.equal(result.accepted, true, 'the restart is queued all the same');
  assert.equal(calls.disarm.length, 0, 'goals.disarm is never called for a session that has no goal');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(
    state.disarmedGoals === undefined || Object.keys(state.disarmedGoals).length === 0,
    true,
    'and no goal record is written',
  );
  assert.notEqual(state.restart, null, 'the request is still pending');
});

test('withdrawing the restart gives the goal back AT ONCE', () => {
  const { file, agent, goals, calls, fake } = queuedRestartFixture('queue-rearm-cancel');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  assert.equal(goals['sess-goal'].activation, 'disarmed', 'the request took the goal away');
  assert.equal(calls.resume.length, 0, 'nothing was re-armed yet');

  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart');
  const cancelled = cancel.execute({ scope: 'all' }, { agent });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true, 'the request is really gone');

  assert.equal(calls.resume.length, 1, 'the goal is re-armed by the withdrawal itself, not at the next boot');
  assert.equal(goals['sess-goal'].activation, 'armed', 'the session can start its next round again');
  assert.equal(goals['sess-goal'].phase, 'active');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof state.disarmedGoals['sess-goal'].resumedAt, 'number', 'the record says it is resumed');
});

test('a restart that turned parkGoals off still disarms nothing (and re-arms nothing)', () => {
  const { agent, goals, calls, fake } = queuedRestartFixture('queue-disarm-off');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test', parkGoals: false }, { agent });
  assert.equal(calls.disarm.length, 0, 'parkGoals:false still means "do not touch goals"');
  assert.equal(goals['sess-goal'].activation, 'armed');

  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart');
  cancel.execute({ scope: 'all' }, { agent });
  assert.equal(calls.resume.length, 0, 'and nothing is re-armed that was never disarmed');
});
