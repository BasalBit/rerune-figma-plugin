import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaByNameRequest, FigmaByNameResponse, FigmaPushRequest, FigmaPushResponse, FigmaPushResult } from "../../shared/api-types"
import { src } from "../../shared/hash"
import { KEY_NAME_ISSUES } from "../../shared/key-names"
import type { ScannedNode } from "../../shared/messages"
import { applyDecision, type RemoteWithMaxLength } from "../../shared/push-plan"
import { ApiError } from "../api/client"
import {
  canSubmit,
  emptyRun,
  executePulls,
  executePush,
  overwriteChunk,
  preparePush,
  pushChunks,
  pushCounts,
  lookUpNames,
  pushSummary,
  remoteLoadError,
  resolveConflictInRun,
  withCheckedNames,
  takeReRuneItems,
  unlinkedGroupTexts,
  type PushInput,
} from "./push"
import { fakeMain } from "./test-fakes"

function remote(key: string, mainText: string, maxLength: number | null = null): RemoteWithMaxLength {
  return { found: true, key, type: "key", enabled: true, structured: false, mainText, maxLength }
}

function byName(textMatches: Record<string, { id: string; key: string }[]>, taken: string[]) {
  return vi.fn(async (_projectId: string, request: FigmaByNameRequest): Promise<FigmaByNameResponse> => ({
    keys: (request.names ?? []).filter((name) => taken.includes(name)).map((name) => ({ id: keyId(900 + taken.indexOf(name)), key: name, type: "key" as const, main_content: { value: "" } })),
    missing: (request.names ?? []).filter((name) => !taken.includes(name)),
    text_matches: (request.texts ?? []).filter((text) => text in textMatches).map((text) => ({ text, keys: textMatches[text] })),
  }))
}

function input(nodes: ScannedNode[], overrides: Partial<PushInput> = {}): PushInput {
  return {
    projectId: PROJECT_ID,
    scope: "selection",
    nodes,
    remote: new Map(),
    sample: [],
    settings: null,
    groupIdenticalTexts: true,
    pending: new Map(),
    ...overrides,
  }
}

function result(clientRef: string, status: FigmaPushResult["status"], extra: Partial<FigmaPushResult> = {}): FigmaPushResult {
  return { client_ref: clientRef, status, key_id: null, key: null, reason: null, message: null, current_text: null, ...extra }
}

function response(results: FigmaPushResult[], availableKeys: number | null = null): FigmaPushResponse {
  const count = (status: FigmaPushResult["status"]) => results.filter((entry) => entry.status === status).length
  return {
    results,
    summary: { created: count("created"), updated: count("updated"), unchanged: count("unchanged"), conflicts: count("conflict"), failed: count("failed") },
    available_keys: availableKeys,
  }
}

describe("preparePush", () => {
  it("defaults single exact-text matches to Link to existing and suggests names for the rest", async () => {
    const nodes = [scannedNode("1:1", "Pay now", { name: "Pay button", autoRename: false }), scannedNode("1:2", "Pay now"), scannedNode("1:3", "Cancel")]
    const keysByName = byName({ "Pay now": [{ id: keyId(1), key: "checkout_pay_now" }] }, [])
    const prepared = await preparePush({ keysByName }, input(nodes))
    expect(keysByName.mock.calls[0][1]).toEqual({ texts: ["Pay now", "Cancel"] })
    expect(prepared.plan.creates).toHaveLength(2)
    expect(prepared.plan.creates[0]).toMatchObject({ ref: "c0", nodeIds: ["1:1", "1:2"], match: { decision: "link", linkKeyId: keyId(1) } })
    expect(prepared.plan.creates[1]).toMatchObject({ ref: "c1", name: "checkout_cancel", match: { decision: "create" }, nameIssues: [] })
    expect(unlinkedGroupTexts(nodes, PROJECT_ID, new Map())).toEqual(["Pay now", "Cancel"])
  })

  it("applies pending Create new key choices over the defaults", async () => {
    const nodes = [scannedNode("1:1", "Pay now")]
    const keysByName = byName({ "Pay now": [{ id: keyId(1), key: "x" }] }, [])
    const prepared = await preparePush({ keysByName }, input(nodes, { scope: "page", pending: new Map([["1:1", "checkout_cta"]]) }))
    expect(prepared.plan.creates[0]).toMatchObject({ name: "checkout_cta", selected: true, match: { decision: "create" } })
    expect(prepared.userRefs.has("c0")).toBe(true)
  })

  it("renames taken suggestions and keeps the issue on taken names the designer chose", async () => {
    const nodes = [scannedNode("1:1", "Cancel"), scannedNode("1:2", "Title"), scannedNode("1:3", "Other text")]
    const keysByName = byName({}, ["checkout_cancel", "checkout_cancel_2", "my_title"])
    const prepared = await preparePush({ keysByName }, input(nodes, { pending: new Map([["1:2", "my_title"], ["1:3", "checkout_cancel_3"]]) }))
    const [cancel, title, other] = prepared.plan.creates
    expect(cancel.name).toBe("checkout_cancel_4")
    expect(cancel.nameIssues).toEqual([])
    expect(title).toMatchObject({ name: "my_title", nameIssues: [KEY_NAME_ISSUES.taken] })
    expect(other).toMatchObject({ name: "checkout_cancel_3", nameIssues: [] })
    expect(prepared.taken.get("my_title")?.type).toBe("key")
  })

  it("rechecks names the designer edits on the latest plan, keeping decisions made meanwhile", async () => {
    const keysByName = byName({}, ["taken_now"])
    const ready = await preparePush({ keysByName }, input([scannedNode("1:1", "Hello"), scannedNode("1:2", "Bye")]))
    const typed = { ...ready, plan: applyDecision(ready.plan, { kind: "create-name", ref: "c0", name: "taken_now" }, ready.context) }
    // The designer unchecks another create while the lookup for the typed name runs.
    const latest = { ...typed, plan: applyDecision(typed.plan, { kind: "create-selected", ref: "c1", selected: false }, typed.context) }
    await lookUpNames({ keysByName }, typed, ["taken_now"])
    const checked = withCheckedNames(latest)
    expect(checked.plan.creates[0].nameIssues).toEqual([KEY_NAME_ISSUES.taken])
    expect(checked.plan.creates[1].selected).toBe(false)
  })
})

describe("review guards", () => {
  it("stops the review when the remote state failed to load", () => {
    expect(remoteLoadError({ remoteStatus: "ready", remoteError: null })).toBeNull()
    expect(remoteLoadError({ remoteStatus: "error", remoteError: "Can't reach ReRune. Check your connection." })).toBe("Can't reach ReRune. Check your connection.")
    expect(remoteLoadError({ remoteStatus: "error", remoteError: null })).toBe("The layers' state in ReRune couldn't be loaded. Try again.")
  })

  it("never says everything matches while linked layers have no status", async () => {
    const keysByName = byName({}, [])
    const linkedOnly = [linkedNode("1:1", "Pay securely", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now" })]
    const unknown = await preparePush({ keysByName }, input(linkedOnly))
    expect(unknown.plan.unknown).toBe(1)
    expect(pushSummary(unknown.plan)).toEqual({ tone: "warning", message: "1 linked layer has no status from ReRune yet. Review again." })
    const synced = await preparePush({ keysByName }, input(linkedOnly, { remote: new Map([[keyId(1), remote("pay", "Pay securely")]]) }))
    expect(pushSummary(synced.plan)).toEqual({ tone: "good", message: "Everything in scope matches ReRune. Nothing to push." })
    const changed = await preparePush({ keysByName }, input(linkedOnly, { remote: new Map([[keyId(1), remote("pay", "Pay now")]]) }))
    expect(pushSummary(changed.plan)).toBeNull()
  })
})

describe("executePush", () => {
  const remoteMap = new Map([
    [keyId(1), remote("checkout_title", "Checkout")],
    [keyId(2), remote("checkout_total", "Total")],
  ])
  const nodes = [
    scannedNode("1:1", "Pay now"),
    scannedNode("1:2", "Exact"),
    linkedNode("1:3", "Checkout now", { keyId: keyId(1), keyName: "checkout_title", syncedText: "Checkout" }),
    linkedNode("1:4", "Sum", { keyId: keyId(2), keyName: "checkout_total", syncedText: "Old total" }),
    linkedNode("I7:1;1:5", "Checkout now", { keyId: keyId(1), keyName: "checkout_title", syncedText: "Checkout", nid: "1:5", state: "inherited" }),
  ]

  async function prepared() {
    const keysByName = byName({ Exact: [{ id: keyId(5), key: "exact_key" }] }, [])
    const ready = await preparePush({ keysByName }, input(nodes, { remote: remoteMap }))
    // conflict on checkout_total: take ReRune text
    return { ...ready, plan: applyDecision(ready.plan, { kind: "conflict", keyId: keyId(2), figmaText: "Sum", decision: "take_rerune" }, ready.context) }
  }

  it("links decided matches, applies ReRune text, pushes, writes follow-up links and the codegen cache", async () => {
    const { plan, context } = await prepared()
    const main = fakeMain()
    const push = vi.fn(async (_projectId: string, request: FigmaPushRequest) =>
      response(
        request.items.map((item) =>
          item.op === "create"
            ? result(item.client_ref, "created", { key_id: keyId(10), key: item.key })
            : result(item.client_ref, "updated", { key_id: item.key_id, key: "checkout_title" }),
        ),
        41,
      ),
    )
    const run = await executePush({ api: { push }, bus: main.bus }, plan, context)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][1]).toEqual({
      file_key: null,
      items: [
        { client_ref: "c0", op: "create", key: "checkout_pay_now", text: "Pay now", description: "Checkout", max_length: null },
        { client_ref: "u" + keyId(1), op: "update", key_id: keyId(1), text: "Checkout now", expected_text: "Checkout" },
      ],
    })
    const types = main.writes.map((message) => message.type)
    expect(types).toEqual(["link-apply", "text-apply", "link-apply"])
    expect(main.writes[0]).toMatchObject({ items: [{ nodeId: "1:2", keyId: keyId(5), keyName: "exact_key", src: src("Exact") }] })
    expect(main.writes[1]).toMatchObject({ items: [{ nodeId: "1:4", text: "Total", src: src("Total") }] })
    const followUps = (main.writes[2] as { items: { nodeId: string; keyId: string; src: string }[] }).items
    // The inherited sublayer is sent as the representative of its main component; main redirects it (§7.6).
    expect(followUps).toEqual([
      { nodeId: "1:1", keyId: keyId(10), keyName: "checkout_pay_now", projectId: PROJECT_ID, src: src("Pay now") },
      { nodeId: "1:3", keyId: keyId(1), keyName: "checkout_title", projectId: PROJECT_ID, src: src("Checkout now") },
      { nodeId: "I7:1;1:5", keyId: keyId(1), keyName: "checkout_title", projectId: PROJECT_ID, src: src("Checkout now") },
    ])
    expect(run).toMatchObject({ created: 1, updated: 1, linked: 1, textsApplied: 1, availableKeys: 41, requestError: null, failures: [], conflicts: [] })
    expect(main.posted.find((message) => message.type === "cache-save")).toEqual({
      type: "cache-save",
      projectId: PROJECT_ID,
      entries: [
        { keyId: keyId(10), k: "checkout_pay_now", placeholders: [], sourceText: "Pay now" },
        { keyId: keyId(1), k: "checkout_title", placeholders: [], sourceText: "Checkout now" },
      ],
    })
  })

  it("reports item failures, conflicts and quota", async () => {
    const { plan, context } = await prepared()
    const main = fakeMain()
    const push = vi.fn(async () =>
      response([
        result("c0", "failed", { reason: "quota_exceeded", message: "quota" }),
        result("u" + keyId(1), "conflict", { key_id: keyId(1), key: "checkout_title", reason: "source_changed", current_text: "Checkout!" }),
      ]),
    )
    const run = await executePush({ api: { push }, bus: main.bus }, plan, context)
    expect(run.quotaExceeded).toBe(true)
    expect(run.failures).toEqual([{ ref: "c0", reason: "quota_exceeded", message: "Your plan's key limit is reached.", keyId: null, keyName: null, nodeIds: ["1:1"] }])
    expect(run.conflicts).toEqual([{ ref: "u" + keyId(1), keyId: keyId(1), keyName: "checkout_title", nodeIds: ["1:3", "I7:1;1:5"], text: "Checkout now", currentText: "Checkout!" }])
    expect(main.posted.some((message) => message.type === "cache-save")).toBe(false)
  })

  it("turns a failed request into a failure per item and never retries", async () => {
    const { plan, context } = await prepared()
    const main = fakeMain()
    const push = vi.fn(async () => Promise.reject(new ApiError(400, null, "project has no billing account")))
    const run = await executePush({ api: { push }, bus: main.bus }, plan, context)
    expect(push).toHaveBeenCalledTimes(1)
    expect(run.requestError).toBe("project has no billing account")
    expect(run.failures.map((failure) => [failure.ref, failure.message])).toEqual([
      ["c0", "project has no billing account"],
      ["u" + keyId(1), "project has no billing account"],
    ])
  })

  it("sends nothing while a preview is active", async () => {
    const keysByName = byName({}, [])
    const ready = await preparePush({ keysByName }, input([scannedNode("1:1", "Hallo", { originalCharacters: "Hello", preview: { lang: "de", source: "draft", variationOptionId: null, appliedAt: 1 } })]))
    const main = fakeMain()
    const push = vi.fn()
    const run = await executePush({ api: { push }, bus: main.bus }, ready.plan, ready.context)
    expect(push).not.toHaveBeenCalled()
    expect(main.writes).toEqual([])
    expect(run.created).toBe(0)
    expect(canSubmit(ready.plan, true)).toBe(false)
  })

  it("adds the max length to max_length_exceeded failures", async () => {
    const { context } = await prepared()
    const lengthy = { ...context, remote: new Map([[keyId(1), remote("checkout_title", "Checkout", 8)]]) }
    const main = fakeMain()
    const chunk = { items: [{ client_ref: "u1", op: "update" as const, key_id: keyId(1), text: "Too long text", expected_text: "Checkout" }], nodeIdsByRef: new Map([["u1", ["1:3"]]]) }
    const run = await pushChunks({ api: { push: async () => response([result("u1", "failed", { key_id: keyId(1), reason: "max_length_exceeded" })]) }, bus: main.bus }, [chunk], lengthy)
    expect(run.failures[0].message).toBe("Longer than the key's max length (8).")
  })
})

describe("after-push choices and pulls", () => {
  const conflict = { ref: "u1", keyId: keyId(1), keyName: "checkout_title", nodeIds: ["1:3", "I7:1;1:5", "I8:1;1:5"], text: "Checkout now", currentText: "Checkout!" }

  it("merges conflicts resolved at the same time into the latest run", () => {
    const other = { ...conflict, ref: "u2", keyId: keyId(2), keyName: "checkout_total" }
    const failure = { ref: "u2", reason: "source_changed" as const, message: "The source text changed in ReRune.", keyId: keyId(2), keyName: "checkout_total", nodeIds: ["1:4"] }
    const writeError = { nodeId: "1:3", code: "missing_font" as const, message: "A font in this layer is missing. Install or replace it first." }
    const start = { ...emptyRun(), conflicts: [conflict, other] }
    // Both clicks start from `start`; the results arrive one after the other.
    const afterFirst = resolveConflictInRun(start, "u1", { writeErrors: [writeError] })
    const afterSecond = resolveConflictInRun(afterFirst, "u2", { updated: 0, conflicts: [], failures: [failure], writeErrors: [] })
    expect(afterSecond.conflicts).toEqual([])
    expect(afterSecond.failures).toEqual([failure])
    expect(afterSecond.writeErrors).toEqual([writeError])
    expect(resolveConflictInRun(afterSecond, "u9", { updated: 1 }).updated).toBe(1)
  })

  it("Overwrite sends one update against the current text", () => {
    const chunk = overwriteChunk(conflict)
    expect(chunk.items).toEqual([{ client_ref: "u1", op: "update", key_id: keyId(1), text: "Checkout now", expected_text: "Checkout!" }])
    expect(chunk.nodeIdsByRef.get("u1")).toEqual(conflict.nodeIds)
  })

  it("Take ReRune text writes one representative per inherited main", () => {
    const nodes = new Map([
      ["1:3", linkedNode("1:3", "Checkout now", { keyId: keyId(1), keyName: "checkout_title", syncedText: "Checkout" })],
      ["I7:1;1:5", linkedNode("I7:1;1:5", "Checkout now", { keyId: keyId(1), keyName: "checkout_title", syncedText: "Checkout", nid: "1:5", state: "inherited" })],
      ["I8:1;1:5", linkedNode("I8:1;1:5", "Checkout now", { keyId: keyId(1), keyName: "checkout_title", syncedText: "Checkout", nid: "1:5", state: "inherited" })],
    ])
    expect(takeReRuneItems(conflict, nodes)).toEqual([
      { nodeId: "1:3", text: "Checkout!", src: src("Checkout!") },
      { nodeId: "I7:1;1:5", text: "Checkout!", src: src("Checkout!") },
    ])
  })

  it("pulls ReRune text and refreshes renamed key names only where the write worked", async () => {
    const nodes = [
      linkedNode("1:1", "Old", { keyId: keyId(1), keyName: "old_name", syncedText: "Old" }),
      linkedNode("1:2", "Old", { keyId: keyId(1), keyName: "old_name", syncedText: "Old" }),
      linkedNode("1:3", "Same", { keyId: keyId(2), keyName: "same", syncedText: "Same" }),
    ]
    const remoteMap = new Map([[keyId(1), remote("new_name", "New")], [keyId(2), remote("same", "Newer")]])
    const ready = await preparePush({ keysByName: byName({}, []) }, input(nodes, { remote: remoteMap }))
    expect(ready.plan.pulls.map((pull) => pull.keyId)).toEqual([keyId(1), keyId(2)])
    const main = fakeMain((message) => (message.type === "text-apply" ? [{ nodeId: "1:2", code: "preview_active", message: "Reset the preview on this layer first." }] : []))
    const outcome = await executePulls({ api: { push: vi.fn() }, bus: main.bus }, ready.plan, ready.context)
    expect(main.writes[0]).toMatchObject({ type: "text-apply", items: [{ nodeId: "1:1", text: "New" }, { nodeId: "1:2", text: "New" }, { nodeId: "1:3", text: "Newer" }] })
    expect(main.writes[1]).toEqual({ type: "link-apply", requestId: expect.any(String), items: [{ nodeId: "1:1", keyId: keyId(1), keyName: "new_name", projectId: PROJECT_ID, src: src("New") }] })
    expect(outcome.errors.map((error) => error.code)).toEqual(["preview_active"])
  })

  it("counts what a push will do", async () => {
    const ready = await preparePush({ keysByName: byName({}, ["dup"]) }, input([scannedNode("1:1", "A"), scannedNode("1:2", "B")], { pending: new Map([["1:2", "dup"]]) }))
    const counts = pushCounts(ready.plan)
    expect(counts).toMatchObject({ creates: 1, nameIssues: 1, links: 0, updates: 0 })
    expect(canSubmit(ready.plan, true)).toBe(true)
    expect(canSubmit(ready.plan, false)).toBe(false)
  })
})
