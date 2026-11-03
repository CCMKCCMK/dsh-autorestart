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
 * A MINIMAL TRUETYPE READER (2026-11-02)
 *
 * WHY THIS EXISTS AT ALL: the approved shortcut icon is the DSH artwork with a
 * round restore badge in the corner, and that badge carries the glyph U+21BB
 * (CLOCKWISE OPEN CIRCLE ARROW) in Segoe UI Symbol. Drawing that glyph needs the
 * font outline, and this generator may not take a dependency (no canvas, no
 * browser, no ImageMagick). So the small part of TrueType that one glyph needs is
 * read here: `cmap` (formats 4 and 12) to find the glyph, `loca` + `glyf` for the
 * outline, and the contours are filled with a nonzero-winding scanline.
 *
 * WHAT IT DOES NOT DO: hinting, variations, colour fonts, kerning, shaping. One
 * glyph, no text layout, no instruction execution.
 * ------------------------------------------------------------------ */

/** Read the table directory of a .ttf/.otf and hand back a tag -> {offset} map. */
export function readTtfDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('not a font: too short')
  const tag = buffer.toString('ascii', 0, 4)
  if (tag !== '\u0000\u0001\u0000\u0000' && tag !== 'true' && tag !== 'OTTO') {
    throw new Error('not a TrueType/OpenType font: sfnt tag ' + JSON.stringify(tag))
  }
  const numTables = buffer.readUInt16BE(4)
  const tables = new Map()
  for (let index = 0; index < numTables; index += 1) {
    const at = 12 + index * 16
    tables.set(buffer.toString('ascii', at, at + 4), {
      offset: buffer.readUInt32BE(at + 8),
      length: buffer.readUInt32BE(at + 12),
    })
  }
  return tables
}

/** The glyph index for one code point, from `cmap` (formats 4 and 12). */
export function glyphIndexFor(buffer, tables, codePoint) {
  const cmap = tables.get('cmap')
  if (!cmap) throw new Error('the font has no cmap')
  const count = buffer.readUInt16BE(cmap.offset + 2)
  let best = null
  for (let index = 0; index < count; index += 1) {
    const at = cmap.offset + 4 + index * 8
    const platform = buffer.readUInt16BE(at)
    const encoding = buffer.readUInt16BE(at + 2)
    const subtable = cmap.offset + buffer.readUInt32BE(at + 4)
    const format = buffer.readUInt16BE(subtable)
    // (3,1)/(3,10) are what Windows uses; (0,x) is the Unicode platform.
    const score = (platform === 3 && encoding === 10 && format === 12) ? 4
      : (platform === 3 && encoding === 1 && format === 4) ? 3
        : (platform === 0 && (format === 4 || format === 12)) ? 1
          : 0
    if (score === 0) continue
    if (best === null || score > best.score) best = { score, subtable, format }
  }
  if (best === null) throw new Error('the font has no Unicode cmap subtable')
  if (best.format === 12) {
    const groups = buffer.readUInt32BE(best.subtable + 12)
    for (let index = 0; index < groups; index += 1) {
      const at = best.subtable + 16 + index * 12
      const start = buffer.readUInt32BE(at)
      const end = buffer.readUInt32BE(at + 4)
      if (codePoint >= start && codePoint <= end) return buffer.readUInt32BE(at + 8) + (codePoint - start)
    }
    return 0
  }
  const segCountX2 = buffer.readUInt16BE(best.subtable + 6)
  const endCodes = best.subtable + 14
  const startCodes = endCodes + segCountX2 + 2
  const idDeltas = startCodes + segCountX2
  const idRangeOffsets = idDeltas + segCountX2
  for (let index = 0; index < segCountX2 / 2; index += 1) {
    const end = buffer.readUInt16BE(endCodes + index * 2)
    if (codePoint > end) continue
    const start = buffer.readUInt16BE(startCodes + index * 2)
    if (codePoint < start) return 0
    const delta = buffer.readInt16BE(idDeltas + index * 2)
    const rangeOffset = buffer.readUInt16BE(idRangeOffsets + index * 2)
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff
    const glyphAt = idRangeOffsets + index * 2 + rangeOffset + (codePoint - start) * 2
    if (glyphAt + 1 >= buffer.length) return 0
    const glyph = buffer.readUInt16BE(glyphAt)
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff
  }
  return 0
}

/** Everything one glyph needs, from the font tables. */
export function readFont(buffer) {
  const tables = readTtfDirectory(buffer)
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const hhea = tables.get('hhea')
  const hmtx = tables.get('hmtx')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  if (!head || !maxp || !hhea || !hmtx || !loca || !glyf) throw new Error('the font is missing a required table')
  return {
    buffer,
    tables,
    unitsPerEm: buffer.readUInt16BE(head.offset + 18),
    longOffsets: buffer.readInt16BE(head.offset + 50) === 1,
    numGlyphs: buffer.readUInt16BE(maxp.offset + 4),
    numberOfHMetrics: buffer.readUInt16BE(hhea.offset + 34),
    hmtx,
    loca,
    glyf,
  }
}

/** The outline of one glyph as contours of {x, y, onCurve}, in font units. */
export function readGlyphOutline(font, glyphIndex, depth = 0) {
  if (depth > 8) return []
  if (!Number.isFinite(glyphIndex) || glyphIndex < 0 || glyphIndex >= font.numGlyphs) return []
  const buffer = font.buffer
  const locaAt = font.loca.offset + (font.longOffsets ? glyphIndex * 4 : glyphIndex * 2)
  const start = font.longOffsets ? buffer.readUInt32BE(locaAt) : buffer.readUInt16BE(locaAt) * 2
  const endAt = font.loca.offset + (font.longOffsets ? (glyphIndex + 1) * 4 : (glyphIndex + 1) * 2)
  const end = font.longOffsets ? buffer.readUInt32BE(endAt) : buffer.readUInt16BE(endAt) * 2
  if (end <= start) return []
  const at = font.glyf.offset + start
  const contours = buffer.readInt16BE(at)
  if (contours < 0) {
    // A composite glyph: place the components and let recursion do the rest.
    const out = []
    let cursor = at + 10
    for (let guard = 0; guard < 32; guard += 1) {
      const flags = buffer.readUInt16BE(cursor)
      const componentGlyph = buffer.readUInt16BE(cursor + 2)
      cursor += 4
      const words = (flags & 0x0001) !== 0
      let dx = 0
      let dy = 0
      if (flags & 0x0002) {
        if (words) { dx = buffer.readInt16BE(cursor); dy = buffer.readInt16BE(cursor + 2); cursor += 4 }
        else { dx = buffer.readInt8(cursor); dy = buffer.readInt8(cursor + 1); cursor += 2 }
      } else {
        cursor += words ? 4 : 2 // point matching is not needed for one glyph
      }
      if (flags & 0x0008) cursor += 2
      else if (flags & 0x0040) cursor += 4
      else if (flags & 0x0080) cursor += 8
      for (const contour of readGlyphOutline(font, componentGlyph, depth + 1)) {
        out.push(contour.map((point) => ({ x: point.x + dx, y: point.y + dy, onCurve: point.onCurve })))
      }
      if ((flags & 0x0020) === 0) break
    }
    return out
  }
  if (contours === 0) return []
  let cursor = at + 10
  const endPoints = []
  for (let index = 0; index < contours; index += 1) {
    endPoints.push(buffer.readUInt16BE(cursor))
    cursor += 2
  }
  const instructionLength = buffer.readUInt16BE(cursor)
  cursor += 2 + instructionLength
  const pointCount = endPoints[endPoints.length - 1] + 1
  const flags = []
  while (flags.length < pointCount) {
    const flag = buffer[cursor]
    cursor += 1
    flags.push(flag)
    if (flag & 0x08) {
      const repeat = buffer[cursor]
      cursor += 1
      for (let extra = 0; extra < repeat; extra += 1) flags.push(flag)
    }
  }
  const xs = []
  let x = 0
  for (const flag of flags) {
    if (flag & 0x02) {
      const short = buffer[cursor]
      cursor += 1
      x += (flag & 0x10) ? short : -short
    } else if ((flag & 0x10) === 0) {
      x += buffer.readInt16BE(cursor)
      cursor += 2
    }
    xs.push(x)
  }
  const ys = []
  let y = 0
  for (const flag of flags) {
    if (flag & 0x04) {
      const short = buffer[cursor]
      cursor += 1
      y += (flag & 0x20) ? short : -short
    } else if ((flag & 0x20) === 0) {
      y += buffer.readInt16BE(cursor)
      cursor += 2
    }
    ys.push(y)
  }
  const out = []
  let first = 0
  for (const last of endPoints) {
    const contour = []
    for (let index = first; index <= last; index += 1) {
      contour.push({ x: xs[index], y: ys[index], onCurve: (flags[index] & 0x01) !== 0 })
    }
    if (contour.length > 0) out.push(contour)
    first = last + 1
  }
  return out
}

/**
 * Flatten quadratic contours into polylines (font units).
 *
 * The TrueType rule for a run of off-curve points: each consecutive pair implies an
 * ON-curve midpoint. A contour that starts with an off-curve point starts at the
 * midpoint of the last and first point.
 */
export function flattenContours(contours) {
  const polylines = []
  for (const contour of contours) {
    if (contour.length === 0) continue
    const points = contour.slice()
    let startPoint
    if (points[0].onCurve) {
      startPoint = points[0]
      points.push(points.shift())
    } else if (points[points.length - 1].onCurve) {
      startPoint = points[points.length - 1]
    } else {
      const last = points[points.length - 1]
      startPoint = { x: (last.x + points[0].x) / 2, y: (last.y + points[0].y) / 2, onCurve: true }
    }
    const line = [{ x: startPoint.x, y: startPoint.y }]
    let current = { x: startPoint.x, y: startPoint.y }
    const queue = points.slice()
    for (let index = 0; index < queue.length; index += 1) {
      const point = queue[index]
      if (point.onCurve) {
        line.push({ x: point.x, y: point.y })
        current = { x: point.x, y: point.y }
        continue
      }
      const next = queue[index + 1] ?? { x: startPoint.x, y: startPoint.y, onCurve: true }
      const end = next.onCurve
        ? { x: next.x, y: next.y }
        : { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }
      const steps = 8 // fine enough that the curve reads as a curve
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps
        const mt = 1 - t
        line.push({
          x: mt * mt * current.x + 2 * mt * t * point.x + t * t * end.x,
          y: mt * mt * current.y + 2 * mt * t * point.y + t * t * end.y,
        })
      }
      current = end
      if (!next.onCurve) index += 1 // the implied midpoint was just consumed
    }
    if (line.length >= 3) polylines.push(line)
  }
  return polylines
}

/** Fill polylines into a coverage buffer (0 or 255 per sample), nonzero winding. */
export function fillPolylines(polylines, width, height, { coverage = null } = {}) {
  const buffer = coverage ?? new Uint8Array(width * height)
  const edges = []
  for (const line of polylines) {
    for (let index = 0; index < line.length; index += 1) {
      const from = line[index]
      const to = line[(index + 1) % line.length]
      if (from.y === to.y) continue
      edges.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y })
    }
  }
  for (let y = 0; y < height; y += 1) {
    const sampleY = y + 0.5
    const crossings = []
    for (const edge of edges) {
      const minY = Math.min(edge.y0, edge.y1)
      const maxY = Math.max(edge.y0, edge.y1)
      if (sampleY < minY || sampleY >= maxY) continue
      const t = (sampleY - edge.y0) / (edge.y1 - edge.y0)
      crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), winding: edge.y1 > edge.y0 ? 1 : -1 })
    }
    if (crossings.length === 0) continue
    crossings.sort((left, right) => left.x - right.x)
    let winding = 0
    for (let index = 0; index < crossings.length; index += 1) {
      const previous = crossings[index - 1]
      const from = index === 0 ? 0 : Math.ceil(previous.x - 0.5)
      const to = Math.ceil(crossings[index].x - 0.5)
      if (winding !== 0) {
        for (let x = Math.max(0, from); x < Math.min(width, to); x += 1) buffer[y * width + x] = 255
      }
      winding += crossings[index].winding
    }
  }
  return buffer
}

/* ------------------------------------------------------------------ *
 * THE RESCUE ICON: THE DSH ARTWORK WITH A RESTORE BADGE (user decision)
 *
 * The user looked at a 256 px preview of exactly this and said "use that one", so
 * the numbers below are a TRANSCRIPTION of the approved picture, not a new design.
 * Every size is DRAWN at that size (supersampled 4x, then box-downsampled); a 16 px
 * badge scaled down from a 256 px bitmap is a grey smudge, which is why the cache
 * rule in the task says "seven sizes, each drawn directly".
 * ------------------------------------------------------------------ */

/** The geometry the user approved, as fractions of the icon edge. */
export const RESCUE_LAYOUT = Object.freeze({
  discRatio: 0.375,      // badge disc diameter
  marginRatio: 0.039,    // disc bottom-right to canvas edge
  ringRatio: 0.047,      // white ring: disc plus this, on the diameter
  glyphRatio: 0.203,     // glyph size
  glyphLiftRatio: 0.012, // the glyph sits this much above the optical centre
  fill: Object.freeze({ r: 0x25, g: 0x63, b: 0xeb }), // #2563EB
  ink: Object.freeze({ r: 0xff, g: 0xff, b: 0xff }),
})

/** How many samples per output pixel the badge is drawn with. */
export const RESCUE_SUPERSAMPLE = 4

/** A filled circle into a coverage buffer, in sample-grid coordinates. */
function fillCircle(coverage, size, cx, cy, radius) {
  const minX = Math.max(0, Math.floor(cx - radius - 1))
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 1))
  const minY = Math.max(0, Math.floor(cy - radius - 1))
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 1))
  const r2 = radius * radius
  for (let y = minY; y <= maxY; y += 1) {
    const dy = y + 0.5 - cy
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy * dy <= r2) coverage[y * size + x] = 255
    }
  }
  return coverage
}

/**
 * Draw the badge onto a transparent RGBA canvas of `size` x `size`.
 *
 * @param {number} size
 * @param {{ glyphPolylines?: Array<Array<{x:number,y:number}>>, fontUnitsPerEm?: number }} [options]
 * @returns {Buffer} size*size RGBA
 */
export function drawRescueBadge(size, { glyphPolylines = [], fontUnitsPerEm = 2048 } = {}) {
  const samples = size * RESCUE_SUPERSAMPLE
  const disc = RESCUE_LAYOUT.discRatio * size
  const margin = RESCUE_LAYOUT.marginRatio * size
  const ring = disc + RESCUE_LAYOUT.ringRatio * size
  const cx = (size - margin - disc / 2) * RESCUE_SUPERSAMPLE
  const cy = (size - margin - disc / 2) * RESCUE_SUPERSAMPLE
  const ringCoverage = new Uint8Array(samples * samples)
  const discCoverage = new Uint8Array(samples * samples)
  fillCircle(ringCoverage, samples, cx, cy, (ring / 2) * RESCUE_SUPERSAMPLE)
  fillCircle(discCoverage, samples, cx, cy, (disc / 2) * RESCUE_SUPERSAMPLE)

  // THE GLYPH, scaled into the disc and drawn several times a hair apart: that is
  // the synthetic bold "Segoe UI Symbol Bold" stands for (the family ships no bold
  // face), and it is what the approved preview shows.
  const glyphCoverage = new Uint8Array(samples * samples)
  if (Array.isArray(glyphPolylines) && glyphPolylines.length > 0) {
    const targetPx = RESCUE_LAYOUT.glyphRatio * size
    const scale = (targetPx / fontUnitsPerEm) * RESCUE_SUPERSAMPLE
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const line of glyphPolylines) {
      for (const point of line) {
        if (point.x < minX) minX = point.x
        if (point.x > maxX) maxX = point.x
        if (point.y < minY) minY = point.y
        if (point.y > maxY) maxY = point.y
      }
    }
    if (Number.isFinite(minX) && maxX > minX) {
      const inkWidth = (maxX - minX) * scale
      const inkHeight = (maxY - minY) * scale
      const left = cx - inkWidth / 2 - minX * scale
      const bottom = cy + inkHeight / 2 + minY * scale // font Y grows up, the grid down
      const lift = RESCUE_LAYOUT.glyphLiftRatio * size * RESCUE_SUPERSAMPLE
      const bold = Math.max(0.5, 0.022 * targetPx * RESCUE_SUPERSAMPLE)
      for (const shift of [-bold, 0, bold]) {
        const placed = glyphPolylines.map((line) => line.map((point) => ({
          x: point.x * scale + left + shift,
          y: bottom - point.y * scale - lift,
        })))
        fillPolylines(placed, samples, samples, { coverage: glyphCoverage })
      }
    }
  }

  // Composite in sample space: ring (white), disc (blue), glyph (white), then
  // box-downsample to the output size - the same anti-aliasing the base uses.
  const canvas = Buffer.alloc(size * size * 4)
  const per = RESCUE_SUPERSAMPLE * RESCUE_SUPERSAMPLE
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < RESCUE_SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < RESCUE_SUPERSAMPLE; sx += 1) {
          const sample = (y * RESCUE_SUPERSAMPLE + sy) * samples + (x * RESCUE_SUPERSAMPLE + sx)
          let sr = 0
          let sg = 0
          let sb = 0
          let sa = 0
          if (ringCoverage[sample] !== 0) {
            sr = RESCUE_LAYOUT.ink.r; sg = RESCUE_LAYOUT.ink.g; sb = RESCUE_LAYOUT.ink.b; sa = 255
          }
          if (discCoverage[sample] !== 0) {
            sr = RESCUE_LAYOUT.fill.r; sg = RESCUE_LAYOUT.fill.g; sb = RESCUE_LAYOUT.fill.b; sa = 255
          }
          if (glyphCoverage[sample] !== 0) {
            sr = RESCUE_LAYOUT.ink.r; sg = RESCUE_LAYOUT.ink.g; sb = RESCUE_LAYOUT.ink.b; sa = 255
          }
          r += sr; g += sg; b += sb; a += sa
        }
      }
      const at = (y * size + x) * 4
      canvas[at] = Math.round(r / per)
      canvas[at + 1] = Math.round(g / per)
      canvas[at + 2] = Math.round(b / per)
      canvas[at + 3] = Math.round(a / per)
    }
  }
  return canvas
}

/** Alpha-composite `top` (size*size RGBA) over `bottom` (same size). */
export function compositeOver(bottom, top) {
  const out = Buffer.from(bottom)
  for (let at = 0; at < out.length; at += 4) {
    const topAlpha = top[at + 3] / 255
    if (topAlpha <= 0) continue
    const bottomAlpha = out[at + 3] / 255
    const outAlpha = topAlpha + bottomAlpha * (1 - topAlpha)
    if (outAlpha <= 0) continue
    for (let channel = 0; channel < 3; channel += 1) {
      const value = (top[at + channel] * topAlpha + out[at + channel] * bottomAlpha * (1 - topAlpha)) / outAlpha
      out[at + channel] = Math.round(Math.min(255, Math.max(0, value)))
    }
    out[at + 3] = Math.round(outAlpha * 255)
  }
  return out
}

/**
 * The whole rescue set: the artwork with the badge, one bitmap per size, each drawn
 * at its own size (never scaled from a bigger one).
 *
 * @param {{ width: number, height: number, data: Buffer }} artwork
 * @param {Array<Array<{x:number,y:number}>>} glyphPolylines in font units
 * @param {number} unitsPerEm
 * @param {{ sizes?: number[] }} [options]
 * @returns {Map<number, Buffer>} size -> size*size RGBA
 */
export function buildRescueBitmaps(artwork, glyphPolylines, unitsPerEm, { sizes = RESCUE_SIZES } = {}) {
  const bitmaps = new Map()
  for (const size of sizes) {
    const base = resizeSquare(artwork, size)
    const badge = drawRescueBadge(size, { glyphPolylines, fontUnitsPerEm: unitsPerEm })
    bitmaps.set(size, compositeOver(base, badge))
  }
  return bitmaps
}

/** Encode an RGBA bitmap as a PNG (node:zlib is enough; no dependencies). */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (let index = 0; index < buffer.length; index += 1) {
      crc ^= buffer[index]
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * THE RESCUE ICON SET, ON DISK
 *
 * NAMING (deliberate): the sha8 is taken from the ICO bytes - the artifact the
 * desktop actually uses - and BOTH files carry it, so `icon-rescue-<sha8>.ico` and
 * `icon-rescue-<sha8>.png` are two renderings of one build. The bytes the settings
 * page shows are the 48 px PNG rendered by the same code, and `iconDataUriHash`
 * states that PNG's own sha8, so "the page and the shortcut are the same drawing"
 * is checkable instead of asserted.
 * ------------------------------------------------------------------ */

/** The seven sizes the shell asks for, plus the 256 the page previews. */
export const RESCUE_ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 180])
export const RESCUE_SIZES = Object.freeze([...RESCUE_ICO_SIZES, 256])
/** The size whose pixels the settings page is given. */
export const RESCUE_PAGE_SIZE = 48
/** The size whose pixels ship as the preview PNG. */
export const RESCUE_PREVIEW_SIZE = 256

/** The DSH artwork the user approved as the base (never the exe's 32 px bitmap). */
export const RESCUE_ARTWORK = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/icon.png'
/** The font the approved preview used for U+21BB. */
export const RESCUE_FONT = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'seguisym.ttf')
/** The code point of the glyph on the badge. */
export const RESCUE_GLYPH = 0x21bb

/** Every drawing input the rescue icon needs, read from disk. */
export function readRescueSources({ artworkPath = RESCUE_ARTWORK, fontPath = RESCUE_FONT } = {}) {
  const artwork = decodePng(fs.readFileSync(artworkPath))
  const font = readFont(fs.readFileSync(fontPath))
  const glyphIndex = glyphIndexFor(font.buffer, font.tables, RESCUE_GLYPH)
  if (glyphIndex === 0) throw new Error('the font has no glyph for U+21BB: ' + fontPath)
  const glyphPolylines = flattenContours(readGlyphOutline(font, glyphIndex))
  if (glyphPolylines.length === 0) throw new Error('the U+21BB glyph in ' + fontPath + ' has an empty outline')
  return { artwork, glyphPolylines, unitsPerEm: font.unitsPerEm }
}

/**
 * Build the whole rescue set from disk.
 *
 * @returns {{ ico: Buffer, png: Buffer, page: Buffer, sizes: number[] }}
 */
export function buildRescueFromDisk(options = {}) {
  const { artwork, glyphPolylines, unitsPerEm } = readRescueSources(options)
  const bitmaps = buildRescueBitmaps(artwork, glyphPolylines, unitsPerEm)
  const entries = RESCUE_ICO_SIZES.map((size) => ({ size, rgba: bitmaps.get(size) }))
  const ico = buildIcoFromBitmaps(entries)
  return {
    ico,
    png: encodePng(bitmaps.get(RESCUE_PREVIEW_SIZE), RESCUE_PREVIEW_SIZE, RESCUE_PREVIEW_SIZE),
    page: encodePng(bitmaps.get(RESCUE_PAGE_SIZE), RESCUE_PAGE_SIZE, RESCUE_PAGE_SIZE),
    sizes: RESCUE_SIZES.slice(),
  }
}

/** An ICO from ready-made bitmaps - DIB entries, no AND mask (see encodeDibEntry). */
export function buildIcoFromBitmaps(entries) {
  const payloads = entries.map((entry) => ({ size: entry.size, payload: encodeDibEntry(entry.rgba, entry.size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(payloads.length, 4)
  const directory = Buffer.alloc(payloads.length * 16)
  let offset = 6 + payloads.length * 16
  payloads.forEach((entry, index) => {
    const at = index * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.payload.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.payload.length
  })
  return Buffer.concat([header, directory, ...payloads.map((entry) => entry.payload)])
}

/** The sha8 both rescue files are named after: the ICO's own content. */
export function rescueHashOf(icoBytes) {
  return crypto.createHash('sha256').update(icoBytes).digest('hex').slice(0, 8)
}

/** Where this build's rescue files belong. */
export function rescueAssetPaths(icoBytes) {
  const hash = rescueHashOf(icoBytes)
  return {
    hash,
    ico: path.join(ASSETS_DIR, 'icon-rescue-' + hash + '.ico'),
    png: path.join(ASSETS_DIR, 'icon-rescue-' + hash + '.png'),
  }
}

/** The rescue files currently shipped (newest hashed name), or nulls. */
export function shippedRescuePaths() {
  let names = []
  try {
    names = fs.readdirSync(ASSETS_DIR)
  } catch {
    return { ico: '', png: '' }
  }
  const ico = names.filter((name) => /^icon-rescue-[0-9a-f]{8}\.ico$/i.test(name)).sort()
  const png = names.filter((name) => /^icon-rescue-[0-9a-f]{8}\.png$/i.test(name)).sort()
  return {
    ico: ico.length > 0 ? path.join(ASSETS_DIR, ico[ico.length - 1]) : '',
    png: png.length > 0 ? path.join(ASSETS_DIR, png[png.length - 1]) : '',
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check')
  // TWO ICONS, TWO MODES. `--rescue` builds the one the user approved (artwork +
  // restore badge); without it the plain artwork is rebuilt, which is what the
  // package used before and what the settings page shows as the plugin's own mark.
  const rescue = process.argv.includes('--rescue')
  const built = rescue ? buildRescueFromDisk() : { ico: buildIconFromDisk(), png: null }
  if (rescue) {
    const target = rescueAssetPaths(built.ico)
    if (checkOnly) {
      const shipped = shippedRescuePaths()
      if (shipped.ico === '') {
        console.error('no assets/icon-rescue-<hash>.ico is shipped; run: node scripts/build-icon.mjs --rescue')
        process.exit(1)
      }
      if (path.basename(shipped.ico) !== path.basename(target.ico)) {
        console.error('the shipped rescue icon is stale: ' + path.basename(shipped.ico)
          + ' (expected ' + path.basename(target.ico) + ')')
        console.error('run: node scripts/build-icon.mjs --rescue')
        process.exit(1)
      }
      const pngOnDisk = fs.existsSync(shipped.png) ? fs.readFileSync(shipped.png) : null
      if (pngOnDisk === null || !pngOnDisk.equals(built.png)) {
        console.error('the shipped rescue preview PNG is missing or stale: ' + path.basename(shipped.png))
        process.exit(1)
      }
      console.log('assets/' + path.basename(shipped.ico) + ' + ' + path.basename(shipped.png)
        + ' match the approved drawing (' + built.ico.length + ' bytes, '
        + RESCUE_ICO_SIZES.length + ' DIB entries)')
      process.exit(0)
    }
    // ONE RESCUE ICON AT A TIME: a stale sibling keeps the old cache key alive.
    for (const name of fs.readdirSync(ASSETS_DIR)) {
      if (!/^icon-rescue-[0-9a-f]{8}\.(ico|png)$/i.test(name)) continue
      if (name === path.basename(target.ico) || name === path.basename(target.png)) continue
      fs.rmSync(path.join(ASSETS_DIR, name), { force: true })
      console.log('removed the superseded rescue icon: ' + name)
    }
    fs.writeFileSync(target.ico, built.ico)
    fs.writeFileSync(target.png, built.png)
    console.log('wrote ' + target.ico + ' (' + built.ico.length + ' bytes, '
      + RESCUE_ICO_SIZES.length + ' DIB entries: ' + RESCUE_ICO_SIZES.join('/') + ')')
    console.log('wrote ' + target.png + ' (' + built.png.length + ' bytes, '
      + RESCUE_PREVIEW_SIZE + ' px preview)')
    process.exit(0)
  }
  const target = targetIcoPath(built.ico)
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
    console.log('assets/' + path.basename(shipped) + ' matches the artwork (' + built.ico.length + ' bytes, all DIB entries)')
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
  fs.writeFileSync(target, built.ico)
  console.log('wrote ' + target + ' (' + built.ico.length + ' bytes, ' + ICON_SIZES.length + ' DIB entries: ' + ICON_SIZES.join('/') + ')')
}
