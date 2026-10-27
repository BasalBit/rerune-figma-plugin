import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeFrame, installFigma, uninstallFigma, type FigmaMock, type MockFn } from "../../test/figma-mock"
import { boxFor, exportFrameImage, exportPlan, hasOpaqueBackground, retryScales } from "./screenshots"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const SOLID = { type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL" }

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
