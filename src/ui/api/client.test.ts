import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  buildUrl,
  createApiClient,
  createLimiter,
  errorFromResponse,
  FORBIDDEN_MESSAGE,
  NETWORK_MESSAGE,
  parseRetryAfter,
  RATE_LIMIT_MESSAGE,
  SERVER_MESSAGE,
  SESSION_ENDED_MESSAGE,
  TIMEOUT_MESSAGE,
  userMessage,
  type ApiClientOptions,
  type FetchLike,
} from "./client"

const API = "http://localhost:8080"

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } })
}

interface Call { url: string; init: RequestInit }

function stubFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next === undefined) {
      throw new Error("unexpected fetch " + url)
    }
    if (next instanceof Error) {
      throw next
    }
    return typeof next === "function" ? next() : next
  }
  return { fetch, calls }
}

function client(fetch: FetchLike, extra: Partial<ApiClientOptions> = {}) {
  const onUnauthorized = vi.fn()
  const sleep = vi.fn(async () => {})
  const api = createApiClient({ apiBase: API, fetch, getToken: () => "rrf_secret", onUnauthorized, sleep, isOnline: () => true, ...extra })
  return { api, onUnauthorized, sleep }
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) {
      return error
    }
    throw error
  }
  throw new Error("expected a rejection")
}

describe("createApiClient", () => {
  it("sends JSON with the plugin token and parses JSON responses", async () => {
    const { fetch, calls } = stubFetch(json(200, { ok: 1 }))
    const { api } = client(fetch)
    await expect(api.request("POST", "/figma/projects/p/push", { json: { items: [] } })).resolves.toEqual({ ok: 1 })
    expect(calls[0].url).toBe(API + "/figma/projects/p/push")
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.body).toBe('{"items":[]}')
    expect(calls[0].init.credentials).toBe("omit")
    expect(headersOf(calls[0])).toMatchObject({ Authorization: "Bearer rrf_secret", "Content-Type": "application/json" })
  })

  it("omits the token for public endpoints and uses an explicit bearer when given", async () => {
    const { fetch, calls } = stubFetch(json(200, {}), json(200, {}))
    const { api } = client(fetch)
    await api.request("GET", "/figma/meta", { auth: false })
    await api.request("POST", "/figma/auth/logout", { bearer: "rrf_other", json: {} })
    expect(headersOf(calls[0]).Authorization).toBeUndefined()
    expect(headersOf(calls[1]).Authorization).toBe("Bearer rrf_other")
  })

  it("returns text bodies and undefined for 204", async () => {
    const { fetch } = stubFetch(text(200, "plain"), new Response(null, { status: 204 }))
    const { api } = client(fetch)
    await expect(api.request("GET", "/x")).resolves.toBe("plain")
    await expect(api.request("POST", "/y", { json: {} })).resolves.toBeUndefined()
  })

  it("maps JSON error bodies to ApiError with reason and message", async () => {
    const { fetch } = stubFetch(json(400, { message: "unknown language de-CH", reason: "unknown_language" }))
    const { api } = client(fetch)
    const error = await rejection(api.request("POST", "/figma/projects/p/keys/resolve", { json: {}, retry: "none" }))
    expect(error).toMatchObject({ status: 400, reason: "unknown_language", message: "unknown language de-CH", retryAfterSeconds: null })
    expect(userMessage(error)).toBe("This language was removed from the project. Refresh.")
  })

  it("maps plain-text error bodies to ApiError without a reason", async () => {
    const { fetch } = stubFetch(text(404, "Project not found\n"))
    const { api } = client(fetch)
    const error = await rejection(api.request("GET", "/figma/projects/p", { retry: "none" }))
    expect(error).toMatchObject({ status: 404, reason: null, message: "Project not found" })
    expect(userMessage(error)).toBe("Project not found")
  })

  it("raises the signed-out event on a 401 from a plugin route", async () => {
    const { fetch } = stubFetch(json(401, { message: "invalid token", reason: "plugin_token_invalid" }))
    const { api, onUnauthorized } = client(fetch)
    const error = await rejection(api.request("GET", "/figma/projects"))
    expect(error.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith(error)
    expect(userMessage(error)).toBe(SESSION_ENDED_MESSAGE)
  })

  it("treats a 401 text body as signed out too", async () => {
    const { fetch } = stubFetch(text(401, "Unauthorized"))
    const { api, onUnauthorized } = client(fetch)
    await rejection(api.request("GET", "/figma/projects"))
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it("does not raise signed-out for public or explicit-bearer requests", async () => {
    const { fetch } = stubFetch(json(401, { message: "x" }), json(401, { message: "y" }))
    const { api, onUnauthorized } = client(fetch)
    await rejection(api.request("GET", "/figma/meta", { auth: false }))
    await rejection(api.request("POST", "/figma/auth/logout", { bearer: "rrf_x", json: {} }))
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("signals signed-out without sending when no token is stored", async () => {
    const { fetch, calls } = stubFetch()
    const { api, onUnauthorized } = client(fetch, { getToken: () => null })
    const error = await rejection(api.request("GET", "/figma/projects"))
    expect(error).toMatchObject({ status: 401, reason: "plugin_token_invalid" })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  it("retries a 429 once after Retry-After seconds", async () => {
    const { fetch, calls } = stubFetch(text(429, "Too many requests", { "Retry-After": "7" }), json(200, { done: true }))
    const { api, sleep } = client(fetch)
    await expect(api.request("GET", "/figma/projects")).resolves.toEqual({ done: true })
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(7000)
  })

  it("caps the 429 wait at 60 seconds and gives up after one retry", async () => {
    const { fetch, calls } = stubFetch(text(429, "slow down", { "Retry-After": "600" }), text(429, "slow down", { "Retry-After": "600" }))
    const { api, sleep } = client(fetch)
    const error = await rejection(api.request("POST", "/figma/projects/p/keys/by-name", { json: {}, retry: "read" }))
    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(600)
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(60000)
    expect(userMessage(error)).toBe(RATE_LIMIT_MESSAGE)
  })

  it("never retries push", async () => {
    const { fetch, calls } = stubFetch(text(429, "slow down"), new TypeError("Failed to fetch"))
    const { api } = client(fetch)
    expect((await rejection(api.request("POST", "/figma/projects/p/push", { json: {}, retry: "none" }))).status).toBe(429)
    expect((await rejection(api.request("POST", "/figma/projects/p/push", { json: {}, retry: "none" }))).reason).toBe("network")
    expect(calls).toHaveLength(2)
  })

  it("retries reads once on a network error", async () => {
    const { fetch, calls } = stubFetch(new TypeError("Failed to fetch"), json(200, { projects: [] }))
    const { api } = client(fetch)
    await expect(api.request("GET", "/figma/projects")).resolves.toEqual({ projects: [] })
    expect(calls).toHaveLength(2)
  })

  it("reports a network error after the single retry", async () => {
    const { fetch, calls } = stubFetch(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"))
    const { api } = client(fetch)
    const error = await rejection(api.request("GET", "/figma/projects"))
    expect(error).toMatchObject({ status: 0, reason: "network", message: NETWORK_MESSAGE })
    expect(calls).toHaveLength(2)
  })

  it("does not retry writes on network errors", async () => {
    const { fetch, calls } = stubFetch(new TypeError("Failed to fetch"))
    const { api } = client(fetch)
    expect((await rejection(api.request("POST", "/figma/auth/sessions", { json: {}, retry: "rate" }))).reason).toBe("network")
    expect(calls).toHaveLength(1)
  })

  it("fails fast when the browser is offline", async () => {
    const { fetch, calls } = stubFetch()
    const { api } = client(fetch, { isOnline: () => false })
    const error = await rejection(api.request("GET", "/figma/projects"))
    expect(error).toMatchObject({ status: 0, reason: "network" })
    expect(userMessage(error)).toBe(NETWORK_MESSAGE)
    expect(calls).toHaveLength(0)
  })

  it("hides 5xx messages from the user", async () => {
    const { fetch } = stubFetch(json(500, { message: "mongo: connection reset at db.go:42" }))
    const { api } = client(fetch)
    const error = await rejection(api.request("POST", "/figma/projects/p/push", { json: {}, retry: "none" }))
    expect(error.message).toContain("mongo")
    expect(userMessage(error)).toBe(SERVER_MESSAGE)
  })

  it("never puts the token in the URL", async () => {
    const { fetch, calls } = stubFetch(json(200, {}))
    const { api } = client(fetch)
    await api.request("GET", "/figma/projects/p/keys/search", { query: { q: "Pay now", limit: 20, cursor: null } })
    expect(calls[0].url).toBe(API + "/figma/projects/p/keys/search?q=Pay+now&limit=20")
    expect(calls[0].url).not.toContain("rrf_")
  })

  describe("timeouts", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it("aborts after the timeout and reports a timeout error", async () => {
      let signal: AbortSignal | null = null
      const fetch: FetchLike = (_url, init) => {
        signal = init.signal ?? null
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
        })
      }
      const { api } = client(fetch)
      const pending = rejection(api.request("POST", "/figma/projects/p/push", { json: {}, retry: "none", timeoutMs: 5000 }))
      await vi.advanceTimersByTimeAsync(4999)
      expect((signal as AbortSignal | null)?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const error = await pending
      expect(error).toMatchObject({ status: 0, reason: "timeout", message: TIMEOUT_MESSAGE })
      expect(userMessage(error)).toBe(TIMEOUT_MESSAGE)
    })

    it("uses 30 s by default and 60 s for uploads", async () => {
      const seen: number[] = []
      const started = Date.now()
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            seen.push(Date.now() - started)
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      const { api } = client(fetch)
      const plain = rejection(api.request("POST", "/a", { json: {}, retry: "none" }))
      const upload = rejection(api.request("POST", "/b", { form: new FormData(), retry: "none" }))
      await vi.advanceTimersByTimeAsync(60000)
      await plain
      await upload
      expect(seen).toEqual([30000, 60000])
    })
  })

  it("keeps at most four requests in flight", async () => {
    const releases: (() => void)[] = []
    let inFlight = 0
    let maxInFlight = 0
    const fetch: FetchLike = () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight--
          resolve(json(200, {}))
        })
      })
    }
    const { api } = client(fetch)
    const all = Promise.all(Array.from({ length: 7 }, (_, i) => api.request("GET", "/r" + i)))
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inFlight).toBe(4)
    while (releases.length > 0) {
      ;(releases.shift() as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await all
    expect(maxInFlight).toBe(4)
  })
})

describe("helpers", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("12", 0)).toBe(12)
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter("soon", 0)).toBeNull()
    const now = Date.parse("2026-10-27T10:00:00Z")
    expect(parseRetryAfter("Tue, 27 Oct 2026 10:00:30 GMT", now)).toBe(30)
  })

  it("builds URLs with encoded query values", () => {
    expect(buildUrl("https://rerune.io/api", "/figma/meta")).toBe("https://rerune.io/api/figma/meta")
    expect(buildUrl("https://rerune.io/api/", "/x", { q: "a&b", n: 2, skip: undefined })).toBe("https://rerune.io/api/x?q=a%26b&n=2")
  })

  it("falls back to the status text when the body is empty", () => {
    expect(errorFromResponse(502, "Bad Gateway", "", null).message).toBe("Bad Gateway")
    expect(errorFromResponse(418, "", "", null).message).toBe("HTTP 418")
  })

  it("limits concurrency in FIFO order", async () => {
    const limiter = createLimiter(1)
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => limiter.run(async () => order.push(n))))
    expect(order).toEqual([1, 2, 3])
    expect(limiter.active).toBe(0)
    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(limiter.active).toBe(0)
  })

  it("maps 403 without a message to the permission text and unknown errors to their message", () => {
    expect(userMessage(new ApiError(403, null, "Forbidden"))).toBe(FORBIDDEN_MESSAGE)
    expect(userMessage(new ApiError(410, "pairing_session_expired", "gone"))).toBe("Code expired. Start sign-in again.")
    expect(userMessage(new Error("The plugin stopped responding. Try again."))).toBe("The plugin stopped responding. Try again.")
    expect(userMessage("weird")).toBe("Something went wrong. Try again.")
  })
})
