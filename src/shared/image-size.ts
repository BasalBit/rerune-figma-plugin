// Reads the pixel size from a PNG (IHDR) or JPEG (SOFn) header without decoding the image.

export interface ImageSize { format: "PNG" | "JPG"; width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function uint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
}

function uint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) + bytes[offset + 1]
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return null
  }
  return { format: "PNG", width: uint32(bytes, 16), height: uint32(bytes, 20) }
}

// SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null
    }
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = uint16(bytes, offset + 2)
    if (length < 2) {
      return null
    }
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) {
        return null
      }
      return { format: "JPG", height: uint16(bytes, offset + 5), width: uint16(bytes, offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes)
}
