import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaByNameRequest, FigmaByNameResponse, FigmaResolvedKey, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import { ApiError } from "../api/client"
import { cacheEntriesFromResolved, fetchTakenNames, fetchTextMatches, linkedKeyIds, loadRemoteStates, mapPool } from "./remote"
import { resolvedKey } from "./test-fakes"

function resolver(table: Map<string, FigmaResolvedKey>) {
  return vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
    source: request.source,
    variation_option: null,
    keys: request.key_ids.filter((id) => table.has(id)).map((id) => table.get(id) as FigmaResolvedKey),
    missing_key_ids: request.key_ids.filter((id) => !table.has(id)),
  }))
}

describe("linkedKeyIds", () => {
  it("collects keys of this project from every link state except invalid", () => {
    const nodes = [
      linkedNode("1:1", "A", { keyId: keyId(1), keyName: "a", syncedText: "A" }),
      linkedNode("1:2", "A", { keyId: keyId(1), keyName: "a", syncedText: "A", nid: "9:9", state: "copied" }),
      linkedNode("I5:1;1:3", "B", { keyId: keyId(2), keyName: "b", syncedText: "B", nid: "1:3", state: "inherited" }),
      linkedNode("1:4", "C", { keyId: keyId(3), keyName: "c", syncedText: "C", projectId: OTHER_PROJECT_ID }),
      linkedNode("1:5", "D", { keyId: keyId(4), keyName: "d", syncedText: "D", state: "invalid" }),
      scannedNode("1:6", "E"),
    ]
    expect(linkedKeyIds(nodes, PROJECT_ID)).toEqual([keyId(1), keyId(2)])
  })
})

describe("loadRemoteStates", () => {
  it("resolves the main language in chunks of 100 with at most 4 requests in flight", async () => {
    const ids = Array.from({ length: 650 }, (_, i) => keyId(i))
    const table = new Map(ids.slice(0, 640).map((id, i) => [id, resolvedKey(id, "k" + i, "Text " + i, { max_length: i === 3 ? 10 : null })]))
    let inFlight = 0
    let peak = 0
    const resolve = resolver(table)
    const api = {
      resolveKeys: async (projectId: string, request: FigmaResolveRequest) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((done) => setTimeout(done, 1))
        inFlight--
        return resolve(projectId, request)
      },
    }
    const load = await loadRemoteStates(api, PROJECT_ID, "en", ids)
    expect(resolve).toHaveBeenCalledTimes(7)
    expect(resolve.mock.calls.every(([, request]) => request.key_ids.length <= 100 && request.source === "draft" && request.languages[0] === "en" && request.variation_option_id === null)).toBe(true)
    expect(peak).toBeLessThanOrEqual(4)
    expect(load.error).toBeNull()
    expect(load.remote.get(ids[3])).toEqual({ found: true, key: "k3", type: "key", enabled: true, structured: false, mainText: "Text 3", maxLength: 10 })
    expect(load.remote.get(ids[645])).toEqual({ found: false, key: null, type: "key", enabled: false, structured: false, mainText: null, maxLength: null })
    expect(load.resolved.get(ids[0])?.key).toBe("k0")
  })

  it("keeps successful chunks and reports the first error", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => keyId(i))
    const table = new Map(ids.map((id) => [id, resolvedKey(id, id, "x")]))
    const resolve = resolver(table)
    const api = {
      resolveKeys: async (projectId: string, request: FigmaResolveRequest) => {
        if (request.key_ids[0] === ids[100]) {
          throw new ApiError(500, null, "boom")
        }
        return resolve(projectId, request)
      },
    }
    const load = await loadRemoteStates(api, PROJECT_ID, "en", ids)
    expect(load.remote.size).toBe(100)
    expect(load.error).toBeInstanceOf(ApiError)
  })

  it("does nothing without keys or a main language", async () => {
    const api = { resolveKeys: vi.fn() }
    expect((await loadRemoteStates(api, PROJECT_ID, "en", [])).remote.size).toBe(0)
    expect((await loadRemoteStates(api, PROJECT_ID, "", [keyId(1)])).remote.size).toBe(0)
    expect(api.resolveKeys).not.toHaveBeenCalled()
  })
})

describe("E11 lookups", () => {
  function byName(answer: (request: FigmaByNameRequest) => FigmaByNameResponse) {
    return vi.fn(async (_projectId: string, request: FigmaByNameRequest) => answer(request))
  }

  it("looks up unique texts in chunks of 100 and skips texts above 5000 UTF-16 units", async () => {
    const texts = Array.from({ length: 120 }, (_, i) => "Text " + i).concat(["Text 0", "", "x".repeat(5001)])
    const keysByName = byName((request) => ({
      keys: [],
      missing: [],
      text_matches: (request.texts ?? []).filter((text) => text.endsWith("7")).map((text) => ({ text, keys: [{ id: keyId(7), key: "seven" }] })),
    }))
    const matches = await fetchTextMatches({ keysByName }, PROJECT_ID, texts)
    expect(keysByName).toHaveBeenCalledTimes(2)
    expect(keysByName.mock.calls.map(([, request]) => request.texts?.length)).toEqual([100, 20])
    expect(keysByName.mock.calls.every(([, request]) => request.names === undefined)).toBe(true)
    expect(matches.get("Text 7")).toEqual([{ id: keyId(7), key: "seven" }])
    expect(matches.has("Text 8")).toBe(false)
  })

  it("returns the names that exist", async () => {
    const keysByName = byName((request) => ({
      keys: (request.names ?? []).filter((name) => name.startsWith("taken")).map((name) => ({ id: keyId(1), key: name, type: "key" as const, main_content: { value: "" } })),
      missing: [],
      text_matches: [],
    }))
    const taken = await fetchTakenNames({ keysByName }, PROJECT_ID, ["taken_a", "free_b", "taken_a", " "])
    expect(keysByName.mock.calls[0][1]).toEqual({ names: ["taken_a", "free_b"] })
    expect([...taken.keys()]).toEqual(["taken_a"])
  })
})

describe("mapPool", () => {
  it("keeps input order", async () => {
    await expect(mapPool([3, 1, 2], 2, async (n) => n * 2)).resolves.toEqual([6, 2, 4])
    await expect(mapPool([], 4, async (n: number) => n)).resolves.toEqual([])
  })
})

describe("cacheEntriesFromResolved", () => {
  it("caches key names, placeholders and up to 60 chars of source text for text keys", () => {
    const entries = cacheEntriesFromResolved(
      new Map([
        [keyId(1), resolvedKey(keyId(1), "greeting", "Hi {{name}}, " + "x".repeat(80), { placeholders: [{ name: "name", type: "string", format: "" }] })],
        [keyId(2), resolvedKey(keyId(2), "group", null, { type: "object", values: [] })],
        [keyId(3), resolvedKey(keyId(3), "empty", null)],
      ]),
      "en",
    )
    expect(entries).toEqual([
      { keyId: keyId(1), k: "greeting", placeholders: ["name"], sourceText: ("Hi {{name}}, " + "x".repeat(80)).slice(0, 60) },
      { keyId: keyId(3), k: "empty", placeholders: [], sourceText: "" },
    ])
  })
})
