import { DATA_KEYS, DATA_TOMBSTONE, PLUGIN_DATA_NAMESPACE, RELAUNCH_COMMAND, WRITE_YIELD_EVERY } from "../shared/constants"
import type { LinkApplyItem, LinkState, NodeError, NodeLink } from "../shared/messages"
import { nodeError } from "../shared/node-errors"
import { createLink, linkStateOf, parseLink, parsePreviewRecord, relaunchDescription, serializeLink, type ParsedLink } from "../shared/plugin-data"
import { createNodeCaches, isInRemoteComponent, isTextNode, nearestComponentOf, overrideFlags, yieldToCanvas, type NodeCaches, type OverrideFlags } from "./node-utils"

export interface OpOutcome { done: number; errors: NodeError[] }

export interface LinkInfo {
  parsed: ParsedLink
  link: NodeLink | null
  state: LinkState
  ownPluginDataOverride: boolean | null
  textOverridden: boolean
}

// D44 inputs for classifying a node's link. While an instance sublayer shows its own preview, the preview write
// itself created a `characters` override (and Figma may list the record as a `pluginData` override), so the link
// is classified with the override state stored in the record before the preview. Otherwise every previewed
// library or component instance would read as inherited_overridden or copied until reset: no re-preview in
// another language, "Not linked" or "Copied" in Layers, and "Keep copied links" would turn the component link
// into a per-instance link. Records of earlier builds carry no pluginData state: a live `true` then falls back
// to the id pattern (null), which cannot match a library nid.
export function classificationFlags(node: BaseNode, caches: NodeCaches): OverrideFlags {
  const flags = overrideFlags(node, caches)
  if (node.id.charAt(0) !== "I") {
    return flags
  }
  const record = parsePreviewRecord(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview))
  if (record === null || record.nid !== node.id) {
    return flags
  }
  const ownPluginDataOverride = record.pluginDataOverridden !== undefined
    ? record.pluginDataOverridden
    : flags.ownPluginDataOverride === true ? null : flags.ownPluginDataOverride
  return { ownPluginDataOverride, textOverridden: record.textOverridden }
}

export function readLinkInfo(node: BaseNode, caches: NodeCaches): LinkInfo {
  const parsed = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  const flags = classificationFlags(node, caches)
  return {
    parsed,
    link: parsed.kind === "link" ? parsed.link : null,
    state: linkStateOf(parsed, node.id, flags.ownPluginDataOverride, flags.textOverridden),
    ownPluginDataOverride: flags.ownPluginDataOverride,
    textOverridden: flags.textOverridden,
  }
}

export function setRelaunch(node: BaseNode, data: { [command: string]: string }): void {
  try {
    node.setRelaunchData(data)
  } catch {
    // Relaunch buttons are a convenience; a node that refuses them keeps its link.
  }
}

// Link write (§7.6): the link plus the relaunch button "ReRune key: <name>".
export function writeLink(node: BaseNode, link: NodeLink): void {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(link))
  setRelaunch(node, { [RELAUNCH_COMMAND]: relaunchDescription(link.k) })
}

// Writes "" and reads back; data that is still visible (inherited from a main component) gets the tombstone
// unless keepVisible says the remaining value may stay. Returns how the value was cleared.
export function clearPluginData(node: BaseNode, key: string, keepVisible: (raw: string) => boolean = () => false): "cleared" | "tombstone" | "kept" {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, key, "")
  const readBack = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, key)
  if (readBack === "") {
    return "cleared"
  }
  if (keepVisible(readBack)) {
    return "kept"
  }
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, key, DATA_TOMBSTONE)
  return "tombstone"
}

// Unlink (§7.6): "" then the tombstone if inherited data shows through; clears the relaunch button.
export function removeLink(node: BaseNode): "cleared" | "tombstone" | "kept" {
  const result = clearPluginData(node, DATA_KEYS.link)
  setRelaunch(node, {})
  return result
}

// The local main component's text node behind an inherited link (§7.13 rule 5, §7.6): it must be a TEXT node
// inside a local COMPONENT and carry its own link to the same key. A library nid can collide with an unrelated
// local node id, so anything else is treated as a remote (library) component.
export async function resolveMainTextNode(link: NodeLink): Promise<TextNode | null> {
  let node: BaseNode | null
  try {
    node = await figma.getNodeByIdAsync(link.nid)
  } catch {
    return null
  }
  if (!isTextNode(node) || node.removed) {
    return null
  }
  const component = nearestComponentOf(node)
  if (component === null || component.remote) {
    return null
  }
  const own = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  if (own.kind !== "link" || own.link.nid !== node.id || own.link.id !== link.id) {
    return null
  }
  return node
}

export async function getTextNode(nodeId: string): Promise<TextNode | null> {
  try {
    const node = await figma.getNodeByIdAsync(nodeId)
    return isTextNode(node) && !node.removed ? node : null
  } catch {
    return null
  }
}

export type WriteTarget = { node: TextNode; redirected: boolean } | { error: NodeError["code"] }

// Where a write for `node` goes. An inherited link is never written on the instance sublayer as a side effect
// (D44): writes for the same key go to the local main component's node, or fail with remote_component.
export async function writeTargetFor(node: TextNode, info: LinkInfo, keyId: string | null): Promise<WriteTarget> {
  if (info.state === "inherited" && info.link !== null && (keyId === null || keyId === info.link.id)) {
    const main = await resolveMainTextNode(info.link)
    return main === null ? { error: "remote_component" } : { node: main, redirected: true }
  }
  if (isInRemoteComponent(node)) {
    return { error: "remote_component" }
  }
  return { node, redirected: false }
}

function validLink(item: LinkApplyItem, nodeId: string, now: number): NodeLink | null {
  const link = createLink({ keyId: item.keyId, keyName: item.keyName, projectId: item.projectId, src: item.src, nodeId, now })
  const parsed = parseLink(serializeLink(link))
  return parsed.kind === "link" ? parsed.link : null
}

// link-apply (§7.11, §7.13 rule 10): explicit writes, also on instance sublayers. An item for an inherited
// sublayer with the same key is a refresh and goes to the main component's node instead.
export async function applyLinks(items: readonly LinkApplyItem[], now: number): Promise<OpOutcome> {
  const caches = createNodeCaches()
  const errors: NodeError[] = []
  const written = new Set<string>()
  let done = 0
  for (let index = 0; index < items.length; index++) {
    if (index > 0 && index % WRITE_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const item = items[index]
    const node = await getTextNode(item.nodeId)
    if (node === null) {
      errors.push(nodeError(item.nodeId, "node_not_found"))
      continue
    }
    try {
      const target = await writeTargetFor(node, readLinkInfo(node, caches), item.keyId)
      if ("error" in target) {
        errors.push(nodeError(item.nodeId, target.error))
        continue
      }
      if (!written.has(target.node.id)) {
        const link = validLink(item, target.node.id, now)
        if (link === null) {
          errors.push(nodeError(item.nodeId, "write_failed", "This link has an invalid key or project id."))
          continue
        }
        writeLink(target.node, link)
        written.add(target.node.id)
      }
      done++
    } catch {
      errors.push(nodeError(item.nodeId, "write_failed"))
    }
  }
  return { done, errors }
}

export async function removeLinks(nodeIds: readonly string[]): Promise<OpOutcome> {
  const errors: NodeError[] = []
  let done = 0
  for (let index = 0; index < nodeIds.length; index++) {
    if (index > 0 && index % WRITE_YIELD_EVERY === 0) {
      await yieldToCanvas()
    }
    const node = await getTextNode(nodeIds[index])
    if (node === null) {
      errors.push(nodeError(nodeIds[index], "node_not_found"))
      continue
    }
    try {
      removeLink(node)
      done++
    } catch {
      errors.push(nodeError(nodeIds[index], "write_failed"))
    }
  }
  return { done, errors }
}
