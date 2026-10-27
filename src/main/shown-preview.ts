import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { parsePreviewRecord, recordOwnership, type PreviewRecord } from "../shared/plugin-data"
import { isInRemoteComponent, isTextNode, lookupNode, overrideFlags, type NodeCaches } from "./node-utils"

// Which preview a text node shows (D22, D23, §7.14 apply step 2).
//
// A node's own record (`nid === node.id`) is its preview. An instance sublayer without a `characters` override
// shows the text of the node it was instanced from, so when that node (or one further up a nested-instance
// chain) carries its own preview record, the sublayer shows that preview as well, although no record of its own
// exists. Scans report such a sublayer as previewing (push stays blocked, sync compares the original text),
// preview-apply leaves it alone, and resets go to the node that owns the record.

export interface ShownPreview {
  record: PreviewRecord
  // The node that carries the record; null when it cannot be reached from this file (a library main previewed
  // in the library file, or a chain Figma does not resolve).
  owner: TextNode | null
}

const MAX_CHAIN = 16

// The node an instance sublayer takes its text from: `I<instance>;<a>;<b>` → `I<a>;<b>` (a sublayer of a nested
// instance inside the main component), `I<instance>;<a>` → `<a>` (the main component's own node).
export function backingNodeId(nodeId: string): string | null {
  if (nodeId.charAt(0) !== "I") {
    return null
  }
  const at = nodeId.indexOf(";")
  if (at < 0 || at === nodeId.length - 1) {
    return null
  }
  const rest = nodeId.slice(at + 1)
  return rest.indexOf(";") >= 0 ? "I" + rest : rest
}

function readRecord(node: BaseNode): PreviewRecord | null {
  return parsePreviewRecord(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview))
}

async function lookupText(id: string, caches: NodeCaches): Promise<TextNode | null> {
  const node = await lookupNode(id, caches)
  return isTextNode(node) ? node : null
}

async function ownerOf(record: PreviewRecord, caches: NodeCaches): Promise<TextNode | null> {
  const node = await lookupText(record.nid, caches)
  if (node === null) {
    return null
  }
  const own = readRecord(node)
  return own !== null && own.nid === node.id ? node : null
}

export function ownRecordOf(node: BaseNode): PreviewRecord | null {
  const record = readRecord(node)
  return record !== null && record.nid === node.id ? record : null
}

export async function shownPreview(node: TextNode, caches: NodeCaches): Promise<ShownPreview | null> {
  const visible = readRecord(node)
  if (visible !== null && visible.nid === node.id) {
    return { record: visible, owner: node }
  }
  if (node.id.charAt(0) !== "I") {
    return null
  }
  const flags = overrideFlags(node, caches)
  if (flags.textOverridden) {
    return null
  }
  let id = backingNodeId(node.id)
  for (let depth = 0; id !== null && depth < MAX_CHAIN; depth++) {
    const backing = await lookupText(id, caches)
    if (backing === null) {
      break
    }
    const record = readRecord(backing)
    if (record !== null && record.nid === backing.id) {
      return { record, owner: backing }
    }
    if (backing.id.charAt(0) !== "I") {
      // A library main keeps the record written in the library file (its nid is a library id).
      return record !== null && isInRemoteComponent(backing) ? { record, owner: null } : null
    }
    if (overrideFlags(backing, caches).textOverridden) {
      return null
    }
    id = backingNodeId(backing.id)
  }
  // The chain could not be followed: a record inherited through plugin data still says what the text shows.
  if (visible !== null && recordOwnership(node.id, visible.nid, flags.ownPluginDataOverride) === "inherited") {
    return { record: visible, owner: await ownerOf(visible, caches) }
  }
  return null
}
