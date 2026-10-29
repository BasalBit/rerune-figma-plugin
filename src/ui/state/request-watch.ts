import { ApiError } from "../api/client"
import type { Availability } from "./screenshots"

// Background reads while the plugin is open: the screenshot requests (SF6), the project's details (E9: languages,
// variations, permissions), the ReRune values of the keys in view (E12, the last scan's links) and, while it failed at
// opening, the availability check (E1, E8). The workspace reads each of them when it opens (and after its own tasks);
// this schedule reads them again while the plugin stays open, so a change made in the dashboard shows without
// reopening the plugin. One schedule for all of them: a round reads them one after the other when the plugin's window
// is shown again or gets the user's attention (focus, or the pointer moving onto it), at most every 15 s, and every
// minute while the window is visible and someone uses the plugin or Figma: after 15 minutes without a click, key or
// scroll in the plugin, attention or a selection change in Figma it stops until the next one. Never while the window
// is hidden, while a task holds the work lock or a round is going on; a read whose own work is going on (another read
// of the same data) sits the round out. A failed read changes nothing on screen and ends the round (the rest waits for
// the next one, so a server that is down gets one failing read per round). A 429 makes every read wait its Retry-After
// (2 minutes without one); another failure makes only that read wait, twice as long each time, at most 10 minutes,
// while the others keep the minute, and a read of it that works brings back the minute. After a failure other than a
// 429, attention reads it again once its last read is a minute old, and the browser coming back online reads it 15 s
// after it at the latest. A 401 ends the schedule (the client signs out). Pure, with an injectable clock and window so
// tests drive it with fake timers.

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
  addEventListener(type: T, listener: () => void, options?: { capture: boolean }): void
  removeEventListener(type: T, listener: () => void, options?: { capture: boolean }): void
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
// Capture is passed as an options object: Node 24's EventTarget (the test runner's) does not match a boolean `true` on
// removal, so the listeners would stay. Browsers accept both forms.
const CAPTURE = { capture: true } as const

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
        doc.addEventListener(type, onActivity, CAPTURE)
      }
      return () => {
        doc.removeEventListener("visibilitychange", onVisibility)
        win.removeEventListener("focus", onAttention)
        win.removeEventListener("online", onOnline)
        doc.documentElement.removeEventListener("pointerenter", onAttention)
        for (const type of ACTIVITY_EVENTS) {
          doc.removeEventListener(type, onActivity, CAPTURE)
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
export function availabilityRead(load: () => Promise<Availability>, loaded: (availability: Availability) => void): () => Promise<WatchFetch> {
  return async () => {
    const availability = await load()
    loaded(availability)
    return availability.error === null ? { kind: "read" } : { kind: "failed", error: new Error(availability.error) }
  }
}

// What one background read did: read (or found nothing to read), skipped because its own work is going on (a run that
// reads the same data itself), or failed (nothing changed on screen).
export type WatchFetch = { kind: "read" } | { kind: "skipped" } | { kind: "failed"; error: unknown }

// One read on a schedule: the screenshot requests, the project's details, the values of the keys in view, the
// availability check. `busy`: its own work is going on (another read of the same data, a run that brings it), so it is
// left out of this round.
export interface WatchRead {
  fetch(): Promise<WatchFetch>
  busy?(): boolean
}

export interface WatchScheduleDeps {
  // A task (a push or pull, a preview, Update screenshots, …) holds the work lock: no read at all.
  busy(): boolean
  window: WatchWindow
  clock?: WatchClock
}

export interface RequestWatch {
  // The read is on (for the requests: signed in, refresh gate open). The first read turned on starts the schedule, and
  // the read its owner makes at that moment counts as the first round; a read turned on later joins the next round.
  start(): void
  // Off (sign-out, another project or file, a closed gate, the app unmounted); a read of it still going on no longer
  // counts. The schedule stops when no read is on.
  stop(): void
  // Someone uses Figma (the selection or the page changed): the minute goes on as while they use the plugin.
  activity(): void
}

// One timer for every background read of the app, so they share the triggers, the idle pause, the locks and a 429's
// wait and never come at once: each round reads them one after the other, in the order they were added.
export interface WatchSchedule {
  add(read: WatchRead): RequestWatch
  activity(): void
}

export interface RequestWatchDeps {
  // refreshRequests.fetch: reads the requests, silent on errors.
  fetch(): Promise<WatchFetch>
  // A task (Update screenshots, a push and its uploads, …) or another read is going on.
  busy(): boolean
  window: WatchWindow
  clock?: WatchClock
}

interface Entry {
  read: WatchRead
  on: boolean
  generation: number
  failures: number          // its failed reads since the last one that worked, 429s left out
  until: number             // after its failure: not read before then (0: no wait of its own)
  tried: number             // when the round of its last read started
}

// Which reads a round reads, at `now`.
type Pick = (entry: Entry, now: number) => boolean

export function createWatchSchedule(deps: WatchScheduleDeps): WatchSchedule {
  const clock = deps.clock ?? systemClock
  const entries: Entry[] = []
  let generation = 0
  let active = false
  let unlisten: (() => void) | null = null
  let timer: unknown = null
  let reading = false
  let lastRead = 0          // when the last round started
  let lastSeen = 0          // when someone last showed, pointed at or used the plugin, or used Figma
  let dueAt = 0             // when the next round is due
  let limitedUntil = 0      // a 429's Retry-After: no read before then

  const waiting = (entry: Entry, now: number) => entry.until > now
  // At the minute, or when a failure's wait is over: every read that is not in its own failure's wait.
  const onTime: Pick = (entry, now) => !waiting(entry, now)
  // Shown or attention: the reads once the last round is 15 s old, and a read in its failure's wait once its own
  // last read is a minute old (its wait can be longer).
  const onAttention: Pick = (entry, now) => (waiting(entry, now) ? now - entry.tried >= REQUEST_POLL_MS : now >= dueAt || now - lastRead >= REQUEST_ATTENTION_MIN_MS)

  function clear(): void {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  // The timer for the next round, only while the window is visible and no round is going on.
  function arm(): void {
    clear()
    if (!active || reading || !deps.window.visible()) {
      return
    }
    const mine = generation
    timer = clock.setTimeout(() => {
      timer = null
      if (mine === generation) {
        void round(onTime)
      }
    }, Math.max(0, dueAt - clock.now()))
  }

  // A task or every read's own work is going on: it brings the data, so the next round is a minute later.
  function later(now: number): void {
    dueAt = Math.max(dueAt, now + REQUEST_POLL_MS)
    arm()
  }

  async function round(pick: Pick): Promise<void> {
    if (!active || reading || !deps.window.visible()) {
      return
    }
    const now = clock.now()
    if (now - lastSeen >= REQUEST_IDLE_MS) {
      // Nobody has used the plugin or Figma for 15 minutes: no timer until someone does.
      clear()
      return
    }
    if (now < limitedUntil) {
      dueAt = Math.max(dueAt, limitedUntil)
      arm()
      return
    }
    const due = entries.filter((entry) => entry.on && entry.read.busy?.() !== true && pick(entry, now))
    if (deps.busy() || due.length === 0) {
      later(now)
      return
    }
    const mine = generation
    reading = true
    lastRead = now
    clear()
    for (const entry of due) {
      // A task, or the read's own work, that started during the round brings what it would read.
      if (!entry.on || deps.busy() || entry.read.busy?.() === true) {
        continue
      }
      const own = entry.generation
      let result: WatchFetch
      try {
        result = await entry.read.fetch()
      } catch (error) {
        result = { kind: "failed", error }
      }
      if (mine !== generation) {
        return
      }
      if (own !== entry.generation) {
        // Stopped or started again meanwhile: its answer does not count.
        continue
      }
      entry.tried = now
      const after = clock.now()
      if (result.kind === "read") {
        entry.failures = 0
        entry.until = 0
      } else if (result.kind === "skipped") {
        // A run of its own reads the data: the minute, also after a failure.
        entry.until = Math.min(entry.until, after + REQUEST_POLL_MS)
      } else {
        const limited = result.error instanceof ApiError && result.error.status === 429
        const pause = waitAfterFailure(result.error, limited ? entry.failures : entry.failures + 1)
        if (pause === null) {
          halt()
          return
        }
        if (limited) {
          // ReRune asks for fewer requests: every read waits.
          limitedUntil = after + pause
        } else {
          // This read waits longer; the others keep the minute.
          entry.failures++
          entry.until = after + pause
        }
        // The rest of the round waits for the next one, so a server that is down gets one failing read per round.
        break
      }
    }
    reading = false
    const after = clock.now()
    // The minute, or later when every read waits after its failure or a 429.
    const soonest = Math.min(...entries.filter((entry) => entry.on).map((entry) => entry.until))
    dueAt = Math.max(after + REQUEST_POLL_MS, limitedUntil, soonest)
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
      case "online": {
        // Offline, every read fails at once: back online, a read that failed comes 15 s after its last read at the
        // latest. A 429's wait is kept.
        if (now < limitedUntil) {
          return
        }
        let soonest = Infinity
        for (const entry of entries) {
          if (entry.on && entry.failures > 0) {
            entry.until = Math.min(entry.until, entry.tried + REQUEST_ATTENTION_MIN_MS)
            soonest = Math.min(soonest, entry.until)
          }
        }
        if (soonest !== Infinity) {
          dueAt = Math.min(dueAt, soonest)
          arm()
        }
        return
      }
      case "activity":
        lastSeen = now
        // After 15 idle minutes the timer stopped: it reads now when the round is due.
        if (timer === null && !reading) {
          arm()
        }
        return
      case "shown":
      case "attention":
        lastSeen = now
        if (now >= limitedUntil && entries.some((entry) => entry.on && onAttention(entry, now))) {
          void round(onAttention)
        } else {
          arm()
        }
    }
  }

  // Every read off (a 401: the session ended), or the last one turned off.
  function halt(): void {
    generation++
    active = false
    reading = false
    clear()
    unlisten?.()
    unlisten = null
    for (const entry of entries) {
      if (entry.on) {
        entry.on = false
        entry.generation++
      }
    }
  }

  function begin(): void {
    active = true
    const now = clock.now()
    lastRead = now
    lastSeen = now
    dueAt = now + REQUEST_POLL_MS
    limitedUntil = 0
    unlisten = deps.window.listen(onWindow)
    arm()
  }

  function off(entry: Entry): void {
    if (!entry.on) {
      return
    }
    entry.on = false
    entry.generation++
    if (!entries.some((other) => other.on)) {
      halt()
    }
  }

  return {
    add(read) {
      const entry: Entry = { read, on: false, generation: 0, failures: 0, until: 0, tried: 0 }
      entries.push(entry)
      return {
        start() {
          // Started again, the read starts afresh, without the wait of a failure before (alone: the schedule too).
          off(entry)
          entry.on = true
          entry.generation++
          entry.failures = 0
          entry.until = 0
          if (!active) {
            begin()
          }
        },
        stop: () => off(entry),
        activity: () => onWindow("activity"),
      }
    },
    activity: () => onWindow("activity"),
  }
}

// A schedule with one read (tests, and a watch of its own).
export function createRequestWatch(deps: RequestWatchDeps): RequestWatch {
  return createWatchSchedule({ busy: deps.busy, window: deps.window, clock: deps.clock }).add({ fetch: deps.fetch })
}
