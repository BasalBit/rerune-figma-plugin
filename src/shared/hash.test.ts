import { describe, expect, it } from "vitest"
import { cyrb53, src } from "./hash"

const LS = String.fromCharCode(0x2028)

describe("src (Appendix A.3)", () => {
  it.each([
    ["", "c53:bdcb81aee8d83"],
    ["Pay now", "c53:1442abda685db2"],
    ["  Pay now \r\n", "c53:1442abda685db2"],
    ["Pay\nnow", "c53:12de0cb44dffda"],
    ["Pay" + LS + "now", "c53:12de0cb44dffda"],
    ["Jetzt zahlen", "c53:1e9705dc1b274d"],
    ["Hi {{name}}", "c53:6764366450577"],
  ])("hashes %j to %s", (input, expected) => {
    expect(src(input)).toBe(expected)
  })

  it("is the hex cyrb53 of the normalised text", () => {
    expect(src(" a\r\nb ")).toBe("c53:" + cyrb53("a\nb").toString(16))
  })

  it("changes with the seed", () => {
    expect(cyrb53("Pay now", 1)).not.toBe(cyrb53("Pay now"))
  })
})
