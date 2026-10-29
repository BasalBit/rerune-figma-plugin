import { Button, Text } from "@create-figma-plugin/ui"
import { h } from "preact"
import type { StoredAuth } from "../../shared/messages"
import { Stamp } from "../brand/stamp"
import { Small, styles } from "../components/ui"
import { fullName } from "../state/session"

// "Signed in as" (D34, §3.12): shown once after a successful sign-in, before the Project screen, so a phished
// approval is visible. Not me revokes the token (E7) and forgets it.

export interface SignedInScreenProps {
  auth: StoredAuth
  busy: boolean
  onContinue(): void
  onNotMe(): void
}

export function SignedInScreen(props: SignedInScreenProps) {
  const name = fullName(props.auth.user)
  return (
    <div style={styles.page}>
      <div class="rr-center" style={{ ...styles.body, gap: "8px" }}>
        <div style={{ ...styles.row, gap: "10px" }}>
          <Stamp size="sm" />
          <Text>Signed in as</Text>
        </div>
        <div style={{ fontSize: "16px", lineHeight: "22px", fontWeight: "600", overflowWrap: "anywhere", color: "var(--rr-ink)" }}>{props.auth.user.email}</div>
        {name !== "" && <Small muted>{name}</Small>}
        <Small muted>If this isn't your ReRune account, choose Not me. The plugin then signs out and forgets this sign-in.</Small>
      </div>
      <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
        <Button secondary disabled={props.busy} loading={props.busy} onClick={props.onNotMe}>
          Not me
        </Button>
        <Button disabled={props.busy} onClick={props.onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
