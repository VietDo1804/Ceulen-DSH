#!/usr/bin/env node
/**
 * Strict typecheck gate (plan 1.4 + 1.5).
 *
 * `tsconfig.strict.json` turns on noUncheckedIndexedAccess, noImplicitReturns
 * and noFallthroughCasesInSwitch. TypeScript has no per-file flags, so the
 * vendored upstream files under `src/vendor/**` are compiled with those flags
 * too; their diagnostics are dropped here, because the vendored-code policy
 * forbids editing them for strictness (src/vendor also imports back into
 * src/core, so project references cannot isolate it).
 *
 * An adapter diagnostic caused by a vendor type still surfaces at the adapter
 * call site, which is ours to fix. Set STRICT_SHOW_VENDOR=1 to see the
 * suppressed vendor diagnostics.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')

let output = ''
let status = 0
try {
  execFileSync(tsc, ['-p', 'tsconfig.strict.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8' })
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  status = typeof error.status === 'number' ? error.status : 1
}

// tsc prints one first line per diagnostic; wrapped detail lines start with
// spaces, so a block belongs to the file named by its first line.
const blocks = []
for (const line of output.split(/\r?\n/)) {
  if (/^[^\s].*?\(\d+,\d+\): (error|warning) TS\d+/.test(line) || /^[^\s].*?: (error|warning) TS\d+/.test(line)) {
    blocks.push([line])
  } else if (blocks.length > 0 && line.trim() !== '') {
    blocks[blocks.length - 1].push(line)
  }
}

const vendor = blocks.filter(block => block[0].startsWith('src/vendor/'))
const ours = blocks.filter(block => !block[0].startsWith('src/vendor/'))
// Config-level failures (`error TS5023: Unknown compiler option …`) carry no
// file:line prefix, so they would otherwise be dropped as "not ours".
const orphans = output.split(/\r?\n/).filter(line => /^error TS\d+/.test(line))

if (process.env.STRICT_SHOW_VENDOR === '1') console.log(vendor.map(block => block.join('\n')).join('\n'))
for (const block of ours) console.error(block.join('\n'))

if (ours.length > 0 || orphans.length > 0) {
  for (const line of orphans) console.error(line)
  console.error(`typecheck:strict: ${ours.length + orphans.length} diagnostic(s) in adapter/core code`)
  process.exit(1)
}
// A failing tsc that printed nothing at all must not read as a pass.
if (status !== 0 && blocks.length === 0) {
  console.error(`typecheck:strict: tsc exited ${status} without a diagnostic; check tsconfig.strict.json`)
  process.exit(1)
}
console.log(`typecheck:strict: clean${vendor.length > 0 ? ` (${vendor.length} vendored diagnostic(s) ignored)` : ''}`)
