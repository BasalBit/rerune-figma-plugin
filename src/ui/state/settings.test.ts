import { describe, expect, it } from "vitest"
import { PROJECT_ID } from "../../../test/fixtures"
import type { FileSettings } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { applyEdit, connectProject, DEFAULT_PREFS, editOf, MIRROR_MESSAGE, parsePrefs, parseSettingsReport, REPAIR_MESSAGE, replaceServerQuestion, sameEdit, settingsOffer } from "./settings"

const API = "http://localhost:8080"

describe("prefs", () => {
  it("parses stored prefs with defaults", () => {
    expect(parsePrefs({})).toEqual(DEFAULT_PREFS)
    expect(
      parsePrefs({
        lastLanguage: "de",
        lastSource: "published",
        lastVariationOptionId: "v",
        uploadScreenshotsOnPush: false,
        inspectPlatform: "flutter",
        groupIdenticalTexts: false,
        samples: { p: { name: "Ada", n: 3 }, bad: "x" },
      }),
    ).toEqual({
      lastLanguage: "de",
      lastSource: "published",
      lastVariationOptionId: "v",
      uploadScreenshotsOnPush: false,
      inspectPlatform: "flutter",
      groupIdenticalTexts: false,
      samples: { p: { name: "Ada" } },
    })
    expect(parsePrefs({ lastSource: "weird", groupIdenticalTexts: "yes" })).toMatchObject({ lastSource: "draft", groupIdenticalTexts: true })
  })
})

describe("file settings", () => {
  const current: FileSettings = { ...newFileSettings({ apiBase: API, projectId: PROJECT_ID, projectName: "Chapter", now: 1 }), keyTemplate: "{frame}_{layer}", caseStyle: "camel", includeLocked: true }

  it("keeps naming and scan options when switching projects on the same server", () => {
    const next = connectProject(current, { id: "6a4600000000000000000999", name: "Other" }, API, 5)
    expect(next).toEqual({ ...current, projectId: "6a4600000000000000000999", projectName: "Other", updatedAt: 5 })
  })

  it("asks before replacing the settings of a file connected to another server (§7.7)", () => {
    const foreign = newFileSettings({ apiBase: "https://api.rerune.io", projectId: PROJECT_ID, projectName: "Chapter", now: 1 })
    expect(replaceServerQuestion(foreign, API, "Chapter dev")).toBe(
      "This file is connected to https://api.rerune.io. Connect it to Chapter dev on " + API + " for everyone who opens it? The plugin then stops working with the other server in this file.",
    )
    expect(replaceServerQuestion(null, API, "Chapter")).toBeNull()
    expect(replaceServerQuestion({ ...foreign, apiBase: API }, API, "Chapter")).toBeNull()
  })

  it("starts from defaults for a new file or another server", () => {
    expect(connectProject(null, { id: PROJECT_ID, name: "Chapter" }, API, 5)).toEqual(newFileSettings({ apiBase: API, projectId: PROJECT_ID, projectName: "Chapter", now: 5 }))
    expect(connectProject({ ...current, apiBase: "https://rerune.io/api" }, { id: PROJECT_ID, name: "Chapter" }, API, 5).keyTemplate).toBeNull()
  })

  it("applies edits with a fresh updatedAt", () => {
    const edit = { ...editOf(current), keyTemplate: "  ", caseStyle: "kebab" as const, includeLocked: false }
    expect(applyEdit(current, edit, 9)).toEqual({ ...current, keyTemplate: null, caseStyle: "kebab", includeLocked: false, updatedAt: 9 })
    expect(sameEdit(editOf(current), { ...editOf(current), keyTemplate: " {frame}_{layer} " })).toBe(true)
    expect(sameEdit(editOf(current), edit)).toBe(false)
  })

  it("reads the settings status from the T7 report", () => {
    expect(parseSettingsReport({ current: { source: "root", differ: true, offerMirror: false, settings: current } })).toEqual({ settings: current, source: "root", differ: true, offerMirror: false })
    expect(parseSettingsReport({ current: { source: "none", settings: null } })).toEqual({ settings: null, source: "none", differ: false, offerMirror: false })
    expect(parseSettingsReport({ current: { source: "page", settings: { v: 2 } } })?.settings).toBeNull()
    expect(parseSettingsReport(null)).toBeNull()
    expect(parseSettingsReport({})).toBeNull()
  })

  it("offers Repair when root and page differ, else the page mirror when it is missing or older (§7.7)", () => {
    expect(settingsOffer({ settings: current, source: "root", differ: true, offerMirror: true })).toEqual({ kind: "repair", settings: current, message: REPAIR_MESSAGE, action: "Repair settings" })
    expect(settingsOffer({ settings: current, source: "root", differ: false, offerMirror: true })).toEqual({
      kind: "mirror",
      settings: current,
      message: MIRROR_MESSAGE,
      action: "Use this file's ReRune settings on this page",
    })
    expect(settingsOffer({ settings: current, source: "root", differ: false, offerMirror: false })).toBeNull()
    expect(settingsOffer({ settings: null, source: "none", differ: true, offerMirror: true })).toBeNull()
    expect(settingsOffer(null)).toBeNull()
  })
})
