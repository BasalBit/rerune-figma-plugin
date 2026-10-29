import type { FigmaTextStyle } from "../shared/api-types"
import { MAX_IMAGE_SIDE, MAX_IMAGE_UPLOAD_BYTES, OBJECT_ID_PATTERN, SCAN_YIELD_EVERY_TEXTS, SCREENSHOT_MAX_BOXES } from "../shared/constants"
import type { Box, FrameSkip, FrameSkipReason, MainToUi, MainToUiOf, RequestId } from "../shared/messages"
import { capturedText, captureTextStyle, scaleTextStyle } from "../shared/text-style"
import { readLinkInfo } from "./links"
import { createNodeCaches, isHidden, pageOf, yieldToCanvas, type NodeCaches } from "./node-utils"
import { readFileSettings } from "./settings"
import { shownPreview } from "./shown-preview"

// Frame export rules (§7.16) and key boxes (Appendix A.8), used by diagnostics T3/T4 and by the Phase 2
// screenshots-export handler (one frame-image per exported frame, then frame-images-done).

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

export type FrameImage = Omit<MainToUiOf<"frame-image">, "type" | "requestId">
export type ScreenshotExport = { ok: true; image: FrameImage } | { ok: false; reason: FrameSkipReason }

// `rect` is relative to the frame's top-left corner, read in the same synchronous step as the frame's bounds, with
// the layer's text and its style in Figma units (screenshot freshness, contract §3.3).
export interface BoxSource { nodeId: string; keyId: string; rect: BoxRect; text: string | null; style: FigmaTextStyle | null }
export interface FrameBoxSources { previewing: boolean; sources: BoxSource[] }

const BOX_STATES = ["ok", "inherited"]

// A node a screenshot can be exported from (also the roots of a scan of requested frames, src/main/scan.ts).
export function isExportable(node: BaseNode): node is ExportableNode {
  return node.type !== "PAGE" && node.type !== "DOCUMENT" && "exportAsync" in node && "absoluteBoundingBox" in node
}

// §7.16 step 5 inputs: the visible text under the frame that shows a key of this project (link state ok or
// inherited; inherited_overridden and copied links show no key), with its bounds relative to the frame. The walk
// yields to the canvas and the designer can move the frame meanwhile, so each text's absolute bounds are taken
// relative to the frame's bounds read in the same step (never to bounds read before or after an await): the
// boxes stay on their text however the frame moves before the export. The layer's characters and text style are
// read in that step too, so they match the image (previewing frames are refused first, so the characters are the
// design text). `previewing` is set as soon as one text shows a language preview: the image would show preview
// text, never the design (D23). A text that fails to read is left out; the frame still exports.
export async function frameBoxSources(frame: SceneNode & { absoluteBoundingBox: Rect | null }, projectId: string | null, caches: NodeCaches): Promise<FrameBoxSources> {
  const sources: BoxSource[] = []
  const texts = "findAllWithCriteria" in frame ? (frame as SceneNode & ChildrenMixin).findAllWithCriteria({ types: ["TEXT"] }) : []
  for (let index = 0; index < texts.length; index++) {
    if (index > 0 && index % SCAN_YIELD_EVERY_TEXTS === 0) {
      await yieldToCanvas()
    }
    const text = texts[index]
    try {
      if (text.removed || isHidden(text, caches)) {
        continue
      }
      if ((await shownPreview(text, caches)) !== null) {
        return { previewing: true, sources: [] }
      }
      if (projectId === null) {
        continue
      }
      const info = readLinkInfo(text, caches)
      const link = info.link
      if (link === null || !BOX_STATES.includes(info.state) || link.p !== projectId || !OBJECT_ID_PATTERN.test(link.id)) {
        continue
      }
      const origin = frame.absoluteBoundingBox
      const rect = text.absoluteBoundingBox
      if (rect !== null && origin !== null) {
        sources.push({
          nodeId: text.id,
          keyId: link.id,
          rect: { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height },
          text: capturedText(text.characters),
          style: captureTextStyle(text, frame.id),
        })
      }
    } catch {
      // The canvas stays editable: a text removed or unreadable meanwhile gets no box.
    }
  }
  return { previewing: false, sources }
}

const FRAME_ORIGIN: BoxRect = { x: 0, y: 0, width: 0, height: 0 }

// Boxes in image pixels (Appendix A.8, with frame-relative rects) for the exported image; texts clipped away by the
// frame get none. E19 takes at most 500 boxes per image, so the first 500 in layer order are kept. The style's
// lengths are scaled by the same factor as the rect.
export function boxesFor(sources: readonly BoxSource[], scale: number, imgW: number, imgH: number): Box[] {
  const boxes: Box[] = []
  for (const source of sources) {
    const box = boxFor(source.rect, FRAME_ORIGIN, scale, imgW, imgH)
    if (box !== null) {
      boxes.push({ nodeId: source.nodeId, keyId: source.keyId, ...box, text: source.text, style: source.style === null ? null : scaleTextStyle(source.style, scale) })
      if (boxes.length >= SCREENSHOT_MAX_BOXES) {
        break
      }
    }
  }
  return boxes
}

// §7.16 steps 1–5 for one frame: look it up, load its page, collect the key texts, export, compute the boxes.
export async function exportScreenshot(frameId: string, projectId: string | null): Promise<ScreenshotExport> {
  let node: BaseNode | null
  try {
    node = await figma.getNodeByIdAsync(frameId)
  } catch {
    return { ok: false, reason: "not_found" }
  }
  if (node === null || node.removed || !isExportable(node)) {
    return { ok: false, reason: "not_found" }
  }
  const frame = node
  const page = pageOf(frame)
  try {
    if (page !== null) {
      await page.loadAsync()
    }
  } catch {
    return { ok: false, reason: "export_failed" }
  }
  const bounds = frame.absoluteBoundingBox
  if (bounds === null || bounds.width <= 0 || bounds.height <= 0) {
    return { ok: false, reason: "no_bounds" }
  }
  let collected: FrameBoxSources
  try {
    collected = await frameBoxSources(frame, projectId, createNodeCaches())
  } catch {
    // Without its boxes the upload would replace the frame's screenshot with one that shows no keys.
    return { ok: false, reason: "export_failed" }
  }
  if (collected.previewing) {
    return { ok: false, reason: "preview_active" }
  }
  // The box walk yields to the canvas: the designer may have deleted the frame (or undone its creation) meanwhile.
  if (frame.removed) {
    return { ok: false, reason: "not_found" }
  }
  let exported: FrameExport
  try {
    exported = await exportFrameImage(frame)
  } catch {
    // A node removed during the export throws on its first read (absoluteBoundingBox).
    exported = { ok: false, reason: "export_failed" }
  }
  if (!exported.ok) {
    return { ok: false, reason: frame.removed ? "not_found" : exported.reason }
  }
  return {
    ok: true,
    image: {
      frameId: frame.id,
      frameName: frame.name,
      pageId: page === null ? "" : page.id,
      pageName: page === null ? "" : page.name,
      format: exported.format,
      bytes: exported.bytes,
      width: exported.width,
      height: exported.height,
      boxes: boxesFor(collected.sources, exported.scale, exported.width, exported.height),
    },
  }
}

// screenshots-export (§7.16): frames one at a time with a yield between them, one frame-image message per
// exported frame (peak memory stays at one image), then frame-images-done with the frames that were skipped.
// Boxes are for keys of the file's project. Reads only.
export async function exportScreenshots(requestId: RequestId, frameIds: readonly string[], send: (message: MainToUi) => void): Promise<void> {
  const projectId = readFileSettings().settings?.projectId ?? null
  const skipped: FrameSkip[] = []
  let exported = 0
  for (let index = 0; index < frameIds.length; index++) {
    if (index > 0) {
      await yieldToCanvas()
    }
    const frameId = frameIds[index]
    let result: ScreenshotExport
    try {
      result = await exportScreenshot(frameId, projectId)
    } catch {
      result = { ok: false, reason: "export_failed" }
    }
    if (result.ok) {
      exported++
      send({ type: "frame-image", requestId, ...result.image })
    } else {
      skipped.push({ frameId, reason: result.reason })
    }
  }
  send({ type: "frame-images-done", requestId, exported, skipped })
}

// The UI sends frame ids as a list of strings; anything else is a programming error answered with handler-error.
export function frameIdsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("frameIds must be a list of frame ids")
  }
  return value as string[]
}
