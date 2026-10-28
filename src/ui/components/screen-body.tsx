import { h, type ComponentChildren, type JSX } from "preact"
import { styles } from "./styles"

// The scrolling body of a workspace tab (Layers, Push, Preview, QA, Settings). The workspace notices (file link,
// settings offer, layers edited during preview, leftover previews, the result banner) come first inside it, in
// normal flow: they take their own space above the tab's content and scroll with it. Drawn on a band between the tab
// bar and the tab, they did not scroll, so the tab's content scrolled out of sight right under them (Preview's
// Language label looked covered by the file-link notice) and, in a small window, they left the tab little room.

export const NOTICES_GAP = "8px"

export function hasNotices(notices: ComponentChildren): boolean {
  return notices !== null && notices !== undefined && notices !== false && !(Array.isArray(notices) && notices.length === 0)
}

export function ScreenBody(props: { notices: ComponentChildren; stack?: boolean; style?: JSX.CSSProperties; children?: ComponentChildren }) {
  const stack = props.stack === true
  return (
    <div style={{ ...styles.body, ...(stack ? styles.stack : {}), ...props.style }}>
      {hasNotices(props.notices) && <div style={{ flexShrink: "0", ...(stack ? {} : { marginBottom: NOTICES_GAP }) }}>{props.notices}</div>}
      {props.children}
    </div>
  )
}
