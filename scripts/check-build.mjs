// Checks a release build (manifest.json, build/main.js, build/ui.js) before it is packed or uploaded. CI runs it
// after `npm run zip` and after `npm run zip:design-only`:
//
//   node scripts/check-build.mjs full          the build with Dev Mode (npm run build)
//   node scripts/check-build.mjs design-only   the design-only build (npm run build:design-only)
//
// It fails on a development build, on the wrong variant, on any manifest field that differs from package.json, and on
// a build/ui.js over its size budget or without the bundled brand fonts (fonts belong to the UI, never to main.js).
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const VARIANTS = ["full", "design-only"]
export const PRODUCTION_API_BASE = "https://rerune.io/api"

// build/ui.js was 299,034 bytes before the brand fonts and styles (+120,506: three WOFF2 fonts as base64, their
// licence, the brand stylesheet and components). Raise it only on purpose: Figma loads ui.js every time the plugin opens.
export const UI_JS_BUDGET = 420000
// "wOF2", the WOFF2 signature, as it starts a base64 font in the bundle.
const FONT_DATA = /d09GMg/

const RELAUNCH_BUTTONS = [{ command: "open", name: "Open ReRune", multipleSelection: true }]
const LOCAL_HOSTS = /localhost|127\.0\.0\.1/

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function releaseProblems({ variant, manifest, pkg, mainJs, uiJs }) {
  if (!VARIANTS.includes(variant)) {
    return [`unknown variant "${variant}" (use ${VARIANTS.join(" or ")})`]
  }
  const plugin = pkg["figma-plugin"]
  const problems = []
  const check = (ok, message) => {
    if (!ok) {
      problems.push(message)
    }
  }
  check(manifest.id === plugin.id, `id is ${JSON.stringify(manifest.id)}, package.json has ${JSON.stringify(plugin.id)}`)
  check(manifest.name === plugin.name, `name is ${JSON.stringify(manifest.name)}`)
  check(manifest.api === "1.0.0", `api is ${JSON.stringify(manifest.api)}`)
  check(manifest.main === "build/main.js" && manifest.ui === "build/ui.js", "main/ui are not build/main.js and build/ui.js")
  check(manifest.documentAccess === "dynamic-page", `documentAccess is ${JSON.stringify(manifest.documentAccess)}`)
  check(same(manifest.networkAccess, plugin.networkAccess), "networkAccess differs from package.json")
  check(same(manifest.relaunchButtons, RELAUNCH_BUTTONS), "relaunchButtons differ from the Open ReRune button")
  for (const key of ["menu", "parameters", "codegenPreferences", "permissions"]) {
    check(!(key in manifest), `manifest has "${key}"`)
  }
  if (variant === "full") {
    check(same(manifest.editorType, ["figma", "dev"]), `editorType is ${JSON.stringify(manifest.editorType)}, expected ["figma","dev"]`)
    check(same(manifest.capabilities, plugin.capabilities), `capabilities are ${JSON.stringify(manifest.capabilities)}`)
    check(same(manifest.codegenLanguages, plugin.codegenLanguages), "codegenLanguages differ from package.json (a development build adds ReRune diagnostics)")
  } else {
    check(same(manifest.editorType, ["figma"]), `editorType is ${JSON.stringify(manifest.editorType)}, expected ["figma"]`)
    check(!("capabilities" in manifest), "a design-only manifest has capabilities")
    check(!("codegenLanguages" in manifest), "a design-only manifest has codegenLanguages")
  }
  check(mainJs.includes(PRODUCTION_API_BASE), `build/main.js does not call ${PRODUCTION_API_BASE} (not a production build)`)
  check(!LOCAL_HOSTS.test(mainJs), "build/main.js mentions localhost or 127.0.0.1 (development build?)")
  check(!LOCAL_HOSTS.test(uiJs), "build/ui.js mentions localhost or 127.0.0.1 (development build?)")
  const uiBytes = Buffer.byteLength(uiJs, "utf8")
  check(uiBytes <= UI_JS_BUDGET, `build/ui.js is ${uiBytes} bytes, over its budget of ${UI_JS_BUDGET}`)
  check(FONT_DATA.test(uiJs), "build/ui.js has no bundled fonts (the .woff2 loader of build-figma-plugin.ui.js?)")
  check(!FONT_DATA.test(mainJs), "build/main.js has font data (the brand fonts belong to build/ui.js only)")
  return problems
}

function main() {
  const variant = process.argv[2] ?? "full"
  const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8")
  const problems = releaseProblems({
    variant,
    manifest: JSON.parse(read("manifest.json")),
    pkg: JSON.parse(read("package.json")),
    mainJs: read("build/main.js"),
    uiJs: read("build/ui.js"),
  })
  if (problems.length > 0) {
    console.error(`Release check (${variant}) failed:\n- ${problems.join("\n- ")}`)
    process.exit(1)
  }
  console.log(`Release check (${variant}) passed.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
