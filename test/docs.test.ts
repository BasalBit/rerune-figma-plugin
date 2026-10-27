/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from "vitest"
import overrideMain from "../build-figma-plugin.main.js"
import overrideManifest from "../build-figma-plugin.manifest.js"
import pkg from "../package.json"
import readme from "../README.md?raw"
import fileLinkComponents from "../src/ui/components/file-link.tsx?raw"
import uiDiagnostics from "../src/ui/diagnostics.ts?raw"
import layersScreen from "../src/ui/screens/layers.tsx?raw"
import settingsScreen from "../src/ui/screens/settings.tsx?raw"
import fileLinkState from "../src/ui/state/file-link.ts?raw"
import testing from "../TESTING.md?raw"

// README and TESTING.md must match what the build and the plugin actually do (P1.5: "present and accurate").

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const original = env.RERUNE_ENV

afterEach(() => {
  if (original === undefined) {
    delete env.RERUNE_ENV
  } else {
    env.RERUNE_ENV = original
  }
})

function hostsOf(reruneEnv: "production" | "development"): { apiBase: string; dashboardBase: string } {
  env.RERUNE_ENV = reruneEnv
  const define = overrideMain({ define: {} }).define as Record<string, string>
  return { apiBase: JSON.parse(define.__API_BASE__) as string, dashboardBase: JSON.parse(define.__DASHBOARD_BASE__) as string }
}

describe("README", () => {
  it("documents every npm script", () => {
    for (const name of Object.keys(pkg.scripts)) {
      expect(readme).toContain(name === "test" ? "`npm test`" : "`npm run " + name + "`")
    }
  })

  it("names the hosts each build talks to", () => {
    for (const build of ["development", "production"] as const) {
      const hosts = hostsOf(build)
      expect(readme).toContain("`" + hosts.apiBase + "`")
      expect(readme).toContain("`" + hosts.dashboardBase + "`")
    }
    expect(pkg["figma-plugin"].networkAccess.devAllowedDomains).toEqual([hostsOf("development").apiBase])
  })

  it("has the development steps: build, import the manifest, local server and dashboard", () => {
    expect(readme).toContain("npm run build:dev")
    expect(readme).toContain("Import plugin from manifest")
    expect(readme).toContain("FIGMA_CONNECT_URL=" + hostsOf("development").dashboardBase + "/figma/connect")
    expect(readme).toContain("go run ./cmd/api")
    expect(readme).toContain("pnpm dev")
    expect(readme).toContain("TESTING.md")
  })
})

describe("TESTING.md", () => {
  it("has every section of §7.23 plus production acceptance", () => {
    for (const section of ["0. Setup", "1. Sign-in", "2. Scan", "3. Link, create and push", "4. Preview", "5. Phase 2", "6. Phase 3", "7. Browser Figma and Figma for VS Code", "8. Spike questions", "9. Production acceptance"]) {
      expect(testing).toContain("## " + section)
    }
  })

  it("has a row for every spike question S1–S14", () => {
    for (let n = 1; n <= 14; n++) {
      expect(testing).toMatch(new RegExp("^\\| S" + n + " \\|", "m"))
    }
  })

  it("names every Diagnostics button the plugin shows", () => {
    const labels = [...uiDiagnostics.matchAll(/label: "(T\d+ [^"]+)"/g)].map((match) => match[1])
    expect(labels).toHaveLength(11)
    for (const label of [...labels, "Network check", "Copy report", "ReRune diagnostics"]) {
      expect(testing).toContain(label)
    }
  })

  it("names the Phase 2 file-link controls and banners the plugin shows", () => {
    const ui = [fileLinkComponents, layersScreen, settingsScreen, fileLinkState].join("\n")
    for (const label of ["Sync links on this page", "This is the same file", "Save link", "Replace link", "Paste link", "Remove all", "Figma file"]) {
      expect(ui).toContain(label)
      expect(testing).toContain(label)
    }
    for (const name of ["COPY_MESSAGE", "BRANCH_MESSAGE"]) {
      const match = fileLinkState.match(new RegExp("export const " + name + ' = "([^"]+)"'))
      expect(match).not.toBeNull()
      expect(testing).toContain(match?.[1] ?? "")
    }
  })

  it("uses the development hosts, the connect URL and the relaunch button name of the build", () => {
    const hosts = hostsOf("development")
    expect(testing).toContain(hosts.apiBase)
    expect(testing).toContain("FIGMA_CONNECT_URL=" + hosts.dashboardBase + "/figma/connect")
    const relaunch = overrideManifest({ ...pkg["figma-plugin"], main: "build/main.js", ui: "build/ui.js" }).relaunchButtons as { name: string }[]
    expect(testing).toContain("**" + relaunch[0].name + "**")
  })
})
