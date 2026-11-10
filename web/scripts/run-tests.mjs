// Runs every scripts/test-*.ts with plain Node (no framework), one after another, and fails if any fails.
// Same as: for f in scripts/test-*.ts; do node $f; done, but it also works on Windows. Run from /web: npm test
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(dir).filter((f) => /^test-.*\.ts$/.test(f)).sort()
const failed = []
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' })
  const ok = result.status === 0
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`)
  if (!ok) {
    failed.push(file)
    console.log(result.stdout + result.stderr)
  }
}
console.log(`\n${files.length - failed.length} of ${files.length} test files passed`)
process.exit(failed.length ? 1 : 0)
