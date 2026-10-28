import { describe, expect, it } from "vitest"
import { createWorkLock, waitText, type WorkTask } from "./work-lock"

describe("work lock", () => {
  it("refuses QA actions and a push while a Preview apply is in flight", () => {
    const changes: (WorkTask | null)[] = []
    const lock = createWorkLock((holder) => changes.push(holder))
    expect(lock.acquire("preview")).toBe(true)
    for (const task of ["report", "copies", "pseudo", "push", "preview"] as const) {
      expect(lock.acquire(task)).toBe(false)
    }
    expect(lock.holder()).toBe("preview")
    expect(changes).toEqual(["preview"])
  })

  it("refuses a Preview apply while a QA task runs", () => {
    const lock = createWorkLock()
    expect(lock.acquire("report")).toBe(true)
    expect(lock.acquire("preview")).toBe(false)
    lock.release("report")
    expect(lock.acquire("copies")).toBe(true)
    expect(lock.acquire("preview")).toBe(false)
  })

  it("lets only the holder release the lock, so a task that ends never unlocks another task's run", () => {
    const changes: (WorkTask | null)[] = []
    const lock = createWorkLock((holder) => changes.push(holder))
    expect(lock.acquire("report")).toBe(true)
    // A refused Preview apply ends (its finally releases) while the report still runs.
    expect(lock.acquire("preview")).toBe(false)
    lock.release("preview")
    expect(lock.holder()).toBe("report")
    expect(lock.acquire("pseudo")).toBe(false)
    lock.release("report")
    expect(lock.holder()).toBeNull()
    lock.release("report")
    expect(changes).toEqual(["report", null])
    expect(lock.acquire("preview")).toBe(true)
  })

  it("names the running task on locked tabs, not only a push", () => {
    expect(waitText("push")).toBe("Wait for the push to finish")
    expect(waitText("preview")).toBe("Wait for the preview to be applied")
    expect(waitText("pseudo")).toBe("Wait for pseudo-localization to finish")
    expect(waitText("report")).toBe("Wait for the overflow report to finish")
    expect(waitText("copies")).toBe("Wait for the language copies to finish")
  })
})
