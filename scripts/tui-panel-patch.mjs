#!/usr/bin/env node
/**
 * Target: dsh-tui 0.20.0 / 0.20.1 / 0.20.2 (TUI plugin layer only; the dsh harness is untouched).
 *
 * `ctx.tuiPanels.open(id)` always moves keyboard focus into the side panel,
 * so a panel that opens itself (the agentbar Subagents panel when a delegate
 * starts) would swallow whatever the user was typing. This patch adds
 * `tuiPanels.reveal(id)`: the same owner check, rate limit and enabled/split
 * gates as `open`, but the chat keeps focus. Plugins feature-detect
 * `reveal`; on a stock tree they simply do not auto-open.
 *
 * Usage: node scripts/tui-panel-patch.mjs [apply|revert|check] [--tui <dir>]
 * Re-run `apply` after a dsh-tui update; `check` exits 1 when not applied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SUPPORTED = ['0.20.0', '0.20.1', '0.20.2']
const SERVICE = 'lib/types/dsh-adapter/panels.js'
const CONTROLLER = 'lib/types/components/sidePanel/useSidePanel.js'

const OPEN_HEAD = `    open(id) {
        assertCapabilityShadowPolicy('host.panels.open',`
const REVEAL_HEAD = `    /** ceulen-panel: open without moving keyboard focus off the chat. */
    reveal(id) {
        return this.open(id, 'reveal');
    }
    open(id, kind) {
        assertCapabilityShadowPolicy('host.panels.open',`
const OPEN_REQUEST = `        if (!panelBridgeRequests.request('open', String(id)))`
const REVEAL_REQUEST = `        if (!panelBridgeRequests.request(kind === 'reveal' ? 'reveal' : 'open', String(id)))`

const OPEN_KIND = `        if (request.kind === 'open') {`
const REVEAL_KIND = `        if (request.kind === 'open' || request.kind === 'reveal') {`
const OPEN_FOCUS = `            view.openPanel(request.id, { focus: true });`
const REVEAL_FOCUS = `            // ceulen-panel: reveal keeps the chat focused.
            view.openPanel(request.id, { focus: request.kind !== 'reveal' });`

const EDITS = [
  { file: SERVICE, from: OPEN_HEAD, to: REVEAL_HEAD },
  { file: SERVICE, from: OPEN_REQUEST, to: REVEAL_REQUEST },
  { file: CONTROLLER, from: OPEN_KIND, to: REVEAL_KIND },
  { file: CONTROLLER, from: OPEN_FOCUS, to: REVEAL_FOCUS },
]

const args = process.argv.slice(2)
const action = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--tui') ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, SERVICE)) || !existsSync(join(root, CONTROLLER))) {
  console.error(`dsh-tui side-panel files not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const count = (haystack, needle) => haystack.split(needle).length - 1

if (action === 'check') {
  const sources = new Map([SERVICE, CONTROLLER].map(file => [file, readFileSync(join(root, file), 'utf8')]))
  const applied = EDITS.every(edit => count(sources.get(edit.file), edit.to) === 1)
  console.log(`dsh-tui ${version} at ${root}: ${applied ? 'panel reveal patch applied' : 'panel reveal patch NOT applied'}`)
  process.exit(applied ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-panel-patch.mjs [apply|revert|check] [--tui <dir>]')
  process.exit(2)
}
if (action === 'apply' && !SUPPORTED.includes(version)) {
  console.error(`apply refused: dsh-tui ${version} is not a verified target (${SUPPORTED.join(', ')}). Check the anchors, then extend SUPPORTED.`)
  process.exit(1)
}

const files = new Map([SERVICE, CONTROLLER].map(file => [file, readFileSync(join(root, file), 'utf8')]))
for (const edit of EDITS) {
  const before = files.get(edit.file)
  // `from` survives inside some `to` forms, so an applied edit is skipped, never re-applied.
  if (action === 'apply' && count(before, edit.to) === 1) continue
  if (action === 'revert' && count(before, edit.to) === 0) continue
  const [search, replacement] = action === 'apply' ? [edit.from, edit.to] : [edit.to, edit.from]
  if (count(before, search) !== 1) {
    console.error(`${action} failed: ${edit.file} does not match dsh-tui ${version}. Re-check the package version.`)
    process.exit(1)
  }
  files.set(edit.file, before.replace(search, replacement))
}
// Validate every edit before writing: a moved later anchor must leave no half patch.
for (const [file, source] of files) writeFileSync(join(root, file), source)
console.log(`${action === 'apply' ? 'applied' : 'reverted'} the panel reveal patch on dsh-tui ${version}. Restart the TUI.`)
