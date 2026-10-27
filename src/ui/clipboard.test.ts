import { describe, expect, it, vi } from "vitest"
import { copyText, type ClipboardDocument } from "./clipboard"

function fakeDocument(options: { withClipboardData: boolean; throws?: boolean }) {
  const listeners = new Set<(event: ClipboardEvent) => void>()
  const data = new Map<string, string>()
  const area = { value: "", style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }
  const doc = {
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => area),
    addEventListener: (_type: "copy", listener: (event: ClipboardEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "copy", listener: (event: ClipboardEvent) => void) => listeners.delete(listener),
    execCommand: vi.fn(() => {
      if (options.throws) {
        throw new Error("blocked")
      }
      const event = {
        clipboardData: options.withClipboardData ? { setData: (type: string, value: string) => data.set(type, value) } : null,
        preventDefault: vi.fn(),
      }
      listeners.forEach((listener) => listener(event as unknown as ClipboardEvent))
      return true
    }),
  }
  return { doc: doc as unknown as ClipboardDocument, data, area, listeners }
}

describe("copyText", () => {
  it("writes the text through a one-shot copy listener and cleans up", async () => {
    const fake = fakeDocument({ withClipboardData: true })
    const clipboard = { writeText: vi.fn(async () => {}) }
    expect(await copyText("checkout_pay_button", fake.doc, clipboard)).toBe(true)
    expect(fake.data.get("text/plain")).toBe("checkout_pay_button")
    expect(fake.area.select).toHaveBeenCalled()
    expect(fake.area.remove).toHaveBeenCalled()
    expect(fake.listeners.size).toBe(0)
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it("falls back to the async Clipboard API when the copy event did not carry the data", async () => {
    const fake = fakeDocument({ withClipboardData: false })
    const clipboard = { writeText: vi.fn(async () => {}) }
    expect(await copyText("key", fake.doc, clipboard)).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith("key")
  })

  it("reports failure when nothing works", async () => {
    const fake = fakeDocument({ withClipboardData: false, throws: true })
    expect(await copyText("key", fake.doc, undefined)).toBe(false)
    const rejecting = { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }
    expect(await copyText("key", fake.doc, rejecting)).toBe(false)
    expect(fake.area.remove).toHaveBeenCalledTimes(2)
  })
})
