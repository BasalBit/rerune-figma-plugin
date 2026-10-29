import type { FigmaKeyRef } from "../../shared/api-types"
import { BY_NAME_TEXT_MAX_UTF16 } from "../../shared/constants"
import { src } from "../../shared/hash"
import type { LinkApplyItem, ScannedNode } from "../../shared/messages"
import { nodeText, type RemoteWithMaxLength } from "../../shared/push-plan"
import { computeSyncState, layerText, type SyncState } from "../../shared/sync-state"
import { utf16Length } from "../../shared/text"
import { unlinkTargets } from "./link"
import type { SkipCounts } from "./ops"

// Layers screen model (§7.8, §7.10): sync state per layer, grouping by top-level frame, state filters and the
// bulk actions. Pure; the screen renders it.

export type Badge = "missing_font" | "mixed_styles" | "variable" | "component_property" | "preview" | "instance" | "pending"
export type StateFilter = "all" | "unlinked" | "synced" | "changed" | "attention" | "readonly" | "too_long"

export interface LayerRow {
  node: ScannedNode
  state: SyncState
  keyName: string | null
  text: string
  badges: Badge[]
  pendingName: string | null
  maxLength: number | null
  textLength: number        // UTF-16 units of the text a push would send (the server's max_length measure)
  overMaxLength: boolean
}

export interface FrameGroup { key: string; frameId: string | null; title: string; rows: LayerRow[] }

export const STATE_LABELS: Record<SyncState, string> = {
  unlinked: "Not linked",
  invalid_link: "Broken link",
  other_project: "Other project",
  copied: "Copied",
  unknown: "Loading",
  key_missing: "Key missing",
  readonly: "Read-only",
  synced: "Synced",
  changed_in_figma: "Changed in Figma",
  changed_in_rerune: "Changed in ReRune",
  conflict: "Conflict",
}

// The chip tone of each state. "rerune" (ReRune amber) is the ReRune side of a change, "info" (Figma blue) the Figma
// side; every chip of a state uses this map, so Layers and Push agree.
export const STATE_TONES: Record<SyncState, "neutral" | "good" | "info" | "warning" | "danger" | "rerune"> = {
  unlinked: "neutral",
  invalid_link: "danger",
  other_project: "warning",
  copied: "warning",
  unknown: "neutral",
  key_missing: "danger",
  readonly: "neutral",
  synced: "good",
  changed_in_figma: "info",
  changed_in_rerune: "rerune",
  conflict: "danger",
}

export const BADGE_LABELS: Record<Badge, string> = {
  missing_font: "Missing font",
  mixed_styles: "Mixed styles",
  variable: "Variable",
  component_property: "Property",
  preview: "Preview",
  instance: "Instance",
  pending: "New key",
}

export const FILTER_LABELS: Record<StateFilter, string> = {
  all: "All",
  unlinked: "Not linked",
  synced: "Synced",
  changed: "Changed",
  attention: "Needs attention",
  readonly: "Read-only",
  too_long: "Too long",
}

const FILTER_STATES: Record<Exclude<StateFilter, "all" | "too_long">, readonly SyncState[]> = {
  unlinked: ["unlinked"],
  synced: ["synced"],
  changed: ["changed_in_figma", "changed_in_rerune", "conflict"],
  attention: ["copied", "invalid_link", "key_missing", "other_project", "unknown"],
  readonly: ["readonly"],
}

export const FILTER_ORDER: readonly StateFilter[] = ["all", "unlinked", "synced", "changed", "attention", "readonly", "too_long"]

export function badgesOf(node: ScannedNode, pending: boolean): Badge[] {
  const badges: Badge[] = []
  if (node.hasMissingFont) badges.push("missing_font")
  if (node.mixedStyles) badges.push("mixed_styles")
  if (node.boundToVariable) badges.push("variable")
  if (node.boundToComponentProperty) badges.push("component_property")
  if (node.preview !== null) badges.push("preview")
  if (node.isInstanceSublayer) badges.push("instance")
  if (pending) badges.push("pending")
  return badges
}

// Key names come from E12 when the remote state is loaded; the link's cached `k` is the fallback (§7.11).
export function keyNameOf(node: ScannedNode, remote: Map<string, RemoteWithMaxLength>): string | null {
  if (node.link === null) {
    return null
  }
  return remote.get(node.link.id)?.key ?? node.link.k
}

export function layerRows(nodes: readonly ScannedNode[], projectId: string, remote: Map<string, RemoteWithMaxLength>, pending: Map<string, string> = new Map()): LayerRow[] {
  return nodes.map((node) => {
    const state = computeSyncState(projectId, node, node.link !== null ? remote.get(node.link.id) : undefined)
    const linked = state !== "unlinked" && state !== "invalid_link"
    const maxLength = linked && node.link !== null ? remote.get(node.link.id)?.maxLength ?? null : null
    const text = layerText(node)
    const textLength = utf16Length(nodeText(node))
    const pendingName = state === "unlinked" ? pending.get(node.nodeId) ?? null : null
    return {
      node,
      state,
      keyName: linked ? keyNameOf(node, remote) : null,
      text,
      badges: badgesOf(node, pendingName !== null),
      pendingName,
      maxLength,
      textLength,
      overMaxLength: maxLength !== null && textLength > maxLength,
    }
  })
}

export function groupByFrame(rows: readonly LayerRow[]): FrameGroup[] {
  const groups = new Map<string, FrameGroup>()
  for (const row of rows) {
    const key = row.node.pageId + "|" + (row.node.frameId ?? "")
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, frameId: row.node.frameId, title: row.node.frameName ?? row.node.pageName + " (no frame)", rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
}

// "Too long" (§7.18.3): linked layers whose text is longer than the key's max_length (a push would hold them back).
export function matchesFilter(row: LayerRow, filter: StateFilter): boolean {
  if (filter === "all") {
    return true
  }
  return filter === "too_long" ? row.overMaxLength : FILTER_STATES[filter].includes(row.state)
}

export function filterCounts(rows: readonly LayerRow[]): Record<StateFilter, number> {
  const counts: Record<StateFilter, number> = { all: rows.length, unlinked: 0, synced: 0, changed: 0, attention: 0, readonly: 0, too_long: 0 }
  for (const row of rows) {
    for (const filter of FILTER_ORDER) {
      if (filter !== "all" && matchesFilter(row, filter)) {
        counts[filter]++
      }
    }
  }
  return counts
}

export function searchRows(rows: readonly LayerRow[], query: string): LayerRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") {
    return rows.slice()
  }
  return rows.filter((row) =>
    row.text.toLowerCase().includes(needle) || row.node.name.toLowerCase().includes(needle) || (row.keyName ?? "").toLowerCase().includes(needle),
  )
}

// "Link exact matches" (§7.8): unlinked layers whose normalised text matches exactly one key are linked
// (src = src(text) → synced); the rest are listed.
export interface ExactMatchPlan {
  links: LinkApplyItem[]
  ambiguous: { text: string; nodeIds: string[]; keys: FigmaKeyRef[] }[]
  unmatched: { text: string; nodeIds: string[] }[]
  skipped: number
}

export function unlinkedTexts(rows: readonly LayerRow[]): string[] {
  const texts = new Set<string>()
  for (const row of rows) {
    if (row.state === "unlinked") {
      const text = nodeText(row.node)
      if (text !== "" && utf16Length(text) <= BY_NAME_TEXT_MAX_UTF16) {
        texts.add(text)
      }
    }
  }
  return [...texts]
}

export function planExactMatches(rows: readonly LayerRow[], textMatches: Map<string, FigmaKeyRef[]>, projectId: string): ExactMatchPlan {
  const plan: ExactMatchPlan = { links: [], ambiguous: [], unmatched: [], skipped: 0 }
  const byText = new Map<string, string[]>()
  for (const row of rows) {
    if (row.state !== "unlinked") {
      plan.skipped++
      continue
    }
    const text = nodeText(row.node)
    const list = byText.get(text)
    if (list === undefined) {
      byText.set(text, [row.node.nodeId])
    } else {
      list.push(row.node.nodeId)
    }
  }
  for (const [text, nodeIds] of byText) {
    const keys = textMatches.get(text) ?? []
    if (keys.length === 1) {
      for (const nodeId of nodeIds) {
        plan.links.push({ nodeId, keyId: keys[0].id, keyName: keys[0].key, projectId, src: src(text) })
      }
    } else if (keys.length > 1) {
      plan.ambiguous.push({ text, nodeIds, keys })
    } else {
      plan.unmatched.push({ text, nodeIds })
    }
  }
  return plan
}

// "Keep copied links" (§7.15): rewrite nid on copied layers of this project, keeping the synced hash.
export function keepCopiedItems(rows: readonly LayerRow[], projectId: string): LinkApplyItem[] {
  const items: LinkApplyItem[] = []
  for (const row of rows) {
    const link = row.node.link
    if (row.state === "copied" && link !== null && link.p === projectId) {
      items.push({ nodeId: row.node.nodeId, keyId: link.id, keyName: row.keyName ?? link.k, projectId, src: link.src })
    }
  }
  return items
}

// Layers that name a key or carry a broken link (Unlink writes "" and the tombstone where inherited data shows).
// inherited_overridden rows read "Not linked" and are left alone (§7.6, D44).
export function unlinkableIds(rows: readonly LayerRow[]): string[] {
  return unlinkTargets(rows.map((row) => row.node))
}

export function linkedCount(rows: readonly LayerRow[]): number {
  return rows.filter((row) => row.state !== "unlinked" && row.state !== "invalid_link").length
}

const SKIP_LABELS: Record<keyof SkipCounts, string> = {
  hidden: "hidden",
  locked: "locked",
  empty: "empty",
  numeric: "numbers only",
  underscore: "named _…",
  languageCopy: "in language copies",
  unavailable: "unavailable",
}

// "Skipped: 3 hidden, 2 locked" under the scan results (§7.9 filters).
export function skippedSummary(skipped: SkipCounts): string | null {
  const parts = (Object.keys(SKIP_LABELS) as (keyof SkipCounts)[]).filter((reason) => skipped[reason] > 0).map((reason) => skipped[reason] + " " + SKIP_LABELS[reason])
  return parts.length === 0 ? null : "Skipped " + parts.join(", ")
}
