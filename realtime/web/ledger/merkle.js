/**
 * Merkle tree, RFC 6962 style (the Certificate Transparency construction).
 *
 *   MTH({})      = SHA-256()
 *   MTH({d0})    = SHA-256(0x00 || d0)
 *   MTH(D[n])    = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
 *   where k is the largest power of two smaller than n.
 *
 * The 0x00/0x01 prefixes stop a leaf hash from ever colliding with an interior
 * node — the classic Merkle second-preimage trick. Reimplemented rather than
 * imported because the point of the exercise is to own the primitive.
 *
 * Inputs and outputs are lowercase hex strings; only the final concatenation
 * is done on bytes.
 */

import { fromHex, isHex, sha256Concat, toHex } from './hash.js'

const LEAF_PREFIX = new Uint8Array([0x00])
const NODE_PREFIX = new Uint8Array([0x01])

export async function leafHash(blockHashHex) {
  return toHex(await sha256Concat(LEAF_PREFIX, fromHex(blockHashHex)))
}

export async function nodeHash(leftHex, rightHex) {
  return toHex(await sha256Concat(NODE_PREFIX, fromHex(leftHex), fromHex(rightHex)))
}

/** Largest power of two strictly less than n (n >= 2). */
export function split(n) {
  let k = 1
  while (k << 1 < n) k <<= 1
  return k
}

async function mth(leaves) {
  if (leaves.length === 0) return toHex(await sha256Concat())
  if (leaves.length === 1) return leaves[0]
  const k = split(leaves.length)
  return nodeHash(await mth(leaves.slice(0, k)), await mth(leaves.slice(k)))
}

/** Root over an ordered list of block hashes. */
export async function merkleRoot(blockHashes) {
  const leaves = []
  for (const hash of blockHashes) leaves.push(await leafHash(hash))
  return mth(leaves)
}

/**
 * Inclusion proof for blockHashes[index]: sibling hashes bottom-up.
 * Anyone holding the block hash and this proof can prove it belongs to `root`.
 */
export async function inclusionProof(blockHashes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= blockHashes.length) {
    throw new Error('inclusionProof: index out of range')
  }
  const leaves = []
  for (const hash of blockHashes) leaves.push(await leafHash(hash))
  return prove(index, leaves)
}

async function prove(index, leaves) {
  if (leaves.length === 1) return []
  const k = split(leaves.length)
  if (index < k) {
    const deeper = await prove(index, leaves.slice(0, k))
    return [...deeper, await mth(leaves.slice(k))]
  }
  const deeper = await prove(index - k, leaves.slice(k))
  return [...deeper, await mth(leaves.slice(0, k))]
}

/**
 * Incremental accumulator.
 *
 * Recomputing MTH over n leaves is O(n) hashes, which blows the 10 ms CPU
 * budget on a free Worker once the board has a few thousand blocks. Instead we
 * keep the binary decomposition of the leaf count ("peaks"): one complete
 * subtree hash per set bit of n. Appending costs O(log n) hashes, and the root
 * is a fold over the peaks.
 *
 *   n = 3  ->  peaks = [leaf2, node(leaf0,leaf1)]
 *   root   =  node(peaks[1], peaks[0])
 */
export const EMPTY_STATE = { size: 0, peaks: [] }

export async function addLeaf(state, blockHashHex) {
  const peaks = state.peaks.slice()
  let node = await leafHash(blockHashHex)
  let level = 0
  while (level < peaks.length && peaks[level] != null) {
    node = await nodeHash(peaks[level], node)
    peaks[level] = null
    level += 1
  }
  peaks[level] = node
  while (peaks.length > 0 && peaks[peaks.length - 1] == null) peaks.pop()
  return { size: state.size + 1, peaks }
}

/** Root from an accumulator state. Equivalent to merkleRoot over the same leaves. */
export async function foldPeaks(state) {
  const { peaks } = state
  let root = null
  // Peaks are ordered left-to-right by size (largest subtree last in the array
  // index, but smallest subtree at index 0), so fold right-associatively:
  // n = 7 -> [leaf6, node(4,5), node(0..3)] -> node(node(0..3), node(node(4,5), leaf6))
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] == null) continue
    root = root === null ? peaks[i] : await nodeHash(peaks[i], root)
  }
  return root ?? toHex(await sha256Concat())
}

/**
 * Verify an inclusion proof.
 * @param {{leaf: string, index: number, size: number, proof: string[], root: string}} args
 */
export async function verifyInclusion({ leaf, index, size, proof, root }) {
  if (!Array.isArray(proof)) return false
  if (!Number.isInteger(index) || !Number.isInteger(size)) return false
  if (size < 1 || index < 0 || index >= size) return false
  if (!isHex(leaf, 64) || !isHex(root, 64)) return false

  const leafDigest = await leafHash(leaf)
  const folded = await fold(leafDigest, index, size, proof, 0)
  if (folded === null) return false
  return folded.used === proof.length && folded.hash === root
}

async function fold(leaf, index, size, proof, position) {
  if (size === 1) return { hash: leaf, used: position }
  const k = split(size)
  if (index < k) {
    const left = await fold(leaf, index, k, proof, position)
    if (left === null) return null
    const sibling = proof[left.used]
    if (sibling === undefined) return null
    return { hash: await nodeHash(left.hash, sibling), used: left.used + 1 }
  }
  const right = await fold(leaf, index - k, size - k, proof, position)
  if (right === null) return null
  const sibling = proof[right.used]
  if (sibling === undefined) return null
  return { hash: await nodeHash(sibling, right.hash), used: right.used + 1 }
}
