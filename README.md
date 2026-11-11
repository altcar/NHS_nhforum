# nhforum

A forum whose history you can verify in your own browser. Two Workers, one ledger.

| | |
|---|---|
| **nhforum** | https://nhforum.hheylau.workers.dev — the board |
| **nhs-epqsocketio** | https://nhs-epqsocketio.hheylau.workers.dev — the live board |

The claim, and the only one worth making:

> Nobody — not even the person running it — can **silently** change or delete what was already posted.
> Content can still be hidden for safeguarding reasons, but the hiding is a signed, visible block.

This is a **verifiable** log, not an **uncensorable** one. One operator, one writer, no mining.
That distinction is the whole point; `SCOPE.md` explains why the original aim was unachievable and
what survived instead.

## Why two Workers

`nhforum` is the persistent board: posts, replies, moderation tombstones, optional email-linked
handles, a full history download.

`nhs-epqsocketio` is the real-time one: the same signed blocks streamed over a WebSocket, which is
what the old `socket.io` experiments were reaching for. **socket.io cannot run on Workers** — its
protocol needs a long-lived Node process and an HTTP long-poll fallback. A Durable Object with the
WebSocket Hibernation API does the same job, natively, at zero idle cost.

Both share `ledger/` and `shared/ledgerStore.js`. There is exactly one implementation of the chain.

## Layout

```
ledger/            pure ESM, imports nothing, runs in Worker + browser + Node
spec/              LEDGER-v1.md (normative) + TEST-VECTORS.json
shared/            LedgerStore: append, checkpoint, Merkle head, rate limiting
worker/src/        nhforum: router, Board DO, auth, SMTP-over-sockets
realtime/src/      nhs-epqsocketio: router, Room DO (WebSocket hibernation)
web/               nhforum UI + the browser verifier
realtime/web/      live board UI
test/              179 tests: encoding, signatures, Merkle, tamper, authority, rollback
scripts/           demo, vectors, asset copy, live smoke tests
```

## Run

```bash
npm install
npm test                                   # 179 tests
npm run demo                               # build a chain, then attack it
npm run dev                                # http://localhost:8787
npm run dev:realtime                       # http://localhost:8788
npm run smoke  -- https://nhforum.hheylau.workers.dev
npm run smoke:realtime -- https://nhs-epqsocketio.hheylau.workers.dev
```

## Deploy

```bash
npx wrangler d1 execute nhforum --remote --file worker/schema.sql   # once
npm run deploy            # nhforum
npm run deploy:realtime   # nhs-epqsocketio
```

Push-triggered builds run the same commands, with `node scripts/build-assets.mjs` as the build step.

## Optional email

Posting never needs an account. Identity is a P-256 key generated in the browser and stored
**non-extractable** in IndexedDB, so no script can read it back out. Email only attests that a human
can read an inbox, which is enough to claim a handle.

Outbound mail goes over `smtp.gmail.com:465` using a raw TLS socket (`cloudflare:sockets`) and a
Gmail App Password. Cloudflare's own outbound email is a paid feature; this stays free.

```bash
npx wrangler secret put GMAIL_USER          -c wrangler.nhforum.jsonc
npx wrangler secret put GMAIL_APP_PASSWORD  -c wrangler.nhforum.jsonc
```

Requires 2-Step Verification on the Google account, then an App Password from
<https://myaccount.google.com/apppasswords>. Without the secrets `/api/auth/request` returns 503 and
the board stays fully usable.

Note: Cloudflare blocks outbound port 25. 465/587 are fine.

## Moderation

Hides are blocks, never deletions. A `rules` block signed by the board's root key appoints
moderators; a moderator then signs `mod.hide` with **their own** key. Readers recompute the
moderator set from the log, so authority is derived rather than stored.

```bash
# 1. choose an admin token for appointing moderators (this is not a user password)
npx wrangler secret put ADMIN_TOKEN -c wrangler.nhforum.jsonc

# 2. copy your public key from the board: click the "anon-…" chip
# 3. appoint yourself (or someone else)
curl -X POST https://nhforum.hheylau.workers.dev/api/admin/rules \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"mods":["<base64url public key>"]}'
```

Reload the board: the hide control appears on every post. `scripts/moderation-demo.mjs` runs the
whole flow — generate a moderator key, appoint it, hide a post, verify the chain.


## What this does and does not give you

| Property | Status |
|---|---|
| Silent edit of history | detectable by any reader, in their own browser |
| Forged post by the operator | impossible without the author's key |
| Silent moderation | impossible: hiding is a signed, visible block |
| Deleted post | detectable: the chain skips a `seq` |
| Operator refuses to serve | **not detected** — availability is not provided |
| Split view | detectable only by comparing heads out of band |
| Censorship resistance, consensus, mining | **out of scope, by design** |

## Security notes

- Passwords do not exist, so there is nothing to hash, phish or leak.
- Session cookies are random 128-bit ids, hashed at rest, `HttpOnly`, `SameSite=Lax`.
- Every SQL statement is parameterised.
- Block bodies are capped at 4 KB; appends are rate limited per key in the Durable Object.
- The writer key (which signs checkpoints) lives in the board's Durable Object storage. It cannot
  forge user posts, because it is not any user's key.

## Licence

MIT
