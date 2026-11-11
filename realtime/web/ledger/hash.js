/**
 * SHA-256 via WebCrypto. Native in Workers, browsers and Node 20+,
 * so there is no hash implementation to get wrong.
 */

const encoder = new TextEncoder()

export const ZERO_HASH = '0'.repeat(64)

export function toHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) throw new Error('fromHex: bad input')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('fromHex: non-hex character')
    out[i] = byte
  }
  return out
}

export function isHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}

export async function sha256Bytes(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function sha256Hex(input) {
  return toHex(await sha256Bytes(input))
}

/** SHA-256 over the concatenation of already-decoded byte chunks. */
export async function sha256Concat(...chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
}
