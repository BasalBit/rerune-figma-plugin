import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, nodeLink, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaLink, FigmaLinksListResponse, FigmaLinksQuery, FigmaLinksRequest, FigmaLinksResponse } from "../../shared/api-types"
import type { LinkSyncGate } from "../../shared/file-link"
import type { LinkCheck, LinkState, UiToMain } from "../../shared/messages"
import { ApiError } from "../api/client"
import { createUiBus } from "../bus"
import {
  affectedNodeIds,
  carriedKey,
  checkLinks,
  cleanLinkName,
  createLinkSyncer,
  isUpsertable,
  linkRequests,
  linkSyncWarning,
  listPageLinks,
  pageSyncSummary,
  planNodeSync,
  planPageSync,
  rejectedWarning,
  sendLinkRequests,
  unresolvedSummary,
  upsertOf,
} from "./link-sync"
import { fakeBusEnvironment } from "./test-fakes"

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

// A main thread that answers link-check from a table (unknown ids → not_found).
function checkingBus(table: Record<string, LinkCheck>) {
  const posted: UiToMain[] = []
  const fake = fakeBusEnvironment((message, deliver) => {
    posted.push(message)
    if (message.type === "link-check") {
      deliver({
        type: "link-check-result",
        requestId: message.requestId,
        nodes: message.nodeIds.map((nodeId) => table[nodeId] ?? check(nodeId, { status: "not_found", linkState: "none", link: null })),
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

  it("syncs the written layers and the instances that inherit from them after a link or unlink", async () => {
    const api = linksApi()
    const { bus, posted } = checkingBus({
      "5:67": linkedCheck("5:67", "ok"),
      "I12:34;5:67": linkedCheck("I12:34;5:67", "inherited"),
      "1:2": check("1:2", { linkState: "none", link: null }),
    })
    const syncer = createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON })
    const result = await syncer.syncNodes(["5:67", "1:2", "1:9"], [scannedNode("I12:34;5:67", "Pay now"), scannedNode("I77:1;8:8", "Other")])
    expect(posted[0]).toMatchObject({ type: "link-check", nodeIds: ["5:67", "1:2", "1:9", "I12:34;5:67"] })
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
    expect(api.upsertLinks).toHaveBeenCalledWith(PROJECT_ID, {
      file_key: FILE_KEY,
      upserts: [upsertFor("12:346", K2)],
      removed_node_ids: ["12:347", "12:901"],
    })
    expect(result).toMatchObject({ upserted: 1, removed: 2, error: null, serverLinks: 5 })
    expect(result?.unresolved.map((link) => link.node_id)).toEqual(["12:900"])
    expect(pageSyncSummary(result!)).toBe("Links on this page: 1 link added or updated, 2 links removed.")
    expect(unresolvedSummary(result!.unresolved.length)).toBe("1 link points to a layer not in this file")
  })

  it("reports a failed listing without writing anything", async () => {
    const api = { links: vi.fn(async () => Promise.reject(new ApiError(500, null, "boom"))), upsertLinks: vi.fn() }
    const { bus } = checkingBus({})
    const result = await createLinkSyncer({ api, bus, projectId: () => PROJECT_ID, gate: () => ON }).syncPage("0:1", [])
    expect(result).toEqual({ upserted: 0, removed: 0, rejected: [], error: "ReRune had a problem. Try again.", serverLinks: 0, unresolved: [] })
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

describe("messages", () => {
  it("explains failures and rejections, and summarises a page sync", () => {
    expect(linkSyncWarning(null)).toBeNull()
    expect(linkSyncWarning({ upserted: 1, removed: 0, rejected: [], error: null })).toBeNull()
    expect(linkSyncWarning({ upserted: 0, removed: 0, rejected: [{ node_id: "1:1", reason: "not_a_text_key" }], error: null })).toBe(
      "1 link wasn't saved in ReRune because the key no longer exists or is a group.",
    )
    expect(rejectedWarning(2)).toBe("2 links weren't saved in ReRune because the key no longer exists or is a group.")
    expect(rejectedWarning(0)).toBeNull()
    expect(pageSyncSummary({ upserted: 0, removed: 0, rejected: [], error: null, serverLinks: 3, unresolved: [] })).toBe("ReRune's links match the layers on this page.")
    expect(unresolvedSummary(3)).toBe("3 links point to layers not in this file")
  })
})
