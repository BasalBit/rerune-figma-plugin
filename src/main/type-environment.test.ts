import { describe, expect, it } from "vitest"

describe("main-thread type environment (src/main/tsconfig.json)", () => {
  it("has plugin typings and no DOM types", () => {
    const pluginType: PluginAPI["editorType"] | undefined = undefined
    // @ts-expect-error FormData is a DOM type; main-thread code runs in Figma's sandbox without it
    const domOnly: FormData | undefined = undefined
    expect(pluginType).toBeUndefined()
    expect(domOnly).toBeUndefined()
  })
})
