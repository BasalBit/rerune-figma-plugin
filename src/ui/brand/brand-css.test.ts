import { describe, expect, it } from "vitest"
import { BRAND_CSS } from "./brand-css"
import { BRAND_TOKENS } from "./tokens"

describe("BRAND_CSS", () => {
  it("loads nothing from the network", () => {
    expect(BRAND_CSS).not.toMatch(/url\(|@import|https?:|@font-face/)
  })

  it("defines every token for light and Figma dark", () => {
    const [light, dark] = [BRAND_CSS.indexOf(":root{"), BRAND_CSS.indexOf(":root.figma-dark{")]
    expect(light).toBeGreaterThanOrEqual(0)
    expect(dark).toBeGreaterThan(light)
    for (const token of Object.keys(BRAND_TOKENS)) {
      expect(BRAND_CSS.split(token + ":").length - 1, token).toBeGreaterThanOrEqual(2)
    }
    // color-mix only inside @supports, after its plain fallback.
    expect(BRAND_CSS).toContain("--rr-wash:#4c402b;")
    expect(BRAND_CSS).toContain("@supports (background:color-mix(in srgb,red 50%,blue)){:root.figma-dark{--rr-wash:color-mix(")
    for (const line of BRAND_CSS.split("\n").filter((entry) => entry.includes("color-mix(in srgb,var("))) {
      expect(line.startsWith("@supports"), line).toBe(true)
    }
  })

  it("brings the focus ring back on plugin-owned controls, over CFP's outline: 0, clear of the footer when Tab scrolls", () => {
    expect(BRAND_CSS).toContain(".rr-focus:focus-visible{outline:2px solid var(--figma-color-border-selected-strong);outline-offset:1px}")
    expect(BRAND_CSS).toContain(".rr-focus{scroll-margin:4px}")
  })

  it("centres the sign-in and pairing screens without pushing them above the scroll area's top", () => {
    expect(BRAND_CSS).toContain(".rr-center{display:flex;flex-direction:column;justify-content:center;justify-content:safe center}")
  })

  it("tints chips and notes more in dark, and gives ReRune chips the key tag's paper and line", () => {
    expect(BRAND_CSS).toContain(".rr-tinted{background:color-mix(in srgb,var(--hue) 12%,var(--figma-color-bg))")
    expect(BRAND_CSS).toContain(".figma-dark .rr-tinted{background:color-mix(in srgb,var(--hue) 16%,var(--figma-color-bg))}")
    expect(BRAND_CSS).toContain(".rr-chip.rr-tone--rerune{background:var(--rr-key-bg);border-color:var(--rr-key-line)}")
  })

  it("draws the chips' shapes in CanvasText under forced colours", () => {
    expect(BRAND_CSS).toContain(".rr-glyph{forced-color-adjust:none;background:CanvasText}.rr-glyph--ring{background:none;border-color:CanvasText}}")
  })

  it("has no rules for widths the Design window can't have (its minimum is 360 px)", () => {
    expect(BRAND_CSS).not.toMatch(/max-width:3[0-5]\dpx/)
  })

  it("stops the only motion under reduced motion", () => {
    expect(BRAND_CSS.match(/animation:rr-/g)).toHaveLength(1)
    expect(BRAND_CSS).toContain("@media (prefers-reduced-motion:reduce){.rr-postmark{animation:none}}")
    expect(BRAND_CSS).not.toMatch(/transition/)
  })

  it("never sets amber as a text colour", () => {
    expect(BRAND_CSS).not.toMatch(/(^|[^-])color:var\(--rr-amber\)/m)
  })

  it("uses the bundled fonts by family name and gives CFP's UI font to ReRune Inter and its code font to ReRune Mono", () => {
    expect(BRAND_CSS).toContain('--font-family:"ReRune Inter",Inter,Helvetica,sans-serif;')
    expect(BRAND_CSS).toContain('--rr-font-display:"ReRune Display"')
    expect(BRAND_CSS).toContain('--rr-font-mono:"ReRune Mono"')
    expect(BRAND_CSS).toContain("html:root{")
    expect(BRAND_CSS).toContain("--font-family-code:var(--rr-font-mono)")
  })

  it("keeps the plain checkbox look of long lists", () => {
    expect(BRAND_CSS).toContain("input.rr-check{-webkit-appearance:checkbox;appearance:auto;")
    expect(BRAND_CSS).toContain("html,body,#create-figma-plugin{height:100%}")
  })
})
