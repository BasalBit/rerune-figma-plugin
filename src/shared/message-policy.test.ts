import { describe, expect, it } from "vitest"
import { IMPACTS, impactOf, isAllowed, isMessageAllowed, MESSAGE_IMPACT, type BuildEnv, type Impact, type PluginEditorType } from "./message-policy"
import type { UiToMain } from "./messages"

const SPEC_TABLE: Record<Impact, UiToMain["type"][]> = {
  ui: ["ui-ready", "auth-save", "auth-clear", "prefs-save", "cache-save", "open-external", "notify", "resize"],
  read: ["select-nodes", "scan-request", "scan-cancel", "inspect-request", "screenshots-export", "diagnostics-read"],
  metadata: ["settings-save", "link-apply", "link-remove"],
  canvas: ["text-apply", "preview-apply", "preview-reset", "overflow-check", "language-copies", "diagnostics-write"],
  devprobe: ["diagnostics-devmode-probe"],
}

describe("MESSAGE_IMPACT (§7.5)", () => {
  it("matches the impact table for every message type", () => {
    const expected = Object.fromEntries(IMPACTS.flatMap((impact) => SPEC_TABLE[impact].map((type) => [type, impact])))
    expect(MESSAGE_IMPACT).toEqual(expected)
  })

  it("looks up impacts and rejects unknown types", () => {
    expect(impactOf("link-apply")).toBe("metadata")
    expect(impactOf("made-up" as UiToMain["type"])).toBeNull()
    expect(impactOf("toString" as UiToMain["type"])).toBeNull()
  })
})

describe("isAllowed", () => {
  const cases: [Impact, PluginEditorType, BuildEnv, boolean][] = [
    ["ui", "figma", "production", true],
    ["ui", "figma", "development", true],
    ["ui", "dev", "production", true],
    ["ui", "dev", "development", true],
    ["read", "figma", "production", true],
    ["read", "figma", "development", true],
    ["read", "dev", "production", true],
    ["read", "dev", "development", true],
    ["metadata", "figma", "production", true],
    ["metadata", "figma", "development", true],
    ["metadata", "dev", "production", false],
    ["metadata", "dev", "development", false],
    ["canvas", "figma", "production", true],
    ["canvas", "figma", "development", true],
    ["canvas", "dev", "production", false],
    ["canvas", "dev", "development", false],
    ["devprobe", "figma", "production", false],
    ["devprobe", "figma", "development", false],
    ["devprobe", "dev", "production", false],
    ["devprobe", "dev", "development", true],
  ]

  it("covers every impact × editor type × env", () => {
    expect(cases).toHaveLength(IMPACTS.length * 2 * 2)
  })

  it.each(cases)("%s in %s (%s) → %s", (impact, editorType, env, expected) => {
    expect(isAllowed(impact, editorType, env)).toBe(expected)
  })

  it("checks message types, refusing unknown ones", () => {
    expect(isMessageAllowed("link-apply", "dev", "development")).toBe(false)
    expect(isMessageAllowed("scan-request", "dev", "production")).toBe(true)
    expect(isMessageAllowed("diagnostics-devmode-probe", "dev", "development")).toBe(true)
    expect(isMessageAllowed("made-up", "figma", "development")).toBe(false)
  })
})
