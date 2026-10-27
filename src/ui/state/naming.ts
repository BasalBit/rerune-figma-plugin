import type { FileSettings } from "../../shared/messages"
import {
  createKeyNameSuggester,
  keyNameIssues,
  keyNameWarnings,
  resolveCaseStyle,
  suggestKeyName,
  TEMPLATE_TOKENS,
  type KeyNameSuggester,
  type ResolvedCaseStyle,
} from "../../shared/key-names"

// Key-name suggestion wiring for the UI (§7.12): project pattern from E9 key_name_sample, file settings override.

export function styleFor(settings: Pick<FileSettings, "caseStyle"> | null, sample: readonly string[]): ResolvedCaseStyle {
  return resolveCaseStyle(settings?.caseStyle ?? "auto", sample)
}

export function suggesterFor(sample: readonly string[], settings: Pick<FileSettings, "caseStyle" | "keyTemplate"> | null, taken: Iterable<string> = []): KeyNameSuggester {
  return createKeyNameSuggester({ style: styleFor(settings, sample), template: settings?.keyTemplate ?? null, taken: [...sample, ...taken] })
}

export interface NameCheck { issues: string[]; warnings: string[] }

// Live validation of a name typed for a new key: D12 rule, taken in the project, duplicate among pending creates.
export function checkNewKeyName(name: string, context: { taken: boolean; duplicate: boolean }): NameCheck {
  const trimmed = name.trim()
  return {
    issues: keyNameIssues(trimmed, { taken: context.taken, duplicateInBatch: context.duplicate }),
    warnings: trimmed === "" ? [] : keyNameWarnings(trimmed),
  }
}

const TEMPLATE_PLACEHOLDER = /\{([^{}]*)\}/g

// Unknown {tokens} in a key template; an empty template means "default join".
export function templateIssues(template: string): string[] {
  const issues: string[] = []
  TEMPLATE_PLACEHOLDER.lastIndex = 0
  for (let match = TEMPLATE_PLACEHOLDER.exec(template); match !== null; match = TEMPLATE_PLACEHOLDER.exec(template)) {
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(match[1])) {
      issues.push("Unknown placeholder {" + match[1] + "}. Use " + TEMPLATE_TOKENS.map((token) => "{" + token + "}").join(", ") + ".")
    }
  }
  if (template.trim() !== "" && !/\{[a-z]+\}/.test(template)) {
    issues.push("Add at least one placeholder, for example {frame}_{layer}.")
  }
  return issues
}

// Example shown under the template field in Settings.
export function exampleKeyName(settings: Pick<FileSettings, "caseStyle" | "keyTemplate">, sample: readonly string[]): string {
  return suggestKeyName(
    { pageName: "Mobile", frameName: "Checkout", layerName: "Pay button", autoRename: false, text: "Pay now", componentName: null },
    { style: styleFor(settings, sample), template: settings.keyTemplate },
  )
}
