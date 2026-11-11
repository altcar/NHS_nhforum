/**
 * nhforum Worker — routing only.
 *
 * Static assets are served from ./web (free, no Worker invocation).
 * Everything under /api is forwarded to the single Board Durable Object.
 */

import { route as authRoute } from './auth.js'

export { Board } from './board.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const boardStub = (env) => env.BOARD.get(env.BOARD.idFromName(env.BOARD_NAME || 'general'))

const forward = (env, path, init) => boardStub(env).fetch(`https://do${path}`, init)

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    // Auth and identity are D1-backed, not part of the immutable log.
    if (
      pathname.startsWith('/auth/') ||
      pathname.startsWith('/api/auth/') ||
      pathname === '/api/me' ||
      pathname === '/api/handles'
    ) {
      return authRoute(request, env, url)
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/head' && request.method === 'GET') {
        return forward(env, `/head${url.search}`)
      }

      if (pathname === '/api/next' && request.method === 'GET') {
        return forward(env, '/next')
      }

      if (pathname === '/api/blocks' && request.method === 'GET') {
        return forward(env, `/blocks${url.search}`)
      }

      if (pathname === '/api/proof' && request.method === 'GET') {
        return forward(env, `/proof${url.search}`)
      }

      if (pathname === '/api/blocks' && request.method === 'POST') {
        const body = await request.text()
        if (body.length > 32_000) return json({ error: 'block too large' }, 413)
        return forward(env, '/append', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      }

      return json({ error: 'not found' }, 404)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      boardStub(env)
        .fetch('https://do/checkpoint', { method: 'POST' })
        .catch(() => {}),
    )
  },
}
