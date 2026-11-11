/**
 * The browser must run the *same* ledger module as the Worker, or "verify it
 * yourself" is theatre. Rather than bundling, copy the sources into each
 * static directory: they are already dependency-free ESM, so the browser can
 * import them directly.
 *
 * Usage: node scripts/build-assets.mjs
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = join(root, 'ledger')

const targets = [join(root, 'web', 'ledger'), join(root, 'realtime', 'web', 'ledger')]

const files = (await readdir(source)).filter((name) => name.endsWith('.js'))

for (const target of targets) {
  await mkdir(target, { recursive: true })
  for (const file of files) {
    await copyFile(join(source, file), join(target, file))
  }
  console.log(`copied ${files.length} ledger modules → ${target}`)
}

/**
 * Inside Workers Builds, also deploy the realtime Worker.
 *
 * A repository has one default wrangler config, so the connected build can only
 * ever deploy one Worker by itself. This runs the second deploy from the same
 * build. It is deliberately non-fatal: if the environment has no credentials
 * for the second Worker, the main deploy must still succeed.
 */
if (process.env.WORKERS_CI === '1' || process.env.CI === 'true') {
  const { spawnSync } = await import('node:child_process')
  console.log('CI build detected — deploying the realtime Worker as well')
  const result = spawnSync('npx', ['wrangler', 'deploy', '-c', 'wrangler.realtime.jsonc'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  console.log(`realtime deploy exit code: ${result.status ?? 'unknown'}`)
}
