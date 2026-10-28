import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolvedKey, FigmaResolveRequest, FigmaResolveResponse, TranslationContent, VariantForm } from "../../shared/api-types"
import { formatCount, NO_PLURAL_SHAPE, renderContent } from "../../shared/icu"
import {
  activePluralChoice,
  AUTOMATIC,
  categoryOptions,
  chosenCategory,
  knownPluralShapes,
  loadPluralShapes,
  pluralKeyIds,
  pluralShapes,
  projectSamples,
  SAMPLE_VALUE_MAX,
  sameSamples,
  sampleHint,
  samplePlaceholders,
  samplesSummary,
  shapesKey,
  withDrafts,
  withoutSamples,
  withSample,
} from "./samples"

function key(id: string, content: TranslationContent | null, placeholders: string[] = [], type: FigmaResolvedKey["type"] = "key"): FigmaResolvedKey {
  return {
    id,
    key: "k" + id.slice(-1),
    type,
    enabled: true,
    status: "published",
    published: true,
    description: "",
    tags: [],
    max_length: null,
    placeholders: placeholders.map((name) => ({ name, type: "string", format: "" })),
    values: [
      content === null
        ? { lang: "en", present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }
        : { lang: "en", present: true, resolved_lang: "en", inherited: false, variation_applied: false, content, length: 0, exceeds_max_length: false },
    ],
  }
}

const cartMessage: TranslationContent = {
  value: "",
  message: {
    parts: [
      { arg: { name: "name" } },
      { text: ": " },
      {
        variant: {
          kind: "plural",
          variable: "count",
          forms: [
            { selector: "one", parts: [{ text: "# item" }], order: 0 },
            {
              selector: "other",
              parts: [
                { text: "# items for " },
                { variant: { kind: "select", variable: "gender", forms: [{ selector: "female", parts: [{ text: "her" }], order: 0 }, { selector: "other", parts: [{ text: "them" }], order: 1 }] } },
              ],
              order: 1,
            },
          ],
        },
      },
    ],
  },
}

describe("samplePlaceholders", () => {
  it("lists the placeholders of the keys linked in scope, in layer order, with plural and select variables marked", () => {
    const nodes = [
      linkedNode("1:1", "Hi {{user}}", { keyId: keyId(2), keyName: "greeting", syncedText: "Hi {{user}}" }),
      linkedNode("1:2", "Ada: 2 items", { keyId: keyId(1), keyName: "cart", syncedText: "Ada: 2 items" }),
      linkedNode("1:3", "Ada: 2 items", { keyId: keyId(1), keyName: "cart", syncedText: "Ada: 2 items", nid: "9:9", state: "copied" }),
      linkedNode("1:4", "Other", { keyId: keyId(3), keyName: "other", syncedText: "Other", projectId: OTHER_PROJECT_ID }),
      linkedNode("1:5", "Own", { keyId: keyId(4), keyName: "own", syncedText: "x", nid: "8:8", state: "inherited_overridden" }),
      scannedNode("1:6", "Unlinked {{nope}}"),
    ]
    const resolved = new Map([
      [keyId(1), key(keyId(1), cartMessage, ["name", "count", "gender"])],
      [keyId(2), key(keyId(2), { value: "Hi {{user}}, {{ spaced }}" }, ["user", "extra"])],
      [keyId(3), key(keyId(3), { value: "{{other_project}}" }, ["other_project"])],
      [keyId(4), key(keyId(4), { value: "{{overridden}}" }, ["overridden"])],
    ])
    expect(samplePlaceholders(nodes, PROJECT_ID, resolved, "en")).toEqual([
      { name: "user", kind: "text", options: [], plural: null },
      { name: "extra", kind: "text", options: [], plural: null },
      { name: "name", kind: "text", options: [], plural: null },
      { name: "count", kind: "plural", options: [], plural: { selectors: ["one", "other"], offset: 0 } },
      { name: "gender", kind: "select", options: ["female", "other"], plural: null },
    ])
  })

  it("lists select options and plural selectors in the server's form order, also when orders tie", () => {
    const tied: TranslationContent = {
      value: "",
      message: {
        parts: [
          { variant: { kind: "select", variable: "gender", forms: [{ selector: "male", parts: [], order: 0 }, { selector: "female", parts: [], order: 0 }, { selector: "other", parts: [], order: 0 }] } },
          { variant: { kind: "plural", variable: "count", forms: [{ selector: "other", parts: [], order: 0 }, { selector: "one", parts: [], order: 0 }, { selector: "=0", parts: [], order: 0 }] } },
        ],
      },
    }
    const nodes = [linkedNode("1:1", "a", { keyId: keyId(1), keyName: "a", syncedText: "a" })]
    const resolved = new Map([[keyId(1), key(keyId(1), tied, ["gender", "count"])]])
    expect(samplePlaceholders(nodes, PROJECT_ID, resolved, "en")).toEqual([
      { name: "gender", kind: "select", options: ["other", "female", "male"], plural: null },
      { name: "count", kind: "plural", options: [], plural: { selectors: ["=0", "one", "other"], offset: 0 } },
    ])
  })

  it("skips keys without a loaded state, group keys and keys without a main value", () => {
    const nodes = [
      linkedNode("1:1", "a", { keyId: keyId(1), keyName: "a", syncedText: "a" }),
      linkedNode("1:2", "b", { keyId: keyId(2), keyName: "b", syncedText: "b" }),
      linkedNode("1:3", "c", { keyId: keyId(3), keyName: "c", syncedText: "c" }),
    ]
    const resolved = new Map([
      [keyId(2), key(keyId(2), null, ["from_catalog"])],
      [keyId(3), key(keyId(3), { value: "{{x}}" }, ["x"], "object")],
    ])
    expect(samplePlaceholders(nodes, PROJECT_ID, resolved, "en")).toEqual([{ name: "from_catalog", kind: "text", options: [], plural: null }])
  })

  it("collects every form selector of a plural variable across keys, with the first block's offset", () => {
    const zeroForms: TranslationContent = {
      value: "",
      message: { parts: [{ variant: { kind: "plural", variable: "count", offset: 1, forms: [{ selector: "zero", parts: [{ text: "No items" }], order: 0 }, { selector: "other", parts: [{ text: "# items" }], order: 1 }] } }] },
    }
    const nodes = [
      linkedNode("1:1", "a", { keyId: keyId(1), keyName: "a", syncedText: "a" }),
      linkedNode("1:2", "b", { keyId: keyId(2), keyName: "b", syncedText: "b" }),
    ]
    const resolved = new Map([
      [keyId(1), key(keyId(1), cartMessage, ["count"])],
      [keyId(2), key(keyId(2), zeroForms, ["count"])],
    ])
    expect(samplePlaceholders(nodes, PROJECT_ID, resolved, "en").find((placeholder) => placeholder.name === "count")).toEqual({
      name: "count",
      kind: "plural",
      options: [],
      plural: { selectors: ["one", "other", "zero"], offset: 0 },
    })
  })
})

describe("samples in prefs", () => {
  const all = { [PROJECT_ID]: { name: "Ada" }, other: { name: "Bob" } }

  it("sets, clears and caps one project's samples, leaving other projects alone", () => {
    expect(projectSamples(all, PROJECT_ID)).toEqual({ name: "Ada" })
    expect(projectSamples(all, "none")).toEqual({})
    expect(withSample(all, PROJECT_ID, "count", "3")).toEqual({ [PROJECT_ID]: { name: "Ada", count: "3" }, other: { name: "Bob" } })
    expect(withSample(all, PROJECT_ID, "name", "")).toEqual({ other: { name: "Bob" } })
    expect(withSample({}, PROJECT_ID, "name", "x".repeat(SAMPLE_VALUE_MAX + 5))[PROJECT_ID].name).toHaveLength(SAMPLE_VALUE_MAX)
    expect(withSample(all, PROJECT_ID, "name", " Ada ")[PROJECT_ID].name).toBe(" Ada ")
    expect(withoutSamples(all, PROJECT_ID)).toEqual({ other: { name: "Bob" } })
    expect(all).toEqual({ [PROJECT_ID]: { name: "Ada" }, other: { name: "Bob" } })
  })

  it("replaces a project's samples with the editor's drafts", () => {
    expect(withDrafts(all, PROJECT_ID, { name: "", count: "2", gender: "female" })).toEqual({ [PROJECT_ID]: { count: "2", gender: "female" }, other: { name: "Bob" } })
    expect(withDrafts(all, PROJECT_ID, {})).toEqual({ other: { name: "Bob" } })
    expect(sameSamples({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true)
    expect(sameSamples({ a: "1" }, { a: "1", b: "2" })).toBe(false)
    expect(sameSamples({ a: "1" }, { a: "2" })).toBe(false)
  })
})

describe("plural selector", () => {
  it("offers Automatic and the language's categories with the count each one shows", () => {
    expect(categoryOptions("en")).toEqual([
      { value: AUTOMATIC, text: "Automatic" },
      { value: "one", text: "one (1)" },
      { value: "other", text: "other (0)" },
    ])
    expect(categoryOptions("pl").map((option) => option.text)).toEqual(["Automatic", "one (1)", "few (2)", "many (0)", "other (" + formatCount("pl", 0.5) + ")"])
    expect(categoryOptions("de-AT").map((option) => option.value)).toEqual([AUTOMATIC, "one", "other"])
    expect(categoryOptions("xx").map((option) => option.value)).toEqual([AUTOMATIC, "other"])
  })

  it("offers a zero / one / two form the language lacks as its exact count, and labels each option with the count it shows", () => {
    const stored = { selectors: ["zero", "one", "other"], offset: 0 }
    // Flutter =0 / =1 stored as zero / one: "other" skips 0, which the zero form claims.
    expect(categoryOptions("en", stored)).toEqual([
      { value: AUTOMATIC, text: "Automatic" },
      { value: "zero", text: "zero (0)" },
      { value: "one", text: "one (1)" },
      { value: "other", text: "other (2)" },
    ])
    expect(categoryOptions("ja", { selectors: ["one", "other"], offset: 0 }).map((option) => option.text)).toEqual(["Automatic", "one (1)", "other (0)"])
    // Arabic has a zero category of its own.
    expect(categoryOptions("ar", stored).map((option) => option.value)).toEqual([AUTOMATIC, "zero", "one", "two", "few", "many", "other"])
    expect(categoryOptions("en", { selectors: ["=0", "one", "other"], offset: 0 }).map((option) => option.text)).toEqual(["Automatic", "one (1)", "other (2)"])
  })

  it("keeps the label and the preview in step for every option", () => {
    const content: TranslationContent = {
      value: "",
      message: { parts: [{ variant: { kind: "plural", variable: "count", forms: [{ selector: "zero", parts: [{ text: "none" }], order: 0 }, { selector: "one", parts: [{ text: "#:one" }], order: 1 }, { selector: "other", parts: [{ text: "#:other" }], order: 2 }] } }] },
    }
    for (const option of categoryOptions("en", { selectors: ["zero", "one", "other"], offset: 0 }).slice(1)) {
      const count = option.text.match(/\((\d+)\)/)?.[1]
      const rendered = renderContent(content, { lang: "en", plural: { variable: "count", category: option.value } })
      expect(rendered === "none" ? "0" : rendered.split(":")[0], option.text).toBe(count)
      expect(rendered === "none" ? "zero" : rendered.split(":")[1]).toBe(option.value)
    }
  })

  it("applies a choice only in its project and in languages that have the category or the exact form", () => {
    const choice = { projectId: PROJECT_ID, variable: "count", category: "few" }
    expect(activePluralChoice(choice, PROJECT_ID, "pl")).toEqual({ variable: "count", category: "few" })
    expect(activePluralChoice(choice, PROJECT_ID, "en")).toBeNull()
    expect(activePluralChoice(choice, "other", "pl")).toBeNull()
    expect(activePluralChoice(choice, PROJECT_ID, null)).toBeNull()
    expect(activePluralChoice(null, PROJECT_ID, "pl")).toBeNull()
    expect(activePluralChoice({ ...choice, category: "zero" }, PROJECT_ID, "en")).toEqual({ variable: "count", category: "zero" })
  })

  it("shows a picked form only where the placeholder's selector offers it", () => {
    const count = { name: "count", kind: "plural" as const, options: [], plural: { selectors: ["zero", "one", "other"], offset: 0 } }
    const files = { name: "count", kind: "plural" as const, options: [], plural: { selectors: ["one", "other"], offset: 0 } }
    expect(chosenCategory(count, "en", { variable: "count", category: "zero" })).toBe("zero")
    expect(chosenCategory(files, "en", { variable: "count", category: "zero" })).toBeNull()
    expect(chosenCategory(count, "en", { variable: "n", category: "one" })).toBeNull()
    expect(chosenCategory(count, null, { variable: "count", category: "one" })).toBeNull()
    expect(chosenCategory({ ...count, kind: "text" }, "en", { variable: "count", category: "one" })).toBeNull()
  })

  it("summarises samples and the plural form, and hints per kind", () => {
    const placeholders = [
      { name: "name", kind: "text" as const, options: [], plural: null },
      { name: "count", kind: "plural" as const, options: [], plural: { selectors: ["one", "other"], offset: 0 } },
      { name: "gender", kind: "select" as const, options: ["female", "other"], plural: null },
    ]
    expect(samplesSummary(placeholders, { name: "Ada", count: "5" }, { variable: "count", category: "one" }, "en")).toBe("name = Ada · count: one")
    // A form the previewed language can't show leaves the typed sample in the summary.
    expect(samplesSummary(placeholders, { count: "5" }, { variable: "count", category: "few" }, "en")).toBe("count = 5")
    expect(samplesSummary(placeholders, { gender: "female", unused: "x" }, null, "en")).toBe("gender = female")
    expect(samplesSummary(placeholders, {}, null, "en")).toBeNull()
    expect(placeholders.map(sampleHint)).toEqual(["Shown as [name] without a sample", "A number, or pick a plural form", "One of: female, other"])
    expect(sampleHint({ name: "x", kind: "select", options: [], plural: null })).toBe("A select value")
  })
})

// A plural message on `count` with these forms (`#` → the count).
function pluralOn(forms: Record<string, string>): TranslationContent {
  const list: VariantForm[] = Object.entries(forms).map(([selector, text], order) => ({ selector, parts: [{ text }], order }))
  return { value: "", message: { parts: [{ variant: { kind: "plural", variable: "count", forms: list } }] } }
}

// A key with one value per language.
function keyIn(id: string, values: Record<string, TranslationContent>): FigmaResolvedKey {
  return {
    ...key(id, null, ["count"]),
    values: Object.entries(values).map(([lang, content]) => ({ lang, present: true, resolved_lang: lang, inherited: false, variation_applied: false, content, length: 0, exceeds_max_length: false })),
  }
}

describe("plural selector of the rendered language (§7.18.5)", () => {
  const nodes = [
    linkedNode("1:1", "2 items", { keyId: keyId(1), keyName: "items", syncedText: "2 items" }),
    linkedNode("1:2", "Hi", { keyId: keyId(2), keyName: "hi", syncedText: "Hi" }),
  ]
  const en = pluralOn({ one: "# item", other: "# items" })
  const deZero = pluralOn({ zero: "Keine", one: "# Element", other: "# Elemente" })
  const main = new Map([
    [keyId(1), keyIn(keyId(1), { en })],
    [keyId(2), keyIn(keyId(2), { en: { value: "Hi" } })],
  ])

  it("offers the target language's zero form the main language lacks, with the counts its forms render", () => {
    const shapes = pluralShapes(nodes, PROJECT_ID, new Map([[keyId(1), keyIn(keyId(1), { de: deZero })]]), "de")
    expect(shapes).toEqual(new Map([["count", { selectors: ["zero", "one", "other"], offset: 0 }]]))
    const [placeholder] = samplePlaceholders(nodes, PROJECT_ID, main, "en", shapes)
    expect(placeholder).toEqual({ name: "count", kind: "plural", options: [], plural: { selectors: ["zero", "one", "other"], offset: 0 } })
    const options = categoryOptions("de", placeholder.plural)
    expect(options.map((option) => option.text)).toEqual(["Automatic", "zero (0)", "one (1)", "other (2)"])
    // Every option renders the count and the form it is labelled with.
    const rendered = options.map((option) => renderContent(deZero, { lang: "de", plural: option.value === AUTOMATIC ? undefined : { variable: "count", category: option.value } }))
    expect(rendered).toEqual(["2 Elemente", "Keine", "1 Element", "2 Elemente"])
    expect(chosenCategory(placeholder, "de", { variable: "count", category: "zero" })).toBe("zero")
    // The main language's shape (the former behaviour) offered no zero and labelled other with 0.
    expect(categoryOptions("de", samplePlaceholders(nodes, PROJECT_ID, main, "en")[0].plural).map((option) => option.text)).toEqual(["Automatic", "one (1)", "other (0)"])
  })

  it("does not offer the main language's zero form in a language without it", () => {
    const enZero = pluralOn({ zero: "No items", one: "# item", other: "# items" })
    const de = pluralOn({ one: "# Element", other: "# Elemente" })
    const withZero = new Map([[keyId(1), keyIn(keyId(1), { en: enZero })]])
    const shapes = pluralShapes(nodes, PROJECT_ID, new Map([[keyId(1), keyIn(keyId(1), { de })]]), "de")
    const [placeholder] = samplePlaceholders(nodes, PROJECT_ID, withZero, "en", shapes)
    const options = categoryOptions("de", placeholder.plural)
    expect(options.map((option) => option.text)).toEqual(["Automatic", "one (1)", "other (0)"])
    expect(renderContent(de, { lang: "de", plural: { variable: "count", category: "other" } })).toBe("0 Elemente")
    // A zero picked for English shows as Automatic here.
    expect(chosenCategory(placeholder, "de", { variable: "count", category: "zero" })).toBeNull()
  })

  it("lists the category names without counts while the rendered language's forms are not known", () => {
    const [placeholder] = samplePlaceholders(nodes, PROJECT_ID, main, "en", null)
    expect(placeholder.plural).toBeNull()
    expect(categoryOptions("pl", null)).toEqual([
      { value: AUTOMATIC, text: "Automatic" },
      { value: "one", text: "one" },
      { value: "few", text: "few" },
      { value: "many", text: "many" },
      { value: "other", text: "other" },
    ])
    expect(chosenCategory(placeholder, "pl", { variable: "count", category: "few" })).toBe("few")
    // A variable the rendered language does not write as a plural has no forms there.
    expect(samplePlaceholders(nodes, PROJECT_ID, main, "en", new Map())[0].plural).toEqual(NO_PLURAL_SHAPE)
  })

  it("loads the forms with one resolve of the plural keys in scope, or takes the workspace's main draft", async () => {
    expect(pluralKeyIds(nodes, PROJECT_ID, main, "en")).toEqual([keyId(1)])
    const draft = { lang: "en", source: "draft" as const, variationOptionId: null }
    expect(knownPluralShapes(nodes, PROJECT_ID, main, "en", draft)).toEqual(new Map([["count", { selectors: ["one", "other"], offset: 0 }]]))
    expect(knownPluralShapes(nodes, PROJECT_ID, main, "en", { ...draft, source: "published" })).toBeNull()
    expect(knownPluralShapes(nodes, PROJECT_ID, main, "en", { ...draft, lang: "de" })).toBeNull()
    // No plural key in scope: nothing to load.
    expect(knownPluralShapes([nodes[1]], PROJECT_ID, main, "en", { ...draft, lang: "de" })).toEqual(new Map())

    const resolveKeys = vi.fn(async (_projectId: string, body: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
      source: body.source,
      variation_option: null,
      missing_key_ids: [],
      keys: body.key_ids.map((id) => keyIn(id, { de: deZero })),
    }))
    const request = { lang: "de", source: "published" as const, variationOptionId: "v1" }
    const shapes = await loadPluralShapes({ resolveKeys }, nodes, PROJECT_ID, main, "en", request)
    expect(resolveKeys).toHaveBeenCalledWith(PROJECT_ID, { key_ids: [keyId(1)], languages: ["de"], source: "published", variation_option_id: "v1" })
    expect(shapes.get("count")?.selectors).toEqual(["zero", "one", "other"])
    expect(shapesKey(request, [keyId(2), keyId(1)])).toBe(shapesKey(request, [keyId(1), keyId(2)]))
    expect(shapesKey(request, [keyId(1)])).not.toBe(shapesKey({ ...request, lang: "it" }, [keyId(1)]))
  })
})
