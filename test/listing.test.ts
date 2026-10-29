/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import overrideManifest from "../build-figma-plugin.manifest.js"
import pkg from "../package.json"
import { decodeRgb, encodeRgbPng, LISTING_COMMENT, LISTING_IMAGES, readListingFile, readPng } from "../scripts/listing-images.mjs"
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
import refreshState from "../src/ui/state/refresh-requests.ts?raw"

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
    expect(storage).toContain("only image files")
    expect(storage).toContain("stored under the project and screenshot IDs")
    // Update screenshots ignores the setting (refreshGate: the screenshot gate with pref true; prepare({ ignorePref })),
    // so the setting's condition must not cover it.
    expect(refreshState).toContain("screenshotGate({ ...input, pref: true })")
    expect(refreshState).toContain("deps.uploader.prepare({ ignorePref: true })")
    expect(storage).toContain("and, whatever that setting says, the image of each frame ReRune requested when the user chooses **Update screenshots**")
    expect(storage).not.toMatch(/on \(the default\)[^;]*Update screenshots/)
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
  const assets = () => section(listing, "## Assets")

  it.each(Object.entries(LISTING_IMAGES))("%s has Figma's size, is the rendered art and is listed in COMMUNITY_LISTING.md", (name, spec) => {
    const png = readPng(readListingFile(name))
    expect([png.width, png.height]).toEqual([spec.width, spec.height])
    // 8-bit RGB: opaque by construction (Figma rounds the icon's corners itself).
    expect([png.bitDepth, png.colorType]).toEqual([8, 2])
    expect(png.text).toMatchObject({ Title: spec.title, Comment: LISTING_COMMENT })
    expect(JSON.stringify(png.text)).not.toMatch(/placeholder/i)
    expect(assets()).toContain(spec.width + " × " + spec.height + " PNG: `listing/" + name + "`")
    expect(listing).not.toMatch(/\(\*\*placeholder\*\*/)
  })

  it("lists the Dev Mode image only for the full build", () => {
    const lines = assets().split("\n")
    for (const [name, spec] of Object.entries(LISTING_IMAGES)) {
      const line = lines.find((entry) => entry.includes("`listing/" + name + "`")) ?? ""
      expect(line.includes("full build only"), name).toBe((spec as { fullBuildOnly?: boolean }).fullBuildOnly === true)
    }
  })

  it("names the art's sources and how to render it again", () => {
    expect(assets()).toContain("`node scripts/listing-art.mjs`")
    expect(assets()).toContain("`listing/src/`")
    expect(section(listing, "## Before you submit")).toContain("- [x] Icon and cover replaced")
  })

  it("reads back what it writes, and rejects a damaged PNG", () => {
    const pixels = [255, 0, 0, 0, 255, 0, 0, 0, 255, 15, 23, 41, 246, 168, 35, 255, 255, 255]
    const png = encodeRgbPng({ width: 3, height: 2, rgb: Uint8Array.from(pixels) }, { Title: "t" })
    const decoded = decodeRgb(png)
    expect([decoded.width, decoded.height, [...decoded.rgb]]).toEqual([3, 2, pixels])
    expect(readPng(png).text).toEqual({ Title: "t" })
    const icon = decodeRgb(readListingFile("icon-128.png"))
    expect([...icon.rgb.subarray(0, 3)]).toEqual([8, 13, 25])
    const bytes = Uint8Array.from(readListingFile("icon-128.png"))
    bytes[20] ^= 0xff
    expect(() => readPng(bytes)).toThrow("Bad CRC in the IHDR chunk")
    expect(() => readPng(new Uint8Array([1, 2, 3]))).toThrow("Not a PNG file")
  })
})
