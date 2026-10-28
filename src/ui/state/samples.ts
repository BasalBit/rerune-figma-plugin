import type { FigmaResolvedKey, MessagePart } from "../../shared/api-types"
import { formatCount, placeholderNames, pluralCategories, sampleCountFor, type PluralChoice } from "../../shared/icu"
import type { ScannedNode } from "../../shared/messages"
import { previewTargets } from "./preview"

// Sample values and the plural category selector (§7.18.5). Samples are kept per project in prefs
// (`samples: { [projectId]: { [placeholder]: string } }`, §7.19); the plural choice is kept for the session.

export type SampleKind = "plural" | "select" | "text"

export interface SamplePlaceholder {
  name: string
  kind: SampleKind      // plural: a plural variable; select: a select/choice variable; text: any other placeholder
  options: string[]     // select/choice selectors, for the hint
}

// Plural choice of the session, remembered for the project it was made in.
export interface ProjectPluralChoice extends PluralChoice { projectId: string }

export const SAMPLE_VALUE_MAX = 200

function walk(parts: readonly MessagePart[], visit: (part: MessagePart) => void): void {
  for (const part of parts) {
    visit(part)
    if (part.variant !== undefined) {
      for (const form of part.variant.forms.slice().sort((a, b) => a.order - b.order)) {
        walk(form.parts, visit)
      }
    }
  }
}

// The placeholders of the keys linked in the scanned layers, in layer order: the key's catalog (E12) plus the
// variables of its main-language message (a plural or select variable is in the catalog too; the walk tells which).
export function samplePlaceholders(
  nodes: readonly ScannedNode[],
  projectId: string,
  resolved: ReadonlyMap<string, FigmaResolvedKey>,
  mainLanguage: string,
): SamplePlaceholder[] {
  const found = new Map<string, SamplePlaceholder>()
  const add = (name: string, kind: SampleKind, options: readonly string[] = []) => {
    const current = found.get(name)
    if (current === undefined) {
      found.set(name, { name, kind, options: options.slice() })
      return
    }
    if (kind === "plural" || (kind === "select" && current.kind === "text")) {
      current.kind = kind
    }
    for (const option of options) {
      if (!current.options.includes(option)) current.options.push(option)
    }
  }
  const keyIds = [...new Set(previewTargets(nodes, projectId).map((node) => (node.link as NonNullable<ScannedNode["link"]>).id))]
  for (const keyId of keyIds) {
    const key = resolved.get(keyId)
    if (key === undefined || key.type !== "key") {
      continue
    }
    const main = key.values.find((value) => value.lang === mainLanguage)
    const content = main !== undefined && main.present ? main.content : null
    if (content !== null && content.message !== undefined && content.message !== null) {
      walk(content.message.parts, (part) => {
        if (part.arg !== undefined) {
          add(part.arg.name, "text")
        } else if (part.variant !== undefined) {
          const variant = part.variant
          add(variant.variable, variant.kind === "plural" ? "plural" : "select", variant.kind === "plural" ? [] : variant.forms.map((form) => form.selector))
        }
      })
    } else if (content !== null) {
      for (const name of placeholderNames(content.value)) add(name, "text")
    }
    for (const placeholder of key.placeholders) {
      add(placeholder.name, "text")
    }
  }
  return [...found.values()]
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

// The choice that applies to this project and language; a category the language doesn't have is ignored by the
// renderer, so the selector shows "Automatic" for it.
export function activePluralChoice(choice: ProjectPluralChoice | null, projectId: string, lang: string | null): PluralChoice | null {
  if (choice === null || choice.projectId !== projectId || lang === null || !pluralCategories(lang).includes(choice.category)) {
    return null
  }
  return { variable: choice.variable, category: choice.category }
}

export const AUTOMATIC = "__automatic__"

// Options of the plural selector: Automatic, then the language's categories with the count each one shows.
export function categoryOptions(lang: string): { value: string; text: string }[] {
  return [
    { value: AUTOMATIC, text: "Automatic" },
    ...pluralCategories(lang).map((category) => {
      const count = sampleCountFor(lang, category)
      return { value: category, text: count === null ? category : category + " (" + formatCount(lang, count) + ")" }
    }),
  ]
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
export function samplesSummary(placeholders: readonly SamplePlaceholder[], samples: Record<string, string>, plural: PluralChoice | null): string | null {
  const parts: string[] = []
  for (const placeholder of placeholders) {
    if (plural !== null && plural.variable === placeholder.name) {
      parts.push(placeholder.name + ": " + plural.category)
    } else if (samples[placeholder.name] !== undefined) {
      parts.push(placeholder.name + " = " + samples[placeholder.name])
    }
  }
  return parts.length === 0 ? null : parts.join(" · ")
}
