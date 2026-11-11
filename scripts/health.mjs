/**
 * Read-only health check for a deployed board.
 *
 * Asserts the things a broken deploy actually breaks: the API answering, and
 * the browser verifier being present. It writes nothing, so it is safe to run
 * on every push (unlike smoke.mjs, which appends blocks).
 *
 * Usage: node scripts/health.mjs
 */

const targets = [
  { name: 'nhforum', base: 'https://nhforum.hheylau.workers.dev', api: '/api/head' },
  { name: 'nhs-epqsocketio', base: 'https://nhs-epqsocketio.hheylau.workers.dev', api: '/api/head' },
]

let failed = false

for (const target of targets) {
  const checks = [
    { path: target.api, expect: 200, json: true },
    { path: '/ledger/index.js', expect: 200 },
    { path: '/', expect: 200 },
  ]

  for (const check of checks) {
    let status = 0
    let note = ''
    try {
      const response = await fetch(target.base + check.path)
      status = response.status
      if (check.json && status === 200) {
        const body = await response.json()
        const hasHead = 'seq' in body || 'error' in body
        note = hasHead ? '' : ' (unexpected body)'
        if (!hasHead) status = 0
      }
    } catch (err) {
      note = ` (${err.message})`
    }

    const ok = status === check.expect
    if (!ok) failed = true
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${target.name.padEnd(17)} ${check.path} → ${status}${note}`)
  }
}

if (failed) {
  console.error('\nA deployment is not serving the API or the verifier.')
  process.exit(1)
}
console.log('\nBoth deployments are healthy.')
