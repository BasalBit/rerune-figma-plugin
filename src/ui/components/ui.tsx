import { Button, LoadingIndicator, Text } from "@create-figma-plugin/ui"
import { h, type ComponentChildren, type JSX } from "preact"
import { BRAND_CSS } from "../brand/brand-css"
import { Postmark } from "../brand/postmark"
import { TONE_GLYPH, toneClasses, type Tone } from "../brand/status"
import type { ErrorGroup } from "../state/ops"
import { layerCount } from "../state/ops"
import { styles } from "./styles"

// Small presentational pieces shared by the Design-mode screens. Surfaces and semantic hues come from Figma's theme
// variables (themeColors: true), so light and dark mode follow the editor; the ReRune layer (type, links, chips,
// notes, key tags) comes from one stylesheet, BRAND_CSS (src/ui/brand).

export type { Tone }

export function GlobalStyle() {
  return <style>{BRAND_CSS}</style>
}

// `mixed`: partly ticked (a Select all over a list where only some rows are ticked); browsers show and announce it so.
export function CheckInput(props: { checked: boolean; onChange(): void; label: string; style?: JSX.CSSProperties; disabled?: boolean; mixed?: boolean }) {
  return (
    <input
      type="checkbox"
      class="rr-check rr-focus"
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

// `icon`: a glyph before the text (the ReRune mark on ReRune's own requests). `postmark`: the postmark of a clean
// result beside the text (its room is reserved, so nothing moves when it stamps in).
export function Note(props: { tone?: Tone; children: ComponentChildren; actions?: ComponentChildren; icon?: ComponentChildren; postmark?: boolean }) {
  return (
    <div class={"rr-note " + toneClasses(props.tone ?? "info") + (props.postmark === true ? " rr-postmarked" : "")}>
      {props.icon !== undefined && (
        <span class="rr-note__icon" aria-hidden="true">
          {props.icon}
        </span>
      )}
      <div class="rr-note__main">
        <div class="rr-note__body">{props.children}</div>
        {props.actions !== undefined && <div style={styles.wrapRow}>{props.actions}</div>}
      </div>
      {props.postmark === true && <Postmark />}
    </div>
  )
}

export function Chip(props: { tone?: Tone; children: ComponentChildren; title?: string }) {
  const tone = props.tone ?? "neutral"
  return (
    <span title={props.title} class={"rr-chip " + toneClasses(tone)}>
      <i class={"rr-glyph rr-glyph--" + TONE_GLYPH[tone]} aria-hidden="true" />
      {props.children}
    </span>
  )
}

// `ariaLabel`: the accessible name when the visible label is the same on several buttons (it names what each acts on).
export function TextButton(props: { onClick(): void; children: ComponentChildren; disabled?: boolean; danger?: boolean; title?: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      class={"rr-link rr-focus" + (props.danger === true ? " rr-link--danger" : "")}
      title={props.title}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

// A section heading: the dashboard's mono-cap label with a short amber bar, a level-2 heading for screen readers.
// Field labels above a control stay Figma's (Small muted).
export function SectionTitle(props: { children: ComponentChildren; style?: JSX.CSSProperties }) {
  return (
    <div class="rr-eyebrow" role="heading" aria-level={2} style={props.style}>
      {props.children}
    </div>
  )
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
            class="rr-focus"
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
