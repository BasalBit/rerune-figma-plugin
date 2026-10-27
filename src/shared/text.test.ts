import { describe, expect, it } from "vitest"
import { firstRunes, isNumericOnly, normalizeDesignText, truncateUtf16, utf16Length } from "./text"

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

describe("normalizeDesignText (Appendix A.3)", () => {
  it("turns CRLF, CR, U+2028 and U+2029 into LF", () => {
    expect(normalizeDesignText("a\r\nb\rc" + LS + "d" + PS + "e")).toBe("a\nb\nc\nd\ne")
  })

  it("trims leading and trailing whitespace only", () => {
    expect(normalizeDesignText("  Pay  now \r\n")).toBe("Pay  now")
    expect(normalizeDesignText("\n\tline one\nline two\n")).toBe("line one\nline two")
  })
})

describe("isNumericOnly (Appendix A.3)", () => {
  it.each([
    ["42", true],
    ["$1,299.00", true],
    ["12:30", true],
    ["2x", true],
    ["Step 2", false],
    ["XXL", false],
    ["", false],
  ])("%j → %s", (input, expected) => {
    expect(isNumericOnly(input)).toBe(expected)
  })

  it("accepts the listed currency, dash and quote characters", () => {
    expect(isNumericOnly("€ 1–2 £3 ¥4 ₹5 (6) #7 *8 9×1 10’ \"11\" 12%")).toBe(true)
    expect(isNumericOnly("1 — 2 / 3; 4+5")).toBe(true)
  })

  it("needs an ASCII digit", () => {
    expect(isNumericOnly("$ – %")).toBe(false)
    expect(isNumericOnly("٤٢")).toBe(false)
  })
})

describe("length helpers", () => {
  it("counts UTF-16 code units like the server", () => {
    expect(utf16Length("Jetzt zahlen")).toBe(12)
    expect(utf16Length("😀")).toBe(2)
  })

  it("never splits a surrogate pair when truncating", () => {
    expect(truncateUtf16("ab😀", 3)).toBe("ab")
    expect(truncateUtf16("abc", 5)).toBe("abc")
    expect(truncateUtf16("abcdef", 4)).toBe("abcd")
  })

  it("takes the first runes", () => {
    expect(firstRunes("😀abc", 2)).toBe("😀a")
  })
})
