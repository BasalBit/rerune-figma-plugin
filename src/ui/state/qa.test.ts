import { describe, expect, it, vi } from "vitest"
import { keyId, linkedNode, PROJECT_ID, scannedNode } from "../../../test/fixtures"
import type { FigmaResolvedKey, FigmaResolveRequest, FigmaResolveResponse } from "../../shared/api-types"
import type { NodeError, ScannedNode, Scope, UiToMain } from "../../shared/messages"
import { LANGUAGE_COPY_MESSAGES } from "../../shared/node-errors"
import type { OverflowItem } from "../../shared/overflow"
import { pseudoLocalize } from "../../shared/pseudo"
import { ApiError } from "../api/client"
import { createUiBus } from "../bus"
import { singleFlight, type ScanResult } from "./ops"
import {
  amountText,
  checkOverflow,
  copiesMade,
  CSV_HEADER,
  csvCell,
  kindLabel,
  makeLanguageCopies,
  markPreviewing,
  NO_FRAMES,
  NO_LANGUAGES,
  NO_LAYERS,
  PREVIEWING_FRAMES,
  PREVIEWING_SCOPE,
  PSEUDO_LANGUAGE,
  QaRefusal,
  reportCsv,
  reportIssueCount,
  reportLanguageLabel,
  runOverflowReport,
  selectedFrames,
  unitOf,
  type CopiesDeps,
  type OverflowDeps,
  type OverflowReport,
} from "./qa"
import { fakeBusEnvironment } from "./test-fakes"

// --- fakes -----------------------------------------------------------------------------------------------------

interface FakeMainOptions {
  applyErrors?(message: Extract<UiToMain, { type: "preview-apply" }>): NodeError[]
  overflow?(nodeIds: string[], lang: string): OverflowItem[]
  copies?(message: Extract<UiToMain, { type: "language-copies" }>): { done: number; errors: NodeError[] }
  failApply?(message: Extract<UiToMain, { type: "preview-apply" }>): boolean
}

// A main thread for the QA flows: preview-apply → op-result (remembers the language on the canvas),
// overflow-check → overflow-result, language-copies → op-result.
function fakeMain(options: FakeMainOptions = {}) {
  const sent: UiToMain[] = []
  let canvasLang = ""
  const fake = fakeBusEnvironment((message, deliver) => {
    sent.push(message)
    if (message.type === "preview-apply") {
      canvasLang = message.info.source === "pseudo" ? PSEUDO_LANGUAGE : message.info.lang
      if (options.failApply?.(message) === true) {
        deliver({ type: "handler-error", forType: "preview-apply", requestId: message.requestId, message: "Figma stopped" })
        return
      }
      const errors = options.applyErrors?.(message) ?? []
      deliver({ type: "op-result", requestId: message.requestId, ok: errors.length === 0, done: message.items.length - errors.length, errors })
    } else if (message.type === "overflow-check") {
      deliver({ type: "overflow-result", requestId: message.requestId, items: options.overflow?.(message.nodeIds, canvasLang) ?? [] })
    } else if (message.type === "language-copies") {
      const outcome = options.copies?.(message) ?? { done: message.copies.reduce((sum, copy) => sum + copy.texts.length, 0), errors: [] }
      deliver({ type: "op-result", requestId: message.requestId, ok: outcome.errors.length === 0, done: outcome.done, errors: outcome.errors })
    }
  })
  return { bus: createUiBus(fake.environment), sent }
}

function value(lang: string, text: string | null, extra: Partial<FigmaResolvedKey["values"][number]> = {}): FigmaResolvedKey["values"][number] {
  return text === null
    ? { lang, present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }
    : { lang, present: true, resolved_lang: lang, inherited: false, variation_applied: false, content: { value: text }, length: text.length, exceeds_max_length: false, ...extra }
}

type Catalog = Record<string, { key: string; maxLength?: number; values: Record<string, string | null | { text: string; exceeds: true }> }>

function fakeApi(catalog: Catalog) {
  const requests: FigmaResolveRequest[] = []
  const resolveKeys = vi.fn(async (_projectId: string, body: FigmaResolveRequest): Promise<FigmaResolveResponse> => {
    requests.push(body)
    const lang = body.languages[0]
    return {
      source: body.source,
      variation_option: null,
      missing_key_ids: [],
      keys: body.key_ids
        .filter((id) => catalog[id] !== undefined)
        .map((id) => {
          const entry = catalog[id]
          const raw = entry.values[lang]
          const resolved =
            raw === undefined || raw === null ? value(lang, null)
              : typeof raw === "string" ? value(lang, raw)
                : value(lang, raw.text, { exceeds_max_length: true })
          return {
            id, key: entry.key, type: "key", enabled: true, status: "published", published: true, description: "", tags: [],
            max_length: entry.maxLength ?? null, placeholders: [], values: [resolved],
          } satisfies FigmaResolvedKey
        }),
    }
  })
  return { resolveKeys, requests }
}

function scanOf(nodes: ScannedNode[], scope: Scope = "selection", truncated = false): ScanResult {
  return { scope, nodes, total: nodes.length, truncated, skipped: { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 } }
}

const K1 = keyId(1)
const K2 = keyId(2)
const K3 = keyId(3)

const NODES = [
  linkedNode("1:1", "Pay now", { keyId: K1, keyName: "pay", syncedText: "Pay now" }, { name: "Pay button" }),
  linkedNode("1:2", "Checkout", { keyId: K2, keyName: "title", syncedText: "Checkout" }, { name: "Title" }),
  linkedNode("1:3", "Free shipping", { keyId: K3, keyName: "shipping", syncedText: "Free shipping" }, { name: "Shipping" }),
  scannedNode("1:4", "Help"),
]

const CATALOG: Catalog = {
  [K1]: { key: "checkout_pay", maxLength: 10, values: { de: { text: "Jetzt sicher bezahlen", exceeds: true }, it: "Paga ora" } },
  [K2]: { key: "checkout_title", values: { de: "Kasse", it: "Cassa" } },
  [K3]: { key: "checkout_shipping", values: { de: "Kostenloser Versand", it: null } },
}

function overflowDeps(main: ReturnType<typeof fakeMain>, api: ReturnType<typeof fakeApi>, overrides: Partial<OverflowDeps> = {}) {
  const reset = vi.fn<(nodeIds: string[]) => Promise<void>>(async () => {})
  const progress: string[] = []
  const deps: OverflowDeps = {
    bus: main.bus,
    api,
    scan: vi.fn(async (scope: Scope) => scanOf(NODES, scope)),
    scanError: () => null,
    keyNames: () => new Map([[K1, "checkout_pay_renamed"]]),
    choicesFor: () => ({ samples: {}, plural: null }),
    reset,
    onProgress: (step) => progress.push(step.lang + " " + (step.index + 1) + "/" + step.total),
    shouldStop: () => false,
    ...overrides,
  }
  return { deps, reset, progress }
}

const REQUEST = { scope: "page" as Scope, languages: ["de", "it"], source: "draft" as const, variationOptionId: null, projectId: PROJECT_ID, mainLanguage: "en" }

// --- overflow report -----------------------------------------------------------------------------------------

describe("runOverflowReport (§7.18.1)", () => {
  it("previews, measures and collects each language in turn, then resets every layer it wrote", async () => {
    const main = fakeMain({
      overflow: (nodeIds, lang) => (lang === "de" ? [{ nodeId: "1:3", kind: "exceeds_parent", by: 42 }] : lang === PSEUDO_LANGUAGE ? nodeIds.map((nodeId) => ({ nodeId, kind: "clipped" as const, by: 3 })) : []),
    })
    const api = fakeApi(CATALOG)
    const { deps, reset, progress } = overflowDeps(main, api)

    const report = await runOverflowReport(deps, { ...REQUEST, languages: ["de", "it", PSEUDO_LANGUAGE] })

    expect(deps.scan).toHaveBeenCalledWith("page")
    expect(main.sent.map((message) => message.type)).toEqual(["preview-apply", "overflow-check", "preview-apply", "overflow-check", "preview-apply", "overflow-check"])
    const [deApply, deCheck, itApply, itCheck, pseudoApply] = main.sent as Extract<UiToMain, { type: "preview-apply" | "overflow-check" }>[]
    expect(deApply).toMatchObject({ info: { lang: "de", source: "draft", variationOptionId: null }, items: [{ nodeId: "1:1", text: "Jetzt sicher bezahlen" }, { nodeId: "1:2", text: "Kasse" }, { nodeId: "1:3", text: "Kostenloser Versand" }] })
    expect(deCheck).toMatchObject({ nodeIds: ["1:1", "1:2", "1:3"] })
    // it has no value for 1:3: it goes back to its source text (not de) and is not measured.
    expect(itApply).toMatchObject({ info: { lang: "it" }, items: [{ nodeId: "1:1", text: "Paga ora" }, { nodeId: "1:2", text: "Cassa" }, { nodeId: "1:3", text: "Free shipping" }] })
    expect(itCheck).toMatchObject({ nodeIds: ["1:1", "1:2"] })
    // Pseudo-localization covers every text layer, linked or not, from its source text.
    expect(pseudoApply).toMatchObject({ info: { lang: "en", source: "pseudo" }, items: NODES.map((node) => ({ nodeId: node.nodeId, text: pseudoLocalize(node.characters) })) })

    expect(report.languages).toEqual([
      { lang: "de", rows: [{ nodeId: "1:3", kind: "exceeds_parent", by: 42 }, { nodeId: "1:1", kind: "max_length", by: 11 }], checked: 3, missing: 0, errors: [] },
      { lang: "it", rows: [], checked: 2, missing: 1, errors: [] },
      { lang: PSEUDO_LANGUAGE, rows: NODES.map((node) => ({ nodeId: node.nodeId, kind: "clipped", by: 3 })), checked: 4, missing: 0, errors: [] },
    ])
    // No undo step of their own: the final reset (the app's preview-reset) commits the whole report as one step.
    expect(main.sent.map((message) => (message as { commit?: false }).commit)).toEqual([false, false, false, false, false, false])
    expect(report.nodes.get("1:1")).toEqual({ name: "Pay button", frameName: "Checkout", keyName: "checkout_pay_renamed" })
    expect(report.nodes.get("1:4")).toEqual({ name: "Help", frameName: "Checkout", keyName: null })
    expect([report.stopped, report.error, report.resetError, report.truncatedScan]).toEqual([null, null, null, false])
    expect(reportIssueCount(report)).toBe(6)
    expect(progress).toEqual(["de 1/3", "it 2/3", "pseudo 3/3"])
    expect(reset).toHaveBeenCalledTimes(1)
    expect([...reset.mock.calls[0][0]].sort()).toEqual(["1:1", "1:2", "1:3", "1:4"])
    // The published source and the variation travel with each resolve.
    expect(api.requests.map((body) => [body.languages, body.source])).toEqual([[["de"], "draft"], [["it"], "draft"]])
  })

  it("does not measure or reset layers main could not write", async () => {
    const main = fakeMain({
      applyErrors: (message) => (message.info.lang === "de" ? [{ nodeId: "1:2", code: "missing_font", message: "A font in this layer is missing." }, { nodeId: "1:1", code: "mixed_styles_flattened", message: "Some text styles couldn't be kept." }] : []),
    })
    const { deps, reset } = overflowDeps(main, fakeApi(CATALOG))
    const report = await runOverflowReport(deps, { ...REQUEST, languages: ["de"] })
    expect((main.sent[1] as Extract<UiToMain, { type: "overflow-check" }>).nodeIds).toEqual(["1:1", "1:3"])
    expect(report.languages[0].checked).toBe(2)
    expect(report.languages[0].errors).toEqual([{ nodeId: "1:2", code: "missing_font", message: "A font in this layer is missing." }])
    expect(reset.mock.calls[0][0]).toEqual(["1:1", "1:3"])
  })

  it("resets what it wrote when a later language fails, and reports the error", async () => {
    const main = fakeMain()
    const api = fakeApi(CATALOG)
    const resolveCatalog = api.resolveKeys.getMockImplementation()
    api.resolveKeys.mockImplementation(async (projectId: string, body: FigmaResolveRequest) => {
      if (body.languages[0] === "it") throw new ApiError(500, null, "boom", null)
      return (resolveCatalog as NonNullable<typeof resolveCatalog>)(projectId, body)
    })
    const { deps, reset } = overflowDeps(main, api)
    const report = await runOverflowReport(deps, REQUEST)
    expect(report.stopped).toBe("error")
    expect(report.error).toBe("ReRune had a problem. Try again.")
    expect(report.languages.map((language) => language.lang)).toEqual(["de"])
    expect((main.sent[0] as Extract<UiToMain, { type: "preview-apply" }>).items.map((item) => item.nodeId)).toEqual(["1:1", "1:2", "1:3"])
    // de wrote three layers before it failed: the reset covers all of them.
    expect(reset).toHaveBeenCalledTimes(1)
    expect([...reset.mock.calls[0][0]].sort()).toEqual(["1:1", "1:2", "1:3"])
  })

  it("still resets a layer an earlier language wrote when a later language fails on it", async () => {
    // Main keeps the earlier record when a write fails, so 1:2 still shows German after it fails in it.
    const main = fakeMain({ applyErrors: (message) => (message.info.lang === "it" ? [{ nodeId: "1:2", code: "write_failed", message: "Figma couldn't change this layer." }] : []) })
    const { deps, reset } = overflowDeps(main, fakeApi(CATALOG))
    const report = await runOverflowReport(deps, REQUEST)
    expect(report.languages[1].errors.map((error) => error.nodeId)).toEqual(["1:2"])
    // Not measured in it (it shows German), but reset at the end.
    expect((main.sent[3] as Extract<UiToMain, { type: "overflow-check" }>).nodeIds).toEqual(["1:1"])
    expect([...reset.mock.calls[0][0]].sort()).toEqual(["1:1", "1:2", "1:3"])
  })

  it("refuses to run while layers in scope show a preview, and writes nothing", async () => {
    const main = fakeMain()
    const previewing = [NODES[0], { ...NODES[1], preview: { lang: "de", source: "draft" as const, variationOptionId: null, appliedAt: 1 } }, NODES[2]]
    const { deps, reset } = overflowDeps(main, fakeApi(CATALOG), { scan: vi.fn(async (scope: Scope) => scanOf(previewing, scope)) })
    const refused = await runOverflowReport(deps, REQUEST).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(QaRefusal)
    expect(refused).toMatchObject({ message: PREVIEWING_SCOPE, nodeIds: ["1:2"] })
    expect(main.sent).toEqual([])
    expect(reset).not.toHaveBeenCalled()
  })

  it("resets its own layers after a reset that was already running (queued, never merged into it)", async () => {
    const main = fakeMain()
    const work = vi.fn<(nodeIds: string[]) => Promise<void>>()
    let releaseOther: () => void = () => {}
    work.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseOther = resolve)))
    work.mockImplementation(async () => {})
    const flight = singleFlight(work)
    // Restore original of the edited-during-preview note, started while the report runs.
    const other = flight.run(["9:9"])
    const { deps } = overflowDeps(main, fakeApi(CATALOG), { reset: (nodeIds) => flight.queue(nodeIds) })
    const pending = runOverflowReport(deps, { ...REQUEST, languages: ["de"] })
    await vi.waitFor(() => expect(main.sent.map((message) => message.type)).toEqual(["preview-apply", "overflow-check"]))
    expect(work).toHaveBeenCalledTimes(1)
    releaseOther()
    await other
    const report = await pending
    expect(report.resetError).toBeNull()
    expect(work.mock.calls.map((call) => call[0])).toEqual([["9:9"], ["1:1", "1:2", "1:3"]])
  })

  it("counts a batch that never answered as written, so the reset still covers it", async () => {
    const main = fakeMain({ failApply: (message) => message.info.lang === "it" })
    const { deps, reset } = overflowDeps(main, fakeApi(CATALOG))
    const report = await runOverflowReport(deps, REQUEST)
    expect(report.stopped).toBe("error")
    expect(report.error).toBe("Figma stopped")
    expect([...reset.mock.calls[0][0]].sort()).toEqual(["1:1", "1:2", "1:3"])
  })

  it("stops between languages and still resets", async () => {
    const main = fakeMain()
    let calls = 0
    const { deps, reset } = overflowDeps(main, fakeApi(CATALOG), { shouldStop: () => calls++ > 0 })
    const report = await runOverflowReport(deps, REQUEST)
    expect(report.stopped).toBe("cancelled")
    expect(report.languages.map((language) => language.lang)).toEqual(["de"])
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("records a failed reset instead of losing the report", async () => {
    const main = fakeMain()
    const { deps } = overflowDeps(main, fakeApi(CATALOG), { reset: vi.fn(async () => Promise.reject(new Error("The plugin stopped responding. Try again."))) })
    const report = await runOverflowReport(deps, { ...REQUEST, languages: ["de"] })
    expect(report.resetError).toBe("The plugin stopped responding. Try again.")
    expect(report.languages).toHaveLength(1)
  })

  it("refuses an empty language list, reports a scan that did not finish and an empty scope", async () => {
    const main = fakeMain()
    const { deps } = overflowDeps(main, fakeApi(CATALOG), { scan: vi.fn(async () => null), scanError: () => "Scan failed badly" })
    await expect(runOverflowReport(deps, { ...REQUEST, languages: [] })).rejects.toThrow(NO_LANGUAGES)
    await expect(runOverflowReport(deps, REQUEST)).rejects.toThrow("Scan failed badly")
    const empty = overflowDeps(main, fakeApi(CATALOG), { scan: vi.fn(async (scope: Scope) => scanOf([], scope)) })
    await expect(runOverflowReport(empty.deps, REQUEST)).rejects.toThrow(NO_LAYERS)
    expect(empty.reset).not.toHaveBeenCalled()
    expect(main.sent).toEqual([])
  })

  it("keeps the scan's truncation flag and uses the render choices per language", async () => {
    const main = fakeMain()
    const choicesFor = vi.fn(() => ({ samples: {}, plural: null }))
    const { deps } = overflowDeps(main, fakeApi(CATALOG), { scan: vi.fn(async (scope: Scope) => scanOf(NODES, scope, true)), choicesFor })
    const report = await runOverflowReport(deps, REQUEST)
    expect(report.truncatedScan).toBe(true)
    expect(choicesFor.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["de", "it"])
  })
})

describe("checkOverflow (UI side)", () => {
  it("asks main in batches of 200 layers", async () => {
    const main = fakeMain({ overflow: (nodeIds) => [{ nodeId: nodeIds[0], kind: "truncated", by: 1.6 }] })
    const ids = Array.from({ length: 450 }, (_, index) => "1:" + index)
    const items = await checkOverflow(main.bus, ids)
    expect(main.sent.map((message) => (message as Extract<UiToMain, { type: "overflow-check" }>).nodeIds.length)).toEqual([200, 200, 50])
    expect(items.map((item) => item.nodeId)).toEqual(["1:0", "1:200", "1:400"])
  })
})

describe("markPreviewing", () => {
  it("marks layers an earlier language wrote, and leaves others alone", () => {
    const marked = markPreviewing(NODES, new Set(["1:2"]))
    expect(marked.map((node) => node.preview !== null)).toEqual([false, true, false, false])
    expect(marked[0]).toBe(NODES[0])
  })
})

describe("report text and CSV", () => {
  const report: Pick<OverflowReport, "languages" | "nodes"> = {
    languages: [
      { lang: "de", rows: [{ nodeId: "1:1", kind: "clipped", by: 12.5 }, { nodeId: "1:2", kind: "max_length", by: 3 }], checked: 2, missing: 0, errors: [] },
      { lang: PSEUDO_LANGUAGE, rows: [{ nodeId: "1:3", kind: "exceeds_parent", by: 4 }], checked: 1, missing: 0, errors: [] },
    ],
    nodes: new Map([
      ["1:1", { name: 'Pay, "now"', frameName: "Checkout", keyName: "checkout_pay" }],
      ["1:2", { name: "=SUM(A1)", frameName: null, keyName: "title" }],
      ["1:3", { name: "Line 1\nLine 2", frameName: "-Draft", keyName: null }],
    ]),
  }

  it("labels kinds, units and amounts", () => {
    expect([kindLabel("clipped"), kindLabel("truncated"), kindLabel("exceeds_parent"), kindLabel("max_length")]).toEqual(["Clipped", "Truncated", "Outside its frame", "Over max length"])
    expect([unitOf("clipped"), unitOf("max_length")]).toEqual(["px", "characters"])
    expect(amountText({ kind: "clipped", by: 12.5 })).toBe("12.5 px past its box")
    expect(amountText({ kind: "truncated", by: 40 })).toBe("40 px cut off")
    expect(amountText({ kind: "exceeds_parent", by: 4 })).toBe("4 px outside its frame")
    expect(amountText({ kind: "max_length", by: 1 })).toBe("1 character too long")
    expect(amountText({ kind: "max_length", by: 3 })).toBe("3 characters too long")
    expect(reportLanguageLabel("de", [{ code: "de", name: "German" }])).toBe("German (de)")
    expect(reportLanguageLabel("sq", [{ code: "sq", name: "" }])).toBe("sq")
    expect(reportLanguageLabel(PSEUDO_LANGUAGE, [])).toBe("Pseudo-localization")
  })

  it("writes RFC 4180 CSV with formula-safe cells", () => {
    expect(csvCell("plain")).toBe("plain")
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell("=1+1")).toBe("'=1+1")
    expect(csvCell("@cmd")).toBe("'@cmd")
    expect(csvCell("+1")).toBe("'+1")
    const csv = reportCsv(report, (lang) => reportLanguageLabel(lang, [{ code: "de", name: "German" }]))
    expect(csv).toBe(
      [
        CSV_HEADER.join(","),
        'German (de),Clipped,12.5,px,"Pay, ""now""",Checkout,checkout_pay,1:1',
        "German (de),Over max length,3,characters,'=SUM(A1),,title,1:2",
        'Pseudo-localization,Outside its frame,4,px,"Line 1\nLine 2",\'-Draft,,1:3',
        "",
      ].join("\r\n"),
    )
  })
})

// --- language copies -------------------------------------------------------------------------------------------

const FRAME_A = { frameId: "10:1", frameName: "Checkout" }
const FRAME_B = { frameId: "20:1", frameName: "Profile" }
const FRAME_C = { frameId: "30:1", frameName: "Settings" }

const PAGE = [
  linkedNode("1:1", "Pay now", { keyId: K1, keyName: "pay", syncedText: "Pay now" }, FRAME_A),
  linkedNode("1:2", "Checkout", { keyId: K2, keyName: "title", syncedText: "Checkout" }, FRAME_A),
  scannedNode("1:4", "Help", FRAME_A),
  linkedNode("2:1", "Free shipping", { keyId: K3, keyName: "shipping", syncedText: "Free shipping" }, FRAME_B),
  linkedNode("3:1", "Checkout", { keyId: K2, keyName: "title", syncedText: "Checkout" }, FRAME_C),
  scannedNode("4:1", "Loose", { frameId: null, frameName: null }),
]

function copiesDeps(main: ReturnType<typeof fakeMain>, api: ReturnType<typeof fakeApi>, selection: ScannedNode[], page: ScannedNode[] = PAGE): CopiesDeps & { progress: string[] } {
  const progress: string[] = []
  return {
    bus: main.bus,
    api,
    scan: vi.fn(async (scope: Scope) => (scope === "selection" ? scanOf(selection, scope) : scanOf(page, scope))),
    scanError: () => null,
    keyNames: () => new Map(),
    choicesFor: () => ({ samples: {}, plural: null }),
    onProgress: (text) => progress.push(text),
    progress,
  }
}

const COPIES_REQUEST = { languages: ["de", "it"], source: "published" as const, variationOptionId: "6a47", projectId: PROJECT_ID }

describe("makeLanguageCopies (§7.18.4)", () => {
  it("copies the whole frames of the selection once per language, one message per frame", async () => {
    const main = fakeMain()
    const api = fakeApi(CATALOG)
    // Only one layer of Checkout and one of Profile are selected; Settings is not.
    const deps = copiesDeps(main, api, [PAGE[1], PAGE[3]])

    const result = await makeLanguageCopies(deps, COPIES_REQUEST)

    expect(deps.scan).toHaveBeenNthCalledWith(1, "selection")
    expect(deps.scan).toHaveBeenNthCalledWith(2, "page")
    const messages = main.sent as Extract<UiToMain, { type: "language-copies" }>[]
    expect(messages.map((message) => message.frameIds)).toEqual([["10:1"], ["20:1"]])
    expect(messages[0].copies).toEqual([
      { lang: "de", source: "published", variationOptionId: "6a47", texts: [{ nodeId: "1:1", text: "Jetzt sicher bezahlen" }, { nodeId: "1:2", text: "Kasse" }] },
      { lang: "it", source: "published", variationOptionId: "6a47", texts: [{ nodeId: "1:1", text: "Paga ora" }, { nodeId: "1:2", text: "Cassa" }] },
    ])
    expect(messages[1].copies).toEqual([
      { lang: "de", source: "published", variationOptionId: "6a47", texts: [{ nodeId: "2:1", text: "Kostenloser Versand" }] },
      { lang: "it", source: "published", variationOptionId: "6a47", texts: [] },
    ])
    expect(api.requests.map((body) => [body.languages, body.source, body.variation_option_id, body.key_ids])).toEqual([
      [["de"], "published", "6a47", [K1, K2, K3]],
      [["it"], "published", "6a47", [K1, K2, K3]],
    ])
    expect(result).toMatchObject({ frames: [{ id: "10:1", name: "Checkout" }, { id: "20:1", name: "Profile" }], languages: ["de", "it"], made: 4, framesCopied: 2, written: 5, refused: [], errors: [], truncatedScan: false })
    expect(result.missing.map((entry) => [entry.lang, entry.entries.map((missing) => missing.nodeId)])).toEqual([["it", ["2:1"]]])
    expect(deps.progress).toEqual(["Loading de values…", "Loading it values…", "Copying Checkout (1 of 2)…", "Copying Profile (2 of 2)…"])
  })

  it("splits frame refusals from layer problems and counts the copies made", async () => {
    const main = fakeMain({
      copies: (message) =>
        message.frameIds[0] === "10:1"
          ? { done: 0, errors: [{ nodeId: "10:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.component }] }
          : { done: 1, errors: [{ nodeId: "8001:1", code: "missing_font", message: "A font in this layer is missing." }, { nodeId: "20:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.failed }] },
    })
    const result = await makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[0], PAGE[3]]), COPIES_REQUEST)
    expect(result.made).toBe(1)
    expect(result.written).toBe(1)
    // Profile got its de copy (it failed): it counts as copied, and the failed language is a problem of the frame.
    expect(result.framesCopied).toBe(1)
    expect(result.refused.map((error) => error.nodeId)).toEqual(["10:1"])
    expect(result.errors.map((error) => error.nodeId)).toEqual(["8001:1", "20:1"])
  })

  it("counts only the copies made when a frame is deleted during the run", async () => {
    const removed = { code: "node_not_found" as const, message: LANGUAGE_COPY_MESSAGES.removed }
    const main = fakeMain({
      copies: (message) =>
        message.frameIds[0] === "10:1"
          ? { done: 2, errors: [{ nodeId: "10:1", ...removed }] }
          : { done: 0, errors: [{ nodeId: "20:1", ...removed }, { nodeId: "20:1", ...removed }] },
    })
    const result = await makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[0], PAGE[3]]), COPIES_REQUEST)
    // Checkout got its de copy before it was deleted; Profile was deleted before any copy.
    expect([result.made, result.framesCopied]).toEqual([1, 1])
    expect(result.errors).toEqual([{ nodeId: "10:1", ...removed }])
    expect(result.refused).toEqual([{ nodeId: "20:1", ...removed }, { nodeId: "20:1", ...removed }])
  })

  it("refuses a frame whose every language failed, and one whose page couldn't be loaded", async () => {
    const failed = { code: "write_failed" as const, message: LANGUAGE_COPY_MESSAGES.failed }
    const main = fakeMain({
      copies: (message) =>
        message.frameIds[0] === "10:1"
          ? { done: 0, errors: [{ nodeId: "10:1", ...failed }, { nodeId: "10:1", ...failed }] }
          : { done: 0, errors: [{ nodeId: "20:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.pageNotLoaded }] },
    })
    const result = await makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[0], PAGE[3]]), COPIES_REQUEST)
    expect([result.made, result.framesCopied]).toEqual([0, 0])
    expect(result.refused.map((error) => error.nodeId)).toEqual(["10:1", "10:1", "20:1"])
    expect(result.errors).toEqual([])
  })

  it("asks for frames, refuses while layers in them preview, and needs a language", async () => {
    const main = fakeMain()
    await expect(makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[5]]), COPIES_REQUEST)).rejects.toThrow(NO_FRAMES)
    const previewing = PAGE.map((node) => (node.nodeId === "1:2" ? { ...node, preview: { lang: "fr", source: "draft" as const, variationOptionId: null, appliedAt: 1 } } : node))
    const refusal = await makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[0]], previewing), COPIES_REQUEST).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(QaRefusal)
    expect((refusal as QaRefusal).message).toBe(PREVIEWING_FRAMES)
    expect((refusal as QaRefusal).nodeIds).toEqual(["1:2"])
    await expect(makeLanguageCopies(copiesDeps(main, fakeApi(CATALOG), [PAGE[0]]), { ...COPIES_REQUEST, languages: [] })).rejects.toThrow(NO_LANGUAGES)
    expect(main.sent).toEqual([])
  })

  it("reports a scan that did not finish", async () => {
    const main = fakeMain()
    const deps = { ...copiesDeps(main, fakeApi(CATALOG), []), scan: vi.fn(async () => null) }
    await expect(makeLanguageCopies(deps, COPIES_REQUEST)).rejects.toThrow("The scan didn't finish. Try again.")
  })

  it("lists the selection's frames once each and counts copies per frame", () => {
    expect(selectedFrames(PAGE)).toEqual([
      { id: "10:1", name: "Checkout" },
      { id: "20:1", name: "Profile" },
      { id: "30:1", name: "Settings" },
    ])
    expect(copiesMade("10:1", 3, [])).toBe(3)
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.failed }])).toBe(2)
    // The frame was deleted during the run: one error per language left, the copies made before still count.
    const removed = { nodeId: "10:1", code: "node_not_found" as const, message: LANGUAGE_COPY_MESSAGES.removed }
    expect(copiesMade("10:1", 3, [removed, removed])).toBe(1)
    expect(copiesMade("10:1", 3, [removed, removed, removed])).toBe(0)
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.failed }, removed])).toBe(1)
    // A frame not found when the run started is refused as a whole.
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "node_not_found", message: "Layer not found. It may be hidden or deleted." }])).toBe(0)
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "preview_active", message: LANGUAGE_COPY_MESSAGES.previewing }])).toBe(0)
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "node_not_found", message: "Layer not found." }])).toBe(0)
    expect(copiesMade("10:1", 3, [{ nodeId: "10:1", code: "write_failed", message: LANGUAGE_COPY_MESSAGES.pageNotLoaded }])).toBe(0)
    expect(copiesMade("10:1", 2, [{ nodeId: "8001:2", code: "missing_font", message: "x" }])).toBe(2)
  })
})
