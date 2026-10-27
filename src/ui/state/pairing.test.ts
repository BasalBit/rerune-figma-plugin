import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FigmaCreateSessionResponse, FigmaPollResponse } from "../../shared/api-types"
import type { StoredAuth, UiToMain } from "../../shared/messages"
import { ApiError } from "../api/client"
import { initialView, navigate, type AppView, type NavContext } from "./navigation"
import {
  approveUrlWarning,
  connectUrlFor,
  createPairingFlow,
  formatCountdown,
  networkBackoffMs,
  PAIRING_MESSAGES,
  pairingDeadline,
  secondsLeft,
  type PairingState,
} from "./pairing"
import { signOut } from "./session"

const API = "http://localhost:8080"
const DASHBOARD = "http://localhost:3000"
const T0 = Date.parse("2026-10-27T10:00:00Z")

function session(overrides: Partial<FigmaCreateSessionResponse> = {}): FigmaCreateSessionResponse {
  return {
    session_id: "671e2a9f4c1d2b3a4f5e6d7c",
    code: "K7P4QX",
    poll_secret: "3f".repeat(32),
    approve_url: DASHBOARD + "/figma/connect?code=K7P-4QX",
    expires_at: "2026-10-27T10:10:00Z",
    interval_seconds: 2,
    ...overrides,
  }
}

const PENDING: FigmaPollResponse = { status: "pending", expires_at: "2026-10-27T10:10:00Z", interval_seconds: 2 }
const APPROVED: FigmaPollResponse = {
  status: "approved",
  token: "rrf_" + "0b".repeat(32),
  token_id: "671e2b114c1d2b3a4f5e6d7d",
  token_expires_at: "2027-01-25T10:01:12Z",
  user: { id: "kc-sub-uuid", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
}

type PollStep = FigmaPollResponse | ApiError

function harness(options: { create?: () => Promise<FigmaCreateSessionResponse>; polls?: PollStep[]; env?: "production" | "development" } = {}) {
  const polls = options.polls ?? []
  const pollTimes: number[] = []
  const api = {
    createSession: vi.fn(options.create ?? (async () => session())),
    pollSession: vi.fn(async (...args: [string, string]): Promise<FigmaPollResponse> => {
      void args
      pollTimes.push(Date.now() - T0)
      const next = polls.shift() ?? PENDING
      if (next instanceof ApiError) {
        throw next
      }
      return next
    }),
  }
  const openExternal = vi.fn()
  const saveAuth = vi.fn()
  const flow = createPairingFlow({ api, apiBase: API, dashboardBase: DASHBOARD, env: options.env ?? "production", openExternal, saveAuth })
  const states: PairingState[] = []
  flow.subscribe((state) => states.push(state))
  return { flow, api, openExternal, saveAuth, states, pollTimes }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("pairing flow", () => {
  it("shows the code, opens the dashboard once and polls every interval until approved", async () => {
    const { flow, api, openExternal, saveAuth, pollTimes } = harness({ polls: [PENDING, PENDING, APPROVED] })
    await flow.start()
    const waiting = flow.getState()
    expect(waiting).toMatchObject({ kind: "waiting", code: "K7P-4QX", connectUrl: DASHBOARD + "/figma/connect?code=K7P-4QX", status: "polling", urlWarning: null })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(DASHBOARD + "/figma/connect?code=K7P-4QX")
    expect(api.pollSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(6000)
    expect(pollTimes).toEqual([2000, 4000, 6000])
    expect(api.pollSession).toHaveBeenCalledWith("671e2a9f4c1d2b3a4f5e6d7c", "3f".repeat(32))
    const expected: StoredAuth = {
      apiBase: API,
      token: "rrf_" + "0b".repeat(32),
      tokenId: "671e2b114c1d2b3a4f5e6d7d",
      tokenExpiresAt: "2027-01-25T10:01:12Z",
      user: { id: "kc-sub-uuid", email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
      savedAt: T0 + 6000,
    }
    expect(saveAuth).toHaveBeenCalledWith(expected)
    expect(flow.getState()).toEqual({ kind: "approved", auth: expected })

    await vi.advanceTimersByTimeAsync(20000)
    expect(api.pollSession).toHaveBeenCalledTimes(3)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it("never shows the poll secret or token in any state", async () => {
    const { flow, states } = harness({ polls: [APPROVED] })
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    const visible = states.filter((state) => state.kind !== "approved")
    expect(JSON.stringify(visible)).not.toContain("3f3f")
    expect(JSON.stringify(visible)).not.toContain("rrf_")
  })

  it("approved → Signed in as; Continue → Project; Not me → logout, auth-clear, Sign in", async () => {
    const { flow } = harness({ polls: [APPROVED] })
    const context: NavContext = { apiBase: API, settings: null }
    let view: AppView = initialView(null, context)
    expect(view.screen).toBe("sign-in")
    view = navigate(view, { type: "start-sign-in" }, context)
    expect(view.screen).toBe("pairing")
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    const state = flow.getState()
    if (state.kind !== "approved") {
      throw new Error("expected approval")
    }
    view = navigate(view, { type: "pairing-approved", auth: state.auth }, context)
    expect(view).toEqual({ screen: "signed-in", notice: null, signedIn: state.auth })
    expect(navigate(view, { type: "continue" }, context).screen).toBe("project")

    const sent: UiToMain[] = []
    const logout = vi.fn(async () => {})
    await signOut({ logout, send: (message) => sent.push(message) }, state.auth)
    expect(logout).toHaveBeenCalledWith(state.auth.token)
    expect(sent).toEqual([{ type: "auth-clear", apiBase: API }])
    expect(navigate(view, { type: "not-me" }, context)).toEqual({ screen: "sign-in", notice: null, signedIn: null })
  })

  it("Not me clears the stored token even when logout fails", async () => {
    const sent: UiToMain[] = []
    const auth: StoredAuth = { apiBase: API, token: "rrf_x", tokenId: "t", tokenExpiresAt: "", user: { id: "u", email: "e", firstName: "", lastName: "" }, savedAt: 0 }
    await signOut({ logout: async () => Promise.reject(new ApiError(0, "network", "offline")), send: (message) => sent.push(message) }, auth)
    expect(sent).toEqual([{ type: "auth-clear", apiBase: API }])
  })

  it("stops on denied", async () => {
    const { flow, api } = harness({ polls: [PENDING, { status: "denied" }] })
    await flow.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(flow.getState()).toEqual({ kind: "failed", reason: "denied", message: PAIRING_MESSAGES.denied })
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.pollSession).toHaveBeenCalledTimes(2)
  })

  it("treats 404 and 410 as an expired code", async () => {
    for (const status of [404, 410]) {
      const { flow } = harness({ polls: [new ApiError(status, status === 404 ? "pairing_session_not_found" : "pairing_session_expired", "gone")] })
      await flow.start()
      await vi.advanceTimersByTimeAsync(2000)
      expect(flow.getState()).toEqual({ kind: "failed", reason: "expired", message: PAIRING_MESSAGES.expired })
    }
  })

  it("reports an unavailable server when E2 answers 503", async () => {
    const { flow, openExternal } = harness({ create: async () => Promise.reject(new ApiError(503, null, "Figma sign-in is not configured")) })
    await flow.start()
    expect(flow.getState()).toEqual({ kind: "failed", reason: "unavailable", message: PAIRING_MESSAGES.unavailable })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("waits Retry-After on 429 (10 s by default)", async () => {
    const { flow, pollTimes } = harness({ polls: [new ApiError(429, null, "slow", 5), new ApiError(429, null, "slow"), PENDING] })
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(flow.getState()).toMatchObject({ kind: "waiting", status: "rate_limited" })
    await vi.advanceTimersByTimeAsync(5000 + 10000)
    expect(pollTimes).toEqual([2000, 7000, 17000])
    expect(flow.getState()).toMatchObject({ kind: "waiting", status: "polling" })
  })

  it("backs off 2 s → 4 s → 8 s → 10 s on network errors, then resets after a success", async () => {
    const network = () => new ApiError(0, "network", "offline")
    const { flow, pollTimes } = harness({ polls: [network(), network(), network(), network(), network(), PENDING, network()] })
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(flow.getState()).toMatchObject({ kind: "waiting", status: "reconnecting" })
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 10000 + 10000 + 2000)
    // polls at 2 s, then +2, +4, +8, +10 (max), +10, then the normal interval, then +2 s backoff again
    expect(pollTimes).toEqual([2000, 4000, 8000, 16000, 26000, 36000, 38000])
  })

  it("treats 5xx like a network error and other 4xx as a failure", async () => {
    const { flow } = harness({ polls: [new ApiError(502, null, "Bad Gateway"), new ApiError(400, null, "invalid poll secret")] })
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(flow.getState()).toMatchObject({ kind: "waiting", status: "reconnecting" })
    await vi.advanceTimersByTimeAsync(2000)
    expect(flow.getState()).toEqual({ kind: "failed", reason: "error", message: "invalid poll secret" })
  })

  it("expires at the deadline and stops polling", async () => {
    const { flow, api } = harness({ create: async () => session({ expires_at: "2026-10-27T10:00:05Z" }) })
    await flow.start()
    const waiting = flow.getState()
    expect(waiting.kind === "waiting" && waiting.deadline).toBe(T0 + 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(flow.getState()).toEqual({ kind: "failed", reason: "expired", message: PAIRING_MESSAGES.expired })
    const calls = api.pollSession.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.pollSession).toHaveBeenCalledTimes(calls)
  })

  it("cancel stops polling and drops in-flight answers", async () => {
    let release: (value: FigmaPollResponse) => void = () => {}
    const { flow, api, saveAuth } = harness()
    api.pollSession.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    flow.cancel()
    expect(flow.getState()).toEqual({ kind: "cancelled" })
    release(APPROVED)
    await vi.advanceTimersByTimeAsync(10000)
    expect(saveAuth).not.toHaveBeenCalled()
    expect(flow.getState()).toEqual({ kind: "cancelled" })
    expect(api.pollSession).toHaveBeenCalledTimes(1)
  })

  it("Open browser again reopens the same connect URL", async () => {
    const { flow, openExternal } = harness()
    await flow.start()
    flow.reopen()
    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(openExternal.mock.calls[1][0]).toBe(DASHBOARD + "/figma/connect?code=K7P-4QX")
  })

  it("restarting replaces the previous session", async () => {
    const { flow, api } = harness()
    await flow.start()
    api.createSession.mockResolvedValueOnce(session({ session_id: "aaaaaaaaaaaaaaaaaaaaaaaa", code: "ABCDEF" }))
    await flow.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.pollSession).toHaveBeenCalledTimes(1)
    expect(api.pollSession.mock.calls[0][0]).toBe("aaaaaaaaaaaaaaaaaaaaaaaa")
    expect(flow.getState()).toMatchObject({ code: "ABC-DEF" })
  })

  it("warns in development builds when approve_url points elsewhere", async () => {
    const { flow } = harness({ env: "development", create: async () => session({ approve_url: "http://localhost:3001/figma/connect?code=K7P-4QX" }) })
    await flow.start()
    expect(flow.getState()).toMatchObject({ kind: "waiting", urlWarning: expect.stringContaining("FIGMA_CONNECT_URL") })
  })
})

describe("pairing helpers", () => {
  it("builds the connect URL from the dashboard base, never approve_url", () => {
    expect(connectUrlFor("https://rerune.io", "K7P-4QX")).toBe("https://rerune.io/figma/connect?code=K7P-4QX")
    expect(connectUrlFor("http://localhost:3000/", "A B")).toBe("http://localhost:3000/figma/connect?code=A%20B")
  })

  it("warns only in development builds", () => {
    expect(approveUrlWarning("production", "https://rerune.io", "http://localhost:3000/figma/connect?code=X")).toBeNull()
    expect(approveUrlWarning("development", "http://localhost:3000", "http://localhost:3000/figma/connect?code=X")).toBeNull()
    expect(approveUrlWarning("development", "http://localhost:3000", "https://rerune.io/figma/connect?code=X")).toContain("does not start with")
  })

  it("bounds the deadline by ten minutes", () => {
    expect(pairingDeadline("2026-10-27T10:10:00Z", T0)).toBe(T0 + 600000)
    expect(pairingDeadline("2026-10-27T10:30:00Z", T0)).toBe(T0 + 600000)
    expect(pairingDeadline("2026-10-27T10:04:00Z", T0)).toBe(T0 + 240000)
    expect(pairingDeadline("2026-10-27T09:00:00Z", T0)).toBe(T0 + 600000)
    expect(pairingDeadline("nonsense", T0)).toBe(T0 + 600000)
  })

  it("formats the countdown", () => {
    expect(secondsLeft(T0 + 61001, T0)).toBe(62)
    expect(secondsLeft(T0 - 1, T0)).toBe(0)
    expect(formatCountdown(600)).toBe("10:00")
    expect(formatCountdown(65)).toBe("1:05")
    expect(networkBackoffMs(0)).toBe(2000)
    expect(networkBackoffMs(7)).toBe(10000)
  })
})
