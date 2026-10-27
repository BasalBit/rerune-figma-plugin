import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installFigma, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { STORAGE_KEYS } from "../shared/constants"
import type { CodegenCacheEntry, StoredAuth } from "../shared/messages"
import {
  clearAuth,
  codegenCacheKey,
  loadAuth,
  loadPrefs,
  mergeCodegenCache,
  parseAuthMap,
  parseCodegenCache,
  parseCodegenIndex,
  parseStoredAuth,
  readCodegenCache,
  saveAuth,
  saveCodegenCache,
  savePrefs,
  touchCodegenIndex,
  type CodegenCache,
} from "./auth-storage"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const PROD = "https://rerune.io/api"
const LOCAL = "http://localhost:8080"

function auth(apiBase: string, token = "rrf_" + "a".repeat(64)): StoredAuth {
  return {
    apiBase,
    token,
    tokenId: "6a4900000000000000000001",
    tokenExpiresAt: "2027-01-25T10:00:00Z",
    user: { id: "kc-1", email: "dana@example.com", firstName: "Dana", lastName: "Designer" },
    savedAt: 1761550000000,
  }
}

function projectId(n: number): string {
  return "6a46" + String(n).padStart(20, "0")
}

function entry(n: number, extra: Partial<CodegenCacheEntry> = {}): CodegenCacheEntry {
  return { keyId: "6a48" + String(n).padStart(20, "0"), k: "key_" + n, placeholders: [], sourceText: "Text " + n, ...extra }
}

describe("auth storage", () => {
  it("stores one StoredAuth per apiBase and loads the matching one", async () => {
    await saveAuth(auth(PROD))
    await saveAuth(auth(LOCAL, "rrf_" + "b".repeat(64)))
    expect(await loadAuth(PROD)).toEqual(auth(PROD))
    expect((await loadAuth(LOCAL))?.token).toBe("rrf_" + "b".repeat(64))
    expect(await loadAuth("https://other.example")).toBeNull()
    expect(Object.keys(figmaMock.clientStorage.data.get(STORAGE_KEYS.auth) as object)).toEqual([PROD, LOCAL])
  })

  it("clears only the given apiBase and deletes the key when none is left", async () => {
    await saveAuth(auth(PROD))
    await saveAuth(auth(LOCAL))
    await clearAuth(LOCAL)
    expect(await loadAuth(LOCAL)).toBeNull()
    expect(await loadAuth(PROD)).not.toBeNull()
    await clearAuth(PROD)
    expect(figmaMock.clientStorage.data.has(STORAGE_KEYS.auth)).toBe(false)
  })

  it("rejects invalid auth without writing", async () => {
    await expect(saveAuth({ ...auth(PROD), token: "" })).rejects.toThrow("Invalid sign-in data")
    expect(figmaMock.clientStorage.setAsync).not.toHaveBeenCalled()
  })

  it("drops the codegen caches and retries when storage is full", async () => {
    figmaMock.clientStorage.data.set(codegenCacheKey(projectId(1)), { a: 1 })
    figmaMock.clientStorage.data.set(STORAGE_KEYS.codegenIndex, [{ projectId: projectId(1), usedAt: 1 }])
    figmaMock.clientStorage.data.set(STORAGE_KEYS.prefs, { lastLanguage: "de" })
    let calls = 0
    figmaMock.clientStorage.setAsync.mockImplementation(async (key: string, value: unknown) => {
      calls++
      if (calls === 1) {
        throw new Error("Storage limit exceeded")
      }
      figmaMock.clientStorage.data.set(key, value)
    })
    await saveAuth(auth(PROD))
    expect(await loadAuth(PROD)).toEqual(auth(PROD))
    expect(figmaMock.clientStorage.data.has(codegenCacheKey(projectId(1)))).toBe(false)
    expect(figmaMock.clientStorage.data.has(STORAGE_KEYS.codegenIndex)).toBe(false)
    expect(figmaMock.clientStorage.data.get(STORAGE_KEYS.prefs)).toEqual({ lastLanguage: "de" })
  })

  it("parses stored auth defensively", () => {
    expect(parseStoredAuth(null)).toBeNull()
    expect(parseStoredAuth({ ...auth(PROD), user: null })).toBeNull()
    expect(parseStoredAuth({ ...auth(PROD), tokenId: 3 })).toBeNull()
    expect(parseStoredAuth({ ...auth(PROD), user: { id: "kc", email: "e@x" }, savedAt: "x" })).toEqual({
      ...auth(PROD),
      user: { id: "kc", email: "e@x", firstName: "", lastName: "" },
      savedAt: 0,
    })
    expect(parseAuthMap({ [PROD]: auth(PROD), [LOCAL]: auth(PROD), bad: 1 })).toEqual({ [PROD]: auth(PROD) })
    expect(parseAuthMap("x")).toEqual({})
  })
})

describe("prefs", () => {
  it("merges changed fields into the stored prefs", async () => {
    await savePrefs({ lastLanguage: "de", lastSource: "draft" })
    await savePrefs({ lastLanguage: "it", inspectPlatform: "flutter" })
    expect(await loadPrefs()).toEqual({ lastLanguage: "it", lastSource: "draft", inspectPlatform: "flutter" })
  })

  it("serialises concurrent writes so none is lost", async () => {
    await Promise.all([savePrefs({ a: 1 }), savePrefs({ b: 2 }), savePrefs({ c: 3 })])
    expect(await loadPrefs()).toEqual({ a: 1, b: 2, c: 3 })
  })

  it("returns {} for missing or invalid prefs", async () => {
    expect(await loadPrefs()).toEqual({})
    figmaMock.clientStorage.data.set(STORAGE_KEYS.prefs, [1, 2])
    expect(await loadPrefs()).toEqual({})
  })
})

describe("codegen cache (pure)", () => {
  it("adds entries stamped with now and truncates source text to 60 chars", () => {
    const merged = mergeCodegenCache({}, [entry(1, { sourceText: "x".repeat(80), placeholders: ["name"] })], 5)
    expect(merged).toEqual({ [entry(1).keyId]: { k: "key_1", placeholders: ["name"], sourceText: "x".repeat(60), updatedAt: 5 } })
  })

  it("keeps at most 2000 entries, dropping the oldest updatedAt", () => {
    let cache: CodegenCache = {}
    cache = mergeCodegenCache(cache, Array.from({ length: 1500 }, (_, i) => entry(i)), 1)
    cache = mergeCodegenCache(cache, Array.from({ length: 600 }, (_, i) => entry(5000 + i)), 2)
    expect(Object.keys(cache)).toHaveLength(2000)
    expect(cache[entry(0).keyId]).toBeUndefined()
    expect(cache[entry(99).keyId]).toBeUndefined()
    expect(cache[entry(100).keyId]).toBeDefined()
    expect(cache[entry(5599).keyId]?.updatedAt).toBe(2)
  })

  it("refreshing an entry protects it from eviction", () => {
    let cache: CodegenCache = mergeCodegenCache({}, Array.from({ length: 2000 }, (_, i) => entry(i)), 1)
    cache = mergeCodegenCache(cache, [entry(0)], 2)
    cache = mergeCodegenCache(cache, [entry(9000)], 3)
    expect(cache[entry(0).keyId]).toBeDefined()
    expect(cache[entry(1).keyId]).toBeUndefined()
    expect(cache[entry(9000).keyId]).toBeDefined()
  })

  it("ignores invalid entries", () => {
    const bad = [{ keyId: "", k: "x", placeholders: [], sourceText: "" }, { keyId: "id", k: "", placeholders: [], sourceText: "" }] as CodegenCacheEntry[]
    expect(mergeCodegenCache({}, bad, 1)).toEqual({})
  })

  it("keeps the 10 most recently used projects", () => {
    let index = parseCodegenIndex([])
    const evicted: string[] = []
    for (let i = 1; i <= 11; i++) {
      const touched = touchCodegenIndex(index, projectId(i), i)
      index = touched.index
      evicted.push(...touched.evicted)
    }
    expect(index).toHaveLength(10)
    expect(evicted).toEqual([projectId(1)])
    const again = touchCodegenIndex(index, projectId(2), 20)
    expect(again.index[0]).toEqual({ projectId: projectId(2), usedAt: 20 })
    expect(again.evicted).toEqual([])
  })

  it("parses caches and indexes defensively", () => {
    expect(parseCodegenCache({ a: { k: "x", placeholders: ["p", 3], updatedAt: 1 }, b: { k: "" }, c: null })).toEqual({
      a: { k: "x", placeholders: ["p"], sourceText: "", updatedAt: 1 },
    })
    expect(parseCodegenIndex([{ projectId: "p", usedAt: 1 }, { projectId: 3 }, null])).toEqual([{ projectId: "p", usedAt: 1 }])
    expect(parseCodegenIndex({})).toEqual([])
  })
})

describe("codegen cache storage", () => {
  it("writes one key per project plus the index and reads it back", async () => {
    expect(await saveCodegenCache(projectId(1), [entry(1)], 10)).toBe(true)
    expect(await readCodegenCache(projectId(1))).toEqual({ [entry(1).keyId]: { k: "key_1", placeholders: [], sourceText: "Text 1", updatedAt: 10 } })
    expect(figmaMock.clientStorage.data.get(STORAGE_KEYS.codegenIndex)).toEqual([{ projectId: projectId(1), usedAt: 10 }])
  })

  it("deletes the cache of the least recently used project beyond 10", async () => {
    for (let i = 1; i <= 11; i++) {
      await saveCodegenCache(projectId(i), [entry(i)], i)
    }
    expect(figmaMock.clientStorage.data.has(codegenCacheKey(projectId(1)))).toBe(false)
    expect(figmaMock.clientStorage.data.has(codegenCacheKey(projectId(11)))).toBe(true)
    expect(await readCodegenCache(projectId(1))).toEqual({})
  })

  it("swallows storage failures and invalid project ids", async () => {
    figmaMock.clientStorage.failWrites = true
    expect(await saveCodegenCache(projectId(1), [entry(1)], 1)).toBe(false)
    figmaMock.clientStorage.failWrites = false
    expect(await saveCodegenCache("../auth", [entry(1)], 1)).toBe(false)
    expect(await readCodegenCache("x")).toEqual({})
  })

  it("a failed cache write never blocks a later auth write", async () => {
    figmaMock.clientStorage.failWrites = true
    await saveCodegenCache(projectId(1), [entry(1)], 1)
    figmaMock.clientStorage.failWrites = false
    await saveAuth(auth(PROD))
    expect(await loadAuth(PROD)).not.toBeNull()
  })
})
