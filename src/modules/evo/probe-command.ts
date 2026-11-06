import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentLike, CommandResult, PluginContext } from '../../core/types.js'
import { ceulenHome } from '../../core/paths.js'
import { loadSettingsSync } from '../../core/settings.js'
import { logLine } from '../../core/log.js'
import { formatContrast, readContrast, readFixtures, runProbe, writeContrast, type ProbeFixture } from './probe.js'
import { appendProbeRun, probesToday } from './probe-ledger.js'
import { evoDir } from './paths.js'
import { newestProposal, proposalLines, readProposalFile, reportsDir, scopeParser, type ProposalReport } from './reports.js'
import { realProbeRunner } from './probe-run.js'

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

/** Flags whose next token is a value, never the positional proposal file. */
const VALUE_FLAGS = new Set(['--evidence', '--k', '--fixtures'])

function proposalArg(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index]!
    if (entry.startsWith('--')) continue
    if (VALUE_FLAGS.has(args[index - 1] ?? '')) continue
    if (entry.endsWith('.md')) return entry
  }
  return newestProposal()?.name
}

/** Content hash pinning a contrast to the proposal it measured. */
function proposalHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function probeCommand(
  ctx: PluginContext,
  rawInput: string,
  agent: AgentLike | undefined,
  signal: AbortSignal,
  flash: (text: string) => void,
): Promise<CommandResult> {
  if (agent === undefined) return { kind: 'error', text: '/evo-probe needs a live session (run it inside the agent)' }
  const args = rawInput.trim().split(/\s+/).filter(Boolean)
  const proposalName = proposalArg(args)
  if (proposalName === undefined) return { kind: 'error', text: 'no proposal: run evo_pass (or pass a proposal-*.md file)' }
  const proposalText = readProposalFile(proposalName)
  if (proposalText === undefined) return { kind: 'error', text: `proposal not found: ${join(reportsDir(), proposalName)}` }

  const settings = loadSettingsSync()
  const max = settings.evo.probeBudget.maxRunsPerDay
  const today = probesToday()
  if (today >= max) {
    return { kind: 'error', text: `probe budget reached: ${today}/${max} today. Raise evo.probeBudget.maxRunsPerDay in ${join(ceulenHome(), 'settings.json')}.` }
  }

  const requested = flagValue(args, '--fixtures')?.split(',').map(entry => entry.trim()).filter(Boolean)
  const fixtures: ProbeFixture[] = readFixtures(join(evoDir(), 'ledger.jsonl'), requested)
  if (fixtures.length === 0) {
    return {
      kind: 'error',
      text: 'no fixtures with a recorded task: drain a digest whose ## requests section is non-empty (node scripts/evo-distill.mjs + node scripts/evo-report.mjs --drain), then retry.',
    }
  }

  let rule: string
  try {
    const parseProposal = await scopeParser()
    const report = parseProposal(proposalText, { repoRoot: process.cwd() })
    rule = report.proposed.map(item => `- ${item.text}`).join('\n')
    if (report.proposed.length === 0) return { kind: 'error', text: `proposal has no scoped rule lines to probe: ${report.errors.map(error => error.reason).join('; ') || 'empty ## Add to RULES.md section'}` }
  } catch (error) {
    return { kind: 'error', text: `proposal unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }

  let subagents: { startActivation?: unknown } | undefined
  try {
    subagents = ctx.get('subagents', false) as { startActivation?: unknown } | undefined
  } catch {
    subagents = undefined
  }
  if (subagents === undefined || typeof subagents.startActivation !== 'function') {
    return { kind: 'error', text: 'subagent service is not mounted; /evo-probe needs delegation to spawn the base/candidate workers' }
  }

  const repoRoot = process.cwd()
  const runner = realProbeRunner(agent, subagents as Parameters<typeof realProbeRunner>[1], signal)
  try {
    const inside = String(await runner.git(['rev-parse', '--is-inside-work-tree'], repoRoot)).trim()
    if (inside !== 'true') throw new Error('not a git work tree')
  } catch {
    return { kind: 'error', text: `${repoRoot} is not a git work tree; worktree probes need a checkout with commits` }
  }

  const k = Math.max(1, Math.min(8, Number(flagValue(args, '--k') ?? 2) || 2))
  // Reserve the run before spawning: a second invocation must see the budget.
  const runId = randomUUID()
  appendProbeRun({ at: new Date().toISOString(), proposal: proposalName, verdict: 'started', runId })
  // Detached: two children per fixture per run, then the contrast lands.
  void runProbe({ proposalName, proposalHash: proposalHash(proposalText), rule, fixtures, k, repoRoot }, runner)
    .then(contrast => {
      const file = writeContrast(reportsDir(), contrast)
      appendProbeRun({ at: new Date().toISOString(), proposal: proposalName, verdict: contrast.verdict, runId, k, fixtures: fixtures.map(fixture => fixture.id), contrast: file })
      flash(`💾 evo · probe ${contrast.verdict}`)
      logLine('evo', `probe ${proposalName}: ${contrast.verdict} -> ${file}`)
    })
    .catch(error => {
      // A run whose children fail still cost two sessions: it counts.
      appendProbeRun({ at: new Date().toISOString(), proposal: proposalName, verdict: 'failed', runId })
      logLine('evo', `probe failed: ${error instanceof Error ? error.message : String(error)}`)
      flash('💾 evo · probe failed')
    })

  return {
    kind: 'success',
    text: [
      `probe started: ${proposalName} · ${fixtures.length} fixture(s) × k=${k} · ${fixtures.map(fixture => fixture.id).join(', ')}`,
      `budget ${today}/${max} today · worktrees under .probe/`,
      'The contrast file lands in reports/ when both workers settle; /evo-apply refuses the proposal until it does.',
    ].join('\n'),
  }
}

export async function applyCommand(rawInput: string): Promise<CommandResult> {
  const args = rawInput.trim().split(/\s+/).filter(Boolean)
  const proposalName = proposalArg(args)
  if (proposalName === undefined) return { kind: 'error', text: 'no proposal: run evo_pass (or pass a proposal-*.md file)' }
  const proposalText = readProposalFile(proposalName)
  if (proposalText === undefined) return { kind: 'error', text: `proposal not found: ${join(reportsDir(), proposalName)}` }

  const contrast = readContrast(reportsDir(), proposalName)
  const evidence = flagValue(args, '--evidence')
  if (contrast === undefined && evidence === undefined) {
    return {
      kind: 'error',
      text: [
        `no probe evidence for ${proposalName}: the --probe gate refuses an unprobed proposal.`,
        `  run /evo-probe ${proposalName}`,
        '  (or pass --evidence <file> for a manual override; the override is recorded in the probe ledger)',
      ].join('\n'),
    }
  }
  let report: ProposalReport
  try {
    const parseProposal = await scopeParser()
    report = parseProposal(proposalText, { repoRoot: process.cwd() })
  } catch (error) {
    return { kind: 'error', text: `proposal unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  // A contrast measures one proposal text: an edited proposal needs a new probe.
  if (contrast?.proposalHash !== undefined && contrast.proposalHash !== proposalHash(proposalText)) {
    return {
      kind: 'error',
      text: `proposal ${proposalName} changed since the probe: re-run /evo-probe ${proposalName} (the recorded contrast is for an older revision).`,
    }
  }
  if (contrast === undefined && evidence !== undefined) {
    appendProbeRun({ at: new Date().toISOString(), proposal: proposalName, verdict: 'override', evidence })
  }

  return {
    kind: 'success',
    text: [
      `proposal ${proposalName}${contrast === undefined ? ' · manual override recorded' : ` · verdict ${contrast.verdict}`}`,
      ...proposalLines(report),
      ...(contrast === undefined ? [] : ['', formatContrast(contrast)]),
      '',
      'Nothing was written: copy each block into its destination (invariant lines to ~/.dsh/ceulen/RULES.md, domain lines to <repo>/.dsh/RULES.md).',
    ].join('\n'),
  }
}
