import { canonicalFileUrl, isFigmaFileKey, type ParsedFigmaUrl } from "./figma-url"
import type { FileSettings } from "./messages"

// The file's link to its Figma URL (§7.7, D43) and when link sync and screenshot upload may run. Pure, shared by
// main (diagnostics, tests of the pause rules) and the UI (banners, link sync, push file_key).

export type SyncPauseReason = "no_file" | "branch" | "possible_copy"
export interface SyncPause { paused: boolean; reason: SyncPauseReason | null }

// Branch files and suspected copies share node ids and the file key with the main file, so anything that writes
// or removes server-side links keyed by node id waits until the designer confirms the file (D43).
// A file key that is not an A.2 key (hand-edited plugin data) counts as no link: E17 would reject it.
export function syncPauseOf(settings: FileSettings | null, rootName: string): SyncPause {
  if (settings === null || settings.fileKey === null || !isFigmaFileKey(settings.fileKey)) {
    return { paused: true, reason: "no_file" }
  }
  if (settings.branchKey !== null) {
    return { paused: true, reason: "branch" }
  }
  if (isPossibleCopy(settings, rootName)) {
    return { paused: true, reason: "possible_copy" }
  }
  return { paused: false, reason: null }
}

// Copy heuristic (§7.7): the file's name is not the one stored when the link was pasted (Duplicate, Save as copy,
// a branch that inherited the main file's settings, or a renamed file).
export function isPossibleCopy(settings: Pick<FileSettings, "fileKey" | "fileName"> | null, rootName: string): boolean {
  return settings !== null && settings.fileKey !== null && settings.fileName !== null && settings.fileName !== rootName
}

export type LinkSyncBlock = SyncPauseReason | "no_permission"

export interface LinkSyncGate {
  enabled: boolean
  reason: LinkSyncBlock | null
  fileKey: string | null          // set only when enabled
}

export const EDIT_KEYS_PERMISSION = "edit_keys"

// §7.11: link upserts and removals run when the file has a link, is not a branch, is not a suspected copy and the
// user may edit keys (E17 needs edit_keys); otherwise they are skipped silently and a banner says why.
export function linkSyncGate(settings: FileSettings | null, rootName: string, permissions: readonly string[]): LinkSyncGate {
  const pause = syncPauseOf(settings, rootName)
  if (pause.paused) {
    return { enabled: false, reason: pause.reason, fileKey: null }
  }
  if (!permissions.includes(EDIT_KEYS_PERMISSION)) {
    return { enabled: false, reason: "no_permission", fileKey: null }
  }
  return { enabled: true, reason: null, fileKey: settings?.fileKey ?? null }
}

// E13 `file_key` (§7.13 rule 11): the push records the file's last push only for a confirmed main file. A branch or
// a suspected copy would stamp the main file's record.
export function pushFileKey(settings: FileSettings | null, rootName: string): string | null {
  return syncPauseOf(settings, rootName).paused ? null : settings?.fileKey ?? null
}

// A pasted link (§7.7): fileKey, the canonical fileUrl, fileName = the file's current name and the branch key.
// The project and the naming and scan options stay.
export function withFileLink(settings: FileSettings, link: Pick<ParsedFigmaUrl, "fileKey" | "branchKey">, rootName: string, now: number): FileSettings {
  return {
    ...settings,
    fileKey: link.fileKey,
    fileUrl: canonicalFileUrl(link.fileKey, rootName),
    fileName: rootName,
    branchKey: link.branchKey,
    updatedAt: now,
  }
}

// "This is the same file" (§7.7): the stored name follows the file's current name.
export function confirmSameFile(settings: FileSettings, rootName: string, now: number): FileSettings {
  return { ...settings, fileName: rootName, updatedAt: now }
}
