/**
 * Identity and signatures.
 *
 * P-256 (ECDSA, SHA-256) rather than Ed25519 purely for reach: Secure Curves
 * (Ed25519 in WebCrypto) landed in browsers years after P-256, and school
 * machines cannot be assumed to run a current one. Verify cost is ~0.2 ms,
 * which fits comfortably inside the 10 ms free-tier CPU budget.
 *
 * Wire formats (normative):
 *   author  = base64url of the 65-byte uncompressed public point (0x04 || X || Y)
 *   sig     = base64url of the 64-byte raw signature (r || s, IEEE P1363)
 *   blob    = base64url of the encrypted JWK
 *
 * WebCrypto already emits r||s, not DER, so no conversion is needed anywhere.
 */

import { b64uDecode, b64uEncode } from './base64.js'
import { sha256Hex } from './hash.js'

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' }

const encoder = new TextEncoder()

export const AUTHOR_BYTES = 65
export const SIG_BYTES = 64
export const KDF_ITERATIONS = 600_000

/** Generate a fresh signing identity. Extractable so it can be backed up. */
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const author = b64uEncode(raw)
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    author,
    fingerprint: await fingerprintOf(author),
  }
}

/**
 * A key for a browser to keep: the private half is imported NON-extractable, so
 * no script (including an XSS payload) can read it back out. It can still sign.
 * The temporary extractable key used for the export is dropped immediately.
 */
export async function createIdentityKey() {
  const pair = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const privateKey = await crypto.subtle.importKey('jwk', jwk, KEY_ALG, false, ['sign'])
  return { privateKey, author: b64uEncode(raw) }
}

/** Stable short id for display. Never used for verification. */
export async function fingerprintOf(author) {
  return (await sha256Hex(b64uDecode(author))).slice(0, 16)
}

export function isAuthor(value) {
  if (typeof value !== 'string') return false
  try {
    const raw = b64uDecode(value)
    return raw.length === AUTHOR_BYTES && raw[0] === 4
  } catch {
    return false
  }
}

export function isSignature(value) {
  if (typeof value !== 'string') return false
  try {
    return b64uDecode(value).length === SIG_BYTES
  } catch {
    return false
  }
}

/** Sign raw bytes (never a string — hashing rules live in canon.js). */
export async function signBytes(privateKey, bytes) {
  const signature = await crypto.subtle.sign(SIGN_ALG, privateKey, bytes)
  return b64uEncode(new Uint8Array(signature))
}

/** Verify a signature. Returns false for malformed input rather than throwing. */
export async function verifyBytes(author, bytes, signature) {
  if (!isAuthor(author) || !isSignature(signature)) return false
  try {
    const key = await crypto.subtle.importKey('raw', b64uDecode(author), KEY_ALG, false, ['verify'])
    return await crypto.subtle.verify(SIGN_ALG, key, b64uDecode(signature), bytes)
  } catch {
    return false
  }
}

/**
 * Encrypt the private key for backup under a passphrase.
 * PBKDF2 at 600k iterations is deliberately slow (~200 ms) — it runs in the
 * browser only. Never call this inside a Worker: the 10 ms CPU budget forbids it.
 */
export async function encryptIdentity(privateKey, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('passphrase must be at least 12 characters')
  }
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(jwk)),
  )
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: b64uEncode(salt),
    iv: b64uEncode(iv),
    blob: b64uEncode(new Uint8Array(sealed)),
  }
}

/** Decrypt a backup blob into a NON-extractable signing key. Throws on wrong passphrase. */
export async function decryptIdentity(backup, passphrase) {
  if (!backup || backup.v !== 1 || backup.kdf !== 'PBKDF2-SHA256') {
    throw new Error('unrecognised identity backup')
  }
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64uDecode(backup.salt),
      iterations: backup.iterations,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  let plain
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uDecode(backup.iv) },
      key,
      b64uDecode(backup.blob),
    )
  } catch {
    throw new Error('wrong passphrase or corrupted backup')
  }
  const jwk = JSON.parse(new TextDecoder().decode(plain))
  const privateKey = await crypto.subtle.importKey('jwk', jwk, KEY_ALG, false, ['sign'])
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    KEY_ALG,
    true,
    ['verify'],
  )
  const author = b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)))
  return { privateKey, publicKey, author, fingerprint: await fingerprintOf(author) }
}
