/**
 * Chain verification.
 *
 * Two entry points, deliberately different:
 *   verifyChain()   — full history from genesis, including the authority rules
 *   verifySegment() — a suffix given the hash before it, structure + signatures
 *
 * The split exists because a browser cannot re-verify 50k blocks inside one
 * request (10 ms CPU on the free plan), so it verifies the suffix it fetched
 * against the head it pinned last visit. See spec/LEDGER-v1.md §5.
 */

import { assertShape, blockBytes, blockHash } from './block.js'
import { ZERO_HASH } from './hash.js'
import { merkleRoot } from './merkle.js'
import { verifyBytes } from './sign.js'

const MAX_PROBLEMS = 50

class Problems {
  constructor() {
    this.list = []
  }
  add(seq, code, message) {
    if (this.list.length < MAX_PROBLEMS) this.list.push({ seq, code, message })
    this.truncated = this.list.length >= MAX_PROBLEMS
  }
  get ok() {
    return this.list.length === 0
  }
}

/**
 * Verify blocks in order.
 *
 * @param {object[]} blocks
 * @param {object} [options]
 * @param {number} [options.startSeq=0]  expected seq of blocks[0]
 * @param {string|null} [options.prevHash=null] hash of the block before blocks[0]
 * @param {boolean} [options.verifySignatures=true]
 * @param {boolean} [options.enforceAuthority=true] only applies when startSeq === 0
 * @param {number|null} [options.maxSkewMs=null] reject blocks timestamped too far ahead
 * @param {number} [options.now=Date.now()]
 */
export async function verifyChain(blocks, options = {}) {
  const {
    startSeq = 0,
    prevHash = null,
    verifySignatures = true,
    enforceAuthority = true,
    maxSkewMs = null,
    now = Date.now(),
  } = options

  const problems = new Problems()
  if (!Array.isArray(blocks)) {
    problems.add(-1, 'input', 'blocks must be an array')
    return { ok: false, count: 0, problems: problems.list, root: null, head: null }
  }

  const hashes = []
  let expectedPrev = startSeq === 0 ? ZERO_HASH : prevHash
  let mods = null
  let rootAuthor = null

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const expectedSeq = startSeq + i

    try {
      assertShape(block)
    } catch (err) {
      problems.add(block?.seq ?? expectedSeq, err.code ?? 'shape', err.message)
      return finish(i, hashes, problems, null, startSeq)
    }

    if (block.seq !== expectedSeq) {
      problems.add(block.seq, 'seq', `expected seq ${expectedSeq}, got ${block.seq}`)
    }
    if (expectedPrev !== null && block.prev !== expectedPrev) {
      problems.add(block.seq, 'prev', `prev does not match hash of seq ${block.seq - 1}`)
    }
    if (maxSkewMs !== null && block.ts > now + maxSkewMs) {
      problems.add(block.seq, 'time', 'block timestamp is in the future')
    }

    const hash = await blockHash(block)
    if (verifySignatures) {
      const valid = await verifyBytes(block.author, blockBytes(block), block.sig)
      if (!valid) problems.add(block.seq, 'sig', 'signature does not verify for this author')
    }

    if (enforceAuthority && startSeq === 0) {
      if (block.seq === 0) {
        if (block.type !== 'genesis') {
          problems.add(0, 'genesis', 'first block must be a genesis block')
        }
        if (block.prev !== ZERO_HASH) {
          problems.add(0, 'genesis', 'genesis block must have a zero prev hash')
        }
        rootAuthor = block.author
        mods = new Set([rootAuthor])
      } else if (block.type === 'genesis') {
        problems.add(block.seq, 'genesis', 'genesis is only valid at seq 0')
      } else if (block.type === 'rules') {
        if (rootAuthor !== null && block.author !== rootAuthor) {
          problems.add(block.seq, 'authority', 'only the board root key may change the rules')
        }
        mods = new Set(block.payload.mods)
      } else if (block.type === 'mod.hide' || block.type === 'mod.restore') {
        if (mods !== null && !mods.has(block.author)) {
          problems.add(block.seq, 'authority', 'moderation blocks must be signed by a moderator')
        }
      }
    }

    hashes.push(hash)
    expectedPrev = hash
  }

  const root = await merkleRoot(hashes)
  return finish(blocks.length, hashes, problems, root, startSeq)
}

function finish(count, hashes, problems, root, startSeq) {
  const head =
    hashes.length > 0 ? { seq: startSeq + count - 1, hash: hashes[hashes.length - 1] } : null
  return { ok: problems.ok, count, problems: problems.list, truncated: problems.truncated ?? false, root, head }
}

/**
 * Client-side incremental check: verify a suffix against the head the client
 * pinned last visit.
 *
 * Throws nothing; returns a verdict the UI can render directly.
 */
export async function verifySegment(blocks, { fromSeq, prevHash, verifySignatures = true } = {}) {
  if (!Number.isInteger(fromSeq) || typeof prevHash !== 'string') {
    throw new TypeError('verifySegment requires { fromSeq, prevHash }')
  }
  return verifyChain(blocks, {
    startSeq: fromSeq,
    prevHash,
    verifySignatures,
    enforceAuthority: false,
  })
}

/**
 * Check that a checkpoint block honestly summarises the history before it.
 * The writer emits these; clients pin them; mirrors compare them.
 */
export async function verifyCheckpoint(blocks, checkpoint) {
  try {
    assertShape(checkpoint)
  } catch (err) {
    return { ok: false, reason: `malformed checkpoint: ${err.message}` }
  }
  if (checkpoint.type !== 'checkpoint') return { ok: false, reason: 'not a checkpoint block' }
  const size = checkpoint.payload.size
  if (size !== checkpoint.seq) {
    return { ok: false, reason: 'checkpoint size must equal its own seq' }
  }
  if (blocks.length < size) return { ok: false, reason: 'history is shorter than the checkpoint claims' }
  const hashes = []
  for (let i = 0; i < size; i++) hashes.push(await blockHash(blocks[i]))
  const root = await merkleRoot(hashes)
  if (root !== checkpoint.payload.root) {
    return { ok: false, reason: 'merkle root mismatch — history was rewritten', expected: root }
  }
  return { ok: true, root }
}

/**
 * Compare a previously pinned head with the head just served.
 *
 * This is the single most important check a reader can make, and it costs two
 * integers: a shorter history means something was removed, and a different root
 * at the same length means two histories exist.
 *
 * Returns: 'first-contact' | 'same' | 'append' | 'rollback' | 'fork' | 'unavailable'
 */
export function compareHeads(pinned, next) {
  if (!pinned) return 'first-contact'
  if (!next) return 'unavailable'
  if (next.seq < pinned.seq) return 'rollback'
  if (next.seq === pinned.seq) return next.root === pinned.root ? 'same' : 'fork'
  return 'append'
}

/**
 * Writer-side gate: may this block follow this head?
 * The Durable Object calls this before appending; a rejection is a 4xx, not a log line.
 */
export async function verifyAppend(head, block, { maxSkewMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const problems = new Problems()
  try {
    assertShape(block)
  } catch (err) {
    problems.add(block?.seq ?? -1, err.code ?? 'shape', err.message)
    return { ok: false, problems: problems.list }
  }

  if (head === null || head === undefined) {
    if (block.seq !== 0) problems.add(block.seq, 'seq', 'first block must be seq 0')
    if (block.prev !== ZERO_HASH) problems.add(block.seq, 'prev', 'first block must chain from the zero hash')
    if (block.type !== 'genesis') problems.add(block.seq, 'genesis', 'first block must be a genesis block')
  } else {
    if (block.seq !== head.seq + 1) {
      problems.add(block.seq, 'seq', `expected seq ${head.seq + 1}, got ${block.seq}`)
    }
    if (block.prev !== head.hash) {
      problems.add(block.seq, 'prev', 'prev does not match the current head')
    }
    if (block.type === 'genesis') problems.add(block.seq, 'genesis', 'genesis is only valid at seq 0')
  }

  if (maxSkewMs !== null && block.ts > now + maxSkewMs) {
    problems.add(block.seq, 'time', 'block timestamp is too far in the future')
  }
  if (!(await verifyBytes(block.author, blockBytes(block), block.sig))) {
    problems.add(block.seq, 'sig', 'signature does not verify for this author')
  }

  return { ok: problems.ok, problems: problems.list, hash: problems.ok ? await blockHash(block) : null }
}
