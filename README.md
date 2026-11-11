# nhforum

**A forum whose history you can verify in your own browser.**

Every post is signed by the key that wrote it and chained to the one before. Anyone can download
the whole log and check it offline. If the person running the server edits or deletes something,
the check fails — and the failure is visible on the page, not buried in a database log.

- Live board — <https://nhforum.hheylau.workers.dev>
- Live socket board — <https://nhs-epqsocketio.hheylau.workers.dev>

---

## The problem

A school forum has an awkward trust problem, and it is not the one blockchain marketing talks about.

Students are asked to trust that:

- what they posted is what is still published;
- a deleted post existed at all;
- a moderator edited their words rather than hiding them;
- "the system" won't quietly rewrite the thread before an argument about it.

The people running the forum have a legitimate need to remove content — safeguarding, abuse, and
duty of care are real. So "the moderator can't delete anything" is not an acceptable design.

The usual answer is a database and a promise. A promise is not evidence.

**This is the narrow, achievable version of the idea:** keep the ability to hide content, remove the
ability to do it *silently*. Hiding becomes a signed, visible entry in an append-only log. The
original post stays in the chain forever, marked hidden.

> The claim: **nobody — not even the operator — can silently change or delete what was already
> posted.** This gives you a *verifiable* log, not an *uncensorable* one.

That distinction is the whole project. It is also why the 2023 version, which claimed to be
"decentralised" and "a blockchain", did not work: it was one Express server over one MySQL user,
and the "chain" was a field the server wrote and never re-checked.

---

## What changed since 2023

The 2023 work and the rebuild now live in one repository, so the "before" and the "after" can be
read side by side. The old code keeps its own history: the 14 commits from the EPQ are the root of
this branch, and the v2 work sits on top of them.

| Path / repo | What it is | Status |
|---|---|---|
| `server/`, `old_server_file/`, `writeup/` | The original EPQ artefact: Express + MySQL + EJS + socket.io, deployed to Render in 2023. | **Preserved unmodified** — the "before" evidence, still at its 2023 commits |
| `ledger/`, `worker/`, `web/` … | The rebuilt system, at the repository root. | **Live** — <https://nhforum.hheylau.workers.dev> |
| [`altcar/NHS_EPQsocketio`](https://github.com/altcar/NHS_EPQsocketio) | 2023 scratchpad: three unconnected socket.io / hash-chain sketches, none of which ran. Its working replacement is `realtime/`. | **Archived**, README explains why |

### What was actually wrong with v1

Not "it wasn't blockchain enough". These:

| v1 | Consequence |
|---|---|
| `WHERE username = "${req.body.value}"` | Trivial SQL injection |
| `SHA256(password)` computed **in the browser** and compared in JS | Authentication bypass with a console line |
| `document.cookie = "logged = <username>"` | Anyone can be anyone by editing a cookie |
| `if (prevhash == prevhash) { log("checked") } else { log("seems wrong") }` then **append anyway** | The "chain" never rejects anything, so it protects nothing |
| `class Block` / `class blockchain` in client JS, unused by the server | The chain is decorative |
| socket.io + a long-lived Node process + MySQL | Cannot be deployed serverless, which is why it needed a paid host |

The fix was not "add more blockchain". It was narrowing the claim to something true, and then
making the cryptography do real work: server-assigned ordering, **author-signed content**, and
**verification in the reader's browser**.

### Side by side

| | v1 (2023) | v2 (this repo) |
|---|---|---|
| Hosting | Express on Render | Cloudflare Workers, free tier |
| State | MySQL | Durable Object SQLite (the log), D1 (identities) |
| Real-time | socket.io | Native WebSockets on a Durable Object |
| Who signs a post | nobody | the author's browser key (P-256) |
| Can the server forge a post | yes | no, it never holds user keys |
| Can the server edit history | yes, undetectably | no, verification fails in the browser |
| Is the chain ever checked | no | on every page load, client-side |
| Auth | password + plaintext cookie | no passwords, non-extractable keys |
| Moderation | delete rows | signed `mod.hide` blocks, originals retained |
| Reproducible proof | none | 179 tests + published test vectors |

---

## The two apps (and why one repo)

The repository contains two Workers that share one ledger implementation. `nhforum` is the
product; `nhs-epqsocketio` exists because the 2023 prototype was trying to be live, and the honest
way to answer "does socket.io work on Workers?" is to build the thing it was for and show it.

| | **nhforum** | **nhs-epqsocketio** |
|---|---|---|
| Purpose | the persistent board | the live board |
| URL | `nhforum.hheylau.workers.dev` | `nhs-epqsocketio.hheylau.workers.dev` |
| Transport | HTTP (`/api/head`, `/api/blocks`) | WebSocket, with HTTP for history |
| Storage | Durable Object + D1 | Durable Object |
| Identity | optional email-verified handle | none, pseudonymous |
| Shows off | verification, moderation, the chain | fan-out, hibernation, ordering |

**socket.io cannot run on Workers.** Its protocol assumes a persistent Node process and falls back
to HTTP long-polling, neither of which exists in a Worker. A Durable Object with the WebSocket
Hibernation API does the job it was being used for — one authoritative process holding the live
connections — natively and at zero idle cost. The client uses a plain `WebSocket`.

Both apps import the same `ledger/` module and the same `shared/ledgerStore.js`. There is exactly
one implementation of "append a block and keep the Merkle head", so the two cannot drift apart.

---

## How to use it

### As a reader

Open the board. No account, no email, no wallet.

The line under the title is the result of a real check, run locally:

- `✓ 19 blocks verified` — every signature, every `prev` link, and the Merkle root recomputed and
  compared against the head the server served.
- `✗ chain broken at seq 47` — something was altered. The page still renders, which is the point.
- `✗ history is shorter than last visit` — the server rolled the log back.
- `✗ two different histories exist` — same length, different root. A fork.

**Download chain** saves the raw JSON. Verification needs no server:

```js
import { verifyChain } from './ledger/index.js'
const blocks = JSON.parse(await file.text())
console.log(await verifyChain(blocks))   // { ok, count, head, problems, root }
```

### As a poster

Type, press post. The browser generates a P-256 key on first visit and stores the private half
**non-extractable** in IndexedDB — no script, including an XSS payload, can read it back out. It
can only sign. Click the `anon-…` chip to copy your public key.

Your identity lives in that browser. Clearing site data loses the key, and with it the ability to
post as "you" — a deliberate trade for not having a password to steal.

### As a moderator

Moderators see a **hide** button on every post. Hiding asks for a reason and emits a signed
`mod.hide` block. The post becomes a tombstone:

> *hidden by a moderator — "off-topic". the block is still in the chain.*

A `mod.restore` block reverses it. Nothing is deleted; the chain is never rewritten. Because the
hide is signed by a key listed in the log, the action is attributable, and a hide by anyone else
fails verification for every reader.

### As the operator

See **Deploy** and **Moderation** below. The operator holds the writer key (it signs checkpoints)
and the admin token (it appoints moderators). Neither can forge a user's post or alter a past block
without breaking every reader's verification.

---

## How it works

```
browser  ──signed block──►  Worker  ──►  Board Durable Object  ──►  SQLite (the log)
   │                                      single writer, total order
   │                                      signs checkpoints
   └──◄── /api/blocks ────────────────────┘
        verifies locally: signatures, prev links, Merkle root vs head
```

A block:

```jsonc
{
  "v": 1,
  "board": "general",
  "seq": 47,             // assigned by the writer
  "prev": "b3f1…",       // SHA-256 of block 46
  "type": "post",        // post | reply | mod.hide | mod.restore | rules | checkpoint | genesis
  "author": "BAAx…",     // the author's public key, carried in the block
  "ts": 1778539200000,   // advisory only; never used for ordering
  "payload": { "body": "…" },
  "sig": "MEUCIQ…"       // ECDSA-P256-SHA256 over canonical(block minus sig)
}
```

Three decisions carry the security:

1. **The signature is excluded from the hash.** ECDSA is randomised; hashing the signature would
   make `prev` links unstable and give identical content two identities.
2. **The server assigns `seq` and `prev`; the author signs everything else.** The writer can order
   and withhold. It cannot speak as anyone.
3. **Canonical JSON, specified with test vectors.** Key order, `-0`, floats and lone surrogates are
   rejected rather than guessed at, because two implementations that disagree by one byte break
   every hash.

Checkpoints (`{ size, root }`) are what readers pin between visits, what mirrors compare, and what
would be anchored externally (OpenTimestamps) in the next step. `size` equals `seq`: a block cannot
commit to its own hash.

Full wire format: [`spec/LEDGER-v1.md`](spec/LEDGER-v1.md).

---

## What it does and does not give you

| Property | Status |
|---|---|
| Silent edit of history | detectable by any reader, in their own browser |
| Forged post by the operator | impossible without the author's key |
| Silent moderation | impossible: hiding is a signed, visible block |
| Deleted post | detectable: the chain skips a `seq` |
| Operator refuses to serve | **not detected** — availability is not provided |
| Split view served to different readers | detectable only by comparing heads out of band |
| Censorship resistance, consensus, mining | **out of scope, by design** |

One operator, one writer, no mining. Security here comes from signatures and evidence, not from
hashrate. Calling this a blockchain is defensible only in the Certificate-Transparency sense: a
verifiable append-only log. Saying so plainly is worth more than overclaiming.

---

## Run it

```bash
npm install
npm test            # 179 tests
npm run demo        # build a signed chain, then attack it three ways
npm run dev         # http://localhost:8787
npm run dev:realtime
```

```
   seq  type          author        hash
   0    genesis       DBN2kq…   8665474d5f0f…
   1    post          lVPP2h…   782556b309ab…
   2    reply         lVPP2h…   f568cdad95a2…
   3    rules         DBN2kq…   478f0dfbabc9…
   4    mod.hide      OfsV-z…   58765d51bd2d…
   5    post          lVPP2h…   58537fdf6376…

✓ verified 6 blocks · head seq 5 · root 123c0c3b437f…

✗ rejected — 2 problems
   seq 1   sig    signature does not verify for this author
   seq 2   prev   prev does not match hash of seq 1
```

## Deploy

```bash
npx wrangler d1 execute nhforum --remote --file worker/schema.sql   # once
npm run deploy            # nhforum
npm run deploy:realtime   # nhs-epqsocketio
```

Both Workers are connected to this repository on `main`, so a push builds and deploys. The build
step is `npm ci && node scripts/build-assets.mjs` (the browser needs the same ledger sources the
Worker uses, so they are copied rather than bundled).

Free tier is enough: 100k requests/day, 100k Durable Object requests/day, 5 GB storage. The board
uses a few percent of that at school scale, and checkpoints are extended at most once a minute so
page loads do not write to the log.

## Email (optional)

Posting never needs an account. Email only proves a human can read an inbox, which is enough to
claim a handle — no password is created.

```bash
npx wrangler secret put GMAIL_USER          -c wrangler.nhforum.jsonc
npx wrangler secret put GMAIL_APP_PASSWORD  -c wrangler.nhforum.jsonc
```

A Gmail App Password (2-Step Verification required) sent over `smtp.gmail.com:465` using a raw TLS
socket. Cloudflare's own outbound email is a paid feature; this stays free. Without the secrets,
`/api/auth/request` returns 503 and everything else works.

## Moderation

```bash
npx wrangler secret put ADMIN_TOKEN -c wrangler.nhforum.jsonc

curl -X POST https://nhforum.hheylau.workers.dev/api/admin/rules \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"mods":["<your public key, from the anon-… chip>"]}'
```

Reload, and the hide control appears. `scripts/moderation-demo.mjs` runs the whole flow against a
live board: appoint a key, hide a post, verify the chain.

---

## Repository layout

```
ledger/          pure ESM: canon, hashing, P-256, Merkle, chain, verification
spec/            LEDGER-v1.md (normative) + TEST-VECTORS.json
shared/          LedgerStore — append, checkpoints, Merkle head, rate limiting
worker/src/      nhforum: router, Board DO, auth, SMTP over sockets
realtime/src/    nhs-epqsocketio: router, Room DO (WebSocket hibernation)
web/             board UI + in-browser verifier
realtime/web/    live board UI
test/            encoding, signatures, Merkle, tamper, authority, rollback
scripts/         demo, vectors, asset copy, live smoke tests, moderation demo
```

## Security notes

- Passwords do not exist. Nothing to hash, phish or leak.
- Session cookies are random 128-bit ids, hashed at rest, `HttpOnly`, `SameSite=Lax`.
- Every SQL statement is parameterised; block bodies are capped at 4 KB.
- Appends are rate limited per key inside the Durable Object.
- The writer key lives in Durable Object storage and signs checkpoints only.
- `ledger/` contains no `fetch`, no storage, no Node built-ins — it is the only thing both the
  server and the reader have to trust, so it is kept small enough to read in one sitting.

## Licence

MIT
