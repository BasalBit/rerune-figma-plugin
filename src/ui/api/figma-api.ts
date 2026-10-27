import type {
  FigmaByNameRequest,
  FigmaByNameResponse,
  FigmaCreateSessionResponse,
  FigmaMetaResponse,
  FigmaPairingCodeResponse,
  FigmaPairingDecisionResponse,
  FigmaPollResponse,
  FigmaProjectDetail,
  FigmaProjectsResponse,
  FigmaPushRequest,
  FigmaPushResponse,
  FigmaResolveRequest,
  FigmaResolveResponse,
  FigmaSearchResponse,
} from "../../shared/api-types"
import { SEARCH_QUERY_MAX_RUNES } from "../../shared/constants"
import { canonicalPairingCode } from "../../shared/pairing-code"
import { firstRunes } from "../../shared/text"
import type { ApiClient } from "./client"

// One function per Phase 1 endpoint (E1–E13, §4). Paths are relative to __API_BASE__ (nginx strips /api).

export interface SearchParams { q: string; cursor?: string | null; limit?: number }

export interface FigmaApi {
  meta(): Promise<FigmaMetaResponse>                                                          // E1
  createSession(): Promise<FigmaCreateSessionResponse>                                        // E2
  pollSession(sessionId: string, pollSecret: string): Promise<FigmaPollResponse>              // E3
  pairingCode(code: string, sessionToken: string): Promise<FigmaPairingCodeResponse>          // E4 (dashboard session bearer, D6)
  approveCode(code: string, sessionToken: string): Promise<FigmaPairingDecisionResponse>      // E5 (dashboard session bearer, D6)
  denyCode(code: string, sessionToken: string): Promise<FigmaPairingDecisionResponse>         // E6 (dashboard session bearer, D6)
  logout(token: string): Promise<void>                                                        // E7
  projects(): Promise<FigmaProjectsResponse>                                                  // E8
  project(projectId: string): Promise<FigmaProjectDetail>                                     // E9
  searchKeys(projectId: string, params: SearchParams): Promise<FigmaSearchResponse>           // E10
  keysByName(projectId: string, request: FigmaByNameRequest): Promise<FigmaByNameResponse>    // E11
  resolveKeys(projectId: string, request: FigmaResolveRequest): Promise<FigmaResolveResponse> // E12
  push(projectId: string, request: FigmaPushRequest): Promise<FigmaPushResponse>              // E13
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function projectPath(projectId: string, rest = ""): string {
  return "/figma/projects/" + segment(projectId) + rest
}

// Pairing codes travel canonical (K7P4QX, Appendix A.1); anything else is sent as typed so the server answers 400.
function codePath(code: string, rest = ""): string {
  return "/figma/auth/codes/" + segment(canonicalPairingCode(code) ?? code) + rest
}

export function searchQuery(q: string): string {
  return firstRunes(q.trim(), SEARCH_QUERY_MAX_RUNES)
}

export function createFigmaApi(client: ApiClient): FigmaApi {
  return {
    meta: () => client.request<FigmaMetaResponse>("GET", "/figma/meta", { auth: false }),
    createSession: () => client.request<FigmaCreateSessionResponse>("POST", "/figma/auth/sessions", { auth: false, json: {}, retry: "rate" }),
    pollSession: (sessionId, pollSecret) =>
      client.request<FigmaPollResponse>("POST", "/figma/auth/sessions/" + segment(sessionId) + "/poll", {
        auth: false,
        json: { poll_secret: pollSecret },
        retry: "none",
      }),
    pairingCode: (code, sessionToken) => client.request<FigmaPairingCodeResponse>("GET", codePath(code), { bearer: sessionToken }),
    approveCode: (code, sessionToken) =>
      client.request<FigmaPairingDecisionResponse>("POST", codePath(code, "/approve"), { bearer: sessionToken, json: {}, retry: "none" }),
    denyCode: (code, sessionToken) =>
      client.request<FigmaPairingDecisionResponse>("POST", codePath(code, "/deny"), { bearer: sessionToken, json: {}, retry: "none" }),
    // The token is passed explicitly: a 401 here (already revoked) must not raise a second signed-out event.
    logout: async (token) => {
      await client.request<unknown>("POST", "/figma/auth/logout", { bearer: token, json: {}, retry: "none" })
    },
    projects: () => client.request<FigmaProjectsResponse>("GET", "/figma/projects"),
    project: (projectId) => client.request<FigmaProjectDetail>("GET", projectPath(projectId)),
    searchKeys: (projectId, params) =>
      client.request<FigmaSearchResponse>("GET", projectPath(projectId, "/keys/search"), {
        query: { q: searchQuery(params.q), cursor: params.cursor ?? null, limit: params.limit ?? null },
      }),
    keysByName: (projectId, request) =>
      client.request<FigmaByNameResponse>("POST", projectPath(projectId, "/keys/by-name"), {
        json: { names: request.names ?? [], texts: request.texts ?? [] },
        retry: "read",
      }),
    resolveKeys: (projectId, request) =>
      client.request<FigmaResolveResponse>("POST", projectPath(projectId, "/keys/resolve"), { json: request, retry: "read" }),
    push: (projectId, request) => client.request<FigmaPushResponse>("POST", projectPath(projectId, "/push"), { json: request, retry: "none" }),
  }
}
