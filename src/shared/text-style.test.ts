import { describe, expect, it } from "vitest"
import type { FigmaScreenshotMeta, FigmaTextStyle } from "./api-types"
import { utf8Length } from "./text"
import {
  backgroundOf,
  canvasScale,
  capturedText,
  captureTextStyle,
  fitMetaBudget,
  hexColor,
  isUpright,
  isWireTextStyle,
  r2,
  scaleTextStyle,
  textColor,
  topmostVisiblePaint,
  type StyleAncestor,
  type StyledText,
} from "./text-style"

// Screenshot freshness, contract §3.3: what main captures for each linked layer at export, and how the UI keeps
// the E19 meta valid and within budget.

const MIXED = Symbol("mixed")

const solid = (r: number, g: number, b: number, extra: Record<string, unknown> = {}) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b }, ...extra })

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    characters: "Pay now",
    start: 0,
    end: 7,
    fontName: { family: "Inter", style: "Semi Bold" },
    fontSize: 17,
    fontWeight: 600,
    lineHeight: { unit: "PIXELS", value: 22 },
    letterSpacing: { unit: "PIXELS", value: -0.41 },
    textCase: "ORIGINAL",
    textDecoration: "NONE",
    fills: [solid(1, 1, 1)],
    ...overrides,
  }
}

const FRAME: StyleAncestor = { id: "10:1", parent: { id: "0:1", parent: null }, fills: [solid(1, 1, 1)], opacity: 1 }
const BUTTON: StyleAncestor = { id: "11:1", parent: FRAME, fills: [solid(10 / 255, 132 / 255, 1)], opacity: 1 }

function text(overrides: Partial<Record<keyof StyledText, unknown>> = {}, segments: Record<string, unknown>[] = [run()]): StyledText {
  return {
    id: "12:1",
    parent: BUTTON,
    characters: "Pay now",
    absoluteTransform: [[1, 0, 124], [0, 1, 510]],
    textAlignHorizontal: "CENTER",
    textAlignVertical: "CENTER",
    textAutoResize: "NONE",
    textTruncation: "DISABLED",
    maxLines: null,
    fontName: { family: "Inter", style: "Semi Bold" },
    fontSize: 17,
    fontWeight: 600,
    lineHeight: { unit: "PIXELS", value: 22 },
    letterSpacing: { unit: "PIXELS", value: -0.41 },
    textCase: "ORIGINAL",
    textDecoration: "NONE",
    fills: [solid(1, 1, 1)],
    getStyledTextSegments: () => Object.freeze(segments.map((segment) => Object.freeze(segment))),
    ...overrides,
  } as StyledText
}

// The §3.1 example, in Figma units.
const PAY_NOW: FigmaTextStyle = {
  font_family: "Inter",
  font_style: "Semi Bold",
  font_weight: 600,
  font_size: 17,
  line_height_px: 22,
  letter_spacing_px: -0.41,
  text_align_horizontal: "center",
  text_align_vertical: "center",
  text_case: "original",
  text_decoration: "none",
  color: "#FFFFFFFF",
  background: "#0A84FFFF",
  auto_resize: "none",
  max_lines: null,
  truncation: "disabled",
  mixed: false,
}

describe("captureTextStyle (rules 2–9)", () => {
  it("describes the first run with the node's alignment, sizing and background", () => {
    expect(captureTextStyle(text(), "10:1")).toEqual(PAY_NOW)
  })

  it("reads only the fields it needs from getStyledTextSegments, and marks several runs as mixed", () => {
    let fields: string[] = []
    const node = text({
      getStyledTextSegments: (requested: string[]) => {
        fields = requested
        return [run({ end: 3 }), run({ start: 3, fontSize: 20 })]
      },
    })
    expect(captureTextStyle(node, "10:1")).toEqual({ ...PAY_NOW, mixed: true })
    expect(fields).toEqual(["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textCase", "textDecoration", "fills"])
  })

  it("uses the node's own values for an empty layer, and gives up on figma.mixed", () => {
    const empty = text({ characters: "", getStyledTextSegments: () => [] })
    expect(captureTextStyle(empty, "10:1")).toEqual(PAY_NOW)
    expect(captureTextStyle(text({ characters: "", fills: MIXED }), "10:1")).toBeNull()
    expect(captureTextStyle(text({ characters: "", fontWeight: MIXED }), "10:1")).toBeNull()
    // A non-empty layer with no runs cannot be described.
    expect(captureTextStyle(text({}, []), "10:1")).toBeNull()
  })

  it("leaves out the style of rotated, skewed, mirrored or upside-down text", () => {
    expect(captureTextStyle(text({ absoluteTransform: [[0, -1, 0], [1, 0, 0]] }), "10:1")).toBeNull()
    expect(captureTextStyle(text({ absoluteTransform: [[1, 0.2, 0], [0, 1, 0]] }), "10:1")).toBeNull()
    expect(captureTextStyle(text({ absoluteTransform: [[-1, 0, 0], [0, 1, 0]] }), "10:1")).toBeNull()
    expect(captureTextStyle(text({ absoluteTransform: [[-1, 0, 0], [0, -1, 0]] }), "10:1")).toBeNull()
    expect(captureTextStyle(text({ absoluteTransform: [[1, 1e-7, 0], [-1e-7, 2, 0]] }), "10:1")).toEqual(PAY_NOW)
    expect(isUpright(null)).toBe(false)
    expect(isUpright([[Number.NaN, 0, 0], [0, 1, 0]])).toBe(false)
  })

  it("gives the lengths at the size the canvas draws the layer, as for text in an instance scaled with K", () => {
    // Scale factor 2: the component's 17 px label is drawn 40 px high instead of 20.
    const scaled = text({ absoluteBoundingBox: { x: 124, y: 510, width: 400, height: 40 }, height: 20 })
    expect(canvasScale(scaled)).toBe(2)
    expect(captureTextStyle(scaled, "10:1")).toEqual({ ...PAY_NOW, font_size: 34, line_height_px: 44, letter_spacing_px: -0.82 })
    const percent = text({ absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 10 }, height: 20 }, [run({ lineHeight: { unit: "PERCENT", value: 150 } })])
    expect(captureTextStyle(percent, "10:1")).toMatchObject({ font_size: 8.5, line_height_px: 12.75, letter_spacing_px: -0.205 })
    // Unscaled (within 0.1 %), or not measurable: the layer's own values.
    expect(canvasScale({ absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20.01 }, height: 20 })).toBe(1)
    expect(canvasScale({ absoluteBoundingBox: null, height: 20 })).toBe(1)
    expect(canvasScale({ absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, height: 0 })).toBe(1)
    expect(canvasScale({ absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 0 }, height: 20 })).toBe(1)
    expect(canvasScale({})).toBe(1)
    expect(captureTextStyle(text({ absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, height: 20 }), "10:1")).toEqual(PAY_NOW)
  })

  it("converts line height and letter spacing to Figma units (percent of the font size)", () => {
    const style = (overrides: Record<string, unknown>) => captureTextStyle(text({}, [run(overrides)]), "10:1")
    expect(style({ lineHeight: { unit: "AUTO" } })?.line_height_px).toBeNull()
    expect(style({ lineHeight: { unit: "PERCENT", value: 150 } })?.line_height_px).toBe(25.5)
    expect(style({ lineHeight: { unit: "PIXELS", value: 0 } })?.line_height_px).toBeNull()
    expect(style({ lineHeight: { unit: "PERCENT", value: -10 } })?.line_height_px).toBeNull()
    expect(style({ letterSpacing: { unit: "PERCENT", value: -2 } })?.letter_spacing_px).toBe(-0.34)
    expect(style({ letterSpacing: { unit: "PIXELS", value: 0 } })?.letter_spacing_px).toBe(0)
    expect(style({ lineHeight: { unit: "EM", value: 1 } })).toBeNull()
    expect(style({ letterSpacing: { unit: "PIXELS", value: Number.NaN } })).toBeNull()
    expect(style({ letterSpacing: "1px" })).toBeNull()
  })

  it("lower-cases Figma's enums and leaves out values the wire does not know", () => {
    const style = (node: Partial<Record<keyof StyledText, unknown>>, overrides: Record<string, unknown> = {}) => captureTextStyle(text(node, [run(overrides)]), "10:1")
    expect(style({ textAlignHorizontal: "JUSTIFIED", textAlignVertical: "BOTTOM" })).toMatchObject({ text_align_horizontal: "justified", text_align_vertical: "bottom" })
    expect(style({ textAutoResize: "WIDTH_AND_HEIGHT" })?.auto_resize).toBe("width_and_height")
    expect(style({ textAutoResize: "TRUNCATE", textTruncation: "ENDING", maxLines: 2 })).toMatchObject({ auto_resize: "truncate", truncation: "ending", max_lines: 2 })
    expect(style({}, { textCase: "SMALL_CAPS_FORCED", textDecoration: "STRIKETHROUGH" })).toMatchObject({ text_case: "small_caps_forced", text_decoration: "strikethrough" })
    expect(style({}, { textCase: "TITLE", textDecoration: "UNDERLINE" })).toMatchObject({ text_case: "title", text_decoration: "underline" })
    expect(style({ textAlignHorizontal: "DISTRIBUTED" })).toBeNull()
    expect(style({ textAutoResize: MIXED })).toBeNull()
    expect(style({}, { textCase: "SENTENCE" })).toBeNull()
    expect(style({}, { textDecoration: undefined })).toBeNull()
  })

  it("trims and cuts font names, rounds and clamps weights and line limits", () => {
    const style = (node: Partial<Record<keyof StyledText, unknown>>, overrides: Record<string, unknown> = {}) => captureTextStyle(text(node, [run(overrides)]), "10:1")
    const nel = String.fromCharCode(0x85)
    expect(style({}, { fontName: { family: "  SF Pro " + nel, style: "Bold Italic" } })).toMatchObject({ font_family: "SF Pro", font_style: "Bold Italic" })
    expect(style({}, { fontName: { family: "😀".repeat(201), style: "Regular" } })?.font_family).toBe("😀".repeat(200))
    expect(style({}, { fontName: { family: "  ", style: "Regular" } })).toBeNull()
    expect(style({}, { fontName: MIXED })).toBeNull()
    expect(style({}, { fontWeight: 449.5 })?.font_weight).toBe(450)
    expect(style({}, { fontWeight: 1500 })?.font_weight).toBe(1000)
    expect(style({}, { fontWeight: 0.2 })?.font_weight).toBe(1)
    expect(style({}, { fontWeight: Number.NaN })?.font_weight).toBeNull()
    expect(style({}, { fontWeight: undefined })?.font_weight).toBeNull()
    expect(style({ maxLines: undefined })?.max_lines).toBeNull()
    expect(style({ maxLines: 2.6 })?.max_lines).toBe(3)
    expect(style({ maxLines: 5000 })?.max_lines).toBe(1000)
    expect(style({}, { fontSize: 0 })).toBeNull()
    expect(style({}, { fontSize: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it("is null when a read throws", () => {
    const throwing = text()
    Object.defineProperty(throwing, "textAlignHorizontal", {
      get: () => {
        throw new Error("The node does not exist")
      },
    })
    expect(captureTextStyle(throwing, "10:1")).toBeNull()
    expect(captureTextStyle(text({ getStyledTextSegments: () => { throw new Error("gone") } }), "10:1")).toBeNull()
  })
})

describe("colours (rule 8)", () => {
  it("writes #RRGGBBAA with rounded, clamped channels", () => {
    expect(hexColor({ r: 10 / 255, g: 132 / 255, b: 1 }, 1)).toBe("#0A84FFFF")
    expect(hexColor({ r: 0.5, g: 0, b: 1.2 }, 0.5)).toBe("#8000FF80")
    expect(hexColor({ r: -0.1, g: 0, b: 0 }, 0)).toBe("#00000000")
    expect(hexColor({ r: Number.NaN, g: 0, b: 0 }, 1)).toBeNull()
    expect(hexColor(undefined, 1)).toBeNull()
  })

  it("takes the topmost visible paint: the last one that is visible and not fully transparent", () => {
    const fills = [solid(1, 0, 0), solid(0, 1, 0), solid(0, 0, 1, { visible: false }), solid(0, 0, 0, { opacity: 0 })]
    expect(topmostVisiblePaint(fills)).toEqual(solid(0, 1, 0))
    expect(topmostVisiblePaint([])).toBeNull()
    expect(topmostVisiblePaint(MIXED)).toBeNull()
  })

  it("colours the text only with a solid paint, its opacity as alpha", () => {
    expect(textColor([solid(1, 1, 1, { opacity: 0.6 })])).toBe("#FFFFFF99")
    expect(textColor([solid(1, 1, 1), { type: "GRADIENT_LINEAR", visible: true }])).toBeNull()
    expect(textColor([])).toBeNull()
  })
})

describe("backgroundOf (rule 9)", () => {
  const leaf = (parent: StyleAncestor): StyleAncestor => ({ id: "12:1", parent })

  it("uses the first ancestor with a visible fill, when it is opaque and solid", () => {
    const group: StyleAncestor = { id: "11:2", parent: BUTTON }
    const hiddenFill: StyleAncestor = { id: "11:3", parent: group, fills: [solid(1, 0, 0, { visible: false })], opacity: 1 }
    const mixedFills: StyleAncestor = { id: "11:4", parent: hiddenFill, fills: MIXED, opacity: 1 }
    expect(backgroundOf(leaf(mixedFills), "10:1")).toBe("#0A84FFFF")
    // The paint's own alpha does not show: the background is opaque.
    expect(backgroundOf(leaf({ id: "11:5", parent: FRAME, fills: [solid(1, 0, 0, { opacity: 0.995 })], opacity: 1 }), "10:1")).toBe("#FF0000FF")
  })

  it("names none when that fill is translucent, blended, not solid, or on a translucent node", () => {
    const on = (fills: unknown[], opacity = 1) => backgroundOf(leaf({ id: "11:1", parent: FRAME, fills, opacity }), "10:1")
    expect(on([solid(1, 0, 0, { opacity: 0.5 })])).toBeNull()
    expect(on([solid(1, 0, 0, { blendMode: "MULTIPLY" })])).toBeNull()
    expect(on([solid(1, 0, 0, { blendMode: undefined })])).toBe("#FF0000FF")
    expect(on([{ type: "IMAGE", visible: true, opacity: 1, blendMode: "NORMAL" }])).toBeNull()
    expect(on([solid(1, 0, 0)], 0.5)).toBeNull()
  })

  it("stops at the exported frame", () => {
    const transparentFrame: StyleAncestor = { id: "10:1", parent: { id: "9:1", parent: null, fills: [solid(1, 0, 0)], opacity: 1 }, fills: [] }
    expect(backgroundOf(leaf(transparentFrame), "10:1")).toBeNull()
    expect(backgroundOf(leaf({ id: "0:1", parent: null }), "10:1")).toBeNull()
  })
})

describe("capturedText (rule 1)", () => {
  it("keeps up to 5,000 UTF-16 units", () => {
    expect(capturedText("x".repeat(5000))).toHaveLength(5000)
    expect(capturedText("x".repeat(5001))).toBeNull()
    expect(capturedText("😀".repeat(2500) + "x")).toBeNull()
    expect(capturedText("")).toBe("")
  })
})

describe("scaleTextStyle (image pixels)", () => {
  it("scales the lengths and rounds them to two decimals", () => {
    expect(scaleTextStyle(PAY_NOW, 3)).toEqual({ ...PAY_NOW, font_size: 51, line_height_px: 66, letter_spacing_px: -1.23 })
    expect(scaleTextStyle(PAY_NOW, 4096 / 5000.5)).toEqual({ ...PAY_NOW, font_size: 13.93, line_height_px: 18.02, letter_spacing_px: -0.34 })
    expect(r2(-0.004)).toBe(0)
    expect(Object.is(r2(-0.004), -0)).toBe(false)
  })

  it("drops the style when the font size rounds to 0, and a line height that does becomes AUTO", () => {
    const tiny = { ...PAY_NOW, font_size: 0.01, line_height_px: 0.01, letter_spacing_px: 0.01 }
    expect(scaleTextStyle(tiny, 0.25)).toBeNull()
    expect(scaleTextStyle({ ...tiny, font_size: 0.04 }, 0.25)).toEqual({ ...tiny, font_size: 0.01, line_height_px: null, letter_spacing_px: 0 })
  })

  it("clamps into the wire ranges", () => {
    expect(scaleTextStyle({ ...PAY_NOW, font_size: 5000, line_height_px: 6000, letter_spacing_px: -5000 }, 2)).toEqual({
      ...PAY_NOW,
      font_size: 8192,
      line_height_px: 8192,
      letter_spacing_px: -8192,
    })
  })
})

describe("isWireTextStyle (the server's §3.2 check)", () => {
  it("accepts captured styles and the contract example", () => {
    expect(isWireTextStyle(PAY_NOW)).toBe(true)
    expect(isWireTextStyle({ ...PAY_NOW, font_weight: null, line_height_px: null, color: null, background: null, max_lines: 1000 })).toBe(true)
  })

  it.each([
    ["an unknown field", { ...PAY_NOW, font_stretch: "normal" }],
    ["an empty family", { ...PAY_NOW, font_family: " " }],
    ["a 201-rune style", { ...PAY_NOW, font_style: "x".repeat(201) }],
    ["a fractional weight", { ...PAY_NOW, font_weight: 600.5 }],
    ["a weight of 0", { ...PAY_NOW, font_weight: 0 }],
    ["a font size of 0", { ...PAY_NOW, font_size: 0 }],
    ["a font size above 8192", { ...PAY_NOW, font_size: 8192.01 }],
    ["a line height of 0", { ...PAY_NOW, line_height_px: 0 }],
    ["a letter spacing below -8192", { ...PAY_NOW, letter_spacing_px: -8192.5 }],
    ["an unknown alignment", { ...PAY_NOW, text_align_horizontal: "LEFT" }],
    ["a lower-case colour", { ...PAY_NOW, color: "#ffffffff" }],
    ["an RGB colour", { ...PAY_NOW, background: "#FFFFFF" }],
    ["max lines of 0", { ...PAY_NOW, max_lines: 0 }],
    ["a missing mixed flag", { ...PAY_NOW, mixed: undefined }],
  ])("rejects %s", (_name, style) => {
    expect(isWireTextStyle(style)).toBe(false)
  })
})

describe("fitMetaBudget (rule 10, SF2c)", () => {
  const meta = (boxes: FigmaScreenshotMeta["boxes"]): FigmaScreenshotMeta => ({
    file_key: "AbCdEf1234567890XyZ",
    frame_id: "10:1",
    frame_name: "Checkout",
    page_id: "0:1",
    page_name: "Mobile",
    width: 400,
    height: 800,
    boxes,
  })
  const box = (index: number, textValue: string | undefined, style: FigmaTextStyle | null = PAY_NOW) => ({
    key_id: "6a48" + String(index).padStart(20, "0"),
    node_id: "12:" + index,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    ...(textValue === undefined ? {} : { text: textValue }),
    ...(style === null ? {} : { style }),
  })
  const bytes = (value: FigmaScreenshotMeta) => utf8Length(JSON.stringify(value))

  it("keeps a meta within the budget as it is", () => {
    const small = meta([box(1, "Pay now")])
    expect(fitMetaBudget(small)).toBe(small)
  })

  it("drops texts, longest first, until the meta fits", () => {
    const full = meta([box(1, "a".repeat(100)), box(2, "ü".repeat(300)), box(3, "b".repeat(200)), box(4, "c".repeat(50))])
    // Room for everything but the 300-character text (600 bytes): only that one goes.
    const fitted = fitMetaBudget(full, bytes(full) - 600)
    expect(fitted.boxes.map((entry) => entry.text?.length)).toEqual([100, undefined, 200, 50])
    expect(bytes(fitted)).toBe(bytes(full) - utf8Length(',"text":' + JSON.stringify("ü".repeat(300))))
    // One byte less: the 200-character text goes too.
    const tighter = fitMetaBudget(full, bytes(full) - utf8Length(',"text":' + JSON.stringify("ü".repeat(300))) - 1)
    expect(tighter.boxes.map((entry) => entry.text?.length)).toEqual([100, undefined, undefined, 50])
    expect(full.boxes[1].text).toHaveLength(300)
  })

  it("drops styles, last box first, once no text is left", () => {
    const full = meta([box(1, "Pay"), box(2, undefined), box(3, "Cancel"), box(4, undefined, null)])
    const noTexts = bytes(meta([box(1, undefined), box(2, undefined), box(3, undefined), box(4, undefined, null)]))
    const fitted = fitMetaBudget(full, noTexts - 1)
    expect(fitted.boxes.map((entry) => [entry.text, entry.style === undefined])).toEqual([
      [undefined, false],
      [undefined, false],
      [undefined, true],
      [undefined, true],
    ])
    expect(bytes(fitted)).toBeLessThanOrEqual(noTexts - 1)
  })

  it("keeps the real 900,000-byte budget with 500 long texts", () => {
    const boxes = Array.from({ length: 500 }, (_, index) => box(index, "€".repeat(4000 + index)))
    const fitted = fitMetaBudget(meta(boxes))
    expect(bytes(fitted)).toBeLessThanOrEqual(900000)
    expect(bytes(fitted)).toBeGreaterThan(900000 - 3 * 4500 - 20)
    // The longest texts (the last boxes) went first; every style stayed.
    const kept = fitted.boxes.filter((entry) => entry.text !== undefined).length
    expect(kept).toBeGreaterThan(0)
    expect(fitted.boxes.slice(0, kept).every((entry) => entry.text !== undefined)).toBe(true)
    expect(fitted.boxes.slice(kept).every((entry) => entry.text === undefined)).toBe(true)
    expect(fitted.boxes.every((entry) => entry.style !== undefined)).toBe(true)
  })
})
