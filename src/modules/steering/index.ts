import type { AgentLike, PluginContext, UserMessageLike } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { clampText, registerCommandSafe, registerPromptSection } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { randomUUID } from 'node:crypto'

export const name = 'ceulen-steering'

export const inject = ['commands', 'systemPrompt']

const GUIDANCE = `Model steering (Ceulen):
- Act with tools early: a short intent line, then the first call. Do not narrate a plan you can execute.
- After a failed command, read the error and change the approach. Never repeat an identical failing call; vary the command or inspect the precondition.
- Keep reasoning internal. The user needs the finding and the action, not a transcript of deliberation.
- DeepSeek routes: prefer concrete file/tool evidence over recalling APIs; verify a symbol exists before editing.
- GLM routes: honor the selected thinking level; do not compensate for a low level with long prose.
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

  registerPromptSection(ctx, {
    name: 'ceulen:steering',
    order: 85,
    text: GUIDANCE,
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
          return { kind: 'error', text: `steer failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return { kind: 'success', text: 'Steered: delivered at the next step boundary, before the next LLM call.' }
    },
  })
}
