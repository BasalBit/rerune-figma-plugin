import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import type { FileSettings } from "../shared/messages"
import { parseFileSettings, resolveFileSettings, serializeFileSettings, type ResolvedFileSettings } from "../shared/plugin-data"

// File settings live on figma.root and are mirrored to each page (§7.7). Root data reportedly does not
// survive branch merges, page data does. Pages are never loaded just to read or mirror settings.

export type SyncPauseReason = "no_file" | "branch" | "possible_copy"
export interface SyncPause { paused: boolean; reason: SyncPauseReason | null }

function readRaw(node: BaseNode): string {
  try {
    return node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)
  } catch {
    return ""
  }
}

export function readFileSettings(page: BaseNode = figma.currentPage): ResolvedFileSettings {
  return resolveFileSettings(readRaw(figma.root), readRaw(page))
}

// Writes the settings to root and the current page with a fresh updatedAt. Invalid settings throw.
export function saveFileSettings(settings: FileSettings, now: number = Date.now()): FileSettings {
  const parsed = parseFileSettings(serializeFileSettings({ ...settings, updatedAt: now }))
  if (parsed === null) {
    throw new Error("Invalid file settings")
  }
  const raw = serializeFileSettings(parsed)
  figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, raw)
  figma.currentPage.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, raw)
  return parsed
}

// Link sync and screenshot upload (Phase 2) run only for a registered, non-branch file that is not a
// suspected copy (§7.7, D43). Scan, push of text drafts and preview are never paused.
export function syncPauseOf(settings: FileSettings | null, rootName: string): SyncPause {
  if (settings === null || settings.fileKey === null) {
    return { paused: true, reason: "no_file" }
  }
  if (settings.branchKey !== null) {
    return { paused: true, reason: "branch" }
  }
  if (settings.fileName !== null && settings.fileName !== rootName) {
    return { paused: true, reason: "possible_copy" }
  }
  return { paused: false, reason: null }
}

export function isApiBaseMismatch(settings: FileSettings | null, apiBase: string): boolean {
  return settings !== null && settings.apiBase !== apiBase
}

export interface SettingsReportEntry { present: boolean; valid: boolean; updatedAt: number | null; projectId: string | null }

export function settingsReportEntry(raw: string): SettingsReportEntry {
  const parsed = parseFileSettings(raw)
  return { present: raw.trim() !== "", valid: parsed !== null, updatedAt: parsed?.updatedAt ?? null, projectId: parsed?.projectId ?? null }
}
