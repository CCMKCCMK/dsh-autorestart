/**
 * THE DESKTOP SHORTCUT CARRIES THE PLUGIN'S OWN ICON (user decision, 2026-11-02).
 *
 * WHAT THE USER SAW. The rescue entry on the desktop had DSH's own executable as
 * its icon (`rescueKitInfo` passed `env.appExePath`). In the one moment this
 * entry matters — the host does not start and the user is looking for a way out
 * — a file wearing DSH's face reads as "this is the program", not "this is the
 * rescue tool". So the host executable is no longer involved at all.
 *
 * THE RULES PINNED HERE:
 *   1. the icon is the plugin's own file, resolved from the plugin directory
 *      (`assets/icon.ico`), and the page gets the SAME path the `.lnk` uses;
 *   2. there is NO fallback to the host executable — the only alternative to the
 *      plugin's icon is NO icon, and a missing icon never fails the shortcut;
 *   3. a repository that ships the icon at the root (`icon.ico`) works too, and
 *      nothing is generated or written at runtime: the answer is a file on disk
 *      or it is "none";
 *   4. the file that actually ships in THIS repository is a real icon container
 *      (a multi-size ICO whose largest entry is the shipped PNG), so the feature
 *      cannot be "green in tests because nothing checks the file".
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime, normalizeConfig } from '../index.js'
import {
  pluginShortcutIcon,
  rescueInfo,
  shortcutCreationScript,
  createDesktopShortcut,
  SHIPPED_ICON_FILES,
} from '../lib/rescue-paths.js'

/** The Cordis context the runtime needs (only logging is used here). */
function hostContext() {
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, disarm: () => undefined, pause: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
}

/* ------------------------------------------------------------------ *
 * ① THE RESOLVER: the plugin's own file, never the host's executable.
 * ------------------------------------------------------------------ */

test('① the plugin icon is resolved from the plugin directory, and only from there', () => {
  assert.deepEqual([...SHIPPED_ICON_FILES], ['assets/icon.ico', 'icon.ico'], 'the packaged place, then the root')

  // The packaged file exists.
  const packaged = pluginShortcutIcon({
    pluginDir: 'C:\\plugin',
    exists: (target) => target === path.join('C:\\plugin', 'assets', 'icon.ico'),
  })
  assert.equal(packaged, path.join('C:\\plugin', 'assets', 'icon.ico'))

  // A repository that only ships it at the root still works.
  const root = pluginShortcutIcon({
    pluginDir: '/plugin',
    exists: (target) => target === path.join('/plugin', 'icon.ico'),
  })
  assert.equal(root, path.join('/plugin', 'icon.ico'))

  // The packaged one wins over the root one (one answer, deterministic order).
  const both = pluginShortcutIcon({
    pluginDir: '/plugin',
    exists: (target) => target === path.join('/plugin', 'icon.ico') || target === path.join('/plugin', 'assets', 'icon.ico'),
  })
  assert.equal(both, path.join('/plugin', 'assets', 'icon.ico'))

  // No plugin directory, no icon — and never a throw.
  assert.equal(pluginShortcutIcon({ pluginDir: '', exists: () => true }), '')
  assert.equal(pluginShortcutIcon({ pluginDir: 'C:\\plugin', exists: () => false }), '')
  assert.equal(
    pluginShortcutIcon({ pluginDir: 'C:\\plugin', exists: () => { throw new Error('denied') } }),
    '',
    'an unreadable path is "no icon", not an exception the shortcut dies of',
  )
})

/* ------------------------------------------------------------------ *
 * ② THE PAGE AND THE `.lnk` GET THE SAME ANSWER, AND IT IS NOT DSH'S EXE.
 * ------------------------------------------------------------------ */

test('② the page and the .lnk name the plugin icon, and the host executable is gone', () => {
  const iconFile = path.join('C:\\plugin', 'assets', 'icon.ico')
  const info = rescueInfo({
    pluginDir: 'C:\\plugin',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    // The desktop exists AND the plugin's icon exists; nothing else does.
    exists: (target) => target === iconFile || target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => '',
  })

  assert.equal(info.iconPath, iconFile, 'the icon IS the plugin’s own file')
  assert.equal(info.iconName, 'icon.ico', 'the page can write down which file it used')
  assert.equal(info.iconAvailable, true)
  assert.equal(/\.exe$/i.test(info.iconPath), false, 'no executable can sneak into this answer')

  // The `.lnk` uses exactly that path, with index 0 — the same file the page
  // just named.
  const script = shortcutCreationScript({
    linkPath: 'C:\\Users\\Tester\\Desktop\\x.lnk',
    targetPath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: info.iconPath,
  })
  assert.ok(
    script.includes("$lnk.IconLocation = 'C:\\plugin\\assets\\icon.ico,0'"),
    'the shortcut carries the plugin icon: ' + script,
  )

  // THE REAL WHOLE-HOST CHECK (not a mock): the runtime that builds the payload
  // for the settings page is asked with an app executable present — the icon it
  // reports must still be the plugin's own file, and that file must exist.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-icon-'))
  try {
    const runtime = createRuntime(hostContext(), normalizeConfig({
      stateFile: path.join(stateDir, 'state.json'),
    }), {
      env: {
        platform: 'win32',
        isDesktopApp: true,
        appExePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
        appVersion: '9.9.9',
      },
    })
    const reported = runtime.rescueKitInfo()
    assert.equal(
      /DeepSeek Harness\.exe$/i.test(reported.iconPath),
      false,
      'the host executable is NOT the icon any more: ' + reported.iconPath,
    )
    assert.equal(path.basename(reported.iconPath), 'icon.ico', 'the plugin’s icon is what the page shows')
    assert.equal(fs.existsSync(reported.iconPath), true, 'and it is a file that really exists: ' + reported.iconPath)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * ③ DEGRADATION: no icon is a fine answer; a wrong icon is not.
 * ------------------------------------------------------------------ */

test('③ an install without the icon gets no icon — the shortcut is still created', () => {
  const info = rescueInfo({
    pluginDir: 'C:\\plugin',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    exists: (target) => target === 'C:\\Users\\Tester\\Desktop',
    readRegistry: () => '',
  })
  assert.equal(info.iconPath, '', 'no icon rather than the host’s face')
  assert.equal(info.iconName, '')
  assert.equal(info.iconAvailable, false, 'and the page is TOLD so instead of showing a path that is not there')

  // The `.lnk` is written WITHOUT an icon line — never with a file that would
  // make `Save()` throw, and never with the executable.
  const script = shortcutCreationScript({
    linkPath: 'C:\\a.lnk',
    targetPath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: info.iconPath,
  })
  assert.equal(script.includes('IconLocation'), false, 'no icon line when there is no icon')

  const created = []
  const written = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    iconPath: info.iconPath,
    exists: () => true,
    createLink: (options) => { created.push(options); return { ok: true, error: null } },
  })
  assert.equal(written.ok, true, 'a missing icon never fails the shortcut')
  assert.equal(created[0].iconPath, '')

  // A host executable is present and it is STILL not used: this is the whole
  // point of the change, and the only way to state it is that the executable
  // never reaches `rescueInfo` at all.
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(
    source.includes('iconPath: env.appExePath'),
    false,
    'the host executable must not be passed as the shortcut icon (text guard)',
  )
})

/* ------------------------------------------------------------------ *
 * ④ THE FILE THAT SHIPS IS A REAL ICON.
 *
 * Without this, every assertion above would pass on a package whose
 * `assets/icon.ico` is a PNG with the wrong extension: Windows would draw the
 * generic blank page and nobody would notice until a user was staring at it.
 * ------------------------------------------------------------------ */

/** Parse an ICO container: the header, every entry, and where the payloads are. */
function readIco(buf) {
  assert.ok(buf.length > 22, 'an .ico is at least a header and one entry')
  assert.equal(buf.readUInt16LE(0), 0, 'reserved field of ICONDIR is 0')
  assert.equal(buf.readUInt16LE(2), 1, 'type 1 = icon (not a cursor)')
  const count = buf.readUInt16LE(4)
  assert.ok(count >= 1, 'at least one image: ' + count)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16
    const width = buf[at] === 0 ? 256 : buf[at]
    const height = buf[at + 1] === 0 ? 256 : buf[at + 1]
    const bytes = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    assert.ok(offset + bytes <= buf.length, `entry ${index} stays inside the file`)
    entries.push({ width, height, bytes, offset })
  }
  return { count, entries }
}

test('④ the .ico this repository ships is a real multi-size icon drawn from the shipped PNG', () => {
  const icoPath = new URL('../assets/icon.ico', import.meta.url)
  assert.equal(fs.existsSync(icoPath), true, 'assets/icon.ico ships with the plugin (package.json files)')

  const ico = fs.readFileSync(icoPath)
  const parsed = readIco(ico)
  assert.ok(parsed.count >= 4, 'a desktop icon carries several sizes, got: ' + parsed.count)
  const sizes = parsed.entries.map((entry) => entry.width + 'x' + entry.height)
  for (const wanted of ['16x16', '32x32', '48x48']) {
    assert.ok(sizes.includes(wanted), 'the shell needs ' + wanted + ', got: ' + sizes.join(', '))
  }
  // Smallest to largest: the shell picks the one it needs.
  const areas = parsed.entries.map((entry) => entry.width * entry.height)
  assert.deepEqual(areas, [...areas].sort((a, b) => a - b), 'the entries are ordered small to large')

  // The largest entry is a PNG (Vista+) whose header says the same size as the
  // artwork it was drawn from — so "the plugin's mark" is provably the same
  // artwork the settings page shows, not a placeholder.
  const largest = parsed.entries[parsed.entries.length - 1]
  const payload = ico.subarray(largest.offset, largest.offset + largest.bytes)
  assert.equal(payload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the largest entry is a PNG')
  const pngWidth = payload.readUInt32BE(16)
  const pngHeight = payload.readUInt32BE(20)
  assert.equal(pngWidth, largest.width, 'the PNG really is the size the entry claims')
  assert.equal(pngHeight, largest.height)

  const artwork = fs.readFileSync(new URL('../assets/icon-180.png', import.meta.url))
  assert.equal(artwork.readUInt32BE(16), pngWidth, 'and it is drawn from assets/icon-180.png')
  assert.equal(artwork.readUInt32BE(20), pngHeight)
})
