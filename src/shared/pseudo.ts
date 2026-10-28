import { utf16Length } from "./text"

// Pseudo-localization (§7.18.2, Appendix A.6): accented look-alikes for a–z and A–Z, `{{…}}` tokens unchanged, and
// padding of 40% (inputs up to 20 UTF-16 units) or 30% (longer inputs) of the input length, inside ⟦ ⟧.

const LOWER = "áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýž"
const UPPER = "ÁƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞǪŔŠŢÚṼŴẊÝŽ"
const TOKEN = /\{\{[^{}]*\}\}/g
const PAD = "·"
const OPEN = "⟦"
const CLOSE = "⟧"

export function pseudoChar(char: string): string {
  const code = char.charCodeAt(0)
  if (char.length === 1 && code >= 97 && code <= 122) {
    return LOWER.charAt(code - 97)
  }
  if (char.length === 1 && code >= 65 && code <= 90) {
    return UPPER.charAt(code - 65)
  }
  return char
}

function mapLetters(text: string): string {
  let output = ""
  for (const char of text) {
    output += pseudoChar(char)
  }
  return output
}

export function pseudoPadding(text: string): number {
  const length = utf16Length(text)
  return Math.ceil(length * (length <= 20 ? 0.4 : 0.3))
}

export function pseudoLocalize(text: string): string {
  let mapped = ""
  let last = 0
  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    mapped += mapLetters(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  mapped += mapLetters(text.slice(last))
  return OPEN + mapped + PAD.repeat(pseudoPadding(text)) + CLOSE
}
