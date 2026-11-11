/**
 * Exercise the moderation path end to end against a deployed board.
 *
 * 1. generates a moderator key
 * 2. appoints it with a `rules` block signed by the board's root key
 * 3. has the moderator sign a `mod.hide` block
 * 4. verifies the whole chain, which is what enforces the authority rules
 *
 * Usage:
 *   node scripts/moderation-demo.mjs https://nhforum.example.workers.dev $ADMIN_TOKEN
 */

import { blockBytes, blockHash, generateKeyPair, signBytes } from '../ledger/index.js'
import { verifyChain } from '../ledger/chain.js'

const base = (process.argv[2] ?? 'https://nhforum.hheylau.workers.dev').replace(/\/$/, '')
const token = process.argv[3]
if (!token) {
  console.error('usage: node scripts/moderation-demo.mjs <url> <ADMIN_TOKEN>')
  process.exit(1)
}

const get = async (path) => {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.json()
}

const mod = await generateKeyPair()
console.log(`moderator key   ${mod.author.slice(0, 18)}…`)

const rules = await fetch(`${base}/api/admin/rules`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ mods: [mod.author] }),
})
const rulesResult = await rules.json()
if (!rules.ok) {
  console.error(`✗ appointing the moderator failed: ${rules.status}`, rulesResult)
  process.exit(1)
}
console.log(`appointed       rules block #${rulesResult.seq}`)

const { blocks } = await get('/api/blocks?from=0&limit=2000')
const target = [...blocks].reverse().find((block) => block.type === 'post')
if (!target) {
  console.error('no post to hide; post something first')
  process.exit(1)
}

const next = await get('/api/next')
const draft = {
  v: 1,
  board: 'general',
  seq: next.seq,
  prev: next.prev,
  type: 'mod.hide',
  author: mod.author,
  ts: Date.now(),
  payload: { target: await blockHash(target), reason: 'moderation demo' },
}
draft.sig = await signBytes(mod.privateKey, blockBytes(draft))

const hidden = await fetch(`${base}/api/blocks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(draft),
})
const hiddenResult = await hidden.json()
if (!hidden.ok) {
  console.error(`✗ hide rejected: ${hidden.status}`, hiddenResult)
  process.exit(1)
}
console.log(`hid #${target.seq}     mod.hide block #${hiddenResult.seq}`)

const final = await get('/api/blocks?from=0&limit=2000')
const verdict = await verifyChain(final.blocks)
if (!verdict.ok) {
  console.error('✗ chain does not verify after moderation', verdict.problems)
  process.exit(1)
}
console.log(`✓ ${verdict.count} blocks verify, including the authority rules`)
