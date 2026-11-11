/**
 * End-to-end smoke test against a deployed Worker.
 *
 * Signs real blocks with a throwaway key, posts them, then verifies the chain
 * the way a browser would — including recomputing the Merkle root and comparing
 * it to the head the server served.
 *
 * Usage: node scripts/smoke.mjs https://nhforum.hheylau.workers.dev
 */

import { blockBytes, blockHash, generateKeyPair, merkleRoot, signBytes } from '../ledger/index.js'
import { verifyChain } from '../ledger/chain.js'

const base = (process.argv[2] ?? 'https://nhforum.hheylau.workers.dev').replace(/\/$/, '')
const board = process.argv[3] ?? 'general'

const get = async (path) => {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.json()
}

async function post(key, type, body, to = null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await get('/api/next')
    const payload = type === 'reply' ? { body, to } : { body }
    const draft = {
      v: 1,
      board,
      seq: next.seq,
      prev: next.prev,
      type,
      author: key.author,
      ts: Date.now(),
      payload,
    }
    draft.sig = await signBytes(key.privateKey, blockBytes(draft))
    const response = await fetch(`${base}/api/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    const result = await response.json()
    if (response.ok) return result
    if (response.status === 409) continue
    throw new Error(`POST /api/blocks → ${response.status}: ${JSON.stringify(result)}`)
  }
  throw new Error('gave up after three stale-head retries')
}

const key = await generateKeyPair()

console.log(`target   ${base}`)

const head0 = await get('/api/head')
console.log(`head in  #${head0.seq} root ${String(head0.root).slice(0, 16)}… ${head0.count} blocks`)

const first = await post(key, 'post', `smoke test ${new Date().toISOString()}`)
const second = await post(key, 'reply', 'and a reply', first.hash)
await post(key, 'post', 'third block')
console.log(`appended #${first.seq} #${second.seq} and one more`)

const { blocks } = await get('/api/blocks?from=0&limit=2000')
const result = await verifyChain(blocks)
if (!result.ok) {
  console.error('✗ chain does not verify', result.problems)
  process.exit(1)
}

const head = await get('/api/head?fresh=1')
const prefix = []
for (const block of blocks.slice(0, head.size)) prefix.push(await blockHash(block))
const root = await merkleRoot(prefix)

console.log(`verified ${result.count} blocks · head #${head.seq}`)
if (root !== head.root) {
  console.error('✗ head root does not match the chain')
  console.error('  computed', root)
  console.error('  served  ', head.root)
  process.exit(1)
}
console.log(`root     ${root.slice(0, 16)}… matches the served head`)
console.log('✓ ok')
