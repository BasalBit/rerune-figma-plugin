/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaByNameRequest, FigmaByNameResponse, FigmaPushResponse, FigmaPushResult, FigmaResolveRequest, FigmaResolveResponse, FigmaScreenshotsResponse } from "../../shared/api-types"
import { src } from "../../shared/hash"
import { KEY_NAME_ISSUES } from "../../shared/key-names"
import type { ScannedNode, Scope } from "../../shared/messages"
import { applyDecision } from "../../shared/push-plan"
import pushScreen from "../screens/push.tsx?raw"
import { layerRows } from "./layers"
import type { ScanResult, ScanRunner } from "./ops"
import { SCAN_UNFINISHED } from "./link-sync"
import {
  carryDecisions,
  CHANGED_SINCE_PUSH,
  checkPlan,
  currentConflict,
  executeOverwrite,
  executePulls,
  executeTakeReRune,
  followShown,
  followStep,
  KEYS_LOADING,
  liveState,
  lookUpNames,
  overwriteChanges,
  planBase,
  planLayerIds,
  planSignature,
  preparePush,
  pullChanges,
  pullSignature,
  replanPush,
  replanShown,
  restSignature,
  takeReRuneChanges,
  unchangedSincePush,
  withCheckedNames,
  type PreparedPush,
  type PushCheckDeps,
  type PushInput,
} from "./push"
import { createRefreshRequests } from "./refresh-requests"
import { emptyScreenshotRun, type ScreenshotFrame } from "./screenshots"
import { fakeMain, resolvedKey } from "./test-fakes"
import { createWorkLock } from "./work-lock"
import { createWorkspace, type WorkspaceState } from "./workspace"

// ReRune edits while the plugin is open (the Push plan follows the keys read again without a scan) and the chips after
// an action on the Push tab (what it wrote shows at once in the workspace, so on Push and Layers).

const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
const K1 = keyId(1)
const K2 = keyId(2)
const K3 = keyId(3)

// The canvas: a scan of the page reads every layer, of the selection the selected ones (all until `select`), by id the
// ones named (those deleted come back missing).
function scene() {
  let selection: string[] | null = null
  let nodes: ScannedNode[] = [
    linkedNode("1:1", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now" }),
    linkedNode("1:2", "Total", { keyId: K2, keyName: "total", syncedText: "Total" }),
    scannedNode("1:3", "Free text"),
    linkedNode("1:4", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now", nid: "1:1", state: "copied" }),
    // Changed in Figma: the layer says "Shipping fee", ReRune still "Shipping".
    linkedNode("1:5", "Shipping fee", { keyId: K3, keyName: "shipping", syncedText: "Shipping" }),
  ]
  const texts = new Map<string, string>([[K1, "Pay now"], [K2, "Total"], [K3, "Shipping"]])
  const run = vi.fn(async (scope: Scope, _progress?: (scanned: number) => void, nodeIds?: readonly string[]): Promise<ScanResult> => {
    const picked =
      nodeIds !== undefined
        ? nodeIds.map((id) => nodes.find((node) => node.nodeId === id)).filter((node): node is ScannedNode => node !== undefined)
        : scope === "selection" && selection !== null
          ? nodes.filter((node) => selection?.includes(node.nodeId))
          : nodes
    const result: ScanResult = { scope, nodes: picked, total: picked.length, truncated: false, skipped: SKIPPED }
    return nodeIds === undefined ? result : { ...result, missingFrameIds: nodeIds.filter((id) => !nodes.some((node) => node.nodeId === id)), hiddenFrameIds: [] }
  })
  const scanner: ScanRunner = { cancel: vi.fn(), run }
  const resolveKeys = vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
    source: "draft",
    variation_option: null,
    keys: request.key_ids.map((id) => resolvedKey(id, id === K1 ? "pay_now" : id === K2 ? "total" : "shipping", texts.get(id) ?? "")),
    missing_key_ids: [],
  }))
  // Names starting with "taken_" exist in the project.
  const keysByName = vi.fn(async (_projectId: string, request: FigmaByNameRequest): Promise<FigmaByNameResponse> => ({
    keys: (request.names ?? []).filter((name) => name.startsWith("taken_")).map((name, index) => ({ id: keyId(800 + index), key: name, type: "key" as const, main_content: { value: "" } })),
    missing: (request.names ?? []).filter((name) => !name.startsWith("taken_")),
    text_matches: [],
  }))
  const workspace = createWorkspace({ scanner, api: { resolveKeys }, project: () => ({ id: PROJECT_ID, main_language: "en" }) })
  const inputOf = (state: WorkspaceState = workspace.store.get()): PushInput => ({
    projectId: PROJECT_ID,
    scope: state.result?.scope ?? "page",
    nodes: state.result?.nodes ?? [],
    remote: state.remote,
    sample: [],
    settings: null,
    groupIdenticalTexts: true,
    pending: state.pending,
  })
  const deps: PushCheckDeps = { api: { keysByName }, state: () => workspace.store.get(), input: inputOf, scanLayers: (nodeIds) => workspace.scanLayers(nodeIds) }
  return {
    workspace,
    texts,
    scanner,
    run,
    resolveKeys,
    keysByName,
    inputOf,
    deps,
    setNodes: (next: ScannedNode[]) => (nodes = next),
    nodes: () => nodes,
    type: (nodeId: string, characters: string) => (nodes = nodes.map((node) => (node.nodeId === nodeId ? { ...node, characters } : node))),
    select: (nodeIds: string[]) => (selection = nodeIds),
    // Scans of the scope (not of layers by id).
    scopeScans: () => run.mock.calls.filter((call) => call[2] === undefined).length,
    async review(scope: Scope = "page"): Promise<PreparedPush> {
      await workspace.scan(scope)
      return preparePush({ keysByName }, inputOf())
    },
    replan: (from: PreparedPush) => replanPush({ keysByName }, from, inputOf()),
  }
}

function decide(prepared: PreparedPush, ...decisions: Parameters<typeof applyDecision>[1][]): PreparedPush {
  let plan = prepared.plan
  for (const decision of decisions) {
    plan = applyDecision(plan, decision, prepared.context)
  }
  return { ...prepared, plan }
}

const rowState = (state: WorkspaceState, nodeId: string) => layerRows(state.result?.nodes ?? [], PROJECT_ID, state.remote, state.pending).find((row) => row.node.nodeId === nodeId)?.state

describe("Push plan while ReRune changes (background read, no scan)", () => {
  it("builds the plan again from the same scan, asks E11 nothing again, and lists the new edit under Changed in ReRune", async () => {
    const s = scene()
    const shown = await s.review()
    expect(shown.plan.pulls).toEqual([])
    const lookups = s.keysByName.mock.calls.length
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    const next = await s.replan(shown)
    expect(s.scopeScans()).toBe(1)
    expect(s.keysByName).toHaveBeenCalledTimes(lookups)
    expect(next.plan.pulls).toMatchObject([{ keyId: K2, remoteText: "Sum", nodeIds: ["1:2"] }])
    expect(followStep(false, shown.plan, next.plan)).toBe("adopt")
    expect(rowState(s.workspace.store.get(), "1:2")).toBe("changed_in_rerune")
  })

  it("moves a layer also changed in Figma to Changed in both", async () => {
    const s = scene()
    const shown = await s.review()
    expect(shown.plan.updates.map((update) => update.keyId)).toEqual([K3])
    s.texts.set(K3, "Delivery")
    await s.workspace.refreshKeys()
    const next = await s.replan(shown)
    expect(next.plan.updates).toEqual([])
    expect(next.plan.conflicts).toMatchObject([{ keyId: K3, figmaText: "Shipping fee", remoteText: "Delivery", decision: "skip" }])
    expect(rowState(s.workspace.store.get(), "1:5")).toBe("conflict")
  })

  it("keeps the designer's choices, and once they made one asks for Refresh instead of moving the rows", async () => {
    const s = scene()
    const reviewed = await s.review()
    const create = reviewed.plan.creates[0]
    const shown = decide(reviewed, { kind: "create-name", ref: create.ref, name: "my_free_text" }, { kind: "copied", nodeId: "1:4", decision: "keep" })
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    const next = await s.replan(shown)
    expect(next.plan.creates[0]).toMatchObject({ name: "my_free_text", nodeIds: ["1:3"] })
    expect(next.plan.copied).toMatchObject([{ nodeId: "1:4", decision: "keep" }])
    expect(next.plan.pulls.map((pull) => pull.keyId)).toEqual([K2])
    expect(followStep(true, shown.plan, next.plan)).toBe("note")
    // Refresh takes the new plan with the choices; a read that finds nothing new changes nothing seen.
    const same = await s.replan(next)
    expect(followStep(true, next.plan, same.plan)).toBe("adopt")
    expect(planSignature(same.plan)).toBe(planSignature(next.plan))
  })

  it("shows the answer of a name lookup that started before the plan was built again", async () => {
    const s = scene()
    const reviewed = await s.review()
    const typed = decide(reviewed, { kind: "create-name", ref: reviewed.plan.creates[0].ref, name: "taken_title" })
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    const next = await s.replan(typed)
    await lookUpNames({ keysByName: s.keysByName }, typed, ["taken_title"])
    expect(withCheckedNames(next).plan.creates[0]).toMatchObject({ name: "taken_title", nameIssues: [KEY_NAME_ISSUES.taken] })
  })

  it("keeps a conflict's choice while ReRune's text is the same, and resets it when ReRune changed it again", async () => {
    const s = scene()
    s.texts.set(K3, "Delivery")
    const reviewed = await s.review()
    const shown = decide(reviewed, { kind: "conflict", keyId: K3, figmaText: "Shipping fee", decision: "overwrite" })
    expect(shown.plan.updates).toMatchObject([{ keyId: K3, text: "Shipping fee", expectedText: "Delivery" }])
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    const kept = await s.replan(shown)
    expect(kept.plan.conflicts[0].decision).toBe("overwrite")
    expect(kept.plan.updates.map((update) => update.keyId)).toEqual([K3])
    s.texts.set(K3, "Delivery now")
    await s.workspace.refreshKeys()
    const reset = await s.replan(kept)
    expect(reset.plan.conflicts[0]).toMatchObject({ remoteText: "Delivery now", decision: "skip" })
    expect(reset.plan.updates).toEqual([])
  })

  it("gives plans with the same work and choices the same signature, whatever their order or refs", async () => {
    const s = scene()
    const shown = await s.review()
    const reordered = { ...shown.plan, creates: [...shown.plan.creates].reverse().map((create, index) => ({ ...create, ref: "c" + (9 - index) })), updates: shown.plan.updates.map((update) => ({ ...update, ref: "x" })) }
    expect(planSignature(reordered)).toBe(planSignature(shown.plan))
    const chosen = decide(shown, { kind: "copied", nodeId: "1:4", decision: "new_key" })
    expect(planSignature(chosen.plan)).not.toBe(planSignature(shown.plan))
  })

  it("carries the choices on a page review with many new texts in linear time (entries are matched by index, not by search)", async () => {
    const s = scene()
    const count = 3000
    s.setNodes(Array.from({ length: count }, (_, index) => scannedNode("3:" + index, "Text " + index)))
    const reviewed = await s.review()
    expect(reviewed.plan.creates).toHaveLength(count)
    const flipped = new Set(reviewed.plan.creates.slice(0, 1000).map((create) => create.ref))
    const shown = decide(reviewed, ...reviewed.plan.creates.filter((create) => flipped.has(create.ref)).map((create) => ({ kind: "create-selected" as const, ref: create.ref, selected: !create.selected })))
    // Every new text has the same origin ("unlinked"): a search would compare each one with half the others.
    const stringify = vi.spyOn(JSON, "stringify")
    const next = carryDecisions(shown.plan, { ...reviewed })
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(calls).toBeLessThan(10 * count)
    expect(next.plan.creates.map((create) => create.selected)).toEqual(shown.plan.creates.map((create) => create.selected))
    expect(next.plan.creates.filter((create, index) => create.selected !== reviewed.plan.creates[index].selected)).toHaveLength(1000)
  })

  it("Select all is a choice: a ReRune change then waits for Refresh, which keeps every new text included", async () => {
    const s = scene()
    s.setNodes([...s.nodes(), scannedNode("1:6", "Back"), scannedNode("1:7", "Next")])
    const reviewed = await s.review()
    expect(reviewed.plan.creates.map((create) => create.selected)).toEqual([false, false, false])
    const base = planBase(s.workspace.store.get())
    const shown = decide(reviewed, { kind: "creates-selected", selected: true })
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    expect((await followShown(s.deps, shown, base, true))?.kind).toBe("note")
    const refreshed = await replanShown(s.deps, shown, base)
    expect(refreshed.kind).toBe("ready")
    if (refreshed.kind !== "ready") return
    expect(refreshed.prepared.plan.creates.map((create) => [create.text, create.selected])).toEqual([["Free text", true], ["Back", true], ["Next", true]])
    expect(refreshed.prepared.plan.pulls.map((pull) => pull.keyId)).toEqual([K2])
    // Cleared again, the next read keeps them all out.
    const cleared = decide(refreshed.prepared, { kind: "creates-selected", selected: false })
    s.texts.set(K2, "Total sum")
    await s.workspace.refreshKeys()
    const again = await s.replan(cleared)
    expect(again.plan.creates.map((create) => create.selected)).toEqual([false, false, false])
  })

  it("keeps new texts left out of a selection review (where they start ticked) when ReRune changes, after Select all is cleared or some are unticked", async () => {
    const s = scene()
    s.setNodes([...s.nodes(), scannedNode("1:6", "Back"), scannedNode("1:7", "Next")])
    const reviewed = await s.review("selection")
    expect(reviewed.plan.creates.map((create) => create.selected)).toEqual([true, true, true])
    const base = planBase(s.workspace.store.get())
    const cleared = decide(reviewed, { kind: "creates-selected", selected: false })
    const some = decide(reviewed, { kind: "create-selected", ref: reviewed.plan.creates[0].ref, selected: false }, { kind: "create-selected", ref: reviewed.plan.creates[2].ref, selected: false })
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    for (const [shown, selected] of [[cleared, [false, false, false]], [some, [false, true, false]]] as const) {
      expect((await followShown(s.deps, shown, base, true))?.kind).toBe("note")
      const refreshed = await replanShown(s.deps, shown, base)
      if (refreshed.kind !== "ready") throw new Error("not ready: " + refreshed.kind)
      expect(refreshed.prepared.plan.pulls.map((pull) => pull.keyId)).toEqual([K2])
      expect(refreshed.prepared.plan.creates.map((create) => [create.text, create.selected])).toEqual([["Free text", selected[0]], ["Back", selected[1]], ["Next", selected[2]]])
    }
  })

  it("carries Select all on a page review with many new texts in one step, without rebuilding the plan per text", async () => {
    const s = scene()
    const count = 3000
    s.setNodes(Array.from({ length: count }, (_, index) => scannedNode("3:" + index, "Text " + index)))
    const reviewed = await s.review()
    const shown = decide(reviewed, { kind: "creates-selected", selected: true })
    // Each rebuild of the plan checks every new name once: per text that would be count × count.
    let checks = 0
    const context = { ...reviewed.context, isTaken: (name: string) => (checks++, reviewed.context.isTaken(name)) }
    const next = carryDecisions(shown.plan, { ...reviewed, context })
    expect(checks).toBeLessThan(10 * count)
    expect(next.plan.creates.every((create) => create.selected)).toBe(true)
  })
})

describe("Push plan: checked again before a push or a pull (the plan's layers by id, wherever the selection is now)", () => {
  it("checks the reviewed layers after Select on a row or a click on the canvas changed the selection, and goes ahead", async () => {
    const s = scene()
    s.texts.set(K2, "Sum")
    const shown = await s.review("selection")
    const reviewed = planLayerIds(shown)
    expect(reviewed).toEqual(["1:1", "1:2", "1:3", "1:4", "1:5"])
    // Select on the "Changed in ReRune" row selects its layer; then nothing is selected.
    for (const selection of [["1:2"], []]) {
      s.select(selection)
      const checked = await checkPlan(s.deps, shown, planSignature)
      expect(checked.kind).toBe("same")
      expect(s.run.mock.calls[s.run.mock.calls.length - 1][2]).toEqual(reviewed)
      // The list keeps showing the reviewed layers, not the new selection.
      expect(s.workspace.store.get().result?.nodes.map((node) => node.nodeId)).toEqual(reviewed)
      expect(s.workspace.store.get().scope).toBe("selection")
    }
    expect(s.scopeScans()).toBe(1)
  })

  it("stops when a reviewed layer was edited or deleted, and gives the plan built again with the choices kept", async () => {
    const s = scene()
    const reviewed = await s.review("selection")
    const shown = decide(reviewed, { kind: "copied", nodeId: "1:4", decision: "keep" })
    s.select(["1:1"])
    s.type("1:2", "Total due")
    const edited = await checkPlan(s.deps, shown, planSignature)
    expect(edited.kind).toBe("changed")
    if (edited.kind !== "changed") return
    expect(edited.prepared.plan.updates.map((update) => update.keyId).sort()).toEqual([K2, K3].sort())
    expect(edited.prepared.plan.copied[0].decision).toBe("keep")
    // Checked again with nothing new: the same plan, and a push goes ahead.
    await expect(checkPlan(s.deps, edited.prepared, planSignature)).resolves.toMatchObject({ kind: "same" })
    s.setNodes(s.nodes().filter((node) => node.nodeId !== "1:3"))
    const deleted = await checkPlan(s.deps, edited.prepared, planSignature)
    expect(deleted.kind).toBe("changed")
    if (deleted.kind === "changed") expect(deleted.prepared.plan.creates).toEqual([])
  })

  it("a pull goes ahead when what it writes is the same, and says when other rows changed", async () => {
    const s = scene()
    s.texts.set(K2, "Sum")
    const shown = await s.review()
    s.type("1:5", "Shipping fees")
    const checked = await checkPlan(s.deps, shown, pullSignature)
    expect(checked.kind).toBe("same")
    if (checked.kind !== "same") return
    expect(restSignature(checked.prepared.plan)).not.toBe(restSignature(shown.plan))
    // Typing into the layer it would write stops it.
    s.type("1:2", "Total due")
    await expect(checkPlan(s.deps, checked.prepared, pullSignature)).resolves.toMatchObject({ kind: "changed" })
  })

  it("explains why it could not check: the scan did not finish, or the keys' state failed or is loading", async () => {
    const s = scene()
    const shown = await s.review()
    const unfinished = await checkPlan({ ...s.deps, scanLayers: async () => null }, shown, planSignature)
    expect(unfinished).toEqual({ kind: "error", message: SCAN_UNFINISHED })
    s.resolveKeys.mockRejectedValueOnce(new Error("Service Unavailable"))
    const failed = await checkPlan(s.deps, shown, planSignature)
    expect(failed.kind).toBe("error")
    const loading = { ...s.deps, scanLayers: async () => ({ scope: "page" as const, nodes: [], total: 0, truncated: false, skipped: SKIPPED }), state: () => ({ ...s.workspace.store.get(), remoteStatus: "loading" as const }) }
    await expect(checkPlan(loading, shown, planSignature)).resolves.toEqual({ kind: "error", message: KEYS_LOADING })
  })
})

describe("Push plan: following the workspace while it shows the plan's layers", () => {
  it("follows a background read of the same scan, and asks for Refresh once a choice was made", async () => {
    const s = scene()
    const shown = await s.review("selection")
    const base = planBase(s.workspace.store.get())
    s.texts.set(K2, "Sum")
    await s.workspace.refreshKeys()
    const followed = await followShown(s.deps, shown, base, false)
    expect(followed?.kind).toBe("adopt")
    if (followed?.kind === "adopt") expect(followed.prepared.plan.pulls.map((pull) => pull.keyId)).toEqual([K2])
    const touched = decide(shown, { kind: "copied", nodeId: "1:4", decision: "keep" })
    expect((await followShown(s.deps, touched, base, true))?.kind).toBe("note")
  })

  it("does not follow a scan of another selection (the header's Reset scans the selection as it is now), and Refresh says so", async () => {
    const s = scene()
    const shown = await s.review("selection")
    const base = planBase(s.workspace.store.get())
    s.select(["1:2"])
    await s.workspace.scan()
    await expect(followShown(s.deps, shown, base, false)).resolves.toBeNull()
    await expect(replanShown(s.deps, shown, base)).resolves.toEqual({ kind: "other" })
    // A scan of the same layers is followed.
    s.select(["1:1", "1:2", "1:3", "1:4", "1:5"])
    await s.workspace.scan()
    await expect(followShown(s.deps, shown, base, false)).resolves.toMatchObject({ kind: "adopt" })
  })

  it("waits while the workspace loads, and reports a failed load instead of starting a review", async () => {
    const s = scene()
    const shown = await s.review()
    const base = planBase(s.workspace.store.get())
    const as = (patch: Partial<WorkspaceState>) => ({ ...s.deps, state: () => ({ ...s.workspace.store.get(), ...patch }) })
    await expect(replanShown(as({ remoteStatus: "loading" }), shown, base)).resolves.toEqual({ kind: "waiting" })
    await expect(replanShown(as({ status: "scanning" }), shown, base)).resolves.toEqual({ kind: "waiting" })
    await expect(replanShown(as({ remoteStatus: "error", remoteError: "Can't reach ReRune." }), shown, base)).resolves.toEqual({ kind: "error", message: "Can't reach ReRune." })
    await expect(replanShown(as({ status: "error", error: "The plugin stopped responding." }), shown, base)).resolves.toEqual({ kind: "error", message: "The plugin stopped responding." })
  })
})

function result(clientRef: string, status: FigmaPushResult["status"], extra: Partial<FigmaPushResult> = {}): FigmaPushResult {
  return { client_ref: clientRef, status, key_id: null, key: null, reason: null, message: null, current_text: null, ...extra }
}

function response(results: FigmaPushResult[]): FigmaPushResponse {
  const count = (status: FigmaPushResult["status"]) => results.filter((entry) => entry.status === status).length
  return { results, summary: { created: count("created"), updated: count("updated"), unchanged: count("unchanged"), conflicts: count("conflict"), failed: count("failed") }, available_keys: null }
}

describe("chips after an action on the Push tab", () => {
  it("Update layers from ReRune: the layers show Synced at once on Layers and Push, and the other choices stay", async () => {
    const s = scene()
    s.texts.set(K2, "Sum")
    const reviewed = await s.review()
    const shown = decide(reviewed, { kind: "create-name", ref: reviewed.plan.creates[0].ref, name: "my_free_text" }, { kind: "copied", nodeId: "1:4", decision: "keep" })
    const main = fakeMain()
    const pulled = await executePulls({ bus: main.bus }, shown.plan, shown.context)
    const keys = s.workspace.applyChanges(pullChanges(shown.plan, pulled))
    expect(keys).toEqual([K2])
    expect(rowState(s.workspace.store.get(), "1:2")).toBe("synced")
    expect(liveState(["1:2"], s.workspace.store.get(), PROJECT_ID)).toBe("synced")
    await s.workspace.refreshKeys({ keyIds: keys })
    expect(s.resolveKeys.mock.calls[s.resolveKeys.mock.calls.length - 1][1].key_ids).toEqual([K2])
    const next = await s.replan(shown)
    expect(next.plan.pulls).toEqual([])
    expect(next.plan.unchanged).toBe(shown.plan.unchanged + 1)
    expect(next.plan.creates[0].name).toBe("my_free_text")
    expect(next.plan.copied[0].decision).toBe("keep")
    expect(s.scanner.run).toHaveBeenCalledTimes(1)
  })

  it("a write that failed leaves its layer as it was", async () => {
    const s = scene()
    s.texts.set(K2, "Sum")
    const shown = await s.review()
    const main = fakeMain(() => [{ nodeId: "1:2", code: "missing_font", message: "A font in this layer is missing." }])
    const pulled = await executePulls({ bus: main.bus }, shown.plan, shown.context)
    expect(s.workspace.applyChanges(pullChanges(shown.plan, pulled))).toEqual([])
    expect(rowState(s.workspace.store.get(), "1:2")).toBe("changed_in_rerune")
  })

  const conflictOf = (currentText: string) => ({ ref: "u" + K2, keyId: K2, keyName: "total", nodeIds: ["1:2"], text: "Total due", currentText })

  async function afterPush() {
    const s = scene()
    // Pushed "Total due" while ReRune changed it to "Sum": the push reported a conflict, and its rescan shows it.
    s.setNodes(s.nodes().map((node) => (node.nodeId === "1:2" ? { ...node, characters: "Total due" } : node)))
    s.texts.set(K2, "Sum")
    await s.workspace.scan("page")
    expect(liveState(["1:2"], s.workspace.store.get(), PROJECT_ID)).toBe("conflict")
    return s
  }

  it("Take ReRune text after a push: Synced at once", async () => {
    const s = await afterPush()
    const nodes = new Map((s.workspace.store.get().result?.nodes ?? []).map((node) => [node.nodeId, node]))
    const conflict = conflictOf("Sum")
    const taken = await executeTakeReRune({ api: { push: vi.fn() }, bus: fakeMain().bus }, conflict, { nodes })
    s.workspace.applyChanges(takeReRuneChanges(conflict, taken))
    expect(liveState(["1:2"], s.workspace.store.get(), PROJECT_ID)).toBe("synced")
    expect(s.workspace.store.get().result?.nodes.find((node) => node.nodeId === "1:2")?.characters).toBe("Sum")
  })

  it("Overwrite after a push: Synced at once, and a conflict again shows ReRune's newest text", async () => {
    const s = await afterPush()
    const state = s.workspace.store.get()
    const context = { projectId: PROJECT_ID, nodes: new Map((state.result?.nodes ?? []).map((node) => [node.nodeId, node])), remote: state.remote, style: "snake" as const, isTaken: () => false, suggestName: () => "x" }
    const conflict = conflictOf("Sum")
    const push = vi.fn(async () => response([result(conflict.ref, "updated", { key_id: K2, key: "total" })]))
    const run = await executeOverwrite({ api: { push }, bus: fakeMain().bus }, conflict, context)
    const keys = s.workspace.applyChanges(overwriteChanges(conflict, run))
    expect(liveState(["1:2"], s.workspace.store.get(), PROJECT_ID)).toBe("synced")
    // ReRune confirms when the key is read again.
    s.texts.set(K2, "Total due")
    await s.workspace.refreshKeys({ keyIds: keys })
    expect(liveState(["1:2"], s.workspace.store.get(), PROJECT_ID)).toBe("synced")

    const t = await afterPush()
    const again = vi.fn(async () => response([result(conflict.ref, "conflict", { key_id: K2, key: "total", reason: "source_changed", current_text: "Sum 2" })]))
    const conflicted = await executeOverwrite({ api: { push: again }, bus: fakeMain().bus }, conflict, context)
    t.workspace.applyChanges(overwriteChanges(conflict, conflicted))
    expect(liveState(["1:2"], t.workspace.store.get(), PROJECT_ID)).toBe("conflict")
    expect(t.workspace.store.get().remote.get(K2)?.mainText).toBe("Sum 2")
  })

  it("Update screenshots from the notices: its pulls show at once on Layers and Push", async () => {
    const s = scene()
    s.texts.set(K2, "Sum")
    await s.workspace.scan("page")
    expect(rowState(s.workspace.store.get(), "1:2")).toBe("changed_in_rerune")
    const lock = createWorkLock()
    const screenshots = vi.fn(
      async (): Promise<FigmaScreenshotsResponse> => ({
        screenshots: [
          {
            id: "6a49" + "1".padStart(20, "0"),
            file_key: "AbCdEf1234567890XyZ",
            frame_id: "10:1",
            frame_name: "Checkout",
            page_id: "0:1",
            page_name: "Mobile",
            content_type: "image/png",
            width: 400,
            height: 800,
            size_bytes: 1000,
            boxes: [],
            image_url: null,
            image_url_expires_at: null,
            figma_url: null,
            created_at: "2026-10-28T10:00:00Z",
            updated_at: "2026-10-28T10:00:00Z",
            outdated_box_count: 1,
            refresh_requested_at: "2026-10-29T10:00:00Z",
            refresh_requested_by: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    )
    const refresh = createRefreshRequests({
      api: { screenshots, cancelRefreshRequest: vi.fn(async () => {}), resolveKeys: s.resolveKeys },
      bus: fakeMain().bus,
      context: () => ({ projectId: PROJECT_ID, mainLanguage: "en", gate: { enabled: true, fileKey: "AbCdEf1234567890XyZ" }, groupIdenticalTexts: true }),
      scanFrames: async () => ({ scope: "page", nodes: s.nodes(), total: s.nodes().length, truncated: false, skipped: SKIPPED, missingFrameIds: [] }),
      uploader: {
        prepare: vi.fn(async () => ({ gate: { enabled: true, reason: null, fileKey: "AbCdEf1234567890XyZ" }, availability: { meta: null, user: null, error: null } })),
        upload: vi.fn(async (frames: readonly ScreenshotFrame[]) => emptyScreenshotRun(frames.length)),
      },
      lock,
      pulled: (change) => void s.workspace.applyChanges(change),
    })
    await refresh.run()
    expect(refresh.store.get().outcome).toMatchObject({ kind: "done", pulled: 1 })
    expect(rowState(s.workspace.store.get(), "1:2")).toBe("synced")
  })

  it("the card shows ReRune's newest text of the key, which Overwrite and Take ReRune text act on", async () => {
    const s = await afterPush()
    const conflict = conflictOf("Sum")
    s.texts.set(K2, "Sum total")
    await s.workspace.refreshKeys({ keyIds: [K2] })
    const current = currentConflict(conflict, s.workspace.store.get().remote)
    expect(current).toEqual({ ...conflict, currentText: "Sum total" })
    const main = fakeMain()
    const nodes = new Map((s.workspace.store.get().result?.nodes ?? []).map((node) => [node.nodeId, node]))
    await executeTakeReRune({ api: { push: vi.fn() }, bus: main.bus }, current, { nodes })
    expect(main.writes[0]).toMatchObject({ type: "text-apply", items: [{ nodeId: "1:2", text: "Sum total", expectedSrc: src("Total due") }] })
    // A key ReRune no longer has keeps the text the push reported.
    expect(currentConflict(conflict, new Map())).toBe(conflict)
  })

  it("Overwrite goes ahead only while the layers still show the text the push sent", async () => {
    const s = await afterPush()
    const conflict = conflictOf("Sum")
    expect(unchangedSincePush(conflict, (await s.workspace.scanNodes(conflict.nodeIds)) ?? { nodes: [] })).toBe(true)
    s.type("1:2", "Total due now")
    expect(unchangedSincePush(conflict, (await s.workspace.scanNodes(conflict.nodeIds)) ?? { nodes: [] })).toBe(false)
    s.setNodes(s.nodes().filter((node) => node.nodeId !== "1:2"))
    expect(unchangedSincePush(conflict, (await s.workspace.scanNodes(conflict.nodeIds)) ?? { nodes: [] })).toBe(false)
    expect(CHANGED_SINCE_PUSH).toContain("Review again")
  })

  it("is wired so: the plan follows and checks with the functions above, every action that writes shows it at once, and a resolved card stays with its chip", () => {
    expect(pushScreen).toContain("void followShown(checkDeps(), from, baseRef.current, touchedRef.current)")
    expect(pushScreen).toContain("const next = await replanShown(checkDeps(), from, baseRef.current)")
    const push = pushScreen.slice(pushScreen.indexOf("  async function push() {"), pushScreen.indexOf("  // §7.13 rule 11: screenshots"))
    expect(push).toContain("checked = await checkPlan(checkDeps(), prepared, planSignature)")
    expect(push).toContain("executePush(pushDeps(), fresh.plan, fresh.context)")
    expect(push).toContain("await props.workspace.scanLayers(planLayerIds(fresh))")
    expect(push).not.toContain("workspace.scan()")
    const pull = pushScreen.slice(pushScreen.indexOf("  async function pull() {"), pushScreen.indexOf("  async function resolveConflict("))
    expect(pull).toContain("const checked = await checkPlan(checkDeps(), prepared, pullSignature)")
    expect(pull).toContain("if (restSignature(fresh.plan) !== restSignature(prepared.plan)) setPlanNote(OTHER_ROWS_CHANGED)")
    const resolve = pushScreen.slice(pushScreen.indexOf("  async function resolveConflict("), pushScreen.indexOf("  function nodesOf("))
    expect(resolve).toContain("await props.workspace.refreshKeys({ keyIds: [shown.keyId] })")
    expect(resolve).toContain("const conflict = currentConflict(shown, props.workspace.store.get().remote)")
    expect(resolve).toContain("if (scanned === null || !unchangedSincePush(conflict, scanned)) {")
    for (const call of ["await showWritten(pullChanges(fresh.plan, done))", "await showWritten(overwriteChanges(conflict, next))", "await showWritten(takeReRuneChanges(conflict, taken))"]) {
      expect(pushScreen).toContain(call)
    }
    expect(pushScreen).toContain("const now = liveState(conflict.nodeIds, screen.state, screen.project.id)")
    expect(pushScreen).toContain("{now !== null && <Chip tone={STATE_TONES[now]}>{STATE_LABELS[now]}</Chip>}")
    expect(pushScreen).toContain("ReRune now: {preview(current.currentText, 160)")
    expect(pushScreen).toContain("value={state === undefined ? null : state.choice}")
    // A choice holds the plan; a review starts without one.
    expect(pushScreen.match(/setTouched\(true\)/g)).toHaveLength(2)
  })
})
