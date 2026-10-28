import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeComponent, fakeFrame, fakeInstance, fakeText, followText, installFigma, loadFont, onPage, uninstallFigma, type FakeNode, type FigmaMock } from "./figma-mock"

// Figma hands out read-only values: arrays and objects the Plugin API returns are frozen, and changing one in place
// throws ("object is not extensible", "Cannot assign to read only property"; developers.figma.com/docs/plugins/
// editing-properties). The mock does the same, so main code that changes such a value fails in tests as it does in
// Figma, while the mock's own state stays mutable for the tests.

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

function frozenDeep(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true
  }
  return Object.isFrozen(value) && Object.values(value).every(frozenDeep)
}

describe("values the mock hands out", () => {
  it("freezes node lists and keeps their nodes live", () => {
    const text = fakeText("1:2", "Pay")
    const frame = fakeFrame("1:1", "Checkout", [text])
    onPage(figmaMock, [frame], [frame])
    const lists: unknown[][] = [
      frame.children,
      figmaMock.currentPage.selection as FakeNode[],
      frame.findAll(),
      frame.findAllWithCriteria({ types: ["TEXT"] }),
      figmaMock.root.children,
    ]
    for (const list of lists) {
      expect(Object.isFrozen(list)).toBe(true)
      expect(() => list.push(text)).toThrow(TypeError)
    }
    expect(frame.children[0]).toBe(text)
    expect((figmaMock.currentPage.selection as FakeNode[])[0]).toBe(frame)
    expect(Object.isFrozen(text)).toBe(false)
    figmaMock.currentPage.selection = [text]
    expect(figmaMock.currentPage.selection).toEqual([text])
  })

  it("freezes object-valued properties deeply and keeps the node's own value mutable", () => {
    const fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: true }]
    const frame = fakeFrame("1:1", "Card", [], {
      fills,
      strokes: [{ type: "SOLID", visible: true }],
      effects: [{ type: "DROP_SHADOW", radius: 4, offset: { x: 0, y: 4 } }],
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      absoluteRenderBounds: { x: 0, y: 0, width: 10, height: 10 },
    })
    for (const key of ["fills", "strokes", "effects", "absoluteBoundingBox", "absoluteRenderBounds"]) {
      expect(frozenDeep(frame[key])).toBe(true)
    }
    expect(() => {
      ;(frame.fills as { color: { r: number } }[])[0].color.r = 1
    }).toThrow(TypeError)
    expect(() => (frame.effects as unknown[]).push({})).toThrow(TypeError)
    expect(Object.isFrozen(fills)).toBe(false)
    frame.fills = []
    expect(frame.fills).toEqual([])
    frame.absoluteBoundingBox = null
    expect(frame.absoluteBoundingBox).toBeNull()
  })

  it("freezes a text's fonts, segments and bindings, not the text's own styles", () => {
    loadFont(figmaMock)
    const text = fakeText("1:1", "Pay", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "v1" } }, componentPropertyReferences: { characters: "Label#1:0" } })
    const values = [text.fontName, text.getRangeAllFontNames(0, 3), text.getStyledTextSegments(["fontName", "fills"]), text.boundVariables, text.componentPropertyReferences, text.absoluteBoundingBox]
    for (const value of values) {
      expect(frozenDeep(value)).toBe(true)
    }
    expect(() => text.getRangeAllFontNames(0, 3).push({ family: "Inter", style: "Bold" })).toThrow(TypeError)
    expect(Object.isFrozen(text.styles[0].fontName)).toBe(false)
    text.setRangeFontName(0, 1, text.getRangeAllFontNames(0, 1)[0])
    expect(Object.isFrozen(text.styles[0].fontName)).toBe(false)
  })

  it("freezes instance overrides; followText still records the characters override", () => {
    loadFont(figmaMock)
    const mainText = fakeText("5:67", "Pay now")
    fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }] })
    followText(sublayer, mainText, instance)
    expect(frozenDeep(instance.overrides)).toBe(true)
    expect(() => instance.overrides[0].overriddenFields.push("characters")).toThrow(TypeError)
    sublayer.characters = "Jetzt zahlen"
    expect(instance.overrides).toEqual([{ id: "I12:34;5:67", overriddenFields: ["pluginData", "characters"] }])
    instance.overrides = []
    expect(instance.overrides).toEqual([])
  })

  it("copies the handed-out properties into a clone", () => {
    const frame = fakeFrame("1:1", "Card", [], { absoluteBoundingBox: { x: 1, y: 2, width: 3, height: 4 }, fills: [{ type: "SOLID" }] })
    const copy = frame.clone()
    expect(copy.absoluteBoundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(copy.fills).toEqual([{ type: "SOLID" }])
    expect(Object.isFrozen(copy.fills)).toBe(true)
  })

  it("freezes what clientStorage and plugin data reads return", async () => {
    const node = fakeText("1:1", "Pay")
    node.setSharedPluginData("rerune", "link", "x")
    node.setRelaunchData({ open: "ReRune" })
    await figmaMock.clientStorage.setAsync("prefs", { lang: { code: "de" } })
    expect(frozenDeep(await figmaMock.clientStorage.getAsync("prefs"))).toBe(true)
    expect(Object.isFrozen(await figmaMock.clientStorage.keysAsync())).toBe(true)
    expect(Object.isFrozen(node.getSharedPluginDataKeys("rerune"))).toBe(true)
    expect(Object.isFrozen(node.getRelaunchData())).toBe(true)
    expect(Object.isFrozen(figmaMock.clientStorage.data.get("prefs"))).toBe(false)
  })
})
