import { OBJECT_ID_PATTERN, SCREENSHOT_FRAME_CHECKS_MAX, STORED_SCREENSHOTS_MAX } from "../../shared/constants"
import type { ScannedNode } from "../../shared/messages"
import type { PlanContext, PushPlan } from "../../shared/push-plan"
import type { RemoteKeyState } from "../../shared/sync-state"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import type { PushRun } from "./push"
import {
  affectedFrames,
  closedGateText,
  emptyScreenshotRun,
  listFileScreenshots,
  screenshotFreshness,
  type ScreenshotFrame,
  type ScreenshotRun,
  type ScreenshotUploader,
  type ShotsState,
} from "./screenshots"
import { createStore, type Store } from "./store"

// Frames with linked keys but no screenshot in ReRune yet (the first push on a new project). Layers linked with Link
// exact matches are never pushed, so their frames got a screenshot only once a push changed one of their layers. The
// Push screen asks ReRune (E20) which frames of the review have a screenshot with each review and again just before
// each upload, and uploads every such frame of the review: with the push, or with Upload screenshots when there is
// nothing else to push. Same gate as every automatic upload, the setting included (off: nothing is read, shown or
// uploaded). The rules:
// - Only the reviewed scope: the frames of the layers the review scanned (the selection, or the open page). Frames on
//   other pages get theirs when their page is reviewed.
// - A frame is a layer's top frame (topFrameOf: the outermost frame, component, component set or instance under the
//   page or a section). Nested frames count for their top frame, and a frame in a section is a top frame (sections are
//   not frames). Text directly on a page or in a section has no frame and gets no screenshot, as on push.
// - A layer counts when it shows a key of this project that ReRune has as a text key: its link is its own ("ok") or it
//   is instance text that shows its main component's key ("inherited"), the layers a screenshot gets boxes for.
//   Unlinked layers, copies, overridden instance text and links to another project or to a key ReRune doesn't have (or
//   hasn't answered for) do not. The scan already leaves out hidden layers (so hidden frames and those in hidden
//   sections), locked ones unless included, `_` and numbers-only ones and language copies.
// - A frame with a layer Changed in ReRune waits for Update layers from ReRune, which gives the layer ReRune's text and
//   uploads the frame: a screenshot now would show the old text.
// - A frame has a screenshot when E20 lists one of this file with its frame id. A frame with a screenshot is uploaded
//   again only when a push changes it; outdated screenshots stay with the requests (refresh-requests.ts).
// - A frame whose upload failed for a lasting reason (too large, no size, an image ReRune refused, the project's
//   screenshot limit) is left out of later pushes in this plugin session; Upload screenshots tries it again.
// - ReRune is asked as little as it can be: up to 10 frames one by one (E20 `frame_id`), more with the file's whole
//   list; before an upload only the frames not known to have a screenshot are asked again.

// The layer shows a key of this project that ReRune has as a text key (E19 keeps the box of such a layer).
export function showsProjectKey(
  node: Pick<ScannedNode, "link" | "linkState">,
  projectId: string,
  remote: ReadonlyMap<string, Pick<RemoteKeyState, "found" | "type">>,
): boolean {
  const link = node.link
  if (link === null || link.p !== projectId || !OBJECT_ID_PATTERN.test(link.id) || (node.linkState !== "ok" && node.linkState !== "inherited")) {
    return false
  }
  const state = remote.get(link.id)
  return state !== undefined && state.found && state.type === "key"
}

// The top frames of the layers that show keys of this project, each once, in layer order.
export function linkedFrames(
  nodes: Iterable<ScannedNode>,
  projectId: string,
  remote: ReadonlyMap<string, Pick<RemoteKeyState, "found" | "type">>,
): ScreenshotFrame[] {
  const frames = new Map<string, ScreenshotFrame>()
  for (const node of nodes) {
    if (node.frameId !== null && !frames.has(node.frameId) && showsProjectKey(node, projectId, remote)) {
      frames.set(node.frameId, { frameId: node.frameId, frameName: node.frameName ?? "" })
    }
  }
  return [...frames.values()]
}

// The plan a note or a run works from: a review, or the check before a push or Upload screenshots.
export interface PlanShots {
  plan: Pick<PushPlan, "pulls">
  context: Pick<PlanContext, "nodes" | "projectId" | "remote">
}

// The frames of a plan's layers that show keys of this project, without those with a layer Changed in ReRune.
export function planFrames(prepared: PlanShots): ScreenshotFrame[] {
  const { context } = prepared
  const pulling = new Set<string>()
  for (const pull of prepared.plan.pulls) {
    for (const nodeId of pull.groupNodeIds) {
      const frameId = context.nodes.get(nodeId)?.frameId
      if (frameId !== null && frameId !== undefined) {
        pulling.add(frameId)
      }
    }
  }
  return linkedFrames(context.nodes.values(), context.projectId, context.remote).filter((frame) => !pulling.has(frame.frameId))
}

// What the plugin knows about a file's screenshots: the frames that have one, and which frames that covers.
export interface StoredFrames {
  fileKey: string
  frameIds: ReadonlySet<string>          // frames with a screenshot in ReRune
  checked: ReadonlySet<string> | null    // frames asked about one by one; null: frameIds is the file's whole list
}

// The linked frames known to have no screenshot (a frame that wasn't asked about is not counted).
export function missingFrames(linked: readonly ScreenshotFrame[], stored: Pick<StoredFrames, "frameIds" | "checked">): ScreenshotFrame[] {
  return linked.filter((frame) => !stored.frameIds.has(frame.frameId) && (stored.checked === null || stored.checked.has(frame.frameId)))
}

// E20 `?file_key=…`, every page. null when the file has more than 10,000 screenshots (the server's ceiling per project,
// so it cannot happen) or after Stop: without the whole list no frame counts as missing, so nothing is sent twice.
// Throws on errors.
export async function loadStoredFrames(
  api: Pick<FigmaApi, "screenshots">,
  projectId: string,
  fileKey: string,
  stopped?: () => boolean,
): Promise<StoredFrames | null> {
  const frameIds = new Set<string>()
  const complete = await listFileScreenshots(api, projectId, fileKey, { max: STORED_SCREENSHOTS_MAX, stopped }, (screenshot) => {
    if (screenshot.file_key === fileKey && typeof screenshot.frame_id === "string" && screenshot.frame_id !== "") {
      frameIds.add(screenshot.frame_id)
    }
  })
  return complete ? { fileKey, frameIds, checked: null } : null
}

// Which of `frames` have a screenshot. Frames `known` (for the same file) says have one are not asked again (a
// screenshot stays until the file is disconnected in ReRune); the others are asked one by one (E20 `frame_id`, one
// request each) when there are up to 10 of them, otherwise with the file's whole list. `onRead` comes before the first
// request. null: unknown (see loadStoredFrames), or Stop. Throws on errors.
export async function checkStoredFrames(
  api: Pick<FigmaApi, "screenshots">,
  projectId: string,
  fileKey: string,
  frames: readonly ScreenshotFrame[],
  known: StoredFrames | null,
  options: { stopped?: () => boolean; onRead?: () => void } = {},
): Promise<StoredFrames | null> {
  const base = known !== null && known.fileKey === fileKey ? known : null
  const open = frames.filter((frame) => base === null || !base.frameIds.has(frame.frameId))
  if (base !== null && open.length === 0) {
    return base
  }
  options.onRead?.()
  if (open.length > SCREENSHOT_FRAME_CHECKS_MAX) {
    return loadStoredFrames(api, projectId, fileKey, options.stopped)
  }
  const frameIds = new Set(base?.frameIds ?? [])
  for (const frame of open) {
    if (options.stopped?.() === true) {
      return null
    }
    const page = await api.screenshots(projectId, { file_key: fileKey, frame_id: frame.frameId, limit: 1 })
    const screenshots = Array.isArray(page.screenshots) ? page.screenshots : []
    if (screenshots.some((screenshot) => screenshot.file_key === fileKey && screenshot.frame_id === frame.frameId)) {
      frameIds.add(frame.frameId)
    }
  }
  const asked = open.map((frame) => frame.frameId)
  const checked = base !== null && base.checked === null ? null : new Set([...(base?.checked ?? []), ...asked])
  return { fileKey, frameIds, checked }
}

// One upload run's frames: `first` (the frames a push changed), then those of `more` not among them. Each frame once,
// so a run never uploads a frame twice.
export function framesWith(first: readonly ScreenshotFrame[], more: readonly ScreenshotFrame[]): ScreenshotFrame[] {
  const frames = new Map<string, ScreenshotFrame>()
  for (const frame of [...first, ...more]) {
    if (!frames.has(frame.frameId)) {
      frames.set(frame.frameId, frame)
    }
  }
  return [...frames.values()]
}

// After a run for `fileKey`: the frames it uploaded have a screenshot now. A list of another file is dropped.
export function withUploaded(stored: StoredFrames | null, fileKey: string, frameIds: readonly string[]): StoredFrames | null {
  if (stored === null || stored.fileKey !== fileKey) {
    return null
  }
  return frameIds.length === 0 ? stored : { ...stored, frameIds: new Set([...stored.frameIds, ...frameIds]) }
}

// With a review: which of its frames with linked keys have a screenshot, when the gate (the setting included) is open
// and there are such frames. null shows no note: the gate is closed, nothing is linked, or ReRune couldn't be asked
// (silent; the push asks again).
export async function readStoredFrames(
  deps: { api: Pick<FigmaApi, "screenshots">; projectId: string; uploader: Pick<ScreenshotUploader, "prepare"> | null },
  linked: readonly ScreenshotFrame[],
): Promise<StoredFrames | null> {
  if (deps.uploader === null || linked.length === 0) {
    return null
  }
  try {
    const { gate } = await deps.uploader.prepare()
    if (!gate.enabled || gate.fileKey === null) {
      return null
    }
    return await checkStoredFrames(deps.api, deps.projectId, gate.fileKey, linked, null)
  } catch {
    return null
  }
}

// Frames whose upload failed for a lasting reason (ScreenshotProblem.lasting), per project and file, for this plugin
// session: a push leaves them out (it would export and send them again for the same answer), Upload screenshots tries
// them again. A frame that uploads is forgotten.
export interface FailedFrames {
  has(projectId: string, fileKey: string, frameId: string): boolean
  record(projectId: string, fileKey: string, run: Pick<ScreenshotRun, "problems" | "uploadedFrameIds">): void
}

export function createFailedFrames(): FailedFrames {
  const failed = new Set<string>()
  const id = (projectId: string, fileKey: string, frameId: string) => projectId + "/" + fileKey + "/" + frameId
  return {
    has: (projectId, fileKey, frameId) => failed.has(id(projectId, fileKey, frameId)),
    record(projectId, fileKey, run) {
      for (const problem of run.problems) {
        if (problem.lasting === true) {
          failed.add(id(projectId, fileKey, problem.frameId))
        }
      }
      for (const frameId of run.uploadedFrameIds) {
        failed.delete(id(projectId, fileKey, frameId))
      }
    },
  }
}

// The Push screen's list of the file's screenshots. `set` replaces it, and a read begun before is dropped, so a
// review's list that lands after a newer one never brings back frames since uploaded; `add` (a run's uploads) adds
// frames without that, and a read begun before it gets them too. So a pull's upload never costs the review its list.
export interface StoredSlot {
  get(): StoredFrames | null
  set(next: StoredFrames | null): void
  add(fileKey: string, frameIds: readonly string[]): void
  begin(): (found: StoredFrames | null) => void
}

export function createStoredSlot(onChange: (next: StoredFrames | null) => void = () => {}): StoredSlot {
  let current: StoredFrames | null = null
  let generation = 0
  // The runs' uploads since the last set, for the reads begun before them.
  let uploads: { fileKey: string; frameIds: readonly string[] }[] = []
  const set = (next: StoredFrames | null) => {
    generation++
    uploads = []
    current = next
    onChange(next)
  }
  return {
    get: () => current,
    set,
    add(fileKey, frameIds) {
      if (frameIds.length === 0) {
        return
      }
      uploads.push({ fileKey, frameIds })
      const next = withUploaded(current, fileKey, frameIds)
      if (next !== current) {
        current = next
        onChange(next)
      }
    },
    begin() {
      const mine = generation
      const from = uploads.length
      return (found) => {
        if (mine !== generation) {
          return
        }
        set(uploads.slice(from).reduce((list, upload) => withUploaded(list, upload.fileKey, upload.frameIds), found))
      }
    },
  }
}

// One upload run of the Push screen: "off" (the gate is closed; `unavailable`: ReRune couldn't be asked about
// screenshots; `closed`: why else, for Upload screenshots), "none" (nothing left to upload), "done" or "failed" (the
// run couldn't start).
export type ShotsOutcome =
  | { kind: "off"; unavailable: string | null; closed: string }
  | { kind: "none" }
  | { kind: "done"; run: ScreenshotRun }
  | { kind: "failed"; message: string }

export interface ShotsDeps {
  api: Pick<FigmaApi, "screenshots">
  projectId: string
  uploader: ScreenshotUploader
  stored: StoredSlot
  failed: FailedFrames
  stopped(): boolean                         // Stop
  onChecking(): void                         // ReRune is asked which frames have a screenshot
  onProgress(run: ScreenshotRun): void
}

// A push's (or a pull's, Overwrite's, Take ReRune text's, Upload screenshots') screenshots (§7.13 rule 11, §7.16): the
// gate with the setting, evaluated now; then `changed` and the frames of `linked` (the plan's frames with linked keys,
// [] for all but a push and Upload screenshots) that have no screenshot in ReRune (checkStoredFrames, from what the
// review found), each frame once. Frames that failed for a lasting reason this session are left out of `linked`, unless
// `retryFailed` (Upload screenshots). After the project's screenshot limit, the rest of the frames without a screenshot
// are left out (uploadScreenshots). The list follows: unknown while the gate is closed, and the frames a run uploaded
// join it (those it didn't upload, after Stop or a problem, still count as missing).
export async function runUpload(
  deps: ShotsDeps,
  changed: readonly ScreenshotFrame[],
  linked: readonly ScreenshotFrame[],
  retryFailed = false,
): Promise<ShotsOutcome> {
  if (changed.length === 0 && linked.length === 0) {
    return { kind: "none" }
  }
  try {
    const { gate, availability } = await deps.uploader.prepare()
    if (!gate.enabled || gate.fileKey === null) {
      deps.stored.set(null)
      return { kind: "off", unavailable: gate.reason === "unavailable" ? availability.error : null, closed: closedGateText(gate, availability) }
    }
    const fileKey = gate.fileKey
    const candidates = retryFailed ? linked : linked.filter((frame) => !deps.failed.has(deps.projectId, fileKey, frame.frameId))
    let missing: ScreenshotFrame[] = []
    if (candidates.length > 0) {
      const known = deps.stored.get()
      const checked = await checkStoredFrames(deps.api, deps.projectId, fileKey, candidates, known, { stopped: deps.stopped, onRead: deps.onChecking }).catch(
        () => null,
      )
      if (deps.stopped()) {
        return { kind: "done", run: { ...emptyScreenshotRun(changed.length), stopped: "cancelled", notUploaded: changed.length } }
      }
      if (checked !== null && checked !== known) {
        deps.stored.set(checked)
      }
      // When ReRune couldn't be asked, what the review found still counts.
      const list = checked ?? (known !== null && known.fileKey === fileKey ? known : null)
      missing = list === null ? [] : missingFrames(candidates, list)
    }
    const frames = framesWith(changed, missing)
    if (frames.length === 0) {
      return { kind: "none" }
    }
    const changedIds = new Set(changed.map((frame) => frame.frameId))
    const newFrameIds = new Set(missing.map((frame) => frame.frameId).filter((frameId) => !changedIds.has(frameId)))
    deps.onProgress(emptyScreenshotRun(frames.length))
    const run = await deps.uploader.upload(frames, {
      fileKey,
      freshness: screenshotFreshness(availability),
      stopped: deps.stopped,
      onProgress: deps.onProgress,
      newFrameIds,
    })
    deps.stored.add(fileKey, run.uploadedFrameIds)
    deps.failed.record(deps.projectId, fileKey, run)
    return { kind: "done", run }
  } catch (caught) {
    return { kind: "failed", message: userMessage(caught) }
  }
}

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many)
}

// "3 frames with linked keys have no screenshot in ReRune yet.", and when the push uploads them " Push uploads them too."
export function missingLine(count: number, pushable: boolean): string {
  const line = plural(count, "frame with linked keys has", "frames with linked keys have") + " no screenshot in ReRune yet."
  return pushable ? line + (count === 1 ? " Push uploads it too." : " Push uploads them too.") : line
}

// Upload screenshots found nothing left to upload (someone uploaded them meanwhile, or the layers changed).
export const NONE_MISSING = "Every frame with linked keys here has a screenshot in ReRune now."

export interface PushShotsState {
  stored: StoredFrames | null                                 // what the review found (null: unknown, or the gate is closed)
  shots: ShotsState | null                                    // the last run: the check before it, its progress, its result
  stopping: boolean
  note: { tone: "good" | "warning"; text: string } | null     // why Upload screenshots uploaded nothing
}

export interface PushShotsDeps {
  api: Pick<FigmaApi, "screenshots">
  projectId: string
  uploader: ScreenshotUploader | null                         // null: no screenshots at all
  failed: FailedFrames
}

// The Push screen's screenshots: the note's list read with each review, the runs after a push, a pull, Overwrite and
// Take ReRune text, Upload screenshots, and Stop. The screen holds the work lock around each run and checks the plan's
// layers again by id before it (checkPlan); `deps` are read at each call (the project, the uploader).
export interface PushShots {
  store: Store<PushShotsState>
  // A review starts: the list, the run and the note go, and a read under way is dropped.
  reset(): void
  // The review's list, in the background.
  read(prepared: PlanShots): void
  // Another action starts: its run and note replace these.
  clear(): void
  // The note's frames: those of the plan without a screenshot, without the ones a push leaves out (failed for a lasting
  // reason) when `pushable`; none while the list is unknown or a run goes on (its progress shows instead).
  noteFrames(prepared: PlanShots, pushable: boolean): ScreenshotFrame[]
  // After a push: the frames it changed and the plan's frames without a screenshot; only the changed ones when a push
  // request failed (ReRune is likely out of reach; they wait for the next push).
  afterPush(prepared: PlanShots, pushed: Pick<PushRun, "affectedNodeIds" | "requestError">): Promise<void>
  // After a pull, Overwrite or Take ReRune text: the frames it changed.
  upload(changed: readonly ScreenshotFrame[]): Promise<void>
  // Upload screenshots: the plan's frames without a screenshot, failed ones included; the note says when nothing went.
  uploadMissing(prepared: PlanShots): Promise<void>
  stop(): void
}

export function createPushShots(deps: () => PushShotsDeps): PushShots {
  const store = createStore<PushShotsState>({ stored: null, shots: null, stopping: false, note: null })
  const slot = createStoredSlot((stored) => store.set((state) => ({ ...state, stored })))
  let stopped = false
  const setShots = (shots: ShotsState | null) => store.set((state) => ({ ...state, shots }))

  async function run(changed: readonly ScreenshotFrame[], linked: readonly ScreenshotFrame[], retryFailed: boolean): Promise<ShotsOutcome> {
    const { api, projectId, uploader, failed } = deps()
    // Nothing to upload (Take ReRune text on text without a frame): the push's result stays.
    if (uploader === null || (changed.length === 0 && linked.length === 0)) {
      return { kind: "none" }
    }
    stopped = false
    store.set((state) => ({ ...state, stopping: false }))
    const outcome = await runUpload(
      {
        api,
        projectId,
        uploader,
        stored: slot,
        failed,
        stopped: () => stopped,
        onChecking: () => setShots({ kind: "checking" }),
        onProgress: (next) => setShots({ kind: "running", run: next }),
      },
      changed,
      linked,
      retryFailed,
    )
    // A gate that is off stays silent (Settings and the file banner say why), except when ReRune couldn't be asked.
    if (outcome.kind === "done") {
      setShots({ kind: "done", run: outcome.run })
    } else if (outcome.kind === "failed") {
      setShots({ kind: "unavailable", message: outcome.message })
    } else if (outcome.kind === "off" && outcome.unavailable !== null) {
      setShots({ kind: "unavailable", message: outcome.unavailable })
    } else if (store.get().shots?.kind === "checking") {
      setShots(null)
    }
    return outcome
  }

  return {
    store,
    reset() {
      slot.set(null)
      store.set((state) => ({ ...state, shots: null, stopping: false, note: null }))
    },
    read(prepared) {
      const { api, projectId, uploader } = deps()
      const done = slot.begin()
      void readStoredFrames({ api, projectId, uploader }, planFrames(prepared)).then(done)
    },
    clear() {
      store.set((state) => ({ ...state, shots: null, note: null }))
    },
    noteFrames(prepared, pushable) {
      const { stored, shots } = store.get()
      if (stored === null || shots?.kind === "running" || shots?.kind === "checking") {
        return []
      }
      const missing = missingFrames(planFrames(prepared), stored)
      if (!pushable) {
        return missing
      }
      const { projectId, failed } = deps()
      return missing.filter((frame) => !failed.has(projectId, stored.fileKey, frame.frameId))
    },
    async afterPush(prepared, pushed) {
      await run(affectedFrames(pushed.affectedNodeIds, prepared.context.nodes), pushed.requestError === null ? planFrames(prepared) : [], false)
    },
    async upload(changed) {
      await run(changed, [], false)
    },
    async uploadMissing(prepared) {
      const outcome = await run([], planFrames(prepared), true)
      if (outcome.kind === "none") {
        store.set((state) => ({ ...state, note: { tone: "good", text: NONE_MISSING } }))
      } else if (outcome.kind === "off" && outcome.unavailable === null) {
        store.set((state) => ({ ...state, note: { tone: "warning", text: outcome.closed } }))
      }
    },
    stop() {
      stopped = true
      store.set((state) => ({ ...state, stopping: true }))
    },
  }
}
