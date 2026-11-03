/**
 * THE OUTPUT SCHEMA OF EVERY TOOL IS STRICT — so "the answer is richer than
 * the schema" is not a cosmetic problem, it is a broken tool.
 *
 * The Host validates the value `execute()` returns against `output.schema`.
 * That schema is strict (`additionalProperties: false`): ONE key the schema
 * does not name makes the WHOLE answer invalid, and the caller gets
 *
 *   tool "continuum_restart" returned invalid output:
 *   "value.restartRequest" is not a declared property (additionalProperties: false)
 *
 * while the action itself has ALREADY HAPPENED. That is the dangerous shape of
 * this bug, worse than a plain failure: "invalid output" reads as "the restart
 * did not happen", so the agent retries, or works around the plugin by killing
 * the app — for a restart that went through minutes ago.
 *
 * This file is the ONE generic defense: for every tool it drives `execute()`
 * and checks the returned value against the declared schema with the same rules
 * the Host uses (types, `required`, `additionalProperties: false`, `oneOf`).
 * Adding a field to an answer without adding it to the schema now fails here.
 *
 * ESM only, Node builtins only. The real runtime is used wherever a call is
 * safe (it produces the REAL shapes, not a fixture that agrees with itself);
 * a stub runtime covers the branches that would touch the machine.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildLifecycleTools, createRuntime, normalizeConfig } from '../index.js'

/** The value types the Host's output validator knows. */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Validate `value` against one schema node, exactly like the Host does.
 *
 * The rules reproduced here are the ones that can break a tool: the type of
 * every declared property, the `required` list, `additionalProperties: false`
 * (the rule this whole file exists for), array `items`, and `oneOf` (which is
 * how this dialect spells "object or null" — there are no type arrays).
 *
 * @param {object} schema one schema node.
 * @param {unknown} value the candidate value.
 * @param {string} at the path, for the message.
 * @returns {string[]} every violation; an empty array means "valid".
 */
function violationsOf(schema, value, at) {
  const violations = []
  if (!schema || typeof schema !== 'object') return violations

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((branch) => violationsOf(branch, value, at).length === 0).length
    if (matched !== 1) violations.push(`"${at}" must match exactly one oneOf branch (matched ${matched})`)
    return violations
  }

  const type = schema.type
  if (type === undefined) return violations
  if (!SCHEMA_TYPES.has(type)) {
    violations.push(`"${at}" declares the unsupported type "${String(type)}"`)
    return violations
  }

  if (type === 'null') {
    if (value !== null) violations.push(`"${at}" must be null`)
    return violations
  }

  if (type === 'object') {
    if (!isPlainObject(value)) {
      violations.push(`"${at}" must be an object`)
      return violations
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${at}.${key}"`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      violations.push(...violationsOf(child, value[key], `${at}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          violations.push(`"${at}.${key}" is not a declared property (additionalProperties: false)`)
        }
      }
    }
    return violations
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`"${at}" must be an array`)
      return violations
    }
    const items = schema.items
    if (items === undefined) return violations
    for (const [index, entry] of value.entries()) violations.push(...violationsOf(items, entry, `${at}[${index}]`))
    return violations
  }

  if (type === 'string') {
    if (typeof value !== 'string') violations.push(`"${at}" must be a string`)
    return violations
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`"${at}" must be a finite number`)
    return violations
  }
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`"${at}" must be an integer`)
    return violations
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(`"${at}" must be a boolean`)
    return violations
  }
  return violations
}

/**
 * Assert that one tool's answer passes its own output schema.
 *
 * The value is JSON round-tripped first: that is what the Host validates (a
 * `undefined` field never reaches it; a `null` one does, and must be allowed by
 * the schema).
 *
 * @param {object} tool the tool definition.
 * @param {unknown} answer what `execute()` returned.
 * @param {string} where which call produced it.
 */
function assertAnswerFits(tool, answer, where) {
  assert.ok(tool && tool.output && tool.output.schema, `${tool && tool.name}: the tool declares no output schema`)
  const seen = JSON.parse(JSON.stringify(answer))
  const violations = violationsOf(tool.output.schema, seen, 'value')
  assert.deepEqual(
    violations,
    [],
    `${where}: the answer of "${tool.name}" does not fit its own strict output schema — the Host would refuse the whole\n`
      + `answer (and the action behind it has already happened):\n  - ${violations.join('\n  - ')}`,
  )
}

/** A fake Cordis context: enough for the runtime to exist and to stay quiet. */
function fakeContext() {
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, disarm: () => undefined, pause: () => undefined, resume: () => undefined, block: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: (name) => (name === 'webServer' ? { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:5601' } : undefined),
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    // The gate's poll timer never ticks in this test: `interval` returns a
    // disposer and forgets the callback, so a queued restart stays queued.
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  return { ctx }
}

/**
 * A REAL runtime in an isolated state directory, plus the tool definitions
 * built on top of it.
 *
 * Everything that could touch the machine is stubbed at the runtime boundary
 * (`runCommand`, `launchWatcher`, the snapshot, the watchdog), so the calls
 * below only ever write inside the temp directory.
 */
function hostFixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-toolschema-${label}-`))
  t.after(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp directory is not the assertion.
    }
  })
  const config = normalizeConfig({
    stateFile: path.join(base, 'state', 'state.json'),
    restartMode: 'app',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: false,
  })
  fs.mkdirSync(path.join(base, 'state'), { recursive: true })
  const { ctx } = fakeContext()
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: true, appExePath: null },
    snapshot: () => ({ ok: true, cancelled: true, dir: null, backup: null, profileDir: null }),
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  })
  const tools = buildLifecycleTools(runtime, config)
  return { base, config, runtime, tools, byName: new Map(tools.map((definition) => [definition.name, definition])) }
}

/**
 * A stub runtime for the branches that must not run against a real machine
 * (installing / removing the supervisor, and a handoff that creates a session).
 * It answers with the shapes the real implementation produces.
 */
function stubRuntime() {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: { platform: 'linux', isDesktopApp: false, appExePath: null, pid: 4242, ppid: 1 },
    stateFile: path.join(os.tmpdir(), 'dsh-ar-stub', 'state', 'state.json'),
    supervisorStatus: () => ({ kind: 'systemd-user', installed: true, running: true, detail: 'a stub unit starts this host' }),
    startupMode: () => 'bare',
    hostKind: () => 'linux',
    deriveStartCommand: async () => ({
      ok: true,
      level: 'systemd-user',
      mode: 'systemd',
      reason: 'the host is started by nobody, so a user unit would own it',
      plan: [{ step: 'write the unit', path: '/home/dev/.config/systemd/user/dsh.service' }],
      needsConfirmation: true,
      command: 'node /opt/dsh/index.js',
      writes: { unit: '/home/dev/.config/systemd/user/dsh.service', config: '/opt/dsh/supervisor.json' },
      compose: 'WantedBy=default.target',
    }),
    installSupervisor: () => ({
      ok: true,
      kind: 'systemd-user',
      degraded: false,
      reason: 'the unit was written and enabled',
      error: null,
      steps: [{ step: 'write the unit', ok: true }],
    }),
    uninstallSupervisor: async () => ({
      ok: true,
      error: null,
      steps: [{ step: 'remove the unit', ok: true }],
      previous: { restartMode: 'command', restartCommand: 'node /opt/dsh/index.js' },
      pending: { name: 'UNINSTALL-PENDING.json', pendingUninstall: '/tmp/dsh/UNINSTALL-PENDING.json' },
    }),
    recordSupervisorChoice: () => {},
    handoff: async () => ({
      ok: true,
      sourceSessionId: 'session-old',
      sessionId: 'session-new',
      carriedChars: 19876,
      carriedTailChars: 12040,
      disarmedGoal: true,
      instruction: 'Continue in session-new: the objective and the reasons travelled with it.',
    }),
  }
}

/**
 * One scenario = a fresh runtime plus the calls to drive on it, in order (the
 * order matters: `continuum_status` is most honest AFTER a request exists).
 */
const REAL_RUNTIME_SCENARIOS = [
  {
    label: 'continuum_restart',
    steps: [
      // THE REGRESSION: this answer carries `restartRequest`, and until the
      // schema learned about it the whole call was refused as invalid output.
      { args: { reason: 'the strict-schema test' }, exec: { agent: { id: 'session-strict-schema' } } },
      // The same call without a calling session: `willResume` is false then.
      { args: { reason: 'no session asked', resume: false } },
      // The request record, as `continuum_status` reports it afterwards.
      { tool: 'continuum_status', args: {} },
    ],
  },
  {
    label: 'continuum_status',
    steps: [
      { args: {} },
      { args: { include_sessions: false } },
    ],
  },
  {
    label: 'continuum_park_goal',
    steps: [
      { args: {}, exec: {} },
      { args: {}, exec: { agent: { id: 'session-with-a-goal' } } },
      { args: { sessionId: 'session-with-a-goal' } },
    ],
  },
  {
    label: 'continuum_recover_now',
    steps: [
      { args: {} },
      { args: { sessionId: 'session-nobody-knows', force: true } },
    ],
  },
  {
    label: 'continuum_handoff',
    steps: [
      // Nothing to read: the failure answer, with every failure key at once.
      { args: {} },
      { args: { sessionId: 'session-nobody-knows' } },
    ],
  },
  {
    label: 'continuum_cancel_restart',
    steps: [
      { args: {} },
      { args: { scope: 'all' } },
      { args: { scope: 'mine', reason: 'the strict-schema test' } },
    ],
  },
  {
    label: 'continuum_supervisor',
    steps: [
      { args: { action: 'status' } },
      { args: { action: 'plan' } },
      // No `confirmed`: the answer is a refusal, and it must stay a valid one.
      { args: { action: 'install' } },
      { args: { action: 'uninstall' } },
    ],
  },
]

test('every tool answers only with keys its strict output schema declares', async (t) => {
  for (const scenario of REAL_RUNTIME_SCENARIOS) {
    const host = hostFixture(t, scenario.label)
    for (const [index, step] of scenario.steps.entries()) {
      const name = step.tool ?? scenario.label
      const tool = host.byName.get(name)
      assert.ok(tool, `the plugin registers a tool named "${name}"`)
      const answer = await tool.execute(step.args ?? {}, step.exec ?? {})
      assertAnswerFits(tool, answer, `${name} step ${index + 1}`)
    }
  }
})

test('the branches that would touch the machine still answer inside their schema', async (t) => {
  const runtime = stubRuntime()
  const config = normalizeConfig({ stateFile: path.join(os.tmpdir(), 'dsh-ar-stub', 'state', 'state.json') })
  const tools = buildLifecycleTools(runtime, config)
  const byName = new Map(tools.map((definition) => [definition.name, definition]))

  const handoffShouldWork = [
    ['continuum_handoff', { sessionId: 'session-old' }],
  ]
  for (const [name, args] of handoffShouldWork) {
    const answer = await byName.get(name).execute(args, {})
    assert.equal(answer.ok, true, `${name}: the stub answers a successful handoff`)
    assertAnswerFits(byName.get(name), answer, `${name} (a successful handoff)`)
  }

  // The dry run returns the widest supervisor answer: `command`, `writes` and
  // `compose` are only PRESENT here, and they are the fields a strict schema
  // silently refuses when they are forgotten.
  const dryRun = await byName.get('continuum_supervisor').execute({ action: 'dry-run' }, {})
  assert.equal(dryRun.command, 'node /opt/dsh/index.js', 'the dry run reports the command it would write')
  assert.ok(dryRun.writes, 'the dry run reports the files it would write')
  assertAnswerFits(byName.get('continuum_supervisor'), dryRun, 'continuum_supervisor (dry-run)')

  const planned = await byName.get('continuum_supervisor').execute({ action: 'plan' }, {})
  assertAnswerFits(byName.get('continuum_supervisor'), planned, 'continuum_supervisor (plan)')

  const installed = await byName.get('continuum_supervisor').execute({ action: 'install', confirmed: true, choice: 'install' }, {})
  assert.equal(installed.ok, true)
  assertAnswerFits(byName.get('continuum_supervisor'), installed, 'continuum_supervisor (install)')

  const removed = await byName.get('continuum_supervisor').execute({ action: 'uninstall', confirmed: true }, {})
  assert.equal(removed.ok, true)
  assertAnswerFits(byName.get('continuum_supervisor'), removed, 'continuum_supervisor (uninstall)')
})

test('no tool weakens its output schema to survive', async () => {
  const runtime = stubRuntime()
  const config = normalizeConfig({ stateFile: path.join(os.tmpdir(), 'dsh-ar-stub', 'state', 'state.json') })
  const tools = buildLifecycleTools(runtime, config)
  assert.ok(tools.length >= 7, 'the lifecycle tools are all built')

  // A NEW TOOL must get a scenario above, or nothing would check its answer
  // against its schema — the next `continuum_restart`-shaped bug would ship
  // untested. Fail here instead of hoping somebody remembers.
  const exercised = new Set(
    REAL_RUNTIME_SCENARIOS.flatMap((scenario) => scenario.steps.map((step) => step.tool ?? scenario.label)),
  )
  for (const tool of tools) {
    assert.ok(exercised.has(tool.name), `${tool.name}: add a scenario that drives this tool — every tool is checked against its schema`)
  }

  for (const tool of tools) {
    const schema = tool.output && tool.output.schema
    assert.ok(schema, `${tool.name}: an output schema is declared`)
    assert.equal(schema.type, 'object', `${tool.name}: the answer is an object`)
    // The rule this file exists for. Loosening it instead of declaring the
    // field is the one "fix" that must never be accepted.
    assert.equal(
      schema.additionalProperties,
      false,
      `${tool.name}: additionalProperties must stay false — a returning field is DECLARED, not tolerated`,
    )
    assert.ok(Array.isArray(schema.required), `${tool.name}: required is declared`)
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${tool.name}: required "${key}" is a declared property`)
    }
  }
})

test('continuum_restart declares restartRequest, and the declaration allows null', async (t) => {
  const host = hostFixture(t, 'restart-request')
  const tool = host.byName.get('continuum_restart')
  const schema = tool.output.schema
  assert.ok(Object.hasOwn(schema.properties, 'restartRequest'), 'continuum_restart declares restartRequest')

  const declared = schema.properties.restartRequest
  const accepts = (value) => violationsOf(declared, value, 'value.restartRequest').length === 0
  assert.equal(accepts({ state: 'queued', pending: true }), true, 'an object passes (the normal answer)')
  assert.equal(accepts(null), true, 'null passes (no request record at all)')
  assert.equal(accepts('queued'), false, 'a bare string does not pass')

  // And the answer really carries it — that is what the schema now covers.
  const answer = await tool.execute({ reason: 'the strict-schema test' }, { agent: { id: 'session-strict-schema' } })
  assert.ok(isPlainObject(answer.restartRequest), 'the answer carries the request record')
  assert.equal(typeof answer.restartRequest.state, 'string', 'the record says in which state the request is')
  assertAnswerFits(tool, answer, 'continuum_restart (the regression)')
})
