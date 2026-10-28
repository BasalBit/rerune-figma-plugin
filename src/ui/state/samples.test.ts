import { describe, expect, it } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolvedKey, TranslationContent } from "../../shared/api-types"
import { formatCount } from "../../shared/icu"
import {
  activePluralChoice,
  AUTOMATIC,
  categoryOptions,
  projectSamples,
  SAMPLE_VALUE_MAX,
  sameSamples,
  sampleHint,
  samplePlaceholders,
  samplesSummary,
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
      { name: "user", kind: "text", options: [] },
      { name: "extra", kind: "text", options: [] },
      { name: "name", kind: "text", options: [] },
      { name: "count", kind: "plural", options: [] },
      { name: "gender", kind: "select", options: ["female", "other"] },
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
    expect(samplePlaceholders(nodes, PROJECT_ID, resolved, "en")).toEqual([{ name: "from_catalog", kind: "text", options: [] }])
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

  it("applies a choice only in its project and in languages that have the category", () => {
    const choice = { projectId: PROJECT_ID, variable: "count", category: "few" }
    expect(activePluralChoice(choice, PROJECT_ID, "pl")).toEqual({ variable: "count", category: "few" })
    expect(activePluralChoice(choice, PROJECT_ID, "en")).toBeNull()
    expect(activePluralChoice(choice, "other", "pl")).toBeNull()
    expect(activePluralChoice(choice, PROJECT_ID, null)).toBeNull()
    expect(activePluralChoice(null, PROJECT_ID, "pl")).toBeNull()
  })

  it("summarises samples and the plural form, and hints per kind", () => {
    const placeholders = [
      { name: "name", kind: "text" as const, options: [] },
      { name: "count", kind: "plural" as const, options: [] },
      { name: "gender", kind: "select" as const, options: ["female", "other"] },
    ]
    expect(samplesSummary(placeholders, { name: "Ada", count: "5" }, { variable: "count", category: "one" })).toBe("name = Ada · count: one")
    expect(samplesSummary(placeholders, { gender: "female", unused: "x" }, null)).toBe("gender = female")
    expect(samplesSummary(placeholders, {}, null)).toBeNull()
    expect(placeholders.map(sampleHint)).toEqual(["Shown as [name] without a sample", "A number, or pick a plural form", "One of: female, other"])
    expect(sampleHint({ name: "x", kind: "select", options: [] })).toBe("A select value")
  })
})
