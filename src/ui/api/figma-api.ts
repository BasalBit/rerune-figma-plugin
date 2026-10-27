import type {
  FigmaByNameRequest,
  FigmaByNameResponse,
  FigmaCreateSessionResponse,
  FigmaFile,
  FigmaFilesResponse,
  FigmaLinksListResponse,
  FigmaLinksQuery,
  FigmaLinksRequest,
  FigmaLinksResponse,
  FigmaMetaResponse,
  FigmaPairingCodeResponse,
  FigmaPairingDecisionResponse,
  FigmaPollResponse,
  FigmaProjectDetail,
  FigmaProjectsResponse,
  FigmaPushRequest,
  FigmaPushResponse,
  FigmaRegisterFileRequest,
  FigmaResolveRequest,
  FigmaResolveResponse,
  FigmaScreenshotContentType,
  FigmaScreenshotMeta,
  FigmaScreenshotUploadResponse,
  FigmaSearchResponse,
} from "../../shared/api-types"
import { SEARCH_QUERY_MAX_RUNES } from "../../shared/constants"
import { canonicalPairingCode } from "../../shared/pairing-code"
import { firstRunes } from "../../shared/text"
import type { ApiClient } from "./client"

// One function per endpoint (Phase 1: E1–E13; Phase 2 files, links and screenshot upload: E14–E19; §4). Paths are
// relative to __API_BASE__ (nginx strips /api).

export interface SearchParams { q: string; cursor?: string | null; limit?: number }

// E19 multipart parts (§7.16): the image as `image/jpeg` or `image/png` named `<frame id>.jpg|png`, and `meta` as a
// JSON blob.
export interface ScreenshotUpload {
  image: Uint8Array
  contentType: FigmaScreenshotContentType
  fileName: string
  meta: FigmaScreenshotMeta
}

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
  registerFile(projectId: string, request: FigmaRegisterFileRequest): Promise<FigmaFile>      // E14
  files(projectId: string): Promise<FigmaFilesResponse>                                       // E15
  deleteFile(projectId: string, fileKey: string): Promise<void>                               // E16
  upsertLinks(projectId: string, request: FigmaLinksRequest): Promise<FigmaLinksResponse>     // E17
  links(projectId: string, query: FigmaLinksQuery): Promise<FigmaLinksListResponse>           // E18
  uploadScreenshot(projectId: string, upload: ScreenshotUpload): Promise<FigmaScreenshotUploadResponse> // E19
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

export function screenshotForm(upload: ScreenshotUpload): FormData {
  const form = new FormData()
  // .slice(): a Uint8Array over a shared or offset buffer is not a BlobPart for TypeScript ≥ 5.7, and the copy
  // never sends bytes outside the view.
  form.append("image", new Blob([upload.image.slice()], { type: upload.contentType }), upload.fileName)
  form.append("meta", new Blob([JSON.stringify(upload.meta)], { type: "application/json" }), "meta.json")
  return form
}

export function createFigmaApi(client: ApiClient): FigmaApi {
  return {
    meta: () => client.request<FigmaMetaResponse>("GET", "/figma/meta", { auth: false }),
    // Sign-in reports a 429 at once instead of waiting up to a minute behind "Starting sign-in…".
    createSession: () => client.request<FigmaCreateSessionResponse>("POST", "/figma/auth/sessions", { auth: false, json: {}, retry: "none" }),
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
    // E14 is an upsert and E17 sets and deletes rows by node id, so both are idempotent: a lost answer is retried
    // once like a read. E16 deletes and stays at the 429-only default.
    registerFile: (projectId, request) =>
      client.request<FigmaFile>("PUT", projectPath(projectId, "/files"), {
        json: request.file_name === undefined ? { url: request.url } : { url: request.url, file_name: request.file_name },
        retry: "read",
      }),
    files: (projectId) => client.request<FigmaFilesResponse>("GET", projectPath(projectId, "/files")),
    deleteFile: async (projectId, fileKey) => {
      await client.request<unknown>("DELETE", projectPath(projectId, "/files/" + segment(fileKey)))
    },
    upsertLinks: (projectId, request) =>
      client.request<FigmaLinksResponse>("PUT", projectPath(projectId, "/links"), {
        json: { file_key: request.file_key, upserts: request.upserts, removed_node_ids: request.removed_node_ids },
        retry: "read",
      }),
    links: (projectId, query) =>
      client.request<FigmaLinksListResponse>("GET", projectPath(projectId, "/links"), {
        query: {
          file_key: query.file_key ?? null,
          frame_id: query.frame_id ?? null,
          page_id: query.page_id ?? null,
          key_id: query.key_id ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit ?? null,
        },
      }),
    // Uploads are never retried by the client (§7.20): the upload queue honours 429 Retry-After itself. The client
    // gives multipart requests the 60 s upload timeout.
    uploadScreenshot: (projectId, upload) =>
      client.request<FigmaScreenshotUploadResponse>("POST", projectPath(projectId, "/screenshots"), { form: screenshotForm(upload), retry: "none" }),
  }
}
