import { PAIRING_NETWORK_BACKOFF_MAX_MS, PAIRING_NETWORK_BACKOFF_MS, PAIRING_RETRY_AFTER_DEFAULT_SECONDS } from "../../shared/constants"
import type { BuildEnv } from "../../shared/message-policy"
import type { StoredAuth } from "../../shared/messages"
import { displayPairingCode } from "../../shared/pairing-code"
import { ApiError, userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { parsePollResponse, storedAuthFromApproved, UNEXPECTED_POLL_MESSAGE } from "./session"

// Pairing poller (§3.1, §7.19): E2 → show the code → open the dashboard once → poll E3 every interval until
// expires_at. Pure state machine with an injectable clock so tests drive it with fake timers.

export const PAIRING_MESSAGES = {
  denied: "Sign-in was blocked in the browser.",
  expired: "Code expired. Start sign-in again.",
  unavailable: "Sign-in with ReRune isn't available right now. Try again later.",
} as const

export const PAIRING_SESSION_MAX_MS = 10 * 60 * 1000
const DEFAULT_INTERVAL_SECONDS = 2
const MAX_INTERVAL_SECONDS = 30

export type PairingStatus = "polling" | "reconnecting" | "rate_limited"
export type PairingFailure = "denied" | "expired" | "unavailable" | "error"

export type PairingState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: string; connectUrl: string; deadline: number; status: PairingStatus; urlWarning: string | null }
  | { kind: "approved"; auth: StoredAuth }
  | { kind: "failed"; reason: PairingFailure; message: string }
  | { kind: "cancelled" }

export interface PairingClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface PairingDeps {
  api: Pick<FigmaApi, "createSession" | "pollSession">
  apiBase: string
  dashboardBase: string
  env: BuildEnv
  openExternal(url: string): void
  saveAuth(auth: StoredAuth): void
  clock?: PairingClock
}

export interface PairingFlow {
  getState(): PairingState
  subscribe(listener: (state: PairingState) => void): () => void
  start(): Promise<void>
  cancel(): void
  reopen(): void
  dispose(): void
}

export const systemClock: PairingClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// The plugin builds its own connect URL from the build's dashboard base, never the server's approve_url (D39).
export function connectUrlFor(dashboardBase: string, code: string): string {
  return dashboardBase.replace(/\/+$/, "") + "/figma/connect?code=" + encodeURIComponent(code)
}

// Development builds warn when the server's approve_url points elsewhere (E2): FIGMA_CONNECT_URL is misconfigured.
export function approveUrlWarning(env: BuildEnv, dashboardBase: string, approveUrl: string): string | null {
  const expected = dashboardBase.replace(/\/+$/, "") + "/figma/connect"
  if (env !== "development" || approveUrl.startsWith(expected)) {
    return null
  }
  return "The server's approve_url (" + approveUrl + ") does not start with " + expected + ". Check FIGMA_CONNECT_URL."
}

// Local deadline from the server's expires_at, bounded by the 10-minute session lifetime so clock skew cannot
// stretch the countdown; an expires_at that already looks past (local clock far ahead) falls back to 10 minutes.
export function pairingDeadline(expiresAt: string, now: number): number {
  const remaining = Date.parse(expiresAt) - now
  if (!isFinite(remaining) || remaining <= 0) {
    return now + PAIRING_SESSION_MAX_MS
  }
  return now + Math.min(remaining, PAIRING_SESSION_MAX_MS)
}

export function networkBackoffMs(attempt: number): number {
  return attempt < PAIRING_NETWORK_BACKOFF_MS.length ? PAIRING_NETWORK_BACKOFF_MS[attempt] : PAIRING_NETWORK_BACKOFF_MAX_MS
}

export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes + ":" + (rest < 10 ? "0" : "") + rest
}

function intervalMs(seconds: number | undefined): number {
  const value = typeof seconds === "number" && isFinite(seconds) && seconds >= 1 ? seconds : DEFAULT_INTERVAL_SECONDS
  return Math.min(value, MAX_INTERVAL_SECONDS) * 1000
}

export function createPairingFlow(deps: PairingDeps): PairingFlow {
  const clock = deps.clock ?? systemClock
  const listeners = new Set<(state: PairingState) => void>()
  let state: PairingState = { kind: "idle" }
  let generation = 0
  let timer: unknown = null
  let session: { id: string; secret: string; interval: number; deadline: number } | null = null
  let networkFailures = 0

  function setState(next: PairingState): void {
    state = next
    for (const listener of [...listeners]) {
      listener(state)
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  function stop(next: PairingState): void {
    generation++
    clearTimer()
    session = null
    setState(next)
  }

  function withStatus(status: PairingStatus): void {
    if (state.kind === "waiting" && state.status !== status) {
      setState({ ...state, status })
    }
  }

  // Waits `ms` (never past the deadline), then polls. Reaching the deadline ends the flow as expired.
  function schedule(mine: number, ms: number): void {
    if (session === null) {
      return
    }
    const remaining = session.deadline - clock.now()
    if (remaining <= 0) {
      stop({ kind: "failed", reason: "expired", message: PAIRING_MESSAGES.expired })
      return
    }
    clearTimer()
    timer = clock.setTimeout(() => {
      timer = null
      if (mine === generation) {
        void poll(mine)
      }
    }, Math.min(ms, remaining))
  }

  async function poll(mine: number): Promise<void> {
    if (session === null) {
      return
    }
    if (clock.now() >= session.deadline) {
      stop({ kind: "failed", reason: "expired", message: PAIRING_MESSAGES.expired })
      return
    }
    const current = session
    try {
      const response = parsePollResponse(await deps.api.pollSession(current.id, current.secret))
      if (mine !== generation) {
        return
      }
      networkFailures = 0
      if (response === null) {
        stop({ kind: "failed", reason: "error", message: UNEXPECTED_POLL_MESSAGE })
        return
      }
      if (response.status === "pending") {
        withStatus("polling")
        current.interval = intervalMs(response.interval_seconds)
        schedule(mine, current.interval)
        return
      }
      if (response.status === "denied") {
        stop({ kind: "failed", reason: "denied", message: PAIRING_MESSAGES.denied })
        return
      }
      const auth = storedAuthFromApproved(response, deps.apiBase, clock.now())
      deps.saveAuth(auth)
      stop({ kind: "approved", auth })
    } catch (error) {
      if (mine !== generation) {
        return
      }
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        stop({ kind: "failed", reason: "expired", message: PAIRING_MESSAGES.expired })
        return
      }
      if (error instanceof ApiError && error.status === 429) {
        withStatus("rate_limited")
        schedule(mine, (error.retryAfterSeconds ?? PAIRING_RETRY_AFTER_DEFAULT_SECONDS) * 1000)
        return
      }
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
        withStatus("reconnecting")
        schedule(mine, networkBackoffMs(networkFailures))
        networkFailures++
        return
      }
      stop({ kind: "failed", reason: "error", message: error instanceof ApiError ? userMessage(error) : UNEXPECTED_POLL_MESSAGE })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async start() {
      const mine = ++generation
      clearTimer()
      session = null
      networkFailures = 0
      setState({ kind: "starting" })
      let created
      try {
        created = await deps.api.createSession()
      } catch (error) {
        if (mine !== generation) {
          return
        }
        const unavailable = error instanceof ApiError && error.status === 503
        setState({ kind: "failed", reason: unavailable ? "unavailable" : "error", message: unavailable ? PAIRING_MESSAGES.unavailable : userMessage(error) })
        return
      }
      if (mine !== generation) {
        return
      }
      const code = displayPairingCode(created.code) ?? created.code
      const connectUrl = connectUrlFor(deps.dashboardBase, code)
      const interval = intervalMs(created.interval_seconds)
      session = { id: created.session_id, secret: created.poll_secret, interval, deadline: pairingDeadline(created.expires_at, clock.now()) }
      setState({
        kind: "waiting",
        code,
        connectUrl,
        deadline: session.deadline,
        status: "polling",
        urlWarning: approveUrlWarning(deps.env, deps.dashboardBase, created.approve_url),
      })
      deps.openExternal(connectUrl)
      schedule(mine, interval)
    },
    cancel() {
      if (state.kind === "starting" || state.kind === "waiting") {
        stop({ kind: "cancelled" })
      }
    },
    reopen() {
      if (state.kind === "waiting") {
        deps.openExternal(state.connectUrl)
      }
    },
    dispose() {
      generation++
      clearTimer()
      session = null
      listeners.clear()
    },
  }
}
