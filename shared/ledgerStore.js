/**
 * LedgerStore — the append-only log, backed by Durable Object SQLite.
 *
 * Both Workers (nhforum and nhs-epqsocketio) compose this, so there is exactly
 * one implementation of "append a signed block and keep the Merkle head".
 *
 * All mutating methods must be called inside state.blockConcurrencyWhile():
 * a Durable Object is single-threaded, but it can still interleave two requests
 * across an `await` on WebCrypto. The DO wraps every write accordingly.
 */

import {
  addLeaf,
  blockBytes,
  blockHash,
  EMPTY_STATE,
  foldPeaks,
  genesisBlock,
  generateKeyPair,
  inclusionProof,
  signBytes,
  VERSION,
  verifyAppend,
  ZERO_HASH,
} from '../ledger/index.js'

const MAX_SKEW_MS = 15 * 60 * 1000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 20

export class LedgerStore {
  constructor({ sql, board }) {
    this.sql = sql
    this.board = board
  }

  async init() {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS blocks (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)',
    )
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)',
    )
    if (!this.meta('genesis')) await this.#createGenesis()
  }

  // ------------------------------------------------------------------ meta

  meta(key) {
    const rows = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()
    return rows.length ? rows[0].value : null
  }

  setMeta(key, value) {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    )
  }

  // ---------------------------------------------------------------- blocks

  head() {
    const rows = this.sql.exec('SELECT seq, hash FROM blocks ORDER BY seq DESC LIMIT 1').toArray()
    return rows.length ? { seq: rows[0].seq, hash: rows[0].hash } : null
  }

  count() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM blocks').one().n
  }

  next() {
    const head = this.head()
    return {
      seq: head ? head.seq + 1 : 0,
      prev: head ? head.hash : ZERO_HASH,
      board: this.board,
    }
  }

  blocks({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 2000 } = {}) {
    return this.sql
      .exec(
        'SELECT body FROM blocks WHERE seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?',
        from,
        to,
        limit,
      )
      .toArray()
      .map((row) => JSON.parse(row.body))
  }

  async root() {
    const state = this.#peaks()
    return foldPeaks(state)
  }

  async proof(seq) {
    const hashes = this.sql
      .exec('SELECT hash FROM blocks ORDER BY seq ASC')
      .toArray()
      .map((row) => row.hash)
    if (!Number.isInteger(seq) || seq < 0 || seq >= hashes.length) return null
    return {
      leaf: hashes[seq],
      index: seq,
      size: hashes.length,
      proof: await inclusionProof(hashes, seq),
      root: await foldPeaks(this.#peaks()),
    }
  }

  // ----------------------------------------------------------------- write

  /** Append a client-signed block. Caller must hold blockConcurrencyWhile. */
  async append(raw) {
    if (raw === null || typeof raw !== 'object') {
      return { status: 400, body: { error: 'block must be an object' } }
    }

    const head = this.head()
    const verdict = await verifyAppend(head, raw, { maxSkewMs: MAX_SKEW_MS, now: Date.now() })
    if (!verdict.ok) {
      return { status: 400, body: { error: 'invalid block', problems: verdict.problems } }
    }

    // Reject a replay of a block we already hold (same seq, different hash).
    if (head && raw.seq <= head.seq) {
      return { status: 409, body: { error: 'stale block', expectedSeq: head.seq + 1 } }
    }

    const rate = this.#takeRate(raw.author)
    if (!rate.ok) {
      return { status: 429, body: { error: 'rate limited', retryAfter: rate.retryAfter } }
    }

    this.#insert(raw, verdict.hash)
    this.setMeta('peaks', JSON.stringify(await addLeaf(this.#peaks(), verdict.hash)))
    return { status: 200, body: { seq: raw.seq, hash: verdict.hash } }
  }

  /**
   * Guarantee a checkpoint exists that covers the whole history, and return it.
   * A checkpoint at seq n covers blocks 0..n-1, so seq = head.seq + 1.
   * Caller must hold blockConcurrencyWhile.
   */
  async ensureHead(maxAgeMs = 60_000) {
    const head = this.head()
    if (!head) return null

    const current = this.#lastCheckpoint()
    if (current && current.seq === head.seq) return describe(current)
    if (current && Date.now() - current.ts < maxAgeMs) return describe(current)

    const root = await foldPeaks(this.#peaks())
    const writer = await this.#writer()
    const block = {
      v: VERSION,
      board: this.board,
      seq: head.seq + 1,
      prev: head.hash,
      type: 'checkpoint',
      author: writer.author,
      ts: Date.now(),
      payload: { size: head.seq + 1, root },
    }
    block.sig = await signBytes(writer.privateKey, blockBytes(block))
    const hash = await blockHash(block)
    this.#insert(block, hash)
    this.setMeta('peaks', JSON.stringify(await addLeaf(this.#peaks(), hash)))
    const entry = { seq: block.seq, hash, ts: block.ts }
    this.setMeta('last_checkpoint', JSON.stringify(entry))
    return describe({ ...entry, block })
  }

  // --------------------------------------------------------------- private

  #peaks() {
    const stored = this.meta('peaks')
    if (!stored) return { ...EMPTY_STATE }
    try {
      const parsed = JSON.parse(stored)
      if (parsed && Number.isInteger(parsed.size) && Array.isArray(parsed.peaks)) return parsed
    } catch {
      /* fall through */
    }
    return { ...EMPTY_STATE }
  }

  #insert(block, hash) {
    this.sql.exec(
      'INSERT INTO blocks (seq, hash, body) VALUES (?, ?, ?)',
      block.seq,
      hash,
      JSON.stringify(block),
    )
  }

  #lastCheckpoint() {
    const stored = this.meta('last_checkpoint')
    if (!stored) return null
    try {
      const entry = JSON.parse(stored)
      const rows = this.sql.exec('SELECT body FROM blocks WHERE seq = ?', entry.seq).toArray()
      if (!rows.length) return null
      return { ...entry, block: JSON.parse(rows[0].body) }
    } catch {
      return null
    }
  }

  async #writer() {
    const stored = this.meta('writer_jwk')
    if (!stored) throw new Error('writer key missing')
    const jwk = JSON.parse(stored)
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    return { privateKey, author: this.meta('writer_author') }
  }

  async #createGenesis() {
    const pair = await generateKeyPair()
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    this.setMeta('writer_jwk', JSON.stringify(jwk))
    this.setMeta('writer_author', pair.author)

    const block = genesisBlock({ board: this.board, author: pair.author, ts: Date.now() })
    block.sig = await signBytes(pair.privateKey, blockBytes(block))
    const hash = await blockHash(block)
    this.#insert(block, hash)
    this.setMeta('peaks', JSON.stringify(await addLeaf(EMPTY_STATE, hash)))
    this.setMeta('genesis', '1')
  }

  #takeRate(key) {
    const window = Math.floor(Date.now() / RATE_WINDOW_MS)
    const rows = this.sql.exec('SELECT window, count FROM rate WHERE key = ?', key).toArray()
    if (rows.length && rows[0].window === window && rows[0].count >= RATE_LIMIT) {
      return { ok: false, retryAfter: RATE_WINDOW_MS - (Date.now() % RATE_WINDOW_MS) }
    }
    const count = rows.length && rows[0].window === window ? rows[0].count + 1 : 1
    this.sql.exec(
      'INSERT INTO rate (key, window, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window = excluded.window, count = excluded.count',
      key,
      window,
      count,
    )
    return { ok: true }
  }
}

function describe(entry) {
  return {
    seq: entry.seq,
    hash: entry.hash,
    ts: entry.ts,
    root: entry.block.payload.root,
    size: entry.block.payload.size,
  }
}
