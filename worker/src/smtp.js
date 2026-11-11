/**
 * SMTP client over Cloudflare TCP sockets.
 *
 * Workers cannot run nodemailer (no persistent Node process, no TLS stack
 * exposed), but they can open a raw TLS socket, which is all SMTP needs.
 * This speaks the minimum subset Gmail requires: EHLO, AUTH LOGIN, MAIL, RCPT,
 * DATA. No pipelining, no STARTTLS upgrade — port 465 is implicit TLS.
 *
 * Note: Cloudflare does not allow outbound port 25. Ports 465/587 are fine.
 */

import { connect } from 'cloudflare:sockets'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function wrapBase64(text, width = 76) {
  const encoded = toBase64(text)
  const lines = []
  for (let i = 0; i < encoded.length; i += width) lines.push(encoded.slice(i, i + width))
  return lines.join('\r\n')
}

function messageId(from) {
  const random = crypto.getRandomValues(new Uint8Array(12))
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')
  return `<${hex}@${from.split('@')[1] ?? 'localhost'}>`
}

export class SmtpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
  }
}

/**
 * @param {{host:string, port:number, user:string, pass:string, from:string, to:string,
 *          subject:string, text:string, timeoutMs?:number}} options
 */
export async function sendMail(options) {
  const {
    host,
    port = 465,
    user,
    pass,
    from,
    to,
    subject,
    text,
    timeoutMs = 20_000,
  } = options

  if (!user || !pass) throw new SmtpError('SMTP credentials missing', 'EAUTH')

  const socket = connect({ hostname: host, port }, { secureTransport: 'on' })
  let buffer = ''
  let aborted = false

  const timer = setTimeout(() => {
    aborted = true
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }, timeoutMs)

  try {
    await socket.opened
    const reader = socket.readable.getReader()
    const writer = socket.writable.getWriter()

    const fill = async () => {
      const { value, done } = await reader.read()
      if (done) throw new SmtpError('connection closed by server', 'ECLOSED')
      if (aborted) throw new SmtpError('SMTP timeout', 'ETIMEDOUT')
      buffer += decoder.decode(value, { stream: true })
    }

    const readLine = async () => {
      while (!buffer.includes('\n')) await fill()
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      return line
    }

    // SMTP replies can be multi-line: "250-first" ... "250 last".
    const readReply = async () => {
      let last = ''
      for (;;) {
        const line = await readLine()
        if (/^\d{3}[ ]/.test(line)) return { code: Number(line.slice(0, 3)), text: line.slice(4), last }
        last = line
      }
    }

    const command = async (line, expected) => {
      await writer.write(encoder.encode(`${line}\r\n`))
      const reply = await readReply()
      if (expected && reply.code !== expected) {
        throw new SmtpError(`${line.split(' ')[0]} rejected: ${reply.code} ${reply.text}`, 'ESMTP')
      }
      return reply
    }

    const greeting = await readReply()
    if (greeting.code !== 220) throw new SmtpError(`bad greeting: ${greeting.code}`, 'ESMTP')

    await command(`EHLO ${host.includes('.') ? 'nhforum' : 'nhforum'}`, 250)
    await command('AUTH LOGIN', 334)
    await command(toBase64(user), 334)
    await command(toBase64(pass), 235)
    await command(`MAIL FROM:<${from}>`, 250)
    await command(`RCPT TO:<${to}>`, 250)
    await command('DATA', 354)

    const body = [
      `From: nhforum <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId(from)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(text),
    ].join('\r\n')

    await writer.write(encoder.encode(`${body}\r\n.\r\n`))
    const stored = await readReply()
    if (stored.code !== 250) throw new SmtpError(`message rejected: ${stored.code}`, 'ESMTP')

    await command('QUIT', 221).catch(() => {})

    try {
      await writer.close()
    } catch {
      /* server may already have closed */
    }
    return { ok: true }
  } finally {
    clearTimeout(timer)
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }
}
