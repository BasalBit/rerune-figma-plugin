import { describe, expect, it } from "vitest"
import type { FigmaScreenshotMeta } from "./api-types"
import { capturedText, fitMetaBudget } from "./screenshot-text"
import { utf8Length } from "./text"

// Screenshot freshness, contract §3.3: the text main captures for each linked layer at export, and how the UI keeps
// the E19 meta within budget.

describe("capturedText (rule 1)", () => {
  it("keeps up to 5,000 UTF-16 units", () => {
    expect(capturedText("x".repeat(5000))).toHaveLength(5000)
    expect(capturedText("x".repeat(5001))).toBeNull()
    expect(capturedText("😀".repeat(2500) + "x")).toBeNull()
    expect(capturedText("")).toBe("")
  })
})

describe("fitMetaBudget (SF2c)", () => {
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
  const box = (index: number, textValue: string | undefined) => ({
    key_id: "6a48" + String(index).padStart(20, "0"),
    node_id: "12:" + index,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    ...(textValue === undefined ? {} : { text: textValue }),
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

  it("drops every text when even the shortest does not fit, and keeps the boxes", () => {
    const full = meta([box(1, "Pay"), box(2, undefined), box(3, "Cancel")])
    const noTexts = meta([box(1, undefined), box(2, undefined), box(3, undefined)])
    const fitted = fitMetaBudget(full, bytes(noTexts))
    expect(fitted).toEqual(noTexts)
    expect(bytes(fitted)).toBe(bytes(noTexts))
  })

  it("keeps the real 900,000-byte budget with 500 long texts", () => {
    const boxes = Array.from({ length: 500 }, (_, index) => box(index, "€".repeat(4000 + index)))
    const fitted = fitMetaBudget(meta(boxes))
    expect(bytes(fitted)).toBeLessThanOrEqual(900000)
    expect(bytes(fitted)).toBeGreaterThan(900000 - 3 * 4500 - 20)
    expect(fitted.boxes).toHaveLength(500)
    // The longest texts (the last boxes) went first.
    const kept = fitted.boxes.filter((entry) => entry.text !== undefined).length
    expect(kept).toBeGreaterThan(0)
    expect(fitted.boxes.slice(0, kept).every((entry) => entry.text !== undefined)).toBe(true)
    expect(fitted.boxes.slice(kept).every((entry) => entry.text === undefined)).toBe(true)
  })
})
