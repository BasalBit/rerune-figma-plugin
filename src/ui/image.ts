// Image helpers for the UI iframe (browser APIs). Phase 2 adds the screenshot rescale/re-encode helpers here.

export interface Rgba { r: number; g: number; b: number; a: number }

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
