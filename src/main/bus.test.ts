import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFigma, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { MESSAGE_IMPACT } from "../shared/message-policy"
import type { MainToUi, UiToMainType } from "../shared/messages"
import { createMainBus, DEV_MODE_REFUSAL, DEVPROBE_REFUSAL, errorText, NOT_IMPLEMENTED, notifyText } from "./bus"

let figmaMock: FigmaMock
let sent: MainToUi[]

beforeEach(() => {
  figmaMock = installFigma()
  sent = []
})

afterEach(() => {
  uninstallFigma()
})

function bus(editorType: "figma" | "dev", env: "production" | "development" = "production") {
  return createMainBus(editorType, env, (message) => sent.push(message))
}

const SAMPLE_MESSAGES: Record<UiToMainType, Record<string, unknown>> = {
  "ui-ready": {},
  "auth-save": { auth: {} },
  "auth-clear": { apiBase: "x" },
  "prefs-save": { prefs: {} },
  "cache-save": { projectId: "p", entries: [] },
  "settings-save": { requestId: "r1", settings: {} },
  "open-external": { url: "https://rerune.io" },
  "notify": { message: "hi" },
  "resize": { width: 400, height: 640 },
  "select-nodes": { nodeIds: [] },
  "scan-request": { requestId: "r1", scope: "selection" },
  "scan-cancel": { requestId: "r1" },
  "link-apply": { requestId: "r1", items: [] },
  "link-remove": { requestId: "r1", nodeIds: [] },
  "text-apply": { requestId: "r1", items: [] },
  "preview-apply": { requestId: "r1", info: {}, items: [] },
  "preview-reset": { requestId: "r1", scope: "page" },
  "screenshots-export": { requestId: "r1", frameIds: [] },
  "inspect-request": {},
  "overflow-check": { requestId: "r1", nodeIds: [] },
  "language-copies": { requestId: "r1", frameIds: [], copies: [] },
  "diagnostics-read": { requestId: "r1", test: "T10-environment" },
  "diagnostics-write": { requestId: "r1", test: "T1-mark" },
  "diagnostics-devmode-probe": { requestId: "r1" },
}

describe("main bus guard (§7.5 impact map)", () => {
  it.each(Object.keys(MESSAGE_IMPACT) as UiToMainType[])("routes %s according to its impact in Design and Dev Mode", async (type) => {
    for (const editorType of ["figma", "dev"] as const) {
      for (const env of ["production", "development"] as const) {
        sent = []
        figmaMock.notify.mockClear()
        const instance = bus(editorType, env)
        const handler = vi.fn()
        instance.on(type, handler)
        await instance.dispatch({ type, ...SAMPLE_MESSAGES[type] })
        const impact = MESSAGE_IMPACT[type]
        const allowed = impact === "ui" || impact === "read" || (impact === "devprobe" ? editorType === "dev" && env === "development" : editorType === "figma")
        expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0)
        if (!allowed) {
          const refusal = impact === "devprobe" ? DEVPROBE_REFUSAL : DEV_MODE_REFUSAL
          expect(figmaMock.notify).toHaveBeenCalledWith(refusal, { error: true })
          const requestId = SAMPLE_MESSAGES[type].requestId
          expect(sent).toEqual([requestId === undefined ? { type: "handler-error", forType: type, message: refusal } : { type: "handler-error", forType: type, requestId, message: refusal }])
        }
      }
    }
  })

  it("refuses canvas writes in Dev Mode with the Dev Mode notice", async () => {
    const instance = bus("dev")
    const handler = vi.fn()
    instance.on("preview-apply", handler)
    await instance.dispatch({ type: "preview-apply", requestId: "c1-1", info: {}, items: [] })
    expect(handler).not.toHaveBeenCalled()
    expect(figmaMock.notify).toHaveBeenCalledWith("Not available in Dev Mode", { error: true })
    expect(sent).toEqual([{ type: "handler-error", forType: "preview-apply", requestId: "c1-1", message: "Not available in Dev Mode" }])
  })
})

describe("main bus error boundary", () => {
  it("turns a thrown error into a notify (≤ 100 chars) and a handler-error", async () => {
    const instance = bus("figma")
    instance.on("link-apply", async () => {
      throw new Error("x".repeat(300))
    })
    await instance.dispatch({ type: "link-apply", requestId: "c2-1", items: [] })
    const [text, options] = figmaMock.notify.mock.calls[0] as [string, NotificationOptions]
    expect(text.length).toBe(100)
    expect(text.startsWith("ReRune: ")).toBe(true)
    expect(options).toEqual({ error: true })
    expect(sent).toEqual([{ type: "handler-error", forType: "link-apply", requestId: "c2-1", message: "x".repeat(300) }])
  })

  it("catches synchronous throws and rejections from non-Error values", async () => {
    const instance = bus("figma")
    instance.on("notify", () => {
      throw "plain failure"
    })
    await instance.dispatch({ type: "notify", message: "x" })
    expect(sent).toEqual([{ type: "handler-error", forType: "notify", message: "plain failure" }])
  })

  it("logs only the type of unknown messages, never the payload", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const instance = bus("figma")
    await instance.dispatch({ type: "steal-token", token: "rrf_secret" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0])).toContain("steal-token")
    expect(String(log.mock.calls[0])).not.toContain("rrf_secret")
    expect(sent).toEqual([])
    expect(figmaMock.notify).not.toHaveBeenCalled()
  })

  it("ignores values without a type", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const instance = bus("figma")
    await instance.dispatch(null)
    await instance.dispatch("ui-ready")
    await instance.dispatch({ type: 7 })
    expect(log).toHaveBeenCalledTimes(3)
    expect(sent).toEqual([])
  })

  it("answers known types without a handler (later phases) with a handler-error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const instance = bus("figma")
    await instance.dispatch({ type: "overflow-check", requestId: "c3-1", nodeIds: [] })
    expect(sent).toEqual([{ type: "handler-error", forType: "overflow-check", requestId: "c3-1", message: NOT_IMPLEMENTED }])
    expect(figmaMock.notify).not.toHaveBeenCalled()
  })

  it("keeps one handler per type (the last registration wins)", async () => {
    const instance = bus("figma")
    const first = vi.fn()
    const second = vi.fn()
    instance.on("ui-ready", first)
    instance.on("ui-ready", second)
    await instance.dispatch({ type: "ui-ready" })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe("bus helpers", () => {
  it("truncates notify text to 100 UTF-16 units", () => {
    expect(notifyText("a".repeat(150))).toHaveLength(100)
    expect(notifyText("short")).toBe("short")
  })

  it("extracts error text", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
    expect(errorText("text")).toBe("text")
    expect(errorText(new Error(""))).toBe("Unexpected error")
    expect(errorText(42)).toBe("Unexpected error")
  })
})
