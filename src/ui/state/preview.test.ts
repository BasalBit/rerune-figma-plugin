import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolvedKey, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import { ApiError } from "../api/client"
import {
  buildPreview,
  defaultLanguage,
  languageLabel,
  previewKeyIds,
  previewStatus,
  previewTargets,
  resetOutcome,
  resolveForPreview,
  sourceLabel,
} from "./preview"

function deKey(id: string, key: string, value: FigmaResolvedKey["values"][number]): FigmaResolvedKey {
  return { id, key, type: "key", enabled: true, status: "published", published: true, description: "", tags: [], max_length: null, placeholders: [], values: [value] }
}

function present(text: string, extra: Partial<FigmaResolvedKey["values"][number]> = {}): FigmaResolvedKey["values"][number] {
  return { lang: "de-AT", present: true, resolved_lang: "de-AT", inherited: false, variation_applied: false, content: { value: text }, length: text.length, exceeds_max_length: false, ...extra }
}

const ABSENT: FigmaResolvedKey["values"][number] = { lang: "de-AT", present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }

const PREVIEWING = { lang: "fr", source: "draft" as const, variationOptionId: null, appliedAt: 1 }

const nodes = [
  linkedNode("I7:1;1:1", "Pay now", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now", nid: "1:1", state: "inherited" }),
  linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now" }),
  linkedNode("1:2", "Hi {{name}}", { keyId: keyId(2), keyName: "greeting", syncedText: "Hi {{name}}" }),
  linkedNode("1:3", "Bonjour", { keyId: keyId(3), keyName: "missing_de", syncedText: "Hello" }, { originalCharacters: "Hello", preview: PREVIEWING }),
  linkedNode("1:4", "Gone", { keyId: keyId(4), keyName: "gone", syncedText: "Gone" }),
  linkedNode("1:5", "Var", { keyId: keyId(5), keyName: "var", syncedText: "Var" }, { boundToVariable: true }),
  linkedNode("1:6", "Other", { keyId: keyId(6), keyName: "other", syncedText: "Other", projectId: OTHER_PROJECT_ID }),
  linkedNode("I9:1;3:3", "Own text", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now", nid: "3:3", state: "inherited_overridden" }),
  scannedNode("1:8", "Plain"),
]

const resolved = new Map([
  [keyId(1), deKey(keyId(1), "checkout_pay", present("Jetzt zahlen", { resolved_lang: "de", inherited: true }))],
  [keyId(2), deKey(keyId(2), "greeting", present("Servus {{name}}"))],
  [keyId(3), deKey(keyId(3), "missing_de", ABSENT)],
])

describe("previewTargets", () => {
  it("keeps links of this project that still name a key", () => {
    expect(previewTargets(nodes, PROJECT_ID).map((node) => node.nodeId)).toEqual(["I7:1;1:1", "1:1", "1:2", "1:3", "1:4", "1:5"])
    expect(previewKeyIds(nodes, PROJECT_ID)).toEqual([keyId(1), keyId(2), keyId(3), keyId(4), keyId(5)])
  })
})

describe("buildPreview", () => {
  it("writes resolved values, keeps the source where missing and lists inherited values", () => {
    const build = buildPreview(nodes, PROJECT_ID, { lang: "de-AT", mode: "draft", variationOptionId: "6a47" }, resolved, new Map())
    expect(build.info).toEqual({ lang: "de-AT", source: "draft", variationOptionId: "6a47" })
    expect(build.items).toEqual([
      { nodeId: "1:1", text: "Jetzt zahlen" },
      { nodeId: "1:2", text: "Servus [name]" },
      { nodeId: "1:3", text: "Hello" },
      { nodeId: "I7:1;1:1", text: "Jetzt zahlen" },
    ])
    expect(build.missing.map((entry) => [entry.nodeId, entry.keyName])).toEqual([["1:3", "missing_de"], ["1:4", "gone"]])
    expect(build.inherited.map((entry) => [entry.nodeId, entry.resolvedLang])).toEqual([["I7:1;1:1", "de"], ["1:1", "de"]])
    expect(build.skipped).toEqual({ variable: ["1:5"], otherProject: 1, unlinked: 2 })
  })

  it("sends a previewing layer without a usable link back to its original text", () => {
    const previewing = [
      scannedNode("2:1", "Bonjour", { originalCharacters: "Hello", preview: PREVIEWING }),
      linkedNode("2:2", "Salut", { keyId: keyId(6), keyName: "other", syncedText: "Hi", projectId: OTHER_PROJECT_ID }, { originalCharacters: "Hi", preview: PREVIEWING }),
    ]
    const build = buildPreview(previewing, PROJECT_ID, { lang: "de-AT", mode: "draft", variationOptionId: null }, resolved, new Map())
    expect(build.items).toEqual([
      { nodeId: "2:1", text: "Hello" },
      { nodeId: "2:2", text: "Hi" },
    ])
    expect(build.skipped).toEqual({ variable: [], otherProject: 1, unlinked: 1 })
  })

  it("previews key names in Show key names mode", () => {
    const build = buildPreview(nodes, PROJECT_ID, { lang: "de-AT", mode: "keys", variationOptionId: "6a47" }, new Map(), new Map([[keyId(2), "greeting_renamed"]]))
    expect(build.info).toEqual({ lang: "de-AT", source: "keys", variationOptionId: null })
    expect(build.items.map((item) => item.text)).toEqual(["[pay]", "[greeting_renamed]", "[missing_de]", "[gone]", "[pay]"])
    expect(build.missing).toEqual([])
  })
})

describe("resolveForPreview", () => {
  it("resolves one language with the chosen source and variation", async () => {
    const resolveKeys = vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
      source: request.source,
      variation_option: null,
      keys: request.key_ids.map((id) => deKey(id, "k", present("x"))),
      missing_key_ids: [],
    }))
    const result = await resolveForPreview({ resolveKeys }, PROJECT_ID, [keyId(1), keyId(2)], { lang: "de-AT", mode: "published", variationOptionId: "v1" })
    expect(resolveKeys).toHaveBeenCalledWith(PROJECT_ID, { key_ids: [keyId(1), keyId(2)], languages: ["de-AT"], source: "published", variation_option_id: "v1" })
    expect(result.size).toBe(2)
    await expect(resolveForPreview({ resolveKeys }, PROJECT_ID, [keyId(1)], { lang: "de", mode: "keys", variationOptionId: null })).resolves.toEqual(new Map())
  })

  it("throws resolve errors so the screen can explain them", async () => {
    const resolveKeys = vi.fn(async () => Promise.reject(new ApiError(400, "unknown_language", "unknown language")))
    await expect(resolveForPreview({ resolveKeys }, PROJECT_ID, [keyId(1)], { lang: "xx", mode: "draft", variationOptionId: null })).rejects.toBeInstanceOf(ApiError)
  })
})

describe("labels and status", () => {
  const languages = [
    { code: "en", name: "English", main: true, rtl_writing: false, inherits_from: [] },
    { code: "de", name: "German", main: false, rtl_writing: false, inherits_from: [] },
    { code: "de-AT", name: "German (Austria)", main: false, rtl_writing: false, inherits_from: ["de"] },
  ]

  it("shows the inheritance chain", () => {
    expect(languageLabel(languages[2])).toBe("German (Austria) (de-AT) · falls back to de")
    expect(languageLabel(languages[0])).toBe("English (en) · source")
  })

  it("picks the last language, else the first non-main one", () => {
    expect(defaultLanguage({ languages, main_language: "en" }, "de-AT")).toBe("de-AT")
    expect(defaultLanguage({ languages, main_language: "en" }, "fr")).toBe("de")
    expect(defaultLanguage({ languages: [], main_language: "" }, null)).toBeNull()
  })

  it("summarises active previews from the scan", () => {
    expect(previewStatus(nodes)).toEqual({ lang: "fr", source: "draft", count: 1, mixed: false })
    expect(previewStatus([scannedNode("1", "x")])).toBeNull()
    expect(sourceLabel("keys")).toBe("key names")
  })

  it("splits reset results into edited, override and other errors", () => {
    const outcome = resetOutcome(3, [
      { nodeId: "1", code: "edited_during_preview", message: "edited" },
      { nodeId: "2", code: "override_kept", message: "kept" },
      { nodeId: "3", code: "missing_font", message: "font" },
    ])
    expect(outcome).toEqual({ done: 3, edited: ["1"], overrideKept: 1, otherErrors: [{ nodeId: "3", code: "missing_font", message: "font" }] })
  })
})
