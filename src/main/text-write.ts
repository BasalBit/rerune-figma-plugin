import {
  DATA_KEYS,
  DATA_TOMBSTONE,
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_DATA_NAMESPACE,
  PREVIEW_SEGMENTS_MAX_JSON_CHARS,
  SCAN_YIELD_EVERY_TEXTS,
  WRITE_YIELD_EVERY,
} from "../shared/constants"
import { src } from "../shared/hash"
import type { NodeError, PreviewInfo, Scope, TextApplyItem } from "../shared/messages"
import { nodeError, type NodeErrorCode } from "../shared/node-errors"
import { createLink, mainsFirst, parseLink, parsePreviewRecord, serializePreviewRecord, type PreviewRecord } from "../shared/plugin-data"
import { utf8Length } from "../shared/text"
import { loadNodeFonts } from "./fonts"
import { clearPluginData, getTextNode, readLinkInfo, writeLink, writeTargetFor, type OpOutcome } from "./links"
import {
  collectTextNodes,
  createNodeCaches,
  isBoundToVariable,
  isInRemoteComponent,
  overrideFlags,
  withInvisibleInstanceChildren,
  yieldToCanvas,
  type NodeCaches,
} from "./node-utils"
import { isInheritedRecord, shownPreview, type ShownPreview } from "./shown-preview"

// Preview, reset and pull writes (§7.14).

export const SEGMENT_FIELDS = [
  "fontName",
  "fontSize",
  "fills",
  "textDecoration",
  "textCase",
  "letterSpacing",
  "lineHeight",
  "textStyleId",
  "fillStyleId",
  "boundVariables",
  "hyperlink",
  "listOptions",
  "indentation",
  "paragraphSpacing",
] as const

export type SegmentField = (typeof SEGMENT_FIELDS)[number]
export type StyleSegment = Pick<StyledTextSegment, SegmentField | "characters" | "start" | "end">

export interface OriginalText {
  characters: string
  autoRename: boolean
  segments: StyleSegment[] | null
  richLost: boolean
}

class NodeFailure extends Error {
  constructor(readonly code: NodeErrorCode, message?: string) {
    super(message ?? code)
  }
}

export function readSegments(node: TextNode): StyleSegment[] {
  if (node.characters.length === 0) {
    return []
  }
  return node.getStyledTextSegments([...SEGMENT_FIELDS]) as StyleSegment[]
}

// Snapshot for restore (§7.6): segments are dropped (richLost) when their JSON exceeds 90,000 chars.
export function snapshotOriginal(node: TextNode): OriginalText {
  const segments = readSegments(node)
  const tooLarge = JSON.stringify(segments).length > PREVIEW_SEGMENTS_MAX_JSON_CHARS
  return { characters: node.characters, autoRename: node.autoRename, segments: tooLarge ? null : segments, richLost: tooLarge }
}

function isSegment(value: unknown): value is StyleSegment {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const segment = value as Partial<StyleSegment>
  return typeof segment.start === "number" && typeof segment.end === "number" && typeof segment.characters === "string"
}

export function storedSegments(segments: readonly unknown[] | null): StyleSegment[] | null {
  return segments === null ? null : segments.filter(isSegment)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

// Whether [start, end) currently uses a text style or a fill style anywhere.
function rangeStyleIds(node: TextNode, start: number, end: number): { text: boolean; fill: boolean } {
  try {
    const segments = node.getStyledTextSegments(["textStyleId", "fillStyleId"], start, end)
    return { text: segments.some((entry) => nonEmpty(entry.textStyleId)), fill: segments.some((entry) => nonEmpty(entry.fillStyleId)) }
  } catch {
    return { text: false, fill: false }
  }
}

// Re-applies one stored segment's style to [start, end), in the order of §7.14 reset step 3, except that a text style
// goes on last: setting a property it governs afterwards (paragraph spacing, a variable binding) would detach it
// again, even with the style's own value. Each setter runs on its own so one unsupported field does not drop the
// rest; returns how many setters failed.
export async function applySegmentStyle(node: TextNode, segment: StyleSegment, start: number, end: number): Promise<number> {
  let failures = 0
  const run = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch {
      failures++
    }
  }
  const current = rangeStyleIds(node, start, end)
  const textStyleId = nonEmpty(segment.textStyleId) ? segment.textStyleId : null
  if (textStyleId === null) {
    // Writing characters spreads the first character's style; detach a text style this range did not have.
    if (current.text) await run(() => node.setRangeTextStyleIdAsync(start, end, ""))
    if (segment.fontName !== undefined) await run(() => node.setRangeFontName(start, end, segment.fontName))
    if (segment.fontSize !== undefined) await run(() => node.setRangeFontSize(start, end, segment.fontSize))
    if (segment.textDecoration !== undefined) await run(() => node.setRangeTextDecoration(start, end, segment.textDecoration))
    if (segment.textCase !== undefined) await run(() => node.setRangeTextCase(start, end, segment.textCase))
    if (segment.letterSpacing !== undefined) await run(() => node.setRangeLetterSpacing(start, end, segment.letterSpacing))
    if (segment.lineHeight !== undefined) await run(() => node.setRangeLineHeight(start, end, segment.lineHeight))
  }
  if (nonEmpty(segment.fillStyleId)) {
    await run(() => node.setRangeFillStyleIdAsync(start, end, segment.fillStyleId))
  } else {
    if (current.fill) await run(() => node.setRangeFillStyleIdAsync(start, end, ""))
    if (Array.isArray(segment.fills)) await run(() => node.setRangeFills(start, end, segment.fills))
  }
  // Every variable-bindable text field is governed by a text style, which brings its own bindings back.
  const bound = textStyleId === null ? (segment.boundVariables ?? {}) : {}
  for (const field of Object.keys(bound) as VariableBindableTextField[]) {
    const alias = bound[field]
    if (alias === undefined) {
      continue
    }
    await run(async () => {
      const variable = await figma.variables.getVariableByIdAsync(alias.id)
      if (variable === null) {
        throw new Error("Variable not found")
      }
      node.setRangeBoundVariable(start, end, field, variable)
    })
  }
  if (segment.hyperlink !== undefined) await run(() => node.setRangeHyperlink(start, end, segment.hyperlink))
  if (segment.listOptions !== undefined) await run(() => node.setRangeListOptions(start, end, segment.listOptions))
  if (segment.indentation !== undefined) await run(() => node.setRangeIndentation(start, end, segment.indentation))
  if (textStyleId === null) {
    if (segment.paragraphSpacing !== undefined) await run(() => node.setRangeParagraphSpacing(start, end, segment.paragraphSpacing))
  } else {
    await run(() => node.setRangeTextStyleIdAsync(start, end, textStyleId))
  }
  return failures
}

// Writes new text (§7.14 apply steps 4–5): characters reset range styles, so each original segment after the
// first whose trimmed text (≥ 2 chars) occurs in the new text gets its style back at the first occurrence.
// Returns true when a styled segment could not be placed (mixed_styles_flattened).
export async function writeTextKeepingStyles(node: TextNode, text: string, segments: readonly StyleSegment[] | null): Promise<boolean> {
  node.characters = text
  if (segments === null || segments.length <= 1) {
    return false
  }
  let flattened = false
  for (const segment of segments.slice(1)) {
    const needle = segment.characters.trim()
    if (needle === "") {
      continue
    }
    const at = needle.length >= 2 ? text.indexOf(needle) : -1
    if (at < 0) {
      flattened = true
      continue
    }
    if ((await applySegmentStyle(node, segment, at, at + needle.length)) > 0) {
      flattened = true
    }
  }
  return flattened
}

// Restores the original text and every stored segment style (§7.14 reset step 3). Returns failed setters.
export async function restoreOriginal(node: TextNode, original: Pick<OriginalText, "characters" | "segments">): Promise<number> {
  node.characters = original.characters
  let failures = 0
  for (const segment of original.segments ?? []) {
    if (segment.end > original.characters.length || segment.start >= segment.end) {
      failures++
      continue
    }
    failures += await applySegmentStyle(node, segment, segment.start, segment.end)
  }
  return failures
}

async function loadFontsOrFail(node: TextNode, segments: readonly StyleSegment[] | null): Promise<void> {
  if (node.hasMissingFont) {
    throw new NodeFailure("missing_font")
  }
  try {
    await loadNodeFonts(node, segments)
  } catch {
    throw new NodeFailure("missing_font")
  }
}

function failureOf(nodeId: string, error: unknown): NodeError {
  return error instanceof NodeFailure ? nodeError(nodeId, error.code) : nodeError(nodeId, "write_failed")
}

function readPreviewRaw(node: TextNode): string {
  return node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)
}

// Deletes a node's own preview record; a record that shows through afterwards is kept only when it is inherited.
function clearOwnRecord(node: TextNode): void {
  clearPluginData(node, DATA_KEYS.preview, (raw) => {
    const record = parsePreviewRecord(raw)
    return record === null || record.nid !== node.id
  })
}

function previewRecordJson(record: PreviewRecord): string | null {
  let json = serializePreviewRecord(record)
  if (utf8Length(json) <= PLUGIN_DATA_MAX_BYTES) {
    return json
  }
  json = serializePreviewRecord({ ...record, segments: null, richLost: true })
  return utf8Length(json) <= PLUGIN_DATA_MAX_BYTES ? json : null
}

// preview-apply (§7.14 apply).
export async function applyPreview(info: Omit<PreviewInfo, "appliedAt">, items: readonly { nodeId: string; text: string }[], now: number): Promise<OpOutcome> {
  const caches = createNodeCaches()
  const errors: NodeError[] = []
  let done = 0
  const ordered = mainsFirst(items)
  for (let index = 0; index < ordered.length; index++) {
    if (index > 0 && index % WRITE_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const item = ordered[index]
    const node = await getTextNode(item.nodeId)
    if (node === null) {
      errors.push(nodeError(item.nodeId, "node_not_found"))
      continue
    }
    try {
      const outcome = await previewNode(node, info, item.text, now, caches)
      if (outcome !== "written" && outcome !== "inherited") {
        errors.push(nodeError(item.nodeId, outcome))
        if (outcome === "mixed_styles_flattened") {
          done++
        }
        continue
      }
      done++
    } catch (error) {
      errors.push(failureOf(item.nodeId, error))
    }
  }
  return { done, errors }
}

async function previewNode(node: TextNode, info: Omit<PreviewInfo, "appliedAt">, text: string, now: number, caches: NodeCaches): Promise<"written" | "inherited" | NodeErrorCode> {
  if (node.hasMissingFont) {
    return "missing_font"
  }
  if (isBoundToVariable(node)) {
    return "bound_to_variable"
  }
  if (isInRemoteComponent(node)) {
    return "remote_component"
  }
  const previousRaw = readPreviewRaw(node)
  const existing = parsePreviewRecord(previousRaw)
  let base: PreviewRecord
  let liveSegments: StyleSegment[] | null = null
  if (existing !== null && existing.nid === node.id) {
    base = existing
  } else if ((await shownPreview(node, caches)) !== null) {
    // Instance text that follows a previewed main component (written earlier in this run or before): it already
    // shows that preview, and storing its previewed text as "original" would corrupt reset. This holds whether the
    // main's record shows through as inherited plugin data or the sublayer has plugin data of its own (D44).
    return "inherited"
  } else {
    const flags = overrideFlags(node, caches)
    const original = snapshotOriginal(node)
    liveSegments = original.segments
    base = {
      v: 1,
      nid: node.id,
      previewSrc: "",
      characters: original.characters,
      autoRename: original.autoRename,
      textOverridden: flags.textOverridden,
      pluginDataOverridden: flags.ownPluginDataOverride,
      segments: original.segments,
      richLost: original.richLost,
      lang: info.lang,
      source: info.source,
      variationOptionId: info.variationOptionId,
      appliedAt: now,
    }
  }
  const record: PreviewRecord = { ...base, previewSrc: src(text), lang: info.lang, source: info.source, variationOptionId: info.variationOptionId, appliedAt: now }
  const json = previewRecordJson(record)
  if (json === null) {
    return "too_large"
  }
  const segments = storedSegments(record.segments) ?? liveSegments ?? (record.richLost ? readSegments(node) : null)
  await loadFontsOrFail(node, segments)
  const ownedBefore = existing !== null && existing.nid === node.id
  const autoRenameBefore = node.autoRename
  // The record is written first so a crash mid-write never loses the original text.
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, json)
  let flattened: boolean
  try {
    node.autoRename = false
    flattened = await writeTextKeepingStyles(node, text, segments)
  } catch (error) {
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, ownedBefore ? previousRaw : "")
    node.autoRename = autoRenameBefore
    throw error
  }
  return flattened ? "mixed_styles_flattened" : "written"
}

async function resetTargets(scope: Scope, nodeIds: readonly string[] | undefined, errors: NodeError[]): Promise<TextNode[]> {
  if (nodeIds !== undefined) {
    const nodes: TextNode[] = []
    for (const nodeId of nodeIds) {
      const node = await getTextNode(nodeId)
      if (node === null) {
        errors.push(nodeError(nodeId, "node_not_found"))
      } else {
        nodes.push(node)
      }
    }
    return nodes
  }
  const page = figma.currentPage
  if (scope === "selection") {
    return (await collectTextNodes(page.selection)) ?? []
  }
  await page.loadAsync()
  const fast = page.findAllWithCriteria({ types: ["TEXT"], sharedPluginData: { namespace: PLUGIN_DATA_NAMESPACE, keys: [DATA_KEYS.preview] } })
  const full = (await collectTextNodes(page.children)) ?? []
  const seen = new Set(fast.map((node) => node.id))
  return fast.concat(full.filter((node) => !seen.has(node.id)))
}

// Resets go where the preview lives (§7.14). An instance sublayer that shows a main component's preview has no
// record of its own (or only an inherited one): the main's node is reset instead, which also ends the preview on
// every other instance of it, and nothing is written on the sublayer (D44). Explicit node ids whose preview lives
// in a library file report remote_component; scope resets keep the sublayer too, so a copied record on it is
// still cleared. Nodes that own a record come first, so a main's record usually no longer shows through on its
// instances when they are reached; when the main's reset is held back (edited, missing font), resetNode still
// recognises its record on the instance as inherited through the backing chain and leaves it alone.
async function withPreviewOwners(nodes: readonly TextNode[], explicit: boolean, caches: NodeCaches, errors: NodeError[]): Promise<TextNode[]> {
  const owners: TextNode[] = []
  const others: TextNode[] = []
  const seen = new Set<string>()
  const add = (list: TextNode[], node: TextNode) => {
    if (!seen.has(node.id)) {
      seen.add(node.id)
      list.push(node)
    }
  }
  for (let index = 0; index < nodes.length; index++) {
    if (index > 0 && index % SCAN_YIELD_EVERY_TEXTS === 0) {
      await yieldToCanvas()
    }
    const node = nodes[index]
    if (node.removed) {
      continue
    }
    let shown: ShownPreview | null
    try {
      shown = await shownPreview(node, caches)
    } catch {
      shown = null
    }
    if (shown === null) {
      add(others, node)
      continue
    }
    if (shown.owner === node) {
      add(owners, node)
      continue
    }
    if (shown.owner !== null) {
      add(owners, shown.owner)
    } else if (explicit) {
      errors.push(nodeError(node.id, "remote_component"))
    }
    if (!explicit) {
      add(others, node)
    }
  }
  return owners.concat(others)
}

// Clears a copied record (§7.14 reset step 1) without touching the text: "" first; a record that still shows
// through afterwards is kept when it is the main component's (inherited), anything else gets the tombstone.
async function clearCopiedRecord(node: TextNode): Promise<void> {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, "")
  const raw = readPreviewRaw(node)
  if (raw === "") {
    return
  }
  const visible = parsePreviewRecord(raw)
  if (visible !== null && (await isInheritedRecord(node, visible, createNodeCaches()))) {
    return
  }
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, DATA_TOMBSTONE)
}

// preview-reset (§7.14 reset). Runs with skipInvisibleInstanceChildren off so hidden previewed instance
// children are found; the flag is restored when the last overlapping reset ends.
// Text layers on the current page that own a preview record, for the UI's "N layers on this page still show a
// preview" (a preview left by a plugin closed during an overflow report, or by an earlier session), whatever the scan
// covers. Uses only the criteria fast path (§1.5: it may miss some instance sublayers), so it is a hint, never a list
// of reset targets; a page reset still scans every text layer. null when the page can't be read.
export function countPagePreviews(): number | null {
  try {
    const nodes = figma.currentPage.findAllWithCriteria({ types: ["TEXT"], sharedPluginData: { namespace: PLUGIN_DATA_NAMESPACE, keys: [DATA_KEYS.preview] } })
    let count = 0
    for (const node of nodes) {
      const record = parsePreviewRecord(readPreviewRaw(node))
      if (record !== null && record.nid === node.id) {
        count++
      }
    }
    return count
  } catch {
    return null
  }
}

export function resetPreview(scope: Scope, nodeIds: readonly string[] | undefined, edited: "restore" | "keep" | undefined): Promise<OpOutcome> {
  return withInvisibleInstanceChildren(async () => {
    const errors: NodeError[] = []
    let done = 0
    const caches = createNodeCaches()
    const explicit = nodeIds !== undefined
    const nodes = await withPreviewOwners(await resetTargets(scope, nodeIds, errors), explicit, caches, errors)
    for (let index = 0; index < nodes.length; index++) {
      if (index > 0 && index % WRITE_YIELD_EVERY === 0) {
        await yieldToCanvas()
      }
      const node = nodes[index]
      if (node.removed) {
        continue
      }
      try {
        const outcome = await resetNode(node, caches, explicit, edited)
        if (outcome === "restored" || outcome === "cleared") {
          done++
        } else if (outcome === "override_kept" || outcome === "styles_lost") {
          done++
          errors.push(outcome === "override_kept" ? nodeError(node.id, "override_kept") : nodeError(node.id, "write_failed", "Some text styles couldn't be restored."))
        } else if (outcome !== "skipped") {
          errors.push(nodeError(node.id, outcome))
        }
      } catch (error) {
        errors.push(failureOf(node.id, error))
      }
    }
    return { done, errors }
  })
}

type ResetOutcome = "restored" | "cleared" | "skipped" | "override_kept" | "styles_lost" | NodeErrorCode

async function resetNode(node: TextNode, caches: NodeCaches, explicit: boolean, edited: "restore" | "keep" | undefined): Promise<ResetOutcome> {
  const record = parsePreviewRecord(readPreviewRaw(node))
  if (record === null) {
    return explicit ? "not_previewing" : "skipped"
  }
  if (record.nid !== node.id) {
    if (await isInheritedRecord(node, record, caches)) {
      // Disappears with the main component's own record (also when that reset was held back, e.g. edited during
      // the preview); writing here would create an override (D44).
      return "skipped"
    }
    await clearCopiedRecord(node)
    return "cleared"
  }
  if (src(node.characters) !== record.previewSrc) {
    if (edited === "keep") {
      clearOwnRecord(node)
      return "cleared"
    }
    if (edited !== "restore") {
      return "edited_during_preview"
    }
  }
  const segments = storedSegments(record.segments)
  try {
    await loadFontsOrFail(node, segments)
  } catch (error) {
    return error instanceof NodeFailure ? error.code : "missing_font"
  }
  const failures = await restoreOriginal(node, { characters: record.characters, segments })
  node.autoRename = record.autoRename
  clearOwnRecord(node)
  if (!record.textOverridden && overrideFlags(node, createNodeCaches()).textOverridden) {
    return "override_kept"
  }
  return failures > 0 ? "styles_lost" : "restored"
}

// text-apply (§7.14 pull, §7.13 rules 4–5): same font and style rules as preview, no preview record; refuses
// nodes with an active preview or a variable binding, and (an item with `expectedSrc`, a pull) a layer whose text
// changed since the scan; inherited nodes write the local main component instead. The node's own link gets the new
// src (k is refreshed by a link-apply with the key name).
export async function applyTexts(items: readonly TextApplyItem[], now: number): Promise<OpOutcome> {
  const caches = createNodeCaches()
  const errors: NodeError[] = []
  const outcomes = new Map<string, "written" | NodeErrorCode>()
  let done = 0
  const ordered = mainsFirst(items)
  for (let index = 0; index < ordered.length; index++) {
    if (index > 0 && index % WRITE_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const item = ordered[index]
    const node = await getTextNode(item.nodeId)
    if (node === null) {
      errors.push(nodeError(item.nodeId, "node_not_found"))
      continue
    }
    try {
      // The layer itself is checked before an inherited write is redirected: an instance sublayer previewed on
      // its own shows its own record, and writing its main instead would leave the sublayer's stored original
      // stale, so reset would bring back the old text as an override (§7.14 pull, D23).
      if ((await shownPreview(node, caches)) !== null) {
        errors.push(nodeError(item.nodeId, "preview_active"))
        continue
      }
      // A pull never overwrites an edit made in Figma since the scan (SF6). A layer that already shows the new text
      // (an instance that follows a main component written earlier in this run) is written as usual.
      if (item.expectedSrc !== undefined) {
        const current = src(node.characters)
        if (current !== item.expectedSrc && current !== item.src) {
          errors.push(nodeError(item.nodeId, "changed_meanwhile"))
          continue
        }
      }
      const target = await writeTargetFor(node, readLinkInfo(node, caches), null)
      if ("error" in target) {
        errors.push(nodeError(item.nodeId, target.error))
        continue
      }
      // Several instance sublayers can redirect to one main component node: it is written once.
      let outcome = outcomes.get(target.node.id)
      if (outcome === undefined) {
        outcome = await pullNode(target.node, item, now, caches)
        outcomes.set(target.node.id, outcome)
      }
      if (outcome === "written" || outcome === "mixed_styles_flattened") {
        done++
      }
      if (outcome !== "written") {
        errors.push(nodeError(item.nodeId, outcome))
      }
    } catch (error) {
      errors.push(failureOf(item.nodeId, error))
    }
  }
  return { done, errors }
}

async function pullNode(node: TextNode, item: TextApplyItem, now: number, caches: NodeCaches): Promise<"written" | NodeErrorCode> {
  // A redirect target (the local main component) can be previewing too.
  if ((await shownPreview(node, caches)) !== null) {
    return "preview_active"
  }
  if (isBoundToVariable(node)) {
    return "bound_to_variable"
  }
  const segments = readSegments(node)
  await loadFontsOrFail(node, segments)
  const flattened = await writeTextKeepingStyles(node, item.text, segments)
  const parsed = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  if (parsed.kind === "link" && parsed.link.nid === node.id) {
    writeLink(node, createLink({ keyId: parsed.link.id, keyName: parsed.link.k, projectId: parsed.link.p, src: item.src, nodeId: node.id, now }))
  }
  return flattened ? "mixed_styles_flattened" : "written"
}
