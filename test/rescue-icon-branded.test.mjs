/**
 * THE ICON THE USER PICKED, PINNED (2026-11-02).
 *
 * The user looked at a 256 px preview - the DSH artwork with a round restore badge
 * in the lower right corner - and said "use that one". These tests hold the
 * shipped artifact to that picture, and hold the settings page to the SAME bytes:
 *
 *   1. every entry in the `.ico` is a DIB with no AND mask (the shape t10 proved
 *      the shell needs);
 *   2. the badge really is #2563EB where the approved drawing puts it;
 *   3. the data URI the page receives decodes to the 48 px entry of that very
 *      `.ico` (one source file, so "same picture" is a fact about bytes);
 *   4. none of it depends on the DSH executable - the artwork and a font are the
 *      only inputs.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RESCUE_ICO_SIZES,
  RESCUE_LAYOUT,
  RESCUE_PAGE_SIZE,
  buildRescueFromDisk,
  encodePng,
  readRescueSources,
} from '../scripts/build-icon.mjs'
import {
  RESCUE_ICON_PATTERN,
  iconDataUriFromIco,
  pluginShortcutIcon,
  rescueInfo,
} from '../lib/rescue-paths.js'

const PLUGIN_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))

/** The rescue `.ico` this package ships, or ''. */
function shippedRescueIco() {
  const dir = path.join(PLUGIN_DIR, 'assets')
  const names = fs.readdirSync(dir).filter((name) => RESCUE_ICON_PATTERN.test(name)).sort()
  return names.length === 0 ? '' : path.join(dir, names[names.length - 1])
}

/** Parse an ICO container. */
function readIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICONDIR reserved field')
  assert.equal(buffer.readUInt16LE(2), 1, 'type 1 = icon')
  const count = buffer.readUInt16LE(4)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16
    entries.push({
      size: buffer[at] === 0 ? 256 : buffer[at],
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12),
    })
  }
  return { count, entries }
}

/** A 32-bpp DIB entry as RGBA, top-down. */
function dibToRgba(buffer, entry) {
  const size = entry.size
  const headerSize = buffer.readUInt32LE(entry.offset)
  assert.equal(headerSize, 40)
  const pixels = entry.offset + headerSize
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const sourceY = size - 1 - y
    for (let x = 0; x < size; x += 1) {
      const from = pixels + (sourceY * size + x) * 4
      const to = (y * size + x) * 4
      rgba[to] = buffer[from + 2]
      rgba[to + 1] = buffer[from + 1]
      rgba[to + 2] = buffer[from]
      rgba[to + 3] = buffer[from + 3]
    }
  }
  return rgba
}

/* ------------------------------------------------------------------ *
 * ① EVERY ENTRY IS A DIB, WITH NO AND MASK.
 * ------------------------------------------------------------------ */

test('1 the shipped rescue icon has seven DIB entries and no AND mask', () => {
  const icoPath = shippedRescueIco()
  assert.notEqual(icoPath, '', 'assets/icon-rescue-<sha8>.ico ships with the plugin')
  const buffer = fs.readFileSync(icoPath)
  const parsed = readIco(buffer)
  assert.equal(parsed.count, RESCUE_ICO_SIZES.length, 'seven sizes: ' + RESCUE_ICO_SIZES.join('/'))
  assert.deepEqual(
    parsed.entries.map((entry) => entry.size),
    RESCUE_ICO_SIZES.slice(),
    'small to large, exactly the sizes the shell asks for',
  )
  for (const entry of parsed.entries) {
    const payload = buffer.subarray(entry.offset, entry.offset + entry.bytes)
    assert.notEqual(payload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', entry.size + 'px: not a PNG entry')
    assert.equal(payload.readUInt32LE(0), 40, entry.size + 'px: BITMAPINFOHEADER')
    assert.equal(payload.readInt32LE(4), entry.size, entry.size + 'px: biWidth')
    assert.equal(payload.readInt32LE(8), entry.size * 2, entry.size + 'px: biHeight is XOR + AND')
    assert.equal(payload.readUInt32LE(16), 0, entry.size + 'px: BI_RGB')
    assert.equal(
      entry.bytes,
      40 + entry.size * entry.size * 4,
      entry.size + 'px: header + pixels, no AND mask (t10 measured why)',
    )
  }
})

/* ------------------------------------------------------------------ *
 * ② THE BADGE IS THE APPROVED COLOUR, WHERE THE APPROVED DRAWING PUTS IT.
 * ------------------------------------------------------------------ */

test('2 the badge disc is #2563EB and the ring around it is white', () => {
  const icoPath = shippedRescueIco()
  const buffer = fs.readFileSync(icoPath)
  const parsed = readIco(buffer)
  const largest = parsed.entries[parsed.entries.length - 1]
  const rgba = dibToRgba(buffer, largest)
  const size = largest.size
  const disc = RESCUE_LAYOUT.discRatio * size
  const margin = RESCUE_LAYOUT.marginRatio * size
  const centreX = Math.round(size - margin - disc / 2)
  const centreY = Math.round(size - margin - disc / 2)
  const at = (x, y) => (y * size + x) * 4
  const centre = at(centreX, centreY)
  assert.deepEqual(
    [rgba[centre], rgba[centre + 1], rgba[centre + 2]],
    [RESCUE_LAYOUT.fill.r, RESCUE_LAYOUT.fill.g, RESCUE_LAYOUT.fill.b],
    'the middle of the badge is #2563EB',
  )
  // The white ring sits just outside the disc.
  const ringRadius = Math.round(disc / 2 + RESCUE_LAYOUT.ringRatio * size / 2 - 1)
  const ring = at(centreX + ringRadius, centreY)
  assert.deepEqual([rgba[ring], rgba[ring + 1], rgba[ring + 2]], [255, 255, 255], 'the ring is white')

  // AND THE GLYPH IS REALLY THERE: white ink inside the blue disc, not a bare disc.
  let white = 0
  let blue = 0
  for (let y = centreY - Math.floor(disc / 2); y <= centreY + Math.floor(disc / 2); y += 1) {
    for (let x = centreX - Math.floor(disc / 2); x <= centreX + Math.floor(disc / 2); x += 1) {
      const dx = x - centreX
      const dy = y - centreY
      if (dx * dx + dy * dy > (disc / 2) * (disc / 2)) continue
      const pixel = at(x, y)
      if (rgba[pixel] > 200 && rgba[pixel + 1] > 200 && rgba[pixel + 2] > 200) white += 1
      else if (rgba[pixel + 2] > 150) blue += 1
    }
  }
  assert.ok(blue > 0, 'the disc is filled')
  assert.ok(white > blue * 0.02, 'the arrow is drawn in white on the disc: ' + white + ' white vs ' + blue + ' blue')
})

/* ------------------------------------------------------------------ *
 * ③ THE PAGE GETS THE SAME PICTURE - FROM THE SAME FILE.
 * ------------------------------------------------------------------ */

test('3 the data URI decodes to the 48 px entry of the shipped .ico', () => {
  const icoPath = shippedRescueIco()
  const buffer = fs.readFileSync(icoPath)
  const parsed = readIco(buffer)
  const entry = parsed.entries.find((candidate) => candidate.size === RESCUE_PAGE_SIZE)
  assert.ok(entry, 'the icon carries a 48 px entry')

  const decoded = iconDataUriFromIco(icoPath)
  assert.ok(decoded !== null, 'the 48 px entry decodes')
  assert.equal(decoded.size, RESCUE_PAGE_SIZE)
  assert.equal(decoded.dataUri.startsWith('data:image/png;base64,'), true)

  const png = Buffer.from(decoded.dataUri.slice('data:image/png;base64,'.length), 'base64')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG')
  assert.equal(png.readUInt32BE(16), RESCUE_PAGE_SIZE, '48 px wide')
  assert.equal(png.readUInt32BE(20), RESCUE_PAGE_SIZE, '48 px high')
  assert.equal(
    crypto.createHash('sha256').update(png).digest('hex').slice(0, 8),
    decoded.hash,
    'the hash the page is told is the hash of the bytes it was given',
  )

  // THE SAME PIXELS AS THE ENTRY THE SHELL DRAWS: re-encode the 48 px DIB with the
  // build script's own encoder and compare byte for byte.
  const expected = encodePng(dibToRgba(buffer, entry), RESCUE_PAGE_SIZE, RESCUE_PAGE_SIZE)
  assert.equal(png.equals(expected), true, 'the page PNG is the 48 px entry, re-encoded')
})

test('3 rescueInfo hands the page that picture and names the same file', () => {
  const info = rescueInfo({ pluginDir: PLUGIN_DIR, platform: 'win32', env: {} })
  assert.match(info.iconName, RESCUE_ICON_PATTERN, 'the shortcut names the rescue icon: ' + info.iconName)
  assert.equal(info.iconDataUriSize, RESCUE_PAGE_SIZE)
  assert.equal(info.iconDataUri.startsWith('data:image/png;base64,'), true, 'the page has a picture to show')
  assert.equal(/^[0-9a-f]{8}$/.test(info.iconDataUriHash), true, 'and a hash it can print: ' + info.iconDataUriHash)

  const viaIco = iconDataUriFromIco(info.iconPath)
  assert.equal(info.iconDataUri, viaIco.dataUri, 'and it came out of the very file the shortcut names')
})

/* ------------------------------------------------------------------ *
 * ④ NOTHING DEPENDS ON THE DSH EXECUTABLE.
 * ------------------------------------------------------------------ */

test('4 the icon builds from the artwork and a font - no executable, no host', () => {
  // The only two inputs are named here, and neither is the DSH binary: the exe
  // icon is a 32 px bitmap that blurs when scaled, which is why the user's
  // decision was "use resources/icon.png".
  const sources = readRescueSources()
  assert.equal(sources.artwork.width >= 256, true, 'the artwork is big enough to draw 256 px from')
  assert.ok(sources.unitsPerEm > 0)
  assert.ok(sources.glyphPolylines.length > 0, 'the U+21BB outline was read from the font')

  const built = buildRescueFromDisk()
  assert.equal(readIco(built.ico).count, RESCUE_ICO_SIZES.length)
  assert.equal(built.page.readUInt32BE(16), RESCUE_PAGE_SIZE, 'and the page PNG comes from the same run')
})

test('4 the resolver needs no app executable to answer', () => {
  // An environment with no `appExePath` at all - the hosted case - still resolves
  // the rescue icon, because the picture never came from the executable.
  const info = rescueInfo({ pluginDir: PLUGIN_DIR, platform: 'win32', env: { isDesktopApp: false } })
  assert.match(info.iconName, RESCUE_ICON_PATTERN)
  assert.equal(info.iconAvailable, true)

  // And a build is idempotent: the same inputs give the same bytes, which is what
  // makes the hashed file name meaningful.
  const first = buildRescueFromDisk().ico
  const second = buildRescueFromDisk().ico
  assert.equal(first.equals(second), true, 'two builds of the same drawing are byte-identical')
  assert.equal(
    crypto.createHash('sha256').update(first).digest('hex').slice(0, 8),
    path.basename(shippedRescueIco()).replace(/^icon-rescue-|\.ico$/g, ''),
    'and that is the hash the shipped file is named after',
  )
})

test('4 an older install with only the plain icon still gets a shortcut', (t) => {
  // The rescue file is new; a package without it must not lose its icon.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-branded-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.mkdirSync(path.join(base, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(base, 'assets', 'icon-abcdef12.ico'), 'not really an icon', 'utf8')
  const icon = pluginShortcutIcon({ pluginDir: base })
  assert.equal(path.basename(icon), 'icon-abcdef12.ico', 'the plain hashed icon is the fallback')
})
