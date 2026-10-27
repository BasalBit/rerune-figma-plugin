import {
  DATA_KEYS,
  PLUGIN_DATA_NAMESPACE,
  SCAN_BATCH_SIZE,
  SCAN_MAX_NODES,
  SCAN_YIELD_EVERY_CHILDREN,
  SCAN_YIELD_EVERY_ROOTS,
  SCAN_YIELD_EVERY_TEXTS,
} from "../shared/constants"
import type { MainToUi, MainToUiOf, RequestId, ScannedNode, Scope } from "../shared/messages"
import { ownPreviewRecord, previewInfoOf, type PreviewRecord } from "../shared/plugin-data"
import { isNumericOnly, normalizeDesignText } from "../shared/text"
import { readLinkInfo } from "./links"
import {
  componentNameOf,
  createNodeCaches,
  isBoundToComponentProperty,
  isBoundToVariable,
  isHidden,
  isInLanguageCopy,
  isLocked,
  pageOf,
  parentNamesOf,
  topFrameOf,
  yieldToCanvas,
  type NodeCaches,
} from "./node-utils"
import { readFileSettings } from "./settings"

export type SkipCounts = MainToUiOf<"scan-done">["skipped"]
export type SkipReason = keyof SkipCounts
export interface ScanFilters { ignoreUnderscoreLayers: boolean; includeLocked: boolean }

export function emptySkipCounts(): SkipCounts {
  return { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
}

export function scanFilters(): ScanFilters {
  const settings = readFileSettings().settings
  return { ignoreUnderscoreLayers: settings?.ignoreUnderscoreLayers ?? true, includeLocked: settings?.includeLocked ?? false }
}

function readPreview(node: TextNode): PreviewRecord | null {
  return ownPreviewRecord(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview), node.id)
}

function mixedStylesOf(node: TextNode, characters: string): boolean {
  if (characters.length === 0) {
    return false
  }
  return node.getStyledTextSegments(["fontName", "fontSize", "fills"]).length > 1
}

// Maps a TEXT node to the wire shape (§7.5). `characters` is read once by the caller and passed in.
export async function describeTextNode(node: TextNode, caches: NodeCaches, characters: string = node.characters, preview: PreviewRecord | null = readPreview(node)): Promise<ScannedNode> {
  const info = readLinkInfo(node, caches)
  const page = pageOf(node)
  const frame = topFrameOf(node)
  const maxLines = (node as { maxLines?: number | null }).maxLines
  return {
    nodeId: node.id,
    name: node.name,
    characters,
    originalCharacters: preview === null ? null : preview.characters,
    pageId: page === null ? "" : page.id,
    pageName: page === null ? "" : page.name,
    frameId: frame === null ? null : frame.id,
    frameName: frame === null ? null : frame.name,
    parentNames: parentNamesOf(node),
    componentName: await componentNameOf(node, caches),
    isInstanceSublayer: node.id.charAt(0) === "I",
    link: info.link,
    linkState: info.state,
    preview: preview === null ? null : previewInfoOf(preview),
    hasMissingFont: node.hasMissingFont === true,
    mixedStyles: mixedStylesOf(node, characters),
    boundToComponentProperty: isBoundToComponentProperty(node),
    boundToVariable: isBoundToVariable(node),
    autoRename: node.autoRename,
    textOverridden: info.textOverridden,
    width: node.width,
    height: node.height,
    textAutoResize: node.textAutoResize,
    textTruncation: node.textTruncation,
    maxLines: maxLines === undefined ? null : maxLines,
  }
}

// Filters of §7.9, in order; returns the skip reason or the scanned node.
export async function scanTextNode(node: TextNode, caches: NodeCaches, filters: ScanFilters): Promise<ScannedNode | SkipReason> {
  if (isHidden(node, caches)) {
    return "hidden"
  }
  if (!filters.includeLocked && isLocked(node, caches)) {
    return "locked"
  }
  const characters = node.characters
  const preview = readPreview(node)
  const text = normalizeDesignText(preview === null ? characters : preview.characters)
  if (text === "") {
    return "empty"
  }
  if (isNumericOnly(text)) {
    return "numeric"
  }
  if (filters.ignoreUnderscoreLayers && node.name.startsWith("_")) {
    return "underscore"
  }
  if (isInLanguageCopy(node, caches)) {
    return "languageCopy"
  }
  return describeTextNode(node, caches, characters, preview)
}

function childrenOf(node: BaseNode): readonly SceneNode[] {
  return "children" in node ? (node as BaseNode & ChildrenMixin).children : []
}

export interface Scanner {
  start(requestId: RequestId, scope: Scope): Promise<void>
  cancel(requestId: RequestId): void
}

// Chunked scanning (§7.9): per-child findAllWithCriteria, setTimeout(0) yields, batches of 100, a generation
// token for cancellation, and per-node try/catch because the canvas stays editable while a scan runs.
export function createScanner(send: (message: MainToUi) => void): Scanner {
  let generation = 0
  let activeRequestId: RequestId | null = null

  return {
    cancel(requestId) {
      if (activeRequestId === requestId) {
        generation++
        activeRequestId = null
      }
    },
    async start(requestId, scope) {
      const mine = ++generation
      activeRequestId = requestId
      const stale = () => mine !== generation
      const filters = scanFilters()
      const caches = createNodeCaches()
      const skipped = emptySkipCounts()
      const seen = new Set<string>()
      let batch: ScannedNode[] = []
      let total = 0
      let scanned = 0
      let truncated = false

      const flush = () => {
        if (batch.length > 0) {
          send({ type: "scan-batch", requestId, nodes: batch })
          batch = []
        }
      }
      const pause = async (): Promise<boolean> => {
        send({ type: "scan-progress", requestId, scanned })
        await yieldToCanvas()
        return !stale()
      }

      const page = figma.currentPage
      let roots: readonly SceneNode[]
      if (scope === "selection") {
        roots = page.selection.slice()
      } else {
        await page.loadAsync()
        if (stale()) {
          return
        }
        roots = page.children.slice()
      }

      outer: for (let r = 0; r < roots.length; r++) {
        if (r > 0 && r % SCAN_YIELD_EVERY_ROOTS === 0 && !(await pause())) {
          return
        }
        const root = roots[r]
        const texts: TextNode[] = []
        try {
          if (root.removed) {
            continue
          }
          if (root.type === "TEXT") {
            texts.push(root)
          }
          const children = childrenOf(root)
          for (let c = 0; c < children.length; c++) {
            if (c > 0 && c % SCAN_YIELD_EVERY_CHILDREN === 0) {
              await yieldToCanvas()
              if (stale()) {
                return
              }
            }
            const child = children[c]
            if (child.removed) {
              continue
            }
            if (child.type === "TEXT") {
              texts.push(child)
            } else if ("findAllWithCriteria" in child) {
              texts.push(...child.findAllWithCriteria({ types: ["TEXT"] }))
            }
          }
        } catch {
          skipped.unavailable++
          continue
        }

        for (let t = 0; t < texts.length; t++) {
          if (t > 0 && t % SCAN_YIELD_EVERY_TEXTS === 0 && !(await pause())) {
            return
          }
          const text = texts[t]
          try {
            if (text.removed) {
              skipped.unavailable++
              continue
            }
            if (seen.has(text.id)) {
              continue
            }
            seen.add(text.id)
            if (total >= SCAN_MAX_NODES) {
              truncated = true
              break outer
            }
            scanned++
            const result = await scanTextNode(text, caches, filters)
            if (typeof result === "string") {
              skipped[result]++
              continue
            }
            batch.push(result)
            total++
            if (batch.length >= SCAN_BATCH_SIZE) {
              flush()
            }
          } catch {
            skipped.unavailable++
          }
        }
        if (stale()) {
          return
        }
      }

      if (stale()) {
        return
      }
      flush()
      activeRequestId = null
      send({ type: "scan-done", requestId, total, truncated, skipped })
    },
  }
}
