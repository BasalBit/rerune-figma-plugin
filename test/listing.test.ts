/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import overrideManifest from "../build-figma-plugin.manifest.js"
import pkg from "../package.json"
import { PLACEHOLDER_MARKER, PLACEHOLDERS, placeholderPng, readListingFile, readPng, scanlines } from "../scripts/listing-placeholders.mjs"
import { CODEGEN_PLATFORMS } from "../src/codegen/snippets"
import { CODEGEN_SOURCE_TEXT_MAX_CHARS } from "../src/shared/constants"
import listing from "../COMMUNITY_LISTING.md?raw"
import signIn from "../src/ui/screens/sign-in.tsx?raw"
import signedIn from "../src/ui/screens/signed-in.tsx?raw"
import layersScreen from "../src/ui/screens/layers.tsx?raw"
import linkDialog from "../src/ui/screens/link-dialog.tsx?raw"
import pushScreen from "../src/ui/screens/push.tsx?raw"
import previewScreen from "../src/ui/screens/preview.tsx?raw"
import settingsScreen from "../src/ui/screens/settings.tsx?raw"
import settingsState from "../src/ui/state/settings.ts?raw"

// COMMUNITY_LISTING.md (spec §7.24, P3.6) is public copy: it must match the manifest and what the code does.

function section(text: string, heading: string): string {
  const start = text.indexOf(heading + "\n")
  expect(start, heading).toBeGreaterThanOrEqual(0)
  const level = heading.match(/^#+/)?.[0] ?? "##"
  const rest = text.slice(start + heading.length + 1)
  const next = rest.search(new RegExp("^#{1," + level.length + "} ", "m"))
  return next === -1 ? rest : rest.slice(0, next)
}

describe("COMMUNITY_LISTING.md", () => {
  it("names the real plugin ID and the listing fields of §7.24", () => {
    expect(pkg["figma-plugin"].id).toBe("1697181748239106841")
    expect(listing).toContain("`" + pkg["figma-plugin"].id + "`")
    expect(listing).toContain("| Name | ReRune |")
    expect(listing).toContain("| Tagline | Link Figma text to ReRune translation keys, push copy as drafts and preview every language. |")
    expect(listing).toMatch(/^\| Category \| .+ \|$/m)
    expect(listing).toContain("| Support contact | info@basalbit.com |")
    expect(listing).toContain("| Privacy policy | https://rerune.io/privacy |")
    expect(listing).toContain("| Source code | https://github.com/BasalBit/rerune-figma-plugin |")
  })

  it("treats the GitHub repository as public, because the listing and the dashboard's public pages link to it", () => {
    // The repository was made public on 2026-10-28; /figma and /docs/figma show it while figmaCommunityPluginUrl is null.
    expect(listing).not.toMatch(/still private|made public before submission/)
    expect(section(listing, "## Data security disclosure")).toContain("The source is public on GitHub (<https://github.com/BasalBit/rerune-figma-plugin>)")
    const checklist = section(listing, "## Before you submit")
    expect(checklist).toContain("- [x] https://github.com/BasalBit/rerune-figma-plugin is public")
    expect(checklist).toContain("`/figma` (**View source on GitHub**) and `/docs/figma` (**Source code on GitHub**)")
    expect(checklist).toContain("must be public before the dashboard is deployed")
  })

  it("repeats the manifest's network access word for word", () => {
    const { allowedDomains, reasoning } = pkg["figma-plugin"].networkAccess
    expect(listing).toContain("| Network access reasoning | " + reasoning + " |")
    expect(allowedDomains).toEqual(["https://rerune.io/api/"])
    expect(listing).toContain("Restricted: `" + allowedDomains[0] + "` only")
  })

  it("says what the description must say, in the design-only text that ships by default", () => {
    const designOnly = section(listing, "### Design-only build (default)")
    for (const sentence of [
      "Requires a ReRune account. Designers join free on every ReRune plan.",
      "Keys created from Figma count toward your ReRune plan's key limit.",
      "Nothing is published from Figma",
      "No AI runs inside the plugin.",
      "free Starter plan",
    ]) {
      expect(designOnly).toContain(sentence)
    }
    // The design-only build has no Dev Mode: its description must not promise any.
    expect(designOnly).not.toMatch(/Dev Mode|inspect panel|Code section|snippet|VS Code/)
  })

  it("keeps the Dev Mode handoff for the full build, with the platforms the snippets support", () => {
    const full = section(listing, "### Add for the full build (with Dev Mode)")
    expect(full).toContain("paid Figma plan with a Dev or Full seat")
    const platforms = CODEGEN_PLATFORMS.map((platform) => platform.label)
    expect(full).toContain(platforms.slice(0, -1).join(", ") + " and " + platforms[platforms.length - 1])
    expect(full).toContain("read-only")
  })

  it("says which build to publish, with each variant's manifest", () => {
    const which = section(listing, "## Which build to publish")
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
    const saved = env.RERUNE_DEV_MODE
    try {
      env.RERUNE_DEV_MODE = "off"
      const designOnly = overrideManifest({ ...pkg["figma-plugin"], main: "build/main.js", ui: "build/ui.js" })
      delete env.RERUNE_DEV_MODE
      const full = overrideManifest({ ...pkg["figma-plugin"], main: "build/main.js", ui: "build/ui.js" })
      expect(which).toContain("`editorType " + JSON.stringify(designOnly.editorType) + "`, no `capabilities`, no `codegenLanguages`")
      expect(which).toContain("`editorType " + JSON.stringify(full.editorType) + "`, `capabilities " + JSON.stringify(full.capabilities) + "`, " + full.codegenLanguages.length + " codegen languages")
    } finally {
      if (saved === undefined) {
        delete env.RERUNE_DEV_MODE
      } else {
        env.RERUNE_DEV_MODE = saved
      }
    }
    expect(which).toContain("`npm run zip:design-only`")
    expect(which).toContain("`npm run zip`")
    expect(which).toMatch(/§5\.5.*§5\.6.*S14/)
    expect(which).toContain("free Starter plan")
  })

  it("answers the data security questions in line with the code", () => {
    const answers = section(listing, "## Data security disclosure")
    expect(answers.match(/^\d+\. \*\*/gm)).toHaveLength(10)
    expect(answers).toContain("`https://rerune.io/api/`")
    expect(answers).toContain("`clientStorage`")
    expect(answers).toContain("`Authorization: Bearer`")
    expect(answers).toContain("up to " + CODEGEN_SOURCE_TEXT_MAX_CHARS + " characters of source text")
    // The design-only build has no Dev Mode and keeps no codegen cache (MainContext.devMode).
    expect(answers).toContain("in the full build only, a cache of key names")
    expect(answers).toContain("the design-only build keeps no such cache")
    // "Upload screenshots of changed frames" is on by default in the plugin's preferences.
    expect(settingsState).toMatch(/uploadScreenshotsOnPush: true,/)
    expect(settingsScreen).toContain("Upload screenshots of changed frames")
    expect(answers).toContain('"Upload screenshots of changed frames" on (the default)')
    expect(answers).toContain("Sandbox accounts never upload images.")
    // The server keeps a keyed hash and the last four characters (app_tokens.token_hint, shown under Connected apps).
    expect(answers).toContain("HMAC-SHA256 hash of it and its last four characters")
    expect(answers).not.toMatch(/stores only a keyed HMAC-SHA256 hash of it\./)
  })

  it("says where screenshots and their records live, as the server stores them and the dashboard's legal pages say", () => {
    const answers = section(listing, "## Data security disclosure")
    // Only the dev Storage zone's city is confirmed; the dashboard says "Germany" until ops confirm production.
    expect(answers).not.toContain("Falkenstein")
    expect(answers).toContain("bunny.net Storage zone in Germany (EU), without replication")
    const bullets = answers.split("\n").filter((line) => line.startsWith("   - "))
    const database = bullets.find((line) => line.includes("In ReRune's database")) ?? ""
    const storage = bullets.find((line) => line.includes("In the bunny.net Storage zone")) ?? ""
    // design_screenshots (Mongo) keeps the boxes, frame and page names, size and sha256; Bunny gets only the bytes
    // at projects/<project>/screenshots/<screenshot>/<upload>.<jpg|png>.
    expect(database).toContain("the positions of its linked layers")
    expect(database).toMatch(/For each uploaded screenshot: its frame and page \(IDs and names\)/)
    expect(database).toContain("SHA-256")
    expect(storage).toContain("only the image file")
    expect(storage).toContain("stored under the project and screenshot IDs")
    expect(storage).not.toMatch(/positions|names/)
    expect(section(listing, "## Before you submit")).toContain("production bunny.net Storage zone is in Germany with no replication regions")
  })

  it("tells reviewers about AI, MCP and writes, with the plugin's real labels", () => {
    const notes = section(listing, "## Notes for Figma's reviewers")
    expect(notes).toContain("**No AI:**")
    expect(notes).toContain("**No MCP:**")
    expect(notes).toContain("**Writes only on user action:**")
    expect(notes).toContain("https://rerune.io/register")
    const labels: [string, string][] = [
      ["Sign in with ReRune", signIn],
      ["Continue", signedIn],
      ["Page", layersScreen],
      ["Scan", layersScreen],
      ["Create on push", linkDialog],
      ["Update layers from ReRune", pushScreen],
      ["Reset", previewScreen],
    ]
    for (const [label, source] of labels) {
      expect(source, label).toContain(label)
      expect(notes, label).toContain(label)
    }
  })
})

describe("listing images", () => {
  it.each(Object.entries(PLACEHOLDERS))("%s has Figma's size and is listed in COMMUNITY_LISTING.md", (name, spec) => {
    const png = readPng(readListingFile(name))
    expect([png.width, png.height]).toEqual([spec.width, spec.height])
    expect(listing).toContain("`listing/" + name + "`")
    expect(listing).toContain(spec.width + " × " + spec.height + " PNG: `listing/" + name + "`")
  })

  it.each(Object.keys(PLACEHOLDERS))("%s, while still a placeholder, is the generator's output and is marked as one", (name) => {
    const png = readPng(readListingFile(name))
    const text = png.text as Record<string, string>
    if (text.Comment !== PLACEHOLDER_MARKER) {
      // Real artwork replaced the placeholder: only the size check above applies.
      expect(listing).not.toContain("`listing/" + name + "` (**placeholder**")
      return
    }
    expect(listing).toContain("`listing/" + name + "` (**placeholder**, replace)")
    const generated = placeholderPng(name)
    expect(png.bitDepth).toBe(8)
    expect(png.colorType).toBe(2)
    // Compare decoded pixels, not bytes: zlib builds may compress the same pixels differently.
    expect(png.inflate().equals(scanlines(generated.canvas))).toBe(true)
    expect(readPng(generated.png).text).toEqual(text)
  })

  it("rejects a damaged PNG", () => {
    const bytes = Uint8Array.from(readListingFile("icon-128.png"))
    bytes[20] ^= 0xff
    expect(() => readPng(bytes)).toThrow("Bad CRC in the IHDR chunk")
    expect(() => readPng(new Uint8Array([1, 2, 3]))).toThrow("Not a PNG file")
  })
})
