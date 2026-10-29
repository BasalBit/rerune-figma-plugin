import type { FigmaProject, FigmaProjectDetail } from "../../shared/api-types"
import { ApiError } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { defaultLanguage } from "./preview"
import type { WatchRead } from "./request-watch"

// The project's details (E9) read again while the plugin is open (app.tsx, on the schedule of request-watch.ts): a
// language, variation or permission added or removed in the dashboard shows without reopening the plugin. Pure apart
// from the read itself.

export interface ProjectChange {
  changed: boolean          // anything in E9 differs: the app takes the new details
  mainLanguage: boolean     // the main language changed: the remote state is loaded again
}

export function projectChange(before: FigmaProjectDetail, after: FigmaProjectDetail): ProjectChange {
  return { changed: JSON.stringify(before) !== JSON.stringify(after), mainLanguage: before.main_language !== after.main_language }
}

export interface ProjectReadDeps {
  api: Pick<FigmaApi, "project">
  // The project shown (null: none, or signed out).
  current(): FigmaProjectDetail | null
  // The workspace loads the project itself (opening, Try again): this read sits the round out.
  loading(): boolean
  // A task holds the work lock (a push, a preview, …): an answer that comes meanwhile is dropped and read again the
  // next round, so a running task never sees the project change or go under it.
  held(): boolean
  // New details of the project shown: the app shows them everywhere, and loads the remote state again for a new main
  // language.
  apply(detail: FigmaProjectDetail, change: ProjectChange): void
  // 403 or 404: the project was deleted or this account lost access to it.
  gone(): void
}

// The read of the schedule: one E9 call per round. An answer for a project that is no longer shown, or that came
// while the workspace loaded it again, is dropped; one that came while a task holds the work lock waits for the next
// round; other failures change nothing (the schedule waits longer).
export function projectRead(deps: ProjectReadDeps): WatchRead {
  return {
    busy: () => deps.loading(),
    async fetch() {
      const active = deps.current()
      if (active === null) {
        return { kind: "read" }
      }
      try {
        const detail = await deps.api.project(active.id)
        const current = deps.current()
        if (current === null || current.id !== active.id || deps.loading()) {
          return { kind: "read" }
        }
        if (deps.held()) {
          return { kind: "skipped" }
        }
        const change = projectChange(current, detail)
        if (change.changed) {
          deps.apply(detail, change)
        }
        return { kind: "read" }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404) && deps.current()?.id === active.id) {
          if (deps.held()) {
            return { kind: "skipped" }
          }
          deps.gone()
          return { kind: "read" }
        }
        return { kind: "failed", error }
      }
    },
  }
}

// A 403 or 404 for the file's project, when the workspace opens or later (deleted, or no longer open to this account).
export function projectGoneMessage(email: string | null): string {
  return "This file's ReRune project isn't available to " + (email ?? "this account") + ". Choose a project."
}

type ProjectLanguages = Pick<FigmaProject, "languages" | "main_language">

// The Preview language after the project's languages changed: kept while the project has it; one that was removed
// falls back to the main language (the first language without one), and `removed` names it for the note. With no
// language before (none in the project), the usual default once there is one.
export function keptLanguage(project: ProjectLanguages, lang: string | null, last: string | null): { lang: string | null; removed: string | null } {
  if (lang !== null && project.languages.some((language) => language.code === lang)) {
    return { lang, removed: null }
  }
  if (lang === null) {
    return { lang: defaultLanguage(project, last), removed: null }
  }
  const main = project.languages.find((language) => language.code === project.main_language) ?? project.languages[0]
  return { lang: main?.code ?? null, removed: lang }
}

// The variation picked, while the project still has it; null (no variation) once it was removed.
export function keptVariation(project: Pick<FigmaProject, "variation_options">, variation: string | null): { variation: string | null; removed: boolean } {
  if (variation === null || project.variation_options.some((option) => option.id === variation)) {
    return { variation, removed: false }
  }
  return { variation: null, removed: true }
}

function codes(list: readonly string[]): string {
  return list.length === 1 ? list[0] : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]
}

export function languageRemovedNote(removed: readonly string[], fallback: string | null): string {
  const what = codes(removed) + (removed.length === 1 ? " was" : " were") + " removed from this project."
  return fallback === null ? what : what + " Language set to " + fallback + "."
}

export const VARIATION_REMOVED_NOTE = "The variation you picked was removed from this project. No variation is used."

// A preview on the canvas in a language the project no longer has: it stays until Reset, which brings back the
// original text as always.
export function removedPreviewNote(status: { lang: string; source: string; mixed: boolean } | null, project: ProjectLanguages): string | null {
  if (status === null || status.mixed || status.source === "pseudo" || status.source === "keys" || project.languages.some((language) => language.code === status.lang)) {
    return null
  }
  return "The layers still show the " + status.lang + " preview, but " + status.lang + " was removed from this project. Reset brings back the original text."
}
