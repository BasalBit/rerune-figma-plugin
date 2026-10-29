import { REQUEST_IDLE_TIMEOUT_MS } from "../../shared/constants"
import type { MainToUi, MainToUiOf, NodeError, RequestId, ScannedNode, Scope, UiToMain } from "../../shared/messages"
import { isWarning } from "../../shared/node-errors"
import { mainsFirst, mainsFirstIds } from "../../shared/plugin-data"
import { createIdleTimeout, HandlerError, RequestTimeoutError, type UiBus } from "../bus"

// Request/response helpers over the UI bus: scans, document writes (op-result) and batching.

export type OpResult = MainToUiOf<"op-result">
export type SkipCounts = MainToUiOf<"scan-done">["skipped"]

export const WRITE_BATCH_SIZE = 200
export const LONG_OP_IDLE_MS = 300000

// `missingFrameIds` / `hiddenFrameIds`: only for a scan of requested frames (screenshot freshness), the frames not in
// the file and the hidden ones (not scanned).
export interface ScanResult {
  scope: Scope
  nodes: ScannedNode[]
  total: number
  truncated: boolean
  skipped: SkipCounts
  missingFrameIds?: string[]
  hiddenFrameIds?: string[]
}

export class ScanCancelledError extends Error {
  constructor() {
    super("Scan cancelled")
    this.name = "ScanCancelledError"
  }
}

export interface ScanRunner {
  // With `frameIds` main scans those frames (screenshot freshness, contract §6.4 step 2) or text layers by id instead
  // of the scope.
  run(scope: Scope, onProgress?: (scanned: number) => void, frameIds?: readonly string[]): Promise<ScanResult>
  cancel(): void
}

// Collects scan-batch messages until scan-done (§7.9). A new run or cancel() sends scan-cancel for the running
// scan; main then stops without a scan-done, so the old promise is rejected here.
export function createScanRunner(bus: Pick<UiBus, "send" | "on" | "nextRequestId">, idleMs: number = REQUEST_IDLE_TIMEOUT_MS): ScanRunner {
  let active: { requestId: RequestId; abort(): void } | null = null

  function cancel(): void {
    if (active !== null) {
      const current = active
      active = null
      bus.send({ type: "scan-cancel", requestId: current.requestId })
      current.abort()
    }
  }

  return {
    cancel,
    run(scope, onProgress, frameIds) {
      cancel()
      const requestId = bus.nextRequestId()
      return new Promise<ScanResult>((resolve, reject) => {
        const nodes: ScannedNode[] = []
        const offs: (() => void)[] = []
        const finish = () => {
          watchdog.clear()
          offs.forEach((off) => off())
          if (active?.requestId === requestId) {
            active = null
          }
        }
        const watchdog = createIdleTimeout(idleMs, () => {
          finish()
          bus.send({ type: "scan-cancel", requestId })
          reject(new RequestTimeoutError(requestId))
        })
        active = {
          requestId,
          abort() {
            finish()
            reject(new ScanCancelledError())
          },
        }
        offs.push(
          bus.on("scan-progress", (message) => {
            if (message.requestId === requestId) {
              watchdog.touch()
              onProgress?.(message.scanned)
            }
          }),
          bus.on("scan-batch", (message) => {
            if (message.requestId === requestId) {
              watchdog.touch()
              nodes.push(...message.nodes)
              onProgress?.(nodes.length)
            }
          }),
          bus.on("scan-done", (message) => {
            if (message.requestId === requestId) {
              finish()
              const result: ScanResult = { scope, nodes, total: message.total, truncated: message.truncated, skipped: message.skipped }
              if (frameIds !== undefined) {
                result.missingFrameIds = message.missingFrameIds?.slice() ?? []
                result.hiddenFrameIds = message.hiddenFrameIds?.slice() ?? []
              }
              resolve(result)
            }
          }),
          bus.on("handler-error", (message) => {
            if (message.requestId === requestId) {
              finish()
              reject(new HandlerError(message.forType, message.message))
            }
          }),
        )
        bus.send(frameIds === undefined ? { type: "scan-request", requestId, scope } : { type: "scan-request", requestId, scope, frameIds: frameIds.slice() })
      })
    },
  }
}

export function runOp(bus: Pick<UiBus, "request">, build: (requestId: RequestId) => UiToMain, idleMs?: number): Promise<OpResult> {
  return bus.request((requestId) => build(requestId), {
    done: (message: MainToUi) => (message.type === "op-result" ? message : undefined),
    idleMs,
  })
}

export interface SingleFlight<A extends unknown[]> {
  run(...args: A): Promise<void>
  // Waits until no run is going on (whatever its outcome), then runs with these arguments: for work that must
  // happen with its own arguments, such as the overflow report's final reset of exactly the layers it wrote.
  queue(...args: A): Promise<void>
  busy(): boolean
}

// One run at a time (preview resets, §7.14): a request while one is running gets the running one's promise
// instead of starting an overlapping canvas write (a double click), unless it is queued. `onBusy` reports the
// start and the end of each run.
export function singleFlight<A extends unknown[]>(work: (...args: A) => Promise<void>, onBusy: (busy: boolean) => void = () => {}): SingleFlight<A> {
  let current: Promise<void> | null = null
  const start = (args: A): Promise<void> => {
    onBusy(true)
    const started = (async () => work(...args))()
    const run = started.finally(() => {
      current = null
      onBusy(false)
    })
    current = run
    return run
  }
  return {
    run(...args) {
      return current !== null ? current : start(args)
    },
    async queue(...args) {
      // Another queued call may start in between, so wait until the flight is really free.
      while (current !== null) {
        await current.catch(() => {})
      }
      return start(args)
    },
    busy: () => current !== null,
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}

// Main writes main components before instances inside one message; batching keeps that order across messages
// (the order itself lives in src/shared/plugin-data.ts, shared with main).
export { mainsFirst }

export interface BatchOutcome { done: number; errors: NodeError[] }

// `commit: false` for a write that more writes of the same run follow, so main makes the whole run one undo step
// (preview-apply and overflow-check carry it, §7.5 Phase 3 addition).
export function undoStep(last: boolean): { commit?: false } {
  return last ? {} : { commit: false }
}

// Sends a document write in batches so each op-result arrives within the bus watchdog (main sends no progress
// for writes). Results are merged. `last` tells the builder whether this is the run's last batch (see undoStep).
export async function runBatched<T>(
  bus: Pick<UiBus, "request">,
  items: readonly T[],
  build: (requestId: RequestId, batch: T[], last: boolean) => UiToMain,
  size: number = WRITE_BATCH_SIZE,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { done: 0, errors: [] }
  const batches = chunk(items, size)
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]
    const result = await runOp(bus, (requestId) => build(requestId, batch, index === batches.length - 1))
    outcome.done += result.done
    outcome.errors.push(...result.errors)
  }
  return outcome
}

// link-remove in batches, main components first across batches (main orders each batch the same way), so an
// instance that inherits a link being removed is reached after its main and left alone (D44).
export function removeLinksBatched(bus: Pick<UiBus, "request">, nodeIds: readonly string[], size: number = WRITE_BATCH_SIZE): Promise<BatchOutcome> {
  return runBatched(bus, mainsFirstIds(nodeIds), (requestId, batch) => ({ type: "link-remove", requestId, nodeIds: batch }), size)
}

export interface ErrorGroup { code: NodeError["code"]; message: string; nodeIds: string[]; warning: boolean }

// One line per error code with the affected layers (Select on canvas uses nodeIds).
export function groupErrors(errors: readonly NodeError[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>()
  for (const error of errors) {
    const id = error.code + "\u0000" + error.message
    const group = groups.get(id)
    if (group === undefined) {
      groups.set(id, { code: error.code, message: error.message, nodeIds: [error.nodeId], warning: isWarning(error) })
    } else if (!group.nodeIds.includes(error.nodeId)) {
      group.nodeIds.push(error.nodeId)
    }
  }
  return [...groups.values()]
}

export function layerCount(count: number): string {
  return count === 1 ? "1 layer" : count + " layers"
}
