/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, nodeLink, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaLink, FigmaLinksListResponse, FigmaLinksQuery, FigmaLinksRequest, FigmaLinksResponse } from "../../shared/api-types"
import type { LinkSyncGate } from "../../shared/file-link"
import type { LinkCheck, LinkState, UiToMain } from "../../shared/messages"
import { ApiError, userMessage } from "../api/client"
import { createUiBus } from "../bus"
import {
  affectedNodeIds,
  AUTO_SYNC_RUNNING,
  autoPageSyncNote,
  autoPageSyncStep,
  carriedKey,
  checkLinks,
  cleanLinkName,
  createLinkSyncer,
  createPageSync,
  isUpsertable,
  linkRequests,
  linkSyncWarning,
  listPageLinks,
  OTHER_PAGES_NOTE,
  pageSyncNote,
  pageSyncSummary,
  planNodeSync,
  planPageSync,
  rejectedWarning,
  RUN_ON_LAYERS_LATER,
  SCAN_UNFINISHED,
  sendLinkRequests,
  unresolvedSummary,
  upsertOf,
  type PageSync,
  type PageSyncDeps,
  type PageSyncResult,
} from "./link-sync"
import type { ScanResult } from "./ops"
import { fakeBusEnvironment } from "./test-fakes"
import appSource from "../app.tsx?raw"
import layersSource from "../screens/layers.tsx?raw"

const FILE_KEY = "AbCdEf1234567890XyZ"
const K1 = keyId(1)
const K2 = keyId(2)
const ON: LinkSyncGate = { enabled: true, reason: null, fileKey: FILE_KEY }

function check(nodeId: string, overrides: Partial<LinkCheck> = {}): LinkCheck {
  return {
    nodeId,
    status: "found",
    linkState: "ok",
    link: nodeLink(K1, "checkout_pay_button", "Pay now", nodeId),
    name: "Pay button",
    pageId: "0:1",
    pageName: "Mobile",
    frameId: "10:1",
    frameName: "Checkout",
    ...overrides,
  }
}

function linkedCheck(nodeId: string, state: LinkState, key = K1, projectId = PROJECT_ID): LinkCheck {
  return check(nodeId, { linkState: state, link: nodeLink(key, "k", "Pay now", state === "ok" ? nodeId : "5:67", projectId) })
}

function serverLink(nodeId: string, overrides: Partial<FigmaLink> = {}): FigmaLink {
  return {
    node_id: nodeId,
    key_id: K1,
    key: "checkout_pay_button",
    file_key: FILE_KEY,
    frame_id: "10:1",
    frame_name: "Checkout",
    page_id: "0:1",
    page_name: "Mobile",
    node_name: "Pay button",
    figma_url: "https://www.figma.com/design/" + FILE_KEY + "/Chapter?node-id=10-1",
    updated_at: "2026-10-27T10:00:00Z",
    ...overrides,
  }
}

function upsertFor(nodeId: string, key = K1, extra: Record<string, string> = {}) {
  return { node_id: nodeId, key_id: key, frame_id: "10:1", frame_name: "Checkout", page_id: "0:1", page_name: "Mobile", node_name: "Pay button", ...extra }
}

describe("what a layer shows (carriedKey, isUpsertable)", () => {
  it("names the key for own, inherited and copied links of this project", () => {
    expect(carriedKey(linkedCheck("1:1", "ok"), PROJECT_ID)).toBe(K1)
    expect(carriedKey(linkedCheck("I2:2;5:67", "inherited"), PROJECT_ID)).toBe(K1)
    expect(carriedKey(linkedCheck("1:3", "copied"), PROJECT_ID)).toBe(K1)
    expect(isUpsertable(linkedCheck("1:1", "ok"), PROJECT_ID)).toBe(true)
    expect(isUpsertable(linkedCheck("I2:2;5:67", "inherited"), PROJECT_ID)).toBe(true)
    expect(isUpsertable(linkedCheck("1:3", "copied"), PROJECT_ID)).toBe(false)
  })

  it("names no key for unlinked, broken, overridden, other-project and missing layers", () => {
    expect(carriedKey(check("1:1", { linkState: "none", link: null }), PROJECT_ID)).toBeNull()
    expect(carriedKey(check("1:1", { linkState: "invalid", link: null }), PROJECT_ID)).toBeNull()
    expect(carriedKey(linkedCheck("I2:2;5:67", "inherited_overridden"), PROJECT_ID)).toBeNull()
    expect(carriedKey(linkedCheck("1:1", "ok", K1, OTHER_PROJECT_ID), PROJECT_ID)).toBeNull()
    expect(carriedKey(check("1:1", { status: "not_found" }), PROJECT_ID)).toBeNull()
  })
})

describe("upsertOf", () => {
  it("builds the E17 upsert with trimmed names cut to 200 runes", () => {
    expect(upsertOf(check("12:345", { name: "  Pay button ", frameName: "Checkout", pageName: "😀".repeat(250) }))).toEqual({
      node_id: "12:345",
      key_id: K1,
      frame_id: "10:1",
      frame_name: "Checkout",
      page_id: "0:1",
      page_name: "😀".repeat(200),
      node_name: "Pay button",
    })
    expect(cleanLinkName("  x  ")).toBe("x")
  })

  it("trims names as the server's strings.TrimSpace does: U+0085 yes, U+FEFF no", () => {
    const nel = String.fromCharCode(0x85)
    const bom = String.fromCharCode(0xfeff)
    expect(cleanLinkName("Checkout" + nel)).toBe("Checkout")
    expect(cleanLinkName(nel + String.fromCharCode(0xa0) + "Pay button" + String.fromCharCode(0x3000))).toBe("Pay button")
    expect(cleanLinkName(bom + "Checkout")).toBe(bom + "Checkout")
    expect(cleanLinkName(nel + "a".repeat(250))).toBe("a".repeat(200))
  })

  it("sends an empty frame for layers outside a frame and drops layers with invalid identifiers", () => {
    expect(upsertOf(check("12:345", { frameId: null, frameName: null }))).toMatchObject({ frame_id: "", frame_name: "" })
    expect(upsertOf(check("12:345", { pageId: "" }))).toBeNull()
    expect(upsertOf(check("12:345", { frameId: "x" }))).toBeNull()
    expect(upsertOf(check("bad", {}))).toBeNull()
    expect(upsertOf(check("12:345", { link: { ...nodeLink(K1, "k", "x", "12:345"), id: "nope" } }))).toBeNull()
  })
})

describe("affectedNodeIds", () => {
  it("adds instance sublayers that inherit from a written layer, by id suffix or nid, nested included", () => {
    const known = [
      scannedNode("I12:34;5:67", "Pay"),
      scannedNode("I30:1;20:1;5:67", "Pay"),
      linkedNode("I40:1;7:7", "Pay", { keyId: K1, keyName: "k", syncedText: "Pay", nid: "5:67", state: "inherited" }),
      scannedNode("I50:1;5:68", "Other"),
      scannedNode("5:670", "Not an instance"),
      scannedNode("I60:1;12:34;5:67", "Nested in an instance with its own link"),
    ]
    expect(affectedNodeIds(["5:67"], known).sort()).toEqual(["5:67", "I12:34;5:67", "I30:1;20:1;5:67", "I40:1;7:7", "I60:1;12:34;5:67"].sort())
    expect(affectedNodeIds(["I12:34;5:67"], known).sort()).toEqual(["I12:34;5:67", "I60:1;12:34;5:67"].sort())
    expect(affectedNodeIds(["1:1", "1:1"])).toEqual(["1:1"])
  })
})

describe("planNodeSync (after link, unlink and push)", () => {
  it("upserts layers that show a key, removes existing layers that show none, and leaves the rest alone", () => {
    const plan = planNodeSync(
      [
        linkedCheck("1:1", "ok"),
        linkedCheck("I2:2;5:67", "inherited"),
        check("1:3", { linkState: "none", link: null }),
        linkedCheck("I4:4;5:67", "inherited_overridden"),
        check("1:5", { linkState: "invalid", link: null }),
        linkedCheck("1:6", "ok", K1, OTHER_PROJECT_ID),
        linkedCheck("1:7", "copied"),
        check("1:8", { status: "not_found", linkState: "none", link: null }),
        check("1:9", { status: "unreadable", linkState: "none", link: null }),
      ],
      PROJECT_ID,
    )
    expect(plan.upserts.map((upsert) => upsert.node_id)).toEqual(["1:1", "I2:2;5:67"])
    expect(plan.removals).toEqual(["1:3", "I4:4;5:67", "1:5", "1:6"])
  })

  it("never removes a layer that resolves to null (D43)", () => {
    expect(planNodeSync([check("1:8", { status: "not_found", linkState: "none", link: null })], PROJECT_ID)).toEqual({ upserts: [], removals: [] })
  })
})

describe("planPageSync (§7.15 page link sync)", () => {
  const base = { projectId: PROJECT_ID, pageId: "0:1" }

  it("lists a server link whose layer resolves to null and does not remove it", () => {
    const plan = planPageSync({ ...base, scanned: [], server: [serverLink("12:999")], checks: new Map([["12:999", check("12:999", { status: "not_found", linkState: "none", link: null })]]) })
    expect(plan.removals).toEqual([])
    expect(plan.upserts).toEqual([])
    expect(plan.unresolved.map((link) => link.node_id)).toEqual(["12:999"])
  })

  it("removes a server link whose layer now carries a link to another key", () => {
    const copiedOther = linkedCheck("12:345", "copied", K2)
    const plan = planPageSync({ ...base, scanned: [], server: [serverLink("12:345")], checks: new Map([["12:345", copiedOther]]) })
    expect(plan.removals).toEqual(["12:345"])
    expect(plan.unresolved).toEqual([])
  })

  it("replaces the key of a server link whose layer is now linked to another key of the project", () => {
    const relinked = linkedNode("12:345", "Cancel", { keyId: K2, keyName: "cancel", syncedText: "Cancel" }, { name: "Pay button" })
    const plan = planPageSync({ ...base, scanned: [relinked], server: [serverLink("12:345")], checks: new Map() })
    expect(plan.upserts).toEqual([upsertFor("12:345", K2)])
    expect(plan.removals).toEqual([])
  })

  it("removes server links of existing layers that carry no link, an overridden instance text or another project's key", () => {
    const scanned = [
      scannedNode("12:1", "Unlinked", { name: "Pay button" }),
      linkedNode("I12:2;5:67", "Buy", { keyId: K1, keyName: "k", syncedText: "Pay", nid: "5:67", state: "inherited_overridden" }),
      linkedNode("12:3", "Pay", { keyId: K1, keyName: "k", syncedText: "Pay", projectId: OTHER_PROJECT_ID }),
    ]
    const checks = new Map<string, LinkCheck>()
    const plan = planPageSync({ ...base, scanned, server: [serverLink("12:1"), serverLink("I12:2;5:67"), serverLink("12:3")], checks: withScanned(checks, scanned) })
    expect(plan.removals).toEqual(["12:1", "I12:2;5:67", "12:3"])
    expect(plan.upserts).toEqual([])
  })

  it("upserts linked layers ReRune lacks and leaves matching links untouched", () => {
    const scanned = [
      linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Pay button" }),
      linkedNode("I12:34;5:67", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now", nid: "5:67", state: "inherited" }, { name: "Pay button" }),
      linkedNode("12:7", "Copy", { keyId: K1, keyName: "k", syncedText: "Copy", nid: "12:345", state: "copied" }),
      scannedNode("12:8", "Plain"),
      linkedNode("12:9", "Elsewhere", { keyId: K1, keyName: "k", syncedText: "Elsewhere" }, { pageId: "0:2" }),
    ]
    const plan = planPageSync({ ...base, scanned, server: [serverLink("12:345")], checks: withScanned(new Map(), scanned) })
    expect(plan.upserts).toEqual([upsertFor("I12:34;5:67")])
    expect(plan.removals).toEqual([])
    expect(plan.unresolved).toEqual([])
  })

  it("leaves a link alone whose names differ from ReRune's only by what the server trims (U+0085)", () => {
    const nel = String.fromCharCode(0x85)
    const bom = String.fromCharCode(0xfeff)
    const scanned = [
      linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Pay button" + nel, frameName: "Checkout" + nel, pageName: nel + "Mobile" }),
      linkedNode("12:346", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: bom + "Pay button" }),
    ]
    const server = [serverLink("12:345"), serverLink("12:346", { node_name: bom + "Pay button" })]
    expect(planPageSync({ ...base, scanned, server, checks: withScanned(new Map(), scanned) })).toEqual({ upserts: [], removals: [], unresolved: [] })
  })

  it("refreshes moved or renamed layers that keep their key, also when only link-check found them", () => {
    const renamed = linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Primary button" })
    const moved = linkedCheck("12:400", "ok")
    moved.pageId = "0:2"
    moved.pageName = "Desktop"
    const plan = planPageSync({
      ...base,
      scanned: [renamed],
      server: [serverLink("12:345"), serverLink("12:400")],
      checks: withScanned(new Map([["12:400", moved]]), [renamed]),
    })
    expect(plan.upserts).toEqual([upsertFor("12:345", K1, { node_name: "Primary button" }), upsertFor("12:400", K1, { page_id: "0:2", page_name: "Desktop" })])
  })

  it("keeps server links of hidden, locked, copied or unreadable layers that still show the key", () => {
    const hidden = linkedCheck("12:500", "ok")
    const copied = linkedCheck("12:501", "copied")
    const unreadable = check("12:502", { status: "unreadable", linkState: "none", link: null })
    const plan = planPageSync({
      ...base,
      scanned: [],
      server: [serverLink("12:500"), serverLink("12:501"), serverLink("12:502"), serverLink("12:503")],
      checks: new Map([["12:500", hidden], ["12:501", copied], ["12:502", unreadable]]),
    })
    expect(plan).toEqual({ upserts: [], removals: [], unresolved: [] })
  })
})

function withScanned(checks: Map<string, LinkCheck>, nodes: ReturnType<typeof scannedNode>[]): Map<string, LinkCheck> {
  for (const node of nodes) {
    checks.set(node.nodeId, { nodeId: node.nodeId, status: "found", linkState: node.linkState, link: node.link, name: node.name, pageId: node.pageId, pageName: node.pageName, frameId: node.frameId, frameName: node.frameName })
  }
  return checks
}

describe("linkRequests", () => {
  it("chunks upserts and removals at 500 each and never sends an empty request", () => {
    const upserts = Array.from({ length: 1200 }, (_, index) => upsertFor("12:" + index))
    const removals = Array.from({ length: 300 }, (_, index) => "13:" + index)
    const requests = linkRequests(FILE_KEY, { upserts, removals })
    expect(requests.map((request) => [request.upserts.length, request.removed_node_ids.length])).toEqual([[500, 300], [500, 0], [200, 0]])
    expect(requests.every((request) => request.file_key === FILE_KEY)).toBe(true)
    expect(linkRequests(FILE_KEY, { upserts: [], removals: [] })).toEqual([])
    expect(linkRequests(FILE_KEY, { upserts: [], removals: ["1:1"] })).toEqual([{ file_key: FILE_KEY, upserts: [], removed_node_ids: ["1:1"] }])
  })
})

// A main thread that answers link-check from a table (unknown ids → not_found), plus `inheritors` when asked.
function checkingBus(table: Record<string, LinkCheck>, inheritors: LinkCheck[] = []) {
  const posted: UiToMain[] = []
  const fake = fakeBusEnvironment((message, deliver) => {
    posted.push(message)
    if (message.type === "link-check") {
      deliver({
        type: "link-check-result",
        requestId: message.requestId,
        nodes: message.nodeIds.map((nodeId) => table[nodeId] ?? check(nodeId, { status: "not_found", linkState: "none", link: null })).concat(message.inheritors === true ? inheritors : []),
      })
    }
  })
  return { bus: createUiBus(fake.environment), posted }
}

function linksApi(pages: FigmaLinksListResponse[] = [], answer: (request: FigmaLinksRequest) => FigmaLinksResponse | Promise<FigmaLinksResponse> = (request) => ({ upserted: request.upserts.length, removed: request.removed_node_ids.length, rejected: [] })) {
  let page = 0
  return {
    links: vi.fn(async (_projectId: string, query: FigmaLinksQuery) => {
      void query
      return pages[page++] ?? { links: [], next_cursor: null, has_more: false }
    }),
    upsertLinks: vi.fn(async (_projectId: string, request: FigmaLinksRequest) => answer(request)),
  }
}

describe("checkLinks", () => {
  it("asks main in batches of 500 ids and maps the answers by node id", async () => {
    const { bus, posted } = checkingBus({ "1:1": check("1:1") })
    const ids = Array.from({ length: 1001 }, (_, index) => "2:" + index).concat(["1:1", "1:1"])
    const checks = await checkLinks(bus, ids)
    const sent = posted.filter((message): message is Extract<UiToMain, { type: "link-check" }> => message.type === "link-check")
    expect(sent.map((message) => message.nodeIds.length)).toEqual([500, 500, 2])
    expect(checks.size).toBe(1002)
    expect(checks.get("1:1")?.status).toBe("found")
    expect(checks.get("2:0")?.status).toBe("not_found")
  })
})

describe("sendLinkRequests and listPageLinks", () => {
  it("adds up the answers and stops at the first failure", async () => {
    let calls = 0
    const api = linksApi([], (request) => {
      calls++
      if (calls === 2) {
        throw new ApiError(403, null, "Forbidden")
      }
      return { upserted: request.upserts.length, removed: 0, rejected: [{ node_id: "12:1", reason: "key_not_found" }] }
    })
    const requests = [1, 2, 3].map((n) => ({ file_key: FILE_KEY, upserts: [upsertFor("12:" + n)], removed_node_ids: [] }))
    const result = await sendLinkRequests(api, PROJECT_ID, requests)
    expect(result).toEqual({ upserted: 1, removed: 0, rejected: [{ node_id: "12:1", reason: "key_not_found" }], error: "You don't have permission to do this in this project." })
    expect(api.upsertLinks).toHaveBeenCalledTimes(2)
  })

  it("follows E18 cursors with pages of 500 and stops when the cursor repeats", async () => {
    const api = linksApi([
      { links: [serverLink("1:1")], next_cursor: "c1", has_more: true },
      { links: [serverLink("1:2")], next_cursor: "c2", has_more: true },
      { links: [serverLink("1:3")], next_cursor: null, has_more: false },
    ])
    expect((await listPageLinks(api, PROJECT_ID, FILE_KEY, "0:1")).map((link) => link.node_id)).toEqual(["1:1", "1:2", "1:3"])
    expect(api.links.mock.calls.map((call) => call[1])).toEqual([
      { file_key: FILE_KEY, page_id: "0:1", cursor: null, limit: 500 },
      { file_key: FILE_KEY, page_id: "0:1", cursor: "c1", limit: 500 },
      { file_key: FILE_KEY, page_id: "0:1", cursor: "c2", limit: 500 },
    ])
    const looping = linksApi([
      { links: [serverLink("1:1")], next_cursor: "same", has_more: true },
      { links: [serverLink("1:2")], next_cursor: "same", has_more: true },
    ])
    expect(await listPageLinks(looping, PROJECT_ID, FILE_KEY, "0:1")).toHaveLength(2)
    expect(looping.links).toHaveBeenCalledTimes(2)
  })
})

describe("createLinkSyncer", () => {
  it("does nothing while link sync is off (no file link, branch, copy, no edit_keys)", async () => {
    for (const reason of ["no_file", "branch", "possible_copy", "no_permission"] as const) {
      const api = linksApi()
      const { bus, posted } = checkingBus({})
      const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ({ enabled: false, reason, fileKey: null }) })
      expect(await syncer.syncNodes(["1:1"])).toBeNull()
      expect(await syncer.syncPage("0:1", [])).toBeNull()
      expect(await syncer.removeServerLinks(["1:1"])).toBeNull()
      expect(api.links).not.toHaveBeenCalled()
      expect(api.upsertLinks).not.toHaveBeenCalled()
      expect(posted).toEqual([])
    }
  })

  it("syncs the page's instances of a linked main component text that the last scan did not include (§7.11, §7.15)", async () => {
    const api = linksApi()
    // Selection scope: only the main component was scanned; main reports its instances on the page.
    const { bus, posted } = checkingBus({ "5:67": linkedCheck("5:67", "ok") }, [linkedCheck("I12:34;5:67", "inherited"), linkedCheck("I12:40;3:2;5:67", "inherited"), check("I12:50;5:67", { linkState: "inherited_overridden" })])
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const result = await syncer.syncNodes(["5:67"], [scannedNode("5:67", "Pay now")])
    expect(posted).toEqual([expect.objectContaining({ type: "link-check", nodeIds: ["5:67"], inheritors: true })])
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, {
      file_key: FILE_KEY,
      upserts: [upsertFor("5:67"), upsertFor("I12:34;5:67"), upsertFor("I12:40;3:2;5:67")],
      removed_node_ids: ["I12:50;5:67"],
    })
    expect(result).toEqual({ upserted: 3, removed: 1, rejected: [], error: null })
  })

  it("syncs the written layers and the instances that inherit from them after a link or unlink", async () => {
    const api = linksApi()
    const { bus, posted } = checkingBus({
      "5:67": linkedCheck("5:67", "ok"),
      "I12:34;5:67": linkedCheck("I12:34;5:67", "inherited"),
      "1:2": check("1:2", { linkState: "none", link: null }),
    })
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const result = await syncer.syncNodes(["5:67", "1:2", "1:9"], [scannedNode("I12:34;5:67", "Pay now"), scannedNode("I77:1;8:8", "Other")])
    expect(posted[0]).toMatchObject({ type: "link-check", nodeIds: ["5:67", "1:2", "1:9", "I12:34;5:67"], inheritors: true })
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, {
      file_key: FILE_KEY,
      upserts: [upsertFor("5:67"), upsertFor("I12:34;5:67")],
      removed_node_ids: ["1:2"],
    })
    expect(result).toEqual({ upserted: 2, removed: 1, rejected: [], error: null })
  })

  it("reports a failed link check or E17 call instead of throwing", async () => {
    const failing = fakeBusEnvironment((message, deliver) => {
      if (message.type === "link-check") {
        deliver({ type: "handler-error", forType: "link-check", requestId: message.requestId, message: "The canvas is busy" })
      }
    })
    const api = linksApi()
    const syncer = createLinkSyncer({ api, bus: createUiBus(failing.environment), projectId: () => PROJECT_ID, gate: () => ON })
    expect(await syncer.syncNodes(["1:1"])).toEqual({ upserted: 0, removed: 0, rejected: [], error: "The canvas is busy" })
    expect(api.upsertLinks).not.toHaveBeenCalled()

    const offline = linksApi([], () => {
      throw new ApiError(0, "network", "Can't reach ReRune. Check your connection.")
    })
    const { bus } = checkingBus({ "1:1": linkedCheck("1:1", "ok") })
    const result = await createLinkSyncer({ api: offline, bus, projectId: () => PROJECT_ID, gate: () => ON }).syncNodes(["1:1"])
    expect(result?.error).toBe("Can't reach ReRune. Check your connection.")
    expect(linkSyncWarning(result)).toContain("Run Sync links on this page later.")
  })

  it("skips the network when nothing is left to sync", async () => {
    const api = linksApi()
    const { bus, posted } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    expect(await syncer.syncNodes(["not-a-node-id"])).toEqual({ upserted: 0, removed: 0, rejected: [], error: null })
    expect(await syncer.syncNodes(["1:404"])).toEqual({ upserted: 0, removed: 0, rejected: [], error: null })
    expect(posted.map((message) => message.type)).toEqual(["link-check"])
    expect(api.upsertLinks).not.toHaveBeenCalled()
  })

  it("syncs a page: scanned layers answer for themselves, the rest are checked, null layers are listed", async () => {
    const scanned = [
      linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Pay button" }),
      linkedNode("12:346", "Cancel", { keyId: K2, keyName: "cancel", syncedText: "Cancel" }, { name: "Pay button" }),
      scannedNode("12:347", "Plain", { name: "Pay button" }),
    ]
    const api = linksApi([
      { links: [serverLink("12:345"), serverLink("12:347"), serverLink("12:900")], next_cursor: "c1", has_more: true },
      { links: [serverLink("12:901"), serverLink("12:902", { key_id: K2 })], next_cursor: null, has_more: false },
    ])
    const { bus, posted } = checkingBus({ "12:901": linkedCheck("12:901", "copied", K2), "12:902": linkedCheck("12:902", "ok", K2) })
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const result = await syncer.syncPage("0:1", scanned)
    expect(posted).toEqual([expect.objectContaining({ type: "link-check", nodeIds: ["12:900", "12:901", "12:902"] })])
    expect(posted[0]).not.toHaveProperty("inheritors")
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, {
      file_key: FILE_KEY,
      upserts: [upsertFor("12:346", K2)],
      removed_node_ids: ["12:347", "12:901"],
    })
    expect(result).toMatchObject({ upserted: 1, removed: 2, error: null, serverLinks: 5, heldBack: 0 })
    expect(result?.unresolved.map((link) => link.node_id)).toEqual(["12:900"])
    expect(pageSyncSummary(result!)).toBe("Links on this page: 1 link added or updated, 2 links removed.")
    expect(unresolvedSummary(result!.unresolved.length)).toBe("1 link points to a layer not in this file")
  })

  it("syncs a page without removals for the automatic run: removals and unresolved links are only counted", async () => {
    const scanned = [
      linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Pay button" }),
      linkedNode("12:346", "Cancel", { keyId: K2, keyName: "cancel", syncedText: "Cancel" }, { name: "Pay button" }),
      scannedNode("12:347", "Plain", { name: "Pay button" }),
    ]
    const api = linksApi([{ links: [serverLink("12:345"), serverLink("12:347"), serverLink("12:900"), serverLink("12:901")], next_cursor: null, has_more: false }])
    const { bus } = checkingBus({ "12:901": linkedCheck("12:901", "copied", K2) })
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const result = await syncer.syncPage("0:1", scanned, { removals: false })
    expect(api.upsertLinks).toHaveBeenCalledTimes(1)
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, { file_key: FILE_KEY, upserts: [upsertFor("12:346", K2)], removed_node_ids: [] })
    expect(result).toEqual({ upserted: 1, removed: 0, rejected: [], error: null, serverLinks: 4, unresolved: [], heldBack: 3 })
  })

  it("reports a failed listing without writing anything", async () => {
    const api = { links: vi.fn(async () => Promise.reject(new ApiError(500, null, "boom"))), upsertLinks: vi.fn() }
    const { bus } = checkingBus({})
    const result = await createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON }).syncPage("0:1", [])
    expect(result).toEqual({ upserted: 0, removed: 0, rejected: [], error: "ReRune had a problem. Try again.", serverLinks: 0, unresolved: [], heldBack: 0 })
    expect(api.upsertLinks).not.toHaveBeenCalled()
    expect(pageSyncSummary(result!)).toBe("The links couldn't be synced: ReRune had a problem. Try again.")
  })

  it("removes listed links only through the explicit Remove", async () => {
    const api = linksApi()
    const { bus, posted } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    expect(await syncer.removeServerLinks(["12:900", "12:900", "12:901"])).toEqual({ upserted: 0, removed: 2, rejected: [], error: null })
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, { file_key: FILE_KEY, upserts: [], removed_node_ids: ["12:900", "12:901"] })
    expect(posted).toEqual([])
  })
})

describe("createPageSync (the button, and the automatic run after a saved or confirmed file link, §7.7)", () => {
  const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
  const LINKED = [
    linkedNode("12:345", "Pay now", { keyId: K1, keyName: "k", syncedText: "Pay now" }, { name: "Pay button" }),
    linkedNode("12:346", "Cancel", { keyId: K2, keyName: "cancel", syncedText: "Cancel" }, { name: "Pay button" }),
  ]
  const FREE = { syncEnabled: true, readOnly: false, busy: false }
  const SYNCED: PageSyncResult = { upserted: 2, removed: 0, rejected: [], error: null, serverLinks: 0, unresolved: [], heldBack: 0 }

  function page(nodes: ReturnType<typeof scannedNode>[]): ScanResult {
    return { scope: "page", nodes, total: nodes.length, truncated: false, skipped: SKIPPED }
  }

  // Resolves once no page sync runs (the automatic run is started by offer() and not awaited by the app).
  function idle(pageSync: PageSync): Promise<void> {
    return new Promise((resolve) => {
      if (pageSync.store.get().running === null) {
        resolve()
        return
      }
      const off = pageSync.store.subscribe((state) => {
        if (state.running === null) {
          off()
          resolve()
        }
      })
    })
  }

  // The scans answer from the queues (null: cancelled); syncPage answers SYNCED unless given.
  function harness(overrides: Partial<PageSyncDeps> = {}) {
    const deps = {
      scanPage: vi.fn(async (): Promise<ScanResult | null> => page(LINKED)),
      scanError: vi.fn((): string | null => null),
      scanPageDetached: vi.fn(async (): Promise<ScanResult | null> => page(LINKED)),
      syncPage: vi.fn(async (): Promise<PageSyncResult | null> => SYNCED),
      ...overrides,
    }
    return { deps, pageSync: createPageSync(deps) }
  }

  it("sends the links made before the file had its link once link sync is on, without changing the tabs (§7.7)", async () => {
    let gate: LinkSyncGate = { enabled: false, reason: "no_file", fileKey: null }
    const api = linksApi()
    const { bus } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => gate })
    // Linked without a file link: the layers keep their links, nothing reaches ReRune.
    expect(await syncer.syncNodes(["12:345", "12:346"], LINKED)).toBeNull()
    expect(api.upsertLinks).not.toHaveBeenCalled()

    gate = ON
    const { deps, pageSync } = harness({ syncPage: (pageId, scanned, options) => syncer.syncPage(pageId, scanned, options) })
    pageSync.request()
    expect(pageSync.offer("0:1", FREE)).toBe("run")
    expect(pageSync.store.get()).toMatchObject({ running: "auto", requested: false })
    await idle(pageSync)
    expect(deps.scanPageDetached).toHaveBeenCalledTimes(1)
    expect(deps.scanPage).not.toHaveBeenCalled()
    expect(api.links).toHaveBeenCalledWith(PROJECT_ID, { file_key: FILE_KEY, page_id: "0:1", cursor: null, limit: 500 })
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, { file_key: FILE_KEY, upserts: [upsertFor("12:345"), upsertFor("12:346", K2)], removed_node_ids: [] })
    const note = pageSync.store.get().auto
    expect(note).toMatchObject({ pageId: "0:1", error: null, result: { upserted: 2, removed: 0, heldBack: 0 } })
    expect(autoPageSyncNote(note!)).toBe("Link sync is on. Links on this page: 2 links added or updated. " + OTHER_PAGES_NOTE)
  })

  it("never removes links on its own and leaves the unresolved list to the button (D43, FIG-7)", async () => {
    // As in a copy of the file whose original's link was pasted: 12:347 exists without a link, 12:900 is not found.
    const listing = { links: [serverLink("12:345"), serverLink("12:347"), serverLink("12:900")], next_cursor: null, has_more: false }
    const api = linksApi([listing, listing])
    const { bus } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const scanned = [LINKED[0], scannedNode("12:347", "Plain", { name: "Pay button" })]
    const { pageSync } = harness({
      scanPage: async () => page(scanned),
      scanPageDetached: async () => page(scanned),
      syncPage: (pageId, nodes, options) => syncer.syncPage(pageId, nodes, options),
    })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    await idle(pageSync)
    expect(api.upsertLinks).not.toHaveBeenCalled()
    const note = pageSync.store.get().auto
    expect(note?.result).toMatchObject({ upserted: 0, removed: 0, unresolved: [], heldBack: 2 })
    expect(autoPageSyncNote(note!)).toBe(
      "Link sync is on. ReRune already has the links on this page. ReRune also has 2 links on this page that no longer match their layers. Run Sync links on this page on Layers to review them. " + OTHER_PAGES_NOTE,
    )

    // The button removes 12:347 and lists 12:900 with Remove.
    const run = await pageSync.start("0:1")
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, { file_key: FILE_KEY, upserts: [], removed_node_ids: ["12:347"] })
    expect(run?.result?.unresolved.map((link) => link.node_id)).toEqual(["12:900"])
  })

  it("waits while the app is busy, then runs once per request", async () => {
    const { deps, pageSync } = harness()
    expect(pageSync.offer("0:1", FREE)).toBeNull()
    pageSync.request()
    expect(pageSync.offer("0:1", { ...FREE, busy: true })).toBe("wait")
    expect(pageSync.store.get().requested).toBe(true)
    expect(deps.scanPageDetached).not.toHaveBeenCalled()
    expect(pageSync.offer("0:1", FREE)).toBe("run")
    expect(pageSync.offer("0:1", FREE)).toBeNull()
    await idle(pageSync)
    expect(pageSync.offer("0:1", FREE)).toBeNull()
    expect(deps.scanPageDetached).toHaveBeenCalledTimes(1)
    expect(deps.syncPage).toHaveBeenCalledTimes(1)
    expect(deps.syncPage).toHaveBeenCalledWith("0:1", LINKED, { removals: false })
  })

  it("asks again when its scan is cancelled (a newer scan, a page change), so the links are not left behind", async () => {
    const scanPageDetached = vi.fn<() => Promise<ScanResult | null>>().mockResolvedValueOnce(null).mockResolvedValue(page(LINKED))
    const { deps, pageSync } = harness({ scanPageDetached })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    await idle(pageSync)
    expect(pageSync.store.get()).toEqual({ running: null, requested: true, auto: null })
    expect(deps.syncPage).not.toHaveBeenCalled()
    expect(pageSync.offer("0:2", FREE)).toBe("run")
    await idle(pageSync)
    expect(scanPageDetached).toHaveBeenCalledTimes(2)
    expect(deps.syncPage).toHaveBeenCalledWith("0:2", LINKED, { removals: false })
    expect(pageSync.store.get()).toMatchObject({ requested: false, auto: { pageId: "0:2", result: SYNCED, error: null } })
  })

  it("runs one page sync at a time: a click during the automatic run starts nothing, a request waits for the button", async () => {
    let finishScan: (result: ScanResult | null) => void = () => {}
    const scanPageDetached = vi.fn(() => new Promise<ScanResult | null>((resolve) => (finishScan = resolve)))
    const scanPage = vi.fn(async (): Promise<ScanResult | null> => page(LINKED))
    const { deps, pageSync } = harness({ scanPage, scanPageDetached })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    expect(pageSync.start("0:1")).toBeNull()
    expect(scanPage).not.toHaveBeenCalled()
    finishScan(page(LINKED))
    await idle(pageSync)

    let finishButton: (result: ScanResult | null) => void = () => {}
    scanPage.mockImplementationOnce(() => new Promise<ScanResult | null>((resolve) => (finishButton = resolve)))
    const button = pageSync.start("0:1")
    expect(button).not.toBeNull()
    expect(pageSync.store.get().running).toBe("button")
    pageSync.request()
    expect(pageSync.offer("0:1", FREE)).toBe("wait")
    finishButton(page(LINKED))
    expect(await button).toEqual({ result: SYNCED, error: null })
    expect(deps.syncPage).toHaveBeenLastCalledWith("0:1", LINKED, { removals: true })
    expect(pageSync.offer("0:1", FREE)).toBe("run")
    finishScan(page(LINKED))
    await idle(pageSync)
    expect(scanPageDetached).toHaveBeenCalledTimes(2)
  })

  it("is dropped when link sync is off by then, or for another server's file", () => {
    const { deps, pageSync } = harness()
    pageSync.request()
    expect(pageSync.offer("0:1", { ...FREE, syncEnabled: false, busy: true })).toBe("drop")
    expect(pageSync.store.get().requested).toBe(false)
    pageSync.request()
    expect(pageSync.offer("0:1", { ...FREE, readOnly: true })).toBe("drop")
    expect(pageSync.offer("0:1", FREE)).toBeNull()
    expect(deps.scanPageDetached).not.toHaveBeenCalled()
  })

  it("is discarded by reset (sign-out, another project), also while it runs", async () => {
    const scanPageDetached = vi.fn<() => Promise<ScanResult | null>>().mockResolvedValueOnce(null).mockResolvedValue(page(LINKED))
    const { pageSync } = harness({ scanPageDetached })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    pageSync.reset()
    await idle(pageSync)
    // The cancelled scan does not ask again after reset.
    expect(pageSync.store.get()).toEqual({ running: null, requested: false, auto: null })

    pageSync.request()
    pageSync.offer("0:1", FREE)
    pageSync.reset()
    await idle(pageSync)
    expect(pageSync.store.get()).toEqual({ running: null, requested: false, auto: null })

    pageSync.request()
    pageSync.offer("0:1", FREE)
    await idle(pageSync)
    expect(pageSync.store.get().auto).not.toBeNull()
    pageSync.dismiss()
    expect(pageSync.store.get().auto).toBeNull()
  })

  it("reports a failed scan or sync in its note and does not ask again", async () => {
    const failing = harness({ scanPageDetached: () => Promise.reject(new Error("The plugin stopped responding. Try again.")) })
    failing.pageSync.request()
    failing.pageSync.offer("0:1", FREE)
    await idle(failing.pageSync)
    const note = failing.pageSync.store.get().auto
    expect(failing.pageSync.store.get().requested).toBe(false)
    expect(note).toEqual({ pageId: "0:1", result: null, error: "The plugin stopped responding. Try again." })
    expect(autoPageSyncNote(note!)).toBe("Link sync is on, but the links on this page couldn't be shared: The plugin stopped responding. Try again. " + RUN_ON_LAYERS_LATER)
    expect(failing.deps.syncPage).not.toHaveBeenCalled()
  })

  it.each([
    ["network", new ApiError(0, "network", "Can't reach ReRune. Check your connection.")],
    ["403", new ApiError(403, "forbidden", "forbidden")],
    ["429", new ApiError(429, "rate_limited", "rate limited")],
  ])("shows the sync's error when the automatic run fails (%s)", async (_label, failure) => {
    const api = { links: vi.fn(async () => Promise.reject(failure)), upsertLinks: vi.fn() }
    const { bus } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const { pageSync } = harness({ syncPage: (pageId, scanned, options) => syncer.syncPage(pageId, scanned, options) })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    await idle(pageSync)
    expect(api.upsertLinks).not.toHaveBeenCalled()
    const note = autoPageSyncNote(pageSync.store.get().auto!)
    expect(note).toBe("Link sync is on, but the links on this page couldn't be shared: " + userMessage(failure) + " " + RUN_ON_LAYERS_LATER)
    expect(note).not.toContain(OTHER_PAGES_NOTE)
  })

  it("leaves no note while link sync is off at the syncer", async () => {
    const api = linksApi()
    const { bus, posted } = checkingBus({})
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ({ enabled: false, reason: "possible_copy", fileKey: null }) })
    const { pageSync } = harness({ syncPage: (pageId, scanned, options) => syncer.syncPage(pageId, scanned, options) })
    pageSync.request()
    pageSync.offer("0:1", FREE)
    await idle(pageSync)
    expect(pageSync.store.get()).toEqual({ running: null, requested: false, auto: null })
    expect(api.links).not.toHaveBeenCalled()
    expect(posted).toEqual([])
  })

  it("reports the button's scan that did not finish or failed, without syncing", async () => {
    const syncPage = vi.fn()
    expect(await harness({ scanPage: async () => null, scanError: () => "The canvas is busy", syncPage }).pageSync.start("0:1")).toEqual({ result: null, error: "The canvas is busy" })
    expect(await harness({ scanPage: async () => null, syncPage }).pageSync.start("0:1")).toEqual({ result: null, error: SCAN_UNFINISHED })
    const thrown = harness({ scanPage: () => Promise.reject(new ApiError(0, "network", "Can't reach ReRune. Check your connection.")), syncPage }).pageSync
    expect(await thrown.start("0:1")).toEqual({ result: null, error: "Can't reach ReRune. Check your connection." })
    expect(thrown.store.get().running).toBeNull()
    expect(syncPage).not.toHaveBeenCalled()
  })
})

describe("the page sync in the app and on Layers", () => {
  function body(source: string, start: string): string {
    const from = source.indexOf(start)
    expect(from, start).toBeGreaterThan(-1)
    return source.slice(from, source.indexOf("\n  }\n", from))
  }

  it("asks for the automatic run after a pasted link and after This is the same file, without leaving the tab", () => {
    expect(body(appSource, "async function saveFileLink(")).toContain("return saveAndRegister(withFileLink(")
    expect(body(appSource, "async function confirmFile(")).toContain("return saveAndRegister(confirmSameFile(")
    const save = body(appSource, "function saveAndRegister(")
    expect(save).toContain("requestPageSync: () => pageSync.request()")
    for (const name of ["function saveAndRegister(", "async function saveFileLink(", "async function confirmFile("]) {
      expect(body(appSource, name)).not.toContain("go(")
    }
  })

  it("runs it once nothing else uses the canvas, and shows its progress and note with the notices", () => {
    const busy = appSource.slice(appSource.indexOf("const autoSyncBusy ="), appSource.indexOf("\n", appSource.indexOf("const autoSyncBusy =")))
    for (const condition of ["workLocked", "resetting", "layersBusy", "link !== null", 'space.status === "scanning"', "!isWorkspaceScreen(screen)"]) {
      expect(busy).toContain(condition)
    }
    expect(appSource).toContain("pageSync.offer(pageRef.current, { syncEnabled: gate.enabled, readOnly, busy: autoSyncBusy })")
    expect(appSource).toContain("[pageSyncState.requested, pageSyncState.running, gate.enabled, readOnly, autoSyncBusy, projectLoaded]")
    expect(appSource).toContain("{autoSyncRunning && <Note tone=\"info\">{AUTO_SYNC_RUNNING}</Note>}")
    expect(appSource).toContain("{autoPageSyncNote(autoSyncNote)}")
    expect(AUTO_SYNC_RUNNING).toBe("Link sync is on. Syncing the links on this page…")
  })

  it("drops the request and the note on sign-out and when a project is picked", () => {
    expect(appSource.match(/setLink\(null\)\n {4}pageSync\.reset\(\)\n {4}workspace\.clear\(true\)/g)).toHaveLength(2)
    expect(body(appSource, "async function pickProject(")).toContain("pageSync.reset()")
  })

  it("shares one guard with Layers, which waits while any page sync runs", () => {
    expect(layersSource).not.toContain("createPageSync")
    expect(body(layersSource, "async function syncPage()")).toContain("props.pageSync.start(props.pageId)")
    expect(layersSource).toContain("const syncing = useStore(props.pageSync.store).running !== null")
    expect(layersSource).toContain("<SegmentedControl value={state.scope} disabled={syncing}")
    expect(layersSource).toContain("const writeDisabled = props.readOnly || busy !== null || scanning || syncing")
    expect(layersSource).toContain("openDisabled={syncing}")
    expect(layersSource).toContain("props.onBusy(busy !== null)")
    expect(appSource).toContain("onBusy={setLayersBusy}")
  })
})

describe("autoPageSyncStep (the automatic run)", () => {
  const FREE = { syncEnabled: true, readOnly: false, busy: false }

  it("runs when the button could, once nothing else runs", () => {
    expect(autoPageSyncStep(FREE)).toBe("run")
    expect(autoPageSyncStep({ ...FREE, busy: true })).toBe("wait")
  })

  it("is dropped when link sync is off by then or on another server's file", () => {
    expect(autoPageSyncStep({ ...FREE, syncEnabled: false })).toBe("drop")
    expect(autoPageSyncStep({ ...FREE, readOnly: true, busy: true })).toBe("drop")
  })
})

describe("messages", () => {
  it("explains failures and rejections, and summarises a page sync", () => {
    expect(linkSyncWarning(null)).toBeNull()
    expect(linkSyncWarning({ upserted: 1, removed: 0, rejected: [], error: null })).toBeNull()
    expect(linkSyncWarning({ upserted: 0, removed: 0, rejected: [{ node_id: "1:1", reason: "not_a_text_key" }], error: null })).toBe(
      "1 link wasn't saved in ReRune because the key no longer exists or is a group.",
    )
    expect(rejectedWarning(2)).toBe("2 links weren't saved in ReRune because the key no longer exists or is a group.")
    expect(rejectedWarning(0)).toBeNull()
    expect(pageSyncSummary({ upserted: 0, removed: 0, rejected: [], error: null, serverLinks: 3, unresolved: [], heldBack: 0 })).toBe("ReRune's links match the layers on this page.")
    expect(unresolvedSummary(3)).toBe("3 links point to layers not in this file")
  })

  it("words the button's note and the automatic run's note", () => {
    const synced: PageSyncResult = { upserted: 173, removed: 1, rejected: [{ node_id: "1:1", reason: "key_not_found" }], error: null, serverLinks: 1, unresolved: [], heldBack: 0 }
    expect(pageSyncNote(synced)).toBe("Links on this page: 173 links added or updated, 1 link removed. 1 link wasn't saved in ReRune because the key no longer exists or is a group.")
    expect(pageSyncNote({ ...synced, upserted: 0, removed: 0, rejected: [] })).toBe("ReRune's links match the layers on this page.")
    const auto = { ...synced, removed: 0, heldBack: 1 }
    expect(autoPageSyncNote({ result: auto, error: null })).toBe(
      "Link sync is on. Links on this page: 173 links added or updated. 1 link wasn't saved in ReRune because the key no longer exists or is a group. ReRune also has 1 link on this page that no longer matches its layer. Run Sync links on this page on Layers to review it. To share the links on other pages, open each page and run Sync links on this page on Layers.",
    )
    expect(autoPageSyncNote({ result: { ...auto, upserted: 0, rejected: [], heldBack: 0, serverLinks: 0 }, error: null })).toBe("Link sync is on. No layer on this page is linked yet. " + OTHER_PAGES_NOTE)
    // One verb for the button everywhere: "Run".
    for (const text of [OTHER_PAGES_NOTE, RUN_ON_LAYERS_LATER, linkSyncWarning({ ...synced, error: "x" }) ?? ""]) {
      expect(text).toMatch(/[Rr]un Sync links on this page/)
      expect(text).not.toMatch(/use Sync links on this page/)
    }
  })
})
