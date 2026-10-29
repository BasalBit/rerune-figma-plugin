import {
  FIGMA_TEXT_ALIGN_HORIZONTALS,
  FIGMA_TEXT_ALIGN_VERTICALS,
  FIGMA_TEXT_AUTO_RESIZES,
  FIGMA_TEXT_CASES,
  FIGMA_TEXT_DECORATIONS,
  FIGMA_TEXT_TRUNCATIONS,
  type FigmaScreenshotMeta,
  type FigmaTextStyle,
} from "./api-types"
import {
  SCREENSHOT_META_MAX_BYTES,
  SCREENSHOT_TEXT_MAX_UTF16,
  TEXT_STYLE_MAX_LINES,
  TEXT_STYLE_MAX_PX,
  TEXT_STYLE_MAX_WEIGHT,
  TEXT_STYLE_NAME_MAX_RUNES,
} from "./constants"
import { firstRunes, trimSpace, utf16Length, utf8Length } from "./text"

// Screenshot freshness (SF2, contract §3.3): the text and text style of a linked layer, captured at export so the
// dashboard can tell whether a screenshot still shows ReRune's text and draw the current text into the layer's box.
// Main reads the style in Figma units (captureTextStyle); boxesFor and fitBoxes scale it to image pixels
// (scaleTextStyle); the UI keeps the E19 meta under its byte budget (fitMetaBudget). A style that cannot be
// described honestly is left out: a wrong style is worse than none.

// What capture reads from a Figma text node and its ancestors. Structural, so the UI build needs no plugin typings
// and tests can pass plain objects; every value is checked, since node-level values can be figma.mixed.
export interface StyleAncestor {
  readonly id: string
  readonly parent: StyleAncestor | null
  readonly fills?: unknown
  readonly opacity?: number
}

export const STYLE_RUN_FIELDS = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textCase", "textDecoration", "fills"] as const
export type StyleRunField = (typeof STYLE_RUN_FIELDS)[number]

export interface StyledText extends StyleAncestor {
  readonly characters: string
  readonly absoluteTransform: unknown
  readonly absoluteBoundingBox?: unknown
  readonly height?: unknown
  readonly textAlignHorizontal: unknown
  readonly textAlignVertical: unknown
  readonly textAutoResize: unknown
  readonly textTruncation: unknown
  readonly maxLines?: unknown
  readonly fontName: unknown
  readonly fontSize: unknown
  readonly fontWeight: unknown
  readonly lineHeight: unknown
  readonly letterSpacing: unknown
  readonly textCase: unknown
  readonly textDecoration: unknown
  getStyledTextSegments(fields: StyleRunField[]): readonly unknown[]
}

// Thrown by the readers below for a value outside what the wire allows; captureTextStyle turns it into "no style".
class Unreadable extends Error {}

const TRANSFORM_EPSILON = 1e-6
const SCALE_EPSILON = 1e-3
const OPAQUE = 0.99
const WIRE_COLOR = /^#[0-9A-F]{8}$/

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Unreadable()
  }
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Two decimals, as the server stores lengths; -0 becomes 0.
export function r2(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}

// The layer's text as the box records it (rule 1): longer layers send none.
export function capturedText(characters: string): string | null {
  return utf16Length(characters) <= SCREENSHOT_TEXT_MAX_UTF16 ? characters : null
}

// Rule 2: rotated, skewed or mirrored text (or text rotated by 180°) has no honest box style.
export function isUpright(transform: unknown): boolean {
  if (!Array.isArray(transform) || !Array.isArray(transform[0]) || !Array.isArray(transform[1])) {
    return false
  }
  const [a, b] = transform[0] as unknown[]
  const [c, d] = transform[1] as unknown[]
  if (![a, b, c, d].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return false
  }
  return Math.abs(b as number) <= TRANSFORM_EPSILON && Math.abs(c as number) <= TRANSFORM_EPSILON && (a as number) > 0 && (d as number) > 0
}

// How much larger the layer is drawn on the canvas than its own values say: text in an instance resized with the scale
// tool (K) keeps the component's font size, line height and letter spacing, while the instance draws it scaled
// (InstanceNode.scaleFactor). Measured as the canvas height of the (upright) layer over its own height, so it does not
// depend on whether absoluteTransform carries that scale. 1 when it cannot be measured or is 1 within 0.1 %.
export function canvasScale(node: Pick<StyledText, "absoluteBoundingBox" | "height">): number {
  const bounds = node.absoluteBoundingBox
  if (!isRecord(bounds) || typeof bounds.height !== "number" || typeof node.height !== "number" || !(node.height > 0)) {
    return 1
  }
  const scale = bounds.height / node.height
  return Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > SCALE_EPSILON ? scale : 1
}

// Rule 8: #RRGGBBAA, each channel Math.round(c × 255) clamped to 0–255, uppercase. null for a channel that is not a
// finite number.
export function hexColor(color: unknown, alpha: number): string | null {
  if (!isRecord(color)) {
    return null
  }
  const channels = [color.r, color.g, color.b, alpha]
  if (!channels.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return null
  }
  return "#" + (channels as number[]).map((entry) => clamp(Math.round(entry * 255), 0, 255).toString(16).toUpperCase().padStart(2, "0")).join("")
}

function opacityOf(value: Fields): number {
  return typeof value.opacity === "number" ? value.opacity : 1
}

// The paint drawn on top: the last visible paint with some opacity (Figma lists fills bottom to top).
export function topmostVisiblePaint(fills: unknown): Fields | null {
  if (!Array.isArray(fills)) {
    return null
  }
  for (let index = fills.length - 1; index >= 0; index--) {
    const paint: unknown = fills[index]
    if (isRecord(paint) && paint.visible !== false && opacityOf(paint) > 0) {
      return paint
    }
  }
  return null
}

// Rule 8: the text colour is the topmost visible paint when it is solid, with the paint's opacity as alpha.
export function textColor(fills: unknown): string | null {
  const paint = topmostVisiblePaint(fills)
  return paint !== null && paint.type === "SOLID" ? hexColor(paint.color, opacityOf(paint)) : null
}

// Rule 9: the first ancestor (up to and including the exported frame) with a visible fill decides. An opaque solid
// fill on an opaque node is the background; anything else (gradient, image, translucent, blended) means none can be
// named. Sibling shapes behind the text are not considered.
export function backgroundOf(node: StyleAncestor, frameId: string): string | null {
  for (let walk = node.parent; walk !== null; walk = walk.parent) {
    const paint = topmostVisiblePaint(walk.fills)
    if (paint !== null) {
      const opaque =
        paint.type === "SOLID" &&
        opacityOf(paint) >= OPAQUE &&
        (paint.blendMode === undefined || paint.blendMode === "NORMAL") &&
        (typeof walk.opacity === "number" ? walk.opacity : 1) >= OPAQUE
      return opaque ? hexColor(paint.color, 1) : null
    }
    if (walk.id === frameId) {
      break
    }
  }
  return null
}

// Rule 7: Figma's enum value lower-cased, when the wire knows it.
function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  const lower = typeof value === "string" ? value.toLowerCase() : null
  const found = allowed.find((entry) => entry === lower)
  if (found === undefined) {
    throw new Unreadable()
  }
  return found
}

function styleName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Unreadable()
  }
  const name = firstRunes(trimSpace(value), TEXT_STYLE_NAME_MAX_RUNES)
  if (name === "") {
    throw new Unreadable()
  }
  return name
}

// Rule 6: Figma's percent line height and letter spacing are of the font size. AUTO line height is null.
function lineHeightOf(value: unknown, fontSize: number): number | null {
  if (!isRecord(value)) {
    throw new Unreadable()
  }
  if (value.unit === "AUTO") {
    return null
  }
  const amount = finite(value.value)
  const px = value.unit === "PIXELS" ? amount : value.unit === "PERCENT" ? (fontSize * amount) / 100 : Number.NaN
  if (Number.isNaN(px)) {
    throw new Unreadable()
  }
  return px > 0 ? px : null
}

function letterSpacingOf(value: unknown, fontSize: number): number {
  if (!isRecord(value)) {
    throw new Unreadable()
  }
  const amount = finite(value.value)
  if (value.unit === "PIXELS") {
    return amount
  }
  if (value.unit === "PERCENT") {
    return (fontSize * amount) / 100
  }
  throw new Unreadable()
}

function roundedOrNull(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), min, max) : null
}

// Rule 3: the first style run (getStyledTextSegments), or the node's own values for an empty layer.
function firstRun(node: StyledText): { run: Fields; mixed: boolean } {
  if (node.characters !== "") {
    const segments = node.getStyledTextSegments([...STYLE_RUN_FIELDS])
    const first = segments[0]
    if (!isRecord(first)) {
      throw new Unreadable()
    }
    return { run: first, mixed: segments.length > 1 }
  }
  const run: Fields = {
    fontName: node.fontName,
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    lineHeight: node.lineHeight,
    letterSpacing: node.letterSpacing,
    textCase: node.textCase,
    textDecoration: node.textDecoration,
    fills: node.fills,
  }
  // figma.mixed (a symbol): the empty layer has no single value to describe.
  if (Object.values(run).some((value) => typeof value === "symbol")) {
    throw new Unreadable()
  }
  return { run, mixed: false }
}

// §3.3 rules 2–9, in canvas units: the layer's Figma values times canvasScale (boxesFor scales the lengths to image
// pixels, like the box). null when the style cannot be described honestly or anything throws while it is read.
export function captureTextStyle(node: StyledText, frameId: string): FigmaTextStyle | null {
  try {
    if (!isUpright(node.absoluteTransform)) {
      return null
    }
    const { run, mixed } = firstRun(node)
    if (!isRecord(run.fontName)) {
      return null
    }
    const fontSize = finite(run.fontSize)
    if (fontSize <= 0) {
      return null
    }
    const scale = canvasScale(node)
    const lineHeight = lineHeightOf(run.lineHeight, fontSize)
    return {
      font_family: styleName(run.fontName.family),
      font_style: styleName(run.fontName.style),
      font_weight: roundedOrNull(run.fontWeight, 1, TEXT_STYLE_MAX_WEIGHT),
      font_size: fontSize * scale,
      line_height_px: lineHeight === null ? null : lineHeight * scale,
      letter_spacing_px: letterSpacingOf(run.letterSpacing, fontSize) * scale,
      text_align_horizontal: enumOf(node.textAlignHorizontal, FIGMA_TEXT_ALIGN_HORIZONTALS),
      text_align_vertical: enumOf(node.textAlignVertical, FIGMA_TEXT_ALIGN_VERTICALS),
      text_case: enumOf(run.textCase, FIGMA_TEXT_CASES),
      text_decoration: enumOf(run.textDecoration, FIGMA_TEXT_DECORATIONS),
      color: textColor(run.fills),
      background: backgroundOf(node, frameId),
      auto_resize: enumOf(node.textAutoResize, FIGMA_TEXT_AUTO_RESIZES),
      max_lines: node.maxLines === null || node.maxLines === undefined ? null : roundedOrNull(node.maxLines, 1, TEXT_STYLE_MAX_LINES),
      truncation: enumOf(node.textTruncation, FIGMA_TEXT_TRUNCATIONS),
      mixed,
    }
  } catch {
    return null
  }
}

// The lengths at another scale (the export scale in boxesFor, actual/expected height in fitBoxes), rounded to two
// decimals and kept in the wire ranges: a font size that rounds to 0 leaves no style, a line height that does
// becomes AUTO (null).
export function scaleTextStyle(style: FigmaTextStyle, factor: number): FigmaTextStyle | null {
  const fontSize = Math.min(r2(style.font_size * factor), TEXT_STYLE_MAX_PX)
  const letterSpacing = r2(style.letter_spacing_px * factor)
  if (!(fontSize > 0) || !Number.isFinite(letterSpacing)) {
    return null
  }
  const lineHeight = style.line_height_px === null ? null : r2(style.line_height_px * factor)
  return {
    ...style,
    font_size: fontSize,
    line_height_px: lineHeight === null || !(lineHeight > 0) ? null : Math.min(lineHeight, TEXT_STYLE_MAX_PX),
    letter_spacing_px: clamp(letterSpacing, -TEXT_STYLE_MAX_PX, TEXT_STYLE_MAX_PX),
  }
}

const STYLE_KEYS: readonly (keyof FigmaTextStyle)[] = [
  "font_family", "font_style", "font_weight", "font_size", "line_height_px", "letter_spacing_px", "text_align_horizontal",
  "text_align_vertical", "text_case", "text_decoration", "color", "background", "auto_resize", "max_lines", "truncation", "mixed",
]

function wireName(value: unknown): boolean {
  if (typeof value !== "string") {
    return false
  }
  const runes = Array.from(trimSpace(value)).length
  return runes >= 1 && runes <= TEXT_STYLE_NAME_MAX_RUNES
}

function integerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function lengthIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > min && value <= max
}

function wireColor(value: unknown): boolean {
  return value === null || (typeof value === "string" && WIRE_COLOR.test(value))
}

// The server's §3.2 check of one box style (any violation fails the whole upload with 400 "invalid meta"). The
// plugin only produces valid styles; this guards the upload against a Figma value nobody foresaw.
export function isWireTextStyle(style: unknown): style is FigmaTextStyle {
  if (!isRecord(style) || !Object.keys(style).every((key) => (STYLE_KEYS as readonly string[]).includes(key))) {
    return false
  }
  return (
    wireName(style.font_family) &&
    wireName(style.font_style) &&
    (style.font_weight === null || integerIn(style.font_weight, 1, TEXT_STYLE_MAX_WEIGHT)) &&
    lengthIn(style.font_size, 0, TEXT_STYLE_MAX_PX) &&
    (style.line_height_px === null || lengthIn(style.line_height_px, 0, TEXT_STYLE_MAX_PX)) &&
    typeof style.letter_spacing_px === "number" &&
    Number.isFinite(style.letter_spacing_px) &&
    Math.abs(style.letter_spacing_px) <= TEXT_STYLE_MAX_PX &&
    (FIGMA_TEXT_ALIGN_HORIZONTALS as readonly unknown[]).includes(style.text_align_horizontal) &&
    (FIGMA_TEXT_ALIGN_VERTICALS as readonly unknown[]).includes(style.text_align_vertical) &&
    (FIGMA_TEXT_CASES as readonly unknown[]).includes(style.text_case) &&
    (FIGMA_TEXT_DECORATIONS as readonly unknown[]).includes(style.text_decoration) &&
    wireColor(style.color) &&
    wireColor(style.background) &&
    (FIGMA_TEXT_AUTO_RESIZES as readonly unknown[]).includes(style.auto_resize) &&
    (style.max_lines === null || integerIn(style.max_lines, 1, TEXT_STYLE_MAX_LINES)) &&
    (FIGMA_TEXT_TRUNCATIONS as readonly unknown[]).includes(style.truncation) &&
    typeof style.mixed === "boolean"
  )
}

// Rule 10 (SF2c): the meta stays within its byte budget. Texts go first, longest first; then styles, last box first.
// The boxes keep their key order (text and style come last), so each removal shrinks the JSON by exactly
// `,"text":<json>` or `,"style":<json>`.
export function fitMetaBudget(meta: FigmaScreenshotMeta, maxBytes: number = SCREENSHOT_META_MAX_BYTES): FigmaScreenshotMeta {
  let size = utf8Length(JSON.stringify(meta))
  if (size <= maxBytes) {
    return meta
  }
  const boxes = meta.boxes.map((box) => ({ ...box }))
  const longestFirst = boxes
    .map((box, index) => ({ index, length: box.text === undefined ? -1 : box.text.length }))
    .filter((entry) => entry.length >= 0)
    .sort((a, b) => b.length - a.length)
  for (const { index } of longestFirst) {
    if (size <= maxBytes) {
      break
    }
    size -= utf8Length(',"text":' + JSON.stringify(boxes[index].text))
    delete boxes[index].text
  }
  for (let index = boxes.length - 1; index >= 0 && size > maxBytes; index--) {
    if (boxes[index].style !== undefined) {
      size -= utf8Length(',"style":' + JSON.stringify(boxes[index].style))
      delete boxes[index].style
    }
  }
  return { ...meta, boxes }
}
