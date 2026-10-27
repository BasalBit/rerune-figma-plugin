import { useEffect, useState } from "preact/hooks"
import type { Store } from "./store"

// Re-renders the component whenever the store changes.
export function useStore<T>(store: Store<T>): T {
  const [state, setState] = useState(store.get())
  useEffect(() => {
    setState(store.get())
    return store.subscribe(setState)
  }, [store])
  return state
}
