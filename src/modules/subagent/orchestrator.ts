import { AsyncResource } from 'node:async_hooks'
import type { PluginContext } from '../../core/types.js'
import { errorMessage, registerCommandSafe, registerPromptSection } from '../../core/tools.js'

const INSTRUCTIONS = `ORCHESTRATOR MODE ACTIVE
The user explicitly selected delegation. Act as the lead coordinator: scope the work, delegate execution, inspect returned evidence, and give the user the integrated result.
Use the existing delegate tool and its configured role/model routes (worker for implementation, scout for investigation, tester for checks, reviewer for independent review). Keep one bounded task per child; split only genuinely independent work. Do not recursively enable this mode in children.
Before dispatch, use todo_write to track the work. Give each child a short meaningful description, a self-contained task, working directory, allowed files/write scope, acceptance checks, and a concise feedback requirement. Respect the delegation budget and required coordination rules; never assign overlapping writes in parallel.
Keep the returned child IDs. Native subagents report back to this lead; use send_message for follow-up. While children run, do only independent coordination or verification. If only waiting remains, end the turn and let native completion notices resume you; do not poll or duplicate their work.
Review the actual child results and verification evidence before marking work complete or reporting success. Surface failures and missing results honestly; do not silently replace a failed dispatch with local implementation.
The existing /dashboard shows native children in Agents and their public output/tools in Activity. todo_write is the lead checklist, not the native Team Tasks board. Use native Team task tools only when available; never invent task rows or claim the dashboard was opened. Tell the user Esc returns from the dashboard to chat.
This mode changes coordination only: keep the lead model, approval policy, permissions, and safety requirements unchanged.`

export function installOrchestrator(ctx: PluginContext): void {
  // ponytail: native children own execution/results; this is only a per-live-agent policy switch.
  let active = new WeakSet<object>()
  // Footer indicator: the same native tuiStatus seam /Agent-mode uses.
  let paintFooter = (_on: boolean): void => {}
  // Only the lead whose state the footer reflects may clear it.
  let shown: object | undefined
  ctx.inject(['tuiStatus'], child => {
    paintFooter = AsyncResource.bind((on: boolean) => {
      try {
        child.get('tuiStatus', false)?.setField?.('ceulen:orchestrator', on ? 'Orchestrator' : undefined, {
          slot: 'left-tail', tone: 'accent',
        })
      } catch {
        // Optional display: coordination also works in headless profiles.
      }
    })
  })
  if (!registerPromptSection(ctx, {
    name: 'ceulen:orchestrator',
    order: 126,
    interpolate: false,
    text: (context = {}) => context.scope !== undefined && active.has(context.scope) ? INSTRUCTIONS : '',
  })) throw new Error('Orchestrator requires the system prompt service')
  ctx.effect(() => () => {
    active = new WeakSet<object>()
    shown = undefined
    paintFooter(false)
  })
  ctx.on('agent/disposed', (payload: { agent?: object }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    active.delete(agent)
    if (shown === agent) {
      shown = undefined
      paintFooter(false)
    }
  })

  registerCommandSafe(ctx, {
    name: 'orchestrator',
    description: 'Coordinate native subagents; optionally submit a task (on, off, status)',
    input: { hint: '[on|off|status|<task>]' },
    handler({ agent, rawInput }) {
      if (agent === undefined) return { kind: 'error', text: 'Orchestrator needs a session context.' }
      if (agent.session.header?.parentSession !== undefined) return { kind: 'error', text: 'Use /orchestrator in the lead session, not a child.' }
      const target = rawInput.trim()
      const action = target.toLowerCase()
      if (action === 'status') return { kind: 'success', text: `Orchestrator: ${active.has(agent) ? 'on' : 'off'} (this live session).\nUse /dashboard for Agents/Activity; Esc returns to chat. /subagent shows worker routes.` }
      if (action === 'off') {
        active.delete(agent)
        if (shown === agent) {
          shown = undefined
          paintFooter(false)
        }
        return { kind: 'success', text: 'Orchestrator off. Existing children are not cancelled; permissions unchanged.' }
      }
      const runtime = ctx.get('subagents', false) as { startActivation?: unknown } | undefined
      if (typeof runtime?.startActivation !== 'function' || ctx.tools.get?.('delegate', agent) === undefined) {
        return { kind: 'error', text: 'Orchestrator unavailable: the native subagent runtime and delegate tool are required.' }
      }
      const wasActive = active.has(agent)
      active.add(agent)
      shown = agent
      paintFooter(true)
      if (target !== '' && action !== 'on') {
        try {
          agent.followup({ role: 'user', content: [{ type: 'text', text: target }], source: { kind: 'user' } })
        } catch (error) {
          if (!wasActive) {
            active.delete(agent)
            if (shown === agent) {
              shown = undefined
              paintFooter(false)
            }
          }
          return { kind: 'error', text: `Task was not queued: ${errorMessage(error)}` }
        }
      }
      return { kind: 'success', text: `Orchestrator on for this live session.${target !== '' && action !== 'on' ? ' Task queued for the lead to delegate.' : ' Send your task in chat, or use /orchestrator <task>.'}\nMonitor /dashboard (Agents/Activity); Esc returns to chat. /orchestrator off exits the mode.` }
    },
  })
}
