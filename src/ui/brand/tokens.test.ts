import { describe, expect, it } from "vitest"
import { BRAND_TOKENS, COLOR_MIX_FALLBACK, CONTRAST_PAIRS, contrastOf, FONT_TOKENS, resolveColor, tint, TINT_PERCENT, toHex, TONE_HUES, type Theme } from "./tokens"

// Every colour pair the brand layer draws passes WCAG 2.x (4.5:1 text, 3:1 icons and lines)
// in Figma light and dark, with Figma's variables as Create Figma Plugin 4.0.3 snapshots them.

const THEMES: Theme[] = ["light", "dark"]

describe("brand tokens", () => {
  it.each(THEMES.flatMap((theme) => CONTRAST_PAIRS.filter((pair) => pair.themes === undefined || pair.themes.includes(theme)).map((pair) => [theme, pair.name, pair] as const)))("%s: %s", (theme, _name, pair) => {
    expect(contrastOf(pair, theme)).toBeGreaterThanOrEqual(pair.min)
  })

  it("fixes the pairs that failed before the brand layer", () => {
    // Muted text was Figma's text-secondary (3.98:1 on white), links Figma blue (4.23:1), the dark warning tint 2.20:1.
    expect(contrastOf({ fg: "var(--figma-color-text-secondary)", bg: "var(--figma-color-bg)" }, "light")).toBeLessThan(4.5)
    expect(contrastOf({ fg: "var(--rr-muted)", bg: "var(--figma-color-bg)" }, "light")).toBeGreaterThan(6)
    expect(contrastOf({ fg: "var(--rr-muted)", bg: "var(--figma-color-bg-secondary)" }, "light")).toBeGreaterThan(5.8)
    expect(contrastOf({ fg: "var(--figma-color-text-brand)", bg: "var(--figma-color-bg)" }, "light")).toBeLessThan(4.5)
    expect(contrastOf({ fg: "var(--rr-ink)", bg: "var(--figma-color-bg)" }, "light")).toBeGreaterThan(17)
  })

  it("converts the dashboard's role tokens", () => {
    expect(BRAND_TOKENS["--rr-ink"]).toEqual({ light: "#0f1729", dark: "#edf2f7" })
    expect(BRAND_TOKENS["--rr-amber"]).toEqual({ light: "#f6a823", dark: "#f6a823" })
    expect(BRAND_TOKENS["--rr-accent"].light).toBe("#c26f0a")
    expect(BRAND_TOKENS["--rr-brand-ink"]).toEqual({ light: "#0f1729", dark: "#0f1729" })
    // Muted text is a neutral grey (Figma's greys sit beside it), not the dashboard's slate --ink-3.
    expect(BRAND_TOKENS["--rr-muted"].light).toBe("#5f5f5f")
    expect(Object.keys(BRAND_TOKENS)).toHaveLength(12)
  })

  it("mixes like the browser (color-mix in srgb) and gives every color-mix token a matching fallback", () => {
    expect(TINT_PERCENT).toEqual({ light: 12, dark: 16 })
    expect(toHex(resolveColor(tint("#f6a823", TINT_PERCENT.dark), "dark"))).toBe("#4c402b")
    expect(toHex(resolveColor("color-mix(in srgb, #000000 50%, #ffffff)", "light"))).toBe("#808080")
    for (const [token, fallback] of Object.entries(COLOR_MIX_FALLBACK)) {
      for (const theme of THEMES) {
        const value = BRAND_TOKENS[token as keyof typeof BRAND_TOKENS][theme]
        expect(toHex(resolveColor(value, theme)), token + " " + theme).toBe(fallback?.[theme])
      }
    }
  })

  it("keeps amber out of text and glyphs: plain amber on white is under 3:1, so light mode draws them in the darker accent", () => {
    expect(contrastOf({ fg: "var(--rr-amber)", bg: "var(--figma-color-bg)" }, "light")).toBeLessThan(3)
    expect(contrastOf({ fg: "var(--rr-accent)", bg: "var(--figma-color-bg)" }, "light")).toBeGreaterThanOrEqual(3)
    expect(Object.keys(TONE_HUES)).toEqual(["good", "info", "warning", "danger", "rerune"])
  })

  it("puts the bundled Inter first and an installed Inter right after it", () => {
    expect(FONT_TOKENS["--font-family"]).toBe('"ReRune Inter",Inter,Helvetica,sans-serif')
  })

  it("refuses colours it can't resolve", () => {
    expect(() => resolveColor("var(--nope)", "light")).toThrow("Unknown colour variable --nope")
    expect(() => resolveColor("hsl(1 2% 3%)", "light")).toThrow("Unsupported colour")
  })
})
