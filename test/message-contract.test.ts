/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMainBus, type MainBus } from "../src/main/bus"
import { registerHandlers, type MainContext } from "../src/main/handlers"
import { watchInspectSelection } from "../src/main/inspect"
import { MESSAGE_IMPACT, type BuildEnv, type PluginEditorType } from "../src/shared/message-policy"
import { MAIN_TO_UI_TYPES, type MainToUi, type MainToUiType, type UiToMainOf, type UiToMainType } from "../src/shared/messages"
import { newFileSettings } from "../src/shared/plugin-data"
import { installFigma, uninstallFigma } from "./figma-mock"
import { PROJECT_ID } from "./fixtures"
import { importClosure, normalizeSources } from "./source-graph"

// Whole-repo contract for the §7.5 messages (plus the Phase 2 additions link-check / link-check-result and the
// frame skip reason preview_active): every type is sent by one side and handled by the other, and every request
// main receives gets exactly one answer, so the UI never waits for its watchdog. Every type of Phases 1–3 is built
// (Phase 3: overflow-check / overflow-result and language-copies for the QA screen).
// The Dev Mode side of the impact map is checked in test/dev-mode-policy.test.ts and src/ui/dev-mode-ui.test.ts.

// What main answers to each UI → main message (null: nothing, the message is fire-and-forget).
const ANSWER: Record<UiToMainType, MainToUiType | null> = {
  "ui-ready": "init",
  "auth-save": null,
  "auth-clear": null,
  "prefs-save": null,
  "cache-save": null,
  "settings-save": "op-result",
  "open-external": null,
  "notify": null,
  "resize": null,
  "select-nodes": null,
  "scan-request": "scan-done",
  "scan-cancel": null,
  "link-apply": "op-result",
  "link-remove": "op-result",
  "link-check": "link-check-result",
  "text-apply": "op-result",
  "preview-apply": "op-result",
  "preview-reset": "op-result",
  "screenshots-export": "frame-images-done",
  "inspect-request": "inspect-selection",
  "overflow-check": "overflow-result",
  "language-copies": "op-result",
  "diagnostics-read": "diagnostics-result",
  "diagnostics-write": "diagnostics-result",
  "diagnostics-devmode-probe": "diagnostics-result",
}

// Main → UI types that are not an answer: progress of a running request, canvas events, and errors.
const NOT_AN_ANSWER: MainToUiType[] = ["selection-changed", "scan-progress", "scan-batch", "frame-image", "handler-error"]

// A valid message of every type, for a file with nothing selected.
const SAMPLES: { [K in UiToMainType]: UiToMainOf<K> } = {
  "ui-ready": { type: "ui-ready" },
  "auth-save": {
    type: "auth-save",
    auth: {
      apiBase: "http://localhost:8080",
      token: "rrf_" + "a".repeat(64),
      tokenId: "671e00000000000000000d7d",
      tokenExpiresAt: "2027-01-25T10:00:00Z",
      user: { id: "kc-1", email: "designer@example.com", firstName: "Dana", lastName: "Designer" },
      savedAt: 1,
    },
  },
  "auth-clear": { type: "auth-clear", apiBase: "http://localhost:8080" },
  "prefs-save": { type: "prefs-save", prefs: { uploadScreenshotsOnPush: false } },
  "cache-save": { type: "cache-save", projectId: PROJECT_ID, entries: [] },
  "settings-save": {
    type: "settings-save",
    requestId: "c1-1",
    settings: newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }),
  },
  "open-external": { type: "open-external", url: "https://rerune.io" },
  "notify": { type: "notify", message: "Copied" },
  "resize": { type: "resize", width: 400, height: 640 },
  "select-nodes": { type: "select-nodes", nodeIds: ["9:9"] },
  "scan-request": { type: "scan-request", requestId: "c1-1", scope: "selection" },
  "scan-cancel": { type: "scan-cancel", requestId: "c1-1" },
  "link-apply": { type: "link-apply", requestId: "c1-1", items: [] },
  "link-remove": { type: "link-remove", requestId: "c1-1", nodeIds: [] },
  "link-check": { type: "link-check", requestId: "c1-1", nodeIds: ["9:9"] },
  "text-apply": { type: "text-apply", requestId: "c1-1", items: [] },
  "preview-apply": { type: "preview-apply", requestId: "c1-1", info: { lang: "de", source: "draft", variationOptionId: null }, items: [] },
  "preview-reset": { type: "preview-reset", requestId: "c1-1", scope: "selection" },
  "screenshots-export": { type: "screenshots-export", requestId: "c1-1", frameIds: ["9:9"] },
  "inspect-request": { type: "inspect-request" },
  "overflow-check": { type: "overflow-check", requestId: "c1-1", nodeIds: [] },
  "language-copies": { type: "language-copies", requestId: "c1-1", frameIds: [], copies: [] },
  "diagnostics-read": { type: "diagnostics-read", requestId: "c1-1", test: "T10-environment" },
  "diagnostics-write": { type: "diagnostics-write", requestId: "c1-1", test: "T8-relaunch" },
  "diagnostics-devmode-probe": { type: "diagnostics-devmode-probe", requestId: "c1-1" },
}

// Production sources only, as text (tests and test helpers excluded).
const uiSources = normalizeSources(
  import.meta.glob<string>(
    ["../src/ui/**/*.ts", "../src/ui/**/*.tsx", "../src/shared/**/*.ts", "../src/codegen/**/*.ts", "!../src/**/*.test.ts", "!../src/ui/state/test-fakes.ts"],
    { query: "?raw", import: "default", eager: true },
  ),
)
const mainSources = normalizeSources(import.meta.glob<string>(["../src/main/**/*.ts", "!../src/main/**/*.test.ts"], { query: "?raw", import: "default", eager: true }))
const UI_FILES = Object.keys(uiSources).filter((path) => path.startsWith("../src/ui/"))

const UI_TO_MAIN = Object.keys(MESSAGE_IMPACT) as UiToMainType[]
const BUILT_UI_TO_MAIN = UI_TO_MAIN
const BUILT_MAIN_TO_UI = MAIN_TO_UI_TYPES
const REQUESTS = BUILT_UI_TO_MAIN.filter((type) => "requestId" in SAMPLES[type])

// A message object literal of this type (`{ type: "scan-request", … }`).
function filesBuilding(sources: Record<string, string>, files: readonly string[], type: string): string[] {
  return files.filter((path) => sources[path].includes(`type: "${type}"`))
}

// Any use of the type name as a string literal (bus.on("…"), message.type === "…").
function filesMentioning(sources: Record<string, string>, files: readonly string[], type: string): string[] {
  return files.filter((path) => sources[path].includes(`"${type}"`))
}

function context(editorType: PluginEditorType, env: BuildEnv, post: (message: MainToUi) => void): MainContext {
  return {
    editorType,
    env,
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: false, command: "" },
    inspect: editorType === "dev" ? watchInspectSelection(post) : null,
  }
}

// Dispatches one message to a fresh bus (in the mode that allows it) and returns everything main posted.
async function exchange(message: { type: UiToMainType } & Record<string, unknown>): Promise<MainToUi[]> {
  const probe = message.type === "diagnostics-devmode-probe"
  const editorType: PluginEditorType = probe ? "dev" : "figma"
  const sent: MainToUi[] = []
  const post = (answer: MainToUi) => sent.push(answer)
  const bus = createMainBus(editorType, "development", post)
  registerHandlers(bus, context(editorType, "development", post))
  await bus.dispatch(message)
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return sent
}

beforeEach(() => {
  installFigma()
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallFigma()
})

describe("§7.5 message contract", () => {
  it("reads the production sources of both sides", () => {
    expect(UI_FILES).toEqual(expect.arrayContaining(["../src/ui/app.tsx", "../src/ui/bus.ts", "../src/ui/inspect-app.tsx"]))
    expect(Object.keys(uiSources).some((path) => path.endsWith(".test.ts"))).toBe(false)
    expect(Object.keys(mainSources)).toContain("../src/main/handlers.ts")
    expect(Object.keys(mainSources).some((path) => path.endsWith(".test.ts"))).toBe(false)
  })

  it("covers every message type of Phases 1–3", () => {
    expect(BUILT_UI_TO_MAIN).toHaveLength(25)
    expect(BUILT_MAIN_TO_UI).toHaveLength(13)
    // Phase 2: link sync, screenshots, Dev Mode inspect and its codegen cache. Phase 3: the QA screen.
    expect(BUILT_UI_TO_MAIN).toEqual(expect.arrayContaining(["link-check", "screenshots-export", "inspect-request", "cache-save", "overflow-check", "language-copies"]))
    expect(BUILT_MAIN_TO_UI).toEqual(expect.arrayContaining(["link-check-result", "frame-image", "frame-images-done", "inspect-selection", "overflow-result"]))
  })

  it("main registers exactly one handler for every built UI → main type", () => {
    const registered: UiToMainType[] = []
    const bus: MainBus = {
      editorType: "figma",
      env: "development",
      send: () => {},
      on: (type) => {
        registered.push(type)
      },
      dispatch: async () => {},
    }
    registerHandlers(bus, context("figma", "development", () => {}))
    expect([...registered].sort()).toEqual([...BUILT_UI_TO_MAIN].sort())
  })

  it.each(BUILT_UI_TO_MAIN)("the UI sends %s", (type) => {
    expect(filesBuilding(uiSources, UI_FILES, type)).not.toEqual([])
  })

  it.each(BUILT_MAIN_TO_UI)("main posts %s and the UI handles it", (type) => {
    expect(filesBuilding(mainSources, Object.keys(mainSources), type)).not.toEqual([])
    expect(filesMentioning(uiSources, UI_FILES, type)).not.toEqual([])
  })

})

describe("each UI handles what main posts in its mode", () => {
  // Dev Mode main posts only init, inspect-selection, diagnostics-result and handler-error (index.ts: inspect
  // watcher and the read-only bus); everything else is Design mode.
  const DEV_MODE_POSTS: MainToUiType[] = ["init", "inspect-selection", "diagnostics-result", "handler-error"]
  const devUi = [...importClosure(uiSources, "../src/ui/inspect-app.tsx"), "../src/ui/bus.ts"]
  // The Design-mode app: everything app.tsx bundles other than through InspectApp.
  const designUi = importClosure({ ...uiSources, "../src/ui/inspect-app.tsx": "" }, "../src/ui/app.tsx").filter((path) => path !== "../src/ui/inspect-app.tsx")

  it("splits the UI into the Dev Mode inspect app and the Design-mode app", () => {
    expect(devUi).toEqual(expect.arrayContaining(["../src/ui/inspect-app.tsx", "../src/ui/screens/inspect.tsx", "../src/ui/state/inspect.ts"]))
    expect(designUi).toEqual(expect.arrayContaining(["../src/ui/app.tsx", "../src/ui/screens/layers.tsx", "../src/ui/state/ops.ts"]))
    expect(designUi).not.toContain("../src/ui/screens/inspect.tsx")
  })

  it.each(DEV_MODE_POSTS)("the Dev Mode inspect app handles %s", (type) => {
    expect(filesMentioning(uiSources, devUi, type)).not.toEqual([])
  })

  it.each(BUILT_MAIN_TO_UI.filter((type) => type !== "inspect-selection"))("the Design-mode app handles %s", (type) => {
    expect(filesMentioning(uiSources, designUi, type)).not.toEqual([])
  })
})

describe("every request gets exactly one answer", () => {
  it("every main → UI type answers a request, reports progress, follows the canvas or reports an error", () => {
    const answers = Object.values(ANSWER).filter((type): type is MainToUiType => type !== null)
    expect(new Set([...answers, ...NOT_AN_ANSWER])).toEqual(new Set(MAIN_TO_UI_TYPES))
    expect(answers.some((type) => NOT_AN_ANSWER.includes(type))).toBe(false)
  })

  it.each(BUILT_UI_TO_MAIN)("%s gets its answer and no error", async (type) => {
    const sample = SAMPLES[type] as { type: UiToMainType; requestId?: string }
    const sent = await exchange(sample)
    expect(sent.filter((message) => message.type === "handler-error")).toEqual([])
    const answer = ANSWER[type]
    const answers = sent.filter((message) => message.type === answer)
    if (answer === null) {
      expect(sent.filter((message) => "requestId" in message && message.requestId === sample.requestId)).toEqual([])
    } else if (sample.requestId !== undefined) {
      expect(answers.map((message) => (message as { requestId: string }).requestId)).toEqual([sample.requestId])
    } else {
      expect(answers).toHaveLength(1)
    }
  })

  it.each(REQUESTS.filter((type) => ANSWER[type] !== null))("%s with a malformed payload still gets exactly one answer or error", async (type) => {
    const sent = await exchange({ type, requestId: "bad-1" })
    const terminal = sent.filter(
      (message) => "requestId" in message && message.requestId === "bad-1" && (message.type === ANSWER[type] || message.type === "handler-error"),
    )
    expect(terminal).toHaveLength(1)
  })
})
