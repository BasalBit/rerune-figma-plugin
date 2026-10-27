const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const LINE_BREAKS = new RegExp("\r\n|\r|" + LINE_SEPARATOR + "|" + PARAGRAPH_SEPARATOR, "g")
const NUMERIC_DECORATION = /[0-9\s.,:;+\-–—%$€£¥₹/()#*×xX'"’]/g
const ASCII_DIGIT = /[0-9]/

export function normalizeDesignText(text: string): string {
  return text.replace(LINE_BREAKS, "\n").trim()
}

export function utf16Length(text: string): number {
  return text.length
}

export function isNumericOnly(text: string): boolean {
  const normalized = normalizeDesignText(text)
  if (!ASCII_DIGIT.test(normalized)) {
    return false
  }
  return normalized.replace(NUMERIC_DECORATION, "") === ""
}

export function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }
  return text.slice(0, end)
}

export function firstRunes(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("")
}

export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}
