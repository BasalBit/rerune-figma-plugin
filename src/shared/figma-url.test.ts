import { describe, expect, it } from "vitest"
import { canonicalFileUrl, figmaNodeUrl, figmaSlug, fileKeyUrl, isFigmaNodeId, isFigmaPageId, parseFigmaUrl } from "./figma-url"

// Appendix A.2 vectors, verbatim ("–" = absent: null in the plugin, "" on the server).
const PARSE_VECTORS: { url: string; fileKey: string; branchKey: string | null; nodeId: string | null; slug: string }[] = [
  { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter-App?node-id=12-345&t=abc", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: "12:345", slug: "Chapter App" },
  { url: "https://figma.com/file/AbCdEf1234567890XyZ/Chapter", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: null, slug: "Chapter" },
  { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/branch/BrAnCh1234567890/Chapter?node-id=1-2", fileKey: "AbCdEf1234567890XyZ", branchKey: "BrAnCh1234567890", nodeId: "1:2", slug: "Chapter" },
  { url: "https://www.figma.com/proto/AbCdEf1234567890XyZ/Chapter?node-id=3-4&scaling=min-zoom", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: "3:4", slug: "Chapter" },
  { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=I12-34%3B5-67", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: "I12:34;5:67", slug: "Chapter" },
  { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter?node-id=12%3A345", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: "12:345", slug: "Chapter" },
  { url: "https://www.figma.com/design/AbCdEf1234567890XyZ", fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: null, slug: "" },
]

const INVALID_VECTORS = [
  "http://www.figma.com/design/AbCdEf1234567890XyZ/x",
  "https://evil.com/design/AbCdEf1234567890XyZ/x",
  "https://www.figma.com/community/file/1234567890/x",
  "https://www.figma.com/design/ab/x",
  "not a url",
]

const BUILD_VECTORS: { fileKey: string; fileName: string; node: string | null; result: string }[] = [
  { fileKey: "AbCdEf1234567890XyZ", fileName: "Chapter App", node: null, result: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter-App" },
  { fileKey: "AbCdEf1234567890XyZ", fileName: "", node: null, result: "https://www.figma.com/design/AbCdEf1234567890XyZ/file" },
  { fileKey: "AbCdEf1234567890XyZ", fileName: "Chapter App", node: "10:1", result: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter-App?node-id=10-1" },
  { fileKey: "AbCdEf1234567890XyZ", fileName: "Chapter App", node: "I12:34;5:67", result: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter-App?node-id=I12-34%3B5-67" },
  { fileKey: "AbCdEf1234567890XyZ", fileName: "Übersicht · Mobile", node: null, result: "https://www.figma.com/design/AbCdEf1234567890XyZ/bersicht-Mobile" },
]

describe("parseFigmaUrl (Appendix A.2)", () => {
  it.each(PARSE_VECTORS)("parses $url", (vector) => {
    expect(parseFigmaUrl(vector.url)).toEqual({ fileKey: vector.fileKey, branchKey: vector.branchKey, nodeId: vector.nodeId, slug: vector.slug })
  })

  it.each(INVALID_VECTORS)("rejects %s", (url) => {
    expect(parseFigmaUrl(url)).toBeNull()
  })

  it("accepts every file type, the bare host and a pasted link with spaces or a trailing slash", () => {
    for (const type of ["design", "file", "proto", "board", "slides"]) {
      expect(parseFigmaUrl("https://www.figma.com/" + type + "/AbCdEf1234567890XyZ/x")?.fileKey).toBe("AbCdEf1234567890XyZ")
    }
    expect(parseFigmaUrl("  https://figma.com/design/AbCdEf1234567890XyZ/Chapter/\n")).toEqual({ fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: null, slug: "Chapter" })
    expect(parseFigmaUrl("HTTPS://WWW.FIGMA.COM/design/AbCdEf1234567890XyZ")?.fileKey).toBe("AbCdEf1234567890XyZ")
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter#frame")?.slug).toBe("Chapter")
  })

  it("treats a malformed node-id as absent, not as an invalid link", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/x?node-id=abc")?.nodeId).toBeNull()
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/x?node-id=%E0%A4%A")?.nodeId).toBeNull()
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/x?node-id=")?.nodeId).toBeNull()
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/x?t=1&node-id=7-8")?.nodeId).toBe("7:8")
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/x?node-id=1-2&node-id=3-4")?.nodeId).toBe("1:2")
  })

  it("decodes the slug and keeps a lone 'branch' segment as the slug", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/%C3%9Cbersicht-Mobile")?.slug).toBe("Übersicht Mobile")
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/branch")).toEqual({ fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: null, slug: "branch" })
    expect(parseFigmaUrl("https://www.figma.com/design/AbCdEf1234567890XyZ/branch/BrAnCh1234567890")).toEqual({
      fileKey: "AbCdEf1234567890XyZ",
      branchKey: "BrAnCh1234567890",
      nodeId: null,
      slug: "",
    })
  })

  it("rejects other hosts, ports, user info, missing keys, bad branch keys and extra path segments", () => {
    for (const url of [
      "https://www.figma.com",
      "https://www.figma.com/",
      "https://www.figma.com/design/",
      "https://figma.com.evil.com/design/AbCdEf1234567890XyZ/x",
      "https://www.figma.com:8443/design/AbCdEf1234567890XyZ/x",
      "https://user@www.figma.com/design/AbCdEf1234567890XyZ/x",
      "https://www.figma.com/design/AbCdEf1234567890XyZ/branch/b!/x",
      "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter/extra",
      "https://www.figma.com/design//AbCdEf1234567890XyZ",
      "https://www.figma.com/design/AbCdEf1234567890XyZ/%E0%A4%A",
      "https://www.figma.com/files/AbCdEf1234567890XyZ/x",
      "https://www.figma.com/design/" + "a".repeat(129) + "/x",
      "",
    ]) {
      expect(parseFigmaUrl(url)).toBeNull()
    }
  })
})

describe("canonical URLs (Appendix A.2 build)", () => {
  it.each(BUILD_VECTORS)("builds $result", (vector) => {
    expect(vector.node === null ? canonicalFileUrl(vector.fileKey, vector.fileName) : figmaNodeUrl(vector.fileKey, vector.fileName, vector.node)).toBe(vector.result)
  })

  it("builds a URL without slug that parses with an empty slug", () => {
    expect(fileKeyUrl("AbCdEf1234567890XyZ")).toBe("https://www.figma.com/design/AbCdEf1234567890XyZ")
    expect(parseFigmaUrl(fileKeyUrl("AbCdEf1234567890XyZ"))).toEqual({ fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: null, slug: "" })
  })

  it("cuts the slug to 100 characters and round-trips through the parser", () => {
    expect(figmaSlug("a".repeat(150))).toHaveLength(100)
    expect(figmaSlug("—")).toBe("file")
    const url = figmaNodeUrl("AbCdEf1234567890XyZ", "Chapter App", "I12:34;5:67")
    expect(parseFigmaUrl(url)).toEqual({ fileKey: "AbCdEf1234567890XyZ", branchKey: null, nodeId: "I12:34;5:67", slug: "Chapter App" })
  })
})

describe("Figma identifiers (§4.0)", () => {
  it("validates node and page ids", () => {
    expect(isFigmaNodeId("12:345")).toBe(true)
    expect(isFigmaNodeId("I12:34;5:67;8:9")).toBe(true)
    expect(isFigmaNodeId("I12:34;")).toBe(false)
    expect(isFigmaNodeId("12-345")).toBe(false)
    expect(isFigmaNodeId("I1:1" + ";1:1".repeat(200))).toBe(false)
    expect(isFigmaPageId("0:1")).toBe(true)
    expect(isFigmaPageId("I0:1")).toBe(false)
  })
})
