import { AsyncResource } from 'node:async_hooks'
import type { PluginContext } from '../../core/types.js'
import { errorMessage, registerCommandSafe, registerPromptSection } from '../../core/tools.js'

const INSTRUCTIONS = `ORCHESTRATOR MODE ACTIVE
The user explicitly selected delegation. Act as the lead coordinator: scope the work, keep the todo list current, delegate execution, inspect returned evidence, and give the user the integrated result.
Use the existing delegate tool and its configured role/model routes (worker for implementation, scout for investigation, tester for checks, reviewer for independent review). Scope the work, then delegate even a small execution task to exactly one worker by default. Keep one bounded task per child; split only genuinely independent work. Do not recursively enable this mode in children.
The Lead coordinates and verifies; it does not duplicate a child's work. Before dispatch, use todo_write. Give each child a short meaningful description, a self-contained task, working directory, allowed files/write scope, acceptance checks, and a concise feedback requirement. Respect the delegation budget and coordination rules; never assign overlapping writes in parallel.
Keep the returned child IDs. Native subagents report back to this lead; use send_message for follow-up. While children run, do only independent coordination or verification. If only waiting remains, end the turn and let native completion notices resume you; do not poll or duplicate their work.
Review the actual child results and verification evidence before marking work complete or reporting success. On an explicit worker issue or an invalid/missing result, make one targeted repair or reassignment through the existing routes. Only after that targeted attempt fails may you implement the missing piece locally, and explain why. Surface failures and missing results honestly.
An unavailable dispatch or an exhausted delegation budget is not blanket permission to bypass the task's approval policy, permissions, or safety requirements; report the limit instead. Do not poll and never enter a recursive orchestration mode.
/dashboard shows the session checklist and the native workflow (Lead plus current-session children); Team tasks and their actual owners stay a separate source. It shows no tool arguments, raw results, or thinking. Tell the user Esc returns from the dashboard to chat.
This mode changes coordination only: keep the lead model, approval policy, permissions, and safety requirements unchanged.`

export function installOrchestrator(ctx: PluginContext): void {
  // ponytail: native children own execution/results; this is only a per-live-agent policy switch.
  let active = new WeakSet<object>()
  // Footer indicator: the same native tuiStatus seam /agent-mode uses.
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
  const deactivate = (agent: object): void => {
    active.delete(agent)
    if (shown !== agent) return
    shown = undefined
    paintFooter(false)
  }
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
    deactivate(agent)
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
      if (action === 'status') return { kind: 'success', text: `Orchestrator: ${active.has(agent) ? 'on' : 'off'} (this live session).\nUse /dashboard for the session checklist and native workflow; Esc returns to chat. /subagent shows worker routes.` }
      if (action === 'off') {
        deactivate(agent)
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
          if (!wasActive) deactivate(agent)
          return { kind: 'error', text: `Task was not queued: ${errorMessage(error)}` }
        }
      }
      return { kind: 'success', text: `Orchestrator on for this live session.${target !== '' && action !== 'on' ? ' Task queued for the lead to delegate.' : ' Send your task in chat, or use /orchestrator <task>.'}\nMonitor /dashboard (Tasks/Workflow); Esc returns to chat. /orchestrator off exits the mode.` }
    },
  })
}
