import { describe, expect, it } from "vitest"
import {
  clippedBy,
  exceedsParentBy,
  fixedAxes,
  innerBox,
  NO_PADDING,
  OVERFLOW_TOLERANCE_PX,
  overflowChecks,
  paddingValue,
  renderMargin,
  roundBy,
  truncatedBy,
  type ParentSizing,
} from "./overflow"

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

const NO_SIZING: ParentSizing = { layoutMode: null, primaryAxisSizingMode: null, counterAxisSizingMode: null, layoutSizingHorizontal: null, layoutSizingVertical: null }

describe("overflowChecks (§7.18.1: which heuristic applies)", () => {
  it.each([
    ["NONE", "DISABLED", { clipped: true, truncated: false, parent: false }],
    ["NONE", "ENDING", { clipped: false, truncated: true, parent: false }],
    ["TRUNCATE", "DISABLED", { clipped: false, truncated: true, parent: false }],
    ["HEIGHT", "DISABLED", { clipped: false, truncated: false, parent: true }],
    ["WIDTH_AND_HEIGHT", "DISABLED", { clipped: false, truncated: false, parent: true }],
    ["HEIGHT", "ENDING", { clipped: false, truncated: true, parent: true }],
    ["WIDTH_AND_HEIGHT", "ENDING", { clipped: false, truncated: true, parent: true }],
  ] as const)("%s + %s", (textAutoResize, textTruncation, expected) => {
    expect(overflowChecks({ textAutoResize, textTruncation })).toEqual(expected)
  })
})

describe("clippedBy (a): fixed box without truncation", () => {
  it("reports render bounds taller than the box beyond the 1.5 px tolerance", () => {
    expect(OVERFLOW_TOLERANCE_PX).toBe(1.5)
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, 0, 100, 36))).toBe(16)
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, -8, 100, 36))).toBe(16)
  })

  it("reports render bounds wider than the box (a word longer than the box)", () => {
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, 0, 124.26, 20))).toBe(24.3)
  })

  it("ignores rendering noise up to the tolerance, and boxes taller than their text", () => {
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, 0, 100, 21.5))).toBeNull()
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, 0, 100, 21.6))).toBe(1.6)
    expect(clippedBy(rect(0, 0, 100, 40), rect(0, 2, 60, 16))).toBeNull()
  })

  it("subtracts what effects and strokes can draw past the box on both sides", () => {
    expect(clippedBy(rect(0, 0, 100, 20), rect(-4, -4, 108, 28), 4)).toBeNull()
    expect(clippedBy(rect(0, 0, 100, 20), rect(-4, -4, 108, 48), 4)).toBe(20)
  })

  it("cannot judge without both rects (invisible text, text clipped inside an instance)", () => {
    expect(clippedBy(rect(0, 0, 100, 20), null)).toBeNull()
    expect(clippedBy(null, rect(0, 0, 100, 40))).toBeNull()
    expect(clippedBy(rect(0, 0, 100, 20), rect(0, 0, NaN, 40))).toBeNull()
  })
})

describe("renderMargin", () => {
  it("adds the reach of the widest visible drop shadow, layer blur and outside stroke", () => {
    expect(renderMargin({})).toBe(0)
    expect(renderMargin({ effects: [{ type: "DROP_SHADOW", visible: true, radius: 4, spread: 1, offset: { x: 0, y: 2 } }] })).toBe(7)
    expect(renderMargin({ effects: [{ type: "DROP_SHADOW", visible: true, radius: 2, offset: { x: -6, y: 1 } }, { type: "DROP_SHADOW", visible: true, radius: 1, offset: { x: 0, y: 1 } }] })).toBe(8)
    expect(renderMargin({ effects: [{ type: "LAYER_BLUR", visible: true, radius: 3 }] })).toBe(3)
    expect(renderMargin({ strokes: [{ visible: true }], strokeWeight: 2, strokeAlign: "OUTSIDE" })).toBe(2)
    expect(renderMargin({ strokes: [{ visible: true }], strokeWeight: 2, strokeAlign: "CENTER" })).toBe(1)
  })

  it("ignores hidden effects, inner shadows, background blurs, inside strokes and hidden strokes", () => {
    expect(renderMargin({ effects: [{ type: "DROP_SHADOW", visible: false, radius: 9, offset: { x: 9, y: 9 } }] })).toBe(0)
    expect(renderMargin({ effects: [{ type: "INNER_SHADOW", visible: true, radius: 9, offset: { x: 9, y: 9 } }, { type: "BACKGROUND_BLUR", visible: true, radius: 9 }] })).toBe(0)
    expect(renderMargin({ strokes: [{ visible: true }], strokeWeight: 4, strokeAlign: "INSIDE" })).toBe(0)
    expect(renderMargin({ strokes: [{ visible: false }], strokeWeight: 4, strokeAlign: "OUTSIDE" })).toBe(0)
    expect(renderMargin({ strokes: [], strokeWeight: 4, strokeAlign: "OUTSIDE" })).toBe(0)
  })
})

describe("truncatedBy (b): truncating text measured without truncation", () => {
  it("reports a taller untruncated clone", () => {
    expect(truncatedBy(20, 60)).toBe(40)
    expect(truncatedBy(40, 41.5)).toBeNull()
    expect(truncatedBy(40, 30)).toBeNull()
    expect(truncatedBy(40, NaN)).toBeNull()
  })
})

describe("fixedAxes", () => {
  it("treats a frame without auto layout as fixed on both axes", () => {
    expect(fixedAxes(NO_SIZING)).toEqual({ width: true, height: true })
    expect(fixedAxes({ ...NO_SIZING, layoutMode: "NONE" })).toEqual({ width: true, height: true })
  })

  it("follows the auto-layout sizing modes per axis", () => {
    expect(fixedAxes({ ...NO_SIZING, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })).toEqual({ width: false, height: true })
    expect(fixedAxes({ ...NO_SIZING, layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })).toEqual({ width: true, height: false })
    expect(fixedAxes({ ...NO_SIZING, layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" })).toEqual({ width: false, height: true })
  })

  it("prefers layoutSizing when Figma reports it (FILL counts as fixed, HUG grows)", () => {
    expect(fixedAxes({ ...NO_SIZING, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" })).toEqual({ width: true, height: false })
    expect(fixedAxes({ ...NO_SIZING, layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED" })).toEqual({ width: false, height: true })
  })
})

describe("exceedsParentBy (c): auto-sized text in a parent of fixed size", () => {
  const parent = { box: rect(0, 0, 200, 48), padding: { left: 16, right: 16, top: 12, bottom: 12 }, fixedWidth: true, fixedHeight: true }

  it("measures against the inner box (box minus padding)", () => {
    expect(innerBox(parent)).toEqual(rect(16, 12, 168, 24))
    expect(innerBox({ box: rect(0, 0, 10, 10), padding: { left: 8, right: 8, top: 0, bottom: 0 } })).toEqual(rect(8, 0, 0, 10))
    expect(exceedsParentBy(rect(16, 12, 168, 24), parent)).toBeNull()
    expect(exceedsParentBy(rect(16, 12, 210, 24), parent)).toBe(42)
    expect(exceedsParentBy(rect(16, 12, 168, 44), parent)).toBe(20)
    expect(exceedsParentBy(rect(4, 12, 100, 24), parent)).toBe(12)
  })

  it("only checks the axes the parent cannot grow", () => {
    expect(exceedsParentBy(rect(16, 12, 300, 24), { ...parent, fixedWidth: false })).toBeNull()
    expect(exceedsParentBy(rect(16, 12, 168, 90), { ...parent, fixedHeight: false })).toBeNull()
    expect(exceedsParentBy(rect(16, 12, 300, 90), { ...parent, fixedWidth: false, fixedHeight: false })).toBeNull()
  })

  it("ignores up to 1.5 px and missing rects", () => {
    expect(exceedsParentBy(rect(16, 12, 169.5, 24), parent)).toBeNull()
    expect(exceedsParentBy(rect(16, 12, 169.6, 24), parent)).toBe(1.6)
    expect(exceedsParentBy(null, parent)).toBeNull()
    expect(exceedsParentBy(rect(0, 0, 10, 10), null)).toBeNull()
    expect(exceedsParentBy(rect(0, 0, 500, 10), { box: rect(0, 0, 100, 100), padding: NO_PADDING, fixedWidth: true, fixedHeight: true })).toBe(400)
  })
})

describe("small helpers", () => {
  it("rounds to one decimal place and reads padding defensively", () => {
    expect(roundBy(12.345)).toBe(12.3)
    expect(roundBy(1.55)).toBe(1.6)
    expect(paddingValue(8)).toBe(8)
    expect(paddingValue(-2)).toBe(0)
    expect(paddingValue(Symbol("mixed"))).toBe(0)
    expect(paddingValue(undefined)).toBe(0)
  })
})
