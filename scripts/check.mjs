/**
 * Runs the check suites in tests/.
 *
 * They're plain scripts rather than a test framework: esbuild bundles each one and
 * node runs it, so there's no runner to configure and no extra dependency beyond
 * fake-indexeddb (which stands in for the browser's database).
 *
 *   npm run check
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'tamaki-check-'))
const suites = readdirSync('tests').filter((f) => f.endsWith('.check.ts')).sort()

let failed = 0

for (const suite of suites) {
  const bundle = join(out, suite.replace(/\.ts$/, '.cjs'))
  await build({
    entryPoints: [join('tests', suite)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
  })

  console.log(`\n──────── ${suite} ────────`)
  try {
    execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
  } catch {
    failed++
  }
}

rmSync(out, { recursive: true, force: true })

if (failed) {
  console.error(`\n❌ ${failed} of ${suites.length} suite(s) failed\n`)
  process.exit(1)
}
console.log(`\n✅ ${suites.length} suite(s) passed\n`)
