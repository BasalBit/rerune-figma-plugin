import { INSPECT_CONTAINER_MAX_NODES, SCAN_MAX_NODES, SCAN_YIELD_EVERY_CHILDREN, SCAN_YIELD_EVERY_TEXTS } from "../shared/constants"
import type { MainToUi, MainToUiOf, ScannedNode } from "../shared/messages"
import { readLinkInfo } from "./links"
import { createNodeCaches, isTextNode, yieldToCanvas, type NodeCaches } from "./node-utils"
import { describeTextNode } from "./scan"

// Dev Mode inspect (§7.17): TEXT → that node; container → linked text nodes under it (≤ 50); none → empty.
// Read-only: nothing here writes to the document.

export type InspectSelection = MainToUiOf<"inspect-selection">

const LINKED_STATES = ["ok", "inherited", "copied"]

// The key a text shows for the panel, or null when it shows none.
function linkedKeyOf(node: TextNode, caches: NodeCaches): string | null {
  const info = readLinkInfo(node, caches)
  return info.link !== null && LINKED_STATES.includes(info.state) ? info.link.id : null
}

interface Found { order: number; text: TextNode }

// A container's linked text nodes, at most 50 (§7.17). The panel shows one card per key, so the 50 are chosen key
// first: the first layer of each key in layer order (up to 50 keys), then the other layers in layer order while
// room is left; they are sent in layer order. `truncated` (a Phase 2 addition to inspect-selection): some linked
// layer under the container is not sent, so a key past the 50th is missing or a key's layer count is low. The
// walk reads only links until it is done (or 5,000 linked layers), and describes just the chosen nodes.
async function linkedTextsUnder(container: BaseNode & ChildrenMixin, caches: NodeCaches, isStale: () => boolean): Promise<{ nodes: ScannedNode[]; truncated: boolean } | null> {
  const firsts: Found[] = []
  const others: Found[] = []
  const keys = new Set<string>()
  let linked = 0
  let read = 0
  let truncated = false
  const yieldAndCheck = async () => {
    await yieldToCanvas()
    return isStale()
  }
  const children = container.children
  walk: for (let index = 0; index < children.length; index++) {
    if (index > 0 && index % SCAN_YIELD_EVERY_CHILDREN === 0 && (await yieldAndCheck())) {
      return null
    }
    const child = children[index]
    const texts: TextNode[] = child.type === "TEXT" ? [child] : "findAllWithCriteria" in child ? child.findAllWithCriteria({ types: ["TEXT"] }) : []
    for (const text of texts) {
      if (++read % SCAN_YIELD_EVERY_TEXTS === 0 && (await yieldAndCheck())) {
        return null
      }
      let keyId: string | null
      try {
        keyId = text.removed ? null : linkedKeyOf(text, caches)
      } catch {
        // A node that disappears while the panel reads it is left out.
        keyId = null
      }
      if (keyId === null) {
        continue
      }
      // Every slot holds a key's first layer: nothing more fits, and this layer is left out.
      if (keys.size >= INSPECT_CONTAINER_MAX_NODES || linked >= SCAN_MAX_NODES) {
        truncated = true
        break walk
      }
      const found = { order: linked++, text }
      if (!keys.has(keyId)) {
        keys.add(keyId)
        firsts.push(found)
      } else if (others.length < INSPECT_CONTAINER_MAX_NODES) {
        others.push(found)
      } else {
        truncated = true
      }
    }
  }
  const room = INSPECT_CONTAINER_MAX_NODES - firsts.length
  if (others.length > room) {
    truncated = true
  }
  const chosen = firsts.concat(others.slice(0, room)).sort((a, b) => a.order - b.order)
  const nodes: ScannedNode[] = []
  for (const { text } of chosen) {
    try {
      if (!text.removed) {
        nodes.push(await describeTextNode(text, caches))
      }
    } catch {
      // A node that disappears while the panel reads it is left out.
    }
  }
  return { nodes, truncated }
}

export async function inspectSelection(isStale: () => boolean = () => false): Promise<InspectSelection | null> {
  const node = figma.currentPage.selection[0]
  if (node === undefined || node.removed) {
    return { type: "inspect-selection", kind: "none", nodes: [], truncated: false }
  }
  const caches = createNodeCaches()
  if (isTextNode(node)) {
    return { type: "inspect-selection", kind: "text", nodes: [await describeTextNode(node, caches)], truncated: false }
  }
  if (!("children" in node)) {
    return { type: "inspect-selection", kind: "none", nodes: [], truncated: false }
  }
  const found = await linkedTextsUnder(node as SceneNode & ChildrenMixin, caches, isStale)
  return found === null ? null : { type: "inspect-selection", kind: "container", nodes: found.nodes, truncated: found.truncated }
}

export interface InspectWatcher {
  refresh(): Promise<void>
}

// Sends inspect-selection on every selection or page change; a newer selection supersedes a running read.
export function watchInspectSelection(send: (message: MainToUi) => void): InspectWatcher {
  let generation = 0
  const refresh = async () => {
    const mine = ++generation
    try {
      const message = await inspectSelection(() => mine !== generation)
      if (message !== null && mine === generation) {
        send(message)
      }
    } catch {
      if (mine === generation) {
        send({ type: "inspect-selection", kind: "none", nodes: [], truncated: false })
      }
    }
  }
  figma.on("selectionchange", () => {
    void refresh()
  })
  figma.on("currentpagechange", () => {
    void refresh()
  })
  return { refresh }
}
