import type { BuildEnv, PluginEditorType } from "../shared/message-policy"
import { isAllowed, MESSAGE_IMPACT } from "../shared/message-policy"
import type { DiagnosticTest, ReadDiagnostic, RequestId, UiToMain, WriteDiagnostic } from "../shared/messages"

// Diagnostics screen logic (§7.21), kept pure so it runs in node tests.

export interface DiagnosticEntry { test: DiagnosticTest; label: string; hint: string }

const READ_TESTS: Record<ReadDiagnostic, Omit<DiagnosticEntry, "test">> = {
  "T1-check": { label: "T1 Check markers", hint: "Find T1 markers on this page after duplicating, pasting, detaching or merging." },
  "T2-instances": { label: "T2 Instances", hint: "Select instances (also nested and library ones) whose main has a linked text." },
  "T3-export": { label: "T3 Export frame", hint: "Select one frame; exports JPG/PNG with and without absolute bounds." },
  "T4-export-page": { label: "T4 Export page", hint: "Exports every top-level frame on this page (up to 100)." },
  "T7-settings": { label: "T7 File settings", hint: "Reads the ReRune file settings on the file and on every page." },
  "T10-environment": { label: "T10 Environment", hint: "Editor, mode, command and API version." },
}

const WRITE_TESTS: Record<WriteDiagnostic, Omit<DiagnosticEntry, "test">> = {
  "T1-mark": { label: "T1 Mark", hint: "Writes a test marker on the selected text layers." },
  "T2-clear": { label: "T2 Clear inherited", hint: "Select an instance: clears one inherited link, then writes an own link. Undo afterwards." },
  "T5-fonts": { label: "T5 Fonts and restore", hint: "Select styled, hyperlinked and variable-bound text: writes ✓ and restores it." },
  "T8-relaunch": { label: "T8 Relaunch button", hint: "Sets a relaunch button on the selection." },
}

const ORDER: DiagnosticTest[] = [
  "T10-environment", "T1-mark", "T1-check", "T2-instances", "T2-clear", "T3-export", "T4-export-page", "T5-fonts", "T7-settings", "T8-relaunch", "T9-devmode-write",
]

function entryOf(test: DiagnosticTest): DiagnosticEntry {
  if (test === "T9-devmode-write") {
    return { test, label: "T9 Dev Mode write", hint: "Select a layer: tries to write plugin data in Dev Mode." }
  }
  if (test in READ_TESTS) {
    return { test, ...READ_TESTS[test as ReadDiagnostic] }
  }
  return { test, ...WRITE_TESTS[test as WriteDiagnostic] }
}

export function messageFor(test: DiagnosticTest, requestId: RequestId): UiToMain {
  if (test === "T9-devmode-write") {
    return { type: "diagnostics-devmode-probe", requestId }
  }
  if (test in READ_TESTS) {
    return { type: "diagnostics-read", requestId, test: test as ReadDiagnostic }
  }
  return { type: "diagnostics-write", requestId, test: test as WriteDiagnostic }
}

// Only the tests the main bus will accept for this editor and build (the impact map decides).
export function diagnosticsFor(editorType: PluginEditorType, env: BuildEnv): DiagnosticEntry[] {
  return ORDER.filter((test) => isAllowed(MESSAGE_IMPACT[messageFor(test, "").type], editorType, env)).map(entryOf)
}

// JSON for "Copy report": binary samples are replaced by their size.
export function printableReport(report: unknown): string {
  return JSON.stringify(report, (_key, value: unknown) => (value instanceof Uint8Array ? { bytes: value.length } : value), 2)
}

export function jpgSampleOf(report: unknown): Uint8Array | null {
  if (typeof report !== "object" || report === null) {
    return null
  }
  const sample = (report as { jpgSample?: unknown }).jpgSample
  return sample instanceof Uint8Array ? sample : null
}

// Values only the UI knows are merged into the main thread's report.
export function withUiFacts(test: DiagnosticTest, report: unknown, facts: { userAgent: string; cornerPixel: unknown }): unknown {
  if (typeof report !== "object" || report === null) {
    return report
  }
  if (test === "T10-environment") {
    return { ...report, userAgent: facts.userAgent }
  }
  if (test === "T3-export") {
    return { ...report, jpgCornerPixel: facts.cornerPixel }
  }
  return report
}
