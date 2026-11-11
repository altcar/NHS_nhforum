/**
 * Board — one Durable Object per board name.
 *
 * The DO is the single writer. That is the entire "consensus" of this system,
 * and it is worth being explicit about: one validator, total order, no mining.
 * What it buys is that seq/prev are assigned atomically, so concurrent posts
 * cannot fork the log.
 */

import { LedgerStore } from '../../shared/ledgerStore.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export class Board {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.store = new LedgerStore({ sql: state.storage.sql, board: env.BOARD_NAME || 'general' })
    state.blockConcurrencyWhile(() => this.store.init())
  }

  /** Run a read-only or mutating operation with no interleaving. */
  async #serial(fn) {
    let out
    await this.state.blockConcurrencyWhile(async () => {
      try {
        out = await fn()
      } catch (err) {
        out = { status: 500, body: { error: String(err?.message ?? err) } }
      }
    })
    return out
  }

  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/head') {
      const fresh = url.searchParams.has('fresh')
      const head = await this.#serial(() => this.store.ensureHead(fresh ? 0 : 60_000))
      return json({ ...head, latest: this.store.head()?.seq ?? -1, count: this.store.count() })
    }

    if (path === '/next') return json(this.store.next())

    if (path === '/blocks') {
      const from = Number(url.searchParams.get('from') ?? 0)
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER)
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 2000), 2000)
      return json({
        blocks: this.store.blocks({ from, to, limit }),
        count: this.store.count(),
      })
    }

    if (path === '/proof') {
      const seq = Number(url.searchParams.get('seq'))
      const proof = await this.store.proof(seq)
      return proof ? json(proof) : json({ error: 'no such block' }, 404)
    }

    if (path === '/append' && request.method === 'POST') {
      const raw = await request.json()
      const outcome = await this.#serial(() => this.store.append(raw))
      return json(outcome.body, outcome.status)
    }

    if (path === '/checkpoint' && request.method === 'POST') {
      const head = await this.#serial(() => this.store.ensureHead(0))
      return json(head)
    }

    return json({ error: 'not found' }, 404)
  }
}
