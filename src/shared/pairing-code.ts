import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./constants"

const CANONICAL_PATTERN = new RegExp("^[" + PAIRING_CODE_ALPHABET + "]{" + PAIRING_CODE_LENGTH + "}$")
const STRIPPED = /[-\s]/g

export function canonicalPairingCode(input: string): string | null {
  const canonical = input.toUpperCase().replace(STRIPPED, "")
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
