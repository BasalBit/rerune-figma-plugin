import { describe, expect, it } from "vitest"
import { BADGE_LABELS, STATE_LABELS, STATE_TONES } from "../state/layers"
import { BADGE_TONE, LAYER_CHIP_TONE, TONE_GLYPH, toneClasses } from "./status"

describe("chip tones", () => {
  it("maps every sync state, keeping its meaning and telling ReRune-side changes apart", () => {
    expect(Object.keys(LAYER_CHIP_TONE).sort()).toEqual(Object.keys(STATE_LABELS).sort())
    for (const [state, tone] of Object.entries(LAYER_CHIP_TONE)) {
      const before = STATE_TONES[state as keyof typeof STATE_TONES]
      expect(tone === before || (before === "info" && tone === "rerune"), state).toBe(true)
    }
    expect(LAYER_CHIP_TONE.changed_in_rerune).toBe("rerune")
    expect(LAYER_CHIP_TONE.changed_in_figma).toBe("info")
  })

  it("maps every badge", () => {
    expect(Object.keys(BADGE_TONE).sort()).toEqual(Object.keys(BADGE_LABELS).sort())
    expect(BADGE_TONE.missing_font).toBe("danger")
    expect(BADGE_TONE.pending).toBe("rerune")
  })

  it("gives each tone a shape, so meaning never rests on colour alone", () => {
    expect(TONE_GLYPH).toEqual({ good: "dot", info: "dot", rerune: "dot", warning: "triangle", danger: "diamond", neutral: "ring" })
    expect(toneClasses("warning")).toBe("rr-tone--warning rr-tinted")
    expect(toneClasses("rerune")).toBe("rr-tone--rerune")
    expect(toneClasses("neutral")).toBe("rr-tone--neutral")
  })
})
