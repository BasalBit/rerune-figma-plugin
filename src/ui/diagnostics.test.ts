import { describe, expect, it } from "vitest"
import { diagnosticsFor, jpgSampleOf, messageFor, printableReport, runNetworkCheck, withUiFacts } from "./diagnostics"
import { cornerPixel } from "./image"

describe("diagnosticsFor", () => {
  it("offers read and write tests in Design mode, never T9", () => {
    for (const env of ["production", "development"] as const) {
      expect(diagnosticsFor("figma", env).map((entry) => entry.test)).toEqual([
        "T10-environment", "T1-mark", "T1-check", "T2-instances", "T2-clear", "T3-export", "T4-export-page", "T5-fonts", "T7-settings", "T8-relaunch",
      ])
    }
  })

  it("offers only read tests plus T9 in Dev Mode development builds", () => {
    expect(diagnosticsFor("dev", "development").map((entry) => entry.test)).toEqual([
      "T10-environment", "T1-check", "T2-instances", "T3-export", "T4-export-page", "T7-settings", "T9-devmode-write",
    ])
    expect(diagnosticsFor("dev", "production").map((entry) => entry.test)).not.toContain("T9-devmode-write")
  })

  it("labels every test", () => {
    for (const entry of diagnosticsFor("figma", "development").concat(diagnosticsFor("dev", "development"))) {
      expect(entry.label).toMatch(/^T\d+ /)
      expect(entry.hint.length).toBeGreaterThan(10)
    }
  })
})

describe("messageFor", () => {
  it("maps each test to its message type", () => {
    expect(messageFor("T1-check", "c1")).toEqual({ type: "diagnostics-read", requestId: "c1", test: "T1-check" })
    expect(messageFor("T5-fonts", "c2")).toEqual({ type: "diagnostics-write", requestId: "c2", test: "T5-fonts" })
    expect(messageFor("T9-devmode-write", "c3")).toEqual({ type: "diagnostics-devmode-probe", requestId: "c3" })
  })
})

describe("reports", () => {
  it("replaces binary samples by their size in the printable JSON", () => {
    const report = { test: "T3-export", jpgSample: new Uint8Array(5), exports: [] }
    expect(JSON.parse(printableReport(report))).toEqual({ test: "T3-export", jpgSample: { bytes: 5 }, exports: [] })
    expect(jpgSampleOf(report)).toBeInstanceOf(Uint8Array)
    expect(jpgSampleOf({ jpgSample: null })).toBeNull()
    expect(jpgSampleOf("x")).toBeNull()
  })

  it("adds the user agent to T10 and the corner pixel to T3", () => {
    const facts = { userAgent: "Figma/1", cornerPixel: { r: 255, g: 255, b: 255, a: 255 } }
    expect(withUiFacts("T10-environment", { test: "T10-environment" }, facts)).toEqual({ test: "T10-environment", userAgent: "Figma/1" })
    expect(withUiFacts("T3-export", { test: "T3-export" }, facts)).toEqual({ test: "T3-export", jpgCornerPixel: facts.cornerPixel })
    expect(withUiFacts("T1-check", { test: "T1-check" }, facts)).toEqual({ test: "T1-check" })
    expect(withUiFacts("T10-environment", null, facts)).toBeNull()
  })

  it("cannot decode images without browser APIs", async () => {
    expect(await cornerPixel(new Uint8Array([0xff, 0xd8]), "image/jpeg")).toBeNull()
  })
})

describe("runNetworkCheck", () => {
  it("reports status, CORS outcome and latency", async () => {
    let clock = 1000
    const now = () => clock
    const ok = await runNetworkCheck(async () => {
      clock += 42
      return { api_version: 1 }
    }, "http://localhost:8080", now)
    expect(ok).toEqual({ test: "network-check", apiBase: "http://localhost:8080", ok: true, status: 200, cors: "ok", latencyMs: 42, meta: { api_version: 1 }, error: null })

    const blocked = await runNetworkCheck(async () => Promise.reject(Object.assign(new Error("Can't reach ReRune."), { status: 0 })), "x", now)
    expect(blocked).toMatchObject({ ok: false, status: 0, cors: "failed", error: "Can't reach ReRune." })

    const server = await runNetworkCheck(async () => Promise.reject(Object.assign(new Error("Bad Gateway"), { status: 502 })), "x", now)
    expect(server).toMatchObject({ ok: false, status: 502, cors: "ok" })
  })
})
