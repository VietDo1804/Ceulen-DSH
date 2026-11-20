/**
 * Delegation nudges for cheap lead models. Measured 2026-11-06..20 over lead
 * sessions: deepseek-v4.1-flash delegated in 17% of sessions (gpt-6.1-sol 78%)
 * and spent 51% of its calls in bash. Wording alone has not moved flash before
 * (the codemode chain hint was followed 4/14), so the lead gets a concrete
 * notice at the moment it matters, at most once per turn and kind:
 *
 * - recon: N local discovery calls in one turn with no delegation yet.
 * - review: the turn has edited M distinct files and no reviewer ran yet.
 *
 * Pure state machine here; the wiring is `installNudges` at the bottom.
 */
import { randomUUID } from 'node:crypto'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { loadSettingsSync } from '../../core/settings.js'
import { errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { callLabel, isReadOnlyCall } from '../codemode/chain-hint.js'
import { routeWanted } from '../../core/route.js'

export interface NudgeState {
  turn?: number
  discovery: number
  labels: string[]
  delegated: boolean
  reviewed: boolean
  edited: Set<string>
  reconSent: boolean
  reviewSent: boolean
}

export interface NudgeLimits {
  discoveryAfter: number
  reviewAfterFiles: number
  /** Recon waits until the lead's context (input + cache-read tokens) reaches this; 0 = no floor. */
  reconMinContext: number
}

export type Nudge = { kind: 'recon' | 'review'; text: string }

const DELEGATING = new Set(['delegate', 'subagent', 'subagent_fork'])
const EDITING = new Set(['edit', 'write', 'apply_patch'])
const SCRIPT_DELEGATES = /\btools\s*(?:\.\s*(?:delegate|subagent|subagent_fork)|\[\s*['"](?:delegate|subagent|subagent_fork)['"]\s*\])\s*\(/
const SCRIPT_WRITES = /\btools\s*(?:\.\s*(?:edit|write|apply_patch)|\[\s*['"](?:edit|write|apply_patch)['"]\s*\])\s*\(/
const PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/gm
// Flash chains its recon (`pwd; ls -la; find …`, `cd x && for f in …; do sed -n …`),
// which chain-hint's start-anchored pattern does not see. Any search/read token
// counts, unless the command also writes, moves, deletes, builds or tests.
const BASH_LOOKS = /(?:^|[\s;&|(])(?:grep|rg|find|fd|cat|ls|tree|head|tail|sed\s+-n|nl|wc|awk)\b/
const BASH_ACTS = /(?:^|[^>&0-9])>(?!&)|>>|\bsed\s+-i\b|\b(?:rm|mv|cp|mkdir|touch|tee|chmod|git\s+(?:add|commit|checkout|reset|push|apply|stash))\b|write_text|writeFileSync|\b(?:npm|pnpm|yarn|npx|node|python3?|tsc|vitest|jest|pytest|cargo|go|make)\b/

export function createNudgeState(): NudgeState {
  return { discovery: 0, labels: [], delegated: false, reviewed: false, edited: new Set(), reconSent: false, reviewSent: false }
}

function args(argumentsJson: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson ?? '{}') as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function editedPaths(name: string, input: Record<string, unknown>): string[] {
  if (name === 'apply_patch') {
    const patch = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : ''
    return [...patch.matchAll(PATCH_FILE)].map(match => match[1]!.trim())
  }
  const path = input.path ?? input.file_path
  return typeof path === 'string' && path.length > 0 ? [path] : []
}

/** A codemode script counts as discovery unless it writes or delegates. */
function isDiscovery(name: string, argumentsJson: string | undefined, input: Record<string, unknown>): boolean {
  if (name === 'codemode') {
    const code = typeof input.code === 'string' ? input.code : typeof input.script === 'string' ? input.script : ''
    return !SCRIPT_WRITES.test(code) && !SCRIPT_DELEGATES.test(code)
  }
  if (name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return (isReadOnlyCall(name, argumentsJson) || BASH_LOOKS.test(command)) && !BASH_ACTS.test(command)
  }
  return isReadOnlyCall(name, argumentsJson) || name === 'find_files' || name === 'resolve_file'
}

export function reconText(count: number, labels: readonly string[]): string {
  const recent = labels.slice(-4).join('; ')
  return [
    `Delegation check: ${count} local discovery calls this turn (latest: ${recent}) and no subagent yet.`,
    'Every file you read stays in your context for the rest of the session.',
    'If more than 2 more reads or searches remain before you can act, stop reading and call `delegate` now:',
    '`{ role: "scout", description: "<5 words>", task: "<the question, paths to search, what to return: file:line anchors + a 150-word answer>" }`.',
    'Independent questions → one scout each, in the same step. Continue only with work that does not need the answer.',
  ].join('\n')
}

export function reviewText(files: readonly string[]): string {
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? `, +${files.length - 5} more` : '')
  return [
    `Review decision: this turn edited ${files.length} files (${shown}).`,
    'If the change adds logic, changes behaviour or an API, or touches a risky area (security, data loss, concurrency), call `delegate` with `role: "reviewer"` once it is complete and checked: give the goal, the changed paths and the verify commands.',
    'If it is mechanical (rename, added argument, formatting, docs), skip the reviewer and say so in one line of your report.',
  ].join('\n')
}

/**
 * Feed every lead `tool/call` event. Returns the nudge to inject, if any.
 * A new turn number resets the counters.
 */
export function noteCall(
  state: NudgeState,
  call: { turn: number; name: string; arguments?: string; context?: number },
  limits: NudgeLimits,
): Nudge | undefined {
  if (state.turn !== call.turn) Object.assign(state, createNudgeState(), { turn: call.turn })
  const input = args(call.arguments)
  if (DELEGATING.has(call.name) || (call.name === 'codemode' && SCRIPT_DELEGATES.test(String(input.code ?? input.script ?? '')))) {
    state.delegated = true
    if (String(input.role ?? '') === 'reviewer' || /role\s*:\s*['"]reviewer['"]/.test(String(input.code ?? ''))) state.reviewed = true
    return undefined
  }
  if (EDITING.has(call.name)) {
    for (const path of editedPaths(call.name, input)) state.edited.add(path)
    if (limits.reviewAfterFiles > 0 && !state.reviewed && !state.reviewSent && state.edited.size >= limits.reviewAfterFiles) {
      state.reviewSent = true
      return { kind: 'review', text: reviewText([...state.edited]) }
    }
    return undefined
  }
  if (!isDiscovery(call.name, call.arguments, input)) return undefined
  state.discovery += 1
  state.labels.push(callLabel(call.name, call.arguments))
  if (limits.discoveryAfter <= 0 || state.delegated || state.reconSent || state.discovery < limits.discoveryAfter) return undefined
  if (limits.reconMinContext > 0 && (call.context ?? 0) < limits.reconMinContext) return undefined
  state.reconSent = true
  return { kind: 'recon', text: reconText(state.discovery, state.labels) }
}

export { routeWanted } from '../../core/route.js'

interface SessionLike { id?: string; header?: { parentSession?: string } }
interface UsageLike { inputTokens?: number; cacheReadTokens?: number }
interface EventLike {
  type?: string
  data?: { turn?: number; name?: unknown; arguments?: unknown; provider?: string; model?: string; usage?: UsageLike; message?: { usage?: UsageLike } }
}

export function installNudges(ctx: PluginContext): void {
  const agents = new Map<string, AgentLike>()
  const routes = new Map<string, string>()
  const states = new Map<string, NudgeState>()
  const contexts = new Map<string, number>()

  ctx.on('agent/created', (payload: { agent?: AgentLike } | undefined) => {
    const agent = payload?.agent
    if (agent === undefined || agent.session?.header?.parentSession !== undefined) return
    const key = String(agent.session.id)
    agents.set(key, agent)
    const current = agent.model?.current?.()
    const provider = current?.provider ?? agent.options?.provider
    const model = current?.model ?? agent.options?.model
    if (provider !== undefined && model !== undefined) routes.set(key, `${provider}/${model}`)
  })
  ctx.on('agent/disposed', (payload: { agent?: AgentLike } | undefined) => {
    if (payload?.agent === undefined) return
    const key = String(payload.agent.session.id)
    agents.delete(key)
    routes.delete(key)
    states.delete(key)
    contexts.delete(key)
  })
  ctx.on('session/event', (session: SessionLike | undefined, event: EventLike | undefined) => {
    if (session?.id === undefined || session.header?.parentSession !== undefined) return
    const key = String(session.id)
    if (event?.type === 'model/selection') {
      if (event.data?.provider !== undefined && event.data?.model !== undefined) routes.set(key, `${event.data.provider}/${event.data.model}`)
      return
    }
    if (event?.type === 'assistant/message') {
      const usage = event.data?.message?.usage ?? event.data?.usage
      if (usage !== undefined) contexts.set(key, (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0))
      return
    }
    if (event?.type !== 'tool/call' || typeof event.data?.name !== 'string') return
    const agent = agents.get(key)
    if (agent === undefined) return
    const nudge = loadSettingsSync().subagent.nudge
    if (!routeWanted(nudge.models, routes.get(key))) return
    const state = states.get(key) ?? createNudgeState()
    states.set(key, state)
    const argumentsJson = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments ?? {})
    const found = noteCall(state, { turn: event.data.turn ?? 0, name: event.data.name, arguments: argumentsJson, context: contexts.get(key) }, nudge)
    if (found === undefined) return
    // Same constraint as the codemode chain hint: this observer runs inside the
    // session's append publication, so the inject waits for a macrotask.
    const timer = setTimeout(() => {
      try {
        agent.inject({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: found.text }],
          // Never source.kind 'user': that would fake a human prompt.
          source: { kind: 'ceulen-delegation-nudge', form: 'notice', summary: `${found.kind} nudge` },
        })
        logLine('subagent', `${found.kind} nudge injected (${routes.get(key)})`)
      } catch (error) {
        logLine('subagent', `${found.kind} nudge failed: ${errorMessage(error)}`)
      }
    }, 0)
    timer.unref?.()
  })
}
