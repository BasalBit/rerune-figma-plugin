// Snippet builders for Dev Mode (§7.17, D21). Pure: used by main's codegen handler (Code section) and by the
// inspect panel in the UI, so nothing here touches `figma` or the DOM. Main targets ES2017: no Unicode property
// escapes, and characters such as U+2028 are compared by code, never written as escapes in literals.

export type CodegenPlatform = "react-i18next" | "flutter" | "android" | "ios" | "angular"

// CodegenResult.language values used here (a subset of the plugin typings' enum, which the UI cannot import).
export type SnippetLanguage = "TYPESCRIPT" | "PLAINTEXT" | "KOTLIN" | "SWIFT" | "HTML"

export interface PlatformInfo { value: CodegenPlatform; label: string; language: SnippetLanguage }

// Same values and labels as package.json `figma-plugin.codegenLanguages` (test/build-hooks.test.ts checks it).
export const CODEGEN_PLATFORMS: readonly PlatformInfo[] = [
  { value: "react-i18next", label: "React (i18next)", language: "TYPESCRIPT" },
  { value: "flutter", label: "Flutter", language: "PLAINTEXT" },
  { value: "android", label: "Android", language: "KOTLIN" },
  { value: "ios", label: "iOS", language: "SWIFT" },
  { value: "angular", label: "Angular", language: "HTML" },
]

export const DEFAULT_PLATFORM: CodegenPlatform = "react-i18next"
export const MORE_KEYS_LINE = "More keys not shown"
export const UNCACHED_NOTE = "Open ReRune in the Dev Mode inspect panel to load placeholders and texts."

export interface SnippetKey { name: string; placeholders: readonly string[] }
export interface CodegenKey extends SnippetKey { sourceText: string | null }

// ReRune's placeholder name rule (server messageformat): valid as is in every target language.
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const DART_IDENTIFIER = /^[a-z][A-Za-z0-9_]*$/
const ANDROID_RESOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const NOT_IDENTIFIER_CHAR = /[^A-Za-z0-9_]/g
const LEADING_DIGIT = /^[0-9]/
const WHITESPACE = /\s+/g

export function isCodegenPlatform(value: unknown): value is CodegenPlatform {
  return CODEGEN_PLATFORMS.some((platform) => platform.value === value)
}

export function platformInfo(platform: CodegenPlatform): PlatformInfo {
  return CODEGEN_PLATFORMS.find((info) => info.value === platform) ?? CODEGEN_PLATFORMS[0]
}

function hex(code: number, width: number): string {
  let digits = code.toString(16).toUpperCase()
  while (digits.length < width) {
    digits = "0" + digits
  }
  return digits
}

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029
}

const SHORT_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" }

// Escapes `quote` and `\`, plus line breaks and other control characters so a snippet always stays on its line.
function escapeQuoted(text: string, quote: "'" | '"', unicode: (code: number) => string): string {
  let out = ""
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (char === "\\") {
      out += "\\\\"
    } else if (char === quote) {
      out += "\\" + quote
    } else if (SHORT_ESCAPES[char] !== undefined) {
      out += SHORT_ESCAPES[char]
    } else if (isControl(code)) {
      out += unicode(code)
    } else {
      out += char
    }
  }
  return out
}

// Swift string literal content (`"` and `\`).
export function escapeSwift(text: string): string {
  return escapeQuoted(text, '"', (code) => "\\u{" + hex(code, 1) + "}")
}

// Kotlin (and Dart) double-quoted string content (`"` and `\`).
export function escapeKotlin(text: string): string {
  return escapeQuoted(text, '"', (code) => "\\u" + hex(code, 4))
}

// JavaScript and Angular template single-quoted string content (`'` and `\`).
export function escapeJs(text: string): string {
  return escapeQuoted(text, "'", (code) => "\\u" + hex(code, 4))
}

// Android: R.string names are the key with "." → "_" (aapt does the same); anything else must be a Java identifier.
export function androidResourceName(key: string): string | null {
  const name = key.replace(/\./g, "_")
  return ANDROID_RESOURCE_NAME.test(name) ? name : null
}

// Flutter gen-l10n uses the key verbatim as the AppLocalizations getter (D21).
export function isDartIdentifier(key: string): boolean {
  return DART_IDENTIFIER.test(key)
}

// Words a placeholder variable cannot be called in each target language (reserved words, literals and, for Angular
// templates, the expression keywords). ReRune allows them as placeholder names (`class`, `default`, `in`, `is`).
const JS_RESERVED = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]
const KOTLIN_RESERVED = [
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object",
  "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while",
]
const SWIFT_RESERVED = [
  "_", "Any", "as", "associatedtype", "await", "borrowing", "break", "case", "catch", "class", "consuming", "continue",
  "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate", "for", "func",
  "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil", "nonisolated", "open", "operator",
  "precedencegroup", "private", "protocol", "public", "repeat", "rethrows", "return", "self", "Self", "static", "struct",
  "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while",
]
const DART_RESERVED = [
  "_", "assert", "await", "break", "case", "catch", "class", "const", "continue", "default", "do", "else", "enum",
  "extends", "false", "final", "finally", "for", "if", "in", "is", "new", "null", "rethrow", "return", "super", "switch",
  "this", "throw", "true", "try", "var", "void", "while", "with", "yield",
]

const RESERVED: Record<CodegenPlatform, ReadonlySet<string>> = {
  "react-i18next": new Set(JS_RESERVED),
  angular: new Set(JS_RESERVED.concat(["as", "undefined"])),
  android: new Set(KOTLIN_RESERVED),
  ios: new Set(SWIFT_RESERVED),
  flutter: new Set(DART_RESERVED),
}

// Kotlin also reserves every name made only of underscores.
function isReserved(platform: CodegenPlatform, name: string): boolean {
  return RESERVED[platform].has(name) || (platform === "android" && /^_+$/.test(name))
}

// Variable names for the placeholders, in ReRune order. ReRune names are identifiers already; anything else (an
// old or hand-edited cache) is made one, a reserved word of the platform gets a trailing "_" (`class` → `class_`),
// and repeated names are numbered.
export function argumentNames(placeholders: readonly string[], platform: CodegenPlatform): { name: string; argument: string }[] {
  const result: { name: string; argument: string }[] = []
  const used = new Set<string>()
  placeholders.forEach((name, index) => {
    if (result.some((entry) => entry.name === name)) {
      return
    }
    let argument = name
    if (!PLACEHOLDER_NAME.test(name)) {
      argument = name.replace(NOT_IDENTIFIER_CHAR, "_")
      if (/^_*$/.test(argument)) {
        argument = "arg" + (index + 1)
      } else if (LEADING_DIGIT.test(argument)) {
        argument = "_" + argument
      }
    }
    if (isReserved(platform, argument)) {
      argument = isReserved(platform, argument + "_") ? "arg" + (index + 1) : argument + "_"
    }
    let unique = argument
    for (let n = 2; used.has(unique); n++) {
      unique = argument + n
    }
    used.add(unique)
    result.push({ name, argument: unique })
  })
  return result
}

// `{ a, b }` (React) or `{ a: a, b: b }` (Angular); a name that is not an identifier is quoted, and a renamed
// variable is written out (`{ class: class_ }`: reserved words are valid property names).
function jsObject(args: readonly { name: string; argument: string }[], shorthand: boolean): string {
  const entries = args.map(({ name, argument }) => {
    if (PLACEHOLDER_NAME.test(name)) {
      return shorthand && name === argument ? name : name + ": " + argument
    }
    return "'" + escapeJs(name) + "': " + argument
  })
  return "{ " + entries.join(", ") + " }"
}

export function oneLine(text: string): string {
  return text.replace(WHITESPACE, " ").trim()
}

// An HTML comment ends at "-->" (or "--!>"), so those are broken up inside comment text.
function htmlCommentText(text: string): string {
  return text.replace(/--(!?)>/g, "- -$1>")
}

export function commentLine(platform: CodegenPlatform, text: string): string {
  const flat = oneLine(text)
  return platform === "angular" ? "<!-- " + htmlCommentText(flat) + " -->" : "// " + flat
}

// The snippet for one key (§7.17 table). Every line is complete code or a comment of the platform.
export function snippetLines(platform: CodegenPlatform, key: SnippetKey): string[] {
  const args = argumentNames(key.placeholders, platform)
  const list = args.map((entry) => entry.argument).join(", ")
  switch (platform) {
    case "react-i18next": {
      const name = "'" + escapeJs(key.name) + "'"
      return [args.length === 0 ? "t(" + name + ")" : "t(" + name + ", " + jsObject(args, true) + ")"]
    }
    case "flutter": {
      if (!isDartIdentifier(key.name)) {
        return ['// "' + escapeKotlin(key.name) + '" is not a valid Dart identifier; rename the key for Flutter']
      }
      const getter = "AppLocalizations.of(context)!." + key.name
      return [args.length === 0 ? getter : getter + "(" + list + ")"]
    }
    case "android": {
      const resource = androidResourceName(key.name)
      if (resource === null) {
        return ['// "' + escapeKotlin(key.name) + '" is not a valid Android resource name']
      }
      if (args.length > 0) {
        return ["stringResource(R.string." + resource + ", " + list + ")"]
      }
      return ["stringResource(R.string." + resource + ")", "// Views: getString(R.string." + resource + ")"]
    }
    case "ios": {
      const localized = 'NSLocalizedString("' + escapeSwift(key.name) + '", comment: "")'
      if (args.length > 0) {
        return ["String(format: " + localized + ", " + list + ")"]
      }
      return ["Text(" + localized + ")", "// UIKit: " + localized]
    }
    case "angular": {
      const name = "'" + escapeJs(key.name) + "'"
      if (args.length > 0) {
        return ["{{ " + name + " | translate: " + jsObject(args, false) + " }}"]
      }
      return ["{{ " + name + " | translate }}", "<!-- Transloco: {{ " + htmlCommentText(name) + " | transloco }} -->"]
    }
  }
}

export function snippetText(platform: CodegenPlatform, key: SnippetKey): string {
  return snippetLines(platform, key).join("\n")
}

// Code section output (§7.17): per key, the cached source text as a comment (when known) and its snippet; key
// blocks are separated by a blank line. `more`: the walk stopped (50 keys or 1.5 s). `uncached`: some keys had no
// cache entry, so their placeholders (and text) are unknown until the inspect panel or a design session loads them.
export function codegenCode(platform: CodegenPlatform, keys: readonly CodegenKey[], notes: { more: boolean; uncached: boolean }): string {
  const blocks = keys.map((key) => {
    const lines: string[] = []
    const source = key.sourceText === null ? "" : oneLine(key.sourceText)
    if (source !== "") {
      lines.push(commentLine(platform, source))
    }
    return lines.concat(snippetLines(platform, key)).join("\n")
  })
  const tail: string[] = []
  if (notes.more) {
    tail.push(commentLine(platform, MORE_KEYS_LINE))
  }
  if (notes.uncached) {
    tail.push(commentLine(platform, UNCACHED_NOTE))
  }
  if (tail.length > 0) {
    blocks.push(tail.join("\n"))
  }
  return blocks.join("\n\n")
}
