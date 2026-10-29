// The Figma Community listing images (COMMUNITY_LISTING.md → Assets): their names, sizes and PNG metadata, and the
// small PNG reader and writer that scripts/listing-art.mjs and test/listing.test.ts share. No dependencies: PNGs are
// read and written with node:zlib (deflate and CRC-32).
import { readFileSync } from "node:fs"
import { crc32, deflateSync, inflateSync } from "node:zlib"

export const LISTING_DIR = new URL("../listing/", import.meta.url)
export const LISTING_COMMENT = "ReRune for Figma listing art (listing/src/art.html)"
export const LISTING_SOFTWARE = "scripts/listing-art.mjs"

// `shot`: the plugin screen in the picture (scripts/ui-harness.mjs scenario, captured into listing/src/shots).
// `fullBuildOnly`: shows Dev Mode, so it belongs only to the full build's listing.
export const LISTING_IMAGES = {
  "icon-128.png": { width: 128, height: 128, title: "ReRune for Figma icon" },
  "cover-1920x1080.png": { width: 1920, height: 1080, title: "ReRune for Figma cover", shot: "layers-light" },
  "carousel-1-link.png": { width: 1920, height: 1080, title: "Link layers to keys", shot: "layers-light" },
  "carousel-2-push.png": { width: 1920, height: 1080, title: "Push copy as drafts", shot: "push-light" },
  "carousel-3-preview.png": { width: 1920, height: 1080, title: "Preview every language", shot: "preview-light" },
  "carousel-4-qa.png": { width: 1920, height: 1080, title: "Catch overflow before it ships", shot: "qa-dark" },
  "carousel-5-dev-mode.png": { width: 1920, height: 1080, title: "Keys and snippets in Dev Mode", shot: "inspect-light", fullBuildOnly: true },
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// Reads a PNG's chunks (checking every CRC), its size, bit depth, colour type and tEXt entries, and the IDAT stream.
export function readPng(bytes) {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Not a PNG file")
  }
  const result = { width: 0, height: 0, bitDepth: 0, colorType: 0, interlace: 0, text: {}, idat: [] }
  let offset = 8
  let ended = false
  while (offset < data.length && !ended) {
    const length = data.readUInt32BE(offset)
    const type = data.toString("latin1", offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (data.readUInt32BE(offset + 8 + length) !== crc32(data.subarray(offset + 4, offset + 8 + length))) {
      throw new Error(`Bad CRC in the ${type} chunk`)
    }
    if (type === "IHDR") {
      result.width = body.readUInt32BE(0)
      result.height = body.readUInt32BE(4)
      result.bitDepth = body[8]
      result.colorType = body[9]
      result.interlace = body[12]
    } else if (type === "tEXt") {
      const split = body.indexOf(0)
      result.text[body.toString("latin1", 0, split)] = body.toString("latin1", split + 1)
    } else if (type === "IDAT") {
      result.idat.push(body)
    } else if (type === "IEND") {
      ended = true
    }
    offset += 12 + length
  }
  if (!ended) {
    throw new Error("PNG has no IEND chunk")
  }
  return { ...result, inflate: () => inflateSync(Buffer.concat(result.idat)) }
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// The pixels of an 8-bit, non-interlaced grey, RGB or RGBA PNG as RGB (alpha composited over `background`).
export function decodeRgb(bytes, background = [255, 255, 255]) {
  const png = readPng(bytes)
  const channels = CHANNELS[png.colorType]
  if (png.bitDepth !== 8 || png.interlace !== 0 || channels === undefined) {
    throw new Error("Only 8-bit, non-interlaced grey, RGB or RGBA PNGs are supported")
  }
  const raw = png.inflate()
  const stride = png.width * channels
  const pixels = Buffer.alloc(stride * png.height)
  for (let row = 0; row < png.height; row++) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const out = pixels.subarray(row * stride, (row + 1) * stride)
    const up = row > 0 ? pixels.subarray((row - 1) * stride, row * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = up !== null ? up[i] : 0
      const c = up !== null && i >= channels ? up[i - channels] : 0
      const x = line[i]
      out[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff
    }
  }
  const rgb = Buffer.alloc(png.width * png.height * 3)
  for (let i = 0; i < png.width * png.height; i++) {
    const at = i * channels
    const [r, g, b] = channels >= 3 ? [pixels[at], pixels[at + 1], pixels[at + 2]] : [pixels[at], pixels[at], pixels[at]]
    const alpha = channels === 4 ? pixels[at + 3] / 255 : channels === 2 ? pixels[at + 1] / 255 : 1
    rgb[i * 3] = Math.round(r * alpha + background[0] * (1 - alpha))
    rgb[i * 3 + 1] = Math.round(g * alpha + background[1] * (1 - alpha))
    rgb[i * 3 + 2] = Math.round(b * alpha + background[2] * (1 - alpha))
  }
  return { width: png.width, height: png.height, rgb }
}

// An 8-bit RGB PNG (opaque by construction) with tEXt entries; each row takes the filter that compresses it best.
export function encodeRgbPng({ width, height, rgb }, text) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const stride = width * 3
  const out = Buffer.alloc((stride + 1) * height)
  const candidate = Buffer.alloc(stride)
  for (let row = 0; row < height; row++) {
    const line = rgb.subarray(row * stride, (row + 1) * stride)
    const up = row > 0 ? rgb.subarray((row - 1) * stride, row * stride) : null
    let best = -1
    let bestScore = Infinity
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? line[i - 3] : 0
        const b = up !== null ? up[i] : 0
        const c = up !== null && i >= 3 ? up[i - 3] : 0
        const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c)
        const value = (line[i] - predicted) & 0xff
        candidate[i] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) {
        bestScore = score
        best = filter
        out[row * (stride + 1)] = filter
        candidate.copy(out, row * (stride + 1) + 1)
      }
    }
    if (best < 0) throw new Error("unreachable")
  }
  const texts = Object.entries(text).map(([keyword, value]) => chunk("tEXt", Buffer.from(keyword + "\0" + value, "latin1")))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...texts,
    chunk("IDAT", deflateSync(out, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function readListingFile(name) {
  return readFileSync(new URL(name, LISTING_DIR))
}
