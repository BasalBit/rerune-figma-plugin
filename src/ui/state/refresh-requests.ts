import type { FigmaScreenshot } from "../../shared/api-types"
import { REFRESH_REQUESTS_MAX, REFRESH_REQUESTS_PAGE_SIZE } from "../../shared/constants"
import type { NodeError } from "../../shared/messages"
import { buildPushPlan } from "../../shared/push-plan"
import { computeSyncState } from "../../shared/sync-state"
import { ApiError, userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { UiBus } from "../bus"
import { SCAN_UNFINISHED } from "./link-sync"
import type { ScanResult } from "./ops"
import { executePulls } from "./push"
import { linkedKeyIds, loadRemoteStates } from "./remote"
import {
  emptyScreenshotRun,
  progressText,
  screenshotFreshness,
  screenshotGate,
  type ScreenshotFrame,
  type ScreenshotGateInput,
  type ScreenshotRun,
  type ScreenshotUploader,
} from "./screenshots"
import { createStore, type Store } from "./store"
import type { WorkLock } from "./work-lock"
import { NO_MAIN_LANGUAGE } from "./workspace"

// Screenshot freshness (SF6, contract §6.4): the frames of this file that ReRune asks new screenshots of (requested
// in the dashboard, E24/E26), the notice that names them, and Update screenshots, which brings ReRune's changed
// texts into those frames (only layers Changed in ReRune: Figma-side edits and conflicts are left alone) and uploads
// the frames, which clears the requests on the server. Design mode only.

export interface RefreshRequest {
  screenshotId: string
  frameId: string
  frameName: string
  pageName: string
  requestedAt: string
  requestedBy: string | null           // the requester's name; null when the account no longer exists
}

// A request as "Not now" and the end of a run remember it: a new request of the same frame has a new time.
export function requestKey(request: Pick<RefreshRequest, "screenshotId" | "requestedAt">): string {
  return request.screenshotId + "@" + request.requestedAt
}

// null: the screenshot has no request (a server that ignored the filter lists every screenshot, SF5b).
export function refreshRequestOf(screenshot: FigmaScreenshot): RefreshRequest | null {
  if (typeof screenshot.refresh_requested_at !== "string" || screenshot.refresh_requested_at === "") {
    return null
  }
  const by = screenshot.refresh_requested_by
  return {
    screenshotId: screenshot.id,
    frameId: screenshot.frame_id,
    frameName: screenshot.frame_name,
    pageName: screenshot.page_name,
    requestedAt: screenshot.refresh_requested_at,
    requestedBy: by !== null && by !== undefined && typeof by.name === "string" && by.name.trim() !== "" ? by.name : null,
  }
}

export interface RefreshGate { enabled: boolean; fileKey: string | null }

// The screenshot gate without the setting (an explicit request is not an automatic upload), on a server that has the
// requests (E1 screenshot_freshness). Closed: no fetch and no notice (sandbox users, viewers, branches, suspected
// copies, files without a link or of another server).
export function refreshGate(input: Omit<ScreenshotGateInput, "pref">): RefreshGate {
  const gate = screenshotGate({ ...input, pref: true })
  if (!gate.enabled || gate.fileKey === null || !screenshotFreshness(input.availability)) {
    return { enabled: false, fileKey: null }
  }
  return { enabled: true, fileKey: gate.fileKey }
}

// E20 `?file_key=…&refresh_requested=true&limit=100`, following next_cursor, at most 1,000 listed screenshots. Only
// screenshots with a request are kept.
export async function loadRefreshRequests(api: Pick<FigmaApi, "screenshots">, projectId: string, fileKey: string): Promise<RefreshRequest[]> {
  const requests: RefreshRequest[] = []
  let cursor: string | null = null
  let listed = 0
  do {
    const page = await api.screenshots(projectId, { file_key: fileKey, refresh_requested: true, cursor, limit: REFRESH_REQUESTS_PAGE_SIZE })
    for (const screenshot of Array.isArray(page.screenshots) ? page.screenshots : []) {
      if (listed >= REFRESH_REQUESTS_MAX) {
        break
      }
      listed++
      const request = screenshot.file_key === fileKey ? refreshRequestOf(screenshot) : null
      if (request !== null) {
        requests.push(request)
      }
    }
    cursor = page.has_more === true && typeof page.next_cursor === "string" && page.next_cursor !== "" ? page.next_cursor : null
  } while (cursor !== null && listed < REFRESH_REQUESTS_MAX)
  return requests
}

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many)
}

const NOTICE_FRAMES = 5
const NOTICE_NAMES = 2

export interface RefreshNotice { message: string; requestedBy: string | null; frames: string }

function frameLabel(request: Pick<RefreshRequest, "frameId" | "frameName" | "pageName">): string {
  const frame = request.frameName.trim() === "" ? request.frameId : request.frameName
  return request.pageName.trim() === "" ? frame : frame + " (" + request.pageName + ")"
}

// "Requested by Ada.", "Requested by Ada and Grace.", "Requested by Ada, Grace and 2 others."; null when no name is
// known.
export function requestersLine(requests: readonly Pick<RefreshRequest, "requestedBy">[]): string | null {
  const names = [...new Set(requests.map((request) => request.requestedBy).filter((name): name is string => name !== null))]
  if (names.length === 0) {
    return null
  }
  const shown = names.slice(0, NOTICE_NAMES)
  const others = names.length - shown.length
  if (others > 0) {
    return "Requested by " + shown.join(", ") + " and " + plural(others, "other", "others") + "."
  }
  return "Requested by " + shown.join(" and ") + "."
}

// "Checkout (Mobile), Cart (Mobile) and 4 more".
export function framesLine(requests: readonly Pick<RefreshRequest, "frameId" | "frameName" | "pageName">[], shown = NOTICE_FRAMES): string {
  const labels = requests.slice(0, shown).map(frameLabel).join(", ")
  const more = requests.length - Math.min(shown, requests.length)
  return more > 0 ? labels + " and " + more + " more" : labels
}

// The notice while at least one request is not dismissed; it counts every current request.
export function refreshNotice(requests: readonly RefreshRequest[], dismissed: ReadonlySet<string>): RefreshNotice | null {
  if (!requests.some((request) => !dismissed.has(requestKey(request)))) {
    return null
  }
  return {
    message: "ReRune asks for new screenshots of " + plural(requests.length, "frame", "frames") + " in this file.",
    requestedBy: requestersLine(requests),
    frames: framesLine(requests),
  }
}

export type RefreshStep = { step: "scanning" } | { step: "updating" } | { step: "uploading"; run: ScreenshotRun }

export interface MissingFrame {
  screenshotId: string
  frameId: string
  frameName: string
  pageName: string
  removal: "removing" | "removed" | null
  error: string | null                 // the last Remove request failed
}

export type RefreshShots = { kind: "done"; run: ScreenshotRun } | { kind: "unavailable"; message: string }

export type RefreshOutcome =
  | { kind: "none" }                                   // ReRune no longer asks for any frame
  | { kind: "error"; message: string }                 // nothing was written or uploaded; the notice stays
  | { kind: "previews"; nodeIds: string[] }            // layers in the frames show a preview: nothing was written
  | {
      kind: "done"
      pulled: number                                   // layers given ReRune's text
      errors: NodeError[]                              // their write errors
      figmaSide: number                                // layers Changed in Figma or in both, left alone
      readonly: number                                 // layers of disabled keys or plural/ICU texts, left alone
      shots: RefreshShots | null                       // null: no frame was left to upload, or screenshots are off
      missing: MissingFrame[]                          // requested frames not in this file
    }

export interface RefreshState {
  requests: RefreshRequest[]           // the current requests (last fetch)
  dismissed: ReadonlySet<string>       // requestKey of requests "Not now" or a finished run put aside, this session
  running: RefreshStep | null
  stopping: boolean
  outcome: RefreshOutcome | null       // the last run's result, until dismissed or the next run
  removing: boolean                    // a Remove request runs
}

export interface RefreshContext {
  projectId: string
  mainLanguage: string
  gate: RefreshGate
  groupIdenticalTexts: boolean
}

export interface RefreshDeps {
  api: Pick<FigmaApi, "screenshots" | "cancelRefreshRequest" | "resolveKeys">
  bus: Pick<UiBus, "request" | "send">
  // The project, gate and prefs of this moment; null without a project.
  context(): RefreshContext | null
  // workspace.scanFrames: null when cancelled or while a shown scan runs.
  scanFrames(frameIds: readonly string[]): Promise<ScanResult | null>
  uploader: ScreenshotUploader
  lock: Pick<WorkLock, "acquire" | "release">
}

export interface RefreshRequests {
  store: Store<RefreshState>
  // Reads the requests again (when the workspace opens on a confirmed file, after the file link is saved, after every
  // upload run). Silent on errors (401 signs out through the client); nothing while a run is going on.
  fetch(): Promise<void>
  notNow(): void
  // Update screenshots (§6.4 steps 1–7): holds the work lock ("refresh"); does nothing while it is held.
  run(): Promise<void>
  stop(): void
  removeRequest(screenshotId: string): Promise<void>
  removeAll(): Promise<void>
  dismissOutcome(): void
  reset(): void                        // sign-out or another project
}

export function emptyRefreshState(): RefreshState {
  return { requests: [], dismissed: new Set(), running: null, stopping: false, outcome: null, removing: false }
}

export function createRefreshRequests(deps: RefreshDeps): RefreshRequests {
  const store = createStore<RefreshState>(emptyRefreshState())
  let generation = 0
  let fetches = 0
  let stopped = false

  const current = (mine: number) => mine === generation

  // The requests of the gate's file; [] when the gate is closed. Throws on errors.
  async function load(context: RefreshContext): Promise<RefreshRequest[]> {
    if (!context.gate.enabled || context.gate.fileKey === null) {
      return []
    }
    return loadRefreshRequests(deps.api, context.projectId, context.gate.fileKey)
  }

  async function fetch(): Promise<void> {
    if (store.get().running !== null) {
      return
    }
    const mine = generation
    const attempt = ++fetches
    const context = deps.context()
    try {
      const requests = context === null ? [] : await load(context)
      if (current(mine) && attempt === fetches && store.get().running === null) {
        store.set((state) => ({ ...state, requests }))
      }
    } catch {
      // Errors are silent: the notice keeps the last known requests.
    }
  }

  function setStep(mine: number, step: RefreshStep): void {
    if (current(mine)) {
      store.set((state) => ({ ...state, running: step }))
    }
  }

  async function upload(mine: number, frames: ScreenshotFrame[]): Promise<RefreshShots | null> {
    if (frames.length === 0) {
      return null
    }
    try {
      const { gate, availability } = await deps.uploader.prepare({ ignorePref: true })
      if (!gate.enabled || gate.fileKey === null) {
        return gate.reason === "unavailable" && availability.error !== null ? { kind: "unavailable", message: availability.error } : null
      }
      setStep(mine, { step: "uploading", run: emptyScreenshotRun(frames.length) })
      const run = await deps.uploader.upload(frames, {
        fileKey: gate.fileKey,
        freshness: true,
        stopped: () => stopped,
        onProgress: (next) => setStep(mine, { step: "uploading", run: next }),
      })
      return { kind: "done", run }
    } catch (caught) {
      return { kind: "unavailable", message: userMessage(caught) }
    }
  }

  // Steps 2–5 for the requests of step 1.
  async function update(mine: number, context: RefreshContext, requests: readonly RefreshRequest[]): Promise<RefreshOutcome> {
    const scanned = await deps.scanFrames(requests.map((request) => request.frameId))
    if (scanned === null) {
      return { kind: "error", message: SCAN_UNFINISHED }
    }
    const previewing = scanned.nodes.filter((node) => node.preview !== null).map((node) => node.nodeId)
    if (previewing.length > 0) {
      return { kind: "previews", nodeIds: previewing }
    }
    if (context.mainLanguage === "") {
      return { kind: "error", message: NO_MAIN_LANGUAGE }
    }
    setStep(mine, { step: "updating" })
    const { projectId } = context
    const load = await loadRemoteStates(deps.api, projectId, context.mainLanguage, linkedKeyIds(scanned.nodes, projectId))
    if (load.error !== null) {
      return { kind: "error", message: userMessage(load.error) }
    }
    // Only plan.pulls is written: creates, updates, conflicts and the rest of the plan are left for Push.
    const plan = buildPushPlan({
      projectId,
      scope: "page",
      nodes: scanned.nodes,
      remote: load.remote,
      textMatches: new Map(),
      groupIdenticalTexts: context.groupIdenticalTexts,
      suggestName: () => "",
    })
    const pulled = await executePulls(deps, plan, { projectId, nodes: new Map(scanned.nodes.map((node) => [node.nodeId, node])) })
    let figmaSide = 0
    for (const node of scanned.nodes) {
      const state = computeSyncState(projectId, node, node.link === null ? undefined : load.remote.get(node.link.id))
      if (state === "changed_in_figma" || state === "conflict") {
        figmaSide++
      }
    }
    // Every requested frame that exists, in request order, pulled or not.
    const missingIds = new Set(scanned.missingFrameIds ?? [])
    const frames = new Map<string, ScreenshotFrame>()
    const missing: MissingFrame[] = []
    for (const request of requests) {
      if (missingIds.has(request.frameId)) {
        missing.push({ screenshotId: request.screenshotId, frameId: request.frameId, frameName: request.frameName, pageName: request.pageName, removal: null, error: null })
      } else if (!frames.has(request.frameId)) {
        frames.set(request.frameId, { frameId: request.frameId, frameName: request.frameName })
      }
    }
    const shots = await upload(mine, [...frames.values()])
    return { kind: "done", pulled: pulled.done, errors: pulled.errors, figmaSide, readonly: plan.readonly, shots, missing }
  }

  async function run(): Promise<void> {
    const context = deps.context()
    if (context === null || !context.gate.enabled || store.get().running !== null || !deps.lock.acquire("refresh")) {
      return
    }
    const mine = generation
    stopped = false
    store.set((state) => ({ ...state, running: { step: "scanning" }, stopping: false, outcome: null }))
    let outcome: RefreshOutcome = { kind: "error", message: SCAN_UNFINISHED }
    let handled: string[] = []
    let requests: RefreshRequest[] | null = null
    try {
      const requested = await load(context)
      if (current(mine)) {
        store.set((state) => ({ ...state, requests: requested }))
      }
      handled = requested.map(requestKey)
      outcome = requested.length === 0 ? { kind: "none" } : await update(mine, context, requested)
      // Step 6: read the requests again. Those of this run are put aside below, so frames that were missing, failed or
      // not reached after Stop do not bring the notice back at once (the results list them); a request made during the
      // run still shows.
      if (outcome.kind === "done") {
        requests = await load(context).catch(() => null)
      }
    } catch (caught) {
      outcome = { kind: "error", message: userMessage(caught) }
    } finally {
      const result = outcome
      store.set((state) => {
        if (!current(mine)) {
          return { ...state, running: null, stopping: false }
        }
        const dismissed = result.kind === "done" ? new Set([...state.dismissed, ...handled]) : state.dismissed
        return { ...state, requests: requests ?? state.requests, dismissed, running: null, stopping: false, outcome: result }
      })
      deps.lock.release("refresh")
    }
  }

  function patchMissing(mine: number, screenshotId: string, patch: Partial<MissingFrame>): void {
    if (!current(mine)) {
      return
    }
    store.set((state) => {
      const outcome = state.outcome
      if (outcome === null || outcome.kind !== "done") {
        return state
      }
      const missing = outcome.missing.map((frame) => (frame.screenshotId === screenshotId ? { ...frame, ...patch } : frame))
      const requests = patch.removal === "removed" ? state.requests.filter((request) => request.screenshotId !== screenshotId) : state.requests
      return { ...state, requests, outcome: { ...outcome, missing } }
    })
  }

  // E25 for one missing frame; false when Remove all should stop (429).
  async function removeOne(mine: number, projectId: string, screenshotId: string): Promise<boolean> {
    patchMissing(mine, screenshotId, { removal: "removing", error: null })
    try {
      await deps.api.cancelRefreshRequest(projectId, screenshotId)
      patchMissing(mine, screenshotId, { removal: "removed", error: null })
      return true
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404 && caught.reason === "screenshot_not_found") {
        patchMissing(mine, screenshotId, { removal: "removed", error: null })
        return true
      }
      patchMissing(mine, screenshotId, { removal: null, error: userMessage(caught) })
      return !(caught instanceof ApiError && caught.status === 429)
    }
  }

  async function remove(screenshotIds: (state: RefreshState) => string[]): Promise<void> {
    const context = deps.context()
    const state = store.get()
    if (context === null || state.running !== null || state.removing) {
      return
    }
    const mine = generation
    store.set((next) => ({ ...next, removing: true }))
    try {
      for (const screenshotId of screenshotIds(state)) {
        if (!(await removeOne(mine, context.projectId, screenshotId))) {
          break
        }
      }
    } finally {
      if (current(mine)) {
        store.set((next) => ({ ...next, removing: false }))
      }
    }
  }

  function missingOf(state: RefreshState): MissingFrame[] {
    return state.outcome !== null && state.outcome.kind === "done" ? state.outcome.missing : []
  }

  return {
    store,
    fetch,
    notNow() {
      store.set((state) => ({ ...state, dismissed: new Set([...state.dismissed, ...state.requests.map(requestKey)]) }))
    },
    run,
    stop() {
      if (store.get().running !== null) {
        stopped = true
        store.set((state) => ({ ...state, stopping: true }))
      }
    },
    removeRequest: (screenshotId) =>
      remove((state) => missingOf(state).filter((frame) => frame.screenshotId === screenshotId && frame.removal !== "removed").map((frame) => frame.screenshotId)),
    removeAll: () => remove((state) => missingOf(state).filter((frame) => frame.removal !== "removed").map((frame) => frame.screenshotId)),
    dismissOutcome() {
      store.set((state) => ({ ...state, outcome: null }))
    },
    reset() {
      generation++
      stopped = true
      store.set((state) => ({ ...emptyRefreshState(), running: state.running }))
    },
  }
}

// The uploader every other upload run uses (push, pull, Overwrite, Take ReRune text): when a run ends, the requests
// are read again, so frames it uploaded leave the notice.
export function refetchAfterUpload(uploader: ScreenshotUploader, refetch: () => Promise<void>): ScreenshotUploader {
  return {
    prepare: (options) => uploader.prepare(options),
    async upload(frames, options) {
      try {
        return await uploader.upload(frames, options)
      } finally {
        void refetch()
      }
    },
  }
}

// One line each for the run's results (contract §6.4 step 7), apart from the screenshot summary and problem groups,
// the missing frames and the write errors, which the results show with their own actions.
export interface RefreshLines { pulled: string | null; figmaSide: string | null; readonly: string | null; outdated: string | null; missing: string | null }

export function refreshLines(outcome: Extract<RefreshOutcome, { kind: "done" }>): RefreshLines {
  const outdated = outcome.shots !== null && outcome.shots.kind === "done" ? outcome.shots.run.outdated : 0
  const missing = outcome.missing
  return {
    pulled: outcome.pulled > 0 ? "Updated " + plural(outcome.pulled, "layer", "layers") + " from ReRune." : null,
    figmaSide:
      outcome.figmaSide > 0
        ? plural(outcome.figmaSide, "layer changed in Figma or in both wasn't", "layers changed in Figma or in both weren't") + " changed. Review " + (outcome.figmaSide === 1 ? "it" : "them") + " on Push."
        : null,
    readonly:
      outcome.readonly > 0
        ? plural(outcome.readonly, "layer is", "layers are") + " read-only in ReRune (disabled keys, or plural and ICU texts) and " + (outcome.readonly === 1 ? "wasn't" : "weren't") + " changed."
        : null,
    outdated: outdated > 0 ? plural(outdated, "uploaded screenshot still shows", "uploaded screenshots still show") + " text that differs from ReRune." : null,
    missing:
      missing.length > 0
        ? plural(missing.length, "requested frame isn't", "requested frames aren't") + " in this file anymore: " + missing.map((frame) => frameLabel(frame)).join(", ") + "."
        : null,
  }
}

export const NO_REQUESTS_LEFT = "ReRune no longer asks for new screenshots of this file."
export const REQUEST_REMOVED = "Request removed."
export const REFRESH_BUSY = "Wait for the current task to finish."

export function previewsLine(count: number): string {
  return "Reset previews in these frames first. " + plural(count, "layer shows", "layers show") + " a preview."
}

export function refreshErrorLine(message: string): string {
  return "Screenshots weren't updated: " + message
}

export function refreshStepText(step: RefreshStep): string {
  switch (step.step) {
    case "scanning":
      return "Reading the requested frames…"
    case "updating":
      return "Updating layers from ReRune…"
    case "uploading":
      return progressText(step.run)
  }
}
