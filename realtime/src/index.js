/**
 * nhs-epqsocketio — the live board.
 *
 * Same ledger, different transport: posts are signed in the browser, streamed
 * over a WebSocket to a single writer, and broadcast back to every listener.
 */

export { Room } from './room.js'

const room = (env) => env.ROOM.get(env.ROOM.idFromName(env.BOARD_NAME || 'socketio'))

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === '/ws') {
      const upgrade = request.headers.get('upgrade')
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      return room(env).fetch(request)
    }

    if (pathname === '/api/blocks') return room(env).fetch(`https://do/blocks${url.search}`)
    if (pathname === '/api/head') return room(env).fetch(`https://do/head${url.search}`)
    if (pathname === '/api/next') return room(env).fetch('https://do/next')

    return env.ASSETS.fetch(request)
  },
}
