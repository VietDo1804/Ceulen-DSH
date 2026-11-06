#!/usr/bin/env node
/**
 * Target: dsh-tui 0.18.0.
 *
 * dsh-tui names an unmapped tool by upper-casing its first letter, so the
 * dsh-fff tools render as `Fff_grep`, `Fff_find` — an acronym mangled into a
 * CamelCase word. This patch adds an alias table ahead of that fallback so
 * the grep tool renders as the short id `fff`.
 *
 * Usage: node scripts/tui-toolname-patch.mjs [apply|revert|check] [--tui <dir>]
 * Re-run `apply` after a dsh-tui update; `check` exits 1 when not applied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOOL_CARD = 'lib/types/components/messages/AssistantToolUseMessage.js'

const DISPLAY_FN = `function displayName(name, displayKey) {`
const ALIAS_TABLE = `/** The grep tool renders as the short id \`fff\`; the generic rule below would turn
 *  \`fff_grep\` into \`Fff_grep\`. Add a row per acronym family, not per rule. */
const TOOL_NAME_ALIASES = {
    fff_grep: 'fff',
};
${DISPLAY_FN}`

const FALLBACK = `    if (name.length === 0)
        return name;`
const ALIAS_LOOKUP = `    if (TOOL_NAME_ALIASES[name] !== undefined)
        return TOOL_NAME_ALIASES[name];
${FALLBACK}`

const EDITS = [
  { file: TOOL_CARD, from: DISPLAY_FN, to: ALIAS_TABLE },
  { file: TOOL_CARD, from: FALLBACK, to: ALIAS_LOOKUP },
]

const args = process.argv.slice(2)
const action = args.find(arg => !arg.startsWith('--')) ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, TOOL_CARD))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

if (action === 'check') {
  const file = readFileSync(join(root, TOOL_CARD), 'utf8')
  const applied = EDITS.every(edit => count(file, edit.to) === 1)
  console.log(`dsh-tui ${version} at ${root}: ${applied ? 'tool-name alias patch applied' : 'tool-name alias patch NOT applied'}`)
  process.exit(applied ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-toolname-patch.mjs [apply|revert|check] [--tui <dir>]')
  process.exit(2)
}

for (const edit of EDITS) {
  const path = join(root, edit.file)
  const before = readFileSync(path, 'utf8')
  const [search, replacement] = action === 'apply' ? [edit.from, edit.to] : [edit.to, edit.from]
  if (count(before, search) !== 1) {
    console.error(`${action} failed: ${edit.file} does not match dsh-tui ${version}. Re-check the package version.`)
    process.exit(1)
  }
  writeFileSync(path, before.replace(search, replacement))
}
console.log(`${action === 'apply' ? 'applied' : 'reverted'} the tool-name aliases on dsh-tui ${version}. Restart the TUI.`)
