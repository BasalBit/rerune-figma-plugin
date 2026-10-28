import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaLanguage, FigmaProjectDetail, FigmaResolvedKey, FigmaResolvedValue, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import type { FileSettings, StoredAuth } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { ApiError } from "../api/client"
import {
  createInspectLoader,
  dashboardKeyUrl,
  INITIAL_INSPECT_VIEW,
  inspectAccess,
  inspectCacheEntries,
  inspectLanguages,
  inspectModel,
  inspectNavigate,
  inspectPlatformOf,
  keyView,
  MISSING_KEY_NOTE,
  NOT_PUBLISHED_NOTE,
  NOT_TEXT_KEY_NOTE,
  OTHER_PROJECT_NOTE,
  projectKeyIds,
  resolvedFor,
  resolveForInspect,
  shouldLoadProject,
  valueMarker,
  valueViews,
  type InspectKey,
  type KeyViewContext,
} from "./inspect"
import { DEFAULT_PREFS } from "./settings"

const API_BASE = "http://localhost:8080"
const DASHBOARD = "http://localhost:3000"

const AUTH: StoredAuth = {
  apiBase: API_BASE,
  token: "rrf_" + "a".repeat(64),
  tokenId: "t1",
  tokenExpiresAt: "",
  user: { id: "u1", email: "dev@example.com", firstName: "Dev", lastName: "" },
  savedAt: 1,
}

function language(code: string, extra: Partial<FigmaLanguage> = {}): FigmaLanguage {
  return { code, name: code.toUpperCase(), main: false, rtl_writing: false, inherits_from: [], ...extra }
}

const LANGUAGES = [language("de"), language("en", { name: "English", main: true }), language("de-AT", { inherits_from: ["de"] }), language("fr")]

const PROJECT: FigmaProjectDetail = {
  id: PROJECT_ID,
  name: "Chapter",
  organisation: { id: "6a4000000000000000000b11", name: "Org" },
  main_language: "en",
  languages: LANGUAGES,
  variation_options: [],
  permissions: [],
  key_count: 3,
  available_keys: null,
  key_name_sample: [],
}

function value(lang: string, text: string | null, extra: Partial<FigmaResolvedValue> = {}): FigmaResolvedValue {
  if (text === null) {
    return { lang, present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false, ...extra }
  }
  return { lang, present: true, resolved_lang: lang, inherited: false, variation_applied: false, content: { value: text }, length: text.length, exceeds_max_length: false, ...extra }
}

function key(id: string, name: string, values: FigmaResolvedValue[], extra: Partial<FigmaResolvedKey> = {}): FigmaResolvedKey {
  return { id, key: name, type: "key", enabled: true, status: "published", published: true, description: "", tags: [], max_length: null, placeholders: [], values, ...extra }
}

// A fake E12 that answers the requested languages from `table` (all languages of a key, in table order).
function resolver(table: Map<string, FigmaResolvedKey>, fail?: (request: FigmaResolveRequest) => unknown) {
  return vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => {
    const error = fail?.(request)
    if (error !== undefined) {
      throw error
    }
    return {
      source: request.source,
      variation_option: null,
      keys: request.key_ids
        .filter((id) => table.has(id))
        .map((id) => {
          const entry = table.get(id) as FigmaResolvedKey
          return { ...entry, values: entry.values.filter((entryValue) => request.languages.includes(entryValue.lang)) }
        }),
      missing_key_ids: request.key_ids.filter((id) => !table.has(id)),
    }
  })
}

const PAY = key(keyId(1), "checkout_pay_button", [
  value("en", "Pay {{amount}}"),
  value("de", "Jetzt {{amount}} zahlen"),
  value("de-AT", "Jetzt {{amount}} zahlen", { resolved_lang: "de", inherited: true }),
  value("fr", null),
], { status: "modified", max_length: 20, placeholders: [{ name: "amount", type: "string", format: "" }] })

describe("access and navigation", () => {
  const settings: FileSettings = newFileSettings({ apiBase: API_BASE, projectId: PROJECT_ID, projectName: "Chapter", now: 1 })

  it("asks to sign in first, then needs this server's file settings", () => {
    expect(inspectAccess(null, settings, API_BASE)).toBe("sign-in")
    expect(inspectAccess(null, null, API_BASE)).toBe("sign-in")
    expect(inspectAccess(AUTH, null, API_BASE)).toBe("not-connected")
    expect(inspectAccess(AUTH, { ...settings, apiBase: "https://rerune.io/api" }, API_BASE)).toBe("other-server")
    expect(inspectAccess(AUTH, settings, API_BASE)).toBe("ready")
  })

  it("goes sign-in → pairing → Signed in as → keys, and back on cancel, Not me and sign-out", () => {
    let view = inspectNavigate(INITIAL_INSPECT_VIEW, { type: "start-sign-in" })
    expect(view.screen).toBe("pairing")
    expect(inspectNavigate(view, { type: "pairing-cancelled" })).toEqual(INITIAL_INSPECT_VIEW)
    view = inspectNavigate(view, { type: "pairing-approved", auth: AUTH })
    expect(view).toEqual({ screen: "signed-in", notice: null, signedIn: AUTH })
    expect(inspectNavigate(view, { type: "continue" })).toEqual(INITIAL_INSPECT_VIEW)
    expect(inspectNavigate(view, { type: "not-me" })).toEqual(INITIAL_INSPECT_VIEW)
    expect(inspectNavigate(INITIAL_INSPECT_VIEW, { type: "signed-out", notice: "Your session ended. Sign in again." })).toEqual({
      screen: "home",
      notice: "Your session ended. Sign in again.",
      signedIn: null,
    })
  })

  it("opens Diagnostics from home but never past Signed in as", () => {
    const diagnostics = inspectNavigate(INITIAL_INSPECT_VIEW, { type: "open-diagnostics" })
    expect(diagnostics.screen).toBe("diagnostics")
    expect(inspectNavigate(diagnostics, { type: "close-diagnostics" }).screen).toBe("home")
    const confirming = inspectNavigate(INITIAL_INSPECT_VIEW, { type: "pairing-approved", auth: AUTH })
    expect(inspectNavigate(confirming, { type: "open-diagnostics" })).toBe(confirming)
    expect(inspectNavigate(confirming, { type: "close-diagnostics" })).toBe(confirming)
  })

  it("loads the project only when ready and not while Signed in as waits (D34)", () => {
    expect(shouldLoadProject("ready", INITIAL_INSPECT_VIEW)).toBe(true)
    expect(shouldLoadProject("ready", { screen: "diagnostics", notice: null, signedIn: null })).toBe(true)
    expect(shouldLoadProject("ready", { screen: "signed-in", notice: null, signedIn: AUTH })).toBe(false)
    expect(shouldLoadProject("ready", { screen: "pairing", notice: null, signedIn: null })).toBe(false)
    expect(shouldLoadProject("not-connected", INITIAL_INSPECT_VIEW)).toBe(false)
    expect(shouldLoadProject("sign-in", INITIAL_INSPECT_VIEW)).toBe(false)
  })

  it("remembers the platform in prefs and defaults to React (i18next)", () => {
    expect(inspectPlatformOf(DEFAULT_PREFS)).toBe("react-i18next")
    expect(inspectPlatformOf({ inspectPlatform: "ios" })).toBe("ios")
    expect(inspectPlatformOf({ inspectPlatform: "cobol" })).toBe("react-i18next")
  })
})

describe("inspectModel", () => {
  it("is empty without a selection", () => {
    expect(inspectModel(null)).toEqual({ kind: "empty", keys: [] })
    expect(inspectModel({ type: "inspect-selection", kind: "none", nodes: [], truncated: false })).toEqual({ kind: "empty", keys: [] })
  })

  it("says when the selected text has no key", () => {
    expect(inspectModel({ type: "inspect-selection", kind: "text", nodes: [scannedNode("1:1", "Plain")], truncated: false })).toEqual({ kind: "unlinked", keys: [] })
  })

  it("lists one row per key with the layer count and project", () => {
    const nodes = [
      linkedNode("1:1", "Pay   now", { keyId: keyId(1), keyName: "checkout_pay_button", syncedText: "Pay now" }),
      linkedNode("I2:1;1:1", "Pay now", { keyId: keyId(1), keyName: "checkout_pay_button", syncedText: "Pay now", nid: "1:1", state: "inherited" }),
      linkedNode("1:3", "Cancel", { keyId: keyId(2), keyName: "checkout_cancel", syncedText: "Cancel", nid: "1:9", state: "copied" }),
      linkedNode("1:4", "Own text", { keyId: keyId(3), keyName: "overridden", syncedText: "x", nid: "1:8", state: "inherited_overridden" }),
      linkedNode("1:6", "Other", { keyId: keyId(4), keyName: "other", syncedText: "Other", projectId: OTHER_PROJECT_ID }),
      scannedNode("1:5", "Unlinked"),
    ]
    const model = inspectModel({ type: "inspect-selection", kind: "container", nodes, truncated: false })
    expect(model).toEqual({
      kind: "keys",
      truncated: false,
      keys: [
        { keyId: keyId(1), keyName: "checkout_pay_button", projectId: PROJECT_ID, layerText: "Pay now", layers: 2, state: "ok" },
        { keyId: keyId(2), keyName: "checkout_cancel", projectId: PROJECT_ID, layerText: "Cancel", layers: 1, state: "copied" },
        { keyId: keyId(4), keyName: "other", projectId: OTHER_PROJECT_ID, layerText: "Other", layers: 1, state: "ok" },
      ],
    })
    expect(projectKeyIds(model, PROJECT_ID)).toEqual([keyId(1), keyId(2)])
  })

  it("passes on that main left linked layers out (more than 50)", () => {
    const nodes = [linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now" })]
    expect(inspectModel({ type: "inspect-selection", kind: "container", nodes, truncated: true })).toMatchObject({ kind: "keys", truncated: true })
  })

  it("shows the original text of a previewing layer and shortens long text", () => {
    const previewing = linkedNode("1:1", "Jetzt zahlen", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now" }, { originalCharacters: "Pay now" })
    const long = linkedNode("1:2", "x".repeat(200), { keyId: keyId(2), keyName: "long", syncedText: "x" })
    const keys = inspectModel({ type: "inspect-selection", kind: "container", nodes: [previewing, long], truncated: false }).keys
    expect(keys[0].layerText).toBe("Pay now")
    expect(keys[1].layerText).toHaveLength(80)
    expect(keys[1].layerText.endsWith("…")).toBe(true)
  })
})

describe("inspectLanguages", () => {
  it("puts the main language first and keeps the project's order", () => {
    expect(inspectLanguages(PROJECT).map((entry) => entry.code)).toEqual(["en", "de", "de-AT", "fr"])
    expect(inspectLanguages({ languages: [] })).toEqual([])
  })
})

describe("resolveForInspect", () => {
  it("asks E12 for every project language and keeps the language order", async () => {
    const resolve = resolver(new Map([[PAY.id, PAY]]))
    const result = await resolveForInspect({ resolveKeys: resolve }, PROJECT_ID, [PAY.id, keyId(9)], ["en", "de", "de-AT", "fr"], "published")
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][1]).toEqual({ key_ids: [PAY.id, keyId(9)], languages: ["en", "de", "de-AT", "fr"], source: "published", variation_option_id: null })
    expect(result.keys.get(PAY.id)?.values.map((entry) => entry.lang)).toEqual(["en", "de", "de-AT", "fr"])
    expect([...result.missing]).toEqual([keyId(9)])
    expect(result.error).toBeNull()
  })

  it("splits more than 100 languages and keys into chunks and merges each key's values", async () => {
    const languages = Array.from({ length: 150 }, (_, i) => "l" + i)
    const ids = Array.from({ length: 120 }, (_, i) => keyId(i))
    const table = new Map(ids.slice(0, 110).map((id) => [id, key(id, id, languages.map((lang) => value(lang, lang + ":" + id)))]))
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
    const result = await resolveForInspect(api, PROJECT_ID, ids, languages, "draft")
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(resolve.mock.calls.every(([, request]) => request.key_ids.length <= 100 && request.languages.length <= 100)).toBe(true)
    expect(peak).toBeLessThanOrEqual(4)
    expect(result.keys.size).toBe(110)
    expect(result.keys.get(ids[105])?.values.map((entry) => entry.lang)).toEqual(languages)
    expect(result.missing.size).toBe(10)
  })

  it("leaves out keys a failed chunk would show half-loaded and reports the error", async () => {
    const languages = Array.from({ length: 101 }, (_, i) => "l" + i)
    const table = new Map([[keyId(1), key(keyId(1), "a", languages.map((lang) => value(lang, lang)))]])
    const failure = new ApiError(0, "network", "offline")
    const resolve = resolver(table, (request) => (request.languages.length === 1 ? failure : undefined))
    const result = await resolveForInspect({ resolveKeys: resolve }, PROJECT_ID, [keyId(1)], languages, "draft")
    expect(result.keys.size).toBe(0)
    expect(result.missing.size).toBe(0)
    expect(result.error).toBe(failure)
  })

  it("sends nothing without keys or languages, and empties the values of a group key", async () => {
    const resolve = resolver(new Map([[keyId(2), key(keyId(2), "group", [value("en", "x")], { type: "object" })]]))
    expect((await resolveForInspect({ resolveKeys: resolve }, PROJECT_ID, [], ["en"], "draft")).keys.size).toBe(0)
    expect((await resolveForInspect({ resolveKeys: resolve }, PROJECT_ID, [keyId(2)], [], "draft")).keys.size).toBe(0)
    expect(resolve).not.toHaveBeenCalled()
    const result = await resolveForInspect({ resolveKeys: resolve }, PROJECT_ID, [keyId(2), keyId(2)], ["en"], "draft")
    expect(resolve.mock.calls[0][1].key_ids).toEqual([keyId(2)])
    expect(result.keys.get(keyId(2))?.values).toEqual([])
  })
})

describe("views", () => {
  const inspectKey: InspectKey = { keyId: PAY.id, keyName: "old_name", projectId: PROJECT_ID, layerText: "Pay 5 €", layers: 2, state: "inherited" }

  function context(extra: Partial<KeyViewContext> = {}): KeyViewContext {
    return {
      projectId: PROJECT_ID,
      languages: inspectLanguages(PROJECT),
      source: "draft",
      platform: "react-i18next",
      dashboardBase: DASHBOARD,
      resolved: PAY,
      missing: false,
      loading: false,
      ...extra,
    }
  }

  it("shows status, max length, every language with markers, the snippet and Open in ReRune", () => {
    const view = keyView(inspectKey, context())
    expect(view.keyName).toBe("checkout_pay_button")
    expect(view.chips.map((chip) => chip.label)).toEqual(["Modified", "Max 20", "2 layers", "From main component"])
    expect(view.note).toBeNull()
    expect(view.values.map((entry) => [entry.lang, entry.state, entry.text, valueMarker(entry)])).toEqual([
      ["en", "present", "Pay {{amount}}", null],
      ["de", "present", "Jetzt {{amount}} zahlen", null],
      ["de-AT", "inherited", "Jetzt {{amount}} zahlen", "Inherited from de"],
      ["fr", "missing", "", "Missing"],
    ])
    expect(view.values[0].main).toBe(true)
    expect(view.snippet).toBe("t('checkout_pay_button', { amount })")
    expect(view.openUrl).toBe("http://localhost:3000/translator/translations/" + PROJECT_ID + "?key=" + PAY.id)
  })

  it("builds the snippet for the chosen platform with the key's placeholders", () => {
    expect(keyView(inspectKey, context({ platform: "android" })).snippet).toBe("stringResource(R.string.checkout_pay_button, amount)")
    expect(keyView(inspectKey, context({ platform: "flutter", resolved: { ...PAY, placeholders: [] } })).snippet).toBe(
      "AppLocalizations.of(context)!.checkout_pay_button",
    )
  })

  it("marks disabled keys, too-long values and plural messages", () => {
    const plural = key(keyId(5), "items", [
      {
        ...value("en", "x"),
        content: { value: "", message: { parts: [{ variant: { kind: "plural", variable: "count", forms: [{ selector: "one", parts: [{ text: "# item" }], order: 1 }, { selector: "other", parts: [{ text: "# items" }], order: 2 }] } }] } },
        exceeds_max_length: true,
        length: 30,
      },
    ], { enabled: false, status: "unpublished" })
    const view = keyView({ ...inspectKey, keyId: keyId(5), layers: 1, state: "ok" }, context({ resolved: plural, languages: [language("en", { main: true })] }))
    expect(view.chips.map((chip) => chip.label)).toEqual(["Not published", "Disabled"])
    expect(view.values[0]).toMatchObject({ structured: true, tooLong: true, length: 30 })
    expect(view.values[0].text).toContain("items")
  })

  it("says why a key has no values", () => {
    expect(keyView(inspectKey, context({ resolved: undefined, missing: true })).note).toBe(MISSING_KEY_NOTE)
    const loading = keyView(inspectKey, context({ resolved: undefined, loading: true }))
    expect(loading).toMatchObject({ note: null, loading: true, keyName: "old_name", values: [] })
    expect(loading.snippet).toBe("t('old_name')")
    expect(keyView(inspectKey, context({ resolved: { ...PAY, type: "object", values: [] } })).note).toBe(NOT_TEXT_KEY_NOTE)
    const unpublished = keyView(inspectKey, context({ source: "published", resolved: { ...PAY, published: false, values: PAY.values.map((entry) => value(entry.lang, null)) } }))
    expect(unpublished).toMatchObject({ note: NOT_PUBLISHED_NOTE, values: [] })
    expect(keyView(inspectKey, context({ source: "published" })).note).toBeNull()
  })

  it("shows a key of another project with its name and snippet only", () => {
    const view = keyView({ ...inspectKey, projectId: OTHER_PROJECT_ID }, context())
    expect(view).toMatchObject({ note: OTHER_PROJECT_NOTE, values: [], keyName: "old_name", snippet: "t('old_name')" })
    expect(view.openUrl).toBe(dashboardKeyUrl(DASHBOARD, OTHER_PROJECT_ID, PAY.id))
  })

  it("reads a language the answer lacks as missing", () => {
    expect(valueViews(key(keyId(1), "a", [value("en", "A")]), [language("en", { main: true }), language("it")]).map((entry) => entry.state)).toEqual(["present", "missing"])
  })

  it("builds dashboard links without a doubled slash", () => {
    expect(dashboardKeyUrl("https://rerune.io/", PROJECT_ID, keyId(1))).toBe("https://rerune.io/translator/translations/" + PROJECT_ID + "?key=" + keyId(1))
  })
})

describe("inspectCacheEntries", () => {
  const keys = new Map([
    [PAY.id, PAY],
    [keyId(2), key(keyId(2), "draft_only", [value("en", null), value("de", "x")], { published: false })],
  ])

  it("caches every text key after a draft resolve", () => {
    expect(inspectCacheEntries(keys, "en", "draft")).toEqual([
      { keyId: PAY.id, k: "checkout_pay_button", placeholders: ["amount"], sourceText: "Pay {{amount}}" },
      { keyId: keyId(2), k: "draft_only", placeholders: [], sourceText: "" },
    ])
  })

  it("keeps the cached draft entry of keys without a published main value", () => {
    expect(inspectCacheEntries(keys, "en", "published").map((entry) => entry.keyId)).toEqual([PAY.id])
  })
})

describe("createInspectLoader", () => {
  function deferred<T>() {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it("loads values per source, saves the codegen cache and keeps the previous values of the other source", async () => {
    const resolve = resolver(new Map([[PAY.id, PAY]]))
    const saveCache = vi.fn()
    const loader = createInspectLoader({ api: { resolveKeys: resolve }, saveCache })
    const pending = loader.load(PROJECT, [PAY.id, keyId(9)], "draft")
    expect(loader.store.get()).toMatchObject({ status: "loading", source: "draft", projectId: PROJECT_ID })
    await pending
    expect(loader.store.get()).toMatchObject({ status: "ready", error: null })
    expect(resolvedFor(loader.store.get(), "draft").get(PAY.id)?.key).toBe("checkout_pay_button")
    expect([...loader.store.get().missing]).toEqual([keyId(9)])
    expect(resolve.mock.calls[0][1].languages).toEqual(["en", "de", "de-AT", "fr"])
    expect(saveCache).toHaveBeenCalledWith(PROJECT_ID, [{ keyId: PAY.id, k: "checkout_pay_button", placeholders: ["amount"], sourceText: "Pay {{amount}}" }])

    await loader.load(PROJECT, [PAY.id], "published")
    expect(resolve.mock.calls[1][1].source).toBe("published")
    expect(resolvedFor(loader.store.get(), "published").has(PAY.id)).toBe(true)
    expect(resolvedFor(loader.store.get(), "draft").has(PAY.id)).toBe(true)
  })

  it("drops a superseded answer from the view but still caches it", async () => {
    const first = deferred<FigmaResolveResponse>()
    const second = deferred<FigmaResolveResponse>()
    const answers = [first, second]
    const resolveKeys = vi.fn(() => (answers.shift() as typeof first).promise)
    const saveCache = vi.fn()
    const loader = createInspectLoader({ api: { resolveKeys }, saveCache })
    const old = loader.load(PROJECT, [keyId(1)], "draft")
    const latest = loader.load(PROJECT, [keyId(2)], "draft")
    const response = (keyValue: FigmaResolvedKey): FigmaResolveResponse => ({ source: "draft", variation_option: null, keys: [keyValue], missing_key_ids: [] })
    second.resolve(response(key(keyId(2), "second", [value("en", "Second")])))
    await latest
    first.resolve(response(key(keyId(1), "first", [value("en", "First")])))
    await old
    const draft = resolvedFor(loader.store.get(), "draft")
    expect([...draft.keys()]).toEqual([keyId(2)])
    expect(loader.store.get().status).toBe("ready")
    expect(saveCache).toHaveBeenCalledTimes(2)
    expect(saveCache.mock.calls[1][1][0].k).toBe("first")
  })

  it("reports errors with the reason and keeps what was loaded before", async () => {
    let failing = false
    const resolve = resolver(new Map([[PAY.id, PAY]]), () => (failing ? new ApiError(400, "unknown_language", "unknown language fr") : undefined))
    const saveCache = vi.fn()
    const loader = createInspectLoader({ api: { resolveKeys: resolve }, saveCache })
    await loader.load(PROJECT, [PAY.id], "draft")
    failing = true
    await loader.load(PROJECT, [PAY.id], "draft")
    expect(loader.store.get()).toMatchObject({ status: "error", errorReason: "unknown_language", error: "This language was removed from the project. Refresh." })
    expect(resolvedFor(loader.store.get(), "draft").has(PAY.id)).toBe(true)
    expect(saveCache).toHaveBeenCalledTimes(1)
  })

  it("is ready at once without keys or languages, and starts over for another project or after reset", async () => {
    const resolve = resolver(new Map([[PAY.id, PAY]]))
    const loader = createInspectLoader({ api: { resolveKeys: resolve }, saveCache: vi.fn() })
    await loader.load(PROJECT, [], "draft")
    expect(loader.store.get().status).toBe("ready")
    await loader.load({ ...PROJECT, languages: [] }, [PAY.id], "draft")
    expect(loader.store.get().status).toBe("ready")
    expect(resolve).not.toHaveBeenCalled()

    await loader.load(PROJECT, [PAY.id], "draft")
    expect(resolvedFor(loader.store.get(), "draft").size).toBe(1)
    const other = loader.load({ ...PROJECT, id: OTHER_PROJECT_ID }, [], "draft")
    expect(resolvedFor(loader.store.get(), "draft").size).toBe(0)
    await other
    await loader.load(PROJECT, [PAY.id], "draft")
    loader.reset()
    expect(loader.store.get()).toMatchObject({ projectId: null, status: "idle" })
    expect(resolvedFor(loader.store.get(), "draft").size).toBe(0)
  })
})
