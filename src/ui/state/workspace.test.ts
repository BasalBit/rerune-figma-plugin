import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import { src } from "../../shared/hash"
import type { ScannedNode, Scope } from "../../shared/messages"
import { computeSyncState } from "../../shared/sync-state"
import { ApiError } from "../api/client"
import { ScanCancelledError, type ScanResult, type ScanRunner } from "./ops"
import { resolvedKey } from "./test-fakes"
import { createWorkspace, NO_MAIN_LANGUAGE, REMOTE_REFRESH_MAX_CALLS } from "./workspace"

const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }

function fakeScanner(nodesFor: (scope: Scope) => ScannedNode[] | Error): ScanRunner & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  return {
    cancel: vi.fn<() => void>(),
    async run(scope, onProgress, frameIds): Promise<ScanResult> {
      const nodes = nodesFor(scope)
      if (nodes instanceof Error) {
        throw nodes
      }
      onProgress?.(nodes.length)
      const result: ScanResult = { scope, nodes, total: nodes.length, truncated: false, skipped: SKIPPED }
      return frameIds === undefined ? result : { ...result, missingFrameIds: frameIds.filter((frameId) => frameId.startsWith("99:")) }
    },
  }
}

function api(fail = false) {
  return {
    resolveKeys: vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => {
      if (fail) {
        throw new ApiError(0, "network", "offline")
      }
      return { source: "draft", variation_option: null, keys: request.key_ids.map((id) => resolvedKey(id, "name_" + id.slice(-1), "Pay now")), missing_key_ids: [] }
    }),
  }
}

describe("workspace", () => {
  const nodes = [
    linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "old", syncedText: "Pay now" }),
    scannedNode("1:2", "Unlinked"),
  ]

  it("scans, then loads remote state for linked keys", async () => {
    const resolver = api()
    const workspace = createWorkspace({ scanner: fakeScanner(() => nodes), api: resolver, project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    const result = await workspace.scan("page")
    expect(result?.nodes).toHaveLength(2)
    const state = workspace.store.get()
    expect(state).toMatchObject({ scope: "page", status: "ready", remoteStatus: "ready", remoteError: null, progress: 2 })
    expect(resolver.resolveKeys).toHaveBeenCalledWith(PROJECT_ID, { key_ids: [keyId(1)], languages: ["en"], source: "draft", variation_option_id: null })
    expect(state.remote.get(keyId(1))?.key).toBe("name_1")
    expect(state.resolved.has(keyId(1))).toBe(true)
  })

  it("reports a scan error and a remote error separately", async () => {
    const failing = createWorkspace({ scanner: fakeScanner(() => new Error("The plugin stopped responding. Try again.")), api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await expect(failing.scan()).resolves.toBeNull()
    expect(failing.store.get()).toMatchObject({ status: "error", error: "The plugin stopped responding. Try again." })

    const offline = createWorkspace({ scanner: fakeScanner(() => nodes), api: api(true), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await offline.scan()
    expect(offline.store.get()).toMatchObject({ status: "ready", remoteStatus: "error", remoteError: "Can't reach ReRune. Check your connection." })
  })

  it("ignores cancelled scans", async () => {
    const workspace = createWorkspace({ scanner: fakeScanner(() => new ScanCancelledError()), api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await workspace.scan()
    expect(workspace.store.get().status).toBe("scanning")
  })

  it("explains a project without a single main language", async () => {
    const resolver = api()
    const workspace = createWorkspace({ scanner: fakeScanner(() => nodes), api: resolver, project: () => ({ id: PROJECT_ID, main_language: "" }) })
    await workspace.scan()
    expect(workspace.store.get()).toMatchObject({ remoteStatus: "error", remoteError: NO_MAIN_LANGUAGE })
    expect(resolver.resolveKeys).not.toHaveBeenCalled()
  })

  it("keeps pending creates until the layer is linked", async () => {
    let current = nodes
    const workspace = createWorkspace({ scanner: fakeScanner(() => current), api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    workspace.setPending(["1:2", "5:5"], " checkout_title ")
    expect([...workspace.store.get().pending]).toEqual([["1:2", "checkout_title"], ["5:5", "checkout_title"]])
    await workspace.scan()
    expect(workspace.store.get().pending.get("1:2")).toBe("checkout_title")
    current = [nodes[0], linkedNode("1:2", "Unlinked", { keyId: keyId(2), keyName: "checkout_title", syncedText: "Unlinked" })]
    await workspace.scan()
    expect(workspace.store.get().pending.has("1:2")).toBe(false)
    expect(workspace.store.get().pending.has("5:5")).toBe(true)
    workspace.setPending(["5:5"], null)
    expect(workspace.store.get().pending.size).toBe(0)
  })

  it("clear() resets results, cancels the scanner and drops pending only when asked", async () => {
    const scanner = fakeScanner(() => nodes)
    const workspace = createWorkspace({ scanner, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) }, "page")
    await workspace.scan()
    workspace.setPending(["1:2"], "x")
    workspace.clear()
    expect(scanner.cancel).toHaveBeenCalled()
    expect(workspace.store.get()).toMatchObject({ scope: "page", status: "idle", result: null })
    expect(workspace.store.get().pending.size).toBe(1)
    workspace.clear(true)
    expect(workspace.store.get().pending.size).toBe(0)
  })

  it("scans the page for the automatic link sync without changing the shown scope, list or status (§7.7)", async () => {
    const shown = [scannedNode("9:1", "Selected")]
    const scanner = fakeScanner((scope) => (scope === "page" ? nodes : shown))
    const workspace = createWorkspace({ scanner, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await workspace.scan("selection")
    const before = workspace.store.get()
    const result = await workspace.scanDetached("page")
    expect(result?.nodes).toEqual(nodes)
    expect(workspace.store.get()).toBe(before)
    expect(workspace.store.get()).toMatchObject({ scope: "selection", status: "ready", result: { scope: "selection", nodes: shown } })
  })

  it("scans requested frames detached, like the automatic link sync (screenshot freshness)", async () => {
    const shown = [scannedNode("9:1", "Selected")]
    const scanner = fakeScanner((scope) => (scope === "page" ? nodes : shown))
    const run = vi.spyOn(scanner, "run")
    const workspace = createWorkspace({ scanner, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await workspace.scan("selection")
    const before = workspace.store.get()
    const result = await workspace.scanFrames(["10:1", "99:1"])
    expect(run).toHaveBeenLastCalledWith("page", undefined, ["10:1", "99:1"])
    expect(result).toMatchObject({ nodes, missingFrameIds: ["99:1"] })
    expect(workspace.store.get()).toBe(before)

    let finish: () => void = () => {}
    const waiting: ScanRunner = {
      cancel: vi.fn<() => void>(),
      run: vi.fn((scope: Scope) => new Promise<ScanResult>((resolve) => (finish = () => resolve({ scope, nodes, total: 2, truncated: false, skipped: SKIPPED })))),
    }
    const busy = createWorkspace({ scanner: waiting, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    const shownScan = busy.scan("selection")
    expect(await busy.scanFrames(["10:1"])).toBeNull()
    finish()
    await shownScan
  })

  it("lets a scan of requested frames finish when the page changes, but not on another project or sign-out", async () => {
    const pending: (() => void)[] = []
    const waiting: ScanRunner & { cancel: ReturnType<typeof vi.fn<() => void>> } = {
      cancel: vi.fn<() => void>(),
      run: vi.fn(
        (scope: Scope) =>
          new Promise<ScanResult>((resolve) => {
            pending.push(() => resolve({ scope, nodes, total: 2, truncated: false, skipped: SKIPPED, missingFrameIds: [] }))
          }),
      ),
    }
    const workspace = createWorkspace({ scanner: waiting, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    const frames = workspace.scanFrames(["10:1"])
    workspace.clear()
    expect(waiting.cancel).not.toHaveBeenCalled()
    pending[0]()
    expect(await frames).toMatchObject({ nodes })

    // Once it ended, a page change cancels the runner's scan again (the automatic link sync's, for one).
    const page = workspace.scanDetached("page")
    workspace.clear()
    expect(waiting.cancel).toHaveBeenCalledTimes(1)
    pending[1]()
    await page

    void workspace.scanFrames(["10:1"])
    workspace.clear(true)
    expect(waiting.cancel).toHaveBeenCalledTimes(2)
  })

  it("leaves the shown scan alone: null while it runs or when a newer scan cancels it, and throws a failure", async () => {
    let finish: () => void = () => {}
    const waiting: ScanRunner & { cancel: ReturnType<typeof vi.fn<() => void>> } = {
      cancel: vi.fn<() => void>(),
      run: vi.fn((scope: Scope) => new Promise<ScanResult>((resolve) => (finish = () => resolve({ scope, nodes, total: 2, truncated: false, skipped: SKIPPED })))),
    }
    const busy = createWorkspace({ scanner: waiting, api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    const shownScan = busy.scan("selection")
    expect(await busy.scanDetached("page")).toBeNull()
    expect(waiting.run).toHaveBeenCalledTimes(1)
    finish()
    await shownScan
    expect(busy.store.get().status).toBe("ready")

    const cancelled = createWorkspace({ scanner: fakeScanner(() => new ScanCancelledError()), api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    expect(await cancelled.scanDetached("page")).toBeNull()
    const failing = createWorkspace({ scanner: fakeScanner(() => new Error("The plugin stopped responding. Try again.")), api: api(), project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await expect(failing.scanDetached("page")).rejects.toThrow("The plugin stopped responding. Try again.")
    expect(failing.store.get()).toMatchObject({ status: "idle", error: null })
  })
})

// ReRune edits while the plugin is open: the keys in view are read again without a scan, and actions that know what
// they wrote change the shown layers at once.
describe("workspace: background reads and action outcomes", () => {
  type Texts = Map<string, string | null>
  // E12 answering from `texts` (key id → main text; null: the key is gone), recording each call's keys.
  function remoteApi(texts: Texts) {
    const calls: string[][] = []
    let fail: unknown = null
    let hold: Promise<void> | null = null
    const resolveKeys = vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => {
      calls.push(request.key_ids)
      const snapshot = new Map(texts)
      if (hold !== null) {
        await hold
      }
      if (fail !== null) {
        throw fail
      }
      const present = request.key_ids.filter((id) => snapshot.get(id) !== null && snapshot.has(id))
      return {
        source: "draft",
        variation_option: null,
        keys: present.map((id) => resolvedKey(id, "key_" + id.slice(-3), snapshot.get(id) ?? "")),
        missing_key_ids: request.key_ids.filter((id) => !present.includes(id)),
      }
    })
    return {
      api: { resolveKeys },
      calls,
      failWith: (error: unknown) => (fail = error),
      // Answers wait until the returned function is called (the texts are read when the call starts).
      holdAnswers() {
        let release: () => void = () => {}
        hold = new Promise<void>((resolve) => (release = resolve))
        return () => {
          hold = null
          release()
        }
      },
    }
  }

  const pay = linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "key_001", syncedText: "Pay now" })
  const total = linkedNode("1:2", "Total", { keyId: keyId(2), keyName: "key_002", syncedText: "Total" })
  const free = scannedNode("1:3", "Free text")

  async function setup(nodes: ScannedNode[] = [pay, total, free], texts: Texts = new Map([[keyId(1), "Pay now"], [keyId(2), "Total"]])) {
    const remote = remoteApi(texts)
    const scanner = fakeScanner(() => nodes)
    const run = vi.spyOn(scanner, "run")
    const project = { id: PROJECT_ID, main_language: "en" }
    const workspace = createWorkspace({ scanner, api: remote.api, project: () => project })
    await workspace.scan("page")
    return { workspace, remote, run, texts, project }
  }

  const syncState = (workspace: ReturnType<typeof createWorkspace>, nodeId: string) => {
    const state = workspace.store.get()
    const node = state.result?.nodes.find((entry) => entry.nodeId === nodeId)
    return node === undefined || node.link === null ? null : computeSyncState(PROJECT_ID, node, state.remote.get(node.link.id))
  }

  it("reads the keys in view again without scanning, and a ReRune edit shows as Changed in ReRune", async () => {
    const s = await setup()
    expect(syncState(s.workspace, "1:1")).toBe("synced")
    s.texts.set(keyId(1), "Pay today")
    await expect(s.workspace.refreshKeys()).resolves.toEqual({ kind: "read" })
    // No scan of the scope: only the layer of the key that changed is read again, by id.
    expect(s.run).toHaveBeenCalledTimes(2)
    expect(s.run.mock.calls[1][2]).toEqual(["1:1"])
    expect(s.remote.calls[s.remote.calls.length - 1]).toEqual([keyId(1), keyId(2)])
    expect(syncState(s.workspace, "1:1")).toBe("changed_in_rerune")
    expect(syncState(s.workspace, "1:2")).toBe("synced")
    expect(s.workspace.store.get()).toMatchObject({ remoteStatus: "ready", remoteError: null, scanId: 1 })
    expect(s.workspace.store.get().resolved.get(keyId(1))?.values[0].content?.value).toBe("Pay today")
  })

  it("leaves the state as it is when nothing changed in ReRune", async () => {
    const s = await setup()
    const before = s.workspace.store.get()
    await s.workspace.refreshKeys()
    expect(s.workspace.store.get()).toBe(before)
  })

  it("shows a key deleted in ReRune as missing", async () => {
    const s = await setup()
    s.texts.set(keyId(2), null)
    await s.workspace.refreshKeys()
    expect(syncState(s.workspace, "1:2")).toBe("key_missing")
    expect(s.workspace.store.get().resolved.has(keyId(2))).toBe(false)
  })

  it("keeps what is shown and reports the failure when the read fails", async () => {
    const s = await setup()
    const before = s.workspace.store.get()
    const error = new ApiError(503, null, "Service Unavailable")
    s.remote.failWith(error)
    await expect(s.workspace.refreshKeys()).resolves.toEqual({ kind: "failed", error })
    expect(s.workspace.store.get()).toBe(before)
  })

  it("drops an answer that a scan, a clear or a main language change made stale", async () => {
    const s = await setup()
    s.texts.set(keyId(1), "Pay today")
    let release = s.remote.holdAnswers()
    const overtaken = s.workspace.refreshKeys()
    const scan = s.workspace.scan("page")
    // The scan's own read sees an edit made after the background read started.
    s.texts.set(keyId(1), "Pay later")
    await vi.waitFor(() => expect(s.remote.calls).toHaveLength(3))
    release()
    await Promise.all([overtaken, scan])
    expect(s.workspace.store.get().scanId).toBe(2)
    expect(s.workspace.store.get().remote.get(keyId(1))?.mainText).toBe("Pay later")

    release = s.remote.holdAnswers()
    const cleared = s.workspace.refreshKeys()
    s.workspace.clear()
    release()
    await expect(cleared).resolves.toEqual({ kind: "read" })
    expect(s.workspace.store.get()).toMatchObject({ result: null, remote: new Map() })

    const again = await setup()
    again.texts.set(keyId(1), "Zahlen")
    release = again.remote.holdAnswers()
    const before = again.workspace.store.get()
    const language = again.workspace.refreshKeys()
    again.project.main_language = "de"
    release()
    await language
    expect(again.workspace.store.get()).toBe(before)
  })

  it("is skipped while the workspace loads the remote state itself, and reads nothing without linked layers", async () => {
    const s = await setup()
    const release = s.remote.holdAnswers()
    const loading = s.workspace.refreshRemote()
    await expect(s.workspace.refreshKeys()).resolves.toEqual({ kind: "skipped" })
    release()
    await loading
    const calls = s.remote.calls.length
    const plain = await setup([free])
    await expect(plain.workspace.refreshKeys()).resolves.toEqual({ kind: "read" })
    expect(plain.remote.calls).toHaveLength(0)
    expect(s.remote.calls).toHaveLength(calls)
  })

  it("explains a project that lost its main language, and loads again once it has one", async () => {
    const s = await setup()
    s.project.main_language = ""
    await s.workspace.refreshKeys()
    expect(s.workspace.store.get()).toMatchObject({ remoteStatus: "error", remoteError: NO_MAIN_LANGUAGE })
    s.project.main_language = "en"
    await s.workspace.refreshKeys()
    expect(s.workspace.store.get()).toMatchObject({ remoteStatus: "ready", remoteError: null })
    expect(syncState(s.workspace, "1:1")).toBe("synced")
  })

  it("sends at most 5 E12 calls per read (500 keys in calls of 100, fewer with a smaller max_batch_size), the next ones each time", async () => {
    const many = Array.from({ length: 1200 }, (_, index) => linkedNode("2:" + index, "Text " + index, { keyId: keyId(index + 10), keyName: "k" + index, syncedText: "Text " + index }))
    const texts: Texts = new Map(many.map((node, index) => [keyId(index + 10), "Text " + index]))
    const ids = (from: number, to?: number) => many.slice(from, to).map((node) => node.link?.id)
    const s = await setup(many, texts)
    s.remote.calls.length = 0
    await s.workspace.refreshKeys()
    expect(s.remote.calls).toHaveLength(REMOTE_REFRESH_MAX_CALLS)
    expect(s.remote.calls.every((call) => call.length === 100)).toBe(true)
    const first = s.remote.calls.flat()
    expect(first).toEqual(ids(0, 500))
    s.remote.calls.length = 0
    await s.workspace.refreshKeys()
    expect(s.remote.calls.flat()).toEqual(ids(500, 1000))
    s.remote.calls.length = 0
    await s.workspace.refreshKeys()
    expect(s.remote.calls.flat()).toEqual(ids(1000))
    s.remote.calls.length = 0
    await s.workspace.refreshKeys()
    expect(s.remote.calls.flat()).toEqual(first)
    // E1's max_batch_size of 50: still 5 calls, 250 keys.
    s.remote.calls.length = 0
    await s.workspace.refreshKeys({ chunkSize: 50 })
    expect(s.remote.calls.map((call) => call.length)).toEqual([50, 50, 50, 50, 50])
    expect(s.remote.calls.flat()).toEqual(ids(500, 750))
    // Named keys are read at once, whatever the turn.
    s.remote.calls.length = 0
    await s.workspace.refreshKeys({ keyIds: [keyId(10), keyId(5000)] })
    expect(s.remote.calls.flat()).toEqual([keyId(10)])
  })

  it("shows what a pull wrote at once: the layer, and the instance that inherits its main component", async () => {
    const main = linkedNode("5:1", "Old", { keyId: keyId(3), keyName: "key_003", syncedText: "Old" })
    const instance = linkedNode("I9:1;5:1", "Old", { keyId: keyId(3), keyName: "key_003", syncedText: "Old", nid: "5:1", state: "inherited" })
    const s = await setup([main, instance, pay], new Map([[keyId(3), "New"], [keyId(1), "Pay now"]]))
    expect(syncState(s.workspace, "5:1")).toBe("changed_in_rerune")
    expect(syncState(s.workspace, "I9:1;5:1")).toBe("changed_in_rerune")
    const before = s.workspace.store.get()
    const touched = s.workspace.applyChanges({ layers: [{ nodeId: "5:1", text: "New", src: src("New") }] })
    expect(touched).toEqual([keyId(3)])
    expect(syncState(s.workspace, "5:1")).toBe("synced")
    expect(syncState(s.workspace, "I9:1;5:1")).toBe("synced")
    expect(s.workspace.store.get().result?.nodes.find((node) => node.nodeId === "I9:1;5:1")?.characters).toBe("New")
    expect(s.workspace.store.get().result?.nodes[2]).toBe(before.result?.nodes[2])
    expect(s.workspace.store.get().scanId).toBe(before.scanId)
  })

  it("shows an Overwrite at once (the key's text and the layer's link), and drops a read that started before it", async () => {
    const edited = linkedNode("1:1", "Pay today", { keyId: keyId(1), keyName: "key_001", syncedText: "Pay now" })
    const s = await setup([edited, total], new Map([[keyId(1), "Pay soon"], [keyId(2), "Total"]]))
    expect(syncState(s.workspace, "1:1")).toBe("conflict")
    const release = s.remote.holdAnswers()
    const older = s.workspace.refreshKeys()
    s.workspace.applyChanges({ layers: [{ nodeId: "1:1", src: src("Pay today") }], mainTexts: new Map([[keyId(1), "Pay today"]]) })
    expect(syncState(s.workspace, "1:1")).toBe("synced")
    release()
    await older
    expect(syncState(s.workspace, "1:1")).toBe("synced")
    // A read after the action applies.
    s.texts.set(keyId(1), "Pay today")
    s.texts.set(keyId(2), "Sum")
    await s.workspace.refreshKeys()
    expect(syncState(s.workspace, "1:1")).toBe("synced")
    expect(syncState(s.workspace, "1:2")).toBe("changed_in_rerune")
  })

  // A canvas the scans read: the selection, the page, or layers by id (those not on it come back missing).
  function canvas(initial: ScannedNode[], selection: string[] = initial.map((node) => node.nodeId)) {
    const layers = new Map(initial.map((node) => [node.nodeId, node]))
    const picked = { ids: selection }
    let hold: Promise<void> | null = null
    const run = vi.fn(async (scope: Scope, _progress?: (scanned: number) => void, nodeIds?: readonly string[]): Promise<ScanResult> => {
      if (hold !== null) {
        await hold
      }
      const ids = nodeIds ?? (scope === "selection" ? picked.ids : [...layers.keys()])
      const nodes = ids.map((id) => layers.get(id)).filter((node): node is ScannedNode => node !== undefined)
      const result: ScanResult = { scope, nodes, total: nodes.length, truncated: false, skipped: SKIPPED }
      return nodeIds === undefined ? result : { ...result, missingFrameIds: nodeIds.filter((id) => !layers.has(id)), hiddenFrameIds: [] }
    })
    return {
      scanner: { cancel: vi.fn(), run } satisfies ScanRunner,
      run,
      picked,
      type: (nodeId: string, characters: string) => layers.set(nodeId, { ...(layers.get(nodeId) as ScannedNode), characters }),
      remove: (nodeId: string) => layers.delete(nodeId),
      holdScans() {
        let release: () => void = () => {}
        hold = new Promise<void>((resolve) => (release = resolve))
        return () => {
          hold = null
          release()
        }
      },
    }
  }

  async function onCanvas(scope: Scope, selection?: string[]) {
    const texts: Texts = new Map([[keyId(1), "Pay now"], [keyId(2), "Total"]])
    const remote = remoteApi(texts)
    const figma = canvas([pay, total, free], selection)
    const workspace = createWorkspace({ scanner: figma.scanner, api: remote.api, project: () => ({ id: PROJECT_ID, main_language: "en" }) })
    await workspace.scan(scope)
    return { workspace, remote, figma, texts }
  }

  it("reads again from the canvas only the layers of a key that changed in ReRune: one edited in Figma since shows Changed in both", async () => {
    const s = await onCanvas("page")
    s.figma.type("1:1", "Pay soon")
    s.figma.type("1:2", "Total due")
    s.texts.set(keyId(1), "Pay today")
    await s.workspace.refreshKeys()
    expect(s.figma.run).toHaveBeenCalledTimes(2)
    expect(s.figma.run.mock.calls[1][2]).toEqual(["1:1"])
    expect(syncState(s.workspace, "1:1")).toBe("conflict")
    // The other layer is not read again: its key did not change (the scan shows it as it was).
    expect(syncState(s.workspace, "1:2")).toBe("synced")
    expect(s.workspace.store.get().scanId).toBe(1)
  })

  it("never starts that read while another scan runs (it would cancel it), and shows ReRune's change anyway", async () => {
    const s = await onCanvas("page")
    s.figma.type("1:1", "Pay soon")
    s.texts.set(keyId(1), "Pay today")
    const release = s.figma.holdScans()
    const detached = s.workspace.scanDetached("page")
    await s.workspace.refreshKeys()
    expect(s.figma.run).toHaveBeenCalledTimes(2)
    expect(syncState(s.workspace, "1:1")).toBe("changed_in_rerune")
    release()
    await expect(detached).resolves.not.toBeNull()
  })

  it("scans the layers of a review by id wherever the selection is now: the list shows them, the scope stays and a deleted one leaves it", async () => {
    const s = await onCanvas("selection")
    expect(s.workspace.store.get().result?.nodes.map((node) => node.nodeId)).toEqual(["1:1", "1:2", "1:3"])
    // Select on a row changed the selection; one layer was deleted.
    s.figma.picked.ids = ["1:2"]
    s.figma.remove("1:3")
    s.texts.set(keyId(2), "Sum")
    const result = await s.workspace.scanLayers(["1:1", "1:2", "1:3"])
    expect(s.figma.run.mock.calls[1][0]).toBe("selection")
    expect(s.figma.run.mock.calls[1][2]).toEqual(["1:1", "1:2", "1:3"])
    const state = s.workspace.store.get()
    expect(state).toMatchObject({ scope: "selection", status: "ready", remoteStatus: "ready", scanId: 2 })
    expect(state.result).toBe(result)
    expect(result?.nodes.map((node) => node.nodeId)).toEqual(["1:1", "1:2"])
    expect(result).not.toHaveProperty("missingFrameIds")
    expect(syncState(s.workspace, "1:2")).toBe("changed_in_rerune")
  })

  it("reads layers by id without showing them (a conflict's layers before Overwrite)", async () => {
    const s = await onCanvas("page")
    const before = s.workspace.store.get()
    s.figma.type("1:1", "Pay soon")
    const result = await s.workspace.scanNodes(["1:1", "9:9"])
    expect(result?.nodes.map((node) => node.characters)).toEqual(["Pay soon"])
    expect(result?.missingFrameIds).toEqual(["9:9"])
    expect(s.workspace.store.get()).toBe(before)
  })
})
