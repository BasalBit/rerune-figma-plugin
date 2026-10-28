import { DESIGN_UI_MAX_SIZE, DESIGN_UI_MIN_SIZE, INSPECT_UI_MIN_SIZE } from "../shared/constants"
import type { BuildEnv, PluginEditorType } from "../shared/message-policy"
import type { MainToUi, MainToUiOf, RequestId } from "../shared/messages"
import { outcomeOk } from "../shared/node-errors"
import { clearAuth, loadAuth, loadPrefs, saveAuth, saveCodegenCache, savePrefs } from "./auth-storage"
import { notifyText, type MainBus } from "./bus"
import { runDevModeProbe, runReadDiagnostic, runWriteDiagnostic } from "./diagnostics"
import { inspectSelection, type InspectWatcher } from "./inspect"
import { checkLinks, nodeIdsOf } from "./link-check"
import { applyLinks, removeLinks, type OpOutcome } from "./links"
import { pageOf } from "./node-utils"
import { checkOverflow, languageCopiesOf, makeLanguageCopies } from "./qa"
import { createScanner } from "./scan"
import { exportScreenshots, frameIdsOf } from "./screenshots"
import { readFileSettings, saveFileSettings } from "./settings"
import { applyPreview, applyTexts, resetPreview } from "./text-write"

export interface MainContext {
  editorType: PluginEditorType
  env: BuildEnv
  apiBase: string
  dashboardBase: string
  pluginVersion: string
  startup: { skipInvisibleInstanceChildren: boolean; command: string }
  inspect: InspectWatcher | null
}

export function commandOf(): string {
  return typeof figma.command === "string" ? figma.command : ""
}

export async function buildInit(context: MainContext): Promise<MainToUiOf<"init">> {
  const [auth, prefs] = await Promise.all([loadAuth(context.apiBase).catch(() => null), loadPrefs().catch(() => ({}))])
  const resolved = readFileSettings()
  const page = figma.currentPage
  return {
    type: "init",
    editorType: context.editorType,
    mode: figma.mode,
    command: commandOf(),
    env: context.env,
    apiBase: context.apiBase,
    dashboardBase: context.dashboardBase,
    pluginVersion: context.pluginVersion,
    auth,
    prefs,
    fileSettings: resolved.settings,
    settingsSource: resolved.source,
    fileName: figma.root.name,
    pageId: page.id,
    pageName: page.name,
    selectionCount: page.selection.length,
  }
}

const EXTERNAL_URL = /^https:\/\/[^\s]+$/i
// Only development builds open the local dashboard (http://localhost:3000). esbuild folds the condition, so production
// bundles do not even contain the pattern.
const LOCAL_URL = __RERUNE_ENV__ === "development" ? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i : null

// figma.openExternal is the only way to open a browser in the desktop app and in VS Code (tooling map §3.3).
// Production builds open https links only; development builds also open http://localhost and http://127.0.0.1.
export function isAllowedExternalUrl(url: string, env: BuildEnv): boolean {
  if (EXTERNAL_URL.test(url)) {
    return true
  }
  return env === "development" && LOCAL_URL !== null && LOCAL_URL.test(url)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampUiSize(editorType: PluginEditorType, width: number, height: number): { width: number; height: number } {
  if (!isFinite(width) || !isFinite(height)) {
    throw new Error("Invalid size")
  }
  const min = editorType === "dev" ? INSPECT_UI_MIN_SIZE : DESIGN_UI_MIN_SIZE
  return { width: clamp(width, min.width, DESIGN_UI_MAX_SIZE.width), height: clamp(height, min.height, DESIGN_UI_MAX_SIZE.height) }
}

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return node !== null && !node.removed && node.type !== "PAGE" && node.type !== "DOCUMENT"
}

// Design: switch to the nodes' page if needed, select and zoom. Dev Mode: zoom only (§7.5 impact map).
export async function selectNodes(nodeIds: readonly string[], editorType: PluginEditorType): Promise<number> {
  const nodes: SceneNode[] = []
  for (const nodeId of nodeIds) {
    try {
      const node = await figma.getNodeByIdAsync(nodeId)
      if (isSceneNode(node)) {
        nodes.push(node)
      }
    } catch {
      // Missing or hidden nodes are skipped.
    }
  }
  if (nodes.length === 0) {
    figma.notify("These layers are no longer on the canvas")
    return 0
  }
  if (editorType === "figma") {
    const page = pageOf(nodes[0])
    if (page !== null && page.id !== figma.currentPage.id) {
      await figma.setCurrentPageAsync(page)
    }
  }
  const visible = nodes.filter((node) => pageOf(node)?.id === figma.currentPage.id)
  if (editorType === "figma") {
    figma.currentPage.selection = visible
  }
  figma.viewport.scrollAndZoomIntoView(visible)
  return visible.length
}

export function watchSelection(send: (message: MainToUi) => void): void {
  const changed = () => {
    const page = figma.currentPage
    send({ type: "selection-changed", selectionCount: page.selection.length, pageId: page.id, pageName: page.name })
  }
  figma.on("selectionchange", changed)
  figma.on("currentpagechange", changed)
}

function sendOutcome(bus: MainBus, requestId: RequestId, outcome: OpOutcome): void {
  bus.send({ type: "op-result", requestId, ok: outcomeOk(outcome.errors), done: outcome.done, errors: outcome.errors })
}

// One handler per message type (the bus answers a type without a handler with a handler-error).
export function registerHandlers(bus: MainBus, context: MainContext): void {
  const scanner = createScanner(bus.send)

  bus.on("ui-ready", async () => {
    bus.send(await buildInit(context))
  })
  bus.on("auth-save", (message) => saveAuth(message.auth))
  bus.on("auth-clear", (message) => clearAuth(message.apiBase))
  bus.on("prefs-save", (message) => savePrefs(message.prefs))
  bus.on("cache-save", async (message) => {
    await saveCodegenCache(message.projectId, message.entries, Date.now())
  })
  bus.on("settings-save", (message) => {
    saveFileSettings(message.settings)
    bus.send({ type: "op-result", requestId: message.requestId, ok: true, done: 1, errors: [] })
  })
  bus.on("open-external", (message) => {
    if (!isAllowedExternalUrl(message.url, context.env)) {
      throw new Error("Only web links can be opened")
    }
    figma.openExternal(message.url)
  })
  bus.on("notify", (message) => {
    figma.notify(notifyText(message.message), { error: message.error === true })
  })
  bus.on("resize", (message) => {
    const size = clampUiSize(context.editorType, message.width, message.height)
    figma.ui.resize(size.width, size.height)
  })
  bus.on("select-nodes", async (message) => {
    await selectNodes(message.nodeIds, context.editorType)
  })
  bus.on("scan-request", (message) => scanner.start(message.requestId, message.scope))
  bus.on("scan-cancel", (message) => {
    scanner.cancel(message.requestId)
  })
  bus.on("inspect-request", async () => {
    if (context.inspect !== null) {
      await context.inspect.refresh()
      return
    }
    const selection = await inspectSelection()
    if (selection !== null) {
      bus.send(selection)
    }
  })
  bus.on("link-apply", async (message) => {
    sendOutcome(bus, message.requestId, await applyLinks(message.items, Date.now()))
  })
  bus.on("link-remove", async (message) => {
    sendOutcome(bus, message.requestId, await removeLinks(message.nodeIds))
  })
  bus.on("link-check", async (message) => {
    const nodes = await checkLinks(nodeIdsOf(message.nodeIds), message.inheritors === true)
    bus.send({ type: "link-check-result", requestId: message.requestId, nodes })
  })
  bus.on("screenshots-export", async (message) => {
    await exportScreenshots(message.requestId, frameIdsOf(message.frameIds), bus.send)
  })
  bus.on("text-apply", async (message) => {
    sendOutcome(bus, message.requestId, await applyTexts(message.items, Date.now()))
  })
  bus.on("preview-apply", async (message) => {
    sendOutcome(bus, message.requestId, await applyPreview(message.info, message.items, Date.now()))
  })
  bus.on("preview-reset", async (message) => {
    sendOutcome(bus, message.requestId, await resetPreview(message.scope, message.nodeIds, message.edited))
  })
  bus.on("overflow-check", async (message) => {
    const items = await checkOverflow(nodeIdsOf(message.nodeIds))
    bus.send({ type: "overflow-result", requestId: message.requestId, items })
  })
  bus.on("language-copies", async (message) => {
    const frameIds = frameIdsOf(message.frameIds)
    const copies = languageCopiesOf(message.copies)
    sendOutcome(bus, message.requestId, await makeLanguageCopies(frameIds, copies, Date.now()))
  })
  bus.on("diagnostics-read", async (message) => {
    const report = await runReadDiagnostic(message.test, { env: context.env, apiBase: context.apiBase, startup: context.startup })
    bus.send({ type: "diagnostics-result", requestId: message.requestId, test: message.test, report })
  })
  bus.on("diagnostics-write", async (message) => {
    const report = await runWriteDiagnostic(message.test, Date.now())
    bus.send({ type: "diagnostics-result", requestId: message.requestId, test: message.test, report })
  })
  bus.on("diagnostics-devmode-probe", (message) => {
    bus.send({ type: "diagnostics-result", requestId: message.requestId, test: "T9-devmode-write", report: runDevModeProbe(Date.now()) })
  })
}
