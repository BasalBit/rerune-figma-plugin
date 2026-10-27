import { KEY_NAME_SERVER_MAX_CHARS, KEY_NAME_SUGGESTED_MAX_CHARS } from "./constants"
import type { CaseStyle, ScannedNode } from "./messages"
import { normalizeDesignText } from "./text"

export type ResolvedCaseStyle = Exclude<CaseStyle, "auto">
export type KeyNameClass = ResolvedCaseStyle | "other"
export type TemplateToken = "page" | "frame" | "screen" | "layer" | "element" | "text" | "component"

export interface NameSource {
  pageName: string
  frameName: string | null
  layerName: string
  autoRename: boolean
  text: string
  componentName: string | null
}

export interface SuggestOptions {
  style: ResolvedCaseStyle
  template: string | null
}

export const KEY_NAME_ISSUES = {
  invalid: "Use letters, digits, _ . - / : and start/end with a letter, digit or _.",
  taken: "A key with this name exists.",
  duplicate: "Another new key in this push has this name.",
} as const

export const KEY_NAME_WARNINGS = {
  dart: "Flutter needs letters, digits and _",
  android: "Not a valid Android resource name",
  androidDots: "Dots become _ in Android R.string",
} as const

const CLASS_PATTERNS: readonly { style: ResolvedCaseStyle; pattern: RegExp; needsUppercase?: boolean }[] = [
  { style: "dot.snake", pattern: /^[a-z0-9]+(_[a-z0-9]+)*(\.[a-z0-9]+(_[a-z0-9]+)*)+$/ },
  { style: "dot.camel", pattern: /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, needsUppercase: true },
  { style: "dot.kebab", pattern: /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/ },
  { style: "slash.snake", pattern: /^[a-z0-9]+(_[a-z0-9]+)*(\/[a-z0-9]+(_[a-z0-9]+)*)+$/ },
  { style: "snake", pattern: /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/ },
  { style: "camel", pattern: /^[a-z]+[A-Z][a-zA-Z0-9]*$/ },
  { style: "pascal", pattern: /^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/ },
  { style: "kebab", pattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/ },
  { style: "screaming", pattern: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/ },
]

const DOMINANT_MIN_COUNT = 3
const DOMINANT_MIN_SHARE = 0.4
const SCREEN_MAX_WORDS = 3
const ELEMENT_MAX_WORDS = 4
const DEFAULT_LAYER_NAME = /^(Text|Frame|Layer|Rectangle|Group)( \d+)?$/
const SERVER_KEY_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.:/-]{0,198}[A-Za-z0-9_])?$/
const DART_IDENTIFIER = /^[a-z][A-Za-z0-9_]*$/
const ANDROID_INVALID = /[^A-Za-z0-9_.]/
const COMBINING_MARKS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g")
const LETTER_FOLDS: readonly [RegExp, string][] = [
  [/ß/g, "ss"],
  [/ẞ/g, "SS"],
  [/æ/g, "ae"],
  [/Æ/g, "AE"],
  [/ø/g, "o"],
  [/Ø/g, "O"],
  [/œ/g, "oe"],
  [/Œ/g, "OE"],
]
const NUMERIC_WORD = /^[0-9]+$/
const TEMPLATE_PART = /\{([a-z]+)\}/g
export const TEMPLATE_TOKENS: readonly TemplateToken[] = ["page", "frame", "screen", "layer", "element", "text", "component"]
const DROP_ORDER: readonly TemplateToken[] = ["element", "layer", "text", "screen", "frame", "component", "page"]
const SEPARATOR_RUN = /[._:/-]{2,}/g
const EDGE_SEPARATORS = /^[._:/-]+|[._:/-]+$/g
const LITERAL_INVALID = /[^A-Za-z0-9_.:/-]/g

type WordRule = "snake" | "camel" | "pascal" | "kebab" | "screaming"
type TemplatePart = { literal: string } | { token: TemplateToken }

export function classifyKeyName(name: string): KeyNameClass {
  for (const entry of CLASS_PATTERNS) {
    if (entry.pattern.test(name) && (entry.needsUppercase !== true || /[A-Z]/.test(name))) {
      return entry.style
    }
  }
  return "other"
}

export function detectCaseStyle(sample: readonly string[]): ResolvedCaseStyle {
  const counts = new Map<ResolvedCaseStyle, number>()
  let classified = 0
  for (const name of sample) {
    const style = classifyKeyName(name)
    if (style !== "other") {
      counts.set(style, (counts.get(style) ?? 0) + 1)
      classified++
    }
  }
  let best: ResolvedCaseStyle | null = null
  let bestCount = 0
  for (const entry of CLASS_PATTERNS) {
    const count = counts.get(entry.style) ?? 0
    if (count > bestCount) {
      best = entry.style
      bestCount = count
    }
  }
  if (best !== null && bestCount >= DOMINANT_MIN_COUNT && bestCount >= classified * DOMINANT_MIN_SHARE) {
    return best
  }
  return "snake"
}

export function resolveCaseStyle(setting: CaseStyle, sample: readonly string[]): ResolvedCaseStyle {
  return setting === "auto" ? detectCaseStyle(sample) : setting
}

export function nameWords(text: string): string[] {
  let folded = text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  for (const [pattern, replacement] of LETTER_FOLDS) {
    folded = folded.replace(pattern, replacement)
  }
  const words = folded
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
  const firstNonNumeric = words.findIndex((word) => !NUMERIC_WORD.test(word))
  return firstNonNumeric > 0 ? words.slice(firstNonNumeric) : words
}

export function isDefaultLayerName(source: Pick<NameSource, "layerName" | "autoRename" | "text">): boolean {
  const name = source.layerName.trim()
  return source.autoRename || name === normalizeDesignText(source.text) || DEFAULT_LAYER_NAME.test(name)
}

export function nameSourceOf(node: Pick<ScannedNode, "pageName" | "frameName" | "name" | "autoRename" | "characters" | "originalCharacters" | "componentName">): NameSource {
  return {
    pageName: node.pageName,
    frameName: node.frameName,
    layerName: node.name,
    autoRename: node.autoRename,
    text: node.originalCharacters ?? node.characters,
    componentName: node.componentName,
  }
}

function wordRuleOf(style: ResolvedCaseStyle): WordRule {
  switch (style) {
    case "snake":
    case "dot.snake":
    case "slash.snake":
      return "snake"
    case "camel":
    case "dot.camel":
      return "camel"
    case "pascal":
      return "pascal"
    case "kebab":
    case "dot.kebab":
      return "kebab"
    case "screaming":
      return "screaming"
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function joinWords(words: readonly string[], rule: WordRule): string {
  switch (rule) {
    case "snake":
      return words.join("_")
    case "camel":
      return words.map((word, index) => (index === 0 ? word : capitalize(word))).join("")
    case "pascal":
      return words.map(capitalize).join("")
    case "kebab":
      return words.join("-")
    case "screaming":
      return words.join("_").toUpperCase()
  }
}

function defaultTemplate(style: ResolvedCaseStyle): TemplatePart[] {
  const separator: Record<ResolvedCaseStyle, string> = {
    snake: "_",
    camel: "",
    pascal: "",
    kebab: "-",
    screaming: "_",
    "dot.snake": ".",
    "dot.camel": ".",
    "dot.kebab": ".",
    "slash.snake": "/",
  }
  return [{ token: "screen" }, { literal: separator[style] }, { token: "element" }]
}

function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let last = 0
  TEMPLATE_PART.lastIndex = 0
  for (let match = TEMPLATE_PART.exec(template); match !== null; match = TEMPLATE_PART.exec(template)) {
    if (match.index > last) {
      parts.push({ literal: template.slice(last, match.index) })
    }
    const token = match[1] as TemplateToken
    if (TEMPLATE_TOKENS.includes(token)) {
      parts.push({ token })
    }
    last = match.index + match[0].length
  }
  if (last < template.length) {
    parts.push({ literal: template.slice(last) })
  }
  return parts
}

function tokenWords(source: NameSource): Record<TemplateToken, string[]> {
  const element = (isDefaultLayerName(source) ? nameWords(normalizeDesignText(source.text)) : nameWords(source.layerName)).slice(0, ELEMENT_MAX_WORDS)
  const frameName = source.frameName ?? ""
  const screen = nameWords(frameName.trim() !== "" ? frameName : source.pageName).slice(0, SCREEN_MAX_WORDS)
  const screenOrDefault = screen.length > 0 ? screen : ["screen"]
  const elementOrDefault = element.length > 0 ? element : ["text"]
  return {
    page: nameWords(source.pageName).slice(0, SCREEN_MAX_WORDS),
    frame: nameWords(frameName).slice(0, SCREEN_MAX_WORDS),
    screen: screenOrDefault,
    layer: elementOrDefault,
    element: elementOrDefault,
    text: nameWords(normalizeDesignText(source.text)).slice(0, ELEMENT_MAX_WORDS),
    component: nameWords(source.componentName ?? "").slice(0, SCREEN_MAX_WORDS),
  }
}

function render(parts: readonly TemplatePart[], words: Record<TemplateToken, string[]>, rule: WordRule): string {
  let output = ""
  for (const part of parts) {
    if ("literal" in part) {
      output += part.literal.replace(LITERAL_INVALID, "")
      continue
    }
    const joined = joinWords(words[part.token], rule)
    output += rule === "camel" && /[A-Za-z0-9]$/.test(output) ? capitalize(joined) : joined
  }
  return output.replace(SEPARATOR_RUN, (run) => run.charAt(0)).replace(EDGE_SEPARATORS, "")
}

function withLetterPrefix(name: string, style: ResolvedCaseStyle): string {
  if (name === "" || /^[A-Za-z]/.test(name)) {
    return name
  }
  switch (wordRuleOf(style)) {
    case "snake":
      return "k_" + name
    case "kebab":
      return "k-" + name
    case "screaming":
      return "K_" + name
    case "camel":
      return "k" + capitalize(name)
    case "pascal":
      return "K" + name
  }
}

function trimToLength(name: string, max: number): string {
  return name.length <= max ? name : name.slice(0, max).replace(/[._:/-]+$/, "")
}

export function suggestKeyName(source: NameSource, options: SuggestOptions): string {
  const rule = wordRuleOf(options.style)
  const words = tokenWords(source)
  const templated = options.template !== null && options.template.trim() !== "" ? parseTemplate(options.template) : null
  let parts = templated ?? defaultTemplate(options.style)
  if (templated !== null && render(templated, words, rule) === "") {
    parts = defaultTemplate(options.style)
  }
  const used = new Set<TemplateToken>()
  for (const part of parts) {
    if ("token" in part) {
      used.add(part.token)
    }
  }
  const compose = () => withLetterPrefix(render(parts, words, rule), options.style)
  let name = compose()
  for (const token of DROP_ORDER) {
    if (!used.has(token)) {
      continue
    }
    while (name.length > KEY_NAME_SUGGESTED_MAX_CHARS && words[token].length > 1) {
      words[token] = words[token].slice(0, -1)
      name = compose()
    }
  }
  return trimToLength(name, KEY_NAME_SUGGESTED_MAX_CHARS)
}

function suffixSeparator(style: ResolvedCaseStyle): string {
  switch (wordRuleOf(style)) {
    case "kebab":
      return "-"
    case "camel":
    case "pascal":
      return ""
    case "snake":
    case "screaming":
      return "_"
  }
}

export function uniqueKeyName(base: string, style: ResolvedCaseStyle, isTaken: (name: string) => boolean): string {
  if (!isTaken(base)) {
    return base
  }
  const limit = base.length <= KEY_NAME_SUGGESTED_MAX_CHARS ? KEY_NAME_SUGGESTED_MAX_CHARS : KEY_NAME_SERVER_MAX_CHARS
  const separator = suffixSeparator(style)
  for (let n = 2; ; n++) {
    const suffix = separator + n
    const candidate = trimToLength(base, limit - suffix.length) + suffix
    if (!isTaken(candidate)) {
      return candidate
    }
  }
}

export function isValidServerKeyName(name: string): boolean {
  return SERVER_KEY_NAME.test(name)
}

export function keyNameWarnings(name: string): string[] {
  const warnings: string[] = []
  if (!DART_IDENTIFIER.test(name)) {
    warnings.push(KEY_NAME_WARNINGS.dart)
  }
  if (ANDROID_INVALID.test(name)) {
    warnings.push(KEY_NAME_WARNINGS.android)
  }
  if (name.includes(".")) {
    warnings.push(KEY_NAME_WARNINGS.androidDots)
  }
  return warnings
}

export function keyNameIssues(name: string, context: { taken: boolean; duplicateInBatch: boolean }): string[] {
  const issues: string[] = []
  if (!isValidServerKeyName(name)) {
    issues.push(KEY_NAME_ISSUES.invalid)
  }
  if (context.duplicateInBatch) {
    issues.push(KEY_NAME_ISSUES.duplicate)
  }
  if (context.taken) {
    issues.push(KEY_NAME_ISSUES.taken)
  }
  return issues
}

export interface KeyNameSuggester {
  style: ResolvedCaseStyle
  suggest(source: NameSource): string
  reserve(name: string): void
  isTaken(name: string): boolean
}

export function createKeyNameSuggester(options: SuggestOptions & { taken: Iterable<string> }): KeyNameSuggester {
  const used = new Set(options.taken)
  const isTaken = (name: string) => used.has(name)
  return {
    style: options.style,
    suggest(source) {
      const name = uniqueKeyName(suggestKeyName(source, options), options.style, isTaken)
      used.add(name)
      return name
    },
    reserve(name) {
      used.add(name)
    },
    isTaken,
  }
}
