/**
 * The bilingual interface: the English user must never see a key name.
 *
 * The facts this pins down (they were checked against the DSH packages):
 *
 *   - the slot component DOES get the translator: a slot registration that
 *     declares `locale:` is rendered with a `t` seat in its props
 *     (`PropsLocale` = `{ t: TranslateNS<N> }` in @deepseek-ai/dsh-client-ui-slots);
 *   - the DSH locale service answers with THE KEY when it does not know one
 *     ("…then repeats it in the shared common namespace before showing the
 *     key itself"), so a plain `t(key)` can put a key name on the screen;
 *   - the plugin registers its OWN dictionaries (`ctx.locale.register`), so the
 *     built-in tables are the source of truth for the interface and the
 *     `locale/*.json` files are their mirror.
 *
 * So the translator of this plugin never shows a key: the Host's answer is
 * used when it is a text, and the built-in dictionary answers otherwise.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Load the client script the way the browser evaluates it.
 *
 * @param {{ language?: string }} options the browser language
 */
function loadClient({ language = 'zh-CN' } = {}) {
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
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    navigator: { language },
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

/** The flattened keys of a nested dictionary. */
function flatten(object, prefix = '') {
  const out = []
  for (const [key, value] of Object.entries(object)) {
    const path = prefix === '' ? key : prefix + '.' + key
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...flatten(value, path))
    else out.push(path)
  }
  return out
}

/**
 * A raw key name looks like an identifier: `durationSeconds`,
 * `settings.backup.label`. It starts with a lowercase letter and has no
 * space — an English word like "Recommended" is copy, not a key.
 */
const RAW_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/

test('without a translator the Chinese user sees Chinese', () => {
  const api = loadClient({ language: 'zh-CN' })
  const t = api.makeTranslate(null)
  assert.equal(t('settings.supervisor.startup.bare'), '手动启动（没人管它）')
  assert.equal(t('settings.backup.list'), '现在备份了什么')
})

test('without a translator the English user sees English', () => {
  const api = loadClient({ language: 'en-US' })
  const t = api.makeTranslate(null)
  assert.equal(t('settings.supervisor.startup.bare'), 'started by hand (nobody manages it)')
  assert.equal(t('settings.backup.list'), 'What is backed up right now')
})

test('the Host translator wins when it answers with a text', () => {
  const api = loadClient({ language: 'en-US' })
  const asked = []
  const t = api.makeTranslate((key) => {
    asked.push(key)
    return 'MOCKED'
  })
  assert.equal(t('settings.backup.list'), 'MOCKED', 'the Host answer is used')
  assert.deepEqual(asked, ['settings.backup.list'], 'the Host translator was asked')
})

test('a Host translator that answers with the key falls back to the dictionary', () => {
  // This is what the DSH locale service does for a key it does not know.
  const api = loadClient({ language: 'en-US' })
  const t = api.makeTranslate((key) => key)
  assert.equal(t('settings.backup.list'), 'What is backed up right now', 'the dictionary answers')
  assert.notEqual(t('settings.backup.list'), 'settings.backup.list', 'never the key itself')
})

test('no text of the interface is a bare key name — in any language', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const api = loadClient({ language })
    const keys = Object.keys(api.dictionaries.zh)
    // 1. The dictionary itself: every key has a text in both languages.
    for (const key of keys) {
      const zh = api.dictionaries.zh[key]
      const en = api.dictionaries.en[key]
      assert.equal(typeof zh, 'string', key + ' has a Chinese text')
      assert.equal(typeof en, 'string', key + ' has an English text')
      assert.equal(zh.length > 0, true, key + ' has a Chinese text')
      assert.equal(en.length > 0, true, key + ' has an English text')
    }
    // 2. The fallback translator: without a Host translator, and with a Host
    //    translator that answers with the key.
    for (const host of [null, (key) => key]) {
      const t = api.makeTranslate(host)
      for (const key of keys) {
        const text = t(key)
        assert.equal(text === key, false, 'the key ' + key + ' must not be shown')
        assert.equal(RAW_KEY.test(text), false, 'the text of ' + key + ' looks like a key name: ' + text)
      }
    }
  }
})

test('the two locale files and the built-in dictionaries have the same keys', () => {
  const api = loadClient({ language: 'zh-CN' })
  const inlineZh = Object.keys(api.dictionaries.zh).sort()
  const inlineEn = Object.keys(api.dictionaries.en).sort()
  const fileZh = flatten(JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))).sort()
  const fileEn = flatten(JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))).sort()

  assert.deepEqual(inlineZh, inlineEn, 'the two dictionaries have the same keys')
  assert.deepEqual(fileZh, inlineZh, 'locale/zh.json is the mirror of the Chinese dictionary')
  assert.deepEqual(fileEn, inlineEn, 'locale/en.json is the mirror of the English dictionary')
})

/** The flattened key → text of a nested dictionary (values kept, not just paths). */
function flatTexts(object, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    const path = prefix === '' ? key : prefix + '.' + key
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flatTexts(value, path))
    else out[path] = value
  }
  return out
}

/**
 * THE MIRRORS SAY THE SAME THING AS THE DICTIONARY — text for text (2026-11-02).
 *
 * WHY THIS EXISTS: the check above compares KEYS, and only keys. That keeps the
 * mirrors complete; it does not keep them truthful. `watchdog.explain` went on
 * saying "验证过能用" in BOTH mirrors for a whole round after the dictionary had been
 * reworded, and nothing went red, because every key was still there. What the user
 * read was the old promise, not the new fact — the very sentence this change is
 * about.
 *
 * A mirror that is allowed to disagree with its source is not a mirror; it is a
 * second copy that will drift. So the values are compared here, for every key, in
 * both languages.
 */
test('the locale files mirror the dictionaries TEXT FOR TEXT, not only by key', () => {
  const api = loadClient({ language: 'zh-CN' })
  const pairs = [
    ['zh.json', 'zh'],
    ['en.json', 'en'],
  ]
  for (const [file, language] of pairs) {
    const mirror = flatTexts(JSON.parse(fs.readFileSync(new URL('../locale/' + file, import.meta.url), 'utf8')))
    const inline = api.dictionaries[language]
    assert.deepEqual(Object.keys(mirror).sort(), Object.keys(inline).sort(), file + ' has exactly the dictionary keys')
    const differing = Object.keys(inline).filter((key) => mirror[key] !== inline[key])
    assert.deepEqual(differing, [], 'locale/' + file + ' must say what the dictionary says (drifted keys listed above)')
  }
})

/**
 * AND THE ONE SENTENCE THE USER ACTUALLY READ: the rescue notice (2026-11-02).
 *
 * It may say what the rescue DOES and by which two facts it picks a copy — the
 * content fingerprint matched, and that boot came up. It may NOT promise a usable
 * backup: "these plugins are fine" is exactly what the record cannot know, since a
 * boot on this content says nothing about whether the plugins inside are healthy.
 */
test('watchdog.explain states the criterion and promises nothing about the plugins', () => {
  const api = loadClient({ language: 'zh-CN' })
  const zh = api.dictionaries.zh['watchdog.explain']
  const en = api.dictionaries.en['watchdog.explain']
  const fileZh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8')).watchdog.explain
  const fileEn = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')).watchdog.explain

  assert.equal(fileZh, zh, 'locale/zh.json is character-for-character the dictionary text')
  assert.equal(fileEn, en, 'locale/en.json is character-for-character the dictionary text')

  assert.equal(zh.includes('验证过能用'), false, 'the old promise is gone from the Chinese text')
  assert.equal(zh.includes('内容指纹一致'), true, 'the Chinese text names the first criterion')
  assert.equal(zh.includes('那次启动起来了'), true, 'and the second one')
  assert.equal(zh.includes('这不代表里面的插件都正常'), true, 'and says what it does NOT mean')

  assert.equal(en.includes('verified backup'), false, 'the old promise is gone from the English text')
  assert.equal(en.includes('content fingerprint matched'), true, 'the English text names the first criterion')
  assert.equal(en.includes('that boot came up'), true, 'and the second one')
  assert.equal(en.includes('does not mean the plugins inside are all fine'), true, 'and says what it does NOT mean')
})

test('the language follows the Host, and the browser is only the fallback', () => {
  const api = loadClient({ language: 'zh-CN' })
  assert.equal(api.currentLanguage(), 'zh', 'the browser language decides when the Host says nothing')
  // A language that is neither Chinese nor English is English (the DSH rule).
  const other = loadClient({ language: 'fr-FR' })
  assert.equal(other.currentLanguage(), 'en')
})
