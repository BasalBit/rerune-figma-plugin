import type { MessagePart, TranslationContent, VariantBlock, VariantForm } from "./api-types"

// Sample rendering of ReRune values (§7.18.5, content shape §4.0) for preview, Dev Mode and search display.
// Plural categories come from CLDR through Intl.PluralRules. The language is looked up like the server's
// domain.CardinalPluralRules: `de-AT` / `de_AT` → `de-AT`, then `de`; `sr-Latn-RS` → `sr-Latn`, `sr-RS`, `sr`;
// deprecated subtags (`iw`, `in`, `mo`, …) are replaced first. A language neither knows has only `other`.

export interface PluralChoice { variable: string; category: string }

export interface RenderOptions {
  lang: string
  samples?: Record<string, string>
  plural?: PluralChoice | null
}

// CLDR category order (the server's pluralSelectorOrder); the only selectors the server stores in a plural block.
export const PLURAL_CATEGORY_ORDER: readonly string[] = ["zero", "one", "two", "few", "many", "other"]

// The server stores Flutter's exact forms =0, =1 and =2 as zero, one and two (a plural block holds only CLDR
// categories), and Flutter (Dart intl) and i18next (`_zero`) show such a form for exactly 0, 1 or 2 in every
// language. So in a language whose CLDR rules lack the category, a zero, one or two form is the exact form =0, =1
// or =2; in a language that has the category it keeps its CLDR meaning.
const EXACT_CATEGORY_COUNTS: ReadonlyMap<string, number> = new Map([["zero", 0], ["one", 1], ["two", 2]])

export function isExactCategoryName(category: string): boolean {
  return EXACT_CATEGORY_COUNTS.has(category)
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

// Counts tried for a category: 0–200 (§7.18.5), then round numbers (French, Spanish, Italian, Portuguese and
// Catalan "many" start at 1,000,000), then halves for categories only fractions reach (Russian or Polish "other",
// Czech "many").
const SAMPLE_COUNT_MAX = 200
const LARGE_SAMPLE_COUNTS: readonly number[] = [1000, 10000, 100000, 1000000, 10000000]

export function renderContent(content: TranslationContent | null, options: RenderOptions): string {
  if (content === null) {
    return ""
  }
  if (content.message !== undefined && content.message !== null) {
    const counts: Counts = { values: new Map(), fromSample: new Set() }
    collectCounts(content.message.parts, options, counts)
    return renderParts(content.message.parts, options, counts, null)
  }
  return content.value.replace(PLACEHOLDER, (_match, name: string) => sampleOrLabel(name.trim(), options))
}

// The `{{name}}` references the server turns into placeholders when it creates a key (D9; messageformat
// CollectPlainPlaceholderReferences), in text order without repeats. `{{ name }}` or `{{user.name}}` stay plain text.
const PLACEHOLDER_REFERENCE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

export function placeholderNames(text: string): string[] {
  const names: string[] = []
  PLACEHOLDER_REFERENCE.lastIndex = 0
  for (let match = PLACEHOLDER_REFERENCE.exec(text); match !== null; match = PLACEHOLDER_REFERENCE.exec(text)) {
    const name = match[1]
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

// ---------------------------------------------------------------------------------------------------------------
// Language lookup (server internal/domain/language_code.go: LanguageCodeKey, languageFallbackKeys)

const LANGUAGE_SUBTAG = /^[A-Za-z]{2,8}$/
const SCRIPT_SUBTAG = /^[A-Za-z]{4}$/
const REGION_SUBTAG = /^(?:[A-Za-z]{2}|[0-9]{3})$/
const DEPRECATED_LANGUAGES: Record<string, string> = { in: "id", iw: "he", ji: "yi", jw: "jv", mo: "ro" }
const DEPRECATED_REGIONS: Record<string, string> = { BU: "MM", DD: "DE", FX: "FR", TP: "TL", YD: "YE", ZR: "CD" }

// The BCP 47 tags the server tries for a project language code, most specific first; [] for a code the server
// rejects (it then knows no plural rules for it).
export function languageLookupTags(code: string): string[] {
  const parts = code.replace(/_/g, "-").split("-")
  if (parts.length > 3 || parts.includes("") || !LANGUAGE_SUBTAG.test(parts[0])) {
    return []
  }
  let language = parts[0].toLowerCase()
  let script = ""
  let region = ""
  if (parts.length === 2) {
    if (SCRIPT_SUBTAG.test(parts[1])) {
      script = titleCase(parts[1])
    } else if (REGION_SUBTAG.test(parts[1])) {
      region = parts[1].toUpperCase()
    } else {
      return []
    }
  } else if (parts.length === 3) {
    if (!SCRIPT_SUBTAG.test(parts[1]) || !REGION_SUBTAG.test(parts[2])) {
      return []
    }
    script = titleCase(parts[1])
    region = parts[2].toUpperCase()
  }
  language = DEPRECATED_LANGUAGES[language] ?? language
  region = DEPRECATED_REGIONS[region] ?? region
  const join = (...subtags: string[]) => subtags.filter((subtag) => subtag !== "").join("-")
  if (script !== "" && region !== "") {
    return [join(language, script, region), join(language, script), join(language, region), language]
  }
  if (script !== "" || region !== "") {
    return [join(language, script, region), language]
  }
  return [language]
}

function titleCase(subtag: string): string {
  return subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase()
}

function firstSupported(code: string, supportedLocalesOf: (tag: string) => string[]): string | null {
  for (const tag of languageLookupTags(code)) {
    try {
      if (supportedLocalesOf(tag).length > 0) {
        return tag
      }
    } catch {
      // A tag the browser's Intl rejects is skipped like an unknown one.
    }
  }
  return null
}

// The tag whose CLDR plural rules apply to a project language, or null when there are none (only `other`).
export function pluralLocale(code: string): string | null {
  return firstSupported(code, (tag) => Intl.PluralRules.supportedLocalesOf(tag))
}

const rulesCache = new Map<string, Intl.PluralRules | null>()
const numberCache = new Map<string, Intl.NumberFormat | null>()

function pluralRulesFor(code: string): Intl.PluralRules | null {
  if (!rulesCache.has(code)) {
    const locale = pluralLocale(code)
    rulesCache.set(code, locale === null ? null : new Intl.PluralRules(locale))
  }
  return rulesCache.get(code) ?? null
}

function numberFormatFor(code: string): Intl.NumberFormat | null {
  if (!numberCache.has(code)) {
    const locale = firstSupported(code, (tag) => Intl.NumberFormat.supportedLocalesOf(tag))
    numberCache.set(code, locale === null ? null : new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }))
  }
  return numberCache.get(code) ?? null
}

// The language's plural categories in CLDR order.
export function pluralCategories(lang: string): string[] {
  const rules = pluralRulesFor(lang)
  const categories = rules === null ? ["other"] : rules.resolvedOptions().pluralCategories.slice()
  return categories.sort((a, b) => PLURAL_CATEGORY_ORDER.indexOf(a) - PLURAL_CATEGORY_ORDER.indexOf(b))
}

export function pluralCategory(lang: string, count: number): string {
  const rules = pluralRulesFor(lang)
  return rules === null ? "other" : rules.select(count)
}

// The number `#` shows, formatted for the language as ICU formats it (`1,000`, `1.000`, `0,5`).
export function formatCount(lang: string, count: number): string {
  const format = numberFormatFor(lang)
  return format === null ? String(count) : format.format(count)
}

// The smallest count of a category (§7.18.5: 0–200, then the larger and fractional counts above), skipping counts
// `skip` rejects; null when the language has no such category.
export function sampleCountFor(lang: string, category: string, skip: (count: number) => boolean = () => false): number | null {
  if (!pluralCategories(lang).includes(category)) {
    return null
  }
  let fallback: number | null = null
  const consider = (count: number): boolean => {
    if (pluralCategory(lang, count) !== category) {
      return false
    }
    fallback = fallback ?? count
    return !skip(count)
  }
  for (let n = 0; n <= SAMPLE_COUNT_MAX; n++) {
    if (consider(n)) return n
  }
  for (const n of LARGE_SAMPLE_COUNTS) {
    if (consider(n)) return n
  }
  for (let n = 0; n <= SAMPLE_COUNT_MAX; n++) {
    if (consider(n + 0.5)) return n + 0.5
  }
  return fallback
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function sampleOf(name: string, options: RenderOptions): string | undefined {
  return options.samples?.[name]
}

function sampleOrLabel(name: string, options: RenderOptions): string {
  const sample = sampleOf(name, options)
  return sample !== undefined ? sample : "[" + name + "]"
}

function numericSample(name: string, options: RenderOptions): number | null {
  const sample = sampleOf(name, options)
  if (sample === undefined || sample.trim() === "") {
    return null
  }
  const count = Number(sample.trim())
  return isFinite(count) ? count : null
}

function sortedForms(block: VariantBlock): VariantForm[] {
  return block.forms.slice().sort((a, b) => a.order - b.order)
}

function formBySelector(forms: readonly VariantForm[], selector: string): VariantForm | undefined {
  return forms.find((form) => form.selector === selector)
}

// The count a selector matches exactly: `=N`, or zero / one / two in a language without that category; null for
// any other selector.
export function exactCountOf(selector: string, lang: string): number | null {
  if (selector.charAt(0) === "=") {
    const count = selector.length > 1 ? Number(selector.slice(1)) : NaN
    return isFinite(count) ? count : null
  }
  const count = EXACT_CATEGORY_COUNTS.get(selector)
  return count !== undefined && !pluralCategories(lang).includes(selector) ? count : null
}

// An `=N` form matching the count wins over a zero / one / two form that stands for the same count.
function exactForm(forms: readonly VariantForm[], count: number, lang: string): VariantForm | undefined {
  const matches = (form: VariantForm) => exactCountOf(form.selector, lang) === count
  return forms.find((form) => form.selector.charAt(0) === "=" && matches(form)) ?? forms.find(matches)
}

// What the plural selector needs to know about a plural variable: the selectors of its forms and its offset.
export interface PluralShape { selectors: readonly string[]; offset: number }

export const NO_PLURAL_SHAPE: PluralShape = { selectors: [], offset: 0 }

// The count a plural block shows for a category picked with the plural selector, or null when it can't show it.
// A category of the language: its smallest count that no exact form of the block claims (so the category's own form
// shows; when exact forms claim every count, its smallest count), plus the offset (the category is chosen on
// count − offset, as ICU does). A zero / one / two form of a language without that category: its exact count.
export function choiceCount(lang: string, shape: PluralShape, category: string): number | null {
  if (!pluralCategories(lang).includes(category)) {
    return shape.selectors.includes(category) ? exactCountOf(category, lang) : null
  }
  const claimed = (count: number) => shape.selectors.some((selector) => exactCountOf(selector, lang) === count)
  const count = sampleCountFor(lang, category, (n) => claimed(n + shape.offset))
  return count === null ? null : count + shape.offset
}

// The value of each plural variable (`count`), set by its first plural block: a category picked with the plural
// selector when this block can show it (choiceCount); else a numeric sample; else the count choiceCount gives for
// `other`.
interface Counts { values: Map<string, number>; fromSample: Set<string> }

function collectCounts(parts: readonly MessagePart[], options: RenderOptions, counts: Counts): void {
  for (const part of parts) {
    const block = part.variant
    if (block === undefined || block === null) {
      continue
    }
    const forms = sortedForms(block)
    if (block.kind === "plural" && !counts.values.has(block.variable)) {
      const shape: PluralShape = { selectors: forms.map((form) => form.selector), offset: block.offset ?? 0 }
      const chosen = options.plural?.variable === block.variable ? options.plural.category : null
      const chosenCount = chosen === null ? null : choiceCount(options.lang, shape, chosen)
      const sample = numericSample(block.variable, options)
      if (chosenCount === null && sample !== null) {
        counts.values.set(block.variable, sample)
        counts.fromSample.add(block.variable)
      } else {
        counts.values.set(block.variable, chosenCount ?? choiceCount(options.lang, shape, "other") ?? shape.offset)
      }
    }
    for (const form of forms) {
      collectCounts(form.parts, options, counts)
    }
  }
}

function renderParts(parts: readonly MessagePart[], options: RenderOptions, counts: Counts, pound: string | null): string {
  let output = ""
  for (const part of parts) {
    if (part.text !== undefined) {
      output += pound === null ? part.text : part.text.replace(/#/g, pound)
    } else if (part.arg !== undefined) {
      // A plural variable shows its count (formatted) unless that count is the sample as typed.
      const name = part.arg.name
      const count = counts.fromSample.has(name) ? undefined : counts.values.get(name)
      output += count !== undefined ? formatCount(options.lang, count) : sampleOrLabel(name, options)
    } else if (part.variant !== undefined) {
      output += renderVariant(part.variant, options, counts, pound)
    }
  }
  return output
}

function renderVariant(block: VariantBlock, options: RenderOptions, counts: Counts, pound: string | null): string {
  const forms = sortedForms(block)
  if (forms.length === 0) {
    return ""
  }
  if (block.kind !== "plural") {
    // select / choice: the form whose selector equals the sample, else `other`, else the first; `#` keeps the
    // enclosing plural's number.
    const sample = sampleOf(block.variable, options)
    const form = (sample !== undefined ? formBySelector(forms, sample.trim()) : undefined) ?? formBySelector(forms, "other") ?? forms[0]
    return renderParts(form.parts, options, counts, pound)
  }
  const offset = block.offset ?? 0
  const count = counts.values.get(block.variable) ?? offset
  // An exact form matching the count wins (=N, or zero / one / two the language lacks; compared before the offset),
  // else the count's category, else `other`, else the first form; `#` inside the form is count − offset.
  const form = exactForm(forms, count, options.lang) ?? formBySelector(forms, pluralCategory(options.lang, count - offset)) ?? formBySelector(forms, "other") ?? forms[0]
  return renderParts(form.parts, options, counts, formatCount(options.lang, count - offset))
}
