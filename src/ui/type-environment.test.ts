import { describe, expect, it } from "vitest"

describe("UI type environment (src/ui/tsconfig.json)", () => {
  it("has DOM types such as AbortController, Blob and FormData", () => {
    const controller = new AbortController()
    controller.abort()
    const form = new FormData()
    form.append("meta", new Blob(["{}"], { type: "application/json" }))
    expect(controller.signal.aborted).toBe(true)
    expect(form.has("meta")).toBe(true)
  })
})
