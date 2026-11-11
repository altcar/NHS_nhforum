import { describe, expect, it } from 'vitest'
import { b64uDecode, b64uEncode } from '../ledger/base64.js'
import { fromHex, sha256Hex, toHex, isHex, ZERO_HASH } from '../ledger/hash.js'

describe('base64url', () => {
  it('matches a known encoding', () => {
    expect(b64uEncode(new Uint8Array([0, 1, 2]))).toBe('AAEC')
    expect(Array.from(b64uDecode('AAEC'))).toEqual([0, 1, 2])
  })

  it('is unpadded and URL-safe', () => {
    for (const byte of [0xfb, 0xff, 0xfe]) {
      const encoded = b64uEncode(new Uint8Array([byte, byte, byte]))
      expect(encoded).not.toContain('=')
      expect(encoded).not.toContain('+')
      expect(encoded).not.toContain('/')
    }
  })

  it('round-trips every length from 0 to 70', () => {
    for (let length = 0; length <= 70; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect(Array.from(b64uDecode(b64uEncode(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('rejects invalid input', () => {
    expect(() => b64uDecode('a')).toThrow()
    expect(() => b64uDecode('a+b/')).toThrow()
    expect(() => b64uDecode('!!!!')).toThrow()
  })
})

describe('sha256', () => {
  it('matches the NIST vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('matches the NIST vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('treats a Uint8Array and its hex form identically', async () => {
    const text = 'nhforum'
    expect(await sha256Hex(new TextEncoder().encode(text))).toBe(await sha256Hex(text))
  })
})

describe('hex helpers', () => {
  it('round-trips', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes))
  })

  it('validates shape', () => {
    expect(isHex(ZERO_HASH, 64)).toBe(true)
    expect(isHex('AB'.repeat(32), 64)).toBe(false)
    expect(isHex('ab', 64)).toBe(false)
    expect(isHex(null, 64)).toBe(false)
  })

  it('rejects malformed hex', () => {
    expect(() => fromHex('zz')).toThrow()
    expect(() => fromHex('abc')).toThrow()
  })
})
