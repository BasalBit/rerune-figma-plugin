import type { LinkState, MainToUiOf } from "../shared/messages"

// Minimal Dev Mode inspect (Phase 1): one row per linked key with its name and the layer text. Phase 2 adds
// values for every language, status, max_length and snippets (§7.17).

export interface InspectKey { keyId: string; keyName: string; layerText: string; layers: number; state: LinkState }
export type InspectModel =
  | { kind: "empty"; keys: [] }
  | { kind: "unlinked"; keys: [] }
  | { kind: "keys"; keys: InspectKey[] }

const LINKED: readonly LinkState[] = ["ok", "inherited", "copied"]
const TEXT_PREVIEW_CHARS = 80

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TEXT_PREVIEW_CHARS ? flat.slice(0, TEXT_PREVIEW_CHARS - 1) + "…" : flat
}

export function inspectModel(selection: MainToUiOf<"inspect-selection"> | null): InspectModel {
  if (selection === null || selection.kind === "none") {
    return { kind: "empty", keys: [] }
  }
  const keys = new Map<string, InspectKey>()
  for (const node of selection.nodes) {
    if (node.link === null || !LINKED.includes(node.linkState)) {
      continue
    }
    const known = keys.get(node.link.id)
    if (known !== undefined) {
      known.layers++
      continue
    }
    keys.set(node.link.id, { keyId: node.link.id, keyName: node.link.k, layerText: preview(node.originalCharacters ?? node.characters), layers: 1, state: node.linkState })
  }
  if (keys.size === 0) {
    return selection.kind === "text" ? { kind: "unlinked", keys: [] } : { kind: "empty", keys: [] }
  }
  return { kind: "keys", keys: [...keys.values()] }
}
