# nhforum v2 — scope, use case, and free-blockchain feasibility

Status: proposal, pre-build
Supersedes: `altcar/NHS_EPQ` (v1, Express + MySQL + socket.io)
Target: single Worker on `<name>.workers.dev`, Cloudflare Workers **Free** plan, £0/month

---

## 1. The claim (this is the whole project in one sentence)

> A school forum where **nobody — not even the person running it — can silently change or delete what was already posted**.
> Posts can still be hidden for safeguarding reasons, but every post, edit and moderation action is signed, hash-chained, and verifiable by any reader in their own browser.

Everything below serves that sentence. Anything that doesn't serve it is out of scope.

### Why the claim has to change from v1

v1 claims "decentralised blockchain forum". Neither half survives inspection:

| v1 claims | Reality |
|---|---|
| Decentralised | One Express server. One MySQL user. One admin. The definition of centralised. |
| Blockchain | Per-post JSON files with a `prevhash` field. No signatures, no verification, no consensus, no replication. |
| Tamper-proof | The server writes the file. Whoever runs the server can rewrite all of it and no client would know. |
| Login | Username in a plaintext cookie. No session. No signature. Forgeable in one line of JS. |

The fix is not "add more blockchain". It is **narrowing the claim to something that is actually true and actually valuable**: *verifiability*, not *censorship-resistance*.

A hash chain that no one verifies is decoration. A hash chain that every client verifies is a security control. That distinction is the intellectual core of the project and is what an EPQ evaluation chapter should be about.

### What is and isn't protected

| Attacker | Protected? | Mechanism |
|---|---|---|
| Operator edits an old post in the database | **Yes** | Client re-hashes the block; hash mismatch is local and provable |
| Operator deletes a post | **Yes** | Chain breaks at that `seq`; client detects the gap |
| Operator lies about a post existing | **Partially** | Inclusion proof only if you have a signed checkpoint containing it |
| Operator forges a post as another user | **Yes** | Blocks are signed with the author's private key, which the server never holds |
| Operator rewrites history before your last visit, and you never saved a head | **No** | Needs gossip or anchoring (§6) |
| Operator runs two different versions of the forum (split view) | **Partially** | Client pins tree heads; mirrors compare heads |
| Someone with a laptop | **Yes** — no mining, so no 51% attack to mount | There is no PoW consensus to attack |
| Your government / Cloudflare | **No** | It's one account on one provider. Be honest about this. |

That table is the honest version of "decentralised", and it is far more defensible in a viva than a claim you can't demonstrate.

---

## 2. Use case: pick one, and pick this one

### Candidates

**A. Tamper-evident moderation log for the school forum** ⭐ recommended
Stakeholder: the students who use it, the teacher who moderates it.
The real pain: *"my post got deleted and I can't prove it existed"* and *"did a mod edit what I said?"*.
The chain gives: provable history, attributable moderation, no silent edits — while still allowing the school to hide content.

**B. Anonymous welfare / peer-support board**
Same artefact, higher emotional stakes, but drags in safeguarding policy and duty-of-care obligations that an EPQ cannot discharge. Keep as a *configuration* of A, not as the pitched case.

**C. Coursework submission receipt log**
Hash every submission, teacher countersigns, prove nothing was backdated. Genuinely useful, tiny, and less interesting to demo. Loses the forum you already built.

**D. Student union election bulletin board**
Blind signatures + verifiable anonymity + coercion resistance. Genuinely hard research-grade crypto. Do not attempt in 30 hours.

### Recommended: A, phrased as "provable moderation"

Three reasons it's the right artefact:

1. **It needs the chain.** Without signatures and chaining there is no way to tell "moderator hid this" from "this never existed". The blockchain is load-bearing, not bolted on — the exact thing examiners probe for.
2. **It has a live adversary with legitimate power.** The moderator is not the enemy; they need to be *able* to hide content and *unable* to do it invisibly. That's a real design tension with a real resolution.
3. **It is testable.** You can demo tampering: change one character in the DB, reload, the page turns red and points at `seq 47`. A demo that fails on purpose is worth more than a feature list.

Narrow further for the artefact: **one board, one moderator key, posts and replies only.** No tags, no search, no profiles, no notifications. v1 had all of those and they are the reason it didn't ship.

---

## 3. Is "blockchain from scratch" possible for free?

Short answer: **the ledger primitives are free and genuinely from scratch. Real decentralisation is not, on one free account.** Separate the two, because they cost differently.

### Free, and you write it yourself

| Component | How | Cost |
|---|---|---|
| SHA-256 hashing | `crypto.subtle.digest` (WebCrypto, native, free) | £0 |
| Signatures | ECDSA P-256 via WebCrypto `sign`/`verify` | £0 |
| Hash chain + append/validate | ~120 lines of pure JS, no deps | £0 |
| Merkle tree + inclusion proofs | ~150 lines, RFC 6962 style (consistency proofs are a documented stretch, not needed for the pinned-head check) | £0 |
| Canonical block encoding | ~60 lines + test vectors | £0 |
| Single-writer ordering ("consensus" of one validator) | Durable Object, SQLite backend | £0 (free tier) |
| Storage | DO SQLite / D1 | £0 (5 GB, 100k writes/day) |
| Hosting + static assets | Workers Free | £0 (100k req/day) |
| Client-side verifier | Same module, runs in the browser | £0 |
| Anti-spam proof-of-work | ~80 lines + inline SHA-256 | £0 (costs the spammer CPU, not money) |
| Public anchoring | OpenTimestamps → real Bitcoin, without a node or an API key | £0 |

### Not free, or not honest to claim

| Thing | Why |
|---|---|
| A token / mining / PoW consensus with real security | Security comes from hashrate. Your chain has none, so anyone with a laptop out-mines it. Don't build consensus — build a single validator and say so. |
| Running a Bitcoin node | ~700 GB disk + bandwidth. Not free, not feasible here. |
| Outbound email on Cloudflare Free | **Email Sending requires Workers Paid.** Inbound routing is unlimited and free; sends to *verified destination addresses* in your account are free on all plans. Everything else needs a third party. |
| A custom domain | workers.dev subdomain is free; a `.co.uk` is ~£8/year. Optional. |
| Multiple independent operators | Technically free (a second free account elsewhere), socially not — you can't make other people run nodes. |

### Where the free tier actually bites

Free Workers get **10 ms CPU per request** and DOs get **100k requests/day**. These aren't incidental — they are the reason the architecture below looks the way it does:

- You **cannot** re-verify a 50,000-block chain inside one request. (50k blocks ≈ 50k signature verifies × ~0.2 ms = 10 seconds.)
- Therefore verification must be **incremental and client-side**, with **Merkle proofs** to prove individual blocks without the whole chain.
- Therefore the client keeps a copy of what it last verified, and a signed tree head.

That's the right design anyway. The limit just removes the option of doing it wrong. Say so in the evaluation — "platform constraints forced the correct architecture" is a strong finding.

### Free-tier budget for the chosen case

Assume 150 students, 30 blocks/day, 1,000 page views/day:

| Meter | Free limit | Estimated use | Headroom |
|---|---|---|---|
| Worker requests | 100,000/day | ~5,000 | 5% |
| DO requests | 100,000/day | ~3,500 | 3.5% |
| DO duration | 13,000 GB-s/day | ~0 (hibernate) | — |
| Rows written | 100,000/day | ~250 | 0.25% |
| Rows read | 5,000,000/day | ~50,000 | 1% |
| Storage | 5 GB | 0.004 GB/year of blocks | huge |
| Cron triggers | 5/account | 1 (hourly checkpoint) | — |
| **Cost** | | | **£0.00** |

Even fully un-hibernated, one DO can be active ~28 hours/day inside the duration allowance (13,000 GB-s ÷ 0.128 GB ≈ 101,500 s). Live updates are affordable; they're just not necessary.

### The one thing that costs money, and how to avoid it

Email auth. Options, in order of preference:

1. **Don't put email on the critical path.** Identity is a keypair, not an address. Cost: £0, and it's *better* security. Email becomes an optional "verified handle" badge.
2. **Resend / Brevo free tier** (~3,000/month / 300/day) — only used for magic links, well inside free.
3. **Cloudflare verified destination addresses** — free on all plans but requires the admin to add each address in the dashboard (200-address limit per account). Fine for a 30-person pilot, useless at scale.
4. Workers Paid, £4/month. Don't.

Recommendation: (1) as the design, (2) as the implementation if you want email at all.

---

## 4. What "blockchain" means here, precisely

You are building a **verifiable append-only log with signed entries** — the same family as Certificate Transparency, Sigsum, Trillian, and git's object graph. Not a coin. That's not a downgrade; it's the part of blockchain that turns out to be useful when you don't need money.

### Block

```jsonc
{
  "v": 1,
  "board": "general",
  "seq": 47,                    // assigned by the single writer
  "prev": "b3f1…",              // SHA-256 of block 46's canonical bytes
  "type": "post",               // post | reply | mod.hide | mod.restore | key.claim | rules | checkpoint
  "author": "9c2e…",            // public key fingerprint (base64url)
  "ts": 1778539200000,          // author-claimed, advisory only
  "payload": { "body": "…" },
  "sig": "MEUCIQ…"              // ECDSA over canonical(block without sig)
}
```

Deliberate choices, each with a reason you can defend:

- **Bodies live in the block.** The log *is* the database; SQLite is only an index and can be rebuilt by replaying. This makes export one file and verification one loop. Cap bodies at 4 KB.
- **`seq` and `prev` are server-assigned, everything else is author-signed.** The server provides ordering; it cannot forge authorship. Being explicit about which field is trusted by whom is the whole security model in one sentence.
- **`ts` is advisory.** Never sort or validate by it. A client clock claim is not evidence.
- **Canonical encoding is a spec with test vectors**, not "whatever `JSON.stringify` does". Key order, `-0`, `1.0` vs `1`, unicode normalisation and lone surrogates will bite you, and "I wrote a canonicalisation spec and a cross-runtime test suite for it" is a genuinely strong thing to write up.

### Checkpoint (the tree head)

Every N blocks (or hourly via cron), the writer emits a `checkpoint` block:

```jsonc
{ "type": "checkpoint", "seq": 481, "payload": { "size": 481, "root": "7d1a…" } }
```

`size` equals `seq`: a checkpoint at position `n` covers blocks `0..n-1`, because
a block cannot commit to its own hash. The checkpoint's own hash is covered by
the next checkpoint.

This is what clients pin, what mirrors compare, and what gets anchored. Without a head, Merkle proofs prove nothing.

### Client verification loop (the important one)

```
on load:
  head := GET /head            # latest signed checkpoint
  pin  := localStorage[board]  # {seq, root} from last visit

  if head.seq <  pin.seq  → ROLLBACK DETECTED   (history was truncated)
  if head.seq == pin.seq and head.root != pin.root → FORK DETECTED
  else fetch blocks (pin.seq, head.seq] and:
      verify each sig against author key
      verify each prev == sha256(previous canonical block)
      recompute Merkle root, compare to head.root
  then pin := head
```

Show this state in the UI as a single line: `✓ 481 blocks verified · head 7d1a…` with a "verify yourself" button that does it in the browser. That line, and the red version of it, is your demo.

### Moderation

A moderator never deletes anything. They emit `mod.hide` referencing a block hash, signed with the mod key. Clients render the original as a tombstone: *"hidden by moderator — content still verifiable"*. The post stays in the chain forever.

This is the resolution to the design tension: the school keeps its safeguarding power, loses its ability to deny. That is a defensible position to actually ship inside a school, which is what makes the case *useful* rather than theoretical.

### "Smart contracts", honestly

On a chain with one validator, a smart contract has no trust benefit — the operator runs the code either way. What survives is **validation rules as data**: a `rules` block declaring which block types each key may emit, versioned and recorded in the chain. Then a violation is *provable* afterwards, even though it wasn't *prevented*.

Write that paragraph. It shows you understand why smart contracts exist, which is more than most EPQ artefacts manage. Don't build a VM.

---

## 5. Architecture (single Worker, free plan)

```
                    ┌──────────────────────────────────────────┐
  browser ────────► │  Worker  (workers.dev, free)             │
   static SPA       │  ├─ GET  /                → static assets │
   + verifier.js    │  ├─ GET  /api/head        → checkpoint    │
                    │  ├─ GET  /api/blocks?from=n               │
                    │  ├─ GET  /api/proof?seq=n → Merkle proof  │
                    │  ├─ POST /api/blocks      → submit (+PoW) │
                    │  └─ POST /api/auth/*      → magic link    │
                    │            │                              │
                    │            ▼                              │
                    │  ┌─────────────────────┐  ┌────────────┐  │
                    │  │ Board DO (SQLite)   │  │ D1         │  │
                    │  │ single writer:      │  │ users,     │  │
                    │  │ seq, prev, root     │  │ sessions,  │  │
                    │  │ raw blocks, index   │  │ magic links│  │
                    │  └─────────────────────┘  └────────────┘  │
                    └──────────────────────────────────────────┘
                                  │ cron: hourly
                                  ▼
                        anchor digest → OpenTimestamps
                                      (free, real Bitcoin)
```

Why a DO and not D1 for the ledger: you need **serialised** appends. Two concurrent posts must not both claim `seq 47`. A DO is a single-threaded actor with transactional SQLite — that is the "consensus" (one validator, total order). D1 for users/sessions because there's no ordering requirement there.

### Module layout — the ledger is a pure library

```
nhforum-v2/
  worker/
    src/index.ts            Hono router, ~150 lines
    src/board.ts            Durable Object: append(), head(), proof()
    src/auth.ts             sessions, magic links
  ledger/                   ← no I/O, no imports, same code everywhere
    canon.js                canonical JSON encode
    block.js                block shape, payload rules, hashing
    hash.js                 sha256 hex helpers
    merkle.js               tree, inclusion proof
    chain.js                verifyChain(), verifyAppend(), compareHeads()
    sign.js                 P-256 keygen / sign / verify (WebCrypto)
  web/
    index.html              one page
    app.js                  fetch + render
    verifier.js             imports the same ledger logic (bundled)
  spec/
    LEDGER-v1.md            the wire format, normative
    TEST-VECTORS.json       shared fixtures
  test/
    canon.test.js           encoding edge cases
    primitives.test.js      base64url, sha256, hex
    sign.test.js            signatures, encrypted backup
    block.test.js           shape and payload rules
    merkle.test.js          roots, proofs, tamper cases
    chain.test.js           tamper, authority, append gate, rollback
    vectors.test.js         the cross-runtime canary
  scripts/
    demo.mjs                build, verify, attack
    gen-vectors.mjs         regenerate fixtures
  wrangler.jsonc
```

The `src/ledger/` rule is the single most important structural decision: **it must import nothing**. If it imports nothing, it runs in the Worker, in the browser, and in Node under vitest, and the same test vectors prove all three agree. That is what makes "verified in your browser" a real claim rather than a slogan. It's also the easiest thing to demonstrate in a viva.

### Identity and auth (no passwords)

- On first visit, generate a **P-256 keypair**; store the private key as a **non-extractable** `CryptoKey` in IndexedDB. It cannot be read by JS, including an XSS payload.
- Posting = signing. The server stores and verifies the public key. It cannot sign as you.
- Export/recovery = encrypt the JWK with AES-GCM under a passphrase-derived key (PBKDF2, 600k iterations). That string is your account. Show it once, tell people to keep it.
- **No passwords exist**, so there is nothing to hash, phish, leak or reuse. This deletes the entire class of bugs in v1.
- Optional email → magic link (HMAC token, single use, 10 min TTL) → grants a "verified handle" badge. Email never gates reading or posting.
- Session cookie: `__Host-nhf`, `HttpOnly`, `Secure`, `SameSite=Lax`, random 128-bit ID, hashed at rest in D1.
- Anti-spam: per-key token bucket in the DO **plus** ~18–20 bits of proof-of-work in the browser (~0.5–1 s). PoW here is a rate limiter, not consensus — the honest use of the technique, and it costs the spammer CPU instead of you money.

### Security debt from v1, explicitly closed

| v1 | v2 |
|---|---|
| `WHERE username = "${req.body.value}"` | Prepared statements only (`db.prepare(...).bind(...)`) |
| `SHA256(password)` compared in browser JS | No passwords |
| `document.cookie = "logged = username"` | Signed, HttpOnly, `__Host-` session |
| `if(prevhash==prevhash){log}else{log}` then append anyway | Invalid block is rejected with a reason |
| Chain class in client, unrelated logic on server | One pure module, three runtimes, shared vectors |
| `GET /login` tells you whether a user exists | Uniform response, rate limited |
| socket.io (needs a long-lived process) | `GET /api/head` polling; optional SSE later |

---

## 6. Anchoring without a blockchain API

Three free routes, in order of strength:

1. **OpenTimestamps** — POST the checkpoint digest to a public calendar; you get a receipt that later upgrades to a Bitcoin attestation. Free, no wallet, no node, no API key. This *is* Bitcoin anchoring, and it's the strongest evidence you can get for £0. Verify offline with the `ots` CLI during the presentation.
2. **Public git commit** — hourly cron commits `{seq, root}` to a public repo. Cheap, permanent, verifiable. Honest caveat: it makes GitHub a trust anchor.
3. **Mirror head comparison** — a static snapshot of the chain on GitHub Pages. The client fetches both heads; disagreement is displayed. Free, and it demonstrates the gossip problem you can't fully solve.

Do 1 and 3. Write up 2 as the fallback.

Open question worth a paragraph in the essay: **anchoring proves the log existed at time T, but only if someone checks the anchor.** A chain nobody watches is still a chain nobody can lie to you about — but only if you kept a copy. That's the honest limit of the whole thing, and stating it is worth more than pretending otherwise.

---

## 7. Scope tiers

### MVP — ship this (≈22 h)

- [ ] `spec/LEDGER-v1.md` + test vectors
- [ ] `ledger/` module: canon, codec, chain, merkle (root only), P-256 sign
- [ ] Board DO: `append`, `head`, `blocks?from=n`, reject invalid
- [ ] Post / reply as signed blocks
- [ ] Client verifier page: full incremental verify, green ✓ / red ✗
- [ ] `mod.hide` + `mod.restore` tombstones
- [ ] Checkpoint + pinned head + rollback/fork detection
- [ ] Keypair identity, export/import, optional verified handle
- [ ] Tamper test suite (mutate each field → assert detection)
- [ ] Deployed to `<name>.workers.dev`

That's a complete, demonstrable, defensible artefact. Everything below is bonus.

### Stretch (≈10 h, in this order)

- [ ] Merkle inclusion proofs + `GET /api/proof?seq=`
- [ ] Proof-of-work anti-spam
- [ ] Hourly cron → OpenTimestamps anchor + "anchored at block 480, verified" badge
- [ ] Static mirror on GitHub Pages + head comparison
- [ ] Moderator key rotation via `rules` block
- [ ] Replay-rebuild: drop the index, rebuild from the log, assert identical head

### Explicitly out of scope (write these down and defend them)

- Tokens, mining, consensus, P2P node network, wallets
- Smart contract VM
- Multiple boards, tags, search, profiles, DMs, avatars, notifications
- Email as a requirement to read or post
- Real-time push (polling is enough; say why)
- Mobile app

Every item here is a thing you could be asked about in a viva, and "I cut it, here's the cost/benefit" is a better answer than a half-working feature.

---

## 8. Build order (each step ends in something demoable)

| # | Step | Done when | h |
|---|---|---|---|
| 1 | Spec + test vectors | Fixtures agreed before code | 4 |
| 2 | `ledger/` + vitest | Tamper tests pass in Node | 6 |
| 3 | Worker + DO + deploy | `GET /api/head` on workers.dev | 4 |
| 4 | Web UI read path | Verified chain rendered in browser | 5 |
| 5 | Post/reply write path | Signed post appears, second client verifies it | 4 |
| 6 | Moderation tombstones | Hidden post still verifiable | 3 |
| 7 | Head pinning | Rollback/fork demo goes red | 3 |
| 8 | Identity + export | Second device restores the same key | 3 |
| 9 | Anchor + mirror | ots receipt shown | 4 |

Steps 1–2 are the project. Steps 3–7 are the delivery of it. Do not start at 4 — v1 started at 4 and that's why the chain was fake.

---

## 9. EPQ framing

What each product decision gives you in the write-up:

| Artefact | Write-up chapter |
|---|---|
| Narrowing "decentralised" → "verifiable" | Analysis: why the original aim was unachievable and what survived |
| Threat model table (§1) | Analysis: the part most projects skip |
| Canonical encoding + vectors | Development: precision, cross-runtime testing |
| Free-tier CPU forcing incremental verification | Evaluation: constraint-driven design |
| Moderation tension (hide vs. deny) | Evaluation: stakeholder conflict, with a real resolution |
| Anchoring's "who checks the anchor" limit | Evaluation: honest limits, strongest paragraph you'll write |
| Tamper test suite | Evidence: demonstrates rather than asserts |
| Scope cut list (§7) | Evaluation: project management, trade-offs |

The one-sentence research question to put on the title page:

> *Can an append-only, cryptographically signed log make a school forum's moderation provably transparent, at zero hosting cost, using no third-party blockchain services?*

Answer: yes for transparency and cost; no for independence from the operator, and the essay should say so plainly.

---

## 10. Practical setup notes

- Node 26 and `gh` are installed per-user but **not on PATH** in a fresh shell. Fix without admin:
  ```powershell
  [Environment]::SetEnvironmentVariable('Path',
    "$env:LOCALAPPDATA\Programs\nodejs;$env:LOCALAPPDATA\Programs\gh\bin;" +
    [Environment]::GetEnvironmentVariable('Path','User'), 'User')
  ```
- Wrangler is already authenticated (`Shalev`, `workers:write`, `d1:write`). Use `npx wrangler@latest` — no global install needed, no admin.
- `workers.dev` subdomain: set once in the dashboard; first deploy will prompt if unset.
- Keep the v1 repo intact and public as the "before" artefact. Build v2 in a **new repo**; do not port EJS, do not port the v1 chain class. Reuse the CSS if you like the look.
- Secrets never in the repo: `npx wrangler secret put SESSION_HMAC_KEY`.
- Free-plan landmine: `wrangler dev` runs locally for free; every `wrangler deploy` iteration is cheap but the 100k/day counter is per-account, not per-project.
