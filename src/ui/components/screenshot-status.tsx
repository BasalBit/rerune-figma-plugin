import { h } from "preact"
import { groupProblems, progressText, screenshotSummary, type ScreenshotRun } from "../state/screenshots"
import { Note, plural, SectionTitle, Small, styles, TextButton } from "./ui"

// A screenshot upload run (§7.16): progress with Stop, then the summary and the frames that weren't uploaded. Shown
// after a push or pull (Push) and after Update screenshots (the notices).

export type ShotsState = { kind: "running"; run: ScreenshotRun } | { kind: "done"; run: ScreenshotRun } | { kind: "unavailable"; message: string }

export function ScreenshotStatus(props: { state: ShotsState; stopping: boolean; onStop(): void; onSelect(nodeIds: string[]): void }) {
  const { state } = props
  if (state.kind === "unavailable") {
    return <Note tone="warning">Screenshots weren't uploaded: {state.message}</Note>
  }
  if (state.kind === "running") {
    return (
      <Note
        tone="info"
        actions={
          <TextButton disabled={props.stopping} onClick={props.onStop}>
            {props.stopping ? "Stopping…" : "Stop"}
          </TextButton>
        }
      >
        {progressText(state.run)}
      </Note>
    )
  }
  const summary = screenshotSummary(state.run)
  if (summary === null && state.run.problems.length === 0) {
    return null
  }
  return (
    <div style={styles.stack}>
      {summary !== null && <Note tone={summary.tone}>{summary.message}</Note>}
      <ScreenshotProblems run={state.run} onSelect={props.onSelect} />
    </div>
  )
}

// The frames a run did not upload, one card per reason, with the frames to select.
export function ScreenshotProblems(props: { run: ScreenshotRun; onSelect(nodeIds: string[]): void }) {
  const groups = groupProblems(props.run.problems)
  if (groups.length === 0) {
    return null
  }
  return (
    <div style={styles.stack}>
      <SectionTitle>Screenshots not uploaded ({props.run.problems.length})</SectionTitle>
      {groups.map((group) => (
        <div key={group.message} style={styles.card}>
          <div style={styles.wrapRow}>
            <Small style={styles.grow}>{group.message}</Small>
            <TextButton onClick={() => props.onSelect(group.frameIds)}>{plural(group.frameIds.length, "frame", "frames")}</TextButton>
          </div>
          <Small muted>{group.frameNames.join(", ")}</Small>
        </div>
      ))}
    </div>
  )
}
