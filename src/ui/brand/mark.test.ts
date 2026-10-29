import { describe, expect, it } from "vitest"
import markSvg from "../../../assets/brand/rerune-mark.svg?raw"
import smallSvg from "../../../assets/brand/rerune-mark-small.svg?raw"
import componentSource from "./mark.tsx?raw"
import { MARK_MAX_SIZE, MARK_MIN_SIZE, MARK_PATH_SMALL, MARK_VIEWBOX } from "./mark"
import stampSource from "./stamp.tsx?raw"
import refreshSource from "../components/refresh-requests.tsx?raw"

function points(path: string): [number, number][] {
  // Every command here is absolute M/L/A/Z; the last two numbers of each M, L and A are its end point.
  return [...path.matchAll(/[MLA]([^MLAZ]+)/g)].map((match) => {
    const numbers = match[1].trim().split(/\s+/).map(Number)
    return [numbers[numbers.length - 2], numbers[numbers.length - 1]]
  })
}

const pathOf = (svg: string) => svg.match(/ d="([^"]+)"/)?.[1] ?? ""

describe("the ReRune mark", () => {
  it("is the heavier cut of the traced logo, as committed in assets/brand", () => {
    expect(pathOf(smallSvg)).toBe(MARK_PATH_SMALL)
    expect(markSvg).toContain('viewBox="0 0 500 500"')
    expect(smallSvg).toContain('viewBox="0 0 500 500"')
    // Same outer outline: the two cuts start the same way (stem, top, bowl, leg).
    expect(pathOf(markSvg).slice(0, 160)).toBe(MARK_PATH_SMALL.slice(0, 160))
  })

  it("stays inside its view box, with room around the glyph", () => {
    for (const path of [pathOf(markSvg), MARK_PATH_SMALL]) {
      for (const [x, y] of points(path)) {
        expect(x).toBeGreaterThanOrEqual(MARK_VIEWBOX.x + 9)
        expect(x).toBeLessThanOrEqual(MARK_VIEWBOX.x + MARK_VIEWBOX.width - 9)
        expect(y).toBeGreaterThanOrEqual(MARK_VIEWBOX.y + 9)
        expect(y).toBeLessThanOrEqual(MARK_VIEWBOX.y + MARK_VIEWBOX.height - 9)
      }
    }
  })

  it("is drawn only at the sizes the heavier cut holds (18-47 px)", () => {
    const literal = [...[componentSource, refreshSource].join("\n").matchAll(/<Mark size=\{(\d+)\}/g)].map((match) => Number(match[1]))
    const stamps = stampSource.match(/STAMP_MARK = \{ sm: (\d+), md: (\d+) \}/)
    expect(stamps).not.toBeNull()
    expect(componentSource).toContain("<Mark size={MARK_MIN_SIZE} />")
    for (const size of [...literal, Number(stamps?.[1]), Number(stamps?.[2]), MARK_MIN_SIZE]) {
      expect(size).toBeGreaterThanOrEqual(MARK_MIN_SIZE)
      expect(size).toBeLessThanOrEqual(MARK_MAX_SIZE)
    }
  })
})
