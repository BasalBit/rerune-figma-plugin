import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defaultStyle, fakeText, installFigma, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { clearFontCache, fontKey, loadFont, loadFonts, loadNodeFonts, nodeFonts } from "./fonts"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
  clearFontCache()
})

afterEach(() => {
  uninstallFigma()
})

const REGULAR = { family: "Inter", style: "Regular" }
const BOLD = { family: "Inter", style: "Bold" }

describe("font cache", () => {
  it("keys fonts by family and style", () => {
    expect(fontKey(REGULAR)).toBe("Inter\u0000Regular")
  })

  it("requests each font once per run", async () => {
    await Promise.all([loadFont(REGULAR), loadFont(REGULAR), loadFont({ family: "Inter", style: "Regular" })])
    await loadFont(REGULAR)
    expect(figmaMock.loadFontAsync).toHaveBeenCalledTimes(1)
  })

  it("forgets a failed load so a later attempt can retry", async () => {
    figmaMock.missingFonts.add("Gone\u0000Regular")
    await expect(loadFont({ family: "Gone", style: "Regular" })).rejects.toThrow("could not be loaded")
    figmaMock.missingFonts.clear()
    await loadFont({ family: "Gone", style: "Regular" })
    expect(figmaMock.loadFontAsync).toHaveBeenCalledTimes(2)
  })

  it("deduplicates and ignores values that are not fonts", async () => {
    await loadFonts([REGULAR, BOLD, REGULAR, null, figmaMock.mixed, { family: "Inter" }])
    expect(figmaMock.loadFontAsync).toHaveBeenCalledTimes(2)
  })
})

describe("node fonts", () => {
  it("lists every font in the text", () => {
    const node = fakeText("1:1", "Pay now")
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    node.setRangeFontName(4, 7, BOLD)
    expect(nodeFonts(node as unknown as TextNode)).toEqual([REGULAR, BOLD])
  })

  it("uses fontName for an empty node", () => {
    const node = fakeText("1:1", "")
    expect(nodeFonts(node as unknown as TextNode)).toEqual([REGULAR])
  })

  it("returns a copy of Figma's frozen font list, so stored segment fonts can be added", async () => {
    const node = fakeText("1:1", "Pay")
    expect(Object.isFrozen(node.getRangeAllFontNames(0, 3))).toBe(true)
    expect(Object.isFrozen(nodeFonts(node as unknown as TextNode))).toBe(false)
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    await expect(loadNodeFonts(node as unknown as TextNode, [{ fontName: BOLD }])).resolves.toBeUndefined()
  })

  it("loads current fonts plus stored segment fonts", async () => {
    const node = fakeText("1:1", "Pay")
    node.styles = node.styles.map(() => defaultStyle({ fontName: { family: "Roboto", style: "Medium" } }))
    await loadNodeFonts(node as unknown as TextNode, [{ fontName: BOLD }, { fontName: undefined }])
    expect(figmaMock.loadFontAsync.mock.calls.map((call) => call[0])).toEqual([{ family: "Roboto", style: "Medium" }, BOLD])
  })
})
