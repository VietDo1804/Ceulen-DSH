import { parseTodos, type TodoItem } from '../todoview/index.js'

/**
 * Live roster of delegated children, fed only by `session/event`. A child is
 * any session whose header names a parent; its root is the top of the parent
 * chain. Pure: no host, no timers, so the band and `/agentbar` share one model.
 */
export type AgentState = 'running' | 'done' | 'failed' | 'cancelled'

export interface AgentRow {
  readonly id: string
  readonly root: string
  readonly depth: number
  label: string
  role?: string
  model?: string
  effort?: string
  state: AgentState
  startedAt: number
  endedAt?: number
  /** Tool calls still in flight, by call id. */
  readonly inFlight: Map<string, string>
  lastTool?: string
  tools: number
  steps: number
  /** Last request's prompt size: input + cache reads. */
  context?: number
  /** The child model's window, from `request/context`. */
  contextWindow?: number
  /** Prompt tokens over every request, and the share served from cache. */
  promptTokens: number
  cachedTokens: number
  todo?: { done: number; total: number }
  todos?: readonly TodoItem[]
  /** First line of the newest assistant text: the child's own narration. */
  note?: string
}

export interface SessionInfo {
  readonly id?: unknown
  readonly header?: { readonly parentSession?: unknown; readonly createdAt?: unknown }
}
export interface SessionEvent {
  readonly type?: unknown
  readonly time?: unknown
  readonly data?: unknown
}

/** A finished batch stays on screen this long; then the band hides and an auto-opened panel closes. */
export const LINGER_MS = 60_000
const MAX_ROWS = 64
const NOTE_CELLS = 120

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {})
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const item = record(block)
    if (item.type !== 'text') continue
    // A final answer often opens with markdown (`## Evidence`); show the words.
    const line = str(item.text)
      ?.split('\n')
      .map(part => part.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, '').replace(/[*_`]+/g, '').trim())
      .find(part => part !== '')
    if (line !== undefined) return line.slice(0, NOTE_CELLS)
  }
  return undefined
}

/** Ceulen's delegate prompt opens with `You are the "<role>" subagent role.` */
function roleOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const match = /^You are the "([a-z][a-z0-9_-]*)" subagent role\./u.exec(str(record(block).text) ?? '')
    if (match !== null) return match[1]
  }
  return undefined
}

const bareTool = (name: string): string => (name.startsWith('ceulen_') ? name.slice('ceulen_'.length) : name)

/**
 * `turn/end` reason kinds and `subagent/end` stop reasons share one set:
 * completed, aborted, error, max-tokens, refusal. Unknown kinds count as
 * failed so a new variant never shows as a success.
 */
function settle(row: AgentRow, kind: string | undefined, at: number): void {
  row.state = kind === undefined || kind === 'completed' ? 'done' : kind === 'aborted' ? 'cancelled' : 'failed'
  row.endedAt = at
  row.inFlight.clear()
}

function setTodos(row: AgentRow, args: unknown): boolean {
  const todos = parseTodos(args)
  if (todos === undefined) return false
  row.todos = todos
  row.todo = { done: todos.filter(item => item.status === 'completed').length, total: todos.length }
  return true
}

export class AgentStore {
  private readonly rows = new Map<string, AgentRow>()
  private readonly parents = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  /** The root session the user is looking at: the newest one with its own turn. */
  private focus: string | undefined
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Changes on every mutation; `useSyncExternalStore` snapshot. */
  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A broken view must not stop event intake.
      }
    }
  }

  private rootOf(id: string): string {
    let current = id
    for (let hops = 0; hops < 16; hops++) {
      const parent = this.parents.get(current)
      if (parent === undefined) return current
      current = parent
    }
    return current
  }

  private depthOf(id: string): number {
    let depth = 0
    let current = id
    while (depth < 16) {
      const parent = this.parents.get(current)
      if (parent === undefined) break
      depth++
      current = parent
    }
    return depth
  }

  /** Children of the focused root, newest last. */
  list(): AgentRow[] {
    const focus = this.focus
    return [...this.rows.values()].filter(row => focus === undefined || row.root === focus)
  }

  /**
   * The current batch: children started since the focused session last had
   * none running. Earlier finished work stays in `list()` but leaves the band.
   */
  batch(): AgentRow[] {
    const rows = this.list()
    const start = this.batchStart.get(this.focus ?? '')
    return start === undefined ? rows : rows.filter(row => row.startedAt >= start || row.state === 'running')
  }

  private readonly batchStart = new Map<string, number>()

  /** The Subagents side panel is on screen: the band steps aside. */
  panelVisible = false
  /** The user focused the panel since it was revealed: never auto-close it. */
  panelTouched = false

  /** The Team side panel (orchestrator mode) is on screen: the band steps aside for it too. */
  teamVisible = false

  setTeamVisible(visible: boolean): void {
    if (this.teamVisible === visible) return
    this.teamVisible = visible
    this.emit()
  }

  /** The root session the user is on. */
  get focusId(): string | undefined {
    return this.focus
  }

  /** A child's row by session id, whatever its batch. */
  row(id: string): AgentRow | undefined {
    return this.rows.get(id)
  }

  setPanelVisible(visible: boolean): void {
    if (this.panelVisible === visible) return
    this.panelVisible = visible
    this.emit()
  }

  touchPanel(): void {
    this.panelTouched = true
  }

  reset(): void {
    this.rows.clear()
    this.parents.clear()
    this.batchStart.clear()
    this.focus = undefined
    this.panelVisible = false
    this.teamVisible = false
    this.panelTouched = false
    this.emit()
  }

  onEvent(session: SessionInfo | undefined, event: SessionEvent | undefined): void {
    const id = str(session?.id)
    const type = str(event?.type)
    if (id === undefined || type === undefined) return
    const parent = str(session?.header?.parentSession)
    const at = num(event?.time) ?? Date.now()
    const data = record(event?.data)

    if (parent === undefined) {
      // A root's own turn means the user is on that session (switch, /new).
      if (type === 'turn/start' && this.focus !== id) {
        this.focus = id
        this.emit()
      }
      return
    }
    this.parents.set(id, parent)
    let row = this.rows.get(id)
    if (row === undefined) {
      const root = this.rootOf(id)
      const idle = ![...this.rows.values()].some(other => other.root === root && other.state === 'running')
      const created = num(session?.header?.createdAt) ?? at
      // Siblings can log their first event out of creation order; a batch
      // starts at its earliest member, not at whichever child spoke first.
      const start = this.batchStart.get(root)
      if (idle || start === undefined || created < start) this.batchStart.set(root, created)
      row = {
        id,
        root,
        depth: this.depthOf(id),
        label: 'subagent',
        state: 'running',
        startedAt: num(session?.header?.createdAt) ?? at,
        inFlight: new Map(),
        tools: 0,
        steps: 0,
        promptTokens: 0,
        cachedTokens: 0,
      }
      this.rows.set(id, row)
      this.focus ??= row.root
      this.prune()
    }
    if (this.apply(row, type, data, at)) this.emit()
  }

  private apply(row: AgentRow, type: string, data: Record<string, unknown>, at: number): boolean {
    switch (type) {
      case 'subagent/descriptor':
        row.label = str(data.label) ?? row.label
        row.model = str(data.agentModel) ?? row.model
        row.effort = str(data.agentReasoningEffort) ?? row.effort
        return true
      case 'request/context':
        row.model ??= str(data.model)
        row.contextWindow = num(data.contextWindow) ?? row.contextWindow
        return true
      case 'user/message':
        row.role ??= roleOf(data.content)
        return row.role !== undefined
      case 'turn/start':
        if (row.state === 'running') return false
        row.state = 'running'
        row.endedAt = undefined
        return true
      case 'step/start':
        row.steps++
        return true
      case 'tool/call': {
        const name = str(data.name)
        if (name === undefined) return false
        row.tools++
        row.lastTool = bareTool(name)
        row.inFlight.set(str(data.callId) ?? `#${row.tools}`, row.lastTool)
        if (row.lastTool === 'todo_write') setTodos(row, data.arguments)
        return true
      }
      // Under the `ptc` preset the model calls `run_code`, and each tool the
      // program calls is logged on its own: `todo_write` arrives only here.
      case 'tool/ptc-dispatch': {
        const name = str(data.name)
        if (name === undefined || bareTool(name) !== 'todo_write' || data.isError === true) return false
        return setTodos(row, data.arguments)
      }
      case 'tool/result': {
        const message = record(data.message)
        const callId = str(record(message.source).callId) ?? str(message.toolCallId)
        if (callId !== undefined) row.inFlight.delete(callId)
        else row.inFlight.clear()
        return true
      }
      case 'assistant/message': {
        const message = record(data.message)
        const usage = record(data.usage ?? message.usage)
        const input = num(usage.inputTokens)
        if (input !== undefined) {
          // DSH logs inputTokens without the cache reads (total = input + output + cacheRead).
          const cached = num(usage.cacheReadTokens) ?? 0
          row.context = input + cached
          row.promptTokens += input + cached
          row.cachedTokens += cached
        }
        row.note = textOf(message.content) ?? row.note
        return true
      }
      case 'turn/end':
        settle(row, str(record(data.reason).kind), at)
        return true
      default:
        return false
    }
  }

  /**
   * End a still-running child from outside its log: `subagent/end` (its run
   * settled) or `agent/disposed`. A child interrupted or torn down without a
   * `turn/end` would otherwise spin forever.
   */
  finish(id: unknown, kind: string | undefined, at = Date.now()): void {
    const row = this.rows.get(str(id) ?? '')
    if (row === undefined || row.state !== 'running') return
    settle(row, kind, at)
    this.emit()
  }

  /** Keep the roster bounded: drop the oldest finished rows first. */
  private prune(): void {
    if (this.rows.size <= MAX_ROWS) return
    for (const [id, row] of this.rows) {
      if (this.rows.size <= MAX_ROWS) break
      if (row.state !== 'running') this.rows.delete(id)
    }
  }
}

export interface Summary {
  readonly running: readonly AgentRow[]
  readonly done: number
  readonly failed: number
  readonly cancelled: number
  readonly total: number
  /** The newest end time when nothing runs. */
  readonly lastEnd?: number
}

export function summarize(rows: readonly AgentRow[]): Summary {
  const running = rows.filter(row => row.state === 'running')
  const ends = rows.map(row => row.endedAt ?? 0)
  return {
    running,
    done: rows.filter(row => row.state === 'done').length,
    failed: rows.filter(row => row.state === 'failed').length,
    cancelled: rows.filter(row => row.state === 'cancelled').length,
    total: rows.length,
    ...(running.length === 0 && rows.length > 0 ? { lastEnd: Math.max(...ends) } : {}),
  }
}

/** The band shows while anything runs and for LINGER_MS after the last finish. */
export function bandVisible(summary: Summary, now: number): boolean {
  if (summary.running.length > 0) return true
  return summary.lastEnd !== undefined && now - summary.lastEnd < LINGER_MS
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function tokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Short model name: provider prefixes and long vendor paths dropped. */
export function shortModel(row: Pick<AgentRow, 'model' | 'effort'>): string | undefined {
  if (row.model === undefined) return undefined
  const base = row.model.split('/').pop() ?? row.model
  return row.effort === undefined ? base : `${base}:${row.effort}`
}

/** Share of all prompt tokens served from cache, 0–100. */
export function cacheHit(row: Pick<AgentRow, 'promptTokens' | 'cachedTokens'>): number | undefined {
  return row.promptTokens > 0 ? Math.round((row.cachedTokens / row.promptTokens) * 100) : undefined
}

export function nameOf(row: Pick<AgentRow, 'role' | 'label'>): string {
  return row.role === undefined ? row.label : `${row.role} · ${row.label}`
}

/**
 * What the child is doing now, in its own words. Tool names are left out on
 * purpose: under the `ptc` preset every call is `run_code`, which says nothing.
 */
export function activity(row: AgentRow): string {
  if (row.note !== undefined) return row.note
  return row.steps === 0 ? 'starting' : 'working'
}

/** Counters after the activity: todo progress, steps, context, elapsed. */
export function meters(row: AgentRow, now: number): string[] {
  const parts: string[] = []
  if (row.todo !== undefined && row.todo.total > 0) parts.push(`todo ${row.todo.done}/${row.todo.total}`)
  if (row.steps > 0) parts.push(`${row.steps} step${row.steps === 1 ? '' : 's'}`)
  if (row.context !== undefined) parts.push(`ctx ${tokens(row.context)}`)
  parts.push(duration((row.endedAt ?? now) - row.startedAt))
  return parts
}

export function headline(summary: Summary): string {
  const parts: string[] = []
  if (summary.running.length > 0) parts.push(`${summary.running.length} running`)
  if (summary.done > 0) parts.push(`${summary.done} done`)
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`)
  return parts.join(' · ')
}

const MARK: Record<AgentState, string> = { running: '◐', done: '✓', failed: '×', cancelled: '–' }

/** Full roster for `/agentbar`: every child of the focused session. */
export function rosterText(rows: readonly AgentRow[], now: number): string {
  if (rows.length === 0) return 'No subagents in this session yet. The band above the prompt appears when one starts.'
  const lines = [`Subagents — ${headline(summarize(rows))}`]
  for (const row of rows) {
    const indent = '  '.repeat(Math.max(1, row.depth))
    const model = shortModel(row)
    lines.push(`${indent}${MARK[row.state]} ${nameOf(row)}${model === undefined ? '' : `  (${model})`}`)
    const detail = [row.state === 'running' ? activity(row) : row.note, `${row.tools} tool call${row.tools === 1 ? '' : 's'}`, ...meters(row, now)].filter(Boolean)
    lines.push(`${indent}  ${detail.join(' · ')}`)
  }
  lines.push('', 'The Subagents side panel opens beside the chat while one runs (fullscreen, ≥93 columns; Ctrl+B toggles it). Ctrl+A opens the full dashboard.')
  return lines.join('\n')
}
