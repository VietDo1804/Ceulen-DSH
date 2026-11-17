import { stripVTControlCharacters } from 'node:util'

/** Narrow, read-only views of the host channel. No runtime/TUI dependency. */
export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}
export interface Task {
  id: string
  subject: string
  description?: string
  status: string
  ownerName?: string
  blockedBy: readonly string[]
  writeScopes: readonly string[]
  writeScopeWarnings: readonly string[]
  ready: boolean
}
export interface Team {
  enabled?: boolean
  failure?: string
  tasks: readonly Task[]
}
export interface ToolCall {
  name: string
  status: string
  startedAt: number
}
export interface Child {
  agentId: string
  sessionId?: string
  runId?: string
  name?: string
  description?: string
  provider?: string
  model?: string
  status: string
  startedAt?: number
  endedAt?: number
  completedAt?: number
  reportedDurationMs?: number
  lastTool?: string
  toolCalls?: readonly { name: string; status: string; startedAt: number }[]
  outputEvents?: readonly { kind: string; text: string; at: number }[]
  tokens?: { input?: number; output?: number; total?: number }
  settledRuns?: readonly { runId?: string; status: string }[]
}
export interface DashboardChannel {
  sessionId: string
  agentId?: string
  agentBindingGeneration?: number
  provider?: string
  model?: string
  status?: string
  lastUserText?: string
  /** Native `channel.todos` (TodoPanelItem): the session's current checklist. */
  todos?: readonly Todo[]
  team?: Team
  tokens?: { input?: number; output?: number }
  subagents?: readonly Child[]
  rows?: readonly { id: number; kind: string; tool?: { name: string; status: string; startedAt?: number } }[]
  agentViewRows?(): readonly { id: string; status: string }[]
  subscribe?(listener: () => void): () => void
  subscribeAgentView?(listener: () => void): () => void
}
export interface Item {
  id: string
  title: string
  status: string
  meta: string
  detail: readonly string[]
  tokens?: { input?: number; output?: number }
  /** All bounded native tool calls; the scene shows at most three per block. */
  tools: readonly ToolCall[]
  /** Public text output only, bounded; never thinking or raw tool payloads. */
  activity: readonly string[]
}
export interface Dashboard {
  sessionId: string
  lead: string
  failure?: string
  needsInput: boolean
  /** Native session checklist (`channel.todos`), namespaced under session. */
  sessionTasks: readonly Item[]
  /** Native Team task board, namespaced under team. */
  teamTasks: readonly Item[]
  sessionCount: { done: number; total: number }
  teamCount: { done: number; total: number }
  /** lastUserText fallback, shown only while no checklist exists. */
  request?: string
  /** Lead root plus only the native children of this session. */
  workflow: { lead: Item; children: readonly Item[] }
}

/** Host Text owns Unicode cell measurement/truncation; strip control bytes first. */
export function clean(value: unknown, limit = 1000): string {
  return stripVTControlCharacters(String(value ?? '—')).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, limit)
}
function route(provider?: string, model?: string): string {
  return `${clean(provider)}/${clean(model)}`
}
export function compactTokens(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}
/** Compact line for a block; an unknown field stays `—`, a real zero stays `0`. */
export function tokenLine(tokens?: { input?: number; output?: number }): string {
  return `IN ${compactTokens(tokens?.input)} / OUT ${compactTokens(tokens?.output)}`
}
/** Exact line for detail; per source, never a parent/child sum. */
export function exactTokens(tokens?: { input?: number; output?: number }): string {
  return `input ${tokens?.input ?? '—'} / output ${tokens?.output ?? '—'}`
}
/**
 * Display order for one block: running calls first, then the most recent.
 * This is UI truncation only; the projection keeps the bounded native history.
 */
export function visibleTools(tools: readonly ToolCall[], max = 3): { shown: readonly ToolCall[]; overflow: number } {
  const order = [...tools].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
  const shown = order.slice(0, Math.max(0, max))
  return { shown, overflow: Math.max(0, order.length - shown.length) }
}
function detailTools(tools: readonly ToolCall[]): string[] {
  const { shown } = visibleTools(tools, 40)
  return shown.length === 0 ? ['Tools: none reported.'] : ['Tools (newest first, max 40):', ...shown.map(tool => `  ${clean(tool.name)} · ${clean(tool.status)} · ${tool.startedAt}`)]
}
function publicActivity(events: readonly { kind: string; text: string; at: number }[] | undefined): string[] {
  return (events ?? []).filter(event => event.kind === 'text').slice(-10).map(event => clean(event.text, 400))
}
function activityDetail(activity: readonly string[]): string[] {
  return activity.length === 0 ? ['Public activity: none reported.'] : [`Public activity (last ${activity.length}):`, ...activity.map(line => `  ${line}`)]
}
const NO_PRIVATE = 'Arguments, raw results, and thinking are not shown.'
const countOf = (items: readonly Item[]): { done: number; total: number } => ({ done: items.filter(item => item.status === 'completed').length, total: items.length })

export function project(channel: DashboardChannel, now = Date.now()): Dashboard {
  const team = channel.team
  const children = channel.subagents ?? []
  const relevant = new Set([channel.sessionId, ...children.map(child => child.sessionId).filter(id => id !== undefined)])
  const needsInput = (channel.agentViewRows?.() ?? []).some(row => relevant.has(row.id) && row.status === 'needs-input')

  const sessionTasks: Item[] = (channel.todos ?? []).map((todo, index) => ({
    id: `session:${index}`,
    title: clean(todo.content),
    status: todo.status,
    meta: 'session checklist',
    detail: ['Source: session checklist (todo_write)', `Status: ${todo.status}`, `Checklist item ${index + 1} of ${channel.todos?.length ?? 0}.`, 'The native checklist has no description or owner.'],
    tools: [], activity: [],
  }))
  const teamTasks: Item[] = (team?.tasks ?? []).map(task => ({
    id: `team:${task.id}`,
    title: clean(task.subject),
    status: clean(task.status),
    meta: `team board · owner ${clean(task.ownerName)} · ${task.ready ? 'ready' : 'not ready'}${task.writeScopeWarnings.length ? ' · scope warning' : ''}`,
    detail: ['Source: native Team task board', clean(task.description), `Owner: ${clean(task.ownerName)}`, `Ready: ${task.ready}`, `Blockers: ${task.blockedBy.map(id => clean(id)).join(', ') || 'none'}`, `Write scopes: ${task.writeScopes.map(scope => clean(scope)).join(', ') || '—'}`, ...task.writeScopeWarnings.map(warning => `WARNING: ${clean(warning)}`)],
    tools: [], activity: [],
  }))
  const request = sessionTasks.length === 0 && typeof channel.lastUserText === 'string' && channel.lastUserText.trim() !== ''
    ? clean(channel.lastUserText, 2000)
    : undefined

  const leadTools: ToolCall[] = (channel.rows ?? []).filter(row => row.kind === 'tool' && row.tool !== undefined).slice(-200)
    .map(row => ({ name: clean(row.tool?.name), status: clean(row.tool?.status), startedAt: row.tool?.startedAt ?? 0 }))
  const lead: Item = {
    id: `lead:${channel.sessionId}`,
    title: 'Lead',
    status: clean(channel.status ?? 'unknown'),
    meta: `${tokenLine(channel.tokens)} · ${route(channel.provider, channel.model)}`,
    detail: ['Source: Lead of this session', `Session: ${clean(channel.sessionId)}`, `Route: ${route(channel.provider, channel.model)}`, `Status: ${clean(channel.status ?? 'unknown')}`, `Tokens: ${exactTokens(channel.tokens)}`, ...detailTools(leadTools), 'Public activity: only native tool projections are read for the Lead.', NO_PRIVATE],
    ...(channel.tokens === undefined ? {} : { tokens: channel.tokens }),
    tools: leadTools, activity: [],
  }
  const workflowChildren: Item[] = children.map(child => {
    const lastTool = child.lastTool ?? child.toolCalls?.at(-1)?.name
    const end = child.endedAt ?? child.completedAt ?? (child.status === 'running' || child.status === 'starting' ? now : undefined)
    const duration = child.reportedDurationMs ?? (child.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - child.startedAt))
    const tools: ToolCall[] = (child.toolCalls ?? []).slice(-200).map(tool => ({ name: clean(tool.name), status: clean(tool.status), startedAt: tool.startedAt }))
    const activity = publicActivity(child.outputEvents)
    return {
      id: `${child.agentId}:${child.runId ?? 'unknown'}`,
      title: clean(child.name ?? child.description ?? child.agentId),
      status: clean(child.status ?? 'unknown'),
      meta: `${tokenLine(child.tokens)} · ${route(child.provider, child.model)}${duration === undefined ? '' : ` · ${Math.floor(duration / 1000)}s`}`,
      detail: [`Agent: ${clean(child.agentId)}`, `Session: ${clean(child.sessionId)}`, `Run: ${clean(child.runId)}`, clean(child.description), `Route: ${route(child.provider, child.model)}`, `Status: ${clean(child.status ?? 'unknown')}`, `Last tool: ${clean(lastTool)}`, `Tokens: ${exactTokens(child.tokens)}`, ...detailTools(tools), ...(child.settledRuns ?? []).slice(-20).map(run => `Previous run ${clean(run.runId)}: ${clean(run.status)}`), ...activityDetail(activity), NO_PRIVATE],
      ...(child.tokens === undefined ? {} : { tokens: child.tokens }),
      tools, activity,
    }
  })

  return {
    sessionId: channel.sessionId,
    lead: `Lead · ${tokenLine(channel.tokens)} · ${route(channel.provider, channel.model)} · ${clean(channel.status ?? 'unknown')}`,
    ...(team?.failure ? { failure: `Team projection failed (last valid board): ${clean(team.failure)}` } : {}),
    needsInput,
    sessionTasks,
    teamTasks,
    sessionCount: countOf(sessionTasks),
    teamCount: countOf(teamTasks),
    ...(request === undefined ? {} : { request }),
    workflow: { lead, children: workflowChildren },
  }
}

export function summary(view: Dashboard): string {
  const tasks = [
    ...view.sessionTasks.map(task => `[S] [${task.status}] ${task.title} · ${task.meta}`),
    ...view.teamTasks.map(task => `[T] [${task.status}] ${task.title} · ${task.meta}`),
  ]
  return [
    `Dashboard · session ${clean(view.sessionId)}`,
    view.lead,
    view.failure,
    `Tasks · session ${view.sessionCount.done}/${view.sessionCount.total} · team ${view.teamCount.done}/${view.teamCount.total}`,
    ...tasks,
    view.request === undefined ? undefined : `Current request (no checklist): ${view.request}`,
    `Workflow · Lead [${view.workflow.lead.status}]`,
    ...view.workflow.children.map(child => `[child] [${child.status}] ${child.title} · ${child.meta}`),
    'Source: native DSH projections; no parent/child usage aggregation.',
  ].filter(line => line !== undefined).join('\n')
}

/** Every listener belongs to one mount, including the separate agent-view feed. */
export function watch(channel: DashboardChannel, listener: () => void): () => void {
  const off = channel.subscribe?.(listener)
  let offAgents: (() => void) | undefined
  try {
    offAgents = channel.subscribeAgentView?.(listener)
  } catch (error) {
    off?.()
    throw error
  }
  return () => { off?.(); offAgents?.() }
}
