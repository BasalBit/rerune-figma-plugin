import { describe, expect, it } from "vitest"
import { firstRunes, isNumericOnly, normalizeDesignText, trimSpace, truncateUtf16, utf16Length } from "./text"

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const NEL = String.fromCharCode(0x85)
const BOM = String.fromCharCode(0xfeff)

// Every code point Go's unicode.IsSpace accepts (strings.TrimSpace), listed by go1.27 over U+0000–U+10FFFF.
const GO_SPACES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]

describe("normalizeDesignText (Appendix A.3)", () => {
  it("turns CRLF, CR, U+2028 and U+2029 into LF", () => {
    expect(normalizeDesignText("a\r\nb\rc" + LS + "d" + PS + "e")).toBe("a\nb\nc\nd\ne")
  })

  it("trims leading and trailing whitespace only", () => {
    expect(normalizeDesignText("  Pay  now \r\n")).toBe("Pay  now")
    expect(normalizeDesignText("\n\tline one\nline two\n")).toBe("line one\nline two")
  })
})

describe("trimSpace (Go strings.TrimSpace)", () => {
  it("trims exactly the characters Go's unicode.IsSpace treats as space", () => {
    const trimmed: number[] = []
    for (let code = 0; code <= 0xffff; code++) {
      if (trimSpace("a" + String.fromCharCode(code)) === "a") {
        trimmed.push(code)
      }
    }
    expect(trimmed).toEqual(GO_SPACES)
  })

  it("trims U+0085 and keeps U+FEFF, unlike String.prototype.trim", () => {
    expect(trimSpace(NEL + " Checkout\t" + NEL)).toBe("Checkout")
    expect(trimSpace(BOM + "Checkout" + BOM)).toBe(BOM + "Checkout" + BOM)
    expect(trimSpace(String.fromCharCode(0x3000, 0xa0) + "Pay " + NEL + " now" + LS)).toBe("Pay " + NEL + " now")
    expect(trimSpace(NEL + " \n")).toBe("")
    expect(trimSpace("")).toBe("")
  })

  it("keeps a supplementary character next to the trimmed space whole", () => {
    expect(trimSpace(" 😀 ")).toBe("😀")
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
