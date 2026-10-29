import { h } from "preact"
import { Mark } from "./mark"

// The dashboard's postage stamp (pg-stamp) at plugin scale: radial-gradient perforation around the mark in white on
// the brand ink window. Sign-in and Signed in use md, empty states sm. Decorative and fixed-size.

const STAMP_MARK = { sm: 20, md: 36 }

export function Stamp(props: { size: "sm" | "md" }) {
  return (
    <span class={"rr-stamp rr-stamp--" + props.size} aria-hidden="true">
      <span class="rr-stamp__art">
        <Mark size={STAMP_MARK[props.size]} />
      </span>
    </span>
  )
}
