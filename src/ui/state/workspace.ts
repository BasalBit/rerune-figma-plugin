import type { FigmaResolvedKey } from "../../shared/api-types"
import type { Scope } from "../../shared/messages"
import type { RemoteWithMaxLength } from "../../shared/push-plan"
import { userMessage } from "../api/client"
import type { FigmaApi } from "../api/figma-api"
import { isLinkedForCreate } from "./link"
import { ScanCancelledError, type ScanResult, type ScanRunner } from "./ops"
import { linkedKeyIds, loadRemoteStates } from "./remote"
import { createStore, type Store } from "./store"

// The scanned layers of the current scope plus their remote state (E12), shared by Layers, Push and Preview.
// Pending creates ("Create new key" in the Link dialog, §7.11) live here until the push links the layers.

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
}

export interface WorkspaceProject { id: string; main_language: string }

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
  refreshRemote(): Promise<void>
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
  }
}

export function createWorkspace(deps: WorkspaceDeps, initialScope: Scope = "selection"): Workspace {
  const store = createStore<WorkspaceState>(emptyWorkspace(initialScope))
  let scanGeneration = 0
  let remoteGeneration = 0
  // Every scan the runner starts gets a number; `framesScan` is the number of the running scan of requested frames.
  let scans = 0
  let framesScan: number | null = null

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
      return await deps.scanner.run(scope, undefined, frameIds)
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

  return {
    store,
    refreshRemote,
    async scan(scope) {
      const target = scope ?? store.get().scope
      const mine = ++scanGeneration
      // The runner cancels the scan it runs, also one of requested frames.
      scans++
      framesScan = null
      store.set((state) => ({ ...state, scope: target, status: "scanning", progress: 0, error: null }))
      let result: ScanResult
      try {
        result = await deps.scanner.run(target, (progress) => {
          if (mine === scanGeneration) {
            store.set((state) => ({ ...state, progress }))
          }
        })
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
      store.set((state) => {
        const pending = new Map(state.pending)
        for (const node of result.nodes) {
          if (isLinkedForCreate(node)) {
            pending.delete(node.nodeId)
          }
        }
        return { ...state, status: "ready", result, progress: result.total, pending }
      })
      await refreshRemote()
      return result
    },
    scanDetached: (scope) => detached(scope),
    scanFrames: (frameIds) => detached("page", frameIds),
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
      store.set((state) => ({ ...emptyWorkspace(state.scope), pending: dropPending ? new Map() : state.pending }))
    },
  }
}
