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

// Settings resolution for the current page, read through diagnostics T7 (init has no differ/offerMirror).
export interface SettingsStatus {
  settings: FileSettings | null
  source: "root" | "page" | "none"
  differ: boolean
  offerMirror: boolean
}

export function parseSettingsReport(report: unknown): SettingsStatus | null {
  if (typeof report !== "object" || report === null) {
    return null
  }
  const current = (report as { current?: unknown }).current
  if (typeof current !== "object" || current === null) {
    return null
  }
  const value = current as { settings?: unknown; source?: unknown; differ?: unknown; offerMirror?: unknown }
  const source = value.source === "root" || value.source === "page" ? value.source : "none"
  const settings = value.settings === null || value.settings === undefined ? null : parseFileSettings(JSON.stringify(value.settings))
  return { settings, source, differ: value.differ === true, offerMirror: value.offerMirror === true }
}

export const API_BASE_MISMATCH = "This file is connected to a different ReRune server."
