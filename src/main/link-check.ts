import type { LinkCheck } from "../shared/messages"
import { readLinkInfo } from "./links"
import { createNodeCaches, pageOf, topFrameOf, withInvisibleInstanceChildren, yieldToCanvas, type NodeCaches } from "./node-utils"

// link-check (link sync, §7.11, §7.15, D43): the current link of the nodes ReRune has links for. Runs with
// skipInvisibleInstanceChildren off, so a hidden instance child (a variant or boolean toggle) is found instead
// of reading as missing. A null lookup is reported as not_found and never treated as deleted: branches and
// duplicated files share node ids with the main file. Reads only.

const CHECK_YIELD_EVERY = 50

function emptyCheck(nodeId: string, status: LinkCheck["status"]): LinkCheck {
  return { nodeId, status, linkState: "none", link: null, name: "", pageId: "", pageName: "", frameId: null, frameName: null }
}

async function checkNode(nodeId: string, caches: NodeCaches): Promise<LinkCheck> {
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
    return { ...meta, linkState: info.state, link: info.link }
  } catch {
    return emptyCheck(nodeId, "unreadable")
  }
}

export async function checkLinks(nodeIds: readonly string[]): Promise<LinkCheck[]> {
  return withInvisibleInstanceChildren(async () => {
    const caches = createNodeCaches()
    const results: LinkCheck[] = []
    for (let index = 0; index < nodeIds.length; index++) {
      if (index > 0 && index % CHECK_YIELD_EVERY === 0) {
        await yieldToCanvas()
      }
      results.push(await checkNode(nodeIds[index], caches))
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
