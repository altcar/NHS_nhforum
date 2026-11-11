/**
 * End-to-end smoke test for the real-time Worker.
 *
 * Connects over WebSocket, signs a block, waits for the broadcast, then verifies
 * the resulting chain over HTTP the same way the browser does.
 *
 * Usage: node scripts/smoke-realtime.mjs https://nhs-epqsocketio.hheylau.workers.dev
 */

import { blockBytes, blockHash, generateKeyPair, merkleRoot, signBytes } from '../ledger/index.js'
import { verifyChain } from '../ledger/chain.js'

const base = (process.argv[2] ?? 'https://nhs-epqsocketio.hheylau.workers.dev').replace(/\/$/, '')
const board = 'socketio'

const key = await generateKeyPair()
const url = `${base.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`

console.log(`target   ${base}`)

const socket = new WebSocket(url)

const waitFor = (predicate, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    const listener = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (predicate(message)) {
        clearTimeout(timer)
        socket.removeEventListener('message', listener)
        resolve(message)
      }
    }
    socket.addEventListener('message', listener)
  })

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('socket error')), { once: true })
})

const hello = await waitFor((message) => message.type === 'hello')
console.log(`hello    seq ${hello.next.seq} · ${hello.count} blocks · ${hello.sockets} socket(s)`)

const draft = {
  v: 1,
  board,
  seq: hello.next.seq,
  prev: hello.next.prev,
  type: 'post',
  author: key.author,
  ts: Date.now(),
  payload: { body: `realtime smoke ${new Date().toISOString()}` },
}
draft.sig = await signBytes(key.privateKey, blockBytes(draft))

socket.send(JSON.stringify({ type: 'post', block: draft }))
const broadcast = await waitFor((message) => message.type === 'block' && message.block.sig === draft.sig)
console.log(`broadcast #${broadcast.block.seq} ${String(broadcast.hash).slice(0, 12)}…`)

socket.close()

const { blocks } = await fetch(`${base}/api/blocks?from=0&limit=2000`).then((r) => r.json())
const result = await verifyChain(blocks)
if (!result.ok) {
  console.error('✗ chain does not verify', result.problems)
  process.exit(1)
}

const head = await fetch(`${base}/api/head?fresh=1`).then((r) => r.json())
const prefix = []
for (const block of blocks.slice(0, head.size)) prefix.push(await blockHash(block))
const root = await merkleRoot(prefix)

if (root !== head.root) {
  console.error('✗ head root mismatch')
  console.error('  computed', root)
  console.error('  served  ', head.root)
  process.exit(1)
}

console.log(`verified ${result.count} blocks · head #${head.seq} · root ${root.slice(0, 12)}…`)
console.log('✓ ok')
