import { afterEach, beforeEach, describe, expect, it } from "vitest"
import overrideMain from "../build-figma-plugin.main.js"
import overrideManifest, { devModeOf } from "../build-figma-plugin.manifest.js"
import overrideUi from "../build-figma-plugin.ui.js"
import pkg from "../package.json"
import { CODEGEN_PLATFORMS } from "../src/codegen/snippets"

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const original = { RERUNE_ENV: env.RERUNE_ENV, RERUNE_DEV_MODE: env.RERUNE_DEV_MODE }

beforeEach(() => {
  // A variant exported in the shell must not change what these tests build.
  delete env.RERUNE_DEV_MODE
})

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) {
      delete env[name]
    } else {
      env[name] = value
    }
  }
})

function build(variables: { RERUNE_ENV?: string; RERUNE_DEV_MODE?: string }): Record<string, unknown> {
  delete env.RERUNE_ENV
  delete env.RERUNE_DEV_MODE
  Object.assign(env, variables)
  return overrideManifest(copy(manifest))
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const rest = { ...value }
  for (const key of keys) {
    delete rest[key]
  }
  return rest
}

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

  it("lists the same codegen languages, in the same order, as the snippet builders", () => {
    expect(pkg["figma-plugin"].codegenLanguages).toEqual(CODEGEN_PLATFORMS.map((platform) => ({ label: platform.label, value: platform.value })))
  })

  it("adds the ReRune diagnostics language only in development builds", () => {
    env.RERUNE_ENV = "development"
    const result = overrideManifest(manifest)
    expect(result.codegenLanguages).toHaveLength(6)
    expect(result.codegenLanguages[5]).toEqual({ label: "ReRune diagnostics", value: "rerune-diagnostics" })
    expect(manifest.codegenLanguages).toHaveLength(5)
  })
})

// The design-only release (RERUNE_DEV_MODE=off) is the build for Figma's free plan: Figma Design only, no Dev Mode.
describe("build-figma-plugin.manifest.js: Dev Mode switch", () => {
  const DEV_MODE_KEYS = ["capabilities", "codegenLanguages"]

  it("keeps Dev Mode by default and with RERUNE_DEV_MODE=on (the spec's §7.3 manifest)", () => {
    for (const variables of [{}, { RERUNE_DEV_MODE: "" }, { RERUNE_DEV_MODE: "on" }]) {
      const result = build(variables)
      expect(result.editorType).toEqual(["figma", "dev"])
      expect(result.capabilities).toEqual(["inspect", "codegen", "vscode"])
      expect((result.codegenLanguages as { value: string }[]).map((language) => language.value)).toEqual(["react-i18next", "flutter", "android", "ios", "angular"])
      expect(result).toEqual(build({}))
    }
    expect((build({ RERUNE_ENV: "development", RERUNE_DEV_MODE: "on" }).codegenLanguages as unknown[]).length).toBe(6)
  })

  it.each(["production", "development"])("RERUNE_DEV_MODE=off builds a design-only manifest (%s)", (reruneEnv) => {
    const full = build({ RERUNE_ENV: reruneEnv })
    const designOnly = build({ RERUNE_ENV: reruneEnv, RERUNE_DEV_MODE: "off" })
    expect(designOnly.editorType).toEqual(["figma"])
    expect(designOnly).not.toHaveProperty("capabilities")
    expect(designOnly).not.toHaveProperty("codegenLanguages")
    expect(designOnly).not.toHaveProperty("codegenPreferences")
    expect(designOnly).not.toHaveProperty("menu")
    expect(JSON.stringify(designOnly)).not.toMatch(/inspect|codegen|vscode|rerune-diagnostics/)
    // Everything else is the full manifest unchanged: same id (clientStorage), network access and page loading.
    expect(without(designOnly, ["editorType"])).toEqual(without(full, ["editorType", ...DEV_MODE_KEYS]))
    expect(designOnly.id).toBe("1697181748239106841")
    expect(designOnly.id).toBe(pkg["figma-plugin"].id)
    expect(designOnly.documentAccess).toBe("dynamic-page")
    expect(designOnly.networkAccess).toEqual(pkg["figma-plugin"].networkAccess)
    expect(designOnly.relaunchButtons).toEqual([{ command: "open", name: "Open ReRune", multipleSelection: true }])
    expect(designOnly.main).toBe("build/main.js")
    expect(designOnly.ui).toBe("build/ui.js")
    expect(Object.keys(designOnly)).toEqual(Object.keys(full).filter((key) => !DEV_MODE_KEYS.includes(key)))
  })

  it("does not change the manifest it is given", () => {
    const input = copy(manifest)
    delete env.RERUNE_ENV
    env.RERUNE_DEV_MODE = "off"
    overrideManifest(input)
    expect(input).toEqual(manifest)
  })

  it("refuses other values, so a typo never ships the wrong variant", () => {
    for (const value of ["OFF", "false", "0", "no", "design-only", " off"]) {
      expect(() => build({ RERUNE_DEV_MODE: value })).toThrow('RERUNE_DEV_MODE must be "on" or "off", got "' + value + '"')
    }
    expect(devModeOf(undefined)).toBe(true)
    expect(devModeOf("")).toBe(true)
    expect(devModeOf("on")).toBe(true)
    expect(devModeOf("off")).toBe(false)
  })

  it("the npm scripts build each variant", () => {
    expect(pkg.scripts.build).toBe("build-figma-plugin --minify")
    expect(pkg.scripts["build:design-only"]).toBe("RERUNE_DEV_MODE=off build-figma-plugin --minify")
    expect(pkg.scripts.zip).toBe("npm run build && zip -r rerune-figma-plugin.zip manifest.json build")
    expect(pkg.scripts["zip:design-only"]).toBe("npm run build:design-only && zip -r rerune-figma-plugin-design-only.zip manifest.json build")
    for (const name of ["build", "build:dev", "watch", "zip"]) {
      expect(pkg.scripts[name as keyof typeof pkg.scripts]).not.toContain("RERUNE_DEV_MODE")
    }
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
