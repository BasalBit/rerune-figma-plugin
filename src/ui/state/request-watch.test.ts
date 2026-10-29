/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROJECT_ID } from "../../../test/fixtures"
import type { FigmaMetaResponse, FigmaProjectsResponse, FigmaScreenshot, FigmaScreenshotsResponse, FigmaUser } from "../../shared/api-types"
import { ApiError } from "../api/client"
import appSource from "../app.tsx?raw"
import type { ScanResult } from "./ops"
import { createRefreshRequests, refreshNotice, type RefreshFetch } from "./refresh-requests"
import {
  availabilityRead,
  browserWindow,
  createRequestWatch,
  createWatchSchedule,
  REQUEST_ATTENTION_MIN_MS,
  REQUEST_IDLE_MS,
  REQUEST_POLL_MS,
  REQUEST_RATE_LIMIT_WAIT_MS,
  REQUEST_WAIT_MAX_MS,
  waitAfterFailure,
  type RequestWatch,
  type WatchEvent,
  type WatchWindow,
} from "./request-watch"
import { createAvailability, emptyScreenshotRun, screenshotFreshness, type Availability, type ScreenshotFrame } from "./screenshots"
import { fakeMain } from "./test-fakes"
import { createWorkLock } from "./work-lock"

const T0 = Date.parse("2026-10-29T10:00:00Z")
const SECOND = 1000
const MINUTE = 60 * SECOND

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

function fakeWindow(visible = true) {
  const listeners = new Set<(event: WatchEvent) => void>()
  let shown = visible
  const emit = (event: WatchEvent) => {
    for (const listener of [...listeners]) {
      listener(event)
    }
  }
  const window: WatchWindow = {
    visible: () => shown,
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    window,
    listeners,
    show() {
      shown = true
      emit("shown")
    },
    hide() {
      shown = false
      emit("hidden")
    },
    attention: () => emit("attention"),
    activity: () => emit("activity"),
    online: () => emit("online"),
  }
}

// Time passes while someone uses Figma (a selection change every 5 minutes), so the watch never goes idle.
async function inUse(watch: RequestWatch, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5 * MINUTE) {
    await vi.advanceTimersByTimeAsync(Math.min(left, 5 * MINUTE))
    watch.activity()
  }
}

// A watch whose reads answer from `results` (one each, the last one again once they are used up); `times` are the
// reads' start times in ms after T0.
function harness(options: { results?: RefreshFetch[]; visible?: boolean } = {}) {
  const results = options.results ?? [{ kind: "read" }]
  const times: number[] = []
  const state = { busy: false }
  const fetch = vi.fn(async (): Promise<RefreshFetch> => {
    times.push(Date.now() - T0)
    return results[Math.min(times.length - 1, results.length - 1)]
  })
  const page = fakeWindow(options.visible ?? true)
  const watch = createRequestWatch({ fetch, busy: () => state.busy, window: page.window })
  return { watch, fetch, times, page, state }
}

const failed = (error: unknown): RefreshFetch => ({ kind: "failed", error })

describe("request watch: cadence", () => {
  it("reads every minute while the window is visible, the first time a minute after the workspace's own read", async () => {
    const h = harness()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(h.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE])
  })

  it("pauses while hidden and reads at once when shown after the minute is over, then every minute again", async () => {
    const h = harness()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    h.page.hide()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(h.fetch).not.toHaveBeenCalled()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([10 * MINUTE + 30 * SECOND])
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([10 * MINUTE + 30 * SECOND, 11 * MINUTE + 30 * SECOND])
  })

  it("reads when the window is shown or gets attention, at most every 15 s", async () => {
    const h = harness()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(10 * SECOND)
    h.page.attention()
    h.page.hide()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    h.page.attention()
    h.page.attention()
    await vi.advanceTimersByTimeAsync(REQUEST_ATTENTION_MIN_MS - 1)
    h.page.attention()
    h.page.hide()
    h.page.show()
    await vi.advanceTimersByTimeAsync(1)
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([15 * SECOND, 30 * SECOND])
    // The minute starts again with every read.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([15 * SECOND, 30 * SECOND, 90 * SECOND])
  })

  it("keeps the minute when the window is shown again within 15 s", async () => {
    const h = harness()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(50 * SECOND)
    h.page.hide()
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([55 * SECOND])
    h.page.hide()
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([55 * SECOND])
    await vi.advanceTimersByTimeAsync(MINUTE - 5 * SECOND - 1)
    expect(h.times).toEqual([55 * SECOND])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.times).toEqual([55 * SECOND, 115 * SECOND])
  })

  it("starts paused in a hidden window", async () => {
    const h = harness({ visible: false })
    h.watch.start()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(h.fetch).not.toHaveBeenCalled()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([5 * MINUTE])
  })
})

describe("request watch: nobody there", () => {
  const minutes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => (from + index) * MINUTE)

  it("stops after 15 minutes without anyone using the plugin or Figma, and reads at once when someone comes back", async () => {
    const h = harness()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(REQUEST_IDLE_MS + 10 * MINUTE)
    expect(h.times).toEqual(minutes(1, 14))
    expect(vi.getTimerCount()).toBe(0)
    h.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([...minutes(1, 14), 25 * MINUTE])
    // Then every minute again, until 15 more idle minutes have passed.
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(h.times).toEqual([...minutes(1, 14), 25 * MINUTE, ...minutes(26, 39)])
  })

  it("a click, key or scroll in the plugin or a selection change in Figma keeps the minute and ends the pause", async () => {
    const h = harness()
    h.watch.start()
    for (let minute = 0; minute < 30; minute += 5) {
      await vi.advanceTimersByTimeAsync(5 * MINUTE)
      h.page.activity()
    }
    expect(h.times).toEqual(minutes(1, 30))
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(h.times).toEqual(minutes(1, 44))
    // Activity reads the read that is due at once, but never before it is due.
    h.watch.activity()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([...minutes(1, 44), 50 * MINUTE])
    h.watch.activity()
    h.page.activity()
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(h.times).toEqual([...minutes(1, 44), 50 * MINUTE])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.times).toEqual([...minutes(1, 44), 50 * MINUTE, 51 * MINUTE])
  })
})

describe("request watch: failures", () => {
  it("waits twice as long after each failure, at most 10 minutes, and a read that works brings back the minute", async () => {
    const error = failed(new ApiError(503, null, "Service Unavailable"))
    const h = harness({ results: [error, error, error, error, error, { kind: "read" }] })
    h.watch.start()
    await inUse(h.watch, MINUTE + 2 * MINUTE + 4 * MINUTE + 8 * MINUTE + 10 * MINUTE + 10 * MINUTE + MINUTE)
    const gaps = h.times.map((time, index) => time - (index === 0 ? 0 : h.times[index - 1]))
    expect(gaps).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 10 * MINUTE, 10 * MINUTE, MINUTE])
  })

  it("after a failure, reads on shown or attention once the last read is a minute old, never before a 429's wait is over", async () => {
    const h = harness({
      results: [failed(new ApiError(0, "network", "Can't reach ReRune.")), { kind: "read" }, failed(new ApiError(429, null, "Too Many Requests", 300)), { kind: "read" }],
    })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE + 30 * SECOND)
    h.page.attention()
    h.page.hide()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE])
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    h.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE])
    // The minute after the read that worked, a 429 asks for 5 minutes: shown and attention wait for them.
    await vi.advanceTimersByTimeAsync(MINUTE)
    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    h.page.attention()
    h.page.hide()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE])
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE, 8 * MINUTE])
    // Back to normal: attention reads again after 15 s.
    await vi.advanceTimersByTimeAsync(REQUEST_ATTENTION_MIN_MS)
    h.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE, 8 * MINUTE, 8 * MINUTE + REQUEST_ATTENTION_MIN_MS])
  })

  it("starts the doubling again after a read that works", async () => {
    const unavailable = failed(new ApiError(503, null, "Service Unavailable"))
    const h = harness({ results: [unavailable, { kind: "read" }, unavailable, { kind: "read" }] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(6 * MINUTE)
    expect(h.times).toEqual([MINUTE, 3 * MINUTE, 4 * MINUTE, 6 * MINUTE])
  })

  it("leaves 429s out of the doubling", async () => {
    const unavailable = failed(new ApiError(503, null, "Service Unavailable"))
    const h = harness({ results: [unavailable, failed(new ApiError(429, null, "Too Many Requests", 90)), unavailable, { kind: "read" }] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    // 2 minutes, the Retry-After, then 4 minutes for the second failure (8 if the 429 counted).
    expect(h.times).toEqual([MINUTE, 3 * MINUTE, 4 * MINUTE + 30 * SECOND, 8 * MINUTE + 30 * SECOND])
  })

  it("reads 15 s after the failed read at the latest when the browser is back online", async () => {
    const offline = failed(new ApiError(0, "network", "Can't reach ReRune. Check your connection."))
    const h = harness({ results: [offline, offline, { kind: "read" }] })
    h.watch.start()
    // Online without a failed read changes nothing.
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    h.page.online()
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    expect(h.times).toEqual([MINUTE])
    // 5 s after the failed read: the read comes 15 s after it.
    await vi.advanceTimersByTimeAsync(5 * SECOND)
    h.page.online()
    await vi.advanceTimersByTimeAsync(9 * SECOND)
    expect(h.times).toEqual([MINUTE])
    await vi.advanceTimersByTimeAsync(SECOND)
    expect(h.times).toEqual([MINUTE, MINUTE + 15 * SECOND])
    // Later than that: at once.
    await vi.advanceTimersByTimeAsync(45 * SECOND)
    h.page.online()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE, MINUTE + 15 * SECOND, 2 * MINUTE])
  })

  it("keeps a 429's wait when the browser is back online", async () => {
    const h = harness({ results: [failed(new ApiError(429, null, "Too Many Requests", 300)), { kind: "read" }] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    h.page.online()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(h.times).toEqual([MINUTE])
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([MINUTE, 6 * MINUTE])
  })

  it("waits a 429's Retry-After, 2 minutes without one", async () => {
    const h = harness({ results: [failed(new ApiError(429, null, "Too Many Requests", 300)), failed(new ApiError(429, null, "Too Many Requests")), { kind: "read" }] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE + 5 * MINUTE + 2 * MINUTE + MINUTE)
    expect(h.times).toEqual([MINUTE, 6 * MINUTE, 8 * MINUTE, 9 * MINUTE])
  })

  it("never waits less than a minute or more than 10 minutes", () => {
    const rateLimited = (seconds: number | null) => new ApiError(429, null, "Too Many Requests", seconds)
    expect(waitAfterFailure(rateLimited(null), 0)).toBe(REQUEST_RATE_LIMIT_WAIT_MS)
    expect(waitAfterFailure(rateLimited(90), 0)).toBe(90 * SECOND)
    expect(waitAfterFailure(rateLimited(0), 0)).toBe(REQUEST_POLL_MS)
    expect(waitAfterFailure(rateLimited(5), 3)).toBe(REQUEST_POLL_MS)
    expect(waitAfterFailure(rateLimited(86400), 0)).toBe(REQUEST_WAIT_MAX_MS)
    expect([1, 2, 3, 4, 5].map((failures) => waitAfterFailure(new ApiError(500, null, "boom"), failures))).toEqual([
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      REQUEST_WAIT_MAX_MS,
      REQUEST_WAIT_MAX_MS,
    ])
    expect(waitAfterFailure(new Error("boom"), 1)).toBe(2 * MINUTE)
    expect(waitAfterFailure(new ApiError(401, "plugin_token_invalid", "Your session ended."), 1)).toBeNull()
  })

  it("stops after a 401 (the client signs out)", async () => {
    const h = harness({ results: [failed(new ApiError(401, "plugin_token_invalid", "Your session ended."))] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.page.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
})

describe("request watch: no overlap", () => {
  it("never reads while a run or another read is going on, and tries again a minute later", async () => {
    const h = harness()
    h.watch.start()
    h.state.busy = true
    await vi.advanceTimersByTimeAsync(MINUTE)
    h.page.attention()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetch).not.toHaveBeenCalled()
    h.state.busy = false
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(h.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.times).toEqual([2 * MINUTE])
  })

  it("starts no second read while its own read waits for the answer", async () => {
    const h = harness()
    let answer: () => void = () => {}
    h.fetch.mockImplementationOnce(() => new Promise<RefreshFetch>((resolve) => (answer = () => resolve({ kind: "read" }))))
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    h.page.attention()
    h.page.hide()
    h.page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })
})

describe("request watch: cleanup", () => {
  it("stop removes the timer and the listeners and ignores the answer of a read still going on", async () => {
    const h = harness()
    let answer: () => void = () => {}
    h.fetch.mockImplementationOnce(() => {
      h.times.push(Date.now() - T0)
      return new Promise<RefreshFetch>((resolve) => (answer = () => resolve(failed(new ApiError(503, null, "Service Unavailable")))))
    })
    h.watch.start()
    expect(h.page.listeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(MINUTE)
    h.watch.stop()
    expect(h.page.listeners.size).toBe(0)
    answer()
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(vi.getTimerCount()).toBe(0)
    h.page.show()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    // Started again (another project or file): one listener, a fresh minute and no wait left from the failure.
    h.watch.start()
    h.watch.start()
    expect(h.page.listeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([MINUTE, 32 * MINUTE])
  })

  it("starts again without the wait of a failure before", async () => {
    const h = harness({ results: [failed(new ApiError(503, null, "Service Unavailable")), { kind: "read" }] })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    h.watch.stop()
    h.watch.start()
    await vi.advanceTimersByTimeAsync(REQUEST_ATTENTION_MIN_MS)
    h.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.times).toEqual([MINUTE, MINUTE + REQUEST_ATTENTION_MIN_MS])
  })

  it("ignores the failure of a read that started before it was started again", async () => {
    const h = harness()
    let answer: () => void = () => {}
    h.fetch.mockImplementationOnce(() => {
      h.times.push(Date.now() - T0)
      return new Promise<RefreshFetch>((resolve) => (answer = () => resolve(failed(new ApiError(503, null, "Service Unavailable")))))
    })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    h.watch.stop()
    h.watch.start()
    answer()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(h.times).toEqual([MINUTE, 2 * MINUTE])
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe("browserWindow", () => {
  it("reports visibility, focus, the pointer entering the plugin, clicks, keys, scrolling and going online, and stops listening", () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", documentElement: new EventTarget() })
    const win = new EventTarget()
    const page = browserWindow(doc, win)
    const events: WatchEvent[] = []
    const unlisten = page.listen((event) => events.push(event))
    const dispatchAll = () => {
      doc.dispatchEvent(new Event("visibilitychange"))
      win.dispatchEvent(new Event("focus"))
      doc.documentElement.dispatchEvent(new Event("pointerenter"))
      for (const type of ["pointerdown", "keydown", "wheel"]) {
        doc.dispatchEvent(new Event(type))
      }
      win.dispatchEvent(new Event("online"))
    }
    expect(page.visible()).toBe(true)
    doc.visibilityState = "hidden"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(page.visible()).toBe(false)
    doc.visibilityState = "visible"
    dispatchAll()
    expect(events).toEqual(["hidden", "shown", "attention", "attention", "activity", "activity", "activity", "online"])
    unlisten()
    dispatchAll()
    expect(events).toHaveLength(8)
  })
})

// The watch with the real requests controller: what the designer sees.
describe("request watch with the requests", () => {
  const FILE_KEY = "AbCdEf1234567890XyZ"

  function screenshot(n: number, frameId: string, at = "2026-10-29T10:00:00Z"): FigmaScreenshot {
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
      refresh_requested_at: at,
      refresh_requested_by: { id: "kc-ada", name: "Ada Lovelace" },
    }
  }

  function setup(lists: (FigmaScreenshot[] | ApiError)[]) {
    let calls = 0
    const screenshots = vi.fn(async (): Promise<FigmaScreenshotsResponse> => {
      const next = lists[Math.min(calls++, lists.length - 1)]
      if (next instanceof ApiError) {
        throw next
      }
      return { screenshots: next, next_cursor: null, has_more: false }
    })
    let scanned: (result: ScanResult | null) => void = () => {}
    const lock = createWorkLock()
    const refresh = createRefreshRequests({
      api: { screenshots, cancelRefreshRequest: vi.fn(async () => {}), resolveKeys: vi.fn() },
      bus: fakeMain().bus,
      context: () => ({ projectId: PROJECT_ID, mainLanguage: "en", gate: { enabled: true, fileKey: FILE_KEY }, groupIdenticalTexts: true }),
      scanFrames: () => new Promise<ScanResult | null>((resolve) => (scanned = resolve)),
      uploader: {
        prepare: vi.fn(async () => ({ gate: { enabled: true, reason: null, fileKey: FILE_KEY }, availability: { meta: null, user: null, error: null } })),
        upload: vi.fn(async (frames: readonly ScreenshotFrame[]) => emptyScreenshotRun(frames.length)),
      },
      lock,
    })
    const page = fakeWindow()
    // As app.tsx wires it.
    const watch = createRequestWatch({ fetch: () => refresh.fetch(), busy: () => refresh.busy() || lock.holder() !== null, window: page.window })
    const notice = () => refreshNotice(refresh.store.get().requests, refresh.store.get().dismissed)
    return { refresh, watch, screenshots, page, notice, lock, finishScan: () => scanned(null) }
  }

  it("shows a request made while the plugin is open within a minute", async () => {
    const s = setup([[], [screenshot(1, "10:1")]])
    await s.refresh.fetch()
    s.watch.start()
    expect(s.notice()).toBeNull()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.notice()?.message).toBe("ReRune asks for new screenshots of 1 frame in this file.")
  })

  it("leaves the notice as it was and shows no error when a background read fails", async () => {
    const s = setup([[screenshot(1, "10:1")], new ApiError(503, null, "Service Unavailable"), new ApiError(0, "network", "Can't reach ReRune.")])
    await s.refresh.fetch()
    s.watch.start()
    const before = s.notice()
    await vi.advanceTimersByTimeAsync(MINUTE + 2 * MINUTE)
    expect(s.screenshots).toHaveBeenCalledTimes(3)
    expect(s.notice()).toEqual(before)
    expect(s.refresh.store.get()).toMatchObject({ outcome: null, running: null })
  })

  it("keeps the requests put aside with Not now hidden, and shows the notice again for a new one", async () => {
    const first = screenshot(1, "10:1")
    const again = screenshot(1, "10:1", "2026-10-29T10:30:00Z")
    const s = setup([[first], [first], [first, screenshot(2, "11:1")], [again]])
    await s.refresh.fetch()
    s.watch.start()
    s.refresh.notNow()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.notice()).toBeNull()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.notice()?.message).toBe("ReRune asks for new screenshots of 2 frames in this file.")
    s.refresh.notNow()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.notice()?.message).toBe("ReRune asks for new screenshots of 1 frame in this file.")
  })

  it("never reads while Update screenshots runs or while the read after an upload waits for its answer", async () => {
    const s = setup([[screenshot(1, "10:1")]])
    await s.refresh.fetch()
    s.watch.start()
    const running = s.refresh.run()
    expect(s.refresh.store.get().running).toEqual({ step: "scanning" })
    const calls = s.screenshots.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    s.page.attention()
    expect(s.screenshots).toHaveBeenCalledTimes(calls)
    s.finishScan()
    await running
    // An upload ended: its read is still waiting for E20 when the minute is over.
    let answer: () => void = () => {}
    s.screenshots.mockImplementationOnce(
      () => new Promise<FigmaScreenshotsResponse>((resolve) => (answer = () => resolve({ screenshots: [], next_cursor: null, has_more: false }))),
    )
    const afterUpload = s.refresh.fetch()
    const reads = s.screenshots.mock.calls.length
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.screenshots).toHaveBeenCalledTimes(reads)
    answer()
    await afterUpload
    expect(s.notice()).toBeNull()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.screenshots).toHaveBeenCalledTimes(reads + 1)
  })

  it("never reads while a push or another task holds the work lock: its uploads read the requests when they end", async () => {
    const s = setup([[screenshot(1, "10:1")]])
    await s.refresh.fetch()
    s.watch.start()
    s.lock.acquire("push")
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.screenshots).toHaveBeenCalledTimes(1)
    s.lock.release("push")
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.screenshots).toHaveBeenCalledTimes(2)
  })
})

describe("availabilityRead (E1 or E8 failed as the workspace opened)", () => {
  const META: FigmaMetaResponse = { api_version: 1, screenshots_enabled: true, max_image_bytes: 2097152, max_image_side: 4096, max_batch_size: 100, server_time: "2026-10-29T10:00:00Z", screenshot_freshness: true }
  const USER: FigmaUser = { id: "kc-1", email: "dana@example.com", first_name: "Dana", last_name: "Designer", sandbox_expires_at: null }

  it("reads them again on the watch's schedule until they work, so the requests' gate can open without reopening the plugin", async () => {
    const meta = vi
      .fn<() => Promise<FigmaMetaResponse>>()
      .mockRejectedValueOnce(new ApiError(503, null, "Service Unavailable"))
      .mockRejectedValueOnce(new ApiError(0, "network", "Can't reach ReRune."))
      .mockResolvedValue(META)
    const projects = vi.fn(async (): Promise<FigmaProjectsResponse> => ({ user: USER, projects: [] }))
    const loader = createAvailability({ meta, projects })
    let availability: Availability = await loader.load()
    expect(availability.error).not.toBeNull()
    const page = fakeWindow()
    const watch = createRequestWatch({ fetch: availabilityRead(() => loader.load(), (next) => (availability = next)), busy: () => false, window: page.window })
    watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(meta).toHaveBeenCalledTimes(2)
    expect(screenshotFreshness(availability)).toBe(false)
    // After the failure, attention a minute later reads again.
    await vi.advanceTimersByTimeAsync(MINUTE)
    page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(meta).toHaveBeenCalledTimes(3)
    expect(availability).toEqual({ meta: META, user: USER, error: null })
    expect(screenshotFreshness(availability)).toBe(true)
    expect(projects).toHaveBeenCalledTimes(1)
  })
})

// One schedule for every background read: shared triggers, locks, idle pause and backoff, one read at a time.
describe("watch schedule: several reads", () => {
  interface Pending { name: string; finish(result?: RefreshFetch): void }

  // Reads that answer only when the test finishes them; `started` records their start order.
  function reads(names: string[]) {
    const started: string[] = []
    const pending: Pending[] = []
    const busy = new Set<string>()
    const make = (name: string) => ({
      busy: () => busy.has(name),
      fetch: vi.fn(
        () =>
          new Promise<RefreshFetch>((resolve) => {
            started.push(name)
            pending.push({ name, finish: (result = { kind: "read" }) => resolve(result) })
          }),
      ),
    })
    return { started, pending, busy, all: Object.fromEntries(names.map((name) => [name, make(name)])) }
  }

  async function finishAll(pending: Pending[], result?: (name: string) => RefreshFetch) {
    while (pending.length > 0) {
      const next = pending.shift() as Pending
      next.finish(result?.(next.name))
      await vi.advanceTimersByTimeAsync(0)
    }
  }

  function setup(names = ["project", "keys", "requests"]) {
    const r = reads(names)
    const lock = { held: false }
    const page = fakeWindow()
    const schedule = createWatchSchedule({ busy: () => lock.held, window: page.window })
    const watches = Object.fromEntries(names.map((name) => [name, schedule.add(r.all[name])]))
    return { ...r, lock, page, schedule, watches }
  }

  it("reads every read once a round, one after the other: never two at once, all on one timer", async () => {
    const s = setup()
    s.watches.project.start()
    s.watches.keys.start()
    s.watches.requests.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.started).toEqual(["project"])
    s.pending.shift()?.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started).toEqual(["project", "keys"])
    s.pending.shift()?.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started).toEqual(["project", "keys", "requests"])
    // Attention while the round goes on starts no second round.
    s.page.attention()
    await vi.advanceTimersByTimeAsync(20 * SECOND)
    expect(s.started).toHaveLength(3)
    s.pending.shift()?.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    // The next round a minute after this one ended.
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(s.started).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.started).toEqual(["project", "keys", "requests", "project"])
  })

  it("shares the 15 s attention throttle, the idle pause and the hidden window", async () => {
    const s = setup(["project", "keys"])
    s.watches.project.start()
    s.watches.keys.start()
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started).toEqual([])
    await vi.advanceTimersByTimeAsync(REQUEST_ATTENTION_MIN_MS)
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "keys"])
    s.page.hide()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(s.started).toHaveLength(2)
    s.page.show()
    await vi.advanceTimersByTimeAsync(0)
    await finishAll(s.pending)
    expect(s.started).toHaveLength(4)
    // Nobody there for 15 minutes: no round for any read.
    await vi.advanceTimersByTimeAsync(REQUEST_IDLE_MS + 5 * MINUTE)
    await finishAll(s.pending)
    const before = s.started.length
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(s.started).toHaveLength(before)
    s.schedule.activity()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started.length).toBeGreaterThan(before)
  })

  it("reads nothing while a task holds the work lock, and leaves out a read whose own work is going on", async () => {
    const s = setup()
    for (const watch of Object.values(s.watches)) watch.start()
    s.lock.held = true
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started).toEqual([])
    s.lock.held = false
    s.busy.add("keys")
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "requests"])
    // A task that starts during a round: the rest of the round waits for the next one.
    s.busy.clear()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.started).toEqual(["project", "requests", "project"])
    s.lock.held = true
    await finishAll(s.pending)
    expect(s.started).toHaveLength(3)
  })

  it("ends the round at a failed read: the rest waits for the next round, so a server that is down gets one failing read a round", async () => {
    const s = setup()
    for (const watch of Object.values(s.watches)) watch.start()
    const down = (): RefreshFetch => failed(new ApiError(0, "network", "Can't reach ReRune."))
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, down)
    expect(s.started).toEqual(["project"])
    // The project's details wait 2 minutes; the next round a minute later reads the keys, which fail too.
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, down)
    expect(s.started).toEqual(["project", "keys"])
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, down)
    expect(s.started).toEqual(["project", "keys", "project"])
    // ReRune answers again: each read comes back when its own wait is over (the project's details: 4 minutes after
    // their second failure), and keeps the minute once it works.
    for (let minute = 4; minute <= 6; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE)
      await finishAll(s.pending)
    }
    expect(s.started.slice(3)).toEqual(["keys", "requests", "keys", "requests", "keys", "requests"])
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending)
    expect(s.started.slice(-3)).toEqual(["project", "keys", "requests"])
  })

  it("keeps the minute for the other reads while one of them keeps failing (E1 down: the availability retry)", async () => {
    const s = setup(["keys", "availability"])
    s.watches.keys.start()
    s.watches.availability.start()
    const answer = (name: string): RefreshFetch => (name === "availability" ? failed(new ApiError(503, null, "Service Unavailable")) : { kind: "read" })
    const at: Record<string, number[]> = { keys: [], availability: [] }
    for (let minute = 1; minute <= 16; minute++) {
      const before = s.started.length
      await vi.advanceTimersByTimeAsync(MINUTE)
      await finishAll(s.pending, answer)
      for (const name of s.started.slice(before)) at[name].push(minute)
      s.schedule.activity()
    }
    expect(at.keys).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    // Its own wait doubles: 2, 4, 8, then 10 minutes.
    expect(at.availability).toEqual([1, 3, 7, 15])
  })

  it("makes every read wait a 429's Retry-After, and attention does not shorten it", async () => {
    const s = setup()
    for (const watch of Object.values(s.watches)) watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, (name) => (name === "keys" ? failed(new ApiError(429, null, "Too Many Requests", 300)) : { kind: "read" }))
    // Nothing after the 429 in this round.
    expect(s.started).toEqual(["project", "keys"])
    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    s.page.attention()
    s.page.online()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.started).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending)
    expect(s.started.slice(2)).toEqual(["project", "keys", "requests"])
    // A round that works brings back the minute.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.started).toHaveLength(6)
  })

  it("after a failed read, attention reads it again once its last read is a minute old; the others keep the 15 s", async () => {
    const s = setup(["project", "keys"])
    s.watches.project.start()
    s.watches.keys.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, (name) => (name === "keys" ? failed(new ApiError(503, null, "Service Unavailable")) : { kind: "read" }))
    expect(s.started).toEqual(["project", "keys"])
    await vi.advanceTimersByTimeAsync(REQUEST_ATTENTION_MIN_MS)
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "keys", "project"])
    await vi.advanceTimersByTimeAsync(MINUTE - REQUEST_ATTENTION_MIN_MS)
    await finishAll(s.pending)
    s.page.attention()
    await vi.advanceTimersByTimeAsync(0)
    await finishAll(s.pending)
    expect(s.started.slice(3)).toEqual(["project", "keys"])
  })

  it("leaves out a read whose own work started while the round read the one before it", async () => {
    const s = setup()
    for (const watch of Object.values(s.watches)) watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.started).toEqual(["project"])
    // A scan starts during the project's read: the keys sit this round out.
    s.busy.add("keys")
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "requests"])
    s.busy.clear()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending)
    expect(s.started.slice(2)).toEqual(["project", "keys", "requests"])
  })

  it("stops every read after a 401 in any of them", async () => {
    const s = setup()
    for (const watch of Object.values(s.watches)) watch.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending, (name) => (name === "keys" ? failed(new ApiError(401, null, "Unauthorized")) : { kind: "read" }))
    expect(s.started).toEqual(["project", "keys"])
    expect(vi.getTimerCount()).toBe(0)
    expect(s.page.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(s.started).toHaveLength(2)
  })

  it("adds a read turned on later to the next round, keeps the others when one is turned off, and stops with the last", async () => {
    const s = setup()
    s.watches.project.start()
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    s.watches.requests.start()
    await vi.advanceTimersByTimeAsync(30 * SECOND)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "requests"])
    s.watches.project.stop()
    await vi.advanceTimersByTimeAsync(MINUTE)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "requests", "requests"])
    s.watches.requests.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(s.page.listeners.size).toBe(0)
  })

  it("does not count the answer of a read turned off while it was pending", async () => {
    const s = setup(["project", "keys"])
    s.watches.project.start()
    s.watches.keys.start()
    await vi.advanceTimersByTimeAsync(MINUTE)
    s.watches.project.stop()
    s.pending.shift()?.finish(failed(new ApiError(503, null, "Service Unavailable")))
    await vi.advanceTimersByTimeAsync(0)
    await finishAll(s.pending)
    expect(s.started).toEqual(["project", "keys"])
    // No failure's wait: the next round comes a minute later.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(s.started).toEqual(["project", "keys", "keys"])
  })
})

// app.tsx is not rendered in tests: its wiring of the schedule is checked in its source.
describe("app.tsx wiring", () => {
  it("has one schedule for every background read, which waits while a task holds the work lock", () => {
    expect(appSource.match(/createWatchSchedule\(/g)).toHaveLength(1)
    expect(appSource).toContain("createWatchSchedule({ busy: () => workLock.holder() !== null, window: browserWindow(document, window) })")
    expect(appSource).not.toContain("createRequestWatch(")
    // In this order each round: the project's details first (a new main language changes the keys' read).
    const order = ["schedule.add(\n        projectRead(", "schedule.add({\n        busy: () => keysBusyRef.current", "schedule.add({ fetch: () => refreshRequests.fetch()", "schedule.add({ fetch: availabilityRead("]
    const positions = order.map((part) => appSource.indexOf(part))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("watches the requests while signed in on a file with the gate open, not during a run of their own, and starts again for another project or file", () => {
    expect(appSource).toContain("schedule.add({ fetch: () => refreshRequests.fetch(), busy: () => refreshRequests.busy() })")
    expect(appSource).toContain("const watching = auth !== null && project !== null && freshnessGate.enabled\n")
    expect(appSource).toContain("    requestWatch.start()\n    return () => requestWatch.stop()\n  }, [watching, project?.id, freshnessGate.fileKey])")
  })

  it("reads the project's details and the keys in view while the workspace is open, the keys not during a scan or a Layers action", () => {
    expect(appSource).toContain("const workspaceOpen = auth !== null && project !== null\n")
    expect(appSource).toContain("    projectWatch.start()\n    keysWatch.start()\n    return () => {\n      projectWatch.stop()\n      keysWatch.stop()\n    }\n  }, [workspaceOpen, project?.id])")
    expect(appSource).toContain("keysBusyRef.current = layersBusy || link !== null || resetting || pageSyncState.running !== null")
    expect(appSource).toContain('busy: () => keysBusyRef.current || workspace.store.get().status === "scanning",')
    expect(appSource).toContain("fetch: () => workspace.refreshKeys({ chunkSize: availabilityRef.current.meta?.max_batch_size }),")
  })

  it("reads the availability again while it failed, and counts selection changes in Figma as use", () => {
    expect(appSource).toContain("schedule.add({ fetch: availabilityRead(() => availabilityLoader.load(), setAvailability) })")
    expect(appSource).toContain("const availabilityFailed = auth !== null && project !== null && availability.error !== null\n")
    expect(appSource).toContain("    availabilityWatch.start()\n    return () => availabilityWatch.stop()\n  }, [availabilityFailed, project?.id])")
    expect(appSource).toContain('bus.on("selection-changed", () => schedule.activity())')
  })
})
