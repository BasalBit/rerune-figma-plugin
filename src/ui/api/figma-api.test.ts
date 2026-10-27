import { describe, expect, it } from "vitest"
import type { ApiClient, ApiRequestOptions, HttpMethod } from "./client"
import { createFigmaApi, searchQuery } from "./figma-api"

interface Recorded { method: HttpMethod; path: string; options: ApiRequestOptions }

function recorder(response: unknown = {}) {
  const calls: Recorded[] = []
  const client: ApiClient = {
    apiBase: "http://localhost:8080",
    request: async <T>(method: HttpMethod, path: string, options: ApiRequestOptions = {}) => {
      calls.push({ method, path, options })
      return response as T
    },
  }
  return { api: createFigmaApi(client), calls }
}

const PROJECT = "6a4600000000000000000c35"

describe("createFigmaApi", () => {
  it("calls the public pairing endpoints without the plugin token", async () => {
    const { api, calls } = recorder()
    await api.meta()
    await api.createSession()
    await api.pollSession("671e2a9f4c1d2b3a4f5e6d7c", "ab".repeat(32))
    expect(calls).toEqual([
      { method: "GET", path: "/figma/meta", options: { auth: false } },
      { method: "POST", path: "/figma/auth/sessions", options: { auth: false, json: {}, retry: "rate" } },
      { method: "POST", path: "/figma/auth/sessions/671e2a9f4c1d2b3a4f5e6d7c/poll", options: { auth: false, json: { poll_secret: "ab".repeat(32) }, retry: "none" } },
    ])
  })

  it("addresses pairing codes canonically and encoded, with the session bearer", async () => {
    const { api, calls } = recorder()
    await api.pairingCode("k7p-4qx", "kc-session")
    await api.approveCode("K7P-4QX", "kc-session")
    await api.denyCode("K7P 4QX", "kc-session")
    await api.pairingCode("bad/code", "kc-session")
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/figma/auth/codes/K7P4QX"],
      ["POST", "/figma/auth/codes/K7P4QX/approve"],
      ["POST", "/figma/auth/codes/K7P4QX/deny"],
      ["GET", "/figma/auth/codes/bad%2Fcode"],
    ])
    expect(calls.every((call) => call.options.bearer === "kc-session")).toBe(true)
    expect(calls[1].options.json).toEqual({})
  })

  it("logs out with an explicit token and an empty body", async () => {
    const { api, calls } = recorder()
    await expect(api.logout("rrf_token")).resolves.toBeUndefined()
    expect(calls).toEqual([{ method: "POST", path: "/figma/auth/logout", options: { bearer: "rrf_token", json: {}, retry: "none" } }])
  })

  it("builds project, search, by-name, resolve and push requests", async () => {
    const { api, calls } = recorder()
    await api.projects()
    await api.project(PROJECT)
    await api.searchKeys(PROJECT, { q: "  Pay now ", cursor: "eyJ2IjoxfQ", limit: 20 })
    await api.keysByName(PROJECT, { texts: ["Pay now"] })
    await api.resolveKeys(PROJECT, { key_ids: ["6a48"], languages: ["de"], source: "draft", variation_option_id: null })
    await api.push(PROJECT, { file_key: null, items: [] })
    expect(calls[0]).toEqual({ method: "GET", path: "/figma/projects", options: {} })
    expect(calls[1]).toEqual({ method: "GET", path: "/figma/projects/" + PROJECT, options: {} })
    expect(calls[2]).toEqual({
      method: "GET",
      path: "/figma/projects/" + PROJECT + "/keys/search",
      options: { query: { q: "Pay now", cursor: "eyJ2IjoxfQ", limit: 20 } },
    })
    expect(calls[3]).toEqual({ method: "POST", path: "/figma/projects/" + PROJECT + "/keys/by-name", options: { json: { names: [], texts: ["Pay now"] }, retry: "read" } })
    expect(calls[4].path).toBe("/figma/projects/" + PROJECT + "/keys/resolve")
    expect(calls[4].options).toEqual({ json: { key_ids: ["6a48"], languages: ["de"], source: "draft", variation_option_id: null }, retry: "read" })
    expect(calls[5]).toEqual({ method: "POST", path: "/figma/projects/" + PROJECT + "/push", options: { json: { file_key: null, items: [] }, retry: "none" } })
  })

  it("encodes path segments", async () => {
    const { api, calls } = recorder()
    await api.project("a/b")
    expect(calls[0].path).toBe("/figma/projects/a%2Fb")
  })

  it("cuts search queries to 100 runes after trimming", () => {
    expect(searchQuery("  x ")).toBe("x")
    expect(searchQuery("😀".repeat(150))).toBe("😀".repeat(100))
  })
})
