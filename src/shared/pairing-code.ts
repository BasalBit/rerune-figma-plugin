import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./constants"

// Appendix A.1, with the server's normalizePairingCode (Go) as the reference for "uppercase" and "whitespace":
// - Go strings.ToUpper maps each code point to one code point (simple case mapping). JS toUpperCase uses full
//   mappings ("ß" → "SS", "ﬀ" → "FF"), so a code point whose uppercase is longer stays as it is.
// - Go unicode.IsSpace: JS \s without U+FEFF, plus U+0085 (NEL).
const CANONICAL_PATTERN = new RegExp("^[" + PAIRING_CODE_ALPHABET + "]{" + PAIRING_CODE_LENGTH + "}$")
const STRIPPED = /[-\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g

function upperSimple(input: string): string {
  return Array.from(input, (char) => {
    const upper = char.toUpperCase()
    return Array.from(upper).length === 1 ? upper : char
  }).join("")
}

export function canonicalPairingCode(input: string): string | null {
  const canonical = upperSimple(input).replace(STRIPPED, "")
  return CANONICAL_PATTERN.test(canonical) ? canonical : null
}

export function isValidPairingCode(input: string): boolean {
  return canonicalPairingCode(input) !== null
}

export function displayPairingCode(input: string): string | null {
  const canonical = canonicalPairingCode(input)
  if (canonical === null) {
    return null
  }
  const half = PAIRING_CODE_LENGTH / 2
  return canonical.slice(0, half) + "-" + canonical.slice(half)
}

export function samePairingCode(a: string, b: string): boolean {
  const left = canonicalPairingCode(a)
  return left !== null && left === canonicalPairingCode(b)
}
