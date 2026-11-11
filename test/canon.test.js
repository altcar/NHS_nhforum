import { describe, expect, it } from 'vitest'
import { canon, CanonError } from '../ledger/canon.js'

describe('canonical encoding', () => {
  it('sorts object keys', () => {
    expect(canon({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
  })

  it('produces identical output regardless of insertion order', () => {
    expect(canon({ z: 1, a: { y: 2, b: 3 } })).toBe(canon({ a: { b: 3, y: 2 }, z: 1 }))
  })

  it('emits no whitespace', () => {
    expect(canon({ a: [1, 2], b: true })).toBe('{"a":[1,2],"b":true}')
  })

  it('handles the scalar types', () => {
    expect(canon(null)).toBe('null')
    expect(canon(true)).toBe('true')
    expect(canon(false)).toBe('false')
    expect(canon(0)).toBe('0')
    expect(canon(-12)).toBe('-12')
    expect(canon('hi')).toBe('"hi"')
  })

  it('passes non-ASCII through as UTF-8 rather than escaping it', () => {
    expect(canon('é')).toBe('"é"')
    expect(canon('👍')).toBe('"👍"')
    expect(canon('日本語')).toBe('"日本語"')
  })

  it('escapes what JSON requires', () => {
    expect(canon('a\nb')).toBe('"a\\nb"')
    expect(canon('a"b')).toBe('"a\\"b"')
    expect(canon('a\\b')).toBe('"a\\\\b"')
    expect(canon('\u0001')).toBe('"\\u0001"')
  })

  it('handles empty containers', () => {
    expect(canon([])).toBe('[]')
    expect(canon({})).toBe('{}')
    expect(canon([[], {}])).toBe('[[],{}]')
  })

  it('accepts nested payloads shaped like real blocks', () => {
    const payload = { seq: 47, prev: 'a'.repeat(64), payload: { body: 'x', t: [1, 2] } }
    expect(canon(payload)).toBe(
      '{"payload":{"body":"x","t":[1,2]},"prev":"' + 'a'.repeat(64) + '","seq":47}',
    )
  })

  describe('rejects ambiguity', () => {
    const bad = (value, why) =>
      expect(() => canon(value), why).toThrow(CanonError)

    it('rejects floats', () => {
      bad(1.5, 'float')
      bad(-0.1, 'negative float')
    })

    it('rejects exponents and non-finite numbers', () => {
      bad(1e21, 'exponent')
      bad(Number.NaN, 'NaN')
      bad(Number.POSITIVE_INFINITY, 'Infinity')
    })

    it('rejects -0', () => {
      bad(-0, '-0')
    })

    it('rejects integers beyond the safe range', () => {
      bad(Number.MAX_SAFE_INTEGER + 2, 'unsafe integer')
    })

    it('rejects lone surrogates', () => {
      bad('\ud800', 'high surrogate alone')
      bad('\udc00', 'low surrogate alone')
      bad('a\ud800b', 'embedded lone surrogate')
    })

    it('rejects undefined values instead of dropping the key', () => {
      bad(undefined, 'undefined')
      bad({ a: undefined }, 'undefined property')
      bad([1, undefined], 'undefined in array')
    })

    it('rejects unsupported objects', () => {
      bad(new Date(), 'Date')
      bad(new Map(), 'Map')
      bad(new Set(), 'Set')
      bad(/x/, 'RegExp')
      bad(new Uint8Array([1]), 'typed array')
      bad({ a: 1n }, 'bigint')
    })

    it('rejects symbol keys', () => {
      bad({ [Symbol('a')]: 1 }, 'symbol key')
    })

    it('rejects cycles', () => {
      const loop = { a: 1 }
      loop.self = loop
      bad(loop, 'cycle')
    })

    it('rejects excessive depth', () => {
      let deep = 1
      for (let i = 0; i < 40; i++) deep = { a: deep }
      bad(deep, 'depth')
    })

    it('rejects functions', () => {
      bad(() => 1, 'function')
    })
  })

  it('permits reasonable depth', () => {
    let deep = 1
    for (let i = 0; i < 20; i++) deep = { a: deep }
    expect(() => canon(deep)).not.toThrow()
  })
})
