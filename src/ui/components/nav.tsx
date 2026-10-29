import { h } from "preact"
import { BrandMark } from "../brand/mark"
import type { WorkspaceScreen } from "../state/navigation"
import { previewStatusText, type PreviewStatus } from "../state/preview"
import { waitText, type WorkTask } from "../state/work-lock"
import { styles, TextButton } from "./ui"

// Header of the workspace screens: the ReRune mark and wordmark, project, Change, selection count, tabs (the active
// one on ReRune's amber rule), and the preview status bar on the ReRune wash (§7.14). Below 340 px the wordmark and
// the selection count make room for the project name.

const TABS: { screen: WorkspaceScreen; label: string }[] = [
  { screen: "layers", label: "Layers" },
  { screen: "push", label: "Push" },
  { screen: "preview", label: "Preview" },
  { screen: "qa", label: "QA" },
  { screen: "settings", label: "Settings" },
]

export interface NavProps {
  active: WorkspaceScreen
  projectName: string
  selectionCount: number
  previewStatus: PreviewStatus | null
  resetDisabled?: boolean
  // The canvas task holding the work lock (push or pull, preview apply, pseudo-localization, overflow report,
  // language copies): tabs and Change wait for it, and a closed tab's title says what for.
  lockedBy?: WorkTask | null
  onOpen(screen: WorkspaceScreen): void
  onChangeProject(): void
  onResetPreview(): void
}

export function Nav(props: NavProps) {
  const lockedBy = props.lockedBy ?? null
  const locked = lockedBy !== null
  return (
    <div style={{ borderBottom: "1px solid var(--figma-color-border)" }}>
      <div class="rr-header">
        <BrandMark />
        <span class="rr-divider" aria-hidden="true" />
        <div class="rr-project" title={props.projectName}>
          {props.projectName}
        </div>
        <TextButton disabled={locked} onClick={props.onChangeProject}>
          Change
        </TextButton>
        <span class="rr-narrow-hide" style={{ ...styles.small, ...styles.muted, whiteSpace: "nowrap" }}>
          {props.selectionCount === 1 ? "1 selected" : props.selectionCount + " selected"}
        </span>
      </div>
      <div role="tablist" class="rr-tabs">
        {TABS.map((tab) => {
          const active = tab.screen === props.active
          return (
            <button
              key={tab.screen}
              type="button"
              role="tab"
              class="rr-tab rr-focus"
              aria-selected={active}
              disabled={locked && !active}
              title={lockedBy !== null && !active ? waitText(lockedBy) : undefined}
              onClick={() => props.onOpen(tab.screen)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {props.previewStatus !== null && (
        <div class="rr-band">
          <span style={styles.grow}>{previewStatusText(props.previewStatus)}</span>
          <TextButton disabled={props.resetDisabled === true} onClick={props.onResetPreview}>
            Reset
          </TextButton>
        </div>
      )}
    </div>
  )
}
