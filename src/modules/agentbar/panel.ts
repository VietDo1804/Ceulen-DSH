import type { TodoItem } from '../todoview/index.js'
import { cacheHit, duration, headline, nameOf, summarize, tokens, type AgentRow, type AgentState, type AgentStore } from './model.js'

/** The narrowed kit `tuiPanels.register` hands a panel component. */
export interface PanelProps {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
    useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void]
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T
  }
  ui: {
    Box: unknown
    Text: unknown
    /** The only timer a panel may use; `null` pauses it. */
    useAnimationTime(intervalMs: number | null): number
  }
  /** Panel host API; keys reach `onKey` only while the panel has focus. */
  host?: {
    onKey?(listener: (event: PanelKeyEvent) => void): () => void
  }
  width: number
  height: number
  focused: boolean
  visible: boolean
}

export interface PanelKeyEvent {
  readonly key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly pageUp?: boolean; readonly pageDown?: boolean }
  preventDefault(): void
}

export type Tone = 'accent' | 'success' | 'error' | 'warning' | 'subtle' | 'strong' | undefined
/** One run of text; a row is runs on the left and an optional right-aligned run. */
export type Run = readonly [string, Tone]
export interface PanelRow {
  readonly left: readonly Run[]
  readonly right?: Run
  /** The first row of a child (card title or finished line), for "↓ N more". */
  readonly agent?: true
  /** Draw this run with a moving highlight (the "Working" shimmer). */
  readonly shimmer?: { readonly text: string; readonly phase: number }
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** Frame length of the spinner and the shimmer sweep. */
export const FRAME_MS = 90
const TODO_ROWS = 5
const MARK: Record<Exclude<AgentState, 'running'>, Run> = {
  done: ['✓', 'success'],
  failed: ['✗', 'error'],
  cancelled: ['◌', 'warning'],
}

function modelLine(row: AgentRow): string | undefined {
  if (row.model === undefined) return undefined
  const base = row.model.split('/').pop() ?? row.model
  return row.effort === undefined ? base : `${base} · ${row.effort}`
}

/** `ctx 26k/1M · 3% · cache 46%`, whatever is known so far. */
export function usageLine(row: AgentRow): string | undefined {
  const parts: string[] = []
  if (row.context !== undefined) {
    if (row.contextWindow !== undefined && row.contextWindow > 0) {
      const share = Math.min(100, Math.round((row.context / row.contextWindow) * 100))
      parts.push(`ctx ${tokens(row.context)}/${tokens(row.contextWindow)} · ${share}%`)
    } else {
      parts.push(`ctx ${tokens(row.context)}`)
    }
  }
  const hit = cacheHit(row)
  if (hit !== undefined) parts.push(`cache ${hit}%`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Up to TODO_ROWS items around the active one, then "+N more". */
export function todoWindow(todos: readonly TodoItem[]): { items: readonly TodoItem[]; hidden: number } {
  if (todos.length <= TODO_ROWS) return { items: todos, hidden: 0 }
  const active = todos.findIndex(item => item.status !== 'completed')
  const start = Math.max(0, Math.min((active < 0 ? todos.length : active) - 1, todos.length - (TODO_ROWS - 1)))
  const items = todos.slice(start, start + TODO_ROWS - 1)
  return { items, hidden: todos.length - items.length }
}

export function bar(done: number, total: number, cells: number): Run[] {
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)
  return [['━'.repeat(filled), 'accent'], ['─'.repeat(cells - filled), 'subtle']]
}

/** Card density: full todo window, then only the active item, then no model line either. */
type Density = 0 | 1 | 2

function runningCard(row: AgentRow, now: number, width: number, frame: number, density: Density): PanelRow[] {
  const rows: PanelRow[] = [{
    left: [[`${SPIN[frame % SPIN.length]} `, 'accent'], [nameOf(row), 'strong']],
    right: [duration(now - row.startedAt), 'subtle'],
    agent: true,
  }]
  const model = density < 2 ? modelLine(row) : undefined
  if (model !== undefined) rows.push({ left: [['  ', undefined], [model, 'subtle']] })
  rows.push({ left: [['  ', undefined]], shimmer: { text: row.steps === 0 ? 'Starting…' : 'Working…', phase: frame } })
  if (row.todos !== undefined && row.todos.length > 0) {
    const done = row.todos.filter(item => item.status === 'completed').length
    const cells = Math.max(6, Math.min(20, width - 16))
    rows.push({ left: [['  todo ', 'subtle'], ...bar(done, row.todos.length, cells), [` ${done}/${row.todos.length}`, 'subtle']] })
    const active = row.todos.find(item => item.status === 'in_progress') ?? row.todos.find(item => item.status === 'pending')
    const { items, hidden } = density === 0 ? todoWindow(row.todos) : { items: active === undefined ? [] : [active], hidden: 0 }
    for (const item of items) {
      const mark: Run = item.status === 'completed' ? ['✓ ', 'success'] : item.status === 'in_progress' ? ['▸ ', 'accent'] : ['○ ', 'subtle']
      rows.push({ left: [['   ', undefined], mark, [item.content, item.status === 'in_progress' ? undefined : 'subtle']] })
    }
    if (hidden > 0) rows.push({ left: [['     ', undefined], [`+${hidden} more`, 'subtle']] })
  }
  const usage = usageLine(row)
  if (usage !== undefined) rows.push({ left: [['  ', undefined], [usage, 'subtle']] })
  return rows
}

function finishedRow(row: AgentRow): PanelRow {
  const mark = MARK[row.state as Exclude<AgentState, 'running'>] ?? MARK.done
  return {
    left: [[`${mark[0]} `, mark[1]], [nameOf(row), 'subtle']],
    right: [duration((row.endedAt ?? row.startedAt) - row.startedAt), 'subtle'],
    agent: true,
  }
}

/**
 * Panel rows for one moment: running children as cards (spinner, model, a
 * shimmering "Working…", todo progress, context and cache), finished ones as
 * one line each. Given `room`, cards shrink until every child fits if they
 * can: first only the active todo item, then no model line. Pure, so tests pin
 * the layout without a host.
 */
export function panelRows(rows: readonly AgentRow[], now: number, width: number, frame = 0, room = Number.POSITIVE_INFINITY): { header: PanelRow; body: PanelRow[] } {
  let result = layout(rows, now, width, frame, 0)
  for (const density of [1, 2] as const) {
    if (result.body.length <= room) break
    result = layout(rows, now, width, frame, density)
  }
  return result
}

function layout(rows: readonly AgentRow[], now: number, width: number, frame: number, density: Density): { header: PanelRow; body: PanelRow[] } {
  const summary = summarize(rows)
  const running = summary.running
  const header: PanelRow = running.length > 0
    ? { left: [['◆ ', 'accent'], ['Subagents', 'strong']], right: [headline(summary), 'subtle'] }
    : rows.length > 0
      ? { left: [summary.failed + summary.cancelled > 0 ? ['◆ ', 'warning'] : ['✓ ', 'success'], ['Subagents', 'strong']], right: [headline(summary), 'subtle'] }
      : { left: [['◆ ', 'subtle'], ['Subagents', 'strong']] }
  if (rows.length === 0) {
    return {
      header,
      body: [
        { left: [['No subagents yet.', 'subtle']] },
        { left: [['This panel opens when a delegate starts.', 'subtle']] },
      ],
    }
  }
  const body: PanelRow[] = []
  for (const [index, row] of running.entries()) {
    if (body.length > 0) body.push({ left: [] })
    body.push(...runningCard(row, now, width, frame + index * 4, density))
  }
  const finished = rows.filter(row => row.state !== 'running')
  if (finished.length > 0 && body.length > 0) body.push({ left: [] })
  for (const row of finished) body.push(finishedRow(row))
  if (running.length === 0) body.push({ left: [] }, { left: [['Results are in the chat.', 'subtle']] })
  return { header, body }
}

/** Cell tones for a shimmer: a bright head sweeping left to right, then a pause. */
export function shimmerTones(text: string, phase: number): Tone[] {
  const cycle = text.length + 8
  const head = phase % cycle
  return [...text].map((_, index) => (index === head ? 'strong' : Math.abs(index - head) === 1 ? 'accent' : 'subtle'))
}

/** Rows the body can show: the panel minus padding, header + gap, and footer. */
export const bodyRows = (height: number): number => Math.max(1, height - 3)

/** Clamp a scroll offset so the last page stays full. */
export const clampScroll = (offset: number, total: number, visible: number): number => Math.max(0, Math.min(offset, total - visible))

/** What a row panel draws from: a store to follow and the rows for one moment. */
export interface RowSource {
  subscribe(listener: () => void): () => void
  getVersion(): number
  rows(now: number, width: number, frame: number, room: number): { header: PanelRow; body: PanelRow[] }
  /** Something moves: the panel's clock runs only then, and only while visible. */
  animating(): boolean
  setVisible(visible: boolean): void
  /** The user focused the panel. */
  touch(): void
}

/** A side panel of rows: header, scrolling body, one hint line. */
export function createRowPanel(source: RowSource): (props: PanelProps) => unknown {
  return function CeulenRowPanel({ React: R, ui, host, width, height, focused, visible }: PanelProps): unknown {
    const h = R.createElement
    R.useSyncExternalStore(source.subscribe, source.getVersion)
    const [scroll, setScroll] = R.useState(0)
    ui.useAnimationTime(visible && source.animating() ? FRAME_MS : null)
    R.useEffect(() => {
      source.setVisible(visible)
      return () => source.setVisible(false)
    }, [visible])
    R.useEffect(() => {
      if (focused) source.touch()
    }, [focused])
    const now = Date.now()
    const room = bodyRows(height)
    // Content width: the panel minus its paddingX.
    const { header, body } = source.rows(now, width - 2, Math.floor(now / FRAME_MS), room)
    const offset = clampScroll(scroll, body.length, room)
    // ↑/↓ and PgUp/PgDn scroll while the panel has focus; Esc returns to the chat (host).
    R.useEffect(() => host?.onKey?.(event => {
      const step = event.key.upArrow ? -1 : event.key.downArrow ? 1 : event.key.pageUp ? -room : event.key.pageDown ? room : 0
      if (step === 0) return
      event.preventDefault()
      setScroll(previous => clampScroll(clampScroll(previous, body.length, room) + step, body.length, room))
    }), [host, room, body.length])

    const text = (value: string, tone: Tone, key?: number): unknown =>
      h(ui.Text, {
        key,
        wrap: 'truncate-end',
        ...(tone === 'subtle' ? { dimColor: true } : tone === 'strong' ? { bold: true } : tone === undefined ? {} : { color: tone }),
      }, value)
    // Only the last run of a row truncates; marks, spinners and bars keep their cells.
    const line = (row: PanelRow, key: number): unknown => {
      const runs: unknown[] = row.left.map(([value, tone], index) => {
        const last = index === row.left.length - 1 && row.shimmer === undefined
        return h(ui.Box, { key: index, flexShrink: last ? 1 : 0, minWidth: last ? 0 : undefined, overflow: 'hidden' }, text(value, tone))
      })
      if (row.shimmer !== undefined) {
        const chars = [...row.shimmer.text]
        runs.push(...shimmerTones(row.shimmer.text, row.shimmer.phase).map((tone, index) => text(chars[index]!, tone, 100 + index)))
      }
      return h(ui.Box, { key, flexDirection: 'row', width: '100%', height: 1, overflow: 'hidden' },
        h(ui.Box, { flexDirection: 'row', flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }, ...(runs.length === 0 ? [text(' ', undefined)] : runs)),
        ...(row.right === undefined ? [] : [h(ui.Box, { flexShrink: 0, paddingLeft: 1 }, text(row.right[0], row.right[1]))]))
    }
    const below = body.slice(offset + room)
    const hiddenAgents = below.filter(row => row.agent === true).length
    const more = hiddenAgents > 0 ? `↓ ${hiddenAgents} more` : below.length > 0 ? '↓ more' : undefined
    // The host already prints "Ctrl+B focus panel" under an unfocused panel.
    const hint = focused
      ? `${body.length > room ? '↑↓ scroll · ' : ''}Esc chat · Ctrl+A dashboard`
      : more !== undefined ? `${more} · Ctrl+A dashboard` : 'Ctrl+A dashboard'
    return h(ui.Box, { flexDirection: 'column', width, height, paddingX: 1, overflow: 'hidden' },
      h(ui.Box, { flexShrink: 0, flexDirection: 'column' }, line(header, 0), h(ui.Box, { height: 1 })),
      h(ui.Box, {
        flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden',
        onWheel: (event: { deltaY?: number }) => setScroll(previous => clampScroll(clampScroll(previous, body.length, room) + Math.sign(event.deltaY ?? 0) * 3, body.length, room)),
      }, ...body.slice(offset, offset + room).map((row, index) => line(row, offset + index))),
      h(ui.Box, { key: 'footer', flexShrink: 0, height: 1, overflow: 'hidden' }, text(hint, 'subtle')))
  }
}

/** The Subagents panel: reads the store, animates only while a child runs. */
export function createPanel(store: AgentStore): (props: PanelProps) => unknown {
  return createRowPanel({
    subscribe: store.subscribe,
    getVersion: store.getVersion,
    rows: (now, width, frame, room) => panelRows(store.batch(), now, width, frame, room),
    animating: () => store.batch().some(row => row.state === 'running'),
    setVisible: visible => store.setPanelVisible(visible),
    touch: () => store.touchPanel(),
  })
}
