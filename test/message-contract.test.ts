/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMainBus, DEV_MODE_REFUSAL, DEVPROBE_REFUSAL, NOT_IMPLEMENTED, type MainBus } from "../src/main/bus"
import { registerHandlers, type MainContext } from "../src/main/handlers"
import { MESSAGE_IMPACT, type BuildEnv, type PluginEditorType } from "../src/shared/message-policy"
import { MAIN_TO_UI_TYPES, type MainToUi, type MainToUiType, type UiToMainType } from "../src/shared/messages"
import { installFigma, uninstallFigma, type FigmaMock } from "./figma-mock"

// Whole-repo contract for the §7.5 messages: every type is sent by one side and handled by the other.
// Types of later phases are already typed and in the impact map; until their phase lands, the UI never sends
// them, main never posts them, and main answers them with a handler-error so nothing waits for the watchdog.

const LATER_PHASE: Partial<Record<UiToMainType | MainToUiType, 2 | 3>> = {
  "screenshots-export": 2,
  "frame-image": 2,
  "frame-images-done": 2,
  "overflow-check": 3,
  "overflow-result": 3,
  "language-copies": 3,
}

// Production sources only, as text (tests and test helpers excluded).
const uiSources = import.meta.glob<string>(["../src/ui/**/*.ts", "../src/ui/**/*.tsx", "!../src/ui/**/*.test.ts", "!../src/ui/state/test-fakes.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
})
const mainSources = import.meta.glob<string>(["../src/main/**/*.ts", "!../src/main/**/*.test.ts"], { query: "?raw", import: "default", eager: true })

const UI_TO_MAIN = Object.keys(MESSAGE_IMPACT) as UiToMainType[]
const PHASE_1_UI_TO_MAIN = UI_TO_MAIN.filter((type) => LATER_PHASE[type] === undefined)
const LATER_UI_TO_MAIN = UI_TO_MAIN.filter((type) => LATER_PHASE[type] !== undefined)
const PHASE_1_MAIN_TO_UI = MAIN_TO_UI_TYPES.filter((type) => LATER_PHASE[type] === undefined)
const LATER_MAIN_TO_UI = MAIN_TO_UI_TYPES.filter((type) => LATER_PHASE[type] !== undefined)

// A message object literal of this type (`{ type: "scan-request", … }`).
function filesBuilding(sources: Record<string, string>, type: string): string[] {
  return Object.keys(sources).filter((path) => sources[path].includes(`type: "${type}"`))
}

// Any use of the type name as a string literal (bus.on("…"), message.type === "…").
function filesMentioning(sources: Record<string, string>, type: string): string[] {
  return Object.keys(sources).filter((path) => sources[path].includes(`"${type}"`))
}

function context(editorType: PluginEditorType, env: BuildEnv): MainContext {
  return {
    editorType,
    env,
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: false, command: "" },
    inspect: null,
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

describe("§7.5 message contract", () => {
  it("reads the production sources of both sides", () => {
    expect(Object.keys(uiSources)).toContain("../src/ui/app.tsx")
    expect(Object.keys(uiSources)).toContain("../src/ui/bus.ts")
    expect(Object.keys(uiSources).some((path) => path.endsWith(".test.ts"))).toBe(false)
    expect(Object.keys(mainSources)).toContain("../src/main/handlers.ts")
    expect(Object.keys(mainSources).some((path) => path.endsWith(".test.ts"))).toBe(false)
  })

  it("splits the message types into Phase 1 and later phases", () => {
    expect(LATER_UI_TO_MAIN).toEqual(["screenshots-export", "overflow-check", "language-copies"])
    expect(LATER_MAIN_TO_UI).toEqual(["frame-image", "frame-images-done", "overflow-result"])
    expect(PHASE_1_UI_TO_MAIN).toHaveLength(21)
    expect(PHASE_1_MAIN_TO_UI).toHaveLength(9)
  })

  it("main registers exactly one handler for every Phase 1 UI → main type", () => {
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
    registerHandlers(bus, context("figma", "development"))
    expect([...registered].sort()).toEqual([...PHASE_1_UI_TO_MAIN].sort())
  })

  it.each(PHASE_1_UI_TO_MAIN)("the UI sends %s", (type) => {
    expect(filesBuilding(uiSources, type)).not.toEqual([])
  })

  it.each(PHASE_1_MAIN_TO_UI)("main posts %s and the UI handles it", (type) => {
    expect(filesBuilding(mainSources, type)).not.toEqual([])
    expect(filesMentioning(uiSources, type)).not.toEqual([])
  })

  it.each(LATER_UI_TO_MAIN)("%s (later phase) is not sent yet and main answers it with a handler-error", async (type) => {
    expect(filesBuilding(uiSources, type)).toEqual([])
    const sent: MainToUi[] = []
    const bus = createMainBus("figma", "development", (message) => sent.push(message))
    registerHandlers(bus, context("figma", "development"))
    await bus.dispatch({ type, requestId: "c1-1" })
    expect(sent).toEqual([{ type: "handler-error", forType: type, requestId: "c1-1", message: NOT_IMPLEMENTED }])
  })

  it.each(LATER_MAIN_TO_UI)("%s (later phase) is not posted by main yet", (type) => {
    expect(filesBuilding(mainSources, type)).toEqual([])
  })
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

  it("a refused write never touches the document", async () => {
    const bus = createMainBus("dev", "development", () => {})
    registerHandlers(bus, context("dev", "development"))
    const rootWrite = vi.spyOn(figmaMock.root, "setSharedPluginData")
    const pageWrite = vi.spyOn(figmaMock.currentPage, "setSharedPluginData")
    await bus.dispatch({ type: "settings-save", requestId: "c1-1", settings: {} })
    await bus.dispatch({ type: "link-remove", requestId: "c1-2", nodeIds: ["1:2"] })
    await bus.dispatch({ type: "preview-reset", requestId: "c1-3", scope: "page" })
    expect(rootWrite).not.toHaveBeenCalled()
    expect(pageWrite).not.toHaveBeenCalled()
    expect(figmaMock.getNodeByIdAsync).not.toHaveBeenCalled()
  })
})
