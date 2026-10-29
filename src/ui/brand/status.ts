import type { Badge } from "../state/layers"

// The tones of the plugin's chips and notes. "rerune" (ReRune amber) marks ReRune-side states, "info" (Figma blue) the
// Figma side (the states' tones are STATE_TONES in state/layers.ts). The rest are Figma's semantic hues, and neutral.
export type Tone = "neutral" | "good" | "info" | "warning" | "danger" | "rerune"

export const BADGE_TONE: Record<Badge, Tone> = {
  missing_font: "danger",
  mixed_styles: "neutral",
  variable: "neutral",
  component_property: "neutral",
  preview: "rerune",
  instance: "neutral",
  pending: "rerune",
}

// A glyph next to each chip's label: warnings and errors get their own shape, neutral a ring. Good, info and ReRune share
// the dot and are told apart by their labels, so meaning never rests on colour alone.
export type Glyph = "dot" | "triangle" | "diamond" | "ring"

export const TONE_GLYPH: Record<Tone, Glyph> = {
  good: "dot",
  info: "dot",
  rerune: "dot",
  warning: "triangle",
  danger: "diamond",
  neutral: "ring",
}

// The classes of a chip or note in a tone (brand-css.ts): Figma's hues are tinted; ReRune's notes have the amber wash,
// its chips the key tag's paper with an amber dot.
export function toneClasses(tone: Tone): string {
  return "rr-tone--" + tone + (tone === "good" || tone === "info" || tone === "warning" || tone === "danger" ? " rr-tinted" : "")
}
