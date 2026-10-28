import type { FigmaFile, FigmaRegisterFileRequest } from "../../shared/api-types"
import { EDIT_KEYS_PERMISSION, isPossibleCopy, linkSyncGate, type LinkSyncBlock, type LinkSyncGate } from "../../shared/file-link"
import { canonicalFileUrl, fileKeyUrl, isFigmaFileKey, parseFigmaUrl, type ParsedFigmaUrl } from "../../shared/figma-url"
import type { FileSettings } from "../../shared/messages"
import { firstRunes, trimSpace } from "../../shared/text"
import { REASON_MESSAGES, userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { RUN_ON_LAYERS_LATER } from "./link-sync"
import { connectedSettings } from "./navigation"

// The pasted file link (§7.7, Phase 2): input validation, E14 registration and the banners that explain why link
// sync is off (§7.11: skipped silently, "a banner explains how to enable").

export const FILE_LINK_INVALID = REASON_MESSAGES.invalid_figma_url
export const FILE_NAME_MAX_RUNES = 200

export type FileLinkInput = { kind: "empty" } | { kind: "invalid"; message: string } | { kind: "valid"; link: ParsedFigmaUrl }

export function readFileLinkInput(text: string): FileLinkInput {
  if (trimSpace(text) === "") {
    return { kind: "empty" }
  }
  const link = parseFigmaUrl(text)
  return link === null ? { kind: "invalid", message: FILE_LINK_INVALID } : { kind: "valid", link }
}

export const COPY_MESSAGE = "This may be a copy of another file. Paste this file's link, or confirm it is the same file."
export const BRANCH_MESSAGE = "Links and screenshots sync after this branch is merged."
export const NO_FILE_MESSAGE = "Paste this file's Figma link (Share → Copy link) so ReRune can show where each key is used. Until then, links stay in this file."
export const NO_PERMISSION_MESSAGE = "Links aren't shared with ReRune because you can't edit keys in this project. Ask an organisation administrator for the Edit keys permission."
export const SYNC_ON_MESSAGE = "Layer links are shared with ReRune, so it shows where each key is used."

export type FileLinkAction = "same-file" | "paste-link"

export interface FileLinkNotice {
  reason: LinkSyncBlock
  tone: "info" | "warning"
  message: string
  actions: FileLinkAction[]
  dismissible: boolean
}

// The banner above the workspace while link sync is off. The copy banner stays until the designer answers it:
// sync is paused while it shows (§7.7).
export function fileLinkNotice(gate: LinkSyncGate): FileLinkNotice | null {
  switch (gate.reason) {
    case null:
      return null
    case "possible_copy":
      return { reason: gate.reason, tone: "warning", message: COPY_MESSAGE, actions: ["same-file", "paste-link"], dismissible: false }
    case "branch":
      return { reason: gate.reason, tone: "info", message: BRANCH_MESSAGE, actions: ["paste-link"], dismissible: true }
    case "no_file":
      return { reason: gate.reason, tone: "info", message: NO_FILE_MESSAGE, actions: ["paste-link"], dismissible: true }
    case "no_permission":
      return { reason: gate.reason, tone: "info", message: NO_PERMISSION_MESSAGE, actions: [], dismissible: true }
  }
}

export const FILE_LINK_ACTION_LABELS: Record<FileLinkAction, string> = {
  "same-file": "This is the same file",
  "paste-link": "Paste link",
}

// One line for the Settings screen.
export function fileLinkStatus(gate: LinkSyncGate): string {
  switch (gate.reason) {
    case null:
      return SYNC_ON_MESSAGE
    case "possible_copy":
      return COPY_MESSAGE
    case "branch":
      return BRANCH_MESSAGE
    case "no_file":
      return NO_FILE_MESSAGE
    case "no_permission":
      return NO_PERMISSION_MESSAGE
  }
}

type FileLinkFields = Pick<FileSettings, "fileKey" | "fileUrl" | "fileName" | "branchKey">

// E14 body for the file's link: the canonical URL and the file's name, cut to 200 runes. A branch link registers
// the main file (E14 registers the URL's first key), but the branch's name is not the main file's: the request
// then has no file_name and a URL without slug, so the server keeps the name of a registered main file and leaves
// a new row unnamed, as links do (D15). A suspected copy is not registered: it would register the original under
// the copy's name (sync waits for it anyway, D43).
export function fileRegistration(settings: FileLinkFields, rootName: string): FigmaRegisterFileRequest | null {
  if (settings.fileKey === null || !isFigmaFileKey(settings.fileKey) || isPossibleCopy(settings, rootName)) {
    return null
  }
  if (settings.branchKey !== null) {
    return { url: fileKeyUrl(settings.fileKey) }
  }
  const url = settings.fileUrl ?? canonicalFileUrl(settings.fileKey, rootName)
  const name = firstRunes(trimSpace(rootName), FILE_NAME_MAX_RUNES)
  return name === "" ? { url } : { url, file_name: name }
}

export interface RegistrationResult { file: FigmaFile | null; error: string | null }

// PUT /figma/projects/{id}/files after a link is pasted or confirmed (§7.7), only with edit_keys; failures are
// reported but never undo the saved settings (links register the file themselves, D15).
export async function registerFile(
  api: Pick<FigmaApi, "registerFile">,
  projectId: string,
  settings: FileLinkFields,
  rootName: string,
  permissions: readonly string[],
): Promise<RegistrationResult> {
  const request = fileRegistration(settings, rootName)
  if (request === null || !permissions.includes(EDIT_KEYS_PERMISSION)) {
    return { file: null, error: null }
  }
  try {
    return { file: await api.registerFile(projectId, request), error: null }
  } catch (error) {
    return { file: null, error: "The link is saved in this file, but ReRune couldn't register it: " + userMessage(error) }
  }
}

// After a pasted link or "This is the same file" (§7.7), the links made while sync was off (no link yet, a
// suspected copy) are in the file only: link, unlink and push send just the layers they change. So the current
// page is synced once, when E14 registered the file and link sync is now on, by the gate of the button and of
// link, unlink and push (§7.11).
export function syncsPageAfterSave(registration: RegistrationResult, gate: LinkSyncGate): boolean {
  return registration.error === null && registration.file !== null && gate.enabled
}

export interface FileLinkSaveDeps {
  api: Pick<FigmaApi, "registerFile">
  apiBase: string                            // this build's server: settings of another server are read-only
  save(settings: FileSettings): Promise<void>
  requestPageSync(): void                    // the app runs "Sync links on this page" once it is free (createPageSync)
}

export interface FileLinkSave {
  projectId: string
  permissions: readonly string[]
  settings: FileSettings                     // with the pasted link (withFileLink) or the confirmed name (confirmSameFile)
  rootName: string
}

// Saves the settings, registers the file (E14) and asks for the page sync when syncsPageAfterSave says so. Returns
// E14's warning, or null; with link sync on, the warning says how to share the links made before (links register
// the file themselves, D15). A failed save throws; a failed registration or sync never undoes the saved link.
export async function saveAndRegisterFile(deps: FileLinkSaveDeps, save: FileLinkSave): Promise<string | null> {
  await deps.save(save.settings)
  const registration = await registerFile(deps.api, save.projectId, save.settings, save.rootName, save.permissions)
  const gate = linkSyncGate(connectedSettings({ apiBase: deps.apiBase, settings: save.settings }), save.rootName, save.permissions)
  if (syncsPageAfterSave(registration, gate)) {
    deps.requestPageSync()
  }
  return registration.error !== null && gate.enabled ? registration.error + " " + RUN_ON_LAYERS_LATER : registration.error
}
