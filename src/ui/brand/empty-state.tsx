import { h, type ComponentChildren } from "preact"
import { Stamp } from "./stamp"

// An empty list or a list not scanned yet: a small stamp beside the hint, in place of an info note. The hint keeps its
// words.
export function EmptyState(props: { children: ComponentChildren }) {
  return (
    <div class="rr-empty">
      <Stamp size="sm" />
      <div class="rr-empty__hint">{props.children}</div>
    </div>
  )
}
