import type { FigmaScreenshotMeta } from "./api-types"
import { SCREENSHOT_META_MAX_BYTES, SCREENSHOT_TEXT_MAX_UTF16 } from "./constants"
import { utf16Length, utf8Length } from "./text"

// Screenshot freshness (SF2, contract §3.3): the text of a linked layer, captured at export so the server can tell
// whether a screenshot still shows ReRune's text. Main captures it (capturedText); the UI keeps the E19 meta under
// its byte budget (fitMetaBudget).

// The layer's text as the box records it (rule 1): longer layers send none.
export function capturedText(characters: string): string | null {
  return utf16Length(characters) <= SCREENSHOT_TEXT_MAX_UTF16 ? characters : null
}

// SF2c: the meta stays within its byte budget by dropping texts, longest first. The boxes keep their key order
// (text comes last), so each removal shrinks the JSON by exactly `,"text":<json>`. Without texts a meta always fits:
// 500 boxes with node IDs of at most 512 characters (the server's limit) come to about 300 kB.
export function fitMetaBudget(meta: FigmaScreenshotMeta, maxBytes: number = SCREENSHOT_META_MAX_BYTES): FigmaScreenshotMeta {
  let size = utf8Length(JSON.stringify(meta))
  if (size <= maxBytes) {
    return meta
  }
  const boxes = meta.boxes.map((box) => ({ ...box }))
  const longestFirst = boxes
    .map((box, index) => ({ index, length: box.text === undefined ? -1 : box.text.length }))
    .filter((entry) => entry.length >= 0)
    .sort((a, b) => b.length - a.length)
  for (const { index } of longestFirst) {
    if (size <= maxBytes) {
      break
    }
    size -= utf8Length(',"text":' + JSON.stringify(boxes[index].text))
    delete boxes[index].text
  }
  return { ...meta, boxes }
}
