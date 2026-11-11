import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../ledger/hash.js'
import {
  addLeaf,
  EMPTY_STATE,
  foldPeaks,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  split,
  verifyInclusion,
} from '../ledger/merkle.js'

const hashes = async (count) => {
  const out = []
  for (let i = 0; i < count; i++) out.push(await sha256Hex(`block-${i}`))
  return out
}

describe('tree shape', () => {
  it('defines the empty tree as SHA-256 of nothing', async () => {
    expect(await merkleRoot([])).toBe(await sha256Hex(''))
  })

  it('hashes a single leaf with the 0x00 prefix', async () => {
    const [only] = await hashes(1)
    expect(await merkleRoot([only])).toBe(await leafHash(only))
    expect(await leafHash(only)).not.toBe(only)
  })

  it('builds two leaves as node(l, r) with the 0x01 prefix', async () => {
    const [a, b] = await hashes(2)
    const expected = await nodeHash(await leafHash(a), await leafHash(b))
    expect(await merkleRoot([a, b])).toBe(expected)
  })

  it('splits three leaves at the largest power of two below n', async () => {
    const [a, b, c] = await hashes(3)
    const left = await nodeHash(await leafHash(a), await leafHash(b))
    const expected = await nodeHash(left, await leafHash(c))
    expect(await merkleRoot([a, b, c])).toBe(expected)
  })

  it('computes the split rule correctly', () => {
    expect([2, 3, 4, 5, 8, 9, 16, 17].map(split)).toEqual([1, 2, 2, 4, 4, 8, 8, 16])
  })

  it('keeps leaf and interior hashes in different domains', async () => {
    const [a] = await hashes(1)
    const leaf = await leafHash(a)
    const node = await nodeHash(a, a)
    expect(leaf).not.toBe(node)
  })
})

describe('incremental accumulator', () => {
  it('matches the full tree for every size from 0 to 40', async () => {
    let state = EMPTY_STATE
    const list = []
    for (let size = 0; size <= 40; size++) {
      expect(await foldPeaks(state), `size=${size}`).toBe(await merkleRoot(list))
      const next = await sha256Hex(`incremental-${size}`)
      list.push(next)
      state = await addLeaf(state, next)
    }
  })

  it('keeps one peak per set bit of the size', async () => {
    let state = EMPTY_STATE
    for (let i = 0; i < 13; i++) {
      state = await addLeaf(state, await sha256Hex(`peak-${i}`))
      const setBits = state.size.toString(2).split('').filter((b) => b === '1').length
      expect(state.peaks.filter(Boolean).length).toBe(setBits)
    }
  })

  it('costs logarithmic hashes per append', async () => {
    let state = EMPTY_STATE
    for (let i = 0; i < 64; i++) state = await addLeaf(state, await sha256Hex(`log-${i}`))
    expect(state.peaks.length).toBeLessThanOrEqual(7)
  })

  it('produces roots that inclusion proofs still verify against', async () => {
    let state = EMPTY_STATE
    const list = []
    for (let i = 0; i < 9; i++) {
      const hash = await sha256Hex(`proof-${i}`)
      list.push(hash)
      state = await addLeaf(state, hash)
    }
    const root = await foldPeaks(state)
    for (let index = 0; index < list.length; index++) {
      const proof = await inclusionProof(list, index)
      expect(await verifyInclusion({ leaf: list[index], index, size: 9, proof, root })).toBe(true)
    }
  })
})

describe('inclusion proofs', () => {
  it('verifies every index for every size from 1 to 24', async () => {
    for (let size = 1; size <= 24; size++) {
      const list = await hashes(size)
      const root = await merkleRoot(list)
      for (let index = 0; index < size; index++) {
        const proof = await inclusionProof(list, index)
        const ok = await verifyInclusion({ leaf: list[index], index, size, proof, root })
        expect(ok, `size=${size} index=${index}`).toBe(true)
      }
    }
  })

  it('keeps proofs logarithmic', async () => {
    const list = await hashes(64)
    const proof = await inclusionProof(list, 37)
    expect(proof.length).toBe(6)
  })

  it('rejects a tampered leaf', async () => {
    const list = await hashes(7)
    const root = await merkleRoot(list)
    const proof = await inclusionProof(list, 3)
    const forged = await sha256Hex('not-the-block')
    expect(await verifyInclusion({ leaf: forged, index: 3, size: 7, proof, root })).toBe(false)
  })

  it('rejects the wrong index', async () => {
    const list = await hashes(7)
    const root = await merkleRoot(list)
    const proof = await inclusionProof(list, 3)
    expect(await verifyInclusion({ leaf: list[3], index: 4, size: 7, proof, root })).toBe(false)
  })

  it('rejects a size that cannot contain the index', async () => {
    const list = await hashes(7)
    const root = await merkleRoot(list)
    const proof = await inclusionProof(list, 3)
    expect(await verifyInclusion({ leaf: list[3], index: 3, size: 3, proof, root })).toBe(false)
    expect(await verifyInclusion({ leaf: list[3], index: 3, size: 0, proof, root })).toBe(false)
  })

  it('rejects a proof that does not match the claimed size', async () => {
    const list = await hashes(7)
    const proof = await inclusionProof(list, 3)
    const rootOfSix = await merkleRoot(list.slice(0, 6))
    expect(
      await verifyInclusion({ leaf: list[3], index: 3, size: 6, proof, root: rootOfSix }),
    ).toBe(false)
  })

  it('rejects the wrong root', async () => {
    const list = await hashes(7)
    const proof = await inclusionProof(list, 2)
    const wrongRoot = await merkleRoot(await hashes(8))
    expect(await verifyInclusion({ leaf: list[2], index: 2, size: 7, proof, root: wrongRoot })).toBe(
      false,
    )
  })

  it('rejects a truncated or padded proof', async () => {
    const list = await hashes(9)
    const root = await merkleRoot(list)
    const proof = await inclusionProof(list, 5)
    for (const broken of [proof.slice(0, -1), [...proof, proof[0]]]) {
      expect(await verifyInclusion({ leaf: list[5], index: 5, size: 9, proof: broken, root })).toBe(
        false,
      )
    }
  })

  it('rejects an out-of-range index when generating', async () => {
    const list = await hashes(3)
    await expect(inclusionProof(list, 3)).rejects.toThrow(/out of range/)
    await expect(inclusionProof(list, -1)).rejects.toThrow(/out of range/)
  })
})
