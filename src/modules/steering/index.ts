import type { AgentLike, PluginContext, UserMessageLike } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { clampText, registerCommandSafe, registerPromptSection, errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { agentRoute, routeWanted } from '../../core/route.js'
import { randomUUID } from 'node:crypto'
import { askedVerbatim, lookupReplacements, redirectText } from './bash-search.js'
import { captureRedirectText, chromeScreenshotCalls } from './bash-capture.js'
import { PLAYBOOK } from './playbook.js'
import { heldToolsNote, installRouteVariants } from '../../core/variants.js'
import { userTextOf, UserWords } from '../../core/user-words.js'

export const name = 'ceulen-steering'

export const inject = ['commands', 'systemPrompt']

/** True when `agent` runs on a route listed in `steering.models`. */
function steeredRoute(agent: unknown): boolean {
  return routeWanted(loadSettingsSync().steering.models, agentRoute(agent as Partial<AgentLike> | undefined))
}

/** The playbook's delegation advice is for leads; children do not delegate. */
function steeredLead(agent: unknown): boolean {
  const lead = agent as Partial<AgentLike> | undefined
  return lead !== undefined && lead.session?.header?.parentSession === undefined && steeredRoute(lead)
}

// One text for every route: a prompt section cannot see the selected model,
// so a line addressed to one model family would be read by all of them.
const GUIDANCE = `Model steering (Ceulen):
- Act with tools early: a short intent line, then the first call. Do not narrate a plan you can execute.
- After a failed command, read the error and change the approach. Never repeat an identical failing call; vary the command or inspect the precondition.
- Keep reasoning internal. The user needs the finding and the action, not a transcript of deliberation.
- Prefer concrete file/tool evidence over recalling APIs; verify a symbol exists before editing.
- Honor the selected thinking level; do not compensate for a low level with long prose.
- When a tool result is truncated, narrow the query instead of re-running it unchanged.`

export function sessionMovedOn(agent: AgentLike, reviewedSeq: number | undefined): boolean {
  if (reviewedSeq === undefined) return false
  const current = agent.session.seq
  return typeof current === 'number' && current !== reviewedSeq
}

const lastShelved = new Map<string, { summary: string; at: number }>()

/**
 * Park a late note (e.g. a slow advisor review that landed after the user
 * already sent a new prompt) as a harness follow-up: it is delivered after
 * the agent finishes the current task instead of being injected mid-task
 * where the new prompt buries it. Pi `follow_up` semantics; the harness
 * owns the queue, this shelf only remembers what was parked for `/steer`.
 */
export function shelveLateNote(agent: AgentLike, message: UserMessageLike, summary: string): boolean {
  const sid = String(agent.session.id)
  try {
    agent.followup(message)
  } catch {
    try {
      agent.followup({ ...message, source: { kind: 'user' } })
    } catch {
      return false
    }
  }
  lastShelved.set(sid, { summary: clampText(summary, 140), at: Date.now() })
  logLine('steering', `shelved late note for ${sid}: ${summary}`)
  return true
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('steering', settings)) return
  // Tuned tool definitions and steering.cold for the steered routes only.
  installRouteVariants(ctx)

  registerPromptSection(ctx, {
    name: 'ceulen:steering',
    order: 85,
    text: GUIDANCE,
  })

  // Evaluated per request with the live agent as scope, so a /model switch
  // adds or drops it; the text itself never varies, which keeps the cache warm.
  registerPromptSection(ctx, {
    name: 'ceulen:playbook',
    order: 86,
    interpolate: false,
    text: (context = {}) => steeredLead(context.scope) ? PLAYBOOK : '',
  })

  // For an agent that holds `steering.cold` tools: which ones, and the way in.
  // The text changes only when the agent's route or the held set does.
  registerPromptSection(ctx, {
    name: 'ceulen:held-tools',
    order: 87,
    interpolate: false,
    text: (context = {}) => heldToolsNote(context.scope),
  })

  // Nested codemode calls run through the same pipeline, so this sees
  // `tools.bash(...)` inside scripts as well as direct bash calls. A command
  // re-issued unchanged after a redirect runs: the model has a reason the
  // dedicated tool cannot cover (a binary file, a pattern ripgrep rejects…).
  const redirected = new Map<string, Set<string>>()
  // A command the user typed out themselves is not redirected: only real user
  // messages and delegation briefs count (core/user-words.ts), never tool output.
  const words = new UserWords()
  ctx.on('session/event', (session: { id?: unknown; header?: { parentSession?: string } } | undefined, event: { type?: string; data?: unknown } | undefined) => {
    if (event?.type !== 'agent/inbox/spliced' || session?.id === undefined) return
    const text = userTextOf(event.data, session.header?.parentSession !== undefined)
    if (text !== undefined) words.request(String(session.id), text)
  })
  ctx.on('agent/disposed', (payload: { agent?: AgentLike } | undefined) => {
    const id = payload?.agent?.session?.id
    if (id === undefined) return
    redirected.delete(String(id))
    words.forget(String(id))
  })
  ctx.on('tools/pre-execute', async (exec: { name?: string; arguments?: unknown; agent?: unknown }, next: () => Promise<unknown>) => {
    if (exec?.name !== 'bash') return next()
    try {
      if (loadSettingsSync().steering.bashLookups !== 'redirect' || !steeredRoute(exec.agent)) return next()
      const input = typeof exec.arguments === 'string' ? JSON.parse(exec.arguments) as unknown : exec.arguments
      const command = (input as { command?: unknown } | undefined)?.command
      if (typeof command !== 'string') return next()
      const calls = lookupReplacements(command)
      const shot = calls === undefined ? chromeScreenshotCalls(command) : undefined
      if (calls === undefined && shot === undefined) return next()
      const session = String((exec.agent as Partial<AgentLike> | undefined)?.session?.id ?? '')
      if (askedVerbatim(words.get(session).request, command)) {
        logLine('steering', `bash ${shot === undefined ? 'lookup' : 'screenshot'} named by the user, allowed: ${clampText(command, 160)}`)
        return next()
      }
      const seen = redirected.get(session) ?? new Set<string>()
      if (seen.has(command)) {
        logLine('steering', `bash ${shot === undefined ? 'lookup' : 'screenshot'} re-issued, allowed: ${clampText(command, 160)}`)
        return next()
      }
      seen.add(command)
      redirected.set(session, seen)
      if (shot !== undefined) {
        logLine('steering', `bash screenshot redirected: ${clampText(command, 160)} → ${shot.map(call => call.call).join(' | ').slice(0, 200)}`)
        return { kind: 'deny', reason: captureRedirectText(command, shot) }
      }
      logLine('steering', `bash lookup redirected: ${clampText(command, 160)} → ${calls!.map(call => call.call).join(' | ').slice(0, 200)}`)
      return { kind: 'deny', reason: redirectText(command, calls!) }
    } catch (error) {
      logLine('steering', `bash lookup check failed: ${errorMessage(error)}`)
      return next()
    }
  })

  registerCommandSafe(ctx, {
    name: 'steering',
    description: 'Show the model-family steering guidance',
    handler() {
      return {
        kind: 'success',
        text: `Steering is active (prompt order 85).\n\n${GUIDANCE}\n\nDSH owns reasoning levels, reasoning stripping, and its own provider error taxonomy; only Ceulen-specific hints are ported.`,
      }
    },
  })

  registerCommandSafe(ctx, {
    name: 'steer',
    description: 'Steer the running agent (next step boundary) or show the parked-note shelf',
    input: { hint: '[text|status|clear]' },
    handler({ agent, rawInput }) {
      const text = rawInput.trim()
      if (text === '' || text === 'status') {
        const entries = [...lastShelved.entries()].map(
          ([sid, note]) => `${sid}: ${note.summary} (parked ${new Date(note.at).toLocaleTimeString()})`,
        )
        return {
          kind: 'success',
          text: entries.length > 0
            ? `Steer shelf (delivered as follow-up once the current task finishes):\n${entries.join('\n')}`
            : 'Steer shelf is empty. Late advisor notes park here when they arrive after a new prompt.',
        }
      }
      if (text === 'clear') {
        lastShelved.clear()
        return { kind: 'success', text: 'Steer shelf record cleared. (Harness-queued delivery, if any, still stands.)' }
      }
      if (agent === undefined) return { kind: 'error', text: 'usage: /steer <text> needs an agent context (run it inside a session)' }
      const message: UserMessageLike = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'ceulen-steer', form: 'steer', summary: clampText(text, 120) },
      }
      try {
        agent.steer(message)
      } catch {
        try {
          agent.steer({ ...message, source: { kind: 'user' } })
        } catch (error) {
          return { kind: 'error', text: `steer failed: ${errorMessage(error)}` }
        }
      }
      return { kind: 'success', text: 'Steered: delivered at the next step boundary, before the next LLM call.' }
    },
  })
}
