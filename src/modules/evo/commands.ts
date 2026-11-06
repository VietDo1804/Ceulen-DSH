import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '../../core/types.js'
import { clampText, registerCommandSafe } from '../../core/tools.js'
import { loadSettingsSync } from '../../core/settings.js'
import { runCycle } from './cycle.js'
import { readChanges, pendingChanges } from './notice.js'
import { newestProposal, proposalLines, scopeParser } from './reports.js'
import { probesToday } from './probe-ledger.js'
import { evoDir, reportsDir } from './paths.js'
import { applyCommand, probeCommand } from './probe-command.js'

export function registerEvoCommands(ctx: PluginContext, flash: (text: string) => void): void {
  registerCommandSafe(ctx, {
    name: 'evo-status',
    description: 'Show evo ledger, pending notices and the latest report',
    async handler() {
      const changes = readChanges()
      const pending = pendingChanges()
      let ledger = 0
      try {
        ledger = readFileSync(join(evoDir(), 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length
      } catch {
        ledger = 0
      }
      const proposal = newestProposal()
      let proposalText: string[] = []
      if (proposal !== undefined) {
        try {
          const parseProposal = await scopeParser()
          proposalText = [`proposals: ${proposal.name}`, ...proposalLines(parseProposal(proposal.text, { repoRoot: process.cwd() }))]
        } catch (error) {
          proposalText = [`proposals: ${proposal.name} (unreadable: ${error instanceof Error ? error.message : String(error)})`]
        }
      }
      return {
        kind: 'success',
        text: [
          `evo · ledger ${ledger} sessions · changes ${changes.length} · unseen ${pending.length}`,
          ...changes.slice(-3).map(entry => `  ${entry.at.slice(0, 16).replace('T', ' ')}  ${clampText(entry.summary, 140)}`),
          `report: ${reportsDir()}/`,
          `probe: ${probesToday()}/${loadSettingsSync().evo.probeBudget.maxRunsPerDay} runs today · /evo-probe · /evo-apply`,
          ...proposalText,
          pending.length > 0 ? 'A pending notice is delivered at the next idle; /evo-status does not consume it.' : '',
        ].filter(Boolean).join('\n'),
      }
    },
  })

  registerCommandSafe(ctx, {
    name: 'evo-cycle',
    description: 'Scan every session, rebuild the evo report, then hand the top signatures to an agent on the configured Evo model that fixes, smoke-tests, stores Munin memories and posts the notice',
    async handler({ agent, signal }) {
      return await runCycle(ctx, agent, signal)
    },
  })

  registerCommandSafe(ctx, {
    name: 'evo-probe',
    description: 'Probe a proposal: base vs candidate worktrees on the recorded fixtures, then write contrast-<proposal>.json (--k 2, --fixtures id,id)',
    input: { hint: '[proposal.md] [--k 2] [--fixtures id,id]' },
    async handler({ rawInput, agent, signal }) {
      return await probeCommand(ctx, rawInput, agent, signal ?? new AbortController().signal, flash)
    },
  })

  registerCommandSafe(ctx, {
    name: 'evo-apply',
    description: 'Render a proposal as reviewable blocks per destination; refuses without a probe contrast (--evidence <file> overrides and is recorded)',
    input: { hint: '[proposal.md] [--evidence <file>]' },
    async handler({ rawInput }) {
      return await applyCommand(rawInput)
    },
  })
}
