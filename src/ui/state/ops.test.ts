import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { scannedNode } from "../../../test/fixtures"
import { createUiBus, HandlerError, RequestTimeoutError } from "../bus"
import { chunk, createScanRunner, groupErrors, layerCount, mainsFirst, runBatched, runOp, ScanCancelledError, singleFlight } from "./ops"
import { fakeBusEnvironment } from "./test-fakes"

const SKIPPED = { hidden: 0, locked: 0, empty: 0, numeric: 0, underscore: 0, languageCopy: 0, unavailable: 0 }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createScanRunner", () => {
  it("collects batches until scan-done", async () => {
    const fake = fakeBusEnvironment()
    const runner = createScanRunner(createUiBus(fake.environment))
    const progress: number[] = []
    const pending = runner.run("page", (n) => progress.push(n))
    const request = fake.posted[0]
    expect(request).toMatchObject({ type: "scan-request", scope: "page" })
    const requestId = (request as { requestId: string }).requestId
    fake.deliver({ type: "scan-progress", requestId, scanned: 50 })
    fake.deliver({ type: "scan-batch", requestId, nodes: [scannedNode("1:1", "A")] })
    fake.deliver({ type: "scan-batch", requestId: "other", nodes: [scannedNode("9:9", "X")] })
    fake.deliver({ type: "scan-batch", requestId, nodes: [scannedNode("1:2", "B")] })
    fake.deliver({ type: "scan-done", requestId, total: 2, truncated: false, skipped: { ...SKIPPED, hidden: 3 } })
    const result = await pending
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["1:1", "1:2"])
    expect(result).toMatchObject({ scope: "page", total: 2, truncated: false, skipped: { hidden: 3 } })
    expect(progress).toEqual([50, 1, 2])
  })

  it("cancels the running scan when a new one starts", async () => {
    const fake = fakeBusEnvironment()
    const runner = createScanRunner(createUiBus(fake.environment))
    const first = runner.run("page")
    const firstId = (fake.posted[0] as { requestId: string }).requestId
    const second = runner.run("selection")
    expect(fake.posted[1]).toEqual({ type: "scan-cancel", requestId: firstId })
    await expect(first).rejects.toBeInstanceOf(ScanCancelledError)
    const secondId = (fake.posted[2] as { requestId: string }).requestId
    fake.deliver({ type: "scan-done", requestId: secondId, total: 0, truncated: false, skipped: SKIPPED })
    await expect(second).resolves.toMatchObject({ scope: "selection", nodes: [] })
  })

  it("rejects on handler-error and on the idle watchdog", async () => {
    const fake = fakeBusEnvironment()
    const runner = createScanRunner(createUiBus(fake.environment), 1000)
    const failing = runner.run("page")
    const id = (fake.posted[0] as { requestId: string }).requestId
    fake.deliver({ type: "handler-error", forType: "scan-request", requestId: id, message: "boom" })
    await expect(failing).rejects.toBeInstanceOf(HandlerError)

    const stuck = runner.run("page")
    const stuckId = (fake.posted[fake.posted.length - 1] as { requestId: string }).requestId
    const assertion = expect(stuck).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(900)
    fake.deliver({ type: "scan-progress", requestId: stuckId, scanned: 10 })
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(200)
    await assertion
    expect(fake.posted[fake.posted.length - 1]).toEqual({ type: "scan-cancel", requestId: stuckId })
  })

  it("cancel() without a running scan does nothing", () => {
    const fake = fakeBusEnvironment()
    createScanRunner(createUiBus(fake.environment)).cancel()
    expect(fake.posted).toEqual([])
  })
})

describe("runOp and runBatched", () => {
  it("waits for the op-result of the request", async () => {
    const fake = fakeBusEnvironment()
    const bus = createUiBus(fake.environment)
    const pending = runOp(bus, (requestId) => ({ type: "link-remove", requestId, nodeIds: ["1:1"] }))
    const id = (fake.posted[0] as { requestId: string }).requestId
    fake.deliver({ type: "op-result", requestId: id, ok: true, done: 1, errors: [] })
    await expect(pending).resolves.toMatchObject({ done: 1 })
  })

  it("sends writes in batches and merges the results", async () => {
    const fake = fakeBusEnvironment()
    const bus = createUiBus(fake.environment)
    const items = Array.from({ length: 5 }, (_, i) => "1:" + i)
    const pending = runBatched(bus, items, (requestId, batch) => ({ type: "link-remove", requestId, nodeIds: batch }), 2)
    for (let round = 0; round < 3; round++) {
      await vi.advanceTimersByTimeAsync(0)
      const message = fake.posted[round] as { requestId: string; nodeIds: string[] }
      fake.deliver({
        type: "op-result",
        requestId: message.requestId,
        ok: round !== 1,
        done: message.nodeIds.length - (round === 1 ? 1 : 0),
        errors: round === 1 ? [{ nodeId: message.nodeIds[0], code: "node_not_found", message: "gone" }] : [],
      })
    }
    const outcome = await pending
    expect(fake.posted.map((message) => (message as { nodeIds: string[] }).nodeIds)).toEqual([["1:0", "1:1"], ["1:2", "1:3"], ["1:4"]])
    expect(outcome).toEqual({ done: 4, errors: [{ nodeId: "1:2", code: "node_not_found", message: "gone" }] })
  })

  it("sends nothing for an empty list", async () => {
    const fake = fakeBusEnvironment()
    await expect(runBatched(createUiBus(fake.environment), [], (requestId, batch) => ({ type: "link-remove", requestId, nodeIds: batch }))).resolves.toEqual({ done: 0, errors: [] })
    expect(fake.posted).toEqual([])
  })
})

describe("singleFlight", () => {
  it("never overlaps runs: a second request while one runs gets the running promise", async () => {
    let release: () => void = () => {}
    const work = vi.fn<(scope: string) => Promise<void>>(() => new Promise<void>((resolve) => (release = resolve)))
    const busy: boolean[] = []
    const flight = singleFlight(work, (value) => busy.push(value))
    const first = flight.run("page")
    const second = flight.run("selection")
    expect(second).toBe(first)
    expect(work).toHaveBeenCalledTimes(1)
    expect(flight.busy()).toBe(true)
    release()
    await first
    expect(flight.busy()).toBe(false)
    expect(busy).toEqual([true, false])
    const third = flight.run("selection")
    expect(work).toHaveBeenLastCalledWith("selection")
    release()
    await third
  })

  it("ends the run when the work fails", async () => {
    const flight = singleFlight(async () => {
      throw new Error("refused")
    })
    await expect(flight.run()).rejects.toThrow("refused")
    expect(flight.busy()).toBe(false)
  })
})

describe("helpers", () => {
  it("chunks, orders mains first and counts layers", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
    expect(mainsFirst([{ nodeId: "I1:2;3:4" }, { nodeId: "3:4" }, { nodeId: "I5:6;3:4" }, { nodeId: "7:8" }]).map((item) => item.nodeId)).toEqual(["3:4", "7:8", "I1:2;3:4", "I5:6;3:4"])
    expect(layerCount(1)).toBe("1 layer")
    expect(layerCount(3)).toBe("3 layers")
  })

  it("groups node errors by code and message", () => {
    const groups = groupErrors([
      { nodeId: "1", code: "missing_font", message: "font" },
      { nodeId: "2", code: "missing_font", message: "font" },
      { nodeId: "2", code: "missing_font", message: "font" },
      { nodeId: "3", code: "override_kept", message: "kept" },
    ])
    expect(groups).toEqual([
      { code: "missing_font", message: "font", nodeIds: ["1", "2"], warning: false },
      { code: "override_kept", message: "kept", nodeIds: ["3"], warning: true },
    ])
  })
})
