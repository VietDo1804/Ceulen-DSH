import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentLike, CommandResult, PluginContext } from '../../core/types.js'
import { packageRoot } from '../../core/paths.js'
import { loadSettingsSync } from '../../core/settings.js'
import { parseRoute, streamTextDetailed, type LlmRoute } from '../../core/llm.js'
import { clampText } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { reportsDir, stamp } from './paths.js'
import type { SubagentRuntimeLike } from './probe-run.js'

const run = promisify(execFile)

/** Configured evo route first, then its fallbacks, then the parent route. */
export function routesFor(agent: AgentLike | undefined): LlmRoute[] {
  const settings = loadSettingsSync()
  const sessionId = agent === undefined ? undefined : String(agent.session.id)
  const withSession = (route: LlmRoute): LlmRoute => (sessionId === undefined ? route : { ...route, sessionId })
  const primary: LlmRoute | undefined = settings.evo.provider !== null && settings.evo.model !== null
    ? {
        provider: settings.evo.provider,
        model: settings.evo.model,
        ...(settings.evo.reasoningEffort === null ? {} : { reasoningEffort: settings.evo.reasoningEffort }),
      }
    : agent?.options.provider !== undefined && agent.options.model !== undefined
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
  // A fallback equal to the primary would only repeat the same failure.
  const seen = new Set<string>()
  return [primary, ...settings.evo.fallbacks.map(parseRoute)]
    .filter((route): route is LlmRoute => route !== undefined)
    .filter(route => {
      const key = `${route.provider}/${route.model}:${route.reasoningEffort ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(withSession)
}

/** Run one deterministic evo script from the bundle root; returns its last line. */
export async function runScript(script: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [join(packageRoot(), 'scripts', script), ...args], {
    cwd: packageRoot(),
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  const lines = String(stdout).trim().split('\n').filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** Self-contained brief for the evo-model worker spawned by `/evo-cycle`. */
function cycleTask(reportFile: string): string {
  return [
    'You are the evo cycle worker. Turn this week of session evidence into shipped fixes.',
    '',
    `Evidence: ${reportFile}`,
    'Read it, then work the "work list" table: signatures past the threshold (count >= 5 AND sessions >= 3) that still occurred this week and are raised inside this repo.',
    '',
    '1. Pick up to 3 from the work list, highest "this week" first. Skip a row that is a safety gate doing its job or is incident-specific (one broken checkout, a single session) — those are not fixable. An empty work list means there is nothing to fix: say so and stop.',
    '2. For each: find the root cause in this repo (the tool that raises the message), fix it where ALL callers route through, and leave ONE runnable check (a vitest case or an assert-based self-check). Fix the cause, not the message.',
    '3. Run `npm run check` (tsc + vitest + bundle check). If a fix leaves it red, revert that fix — never leave the tree broken.',
    '4. Store verified durable lessons in Munin (the primary memory): `munin_search` for a near-duplicate first, then `munin_store` once. Never a second copy through `agentmem_store` — that is the Pi replica, refreshed from the cloud. Tags `type:bug-fix,domain:<area>`. No session summaries, no TODOs, no unverified guesses.',
    '5. Call `evo_notice` exactly once: one line naming what changed, detail = counts and files.',
    '',
    'Constraints: no git commit, no unrelated refactors, smallest diff. Fixes stay inside this bundle\'s `src/` (plus `test/`) — never `node_modules`, the DSH core, `vendor/`, or `upstream/`; a bug that lives upstream is reported, not patched. Do not edit ~/.dsh/ceulen/settings.json or RULES.md, and do not restart or kill processes.',
    'Report: fixed (file + cause), skipped (signature + why), check result, memories stored, notice line.',
  ].join('\n')
}

const EVO_SYSTEM = [
  'You maintain the sticky rule file of an AI coding agent (DeepSeek Harness).',
  'You receive a promotion packet: recurring failure signatures, each with a count and affected sessions.',
  'Only signatures with >= 5 occurrences across >= 3 distinct sessions qualify. Draft only: never claim a rule was applied; adoption requires a matching passing probe and valid scope.',
  'Turn it into the SMALLEST set of rule lines that would have prevented those failures.',
  'Rules are imperative, scoped, and one line each; put the evidence count in parentheses.',
  'Skip signatures that are incident-specific (one provider outage, one broken checkout) or not fixable by a rule.',
  'Answer in markdown with exactly these sections, no prose outside them:',
  '## Add to RULES.md',
  '## Script fixes',
  '## Drop',
  'Every line under "## Add to RULES.md" starts with a scope tag:',
  '- `- scope: invariant — <repo-agnostic rule>` (applies to every repo, lands in the user rules file)',
  '- `- scope: domain — <rule naming this repo>` (applies here only, lands in the repo rules file)',
  'An invariant line must not name an absolute path, a repo file, or a repo import.',
].join('\n')

/** Reasoning is billed against the same budget as the reply, so the cap must leave room for both. */
const EVO_MAX_TOKENS = 8_000

export interface EvoDraft {
  text: string
  /** The reply hit the token cap: its unfinished last line was dropped. */
  truncated: boolean
  route: LlmRoute
}

/**
 * Ask each route in turn for the draft. A reply cut at the token cap is kept
 * without its unfinished last line and flagged; a route that spent the whole
 * budget thinking is asked once more without a reasoning effort.
 */
export async function askEvo(ctx: PluginContext, routes: readonly LlmRoute[], packet: string, signal: AbortSignal): Promise<EvoDraft> {
  const failures: string[] = []
  const label = (route: LlmRoute): string => `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `:${route.reasoningEffort}`}`
  const plain = (route: LlmRoute): LlmRoute => {
    const { reasoningEffort: _effort, ...rest } = route
    return rest
  }
  for (const route of routes) {
    for (const attempt of route.reasoningEffort === undefined ? [route] : [route, plain(route)]) {
      try {
        const { text, finish } = await streamTextDetailed(ctx, attempt, EVO_SYSTEM, clampText(packet, 12_000), signal, EVO_MAX_TOKENS)
        const cut = finish === 'max-tokens'
        if (text !== '') {
          const whole = cut && text.includes('\n') ? text.slice(0, text.lastIndexOf('\n')) : text
          return { text: whole, truncated: cut, route: attempt }
        }
        failures.push(`${label(attempt)}: ${cut ? `no text within ${EVO_MAX_TOKENS} tokens (the budget went to reasoning)` : 'empty reply'}`)
        if (!cut) break
      } catch (error) {
        failures.push(`${label(attempt)}: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
    if (signal.aborted) break
  }
  throw new Error(`evo route failed: ${failures.join('; ')}`)
}

function subagentService(ctx: PluginContext): SubagentRuntimeLike | undefined {
  try {
    const service = ctx.get('subagents', false) as SubagentRuntimeLike | undefined
    return service !== undefined && typeof service.startActivation === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * One-shot cycle: deterministic scan -> report -> worker on the configured Evo
 * model. Registered at the root so the command palette lists it; the optional
 * subagent service is resolved only when the command runs.
 */
export async function runCycle(ctx: PluginContext, agent: AgentLike | undefined, signal?: AbortSignal): Promise<CommandResult> {
  if (agent === undefined) return { kind: 'error', text: '/evo-cycle needs a live session (run it inside the agent)' }
  const subagents = subagentService(ctx)
  if (subagents === undefined) {
    return { kind: 'error', text: 'subagent service is not mounted; /evo-cycle needs delegation to spawn the worker' }
  }
  const settings = loadSettingsSync()
  const route = settings.evo.provider !== null && settings.evo.model !== null
    ? { provider: settings.evo.provider, model: settings.evo.model }
    : agent.options.provider !== undefined && agent.options.model !== undefined
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
  if (route === undefined) return { kind: 'error', text: 'no evo route: set evo.provider/model in /ceulen-config → Model → Evo' }

  const steps: string[] = []
  try {
    steps.push(await runScript('evo-distill.mjs', ['--all']))
    steps.push(await runScript('evo-report.mjs', ['--drain']))
    await runScript('evo-report.mjs', [])
  } catch (error) {
    return { kind: 'error', text: `evo cycle stage failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  const reportFile = join(reportsDir(), `report-${stamp()}.md`)
  let headline = ''
  try {
    headline = readFileSync(reportFile, 'utf8').split('\n').filter(Boolean)[1] ?? ''
  } catch {
    headline = 'report missing'
  }

  const stop = signal ?? new AbortController().signal
  const activation = await subagents.startActivation({
    provider: 'spawn',
    label: 'evo cycle',
    request: {
      prompt: [{ type: 'text', text: cycleTask(reportFile) }],
      parent: agent,
      signal: stop,
      cwd: packageRoot(),
      // ponytail: no effort override — the agent runtime rejects an effort
      // the model does not advertise (UNSUPPORTED_REASONING_EFFORT) and the
      // catalog exposes no capability metadata to pre-check, so the worker
      // runs at the model default. evo_pass still honors the configured effort.
      agentOptions: { provider: route.provider, model: route.model },
    },
    signal: stop,
    delivery: 'parent',
  })
  logLine('evo', `cycle spawned ${String(activation.childId)} on ${route.provider}/${route.model}`)
  return {
    kind: 'success',
    text: [
      `evo cycle · ${steps.join(' · ')}`,
      `report: ${reportFile}`,
      headline,
      `worker ${String(activation.childId)} on ${route.provider}/${route.model} — fixes, smoke-tests, stores Munin memory, then notifies`,
    ].join('\n'),
  }
}
