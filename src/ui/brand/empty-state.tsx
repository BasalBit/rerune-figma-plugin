import { h, type ComponentChildren } from "preact"
import { Stamp } from "./stamp"

// An empty list or a list not scanned yet: a small stamp beside the hint (and a title when given), in place of an
// info note. The hint keeps its words.
export function EmptyState(props: { title?: string; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="rr-empty">
      <Stamp size="sm" />
      <div class="rr-empty__text">
        {props.title !== undefined && <div class="rr-empty__title">{props.title}</div>}
        <div class="rr-empty__hint">{props.children}</div>
        {props.action !== undefined && <div class="rr-empty__action">{props.action}</div>}
      </div>
    </div>
  )
}
