import type { FigmaPollApproved, FigmaPollResponse } from "../../shared/api-types"
import type { StoredAuth, UiToMain } from "../../shared/messages"

// Auth session helpers (§7.19, D34): the stored shape of a fresh token, sign-out and "Not me".

// §3.5: "rrf_" + 64 lowercase hex.
export const PLUGIN_TOKEN_PATTERN = /^rrf_[0-9a-f]{64}$/
export const UNEXPECTED_POLL_MESSAGE = "ReRune sent an unexpected answer. Start sign-in again."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// E3 answers (§E3): only pending, approved (with a well-formed token and user) and denied are accepted. Anything
// else is null, and the poller stops with UNEXPECTED_POLL_MESSAGE instead of a raw JavaScript error (§7.20).
export function parsePollResponse(payload: unknown): FigmaPollResponse | null {
  if (!isRecord(payload)) {
    return null
  }
  switch (payload.status) {
    case "pending":
      return {
        status: "pending",
        expires_at: text(payload.expires_at),
        interval_seconds: typeof payload.interval_seconds === "number" ? payload.interval_seconds : 0,
      }
    case "denied":
      return { status: "denied" }
    case "approved": {
      const user = payload.user
      if (
        typeof payload.token !== "string" || !PLUGIN_TOKEN_PATTERN.test(payload.token) || !nonEmpty(payload.token_id) ||
        !isRecord(user) || !nonEmpty(user.id) || typeof user.email !== "string"
      ) {
        return null
      }
      return {
        status: "approved",
        token: payload.token,
        token_id: payload.token_id,
        token_expires_at: text(payload.token_expires_at),
        user: { id: user.id, email: user.email, first_name: text(user.first_name), last_name: text(user.last_name) },
      }
    }
    default:
      return null
  }
}

export function storedAuthFromApproved(response: FigmaPollApproved, apiBase: string, now: number): StoredAuth {
  return {
    apiBase,
    token: response.token,
    tokenId: response.token_id,
    tokenExpiresAt: response.token_expires_at,
    user: {
      id: response.user.id,
      email: response.user.email,
      firstName: response.user.first_name,
      lastName: response.user.last_name,
    },
    savedAt: now,
  }
}

export function fullName(user: Pick<StoredAuth["user"], "firstName" | "lastName">): string {
  return [user.firstName, user.lastName].map((part) => part.trim()).filter((part) => part !== "").join(" ")
}

// Auth stored for another server (a development build reading a production token, or the reverse) is ignored.
export function usableAuth(auth: StoredAuth | null, apiBase: string): StoredAuth | null {
  return auth !== null && auth.apiBase === apiBase && typeof auth.token === "string" && auth.token !== "" ? auth : null
}

export interface SignOutDeps {
  logout(token: string): Promise<void>
  send(message: UiToMain): void
}

// Sign out and "Not me" (§7.19, §3.12): E7, then auth-clear even when the request fails.
export async function signOut(deps: SignOutDeps, auth: StoredAuth): Promise<void> {
  try {
    await deps.logout(auth.token)
  } catch {
    // The token is forgotten locally either way; a revoked or expired token answers 401.
  } finally {
    deps.send({ type: "auth-clear", apiBase: auth.apiBase })
  }
}

export const SESSION_ENDED_NOTICE = "Your session ended. Sign in again."
