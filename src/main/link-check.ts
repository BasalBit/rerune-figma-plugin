import type { LinkCheck } from "../shared/messages"
import { readLinkInfo } from "./links"
import { createNodeCaches, isInLanguageCopy, pageOf, topFrameOf, withInvisibleInstanceChildren, yieldToCanvas, type NodeCaches } from "./node-utils"

// link-check (link sync, §7.11, §7.15, D43): the current link of the nodes ReRune has links for (and, on request,
// of the instance sublayers on the current page that inherit from them). Runs with
// skipInvisibleInstanceChildren off, so a hidden instance child (a variant or boolean toggle) is found instead
// of reading as missing. A null lookup is reported as not_found and never treated as deleted: branches and
// duplicated files share node ids with the main file. Reads only.

const CHECK_YIELD_EVERY = 50

function emptyCheck(nodeId: string, status: LinkCheck["status"]): LinkCheck {
  return { nodeId, status, linkState: "none", link: null, name: "", pageId: "", pageName: "", frameId: null, frameName: null }
}

// `sources` collects the ids (without a leading "I") of found text layers inside a component.
async function checkNode(nodeId: string, caches: NodeCaches, sources: Set<string> | null): Promise<LinkCheck> {
  let node: BaseNode | null
  try {
    node = await figma.getNodeByIdAsync(nodeId)
  } catch {
    return emptyCheck(nodeId, "unreadable")
  }
  if (node === null || node.removed) {
    return emptyCheck(nodeId, "not_found")
  }
  try {
    const page = pageOf(node)
    const frame = topFrameOf(node)
    const meta = {
      nodeId,
      status: "found" as const,
      name: node.name,
      pageId: page === null ? "" : page.id,
      pageName: page === null ? "" : page.name,
      frameId: frame === null ? null : frame.id,
      frameName: frame === null ? null : frame.name,
    }
    // Only text layers carry links; another node under this id carries none.
    if (node.type !== "TEXT") {
      return { ...meta, linkState: "none", link: null }
    }
    const info = readLinkInfo(node, caches)
    if (sources !== null && inComponent(node)) {
      sources.add(node.id.replace(/^I/, ""))
    }
    return { ...meta, linkState: info.state, link: info.link }
  } catch {
    return emptyCheck(nodeId, "unreadable")
  }
}

async function checkAll(nodeIds: readonly string[], caches: NodeCaches, sources: Set<string> | null = null): Promise<LinkCheck[]> {
  const results: LinkCheck[] = []
  for (let index = 0; index < nodeIds.length; index++) {
    if (index > 0 && index % CHECK_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    results.push(await checkNode(nodeIds[index], caches, sources))
  }
  return results
}

function inComponent(node: BaseNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "COMPONENT") {
      return true
    }
  }
  return false
}

// The current page's instance sublayers that show one of `sources` (D44): Figma names an instance sublayer "I" +
// the instance path + ";" + the component node's id, so a sublayer of an instance (also a nested one) of that
// component ends with ";" + the source id. Other pages are never loaded for it. Layers of language copies are left
// out, as scans and pushes leave them out (D32).
function inheritorsOnPage(sources: ReadonlySet<string>, checked: ReadonlySet<string>, caches: NodeCaches): string[] {
  if (sources.size === 0) {
    return []
  }
  const found: string[] = []
  for (const text of figma.currentPage.findAllWithCriteria({ types: ["TEXT"] })) {
    if (text.id.charAt(0) !== "I" || checked.has(text.id) || isInLanguageCopy(text, caches)) {
      continue
    }
    const parts = text.id.split(";")
    for (let start = 1; start < parts.length; start++) {
      if (sources.has(parts.slice(start).join(";"))) {
        found.push(text.id)
        break
      }
    }
  }
  return found
}

// `inheritors` (after link, unlink and push): also check the current page's instance sublayers that inherit from a
// checked text inside a component, since linking or unlinking the main component's text changes what they show
// (§7.11, §7.15), whether or not the last scan included them.
export async function checkLinks(nodeIds: readonly string[], inheritors = false): Promise<LinkCheck[]> {
  return withInvisibleInstanceChildren(async () => {
    const caches = createNodeCaches()
    const sources = inheritors ? new Set<string>() : null
    const results = await checkAll(nodeIds, caches, sources)
    if (sources !== null) {
      try {
        results.push(...(await checkAll(inheritorsOnPage(sources, new Set(nodeIds), caches), caches)))
      } catch {
        // The requested layers are answered; their instances are checked by the next sync or "Sync links on this page".
      }
    }
    return results
  })
}

// The UI sends ids as an array of strings; anything else is a programming error answered with handler-error.
export function nodeIdsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("nodeIds must be a list of node ids")
  }
  return value as string[]
}
