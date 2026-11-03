/**
 * THE DESKTOP SHORTCUT CARRIES THE PLUGIN'S OWN ICON (user decision, 2026-11-02).
 *
 * WHAT THE USER SAW. The rescue entry on the desktop had DSH's own executable as
 * its icon (`rescueKitInfo` passed `env.appExePath`). In the one moment this
 * entry matters —the host does not start and the user is looking for a way out
 * —a file wearing DSH's face reads as "this is the program", not "this is the
 * rescue tool". So the host executable is no longer involved at all.
 *
 * THE RULES PINNED HERE:
 *   1. the icon is the plugin's own file, resolved from the plugin directory
 *      (`assets/icon.ico`), and the page gets the SAME path the `.lnk` uses;
 *   2. there is NO fallback to the host executable —the only alternative to the
 *      plugin's icon is NO icon, and a missing icon never fails the shortcut;
 *   3. a repository that ships the icon at the root (`icon.ico`) works too, and
 *      nothing is generated or written at runtime: the answer is a file on disk
 *      or it is "none";
 *   4. the file that actually ships in THIS repository is a real icon container
 *      (a multi-size ICO whose largest entry is the shipped PNG), so the feature
 *      cannot be "green in tests because nothing checks the file".
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime, normalizeConfig } from '../index.js'
import { buildIconFromDisk, shippedIcoPath } from '../scripts/build-icon.mjs'
import {
  pluginShortcutIcon,
  rescueInfo,
  shortcutCreationScript,
  createDesktopShortcut,
  ensureShortcutIcon,
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
 * ①THE RESOLVER: the plugin's own file, never the host's executable.
 * ------------------------------------------------------------------ */

test('①the plugin icon is resolved from the plugin directory, and only from there', () => {
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

  // No plugin directory, no icon —and never a throw.
  assert.equal(pluginShortcutIcon({ pluginDir: '', exists: () => true }), '')
  assert.equal(pluginShortcutIcon({ pluginDir: 'C:\\plugin', exists: () => false }), '')
  assert.equal(
    pluginShortcutIcon({ pluginDir: 'C:\\plugin', exists: () => { throw new Error('denied') } }),
    '',
    'an unreadable path is "no icon", not an exception the shortcut dies of',
  )
})

/* ------------------------------------------------------------------ *
 * ②THE PAGE AND THE `.lnk` GET THE SAME ANSWER, AND IT IS NOT DSH'S EXE.
 * ------------------------------------------------------------------ */

test('②the page and the .lnk name the plugin icon, and the host executable is gone', () => {
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

  // The `.lnk` uses exactly that path, with index 0 —the same file the page
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
  // for the settings page is asked with an app executable present —the icon it
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
    assert.equal(
      /^shortcut-icon-[0-9a-f]{8}\.ico$/i.test(path.basename(reported.iconPath)),
      true,
      'the page and the .lnk name a fresh content-addressed copy, not the asset path: ' + reported.iconPath,
    )
    assert.equal(path.dirname(reported.iconPath), stateDir, 'the copy lives in the plugin state directory')
    assert.equal(fs.existsSync(reported.iconPath), true, 'and it is a file that really exists: ' + reported.iconPath)
    // THE COPY IS THE PICTURE THE RESOLVER PICKED (2026-11-02): since the user
    // approved the branded "rescue" icon, the source is that file rather than the
    // plain artwork, so the comparison is against the resolver's own answer.
    assert.equal(
      fs.readFileSync(reported.iconPath).equals(fs.readFileSync(pluginShortcutIcon({ pluginDir: process.cwd() }))),
      true,
      'the copy carries exactly the icon this package ships',
    )
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * ③DEGRADATION: no icon is a fine answer; a wrong icon is not.
 * ------------------------------------------------------------------ */

test('③an install without the icon gets no icon —the shortcut is still created', () => {
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

  // The `.lnk` is written WITHOUT an icon line —never with a file that would
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
 * ④THE FILE THAT SHIPS IS A REAL ICON.
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

test('④the .ico this repository ships is made of DIB entries the shell can read', () => {
  // THE SHIPPED NAME CARRIES THE CONTENT HASH (see scripts/build-icon.mjs).
  const icoPath = shippedIcoPath()
  assert.notEqual(icoPath, '', 'an assets/icon-<hash>.ico ships with the plugin (package.json files)')
  assert.equal(fs.existsSync(icoPath), true, icoPath + ' exists')

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

  // EVERY ENTRY IS A DIB, NEVER A PNG (user report, 2026-11-02: "still no icon").
  // Measured on the real machine: the classic icon path (`ExtractIconEx`,
  // `SHGetFileInfo`, `System.Drawing.Icon`, Explorer's image list) decodes a PNG
  // entry as raw pixels and paints garbage. Rendering the same 32 px tile:
  //   System.Drawing.Icon(PNG-entry .ico) -> random noise
  //   System.Drawing.Icon(DIB-entry .ico) -> the ring + flame
  //   shell drawing a .lnk -> DIB .ico    -> the mark, with the arrow overlay
  //   shell drawing the real .lnk         -> a solid bright block (the bug)
  // `scripts/build-icon.mjs` builds the shipped file from `assets/icon-180.png`
  // with DIB entries only, and this assertion is what keeps it that way.
  for (const entry of parsed.entries) {
    const payload = ico.subarray(entry.offset, entry.offset + entry.bytes)
    const magic = payload.subarray(0, 8).toString('hex')
    assert.notEqual(magic, '89504e470d0a1a0a', entry.width + 'px: a PNG entry would be unreadable to the shell')
    assert.equal(payload.readUInt32LE(0), 40, entry.width + 'px: BITMAPINFOHEADER (biSize 40)')
    assert.equal(payload.readInt32LE(4), entry.width, entry.width + 'px: biWidth')
    // The icon convention: biHeight covers the XOR bitmap AND the AND mask.
    assert.equal(payload.readInt32LE(8), entry.height * 2, entry.width + 'px: biHeight is XOR + AND')
    assert.equal(payload.readUInt16LE(12), 1, entry.width + 'px: biPlanes')
    assert.equal(payload.readUInt16LE(14), 32, entry.width + 'px: 32 bits per pixel')
    assert.equal(payload.readUInt32LE(16), 0, entry.width + 'px: BI_RGB (uncompressed)')
    // NO AND MASK (2026-11-02, measured): with both a mask and a 32-bpp alpha
    // channel this Windows build applies the mask over the alpha and draws a
    // ghost of the mark. Pillow omits the mask for 32-bpp entries as well, and
    // its files always rendered correctly. So an entry is exactly the header
    // plus the pixels.
    assert.equal(entry.bytes, 40 + entry.width * entry.height * 4, entry.width + 'px: header + pixels, no AND mask')
  }
})

test('④the icon can be rebuilt from the artwork, byte for byte (no hand-edited binary)', () => {
  // The artifact is generated, so it must be reproducible: an .ico that only
  // exists because somebody ran a tool once will drift, and a drifted icon is
  // exactly how the PNG entries got shipped in the first place.
  const built = buildIconFromDisk()
  const shipped = fs.readFileSync(shippedIcoPath())
  assert.equal(
    built.equals(shipped),
    true,
    'the shipped icon must equal `node scripts/build-icon.mjs` from assets/icon-180.png (shipped '
      + shipped.length + ' bytes, built ' + built.length + ')',
  )
})

/* ------------------------------------------------------------------ *
 * ⑤THE SHORTCUT GETS A FRESH PATH, NOT THE ASSET PATH.
 *
 * User report, 2026-11-02: after the `.ico` itself was fixed, the desktop
 * shortcut STILL drew a solid block. Measured: the very same bytes rendered the
 * mark from a path the shell had never seen, and the block from the plugin's own
 * `assets/` path —an icon path Explorer has already drawn keeps being served
 * from its cache, and rewriting the `.lnk` (even deleting and recreating it) does
 * not change that. So the shortcut names a content-addressed copy in the state
 * directory, which is a new cache key on every build.
 * ------------------------------------------------------------------ */

test('⑤the shortcut is handed a fresh, content-addressed copy of the icon', () => {
  const files = new Map()
  const dirs = []
  const exists = (target) => files.has(target)
  const readFile = (target) => {
    if (!files.has(target)) throw new Error('ENOENT ' + target)
    return files.get(target)
  }
  const writeFile = (target, data) => { files.set(target, data) }
  const mkdir = (target) => { dirs.push(target) }

  const source = 'C:/plugin/assets/icon-abcdef12.ico'
  files.set(source, Buffer.from('the icon bytes'))
  const stateDir = 'C:/state/dsh-autorestart'

  const icon = ensureShortcutIcon({ sourceIcon: source, stateDir, exists, readFile, writeFile, mkdir })
  assert.notEqual(icon, source, 'the asset path is not what the shortcut names')
  assert.equal(icon.startsWith(path.join(stateDir, 'shortcut-icon-')), true, 'it lives in the state dir: ' + icon)
  assert.equal(icon.endsWith('.ico'), true)
  assert.deepEqual(dirs, [stateDir], 'the state directory is created, once')
  assert.equal(files.get(icon).toString(), 'the icon bytes', 'the copy carries the exact bytes')

  // Second call: the copy is already there, nothing is written again.
  const dirsBefore = dirs.length
  const again = ensureShortcutIcon({ sourceIcon: source, stateDir, exists, readFile, writeFile, mkdir })
  assert.equal(again, icon, 'the same name comes back, so the shortcut does not churn')
  assert.equal(dirs.length, dirsBefore, 'and nothing is created again')

  // A different icon is a different name: that is what makes a new build a new
  // cache entry, which is the whole point of the copy.
  files.set(source, Buffer.from('a new build of the icon'))
  const rebuilt = ensureShortcutIcon({ sourceIcon: source, stateDir, exists, readFile, writeFile, mkdir })
  assert.notEqual(rebuilt, icon, 'a rebuilt icon gets a new name')

  // No state directory (a test host, or a read-only one): the asset path stays.
  assert.equal(
    ensureShortcutIcon({ sourceIcon: source, stateDir: '', exists, readFile, writeFile, mkdir }),
    source,
    'without a state directory the asset path is handed back unchanged',
  )
})

test('⑤a state directory that cannot be written never costs the icon entirely', () => {
  const source = 'C:/plugin/assets/icon-abcdef12.ico'
  const icon = ensureShortcutIcon({
    sourceIcon: source,
    stateDir: 'C:/state/dsh-autorestart',
    exists: () => false,
    readFile: () => { throw new Error('EACCES') },
    writeFile: () => {},
    mkdir: () => {},
  })
  assert.equal(icon, source, 'the plugin asset is still an icon; failing to copy must not lose it')
})
