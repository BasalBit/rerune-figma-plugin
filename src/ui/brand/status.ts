import type { SyncState } from "../../shared/sync-state"
import { STATE_TONES, type Badge } from "../state/layers"

// The tones of the plugin's chips and notes. "rerune" (amber on the ReRune wash) marks ReRune-side states; "info"
// (Figma blue) the Figma side. The rest are Figma's semantic hues, and neutral.
export type Tone = "neutral" | "good" | "info" | "warning" | "danger" | "rerune"

// Layer chips: state/layers.ts keeps one "info" for both sides of a change; the brand tells them apart.
export const LAYER_CHIP_TONE: Record<SyncState, Tone> = { ...STATE_TONES, changed_in_rerune: "rerune" }

export const BADGE_TONE: Record<Badge, Tone> = {
  missing_font: "danger",
  mixed_styles: "neutral",
  variable: "neutral",
  component_property: "neutral",
  preview: "rerune",
  instance: "neutral",
  pending: "rerune",
}

// A glyph next to each chip's label, so meaning never rests on colour alone.
export type Glyph = "dot" | "triangle" | "diamond" | "ring"

export const TONE_GLYPH: Record<Tone, Glyph> = {
  good: "dot",
  info: "dot",
  rerune: "dot",
  warning: "triangle",
  danger: "diamond",
  neutral: "ring",
}

// The classes of a chip or note in a tone (brand-css.ts): Figma's hues are tinted, ReRune's state is the amber wash.
export function toneClasses(tone: Tone): string {
  return "rr-tone--" + tone + (tone === "good" || tone === "info" || tone === "warning" || tone === "danger" ? " rr-tinted" : "")
}
