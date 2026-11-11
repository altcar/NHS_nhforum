import {
  blockBytes,
  blockHash,
  compareHeads,
  createIdentityKey,
  fingerprintOf,
  merkleRoot,
  signBytes,
  verifyChain,
} from './ledger/index.js'

const BOARD = 'socketio'
const PIN_KEY = 'nhs-epqsocketio:pin'

const $ = (id) => document.getElementById(id)
const el = {
  conn: $('conn'),
  connText: $('connText'),
  pill: $('pill'),
  meta: $('meta'),
  peers: $('peers'),
  verify: $('verify'),
  composer: $('composer'),
  body: $('body'),
  send: $('send'),
  hint: $('hint'),
  feed: $('feed'),
  empty: $('empty'),
}

const state = {
  identity: null,
  socket: null,
  next: null,
  blocks: [],
  hashes: [],
  retry: 0,
  seen: new Set(),
}

const short = (hash) => (hash ? `${hash.slice(0, 8)}…` : '—')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setConn(kind, text) {
  el.conn.dataset.state = kind
  el.connText.textContent = text
}

function setPill(kind, text) {
  el.pill.dataset.state = kind
  el.pill.textContent = text
}

/* --------------------------------------------------------------- identity */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nhforum', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('keys')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction('keys', 'readonly').objectStore('keys').get(key)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function idbPut(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction('keys', 'readwrite').objectStore('keys').put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function ensureIdentity() {
  let record = await idbGet('identity')
  if (!record) {
    record = await createIdentityKey()
    await idbPut('identity', record)
  }
  state.identity = record
  return record
}

/* --------------------------------------------------------------- render */

function render() {
  const posts = state.blocks.filter((block) => block.type === 'post' || block.type === 'reply')
  el.empty.hidden = posts.length > 0
  el.feed.replaceChildren()

  const hashBySeq = new Map(state.blocks.map((block, index) => [block.seq, state.hashes[index]]))

  for (const block of posts.slice(-300)) {
    const hash = hashBySeq.get(block.seq)
    const item = document.createElement('li')
    item.className = `item${block.author === state.identity?.author ? ' mine' : ''}`

    const head = document.createElement('div')
    head.className = 'itemhead'

    const author = document.createElement('span')
    author.className = 'author'
    fingerprintOf(block.author).then((fp) => {
      author.textContent = `anon-${fp.slice(0, 6)}`
    })
    author.title = block.author

    const seq = document.createElement('span')
    seq.className = 'seq'
    seq.textContent = `#${block.seq} · ${short(hash)}`

    head.append(author, seq)

    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = block.payload.body

    item.append(head, body)
    el.feed.append(item)
  }

  el.feed.scrollTop = el.feed.scrollHeight
}

async function verifyChainHere() {
  const [head, chain] = await Promise.all([
    fetch('/api/head?fresh=1').then((r) => r.json()),
    fetch('/api/blocks?from=0&limit=2000').then((r) => r.json()),
  ])

  const blocks = chain.blocks ?? []
  const hashes = []
  for (const block of blocks) hashes.push(await blockHash(block))

  state.blocks = blocks
  state.hashes = hashes

  const result = await verifyChain(blocks)
  let kind = 'ok'
  let text = `✓ ${blocks.length} blocks verified`

  if (!result.ok) {
    kind = 'bad'
    text = `✗ broken at ${result.problems[0]?.seq ?? '?'}`
  } else if (head && Number.isInteger(head.seq)) {
    const root = await merkleRoot(hashes.slice(0, head.size))
    const pin = JSON.parse(localStorage.getItem(PIN_KEY) || 'null')
    const outcome = compareHeads(pin, { seq: head.seq, root: head.root })
    if (root !== head.root || outcome === 'rollback' || outcome === 'fork') {
      kind = 'bad'
      text = outcome === 'fork' ? '✗ two histories exist' : '✗ history changed'
    } else {
      localStorage.setItem(PIN_KEY, JSON.stringify({ seq: head.seq, root: head.root }))
    }
    el.meta.textContent = `head #${head.seq} · root ${short(head.root)} · ${blocks.length} blocks`
  } else {
    kind = 'warn'
    text = 'no checkpoint yet'
    el.meta.textContent = `${blocks.length} blocks`
  }

  setPill(kind, text)
  render()
}

/* ---------------------------------------------------------------- socket */

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${protocol}://${location.host}/ws`)
  state.socket = socket
  setConn('connecting', 'connecting…')

  socket.addEventListener('open', () => {
    state.retry = 0
    setConn('open', 'live')
  })

  socket.addEventListener('message', async (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }

    if (message.type === 'hello') {
      state.next = message.next
      el.peers.textContent = `${message.sockets} listener${message.sockets === 1 ? '' : 's'}`
      return
    }

    if (message.type === 'pong') {
      if (message.next) state.next = message.next
      return
    }

    if (message.type === 'rejected') {
      el.hint.textContent = message.problems?.length
        ? message.problems.map((p) => `seq ${p.seq}: ${p.message}`).join('; ')
        : message.reason
      el.hint.style.color = 'var(--bad)'
      settle({ ok: false, reason: message.reason ?? 'rejected' })
      return
    }

    if (message.type === 'block') {
      state.next = message.next
      const key = `${message.block.seq}:${message.hash}`
      if (state.seen.has(key)) return
      state.seen.add(key)

      const previous = state.hashes[state.hashes.length - 1]
      state.blocks.push(message.block)
      state.hashes.push(message.hash)

      // A gap means the socket dropped messages; reload from the log.
      if (previous && message.block.prev !== previous) {
        await verifyChainHere()
        settle({ ok: true })
        return
      }

      el.hint.textContent = `appended #${message.block.seq}`
      el.hint.style.color = 'var(--dim)'
      render()

      const item = el.feed.lastElementChild
      if (item) item.classList.add('fresh')

      settle({ ok: true, block: message.block })
    }
  })

  socket.addEventListener('close', () => {
    setConn('closed', 'reconnecting…')
    state.retry += 1
    const delay = Math.min(8000, 400 * 2 ** Math.min(state.retry, 5))
    setTimeout(connect, delay)
  })

  socket.addEventListener('error', () => {
    setConn('closed', 'connection error')
  })
}

/* ------------------------------------------------------------------ post */

let awaiting = null

function settle(outcome) {
  const pending = awaiting
  awaiting = null
  if (!pending) return
  if (outcome.ok) pending.resolve(outcome)
  else pending.reject(new Error(outcome.reason ?? 'rejected'))
}

async function publish(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!state.next) {
      state.next = await fetch('/api/next').then((r) => r.json())
    }
    const draft = {
      v: 1,
      board: BOARD,
      seq: state.next.seq,
      prev: state.next.prev,
      type: 'post',
      author: state.identity.author,
      ts: Date.now(),
      payload: { body: text },
    }
    draft.sig = await signBytes(state.identity.privateKey, blockBytes(draft))

    if (state.socket?.readyState !== WebSocket.OPEN) throw new Error('not connected')

    try {
      await new Promise((resolve, reject) => {
        awaiting = { sig: draft.sig, resolve, reject }
        state.socket.send(JSON.stringify({ type: 'post', block: draft }))
        setTimeout(() => {
          if (awaiting?.sig === draft.sig) {
            awaiting = null
            reject(new Error('no reply from the writer'))
          }
        }, 6000)
      })
      return
    } catch (err) {
      if (String(err.message).includes('stale')) {
        state.next = null
        continue
      }
      throw err
    }
  }
  throw new Error('lost the race for the next block three times')
}

/* ---------------------------------------------------------------- events */

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = el.body.value.trim()
  if (!text) return

  el.send.disabled = true
  el.send.textContent = 'signing…'
  try {
    await publish(text)
    el.body.value = ''
  } catch (err) {
    el.hint.textContent = String(err.message ?? err)
    el.hint.style.color = 'var(--bad)'
  } finally {
    el.send.disabled = false
    el.send.textContent = 'send'
  }
})

el.verify.addEventListener('click', () => verifyChainHere())

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    await ensureIdentity()
  } catch (err) {
    el.hint.textContent = `no signing key available: ${err.message}`
    el.hint.style.color = 'var(--bad)'
    return
  }

  await verifyChainHere()
  connect()

  setInterval(() => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'ping' }))
    }
  }, 25_000)
}

boot()
