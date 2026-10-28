import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeFrame, fakePage, fakeText, installFigma, onPage, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE, STORAGE_KEYS } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi, StoredAuth } from "../shared/messages"
import { newFileSettings, parseLink, serializeFileSettings } from "../shared/plugin-data"
import { codegenCacheKey } from "./auth-storage"
import { createMainBus, type MainBus } from "./bus"
import { clearFontCache } from "./fonts"
import { buildInit, clampUiSize, isAllowedExternalUrl, registerHandlers, selectNodes, watchSelection, type MainContext } from "./handlers"

let figmaMock: FigmaMock
let sent: MainToUi[]

beforeEach(() => {
  figmaMock = installFigma()
  sent = []
  clearFontCache()
})

afterEach(() => {
  uninstallFigma()
})

function context(editorType: "figma" | "dev" = "figma"): MainContext {
  return {
    editorType,
    env: "development",
    devMode: true,
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: false, command: "" },
    inspect: null,
  }
}

function setup(editorType: "figma" | "dev" = "figma"): MainBus {
  const bus = createMainBus(editorType, "development", (message) => sent.push(message))
  registerHandlers(bus, context(editorType))
  return bus
}

const AUTH: StoredAuth = {
  apiBase: "http://localhost:8080",
  token: "rrf_" + "c".repeat(64),
  tokenId: "6a4900000000000000000001",
  tokenExpiresAt: "2027-01-25T10:00:00Z",
  user: { id: "kc-1", email: "dana@example.com", firstName: "Dana", lastName: "Designer" },
  savedAt: 1,
}

describe("init handshake", () => {
  it("answers every ui-ready with init (auth for this apiBase, prefs, file settings)", async () => {
    figmaMock.clientStorage.data.set(STORAGE_KEYS.auth, { [AUTH.apiBase]: AUTH, "https://rerune.io/api": { ...AUTH, apiBase: "https://rerune.io/api" } })
    figmaMock.clientStorage.data.set(STORAGE_KEYS.prefs, { lastLanguage: "de" })
    const settings = newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 5 })
    figmaMock.currentPage.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file, serializeFileSettings(settings))
    figmaMock.command = "open"
    const a = fakeText("1:1", "A")
    onPage(figmaMock, [a], [a])
    const bus = setup()
    await bus.dispatch({ type: "ui-ready" })
    await bus.dispatch({ type: "ui-ready" })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({
      type: "init",
      editorType: "figma",
      mode: "default",
      command: "open",
      env: "development",
      apiBase: "http://localhost:8080",
      dashboardBase: "http://localhost:3000",
      pluginVersion: "0.1.0",
      auth: AUTH,
      prefs: { lastLanguage: "de" },
      fileSettings: settings,
      settingsSource: "page",
      fileName: "File",
      pageId: "0:1",
      pageName: "Page 1",
      selectionCount: 1,
    })
  })

  it("still answers when storage cannot be read", async () => {
    figmaMock.clientStorage.getAsync.mockRejectedValue(new Error("broken"))
    const init = await buildInit(context())
    expect(init).toMatchObject({ auth: null, prefs: {}, fileSettings: null, settingsSource: "none" })
  })
})

describe("ui handlers", () => {
  it("saves and clears auth, prefs and the codegen cache", async () => {
    const bus = setup("dev")
    await bus.dispatch({ type: "auth-save", auth: AUTH })
    await bus.dispatch({ type: "prefs-save", prefs: { inspectPlatform: "ios" } })
    await bus.dispatch({ type: "cache-save", projectId: PROJECT_ID, entries: [{ keyId: keyId(1), k: "a", placeholders: [], sourceText: "A" }] })
    expect(figmaMock.clientStorage.data.get(STORAGE_KEYS.auth)).toEqual({ [AUTH.apiBase]: AUTH })
    expect(figmaMock.clientStorage.data.get(STORAGE_KEYS.prefs)).toEqual({ inspectPlatform: "ios" })
    expect(figmaMock.clientStorage.data.has(codegenCacheKey(PROJECT_ID))).toBe(true)
    await bus.dispatch({ type: "auth-clear", apiBase: AUTH.apiBase })
    expect(figmaMock.clientStorage.data.has(STORAGE_KEYS.auth)).toBe(false)
    expect(sent).toEqual([])
  })

  it("keeps no codegen cache in the design-only build (no Dev Mode reads it)", async () => {
    const bus = createMainBus("figma", "production", (message) => sent.push(message))
    registerHandlers(bus, { ...context(), env: "production", devMode: false })
    await bus.dispatch({ type: "cache-save", projectId: PROJECT_ID, entries: [{ keyId: keyId(1), k: "a", placeholders: [], sourceText: "A" }] })
    expect(figmaMock.clientStorage.data.has(codegenCacheKey(PROJECT_ID))).toBe(false)
    expect(figmaMock.clientStorage.data.has(STORAGE_KEYS.codegenIndex)).toBe(false)
    expect(sent).toEqual([])
  })

  it("ignores cache-save failures silently", async () => {
    figmaMock.clientStorage.failWrites = true
    await setup().dispatch({ type: "cache-save", projectId: PROJECT_ID, entries: [{ keyId: keyId(1), k: "a", placeholders: [], sourceText: "A" }] })
    expect(sent).toEqual([])
    expect(figmaMock.notify).not.toHaveBeenCalled()
  })

  it("opens only web links", async () => {
    const bus = setup()
    await bus.dispatch({ type: "open-external", url: "http://localhost:3000/figma/connect?code=K7P4QX" })
    expect(figmaMock.openExternal).toHaveBeenCalledWith("http://localhost:3000/figma/connect?code=K7P4QX")
    await bus.dispatch({ type: "open-external", url: "javascript:alert(1)" })
    expect(figmaMock.openExternal).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ type: "handler-error", forType: "open-external", message: "Only web links can be opened" }])
  })

  it("opens http://localhost and http://127.0.0.1 links only in development builds", async () => {
    const local = ["http://localhost:3000/figma/connect?code=K7P4QX", "http://127.0.0.1:3000/register", "http://localhost", "http://LOCALHOST:8080/"]
    for (const url of local) {
      expect(isAllowedExternalUrl(url, "development"), url).toBe(true)
      expect(isAllowedExternalUrl(url, "production"), url).toBe(false)
    }
    for (const env of ["production", "development"] as const) {
      expect(isAllowedExternalUrl("https://rerune.io/register", env)).toBe(true)
      expect(isAllowedExternalUrl("https://rerune.io/translator/translations/p?key=k", env)).toBe(true)
      for (const url of ["http://evil.example", "http://localhost.evil.example/", "http://127.0.0.1.evil.example", "http://localhost:3000/a b", "javascript:alert(1)", "file:///etc/passwd", "https://", ""]) {
        expect(isAllowedExternalUrl(url, env), env + " " + url).toBe(false)
      }
    }

    const production = createMainBus("figma", "production", (message) => sent.push(message))
    registerHandlers(production, { ...context(), env: "production", apiBase: "https://rerune.io/api", dashboardBase: "https://rerune.io" })
    await production.dispatch({ type: "open-external", url: "http://localhost:3000/figma/connect?code=K7P4QX" })
    await production.dispatch({ type: "open-external", url: "http://127.0.0.1:3000/figma/connect?code=K7P4QX" })
    expect(figmaMock.openExternal).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { type: "handler-error", forType: "open-external", message: "Only web links can be opened" },
      { type: "handler-error", forType: "open-external", message: "Only web links can be opened" },
    ])
    await production.dispatch({ type: "open-external", url: "https://rerune.io/figma/connect?code=K7P4QX" })
    expect(figmaMock.openExternal).toHaveBeenCalledWith("https://rerune.io/figma/connect?code=K7P4QX")
  })

  it("notifies with at most 100 characters", async () => {
    await setup().dispatch({ type: "notify", message: "x".repeat(120), error: true })
    expect(figmaMock.notify).toHaveBeenCalledWith("x".repeat(100), { error: true })
  })

  it("clamps resizes to the Design and inspect limits", async () => {
    await setup().dispatch({ type: "resize", width: 2000, height: 100 })
    expect(figmaMock.ui.resize).toHaveBeenCalledWith(800, 480)
    expect(clampUiSize("dev", 250.4, 300)).toEqual({ width: 300, height: 300 })
    expect(() => clampUiSize("figma", Number.NaN, 1)).toThrow()
  })
})

describe("select-nodes", () => {
  it("switches page, selects and zooms in Design", async () => {
    const other = fakePage("5:0", "Other")
    const node = fakeText("5:1", "There")
    other.appendChild(node)
    figmaMock.root.appendChild(other)
    expect(await selectNodes(["5:1", "9:9"], "figma")).toBe(1)
    expect(figmaMock.setCurrentPageAsync).toHaveBeenCalledWith(other)
    expect(figmaMock.currentPage.selection).toEqual([node])
    expect(figmaMock.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([node])
  })

  it("only zooms in Dev Mode", async () => {
    const node = fakeText("1:1", "Here")
    onPage(figmaMock, [node], [])
    await setup("dev").dispatch({ type: "select-nodes", nodeIds: ["1:1"] })
    expect(figmaMock.currentPage.selection).toEqual([])
    expect(figmaMock.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([node])
    expect(figmaMock.setCurrentPageAsync).not.toHaveBeenCalled()
  })

  it("tells the user when nothing is left to select", async () => {
    expect(await selectNodes(["9:9"], "figma")).toBe(0)
    expect(figmaMock.notify).toHaveBeenCalledWith("These layers are no longer on the canvas")
  })
})

describe("document handlers through the bus", () => {
  it("saves file settings and answers op-result", async () => {
    const settings = newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 })
    await setup().dispatch({ type: "settings-save", requestId: "c1", settings })
    expect(sent).toEqual([{ type: "op-result", requestId: "c1", ok: true, done: 1, errors: [] }])
    expect(figmaMock.root.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).not.toBe("")
    expect(figmaMock.currentPage.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.file)).not.toBe("")
  })

  it("streams a scan", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [fakeFrame("1:0", "Checkout", [node])], [node])
    await setup().dispatch({ type: "scan-request", requestId: "c2", scope: "selection" })
    expect(sent.map((message) => message.type)).toEqual(["scan-batch", "scan-done"])
  })

  it("links, pulls, previews, resets and unlinks with op-results", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node], [node])
    const bus = setup()
    await bus.dispatch({ type: "link-apply", requestId: "l", items: [{ nodeId: "1:1", keyId: keyId(1), keyName: "pay", projectId: PROJECT_ID, src: src("Pay now") }] })
    await bus.dispatch({ type: "text-apply", requestId: "t", items: [{ nodeId: "1:1", text: "Pay securely", src: src("Pay securely") }] })
    await bus.dispatch({ type: "preview-apply", requestId: "p", info: { lang: "de", source: "draft", variationOptionId: null }, items: [{ nodeId: "1:1", text: "Sicher zahlen" }] })
    await bus.dispatch({ type: "preview-reset", requestId: "r", scope: "selection" })
    await bus.dispatch({ type: "link-remove", requestId: "u", nodeIds: ["1:1", "9:9"] })
    expect(sent).toEqual([
      { type: "op-result", requestId: "l", ok: true, done: 1, errors: [] },
      { type: "op-result", requestId: "t", ok: true, done: 1, errors: [] },
      { type: "op-result", requestId: "p", ok: true, done: 1, errors: [] },
      { type: "op-result", requestId: "r", ok: true, done: 1, errors: [] },
      { type: "op-result", requestId: "u", ok: false, done: 1, errors: [{ nodeId: "9:9", code: "node_not_found", message: "Layer not found. It may be hidden or deleted." }] },
    ])
    expect(node.characters).toBe("Pay securely")
    expect(parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)).kind).toBe("none")
  })

  it("keeps the true original when two preview-apply messages overlap on one layer", async () => {
    for (let delay = 0; delay < 12; delay++) {
      uninstallFigma()
      figmaMock = installFigma()
      clearFontCache()
      sent = []
      const node = fakeText("1:1", "Pay now")
      onPage(figmaMock, [node], [node])
      const bus = setup()
      const first = bus.dispatch({ type: "preview-apply", requestId: "a", info: { lang: "de", source: "draft", variationOptionId: null }, items: [{ nodeId: "1:1", text: "Jetzt zahlen" }] })
      let later: Promise<void> = Promise.resolve()
      for (let tick = 0; tick < delay; tick++) later = later.then(() => undefined)
      const second = later.then(() =>
        bus.dispatch({ type: "preview-apply", requestId: "b", info: { lang: "en", source: "pseudo", variationOptionId: null }, items: [{ nodeId: "1:1", text: "⟦Þáý ñóŵ⟧" }] }),
      )
      await Promise.all([first, second])
      expect(node.characters).toBe("⟦Þáý ñóŵ⟧")
      await bus.dispatch({ type: "preview-reset", requestId: "r", scope: "page", nodeIds: ["1:1"] })
      expect(node.characters).toBe("Pay now")
      expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview)).toBe("")
    }
  })

  it("makes an overflow report's messages one undo step, committed by its final reset", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node], [node])
    const bus = setup()
    figmaMock.commitUndo.mockClear()
    for (const [lang, text] of [["de", "Jetzt zahlen"], ["it", "Paga ora"]]) {
      await bus.dispatch({ type: "preview-apply", requestId: "p-" + lang, info: { lang, source: "draft", variationOptionId: null }, items: [{ nodeId: "1:1", text }], commit: false })
      await bus.dispatch({ type: "overflow-check", requestId: "o-" + lang, nodeIds: ["1:1"], commit: false })
    }
    expect(node.characters).toBe("Paga ora")
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
    await bus.dispatch({ type: "preview-reset", requestId: "r", scope: "page", nodeIds: ["1:1"] })
    expect(figmaMock.commitUndo).toHaveBeenCalledTimes(1)
    expect(node.characters).toBe("Pay now")
  })

  it("refuses document writes in Dev Mode", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    await setup("dev").dispatch({ type: "link-apply", requestId: "l", items: [{ nodeId: "1:1", keyId: keyId(1), keyName: "pay", projectId: PROJECT_ID, src: src("Pay now") }] })
    expect(sent).toEqual([{ type: "handler-error", forType: "link-apply", requestId: "l", message: "Not available in Dev Mode" }])
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)).toBe("")
  })

  it("runs diagnostics and answers diagnostics-result", async () => {
    const node = fakeText("1:1", "A")
    onPage(figmaMock, [node], [node])
    const bus = setup()
    await bus.dispatch({ type: "diagnostics-read", requestId: "d1", test: "T10-environment" })
    await bus.dispatch({ type: "diagnostics-write", requestId: "d2", test: "T8-relaunch" })
    expect(sent.map((message) => [message.type, (message as { test?: string }).test])).toEqual([
      ["diagnostics-result", "T10-environment"],
      ["diagnostics-result", "T8-relaunch"],
    ])
    const devBus = createMainBus("dev", "development", (message) => sent.push(message))
    registerHandlers(devBus, context("dev"))
    await devBus.dispatch({ type: "diagnostics-devmode-probe", requestId: "d3" })
    expect(sent[2]).toMatchObject({ type: "diagnostics-result", requestId: "d3", test: "T9-devmode-write", report: { allowed: true } })
  })

  it("answers inspect-request with the current inspect selection", async () => {
    const node = fakeText("1:1", "A")
    onPage(figmaMock, [node], [node])
    await setup().dispatch({ type: "inspect-request" })
    expect(sent[0]).toMatchObject({ type: "inspect-selection", kind: "text" })
  })

  it("uses the inspect watcher in Dev Mode", async () => {
    const refresh = vi.fn(async () => {})
    const bus = createMainBus("dev", "development", (message) => sent.push(message))
    registerHandlers(bus, { ...context("dev"), inspect: { refresh } })
    await bus.dispatch({ type: "inspect-request" })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("answers overflow-check with overflow-result and language-copies with op-result (QA, §7.18)", async () => {
    const bus = setup()
    await bus.dispatch({ type: "overflow-check", requestId: "q1", nodeIds: ["99:1"] })
    await bus.dispatch({ type: "language-copies", requestId: "q2", frameIds: ["99:1"], copies: [] })
    expect(sent).toEqual([
      { type: "overflow-result", requestId: "q1", items: [] },
      { type: "op-result", requestId: "q2", ok: false, done: 0, errors: [{ nodeId: "99:1", code: "node_not_found", message: "Layer not found. It may be hidden or deleted." }] },
    ])
  })

  it("answers screenshots-export with frame-images-done (and refuses ids that are not a list)", async () => {
    const bus = setup()
    await bus.dispatch({ type: "screenshots-export", requestId: "s1", frameIds: ["99:1"] })
    expect(sent).toEqual([{ type: "frame-images-done", requestId: "s1", exported: 0, skipped: [{ frameId: "99:1", reason: "not_found" }] }])
    sent = []
    await bus.dispatch({ type: "screenshots-export", requestId: "s2", frameIds: "10:1" })
    expect(sent).toEqual([{ type: "handler-error", forType: "screenshots-export", requestId: "s2", message: "frameIds must be a list of frame ids" }])
  })
})

describe("watchSelection", () => {
  it("sends selection-changed on selection and page changes", () => {
    const messages: MainToUi[] = []
    watchSelection((message) => messages.push(message))
    const node = fakeText("1:1", "A")
    onPage(figmaMock, [node], [node])
    figmaMock.emit("selectionchange")
    figmaMock.currentPage = fakePage("2:0", "Second")
    figmaMock.emit("currentpagechange")
    expect(messages).toEqual([
      { type: "selection-changed", selectionCount: 1, pageId: "0:1", pageName: "Page 1" },
      { type: "selection-changed", selectionCount: 0, pageId: "2:0", pageName: "Second" },
    ])
  })
})
