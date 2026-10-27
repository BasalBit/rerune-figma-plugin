import { describe, expect, it } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import { src } from "../../shared/hash"
import type { RemoteWithMaxLength } from "../../shared/push-plan"
import {
  filterCounts,
  groupByFrame,
  keepCopiedItems,
  layerRows,
  linkedCount,
  matchesFilter,
  planExactMatches,
  searchRows,
  skippedSummary,
  unlinkableIds,
  unlinkedTexts,
} from "./layers"

function remote(key: string, mainText: string, maxLength: number | null = null): RemoteWithMaxLength {
  return { found: true, key, type: "key", enabled: true, structured: false, mainText, maxLength }
}

describe("layerRows", () => {
  const remoteMap = new Map([
    [keyId(1), remote("checkout_pay_button", "Pay now", 5)],
    [keyId(2), remote("checkout_title_renamed", "Checkout")],
  ])
  const nodes = [
    linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "old_name", syncedText: "Pay now" }, { hasMissingFont: true }),
    linkedNode("1:2", "Check out", { keyId: keyId(2), keyName: "checkout_title", syncedText: "Checkout" }, { frameId: "20:1", frameName: "Cart" }),
    scannedNode("1:3", "Unlinked", { boundToVariable: true }),
    linkedNode("1:4", "Other", { keyId: keyId(3), keyName: "x", syncedText: "Other", projectId: OTHER_PROJECT_ID }),
    linkedNode("1:5", "Pay now", { keyId: keyId(1), keyName: "old_name", syncedText: "Pay now", nid: "9:9", state: "copied" }),
    linkedNode("1:6", "Gone", { keyId: keyId(9), keyName: "gone", syncedText: "Gone" }),
  ]
  const rows = layerRows(nodes, PROJECT_ID, new Map([...remoteMap, [keyId(9), { ...remote("", ""), found: false, key: null }]]), new Map([["1:3", "checkout_new"]]))

  it("computes sync state, key names from E12 and badges", () => {
    expect(rows.map((row) => row.state)).toEqual(["synced", "changed_in_figma", "unlinked", "other_project", "copied", "key_missing"])
    expect(rows[0].keyName).toBe("checkout_pay_button")
    expect(rows[1].keyName).toBe("checkout_title_renamed")
    expect(rows[2].keyName).toBeNull()
    expect(rows[5].keyName).toBe("gone")
    expect(rows[0].badges).toEqual(["missing_font"])
    expect(rows[2].badges).toEqual(["variable", "pending"])
    expect(rows[2].pendingName).toBe("checkout_new")
    expect(rows[0].maxLength).toBe(5)
    expect(rows[0].overMaxLength).toBe(true)
  })

  it("groups by frame in scan order", () => {
    const groups = groupByFrame(rows)
    expect(groups.map((group) => [group.title, group.rows.length])).toEqual([["Checkout", 5], ["Cart", 1]])
    const noFrame = groupByFrame(layerRows([scannedNode("2:1", "x", { frameId: null, frameName: null })], PROJECT_ID, new Map()))
    expect(noFrame[0].title).toBe("Mobile (no frame)")
  })

  it("filters and counts by state group", () => {
    expect(filterCounts(rows)).toEqual({ all: 6, unlinked: 1, synced: 1, changed: 1, attention: 3, readonly: 0 })
    expect(rows.filter((row) => matchesFilter(row, "changed")).map((row) => row.node.nodeId)).toEqual(["1:2"])
    expect(linkedCount(rows)).toBe(5)
  })

  it("searches text, layer name and key name", () => {
    expect(searchRows(rows, "renamed").map((row) => row.node.nodeId)).toEqual(["1:2"])
    expect(searchRows(rows, "  ").length).toBe(6)
    expect(searchRows(rows, "UNLINKED").map((row) => row.node.nodeId)).toEqual(["1:3"])
  })

  it("builds Keep copied links and Unlink targets", () => {
    expect(keepCopiedItems(rows, PROJECT_ID)).toEqual([{ nodeId: "1:5", keyId: keyId(1), keyName: "checkout_pay_button", projectId: PROJECT_ID, src: src("Pay now") }])
    expect(unlinkableIds(rows)).toEqual(["1:1", "1:2", "1:4", "1:5", "1:6"])
    const overridden = layerRows([linkedNode("I2:1;1:7", "Own text", { keyId: keyId(1), keyName: "x", syncedText: "Pay now", nid: "1:7", state: "inherited_overridden" })], PROJECT_ID, remoteMap)
    expect(overridden[0].state).toBe("unlinked")
    expect(unlinkableIds(overridden)).toEqual([])
  })
})

describe("Link exact matches", () => {
  const rows = layerRows(
    [
      scannedNode("1:1", "Pay now"),
      scannedNode("1:2", " Pay now\r\n"),
      scannedNode("1:3", "Title"),
      scannedNode("1:4", "Nothing"),
      linkedNode("1:5", "Pay now", { keyId: keyId(1), keyName: "a", syncedText: "Pay now" }),
      scannedNode("1:6", "x".repeat(5001)),
    ],
    PROJECT_ID,
    new Map([[keyId(1), remote("a", "Pay now")]]),
  )

  it("queries unique normalised unlinked texts up to 5000 units", () => {
    expect(unlinkedTexts(rows)).toEqual(["Pay now", "Title", "Nothing"])
  })

  it("links layers with exactly one match and lists the rest", () => {
    const plan = planExactMatches(
      rows,
      new Map([
        ["Pay now", [{ id: keyId(1), key: "a" }]],
        ["Title", [{ id: keyId(2), key: "b" }, { id: keyId(3), key: "c" }]],
      ]),
      PROJECT_ID,
    )
    expect(plan.links).toEqual([
      { nodeId: "1:1", keyId: keyId(1), keyName: "a", projectId: PROJECT_ID, src: src("Pay now") },
      { nodeId: "1:2", keyId: keyId(1), keyName: "a", projectId: PROJECT_ID, src: src("Pay now") },
    ])
    expect(plan.ambiguous).toEqual([{ text: "Title", nodeIds: ["1:3"], keys: [{ id: keyId(2), key: "b" }, { id: keyId(3), key: "c" }] }])
    expect(plan.unmatched.map((entry) => entry.nodeIds)).toEqual([["1:4"], ["1:6"]])
    expect(plan.skipped).toBe(1)
  })
})

describe("skippedSummary", () => {
  it("lists non-zero skip reasons", () => {
    const none = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
    expect(skippedSummary(none)).toBeNull()
    expect(skippedSummary({ ...none, hidden: 3, numeric: 1, unavailable: 2 })).toBe("Skipped 3 hidden, 1 numbers only, 2 unavailable")
  })
})
