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
  refreshRemote(): Promise<void>
  setScope(scope: Scope): void
  setPending(nodeIds: readonly string[], name: string | null): void
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

  return {
    store,
    refreshRemote,
    async scan(scope) {
      const target = scope ?? store.get().scope
      const mine = ++scanGeneration
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
    // Page changes keep pending creates (node ids stay valid); a project change drops them.
    clear(dropPending = false) {
      scanGeneration++
      remoteGeneration++
      deps.scanner.cancel()
      store.set((state) => ({ ...emptyWorkspace(state.scope), pending: dropPending ? new Map() : state.pending }))
    },
  }
}
