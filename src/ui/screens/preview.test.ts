/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import previewSource from "./preview.tsx?raw"

// A language or variation removed in ReRune while Preview shows it: the dropdowns get a value the project still has in
// the same render (CFP's Dropdown throws "Invalid value" on a value it has no option for), not only after the effect
// that switches the picked language runs.
describe("Preview after a language or variation is removed in ReRune", () => {
  it("computes the shown language and variation from the project in render", () => {
    expect(previewSource).toContain("const shownLang = keptLanguage(project, lang, prefs.lastLanguage).lang")
    expect(previewSource).toContain("const shownVariation = keptVariation(project, variation).variation")
  })

  it("gives both dropdowns and every request the shown values, never the raw state", () => {
    expect(previewSource).toContain("value={shownLang}")
    expect(previewSource).toContain("value={shownVariation ?? NO_VARIATION}")
    expect(previewSource).not.toMatch(/value=\{lang\}/)
    expect(previewSource).not.toMatch(/value=\{variation \?\? NO_VARIATION\}/)
    expect(previewSource).toContain("{ lang: shownLang, source, variationOptionId: shownVariation }")
    expect(previewSource).toContain("{ lang: shownLang, mode, variationOptionId: shownVariation }")
  })
})
