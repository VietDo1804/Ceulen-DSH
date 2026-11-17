import type { AgentLike, MessageLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { errorMessage, registerCommandSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { latestTodos, type TodoItem } from '../todoview/index.js'
import { clean, project, summary, type Child, type Team } from './model.js'
import { createDashboardScene } from './scene.js'

export const name = 'ceulen-dashboard'
export const inject = ['commands']
export const SCENE_ID = 'ceulen-dashboard'
interface Scenes {
  register(scene: { id: string; title: string; component: unknown }): () => void
  open(id: string): boolean
}
interface CatalogEntry { id: string; label?: string; createdAt?: number }
type RawTeam = Omit<Team, 'tasks'> & { tasks: readonly (Team['tasks'][number] & { owner?: unknown })[] }

/** The newest user message text, used only while the session has no checklist. */
function lastUserText(messages: readonly MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined || message.role !== 'user') continue
    const text = message.content
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: unknown }).text)
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    if (text.trim() !== '') return text
  }
  return undefined
}

/** Headless reads the same native projections and transcript, not a cached scene or tool prose. */
async function status(ctx: PluginContext, agent: AgentLike, signal?: AbortSignal): Promise<string> {
  const notes: string[] = []
  let team: Team | undefined
  let children: Child[] = []
  let todos: TodoItem[] | undefined
  let request: string | undefined
  try {
    const projections = ctx.get('sessionProjections', false) as { snapshot?(session: unknown, keys: readonly string[]): { values: Record<string, unknown> } } | undefined
    const raw = projections?.snapshot?.(agent.session, ['agentTeam']).values.agentTeam as RawTeam | undefined
    if (raw !== undefined && Array.isArray(raw.tasks)) team = { ...raw, tasks: raw.tasks.map(task => ({ ...task, ownerName: typeof task.ownerName === 'string' ? task.ownerName : typeof task.owner === 'string' ? task.owner : undefined })) }
    else notes.push('Team projection unavailable in this composition.')
  } catch { notes.push('Team projection read failed; board is unavailable.') }
  if (agent.session.deriveMessages === undefined) notes.push('Session transcript unavailable; the checklist was not read.')
  else {
    try {
      const messages = agent.session.deriveMessages()
      todos = latestTodos(messages)
      request = lastUserText(messages)
      if (todos === undefined) notes.push('No session checklist (todo_write) in this session log.')
    } catch { notes.push('Session transcript read failed; the checklist was not read.') }
  }
  try {
    const service = ctx.get('subagents', false) as {
      listChildren?(id: string, signal?: AbortSignal): Promise<readonly CatalogEntry[]>
      listDescendants?(id: string, signal?: AbortSignal): Promise<readonly (CatalogEntry & { kind: string; parentId: string })[]>
    } | undefined
    const entries = service?.listChildren !== undefined ? await service.listChildren(agent.session.id, signal)
      : service?.listDescendants !== undefined ? (await service.listDescendants(agent.session.id, signal)).filter(child => child.kind === 'child' && child.parentId === agent.session.id) : undefined
    if (entries === undefined) notes.push('Native child catalog unavailable.')
    else children = entries.map(child => ({ agentId: child.id, sessionId: child.id, description: child.label, status: 'unknown' }))
  } catch { notes.push('Native child catalog read failed.') }
  const selection = agent.model?.current?.() ?? agent.options
  const view = project({ sessionId: agent.session.id, provider: selection.provider, model: selection.model, status: agent.status, team, subagents: children, todos, lastUserText: request })
  return `${summary(view)}\nHeadless catalog: child run/status/route/usage require the live TUI channel.\n${notes.join('\n')}`.trim()
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('dashboard', loadSettingsSync())) return
  let scenes: Scenes | undefined
  const register = (child: PluginContext): void => {
    if (scenes !== undefined) return
    const service = child.get('tuiScenes', false) as Scenes | undefined
    if (typeof service?.register !== 'function' || typeof service.open !== 'function') return
    const dispose = service.register({ id: SCENE_ID, title: 'Native Tasks & Workflow', component: createDashboardScene() })
    scenes = service
    child.effect(() => () => { dispose(); scenes = undefined }, 'ceulen dashboard scene')
  }
  try { ctx.inject(['tuiScenes'], register) }
  catch (error) { logLine('dashboard', `scene injection unavailable: ${errorMessage(error)}`) }

  registerCommandSafe(ctx, {
    name: 'dashboard',
    description: 'Native same-session checklist/workflow dashboard; status prints a headless summary',
    input: { hint: '[status]' },
    async handler({ agent, rawInput, signal }) {
      if (agent === undefined) return { kind: 'error', text: 'dashboard needs a session context' }
      const input = rawInput.trim()
      if (input !== '' && input !== 'status') return { kind: 'error', text: 'Usage: /dashboard [status]' }
      try {
        if (input === 'status') return { kind: 'success', text: await status(ctx, agent, signal) }
        if (scenes === undefined) register(ctx)
        if (scenes?.open(SCENE_ID) === true) return { kind: 'success', text: '' }
        return { kind: 'error', text: 'Native dashboard scene unavailable. Use /dashboard status; a TUI host with tuiScenes is required.' }
      } catch (error) {
        return { kind: 'error', text: `Dashboard unavailable: ${clean(errorMessage(error))}. Use /dashboard status.` }
      }
    },
  })
}
