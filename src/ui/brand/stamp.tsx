import { h } from "preact"
import { Mark } from "./mark"

// The dashboard's logo stamp (PostageStamp src="/logo.png" tone="amber", as on its sign-in and /figma/connect pages) at
// plugin scale: amber radial-gradient perforation and art window, the mark in brand ink inside a brand ink frame.
// Sign-in uses md, Signed in and empty states sm. Decorative and fixed-size.

const STAMP_MARK = { sm: 19, md: 33 }

export function Stamp(props: { size: "sm" | "md" }) {
  return (
    <span class={"rr-stamp rr-stamp--" + props.size} aria-hidden="true">
      <span class="rr-stamp__art">
        <Mark size={STAMP_MARK[props.size]} />
      </span>
    </span>
  )
}
