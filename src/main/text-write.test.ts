import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  defaultStyle,
  fakeComponent,
  fakeFrame,
  fakeInstance,
  fakePage,
  fakeText,
  followText,
  installFigma,
  onPage,
  uninstallFigma,
  type FakeNode,
  type FakeText,
  type FigmaMock,
} from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, DATA_TOMBSTONE, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { NodeLink, PreviewInfo } from "../shared/messages"
import { parseLink, parsePreviewRecord, serializeLink, serializePreviewRecord, type PreviewRecord } from "../shared/plugin-data"
import { clearFontCache } from "./fonts"
import { applyPreview, applyTexts, resetPreview, SEGMENT_FIELDS } from "./text-write"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
  clearFontCache()
})

afterEach(() => {
  uninstallFigma()
})

const DE: Omit<PreviewInfo, "appliedAt"> = { lang: "de", source: "draft", variationOptionId: null }
const BOLD = { family: "Inter", style: "Bold" }

function record(node: FakeNode): PreviewRecord | null {
  return parsePreviewRecord(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview))
}

function linkOf(node: FakeNode): NodeLink | null {
  const parsed = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  return parsed.kind === "link" ? parsed.link : null
}

function link(nid: string, text: string): NodeLink {
  return { v: 1, id: keyId(1), k: "checkout_pay_button", p: PROJECT_ID, src: src(text), nid, t: 1 }
}

function segmentsOf(node: FakeText) {
  return node.getStyledTextSegments([...SEGMENT_FIELDS])
}

describe("preview-apply (§7.14 apply)", () => {
  it("stores the original with nid, turns autoRename off and writes the text", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    const before = segmentsOf(node)
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt zahlen" }], 1000)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(node.characters).toBe("Jetzt zahlen")
    expect(node.autoRename).toBe(false)
    expect(node.name).toBe("Pay now")
    expect(record(node)).toEqual({
      v: 1,
      nid: "1:1",
      previewSrc: src("Jetzt zahlen"),
      characters: "Pay now",
      autoRename: true,
      textOverridden: false,
      segments: before,
      richLost: false,
      lang: "de",
      source: "draft",
      variationOptionId: null,
      appliedAt: 1000,
    })
  })

  it("keeps the first original when another language is previewed", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt zahlen" }], 1)
    await applyPreview({ lang: "it", source: "published", variationOptionId: "opt1" }, [{ nodeId: "1:1", text: "Paga ora" }], 2)
    expect(node.characters).toBe("Paga ora")
    expect(record(node)).toMatchObject({ characters: "Pay now", autoRename: true, previewSrc: src("Paga ora"), lang: "it", source: "published", variationOptionId: "opt1", appliedAt: 2 })
  })

  it("loads every font once and reports missing fonts without writing", async () => {
    const node = fakeText("1:1", "Pay now")
    node.setRangeFontName.mockClear()
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    node.setRangeFontName(4, 7, BOLD)
    const missing = fakeText("1:2", "Missing", { hasMissingFont: true })
    const unloadable = fakeText("1:3", "Unloadable")
    unloadable.styles = unloadable.styles.map(() => defaultStyle({ fontName: { family: "Gone", style: "Regular" } }))
    figmaMock.missingFonts.add("Gone\u0000Regular")
    onPage(figmaMock, [node, missing, unloadable])
    const outcome = await applyPreview(DE, [
      { nodeId: "1:1", text: "Jetzt now" },
      { nodeId: "1:2", text: "Fehlt" },
      { nodeId: "1:3", text: "Nicht ladbar" },
    ], 1)
    expect(outcome.done).toBe(1)
    expect(outcome.errors.map((error) => [error.nodeId, error.code])).toEqual([
      ["1:2", "missing_font"],
      ["1:3", "missing_font"],
    ])
    expect(missing.characters).toBe("Missing")
    expect(record(missing)).toBeNull()
    expect(unloadable.characters).toBe("Unloadable")
    expect(record(unloadable)).toBeNull()
    const loads = figmaMock.loadFontAsync.mock.calls.map((call) => (call[0] as { family: string; style: string }).family + " " + (call[0] as { style: string }).style)
    expect(loads.filter((font) => font === "Inter Regular")).toHaveLength(1)
    expect(loads.filter((font) => font === "Inter Bold")).toHaveLength(1)
    expect(node.getRangeAllFontNames(6, 9)).toEqual([BOLD])
  })

  it("never writes text bound to a string variable", async () => {
    const node = fakeText("1:1", "Pay now", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "V:1" } } })
    onPage(figmaMock, [node])
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt" }], 1)
    expect(outcome).toEqual({ done: 0, errors: [{ nodeId: "1:1", code: "bound_to_variable", message: "Text comes from a Figma variable; change the variable instead" }] })
    expect(node.characters).toBe("Pay now")
  })

  it("reports layers that are gone", async () => {
    expect((await applyPreview(DE, [{ nodeId: "9:9", text: "x" }], 1)).errors[0].code).toBe("node_not_found")
  })

  it("previews main components first and skips instances that inherit the main's record", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.inheritFrom = mainText
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [instance])])
    const outcome = await applyPreview(DE, [
      { nodeId: "I12:34;5:67", text: "Jetzt zahlen" },
      { nodeId: "5:67", text: "Jetzt zahlen" },
    ], 1)
    expect(outcome).toEqual({ done: 2, errors: [] })
    expect(record(mainText)?.nid).toBe("5:67")
    expect(sublayer.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([])
    expect(sublayer.characters).toBe("Jetzt zahlen")
    expect(instance.overrides).toEqual([])
  })

  it("skips instance text that follows the previewed main even when the sublayer has plugin data of its own", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink({ ...link("I12:34;5:67", "Pay now"), id: keyId(2) }))
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [fakeComponent("5:1", "Button", [mainText]), instance])
    const outcome = await applyPreview(DE, [
      { nodeId: "I12:34;5:67", text: "Bezahlen" },
      { nodeId: "5:67", text: "Jetzt zahlen" },
    ], 1)
    expect(outcome).toEqual({ done: 2, errors: [] })
    expect(record(sublayer)).toBeNull()
    expect(sublayer.characters).toBe("Jetzt zahlen")

    expect(await resetPreview("page", undefined, undefined)).toEqual({ done: 1, errors: [] })
    expect(mainText.characters).toBe("Pay now")
    expect(sublayer.characters).toBe("Pay now")
    expect(instance.overrides).toEqual([{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }])
  })

  it("skips instance text that follows a previewed main whose record does not show through", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [fakeComponent("5:1", "Button", [mainText]), instance])
    await applyPreview(DE, [{ nodeId: "5:67", text: "Jetzt zahlen" }], 1)
    const outcome = await applyPreview(DE, [{ nodeId: "I12:34;5:67", text: "Jetzt zahlen" }], 2)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(sublayer.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe("")
    expect(instance.overrides).toEqual([])
  })

  it("previews a nested instance level before the instances that follow it", async () => {
    const mainText = fakeText("5:6", "Pay now")
    const nested = fakeText("I3:4;5:6", "Pay now")
    const nestedInstance = fakeInstance("3:4", "Button", [nested], { overrides: [] })
    followText(nested, mainText, nestedInstance)
    const outer = fakeText("I1:2;3:4;5:6", "Pay now")
    const outerInstance = fakeInstance("1:2", "Card", [outer], { overrides: [] })
    followText(outer, nested, outerInstance)
    onPage(figmaMock, [fakeComponent("5:1", "Button", [mainText]), fakeComponent("3:1", "Card", [nestedInstance]), outerInstance])
    const outcome = await applyPreview(DE, [
      { nodeId: "I1:2;3:4;5:6", text: "Jetzt zahlen" },
      { nodeId: "I3:4;5:6", text: "Jetzt zahlen" },
    ], 1)
    expect(outcome).toEqual({ done: 2, errors: [] })
    expect(record(nested)).toMatchObject({ nid: "I3:4;5:6", characters: "Pay now" })
    expect(record(outer)).toBeNull()
    expect(outer.characters).toBe("Jetzt zahlen")
    expect(outerInstance.overrides).toEqual([])
  })

  it("replaces a copied record with the node's own original", async () => {
    const node = fakeText("1:2", "Jetzt zahlen")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord({
      v: 1, nid: "1:1", previewSrc: src("Jetzt zahlen"), characters: "Pay now", autoRename: true, textOverridden: false,
      segments: null, richLost: false, lang: "de", source: "draft", variationOptionId: null, appliedAt: 1,
    }))
    onPage(figmaMock, [node])
    await applyPreview({ lang: "it", source: "draft", variationOptionId: null }, [{ nodeId: "1:2", text: "Paga ora" }], 2)
    expect(record(node)).toMatchObject({ nid: "1:2", characters: "Jetzt zahlen", lang: "it" })
  })

  it("records the instance's text override state on an instance sublayer", async () => {
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }] })])
    await applyPreview(DE, [{ nodeId: "I12:34;5:67", text: "Jetzt" }], 1)
    expect(record(sublayer)).toMatchObject({ nid: "I12:34;5:67", textOverridden: true })
  })

  it("re-applies a styled segment found in the new text", async () => {
    const node = fakeText("1:1", "Total: 42 EUR")
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    node.setRangeFontName(7, 9, BOLD)
    onPage(figmaMock, [node])
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Summe: 42 EUR" }], 1)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(node.getRangeAllFontNames(7, 9)).toEqual([BOLD])
    expect(node.getRangeAllFontNames(0, 7)).toEqual([{ family: "Inter", style: "Regular" }])
  })

  it("warns mixed_styles_flattened when a styled segment cannot be placed", async () => {
    const node = fakeText("1:1", "Total: 42 EUR")
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    node.setRangeFontName(7, 9, BOLD)
    onPage(figmaMock, [node])
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Summe" }], 1)
    expect(outcome.done).toBe(1)
    expect(outcome.errors).toEqual([{ nodeId: "1:1", code: "mixed_styles_flattened", message: "Some text styles couldn't be kept." }])
  })

  it("drops segments above 90,000 JSON chars (richLost)", async () => {
    const big = "x".repeat(95000)
    const node = fakeText("1:1", "Pay now", {
      getStyledTextSegments: () => [{ characters: "Pay now", start: 0, end: 7, ...defaultStyle(), hyperlink: { type: "URL", value: big } }],
    })
    onPage(figmaMock, [node])
    await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt" }], 1)
    expect(record(node)).toMatchObject({ segments: null, richLost: true, characters: "Pay now" })
  })

  it("refuses text too large to store as plugin data", async () => {
    const huge = "€".repeat(34000)
    const node = fakeText("1:1", huge, { getStyledTextSegments: () => [] })
    onPage(figmaMock, [node])
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt" }], 1)
    expect(outcome.errors[0].code).toBe("too_large")
    expect(node.characters).toBe(huge)
    expect(record(node)).toBeNull()
  })

  it("rolls the record back when the write fails", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    Object.defineProperty(node, "characters", {
      get: () => "Pay now",
      set: () => {
        throw new Error("write refused")
      },
    })
    const outcome = await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt" }], 1)
    expect(outcome.errors[0].code).toBe("write_failed")
    expect(record(node)).toBeNull()
    expect(node.autoRename).toBe(true)
  })
  it("keeps the previous preview intact when re-previewing fails", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt zahlen" }], 1)
    const before = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)
    Object.defineProperty(node, "characters", {
      get: () => "Jetzt zahlen",
      set: () => {
        throw new Error("write refused")
      },
    })
    const outcome = await applyPreview({ lang: "it", source: "draft", variationOptionId: null }, [{ nodeId: "1:1", text: "Paga ora" }], 2)
    expect(outcome.errors[0].code).toBe("write_failed")
    expect(node.autoRename).toBe(false)
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe(before)
  })
})

describe("preview-reset (§7.14 reset)", () => {
  async function previewed(node: FakeText, text = "Jetzt zahlen") {
    await applyPreview(DE, [{ nodeId: node.id, text }], 1)
  }

  it("restores text, autoRename and every style, then deletes the record", async () => {
    figmaMock.textStyles.set("S:heading", { fontName: BOLD, fontSize: 24 })
    figmaMock.fillStyles.set("S:brand", [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" }])
    figmaMock.variablesById.set("V:size", { id: "V:size", name: "size" })
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    const node = fakeText("1:1", "Hello brave world")
    await node.setRangeTextStyleIdAsync(0, 5, "S:heading")
    await node.setRangeFillStyleIdAsync(6, 11, "S:brand")
    node.setRangeBoundVariable(6, 11, "fontSize", { id: "V:size" })
    node.setRangeHyperlink(12, 17, { type: "URL", value: "https://rerune.io" })
    node.setRangeLetterSpacing(12, 17, { unit: "PIXELS", value: 2 })
    onPage(figmaMock, [node])
    const original = segmentsOf(node)
    await previewed(node, "Hallo mutige Welt")
    node.setRangeTextStyleIdAsync.mockClear()
    node.setRangeFillStyleIdAsync.mockClear()
    node.setRangeFontName.mockClear()

    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(node.characters).toBe("Hello brave world")
    expect(node.autoRename).toBe(true)
    expect(record(node)).toBeNull()
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe("")
    expect(segmentsOf(node)).toEqual(original)
    expect(node.setRangeTextStyleIdAsync).toHaveBeenCalledWith(0, 5, "S:heading")
    expect(node.setRangeFillStyleIdAsync).toHaveBeenCalledWith(6, 11, "S:brand")
    expect(node.setRangeFontName.mock.calls.some((call) => call[0] === 0)).toBe(false)
    expect(node.setRangeBoundVariable).toHaveBeenLastCalledWith(6, 11, "fontSize", { id: "V:size", name: "size" })
  })

  it("resets only the selection in selection scope", async () => {
    const a = fakeText("1:1", "A text")
    const b = fakeText("1:2", "B text")
    onPage(figmaMock, [a, b])
    await previewed(a)
    await previewed(b)
    figmaMock.currentPage.selection = [a]
    const outcome = await resetPreview("selection", undefined, undefined)
    expect(outcome.done).toBe(1)
    expect(a.characters).toBe("A text")
    expect(b.characters).toBe("Jetzt zahlen")
  })

  it("leaves inherited records alone and restores the main component", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.inheritFrom = mainText
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [instance]), component])
    await previewed(mainText)
    const writes: string[] = []
    const original = sublayer.setSharedPluginData
    sublayer.setSharedPluginData = (namespace: string, key: string, value: string) => {
      writes.push(key)
      original(namespace, key, value)
    }
    expect(sublayer.characters).toBe("Jetzt zahlen")
    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(mainText.characters).toBe("Pay now")
    expect(writes).toEqual([])
    expect(sublayer.characters).toBe("Pay now")
    expect(instance.overrides).toEqual([])
  })

  it("resets main components before their instances, so nothing is written on an instance with plugin data of its own", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.inheritFrom = mainText
    sublayer.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink({ ...link("I12:34;5:67", "Pay now"), id: keyId(2) }))
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [instance, fakeComponent("5:1", "Button", [mainText])])
    await previewed(mainText)
    expect(await resetPreview("page", undefined, undefined)).toEqual({ done: 1, errors: [] })
    expect(mainText.characters).toBe("Pay now")
    expect(sublayer.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([DATA_KEYS.link])
  })

  it("resets the main component, also on another page, when an instance that shows its preview is reset", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const components = fakePage("0:2", "Components", [fakeComponent("5:1", "Button", [mainText])])
    figmaMock.root.appendChild(components)
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [instance])])
    await previewed(mainText)

    expect(await resetPreview("page", ["I12:34;5:67"], undefined)).toEqual({ done: 1, errors: [] })
    expect(mainText.characters).toBe("Pay now")
    expect(record(mainText)).toBeNull()
    expect(sublayer.characters).toBe("Pay now")
    expect(sublayer.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([])

    await previewed(mainText)
    figmaMock.currentPage.selection = [instance]
    expect(await resetPreview("selection", undefined, undefined)).toEqual({ done: 1, errors: [] })
    expect(mainText.characters).toBe("Pay now")
  })

  it("reports remote_component for an instance that shows a preview kept in a library component", async () => {
    const libraryText = fakeText("77:1", "Jetzt zahlen")
    libraryText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord({
      v: 1, nid: "3:9", previewSrc: src("Jetzt zahlen"), characters: "Pay now", autoRename: true, textOverridden: false,
      segments: null, richLost: false, lang: "de", source: "draft", variationOptionId: null, appliedAt: 1,
    }))
    fakeComponent("77:0", "Button", [libraryText], { remote: true })
    const sublayer = fakeText("I12:34;77:1", "Jetzt zahlen")
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: [] })])
    const outcome = await resetPreview("page", ["I12:34;77:1"], undefined)
    expect(outcome).toEqual({ done: 0, errors: [{ nodeId: "I12:34;77:1", code: "remote_component", message: "Update this text in the library file." }] })
    expect(libraryText.characters).toBe("Jetzt zahlen")
  })

  it("restores skipInvisibleInstanceChildren when resets overlap", async () => {
    const a = fakeText("1:1", "A text")
    onPage(figmaMock, [a])
    await previewed(a)
    figmaMock.skipInvisibleInstanceChildren = true
    await Promise.all([resetPreview("page", undefined, undefined), resetPreview("page", undefined, undefined)])
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
    expect(a.characters).toBe("A text")
  })

  it("clears a copied record without touching the text", async () => {
    const node = fakeText("1:2", "Jetzt zahlen")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord({
      v: 1, nid: "1:1", previewSrc: src("Jetzt zahlen"), characters: "Pay now", autoRename: true, textOverridden: false,
      segments: null, richLost: false, lang: "de", source: "draft", variationOptionId: null, appliedAt: 1,
    }))
    onPage(figmaMock, [node])
    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(node.characters).toBe("Jetzt zahlen")
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe("")
  })

  it("reports layers edited during the preview, then keeps or restores them on request", async () => {
    const keep = fakeText("1:1", "Pay now")
    const restore = fakeText("1:2", "Cancel")
    onPage(figmaMock, [keep, restore])
    await previewed(keep, "Jetzt zahlen")
    await previewed(restore, "Abbrechen")
    keep.characters = "Jetzt sofort zahlen"
    restore.characters = "Abbruch"

    const first = await resetPreview("page", undefined, undefined)
    expect(first.done).toBe(0)
    expect(first.errors.map((error) => [error.nodeId, error.code])).toEqual([
      ["1:1", "edited_during_preview"],
      ["1:2", "edited_during_preview"],
    ])
    expect(record(keep)).not.toBeNull()

    expect(await resetPreview("page", ["1:1"], "keep")).toEqual({ done: 1, errors: [] })
    expect(keep.characters).toBe("Jetzt sofort zahlen")
    expect(record(keep)).toBeNull()

    expect(await resetPreview("page", ["1:2"], "restore")).toEqual({ done: 1, errors: [] })
    expect(restore.characters).toBe("Cancel")
    expect(record(restore)).toBeNull()
  })

  it("finds previewed instance children that are hidden now, and restores the flag", async () => {
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [] })
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [instance])])
    await previewed(sublayer)
    sublayer.visible = false
    figmaMock.skipInvisibleInstanceChildren = true
    let flagDuringReset: boolean | null = null
    const original = sublayer.setSharedPluginData
    sublayer.setSharedPluginData = (namespace: string, key: string, value: string) => {
      flagDuringReset = figmaMock.skipInvisibleInstanceChildren
      original(namespace, key, value)
    }
    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(sublayer.characters).toBe("Pay now")
    expect(flagDuringReset).toBe(false)
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })

  it("keeps the record and reports a missing font", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    await previewed(node)
    node.hasMissingFont = true
    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome.errors.map((error) => error.code)).toEqual(["missing_font"])
    expect(record(node)).not.toBeNull()
    expect(node.characters).toBe("Jetzt zahlen")
  })

  it("warns override_kept when an instance keeps a text override after reset", async () => {
    const overrides: { id: string; overriddenFields: string[] }[] = []
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: () => overrides })])
    await previewed(sublayer)
    overrides.push({ id: "I12:34;5:67", overriddenFields: ["characters", "pluginData"] })
    const outcome = await resetPreview("page", undefined, undefined)
    expect(outcome.done).toBe(1)
    expect(outcome.errors).toEqual([{ nodeId: "I12:34;5:67", code: "override_kept", message: "This instance keeps a text override after reset." }])
    expect(sublayer.characters).toBe("Pay now")
  })

  it("writes the tombstone when an own record cannot be cleared with an empty string", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    await previewed(node)
    const original = node.setSharedPluginData
    node.setSharedPluginData = (namespace: string, key: string, value: string) => {
      if (value !== "") {
        original(namespace, key, value)
      }
    }
    await resetPreview("page", undefined, undefined)
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe(DATA_TOMBSTONE)
    expect(record(node)).toBeNull()
  })

  it("reports explicit nodes that are not previewing or gone", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    const outcome = await resetPreview("page", ["1:1", "9:9"], "restore")
    expect(outcome.errors.map((error) => [error.nodeId, error.code])).toEqual([
      ["9:9", "node_not_found"],
      ["1:1", "not_previewing"],
    ])
  })
})

describe("text-apply (§7.14 pull)", () => {
  it("writes the text and the new src on the node's own link", async () => {
    const node = fakeText("1:1", "Pay now")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link("1:1", "Pay now")))
    onPage(figmaMock, [node])
    const outcome = await applyTexts([{ nodeId: "1:1", text: "Pay securely", src: src("Pay securely") }], 50)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(node.characters).toBe("Pay securely")
    expect(linkOf(node)).toEqual({ ...link("1:1", "Pay securely"), t: 50 })
    expect(record(node)).toBeNull()
  })

  it("writes text without a link when the layer is unlinked", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    expect(await applyTexts([{ nodeId: "1:1", text: "Pay", src: src("Pay") }], 1)).toEqual({ done: 1, errors: [] })
    expect(linkOf(node)).toBeNull()
  })

  it("refuses layers with an active preview or a variable binding", async () => {
    const previewing = fakeText("1:1", "Pay now")
    const bound = fakeText("1:2", "Pay now", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "V:1" } } })
    onPage(figmaMock, [previewing, bound])
    await applyPreview(DE, [{ nodeId: "1:1", text: "Jetzt" }], 1)
    const outcome = await applyTexts([
      { nodeId: "1:1", text: "Pay securely", src: src("Pay securely") },
      { nodeId: "1:2", text: "Pay securely", src: src("Pay securely") },
    ], 2)
    expect(outcome.errors.map((error) => [error.nodeId, error.code])).toEqual([
      ["1:1", "preview_active"],
      ["1:2", "bound_to_variable"],
    ])
    expect(previewing.characters).toBe("Jetzt")
    expect(bound.characters).toBe("Pay now")
  })

  it("refuses instance text that follows a previewed main component", async () => {
    const mainText = fakeText("5:67", "Pay now")
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link("I12:34;5:67", "Pay now")))
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }] })
    followText(sublayer, mainText, instance)
    onPage(figmaMock, [fakeComponent("5:1", "Button", [mainText]), instance])
    await applyPreview(DE, [{ nodeId: "5:67", text: "Jetzt zahlen" }], 1)
    const outcome = await applyTexts([{ nodeId: "I12:34;5:67", text: "Pay securely", src: src("Pay securely") }], 2)
    expect(outcome.errors.map((error) => [error.nodeId, error.code])).toEqual([["I12:34;5:67", "preview_active"]])
    expect(sublayer.characters).toBe("Jetzt zahlen")
    expect(instance.overrides).toEqual([{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }])
  })

  it("writes the local main component once for inherited instance text", async () => {
    const mainText = fakeText("5:67", "Pay now")
    mainText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link("5:67", "Pay now")))
    const component = fakeComponent("5:1", "Button", [mainText])
    const a = fakeText("I12:34;5:67", "Pay now")
    const b = fakeText("I13:1;5:67", "Pay now")
    a.inheritFrom = mainText
    b.inheritFrom = mainText
    onPage(figmaMock, [component, fakeInstance("12:34", "Button", [a], { overrides: [] }), fakeInstance("13:1", "Button", [b], { overrides: [] })])
    const outcome = await applyTexts([
      { nodeId: "I12:34;5:67", text: "Pay securely", src: src("Pay securely") },
      { nodeId: "I13:1;5:67", text: "Pay securely", src: src("Pay securely") },
    ], 3)
    expect(outcome).toEqual({ done: 2, errors: [] })
    expect(mainText.characters).toBe("Pay securely")
    expect(linkOf(mainText)?.src).toBe(src("Pay securely"))
    expect(a.characters).toBe("Pay now")
    expect(a.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([])
    expect(b.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([])
  })

  it("reports remote_component for text inherited from a library component", async () => {
    const sublayer = fakeText("I12:34;77:1", "Pay now")
    sublayer.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link("3:9", "Pay now")))
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: [] })])
    const outcome = await applyTexts([{ nodeId: "I12:34;77:1", text: "Pay securely", src: src("Pay securely") }], 1)
    expect(outcome.errors.map((error) => error.code)).toEqual(["remote_component"])
    expect(sublayer.characters).toBe("Pay now")
  })

  it("keeps a styled segment that still occurs in the pulled text", async () => {
    const node = fakeText("1:1", "Total: 42 EUR")
    figmaMock.loadedFonts.add("Inter\u0000Bold")
    node.setRangeFontName(7, 9, BOLD)
    onPage(figmaMock, [node])
    await applyTexts([{ nodeId: "1:1", text: "Grand total: 42 EUR", src: src("Grand total: 42 EUR") }], 1)
    expect(node.getRangeAllFontNames(13, 15)).toEqual([BOLD])
  })

  it("reports missing nodes", async () => {
    expect((await applyTexts([{ nodeId: "9:9", text: "x", src: src("x") }], 1)).errors[0].code).toBe("node_not_found")
  })
})
