import { describe, expect, it } from "vitest"
import { confirmSameFile, isPossibleCopy, linkSyncGate, pushFileKey, syncPauseOf, withFileLink } from "./file-link"
import { parseFigmaUrl } from "./figma-url"
import type { FileSettings } from "./messages"
import { newFileSettings, parseFileSettings, serializeFileSettings } from "./plugin-data"

const PROJECT = "6a4600000000000000000c35"
const FILE_KEY = "AbCdEf1234567890XyZ"
const BRANCH_KEY = "BrAnCh1234567890"
const EDITOR = ["edit_keys", "publishing"]

function settings(overrides: Partial<FileSettings> = {}): FileSettings {
  return { ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT, projectName: "Chapter", now: 100 }), ...overrides }
}

function linked(overrides: Partial<FileSettings> = {}): FileSettings {
  return settings({ fileKey: FILE_KEY, fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter", fileName: "Chapter", ...overrides })
}

describe("pause rules (§7.7, D43)", () => {
  it("pauses without a file link, or with a file key that is not an A.2 key", () => {
    expect(syncPauseOf(null, "Chapter")).toEqual({ paused: true, reason: "no_file" })
    expect(syncPauseOf(settings(), "Chapter")).toEqual({ paused: true, reason: "no_file" })
    expect(syncPauseOf(linked({ fileKey: "ab/cd" }), "Chapter")).toEqual({ paused: true, reason: "no_file" })
  })

  it("pauses in a branch file before checking the name", () => {
    expect(syncPauseOf(linked({ branchKey: BRANCH_KEY }), "Chapter")).toEqual({ paused: true, reason: "branch" })
    expect(syncPauseOf(linked({ branchKey: BRANCH_KEY }), "Another name")).toEqual({ paused: true, reason: "branch" })
  })

  it("pauses while the file name differs from the stored one (suspected copy)", () => {
    expect(syncPauseOf(linked(), "Chapter (Copy)")).toEqual({ paused: true, reason: "possible_copy" })
    expect(isPossibleCopy(linked(), "Chapter (Copy)")).toBe(true)
    expect(isPossibleCopy(linked({ fileName: null }), "Chapter (Copy)")).toBe(false)
    expect(isPossibleCopy(settings(), "Chapter (Copy)")).toBe(false)
    expect(isPossibleCopy(null, "Chapter")).toBe(false)
  })

  it("runs for the confirmed main file", () => {
    expect(syncPauseOf(linked(), "Chapter")).toEqual({ paused: false, reason: null })
    expect(syncPauseOf(linked({ fileName: null }), "Whatever")).toEqual({ paused: false, reason: null })
  })
})

describe("linkSyncGate (§7.11)", () => {
  it("enables link sync only for a confirmed main file and a user with edit_keys", () => {
    expect(linkSyncGate(linked(), "Chapter", EDITOR)).toEqual({ enabled: true, reason: null, fileKey: FILE_KEY })
    expect(linkSyncGate(linked(), "Chapter", ["publishing"])).toEqual({ enabled: false, reason: "no_permission", fileKey: null })
    expect(linkSyncGate(settings(), "Chapter", EDITOR)).toEqual({ enabled: false, reason: "no_file", fileKey: null })
    expect(linkSyncGate(linked({ branchKey: BRANCH_KEY }), "Chapter", EDITOR)).toEqual({ enabled: false, reason: "branch", fileKey: null })
    expect(linkSyncGate(linked(), "Chapter (Copy)", EDITOR)).toEqual({ enabled: false, reason: "possible_copy", fileKey: null })
  })

  it("reports the file's state before the missing permission", () => {
    expect(linkSyncGate(linked({ branchKey: BRANCH_KEY }), "Chapter", []).reason).toBe("branch")
    expect(linkSyncGate(null, "Chapter", []).reason).toBe("no_file")
  })
})

describe("pushFileKey (E13 file_key, §7.13 rule 11)", () => {
  it("sends the file key only for a confirmed main file", () => {
    expect(pushFileKey(linked(), "Chapter")).toBe(FILE_KEY)
    expect(pushFileKey(linked({ branchKey: BRANCH_KEY }), "Chapter")).toBeNull()
    expect(pushFileKey(linked(), "Chapter (Copy)")).toBeNull()
    expect(pushFileKey(settings(), "Chapter")).toBeNull()
    expect(pushFileKey(null, "Chapter")).toBeNull()
  })
})

describe("withFileLink and confirmSameFile (§7.7)", () => {
  it("stores the key, the canonical URL, the current file name and no branch for a file link", () => {
    const parsed = parseFigmaUrl("https://www.figma.com/design/" + FILE_KEY + "/Old-Name?node-id=12-345&t=abc")
    expect(parsed).not.toBeNull()
    const next = withFileLink(settings({ keyTemplate: "{frame}_{layer}", caseStyle: "camel" }), parsed!, "Chapter App", 500)
    expect(next).toMatchObject({
      projectId: PROJECT,
      keyTemplate: "{frame}_{layer}",
      caseStyle: "camel",
      fileKey: FILE_KEY,
      fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter-App",
      fileName: "Chapter App",
      branchKey: null,
      updatedAt: 500,
    })
    expect(parseFileSettings(serializeFileSettings(next))).toEqual(next)
    expect(syncPauseOf(next, "Chapter App").paused).toBe(false)
  })

  it("stores the branch key of a branch link, which pauses sync", () => {
    const parsed = parseFigmaUrl("https://www.figma.com/design/" + FILE_KEY + "/branch/" + BRANCH_KEY + "/Chapter")
    const next = withFileLink(settings(), parsed!, "Chapter", 500)
    expect(next).toMatchObject({ fileKey: FILE_KEY, fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter", branchKey: BRANCH_KEY })
    expect(syncPauseOf(next, "Chapter")).toEqual({ paused: true, reason: "branch" })
  })

  it("replaces an earlier link, branch included", () => {
    const branch = withFileLink(settings(), { fileKey: FILE_KEY, branchKey: BRANCH_KEY }, "Chapter", 500)
    const main = withFileLink(branch, { fileKey: "ZyX0987654321fEdCbA", branchKey: null }, "Chapter", 600)
    expect(main).toMatchObject({ fileKey: "ZyX0987654321fEdCbA", branchKey: null, updatedAt: 600 })
  })

  it("'This is the same file' takes the file's current name and resumes sync", () => {
    const copy = linked()
    expect(syncPauseOf(copy, "Chapter v2").reason).toBe("possible_copy")
    const confirmed = confirmSameFile(copy, "Chapter v2", 700)
    expect(confirmed).toEqual({ ...copy, fileName: "Chapter v2", updatedAt: 700 })
    expect(syncPauseOf(confirmed, "Chapter v2")).toEqual({ paused: false, reason: null })
  })
})
