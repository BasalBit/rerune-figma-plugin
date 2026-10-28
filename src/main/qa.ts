import { DATA_KEYS, PLUGIN_DATA_NAMESPACE, SCAN_YIELD_EVERY_TEXTS, WRITE_YIELD_EVERY } from "../shared/constants"
import type { NodeError, ResolveSource, UiToMainOf } from "../shared/messages"
import { LANGUAGE_COPY_MESSAGES, nodeError, type NodeErrorCode } from "../shared/node-errors"
import {
  clippedBy,
  exceedsParentBy,
  fixedAxes,
  largestBy,
  NO_MARGINS,
  NO_PADDING,
  overflowChecks,
  paddingValue,
  renderMargins,
  truncatedBy,
  type OverflowItem,
  type ParentBox,
  type ParentSizing,
  type Rect,
  type RenderExtras,
} from "../shared/overflow"
import { isOwnLangCopy, serializeLangCopy } from "../shared/plugin-data"
import { loadNodeFonts } from "./fonts"
import { getTextNode, type OpOutcome } from "./links"
import { createNodeCaches, isBoundToVariable, pageOf, withInvisibleInstanceChildren, yieldToCanvas, type NodeCaches } from "./node-utils"
import { shownPreview } from "./shown-preview"
import { readSegments, writeTextKeepingStyles } from "./text-write"

// QA (§7.18, Design mode only): the overflow check run by the overflow report after each language's preview, and
// language copies ("duplicate frame per language", D32).

export const OVERFLOW_YIELD_EVERY = 20
export const LANGUAGE_COPY_GAP = 100

// ---------------------------------------------------------------------------------------------------------------
// overflow-check (§7.18.1): measures the given text layers as they are now (the UI has just previewed a language)
// with the heuristics of src/shared/overflow.ts. Truncating text and fixed boxes are measured on a clone that is
// removed again in the same synchronous step. Layers that are gone, hidden in an instance or unreadable are left out.

export async function checkOverflow(nodeIds: readonly string[]): Promise<OverflowItem[]> {
  const items: OverflowItem[] = []
  const parents = new Map<string, ParentBox | null>()
  const seen = new Set<string>()
  for (let index = 0; index < nodeIds.length; index++) {
    if (index > 0 && index % OVERFLOW_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const nodeId = nodeIds[index]
    if (seen.has(nodeId)) {
      continue
    }
    seen.add(nodeId)
    const node = await getTextNode(nodeId)
    if (node === null || node.removed) {
      continue
    }
    items.push(...(await overflowOf(node, parents)))
  }
  return items
}

async function overflowOf(node: TextNode, parents: Map<string, ParentBox | null>): Promise<OverflowItem[]> {
  let checks: ReturnType<typeof overflowChecks>
  try {
    checks = overflowChecks({ textAutoResize: node.textAutoResize, textTruncation: node.textTruncation })
  } catch {
    return []
  }
  const found: OverflowItem[] = []
  const add = (kind: OverflowItem["kind"], by: number | null) => {
    if (by !== null) {
      found.push({ nodeId: node.id, kind, by })
    }
  }
  if (checks.clipped) {
    add("clipped", await clippingOf(node))
  }
  if (checks.truncated) {
    add("truncated", await truncationOf(node))
  }
  if (checks.parent) {
    add("exceeds_parent", attempt(() => exceedsParentBy(rectOf(node.absoluteBoundingBox), parentBoxOf(node, parents))))
  }
  return found
}

function attempt(measure: () => number | null): number | null {
  try {
    return measure()
  } catch {
    return null
  }
}

function rectOf(rect: Rect | null | undefined): Rect | null {
  return rect === null || rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function renderExtras(node: TextNode): RenderExtras {
  return {
    effects: node.effects as unknown as RenderExtras["effects"],
    strokes: node.strokes as unknown as RenderExtras["strokes"],
    strokeWeight: typeof node.strokeWeight === "number" ? node.strokeWeight : null,
    strokeAlign: node.strokeAlign,
  }
}

// How much taller than the layer its text is when the height follows the text: { by } (null within the
// tolerance), or null when it cannot be measured (missing font, a clone Figma refuses). The layer's height is read
// before the clone exists, so the clone cannot affect it.
async function heightExcess(node: TextNode): Promise<{ by: number | null } | null> {
  try {
    const height = node.height
    const full = await untruncatedHeight(node)
    return full === null ? null : { by: truncatedBy(height, full) }
  } catch {
    return null
  }
}

// (b) Truncating text.
async function truncationOf(node: TextNode): Promise<number | null> {
  return (await heightExcess(node))?.by ?? null
}

// (a) A fixed box without truncation: more lines than the box holds are found on a clone whose height follows the
// text, so glyph insets, tight line heights and text inside instances (whose render bounds can be null) do not
// matter; a word wider than the box is found by the render bounds' left and right edges, allowing for effects and
// strokes per side. When the clone cannot be measured, the render bounds' top and bottom edges are compared too.
async function clippingOf(node: TextNode): Promise<number | null> {
  const measured = await heightExcess(node)
  const margins = read(() => renderMargins(renderExtras(node))) ?? NO_MARGINS
  const sides = attempt(() => clippedBy(rectOf(node.absoluteBoundingBox), rectOf(node.absoluteRenderBounds), margins, { horizontal: true, vertical: measured === null }))
  return largestBy(measured === null ? null : measured.by, sides)
}

// The height the text needs without truncation: a clone with truncation off, no line limit and a fixed width whose
// height follows the text (tooling map §3.13). The fonts are loaded before the clone exists, so creating,
// measuring and removing it happen without an await in between and the canvas never shows it. The clone goes to
// the top of the current page, so it cannot reflow an auto-layout parent. Null when the fonts cannot be loaded.
async function untruncatedHeight(node: TextNode): Promise<number | null> {
  if (node.hasMissingFont) {
    return null
  }
  await loadNodeFonts(node)
  let clone: TextNode | null = null
  try {
    clone = node.clone()
    try {
      figma.currentPage.appendChild(clone)
    } catch {
      // Figma parents clones under the current page already.
    }
    clone.textTruncation = "DISABLED"
    clone.maxLines = null
    clone.textAutoResize = "HEIGHT"
    return clone.height
  } finally {
    if (clone !== null && !clone.removed) {
      clone.remove()
    }
  }
}

const GROUPING_TYPES = ["GROUP", "BOOLEAN_OPERATION", "TRANSFORM_GROUP"]
const PARENT_TYPES = ["FRAME", "COMPONENT", "INSTANCE"]

type SizedParent = FrameNode | ComponentNode | InstanceNode

// The frame whose box limits the text: groups take the size of their content, so they are skipped. Text placed
// directly on a page or in a section has no such parent.
export function constrainingParent(node: BaseNode): SizedParent | null {
  let parent = node.parent
  while (parent !== null && GROUPING_TYPES.includes(parent.type)) {
    parent = parent.parent
  }
  return parent !== null && PARENT_TYPES.includes(parent.type) ? (parent as SizedParent) : null
}

function read<T>(get: () => T): T | null {
  try {
    const value = get()
    return value === undefined ? null : value
  } catch {
    return null
  }
}

// (c) The parent's box, its auto-layout padding and which axes cannot grow with the text; cached per parent for
// one overflow-check.
export function parentBoxOf(node: BaseNode, cache: Map<string, ParentBox | null>): ParentBox | null {
  const parent = constrainingParent(node)
  if (parent === null) {
    return null
  }
  const known = cache.get(parent.id)
  if (known !== undefined) {
    return known
  }
  let result: ParentBox | null = null
  const box = rectOf(read(() => parent.absoluteBoundingBox))
  if (box !== null) {
    const sizing: ParentSizing = {
      layoutMode: read(() => parent.layoutMode),
      primaryAxisSizingMode: read(() => parent.primaryAxisSizingMode),
      counterAxisSizingMode: read(() => parent.counterAxisSizingMode),
      layoutSizingHorizontal: read(() => parent.layoutSizingHorizontal),
      layoutSizingVertical: read(() => parent.layoutSizingVertical),
    }
    const axes = fixedAxes(sizing)
    const autoLayout = sizing.layoutMode !== null && sizing.layoutMode !== "NONE"
    const padding = autoLayout
      ? {
          left: paddingValue(read(() => parent.paddingLeft)),
          right: paddingValue(read(() => parent.paddingRight)),
          top: paddingValue(read(() => parent.paddingTop)),
          bottom: paddingValue(read(() => parent.paddingBottom)),
        }
      : NO_PADDING
    result = { box, padding, fixedWidth: axes.width, fixedHeight: axes.height }
  }
  cache.set(parent.id, result)
  return result
}

// ---------------------------------------------------------------------------------------------------------------
// language-copies (§7.18.4, D32): one copy of each top-level frame or instance per language, next to the original,
// marked with langCopy (nid = the copy's id) so scans and pushes skip it, with the resolved text written into the
// copy's layers. Undo is native: the bus commits the whole message as one undo step.

export type LanguageCopyRequest = UiToMainOf<"language-copies">["copies"][number]

const RESOLVE_SOURCES: readonly ResolveSource[] = ["draft", "published"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// The UI sends a list of languages with their texts; anything else is a programming error answered with
// handler-error.
export function languageCopiesOf(value: unknown): LanguageCopyRequest[] {
  const valid =
    Array.isArray(value) &&
    value.every(
      (copy) =>
        isRecord(copy) &&
        typeof copy.lang === "string" && copy.lang !== "" &&
        RESOLVE_SOURCES.includes(copy.source as ResolveSource) &&
        (copy.variationOptionId === null || typeof copy.variationOptionId === "string") &&
        Array.isArray(copy.texts) &&
        copy.texts.every((text) => isRecord(text) && typeof text.nodeId === "string" && typeof text.text === "string"),
    )
  if (!valid) {
    throw new Error("copies must be a list of languages with texts")
  }
  return value as LanguageCopyRequest[]
}

type CopySource = FrameNode | InstanceNode

function isTopLevel(node: BaseNode): boolean {
  const parent = node.parent
  return parent !== null && (parent.type === "PAGE" || parent.type === "SECTION")
}

async function copySource(frameId: string): Promise<{ frame: CopySource } | { error: NodeError }> {
  let node: BaseNode | null
  try {
    node = await figma.getNodeByIdAsync(frameId)
  } catch {
    node = null
  }
  if (node === null || node.removed) {
    return { error: nodeError(frameId, "node_not_found") }
  }
  // Cloning a component (or a component set) creates new library components, not a copy of a screen.
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    return { error: nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.component) }
  }
  if ((node.type !== "FRAME" && node.type !== "INSTANCE") || !isTopLevel(node)) {
    return { error: nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.notFrame) }
  }
  if (isOwnLangCopy(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.langCopy), node.id)) {
    return { error: nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.alreadyCopy) }
  }
  // dynamic-page: a frame of another page (the user switched pages meanwhile) can only be walked once loaded.
  const page = pageOf(node)
  if (page !== null && page.id !== figma.currentPage.id) {
    try {
      await page.loadAsync()
    } catch {
      // A refusal of the whole frame: no copy of any language is made.
      return { error: nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.pageNotLoaded) }
    }
  }
  return { frame: node }
}

// Whether any text in the frame shows a language preview (its own record, or instance text following a previewed
// main component): a copy would keep the preview text, or a preview record that Reset could not restore.
async function showsPreview(frame: CopySource, caches: NodeCaches): Promise<boolean> {
  const texts = frame.findAllWithCriteria({ types: ["TEXT"] })
  for (let index = 0; index < texts.length; index++) {
    if (index > 0 && index % SCAN_YIELD_EVERY_TEXTS === 0) {
      await yieldToCanvas()
    }
    try {
      if (!texts[index].removed && (await shownPreview(texts[index], caches)) !== null) {
        return true
      }
    } catch {
      // An unreadable layer cannot carry a readable preview record.
    }
  }
  return false
}

export interface CopyMapping {
  texts: Map<string, TextNode>      // original text id → the copy's text layer
  mismatches: string[]              // ids of the copy's nodes whose subtree did not match the original
}

function childrenOf(node: BaseNode): readonly SceneNode[] {
  return "children" in node ? (node as BaseNode & ChildrenMixin).children : []
}

// clone() turns main components nested in the frame into instances of them.
function sameKind(original: BaseNode, copy: BaseNode): boolean {
  return original.type === copy.type || (original.type === "COMPONENT" && copy.type === "INSTANCE")
}

// Maps the original's text layers to the copy's by walking both trees in parallel. Callers run it with
// skipInvisibleInstanceChildren off: a nested main component becomes an instance in the copy, whose children would
// otherwise leave out hidden layers that the component lists. A level whose types or child counts differ is not
// descended into; that part of the copy keeps the source text and is reported.
export async function mapCopyTexts(original: BaseNode, copy: BaseNode): Promise<CopyMapping> {
  const mapping: CopyMapping = { texts: new Map(), mismatches: [] }
  const stack: [BaseNode, BaseNode][] = [[original, copy]]
  let visited = 0
  while (stack.length > 0) {
    const [source, target] = stack.pop() as [BaseNode, BaseNode]
    visited++
    if (visited % SCAN_YIELD_EVERY_TEXTS === 0) {
      await yieldToCanvas()
    }
    if (!sameKind(source, target)) {
      mapping.mismatches.push(target.id)
      continue
    }
    if (source.type === "TEXT") {
      mapping.texts.set(source.id, target as TextNode)
      continue
    }
    const sourceChildren = childrenOf(source)
    const targetChildren = childrenOf(target)
    if (sourceChildren.length !== targetChildren.length) {
      mapping.mismatches.push(target.id)
      continue
    }
    for (let index = sourceChildren.length - 1; index >= 0; index--) {
      stack.push([sourceChildren[index], targetChildren[index]])
    }
  }
  return mapping
}

// Writes one resolved value into the copy (§7.14 write rules: fonts, mixed styles kept where they can be placed,
// autoRename off so the layer keeps its name). Variable-bound text is never written.
async function writeCopyText(node: TextNode, text: string): Promise<"written" | NodeErrorCode> {
  if (node.characters === text) {
    return "written"
  }
  if (node.hasMissingFont) {
    return "missing_font"
  }
  if (isBoundToVariable(node)) {
    return "bound_to_variable"
  }
  const segments = readSegments(node)
  try {
    await loadNodeFonts(node, segments)
  } catch {
    return "missing_font"
  }
  node.autoRename = false
  return (await writeTextKeepingStyles(node, text, segments)) ? "mixed_styles_flattened" : "written"
}

// One copy of `frame` for language number `index` (0-based): inserted right after the original (and the copies made
// before it) in the same parent, so a frame inside a section stays in it; placed to the right of the original. A frame
// deleted meanwhile (the canvas stays usable during the run) gets no copy and `removed` on its id (`frameId`, read
// before the run: a removed node's properties may not be readable).
async function copyFrame(frameId: string, frame: CopySource, request: LanguageCopyRequest, index: number, now: number): Promise<OpOutcome> {
  const parent = frame.removed ? null : frame.parent
  if (parent === null) {
    return { done: 0, errors: [nodeError(frameId, "node_not_found", LANGUAGE_COPY_MESSAGES.removed)] }
  }
  let copy: CopySource
  try {
    copy = frame.clone()
  } catch {
    return { done: 0, errors: [nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.failed)] }
  }
  try {
    parent.insertChild(parent.children.indexOf(frame) + 1 + index, copy)
    copy.x = frame.x + (frame.width + LANGUAGE_COPY_GAP) * (index + 1)
    copy.y = frame.y
    copy.name = frame.name + " · " + request.lang
    copy.setSharedPluginData(
      PLUGIN_DATA_NAMESPACE,
      DATA_KEYS.langCopy,
      serializeLangCopy({ v: 1, nid: copy.id, lang: request.lang, source: request.source, variationOptionId: request.variationOptionId, sourceFrameId: frameId, createdAt: now }),
    )
  } catch {
    try {
      copy.remove()
    } catch {
      // Nothing more to undo.
    }
    return { done: 0, errors: [nodeError(frameId, "write_failed", LANGUAGE_COPY_MESSAGES.failed)] }
  }
  const errors: NodeError[] = []
  const mapping = await mapCopyTexts(frame, copy)
  for (const nodeId of mapping.mismatches) {
    errors.push(nodeError(nodeId, "subtree_mismatch", LANGUAGE_COPY_MESSAGES.mismatch))
  }
  let done = 0
  for (let position = 0; position < request.texts.length; position++) {
    if (position > 0 && position % WRITE_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const item = request.texts[position]
    const target = mapping.texts.get(item.nodeId)
    if (target === undefined || target.removed) {
      continue
    }
    try {
      const outcome = await writeCopyText(target, item.text)
      if (outcome === "written" || outcome === "mixed_styles_flattened") {
        done++
      }
      if (outcome !== "written") {
        errors.push(nodeError(target.id, outcome))
      }
    } catch {
      errors.push(nodeError(target.id, "write_failed"))
    }
  }
  return { done, errors }
}

// language-copies: frames are checked first (not found, component, not a top-level frame, already a copy); then the
// request is refused as a whole while any of the frames shows a preview ("Reset previews first."). `done` counts
// the text layers written in all copies; refusals carry the frame's id, per-layer problems the copy's layer id.
export function makeLanguageCopies(frameIds: readonly string[], copies: readonly LanguageCopyRequest[], now: number): Promise<OpOutcome> {
  return withInvisibleInstanceChildren(async () => {
    const errors: NodeError[] = []
    const frames: { id: string; node: CopySource }[] = []
    const seen = new Set<string>()
    for (const frameId of frameIds) {
      if (seen.has(frameId)) {
        continue
      }
      seen.add(frameId)
      const checked = await copySource(frameId)
      if ("error" in checked) {
        errors.push(checked.error)
      } else {
        frames.push({ id: frameId, node: checked.frame })
      }
    }
    const caches = createNodeCaches()
    const previewing: NodeError[] = []
    for (const frame of frames) {
      if (!frame.node.removed && (await showsPreview(frame.node, caches))) {
        previewing.push(nodeError(frame.id, "preview_active", LANGUAGE_COPY_MESSAGES.previewing))
      }
    }
    if (previewing.length > 0) {
      return { done: 0, errors: errors.concat(previewing) }
    }
    let done = 0
    for (const frame of frames) {
      for (let index = 0; index < copies.length; index++) {
        // The canvas stays usable while copies are written, so the frame can be deleted (or undone) meanwhile: each
        // language left without a copy is reported (`removed`), so the UI counts only the copies made.
        const outcome = await copyFrame(frame.id, frame.node, copies[index], index, now)
        done += outcome.done
        errors.push(...outcome.errors)
      }
    }
    return { done, errors }
  })
}
