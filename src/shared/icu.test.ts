import { describe, expect, it } from "vitest"
import type { MessagePart, TranslationContent, VariantBlock } from "./api-types"
import { placeholderNames, pluralCategories, renderContent, sampleCountFor } from "./icu"

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

const itemsMessage = message(
  { text: "You have " },
  plural("count", [
    ["=0", [{ text: "no items" }]],
    ["one", [{ text: "# item" }]],
    ["other", [{ text: "# items" }]],
  ]),
)

describe("renderContent: plain values", () => {
  it("returns plain text and an empty string for missing content", () => {
    expect(renderContent({ value: "Pay now" }, { lang: "en" })).toBe("Pay now")
    expect(renderContent(null, { lang: "en" })).toBe("")
  })

  it("shows [name] for placeholders without a sample", () => {
    expect(renderContent({ value: "Hi {{name}}, pay {{ amount }}" }, { lang: "en" })).toBe("Hi [name], pay [amount]")
  })

  it("uses samples when given", () => {
    expect(renderContent({ value: "Hi {{name}}" }, { lang: "en", samples: { name: "Ada" } })).toBe("Hi Ada")
  })
})

describe("renderContent: messages", () => {
  it("renders text and args", () => {
    const content = message({ text: "Hi " }, { arg: { name: "name" } }, { text: "!" })
    expect(renderContent(content, { lang: "en" })).toBe("Hi [name]!")
    expect(renderContent(content, { lang: "en", samples: { name: "Ada" } })).toBe("Hi Ada!")
  })

  it("defaults to the other form with the smallest matching count", () => {
    expect(renderContent(itemsMessage, { lang: "en" })).toBe("You have 0 items")
  })

  it("renders the chosen plural category", () => {
    expect(renderContent(itemsMessage, { lang: "en", plural: { variable: "count", category: "one" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "en", plural: { variable: "other", category: "one" } })).toBe("You have 0 items")
  })

  it("lets an exact =N selector matching the sample count win", () => {
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "0" } })).toBe("You have no items")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "1" } })).toBe("You have 1 item")
    expect(renderContent(itemsMessage, { lang: "en", samples: { count: "5" } })).toBe("You have 5 items")
  })

  it("uses the language's plural categories", () => {
    const content = message(
      plural("n", [
        ["one", [{ text: "# plik" }]],
        ["few", [{ text: "# pliki" }]],
        ["many", [{ text: "# plików" }]],
        ["other", [{ text: "# pliku" }]],
      ]),
    )
    expect(renderContent(content, { lang: "pl", plural: { variable: "n", category: "few" } })).toBe("2 pliki")
    expect(renderContent(content, { lang: "pl", plural: { variable: "n", category: "many" } })).toBe("0 plików")
    expect(renderContent(content, { lang: "pl", samples: { n: "22" } })).toBe("22 pliki")
  })

  it("subtracts the offset for # and category selection", () => {
    const content = message(
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
    expect(renderContent(content, { lang: "en", samples: { guests: "2" } })).toBe("You and 1 other")
    expect(renderContent(content, { lang: "en", samples: { guests: "1" } })).toBe("Just you")
    expect(renderContent(content, { lang: "en", samples: { guests: "4" } })).toBe("You and 3 others")
    expect(renderContent(content, { lang: "en", plural: { variable: "guests", category: "one" } })).toBe("You and 1 other")
  })

  it("selects select/choice forms by sample, else other, else the first form", () => {
    const select = (selector: string, forms: [string, string][]): TranslationContent =>
      message({
        variant: { kind: "select", variable: selector, forms: forms.map(([sel, text], order) => ({ selector: sel, parts: [{ text }], order })) },
      })
    const gender = select("gender", [
      ["female", "She"],
      ["male", "He"],
      ["other", "They"],
    ])
    expect(renderContent(gender, { lang: "en", samples: { gender: "female" } })).toBe("She")
    expect(renderContent(gender, { lang: "en", samples: { gender: "robot" } })).toBe("They")
    expect(renderContent(gender, { lang: "en" })).toBe("They")
    expect(renderContent(select("x", [["a", "A"], ["b", "B"]]), { lang: "en" })).toBe("A")
  })

  it("keeps # literal outside plural forms and uses the inner plural for nested ones", () => {
    const content = message(
      { text: "#1: " },
      plural("count", [
        ["other", [{ text: "# files in " }, plural("folders", [["one", [{ text: "# folder" }]], ["other", [{ text: "# folders" }]]])]],
      ]),
    )
    expect(renderContent(content, { lang: "en", samples: { count: "3", folders: "1" } })).toBe("#1: 3 files in 1 folder")
  })

  it("orders forms by their order field", () => {
    const block: VariantBlock = {
      kind: "select",
      variable: "x",
      forms: [
        { selector: "b", parts: [{ text: "B" }], order: 1 },
        { selector: "a", parts: [{ text: "A" }], order: 0 },
      ],
    }
    expect(renderContent(message({ variant: block }), { lang: "en" })).toBe("A")
  })

  it("renders an empty variant as nothing", () => {
    expect(renderContent(message({ text: "x" }, { variant: { kind: "plural", variable: "n", forms: [] } }), { lang: "en" })).toBe("x")
  })
})

describe("plural helpers", () => {
  it("finds the smallest sample count per category", () => {
    expect(sampleCountFor("en", "one")).toBe(1)
    expect(sampleCountFor("en", "other")).toBe(0)
    expect(sampleCountFor("en", "few")).toBeNull()
    expect(sampleCountFor("ar", "zero")).toBe(0)
  })

  it("lists categories and falls back to English for invalid tags", () => {
    expect(pluralCategories("en").sort()).toEqual(["one", "other"])
    expect(pluralCategories("not a tag!").sort()).toEqual(["one", "other"])
  })

  it("lists placeholder names once, in order", () => {
    expect(placeholderNames("{{b}} and {{a}} and {{ b }}")).toEqual(["b", "a"])
    expect(placeholderNames("none")).toEqual([])
  })
})
