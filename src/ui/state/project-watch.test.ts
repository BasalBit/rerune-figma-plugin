/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID } from "../../../test/fixtures"
import type { FigmaLanguage, FigmaProjectDetail, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import { linkSyncGate } from "../../shared/file-link"
import type { FileSettings, PreviewInfo } from "../../shared/messages"
import { ApiError } from "../api/client"
import appSource from "../app.tsx?raw"
import previewSource from "../screens/preview.tsx?raw"
import qaSource from "../screens/qa.tsx?raw"
import type { ScanResult } from "./ops"
import { defaultLanguage, languageLabel, previewStatus } from "./preview"
import {
  keptLanguage,
  keptVariation,
  languageRemovedNote,
  projectChange,
  projectGoneMessage,
  projectRead,
  removedPreviewNote,
  VARIATION_REMOVED_NOTE,
  type ProjectChange,
} from "./project-watch"
import { reportLanguageLabel } from "./qa"
import { createWatchSchedule, REQUEST_POLL_MS, type WatchWindow } from "./request-watch"
import { canSubmit, preparePush } from "./push"
import { resolvedKey } from "./test-fakes"
import { createWorkspace } from "./workspace"

// Languages changed in ReRune while the plugin is open: the project's details (E9) are read on the schedule and every
// list that uses them follows.

const MINUTE = REQUEST_POLL_MS

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function language(code: string, main = false): FigmaLanguage {
  return { code, name: code.toUpperCase(), main, rtl_writing: false, inherits_from: [] }
}

function project(overrides: Partial<FigmaProjectDetail> = {}): FigmaProjectDetail {
  return {
    id: PROJECT_ID,
    name: "Shop",
    organisation: { id: "6a4700000000000000000001", name: "Acme" },
    main_language: "en",
    languages: [language("en", true), language("de"), language("fr")],
    variation_options: [{ id: "6a4500000000000000000001", value: "Formal" }],
    permissions: ["view_keys", "edit_keys"],
    key_count: 10,
    available_keys: null,
    key_name_sample: [],
    ...overrides,
  }
}

function visibleWindow(): WatchWindow {
  return { visible: () => true, listen: () => () => {} }
}

// The app's project read on a schedule: `shown` is the project the app shows.
function setup(answers: (FigmaProjectDetail | Error)[]) {
  let shown: FigmaProjectDetail | null = project()
  let calls = 0
  const api = {
    project: vi.fn(async (): Promise<FigmaProjectDetail> => {
      const next = answers[Math.min(calls++, answers.length - 1)]
      if (next instanceof Error) throw next
      return next
    }),
  }
  const applied: ProjectChange[] = []
  const gone = vi.fn()
  const state = { loading: false, held: false }
  const schedule = createWatchSchedule({ busy: () => state.held, window: visibleWindow() })
  const watch = schedule.add(
    projectRead({
      api,
      current: () => shown,
      loading: () => state.loading,
      held: () => state.held,
      apply: (detail, change) => {
        shown = detail
        applied.push(change)
      },
      gone,
    }),
  )
  return { api, applied, gone, watch, state, shown: () => shown, setShown: (next: FigmaProjectDetail | null) => (shown = next) }
}

describe("project details read while the plugin is open", () => {
  it("shows a language added in ReRune within a minute, in the Preview list and the QA checkboxes", async () => {
    const s = setup([project({ languages: [language("en", true), language("de"), language("fr"), language("uk")] })])
    s.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.applied).toEqual([{ changed: true, mainLanguage: false }])
    const codes = s.shown()?.languages.map((entry) => entry.code)
    expect(codes).toEqual(["en", "de", "fr", "uk"])
    // The Preview dropdown and the QA checkboxes list project.languages as they render.
    expect(previewSource).toContain("const languageOptions = project.languages.map((language) => ({ value: language.code, text: languageLabel(language) }))")
    expect(qaSource).toContain("project.languages.map((language) => (")
    expect(languageLabel(language("uk"))).toBe("UK (uk)")
  })

  it("changes nothing when the details are the same, and leaves them as they are when the read fails", async () => {
    const s = setup([project(), new ApiError(503, null, "Service Unavailable")])
    s.watch.start()
    const before = s.shown()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.api.project).toHaveBeenCalledTimes(1)
    expect(s.applied).toEqual([])
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.api.project).toHaveBeenCalledTimes(2)
    expect(s.shown()).toBe(before)
    expect(s.gone).not.toHaveBeenCalled()
    // The failure's wait: no read a minute later.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.api.project).toHaveBeenCalledTimes(2)
  })

  it("drops an answer for a project no longer shown, and sits out while the workspace loads the project itself", async () => {
    const s = setup([project({ name: "Renamed" })])
    s.watch.start()
    s.state.loading = true
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.api.project).not.toHaveBeenCalled()
    s.state.loading = false
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.shown()?.name).toBe("Renamed")
    let answer: (detail: FigmaProjectDetail) => void = () => {}
    s.api.project.mockImplementationOnce(() => new Promise<FigmaProjectDetail>((resolve) => (answer = resolve)))
    await vi.advanceTimersByTimeAsync(MINUTE)
    const other = project({ id: "6a4600000000000000000999", name: "Other" })
    s.setShown(other)
    answer(project({ name: "Late" }))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.shown()).toBe(other)
  })

  it("handles a project deleted or no longer open to this account as when the workspace opens", async () => {
    for (const status of [403, 404]) {
      const s = setup([new ApiError(status, null, "gone")])
      s.watch.start()
      await vi.advanceTimersByTimeAsync(MINUTE)
      expect(s.gone).toHaveBeenCalledTimes(1)
    }
    expect(projectGoneMessage("dana@example.com")).toBe("This file's ReRune project isn't available to dana@example.com. Choose a project.")
    expect(appSource).toContain("setProjectError(projectGoneMessage(authRef.current?.user.email ?? null))\n        go({ type: \"change-project\" })")
    const gone = appSource.slice(appSource.indexOf("  function projectGone() {"), appSource.indexOf("  // Loads the project detail (E9)"))
    for (const step of ["setActiveProject(null)", "setLink(null)", "refreshRequests.reset()", "workspace.clear(true)", 'go({ type: "change-project" })']) {
      expect(gone).toContain(step)
    }
  })

  it("keeps the project as it is while a task holds the work lock: an answer that comes meanwhile waits for the next round", async () => {
    const s = setup([project({ languages: [language("en", true)] }), new ApiError(404, null, "Not found"), new ApiError(404, null, "Not found")])
    s.watch.start()
    const before = s.shown()
    // A push starts while the read waits for its answer.
    let answer: () => void = () => {}
    s.api.project.mockImplementationOnce(() => new Promise<FigmaProjectDetail>((resolve) => (answer = () => resolve(project({ languages: [language("en", true)] })))))
    await vi.advanceTimersByTimeAsync(MINUTE)
    s.state.held = true
    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.shown()).toBe(before)
    // No read while the push runs; the next round after it applies the change.
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(s.api.project).toHaveBeenCalledTimes(1)
    s.state.held = false
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.shown()?.languages.map((entry) => entry.code)).toEqual(["en"])
    // A project gone during a task: the Project screen only once the task ended.
    let gone: () => void = () => {}
    s.api.project.mockImplementationOnce(() => new Promise<FigmaProjectDetail>((_resolve, reject) => (gone = () => reject(new ApiError(404, null, "Not found")))))
    await vi.advanceTimersByTimeAsync(MINUTE)
    s.state.held = true
    gone()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.gone).not.toHaveBeenCalled()
    s.state.held = false
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.gone).toHaveBeenCalledTimes(1)
    expect(appSource).toContain("held: () => workLock.holder() !== null,")
    expect(appSource).toContain("const current = projectRef.current\n              if (current !== null) setActiveProject({ ...current, available_keys: availableKeys })")
  })

  it("stops after a 401 (the client signs out)", async () => {
    const s = setup([new ApiError(401, null, "Unauthorized")])
    s.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(s.api.project).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("loads the remote state again in the new main language when it changed", async () => {
    let shown = project()
    const resolveKeys = vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
      source: "draft",
      variation_option: null,
      keys: request.key_ids.map((id) => resolvedKey(id, "pay_now", "Pay now")),
      missing_key_ids: [],
    }))
    const nodes = [linkedNode("1:1", "Pay now", { keyId: keyId(1), keyName: "pay_now", syncedText: "Pay now" })]
    const workspace = createWorkspace({
      scanner: { cancel: vi.fn(), run: vi.fn(async (): Promise<ScanResult> => ({ scope: "page", nodes, total: 1, truncated: false, skipped: { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 } })) },
      api: { resolveKeys },
      project: () => shown,
    })
    await workspace.scan("page")
    const read = projectRead({
      api: { project: vi.fn(async () => project({ main_language: "de", languages: [language("en"), language("de", true)] })) },
      current: () => shown,
      loading: () => false,
      held: () => false,
      // As app.tsx applies it.
      apply: (detail, change) => {
        shown = detail
        if (change.mainLanguage) void workspace.refreshRemote()
      },
      gone: () => {},
    })
    await read.fetch()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveKeys).toHaveBeenLastCalledWith(PROJECT_ID, expect.objectContaining({ languages: ["de"] }))
    expect(appSource).toContain("if (change.mainLanguage) {\n              void workspace.refreshRemote()\n            }")
  })

  it("updates the gates at once when the account loses Edit keys", async () => {
    const s = setup([project({ permissions: ["view_keys"] })])
    s.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    const permissions = s.shown()?.permissions ?? []
    expect(permissions).toEqual(["view_keys"])
    const settings: FileSettings = {
      v: 1,
      apiBase: "http://localhost:8080",
      projectId: PROJECT_ID,
      projectName: "Shop",
      fileKey: "AbCdEf1234567890XyZ",
      fileUrl: "https://www.figma.com/design/AbCdEf1234567890XyZ/Shop",
      fileName: "Shop",
      branchKey: null,
      keyTemplate: null,
      caseStyle: "auto",
      ignoreUnderscoreLayers: true,
      includeLocked: false,
      updatedAt: 1,
    }
    expect(linkSyncGate(settings, "Shop", project().permissions)).toMatchObject({ enabled: true })
    expect(linkSyncGate(settings, "Shop", permissions)).toMatchObject({ enabled: false, reason: "no_permission" })
    const prepared = await preparePush({ keysByName: vi.fn(async () => ({ keys: [], missing: [], text_matches: [] })) }, {
      projectId: PROJECT_ID,
      scope: "selection",
      nodes: [],
      remote: new Map(),
      sample: [],
      settings: null,
      groupIdenticalTexts: true,
      pending: new Map(),
    })
    expect(canSubmit(prepared.plan, permissions.includes("edit_keys"))).toBe(false)
    // The app and the Push tab read the permissions of the project shown, as they render.
    expect(appSource).toContain("const gate = linkSyncGate(usable, rootName, project?.permissions ?? [])")
    expect(appSource).toContain("const freshnessGate = refreshGate({ availability, settings: usable, rootName, permissions: project?.permissions ?? [] })")
  })
})

describe("picks after the project's languages and variations changed", () => {
  it("keeps the Preview language while the project has it, and falls back to the main language with a note when it was removed", () => {
    expect(keptLanguage(project(), "de", null)).toEqual({ lang: "de", removed: null })
    const withoutDe = project({ languages: [language("en", true), language("fr")] })
    expect(keptLanguage(withoutDe, "de", "de")).toEqual({ lang: "en", removed: "de" })
    expect(languageRemovedNote(["de"], "en")).toBe("de was removed from this project. Language set to en.")
    // No main language left: the first one.
    expect(keptLanguage(project({ main_language: "", languages: [language("fr")] }), "de", null)).toEqual({ lang: "fr", removed: "de" })
    // The last language removed, then a first one added.
    expect(keptLanguage(project({ languages: [] }), "de", null)).toEqual({ lang: null, removed: "de" })
    expect(keptLanguage(project(), null, "fr")).toEqual({ lang: "fr", removed: null })
    expect(keptLanguage(project(), null, null).lang).toBe(defaultLanguage(project(), null))
    expect(previewSource).toContain("const keptLang = keptLanguage(project, lang, prefs.lastLanguage)")
    expect(previewSource).toContain("setPickNote(languageRemovedNote([keptLang.removed], keptLang.lang))")
  })

  it("drops a removed variation for no variation, with a note", () => {
    const id = "6a4500000000000000000001"
    expect(keptVariation(project(), id)).toEqual({ variation: id, removed: false })
    expect(keptVariation(project({ variation_options: [] }), id)).toEqual({ variation: null, removed: true })
    expect(keptVariation(project({ variation_options: [] }), null)).toEqual({ variation: null, removed: false })
    expect(VARIATION_REMOVED_NOTE).toBe("The variation you picked was removed from this project. No variation is used.")
    expect(previewSource).toContain("setPickNote(VARIATION_REMOVED_NOTE)")
  })

  it("unchecks removed QA languages with a note; the report's labels and the plural forms use the languages left", () => {
    expect(languageRemovedNote(["de", "fr"], null)).toBe("de and fr were removed from this project.")
    expect(languageRemovedNote(["de", "fr", "it"], null)).toBe("de, fr and it were removed from this project.")
    expect(qaSource).toContain("const languages = session.languages.filter((code) => project.languages.some((language) => language.code === code))")
    expect(qaSource).toContain("setPickNote(removed.length > 0 ? languageRemovedNote(removed, null) : VARIATION_REMOVED_NOTE)")
    // The plural forms follow the first language picked that is left (samples, §7.18.5).
    expect(qaSource).toContain("const pluralLang = ordered.length > 0 ? ordered[0] : null")
    expect(reportLanguageLabel("de", [language("en")])).toBe("de")
  })

  it("keeps a preview in a removed language on the canvas and says that Reset brings back the original text", () => {
    const info: PreviewInfo = { lang: "de", source: "draft", variationOptionId: null, appliedAt: 1 }
    const nodes = [linkedNode("1:1", "Jetzt zahlen", { keyId: keyId(1), keyName: "pay_now", syncedText: "Pay now" }, { originalCharacters: "Pay now", preview: info })]
    const status = previewStatus(nodes)
    expect(removedPreviewNote(status, project())).toBeNull()
    expect(removedPreviewNote(status, project({ languages: [language("en", true)] }))).toBe(
      "The layers still show the de preview, but de was removed from this project. Reset brings back the original text.",
    )
    expect(removedPreviewNote({ lang: "en", source: "pseudo", mixed: false }, project({ languages: [] }))).toBeNull()
    expect(removedPreviewNote(null, project())).toBeNull()
    // Reset sends no language: the main thread restores the stored original whatever the project has now.
    expect(appSource).toContain('runOp(bus, (requestId) => ({ type: "preview-reset", requestId, scope, nodeIds, edited }), LONG_OP_IDLE_MS)')
  })

  it("reports what changed", () => {
    expect(projectChange(project(), project())).toEqual({ changed: false, mainLanguage: false })
    expect(projectChange(project(), project({ languages: [language("en", true)] }))).toEqual({ changed: true, mainLanguage: false })
    expect(projectChange(project(), project({ main_language: "de" }))).toEqual({ changed: true, mainLanguage: true })
    expect(projectChange(project(), project({ variation_options: [] })).changed).toBe(true)
  })
})
