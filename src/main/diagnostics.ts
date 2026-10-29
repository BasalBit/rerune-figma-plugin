import { DATA_KEYS, DIAGNOSTICS_MAX_FRAMES, DIAGNOSTICS_MAX_NODES, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { imageSize, type ImageSize } from "../shared/image-size"
import type { ReadDiagnostic, WriteDiagnostic } from "../shared/messages"
import { classifyLink, createLink, parseDiagMarker, parseLink, resolveFileSettings, serializeDiagMarker, serializeLink } from "../shared/plugin-data"
import { errorText } from "./bus"
import { loadNodeFonts, nodeFonts } from "./fonts"
import { readLinkInfo } from "./links"
import {
  collectTextNodes,
  createNodeCaches,
  instanceAncestorsOf,
  isBoundToComponentProperty,
  isBoundToVariable,
  isTextNode,
  overrideFlags,
  pageOf,
  readOverrides,
  yieldToCanvas,
} from "./node-utils"
import { exportFrameImage, exportPlan, hasOpaqueBackground, type ExportConstraint } from "./screenshots"
import { settingsReportEntry, syncPauseOf } from "./settings"
import { countPagePreviews, SEGMENT_FIELDS, readSegments, restoreOriginal, type StyleSegment } from "./text-write"

// Phase 0 spike folded into the plugin (§7.21). Each test returns a JSON-friendly report; the UI shows it with
// "Copy report". T6 runs in the codegen diagnostics language (codegen.ts).

export interface DiagnosticsContext {
  env: "production" | "development"
  apiBase: string
  startup: { skipInvisibleInstanceChildren: boolean; command: string }
}

const MAX_INSTANCES = 20
const MAX_SUBLAYERS = 200
const MAX_FONT_NODES = 20
const MAX_SAMPLE_BYTES = 5000000
const FRAME_LIKE = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]

type Report = Record<string, unknown>

function selection(): readonly SceneNode[] {
  return figma.currentPage.selection
}

async function selectedTexts(limit: number): Promise<{ nodes: TextNode[]; truncated: boolean }> {
  const all = (await collectTextNodes(selection())) ?? []
  return { nodes: all.slice(0, limit), truncated: all.length > limit }
}

function selectedInstances(): InstanceNode[] {
  return selection().filter((node): node is InstanceNode => node.type === "INSTANCE").slice(0, MAX_INSTANCES)
}

function idPatternInherited(nodeId: string, nid: string): boolean {
  return nodeId.charAt(0) === "I" && nodeId.endsWith(";" + nid.replace(/^I/, ""))
}

// T1-mark: diag marker {nid, t} on the selected text nodes.
function t1Mark(texts: TextNode[], truncated: boolean, now: number): Report {
  const nodes: { nodeId: string; name: string }[] = []
  const failed: { nodeId: string; error: string }[] = []
  for (const node of texts) {
    try {
      node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag, serializeDiagMarker({ v: 1, nid: node.id, t: now }))
      nodes.push({ nodeId: node.id, name: node.name })
    } catch (error) {
      failed.push({ nodeId: node.id, error: errorText(error) })
    }
  }
  return { test: "T1-mark", markedAt: now, marked: nodes.length, nodes, failed, truncated }
}

// T1-check: every diag marker on the current page, plus how many the criteria fast path finds.
async function t1Check(): Promise<Report> {
  const page = figma.currentPage
  await page.loadAsync()
  const criteria = page.findAllWithCriteria({ types: ["TEXT"], sharedPluginData: { namespace: PLUGIN_DATA_NAMESPACE, keys: [DATA_KEYS.diag] } })
  const criteriaIds = new Set(criteria.map((node) => node.id))
  const texts = (await collectTextNodes(page.children)) ?? []
  const rows: Report[] = []
  for (const node of texts) {
    let raw: string
    try {
      raw = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag)
    } catch (error) {
      rows.push({ nodeId: node.id, error: errorText(error) })
      continue
    }
    if (raw === "") {
      continue
    }
    const marker = parseDiagMarker(raw)
    rows.push(
      marker === null
        ? { nodeId: node.id, name: node.name, invalid: raw.slice(0, 200) }
        : {
            nodeId: node.id,
            nid: marker.nid,
            sameId: marker.nid === node.id,
            instancePattern: idPatternInherited(node.id, marker.nid),
            name: node.name,
            markedAt: marker.t,
            matchedByCriteria: criteriaIds.has(node.id),
          },
    )
  }
  return {
    test: "T1-check",
    fileName: figma.root.name,
    pageId: page.id,
    pageName: page.name,
    textNodes: texts.length,
    found: rows.length,
    criteriaMatches: criteria.length,
    nodes: rows.slice(0, DIAGNOSTICS_MAX_NODES),
    truncated: rows.length > DIAGNOSTICS_MAX_NODES,
  }
}

async function mainComponentInfo(instance: InstanceNode): Promise<Report | null> {
  try {
    const main = await instance.getMainComponentAsync()
    return main === null ? null : { id: main.id, name: main.name, remote: main.remote, parentType: main.parent === null ? null : main.parent.type }
  } catch (error) {
    return { error: errorText(error) }
  }
}

// T2-instances: inherited link data on instance sublayers, the criteria filter, ids and overrides.
async function t2Instances(): Promise<Report> {
  const instances = selectedInstances()
  if (instances.length === 0) {
    return { test: "T2-instances", error: "Select one or more instances (also a nested instance and an instance of a library component)." }
  }
  const reports: Report[] = []
  for (const instance of instances) {
    const caches = createNodeCaches()
    const texts = instance.findAllWithCriteria({ types: ["TEXT"] })
    const matched = instance.findAllWithCriteria({ types: ["TEXT"], sharedPluginData: { namespace: PLUGIN_DATA_NAMESPACE, keys: [DATA_KEYS.link] } })
    const matchedIds = new Set(matched.map((node) => node.id))
    const ancestors = new Map<string, InstanceNode>([[instance.id, instance]])
    const sublayers = texts.slice(0, MAX_SUBLAYERS).map((node) => {
      for (const ancestor of instanceAncestorsOf(node)) {
        ancestors.set(ancestor.id, ancestor)
      }
      const raw = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)
      const parsed = parseLink(raw)
      const flags = overrideFlags(node, caches)
      return {
        nodeId: node.id,
        name: node.name,
        hasLinkData: raw !== "",
        nid: parsed.kind === "link" ? parsed.link.nid : null,
        key: parsed.kind === "link" ? parsed.link.k : null,
        ownPluginDataOverride: flags.ownPluginDataOverride,
        textOverridden: flags.textOverridden,
        classification: parsed.kind === "link" ? classifyLink(node.id, parsed.link.nid, flags.ownPluginDataOverride, flags.textOverridden) : parsed.kind,
        idPatternInherited: parsed.kind === "link" ? idPatternInherited(node.id, parsed.link.nid) : null,
        matchedByCriteria: matchedIds.has(node.id),
      }
    })
    const overrides = [...ancestors.values()].map((ancestor) => ({ instanceId: ancestor.id, name: ancestor.name, overrides: readOverrides(ancestor, caches) }))
    reports.push({
      instanceId: instance.id,
      name: instance.name,
      mainComponent: await mainComponentInfo(instance),
      textCount: texts.length,
      criteriaCount: matched.length,
      sublayers,
      truncated: texts.length > MAX_SUBLAYERS,
      overrides,
    })
  }
  return { test: "T2-instances", instances: reports }
}

function overridesFor(node: BaseNode): Report[] {
  const caches = createNodeCaches()
  return instanceAncestorsOf(node).map((instance) => {
    const list = readOverrides(instance, caches)
    return { instanceId: instance.id, entry: list === null ? "unreadable" : (list.find((item) => item.id === node.id) ?? null) }
  })
}

// T2-clear: does "" clear inherited data, and is a sublayer write listed as a pluginData override?
async function t2Clear(now: number): Promise<Report> {
  const caches = createNodeCaches()
  let target: TextNode | null = null
  for (const instance of selectedInstances()) {
    for (const node of instance.findAllWithCriteria({ types: ["TEXT"] })) {
      if (readLinkInfo(node, caches).state === "inherited") {
        target = node
        break
      }
    }
    if (target !== null) {
      break
    }
  }
  if (target === null) {
    return { test: "T2-clear", error: "Select an instance whose main component has a linked text layer." }
  }
  const before = readLinkInfo(target, caches)
  const inherited = before.link
  target.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, "")
  const afterClear = target.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)
  const overridesAfterClear = overridesFor(target)
  // Two undo steps (TESTING.md T2: "then undo twice"): the clear, then the own-link write (the bus commits it).
  figma.commitUndo()
  let writeError: string | null = null
  if (inherited !== null) {
    try {
      const own = createLink({ keyId: inherited.id, keyName: inherited.k, projectId: inherited.p, src: inherited.src, nodeId: target.id, now })
      target.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(own))
    } catch (error) {
      writeError = errorText(error)
    }
  }
  const overridesAfterWrite = overridesFor(target)
  const after = readLinkInfo(target, createNodeCaches())
  return {
    test: "T2-clear",
    nodeId: target.id,
    name: target.name,
    inheritedNid: inherited === null ? null : inherited.nid,
    clearWithEmptyString: { readBack: afterClear, cleared: afterClear === "", overrides: overridesAfterClear },
    ownLinkWrite: {
      error: writeError,
      overrides: overridesAfterWrite,
      listedAsPluginDataOverride: overridesAfterWrite.some((entry) => {
        const listed = entry.entry as { overriddenFields?: string[] } | null | "unreadable"
        return listed !== null && listed !== "unreadable" && (listed.overriddenFields ?? []).includes("pluginData")
      }),
      stateAfter: after.state,
    },
    note: "The sublayer now carries its own link. Undo in Figma to revert.",
  }
}

function decodedMatches(decoded: ImageSize | null, width: number, height: number): boolean | null {
  return decoded === null ? null : Math.abs(decoded.width - width) <= 1 && Math.abs(decoded.height - height) <= 1
}

type Exportable = SceneNode & ExportMixin & { absoluteBoundingBox: Rect | null; absoluteRenderBounds: Rect | null; opacity?: number; fills?: unknown }

function firstExportable(): Exportable | null {
  for (const node of selection()) {
    if ("exportAsync" in node && "absoluteBoundingBox" in node) {
      return node as Exportable
    }
  }
  return null
}

// T3-export: useAbsoluteBounds true/false × JPG/PNG × SCALE/WIDTH, decoded size vs the bounds.
async function t3Export(): Promise<Report> {
  const frame = firstExportable()
  if (frame === null) {
    return { test: "T3-export", error: "Select a frame." }
  }
  const page = pageOf(frame)
  if (page !== null) {
    await page.loadAsync()
  }
  const bounds = frame.absoluteBoundingBox
  const render = frame.absoluteRenderBounds
  if (bounds === null) {
    return { test: "T3-export", frameId: frame.id, error: "The frame has no bounds." }
  }
  const halfWidth = Math.max(1, Math.round(bounds.width / 2))
  const exports: Report[] = []
  let sample: Uint8Array | null = null
  for (const format of ["JPG", "PNG"] as const) {
    for (const useAbsoluteBounds of [true, false]) {
      for (const constraint of [{ type: "SCALE", value: 1 }, { type: "WIDTH", value: halfWidth }] as ExportConstraint[]) {
        const area = useAbsoluteBounds || render === null ? bounds : render
        const scale = constraint.type === "SCALE" ? constraint.value : constraint.value / area.width
        const expected = { width: Math.round(area.width * scale), height: Math.round(area.height * scale) }
        const started = Date.now()
        try {
          const bytes = await frame.exportAsync({ format, constraint, useAbsoluteBounds, colorProfile: "SRGB" })
          const decoded = imageSize(bytes)
          exports.push({ format, useAbsoluteBounds, constraint, bytes: bytes.length, ms: Date.now() - started, decoded, expected, matches: decodedMatches(decoded, expected.width, expected.height) })
          if (format === "JPG" && useAbsoluteBounds && constraint.type === "SCALE" && bytes.length <= MAX_SAMPLE_BYTES) {
            sample = bytes
          }
        } catch (error) {
          exports.push({ format, useAbsoluteBounds, constraint, ms: Date.now() - started, error: errorText(error) })
        }
      }
    }
  }
  return {
    test: "T3-export",
    frameId: frame.id,
    frameName: frame.name,
    absoluteBoundingBox: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    absoluteRenderBounds: render === null ? null : { x: render.x, y: render.y, width: render.width, height: render.height },
    opaqueBackground: hasOpaqueBackground(frame),
    plan: exportPlan(bounds),
    exports,
    // The UI decodes this JPG to read the corner pixel colour (transparent frames), then drops it from the copied report.
    jpgSample: sample,
  }
}

function topFrames(nodes: readonly SceneNode[], out: SceneNode[]): void {
  for (const node of nodes) {
    if (out.length >= DIAGNOSTICS_MAX_FRAMES) {
      return
    }
    if (node.type === "SECTION") {
      topFrames(node.children, out)
    } else if (FRAME_LIKE.includes(node.type)) {
      out.push(node)
    }
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

// T4-export-page: every top-level frame on the page (≤ 100) with the §7.16 rules.
async function t4ExportPage(): Promise<Report> {
  const page = figma.currentPage
  await page.loadAsync()
  const frames: SceneNode[] = []
  topFrames(page.children, frames)
  const started = Date.now()
  const rows: Report[] = []
  const sizes: number[] = []
  for (let index = 0; index < frames.length; index++) {
    if (index > 0) {
      await yieldToCanvas()
    }
    const frame = frames[index] as Exportable
    const frameStarted = Date.now()
    try {
      const result = await exportFrameImage(frame)
      if (result.ok) {
        sizes.push(result.bytes.length)
        const decoded = imageSize(result.bytes)
        rows.push({ frameId: frame.id, name: frame.name, format: result.format, bytes: result.bytes.length, scale: result.scale, attempts: result.attempts, expected: { width: result.width, height: result.height }, decoded, matches: decodedMatches(decoded, result.width, result.height), ms: Date.now() - frameStarted })
      } else {
        rows.push({ frameId: frame.id, name: frame.name, skipped: result.reason, ms: Date.now() - frameStarted })
      }
    } catch (error) {
      rows.push({ frameId: frame.id, name: frame.name, error: errorText(error), ms: Date.now() - frameStarted })
    }
  }
  return {
    test: "T4-export-page",
    pageId: page.id,
    pageName: page.name,
    frames: frames.length,
    exported: sizes.length,
    totalMs: Date.now() - started,
    averageBytes: sizes.length === 0 ? 0 : Math.round(sizes.reduce((sum, value) => sum + value, 0) / sizes.length),
    maxBytes: sizes.length === 0 ? 0 : Math.max(...sizes),
    p95Bytes: percentile(sizes, 0.95),
    reexported: rows.filter((row) => typeof row.attempts === "number" && row.attempts > 1).length,
    rows,
  }
}

// T5-fonts: fonts, write "<text> ✓", restore with the reset routine, compare every segment field.
async function t5Fonts(): Promise<Report> {
  const { nodes, truncated } = await selectedTexts(MAX_FONT_NODES)
  if (nodes.length === 0) {
    return { test: "T5-fonts", error: "Select text layers (include a style-bound, a hyperlinked and a variable-bound text)." }
  }
  const rows: Report[] = []
  for (const node of nodes) {
    const row: Report = {
      nodeId: node.id,
      name: node.name,
      hasMissingFont: node.hasMissingFont,
      boundToVariable: isBoundToVariable(node),
      boundToComponentProperty: isBoundToComponentProperty(node),
      textOverriddenBefore: overrideFlags(node, createNodeCaches()).textOverridden,
    }
    rows.push(row)
    try {
      row.fonts = nodeFonts(node)
    } catch (error) {
      row.fonts = errorText(error)
    }
    if (node.hasMissingFont) {
      row.skipped = "missing_font"
      continue
    }
    const before: StyleSegment[] = readSegments(node)
    const loadStarted = Date.now()
    try {
      await loadNodeFonts(node, before)
      row.loadMs = Date.now() - loadStarted
    } catch (error) {
      row.loadError = errorText(error)
      continue
    }
    if (row.boundToVariable === true) {
      row.skipped = "bound_to_variable"
      continue
    }
    const characters = node.characters
    const autoRename = node.autoRename
    try {
      node.autoRename = false
      node.characters = characters + " ✓"
      row.writeOk = true
    } catch (error) {
      row.writeOk = false
      row.writeError = errorText(error)
      node.autoRename = autoRename
      continue
    }
    row.restoreFailures = await restoreOriginal(node, { characters, segments: before })
    node.autoRename = autoRename
    const after = readSegments(node)
    const exact: Record<string, boolean> = {}
    for (const field of SEGMENT_FIELDS) {
      const pick = (segments: StyleSegment[]) => JSON.stringify(segments.map((segment) => [segment.start, segment.end, segment[field]]))
      exact[field] = pick(before) === pick(after)
    }
    row.textRestored = node.characters === characters
    row.exact = exact
    row.segmentsBefore = before
    row.segmentsAfter = after
    row.textOverriddenAfter = overrideFlags(node, createNodeCaches()).textOverridden
  }
  return { test: "T5-fonts", nodes: rows, truncated }
}

function readFileData(node: BaseNode): { raw: string; error: string | null } {
  try {
    return { raw: node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file), error: null }
  } catch (error) {
    return { raw: "", error: errorText(error) }
  }
}

// T7-settings: `file` on root and on every page, plus the resolution for the current page (the UI uses
// `current.differ` for "Repair settings" and `current.offerMirror` for the page mirror offer, §7.7) and whether
// link sync and screenshot upload are paused for it (no file link, branch, suspected copy; D43). The UI reads it when
// it opens, on page changes and after resets, so `current.previews` (text layers on the page that own a preview
// record) also tells it about previews its scan does not cover, such as those of a report the plugin was closed in.
function t7Settings(): Report {
  const root = readFileData(figma.root)
  const pages = figma.root.children.map((page) => {
    const data = readFileData(page)
    return { pageId: page.id, name: page.name, current: page.id === figma.currentPage.id, ...settingsReportEntry(data.raw), equalToRoot: data.raw !== "" && data.raw === root.raw, error: data.error }
  })
  const currentRaw = readFileData(figma.currentPage).raw
  const resolved = resolveFileSettings(root.raw, currentRaw)
  return {
    test: "T7-settings",
    fileName: figma.root.name,
    root: { ...settingsReportEntry(root.raw), error: root.error },
    pages,
    current: {
      pageId: figma.currentPage.id,
      source: resolved.source,
      differ: resolved.differ,
      offerMirror: resolved.offerMirror,
      settings: resolved.settings,
      syncPause: syncPauseOf(resolved.settings, figma.root.name),
      previews: countPagePreviews(),
    },
  }
}

// T8-relaunch: relaunch data on the selection; the user checks the button in Design and Dev Mode.
function t8Relaunch(): Report {
  const nodes = selection().slice(0, DIAGNOSTICS_MAX_NODES).map((node) => {
    try {
      node.setRelaunchData({ open: "ReRune diagnostics: relaunch button test" })
      return { nodeId: node.id, name: node.name, ok: true }
    } catch (error) {
      return { nodeId: node.id, name: node.name, ok: false, error: errorText(error) }
    }
  })
  return { test: "T8-relaunch", set: nodes.filter((node) => node.ok).length, nodes, hint: "Look for the Open ReRune button in the right sidebar in Figma Design and in Dev Mode." }
}

// T11-style-overrides: per selected text, its text style and the overrides Figma counts on top of it (the "(1)"
// after a style name in the sidebar). Read only.
async function t11StyleOverrides(): Promise<Report> {
  const { nodes, truncated } = await selectedTexts(MAX_FONT_NODES)
  if (nodes.length === 0) {
    return { test: "T11-style-overrides", error: "Select text layers that use a text style." }
  }
  const rows: Report[] = []
  for (const node of nodes) {
    const row: Report = { nodeId: node.id, name: node.name, characters: node.characters.length }
    rows.push(row)
    try {
      const segments = node.getStyledTextSegments(["textStyleId", "textStyleOverrides", "hyperlink", "textDecoration", "fontName"])
      const styles: Report[] = []
      for (const segment of segments) {
        const style = segment.textStyleId === "" ? null : await figma.getStyleByIdAsync(segment.textStyleId)
        styles.push({
          start: segment.start,
          end: segment.end,
          textStyleId: segment.textStyleId,
          styleName: style?.name ?? null,
          textStyleOverrides: segment.textStyleOverrides,
          hyperlink: segment.hyperlink,
          textDecoration: segment.textDecoration,
          fontName: segment.fontName,
        })
      }
      row.segments = styles
    } catch (error) {
      row.error = errorText(error)
    }
  }
  return { test: "T11-style-overrides", nodes: rows, truncated }
}

function t10Environment(context: DiagnosticsContext): Report {
  return {
    test: "T10-environment",
    editorType: figma.editorType,
    mode: figma.mode,
    command: figma.command,
    startupCommand: context.startup.command,
    vscode: figma.vscode !== undefined,
    apiVersion: figma.apiVersion,
    skipInvisibleInstanceChildrenDefault: context.startup.skipInvisibleInstanceChildren,
    skipInvisibleInstanceChildrenNow: figma.skipInvisibleInstanceChildren,
    fileName: figma.root.name,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pluginVersion: __PLUGIN_VERSION__,
    env: context.env,
    apiBase: context.apiBase,
  }
}

export async function runReadDiagnostic(test: ReadDiagnostic, context: DiagnosticsContext): Promise<Report> {
  switch (test) {
    case "T1-check":
      return t1Check()
    case "T2-instances":
      return t2Instances()
    case "T3-export":
      return t3Export()
    case "T4-export-page":
      return t4ExportPage()
    case "T7-settings":
      return t7Settings()
    case "T10-environment":
      return t10Environment(context)
    case "T11-style-overrides":
      return t11StyleOverrides()
  }
}

export async function runWriteDiagnostic(test: WriteDiagnostic, now: number): Promise<Report> {
  switch (test) {
    case "T1-mark": {
      const { nodes, truncated } = await selectedTexts(DIAGNOSTICS_MAX_NODES)
      return t1Mark(nodes, truncated, now)
    }
    case "T2-clear":
      return t2Clear(now)
    case "T5-fonts":
      return t5Fonts()
    case "T8-relaunch":
      return t8Relaunch()
  }
}

// T9 (Dev Mode, development builds): is setSharedPluginData allowed in Dev Mode? Cleans up when it is.
export function runDevModeProbe(now: number): Report {
  const node = selection()[0]
  if (node === undefined) {
    return { test: "T9-devmode-write", error: "Select a layer." }
  }
  try {
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag, serializeDiagMarker({ v: 1, nid: node.id, t: now }))
    const readBack = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag)
    let cleanupError: string | null = null
    try {
      node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag, "")
    } catch (error) {
      cleanupError = errorText(error)
    }
    return { test: "T9-devmode-write", nodeId: node.id, isText: isTextNode(node), allowed: true, error: null, readBack, cleanupError }
  } catch (error) {
    return { test: "T9-devmode-write", nodeId: node.id, isText: isTextNode(node), allowed: false, error: errorText(error) }
  }
}
