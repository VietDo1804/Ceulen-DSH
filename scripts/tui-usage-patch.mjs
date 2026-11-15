#!/usr/bin/env node
// dsh-tui 0.20.0 clamps setField(maxCells: 64) to 32 before layout.
// Keep the default and field-count limits; allow all usage windows to survive.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const action = args.shift() ?? 'check'
if (!['apply', 'check', 'revert'].includes(action) ||
    (args.length !== 0 && (args.length !== 2 || args[0] !== '--tui'))) {
  console.error('usage: node scripts/tui-usage-patch.mjs apply|check|revert [--tui <dir>]')
  process.exit(2)
}
const root = args[1] ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
try {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (version !== '0.20.0') throw new Error('Usage patch requires dsh-tui 0.20.0; found ' + version + '. Nothing written.')
  const file = join(root, 'lib/types/dsh-adapter/status.js')
  const source = readFileSync(file, 'utf8')
  const stock = 'const FIELD_CELLS_MAX = 32;'
  const patched = 'const FIELD_CELLS_MAX = 64; // ceulen-usage: retain 5h/W/M countdowns'
  const count = text => source.split(text).length - 1
  const applied = count(patched) === 1 && count(stock) === 0
  const original = count(stock) === 1 && count(patched) === 0
  if (!applied && !original) throw new Error('Usage cap anchor must match exactly once. Nothing written.')
  if (action === 'check') {
    console.log('dsh-tui ' + version + ' usage cap patch ' + (applied ? 'applied' : 'NOT applied'))
    process.exit(applied ? 0 : 1)
  }
  if ((action === 'apply' && original) || (action === 'revert' && applied)) {
    writeFileSync(file, source.replace(action === 'apply' ? stock : patched, action === 'apply' ? patched : stock))
  }
  console.log('Usage cap patch ' + (action === 'apply' ? 'applied' : 'reverted') + ' on dsh-tui ' + version + '. Restart the TUI.')
} catch (error) {
  console.error(String(error))
  process.exit(1)
}
