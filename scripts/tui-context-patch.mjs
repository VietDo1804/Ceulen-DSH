#!/usr/bin/env node
/**
 * Target: dsh-tui 0.18.0.
 *
 * dsh-tui claims `/context` locally (Chat.js `case 'context'` renders the
 * loaded-context dump), and its merged command list shadows registry names
 * with locals — a registry command named `context` never appears as
 * `external` and would never run. This patch replaces the local case with a
 * registry probe: invoke `context` directly (the token dashboard when ceulen
 * is composed), and keep the loaded-context dump as the fallback when the
 * registry has no such command. The dashboard is ANSI-colored, so the patched
 * path also whitelists SGR sequences (colors/bold only — cursor, OSC and
 * hyperlink escapes are still dropped) and forwards the TUI's column count.
 *
 * Usage: node scripts/tui-context-patch.mjs [apply|revert|check] [--tui <dir>]
 * Re-run `apply` after a dsh-tui update; `check` exits 1 when not applied.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHAT = 'lib/types/screens/Chat.js'

const STOCK = `            case 'context': {
                setHelpOpen(false);
                const context = channel.loadedContext;
                if (context === undefined) {
                    channel.notify(t('context-unavailable'), { color: 'warning' });
                    return true;
                }
                channel.pushLocal('/context', formatLoadedContextReport(context));
                return true;
            }`
const PATCHED = String.raw`            case 'context': {
                setHelpOpen(false);
                // ceulen-context: the DSH registry may own /context (the token
                // dashboard). The merged command list shadows registry names with
                // locals, so a commandList probe never sees it — invoke the
                // registry directly and keep the loaded-context dump as fallback.
                // The dashboard is colored: keep SGR only (the stock sanitizer
                // strips every escape and would flatten the grid).
                return channel.runExternalCommandOutcome('context', rawInput + ' --color --width ' + (process.stdout.columns ?? 100), images).then(outcome => {
                    if (outcome === undefined) {
                        const loadedContext = channel.loadedContext;
                        if (loadedContext === undefined) {
                            channel.notify(t('context-unavailable'), { color: 'warning' });
                            return true;
                        }
                        channel.pushLocal('/context', formatLoadedContextReport(loadedContext));
                        return true;
                    }
                    const keepSgr = value => value
                        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
                        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, seq => (/^\x1b\[[0-9;]{1,64}m$/u.test(seq) ? seq : ''))
                        .replace(/\x1b(?!\[[0-9;]{1,64}m)/gu, '')
                        .replace(/[\x00-\x1a\x1c-\x1f\x7f-\x9f]/gu, '');
                    // Split before the control strip: keepSgr works on one
                    // rendered line, so the newlines are structure, not escapes.
                    const bounded = outcome.text.length > 65_536 ? outcome.text.slice(0, 65_536) : outcome.text;
                    const rows = bounded.split(/\r?\n/u);
                    const truncated = bounded.length < outcome.text.length || rows.length > 200;
                    const lines = rows.slice(0, 200).map(keepSgr);
                    if (truncated)
                        lines.push(t('command-output-truncated'));
                    if (lines.length > 0)
                        channel.pushLocal('/context', lines, { lineLimit: 65_536, preserveWhitespace: true });
                    if (outcome.kind === 'error') {
                        const cleaned = cleanRenderText(outcome.text, COMMAND_RESULT_CELLS);
                        if (cleaned !== '')
                            channel.notify(cleaned, { color: 'error' });
                    }
                    return true;
                });
            }`

/** The pre-ANSI ceulen patch; upgraded in place so `apply` is idempotent. */
const LEGACY_PATCHED = `            case 'context': {
                setHelpOpen(false);
                // ceulen-context: the DSH registry may own /context (the token
                // dashboard). The merged command list shadows registry names with
                // locals, so a commandList probe never sees it — invoke the
                // registry directly and keep the loaded-context dump as fallback.
                return channel.runExternalCommandOutcome('context', rawInput, images).then(outcome => {
                    if (outcome === undefined) {
                        const loadedContext = channel.loadedContext;
                        if (loadedContext === undefined) {
                            channel.notify(t('context-unavailable'), { color: 'warning' });
                            return true;
                        }
                        channel.pushLocal('/context', formatLoadedContextReport(loadedContext));
                        return true;
                    }
                    const report = cleanCommandReport(outcome.text);
                    if (report.truncated)
                        report.lines.push(t('command-output-truncated'));
                    if (report.lines.length > 0)
                        channel.pushLocal('/context', report.lines, { lineLimit: 65_536, preserveWhitespace: true });
                    if (outcome.kind === 'error') {
                        const cleaned = cleanRenderText(outcome.text, COMMAND_RESULT_CELLS);
                        if (cleaned !== '')
                            channel.notify(cleaned, { color: 'error' });
                    }
                    return true;
                });
            }`

const args = process.argv.slice(2)
const action = args.find(arg => !arg.startsWith('--')) ?? 'check'
const tuiFlag = args.indexOf('--tui')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = tuiFlag >= 0 && args[tuiFlag + 1] !== undefined
  ? args[tuiFlag + 1]
  : join(home, 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

if (!existsSync(join(root, CHAT))) {
  console.error(`dsh-tui not found at ${root}\nPass --tui <path-to-@deepseek-harness-tui/dsh-tui>.`)
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const chatPath = join(root, CHAT)

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

if (action === 'check') {
  const chat = readFileSync(chatPath, 'utf8')
  const applied = count(chat, PATCHED) === 1
  console.log(`dsh-tui ${version} at ${root}: ${applied ? 'context redirect patch applied' : 'context redirect patch NOT applied'}`)
  process.exit(applied ? 0 : 1)
}

if (action !== 'apply' && action !== 'revert') {
  console.error('usage: node scripts/tui-context-patch.mjs [apply|revert|check] [--tui <dir>]')
  process.exit(2)
}

const before = readFileSync(chatPath, 'utf8')
if (action === 'apply') {
  if (count(before, PATCHED) === 1) {
    console.log(`dsh-tui ${version}: context redirect patch already applied.`)
    process.exit(0)
  }
  const search = count(before, STOCK) === 1 ? STOCK : LEGACY_PATCHED
  if (count(before, search) !== 1) {
    console.error(`apply failed: ${CHAT} does not match dsh-tui ${version}. Re-check the package version.`)
    process.exit(1)
  }
  writeFileSync(chatPath, before.replace(search, PATCHED))
  console.log(`applied the /context ANSI dashboard redirect on dsh-tui ${version}. Restart the TUI.`)
  process.exit(0)
}
if (count(before, PATCHED) !== 1 && count(before, LEGACY_PATCHED) !== 1) {
  console.error(`revert failed: ${CHAT} is not patched for dsh-tui ${version}.`)
  process.exit(1)
}
const search = count(before, PATCHED) === 1 ? PATCHED : LEGACY_PATCHED
writeFileSync(chatPath, before.replace(search, STOCK))
console.log(`reverted the /context redirect on dsh-tui ${version}. Restart the TUI.`)
