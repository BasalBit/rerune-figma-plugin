import type { FigmaLanguage, FigmaProject, FigmaResolvedKey } from "../../shared/api-types"
import { renderContent } from "../../shared/icu"
import type { NodeError, PreviewInfo, ResolveSource, ScannedNode } from "../../shared/messages"
import { layerText } from "../../shared/sync-state"
import type { FigmaApi } from "../api/figma-api"
import { mainsFirst } from "./ops"
import { resolveInChunks } from "./remote"

// Preview (§7.14 UI rules, D24): resolve linked keys for one language, write the values with preview-apply,
// keep the source text where a translation is missing and list those layers.

export type PreviewMode = ResolveSource | "keys"

export interface PreviewRequest { lang: string; mode: PreviewMode; variationOptionId: string | null }

export interface PreviewEntry { nodeId: string; keyId: string; keyName: string; text: string; resolvedLang: string }

export interface PreviewBuild {
  info: Omit<PreviewInfo, "appliedAt">
  items: { nodeId: string; text: string }[]
  missing: PreviewEntry[]
  inherited: PreviewEntry[]
  skipped: { variable: string[]; otherProject: number; unlinked: number }
}

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
): PreviewBuild {
  const build: PreviewBuild = {
    info: { lang: request.lang, source: request.mode, variationOptionId: request.mode === "keys" ? null : request.variationOptionId },
    items: [],
    missing: [],
    inherited: [],
    skipped: { variable: [], otherProject: 0, unlinked: 0 },
  }
  for (const node of nodes) {
    const link = node.link
    if (link === null || !PREVIEW_LINK_STATES.includes(node.linkState)) {
      build.skipped.unlinked++
      continue
    }
    if (link.p !== projectId) {
      build.skipped.otherProject++
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
    const text = renderContent(value.content, { lang: request.lang })
    build.items.push({ nodeId: node.nodeId, text })
    if (value.inherited) {
      build.inherited.push({ ...entry, text })
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
