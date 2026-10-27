import { describe, expect, it } from "vitest"
import { keyId, linkedNode, scannedNode } from "../../test/fixtures"
import { inspectModel } from "./inspect-model"

describe("inspectModel", () => {
  it("is empty without a selection", () => {
    expect(inspectModel(null)).toEqual({ kind: "empty", keys: [] })
    expect(inspectModel({ type: "inspect-selection", kind: "none", nodes: [] })).toEqual({ kind: "empty", keys: [] })
  })

  it("says when the selected text has no key", () => {
    expect(inspectModel({ type: "inspect-selection", kind: "text", nodes: [scannedNode("1:1", "Plain")] })).toEqual({ kind: "unlinked", keys: [] })
  })

  it("lists one row per key with the layer count", () => {
    const nodes = [
      linkedNode("1:1", "Pay   now", { keyId: keyId(1), keyName: "checkout_pay_button", syncedText: "Pay now" }),
      linkedNode("I2:1;1:1", "Pay now", { keyId: keyId(1), keyName: "checkout_pay_button", syncedText: "Pay now", nid: "1:1", state: "inherited" }),
      linkedNode("1:3", "Cancel", { keyId: keyId(2), keyName: "checkout_cancel", syncedText: "Cancel", nid: "1:9", state: "copied" }),
      linkedNode("1:4", "Own text", { keyId: keyId(3), keyName: "overridden", syncedText: "x", nid: "1:8", state: "inherited_overridden" }),
      scannedNode("1:5", "Unlinked"),
    ]
    expect(inspectModel({ type: "inspect-selection", kind: "container", nodes })).toEqual({
      kind: "keys",
      keys: [
        { keyId: keyId(1), keyName: "checkout_pay_button", layerText: "Pay now", layers: 2, state: "ok" },
        { keyId: keyId(2), keyName: "checkout_cancel", layerText: "Cancel", layers: 1, state: "copied" },
      ],
    })
  })

  it("shows the original text of a previewing layer and shortens long text", () => {
    const previewing = linkedNode("1:1", "Jetzt zahlen", { keyId: keyId(1), keyName: "pay", syncedText: "Pay now" }, { originalCharacters: "Pay now" })
    const long = linkedNode("1:2", "x".repeat(200), { keyId: keyId(2), keyName: "long", syncedText: "x" })
    const keys = inspectModel({ type: "inspect-selection", kind: "container", nodes: [previewing, long] }).keys
    expect(keys[0].layerText).toBe("Pay now")
    expect(keys[1].layerText).toHaveLength(80)
    expect(keys[1].layerText.endsWith("…")).toBe(true)
  })
})
