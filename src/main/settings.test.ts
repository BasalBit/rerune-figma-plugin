import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakePage, installFigma, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import type { FileSettings } from "../shared/messages"
import { newFileSettings, serializeFileSettings } from "../shared/plugin-data"
import { isApiBaseMismatch, readFileSettings, saveFileSettings, settingsReportEntry, syncPauseOf } from "./settings"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const PROJECT = "6a4600000000000000000c35"

function settings(overrides: Partial<FileSettings> = {}): FileSettings {
  return { ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT, projectName: "Chapter", now: 100 }), ...overrides }
}

function put(node: { setSharedPluginData(ns: string, key: string, value: string): void }, value: FileSettings | string): void {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, typeof value === "string" ? value : serializeFileSettings(value))
}

describe("readFileSettings (§7.7 read order)", () => {
  it("reports none when neither root nor page has settings", () => {
    expect(readFileSettings()).toEqual({ settings: null, source: "none", differ: false, offerMirror: false })
  })

  it("uses root and offers the page mirror when the page has none", () => {
    put(figmaMock.root, settings())
    expect(readFileSettings()).toEqual({ settings: settings(), source: "root", differ: false, offerMirror: true })
  })

  it("falls back to the page mirror when root data is missing or invalid (branch merge)", () => {
    put(figmaMock.root, "{broken")
    put(figmaMock.currentPage, settings({ projectName: "From page" }))
    expect(readFileSettings()).toMatchObject({ source: "page", differ: false, settings: { projectName: "From page" } })
  })

  it("lets the newer updatedAt win when both are valid and differ, without writing", () => {
    put(figmaMock.root, settings({ updatedAt: 100 }))
    put(figmaMock.currentPage, settings({ updatedAt: 200, keyTemplate: "{screen}_{element}" }))
    const resolved = readFileSettings()
    expect(resolved).toMatchObject({ source: "page", differ: true, offerMirror: false, settings: { keyTemplate: "{screen}_{element}" } })
    expect(figmaMock.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).toBe(serializeFileSettings(settings({ updatedAt: 100 })))
  })

  it("offers the mirror when the page copy is older", () => {
    put(figmaMock.root, settings({ updatedAt: 300, caseStyle: "camel" }))
    put(figmaMock.currentPage, settings({ updatedAt: 200 }))
    expect(readFileSettings()).toMatchObject({ source: "root", differ: true, offerMirror: true, settings: { caseStyle: "camel" } })
  })

  it("reads the page passed in (current page by default)", () => {
    const other = fakePage("5:1", "Other")
    put(other, settings({ projectName: "Other page" }))
    expect(readFileSettings(other as unknown as PageNode).settings?.projectName).toBe("Other page")
  })
})

describe("saveFileSettings", () => {
  it("writes the same JSON to root and the current page with a fresh updatedAt", () => {
    const saved = saveFileSettings(settings({ updatedAt: 1 }), 5000)
    expect(saved.updatedAt).toBe(5000)
    const raw = serializeFileSettings(saved)
    expect(figmaMock.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).toBe(raw)
    expect(figmaMock.currentPage.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).toBe(raw)
    expect(readFileSettings()).toEqual({ settings: saved, source: "root", differ: false, offerMirror: false })
  })

  it("repairs differing copies by saving the winner to both", () => {
    put(figmaMock.root, settings({ updatedAt: 100 }))
    put(figmaMock.currentPage, settings({ updatedAt: 200, caseStyle: "kebab" }))
    const winner = readFileSettings().settings as FileSettings
    saveFileSettings(winner, 300)
    expect(readFileSettings()).toMatchObject({ differ: false, settings: { caseStyle: "kebab", updatedAt: 300 } })
  })

  it("refuses invalid settings", () => {
    expect(() => saveFileSettings(settings({ projectId: "nope" }))).toThrow("Invalid file settings")
    expect(figmaMock.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).toBe("")
  })
})

describe("syncPauseOf (D43: branch / paused settings block link sync)", () => {
  it("pauses without a registered file", () => {
    expect(syncPauseOf(null, "Chapter")).toEqual({ paused: true, reason: "no_file" })
    expect(syncPauseOf(settings(), "Chapter")).toEqual({ paused: true, reason: "no_file" })
  })

  it("pauses link sync and screenshots in branch files", () => {
    expect(syncPauseOf(settings({ fileKey: "abc", fileName: "Chapter", branchKey: "br1" }), "Chapter")).toEqual({ paused: true, reason: "branch" })
  })

  it("pauses for a suspected copy (file name changed)", () => {
    expect(syncPauseOf(settings({ fileKey: "abc", fileName: "Chapter" }), "Chapter (Copy)")).toEqual({ paused: true, reason: "possible_copy" })
  })

  it("runs for the registered file", () => {
    expect(syncPauseOf(settings({ fileKey: "abc", fileName: "Chapter" }), "Chapter")).toEqual({ paused: false, reason: null })
  })
})

describe("settings helpers", () => {
  it("detects a different ReRune server", () => {
    expect(isApiBaseMismatch(settings(), "http://localhost:8080")).toBe(false)
    expect(isApiBaseMismatch(settings(), "https://rerune.io/api")).toBe(true)
    expect(isApiBaseMismatch(null, "https://rerune.io/api")).toBe(false)
  })

  it("summarises raw settings for diagnostics", () => {
    expect(settingsReportEntry("")).toEqual({ present: false, valid: false, updatedAt: null, projectId: null })
    expect(settingsReportEntry("{x")).toEqual({ present: true, valid: false, updatedAt: null, projectId: null })
    expect(settingsReportEntry(serializeFileSettings(settings()))).toEqual({ present: true, valid: true, updatedAt: 100, projectId: PROJECT })
  })
})
