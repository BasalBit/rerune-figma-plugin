import type { FigmaPollApproved } from "../../shared/api-types"
import type { StoredAuth, UiToMain } from "../../shared/messages"

// Auth session helpers (§7.19, D34): the stored shape of a fresh token, sign-out and "Not me".

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
  return auth !== null && auth.apiBase === apiBase && auth.token !== "" ? auth : null
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
