/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from "vitest"
import overrideManifest from "../build-figma-plugin.manifest.js"
import pkg from "../package.json"
import { PRODUCTION_API_BASE, releaseProblems, VARIANTS } from "../scripts/check-build.mjs"
import ci from "../.github/workflows/ci.yml?raw"
import gitignore from "../.gitignore?raw"
import nvmrc from "../.nvmrc?raw"

// Release tooling (P3.6): CI builds and checks both release variants; scripts/check-build.mjs refuses a wrong build.

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const original = { RERUNE_ENV: env.RERUNE_ENV, RERUNE_DEV_MODE: env.RERUNE_DEV_MODE }

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) {
      delete env[name]
    } else {
      env[name] = value
    }
  }
})

type Manifest = Record<string, unknown>

// The manifest CFP writes: its own fields plus the hook's (build-manifest-async.js in @create-figma-plugin/build).
function builtManifest(variables: { RERUNE_ENV?: string; RERUNE_DEV_MODE?: string }): Manifest {
  delete env.RERUNE_ENV
  delete env.RERUNE_DEV_MODE
  Object.assign(env, variables)
  const { main: _main, ui: _ui, ...rest } = pkg["figma-plugin"]
  expect([_main, _ui]).toEqual(["src/main/index.ts", "src/ui/index.tsx"])
  return overrideManifest({ api: "1.0.0", ...rest, main: "build/main.js", ui: "build/ui.js" }) as Manifest
}

const PRODUCTION_MAIN = 'var a="' + PRODUCTION_API_BASE + '",b="https://rerune.io";'
const PRODUCTION_UI = "function render(){}"

function problems(variant: string, manifest: Manifest, mainJs = PRODUCTION_MAIN, uiJs = PRODUCTION_UI): string[] {
  return releaseProblems({ variant, manifest, pkg, mainJs, uiJs })
}

describe("scripts/check-build.mjs", () => {
  it("passes the production manifest of each variant", () => {
    expect(VARIANTS).toEqual(["full", "design-only"])
    expect(problems("full", builtManifest({}))).toEqual([])
    expect(problems("design-only", builtManifest({ RERUNE_DEV_MODE: "off" }))).toEqual([])
  })

  it("refuses the other variant's manifest", () => {
    expect(problems("design-only", builtManifest({}))).toEqual([
      'editorType is ["figma","dev"], expected ["figma"]',
      "a design-only manifest has capabilities",
      "a design-only manifest has codegenLanguages",
    ])
    expect(problems("full", builtManifest({ RERUNE_DEV_MODE: "off" }))).toEqual([
      'editorType is ["figma"], expected ["figma","dev"]',
      "capabilities are undefined",
      "codegenLanguages differ from package.json (a development build adds ReRune diagnostics)",
    ])
  })

  it("refuses development builds: the diagnostics language, a local API or a localhost link in a bundle", () => {
    expect(problems("full", builtManifest({ RERUNE_ENV: "development" }))).toEqual([
      "codegenLanguages differ from package.json (a development build adds ReRune diagnostics)",
    ])
    const devMain = 'var a="http://localhost:8080",b="http://localhost:3000";'
    expect(problems("design-only", builtManifest({ RERUNE_DEV_MODE: "off" }), devMain)).toEqual([
      "build/main.js does not call https://rerune.io/api (not a production build)",
      "build/main.js mentions localhost or 127.0.0.1 (development build?)",
    ])
    expect(problems("full", builtManifest({}), PRODUCTION_MAIN + "/^http:\\/\\/(localhost|127\\.0\\.0\\.1)/")).toEqual([
      "build/main.js mentions localhost or 127.0.0.1 (development build?)",
    ])
    expect(problems("full", builtManifest({}), PRODUCTION_MAIN, 'fetch("http://127.0.0.1:8080")')).toEqual([
      "build/ui.js mentions localhost or 127.0.0.1 (development build?)",
    ])
  })

  it("refuses a manifest that differs from package.json", () => {
    const manifest = builtManifest({})
    expect(problems("full", { ...manifest, id: "0000000000000000000" })).toEqual(['id is "0000000000000000000", package.json has "1697181748239106841"'])
    expect(problems("full", { ...manifest, documentAccess: undefined })).toEqual(["documentAccess is undefined"])
    expect(problems("full", { ...manifest, networkAccess: { allowedDomains: ["*"], reasoning: "x" } })).toEqual(["networkAccess differs from package.json"])
    expect(problems("full", { ...manifest, permissions: ["currentuser"] })).toEqual(['manifest has "permissions"'])
    expect(problems("full", { ...manifest, relaunchButtons: [] })).toEqual(["relaunchButtons differ from the Open ReRune button"])
    expect(problems("full", { ...manifest, main: "src/main/index.ts" })).toEqual(["main/ui are not build/main.js and build/ui.js"])
    expect(problems("beta", manifest)).toEqual(['unknown variant "beta" (use full or design-only)'])
  })
})

describe("CI workflow (.github/workflows/ci.yml)", () => {
  const commands = [...ci.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1])
  const uploads = [...ci.matchAll(/^\s+path: (.+)$/gm)].map((match) => match[1])

  it("runs on Node 24 from .nvmrc", () => {
    expect(nvmrc.trim()).toBe("24")
    expect(ci).toContain("node-version-file: .nvmrc")
    expect(ci).toContain("uses: actions/setup-node@")
  })

  it("checks, tests, then builds, checks and uploads both release variants and the development build", () => {
    expect(commands).toEqual([
      "npm ci",
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run zip",
      "node scripts/check-build.mjs full",
      "npm run zip:design-only",
      "node scripts/check-build.mjs design-only",
      "npm run build:dev",
    ])
    expect(uploads).toEqual(["rerune-figma-plugin.zip", "rerune-figma-plugin-design-only.zip"])
    expect(ci.match(/uses: actions\/upload-artifact@/g)).toHaveLength(2)
    expect(ci.match(/if-no-files-found: error/g)).toHaveLength(2)
  })

  it("uploads exactly the archives the zip scripts write, which git ignores", () => {
    expect(pkg.scripts.zip).toContain("zip -r " + uploads[0] + " manifest.json build")
    expect(pkg.scripts["zip:design-only"]).toContain("zip -r " + uploads[1] + " manifest.json build")
    expect(gitignore.split("\n")).toEqual(expect.arrayContaining(["*.zip", "manifest.json", "build"]))
  })

  it("only reads the repository", () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m)
  })
})
