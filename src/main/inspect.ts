import { INSPECT_CONTAINER_MAX_NODES } from "../shared/constants"
import type { MainToUi, MainToUiOf, ScannedNode } from "../shared/messages"
import { readLinkInfo } from "./links"
import { createNodeCaches, isTextNode, yieldToCanvas, type NodeCaches } from "./node-utils"
import { describeTextNode } from "./scan"

// Dev Mode inspect (§7.17): TEXT → that node; container → linked text nodes under it (≤ 50); none → empty.
// Read-only: nothing here writes to the document.

export type InspectSelection = MainToUiOf<"inspect-selection">

const LINKED_STATES = ["ok", "inherited", "copied"]

export function isLinkedForInspect(node: TextNode, caches: NodeCaches): boolean {
  return LINKED_STATES.includes(readLinkInfo(node, caches).state)
}

async function linkedTextsUnder(container: BaseNode & ChildrenMixin, caches: NodeCaches, isStale: () => boolean): Promise<ScannedNode[] | null> {
  const nodes: ScannedNode[] = []
  const children = container.children
  for (let index = 0; index < children.length && nodes.length < INSPECT_CONTAINER_MAX_NODES; index++) {
    if (index > 0 && index % 10 === 0) {
      await yieldToCanvas()
      if (isStale()) {
        return null
      }
    }
    const child = children[index]
    const texts: TextNode[] = child.type === "TEXT" ? [child] : "findAllWithCriteria" in child ? child.findAllWithCriteria({ types: ["TEXT"] }) : []
    for (const text of texts) {
      if (nodes.length >= INSPECT_CONTAINER_MAX_NODES) {
        break
      }
      try {
        if (!text.removed && isLinkedForInspect(text, caches)) {
          nodes.push(await describeTextNode(text, caches))
        }
      } catch {
        // A node that disappears while the panel reads it is left out.
      }
    }
  }
  return nodes
}

export async function inspectSelection(isStale: () => boolean = () => false): Promise<InspectSelection | null> {
  const node = figma.currentPage.selection[0]
  if (node === undefined || node.removed) {
    return { type: "inspect-selection", kind: "none", nodes: [] }
  }
  const caches = createNodeCaches()
  if (isTextNode(node)) {
    return { type: "inspect-selection", kind: "text", nodes: [await describeTextNode(node, caches)] }
  }
  if (!("children" in node)) {
    return { type: "inspect-selection", kind: "none", nodes: [] }
  }
  const nodes = await linkedTextsUnder(node as SceneNode & ChildrenMixin, caches, isStale)
  return nodes === null ? null : { type: "inspect-selection", kind: "container", nodes }
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
        send({ type: "inspect-selection", kind: "none", nodes: [] })
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
