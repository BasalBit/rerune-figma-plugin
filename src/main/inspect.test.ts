import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeFrame, fakeText, installFigma, onPage, uninstallFigma, type FakeNode, type FigmaMock } from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi } from "../shared/messages"
import { serializeLink } from "../shared/plugin-data"
import { inspectSelection, watchInspectSelection } from "./inspect"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma({ editorType: "dev", mode: "inspect" })
})

afterEach(() => {
  uninstallFigma()
})

function linked(id: string, n: number, key = n): FakeNode {
  const node = fakeText(id, "Text " + n)
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink({ v: 1, id: keyId(key), k: "key_" + key, p: PROJECT_ID, src: src("Text " + n), nid: id, t: 1 }))
  return node
}

describe("inspectSelection (§7.17)", () => {
  it("returns none without a selection", async () => {
    expect(await inspectSelection()).toEqual({ type: "inspect-selection", kind: "none", nodes: [], truncated: false })
  })

  it("returns the selected text layer, linked or not", async () => {
    const plain = fakeText("1:1", "Plain")
    onPage(figmaMock, [plain], [plain])
    const result = await inspectSelection()
    expect(result?.kind).toBe("text")
    expect(result?.nodes.map((node) => [node.nodeId, node.linkState])).toEqual([["1:1", "none"]])
  })

  it("returns up to 50 linked text layers under a container", async () => {
    const children = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? linked("2:" + i, i) : fakeText("2:" + i, "Unlinked " + i)))
    const frame = fakeFrame("1:0", "Checkout", [fakeFrame("1:1", "Nested", children.slice(0, 10)), ...children.slice(10)])
    onPage(figmaMock, [frame], [frame])
    const result = await inspectSelection()
    expect(result?.kind).toBe("container")
    expect(result?.nodes).toHaveLength(30)
    expect(result?.nodes.every((node) => node.link !== null)).toBe(true)
    expect(result?.truncated).toBe(false)
    const many = fakeFrame("3:0", "Many", Array.from({ length: 70 }, (_, i) => linked("3:" + (i + 1), 100 + i)))
    onPage(figmaMock, [many], [many])
    const capped = await inspectSelection()
    expect(capped?.nodes.map((node) => node.nodeId)).toEqual(Array.from({ length: 50 }, (_, i) => "3:" + (i + 1)))
    expect(capped?.truncated).toBe(true)
  })

  it("lists every key of a repetitive frame first and says when layers are left out", async () => {
    // A list of 30 rows of one component (2 linked texts each, keys 1 and 2), then a header (key 3) and a CTA (key 4).
    const rows = Array.from({ length: 30 }, (_, row) => fakeFrame("4:" + row, "Row", [linked("5:" + row, row, 1), linked("6:" + row, row, 2)]))
    const frame = fakeFrame("1:0", "Screen", [...rows, linked("7:1", 1, 3), linked("7:2", 2, 4)])
    onPage(figmaMock, [frame], [frame])
    const result = await inspectSelection()
    expect(result?.nodes).toHaveLength(50)
    expect([...new Set(result?.nodes.map((node) => node.link?.id))]).toEqual([keyId(1), keyId(2), keyId(3), keyId(4)])
    // Layer order is kept: the first 24 rows (48 layers), then the header and the CTA.
    expect(result?.nodes.slice(-3).map((node) => node.nodeId)).toEqual(["6:23", "7:1", "7:2"])
    expect(result?.truncated).toBe(true)

    // The same frame with 24 rows fits (48 + 2 layers): everything is listed.
    const small = fakeFrame("1:1", "Screen", [...rows.slice(0, 24), linked("8:1", 1, 3), linked("8:2", 2, 4)])
    onPage(figmaMock, [small], [small])
    const all = await inspectSelection()
    expect(all?.nodes).toHaveLength(50)
    expect(all?.truncated).toBe(false)
  })

  it("returns none for a selected node without children", async () => {
    const vector = { id: "1:9", type: "VECTOR", name: "Shape", removed: false, parent: null } as unknown as FakeNode
    figmaMock.currentPage.selection = [vector]
    expect(await inspectSelection()).toEqual({ type: "inspect-selection", kind: "none", nodes: [], truncated: false })
  })
})

describe("watchInspectSelection", () => {
  it("sends inspect-selection on selection and page changes, and on refresh", async () => {
    const sent: MainToUi[] = []
    const watcher = watchInspectSelection((message) => sent.push(message))
    const node = linked("1:1", 1)
    onPage(figmaMock, [node], [node])
    figmaMock.emit("selectionchange")
    await new Promise((resolve) => setTimeout(resolve, 0))
    figmaMock.emit("currentpagechange")
    await watcher.refresh()
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.every((message) => message.type === "inspect-selection")).toBe(true)
  })

  it("drops a result superseded by a newer selection", async () => {
    const sent: MainToUi[] = []
    const watcher = watchInspectSelection((message) => sent.push(message))
    const frame = fakeFrame("1:0", "Checkout", Array.from({ length: 30 }, (_, i) => linked("2:" + i, i)))
    onPage(figmaMock, [frame], [frame])
    const first = watcher.refresh()
    const plain = fakeText("9:1", "Plain")
    figmaMock.currentPage.selection = [plain]
    const second = watcher.refresh()
    await Promise.all([first, second])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: "text" })
  })
})
