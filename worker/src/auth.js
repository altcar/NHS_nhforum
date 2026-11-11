/**
 * Optional email identity.
 *
 * Posting never needs an account: identity is the browser key. Email only
 * attests "this key belongs to someone who can read this inbox", which gives a
 * verified handle. That keeps the free tier viable (Cloudflare's own outbound
 * email is a paid feature) and removes passwords entirely.
 *
 * The link binds email -> author at *request* time, using a signature from the
 * key being claimed, so a forwarded link cannot steal someone else's identity.
 */

import { b64uEncode, canonBytes, isAuthor, sha256Hex, verifyBytes } from '../../ledger/index.js'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/
const RESERVED = new Set(['admin', 'mod', 'moderator', 'system', 'root', 'nhforum', 'staff'])

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAGIC_TTL_MS = 15 * 60 * 1000
const MAX_MAGIC_PER_HOUR = 5

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

const page = (title, message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;
      font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 main{max-width:34rem;padding:2rem}
 h1{font-size:1.25rem;margin:0 0 .75rem}
 p{color:#9aa4b2;margin:0 0 1.25rem}
 a{color:#7dd3fc}
</style></head><body><main><h1>${title}</h1><p>${message}</p><a href="/">Back to the board</a></main></body></html>`

function cookieName(url) {
  return url.protocol === 'https:' ? '__Host-nhf' : 'nhf_session'
}

function readCookie(request, name) {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

export async function sessionUser(env, request, url) {
  const sessionId = readCookie(request, cookieName(url))
  if (!sessionId) return null
  const idHash = await sha256Hex(sessionId)
  const row = await env.DB.prepare(
    `SELECT u.author, u.handle, u.email, s.expires_at
       FROM sessions s JOIN users u ON u.author = s.author
      WHERE s.id_hash = ?`,
  )
    .bind(idHash)
    .first()
  if (!row) return null
  if (row.expires_at < Date.now()) return null
  return { author: row.author, handle: row.handle, email: row.email }
}

export async function route(request, env, url) {
  const { pathname } = url

  if (pathname === '/api/me') {
    const user = await sessionUser(env, request, url)
    return json({ user, mail: Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD) })
  }

  if (pathname === '/api/handles') {
    const { results } = await env.DB.prepare('SELECT author, handle FROM users').all()
    return json(
      { handles: (results ?? []).map((row) => ({ author: row.author, handle: row.handle })) },
      200,
    )
  }

  if (pathname === '/api/auth/request' && request.method === 'POST') {
    return requestMagicLink(request, env, url)
  }

  if (pathname === '/auth/callback' && request.method === 'GET') {
    return callback(request, env, url)
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const sessionId = readCookie(request, cookieName(url))
    if (sessionId) {
      await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?')
        .bind(await sha256Hex(sessionId))
        .run()
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `${cookieName(url)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      },
    })
  }

  return json({ error: 'not found' }, 404)
}

async function requestMagicLink(request, env, url) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    return json(
      {
        error: 'email is not configured',
        hint: 'set GMAIL_USER and GMAIL_APP_PASSWORD with wrangler secret put; posting works without an account',
      },
      503,
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }

  const email = String(body.email ?? '').trim().toLowerCase()
  const handle = String(body.handle ?? '').trim().toLowerCase()
  const author = String(body.author ?? '')
  const proof = String(body.proof ?? '')

  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'invalid email' }, 400)
  if (!HANDLE_RE.test(handle)) {
    return json({ error: 'handle must be 2-24 characters: a-z, 0-9, _ or -' }, 400)
  }
  if (RESERVED.has(handle)) return json({ error: 'that handle is reserved' }, 409)
  if (!isAuthor(author)) return json({ error: 'invalid author key' }, 400)
  if (!(await verifyBytes(author, canonBytes({ claim: email, handle }), proof))) {
    return json({ error: 'proof does not verify for that author key' }, 400)
  }

  const now = Date.now()
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM magic WHERE email = ? AND created_at > ?',
  )
    .bind(email, now - 60 * 60 * 1000)
    .first()
  if ((recent?.n ?? 0) >= MAX_MAGIC_PER_HOUR) {
    return json({ error: 'too many links requested; try again later' }, 429)
  }

  const holder = await env.DB.prepare('SELECT author FROM users WHERE handle = ?').bind(handle).first()
  if (holder && holder.author !== author) return json({ error: 'that handle is taken' }, 409)

  const token = b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(token)

  await env.DB.prepare(
    `INSERT INTO magic (token_hash, email, handle, author, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(tokenHash, email, handle, author, now, now + MAGIC_TTL_MS)
    .run()

  const origin = env.PUBLIC_ORIGIN || url.origin
  const link = `${origin}/auth/callback?t=${encodeURIComponent(token)}`

  try {
    const { sendMail } = await import('./smtp.js')
    await sendMail({
      host: 'smtp.gmail.com',
      port: 465,
      user: env.GMAIL_USER,
      pass: env.GMAIL_APP_PASSWORD,
      from: env.GMAIL_USER,
      to: email,
      subject: 'your nhforum sign-in link',
      text: [
        'Open this link within 15 minutes to verify your handle on nhforum.',
        '',
        link,
        '',
        'If you did not ask for this, ignore the message. The link only proves',
        'you can read this inbox; it cannot post on your behalf.',
      ].join('\n'),
    })
  } catch (err) {
    await env.DB.prepare('DELETE FROM magic WHERE token_hash = ?').bind(tokenHash).run()
    return json({ error: 'could not send the email', detail: String(err?.message ?? err) }, 502)
  }

  return json({ ok: true, message: 'check your inbox' })
}

async function callback(request, env, url) {
  const token = url.searchParams.get('t')
  if (!token) return html(page('Missing link token', 'That link is incomplete.'), 400)

  const tokenHash = await sha256Hex(token)
  const row = await env.DB.prepare('SELECT * FROM magic WHERE token_hash = ?').bind(tokenHash).first()
  const now = Date.now()

  if (!row) return html(page('Unknown link', 'This link was never issued, or has already been used.'), 400)
  if (row.used_at) return html(page('Link already used', 'Request a new one from the board.'), 400)
  if (row.expires_at < now) return html(page('Link expired', 'Links are valid for 15 minutes.'), 400)

  await env.DB.prepare('UPDATE magic SET used_at = ? WHERE token_hash = ?').bind(now, tokenHash).run()

  try {
    await env.DB.prepare(
      `INSERT INTO users (author, handle, email, created_at, verified_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(author) DO UPDATE SET
         handle = excluded.handle,
         email = excluded.email,
         verified_at = excluded.verified_at`,
    )
      .bind(row.author, row.handle, row.email, now, now)
      .run()
  } catch (err) {
    const message = String(err?.message ?? err)
    if (message.includes('UNIQUE')) {
      return html(
        page('That handle or email is already linked', 'Pick a different handle and try again.'),
        409,
      )
    }
    return html(page('Could not save the account', 'Something went wrong on our side.'), 500)
  }

  const sessionId = b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.prepare(
    'INSERT INTO sessions (id_hash, author, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(sessionId), row.author, now, now + SESSION_TTL_MS)
    .run()

  const secure = url.protocol === 'https:' ? ' Secure;' : ''
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': `${cookieName(url)}=${sessionId}; Path=/; Max-Age=${Math.floor(
        SESSION_TTL_MS / 1000,
      )}; HttpOnly;${secure} SameSite=Lax`,
      'cache-control': 'no-store',
    },
  })
}
