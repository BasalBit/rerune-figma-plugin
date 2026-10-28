import type { FigmaLanguage } from "../../shared/api-types"
import type { NodeError, PreviewInfo, ResolveSource, ScannedNode, Scope } from "../../shared/messages"
import { isWarning, LANGUAGE_COPY_MESSAGES } from "../../shared/node-errors"
import type { OverflowItem, OverflowKind } from "../../shared/overflow"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { chunk, LONG_OP_IDLE_MS, runOp, WRITE_BATCH_SIZE } from "./ops"
import {
  buildPreview,
  buildPseudoPreview,
  previewKeyIds,
  previewTargets,
  resolveForPreview,
  type PreviewEntry,
  type PreviewRequest,
  type RenderChoices,
} from "./preview"
import type { ScanResult } from "./ops"

// QA (§7.18, Design mode): the overflow report (P3.3) and language copies (P3.4).
//
// Overflow report: for each picked language in turn, resolve → preview-apply → overflow-check → collect, then one
// preview-reset of every layer the report wrote, always (also after an error or Stop). Values longer than their
// key's max length come from E12 (`exceeds_max_length`) and are added UI-side as "max_length".
//
// Language copies: the top-level frames of the selection are copied once per language by main (language-copies),
// with the resolved text of every scanned layer in those frames; missing values keep the source text and are listed.

export const PSEUDO_LANGUAGE = "pseudo"

export type ReportKind = OverflowKind | "max_length"
export interface ReportRow { nodeId: string; kind: ReportKind; by: number }

export interface LanguageReport {
  lang: string                    // a project language code, or PSEUDO_LANGUAGE
  rows: ReportRow[]
  checked: number                 // layers measured in this language
  missing: number                 // linked layers without a value: they kept the source text and were not measured
  errors: NodeError[]             // layers preview-apply could not write (not measured)
}

export interface ReportNode { name: string; frameName: string | null; keyName: string | null }

export interface OverflowReport {
  scope: Scope
  source: ResolveSource
  variationOptionId: string | null
  languages: LanguageReport[]
  nodes: Map<string, ReportNode>
  truncatedScan: boolean
  stopped: "error" | "cancelled" | null
  error: string | null
  resetError: string | null
}

export interface OverflowRequest {
  scope: Scope
  languages: string[]
  source: ResolveSource
  variationOptionId: string | null
  projectId: string
  mainLanguage: string
}

export interface OverflowProgress { lang: string; index: number; total: number }

export interface QaDeps {
  bus: Pick<UiBus, "request">
  api: Pick<FigmaApi, "resolveKeys">
  scan(scope: Scope): Promise<ScanResult | null>
  scanError(): string | null
  keyNames(): ReadonlyMap<string, string>
  choicesFor(lang: string): RenderChoices
}

export interface OverflowDeps extends QaDeps {
  // Resets the previews on these layers (the app's preview-reset, so the edited-during-preview question works).
  reset(nodeIds: string[]): Promise<void>
  onProgress(progress: OverflowProgress): void
  shouldStop(): boolean
}

// A request QA does not run, with the layers to select on the canvas (the screen offers "Select on canvas").
export class QaRefusal extends Error {
  constructor(message: string, readonly nodeIds: string[] = []) {
    super(message)
    this.name = "QaRefusal"
  }
}

export const SCAN_FAILED = "The scan didn't finish. Try again."
export const NO_LANGUAGES = "Pick at least one language."
export const NO_LAYERS = "No text layers to check. Select layers, or choose Page."
export const PREVIEWING_SCOPE = "Layers in scope show a preview. Reset previews first."

const KIND_LABELS: Record<ReportKind, string> = {
  clipped: "Clipped",
  truncated: "Truncated",
  exceeds_parent: "Outside its frame",
  max_length: "Over max length",
}

export function kindLabel(kind: ReportKind): string {
  return KIND_LABELS[kind]
}

export function unitOf(kind: ReportKind): "px" | "characters" {
  return kind === "max_length" ? "characters" : "px"
}

export function amountText(row: Pick<ReportRow, "kind" | "by">): string {
  if (row.kind === "max_length") {
    return row.by === 1 ? "1 character too long" : row.by + " characters too long"
  }
  const px = String(row.by) + " px"
  switch (row.kind) {
    case "clipped":
      return px + " past its box"
    case "truncated":
      return px + " cut off"
    case "exceeds_parent":
      return px + " outside its frame"
  }
}

// "German (de)" for a project language, "Pseudo-localization" for the pseudo entry.
export function reportLanguageLabel(lang: string, languages: readonly Pick<FigmaLanguage, "code" | "name">[]): string {
  if (lang === PSEUDO_LANGUAGE) {
    return "Pseudo-localization"
  }
  const language = languages.find((entry) => entry.code === lang)
  return language !== undefined && language.name !== "" ? language.name + " (" + lang + ")" : lang
}

const PREVIEWING: PreviewInfo = { lang: "", source: "draft", variationOptionId: null, appliedAt: 0 }

// Layers an earlier language of the run wrote show that preview now: buildPreview then writes their original text
// where this language has no value, instead of leaving the previous language on the canvas.
export function markPreviewing(nodes: readonly ScannedNode[], written: ReadonlySet<string>): ScannedNode[] {
  return nodes.map((node) => (node.preview === null && written.has(node.nodeId) ? { ...node, preview: PREVIEWING } : node))
}

function reportNodes(nodes: readonly ScannedNode[], keyNames: ReadonlyMap<string, string>): Map<string, ReportNode> {
  const map = new Map<string, ReportNode>()
  for (const node of nodes) {
    const link = node.link
    map.set(node.nodeId, { name: node.name, frameName: node.frameName, keyName: link === null ? null : keyNames.get(link.id) ?? link.k })
  }
  return map
}

// preview-apply in batches; every id of a batch counts as written before it is sent (a batch that times out may
// still have been written). A layer main reports as failed loses that status only when this language added it: a
// failed write keeps the preview an earlier language of the run wrote (main puts its record back), so the final
// reset must still cover it.
async function applyTracked(
  bus: Pick<UiBus, "request">,
  info: Omit<PreviewInfo, "appliedAt">,
  items: readonly { nodeId: string; text: string }[],
  written: Set<string>,
): Promise<{ errors: NodeError[]; failed: Set<string> }> {
  const errors: NodeError[] = []
  const failed = new Set<string>()
  const added = new Set<string>()
  for (const batch of chunk(items, WRITE_BATCH_SIZE)) {
    for (const item of batch) {
      if (!written.has(item.nodeId)) {
        written.add(item.nodeId)
        added.add(item.nodeId)
      }
    }
    const result = await runOp(bus, (requestId) => ({ type: "preview-apply", requestId, info, items: batch }))
    for (const error of result.errors) {
      errors.push(error)
      if (!isWarning(error)) {
        failed.add(error.nodeId)
      }
    }
  }
  for (const nodeId of failed) {
    if (added.has(nodeId)) {
      written.delete(nodeId)
    }
  }
  return { errors, failed }
}

// overflow-check in batches of 200 layers, so each answer arrives within the bus watchdog.
export async function checkOverflow(bus: Pick<UiBus, "request">, nodeIds: readonly string[]): Promise<OverflowItem[]> {
  const items: OverflowItem[] = []
  for (const batch of chunk(nodeIds, WRITE_BATCH_SIZE)) {
    const answer = await bus.request((requestId) => ({ type: "overflow-check", requestId, nodeIds: batch }), {
      done: (message) => (message.type === "overflow-result" ? message.items : undefined),
    })
    items.push(...answer)
  }
  return items
}

async function checkLanguage(deps: OverflowDeps, request: OverflowRequest, nodes: readonly ScannedNode[], lang: string, written: Set<string>): Promise<LanguageReport> {
  const current = markPreviewing(nodes, written)
  let info: Omit<PreviewInfo, "appliedAt">
  let items: { nodeId: string; text: string }[]
  let measure: string[]
  let tooLong: ReportRow[] = []
  let missing = 0
  if (lang === PSEUDO_LANGUAGE) {
    const pseudo = buildPseudoPreview(current, request.mainLanguage)
    info = pseudo.info
    items = pseudo.items
    measure = items.map((item) => item.nodeId)
  } else {
    const previewRequest: PreviewRequest = { lang, mode: request.source, variationOptionId: request.variationOptionId }
    const resolved = await resolveForPreview(deps.api, request.projectId, previewKeyIds(current, request.projectId), previewRequest)
    const build = buildPreview(current, request.projectId, previewRequest, resolved, deps.keyNames(), deps.choicesFor(lang))
    info = build.info
    items = build.items
    missing = build.missing.length
    // Measured: layers that show this language's value (not the ones that went back to their original text).
    const showsValue = new Set(previewTargets(current, request.projectId).map((node) => node.nodeId))
    for (const entry of build.missing) {
      showsValue.delete(entry.nodeId)
    }
    measure = items.map((item) => item.nodeId).filter((nodeId) => showsValue.has(nodeId))
    tooLong = build.tooLong.map((entry) => ({ nodeId: entry.nodeId, kind: "max_length" as const, by: entry.length - entry.maxLength }))
  }
  const applied = await applyTracked(deps.bus, info, items, written)
  const ids = measure.filter((nodeId) => !applied.failed.has(nodeId))
  const overflow = ids.length === 0 ? [] : await checkOverflow(deps.bus, ids)
  return { lang, rows: [...overflow, ...tooLong], checked: ids.length, missing, errors: applied.errors.filter((error) => !isWarning(error)) }
}

// The overflow report (§7.18.1). Refused while layers in scope show a preview. Always ends with a reset of every
// layer it wrote, also after an error or Stop.
export async function runOverflowReport(deps: OverflowDeps, request: OverflowRequest): Promise<OverflowReport> {
  if (request.languages.length === 0) {
    throw new Error(NO_LANGUAGES)
  }
  const scanned = await deps.scan(request.scope)
  if (scanned === null) {
    throw new Error(deps.scanError() ?? SCAN_FAILED)
  }
  if (scanned.nodes.length === 0) {
    throw new Error(NO_LAYERS)
  }
  // The report starts from the original text: a layer that already shows a preview (its own, or instance text
  // following a previewed main component that may lie outside the scope) would be measured with that preview's text
  // and its owner reset at the end, although the report never wrote it.
  const previewing = scanned.nodes.filter((node) => node.preview !== null).map((node) => node.nodeId)
  if (previewing.length > 0) {
    throw new QaRefusal(PREVIEWING_SCOPE, previewing)
  }
  const report: OverflowReport = {
    scope: request.scope,
    source: request.source,
    variationOptionId: request.variationOptionId,
    languages: [],
    nodes: reportNodes(scanned.nodes, deps.keyNames()),
    truncatedScan: scanned.truncated,
    stopped: null,
    error: null,
    resetError: null,
  }
  const written = new Set<string>()
  try {
    for (let index = 0; index < request.languages.length; index++) {
      if (deps.shouldStop()) {
        report.stopped = "cancelled"
        break
      }
      const lang = request.languages[index]
      deps.onProgress({ lang, index, total: request.languages.length })
      report.languages.push(await checkLanguage(deps, request, scanned.nodes, lang, written))
    }
  } catch (error) {
    report.stopped = "error"
    report.error = userMessage(error)
  } finally {
    if (written.size > 0) {
      try {
        await deps.reset([...written])
      } catch (error) {
        report.resetError = userMessage(error)
      }
    }
  }
  return report
}

export function reportIssueCount(report: Pick<OverflowReport, "languages">): number {
  return report.languages.reduce((sum, language) => sum + language.rows.length, 0)
}

// CSV (RFC 4180, CRLF line ends): one row per finding. Cells a spreadsheet would run as a formula (=, +, -, @, tab,
// CR at the start) get a leading apostrophe.
export const CSV_HEADER = ["Language", "Issue", "Amount", "Unit", "Layer", "Frame", "Key", "Node ID"]

export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe
}

export function reportCsv(report: Pick<OverflowReport, "languages" | "nodes">, languageLabel: (lang: string) => string): string {
  const lines = [CSV_HEADER.map(csvCell).join(",")]
  for (const language of report.languages) {
    for (const row of language.rows) {
      const node = report.nodes.get(row.nodeId)
      lines.push(
        [languageLabel(language.lang), kindLabel(row.kind), String(row.by), unitOf(row.kind), node?.name ?? "", node?.frameName ?? "", node?.keyName ?? "", row.nodeId]
          .map(csvCell)
          .join(","),
      )
    }
  }
  return lines.join("\r\n") + "\r\n"
}

// ---------------------------------------------------------------------------------------------------------------
// Language copies (§7.18.4, D32).

export const NO_FRAMES = "Select one or more frames with text first."
export const PREVIEWING_FRAMES = "Layers in these frames show a preview. Reset previews first."

export interface CopiesRequest { languages: string[]; source: ResolveSource; variationOptionId: string | null; projectId: string }

export interface CopiesResult {
  frames: { id: string; name: string }[]
  languages: string[]
  made: number                                          // copies created
  framesCopied: number                                  // frames that got at least one copy
  written: number                                       // text layers written into the copies
  missing: { lang: string; entries: PreviewEntry[] }[]  // linked layers without a value (kept the source text)
  refused: NodeError[]                                  // frames that got no copies (errors on the frame's id)
  errors: NodeError[]                                   // layers of copies that kept the source text, and the
                                                        // languages Figma couldn't copy a frame for (frame's id)
  variableSkipped: number
  truncatedScan: boolean
}

export interface CopiesDeps extends QaDeps {
  onProgress(text: string): void
}

// The top-level frames of the selection, in scan order.
export function selectedFrames(nodes: readonly ScannedNode[]): { id: string; name: string }[] {
  const frames = new Map<string, string>()
  for (const node of nodes) {
    if (node.frameId !== null && !frames.has(node.frameId)) {
      frames.set(node.frameId, node.frameName ?? "")
    }
  }
  return [...frames].map(([id, name]) => ({ id, name }))
}

// Copies of a frame made by one language-copies message: none when the frame was refused as a whole (any error on
// the frame's id other than "Figma couldn't copy this frame."), else one per language minus the languages whose
// copy Figma refused.
export function copiesMade(frameId: string, languages: number, errors: readonly NodeError[]): number {
  const own = errors.filter((error) => error.nodeId === frameId)
  if (own.some((error) => error.message !== LANGUAGE_COPY_MESSAGES.failed)) {
    return 0
  }
  return Math.max(0, languages - own.length)
}

export async function makeLanguageCopies(deps: CopiesDeps, request: CopiesRequest): Promise<CopiesResult> {
  if (request.languages.length === 0) {
    throw new QaRefusal(NO_LANGUAGES)
  }
  const selection = await deps.scan("selection")
  if (selection === null) {
    throw new Error(deps.scanError() ?? SCAN_FAILED)
  }
  const frames = selectedFrames(selection.nodes)
  if (frames.length === 0) {
    throw new QaRefusal(NO_FRAMES)
  }
  // The whole frames, also when only some of their layers are selected.
  const page = await deps.scan("page")
  if (page === null) {
    throw new Error(deps.scanError() ?? SCAN_FAILED)
  }
  const frameIds = new Set(frames.map((frame) => frame.id))
  const texts = page.nodes.filter((node) => node.frameId !== null && frameIds.has(node.frameId))
  const previewing = texts.filter((node) => node.preview !== null).map((node) => node.nodeId)
  if (previewing.length > 0) {
    throw new QaRefusal(PREVIEWING_FRAMES, previewing)
  }
  const frameOf = new Map(texts.map((node) => [node.nodeId, node.frameId as string]))
  const result: CopiesResult = {
    frames,
    languages: request.languages.slice(),
    made: 0,
    framesCopied: 0,
    written: 0,
    missing: [],
    refused: [],
    errors: [],
    variableSkipped: 0,
    truncatedScan: page.truncated,
  }
  // Per frame and language, the texts to write.
  const byFrame = new Map<string, Map<string, { nodeId: string; text: string }[]>>()
  for (const lang of request.languages) {
    deps.onProgress("Loading " + lang + " values…")
    const previewRequest: PreviewRequest = { lang, mode: request.source, variationOptionId: request.variationOptionId }
    const resolved = await resolveForPreview(deps.api, request.projectId, previewKeyIds(texts, request.projectId), previewRequest)
    const build = buildPreview(texts, request.projectId, previewRequest, resolved, deps.keyNames(), deps.choicesFor(lang))
    if (build.missing.length > 0) {
      result.missing.push({ lang, entries: build.missing })
    }
    result.variableSkipped = build.skipped.variable.length
    for (const item of build.items) {
      const frameId = frameOf.get(item.nodeId)
      if (frameId === undefined) {
        continue
      }
      const perLanguage = byFrame.get(frameId) ?? new Map<string, { nodeId: string; text: string }[]>()
      byFrame.set(frameId, perLanguage)
      perLanguage.set(lang, [...(perLanguage.get(lang) ?? []), item])
    }
  }
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    deps.onProgress("Copying " + (frame.name === "" ? "frame" : frame.name) + " (" + (index + 1) + " of " + frames.length + ")…")
    const copies = request.languages.map((lang) => ({
      lang,
      source: request.source,
      variationOptionId: request.variationOptionId,
      texts: byFrame.get(frame.id)?.get(lang) ?? [],
    }))
    const outcome = await runOp(deps.bus, (requestId) => ({ type: "language-copies", requestId, frameIds: [frame.id], copies }), LONG_OP_IDLE_MS)
    const made = copiesMade(frame.id, request.languages.length, outcome.errors)
    result.written += outcome.done
    result.made += made
    if (made > 0) {
      result.framesCopied++
    }
    // A frame that got no copy is refused; one copy Figma couldn't make of a frame that got others is a problem
    // of that frame, so the summary still counts the frame.
    for (const error of outcome.errors) {
      if (error.nodeId === frame.id && made === 0) {
        result.refused.push(error)
      } else {
        result.errors.push(error)
      }
    }
  }
  return result
}
