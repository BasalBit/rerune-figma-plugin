import { MAX_IMAGE_SIDE, MAX_IMAGE_UPLOAD_BYTES } from "../shared/constants"

// Frame export rules (§7.16) and key boxes (Appendix A.8). Phase 1 uses them for diagnostics T3/T4; the
// Phase 2 screenshots-export handler builds on the same functions.

export interface BoxRect { x: number; y: number; width: number; height: number }
export interface ImageBox { x: number; y: number; w: number; h: number }
export type ExportConstraint = { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number }

const MIN_RETRY_SCALE = 0.25
const RETRY_FACTOR = 0.75

export function boxFor(b: BoxRect, frame: BoxRect, scale: number, imgW: number, imgH: number): ImageBox | null {
  const x = (b.x - frame.x) * scale
  const y = (b.y - frame.y) * scale
  const x2 = Math.min(imgW, x + b.width * scale)
  const y2 = Math.min(imgH, y + b.height * scale)
  const cx = Math.max(0, x)
  const cy = Math.max(0, y)
  return x2 <= cx || y2 <= cy ? null : { x: Math.round(cx), y: Math.round(cy), w: Math.round(x2 - cx), h: Math.round(y2 - cy) }
}

// No fractional SCALE for big frames, so float rounding cannot produce a 4097-px side.
export function exportPlan(bounds: { width: number; height: number }): { scale: number; constraint: ExportConstraint } {
  const long = Math.max(bounds.width, bounds.height)
  if (long <= MAX_IMAGE_SIDE) {
    return { scale: 1, constraint: { type: "SCALE", value: 1 } }
  }
  return { scale: MAX_IMAGE_SIDE / long, constraint: { type: bounds.width >= bounds.height ? "WIDTH" : "HEIGHT", value: MAX_IMAGE_SIDE } }
}

interface PaintLike { type: string; visible?: boolean; opacity?: number; blendMode?: string }

// JPG only for frames with a fully opaque visible fill; everything else exports PNG (D17).
export function hasOpaqueBackground(frame: { opacity?: number; fills?: unknown }, mixed: symbol = figma.mixed): boolean {
  const opacity = frame.opacity ?? 1
  if (opacity < 0.99 || frame.fills === mixed || !Array.isArray(frame.fills)) {
    return false
  }
  return (frame.fills as PaintLike[]).some(
    (paint) => paint.visible !== false && (paint.opacity ?? 1) >= 0.99 && !(paint.type === "IMAGE" && paint.blendMode !== undefined && paint.blendMode !== "NORMAL"),
  )
}

// Successive SCALE values for re-exports of an image above 2,000,000 bytes: × 0.75 each, clamped at 0.25,
// each strictly below the previous one (so below the 4096-px plan).
export function retryScales(scale: number): number[] {
  const scales: number[] = []
  let previous = scale
  for (;;) {
    const next = Math.max(previous * RETRY_FACTOR, MIN_RETRY_SCALE)
    if (next >= previous) {
      return scales
    }
    scales.push(next)
    if (next === MIN_RETRY_SCALE) {
      return scales
    }
    previous = next
  }
}

export type FrameExport =
  | { ok: true; format: "JPG" | "PNG"; bytes: Uint8Array; scale: number; width: number; height: number; bounds: BoxRect; attempts: number }
  | { ok: false; reason: "no_bounds" | "too_large" | "export_failed" }

type ExportableNode = SceneNode & ExportMixin & { absoluteBoundingBox: Rect | null; opacity?: number; fills?: unknown }

// §7.16 steps 1–4 for one frame (the caller loads the frame's page first).
export async function exportFrameImage(frame: ExportableNode): Promise<FrameExport> {
  const bounds = frame.absoluteBoundingBox
  if (bounds === null || bounds.width <= 0 || bounds.height <= 0) {
    return { ok: false, reason: "no_bounds" }
  }
  const format = hasOpaqueBackground(frame) ? "JPG" : "PNG"
  const plan = exportPlan(bounds)
  const attempt = async (constraint: ExportConstraint) =>
    frame.exportAsync({ format, constraint, useAbsoluteBounds: true, colorProfile: "SRGB" })
  let scale = plan.scale
  let attempts = 1
  let bytes: Uint8Array
  try {
    bytes = await attempt(plan.constraint)
    for (const next of retryScales(plan.scale)) {
      if (bytes.length <= MAX_IMAGE_UPLOAD_BYTES) {
        break
      }
      scale = next
      attempts++
      bytes = await attempt({ type: "SCALE", value: next })
    }
  } catch {
    return { ok: false, reason: "export_failed" }
  }
  if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, reason: "too_large" }
  }
  return {
    ok: true,
    format,
    bytes,
    scale,
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    attempts,
  }
}
