import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pkg from "../package.json"
import { createMainBus, DEV_MODE_REFUSAL, DEVPROBE_REFUSAL } from "../src/main/bus"
import { generateCode } from "../src/main/codegen"
import { registerHandlers, type MainContext } from "../src/main/handlers"
import { watchInspectSelection } from "../src/main/inspect"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../src/shared/constants"
import { src } from "../src/shared/hash"
import { isAllowed, MESSAGE_IMPACT, type BuildEnv, type PluginEditorType } from "../src/shared/message-policy"
import type { FileSettings, MainToUi, ReadDiagnostic, StoredAuth, UiToMain, UiToMainType } from "../src/shared/messages"
import { newFileSettings, serializeFileSettings, serializeLink } from "../src/shared/plugin-data"
import {
  fakeComponent,
  fakeFrame,
  fakeInstance,
  fakeText,
  followText,
  installFigma,
  loadFont,
  onPage,
  uninstallFigma,
  type FakeNode,
  type FakeText,
  type FigmaMock,
} from "./figma-mock"
import { keyId, PROJECT_ID } from "./fixtures"

// Dev Mode policy on the main side (§7.5 impact map, §7.17 "No writes of any kind", §1.5 "Dev Mode never writes"):
// with the real handlers, Dev Mode refuses every metadata and canvas message; every message it does accept
// (ui and read impacts) leaves the document exactly as it was; and the Code section (codegen) never writes,
// never stores anything and never calls the network.

const UI_TO_MAIN = Object.keys(MESSAGE_IMPACT) as UiToMainType[]
const ENVS: BuildEnv[] = ["production", "development"]
const FILE_KEY = "AbCdEf1234567890XyZ"
const SOLID = { type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL" }
const NS = PLUGIN_DATA_NAMESPACE

function context(editorType: PluginEditorType, env: BuildEnv, post: (message: MainToUi) => void = () => {}): MainContext {
  return {
    editorType,
    env,
    devMode: true,
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: false, command: "" },
    inspect: editorType === "dev" ? watchInspectSelection(post) : null,
  }
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

function link(node: FakeNode, n: number, text: string, nid = node.id): void {
  node.setSharedPluginData(NS, DATA_KEYS.link, serializeLink({ v: 1, id: keyId(n), k: "key_" + n, p: PROJECT_ID, src: src(text), nid, t: 1 }))
}

interface Fixture { frame: FakeNode; texts: FakeText[]; instance: FakeNode; settings: FileSettings }

// A connected file: a frame with linked and unlinked text, an instance whose text inherits its main component's
// link, the component itself, and file settings on the document and the page.
function connectedFile(figma: FigmaMock): Fixture {
  loadFont(figma)
  const mainText = fakeText("3:2", "Pay now", { absoluteBoundingBox: rect(500, 10, 80, 20) })
  link(mainText, 1, "Pay now")
  const component = fakeComponent("3:1", "Button", [mainText], { absoluteBoundingBox: rect(500, 0, 100, 40) })
  const sublayer = fakeText("I4:1;3:2", "Pay now", { absoluteBoundingBox: rect(20, 100, 80, 20) })
  sublayer.inheritFrom = mainText
  const instance = fakeInstance("4:1", "Button", [sublayer], { mainComponent: component })
  followText(sublayer, mainText, instance)
  const linked = fakeText("1:2", "Checkout", { absoluteBoundingBox: rect(20, 20, 120, 24) })
  link(linked, 2, "Checkout")
  const plain = fakeText("1:3", "Free shipping", { absoluteBoundingBox: rect(20, 60, 120, 20) })
  const frame = fakeFrame("1:1", "Checkout", [linked, plain, instance], {
    absoluteBoundingBox: rect(0, 0, 400, 800),
    absoluteRenderBounds: rect(0, 0, 400, 800),
    opacity: 1,
    fills: [SOLID],
    exportAsync: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
  })
  onPage(figma, [frame, component], [frame])
  const settings: FileSettings = {
    ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }),
    fileKey: FILE_KEY,
    fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/File",
    fileName: "File",
  }
  figma.root.setSharedPluginData(NS, DATA_KEYS.file, serializeFileSettings(settings))
  figma.currentPage.setSharedPluginData(NS, DATA_KEYS.file, serializeFileSettings(settings))
  return { frame, texts: [mainText, sublayer, linked, plain], instance, settings }
}

// Everything a plugin could change in the document: names, visibility, structure, the rerune plugin data, relaunch
// data, and the characters and per-character styles of every text layer.
function snapshot(figma: FigmaMock): string {
  const rows: unknown[] = []
  const visit = (node: FakeNode) => {
    const data = node.getSharedPluginDataKeys(NS).sort().map((key) => [key, node.getSharedPluginData(NS, key)])
    const text = node.type === "TEXT" ? { characters: (node as FakeText).characters, styles: (node as FakeText).styles, autoRename: (node as FakeText).autoRename } : null
    rows.push({ id: node.id, type: node.type, name: node.name, visible: node.visible, locked: node.locked, removed: node.removed, children: node.allChildren.map((child) => child.id), data, relaunch: node.getRelaunchData(), text })
    node.allChildren.forEach(visit)
  }
  visit(figma.root)
  return JSON.stringify(rows)
}

const AUTH: StoredAuth = {
  apiBase: "http://localhost:8080",
  token: "rrf_" + "a".repeat(64),
  tokenId: "671e00000000000000000d7d",
  tokenExpiresAt: "2027-01-25T10:00:00Z",
  user: { id: "kc-1", email: "dev@example.com", firstName: "Dev", lastName: "Eloper" },
  savedAt: 1,
}

const READ_DIAGNOSTICS: ReadDiagnostic[] = ["T1-check", "T2-instances", "T3-export", "T4-export-page", "T7-settings", "T10-environment", "T11-style-overrides"]

// Every message Dev Mode accepts (impact ui or read), with real payloads for the fixture file. The list must cover
// every such type: a ui or read message added to the impact map without an entry here fails the coverage test.
function acceptedMessages(fixture: Fixture, env: BuildEnv = "development"): UiToMain[] {
  const ids = fixture.texts.map((text) => text.id)
  // Production builds open https links only (the local dashboard is development-only).
  const dashboardBase = env === "development" ? "http://localhost:3000" : "https://rerune.io"
  return [
    { type: "ui-ready" },
    { type: "auth-save", auth: AUTH },
    { type: "prefs-save", prefs: { inspectPlatform: "ios" } },
    { type: "cache-save", projectId: PROJECT_ID, entries: [{ keyId: keyId(2), k: "key_2", placeholders: [], sourceText: "Checkout" }] },
    { type: "open-external", url: dashboardBase + "/translator/translations/" + PROJECT_ID + "?key=" + keyId(2) },
    { type: "notify", message: "Copied" },
    { type: "resize", width: 320, height: 600 },
    { type: "select-nodes", nodeIds: ids },
    { type: "scan-request", requestId: "c1-1", scope: "page" },
    { type: "scan-request", requestId: "c1-2", scope: "selection" },
    { type: "scan-cancel", requestId: "c1-2" },
    { type: "inspect-request" },
    { type: "link-check", requestId: "c1-3", nodeIds: [...ids, "9:9"] },
    { type: "screenshots-export", requestId: "c1-4", frameIds: [fixture.frame.id] },
    ...READ_DIAGNOSTICS.map((test, i): UiToMain => ({ type: "diagnostics-read", requestId: "c1-d" + i, test })),
    { type: "auth-clear", apiBase: AUTH.apiBase },
  ]
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallFigma()
})

describe("Dev Mode message policy (§7.5 impact map) with the real handlers", () => {
  const BLOCKED_IN_DEV_MODE: UiToMainType[] = [
    "settings-save", "link-apply", "link-remove",
    "text-apply", "preview-apply", "preview-reset", "overflow-check", "language-copies", "diagnostics-write",
  ]

  async function refusedTypes(editorType: PluginEditorType, env: BuildEnv): Promise<UiToMainType[]> {
    const refused: UiToMainType[] = []
    for (const type of UI_TO_MAIN) {
      const sent: MainToUi[] = []
      const bus = createMainBus(editorType, env, (message) => sent.push(message))
      registerHandlers(bus, context(editorType, env))
      // An empty payload: allowed handlers fail or do nothing, refused ones never run.
      await bus.dispatch({ type, requestId: "c1-1" })
      const refusal = sent.find(
        (message) => message.type === "handler-error" && (message.message === DEV_MODE_REFUSAL || message.message === DEVPROBE_REFUSAL),
      )
      if (refusal !== undefined) {
        refused.push(type)
      }
    }
    return refused.sort()
  }

  it("Dev Mode refuses every metadata and canvas write, and the probe outside development builds", async () => {
    expect(await refusedTypes("dev", "production")).toEqual([...BLOCKED_IN_DEV_MODE, "diagnostics-devmode-probe"].sort())
    expect(await refusedTypes("dev", "development")).toEqual([...BLOCKED_IN_DEV_MODE].sort())
  })

  it("Design mode refuses only the Dev Mode probe", async () => {
    expect(await refusedTypes("figma", "production")).toEqual(["diagnostics-devmode-probe"])
    expect(await refusedTypes("figma", "development")).toEqual(["diagnostics-devmode-probe"])
  })

  it("a refused write never touches the document and is not an undo step", async () => {
    const fixture = connectedFile(figmaMock)
    const before = snapshot(figmaMock)
    const sent: MainToUi[] = []
    const bus = createMainBus("dev", "development", (message) => sent.push(message))
    registerHandlers(bus, context("dev", "development"))
    const lookups = figmaMock.getNodeByIdAsync.mock.calls.length
    const ids = fixture.texts.map((text) => text.id)
    const writes: UiToMain[] = [
      { type: "settings-save", requestId: "w1", settings: { ...fixture.settings, projectName: "Other" } },
      { type: "link-apply", requestId: "w2", items: [{ nodeId: "1:3", keyId: keyId(3), keyName: "key_3", projectId: PROJECT_ID, src: src("Free shipping") }] },
      { type: "link-remove", requestId: "w3", nodeIds: ids },
      { type: "text-apply", requestId: "w4", items: [{ nodeId: "1:2", text: "Kasse", src: src("Kasse") }] },
      { type: "preview-apply", requestId: "w5", info: { lang: "de", source: "draft", variationOptionId: null }, items: [{ nodeId: "1:2", text: "Kasse" }] },
      { type: "preview-reset", requestId: "w6", scope: "page" },
      { type: "overflow-check", requestId: "w7", nodeIds: ids },
      { type: "language-copies", requestId: "w8", frameIds: [fixture.frame.id], copies: [{ lang: "de", source: "draft", variationOptionId: null, texts: [{ nodeId: "1:2", text: "Kasse" }] }] },
      { type: "diagnostics-write", requestId: "w9", test: "T1-mark" },
    ]
    for (const message of writes) {
      await bus.dispatch(message)
    }
    await settle()
    expect(snapshot(figmaMock)).toBe(before)
    expect(figmaMock.getNodeByIdAsync.mock.calls.length).toBe(lookups)
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
    expect(sent.map((message) => (message.type === "handler-error" ? [message.forType, message.requestId, message.message] : message.type))).toEqual(
      writes.map((message) => [message.type, (message as { requestId: string }).requestId, DEV_MODE_REFUSAL]),
    )
  })
})

describe("messages Dev Mode accepts never change the document", () => {
  it("the fixture list covers every ui and read message type", () => {
    const fixture = connectedFile(figmaMock)
    const accepted = UI_TO_MAIN.filter((type) => isAllowed(MESSAGE_IMPACT[type], "dev", "production"))
    expect([...new Set(acceptedMessages(fixture).map((message) => message.type))].sort()).toEqual([...accepted].sort())
    expect(new Set(acceptedMessages(fixture).filter((message) => message.type === "diagnostics-read").map((message) => (message as { test: string }).test))).toEqual(new Set(READ_DIAGNOSTICS))
  })

  it.each([
    ["dev", "production"],
    ["dev", "development"],
    ["figma", "production"],
  ] as const)("%s mode, %s build: same document, no undo step, no handler error", async (editorType, env) => {
    figmaMock.editorType = editorType
    figmaMock.mode = editorType === "dev" ? "inspect" : "default"
    const fixture = connectedFile(figmaMock)
    const before = snapshot(figmaMock)
    const selection = figmaMock.currentPage.selection as FakeNode[]
    const skipBefore = figmaMock.skipInvisibleInstanceChildren
    const sent: MainToUi[] = []
    const post = (message: MainToUi) => sent.push(message)
    const bus = createMainBus(editorType, env, post)
    registerHandlers(bus, context(editorType, env, post))
    for (const message of acceptedMessages(fixture, env)) {
      await bus.dispatch(message)
      await settle()
    }

    expect(snapshot(figmaMock)).toBe(before)
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(skipBefore)
    expect(sent.filter((message) => message.type === "handler-error")).toEqual([])
    // Every read was answered with what it asked for.
    const types = sent.map((message) => message.type)
    for (const answer of ["init", "scan-done", "inspect-selection", "link-check-result", "frame-image", "frame-images-done", "diagnostics-result"]) {
      expect(types).toContain(answer)
    }
    const checks = sent.find((message) => message.type === "link-check-result")
    expect(checks?.type === "link-check-result" && checks.nodes.map((node) => [node.nodeId, node.status, node.linkState])).toEqual([
      ["3:2", "found", "ok"],
      ["I4:1;3:2", "found", "inherited"],
      ["1:2", "found", "ok"],
      ["1:3", "found", "none"],
      ["9:9", "not_found", "none"],
    ])
    if (editorType === "dev") {
      // select-nodes only zooms in Dev Mode (§7.5): the selection is the user's.
      // (Figma hands out a frozen copy of the list, so its nodes are compared.)
      const after = figmaMock.currentPage.selection as FakeNode[]
      expect(after).toHaveLength(selection.length)
      after.forEach((node, index) => expect(node).toBe(selection[index]))
      expect(figmaMock.viewport.scrollAndZoomIntoView).toHaveBeenCalled()
    } else {
      expect((figmaMock.currentPage.selection as FakeNode[]).map((node) => node.id)).toEqual(fixture.texts.map((text) => text.id))
    }
  })
})

describe("Code section (codegen, §7.17, D31)", () => {
  it("never writes the document or the plugin's storage and never calls the network, for every language", async () => {
    figmaMock.editorType = "dev"
    figmaMock.mode = "codegen"
    const fixture = connectedFile(figmaMock)
    const before = snapshot(figmaMock)
    const fetchSpy = vi.fn()
    const globals = globalThis as unknown as Record<string, unknown>
    const originalFetch = globals.fetch
    globals.fetch = fetchSpy
    try {
      const languages = [...pkg["figma-plugin"].codegenLanguages.map((language) => language.value), "rerune-diagnostics"]
      for (const env of ENVS) {
        for (const language of languages) {
          for (const node of [fixture.frame, ...fixture.texts, fixture.instance]) {
            const results = await generateCode({ node: node as unknown as SceneNode, language }, env)
            expect(results.length).toBeGreaterThan(0)
          }
        }
      }
    } finally {
      globals.fetch = originalFetch
    }
    expect(snapshot(figmaMock)).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(figmaMock.clientStorage.setAsync).not.toHaveBeenCalled()
    expect(figmaMock.clientStorage.deleteAsync).not.toHaveBeenCalled()
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
    expect(figmaMock.ui.postMessage).not.toHaveBeenCalled()
  })
})
