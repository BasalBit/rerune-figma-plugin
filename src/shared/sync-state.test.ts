import { describe, expect, it } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../test/fixtures"
import type { FigmaResolvedKey } from "./api-types"
import { computeSyncState, missingRemoteState, remoteStateFromResolved, type RemoteKeyState } from "./sync-state"

const KEY = keyId(1)

function remote(mainText: string | null, overrides: Partial<RemoteKeyState> = {}): RemoteKeyState {
  return { found: true, key: "checkout_pay_button", type: "key", enabled: true, structured: false, mainText, ...overrides }
}

function linked(characters: string, syncedText: string, overrides: Parameters<typeof linkedNode>[3] = {}, state: Parameters<typeof linkedNode>[2]["state"] = "ok") {
  return linkedNode("12:345", characters, { keyId: KEY, keyName: "checkout_pay_button", syncedText, state }, overrides)
}

describe("computeSyncState (Appendix A.7)", () => {
  it("treats no link, the tombstone and inherited_overridden as unlinked", () => {
    expect(computeSyncState(PROJECT_ID, scannedNode("1:1", "Pay now"), undefined)).toBe("unlinked")
    expect(computeSyncState(PROJECT_ID, linked("Pay now", "Pay now", {}, "inherited_overridden"), remote("Pay now"))).toBe("unlinked")
  })

  it("reports invalid links", () => {
    expect(computeSyncState(PROJECT_ID, scannedNode("1:1", "Pay now", { linkState: "invalid" }), undefined)).toBe("invalid_link")
  })

  it("reports links into another project before anything else", () => {
    const node = linkedNode("12:345", "Pay now", { keyId: KEY, keyName: "k", syncedText: "Pay now", projectId: OTHER_PROJECT_ID, state: "copied" })
    expect(computeSyncState(PROJECT_ID, node, remote("Pay now"))).toBe("other_project")
  })

  it("reports copied links", () => {
    expect(computeSyncState(PROJECT_ID, linked("Pay now", "Pay now", {}, "copied"), remote("Pay now"))).toBe("copied")
  })

  it("is unknown until the remote state is loaded", () => {
    expect(computeSyncState(PROJECT_ID, linked("Pay now", "Pay now"), undefined)).toBe("unknown")
  })

  it("reports keys that no longer exist", () => {
    expect(computeSyncState(PROJECT_ID, linked("Pay now", "Pay now"), missingRemoteState())).toBe("key_missing")
  })

  it.each([
    ["an object key", { type: "object" as const }],
    ["an array key", { type: "array" as const }],
    ["a structured main value", { structured: true }],
    ["a disabled draft", { enabled: false }],
  ])("is readonly for %s", (_label, overrides) => {
    expect(computeSyncState(PROJECT_ID, linked("Pay now", "Pay now"), remote("Pay now", overrides))).toBe("readonly")
  })

  it.each([
    ["synced when t = r", "Pay now", "Pay now", "Pay now", "synced"],
    ["synced when t = r even if s differs", "Pay now", "Old", "Pay now", "synced"],
    ["changed_in_rerune when only t = s", "Pay now", "Pay now", "Pay securely", "changed_in_rerune"],
    ["changed_in_figma when only r = s", "Pay securely", "Pay now", "Pay now", "changed_in_figma"],
    ["conflict when all differ", "Pay securely", "Pay now", "Pay safely", "conflict"],
  ])("is %s", (_label, layer, synced, main, expected) => {
    expect(computeSyncState(PROJECT_ID, linked(layer, synced), remote(main))).toBe(expected)
  })

  it("compares normalised text", () => {
    expect(computeSyncState(PROJECT_ID, linked("  Pay now\r\n", "Pay now"), remote("Pay now "))).toBe("synced")
  })

  it("uses the original text while a preview is active", () => {
    const node = linked("Jetzt zahlen", "Pay now", { originalCharacters: "Pay now" })
    expect(computeSyncState(PROJECT_ID, node, remote("Pay now"))).toBe("synced")
  })

  it("treats a missing main value as empty text", () => {
    expect(computeSyncState(PROJECT_ID, linked("Pay now", ""), remote(null))).toBe("changed_in_figma")
  })

  it("classifies inherited links like ok links", () => {
    const node = linkedNode("I12:34;5:67", "Pay securely", { keyId: KEY, keyName: "k", syncedText: "Pay now", nid: "5:67", state: "inherited" })
    expect(computeSyncState(PROJECT_ID, node, remote("Pay now"))).toBe("changed_in_figma")
  })
})

describe("remoteStateFromResolved", () => {
  function resolved(overrides: Partial<FigmaResolvedKey> = {}): FigmaResolvedKey {
    return {
      id: KEY,
      key: "checkout_pay_button",
      type: "key",
      enabled: true,
      status: "published",
      published: true,
      description: "",
      tags: [],
      max_length: null,
      placeholders: [],
      values: [
        { lang: "en", present: true, resolved_lang: "en", inherited: false, variation_applied: false, content: { value: "Pay now" }, length: 7, exceeds_max_length: false },
      ],
      ...overrides,
    }
  }

  it("reads the main language value", () => {
    expect(remoteStateFromResolved(resolved(), "en")).toEqual(remote("Pay now"))
  })

  it("marks structured content", () => {
    const key = resolved({
      values: [{ lang: "en", present: true, resolved_lang: "en", inherited: false, variation_applied: false, content: { value: "", message: { parts: [{ text: "x" }] } }, length: 1, exceeds_max_length: false }],
    })
    expect(remoteStateFromResolved(key, "en").structured).toBe(true)
  })

  it("has no main text when the value is absent", () => {
    const key = resolved({ values: [{ lang: "en", present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }] })
    expect(remoteStateFromResolved(key, "en").mainText).toBeNull()
    expect(remoteStateFromResolved(resolved(), "de").mainText).toBeNull()
  })

  it("keeps disabled and object keys", () => {
    expect(remoteStateFromResolved(resolved({ enabled: false, type: "object", values: [] }), "en")).toEqual(
      remote(null, { enabled: false, type: "object" }),
    )
  })
})
