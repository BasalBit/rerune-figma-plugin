import { afterEach, describe, expect, it } from "vitest"
import overrideMain from "../build-figma-plugin.main.js"
import overrideManifest from "../build-figma-plugin.manifest.js"
import overrideUi from "../build-figma-plugin.ui.js"
import pkg from "../package.json"

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const original = env.RERUNE_ENV

afterEach(() => {
  if (original === undefined) {
    delete env.RERUNE_ENV
  } else {
    env.RERUNE_ENV = original
  }
})

const manifest = { ...pkg["figma-plugin"], main: "build/main.js", ui: "build/ui.js" }

describe("build-figma-plugin.manifest.js", () => {
  it("adds the relaunch button and keeps exactly 5 codegen languages in production", () => {
    delete env.RERUNE_ENV
    const result = overrideManifest(manifest)
    expect(result.relaunchButtons).toEqual([{ command: "open", name: "Open ReRune", multipleSelection: true }])
    expect(result.codegenLanguages.map((language: { value: string }) => language.value)).toEqual(["react-i18next", "flutter", "android", "ios", "angular"])
    expect(result.networkAccess).toEqual(pkg["figma-plugin"].networkAccess)
    expect(result).not.toHaveProperty("menu")
    expect(result).not.toHaveProperty("codegenPreferences")
  })

  it("adds the ReRune diagnostics language only in development builds", () => {
    env.RERUNE_ENV = "development"
    const result = overrideManifest(manifest)
    expect(result.codegenLanguages).toHaveLength(6)
    expect(result.codegenLanguages[5]).toEqual({ label: "ReRune diagnostics", value: "rerune-diagnostics" })
    expect(manifest.codegenLanguages).toHaveLength(5)
  })
})

describe("build-figma-plugin.{main,ui}.js", () => {
  it.each([
    ["main", overrideMain],
    ["ui", overrideUi],
  ])("defines production constants by default (%s)", (_name, override) => {
    delete env.RERUNE_ENV
    expect(override({ target: "es2017", define: { existing: "1" } })).toEqual({
      target: "es2017",
      define: {
        existing: "1",
        __RERUNE_ENV__: '"production"',
        __API_BASE__: '"https://rerune.io/api"',
        __DASHBOARD_BASE__: '"https://rerune.io"',
        __PLUGIN_VERSION__: JSON.stringify(pkg.version),
      },
    })
  })

  it.each([
    ["main", overrideMain],
    ["ui", overrideUi],
  ])("defines development constants (%s)", (_name, override) => {
    env.RERUNE_ENV = "development"
    expect(override({}).define).toEqual({
      __RERUNE_ENV__: '"development"',
      __API_BASE__: '"http://localhost:8080"',
      __DASHBOARD_BASE__: '"http://localhost:3000"',
      __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    })
  })

  it("refuses unknown environments", () => {
    env.RERUNE_ENV = "staging"
    expect(() => overrideMain({})).toThrow('RERUNE_ENV must be "production" or "development"')
  })
})
