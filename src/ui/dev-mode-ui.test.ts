/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import { builtMessageTypes, codeReachableFrom, importClosure, namesImportedFrom, normalizeSources } from "../../test/source-graph"
import { isAllowed, MESSAGE_IMPACT, type BuildEnv } from "../shared/message-policy"
import type { UiToMainType } from "../shared/messages"
import { diagnosticsFor, messageFor } from "./diagnostics"

// Dev Mode policy on the UI side (§7.5, §7.17 "No writes of any kind"). Main refuses every metadata and canvas
// message in Dev Mode (test/dev-mode-policy.test.ts); this checks that the Dev Mode UI never even builds one, so a
// developer never meets "Not available in Dev Mode". The Dev Mode UI is InspectApp and the code it bundles: the
// whole of inspect-app.tsx, and of every other module only the declarations reachable from the names imported
// from it (test/source-graph.ts).

const sources = normalizeSources(
  import.meta.glob<string>(
    [
      "./**/*.ts",
      "./**/*.tsx",
      "../shared/**/*.ts",
      "../codegen/**/*.ts",
      "!./**/*.test.ts",
      "!../shared/**/*.test.ts",
      "!../codegen/**/*.test.ts",
      "!./state/test-fakes.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  ),
)

const ENTRY = "inspect-app.tsx"
const UI_TO_MAIN = Object.keys(MESSAGE_IMPACT) as UiToMainType[]
const ENVS: BuildEnv[] = ["production", "development"]

function refusedInDevMode(env: BuildEnv): UiToMainType[] {
  return UI_TO_MAIN.filter((type) => !isAllowed(MESSAGE_IMPACT[type], "dev", env))
}

// Refused message types each module of the Dev Mode UI can build, through the code the UI bundles from it.
function refusedBuilders(env: BuildEnv): Record<string, string[]> {
  const closure = importClosure(sources, ENTRY)
  const result: Record<string, string[]> = {}
  for (const file of closure) {
    const code = file === ENTRY ? sources[file] : codeReachableFrom(sources[file], namesImportedFrom(sources, closure, file))
    const built = builtMessageTypes(code, refusedInDevMode(env))
    if (built.length > 0) {
      result[file] = built
    }
  }
  return result
}

describe("Dev Mode UI (inspect panel)", () => {
  it("reads the UI, shared and codegen sources", () => {
    expect(Object.keys(sources)).toEqual(expect.arrayContaining([ENTRY, "app.tsx", "state/inspect.ts", "../shared/messages.ts", "../codegen/snippets.ts"]))
    expect(Object.keys(sources).some((path) => path.endsWith(".test.ts"))).toBe(false)
  })

  it("is what the app renders in Dev Mode", () => {
    expect(sources["app.tsx"]).toMatch(/init\.editorType === "dev" \? <InspectApp /)
  })

  it("bundles the sign-in, inspect and diagnostics modules, and no Design-mode screen", () => {
    const closure = importClosure(sources, ENTRY)
    expect(closure).toEqual(expect.arrayContaining(["screens/inspect.tsx", "state/inspect.ts", "state/pairing.ts", "state/session.ts", "screens/diagnostics.tsx", "../codegen/snippets.ts"]))
    for (const screen of ["layers", "link-dialog", "push", "preview", "settings", "project-picker"]) {
      expect(closure).not.toContain("screens/" + screen + ".tsx")
    }
  })

  it.each(ENVS)("builds no message Dev Mode refuses (%s build), except through the Diagnostics screen's messageFor", (env) => {
    expect(refusedInDevMode(env)).toContain("link-apply")
    const offenders = refusedBuilders(env)
    expect(Object.keys(offenders)).toEqual(["diagnostics.ts"])
    expect(codeReachableFrom(sources["diagnostics.ts"], ["messageFor"])).toContain(offenders["diagnostics.ts"].map((type) => `type: "${type}"`)[0])
  })

  it.each(ENVS)("offers in Dev Mode only diagnostics whose message the impact map allows (%s build)", (env) => {
    const offered = diagnosticsFor("dev", env)
    expect(offered.length).toBeGreaterThan(0)
    for (const entry of offered) {
      const type = messageFor(entry.test, "c1-1").type
      expect(isAllowed(MESSAGE_IMPACT[type], "dev", env)).toBe(true)
    }
    expect(sources["screens/diagnostics.tsx"]).toContain("diagnosticsFor(props.editorType, props.env)")
  })

  it("would notice a write sender bundled into the Dev Mode UI", () => {
    const closure = importClosure(sources, ENTRY)
    const ops = "state/ops.ts"
    expect(closure).toContain(ops)
    expect(namesImportedFrom(sources, closure, ops)).not.toContain("removeLinksBatched")
    expect(builtMessageTypes(codeReachableFrom(sources[ops], ["removeLinksBatched"]), refusedInDevMode("production"))).toEqual(["link-remove"])
    expect(builtMessageTypes(codeReachableFrom(sources[ops], ["chunk"]), refusedInDevMode("production"))).toEqual([])
  })
})
