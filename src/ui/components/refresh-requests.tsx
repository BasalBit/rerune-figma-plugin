import { Button } from "@create-figma-plugin/ui"
import { h } from "preact"
import { groupErrors } from "../state/ops"
import {
  framesLine,
  NO_REQUESTS_LEFT,
  previewsLine,
  REFRESH_BUSY,
  refreshErrorLine,
  refreshLines,
  refreshNotice,
  refreshStepText,
  REQUEST_REMOVED,
  type MissingFrame,
  type RefreshOutcome,
  type RefreshState,
} from "../state/refresh-requests"
import { screenshotSummary } from "../state/screenshots"
import { ScreenshotProblems, ScreenshotStatus } from "./screenshot-status"
import { ErrorGroups, Note, Small, styles, TextButton } from "./ui"

// Screenshot freshness (SF6, contract §6.4) in the workspace notices, first on every tab: the frames ReRune asks new
// screenshots of with Update screenshots and Not now, the run's progress (Stop while it uploads), and its results.

export interface RefreshRequestsNoteProps {
  state: RefreshState
  busy: boolean                      // a canvas task, reset, scan, page sync or Layers action runs
  resetting: boolean
  onRun(): void
  onNotNow(): void
  onStop(): void
  onResetPreviews(nodeIds: string[]): void
  onRemove(screenshotId: string): void
  onRemoveAll(): void
  onDismiss(): void
  onSelect(nodeIds: string[]): void
}

const DANGER_TEXT = { color: "var(--figma-color-text-danger)" }

// Whether the notes show anything (the app shows the notices only when one of them does).
export function refreshNotesShown(state: RefreshState): boolean {
  return state.running !== null || state.outcome !== null || refreshNotice(state.requests, state.dismissed) !== null
}

export function RefreshRequestsNote(props: RefreshRequestsNoteProps) {
  const { state } = props
  const notice = refreshNotice(state.requests, state.dismissed)
  if (state.running !== null) {
    const step = state.running
    if (step.step === "uploading") {
      return <ScreenshotStatus state={{ kind: "running", run: step.run }} stopping={state.stopping} onStop={props.onStop} onSelect={props.onSelect} />
    }
    return <Note tone="info">{refreshStepText(step)}</Note>
  }
  if (state.outcome === null && notice === null) {
    return null
  }
  return (
    <div style={styles.tightStack}>
      {state.outcome !== null && <Outcome outcome={state.outcome} props={props} />}
      {notice !== null && (
        <Note
          tone="info"
          actions={
            <div style={styles.wrapRow}>
              <Button disabled={props.busy} onClick={props.onRun}>
                Update screenshots
              </Button>
              <TextButton onClick={props.onNotNow}>Not now</TextButton>
            </div>
          }
        >
          <div>{notice.message}</div>
          {notice.requestedBy !== null && <div>{notice.requestedBy}</div>}
          <div style={styles.muted}>{notice.frames}</div>
          {props.busy && <div style={styles.muted}>{REFRESH_BUSY}</div>}
        </Note>
      )}
    </div>
  )
}

function Outcome(props: { outcome: RefreshOutcome; props: RefreshRequestsNoteProps }) {
  const { outcome } = props
  const note = props.props
  const dismiss = <TextButton onClick={note.onDismiss}>Dismiss</TextButton>
  switch (outcome.kind) {
    case "none":
      return (
        <Note tone="info" actions={dismiss}>
          {NO_REQUESTS_LEFT}
        </Note>
      )
    case "error":
      return (
        <Note tone="warning" actions={dismiss}>
          {refreshErrorLine(outcome.message)}
        </Note>
      )
    case "previews":
      return (
        <Note
          tone="warning"
          actions={
            <div style={styles.row}>
              <TextButton disabled={note.resetting || note.busy} onClick={() => note.onResetPreviews(outcome.nodeIds)}>
                Reset previews
              </TextButton>
              {dismiss}
            </div>
          }
        >
          {previewsLine(outcome.nodeIds.length)}
        </Note>
      )
    case "done":
      return <DoneOutcome outcome={outcome} props={note} />
  }
}

// One line each, in the order of contract §6.4 step 7 (the hidden requested frames after the missing ones); the
// frames not uploaded, the missing and hidden frames (with Remove request) and the write errors follow with their
// actions.
function DoneOutcome(props: { outcome: Extract<RefreshOutcome, { kind: "done" }>; props: RefreshRequestsNoteProps }) {
  const { outcome } = props
  const note = props.props
  const lines = refreshLines(outcome)
  const run = outcome.shots !== null && outcome.shots.kind === "done" ? outcome.shots.run : null
  const summary = run === null ? null : screenshotSummary(run)
  const shotsLine = outcome.shots === null ? null : outcome.shots.kind === "unavailable" ? "Screenshots weren't uploaded: " + outcome.shots.message : summary?.message ?? null
  const messages = [lines.pulled, shotsLine, lines.figmaSide, lines.readonly, lines.outdated, lines.missing, lines.hidden].filter((line): line is string => line !== null)
  const left = outcome.missing.filter((frame) => frame.removal !== "removed")
  const warning =
    lines.figmaSide !== null ||
    lines.readonly !== null ||
    lines.outdated !== null ||
    lines.missing !== null ||
    lines.hidden !== null ||
    outcome.errors.length > 0 ||
    outcome.shots?.kind === "unavailable" ||
    summary?.tone === "warning"
  const removeDisabled = note.state.removing
  return (
    <div style={styles.stack}>
      <Note
        tone={warning ? "warning" : "good"}
        actions={
          <div style={styles.row}>
            {left.length > 1 && (
              <TextButton disabled={removeDisabled} onClick={note.onRemoveAll}>
                Remove all
              </TextButton>
            )}
            <TextButton onClick={note.onDismiss}>Dismiss</TextButton>
          </div>
        }
      >
        {messages.length === 0 ? "No screenshots were uploaded." : messages.map((message) => <div key={message}>{message}</div>)}
      </Note>
      {run !== null && <ScreenshotProblems run={run} onSelect={note.onSelect} />}
      {outcome.missing.map((frame) => (
        <MissingFrameCard key={frame.screenshotId} frame={frame} disabled={removeDisabled} onRemove={() => note.onRemove(frame.screenshotId)} />
      ))}
      <ErrorGroups groups={groupErrors(outcome.errors)} onSelect={note.onSelect} />
    </div>
  )
}

// One card per frame, each with its own Remove request: the button's accessible name says which frame it is for.
function MissingFrameCard(props: { frame: MissingFrame; disabled: boolean; onRemove(): void }) {
  const { frame } = props
  const label = framesLine([frame])
  return (
    <div style={styles.card}>
      <div style={styles.wrapRow}>
        <Small style={styles.grow}>{label}</Small>
        {frame.removal === "removed" ? (
          <Small muted>{REQUEST_REMOVED}</Small>
        ) : (
          <TextButton
            disabled={props.disabled || frame.removal === "removing"}
            ariaLabel={(frame.removal === "removing" ? "Removing request for " : "Remove request for ") + label}
            onClick={props.onRemove}
          >
            {frame.removal === "removing" ? "Removing…" : "Remove request"}
          </TextButton>
        )}
      </div>
      {frame.error !== null && <Small style={DANGER_TEXT}>{frame.error}</Small>}
    </div>
  )
}
