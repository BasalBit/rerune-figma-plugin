import type { FigmaKeyRef, TranslationContent } from "../../shared/api-types"
import { BY_NAME_TEXT_MAX_UTF16, SEARCH_QUERY_MAX_RUNES } from "../../shared/constants"
import { src } from "../../shared/hash"
import type { LinkApplyItem, LinkState, ScannedNode, TextApplyItem } from "../../shared/messages"
import { nodeText } from "../../shared/push-plan"
import { firstRunes, normalizeDesignText, utf16Length } from "../../shared/text"

// Link dialog logic (§7.11): which layers it targets, the E11/E10 queries, and what linking to a chosen key
// writes. Keys are created only on push, so "Create new key" only records a pending name.

export interface LinkCandidate { id: string; key: string; main_content: TranslationContent | null }

export type LinkDecision =
  | { kind: "direct"; links: LinkApplyItem[]; note: string | null }
  | { kind: "ask"; remoteText: string; differing: number; keep: LinkApplyItem[]; use: { links: LinkApplyItem[]; texts: TextApplyItem[] } }

export const STRUCTURED_NOTE = "This key uses a plural or ICU message, so it stays read-only in Figma."
export const EMPTY_SOURCE_NOTE = "This key has no source text yet. Push to send the layer text."

// The key's main plain text, or null when the content is structured (ICU/plural, §4.0).
export function remotePlainText(content: TranslationContent | null): string | null {
  if (content === null) {
    return ""
  }
  if (content.message !== undefined && content.message !== null) {
    return null
  }
  return content.value
}

// Link states that already name a key (or a broken link). "Create new key" records a pending create, and creates
// come only from unlinked layers (none, inherited_overridden; §7.13 rule 2), so it is not offered for these: the
// pending name would be dropped by the next scan and nothing would be created. They are also the only layers
// Unlink writes: an inherited_overridden layer is shown and treated as "Not linked" (§7.6), and a tombstone on it
// would stop it from inheriting once its override is removed (D44).
export const LINKED_STATES: readonly LinkState[] = ["ok", "copied", "inherited", "invalid"]

export function isLinkedForCreate(node: Pick<ScannedNode, "linkState">): boolean {
  return LINKED_STATES.includes(node.linkState)
}

// Layers the Link dialog's Unlink acts on (its label counts exactly these).
export function unlinkTargets(nodes: readonly Pick<ScannedNode, "nodeId" | "linkState">[]): string[] {
  return nodes.filter(isLinkedForCreate).map((node) => node.nodeId)
}

// Why "Create new key" is not available for these layers, or null when it is.
export function createBlockedReason(nodes: readonly Pick<ScannedNode, "linkState">[]): string | null {
  const linked = nodes.filter(isLinkedForCreate)
  if (linked.length === 0) {
    return null
  }
  const copied = linked.some((node) => node.linkState === "copied") ? " For a copied layer you can also choose New key on the Push screen." : ""
  if (nodes.length === 1) {
    return "This layer is linked to a key. Unlink it first to create a new key for it." + copied
  }
  return (linked.length === 1 ? "1 of these layers is linked to a key" : linked.length + " of these layers are linked to keys") + ". Unlink them first to create a new key." + copied
}

// Same normalised text on every layer: required to create one key for them.
export function sharedText(nodes: readonly ScannedNode[]): string | null {
  if (nodes.length === 0) {
    return null
  }
  const text = nodeText(nodes[0])
  return nodes.every((node) => nodeText(node) === text) ? text : null
}

// Exact-text lookup (E11 texts): one normalised text per distinct layer text, ≤ 5000 UTF-16 units.
export function exactTextQueries(nodes: readonly ScannedNode[]): string[] {
  const texts = new Set<string>()
  for (const node of nodes) {
    const text = nodeText(node)
    if (text !== "" && utf16Length(text) <= BY_NAME_TEXT_MAX_UTF16) {
      texts.add(text)
    }
  }
  return [...texts]
}

export function exactMatchKeys(textMatches: ReadonlyMap<string, FigmaKeyRef[]>): FigmaKeyRef[] {
  const keys = new Map<string, FigmaKeyRef>()
  for (const list of textMatches.values()) {
    for (const key of list) {
      keys.set(key.id, key)
    }
  }
  return [...keys.values()]
}

// Search prefill (§7.8): the first 100 runes of the layer text. A text input cannot hold line breaks, so the
// first non-empty line is used.
export function searchPrefill(text: string): string {
  const line = normalizeDesignText(text).split("\n").map((part) => part.trim()).find((part) => part !== "") ?? ""
  return firstRunes(line, SEARCH_QUERY_MAX_RUNES)
}

function linkItem(node: ScannedNode, key: FigmaKeyRef, projectId: string, hash: string): LinkApplyItem {
  return { nodeId: node.nodeId, keyId: key.id, keyName: key.key, projectId, src: hash }
}

// Link to an existing key (§7.11): same text → link with src(text); different → ask "Use ReRune text"
// (link, then text-apply the remote text) or "Keep layer text" (link with src(remote) → changed_in_figma).
export function linkDecision(nodes: readonly ScannedNode[], key: LinkCandidate, projectId: string): LinkDecision {
  const remote = remotePlainText(key.main_content)
  const ref: FigmaKeyRef = { id: key.id, key: key.key }
  if (remote === null) {
    return { kind: "direct", links: nodes.map((node) => linkItem(node, ref, projectId, src(nodeText(node)))), note: STRUCTURED_NOTE }
  }
  const remoteHash = src(remote)
  if (normalizeDesignText(remote) === "") {
    return { kind: "direct", links: nodes.map((node) => linkItem(node, ref, projectId, remoteHash)), note: EMPTY_SOURCE_NOTE }
  }
  const differing = nodes.filter((node) => src(nodeText(node)) !== remoteHash).length
  const links = nodes.map((node) => linkItem(node, ref, projectId, remoteHash))
  if (differing === 0) {
    return { kind: "direct", links, note: null }
  }
  return {
    kind: "ask",
    remoteText: remote,
    differing,
    keep: links,
    use: { links, texts: nodes.map((node) => ({ nodeId: node.nodeId, text: remote, src: remoteHash })) },
  }
}

// Default target of the Link dialog for a layer whose text equals one key exactly (D40): that key first.
export function preferredKey(matches: readonly FigmaKeyRef[]): FigmaKeyRef | null {
  return matches.length === 1 ? matches[0] : null
}

// Pending names chosen for other layers (duplicate check for "Create new key"). Layers with the same text
// become one key when identical texts are grouped, so `sameKey` excludes them.
export function pendingNamesExcept(pending: ReadonlyMap<string, string>, nodeIds: readonly string[], sameKey: (nodeId: string) => boolean = () => false): Set<string> {
  const names = new Set<string>()
  for (const [nodeId, name] of pending) {
    if (!nodeIds.includes(nodeId) && !sameKey(nodeId)) {
      names.add(name)
    }
  }
  return names
}
