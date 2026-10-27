import { MAX_REQUESTS_IN_FLIGHT, REQUEST_TIMEOUT_MS, RETRY_AFTER_MAX_SECONDS, UPLOAD_TIMEOUT_MS } from "../../shared/constants"

// Fetch wrapper for the ReRune API (§7.20). Every ReRune call runs in the UI iframe: it has the token, fetch,
// FormData and AbortController; main never talks to the network outside codegen.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

// "read": idempotent reads and resolve, retried once on a network error and once on 429.
// "rate": retried once on 429 only. "none": never retried (push, uploads, pairing polls).
export type RetryPolicy = "read" | "rate" | "none"

export interface ApiRequestOptions {
  json?: unknown
  form?: FormData
  query?: Record<string, string | number | null | undefined>
  timeoutMs?: number
  auth?: boolean                 // send the plugin token (default true)
  bearer?: string                // explicit bearer instead of the stored plugin token; never raises signed-out
  retry?: RetryPolicy
}

export interface ApiClient {
  readonly apiBase: string
  request<T>(method: HttpMethod, path: string, options?: ApiRequestOptions): Promise<T>
}

export interface ApiClientOptions {
  apiBase: string
  fetch: FetchLike
  getToken(): string | null
  onUnauthorized?(error: ApiError): void   // any 401 from a request sent with the plugin token (§3.11)
  isOnline?(): boolean
  sleep?(ms: number): Promise<void>
  now?(): number
  maxInFlight?: number
}

export const NETWORK_MESSAGE = "Can't reach ReRune. Check your connection."
export const TIMEOUT_MESSAGE = "ReRune took too long to answer. Try again."
export const SERVER_MESSAGE = "ReRune had a problem. Try again."
export const SESSION_ENDED_MESSAGE = "Your session ended. Sign in again."
export const RATE_LIMIT_MESSAGE = "ReRune is busy. Wait a moment and try again."
export const FORBIDDEN_MESSAGE = "You don't have permission to do this in this project."
export const UNEXPECTED_MESSAGE = "Something went wrong. Try again."

export const NETWORK_RETRY_DELAY_MS = 1000
export const RATE_LIMIT_DEFAULT_SECONDS = 5

// Plugin messages per ErrorResponse.reason (Appendix B.1). Reasons without a plugin message fall through to
// the status-based messages below.
export const REASON_MESSAGES: Readonly<Record<string, string>> = {
  plugin_token_invalid: SESSION_ENDED_MESSAGE,
  pairing_session_not_found: "Code expired. Start sign-in again.",
  pairing_session_expired: "Code expired. Start sign-in again.",
  unknown_language: "This language was removed from the project. Refresh.",
  unknown_variation_option: "This variation was removed. Refresh.",
  invalid_figma_url: "Paste a Figma file link (Share → Copy link).",
  design_storage_disabled: "Screenshots are switched off on this ReRune server.",
  design_storage_failed: "Screenshot upload failed. It will be retried on the next push.",
  screenshot_limit_reached: "This project reached its screenshot limit. Contact support.",
  invalid_image: "This frame image couldn't be uploaded.",
}

export class ApiError extends Error {
  readonly status: number
  readonly reason: string | null
  readonly retryAfterSeconds: number | null

  constructor(status: number, reason: string | null, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.reason = reason
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0
}

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>
  readonly active: number
  readonly queued: number
}

// At most `max` tasks run at once; the rest wait in FIFO order.
export function createLimiter(max: number): Limiter {
  let active = 0
  const queue: (() => void)[] = []
  const next = () => {
    while (active < max && queue.length > 0) {
      const start = queue.shift() as () => void
      active++
      start()
    }
  }
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          const settle = () => {
            active--
            next()
          }
          let promise: Promise<T>
          try {
            promise = task()
          } catch (error) {
            settle()
            reject(error)
            return
          }
          promise.then(
            (value) => {
              settle()
              resolve(value)
            },
            (error: unknown) => {
              settle()
              reject(error)
            },
          )
        })
        next()
      })
    },
    get active() {
      return active
    },
    get queued() {
      return queue.length
    },
  }
}

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") {
    return null
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  const date = Date.parse(trimmed)
  if (isNaN(date)) {
    return null
  }
  return Math.max(0, Math.ceil((date - now) / 1000))
}

export function buildUrl(apiBase: string, path: string, query?: ApiRequestOptions["query"]): string {
  let url = apiBase.replace(/\/+$/, "") + path
  if (query !== undefined) {
    const params = new URLSearchParams()
    for (const name of Object.keys(query)) {
      const value = query[name]
      if (value !== undefined && value !== null) {
        params.append(name, String(value))
      }
    }
    const encoded = params.toString()
    if (encoded !== "") {
      url += (url.includes("?") ? "&" : "?") + encoded
    }
  }
  return url
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }
  const text = await response.text()
  const type = response.headers.get("Content-Type") ?? ""
  if (type.toLowerCase().includes("json") && text.trim() !== "") {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

// Error bodies are JSON {message, reason?} or plain text (§3.11); both are handled.
export function errorFromResponse(status: number, statusText: string, payload: unknown, retryAfterSeconds: number | null): ApiError {
  let message = ""
  let reason: string | null = null
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const body = payload as { message?: unknown; reason?: unknown }
    message = typeof body.message === "string" ? body.message : ""
    reason = typeof body.reason === "string" && body.reason !== "" ? body.reason : null
  } else if (typeof payload === "string") {
    message = payload.trim()
  }
  if (message === "") {
    message = statusText !== "" ? statusText : "HTTP " + status
  }
  return new ApiError(status, reason, message, retryAfterSeconds)
}

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const limiter = createLimiter(options.maxInFlight ?? MAX_REQUESTS_IN_FLIGHT)
  const isOnline = options.isOnline ?? defaultIsOnline
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now

  async function send<T>(method: HttpMethod, path: string, request: ApiRequestOptions): Promise<T> {
    if (!isOnline()) {
      throw new ApiError(0, "network", NETWORK_MESSAGE)
    }
    const headers: Record<string, string> = { Accept: "application/json" }
    const usesPluginToken = request.auth !== false && request.bearer === undefined
    if (request.bearer !== undefined) {
      headers.Authorization = "Bearer " + request.bearer
    } else if (request.auth !== false) {
      const token = options.getToken()
      if (token === null || token === "") {
        const error = new ApiError(401, "plugin_token_invalid", SESSION_ENDED_MESSAGE)
        options.onUnauthorized?.(error)
        throw error
      }
      headers.Authorization = "Bearer " + token
    }
    let body: BodyInit | undefined
    if (request.form !== undefined) {
      body = request.form
    } else if (request.json !== undefined) {
      body = JSON.stringify(request.json)
      headers["Content-Type"] = "application/json"
    }
    const controller = new AbortController()
    const timeoutMs = request.timeoutMs ?? (request.form !== undefined ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      let response: Response
      let payload: unknown
      try {
        response = await options.fetch(buildUrl(options.apiBase, path, request.query), {
          method,
          headers,
          body,
          signal: controller.signal,
          credentials: "omit",
        })
        payload = await readPayload(response)
      } catch {
        // fetch rejects with a TypeError on network and CORS failures; an abort means our timeout fired.
        throw timedOut ? new ApiError(0, "timeout", TIMEOUT_MESSAGE) : new ApiError(0, "network", NETWORK_MESSAGE)
      }
      if (response.ok) {
        return payload as T
      }
      const error = errorFromResponse(response.status, response.statusText, payload, parseRetryAfter(response.headers.get("Retry-After"), now()))
      if (error.status === 401 && usesPluginToken) {
        options.onUnauthorized?.(error)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    apiBase: options.apiBase,
    async request<T>(method: HttpMethod, path: string, request: ApiRequestOptions = {}): Promise<T> {
      const policy: RetryPolicy = request.retry ?? (method === "GET" ? "read" : "rate")
      let networkRetried = false
      let rateRetried = false
      for (;;) {
        try {
          return await limiter.run(() => send<T>(method, path, request))
        } catch (error) {
          if (!(error instanceof ApiError)) {
            throw error
          }
          if (error.reason === "network" && policy === "read" && !networkRetried && isOnline()) {
            networkRetried = true
            await sleep(NETWORK_RETRY_DELAY_MS)
            continue
          }
          if (error.status === 429 && policy !== "none" && !rateRetried) {
            rateRetried = true
            await sleep(Math.min(error.retryAfterSeconds ?? RATE_LIMIT_DEFAULT_SECONDS, RETRY_AFTER_MAX_SECONDS) * 1000)
            continue
          }
          throw error
        }
      }
    },
  }
}

function cleanServerText(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  return flat.length > 200 ? flat.slice(0, 199) + "…" : flat
}

// User-facing text for any error a screen catches (§7.20): Appendix B.1 reasons first, never a stack trace
// or a raw 5xx message.
export function userMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.reason !== null && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, error.reason)) {
      return REASON_MESSAGES[error.reason]
    }
    if (error.status === 0) {
      return error.reason === "timeout" ? TIMEOUT_MESSAGE : NETWORK_MESSAGE
    }
    if (error.status === 401) {
      return SESSION_ENDED_MESSAGE
    }
    if (error.status === 429) {
      return RATE_LIMIT_MESSAGE
    }
    if (error.status >= 500) {
      return SERVER_MESSAGE
    }
    if (error.status === 403 && (error.message === "" || error.message === "Forbidden")) {
      return FORBIDDEN_MESSAGE
    }
    const text = cleanServerText(error.message)
    return text === "" ? UNEXPECTED_MESSAGE : text
  }
  if (error instanceof Error && error.message !== "") {
    return error.message
  }
  return UNEXPECTED_MESSAGE
}
