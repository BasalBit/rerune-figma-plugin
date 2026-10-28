import type { FigmaLanguage, FigmaProject, FigmaResolvedKey } from "../../shared/api-types"
import { renderContent, type PluralChoice } from "../../shared/icu"
import type { NodeError, PreviewInfo, ResolveSource, ScannedNode } from "../../shared/messages"
import { pseudoLocalize } from "../../shared/pseudo"
import { layerText } from "../../shared/sync-state"
import type { FigmaApi } from "../api/figma-api"
import { mainsFirst } from "./ops"
import { resolveInChunks } from "./remote"

// Preview (§7.14 UI rules, D24): resolve linked keys for one language, write the values with preview-apply,
// keep the source text where a translation is missing and list those layers.

export type PreviewMode = ResolveSource | "keys"

export interface PreviewRequest { lang: string; mode: PreviewMode; variationOptionId: string | null }

export interface PreviewEntry { nodeId: string; keyId: string; keyName: string; text: string; resolvedLang: string }

// A previewed value longer than the key's max_length (§7.18.3): E12 `exceeds_max_length`, with its `length`
// (messageformat.ContentLength: UTF-16 units, `{{name}}` as written, the longest plural form).
export interface PreviewTooLong extends PreviewEntry { length: number; maxLength: number }

export interface PreviewBuild {
  info: Omit<PreviewInfo, "appliedAt">
  items: { nodeId: string; text: string }[]
  missing: PreviewEntry[]
  inherited: PreviewEntry[]
  tooLong: PreviewTooLong[]
  skipped: { variable: string[]; otherProject: number; unlinked: number }
}

// Sample values (prefs, per project) and the plural category selector (§7.18.5) used to render values.
export interface RenderChoices { samples: Record<string, string>; plural: PluralChoice | null }

export const NO_RENDER_CHOICES: RenderChoices = { samples: {}, plural: null }

export const PREVIEW_LINK_STATES: readonly ScannedNode["linkState"][] = ["ok", "inherited", "copied"]

// Layers that preview: links of this project that still name a key. inherited_overridden keeps its own text.
export function previewTargets(nodes: readonly ScannedNode[], projectId: string): ScannedNode[] {
  return nodes.filter((node) => node.link !== null && node.link.p === projectId && PREVIEW_LINK_STATES.includes(node.linkState))
}

export function previewKeyIds(nodes: readonly ScannedNode[], projectId: string): string[] {
  return [...new Set(previewTargets(nodes, projectId).map((node) => (node.link as NonNullable<ScannedNode["link"]>).id))]
}

// "German (Austria) · falls back to de" for languages that inherit (resolve walks inherits_from, nearest first).
export function languageLabel(language: FigmaLanguage): string {
  const base = language.name !== "" ? language.name + " (" + language.code + ")" : language.code
  const chain = language.inherits_from.length > 0 ? " · falls back to " + language.inherits_from.join(" → ") : ""
  return base + (language.main ? " · source" : "") + chain
}

export function defaultLanguage(project: Pick<FigmaProject, "languages" | "main_language">, last: string | null): string | null {
  if (last !== null && project.languages.some((language) => language.code === last)) {
    return last
  }
  const firstOther = project.languages.find((language) => !language.main)
  return firstOther?.code ?? project.languages[0]?.code ?? null
}

export async function resolveForPreview(
  api: Pick<FigmaApi, "resolveKeys">,
  projectId: string,
  keyIds: readonly string[],
  request: PreviewRequest,
): Promise<Map<string, FigmaResolvedKey>> {
  const resolved = new Map<string, FigmaResolvedKey>()
  if (request.mode === "keys" || keyIds.length === 0) {
    return resolved
  }
  const { responses, error } = await resolveInChunks(api, projectId, keyIds, {
    languages: [request.lang],
    source: request.mode,
    variation_option_id: request.variationOptionId,
  })
  if (error !== null) {
    throw error
  }
  for (const response of responses) {
    for (const key of response.keys) {
      resolved.set(key.id, key)
    }
  }
  return resolved
}

export function buildPreview(
  nodes: readonly ScannedNode[],
  projectId: string,
  request: PreviewRequest,
  resolved: ReadonlyMap<string, FigmaResolvedKey>,
  keyNames: ReadonlyMap<string, string>,
  choices: RenderChoices = NO_RENDER_CHOICES,
): PreviewBuild {
  const build: PreviewBuild = {
    info: { lang: request.lang, source: request.mode, variationOptionId: request.mode === "keys" ? null : request.variationOptionId },
    items: [],
    missing: [],
    inherited: [],
    tooLong: [],
    skipped: { variable: [], otherProject: 0, unlinked: 0 },
  }
  // A layer that is previewing but no longer resolves to a key of this project (unlinked or relinked during the
  // preview) goes back to its original text instead of keeping the previous language; Reset still clears it.
  const restoreOriginal = (node: ScannedNode) => {
    if (node.preview !== null) {
      build.items.push({ nodeId: node.nodeId, text: layerText(node) })
    }
  }
  for (const node of nodes) {
    const link = node.link
    if (link === null || !PREVIEW_LINK_STATES.includes(node.linkState)) {
      build.skipped.unlinked++
      restoreOriginal(node)
      continue
    }
    if (link.p !== projectId) {
      build.skipped.otherProject++
      restoreOriginal(node)
      continue
    }
    if (node.boundToVariable) {
      build.skipped.variable.push(node.nodeId)
      continue
    }
    const keyName = resolved.get(link.id)?.key ?? keyNames.get(link.id) ?? link.k
    if (request.mode === "keys") {
      build.items.push({ nodeId: node.nodeId, text: "[" + keyName + "]" })
      continue
    }
    const key = resolved.get(link.id)
    const value = key?.values.find((entry) => entry.lang === request.lang)
    const entry: PreviewEntry = { nodeId: node.nodeId, keyId: link.id, keyName, text: layerText(node), resolvedLang: value?.resolved_lang ?? "" }
    if (value === undefined || !value.present || value.content === null) {
      build.missing.push(entry)
      // Missing values keep the source text; a layer already previewing another language goes back to it.
      if (node.preview !== null) {
        build.items.push({ nodeId: node.nodeId, text: layerText(node) })
      }
      continue
    }
    const text = renderContent(value.content, { lang: request.lang, samples: choices.samples, plural: choices.plural })
    build.items.push({ nodeId: node.nodeId, text })
    if (value.inherited) {
      build.inherited.push({ ...entry, text })
    }
    if (value.exceeds_max_length && key !== undefined && key.max_length !== null) {
      build.tooLong.push({ ...entry, text, length: value.length, maxLength: key.max_length })
    }
  }
  build.items = mainsFirst(build.items)
  return build
}

// Pseudo-localization (§7.18.2, Appendix A.6) through preview-apply with source "pseudo": every text layer in scope
// (linked or not; it needs no server) shows its own source text pseudo-localized. Layers already previewing start from
// their original text. Variable-bound text is never written (§7.14). `lang` records the project's main language,
// whose text the pseudo text stands for.
export interface PseudoBuild {
  info: Omit<PreviewInfo, "appliedAt">
  items: { nodeId: string; text: string }[]
  skipped: { variable: string[] }
}

export function buildPseudoPreview(nodes: readonly ScannedNode[], mainLanguage: string): PseudoBuild {
  const build: PseudoBuild = { info: { lang: mainLanguage, source: "pseudo", variationOptionId: null }, items: [], skipped: { variable: [] } }
  for (const node of nodes) {
    if (node.boundToVariable) {
      build.skipped.variable.push(node.nodeId)
      continue
    }
    const text = layerText(node)
    if (text.trim() !== "") {
      build.items.push({ nodeId: node.nodeId, text: pseudoLocalize(text) })
    }
  }
  build.items = mainsFirst(build.items)
  return build
}

export interface PreviewStatus { lang: string; source: PreviewInfo["source"]; count: number; mixed: boolean }

// Status bar (§7.14): "Previewing {lang} ({source}) on {n} layers · Reset", from the scanned preview records.
export function previewStatus(nodes: readonly ScannedNode[]): PreviewStatus | null {
  const previewing = nodes.filter((node) => node.preview !== null)
  if (previewing.length === 0) {
    return null
  }
  const first = previewing[0].preview as PreviewInfo
  const mixed = previewing.some((node) => node.preview?.lang !== first.lang || node.preview?.source !== first.source)
  return { lang: first.lang, source: first.source, count: previewing.length, mixed }
}

// Status bar text (§7.14): "Previewing {lang} ({source}) on {n} layers"; pseudo-localization names itself.
export function previewStatusText(status: PreviewStatus): string {
  const layers = status.count === 1 ? "1 layer" : status.count + " layers"
  if (status.mixed) {
    return "Previewing several languages on " + layers
  }
  if (status.source === "pseudo") {
    return "Previewing pseudo-localization on " + layers
  }
  return "Previewing " + status.lang + " (" + sourceLabel(status.source) + ") on " + layers
}

// Previews on the current page that the header's status (built from the scan) does not show, such as those left by a
// plugin closed during an overflow report (§7.18.1) while nothing is selected: text layers that own a preview record,
// counted by main. Said only while the scan shows no preview and no task or reset runs; null otherwise.
export function leftoverPreviewNotice(input: { pagePreviews: number; scanStatus: PreviewStatus | null; busy: boolean }): string | null {
  if (input.pagePreviews <= 0 || input.scanStatus !== null || input.busy) {
    return null
  }
  const layers = input.pagePreviews === 1 ? "1 layer on this page still shows a preview." : input.pagePreviews + " layers on this page still show a preview."
  return layers + " Reset page brings back the original text."
}

export function sourceLabel(source: PreviewInfo["source"]): string {
  switch (source) {
    case "draft":
      return "draft"
    case "published":
      return "published"
    case "pseudo":
      return "pseudo"
    case "keys":
      return "key names"
  }
}

export interface ResetOutcome { edited: string[]; overrideKept: number; otherErrors: NodeError[]; done: number }

// Splits a preview-reset result: layers edited during the preview need the Keep/Restore question (§7.14 step 2).
export function resetOutcome(done: number, errors: readonly NodeError[]): ResetOutcome {
  return {
    done,
    edited: errors.filter((error) => error.code === "edited_during_preview").map((error) => error.nodeId),
    overrideKept: errors.filter((error) => error.code === "override_kept").length,
    otherErrors: errors.filter((error) => error.code !== "edited_during_preview" && error.code !== "override_kept"),
  }
}
