import { stripVTControlCharacters } from 'node:util'

/** Narrow, read-only views of the host channel. No runtime/TUI dependency. */
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
  members?: readonly { id: string; name: string; role: string; phase: string }[]
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
  /** Native start time when the host reported one; 0/absent means unknown. */
  at?: number
}
export interface Dashboard {
  sessionId: string
  lead: string
  warning?: string
  failure?: string
  needsInput: boolean
  taskCount: string
  tasks: readonly Item[]
  agents: readonly Item[]
  activity: readonly Item[]
  /** Per-source parent usage exactly as the channel reported it, never summed. */
  tokens?: { input?: number; output?: number }
}

/** Host Text owns Unicode cell measurement/truncation; strip control bytes first. */
export function clean(value: unknown, limit = 1000): string {
  return stripVTControlCharacters(String(value ?? '—')).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, limit)
}
function route(provider?: string, model?: string): string {
  return `${clean(provider)}/${clean(model)}`
}
function usage(tokens?: { input?: number; output?: number }): string {
  return tokens === undefined ? 'usage —' : `in ${tokens.input ?? '—'} / out ${tokens.output ?? '—'}`
}

export function project(channel: DashboardChannel, now = Date.now()): Dashboard {
  const team = channel.team
  const children = channel.subagents ?? []
  const relevant = new Set([channel.sessionId, ...children.map(child => child.sessionId).filter(id => id !== undefined)])
  const needsInput = (channel.agentViewRows?.() ?? []).some(row => relevant.has(row.id) && row.status === 'needs-input')
  const tasks = (team?.tasks ?? []).map(task => ({
    id: task.id,
    title: clean(task.subject),
    status: clean(task.status),
    meta: `owner ${clean(task.ownerName)} · ${task.ready ? 'ready' : 'not ready'}${task.writeScopeWarnings.length ? ' · scope warning' : ''}`,
    detail: [clean(task.description), `Owner: ${clean(task.ownerName)}`, `Ready: ${task.ready}`, `Blockers: ${task.blockedBy.map(id => clean(id)).join(', ') || 'none'}`, `Write scopes: ${task.writeScopes.map(scope => clean(scope)).join(', ') || '—'}`, ...task.writeScopeWarnings.map(warning => `WARNING: ${clean(warning)}`)],
  }))
  const agents: Item[] = children.map(child => {
    const lastTool = child.lastTool ?? child.toolCalls?.at(-1)?.name
    const end = child.endedAt ?? child.completedAt ?? (child.status === 'running' || child.status === 'starting' ? now : undefined)
    const duration = child.reportedDurationMs ?? (child.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - child.startedAt))
    return {
      id: `${child.agentId}:${child.runId ?? 'unknown'}`,
      title: clean(child.name ?? child.description ?? child.agentId),
      status: clean(child.status ?? 'unknown'),
      meta: `${route(child.provider, child.model)} · tool ${clean(lastTool)} · ${duration === undefined ? 'duration —' : `${Math.floor(duration / 1000)}s`} · ${usage(child.tokens)}`,
      detail: [`Agent: ${clean(child.agentId)}`, `Session: ${clean(child.sessionId)}`, `Run: ${clean(child.runId)}`, clean(child.description), `Route: ${route(child.provider, child.model)}`, `Last tool: ${clean(lastTool)}`, usage(child.tokens), ...(child.settledRuns ?? []).slice(-20).map(run => `Previous run ${clean(run.runId)}: ${clean(run.status)}`)],
    }
  })
  for (const member of team?.members ?? []) {
    if (member.id === channel.sessionId || member.role === 'lead' || children.some(child => child.sessionId === member.id)) continue
    agents.push({ id: member.id, title: clean(member.name), status: 'unknown', meta: `${clean(member.role)} · phase ${clean(member.phase)} · route —`, detail: [`Session: ${clean(member.id)}`, 'No native run snapshot available.'] })
  }
  const activity: (Item & { at: number })[] = []
  for (const row of (channel.rows ?? []).slice(-200)) {
    if (row.kind !== 'tool' || row.tool === undefined) continue
    activity.push({ id: `lead:${row.id}`, title: clean(row.tool.name), status: clean(row.tool.status), meta: 'lead · tool', detail: ['Source: lead', `Tool: ${clean(row.tool.name)}`, `Status: ${clean(row.tool.status)}`, 'Arguments and raw results are not shown.'], at: row.tool.startedAt ?? 0 })
  }
  for (const child of children) {
    // ponytail: use bounded native previews, never fold transcripts or show thinking/tool arguments.
    for (const [index, event] of (child.outputEvents ?? []).slice(-200).entries()) {
      if (event.kind !== 'text') continue
      const source = clean(child.name ?? child.agentId)
      activity.push({ id: `${child.agentId}:${child.runId ?? 'unknown'}:${index}:${event.at}`, title: clean(event.text, 240), status: 'text', meta: `${source} · run ${clean(child.runId)}`, detail: [`Source: ${source}`, `Run: ${clean(child.runId)}`, clean(event.text, 4000)], at: event.at })
    }
    for (const [index, tool] of (child.toolCalls ?? []).slice(-200).entries()) {
      activity.push({ id: `${child.agentId}:${child.runId ?? 'unknown'}:tool:${index}:${tool.startedAt}`, title: clean(tool.name), status: clean(tool.status), meta: `${clean(child.name ?? child.agentId)} · tool`, detail: [`Agent: ${clean(child.agentId)}`, `Run: ${clean(child.runId)}`, `Tool: ${clean(tool.name)}`, `Status: ${clean(tool.status)}`], at: tool.startedAt })
    }
  }
  const model = channel.model ?? ''
  return {
    sessionId: channel.sessionId,
    lead: `lead · ${route(channel.provider, channel.model)} · ${clean(channel.status ?? 'unknown')} · ${usage(channel.tokens)}`,
    ...(model === 'gpt-6-astra' ? {} : { warning: 'Lead is not GPT-6-astra. Use /model in chat to select it; dashboard never switches models.' }),
    ...(team?.failure ? { failure: `Team projection failed (last valid board): ${clean(team.failure)}` } : {}),
    needsInput,
    taskCount: `${tasks.filter(task => task.status === 'completed').length}/${tasks.length}`,
    tasks,
    agents,
    activity: activity.sort((a, b) => b.at - a.at).slice(0, 200),
    ...(channel.tokens === undefined ? {} : { tokens: channel.tokens }),
  }
}

export function summary(view: Dashboard): string {
  return [`Dashboard · session ${clean(view.sessionId)}`, view.lead, view.warning, view.failure, `Tasks ${view.taskCount}`, ...view.tasks.map(task => `[${task.status}] ${task.title} · ${task.meta}`), `Agents ${view.agents.length}`, ...view.agents.map(agent => `[${agent.status}] ${agent.title} · ${agent.meta}`), 'Source: native DSH projections; no parent/child usage aggregation.'].filter(line => line !== undefined).join('\n')
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
