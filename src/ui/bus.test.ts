import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MainToUi } from "../shared/messages"
import { carriesBinary, createIdleTimeout, createUiBus, HandlerError, RequestTimeoutError, toBridge, type UiBusEnvironment } from "./bus"

function fakeEnvironment() {
  const posted: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  const environment: UiBusEnvironment = {
    post: (message) => posted.push(message),
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  return {
    environment,
    posted,
    deliver(message: MainToUi | unknown) {
      listener?.(message)
    },
    get subscribed() {
      return listener !== null
    },
  }
}

const INIT: MainToUi = {
  type: "init",
  editorType: "dev",
  mode: "inspect",
  command: "",
  env: "development",
  apiBase: "http://localhost:8080",
  dashboardBase: "http://localhost:3000",
  pluginVersion: "0.1.0",
  auth: null,
  prefs: {},
  fileSettings: null,
  settingsSource: "none",
  fileName: "File",
  pageId: "0:1",
  pageName: "Page 1",
  selectionCount: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("toBridge", () => {
  it("JSON-clones messages so proxies and functions never reach postMessage", () => {
    const message = { type: "prefs-save", prefs: { a: 1, skip: undefined, fn: () => 1 } }
    const bridged = toBridge(message)
    expect(bridged).toEqual({ type: "prefs-save", prefs: { a: 1 } })
    expect(bridged).not.toBe(message)
  })

  it("passes messages carrying a Uint8Array through untouched", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const message = { type: "upload", bytes }
    expect(carriesBinary(message)).toBe(true)
    expect(toBridge(message)).toBe(message)
    expect(carriesBinary({ type: "x", nested: { bytes } })).toBe(false)
  })
})

describe("createUiBus", () => {
  it("sends ui-ready every 400 ms until init arrives", async () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    const pending = bus.handshake()
    expect(fake.posted).toEqual([{ type: "ui-ready" }])
    await vi.advanceTimersByTimeAsync(1200)
    expect(fake.posted).toHaveLength(4)
    fake.deliver(INIT)
    expect(await pending).toEqual(INIT)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.posted).toHaveLength(4)
  })

  it("delivers messages to every listener of the type and lets them unsubscribe", () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    const first = vi.fn()
    const second = vi.fn()
    const off = bus.on("selection-changed", first)
    bus.on("selection-changed", second)
    const message: MainToUi = { type: "selection-changed", selectionCount: 2, pageId: "0:1", pageName: "Page 1" }
    fake.deliver(message)
    off()
    fake.deliver(message)
    fake.deliver({ nope: true })
    fake.deliver(null)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it("creates request ids as c<time>-<n>", () => {
    const bus = createUiBus(fakeEnvironment().environment)
    expect(bus.nextRequestId()).toMatch(/^c\d+-1$/)
    expect(bus.nextRequestId()).toMatch(/^c\d+-2$/)
  })

  it("resolves a request on its final message and ignores other requests", async () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    const pending = bus.request((requestId) => ({ type: "link-remove", requestId, nodeIds: ["1:1"] }), {
      done: (message) => (message.type === "op-result" ? message : undefined),
    })
    const sent = fake.posted[0] as { requestId: string }
    fake.deliver({ type: "op-result", requestId: "other", ok: true, done: 0, errors: [] })
    fake.deliver({ type: "op-result", requestId: sent.requestId, ok: true, done: 1, errors: [] })
    expect(await pending).toEqual({ type: "op-result", requestId: sent.requestId, ok: true, done: 1, errors: [] })
  })

  it("rejects on handler-error for the request", async () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    const pending = bus.request((requestId) => ({ type: "preview-reset", requestId, scope: "page" }), { done: () => undefined })
    const sent = fake.posted[0] as { requestId: string }
    fake.deliver({ type: "handler-error", forType: "preview-reset", requestId: sent.requestId, message: "Not available in Dev Mode" })
    await expect(pending).rejects.toEqual(new HandlerError("preview-reset", "Not available in Dev Mode"))
  })

  it("times out after 30 s without messages, and progress keeps the request alive", async () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    const pending = bus.request((requestId) => ({ type: "scan-request", requestId, scope: "page" }), {
      done: (message) => (message.type === "scan-done" ? message.total : undefined),
    })
    const requestId = (fake.posted[0] as { requestId: string }).requestId
    const settled = vi.fn()
    pending.then(settled, settled)
    await vi.advanceTimersByTimeAsync(29000)
    fake.deliver({ type: "scan-progress", requestId, scanned: 200 })
    await vi.advanceTimersByTimeAsync(29000)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1001)
    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it("stops listening after dispose", () => {
    const fake = fakeEnvironment()
    const bus = createUiBus(fake.environment)
    expect(fake.subscribed).toBe(true)
    bus.dispose()
    expect(fake.subscribed).toBe(false)
  })
})

describe("createIdleTimeout", () => {
  it("fires once after the idle time and can be cleared", async () => {
    const fired = vi.fn()
    const timeout = createIdleTimeout(100, fired)
    await vi.advanceTimersByTimeAsync(90)
    timeout.touch()
    await vi.advanceTimersByTimeAsync(90)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(fired).toHaveBeenCalledTimes(1)
    const cleared = vi.fn()
    createIdleTimeout(100, cleared).clear()
    await vi.advanceTimersByTimeAsync(200)
    expect(cleared).not.toHaveBeenCalled()
  })
})
