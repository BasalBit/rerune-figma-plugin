import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fakeComponent,
  fakeFrame,
  fakeInstance,
  fakePage,
  fakeSection,
  fakeText,
  installFigma,
  onPage,
  uninstallFigma,
  type FakeNode,
  type FigmaMock,
} from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import { newFileSettings, serializeDiagMarker, serializeFileSettings, serializeLink } from "../shared/plugin-data"
import { clearFontCache } from "./fonts"
import { runDevModeProbe, runReadDiagnostic, runWriteDiagnostic, type DiagnosticsContext } from "./diagnostics"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
  clearFontCache()
})

afterEach(() => {
  uninstallFigma()
})

const CONTEXT: DiagnosticsContext = { env: "development", apiBase: "http://localhost:8080", startup: { skipInvisibleInstanceChildren: false, command: "" } }

type Report = Record<string, unknown>

function linkJson(nid: string): string {
  return serializeLink({ v: 1, id: keyId(1), k: "checkout_pay_button", p: PROJECT_ID, src: src("Pay now"), nid, t: 1 })
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03])
}

function exporter(bounds: { width: number; height: number }) {
  return vi.fn(async (settings: ExportSettingsImage) => {
    const constraint = settings.constraint ?? { type: "SCALE", value: 1 }
    const scale = constraint.type === "SCALE" ? constraint.value : constraint.type === "WIDTH" ? constraint.value / bounds.width : constraint.value / bounds.height
    const width = Math.round(bounds.width * scale)
    const height = Math.round(bounds.height * scale)
    return settings.format === "PNG" ? png(width, height) : jpeg(width, height)
  })
}

describe("T1 (link survival)", () => {
  it("marks the selected text and finds markers, copies and instance patterns on the page", async () => {
    const a = fakeText("1:1", "Pay now")
    const b = fakeText("1:2", "Cancel")
    onPage(figmaMock, [fakeFrame("1:0", "Checkout", [a, b])], [a])
    const mark = (await runWriteDiagnostic("T1-mark", 123)) as Report
    expect(mark).toMatchObject({ test: "T1-mark", marked: 1, nodes: [{ nodeId: "1:1", name: "Pay now" }], failed: [] })
    const copy = fakeText("2:1", "Pay now")
    copy.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag, a.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag))
    const sub = fakeText("I9:9;1:1", "Pay now")
    sub.inheritFrom = a
    onPage(figmaMock, [copy, fakeInstance("9:9", "Instance", [sub])])
    const check = (await runReadDiagnostic("T1-check", CONTEXT)) as Report
    expect(check).toMatchObject({ test: "T1-check", found: 3, criteriaMatches: 3, truncated: false })
    expect(check.nodes).toEqual([
      { nodeId: "1:1", nid: "1:1", sameId: true, instancePattern: false, name: "Pay now", markedAt: 123, matchedByCriteria: true },
      { nodeId: "2:1", nid: "1:1", sameId: false, instancePattern: false, name: "Pay now", markedAt: 123, matchedByCriteria: true },
      { nodeId: "I9:9;1:1", nid: "1:1", sameId: false, instancePattern: true, name: "Pay now", markedAt: 123, matchedByCriteria: true },
    ])
  })

  it("reports invalid markers", async () => {
    const node = fakeText("1:1", "x")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag, "{bad")
    onPage(figmaMock, [node])
    const check = (await runReadDiagnostic("T1-check", CONTEXT)) as Report
    expect(check.nodes).toEqual([{ nodeId: "1:1", name: "x", invalid: "{bad" }])
  })
})

describe("T2 (instances)", () => {
  function setup(overrides: () => { id: string; overriddenFields: string[] }[] = () => []) {
    const mainText = fakeText("5:67", "Pay now")
    mainText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, linkJson("5:67"))
    const component = fakeComponent("5:1", "Button", [mainText])
    const sub = fakeText("I12:34;5:67", "Pay now")
    sub.inheritFrom = mainText
    const instance = fakeInstance("12:34", "Button", [sub], { overrides, mainComponent: component })
    onPage(figmaMock, [component, instance], [instance])
    return { mainText, sub, instance }
  }

  it("needs a selected instance", async () => {
    expect(await runReadDiagnostic("T2-instances", CONTEXT)).toMatchObject({ error: expect.any(String) })
    expect(await runWriteDiagnostic("T2-clear", 1)).toMatchObject({ error: expect.any(String) })
  })

  it("reports inherited data, the criteria filter, the classification and every ancestor's overrides", async () => {
    setup()
    figmaMock.criteriaSkipsInherited = true
    const report = (await runReadDiagnostic("T2-instances", CONTEXT)) as { instances: Report[] }
    expect(report.instances[0]).toMatchObject({
      instanceId: "12:34",
      mainComponent: { id: "5:1", name: "Button", remote: false },
      textCount: 1,
      criteriaCount: 0,
      sublayers: [
        {
          nodeId: "I12:34;5:67",
          hasLinkData: true,
          nid: "5:67",
          key: "checkout_pay_button",
          ownPluginDataOverride: false,
          textOverridden: false,
          classification: "inherited",
          idPatternInherited: true,
          matchedByCriteria: false,
        },
      ],
      overrides: [{ instanceId: "12:34", name: "Button", overrides: [] }],
    })
  })

  it("T2-clear: clears with an empty string, writes an own link and re-reads the overrides", async () => {
    const { sub } = setup()
    const instance = (figmaMock.currentPage.selection as FakeNode[])[0]
    Object.defineProperty(instance, "overrides", {
      get: () => (sub.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE).length > 0 ? [{ id: "I12:34;5:67", overriddenFields: ["pluginData"] }] : []),
      configurable: true,
    })
    const steps: string[] = []
    const write = sub.setSharedPluginData
    sub.setSharedPluginData = (namespace: string, key: string, value: string) => {
      steps.push(value === "" ? "clear" : "write")
      write(namespace, key, value)
    }
    figmaMock.commitUndo.mockImplementation(() => steps.push("commit"))
    const report = (await runWriteDiagnostic("T2-clear", 50)) as Report
    expect(steps).toEqual(["clear", "commit", "write"])
    expect(report).toMatchObject({
      test: "T2-clear",
      nodeId: "I12:34;5:67",
      inheritedNid: "5:67",
      clearWithEmptyString: { readBack: linkJson("5:67"), cleared: false },
      ownLinkWrite: { error: null, listedAsPluginDataOverride: true, stateAfter: "ok" },
    })
  })
})

describe("T3 / T4 (export)", () => {
  it("T3 exports both formats with and without absolute bounds and checks the decoded size", async () => {
    const frame = fakeFrame("1:1", "Checkout", [], {
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 800 },
      absoluteRenderBounds: { x: -10, y: -10, width: 420, height: 830 },
      opacity: 1,
      fills: [],
    })
    frame.exportAsync = vi.fn(async (settings: ExportSettingsImage) => {
      const area = settings.useAbsoluteBounds ? { width: 400, height: 800 } : { width: 420, height: 830 }
      return exporter(area)(settings)
    })
    onPage(figmaMock, [frame], [frame])
    const report = (await runReadDiagnostic("T3-export", CONTEXT)) as Report & { exports: Report[] }
    expect(report).toMatchObject({ test: "T3-export", frameId: "1:1", opaqueBackground: false, plan: { scale: 1 } })
    expect(report.exports).toHaveLength(8)
    expect(report.exports.every((row) => row.matches === true)).toBe(true)
    expect(report.exports[1]).toMatchObject({ format: "JPG", useAbsoluteBounds: true, constraint: { type: "WIDTH", value: 200 }, decoded: { width: 200, height: 400 } })
    expect(report.jpgSample).toBeInstanceOf(Uint8Array)
  })

  it("T3 needs a frame and reports export errors", async () => {
    expect(await runReadDiagnostic("T3-export", CONTEXT)).toMatchObject({ error: "Select a frame." })
    const frame = fakeFrame("1:1", "Broken", [], { absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, absoluteRenderBounds: null, exportAsync: vi.fn(async () => Promise.reject(new Error("nope"))) })
    onPage(figmaMock, [frame], [frame])
    const report = (await runReadDiagnostic("T3-export", CONTEXT)) as { exports: Report[] }
    expect(report.exports.every((row) => row.error === "nope")).toBe(true)
  })

  it("T4 exports every top-level frame (also inside sections) and summarises sizes", async () => {
    const frames = [1, 2].map((n) => fakeFrame("1:" + n, "Frame " + n, [], { absoluteBoundingBox: { x: 0, y: 0, width: 100 * n, height: 100 }, opacity: 1, fills: [{ type: "SOLID" }], exportAsync: exporter({ width: 100 * n, height: 100 }) }))
    const inSection = fakeFrame("2:2", "In section", [], { absoluteBoundingBox: null, exportAsync: vi.fn() })
    onPage(figmaMock, [...frames, fakeSection("2:1", "Section", [inSection]), fakeText("3:1", "Loose text")])
    const report = (await runReadDiagnostic("T4-export-page", CONTEXT)) as Report & { rows: Report[] }
    expect(report).toMatchObject({ test: "T4-export-page", frames: 3, exported: 2, reexported: 0 })
    expect(report.rows.map((row) => row.frameId)).toEqual(["1:1", "1:2", "2:2"])
    expect(report.rows[2]).toMatchObject({ skipped: "no_bounds" })
    expect(report.rows[0]).toMatchObject({ format: "JPG", matches: true })
  })
})

describe("T5 (fonts and exact restore)", () => {
  it("writes ✓, restores every field exactly and reports bindings and missing fonts", async () => {
    figmaMock.textStyles.set("S:1", { fontSize: 20 })
    const styled = fakeText("1:1", "Hello world")
    await styled.setRangeTextStyleIdAsync(0, 5, "S:1")
    styled.setRangeHyperlink(6, 11, { type: "URL", value: "https://rerune.io" })
    const bound = fakeText("1:2", "Bound", { boundVariables: { characters: { type: "VARIABLE_ALIAS", id: "V:1" } } })
    const missing = fakeText("1:3", "Missing", { hasMissingFont: true })
    onPage(figmaMock, [styled, bound, missing], [styled, bound, missing])
    const report = (await runWriteDiagnostic("T5-fonts", 1)) as { nodes: Report[] }
    expect(report.nodes[0]).toMatchObject({ nodeId: "1:1", writeOk: true, textRestored: true, restoreFailures: 0, textOverriddenAfter: false })
    expect(Object.values(report.nodes[0].exact as Record<string, boolean>).every(Boolean)).toBe(true)
    expect(styled.characters).toBe("Hello world")
    expect(styled.autoRename).toBe(true)
    expect(report.nodes[1]).toMatchObject({ nodeId: "1:2", boundToVariable: true, skipped: "bound_to_variable" })
    expect(bound.characters).toBe("Bound")
    expect(report.nodes[2]).toMatchObject({ nodeId: "1:3", skipped: "missing_font" })
  })

  it("asks for a text selection", async () => {
    expect(await runWriteDiagnostic("T5-fonts", 1)).toMatchObject({ error: expect.any(String) })
  })
})

describe("T7 / T8 / T10 / T9", () => {
  it("T7 reports root, every page and the current page's resolution", async () => {
    const settings = newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 100 })
    figmaMock.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings({ ...settings, updatedAt: 300 }))
    figmaMock.currentPage.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings(settings))
    figmaMock.root.appendChild(fakePage("5:0", "Other"))
    const report = (await runReadDiagnostic("T7-settings", CONTEXT)) as Report
    expect(report).toMatchObject({
      test: "T7-settings",
      fileName: "File",
      root: { present: true, valid: true, updatedAt: 300 },
      pages: [
        { pageId: "0:1", current: true, present: true, valid: true, updatedAt: 100, equalToRoot: false },
        { pageId: "5:0", current: false, present: false, valid: false, equalToRoot: false },
      ],
      current: { pageId: "0:1", source: "root", differ: true, offerMirror: true, syncPause: { paused: true, reason: "no_file" } },
    })
  })

  it("T7 reports when link sync is paused for a branch or a suspected copy", async () => {
    const linked = { ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 100 }), fileKey: "AbCdEf1234567890XyZ", fileName: "File" }
    figmaMock.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings(linked))
    figmaMock.currentPage.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings(linked))
    expect(((await runReadDiagnostic("T7-settings", CONTEXT)) as Report).current).toMatchObject({ syncPause: { paused: false, reason: null } })
    figmaMock.root.name = "File (Copy)"
    expect(((await runReadDiagnostic("T7-settings", CONTEXT)) as Report).current).toMatchObject({ syncPause: { paused: true, reason: "possible_copy" } })
    figmaMock.currentPage.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings({ ...linked, branchKey: "BrAnCh1234567890", updatedAt: 200 }))
    expect(((await runReadDiagnostic("T7-settings", CONTEXT)) as Report).current).toMatchObject({ syncPause: { paused: true, reason: "branch" } })
  })

  it("T8 sets relaunch data on the selection", async () => {
    const a = fakeText("1:1", "A")
    onPage(figmaMock, [a], [a])
    expect(await runWriteDiagnostic("T8-relaunch", 1)).toMatchObject({ test: "T8-relaunch", set: 1 })
    expect(a.getRelaunchData()).toEqual({ open: "ReRune diagnostics: relaunch button test" })
  })

  it("T10 reports the environment", async () => {
    const report = await runReadDiagnostic("T10-environment", { ...CONTEXT, startup: { skipInvisibleInstanceChildren: false, command: "open" } })
    expect(report).toEqual({
      test: "T10-environment",
      editorType: "figma",
      mode: "default",
      command: "",
      startupCommand: "open",
      vscode: false,
      apiVersion: "1.0.0",
      skipInvisibleInstanceChildrenDefault: false,
      skipInvisibleInstanceChildrenNow: false,
      fileName: "File",
      currentPage: { id: "0:1", name: "Page 1" },
      pluginVersion: "0.0.0-test",
      env: "development",
      apiBase: "http://localhost:8080",
    })
  })

  it("T9 records whether Dev Mode allows the write and cleans up", () => {
    const node = fakeText("1:1", "A")
    onPage(figmaMock, [node], [node])
    expect(runDevModeProbe(7)).toEqual({ test: "T9-devmode-write", nodeId: "1:1", isText: true, allowed: true, error: null, readBack: serializeDiagMarker({ v: 1, nid: "1:1", t: 7 }), cleanupError: null })
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.diag)).toBe("")
    figmaMock.pluginDataWriteError = "Cannot write in Dev Mode"
    expect(runDevModeProbe(8)).toMatchObject({ allowed: false, error: "Cannot write in Dev Mode" })
    figmaMock.currentPage.selection = []
    expect(runDevModeProbe(9)).toMatchObject({ error: "Select a layer." })
  })
})
