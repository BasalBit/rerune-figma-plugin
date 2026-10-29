import type { FigmaResolvedKey } from "../../shared/api-types"
import type { ScannedNode, Scope } from "../../shared/messages"
import type { RemoteWithMaxLength } from "../../shared/push-plan"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { isLinkedForCreate } from "./link"
import { ScanCancelledError, type ScanResult, type ScanRunner } from "./ops"
import { linkedKeyIds, loadRemoteStates, resolveChunkSize } from "./remote"
import type { WatchFetch } from "./request-watch"
import { createStore, type Store } from "./store"

// The scanned layers of the current scope plus their remote state (E12), shared by Layers, Push and Preview.
// Pending creates ("Create new key" in the Link dialog, §7.11) live here until the push links the layers. While the
// plugin is open, the keys' values are read again in the background (refreshKeys, on the schedule of
// request-watch.ts) without scanning the scope: only the layers of a key that changed in ReRune are read again from
// the canvas, so one edited in Figma since the scan shows as changed in both. Actions that know what they wrote (a
// pull, Take ReRune text, an Overwrite, Update screenshots) change the shown layers at once (applyChanges), so every
// tab's states follow.

export type ScanStatus = "idle" | "scanning" | "ready" | "error"
export type RemoteStatus = "idle" | "loading" | "ready" | "error"

export interface WorkspaceState {
  scope: Scope
  status: ScanStatus
  progress: number
  result: ScanResult | null
  error: string | null
  remote: Map<string, RemoteWithMaxLength>
  resolved: Map<string, FigmaResolvedKey>
  remoteStatus: RemoteStatus
  remoteError: string | null
  pending: Map<string, string>
  // Counts shown scans and clears. A background read or an action's change keeps it: the layers are the same scan.
  scanId: number
}

export interface WorkspaceProject { id: string; main_language: string }

// What an action wrote, as it knows it: the text a layer shows now (absent: its text did not change) and the src its
// link got (text-apply and the push's follow-up links write both), and the main text of keys it pushed.
export interface LayerWrite { nodeId: string; text?: string; src: string }
export interface WorkspaceChange { layers: readonly LayerWrite[]; mainTexts?: ReadonlyMap<string, string> }

export interface KeyRefreshOptions {
  // Default: the keys of the shown scan's links, at most REMOTE_REFRESH_MAX_CALLS calls' worth per read, the next
  // ones each time.
  keyIds?: readonly string[]
  chunkSize?: number           // keys per E12 call (E1 max_batch_size, at most 100)
}

// The ceiling of one background read: 5 E12 calls, 2 at a time (500 keys with E1's max_batch_size of 100, fewer
// with a smaller one). A scan with more keys is read in turns (the next ones each round), so every key is read again
// within a few minutes and no round sends more calls.
export const REMOTE_REFRESH_MAX_CALLS = 5
export const REMOTE_REFRESH_IN_FLIGHT = 2

export function refreshMaxKeys(chunkSize?: number): number {
  return REMOTE_REFRESH_MAX_CALLS * resolveChunkSize(chunkSize)
}

export interface WorkspaceDeps {
  scanner: ScanRunner
  api: Pick<FigmaApi, "resolveKeys">
  project(): WorkspaceProject | null
}

export interface Workspace {
  store: Store<WorkspaceState>
  scan(scope?: Scope): Promise<ScanResult | null>
  // A scan whose result is not shown (the automatic page link sync, §7.7): scope, list and status stay. Scans share
  // one runner, so it returns null while a shown scan runs, and a later scan or clear() cancels it (null).
  scanDetached(scope: Scope): Promise<ScanResult | null>
  // A detached scan of the frames ReRune asks new screenshots of (screenshot freshness, contract §6.4 step 2), with
  // the file's scan filters; the frames not in the file come back in `missingFrameIds`. Same rules as scanDetached,
  // except that a page change keeps it: it reads the frames on whichever page they are.
  scanFrames(frameIds: readonly string[]): Promise<ScanResult | null>
  // The same for text layers by id (a conflict's layers before Overwrite): those deleted or hidden are left out.
  scanNodes(nodeIds: readonly string[]): Promise<ScanResult | null>
  // A shown scan of these text layers by id, wherever the selection is now, with their remote state: the layers of a
  // Push review before a push or a pull and after a push. The scope stays; layers deleted or hidden are left out.
  scanLayers(nodeIds: readonly string[]): Promise<ScanResult | null>
  refreshRemote(): Promise<void>
  // Reads the keys' ReRune values again (E12) without scanning and without a loading state: a change shows in every
  // tab, an error keeps what is shown ("failed" tells the schedule to wait). An answer older than a scan, a clear, a
  // project or main language change, or a later change of the same key is dropped. "skipped" while the workspace loads
  // the remote state itself.
  refreshKeys(options?: KeyRefreshOptions): Promise<WatchFetch>
  // An action's outcome on the shown layers (see WorkspaceChange); returns the keys it touched, to read again.
  applyChanges(change: WorkspaceChange): string[]
  setScope(scope: Scope): void
  setPending(nodeIds: readonly string[], name: string | null): void
  // A page change (`clear()`) or another project or sign-out (`clear(true)`): the shown scan, its list and remote
  // state are dropped and the runner's scan is cancelled, apart from a scan of requested frames on a page change.
  clear(dropPending?: boolean): void
}

export const NO_MAIN_LANGUAGE = "This project needs exactly one main language before layers can sync."

export function emptyWorkspace(scope: Scope = "selection"): WorkspaceState {
  return {
    scope,
    status: "idle",
    progress: 0,
    result: null,
    error: null,
    remote: new Map(),
    resolved: new Map(),
    remoteStatus: "idle",
    remoteError: null,
    pending: new Map(),
    scanId: 0,
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// The shown layers after an action wrote them. An instance layer that inherits a written main component's link
// shows the main's new text and src too.
export function changedNodes(nodes: readonly ScannedNode[], layers: readonly LayerWrite[]): ScannedNode[] {
  const writes = new Map(layers.map((write) => [write.nodeId, write]))
  return nodes.map((node) => {
    const own = writes.get(node.nodeId)
    const main = node.linkState === "inherited" && node.link !== null ? writes.get(node.link.nid) : undefined
    const write = own ?? main
    if (write === undefined) {
      return node
    }
    const linked = node.link !== null && (node.linkState === "ok" || node.linkState === "inherited")
    return { ...node, characters: write.text ?? node.characters, link: linked && node.link !== null ? { ...node.link, src: write.src } : node.link }
  })
}

export function createWorkspace(deps: WorkspaceDeps, initialScope: Scope = "selection"): Workspace {
  const store = createStore<WorkspaceState>(emptyWorkspace(initialScope))
  let scanGeneration = 0
  let remoteGeneration = 0
  // Every scan the runner starts gets a number; `framesScan` is the number of the running scan of requested frames.
  let scans = 0
  let framesScan: number | null = null
  // Background reads and actions number their answers per key: an answer is applied only over older ones.
  let answers = 0
  const answered = new Map<string, number>()
  // Where the next background read of a scan with more keys than one read takes starts.
  let turn = { scanId: -1, offset: 0 }
  // Scans the runner runs now (shown or detached): a background read never starts one meanwhile, since a new scan
  // cancels the running one.
  let running = 0

  function keysToRefresh(all: readonly string[], scanId: number, max: number): string[] {
    if (all.length <= max) {
      return all.slice()
    }
    if (turn.scanId !== scanId || turn.offset >= all.length) {
      turn = { scanId, offset: 0 }
    }
    const ids = all.slice(turn.offset, turn.offset + max)
    turn = { scanId, offset: turn.offset + max }
    return ids
  }

  async function run(scope: Scope, onProgress?: (scanned: number) => void, nodeIds?: readonly string[]): Promise<ScanResult> {
    running++
    try {
      return await deps.scanner.run(scope, onProgress, nodeIds)
    } finally {
      running--
    }
  }

  // The layers of keys that changed in ReRune, read again from the canvas by id (no scan of the scope): null when
  // another scan runs (it would be cancelled) or this one was cancelled.
  async function layersAgain(nodeIds: readonly string[]): Promise<ScanResult | null> {
    if (nodeIds.length === 0 || running > 0 || store.get().status === "scanning") {
      return null
    }
    try {
      return await run("page", undefined, nodeIds)
    } catch {
      return null
    }
  }

  async function refreshKeys(options: KeyRefreshOptions = {}): Promise<WatchFetch> {
    const project = deps.project()
    const state = store.get()
    if (project === null || state.result === null || state.status !== "ready") {
      return { kind: "read" }
    }
    if (state.remoteStatus === "loading") {
      return { kind: "skipped" }
    }
    if (project.main_language === "") {
      // The project lost its main language: the layers can't sync, as after a scan.
      if (state.remoteError !== NO_MAIN_LANGUAGE) {
        store.set((current) => ({ ...current, remote: new Map(), resolved: new Map(), remoteStatus: "error", remoteError: NO_MAIN_LANGUAGE }))
      }
      return { kind: "read" }
    }
    const linked = linkedKeyIds(state.result.nodes, project.id)
    const wanted = options.keyIds === undefined ? null : new Set(options.keyIds)
    const ids = wanted === null ? keysToRefresh(linked, state.scanId, refreshMaxKeys(options.chunkSize)) : linked.filter((id) => wanted.has(id))
    if (ids.length === 0) {
      return { kind: "read" }
    }
    const whole = ids.length === linked.length
    const mine = ++answers
    const generation = remoteGeneration
    const scanId = state.scanId
    const { id: projectId, main_language: mainLanguage } = project
    const stale = () => {
      const now = deps.project()
      return generation !== remoteGeneration || store.get().scanId !== scanId || now?.id !== projectId || now.main_language !== mainLanguage
    }
    const load = await loadRemoteStates(deps.api, projectId, mainLanguage, ids, { chunkSize: options.chunkSize, inFlight: REMOTE_REFRESH_IN_FLIGHT })
    if (load.error !== null) {
      return { kind: "failed", error: load.error }
    }
    if (stale()) {
      return { kind: "read" }
    }
    // An answer is applied only over older ones: an action that wrote the key since knows better.
    const current = (id: string) => (answered.get(id) ?? 0) <= mine
    const before = store.get().remote
    const moved = new Set(ids.filter((id) => current(id) && load.remote.has(id) && !sameJson(before.get(id), load.remote.get(id))))
    const again = await layersAgain(
      (store.get().result?.nodes ?? []).filter((node) => node.link !== null && node.link.p === projectId && moved.has(node.link.id)).map((node) => node.nodeId),
    )
    if (stale()) {
      return { kind: "read" }
    }
    const fresh = new Map((again?.nodes ?? []).map((node) => [node.nodeId, node]))
    store.set((state) => {
      const remote = new Map(state.remote)
      const resolved = new Map(state.resolved)
      let changed = false
      for (const id of ids) {
        if (!current(id)) {
          continue
        }
        answered.set(id, mine)
        const next = load.remote.get(id)
        if (next !== undefined && !sameJson(remote.get(id), next)) {
          remote.set(id, next)
          changed = true
        }
        const key = load.resolved.get(id)
        if (key === undefined && resolved.delete(id)) {
          changed = true
        } else if (key !== undefined && !sameJson(resolved.get(id), key)) {
          resolved.set(id, key)
          changed = true
        }
      }
      // The layers read again show their text and link as they are now (an action since keeps its own).
      let nodes = state.result?.nodes ?? []
      if (fresh.size > 0) {
        const merged = nodes.map((node) => {
          const now = fresh.get(node.nodeId)
          return now === undefined || (node.link !== null && !current(node.link.id)) || sameJson(now, node) ? node : now
        })
        if (merged.some((node, index) => node !== nodes[index])) {
          nodes = merged
          changed = true
        }
      }
      // A read of every key that works also ends the error of a load that failed before.
      const recovered = whole && state.remoteStatus === "error"
      if (!changed && !recovered) {
        return state
      }
      const result = state.result === null || nodes === state.result.nodes ? state.result : { ...state.result, nodes }
      return { ...state, result, remote, resolved, ...(recovered ? { remoteStatus: "ready" as const, remoteError: null } : {}) }
    })
    return { kind: "read" }
  }

  function applyChanges(change: WorkspaceChange): string[] {
    const state = store.get()
    const result = state.result
    const project = deps.project()
    if (result === null || project === null) {
      return []
    }
    const nodes = changedNodes(result.nodes, change.layers)
    const touched = new Set<string>()
    const written = new Set(change.layers.map((write) => write.nodeId))
    for (const node of nodes) {
      if (node.link !== null && node.link.p === project.id && (written.has(node.nodeId) || written.has(node.link.nid))) {
        touched.add(node.link.id)
      }
    }
    const remote = new Map(state.remote)
    for (const [keyId, mainText] of change.mainTexts ?? []) {
      const entry = remote.get(keyId)
      if (entry !== undefined && entry.found) {
        remote.set(keyId, { ...entry, mainText })
      }
      touched.add(keyId)
    }
    // A background read that started before the action knows the old values of these keys: its answer is dropped.
    const mine = ++answers
    for (const keyId of touched) {
      answered.set(keyId, mine)
    }
    store.set((current) => (current.result !== result ? current : { ...current, result: { ...result, nodes }, remote }))
    return [...touched]
  }

  async function refreshRemote(): Promise<void> {
    const mine = ++remoteGeneration
    const project = deps.project()
    const result = store.get().result
    if (project === null || result === null) {
      return
    }
    if (project.main_language === "") {
      store.set((state) => ({ ...state, remote: new Map(), resolved: new Map(), remoteStatus: "error", remoteError: NO_MAIN_LANGUAGE }))
      return
    }
    const keyIds = linkedKeyIds(result.nodes, project.id)
    store.set((state) => ({ ...state, remoteStatus: keyIds.length === 0 ? "ready" : "loading", remoteError: null }))
    if (keyIds.length === 0) {
      store.set((state) => ({ ...state, remote: new Map(), resolved: new Map() }))
      return
    }
    const load = await loadRemoteStates(deps.api, project.id, project.main_language, keyIds)
    if (mine !== remoteGeneration) {
      return
    }
    store.set((state) => ({
      ...state,
      remote: load.remote,
      resolved: load.resolved,
      remoteStatus: load.error === null ? "ready" : "error",
      remoteError: load.error === null ? null : userMessage(load.error),
    }))
  }

  async function detached(scope: Scope, frameIds?: readonly string[]): Promise<ScanResult | null> {
    if (store.get().status === "scanning") {
      return null
    }
    const mine = ++scans
    framesScan = frameIds === undefined ? null : mine
    try {
      return await run(scope, undefined, frameIds)
    } catch (error) {
      if (error instanceof ScanCancelledError) {
        return null
      }
      throw error
    } finally {
      if (framesScan === mine) {
        framesScan = null
      }
    }
  }

  // A scan whose result is shown: of the scope, or (`nodeIds`) of these layers wherever they are.
  async function shown(target: Scope, nodeIds?: readonly string[]): Promise<ScanResult | null> {
    const mine = ++scanGeneration
    // The runner cancels the scan it runs, also one of requested frames.
    scans++
    framesScan = null
    store.set((state) => ({ ...state, scope: target, status: "scanning", progress: 0, error: null }))
    let result: ScanResult
    try {
      result = await run(
        target,
        (progress) => {
          // A scan by id reports each lookup (progress 0): only a new count is shown.
          if (mine === scanGeneration && store.get().progress !== progress) {
            store.set((state) => ({ ...state, progress }))
          }
        },
        nodeIds,
      )
    } catch (error) {
      if (error instanceof ScanCancelledError || mine !== scanGeneration) {
        return null
      }
      store.set((state) => ({ ...state, status: "error", error: userMessage(error) }))
      return null
    }
    if (mine !== scanGeneration) {
      return null
    }
    if (nodeIds !== undefined) {
      delete result.missingFrameIds
      delete result.hiddenFrameIds
    }
    store.set((state) => {
      const pending = new Map(state.pending)
      for (const node of result.nodes) {
        if (isLinkedForCreate(node)) {
          pending.delete(node.nodeId)
        }
      }
      return { ...state, status: "ready", result, progress: result.total, pending, scanId: state.scanId + 1 }
    })
    await refreshRemote()
    return result
  }

  return {
    store,
    refreshRemote,
    refreshKeys,
    applyChanges,
    scan: (scope) => shown(scope ?? store.get().scope),
    scanLayers: (nodeIds) => shown(store.get().scope, nodeIds),
    scanDetached: (scope) => detached(scope),
    scanFrames: (frameIds) => detached("page", frameIds),
    scanNodes: (nodeIds) => detached("page", nodeIds),
    setScope(scope) {
      store.set((state) => ({ ...state, scope }))
    },
    setPending(nodeIds, name) {
      store.set((state) => {
        const pending = new Map(state.pending)
        for (const nodeId of nodeIds) {
          if (name === null || name.trim() === "") {
            pending.delete(nodeId)
          } else {
            pending.set(nodeId, name.trim())
          }
        }
        return { ...state, pending }
      })
    },
    // Page changes keep pending creates (node ids stay valid); a project change drops them. A scan of requested frames
    // does not depend on the page, so a page change lets it finish.
    clear(dropPending = false) {
      scanGeneration++
      remoteGeneration++
      if (dropPending || framesScan === null) {
        deps.scanner.cancel()
      }
      store.set((state) => ({ ...emptyWorkspace(state.scope), pending: dropPending ? new Map() : state.pending, scanId: state.scanId + 1 }))
    },
  }
}
