import type { FigmaResolvedKey } from "../../shared/api-types"
import type { MainToUi, NodeError, UiToMain } from "../../shared/messages"
import { createUiBus, type UiBus, type UiBusEnvironment } from "../bus"

// Test doubles for UI state tests (imported only by *.test.ts files): a bus environment that records posts,
// and a fake main thread that answers document writes with op-results.

export interface FakeBusEnvironment {
  environment: UiBusEnvironment
  posted: UiToMain[]
  deliver(message: MainToUi): void
}

export function fakeBusEnvironment(onPost?: (message: UiToMain, deliver: (reply: MainToUi) => void) => void): FakeBusEnvironment {
  const posted: UiToMain[] = []
  let listener: ((message: unknown) => void) | null = null
  const deliver = (message: MainToUi) => listener?.(message)
  return {
    environment: {
      post: (message) => {
        posted.push(message as UiToMain)
        if (onPost !== undefined) {
          Promise.resolve().then(() => onPost(message as UiToMain, deliver), () => {})
        }
      },
      subscribe: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
    },
    posted,
    deliver,
  }
}

export type WriteMessage = Extract<UiToMain, { type: "link-apply" | "link-remove" | "text-apply" | "preview-apply" | "preview-reset" | "settings-save" }>

// A main thread that answers every write with done = item count and the errors `fail` returns.
export function fakeMain(fail: (message: WriteMessage) => NodeError[] = () => []): { bus: UiBus; posted: UiToMain[]; writes: WriteMessage[] } {
  const writes: WriteMessage[] = []
  const fake = fakeBusEnvironment((message, deliver) => {
    if (message.type === "link-apply" || message.type === "link-remove" || message.type === "text-apply" || message.type === "preview-apply" || message.type === "preview-reset" || message.type === "settings-save") {
      writes.push(message)
      const errors = fail(message)
      const count =
        message.type === "link-remove" ? message.nodeIds.length
          : message.type === "preview-reset" ? message.nodeIds?.length ?? 0
            : message.type === "settings-save" ? 1
              : message.items.length
      const failed = errors.filter((error) => error.code !== "mixed_styles_flattened" && error.code !== "override_kept").length
      deliver({ type: "op-result", requestId: message.requestId, ok: failed === 0, done: count - failed, errors })
    }
  })
  return { bus: createUiBus(fake.environment), posted: fake.posted, writes }
}

// An E12 key with one main-language (en) value; `main === null` means the value is absent.
export function resolvedKey(id: string, key: string, main: string | null, extra: Partial<FigmaResolvedKey> = {}): FigmaResolvedKey {
  return {
    id,
    key,
    type: "key",
    enabled: true,
    status: "published",
    published: true,
    description: "",
    tags: [],
    max_length: null,
    placeholders: [],
    values: [
      main === null
        ? { lang: "en", present: false, resolved_lang: "", inherited: false, variation_applied: false, content: null, length: 0, exceeds_max_length: false }
        : { lang: "en", present: true, resolved_lang: "en", inherited: false, variation_applied: false, content: { value: main }, length: main.length, exceeds_max_length: false },
    ],
    ...extra,
  }
}
