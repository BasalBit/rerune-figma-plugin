import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeComponent, fakeFrame, fakeInstance, fakePage, fakeSection, fakeText, installFigma, onPage, uninstallFigma, type FakeNode, type FigmaMock } from "../../test/figma-mock"
import { keyId, OTHER_PROJECT_ID, PROJECT_ID } from "../../test/fixtures"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { src } from "../shared/hash"
import type { MainToUi, NodeLink } from "../shared/messages"
import { serializeLink } from "../shared/plugin-data"
import { createMainBus } from "./bus"
import { registerHandlers, type MainContext } from "./handlers"
import { checkLinks, nodeIdsOf } from "./link-check"

let figmaMock: FigmaMock

beforeEach(() => {
  figmaMock = installFigma()
})

afterEach(() => {
  uninstallFigma()
})

const K1 = keyId(1)
const K2 = keyId(2)

function link(nid: string, id = K1, projectId = PROJECT_ID): NodeLink {
  return { v: 1, id, k: "checkout_pay_button", p: projectId, src: src("Pay now"), nid, t: 1 }
}

function setLink(node: FakeNode, value: NodeLink): void {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, DATA_KEYS.link, serializeLink(value))
}

function context(editorType: "figma" | "dev"): MainContext {
  return {
    editorType,
    env: "development",
    apiBase: "http://localhost:8080",
    dashboardBase: "http://localhost:3000",
    pluginVersion: "0.1.0",
    startup: { skipInvisibleInstanceChildren: false, command: "" },
    inspect: null,
  }
}

describe("checkLinks (link sync, D43)", () => {
  it("reports the link state and the layer's page, frame and name", async () => {
    const own = fakeText("12:345", "Pay now")
    own.name = "Pay button"
    setLink(own, link("12:345"))
    const other = fakeText("12:346", "Cancel")
    setLink(other, link("12:346", K2))
    const foreign = fakeText("12:347", "Back")
    setLink(foreign, link("12:347", K1, OTHER_PROJECT_ID))
    const plain = fakeText("12:348", "Help")
    onPage(figmaMock, [fakeSection("9:1", "Flows", [fakeFrame("10:1", "Checkout", [own, other, foreign, plain])])])
    figmaMock.currentPage.name = "Mobile"

    const checks = await checkLinks(["12:345", "12:346", "12:347", "12:348"])
    expect(checks[0]).toEqual({
      nodeId: "12:345",
      status: "found",
      linkState: "ok",
      link: link("12:345"),
      name: "Pay button",
      pageId: "0:1",
      pageName: "Mobile",
      frameId: "10:1",
      frameName: "Checkout",
    })
    expect(checks[1]).toMatchObject({ status: "found", linkState: "ok", link: { id: K2 } })
    expect(checks[2]).toMatchObject({ status: "found", linkState: "ok", link: { p: OTHER_PROJECT_ID } })
    expect(checks[3]).toMatchObject({ status: "found", linkState: "none", link: null, frameId: "10:1" })
  })

  it("reports deleted and unknown nodes as not found, never as unlinked", async () => {
    const gone = fakeText("12:345", "Pay now")
    setLink(gone, link("12:345"))
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [gone])])
    gone.remove()
    const checks = await checkLinks(["12:345", "99:1"])
    expect(checks).toEqual([
      { nodeId: "12:345", status: "not_found", linkState: "none", link: null, name: "", pageId: "", pageName: "", frameId: null, frameName: null },
      { nodeId: "99:1", status: "not_found", linkState: "none", link: null, name: "", pageId: "", pageName: "", frameId: null, frameName: null },
    ])
  })

  it("finds hidden instance children with skipInvisibleInstanceChildren off and restores the flag", async () => {
    const mainText = fakeText("5:67", "Pay now")
    setLink(mainText, link("5:67"))
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.inheritFrom = mainText
    sublayer.visible = false
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [], mainComponent: component })
    onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [instance])])
    figmaMock.skipInvisibleInstanceChildren = true
    expect(await figmaMock.getNodeByIdAsync("I12:34;5:67")).toBeNull()

    const checks = await checkLinks(["I12:34;5:67"])
    expect(checks[0]).toMatchObject({ status: "found", linkState: "inherited", link: { id: K1, nid: "5:67" }, frameId: "10:1" })
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })

  it("classifies an instance whose text is overridden as inherited_overridden", async () => {
    const mainText = fakeText("5:67", "Pay now")
    setLink(mainText, link("5:67"))
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Buy")
    sublayer.inheritFrom = mainText
    const instance = fakeInstance("12:34", "Button", [sublayer], { overrides: [{ id: "I12:34;5:67", overriddenFields: ["characters"] }], mainComponent: component })
    onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [instance])])
    expect((await checkLinks(["I12:34;5:67"]))[0]).toMatchObject({ status: "found", linkState: "inherited_overridden" })
  })

  it("reports a node of another type as found without a link", async () => {
    onPage(figmaMock, [fakeFrame("10:1", "Checkout")])
    expect((await checkLinks(["10:1"]))[0]).toMatchObject({ status: "found", linkState: "none", link: null, name: "Checkout", frameId: null })
  })

  it("finds nodes on other pages and reports unreadable lookups", async () => {
    const away = fakeText("20:1", "Settings")
    setLink(away, link("20:1"))
    const page = fakePage("0:2", "Desktop", [fakeFrame("19:1", "Account", [away])])
    figmaMock.root.appendChild(page)
    const lookup = figmaMock.getNodeByIdAsync.getMockImplementation()
    figmaMock.getNodeByIdAsync.mockImplementation(async (id: string) => {
      if (id === "66:6") {
        throw new Error("boom")
      }
      return lookup?.(id)
    })
    const checks = await checkLinks(["20:1", "66:6"])
    expect(checks[0]).toMatchObject({ status: "found", linkState: "ok", pageId: "0:2", pageName: "Desktop", frameId: "19:1", frameName: "Account" })
    expect(checks[1]).toMatchObject({ status: "unreadable", linkState: "none", link: null })
  })

  it("restores the flag when the lookup fails", async () => {
    figmaMock.skipInvisibleInstanceChildren = true
    figmaMock.getNodeByIdAsync.mockRejectedValue(new Error("boom"))
    expect((await checkLinks(["1:1"]))[0].status).toBe("unreadable")
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
  })

  it("adds the current page's instance sublayers of a checked component text on request (§7.11, §7.15)", async () => {
    const mainText = fakeText("5:67", "Pay now")
    setLink(mainText, link("5:67"))
    const component = fakeComponent("5:1", "Button", [mainText])
    const plain = fakeInstance("12:34", "Button", [Object.assign(fakeText("I12:34;5:67", "Pay now"), { inheritFrom: mainText })], { overrides: [], mainComponent: component })
    const hidden = fakeText("I12:35;5:67", "Pay now")
    hidden.inheritFrom = mainText
    hidden.visible = false
    const hiddenInstance = fakeInstance("12:35", "Button", [hidden], { overrides: [], mainComponent: component })
    // A Button instance nested in a Card instance.
    const nested = fakeText("I12:40;3:2;5:67", "Pay now")
    nested.inheritFrom = mainText
    const card = fakeInstance("12:40", "Card", [fakeInstance("I12:40;3:2", "Button", [nested], { overrides: [], mainComponent: component })], { overrides: [] })
    const overridden = fakeText("I12:50;5:67", "Buy")
    overridden.inheritFrom = mainText
    const overriddenInstance = fakeInstance("12:50", "Button", [overridden], { overrides: [{ id: "I12:50;5:67", overriddenFields: ["characters"] }], mainComponent: component })
    const other = fakeText("I12:60;9:99", "Other")
    onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [plain, hiddenInstance, card, overriddenInstance, fakeInstance("12:60", "Badge", [other])])])
    const elsewhere = fakeText("I30:1;5:67", "Pay now")
    elsewhere.inheritFrom = mainText
    figmaMock.root.appendChild(fakePage("0:2", "Desktop", [fakeInstance("30:1", "Button", [elsewhere], { overrides: [], mainComponent: component })]))
    figmaMock.skipInvisibleInstanceChildren = true

    const checks = await checkLinks(["5:67"], true)
    expect(checks.map((entry) => [entry.nodeId, entry.linkState])).toEqual([
      ["5:67", "ok"],
      ["I12:34;5:67", "inherited"],
      ["I12:35;5:67", "inherited"],
      ["I12:40;3:2;5:67", "inherited"],
      ["I12:50;5:67", "inherited_overridden"],
    ])
    expect(checks.every((entry) => entry.status === "found" && entry.frameId !== null)).toBe(true)
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
    // Without the flag (page link sync) only the requested layers are answered.
    expect((await checkLinks(["5:67"])).map((entry) => entry.nodeId)).toEqual(["5:67"])
    // An instance sublayer already requested is answered once.
    expect((await checkLinks(["5:67", "I12:34;5:67"], true)).map((entry) => entry.nodeId)).toEqual(["5:67", "I12:34;5:67", "I12:35;5:67", "I12:40;3:2;5:67", "I12:50;5:67"])
  })

  it("does not walk the page for text outside a component", async () => {
    const own = fakeText("12:345", "Pay now")
    setLink(own, link("12:345"))
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [own])])
    const walk = vi.spyOn(figmaMock.currentPage, "findAllWithCriteria")
    expect((await checkLinks(["12:345", "99:1"], true)).map((entry) => entry.nodeId)).toEqual(["12:345", "99:1"])
    expect(walk).not.toHaveBeenCalled()
  })

  it("validates the id list of the message", () => {
    expect(nodeIdsOf(["1:1"])).toEqual(["1:1"])
    expect(() => nodeIdsOf(undefined)).toThrow("nodeIds must be a list of node ids")
    expect(() => nodeIdsOf([1])).toThrow("nodeIds must be a list of node ids")
  })
})

describe("link-check handler", () => {
  it("answers with link-check-result in Design mode and in Dev Mode (a read)", async () => {
    const own = fakeText("12:345", "Pay now")
    setLink(own, link("12:345"))
    onPage(figmaMock, [fakeFrame("10:1", "Checkout", [own])])
    for (const editorType of ["figma", "dev"] as const) {
      const sent: MainToUi[] = []
      const bus = createMainBus(editorType, "development", (message) => sent.push(message))
      registerHandlers(bus, context(editorType))
      await bus.dispatch({ type: "link-check", requestId: "c1-1", nodeIds: ["12:345"] })
      expect(sent).toEqual([{ type: "link-check-result", requestId: "c1-1", nodes: [expect.objectContaining({ nodeId: "12:345", status: "found", linkState: "ok" })] }])
    }
    expect(figmaMock.commitUndo).not.toHaveBeenCalled()
  })

  it("answers for the page's inheriting instance sublayers when asked", async () => {
    const mainText = fakeText("5:67", "Pay now")
    setLink(mainText, link("5:67"))
    const component = fakeComponent("5:1", "Button", [mainText])
    const sublayer = fakeText("I12:34;5:67", "Pay now")
    sublayer.inheritFrom = mainText
    onPage(figmaMock, [component, fakeFrame("10:1", "Checkout", [fakeInstance("12:34", "Button", [sublayer], { overrides: [], mainComponent: component })])])
    const sent: MainToUi[] = []
    const bus = createMainBus("figma", "development", (message) => sent.push(message))
    registerHandlers(bus, context("figma"))
    await bus.dispatch({ type: "link-check", requestId: "c1-3", nodeIds: ["5:67"], inheritors: true })
    expect(sent).toEqual([{ type: "link-check-result", requestId: "c1-3", nodes: [expect.objectContaining({ nodeId: "5:67" }), expect.objectContaining({ nodeId: "I12:34;5:67", linkState: "inherited" })] }])
  })

  it("answers a malformed request with a handler-error", async () => {
    const sent: MainToUi[] = []
    const bus = createMainBus("figma", "development", (message) => sent.push(message))
    registerHandlers(bus, context("figma"))
    await bus.dispatch({ type: "link-check", requestId: "c1-2" })
    expect(sent).toEqual([{ type: "handler-error", forType: "link-check", requestId: "c1-2", message: "nodeIds must be a list of node ids" }])
  })
})
