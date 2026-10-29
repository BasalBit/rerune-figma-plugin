export type TranslationContent = { value: string; message?: MessageValue }
export type MessageValue = { parts: MessagePart[] }
export type MessagePart = { text?: string; arg?: MessageArg; variant?: VariantBlock }
export type MessageArg = { name: string; kind?: string; style?: string }
export type VariantKind = "plural" | "select" | "choice"
export type VariantForm = { selector: string; parts: MessagePart[]; order: number }
export type VariantBlock = { kind: VariantKind; variable: string; offset?: number; forms: VariantForm[] }

export type ErrorReason =
  | "max_length_exceeded"
  | "plugin_token_invalid"
  | "session_token_required"
  | "not_a_plugin_token"
  | "pairing_code_invalid"
  | "pairing_session_not_found"
  | "pairing_session_expired"
  | "pairing_session_already_used"
  | "app_token_not_found"
  | "unknown_language"
  | "unknown_variation_option"
  | "invalid_figma_url"
  | "figma_file_not_found"
  | "ambiguous_project"
  | "design_storage_disabled"
  | "design_storage_failed"
  | "screenshot_limit_reached"
  | "invalid_image"
  | "screenshot_not_found"

export const ERROR_REASONS: readonly ErrorReason[] = [
  "max_length_exceeded",
  "plugin_token_invalid",
  "session_token_required",
  "not_a_plugin_token",
  "pairing_code_invalid",
  "pairing_session_not_found",
  "pairing_session_expired",
  "pairing_session_already_used",
  "app_token_not_found",
  "unknown_language",
  "unknown_variation_option",
  "invalid_figma_url",
  "figma_file_not_found",
  "ambiguous_project",
  "design_storage_disabled",
  "design_storage_failed",
  "screenshot_limit_reached",
  "invalid_image",
  "screenshot_not_found",
]

export interface ErrorResponse { message: string; reason?: ErrorReason }

export type PushItemReason =
  | "duplicate_key"
  | "quota_exceeded"
  | "invalid_key_name"
  | "invalid_text"
  | "key_disabled"
  | "max_length_exceeded"
  | "invalid_placeholder"
  | "key_not_found"
  | "not_a_text_key"
  | "structured_source"
  | "source_changed"
  | "internal_error"

export const PUSH_ITEM_REASONS: readonly PushItemReason[] = [
  "duplicate_key",
  "quota_exceeded",
  "invalid_key_name",
  "invalid_text",
  "key_disabled",
  "max_length_exceeded",
  "invalid_placeholder",
  "key_not_found",
  "not_a_text_key",
  "structured_source",
  "source_changed",
  "internal_error",
]

export type KeyType = "key" | "object" | "array"
export type PublicationStatus = "unpublished" | "published" | "modified"
export type FigmaResolveSource = "draft" | "published"
export type FigmaSearchMatch = "exact_key" | "exact_text" | "partial"
export type FigmaPairingStatus = "pending" | "approved" | "denied"
export type FigmaPushOperation = "create" | "update"
export type FigmaPushStatus = "created" | "updated" | "unchanged" | "conflict" | "failed"

export interface FigmaPlaceholder { name: string; type: string; format: string }

export interface FigmaMetaResponse {
  api_version: number
  screenshots_enabled: boolean
  max_image_bytes: number
  max_image_side: number
  max_batch_size: number
  server_time: string
  // Screenshot freshness: E19 boxes take `text`, E20 filters `refresh_requested`, E24–E26 exist. Absent on older
  // servers (read as false).
  screenshot_freshness: boolean
}

export type FigmaCreateSessionRequest = Record<string, never>

export interface FigmaCreateSessionResponse {
  session_id: string
  code: string
  poll_secret: string
  approve_url: string
  expires_at: string
  interval_seconds: number
}

export interface FigmaPollRequest { poll_secret: string }

export interface FigmaPairedUser { id: string; email: string; first_name: string; last_name: string }

export interface FigmaPollPending { status: "pending"; expires_at: string; interval_seconds: number }
export interface FigmaPollApproved {
  status: "approved"
  token: string
  token_id: string
  token_expires_at: string
  user: FigmaPairedUser
}
export interface FigmaPollDenied { status: "denied" }
export type FigmaPollResponse = FigmaPollPending | FigmaPollApproved | FigmaPollDenied

export interface FigmaPairingCodeResponse {
  code: string
  status: FigmaPairingStatus
  created_at: string
  expires_at: string
  same_network: boolean
  decided_by_you: boolean
}

export interface FigmaPairingDecisionResponse { code: string; status: "approved" | "denied" }

export type FigmaLogoutRequest = Record<string, never>

export interface FigmaUser {
  id: string
  email: string
  first_name: string
  last_name: string
  sandbox_expires_at: string | null
}

export interface FigmaOrganisationRef { id: string; name: string }

export interface FigmaLanguage {
  code: string
  name: string
  main: boolean
  rtl_writing: boolean
  inherits_from: string[]
}

export interface FigmaVariationOption { id: string; value: string }

export interface FigmaProject {
  id: string
  name: string
  organisation: FigmaOrganisationRef
  main_language: string
  languages: FigmaLanguage[]
  variation_options: FigmaVariationOption[]
  permissions: string[]
}

export interface FigmaProjectsResponse { user: FigmaUser; projects: FigmaProject[] }

export interface FigmaProjectDetail extends FigmaProject {
  key_count: number
  available_keys: number | null
  key_name_sample: string[]
}

export interface FigmaSearchItem {
  id: string
  key: string
  match: FigmaSearchMatch
  main_content: TranslationContent
  description: string
  tags: string[]
  max_length: number | null
  placeholders: FigmaPlaceholder[]
  status: PublicationStatus
  updated_at: string
}

export interface FigmaSearchResponse { items: FigmaSearchItem[]; next_cursor: string | null; has_more: boolean }

export interface FigmaByNameRequest { names?: string[]; texts?: string[] }

export interface FigmaKeyRef { id: string; key: string }

export interface FigmaByNameKey { id: string; key: string; type: KeyType; main_content: TranslationContent }

export interface FigmaTextMatch { text: string; keys: FigmaKeyRef[] }

export interface FigmaByNameResponse {
  keys: FigmaByNameKey[]
  missing: string[]
  text_matches: FigmaTextMatch[]
}

export interface FigmaResolveRequest {
  key_ids: string[]
  languages: string[]
  source: FigmaResolveSource
  variation_option_id: string | null
}

export interface FigmaResolvedValue {
  lang: string
  present: boolean
  resolved_lang: string
  inherited: boolean
  variation_applied: boolean
  content: TranslationContent | null
  length: number
  exceeds_max_length: boolean
}

export interface FigmaResolvedKey {
  id: string
  key: string
  type: KeyType
  enabled: boolean
  status: PublicationStatus
  published: boolean
  description: string
  tags: string[]
  max_length: number | null
  placeholders: FigmaPlaceholder[]
  values: FigmaResolvedValue[]
}

export interface FigmaResolveResponse {
  source: FigmaResolveSource
  variation_option: FigmaVariationOption | null
  keys: FigmaResolvedKey[]
  missing_key_ids: string[]
}

export interface PushCreateItemWire {
  client_ref: string
  op: "create"
  key: string
  text: string
  description: string
  max_length: number | null
}

export interface PushUpdateItemWire {
  client_ref: string
  op: "update"
  key_id: string
  text: string
  expected_text: string
}

export type PushItemWire = PushCreateItemWire | PushUpdateItemWire

export interface FigmaPushRequest { file_key: string | null; items: PushItemWire[] }

export interface FigmaPushResult {
  client_ref: string
  status: FigmaPushStatus
  key_id: string | null
  key: string | null
  reason: PushItemReason | null
  message: string | null
  current_text: string | null
}

export interface FigmaPushSummary { created: number; updated: number; unchanged: number; conflicts: number; failed: number }

export interface FigmaPushResponse {
  results: FigmaPushResult[]
  summary: FigmaPushSummary
  available_keys: number | null
}

// Phase 2: files and links (E14–E18).

export interface FigmaRegisterFileRequest { url: string; file_name?: string }

export interface FigmaFileUserRef { id: string; name: string }

export interface FigmaFile {
  file_key: string
  file_name: string
  url: string
  link_count: number
  screenshot_count: number
  last_push_at: string | null
  last_push_by: FigmaFileUserRef | null
  created_at: string
  updated_at: string
  outdated_screenshot_count: number   // screenshots of the file with at least one outdated box
  refresh_requested_count: number     // screenshots of the file with a refresh request
}

export interface FigmaFilesResponse { files: FigmaFile[] }

export interface FigmaLinkUpsert {
  node_id: string
  key_id: string
  frame_id: string
  frame_name: string
  page_id: string
  page_name: string
  node_name: string
}

export interface FigmaLinksRequest { file_key: string; upserts: FigmaLinkUpsert[]; removed_node_ids: string[] }

export type FigmaLinkRejectReason = "key_not_found" | "not_a_text_key"

export const FIGMA_LINK_REJECT_REASONS: readonly FigmaLinkRejectReason[] = ["key_not_found", "not_a_text_key"]

export interface FigmaLinkRejection { node_id: string; reason: FigmaLinkRejectReason }

export interface FigmaLinksResponse { upserted: number; removed: number; rejected: FigmaLinkRejection[] }

export interface FigmaLink {
  node_id: string
  key_id: string
  key: string
  file_key: string
  frame_id: string
  frame_name: string
  page_id: string
  page_name: string
  node_name: string
  figma_url: string
  updated_at: string
}

export interface FigmaLinksQuery {
  file_key?: string | null
  frame_id?: string | null
  page_id?: string | null
  key_id?: string | null
  cursor?: string | null
  limit?: number | null
}

export interface FigmaLinksListResponse { links: FigmaLink[]; next_cursor: string | null; has_more: boolean }

// Phase 2: screenshots (E19; FigmaScreenshot is shared by E19–E22).

// Whether a stored box's captured text equals the key's draft main-language text (computed by the server).
export type FigmaTextStatus = "current" | "outdated" | "unknown"

export const FIGMA_TEXT_STATUSES: readonly FigmaTextStatus[] = ["current", "outdated", "unknown"]

// E19 meta box; `text` is sent only to a server with E1 screenshot_freshness.
export interface FigmaScreenshotBox { key_id: string; node_id: string; x: number; y: number; w: number; h: number; text?: string }

// A stored box as E19–E22 return it.
export interface FigmaStoredScreenshotBox {
  key_id: string
  node_id: string
  x: number
  y: number
  w: number
  h: number
  text: string | null
  text_status: FigmaTextStatus
}

// The `meta` part of the E19 multipart upload (strict JSON on the server).
export interface FigmaScreenshotMeta {
  file_key: string
  frame_id: string
  frame_name: string
  page_id: string
  page_name: string
  width: number
  height: number
  boxes: FigmaScreenshotBox[]
}

export type FigmaScreenshotContentType = "image/jpeg" | "image/png"

export interface FigmaScreenshot {
  id: string
  file_key: string
  frame_id: string
  frame_name: string
  page_id: string
  page_name: string
  content_type: FigmaScreenshotContentType
  width: number
  height: number
  size_bytes: number
  boxes: FigmaStoredScreenshotBox[]
  image_url: string | null
  image_url_expires_at: string | null
  figma_url: string | null
  created_at: string
  updated_at: string
  outdated_box_count: number                       // over all stored boxes, also when `boxes` is filtered to one key
  refresh_requested_at: string | null
  refresh_requested_by: FigmaFileUserRef | null    // null: no request, or the user no longer exists
}

export type FigmaDroppedBoxReason = "out_of_bounds" | "invalid_node_id" | "key_not_found"

export const FIGMA_DROPPED_BOX_REASONS: readonly FigmaDroppedBoxReason[] = ["out_of_bounds", "invalid_node_id", "key_not_found"]

export interface FigmaDroppedBox { node_id: string; key_id: string; reason: FigmaDroppedBoxReason }

export interface FigmaScreenshotUploadResponse {
  screenshot: FigmaScreenshot
  unchanged_image: boolean
  dropped_boxes: FigmaDroppedBox[]
}

// Phase 2: screenshot list and URL, key design, URL keys (E20–E23). The plugin does not call these yet; they are
// typed so the wire contract of §4 is complete in one place.

export interface FigmaScreenshotsQuery {
  file_key?: string | null
  frame_id?: string | null
  key_id?: string | null
  refresh_requested?: boolean | null   // sent as "true" / "false"; absent: no filter
  cursor?: string | null
  limit?: number | null
}

// E20: with `key_id`, each screenshot's boxes are those of that key.
export interface FigmaScreenshotsResponse { screenshots: FigmaScreenshot[]; next_cursor: string | null; has_more: boolean }

// E24 (request a new screenshot of one frame): `created` is false when it was already requested; the response then
// carries that first request.
export interface FigmaRefreshRequestResponse {
  screenshot_id: string
  refresh_requested_at: string
  refresh_requested_by: FigmaFileUserRef | null
  created: boolean
}

// E26 (request new screenshots of every outdated frame of a file).
export interface FigmaFileRefreshResponse { outdated: number; requested: number; already_requested: number }

// E21: a fresh signed URL for one screenshot.
export interface FigmaScreenshotUrlResponse { image_url: string; image_url_expires_at: string }

// E22: a key's links carry no key fields (they are all this key's).
export interface FigmaKeyDesignLink {
  node_id: string
  file_key: string
  frame_id: string
  frame_name: string
  page_id: string
  page_name: string
  node_name: string
  figma_url: string
  updated_at: string
}

export interface FigmaKeyDesignResponse {
  key_id: string
  storage_enabled: boolean
  links: FigmaKeyDesignLink[]
  screenshots: FigmaScreenshot[]
}

export interface FigmaUrlKeysQuery {
  figma_url: string
  project_id?: string | null
  source?: FigmaResolveSource | null
  languages?: string | null      // comma-separated project language codes, ≤ 20
}

// E23 node matching: frame, node or page id; the whole file when the URL has no node id; none when nothing matched.
export type FigmaUrlKeysMatch = "frame" | "node" | "page" | "file" | "none"

export const FIGMA_URL_KEYS_MATCHES: readonly FigmaUrlKeysMatch[] = ["frame", "node", "page", "file", "none"]

export interface FigmaUrlKey {
  key_id: string
  key: string
  node_ids: string[]
  frame_names: string[]
  status: PublicationStatus
  description: string
  max_length: number | null
  placeholders: FigmaPlaceholder[]
  values: FigmaResolvedValue[]
}

export interface FigmaUrlKeysResponse {
  project_id: string
  file_key: string
  node_id: string | null
  matched: FigmaUrlKeysMatch
  source: FigmaResolveSource
  truncated: boolean
  keys: FigmaUrlKey[]
}
