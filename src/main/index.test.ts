import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeText, installFigma, uninstallFigma } from "../../test/figma-mock"
import { DATA_KEYS, PLUGIN_DATA_NAMESPACE } from "../shared/constants"
import { serializeLink } from "../shared/plugin-data"
import main from "./index"

afterEach(() => {
  uninstallFigma()
})

function shownData(figmaMock: ReturnType<typeof installFigma>): unknown {
  const html = figmaMock.showUI.mock.calls[0][0] as string
  const match = /const __SHOW_UI_DATA__=(.*?);\/\*ui\*\//.exec(html)
  return match === null ? null : JSON.parse(match[1])
}

describe("main entry", () => {
  it("opens the Design UI at 400 × 640 and skips invisible instance children", () => {
    const figmaMock = installFigma({ editorType: "figma", mode: "default", command: "open" })
    main()
    expect(figmaMock.skipInvisibleInstanceChildren).toBe(true)
    expect(figmaMock.showUI.mock.calls[0][1]).toEqual({ themeColors: true, width: 400, height: 640 })
    expect(shownData(figmaMock)).toEqual({ mode: "design", command: "open" })
  })

  it("opens the inspect UI at 300 × 480 in Dev Mode", () => {
    const figmaMock = installFigma({ editorType: "dev", mode: "inspect" })
    main()
    expect(figmaMock.showUI.mock.calls[0][1]).toEqual({ themeColors: true, width: 300, height: 480 })
    expect(shownData(figmaMock)).toEqual({ mode: "inspect" })
  })

  it("answers codegen with the linked key name and no UI", () => {
    const on = vi.fn()
    const figmaMock = installFigma({ editorType: "dev", mode: "codegen", codegen: { on } })
    main()
    expect(figmaMock.showUI).not.toHaveBeenCalled()
    expect(on).toHaveBeenCalledWith("generate", expect.any(Function))
    const generate = on.mock.calls[0][1] as (event: { node: unknown; language: string }) => CodegenResult[]

    const linked = fakeText("12:345", "Pay now")
    linked.setSharedPluginData(
      PLUGIN_DATA_NAMESPACE,
      DATA_KEYS.link,
      serializeLink({ v: 1, id: "6a4800000000000000000001", k: "checkout_pay_button", p: "6a4600000000000000000c35", src: "c53:1", nid: "12:345", t: 1 }),
    )
    expect(generate({ node: linked, language: "flutter" })).toEqual([{ title: "ReRune keys", language: "PLAINTEXT", code: "checkout_pay_button" }])
    expect(generate({ node: fakeText("1:2", "Plain"), language: "flutter" })).toEqual([
      { title: "ReRune", language: "PLAINTEXT", code: "No ReRune key is linked to this layer." },
    ])
    expect(generate({ node: { type: "FRAME" }, language: "flutter" })[0].code).toBe("No ReRune key is linked to this layer.")
  })
})
