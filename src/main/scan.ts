import {
  SCAN_BATCH_SIZE,
  SCAN_MAX_NODES,
  SCAN_YIELD_EVERY_CHILDREN,
  SCAN_YIELD_EVERY_ROOTS,
  SCAN_YIELD_EVERY_TEXTS,
} from "../shared/constants"
import type { MainToUi, MainToUiOf, RequestId, ScannedNode, Scope } from "../shared/messages"
import { previewInfoOf } from "../shared/plugin-data"
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
import { isExportable } from "./screenshots"
import { readFileSettings } from "./settings"
import { shownPreview, type ShownPreview } from "./shown-preview"

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

function mixedStylesOf(node: TextNode, characters: string): boolean {
  if (characters.length === 0) {
    return false
  }
  return node.getStyledTextSegments(["fontName", "fontSize", "fills"]).length > 1
}

// Maps a TEXT node to the wire shape (§7.5). `characters` is read once by the caller and passed in. `shown` is
// the preview the node shows: its own record, or the record of the main component its instance text follows
// (originalCharacters is then the main's original text, so sync and push never see preview text, D23).
export async function describeTextNode(node: TextNode, caches: NodeCaches, characters: string = node.characters, shown?: ShownPreview | null): Promise<ScannedNode> {
  const preview = shown === undefined ? await shownPreview(node, caches) : shown
  const info = readLinkInfo(node, caches)
  const page = pageOf(node)
  const frame = topFrameOf(node)
  const maxLines = (node as { maxLines?: number | null }).maxLines
  return {
    nodeId: node.id,
    name: node.name,
    characters,
    originalCharacters: preview === null ? null : preview.record.characters,
    pageId: page === null ? "" : page.id,
    pageName: page === null ? "" : page.name,
    frameId: frame === null ? null : frame.id,
    frameName: frame === null ? null : frame.name,
    parentNames: parentNamesOf(node),
    componentName: await componentNameOf(node, caches),
    isInstanceSublayer: node.id.charAt(0) === "I",
    link: info.link,
    linkState: info.state,
    preview: preview === null ? null : previewInfoOf(preview.record),
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
  const preview = await shownPreview(node, caches)
  const text = normalizeDesignText(preview === null ? characters : preview.record.characters)
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
  // With `frameIds` (screenshot freshness, the frames ReRune asks new screenshots of; or text layers by id, the layers
  // of a Push review) the roots are those nodes and `scope` is ignored.
  start(requestId: RequestId, scope: Scope, frameIds?: readonly string[]): Promise<void>
  cancel(requestId: RequestId): void
}

interface FrameRoots { roots: SceneNode[]; ids: string[]; missing: Set<string>; hidden: Set<string> }

// The roots of a scan of requested frames (contract §6.4 step 2): each frame by id, its page loaded first (the
// frames can be on any page). A frame that resolves to null, was removed or cannot be exported is missing. A hidden
// frame (or one in a hidden section) is not scanned: its texts are all hidden, and its upload would replace the
// frame's boxes with none. A page that fails to load leaves its frame in: reading it then counts as unavailable, and
// its export reports the problem. null: the scan went stale meanwhile. `touch` runs after each lookup and page load,
// so the UI's idle watchdog (30 s) sees progress while many pages load.
async function frameRoots(frameIds: readonly string[], stale: () => boolean, caches: NodeCaches, touch: () => void): Promise<FrameRoots | null> {
  const roots: SceneNode[] = []
  const ids: string[] = []
  const missing = new Set<string>()
  const hidden = new Set<string>()
  const loaded = new Set<string>()
  for (const frameId of frameIds) {
    let node: BaseNode | null
    try {
      node = await figma.getNodeByIdAsync(frameId)
    } catch {
      node = null
    }
    if (stale()) {
      return null
    }
    touch()
    if (node === null || node.removed || !isExportable(node)) {
      missing.add(frameId)
      continue
    }
    const page = pageOf(node)
    if (page !== null && !loaded.has(page.id)) {
      loaded.add(page.id)
      try {
        await page.loadAsync()
      } catch {
        // See above.
      }
      if (stale()) {
        return null
      }
      touch()
    }
    if (isHidden(node, caches)) {
      hidden.add(frameId)
      continue
    }
    roots.push(node)
    ids.push(frameId)
  }
  return { roots, ids, missing, hidden }
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
    async start(requestId, scope, frameIds) {
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
      let rootIds: readonly string[] = []
      let missing: Set<string> | null = null
      let hidden = new Set<string>()
      if (frameIds !== undefined) {
        const found = await frameRoots(frameIds, stale, caches, () => send({ type: "scan-progress", requestId, scanned: 0 }))
        if (found === null) {
          return
        }
        roots = found.roots
        rootIds = found.ids
        missing = found.missing
        hidden = found.hidden
      } else if (scope === "selection") {
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
            // A requested frame deleted while the scan yielded is not in the file anymore.
            missing?.add(rootIds[r])
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
              // No spread: a large result would exceed the engine's argument limit and drop the whole root.
              for (const text of child.findAllWithCriteria({ types: ["TEXT"] })) {
                texts.push(text)
              }
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
      if (frameIds === undefined || missing === null) {
        send({ type: "scan-done", requestId, total, truncated, skipped })
      } else {
        const gone = missing
        // In request order, each frame once.
        const requested = [...new Set(frameIds)]
        send({
          type: "scan-done",
          requestId,
          total,
          truncated,
          skipped,
          missingFrameIds: requested.filter((frameId) => gone.has(frameId)),
          hiddenFrameIds: requested.filter((frameId) => hidden.has(frameId)),
        })
      }
    },
  }
}
