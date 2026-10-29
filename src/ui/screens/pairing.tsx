import { Button } from "@create-figma-plugin/ui"
import { Fragment, h } from "preact"
import { useEffect, useState } from "preact/hooks"
import { Ticket } from "../brand/ticket"
import { Loading, Note, Small, styles } from "../components/ui"
import { formatCountdown, secondsLeft, type PairingState } from "../state/pairing"

// Pairing (§3.12, §7.8): the code, "Check that the code in your browser matches", Open browser again, Cancel,
// the countdown and the polling status. The poll secret and token are never shown. The code sits on the ticket of
// the /figma/connect page ("Pairing code", the code, the hint), the countdown and status on its stub.

export interface PairingScreenProps {
  state: PairingState
  onCancel(): void
  onReopen(): void
  onRestart(): void
}

const STATUS_TEXT = {
  polling: "Waiting for you to confirm in the browser…",
  reconnecting: "Can't reach ReRune right now. Retrying…",
  rate_limited: "ReRune asked the plugin to slow down. Retrying shortly…",
} as const

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function PairingScreen(props: PairingScreenProps) {
  const state = props.state
  const now = useNow(state.kind === "waiting")

  if (state.kind === "idle" || state.kind === "starting") {
    return (
      <div style={styles.page}>
        <div style={styles.body}>
          <Loading label="Starting sign-in…" />
        </div>
      </div>
    )
  }

  if (state.kind === "failed") {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.body, ...styles.stack, justifyContent: "center" }}>
          <Note tone={state.reason === "denied" ? "warning" : "danger"}>{state.message}</Note>
          <Button fullWidth onClick={props.onRestart}>
            Start again
          </Button>
          <Button fullWidth secondary onClick={props.onCancel}>
            Back
          </Button>
        </div>
      </div>
    )
  }

  if (state.kind !== "waiting") {
    return null
  }

  const left = secondsLeft(state.deadline, now)
  return (
    <div style={styles.page}>
      <div style={{ ...styles.body, ...styles.stack, justifyContent: "center" }}>
        <Ticket
          stub={
            <Fragment>
              <Small muted>Code expires in {formatCountdown(left)}</Small>
              <Small>{STATUS_TEXT[state.status]}</Small>
            </Fragment>
          }
        >
          <div class="rr-label" aria-hidden="true">
            Pairing code
          </div>
          <div class="rr-pairing-code" aria-label="Pairing code" translate={false}>
            {state.code}
          </div>
          <div style={{ fontSize: "12px", lineHeight: "16px" }}>Check that the code in your browser matches</div>
        </Ticket>
        <Small muted style={{ textAlign: "center" }}>
          After you confirm in the browser, come back to Figma.
        </Small>
        {state.urlWarning !== null && <Note tone="warning">{state.urlWarning}</Note>}
      </div>
      <div style={{ ...styles.footer, justifyContent: "flex-end" }}>
        <Button secondary onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={props.onReopen}>Open browser again</Button>
      </div>
    </div>
  )
}
