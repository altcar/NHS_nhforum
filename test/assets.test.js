import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = join(root, 'ledger')
const copies = [join(root, 'web', 'ledger'), join(root, 'realtime', 'web', 'ledger')]

/**
 * The browser must run the same code as the Worker, and a push-triggered deploy
 * uploads the repository without running a build step. So the copies are
 * committed, and this test is the thing that stops them drifting.
 *
 * Fix a failure with: node scripts/build-assets.mjs
 */
describe('browser copies of the ledger', () => {
  it('exist in every static directory', async () => {
    const files = (await readdir(source)).filter((name) => name.endsWith('.js'))
    expect(files.length).toBeGreaterThan(0)

    for (const dir of copies) {
      const present = (await readdir(dir)).filter((name) => name.endsWith('.js')).sort()
      expect(present, `${dir} is missing modules`).toEqual([...files].sort())
    }
  })

  it('are byte-identical to ledger/', async () => {
    const files = (await readdir(source)).filter((name) => name.endsWith('.js'))
    for (const dir of copies) {
      for (const file of files) {
        const expected = await readFile(join(source, file), 'utf8')
        const actual = await readFile(join(dir, file), 'utf8')
        expect(actual, `${dir}/${file} has drifted; run node scripts/build-assets.mjs`).toBe(expected)
      }
    }
  })
})
