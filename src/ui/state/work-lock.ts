// One canvas task at a time in the Design mode workspace (§7.13, §7.14, §7.18). A push, a preview apply,
// pseudo-localization, the overflow report and language copies each write the canvas over many messages; two of them
// at once would write previews over each other (the second one's preview stored as the first one's "original") or
// copy a frame while another task previews it. The task holding the lock keeps the tabs and Change project put; a
// task that cannot take it does not start.

export type WorkTask = "push" | "preview" | "pseudo" | "report" | "copies"

export interface WorkLock {
  // Takes the lock for this task; false (and nothing changes) while any task holds it.
  acquire(task: WorkTask): boolean
  // Ends this task's hold. A task that does not hold the lock changes nothing, so a task that ends can never
  // release the lock another task holds.
  release(task: WorkTask): void
  holder(): WorkTask | null
}

export function createWorkLock(onChange: (holder: WorkTask | null) => void = () => {}): WorkLock {
  let current: WorkTask | null = null
  return {
    acquire(task) {
      if (current !== null) {
        return false
      }
      current = task
      onChange(current)
      return true
    },
    release(task) {
      if (current !== task) {
        return
      }
      current = null
      onChange(null)
    },
    holder: () => current,
  }
}
