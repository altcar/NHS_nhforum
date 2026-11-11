/**
 * nhforum ledger — public surface.
 *
 * This module tree imports nothing outside itself and nothing runtime-specific.
 * That is the whole point: the same bytes must be produced in a Worker, in a
 * browser, and under Node, so a reader can verify the server without trusting it.
 */

export { canon, canonBytes, CanonError, MAX_DEPTH } from './canon.js'
export { sha256Bytes, sha256Hex, sha256Concat, toHex, fromHex, isHex, ZERO_HASH } from './hash.js'
export { b64uEncode, b64uDecode } from './base64.js'
export {
  AUTHOR_BYTES,
  SIG_BYTES,
  KDF_ITERATIONS,
  generateKeyPair,
  createIdentityKey,
  fingerprintOf,
  isAuthor,
  isSignature,
  signBytes,
  verifyBytes,
  encryptIdentity,
  decryptIdentity,
} from './sign.js'
export {
  VERSION,
  MAX_BODY,
  MAX_REASON,
  MAX_BOARD,
  TYPES,
  RESERVED_TYPES,
  FIELDS,
  BlockError,
  assertShape,
  assertPayload,
  signedFields,
  blockBytes,
  blockHash,
  canonicalText,
  genesisBlock,
} from './block.js'
export {
  merkleRoot,
  inclusionProof,
  verifyInclusion,
  leafHash,
  nodeHash,
  split,
  addLeaf,
  foldPeaks,
  EMPTY_STATE,
} from './merkle.js'
export { verifyChain, verifySegment, verifyCheckpoint, verifyAppend, compareHeads } from './chain.js'
