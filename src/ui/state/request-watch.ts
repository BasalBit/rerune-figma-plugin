import { ApiError } from "../api/client"
import type { RefreshFetch } from "./refresh-requests"
import type { Availability } from "./screenshots"

// Screenshot requests while the plugin is open (SF6): the workspace reads them when it opens, after the file link is
// saved and after every upload run; this watch also reads them while the plugin stays open, so a request made in the
// dashboard shows without reopening the plugin. It reads when the plugin's window is shown again or gets the user's
// attention (focus, or the pointer moving onto it), at most every 15 s, and every minute while the window is visible
// and someone uses the plugin or Figma: after 15 minutes without a click, key or scroll in the plugin, attention or a
// selection change in Figma it stops until the next one. Never while the window is hidden, while a task or another
// read is going on. A failed read changes nothing on screen and the next one waits longer: a 429 its Retry-After
// (2 minutes without one), other failures twice as long each time; at most 10 minutes, and a read that works brings
// back the minute. After a failure other than a 429, attention reads again once the last read is a minute old, and
// the browser coming back online reads at once. A 401 ends the watch (the client signs out). app.tsx also retries the
// availability check (E1, E8) on this schedule when it failed at opening. Pure, with an injectable clock and window
// so tests drive it with fake timers.

export const REQUEST_POLL_MS = 60 * 1000
export const REQUEST_ATTENTION_MIN_MS = 15 * 1000
export const REQUEST_RATE_LIMIT_WAIT_MS = 2 * 60 * 1000
export const REQUEST_WAIT_MAX_MS = 10 * 60 * 1000
export const REQUEST_IDLE_MS = 15 * 60 * 1000

export interface WatchClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// performance.now never goes back when the system clock is set back.
const systemClock: WatchClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// "shown" and "hidden": the window's visibility changed; "attention": it got focus or the pointer moved onto it;
// "activity": a click, key or scroll in the plugin; "online": the browser is back online.
export type WatchEvent = "shown" | "hidden" | "attention" | "activity" | "online"

// The plugin window as the watch sees it.
export interface WatchWindow {
  visible(): boolean
  listen(listener: (event: WatchEvent) => void): () => void
}

interface Listenable<T extends string> {
  addEventListener(type: T, listener: () => void, capture?: boolean): void
  removeEventListener(type: T, listener: () => void, capture?: boolean): void
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const

export interface WatchDocument extends Listenable<"visibilitychange" | (typeof ACTIVITY_EVENTS)[number]> {
  readonly visibilityState: string
  readonly documentElement: Listenable<"pointerenter">
}

// The plugin iframe: the document's visibility (hidden while Figma is minimised or covered, or the plugin is closed),
// the window's focus (a click in the plugin, or Figma brought back while the plugin had focus), the pointer entering
// the plugin, clicks, keys and scrolling in it (capture phase, so no component can hide them) and the browser coming
// back online.
export function browserWindow(doc: WatchDocument, win: Listenable<"focus" | "online">): WatchWindow {
  const visible = () => doc.visibilityState !== "hidden"
  return {
    visible,
    listen(listener) {
      const onVisibility = () => listener(visible() ? "shown" : "hidden")
      const onAttention = () => listener("attention")
      const onActivity = () => listener("activity")
      const onOnline = () => listener("online")
      doc.addEventListener("visibilitychange", onVisibility)
      win.addEventListener("focus", onAttention)
      win.addEventListener("online", onOnline)
      doc.documentElement.addEventListener("pointerenter", onAttention)
      for (const type of ACTIVITY_EVENTS) {
        doc.addEventListener(type, onActivity, true)
      }
      return () => {
        doc.removeEventListener("visibilitychange", onVisibility)
        win.removeEventListener("focus", onAttention)
        win.removeEventListener("online", onOnline)
        doc.documentElement.removeEventListener("pointerenter", onAttention)
        for (const type of ACTIVITY_EVENTS) {
          doc.removeEventListener(type, onActivity, true)
        }
      }
    },
  }
}

// The wait after a failed read; `failures` counts the failed reads since the last one that worked, this one included
// and 429s left out. null: stop (401: the session ended).
export function waitAfterFailure(error: unknown, failures: number): number | null {
  if (error instanceof ApiError && error.status === 401) {
    return null
  }
  if (error instanceof ApiError && error.status === 429) {
    const wait = error.retryAfterSeconds === null ? REQUEST_RATE_LIMIT_WAIT_MS : error.retryAfterSeconds * 1000
    return Math.min(Math.max(wait, REQUEST_POLL_MS), REQUEST_WAIT_MAX_MS)
  }
  return Math.min(REQUEST_POLL_MS * 2 ** Math.max(1, failures), REQUEST_WAIT_MAX_MS)
}

// The availability check (E1, E8) as a read of the watch: when it failed as the workspace opened, app.tsx reads it
// again on this schedule until it works, so the refresh gate can open without reopening the plugin.
export function availabilityRead(load: () => Promise<Availability>, loaded: (availability: Availability) => void): () => Promise<RefreshFetch> {
  return async () => {
    const availability = await load()
    loaded(availability)
    return availability.error === null ? { kind: "read" } : { kind: "failed", error: new Error(availability.error) }
  }
}

export interface RequestWatchDeps {
  // refreshRequests.fetch: reads the requests, silent on errors.
  fetch(): Promise<RefreshFetch>
  // A task (Update screenshots, a push and its uploads, …) or another read is going on.
  busy(): boolean
  window: WatchWindow
  clock?: WatchClock
}

export interface RequestWatch {
  // The workspace is open on a file whose requests are read (signed in, refresh gate open). The read the workspace
  // makes when it opens counts as the first one.
  start(): void
  // Sign-out, another project or file, a closed gate, the app unmounted. Also ends a read's wait for its answer.
  stop(): void
  // Someone uses Figma (the selection or the page changed): the minute goes on as while they use the plugin.
  activity(): void
}

// The wait after the last read: none, a failure's or a 429's.
type Wait = "none" | "failure" | "rate_limit"

// How old the last read must be before shown or attention read again: 15 s, a minute after a failure (its wait can be
// longer), and never before a 429's Retry-After is over.
const ATTENTION_GAP: Readonly<Record<Wait, number>> = { none: REQUEST_ATTENTION_MIN_MS, failure: REQUEST_POLL_MS, rate_limit: Infinity }

export function createRequestWatch(deps: RequestWatchDeps): RequestWatch {
  const clock = deps.clock ?? systemClock
  let generation = 0
  let active = false
  let unlisten: (() => void) | null = null
  let timer: unknown = null
  let reading = false
  let lastRead = 0          // when the last read started
  let lastSeen = 0          // when someone last showed, pointed at or used the plugin, or used Figma
  let dueAt = 0             // when the next read is due
  let wait: Wait = "none"
  let failures = 0

  function clear(): void {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  // The timer for the next read, only while the window is visible and no read of the watch is going on.
  function arm(): void {
    clear()
    if (!active || reading || !deps.window.visible()) {
      return
    }
    const mine = generation
    timer = clock.setTimeout(() => {
      timer = null
      if (mine === generation) {
        void read()
      }
    }, Math.max(0, dueAt - clock.now()))
  }

  async function read(): Promise<void> {
    if (!active || reading || !deps.window.visible()) {
      return
    }
    const now = clock.now()
    if (now - lastSeen >= REQUEST_IDLE_MS) {
      // Nobody has used the plugin or Figma for 15 minutes: no timer until someone does.
      clear()
      return
    }
    if (deps.busy()) {
      // The task or the other read brings the requests: the next read is a minute later.
      dueAt = Math.max(dueAt, now + REQUEST_POLL_MS)
      arm()
      return
    }
    const mine = generation
    reading = true
    lastRead = now
    clear()
    let result: RefreshFetch
    try {
      result = await deps.fetch()
    } catch (error) {
      result = { kind: "failed", error }
    }
    if (mine !== generation) {
      return
    }
    reading = false
    const after = clock.now()
    if (result.kind === "failed") {
      const rateLimited = result.error instanceof ApiError && result.error.status === 429
      if (!rateLimited) {
        failures++
      }
      const next = waitAfterFailure(result.error, failures)
      if (next === null) {
        stop()
        return
      }
      dueAt = after + next
      wait = rateLimited ? "rate_limit" : "failure"
    } else {
      // "skipped": a run started meanwhile and reads the requests itself.
      if (result.kind === "read") {
        failures = 0
        wait = "none"
      }
      dueAt = after + REQUEST_POLL_MS
    }
    arm()
  }

  function onWindow(event: WatchEvent): void {
    if (!active) {
      return
    }
    const now = clock.now()
    switch (event) {
      case "hidden":
        clear()
        return
      case "online":
        // Offline, every read fails at once: back online, the next read comes 15 s after the last one at the latest.
        if (wait === "failure") {
          dueAt = Math.min(dueAt, lastRead + REQUEST_ATTENTION_MIN_MS)
          arm()
        }
        return
      case "activity":
        lastSeen = now
        // After 15 idle minutes the timer stopped: it reads now when the read is due.
        if (timer === null && !reading) {
          arm()
        }
        return
      case "shown":
      case "attention":
        lastSeen = now
        if (now >= dueAt || now - lastRead >= ATTENTION_GAP[wait]) {
          void read()
        } else {
          arm()
        }
    }
  }

  function stop(): void {
    generation++
    active = false
    reading = false
    clear()
    unlisten?.()
    unlisten = null
  }

  return {
    start() {
      stop()
      active = true
      const now = clock.now()
      lastRead = now
      lastSeen = now
      dueAt = now + REQUEST_POLL_MS
      wait = "none"
      failures = 0
      unlisten = deps.window.listen(onWindow)
      arm()
    },
    stop,
    activity: () => onWindow("activity"),
  }
}
