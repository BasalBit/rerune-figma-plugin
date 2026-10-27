import { describe, expect, it, vi } from "vitest"
import { keyId, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaByNameRequest, FigmaByNameResponse } from "../../shared/api-types"
import { MAX_BATCH_SIZE } from "../../shared/constants"
import { src } from "../../shared/hash"
import type { ScannedNode } from "../../shared/messages"
import {
  createBlockedReason,
  EMPTY_SOURCE_NOTE,
  exactMatchKeys,
  exactTextQueries,
  fetchExactCandidates,
  linkDecision,
  pendingNamesExcept,
  preferredKey,
  remotePlainText,
  searchPrefill,
  sharedText,
  unlinkTargets,
  STRUCTURED_NOTE,
} from "./link"

const KEY = { id: keyId(1), key: "checkout_pay_button", main_content: { value: "Pay now" } }

describe("linkDecision", () => {
  it("links directly with src(text) when the layer text equals the key's main text", () => {
    const decision = linkDecision([scannedNode("1:1", "  Pay now\r\n")], KEY, PROJECT_ID)
    expect(decision).toEqual({
      kind: "direct",
      links: [{ nodeId: "1:1", keyId: keyId(1), keyName: "checkout_pay_button", projectId: PROJECT_ID, src: src("Pay now") }],
      note: null,
    })
  })

  it("asks Use ReRune text / Keep layer text when the texts differ", () => {
    const nodes = [scannedNode("1:1", "Pay now"), scannedNode("1:2", "Pay")]
    const decision = linkDecision(nodes, KEY, PROJECT_ID)
    if (decision.kind !== "ask") {
      throw new Error("expected a question")
    }
    expect(decision.differing).toBe(1)
    expect(decision.remoteText).toBe("Pay now")
    // Both choices link with src(remote): kept text then reads changed_in_figma, applied text reads synced.
    expect(decision.keep.map((item) => item.src)).toEqual([src("Pay now"), src("Pay now")])
    expect(decision.use.links).toEqual(decision.keep)
    expect(decision.use.texts).toEqual([
      { nodeId: "1:1", text: "Pay now", src: src("Pay now") },
      { nodeId: "1:2", text: "Pay now", src: src("Pay now") },
    ])
  })

  it("compares the original text of a previewing layer", () => {
    const decision = linkDecision([scannedNode("1:1", "Jetzt zahlen", { originalCharacters: "Pay now" })], KEY, PROJECT_ID)
    expect(decision.kind).toBe("direct")
  })

  it("links structured keys read-only and empty keys as changed in Figma", () => {
    const structured = linkDecision([scannedNode("1:1", "3 items")], { ...KEY, main_content: { value: "", message: { parts: [{ text: "x" }] } } }, PROJECT_ID)
    expect(structured).toMatchObject({ kind: "direct", note: STRUCTURED_NOTE })
    expect(structured.kind === "direct" && structured.links[0].src).toBe(src("3 items"))
    const empty = linkDecision([scannedNode("1:1", "Pay now")], { ...KEY, main_content: null }, PROJECT_ID)
    expect(empty).toMatchObject({ kind: "direct", note: EMPTY_SOURCE_NOTE })
    expect(empty.kind === "direct" && empty.links[0].src).toBe(src(""))
  })
})

describe("Unlink targets", () => {
  it("are the linked layers only: unlinked and overridden instance text are not written (D44)", () => {
    const nodes = (["none", "ok", "copied", "inherited", "inherited_overridden", "invalid"] as const).map((linkState, index) => scannedNode("1:" + index, "Pay now", { linkState }))
    expect(unlinkTargets(nodes)).toEqual(["1:1", "1:2", "1:3", "1:5"])
  })
})

describe("Create new key availability", () => {
  const unlinked = (nodeId: string) => scannedNode(nodeId, "Pay now")
  const withState = (nodeId: string, linkState: ScannedNode["linkState"]) => scannedNode(nodeId, "Pay now", { linkState })

  it("is offered for unlinked layers and instance text that overrides an inherited link", () => {
    expect(createBlockedReason([unlinked("1:1"), withState("I2:1;3:3", "inherited_overridden")])).toBeNull()
  })

  it("is not offered once any layer is linked, because only unlinked layers become creates", () => {
    expect(createBlockedReason([withState("1:1", "ok")])).toBe("This layer is linked to a key. Unlink it first to create a new key for it.")
    expect(createBlockedReason([withState("1:1", "copied")])).toBe(
      "This layer is linked to a key. Unlink it first to create a new key for it. For a copied layer you can also choose New key on the Push screen.",
    )
    expect(createBlockedReason([unlinked("1:1"), withState("I2:1;3:3", "inherited"), withState("1:3", "invalid")])).toBe(
      "2 of these layers are linked to keys. Unlink them first to create a new key.",
    )
  })
})

describe("dialog helpers", () => {
  it("reads plain text from content", () => {
    expect(remotePlainText({ value: "x" })).toBe("x")
    expect(remotePlainText(null)).toBe("")
    expect(remotePlainText({ value: "", message: { parts: [] } })).toBeNull()
  })

  it("requires one shared text to create one key", () => {
    expect(sharedText([scannedNode("1", "A "), scannedNode("2", "A")])).toBe("A")
    expect(sharedText([scannedNode("1", "A"), scannedNode("2", "B")])).toBeNull()
    expect(sharedText([])).toBeNull()
  })

  it("builds exact-text queries of any length up to the E11 limit", () => {
    expect(exactTextQueries([scannedNode("1", "A"), scannedNode("2", " A"), scannedNode("3", "  "), scannedNode("4", "y".repeat(400))])).toEqual(["A", "y".repeat(400)])
    expect(exactTextQueries([scannedNode("1", "z".repeat(5001))])).toEqual([])
  })

  it("collects exact-match keys and prefers a single one", () => {
    const keys = exactMatchKeys(new Map([["A", [{ id: "1", key: "a" }]], ["B", [{ id: "1", key: "a" }, { id: "2", key: "b" }]]]))
    expect(keys).toEqual([{ id: "1", key: "a" }, { id: "2", key: "b" }])
    expect(preferredKey([{ id: "1", key: "a" }])).toEqual({ id: "1", key: "a" })
    expect(preferredKey(keys)).toBeNull()
  })

  it("prefills search with the first line, cut to 100 runes", () => {
    expect(searchPrefill("\n  Pay now  \nsecond line")).toBe("Pay now")
    expect(searchPrefill("😀".repeat(120))).toBe("😀".repeat(100))
    expect(searchPrefill("   ")).toBe("")
  })

  it("lists pending names of other layers that would not share the key", () => {
    const pending = new Map([["1", "a"], ["2", "b"], ["3", "c"]])
    expect([...pendingNamesExcept(pending, ["1"])]).toEqual(["b", "c"])
    expect([...pendingNamesExcept(pending, ["1"], (nodeId) => nodeId === "3")]).toEqual(["b"])
  })
})

describe("fetchExactCandidates (Link dialog, D40)", () => {
  function byName(answer: (request: FigmaByNameRequest) => FigmaByNameResponse) {
    return vi.fn(async (_projectId: string, request: FigmaByNameRequest) => answer(request))
  }

  it("sends more than 100 distinct texts in E11 requests of at most 100 texts", async () => {
    // "Select all shown" + "Link…" hands every checked layer to the dialog; E11 rejects a request above 100 texts.
    const nodes = Array.from({ length: 250 }, (_, i) => scannedNode("1:" + i, "Text " + i)).concat([scannedNode("2:1", " Text 7 "), scannedNode("2:2", "  ")])
    const keysByName = byName((request) => ({
      keys: [],
      missing: [],
      text_matches: (request.texts ?? [])
        .filter((text) => text === "Text 7" || text === "Text 180" || text === "Text 240")
        .map((text) => ({ text, keys: text === "Text 240" ? [{ id: keyId(2), key: "two" }, { id: keyId(3), key: "three" }] : [{ id: keyId(2), key: "two" }] })),
    }))
    const candidates = await fetchExactCandidates({ keysByName }, PROJECT_ID, nodes)
    const sent = keysByName.mock.calls.map(([, request]) => request.texts ?? [])
    expect(sent.length).toBe(3)
    expect(sent.every((texts) => texts.length > 0 && texts.length <= MAX_BATCH_SIZE)).toBe(true)
    expect(sent.flat().sort()).toEqual(Array.from({ length: 250 }, (_, i) => "Text " + i).sort())
    expect(keysByName.mock.calls.every(([projectId, request]) => projectId === PROJECT_ID && request.names === undefined)).toBe(true)
    // Each key once, in the order of the layers' texts, with the matched text as its main text.
    expect(candidates).toEqual([
      { id: keyId(2), key: "two", main_content: { value: "Text 7" } },
      { id: keyId(3), key: "three", main_content: { value: "Text 240" } },
    ])
  })

  it("sends nothing when no layer has a text to look up", async () => {
    const keysByName = byName(() => ({ keys: [], missing: [], text_matches: [] }))
    expect(await fetchExactCandidates({ keysByName }, PROJECT_ID, [scannedNode("1", "  "), scannedNode("2", "z".repeat(5001))])).toEqual([])
    expect(keysByName).not.toHaveBeenCalled()
  })
})
