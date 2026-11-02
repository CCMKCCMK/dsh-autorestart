#!/usr/bin/env node
/**
 * Build `assets/icon.ico` from `assets/icon-180.png` - DIB entries only.
 *
 * WHY THIS EXISTS AT ALL (user report, 2026-11-02: "the desktop shortcut still
 * shows no icon", while `IconLocation` pointed at this very file and the file was
 * there).
 *
 * MEASURED ON THE REAL MACHINE: the ICO that shipped was built by Pillow with
 * PNG-compressed entries for every size (16/24/32/48/64/128/180 - all `PNG`).
 * The classic Windows icon path - `ExtractIconEx`, `SHGetFileInfo`,
 * `System.Drawing.Icon`, and Explorer's own image list - reads ICO entries as
 * DIBs. Handed a PNG entry it does not fail loudly, it decodes the PNG bytes as
 * raw pixels and paints garbage. Rendering the same 32x32 tile three ways:
 *
 *   System.Drawing.Icon(png-entry ico)  -> random noise  ("+:=.  .- #++ =%::*%:")
 *   System.Drawing.Icon(dib-entry ico)  -> the ring + flame of the plugin's mark
 *   shell drawing a .lnk -> DIB ico     -> the mark, plus the shortcut arrow
 *   shell drawing the real desktop .lnk -> a solid bright block (the bug)
 *
 * The control ("same .lnk format, `shell32.dll,3`") drew correctly, so the probe
 * and the quoting are fine: PNG entries were the whole problem.
 *
 * WHY A SCRIPT AND NOT A ONE-OFF: an icon that can only be rebuilt by whoever
 * happens to have Pillow installed is an icon that will drift. This reads the
 * shipped PNG with `node:zlib` only (no dependencies), so `node scripts/build-icon.mjs`
 * reproduces the artifact byte for byte, and the test suite can assert that.
 *
 * USAGE
 *   node scripts/build-icon.mjs            # write assets/icon-<hash>.ico
 *   node scripts/build-icon.mjs --check    # compare with the shipped file, do not write
 *
 * WHY THE FILE NAME CARRIES A HASH (user report, 2026-11-02, the second half of
 * "still no icon"). Explorer caches the icon it drew PER ICON FILE PATH. Once it
 * had cached "...\assets\icon.ico,0" while that file was the broken all-PNG one,
 * fixing the file changed nothing: rewriting the shortcut, even deleting and
 * recreating it, kept showing the cached garbage - measured, not guessed. A new
 * PATH is a new cache entry, so the shipped name embeds the content hash and an
 * update that changes the artwork necessarily changes the path.
 *
 * Sizes are capped at 180 (the artwork's own size): a 256 entry is the one size
 * a DIB cannot carry, and a PNG entry for it would bring the whole bug back.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.dirname(HERE)
export const SOURCE_PNG = path.join(PLUGIN_DIR, 'assets', 'icon-180.png')
export const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets')

/** The shipped icon's name carries its content: a new build is a new cache key. */
export function iconFileNameFor(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  return 'icon-' + digest + '.ico'
}

/** Where the icon for this artwork belongs. */
export function targetIcoPath(bytes) {
  return path.join(ASSETS_DIR, iconFileNameFor(bytes))
}

/** The icon file the plugin currently ships (the newest hashed one). */
export function shippedIcoPath() {
  let names = []
  try {
    names = fs.readdirSync(ASSETS_DIR)
  } catch {
    return ''
  }
  const hashed = names.filter((name) => /^icon-[0-9a-f]{8}\.ico$/i.test(name)).sort()
  return hashed.length > 0 ? path.join(ASSETS_DIR, hashed[hashed.length - 1]) : ''
}

/** The sizes the shell asks for, small to large. */
export const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 180])

/* ------------------------------------------------------------------ *
 * PNG reading (node:zlib only - no dependencies, no native modules)
 * ------------------------------------------------------------------ */

/**
 * Decode an 8-bit RGBA (colour type 6) PNG into `{ width, height, data }`.
 *
 * Deliberately narrow: the artwork this project ships is an 8-bit RGBA PNG, and
 * guessing at every PNG variant here would be a second image library. Anything
 * else is refused with a sentence instead of a wrong icon.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, data: Buffer }}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('not a PNG: too short')
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG: bad signature')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end > buffer.length) throw new Error('not a PNG: truncated chunk ' + type)
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start)
      height = buffer.readUInt32BE(start + 4)
      bitDepth = buffer[start + 8]
      colorType = buffer[start + 9]
      const interlace = buffer[start + 12]
      if (bitDepth !== 8) throw new Error('unsupported PNG: bit depth ' + bitDepth + ' (need 8)')
      if (colorType !== 6) throw new Error('unsupported PNG: colour type ' + colorType + ' (need 6 = RGBA)')
      if (interlace !== 0) throw new Error('unsupported PNG: interlaced')
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4 // + CRC
  }
  if (width <= 0 || height <= 0) throw new Error('not a PNG: no IHDR')
  if (idat.length === 0) throw new Error('not a PNG: no IDAT')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  if (raw.length < (stride + 1) * height) throw new Error('not a PNG: image data is short')
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const current = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x]
      const left = x >= 4 ? current[x - 4] : 0
      const up = previous[x]
      const upLeft = x >= 4 ? previous[x - 4] : 0
      let value
      switch (filter) {
        case 0: value = rawByte; break
        case 1: value = rawByte + left; break
        case 2: value = rawByte + up; break
        case 3: value = rawByte + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft)
          value = rawByte + predictor
          break
        }
        default: throw new Error('not a PNG: unknown filter ' + filter + ' on row ' + y)
      }
      current[x] = value & 0xff
    }
    current.copy(out, y * stride)
    previous = current
  }
  return { width, height, data: out }
}

/**
 * Box-filter downscale to a square size. Averaging is what makes a 180 px mark
 * legible at 16 px; nearest-neighbour turns the flame into a smear.
 *
 * @param {{ width: number, height: number, data: Buffer }} image
 * @param {number} size
 * @returns {Buffer} size*size RGBA
 */
export function resizeSquare(image, size) {
  const { width, height, data } = image
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor((y * height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size))
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor((x * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * width + sx) * 4
          // PREMULTIPLIED WEIGHT: transparent pixels must not darken the edge.
          const alpha = data[at + 3] / 255
          r += data[at] * alpha
          g += data[at + 1] * alpha
          b += data[at + 2] * alpha
          a += alpha
          weight += 1
        }
      }
      const at = (y * size + x) * 4
      if (a > 0) {
        out[at] = Math.round(r / a)
        out[at + 1] = Math.round(g / a)
        out[at + 2] = Math.round(b / a)
      }
      out[at + 3] = Math.round((a / Math.max(1, weight)) * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * ICO writing - DIB (BITMAPINFOHEADER + BGRA) entries only
 * ------------------------------------------------------------------ */

/**
 * One DIB entry: BITMAPINFOHEADER + bottom-up BGRA rows.
 *
 * NO AND MASK, ON PURPOSE - and this was MEASURED, not assumed. With a 32-bpp
 * entry the alpha channel carries the transparency; the AND mask is the legacy
 * 1-bit form for the same job, and when both are present this Windows build
 * applies the mask over the alpha and draws a ghost (the mark reduced to its
 * outline). The three builds, each in its own shortcut so the shell had no cache
 * to reuse, rendered:
 *
 *   mask omitted      -> the ring + flame (the artwork)   <- this build
 *   mask = alpha<128  -> outline only, everything else blank
 *   mask = inverted   -> outline only, everything else blank
 *
 * Pillow's ICO writer also omits the mask for 32-bpp entries (its 32 px entry is
 * 40 + 32*32*4 bytes, exactly what this writes), which is why its files always
 * rendered correctly and mine did not.
 *
 * @param {Buffer} rgba size*size RGBA
 * @param {number} size
 * @returns {Buffer}
 */
export function encodeDibEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight (XOR + AND), the icon convention
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // biSizeImage
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    // Bottom-up, as every DIB is.
    const sourceY = size - 1 - y
    for (let x = 0; x < size; x += 1) {
      const from = (sourceY * size + x) * 4
      const to = (y * size + x) * 4
      pixels[to] = rgba[from + 2] // B
      pixels[to + 1] = rgba[from + 1] // G
      pixels[to + 2] = rgba[from] // R
      pixels[to + 3] = rgba[from + 3] // A
    }
  }
  return Buffer.concat([header, pixels])
}

/**
 * Build the whole `.ico` from an RGBA image.
 *
 * @param {{ width: number, height: number, data: Buffer }} image
 * @param {number[]} [sizes]
 * @returns {Buffer}
 */
export function buildIco(image, sizes = ICON_SIZES) {
  const entries = sizes.map((size) => ({ size, payload: encodeDibEntry(resizeSquare(image, size), size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16
  entries.forEach((entry, index) => {
    const at = index * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size // width (0 = 256)
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size // height
    directory[at + 2] = 0 // colour count (0 = truecolour)
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.payload.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.payload.length
  })
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.payload)])
}

/** Read the artwork and build the icon, from disk. */
export function buildIconFromDisk() {
  return buildIco(decodePng(fs.readFileSync(SOURCE_PNG)))
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check')
  const built = buildIconFromDisk()
  const target = targetIcoPath(built)
  if (checkOnly) {
    const shipped = shippedIcoPath()
    if (shipped === '') {
      console.error('no assets/icon-<hash>.ico is shipped; run: node scripts/build-icon.mjs')
      process.exit(1)
    }
    if (path.basename(shipped) !== path.basename(target)) {
      console.error('the shipped icon is stale: ' + path.basename(shipped) + ' (expected ' + path.basename(target) + ')')
      console.error('run: node scripts/build-icon.mjs')
      process.exit(1)
    }
    console.log('assets/' + path.basename(shipped) + ' matches the artwork (' + built.length + ' bytes, all DIB entries)')
    process.exit(0)
  }
  // ONE ICON AT A TIME: a stale sibling would keep the old cache key alive.
  for (const name of fs.readdirSync(ASSETS_DIR)) {
    if (!/^icon(-[0-9a-f]{8})?\.ico$/i.test(name)) continue
    const full = path.join(ASSETS_DIR, name)
    if (path.basename(target) === name) continue
    fs.rmSync(full, { force: true })
    console.log('removed the superseded icon: ' + name)
  }
  fs.writeFileSync(target, built)
  console.log('wrote ' + target + ' (' + built.length + ' bytes, ' + ICON_SIZES.length + ' DIB entries: ' + ICON_SIZES.join('/') + ')')
}
