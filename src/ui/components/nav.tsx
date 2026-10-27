import { h } from "preact"
import type { WorkspaceScreen } from "../state/navigation"
import type { PreviewStatus } from "../state/preview"
import { sourceLabel } from "../state/preview"
import { styles, TextButton } from "./ui"

// Header of the workspace screens: project, selection count, tabs, and the preview status bar (§7.14).

const TABS: { screen: WorkspaceScreen; label: string }[] = [
  { screen: "layers", label: "Layers" },
  { screen: "push", label: "Push" },
  { screen: "preview", label: "Preview" },
  { screen: "settings", label: "Settings" },
]

export interface NavProps {
  active: WorkspaceScreen
  projectName: string
  selectionCount: number
  previewStatus: PreviewStatus | null
  onOpen(screen: WorkspaceScreen): void
  onChangeProject(): void
  onResetPreview(): void
}

export function Nav(props: NavProps) {
  return (
    <div style={{ borderBottom: "1px solid var(--figma-color-border)" }}>
      <div style={{ ...styles.row, padding: "8px 12px 4px" }}>
        <div style={{ ...styles.grow, fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={props.projectName}>
          {props.projectName}
        </div>
        <span style={{ ...styles.small, ...styles.muted }}>{props.selectionCount === 1 ? "1 selected" : props.selectionCount + " selected"}</span>
        <TextButton onClick={props.onChangeProject}>Change</TextButton>
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
              onClick={() => props.onOpen(tab.screen)}
              style={{
                background: "none",
                border: "none",
                borderBottom: "2px solid " + (active ? "var(--figma-color-border-brand-strong)" : "transparent"),
                color: active ? "var(--figma-color-text)" : "var(--figma-color-text-secondary)",
                fontWeight: active ? "600" : "400",
                padding: "6px 8px",
                cursor: "pointer",
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
          <span style={styles.grow}>
            {props.previewStatus.mixed
              ? "Previewing several languages on " + props.previewStatus.count + " layers"
              : "Previewing " + props.previewStatus.lang + " (" + sourceLabel(props.previewStatus.source) + ") on " + props.previewStatus.count + " layers"}
          </span>
          <TextButton onClick={props.onResetPreview}>Reset</TextButton>
        </div>
      )}
    </div>
  )
}
