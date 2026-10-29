import { describe, expect, it, vi } from "vitest"
import { PROJECT_ID } from "../../../test/fixtures"
import type { FigmaFile, FigmaRegisterFileRequest } from "../../shared/api-types"
import { confirmSameFile, linkSyncGate, withFileLink } from "../../shared/file-link"
import type { FileSettings } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { ApiError, userMessage } from "../api/client"
import {
  BRANCH_MESSAGE,
  COPY_MESSAGE,
  FILE_LINK_INVALID,
  fileLinkNotice,
  fileLinkStatus,
  fileRegistration,
  NO_FILE_MESSAGE,
  NO_PERMISSION_MESSAGE,
  readFileLinkInput,
  registerFile,
  saveAndRegisterFile,
  syncsPageAfterSave,
  SYNC_ON_MESSAGE,
  type FileLinkSave,
} from "./file-link"
import { RUN_ON_LAYERS_LATER } from "./link-sync"

const FILE_KEY = "AbCdEf1234567890XyZ"
const BRANCH_KEY = "BrAnCh1234567890"
const EDITOR = ["edit_keys"]

function settings(overrides: Partial<FileSettings> = {}): FileSettings {
  return { ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }), ...overrides }
}

function registered(request: FigmaRegisterFileRequest): FigmaFile {
  return {
    file_key: FILE_KEY,
    file_name: request.file_name ?? "",
    url: request.url,
    link_count: 0,
    screenshot_count: 0,
    last_push_at: null,
    last_push_by: null,
    created_at: "2026-10-27T10:00:00Z",
    updated_at: "2026-10-27T10:00:00Z",
    outdated_screenshot_count: 0,
    refresh_requested_count: 0,
  }
}

describe("readFileLinkInput (§7.7, Appendix A.2)", () => {
  it("accepts file, design and branch links and explains anything else", () => {
    expect(readFileLinkInput("   ")).toEqual({ kind: "empty" })
    expect(readFileLinkInput("https://www.figma.com/design/" + FILE_KEY + "/Chapter?node-id=1-2")).toEqual({
      kind: "valid",
      link: { fileKey: FILE_KEY, branchKey: null, nodeId: "1:2", slug: "Chapter" },
    })
    expect(readFileLinkInput("https://www.figma.com/design/" + FILE_KEY + "/branch/" + BRANCH_KEY + "/Chapter")).toMatchObject({ kind: "valid", link: { branchKey: BRANCH_KEY } })
    expect(readFileLinkInput("https://www.figma.com/community/file/1234567890/x")).toEqual({ kind: "invalid", message: FILE_LINK_INVALID })
    expect(FILE_LINK_INVALID).toBe("Paste a Figma file link (Share → Copy link).")
  })

  it("trims a pasted link as the server does: U+0085 is space, U+FEFF is not", () => {
    const nel = String.fromCharCode(0x85)
    const bom = String.fromCharCode(0xfeff)
    expect(readFileLinkInput(nel + " ")).toEqual({ kind: "empty" })
    expect(readFileLinkInput(bom)).toEqual({ kind: "invalid", message: FILE_LINK_INVALID })
    expect(readFileLinkInput(bom + "https://www.figma.com/design/" + FILE_KEY + "/Chapter")).toEqual({ kind: "invalid", message: FILE_LINK_INVALID })
    expect(readFileLinkInput("https://www.figma.com/design/" + FILE_KEY + "/Chapter" + nel)).toMatchObject({ kind: "valid", link: { fileKey: FILE_KEY, slug: "Chapter" } })
  })
})

describe("fileLinkNotice and fileLinkStatus (§7.7, §7.11 banners)", () => {
  it("asks about a suspected copy until it is answered, and pauses sync meanwhile", () => {
    const gate = linkSyncGate(settings({ fileKey: FILE_KEY, fileName: "Chapter" }), "Chapter (Copy)", EDITOR)
    expect(gate.enabled).toBe(false)
    expect(fileLinkNotice(gate)).toEqual({ reason: "possible_copy", tone: "warning", message: COPY_MESSAGE, actions: ["same-file", "paste-link"], dismissible: false })
    expect(COPY_MESSAGE).toBe("This may be a copy of another file. Paste this file's link, or confirm it is the same file.")
  })

  it("explains branches, missing links and missing permissions", () => {
    expect(fileLinkNotice(linkSyncGate(settings({ fileKey: FILE_KEY, branchKey: BRANCH_KEY }), "Chapter", EDITOR))).toMatchObject({ reason: "branch", message: BRANCH_MESSAGE, dismissible: true })
    expect(BRANCH_MESSAGE).toBe("Links and screenshots sync after this branch is merged.")
    expect(fileLinkNotice(linkSyncGate(settings(), "Chapter", EDITOR))).toMatchObject({ reason: "no_file", message: NO_FILE_MESSAGE, actions: ["paste-link"] })
    expect(fileLinkNotice(linkSyncGate(settings({ fileKey: FILE_KEY, fileName: "Chapter" }), "Chapter", []))).toMatchObject({ reason: "no_permission", message: NO_PERMISSION_MESSAGE, actions: [] })
    expect(fileLinkNotice(linkSyncGate(settings({ fileKey: FILE_KEY, fileName: "Chapter" }), "Chapter", EDITOR))).toBeNull()
  })

  it("describes the sync state in Settings", () => {
    expect(fileLinkStatus(linkSyncGate(settings({ fileKey: FILE_KEY, fileName: "Chapter" }), "Chapter", EDITOR))).toBe(SYNC_ON_MESSAGE)
    expect(fileLinkStatus(linkSyncGate(settings({ fileKey: FILE_KEY, fileName: "Chapter" }), "Copy", EDITOR))).toBe(COPY_MESSAGE)
    expect(fileLinkStatus(linkSyncGate(settings({ fileKey: FILE_KEY, branchKey: BRANCH_KEY }), "Chapter", EDITOR))).toBe(BRANCH_MESSAGE)
    expect(fileLinkStatus(linkSyncGate(settings(), "Chapter", EDITOR))).toBe(NO_FILE_MESSAGE)
    expect(fileLinkStatus(linkSyncGate(settings({ fileKey: FILE_KEY }), "Chapter", []))).toBe(NO_PERMISSION_MESSAGE)
  })
})

describe("fileRegistration and registerFile (E14)", () => {
  const linked = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: null }, "Chapter App", 5)

  it("registers the canonical URL with the file's name, cut to 200 runes", () => {
    expect(fileRegistration(linked, "Chapter App")).toEqual({ url: "https://www.figma.com/design/" + FILE_KEY + "/Chapter-App", file_name: "Chapter App" })
    const long = "  " + "é".repeat(250)
    expect(fileRegistration({ ...linked, fileName: long }, long)).toEqual({ url: linked.fileUrl, file_name: "é".repeat(200) })
    expect(fileRegistration({ ...linked, fileUrl: null, fileName: null }, "Renamed")).toEqual({ url: "https://www.figma.com/design/" + FILE_KEY + "/Renamed", file_name: "Renamed" })
    expect(fileRegistration({ ...linked, fileName: "  " }, "  ")).toEqual({ url: linked.fileUrl })
  })

  it("trims the file's name as the server's strings.TrimSpace does: U+0085 yes, U+FEFF no", () => {
    const nel = String.fromCharCode(0x85)
    const bom = String.fromCharCode(0xfeff)
    expect(fileRegistration({ ...linked, fileName: "Chapter App" + nel }, "Chapter App" + nel)).toEqual({ url: linked.fileUrl, file_name: "Chapter App" })
    expect(fileRegistration({ ...linked, fileName: bom + "Chapter App" }, bom + "Chapter App")).toEqual({ url: linked.fileUrl, file_name: bom + "Chapter App" })
    expect(fileRegistration({ ...linked, fileName: nel }, nel)).toEqual({ url: linked.fileUrl })
  })

  it("does not register without a link or for a suspected copy", () => {
    expect(fileRegistration(settings(), "Chapter")).toBeNull()
    expect(fileRegistration({ ...linked, fileKey: "x/y" }, "Chapter App")).toBeNull()
    expect(fileRegistration(linked, "Chapter App (Copy)")).toBeNull()
  })

  it("registers the main file of a branch link without the branch's name (E14)", async () => {
    const branch = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: BRANCH_KEY }, "Chapter App – new checkout", 5)
    expect(fileRegistration(branch, "Chapter App – new checkout")).toEqual({ url: "https://www.figma.com/design/" + FILE_KEY })
    const api = { registerFile: vi.fn(async (_projectId: string, request: FigmaRegisterFileRequest) => registered(request)) }
    expect((await registerFile(api, PROJECT_ID, branch, "Chapter App – new checkout", EDITOR)).error).toBeNull()
    expect(api.registerFile).toHaveBeenCalledWith(PROJECT_ID, { url: "https://www.figma.com/design/" + FILE_KEY })
    expect(await registerFile(api, PROJECT_ID, branch, "Chapter App – new checkout", [])).toEqual({ file: null, error: null })
    expect(api.registerFile).toHaveBeenCalledTimes(1)
  })

  it("calls E14 only with edit_keys and reports failures without throwing", async () => {
    const api = { registerFile: vi.fn(async (_projectId: string, request: FigmaRegisterFileRequest) => registered(request)) }
    expect(await registerFile(api, PROJECT_ID, linked, "Chapter App", EDITOR)).toEqual({ file: registered({ url: linked.fileUrl ?? "", file_name: "Chapter App" }), error: null })
    expect(api.registerFile).toHaveBeenCalledWith(PROJECT_ID, { url: "https://www.figma.com/design/" + FILE_KEY + "/Chapter-App", file_name: "Chapter App" })

    api.registerFile.mockClear()
    expect(await registerFile(api, PROJECT_ID, linked, "Chapter App", ["publishing"])).toEqual({ file: null, error: null })
    expect(await registerFile(api, PROJECT_ID, settings(), "Chapter App", EDITOR)).toEqual({ file: null, error: null })
    expect(api.registerFile).not.toHaveBeenCalled()

    api.registerFile.mockRejectedValueOnce(new ApiError(400, "invalid_figma_url", "invalid figma url"))
    expect(await registerFile(api, PROJECT_ID, linked, "Chapter App", EDITOR)).toEqual({
      file: null,
      error: "The link is saved in this file, but ReRune couldn't register it: Paste a Figma file link (Share → Copy link).",
    })
  })
})

describe("saveAndRegisterFile: the page sync after a saved or confirmed file link (§7.7)", () => {
  const API_BASE = "http://localhost:8080"
  const pasted = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: null }, "Chapter App", 5)

  // Records the order of save, E14 and the page sync request; `register` answers E14.
  function harness(register: (request: FigmaRegisterFileRequest) => Promise<FigmaFile> = async (request) => registered(request)) {
    const calls: string[] = []
    const api = {
      registerFile: vi.fn(async (_projectId: string, request: FigmaRegisterFileRequest) => {
        calls.push("register")
        return register(request)
      }),
    }
    const save = vi.fn<(next: FileSettings) => Promise<void>>(async () => {
      calls.push("save")
    })
    const requestPageSync = vi.fn(() => {
      calls.push("sync-page")
    })
    return { calls, api, save, requestPageSync, deps: { api, apiBase: API_BASE, save, requestPageSync } }
  }

  function input(next: FileSettings, overrides: Partial<FileLinkSave> = {}): FileLinkSave {
    return { projectId: PROJECT_ID, permissions: EDITOR, settings: next, rootName: "Chapter App", ...overrides }
  }

  it("syncs the page after a pasted link once the file is saved and registered", async () => {
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input(pasted))).toBeNull()
    expect(run.calls).toEqual(["save", "register", "sync-page"])
    expect(run.save).toHaveBeenCalledWith(pasted)
  })

  it("syncs the page after This is the same file, which resumes a paused sync", async () => {
    const copy = { ...pasted, fileName: "Chapter App" }
    expect(linkSyncGate(copy, "Chapter App (Copy)", EDITOR).reason).toBe("possible_copy")
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input(confirmSameFile(copy, "Chapter App (Copy)", 6), { rootName: "Chapter App (Copy)" }))).toBeNull()
    expect(run.calls).toEqual(["save", "register", "sync-page"])
  })

  it.each([
    ["network", new ApiError(0, "network", "Can't reach ReRune. Check your connection.")],
    ["403", new ApiError(403, null, "You don't have permission to do that.")],
    ["429", new ApiError(429, null, "Too many requests. Wait a moment and try again.")],
  ])("keeps the link saved, does not sync and says how to share the links later when E14 failed (%s)", async (_label, failure) => {
    const run = harness(async () => Promise.reject(failure))
    const warning = await saveAndRegisterFile(run.deps, input(pasted))
    expect(warning).toBe("The link is saved in this file, but ReRune couldn't register it: " + userMessage(failure) + " " + RUN_ON_LAYERS_LATER)
    expect(run.calls).toEqual(["save", "register"])
  })

  it("does not point to Sync links on this page when E14 failed for a branch link (sync waits for the merge)", async () => {
    const branch = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: BRANCH_KEY }, "Chapter App", 5)
    const run = harness(async () => Promise.reject(new ApiError(0, "network", "Can't reach ReRune. Check your connection.")))
    expect(await saveAndRegisterFile(run.deps, input(branch))).toBe("The link is saved in this file, but ReRune couldn't register it: Can't reach ReRune. Check your connection.")
  })

  it("does not sync without edit_keys: nothing is registered and links stay in the file", async () => {
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input(pasted, { permissions: ["publishing"] }))).toBeNull()
    expect(run.calls).toEqual(["save"])
  })

  it("does not sync for a branch link: the main file is registered, sync waits for the merge", async () => {
    const branch = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: BRANCH_KEY }, "Chapter App", 5)
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input(branch))).toBeNull()
    expect(run.calls).toEqual(["save", "register"])
  })

  it("does not sync while sync is paused for a suspected copy", async () => {
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input(pasted, { rootName: "Chapter App (Copy)" }))).toBeNull()
    expect(run.calls).toEqual(["save"])
  })

  it("does not sync settings of another ReRune server (read-only)", async () => {
    const run = harness()
    expect(await saveAndRegisterFile(run.deps, input({ ...pasted, apiBase: "https://rerune.io/api" }))).toBeNull()
    expect(run.calls).toEqual(["save", "register"])
  })

  it("neither registers nor syncs when the settings could not be saved", async () => {
    const run = harness()
    run.save.mockRejectedValueOnce(new Error("The settings couldn't be saved."))
    await expect(saveAndRegisterFile(run.deps, input(pasted))).rejects.toThrow("The settings couldn't be saved.")
    expect(run.api.registerFile).not.toHaveBeenCalled()
    expect(run.requestPageSync).not.toHaveBeenCalled()
  })

  it("needs a registered file and the link sync gate (syncsPageAfterSave)", () => {
    const on = linkSyncGate(pasted, "Chapter App", EDITOR)
    const file = registered({ url: pasted.fileUrl ?? "" })
    expect(syncsPageAfterSave({ file, error: null }, on)).toBe(true)
    expect(syncsPageAfterSave({ file: null, error: null }, on)).toBe(false)
    expect(syncsPageAfterSave({ file: null, error: "The link is saved in this file, but ReRune couldn't register it: boom" }, on)).toBe(false)
    for (const reason of ["no_file", "branch", "possible_copy", "no_permission"] as const) {
      expect(syncsPageAfterSave({ file, error: null }, { enabled: false, reason, fileKey: null })).toBe(false)
    }
  })
})
