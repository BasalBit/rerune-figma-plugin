import { describe, expect, it } from "vitest"
import { BADGE_LABELS, STATE_LABELS, STATE_TONES } from "../state/layers"
import { BADGE_TONE, TONE_GLYPH, toneClasses, type Tone } from "./status"

const screens = import.meta.glob<string>("../screens/*.tsx", { query: "?raw", import: "default", eager: true })

describe("chip tones", () => {
  it("maps every sync state, telling the ReRune side of a change from the Figma side", () => {
    expect(Object.keys(STATE_TONES).sort()).toEqual(Object.keys(STATE_LABELS).sort())
    const tones: Tone[] = Object.values(STATE_TONES)
    expect(tones.length).toBe(Object.keys(STATE_LABELS).length)
    expect(STATE_TONES.changed_in_rerune).toBe("rerune")
    expect(STATE_TONES.changed_in_figma).toBe("info")
  })

  it("maps every badge", () => {
    expect(Object.keys(BADGE_TONE).sort()).toEqual(Object.keys(BADGE_LABELS).sort())
    expect(BADGE_TONE.missing_font).toBe("danger")
    expect(BADGE_TONE.pending).toBe("rerune")
  })

  it("gives warnings, errors and neutral chips their own shape; good, info and ReRune share the dot and differ by label", () => {
    expect(TONE_GLYPH).toEqual({ good: "dot", info: "dot", rerune: "dot", warning: "triangle", danger: "diamond", neutral: "ring" })
    expect(toneClasses("warning")).toBe("rr-tone--warning rr-tinted")
    expect(toneClasses("rerune")).toBe("rr-tone--rerune")
    expect(toneClasses("neutral")).toBe("rr-tone--neutral")
  })
})

describe("changes made in ReRune on the screens", () => {
  it("are ReRune notes (amber wash) or hints (amber dot): new changes on Push, a language removed on Preview and QA", () => {
    const push = screens["../screens/push.tsx"]
    const stale = push.slice(push.indexOf("{stale && ("), push.indexOf("{REMOTE_CHANGED_NOTE}"))
    expect(stale).toContain('tone="rerune"')
    const preview = screens["../screens/preview.tsx"]
    expect(preview).toContain('{removedPreview !== null && <Note tone="rerune">{removedPreview}</Note>}')
    for (const source of [preview, screens["../screens/qa.tsx"]]) {
      expect(source).toContain("{pickNote !== null && <ReRuneHint>{pickNote}</ReRuneHint>}")
    }
  })
})

describe("key names on the screens", () => {
  it("are key tags, never plain mono text", () => {
    const plainMono = /styles\.mono[^>]*>\s*\{[\w?.]*\b(keyName|key)\}/
    expect("<span style={{ ...styles.grow, ...styles.mono }}>{conflict.keyName}</span>").toMatch(plainMono)
    expect(Object.keys(screens).length).toBeGreaterThan(5)
    for (const [file, source] of Object.entries(screens)) {
      // A key name in a styles.mono element, e.g. <span style={{ ...styles.mono }}>{conflict.keyName}</span>.
      expect(source, file).not.toMatch(plainMono)
    }
  })
})
