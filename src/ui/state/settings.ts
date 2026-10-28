import type { FigmaProject } from "../../shared/api-types"
import { CASE_STYLES } from "../../shared/constants"
import type { CaseStyle, FileSettings, ResolveSource } from "../../shared/messages"
import { newFileSettings, parseFileSettings } from "../../shared/plugin-data"

// File settings and prefs on the UI side (§7.7, §7.19). Writes go through main (settings-save, prefs-save).

export interface Prefs {
  lastLanguage: string | null
  lastSource: ResolveSource
  lastVariationOptionId: string | null
  uploadScreenshotsOnPush: boolean
  inspectPlatform: string | null
  groupIdenticalTexts: boolean
  samples: Record<string, Record<string, string>>
}

export const DEFAULT_PREFS: Prefs = {
  lastLanguage: null,
  lastSource: "draft",
  lastVariationOptionId: null,
  uploadScreenshotsOnPush: true,
  inspectPlatform: null,
  groupIdenticalTexts: true,
  samples: {},
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function parseSamples(value: unknown): Record<string, Record<string, string>> {
  const samples: Record<string, Record<string, string>> = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return samples
  }
  for (const projectId of Object.keys(value)) {
    const entries = (value as Record<string, unknown>)[projectId]
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
      continue
    }
    const clean: Record<string, string> = {}
    for (const name of Object.keys(entries)) {
      const sample = (entries as Record<string, unknown>)[name]
      if (typeof sample === "string") {
        clean[name] = sample
      }
    }
    samples[projectId] = clean
  }
  return samples
}

export function parsePrefs(raw: Record<string, unknown>): Prefs {
  return {
    lastLanguage: stringOrNull(raw.lastLanguage),
    lastSource: raw.lastSource === "published" ? "published" : "draft",
    lastVariationOptionId: stringOrNull(raw.lastVariationOptionId),
    uploadScreenshotsOnPush: boolOr(raw.uploadScreenshotsOnPush, DEFAULT_PREFS.uploadScreenshotsOnPush),
    inspectPlatform: stringOrNull(raw.inspectPlatform),
    groupIdenticalTexts: boolOr(raw.groupIdenticalTexts, DEFAULT_PREFS.groupIdenticalTexts),
    samples: parseSamples(raw.samples),
  }
}

// Connecting the file to a project keeps the file's naming and scan options on the same server; a file that
// belonged to another server starts from defaults (§7.7).
export function connectProject(current: FileSettings | null, project: Pick<FigmaProject, "id" | "name">, apiBase: string, now: number): FileSettings {
  if (current === null || current.apiBase !== apiBase) {
    return newFileSettings({ apiBase, projectId: project.id, projectName: project.name, now })
  }
  return { ...current, projectId: project.id, projectName: project.name, updatedAt: now }
}

export interface SettingsEdit {
  keyTemplate: string
  caseStyle: CaseStyle
  ignoreUnderscoreLayers: boolean
  includeLocked: boolean
}

export function editOf(settings: FileSettings): SettingsEdit {
  return {
    keyTemplate: settings.keyTemplate ?? "",
    caseStyle: settings.caseStyle,
    ignoreUnderscoreLayers: settings.ignoreUnderscoreLayers,
    includeLocked: settings.includeLocked,
  }
}

export function applyEdit(settings: FileSettings, edit: SettingsEdit, now: number): FileSettings {
  const template = edit.keyTemplate.trim()
  return {
    ...settings,
    keyTemplate: template === "" ? null : template,
    caseStyle: CASE_STYLES.includes(edit.caseStyle) ? edit.caseStyle : "auto",
    ignoreUnderscoreLayers: edit.ignoreUnderscoreLayers,
    includeLocked: edit.includeLocked,
    updatedAt: now,
  }
}

export function sameEdit(a: SettingsEdit, b: SettingsEdit): boolean {
  return a.keyTemplate.trim() === b.keyTemplate.trim() && a.caseStyle === b.caseStyle && a.ignoreUnderscoreLayers === b.ignoreUnderscoreLayers && a.includeLocked === b.includeLocked
}

export const CASE_STYLE_LABELS: Record<CaseStyle, string> = {
  auto: "Auto (match the project)",
  snake: "snake_case",
  camel: "camelCase",
  kebab: "kebab-case",
  pascal: "PascalCase",
  screaming: "SCREAMING_SNAKE",
  "dot.snake": "dot.snake_case",
  "dot.camel": "dot.camelCase",
  "dot.kebab": "dot.kebab-case",
  "slash.snake": "slash/snake_case",
}

// Settings resolution for the current page, read through diagnostics T7 (init has no differ/offerMirror), plus
// the file's current name (figma.root.name) for the copy heuristic (§7.7); null when the report lacks it. And the
// text layers on the current page that own a preview record (0 when the report lacks it), for previews the scan
// does not show (for example after the plugin was closed during an overflow report).
export interface SettingsStatus {
  settings: FileSettings | null
  source: "root" | "page" | "none"
  differ: boolean
  offerMirror: boolean
  rootName: string | null
  pagePreviews: number
}

export function parseSettingsReport(report: unknown): SettingsStatus | null {
  if (typeof report !== "object" || report === null) {
    return null
  }
  const current = (report as { current?: unknown }).current
  if (typeof current !== "object" || current === null) {
    return null
  }
  const value = current as { settings?: unknown; source?: unknown; differ?: unknown; offerMirror?: unknown; previews?: unknown }
  const source = value.source === "root" || value.source === "page" ? value.source : "none"
  const settings = value.settings === null || value.settings === undefined ? null : parseFileSettings(JSON.stringify(value.settings))
  const fileName = (report as { fileName?: unknown }).fileName
  const previews = typeof value.previews === "number" && Number.isInteger(value.previews) && value.previews > 0 ? value.previews : 0
  return { settings, source, differ: value.differ === true, offerMirror: value.offerMirror === true, rootName: typeof fileName === "string" ? fileName : null, pagePreviews: previews }
}

export type SettingsOffer = { kind: "repair" | "mirror"; settings: FileSettings; message: string; action: string }

export const REPAIR_MESSAGE = "The file and this page store different ReRune settings (for example after a branch merge). The newer ones are in use."
export const MIRROR_MESSAGE = "This page has no copy of the file's ReRune settings. A copy keeps them safe when branches are merged."

// §7.7: "Repair settings" when root and page differ; the page-mirror offer when the plugin opens on a page without
// a valid or current mirror. Both are explicit one-click writes of the winning settings (no silent write).
export function settingsOffer(status: SettingsStatus | null): SettingsOffer | null {
  if (status === null || status.settings === null) {
    return null
  }
  if (status.differ) {
    return { kind: "repair", settings: status.settings, message: REPAIR_MESSAGE, action: "Repair settings" }
  }
  if (status.offerMirror) {
    return { kind: "mirror", settings: status.settings, message: MIRROR_MESSAGE, action: "Use this file's ReRune settings on this page" }
  }
  return null
}

export const API_BASE_MISMATCH = "This file is connected to a different ReRune server."
export const API_BASE_MISMATCH_HINT = API_BASE_MISMATCH + " Nothing in this file changes unless you connect it to a project on this server."

// §7.7: a file connected to another server stays read-only here. Connecting it to a project on this server replaces
// the settings for everyone who opens the file, so the Project screen asks first (null: nothing to confirm).
export function replaceServerQuestion(settings: Pick<FileSettings, "apiBase"> | null, apiBase: string, projectName: string): string | null {
  if (settings === null || settings.apiBase === apiBase) {
    return null
  }
  return "This file is connected to " + settings.apiBase + ". Connect it to " + projectName + " on " + apiBase + " for everyone who opens it? The plugin then stops working with the other server in this file."
}
