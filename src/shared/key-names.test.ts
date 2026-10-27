import { describe, expect, it } from "vitest"
import { scannedNode } from "../../test/fixtures"
import {
  classifyKeyName,
  createKeyNameSuggester,
  detectCaseStyle,
  isDefaultLayerName,
  isValidServerKeyName,
  KEY_NAME_ISSUES,
  KEY_NAME_WARNINGS,
  keyNameIssues,
  keyNameWarnings,
  nameSourceOf,
  nameWords,
  resolveCaseStyle,
  suggestKeyName,
  uniqueKeyName,
  type NameSource,
  type ResolvedCaseStyle,
} from "./key-names"

function source(frameName: string | null, layerName: string, overrides: Partial<NameSource> = {}): NameSource {
  return { pageName: "", frameName, layerName, autoRename: false, text: "", componentName: null, ...overrides }
}

function suggestFor(sample: string[], src: NameSource, template: string | null = null): string {
  const style = detectCaseStyle(sample)
  return createKeyNameSuggester({ style, template, taken: sample }).suggest(src)
}

describe("key-name suggestions (Appendix A.5)", () => {
  it.each([
    [[], source("Checkout", "Pay button", { text: "Pay now" }), null, "checkout_pay_button"],
    [[], source("Checkout", "Pay now", { autoRename: true, text: "Pay now" }), null, "checkout_pay_now"],
    [[], source("Checkout", "Text", { text: "Pay now" }), null, "checkout_pay_now"],
    [["home.title", "home.subTitle", "profile.saveButton", "cart.checkoutLabel"], source("Checkout", "Pay button"), null, "checkout.payButton"],
    [["homeTitle", "homeSubtitle", "profileSaveButton"], source("Checkout", "Pay button"), null, "checkoutPayButton"],
    [["home-title", "home-subtitle", "profile-save"], source("Checkout", "Pay button"), null, "checkout-pay-button"],
    [["HOME_TITLE", "HOME_SUBTITLE", "PROFILE_SAVE"], source("Checkout", "Pay button"), null, "CHECKOUT_PAY_BUTTON"],
    [["a", "b", "Title Case Key"], source("Checkout", "Pay button"), null, "checkout_pay_button"],
    [[], source("1. Sign up / Step 2", "Title"), null, "sign_up_step_title"],
    [[], source("Übersicht", "Größe"), null, "ubersicht_grosse"],
    [[], source("購入", "購入する", { autoRename: true, text: "購入する" }), null, "screen_text"],
    [[], source("404", "Message"), null, "k_404_message"],
    [["checkout_pay_button"], source("Checkout", "Pay button"), null, "checkout_pay_button_2"],
    [[], source("Checkout", "Pay button", { pageName: "Mobile" }), "{page}.{frame}.{layer}", "mobile.checkout.pay_button"],
  ])("sample %j → %s", (sample, src, template, expected) => {
    expect(suggestFor(sample, src, template)).toBe(expected)
  })

  it("detects the styles named in the table", () => {
    expect(detectCaseStyle([])).toBe("snake")
    expect(detectCaseStyle(["home.title", "home.subTitle", "profile.saveButton", "cart.checkoutLabel"])).toBe("dot.camel")
    expect(detectCaseStyle(["a", "b", "Title Case Key"])).toBe("snake")
    expect(detectCaseStyle(["checkout_pay_button"])).toBe("snake")
  })
})

describe("classifyKeyName", () => {
  it.each([
    ["home.title", "dot.snake"],
    ["home.pay_button", "dot.snake"],
    ["home.payButton", "dot.camel"],
    ["home-page.pay-button", "dot.kebab"],
    ["home/pay_button", "slash.snake"],
    ["home_title", "snake"],
    ["homeTitle", "camel"],
    ["HomeTitle", "pascal"],
    ["home-title", "kebab"],
    ["HOME_TITLE", "screaming"],
    ["title", "other"],
    ["Title Case", "other"],
    ["Title", "other"],
  ])("%s → %s", (name, expected) => {
    expect(classifyKeyName(name)).toBe(expected)
  })
})

describe("detectCaseStyle", () => {
  it("needs at least 3 names of the dominant style", () => {
    expect(detectCaseStyle(["homeTitle", "homeSubtitle"])).toBe("snake")
  })

  it("needs at least 40 % of the classified names", () => {
    expect(detectCaseStyle(["aB", "cD", "eF", "a_b", "c_d", "e-f", "g-h"])).toBe("camel")
    expect(detectCaseStyle(["aB", "cD", "eF", "a_b", "c_d", "e-f", "g-h", "I_J"])).toBe("snake")
  })

  it("picks the most frequent style", () => {
    expect(detectCaseStyle(["aB", "cD", "eF", "a_b", "c_d", "e_f", "g_h", "i_j", "k-l", "m-n"])).toBe("snake")
    expect(detectCaseStyle(["a-b", "c-d", "e-f", "g-h", "aB", "cD", "eF"])).toBe("kebab")
  })

  it("ignores names classified as other when computing the share", () => {
    expect(detectCaseStyle(["aB", "cD", "eF", "x", "y", "z", "Title", "Some Key", "w"])).toBe("camel")
  })

  it("lets an explicit setting override auto", () => {
    expect(resolveCaseStyle("kebab", ["home_title", "home_sub", "x_y"])).toBe("kebab")
    expect(resolveCaseStyle("auto", ["home-title", "home-sub", "x-y"])).toBe("kebab")
  })
})

describe("nameWords", () => {
  it("folds accents and the special letters", () => {
    expect(nameWords("Ærø Œuvre Straße Ångström")).toEqual(["aero", "oeuvre", "strasse", "angstrom"])
  })

  it("splits camelCase and acronyms", () => {
    expect(nameWords("checkoutPayButton")).toEqual(["checkout", "pay", "button"])
    expect(nameWords("HTMLParser v2")).toEqual(["html", "parser", "v2"])
  })

  it("drops leading numeric words only when a word remains", () => {
    expect(nameWords("1. Sign up")).toEqual(["sign", "up"])
    expect(nameWords("404")).toEqual(["404"])
    expect(nameWords("2 3 4")).toEqual(["2", "3", "4"])
    expect(nameWords("Step 2")).toEqual(["step", "2"])
  })
})

describe("default layer names", () => {
  it.each([
    [{ layerName: "Text", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Text 12", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Frame 3", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Rectangle", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Group 1", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Layer", autoRename: false, text: "Pay" }, true],
    [{ layerName: "Pay now", autoRename: false, text: " Pay now\n" }, true],
    [{ layerName: "Label", autoRename: false, text: "Pay" }, false],
    [{ layerName: "Title", autoRename: false, text: "Pay" }, false],
    [{ layerName: "Text field", autoRename: false, text: "Pay" }, false],
    [{ layerName: "Label", autoRename: true, text: "Pay" }, true],
  ])("%j → %s", (input, expected) => {
    expect(isDefaultLayerName(input)).toBe(expected)
  })
})

describe("suggestKeyName", () => {
  const checkout = source("Checkout", "Pay button")

  it.each([
    ["snake", "checkout_pay_button"],
    ["camel", "checkoutPayButton"],
    ["pascal", "CheckoutPayButton"],
    ["kebab", "checkout-pay-button"],
    ["screaming", "CHECKOUT_PAY_BUTTON"],
    ["dot.snake", "checkout.pay_button"],
    ["dot.camel", "checkout.payButton"],
    ["dot.kebab", "checkout.pay-button"],
    ["slash.snake", "checkout/pay_button"],
  ] as [ResolvedCaseStyle, string][])("joins %s as %s", (style, expected) => {
    expect(suggestKeyName(checkout, { style, template: null })).toBe(expected)
  })

  it("uses the page name when there is no frame", () => {
    expect(suggestKeyName(source(null, "Title", { pageName: "Onboarding" }), { style: "snake", template: null })).toBe("onboarding_title")
  })

  it("limits screen to 3 words and element to 4 words", () => {
    const long = source("Order review and payment step", "Primary action button label text")
    expect(suggestKeyName(long, { style: "snake", template: null })).toBe("order_review_and_primary_action_button_label")
  })

  it("takes the first 4 words of the text for default names", () => {
    expect(suggestKeyName(source("Checkout", "Text", { text: "Pay now with your saved card" }), { style: "snake", template: null })).toBe(
      "checkout_pay_now_with_your",
    )
  })

  it("keeps names at 64 characters by dropping element words, then screen words", () => {
    const long = source("Supercalifragilistic expialidocious extraordinarily", "Pneumonoultramicroscopic silicovolcanoconiosis enormous label")
    const name = suggestKeyName(long, { style: "snake", template: null })
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toBe("supercalifragilistic_expialidocious_pneumonoultramicroscopic")
  })

  it("truncates a single huge word", () => {
    const name = suggestKeyName(source("x".repeat(80), "y"), { style: "snake", template: null })
    expect(name).toHaveLength(64)
    expect(isValidServerKeyName(name)).toBe(true)
  })

  it.each([
    ["snake", "k_404_message"],
    ["kebab", "k-404-message"],
    ["screaming", "K_404_MESSAGE"],
    ["camel", "k404Message"],
    ["pascal", "K404Message"],
    ["dot.snake", "k_404.message"],
  ] as [ResolvedCaseStyle, string][])("prefixes names that start with a digit (%s)", (style, expected) => {
    expect(suggestKeyName(source("404", "Message"), { style, template: null })).toBe(expected)
  })

  it("supports every template token", () => {
    const src = source("Checkout", "Pay button", { pageName: "Mobile", text: "Pay now", componentName: "Primary Button" })
    expect(suggestKeyName(src, { style: "snake", template: "{component}/{text}" })).toBe("primary_button/pay_now")
    expect(suggestKeyName(src, { style: "camel", template: "{screen}.{element}" })).toBe("checkout.payButton")
    expect(suggestKeyName(src, { style: "kebab", template: "app:{frame}:{layer}" })).toBe("app:checkout:pay-button")
  })

  it("drops empty tokens with their separators and unknown placeholders", () => {
    const src = source("Checkout", "Pay button")
    expect(suggestKeyName(src, { style: "snake", template: "{page}.{frame}.{layer}" })).toBe("checkout.pay_button")
    expect(suggestKeyName(src, { style: "snake", template: "{nope}.{frame}" })).toBe("checkout")
    expect(suggestKeyName(src, { style: "snake", template: "my app {frame}" })).toBe("myappcheckout")
  })

  it("falls back to the default join when a template renders nothing", () => {
    expect(suggestKeyName(source("Checkout", "Pay button"), { style: "snake", template: "{component}" })).toBe("checkout_pay_button")
  })

  it("always produces names that pass the server rule", () => {
    const sources = [
      source("Checkout", "Pay button"),
      source("", "", { text: "" }),
      source("…", "—", { text: "!!!" }),
      source("404", "500", { text: "42" }),
    ]
    for (const style of ["snake", "camel", "pascal", "kebab", "screaming", "dot.snake", "dot.camel", "dot.kebab", "slash.snake"] as ResolvedCaseStyle[]) {
      for (const src of sources) {
        expect(isValidServerKeyName(suggestKeyName(src, { style, template: null }))).toBe(true)
      }
    }
  })
})

describe("uniqueKeyName", () => {
  const taken = (names: string[]) => (name: string) => names.includes(name)

  it.each([
    ["snake", "a_b", ["a_b", "a_b_2"], "a_b_3"],
    ["kebab", "a-b", ["a-b"], "a-b-2"],
    ["dot.kebab", "a.b-c", ["a.b-c"], "a.b-c-2"],
    ["camel", "aB", ["aB"], "aB2"],
    ["pascal", "AB", ["AB"], "AB2"],
    ["screaming", "A_B", ["A_B"], "A_B_2"],
  ] as [ResolvedCaseStyle, string, string[], string][])("suffixes %s names", (style, base, names, expected) => {
    expect(uniqueKeyName(base, style, taken(names))).toBe(expected)
  })

  it("keeps a free name and stays within 64 characters", () => {
    expect(uniqueKeyName("free", "snake", taken([]))).toBe("free")
    const base = "a".repeat(64)
    expect(uniqueKeyName(base, "snake", taken([base]))).toBe("a".repeat(62) + "_2")
  })

  it("makes every suggestion of one suggester unique", () => {
    const suggester = createKeyNameSuggester({ style: "snake", template: null, taken: ["checkout_pay_button"] })
    const src = source("Checkout", "Pay button")
    expect([suggester.suggest(src), suggester.suggest(src)]).toEqual(["checkout_pay_button_2", "checkout_pay_button_3"])
    suggester.reserve("checkout_title")
    expect(suggester.isTaken("checkout_title")).toBe(true)
  })
})

describe("server key-name rule (Appendix A.4)", () => {
  it.each(["checkout_pay_button", "checkout.payButton", "checkout-pay-button", "Checkout/Title", "ns:key", "a", "_x", "a".repeat(200)])(
    "accepts %j",
    (name) => {
      expect(isValidServerKeyName(name)).toBe(true)
    },
  )

  it.each(["", " checkout", "checkout ", "checkout pay", "checkout.", ".checkout", "-x", "über_titel", "a{b}", "a".repeat(201)])("rejects %j", (name) => {
    expect(isValidServerKeyName(name)).toBe(false)
  })
})

describe("warnings and issues", () => {
  it("warns about platform rules without blocking", () => {
    expect(keyNameWarnings("checkout_pay_button")).toEqual([])
    expect(keyNameWarnings("checkout.payButton")).toEqual([KEY_NAME_WARNINGS.dart, KEY_NAME_WARNINGS.androidDots])
    expect(keyNameWarnings("checkoutPayButton")).toEqual([])
    expect(keyNameWarnings("checkout-pay")).toEqual([KEY_NAME_WARNINGS.dart, KEY_NAME_WARNINGS.android])
    expect(keyNameWarnings("Checkout_title")).toEqual([KEY_NAME_WARNINGS.dart])
  })

  it("lists blocking issues", () => {
    expect(keyNameIssues("ok_name", { taken: false, duplicateInBatch: false })).toEqual([])
    expect(keyNameIssues("bad name", { taken: true, duplicateInBatch: true })).toEqual([
      KEY_NAME_ISSUES.invalid,
      KEY_NAME_ISSUES.duplicate,
      KEY_NAME_ISSUES.taken,
    ])
  })
})

describe("nameSourceOf", () => {
  it("uses the original text while previewing", () => {
    const node = scannedNode("1:2", "Jetzt zahlen", { originalCharacters: "Pay now", name: "Pay now", autoRename: false, componentName: "Button" })
    expect(nameSourceOf(node)).toEqual({ pageName: "Mobile", frameName: "Checkout", layerName: "Pay now", autoRename: false, text: "Pay now", componentName: "Button" })
  })
})
