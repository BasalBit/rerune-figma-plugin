import type { FigmaApi } from "../api/figma-api"
import type { FigmaResolvedKey, MessagePart, TranslationContent } from "../../shared/api-types"
import { choiceCount, formatCount, isExactCategoryName, NO_PLURAL_SHAPE, PLURAL_CATEGORY_ORDER, placeholderNames, pluralCategories, sortedVariantForms, type PluralChoice, type PluralShape } from "../../shared/icu"
import type { ResolveSource, ScannedNode } from "../../shared/messages"
import { previewTargets, resolveForPreview } from "./preview"

// Sample values and the plural category selector (§7.18.5). Samples are kept per project in prefs
// (`samples: { [projectId]: { [placeholder]: string } }`, §7.19); the plural choice is kept for the session.

export type SampleKind = "plural" | "select" | "text"

export interface SamplePlaceholder {
  name: string
  kind: SampleKind      // plural: a plural variable; select: a select/choice variable; text: any other placeholder
  options: string[]     // select/choice selectors, for the hint
  // A plural variable's form selectors (all its blocks) and offset (its first block's) in the language the preview
  // renders (pluralShapes); null for other kinds, and while that language's forms are not known.
  plural: PluralShape | null
}

// Plural choice of the session, remembered for the project it was made in.
export interface ProjectPluralChoice extends PluralChoice { projectId: string }

export const SAMPLE_VALUE_MAX = 200

function walk(parts: readonly MessagePart[], visit: (part: MessagePart) => void): void {
  for (const part of parts) {
    visit(part)
    if (part.variant !== undefined) {
      for (const form of sortedVariantForms(part.variant.forms)) {
        walk(form.parts, visit)
      }
    }
  }
}

function keyIdsInScope(nodes: readonly ScannedNode[], projectId: string): string[] {
  return [...new Set(previewTargets(nodes, projectId).map((node) => (node.link as NonNullable<ScannedNode["link"]>).id))]
}

function contentIn(key: FigmaResolvedKey | undefined, lang: string): TranslationContent | null {
  if (key === undefined || key.type !== "key") {
    return null
  }
  const value = key.values.find((entry) => entry.lang === lang)
  return value !== undefined && value.present ? value.content : null
}

// The plural variables of the keys in scope as `lang` writes them (§7.18.5): per variable, the selectors of all its
// plural blocks in that language's values and the offset of the first. The selector offers and counts what this
// language's own forms render (a translation may have an exact `zero` form the main language lacks, or none).
export function pluralShapes(nodes: readonly ScannedNode[], projectId: string, resolved: ReadonlyMap<string, FigmaResolvedKey>, lang: string): Map<string, PluralShape> {
  const shapes = new Map<string, PluralShape>()
  for (const keyId of keyIdsInScope(nodes, projectId)) {
    const content = contentIn(resolved.get(keyId), lang)
    if (content === null || content.message === undefined || content.message === null) {
      continue
    }
    walk(content.message.parts, (part) => {
      const variant = part.variant
      if (variant === undefined || variant === null || variant.kind !== "plural") {
        return
      }
      const current = shapes.get(variant.variable)
      const selectors = current === undefined ? [] : current.selectors.slice()
      for (const form of sortedVariantForms(variant.forms)) {
        if (!selectors.includes(form.selector)) selectors.push(form.selector)
      }
      shapes.set(variant.variable, { selectors, offset: current === undefined ? variant.offset ?? 0 : current.offset })
    })
  }
  return shapes
}

// The placeholders of the keys linked in the scanned layers, in layer order: the key's catalog (E12) plus the
// variables of its main-language message (a plural or select variable is in the catalog too; the walk tells which).
// A plural variable's shape comes from `rendered` (pluralShapes of the language the preview renders; a variable it
// lacks has no forms there), is unknown with `rendered` null (still loading), and is the main language's without it.
export function samplePlaceholders(
  nodes: readonly ScannedNode[],
  projectId: string,
  resolved: ReadonlyMap<string, FigmaResolvedKey>,
  mainLanguage: string,
  rendered?: ReadonlyMap<string, PluralShape> | null,
): SamplePlaceholder[] {
  const found = new Map<string, SamplePlaceholder>()
  const add = (name: string, kind: SampleKind, options: readonly string[] = [], plural: PluralShape | null = null) => {
    let current = found.get(name)
    if (current === undefined) {
      current = { name, kind, options: [], plural: null }
      found.set(name, current)
    }
    if (kind === "plural" || (kind === "select" && current.kind === "text")) {
      current.kind = kind
    }
    for (const option of options) {
      if (!current.options.includes(option)) current.options.push(option)
    }
    if (plural !== null) {
      const selectors = current.plural === null ? [] : current.plural.selectors.slice()
      for (const selector of plural.selectors) {
        if (!selectors.includes(selector)) selectors.push(selector)
      }
      current.plural = { selectors, offset: current.plural === null ? plural.offset : current.plural.offset }
    }
  }
  for (const keyId of keyIdsInScope(nodes, projectId)) {
    const key = resolved.get(keyId)
    if (key === undefined || key.type !== "key") {
      continue
    }
    const content = contentIn(key, mainLanguage)
    if (content !== null && content.message !== undefined && content.message !== null) {
      walk(content.message.parts, (part) => {
        if (part.arg !== undefined) {
          add(part.arg.name, "text")
        } else if (part.variant !== undefined) {
          const variant = part.variant
          const selectors = sortedVariantForms(variant.forms).map((form) => form.selector)
          if (variant.kind === "plural") {
            add(variant.variable, "plural", [], { selectors, offset: variant.offset ?? 0 })
          } else {
            add(variant.variable, "select", selectors)
          }
        }
      })
    } else if (content !== null) {
      for (const name of placeholderNames(content.value)) add(name, "text")
    }
    for (const placeholder of key.placeholders) {
      add(placeholder.name, "text")
    }
  }
  const placeholders = [...found.values()]
  if (rendered === undefined) {
    return placeholders
  }
  return placeholders.map((placeholder) =>
    placeholder.kind !== "plural" ? placeholder : { ...placeholder, plural: rendered === null ? null : rendered.get(placeholder.name) ?? NO_PLURAL_SHAPE },
  )
}

// What the plural selector renders with (§7.18.5): the language, source and variation of the preview.
export interface ShapeRequest { lang: string; source: ResolveSource; variationOptionId: string | null }

// The keys in scope whose main-language message has a plural block: the only ones whose forms the selector needs.
export function pluralKeyIds(nodes: readonly ScannedNode[], projectId: string, resolved: ReadonlyMap<string, FigmaResolvedKey>, mainLanguage: string): string[] {
  return keyIdsInScope(nodes, projectId).filter((keyId) => {
    const content = contentIn(resolved.get(keyId), mainLanguage)
    let plural = false
    if (content !== null && content.message !== undefined && content.message !== null) {
      walk(content.message.parts, (part) => {
        plural = plural || part.variant?.kind === "plural"
      })
    }
    return plural
  })
}

// Identifies one load of a language's plural forms (the keys, language, source and variation).
export function shapesKey(request: ShapeRequest, keyIds: readonly string[]): string {
  return [request.lang, request.source, request.variationOptionId ?? "", keyIds.slice().sort().join(",")].join("\u0000")
}

// The plural forms of `request.lang` for the keys in scope, without a request when they are already loaded: the main
// language's draft without a variation is what the workspace resolved. null when they must be loaded (loadPluralShapes).
export function knownPluralShapes(
  nodes: readonly ScannedNode[],
  projectId: string,
  resolved: ReadonlyMap<string, FigmaResolvedKey>,
  mainLanguage: string,
  request: ShapeRequest,
): Map<string, PluralShape> | null {
  if (pluralKeyIds(nodes, projectId, resolved, mainLanguage).length === 0) {
    return new Map()
  }
  if (request.lang === mainLanguage && request.source === "draft" && request.variationOptionId === null) {
    return pluralShapes(nodes, projectId, resolved, mainLanguage)
  }
  return null
}

// Loads the plural forms of `request.lang` with one E12 resolve of the keys in scope that have a plural variable.
export async function loadPluralShapes(
  api: Pick<FigmaApi, "resolveKeys">,
  nodes: readonly ScannedNode[],
  projectId: string,
  resolved: ReadonlyMap<string, FigmaResolvedKey>,
  mainLanguage: string,
  request: ShapeRequest,
): Promise<Map<string, PluralShape>> {
  const known = knownPluralShapes(nodes, projectId, resolved, mainLanguage, request)
  if (known !== null) {
    return known
  }
  const keyIds = pluralKeyIds(nodes, projectId, resolved, mainLanguage)
  const values = await resolveForPreview(api, projectId, keyIds, { lang: request.lang, mode: request.source, variationOptionId: request.variationOptionId })
  return pluralShapes(nodes, projectId, values, request.lang)
}

export function projectSamples(samples: Record<string, Record<string, string>>, projectId: string): Record<string, string> {
  return samples[projectId] ?? {}
}

// The prefs' `samples` with one value changed; an empty value removes the sample ("[name]" shows again).
export function withSample(samples: Record<string, Record<string, string>>, projectId: string, name: string, value: string): Record<string, Record<string, string>> {
  const current = { ...projectSamples(samples, projectId) }
  const clipped = value.slice(0, SAMPLE_VALUE_MAX)
  if (clipped === "") {
    delete current[name]
  } else {
    current[name] = clipped
  }
  const next = { ...samples }
  if (Object.keys(current).length === 0) {
    delete next[projectId]
  } else {
    next[projectId] = current
  }
  return next
}

// The prefs' `samples` with the project's drafts (the editor's inputs) in place of its saved values.
export function withDrafts(samples: Record<string, Record<string, string>>, projectId: string, drafts: Record<string, string>): Record<string, Record<string, string>> {
  let next = withoutSamples(samples, projectId)
  for (const name of Object.keys(drafts)) {
    next = withSample(next, projectId, name, drafts[name])
  }
  return next
}

export function sameSamples(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

export function withoutSamples(samples: Record<string, Record<string, string>>, projectId: string): Record<string, Record<string, string>> {
  const next = { ...samples }
  delete next[projectId]
  return next
}

// The choice that applies to this project and language: a category of the language, or a zero / one / two form
// that stands for an exact count in a language without that category. The renderer ignores a choice a message
// can't show, and the selector shows "Automatic" for it (chosenCategory).
export function activePluralChoice(choice: ProjectPluralChoice | null, projectId: string, lang: string | null): PluralChoice | null {
  if (choice === null || choice.projectId !== projectId || lang === null || !(pluralCategories(lang).includes(choice.category) || isExactCategoryName(choice.category))) {
    return null
  }
  return { variable: choice.variable, category: choice.category }
}

export const AUTOMATIC = "__automatic__"

// Options of the plural selector for a plural variable: Automatic, then in CLDR order the language's categories
// and the variable's zero / one / two forms the language lacks (they stand for exactly 0, 1 and 2), each with the
// count the preview shows for it (counts an exact form claims are skipped, so "other" shows the other form). `shape`
// is the variable's forms in `lang` (the language rendered); null while they are not known: the language's
// categories only, without counts.
export function categoryOptions(lang: string, shape: PluralShape | null = NO_PLURAL_SHAPE): { value: string; text: string }[] {
  const languageCategories = pluralCategories(lang)
  if (shape === null) {
    return [{ value: AUTOMATIC, text: "Automatic" }, ...languageCategories.map((category) => ({ value: category, text: category }))]
  }
  const forms = shape
  const exact = forms.selectors.filter((selector) => isExactCategoryName(selector) && !languageCategories.includes(selector))
  const categories = [...languageCategories, ...new Set(exact)].sort((a, b) => PLURAL_CATEGORY_ORDER.indexOf(a) - PLURAL_CATEGORY_ORDER.indexOf(b))
  return [
    { value: AUTOMATIC, text: "Automatic" },
    ...categories.map((category) => {
      const count = choiceCount(lang, forms, category)
      return { value: category, text: count === null ? category : category + " (" + formatCount(lang, count) + ")" }
    }),
  ]
}

// The plural form picked for this placeholder, when its selector offers it in this language; null shows Automatic.
export function chosenCategory(placeholder: SamplePlaceholder, lang: string | null, plural: PluralChoice | null): string | null {
  if (plural === null || lang === null || placeholder.kind !== "plural" || plural.variable !== placeholder.name) {
    return null
  }
  return categoryOptions(lang, placeholder.plural).some((option) => option.value === plural.category) ? plural.category : null
}

export function sampleHint(placeholder: SamplePlaceholder): string {
  switch (placeholder.kind) {
    case "plural":
      return "A number, or pick a plural form"
    case "select":
      return placeholder.options.length > 0 ? "One of: " + placeholder.options.join(", ") : "A select value"
    case "text":
      return "Shown as [" + placeholder.name + "] without a sample"
  }
}

// One line for the Preview screen when samples or a plural form are set: "name = Ada · count: few".
export function samplesSummary(placeholders: readonly SamplePlaceholder[], samples: Record<string, string>, plural: PluralChoice | null, lang: string | null): string | null {
  const parts: string[] = []
  for (const placeholder of placeholders) {
    const category = chosenCategory(placeholder, lang, plural)
    if (category !== null) {
      parts.push(placeholder.name + ": " + category)
    } else if (samples[placeholder.name] !== undefined) {
      parts.push(placeholder.name + " = " + samples[placeholder.name])
    }
  }
  return parts.length === 0 ? null : parts.join(" · ")
}
