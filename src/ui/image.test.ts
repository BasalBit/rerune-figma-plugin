import { afterEach, describe, expect, it, vi } from "vitest"
import { measureImage } from "./image"

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("measureImage (§7.16 decoded size)", () => {
  it("decodes with createImageBitmap when the browser has it", async () => {
    const close = vi.fn()
    const createImageBitmap = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("image/png")
      expect(blob.size).toBe(33)
      return { width: 801, height: 1600, close }
    })
    vi.stubGlobal("createImageBitmap", createImageBitmap)
    expect(await measureImage(png(800, 1600), "image/png")).toEqual({ width: 801, height: 1600 })
    expect(close).toHaveBeenCalled()
  })

  it("falls back to the image header when decoding is unavailable or fails", async () => {
    expect(await measureImage(png(400, 800), "image/png")).toEqual({ width: 400, height: 800 })
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("decode failed"))))
    expect(await measureImage(png(400, 800), "image/png")).toEqual({ width: 400, height: 800 })
    expect(await measureImage(new Uint8Array([1, 2, 3]), "image/jpeg")).toBeNull()
  })
})
