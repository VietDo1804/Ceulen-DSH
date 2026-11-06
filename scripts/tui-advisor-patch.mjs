#!/usr/bin/env node
/**
 * Target: dsh-tui 0.18.0 (anchors unchanged since 0.16.1).
 *
 * dsh-tui drops every user message whose `source.kind` is not `user`
 * (translate.js → `source: 'injected'`, then projection.js bails), so the
 * ceulen advisor's `ceulen-advisor` note never reaches the transcript — only
 * the 15 s footer status line showed it. This patch keeps the note's
 * provenance and renders it as its own transcript row in a rounded box.
 *
 * Usage: node scripts/tui-advisor-patch.mjs [apply|revert|check] [--tui <dir>]
 * Re-run `apply` after a dsh-tui update; `check` exits 1 when not applied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TRANSLATE = 'lib/types/dsh-adapter/backend/translate.js'
const PROJECTION = 'lib/types/channel/projection.js'
const MESSAGE_LIST = 'lib/types/components/MessageList.js'

const INJECTED_TRANSLATE = `        // Injected context (plugin/skill source) is model-facing only; it has no
        // transcript-facing text.
        if (data.source.kind !== 'user')`
const ADVISOR_TRANSLATE = `        // Ceulen advisor: a reviewer note keeps its own transcript row.
        if (data.source.kind === 'ceulen-advisor') {
            return [{ type: 'user.message', ...base, source: 'advisor', text: textOf(data.content) }];
        }
`

const INJECTED_PROJECTION = `        // Injected context (plugin/skill/goal source) is not a human bubble;
        // v1 renders direct human prompts only.
        if (event.source !== 'user')`
const ADVISOR_PROJECTION = `        if (event.source === 'advisor') {
            if (event.text !== '')
                appendRow({ id: deps.rowIds.value, kind: 'advisor', text: event.text, seq: event.seq });
            deps.rowIds.value += 1;
            return;
        }
`

const NOTICE_CASE = `        case 'notice':`
const ADVISOR_CASE = `        case 'advisor':
            return (_jsx(Box, { marginTop: 1, paddingX: 1, flexDirection: "column", borderStyle: "round", borderColor: "inactive", ref: ref, onClick: foldClickable ? foldOnClick : undefined, children: _jsx(Text, { wrap: "wrap", children: displayText }) }));
`

const EDITS = [
  { file: TRANSLATE, from: INJECTED_TRANSLATE, to: ADVISOR_TRANSLATE + INJECTED_TRANSLATE },
  { file: PROJECTION, from: INJECTED_PROJECTION, to: ADVISOR_PROJECTION + INJECTED_PROJECTION },
  { file: MESSAGE_LIST, from: NOTICE_CASE, to: ADVISOR_CASE + NOTICE_CASE },
]

const args = process.argv.slice(2)
const action = args.find(arg => !arg.startsWith('--')) ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, MESSAGE_LIST))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

if (action === 'check') {
  const files = new Map(EDITS.map(edit => [edit.file, readFileSync(join(root, edit.file), 'utf8')]))
  const applied = EDITS.every(edit => count(files.get(edit.file), edit.to) === 1)
  console.log(`dsh-tui ${version} at ${root}: ${applied ? 'advisor block patch applied' : 'advisor block patch NOT applied'}`)
  process.exit(applied ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-advisor-patch.mjs [apply|revert|check] [--tui <dir>]')
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
console.log(`${action === 'apply' ? 'applied' : 'reverted'} the advisor transcript block on dsh-tui ${version}. Restart the TUI.`)
