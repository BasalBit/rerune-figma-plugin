import { Button, Text, VerticalSpace } from "@create-figma-plugin/ui"
import { h } from "preact"
import { Note, Small, styles, TextButton } from "../components/ui"

// Sign in (§7.8): proper sign-in through the dashboard (pairing, §3), never a pasted API key. Also the Dev Mode
// inspect panel's sign-in (§7.17), with its own description and Diagnostics only in development builds.

export const DESIGN_DESCRIPTION = "Link Figma text to ReRune translation keys, push copy as drafts and preview every language."

export interface SignInScreenProps {
  notice: string | null
  version: string
  description?: string
  onSignIn(): void
  onCreateAccount(): void
  onDiagnostics?: () => void
}

export function SignInScreen(props: SignInScreenProps) {
  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, display: "flex", flexDirection: "column", justifyContent: "center", gap: "12px" }}>
        {props.notice !== null && <Note tone="warning">{props.notice}</Note>}
        <div style={{ fontSize: "20px", fontWeight: "700" }}>ReRune</div>
        <Text>{props.description ?? DESIGN_DESCRIPTION}</Text>
        <VerticalSpace space="small" />
        <Button fullWidth onClick={props.onSignIn}>
          Sign in with ReRune
        </Button>
        <Small muted>Requires a ReRune account. Designers join free on every plan.</Small>
        <TextButton onClick={props.onCreateAccount}>Create an account</TextButton>
      </div>
      <div style={{ ...styles.row, padding: "8px 12px", justifyContent: "space-between" }}>
        <Small muted>Version {props.version}</Small>
        {props.onDiagnostics !== undefined && <TextButton onClick={props.onDiagnostics}>Diagnostics</TextButton>}
      </div>
    </div>
  )
}
