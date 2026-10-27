import { src } from "../src/shared/hash"
import type { LinkState, NodeLink, ScannedNode } from "../src/shared/messages"

export const PROJECT_ID = "6a4600000000000000000c35"
export const OTHER_PROJECT_ID = "6a4600000000000000000999"

export function keyId(n: number): string {
  return "6a48" + String(n).padStart(20, "0")
}

export function nodeLink(keyIdValue: string, keyName: string, text: string, nid: string, projectId = PROJECT_ID): NodeLink {
  return { v: 1, id: keyIdValue, k: keyName, p: projectId, src: src(text), nid, t: 1761550000000 }
}

export function scannedNode(nodeId: string, characters: string, overrides: Partial<ScannedNode> = {}): ScannedNode {
  return {
    nodeId,
    name: characters,
    characters,
    originalCharacters: null,
    pageId: "0:1",
    pageName: "Mobile",
    frameId: "10:1",
    frameName: "Checkout",
    parentNames: [],
    componentName: null,
    isInstanceSublayer: nodeId.startsWith("I"),
    link: null,
    linkState: "none",
    preview: null,
    hasMissingFont: false,
    mixedStyles: false,
    boundToComponentProperty: false,
    boundToVariable: false,
    autoRename: true,
    textOverridden: false,
    width: 100,
    height: 20,
    textAutoResize: "WIDTH_AND_HEIGHT",
    textTruncation: "DISABLED",
    maxLines: null,
    ...overrides,
  }
}

export function linkedNode(
  nodeId: string,
  characters: string,
  link: { keyId: string; keyName: string; syncedText: string; nid?: string; projectId?: string; state?: LinkState },
  overrides: Partial<ScannedNode> = {},
): ScannedNode {
  return scannedNode(nodeId, characters, {
    link: nodeLink(link.keyId, link.keyName, link.syncedText, link.nid ?? nodeId, link.projectId),
    linkState: link.state ?? "ok",
    ...overrides,
  })
}
