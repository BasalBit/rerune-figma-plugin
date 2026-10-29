import { describe, expect, it } from "vitest"
import { keyNameParts, KeyTag } from "./key-tag"

describe("keyNameParts", () => {
  it("cuts a key name after each separator, so it wraps at boundaries", () => {
    expect(keyNameParts("checkout.payment_summary.total-amount/label:v2")).toEqual(["checkout.", "payment_", "summary.", "total-", "amount/", "label:", "v2"])
    expect(keyNameParts("checkout")).toEqual(["checkout"])
    expect(keyNameParts("a__b")).toEqual(["a_", "_", "b"])
    expect(keyNameParts("trailing.")).toEqual(["trailing."])
    expect(keyNameParts("")).toEqual([])
  })

  it("keeps every character", () => {
    for (const name of ["home_title", "a.b.c", "x--y", "ns:key/path.leaf_1"]) {
      expect(keyNameParts(name).join("")).toBe(name)
    }
  })
})

describe("KeyTag", () => {
  it("is the key name only, untranslated, with the full name as its title", () => {
    const tag = KeyTag({ name: "checkout_title", pending: true })
    expect(tag.props).toMatchObject({ class: "rr-key rr-key--pending", title: "checkout_title", translate: false })
    expect(KeyTag({ name: "a", large: true }).props.class).toBe("rr-key rr-key--lg")
    expect(KeyTag({ name: "a" }).props.class).toBe("rr-key")
  })
})
