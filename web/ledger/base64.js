/**
 * base64url (RFC 4648 §5, unpadded) for Uint8Array <-> string.
 *
 * Hand-rolled rather than Buffer/btoa so the same code runs in Workers,
 * browsers and Node without a polyfill or a bundler shim.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function b64uEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]
  }
  return out
}

export function b64uDecode(text) {
  if (typeof text !== 'string') throw new TypeError('base64url: expected a string')
  if (text.length % 4 === 1) throw new Error('base64url: impossible length')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let written = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const value = code < 128 ? LOOKUP[code] : -1
    if (value < 0) throw new Error(`base64url: invalid character at ${i}`)
    buf = ((buf << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, written)
}
