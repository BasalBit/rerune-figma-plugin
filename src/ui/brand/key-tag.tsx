import { Fragment, h } from "preact"

// A translation key's name as the dashboard's ‹ key › tag (pg-key): ReRune Mono between amber brackets. Data only:
// the plugin shows a key tag only for a real key name, never as decoration. Long names wrap after their separators.

export const KEY_BREAK_AFTER = /([._\-/:])/

// The name cut after each separator (".", "_", "-", "/", ":"), so a <wbr> can follow each piece.
export function keyNameParts(name: string): string[] {
  const parts: string[] = []
  let current = ""
  for (const piece of name.split(KEY_BREAK_AFTER)) {
    current += piece
    if (KEY_BREAK_AFTER.test(piece) && piece.length === 1) {
      parts.push(current)
      current = ""
    }
  }
  if (current !== "") {
    parts.push(current)
  }
  return parts
}

// `pending`: a key that Create on push will make (dashed border). `large`: Dev Mode's 12 px.
export function KeyTag(props: { name: string; pending?: boolean; large?: boolean }) {
  const classes = "rr-key" + (props.pending === true ? " rr-key--pending" : "") + (props.large === true ? " rr-key--lg" : "")
  const parts = keyNameParts(props.name)
  return (
    <span class={classes} title={props.name} translate={false}>
      <span class="rr-key__name">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {part}
            {index < parts.length - 1 && <wbr />}
          </Fragment>
        ))}
      </span>
    </span>
  )
}
