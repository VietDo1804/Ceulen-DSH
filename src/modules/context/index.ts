/**
 * `/context` — the Claude Code-style context dashboard. The split:
 *
 * - report.ts   public usage/report types, the compaction buffer, buildReport
 * - dashboard.ts ANSI card + plain block rendering, stripAnsi
 * - collect.ts  service reads (projections, token meter, model info) and reportFor
 * - scene.ts    the `/context --play` DNA scene plus its static fallback frame
 */
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { errorMessage, registerCommandSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { briefStatusLine } from '../munin/index.js'
import { briefStatusLine as agentMemBriefStatusLine } from '../agentmem/index.js'
import { collectSnapshots, formatTokens, type DnaEvent } from './dna.js'
import { reportFor, terminalColumns } from './collect.js'
import { dnaReport, openDnaReplay } from './scene.js'
import { stripAnsi } from './dashboard.js'

export const name = 'ceulen-context'
export const inject = ['commands']

// Public surface: tests import these from the module entry.
export { formatTokens }
export { buildReport, compactionBuffer, estimateBreakdown } from './report.js'
export type { CompactionOptions, ContextUsage, ReportOptions } from './report.js'

/**
 * `/context` — the Claude Code-style context dashboard: one block grid plus a
 * per-category token legend, built from the harness's own token meter and
 * session projections. The TUI claims `/context` locally, so
 * scripts/tui-context-patch.mjs redirects the built-in to this registry
 * command when it exists; it also passes `--color --width N` and keeps the
 * SGR sequences this command emits.
 *
 * `--dna` swaps the category grid for the per-item fingerprint (see dna.ts);
 * `--play` opens the replay scene when `tuiScenes` is mounted and falls back
 * to the same static frame otherwise.
 */
export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('context', loadSettingsSync())) return

  registerCommandSafe(ctx, {
    name: 'context',
    description: 'Context window dashboard; --dna prints the per-item fingerprint, --play replays it (TUI)',
    input: { hint: '[--dna | --play] [--color] [--width N]' },
    async handler({ agent, rawInput }) {
      if (agent === undefined) {
        logLine('context', 'invoked without a session context')
        return { kind: 'error', text: 'context needs a session context' }
      }
      try {
        const color = /(?:^|\s)--color(?:\s|$)/u.test(rawInput)
        const width = /(?:^|\s)--width(?:=|\s+)(\d{1,4})/u.exec(rawInput)
        const columns = width === null ? terminalColumns() : Number(width[1])
        // DNA mode reads the request headers in the session log, not the
        // projections: the projections keep category totals, the headers keep
        // the items (and `surfaceOp`, which the local event view omits).
        if (/(?:^|\s)--(?:dna|play)(?:\s|$)/u.test(rawInput)) {
          const events = (agent.session.snapshotEvents?.() ?? []) as unknown as readonly DnaEvent[]
          const snapshots = collectSnapshots(events, { limit: 200 })
          if (/(?:^|\s)--play(?:\s|$)/u.test(rawInput)) {
            if (openDnaReplay(ctx, snapshots)) {
              logLine('context', `dna replay opened (${snapshots.length} frames)`)
              return { kind: 'success', text: '' }
            }
            logLine('context', 'dna replay unavailable; printing the latest frame')
          }
          return { kind: 'success', text: dnaReport(snapshots, { width: columns ?? 100, color }) }
        }
        const report = await reportFor(ctx, agent, { color, columns })
        // One line item per memory brief: exact bytes, absent when that brief is off.
        const briefs = [briefStatusLine(), agentMemBriefStatusLine()].filter(line => line !== '')
        const text = briefs.length === 0 ? report : `${report}\n${briefs.join('\n')}`
        logLine('context', `invoked: ${stripAnsi(text.split('\n')[0] ?? '')}`)
        return { kind: 'success', text }
      } catch (error) {
        logLine('context', `invoked failed: ${errorMessage(error)}`)
        return { kind: 'error', text: `context failed: ${errorMessage(error)}` }
      }
    },
  })

  logLine('context', 'loaded (/context block dashboard from tokenMeter + session projections; --dna/--play)')
}
