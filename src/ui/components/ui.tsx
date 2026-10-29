import { Button, LoadingIndicator, Text } from "@create-figma-plugin/ui"
import { h, type ComponentChildren, type JSX } from "preact"
import type { ErrorGroup } from "../state/ops"
import { layerCount } from "../state/ops"
import { styles } from "./styles"

// Small presentational pieces shared by the Design-mode screens. Colours come from Figma's theme variables
// (themeColors: true), so light and dark mode follow the editor.

export type Tone = "neutral" | "good" | "info" | "warning" | "danger"

const TONE_COLORS: Record<Tone, { text: string; background: string; border: string }> = {
  neutral: { text: "var(--figma-color-text-secondary)", background: "var(--figma-color-bg-secondary)", border: "var(--figma-color-border)" },
  good: { text: "var(--figma-color-text-success)", background: "var(--figma-color-bg-success-tertiary)", border: "var(--figma-color-border-success)" },
  info: { text: "var(--figma-color-text-brand)", background: "var(--figma-color-bg-brand-tertiary)", border: "var(--figma-color-border-brand)" },
  warning: { text: "var(--figma-color-text-warning)", background: "var(--figma-color-bg-warning-tertiary)", border: "var(--figma-color-border-warning)" },
  danger: { text: "var(--figma-color-text-danger)", background: "var(--figma-color-bg-danger-tertiary)", border: "var(--figma-color-border-danger)" },
}

// The plugin fills the iframe; CFP's base CSS removes the native look of inputs, so the plain checkboxes used
// in long lists (cheaper than the CFP component) get it back through the rr-check class.
export const GLOBAL_CSS = [
  "html, body, #create-figma-plugin { height: 100%; }",
  "input.rr-check { -webkit-appearance: checkbox; appearance: auto; width: 12px; height: 12px; margin: 0; flex-shrink: 0; cursor: pointer; accent-color: var(--figma-color-bg-brand); }",
].join("\n")

export function GlobalStyle() {
  return <style>{GLOBAL_CSS}</style>
}

// `mixed`: partly ticked (a Select all over a list where only some rows are ticked); browsers show and announce it so.
export function CheckInput(props: { checked: boolean; onChange(): void; label: string; style?: JSX.CSSProperties; disabled?: boolean; mixed?: boolean }) {
  return (
    <input
      type="checkbox"
      class="rr-check"
      checked={props.checked}
      indeterminate={props.mixed}
      disabled={props.disabled}
      onChange={props.onChange}
      aria-label={props.label}
      style={props.disabled === true ? { cursor: "default", ...props.style } : props.style}
    />
  )
}

export { styles }

export function Note(props: { tone?: Tone; children: ComponentChildren; actions?: ComponentChildren }) {
  const colors = TONE_COLORS[props.tone ?? "info"]
  return (
    <div style={{ border: "1px solid " + colors.border, background: colors.background, borderRadius: "6px", padding: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ color: "var(--figma-color-text)", fontSize: "11px", lineHeight: "16px", overflowWrap: "anywhere" }}>{props.children}</div>
      {props.actions !== undefined && <div style={styles.wrapRow}>{props.actions}</div>}
    </div>
  )
}

export function Chip(props: { tone?: Tone; children: ComponentChildren; title?: string }) {
  const colors = TONE_COLORS[props.tone ?? "neutral"]
  return (
    <span
      title={props.title}
      style={{ color: colors.text, background: colors.background, borderRadius: "10px", padding: "0 6px", fontSize: "10px", lineHeight: "16px", whiteSpace: "nowrap", flexShrink: "0" }}
    >
      {props.children}
    </span>
  )
}

// `ariaLabel`: the accessible name when the visible label is the same on several buttons (it names what each acts on).
export function TextButton(props: { onClick(): void; children: ComponentChildren; disabled?: boolean; danger?: boolean; title?: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        background: "none",
        border: "none",
        padding: "0",
        cursor: props.disabled === true ? "default" : "pointer",
        color: props.danger === true ? "var(--figma-color-text-danger)" : "var(--figma-color-text-brand)",
        opacity: props.disabled === true ? "0.5" : "1",
        font: "inherit",
        fontSize: "11px",
        textAlign: "left",
      }}
    >
      {props.children}
    </button>
  )
}

export function SectionTitle(props: { children: ComponentChildren; style?: JSX.CSSProperties }) {
  return <div style={{ ...styles.sectionTitle, ...props.style }}>{props.children}</div>
}

export function Small(props: { children: ComponentChildren; muted?: boolean; style?: JSX.CSSProperties }) {
  return <div style={{ ...styles.small, ...(props.muted === true ? styles.muted : {}), ...props.style }}>{props.children}</div>
}

export function Loading(props: { label: string }) {
  return (
    <div style={{ ...styles.row, padding: "16px 0", justifyContent: "center" }}>
      <LoadingIndicator />
      <Text>{props.label}</Text>
    </div>
  )
}

export function ErrorNote(props: { message: string | null; onRetry?: () => void }) {
  if (props.message === null) {
    return null
  }
  return (
    <Note tone="danger" actions={props.onRetry !== undefined ? <TextButton onClick={props.onRetry}>Try again</TextButton> : undefined}>
      {props.message}
    </Note>
  )
}

// Node errors from op-results, one line per kind, with Select on canvas.
export function ErrorGroups(props: { groups: readonly ErrorGroup[]; onSelect(nodeIds: string[]): void }) {
  if (props.groups.length === 0) {
    return null
  }
  return (
    <div style={styles.tightStack}>
      {props.groups.map((group) => (
        <Note key={group.code + group.message} tone={group.warning ? "warning" : "danger"} actions={<TextButton onClick={() => props.onSelect(group.nodeIds)}>Select on canvas</TextButton>}>
          {layerCount(group.nodeIds.length)}: {group.message}
        </Note>
      ))}
    </div>
  )
}

export function Choice<T extends string>(props: { value: T | null; options: { value: T; label: string }[]; onChange(value: T): void; disabled?: boolean }) {
  return (
    <div style={styles.wrapRow}>
      {props.options.map((option) => {
        const active = option.value === props.value
        return (
          <button
            key={option.value}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            style={{
              border: "1px solid " + (active ? "var(--figma-color-border-brand-strong)" : "var(--figma-color-border)"),
              background: active ? "var(--figma-color-bg-brand-tertiary)" : "transparent",
              color: "var(--figma-color-text)",
              borderRadius: "4px",
              padding: "2px 8px",
              fontSize: "11px",
              lineHeight: "16px",
              cursor: props.disabled === true ? "default" : "pointer",
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Footer(props: { children: ComponentChildren }) {
  return <div style={styles.footer}>{props.children}</div>
}

export function BackButton(props: { onClick(): void; label?: string }) {
  return (
    <Button secondary onClick={props.onClick}>
      {props.label ?? "Back"}
    </Button>
  )
}

export function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many)
}

export function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}
