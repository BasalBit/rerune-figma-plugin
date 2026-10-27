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

  // Beyond A.1: the server's Go normaliser is the reference (strings.ToUpper maps one code point to one;
  // unicode.IsSpace includes U+0085 and excludes U+FEFF). Every single code point was compared with Go.
  it.each([
    ["K7P\u00854QX", "K7P4QX"],
    ["K7P\u00a04QX", "K7P4QX"],
    ["K7P\u30004QX", "K7P4QX"],
    ["K7P\u20284QX", "K7P4QX"],
    ["k7p4q\u017f", "K7P4QS"],
  ])("normalises %j like the server", (input, canonical) => {
    expect(canonicalPairingCode(input)).toBe(canonical)
    expect(samePairingCode(input, canonical)).toBe(true)
  })

  it.each(["\u00dfK7P4", "\ufb00K7P4", "\ufb06K7P4", "K7P\ufeff4QX", "K7P\u200b4QX"])("rejects %j like the server", (input) => {
    expect(canonicalPairingCode(input)).toBeNull()
    expect(isValidPairingCode(input)).toBe(false)
  })

  it("compares codes after normalising", () => {
    expect(samePairingCode("k7p 4qx", "K7P-4QX")).toBe(true)
    expect(samePairingCode("K7P-4QX", "K7P-4QY")).toBe(false)
    expect(samePairingCode("bad", "bad")).toBe(false)
  })
})
