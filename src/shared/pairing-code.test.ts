import { describe, expect, it } from "vitest"
import { canonicalPairingCode, displayPairingCode, isValidPairingCode, samePairingCode } from "./pairing-code"

describe("pairing code (Appendix A.1)", () => {
  it.each([
    ["K7P-4QX", "K7P4QX", "K7P-4QX"],
    ["k7p4qx", "K7P4QX", "K7P-4QX"],
    ["  k7p 4qx ", "K7P4QX", "K7P-4QX"],
  ])("accepts %j", (input, canonical, display) => {
    expect(canonicalPairingCode(input)).toBe(canonical)
    expect(displayPairingCode(input)).toBe(display)
    expect(isValidPairingCode(input)).toBe(true)
  })

  it.each(["K7P-4QO", "K7P-4Q1", "K7P-4Q", "K7P_4QX", "", "K7P-4QXX"])("rejects %j", (input) => {
    expect(canonicalPairingCode(input)).toBeNull()
    expect(displayPairingCode(input)).toBeNull()
    expect(isValidPairingCode(input)).toBe(false)
  })

  it("compares codes after normalising", () => {
    expect(samePairingCode("k7p 4qx", "K7P-4QX")).toBe(true)
    expect(samePairingCode("K7P-4QX", "K7P-4QY")).toBe(false)
    expect(samePairingCode("bad", "bad")).toBe(false)
  })
})
