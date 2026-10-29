import type { FigmaMetaResponse, FigmaScreenshotBox, FigmaScreenshotContentType, FigmaScreenshotMeta, FigmaScreenshotUploadResponse, FigmaUser } from "../../shared/api-types"
import {
  MAX_IMAGE_SIDE,
  MAX_IMAGE_UPLOAD_BYTES,
  RETRY_AFTER_MAX_SECONDS,
  SCREENSHOT_EXPORT_IDLE_MS,
  SCREENSHOT_MAX_BOXES,
  SCREENSHOT_NAME_MAX_RUNES,
  SCREENSHOT_RATE_LIMIT_RETRIES,
  SCREENSHOT_SIZE_TOLERANCE_PX,
} from "../../shared/constants"
import { EDIT_KEYS_PERMISSION, syncPauseOf, type SyncPauseReason } from "../../shared/file-link"
import type { Box, FileSettings, FrameSkipReason, MainToUiOf, ScannedNode } from "../../shared/messages"
import { firstRunes, trimSpace } from "../../shared/text"
import { capturedText, fitMetaBudget, isWireTextStyle, scaleTextStyle } from "../../shared/text-style"
import { ApiError, RATE_LIMIT_DEFAULT_SECONDS, RATE_LIMIT_MESSAGE, REASON_MESSAGES, userMessage } from "../api/client"
import type { FigmaApi, ScreenshotUpload } from "../api/figma-api"
import { RequestTimeoutError, type UiBus } from "../bus"
import type { PixelSize } from "../image"
import { BRANCH_MESSAGE } from "./file-link"

// Screenshots of changed frames (§7.16, §7.13 rule 11, D4, D17, D43; after a push, Overwrite, Take ReRune text and
// Update layers from ReRune, SF1): which frames to upload, whether uploads may run, the export through main one frame
// at a time, and the sequential E19 upload queue.

export type FrameImage = Omit<MainToUiOf<"frame-image">, "type" | "requestId">
export type FrameExportResult = { kind: "image"; image: FrameImage } | { kind: "skipped"; reason: FrameSkipReason }

// What the plugin knows about the server (E1 screenshots_enabled) and the user (E8 sandbox_expires_at). null: not
// loaded (yet); `error` is the last load failure.
export interface Availability { meta: FigmaMetaResponse | null; user: FigmaUser | null; error: string | null }

export interface AvailabilityLoader {
  current(): Availability
  // Fetches whatever is not known yet (E1 and E8 in parallel), once; a failed fetch is tried again next time.
  load(): Promise<Availability>
  // E8's user from the Project screen, so the sandbox check needs no second E8 call.
  setUser(user: FigmaUser): void
  // A 503 design_storage_disabled during an upload: screenshots stay off for the rest of the plugin session.
  disable(): void
  // Sign-out: the user is forgotten; what the server said about screenshots stays.
  reset(): void
}

const OFF_META: FigmaMetaResponse = {
  api_version: 1,
  screenshots_enabled: false,
  max_image_bytes: MAX_IMAGE_UPLOAD_BYTES,
  max_image_side: MAX_IMAGE_SIDE,
  max_batch_size: 100,
  server_time: "",
  screenshot_freshness: false,
}

export function createAvailability(api: Pick<FigmaApi, "meta" | "projects">): AvailabilityLoader {
  let meta: FigmaMetaResponse | null = null
  let user: FigmaUser | null = null
  let error: string | null = null
  let generation = 0
  let pending: Promise<Availability> | null = null
  const snapshot = (): Availability => ({ meta, user, error })

  return {
    current: snapshot,
    load() {
      if (meta !== null && user !== null) {
        return Promise.resolve(snapshot())
      }
      if (pending !== null) {
        return pending
      }
      const mine = generation
      const loadMeta = meta === null ? api.meta() : Promise.resolve(meta)
      const loadUser = user === null ? api.projects().then((response) => response.user) : Promise.resolve(user)
      const started = Promise.allSettled([loadMeta, loadUser]).then(([metaResult, userResult]) => {
        if (mine === generation) {
          if (metaResult.status === "fulfilled" && meta === null) {
            meta = metaResult.value
          }
          if (userResult.status === "fulfilled" && user === null) {
            user = userResult.value
          }
          const failed = metaResult.status === "rejected" ? metaResult.reason : userResult.status === "rejected" ? userResult.reason : null
          error = failed === null ? null : userMessage(failed)
          pending = null
        }
        return snapshot()
      })
      pending = started
      return started
    },
    setUser(next) {
      user = next
    },
    disable() {
      meta = { ...(meta ?? OFF_META), screenshots_enabled: false }
    },
    reset() {
      generation++
      pending = null
      user = null
      error = null
    },
  }
}

// E1 screenshot_freshness (SF5b): only such a server takes the boxes' text and style (an older one answers 400).
export function screenshotFreshness(availability: Availability): boolean {
  return availability.meta?.screenshot_freshness === true
}

export type ScreenshotBlock = "sandbox" | "server_disabled" | "pref_off" | "unavailable" | SyncPauseReason | "no_permission"

export interface ScreenshotGate { enabled: boolean; reason: ScreenshotBlock | null; fileKey: string | null }

export interface ScreenshotGateInput {
  pref: boolean                      // Settings → "Upload screenshots of changed frames"
  availability: Availability
  settings: FileSettings | null
  rootName: string
  permissions: readonly string[]
}

// §7.16: uploads run only when E1 says enabled, the user is not a sandbox user, the file is a confirmed main file
// (no branch, not a suspected copy, D43) and the user may edit keys (E19 needs edit_keys).
export function screenshotGate(input: ScreenshotGateInput): ScreenshotGate {
  const blocked = (reason: ScreenshotBlock): ScreenshotGate => ({ enabled: false, reason, fileKey: null })
  const { meta, user } = input.availability
  if (user !== null && user.sandbox_expires_at !== null) {
    return blocked("sandbox")
  }
  if (meta !== null && !meta.screenshots_enabled) {
    return blocked("server_disabled")
  }
  if (!input.pref) {
    return blocked("pref_off")
  }
  if (meta === null || user === null) {
    return blocked("unavailable")
  }
  const pause = syncPauseOf(input.settings, input.rootName)
  if (pause.paused || input.settings === null) {
    return blocked(pause.reason ?? "no_file")
  }
  if (!input.permissions.includes(EDIT_KEYS_PERMISSION)) {
    return blocked("no_permission")
  }
  return { enabled: true, reason: null, fileKey: input.settings.fileKey }
}

export const SCREENSHOTS_ON_HINT = "Screenshots of the frames you push or update from ReRune are uploaded to ReRune, so translators and developers see where each key is used."
export const SERVER_DISABLED_HINT = "Screenshots aren't available on this ReRune server."
export const NO_FILE_HINT = "Screenshots upload once this file's Figma link is saved."
export const COPY_HINT = "Screenshots wait until you confirm this file under Figma file."
export const NO_PERMISSION_HINT = "Uploading screenshots needs the Edit keys permission in this project."
export const CHECKING_HINT = "Checking whether screenshots can be uploaded…"

export interface ScreenshotSetting { visible: boolean; toggle: boolean; hint: string | null }

// Settings → Push (§7.8): the toggle is hidden for sandbox users (D4), and so until E8 has said the account is not a
// sandbox account (still loading, or failed: the hint says which); a server without screenshot storage gets a note
// instead of the toggle; otherwise the hint says what happens on push, or why nothing is uploaded.
export function screenshotSetting(gate: ScreenshotGate, availability: Availability): ScreenshotSetting {
  if (availability.user === null && gate.reason !== "server_disabled") {
    return { visible: true, toggle: false, hint: availability.error === null ? CHECKING_HINT : unavailableHint(availability.error) }
  }
  switch (gate.reason) {
    case "sandbox":
      return { visible: false, toggle: false, hint: null }
    case "server_disabled":
      return { visible: true, toggle: false, hint: SERVER_DISABLED_HINT }
    case null:
      return { visible: true, toggle: true, hint: SCREENSHOTS_ON_HINT }
    case "pref_off":
      return { visible: true, toggle: true, hint: null }
    case "unavailable":
      return { visible: true, toggle: true, hint: availability.error === null ? null : unavailableHint(availability.error) }
    case "no_file":
      return { visible: true, toggle: true, hint: NO_FILE_HINT }
    case "branch":
      return { visible: true, toggle: true, hint: BRANCH_MESSAGE }
    case "possible_copy":
      return { visible: true, toggle: true, hint: COPY_HINT }
    case "no_permission":
      return { visible: true, toggle: true, hint: NO_PERMISSION_HINT }
  }
}

function unavailableHint(error: string): string {
  return "ReRune couldn't be asked about screenshots: " + error
}

export interface ScreenshotFrame { frameId: string; frameName: string }

// §7.13 rule 11: the top frames of the layers a push changed, each once, in the order the layers come. Text that
// sits directly on a page or in a section has no frame and gets no screenshot.
export function affectedFrames(nodeIds: readonly string[], nodes: ReadonlyMap<string, Pick<ScannedNode, "frameId" | "frameName">>): ScreenshotFrame[] {
  const frames = new Map<string, ScreenshotFrame>()
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId)
    if (node === undefined || node.frameId === null || frames.has(node.frameId)) {
      continue
    }
    frames.set(node.frameId, { frameId: node.frameId, frameName: node.frameName ?? "" })
  }
  return [...frames.values()]
}

// §7.16: when the decoded image differs from the expected size by more than 2 px, boxes are rescaled by
// actual/expected; they are always clamped to the decoded size (E19 drops boxes that leave the image). A rescale
// scales the style's lengths by actual/expected height too (contract §3.3).
export function fitBoxes(boxes: readonly Box[], expected: PixelSize, actual: PixelSize): Box[] {
  const rescale =
    Math.abs(actual.width - expected.width) > SCREENSHOT_SIZE_TOLERANCE_PX || Math.abs(actual.height - expected.height) > SCREENSHOT_SIZE_TOLERANCE_PX
  const sx = rescale && expected.width > 0 ? actual.width / expected.width : 1
  const sy = rescale && expected.height > 0 ? actual.height / expected.height : 1
  const fitted: Box[] = []
  for (const box of boxes) {
    const x = Math.max(0, Math.round(box.x * sx))
    const y = Math.max(0, Math.round(box.y * sy))
    const x2 = Math.min(actual.width, Math.round((box.x + box.w) * sx))
    const y2 = Math.min(actual.height, Math.round((box.y + box.h) * sy))
    if (x2 > x && y2 > y) {
      const style = rescale && box.style !== null ? scaleTextStyle(box.style, sy) : box.style
      fitted.push({ ...box, x, y, w: x2 - x, h: y2 - y, style })
    }
  }
  return fitted
}

export function contentTypeOf(format: FrameImage["format"]): FigmaScreenshotContentType {
  return format === "JPG" ? "image/jpeg" : "image/png"
}

// `<frameId with : and ; → _>.jpg|png` (§7.16).
export function imageFileName(frameId: string, format: FrameImage["format"]): string {
  return frameId.replace(/[:;]/g, "_") + (format === "JPG" ? ".jpg" : ".png")
}

// A name as the server stores it (strings.TrimSpace, cut to 200 runes, §4.0).
function cleanName(name: string): string {
  return firstRunes(trimSpace(name), SCREENSHOT_NAME_MAX_RUNES)
}

// Main only captures valid text and styles; anything else is left out here too, since one invalid box fails the
// whole upload (400 "invalid meta").
function wireBox(box: Box, freshness: boolean): FigmaScreenshotBox {
  const wire: FigmaScreenshotBox = { key_id: box.keyId, node_id: box.nodeId, x: box.x, y: box.y, w: box.w, h: box.h }
  if (freshness && typeof box.text === "string" && capturedText(box.text) !== null) {
    wire.text = box.text
  }
  if (freshness && box.style !== null && isWireTextStyle(box.style)) {
    wire.style = box.style
  }
  return wire
}

// The E19 `meta` part: the decoded size and the fitted boxes (at most 500). With `freshness` (E1
// screenshot_freshness) each box also carries its text and style, within the 900,000-byte budget (SF2c); without it
// the boxes are sent as before, since an older server rejects unknown fields.
export function screenshotMeta(image: FrameImage, fileKey: string, size: PixelSize, boxes: readonly Box[], freshness: boolean): FigmaScreenshotMeta {
  const meta: FigmaScreenshotMeta = {
    file_key: fileKey,
    frame_id: image.frameId,
    frame_name: cleanName(image.frameName),
    page_id: image.pageId,
    page_name: cleanName(image.pageName),
    width: size.width,
    height: size.height,
    boxes: boxes.slice(0, SCREENSHOT_MAX_BOXES).map((box) => wireBox(box, freshness)),
  }
  return freshness ? fitMetaBudget(meta) : meta
}

export function frameImageOf(message: MainToUiOf<"frame-image">): FrameImage {
  return {
    frameId: message.frameId,
    frameName: message.frameName,
    pageId: message.pageId,
    pageName: message.pageName,
    format: message.format,
    bytes: message.bytes,
    width: message.width,
    height: message.height,
    boxes: message.boxes,
  }
}

// One frame through main (screenshots-export with a single id): at most one image is in memory at a time, and the
// queue can stop between frames without main exporting the rest.
export async function requestFrameImage(bus: Pick<UiBus, "request">, frameId: string): Promise<FrameExportResult> {
  const images: FrameImage[] = []
  const done = await bus.request((requestId) => ({ type: "screenshots-export", requestId, frameIds: [frameId] }), {
    done: (message) => {
      if (message.type === "frame-image") {
        images.push(frameImageOf(message))
        return undefined
      }
      return message.type === "frame-images-done" ? message : undefined
    },
    idleMs: SCREENSHOT_EXPORT_IDLE_MS,
  })
  const image = images.find((entry) => entry.frameId === frameId)
  if (image !== undefined) {
    return { kind: "image", image }
  }
  return { kind: "skipped", reason: done.skipped.find((entry) => entry.frameId === frameId)?.reason ?? "export_failed" }
}

export const SKIP_MESSAGES: Record<FrameSkipReason, string> = {
  not_found: "The frame isn't in this file anymore.",
  no_bounds: "The frame has no size, so there is nothing to show.",
  too_large: "The frame image stays above 2 MB, even at a quarter of its size.",
  export_failed: "Figma couldn't export the frame.",
  preview_active: "The frame shows a language preview. Reset previews and push again to upload it.",
}

export const TOO_LARGE_MESSAGE = "The frame image is larger than 2 MB."
export const INVALID_IMAGE_MESSAGE = REASON_MESSAGES.invalid_image

export type ScreenshotStop = "disabled" | "unavailable" | "forbidden" | "signed_out" | "rate_limited" | "unresponsive" | "cancelled"

export interface ScreenshotProblem { frameId: string; frameName: string; message: string }

export interface ScreenshotRun {
  total: number
  done: number                 // frames handled (uploaded, skipped or failed)
  uploaded: number             // E19 answered 200 (unchanged images included)
  unchanged: number            // same bytes as the stored image: the server kept it and updated names and boxes
  droppedBoxes: number         // boxes E19 left out (key deleted, out of the image)
  outdated: number             // uploaded screenshots that still show text other than ReRune's (outdated_box_count > 0)
  problems: ScreenshotProblem[]
  stopped: ScreenshotStop | null
  stopMessage: string | null   // null for a silent stop (screenshots switched off, signed out)
  notUploaded: number          // frames left when the queue stopped
}

export function emptyScreenshotRun(total: number): ScreenshotRun {
  return { total, done: 0, uploaded: 0, unchanged: 0, droppedBoxes: 0, outdated: 0, problems: [], stopped: null, stopMessage: null, notUploaded: 0 }
}

export type UploadErrorAction =
  | { kind: "retry"; waitMs: number }
  | { kind: "stop"; stop: ScreenshotStop; message: string | null }
  | { kind: "frame"; message: string }

// §7.16 / §7.20: 429 → wait Retry-After (≤ 60 s) and try the frame again (twice, then stop); 503 → stop (a
// design_storage_disabled 503 switches screenshots off for the session, silently, Appendix B.1); 403 without a
// reason (sandbox, or no edit_keys) → stop; 401 → stop (the client signs out); anything else fails this frame only.
export function uploadErrorAction(error: unknown, attempt: number): UploadErrorAction {
  if (!(error instanceof ApiError)) {
    return { kind: "frame", message: userMessage(error) }
  }
  if (error.status === 429) {
    if (attempt < SCREENSHOT_RATE_LIMIT_RETRIES) {
      return { kind: "retry", waitMs: Math.min(error.retryAfterSeconds ?? RATE_LIMIT_DEFAULT_SECONDS, RETRY_AFTER_MAX_SECONDS) * 1000 }
    }
    return { kind: "stop", stop: "rate_limited", message: RATE_LIMIT_MESSAGE }
  }
  if (error.status === 503) {
    return error.reason === "design_storage_disabled" ? { kind: "stop", stop: "disabled", message: null } : { kind: "stop", stop: "unavailable", message: userMessage(error) }
  }
  if (error.status === 403 && error.reason === null) {
    return { kind: "stop", stop: "forbidden", message: userMessage(error) }
  }
  if (error.status === 401) {
    return { kind: "stop", stop: "signed_out", message: null }
  }
  return { kind: "frame", message: userMessage(error) }
}

export interface ScreenshotDeps {
  exportFrame(frameId: string): Promise<FrameExportResult>
  measure(bytes: Uint8Array, type: FigmaScreenshotContentType): Promise<PixelSize | null>
  upload(upload: ScreenshotUpload): Promise<FigmaScreenshotUploadResponse>
  sleep(ms: number): Promise<void>
  onDisabled?(): void
}

export interface ScreenshotRunOptions {
  fileKey: string
  freshness: boolean                          // E1 screenshot_freshness: send each box's text and style
  stopped?(): boolean                         // "Stop": checked before each upload and during a 429 wait
  onProgress?(run: ScreenshotRun): void
}

// A 429 wait (up to 60 s, twice per frame) is slept in steps, so Stop ends the queue within a step.
export const STOP_POLL_MS = 250

type Settled = { ok: true; result: FrameExportResult } | { ok: false; error: unknown }

type FrameOutcome = { kind: "next" } | { kind: "stop"; stop: ScreenshotStop; message: string | null }

// The upload queue (§7.16): frames in order, one export ahead of the upload (main exports the next frame while
// this one uploads), one E19 request at a time. Uploads are never retried except after a 429.
export async function uploadScreenshots(deps: ScreenshotDeps, frames: readonly ScreenshotFrame[], options: ScreenshotRunOptions): Promise<ScreenshotRun> {
  const run = emptyScreenshotRun(frames.length)
  const progress = () => options.onProgress?.({ ...run, problems: run.problems.slice() })
  const stopRun = (index: number, stop: ScreenshotStop, message: string | null) => {
    run.stopped = stop
    run.stopMessage = message
    run.notUploaded = frames.length - index
  }
  const start = (frame: ScreenshotFrame): Promise<Settled> =>
    deps.exportFrame(frame.frameId).then(
      (result): Settled => ({ ok: true, result }),
      (error: unknown): Settled => ({ ok: false, error }),
    )

  progress()
  let next: Promise<Settled> | null = frames.length > 0 ? start(frames[0]) : null
  for (let index = 0; index < frames.length && next !== null; index++) {
    const settled: Settled = await next
    if (options.stopped?.() === true) {
      stopRun(index, "cancelled", null)
      break
    }
    next = index + 1 < frames.length ? start(frames[index + 1]) : null
    const outcome = await handleFrame(deps, frames[index], settled, run, options)
    if (outcome.kind === "stop") {
      if (outcome.stop === "disabled") {
        deps.onDisabled?.()
      }
      stopRun(index, outcome.stop, outcome.message)
      break
    }
    run.done++
    progress()
  }
  progress()
  return run
}

async function handleFrame(deps: ScreenshotDeps, frame: ScreenshotFrame, settled: Settled, run: ScreenshotRun, options: ScreenshotRunOptions): Promise<FrameOutcome> {
  const problem = (message: string, frameName = frame.frameName): FrameOutcome => {
    run.problems.push({ frameId: frame.frameId, frameName, message })
    return { kind: "next" }
  }
  if (!settled.ok) {
    if (settled.error instanceof RequestTimeoutError) {
      return { kind: "stop", stop: "unresponsive", message: settled.error.message }
    }
    return problem(SKIP_MESSAGES.export_failed)
  }
  if (settled.result.kind === "skipped") {
    return problem(SKIP_MESSAGES[settled.result.reason])
  }
  const image = settled.result.image
  const name = image.frameName === "" ? frame.frameName : image.frameName
  // Checked here as well: a body above the server's limit fails before CORS and would read as a network error.
  if (image.bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    return problem(TOO_LARGE_MESSAGE, name)
  }
  const contentType = contentTypeOf(image.format)
  const expected = { width: image.width, height: image.height }
  const size = (await deps.measure(image.bytes, contentType).catch(() => null)) ?? expected
  if (size.width < 1 || size.height < 1 || Math.max(size.width, size.height) > MAX_IMAGE_SIDE) {
    return problem(INVALID_IMAGE_MESSAGE, name)
  }
  const upload: ScreenshotUpload = {
    image: image.bytes,
    contentType,
    fileName: imageFileName(image.frameId, image.format),
    meta: screenshotMeta(image, options.fileKey, size, fitBoxes(image.boxes, expected, size), options.freshness),
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await deps.upload(upload)
      run.uploaded++
      if (response.unchanged_image === true) {
        run.unchanged++
      }
      run.droppedBoxes += Array.isArray(response.dropped_boxes) ? response.dropped_boxes.length : 0
      const outdated = response.screenshot?.outdated_box_count
      if (typeof outdated === "number" && outdated > 0) {
        run.outdated++
      }
      return { kind: "next" }
    } catch (error) {
      const action = uploadErrorAction(error, attempt)
      if (action.kind === "retry") {
        if (!(await waitUnlessStopped(deps, action.waitMs, options.stopped))) {
          return { kind: "stop", stop: "cancelled", message: null }
        }
        continue
      }
      if (action.kind === "stop") {
        return action
      }
      return problem(action.message, name)
    }
  }
}

// Sleeps `ms` in steps of STOP_POLL_MS; false as soon as the designer pressed Stop (then the frame is not sent again).
async function waitUnlessStopped(deps: Pick<ScreenshotDeps, "sleep">, ms: number, stopped: (() => boolean) | undefined): Promise<boolean> {
  for (let left = ms; left > 0; left -= STOP_POLL_MS) {
    if (stopped?.() === true) {
      return false
    }
    await deps.sleep(Math.min(STOP_POLL_MS, left))
  }
  return stopped?.() !== true
}

export function screenshotDeps(input: {
  api: Pick<FigmaApi, "uploadScreenshot">
  bus: Pick<UiBus, "request">
  projectId: string
  measure: ScreenshotDeps["measure"]
  sleep?: ScreenshotDeps["sleep"]
  onDisabled?: () => void
}): ScreenshotDeps {
  return {
    exportFrame: (frameId) => requestFrameImage(input.bus, frameId),
    measure: input.measure,
    upload: (upload) => input.api.uploadScreenshot(input.projectId, upload),
    sleep: input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    onDisabled: input.onDisabled,
  }
}

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many)
}

// Server messages (a 403's text) may lack the final full stop.
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : text + "."
}

export interface ScreenshotSummary { tone: "good" | "warning"; message: string }

// One line for the push results; the per-frame problems are listed below it (groupProblems).
export function screenshotSummary(run: ScreenshotRun): ScreenshotSummary | null {
  const parts: string[] = []
  if (run.uploaded > 0) {
    parts.push(plural(run.uploaded, "screenshot", "screenshots") + " uploaded" + (run.unchanged > 0 ? " (" + run.unchanged + " unchanged)" : "") + ".")
  }
  if (run.droppedBoxes > 0) {
    parts.push(plural(run.droppedBoxes, "layer position wasn't", "layer positions weren't") + " saved because the key no longer exists or the layer is outside the image.")
  }
  if (run.stopped !== null && run.stopMessage !== null) {
    parts.push("Screenshot upload stopped: " + sentence(run.stopMessage))
  }
  if (run.stopped === "cancelled") {
    parts.push("Screenshot upload stopped.")
  }
  if (run.stopped !== null && run.notUploaded > 0 && (run.stopMessage !== null || run.stopped === "cancelled")) {
    parts.push(plural(run.notUploaded, "screenshot wasn't", "screenshots weren't") + " uploaded.")
  }
  if (parts.length === 0) {
    return null
  }
  const warning = run.problems.length > 0 || run.droppedBoxes > 0 || (run.stopped !== null && run.stopped !== "disabled" && run.stopped !== "signed_out")
  return { tone: warning ? "warning" : "good", message: parts.join(" ") }
}

export interface ProblemGroup { message: string; frameIds: string[]; frameNames: string[] }

// Frames that were not uploaded, one line per reason.
export function groupProblems(problems: readonly ScreenshotProblem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>()
  for (const problem of problems) {
    let group = groups.get(problem.message)
    if (group === undefined) {
      group = { message: problem.message, frameIds: [], frameNames: [] }
      groups.set(problem.message, group)
    }
    if (!group.frameIds.includes(problem.frameId)) {
      group.frameIds.push(problem.frameId)
      group.frameNames.push(problem.frameName === "" ? problem.frameId : problem.frameName)
    }
  }
  return [...groups.values()]
}

export function progressText(run: ScreenshotRun): string {
  return "Uploading screenshots… " + Math.min(run.done + 1, run.total) + " of " + run.total
}

// The Push screen's way in (§7.13 rule 11, SF1): `prepare` loads E1/E8 when needed and evaluates the gate with the
// current settings, prefs and permissions; `upload` runs the queue for this project (with `freshness` from the
// availability `prepare` returned). `ignorePref`: Update screenshots (SF6) fulfils an explicit request, which is not
// an automatic upload, so the setting does not apply to it.
export interface ScreenshotUploader {
  prepare(options?: { ignorePref?: boolean }): Promise<{ gate: ScreenshotGate; availability: Availability }>
  upload(frames: readonly ScreenshotFrame[], options: ScreenshotRunOptions): Promise<ScreenshotRun>
}
