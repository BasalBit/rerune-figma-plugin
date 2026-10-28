import { describe, expect, it } from "vitest"
import {
  androidResourceName,
  argumentNames,
  CODEGEN_PLATFORMS,
  codegenCode,
  commentLine,
  DEFAULT_PLATFORM,
  escapeJs,
  escapeKotlin,
  escapeSwift,
  isCodegenPlatform,
  isDartIdentifier,
  MORE_KEYS_LINE,
  platformInfo,
  snippetLines,
  snippetText,
  UNCACHED_NOTE,
  type CodegenPlatform,
} from "./snippets"

const PAY = { name: "checkout_pay_button", placeholders: [] }
const GREETING = { name: "greeting", placeholders: ["a", "b"] }

describe("platforms", () => {
  it("maps every codegen language to its CodegenResult language", () => {
    expect(CODEGEN_PLATFORMS.map((platform) => [platform.value, platform.language])).toEqual([
      ["react-i18next", "TYPESCRIPT"],
      ["flutter", "PLAINTEXT"],
      ["android", "KOTLIN"],
      ["ios", "SWIFT"],
      ["angular", "HTML"],
    ])
    expect(platformInfo("ios").label).toBe("iOS")
    expect(DEFAULT_PLATFORM).toBe("react-i18next")
  })

  it("recognises only the five platform values", () => {
    for (const platform of CODEGEN_PLATFORMS) {
      expect(isCodegenPlatform(platform.value)).toBe(true)
    }
    for (const value of ["rerune-diagnostics", "react", "", null, undefined, 3]) {
      expect(isCodegenPlatform(value)).toBe(false)
    }
  })
})

// §7.17 snippet table, verbatim.
describe("snippetLines (§7.17 table)", () => {
  const table: [CodegenPlatform, string[], string[]][] = [
    ["react-i18next", ["t('checkout_pay_button')"], ["t('greeting', { a, b })"]],
    ["flutter", ["AppLocalizations.of(context)!.checkout_pay_button"], ["AppLocalizations.of(context)!.greeting(a, b)"]],
    [
      "android",
      ["stringResource(R.string.checkout_pay_button)", "// Views: getString(R.string.checkout_pay_button)"],
      ["stringResource(R.string.greeting, a, b)"],
    ],
    [
      "ios",
      ['Text(NSLocalizedString("checkout_pay_button", comment: ""))', '// UIKit: NSLocalizedString("checkout_pay_button", comment: "")'],
      ['String(format: NSLocalizedString("greeting", comment: ""), a, b)'],
    ],
    [
      "angular",
      ["{{ 'checkout_pay_button' | translate }}", "<!-- Transloco: {{ 'checkout_pay_button' | transloco }} -->"],
      ["{{ 'greeting' | translate: { a: a, b: b } }}"],
    ],
  ]

  it.each(table)("%s without and with placeholders", (platform, plain, withPlaceholders) => {
    expect(snippetLines(platform, PAY)).toEqual(plain)
    expect(snippetLines(platform, GREETING)).toEqual(withPlaceholders)
    expect(snippetText(platform, PAY)).toBe(plain.join("\n"))
  })

  it("keeps the placeholders in ReRune order", () => {
    const key = { name: "summary", placeholders: ["count", "amount", "name"] }
    expect(snippetText("react-i18next", key)).toBe("t('summary', { count, amount, name })")
    expect(snippetText("flutter", key)).toBe("AppLocalizations.of(context)!.summary(count, amount, name)")
    expect(snippetText("android", key)).toBe("stringResource(R.string.summary, count, amount, name)")
    expect(snippetText("ios", key)).toBe('String(format: NSLocalizedString("summary", comment: ""), count, amount, name)')
    expect(snippetText("angular", key)).toBe("{{ 'summary' | translate: { count: count, amount: amount, name: name } }}")
  })
})

describe("escaping", () => {
  it("escapes ' and \\ in JavaScript and Angular strings", () => {
    expect(escapeJs("it's\\here")).toBe("it\\'s\\\\here")
    expect(snippetText("react-i18next", { name: "it's", placeholders: [] })).toBe("t('it\\'s')")
    expect(snippetText("react-i18next", { name: "a\\b", placeholders: ["x"] })).toBe("t('a\\\\b', { x })")
    expect(snippetLines("angular", { name: "it's", placeholders: [] })).toEqual([
      "{{ 'it\\'s' | translate }}",
      "<!-- Transloco: {{ 'it\\'s' | transloco }} -->",
    ])
    expect(snippetText("angular", { name: "a\\b", placeholders: ["x"] })).toBe("{{ 'a\\\\b' | translate: { x: x } }}")
  })

  it("leaves double quotes alone in single-quoted strings", () => {
    expect(snippetText("react-i18next", { name: 'say "hi"', placeholders: [] })).toBe("t('say \"hi\"')")
  })

  it('escapes " and \\ in Swift and Kotlin strings', () => {
    expect(escapeSwift('say "hi" \\o/')).toBe('say \\"hi\\" \\\\o/')
    expect(escapeKotlin('say "hi" \\o/')).toBe('say \\"hi\\" \\\\o/')
    expect(snippetLines("ios", { name: 'say "hi"', placeholders: [] })).toEqual([
      'Text(NSLocalizedString("say \\"hi\\"", comment: ""))',
      '// UIKit: NSLocalizedString("say \\"hi\\"", comment: "")',
    ])
    expect(snippetText("ios", { name: "a\\b", placeholders: ["n"] })).toBe('String(format: NSLocalizedString("a\\\\b", comment: ""), n)')
    expect(snippetText("ios", { name: "it's", placeholders: [] })).toContain('NSLocalizedString("it\'s", comment: "")')
  })

  it("keeps every snippet on its lines when a key contains line breaks or control characters", () => {
    const key = { name: "line\nbreak\ttab\r" + String.fromCharCode(0x2028) + String.fromCharCode(1), placeholders: [] }
    expect(escapeJs(key.name)).toBe("line\\nbreak\\ttab\\r\\u2028\\u0001")
    expect(escapeKotlin(key.name)).toBe("line\\nbreak\\ttab\\r\\u2028\\u0001")
    expect(escapeSwift(key.name)).toBe("line\\nbreak\\ttab\\r\\u{2028}\\u{1}")
    for (const platform of CODEGEN_PLATFORMS) {
      const lines = snippetLines(platform.value, key)
      for (const line of lines) {
        expect(line).not.toMatch(/[\n\r]/)
        expect(line.includes(String.fromCharCode(0x2028))).toBe(false)
      }
    }
  })

  it("keeps non-ASCII key names as they are", () => {
    expect(snippetText("react-i18next", { name: "größe_€_😀", placeholders: [] })).toBe("t('größe_€_😀')")
    expect(snippetLines("ios", { name: "größe", placeholders: [] })[0]).toBe('Text(NSLocalizedString("größe", comment: ""))')
  })
})

describe("Android resource names", () => {
  it("maps . to _ (D21)", () => {
    expect(androidResourceName("checkout.pay_button")).toBe("checkout_pay_button")
    expect(snippetLines("android", { name: "checkout.pay.button", placeholders: [] })).toEqual([
      "stringResource(R.string.checkout_pay_button)",
      "// Views: getString(R.string.checkout_pay_button)",
    ])
    expect(snippetText("android", { name: "checkout.title", placeholders: ["n"] })).toBe("stringResource(R.string.checkout_title, n)")
  })

  it.each(["checkout-pay", "checkout/pay", "checkout:pay", "1st_screen", "pay now", "größe", ""])("says %j is not a valid resource name", (name) => {
    expect(androidResourceName(name)).toBeNull()
    expect(snippetLines("android", { name, placeholders: ["a"] })).toEqual(['// "' + name + '" is not a valid Android resource name'])
  })

  it("accepts identifiers with upper case, digits and a leading underscore", () => {
    expect(androidResourceName("CheckoutTitle2")).toBe("CheckoutTitle2")
    expect(androidResourceName("_private")).toBe("_private")
    expect(androidResourceName(".hidden")).toBe("_hidden")
  })

  it("escapes the key inside the comment", () => {
    expect(snippetLines("android", { name: 'a"b\\c\nd', placeholders: [] })).toEqual(['// "a\\"b\\\\c\\nd" is not a valid Android resource name'])
  })

  it.each(["continue", "new", "default", "class", "switch", "return", "int", "true", "null", "_", "__", "_.__"])(
    "says the Java keyword, literal or underscore name %j is not a valid resource name (aapt2 refuses it)",
    (name) => {
      expect(androidResourceName(name)).toBeNull()
      expect(snippetLines("android", { name, placeholders: [] })).toEqual(['// "' + name + '" is not a valid Android resource name'])
    },
  )

  it("escapes Kotlin keywords that Java allows with backticks", () => {
    expect(androidResourceName("fun")).toBe("fun")
    expect(snippetLines("android", { name: "fun", placeholders: [] })).toEqual(["stringResource(R.string.`fun`)", "// Views: getString(R.string.`fun`)"])
    expect(snippetText("android", { name: "when", placeholders: ["in"] })).toBe("stringResource(R.string.`when`, in_)")
    expect(snippetText("android", { name: "continue_button", placeholders: [] })).toBe("stringResource(R.string.continue_button)\n// Views: getString(R.string.continue_button)")
  })
})

describe("Flutter identifiers", () => {
  it.each(["checkout_pay_button", "checkoutPayButton", "a", "x2_Y"])("uses %s as the getter", (name) => {
    expect(isDartIdentifier(name)).toBe(true)
    expect(snippetText("flutter", { name, placeholders: [] })).toBe("AppLocalizations.of(context)!." + name)
  })

  it.each(["CheckoutPayButton", "checkout.pay", "checkout-pay", "_private", "1st", "pay now", "größe", ""])("says %j is not a valid Dart identifier", (name) => {
    expect(isDartIdentifier(name)).toBe(false)
    expect(snippetLines("flutter", { name, placeholders: ["a"] })).toEqual(['// "' + name + '" is not a valid Dart identifier; rename the key for Flutter'])
  })

  it("escapes the key inside the comment", () => {
    expect(snippetText("flutter", { name: 'a"b', placeholders: [] })).toBe('// "a\\"b" is not a valid Dart identifier; rename the key for Flutter')
  })

  it.each(["continue", "new", "default", "class", "switch", "return", "null", "true"])("says the reserved word %j is not a valid Dart identifier", (name) => {
    expect(isDartIdentifier(name)).toBe(false)
    expect(snippetLines("flutter", { name, placeholders: [] })).toEqual(['// "' + name + '" is not a valid Dart identifier; rename the key for Flutter'])
  })

  it("keeps keys that only contain a reserved word", () => {
    expect(snippetText("flutter", { name: "continue_button", placeholders: [] })).toBe("AppLocalizations.of(context)!.continue_button")
    expect(snippetText("flutter", { name: "newItems", placeholders: ["count"] })).toBe("AppLocalizations.of(context)!.newItems(count)")
  })
})

describe("argumentNames", () => {
  it("uses ReRune placeholder names as they are", () => {
    expect(argumentNames(["count", "_x", "userName2"], "react-i18next").map((entry) => entry.argument)).toEqual(["count", "_x", "userName2"])
  })

  it("renames placeholders that are reserved words of the platform", () => {
    const names = ["class", "default", "in", "is", "fun", "new", "self", "undefined", "_", "name"]
    const argumentsOf = (platform: CodegenPlatform) => argumentNames(names, platform).map((entry) => entry.argument)
    expect(argumentsOf("react-i18next")).toEqual(["class_", "default_", "in_", "is", "fun", "new_", "self", "undefined", "_", "name"])
    expect(argumentsOf("angular")).toEqual(["class_", "default_", "in_", "is", "fun", "new_", "self", "undefined_", "_", "name"])
    expect(argumentsOf("android")).toEqual(["class_", "default", "in_", "is_", "fun_", "new", "self", "undefined", "arg9", "name"])
    expect(argumentsOf("ios")).toEqual(["class_", "default_", "in_", "is_", "fun", "new", "self_", "undefined", "__", "name"])
    expect(argumentsOf("flutter")).toEqual(["class_", "default_", "in_", "is_", "fun", "new_", "self", "undefined", "__", "name"])
    expect(argumentNames(["__"], "android").map((entry) => entry.argument)).toEqual(["arg1"])
    expect(argumentNames(["class_", "class"], "react-i18next").map((entry) => entry.argument)).toEqual(["class_", "class_2"])
  })

  it("writes snippets with reserved-word placeholders that compile (class, default)", () => {
    const key = { name: "greeting", placeholders: ["class", "default"] }
    const react = snippetText("react-i18next", key)
    expect(react).toBe("t('greeting', { class: class_, default: default_ })")
    // Parses as JavaScript (the shorthand `{ class, default }` is a SyntaxError).
    expect(() => new Function("t", "class_", "default_", "return " + react)).not.toThrow()
    expect(() => new Function("t", "return t('greeting', { class, default })")).toThrow(SyntaxError)
    expect(snippetText("angular", key)).toBe("{{ 'greeting' | translate: { class: class_, default: default_ } }}")
    expect(snippetText("android", key)).toBe("stringResource(R.string.greeting, class_, default)")
    expect(snippetText("android", { name: "greeting", placeholders: ["in", "is", "fun"] })).toBe("stringResource(R.string.greeting, in_, is_, fun_)")
    expect(snippetText("ios", key)).toBe('String(format: NSLocalizedString("greeting", comment: ""), class_, default_)')
    expect(snippetText("flutter", key)).toBe("AppLocalizations.of(context)!.greeting(class_, default_)")
  })

  it("turns names that are not identifiers into variables and quotes them as object keys", () => {
    const args = argumentNames(["user.name", "2nd", "-", "a b"], "react-i18next")
    expect(args.map((entry) => entry.argument)).toEqual(["user_name", "_2nd", "arg3", "a_b"])
    expect(snippetText("react-i18next", { name: "x", placeholders: ["user.name", "count"] })).toBe("t('x', { 'user.name': user_name, count })")
    expect(snippetText("angular", { name: "x", placeholders: ["it's"] })).toBe("{{ 'x' | translate: { 'it\\'s': it_s } }}")
    expect(snippetText("flutter", { name: "x", placeholders: ["user.name"] })).toBe("AppLocalizations.of(context)!.x(user_name)")
  })

  it("drops repeated names and numbers clashing variables", () => {
    expect(argumentNames(["a", "a", "b"], "ios").map((entry) => entry.argument)).toEqual(["a", "b"])
    const clash = argumentNames(["a-b", "a_b"], "react-i18next")
    expect(clash.map((entry) => entry.argument)).toEqual(["a_b", "a_b2"])
    expect(snippetText("react-i18next", { name: "x", placeholders: ["a-b", "a_b"] })).toBe("t('x', { 'a-b': a_b, a_b: a_b2 })")
  })
})

describe("commentLine", () => {
  it("uses the platform's comment syntax on one line", () => {
    expect(commentLine("react-i18next", "Pay\n  now")).toBe("// Pay now")
    expect(commentLine("flutter", "Pay now")).toBe("// Pay now")
    expect(commentLine("android", "Pay now")).toBe("// Pay now")
    expect(commentLine("ios", "Pay now")).toBe("// Pay now")
    expect(commentLine("angular", "Pay now")).toBe("<!-- Pay now -->")
  })

  it("never ends an HTML comment early", () => {
    expect(commentLine("angular", "a --> b --!> c")).toBe("<!-- a - -> b - -!> c -->")
    expect(snippetLines("angular", { name: "a-->b", placeholders: [] })[1]).toBe("<!-- Transloco: {{ 'a- ->b' | transloco }} -->")
  })
})

describe("codegenCode", () => {
  const keys = [
    { name: "checkout_pay_button", placeholders: [], sourceText: "Pay\nnow" },
    { name: "greeting", placeholders: ["name"], sourceText: null },
  ]

  it("puts the cached source text above each snippet and separates keys with a blank line", () => {
    expect(codegenCode("react-i18next", keys, { more: false, uncached: false })).toBe(
      "// Pay now\nt('checkout_pay_button')\n\nt('greeting', { name })",
    )
    expect(codegenCode("android", keys, { more: false, uncached: false })).toBe(
      "// Pay now\nstringResource(R.string.checkout_pay_button)\n// Views: getString(R.string.checkout_pay_button)\n\nstringResource(R.string.greeting, name)",
    )
    expect(codegenCode("angular", keys.slice(0, 1), { more: false, uncached: false })).toBe(
      "<!-- Pay now -->\n{{ 'checkout_pay_button' | translate }}\n<!-- Transloco: {{ 'checkout_pay_button' | transloco }} -->",
    )
  })

  it("skips an empty source text", () => {
    expect(codegenCode("ios", [{ name: "x", placeholders: [], sourceText: "  " }], { more: false, uncached: false })).toBe(
      'Text(NSLocalizedString("x", comment: ""))\n// UIKit: NSLocalizedString("x", comment: "")',
    )
  })

  it("ends with the More keys and uncached notes as comments", () => {
    expect(codegenCode("flutter", keys.slice(1), { more: true, uncached: true })).toBe(
      "AppLocalizations.of(context)!.greeting(name)\n\n// " + MORE_KEYS_LINE + "\n// " + UNCACHED_NOTE,
    )
    expect(codegenCode("angular", [], { more: true, uncached: false })).toBe("<!-- " + MORE_KEYS_LINE + " -->")
  })
})
