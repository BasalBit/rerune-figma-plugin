import { describe, expect, it } from "vitest"
import type { FigmaScreenshotMeta } from "../../shared/api-types"
import { createApiClient, type ApiClient, type ApiRequestOptions, type HttpMethod } from "./client"
import { createFigmaApi, screenshotForm, searchQuery, type ScreenshotUpload } from "./figma-api"

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
      { method: "POST", path: "/figma/auth/sessions", options: { auth: false, json: {}, retry: "none" } },
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

  it("builds the file and link requests (E14–E18)", async () => {
    const { api, calls } = recorder()
    await api.registerFile(PROJECT, { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter", file_name: "Chapter" })
    await api.registerFile(PROJECT, { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter" })
    await api.files(PROJECT)
    await expect(api.deleteFile(PROJECT, "AbCdEf1234567890XyZ")).resolves.toBeUndefined()
    const upserts = [{ node_id: "12:345", key_id: "6a48", frame_id: "10:1", frame_name: "Checkout", page_id: "0:1", page_name: "Mobile", node_name: "Pay" }]
    await api.upsertLinks(PROJECT, { file_key: "AbCdEf1234567890XyZ", upserts, removed_node_ids: ["12:999"] })
    await api.links(PROJECT, { file_key: "AbCdEf1234567890XyZ", page_id: "0:1", limit: 500 })
    await api.links(PROJECT, { file_key: "AbCdEf1234567890XyZ", page_id: "0:1", cursor: "eyJ2IjoxfQ", limit: 500 })
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/figma/projects/" + PROJECT + "/files",
        options: { json: { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter", file_name: "Chapter" }, retry: "read" },
      },
      { method: "PUT", path: "/figma/projects/" + PROJECT + "/files", options: { json: { url: "https://www.figma.com/design/AbCdEf1234567890XyZ/Chapter" }, retry: "read" } },
      { method: "GET", path: "/figma/projects/" + PROJECT + "/files", options: {} },
      { method: "DELETE", path: "/figma/projects/" + PROJECT + "/files/AbCdEf1234567890XyZ", options: {} },
      {
        method: "PUT",
        path: "/figma/projects/" + PROJECT + "/links",
        options: { json: { file_key: "AbCdEf1234567890XyZ", upserts, removed_node_ids: ["12:999"] }, retry: "read" },
      },
      {
        method: "GET",
        path: "/figma/projects/" + PROJECT + "/links",
        options: { query: { file_key: "AbCdEf1234567890XyZ", frame_id: null, page_id: "0:1", key_id: null, cursor: null, limit: 500 } },
      },
      {
        method: "GET",
        path: "/figma/projects/" + PROJECT + "/links",
        options: { query: { file_key: "AbCdEf1234567890XyZ", frame_id: null, page_id: "0:1", key_id: null, cursor: "eyJ2IjoxfQ", limit: 500 } },
      },
    ])
  })

  it("uploads a screenshot as multipart (E19) and never retries it in the client", async () => {
    const { api, calls } = recorder({ screenshot: {}, unchanged_image: false, dropped_boxes: [] })
    await api.uploadScreenshot(PROJECT, UPLOAD)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "POST", path: "/figma/projects/" + PROJECT + "/screenshots", options: { retry: "none" } })
    expect(calls[0].options.form).toBeInstanceOf(FormData)
    expect(calls[0].options.json).toBeUndefined()
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

const META: FigmaScreenshotMeta = {
  file_key: "AbCdEf1234567890XyZ",
  frame_id: "I10:1;2:3",
  frame_name: "Checkout",
  page_id: "0:1",
  page_name: "Mobile",
  width: 2,
  height: 1,
  boxes: [{ key_id: "6a4800000000000000000001", node_id: "12:345", x: 0, y: 0, w: 1, h: 1 }],
}

const UPLOAD: ScreenshotUpload = { image: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "I10_1_2_3.png", meta: META }

describe("screenshotForm (E19 parts, §7.16)", () => {
  it("sends the image under its type and file name and meta as a JSON blob", async () => {
    const form = screenshotForm(UPLOAD)
    const image = form.get("image") as File
    expect(image.name).toBe("I10_1_2_3.png")
    expect(image.type).toBe("image/png")
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    const meta = form.get("meta") as File
    expect(meta.type).toBe("application/json")
    expect(JSON.parse(await meta.text())).toEqual(META)
    expect([...form.keys()]).toEqual(["image", "meta"])
  })

  it("copies only the bytes of the view", async () => {
    const buffer = new Uint8Array([9, 9, 1, 2, 9]).buffer
    const form = screenshotForm({ ...UPLOAD, image: new Uint8Array(buffer, 2, 2) })
    expect(new Uint8Array(await (form.get("image") as File).arrayBuffer())).toEqual(new Uint8Array([1, 2]))
  })

  it("goes out with the plugin token and lets fetch set the multipart content type", async () => {
    const seen: RequestInit[] = []
    const client = createApiClient({
      apiBase: "http://localhost:8080",
      getToken: () => "rrf_" + "a".repeat(64),
      fetch: async (_url, init) => {
        seen.push(init)
        return new Response(JSON.stringify({ screenshot: {}, unchanged_image: true, dropped_boxes: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
      },
    })
    const response = await createFigmaApi(client).uploadScreenshot(PROJECT, UPLOAD)
    expect(response.unchanged_image).toBe(true)
    const headers = seen[0].headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer rrf_" + "a".repeat(64))
    expect(headers["Content-Type"]).toBeUndefined()
    expect(seen[0].body).toBeInstanceOf(FormData)
  })
})
