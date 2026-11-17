import { AsyncResource } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadSettingsSync, routeBase } from '../../core/settings.js'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { errorMessage, registerCommandSafe, registerPromptSection } from '../../core/tools.js'

export const name = 'ceulen-agent-mode'
export const inject = ['commands', 'systemPrompt']

interface Route {
  readonly provider: string
  readonly model: string
}

export function apply(ctx: PluginContext, config: { path?: string } = {}): void {
  const path = config.path ?? join(homedir(), 'vietdo_workspace/DHS/agent_mode/AGENTS.md')
  // ponytail: activation-local state, like /ponytail; restart starts inactive.
  let instructions = ''
  // undefined follows the configured model routes; an explicit command wins.
  let explicit: boolean | undefined
  let route: Route | undefined
  let mainSessionId: string | undefined
  let paintFooter = (): void => {}
  ctx.inject(['tuiStatus'], child => {
    // The TUI requires writes in this child activation, even from commands.
    paintFooter = AsyncResource.bind(() => {
      try {
        child.get('tuiStatus', false)?.setField?.('ceulen:agent-mode', instructions ? 'Agent Mode' : undefined, {
          slot: 'left-tail', tone: 'accent',
        })
      } catch {
        // Optional display: the role also works in headless profiles.
      }
    })
    paintFooter()
  })
  ctx.effect(() => () => {
    instructions = ''
    explicit = undefined
    route = undefined
    mainSessionId = undefined
    paintFooter()
  })
  if (!registerPromptSection(ctx, {
    name: 'ceulen:agent-mode',
    order: 125,
    interpolate: false,
    text: () => instructions,
  })) throw new Error('Agent Mode requires the system prompt service')

  const readRole = (): string => {
    const role = readFileSync(path, 'utf8').trim()
    if (!role) throw new Error('Role file is empty')
    return `AGENT MODE ACTIVE\nRole source: ${path}\nThese role instructions do not change permissions or override safety requirements.\n\n${role}`
  }

  /** Follow `agentMode.models` until the user answers explicitly with on/off. */
  const followRoute = (): void => {
    if (explicit !== undefined) return
    const key = route === undefined ? '' : `${route.provider}/${route.model}`
    const wanted = key !== '' && loadSettingsSync().agentMode.models.some(entry => routeBase(entry) === key)
    if (wanted) {
      try {
        instructions = readRole()
      } catch {
        // Auto-activation stays silent: a missing role file leaves the mode off.
        instructions = ''
      }
    } else instructions = ''
    paintFooter()
  }

  // Session modes are activation-local: a resumed or new lead re-evaluates its route.
  ctx.on('agent/created', (payload: { agent?: AgentLike } | undefined) => {
    const agent = payload?.agent
    if (agent === undefined || agent.session?.header?.parentSession !== undefined) return
    mainSessionId = agent.session?.id
    // A resumed session keeps its durable selection, which outranks options.
    const current = agent.model?.current?.()
    const provider = current?.provider ?? agent.options?.provider
    const model = current?.model ?? agent.options?.model
    route = provider !== undefined && model !== undefined ? { provider, model } : undefined
    followRoute()
  })
  ctx.on('session/event', (session: { id?: string } | undefined, event: { type?: string; data?: { provider?: string; model?: string } } | undefined) => {
    if (event?.type !== 'model/selection') return
    if (mainSessionId !== undefined && session?.id !== undefined && session.id !== mainSessionId) return
    const provider = event.data?.provider
    const model = event.data?.model
    if (provider === undefined || model === undefined) return
    route = { provider, model }
    followRoute()
  })

  registerCommandSafe(ctx, {
    // The host only accepts lower-case command names.
    name: 'agent-mode',
    description: 'Load your translation/localization AGENTS.md role (on, off, status)',
    input: { hint: '[on|off|status]' },
    handler({ rawInput }) {
      const action = rawInput.trim().toLowerCase()
      if (action === 'status') {
        const source = explicit === undefined ? ' (model default)' : ''
        return { kind: 'success', text: `Agent Mode: ${instructions ? 'on' : 'off'}${source}\nRole: ${path}` }
      }
      if (action === 'off') {
        explicit = false
        instructions = ''
        paintFooter()
        return { kind: 'success', text: 'Agent Mode off. Role instructions removed; permissions unchanged.' }
      }
      if (action !== '' && action !== 'on') {
        return { kind: 'error', text: 'Usage: /agent-mode [on|off|status]' }
      }
      try {
        instructions = readRole()
        explicit = true
        return { kind: 'success', text: `Agent Mode on. Loaded ${path}.\nUse /agent-mode off to leave; run /agent-mode again to reload edits. Permissions unchanged.` }
      } catch (error) {
        explicit = true
        instructions = ''
        return { kind: 'error', text: `Agent Mode off: cannot load ${path}: ${errorMessage(error)}` }
      } finally {
        paintFooter()
      }
    },
  })
}
