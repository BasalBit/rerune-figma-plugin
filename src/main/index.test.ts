import { afterEach, describe, expect, it } from "vitest"
import { fakeText, installFigma, onPage, uninstallFigma, type FigmaMock } from "../../test/figma-mock"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { serializeLink } from "../shared/plugin-data"
import main from "./index"

afterEach(() => {
  uninstallFigma()
})

function shownData(figmaMock: FigmaMock): unknown {
  const html = figmaMock.showUI.mock.calls[0][0] as string
  const match = /const __SHOW_UI_DATA__=(.*?);\/\*ui\*\//.exec(html)
  return match === null ? null : JSON.parse(match[1])
}

async function dispatch(figmaMock: FigmaMock, message: unknown): Promise<void> {
  ;(figmaMock.ui.onmessage as (message: unknown) => void)(message)
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("main entry (§7.4 mode dispatch)", () => {
  it("Design: skips invisible instance children, attaches the bus, watches the selection and opens 400 × 640", async () => {
    const figmaMock = installFigma({ editorType: "figma", mode: "default", command: "open" })
    main()
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
    expect(figmaMock.showUI.mock.calls[0][1]).toEqual({ themeColors: true, width: 400, height: 640 })
    expect(shownData(figmaMock)).toEqual({ mode: "design", command: "open" })
    expect(typeof figmaMock.ui.onmessage).toBe("function")
    expect(figmaMock.listeners.has("selectionchange")).toBe(true)

    await dispatch(figmaMock, { type: "ui-ready" })
    const init = figmaMock.ui.postMessage.mock.calls[0][0] as Record<string, unknown>
    expect(init).toMatchObject({ type: "init", editorType: "figma", command: "open", env: "development", apiBase: "http://localhost:8080", dashboardBase: "http://localhost:3000", pluginVersion: "0.0.0-test" })

    await dispatch(figmaMock, { type: "diagnostics-read", requestId: "d", test: "T10-environment" })
    const report = (figmaMock.ui.postMessage.mock.calls[1][0] as { report: Record<string, unknown> }).report
    expect(report).toMatchObject({ skipInvisibleInstanceChildrenDefault: false, skipInvisibleInstanceChildrenNow: true, startupCommand: "open" })
  })

  it("Dev Mode inspect: read-only bus, inspect-selection on selection change, 300 × 480", async () => {
    const figmaMock = installFigma({ editorType: "dev", mode: "inspect", skipInvisibleInstanceChildren: true })
    main()
    expect(figmaMock.showUI.mock.calls[0][1]).toEqual({ themeColors: true, width: 300, height: 480 })
    expect(shownData(figmaMock)).toEqual({ mode: "inspect" })
    const node = fakeText("1:1", "Pay now")
    onPage(figmaMock, [node], [node])
    figmaMock.emit("selectionchange")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(figmaMock.ui.postMessage.mock.calls[0][0]).toMatchObject({ type: "inspect-selection", kind: "text" })

    await dispatch(figmaMock, { type: "link-remove", requestId: "x", nodeIds: ["1:1"] })
    expect(figmaMock.notify).toHaveBeenCalledWith("Not available in Dev Mode", { error: true })
  })

  it("Dev Mode codegen: no UI, registers generate and answers with linked key names", async () => {
    const figmaMock = installFigma({ editorType: "dev", mode: "codegen", command: "generate" })
    main()
    expect(figmaMock.showUI).not.toHaveBeenCalled()
    expect(figmaMock.ui.onmessage).toBeUndefined()
    const generate = figmaMock.codegen.on.mock.calls[0][1] as (event: { node: unknown; language: string }) => Promise<CodegenResult[]>
    const linked = fakeText("12:345", "Pay now")
    linked.setSharedPluginData(
      PLUGIN_DATA_NAMESPACE,
      DATA_KEYS.link,
      serializeLink({ v: 1, id: "6a4800000000000000000001", k: "checkout_pay_button", p: "6a4600000000000000000c35", src: "c53:1", nid: "12:345", t: 1 }),
    )
    expect(await generate({ node: linked, language: "flutter" })).toEqual([{ title: "ReRune keys", language: "PLAINTEXT", code: "checkout_pay_button" }])
    expect(await generate({ node: fakeText("1:2", "Plain"), language: "flutter" })).toEqual([
      { title: "ReRune", language: "PLAINTEXT", code: "No ReRune key is linked to this layer." },
    ])
  })
})
