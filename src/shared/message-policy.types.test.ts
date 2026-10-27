import { describe, expect, it } from "vitest"
import { MESSAGE_IMPACT, type Impact } from "./message-policy"
import type { UiToMain } from "./messages"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

const keysMatchMessages: Equal<keyof typeof MESSAGE_IMPACT, UiToMain["type"]> = true

// @ts-expect-error an impact map that leaves out a message type must not compile
const missingType: Record<UiToMain["type"], Impact> = { "ui-ready": "ui" }

// @ts-expect-error an impact map with a type that is not a message must not compile
const extraType: Record<UiToMain["type"], Impact> = { ...MESSAGE_IMPACT, "made-up": "ui" }

// @ts-expect-error an impact outside the five classes must not compile
const unknownImpact: Record<UiToMain["type"], Impact> = { ...MESSAGE_IMPACT, "ui-ready": "write" }

describe("message-policy exhaustiveness (compiled by tsc -p .)", () => {
  it("has the compile-time guards in place", () => {
    expect(keysMatchMessages).toBe(true)
    expect(Object.keys(missingType)).toEqual(["ui-ready"])
    expect(extraType).toHaveProperty("made-up")
    expect(unknownImpact["ui-ready"]).toBe("write")
  })
})
