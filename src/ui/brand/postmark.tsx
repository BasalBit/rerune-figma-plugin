import { h } from "preact"

// The dashboard's postmark (Postmark) beside a clean result (Note postmark): rings and the wave, no ring text
// (illegible below 72 px), strokes heavier than the 120 px original so they hold at 44 px. It stamps in once
// (180 ms), not under reduced motion, and hides below 320 px.

const WAVE =
  "M0 8c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6M0 20c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6M0 32c10 0 10-6 20-6s10 6 20 6 10-6 20-6 10 6 20 6 10-6 20-6 10 6 20 6"

export function Postmark() {
  return (
    <svg class="rr-postmark" viewBox="0 0 120 120" width="44" height="44" aria-hidden="true" focusable="false">
      <circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" stroke-width="3.2" />
      <circle cx="60" cy="60" r="33" fill="none" stroke="currentColor" stroke-width="2.4" />
      <svg x="30" y="47" width="60" height="26" viewBox="0 0 120 40" overflow="visible">
        <path d={WAVE} fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      </svg>
    </svg>
  )
}
