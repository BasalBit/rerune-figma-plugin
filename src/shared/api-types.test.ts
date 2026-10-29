import { describe, expect, it } from "vitest"
import {
  ERROR_REASONS,
  FIGMA_DROPPED_BOX_REASONS,
  FIGMA_LINK_REJECT_REASONS,
  FIGMA_TEXT_STATUSES,
  FIGMA_URL_KEYS_MATCHES,
  PUSH_ITEM_REASONS,
  type FigmaFileRefreshResponse,
  type FigmaRefreshRequestResponse,
  type FigmaTextStatus,
  type FigmaKeyDesignResponse,
  type FigmaScreenshotsQuery,
  type FigmaScreenshotsResponse,
  type FigmaScreenshotUrlResponse,
  type FigmaUrlKeysMatch,
  type FigmaUrlKeysQuery,
  type FigmaUrlKeysResponse,
  type ErrorReason,
  type FigmaDroppedBoxReason,
  type FigmaFile,
  type FigmaFilesResponse,
  type FigmaLinkRejectReason,
  type FigmaLinksListResponse,
  type FigmaLinksRequest,
  type FigmaLinksResponse,
  type FigmaRegisterFileRequest,
  type FigmaScreenshot,
  type FigmaScreenshotMeta,
  type FigmaScreenshotUploadResponse,
  type FigmaByNameRequest,
  type FigmaByNameResponse,
  type FigmaCreateSessionResponse,
  type FigmaMetaResponse,
  type FigmaPairingCodeResponse,
  type FigmaPairingDecisionResponse,
  type FigmaPollResponse,
  type FigmaProjectDetail,
  type FigmaProjectsResponse,
  type FigmaPushRequest,
  type FigmaPushResponse,
  type FigmaResolveRequest,
  type FigmaResolveResponse,
  type FigmaSearchResponse,
  type PushItemReason,
  type TranslationContent,
} from "./api-types"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const errorReasonsComplete: Equal<(typeof ERROR_REASONS)[number], ErrorReason> = true
const pushReasonsComplete: Equal<(typeof PUSH_ITEM_REASONS)[number], PushItemReason> = true
const linkRejectReasonsComplete: Equal<(typeof FIGMA_LINK_REJECT_REASONS)[number], FigmaLinkRejectReason> = true
const droppedBoxReasonsComplete: Equal<(typeof FIGMA_DROPPED_BOX_REASONS)[number], FigmaDroppedBoxReason> = true

const meta: FigmaMetaResponse = {
  api_version: 1,
  screenshots_enabled: false,
  max_image_bytes: 2097152,
  max_image_side: 4096,
  max_batch_size: 100,
  server_time: "2026-10-27T10:00:00Z",
  screenshot_freshness: true,
}

const session: FigmaCreateSessionResponse = {
  session_id: "671e2a9f4c1d2b3a4f5e6d7c",
  code: "K7P-4QX",
  poll_secret: "3f1c9a",
  approve_url: "https://rerune.io/figma/connect?code=K7P-4QX",
  expires_at: "2026-10-27T10:10:00Z",
  interval_seconds: 2,
}

const polls: FigmaPollResponse[] = [
  { status: "pending", expires_at: "2026-10-27T10:10:00Z", interval_seconds: 2 },
  {
    status: "approved",
    token: "rrf_0b4c",
    token_id: "671e2b114c1d2b3a4f5e6d7d",
    token_expires_at: "2027-01-25T10:01:12Z",
    user: { id: "kc-sub-uuid", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
  },
  { status: "denied" },
]

const codeInfo: FigmaPairingCodeResponse = {
  code: "K7P-4QX",
  status: "pending",
  created_at: "2026-10-27T10:00:00Z",
  expires_at: "2026-10-27T10:10:00Z",
  same_network: true,
  decided_by_you: false,
}

const decision: FigmaPairingDecisionResponse = { code: "K7P-4QX", status: "approved" }

const projects: FigmaProjectsResponse = {
  user: { id: "kc-sub-uuid", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", sandbox_expires_at: null },
  projects: [
    {
      id: "6a4600000000000000000c35",
      name: "Chapter",
      organisation: { id: "6a4000000000000000000b11", name: "Ada's Private Org" },
      main_language: "en",
      languages: [
        { code: "en", name: "English", main: true, rtl_writing: false, inherits_from: [] },
        { code: "de-AT", name: "German (Austria)", main: false, rtl_writing: false, inherits_from: ["de"] },
      ],
      variation_options: [{ id: "6a4700000000000000000a01", value: "vip" }],
      permissions: ["edit_keys", "publishing"],
    },
  ],
}

const detail: FigmaProjectDetail = { ...projects.projects[0], key_count: 88, available_keys: null, key_name_sample: ["checkout_pay_button"] }

const search: FigmaSearchResponse = {
  items: [
    {
      id: "6a4800000000000000000001",
      key: "checkout_pay_button",
      match: "exact_text",
      main_content: { value: "Pay now" },
      description: "Checkout",
      tags: ["figma"],
      max_length: null,
      placeholders: [],
      status: "published",
      updated_at: "2026-10-20T09:00:00Z",
    },
  ],
  next_cursor: null,
  has_more: false,
}

const byNameRequest: FigmaByNameRequest = { names: ["checkout_pay_button", "missing_one"], texts: ["Pay now"] }

const byName: FigmaByNameResponse = {
  keys: [{ id: "6a4800000000000000000001", key: "checkout_pay_button", type: "key", main_content: { value: "Pay now" } }],
  missing: ["missing_one"],
  text_matches: [{ text: "Pay now", keys: [{ id: "6a4800000000000000000001", key: "checkout_pay_button" }] }],
}

const resolveRequest: FigmaResolveRequest = { key_ids: ["6a4800000000000000000001"], languages: ["de-AT", "en"], source: "draft", variation_option_id: null }

const resolved: FigmaResolveResponse = {
  source: "draft",
  variation_option: { id: "6a4700000000000000000a01", value: "vip" },
  keys: [
    {
      id: "6a4800000000000000000001",
      key: "checkout_pay_button",
      type: "key",
      enabled: true,
      status: "modified",
      published: true,
      description: "Checkout",
      tags: ["figma"],
      max_length: 20,
      placeholders: [{ name: "amount", type: "string", format: "" }],
      values: [
        { lang: "de-AT", present: true, resolved_lang: "de", inherited: true, variation_applied: false, content: { value: "Jetzt zahlen" }, length: 12, exceeds_max_length: false },
        { lang: "fr", present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false },
      ],
    },
  ],
  missing_key_ids: [],
}

const pushRequest: FigmaPushRequest = {
  file_key: null,
  items: [
    { client_ref: "c0", op: "create", key: "checkout_pay_button", text: "Pay now", description: "Checkout", max_length: null },
    { client_ref: "u6a4800000000000000000002", op: "update", key_id: "6a4800000000000000000002", text: "Pay securely", expected_text: "Pay now" },
  ],
}

const pushResponse: FigmaPushResponse = {
  results: [
    { client_ref: "c0", status: "created", key_id: "6a4800000000000000000003", key: "checkout_pay_button", reason: null, message: null, current_text: null },
    {
      client_ref: "u6a4800000000000000000002",
      status: "conflict",
      key_id: "6a4800000000000000000002",
      key: "checkout_title",
      reason: "source_changed",
      message: "The source text changed in ReRune.",
      current_text: "Pay safely",
    },
  ],
  summary: { created: 1, updated: 0, unchanged: 0, conflicts: 1, failed: 0 },
  available_keys: 911,
}

const structured: TranslationContent = {
  value: "",
  message: {
    parts: [
      { text: "You have " },
      {
        variant: {
          kind: "plural",
          variable: "count",
          offset: 0,
          forms: [
            { selector: "one", parts: [{ text: "# item" }], order: 0 },
            { selector: "other", parts: [{ arg: { name: "count", kind: "number" } }, { text: " items" }], order: 1 },
          ],
        },
      },
    ],
  },
}

// Phase 2 examples (E14–E18), as written in §4.
const registerFile: FigmaRegisterFileRequest = { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=0-1", file_name: "Chapter" }

const file: FigmaFile = {
  file_key: "AbCdEf1234567890XyZ",
  file_name: "Chapter",
  url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter",
  link_count: 0,
  screenshot_count: 0,
  last_push_at: null,
  last_push_by: null,
  created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  outdated_screenshot_count: 0,
  refresh_requested_count: 0,
}

const files: FigmaFilesResponse = { files: [file, { ...file, last_push_at: "2026-10-27T11:00:00Z", last_push_by: { id: "kc-sub", name: "Ada Lovelace" } }] }

const linksRequest: FigmaLinksRequest = {
  file_key: "AbCdEf1234567890XyZ",
  upserts: [{ node_id: "12:345", key_id: "6a4800000000000000000001", frame_id: "10:1", frame_name: "Checkout", page_id: "0:1", page_name: "Mobile", node_name: "Pay button" }],
  removed_node_ids: ["12:999"],
}

const linksResponse: FigmaLinksResponse = { upserted: 1, removed: 1, rejected: [{ node_id: "12:346", reason: "key_not_found" }] }

const linksList: FigmaLinksListResponse = {
  links: [
    {
      node_id: "12:345",
      key_id: "6a4800000000000000000001",
      key: "checkout_pay_button",
      file_key: "AbCdEf1234567890XyZ",
      frame_id: "10:1",
      frame_name: "Checkout",
      page_id: "0:1",
      page_name: "Mobile",
      node_name: "Pay button",
      figma_url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=10-1",
      updated_at: "2026-10-27T10:00:00Z",
    },
  ],
  next_cursor: null,
  has_more: false,
}

// Phase 2 examples (E19), as written in §4.
const screenshotMeta: FigmaScreenshotMeta = {
  file_key: "AbCdEf1234567890XyZ",
  frame_id: "10:1",
  frame_name: "Checkout",
  page_id: "0:1",
  page_name: "Mobile",
  width: 1170,
  height: 2532,
  boxes: [{ key_id: "6a4800000000000000000001", node_id: "12:345", x: 24, y: 310, w: 200, h: 40 }],
}

const screenshot: FigmaScreenshot = {
  id: "6a4900000000000000000a01",
  file_key: "AbCdEf1234567890XyZ",
  frame_id: "10:1",
  frame_name: "Checkout",
  page_id: "0:1",
  page_name: "Mobile",
  content_type: "image/jpeg",
  width: 1170,
  height: 2532,
  size_bytes: 184233,
  boxes: [{ key_id: "6a4800000000000000000001", node_id: "12:345", x: 24, y: 310, w: 200, h: 40, text: null, text_status: "unknown" }],
  image_url: "https://designs.rerune.io/projects/6a46/screenshots/6a49/6a4a.jpg?token=HS256-x&expires=1761562800",
  image_url_expires_at: "2026-10-27T11:00:00Z",
  figma_url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=10-1",
  created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  outdated_box_count: 0,
  refresh_requested_at: null,
  refresh_requested_by: null,
}

const screenshotUpload: FigmaScreenshotUploadResponse = {
  screenshot,
  unchanged_image: false,
  dropped_boxes: [{ node_id: "12:346", key_id: "6a4800000000000000000009", reason: "key_not_found" }],
}

// Phase 2 examples (E20–E23), as written in §4.
const screenshotsQuery: FigmaScreenshotsQuery = { file_key: "AbCdEf1234567890XyZ", frame_id: "10:1", key_id: "6a4800000000000000000001", cursor: null, limit: 50 }

const screenshots: FigmaScreenshotsResponse = { screenshots: [screenshot], next_cursor: null, has_more: false }

const screenshotUrl: FigmaScreenshotUrlResponse = { image_url: screenshot.image_url ?? "", image_url_expires_at: "2026-10-27T11:00:00Z" }

const keyDesign: FigmaKeyDesignResponse = {
  key_id: "6a4800000000000000000001",
  storage_enabled: true,
  links: [
    {
      node_id: "12:345",
      file_key: "AbCdEf1234567890XyZ",
      frame_id: "10:1",
      frame_name: "Checkout",
      page_id: "0:1",
      page_name: "Mobile",
      node_name: "Pay button",
      figma_url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=10-1",
      updated_at: "2026-10-27T10:00:00Z",
    },
  ],
  screenshots: [screenshot],
}

const keyDesignOff: FigmaKeyDesignResponse = { ...keyDesign, storage_enabled: false, screenshots: [] }

const urlKeysQuery: FigmaUrlKeysQuery = {
  figma_url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=10-1",
  project_id: null,
  source: "draft",
  languages: "en,de",
}

const urlKeys: FigmaUrlKeysResponse = {
  project_id: "6a4600000000000000000c35",
  file_key: "AbCdEf1234567890XyZ",
  node_id: "10:1",
  matched: "frame",
  source: "draft",
  truncated: false,
  keys: [
    {
      key_id: "6a4800000000000000000001",
      key: "checkout_pay_button",
      node_ids: ["12:345"],
      frame_names: ["Checkout"],
      status: "published",
      description: "Checkout",
      max_length: 20,
      placeholders: [{ name: "amount", type: "string", format: "" }],
      values: [
        { lang: "en", present: true, resolved_lang: "en", inherited: false, variation_applied: false, content: { value: "Pay now" }, length: 7, exceeds_max_length: false },
      ],
    },
  ],
}

const urlKeysFile: FigmaUrlKeysResponse = { ...urlKeys, node_id: null, matched: "file" }

const urlKeysMatchesComplete: Equal<(typeof FIGMA_URL_KEYS_MATCHES)[number], FigmaUrlKeysMatch> = true

// Screenshot freshness examples (E1, E19–E26), as written in the freshness contract (§3.1, §5.2, §5.3).
const freshMeta: FigmaScreenshotMeta = {
  ...screenshotMeta,
  boxes: [
    { key_id: "6a4800000000000000000001", node_id: "12:345", x: 24, y: 310, w: 200, h: 40, text: "Pay now" },
    { key_id: "6a4800000000000000000002", node_id: "12:346", x: 24, y: 360, w: 300, h: 20 },
  ],
}

const freshScreenshot: FigmaScreenshot = {
  ...screenshot,
  boxes: [{ key_id: "6a4800000000000000000001", node_id: "12:345", x: 24, y: 310, w: 200, h: 40, text: "Pay now", text_status: "outdated" }],
  outdated_box_count: 1,
  refresh_requested_at: "2026-10-29T10:00:00Z",
  refresh_requested_by: { id: "kc-sub", name: "Ada Lovelace" },
}

const requestedQuery: FigmaScreenshotsQuery = { file_key: "AbCdEf1234567890XyZ", refresh_requested: true, limit: 100 }

const refreshRequest: FigmaRefreshRequestResponse = {
  screenshot_id: "6a4900000000000000000a01",
  refresh_requested_at: "2026-10-29T10:00:00Z",
  refresh_requested_by: { id: "kc-sub", name: "Ada Lovelace" },
  created: true,
}

const fileRefresh: FigmaFileRefreshResponse = { outdated: 4, requested: 3, already_requested: 1 }

const freshFile: FigmaFile = { ...file, outdated_screenshot_count: 4, refresh_requested_count: 3 }

const statusesComplete: Equal<(typeof FIGMA_TEXT_STATUSES)[number], FigmaTextStatus> = true

describe("wire types (screenshot freshness)", () => {
  it("accept the contract examples", () => {
    const examples = [freshMeta, freshScreenshot, requestedQuery, refreshRequest, fileRefresh, freshFile]
    expect(JSON.parse(JSON.stringify(examples))).toEqual(examples)
  })

  it("list every text status, as the server spells them", () => {
    expect(statusesComplete).toBe(true)
    expect(FIGMA_TEXT_STATUSES).toEqual(["current", "outdated", "unknown"])
  })
})

describe("wire types (§4, E20–E23)", () => {
  it("accept the spec examples", () => {
    const examples = [screenshotsQuery, screenshots, screenshotUrl, keyDesign, keyDesignOff, urlKeysQuery, urlKeys, urlKeysFile]
    expect(JSON.parse(JSON.stringify(examples))).toEqual(examples)
  })

  it("list every E23 match", () => {
    expect(urlKeysMatchesComplete).toBe(true)
    expect([...FIGMA_URL_KEYS_MATCHES].sort()).toEqual(["file", "frame", "node", "none", "page"])
  })
})

describe("wire types (§4, E19)", () => {
  it("accept the spec examples", () => {
    const examples = [screenshotMeta, screenshot, screenshotUpload]
    expect(JSON.parse(JSON.stringify(examples))).toEqual(examples)
  })

  it("list every dropped-box reason", () => {
    expect(droppedBoxReasonsComplete).toBe(true)
    expect([...FIGMA_DROPPED_BOX_REASONS].sort()).toEqual(["invalid_node_id", "key_not_found", "out_of_bounds"])
  })
})

describe("wire types (§4, E14–E18)", () => {
  it("accept the spec examples", () => {
    const examples = [registerFile, file, files, linksRequest, linksResponse, linksList]
    expect(JSON.parse(JSON.stringify(examples))).toEqual(examples)
  })

  it("list both E17 rejection reasons", () => {
    expect(linkRejectReasonsComplete).toBe(true)
    expect([...FIGMA_LINK_REJECT_REASONS].sort()).toEqual(["key_not_found", "not_a_text_key"])
  })
})

describe("wire types (§4, E1–E13)", () => {
  it("accept the spec examples", () => {
    const examples = [meta, session, polls, codeInfo, decision, projects, detail, search, byNameRequest, byName, resolveRequest, resolved, pushRequest, pushResponse, structured]
    expect(JSON.parse(JSON.stringify(examples))).toEqual(examples)
  })

  it("list every error reason of Appendix B.1", () => {
    expect(errorReasonsComplete).toBe(true)
    expect(ERROR_REASONS).toHaveLength(19)
    expect(new Set(ERROR_REASONS).size).toBe(ERROR_REASONS.length)
  })

  it("list every push item reason of Appendix B.2", () => {
    expect(pushReasonsComplete).toBe(true)
    expect(PUSH_ITEM_REASONS).toHaveLength(12)
    expect(new Set(PUSH_ITEM_REASONS).size).toBe(PUSH_ITEM_REASONS.length)
  })
})
