/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from "vitest"
import overrideMain from "../build-figma-plugin.main.js"
import overrideManifest from "../build-figma-plugin.manifest.js"
import pkg from "../package.json"
import { CODEGEN_CACHE_MAX_ENTRIES, CODEGEN_CACHE_MAX_PROJECTS, CODEGEN_SOURCE_TEXT_MAX_CHARS, DATA_KEYS, STORAGE_KEYS } from "../src/shared/constants"
import { isAllowed, MESSAGE_IMPACT } from "../src/shared/message-policy"
import { MAIN_TO_UI_TYPES, type UiToMainType } from "../src/shared/messages"
import { LANGUAGE_COPY_MESSAGES } from "../src/shared/node-errors"
import readme from "../README.md?raw"
import snippets from "../src/codegen/snippets.ts?raw"
import fileLinkComponents from "../src/ui/components/file-link.tsx?raw"
import inspectApp from "../src/ui/inspect-app.tsx?raw"
import inspectScreen from "../src/ui/screens/inspect.tsx?raw"
import inspectState from "../src/ui/state/inspect.ts?raw"
import uiDiagnostics from "../src/ui/diagnostics.ts?raw"
import layersScreen from "../src/ui/screens/layers.tsx?raw"
import linkSyncState from "../src/ui/state/link-sync.ts?raw"
import settingsScreen from "../src/ui/screens/settings.tsx?raw"
import fileLinkState from "../src/ui/state/file-link.ts?raw"
import screenshotState from "../src/ui/state/screenshots.ts?raw"
import screenshotStatus from "../src/ui/components/screenshot-status.tsx?raw"
import refreshComponent from "../src/ui/components/refresh-requests.tsx?raw"
import refreshState from "../src/ui/state/refresh-requests.ts?raw"
import pushScreen from "../src/ui/screens/push.tsx?raw"
import previewScreen from "../src/ui/screens/preview.tsx?raw"
import qaScreen from "../src/ui/screens/qa.tsx?raw"
import qaState from "../src/ui/state/qa.ts?raw"
import samplesComponent from "../src/ui/components/samples.tsx?raw"
import samplesState from "../src/ui/state/samples.ts?raw"
import layersState from "../src/ui/state/layers.ts?raw"
import previewState from "../src/ui/state/preview.ts?raw"
import testing from "../TESTING.md?raw"
import listing from "../COMMUNITY_LISTING.md?raw"
import pushState from "../src/ui/state/push.ts?raw"
import { snippetLines } from "../src/codegen/snippets"

// README and TESTING.md must match what the build and the plugin actually do (P1.5: "present and accurate").

// Test files of the repository (the README names the whole-repo ones). Vite leaves the importing file out.
const testFiles = [...Object.keys(import.meta.glob(["./*.test.ts", "../src/**/*.test.ts"])), "./docs.test.ts"]

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

  it("has the message table of the impact map: every UI → main type with its impact and Dev Mode rule", () => {
    for (const type of Object.keys(MESSAGE_IMPACT) as UiToMainType[]) {
      const impact = MESSAGE_IMPACT[type]
      const devMode = impact === "devprobe" ? "development builds only" : isAllowed(impact, "dev", "production") ? "yes" : "no"
      expect(readme).toMatch(new RegExp("^\\| `" + type + "` \\| `" + impact + "` \\| " + devMode + "[ (|]", "m"))
    }
    for (const type of MAIN_TO_UI_TYPES) {
      expect(readme).toContain("`" + type + "`")
    }
  })

  it("lists every plugin-data key, every local storage key and the codegen cache limits", () => {
    for (const key of Object.values(DATA_KEYS)) {
      expect(readme).toMatch(new RegExp("^\\| [a-z ]+ \\| `" + key + "` \\|", "m"))
    }
    for (const key of [STORAGE_KEYS.auth, STORAGE_KEYS.prefs, STORAGE_KEYS.codegenPrefix + "<projectId>", STORAGE_KEYS.codegenIndex]) {
      expect(readme).toContain("| `" + key + "` |")
    }
    expect(readme).toContain(CODEGEN_CACHE_MAX_ENTRIES.toLocaleString("en-US") + " keys")
    expect(readme).toContain("at most " + CODEGEN_CACHE_MAX_PROJECTS)
    expect(readme).toContain("up to " + CODEGEN_SOURCE_TEXT_MAX_CHARS + " characters")
  })

  it("names the relaunch button and the whole-repo tests that exist", () => {
    const relaunch = overrideManifest({ ...pkg["figma-plugin"], main: "build/main.js", ui: "build/ui.js" }).relaunchButtons as { name: string }[]
    expect(readme).toContain("**" + relaunch[0].name + "**")
    const named = [...readme.matchAll(/`((?:test|src)\/[\w/.-]+\.test\.ts)`/g)].map((match) => match[1])
    expect(named).toEqual(expect.arrayContaining(["test/message-contract.test.ts", "test/dev-mode-policy.test.ts", "src/ui/dev-mode-ui.test.ts", "test/docs.test.ts", "src/ui/api/readme.test.ts"]))
    for (const path of named) {
      expect(testFiles).toContain(path.startsWith("test/") ? "./" + path.slice(5) : "../" + path)
    }
  })
})

// The text between a heading and the next heading of the same or a higher level.
function section(text: string, heading: string): string {
  const start = text.indexOf(heading + "\n")
  expect(start, heading).toBeGreaterThanOrEqual(0)
  const level = heading.match(/^#+/)?.[0] ?? "##"
  const rest = text.slice(start + heading.length + 1)
  const next = rest.search(new RegExp("^#{1," + level.length + "} ", "m"))
  return next === -1 ? rest : rest.slice(0, next)
}

const PAID = /needs a paid Figma plan/i
const BRANCHING = /needs a Figma Organization or Enterprise plan \(branching\)/i

describe("public docs stand on their own", () => {
  it("README's privacy summary names the texts sent for exact-text lookups, as preparePush sends them", () => {
    const privacy = section(readme, "## Privacy")
    expect(privacy).toContain("opening **Push** sends the text of every unlinked text layer in scope and the key names it suggests for them")
    expect(privacy).toContain("the Link dialog and **Link exact matches** send the text of the selected layers")
    expect(privacy).toContain("These lookups create nothing in ReRune.")
    // The Push review posts every unlinked text in scope (E11 texts) and the suggested names (E11 names).
    const prepare = pushState.slice(pushState.indexOf("export async function preparePush"))
    expect(prepare).toMatch(/fetchTextMatches\(api, input\.projectId, unlinkedGroupTexts\(input\.nodes/)
    expect(prepare).toMatch(/fetchTakenNames\(api, input\.projectId, toCheck\)/)
    expect(listing).toContain("these lookups create nothing in ReRune")
  })

  it("lists every kind of plugin data the plugin writes in the data security answer", () => {
    const answers = section(listing, "## Data security disclosure")
    expect(answers).toContain("on language copies of frames, a marker with the language, source, variation and the original frame's ID")
    expect(answers).toContain("only when the Diagnostics write test **T1 Mark** is run, a test marker")
    expect(readme).toMatch(/\| text layer \| `diag` \| .*every build, only when you run that write test/)
    for (const key of Object.values(DATA_KEYS)) {
      expect(readme).toContain("`" + key + "`")
    }
  })

  it("does not send readers to the internal design spec or plan", () => {
    const note = readme.split("\n").find((line) => line.startsWith("Code comments that cite a section")) ?? ""
    for (const [name, text] of [["README.md", readme.replace(note, "")], ["TESTING.md", testing], ["COMMUNITY_LISTING.md", listing]]) {
      expect(text, name).not.toMatch(/\bspec(?:'s)? (?:§|message)|\bthe spec\b|plan §\d|tooling map/i)
    }
    expect(readme).toContain("refer to ReRune's internal design notes for this integration")
  })

  it("has the Dev Mode snippet table in TESTING.md, as the snippet builders write it", () => {
    const rows = section(testing, "### 5.5 Dev Mode inspect panel").split("\n").filter((line) => /^ {2}\| (React|Flutter|Android|iOS|Angular)/.test(line))
    expect(rows).toHaveLength(5)
    const cells = (row: string) => row.split(/(?<!\\)\|/).slice(2, 4).map((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].replace(/\\\|/g, "|")))
    const platforms = ["react-i18next", "flutter", "android", "ios", "angular"] as const
    rows.forEach((row, index) => {
      const [plain, withPlaceholders] = cells(row)
      expect(plain, row).toEqual(snippetLines(platforms[index], { name: "checkout_pay_button", placeholders: [] }))
      expect(withPlaceholders, row).toEqual(snippetLines(platforms[index], { name: "greeting", placeholders: ["a", "b"] }))
    })
  })

  it("explains how to run the scripts on Windows", () => {
    const development = section(readme, "## Development")
    expect(development).toContain("**Windows:**")
    expect(development).toContain("Git Bash or WSL")
    expect(development).toContain("npm config set script-shell")
  })
})

describe("README: Figma plans and release builds", () => {
  it("says which features need a paid Figma plan and what to do on the free plan", () => {
    const requirements = section(readme, "## Requirements")
    expect(requirements).toContain("Starter plan")
    expect(requirements).toContain("paid Figma plan with a Dev or Full seat")
    expect(requirements).toContain('"needs a paid Figma plan"')
    for (const check of ["§5.5", "§5.6", "Figma for VS Code", "library-component fixture", "S14"]) {
      expect(requirements).toContain(check)
    }
    expect(requirements).toContain("ship the design-only build (`npm run zip:design-only`)")
  })

  it("documents the RERUNE_DEV_MODE switch and the design-only manifest", () => {
    expect(readme).toContain("`RERUNE_DEV_MODE` picks the variant: `on` (the default) keeps Dev Mode; `off` writes a design-only manifest")
    expect(readme).toContain("`editorType` `[\"figma\"]` and no `capabilities` or `codegenLanguages`")
    expect(readme).toContain("RERUNE_ENV=development RERUNE_DEV_MODE=off npx build-figma-plugin")
    expect(readme).toContain("only development builds open `http://localhost` / `http://127.0.0.1` links")
  })

  it("says when to ship which release build", () => {
    const release = section(readme, "## Build and release")
    for (const command of ["`npm run zip:design-only`", "`npm run zip`", "`node scripts/check-build.mjs full`", "`design-only`"]) {
      expect(release).toContain(command)
    }
    expect(release).toContain("**Which one to ship:** the design-only build, unless Dev Mode has been tested on a paid Figma plan")
    expect(release).toMatch(/§5\.5 \(inspect panel\) and §5\.6 \(codegen\) passed, and spike S14/)
    expect(release).toContain("`" + pkg["figma-plugin"].id + "`")
    expect(release).toContain("COMMUNITY_LISTING.md")
    expect(release).toContain("CHANGELOG.md")
  })
})

describe("TESTING.md", () => {
  it("marks every check that needs a paid Figma plan and says what to do on the free plan", () => {
    const intro = testing.slice(0, testing.indexOf("## 0. Setup"))
    expect(intro).toContain("**On the free plan:** skip them")
    expect(intro).toContain("ship the design-only build (`npm run zip:design-only`")
    for (const [heading, marker] of [
      ["### 5.5 Dev Mode inspect panel", "**Needs a paid Figma plan:**"],
      ["### 5.6 Codegen (Dev Mode → Code)", "**Needs a paid Figma plan**"],
    ]) {
      const body = section(testing, heading)
      expect(body.trimStart().startsWith(marker), heading).toBe(true)
      expect(body).toMatch(/On the free (Starter )?plan skip/)
    }
    expect(section(testing, "### 5.5 Dev Mode inspect panel")).toContain("ship the design-only build (`npm run zip:design-only`)")
    const vsCode = section(testing, "## 7. Browser Figma and Figma for VS Code")
    expect(vsCode).toMatch(/^- \[ \] \*\*Needs a paid Figma plan\.\*\* VS Code:/m)
    expect(vsCode).toContain("Figma for VS Code is a Dev Mode surface and needs a paid Figma plan")
    expect(testing).toMatch(/^- \[ \] An instance of a \*\*library component\*\*.*\*\*Needs a paid Figma plan\*\* \(team libraries\)/m)
    for (const row of ["S9", "S10", "S11", "S14"]) {
      expect(testing).toMatch(new RegExp("^\\| " + row + " \\| \\*\\*Needs a paid Figma plan\\.\\*\\*", "m"))
    }
    expect(testing).toMatch(/^\| S3 \| .*library needs a paid Figma plan/m)
    for (const test of ["T6 codegen", "T9 Dev Mode write"]) {
      expect(testing).toMatch(new RegExp("^\\| " + test + " \\| \\*\\*Needs a paid Figma plan\\.\\*\\*", "m"))
    }
    // Every line about Dev Mode surfaces or library components outside §5.5/§5.6 (marked as a whole) names the plan.
    const outside = testing.replace(section(testing, "### 5.5 Dev Mode inspect panel"), "").replace(section(testing, "### 5.6 Codegen (Dev Mode → Code)"), "")
    const checks = outside.split("\n").filter((line) => /^(- \[ \] |- \*\*|\| [TS]\d+ )/.test(line))
    const devModeChecks = checks.filter((line) => /library (instance|component)|Dev Mode inspect panel|VS Code|Dev Mode → Code|in Dev Mode/.test(line))
    expect(devModeChecks.length).toBeGreaterThanOrEqual(12)
    for (const line of devModeChecks) {
      expect(line).toMatch(PAID)
    }
    expect(testing.split("\n")[2]).toMatch(PAID)
    expect(testing).toContain("**Do not submit the full build to Community until S14 is answered.**")
  })

  it("marks every check that creates or merges a branch as needing an Organization or Enterprise plan", () => {
    const intro = testing.slice(0, testing.indexOf("## 0. Setup"))
    expect(intro).toMatch(BRANCHING)
    expect(intro).toContain("Starter and Professional do not")
    for (const check of ["§5.1 **Branch link**", "§5.2 **Branch safety**", "§5.3 **Off and blocked**", "T1", "T7", "S5"]) {
      expect(intro).toContain(check)
    }
    expect(intro).toMatch(/\*\*Phase 1 is done when\*\*.*S5 stays open/)
    const checks = testing.split("\n").filter((line) => /^(- \[ \] |- \*\*|\| [TS]\d+ )/.test(line))
    const branchChecks = checks.filter((line) => /\bbranch(es)?\b/i.test(line.replace(/branch chosen|chosen branch/gi, "")))
    expect(branchChecks.length).toBeGreaterThanOrEqual(6)
    for (const line of branchChecks) {
      expect(line).toMatch(BRANCHING)
    }
  })

  it("runs unpublished builds in Figma desktop only and browser Figma after publishing", () => {
    expect(testing.split("\n")[2]).toContain("only in the desktop app")
    // §7 runs on the published build as a whole (its intro says so); §10 is the post-publish smoke test.
    const beforePublish = testing.slice(0, testing.indexOf("## 10. Post-publish smoke test")).replace(section(testing, "## 7. Browser Figma and Figma for VS Code"), "")
    const browserChecks = beforePublish.split("\n").filter((line) => /^- \[ \] /.test(line) && /browser Figma/i.test(line))
    for (const line of browserChecks) {
      expect(line).toMatch(/published build|§10/)
    }
    expect(section(testing, "## 7. Browser Figma and Figma for VS Code")).toContain("runs on the **published Community build**")
    expect(section(testing, "## 9. Production acceptance")).not.toContain("and in browser Figma")
    const smoke = section(testing, "## 10. Post-publish smoke test")
    expect(smoke).toContain("Browser Figma has its own plugin storage")
    expect(listing).toContain("`TESTING.md` §10")
    expect(readme).toContain("browser Figma runs only published plugins")
  })

  it("builds the variant that will be published for the production acceptance", () => {
    const production = section(testing, "## 9. Production acceptance")
    expect(production).toContain("`npm run build:design-only` for the design-only release, or `npm run build` for the full release")
    expect(testing).toContain("| Figma plan and seat |")
    expect(testing).toContain("RERUNE_ENV=development RERUNE_DEV_MODE=off npx build-figma-plugin")
  })

  it("checks signed out that the dashboard's GitHub links open the public repository", () => {
    const step = section(testing, "## 9. Production acceptance").split("\n").find((line) => line.startsWith("- [ ] 1. ")) ?? ""
    expect(step).toContain("dashboard deployed after it")
    expect(step).toContain("Signed out, **View source on GitHub** on `https://rerune.io/figma` and **Source code on GitHub** on `https://rerune.io/docs/figma` open the repository, not a GitHub 404")
  })

  it("has every section of §7.23 plus production acceptance", () => {
    for (const section of ["0. Setup", "1. Sign-in", "2. Scan", "3. Link, create and push", "4. Preview", "5. Phase 2", "6. Phase 3", "7. Browser Figma and Figma for VS Code", "8. Spike questions", "9. Production acceptance", "10. Post-publish smoke test"]) {
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

  it("names the screenshot toggle, notes and results the plugin shows (P2.3)", () => {
    for (const label of ["Upload screenshots of changed frames", "Screenshots not uploaded", "Stop", "Uploading screenshots…"]) {
      expect([settingsScreen, pushScreen, screenshotState, screenshotStatus].join("\n")).toContain(label)
      expect(testing).toContain(label)
    }
    for (const name of ["SCREENSHOTS_ON_HINT", "SERVER_DISABLED_HINT", "NO_FILE_HINT", "COPY_HINT", "CHECKING_HINT"]) {
      const match = screenshotState.match(new RegExp("export const " + name + ' = "([^"]+)"'))
      expect(match).not.toBeNull()
      expect(testing).toContain(match?.[1] ?? "")
    }
    const preview = screenshotState.match(/preview_active: "([^"]+)"/)
    expect(testing).toContain(preview?.[1] ?? "missing")
    expect(readme).toContain("Upload screenshots of changed frames")
  })

  it("names the screenshot requests' notice, actions and results (screenshot freshness)", () => {
    const ui = [refreshComponent, refreshState].join("\n")
    for (const label of ["Update screenshots", "Not now", "Remove request", "Remove all", "Reset previews", "ReRune asks for new screenshots of", "Requested by", "Request removed."]) {
      expect(ui).toContain(label)
      expect(testing).toContain(label)
    }
    for (const name of ["NO_REQUESTS_LEFT", "REFRESH_BUSY"]) {
      const match = refreshState.match(new RegExp("export const " + name + ' = "([^"]+)"'))
      expect(match).not.toBeNull()
      expect(testing).toContain(match?.[1] ?? "")
    }
    expect(readme).toContain("Update screenshots")
    // refreshLines' hidden line (its exact text is checked in refresh-requests.test.ts).
    expect(refreshState).toContain('" hidden in Figma, so "')
    expect(testing).toContain("1 requested frame is hidden in Figma, so its screenshot wasn't uploaded: {frame} ({page}).")
    expect(readme).toContain("and hidden ones (also in a hidden section")
    // The counts the check expects ("Updated 1 layer", "1 layer changed in Figma or in both") need the Figma edit on one
    // of the two layers whose key changed: on any other layer both keys are Changed in ReRune.
    const check = testing.split("\n").find((line) => line.startsWith("- [ ] **Screenshot requests**")) ?? ""
    expect(check).toContain("change the Figma text of one of those two layers without pushing (it is then changed in both places)")
    expect(check).toContain('"Updated 1 layer from ReRune."')
    expect(check).toContain('"1 layer changed in Figma or in both wasn\'t changed. Review it on Push."')
    expect(readme).toContain("**Update screenshots** uploads those frames the same way, whatever the setting says.")
  })

  it("names the Dev Mode inspect controls, notes and codegen lines the plugin shows (P2.4, P2.5)", () => {
    for (const label of ["Copy code", "Open in ReRune", "Refresh", "Check again", "Inherited from ", "Missing", "Too long", "Plural/ICU"]) {
      expect([inspectScreen, inspectApp, inspectState].join("\n")).toContain(label)
      expect(testing).toContain(label)
    }
    for (const name of ["INSPECT_DESCRIPTION", "NOT_CONNECTED_MESSAGE", "MISSING_KEY_NOTE", "OTHER_PROJECT_NOTE", "NOT_PUBLISHED_NOTE", "INSPECT_TRUNCATED_NOTE"]) {
      const match = inspectState.match(new RegExp("export const " + name + ' = "([^"]+)"'))
      expect(match).not.toBeNull()
      expect(testing).toContain(match?.[1] ?? "")
    }
    for (const name of ["MORE_KEYS_LINE", "UNCACHED_NOTE"]) {
      const match = snippets.match(new RegExp("export const " + name + ' = "([^"]+)"'))
      expect(match).not.toBeNull()
      expect(testing).toContain(match?.[1] ?? "")
    }
    for (const platform of pkg["figma-plugin"].codegenLanguages) {
      expect(testing).toContain(platform.label)
    }
  })

  it("has the Phase 2 sections, the dashboard sign-in checks and the done criteria", () => {
    for (const section of ["### 1.1 Connect page and Connected apps (dashboard)", "### 5.1 File link", "### 5.2 Link sync", "### 5.3 Screenshots", "### 5.4 Dashboard", "### 5.5 Dev Mode inspect panel", "### 5.6 Codegen", "### 5.7 MCP"]) {
      expect(testing).toContain(section)
    }
    expect(testing).toContain("**Phase 2 is done when**")
    for (const tool of ["get_keys_for_figma_url", "list_figma_links"]) {
      expect(testing).toContain("`" + tool + "`")
    }
    const rejected = linkSyncState.match(/\+ " (saved in ReRune because [^"]+)"/)
    expect(rejected).not.toBeNull()
    expect(testing).toContain("1 link wasn't " + (rejected?.[1] ?? "missing"))
  })

  it("names the Phase 3 QA, sample, plural and max length controls the plugin shows (P3.1, P3.2, P3.5)", () => {
    const ui = [qaScreen, previewScreen, samplesComponent, samplesState, layersState, layersScreen, pushScreen, previewState].join("\n")
    for (const label of [
      "Pseudo-localize",
      "Pseudo-localization",
      "Previewing pseudo-localization on",
      "Sample values and plural forms",
      "Clear samples",
      "Automatic",
      "Longer than max length",
      "Over max length",
      "Too long",
      "Pushing this text is blocked.",
      "Overwrite ReRune is blocked.",
      "longer than the key's max length and won't be pushed",
    ]) {
      expect(ui).toContain(label)
      expect(testing).toContain(label)
    }
    for (const label of ["Pseudo-localize", "Sample values and plural forms", "Over max length", "Too long"]) {
      expect(readme).toContain(label)
    }
  })

  it("names the overflow report and language copies controls and messages the plugin shows (P3.3, P3.4)", () => {
    const ui = [qaScreen, qaState].join("\n")
    // UI modules need DOM types, which this tsconfig has not: their texts are read from the source.
    const constant = (name: string) => {
      const match = qaState.match(new RegExp("export const " + name + " = \"([^\"]+)\""))
      expect(match, name).not.toBeNull()
      return match?.[1] ?? ""
    }
    const header = qaState.match(/export const CSV_HEADER = \[([^\]]+)\]/)?.[1].split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")) ?? []
    expect(header).toHaveLength(8)
    for (const label of [
      "Run overflow report",
      "Include pseudo-localization",
      "Copy CSV",
      "Make language copies",
      "Select originals",
      "Clipped",
      "Truncated",
      "Outside its frame",
      "past its box",
      "cut off",
      "characters too long",
      "no value in this language and kept the source text",
      "Stopped before the last language.",
      constant("NO_FRAMES"),
      constant("NO_LAYERS"),
      constant("PREVIEWING_FRAMES"),
      constant("PREVIEWING_SCOPE"),
    ]) {
      expect(ui).toContain(label)
      expect(testing).toContain(label)
    }
    for (const message of [LANGUAGE_COPY_MESSAGES.component]) {
      expect(testing).toContain(message)
    }
    expect(testing).toContain(header.join(", "))
    for (const label of ["Run overflow report", "Include pseudo-localization", "Copy CSV", "Make language copies", "Clipped", "Truncated", "Outside its frame"]) {
      expect(readme).toContain(label)
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
