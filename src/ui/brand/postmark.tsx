import { h } from "preact"

// The dashboard's postmark (Postmark) beside a clean result (Note postmark): the two rings with a dotted ring in place
// of the ring text (illegible below 72 px), and the cancellation waves running across the inner ring, strokes heavier
// than the 120 px original so they hold at 44 px. It stamps in once (180 ms), not under reduced motion.

const WAVE =
  "M0 8c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6M0 20c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6M0 32c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6"

// 32 dots on the ring between the circles (its circumference is 2π·44.5 ≈ 279.6).
const DOTS = "0 " + ((2 * Math.PI * 44.5) / 32).toFixed(3)

export function Postmark() {
  return (
    <svg class="rr-postmark" viewBox="0 0 120 120" width="44" height="44" aria-hidden="true" focusable="false">
      <circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" stroke-width="3.2" />
      <circle cx="60" cy="60" r="44.5" fill="none" stroke="currentColor" stroke-width="4.4" stroke-linecap="round" stroke-dasharray={DOTS} />
      <circle cx="60" cy="60" r="33" fill="none" stroke="currentColor" stroke-width="2.4" />
      <svg x="15" y="45" width="90" height="30" viewBox="0 0 120 40" overflow="visible">
        <path d={WAVE} fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" />
      </svg>
    </svg>
  )
}
