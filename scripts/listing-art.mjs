// Renders the Figma Community listing images (COMMUNITY_LISTING.md → Assets) from listing/src/art.html in headless
// Chromium. Not run in CI; run it when the screens or the art change, from the commit you publish and before the
// release build is put in place:
//
//   CHROME_BIN=… node scripts/listing-art.mjs capture   builds the design-only and the full plugin and captures the
//                                                       screens into listing/src/shots (scripts/ui-harness.mjs), then
//                                                       puts back the build/ and manifest.json that were there
//   CHROME_BIN=… node scripts/listing-art.mjs render    writes listing/*.png from art.html and the shots
//
// CHROME_BIN is a Chromium or Chrome binary (without it, the installed Google Chrome). The images are written as
// 8-bit RGB PNGs (opaque) with a Title, the Comment LISTING_COMMENT and Software tEXt entry.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { decodeRgb, encodeRgbPng, LISTING_COMMENT, LISTING_DIR, LISTING_IMAGES, LISTING_SOFTWARE } from "./listing-images.mjs"
import { capture, launchBrowser } from "./ui-harness.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SHOTS = fileURLToPath(new URL("src/shots/", LISTING_DIR))
const ORIGIN = "https://listing.rerune.local"
const SERVED = ["/listing/src/", "/assets/brand/"]
const TYPES = { ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff": "font/woff" }

// The shots art.html shows: [scenario, size, theme, build]. The Dev Mode panel needs the full build.
const SHOT_RUNS = {
  "layers-light": ["05-layers", "listing", "light", "design-only"],
  "push-light": ["06-push-review", "listing", "light", "design-only"],
  "preview-light": ["08-preview", "listing", "light", "design-only"],
  "qa-dark": ["09-qa-overflow", "listing", "dark", "design-only"],
  "inspect-light": ["13-inspect", "inspect", "light", "full"],
}

// What the plugin's build output is now (build/ and manifest.json, if any), so capture can put it back: the build
// Figma desktop imported, or the release build being checked, stays as it was.
const BUILD_OUTPUT = ["build", "manifest.json"]

function saveBuildOutput() {
  const saved = mkdtempSync(join(tmpdir(), "rerune-listing-build-"))
  for (const entry of BUILD_OUTPUT) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(saved, entry), { recursive: true })
  }
  return saved
}

function restoreBuildOutput(saved) {
  for (const entry of BUILD_OUTPUT) {
    rmSync(join(ROOT, entry), { recursive: true, force: true })
    if (existsSync(join(saved, entry))) cpSync(join(saved, entry), join(ROOT, entry), { recursive: true })
  }
  rmSync(saved, { recursive: true, force: true })
}

async function captureShots() {
  const saved = saveBuildOutput()
  try {
    await captureBoth()
  } finally {
    restoreBuildOutput(saved)
  }
}

async function captureBoth() {
  const browser = await launchBrowser()
  for (const build of ["design-only", "full"]) {
    execFileSync("npm", ["run", build === "full" ? "build" : "build:design-only"], { cwd: ROOT, stdio: "inherit" })
    const runs = Object.entries(SHOT_RUNS)
      .filter(([, run]) => run[3] === build)
      .map(([file, [name, size, theme]]) => ({ name, size, theme, file }))
    const checks = await capture({ outDir: SHOTS, runs, browser })
    if (checks.some((check) => check.failed !== null)) {
      throw new Error("a capture failed: " + checks.filter((check) => check.failed !== null).map((check) => check.file + " " + check.failed).join("; "))
    }
  }
  await browser.close()
}

async function render() {
  const browser = await launchBrowser()
  for (const [name, spec] of Object.entries(LISTING_IMAGES)) {
    const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== ORIGIN || !SERVED.some((prefix) => url.pathname.startsWith(prefix))) {
        return route.abort()
      }
      return route.fulfill({ status: 200, contentType: TYPES[extname(url.pathname)] ?? "application/octet-stream", body: readFileSync(ROOT + url.pathname.slice(1)) })
    })
    await page.goto(ORIGIN + "/listing/src/art.html")
    if (!(await page.evaluate((image) => window.renderArt(image), name))) {
      throw new Error("art.html has no template for " + name)
    }
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: spec.width, height: spec.height } })
    const png = encodeRgbPng(decodeRgb(shot), { Title: spec.title, Comment: LISTING_COMMENT, Software: LISTING_SOFTWARE })
    writeFileSync(new URL(name, LISTING_DIR), png)
    console.log("wrote listing/" + name + " (" + png.length + " bytes)")
    await context.close()
  }
  await browser.close()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2]
  if (command === "capture") {
    await captureShots()
  } else if (command === "render") {
    await render()
  } else {
    console.error("usage: node scripts/listing-art.mjs capture|render")
    process.exit(2)
  }
}
