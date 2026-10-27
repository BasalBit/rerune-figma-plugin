import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installFigma, uninstallFigma } from "../../test/figma-mock"
import { serializeUiData, showPluginUI } from "./show-ui"

describe("showPluginUI (CFP G2 workaround)", () => {
  let figmaMock: ReturnType<typeof installFigma>

  beforeEach(() => {
    figmaMock = installFigma({ editorType: "dev", command: "generate" })
  })

  afterEach(() => {
    uninstallFigma()
  })

  it("always passes an empty command and injects the data", () => {
    showPluginUI({ width: 300, height: 480 }, { mode: "inspect" })
    const [html, options] = figmaMock.showUI.mock.calls[0] as unknown as [string, ShowUIOptions]
    expect(html).toContain("const __FIGMA_COMMAND__='';")
    expect(html).toContain('const __SHOW_UI_DATA__={"mode":"inspect"};')
    expect(html).toContain("document.body.classList.add('theme-dev');")
    expect(html.startsWith('<div id="create-figma-plugin"></div><script>')).toBe(true)
    expect(html.endsWith("/*ui*/</script>")).toBe(true)
    expect(options).toEqual({ themeColors: true, width: 300, height: 480 })
  })

  it("lets callers override themeColors", () => {
    showPluginUI({ themeColors: false }, {})
    expect(figmaMock.showUI.mock.calls[0][1]).toEqual({ themeColors: false })
  })
})

describe("serializeUiData", () => {
  it("escapes characters that could end the script or break the line", () => {
    const data = { name: "</script><script>alert(1)</script>", text: "a" + String.fromCharCode(0x2028) + "b" + String.fromCharCode(0x2029) }
    const json = serializeUiData(data)
    expect(json).not.toContain("<")
    expect(json).not.toContain(String.fromCharCode(0x2028))
    expect(json).not.toContain(String.fromCharCode(0x2029))
    expect(JSON.parse(json)).toEqual(data)
  })
})
