import { NOTIFY_MAX_CHARS } from "../shared/constants"
import { impactOf, isAllowed, type BuildEnv, type PluginEditorType } from "../shared/message-policy"
import type { MainToUi, RequestId, UiToMain, UiToMainOf, UiToMainType } from "../shared/messages"
import { truncateUtf16 } from "../shared/text"

export type MainHandler<T extends UiToMainType> = (message: UiToMainOf<T>) => void | Promise<void>

export interface MainBus {
  readonly editorType: PluginEditorType
  readonly env: BuildEnv
  send(message: MainToUi): void
  on<T extends UiToMainType>(type: T, handler: MainHandler<T>): void
  dispatch(raw: unknown): Promise<void>
}

export const DEV_MODE_REFUSAL = "Not available in Dev Mode"
export const DEVPROBE_REFUSAL = "Only available in Dev Mode development builds"
export const NOT_IMPLEMENTED = "Not available in this version of the plugin"

export function send(message: MainToUi): void {
  figma.ui.postMessage(message)
}

export function notifyText(message: string): string {
  return truncateUtf16(message, NOTIFY_MAX_CHARS)
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message
  }
  if (typeof error === "string" && error !== "") {
    return error
  }
  return "Unexpected error"
}

function requestIdOf(message: Record<string, unknown>): RequestId | undefined {
  return typeof message.requestId === "string" ? message.requestId : undefined
}

// Typed main bus (§7.5): one handler per type, the Dev Mode impact guard, and an error boundary,
// because Figma drops unhandled rejections from figma.ui.onmessage without a trace.
export function createMainBus(editorType: PluginEditorType, env: BuildEnv, post: (message: MainToUi) => void = send): MainBus {
  const handlers = new Map<UiToMainType, (message: UiToMain) => void | Promise<void>>()

  function fail(type: UiToMainType, requestId: RequestId | undefined, message: string, notify: string | null): void {
    if (notify !== null) {
      figma.notify(notifyText(notify), { error: true })
    }
    post(requestId === undefined ? { type: "handler-error", forType: type, message } : { type: "handler-error", forType: type, requestId, message })
  }

  return {
    editorType,
    env,
    send: post,
    on(type, handler) {
      handlers.set(type, handler as (message: UiToMain) => void | Promise<void>)
    },
    async dispatch(raw) {
      if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
        console.log("ReRune: ignored a message without a type")
        return
      }
      const message = raw as Record<string, unknown> & { type: string }
      const impact = impactOf(message.type as UiToMainType)
      if (impact === null) {
        // Unknown types log only the type: payloads can carry the plugin token.
        console.log("ReRune: unknown message type " + message.type)
        return
      }
      const type = message.type as UiToMainType
      const requestId = requestIdOf(message)
      if (!isAllowed(impact, editorType, env)) {
        const refusal = impact === "devprobe" ? DEVPROBE_REFUSAL : DEV_MODE_REFUSAL
        fail(type, requestId, refusal, refusal)
        return
      }
      const handler = handlers.get(type)
      if (handler === undefined) {
        console.log("ReRune: no handler for message type " + type)
        fail(type, requestId, NOT_IMPLEMENTED, null)
        return
      }
      try {
        await handler(message as unknown as UiToMain)
      } catch (error) {
        const text = errorText(error)
        fail(type, requestId, text, "ReRune: " + text)
      }
    },
  }
}
