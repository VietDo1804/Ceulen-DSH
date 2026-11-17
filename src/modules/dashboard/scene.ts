import { clean, project, visibleTools, watch, type Dashboard, type DashboardChannel, type Item } from './model.js'
import { motion, tokens as t } from './tokens.js'

interface Key {
  escape?: boolean; tab?: boolean; shift?: boolean; return?: boolean
  upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean
  home?: boolean; end?: boolean; ctrl?: boolean
}
interface Scroll { scrollBy(n: number): void; scrollTo(n: number): void; scrollToBottom(): void }
/** `ui.useAnimationFrame`: shared host clock, [ref, elapsedMs]; absent in host-free tests. */
type Frame = readonly [unknown, number]
export interface SceneProps {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void]
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
    useRef<T>(value: T): { current: T }
  }
  ui: {
    Box: unknown; Text: unknown; ScrollBox: unknown
    useInput(handler: (input: string, key: Key) => void): void
    useTerminalSize(): { columns: number; rows: number }
    useAnimationFrame?(intervalMs: number | null): Frame
  }
  channel: DashboardChannel
  close(): void
}

/** Wide terminals get Tasks and Workflow side by side; everything else tabs. */
export function layout(columns: number, rows: number): 'small' | 'tabs' | 'wide' {
  return columns < t.minColumns || rows < t.minRows ? 'small' : columns < t.wide ? 'tabs' : 'wide'
}
const labels = ['Tasks', 'Workflow'] as const
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const running = (status: string): boolean => status === 'running' || status === 'starting' || status === 'in_progress'
const tone = (status: string): string => status === 'failed' || status === 'error' || status === 'cancelled' ? t.danger : status === 'completed' || status === 'ok' ? t.success : running(status) ? t.focus : t.muted
const mark = (status: string): string => status === 'failed' || status === 'cancelled' ? '×' : status === 'completed' || status === 'ok' ? '✓' : running(status) ? '◐' : '○'

/** Start block so the cursor block fits inside the card's row budget. */
function firstVisible(heights: readonly number[], cursor: number, capacity: number): number {
  let start = 0
  while (start < cursor) {
    let used = 0
    for (let i = start; i <= cursor && i < heights.length; i++) used += heights[i] ?? 0
    if (used <= capacity) break
    start++
  }
  return start
}

function DashboardSession({ React: R, ui, channel, close }: SceneProps): unknown {
  const h = R.createElement
  const [state, setState] = R.useState<{ view?: Dashboard; error?: string }>({})
  const [focus, setFocus] = R.useState(0)
  const [selected, setSelected] = R.useState<readonly string[]>(['', ''])
  const [detail, setDetail] = R.useState<{ region: number; id: string } | undefined>(undefined)
  const scroll = R.useRef<Scroll | null>(null)
  const size = ui.useTerminalSize()
  R.useEffect(() => {
    const refresh = (): void => {
      try { setState({ view: project(channel) }) }
      catch { setState(previous => ({ ...previous, error: 'Native projection unavailable; showing last valid snapshot.' })) }
    }
    refresh()
    try { return watch(channel, refresh) }
    catch { setState(previous => ({ ...previous, error: 'Native subscription unavailable; snapshot is not live.' })) }
    return undefined
  }, [channel])
  R.useEffect(() => { if (state.view?.needsInput) close() }, [state.view?.needsInput, close])

  const view = state.view
  const spinning = view !== undefined && (running(view.workflow.lead.status) || view.workflow.children.some(item => running(item.status)))
  // One shared host clock, and only while a native run is live; idle costs zero frames.
  const frame = ui.useAnimationFrame ?? ((): Frame => [undefined, 0])
  const [clockRef, time] = frame(spinning ? motion.tickMs : null)
  const spin = (offset = 0): string => SPIN[(Math.floor(time / motion.tickMs) + offset) % SPIN.length] ?? '⠋'

  const mode = layout(size.columns, size.rows)
  const error = state.error ?? view?.failure
  const headerRows = 2 + (error === undefined ? 0 : 1) + (mode === 'tabs' ? 1 : 0)
  const inner = Math.max(12, size.columns - 2 * t.inset)
  const bodyRows = Math.max(1, size.rows - headerRows - 2)

  const taskItems: readonly Item[] = view === undefined ? [] : [...view.sessionTasks, ...view.teamTasks]
  const workflowItems: readonly Item[] = view === undefined ? [] : [view.workflow.lead, ...view.workflow.children]
  const groups: readonly (readonly Item[])[] = [taskItems, workflowItems]
  const items = groups[focus] ?? []
  const index = Math.max(0, items.findIndex(item => item.id === selected[focus]))
  const opened = detail === undefined ? undefined : groups[detail.region]?.find(item => item.id === detail.id)
  const taskCapacity = Math.max(1, bodyRows - 3 - (view?.request === undefined ? 0 : 1))
  const workflowCapacity = Math.max(1, bodyRows - 2)
  const page = focus === 0 ? taskCapacity : Math.max(1, Math.floor(workflowCapacity / 2))

  ui.useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      if (detail !== undefined) setDetail(undefined)
      else close()
      return
    }
    if (mode === 'small') return
    if (key.tab && detail === undefined) { setFocus((focus + 1) % labels.length); return }
    const delta = key.pageDown ? page : key.pageUp ? -page : key.downArrow ? 1 : key.upArrow ? -1 : 0
    if (opened !== undefined) {
      if (key.home) scroll.current?.scrollTo(0)
      else if (key.end) scroll.current?.scrollToBottom()
      else if (delta) scroll.current?.scrollBy(delta)
      return
    }
    if (delta || key.home || key.end) {
      const next = key.home ? 0 : key.end ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + delta))
      setSelected(selected.map((id, region) => region === focus ? items[next]?.id ?? '' : id))
    }
    if (key.return && items[index] !== undefined) setDetail({ region: focus, id: items[index].id })
  })

  const text = (value: string, props: Record<string, unknown> = {}): unknown => h(ui.Text, { color: t.text, wrap: 'truncate-end', ...props }, value)
  /** Inline colour runs inside one line; each run stays a whole string for host truncation. */
  const runs = (segments: readonly (readonly [string, Record<string, unknown>])[], props: Record<string, unknown> = {}): unknown =>
    h(ui.Text, { wrap: 'truncate-end', ...props }, ...segments.map(([value, extra], i) => h(ui.Text, { key: i, ...extra }, value)))
  if (mode === 'small') {
    return h(ui.Box, { flexDirection: 'column', width: size.columns, height: Math.max(1, size.rows) },
      text(`Too small at ${size.columns}x${size.rows}`, { bold: true, color: t.focus }),
      text('Resize to at least 30x10.', { color: t.muted }),
      text('Esc: chat', { color: t.muted }))
  }

  const card = (title: string, opts: { key?: string; width: number; height: number; active?: boolean }, ...rows: unknown[]): unknown =>
    h(ui.Box, {
      key: opts.key, flexDirection: 'column', flexShrink: 1, minWidth: 0, width: opts.width, height: opts.height,
      borderStyle: 'round', borderColor: opts.active === true ? t.focus : t.card,
      borderText: { content: `─ ${title} `, position: 'top', align: 'start' }, paddingX: t.inset,
    }, ...rows)

  const taskCard = (width: number): unknown => {
    const total = taskItems.length
    const cursor = Math.max(0, taskItems.findIndex(item => item.id === selected[0]))
    const start = Math.floor(cursor / taskCapacity) * taskCapacity
    const shown = taskItems.slice(start, start + taskCapacity)
    const rows: unknown[] = []
    const range = total > taskCapacity ? ` · ${start + 1}-${Math.min(start + taskCapacity, total)}/${total}` : ''
    rows.push(text(`session ${view?.sessionCount.done ?? 0}/${view?.sessionCount.total ?? 0} · team ${view?.teamCount.done ?? 0}/${view?.teamCount.total ?? 0}${range}`, { color: t.muted }))
    if (view?.request !== undefined) {
      rows.push(runs([
        ['Current request ', { color: t.muted, bold: true }],
        [clean(view.request, 600), { color: t.text }],
        [' · no checklist', { color: t.muted }],
      ]))
    }
    for (const [offset, item] of shown.entries()) {
      const selectedRow = focus === 0 && start + offset === cursor
      const source = item.id.startsWith('session:') ? 'S' : 'T'
      const glyph = mark(item.status)
      rows.push(runs([
        [`${selectedRow ? '>' : ' '}${glyph} `, { color: tone(item.status), bold: selectedRow }],
        [`${source} `, { color: t.muted }],
        [item.title, { color: t.text, bold: selectedRow }],
        [` · ${item.status}`, { color: tone(item.status) }],
        [` · ${item.meta}`, { color: t.muted }],
      ]))
    }
    if (total === 0) rows.push(text('No session checklist or team tasks. Nothing was created.', { color: t.muted }))
    return card('Tasks', { key: 'tasks', width, height: bodyRows, active: focus === 0 }, ...rows)
  }

  const workflowCard = (width: number): unknown => {
    const blocks = workflowItems.map(item => {
      const { shown, overflow } = visibleTools(item.tools)
      return { item, shown, overflow, height: 2 + shown.length + (overflow > 0 ? 1 : 0) }
    })
    const cursor = Math.max(0, workflowItems.findIndex(item => item.id === selected[1]))
    const start = firstVisible(blocks.map(block => block.height), cursor, workflowCapacity)
    const rows: unknown[] = []
    let used = 0
    for (let i = start; i < blocks.length; i++) {
      const block = blocks[i]
      if (block === undefined) break
      const remaining = workflowCapacity - used
      if (remaining <= 0) break
      const selectedRow = focus === 1 && i === cursor
      const glyph = running(block.item.status) ? spin(i) : mark(block.item.status)
      const connector = i === 0 ? '  ' : i === workflowItems.length - 1 ? '└─ ' : '├─ '
      const lines: unknown[] = [
        runs([
          [`${selectedRow ? '>' : ' '}${connector}${glyph} `, { color: tone(block.item.status), bold: selectedRow }],
          [block.item.title, { color: t.text, bold: selectedRow }],
          [` · ${block.item.status}`, { color: tone(block.item.status) }],
        ]),
        text(`  ${block.item.meta}`, { color: t.muted }),
      ]
      for (const tool of block.shown) {
        const toolGlyph = running(tool.status) ? spin() : mark(tool.status)
        lines.push(runs([
          [`   ${toolGlyph} `, { color: tone(tool.status) }],
          [tool.name, { color: t.text }],
          [` · ${tool.status}`, { color: tone(tool.status) }],
        ]))
      }
      if (block.overflow > 0) lines.push(text(`   +${block.overflow} earlier`, { color: t.muted }))
      rows.push(...lines.slice(0, remaining))
      used += Math.min(lines.length, remaining)
    }
    if (rows.length === 0) rows.push(text('Loading native workflow…', { color: t.muted }))
    if (workflowItems.length === 1 && used < workflowCapacity) rows.push(text('No native current-session children.', { color: t.muted }))
    return card('Workflow', { key: 'workflow', width, height: bodyRows, active: focus === 1 }, ...rows)
  }

  let body: unknown
  if (detail !== undefined) {
    const lines = [opened?.title ?? 'This run/item is no longer in the native snapshot.', ...(opened?.detail ?? [])]
    body = card(`DETAIL · ${labels[detail.region]}`, { width: inner, height: bodyRows, active: true },
      h(ui.ScrollBox, { key: detail.id, ref: scroll, height: Math.max(1, bodyRows - 4), flexDirection: 'column' },
        ...lines.map((line, i) => h(ui.Text, { key: i, color: t.text }, clean(line, 4000)))))
  } else if (mode === 'wide') {
    const tasksWidth = Math.floor(inner * 0.42)
    body = h(ui.Box, { flexDirection: 'row', width: inner, height: bodyRows, flexShrink: 0 },
      taskCard(tasksWidth), workflowCard(Math.max(8, inner - tasksWidth)))
  } else {
    body = focus === 0 ? taskCard(inner) : workflowCard(inner)
  }

  // Keep Tab and Esc visible when the terminal is too narrow for the full hint.
  const footer = detail !== undefined
    ? (inner < 46 ? 'Esc: overview · Esc: chat' : 'Esc: overview · Esc again: chat · ↑↓/PgUp/PgDn: scroll')
    : (inner < 34 ? 'Tab · Esc: chat' : inner < 46 ? 'Tab: region · Enter · Esc: chat' : 'Tab: region · ↑↓/PgUp/PgDn: select · Enter: detail · Esc: chat')
  return h(ui.Box, { ref: clockRef, flexDirection: 'column', width: size.columns, height: size.rows, paddingX: t.inset },
    text(`${spinning ? `${spin()} ` : ''}CEULEN · dashboard · ${clean(channel.sessionId)}`, { bold: true, color: t.focus }),
    text(view?.lead ?? 'Loading native channel…', { color: t.muted }),
    ...(error === undefined ? [] : [text(error, { color: t.danger })]),
    ...(mode === 'tabs' ? [text(labels.map((label, region) => (region === focus ? `[${label}]` : label)).join(' · '), { color: t.muted })] : []),
    body,
    text(footer, { color: t.muted }),
    text('Source: native checklist/team/subagents · tokens per source, not summed', { color: t.muted }),
  )
}

/** A rebind remounts local navigation, never reuses another session's snapshot. */
export function createDashboardScene(): (props: SceneProps) => unknown {
  return props => props.React.createElement(DashboardSession, { ...props, key: `${props.channel.sessionId}:${props.channel.agentBindingGeneration ?? 0}` })
}
