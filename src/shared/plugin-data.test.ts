import { describe, expect, it } from "vitest"
import { LINK_TOMBSTONE } from "./constants"
import type { FileSettings } from "./messages"
import {
  mainsFirst,
  classifyLink,
  createLink,
  isOwnLangCopy,
  isTombstone,
  linkStateOf,
  newFileSettings,
  ownPreviewRecord,
  parseDiagMarker,
  parseFileSettings,
  parseLangCopy,
  parseLink,
  parsePreviewRecord,
  previewInfoOf,
  recordOwnership,
  relaunchDescription,
  resolveFileSettings,
  serializeDiagMarker,
  serializeFileSettings,
  serializeLangCopy,
  serializeLink,
  serializePreviewRecord,
  type PreviewRecord,
} from "./plugin-data"

const KEY = "6a4800000000000000000001"
const PROJECT = "6a4600000000000000000c35"

function linkJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, id: KEY, k: "checkout_pay_button", p: PROJECT, src: "c53:1442abda685db2", nid: "12:345", t: 1761550000000, ...overrides })
}

describe("parseLink", () => {
  it("parses a valid link", () => {
    expect(parseLink(linkJson())).toEqual({
      kind: "link",
      link: { v: 1, id: KEY, k: "checkout_pay_button", p: PROJECT, src: "c53:1442abda685db2", nid: "12:345", t: 1761550000000 },
    })
  })

  it("treats empty data and the tombstone as no link", () => {
    expect(parseLink("")).toEqual({ kind: "none" })
    expect(parseLink("   ")).toEqual({ kind: "none" })
    expect(parseLink(LINK_TOMBSTONE)).toEqual({ kind: "none" })
  })

  it.each([
    ["invalid JSON", "{nope"],
    ["a JSON array", "[1]"],
    ["a JSON string", '"x"'],
    ["null", "null"],
    ["an unknown version", linkJson({ v: 2 })],
    ["a tombstone of an unknown version", JSON.stringify({ v: 2, none: true })],
    ["an id that is not 24-hex", linkJson({ id: "6a48" })],
    ["an uppercase id", linkJson({ id: "6A4800000000000000000001" })],
    ["a project that is not 24-hex", linkJson({ p: "chapter" })],
    ["an empty key name", linkJson({ k: "" })],
    ["a missing src", linkJson({ src: undefined })],
    ["a numeric nid", linkJson({ nid: 12 })],
  ])("marks %s as invalid", (_label, raw) => {
    expect(parseLink(raw)).toEqual({ kind: "invalid" })
  })

  it("defaults a missing or broken timestamp to 0", () => {
    const parsed = parseLink(linkJson({ t: "yesterday" }))
    expect(parsed.kind === "link" && parsed.link.t).toBe(0)
  })

  it("round-trips through serializeLink and createLink", () => {
    const link = createLink({ keyId: KEY, keyName: "a.b", projectId: PROJECT, src: "c53:1", nodeId: "I1:2;3:4", now: 5 })
    expect(parseLink(serializeLink(link))).toEqual({ kind: "link", link })
  })

  it("recognises the tombstone", () => {
    expect(isTombstone(LINK_TOMBSTONE)).toBe(true)
    expect(isTombstone(linkJson())).toBe(false)
    expect(isTombstone("")).toBe(false)
  })
})

describe("classifyLink (Appendix A.9)", () => {
  it.each([
    ["12:345", "12:345", null, false, "ok"],
    ["I12:34;5:67", "I12:34;5:67", true, true, "ok"],
    ["I12:34;5:67", "I12:34;5:67", false, false, "ok"],
    ["I12:34;5:67", "5:67", false, false, "inherited"],
    ["I1:2;3:4;5:6", "I3:4;5:6", false, false, "inherited"],
    ["I12:34;77:1", "3:9", false, false, "inherited"],
    ["I12:34;5:67", "5:67", false, true, "inherited_overridden"],
    ["I99:1;5:67", "I12:34;5:67", true, false, "copied"],
    ["I12:34;5:67", "5:67", null, false, "inherited"],
    ["I1:2;3:4;5:6", "I3:4;5:6", null, false, "inherited"],
    ["I99:1;5:67", "I12:34;5:67", null, false, "copied"],
    ["I12:34;15:67", "5:67", null, false, "copied"],
    ["5:68", "5:67", false, false, "copied"],
    ["5:68", "5:67", null, false, "copied"],
  ] as const)("node %s with nid %s (override %s, text %s) → %s", (nodeId, nid, own, text, expected) => {
    expect(classifyLink(nodeId, nid, own, text)).toBe(expected)
  })

  it("applies the characters override to the fallback rule too", () => {
    expect(classifyLink("I12:34;5:67", "5:67", null, true)).toBe("inherited_overridden")
  })

  it("maps parse results to link states", () => {
    expect(linkStateOf({ kind: "none" }, "1:1", null, false)).toBe("none")
    expect(linkStateOf({ kind: "invalid" }, "1:1", null, false)).toBe("invalid")
    expect(linkStateOf(parseLink(linkJson({ nid: "5:67" })), "I12:34;5:67", false, false)).toBe("inherited")
    expect(linkStateOf(parseLink(linkJson({ nid: "12:345" })), "12:345", null, false)).toBe("ok")
  })

  it("classifies record ownership with the same rule", () => {
    expect(recordOwnership("12:345", "12:345", null)).toBe("own")
    expect(recordOwnership("I12:34;5:67", "5:67", false)).toBe("inherited")
    expect(recordOwnership("I12:34;5:67", "5:67", null)).toBe("inherited")
    expect(recordOwnership("I12:34;5:67", "5:67", true)).toBe("copied")
    expect(recordOwnership("5:68", "5:67", null)).toBe("copied")
  })
})

describe("mainsFirst (write order)", () => {
  it("writes main components, then instance sublayers from the shallowest nesting level down", () => {
    const order = mainsFirst([{ nodeId: "I1:2;3:4;5:6" }, { nodeId: "I9:1;5:6" }, { nodeId: "5:6" }, { nodeId: "I3:4;5:6" }, { nodeId: "7:8" }])
    expect(order.map((item) => item.nodeId)).toEqual(["5:6", "7:8", "I9:1;5:6", "I3:4;5:6", "I1:2;3:4;5:6"])
  })
})

describe("relaunchDescription", () => {
  it("prefixes the key name and caps at 1000 characters", () => {
    expect(relaunchDescription("checkout_pay_button")).toBe("ReRune key: checkout_pay_button")
    expect(relaunchDescription("x".repeat(2000))).toHaveLength(1000)
  })
})

function previewRecord(overrides: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    v: 1,
    nid: "12:345",
    previewSrc: "c53:1e9705dc1b274d",
    characters: "Pay now",
    autoRename: true,
    textOverridden: false,
    segments: [{ characters: "Pay now", start: 0, end: 7 }],
    richLost: false,
    lang: "de-AT",
    source: "draft",
    variationOptionId: null,
    appliedAt: 1761550000000,
    ...overrides,
  }
}

describe("preview records", () => {
  it("round-trips a record", () => {
    const record = previewRecord()
    expect(parsePreviewRecord(serializePreviewRecord(record))).toEqual(record)
    expect(previewInfoOf(record)).toEqual({ lang: "de-AT", source: "draft", variationOptionId: null, appliedAt: 1761550000000 })
  })

  it("accepts rich-lost records without segments", () => {
    const record = previewRecord({ segments: null, richLost: true, source: "pseudo" })
    expect(parsePreviewRecord(serializePreviewRecord(record))).toEqual(record)
  })

  it.each([
    ["empty", ""],
    ["invalid JSON", "{"],
    ["the tombstone", LINK_TOMBSTONE],
    ["a wrong version", JSON.stringify({ ...previewRecord(), v: 3 })],
    ["an unknown source", JSON.stringify({ ...previewRecord(), source: "machine" })],
    ["segments that are not an array", JSON.stringify({ ...previewRecord(), segments: {} })],
    ["a missing original", JSON.stringify({ ...previewRecord(), characters: undefined })],
  ])("treats %s as absent", (_label, raw) => {
    expect(parsePreviewRecord(raw)).toBeNull()
  })

  it("treats a record whose nid differs from the node as absent", () => {
    const raw = serializePreviewRecord(previewRecord({ nid: "5:67" }))
    expect(ownPreviewRecord(raw, "I12:34;5:67")).toBeNull()
    expect(ownPreviewRecord(raw, "5:68")).toBeNull()
    expect(ownPreviewRecord(raw, "5:67")).not.toBeNull()
  })
})

describe("language copy markers", () => {
  const marker = { v: 1 as const, nid: "40:1", lang: "de", source: "draft" as const, variationOptionId: null, sourceFrameId: "10:1", createdAt: 1 }

  it("round-trips and matches only its own frame", () => {
    const raw = serializeLangCopy(marker)
    expect(parseLangCopy(raw)).toEqual(marker)
    expect(isOwnLangCopy(raw, "40:1")).toBe(true)
    expect(isOwnLangCopy(raw, "41:7")).toBe(false)
  })

  it("rejects broken markers", () => {
    expect(parseLangCopy("")).toBeNull()
    expect(parseLangCopy(JSON.stringify({ ...marker, source: "pseudo" }))).toBeNull()
    expect(parseLangCopy(JSON.stringify({ ...marker, v: 2 }))).toBeNull()
    expect(isOwnLangCopy("{", "40:1")).toBe(false)
  })
})

describe("diagnostics markers", () => {
  it("round-trips", () => {
    expect(parseDiagMarker(serializeDiagMarker({ v: 1, nid: "1:2", t: 3 }))).toEqual({ v: 1, nid: "1:2", t: 3 })
    expect(parseDiagMarker("[]")).toBeNull()
    expect(parseDiagMarker(JSON.stringify({ v: 1, nid: 4, t: 3 }))).toBeNull()
  })
})

function settings(overrides: Partial<FileSettings> = {}): FileSettings {
  return { ...newFileSettings({ apiBase: "https://rerune.io/api", projectId: PROJECT, projectName: "Chapter", now: 100 }), ...overrides }
}

describe("file settings", () => {
  it("creates defaults", () => {
    expect(settings()).toEqual({
      v: 1,
      apiBase: "https://rerune.io/api",
      projectId: PROJECT,
      projectName: "Chapter",
      fileKey: null,
      fileUrl: null,
      fileName: null,
      branchKey: null,
      keyTemplate: null,
      caseStyle: "auto",
      ignoreUnderscoreLayers: true,
      includeLocked: false,
      updatedAt: 100,
    })
  })

  it("round-trips", () => {
    const value = settings({ fileKey: "AbCdEf1234567890XyZ", branchKey: "BrAnCh1234567890", caseStyle: "dot.camel", keyTemplate: "{frame}_{layer}" })
    expect(parseFileSettings(serializeFileSettings(value))).toEqual(value)
  })

  it("fills optional fields that are missing", () => {
    const raw = JSON.stringify({ v: 1, apiBase: "https://rerune.io/api", projectId: PROJECT, projectName: "Chapter", updatedAt: 100 })
    expect(parseFileSettings(raw)).toEqual(settings())
  })

  it.each([
    ["empty", ""],
    ["invalid JSON", "nope"],
    ["a wrong version", JSON.stringify({ ...settings(), v: 2 })],
    ["a bad project id", JSON.stringify({ ...settings(), projectId: "x" })],
    ["an empty api base", JSON.stringify({ ...settings(), apiBase: "" })],
    ["a missing updatedAt", JSON.stringify({ ...settings(), updatedAt: undefined })],
    ["an unknown case style", JSON.stringify({ ...settings(), caseStyle: "title" })],
    ["a non-string file key", JSON.stringify({ ...settings(), fileKey: 5 })],
    ["a non-boolean flag", JSON.stringify({ ...settings(), includeLocked: "yes" })],
  ])("rejects %s", (_label, raw) => {
    expect(parseFileSettings(raw)).toBeNull()
  })

  it("reads root first, then the page mirror", () => {
    const root = serializeFileSettings(settings())
    expect(resolveFileSettings("", "")).toEqual({ settings: null, source: "none", differ: false, offerMirror: false })
    expect(resolveFileSettings(root, "")).toEqual({ settings: settings(), source: "root", differ: false, offerMirror: true })
    expect(resolveFileSettings("{broken", root)).toEqual({ settings: settings(), source: "page", differ: false, offerMirror: false })
    expect(resolveFileSettings(root, root)).toEqual({ settings: settings(), source: "root", differ: false, offerMirror: false })
  })

  it("lets the newer copy win when root and page differ", () => {
    const older = settings({ updatedAt: 100, projectName: "Old" })
    const newer = settings({ updatedAt: 200, projectName: "New" })
    expect(resolveFileSettings(serializeFileSettings(newer), serializeFileSettings(older))).toEqual({
      settings: newer,
      source: "root",
      differ: true,
      offerMirror: true,
    })
    expect(resolveFileSettings(serializeFileSettings(older), serializeFileSettings(newer))).toEqual({
      settings: newer,
      source: "page",
      differ: true,
      offerMirror: false,
    })
  })
})
