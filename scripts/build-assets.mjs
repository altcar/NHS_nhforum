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
