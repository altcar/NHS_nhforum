/**
 * Block shape, payload rules, canonical bytes and hashes.
 *
 * A block is the unit of authorship. The writer assigns `seq` and `prev`
 * (ordering); the author signs everything else. That split is the security
 * model in one line: the server can order and withhold, it cannot speak as you.
 */

import { b64uDecode } from './base64.js'
import { canon, canonBytes } from './canon.js'
import { isHex, sha256Hex, ZERO_HASH } from './hash.js'
import { AUTHOR_BYTES, isAuthor, isSignature } from './sign.js'

export const VERSION = 1
export const MAX_BODY = 4096
export const MAX_HANDLE = 32
export const MAX_REASON = 280
export const MAX_BOARD = 64

/** Types accepted in v1. Unknown types are invalid — strict, so the set is a contract. */
export const TYPES = Object.freeze([
  'genesis',
  'post',
  'reply',
  'mod.hide',
  'mod.restore',
  'rules',
  'checkpoint',
])

export const FIELDS = Object.freeze([
  'v',
  'board',
  'seq',
  'prev',
  'type',
  'author',
  'ts',
  'payload',
  'sig',
])

/** Reserved for v2. Listed so nobody thinks they were forgotten. */
export const RESERVED_TYPES = Object.freeze(['key.claim', 'handle.verify', 'react'])

export class BlockError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BlockError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new BlockError(code, message)
}

function checkString(value, { field, min = 1, max }) {
  if (typeof value !== 'string') fail('shape', `${field} must be a string`)
  if (value.length < min) fail('shape', `${field} must not be empty`)
  if (value.length > max) fail('shape', `${field} exceeds ${max} characters`)
  if (value.length > 0 && value.trim().length === 0) fail('shape', `${field} must not be blank`)
}

function checkInt(value, { field, min = 0 }) {
  if (!Number.isSafeInteger(value) || value < min) fail('shape', `${field} must be an integer >= ${min}`)
}

function checkHash(value, field) {
  if (!isHex(value, 64)) fail('shape', `${field} must be 64 lowercase hex characters`)
}

/** Structural validation. Does not check the signature. */
export function assertShape(block) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    fail('shape', 'block must be an object')
  }
  const keys = Object.keys(block)
  for (const key of keys) {
    if (!FIELDS.includes(key)) fail('shape', `unexpected field ${key}`)
  }
  for (const field of FIELDS) {
    if (!(field in block)) fail('shape', `missing field ${field}`)
  }

  if (block.v !== VERSION) fail('shape', `unsupported version ${block.v}`)
  checkString(block.board, { field: 'board', max: MAX_BOARD })
  checkInt(block.seq, { field: 'seq' })
  checkHash(block.prev, 'prev')
  if (!TYPES.includes(block.type)) fail('type', `unknown block type ${block.type}`)
  if (!isAuthor(block.author)) fail('shape', 'author is not a P-256 public key')
  checkInt(block.ts, { field: 'ts' })
  if (!isSignature(block.sig)) fail('shape', 'sig is not a 64-byte signature')
  if (block.payload === null || typeof block.payload !== 'object' || Array.isArray(block.payload)) {
    fail('shape', 'payload must be an object')
  }
  assertPayload(block.type, block.payload)
  return true
}

function assertKeys(payload, allowed, required = allowed) {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) fail('payload', `unexpected payload field ${key}`)
  }
  for (const key of required) {
    if (!(key in payload)) fail('payload', `missing payload field ${key}`)
  }
}

/** Per-type payload validation. This table is the "contract" of the log. */
export function assertPayload(type, payload) {
  switch (type) {
    case 'genesis':
      assertKeys(payload, [], [])
      return true

    case 'post':
      assertKeys(payload, ['body'])
      checkString(payload.body, { field: 'body', max: MAX_BODY })
      return true

    case 'reply':
      assertKeys(payload, ['body', 'to'])
      checkString(payload.body, { field: 'body', max: MAX_BODY })
      checkHash(payload.to, 'to')
      return true

    case 'mod.hide': {
      assertKeys(payload, ['target', 'reason'], ['target'])
      checkHash(payload.target, 'target')
      if (payload.reason !== undefined) checkString(payload.reason, { field: 'reason', max: MAX_REASON })
      return true
    }

    case 'mod.restore':
      assertKeys(payload, ['target'])
      checkHash(payload.target, 'target')
      return true

    case 'rules': {
      assertKeys(payload, ['mods'])
      if (!Array.isArray(payload.mods)) fail('payload', 'mods must be an array')
      if (payload.mods.length > 32) fail('payload', 'at most 32 moderators')
      for (const author of payload.mods) {
        if (!isAuthor(author)) fail('payload', 'mods must be public keys')
      }
      return true
    }

    case 'checkpoint': {
      assertKeys(payload, ['size', 'root'])
      checkInt(payload.size, { field: 'size', min: 1 })
      checkHash(payload.root, 'root')
      return true
    }

    default:
      fail('type', `no payload rules for type ${type}`)
  }
}

/** The signed portion: everything except `sig`. */
export function signedFields(block) {
  return {
    v: block.v,
    board: block.board,
    seq: block.seq,
    prev: block.prev,
    type: block.type,
    author: block.author,
    ts: block.ts,
    payload: block.payload,
  }
}

/** Canonical bytes that the author signs and everyone hashes. */
export function blockBytes(block) {
  return canonBytes(signedFields(block))
}

/**
 * Block hash = SHA-256 over the canonical signed fields.
 * `sig` is excluded on purpose: ECDSA signatures are randomised, so a signature
 * that is re-generated (same key, same content) must not change the block's
 * identity, otherwise `prev` links would be unstable.
 */
export function blockHash(block) {
  return sha256Hex(blockBytes(block))
}

export function canonicalText(block) {
  return canon(signedFields(block))
}

/** Build an unsigned genesis block for a board. Caller signs it. */
export function genesisBlock({ board, author, ts }) {
  return { v: VERSION, board, seq: 0, prev: ZERO_HASH, type: 'genesis', author, ts, payload: {}, sig: '' }
}

export function assertAuthorBytes(author) {
  const raw = b64uDecode(author)
  if (raw.length !== AUTHOR_BYTES) fail('shape', 'author has the wrong length')
  return true
}
