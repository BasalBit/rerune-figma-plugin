import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeComponent, fakeFrame, fakeInstance, fakePage, fakeSection, fakeText, installFigma, loadFont, onPage, uninstallFigma, type FakeNode, type FigmaMock, type MockFn } from "../../test/figma-mock"
import { keyId, OTHER_PROJECT_ID, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi, MainToUiOf, NodeLink } from "../shared/messages"
import { newFileSettings, serializeFileSettings, serializeLink, serializePreviewRecord, type PreviewRecord } from "../shared/plugin-data"
import { createNodeCaches } from "./node-utils"
import { boxesFor, boxFor, exportFrameImage, exportPlan, exportScreenshot, exportScreenshots, frameBoxSources, frameIdsOf, hasOpaqueBackground, retryScales } from "./screenshots"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const SOLID = { type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 1, g: 1, b: 1 } }

describe("boxFor (Appendix A.8)", () => {
  it.each([
    [rect(100, 200, 400, 800), 1, 400, 800, rect(120, 250, 100, 20), { x: 20, y: 50, w: 100, h: 20 }],
    [rect(100, 200, 400, 800), 1, 400, 800, rect(480, 250, 100, 20), { x: 380, y: 50, w: 20, h: 20 }],
    [rect(100, 200, 400, 800), 1, 400, 800, rect(600, 250, 100, 20), null],
    [rect(0, 0, 8192, 1000), 0.5, 4096, 500, rect(1000, 100, 200, 40), { x: 500, y: 50, w: 100, h: 20 }],
  ])("frame %o scale %d → box", (frame, scale, imgW, imgH, node, expected) => {
    expect(boxFor(node, frame, scale, imgW, imgH)).toEqual(expected)
  })

  it("clips boxes that start left of or above the image", () => {
    expect(boxFor(rect(90, 190, 20, 20), rect(100, 200, 400, 800), 1, 400, 800)).toEqual({ x: 0, y: 0, w: 10, h: 10 })
  })
})

describe("export constraint (§7.16, Appendix A.8 vectors)", () => {
  it("uses WIDTH 4096 for a 5000.5 × 300 frame", () => {
    expect(exportPlan({ width: 5000.5, height: 300 })).toEqual({ scale: 4096 / 5000.5, constraint: { type: "WIDTH", value: 4096 } })
  })

  it("uses HEIGHT 4096 for a 300 × 9000 frame", () => {
    expect(exportPlan({ width: 300, height: 9000 })).toEqual({ scale: 4096 / 9000, constraint: { type: "HEIGHT", value: 4096 } })
  })

  it("uses SCALE 1 up to 4096 px", () => {
    expect(exportPlan({ width: 4096, height: 10 })).toEqual({ scale: 1, constraint: { type: "SCALE", value: 1 } })
  })
})

describe("hasOpaqueBackground", () => {
  it("is true for a visible, fully opaque solid fill on an opaque frame", () => {
    expect(hasOpaqueBackground({ opacity: 1, fills: [SOLID] })).toBe(true)
    expect(hasOpaqueBackground({ fills: [{ type: "SOLID" }] })).toBe(true)
  })

  it("exports PNG for mixed fills, a translucent frame or no opaque paint", () => {
    expect(hasOpaqueBackground({ opacity: 1, fills: figmaMock.mixed })).toBe(false)
    expect(hasOpaqueBackground({ opacity: 0.5, fills: [SOLID] })).toBe(false)
    expect(hasOpaqueBackground({ opacity: 1, fills: [] })).toBe(false)
    expect(hasOpaqueBackground({ opacity: 1, fills: [{ ...SOLID, visible: false }] })).toBe(false)
    expect(hasOpaqueBackground({ opacity: 1, fills: [{ ...SOLID, opacity: 0.5 }] })).toBe(false)
    expect(hasOpaqueBackground({ opacity: 1, fills: [{ type: "IMAGE", visible: true, opacity: 1, blendMode: "MULTIPLY" }] })).toBe(false)
  })

  it("accepts an opaque image fill with the normal blend mode", () => {
    expect(hasOpaqueBackground({ opacity: 1, fills: [{ type: "IMAGE", visible: true, opacity: 1, blendMode: "NORMAL" }] })).toBe(true)
  })
})

describe("retryScales", () => {
  it("shrinks by 0.75 down to a 0.25 floor", () => {
    expect(retryScales(1)).toEqual([0.75, 0.5625, 0.421875, 0.31640625, 0.25])
    expect(retryScales(0.3)).toEqual([0.25])
    expect(retryScales(0.25)).toEqual([])
    expect(retryScales(0.2)).toEqual([])
  })
})

describe("exportFrameImage", () => {
  function frameWith(exportAsync: (settings: ExportSettings) => Promise<Uint8Array>, bounds = rect(0, 0, 400, 800), fills: unknown[] = [SOLID]) {
    return fakeFrame("1:1", "Checkout", [], { absoluteBoundingBox: bounds, opacity: 1, fills, exportAsync: vi.fn(exportAsync) })
  }

  it("exports JPG at SCALE 1 with absolute bounds and sRGB", async () => {
    const frame = frameWith(async () => new Uint8Array(1000))
    const result = await exportFrameImage(frame as unknown as FrameNode)
    expect(result).toMatchObject({ ok: true, format: "JPG", scale: 1, width: 400, height: 800, attempts: 1 })
    expect(frame.exportAsync).toHaveBeenCalledWith({ format: "JPG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: true, colorProfile: "SRGB" })
  })

  it("exports PNG for a transparent frame", async () => {
    const frame = frameWith(async () => new Uint8Array(10), rect(0, 0, 10, 10), [])
    expect(await exportFrameImage(frame as unknown as FrameNode)).toMatchObject({ ok: true, format: "PNG" })
  })

  it("re-exports smaller while above 2,000,000 bytes", async () => {
    const sizes = [3000000, 2500000, 1500000]
    const frame = frameWith(async () => new Uint8Array(sizes.shift() ?? 1))
    const result = await exportFrameImage(frame as unknown as FrameNode)
    expect(result).toMatchObject({ ok: true, scale: 0.5625, width: 225, height: 450, attempts: 3 })
    expect((frame.exportAsync as MockFn).mock.calls.map((call) => (call[0] as ExportSettingsImage).constraint)).toEqual([
      { type: "SCALE", value: 1 },
      { type: "SCALE", value: 0.75 },
      { type: "SCALE", value: 0.5625 },
    ])
  })

  it("gives up with too_large after the 0.25 floor", async () => {
    const frame = frameWith(async () => new Uint8Array(2000001))
    expect(await exportFrameImage(frame as unknown as FrameNode)).toEqual({ ok: false, reason: "too_large" })
  })

  it("reports frames without bounds and failed exports", async () => {
    expect(await exportFrameImage(frameWith(async () => new Uint8Array(1), null as unknown as ReturnType<typeof rect>) as unknown as FrameNode)).toEqual({ ok: false, reason: "no_bounds" })
    const failing = frameWith(async () => {
      throw new Error("export failed")
    })
    expect(await exportFrameImage(failing as unknown as FrameNode)).toEqual({ ok: false, reason: "export_failed" })
  })
})

const K1 = keyId(1)
const K2 = keyId(2)

function link(nid: string, id = K1, projectId = PROJECT_ID): NodeLink {
  return { v: 1, id, k: "checkout_pay_button", p: projectId, src: src("Pay now"), nid, t: 1 }
}

function linkedText(id: string, bounds: ReturnType<typeof rect>, value: NodeLink | null = link(id)): FakeNode {
  const node = fakeText(id, "Pay now", { absoluteBoundingBox: bounds })
  if (value !== null) {
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(value))
  }
  return node
}

function connectFile(projectId = PROJECT_ID): void {
  const raw = serializeFileSettings(newFileSettings({ apiBase: "http://localhost:8080", projectId, projectName: "Chapter", now: 1 }))
  figmaMock.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, raw)
}

function exportingFrame(id: string, children: FakeNode[], bounds = rect(100, 200, 400, 800), sizes: number[] = [1000]) {
  return fakeFrame(id, "Checkout", children, {
    absoluteBoundingBox: bounds,
    opacity: 1,
    fills: [SOLID],
    exportAsync: vi.fn(async () => new Uint8Array(sizes.length > 1 ? (sizes.shift() as number) : sizes[0])),
  })
}

function previewRecord(nid: string): PreviewRecord {
  return {
    v: 1,
    nid,
    previewSrc: src("Jetzt zahlen"),
    characters: "Pay now",
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

async function run(frameIds: string[]): Promise<MainToUi[]> {
  const sent: MainToUi[] = []
  await exportScreenshots("r1", frameIds, (message) => sent.push(message))
  return sent
}

function image(sent: MainToUi[], frameId: string): MainToUiOf<"frame-image"> {
  const found = sent.find((message): message is MainToUiOf<"frame-image"> => message.type === "frame-image" && message.frameId === frameId)
  if (found === undefined) {
    throw new Error("no frame-image for " + frameId)
  }
  return found
}

describe("screenshots-export (§7.16)", () => {
  it("exports the frame and boxes the visible linked text of the file's project", async () => {
    connectFile()
    const inside = linkedText("12:1", rect(120, 250, 100, 20))
    const clipped = linkedText("12:2", rect(480, 250, 100, 20), link("12:2", K2))
    const outside = linkedText("12:3", rect(600, 250, 100, 20))
    const otherProject = linkedText("12:4", rect(120, 300, 100, 20), link("12:4", K1, OTHER_PROJECT_ID))
    const unlinked = linkedText("12:5", rect(120, 350, 100, 20), null)
    const copied = linkedText("12:6", rect(120, 400, 100, 20), link("12:1"))
    const hidden = linkedText("12:7", rect(120, 450, 100, 20))
    hidden.visible = false
    const frame = exportingFrame("10:1", [inside, clipped, outside, otherProject, unlinked, copied, hidden])
    onPage(figmaMock, [fakeSection("9:1", "Flows", [frame])])
    figmaMock.currentPage.name = "Mobile"

    const sent = await run(["10:1"])
    expect(sent).toHaveLength(2)
    expect(image(sent, "10:1")).toEqual({
      type: "frame-image",
      requestId: "r1",
      frameId: "10:1",
      frameName: "Checkout",
      pageId: "0:1",
      pageName: "Mobile",
      format: "JPG",
      bytes: new Uint8Array(1000),
      width: 400,
      height: 800,
      boxes: [
        { nodeId: "12:1", keyId: K1, x: 20, y: 50, w: 100, h: 20, text: "Pay now" },
        { nodeId: "12:2", keyId: K2, x: 380, y: 50, w: 20, h: 20, text: "Pay now" },
      ],
    })
    expect(frame.exportAsync).toHaveBeenCalledWith({ format: "JPG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: true, colorProfile: "SRGB" })
    expect(sent[1]).toEqual({ type: "frame-images-done", requestId: "r1", exported: 1, skipped: [] })
  })

  it("boxes instance text that inherits a component link, not text that overrides it", async () => {
    connectFile()
    const mainText = linkedText("5:67", rect(0, 0, 50, 10))
    figmaMock.root.appendChild(fakePage("0:2", "Components", [fakeComponent("5:1", "Button", [mainText])]))
    const inherits = fakeText("I12:34;5:67", "Pay now", { absoluteBoundingBox: rect(110, 210, 50, 10) })
    inherits.inheritFrom = mainText
    const overridden = fakeText("I13:1;5:67", "Pay securely", { absoluteBoundingBox: rect(110, 300, 50, 10) })
    overridden.inheritFrom = mainText
    const frame = exportingFrame("10:1", [
      fakeInstance("12:34", "Button", [inherits], { overrides: [] }),
      fakeInstance("13:1", "Button", [overridden], { overrides: [{ id: "I13:1;5:67", overriddenFields: ["characters"] }] }),
    ])
    onPage(figmaMock, [frame])

    const sent = await run(["10:1"])
    expect(image(sent, "10:1").boxes).toEqual([{ nodeId: "I12:34;5:67", keyId: K1, x: 10, y: 10, w: 50, h: 10, text: "Pay now" }])
  })

  it("exports big frames at WIDTH 4096 and scales the boxes (Appendix A.8)", async () => {
    connectFile()
    const frame = exportingFrame("10:1", [linkedText("12:1", rect(1000, 100, 200, 40))], rect(0, 0, 8192, 1000))
    onPage(figmaMock, [frame])
    const sent = await run(["10:1"])
    expect(frame.exportAsync).toHaveBeenCalledWith(expect.objectContaining({ constraint: { type: "WIDTH", value: 4096 } }))
    expect(image(sent, "10:1")).toMatchObject({ width: 4096, height: 500, boxes: [{ nodeId: "12:1", x: 500, y: 50, w: 100, h: 20 }] })
  })

  it("scales the boxes with a smaller re-export above 2,000,000 bytes", async () => {
    connectFile()
    const frame = exportingFrame("10:1", [linkedText("12:1", rect(120, 250, 100, 20))], rect(100, 200, 400, 800), [3000000, 1000])
    onPage(figmaMock, [frame])
    const sent = await run(["10:1"])
    expect(image(sent, "10:1")).toMatchObject({ width: 300, height: 600, boxes: [{ x: 15, y: 38, w: 75, h: 15 }] })
  })

  it("exports PNG for a frame without an opaque fill", async () => {
    connectFile()
    const frame = exportingFrame("10:1", [])
    frame.fills = []
    onPage(figmaMock, [frame])
    const sent = await run(["10:1"])
    expect(image(sent, "10:1")).toMatchObject({ format: "PNG", boxes: [] })
  })

  it("loads the frame's page first, also on another page", async () => {
    connectFile()
    const frame = exportingFrame("20:1", [linkedText("21:1", rect(120, 250, 100, 20))])
    const other = fakePage("0:2", "Tablet", [frame])
    figmaMock.root.appendChild(other)
    const sent = await run(["20:1"])
    expect(other.loadAsync).toHaveBeenCalled()
    expect(image(sent, "20:1")).toMatchObject({ pageId: "0:2", pageName: "Tablet", boxes: [{ nodeId: "21:1" }] })
  })

  it("exports frames one by one, one message each, and reports the frames it skipped", async () => {
    connectFile()
    const first = exportingFrame("10:1", [linkedText("12:1", rect(120, 250, 100, 20))])
    const second = exportingFrame("11:1", [linkedText("13:1", rect(120, 250, 100, 20))])
    const noBounds = exportingFrame("14:1", [])
    noBounds.absoluteBoundingBox = null
    const failing = exportingFrame("15:1", [])
    failing.exportAsync = vi.fn(async () => {
      throw new Error("export failed")
    })
    const huge = exportingFrame("16:1", [], rect(0, 0, 400, 800), [2000001])
    const removed = exportingFrame("17:1", [])
    onPage(figmaMock, [first, second, noBounds, failing, huge, removed])
    removed.remove()

    const sent = await run(["10:1", "14:1", "11:1", "15:1", "16:1", "17:1", "99:1"])
    expect(sent.map((message) => message.type)).toEqual(["frame-image", "frame-image", "frame-images-done"])
    expect(sent.map((message) => (message.type === "frame-image" ? message.frameId : null))).toEqual(["10:1", "11:1", null])
    expect(sent[2]).toEqual({
      type: "frame-images-done",
      requestId: "r1",
      exported: 2,
      skipped: [
        { frameId: "14:1", reason: "no_bounds" },
        { frameId: "15:1", reason: "export_failed" },
        { frameId: "16:1", reason: "too_large" },
        { frameId: "17:1", reason: "not_found" },
        { frameId: "99:1", reason: "not_found" },
      ],
    })
  })

  it("reports a frame deleted while its texts are read or while it exports as not_found (§7.9)", async () => {
    connectFile()
    const removedNodeError = () => new Error("The node with id \"10:1\" does not exist")
    // Deleted during the box walk, which yields to the canvas: reading the frame afterwards throws, as in Figma.
    const text = linkedText("12:1", rect(120, 250, 100, 20))
    const frame = exportingFrame("10:1", [text])
    const bounds = rect(100, 200, 400, 800)
    Object.defineProperty(frame, "absoluteBoundingBox", {
      configurable: true,
      get: () => {
        if (frame.removed) throw removedNodeError()
        return bounds
      },
    })
    Object.defineProperty(text, "absoluteBoundingBox", {
      configurable: true,
      get: () => {
        frame.remove()
        return rect(120, 250, 100, 20)
      },
    })
    // Deleted between the bounds read and the export.
    const exporting = exportingFrame("11:1", [])
    exporting.exportAsync = vi.fn(async () => {
      exporting.remove()
      throw removedNodeError()
    })
    onPage(figmaMock, [frame, exporting])

    const sent = await run(["10:1", "11:1"])
    expect(sent).toEqual([
      { type: "frame-images-done", requestId: "r1", exported: 0, skipped: [{ frameId: "10:1", reason: "not_found" }, { frameId: "11:1", reason: "not_found" }] },
    ])
    expect(frame.exportAsync).not.toHaveBeenCalled()
  })

  it("skips a frame whose text shows a language preview, own or through its main component (D23)", async () => {
    connectFile()
    const previewing = linkedText("12:1", rect(120, 250, 100, 20))
    previewing.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(previewRecord("12:1")))
    const frame = exportingFrame("10:1", [previewing])
    const mainText = linkedText("5:67", rect(0, 0, 50, 10))
    mainText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(previewRecord("5:67")))
    figmaMock.root.appendChild(fakePage("0:2", "Components", [fakeComponent("5:1", "Button", [mainText])]))
    const follows = fakeText("I12:34;5:67", "Jetzt zahlen", { absoluteBoundingBox: rect(110, 210, 50, 10) })
    const viaMain = exportingFrame("11:1", [fakeInstance("12:34", "Button", [follows], { overrides: [] })])
    onPage(figmaMock, [frame, viaMain])

    const sent = await run(["10:1", "11:1"])
    expect(sent).toEqual([
      { type: "frame-images-done", requestId: "r1", exported: 0, skipped: [{ frameId: "10:1", reason: "preview_active" }, { frameId: "11:1", reason: "preview_active" }] },
    ])
    expect(frame.exportAsync).not.toHaveBeenCalled()
  })

  it("refuses a hidden frame, one in a hidden section and one hidden while its texts are read: it would upload no boxes", async () => {
    connectFile()
    const hidden = exportingFrame("10:1", [linkedText("12:1", rect(120, 250, 100, 20))])
    hidden.visible = false
    const inSection = exportingFrame("20:1", [linkedText("22:1", rect(120, 250, 100, 20))])
    const section = fakeSection("9:1", "Old flows", [inSection])
    section.visible = false
    // The walk yields after 200 texts; the designer hides the frame meanwhile.
    const texts = Array.from({ length: 201 }, (_, index) => linkedText("32:" + index, rect(120, 250, 100, 20)))
    const hiddenLater = exportingFrame("30:1", texts)
    onPage(figmaMock, [hidden, section, hiddenLater])
    setTimeout(() => {
      hiddenLater.visible = false
    }, 0)
    const sent = await run(["10:1", "20:1", "30:1"])
    expect(sent).toEqual([
      {
        type: "frame-images-done",
        requestId: "r1",
        exported: 0,
        skipped: [
          { frameId: "10:1", reason: "hidden" },
          { frameId: "20:1", reason: "hidden" },
          { frameId: "30:1", reason: "hidden" },
        ],
      },
    ])
    for (const frame of [hidden, inSection, hiddenLater]) {
      expect(frame.exportAsync).not.toHaveBeenCalled()
    }
  })

  it("exports without boxes when the file is not connected to a project", async () => {
    const frame = exportingFrame("10:1", [linkedText("12:1", rect(120, 250, 100, 20))])
    onPage(figmaMock, [frame])
    expect(image(await run(["10:1"]), "10:1").boxes).toEqual([])
  })

  it("does not export a page or a node that cannot be exported", async () => {
    connectFile()
    expect(await exportScreenshot("0:1", PROJECT_ID)).toEqual({ ok: false, reason: "not_found" })
    figmaMock.getNodeByIdAsync.mockRejectedValueOnce(new Error("boom"))
    expect(await exportScreenshot("10:1", PROJECT_ID)).toEqual({ ok: false, reason: "not_found" })
  })

  it("keeps the first 500 boxes (E19 limit)", () => {
    const sources = Array.from({ length: 501 }, (_, index) => ({ nodeId: "12:" + index, keyId: K1, rect: rect(10, 10, 5, 5), text: null }))
    const boxes = boxesFor(sources, 1, 100, 100)
    expect(boxes).toHaveLength(500)
    expect(boxes[499].nodeId).toBe("12:499")
  })

  it("collects box sources relative to the frame, without loading pages, and skips unreadable text", async () => {
    const good = linkedText("12:1", rect(101, 202, 3, 4))
    const broken = linkedText("12:2", rect(101, 202, 3, 4))
    broken.getSharedPluginData = () => {
      throw new Error("gone")
    }
    const frame = fakeFrame("10:1", "Checkout", [good, broken], { absoluteBoundingBox: rect(100, 200, 50, 50) })
    onPage(figmaMock, [frame])
    expect(await frameBoxSources(frame as unknown as FrameNode, PROJECT_ID, createNodeCaches())).toEqual({
      previewing: false,
      sources: [{ nodeId: "12:1", keyId: K1, rect: rect(1, 2, 3, 4), text: "Pay now" }],
    })
  })

  it("keeps the boxes on their text when the frame moves while its texts are read (§7.16 step 5)", async () => {
    connectFile()
    // More texts than one batch: the walk yields to the canvas after 200 of them, and the designer drags the frame
    // (with its texts) by (+50, +30) meanwhile. The export then reads the moved frame's bounds.
    const texts = Array.from({ length: 201 }, (_, index) => linkedText("12:" + index, rect(120, 250, 100, 20)))
    const frame = exportingFrame("10:1", texts, rect(100, 200, 400, 800))
    onPage(figmaMock, [frame])
    setTimeout(() => {
      frame.absoluteBoundingBox = rect(150, 230, 400, 800)
      for (const text of texts) {
        text.absoluteBoundingBox = rect(170, 280, 100, 20)
      }
    }, 0)
    const boxes = image(await run(["10:1"]), "10:1").boxes
    expect(boxes).toHaveLength(201)
    expect(boxes.every((box) => box.x === 20 && box.y === 50 && box.w === 100 && box.h === 20)).toBe(true)
  })

  it("accepts only a list of frame ids", () => {
    expect(frameIdsOf(["10:1"])).toEqual(["10:1"])
    expect(() => frameIdsOf("10:1")).toThrow("frameIds must be a list of frame ids")
    expect(() => frameIdsOf([1])).toThrow("frameIds must be a list of frame ids")
  })
})

describe("text capture at export (screenshot freshness, contract §3.3)", () => {
  it("records the layer's text, an empty one too, and none for a layer longer than 5,000 UTF-16 units", async () => {
    connectFile()
    loadFont(figmaMock)
    const full = linkedText("12:1", rect(120, 250, 100, 20))
    full.characters = "x".repeat(5000)
    const empty = linkedText("12:2", rect(120, 300, 100, 20))
    empty.characters = ""
    const long = linkedText("12:3", rect(120, 350, 100, 20))
    long.characters = "😀".repeat(2500) + "x"
    const frame = exportingFrame("10:1", [full, empty, long])
    onPage(figmaMock, [frame])
    const boxes = image(await run(["10:1"]), "10:1").boxes
    expect(boxes.map((box) => [box.nodeId, box.text === null ? null : box.text.length])).toEqual([
      ["12:1", 5000],
      ["12:2", 0],
      ["12:3", null],
    ])
  })
})
