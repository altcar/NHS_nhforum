/**
 * Canonical JSON — the byte-level contract every participant hashes.
 *
 * If two implementations disagree about a single byte, every hash breaks and
 * the log stops being verifiable, so this file is deliberately strict: it
 * accepts a narrow subset of JSON values and rejects everything ambiguous.
 *
 * Rules (normative, see spec/LEDGER-v1.md §2):
 *   - null, true, false
 *   - strings, well-formed UTF-16 only (no lone surrogates)
 *   - numbers: safe integers only, and never -0. No floats, no exponents.
 *   - arrays: order preserved
 *   - objects: plain objects (or null-prototype), keys sorted by UTF-16 code
 *     unit order, no symbol keys, no undefined values
 *   - no cycles, max depth 32
 */

export class CanonError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CanonError'
  }
}

export const MAX_DEPTH = 32

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++ // valid pair, skip the low half
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function encodeString(str) {
  if (hasLoneSurrogate(str)) {
    throw new CanonError('string contains a lone surrogate; normalise to well-formed UTF-16')
  }
  return JSON.stringify(str)
}

function encodeNumber(num) {
  if (!Number.isFinite(num)) throw new CanonError(`non-finite number: ${num}`)
  if (!Number.isSafeInteger(num)) {
    throw new CanonError(`number must be a safe integer, got ${num}; send fractions as strings`)
  }
  if (Object.is(num, -0)) throw new CanonError('-0 is not allowed; use 0')
  return String(num)
}

function encodeValue(value, depth, path, seen) {
  if (depth > MAX_DEPTH) throw new CanonError(`max depth ${MAX_DEPTH} exceeded at ${path}`)
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return encodeString(value)
    case 'number':
      return encodeNumber(value)
    case 'object':
      break
    default:
      throw new CanonError(`unsupported type ${typeof value} at ${path}`)
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonError(`cycle at ${path}`)
    seen.add(value)
    let out = '['
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ','
      out += encodeValue(value[i], depth + 1, `${path}[${i}]`, seen)
    }
    seen.delete(value)
    return out + ']'
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const name = value?.constructor?.name ?? 'unknown'
    throw new CanonError(`unsupported object type ${name} at ${path}; only plain objects are allowed`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonError(`symbol keys are not allowed at ${path}`)
  }
  if (seen.has(value)) throw new CanonError(`cycle at ${path}`)

  seen.add(value)
  const keys = Object.keys(value).sort() // UTF-16 code unit order, as in RFC 8785
  let out = '{'
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const child = value[key]
    if (child === undefined) {
      throw new CanonError(`undefined value at ${path}.${key}; omit the key instead`)
    }
    if (i > 0) out += ','
    out += encodeString(key) + ':' + encodeValue(child, depth + 1, `${path}.${key}`, seen)
  }
  seen.delete(value)
  return out + '}'
}

/** Canonicalise a value to a string. Throws CanonError on anything ambiguous. */
export function canon(value) {
  return encodeValue(value, 0, '$', new Set())
}

const encoder = new TextEncoder()

/** Canonicalise to UTF-8 bytes — the only form that may be hashed. */
export function canonBytes(value) {
  return encoder.encode(canon(value))
}
