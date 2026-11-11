/**
 * Terminal demo of the ledger: build a real signed chain, verify it, then
 * attack it three ways and watch each attack get caught.
 *
 * Usage: npm run demo
 */

import { blockBytes, blockHash, VERSION } from '../ledger/block.js'
import { compareHeads, verifyChain, verifyCheckpoint } from '../ledger/chain.js'
import { merkleRoot } from '../ledger/merkle.js'
import { ZERO_HASH } from '../ledger/hash.js'
import { generateKeyPair, signBytes } from '../ledger/sign.js'

const TS = 1_700_000_000_000

const paint = (code) => (text) => `\u001b[${code}m${text}\u001b[0m`
const dim = paint('2')
const green = paint('32')
const red = paint('31')
const bold = paint('1')

function rule(label) {
  console.log(`\n${bold(label)}`)
  console.log(dim('─'.repeat(Math.max(24, label.length))))
}

const short = (hash) => hash.slice(0, 12) + '…'
const plural = (n) => (n === 1 ? '1 problem' : `${n} problems`)

async function buildBoard() {
  const rootKey = await generateKeyPair()
  const poster = await generateKeyPair()
  const mod = await generateKeyPair()

  const blocks = []
  let seq = 0
  let prev = ZERO_HASH

  async function emit(type, payload, key) {
    const header = {
      v: VERSION,
      board: 'general',
      seq,
      prev,
      type,
      author: key.author,
      ts: TS + seq * 1000,
      payload,
    }
    const sig = await signBytes(key.privateKey, blockBytes(header))
    const block = { ...header, sig }
    blocks.push(block)
    seq += 1
    prev = await blockHash(block)
    return block
  }

  await emit('genesis', {}, rootKey)
  const first = await emit('post', { body: 'has anyone actually read the spec?' }, poster)
  await emit('reply', { body: 'twice', to: await blockHash(first) }, poster)
  await emit('rules', { mods: [mod.author] }, rootKey)
  await emit('mod.hide', { target: await blockHash(first), reason: 'off-topic' }, mod)
  await emit('post', { body: 'and the chain still verifies' }, poster)

  return { blocks, rootKey, poster, mod }
}

async function printBlocks(blocks) {
  console.log(dim('   seq  type          author        hash'))
  for (const block of blocks) {
    console.log(
      `   ${String(block.seq).padEnd(4)} ${block.type.padEnd(13)} ${block.author.slice(4, 10)}…   ${short(await blockHash(block))}`,
    )
  }
}

async function main() {
  const { blocks } = await buildBoard()

  rule('1. a real chain, really signed')
  await printBlocks(blocks)

  const verdict = await verifyChain(blocks)
  console.log(
    `\n${green('✓')} verified ${bold(String(verdict.count))} blocks · head seq ${verdict.head.seq} · root ${short(verdict.root)}`,
  )

  // ---------------------------------------------------------------- tamper
  rule('2. attack: edit a body in the database')
  const edited = JSON.parse(JSON.stringify(blocks))
  edited[1].payload.body = 'something the author never wrote'
  const tampered = await verifyChain(edited)
  console.log(`${red('✗ rejected')} — ${plural(tampered.problems.length)}`)
  for (const problem of tampered.problems.slice(0, 4)) {
    console.log(
      `   seq ${String(problem.seq).padEnd(3)} ${problem.code.padEnd(6)} ${dim(problem.message)}`,
    )
  }
  console.log(
    dim('\n   The server holds the data but not the key, so it cannot rewrite history and re-sign it.'),
  )

  // ------------------------------------------------------------- authority
  rule('3. attack: a non-moderator reverses a moderation decision')
  const impostor = await generateKeyPair()
  const forged = JSON.parse(JSON.stringify(blocks))
  const head = { seq: forged.length - 1, hash: await blockHash(forged[forged.length - 1]) }
  const header = {
    v: VERSION,
    board: 'general',
    seq: head.seq + 1,
    prev: head.hash,
    type: 'mod.restore',
    author: impostor.author,
    ts: TS + 9000,
    payload: { target: await blockHash(forged[1]) },
  }
  forged.push({ ...header, sig: await signBytes(impostor.privateKey, blockBytes(header)) })
  const unauthorised = await verifyChain(forged)
  console.log(`${red('✗ rejected')} — ${plural(unauthorised.problems.length)}`)
  for (const problem of unauthorised.problems) {
    console.log(
      `   seq ${String(problem.seq).padEnd(3)} ${problem.code.padEnd(9)} ${dim(problem.message)}`,
    )
  }
  console.log(dim('\n   Authority is carried in the log, so privilege escalation is provable.'))

  // -------------------------------------------------------------- rollback
  rule('4. attack: serve an older or different history')
  const hashes = []
  for (const block of blocks) hashes.push(await blockHash(block))
  const pinned = { seq: blocks.length - 1, root: await merkleRoot(hashes) }

  const served = { seq: 3, root: await merkleRoot(hashes.slice(0, 4)) }
  console.log(`   pinned  seq ${pinned.seq}  root ${short(pinned.root)}`)
  console.log(`   served  seq ${served.seq}  root ${short(served.root)}`)
  console.log(
    `   verdict ${red(compareHeads(pinned, served).toUpperCase())} — history is shorter than one already seen`,
  )
  console.log(
    `   verdict ${red(compareHeads(pinned, { seq: pinned.seq, root: served.root }).toUpperCase())} — same length, different history`,
  )

  // ------------------------------------------------------------ checkpoint
  rule('5. checkpoint honesty')
  const last = blocks[blocks.length - 1]
  const checkpoint = {
    ...last,
    type: 'checkpoint',
    payload: { size: last.seq, root: await merkleRoot(hashes.slice(0, last.seq)) },
  }
  const honest = await verifyCheckpoint(blocks, checkpoint)
  console.log(
    `   ${honest.ok ? green('✓') : red('✗')} checkpoint at seq ${last.seq} covers blocks 0–${last.seq - 1}`,
  )

  const lying = { ...checkpoint, payload: { ...checkpoint.payload, size: 2 } }
  const dishonest = await verifyCheckpoint(blocks, lying)
  console.log(`   ${dishonest.ok ? green('✓') : red('✗')} ${dim(dishonest.reason)}`)

  console.log(
    dim(
      '\n   Every check above runs in a browser too: same module, same vectors, no server trust.\n',
    ),
  )
}

await main()
