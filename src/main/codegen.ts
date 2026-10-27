import { CODEGEN_PLATFORMS, codegenCode, isCodegenPlatform, MORE_KEYS_LINE, oneLine, platformInfo, type CodegenKey, type CodegenPlatform } from "../codegen/snippets"
import { CODEGEN_MAX_KEYS, CODEGEN_WALK_BUDGET_MS } from "../shared/constants"
import { readCodegenCache, type CodegenCache } from "./auth-storage"
import { readLinkInfo } from "./links"
import { createNodeCaches, isTextNode, type NodeCaches } from "./node-utils"
import { readFileSettings } from "./settings"

// Codegen (§7.17, D31): no network, no preferences. Reads only plugin data and the clientStorage value cache
// (filled by the inspect panel and Design-mode loads) and answers with the snippets of the chosen platform.

export const DIAGNOSTICS_LANGUAGE = "rerune-diagnostics"
export const NO_KEY_CODE = "No ReRune key is linked to this layer."
export { MORE_KEYS_LINE }

export interface LinkedKey { keyId: string; projectId: string; k: string }
export interface LinkedKeys { keys: LinkedKey[]; more: boolean; complete: boolean }

const LINKED_STATES = ["ok", "inherited", "copied"]
const SLEEP_NAME = /^sleep:(\d+(?:\.\d+)?)$/

function linkedKeyOf(node: TextNode, caches: NodeCaches): LinkedKey | null {
  const info = readLinkInfo(node, caches)
  if (info.link === null || !LINKED_STATES.includes(info.state)) {
    return null
  }
  return { keyId: info.link.id, projectId: info.link.p, k: info.link.k }
}

// TEXT → its key; container → linked text under it, deduplicated by key, stopping after 1.5 s or 50 keys.
export function collectLinkedKeys(node: SceneNode, now: () => number = Date.now): LinkedKeys {
  const caches = createNodeCaches()
  if (isTextNode(node)) {
    const key = linkedKeyOf(node, caches)
    return { keys: key === null ? [] : [key], more: false, complete: true }
  }
  const deadline = now() + CODEGEN_WALK_BUDGET_MS
  const keys: LinkedKey[] = []
  const seen = new Set<string>()
  const stack: SceneNode[] = "children" in node ? (node as SceneNode & ChildrenMixin).children.slice().reverse() : []
  while (stack.length > 0) {
    if (now() > deadline) {
      return { keys, more: true, complete: false }
    }
    const current = stack.pop() as SceneNode
    try {
      if (current.removed || current.visible === false) {
        continue
      }
      if (isTextNode(current)) {
        const key = linkedKeyOf(current, caches)
        if (key !== null && !seen.has(key.keyId)) {
          if (keys.length >= CODEGEN_MAX_KEYS) {
            return { keys, more: true, complete: false }
          }
          seen.add(key.keyId)
          keys.push(key)
        }
      } else if ("children" in current) {
        const children = (current as SceneNode & ChildrenMixin).children
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push(children[index])
        }
      }
    } catch {
      // Nodes that cannot be read are left out of the generated code.
    }
  }
  return { keys, more: false, complete: true }
}

// Phase 1 output, kept for a language value the manifest does not list: key names as PLAINTEXT.
export function keyLines(keys: readonly LinkedKey[], caches: ReadonlyMap<string, CodegenCache>, more: boolean): string[] {
  const lines: string[] = []
  for (const key of keys) {
    const cached = caches.get(key.projectId)?.[key.keyId]
    const sourceText = cached === undefined ? "" : oneLine(cached.sourceText)
    if (sourceText !== "") {
      lines.push("// " + sourceText)
    }
    lines.push(cached === undefined ? key.k : cached.k)
  }
  if (more) {
    lines.push(MORE_KEYS_LINE)
  }
  return lines
}

// Key name, placeholders and source text per key: the cache's entry when present (renames in ReRune reach codegen
// through it), else the link's key name with no known placeholders.
export function codegenKeys(keys: readonly LinkedKey[], caches: ReadonlyMap<string, CodegenCache>): { keys: CodegenKey[]; uncached: boolean } {
  let uncached = false
  const result = keys.map((key) => {
    const cached = caches.get(key.projectId)?.[key.keyId]
    if (cached === undefined) {
      uncached = true
      return { name: key.k, placeholders: [], sourceText: null }
    }
    return { name: cached.k, placeholders: cached.placeholders, sourceText: cached.sourceText }
  })
  return { keys: result, uncached }
}

// The project cache is read once per generate call (memoised per project id).
async function readCaches(keys: readonly LinkedKey[]): Promise<Map<string, CodegenCache>> {
  const result = new Map<string, CodegenCache>()
  for (const key of keys) {
    if (!result.has(key.projectId)) {
      try {
        result.set(key.projectId, await readCodegenCache(key.projectId))
      } catch {
        result.set(key.projectId, {})
      }
    }
  }
  return result
}

function noKeyResult(): CodegenResult[] {
  return [{ title: "ReRune", language: "PLAINTEXT", code: NO_KEY_CODE }]
}

export async function generateKeyNames(node: SceneNode): Promise<CodegenResult[]> {
  const linked = collectLinkedKeys(node)
  if (linked.keys.length === 0 && linked.complete) {
    return noKeyResult()
  }
  const caches = await readCaches(linked.keys)
  return [{ title: "ReRune keys", language: "PLAINTEXT", code: keyLines(linked.keys, caches, linked.more).join("\n") }]
}

// Snippets of the selected keys for one platform (§7.17 table), one block per key.
export async function generateSnippets(node: SceneNode, platform: CodegenPlatform): Promise<CodegenResult[]> {
  const linked = collectLinkedKeys(node)
  if (linked.keys.length === 0 && linked.complete) {
    return noKeyResult()
  }
  const caches = await readCaches(linked.keys)
  const { keys, uncached } = codegenKeys(linked.keys, caches)
  return [{ title: "ReRune keys", language: platformInfo(platform).language, code: codegenCode(platform, keys, { more: linked.more, uncached }) }]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// T6 (development builds only): environment values in codegen mode and the handler's own cost. A selected
// layer named sleep:<n> waits n seconds first, to measure the real generate timeout.
export async function diagnosticsReport(node: SceneNode): Promise<CodegenResult[]> {
  const started = Date.now()
  const match = SLEEP_NAME.exec(node.name)
  const sleepSeconds = match === null ? 0 : Number(match[1])
  if (sleepSeconds > 0) {
    await sleep(sleepSeconds * 1000)
  }
  const buildStarted = Date.now()
  const linked = collectLinkedKeys(node)
  const projectId = readFileSettings().settings?.projectId ?? linked.keys[0]?.projectId ?? null
  const cacheStarted = Date.now()
  let cacheEntries = 0
  if (projectId !== null) {
    try {
      cacheEntries = Object.keys(await readCodegenCache(projectId)).length
    } catch {
      cacheEntries = -1
    }
  }
  const cacheMs = Date.now() - cacheStarted
  const caches = await readCaches(linked.keys)
  const built = codegenKeys(linked.keys, caches)
  for (const platform of CODEGEN_PLATFORMS) {
    codegenCode(platform.value, built.keys, { more: linked.more, uncached: built.uncached })
  }
  const buildMs = Date.now() - buildStarted - cacheMs
  const lines = [
    "ReRune diagnostics (T6-codegen)",
    "figma.command: " + JSON.stringify(figma.command),
    "figma.mode: " + JSON.stringify(figma.mode),
    "figma.editorType: " + JSON.stringify(figma.editorType),
    "figma.apiVersion: " + JSON.stringify(figma.apiVersion),
    "skipInvisibleInstanceChildren: " + String(figma.skipInvisibleInstanceChildren),
    "selection: " + JSON.stringify(node.name) + " (" + node.type + ")",
    "slept seconds: " + String(sleepSeconds),
    "cache read ms: " + String(cacheMs) + " (project " + (projectId ?? "none") + ", entries " + String(cacheEntries) + ")",
    "snippet build ms: " + String(buildMs) + " (keys " + String(linked.keys.length) + (linked.more ? ", more not shown" : "") + ")",
    "handler total ms: " + String(Date.now() - started),
    "pluginVersion: " + __PLUGIN_VERSION__,
  ]
  return [{ title: "ReRune diagnostics", language: "PLAINTEXT", code: lines.join("\n") }]
}

export async function generateCode(event: CodegenEvent, env: "production" | "development" = __RERUNE_ENV__): Promise<CodegenResult[]> {
  if (event.language === DIAGNOSTICS_LANGUAGE && env === "development") {
    return diagnosticsReport(event.node)
  }
  if (isCodegenPlatform(event.language)) {
    return generateSnippets(event.node, event.language)
  }
  return generateKeyNames(event.node)
}

export function registerCodegen(): void {
  figma.codegen.on("generate", (event) => generateCode(event))
}
