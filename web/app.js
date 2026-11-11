import {
  blockBytes,
  blockHash,
  canonBytes,
  compareHeads,
  createIdentityKey,
  fingerprintOf,
  merkleRoot,
  signBytes,
  verifyChain,
} from './ledger/index.js'

const BOARD = 'general'
const PIN_KEY = 'nhforum:pin'
const MAX_RENDER = 400

const $ = (id) => document.getElementById(id)
const el = {
  fingerprint: $('fingerprint'),
  signin: $('signin'),
  pill: $('pill'),
  chainmeta: $('chainmeta'),
  problems: $('problems'),
  verify: $('verify'),
  download: $('download'),
  composer: $('composer'),
  body: $('body'),
  post: $('post'),
  hint: $('hint'),
  feed: $('feed'),
  empty: $('empty'),
  replynote: $('replynote'),
  replyto: $('replyto'),
  cancelreply: $('cancelreply'),
  dialog: $('signinDialog'),
  signinForm: $('signinForm'),
  signinStatus: $('signinStatus'),
  cancelSignin: $('cancelSignin'),
  sendLink: $('sendLink'),
}

const state = {
  identity: null,
  blocks: [],
  hashes: [],
  hashBySeq: new Map(),
  byHash: new Map(),
  hidden: new Map(),
  handles: new Map(),
  fingerprints: new Map(),
  replyTo: null,
  problems: [],
}

/* ------------------------------------------------------------------ utils */

const short = (hash) => (hash ? `${hash.slice(0, 8)}…` : '—')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${path} → ${response.status}`)
  return response.json()
}

function setPill(kind, text) {
  el.pill.dataset.state = kind
  el.pill.textContent = text
}

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(ts).toLocaleDateString()
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
  const fingerprint = await fingerprintOf(record.author)
  state.fingerprints.set(record.author, fingerprint)
  el.fingerprint.textContent = `anon-${fingerprint.slice(0, 6)}`
  el.fingerprint.title = record.author
  return record
}

/* -------------------------------------------------------------- rendering */

function labelFor(author) {
  const handle = state.handles.get(author)
  if (handle) return { text: handle, verified: true }
  const fingerprint = state.fingerprints.get(author)
  return { text: `anon-${(fingerprint ?? author.slice(4, 10)).slice(0, 6)}`, verified: false }
}

function renderReplyTarget(block) {
  const target = state.byHash.get(block.payload.to)
  return target ? `#${target.seq}` : short(block.payload.to)
}

function render() {
  const posts = state.blocks.filter((block) => block.type === 'post' || block.type === 'reply')
  el.empty.hidden = posts.length > 0
  el.feed.replaceChildren()

  const visible = posts.slice(-MAX_RENDER)
  for (const block of visible) {
    const hash = state.hashBySeq.get(block.seq)
    const author = labelFor(block.author)
    const item = document.createElement('li')
    item.className = `post ${block.type === 'reply' ? 'reply' : ''}`

    const header = document.createElement('div')
    header.className = 'postheader'

    const authorNode = document.createElement('span')
    authorNode.className = `author${author.verified ? ' verified' : ''}`
    authorNode.textContent = author.text
    authorNode.title = block.author

    const seqNode = document.createElement('span')
    seqNode.className = 'seq'
    seqNode.textContent = `#${block.seq}`

    const timeNode = document.createElement('time')
    timeNode.className = 'seq'
    timeNode.dateTime = new Date(block.ts).toISOString()
    timeNode.textContent = timeAgo(block.ts)

    header.append(authorNode, seqNode, timeNode)
    if (block.type === 'reply') {
      const target = document.createElement('span')
      target.className = 'seq'
      target.textContent = `→ ${renderReplyTarget(block)}`
      header.append(target)
    }

    const body = document.createElement('div')
    body.className = 'body'

    const hidden = state.hidden.get(hash)
    const isHidden = hidden !== undefined
    if (isHidden) {
      item.classList.add('mod')
      const reason = hidden ? ` — “${hidden}”` : ''
      body.classList.add('tombstone')
      body.textContent = `hidden by a moderator${reason}. the block is still in the chain.`
    } else {
      body.textContent = block.payload.body
    }

    item.append(header, body)

    if (!isHidden) {
      const footer = document.createElement('div')
      footer.className = 'postfooter'
      const replyButton = document.createElement('button')
      replyButton.type = 'button'
      replyButton.textContent = 'reply'
      replyButton.addEventListener('click', () => {
        state.replyTo = { hash, seq: block.seq }
        el.replyto.textContent = `#${block.seq}`
        el.replynote.hidden = false
        el.body.focus()
      })
      footer.append(replyButton)
      item.append(footer)
    }

    el.feed.append(item)
  }
}

/* ----------------------------------------------------------- verification */

function readPin() {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    if (!raw) return null
    const pin = JSON.parse(raw)
    return Number.isInteger(pin?.seq) && typeof pin?.root === 'string' ? pin : null
  } catch {
    return null
  }
}

function writePin(pin) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pin))
  } catch {
    /* storage disabled; verification still works, rollback detection degrades */
  }
}

async function verifyAll({ fresh = false } = {}) {
  setPill('checking', 'checking…')
  el.problems.replaceChildren()

  let head = null
  let chain = { blocks: [] }
  let handles = []
  try {
    ;[head, chain, handles] = await Promise.all([
      api(`/api/head${fresh ? '?fresh=1' : ''}`),
      api('/api/blocks?from=0&limit=2000'),
      api('/api/handles').catch(() => ({ handles: [] })),
    ])
  } catch (err) {
    setPill('bad', 'unreachable')
    el.chainmeta.textContent = String(err.message ?? err)
    return
  }

  const blocks = chain.blocks ?? []
  const hashes = []
  for (const block of blocks) hashes.push(await blockHash(block))

  state.blocks = blocks
  state.hashes = hashes
  state.hashBySeq = new Map(blocks.map((block, index) => [block.seq, hashes[index]]))
  state.byHash = new Map(blocks.map((block, index) => [hashes[index], block]))
  state.handles = new Map((handles.handles ?? []).map((row) => [row.author, row.handle]))

  const uniqueAuthors = [...new Set(blocks.map((block) => block.author))]
  await Promise.all(
    uniqueAuthors.map(async (author) => {
      if (!state.fingerprints.has(author)) {
        state.fingerprints.set(author, await fingerprintOf(author))
      }
    }),
  )

  state.hidden = new Map()
  for (const block of blocks) {
    if (block.type === 'mod.hide') state.hidden.set(block.payload.target, block.payload.reason ?? '')
    if (block.type === 'mod.restore') state.hidden.delete(block.payload.target)
  }

  const result = await verifyChain(blocks)
  state.problems = result.problems ?? []

  let verdict = 'ok'
  let headline = `✓ ${blocks.length} blocks verified`

  if (!result.ok) {
    verdict = 'bad'
    headline = `✗ chain broken at ${state.problems[0]?.seq ?? '?'}`
  } else if (head && Number.isInteger(head.seq)) {
    const prefixHashes = hashes.slice(0, head.size)
    const root = await merkleRoot(prefixHashes)
    if (root !== head.root) {
      verdict = 'bad'
      headline = '✗ head root does not match the blocks'
    } else {
      const pin = readPin()
      const outcome = compareHeads(pin, { seq: head.seq, root: head.root })
      if (outcome === 'rollback') {
        verdict = 'bad'
        headline = '✗ history is shorter than last visit'
      } else if (outcome === 'fork') {
        verdict = 'bad'
        headline = '✗ two different histories exist'
      } else {
        writePin({ seq: head.seq, root: head.root })
        headline = `✓ ${blocks.length} blocks verified`
      }
    }
  } else {
    verdict = 'warn'
    headline = 'no checkpoint yet'
  }

  setPill(verdict, headline)
  const pending = head ? Math.max(0, blocks.length - 1 - head.seq) : 0
  el.chainmeta.textContent = head
    ? `head #${head.seq} · root ${short(head.root)} · ${blocks.length} blocks${
        pending ? ` · +${pending} pending` : ''
      }`
    : `${blocks.length} blocks · no head`

  for (const problem of state.problems.slice(0, 5)) {
    const line = document.createElement('li')
    line.textContent = `seq ${problem.seq}: ${problem.code} — ${problem.message}`
    el.problems.append(line)
  }

  render()
  refreshWho()
}

/* ------------------------------------------------------------------ post */

async function publish(text, type = 'post', to = null) {
  if (!state.identity) throw new Error('no identity yet')
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await api('/api/next')
    const payload = type === 'reply' ? { body: text, to } : { body: text }
    const draft = {
      v: 1,
      board: BOARD,
      seq: next.seq,
      prev: next.prev,
      type,
      author: state.identity.author,
      ts: Date.now(),
      payload,
    }
    draft.sig = await signBytes(state.identity.privateKey, blockBytes(draft))

    const response = await fetch('/api/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })

    if (response.ok) return
    const error = await response.json().catch(() => ({}))
    if (response.status === 409 || error.error === 'stale block') {
      await sleep(150)
      continue
    }
    if (error.problems) {
      throw new Error(error.problems.map((p) => `seq ${p.seq}: ${p.message}`).join('; '))
    }
    throw new Error(error.error ?? `post failed (${response.status})`)
  }
  throw new Error('someone else posted first three times; try again')
}

/* ------------------------------------------------------------------- who */

async function refreshWho() {
  try {
    const me = await api('/api/me')
    if (me.user) {
      el.fingerprint.textContent = me.user.handle
      el.fingerprint.dataset.verified = 'true'
      el.fingerprint.title = `${me.user.email} · ${me.user.author}`
      el.signin.textContent = 'sign out'
      el.signin.dataset.mode = 'out'
    } else {
      el.signin.textContent = 'verify a handle'
      el.signin.dataset.mode = 'in'
    }
  } catch {
    /* offline: keep the anonymous label */
  }
}

/* ---------------------------------------------------------------- events */

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = el.body.value.trim()
  if (!text) return

  el.post.disabled = true
  el.post.textContent = 'signing…'
  try {
    const reply = state.replyTo
    await publish(text, reply ? 'reply' : 'post', reply?.hash ?? null)
    el.body.value = ''
    state.replyTo = null
    el.replynote.hidden = true
    await verifyAll()
  } catch (err) {
    el.hint.textContent = String(err.message ?? err)
    el.hint.style.color = 'var(--bad)'
  } finally {
    el.post.disabled = false
    el.post.textContent = 'post'
  }
})

el.cancelreply.addEventListener('click', () => {
  state.replyTo = null
  el.replynote.hidden = true
})

el.verify.addEventListener('click', () => verifyAll({ fresh: true }))

el.download.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.blocks, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `nhforum-chain-${Date.now()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
})

el.signin.addEventListener('click', async () => {
  if (el.signin.dataset.mode === 'out') {
    await fetch('/api/auth/logout', { method: 'POST' })
    el.fingerprint.dataset.verified = 'false'
    await verifyAll()
    return
  }
  el.signinStatus.textContent = ''
  el.dialog.showModal()
})

el.cancelSignin.addEventListener('click', () => el.dialog.close())

el.signinForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const email = $('email').value.trim().toLowerCase()
  const handle = $('handle').value.trim().toLowerCase()
  if (!email || !handle) return

  el.sendLink.disabled = true
  el.signinStatus.dataset.state = ''
  el.signinStatus.textContent = 'signing the claim…'

  try {
    const proof = await signBytes(state.identity.privateKey, canonBytes({ claim: email, handle }))
    const response = await fetch('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, handle, author: state.identity.author, proof }),
    })
    const result = await response.json()
    if (!response.ok) {
      el.signinStatus.dataset.state = 'bad'
      el.signinStatus.textContent = result.hint ? `${result.error} — ${result.hint}` : result.error
      return
    }
    el.signinStatus.dataset.state = 'ok'
    el.signinStatus.textContent = 'link sent. open it in this browser within 15 minutes.'
  } catch (err) {
    el.signinStatus.dataset.state = 'bad'
    el.signinStatus.textContent = String(err.message ?? err)
  } finally {
    el.sendLink.disabled = false
  }
})

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    await ensureIdentity()
  } catch (err) {
    el.hint.textContent = `this browser will not hold a signing key: ${err.message}`
    el.hint.style.color = 'var(--bad)'
    return
  }
  await verifyAll()
}

boot()
