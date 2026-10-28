import type { MainToUiOf } from "./messages"

// Overflow heuristics (§7.18.1, tooling map §3.13), pure so main and the tests share them. Figma has no "is this
// text cut off" property; main measures each previewed text layer and these rules decide:
// (a) fixed box, no truncation: the rendered glyphs are taller or wider than the box → "clipped";
// (b) truncating text (ending ellipsis, or the deprecated TRUNCATE resize): a clone measured without truncation is
//     taller than the layer → "truncated";
// (c) auto-sized text in a parent of fixed size: the layer's box reaches past the parent's inner box (its box minus
//     auto-layout padding) on a fixed axis → "exceeds_parent".
// `by` is in pixels, rounded to one decimal place. The tolerance (1.5 px) absorbs rendering noise.

export type OverflowItem = MainToUiOf<"overflow-result">["items"][number]
export type OverflowKind = OverflowItem["kind"]

export const OVERFLOW_TOLERANCE_PX = 1.5
export const OVERFLOW_KINDS: readonly OverflowKind[] = ["clipped", "truncated", "exceeds_parent"]

export interface Rect { x: number; y: number; width: number; height: number }

export type TextAutoResize = "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE"
export type TextTruncation = "DISABLED" | "ENDING"

export interface OverflowChecks { clipped: boolean; truncated: boolean; parent: boolean }

// Which checks apply to a text layer. A truncating layer is measured with a clone; a fixed box without truncation
// is compared with its render bounds; auto-sized text (also when it truncates at maxLines) is compared with its
// parent.
export function overflowChecks(text: { textAutoResize: TextAutoResize; textTruncation: TextTruncation }): OverflowChecks {
  const truncating = text.textTruncation === "ENDING" || text.textAutoResize === "TRUNCATE"
  return {
    clipped: text.textAutoResize === "NONE" && !truncating,
    truncated: truncating,
    parent: text.textAutoResize === "WIDTH_AND_HEIGHT" || text.textAutoResize === "HEIGHT",
  }
}

export function roundBy(excess: number): number {
  return Math.round(excess * 10) / 10
}

function isRect(value: Rect | null | undefined): value is Rect {
  return (
    value !== null && value !== undefined &&
    isFinite(value.x) && isFinite(value.y) && isFinite(value.width) && isFinite(value.height)
  )
}

// Effects and strokes enlarge the render bounds of a layer that does not overflow at all; this is how far they can
// reach past the box on one side. Drop shadows reach their offset plus blur radius plus spread, layer blurs their
// radius, outside and centred strokes their (half) weight. Inner shadows and background blurs stay inside.
export interface RenderExtras {
  effects?: ReadonlyArray<{ type: string; visible?: boolean; radius?: number; spread?: number; offset?: { x: number; y: number } }> | null
  strokes?: ReadonlyArray<{ visible?: boolean }> | null
  strokeWeight?: number | null
  strokeAlign?: string | null
}

export function renderMargin(extras: RenderExtras): number {
  let shadow = 0
  let blur = 0
  for (const effect of extras.effects ?? []) {
    if (effect.visible === false) {
      continue
    }
    const radius = typeof effect.radius === "number" && isFinite(effect.radius) ? Math.max(0, effect.radius) : 0
    if (effect.type === "DROP_SHADOW") {
      const offset = effect.offset ?? { x: 0, y: 0 }
      const spread = typeof effect.spread === "number" && isFinite(effect.spread) ? Math.max(0, effect.spread) : 0
      shadow = Math.max(shadow, Math.max(Math.abs(offset.x), Math.abs(offset.y)) + radius + spread)
    } else if (effect.type === "LAYER_BLUR") {
      blur = Math.max(blur, radius)
    }
  }
  let stroke = 0
  const weight = extras.strokeWeight
  if (typeof weight === "number" && isFinite(weight) && weight > 0 && (extras.strokes ?? []).some((paint) => paint.visible !== false)) {
    if (extras.strokeAlign === "OUTSIDE") {
      stroke = weight
    } else if (extras.strokeAlign !== "INSIDE") {
      stroke = weight / 2
    }
  }
  return shadow + blur + stroke
}

// (a) A fixed-size text box without truncation: Figma draws text that does not fit past the box, so its render
// bounds grow taller (or wider, for a word longer than the box) than the box. Returns the excess beyond the
// tolerance and what effects and strokes can explain, or null. A null render rect (an invisible layer, or text
// clipped inside an instance) cannot be judged.
export function clippedBy(box: Rect | null, render: Rect | null, margin = 0, tolerance = OVERFLOW_TOLERANCE_PX): number | null {
  if (!isRect(box) || !isRect(render)) {
    return null
  }
  const allowed = 2 * Math.max(0, margin)
  const excess = Math.max(render.height - box.height, render.width - box.width) - allowed
  return excess > tolerance ? roundBy(excess) : null
}

// (b) Truncating text: the clone without truncation (fixed width, height grows) against the layer's height.
export function truncatedBy(height: number, fullHeight: number, tolerance = OVERFLOW_TOLERANCE_PX): number | null {
  if (!isFinite(height) || !isFinite(fullHeight)) {
    return null
  }
  const excess = fullHeight - height
  return excess > tolerance ? roundBy(excess) : null
}

export type LayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID"
export type AxisSizingMode = "FIXED" | "AUTO"
export type LayoutSizing = "FIXED" | "HUG" | "FILL"

export interface ParentSizing {
  layoutMode: LayoutMode | null                       // null: not a frame-like node, or unreadable (no auto layout)
  primaryAxisSizingMode: AxisSizingMode | null
  counterAxisSizingMode: AxisSizingMode | null
  layoutSizingHorizontal: LayoutSizing | null
  layoutSizingVertical: LayoutSizing | null
}

// Whether a parent keeps its width / height when its content grows. A frame without auto layout never grows with
// its children; an auto-layout frame grows on an axis it hugs ("HUG", or sizing mode "AUTO" on that axis). "FILL"
// takes its size from its own parent, so the content cannot grow it either.
export function fixedAxes(sizing: ParentSizing): { width: boolean; height: boolean } {
  const mode = sizing.layoutMode ?? "NONE"
  const fromModes = (horizontal: boolean): boolean => {
    if (mode === "NONE" || mode === "GRID") {
      return true
    }
    const primary = (mode === "HORIZONTAL") === horizontal
    return (primary ? sizing.primaryAxisSizingMode : sizing.counterAxisSizingMode) !== "AUTO"
  }
  return {
    width: sizing.layoutSizingHorizontal !== null ? sizing.layoutSizingHorizontal !== "HUG" : fromModes(true),
    height: sizing.layoutSizingVertical !== null ? sizing.layoutSizingVertical !== "HUG" : fromModes(false),
  }
}

export interface Padding { left: number; right: number; top: number; bottom: number }

export const NO_PADDING: Padding = { left: 0, right: 0, top: 0, bottom: 0 }

export interface ParentBox { box: Rect; padding: Padding; fixedWidth: boolean; fixedHeight: boolean }

export function innerBox(parent: Pick<ParentBox, "box" | "padding">): Rect {
  const { box, padding } = parent
  return {
    x: box.x + padding.left,
    y: box.y + padding.top,
    width: Math.max(0, box.width - padding.left - padding.right),
    height: Math.max(0, box.height - padding.top - padding.bottom),
  }
}

// (c) Auto-sized text against its parent's inner box, on the axes the parent cannot grow: how far the layer's box
// reaches past an edge, or null within the tolerance.
export function exceedsParentBy(text: Rect | null, parent: ParentBox | null, tolerance = OVERFLOW_TOLERANCE_PX): number | null {
  if (!isRect(text) || parent === null || !isRect(parent.box) || (!parent.fixedWidth && !parent.fixedHeight)) {
    return null
  }
  const inner = innerBox(parent)
  let excess = 0
  if (parent.fixedWidth) {
    excess = Math.max(excess, inner.x - text.x, text.x + text.width - (inner.x + inner.width))
  }
  if (parent.fixedHeight) {
    excess = Math.max(excess, inner.y - text.y, text.y + text.height - (inner.y + inner.height))
  }
  return excess > tolerance ? roundBy(excess) : null
}

// Reads a number that may be missing or figma.mixed; anything else counts as 0.
export function paddingValue(value: unknown): number {
  return typeof value === "number" && isFinite(value) ? Math.max(0, value) : 0
}
