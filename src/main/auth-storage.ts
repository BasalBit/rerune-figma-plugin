import {
  CODEGEN_CACHE_MAX_ENTRIES,
  CODEGEN_CACHE_MAX_PROJECTS,
  CODEGEN_SOURCE_TEXT_MAX_CHARS,
  OBJECT_ID_PATTERN,
  STORAGE_KEYS,
} from "../shared/constants"
import type { CodegenCacheEntry, StoredAuth } from "../shared/messages"
import { truncateUtf16 } from "../shared/text"

// figma.clientStorage (§7.19). Only main can reach it; the UI talks to it through messages.

export interface CachedKey { k: string; placeholders: string[]; sourceText: string; updatedAt: number }
export type CodegenCache = Record<string, CachedKey>
export interface CodegenIndexEntry { projectId: string; usedAt: number }

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

export function codegenCacheKey(projectId: string): string {
  return STORAGE_KEYS.codegenPrefix + projectId
}

export function parseStoredAuth(value: unknown): StoredAuth | null {
  if (!isObject(value) || !isObject(value.user)) {
    return null
  }
  const { apiBase, token, tokenId, tokenExpiresAt, savedAt } = value
  const user = value.user
  if (!isNonEmptyString(apiBase) || !isNonEmptyString(token) || !isNonEmptyString(tokenId) || !isNonEmptyString(user.id) || typeof user.email !== "string") {
    return null
  }
  return {
    apiBase,
    token,
    tokenId,
    tokenExpiresAt: stringOr(tokenExpiresAt, ""),
    user: { id: user.id, email: user.email, firstName: stringOr(user.firstName, ""), lastName: stringOr(user.lastName, "") },
    savedAt: typeof savedAt === "number" && isFinite(savedAt) ? savedAt : 0,
  }
}

export function parseAuthMap(value: unknown): Record<string, StoredAuth> {
  const result: Record<string, StoredAuth> = {}
  if (!isObject(value)) {
    return result
  }
  for (const apiBase of Object.keys(value)) {
    const auth = parseStoredAuth(value[apiBase])
    if (auth !== null && auth.apiBase === apiBase) {
      result[apiBase] = auth
    }
  }
  return result
}

export function parsePrefs(value: unknown): Record<string, unknown> {
  return isObject(value) ? { ...value } : {}
}

function parseCachedKey(value: unknown): CachedKey | null {
  if (!isObject(value) || !isNonEmptyString(value.k) || !Array.isArray(value.placeholders) || typeof value.updatedAt !== "number") {
    return null
  }
  return {
    k: value.k,
    placeholders: value.placeholders.filter((entry): entry is string => typeof entry === "string"),
    sourceText: truncateUtf16(stringOr(value.sourceText, ""), CODEGEN_SOURCE_TEXT_MAX_CHARS),
    updatedAt: value.updatedAt,
  }
}

export function parseCodegenCache(value: unknown): CodegenCache {
  const result: CodegenCache = {}
  if (!isObject(value)) {
    return result
  }
  for (const keyId of Object.keys(value)) {
    const entry = parseCachedKey(value[keyId])
    if (entry !== null) {
      result[keyId] = entry
    }
  }
  return result
}

export function parseCodegenIndex(value: unknown): CodegenIndexEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result: CodegenIndexEntry[] = []
  for (const entry of value) {
    if (isObject(entry) && isNonEmptyString(entry.projectId) && typeof entry.usedAt === "number") {
      result.push({ projectId: entry.projectId, usedAt: entry.usedAt })
    }
  }
  return result
}

// Adds entries (stamped `now`) and keeps at most 2000 keys, dropping the oldest `updatedAt` first (on a tie,
// the entry stored earlier goes first).
export function mergeCodegenCache(cache: CodegenCache, entries: readonly CodegenCacheEntry[], now: number): CodegenCache {
  const next: CodegenCache = {}
  for (const keyId of Object.keys(cache)) {
    next[keyId] = cache[keyId]
  }
  for (const entry of entries) {
    if (!isNonEmptyString(entry.keyId) || !isNonEmptyString(entry.k) || !Array.isArray(entry.placeholders)) {
      continue
    }
    next[entry.keyId] = {
      k: entry.k,
      placeholders: entry.placeholders.filter((name) => typeof name === "string"),
      sourceText: truncateUtf16(stringOr(entry.sourceText, ""), CODEGEN_SOURCE_TEXT_MAX_CHARS),
      updatedAt: now,
    }
  }
  const ids = Object.keys(next)
  if (ids.length <= CODEGEN_CACHE_MAX_ENTRIES) {
    return next
  }
  const kept = ids
    .map((keyId, order) => ({ keyId, order, updatedAt: next[keyId].updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.order - a.order)
    .slice(0, CODEGEN_CACHE_MAX_ENTRIES)
  const trimmed: CodegenCache = {}
  for (const { keyId } of kept) {
    trimmed[keyId] = next[keyId]
  }
  return trimmed
}

// Marks a project as used and keeps the 10 most recently used projects; returns the evicted ones.
export function touchCodegenIndex(index: readonly CodegenIndexEntry[], projectId: string, now: number): { index: CodegenIndexEntry[]; evicted: string[] } {
  const ordered = index
    .filter((entry) => entry.projectId !== projectId)
    .concat([{ projectId, usedAt: now }])
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => b.entry.usedAt - a.entry.usedAt || b.order - a.order)
    .map(({ entry }) => entry)
  return {
    index: ordered.slice(0, CODEGEN_CACHE_MAX_PROJECTS),
    evicted: ordered.slice(CODEGEN_CACHE_MAX_PROJECTS).map((entry) => entry.projectId),
  }
}

// Read-modify-write operations run one after another so concurrent messages cannot lose updates.
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function deleteCodegenCaches(): Promise<void> {
  const keys = await figma.clientStorage.keysAsync()
  for (const key of keys) {
    if (key.startsWith(STORAGE_KEYS.codegenPrefix)) {
      await figma.clientStorage.deleteAsync(key)
    }
  }
}

export async function loadAuth(apiBase: string): Promise<StoredAuth | null> {
  const map = parseAuthMap(await figma.clientStorage.getAsync(STORAGE_KEYS.auth))
  return map[apiBase] ?? null
}

// Auth has priority over the codegen cache: when storage is full, the caches are dropped and the write retried.
export function saveAuth(auth: StoredAuth): Promise<void> {
  const valid = parseStoredAuth(auth)
  if (valid === null) {
    return Promise.reject(new Error("Invalid sign-in data"))
  }
  return serialized(async () => {
    const map = parseAuthMap(await figma.clientStorage.getAsync(STORAGE_KEYS.auth))
    map[valid.apiBase] = valid
    try {
      await figma.clientStorage.setAsync(STORAGE_KEYS.auth, map)
    } catch {
      await deleteCodegenCaches()
      await figma.clientStorage.setAsync(STORAGE_KEYS.auth, map)
    }
  })
}

export function clearAuth(apiBase: string): Promise<void> {
  return serialized(async () => {
    const map = parseAuthMap(await figma.clientStorage.getAsync(STORAGE_KEYS.auth))
    delete map[apiBase]
    if (Object.keys(map).length === 0) {
      await figma.clientStorage.deleteAsync(STORAGE_KEYS.auth)
    } else {
      await figma.clientStorage.setAsync(STORAGE_KEYS.auth, map)
    }
  })
}

export async function loadPrefs(): Promise<Record<string, unknown>> {
  return parsePrefs(await figma.clientStorage.getAsync(STORAGE_KEYS.prefs))
}

// Shallow merge: the UI sends the fields it changed.
export function savePrefs(prefs: Record<string, unknown>): Promise<void> {
  return serialized(async () => {
    const current = parsePrefs(await figma.clientStorage.getAsync(STORAGE_KEYS.prefs))
    await figma.clientStorage.setAsync(STORAGE_KEYS.prefs, { ...current, ...parsePrefs(prefs) })
  })
}

export async function readCodegenCache(projectId: string): Promise<CodegenCache> {
  if (!OBJECT_ID_PATTERN.test(projectId)) {
    return {}
  }
  return parseCodegenCache(await figma.clientStorage.getAsync(codegenCacheKey(projectId)))
}

// Failures (storage full, invalid input) are swallowed: the cache is an optimisation only (§7.19).
export async function saveCodegenCache(projectId: string, entries: readonly CodegenCacheEntry[], now: number): Promise<boolean> {
  if (!OBJECT_ID_PATTERN.test(projectId) || !Array.isArray(entries)) {
    return false
  }
  try {
    await serialized(async () => {
      const cache = parseCodegenCache(await figma.clientStorage.getAsync(codegenCacheKey(projectId)))
      const merged = mergeCodegenCache(cache, entries, now)
      const index = parseCodegenIndex(await figma.clientStorage.getAsync(STORAGE_KEYS.codegenIndex))
      const touched = touchCodegenIndex(index, projectId, now)
      for (const evicted of touched.evicted) {
        await figma.clientStorage.deleteAsync(codegenCacheKey(evicted))
      }
      await figma.clientStorage.setAsync(codegenCacheKey(projectId), merged)
      await figma.clientStorage.setAsync(STORAGE_KEYS.codegenIndex, touched.index)
    })
    return true
  } catch {
    return false
  }
}
