import type { JSX } from "preact"

// The inline styles shared by the Design-mode screens. Kept apart from ui.tsx, which imports the Create Figma Plugin
// components (and their CSS), so layout pieces like ScreenBody can be checked in the node test environment.

export const styles = {
  page: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0" } as JSX.CSSProperties,
  body: { flex: "1", overflowY: "auto", padding: "12px", minHeight: "0" } as JSX.CSSProperties,
  footer: { borderTop: "1px solid var(--figma-color-border)", padding: "8px 12px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } as JSX.CSSProperties,
  row: { display: "flex", gap: "8px", alignItems: "center" } as JSX.CSSProperties,
  wrapRow: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } as JSX.CSSProperties,
  grow: { flex: "1", minWidth: "0" } as JSX.CSSProperties,
  card: { border: "1px solid var(--figma-color-border)", borderRadius: "6px", padding: "8px", display: "flex", flexDirection: "column", gap: "6px" } as JSX.CSSProperties,
  mono: { fontFamily: "var(--font-family-code, ui-monospace, monospace)", fontSize: "11px", overflowWrap: "anywhere" } as JSX.CSSProperties,
  clamp: { display: "-webkit-box", WebkitLineClamp: "2", WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" } as JSX.CSSProperties,
  muted: { color: "var(--figma-color-text-secondary)" } as JSX.CSSProperties,
  small: { fontSize: "11px", lineHeight: "16px" } as JSX.CSSProperties,
  stack: { display: "flex", flexDirection: "column", gap: "8px" } as JSX.CSSProperties,
  tightStack: { display: "flex", flexDirection: "column", gap: "4px" } as JSX.CSSProperties,
  sectionTitle: { fontWeight: "600", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--figma-color-text-secondary)", margin: "12px 0 6px" } as JSX.CSSProperties,
}
