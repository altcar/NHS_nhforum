import { describe, expect, it } from 'vitest'
import {
  assertShape,
  BlockError,
  blockBytes,
  blockHash,
  canonicalText,
  genesisBlock,
  MAX_BODY,
  signedFields,
  VERSION,
} from '../ledger/block.js'
import { ZERO_HASH } from '../ledger/hash.js'
import { generateKeyPair, signBytes } from '../ledger/sign.js'

const TS = 1_700_000_000_000

async function build(overrides = {}, key) {
  const pair = key ?? (await generateKeyPair())
  const header = {
    v: VERSION,
    board: 'general',
    seq: 1,
    prev: ZERO_HASH,
    type: 'post',
    author: pair.author,
    ts: TS,
    payload: { body: 'hello' },
    ...overrides,
  }
  const sig = await signBytes(pair.privateKey, blockBytes(header))
  return { pair, block: { ...header, sig } }
}

async function expectCode(fn, code) {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BlockError)
    expect(err.code).toBe(code)
    return
  }
  throw new Error('expected a BlockError')
}

describe('block shape', () => {
  it('accepts a well-formed post', async () => {
    const { block } = await build()
    expect(assertShape(block)).toBe(true)
  })

  it('produces a genesis block with the reserved fields', async () => {
    const pair = await generateKeyPair()
    const block = genesisBlock({ board: 'general', author: pair.author, ts: TS })
    expect(block.seq).toBe(0)
    expect(block.prev).toBe(ZERO_HASH)
    expect(block.type).toBe('genesis')
    expect(block.payload).toEqual({})
    expect(block.sig).toBe('')
  })

  it('rejects unknown fields', async () => {
    const { block } = await build()
    block.extra = 'sneaky'
    await expectCode(() => assertShape(block), 'shape')
  })

  it('rejects missing fields', async () => {
    const { block } = await build()
    delete block.sig
    await expectCode(() => assertShape(block), 'shape')
  })

  it('rejects a wrong version', async () => {
    const { block } = await build({ v: 2 })
    await expectCode(() => assertShape(block), 'shape')
  })

  it('rejects unsafe or negative numbers', async () => {
    const { block } = await build()
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expectCode(() => assertShape({ ...block, seq }), 'shape')
    }
  })

  it('rejects a malformed prev hash', async () => {
    const { block } = await build({ prev: 'abc' })
    await expectCode(() => assertShape(block), 'shape')
  })

  it('rejects an unknown type', async () => {
    const { block } = await build({ type: 'transfer', payload: {} })
    await expectCode(() => assertShape(block), 'type')
  })
})

describe('payload rules', () => {
  const cases = [
    ['post with empty body', { type: 'post', payload: { body: '' } }, 'shape'],
    ['post with an oversized body', { type: 'post', payload: { body: 'x'.repeat(MAX_BODY + 1) } }, 'shape'],
    ['post with an extra field', { type: 'post', payload: { body: 'x', extra: 1 } }, 'payload'],
    ['reply without a target', { type: 'reply', payload: { body: 'x' } }, 'payload'],
    ['reply with a bad target', { type: 'reply', payload: { body: 'x', to: 'nope' } }, 'shape'],
    ['hide without a target', { type: 'mod.hide', payload: {} }, 'payload'],
    ['hide with a bad target', { type: 'mod.hide', payload: { target: 'zz' } }, 'shape'],
    ['hide with an oversized reason', { type: 'mod.hide', payload: { target: 'a'.repeat(64), reason: 'x'.repeat(281) } }, 'shape'],
    ['rules with a non-key', { type: 'rules', payload: { mods: ['alice'] } }, 'payload'],
    ['checkpoint with size 0', { type: 'checkpoint', payload: { size: 0, root: 'a'.repeat(64) } }, 'shape'],
    ['checkpoint with a bad root', { type: 'checkpoint', payload: { size: 1, root: 'nope' } }, 'shape'],
    ['genesis with a payload', { type: 'genesis', payload: { body: 'x' } }, 'payload'],
  ]

  for (const [name, overrides, code] of cases) {
    it(`rejects ${name}`, async () => {
      const { block } = await build(overrides)
      await expectCode(() => assertShape(block), code)
    })
  }
})

describe('hashes', () => {
  it('covers exactly the signed fields', async () => {
    const { block } = await build()
    expect(Object.keys(signedFields(block))).toEqual([
      'v',
      'board',
      'seq',
      'prev',
      'type',
      'author',
      'ts',
      'payload',
    ])
    expect(canonicalText(block)).not.toContain('sig')
  })

  it('is stable when the signature is regenerated', async () => {
    const pair = await generateKeyPair()
    const { block } = await build({}, pair)
    const resigned = { ...block, sig: await signBytes(pair.privateKey, blockBytes(block)) }
    expect(resigned.sig).not.toBe(block.sig)
    expect(await blockHash(resigned)).toBe(await blockHash(block))
  })

  it('changes when any signed field changes', async () => {
    const { block } = await build()
    const base = await blockHash(block)
    const mutations = [
      { board: 'other' },
      { seq: 2 },
      { prev: 'a'.repeat(64) },
      { type: 'reply' },
      { ts: TS + 1 },
      { payload: { body: 'different' } },
    ]
    for (const mutation of mutations) {
      expect(await blockHash({ ...block, ...mutation })).not.toBe(base)
    }
  })
})
