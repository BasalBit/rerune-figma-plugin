import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import type { ScannedNode, Scope } from "../../shared/messages"
import { ApiError } from "../api/client"
import { ScanCancelledError, type ScanResult, type ScanRunner } from "./ops"
import { resolvedKey } from "./test-fakes"
import { createWorkspace, NO_MAIN_LANGUAGE } from "./workspace"

const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }

function fakeScanner(nodesFor: (scope: Scope) => ScannedNode[] | Error): ScanRunner & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  return {
    cancel: vi.fn<() => void>(),
    async run(scope, onProgress): Promise<ScanResult> {
      const nodes = nodesFor(scope)
      if (nodes instanceof Error) {
        throw nodes
      }
      onProgress?.(nodes.length)
      return { scope, nodes, total: nodes.length, truncated: false, skipped: SKIPPED }
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
