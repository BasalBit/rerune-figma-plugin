// Placeholder images for the Figma Community listing (COMMUNITY_LISTING.md → Assets). They only have the right sizes
// and say PLACEHOLDER on them: replace both with real artwork before publishing.
//
//   node scripts/listing-placeholders.mjs     writes listing/icon-128.png and listing/cover-1920x1080.png
//
// No dependencies: PNGs are written with node:zlib (deflate and CRC-32) and text uses a built-in 5×7 pixel font.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { crc32, deflateSync, inflateSync } from "node:zlib"

export const PLACEHOLDER_MARKER = "PLACEHOLDER: replace this image before publishing the plugin."
export const LISTING_DIR = new URL("../listing/", import.meta.url)

const NAVY = [15, 23, 42] // ReRune navy, hsl(222 47% 11%)
const AMBER = [246, 168, 35] // ReRune amber, hsl(38 92% 55%)
const WHITE = [255, 255, 255]
const SLATE = [148, 163, 184]

// 5×7 glyphs, one string per row, "#" = ink. Uppercase only.
const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "×": [".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "....."],
}

class Canvas {
  constructor(width, height, color) {
    this.width = width
    this.height = height
    this.pixels = new Uint8Array(width * height * 3)
    this.rect(0, 0, width, height, color)
  }

  rect(x, y, width, height, color) {
    const x0 = Math.max(0, x)
    const y0 = Math.max(0, y)
    const x1 = Math.min(this.width, x + width)
    const y1 = Math.min(this.height, y + height)
    for (let row = y0; row < y1; row++) {
      for (let column = x0; column < x1; column++) {
        this.pixels.set(color, (row * this.width + column) * 3)
      }
    }
  }

  // Diagonal warning stripes, the usual "not final" sign.
  stripes(x, y, width, height, a, b, period) {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const color = Math.floor((column + row) / period) % 2 === 0 ? a : b
        this.pixels.set(color, (row * this.width + column) * 3)
      }
    }
  }

  textWidth(text, scale) {
    return (text.length * 6 - 1) * scale
  }

  text(text, x, y, scale, color) {
    for (let i = 0; i < text.length; i++) {
      const glyph = FONT[text[i]]
      if (glyph === undefined) {
        throw new Error(`No glyph for "${text[i]}"`)
      }
      glyph.forEach((line, row) => {
        for (let column = 0; column < 5; column++) {
          if (line[column] === "#") {
            this.rect(x + (i * 6 + column) * scale, y + row * scale, scale, scale, color)
          }
        }
      })
    }
  }

  centeredText(text, y, scale, color) {
    this.text(text, Math.round((this.width - this.textWidth(text, scale)) / 2), y, scale, color)
  }
}

function renderIcon() {
  const canvas = new Canvas(128, 128, NAVY)
  canvas.centeredText("R", 14, 11, WHITE)
  canvas.stripes(0, 98, 128, 30, AMBER, NAVY, 8)
  canvas.rect(14, 103, 100, 19, AMBER)
  canvas.centeredText("PLACEHOLDER", 109, 1, NAVY)
  return canvas
}

function renderCover() {
  const canvas = new Canvas(1920, 1080, NAVY)
  canvas.stripes(0, 0, 1920, 56, AMBER, NAVY, 40)
  canvas.stripes(0, 1024, 1920, 56, AMBER, NAVY, 40)
  canvas.centeredText("RERUNE FOR FIGMA", 200, 14, WHITE)
  canvas.centeredText("LINK FIGMA TEXT TO RERUNE TRANSLATION KEYS,", 380, 5, SLATE)
  canvas.centeredText("PUSH COPY AS DRAFTS AND PREVIEW EVERY LANGUAGE.", 440, 5, SLATE)
  canvas.rect(160, 600, 1600, 220, AMBER)
  canvas.centeredText("PLACEHOLDER", 640, 12, NAVY)
  canvas.centeredText("REPLACE BEFORE PUBLISHING", 760, 5, NAVY)
  canvas.centeredText("COVER 1920 × 1080 - MADE BY SCRIPTS/LISTING-PLACEHOLDERS.MJS", 920, 3, SLATE)
  return canvas
}

export const PLACEHOLDERS = {
  "icon-128.png": { width: 128, height: 128, title: "ReRune Figma plugin icon (placeholder)", render: renderIcon },
  "cover-1920x1080.png": { width: 1920, height: 1080, title: "ReRune Figma plugin cover (placeholder)", render: renderCover },
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// Scanlines with filter type 0 (none) before each row, as the PNG IDAT stream wants them.
export function scanlines(canvas) {
  const stride = canvas.width * 3
  const out = Buffer.alloc((stride + 1) * canvas.height)
  for (let row = 0; row < canvas.height; row++) {
    out[row * (stride + 1)] = 0
    out.set(canvas.pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }
  return out
}

export function encodePng(canvas, text) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(canvas.width, 0)
  header.writeUInt32BE(canvas.height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolour RGB, deflate, adaptive filtering, no interlace
  const texts = Object.entries(text).map(([keyword, value]) => chunk("tEXt", Buffer.from(keyword + "\0" + value, "latin1")))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...texts,
    chunk("IDAT", deflateSync(scanlines(canvas), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function placeholderPng(name) {
  const spec = PLACEHOLDERS[name]
  const canvas = spec.render()
  return { canvas, png: encodePng(canvas, { Title: spec.title, Comment: PLACEHOLDER_MARKER, Software: "scripts/listing-placeholders.mjs" }) }
}

// Reads a PNG's chunks (checking every CRC), its size and tEXt entries, and the inflated IDAT stream.
export function readPng(bytes) {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Not a PNG file")
  }
  const result = { width: 0, height: 0, bitDepth: 0, colorType: 0, text: {}, idat: [] }
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

export function readListingFile(name) {
  return readFileSync(new URL(name, LISTING_DIR))
}

function main() {
  mkdirSync(LISTING_DIR, { recursive: true })
  for (const name of Object.keys(PLACEHOLDERS)) {
    const { png } = placeholderPng(name)
    writeFileSync(new URL(name, LISTING_DIR), png)
    console.log(`wrote ${fileURLToPath(new URL(name, LISTING_DIR))} (${png.length} bytes)`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
