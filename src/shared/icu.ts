import type { MessagePart, TranslationContent, VariantBlock, VariantForm } from "./api-types"

export interface RenderOptions {
  lang: string
  samples?: Record<string, string>
  plural?: { variable: string; category: string }
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g
const SAMPLE_COUNT_MAX = 200

export function renderContent(content: TranslationContent | null, options: RenderOptions): string {
  if (content === null) {
    return ""
  }
  if (content.message !== undefined && content.message !== null) {
    return renderParts(content.message.parts, options, null)
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

export function pluralCategories(lang: string): string[] {
  return pluralRules(lang).resolvedOptions().pluralCategories.slice()
}

export function sampleCountFor(lang: string, category: string): number | null {
  const rules = pluralRules(lang)
  for (let n = 0; n <= SAMPLE_COUNT_MAX; n++) {
    if (rules.select(n) === category) {
      return n
    }
  }
  return null
}

function sampleOrLabel(name: string, options: RenderOptions): string {
  const sample = options.samples?.[name]
  return sample !== undefined ? sample : "[" + name + "]"
}

function renderParts(parts: readonly MessagePart[], options: RenderOptions, pound: string | null): string {
  let output = ""
  for (const part of parts) {
    if (part.text !== undefined) {
      output += pound === null ? part.text : part.text.replace(/#/g, pound)
    } else if (part.arg !== undefined) {
      output += sampleOrLabel(part.arg.name, options)
    } else if (part.variant !== undefined) {
      output += renderVariant(part.variant, options, pound)
    }
  }
  return output
}

function sortedForms(block: VariantBlock): VariantForm[] {
  return block.forms.slice().sort((a, b) => a.order - b.order)
}

function formBySelector(forms: readonly VariantForm[], selector: string): VariantForm | undefined {
  return forms.find((form) => form.selector === selector)
}

function renderVariant(block: VariantBlock, options: RenderOptions, pound: string | null): string {
  const forms = sortedForms(block)
  if (forms.length === 0) {
    return ""
  }
  if (block.kind !== "plural") {
    const sample = options.samples?.[block.variable]
    const form = (sample !== undefined ? formBySelector(forms, sample) : undefined) ?? formBySelector(forms, "other") ?? forms[0]
    return renderParts(form.parts, options, pound)
  }
  const offset = block.offset ?? 0
  const explicit = options.plural !== undefined && options.plural.variable === block.variable ? options.plural.category : null
  const sample = options.samples?.[block.variable]
  const sampleCount = sample !== undefined && sample.trim() !== "" && isFinite(Number(sample)) ? Number(sample) : null
  if (sampleCount !== null) {
    const category = explicit ?? pluralRules(options.lang).select(sampleCount - offset)
    const form = formBySelector(forms, "=" + sampleCount) ?? formBySelector(forms, category) ?? formBySelector(forms, "other") ?? forms[0]
    return renderParts(form.parts, options, String(sampleCount - offset))
  }
  const category = explicit ?? "other"
  const form = formBySelector(forms, category) ?? formBySelector(forms, "other") ?? forms[0]
  return renderParts(form.parts, options, String(sampleCountFor(options.lang, category) ?? 0))
}

function pluralRules(lang: string): Intl.PluralRules {
  try {
    return new Intl.PluralRules(lang)
  } catch {
    return new Intl.PluralRules("en")
  }
}
