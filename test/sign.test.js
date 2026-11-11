import { describe, expect, it } from 'vitest'
import {
  decryptIdentity,
  encryptIdentity,
  fingerprintOf,
  generateKeyPair,
  isAuthor,
  isSignature,
  signBytes,
  verifyBytes,
} from '../ledger/sign.js'
import { b64uDecode } from '../ledger/base64.js'

const encoder = new TextEncoder()

describe('identity', () => {
  it('generates a usable P-256 public point', async () => {
    const pair = await generateKeyPair()
    expect(isAuthor(pair.author)).toBe(true)
    expect(b64uDecode(pair.author).length).toBe(65)
    expect(b64uDecode(pair.author)[0]).toBe(0x04)
  })

  it('derives a stable 16-character fingerprint', async () => {
    const pair = await generateKeyPair()
    const fingerprint = await fingerprintOf(pair.author)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(await fingerprintOf(pair.author)).toBe(fingerprint)
  })

  it('gives different keys different authors', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    expect(a.author).not.toBe(b.author)
  })
})

describe('signatures', () => {
  it('verifies a signature over exact bytes', async () => {
    const pair = await generateKeyPair()
    const bytes = encoder.encode('hello')
    const signature = await signBytes(pair.privateKey, bytes)
    expect(isSignature(signature)).toBe(true)
    expect(b64uDecode(signature).length).toBe(64)
    expect(await verifyBytes(pair.author, bytes, signature)).toBe(true)
  })

  it('rejects a tampered message', async () => {
    const pair = await generateKeyPair()
    const signature = await signBytes(pair.privateKey, encoder.encode('hello'))
    expect(await verifyBytes(pair.author, encoder.encode('hellO'), signature)).toBe(false)
  })

  it('rejects another key as author', async () => {
    const signer = await generateKeyPair()
    const impostor = await generateKeyPair()
    const bytes = encoder.encode('hello')
    const signature = await signBytes(signer.privateKey, bytes)
    expect(await verifyBytes(impostor.author, bytes, signature)).toBe(false)
  })

  it('returns false for malformed input rather than throwing', async () => {
    const pair = await generateKeyPair()
    const bytes = encoder.encode('hello')
    expect(await verifyBytes('not-a-key', bytes, 'not-a-sig')).toBe(false)
    expect(await verifyBytes(pair.author, bytes, 'AAAA')).toBe(false)
  })

  it('produces a different signature each time (randomised ECDSA)', async () => {
    const pair = await generateKeyPair()
    const bytes = encoder.encode('hello')
    const first = await signBytes(pair.privateKey, bytes)
    const second = await signBytes(pair.privateKey, bytes)
    expect(first).not.toBe(second)
    expect(await verifyBytes(pair.author, bytes, second)).toBe(true)
  })
})

describe('encrypted identity backup', () => {
  const passphrase = 'correct horse battery staple'

  it('round-trips to the same author', async () => {
    const pair = await generateKeyPair()
    const backup = await encryptIdentity(pair.privateKey, passphrase)
    const restored = await decryptIdentity(backup, passphrase)
    expect(restored.author).toBe(pair.author)

    const bytes = encoder.encode('proof')
    const signature = await signBytes(restored.privateKey, bytes)
    expect(await verifyBytes(pair.author, bytes, signature)).toBe(true)
  })

  it('restores a non-extractable key', async () => {
    const pair = await generateKeyPair()
    const backup = await encryptIdentity(pair.privateKey, passphrase)
    const restored = await decryptIdentity(backup, passphrase)
    await expect(crypto.subtle.exportKey('jwk', restored.privateKey)).rejects.toThrow()
  })

  it('rejects the wrong passphrase', async () => {
    const pair = await generateKeyPair()
    const backup = await encryptIdentity(pair.privateKey, passphrase)
    await expect(decryptIdentity(backup, 'wrong horse battery staple')).rejects.toThrow(
      /wrong passphrase/,
    )
  })

  it('refuses short passphrases', async () => {
    const pair = await generateKeyPair()
    await expect(encryptIdentity(pair.privateKey, 'short')).rejects.toThrow(/12 characters/)
  })
})
