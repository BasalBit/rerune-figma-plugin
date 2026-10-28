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
  "link-check": { requestId: "r1", nodeIds: [] },
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

describe("undo steps", () => {
  it.each(Object.keys(MESSAGE_IMPACT) as UiToMainType[])("commits %s to undo history only when it may change the document", async (type) => {
    figmaMock.commitUndo.mockClear()
    const instance = bus("figma", "development")
    instance.on(type, vi.fn())
    await instance.dispatch({ type, ...SAMPLE_MESSAGES[type] })
    const impact = MESSAGE_IMPACT[type]
    const writes = impact === "metadata" || impact === "canvas"
    expect(figmaMock.commitUndo).toHaveBeenCalledTimes(writes ? 1 : 0)
  })

  it("commits after the handler's writes, also when it fails, and survives a failing commit", async () => {
    const order: string[] = []
    figmaMock.commitUndo.mockImplementation(() => order.push("commit"))
    const instance = bus("figma")
    instance.on("text-apply", async () => {
      order.push("write")
      throw new Error("write refused")
    })
    await instance.dispatch({ type: "text-apply", requestId: "c1", items: [] })
    expect(order).toEqual(["write", "commit"])
    expect(sent).toEqual([{ type: "handler-error", forType: "text-apply", requestId: "c1", message: "write refused" }])

    figmaMock.commitUndo.mockImplementation(() => {
      throw new Error("no undo here")
    })
    instance.on("link-remove", () => {})
    await expect(instance.dispatch({ type: "link-remove", requestId: "c2", nodeIds: [] })).resolves.toBeUndefined()
  })

  it("leaves a write sent with commit: false to the next write's undo step", async () => {
    const order: string[] = []
    figmaMock.commitUndo.mockImplementation(() => order.push("commit"))
    const instance = bus("figma")
    instance.on("preview-apply", (message) => {
      order.push("apply " + message.requestId)
    })
    instance.on("overflow-check", (message) => {
      order.push("check " + message.requestId)
    })
    instance.on("preview-reset", () => {
      order.push("reset")
    })
    await instance.dispatch({ type: "preview-apply", requestId: "a", info: {}, items: [], commit: false })
    await instance.dispatch({ type: "overflow-check", requestId: "b", nodeIds: [], commit: false })
    await instance.dispatch({ type: "preview-apply", requestId: "c", info: {}, items: [], commit: false })
    await instance.dispatch({ type: "preview-reset", requestId: "d", scope: "page" })
    expect(order).toEqual(["apply a", "check b", "apply c", "reset", "commit"])
    await instance.dispatch({ type: "preview-apply", requestId: "e", info: {}, items: [] })
    expect(order.slice(-2)).toEqual(["apply e", "commit"])
  })

  it("does not commit refused writes", async () => {
    figmaMock.commitUndo.mockClear()
    const instance = bus("dev")
    instance.on("preview-apply", vi.fn())
    await instance.dispatch({ type: "preview-apply", requestId: "c1", info: {}, items: [] })
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
  })
})

describe("document writes run one at a time", () => {
  function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it("starts a write only after the previous write ended, in arrival order; reads are not queued", async () => {
    const order: string[] = []
    const gate = deferred()
    const instance = bus("figma")
    instance.on("preview-apply", async (message) => {
      order.push("start " + message.requestId)
      if (message.requestId === "a") {
        await gate.promise
      }
      order.push("end " + message.requestId)
    })
    instance.on("settings-save", () => {
      order.push("settings")
    })
    instance.on("scan-request", () => {
      order.push("scan")
    })
    const first = instance.dispatch({ type: "preview-apply", requestId: "a", info: {}, items: [] })
    const second = instance.dispatch({ type: "preview-apply", requestId: "b", info: {}, items: [] })
    const third = instance.dispatch({ type: "settings-save", requestId: "c", settings: {} })
    await instance.dispatch({ type: "scan-request", requestId: "d", scope: "page" })
    for (let tick = 0; tick < 10; tick++) await Promise.resolve()
    expect(order.slice().sort()).toEqual(["scan", "start a"])
    gate.resolve()
    await Promise.all([first, second, third])
    expect(order.filter((entry) => entry !== "scan")).toEqual(["start a", "end a", "start b", "end b", "settings"])
  })

  it("commits each write's undo step before the next write starts", async () => {
    const order: string[] = []
    figmaMock.commitUndo.mockImplementation(() => order.push("commit"))
    const instance = bus("figma")
    instance.on("preview-apply", async (message) => {
      order.push("write " + message.requestId)
      await Promise.resolve()
      order.push("wrote " + message.requestId)
    })
    await Promise.all([
      instance.dispatch({ type: "preview-apply", requestId: "a", info: {}, items: [] }),
      instance.dispatch({ type: "preview-apply", requestId: "b", info: {}, items: [] }),
    ])
    expect(order).toEqual(["write a", "wrote a", "commit", "write b", "wrote b", "commit"])
  })

  it("runs the next write after one that failed, and after one whose error notice failed", async () => {
    const instance = bus("figma")
    const after = vi.fn()
    instance.on("text-apply", () => {
      throw new Error("write refused")
    })
    instance.on("link-remove", after)
    figmaMock.notify.mockImplementationOnce(() => {
      throw new Error("no notify")
    })
    const failing = instance.dispatch({ type: "text-apply", requestId: "a", items: [] })
    const next = instance.dispatch({ type: "link-remove", requestId: "b", nodeIds: [] })
    await expect(failing).rejects.toThrow("no notify")
    await next
    expect(after).toHaveBeenCalledTimes(1)
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

  it("answers known types without a registered handler with a handler-error", async () => {
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
