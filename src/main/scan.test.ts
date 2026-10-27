import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createNode,
  defaultStyle,
  fakeComponent,
  fakeFrame,
  fakeGroup,
  fakeInstance,
  fakeSection,
  fakeText,
  installFigma,
  onPage,
  uninstallFigma,
  type FakeNode,
  type FigmaMock,
} from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE, SCAN_MAX_NODES } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi, MainToUiOf, NodeLink, ScannedNode } from "../shared/messages"
import { newFileSettings, serializeFileSettings, serializeLangCopy, serializeLink, serializePreviewRecord, type PreviewRecord } from "../shared/plugin-data"
import { createNodeCaches } from "./node-utils"
import { createScanner, describeTextNode, emptySkipCounts, scanTextNode } from "./scan"

let figmaMock: FigmaMock
let messages: MainToUi[]

beforeEach(() => {
  figmaMock = installFigma()
  messages = []
})

afterEach(() => {
  uninstallFigma()
})

function link(nid: string, text = "Pay now"): NodeLink {
  return { v: 1, id: keyId(1), k: "checkout_pay_button", p: PROJECT_ID, src: src(text), nid, t: 1 }
}

function previewRecord(nid: string, characters: string, previewText: string): PreviewRecord {
  return {
    v: 1,
    nid,
    previewSrc: src(previewText),
    characters,
    autoRename: true,
    textOverridden: false,
    segments: null,
    richLost: false,
    lang: "de",
    source: "draft",
    variationOptionId: null,
    appliedAt: 99,
  }
}

function batches(requestId = "r1"): ScannedNode[] {
  return messages.flatMap((message) => (message.type === "scan-batch" && message.requestId === requestId ? message.nodes : []))
}

function done(requestId = "r1"): MainToUiOf<"scan-done"> | undefined {
  return messages.find((message): message is MainToUiOf<"scan-done"> => message.type === "scan-done" && message.requestId === requestId)
}

// A light TEXT node for large scans (fakeText creates many mocks per node).
function lightText(id: string, characters: string): FakeNode {
  return createNode("TEXT", id, characters, [], {
    characters,
    hasMissingFont: false,
    autoRename: true,
    boundVariables: {},
    componentPropertyReferences: null,
    width: 10,
    height: 10,
    textAutoResize: "WIDTH_AND_HEIGHT",
    textTruncation: "DISABLED",
    maxLines: null,
    getStyledTextSegments: () => [{ characters, start: 0, end: characters.length, ...defaultStyle() }],
  })
}

describe("describeTextNode", () => {
  it("maps a text layer inside an instance to the wire shape", async () => {
    const main = fakeComponent("5:1", "Primary button")
    const label = fakeText("I12:34;5:67", "Pay now", { name: "Label", autoRename: false, width: 120, height: 24, textAutoResize: "NONE", textTruncation: "ENDING", maxLines: 2 })
    label.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link("5:67")))
    const instance = fakeInstance("12:34", "Button", [label], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }], mainComponent: main })
    const frame = fakeFrame("10:1", "Checkout", [fakeGroup("10:2", "Footer", [instance])])
    onPage(figmaMock, [fakeSection("9:1", "Flow", [frame])])
    const node = await describeTextNode(label as unknown as TextNode, createNodeCaches())
    const expected: ScannedNode = {
      nodeId: "I12:34;5:67",
      name: "Label",
      characters: "Pay now",
      originalCharacters: null,
      pageId: "0:1",
      pageName: "Page 1",
      frameId: "10:1",
      frameName: "Checkout",
      parentNames: ["Button", "Footer", "Checkout"],
      componentName: "Primary button",
      isInstanceSublayer: true,
      link: link("5:67"),
      linkState: "inherited_overridden",
      preview: null,
      hasMissingFont: false,
      mixedStyles: false,
      boundToComponentProperty: false,
      boundToVariable: false,
      autoRename: false,
      textOverridden: true,
      width: 120,
      height: 24,
      textAutoResize: "NONE",
      textTruncation: "ENDING",
      maxLines: 2,
    }
    expect(node).toEqual(expected)
  })

  it("reports an own preview with the original text and ignores a copied one", async () => {
    const own = fakeText("1:1", "Jetzt zahlen")
    own.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(previewRecord("1:1", "Pay now", "Jetzt zahlen")))
    const copy = fakeText("1:2", "Jetzt zahlen")
    copy.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(previewRecord("1:1", "Pay now", "Jetzt zahlen")))
    onPage(figmaMock, [own, copy])
    const ownNode = await describeTextNode(own as unknown as TextNode, createNodeCaches())
    expect(ownNode.originalCharacters).toBe("Pay now")
    expect(ownNode.preview).toEqual({ lang: "de", source: "draft", variationOptionId: null, appliedAt: 99 })
    const copyNode = await describeTextNode(copy as unknown as TextNode, createNodeCaches())
    expect(copyNode.originalCharacters).toBeNull()
    expect(copyNode.preview).toBeNull()
  })

  it("flags mixed styles, missing fonts and bindings", async () => {
    const node = fakeText("1:1", "Pay now", {
      hasMissingFont: true,
      boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "V:1" } },
      componentPropertyReferences: { characters: "Label#1:0" },
    })
    node.setRangeFontSize(0, 3, 20)
    onPage(figmaMock, [node])
    const scanned = await describeTextNode(node as unknown as TextNode, createNodeCaches())
    expect(scanned).toMatchObject({ mixedStyles: true, hasMissingFont: true, boundToVariable: true, boundToComponentProperty: true, frameId: null, parentNames: [] })
  })
})

describe("scanTextNode filters (§7.9)", () => {
  const filters = { ignoreUnderscoreLayers: true, includeLocked: false }

  it("skips hidden, locked, empty, numeric, underscore and language-copy layers", async () => {
    const hiddenParent = fakeGroup("2:1", "Hidden", [fakeText("2:2", "Hidden text")])
    hiddenParent.visible = false
    const locked = fakeText("3:1", "Locked", { locked: true })
    const empty = fakeText("4:1", "  \n ")
    const numeric = fakeText("5:1", "€ 1.299,00")
    const underscore = fakeText("6:1", "Note", { name: "_note" })
    const inCopy = fakeText("7:2", "Hallo")
    const copy = fakeFrame("7:1", "Checkout de", [inCopy])
    copy.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.langCopy, serializeLangCopy({ v: 1, nid: "7:1", lang: "de", source: "draft", variationOptionId: null, sourceFrameId: "1:1", createdAt: 1 }))
    const kept = fakeText("8:1", "Pay now")
    onPage(figmaMock, [hiddenParent, locked, empty, numeric, underscore, copy, kept])
    const caches = createNodeCaches()
    const run = (node: FakeNode) => scanTextNode(node as unknown as TextNode, caches, filters)
    expect(await run(hiddenParent.children[0])).toBe("hidden")
    expect(await run(locked)).toBe("locked")
    expect(await run(empty)).toBe("empty")
    expect(await run(numeric)).toBe("numeric")
    expect(await run(underscore)).toBe("underscore")
    expect(await run(inCopy)).toBe("languageCopy")
    expect(await run(kept)).toMatchObject({ nodeId: "8:1" })
  })

  it("keeps locked and underscore layers when the file settings say so", async () => {
    const locked = fakeText("3:1", "Locked", { locked: true })
    const underscore = fakeText("6:1", "Note", { name: "_note" })
    onPage(figmaMock, [locked, underscore])
    const relaxed = { ignoreUnderscoreLayers: false, includeLocked: true }
    expect(await scanTextNode(locked as unknown as TextNode, createNodeCaches(), relaxed)).toMatchObject({ nodeId: "3:1" })
    expect(await scanTextNode(underscore as unknown as TextNode, createNodeCaches(), relaxed)).toMatchObject({ nodeId: "6:1" })
  })

  it("filters on the original text of a previewing layer", async () => {
    const node = fakeText("1:1", "[checkout_total]")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(previewRecord("1:1", "42", "[checkout_total]")))
    onPage(figmaMock, [node])
    expect(await scanTextNode(node as unknown as TextNode, createNodeCaches(), filters)).toBe("numeric")
  })
})

describe("createScanner", () => {
  it("returns an empty result for an empty selection", async () => {
    onPage(figmaMock, [fakeText("1:1", "Pay now")], [])
    await createScanner((message) => messages.push(message)).start("r1", "selection")
    expect(batches()).toEqual([])
    expect(done()).toEqual({ type: "scan-done", requestId: "r1", total: 0, truncated: false, skipped: emptySkipCounts() })
  })

  it("scans the selection: root text, child text and text in nested containers, without duplicates", async () => {
    const rootText = fakeText("1:1", "Root")
    const direct = fakeText("2:2", "Direct")
    const nested = fakeText("2:4", "Nested")
    const frame = fakeFrame("2:1", "Frame", [direct, fakeGroup("2:3", "Group", [nested])])
    onPage(figmaMock, [rootText, frame], [rootText, frame, rootText])
    await createScanner((message) => messages.push(message)).start("r1", "selection")
    expect(batches().map((node) => node.nodeId)).toEqual(["1:1", "2:2", "2:4"])
    expect(done()?.total).toBe(3)
  })

  it("loads the page and counts skipped layers in page scope", async () => {
    figmaMock.root.setSharedPluginData(
      PLUGIN_DATA_NAMESPACE,
      DATA_KEYS.file,
      serializeFileSettings({ ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }), includeLocked: true }),
    )
    const locked = fakeText("1:2", "Locked", { locked: true })
    const numeric = fakeText("1:3", "12")
    onPage(figmaMock, [fakeFrame("1:1", "Frame", [locked, numeric, fakeText("1:4", "Kept")])])
    await createScanner((message) => messages.push(message)).start("r1", "page")
    expect(figmaMock.currentPage.loadAsync).toHaveBeenCalled()
    expect(batches().map((node) => node.nodeId)).toEqual(["1:2", "1:4"])
    expect(done()?.skipped).toEqual({ ...emptySkipCounts(), numeric: 1 })
  })

  it("streams batches of 100 with progress messages", async () => {
    const texts = Array.from({ length: 250 }, (_, i) => lightText("3:" + i, "Text " + i))
    onPage(figmaMock, [fakeFrame("1:1", "List", texts)], [])
    await createScanner((message) => messages.push(message)).start("r1", "page")
    const sizes = messages.filter((message) => message.type === "scan-batch").map((message) => (message as MainToUiOf<"scan-batch">).nodes.length)
    expect(sizes).toEqual([100, 100, 50])
    expect(messages.some((message) => message.type === "scan-progress")).toBe(true)
    expect(done()).toMatchObject({ total: 250, truncated: false })
  })

  it("skips a node removed between batches (unavailable) and finishes", async () => {
    const texts = Array.from({ length: 250 }, (_, i) => lightText("3:" + i, "Text " + i))
    onPage(figmaMock, [fakeFrame("1:1", "List", texts)])
    let removed = false
    await createScanner((message) => {
      messages.push(message)
      if (message.type === "scan-progress" && !removed) {
        removed = true
        texts[230].remove()
      }
    }).start("r1", "page")
    expect(done()).toMatchObject({ total: 249, skipped: { ...emptySkipCounts(), unavailable: 1 } })
    expect(batches().some((node) => node.nodeId === "3:230")).toBe(false)
  })

  it("counts a node whose read throws as unavailable and continues", async () => {
    const broken = fakeText("1:2", "Broken")
    Object.defineProperty(broken, "characters", {
      get: () => {
        throw new Error("The node no longer exists")
      },
    })
    onPage(figmaMock, [fakeFrame("1:1", "Frame", [broken, fakeText("1:3", "Fine")])])
    await createScanner((message) => messages.push(message)).start("r1", "page")
    expect(done()).toMatchObject({ total: 1, skipped: { ...emptySkipCounts(), unavailable: 1 } })
  })

  it("stops at 5000 nodes and reports truncated", async () => {
    const texts = Array.from({ length: SCAN_MAX_NODES + 1 }, (_, i) => lightText("4:" + i, "Text " + i))
    onPage(figmaMock, [fakeFrame("1:1", "Huge", texts)])
    await createScanner((message) => messages.push(message)).start("r1", "page")
    expect(done()).toMatchObject({ total: SCAN_MAX_NODES, truncated: true })
    expect(batches()).toHaveLength(SCAN_MAX_NODES)
  })

  it("stops without scan-done when cancelled", async () => {
    const texts = Array.from({ length: 250 }, (_, i) => lightText("3:" + i, "Text " + i))
    onPage(figmaMock, [fakeFrame("1:1", "List", texts)])
    const scanner = createScanner((message) => {
      messages.push(message)
      if (message.type === "scan-progress") {
        scanner.cancel("r1")
      }
    })
    await scanner.start("r1", "page")
    expect(done()).toBeUndefined()
    expect(batches().length).toBeLessThan(250)
  })

  it("ignores a cancel for another request", async () => {
    onPage(figmaMock, [fakeText("1:1", "Pay now")])
    const scanner = createScanner((message) => messages.push(message))
    scanner.cancel("other")
    await scanner.start("r1", "page")
    expect(done()?.total).toBe(1)
  })

  it("lets a newer scan supersede a running one", async () => {
    const texts = Array.from({ length: 250 }, (_, i) => lightText("3:" + i, "Text " + i))
    onPage(figmaMock, [fakeFrame("1:1", "List", texts)])
    let second: Promise<void> | null = null
    const scanner = createScanner((message) => {
      messages.push(message)
      if (message.type === "scan-progress" && message.requestId === "r1" && second === null) {
        second = scanner.start("r2", "page")
      }
    })
    await scanner.start("r1", "page")
    await second
    expect(done("r1")).toBeUndefined()
    expect(done("r2")?.total).toBe(250)
  })
})
