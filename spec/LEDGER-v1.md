# LEDGER-v1 — nhforum verifiable append-only log

Status: normative
Version: 1
Implementations: `ledger/` (reference), any client that ships `ledger/`

This document specifies exactly what a block is, how it is encoded, how it is
hashed, and what a verifier must check. If an implementation produces a
different byte sequence for the same content, it is wrong — the bytes are the
protocol.

---

## 1. Scope

A **ledger** is an ordered sequence of **blocks**. Each block is authored and
signed by a key pair, and commits to the hash of the block before it. A
**checkpoint** block summarises the history up to itself with a Merkle root.

### What this format provides

- **Integrity**: any change to any byte of any block is detectable by anyone.
- **Authorship**: a block cannot be attributed to a key that did not sign it.
- **Total order**: `seq` plus `prev` fix an unambiguous history.
- **Compact proof of inclusion**: a block can be proven to belong to a history
  without sending the whole history.
- **Append-only detection**: a truncated or rewritten history contradicts a
  previously pinned checkpoint.

### What this format does not provide

- **Censorship resistance.** One writer orders the log. It may refuse to append,
  or refuse to serve. Refusal is not detectable from the log alone.
- **Availability.** If the only server goes away, so does the log, unless
  someone kept a copy.
- **Consensus.** There is exactly one validator. `seq` is whatever that
  validator says it is.
- **Non-repudiation of withholding.** A split view (different histories served
  to different readers) is only detectable by comparing heads out of band.

Stated plainly: this is a **verifiable** log, not a **decentralised** one. It is
the design of Certificate Transparency and Sigsum, not the design of Bitcoin.
Any claim beyond that is false and the essay should say so.

---

## 2. Canonical encoding

Blocks are hashed as canonical JSON, UTF-8 encoded, with no whitespace.

Accepted values:

| Type | Rule |
|---|---|
| `null` | literal `null` |
| boolean | literal `true` / `false` |
| string | well-formed UTF-16, no lone surrogates; escaped as `JSON.stringify` escapes it |
| number | **safe integers only** (`Number.isSafeInteger`), never `-0`, never a float |
| array | order preserved, `[a,b]` |
| object | plain object (`Object.prototype` or `null` prototype); keys sorted |

Specific rules:

1. **Key order** is ascending by UTF-16 code unit, as in RFC 8785 (JCS).
2. **No floats.** `1.0`, `1e3`, `0.5` are rejected. Send fractions as strings.
   This removes the entire exponent-formatting and precision ambiguity class at
   the cost of one rule the payload schema can live with.
3. **No `undefined`.** A key with an `undefined` value is an error, never
   silently dropped: dropping is how two implementations quietly disagree.
4. **No lone surrogates.** `"\uD800"` is rejected. Valid surrogate pairs pass
   through unescaped, so emoji are fine.
5. **No `Date`, `Map`, `Set`, `RegExp`, `BigInt`, typed arrays, class instances.**
6. **No symbol keys.**
7. **No cycles.**
8. **Maximum depth 32.**

Separators are `,` and `:` with no spaces.

Example:

```json
{"a":1,"b":[true,null,"x"],"z":"é"}
```

Note `é` is emitted as the literal UTF-8 character, not `\u00e9`.

---

## 3. Identity and signatures

| Property | Value |
|---|---|
| Curve | NIST P-256 |
| Signature | ECDSA over SHA-256 |
| `author` | base64url (unpadded) of the 65-byte uncompressed public point `0x04 ‖ X ‖ Y` |
| `sig` | base64url (unpadded) of the 64-byte raw signature `r ‖ s` (IEEE P1363) |
| fingerprint | `hex(SHA-256(raw point))[0:16]` — display only, never for verification |

WebCrypto emits `r‖s` directly; no DER conversion is specified or permitted.
Because the full public key travels with every block, verification needs no key
registry and no network lookup.

A block's `author` is a pseudonym. Nothing in this format links a key to a
person; that is a policy layer above the ledger, and its absence is a feature.

---

## 4. Block

```jsonc
{
  "v": 1,
  "board": "general",
  "seq": 47,
  "prev": "b3f1…",            // SHA-256 hex, 64 chars
  "type": "post",
  "author": "BAAx…",          // base64url, 87 chars
  "ts": 1778539200000,        // author-claimed, advisory
  "payload": { "body": "…" },
  "sig": "MEUCIQ…"            // base64url, 86 chars
}
```

Rules:

- Exactly these nine fields. An unknown field is invalid; a missing field is
  invalid. Strictness is what makes the set a contract rather than a suggestion.
- `seq` is a non-negative safe integer, contiguous from 0.
- `prev` is 64 lowercase hex characters.
- `ts` is a non-negative safe integer of milliseconds since the Unix epoch.
  **It is advisory.** A verifier must not sort or validate by `ts`; the total
  order is `seq`. A writer may reject blocks timestamped too far in the future,
  but this is a policy decision, not part of chain validity.
- `author` must decode to 65 bytes beginning with `0x04`.
- `sig` must decode to 64 bytes.

### 4.1 Signed bytes

```
signed = canonical({ v, board, seq, prev, type, author, ts, payload })
sig    = ECDSA-P256-SHA256(privateKey, utf8(signed))
```

`sig` is excluded from its own input, as it must be.

### 4.2 Block hash

```
hash = SHA-256(utf8(canonical(signed)))
```

`sig` is deliberately excluded from the hash. ECDSA is randomised: re-signing
identical content produces a different signature, and if the hash covered `sig`
then two equally valid blocks would claim different identities and every `prev`
link would be unstable. Signatures are verified; they are not hashed.

---

## 5. Chain and authority rules

Block 0 is a **genesis** block:

- `seq = 0`
- `prev = "0" × 64`
- `type = "genesis"`
- `payload = {}`

For every block at `seq = n > 0`:

- `seq` equals the previous block's `seq` + 1
- `prev` equals `hash(block n-1)`
- `type ≠ "genesis"`

### 5.1 Rules as data

The genesis author is the **root key**. Authority is then carried in the log
itself:

| Block type | Who may sign it |
|---|---|
| `genesis` | anyone, but only once, at seq 0 |
| `post`, `reply` | any key |
| `rules` | the root key only |
| `mod.hide`, `mod.restore` | a key listed in the current `mods` set |
| `checkpoint` | any key (the writer) |

The initial `mods` set is `{genesis.author}`. A `rules` block replaces it
wholesale:

```jsonc
{ "type": "rules", "payload": { "mods": ["BAAx…", "BAAy…"] } }
```

This is the honest kernel of a "smart contract": validation rules stored in the
log and versioned by it. There is one validator, so the rules are not *enforced*
against the operator — but a violation is *provable* afterwards, because both
the rule change and the offending block are in the chain with their signatures.

### 5.2 Payloads

| `type` | Payload | Constraints |
|---|---|---|
| `genesis` | `{}` | exactly empty |
| `post` | `{ body }` | 1–4096 chars, not blank |
| `reply` | `{ body, to }` | `to` = hash of the parent `post` |
| `mod.hide` | `{ target, reason? }` | `target` = hash of a block; `reason` ≤ 280 |
| `mod.restore` | `{ target }` | `target` = hash of a block |
| `rules` | `{ mods }` | array of ≤ 32 authors, each a valid public key |
| `checkpoint` | `{ size, root }` | `size` ≥ 1; `root` = 64 hex chars |

`mod.hide` does not delete anything. The hidden block remains in the chain and
remains verifiable; clients render a tombstone. Deleting would break `prev`
links and destroy the property the log exists to provide.

Reserved for a later version (invalid in v1): `key.claim`, `handle.verify`,
`react`.

---

## 6. Checkpoints and the Merkle tree

### 6.1 Tree

RFC 6962, the Certificate Transparency construction:

```
MTH({})    = SHA-256()
MTH({d0})  = SHA-256(0x00 ‖ d0)
MTH(D[n])  = SHA-256(0x01 ‖ MTH(D[0:k]) ‖ MTH(D[k:n]))
```

where `k` is the largest power of two strictly less than `n`, and `d` is a
block hash. The `0x00` / `0x01` prefixes prevent a leaf hash from being
reinterpreted as an interior node.

### 6.2 Checkpoint block

```jsonc
{
  "type": "checkpoint",
  "seq": 481,
  "payload": { "size": 481, "root": "7d1a…" }
}
```

A checkpoint at `seq = n` summarises the blocks **before** it: `size` must equal
`seq` (so `n` covers `0..n-1`), and `root` must equal `MTH` over those `n` block
hashes. The checkpoint's own hash is covered by the next checkpoint, never by
itself — a block cannot commit to its own hash.

A checkpoint whose root disagrees with the blocks before it is either corrupt or
a rewrite, and a verifier must treat that as tampering, not as a recoverable
error.

Checkpoints are what clients pin, what mirrors compare, and what gets anchored
externally. Without a head, a Merkle proof proves nothing.

### 6.3 Inclusion proof

Sibling hashes, bottom-up, for a given leaf index. Verification folds the leaf
upward using the split rule from §6.1 and requires the result to equal the root
and every proof element to be consumed.

---

## 7. Verification protocol

A reader is not required to trust the server. On load:

```
head := GET /api/head                       # latest signed checkpoint
pin  := local storage { seq, root }         # from last visit

if head.seq < pin.seq                              → ROLLBACK
if head.seq = pin.seq and head.root ≠ pin.root     → FORK
if head.seq = pin.seq and head.root  = pin.root    → up to date

else:
  blocks := GET /api/blocks?from=pin.seq+1
  verify each block's signature over its canonical signed fields
  verify seq continuity and prev links
  compute MTH over the block hashes since pin, and over the full prefix
  compare with head.root
  pin := head
```

Three outcomes must be distinguished in the UI, because they mean different
things:

| Verdict | Meaning |
|---|---|
| **Verified** | Every byte checks out. The server told the truth about this history. |
| **Rollback** | The server's history is shorter than one already seen. Something was removed. |
| **Fork** | Same length, different root. Two histories exist. |
| **Unverifiable** | Could not fetch enough to check. Not the same as verified. |

"Unverifiable" must never be displayed as success. That single rule prevents
most of the ways a verification UI can lie.

### 7.1 Why incremental

Free-tier Workers get 10 ms of CPU per request. Re-verifying 50,000 blocks is
~50,000 signature verifications (~10 s), which cannot happen inside a request
and should not happen on every page load. Hence: pin the head, fetch the
suffix, verify the suffix, and rely on the head's Merkle root for everything
before it. The platform limit and the correct design happen to agree.

---

## 8. Test vectors

`spec/TEST-VECTORS.json` is generated by `npm run vectors` and contains:

| Key | Contents |
|---|---|
| `sha256` | input → digest |
| `canon` | value → canonical string |
| `merkle` | leaf hashes, per-size roots, and proofs |
| `chain` | a signed 6-block chain, per-block hashes, final root and head |

Every implementation must reproduce `canon`, `sha256`, `merkle` and every block
hash exactly. Signatures are randomised by design, so vectors carry signatures
only to prove that verification succeeds — equality is not expected.

The reference test suite asserts all of the above, plus:

- mutating any field of any block is detected, with the right problem code
- deleting, inserting or reordering blocks is detected
- a `mod.hide` signed by a non-moderator is rejected
- a `rules` block signed by a non-root key is rejected
- inclusion proofs verify for every index of every size 1–24, and fail when the
  leaf, index, size, proof or root is altered

---

## 9. Versioning

`v` is the block format version. Adding a block type or a payload field is a
version bump; verifiers reject unknown versions and unknown types rather than
guessing. History is never migrated in place — a v2 board starts a new genesis,
and the old chain remains verifiable forever under v1.
