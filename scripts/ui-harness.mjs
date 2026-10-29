// The plugin UI in headless Chromium, for the listing screenshots (scripts/listing-art.mjs capture) and for reviews:
// the built build/ui.js inside a parent page that plays Figma's main thread (postMessage) on fixture layers, with
// Figma's theme variables (CFP's snapshot) and figma-light / figma-dark on <html>. The ReRune API of the production
// build (https://rerune.io/api) is answered by page.route from fixtures; every other request is aborted, so nothing
// leaves the machine.
//
//   CHROME_BIN=… node scripts/ui-harness.mjs <out dir> [scenario prefix …]
//
// Build first (npm run build, or npm run build:design-only). Writes <scenario>[-<width>x<height>]-<theme>.png at 2x
// (HARNESS_SCALE=1 for standard-resolution screens), and checks.json: no horizontal scroll, no content above the top of
// a scroll area (unreachable), the layout shift while the screen loads, the brand fonts loaded, page errors, text under
// 4.5:1 (3:1 large). The Design screens render at 400 × 640 and at the window's 360 × 480 minimum, the Dev Mode panel at
// 300 × 480 and 300 × 200 (a short inspect panel). Every run sets reduced motion except 07-push-results, which plays the
// postmark's stamp-in. A scenario with `later` changes ReRune's side once its screen is shown (h.later: the plugin's
// background reads pick it up at the next round, at least 15 s after the last one, when the window gets focus).
// CHROME_BIN is a Chromium or Chrome binary; without it, the installed Google Chrome is used. Not run in CI.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "playwright-core"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const themeCss = readFileSync(ROOT + "node_modules/@create-figma-plugin/ui/lib/css/theme.css", "utf8")
const block = (name) => {
  const start = themeCss.indexOf(":root ." + name + " {")
  return ":root{" + themeCss.slice(themeCss.indexOf("{", start) + 1, themeCss.indexOf("}", start)) + "}"
}
const THEMES = { light: block("figma-light"), dark: block("figma-dark") }
let uiJs = ""

export function launchBrowser() {
  return process.env.CHROME_BIN ? chromium.launch({ executablePath: process.env.CHROME_BIN }) : chromium.launch({ channel: "chrome" })
}

// ---------- fixture data (the /figma demo: a Chapter checkout) ----------
const API = "https://rerune.io/api"
const P = "6a4600000000000000000c35"
const K = (n) => "6a48" + String(n).padStart(20, "0")
const languages = [
  { code: "en", name: "English", main: true, rtl_writing: false, inherits_from: [] },
  { code: "de", name: "German", main: false, rtl_writing: false, inherits_from: [] },
  { code: "de-AT", name: "German (Austria)", main: false, rtl_writing: false, inherits_from: ["de"] },
  { code: "fr", name: "French", main: false, rtl_writing: false, inherits_from: [] },
]
const project = { id: P, name: "Chapter · Mobile app", organisation: { id: "6a4000000000000000000b11", name: "Chapter Labs" }, main_language: "en", languages, variation_options: [], permissions: ["edit_keys", "publishing"] }
const projects = [
  project,
  { ...project, id: "6a4600000000000000000c36", name: "Chapter · Website", permissions: ["edit_keys"] },
  { ...project, id: "6a4600000000000000000c37", name: "Brand guidelines", permissions: [] },
  { ...project, id: "6a4600000000000000000c38", name: "Sandbox demo", organisation: { id: "6a4000000000000000000b12", name: "Ada's Private Org" }, permissions: ["edit_keys", "publishing"] },
]
const user = { id: "kc", email: "ada@chapter.app", first_name: "Ada", last_name: "Lovelace", sandbox_expires_at: null }
const auth = { apiBase: API, token: "rrf_" + "ab".repeat(32), tokenId: "t1", tokenExpiresAt: "2027-01-25T10:01:12Z", user: { id: "kc", email: user.email, firstName: "Ada", lastName: "Lovelace" }, savedAt: 1 }
const settings = { v: 1, apiBase: API, projectId: P, projectName: project.name, fileKey: "AbC123xYz", fileUrl: "https://www.figma.com/design/AbC123xYz/Chapter-app", fileName: "Chapter app", branchKey: null, keyTemplate: null, caseStyle: "snake", ignoreUnderscoreLayers: true, includeLocked: false, updatedAt: 1 }

// Keys: [id, name, ReRune main text, German, French, max length]
const KEYS = {
  [K(1)]: ["checkout_pay_button", "Pay now", "Jetzt bezahlen", "Payer maintenant", 20],
  [K(2)]: ["checkout.payment_summary.total_amount_label", "Total due", "Gesamtbetrag", "Montant total", null],
  [K(3)]: ["checkout_title", "Checkout", null, "Paiement", null],
  [K(4)]: ["cart_empty_hint", "Nothing in your cart yet", "Dein Warenkorb ist noch leer", "Votre panier est vide", null],
  [K(5)]: ["cart_promo_label", "Have a promo code?", "Hast du einen Gutscheincode?", "Un code promo ?", null],
  [K(6)]: ["checkout_delivery_note", "Arrives in 2–3 days", "Lieferung in 2–3 Tagen, versandkostenfrei", "Livraison en 2 à 3 jours", 24],
}

// ---------- the parent page: Figma's main thread ----------
function hostHtml(theme, width, height, scenario) {
  const srcdoc =
    `<!doctype html><html class="figma-${theme}"><head><meta charset="utf-8"><style>${THEMES[theme]}</style></head><body>` +
    `<div id="create-figma-plugin"></div><script>const __FIGMA_COMMAND__='';const __SHOW_UI_DATA__={};${uiJs.replace(/<\/script/g, "<\\/script")}</script></body></html>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${theme === "dark" ? "#1e1e1e" : "#e5e5e5"}}</style></head><body>
<iframe id="ui" style="display:block;width:${width}px;height:${height}px;border:0" sandbox="allow-scripts allow-popups"></iframe>
<script>
const SC = ${JSON.stringify(scenario)}
const P = ${JSON.stringify(P)}
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
const src = (t) => "c53:" + cyrb53(t.replace(/\\r\\n|\\r/g, "\\n").trim()).toString(16)
function node(id, text, extra = {}) {
  return { nodeId: id, name: extra.name ?? text, characters: text, originalCharacters: null, pageId: "0:1", pageName: "Mobile", frameId: "10:1", frameName: "Checkout",
    parentNames: [], componentName: null, isInstanceSublayer: false, link: null, linkState: "none", preview: null, hasMissingFont: false,
    mixedStyles: false, boundToComponentProperty: false, boundToVariable: false, autoRename: true, textOverridden: false, width: 120, height: 20,
    textAutoResize: "WIDTH_AND_HEIGHT", textTruncation: "DISABLED", maxLines: null, ...extra }
}
function linked(id, text, keyId, keyName, linkedText, extra = {}) {
  return node(id, text, { link: { v: 1, id: keyId, k: keyName, p: P, src: src(linkedText), nid: id, t: 1 }, linkState: extra.linkState ?? "ok", ...extra })
}
window.state = { links: {}, previews: {}, posted: [] }
const BASE = () => SC.nodes.map((n) => n.linked ? linked(n.id, n.text, n.keyId, n.keyName, n.linkedText, n.extra) : node(n.id, n.text, n.extra))
window.nodes = () => BASE().map((n) => {
  let out = n
  const written = window.state.links[n.nodeId]
  if (written === "none") out = { ...out, link: null, linkState: "none" }
  else if (written) out = { ...out, link: { v: 1, id: written.keyId, k: written.keyName, p: P, src: written.src, nid: n.nodeId, t: 1 }, linkState: "ok" }
  const shown = window.state.previews[n.nodeId]
  if (shown) out = { ...out, originalCharacters: out.characters, characters: shown.text, preview: shown.info }
  return out
})
const frame = document.getElementById("ui")
function reply(message) { frame.contentWindow.postMessage({ pluginMessage: message }, "*") }
window.addEventListener("message", (event) => {
  const message = event.data && event.data.pluginMessage
  if (!message) return
  window.state.posted.push(message.type)
  const done = (n, errors = []) => reply({ type: "op-result", requestId: message.requestId, ok: errors.length === 0, done: n, errors })
  switch (message.type) {
    case "ui-ready":
      reply({ type: "init", editorType: SC.editorType ?? "figma", mode: SC.editorType === "dev" ? "inspect" : "default", command: "", env: "production", apiBase: ${JSON.stringify(API)}, dashboardBase: "https://rerune.io",
        pluginVersion: "0.1.0", auth: SC.auth, prefs: SC.prefs ?? {}, fileSettings: SC.settings, settingsSource: SC.settings ? "root" : "none",
        fileName: "Chapter app", pageId: "0:1", pageName: "Mobile", selectionCount: 3 })
      break
    case "diagnostics-read":
      reply({ type: "diagnostics-result", requestId: message.requestId, test: message.test, report: message.test === "T7-settings"
        ? { fileName: "Chapter app", current: { source: SC.settings ? "root" : "none", differ: false, offerMirror: false, settings: SC.settings, previews: 0 } }
        : { test: message.test, ok: true } })
      break
    case "inspect-request":
      reply({ type: "inspect-selection", kind: "text", nodes: window.nodes().filter((n) => n.link !== null).slice(0, 1), truncated: false })
      break
    case "settings-save": done(1); break
    case "scan-request": {
      const nodes = window.nodes()
      reply({ type: "scan-progress", requestId: message.requestId, scanned: nodes.length })
      setTimeout(() => {
        reply({ type: "scan-batch", requestId: message.requestId, nodes })
        reply({ type: "scan-done", requestId: message.requestId, total: nodes.length, truncated: false, skipped: { hidden: 2, locked: 0, empty: 0, numeric: 3, underscore: 0, languageCopy: 0, unavailable: 0 },
          ...(message.frameIds ? { missingFrameIds: [], hiddenFrameIds: [] } : {}) })
      }, 30)
      break
    }
    case "link-check": reply({ type: "link-check-result", requestId: message.requestId, nodes: [] }); break
    case "link-apply": for (const item of message.items) window.state.links[item.nodeId] = item; done(message.items.length); break
    case "link-remove": for (const id of message.nodeIds) window.state.links[id] = "none"; done(message.nodeIds.length); break
    case "text-apply": done(message.items.length); break
    case "preview-apply":
      for (const item of message.items) window.state.previews[item.nodeId] = { text: item.text, info: { ...message.info, appliedAt: Date.now() } }
      done(message.items.length)
      break
    case "preview-reset": {
      const ids = message.nodeIds ?? Object.keys(window.state.previews)
      for (const id of ids) delete window.state.previews[id]
      done(ids.length)
      break
    }
    case "overflow-check": {
      const items = []
      for (const id of message.nodeIds) {
        const shown = window.state.previews[id]
        if (!shown) continue
        if (id === "1:1") items.push({ nodeId: id, kind: "clipped", by: 14 })
        if (id === "1:4") items.push({ nodeId: id, kind: "exceeds_parent", by: 22.5 })
        if (id === "2:1") items.push({ nodeId: id, kind: "truncated", by: 31 })
      }
      reply({ type: "overflow-result", requestId: message.requestId, items })
      break
    }
    case "screenshots-export": reply({ type: "frame-images-done", requestId: message.requestId, exported: 0, skipped: [] }); break
    default: break
  }
})
frame.srcdoc = ${JSON.stringify(srcdoc).replace(/<\//g, "<\\/")}
</script></body></html>`
}

// ---------- scenarios ----------
// Layer fixtures: synced, changed in ReRune, changed in Figma, changed in both, copied, unlinked.
const LAYERS = [
  { id: "1:1", text: "Pay now", linked: true, keyId: K(1), keyName: "checkout_pay_button", linkedText: "Pay now", extra: { name: "Pay button" } },
  { id: "1:2", text: "Total", linked: true, keyId: K(2), keyName: "checkout.payment_summary.total_amount_label", linkedText: "Total", extra: { name: "Total label" } },
  { id: "1:3", text: "Review your order", linked: true, keyId: K(3), keyName: "checkout_title", linkedText: "Checkout", extra: { name: "Title" } },
  { id: "1:4", text: "Arrives in 2–3 days", linked: true, keyId: K(6), keyName: "checkout_delivery_note", linkedText: "Arrives in 2–3 days", extra: { name: "Delivery" } },
  { id: "1:5", text: "Cancel", extra: { name: "Cancel" } },
  { id: "2:1", text: "Your cart is empty", linked: true, keyId: K(4), keyName: "cart_empty_hint", linkedText: "Your cart is empty for now", extra: { frameId: "20:1", frameName: "Cart", name: "Empty hint" } },
  { id: "2:2", text: "Have a promo code?", linked: true, keyId: K(5), keyName: "cart_promo_label", linkedText: "Have a promo code?", extra: { frameId: "20:1", frameName: "Cart", name: "Promo", linkState: "copied" } },
  { id: "2:3", text: "Gift card", extra: { frameId: "20:1", frameName: "Cart", name: "Gift card", hasMissingFont: true } },
]
// ReRune's main-language text: K(2) changed in ReRune, K(3) changed in Figma (the layer), K(4) changed in both.
const REMOTE_MAIN = { [K(1)]: "Pay now", [K(2)]: "Total due", [K(3)]: "Checkout", [K(4)]: "Nothing in your cart yet", [K(5)]: "Have a promo code?", [K(6)]: "Arrives in 2–3 days" }

const CLEAN_LAYERS = LAYERS.filter((layer) => ["1:1", "1:3", "1:5"].includes(layer.id))
// The project after German was removed in ReRune (Austrian German no longer inherits from it).
const WITHOUT_DE = { ...project, languages: languages.filter((language) => language.code !== "de").map((language) => ({ ...language, inherits_from: [] })) }
// The background reads keep 15 s between rounds when the window gets focus (REQUEST_ATTENTION_MIN_MS, request-watch.ts).
const ATTENTION_MIN_MS = 15000

const base = { auth, settings, nodes: LAYERS, meta: { screenshots_enabled: false, screenshot_freshness: false }, requests: [] }
export const SCENARIOS = {
  "01-signin": { ...base, auth: null, settings: null, steps: async (h) => { await h.text("Sign in with ReRune") } },
  "02-pairing": { ...base, auth: null, settings: null, steps: async (h) => { await h.button("Sign in with ReRune"); await h.text("Check that the code in your browser matches") } },
  "03-signed-in": { ...base, auth: null, settings: null, pollApproves: true, steps: async (h) => { await h.button("Sign in with ReRune"); await h.text("Signed in as", 9000) } },
  "04-project-picker": { ...base, steps: async (h) => { await h.text("Chapter · Mobile app"); await h.link("Change"); await h.text("Choose a ReRune project"); await h.text("Brand guidelines") } },
  "05-layers": { ...base, sizes: ["default", "min"], steps: async (h) => { await h.scanPage(); await h.pending("1:5", "Cancel", "checkout_cancel"); await h.text("Review your order") } },
  "06-push-review": {
    ...base,
    sizes: ["default", "min"],
    steps: async (h) => { await h.scanPage(); await h.tab("Push"); await h.text("Changed in both", 8000); await h.wait(300) },
  },
  "06b-push-review-more": {
    ...base,
    steps: async (h) => { await h.scanPage(); await h.tab("Push"); await h.text("Changed in both", 8000); await h.scrollTo("Changed in both") },
  },
  // One of the two new texts included: Select all is partly ticked. That is a choice, so the change made in ReRune
  // meanwhile (Pay now) waits for Refresh.
  "06c-push-select-all": {
    ...base,
    later: { remote: { [K(1)]: "Pay now securely" } },
    steps: async (h) => {
      await h.scanPage(); await h.tab("Push"); await h.text("Changed in both", 8000); await h.checkFirst("Include in push")
      await h.later(); await h.text("ReRune has new changes.", 8000); await h.wait(300)
    },
  },
  "07-push-results": {
    ...base,
    nodes: CLEAN_LAYERS,
    motion: true,
    steps: async (h) => { await h.scanPage(); await h.tab("Push"); await h.text("Changed in Figma", 8000); await h.checkAll("Include in push"); await h.button(/^Push \d+ changes?$/); await h.text("Drafts are never published from Figma.", 8000); await h.wait(400) },
  },
  // Checkout was edited in ReRune while the push ran: the result card's chip shows the layer's state as it is now, and
  // after Take ReRune text it is Synced (second shot, "resolved").
  "07b-push-results-conflict": {
    ...base,
    nodes: CLEAN_LAYERS,
    later: { remote: { [K(3)]: "Checkout and pay" }, conflictOnPush: true },
    steps: async (h) => {
      await h.scanPage(); await h.tab("Push"); await h.text("Changed in Figma", 8000); await h.button(/^Push \d+ changes?$/); await h.text("Changed in ReRune meanwhile", 8000)
      await h.wait(400); await h.shot(); await h.button("Take ReRune text"); await h.text("Synced", 8000); await h.wait(400); await h.shot("resolved")
    },
  },
  "08-preview": { ...base, steps: async (h) => { await h.scanPage(); await h.tab("Preview"); await h.text("Show key names instead of text"); await h.button("Apply to page"); await h.text("Missing translations", 8000); await h.wait(300) } },
  // German is removed from the project in ReRune while its preview is on the canvas, first while Layers is shown (08b),
  // then while Preview stays open with German picked (08c: its language list loses the language it shows; CFP's Dropdown
  // throws on a value it has no option for, so the screen must swap it in the same render).
  "08b-preview-language-removed": {
    ...base,
    later: { project: WITHOUT_DE },
    steps: async (h) => {
      await h.scanPage(); await h.tab("Preview"); await h.text("Show key names instead of text"); await h.button("Apply to page"); await h.text("Missing translations", 8000)
      await h.wait(1000); await h.tab("Layers"); await h.text("Select all shown")
      await h.later(); await h.wait(1000); await h.tab("Preview"); await h.text("was removed from this project", 8000); await h.wait(300)
    },
  },
  "08c-preview-language-removed-open": {
    ...base,
    later: { project: WITHOUT_DE },
    steps: async (h) => {
      await h.scanPage(); await h.tab("Preview"); await h.text("Show key names instead of text"); await h.button("Apply to page"); await h.text("Missing translations", 8000)
      await h.later(); await h.text("was removed from this project", 8000); await h.wait(300)
    },
  },
  "09-qa-overflow": { ...base, steps: async (h) => { await h.scanPage(); await h.tab("QA"); await h.check("de"); await h.check("fr"); await h.button("Run overflow report"); await h.text(/issues? found/, 10000); await h.scrollTo("Overflow report") } },
  // German, picked for the report, is removed from the project in ReRune while QA is open.
  "09b-qa-language-removed": {
    ...base,
    later: { project: WITHOUT_DE },
    steps: async (h) => { await h.scanPage(); await h.tab("QA"); await h.check("de"); await h.check("fr"); await h.later(); await h.text("was removed from this project", 8000); await h.wait(300) },
  },
  "10-settings": { ...base, meta: { screenshots_enabled: true, screenshot_freshness: true }, steps: async (h) => { await h.tab("Settings"); await h.text("Key names"); await h.wait(300) } },
  "11-request-notice": {
    ...base,
    meta: { screenshots_enabled: true, screenshot_freshness: true },
    requests: [{ frame: "10:1", name: "Checkout" }, { frame: "20:1", name: "Cart" }],
    steps: async (h) => { await h.text("Update screenshots", 9000); await h.scanPage(); await h.wait(300) },
  },
  "12-empty": { ...base, nodes: [], steps: async (h) => { await h.text("No text layers in the selection.") ; await h.wait(200) } },
  "14-focus": {
    ...base,
    steps: async (h) => { await h.scanPage(); await h.tabTo((el) => el.classList.contains("rr-focus") && el.textContent.startsWith("Total")); await h.wait(150) },
    keepFocus: true,
  },
  "13-inspect": { ...base, editorType: "dev", sizes: ["inspect", "short"], steps: async (h) => { await h.text("Copy code", 9000); await h.wait(300) } },
  // The Dev Mode panel's sign-in and pairing in a short panel: they scroll from the top instead of losing it.
  "15-inspect-signin": { ...base, editorType: "dev", auth: null, settings: null, sizes: ["short"], steps: async (h) => { await h.text("Sign in with ReRune"); await h.wait(200) } },
  "16-inspect-pairing": { ...base, editorType: "dev", auth: null, settings: null, sizes: ["short"], steps: async (h) => { await h.button("Sign in with ReRune"); await h.text("Check that the code in your browser matches"); await h.wait(200) } },
}

// default: the Design window as it opens; min: its smallest size (DESIGN_UI_MIN_SIZE); listing: a shorter Design window
// for the Community carousel (scripts/listing-art.mjs); inspect and short: the Dev Mode inspect panel, which can be
// 300 px wide and very short.
export const SIZES = {
  default: { width: 400, height: 640 },
  min: { width: 360, height: 480 },
  listing: { width: 400, height: 560 },
  inspect: { width: 300, height: 480 },
  short: { width: 300, height: 200 },
}

function baseName(name, size) {
  const { width, height } = SIZES[size]
  return name + (size === "default" ? "" : "-" + width + "x" + height)
}

// `later`: the scenario's ReRune-side changes once h.later() ran.
function remoteKey(id, languagesWanted, source, later) {
  const [key, en, de, fr, max] = KEYS[id] ?? ["unknown_" + id.slice(-3), "?", null, null, null]
  const content = { en: later?.remote?.[id] ?? REMOTE_MAIN[id] ?? en, de, "de-AT": de, fr }
  return {
    id, key, type: "key", enabled: true, status: id === K(3) ? "modified" : "published", published: true, description: "", tags: [], max_length: max, placeholders: [],
    values: languagesWanted.map((lang) => {
      const value = content[lang]
      if (value === null || value === undefined) return { lang, present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }
      return { lang, present: true, resolved_lang: lang === "de-AT" ? "de" : lang, inherited: lang === "de-AT", variation_applied: false, content: { value }, length: value.length, exceeds_max_length: max !== null && value.length > max }
    }),
  }
}

async function mockApi(page, scenario, errors, live) {
  let polls = 0
  await page.route("**/*", async (route) => {
    try {
      await answer(route)
    } catch (error) {
      errors.push("mock: " + route.request().url() + " " + error.message)
      await route.abort().catch(() => {})
    }
  })
  async function answer(route) {
    const request = route.request()
    const url = request.url()
    if (!url.startsWith(API + "/")) {
      if (url.startsWith("http")) errors.push("aborted: " + url)
      return url.startsWith("http") ? route.abort() : route.continue()
    }
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS" }
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors })
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) })
    const path = new URL(url).pathname.replace(/^\/api/, "")
    const body = request.postData() ? (() => { try { return JSON.parse(request.postData()) } catch { return null } })() : null
    const now = Date.now()
    if (path === "/figma/meta") return json(200, { api_version: 1, max_image_bytes: 2097152, max_image_side: 4096, max_batch_size: 100, server_time: new Date().toISOString(), ...scenario.meta })
    if (path === "/figma/auth/sessions") return json(201, { session_id: "671e2a9f4c1d2b3a4f5e6d7c", code: "K7P4QX", poll_secret: "3f".repeat(32), approve_url: "https://rerune.io/figma/connect?code=K7P-4QX", expires_at: new Date(now + 582000).toISOString(), interval_seconds: 1 })
    if (path.endsWith("/poll")) {
      polls++
      if (!scenario.pollApproves || polls < 2) return json(200, { status: "pending", expires_at: new Date(now + 582000).toISOString(), interval_seconds: 1 })
      return json(200, { status: "approved", token: "rrf_" + "0b".repeat(32), token_id: "671e2b114c1d2b3a4f5e6d7d", token_expires_at: "2027-01-25T10:01:12Z", user: { id: "kc", email: user.email, first_name: "Ada", last_name: "Lovelace" } })
    }
    if (path === "/figma/auth/logout") return route.fulfill({ status: 204, headers: cors })
    if (path === "/figma/projects") return json(200, { user, projects })
    const later = live.later ? scenario.later : undefined
    if (path === "/figma/projects/" + P) return json(200, { ...(later?.project ?? project), key_count: 128, available_keys: 872, key_name_sample: ["checkout_title", "checkout_pay_button", "cart_empty_hint"] })
    if (path.endsWith("/keys/search")) return json(200, { items: [], next_cursor: null, has_more: false })
    if (path.endsWith("/keys/by-name")) return json(200, { keys: [], missing: body?.names ?? [], text_matches: [] })
    if (path.endsWith("/keys/resolve")) {
      return json(200, { source: body.source, variation_option: null, missing_key_ids: [], keys: body.key_ids.filter((id) => KEYS[id]).map((id) => remoteKey(id, body.languages, body.source, later)) })
    }
    if (path.endsWith("/push")) {
      // conflictOnPush: the keys of `later.remote` were edited in ReRune meanwhile, from this push on.
      const meanwhile = scenario.later?.conflictOnPush === true ? scenario.later.remote : {}
      if (scenario.later?.conflictOnPush === true) live.later = true
      const results = body.items.map((item) => item.op === "create"
        ? { client_ref: item.client_ref, status: "created", key_id: K(50), key: item.key, reason: null, message: null, current_text: null }
        : meanwhile[item.key_id] !== undefined
          ? { client_ref: item.client_ref, status: "conflict", key_id: item.key_id, key: KEYS[item.key_id]?.[0] ?? null, reason: "source_changed", message: null, current_text: meanwhile[item.key_id] }
          : { client_ref: item.client_ref, status: "updated", key_id: item.key_id, key: KEYS[item.key_id]?.[0] ?? null, reason: null, message: null, current_text: null })
      const count = (status) => results.filter((r) => r.status === status).length
      return json(200, { results, summary: { created: count("created"), updated: count("updated"), unchanged: 0, conflicts: count("conflict"), failed: 0 }, available_keys: 871 })
    }
    if (path.endsWith("/files") && request.method() === "PUT") return json(200, { file_key: settings.fileKey, file_name: "Chapter app", url: settings.fileUrl, link_count: 6, screenshot_count: 2, last_push_at: null, last_push_by: null, created_at: "2026-10-20T09:00:00Z", updated_at: "2026-10-20T09:00:00Z", outdated_screenshot_count: 0, refresh_requested_count: scenario.requests.length })
    if (path.endsWith("/files")) return json(200, { files: [] })
    if (path.endsWith("/links") && request.method() === "PUT") return json(200, { upserted: body?.upserts?.length ?? 0, removed: 0, rejected: [] })
    if (path.endsWith("/links")) return json(200, { links: [], next_cursor: null, has_more: false })
    if (path.endsWith("/screenshots") && request.method() === "GET") {
      const screenshots = scenario.requests.map((r, index) => ({ id: "6a5" + String(index).padStart(21, "0"), file_key: settings.fileKey, frame_id: r.frame, frame_name: r.name, page_id: "0:1", page_name: "Mobile", content_type: "image/png", width: 375, height: 812, size_bytes: 1000, boxes: [], image_url: null, image_url_expires_at: null, figma_url: null, created_at: "2026-10-20T09:00:00Z", updated_at: "2026-10-20T09:00:00Z", outdated_box_count: 2, refresh_requested_at: "2026-10-29T08:12:00Z", refresh_requested_by: { id: "u2", name: "Lena Schmidt" } }))
      return json(200, { screenshots, next_cursor: null, has_more: false })
    }
    errors.push("not mocked: " + request.method() + " " + path)
    return json(404, { message: "not mocked " + path })
  }
}

function helpers(page, ui, live) {
  const h = {
    shots: [],
    file: () => "",
    wait: (ms) => page.waitForTimeout(ms),
    text: (text, timeout = 6000) => ui.getByText(text, typeof text === "string" ? { exact: false } : undefined).first().waitFor({ timeout }),
    button: async (name) => { const b = ui.getByRole("button", { name }).first(); await b.waitFor({ timeout: 6000 }); await b.dispatchEvent("click") },
    link: async (name) => h.button(name),
    tab: async (name) => { await ui.getByRole("tab", { name }).dispatchEvent("click"); await page.waitForTimeout(150) },
    check: async (label) => { await ui.getByLabel(label, { exact: true }).check() },
    checkAll: async (label) => { for (const box of await ui.getByLabel(label, { exact: true }).all()) await box.check() },
    checkFirst: async (label) => { await ui.getByLabel(label, { exact: true }).first().check() },
    // ReRune's side changes (the scenario's `later`); the next round of background reads, when the window gets focus,
    // brings it.
    later: async () => {
      live.later = true
      await page.waitForTimeout(ATTENTION_MIN_MS + 500)
      await page.frames()[1].evaluate(() => window.dispatchEvent(new Event("focus")))
    },
    shot: async (suffix) => { await h.blur(); await page.screenshot({ path: h.file(suffix) }); h.shots.push(suffix ?? "") },
    blur: () => page.frames()[1].evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()),
    // Keyboard only: Tab until the predicate holds for the focused element (the focus ring is :focus-visible).
    tabTo: async (predicate) => {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab")
        if (await page.frames()[1].evaluate((source) => new Function("el", "return (" + source + ")(el)")(document.activeElement), predicate.toString())) return
      }
      throw new Error("focus never reached the target")
    },
    scanPage: async () => {
      await ui.getByText("Page", { exact: true }).first().dispatchEvent("click")
      await page.waitForTimeout(150)
      await ui.getByText("Pay now").first().waitFor({ timeout: 6000 })
      await page.waitForTimeout(250)
    },
    pending: async (nodeId, text, name) => {
      await ui.getByRole("button", { name: new RegExp("^" + text) }).first().dispatchEvent("click")
      await ui.getByText("Create new key").first().waitFor({ timeout: 6000 })
      const box = ui.locator('input[placeholder="key_name"]')
      await box.fill(name)
      await page.waitForTimeout(150)
      await h.button("Create on push")
      await ui.getByText("New key").first().waitFor({ timeout: 6000 })
    },
    scrollTo: async (text) => {
      await ui.getByText(text).first().evaluate((el) => el.scrollIntoView({ block: "start" }), null, { timeout: 6000 })
      await page.waitForTimeout(200)
    },
  }
  return h
}

// `runs`: { name, size, theme }[] (default: every scenario in its sizes, light and dark). Returns the checks.
export async function capture({ outDir, runs = allRuns(), browser = null }) {
  mkdirSync(outDir, { recursive: true })
  uiJs = readFileSync(ROOT + "build/ui.js", "utf8")
  const own = browser === null
  const chrome = browser ?? (await launchBrowser())
  const checks = []
  for (const run of runs) {
    let result = await captureOne(chrome, outDir, run)
    if (result.failed !== null) {
      result = await captureOne(chrome, outDir, run) // one retry: a step timing out under load
    }
    checks.push(result)
  }
  if (own) await chrome.close()
  return checks
}

export function allRuns(only = []) {
  const runs = []
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only.length > 0 && !only.some((prefix) => name.startsWith(prefix))) continue
    for (const size of scenario.sizes ?? ["default"]) {
      for (const theme of ["light", "dark"]) runs.push({ name, size, theme })
    }
  }
  return runs
}

async function captureOne(browser, outDir, { name, size, theme, file: fileName }) {
  const scenario = SCENARIOS[name]
  const { width, height } = SIZES[size]
  const file = fileName ?? baseName(name, size) + "-" + theme
  const reducedMotion = scenario.motion === true ? "no-preference" : "reduce"
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(process.env.HARNESS_SCALE ?? 2), colorScheme: theme, reducedMotion })
  // Layout shift in every frame (the plugin is the srcdoc iframe), summed without shifts right after input.
  await context.addInitScript(() => {
    window.__layoutShift = 0
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShift += entry.value }).observe({ type: "layout-shift", buffered: true })
    } catch {
      window.__layoutShift = null
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push("console: " + message.text().slice(0, 200)) })
  const live = { later: false }
  await mockApi(page, scenario, errors, live)
  const { steps, ...data } = scenario
  const host = mkdtempSync(tmpdir() + "/rerune-ui-harness-") + "/host.html"
  writeFileSync(host, hostHtml(theme, width, height, data))
  await page.goto(pathToFileURL(host).href)
  const ui = page.frameLocator("#ui")
  let failed = null
  const h = helpers(page, ui, live)
  // A file name like 06-push-review-b-light: the suffix goes before the theme.
  h.file = (suffix) => outDir + "/" + (fileName !== undefined ? fileName + (suffix ? "-" + suffix : "") : baseName(name, size) + (suffix ? "-" + suffix : "") + "-" + theme) + ".png"
  try {
    await steps(h)
  } catch (error) {
    failed = error.message.split("\n")[0]
  }
  await page.waitForTimeout(250)
  const frame = page.frames().find((f) => f !== page.mainFrame())
  const facts = await frame.evaluate(() => {
    // Horizontal scroll: a scroll container (overflow-x auto/scroll) or the document wider than its box.
    const scrollers = [...document.querySelectorAll("#create-figma-plugin *")].filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
    // Content above the top of a vertical scroll area that is scrolled to the top can never be scrolled to (centred
    // content taller than its area).
    const aboveTop = [...document.querySelectorAll("#create-figma-plugin *")]
      .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollTop === 0 && el.children.length > 0)
      .map((el) => ({ el, by: el.getBoundingClientRect().top - Math.min(...[...el.children].map((child) => child.getBoundingClientRect().top)) }))
      .filter((entry) => entry.by > 0.5)
      .map((entry) => (entry.el.className || entry.el.tagName) + " " + entry.by.toFixed(1) + "px")
    // Text contrast: each element with its own text against the first opaque background up the tree.
    const parse = (value) => {
      const rgb = value.match(/rgba?\(([^)]+)\)/)
      if (rgb) { const [r, g, b, a = 1] = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a } }
      const srgb = value.match(/color\(srgb ([^)]+)\)/)
      if (srgb) { const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: r * 255, g: g * 255, b: b * 255, a } }
      return null
    }
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
    const lum = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const background = (el) => {
      const layers = []
      for (let at = el; at; at = at.parentElement) {
        const color = parse(getComputedStyle(at).backgroundColor)
        if (color && color.a > 0) { layers.push(color); if (color.a >= 1) break }
      }
      return layers.reverse().reduce((acc, layer) => over(layer, acc), { r: 255, g: 255, b: 255, a: 1 })
    }
    const low = []
    for (const el of document.querySelectorAll("#create-figma-plugin *")) {
      const own = [...el.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim() !== "")
      // The word tile's amber is a ::before (brand ink on amber is 8.97:1, tokens.test.ts), which this scan can't see.
      if (!own || el.closest("[disabled], [aria-hidden=true]") || el.matches("input, textarea, .rr-tile")) continue
      const style = getComputedStyle(el)
      if (style.visibility === "hidden" || el.getClientRects().length === 0) continue
      let opacity = 1
      for (let at = el; at; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity)
      if (opacity < 0.99) continue // disabled controls (CFP and ours dim with opacity)
      const fg = parse(style.color)
      if (!fg) continue
      const bg = background(el)
      const value = ratio(over(fg, bg), bg)
      const size = parseFloat(style.fontSize)
      const large = size >= 18 || (size >= 14 && Number(style.fontWeight) >= 700)
      if (value < (large ? 3 : 4.5)) low.push(el.textContent.trim().slice(0, 40) + " " + value.toFixed(2))
    }
    return {
      fonts: { display: document.fonts.check('800 15px "ReRune Display"'), mono: document.fonts.check('500 11px "ReRune Mono"'), inter: document.fonts.check('400 11px "ReRune Inter"') },
      fontFaces: [...document.fonts].map((face) => face.family + " " + face.weight + " " + face.status),
      docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollers: scrollers.map((el) => (el.className || el.tagName) + " " + el.scrollWidth + ">" + el.clientWidth).slice(0, 5),
      lowContrast: low.slice(0, 12),
      aboveTop,
      layoutShift: window.__layoutShift === null ? null : Number(window.__layoutShift.toFixed(4)),
    }
  })
  if (h.shots.length === 0) {
    if (!scenario.keepFocus) await h.blur()
    await page.screenshot({ path: h.file() })
  }
  const notes = [failed ? " — " + failed : "", errors.length ? " errors=" + JSON.stringify(errors) : "", facts.scrollers.length || facts.docScroll ? " hscroll=" + JSON.stringify(facts.scrollers) : "", facts.aboveTop.length ? " above-top=" + JSON.stringify(facts.aboveTop) : "", facts.lowContrast.length ? " contrast=" + JSON.stringify(facts.lowContrast) : "", !facts.fonts.display || !facts.fonts.mono || !facts.fonts.inter ? " fonts=" + JSON.stringify(facts.fonts) : ""].join("")
  console.log((failed ? "FAIL " : "ok   ") + file + notes + (facts.layoutShift ? " cls=" + facts.layoutShift : ""))
  await context.close()
  rmSync(dirname(host), { recursive: true, force: true })
  return { file, failed, errors, ...facts }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [outDir, ...only] = process.argv.slice(2)
  if (outDir === undefined) {
    console.error("usage: node scripts/ui-harness.mjs <out dir> [scenario prefix …]")
    process.exit(2)
  }
  const checks = await capture({ outDir, runs: allRuns(only) })
  writeFileSync(outDir + "/checks.json", JSON.stringify(checks, null, 1))
  process.exit(checks.some((check) => check.failed !== null) ? 1 : 0)
}
