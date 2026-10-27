import { createApiClient, type FetchLike } from "./client"
import { createFigmaApi, type FigmaApi } from "./figma-api"

// The API as the plugin iframe uses it: window fetch, the stored plugin token, and a callback for any 401 on a
// request sent with that token (§7.19, §7.20). Shared by the Design-mode app and the Dev Mode inspect panel.

const browserFetch: FetchLike = (url, request) => fetch(url, request)

export function createBrowserApi(apiBase: string, getToken: () => string | null, onUnauthorized: () => void): FigmaApi {
  return createFigmaApi(createApiClient({ apiBase, fetch: browserFetch, getToken, onUnauthorized }))
}
