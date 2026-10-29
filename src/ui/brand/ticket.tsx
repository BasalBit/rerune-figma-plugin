import { h, type ComponentChildren } from "preact"

// The dashboard's ticket (pg-ticket) at plugin scale, as /figma/connect frames the pairing code: an ink outline with
// a hard offset shadow, and a stub under a dashed edge with two notches.
export function Ticket(props: { children: ComponentChildren; stub?: ComponentChildren }) {
  return (
    <div class="rr-ticket">
      <div class="rr-ticket__main">{props.children}</div>
      {props.stub !== undefined && <div class="rr-ticket__stub">{props.stub}</div>}
    </div>
  )
}
