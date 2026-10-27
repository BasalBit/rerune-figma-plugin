import { describe, expect, it } from "vitest"
import { imageSize } from "./image-size"

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
    0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  ])
}

describe("imageSize", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(imageSize(png(4096, 1203))).toEqual({ format: "PNG", width: 4096, height: 1203 })
  })

  it("reads JPEG SOF0 and progressive SOF2 dimensions, skipping other segments", () => {
    expect(imageSize(jpeg(375, 812))).toEqual({ format: "JPG", width: 375, height: 812 })
    expect(imageSize(jpeg(4096, 300, 0xc2))).toEqual({ format: "JPG", width: 4096, height: 300 })
  })

  it("returns null for other or truncated data", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageSize(png(1, 1).slice(0, 20))).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
  })
})
