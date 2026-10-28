import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fakeComponent,
  fakeComponentSet,
  fakeFrame,
  fakeGroup,
  fakeInstance,
  fakePage,
  fakeSection,
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
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi, PreviewInfo } from "../shared/messages"
import { LANGUAGE_COPY_MESSAGES } from "../shared/node-errors"
import { parseLangCopy, parseLink, serializeLangCopy, serializeLink } from "../shared/plugin-data"
import { createMainBus } from "./bus"
import { clearFontCache } from "./fonts"
import { registerHandlers, type MainContext } from "./handlers"
import { checkOverflow, constrainingParent, LANGUAGE_COPY_GAP, languageCopiesOf, makeLanguageCopies, mapCopyTexts, parentBoxOf, type LanguageCopyRequest } from "./qa"
import { createScanner } from "./scan"
import { applyPreview } from "./text-write"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
  clearFontCache()
})

afterEach(() => {
  uninstallFigma()
})

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const NS = PLUGIN_DATA_NAMESPACE
const DE: Omit<PreviewInfo, "appliedAt"> = { lang: "de", source: "draft", variationOptionId: null }

function context(): MainContext {
  return {
    editorType: "figma",
    env: "development",
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: true, command: "" },
    inspect: null,
  }
}

async function exchange(message: Record<string, unknown>): Promise<MainToUi[]> {
  const sent: MainToUi[] = []
  const bus = createMainBus("figma", "development", (answer) => sent.push(answer))
  registerHandlers(bus, context())
  await bus.dispatch(message)
  return sent
}

function link(node: FakeNode, n: number, text: string): void {
  node.setSharedPluginData(NS, DATA_KEYS.link, serializeLink({ v: 1, id: keyId(n), k: "key_" + n, p: PROJECT_ID, src: src(text), nid: node.id, t: 1 }))
}

describe("overflow-check (§7.18.1)", () => {
  describe("(a) fixed box without truncation → clipped", () => {
    it("measures the height the text needs on a clone, removes it again, and reports nothing within the tolerance", async () => {
      const long = fakeText("1:1", "Jetzt bezahlen und Versand wählen", { textAutoResize: "NONE", height: 20, measuredHeight: 52, absoluteBoundingBox: rect(0, 0, 100, 20), absoluteRenderBounds: rect(0, 2, 100, 48) })
      const fits = fakeText("1:2", "Zahlen", { textAutoResize: "NONE", height: 20, measuredHeight: 21.5, absoluteBoundingBox: rect(0, 30, 100, 20), absoluteRenderBounds: rect(0, 33, 60, 14) })
      const frame = fakeFrame("10:1", "Checkout", [long, fits])
      onPage(figmaMock, [frame])
      const append = vi.spyOn(figmaMock.currentPage, "appendChild")

      expect(await checkOverflow(["1:1", "1:2"])).toEqual([{ nodeId: "1:1", kind: "clipped", by: 32 }])
      // Figma parents a clone under the page, and checkOverflow moves it to the page's top level once more.
      const clones = [...new Set(append.mock.calls.map((call) => call[0] as FakeText))].filter((node) => node !== frame)
      expect(clones).toHaveLength(2)
      expect(clones.every((clone) => clone.removed && clone.textAutoResize === "HEIGHT")).toBe(true)
      expect([long.textAutoResize, long.height, fits.height]).toEqual(["NONE", 20, 20])
      expect(frame.allChildren).toEqual([long, fits])
    })

    it("finds one more line in a box with spare height, although the glyphs are no taller than the box", async () => {
      // The glyphs start 6 px below the top (half-leading, ascender gap) and end 5 px below the box.
      const label = fakeText("1:1", "Kostenloser Versand für alle Bestellungen", { textAutoResize: "NONE", width: 200, height: 40, measuredHeight: 48, absoluteBoundingBox: rect(0, 0, 200, 40), absoluteRenderBounds: rect(1, 6, 180, 39) })
      onPage(figmaMock, [label])
      expect(await checkOverflow(["1:1"])).toEqual([{ nodeId: "1:1", kind: "clipped", by: 8 }])
    })

    it("does not count a tight line height as overflow, and finds a word wider than the box by its render bounds", async () => {
      // Line height 100%: descenders reach past the box, but the text fits its lines.
      const tight = fakeText("1:1", "Zahlung", { textAutoResize: "NONE", height: 16, measuredHeight: 16, absoluteBoundingBox: rect(0, 0, 100, 16), absoluteRenderBounds: rect(0, -1, 60, 19) })
      const wide = fakeText("1:2", "Donaudampfschifffahrt", { textAutoResize: "NONE", height: 20, measuredHeight: 20, absoluteBoundingBox: rect(0, 40, 100, 20), absoluteRenderBounds: rect(0, 42, 124.26, 16) })
      onPage(figmaMock, [tight, wide])
      expect(await checkOverflow(["1:1", "1:2"])).toEqual([{ nodeId: "1:2", kind: "clipped", by: 24.3 }])
    })

    it("allows for a drop shadow on the sides it reaches, and only there", async () => {
      const shadow = { effects: [{ type: "DROP_SHADOW", visible: true, radius: 0, offset: { x: 4, y: 0 }, spread: 0 }], strokes: [], strokeWeight: 0, strokeAlign: "OUTSIDE" }
      const fits = fakeText("1:1", "Zahlen", { textAutoResize: "NONE", absoluteBoundingBox: rect(0, 0, 100, 20), absoluteRenderBounds: rect(0, 4, 104, 12), ...shadow })
      // 3 px past the left edge, where a shadow moved to the right does not reach.
      const spills = fakeText("1:2", "Weiter", { textAutoResize: "NONE", absoluteBoundingBox: rect(0, 40, 100, 20), absoluteRenderBounds: rect(-3, 44, 107, 12), ...shadow })
      onPage(figmaMock, [fits, spills])
      expect(await checkOverflow(["1:1", "1:2"])).toEqual([{ nodeId: "1:2", kind: "clipped", by: 3 }])
    })

    it("measures text without render bounds (cut off inside an instance) on the clone", async () => {
      const inInstance = fakeText("I5:1;3:2", "Weiter zum Bezahlen", { textAutoResize: "NONE", height: 20, measuredHeight: 40, absoluteBoundingBox: rect(0, 0, 100, 20), absoluteRenderBounds: null })
      onPage(figmaMock, [fakeInstance("5:1", "Button", [inInstance])])
      expect(await checkOverflow(["I5:1;3:2"])).toEqual([{ nodeId: "I5:1;3:2", kind: "clipped", by: 20 }])
    })

    it("compares the render bounds' top and bottom when no clone can be measured", async () => {
      const refused = fakeText("1:1", "Zahlen", { textAutoResize: "NONE", height: 20, measuredHeight: 60, absoluteBoundingBox: rect(0, 0, 100, 20), absoluteRenderBounds: rect(0, 4, 100, 32) })
      refused.clone = () => {
        throw new Error("Cannot clone")
      }
      const missing = fakeText("1:2", "Weiter", { textAutoResize: "NONE", height: 20, measuredHeight: 60, hasMissingFont: true, absoluteBoundingBox: rect(0, 40, 100, 20), absoluteRenderBounds: rect(0, 44, 100, 12) })
      const unknown = fakeText("1:3", "Zurück", { textAutoResize: "NONE", absoluteBoundingBox: rect(0, 80, 100, 20), absoluteRenderBounds: null })
      unknown.clone = refused.clone
      onPage(figmaMock, [refused, missing, unknown])
      expect(await checkOverflow(["1:1", "1:2", "1:3"])).toEqual([{ nodeId: "1:1", kind: "clipped", by: 16 }])
      expect(figmaMock.currentPage.allChildren).toHaveLength(3)
    })
  })

  describe("(b) truncating text → truncated", () => {
    it("measures a clone without truncation and removes it again", async () => {
      const label = fakeText("1:1", "Jetzt bezahlen und Versand wählen", { textAutoResize: "NONE", textTruncation: "ENDING", maxLines: 1, height: 20, measuredHeight: 60, absoluteBoundingBox: rect(0, 0, 100, 20) })
      const frame = fakeFrame("10:1", "Checkout", [label], { layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" })
      onPage(figmaMock, [frame])
      const before = figmaMock.currentPage.allChildren.map((node) => node.id)
      const append = vi.spyOn(figmaMock.currentPage, "appendChild")

      expect(await checkOverflow(["1:1"])).toEqual([{ nodeId: "1:1", kind: "truncated", by: 40 }])
      // The clone went to the top of the page (never into the auto-layout frame) and is gone again.
      expect(append).toHaveBeenCalledTimes(2)
      const clone = append.mock.calls[0][0] as FakeText
      expect(clone).not.toBe(label)
      expect(clone.removed).toBe(true)
      expect([clone.textTruncation, clone.maxLines, clone.textAutoResize]).toEqual(["DISABLED", null, "HEIGHT"])
      expect(figmaMock.currentPage.allChildren.map((node) => node.id)).toEqual(before)
      expect(frame.allChildren).toEqual([label])
      // The layer itself is unchanged.
      expect([label.textTruncation, label.maxLines, label.textAutoResize, label.height]).toEqual(["ENDING", 1, "NONE", 20])
      expect(figmaMock.loadFontAsync).toHaveBeenCalledWith({ family: "Inter", style: "Regular" })
    })

    it("reports nothing when the text fits, and measures instance text and the deprecated TRUNCATE mode", async () => {
      const fits = fakeText("1:1", "Zahlen", { textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 2, height: 40, measuredHeight: 20 })
      const inInstance = fakeText("I5:1;3:2", "Weiter zum Bezahlen", { textAutoResize: "TRUNCATE", height: 16, measuredHeight: 32 })
      onPage(figmaMock, [fits, fakeInstance("5:1", "Button", [inInstance])])
      expect(await checkOverflow(["1:1", "I5:1;3:2"])).toEqual([{ nodeId: "I5:1;3:2", kind: "truncated", by: 16 }])
    })

    it("skips text with a missing font and a clone Figma refuses, and keeps the other checks", async () => {
      const missing = fakeText("1:1", "Zahlen", { textAutoResize: "NONE", textTruncation: "ENDING", height: 20, measuredHeight: 60, hasMissingFont: true })
      const refused = fakeText("1:2", "Weiter", { textAutoResize: "HEIGHT", textTruncation: "ENDING", height: 20, measuredHeight: 60, absoluteBoundingBox: rect(0, 0, 300, 20) })
      refused.clone = () => {
        throw new Error("Cannot clone")
      }
      const unloadable = fakeText("1:3", "Zurück", { textAutoResize: "NONE", textTruncation: "ENDING", height: 20, measuredHeight: 60 })
      unloadable.styles = unloadable.styles.map((style) => ({ ...style, fontName: { family: "Gone", style: "Regular" } }))
      figmaMock.missingFonts.add("Gone\u0000Regular")
      onPage(figmaMock, [fakeFrame("10:1", "Card", [missing, refused, unloadable], { absoluteBoundingBox: rect(0, 0, 200, 100) })])
      expect(await checkOverflow(["1:1", "1:2", "1:3"])).toEqual([{ nodeId: "1:2", kind: "exceeds_parent", by: 100 }])
      expect(figmaMock.currentPage.allChildren).toHaveLength(1)
    })
  })

  describe("(c) auto-sized text in a fixed parent → exceeds_parent", () => {
    it("compares with the inner box of a frame without auto layout", async () => {
      const text = fakeText("1:1", "Kostenloser Versand ab 50 €", { textAutoResize: "WIDTH_AND_HEIGHT", absoluteBoundingBox: rect(10, 10, 230, 20) })
      onPage(figmaMock, [fakeFrame("10:1", "Badge", [text], { absoluteBoundingBox: rect(0, 0, 200, 40), paddingLeft: 30, layoutMode: "NONE" })])
      // Padding only applies to auto layout.
      expect(await checkOverflow(["1:1"])).toEqual([{ nodeId: "1:1", kind: "exceeds_parent", by: 40 }])
    })

    it("uses auto-layout padding and skips axes the parent hugs", async () => {
      const wide = fakeText("1:1", "Jetzt bezahlen und Versand wählen", { textAutoResize: "WIDTH_AND_HEIGHT", absoluteBoundingBox: rect(16, 12, 220, 20) })
      const button = fakeFrame("10:1", "Button", [wide], {
        absoluteBoundingBox: rect(0, 0, 200, 44),
        layoutMode: "HORIZONTAL",
        primaryAxisSizingMode: "FIXED",
        counterAxisSizingMode: "AUTO",
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "HUG",
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 12,
        paddingBottom: 12,
      })
      const tall = fakeText("1:2", "Ein langer Absatz", { textAutoResize: "HEIGHT", absoluteBoundingBox: rect(8, 8, 100, 300) })
      const column = fakeFrame("10:2", "Column", [tall], { absoluteBoundingBox: rect(0, 0, 116, 120), layoutMode: "VERTICAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED", paddingLeft: 8, paddingRight: 8, paddingTop: 8, paddingBottom: 8 })
      onPage(figmaMock, [button, column])
      expect(await checkOverflow(["1:1", "1:2"])).toEqual([{ nodeId: "1:1", kind: "exceeds_parent", by: 52 }])
    })

    it("looks through groups to the frame and ignores text on the page or in a section", async () => {
      const grouped = fakeText("1:1", "Weiter", { textAutoResize: "WIDTH_AND_HEIGHT", absoluteBoundingBox: rect(0, 0, 150, 20) })
      const loose = fakeText("1:2", "Lose", { textAutoResize: "WIDTH_AND_HEIGHT", absoluteBoundingBox: rect(0, 0, 9000, 20) })
      const inSection = fakeText("1:3", "Abschnitt", { textAutoResize: "HEIGHT", absoluteBoundingBox: rect(0, 0, 100, 9000) })
      const frame = fakeFrame("10:1", "Card", [fakeGroup("11:1", "Group", [grouped])], { absoluteBoundingBox: rect(0, 0, 100, 100) })
      onPage(figmaMock, [frame, loose, fakeSection("9:1", "Flows", [inSection])])
      expect(constrainingParent(grouped as unknown as BaseNode)?.id).toBe("10:1")
      expect(constrainingParent(loose as unknown as BaseNode)).toBeNull()
      expect(await checkOverflow(["1:1", "1:2", "1:3"])).toEqual([{ nodeId: "1:1", kind: "exceeds_parent", by: 50 }])
    })

    it("caches the parent box per check and treats an unreadable parent box as unknown", () => {
      const a = fakeText("1:1", "A")
      const b = fakeText("1:2", "B")
      const frame = fakeFrame("10:1", "Card", [a, b], { absoluteBoundingBox: rect(0, 0, 100, 100) })
      const broken = fakeFrame("10:2", "Broken", [fakeText("1:3", "C")])
      Object.defineProperty(broken, "absoluteBoundingBox", {
        get: () => {
          throw new Error("unreadable")
        },
      })
      onPage(figmaMock, [frame, broken])
      const cache = new Map()
      const first = parentBoxOf(a as unknown as BaseNode, cache)
      expect(first).toEqual({ box: rect(0, 0, 100, 100), padding: { left: 0, right: 0, top: 0, bottom: 0 }, fixedWidth: true, fixedHeight: true })
      expect(parentBoxOf(b as unknown as BaseNode, cache)).toBe(first)
      expect(parentBoxOf(broken.allChildren[0] as unknown as BaseNode, cache)).toBeNull()
    })
  })

  it("reports several kinds for one layer, each once, and skips unknown, removed and repeated ids", async () => {
    const text = fakeText("1:1", "Jetzt bezahlen", { textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 1, height: 20, measuredHeight: 44, absoluteBoundingBox: rect(0, 0, 100, 20) })
    const gone = fakeText("1:2", "Weg", { textAutoResize: "NONE", absoluteBoundingBox: rect(0, 0, 10, 10), absoluteRenderBounds: rect(0, 0, 10, 90) })
    onPage(figmaMock, [fakeFrame("10:1", "Card", [text, gone], { absoluteBoundingBox: rect(0, 0, 80, 100) })])
    gone.remove()
    expect(await checkOverflow(["1:1", "9:9", "1:2", "1:1"])).toEqual([
      { nodeId: "1:1", kind: "truncated", by: 24 },
      { nodeId: "1:1", kind: "exceeds_parent", by: 20 },
    ])
  })

  it("answers overflow-check with overflow-result, and a malformed request with a handler-error", async () => {
    onPage(figmaMock, [fakeText("1:1", "Zahlen", { textAutoResize: "NONE", height: 20, measuredHeight: 40, absoluteBoundingBox: rect(0, 0, 100, 20), absoluteRenderBounds: rect(0, 0, 100, 40) })])
    expect(await exchange({ type: "overflow-check", requestId: "c1-1", nodeIds: ["1:1"] })).toEqual([
      { type: "overflow-result", requestId: "c1-1", items: [{ nodeId: "1:1", kind: "clipped", by: 20 }] },
    ])
    const bad = await exchange({ type: "overflow-check", requestId: "c1-2", nodeIds: "1:1" })
    expect(bad).toEqual([{ type: "handler-error", forType: "overflow-check", requestId: "c1-2", message: "nodeIds must be a list of node ids" }])
  })
})

// ---------------------------------------------------------------------------------------------------------------

function copyRequest(lang: string, texts: Record<string, string>): LanguageCopyRequest {
  return { lang, source: "draft", variationOptionId: null, texts: Object.entries(texts).map(([nodeId, text]) => ({ nodeId, text })) }
}

function copiesOf(parent: FakeNode, frame: FakeNode): FakeNode[] {
  return parent.allChildren.filter((node) => node !== frame && node.name.startsWith(frame.name + " · "))
}

// Every text layer under the node, hidden instance children included (whatever skipInvisibleInstanceChildren says).
function textsOf(node: FakeNode): FakeText[] {
  const found: FakeText[] = []
  const visit = (entry: FakeNode) => {
    for (const child of entry.allChildren) {
      if (child.type === "TEXT") found.push(child as FakeText)
      visit(child)
    }
  }
  visit(node)
  return found
}

function checkoutFrame(): { frame: FakeNode; title: FakeText; pay: FakeText } {
  const title = fakeText("1:2", "Checkout")
  link(title, 1, "Checkout")
  const pay = fakeText("1:3", "Pay now")
  link(pay, 2, "Pay now")
  const frame = fakeFrame("1:1", "Checkout", [title, pay], { x: 100, y: 40, width: 375, height: 812 })
  return { frame, title, pay }
}

describe("language-copies (§7.18.4, D32)", () => {
  it("copies the frame once per language, next to the original, marked and translated", async () => {
    const { frame, title, pay } = checkoutFrame()
    const other = fakeFrame("2:1", "Other", [], { x: 0, y: 0, width: 10, height: 10 })
    onPage(figmaMock, [frame, other])

    const outcome = await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse", "1:3": "Jetzt zahlen" }), copyRequest("it", { "1:2": "Cassa" })], 1000)

    expect(outcome).toEqual({ done: 3, errors: [] })
    const page = figmaMock.currentPage
    expect(page.allChildren.map((node) => node.name)).toEqual(["Checkout", "Checkout · de", "Checkout · it", "Other"])
    const [de, it] = copiesOf(page, frame)
    expect([de.x, de.y]).toEqual([100 + (375 + LANGUAGE_COPY_GAP), 40])
    expect([it.x, it.y]).toEqual([100 + (375 + LANGUAGE_COPY_GAP) * 2, 40])
    expect(parseLangCopy(de.getSharedPluginData(NS, DATA_KEYS.langCopy))).toEqual({ v: 1, nid: de.id, lang: "de", source: "draft", variationOptionId: null, sourceFrameId: "1:1", createdAt: 1000 })
    expect(parseLangCopy(it.getSharedPluginData(NS, DATA_KEYS.langCopy))?.nid).toBe(it.id)
    expect(textsOf(de).map((node) => [node.characters, node.name, node.autoRename])).toEqual([["Kasse", "Checkout", false], ["Jetzt zahlen", "Pay now", false]])
    // A missing value keeps the source text.
    expect(textsOf(it).map((node) => node.characters)).toEqual(["Cassa", "Pay now"])
    // The copies' layers keep the copied links (another node's nid), which scans never see.
    expect(parseLink(textsOf(de)[0].getSharedPluginData(NS, DATA_KEYS.link))).toMatchObject({ kind: "link", link: { nid: "1:2" } })
    // The original is untouched.
    expect([title.characters, pay.characters, title.autoRename, frame.name]).toEqual(["Checkout", "Pay now", true, "Checkout"])
    expect(frame.getSharedPluginData(NS, DATA_KEYS.langCopy)).toBe("")
  })

  it("keeps a copy of a frame inside a section in that section", async () => {
    const { frame } = checkoutFrame()
    const section = fakeSection("9:1", "Flows", [frame, fakeFrame("3:1", "Next", [], { x: 600, y: 0, width: 10, height: 10 })])
    onPage(figmaMock, [section])
    expect(await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse" })], 1)).toEqual({ done: 1, errors: [] })
    expect(section.allChildren.map((node) => node.name)).toEqual(["Checkout", "Checkout · de", "Next"])
    expect(figmaMock.currentPage.allChildren.map((node) => node.id)).toEqual(["9:1"])
    expect(copiesOf(section, frame)[0].x).toBe(100 + 375 + LANGUAGE_COPY_GAP)
  })

  it("loads the page of a frame that is no longer on the current page", async () => {
    const { frame } = checkoutFrame()
    const other = fakePage("0:2", "Desktop", [frame])
    figmaMock.root.appendChild(other)
    expect(await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse" })], 1)).toEqual({ done: 1, errors: [] })
    expect(other.loadAsync).toHaveBeenCalledTimes(1)
    expect(other.allChildren.map((node) => node.name)).toEqual(["Checkout", "Checkout · de"])
  })

  it("refuses the whole frame when its page can't be loaded", async () => {
    const { frame } = checkoutFrame()
    const other = fakePage("0:2", "Desktop", [frame])
    figmaMock.root.appendChild(other)
    other.loadAsync = vi.fn(async () => Promise.reject(new Error("offline")))
    expect(await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse" }), copyRequest("it", { "1:2": "Cassa" })], 1)).toEqual({
      done: 0,
      errors: [{ nodeId: "1:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.pageNotLoaded }],
    })
    expect(other.allChildren.map((node) => node.name)).toEqual(["Checkout"])
  })

  it("copies a top-level instance and maps its sublayers", async () => {
    const mainText = fakeText("5:2", "Pay now")
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I6:1;5:2", "Pay now")
    const instance = fakeInstance("6:1", "Button", [sublayer], { overrides: [], mainComponent: component })
    Object.assign(instance, { x: 0, y: 0, width: 120, height: 40 })
    onPage(figmaMock, [component, instance])
    expect(await makeLanguageCopies(["6:1"], [copyRequest("de", { "I6:1;5:2": "Jetzt zahlen" })], 1)).toEqual({ done: 1, errors: [] })
    const copy = copiesOf(figmaMock.currentPage, instance)[0]
    expect(copy.type).toBe("INSTANCE")
    expect(textsOf(copy).map((node) => [node.id, node.characters])).toEqual([["I" + copy.id + ";5:2", "Jetzt zahlen"]])
    expect(sublayer.characters).toBe("Pay now")
  })

  it("refuses components and component sets, and copies the other frames", async () => {
    const { frame } = checkoutFrame()
    const component = fakeComponent("5:1", "Button", [fakeText("5:2", "Pay now")])
    const set = fakeComponentSet("7:1", "Chip", [fakeComponent("7:2", "State=On", [fakeText("7:3", "On")])])
    onPage(figmaMock, [frame, component, set])
    const outcome = await makeLanguageCopies(["5:1", "7:1", "1:1"], [copyRequest("de", { "1:2": "Kasse", "5:2": "Zahlen", "7:3": "An" })], 1)
    expect(outcome.done).toBe(1)
    expect(outcome.errors).toEqual([
      { nodeId: "5:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.component },
      { nodeId: "7:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.component },
    ])
    expect(LANGUAGE_COPY_MESSAGES.component).toBe("Language copies work on frames; place an instance in a frame first.")
    expect(figmaMock.currentPage.allChildren.map((node) => node.name)).toEqual(["Checkout", "Checkout · de", "Button", "Chip"])
  })

  it("refuses frames that are not top-level, groups, language copies and missing frames", async () => {
    const inner = fakeFrame("1:5", "Inner", [fakeText("1:6", "Hi")], { x: 0, y: 0, width: 10, height: 10 })
    const outer = fakeFrame("1:4", "Outer", [inner], { x: 0, y: 0, width: 50, height: 50 })
    const group = fakeGroup("2:1", "Group", [fakeText("2:2", "Hi")])
    const copy = fakeFrame("3:1", "Checkout · de", [fakeText("3:2", "Kasse")], { x: 0, y: 0, width: 10, height: 10 })
    copy.setSharedPluginData(NS, DATA_KEYS.langCopy, serializeLangCopy({ v: 1, nid: "3:1", lang: "de", source: "draft", variationOptionId: null, sourceFrameId: "1:1", createdAt: 1 }))
    onPage(figmaMock, [outer, group, copy])
    const outcome = await makeLanguageCopies(["1:5", "2:1", "3:1", "9:9", "3:1"], [copyRequest("de", {})], 1)
    expect(outcome).toEqual({
      done: 0,
      errors: [
        { nodeId: "1:5", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.notFrame },
        { nodeId: "2:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.notFrame },
        { nodeId: "3:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.alreadyCopy },
        { nodeId: "9:9", code: "node_not_found", message: "Layer not found. It may be hidden or deleted." },
      ],
    })
    expect(figmaMock.currentPage.allChildren).toHaveLength(3)
  })

  it("is refused as a whole while a text in the frames shows a preview, including a hidden instance child", async () => {
    const { frame } = checkoutFrame()
    const mainText = fakeText("5:2", "Pay now")
    const component = fakeComponent("5:1", "Button", [mainText])
    const hidden = fakeText("I6:1;5:2", "Pay now")
    const instance = fakeInstance("6:1", "Button", [hidden], { overrides: [], mainComponent: component })
    followText(hidden, mainText, instance)
    hidden.visible = false
    const second = fakeFrame("8:1", "Profile", [instance], { x: 0, y: 900, width: 375, height: 812 })
    onPage(figmaMock, [frame, second, component])
    // The main component previews German; the instance's hidden text follows it.
    expect((await applyPreview(DE, [{ nodeId: "5:2", text: "Jetzt zahlen" }], 1)).errors).toEqual([])
    figmaMock.skipInvisibleInstanceChildren = true

    const outcome = await makeLanguageCopies(["1:1", "8:1"], [copyRequest("de", { "1:2": "Kasse" })], 1)
    expect(outcome).toEqual({ done: 0, errors: [{ nodeId: "8:1", code: "preview_active", message: "Reset previews first." }] })
    expect(figmaMock.currentPage.allChildren.map((node) => node.name)).toEqual(["Checkout", "Profile", "Button"])
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })

  it("is refused when the frame's own text previews", async () => {
    const { frame } = checkoutFrame()
    onPage(figmaMock, [frame])
    await applyPreview(DE, [{ nodeId: "1:3", text: "Jetzt zahlen" }], 1)
    const outcome = await makeLanguageCopies(["1:1"], [copyRequest("it", { "1:2": "Cassa" })], 1)
    expect(outcome.errors).toEqual([{ nodeId: "1:1", code: "preview_active", message: LANGUAGE_COPY_MESSAGES.previewing }])
    expect(figmaMock.currentPage.allChildren).toHaveLength(1)
  })

  it("maps a nested main component's hidden child with skipInvisibleInstanceChildren off and restores the flag", async () => {
    const visible = fakeText("5:2", "Pay now")
    const hidden = fakeText("5:3", "Processing…")
    hidden.visible = false
    const component = fakeComponent("5:1", "Button", [visible, hidden])
    const footer = fakeText("1:9", "Terms")
    const frame = fakeFrame("1:1", "Checkout", [component, footer], { x: 0, y: 0, width: 375, height: 812 })
    onPage(figmaMock, [frame])
    figmaMock.skipInvisibleInstanceChildren = true

    const outcome = await makeLanguageCopies(["1:1"], [copyRequest("de", { "5:2": "Jetzt zahlen", "5:3": "Wird bearbeitet…", "1:9": "AGB" })], 1)

    expect(outcome).toEqual({ done: 3, errors: [] })
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
    const copy = copiesOf(figmaMock.currentPage, frame)[0]
    // The copied main component is an instance of it now; its hidden child was still mapped and written.
    expect(copy.allChildren[0].type).toBe("INSTANCE")
    expect(textsOf(copy).map((node) => node.characters)).toEqual(["Jetzt zahlen", "Wird bearbeitet…", "AGB"])
    expect([visible.characters, hidden.characters]).toEqual(["Pay now", "Processing…"])
  })

  it("keeps the source text where a copy's subtree differs, and reports it", async () => {
    const original = fakeFrame("1:1", "Checkout", [fakeText("1:2", "Checkout"), fakeGroup("1:3", "Row", [fakeText("1:4", "Pay now")]), fakeFrame("1:5", "List", [fakeText("1:6", "A")])])
    const copy = fakeFrame("2:1", "Checkout · de", [fakeText("2:2", "Checkout"), fakeFrame("2:3", "Row", [fakeText("2:4", "Pay now")]), fakeFrame("2:5", "List", [])])
    const mapping = await mapCopyTexts(original as unknown as BaseNode, copy as unknown as BaseNode)
    expect([...mapping.texts.entries()].map(([id, node]) => [id, node.id])).toEqual([["1:2", "2:2"]])
    expect(mapping.mismatches).toEqual(["2:3", "2:5"])
  })

  it("reports layers it could not write in the copy and keeps their text", async () => {
    const plain = fakeText("1:2", "Checkout")
    const missing = fakeText("1:3", "Pay now", { hasMissingFont: true })
    const variable = fakeText("1:4", "Total", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } } })
    const same = fakeText("1:5", "OK")
    const frame = fakeFrame("1:1", "Checkout", [plain, missing, variable, same], { x: 0, y: 0, width: 375, height: 812 })
    onPage(figmaMock, [frame])
    const outcome = await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse", "1:3": "Jetzt zahlen", "1:4": "Summe", "1:5": "OK", "9:9": "Nirgends" })], 1)
    const copy = copiesOf(figmaMock.currentPage, frame)[0]
    const [copyPlain, copyMissing, copyVariable, copySame] = textsOf(copy)
    expect(outcome).toEqual({
      done: 2,
      errors: [
        { nodeId: copyMissing.id, code: "missing_font", message: "A font in this layer is missing. Install or replace it first." },
        { nodeId: copyVariable.id, code: "bound_to_variable", message: "Text comes from a Figma variable; change the variable instead" },
      ],
    })
    expect([copyPlain.characters, copyMissing.characters, copyVariable.characters, copySame.characters]).toEqual(["Kasse", "Pay now", "Total", "OK"])
  })

  it("makes copies that scans skip as language copies (D32)", async () => {
    const { frame } = checkoutFrame()
    onPage(figmaMock, [frame])
    await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse", "1:3": "Jetzt zahlen" })], 1)
    const sent: MainToUi[] = []
    await createScanner((message) => sent.push(message)).start("s1", "page")
    const done = sent.find((message) => message.type === "scan-done")
    expect(done).toMatchObject({ total: 2, skipped: { languageCopy: 2 } })
    const scanned = sent.flatMap((message) => (message.type === "scan-batch" ? message.nodes.map((node) => node.nodeId) : []))
    expect(scanned).toEqual(["1:2", "1:3"])
  })

  it("answers language-copies with one op-result and one undo step; malformed copies get a handler-error", async () => {
    const { frame } = checkoutFrame()
    onPage(figmaMock, [frame])
    const sent = await exchange({ type: "language-copies", requestId: "c1-1", frameIds: ["1:1"], copies: [copyRequest("de", { "1:2": "Kasse" })] })
    expect(sent).toEqual([{ type: "op-result", requestId: "c1-1", ok: true, done: 1, errors: [] }])
    expect(figmaMock.commitUndo).toHaveBeenCalledTimes(1)
    const refused = await exchange({ type: "language-copies", requestId: "c1-2", frameIds: ["1:1"], copies: [{ lang: "de", source: "pseudo", variationOptionId: null, texts: [] }] })
    expect(refused).toEqual([{ type: "handler-error", forType: "language-copies", requestId: "c1-2", message: "copies must be a list of languages with texts" }])
    const noFrames = await exchange({ type: "language-copies", requestId: "c1-3", frameIds: "1:1", copies: [] })
    expect(noFrames).toEqual([{ type: "handler-error", forType: "language-copies", requestId: "c1-3", message: "frameIds must be a list of frame ids" }])
  })

  it("validates the copies of the message", () => {
    const valid = [copyRequest("de", { "1:2": "Kasse" }), { lang: "it", source: "published" as const, variationOptionId: "6a47", texts: [] }]
    expect(languageCopiesOf(valid)).toBe(valid)
    for (const bad of [
      undefined,
      [{ lang: "", source: "draft", variationOptionId: null, texts: [] }],
      [{ lang: "de", source: "draft", variationOptionId: 3, texts: [] }],
      [{ lang: "de", source: "draft", variationOptionId: null, texts: [{ nodeId: "1:2" }] }],
      [{ lang: "de", source: "draft", variationOptionId: null }],
      [null],
    ]) {
      expect(() => languageCopiesOf(bad)).toThrow("copies must be a list of languages with texts")
    }
  })

  it("leaves no half-made copy when Figma refuses to place it", async () => {
    const { frame } = checkoutFrame()
    const page = figmaMock.currentPage
    onPage(figmaMock, [frame])
    const insert = vi.spyOn(page, "insertChild").mockImplementation(() => {
      throw new Error("Cannot insert")
    })
    const outcome = await makeLanguageCopies(["1:1"], [copyRequest("de", { "1:2": "Kasse" })], 1)
    expect(outcome).toEqual({ done: 0, errors: [{ nodeId: "1:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.failed }] })
    insert.mockRestore()
    expect(page.allChildren.map((node) => node.id)).toEqual(["1:1"])
  })
})
