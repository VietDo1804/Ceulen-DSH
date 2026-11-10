import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '../../core/types.js'
import { clampText, registerCommandSafe } from '../../core/tools.js'
import { readChanges, pendingChanges } from './notice.js'
import { evoDir, reportsDir } from './paths.js'

function lineCount(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** The newest `report-<date>.md` and the line that sums up its fix groups. */
export function newestReport(): { file: string; headline: string } | undefined {
  let names: string[] = []
  try {
    names = readdirSync(reportsDir()).filter(name => /^report-\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
  } catch {
    return undefined
  }
  const name = names[names.length - 1]
  if (name === undefined) return undefined
  const file = join(reportsDir(), name)
  try {
    const headline = readFileSync(file, 'utf8').split('\n').find(line => line.startsWith('## fix groups')) ?? ''
    return { file, headline: headline.replace(/^## /, '') }
  } catch {
    return undefined
  }
}

export function registerEvoCommands(ctx: PluginContext): void {
  registerCommandSafe(ctx, {
    name: 'evo-status',
    description: 'Show the evo ledger, the newest weekly report with its fix groups, recorded fixes and pending notices',
    async handler() {
      const changes = readChanges()
      const pending = pendingChanges()
      const report = newestReport()
      return {
        kind: 'success',
        text: [
          `evo · ledger ${lineCount(join(evoDir(), 'ledger.jsonl'))} sessions · changes ${changes.length} · unseen ${pending.length}`,
          ...changes.slice(-3).map(entry => `  ${entry.at.slice(0, 16).replace('T', ' ')}  ${clampText(entry.summary, 140)}`),
          report === undefined
            ? `report: none yet in ${reportsDir()}/ (the weekly timer writes it; scripts/evo-weekly.mjs by hand)`
            : `report: ${report.file}${report.headline === '' ? '' : `\n  ${report.headline}`}`,
          `fixes recorded: ${lineCount(join(evoDir(), 'fixes.jsonl'))} (scripts/evo-report.mjs --fixed)`,
          'The report changes nothing. To act on it, start a review session on the model you trust: "evo weekly review".',
          pending.length > 0 ? 'A pending notice is delivered at the next idle; /evo-status does not consume it.' : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })
}
