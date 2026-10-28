import type { FigmaKeyRef, FigmaResolvedKey, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import { BY_NAME_TEXT_MAX_UTF16, CODEGEN_SOURCE_TEXT_MAX_CHARS, MAX_BATCH_SIZE, MAX_REQUESTS_IN_FLIGHT, RESOLVE_CHUNK_SIZE } from "../../shared/constants"
import { renderContent } from "../../shared/icu"
import type { CodegenCacheEntry, ScannedNode } from "../../shared/messages"
import type { RemoteWithMaxLength } from "../../shared/push-plan"
import { missingRemoteState, remoteStateFromResolved } from "../../shared/sync-state"
import { trimSpace, truncateUtf16, utf16Length } from "../../shared/text"
import type { FigmaApi } from "../api/figma-api"
import { chunk } from "./ops"

// Remote key state for sync (§7.10): E12 with source draft and the main language, chunks of 100, ≤ 4 in flight.

export interface RemoteLoad {
  remote: Map<string, RemoteWithMaxLength>
  resolved: Map<string, FigmaResolvedKey>
  error: unknown
}

// Runs `task` over items with at most `limit` running at once; results keep the input order.
export async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Keys whose remote state the sync needs: links of this project, whatever the link state (copied and inherited
// links still name a key). Invalid links and other projects are excluded.
export function linkedKeyIds(nodes: readonly ScannedNode[], projectId: string): string[] {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.link !== null && node.link.p === projectId && node.linkState !== "invalid") {
      ids.add(node.link.id)
    }
  }
  return [...ids]
}

export async function resolveInChunks(
  api: Pick<FigmaApi, "resolveKeys">,
  projectId: string,
  keyIds: readonly string[],
  request: Omit<FigmaResolveRequest, "key_ids">,
): Promise<{ responses: FigmaResolveResponse[]; error: unknown }> {
  const responses: FigmaResolveResponse[] = []
  let error: unknown = null
  await mapPool(chunk(keyIds, RESOLVE_CHUNK_SIZE), MAX_REQUESTS_IN_FLIGHT, async (ids) => {
    try {
      responses.push(await api.resolveKeys(projectId, { ...request, key_ids: ids }))
    } catch (caught) {
      error = error ?? caught
    }
  })
  return { responses, error }
}

export async function loadRemoteStates(
  api: Pick<FigmaApi, "resolveKeys">,
  projectId: string,
  mainLanguage: string,
  keyIds: readonly string[],
): Promise<RemoteLoad> {
  const remote = new Map<string, RemoteWithMaxLength>()
  const resolved = new Map<string, FigmaResolvedKey>()
  if (keyIds.length === 0 || mainLanguage === "") {
    return { remote, resolved, error: null }
  }
  const { responses, error } = await resolveInChunks(api, projectId, keyIds, { languages: [mainLanguage], source: "draft", variation_option_id: null })
  for (const response of responses) {
    for (const key of response.keys) {
      resolved.set(key.id, key)
      remote.set(key.id, {
        ...remoteStateFromResolved(key, mainLanguage),
        maxLength: key.max_length,
        placeholders: key.placeholders.map((placeholder) => placeholder.name),
      })
    }
    for (const id of response.missing_key_ids) {
      remote.set(id, { ...missingRemoteState(), maxLength: null })
    }
  }
  return { remote, resolved, error }
}

// E11 text lookup (D40) for normalised texts, chunks of 100; texts above 5000 UTF-16 units are skipped.
export async function fetchTextMatches(api: Pick<FigmaApi, "keysByName">, projectId: string, texts: readonly string[]): Promise<Map<string, FigmaKeyRef[]>> {
  const unique = [...new Set(texts)].filter((text) => text !== "" && utf16Length(text) <= BY_NAME_TEXT_MAX_UTF16)
  const matches = new Map<string, FigmaKeyRef[]>()
  await mapPool(chunk(unique, MAX_BATCH_SIZE), MAX_REQUESTS_IN_FLIGHT, async (batch) => {
    const response = await api.keysByName(projectId, { texts: batch })
    for (const match of response.text_matches) {
      matches.set(match.text, match.keys.slice())
    }
  })
  return matches
}

export interface TakenName { id: string; key: string; type: "key" | "object" | "array" }

// E11 name lookup, chunks of 100: names that already exist in the project. A name the server would reject (empty
// after strings.TrimSpace, so also one of only U+0085) is left out, as it would fail its whole batch with a 400.
export async function fetchTakenNames(api: Pick<FigmaApi, "keysByName">, projectId: string, names: readonly string[]): Promise<Map<string, TakenName>> {
  const unique = [...new Set(names.map((name) => name.trim()))].filter((name) => trimSpace(name) !== "" && name.length <= 200)
  const taken = new Map<string, TakenName>()
  await mapPool(chunk(unique, MAX_BATCH_SIZE), MAX_REQUESTS_IN_FLIGHT, async (batch) => {
    const response = await api.keysByName(projectId, { names: batch })
    for (const key of response.keys) {
      taken.set(key.key, { id: key.id, key: key.key, type: key.type })
    }
  })
  return taken
}

// Codegen cache entries (§7.17, §7.19) from resolved keys, so renames in ReRune reach Dev Mode codegen.
export function cacheEntriesFromResolved(resolved: ReadonlyMap<string, FigmaResolvedKey>, mainLanguage: string): CodegenCacheEntry[] {
  const entries: CodegenCacheEntry[] = []
  for (const key of resolved.values()) {
    if (key.type !== "key") {
      continue
    }
    const main = key.values.find((value) => value.lang === mainLanguage)
    const content = main !== undefined && main.present ? main.content : null
    const structured = content !== null && content.message !== undefined && content.message !== null
    const text = content === null ? "" : structured ? renderContent(content, { lang: mainLanguage }) : content.value
    entries.push({ keyId: key.id, k: key.key, placeholders: key.placeholders.map((placeholder) => placeholder.name), sourceText: truncateUtf16(text, CODEGEN_SOURCE_TEXT_MAX_CHARS) })
  }
  return entries
}
