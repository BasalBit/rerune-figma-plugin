import { REQUEST_IDLE_TIMEOUT_MS, UI_READY_RETRY_MS } from "../shared/constants"
import { MAIN_TO_UI_TYPES, type MainToUi, type MainToUiOf, type MainToUiType, type RequestId, type UiToMain } from "../shared/messages"

// UI side of the main ↔ UI bridge (§7.5): JSON-cloned sends (except messages carrying Uint8Array), listeners
// per message type, the ui-ready handshake retried every 400 ms until init, and a per-request idle watchdog.

export interface UiBusEnvironment {
  post(message: unknown): void
  subscribe(listener: (message: unknown) => void): () => void
}

export class HandlerError extends Error {
  constructor(readonly forType: string, message: string) {
    super(message)
    this.name = "HandlerError"
  }
}

export class RequestTimeoutError extends Error {
  constructor(readonly requestId: RequestId) {
    super("The plugin stopped responding. Try again.")
    this.name = "RequestTimeoutError"
  }
}

export interface RequestOptions<T> {
  // Returns the final value for a message of this request, or undefined to keep waiting.
  done(message: MainToUi): T | undefined
  idleMs?: number
}

export interface UiBus {
  send(message: UiToMain): void
  on<T extends MainToUiType>(type: T, listener: (message: MainToUiOf<T>) => void): () => void
  nextRequestId(): RequestId
  handshake(): Promise<MainToUiOf<"init">>
  request<T>(build: (requestId: RequestId) => UiToMain, options: RequestOptions<T>): Promise<T>
  dispose(): void
}

export function carriesBinary(message: object): boolean {
  return Object.values(message).some((value) => value instanceof Uint8Array)
}

// Strips proxies and non-cloneable values before postMessage; Uint8Array is the only binary type that crosses.
export function toBridge<T extends object>(message: T): T {
  return carriesBinary(message) ? message : (JSON.parse(JSON.stringify(message)) as T)
}

export function createIdleTimeout(ms: number, onTimeout: () => void): { touch(): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(onTimeout, ms)
  return {
    touch() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = setTimeout(onTimeout, ms)
      }
    },
    clear() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

function requestIdOf(message: MainToUi): RequestId | undefined {
  return "requestId" in message ? message.requestId : undefined
}

export function createUiBus(environment: UiBusEnvironment): UiBus {
  const listeners = new Map<MainToUiType, Set<(message: MainToUi) => void>>()
  let counter = 0

  const unsubscribe = environment.subscribe((raw) => {
    if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
      return
    }
    const message = raw as MainToUi
    for (const listener of [...(listeners.get(message.type) ?? [])]) {
      listener(message)
    }
  })

  function on<T extends MainToUiType>(type: T, listener: (message: MainToUiOf<T>) => void): () => void {
    let set = listeners.get(type)
    if (set === undefined) {
      set = new Set()
      listeners.set(type, set)
    }
    const entry = listener as (message: MainToUi) => void
    set.add(entry)
    return () => {
      set?.delete(entry)
    }
  }

  function onAny(listener: (message: MainToUi) => void): () => void {
    const offs = MAIN_TO_UI_TYPES.map((type) => on(type, listener))
    return () => offs.forEach((off) => off())
  }

  return {
    send(message) {
      environment.post(toBridge(message))
    },
    on,
    nextRequestId() {
      counter++
      return `c${Date.now()}-${counter}`
    },
    handshake() {
      return new Promise((resolve) => {
        const off = on("init", (message) => {
          clearInterval(retry)
          off()
          resolve(message)
        })
        const ping = () => environment.post({ type: "ui-ready" })
        const retry = setInterval(ping, UI_READY_RETRY_MS)
        ping()
      })
    },
    request(build, options) {
      const requestId = `c${Date.now()}-${++counter}`
      return new Promise((resolve, reject) => {
        let off: () => void = () => {}
        const watchdog = createIdleTimeout(options.idleMs ?? REQUEST_IDLE_TIMEOUT_MS, () => {
          off()
          reject(new RequestTimeoutError(requestId))
        })
        off = onAny((message) => {
          if (requestIdOf(message) !== requestId) {
            return
          }
          if (message.type === "handler-error") {
            watchdog.clear()
            off()
            reject(new HandlerError(message.forType, message.message))
            return
          }
          const value = options.done(message)
          if (value === undefined) {
            watchdog.touch()
            return
          }
          watchdog.clear()
          off()
          resolve(value)
        })
        environment.post(toBridge(build(requestId)))
      })
    },
    dispose() {
      unsubscribe()
      listeners.clear()
    },
  }
}

export function browserEnvironment(): UiBusEnvironment {
  return {
    post(message) {
      parent.postMessage({ pluginMessage: message }, "*")
    },
    subscribe(listener) {
      const handler = (event: MessageEvent) => {
        const data = event.data as { pluginMessage?: unknown } | null
        if (typeof data === "object" && data !== null && "pluginMessage" in data) {
          listener(data.pluginMessage)
        }
      }
      window.addEventListener("message", handler)
      return () => window.removeEventListener("message", handler)
    },
  }
}
