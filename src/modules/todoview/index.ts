import type { AgentLike, MessageLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { registerCommandSafe, tuiStatusPublisher } from '../../core/tools.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-todoview'
export const inject = ['commands']

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * The newest `todo_write` call carries the whole board, so replaying the
 * session transcript and letting the last call win is the current state.
 * Returns undefined when the session never wrote a todo list.
 */
export function latestTodos(messages: readonly MessageLike[]): TodoItem[] | undefined {
  let latest: TodoItem[] | undefined
  for (const message of messages) {
    for (const block of message.content) {
      const record = block as { type?: string; name?: string; arguments?: unknown }
      if (record.type !== 'tool-call' || typeof record.name !== 'string') continue
      const bare = record.name.startsWith('ceulen_') ? record.name.slice('ceulen_'.length) : record.name
      if (bare !== 'todo_write') continue
      const parsed = parseTodos(record.arguments)
      if (parsed !== undefined) latest = parsed
    }
  }
  return latest
}

function parseTodos(raw: unknown): TodoItem[] | undefined {
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  const todos = (args as { todos?: unknown } | null | undefined)?.todos
  if (!Array.isArray(todos)) return undefined
  return todos
    .filter((item): item is { content: string; status?: string } => item !== null && typeof (item as { content?: unknown }).content === 'string')
    .map(item => ({
      content: item.content,
      status: item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending',
    }))
}

/** Compact status-bar segment: progress count plus the active item. */
export function statusText(todos: TodoItem[]): string {
  if (todos.length === 0) return 'todo · clear'
  const done = todos.filter(item => item.status === 'completed').length
  const label = `todo ${done}/${todos.length}`
  if (done === todos.length) return `${label} ✓ all done`
  const active = todos.find(item => item.status === 'in_progress') ?? todos.find(item => item.status === 'pending')
  if (active === undefined) return label
  const brief = active.content.length > 48 ? `${active.content.slice(0, 47)}…` : active.content
  return `${label} · ▸ ${brief}`
}

/** Full board for /todo — completed items render struck through. */
export function listText(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo board is empty — it fills in when todo_write is used.'
  const done = todos.filter(item => item.status === 'completed').length
  const lines = todos.map(item => {
    if (item.status === 'completed') return `  ✓ ~~${item.content}~~`
    if (item.status === 'in_progress') return `  ▸ ${item.content}`
    return `  · ${item.content}`
  })
  return [`Todo — ${done}/${todos.length} done`, ...lines].join('\n')
}

/**
 * Surface the native todo board: a `ceulen:todo` status line refreshed at
 * turn boundaries, plus `/todo` for the full list with completed items
 * struck through. DSH owns todo_write; this module only reads the transcript
 * (no per-call tool event exists).
 */
export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('todoview', loadSettingsSync())) return

  const publishTodo = tuiStatusPublisher(ctx, 'ceulen:todo')

  const refresh = (agent: AgentLike | undefined): TodoItem[] | undefined => {
    const todos = latestTodos(agent?.session.deriveMessages?.() ?? [])
    // Root-activation status writes are rejected by the TUI; the publisher
    // resolves the service through an injected child activation.
    publishTodo(todos === undefined ? undefined : statusText(todos))
    return todos
  }

  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string }) => {
    if (payload?.agent === undefined) return
    if (payload.status === 'running' || payload.status === 'idle') refresh(payload.agent)
  })

  registerCommandSafe(ctx, {
    name: 'todo',
    description: 'Show the todo board — completed items struck through',
    handler({ agent }) {
      if (agent === undefined) return { kind: 'error', text: 'todo needs a session context' }
      return { kind: 'success', text: listText(refresh(agent) ?? []) }
    },
  })

  logLine('todoview', 'loaded (ceulen:todo status line + /todo with ~~done~~ strikethrough)')
}
