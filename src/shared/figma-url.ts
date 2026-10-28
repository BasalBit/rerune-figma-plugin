// Figma URLs (Appendix A.2, identical to the server's figma_url.go). Hand-written instead of `URL`, because the
// main thread has no URL API; the UI uses it for the pasted file link (§7.7) and for deep links.

export interface ParsedFigmaUrl {
  fileKey: string                 // the first key: the file's identity, also in a branch URL
  branchKey: string | null        // the branch key of a branch URL (FileSettings.branchKey, D43)
  nodeId: string | null           // `node-id` as a Figma node id, or null when absent or malformed
  slug: string                    // URL-decoded, `-` → space, trimmed
}

export const FIGMA_FILE_KEY_PATTERN = /^[A-Za-z0-9]{6,128}$/
export const FIGMA_NODE_ID_PATTERN = /^I?\d+:\d+(;\d+:\d+)*$/
export const FIGMA_PAGE_ID_PATTERN = /^\d+:\d+$/
export const FIGMA_NODE_ID_MAX_CHARS = 512
export const FIGMA_SLUG_MAX_CHARS = 100

const FIGMA_HOSTS = ["figma.com", "www.figma.com"]
const FILE_TYPES = ["design", "file", "proto", "board", "slides"]
const SCHEME = "https://"

// Node and non-empty frame ids on the wire (§4.0).
export function isFigmaNodeId(value: string): boolean {
  return value.length <= FIGMA_NODE_ID_MAX_CHARS && FIGMA_NODE_ID_PATTERN.test(value)
}

export function isFigmaPageId(value: string): boolean {
  return FIGMA_PAGE_ID_PATTERN.test(value)
}

export function isFigmaFileKey(value: string): boolean {
  return FIGMA_FILE_KEY_PATTERN.test(value)
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

// `node-id` from the query: the first occurrence, URL-decoded ("+" is a space in a query); without a ":" every "-"
// becomes ":". Anything that is not a node id afterwards counts as absent.
function nodeIdOf(query: string): string | null {
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=")
    const name = decode((equals === -1 ? pair : pair.slice(0, equals)).replace(/\+/g, " "))
    if (name !== "node-id") {
      continue
    }
    const raw = decode((equals === -1 ? "" : pair.slice(equals + 1)).replace(/\+/g, " "))
    if (raw === null) {
      return null
    }
    const value = raw.includes(":") ? raw : raw.replace(/-/g, ":")
    return isFigmaNodeId(value) ? value : null
  }
  return null
}

// https://(www.)figma.com/(design|file|proto|board|slides)/<key>[/branch/<branchKey>][/<slug>]; null when the
// text is not such a link.
export function parseFigmaUrl(input: string): ParsedFigmaUrl | null {
  let rest = input.trim()
  if (rest.slice(0, SCHEME.length).toLowerCase() !== SCHEME) {
    return null
  }
  rest = rest.slice(SCHEME.length)
  const hash = rest.indexOf("#")
  if (hash !== -1) {
    rest = rest.slice(0, hash)
  }
  const question = rest.indexOf("?")
  const query = question === -1 ? "" : rest.slice(question + 1)
  if (question !== -1) {
    rest = rest.slice(0, question)
  }
  const slash = rest.indexOf("/")
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  if (!FIGMA_HOSTS.includes(host) || slash === -1) {
    return null
  }
  const raw = rest.slice(slash + 1).split("/")
  if (raw.length > 1 && raw[raw.length - 1] === "") {
    raw.pop()
  }
  const segments: string[] = []
  for (const segment of raw) {
    const decoded = decode(segment)
    if (decoded === null || decoded === "") {
      return null
    }
    segments.push(decoded)
  }
  if (segments.length < 2 || !FILE_TYPES.includes(segments[0]) || !isFigmaFileKey(segments[1])) {
    return null
  }
  let tail = segments.slice(2)
  let branchKey: string | null = null
  if (tail.length >= 2 && tail[0] === "branch") {
    if (!isFigmaFileKey(tail[1])) {
      return null
    }
    branchKey = tail[1]
    tail = tail.slice(2)
  }
  if (tail.length > 1) {
    return null
  }
  return {
    fileKey: segments[1],
    branchKey,
    nodeId: nodeIdOf(query),
    slug: tail.length === 0 ? "" : tail[0].replace(/-/g, " ").trim(),
  }
}

// Slug of a file name: every run outside [A-Za-z0-9] becomes "-", trimmed of "-", cut to 100 chars, "file" if empty.
export function figmaSlug(fileName: string): string {
  const slug = fileName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, FIGMA_SLUG_MAX_CHARS)
  return slug === "" ? "file" : slug
}

// Canonical file URL: https://www.figma.com/design/<file_key>/<slug>.
export function canonicalFileUrl(fileKey: string, fileName: string): string {
  return fileKeyUrl(fileKey) + "/" + figmaSlug(fileName)
}

// The file's URL without a slug (A.2 parses it with an empty slug), for requests that must not carry a file name.
export function fileKeyUrl(fileKey: string): string {
  return "https://www.figma.com/design/" + fileKey
}

// Node link: the canonical URL + ?node-id= with ":" → "-" and ";" → "%3B".
export function figmaNodeUrl(fileKey: string, fileName: string, nodeId: string): string {
  return canonicalFileUrl(fileKey, fileName) + "?node-id=" + nodeId.replace(/:/g, "-").replace(/;/g, "%3B")
}
