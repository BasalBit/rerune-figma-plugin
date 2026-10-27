import type { FigmaResolvedKey } from "./api-types"
import { src } from "./hash"
import type { ScannedNode } from "./messages"

export type SyncState = "unlinked" | "invalid_link" | "other_project" | "copied" | "unknown" | "key_missing" | "readonly"
  | "synced" | "changed_in_figma" | "changed_in_rerune" | "conflict"

export interface RemoteKeyState {
  found: boolean
  key: string | null
  type: "key" | "object" | "array"
  enabled: boolean
  structured: boolean
  mainText: string | null
}

export type SyncNode = Pick<ScannedNode, "characters" | "originalCharacters" | "link" | "linkState">

export function computeSyncState(projectId: string, node: SyncNode, remote: RemoteKeyState | undefined): SyncState {
  if (node.linkState === "invalid") {
    return "invalid_link"
  }
  if (node.linkState === "none" || node.linkState === "inherited_overridden" || node.link === null) {
    return "unlinked"
  }
  if (node.link.p !== projectId) {
    return "other_project"
  }
  if (node.linkState === "copied") {
    return "copied"
  }
  if (remote === undefined) {
    return "unknown"
  }
  if (!remote.found) {
    return "key_missing"
  }
  if (remote.type !== "key" || remote.structured || !remote.enabled) {
    return "readonly"
  }
  const t = src(layerText(node))
  const r = src(remote.mainText ?? "")
  const s = node.link.src
  if (t === r) {
    return "synced"
  }
  if (t === s) {
    return "changed_in_rerune"
  }
  if (r === s) {
    return "changed_in_figma"
  }
  return "conflict"
}

export function layerText(node: Pick<ScannedNode, "characters" | "originalCharacters">): string {
  return node.originalCharacters ?? node.characters
}

export function remoteStateFromResolved(key: FigmaResolvedKey, mainLanguage: string): RemoteKeyState {
  const main = key.values.find((value) => value.lang === mainLanguage)
  const content = main !== undefined && main.present ? main.content : null
  return {
    found: true,
    key: key.key,
    type: key.type,
    enabled: key.enabled,
    structured: content !== null && content.message !== undefined && content.message !== null,
    mainText: content === null ? null : content.value,
  }
}

export function missingRemoteState(): RemoteKeyState {
  return { found: false, key: null, type: "key", enabled: false, structured: false, mainText: null }
}
