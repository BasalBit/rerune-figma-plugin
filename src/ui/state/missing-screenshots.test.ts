/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, OTHER_PROJECT_ID, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type {
  FigmaByNameRequest,
  FigmaByNameResponse,
  FigmaMetaResponse,
  FigmaPushResponse,
  FigmaResolveRequest,
  FigmaResolveResponse,
  FigmaScreenshot,
  FigmaScreenshotsQuery,
  FigmaScreenshotsResponse,
  FigmaUser,
} from "../../shared/api-types"
import type { FileSettings, ScannedNode, Scope } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import type { RemoteKeyState } from "../../shared/sync-state"
import { ApiError, REASON_MESSAGES } from "../api/client"
import type { ScreenshotUpload } from "../api/figma-api"
import pushScreen from "../screens/push.tsx?raw"
import appSource from "../app.tsx?raw"
import statusSource from "../components/screenshot-status.tsx?raw"
import {
  checkStoredFrames,
  createFailedFrames,
  createPushShots,
  createStoredSlot,
  framesWith,
  linkedFrames,
  loadStoredFrames,
  missingFrames,
  missingLine,
  NONE_MISSING,
  planFrames,
  readStoredFrames,
  runUpload,
  showsProjectKey,
  withUploaded,
  type FailedFrames,
  type ShotsDeps,
  type StoredFrames,
} from "./missing-screenshots"
import type { ScanResult, ScanRunner } from "./ops"
import { checkPlan, executePulls, executePush, followShown, planBase, planSignature, preparePush, pullSignature, type PushCheckDeps, type PushInput } from "./push"
import { createRefreshRequests, refetchAfterUpload } from "./refresh-requests"
import { createWatchSchedule, type WatchEvent, type WatchWindow } from "./request-watch"
import {
  affectedFrames,
  CHECKING_SHOTS_TEXT,
  COPY_HINT,
  emptyScreenshotRun,
  progressText,
  screenshotGate,
  screenshotSummary,
  SCREENSHOTS_OFF_TEXT,
  TOO_LARGE_MESSAGE,
  uploadScreenshots,
  type Availability,
  type FrameExportResult,
  type ScreenshotDeps,
  type ScreenshotFrame,
  type ScreenshotGate,
  type ScreenshotRun,
  type ScreenshotUploader,
  type ShotsState,
} from "./screenshots"
import { fakeMain, resolvedKey } from "./test-fakes"
import { createWorkLock, waitText } from "./work-lock"
import { createWorkspace, type WorkspaceState } from "./workspace"

// Frames with linked keys but no screenshot in ReRune yet (the first push on a new project): which frames count, how
// ReRune is asked (E20, one frame at a time or the file's whole list), the push that uploads them too, Upload
// screenshots when there is nothing else to push, frames that can't be uploaded, and how all of it behaves with the
// setting, the gate, Stop, 429s, the refresh requests, the background reads and the Push screen's state.

const FILE_KEY = "AbCdEf1234567890XyZ"
const OTHER_FILE_KEY = "OtHeRfIlE1234567890"
const K1 = keyId(1)
const K2 = keyId(2)
const K3 = keyId(3)
const K4 = keyId(4)
const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
const META: FigmaMetaResponse = { api_version: 1, screenshots_enabled: true, max_image_bytes: 2097152, max_image_side: 4096, max_batch_size: 100, server_time: "2026-10-29T10:00:00Z", screenshot_freshness: true }
const USER: FigmaUser = { id: "kc-1", email: "dana@example.com", first_name: "Dana", last_name: "Designer", sandbox_expires_at: null }
const READY: Availability = { meta: META, user: USER, error: null }
const OPEN: ScreenshotGate = { enabled: true, reason: null, fileKey: FILE_KEY }

const found = (type: RemoteKeyState["type"] = "key") => ({ found: true, type })

function frameOf(frameId: string, frameName: string) {
  return { frameId, frameName }
}

function linkedFile(overrides: Partial<FileSettings> = {}): FileSettings {
  return {
    ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }),
    fileKey: FILE_KEY,
    fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter",
    fileName: "Chapter",
    ...overrides,
  }
}

function screenshot(n: number, frameId: string, extra: Partial<FigmaScreenshot> = {}): FigmaScreenshot {
  return {
    id: "6a49" + String(n).padStart(20, "0"),
    file_key: FILE_KEY,
    frame_id: frameId,
    frame_name: "Frame " + frameId,
    page_id: "0:1",
    page_name: "Mobile",
    content_type: "image/png",
    width: 400,
    height: 800,
    size_bytes: 1000,
    boxes: [],
    image_url: null,
    image_url_expires_at: null,
    figma_url: null,
    created_at: "2026-10-28T10:00:00Z",
    updated_at: "2026-10-28T10:00:00Z",
    outdated_box_count: 0,
    refresh_requested_at: null,
    refresh_requested_by: null,
    ...extra,
  }
}

// E20 that answers from a list of pages (one call each, in order), the last one again once they are used up.
function listing(...pages: FigmaScreenshot[][]) {
  const calls: FigmaScreenshotsQuery[] = []
  const screenshots = vi.fn(async (_projectId: string, query: FigmaScreenshotsQuery): Promise<FigmaScreenshotsResponse> => {
    calls.push(query)
    const index = Math.min(calls.length - 1, pages.length - 1)
    const last = index === pages.length - 1
    return { screenshots: pages[index] ?? [], next_cursor: last ? null : "c" + (index + 1), has_more: !last }
  })
  return { screenshots, calls }
}

// E20 for the file as it is now: `frames` have a screenshot. One page; `frame_id` filters it, as on the server.
function server(frames: string[]) {
  const stored = new Set(frames)
  const calls: FigmaScreenshotsQuery[] = []
  const screenshots = vi.fn(async (_projectId: string, query: FigmaScreenshotsQuery): Promise<FigmaScreenshotsResponse> => {
    calls.push(query)
    const all = [...stored].map((frameId, index) => screenshot(index, frameId))
    const picked = typeof query.frame_id === "string" ? all.filter((entry) => entry.frame_id === query.frame_id) : all
    return { screenshots: picked, next_cursor: null, has_more: false }
  })
  // The frames asked about one by one, and the reads of the whole list.
  const asked = () => calls.filter((query) => typeof query.frame_id === "string").map((query) => query.frame_id)
  const whole = () => calls.filter((query) => query.frame_id === undefined).length
  return { screenshots, calls, stored, asked, whole }
}

// The canvas of a new project (one page, frames 10:1 to 16:1). Every layer is linked to a key that has its text, so a
// push has nothing to send, except 1:4, changed in Figma.
function canvas(): ScannedNode[] {
  return [
    linkedNode("1:1", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now" }, { frameId: "10:1", frameName: "Checkout" }),
    // A nested frame's layer counts for its top frame.
    linkedNode("1:2", "Total", { keyId: K2, keyName: "total", syncedText: "Total" }, { frameId: "10:1", frameName: "Checkout", parentNames: ["Summary", "Checkout"] }),
    linkedNode("1:3", "Cart", { keyId: K2, keyName: "total", syncedText: "Total" }, { frameId: "11:1", frameName: "Cart" }),
    scannedNode("1:4b", "Free text", { frameId: "11:1", frameName: "Cart" }),
    // Changed in Figma: the layer says "Shipping fee", ReRune still "Shipping".
    linkedNode("1:4", "Shipping fee", { keyId: K3, keyName: "shipping", syncedText: "Shipping" }, { frameId: "12:1", frameName: "Done" }),
    // Instance text that shows its main component's key.
    linkedNode("I5:1;1:1", "Total", { keyId: K2, keyName: "total", syncedText: "Total", nid: "5:1", state: "inherited" }, { frameId: "13:1", frameName: "Receipt" }),
    // A copied layer, a link to another project and a key ReRune doesn't have: no key shows.
    linkedNode("1:6", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now", nid: "1:1", state: "copied" }, { frameId: "14:1", frameName: "Copy" }),
    linkedNode("1:7", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now", projectId: OTHER_PROJECT_ID }, { frameId: "15:1", frameName: "Other" }),
    linkedNode("1:8", "Gone", { keyId: K4, keyName: "gone", syncedText: "Gone" }, { frameId: "16:1", frameName: "Gone" }),
    // Text directly on the page has no frame.
    linkedNode("1:9", "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now" }, { frameId: null, frameName: null }),
  ]
}

// The canvas with a workspace and the API a review and a push use. A scan of the page reads every layer, of the
// selection the selected ones, by id the ones named.
function scene(nodes: ScannedNode[] = canvas()) {
  let current = nodes
  let selection: string[] | null = null
  const texts = new Map<string, string>([[K1, "Pay now"], [K2, "Total"], [K3, "Shipping"]])
  const run = vi.fn(async (scope: Scope, _progress?: (scanned: number) => void, nodeIds?: readonly string[]): Promise<ScanResult> => {
    const picked =
      nodeIds !== undefined
        ? nodeIds.map((id) => current.find((node) => node.nodeId === id)).filter((node): node is ScannedNode => node !== undefined)
        : scope === "selection" && selection !== null
          ? current.filter((node) => selection?.includes(node.nodeId))
          : current
    return { scope, nodes: picked, total: picked.length, truncated: false, skipped: SKIPPED }
  })
  const scanner: ScanRunner = { cancel: vi.fn(), run }
  const resolveKeys = vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => ({
    source: "draft",
    variation_option: null,
    keys: request.key_ids.filter((id) => texts.has(id)).map((id) => resolvedKey(id, "key_" + id.slice(-1), texts.get(id) ?? "")),
    missing_key_ids: request.key_ids.filter((id) => !texts.has(id)),
  }))
  const keysByName = vi.fn(async (_projectId: string, request: FigmaByNameRequest): Promise<FigmaByNameResponse> => ({ keys: [], missing: request.names ?? [], text_matches: [] }))
  const workspace = createWorkspace({ scanner, api: { resolveKeys }, project: () => ({ id: PROJECT_ID, main_language: "en" }) })
  const inputOf = (state: WorkspaceState = workspace.store.get()): PushInput => ({
    projectId: PROJECT_ID,
    scope: state.result?.scope ?? "page",
    nodes: state.result?.nodes ?? [],
    remote: state.remote,
    sample: [],
    settings: null,
    groupIdenticalTexts: true,
    pending: state.pending,
  })
  const deps: PushCheckDeps = { api: { keysByName }, state: () => workspace.store.get(), input: inputOf, scanLayers: (nodeIds) => workspace.scanLayers(nodeIds) }
  return {
    workspace,
    texts,
    deps,
    setNodes: (next: ScannedNode[]) => (current = next),
    nodes: () => current,
    select: (nodeIds: string[]) => (selection = nodeIds),
    async review(scope: Scope = "page") {
      await workspace.scan(scope)
      return preparePush({ keysByName }, inputOf())
    },
  }
}

// The app's uploader around the real queue: the gate of `gate()` (the setting included unless ignored), main's export
// of each frame (an image of 400 × 800, or what `exported` says) and E19, whose answers `upload` decides.
function uploader(
  options: {
    gate?: () => ScreenshotGate
    availability?: () => Availability
    upload?: (upload: ScreenshotUpload) => Promise<void>
    exported?: (frameId: string) => FrameExportResult | null
  } = {},
) {
  const sent: string[] = []
  const exports: string[] = []
  const prepared: ({ ignorePref?: boolean } | undefined)[] = []
  const deps: ScreenshotDeps = {
    exportFrame: vi.fn(async (frameId: string): Promise<FrameExportResult> => {
      exports.push(frameId)
      return (
        options.exported?.(frameId) ?? {
          kind: "image",
          image: { frameId, frameName: "", pageId: "0:1", pageName: "Mobile", format: "PNG", bytes: new Uint8Array(10), width: 400, height: 800, boxes: [] },
        }
      )
    }),
    measure: async () => null,
    upload: vi.fn(async (upload: ScreenshotUpload) => {
      await options.upload?.(upload)
      sent.push(upload.meta.frame_id)
      return { screenshot: {} as FigmaScreenshot, unchanged_image: false, dropped_boxes: [] }
    }),
    sleep: async () => {},
  }
  const shots: ScreenshotUploader = {
    prepare: vi.fn(async (prepareOptions?: { ignorePref?: boolean }) => {
      prepared.push(prepareOptions)
      return { gate: options.gate?.() ?? OPEN, availability: options.availability?.() ?? READY }
    }),
    upload: vi.fn((frames: readonly ScreenshotFrame[], runOptions) => uploadScreenshots(deps, frames, runOptions)),
  }
  return { shots, sent, exports, prepared, deps }
}

function shotsDeps(
  api: ShotsDeps["api"],
  shots: ScreenshotUploader,
  extra: Partial<ShotsDeps> = {},
): ShotsDeps & { progress: ScreenshotRun[]; checking: () => number } {
  const progress: ScreenshotRun[] = []
  let checking = 0
  return {
    api,
    projectId: PROJECT_ID,
    uploader: shots,
    stored: createStoredSlot(),
    failed: createFailedFrames(),
    stopped: () => false,
    onChecking: () => checking++,
    onProgress: (run) => progress.push(run),
    progress,
    checking: () => checking,
    ...extra,
  }
}

const ids = (frames: readonly ScreenshotFrame[]) => frames.map((frame) => frame.frameId)
const none: StoredFrames = { fileKey: FILE_KEY, frameIds: new Set(), checked: null }

describe("which frames count (the reviewed scope, the top frame, layers that show a key of this project)", () => {
  const remote = new Map([
    [K1, found()],
    [K2, found()],
    [K3, found()],
  ])

  it("takes each top frame once, in layer order, for layers that show a key of this project that ReRune has", () => {
    expect(linkedFrames(canvas(), PROJECT_ID, remote)).toEqual([
      frameOf("10:1", "Checkout"),
      frameOf("11:1", "Cart"),
      frameOf("12:1", "Done"),
      frameOf("13:1", "Receipt"),
    ])
  })

  it("leaves out unlinked layers, copies, overridden instance text, other projects' links, keys ReRune doesn't have and text without a frame", () => {
    const [ok] = canvas()
    expect(showsProjectKey(ok, PROJECT_ID, remote)).toBe(true)
    expect(showsProjectKey({ ...ok, link: null, linkState: "none" }, PROJECT_ID, remote)).toBe(false)
    expect(showsProjectKey({ ...ok, linkState: "copied" }, PROJECT_ID, remote)).toBe(false)
    expect(showsProjectKey({ ...ok, linkState: "inherited_overridden" }, PROJECT_ID, remote)).toBe(false)
    expect(showsProjectKey({ ...ok, linkState: "invalid" }, PROJECT_ID, remote)).toBe(false)
    expect(showsProjectKey({ ...ok, linkState: "inherited" }, PROJECT_ID, remote)).toBe(true)
    expect(showsProjectKey(ok, OTHER_PROJECT_ID, remote)).toBe(false)
    expect(showsProjectKey({ ...ok, link: ok.link === null ? null : { ...ok.link, id: "not-an-id" } }, PROJECT_ID, remote)).toBe(false)
    // ReRune hasn't answered for the key, the key is gone, or it is not a text key (no box would stay).
    expect(showsProjectKey(ok, PROJECT_ID, new Map())).toBe(false)
    expect(showsProjectKey(ok, PROJECT_ID, new Map([[K1, { found: false, type: "key" as const }]]))).toBe(false)
    expect(showsProjectKey(ok, PROJECT_ID, new Map([[K1, found("object")]]))).toBe(false)
    // A disabled or plural key is still a text key: its box stays, so it counts.
    expect(linkedFrames([canvas()[8]], PROJECT_ID, new Map([[K4, found()]]))).toEqual([frameOf("16:1", "Gone")])
    expect(linkedFrames([canvas()[9]], PROJECT_ID, remote)).toEqual([])
  })

  it("follows the review's scope: a Selection review counts only the selected layers' frames, a Page review every frame on the page", async () => {
    const s = scene()
    s.select(["1:3"])
    const selection = await s.review("selection")
    expect(ids(planFrames(selection))).toEqual(["11:1"])
    const page = await s.review("page")
    expect(ids(planFrames(page))).toEqual(["10:1", "11:1", "12:1", "13:1"])
  })

  it("follows the plan the background read builds again: a frame whose key ReRune deleted leaves the count", async () => {
    const s = scene()
    const reviewed = await s.review()
    const base = planBase(s.workspace.store.get())
    expect(ids(planFrames(reviewed))).toEqual(["10:1", "11:1", "12:1", "13:1"])
    s.texts.delete(K3)
    await s.workspace.refreshKeys()
    const followed = await followShown(s.deps, reviewed, base, false)
    if (followed?.kind !== "adopt") throw new Error("the plan should follow")
    expect(ids(planFrames(followed.prepared))).toEqual(["10:1", "11:1", "13:1"])
  })

  it("leaves out a frame with a layer Changed in ReRune: Update layers from ReRune gives it ReRune's text and uploads it", async () => {
    const s = scene()
    // ReRune's text of pay_now changed: 1:1 (frame 10:1) is Changed in ReRune.
    s.texts.set(K1, "Pay today")
    const reviewed = await s.review()
    expect(reviewed.plan.pulls.map((pull) => pull.keyId)).toEqual([K1])
    expect(ids(planFrames(reviewed))).toEqual(["11:1", "12:1", "13:1"])
    // The pull's frames are the frames it changed: 10:1 goes then, with the new text.
    const checked = await checkPlan(s.deps, reviewed, pullSignature)
    if (checked.kind !== "same") throw new Error("the plan should be the same")
    const pulled = await executePulls({ bus: fakeMain().bus }, checked.prepared.plan, checked.prepared.context)
    expect(ids(affectedFrames(pulled.affectedNodeIds, checked.prepared.context.nodes))).toEqual(["10:1"])
  })
})

describe("the file's screenshots (E20 ?file_key=…, every page)", () => {
  it("follows the cursor without the request filter and keeps the frames of this file", async () => {
    const api = listing([screenshot(1, "10:1"), screenshot(2, "11:1", { refresh_requested_at: "2026-10-29T10:00:00Z" })], [screenshot(3, "12:1"), screenshot(4, "13:1", { file_key: OTHER_FILE_KEY })])
    const stored = await loadStoredFrames(api, PROJECT_ID, FILE_KEY)
    expect(api.calls).toEqual([
      { file_key: FILE_KEY, cursor: null, limit: 100 },
      { file_key: FILE_KEY, cursor: "c1", limit: 100 },
    ])
    expect(api.calls.every((query) => !("refresh_requested" in query))).toBe(true)
    expect(stored).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["10:1", "11:1", "12:1"]), checked: null })
  })

  it("is unknown (null) past 10,000 screenshots, so nothing counts as missing", async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, i) => screenshot(start + i, "10:" + (start + i)))
    const endless = listing(...Array.from({ length: 101 }, (_, i) => page(i * 100)), [])
    expect(await loadStoredFrames(endless, PROJECT_ID, FILE_KEY)).toBeNull()
    expect(endless.calls).toHaveLength(100)
    const full = listing(...Array.from({ length: 100 }, (_, i) => page(i * 100)))
    expect((await loadStoredFrames(full, PROJECT_ID, FILE_KEY))?.frameIds.size).toBe(10000)
  })

  it("stops between pages on Stop (unknown), and throws on errors (the callers decide what that means)", async () => {
    const api = listing([screenshot(1, "10:1")], [screenshot(2, "11:1")])
    let stop = false
    api.screenshots.mockImplementationOnce(async (_projectId, query) => {
      api.calls.push(query)
      stop = true
      return { screenshots: [screenshot(1, "10:1")], next_cursor: "c1", has_more: true }
    })
    expect(await loadStoredFrames(api, PROJECT_ID, FILE_KEY, () => stop)).toBeNull()
    expect(api.calls).toHaveLength(1)
    const failing = { screenshots: vi.fn(async () => Promise.reject(new ApiError(503, "design_storage_disabled", "off"))) }
    await expect(loadStoredFrames(failing, PROJECT_ID, FILE_KEY)).rejects.toThrow()
  })
})

describe("asking ReRune as little as it can (checkStoredFrames)", () => {
  const frames = (count: number) => Array.from({ length: count }, (_, i) => frameOf("20:" + i, "Screen " + i))

  it("asks up to 10 frames one by one (E20 frame_id, one each) and keeps which it asked", async () => {
    const api = server(["20:1", "99:1"])
    let reads = 0
    const stored = await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(10), null, { onRead: () => reads++ })
    expect(api.calls[0]).toEqual({ file_key: FILE_KEY, frame_id: "20:0", limit: 1 })
    expect(api.asked()).toEqual(ids(frames(10)))
    expect(api.whole()).toBe(0)
    expect(reads).toBe(1)
    expect(stored).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["20:1"]), checked: new Set(ids(frames(10))) })
    // A frame it didn't ask about is not counted as missing.
    expect(ids(missingFrames([...frames(3), frameOf("30:1", "Other")], stored ?? none))).toEqual(["20:0", "20:2"])
  })

  it("reads the file's whole list for more than 10 frames", async () => {
    const api = server(["20:1"])
    expect(await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(11), null)).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["20:1"]), checked: null })
    expect(api.calls).toEqual([{ file_key: FILE_KEY, cursor: null, limit: 100 }])
  })

  it("asks again only about frames not known to have a screenshot, and nothing when every frame has one", async () => {
    const api = server(["20:0", "20:1", "20:2"])
    const known: StoredFrames = { fileKey: FILE_KEY, frameIds: new Set(["20:0", "20:1"]), checked: null }
    let reads = 0
    const again = await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(3), known, { onRead: () => reads++ })
    expect(api.asked()).toEqual(["20:2"])
    // A whole list asked again about a few frames stays whole.
    expect(again).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["20:0", "20:1", "20:2"]), checked: null })
    api.calls.length = 0
    expect(await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(3), again, { onRead: () => reads++ })).toBe(again)
    expect(api.calls).toEqual([])
    expect(reads).toBe(1)
    // What was asked one by one adds up.
    const partial: StoredFrames = { fileKey: FILE_KEY, frameIds: new Set(["20:0"]), checked: new Set(["20:0", "20:5"]) }
    expect((await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(2), partial))?.checked).toEqual(new Set(["20:0", "20:5", "20:1"]))
  })

  it("treats a list of another file as unknown, and stops between requests", async () => {
    const api = server([])
    await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(2), { ...none, fileKey: OTHER_FILE_KEY, frameIds: new Set(["20:0"]) })
    expect(api.asked()).toEqual(["20:0", "20:1"])
    api.calls.length = 0
    let asked = 0
    api.screenshots.mockImplementation(async (_projectId, query) => {
      api.calls.push(query)
      asked++
      return { screenshots: [], next_cursor: null, has_more: false }
    })
    expect(await checkStoredFrames(api, PROJECT_ID, FILE_KEY, frames(5), null, { stopped: () => asked === 2 })).toBeNull()
    expect(api.calls).toHaveLength(2)
  })
})

describe("missing frames, one run's frames and the list after a run", () => {
  const linked = [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart"), frameOf("12:1", "Done")]

  it("are the linked frames known to have no screenshot", () => {
    expect(missingFrames(linked, { frameIds: new Set(["11:1", "99:1"]), checked: null })).toEqual([frameOf("10:1", "Checkout"), frameOf("12:1", "Done")])
    expect(missingFrames(linked, { frameIds: new Set(), checked: new Set(["12:1"]) })).toEqual([frameOf("12:1", "Done")])
  })

  it("puts the changed frames first and each frame once", () => {
    expect(framesWith([frameOf("12:1", "Done"), frameOf("20:1", "New")], linked)).toEqual([frameOf("12:1", "Done"), frameOf("20:1", "New"), frameOf("10:1", "Checkout"), frameOf("11:1", "Cart")])
  })

  it("adds the uploaded frames, and drops a list of another file", () => {
    const stored: StoredFrames = { fileKey: FILE_KEY, frameIds: new Set(["11:1"]), checked: new Set(["11:1"]) }
    expect(withUploaded(stored, FILE_KEY, ["10:1"])).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["10:1", "11:1"]), checked: new Set(["11:1"]) })
    expect(withUploaded(stored, FILE_KEY, [])).toBe(stored)
    expect(withUploaded(stored, OTHER_FILE_KEY, ["10:1"])).toBeNull()
    expect(withUploaded(null, FILE_KEY, ["10:1"])).toBeNull()
  })

  it("says how many frames have none, and that the push uploads them too", () => {
    expect(missingLine(3, false)).toBe("3 frames with linked keys have no screenshot in ReRune yet.")
    expect(missingLine(1, false)).toBe("1 frame with linked keys has no screenshot in ReRune yet.")
    expect(missingLine(3, true)).toBe("3 frames with linked keys have no screenshot in ReRune yet. Push uploads them too.")
    expect(missingLine(1, true)).toBe("1 frame with linked keys has no screenshot in ReRune yet. Push uploads it too.")
  })
})

describe("the note's list, read with the review", () => {
  const linked = [frameOf("10:1", "Checkout")]

  it("asks ReRune for the gate's file when the gate is open and the review has linked frames", async () => {
    const api = server(["11:1"])
    const { shots, prepared } = uploader()
    expect(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: shots }, linked)).toEqual({ fileKey: FILE_KEY, frameIds: new Set(), checked: new Set(["10:1"]) })
    expect(api.asked()).toEqual(["10:1"])
    // The setting governs: the gate is asked without ignorePref.
    expect(prepared).toEqual([undefined])
  })

  it("reads nothing and shows no note with the setting off or the gate closed (sandbox, storage off, no Edit keys, no link, a branch, a suspected copy)", async () => {
    const input = { pref: true, availability: READY, settings: linkedFile(), rootName: "Chapter", permissions: ["edit_keys"] }
    const closed = [
      screenshotGate({ ...input, pref: false }),
      screenshotGate({ ...input, availability: { ...READY, user: { ...USER, sandbox_expires_at: "2026-10-29T15:00:00Z" } } }),
      screenshotGate({ ...input, availability: { ...READY, meta: { ...META, screenshots_enabled: false } } }),
      screenshotGate({ ...input, permissions: ["view_keys"] }),
      screenshotGate({ ...input, settings: null }),
      screenshotGate({ ...input, settings: linkedFile({ branchKey: "BrAnCh1234567890" }) }),
      screenshotGate({ ...input, rootName: "Chapter (Copy)" }),
      screenshotGate({ ...input, availability: { meta: null, user: null, error: "Can't reach ReRune." } }),
    ]
    expect(closed.map((gate) => gate.reason)).toEqual(["pref_off", "sandbox", "server_disabled", "no_permission", "no_file", "branch", "possible_copy", "unavailable"])
    for (const gate of closed) {
      const api = server([])
      const { shots } = uploader({ gate: () => gate })
      expect(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: shots }, linked)).toBeNull()
      expect(api.screenshots).not.toHaveBeenCalled()
    }
    expect(screenshotGate(input)).toEqual(OPEN)
  })

  it("asks nothing without linked frames or an uploader, and is silent when E20 fails", async () => {
    const api = server([])
    const { shots } = uploader()
    expect(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: shots }, [])).toBeNull()
    expect(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: null }, linked)).toBeNull()
    expect(shots.prepare).not.toHaveBeenCalled()
    const failing = { screenshots: vi.fn(async () => Promise.reject(new ApiError(429, null, "slow down", 60))) }
    expect(await readStoredFrames({ api: failing, projectId: PROJECT_ID, uploader: shots }, linked)).toBeNull()
  })

  it("drops a review's list that lands after a newer one (no stale reads)", () => {
    const changes: (StoredFrames | null)[] = []
    const slot = createStoredSlot((next) => changes.push(next))
    const reviewRead = slot.begin()
    slot.set({ fileKey: FILE_KEY, frameIds: new Set(["10:1"]), checked: null })
    reviewRead(none)
    expect(slot.get()).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["10:1"]), checked: null })
    const next = slot.begin()
    next({ fileKey: FILE_KEY, frameIds: new Set(["10:1", "11:1"]), checked: null })
    expect(slot.get()?.frameIds.size).toBe(2)
    expect(changes).toHaveLength(2)
  })

  it("keeps a review's read when a run only uploads (a pull), and adds the run's frames to what it finds", () => {
    const slot = createStoredSlot()
    const reviewRead = slot.begin()
    slot.add(FILE_KEY, ["12:1"])
    expect(slot.get()).toBeNull()
    reviewRead(none)
    expect(slot.get()).toEqual({ fileKey: FILE_KEY, frameIds: new Set(["12:1"]), checked: null })
    slot.add(FILE_KEY, ["13:1"])
    expect(slot.get()?.frameIds).toEqual(new Set(["12:1", "13:1"]))
    // Uploads to another file (its link changed meanwhile): a list of the old file is dropped.
    const later = slot.begin()
    slot.add(OTHER_FILE_KEY, ["14:1"])
    expect(slot.get()).toBeNull()
    later(none)
    expect(slot.get()).toBeNull()
  })
})

describe("First push on a new project uploads screenshots of linked frames", () => {
  function pushApi() {
    return {
      push: vi.fn(async (): Promise<FigmaPushResponse> => ({
        results: [{ client_ref: "u" + K3, status: "updated", key_id: K3, key: "shipping", reason: null, message: null, current_text: null }],
        summary: { created: 0, updated: 1, unchanged: 0, conflicts: 0, failed: 0 },
        available_keys: null,
      })),
    }
  }

  it("uploads the changed frame and every linked frame without a screenshot, each once, asking ReRune only what it doesn't know", async () => {
    const s = scene()
    const api = server(["13:1"])
    const { shots, sent } = uploader()
    // The review: four frames show keys (asked one by one), the server has a screenshot of 13:1 only.
    const reviewed = await s.review()
    const deps = shotsDeps(api, shots)
    deps.stored.set(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: shots }, planFrames(reviewed)))
    expect(api.asked()).toEqual(["10:1", "11:1", "12:1", "13:1"])
    expect(ids(missingFrames(planFrames(reviewed), deps.stored.get() ?? none))).toEqual(["10:1", "11:1", "12:1"])
    // The push: the plan's layers checked again by id, the push, then the upload of the changed frame (12:1) and the others.
    const checked = await checkPlan(s.deps, reviewed, planSignature)
    if (checked.kind === "error") throw new Error(checked.message)
    const pushed = await executePush({ api: pushApi(), bus: fakeMain().bus }, checked.prepared.plan, checked.prepared.context)
    const changed = affectedFrames(pushed.affectedNodeIds, checked.prepared.context.nodes)
    expect(ids(changed)).toEqual(["12:1"])
    api.calls.length = 0
    const outcome = await runUpload(deps, changed, planFrames(checked.prepared))
    expect(outcome).toMatchObject({ kind: "done", run: { total: 3, uploaded: 3, stopped: null } })
    expect(sent).toEqual(["12:1", "10:1", "11:1"])
    expect(deps.progress[0]).toEqual(emptyScreenshotRun(3))
    // Only the three frames without a screenshot were asked again; 13:1 is known to have one.
    expect(api.asked()).toEqual(["10:1", "11:1", "12:1"])
    expect(deps.checking()).toBe(1)
    // Afterwards nothing is missing: the note goes, and the next push sends only what it changes, asking nothing.
    expect(missingFrames(planFrames(checked.prepared), deps.stored.get() ?? none)).toEqual([])
    api.stored.add("10:1").add("11:1").add("12:1")
    api.calls.length = 0
    const again = await runUpload(deps, [frameOf("12:1", "Done")], planFrames(checked.prepared))
    expect(again).toMatchObject({ kind: "done", run: { total: 1 } })
    expect(api.calls).toEqual([])
    expect(deps.checking()).toBe(1)
  })

  it("reads the whole list once for a page with many frames, then asks nothing on the next push", async () => {
    const nodes = Array.from({ length: 30 }, (_, i) => linkedNode("3:" + i, "Pay now", { keyId: K1, keyName: "pay_now", syncedText: "Pay now" }, { frameId: "30:" + i, frameName: "Screen " + i }))
    const s = scene(nodes)
    const api = server(["30:0"])
    const { shots, sent } = uploader()
    const reviewed = await s.review()
    const deps = shotsDeps(api, shots)
    deps.stored.set(await readStoredFrames({ api, projectId: PROJECT_ID, uploader: shots }, planFrames(reviewed)))
    expect(api.calls).toEqual([{ file_key: FILE_KEY, cursor: null, limit: 100 }])
    expect(await runUpload(deps, [], planFrames(reviewed))).toMatchObject({ kind: "done", run: { uploaded: 29 } })
    expect(sent).toHaveLength(29)
    expect(api.whole()).toBe(2)
    api.calls.length = 0
    expect(await runUpload(deps, [frameOf("30:3", "Screen 3")], planFrames(reviewed))).toMatchObject({ kind: "done", run: { total: 1 } })
    expect(api.calls).toEqual([])
  })

  it("rechecks the review's layers by id: a frame whose layers were unlinked or deleted since the review is not uploaded", async () => {
    const s = scene()
    const api = server([])
    const { shots, sent } = uploader()
    const reviewed = await s.review()
    s.setNodes(s.nodes().filter((node) => node.frameId !== "11:1").map((node) => (node.nodeId === "1:1" ? { ...node, link: null, linkState: "none" as const } : node)))
    const checked = await checkPlan(s.deps, reviewed, planSignature)
    if (checked.kind === "error") throw new Error(checked.message)
    await runUpload(shotsDeps(api, shots), [], planFrames(checked.prepared))
    // 10:1 keeps 1:2 (still linked); 11:1 is gone.
    expect(sent).toEqual(["10:1", "12:1", "13:1"])
  })

  it("Upload screenshots on its own: nothing to push, the same frames go, and nothing left says so", async () => {
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    const api = server([])
    const { shots, sent } = uploader()
    const reviewed = await s.review()
    expect(reviewed.plan.updates).toEqual([])
    const deps = shotsDeps(api, shots)
    expect(await runUpload(deps, [], planFrames(reviewed), true)).toMatchObject({ kind: "done", run: { uploaded: 3 } })
    expect(sent).toEqual(["10:1", "11:1", "13:1"])
    expect(missingFrames(planFrames(reviewed), deps.stored.get() ?? none)).toEqual([])
    // Clicked again from an older note after someone uploaded them all: ReRune is asked first, nothing is sent.
    sent.length = 0
    deps.stored.set(none)
    api.stored.add("10:1").add("11:1").add("13:1")
    expect(await runUpload(deps, [], planFrames(reviewed), true)).toEqual({ kind: "none" })
    expect(sent).toEqual([])
    expect(deps.stored.get()?.frameIds).toEqual(new Set(["10:1", "11:1", "13:1"]))
  })

  it("falls back to what the review found when ReRune can't be asked again, and to the changed frames without it", async () => {
    const failing = { screenshots: vi.fn(async () => Promise.reject(new ApiError(0, "network", "offline"))) }
    const linked = [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart")]
    const { shots, sent } = uploader()
    const deps = shotsDeps(failing, shots)
    deps.stored.set({ fileKey: FILE_KEY, frameIds: new Set(["10:1"]), checked: null })
    await runUpload(deps, [], linked)
    expect(sent).toEqual(["11:1"])
    sent.length = 0
    deps.stored.set({ fileKey: OTHER_FILE_KEY, frameIds: new Set(), checked: null })
    await runUpload(deps, [frameOf("12:1", "Done")], linked)
    expect(sent).toEqual(["12:1"])
  })

  it("uploads nothing and forgets the list with the setting off or the gate closed", async () => {
    const api = server([])
    let gate: ScreenshotGate = OPEN
    let availability: Availability = READY
    const { shots, sent } = uploader({ gate: () => gate, availability: () => availability })
    const deps = shotsDeps(api, shots)
    deps.stored.set(none)
    gate = { enabled: false, reason: "pref_off", fileKey: null }
    expect(await runUpload(deps, [frameOf("12:1", "Done")], [frameOf("10:1", "Checkout")])).toEqual({ kind: "off", unavailable: null, closed: SCREENSHOTS_OFF_TEXT })
    expect(deps.stored.get()).toBeNull()
    gate = { enabled: false, reason: "possible_copy", fileKey: null }
    expect(await runUpload(deps, [], [frameOf("10:1", "Checkout")])).toMatchObject({ kind: "off", unavailable: null, closed: COPY_HINT })
    gate = { enabled: false, reason: "unavailable", fileKey: null }
    availability = { meta: null, user: null, error: "Can't reach ReRune." }
    expect(await runUpload(deps, [], [frameOf("10:1", "Checkout")])).toMatchObject({ kind: "off", unavailable: "Can't reach ReRune." })
    expect(sent).toEqual([])
    expect(api.screenshots).not.toHaveBeenCalled()
  })

  it("Stop: the frames not uploaded still count as missing, so the note shows what is left", async () => {
    const api = server([])
    let stop = false
    const { shots, sent } = uploader({
      upload: async () => {
        stop = true
      },
    })
    const linked = [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart"), frameOf("12:1", "Done")]
    const deps = shotsDeps(api, shots, { stopped: () => stop })
    const outcome = await runUpload(deps, [], linked)
    expect(outcome).toMatchObject({ kind: "done", run: { uploaded: 1, stopped: "cancelled", notUploaded: 2 } })
    expect(sent).toEqual(["10:1"])
    expect(ids(missingFrames(linked, deps.stored.get() ?? none))).toEqual(["11:1", "12:1"])
  })

  it("Stop while ReRune is asked: nothing is uploaded, not even the changed frames", async () => {
    const api = server([])
    let stop = false
    api.screenshots.mockImplementation(async (_projectId, query) => {
      api.calls.push(query)
      stop = true
      return { screenshots: [], next_cursor: null, has_more: false }
    })
    const { shots, sent } = uploader()
    const deps = shotsDeps(api, shots, { stopped: () => stop })
    const outcome = await runUpload(deps, [frameOf("12:1", "Done")], [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart")])
    expect(outcome).toEqual({ kind: "done", run: { ...emptyScreenshotRun(1), stopped: "cancelled", notUploaded: 1 } })
    if (outcome.kind !== "done") throw new Error("done")
    expect(screenshotSummary(outcome.run)?.message).toBe("Screenshot upload stopped. 1 screenshot wasn't uploaded.")
    expect(api.calls).toHaveLength(1)
    expect(sent).toEqual([])
  })

  it("a large first upload waits on 429 and goes on, sending no frame twice", async () => {
    const api = server([])
    let calls = 0
    const { shots, sent } = uploader({
      upload: async () => {
        calls++
        if (calls === 61) throw new ApiError(429, null, "Too many requests. Please try again later.", 60)
      },
    })
    const linked = Array.from({ length: 80 }, (_, i) => frameOf("20:" + i, "Screen " + i))
    const deps = shotsDeps(api, shots)
    const outcome = await runUpload(deps, [], linked)
    expect(outcome).toMatchObject({ kind: "done", run: { total: 80, uploaded: 80, stopped: null, waiting: false } })
    expect(sent).toEqual(ids(linked))
    expect(deps.progress.some((run) => run.waiting && run.done === 60)).toBe(true)
  })

  it("a run that can't start reports why", async () => {
    const shots: ScreenshotUploader = { prepare: vi.fn(async () => Promise.reject(new ApiError(0, "network", "offline"))), upload: vi.fn() }
    expect(await runUpload(shotsDeps(server([]), shots), [], [frameOf("10:1", "Checkout")])).toEqual({ kind: "failed", message: "Can't reach ReRune. Check your connection." })
    expect(await runUpload(shotsDeps(server([]), shots), [], [])).toEqual({ kind: "none" })
  })
})

describe("frames that can't be uploaded (lasting problems)", () => {
  const linked = [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart"), frameOf("12:1", "Done")]
  const tooLarge = (frameId: string): FrameExportResult | null => (frameId === "11:1" ? { kind: "skipped", reason: "too_large" } : null)

  it("are left out of later pushes in this session, not asked about or exported again; Upload screenshots tries them again", async () => {
    const api = server([])
    const { shots, sent, exports } = uploader({ exported: tooLarge })
    const failed = createFailedFrames()
    const deps = shotsDeps(api, shots, { failed })
    const first = await runUpload(deps, [], linked)
    expect(first).toMatchObject({ kind: "done", run: { uploaded: 2, problems: [{ frameId: "11:1", lasting: true }] } })
    expect(failed.has(PROJECT_ID, FILE_KEY, "11:1")).toBe(true)
    // The next push: 11:1 has no screenshot but is left out, so nothing is asked, exported or sent for it.
    exports.length = 0
    api.calls.length = 0
    expect(await runUpload(deps, [frameOf("12:1", "Done")], linked)).toMatchObject({ kind: "done", run: { total: 1 } })
    expect(exports).toEqual(["12:1"])
    expect(api.calls).toEqual([])
    // Upload screenshots tries it again; once it uploads, it is forgotten.
    exports.length = 0
    const { shots: fixed, sent: sentNow } = uploader()
    const explicit = await runUpload({ ...deps, uploader: fixed }, [], linked, true)
    expect(explicit).toMatchObject({ kind: "done", run: { total: 1, uploaded: 1 } })
    expect(sentNow).toEqual(["11:1"])
    expect(failed.has(PROJECT_ID, FILE_KEY, "11:1")).toBe(false)
    expect(sent).toEqual(["10:1", "12:1", "12:1"])
  })

  it("keeps frames of other projects and files apart, and forgets nothing for a problem a later try can fix", () => {
    const failed: FailedFrames = createFailedFrames()
    failed.record(PROJECT_ID, FILE_KEY, {
      problems: [
        { frameId: "10:1", frameName: "Checkout", message: TOO_LARGE_MESSAGE, lasting: true },
        { frameId: "11:1", frameName: "Cart", message: "The frame shows a language preview." },
      ],
      uploadedFrameIds: [],
    })
    expect(failed.has(PROJECT_ID, FILE_KEY, "10:1")).toBe(true)
    expect(failed.has(PROJECT_ID, FILE_KEY, "11:1")).toBe(false)
    expect(failed.has(PROJECT_ID, OTHER_FILE_KEY, "10:1")).toBe(false)
    expect(failed.has(OTHER_PROJECT_ID, FILE_KEY, "10:1")).toBe(false)
  })

  it("after the project's screenshot limit, the rest of the frames without a screenshot are left out, the changed ones still go", async () => {
    const api = server([])
    let limit = false
    const { shots, sent, exports } = uploader({
      upload: async (upload) => {
        if (upload.meta.frame_id === "10:1") limit = true
        // 12:1 has a screenshot: replacing it adds none.
        if (limit && upload.meta.frame_id !== "12:1") throw new ApiError(403, "screenshot_limit_reached", "This project reached its screenshot limit")
      },
    })
    const failed = createFailedFrames()
    const deps = shotsDeps(api, shots, { failed })
    api.stored.add("12:1")
    const many = [frameOf("10:1", "Checkout"), frameOf("11:1", "Cart"), frameOf("13:1", "Receipt"), frameOf("14:1", "Profile")]
    const outcome = await runUpload(deps, [frameOf("12:1", "Done")], many)
    if (outcome.kind !== "done") throw new Error("done")
    expect(sent).toEqual(["12:1"])
    expect(exports).toEqual(["12:1", "10:1", "11:1"])
    expect(outcome.run.problems.map((problem) => [problem.frameId, problem.message])).toEqual([
      ["10:1", REASON_MESSAGES.screenshot_limit_reached],
      ["11:1", REASON_MESSAGES.screenshot_limit_reached],
      ["13:1", REASON_MESSAGES.screenshot_limit_reached],
      ["14:1", REASON_MESSAGES.screenshot_limit_reached],
    ])
    // The next push leaves them all out.
    expect(ids(many).every((frameId) => failed.has(PROJECT_ID, FILE_KEY, frameId))).toBe(true)
  })
})

describe("the Push screen's screenshots (createPushShots: review, note, Upload screenshots, push, pull, Stop)", () => {
  function screen(options: { api?: ReturnType<typeof server>; shots?: ReturnType<typeof uploader>; failed?: FailedFrames } = {}) {
    const api = options.api ?? server([])
    const up = options.shots ?? uploader()
    const failed = options.failed ?? createFailedFrames()
    const ctl = createPushShots(() => ({ api, projectId: PROJECT_ID, uploader: up.shots, failed }))
    const seen: (ShotsState | null)[] = []
    ctl.store.subscribe((state) => {
      if (seen[seen.length - 1] !== state.shots) seen.push(state.shots)
    })
    // The list read with a review lands.
    const settle = () => vi.waitFor(() => expect(ctl.store.get().stored).not.toBeNull())
    return { ctl, api, up, failed, seen, settle }
  }

  it("review → the note's count → Upload screenshots → checking, progress, the result → the note is gone", async () => {
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    const { ctl, up, seen, settle } = screen()
    ctl.reset()
    const reviewed = await s.review()
    ctl.read(reviewed)
    await settle()
    expect(missingLine(ctl.noteFrames(reviewed, false).length, false)).toBe("3 frames with linked keys have no screenshot in ReRune yet.")
    // The screen checks the plan's layers again by id, then Upload screenshots. While it runs the note is gone.
    const checked = await checkPlan(s.deps, reviewed, planSignature)
    if (checked.kind === "error") throw new Error(checked.message)
    const counted: [string | null, number][] = []
    ctl.store.subscribe((state) => counted.push([state.shots?.kind ?? null, ctl.noteFrames(reviewed, false).length]))
    ctl.clear()
    await ctl.uploadMissing(checked.prepared)
    const kinds = seen.map((shots) => shots?.kind ?? null)
    expect(kinds[0]).toBeNull()
    expect(kinds[1]).toBe("checking")
    expect(kinds[kinds.length - 1]).toBe("done")
    expect(new Set(kinds.slice(2, -1))).toEqual(new Set(["running"]))
    const first = seen[2]
    expect(first?.kind === "running" ? progressText(first.run) : null).toBe("Uploading screenshots… 1 of 3")
    const during = counted.filter(([kind]) => kind === "checking" || kind === "running")
    expect(during.length).toBeGreaterThan(0)
    expect(during.every(([, count]) => count === 0)).toBe(true)
    expect(up.sent).toEqual(["10:1", "11:1", "13:1"])
    const result = ctl.store.get().shots
    if (result?.kind !== "done") throw new Error("done")
    expect(screenshotSummary(result.run)?.message).toBe("3 screenshots uploaded.")
    expect(ctl.noteFrames(reviewed, false)).toEqual([])
    expect(ctl.store.get().note).toBeNull()
  })

  it("Upload screenshots with nothing left says so, and with the gate closed since the review says why", async () => {
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    let gate: ScreenshotGate = OPEN
    const api = server([])
    const { ctl, settle } = screen({ api, shots: uploader({ gate: () => gate }) })
    const reviewed = await s.review()
    ctl.read(reviewed)
    await settle()
    api.stored.add("10:1").add("11:1").add("13:1")
    await ctl.uploadMissing(reviewed)
    expect(ctl.store.get().note).toEqual({ tone: "good", text: NONE_MISSING })
    expect(ctl.store.get().shots).toBeNull()
    api.stored.clear()
    gate = { enabled: false, reason: "possible_copy", fileKey: null }
    ctl.clear()
    await ctl.uploadMissing(reviewed)
    expect(ctl.store.get().note).toEqual({ tone: "warning", text: COPY_HINT })
    expect(ctl.store.get().stored).toBeNull()
  })

  it("a push uploads the changed frames and the missing ones; when its request failed, only the changed ones", async () => {
    const s = scene()
    const { ctl, up, settle } = screen()
    const reviewed = await s.review()
    ctl.read(reviewed)
    await settle()
    expect(ctl.noteFrames(reviewed, true)).toHaveLength(4)
    await ctl.afterPush(reviewed, { affectedNodeIds: ["1:4"], requestError: "Can't reach ReRune. Check your connection." })
    expect(up.sent).toEqual(["12:1"])
    await ctl.afterPush(reviewed, { affectedNodeIds: ["1:4"], requestError: null })
    expect(up.sent).toEqual(["12:1", "12:1", "10:1", "11:1", "13:1"])
  })

  it("the note leaves out, when there is something to push, the frames a push leaves out (failed for good); Upload screenshots counts them", async () => {
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    const failed = createFailedFrames()
    const { ctl, settle } = screen({ failed })
    const reviewed = await s.review()
    ctl.read(reviewed)
    await settle()
    failed.record(PROJECT_ID, FILE_KEY, { problems: [{ frameId: "11:1", frameName: "Cart", message: TOO_LARGE_MESSAGE, lasting: true }], uploadedFrameIds: [] })
    expect(ids(ctl.noteFrames(reviewed, true))).toEqual(["10:1", "13:1"])
    expect(ids(ctl.noteFrames(reviewed, false))).toEqual(["10:1", "11:1", "13:1"])
  })

  it("drops a review's read that lands after a run asked ReRune, and keeps one when a pull only uploaded", async () => {
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    const api = server([])
    let release: () => void = () => {}
    const { ctl, up } = screen({ api })
    // The review's read waits until released.
    api.screenshots.mockImplementationOnce(async (_projectId, query) => {
      api.calls.push(query)
      await new Promise<void>((resolve) => (release = resolve))
      return { screenshots: [], next_cursor: null, has_more: false }
    })
    const reviewed = await s.review()
    ctl.read(reviewed)
    await vi.waitFor(() => expect(api.calls).toHaveLength(1))
    // A pull uploads 10:1 meanwhile: the review's answer (asked before) still lands, with 10:1 added.
    await ctl.upload([frameOf("10:1", "Checkout")])
    expect(up.sent).toEqual(["10:1"])
    release()
    await vi.waitFor(() => expect(ctl.store.get().stored).not.toBeNull())
    expect(ids(ctl.noteFrames(reviewed, false))).toEqual(["11:1", "13:1"])
    // A second review whose read lands after Upload screenshots asked ReRune again is dropped.
    ctl.reset()
    api.screenshots.mockImplementationOnce(async (_projectId, query) => {
      api.calls.push(query)
      await new Promise<void>((resolve) => (release = resolve))
      return { screenshots: [], next_cursor: null, has_more: false }
    })
    ctl.read(reviewed)
    await ctl.uploadMissing(reviewed)
    expect(ctl.noteFrames(reviewed, false)).toEqual([])
    release()
    // The late read asks about 11:1 and 13:1 too, then lands, and is dropped.
    await vi.waitFor(() => expect(api.asked().filter((frameId) => frameId === "13:1")).toHaveLength(3))
    await Promise.resolve()
    expect(ctl.noteFrames(reviewed, false)).toEqual([])
  })

  it("an upload with no frames (Take ReRune text on text without a frame) or a closed gate leaves the push's result shown", async () => {
    let gate: ScreenshotGate = OPEN
    const { ctl } = screen({ shots: uploader({ gate: () => gate }) })
    await ctl.upload([frameOf("12:1", "Done")])
    const shown = ctl.store.get().shots
    expect(shown?.kind).toBe("done")
    await ctl.upload([])
    expect(ctl.store.get().shots).toBe(shown)
    gate = { enabled: false, reason: "pref_off", fileKey: null }
    await ctl.upload([frameOf("12:1", "Done")])
    expect(ctl.store.get().shots).toBe(shown)
  })

  it("Stop while ReRune is asked shows Stopping… and uploads nothing", async () => {
    const api = server([])
    const { ctl, up } = screen({ api })
    const s = scene(canvas().filter((node) => node.nodeId !== "1:4"))
    const reviewed = await s.review()
    api.screenshots.mockImplementation(async (_projectId, query) => {
      api.calls.push(query)
      ctl.stop()
      return { screenshots: [], next_cursor: null, has_more: false }
    })
    await ctl.uploadMissing(reviewed)
    expect(ctl.store.get()).toMatchObject({ stopping: true, shots: { kind: "done", run: { stopped: "cancelled" } } })
    expect(up.sent).toEqual([])
    expect(CHECKING_SHOTS_TEXT).toBe("Checking which frames have a screenshot in ReRune…")
  })
})

describe("with the refresh requests and the background reads", () => {
  it("never counts a requested frame as missing (a request lives on a screenshot), and the upload reads the requests again after", async () => {
    const api = listing([screenshot(1, "10:1", { refresh_requested_at: "2026-10-29T10:00:00Z", outdated_box_count: 2 })])
    const { shots, sent } = uploader()
    const refetch = vi.fn(async () => {})
    const deps = shotsDeps(api, refetchAfterUpload(shots, refetch))
    await runUpload(deps, [], Array.from({ length: 11 }, (_, i) => (i === 0 ? frameOf("10:1", "Checkout") : frameOf("11:" + i, "Cart " + i))))
    expect(sent).not.toContain("10:1")
    expect(sent).toHaveLength(10)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("Update screenshots and the background reads wait while Upload screenshots holds the work lock", async () => {
    const lock = createWorkLock()
    // The Push screen's exclusive run takes the lock through onBusy (the app's pushBusy), as "upload".
    expect(lock.acquire("upload")).toBe(true)
    expect(waitText("upload")).toBe("Wait for the screenshots to be uploaded")
    const scanFrames = vi.fn(async () => null)
    const refresh = createRefreshRequests({
      api: {
        screenshots: server([]).screenshots,
        cancelRefreshRequest: vi.fn(async () => {}),
        resolveKeys: vi.fn(async (): Promise<FigmaResolveResponse> => ({ source: "draft", variation_option: null, keys: [], missing_key_ids: [] })),
      },
      bus: fakeMain().bus,
      context: () => ({ projectId: PROJECT_ID, mainLanguage: "en", gate: { enabled: true, fileKey: FILE_KEY }, groupIdenticalTexts: true }),
      scanFrames,
      uploader: uploader().shots,
      lock,
    })
    await refresh.run()
    expect(scanFrames).not.toHaveBeenCalled()
    let listener: (event: WatchEvent) => void = () => {}
    const window: WatchWindow = {
      visible: () => true,
      listen: (next) => {
        listener = next
        return () => {}
      },
    }
    let now = 0
    const read = vi.fn(async () => ({ kind: "read" as const }))
    const schedule = createWatchSchedule({ busy: () => lock.holder() !== null, window, clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => {} } })
    schedule.add({ fetch: read }).start()
    now = 20000
    listener("attention")
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    // Once the run ends the reads come again.
    lock.release("upload")
    now = 40000
    listener("attention")
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe("wiring (push.tsx, app.tsx)", () => {
  it("reads the list with each review, uploads with the push and with Upload screenshots, and shows the note", () => {
    const review = pushScreen.slice(pushScreen.indexOf("  async function review() {"), pushScreen.indexOf("  function checkDeps("))
    expect(review).toContain("shotsCtl.reset()")
    expect(review).toContain("shotsCtl.read(next)")
    const push = pushScreen.slice(pushScreen.indexOf("  async function push() {"), pushScreen.indexOf("  // Upload screenshots, when there is nothing else"))
    expect(push).toContain("await shotsCtl.afterPush(fresh, pushed)")
    const upload = pushScreen.slice(pushScreen.indexOf("  async function uploadMissing() {"), pushScreen.indexOf("  function stopScreenshots("))
    expect(upload).toContain("await exclusive(async () => {")
    expect(upload).toContain("checked = await checkPlan(checkDeps(), prepared, planSignature)")
    expect(upload).toContain("await shotsCtl.uploadMissing(checked.prepared)")
    expect(upload).toContain('}, "upload")')
    // Pull, Overwrite and Take ReRune text upload only the frames they changed.
    expect(pushScreen.match(/await shotsCtl\.upload\(affectedFrames\([^\n]*\)\)\n/g)).toHaveLength(3)
    expect(pushScreen).toContain("shotsCtl.noteFrames(prepared, submittable)")
    expect(pushScreen).toContain("pushable={submittable}")
    expect(pushScreen).toContain("disabled={busy || plan.blockedByPreview.length > 0}")
    expect(pushScreen).toContain("Upload screenshots\n")
    expect(pushScreen).toContain("props.onBusy(true, task)")
    // The app hands the Push screen the uploader that reads the requests again after each run, the API with E20 and the
    // session's failed frames, and holds the work lock as "upload" for Upload screenshots.
    expect(appSource).toContain("screenshots={pushUploader}")
    expect(appSource).toContain("failedShots={failedShots}")
    expect(appSource).toContain('locked={workTask !== null && workTask !== "push" && workTask !== "upload"}')
    expect(appSource).toMatch(/<PushScreen[\s\S]*?api=\{api\}/)
    expect(statusSource).toContain('state.kind === "checking" ? CHECKING_SHOTS_TEXT : progressText(state.run)')
  })
})
