import type { FigmaLink, FigmaLinkRejection, FigmaLinksRequest, FigmaLinkUpsert } from "../../shared/api-types"
import { OBJECT_ID_PATTERN } from "../../shared/constants"
import type { LinkSyncGate } from "../../shared/file-link"
import { isFigmaNodeId, isFigmaPageId } from "../../shared/figma-url"
import type { LinkCheck, RequestId, ScannedNode } from "../../shared/messages"
import { firstRunes, trimSpace } from "../../shared/text"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { chunk } from "./ops"

// Link sync (§7.11, §7.15, D43): ReRune's copy of which layer of this file shows which key (E17/E18), so the
// dashboard can show where a key is used and MCP can list a frame's keys. Two triggers:
// - after link, unlink and push, the affected layers are upserted or removed (syncNodes);
// - "Sync links on this page" compares ReRune's links of the current page with the layers (syncPage).
// A server link is removed only when its layer exists and carries no link or another key. A layer that resolves to
// null (hidden, or a layer of another branch or file: they share node ids and the file key) is never removed
// automatically: such links are listed and removed only through an explicit Remove.

export const LINKS_BATCH_SIZE = 500          // E17: ≤ 500 upserts and ≤ 500 removals per request; E18 page size
export const LINK_CHECK_BATCH_SIZE = 500     // node ids per link-check message
export const LINK_NAME_MAX_RUNES = 200       // names are trimmed (strings.TrimSpace) and cut to 200 runes on the server (§4.0)
export const LINKS_MAX_PAGES = 200           // E18 pages read for one page sync (100,000 links)

export interface LinkSyncPlan { upserts: FigmaLinkUpsert[]; removals: string[] }
export interface PageSyncPlan extends LinkSyncPlan { unresolved: FigmaLink[] }

export interface LinkSyncResult {
  upserted: number
  removed: number
  rejected: FigmaLinkRejection[]
  error: string | null
}

export interface PageSyncResult extends LinkSyncResult {
  serverLinks: number
  unresolved: FigmaLink[]
}

type CheckedNode = Pick<LinkCheck, "nodeId" | "status" | "linkState" | "link" | "name" | "pageId" | "pageName" | "frameId" | "frameName">

export function emptyResult(): LinkSyncResult {
  return { upserted: 0, removed: 0, rejected: [], error: null }
}

// A name as the server stores it (§4.0), so sameUpsert sees an unchanged layer as unchanged.
export function cleanLinkName(name: string): string {
  return firstRunes(trimSpace(name), LINK_NAME_MAX_RUNES)
}

// A scanned layer exists by definition: its scan state is as good as a link-check.
export function checkFromScanned(node: ScannedNode): LinkCheck {
  return {
    nodeId: node.nodeId,
    status: "found",
    linkState: node.linkState,
    link: node.link,
    name: node.name,
    pageId: node.pageId,
    pageName: node.pageName,
    frameId: node.frameId,
    frameName: node.frameName,
  }
}

// The key of this project a found layer shows, or null when it shows none: unlinked, a broken link, an instance
// that overrides its text (treated as unlinked, §7.6), or a link to another project's key. Copied links still name
// their key.
export function carriedKey(check: CheckedNode, projectId: string): string | null {
  if (check.status !== "found" || check.link === null) {
    return null
  }
  if (check.linkState === "none" || check.linkState === "invalid" || check.linkState === "inherited_overridden") {
    return null
  }
  return check.link.p === projectId ? check.link.id : null
}

// Layers ReRune should list: own links and inherited instance links of this project. Copied links wait for the
// designer's Keep / New key decision.
export function isUpsertable(check: CheckedNode, projectId: string): boolean {
  return carriedKey(check, projectId) !== null && (check.linkState === "ok" || check.linkState === "inherited")
}

// E17 upsert for a layer, or null when an identifier would fail the server's validation (§4.0).
export function upsertOf(check: CheckedNode): FigmaLinkUpsert | null {
  const link = check.link
  if (link === null || !OBJECT_ID_PATTERN.test(link.id) || !isFigmaNodeId(check.nodeId) || !isFigmaPageId(check.pageId)) {
    return null
  }
  const frameId = check.frameId ?? ""
  if (frameId !== "" && !isFigmaNodeId(frameId)) {
    return null
  }
  return {
    node_id: check.nodeId,
    key_id: link.id,
    frame_id: frameId,
    frame_name: frameId === "" ? "" : cleanLinkName(check.frameName ?? ""),
    page_id: check.pageId,
    page_name: cleanLinkName(check.pageName),
    node_name: cleanLinkName(check.name),
  }
}

export function sameUpsert(server: Pick<FigmaLink, keyof FigmaLinkUpsert>, upsert: FigmaLinkUpsert): boolean {
  return (
    server.node_id === upsert.node_id &&
    server.key_id === upsert.key_id &&
    server.frame_id === upsert.frame_id &&
    server.frame_name === upsert.frame_name &&
    server.page_id === upsert.page_id &&
    server.page_name === upsert.page_name &&
    server.node_name === upsert.node_name
  )
}

// The layers a link or unlink changes in ReRune's eyes: the layers written, plus the instance sublayers of the
// scan that inherit from one of them (same id suffix, D44 fallback rule, or the link's nid), since linking or
// unlinking a main component's text changes what its instances show. Instances on the page that the scan did not
// include (a Selection scan of the main component) are added by main (link-check `inheritors`).
export function affectedNodeIds(acted: readonly string[], known: readonly Pick<ScannedNode, "nodeId" | "link">[] = []): string[] {
  const result = new Set(acted)
  const sources = new Set(acted.map((id) => id.replace(/^I/, "")))
  const actedIds = new Set(acted)
  for (const node of known) {
    if (node.nodeId.charAt(0) !== "I" || result.has(node.nodeId)) {
      continue
    }
    if (node.link !== null && actedIds.has(node.link.nid)) {
      result.add(node.nodeId)
      continue
    }
    const parts = node.nodeId.split(";")
    for (let start = 1; start < parts.length; start++) {
      if (sources.has(parts.slice(start).join(";"))) {
        result.add(node.nodeId)
        break
      }
    }
  }
  return [...result]
}

// After link, unlink or push: upsert the layers that show a key of this project, remove the ones that exist and
// show none. Layers that are not found (or unreadable) are left alone; copied layers wait for a decision.
export function planNodeSync(checks: readonly CheckedNode[], projectId: string): LinkSyncPlan {
  const upserts = new Map<string, FigmaLinkUpsert>()
  const removals = new Set<string>()
  for (const check of checks) {
    if (check.status !== "found" || upserts.has(check.nodeId) || removals.has(check.nodeId) || !isFigmaNodeId(check.nodeId)) {
      continue
    }
    if (carriedKey(check, projectId) === null) {
      removals.add(check.nodeId)
    } else if (isUpsertable(check, projectId)) {
      const upsert = upsertOf(check)
      if (upsert !== null) {
        upserts.set(check.nodeId, upsert)
      }
    }
  }
  return { upserts: [...upserts.values()], removals: [...removals] }
}

export interface PageSyncInput {
  projectId: string
  pageId: string
  scanned: readonly ScannedNode[]           // the page scan
  server: readonly FigmaLink[]              // E18 links of this file on this page
  checks: ReadonlyMap<string, CheckedNode>  // every server link's layer: from the scan, else from link-check
}

// Page link sync (§7.15): every linked layer of the page that ReRune lacks (or has with other names or another
// key) is upserted; a server link whose layer exists and shows no key, or another key, is removed (D43); a server
// link whose layer resolves to null is listed (unresolved), never removed here.
export function planPageSync(input: PageSyncInput): PageSyncPlan {
  const upserts = new Map<string, FigmaLinkUpsert>()
  const removals = new Set<string>()
  const unresolved: FigmaLink[] = []
  const server = new Map(input.server.map((link) => [link.node_id, link]))
  for (const node of input.scanned) {
    if (node.pageId !== input.pageId) {
      continue
    }
    const check = checkFromScanned(node)
    if (!isUpsertable(check, input.projectId)) {
      continue
    }
    const upsert = upsertOf(check)
    const existing = server.get(node.nodeId)
    if (upsert !== null && (existing === undefined || !sameUpsert(existing, upsert))) {
      upserts.set(node.nodeId, upsert)
    }
  }
  for (const link of input.server) {
    if (upserts.has(link.node_id) || removals.has(link.node_id)) {
      continue
    }
    const check = input.checks.get(link.node_id)
    if (check === undefined || check.status === "unreadable") {
      continue
    }
    if (check.status === "not_found") {
      unresolved.push(link)
      continue
    }
    const key = carriedKey(check, input.projectId)
    const upsert = isUpsertable(check, input.projectId) ? upsertOf(check) : null
    if (key === link.key_id) {
      // Same key: refresh moved or renamed layers (another page, frame or name).
      if (upsert !== null && !sameUpsert(link, upsert)) {
        upserts.set(link.node_id, upsert)
      }
    } else if (key !== null && upsert !== null) {
      upserts.set(link.node_id, upsert)
    } else {
      removals.add(link.node_id)
    }
  }
  return { upserts: [...upserts.values()], removals: [...removals], unresolved }
}

// E17 requests: ≤ 500 upserts and ≤ 500 removals each, at least one entry, node ids unique (they come from
// maps keyed by node id).
export function linkRequests(fileKey: string, plan: LinkSyncPlan): FigmaLinksRequest[] {
  const upserts = chunk(plan.upserts, LINKS_BATCH_SIZE)
  const removals = chunk(plan.removals, LINKS_BATCH_SIZE)
  const requests: FigmaLinksRequest[] = []
  for (let index = 0; index < Math.max(upserts.length, removals.length); index++) {
    requests.push({ file_key: fileKey, upserts: upserts[index] ?? [], removed_node_ids: removals[index] ?? [] })
  }
  return requests
}

// link-check in batches of 500 ids (each answered well within the bus watchdog). With `inheritors`, main also
// answers for the current page's instance sublayers that inherit from a checked text inside a component.
export async function checkLinks(bus: Pick<UiBus, "request">, nodeIds: readonly string[], inheritors = false): Promise<Map<string, LinkCheck>> {
  const checks = new Map<string, LinkCheck>()
  for (const batch of chunk([...new Set(nodeIds)], LINK_CHECK_BATCH_SIZE)) {
    const nodes = await bus.request((requestId: RequestId) => (inheritors ? { type: "link-check", requestId, nodeIds: batch, inheritors } : { type: "link-check", requestId, nodeIds: batch }), {
      done: (message) => (message.type === "link-check-result" ? message.nodes : undefined),
    })
    for (const node of nodes) {
      checks.set(node.nodeId, node)
    }
  }
  return checks
}

// Sends the requests one by one and stops at the first failure (403, network…): the rest would fail the same way.
export async function sendLinkRequests(api: Pick<FigmaApi, "upsertLinks">, projectId: string, requests: readonly FigmaLinksRequest[]): Promise<LinkSyncResult> {
  const result = emptyResult()
  for (const request of requests) {
    try {
      const response = await api.upsertLinks(projectId, request)
      result.upserted += response.upserted
      result.removed += response.removed
      result.rejected.push(...response.rejected)
    } catch (error) {
      result.error = userMessage(error)
      break
    }
  }
  return result
}

export async function listPageLinks(api: Pick<FigmaApi, "links">, projectId: string, fileKey: string, pageId: string): Promise<FigmaLink[]> {
  const links: FigmaLink[] = []
  let cursor: string | null = null
  for (let page = 0; page < LINKS_MAX_PAGES; page++) {
    const response = await api.links(projectId, { file_key: fileKey, page_id: pageId, cursor, limit: LINKS_BATCH_SIZE })
    links.push(...response.links)
    if (!response.has_more || response.next_cursor === null || response.next_cursor === cursor) {
      break
    }
    cursor = response.next_cursor
  }
  return links
}

export interface LinkSyncDeps {
  api: Pick<FigmaApi, "upsertLinks" | "links">
  bus: Pick<UiBus, "request">
  projectId(): string | null
  gate(): LinkSyncGate
}

export interface LinkSyncer {
  gate(): LinkSyncGate
  // null: link sync is off for this file or user (§7.11: skipped silently, the banner explains).
  syncNodes(acted: readonly string[], known?: readonly ScannedNode[]): Promise<LinkSyncResult | null>
  syncPage(pageId: string, scanned: readonly ScannedNode[]): Promise<PageSyncResult | null>
  removeServerLinks(nodeIds: readonly string[]): Promise<LinkSyncResult | null>
}

function errorResult(error: unknown): LinkSyncResult {
  return { ...emptyResult(), error: userMessage(error) }
}

export function createLinkSyncer(deps: LinkSyncDeps): LinkSyncer {
  function target(): { fileKey: string; projectId: string } | null {
    const gate = deps.gate()
    const projectId = deps.projectId()
    return gate.enabled && gate.fileKey !== null && projectId !== null ? { fileKey: gate.fileKey, projectId } : null
  }

  return {
    gate: deps.gate,
    async syncNodes(acted, known = []) {
      const to = target()
      if (to === null) {
        return null
      }
      const ids = affectedNodeIds(acted, known).filter(isFigmaNodeId)
      if (ids.length === 0) {
        return emptyResult()
      }
      let checks: Map<string, LinkCheck>
      try {
        checks = await checkLinks(deps.bus, ids, true)
      } catch (error) {
        return errorResult(error)
      }
      const plan = planNodeSync([...checks.values()], to.projectId)
      return sendLinkRequests(deps.api, to.projectId, linkRequests(to.fileKey, plan))
    },
    async syncPage(pageId, scanned) {
      const to = target()
      if (to === null) {
        return null
      }
      let server: FigmaLink[]
      const checks = new Map<string, CheckedNode>()
      try {
        server = await listPageLinks(deps.api, to.projectId, to.fileKey, pageId)
        const scannedById = new Map(scanned.map((node) => [node.nodeId, node]))
        const missing: string[] = []
        for (const link of server) {
          const node = scannedById.get(link.node_id)
          if (node !== undefined) {
            checks.set(link.node_id, checkFromScanned(node))
          } else {
            missing.push(link.node_id)
          }
        }
        for (const [nodeId, check] of await checkLinks(deps.bus, missing)) {
          checks.set(nodeId, check)
        }
      } catch (error) {
        return { ...errorResult(error), serverLinks: 0, unresolved: [] }
      }
      const plan = planPageSync({ projectId: to.projectId, pageId, scanned, server, checks })
      const sent = await sendLinkRequests(deps.api, to.projectId, linkRequests(to.fileKey, plan))
      return { ...sent, serverLinks: server.length, unresolved: plan.unresolved }
    },
    async removeServerLinks(nodeIds) {
      const to = target()
      if (to === null) {
        return null
      }
      const ids = [...new Set(nodeIds)].filter(isFigmaNodeId)
      if (ids.length === 0) {
        return emptyResult()
      }
      return sendLinkRequests(deps.api, to.projectId, linkRequests(to.fileKey, { upserts: [], removals: ids }))
    },
  }
}

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many)
}

// Shown after a link, unlink or push when ReRune's copy of the links could not be updated completely.
export function linkSyncWarning(result: LinkSyncResult | null): string | null {
  if (result === null) {
    return null
  }
  if (result.error !== null) {
    return "The layers' links couldn't be updated in ReRune: " + result.error + " Run Sync links on this page later."
  }
  return rejectedWarning(result.rejected.length)
}

// E17 rejections (key_not_found, not_a_text_key): the layer's key was deleted in ReRune or is a group.
export function rejectedWarning(count: number): string | null {
  return count === 0 ? null : plural(count, "link wasn't", "links weren't") + " saved in ReRune because the key no longer exists or is a group."
}

// One line for the result of "Sync links on this page".
export function pageSyncSummary(result: PageSyncResult): string {
  if (result.error !== null) {
    return "The links couldn't be synced: " + result.error
  }
  const changes = [
    result.upserted > 0 ? plural(result.upserted, "link added or updated", "links added or updated") : null,
    result.removed > 0 ? plural(result.removed, "link removed", "links removed") : null,
  ].filter((part): part is string => part !== null)
  return changes.length === 0 ? "ReRune's links match the layers on this page." : "Links on this page: " + changes.join(", ") + "."
}

export function unresolvedSummary(count: number): string {
  return count === 1 ? "1 link points to a layer not in this file" : count + " links point to layers not in this file"
}
