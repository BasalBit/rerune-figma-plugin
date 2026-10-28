import { describe, expect, it } from "vitest"
import { SERVER_PLURAL_SAMPLES, SERVER_PLURAL_VECTORS } from "../../test/server-plural-vectors"
import type { MessagePart, TranslationContent, VariantBlock } from "./api-types"
import {
  choiceCount,
  exactCountOf,
  formatCount,
  languageLookupTags,
  NO_PLURAL_SHAPE,
  PLURAL_CATEGORY_ORDER,
  placeholderNames,
  pluralCategories,
  pluralCategory,
  pluralLocale,
  renderContent,
  sampleCountFor,
  sortedVariantForms,
} from "./icu"

function message(...parts: MessagePart[]): TranslationContent {
  return { value: "", message: { parts } }
}

function plural(variable: string, forms: [string, MessagePart[]][], offset?: number): MessagePart {
  const block: VariantBlock = { kind: "plural", variable, forms: forms.map(([selector, parts], order) => ({ selector, parts, order })) }
  if (offset !== undefined) {
    block.offset = offset
  }
  return { variant: block }
}

function select(variable: string, forms: [string, string][], kind: "select" | "choice" = "select"): MessagePart {
  return { variant: { kind, variable, forms: forms.map(([selector, text], order) => ({ selector, parts: [{ text }], order })) } }
}

// "You have {count, plural, =0 {no items} one {# item} other {# items}}"
const itemsMessage = message(
  { text: "You have " },
  plural("count", [
    ["=0", [{ text: "no items" }]],
    ["one", [{ text: "# item" }]],
    ["other", [{ text: "# items" }]],
  ]),
)

// Polish "{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}"
const polishFiles = message(
  plural("n", [
    ["one", [{ text: "# plik" }]],
    ["few", [{ text: "# pliki" }]],
    ["many", [{ text: "# plików" }]],
    ["other", [{ text: "# pliku" }]],
  ]),
)

// "{guests, plural, offset:1 =0 {Nobody} =1 {Just you} one {You and # other} other {You and # others}}"
const guestsMessage = message(
  plural(
    "guests",
    [
      ["=0", [{ text: "Nobody" }]],
      ["=1", [{ text: "Just you" }]],
      ["one", [{ text: "You and # other" }]],
      ["other", [{ text: "You and # others" }]],
    ],
    1,
  ),
)

describe("renderContent: plain values", () => {
  it("returns plain text and an empty string for missing content", () => {
    expect(renderContent({ value: "Pay now" }, { lang: "en" })).toBe("Pay now")
    expect(renderContent(null, { lang: "en" })).toBe("")
  })

  it("shows [name] for placeholders without a sample", () => {
    expect(renderContent({ value: "Hi {{name}}, pay {{amount}}" }, { lang: "en" })).toBe("Hi [name], pay [amount]")
  })

  it("fills only the references the server treats as placeholders and shows any other {{…}} as typed", () => {
    // The server stores Flutter "Hello {name}, {{ spaced }} and {{user.name}}" as this value, the last two as text.
    const value = "Hello {{name}}, {{ spaced }} and {{user.name}}"
    expect(renderContent({ value }, { lang: "en" })).toBe("Hello [name], {{ spaced }} and {{user.name}}")
    const samples = { name: "Ada", spaced: "S", " spaced ": "T", "user.name": "U", "2x": "V" }
    expect(renderContent({ value: value + " {{2x}} {{}} {{_total}}" }, { lang: "en", samples })).toBe("Hello Ada, {{ spaced }} and {{user.name}} {{2x}} {{}} [_total]")
  })

  it("uses samples when given, also an empty one", () => {
    expect(renderContent({ value: "Hi {{name}}" }, { lang: "en", samples: { name: "Ada" } })).toBe("Hi Ada")
    expect(renderContent({ value: "Hi {{name}}!" }, { lang: "en", samples: { name: "" } })).toBe("Hi !")
  })
})

describe("renderContent: arguments and select", () => {
  it("renders text and args", () => {
    const content = message({ text: "Hi " }, { arg: { name: "name" } }, { text: "!" })
    expect(renderContent(content, { lang: "en" })).toBe("Hi [name]!")
    expect(renderContent(content, { lang: "en", samples: { name: "Ada" } })).toBe("Hi Ada!")
  })

  it("selects select/choice forms by sample, else other, else the first form", () => {
    const gender = message(select("gender", [["female", "She"], ["male", "He"], ["other", "They"]]))
    expect(renderContent(gender, { lang: "en", samples: { gender: "female" } })).toBe("She")
    expect(renderContent(gender, { lang: "en", samples: { gender: " male " } })).toBe("He")
    expect(renderContent(gender, { lang: "en", samples: { gender: "robot" } })).toBe("They")
    expect(renderContent(gender, { lang: "en" })).toBe("They")
    expect(renderContent(message(select("x", [["a", "A"], ["b", "B"]])), { lang: "en" })).toBe("A")
    expect(renderContent(message(select("n", [["0#", "none"], ["1#", "one"], ["1<", "many"]], "choice")), { lang: "en", samples: { n: "1#" } })).toBe("one")
  })

  it("orders forms by their order field and renders an empty variant as nothing", () => {
    const block: VariantBlock = {
      kind: "select",
      variable: "x",
      forms: [
        { selector: "b", parts: [{ text: "B" }], order: 1 },
        { selector: "a", parts: [{ text: "A" }], order: 0 },
      ],
    }
    expect(renderContent(message({ variant: block }), { lang: "en" })).toBe("A")
    expect(renderContent(message({ text: "x" }, { variant: { kind: "plural", variable: "n", forms: [] } }), { lang: "en" })).toBe("x")
  })

  it("breaks ties in order like the server, so the first form is the server's first form", () => {
    // `order` is not unique through the API or MCP, and select blocks need no `other` form.
    const tied: VariantBlock = {
      kind: "select",
      variable: "gender",
      forms: [
        { selector: "male", parts: [{ text: "He" }], order: 0 },
        { selector: "female", parts: [{ text: "She" }], order: 0 },
      ],
    }
    expect(renderContent(message({ variant: tied }), { lang: "en", samples: { gender: "robot" } })).toBe("She")
    expect(renderContent(message({ variant: tied }), { lang: "en", samples: { gender: "male" } })).toBe("He")
  })
})

describe("sortedVariantForms (messageformat.SortedVariantForms)", () => {
  const selectors = (forms: [string, number][]) =>
    sortedVariantForms(forms.map(([selector, order]) => ({ selector, parts: [], order }))).map((form) => form.selector)

  it("sorts by order, then =N, the CLDR categories in order, any other selector, then by selector", () => {
    expect(selectors([["b", 0], ["other", 0], ["=1", 0], ["a", 0], ["one", 0], ["=0", 0], ["zero", 0], ["many", 0]])).toEqual(["=0", "=1", "zero", "one", "many", "other", "a", "b"])
    expect(selectors([["other", 0], ["=0", 1], ["one", 1]])).toEqual(["other", "=0", "one"])
    expect(selectors([["one", 2], ["few", 1], ["two", 1]])).toEqual(["two", "few", "one"])
  })

  it("compares selectors by code point, as Go compares UTF-8 bytes", () => {
    expect(selectors([["\u{10000}", 0], ["\uFFFF", 0], ["Z", 0], ["a", 0]])).toEqual(["Z", "a", "\uFFFF", "\u{10000}"])
  })

  it("leaves the forms it is given unchanged", () => {
    const forms = [{ selector: "other", parts: [], order: 1 }, { selector: "one", parts: [], order: 0 }]
    sortedVariantForms(forms)
    expect(forms.map((form) => form.selector)).toEqual(["other", "one"])
  })
})

describe("renderContent: plurals without a choice", () => {
  it("shows the other form with its smallest count that no exact form claims", () => {
    expect(renderContent(itemsMessage, { lang: "en" })).toBe("You have 2 items")
    expect(renderContent(message(plural("n", [["one", [{ text: "# file" }]], ["other", [{ text: "# files" }]]])), { lang: "en" })).toBe("0 files")
  })

  it("uses a count only fractions reach when the language's other form needs one", () => {
    expect(renderContent(polishFiles, { lang: "pl" })).toBe(formatCount("pl", 0.5) + " pliku")
    expect(formatCount("pl", 0.5)).toBe("0,5")
  })
})

describe("renderContent: plural category selector", () => {
  it("renders the chosen category with its smallest count", () => {
    expect(renderContent(itemsMessage, { lang: "en", plural: { variable: "count", category: "one" } })).toBe("You have 1 item")
    expect(renderContent(polishFiles, { lang: "pl", plural: { variable: "n", category: "few" } })).toBe("2 pliki")
    expect(renderContent(polishFiles, { lang: "pl", plural: { variable: "n", category: "many" } })).toBe("0 plików")
    expect(renderContent(polishFiles, { lang: "pl", plural: { variable: "n", category: "one" } })).toBe("1 plik")
  })

  it("reaches categories whose smallest count is above 200", () => {
    const french = message(plural("n", [["one", [{ text: "# fichier" }]], ["many", [{ text: "# de fichiers" }]], ["other", [{ text: "# fichiers" }]]]))
    expect(renderContent(french, { lang: "fr", plural: { variable: "n", category: "many" } })).toBe(formatCount("fr", 1000000) + " de fichiers")
  })

  it("ignores a choice for another variable or a category the language doesn't have", () => {
    expect(renderContent(itemsMessage, { lang: "en", plural: { variable: "other", category: "one" } })).toBe("You have 2 items")
    expect(renderContent(itemsMessage, { lang: "en", plural: { variable: "count", category: "few" } })).toBe("You have 2 items")
  })

  it("wins over a numeric sample of the same variable", () => {
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "5" }, plural: { variable: "count", category: "one" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "5" }, plural: { variable: "count", category: "few" } })).toBe("You have 5 items")
  })

  it("shows the exact form when every count of the category is claimed by one", () => {
    const content = message(plural("n", [["=1", [{ text: "exactly one" }]], ["one", [{ text: "# one" }]], ["other", [{ text: "# others" }]]]))
    expect(renderContent(content, { lang: "en", plural: { variable: "n", category: "one" } })).toBe("exactly one")
  })

  it("covers every category of a six-category language", () => {
    const forms: [string, MessagePart[]][] = PLURAL_CATEGORY_ORDER.map((category) => [category, [{ text: category + ":#" }]])
    const arabic = message(plural("n", forms))
    const rendered = pluralCategories("ar").map((category) => renderContent(arabic, { lang: "ar", plural: { variable: "n", category } }))
    expect(rendered).toEqual(["zero:" + formatCount("ar", 0), "one:" + formatCount("ar", 1), "two:" + formatCount("ar", 2), "few:" + formatCount("ar", 3), "many:" + formatCount("ar", 11), "other:" + formatCount("ar", 100)])
  })
})

// Flutter "{count, plural, =0{No items} =1{# item} other{# items}}" as ReRune stores it (=0 → zero, =1 → one).
const storedZeroMessage = message(
  plural("count", [
    ["zero", [{ text: "No items" }]],
    ["one", [{ text: "# item" }]],
    ["other", [{ text: "# items" }]],
  ]),
)

describe("renderContent: zero, one and two forms of a language without that category", () => {
  it("shows a zero form for exactly 0 in English (Flutter =0, i18next _zero), and never by default", () => {
    expect(pluralCategories("en")).toEqual(["one", "other"])
    expect(renderContent(storedZeroMessage, { lang: "en", samples: { count: "0" } })).toBe("No items")
    expect(renderContent(storedZeroMessage, { lang: "en", samples: { count: "1" } })).toBe("1 item")
    expect(renderContent(storedZeroMessage, { lang: "en", samples: { count: "7" } })).toBe("7 items")
    // Automatic shows the other form with a count the app shows it for.
    expect(renderContent(storedZeroMessage, { lang: "en" })).toBe("2 items")
    expect(renderContent(storedZeroMessage, { lang: "en", plural: { variable: "count", category: "other" } })).toBe("2 items")
    expect(renderContent(storedZeroMessage, { lang: "en", plural: { variable: "count", category: "zero" } })).toBe("No items")
    expect(renderContent(storedZeroMessage, { lang: "en", plural: { variable: "count", category: "one" } })).toBe("1 item")
  })

  it("keeps the CLDR meaning in a language that has the category", () => {
    // Arabic zero is 0; Latvian zero is 0, 10–20, 30, …; French one is 0 and 1, but French has no zero.
    expect(renderContent(storedZeroMessage, { lang: "ar", samples: { count: "0" } })).toBe("No items")
    expect(renderContent(storedZeroMessage, { lang: "lv", samples: { count: "11" } })).toBe("No items")
    expect(renderContent(storedZeroMessage, { lang: "lv", plural: { variable: "count", category: "zero" } })).toBe("No items")
    expect(renderContent(storedZeroMessage, { lang: "fr", samples: { count: "0" } })).toBe("No items")
    const files = message(plural("n", [["one", [{ text: "# fichier" }]], ["other", [{ text: "# fichiers" }]]]))
    expect(renderContent(files, { lang: "fr", samples: { n: "0" } })).toBe("0 fichier")
  })

  it("treats a two form as =2 and lets an =N form win over the zero form for the same count", () => {
    const twos = message(plural("n", [["two", [{ text: "a pair" }]], ["other", [{ text: "# shoes" }]]]))
    expect(renderContent(twos, { lang: "de", samples: { n: "2" } })).toBe("a pair")
    expect(renderContent(twos, { lang: "de", plural: { variable: "n", category: "two" } })).toBe("a pair")
    expect(renderContent(twos, { lang: "de" })).toBe("0 shoes")
    const both = message(plural("n", [["zero", [{ text: "zero form" }]], ["=0", [{ text: "exact form" }]], ["other", [{ text: "#" }]]]))
    expect(renderContent(both, { lang: "en", samples: { n: "0" } })).toBe("exact form")
  })

  it("ignores a picked zero form the block doesn't have", () => {
    const files = message(plural("n", [["one", [{ text: "# file" }]], ["other", [{ text: "# files" }]]]))
    expect(renderContent(files, { lang: "en", plural: { variable: "n", category: "zero" } })).toBe("0 files")
    expect(renderContent(files, { lang: "en", samples: { n: "4" }, plural: { variable: "n", category: "zero" } })).toBe("4 files")
  })
})

describe("exactCountOf and choiceCount", () => {
  it("reads =N selectors and zero / one / two the language lacks", () => {
    expect(exactCountOf("=0", "en")).toBe(0)
    expect(exactCountOf("=12", "pl")).toBe(12)
    expect(exactCountOf("=", "en")).toBeNull()
    expect(exactCountOf("=x", "en")).toBeNull()
    expect(exactCountOf("zero", "en")).toBe(0)
    expect(exactCountOf("one", "ja")).toBe(1)
    expect(exactCountOf("two", "de")).toBe(2)
    expect(exactCountOf("zero", "ar")).toBeNull()
    expect(exactCountOf("one", "en")).toBeNull()
    expect(exactCountOf("few", "en")).toBeNull()
    expect(exactCountOf("other", "en")).toBeNull()
    expect(exactCountOf("constructor", "en")).toBeNull()
  })

  it("gives the count each pick shows, skipping counts an exact form claims", () => {
    const shape = { selectors: ["zero", "one", "other"], offset: 0 }
    expect(choiceCount("en", shape, "zero")).toBe(0)
    expect(choiceCount("en", shape, "one")).toBe(1)
    expect(choiceCount("en", shape, "other")).toBe(2)
    expect(choiceCount("en", shape, "few")).toBeNull()
    expect(choiceCount("en", { selectors: ["one", "other"], offset: 0 }, "zero")).toBeNull()
    expect(choiceCount("en", NO_PLURAL_SHAPE, "other")).toBe(0)
    // With an offset the category is chosen on count − offset; exact forms compare the count.
    expect(choiceCount("en", { selectors: ["=0", "=1", "one", "other"], offset: 1 }, "one")).toBe(2)
    expect(choiceCount("en", { selectors: ["=0", "=1", "one", "other"], offset: 1 }, "other")).toBe(3)
  })
})

describe("renderContent: numeric samples", () => {
  it("lets an exact =N selector matching the sample win, else the sample's category", () => {
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "0" } })).toBe("You have no items")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "1" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: " 5 " } })).toBe("You have 5 items")
    expect(renderContent(polishFiles, { lang: "pl", samples: { n: "22" } })).toBe("22 pliki")
    expect(renderContent(polishFiles, { lang: "pl", samples: { n: "25" } })).toBe("25 plików")
  })

  it("formats # for the language and handles fractions", () => {
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "1000" } })).toBe("You have 1,000 items")
    expect(renderContent(itemsMessage, { lang: "de", samples: { count: "1000" } })).toBe("You have 1.000 items")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "1.5" } })).toBe("You have 1.5 items")
  })

  it("treats a sample that is not a number as no sample", () => {
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "many" } })).toBe("You have 2 items")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: " " } })).toBe("You have 2 items")
  })

  it("subtracts the offset for # and the category, but not for exact forms", () => {
    expect(renderContent(guestsMessage, { lang: "en", samples: { guests: "0" } })).toBe("Nobody")
    expect(renderContent(guestsMessage, { lang: "en", samples: { guests: "1" } })).toBe("Just you")
    expect(renderContent(guestsMessage, { lang: "en", samples: { guests: "2" } })).toBe("You and 1 other")
    expect(renderContent(guestsMessage, { lang: "en", samples: { guests: "4" } })).toBe("You and 3 others")
    expect(renderContent(guestsMessage, { lang: "en", plural: { variable: "guests", category: "one" } })).toBe("You and 1 other")
    expect(renderContent(guestsMessage, { lang: "en" })).toBe("You and 2 others")
  })
})

describe("renderContent: # and arguments of plural variables", () => {
  it("keeps # literal outside plural forms, inside select forms uses the enclosing plural, nested plurals their own", () => {
    const content = message(
      { text: "#1: " },
      plural("count", [
        ["other", [{ text: "# files in " }, plural("folders", [["one", [{ text: "# folder" }]], ["other", [{ text: "# folders" }]]]), select("kind", [["other", " (#)"]])]],
      ]),
    )
    expect(renderContent(content, { lang: "en", samples: { count: "3", folders: "1" } })).toBe("#1: 3 files in 1 folder (3)")
  })

  it("shows a plural variable's count in its arguments, or the sample as typed", () => {
    const content = message({ arg: { name: "count" } }, { text: " · " }, plural("count", [["one", [{ text: "# file" }]], ["other", [{ text: "# files" }]]]))
    expect(renderContent(content, { lang: "en" })).toBe("0 · 0 files")
    expect(renderContent(content, { lang: "en", plural: { variable: "count", category: "one" } })).toBe("1 · 1 file")
    expect(renderContent(content, { lang: "en", samples: { count: "1000" } })).toBe("1000 · 1,000 files")
  })

  it("gives every block of one variable the same count", () => {
    const content = message(
      plural("n", [["one", [{ text: "# item" }]], ["other", [{ text: "# items" }]]]),
      { text: ", " },
      plural("n", [["one", [{ text: "# left" }]], ["other", [{ text: "# left over" }]]], 1),
    )
    expect(renderContent(content, { lang: "en", samples: { n: "2" } })).toBe("2 items, 1 left")
    expect(renderContent(content, { lang: "en", plural: { variable: "n", category: "one" } })).toBe("1 item, 0 left over")
  })
})

describe("renderContent: language lookup", () => {
  it("uses the base language's rules for regional and underscore codes", () => {
    const russian = message(plural("n", [["one", [{ text: "# файл" }]], ["few", [{ text: "# файла" }]], ["many", [{ text: "# файлов" }]], ["other", [{ text: "# файла" }]]]))
    expect(renderContent(russian, { lang: "ru-RU", samples: { n: "21" } })).toBe("21 файл")
    expect(renderContent(polishFiles, { lang: "pl_PL", plural: { variable: "n", category: "few" } })).toBe("2 pliki")
    expect(renderContent(itemsMessage, { lang: "de-AT", plural: { variable: "count", category: "one" } })).toBe("You have 1 item")
  })

  it("has only the other form for a language without rules, where a one form stands for exactly 1", () => {
    expect(renderContent(itemsMessage, { lang: "xx", samples: { count: "3" } })).toBe("You have 3 items")
    expect(renderContent(itemsMessage, { lang: "xx", samples: { count: "1" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "xx", plural: { variable: "count", category: "one" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "xx" })).toBe("You have 2 items")
    const files = message(plural("n", [["one", [{ text: "# file" }]], ["other", [{ text: "# files" }]]]))
    expect(renderContent(files, { lang: "xx", plural: { variable: "n", category: "few" } })).toBe("0 files")
  })
})

describe("plural helpers", () => {
  it("finds the smallest count per category, past 200 and in fractions when needed", () => {
    expect(sampleCountFor("en", "one")).toBe(1)
    expect(sampleCountFor("en", "other")).toBe(0)
    expect(sampleCountFor("en", "few")).toBeNull()
    expect(sampleCountFor("ar", "zero")).toBe(0)
    expect(sampleCountFor("ar", "many")).toBe(11)
    expect(sampleCountFor("pl", "many")).toBe(0)
    expect(sampleCountFor("ru", "other")).toBe(0.5)
    expect(sampleCountFor("cs", "many")).toBe(0.5)
    expect(sampleCountFor("fr", "many")).toBe(1000000)
    expect(sampleCountFor("xx", "other")).toBe(0)
  })

  it("skips counts on request and falls back to the smallest when all are skipped", () => {
    expect(sampleCountFor("en", "other", (n) => n === 0)).toBe(2)
    expect(sampleCountFor("en", "one", (n) => n === 1)).toBe(1)
  })

  it("lists categories in CLDR order; a language without rules has only other", () => {
    expect(pluralCategories("en")).toEqual(["one", "other"])
    expect(pluralCategories("pl")).toEqual(["one", "few", "many", "other"])
    expect(pluralCategories("ar")).toEqual(["zero", "one", "two", "few", "many", "other"])
    expect(pluralCategories("xx")).toEqual(["other"])
    expect(pluralCategories("not a tag!")).toEqual(["other"])
    expect(pluralCategory("xx", 1)).toBe("other")
  })

  it("formats counts for the language", () => {
    expect(formatCount("en", 1000)).toBe("1,000")
    expect(formatCount("de", 1000)).toBe("1.000")
    expect(formatCount("ru", 0.5)).toBe("0,5")
    expect(formatCount("xx", 1000)).toBe("1000")
  })

  it("lists placeholder names once, in order", () => {
    expect(placeholderNames("{{b}} and {{a}} and {{b}}")).toEqual(["b", "a"])
    expect(placeholderNames("none")).toEqual([])
  })

  it("lists only the references the server creates placeholders for (D9)", () => {
    expect(placeholderNames("{{ amount }} {{user.name}} {{2x}} {{_total}} {{a-b}}")).toEqual(["_total"])
  })
})

describe("language lookup like the server (domain.LanguageLookupKeys)", () => {
  it("normalises separators, case and deprecated subtags, then falls back", () => {
    expect(languageLookupTags("de-AT")).toEqual(["de-AT", "de"])
    expect(languageLookupTags("de_at")).toEqual(["de-AT", "de"])
    expect(languageLookupTags("DE")).toEqual(["de"])
    expect(languageLookupTags("es-419")).toEqual(["es-419", "es"])
    expect(languageLookupTags("zh-hant")).toEqual(["zh-Hant", "zh"])
    expect(languageLookupTags("sr-Latn-RS")).toEqual(["sr-Latn-RS", "sr-Latn", "sr-RS", "sr"])
    expect(languageLookupTags("kok_Latn_IN")).toEqual(["kok-Latn-IN", "kok-Latn", "kok-IN", "kok"])
    expect(languageLookupTags("iw")).toEqual(["he"])
    expect(languageLookupTags("in-ID")).toEqual(["id-ID", "id"])
    expect(languageLookupTags("mo")).toEqual(["ro"])
    expect(languageLookupTags("my-BU")).toEqual(["my-MM", "my"])
  })

  it("rejects codes the server rejects", () => {
    for (const code of ["", "e", "en-US-POSIX", "en--US", "en-Latn-US-x", "1en", "en-USA1", "en-Latn-Latn"]) {
      expect(languageLookupTags(code)).toEqual([])
    }
    expect(pluralLocale("en-US-POSIX")).toBeNull()
    expect(pluralLocale("xx-AT")).toBeNull()
    expect(pluralLocale("de_AT")).toBe("de-AT")
  })
})

describe("agreement with the server's plural rules", () => {
  const letters: Record<string, string> = { z: "zero", o: "one", t: "two", f: "few", m: "many", x: "other" }

  it.each(SERVER_PLURAL_VECTORS.map((vector) => [vector.code, vector] as const))("%s", (code, vector) => {
    if (vector.categories === null || vector.integers === null) {
      expect(pluralCategories(code)).toEqual(["other"])
      expect(SERVER_PLURAL_SAMPLES.map((n) => pluralCategory(code, n)).every((category) => category === "other")).toBe(true)
      return
    }
    const serverCategories = vector.categories.slice().sort((a, b) => PLURAL_CATEGORY_ORDER.indexOf(a) - PLURAL_CATEGORY_ORDER.indexOf(b))
    expect(pluralCategories(code)).toEqual(serverCategories)
    const expected = Array.from(vector.integers).map((letter) => letters[letter])
    expect(SERVER_PLURAL_SAMPLES.map((n) => pluralCategory(code, n))).toEqual(expected)
  })
})
