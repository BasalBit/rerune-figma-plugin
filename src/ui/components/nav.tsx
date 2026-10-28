import { h } from "preact"
import type { WorkspaceScreen } from "../state/navigation"
import { previewStatusText, type PreviewStatus } from "../state/preview"
import { waitText, type WorkTask } from "../state/work-lock"
import { styles, TextButton } from "./ui"

// Header of the workspace screens: project, selection count, tabs, and the preview status bar (§7.14).

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
      <div style={{ ...styles.row, padding: "8px 12px 4px" }}>
        <div style={{ ...styles.grow, fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={props.projectName}>
          {props.projectName}
        </div>
        <span style={{ ...styles.small, ...styles.muted }}>{props.selectionCount === 1 ? "1 selected" : props.selectionCount + " selected"}</span>
        <TextButton disabled={locked} onClick={props.onChangeProject}>
          Change
        </TextButton>
      </div>
      <div role="tablist" style={{ display: "flex", padding: "0 8px" }}>
        {TABS.map((tab) => {
          const active = tab.screen === props.active
          return (
            <button
              key={tab.screen}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={locked && !active}
              title={lockedBy !== null && !active ? waitText(lockedBy) : undefined}
              onClick={() => props.onOpen(tab.screen)}
              style={{
                background: "none",
                border: "none",
                borderBottom: "2px solid " + (active ? "var(--figma-color-border-brand-strong)" : "transparent"),
                color: active ? "var(--figma-color-text)" : "var(--figma-color-text-secondary)",
                fontWeight: active ? "600" : "400",
                padding: "6px 8px",
                cursor: locked && !active ? "default" : "pointer",
                opacity: locked && !active ? "0.5" : "1",
                font: "inherit",
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {props.previewStatus !== null && (
        <div style={{ ...styles.row, padding: "4px 12px", background: "var(--figma-color-bg-brand-tertiary)", fontSize: "11px" }}>
          <span style={styles.grow}>{previewStatusText(props.previewStatus)}</span>
          <TextButton disabled={props.resetDisabled === true} onClick={props.onResetPreview}>
            Reset
          </TextButton>
        </div>
      )}
    </div>
  )
}
