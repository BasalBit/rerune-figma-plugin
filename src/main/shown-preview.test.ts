import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeComponent, fakeInstance, fakeText, followText, installFigma, onPage, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import { serializePreviewRecord, type PreviewRecord } from "../shared/plugin-data"
import { createNodeCaches } from "./node-utils"
import { backingNodeId, shownPreview } from "./shown-preview"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

function record(nid: string, characters = "Pay now"): PreviewRecord {
  return {
    v: 1, nid, previewSrc: src("Jetzt zahlen"), characters, autoRename: true, textOverridden: false, segments: null, richLost: false,
    lang: "de", source: "draft", variationOptionId: null, appliedAt: 1,
  }
}

function asText(node: unknown): TextNode {
  return node as TextNode
}

describe("backingNodeId", () => {
  it("names the node an instance sublayer takes its text from", () => {
    expect(backingNodeId("I12:34;5:67")).toBe("5:67")
    expect(backingNodeId("I1:2;3:4;5:6")).toBe("I3:4;5:6")
    expect(backingNodeId("5:67")).toBeNull()
    expect(backingNodeId("I12:34")).toBeNull()
    expect(backingNodeId("I12:34;")).toBeNull()
  })
})

describe("shownPreview", () => {
  it("returns the node's own record first", async () => {
    const node = fakeText("1:1", "Jetzt zahlen")
    node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(record("1:1")))
    onPage(figmaMock, [node])
    expect(await shownPreview(asText(node), createNodeCaches())).toMatchObject({ record: { nid: "1:1" }, owner: node })
  })

  it("follows a nested instance chain to the record, and stops at a text override", async () => {
    const mainText = fakeText("5:6", "Pay now")
    mainText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(record("5:6")))
    const nested = fakeText("I3:4;5:6", "Pay now")
    const nestedInstance = fakeInstance("3:4", "Button", [nested], { overrides: [] })
    followText(nested, mainText, nestedInstance)
    const outer = fakeText("I1:2;3:4;5:6", "Pay now")
    const outerInstance = fakeInstance("1:2", "Card", [outer], { overrides: [] })
    followText(outer, nested, outerInstance)
    onPage(figmaMock, [fakeComponent("5:1", "Button", [mainText]), fakeComponent("3:1", "Card", [nestedInstance]), outerInstance])
    expect(await shownPreview(asText(outer), createNodeCaches())).toMatchObject({ record: { nid: "5:6" }, owner: mainText })

    nestedInstance.overrides.push({ id: "I3:4;5:6", overriddenFields: ["characters"] })
    expect(await shownPreview(asText(outer), createNodeCaches())).toBeNull()
  })

  it("ignores a copied record on a node that is not an instance sublayer", async () => {
    const copy = fakeText("1:2", "Jetzt zahlen")
    copy.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(record("1:1")))
    onPage(figmaMock, [copy])
    expect(await shownPreview(asText(copy), createNodeCaches())).toBeNull()
  })

  it("falls back to a record inherited through plugin data when the chain cannot be followed", async () => {
    const mainText = fakeText("5:67", "Jetzt zahlen")
    mainText.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.preview, serializePreviewRecord(record("5:67")))
    const sublayer = fakeText("I12:34;5:67", "Jetzt zahlen")
    sublayer.inheritFrom = mainText
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: [] })])
    mainText.remove()
    expect(await shownPreview(asText(sublayer), createNodeCaches())).toMatchObject({ record: { nid: "5:67" }, owner: null })
  })
})
