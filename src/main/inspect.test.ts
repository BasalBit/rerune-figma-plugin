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

function linked(id: string, n: number): FakeNode {
  const node = fakeText(id, "Text " + n)
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink({ v: 1, id: keyId(n), k: "key_" + n, p: PROJECT_ID, src: src("Text " + n), nid: id, t: 1 }))
  return node
}

describe("inspectSelection (§7.17)", () => {
  it("returns none without a selection", async () => {
    expect(await inspectSelection()).toEqual({ type: "inspect-selection", kind: "none", nodes: [] })
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
    const many = fakeFrame("3:0", "Many", Array.from({ length: 70 }, (_, i) => linked("3:" + (i + 1), 100 + i)))
    onPage(figmaMock, [many], [many])
    expect((await inspectSelection())?.nodes).toHaveLength(50)
  })

  it("returns none for a selected node without children", async () => {
    const vector = { id: "1:9", type: "VECTOR", name: "Shape", removed: false, parent: null } as unknown as FakeNode
    figmaMock.currentPage.selection = [vector]
    expect(await inspectSelection()).toEqual({ type: "inspect-selection", kind: "none", nodes: [] })
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
