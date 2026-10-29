import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaMetaResponse, FigmaResolveRequest, FigmaResolveResponse, FigmaScreenshot, FigmaScreenshotsQuery, FigmaScreenshotsResponse, FigmaUser } from "../../shared/api-types"
import { src } from "../../shared/hash"
import type { FileSettings, ScannedNode } from "../../shared/messages"
import { newFileSettings } from "../../shared/plugin-data"
import { ApiError, RATE_LIMIT_MESSAGE } from "../api/client"
import { SCAN_UNFINISHED } from "./link-sync"
import type { ScanResult } from "./ops"
import {
  createRefreshRequests,
  framesLine,
  loadRefreshRequests,
  previewsLine,
  refetchAfterUpload,
  refreshGate,
  refreshLines,
  refreshNotice,
  refreshRequestOf,
  requestersLine,
  requestKey,
  type RefreshContext,
  type RefreshOutcome,
  type RefreshRequest,
} from "./refresh-requests"
import { emptyScreenshotRun, type Availability, type ScreenshotFrame, type ScreenshotGate, type ScreenshotRun, type ScreenshotRunOptions, type ScreenshotUploader } from "./screenshots"
import { fakeMain, resolvedKey } from "./test-fakes"
import { createWorkLock } from "./work-lock"
import { NO_MAIN_LANGUAGE } from "./workspace"

const FILE_KEY = "AbCdEf1234567890XyZ"
const META: FigmaMetaResponse = { api_version: 1, screenshots_enabled: true, max_image_bytes: 2097152, max_image_side: 4096, max_batch_size: 100, server_time: "2026-10-29T10:00:00Z", screenshot_freshness: true }
const USER: FigmaUser = { id: "kc-1", email: "dana@example.com", first_name: "Dana", last_name: "Designer", sandbox_expires_at: null }
const READY: Availability = { meta: META, user: USER, error: null }
const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }
const OPEN_GATE: ScreenshotGate = { enabled: true, reason: null, fileKey: FILE_KEY }

function linkedFile(overrides: Partial<FileSettings> = {}): FileSettings {
  return {
    ...newFileSettings({ apiBase: "http://localhost:8080", projectId: PROJECT_ID, projectName: "Chapter", now: 1 }),
    fileKey: FILE_KEY,
    fileUrl: "https://www.figma.com/design/" + FILE_KEY + "/Chapter",
    fileName: "Chapter",
    ...overrides,
  }
}

function screenshot(n: number, frameId: string, request: { at: string | null; by?: string | null } = { at: "2026-10-29T10:00:00Z", by: "Ada Lovelace" }, extra: Partial<FigmaScreenshot> = {}): FigmaScreenshot {
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
    outdated_box_count: 1,
    refresh_requested_at: request.at,
    refresh_requested_by: request.at === null || request.by === null ? null : { id: "kc-" + (request.by ?? "ada"), name: request.by ?? "Ada Lovelace" },
    ...extra,
  }
}

function request(n: number, frameId: string, overrides: Partial<RefreshRequest> = {}): RefreshRequest {
  return { screenshotId: "s" + n, frameId, frameName: "Frame " + frameId, pageName: "Mobile", requestedAt: "2026-10-29T10:00:00Z", requestedBy: "Ada Lovelace", ...overrides }
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

// E20 as the requests change over time: each read (one page) gets the next snapshot, the last one again once they
// are used up.
function snapshots(...lists: FigmaScreenshot[][]) {
  const calls: FigmaScreenshotsQuery[] = []
  const screenshots = vi.fn(async (_projectId: string, query: FigmaScreenshotsQuery): Promise<FigmaScreenshotsResponse> => {
    calls.push(query)
    return { screenshots: lists[Math.min(calls.length - 1, lists.length - 1)] ?? [], next_cursor: null, has_more: false }
  })
  return { screenshots, calls }
}

describe("refreshGate (SF5b, SF6)", () => {
  const input = (overrides: Partial<Parameters<typeof refreshGate>[0]> = {}): Parameters<typeof refreshGate>[0] => ({
    availability: READY,
    settings: linkedFile(),
    rootName: "Chapter",
    permissions: ["edit_keys"],
    ...overrides,
  })

  it("is the screenshot gate without the setting, on a server with screenshot freshness", () => {
    expect(refreshGate(input())).toEqual({ enabled: true, fileKey: FILE_KEY })
  })

  it("is closed without the E1 flag, for sandbox users and viewers, and on files that don't sync", () => {
    const closed = { enabled: false, fileKey: null }
    expect(refreshGate(input({ availability: { ...READY, meta: { ...META, screenshot_freshness: false } } }))).toEqual(closed)
    expect(refreshGate(input({ availability: { ...READY, meta: { ...META, screenshot_freshness: undefined as unknown as boolean } } }))).toEqual(closed)
    expect(refreshGate(input({ availability: { ...READY, user: { ...USER, sandbox_expires_at: "2026-10-29T15:00:00Z" } } }))).toEqual(closed)
    expect(refreshGate(input({ permissions: ["view_keys"] }))).toEqual(closed)
    expect(refreshGate(input({ availability: { ...READY, meta: { ...META, screenshots_enabled: false } } }))).toEqual(closed)
    expect(refreshGate(input({ settings: null }))).toEqual(closed)
    expect(refreshGate(input({ settings: linkedFile({ branchKey: "BrAnCh1234567890" }) }))).toEqual(closed)
    expect(refreshGate(input({ rootName: "Chapter (Copy)" }))).toEqual(closed)
    expect(refreshGate(input({ availability: { meta: null, user: null, error: null } }))).toEqual(closed)
  })
})

describe("loadRefreshRequests (E20 refresh_requested=true)", () => {
  it("follows the cursor and keeps only screenshots of this file with a request", async () => {
    const api = listing(
      [screenshot(1, "10:1"), screenshot(2, "11:1", { at: null })],
      [screenshot(3, "12:1", { at: "2026-10-29T11:00:00Z", by: null }), screenshot(4, "13:1", undefined, { file_key: "OtHeRfIlE1234567890" })],
    )
    const requests = await loadRefreshRequests(api, PROJECT_ID, FILE_KEY)
    expect(api.calls).toEqual([
      { file_key: FILE_KEY, refresh_requested: true, cursor: null, limit: 100 },
      { file_key: FILE_KEY, refresh_requested: true, cursor: "c1", limit: 100 },
    ])
    expect(requests).toEqual([
      { screenshotId: screenshot(1, "").id, frameId: "10:1", frameName: "Frame 10:1", pageName: "Mobile", requestedAt: "2026-10-29T10:00:00Z", requestedBy: "Ada Lovelace" },
      { screenshotId: screenshot(3, "").id, frameId: "12:1", frameName: "Frame 12:1", pageName: "Mobile", requestedAt: "2026-10-29T11:00:00Z", requestedBy: null },
    ])
  })

  it("reads at most 1,000 frames", async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, i) => screenshot(start + i, "10:" + (start + i)))
    const pages = Array.from({ length: 12 }, (_, i) => page(i * 100))
    const api = listing(...pages)
    const requests = await loadRefreshRequests(api, PROJECT_ID, FILE_KEY)
    expect(api.calls).toHaveLength(10)
    expect(requests).toHaveLength(1000)
  })

  it("maps a screenshot to its request", () => {
    expect(refreshRequestOf(screenshot(1, "10:1", { at: null }))).toBeNull()
    expect(refreshRequestOf(screenshot(1, "10:1", { at: "2026-10-29T10:00:00Z", by: "  " }))?.requestedBy).toBeNull()
  })
})

describe("the notice (§6.4)", () => {
  it("counts every current request, names up to two requesters and five frames", () => {
    const requests = [
      request(1, "10:1"),
      request(2, "11:1", { requestedBy: "Grace Hopper" }),
      request(3, "12:1", { requestedBy: null, pageName: "" }),
      request(4, "13:1", { requestedBy: "Ada Lovelace", frameName: "" }),
      request(5, "14:1", { requestedBy: "Edsger Dijkstra" }),
      request(6, "15:1", { requestedBy: "Barbara Liskov" }),
      request(7, "16:1"),
    ]
    expect(refreshNotice(requests, new Set())).toEqual({
      message: "ReRune asks for new screenshots of 7 frames in this file.",
      requestedBy: "Requested by Ada Lovelace, Grace Hopper and 2 others.",
      frames: "Frame 10:1 (Mobile), Frame 11:1 (Mobile), Frame 12:1, 13:1 (Mobile), Frame 14:1 (Mobile) and 2 more",
    })
    expect(requestersLine([request(1, "10:1"), request(2, "11:1", { requestedBy: "Grace Hopper" })])).toBe("Requested by Ada Lovelace and Grace Hopper.")
    expect(requestersLine([request(1, "10:1"), request(2, "11:1")])).toBe("Requested by Ada Lovelace.")
    expect(requestersLine([request(1, "10:1", { requestedBy: null }), request(2, "11:1", { requestedBy: "Grace Hopper" }), request(3, "12:1", { requestedBy: "Ada" }), request(4, "13:1", { requestedBy: "Linus" })])).toBe(
      "Requested by Grace Hopper, Ada and 1 other.",
    )
    expect(requestersLine([request(1, "10:1", { requestedBy: null })])).toBeNull()
    expect(framesLine([request(1, "10:1")])).toBe("Frame 10:1 (Mobile)")
    expect(refreshNotice([request(1, "10:1")], new Set())?.message).toBe("ReRune asks for new screenshots of 1 frame in this file.")
  })

  it("hides while every request is dismissed and shows all of them again for a new one", () => {
    const first = [request(1, "10:1"), request(2, "11:1")]
    const dismissed = new Set(first.map(requestKey))
    expect(refreshNotice(first, dismissed)).toBeNull()
    expect(refreshNotice([], new Set())).toBeNull()
    // A new request of the same frame has a new time.
    const again = [first[0], { ...first[1], requestedAt: "2026-10-29T12:00:00Z" }]
    expect(refreshNotice(again, dismissed)?.message).toBe("ReRune asks for new screenshots of 2 frames in this file.")
  })
})

describe("result lines (§6.4 step 7)", () => {
  const done = (overrides: Partial<Extract<RefreshOutcome, { kind: "done" }>> = {}): Extract<RefreshOutcome, { kind: "done" }> => ({
    kind: "done",
    pulled: 0,
    errors: [],
    figmaSide: 0,
    readonly: 0,
    shots: null,
    missing: [],
    ...overrides,
  })
  const missing = (frameId: string, frameName: string) => ({ screenshotId: "s" + frameId, frameId, frameName, pageName: "Mobile", hidden: false, removal: null, error: null })

  it("says nothing for zero counts", () => {
    expect(refreshLines(done())).toEqual({ pulled: null, figmaSide: null, readonly: null, outdated: null, missing: null, hidden: null })
  })

  it("uses one and many forms", () => {
    const run = (outdated: number): ScreenshotRun => ({ ...emptyScreenshotRun(3), uploaded: 3, done: 3, outdated })
    expect(refreshLines(done({ pulled: 1, figmaSide: 1, readonly: 1, shots: { kind: "done", run: run(1) }, missing: [missing("10:1", "Checkout")] }))).toEqual({
      pulled: "Updated 1 layer from ReRune.",
      figmaSide: "1 layer changed in Figma or in both wasn't changed. Review it on Push.",
      readonly: "1 layer is read-only in ReRune (disabled keys, or plural and ICU texts) and wasn't changed.",
      outdated: "1 uploaded screenshot still shows text that differs from ReRune.",
      missing: "1 requested frame isn't in this file anymore: Checkout (Mobile).",
      hidden: null,
    })
    expect(refreshLines(done({ pulled: 3, figmaSide: 2, readonly: 4, shots: { kind: "done", run: run(2) }, missing: [missing("10:1", "Checkout"), missing("11:1", "")] }))).toEqual({
      pulled: "Updated 3 layers from ReRune.",
      figmaSide: "2 layers changed in Figma or in both weren't changed. Review them on Push.",
      readonly: "4 layers are read-only in ReRune (disabled keys, or plural and ICU texts) and weren't changed.",
      outdated: "2 uploaded screenshots still show text that differs from ReRune.",
      missing: "2 requested frames aren't in this file anymore: Checkout (Mobile), 11:1 (Mobile).",
      hidden: null,
    })
    expect(previewsLine(1)).toBe("Reset previews in these frames first. 1 layer shows a preview.")
    expect(previewsLine(3)).toBe("Reset previews in these frames first. 3 layers show a preview.")
  })
})

// The frames of the run below: 10:1 has a layer Changed in ReRune, Changed in Figma, a conflict, a disabled key and a
// synced layer; 11:1 is gone from the file; 12:1 has nothing to pull.
const K1 = keyId(1)
const K2 = keyId(2)
const K3 = keyId(3)
const K4 = keyId(4)
const K5 = keyId(5)

function frameNodes(): ScannedNode[] {
  return [
    linkedNode("10:2", "Pay", { keyId: K1, keyName: "pay", syncedText: "Pay" }),
    linkedNode("10:3", "Total!", { keyId: K2, keyName: "total", syncedText: "Total" }),
    linkedNode("10:4", "Cart!", { keyId: K3, keyName: "cart", syncedText: "Cart" }),
    linkedNode("10:5", "Off", { keyId: K4, keyName: "off", syncedText: "Off" }),
    linkedNode("10:6", "Done", { keyId: K5, keyName: "done", syncedText: "Done" }),
    scannedNode("12:2", "Unlinked", { frameId: "12:1", frameName: "Frame 12:1" }),
  ]
}

function resolver(fail = false) {
  const texts: Record<string, string> = { [K1]: "Pay now", [K2]: "Total", [K3]: "Basket", [K4]: "Off now", [K5]: "Done" }
  return vi.fn(async (_projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> => {
    if (fail) {
      throw new ApiError(0, "network", "Can't reach ReRune. Check your connection.")
    }
    return {
      source: "draft",
      variation_option: null,
      keys: request.key_ids.map((id) => resolvedKey(id, "key_" + id.slice(-1), texts[id] ?? "", id === K4 ? { enabled: false } : {})),
      missing_key_ids: [],
    }
  })
}

interface Harness {
  refresh: ReturnType<typeof createRefreshRequests>
  api: { screenshots: ReturnType<typeof snapshots>["screenshots"]; cancelRefreshRequest: ReturnType<typeof vi.fn>; resolveKeys: ReturnType<typeof resolver> }
  listed: FigmaScreenshotsQuery[]
  main: ReturnType<typeof fakeMain>
  scanFrames: ReturnType<typeof vi.fn>
  uploads: { frames: ScreenshotFrame[]; options: ScreenshotRunOptions }[]
  prepare: ReturnType<typeof vi.fn>
  lock: ReturnType<typeof createWorkLock>
  context: { value: RefreshContext | null }
}

function harness(options: {
  reads?: FigmaScreenshot[][]
  nodes?: ScannedNode[] | null
  missing?: string[]
  hidden?: string[]
  resolveFails?: boolean
  gate?: ScreenshotGate
  uploadRun?: (frames: readonly ScreenshotFrame[]) => ScreenshotRun
  context?: Partial<RefreshContext>
} = {}): Harness {
  const list = snapshots(...(options.reads ?? [[screenshot(1, "10:1"), screenshot(2, "11:1"), screenshot(3, "12:1")]]))
  const main = fakeMain()
  const uploads: Harness["uploads"] = []
  const nodes = options.nodes === undefined ? frameNodes() : options.nodes
  const scanFrames = vi.fn(async (frameIds: readonly string[]): Promise<ScanResult | null> =>
    nodes === null
      ? null
      : {
          scope: "page",
          nodes,
          total: nodes.length,
          truncated: false,
          skipped: SKIPPED,
          missingFrameIds: options.missing ?? frameIds.filter((id) => id === "11:1"),
          hiddenFrameIds: options.hidden ?? [],
        },
  )
  const prepare = vi.fn(async () => ({ gate: options.gate ?? OPEN_GATE, availability: READY }))
  const uploader: ScreenshotUploader = {
    prepare,
    async upload(frames, runOptions) {
      uploads.push({ frames: frames.slice(), options: runOptions })
      return options.uploadRun?.(frames) ?? { ...emptyScreenshotRun(frames.length), done: frames.length, uploaded: frames.length, outdated: 1 }
    },
  }
  const api = { screenshots: list.screenshots, cancelRefreshRequest: vi.fn(async () => {}), resolveKeys: resolver(options.resolveFails) }
  const lock = createWorkLock()
  const context: Harness["context"] = {
    value: { projectId: PROJECT_ID, mainLanguage: "en", gate: { enabled: true, fileKey: FILE_KEY }, groupIdenticalTexts: true, ...options.context },
  }
  const refresh = createRefreshRequests({ api, bus: main.bus, context: () => context.value, scanFrames, uploader, lock })
  return { refresh, api, listed: list.calls, main, scanFrames, uploads, prepare, lock, context }
}

function outcomeOf(h: Harness): RefreshOutcome | null {
  return h.refresh.store.get().outcome
}

describe("createRefreshRequests: fetch", () => {
  it("reads the requests of the gate's file", async () => {
    const h = harness()
    await h.refresh.fetch()
    expect(h.listed).toEqual([{ file_key: FILE_KEY, refresh_requested: true, cursor: null, limit: 100 }])
    expect(h.refresh.store.get().requests.map((entry) => entry.frameId)).toEqual(["10:1", "11:1", "12:1"])
  })

  it("never asks ReRune while the gate is closed (no flag, sandbox, viewer, no file) and drops what it had", async () => {
    const h = harness()
    await h.refresh.fetch()
    h.context.value = { ...(h.context.value as RefreshContext), gate: { enabled: false, fileKey: null } }
    await h.refresh.fetch()
    expect(h.listed).toHaveLength(1)
    expect(h.refresh.store.get().requests).toEqual([])
    h.context.value = null
    await h.refresh.fetch()
    expect(h.listed).toHaveLength(1)
  })

  it("keeps the last requests when a fetch fails, silently", async () => {
    const h = harness()
    await h.refresh.fetch()
    h.api.screenshots.mockRejectedValueOnce(new ApiError(503, null, "Service Unavailable"))
    await h.refresh.fetch()
    expect(h.refresh.store.get().requests).toHaveLength(3)
    expect(h.refresh.store.get().outcome).toBeNull()
  })

  it("Not now dismisses the current requests for the session", async () => {
    const h = harness()
    await h.refresh.fetch()
    h.refresh.notNow()
    const state = h.refresh.store.get()
    expect(refreshNotice(state.requests, state.dismissed)).toBeNull()
    await h.refresh.fetch()
    expect(refreshNotice(h.refresh.store.get().requests, h.refresh.store.get().dismissed)).toBeNull()
  })

  it("reads the requests again after every other upload run", async () => {
    const refetch = vi.fn(async () => {})
    const upload = vi.fn(async (frames: readonly ScreenshotFrame[]) => emptyScreenshotRun(frames.length))
    const uploader = refetchAfterUpload({ prepare: vi.fn(async () => ({ gate: OPEN_GATE, availability: READY })), upload }, refetch)
    await uploader.prepare({ ignorePref: true })
    expect(refetch).not.toHaveBeenCalled()
    await uploader.upload([{ frameId: "10:1", frameName: "Checkout" }], { fileKey: FILE_KEY, freshness: true })
    expect(refetch).toHaveBeenCalledTimes(1)
    upload.mockRejectedValueOnce(new Error("boom"))
    await expect(uploader.upload([], { fileKey: FILE_KEY, freshness: true })).rejects.toThrow("boom")
    expect(refetch).toHaveBeenCalledTimes(2)
  })
})

describe("createRefreshRequests: Update screenshots (§6.4)", () => {
  it("pulls only layers Changed in ReRune, uploads exactly the requested frames that exist in request order and lists the missing ones", async () => {
    const all = [screenshot(1, "10:1"), screenshot(2, "11:1"), screenshot(3, "12:1")]
    const h = harness({
      reads: [
        all,
        all,
        // Step 6: a request made during the run (12:1 again, after its upload) and the missing frame's.
        [screenshot(2, "11:1"), screenshot(3, "12:1", { at: "2026-10-29T10:05:00Z", by: "Grace Hopper" })],
      ],
    })
    await h.refresh.fetch()
    h.api.screenshots.mockClear()
    const holders: (string | null)[] = []
    h.prepare.mockImplementationOnce(async () => {
      holders.push(h.lock.holder())
      return { gate: OPEN_GATE, availability: READY }
    })

    await h.refresh.run()

    // Step 1 and step 6 each read the requests once.
    expect(h.api.screenshots).toHaveBeenCalledTimes(2)
    expect(h.scanFrames).toHaveBeenCalledWith(["10:1", "11:1", "12:1"])
    expect(h.api.resolveKeys).toHaveBeenCalledWith(PROJECT_ID, { key_ids: [K1, K2, K3, K4, K5], languages: ["en"], source: "draft", variation_option_id: null })
    // Only the layer Changed in ReRune is written (with its renamed key name refreshed).
    expect(h.main.writes).toEqual([
      { type: "text-apply", requestId: expect.any(String), items: [{ nodeId: "10:2", text: "Pay now", src: src("Pay now") }] },
      { type: "link-apply", requestId: expect.any(String), items: [{ nodeId: "10:2", keyId: K1, keyName: "key_1", projectId: PROJECT_ID, src: src("Pay now") }] },
    ])
    expect(h.prepare).toHaveBeenCalledWith({ ignorePref: true })
    expect(holders).toEqual(["refresh"])
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0].frames).toEqual([
      { frameId: "10:1", frameName: "Frame 10:1" },
      { frameId: "12:1", frameName: "Frame 12:1" },
    ])
    expect(h.uploads[0].options).toMatchObject({ fileKey: FILE_KEY, freshness: true })

    const state = h.refresh.store.get()
    expect(state.running).toBeNull()
    expect(h.lock.holder()).toBeNull()
    expect(state.outcome).toEqual({
      kind: "done",
      pulled: 1,
      errors: [],
      figmaSide: 2,
      readonly: 1,
      shots: { kind: "done", run: { ...emptyScreenshotRun(2), done: 2, uploaded: 2, outdated: 1 } },
      missing: [{ screenshotId: screenshot(2, "").id, frameId: "11:1", frameName: "Frame 11:1", pageName: "Mobile", hidden: false, removal: null, error: null }],
    })
    // Every request of the run is put aside (the missing frame too); the one made during the run still shows.
    expect(refreshNotice(state.requests, state.dismissed)).toEqual({
      message: "ReRune asks for new screenshots of 2 frames in this file.",
      requestedBy: "Requested by Ada Lovelace and Grace Hopper.",
      frames: "Frame 11:1 (Mobile), Frame 12:1 (Mobile)",
    })
    expect(refreshLines(state.outcome as Extract<RefreshOutcome, { kind: "done" }>)).toMatchObject({
      pulled: "Updated 1 layer from ReRune.",
      figmaSide: "2 layers changed in Figma or in both weren't changed. Review them on Push.",
      readonly: "1 layer is read-only in ReRune (disabled keys, or plural and ICU texts) and wasn't changed.",
      outdated: "1 uploaded screenshot still shows text that differs from ReRune.",
      missing: "1 requested frame isn't in this file anymore: Frame 11:1 (Mobile).",
    })
  })

  it("never uploads a hidden requested frame (its screenshot would show no keys) and lists it with Remove request", async () => {
    const h = harness({ hidden: ["12:1"] })
    await h.refresh.run()
    expect(h.uploads.map((entry) => entry.frames.map((frame) => frame.frameId))).toEqual([["10:1"]])
    const outcome = outcomeOf(h) as Extract<RefreshOutcome, { kind: "done" }>
    expect(outcome.missing.map((frame) => [frame.frameId, frame.hidden])).toEqual([
      ["11:1", false],
      ["12:1", true],
    ])
    expect(refreshLines(outcome)).toMatchObject({
      missing: "1 requested frame isn't in this file anymore: Frame 11:1 (Mobile).",
      hidden: "1 requested frame is hidden in Figma, so its screenshot wasn't uploaded: Frame 12:1 (Mobile).",
    })
    expect(refreshLines({ ...outcome, missing: outcome.missing.map((frame) => ({ ...frame, hidden: true })) })).toMatchObject({
      missing: null,
      hidden: "2 requested frames are hidden in Figma, so their screenshots weren't uploaded: Frame 11:1 (Mobile), Frame 12:1 (Mobile).",
    })
    await h.refresh.removeAll()
    expect(h.api.cancelRefreshRequest.mock.calls).toEqual([
      [PROJECT_ID, screenshot(2, "").id],
      [PROJECT_ID, screenshot(3, "").id],
    ])
  })

  it("keeps the requests of step 6 when a read that started before the run answers after it", async () => {
    const before = [screenshot(1, "10:1"), screenshot(3, "12:1")]
    const during = screenshot(3, "12:1", { at: "2026-10-29T10:05:00Z", by: "Grace Hopper" })
    // Step 1 and step 6 (the late read below answers on its own).
    const h = harness({ reads: [before, [during]] })
    let answer: () => void = () => {}
    h.api.screenshots.mockImplementationOnce(
      () => new Promise<FigmaScreenshotsResponse>((resolve) => (answer = () => resolve({ screenshots: before, next_cursor: null, has_more: false }))),
    )
    // A push's upload ended: its refetch is still waiting for E20 when Update screenshots starts.
    const late = h.refresh.fetch()
    await h.refresh.run()
    answer()
    await late
    const state = h.refresh.store.get()
    expect(state.requests.map(requestKey)).toEqual([requestKey(refreshRequestOf(during) as RefreshRequest)])
    expect(refreshNotice(state.requests, state.dismissed)?.message).toBe("ReRune asks for new screenshots of 1 frame in this file.")
  })

  it("puts every request of a stopped run aside, also the frames it did not reach", async () => {
    const h = harness({
      reads: [[screenshot(1, "10:1"), screenshot(3, "12:1")]],
      uploadRun: (frames) => ({ ...emptyScreenshotRun(frames.length), done: 1, uploaded: 1, stopped: "cancelled", notUploaded: 1 }),
    })
    await h.refresh.run()
    const state = h.refresh.store.get()
    expect(state.requests).toHaveLength(2)
    expect(refreshNotice(state.requests, state.dismissed)).toBeNull()
  })

  it("stops before writing when a layer in the frames shows a preview, and keeps the notice", async () => {
    const preview = { lang: "de", source: "draft" as const, variationOptionId: null, appliedAt: 1 }
    const nodes = [...frameNodes(), linkedNode("12:3", "Zahlen", { keyId: K1, keyName: "pay", syncedText: "Pay" }, { frameId: "12:1", originalCharacters: "Pay", preview })]
    const h = harness({ nodes })
    await h.refresh.run()
    expect(outcomeOf(h)).toEqual({ kind: "previews", nodeIds: ["12:3"] })
    expect(h.api.resolveKeys).not.toHaveBeenCalled()
    expect(h.main.writes).toEqual([])
    expect(h.uploads).toEqual([])
    const state = h.refresh.store.get()
    expect(refreshNotice(state.requests, state.dismissed)?.message).toBe("ReRune asks for new screenshots of 3 frames in this file.")
    expect(h.lock.holder()).toBeNull()
  })

  it("reports a scan that didn't finish, a project without one main language and a failed E12 load without writing", async () => {
    const cancelled = harness({ nodes: null })
    await cancelled.refresh.run()
    expect(outcomeOf(cancelled)).toEqual({ kind: "error", message: SCAN_UNFINISHED })

    const noMain = harness({ context: { mainLanguage: "" } })
    await noMain.refresh.run()
    expect(outcomeOf(noMain)).toEqual({ kind: "error", message: NO_MAIN_LANGUAGE })

    const offline = harness({ resolveFails: true })
    await offline.refresh.run()
    expect(outcomeOf(offline)).toEqual({ kind: "error", message: "Can't reach ReRune. Check your connection." })
    for (const h of [cancelled, noMain, offline]) {
      expect(h.main.writes).toEqual([])
      expect(h.uploads).toEqual([])
      expect(h.refresh.store.get().dismissed.size).toBe(0)
      expect(h.lock.holder()).toBeNull()
    }
  })

  it("says so when ReRune no longer asks for any frame", async () => {
    const h = harness({ reads: [[]] })
    await h.refresh.run()
    expect(outcomeOf(h)).toEqual({ kind: "none" })
    expect(h.scanFrames).not.toHaveBeenCalled()
  })

  it("uploads with the setting off, since only the screenshot gate counts (prepare ignores the pref)", async () => {
    const h = harness({ reads: [[screenshot(3, "12:1")]] })
    await h.refresh.run()
    expect(h.prepare).toHaveBeenCalledWith({ ignorePref: true })
    expect(h.uploads.map((entry) => entry.frames.map((frame) => frame.frameId))).toEqual([["12:1"]])
  })

  it("reports a gate that closed before the upload like a push does", async () => {
    const h = harness({ gate: { enabled: false, reason: "unavailable", fileKey: null } })
    h.prepare.mockResolvedValueOnce({ gate: { enabled: false, reason: "unavailable", fileKey: null }, availability: { ...READY, meta: null, error: "Can't reach ReRune. Check your connection." } })
    await h.refresh.run()
    expect(outcomeOf(h)).toMatchObject({ kind: "done", shots: { kind: "unavailable", message: "Can't reach ReRune. Check your connection." } })
    expect(h.uploads).toEqual([])
  })

  it("does not start while another task holds the work lock, or without a gate", async () => {
    const h = harness()
    h.lock.acquire("push")
    await h.refresh.run()
    expect(h.api.screenshots).not.toHaveBeenCalled()
    expect(h.lock.holder()).toBe("push")
    h.lock.release("push")
    h.context.value = { ...(h.context.value as RefreshContext), gate: { enabled: false, fileKey: null } }
    await h.refresh.run()
    expect(h.api.screenshots).not.toHaveBeenCalled()
  })

  it("Stop ends the upload queue, and fetches wait for the run", async () => {
    let release: () => void = () => {}
    const h = harness({ reads: [[screenshot(1, "10:1")]] })
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ gate: OPEN_GATE, availability: READY })
        }),
    )
    const uploads = h.uploads
    const running = h.refresh.run()
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalled())
    await h.refresh.fetch()
    expect(h.api.screenshots).toHaveBeenCalledTimes(1)
    h.refresh.stop()
    expect(h.refresh.store.get().stopping).toBe(true)
    release()
    await running
    expect(uploads[0].options.stopped?.()).toBe(true)
    expect(h.refresh.store.get()).toMatchObject({ running: null, stopping: false })
  })
})

describe("createRefreshRequests: Remove request (E25)", () => {
  async function withMissing(frames: string[]): Promise<Harness> {
    const h = harness({ reads: [frames.map((frameId, index) => screenshot(index + 1, frameId))], missing: frames })
    await h.refresh.run()
    return h
  }

  const missingOf = (h: Harness) => {
    const outcome = h.refresh.store.get().outcome
    return outcome !== null && outcome.kind === "done" ? outcome.missing.map((frame) => [frame.frameId, frame.removal, frame.error]) : []
  }

  it("removes one request; a 404 screenshot_not_found counts as removed, other failures show the API message", async () => {
    const h = await withMissing(["20:1", "21:1", "22:1"])
    expect(h.uploads).toEqual([])
    h.api.cancelRefreshRequest.mockRejectedValueOnce(new ApiError(404, "screenshot_not_found", "screenshot not found"))
    await h.refresh.removeRequest(screenshot(2, "").id)
    h.api.cancelRefreshRequest.mockRejectedValueOnce(new ApiError(403, null, "only the requester or a member with edit_keys can cancel"))
    await h.refresh.removeRequest(screenshot(3, "").id)
    await h.refresh.removeRequest(screenshot(1, "").id)
    expect(h.api.cancelRefreshRequest.mock.calls).toEqual([
      [PROJECT_ID, screenshot(2, "").id],
      [PROJECT_ID, screenshot(3, "").id],
      [PROJECT_ID, screenshot(1, "").id],
    ])
    expect(missingOf(h)).toEqual([
      ["20:1", "removed", null],
      ["21:1", "removed", null],
      ["22:1", null, "only the requester or a member with edit_keys can cancel"],
    ])
    expect(h.refresh.store.get().requests.map((entry) => entry.frameId)).toEqual(["22:1"])
    // A removed request is not sent again.
    await h.refresh.removeRequest(screenshot(1, "").id)
    expect(h.api.cancelRefreshRequest).toHaveBeenCalledTimes(3)
  })

  it("Remove all goes one at a time and stops at a 429 with the rate-limit message, leaving the rest listed", async () => {
    const h = await withMissing(["20:1", "21:1", "22:1"])
    h.api.cancelRefreshRequest.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(429, null, "Too Many Requests", 30))
    await h.refresh.removeAll()
    expect(h.api.cancelRefreshRequest).toHaveBeenCalledTimes(2)
    expect(missingOf(h)).toEqual([
      ["20:1", "removed", null],
      ["21:1", null, RATE_LIMIT_MESSAGE],
      ["22:1", null, null],
    ])
    expect(h.refresh.store.get().removing).toBe(false)
    await h.refresh.removeAll()
    expect(missingOf(h)).toEqual([
      ["20:1", "removed", null],
      ["21:1", "removed", null],
      ["22:1", "removed", null],
    ])
    expect(h.api.cancelRefreshRequest).toHaveBeenCalledTimes(4)
  })

  it("forgets the result and the requests on reset (sign-out, another project)", async () => {
    const h = await withMissing(["20:1"])
    h.refresh.reset()
    expect(h.refresh.store.get()).toMatchObject({ requests: [], outcome: null, running: null })
    expect(h.refresh.store.get().dismissed.size).toBe(0)
  })
})
