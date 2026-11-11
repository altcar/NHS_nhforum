import { describe, expect, it } from 'vitest'
import { blockHash, blockBytes, VERSION } from '../ledger/block.js'
import { verifyAppend, verifyChain, verifyCheckpoint, verifySegment } from '../ledger/chain.js'
import { ZERO_HASH } from '../ledger/hash.js'
import { signBytes } from '../ledger/sign.js'
import { clone, codesOf, newBoard, TS } from './helpers.js'

/** A fully signed six-block board. */
async function sampleBoard() {
  const board = await newBoard()
  await board.genesis()
  await board.post('first post')
  await board.post('second post')
  await board.rules([board.mod.author])
  await board.hide(await blockHash(board.chain[1]), { reason: 'off-topic' })
  await board.reply('a reply', await blockHash(board.chain[1]))
  return board
}

describe('a valid chain', () => {
  it('verifies from genesis', async () => {
    const board = await sampleBoard()
    const result = await verifyChain(board.chain)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.count).toBe(6)
    expect(result.head.seq).toBe(5)
    expect(result.head.hash).toBe(await blockHash(board.chain[5]))
  })

  it('reports a merkle root that matches a checkpoint', async () => {
    const board = await sampleBoard()
    const { root } = await verifyChain(board.chain)
    const checkpoint = await board.checkpoint()
    expect(checkpoint.payload.root).toBe(root)
  })

  it('treats an empty history as nothing to verify', async () => {
    const result = await verifyChain([])
    expect(result.ok).toBe(true)
    expect(result.count).toBe(0)
    expect(result.head).toBeNull()
  })
})

describe('tampering is detected', () => {
  const cases = [
    [
      'an edited body',
      (chain) => {
        chain[1].payload.body = 'edited after the fact'
        return 'sig'
      },
    ],
    [
      'an edited timestamp',
      (chain) => {
        chain[2].ts += 1
        return 'sig'
      },
    ],
    [
      'a swapped author',
      (chain) => {
        chain[1].author = chain[4].author
        return 'sig'
      },
    ],
    [
      'a forged signature',
      (chain) => {
        chain[3].sig = chain[2].sig
        return 'sig'
      },
    ],
    [
      'a rewired prev link',
      (chain) => {
        chain[3].prev = ZERO_HASH
        return 'prev'
      },
    ],
    [
      'a skipped sequence number',
      (chain) => {
        chain[2].seq = 9
        return 'seq'
      },
    ],
    [
      'an added field',
      (chain) => {
        chain[2].note = 'hello'
        return 'shape'
      },
    ],
    [
      'a deleted block',
      (chain) => {
        chain.splice(2, 1)
        return 'seq'
      },
    ],
    [
      'reordered blocks',
      (chain) => {
        const [a, b] = [chain[2], chain[3]]
        chain[2] = b
        chain[3] = a
        return 'seq'
      },
    ],
    [
      'a forged genesis',
      (chain) => {
        chain[0].payload = { body: 'x' }
        return 'payload'
      },
    ],
  ]

  for (const [name, mutate, code] of cases) {
    it(`detects ${name}`, async () => {
      const board = await sampleBoard()
      const tampered = clone(board.chain)
      const expected = mutate(tampered)
      const result = await verifyChain(tampered)
      expect(result.ok).toBe(false)
      expect(codesOf(result)).toContain(expected)
    })
  }
})

describe('authority rules', () => {
  it('lets the root key set moderators', async () => {
    const board = await sampleBoard()
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(true)
  })

  it('rejects moderation by an unauthorised key', async () => {
    const board = await newBoard()
    await board.genesis()
    const post = await board.post()
    await board.hide(await blockHash(post), { key: board.alice }) // alice is not a moderator
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('authority')
  })

  it('rejects a rules change signed by a non-root key', async () => {
    const board = await newBoard()
    await board.genesis()
    await board.rules([board.mod.author], board.alice)
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('authority')
  })

  it('honours a moderator set established after the genesis block', async () => {
    const board = await newBoard()
    await board.genesis()
    const post = await board.post()
    await board.rules([board.mod.author])
    await board.hide(await blockHash(post))
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(true)
  })

  it('revokes moderation when the rules are replaced', async () => {
    const board = await newBoard()
    await board.genesis()
    const post = await board.post()
    await board.rules([board.mod.author])
    await board.rules([board.alice.author]) // mod is no longer a moderator
    await board.hide(await blockHash(post), { key: board.mod })
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('authority')
  })

  it('refuses a second genesis block', async () => {
    const board = await newBoard()
    await board.genesis()
    await board.genesis()
    const result = await verifyChain(board.chain)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('genesis')
  })
})

describe('writer-side append gate', () => {
  async function nextBlock(board, head, overrides = {}) {
    const header = {
      v: VERSION,
      board: 'general',
      seq: head.seq + 1,
      prev: head.hash,
      type: 'post',
      author: board.alice.author,
      ts: TS + 99_000,
      payload: { body: 'next' },
      ...overrides,
    }
    return { ...header, sig: await signBytes(board.alice.privateKey, blockBytes(header)) }
  }

  it('accepts the next block', async () => {
    const board = await sampleBoard()
    const { head } = await verifyChain(board.chain)
    const block = await nextBlock(board, head)
    const verdict = await verifyAppend(head, block)
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.hash).toBe(await blockHash(block))
  })

  it('rejects a block built on a stale head', async () => {
    const board = await sampleBoard()
    const staleHead = { seq: 2, hash: await blockHash(board.chain[2]) }
    const block = await nextBlock(board, staleHead)
    const verdict = await verifyAppend((await verifyChain(board.chain)).head, block)
    expect(verdict.ok).toBe(false)
    expect(codesOf(verdict)).toContain('seq')
  })

  it('rejects a wrong prev link even when correctly signed', async () => {
    const board = await sampleBoard()
    const { head } = await verifyChain(board.chain)
    const block = await nextBlock(board, head, { prev: ZERO_HASH })
    const verdict = await verifyAppend(head, block)
    expect(verdict.ok).toBe(false)
    expect(codesOf(verdict)).toEqual(['prev'])
  })

  it('rejects an unsigned or tampered block', async () => {
    const board = await sampleBoard()
    const { head } = await verifyChain(board.chain)
    const block = await nextBlock(board, head)
    block.payload.body = 'changed after signing'
    const verdict = await verifyAppend(head, block)
    expect(verdict.ok).toBe(false)
    expect(codesOf(verdict)).toContain('sig')
  })

  it('rejects a far-future timestamp', async () => {
    const board = await sampleBoard()
    const { head } = await verifyChain(board.chain)
    const block = await nextBlock(board, head, { ts: TS + 10 * 24 * 60 * 60 * 1000 })
    const verdict = await verifyAppend(head, block, { now: TS })
    expect(verdict.ok).toBe(false)
    expect(codesOf(verdict)).toContain('time')
  })

  it('accepts the genesis block only at the start', async () => {
    const board = await newBoard()
    const { head } = await verifyChain([])
    const block = await board.genesis()
    expect((await verifyAppend(head, block)).ok).toBe(true)

    const second = await nextBlock(board, { seq: 0, hash: await blockHash(block) }, { type: 'genesis', payload: {} })
    expect((await verifyAppend({ seq: 0, hash: await blockHash(block) }, second)).ok).toBe(false)
  })
})

describe('incremental verification', () => {
  it('verifies a suffix against a pinned hash', async () => {
    const board = await sampleBoard()
    const suffix = board.chain.slice(3)
    const result = await verifySegment(suffix, {
      fromSeq: 3,
      prevHash: await blockHash(board.chain[2]),
    })
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.head.seq).toBe(5)
  })

  it('rejects a suffix that does not extend the pinned hash', async () => {
    const board = await sampleBoard()
    const suffix = board.chain.slice(3)
    const result = await verifySegment(suffix, { fromSeq: 3, prevHash: ZERO_HASH })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('prev')
  })

  it('requires a pinned hash', async () => {
    await expect(verifySegment([], { fromSeq: 1 })).rejects.toThrow(/prevHash/)
  })

  it('does not enforce authority on a suffix (state lives with the client)', async () => {
    const board = await sampleBoard()
    const suffix = board.chain.slice(4) // starts at a mod.hide
    const result = await verifySegment(suffix, {
      fromSeq: 4,
      prevHash: await blockHash(board.chain[3]),
    })
    expect(result.ok).toBe(true)
  })
})

describe('checkpoints', () => {
  it('accepts a checkpoint that summarises the history before it', async () => {
    const board = await sampleBoard()
    const checkpoint = await board.checkpoint()
    const history = board.chain.slice(0, checkpoint.payload.size)
    const verdict = await verifyCheckpoint(history, checkpoint)
    expect(verdict.ok).toBe(true)
    expect(verdict.root).toBe(checkpoint.payload.root)
  })

  it('rejects a rewound history', async () => {
    const board = await sampleBoard()
    const checkpoint = await board.checkpoint()
    const rewound = clone(board.chain.slice(0, checkpoint.payload.size))
    rewound[1].payload.body = 'rewritten'
    const verdict = await verifyCheckpoint(rewound, checkpoint)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/rewritten|mismatch/)
  })

  it('rejects a checkpoint whose size contradicts its position', async () => {
    const board = await sampleBoard()
    const checkpoint = await board.checkpoint()
    const lying = { ...checkpoint, payload: { ...checkpoint.payload, size: 3 } }
    const verdict = await verifyCheckpoint(board.chain, lying)
    expect(verdict.ok).toBe(false)
  })

  it('rejects a truncated history', async () => {
    const board = await sampleBoard()
    const checkpoint = await board.checkpoint()
    const verdict = await verifyCheckpoint([], checkpoint)
    expect(verdict.ok).toBe(false)
  })
})
