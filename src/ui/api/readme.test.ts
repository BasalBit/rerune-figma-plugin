/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import readme from "../../../README.md?raw"
import type { ApiClient, HttpMethod } from "./client"
import { createFigmaApi, type FigmaApi, type ScreenshotUpload } from "./figma-api"

// The README's "ReRune API" table must list exactly the endpoints the plugin calls: the README's privacy section
// points to it. Endpoints of figma-api.ts the UI never calls (the dashboard's pairing endpoints, the file list and
// delete) must not be listed.

const UPLOAD: ScreenshotUpload = {
  image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  contentType: "image/jpeg",
  fileName: "1_1.jpg",
  meta: { file_key: "AbCdEf1234567890XyZ", frame_id: "1:1", frame_name: "Checkout", page_id: "0:1", page_name: "Page 1", width: 1, height: 1, boxes: [] },
}
const P = "{project_id}"

// One call per FigmaApi method with placeholder path parameters: the recorded path is the README's form.
const CALLS: Record<keyof FigmaApi, (api: FigmaApi) => Promise<unknown>> = {
  meta: (api) => api.meta(),
  createSession: (api) => api.createSession(),
  pollSession: (api) => api.pollSession("{session_id}", "secret"),
  pairingCode: (api) => api.pairingCode("{code}", "session"),
  approveCode: (api) => api.approveCode("{code}", "session"),
  denyCode: (api) => api.denyCode("{code}", "session"),
  logout: (api) => api.logout("token"),
  projects: (api) => api.projects(),
  project: (api) => api.project(P),
  searchKeys: (api) => api.searchKeys(P, { q: "pay" }),
  keysByName: (api) => api.keysByName(P, { names: ["a"] }),
  resolveKeys: (api) => api.resolveKeys(P, { key_ids: [], languages: ["en"], source: "draft", variation_option_id: null }),
  push: (api) => api.push(P, { file_key: null, items: [] }),
  registerFile: (api) => api.registerFile(P, { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/File" }),
  files: (api) => api.files(P),
  deleteFile: (api) => api.deleteFile(P, "{file_key}"),
  upsertLinks: (api) => api.upsertLinks(P, { file_key: "AbCdEf1234567890XyZ", upserts: [], removed_node_ids: [] }),
  links: (api) => api.links(P, { file_key: "AbCdEf1234567890XyZ" }),
  uploadScreenshot: (api) => api.uploadScreenshot(P, UPLOAD),
  screenshots: (api) => api.screenshots(P, { file_key: "AbCdEf1234567890XyZ", refresh_requested: true }),
  cancelRefreshRequest: (api) => api.cancelRefreshRequest(P, "{screenshot_id}"),
}

async function endpointOf(method: keyof FigmaApi): Promise<string> {
  const calls: { method: HttpMethod; path: string }[] = []
  const client: ApiClient = {
    apiBase: "http://localhost:8080",
    request: async <T>(httpMethod: HttpMethod, path: string) => {
      calls.push({ method: httpMethod, path: decodeURIComponent(path) })
      return {} as T
    },
  }
  await CALLS[method](createFigmaApi(client))
  expect(calls).toHaveLength(1)
  return calls[0].method + " " + calls[0].path
}

// Production UI sources, to find which API methods the plugin calls (`api.resolveKeys(…)`).
const uiSources = import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../state/test-fakes.ts", "!./figma-api.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
})
const used = new Set(Object.values(uiSources).flatMap((source) => [...source.matchAll(/\bapi\.(\w+)\(/g)].map((match) => match[1])))
const METHODS = Object.keys(CALLS) as (keyof FigmaApi)[]

describe("README: ReRune API table", () => {
  it("knows which API methods the UI calls", () => {
    expect([...used].filter((name) => !METHODS.includes(name as keyof FigmaApi))).toEqual([])
    expect(METHODS.filter((method) => !used.has(method)).sort()).toEqual(["approveCode", "deleteFile", "denyCode", "files", "pairingCode"])
  })

  it.each(METHODS.filter((method) => used.has(method)))("lists the endpoint of %s", async (method) => {
    expect(readme).toContain("| `" + (await endpointOf(method)) + "` |")
  })

  it.each(METHODS.filter((method) => !used.has(method)))("does not list the endpoint of %s, which the plugin never calls", async (method) => {
    expect(readme).not.toContain("`" + (await endpointOf(method)) + "`")
  })

  it("has one row per endpoint the plugin calls", () => {
    const rows = [...readme.matchAll(/^\| `(GET|POST|PUT|DELETE) (\/figma\/[^`]+)` \|/gm)]
    expect(rows).toHaveLength(METHODS.filter((method) => used.has(method)).length)
  })
})
