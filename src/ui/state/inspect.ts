import { DEFAULT_PLATFORM, isCodegenPlatform, snippetText, type CodegenPlatform } from "../../codegen/snippets"
import type { FigmaLanguage, FigmaProjectDetail, FigmaResolvedKey, FigmaResolvedValue, FigmaResolveSource } from "../../shared/api-types"
import { MAX_REQUESTS_IN_FLIGHT, RESOLVE_CHUNK_SIZE } from "../../shared/constants"
import { renderContent } from "../../shared/icu"
import type { CodegenCacheEntry, FileSettings, LinkState, MainToUiOf, StoredAuth } from "../../shared/messages"
import { ApiError, userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { chunk } from "./ops"
import { cacheEntriesFromResolved, mapPool } from "./remote"
import type { Prefs } from "./settings"
import { createStore, type Store } from "./store"

// Dev Mode inspect panel (§7.17, P2.4): sign-in, the file's project, and per linked key its status, max length,
// values in every project language (Draft/Published), inherited/missing markers, the snippet for the chosen
// platform and "Open in ReRune". Read-only: the panel only sends ui/read messages (cache-save, prefs-save,
// open-external, auth-save, auth-clear, notify, inspect-request, diagnostics-read). Pure, so node tests cover it.

export type InspectSelection = MainToUiOf<"inspect-selection">

export const INSPECT_DESCRIPTION = "See the ReRune keys of the selected layers, their values in every language and code snippets."
export const NOT_CONNECTED_MESSAGE = "This file isn't connected to ReRune yet. A designer connects it from Figma Design."
export const OTHER_SERVER_MESSAGE = "This file is connected to a different ReRune server. A designer connects it to this server from Figma Design."
export const OTHER_PROJECT_NOTE = "Linked to a key of another ReRune project."
export const MISSING_KEY_NOTE = "This key no longer exists in ReRune."
export const NOT_TEXT_KEY_NOTE = "This key is a group, not a text key."
export const NOT_PUBLISHED_NOTE = "This key isn't published yet."
export const NO_LANGUAGES_NOTE = "This project has no languages yet."

// ---- Access and navigation

export type InspectAccess = "sign-in" | "not-connected" | "other-server" | "ready"

// Sign-in comes first (§7.17); a file without settings, or with another server's settings (§7.7), has no project.
export function inspectAccess(auth: StoredAuth | null, settings: FileSettings | null, apiBase: string): InspectAccess {
  if (auth === null) {
    return "sign-in"
  }
  if (settings === null) {
    return "not-connected"
  }
  return settings.apiBase === apiBase ? "ready" : "other-server"
}

export type InspectScreenName = "home" | "pairing" | "signed-in" | "diagnostics"

export interface InspectView {
  screen: InspectScreenName
  notice: string | null          // shown on the Sign in screen ("Your session ended. Sign in again.")
  signedIn: StoredAuth | null    // the fresh sign-in shown on "Signed in as" (D34), once per sign-in
}

export type InspectNavEvent =
  | { type: "start-sign-in" }
  | { type: "pairing-approved"; auth: StoredAuth }
  | { type: "pairing-cancelled" }
  | { type: "continue" }
  | { type: "not-me" }
  | { type: "signed-out"; notice: string | null }
  | { type: "open-diagnostics" }
  | { type: "close-diagnostics" }

export const INITIAL_INSPECT_VIEW: InspectView = { screen: "home", notice: null, signedIn: null }

export function inspectNavigate(view: InspectView, event: InspectNavEvent): InspectView {
  switch (event.type) {
    case "start-sign-in":
      return { screen: "pairing", notice: null, signedIn: null }
    case "pairing-approved":
      return { screen: "signed-in", notice: null, signedIn: event.auth }
    case "pairing-cancelled":
    case "continue":
    case "not-me":
      return INITIAL_INSPECT_VIEW
    case "signed-out":
      return { screen: "home", notice: event.notice, signedIn: null }
    case "open-diagnostics":
      // "Signed in as" must be answered first (D34).
      return view.screen === "signed-in" ? view : { ...view, screen: "diagnostics" }
    case "close-diagnostics":
      return view.screen === "diagnostics" ? { ...view, screen: "home" } : view
  }
}

// The file's project (E9) loads only once the panel shows keys: never while "Signed in as" waits (D34).
export function shouldLoadProject(access: InspectAccess, view: InspectView): boolean {
  return access === "ready" && view.screen !== "signed-in" && view.screen !== "pairing"
}

export function inspectPlatformOf(prefs: Pick<Prefs, "inspectPlatform">): CodegenPlatform {
  return isCodegenPlatform(prefs.inspectPlatform) ? prefs.inspectPlatform : DEFAULT_PLATFORM
}

// ---- Selection → keys

export interface InspectKey { keyId: string; keyName: string; projectId: string; layerText: string; layers: number; state: LinkState }
export type InspectModel =
  | { kind: "empty"; keys: [] }
  | { kind: "unlinked"; keys: [] }
  | { kind: "keys"; keys: InspectKey[] }

const LINKED: readonly LinkState[] = ["ok", "inherited", "copied"]
const TEXT_PREVIEW_CHARS = 80

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TEXT_PREVIEW_CHARS ? flat.slice(0, TEXT_PREVIEW_CHARS - 1) + "…" : flat
}

// One entry per linked key (in layer order); inherited_overridden and invalid links show no key.
export function inspectModel(selection: InspectSelection | null): InspectModel {
  if (selection === null || selection.kind === "none") {
    return { kind: "empty", keys: [] }
  }
  const keys = new Map<string, InspectKey>()
  for (const node of selection.nodes) {
    if (node.link === null || !LINKED.includes(node.linkState)) {
      continue
    }
    const known = keys.get(node.link.id)
    if (known !== undefined) {
      known.layers++
      continue
    }
    keys.set(node.link.id, {
      keyId: node.link.id,
      keyName: node.link.k,
      projectId: node.link.p,
      layerText: preview(node.originalCharacters ?? node.characters),
      layers: 1,
      state: node.linkState,
    })
  }
  if (keys.size === 0) {
    return selection.kind === "text" ? { kind: "unlinked", keys: [] } : { kind: "empty", keys: [] }
  }
  return { kind: "keys", keys: [...keys.values()] }
}

// Keys E12 can resolve: links of the file's project (key IDs are project-scoped).
export function projectKeyIds(model: InspectModel, projectId: string): string[] {
  return model.keys.filter((key) => key.projectId === projectId).map((key) => key.keyId)
}

// ---- Values (E12 for every project language)

// The main (source) language first, then the project's order.
export function inspectLanguages(project: Pick<FigmaProjectDetail, "languages">): FigmaLanguage[] {
  return project.languages.filter((language) => language.main).concat(project.languages.filter((language) => !language.main))
}

export interface InspectResolved { keys: Map<string, FigmaResolvedKey>; missing: Set<string>; error: unknown }

// E12 takes 1–100 keys and 1–100 languages: keys and languages go in chunks of 100 (≤ 4 requests in flight) and
// each key's values are put back in `languages` order. A key some chunk failed for is left out (with the error).
export async function resolveForInspect(
  api: Pick<FigmaApi, "resolveKeys">,
  projectId: string,
  keyIds: readonly string[],
  languages: readonly string[],
  source: FigmaResolveSource,
): Promise<InspectResolved> {
  const result: InspectResolved = { keys: new Map(), missing: new Set(), error: null }
  const ids = [...new Set(keyIds)]
  if (ids.length === 0 || languages.length === 0) {
    return result
  }
  const languageChunks = chunk(languages, RESOLVE_CHUNK_SIZE)
  const jobs = chunk(ids, RESOLVE_CHUNK_SIZE).flatMap((keys) => languageChunks.map((langs) => ({ keys, langs })))
  const found = new Map<string, { key: FigmaResolvedKey; values: Map<string, FigmaResolvedValue>; chunks: number }>()
  const missing = new Map<string, number>()
  await mapPool(jobs, MAX_REQUESTS_IN_FLIGHT, async (job) => {
    try {
      const response = await api.resolveKeys(projectId, { key_ids: job.keys, languages: job.langs, source, variation_option_id: null })
      for (const key of response.keys) {
        const entry = found.get(key.id) ?? { key, values: new Map<string, FigmaResolvedValue>(), chunks: 0 }
        for (const value of key.values) {
          entry.values.set(value.lang, value)
        }
        entry.chunks++
        found.set(key.id, entry)
      }
      for (const id of response.missing_key_ids) {
        missing.set(id, (missing.get(id) ?? 0) + 1)
      }
    } catch (caught) {
      result.error = result.error ?? caught
    }
  })
  for (const id of ids) {
    const entry = found.get(id)
    if (entry !== undefined && entry.chunks === languageChunks.length) {
      const values = languages.map((lang) => entry.values.get(lang)).filter((value): value is FigmaResolvedValue => value !== undefined)
      result.keys.set(id, { ...entry.key, values: entry.key.type === "key" ? values : [] })
    } else if (entry === undefined && missing.get(id) === languageChunks.length) {
      result.missing.add(id)
    }
  }
  return result
}

// Codegen cache entries after a resolve (§7.17). Published values are cached too (names and placeholders of what
// ships), except keys without a published main value: they keep their cached draft entry.
export function inspectCacheEntries(keys: ReadonlyMap<string, FigmaResolvedKey>, mainLanguage: string, source: FigmaResolveSource): CodegenCacheEntry[] {
  const entries = cacheEntriesFromResolved(keys, mainLanguage)
  if (source === "draft") {
    return entries
  }
  return entries.filter((entry) => keys.get(entry.keyId)?.values.some((value) => value.lang === mainLanguage && value.present) === true)
}

// ---- Views

export type ChipTone = "neutral" | "good" | "info" | "warning" | "danger"
export interface InspectChip { label: string; tone: ChipTone; title?: string }

export type InspectValueState = "present" | "inherited" | "missing"
export interface InspectValueView {
  lang: string
  name: string
  main: boolean
  state: InspectValueState
  text: string
  structured: boolean
  resolvedLang: string
  length: number
  tooLong: boolean
}

export interface InspectKeyView {
  keyId: string
  keyName: string
  projectId: string
  layerText: string
  chips: InspectChip[]
  note: string | null
  loading: boolean
  values: InspectValueView[]
  snippet: string
  openUrl: string
}

export interface KeyViewContext {
  projectId: string
  languages: readonly FigmaLanguage[]
  source: FigmaResolveSource
  platform: CodegenPlatform
  dashboardBase: string
  resolved: FigmaResolvedKey | undefined
  missing: boolean
  loading: boolean
}

// "Open in ReRune" (§7.17, D27): the translations page selects the key from ?key=.
export function dashboardKeyUrl(dashboardBase: string, projectId: string, keyId: string): string {
  return dashboardBase.replace(/\/+$/, "") + "/translator/translations/" + encodeURIComponent(projectId) + "?key=" + encodeURIComponent(keyId)
}

const STATUS_CHIPS: Record<FigmaResolvedKey["status"], InspectChip> = {
  published: { label: "Published", tone: "good" },
  modified: { label: "Modified", tone: "info", title: "Changed since it was last published" },
  unpublished: { label: "Not published", tone: "neutral" },
}

function layerChips(key: InspectKey): InspectChip[] {
  const chips: InspectChip[] = []
  if (key.layers > 1) {
    chips.push({ label: key.layers + " layers", tone: "neutral" })
  }
  if (key.state === "inherited") {
    chips.push({ label: "From main component", tone: "neutral", title: "The layer shows its main component's key" })
  } else if (key.state === "copied") {
    chips.push({ label: "Copied layer", tone: "warning", title: "A designer copied this layer; its link may be confirmed or replaced in Figma Design" })
  }
  return chips
}

// Values for every project language, in the panel's language order; a language the answer lacks reads as missing.
export function valueViews(key: FigmaResolvedKey, languages: readonly FigmaLanguage[]): InspectValueView[] {
  if (key.type !== "key") {
    return []
  }
  return languages.map((language): InspectValueView => {
    const value = key.values.find((entry) => entry.lang === language.code)
    const base = { lang: language.code, name: language.name, main: language.main }
    if (value === undefined || !value.present || value.content === null) {
      return { ...base, state: "missing", text: "", structured: false, resolvedLang: "", length: 0, tooLong: false }
    }
    const structured = value.content.message !== undefined && value.content.message !== null
    return {
      ...base,
      state: value.inherited ? "inherited" : "present",
      // Plain values keep their {{placeholders}}; plural/ICU messages are rendered with their "other" forms.
      text: structured ? renderContent(value.content, { lang: language.code }) : value.content.value,
      structured,
      resolvedLang: value.resolved_lang,
      length: value.length,
      tooLong: value.exceeds_max_length,
    }
  })
}

export function keyView(key: InspectKey, context: KeyViewContext): InspectKeyView {
  const view: InspectKeyView = {
    keyId: key.keyId,
    keyName: key.keyName,
    projectId: key.projectId,
    layerText: key.layerText,
    chips: [],
    note: null,
    loading: false,
    values: [],
    snippet: snippetText(context.platform, { name: key.keyName, placeholders: [] }),
    openUrl: dashboardKeyUrl(context.dashboardBase, key.projectId, key.keyId),
  }
  if (key.projectId !== context.projectId) {
    return { ...view, chips: layerChips(key), note: OTHER_PROJECT_NOTE }
  }
  const resolved = context.resolved
  if (resolved === undefined) {
    return context.missing ? { ...view, chips: layerChips(key), note: MISSING_KEY_NOTE } : { ...view, chips: layerChips(key), loading: context.loading }
  }
  const chips: InspectChip[] = [STATUS_CHIPS[resolved.status] ?? { label: resolved.status, tone: "neutral" }]
  if (!resolved.enabled) {
    chips.push({ label: "Disabled", tone: "warning" })
  }
  if (resolved.max_length !== null) {
    chips.push({ label: "Max " + resolved.max_length, tone: "neutral", title: "Max length: " + resolved.max_length + " characters" })
  }
  let note: string | null = null
  if (resolved.type !== "key") {
    note = NOT_TEXT_KEY_NOTE
  } else if (context.source === "published" && !resolved.published) {
    note = NOT_PUBLISHED_NOTE
  }
  return {
    ...view,
    keyName: resolved.key,
    chips: chips.concat(layerChips(key)),
    note,
    values: note === null ? valueViews(resolved, context.languages) : [],
    snippet: snippetText(context.platform, { name: resolved.key, placeholders: resolved.placeholders.map((placeholder) => placeholder.name) }),
  }
}

export function valueMarker(value: InspectValueView): string | null {
  if (value.state === "missing") {
    return "Missing"
  }
  return value.state === "inherited" ? "Inherited from " + value.resolvedLang : null
}

// ---- Loader (E12 per selection and source; cache-save after each resolve)

export type InspectLoadStatus = "idle" | "loading" | "ready" | "error"

export interface InspectValuesState {
  projectId: string | null
  source: FigmaResolveSource
  status: InspectLoadStatus
  error: string | null
  errorReason: string | null
  draft: ReadonlyMap<string, FigmaResolvedKey>
  published: ReadonlyMap<string, FigmaResolvedKey>
  missing: ReadonlySet<string>
}

export interface InspectLoaderDeps {
  api: Pick<FigmaApi, "resolveKeys">
  saveCache(projectId: string, entries: CodegenCacheEntry[]): void
}

export interface InspectLoader {
  store: Store<InspectValuesState>
  load(project: Pick<FigmaProjectDetail, "id" | "languages" | "main_language">, keyIds: readonly string[], source: FigmaResolveSource): Promise<void>
  reset(): void
}

export function emptyInspectValues(): InspectValuesState {
  return { projectId: null, source: "draft", status: "idle", error: null, errorReason: null, draft: new Map(), published: new Map(), missing: new Set() }
}

export function resolvedFor(state: InspectValuesState, source: FigmaResolveSource): ReadonlyMap<string, FigmaResolvedKey> {
  return source === "draft" ? state.draft : state.published
}

// Every selection or source change resolves the selection's keys again (fresh values); a newer load supersedes a
// running one, whose answer is then only used for the codegen cache.
export function createInspectLoader(deps: InspectLoaderDeps): InspectLoader {
  const store = createStore<InspectValuesState>(emptyInspectValues())
  let generation = 0
  return {
    store,
    async load(project, keyIds, source) {
      const mine = ++generation
      const sameProject = store.get().projectId === project.id
      const languages = inspectLanguages(project).map((language) => language.code)
      const nothing = keyIds.length === 0 || languages.length === 0
      store.set((state) => ({
        ...(sameProject ? state : emptyInspectValues()),
        projectId: project.id,
        source,
        status: nothing ? "ready" : "loading",
        error: null,
        errorReason: null,
      }))
      if (nothing) {
        return
      }
      const result = await resolveForInspect(deps.api, project.id, keyIds, languages, source)
      const entries = inspectCacheEntries(result.keys, project.main_language, source)
      if (entries.length > 0) {
        deps.saveCache(project.id, entries)
      }
      if (mine !== generation) {
        return
      }
      store.set((state) => {
        const values = new Map(resolvedFor(state, source))
        const missing = new Set(state.missing)
        for (const [id, key] of result.keys) {
          values.set(id, key)
          missing.delete(id)
        }
        for (const id of result.missing) {
          values.delete(id)
          missing.add(id)
        }
        const failed = result.error !== null
        return {
          ...state,
          draft: source === "draft" ? values : state.draft,
          published: source === "published" ? values : state.published,
          missing,
          status: failed ? "error" : "ready",
          error: failed ? userMessage(result.error) : null,
          errorReason: failed && result.error instanceof ApiError ? result.error.reason : null,
        }
      })
    },
    reset() {
      generation++
      store.set(emptyInspectValues())
    },
  }
}
