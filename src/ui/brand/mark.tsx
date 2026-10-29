import { h } from "preact"

// The ReRune mark: the outlined R with the rune-like inner stroke of the dashboard's public/logo.png, traced as one
// path. assets/brand/rerune-mark.svg is the faithful master (binary IoU 0.9916 against logo.png at 500 px), for art
// of 48 px and more (the Community listing). Its outline strokes are 3.6% of the letter's height and turn into grey
// haze below that, and the plugin draws the mark at 18-36 px, so the plugin carries only the heavier cut
// (assets/brand/rerune-mark-small.svg: strokes thickened inward, the same outline and gaps). Below 18 px there is no
// mark, only the wordmark.

export const MARK_PATH_SMALL =
  "M138.1 372.85L138.1 127.25A15.9 15.9 0 0 1 154 111.35L247.3 111.35A103.4 103.4 0 0 1 335.93 161.5A99.4 99.4 0 0 1 295.31 301.53L361.87 388.75L287.25 388.75A23.6 23.6 0 0 1 268.32 379.25L221.14 315.96A4 4 0 0 1 220.35 313.57L220.35 285.44L284.23 371.15L326.3 371.15L266.61 292.93A81.8 81.8 0 0 0 320.85 170.56A85.8 85.8 0 0 0 247.3 128.95L155.7 128.95L155.7 371.15L183.4 371.15L183.4 301.05L168.2 313.92L168.2 291.89A20.3 20.3 0 0 1 175.38 276.39L183.4 269.61L183.4 144.3L205.08 144.3L271.95 200.91A16.5 16.5 0 0 1 271.95 226.09L207.4 280.74L207.4 372.85A15.9 15.9 0 0 1 191.5 388.75L154 388.75A15.9 15.9 0 0 1 138.1 372.85ZM207.4 177.71L207.4 249.29L249.68 213.5Z"

// The glyph spans 138–362 × 111–389 in the 500-unit frame of logo.png; the view box keeps 10 units around it.
export const MARK_VIEWBOX = { x: 128, y: 101, width: 244, height: 298 }
export const MARK_MIN_SIZE = 18
export const MARK_MAX_SIZE = 47

// `size`: the height in px, 18 to 47 (the width follows the view box). Decorative: the wordmark or the context names it.
export function Mark(props: { size: number }) {
  const box = MARK_VIEWBOX
  return (
    <svg
      viewBox={box.x + " " + box.y + " " + box.width + " " + box.height}
      width={String(Math.round((props.size * box.width * 100) / box.height) / 100)}
      height={String(props.size)}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "none" }}
    >
      <path fill="currentColor" d={MARK_PATH_SMALL} />
    </svg>
  )
}

// The dashboard's `pg-brand--sm` at Figma's scale: a 22 px framed tile with the mark, and the Bricolage wordmark.
export function BrandMark(props: { wordmark?: boolean }) {
  return (
    <span class="rr-brand">
      <span class="rr-brand__tile" aria-hidden="true">
        <Mark size={MARK_MIN_SIZE} />
      </span>
      {props.wordmark !== false && <span class="rr-wordmark">ReRune</span>}
    </span>
  )
}
