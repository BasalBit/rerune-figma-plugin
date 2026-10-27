// Minimal observable store: framework-free so state logic runs in node tests; `useStore` binds it to Preact.

export interface Store<T> {
  get(): T
  set(next: T | ((current: T) => T)): void
  subscribe(listener: (state: T) => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<(state: T) => void>()
  return {
    get: () => state,
    set(next) {
      state = typeof next === "function" ? (next as (current: T) => T)(state) : next
      for (const listener of [...listeners]) {
        listener(state)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
