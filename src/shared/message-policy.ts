import type { UiToMain } from "./messages"

export type Impact = "ui" | "read" | "metadata" | "canvas" | "devprobe"
export type PluginEditorType = "figma" | "dev"
export type BuildEnv = "production" | "development"

export const IMPACTS: readonly Impact[] = ["ui", "read", "metadata", "canvas", "devprobe"]

export const MESSAGE_IMPACT: Record<UiToMain["type"], Impact> = {
  "ui-ready": "ui",
  "auth-save": "ui",
  "auth-clear": "ui",
  "prefs-save": "ui",
  "cache-save": "ui",
  "open-external": "ui",
  "notify": "ui",
  "resize": "ui",
  "select-nodes": "read",
  "scan-request": "read",
  "scan-cancel": "read",
  "inspect-request": "read",
  "screenshots-export": "read",
  "diagnostics-read": "read",
  "settings-save": "metadata",
  "link-apply": "metadata",
  "link-remove": "metadata",
  "text-apply": "canvas",
  "preview-apply": "canvas",
  "preview-reset": "canvas",
  "overflow-check": "canvas",
  "language-copies": "canvas",
  "diagnostics-write": "canvas",
  "diagnostics-devmode-probe": "devprobe",
}

export function isAllowed(impact: Impact, editorType: PluginEditorType, env: BuildEnv): boolean {
  switch (impact) {
    case "ui":
    case "read":
      return true
    case "metadata":
    case "canvas":
      return editorType !== "dev"
    case "devprobe":
      return editorType === "dev" && env === "development"
  }
}

export function impactOf(type: UiToMain["type"]): Impact | null {
  return Object.prototype.hasOwnProperty.call(MESSAGE_IMPACT, type) ? MESSAGE_IMPACT[type] : null
}

export function isMessageAllowed(type: string, editorType: PluginEditorType, env: BuildEnv): boolean {
  const impact = impactOf(type as UiToMain["type"])
  return impact !== null && isAllowed(impact, editorType, env)
}
