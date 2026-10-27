import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeComponent, fakeFrame, fakeInstance, fakeText, followText, installFigma, onPage, uninstallFigma, type FakeNode, type FigmaMock } from "../../test/figma-mock"
import { keyId, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, LINK_TOMBSTONE, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { LinkApplyItem, NodeLink } from "../shared/messages"
import { parseLink, serializeLink } from "../shared/plugin-data"
import { applyLinks, readLinkInfo, removeLink, removeLinks, resolveMainTextNode, writeLink } from "./links"
import { clearFontCache } from "./fonts"
import { createNodeCaches } from "./node-utils"
import { applyPreview, resetPreview } from "./text-write"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const K1 = keyId(1)
const K2 = keyId(2)

function link(nid: string, id = K1, k = "checkout_pay_button", text = "Pay now"): NodeLink {
  return { v: 1, id, k, p: PROJECT_ID, src: src(text), nid, t: 1 }
}

function setLink(node: FakeNode, value: NodeLink | string): void {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, typeof value === "string" ? value : serializeLink(value))
}

function linkOf(node: FakeNode): NodeLink | null {
  const parsed = parseLink(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link))
  return parsed.kind === "link" ? parsed.link : null
}

function item(nodeId: string, overrides: Partial<LinkApplyItem> = {}): LinkApplyItem {
  return { nodeId, keyId: K1, keyName: "checkout_pay_button", projectId: PROJECT_ID, src: src("Pay now"), ...overrides }
}

// A local main component with a linked text layer and an instance that inherits the link (data shows through).
function componentWithInstance(options: { overrides?: { id: string; overriddenFields: string[] }[] } = {}) {
  const mainText = fakeText("5:67", "Pay now")
  setLink(mainText, link("5:67"))
  const component = fakeComponent("5:1", "Button", [mainText])
  const sublayer = fakeText("I12:34;5:67", "Pay now")
  sublayer.inheritFrom = mainText
  const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: options.overrides ?? [], mainComponent: component })
  onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [instance])])
  return { mainText, component, sublayer, instance }
}

describe("readLinkInfo", () => {
  it("classifies own, copied, inherited, overridden and invalid links", () => {
    const { sublayer } = componentWithInstance()
    const own = fakeText("1:1", "x")
    setLink(own, link("1:1"))
    const copied = fakeText("1:2", "x")
    setLink(copied, link("1:1"))
    const invalid = fakeText("1:3", "x")
    setLink(invalid, "{oops")
    const none = fakeText("1:4", "x")
    const caches = createNodeCaches()
    expect(readLinkInfo(own as unknown as BaseNode, caches)).toMatchObject({ state: "ok", link: link("1:1") })
    expect(readLinkInfo(copied as unknown as BaseNode, caches).state).toBe("copied")
    expect(readLinkInfo(sublayer as unknown as BaseNode, caches)).toMatchObject({ state: "inherited", ownPluginDataOverride: false })
    expect(readLinkInfo(invalid as unknown as BaseNode, caches)).toMatchObject({ state: "invalid", link: null })
    expect(readLinkInfo(none as unknown as BaseNode, caches)).toMatchObject({ state: "none", link: null })
  })

  it("reports inherited_overridden when the instance overrides the text", () => {
    const { sublayer } = componentWithInstance({ overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }] })
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches())).toMatchObject({ state: "inherited_overridden", textOverridden: true })
  })

  it("classifies a previewed instance sublayer with the override state stored before the preview", async () => {
    clearFontCache()
    const { mainText, sublayer, instance } = componentWithInstance()
    followText(sublayer, mainText, instance)
    await applyPreview({ lang: "de", source: "draft", variationOptionId: null }, [{ nodeId: "I12:34;5:67", text: "Jetzt zahlen" }], 1)
    // The preview write is a characters override; Figma may also list the record as a pluginData override.
    expect(instance.overrides).toEqual([{ id: "I12:34;5:67", overriddenFields: ["characters"] }])
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches())).toMatchObject({ state: "inherited", textOverridden: false })
    instance.overrides[0].overriddenFields.push("pluginData")
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches())).toMatchObject({ state: "inherited", textOverridden: false })
    instance.overrides[0].overriddenFields.pop()

    // Re-preview in another language reaches it and keeps the first original.
    await applyPreview({ lang: "fr", source: "draft", variationOptionId: null }, [{ nodeId: "I12:34;5:67", text: "Payer" }], 2)
    expect(sublayer.characters).toBe("Payer")
    await resetPreview("page", undefined, undefined)
    expect(sublayer.characters).toBe("Pay now")
    // After the reset the live override state applies again (Figma keeps the characters override, override_kept).
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches()).state).toBe("inherited_overridden")
  })

  it("keeps an instance sublayer whose text was overridden before the preview inherited_overridden", async () => {
    clearFontCache()
    const { sublayer } = componentWithInstance({ overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }] })
    await applyPreview({ lang: "de", source: "draft", variationOptionId: null }, [{ nodeId: "I12:34;5:67", text: "Jetzt zahlen" }], 1)
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches()).state).toBe("inherited_overridden")
  })
})

describe("writeLink / removeLink (§7.6)", () => {
  it("writes the link and the relaunch button", () => {
    const node = fakeText("1:1", "Pay now")
    writeLink(node as unknown as BaseNode, link("1:1"))
    expect(linkOf(node)).toEqual(link("1:1"))
    expect(node.setRelaunchData).toHaveBeenCalledWith({ open: "ReRune key: checkout_pay_button" })
  })

  it("keeps the link when the node refuses relaunch data", () => {
    const node = fakeText("1:1", "Pay now")
    node.setRelaunchData.mockImplementation(() => {
      throw new Error("not allowed")
    })
    writeLink(node as unknown as BaseNode, link("1:1"))
    expect(linkOf(node)).toEqual(link("1:1"))
  })

  it("unlinks with an empty string and clears the relaunch data", () => {
    const node = fakeText("1:1", "Pay now")
    setLink(node, link("1:1"))
    expect(removeLink(node as unknown as BaseNode)).toBe("cleared")
    expect(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)).toBe("")
    expect(node.setRelaunchData).toHaveBeenLastCalledWith({})
  })

  it("writes the tombstone when inherited data still shows through", () => {
    const { sublayer, mainText } = componentWithInstance()
    expect(removeLink(sublayer as unknown as BaseNode)).toBe("tombstone")
    expect(sublayer.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)).toBe(LINK_TOMBSTONE)
    expect(readLinkInfo(sublayer as unknown as BaseNode, createNodeCaches()).state).toBe("none")
    expect(linkOf(mainText)).toEqual(link("5:67"))
  })
})

describe("resolveMainTextNode", () => {
  it("returns the local main component's text node that owns the link", async () => {
    const { mainText, sublayer } = componentWithInstance()
    const inherited = linkOf(sublayer) as NodeLink
    expect(await resolveMainTextNode(inherited)).toBe(mainText)
  })

  it("refuses library mains and unrelated local nodes with a colliding id", async () => {
    const libraryLink = link("3:9")
    expect(await resolveMainTextNode(libraryLink)).toBeNull()
    const unrelated = fakeText("3:9", "Unrelated")
    onPage(figmaMock, [fakeComponent("3:1", "Other", [unrelated])])
    expect(await resolveMainTextNode(libraryLink)).toBeNull()
    setLink(unrelated, link("3:9", K2))
    expect(await resolveMainTextNode(libraryLink)).toBeNull()
  })

  it("refuses a text node outside a component or inside a remote component", async () => {
    const loose = fakeText("7:1", "x")
    setLink(loose, link("7:1"))
    const remoteText = fakeText("8:2", "x")
    setLink(remoteText, link("8:2"))
    onPage(figmaMock, [loose, fakeComponent("8:1", "Library", [remoteText], { remote: true })])
    expect(await resolveMainTextNode(link("7:1"))).toBeNull()
    expect(await resolveMainTextNode(link("8:2"))).toBeNull()
  })
})

describe("applyLinks (link-apply)", () => {
  it("writes links with nid = node id and t = now", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    const outcome = await applyLinks([item("1:1")], 777)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(linkOf(node)).toEqual({ ...link("1:1"), t: 777 })
  })

  it("rewrites nid for a copied link (Keep)", async () => {
    const node = fakeText("1:2", "Pay now")
    setLink(node, link("1:1"))
    onPage(figmaMock, [node])
    await applyLinks([item("1:2")], 5)
    expect(linkOf(node)?.nid).toBe("1:2")
  })

  it("reports missing nodes and invalid ids per item and continues", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    const outcome = await applyLinks([item("9:9"), item("1:1", { keyId: "nope" }), item("1:1")], 1)
    expect(outcome.done).toBe(1)
    expect(outcome.errors.map((error) => [error.nodeId, error.code])).toEqual([
      ["9:9", "node_not_found"],
      ["1:1", "write_failed"],
    ])
  })

  it("redirects a same-key refresh on an inherited sublayer to the local main component (D44)", async () => {
    const { mainText, sublayer } = componentWithInstance()
    const outcome = await applyLinks([item("I12:34;5:67", { src: src("Pay securely"), keyName: "checkout_pay" })], 9)
    expect(outcome).toEqual({ done: 1, errors: [] })
    expect(sublayer.getSharedPluginDataKeys(PLUGIN_DATA_NAMESPACE)).toEqual([])
    expect(linkOf(mainText)).toEqual({ ...link("5:67"), k: "checkout_pay", src: src("Pay securely"), t: 9 })
  })

  it("reports remote_component for an inherited link from a library main and writes nothing", async () => {
    const sublayer = fakeText("I12:34;77:1", "Pay now")
    setLink(sublayer, link("3:9"))
    const unrelated = fakeText("3:9", "Unrelated")
    onPage(figmaMock, [fakeInstance("12:34", "Button", [sublayer], { overrides: [] }), fakeComponent("3:1", "Local", [unrelated])])
    const outcome = await applyLinks([item("I12:34;77:1")], 1)
    expect(outcome.errors).toEqual([{ nodeId: "I12:34;77:1", code: "remote_component", message: "Update this text in the library file." }])
    expect(unrelated.getSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link)).toBe("")
  })

  it("writes an explicit link to another key on the instance sublayer itself", async () => {
    const { mainText, sublayer } = componentWithInstance()
    await applyLinks([item("I12:34;5:67", { keyId: K2, keyName: "other" })], 3)
    expect(linkOf(sublayer)).toMatchObject({ id: K2, nid: "I12:34;5:67" })
    expect(linkOf(mainText)?.id).toBe(K1)
  })

  it("writes a redirected main component once for several sublayers", async () => {
    const { mainText } = componentWithInstance()
    const second = fakeText("I13:1;5:67", "Pay now")
    second.inheritFrom = mainText
    onPage(figmaMock, [fakeInstance("13:1", "Button", [second], { overrides: [] })])
    const writes: string[] = []
    const original = mainText.setSharedPluginData
    mainText.setSharedPluginData = (namespace: string, key: string, value: string) => {
      writes.push(key)
      original(namespace, key, value)
    }
    const outcome = await applyLinks([item("I12:34;5:67"), item("I13:1;5:67")], 1)
    expect(outcome).toEqual({ done: 2, errors: [] })
    expect(writes).toEqual([DATA_KEYS.link])
  })

  it("refuses writes inside library components", async () => {
    const remote = fakeText("8:2", "x")
    onPage(figmaMock, [fakeComponent("8:1", "Library", [remote], { remote: true })])
    expect((await applyLinks([item("8:2")], 1)).errors[0].code).toBe("remote_component")
  })

  it("reports write_failed when Figma refuses the write", async () => {
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node])
    figmaMock.pluginDataWriteError = "read-only"
    expect((await applyLinks([item("1:1")], 1)).errors[0].code).toBe("write_failed")
  })
})

describe("removeLinks (link-remove)", () => {
  it("unlinks each node and reports missing ones", async () => {
    const a = fakeText("1:1", "A")
    const b = fakeText("1:2", "B")
    setLink(a, link("1:1"))
    setLink(b, link("1:2"))
    onPage(figmaMock, [a, b])
    const outcome = await removeLinks(["1:1", "9:9", "1:2"])
    expect(outcome.done).toBe(2)
    expect(outcome.errors.map((error) => error.code)).toEqual(["node_not_found"])
    expect(linkOf(a)).toBeNull()
    expect(linkOf(b)).toBeNull()
  })

  it("yields between batches and handles more than ten nodes", async () => {
    const nodes = Array.from({ length: 23 }, (_, i) => {
      const node = fakeText("2:" + i, "x")
      setLink(node, link("2:" + i))
      return node
    })
    onPage(figmaMock, nodes)
    expect((await removeLinks(nodes.map((node) => node.id))).done).toBe(23)
  })
})
