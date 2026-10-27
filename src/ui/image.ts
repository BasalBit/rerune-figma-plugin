import { imageSize } from "../shared/image-size"

// Image helpers for the UI iframe (browser APIs): the T3 corner pixel and the decoded size of a frame image.

export interface Rgba { r: number; g: number; b: number; a: number }
export interface PixelSize { width: number; height: number }

// Decoded size of an exported frame image (§7.16): createImageBitmap when the browser has it, else the PNG/JPEG
// header (what the server's image.DecodeConfig reads); null when neither can tell.
export async function measureImage(bytes: Uint8Array, type: "image/jpeg" | "image/png"): Promise<PixelSize | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type }))
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    } catch {
      // Fall back to the header below.
    }
  }
  const header = imageSize(bytes)
  return header === null ? null : { width: header.width, height: header.height }
}

// Top-left pixel of an encoded image (diagnostics T3: background of a transparent frame exported as JPG).
// Returns null where the browser APIs are missing (tests, old engines) or decoding fails.
export async function cornerPixel(bytes: Uint8Array, type: "image/jpeg" | "image/png"): Promise<Rgba | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return null
  }
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type }))
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext("2d")
    if (context === null) {
      return null
    }
    context.drawImage(bitmap, 0, 0)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    bitmap.close()
    return { r, g, b, a }
  } catch {
    return null
  }
}
