import { describe, expect, it, vi } from "vitest"
import { keyId, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaMetaResponse, FigmaScreenshotUploadResponse, FigmaUser } from "../../shared/api-types"
import type { Box, FileSettings, MainToUi, UiToMain } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { ApiError, RATE_LIMIT_MESSAGE, REASON_MESSAGES } from "../api/client"
import type { ScreenshotUpload } from "../api/figma-api"
import { createUiBus, HandlerError, RequestTimeoutError } from "../bus"
import { BRANCH_MESSAGE } from "./file-link"
import {
  affectedFrames,
  contentTypeOf,
  COPY_HINT,
  createAvailability,
  emptyScreenshotRun,
  fitBoxes,
  groupProblems,
  imageFileName,
  NO_FILE_HINT,
  NO_PERMISSION_HINT,
  progressText,
  requestFrameImage,
  screenshotDeps,
  screenshotGate,
  screenshotMeta,
  SCREENSHOTS_ON_HINT,
  screenshotSetting,
  screenshotSummary,
  SERVER_DISABLED_HINT,
  SKIP_MESSAGES,
  TOO_LARGE_MESSAGE,
  uploadErrorAction,
  uploadScreenshots,
  type Availability,
  type FrameExportResult,
  type FrameImage,
  type ScreenshotDeps,
  type ScreenshotFrame,
} from "./screenshots"
import { fakeBusEnvironment } from "./test-fakes"

const FILE_KEY = "AbCdEf1234567890XyZ"
const K1 = keyId(1)
const K2 = keyId(2)

const META: FigmaMetaResponse = { api_version: 1, screenshots_enabled: true, max_image_bytes: 2097152, max_image_side: 4096, max_batch_size: 100, server_time: "2026-10-27T10:00:00Z" }
const USER: FigmaUser = { id: "kc-1", email: "dana@example.com", first_name: "Dana", last_name: "Designer", sandbox_expires_at: null }
const READY: Availability = { meta: META, user: USER, error: null }

function linkedFile(overrides: Partial<FileSettings> = {}): FileSettings {
  return {
    ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }),
    fileKey: FILE_KEY,
    fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter",
    fileName: "Chapter",
    ...overrides,
  }
}

function gateInput(overrides: Partial<Parameters<typeof screenshotGate>[0]> = {}): Parameters<typeof screenshotGate>[0] {
  return { pref: true, availability: READY, settings: linkedFile(), rootName: "Chapter", permissions: ["edit_keys"], ...overrides }
}

describe("screenshotGate (§7.16, D4, D43)", () => {
  it("is on for a confirmed main file, a non-sandbox user with edit_keys and a server with storage", () => {
    expect(screenshotGate(gateInput())).toEqual({ enabled: true, reason: null, fileKey: FILE_KEY })
  })

  it("names the first reason that keeps uploads off", () => {
    const reason = (overrides: Partial<Parameters<typeof screenshotGate>[0]>) => screenshotGate(gateInput(overrides))
    expect(reason({ availability: { ...READY, user: { ...USER, sandbox_expires_at: "2026-10-27T15:00:00Z" } }, pref: false })).toEqual({ enabled: false, reason: "sandbox", fileKey: null })
    expect(reason({ availability: { ...READY, meta: { ...META, screenshots_enabled: false } }, pref: false }).reason).toBe("server_disabled")
    expect(reason({ pref: false }).reason).toBe("pref_off")
    expect(reason({ availability: { meta: null, user: USER, error: null } }).reason).toBe("unavailable")
    expect(reason({ availability: { meta: META, user: null, error: "offline" } }).reason).toBe("unavailable")
    expect(reason({ settings: null }).reason).toBe("no_file")
    expect(reason({ settings: linkedFile({ fileKey: null }) }).reason).toBe("no_file")
    expect(reason({ settings: linkedFile({ branchKey: "BrAnCh1234567890" }) }).reason).toBe("branch")
    expect(reason({ rootName: "Chapter (Copy)" }).reason).toBe("possible_copy")
    expect(reason({ permissions: ["publishing"] }).reason).toBe("no_permission")
  })
})

describe("screenshotSetting (Settings → Push)", () => {
  const setting = (overrides: Partial<Parameters<typeof screenshotGate>[0]>) => {
    const input = gateInput(overrides)
    return screenshotSetting(screenshotGate(input), input.availability)
  }

  it("hides the toggle for sandbox users and replaces it with a note when the server stores no screenshots", () => {
    expect(setting({ availability: { ...READY, user: { ...USER, sandbox_expires_at: "2026-10-27T15:00:00Z" } } })).toEqual({ visible: false, toggle: false, hint: null })
    expect(setting({ availability: { ...READY, meta: { ...META, screenshots_enabled: false } } })).toEqual({ visible: true, toggle: false, hint: SERVER_DISABLED_HINT })
  })

  it("explains why nothing is uploaded", () => {
    expect(setting({})).toEqual({ visible: true, toggle: true, hint: SCREENSHOTS_ON_HINT })
    expect(setting({ pref: false }).hint).toBeNull()
    expect(setting({ availability: { meta: null, user: null, error: null } }).hint).toBeNull()
    expect(setting({ availability: { meta: null, user: null, error: "Can't reach ReRune. Check your connection." } }).hint).toBe(
      "ReRune couldn't be asked about screenshots: Can't reach ReRune. Check your connection.",
    )
    expect(setting({ settings: linkedFile({ fileKey: null }) }).hint).toBe(NO_FILE_HINT)
    expect(setting({ settings: linkedFile({ branchKey: "BrAnCh1234567890" }) }).hint).toBe(BRANCH_MESSAGE)
    expect(setting({ rootName: "Copy" }).hint).toBe(COPY_HINT)
    expect(setting({ permissions: [] }).hint).toBe(NO_PERMISSION_HINT)
  })
})

describe("createAvailability (E1 + E8)", () => {
  function api(overrides: { meta?: () => Promise<FigmaMetaResponse>; projects?: () => Promise<{ user: FigmaUser; projects: [] }> } = {}) {
    return {
      meta: vi.fn(overrides.meta ?? (async () => META)),
      projects: vi.fn(overrides.projects ?? (async () => ({ user: USER, projects: [] as [] }))),
    }
  }

  it("loads meta and the user once, in parallel, and shares a running load", async () => {
    const fake = api()
    const loader = createAvailability(fake)
    expect(loader.current()).toEqual({ meta: null, user: null, error: null })
    const [first, second] = await Promise.all([loader.load(), loader.load()])
    expect(first).toEqual(READY)
    expect(second).toEqual(READY)
    await loader.load()
    expect(fake.meta).toHaveBeenCalledTimes(1)
    expect(fake.projects).toHaveBeenCalledTimes(1)
  })

  it("keeps what loaded, reports the failure and tries the rest again next time", async () => {
    let fail = true
    const fake = api({ projects: async () => (fail ? Promise.reject(new ApiError(0, "network", "offline")) : { user: USER, projects: [] }) })
    const loader = createAvailability(fake)
    expect(await loader.load()).toEqual({ meta: META, user: null, error: "Can't reach ReRune. Check your connection." })
    fail = false
    expect(await loader.load()).toEqual(READY)
    expect(fake.meta).toHaveBeenCalledTimes(1)
    expect(fake.projects).toHaveBeenCalledTimes(2)
  })

  it("takes the user from the Project screen instead of a second E8 call", async () => {
    const fake = api()
    const loader = createAvailability(fake)
    loader.setUser(USER)
    expect(await loader.load()).toEqual(READY)
    expect(fake.projects).not.toHaveBeenCalled()
  })

  it("switches screenshots off for the session, also before meta loaded", async () => {
    const loader = createAvailability(api())
    loader.disable()
    expect(loader.current().meta?.screenshots_enabled).toBe(false)
    expect((await loader.load()).meta?.screenshots_enabled).toBe(false)
    const loaded = createAvailability(api())
    await loaded.load()
    loaded.disable()
    expect(loaded.current().meta).toEqual({ ...META, screenshots_enabled: false })
  })

  it("forgets the user on sign-out, keeps the server's answer and drops a load that was running", async () => {
    let resolveUser: (value: { user: FigmaUser; projects: [] }) => void = () => {}
    const fake = api({ projects: () => new Promise((resolve) => (resolveUser = resolve)) })
    const loader = createAvailability(fake)
    loader.setUser(USER)
    await loader.load()
    loader.reset()
    expect(loader.current()).toEqual({ meta: META, user: null, error: null })
    const running = loader.load()
    loader.reset()
    resolveUser({ user: { ...USER, id: "other" }, projects: [] })
    await running
    expect(loader.current().user).toBeNull()
  })
})

describe("affectedFrames (§7.13 rule 11)", () => {
  it("lists each top frame of the given layers once, in order, without frameless text", () => {
    const nodes = new Map([
      ["1:1", scannedNode("1:1", "A", { frameId: "10:1", frameName: "Checkout" })],
      ["1:2", scannedNode("1:2", "B", { frameId: "11:1", frameName: "Cart" })],
      ["1:3", scannedNode("1:3", "C", { frameId: "10:1", frameName: "Checkout" })],
      ["1:4", scannedNode("1:4", "D", { frameId: null, frameName: null })],
    ])
    expect(affectedFrames(["1:2", "1:1", "1:3", "1:4", "9:9"], nodes)).toEqual([
      { frameId: "11:1", frameName: "Cart" },
      { frameId: "10:1", frameName: "Checkout" },
    ])
  })
})

function box(x: number, y: number, w: number, h: number, nodeId = "12:1"): Box {
  return { nodeId, keyId: K1, x, y, w, h }
}

describe("fitBoxes (§7.16 decoded size)", () => {
  it("keeps boxes within 2 px but clamps them to the decoded image", () => {
    expect(fitBoxes([box(10, 10, 20, 20), box(390, 790, 10, 10)], { width: 400, height: 800 }, { width: 398, height: 799 })).toEqual([box(10, 10, 20, 20), box(390, 790, 8, 9)])
  })

  it("rescales boxes by actual/expected beyond 2 px", () => {
    expect(fitBoxes([box(100, 200, 50, 20)], { width: 400, height: 800 }, { width: 800, height: 1600 })).toEqual([box(200, 400, 100, 40)])
    expect(fitBoxes([box(100, 200, 50, 20)], { width: 400, height: 800 }, { width: 396, height: 800 })).toEqual([box(99, 200, 50, 20)])
  })

  it("drops boxes that end up empty or outside", () => {
    expect(fitBoxes([box(400, 10, 10, 10), box(-5, -5, 3, 3), box(-5, 0, 10, 10)], { width: 400, height: 800 }, { width: 400, height: 800 })).toEqual([box(0, 0, 5, 10)])
  })
})

const IMAGE: FrameImage = {
  frameId: "I10:1;2:3",
  frameName: "  Checkout  ",
  pageId: "0:1",
  pageName: "Mobile",
  format: "JPG",
  bytes: new Uint8Array([1, 2, 3]),
  width: 400,
  height: 800,
  boxes: [box(20, 50, 100, 20), box(380, 50, 20, 20, "12:2")],
}

describe("E19 parts", () => {
  it("names the image after the frame and picks the content type", () => {
    expect(imageFileName("10:1", "JPG")).toBe("10_1.jpg")
    expect(imageFileName("I10:1;2:3", "PNG")).toBe("I10_1_2_3.png")
    expect(contentTypeOf("JPG")).toBe("image/jpeg")
    expect(contentTypeOf("PNG")).toBe("image/png")
  })

  it("builds meta with the decoded size, trimmed names and at most 500 boxes", () => {
    expect(screenshotMeta(IMAGE, FILE_KEY, { width: 400, height: 800 }, IMAGE.boxes)).toEqual({
      file_key: FILE_KEY,
      frame_id: "I10:1;2:3",
      frame_name: "Checkout",
      page_id: "0:1",
      page_name: "Mobile",
      width: 400,
      height: 800,
      boxes: [
        { key_id: K1, node_id: "12:1", x: 20, y: 50, w: 100, h: 20 },
        { key_id: K1, node_id: "12:2", x: 380, y: 50, w: 20, h: 20 },
      ],
    })
    const many = Array.from({ length: 501 }, (_, index) => box(0, 0, 1, 1, "12:" + index))
    const meta = screenshotMeta({ ...IMAGE, frameName: "😀".repeat(250) }, FILE_KEY, { width: 10, height: 10 }, many)
    expect(meta.boxes).toHaveLength(500)
    expect(meta.frame_name).toBe("😀".repeat(200))
  })
})

describe("requestFrameImage (screenshots-export, one frame per request)", () => {
  function mainAnswering(reply: (message: Extract<UiToMain, { type: "screenshots-export" }>) => MainToUi[]) {
    const fake = fakeBusEnvironment((message, deliver) => {
      if (message.type === "screenshots-export") {
        reply(message).forEach(deliver)
      }
    })
    return { bus: createUiBus(fake.environment), posted: fake.posted }
  }

  it("asks main for one frame and returns its image", async () => {
    const main = mainAnswering((message) => [
      { type: "frame-image", requestId: message.requestId, ...IMAGE },
      { type: "frame-images-done", requestId: message.requestId, exported: 1, skipped: [] },
    ])
    expect(await requestFrameImage(main.bus, "I10:1;2:3")).toEqual({ kind: "image", image: IMAGE })
    expect(main.posted).toEqual([expect.objectContaining({ type: "screenshots-export", frameIds: ["I10:1;2:3"] })])
  })

  it("returns main's skip reason", async () => {
    const main = mainAnswering((message) => [{ type: "frame-images-done", requestId: message.requestId, exported: 0, skipped: [{ frameId: "10:1", reason: "preview_active" }] }])
    expect(await requestFrameImage(main.bus, "10:1")).toEqual({ kind: "skipped", reason: "preview_active" })
    const silent = mainAnswering((message) => [{ type: "frame-images-done", requestId: message.requestId, exported: 0, skipped: [] }])
    expect(await requestFrameImage(silent.bus, "10:1")).toEqual({ kind: "skipped", reason: "export_failed" })
  })

  it("rejects with main's handler error", async () => {
    const main = mainAnswering((message) => [{ type: "handler-error", forType: "screenshots-export", requestId: message.requestId, message: "boom" }])
    await expect(requestFrameImage(main.bus, "10:1")).rejects.toBeInstanceOf(HandlerError)
  })
})

describe("uploadErrorAction (§7.16, §7.20, Appendix B.1)", () => {
  it("waits Retry-After (at most 60 s) on 429, twice, then stops", () => {
    expect(uploadErrorAction(new ApiError(429, null, "slow down", 30), 0)).toEqual({ kind: "retry", waitMs: 30000 })
    expect(uploadErrorAction(new ApiError(429, null, "slow down", 600), 1)).toEqual({ kind: "retry", waitMs: 60000 })
    expect(uploadErrorAction(new ApiError(429, null, "slow down"), 0)).toEqual({ kind: "retry", waitMs: 5000 })
    expect(uploadErrorAction(new ApiError(429, null, "slow down", 30), 2)).toEqual({ kind: "stop", stop: "rate_limited", message: RATE_LIMIT_MESSAGE })
  })

  it("stops on 503, on a 403 without a reason and on 401", () => {
    expect(uploadErrorAction(new ApiError(503, "design_storage_disabled", "off"), 0)).toEqual({ kind: "stop", stop: "disabled", message: null })
    expect(uploadErrorAction(new ApiError(503, null, "maintenance"), 0)).toEqual({ kind: "stop", stop: "unavailable", message: "ReRune had a problem. Try again." })
    expect(uploadErrorAction(new ApiError(403, null, "This action is not available in the sandbox"), 0)).toEqual({
      kind: "stop",
      stop: "forbidden",
      message: "This action is not available in the sandbox",
    })
    expect(uploadErrorAction(new ApiError(401, "plugin_token_invalid", "x"), 0)).toEqual({ kind: "stop", stop: "signed_out", message: null })
  })

  it("fails only the frame otherwise, with the Appendix B.1 text", () => {
    expect(uploadErrorAction(new ApiError(403, "screenshot_limit_reached", "x"), 0)).toEqual({ kind: "frame", message: REASON_MESSAGES.screenshot_limit_reached })
    expect(uploadErrorAction(new ApiError(502, "design_storage_failed", "x"), 0)).toEqual({ kind: "frame", message: "Screenshot upload failed. It will be retried on the next push." })
    expect(uploadErrorAction(new ApiError(400, "invalid_image", "x"), 0)).toEqual({ kind: "frame", message: "This frame image couldn't be uploaded." })
    expect(uploadErrorAction(new ApiError(0, "network", "x"), 0)).toEqual({ kind: "frame", message: "Can't reach ReRune. Check your connection." })
    expect(uploadErrorAction(new Error("odd"), 0)).toEqual({ kind: "frame", message: "odd" })
  })
})

const FRAMES: ScreenshotFrame[] = [
  { frameId: "10:1", frameName: "Checkout" },
  { frameId: "11:1", frameName: "Cart" },
  { frameId: "12:1", frameName: "Done" },
]

function imageOf(frameId: string, extra: Partial<FrameImage> = {}): FrameImage {
  return { ...IMAGE, frameId, frameName: FRAMES.find((frame) => frame.frameId === frameId)?.frameName ?? "", ...extra }
}

function uploaded(extra: Partial<FigmaScreenshotUploadResponse> = {}): FigmaScreenshotUploadResponse {
  return { screenshot: {} as FigmaScreenshotUploadResponse["screenshot"], unchanged_image: false, dropped_boxes: [], ...extra }
}

function deps(overrides: Partial<ScreenshotDeps> = {}) {
  const log: string[] = []
  const uploads: ScreenshotUpload[] = []
  const base: ScreenshotDeps = {
    exportFrame: vi.fn(async (frameId: string): Promise<FrameExportResult> => {
      log.push("export " + frameId)
      return { kind: "image", image: imageOf(frameId) }
    }),
    measure: vi.fn(async () => null),
    upload: vi.fn(async (upload: ScreenshotUpload) => {
      log.push("upload " + upload.meta.frame_id)
      uploads.push(upload)
      return uploaded()
    }),
    sleep: vi.fn(async () => {}),
    onDisabled: vi.fn(),
  }
  return { deps: { ...base, ...overrides }, log, uploads }
}

describe("uploadScreenshots (the upload queue, §7.16)", () => {
  it("uploads frame by frame, exporting the next frame while one uploads", async () => {
    const fake = deps()
    const progress: number[] = []
    const run = await uploadScreenshots(fake.deps, FRAMES, { fileKey: FILE_KEY, onProgress: (state) => progress.push(state.done) })
    expect(fake.log).toEqual(["export 10:1", "export 11:1", "upload 10:1", "export 12:1", "upload 11:1", "upload 12:1"])
    expect(run).toEqual({ ...emptyScreenshotRun(3), done: 3, uploaded: 3 })
    expect(progress).toEqual([0, 1, 2, 3, 3])
    expect(fake.uploads[0]).toEqual({
      image: IMAGE.bytes,
      contentType: "image/jpeg",
      fileName: "10_1.jpg",
      meta: {
        file_key: FILE_KEY,
        frame_id: "10:1",
        frame_name: "Checkout",
        page_id: "0:1",
        page_name: "Mobile",
        width: 400,
        height: 800,
        boxes: [
          { key_id: K1, node_id: "12:1", x: 20, y: 50, w: 100, h: 20 },
          { key_id: K1, node_id: "12:2", x: 380, y: 50, w: 20, h: 20 },
        ],
      },
    })
  })

  it("sends the decoded size and rescales the boxes when the image differs by more than 2 px", async () => {
    const fake = deps({ measure: vi.fn(async () => ({ width: 200, height: 400 })) })
    await uploadScreenshots(fake.deps, FRAMES.slice(0, 1), { fileKey: FILE_KEY })
    expect(fake.uploads[0].meta).toMatchObject({ width: 200, height: 400, boxes: [{ x: 10, y: 25, w: 50, h: 10 }, { x: 190, y: 25, w: 10, h: 10 }] })
    expect(fake.deps.measure).toHaveBeenCalledWith(IMAGE.bytes, "image/jpeg")
  })

  it("counts unchanged images and boxes the server left out", async () => {
    const fake = deps({
      upload: vi.fn(async () => uploaded({ unchanged_image: true, dropped_boxes: [{ node_id: "12:2", key_id: K2, reason: "key_not_found" }] })),
    })
    const run = await uploadScreenshots(fake.deps, FRAMES.slice(0, 2), { fileKey: FILE_KEY })
    expect(run).toMatchObject({ uploaded: 2, unchanged: 2, droppedBoxes: 2 })
  })

  it("reports frames main skipped, too large or invalid images and failed uploads, and goes on", async () => {
    const results: Record<string, FrameExportResult> = {
      "10:1": { kind: "skipped", reason: "preview_active" },
      "11:1": { kind: "image", image: imageOf("11:1", { bytes: new Uint8Array(2000001) }) },
      "12:1": { kind: "image", image: imageOf("12:1") },
      "13:1": { kind: "image", image: imageOf("13:1", { frameName: "Paid" }) },
      // Longer than 4096 px once decoded (here: the expected size, as nothing could be decoded).
      "14:1": { kind: "image", image: imageOf("14:1", { frameName: "Huge", width: 5000, height: 10 }) },
    }
    const fake = deps({
      exportFrame: vi.fn(async (frameId: string) => {
        if (frameId === "15:1") {
          throw new HandlerError("screenshots-export", "boom")
        }
        return results[frameId]
      }),
      upload: vi.fn(async (upload: ScreenshotUpload) => {
        if (upload.meta.frame_id === "12:1") {
          throw new ApiError(502, "design_storage_failed", "bunny")
        }
        if (upload.meta.frame_id === "13:1") {
          throw new ApiError(403, "screenshot_limit_reached", "limit")
        }
        return uploaded()
      }),
    })
    const frames = [...FRAMES, { frameId: "13:1", frameName: "Paid" }, { frameId: "14:1", frameName: "Huge" }, { frameId: "15:1", frameName: "Broken" }]
    const run = await uploadScreenshots(fake.deps, frames, { fileKey: FILE_KEY })
    expect(run.stopped).toBeNull()
    expect(run.done).toBe(6)
    expect(run.uploaded).toBe(0)
    expect(run.problems).toEqual([
      { frameId: "10:1", frameName: "Checkout", message: SKIP_MESSAGES.preview_active },
      { frameId: "11:1", frameName: "Cart", message: TOO_LARGE_MESSAGE },
      { frameId: "12:1", frameName: "Done", message: "Screenshot upload failed. It will be retried on the next push." },
      { frameId: "13:1", frameName: "Paid", message: "This project reached its screenshot limit. Contact support." },
      { frameId: "14:1", frameName: "Huge", message: "This frame image couldn't be uploaded." },
      { frameId: "15:1", frameName: "Broken", message: SKIP_MESSAGES.export_failed },
    ])
    expect(fake.deps.upload).toHaveBeenCalledTimes(2)
  })

  it("honours 429 Retry-After and tries the frame again", async () => {
    let calls = 0
    const fake = deps({
      upload: vi.fn(async () => {
        calls++
        if (calls === 1) {
          throw new ApiError(429, null, "slow down", 12)
        }
        return uploaded()
      }),
    })
    const run = await uploadScreenshots(fake.deps, FRAMES.slice(0, 2), { fileKey: FILE_KEY })
    expect(fake.deps.sleep).toHaveBeenCalledWith(12000)
    expect(run).toMatchObject({ uploaded: 2, problems: [], stopped: null })
  })

  it("stops after repeated 429s and counts what was left", async () => {
    const fake = deps({ upload: vi.fn(async () => Promise.reject(new ApiError(429, null, "slow down", 60))) })
    const run = await uploadScreenshots(fake.deps, FRAMES, { fileKey: FILE_KEY })
    expect(fake.deps.upload).toHaveBeenCalledTimes(3)
    expect(fake.deps.sleep).toHaveBeenCalledTimes(2)
    expect(run).toMatchObject({ stopped: "rate_limited", stopMessage: RATE_LIMIT_MESSAGE, notUploaded: 3, done: 0 })
  })

  it("stops silently on 503 design_storage_disabled and switches screenshots off for the session", async () => {
    const fake = deps({ upload: vi.fn(async () => Promise.reject(new ApiError(503, "design_storage_disabled", "off"))) })
    const run = await uploadScreenshots(fake.deps, FRAMES, { fileKey: FILE_KEY })
    expect(fake.deps.upload).toHaveBeenCalledTimes(1)
    expect(fake.deps.onDisabled).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ stopped: "disabled", stopMessage: null, notUploaded: 3 })
    expect(screenshotSummary(run)).toBeNull()
  })

  it("stops on the first 403 without a reason (sandbox) after the frames already uploaded", async () => {
    let calls = 0
    const fake = deps({
      upload: vi.fn(async () => {
        calls++
        if (calls === 2) {
          throw new ApiError(403, null, "This action is not available in the sandbox")
        }
        return uploaded()
      }),
    })
    const run = await uploadScreenshots(fake.deps, FRAMES, { fileKey: FILE_KEY })
    expect(fake.deps.upload).toHaveBeenCalledTimes(2)
    expect(fake.deps.onDisabled).not.toHaveBeenCalled()
    expect(run).toMatchObject({ uploaded: 1, done: 1, stopped: "forbidden", notUploaded: 2 })
    expect(screenshotSummary(run)).toEqual({
      tone: "warning",
      message: "1 screenshot uploaded. Screenshot upload stopped: This action is not available in the sandbox. 2 screenshots weren't uploaded.",
    })
  })

  it("stops on 401 (the client signs out) and when main stops answering", async () => {
    const signedOut = deps({ upload: vi.fn(async () => Promise.reject(new ApiError(401, "plugin_token_invalid", "x"))) })
    expect(await uploadScreenshots(signedOut.deps, FRAMES, { fileKey: FILE_KEY })).toMatchObject({ stopped: "signed_out", stopMessage: null })
    const stuck = deps({ exportFrame: vi.fn(async () => Promise.reject(new RequestTimeoutError("c1"))) })
    const run = await uploadScreenshots(stuck.deps, FRAMES, { fileKey: FILE_KEY })
    expect(run).toMatchObject({ stopped: "unresponsive", stopMessage: "The plugin stopped responding. Try again.", notUploaded: 3 })
    expect(stuck.deps.upload).not.toHaveBeenCalled()
  })

  it("stops between frames when the designer asks", async () => {
    let stop = false
    const fake = deps({
      upload: vi.fn(async () => {
        stop = true
        return uploaded()
      }),
    })
    const run = await uploadScreenshots(fake.deps, FRAMES, { fileKey: FILE_KEY, stopped: () => stop })
    expect(fake.deps.upload).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ uploaded: 1, stopped: "cancelled", notUploaded: 2 })
    expect(screenshotSummary(run)?.message).toBe("1 screenshot uploaded. Screenshot upload stopped. 2 screenshots weren't uploaded.")
  })

  it("does nothing without frames", async () => {
    const fake = deps()
    expect(await uploadScreenshots(fake.deps, [], { fileKey: FILE_KEY })).toEqual(emptyScreenshotRun(0))
    expect(fake.deps.exportFrame).not.toHaveBeenCalled()
  })
})

describe("screenshotDeps", () => {
  it("exports through main and uploads to the project", async () => {
    const fake = fakeBusEnvironment((message, deliver) => {
      if (message.type === "screenshots-export") {
        deliver({ type: "frame-image", requestId: message.requestId, ...imageOf("10:1") })
        deliver({ type: "frame-images-done", requestId: message.requestId, exported: 1, skipped: [] })
      }
    })
    const uploadScreenshot = vi.fn(async () => uploaded())
    const built = screenshotDeps({ api: { uploadScreenshot }, bus: createUiBus(fake.environment), projectId: PROJECT_ID, measure: async () => null })
    expect(await built.exportFrame("10:1")).toEqual({ kind: "image", image: imageOf("10:1") })
    const upload = { image: IMAGE.bytes, contentType: "image/jpeg" as const, fileName: "10_1.jpg", meta: screenshotMeta(IMAGE, FILE_KEY, { width: 400, height: 800 }, []) }
    await built.upload(upload)
    expect(uploadScreenshot).toHaveBeenCalledWith(PROJECT_ID, upload)
  })
})

describe("screenshot results", () => {
  it("summarises uploads, unchanged images and dropped boxes", () => {
    expect(screenshotSummary(emptyScreenshotRun(0))).toBeNull()
    expect(screenshotSummary({ ...emptyScreenshotRun(3), done: 3, uploaded: 3, unchanged: 1 })).toEqual({ tone: "good", message: "3 screenshots uploaded (1 unchanged)." })
    expect(screenshotSummary({ ...emptyScreenshotRun(1), done: 1, uploaded: 1, droppedBoxes: 2 })).toEqual({
      tone: "warning",
      message: "1 screenshot uploaded. 2 layer positions weren't saved because the key no longer exists or the layer is outside the image.",
    })
    expect(screenshotSummary({ ...emptyScreenshotRun(2), done: 2, uploaded: 1, problems: [{ frameId: "10:1", frameName: "Checkout", message: "x" }] })?.tone).toBe("warning")
  })

  it("groups problems by message", () => {
    expect(
      groupProblems([
        { frameId: "10:1", frameName: "Checkout", message: "a" },
        { frameId: "11:1", frameName: "", message: "a" },
        { frameId: "12:1", frameName: "Done", message: "b" },
        { frameId: "10:1", frameName: "Checkout", message: "a" },
      ]),
    ).toEqual([
      { message: "a", frameIds: ["10:1", "11:1"], frameNames: ["Checkout", "11:1"] },
      { message: "b", frameIds: ["12:1"], frameNames: ["Done"] },
    ])
  })

  it("shows the frame being uploaded", () => {
    expect(progressText({ ...emptyScreenshotRun(3), done: 0 })).toBe("Uploading screenshots… 1 of 3")
    expect(progressText({ ...emptyScreenshotRun(3), done: 3 })).toBe("Uploading screenshots… 3 of 3")
  })
})
