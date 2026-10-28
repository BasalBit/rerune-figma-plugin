import { describe, expect, it } from "vitest"
import { pseudoChar, pseudoLocalize, pseudoPadding } from "./pseudo"

// Appendix A.6, letter by letter.
const MAP: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
}

describe("pseudoLocalize (Appendix A.6)", () => {
  it("matches the spec vectors", () => {
    expect(pseudoLocalize("Pay now")).toBe("⟦Þáý ñóŵ···⟧")
    expect(pseudoLocalize("Hi {{name}}")).toBe("⟦Ĥí {{name}}·····⟧")
  })

  it("maps every ASCII letter as the appendix lists", () => {
    for (const [from, to] of Object.entries(MAP)) {
      expect(pseudoChar(from)).toBe(to)
    }
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    expect(pseudoLocalize(alphabet)).toBe("⟦" + Array.from(alphabet, (char) => MAP[char]).join("") + "·".repeat(16) + "⟧")
  })

  it("leaves other characters as they are", () => {
    const others = "0123456789 .,;:!?'\"()[]{}<>@#$%&*+-=_/\\|~^`äöüßÄÖÜéñ中文العربية😀\t"
    for (const char of others) {
      expect(pseudoChar(char)).toBe(char)
    }
    expect(pseudoLocalize("1 + 2")).toBe("⟦1 + 2··⟧")
  })

  it("keeps every {{…}} token unchanged and maps the text around it", () => {
    expect(pseudoLocalize("{{count}} items for {{user_name}}")).toBe("⟦{{count}} íţéɱš ƒóŕ {{user_name}}··········⟧")
    expect(pseudoLocalize("{{}} a")).toBe("⟦{{}} á···⟧")
    expect(pseudoLocalize("{name} and {{ spaced }}")).toBe("⟦{ñáɱé} áñð {{ spaced }}·······⟧")
  })

  it("pads 40% up to 20 UTF-16 units and 30% above, rounded up", () => {
    expect(pseudoPadding("")).toBe(0)
    expect(pseudoLocalize("")).toBe("⟦⟧")
    expect(pseudoPadding("a")).toBe(1)
    expect(pseudoPadding("a".repeat(20))).toBe(8)
    expect(pseudoPadding("a".repeat(21))).toBe(7)
    expect(pseudoPadding("a".repeat(100))).toBe(30)
    expect(pseudoPadding("😀")).toBe(1)
    expect(pseudoPadding("😀".repeat(10))).toBe(8)
    expect(pseudoPadding("😀".repeat(11))).toBe(7)
  })

  it("keeps line breaks and pads at the end", () => {
    expect(pseudoLocalize("Line one\nLine two")).toBe("⟦Ļíñé óñé\nĻíñé ţŵó·······⟧")
  })
})
