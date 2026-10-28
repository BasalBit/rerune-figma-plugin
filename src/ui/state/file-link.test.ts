import { describe, expect, it, vi } from "vitest"
import { PROJECT_ID } from "../../../test/fixtures"
import type { FigmaFile, FigmaRegisterFileRequest } from "../../shared/api-types"
import { linkSyncGate, withFileLink } from "../../shared/file-link"
import type { FileSettings } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { ApiError } from "../api/client"
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
  SYNC_ON_MESSAGE,
} from "./file-link"

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
