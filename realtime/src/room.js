/**
 * Room — a Durable Object that is both the single writer and the fan-out point.
 *
 * This is the piece socket.io was doing: one authoritative process holding the
 * connections. On Workers the equivalent is a DO with the WebSocket Hibernation
 * API, so idle rooms cost no duration and no client keeps a Worker warm.
 *
 * Native WebSockets, not socket.io: socket.io's protocol depends on a
 * long-lived Node process and an HTTP long-poll fallback that Workers cannot
 * serve. The client just uses WebSocket, which every browser has anyway.
 */

import { LedgerStore } from '../../shared/ledgerStore.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.store = new LedgerStore({ sql: state.storage.sql, board: env.BOARD_NAME || 'socketio' })
    state.blockConcurrencyWhile(() => this.store.init())
  }

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

    if (url.pathname === '/ws') return this.#accept()

    if (url.pathname === '/blocks') {
      const from = Number(url.searchParams.get('from') ?? 0)
      return json({ blocks: this.store.blocks({ from }), count: this.store.count() })
    }

    if (url.pathname === '/head') {
      const fresh = url.searchParams.has('fresh')
      const head = await this.#serial(() => this.store.ensureHead(fresh ? 0 : 60_000))
      return json({ ...head, latest: this.store.head()?.seq ?? -1, count: this.store.count() })
    }

    if (url.pathname === '/next') return json(this.store.next())

    return json({ error: 'not found' }, 404)
  }

  #accept() {
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    pair[1].send(
      JSON.stringify({
        type: 'hello',
        next: this.store.next(),
        latest: this.store.head()?.seq ?? -1,
        count: this.store.count(),
        sockets: this.state.getWebSockets().length,
      }),
    )
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** Hibernation-safe message handler: read state from SQLite, never memory. */
  async webSocketMessage(ws, raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      ws.send(JSON.stringify({ type: 'rejected', reason: 'not JSON' }))
      return
    }

    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', next: this.store.next() }))
      return
    }

    if (message.type !== 'post') {
      ws.send(JSON.stringify({ type: 'rejected', reason: `unknown message ${message.type}` }))
      return
    }

    const outcome = await this.#serial(() => this.store.append(message.block))
    if (outcome.status !== 200) {
      ws.send(
        JSON.stringify({
          type: 'rejected',
          reason: outcome.body.error ?? 'rejected',
          problems: outcome.body.problems ?? [],
        }),
      )
      return
    }

    this.broadcast({
      type: 'block',
      block: message.block,
      hash: outcome.body.hash,
      next: this.store.next(),
      count: this.store.count(),
    })
  }

  broadcast(payload) {
    const text = JSON.stringify(payload)
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(text)
      } catch {
        /* socket already gone; the runtime will clean it up */
      }
    }
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason)
    } catch {
      /* already closed */
    }
  }

  webSocketError(ws) {
    try {
      ws.close(1011, 'socket error')
    } catch {
      /* already closed */
    }
  }
}
