// ReRune brand tokens for the plugin, in Figma light and dark (themeColors: true puts figma-light or figma-dark on
// <html> and Figma's --figma-color-* variables on :root). The values are the dashboard's role tokens
// (components/global.css), converted from HSL; surfaces, muted text and the dark ticket shadow stay neutral like
// Figma's. Data only, so node tests can check every pair the UI uses for contrast (tokens.test.ts) and brand-css.ts can
// turn them into CSS.

export type Theme = "light" | "dark"

export interface ThemedValue {
  light: string
  dark: string
}

// --rr-*: what each one is for is in brand-css.ts. Values may refer to Figma's variables (var(--figma-color-…)).
export const BRAND_TOKENS = {
  "--rr-ink": { light: "#0f1729", dark: "#edf2f7" }, // dashboard --ink: wordmark, headings, links, pairing code, mark
  "--rr-ink-2": { light: "#333e57", dark: "#becada" }, // --ink-2: key tag text
  // Muted text and field labels: a neutral grey beside Figma's own (its text-secondary is 3.98:1 on white), Figma's
  // text-secondary in dark.
  "--rr-muted": { light: "#5f5f5f", dark: "var(--figma-color-text-secondary)" },
  "--rr-accent": { light: "#c26f0a", dark: "#f9b639" }, // --amber-lo: key brackets, ReRune glyphs (dots)
  // --amber: fills, borders, the tab bar and link underlines (decoration beside a bold tab or ink link text), never text
  "--rr-amber": { light: "#f6a823", dark: "#f6a823" },
  "--rr-wash": { light: "#fff7eb", dark: "color-mix(in srgb, #f6a823 16%, var(--figma-color-bg))" }, // --amber-wash
  "--rr-key-bg": { light: "#ffffff", dark: "var(--figma-color-bg-secondary)" }, // --paper-hi: key tag
  "--rr-key-line": { light: "#d0d6e2", dark: "#4d4d4d" }, // --line: key tag border, ticket stub
  "--rr-mark-bg": { light: "#ffffff", dark: "#161d2c" }, // --paper-hi: mark tile
  // --hard: ticket offset shadow; in dark a shade darker than Figma's panel (the dashboard's slate slab reads blue there)
  "--rr-hard": { light: "#0f1729", dark: "#1e1e1e" },
  "--rr-postmark": { light: "#0f1729", dark: "#b1bfd3" }, // --postmark
  "--rr-brand-ink": { light: "#0f1729", dark: "#0f1729" }, // --brand-ink: the mark and frame on the amber stamp, text on amber
} as const satisfies Record<string, ThemedValue>

export type BrandToken = keyof typeof BRAND_TOKENS

// Fallbacks for browsers without color-mix (each color-mix declaration is preceded by its fallback).
export const COLOR_MIX_FALLBACK: Partial<Record<BrandToken, ThemedValue>> = {
  "--rr-wash": { light: "#fff7eb", dark: "#4c402b" },
}

// "ReRune Inter" is the bundled Latin subset (fonts.ts); characters outside it come from an installed Inter, then
// Helvetica, so a designer's full Inter is never hidden by the subset.
export const FONT_TOKENS = {
  "--font-family": '"ReRune Inter",Inter,Helvetica,sans-serif',
  "--rr-font-display": '"ReRune Display","Arial Narrow","ReRune Inter",Inter,system-ui,sans-serif',
  "--rr-font-mono": '"ReRune Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
} as const

// Figma's own values, as Create Figma Plugin 4.0.3 snapshots them (lib/css/theme.css), for the contrast checks.
// In Figma desktop the live variables apply; chip and note tints follow them through color-mix.
export const FIGMA_SNAPSHOT: Record<Theme, Record<string, string>> = {
  light: {
    "--figma-color-bg": "#ffffff",
    "--figma-color-bg-secondary": "#f5f5f5",
    "--figma-color-border": "#e6e6e6",
    "--figma-color-text": "rgba(0, 0, 0, 0.9)",
    "--figma-color-text-secondary": "rgba(0, 0, 0, 0.5)",
    "--figma-color-text-brand": "#007be5",
    "--figma-color-text-success": "#009951",
    "--figma-color-text-warning": "#b86200",
    "--figma-color-text-danger": "#dc3412",
    "--figma-color-border-selected-strong": "#007be5",
  },
  dark: {
    "--figma-color-bg": "#2c2c2c",
    "--figma-color-bg-secondary": "#383838",
    "--figma-color-border": "#444444",
    "--figma-color-text": "rgba(255, 255, 255, 1)",
    "--figma-color-text-secondary": "rgba(255, 255, 255, 0.7)",
    "--figma-color-text-brand": "#7cc4f8",
    "--figma-color-text-success": "#79d297",
    "--figma-color-text-warning": "#f7d15f",
    "--figma-color-text-danger": "#fca397",
    "--figma-color-border-selected-strong": "#7cc4f8",
  },
}

// The tones of chips and notes: Figma's semantic hues, and ReRune amber for ReRune-side states.
export const TONE_HUES = {
  good: "var(--figma-color-text-success)",
  info: "var(--figma-color-text-brand)",
  warning: "var(--figma-color-text-warning)",
  danger: "var(--figma-color-text-danger)",
  rerune: "var(--rr-accent)",
} as const

// How much of a tone's hue tints a chip or note: more in dark, where 12% of a hue over Figma's grey turns muddy.
export const TINT_PERCENT: Record<Theme, number> = { light: 12, dark: 16 }
export const TINT_BORDER_PERCENT = 45

export function tint(hue: string, percent: number): string {
  return "color-mix(in srgb, " + hue + " " + percent + "%, var(--figma-color-bg))"
}

export interface ContrastPair {
  name: string
  fg: string
  bg: string
  min: number // 4.5 for text, 3 for large text, icons and lines
  themes?: Theme[] // both when left out
}

const BG = "var(--figma-color-bg)"
const BG2 = "var(--figma-color-bg-secondary)"
const TEXT = "var(--figma-color-text)"

const THEMES: Theme[] = ["light", "dark"]
const HUE_TONES = ["good", "info", "warning", "danger"] as const

// A pair on a tone's tint, once per theme (the tint differs).
function onTints(name: (tone: string) => string, fg: (tone: (typeof HUE_TONES)[number]) => string, min: number): ContrastPair[] {
  return THEMES.flatMap((theme) => HUE_TONES.map((tone) => ({ name: name(tone), fg: fg(tone), bg: tint(TONE_HUES[tone], TINT_PERCENT[theme]), min, themes: [theme] })))
}

// Every foreground/background pair the brand layer draws, with the WCAG 2.x minimum it needs.
export const CONTRAST_PAIRS: ContrastPair[] = [
  { name: "ink on bg (wordmark, headings, links, pairing code)", fg: "var(--rr-ink)", bg: BG, min: 4.5 },
  { name: "body text on bg", fg: TEXT, bg: BG, min: 4.5 },
  { name: "muted on bg", fg: "var(--rr-muted)", bg: BG, min: 4.5 },
  { name: "muted on bg-secondary (neutral chip, code blocks)", fg: "var(--rr-muted)", bg: BG2, min: 4.5 },
  { name: "key tag text", fg: "var(--rr-ink-2)", bg: "var(--rr-key-bg)", min: 4.5 },
  ...onTints((tone) => "chip and note text on the " + tone + " tint", () => TEXT, 4.5),
  { name: "text on the ReRune wash (ReRune notes, preview band)", fg: TEXT, bg: "var(--rr-wash)", min: 4.5 },
  { name: "ReRune chip text (on the key tag's paper)", fg: TEXT, bg: "var(--rr-key-bg)", min: 4.5 },
  { name: "muted on the ReRune wash", fg: "var(--rr-muted)", bg: "var(--rr-wash)", min: 4.5 },
  { name: "danger text on bg", fg: "var(--figma-color-text-danger)", bg: BG, min: 4.5 },
  { name: "key brackets on the key tag", fg: "var(--rr-accent)", bg: "var(--rr-key-bg)", min: 3 },
  // In light mode the amber tab bar and link underline are decoration (about 2:1): the active tab is also bold and in
  // Figma's text colour, and a link is ink text.
  { name: "tab bar and link underline on bg", fg: "var(--rr-amber)", bg: BG, min: 3, themes: ["dark"] },
  { name: "focus ring on bg", fg: "var(--figma-color-border-selected-strong)", bg: BG, min: 3 },
  ...onTints((tone) => "chip glyph on the " + tone + " tint", (tone) => TONE_HUES[tone], 3),
  { name: "ReRune chip glyph on the key tag's paper", fg: "var(--rr-accent)", bg: "var(--rr-key-bg)", min: 3 },
  { name: "ReRune glyph on the wash (preview band)", fg: "var(--rr-accent)", bg: "var(--rr-wash)", min: 3 },
  { name: "mark on its tile", fg: "var(--rr-ink)", bg: "var(--rr-mark-bg)", min: 3 },
  { name: "mark tile border on bg", fg: "var(--rr-ink)", bg: BG, min: 3 },
  { name: "brand ink mark on the amber stamp", fg: "var(--rr-brand-ink)", bg: "var(--rr-amber)", min: 3 },
  // The stamp is decorative; in light mode amber on white (about 2:1) is edged by its perforation and drop shadow.
  { name: "amber stamp on bg", fg: "var(--rr-amber)", bg: BG, min: 3, themes: ["dark"] },
  { name: "brand ink on amber (word tile)", fg: "var(--rr-brand-ink)", bg: "var(--rr-amber)", min: 4.5 },
]

// ---- colour maths (WCAG 2.x relative luminance, sRGB color-mix, alpha compositing) ----

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function splitArgs(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of text) {
    if (char === "(") depth++
    if (char === ")") depth--
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return parts
}

// Resolves a CSS colour expression (hex, rgb(a), var() of a brand token or Figma variable, color-mix in srgb) for a theme.
export function resolveColor(expression: string, theme: Theme): Rgba {
  const value = expression.trim()
  const variable = value.match(/^var\((--[\w-]+)\)$/)
  if (variable !== null) {
    const name = variable[1]
    const token = (BRAND_TOKENS as Record<string, ThemedValue>)[name]
    const source = token !== undefined ? token[theme] : FIGMA_SNAPSHOT[theme][name]
    if (source === undefined) {
      throw new Error("Unknown colour variable " + name)
    }
    return resolveColor(source, theme)
  }
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1]
    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: 1 }
  }
  const rgb = value.match(/^rgba?\((.*)\)$/)
  if (rgb !== null) {
    const [r, g, b, a] = splitArgs(rgb[1]).map(Number)
    return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a }
  }
  const mix = value.match(/^color-mix\(in srgb,(.*)\)$/)
  if (mix !== null) {
    const [first, second] = splitArgs(mix[1])
    const amount = first.match(/^(.*)\s+([\d.]+)%$/)
    if (amount === null) {
      throw new Error("Unsupported color-mix " + value)
    }
    const p = Number(amount[2]) / 100
    const a = resolveColor(amount[1], theme)
    const b = resolveColor(second, theme)
    const alpha = a.a * p + b.a * (1 - p)
    const channel = (x: number, y: number) => (alpha === 0 ? 0 : (x * a.a * p + y * b.a * (1 - p)) / alpha)
    return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha }
  }
  throw new Error("Unsupported colour " + value)
}

export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  const channel = (x: number, y: number) => (x * top.a + y * bottom.a * (1 - top.a)) / a
  return { r: channel(top.r, bottom.r), g: channel(top.g, bottom.g), b: channel(top.b, bottom.b), a }
}

function luminance(color: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

// The contrast ratio of a pair, both composited over the theme's background as the plugin draws them.
export function contrastOf(pair: Pick<ContrastPair, "fg" | "bg">, theme: Theme): number {
  const ground = resolveColor("var(--figma-color-bg)", theme)
  const bg = composite(resolveColor(pair.bg, theme), ground)
  const fg = composite(resolveColor(pair.fg, theme), bg)
  const [light, dark] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

export function toHex(color: Rgba): string {
  return "#" + [color.r, color.g, color.b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")
}
