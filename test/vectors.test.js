import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { canon } from '../ledger/canon.js'
import { blockBytes, blockHash } from '../ledger/block.js'
import { verifyChain, verifyCheckpoint } from '../ledger/chain.js'
import { sha256Hex } from '../ledger/hash.js'
import { merkleRoot, verifyInclusion } from '../ledger/merkle.js'
import { verifyBytes } from '../ledger/sign.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(
  await readFile(join(here, '..', 'spec', 'TEST-VECTORS.json'), 'utf8'),
)

/**
 * The cross-runtime canary. Any implementation of the spec — in a Worker, a
 * browser, Go, Rust — must reproduce these values byte for byte. If one of
 * these fails, the format has silently changed and every stored hash is wrong.
 */
describe('test vectors: sha256', () => {
  for (const [input, digest] of Object.entries(vectors.sha256)) {
    it(`hashes ${input === '' ? 'the empty string' : `"${input}"`}`, async () => {
      expect(await sha256Hex(input)).toBe(digest)
    })
  }
})

describe('test vectors: canonical encoding', () => {
  for (const { value, expected } of vectors.canon) {
    it(`encodes ${JSON.stringify(value)}`, () => {
      expect(canon(value)).toBe(expected)
    })
  }
})

describe('test vectors: merkle tree', () => {
  for (const { size, leaves, root, proofs } of vectors.merkle) {
    it(`reproduces the root for size ${size}`, async () => {
      expect(await merkleRoot(leaves)).toBe(root)
    })

    for (const { index, proof } of proofs) {
      it(`verifies inclusion size ${size} index ${index}`, async () => {
        expect(await verifyInclusion({ leaf: leaves[index], index, size, proof, root })).toBe(true)
      })
    }
  }
})

describe('test vectors: signed chain', () => {
  const { blocks, hashes, root, head, checkpoint } = vectors.chain

  it('hashes every block as recorded', async () => {
    for (let i = 0; i < blocks.length; i++) {
      expect(await blockHash(blocks[i])).toBe(hashes[i])
    }
  })

  it('verifies end to end', async () => {
    const result = await verifyChain(blocks)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.head).toEqual(head)
    expect(result.root).toBe(root)
  })

  it('re-verifies every signature from the carried public keys', async () => {
    for (const block of blocks) {
      expect(await verifyBytes(block.author, blockBytes(block), block.sig)).toBe(true)
    }
  })

  it('matches the recorded checkpoint', async () => {
    const target = blocks[checkpoint.seq]
    expect(target.type).toBe('checkpoint')
    expect(target.payload.size).toBe(checkpoint.size)
    expect(target.payload.root).toBe(checkpoint.root)
    const verdict = await verifyCheckpoint(blocks.slice(0, checkpoint.size), target)
    expect(verdict.ok).toBe(true)
  })
})
