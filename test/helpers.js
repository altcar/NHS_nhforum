import { blockBytes, blockHash, VERSION } from '../ledger/block.js'
import { ZERO_HASH } from '../ledger/hash.js'
import { merkleRoot } from '../ledger/merkle.js'
import { generateKeyPair, signBytes } from '../ledger/sign.js'

export const TS = 1_700_000_000_000

/**
 * A test board with a root key, an ordinary author and a moderator.
 * Blocks are really signed — nothing here bypasses the crypto.
 */
export async function newBoard({ board = 'general' } = {}) {
  const root = await generateKeyPair()
  const alice = await generateKeyPair()
  const mod = await generateKeyPair()

  const state = { seq: 0, prev: ZERO_HASH }
  const chain = []

  async function emit(type, payload, key) {
    const header = {
      v: VERSION,
      board,
      seq: state.seq,
      prev: state.prev,
      type,
      author: key.author,
      ts: TS + state.seq * 1000,
      payload,
    }
    const sig = await signBytes(key.privateKey, blockBytes(header))
    const block = { ...header, sig }
    chain.push(block)
    state.seq += 1
    state.prev = await blockHash(block)
    return block
  }

  const api = {
    root,
    alice,
    mod,
    chain,
    emit,
    genesis: () => emit('genesis', {}, root),
    post: (body = 'hello', key = alice) => emit('post', { body }, key),
    reply: (body, to, key = alice) => emit('reply', { body, to }, key),
    rules: (mods, key = root) => emit('rules', { mods }, key),
    hide: (target, { key = mod, reason } = {}) =>
      emit('mod.hide', reason ? { target, reason } : { target }, key),
    restore: (target, key = mod) => emit('mod.restore', { target }, key),
    async checkpoint(key = alice) {
      const hashes = []
      for (const block of chain) hashes.push(await blockHash(block))
      return emit('checkpoint', { size: chain.length, root: await merkleRoot(hashes) }, key)
    },
  }
  return api
}

/** Deep clone that survives JSON round-tripping (blocks are plain JSON). */
export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export const codesOf = (result) => result.problems.map((p) => p.code)
