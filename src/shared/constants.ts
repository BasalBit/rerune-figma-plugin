import type { CaseStyle } from "./messages"

export const PLUGIN_DATA_NAMESPACE = "rerune"

export const DATA_KEYS = {
  link: "link",
  preview: "preview",
  diag: "diag",
  langCopy: "langCopy",
  file: "file",
} as const

export const PLUGIN_DATA_VERSION = 1
export const LINK_TOMBSTONE = '{"v":1,"none":true}'
export const DATA_TOMBSTONE = LINK_TOMBSTONE

export const RELAUNCH_COMMAND = "open"
export const RELAUNCH_DESCRIPTION_PREFIX = "ReRune key: "
export const RELAUNCH_DESCRIPTION_MAX_CHARS = 1000
export const NOTIFY_MAX_CHARS = 100

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
export const PAIRING_CODE_LENGTH = 6

export const STORAGE_KEYS = {
  auth: "rerune.auth.v1",
  prefs: "rerune.prefs.v1",
  codegenPrefix: "rerune.codegen.v1.",
  codegenIndex: "rerune.codegen.v1.index",
} as const

export const CODEGEN_CACHE_MAX_ENTRIES = 2000
export const CODEGEN_CACHE_MAX_PROJECTS = 10
export const CODEGEN_SOURCE_TEXT_MAX_CHARS = 60
export const CODEGEN_MAX_KEYS = 50
export const CODEGEN_WALK_BUDGET_MS = 1500

export const SCAN_MAX_NODES = 5000
export const SCAN_BATCH_SIZE = 100
export const SCAN_YIELD_EVERY_ROOTS = 25
export const SCAN_YIELD_EVERY_CHILDREN = 10
export const SCAN_YIELD_EVERY_TEXTS = 200

export const MAX_BATCH_SIZE = 100
export const PUSH_CHUNK_SIZE = 100
export const RESOLVE_CHUNK_SIZE = 100
export const MAX_REQUESTS_IN_FLIGHT = 4
export const BY_NAME_TEXT_MAX_UTF16 = 5000
export const SEARCH_DEBOUNCE_MS = 250
export const SEARCH_QUERY_MAX_RUNES = 100
export const SEARCH_PAGE_SIZE = 20
export const INSPECT_CONTAINER_MAX_NODES = 50

export const KEY_NAME_SUGGESTED_MAX_CHARS = 64
export const KEY_NAME_SERVER_MAX_CHARS = 200
export const FIGMA_KEY_TAG = "figma"

export const PREVIEW_SEGMENTS_MAX_JSON_CHARS = 90000
export const PLUGIN_DATA_MAX_BYTES = 100000
export const WRITE_YIELD_EVERY = 10
export const DIAGNOSTICS_MAX_NODES = 500
export const DIAGNOSTICS_MAX_FRAMES = 100

export const MAX_IMAGE_UPLOAD_BYTES = 2000000
export const MAX_IMAGE_SIDE = 4096
export const SCREENSHOT_MAX_BOXES = 500              // E19 accepts at most 500 boxes per image
export const SCREENSHOT_SIZE_TOLERANCE_PX = 2        // §7.16: rescale boxes when the decoded image differs by more
export const SCREENSHOT_NAME_MAX_RUNES = 200         // frame and page names are cut to 200 runes on the server (§4.0)
export const SCREENSHOT_RATE_LIMIT_RETRIES = 2       // 429 waits per frame before the upload queue stops
export const SCREENSHOT_EXPORT_IDLE_MS = 120000      // one frame export (with re-exports) per request
export const SCREENSHOT_TEXT_MAX_UTF16 = 5000        // a box's captured text; longer layers send none (server: ≤ 5,000 runes)
export const SCREENSHOT_META_MAX_BYTES = 900000      // the E19 meta part with captured texts, as UTF-8 JSON
export const REFRESH_REQUESTS_PAGE_SIZE = 100        // E20 page size for the frames ReRune asks new screenshots of
export const REFRESH_REQUESTS_MAX = 1000             // requested frames the plugin reads per file

export const REQUEST_TIMEOUT_MS = 30000
export const UPLOAD_TIMEOUT_MS = 60000
export const RETRY_AFTER_MAX_SECONDS = 60
export const PAIRING_RETRY_AFTER_DEFAULT_SECONDS = 10
export const PAIRING_NETWORK_BACKOFF_MS = [2000, 4000, 8000] as const
export const PAIRING_NETWORK_BACKOFF_MAX_MS = 10000

export const UI_READY_RETRY_MS = 400
export const REQUEST_IDLE_TIMEOUT_MS = 30000

export const DESIGN_UI_SIZE = { width: 400, height: 640 } as const
export const DESIGN_UI_MIN_SIZE = { width: 360, height: 480 } as const
export const DESIGN_UI_MAX_SIZE = { width: 800, height: 1000 } as const
export const INSPECT_UI_SIZE = { width: 300, height: 480 } as const
export const INSPECT_UI_MIN_SIZE = { width: 300, height: 200 } as const

export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/

export const CASE_STYLES: readonly CaseStyle[] = [
  "auto",
  "snake",
  "camel",
  "kebab",
  "pascal",
  "screaming",
  "dot.snake",
  "dot.camel",
  "dot.kebab",
  "slash.snake",
]

export const DEFAULT_FILE_SETTINGS_OPTIONS = {
  keyTemplate: null,
  caseStyle: "auto",
  ignoreUnderscoreLayers: true,
  includeLocked: false,
} as const
