/**
 * "REPORT A PROBLEM": the diagnostics, the pre-filled issue and the fallback.
 *
 * The diagnostics are the ONE thing the user hands us when something is wrong,
 * so two things matter:
 *
 *   - they must carry the facts (version, platform, desktop client, the
 *     startup mode AND the evidence it rests on, the supervisor, the restart
 *     mode, the verdict of the last restart);
 *   - they must carry NOTHING private: no access token, no URL with a token,
 *     no secret. A bug report that leaks the token of the instance is worse
 *     than no bug report.
 *
 * The client is evaluated the way the browser evaluates it (a vm sandbox), so
 * the helpers it publishes are really the ones the settings page uses.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

import {
  buildDiagnostics,
  buildIssueUrl,
  DIAGNOSTIC_BODY_LIMIT,
  ISSUE_URL_BASE,
  redactSecrets,
  SUPPORT_EMAIL,
  truncatePath,
} from '../lib/diagnostics.js'

/**
 * The client script, evaluated the way the browser evaluates it.
 */
function loadClient() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
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
      createElement: (tag) => ({
        tag, id: '', textContent: '', parentNode: null,
        setAttribute: () => {}, appendChild: () => {},
      }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return sandbox.__dshAutorestartClient
}

/** A payload that looks like the state of a real host. */
function statePayload() {
  return {
    version: '0.6.2',
    platform: 'win32',
    hostKind: 'wsl',
    isDesktopApp: false,
    startup: { mode: 'bare', kind: 'terminal', evidence: 'parent:4242: bash' },
    supervisor: { mode: 'installed', kind: 'systemd-user' },
    restartMode: 'app',
    lastRestart: { result: 'failed', failedChecks: ['listener', 'routes'] },
    stateDir: 'C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart',
    // The things that must NEVER end up in the diagnostics:
    accessUrl: 'http://127.0.0.1:52765/?token=DEADBEEFCAFEBABE',
    state: { token: 'DEADBEEFCAFEBABE', apiKey: 'sk-live-SECRET' },
  }
}

test('the diagnostics carry every fact a bug report needs', () => {
  const text = buildDiagnostics(statePayload())
  assert.match(text, /plugin version: 0\.6\.2/)
  assert.match(text, /platform: win32/)
  assert.match(text, /host kind: wsl/)
  assert.match(text, /desktop client: no/)
  assert.match(text, /startup mode: bare/)
  assert.match(text, /startup evidence: parent:4242: bash/)
  assert.match(text, /supervisor mode: installed/)
  assert.match(text, /supervisor kind: systemd-user/)
  assert.match(text, /restart mode: app/)
  assert.match(text, /last restart result: failed/)
  assert.match(text, /last restart failed checks: listener, routes/)
  // A desktop client says so.
  assert.match(buildDiagnostics({ ...statePayload(), isDesktopApp: true }), /desktop client: yes/)
  // A restart that worked says "none".
  assert.match(
    buildDiagnostics({ ...statePayload(), lastRestart: { result: 'ok', failedChecks: [] } }),
    /last restart failed checks: none/,
  )
})

test('the diagnostics never carry a token, a token URL or a secret', () => {
  const text = buildDiagnostics(statePayload())
  assert.equal(/token/i.test(text), false, 'the word token must not appear: ' + text)
  assert.equal(/\?token=/i.test(text), false, 'no URL with a token')
  assert.equal(/DEADBEEFCAFEBABE/.test(text), false, 'the access token must not leak')
  assert.equal(/sk-live-SECRET/.test(text), false, 'a secret must not leak')
  assert.equal(/127\.0\.0\.1:52765/.test(text), false, 'the access link must not leak')
  // The redaction itself is the second line of defence.
  assert.equal(redactSecrets('http://x/?token=abc').includes('abc'), false)
  assert.equal(redactSecrets('token: abcdef').includes('abcdef'), false)
  assert.equal(redactSecrets('"apiKey": "sk-live-1"').includes('sk-live-1'), false)
})

test('a path is shortened, but the user name may stay', () => {
  assert.equal(
    truncatePath('C:\\Users\\fg\\.dsh\\storages\\dsh-autorestart'),
    '…/fg/.dsh/storages/dsh-autorestart',
  )
  assert.equal(truncatePath('C:\\Users\\fg'), 'C:\\Users\\fg')
  const text = buildDiagnostics(statePayload())
  assert.match(text, /dsh home: …\//)
  assert.match(text, /fg/, 'the user name may stay: it says which account ran it')
  assert.equal(text.includes('C:\\Users\\fg'), false, 'the full path is not copied')
})

test('the pre-filled issue URL is encoded and stays short', () => {
  const title = '重启 / 开机自启相关的问题'
  const body = '请把刚才复制的诊断信息粘贴到下面。\n\n## 发生了什么\n\n\n## 期望什么\n\n\n## 怎么复现\n'
  const url = buildIssueUrl(ISSUE_URL_BASE, title, body)
  assert.ok(url.startsWith(ISSUE_URL_BASE + '?title='), url)
  assert.equal(url.includes(' '), false, 'the spaces must be encoded')
  assert.equal(url.includes('重启'), false, 'the Chinese text must be encoded')
  assert.equal(decodeURIComponent(url.split('&body=')[0].split('title=')[1]), title, 'the title survives')
  assert.equal(decodeURIComponent(url.split('&body=')[1]), body, 'the body survives')
  // The body of an issue URL has a length limit.
  const long = buildIssueUrl(ISSUE_URL_BASE, title, 'x'.repeat(5000))
  const longBody = decodeURIComponent(long.split('&body=')[1])
  assert.ok(longBody.length <= DIAGNOSTIC_BODY_LIMIT, 'the body is cut: ' + longBody.length)
  assert.ok(long.length < 2000, 'the URL stays usable')
})

test('the clipboard refuses sometimes — the fallback brings the text back', async () => {
  const api = loadClient()
  assert.ok(api, 'the client publishes its helpers')
  assert.equal(typeof api.copyReportText, 'function')

  const text = '--- dsh-autorestart diagnostics ---\nplugin version: 0.6.2\n--- end ---'

  // 1. The happy path.
  const copied = []
  const ok = await api.copyReportText(text, { clipboard: { writeText: async (value) => { copied.push(value) } } })
  assert.equal(ok.ok, true)
  assert.equal(ok.fallback, false)
  assert.deepEqual(copied, [text])

  // 2. The clipboard refuses (an insecure context, no permission).
  const refused = await api.copyReportText(text, {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError') } },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.fallback, true)
  assert.equal(refused.text, text, 'the text comes back, so the user can copy it by hand')

  // 3. There is no clipboard at all.
  const none = await api.copyReportText(text, { clipboard: null })
  assert.equal(none.fallback, true)
  assert.equal(none.text, text)
})

test('the email of the fallback is the one of the project', () => {
  assert.equal(SUPPORT_EMAIL, '252170229@qq.com')
  const api = loadClient()
})

test('the client publishes the report helpers and keeps the bundle isolated', () => {
  const api = loadClient()
  assert.equal(typeof api.buildIssueUrl, 'function')
  assert.equal(typeof api.copyReportText, 'function')
  // The bilingual copy of the new group is in the built-in dictionaries.
  assert.equal(typeof api.dictionaries.zh['settings.report.github'], 'string')
  assert.equal(typeof api.dictionaries.en['settings.report.github'], 'string')
  assert.equal(api.dictionaries.zh['settings.groups.report'], '遇到问题')
  assert.equal(api.dictionaries.en['settings.groups.report'], 'Something is wrong')
})
