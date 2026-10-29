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
    expect(BRAND_CSS).toContain("--rr-wash:#443b2b;")
    expect(BRAND_CSS).toContain("@supports (background:color-mix(in srgb,red 50%,blue)){:root.figma-dark{--rr-wash:color-mix(")
    for (const line of BRAND_CSS.split("\n").filter((entry) => entry.includes("color-mix(in srgb,var("))) {
      expect(line.startsWith("@supports"), line).toBe(true)
    }
  })

  it("brings the focus ring back on plugin-owned controls, over CFP's outline: 0", () => {
    expect(BRAND_CSS).toContain(".rr-focus:focus-visible{outline:2px solid var(--figma-color-border-selected-strong);outline-offset:1px}")
  })

  it("stops the only motion under reduced motion", () => {
    expect(BRAND_CSS.match(/animation:rr-/g)).toHaveLength(1)
    expect(BRAND_CSS).toContain("@media (prefers-reduced-motion:reduce){.rr-postmark{animation:none}}")
    expect(BRAND_CSS).not.toMatch(/transition/)
  })

  it("never sets amber as a text colour", () => {
    expect(BRAND_CSS).not.toMatch(/(^|[^-])color:var\(--rr-amber\)/m)
  })

  it("uses the bundled fonts by family name and gives CFP's code font to ReRune Mono", () => {
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
