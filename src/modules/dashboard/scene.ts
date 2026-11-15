import { clean, project, watch, type Dashboard, type DashboardChannel, type Item } from './model.js'
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

export function layout(columns: number, rows: number): 'small' | 'tabs' | 'stacked' | 'wide' {
  return columns < t.minColumns || rows < t.minRows ? 'small' : columns < t.stacked || rows < 24 ? 'tabs' : columns < t.wide ? 'stacked' : 'wide'
}
const labels = ['Tasks', 'Agents', 'Activity'] as const
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const running = (status: string): boolean => status === 'running' || status === 'starting'
const tone = (status: string): string => status === 'failed' || status === 'error' || status === 'cancelled' ? t.danger : status === 'completed' || status === 'ok' ? t.success : running(status) ? t.focus : t.muted
const mark = (status: string): string => status === 'failed' || status === 'cancelled' ? '×' : status === 'completed' || status === 'ok' ? '✓' : running(status) ? '◐' : '○'

/** Host design-system ProgressBar is not in the plugin `ui` surface; this is its 8-line equivalent, with a visible track. */
function gauge(ratio: number, width: number, ramp: number): readonly [string, string] {
  const r = Math.max(0, Math.min(1, ratio * ramp))
  const whole = Math.floor(r * width)
  const tail = whole < width ? BLOCKS[Math.floor((r * width - whole) * BLOCKS.length)] ?? ' ' : ''
  const filled = (BLOCKS[8] ?? '█').repeat(whole) + tail
  return [filled, '░'.repeat(Math.max(0, width - whole - (tail === '' ? 0 : 1)))]
}
function sparkline(counts: readonly number[]): string {
  const max = Math.max(1, ...counts)
  return counts.map(count => SPARK[count === 0 ? 0 : Math.min(7, Math.round((count / max) * 7))] ?? '▁').join('')
}
/** Real per-minute event counts from native timestamps; unknown times contribute nothing. */
function recent(items: readonly Item[], minutes: number, now: number): number[] {
  const counts = new Array<number>(minutes).fill(0)
  for (const item of items) {
    if (item.at === undefined || item.at <= 0) continue
    const age = Math.floor((now - item.at) / 60_000)
    const slot = minutes - 1 - age
    const current = counts[slot]
    if (age >= 0 && current !== undefined) counts[slot] = current + 1
  }
  return counts
}
function compact(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function DashboardSession({ React: R, ui, channel, close }: SceneProps): unknown {
  const h = R.createElement
  const [state, setState] = R.useState<{ view?: Dashboard; error?: string }>({})
  const [focus, setFocus] = R.useState(0)
  const [selected, setSelected] = R.useState<readonly string[]>(['', '', ''])
  const [detail, setDetail] = R.useState<{ region: number; id: string } | undefined>(undefined)
  const [mountedAt] = R.useState(() => Date.now())
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
  // ponytail: one shared clock, and it stops. Idle after the open ramp costs zero timers.
  const frame = ui.useAnimationFrame ?? ((): Frame => [undefined, 0])
  const spinning = view?.agents.some(item => running(item.status)) ?? false
  const [clockRef, time] = frame(spinning || Date.now() - mountedAt < motion.rampMs + motion.tickMs ? motion.tickMs : null)
  const ramp = Math.min(1, Math.max(0, (Date.now() - mountedAt) / motion.rampMs))
  const spin = (offset = 0): string => SPIN[(Math.floor(time / motion.tickMs) + offset) % SPIN.length] ?? '⠋'

  const groups: readonly (readonly Item[])[] = [view?.tasks ?? [], view?.agents ?? [], view?.activity ?? []]
  const items = groups[focus] ?? []
  const index = Math.max(0, items.findIndex(item => item.id === selected[focus]))
  const opened = detail === undefined ? undefined : groups[detail.region]?.find(item => item.id === detail.id)
  const mode = layout(size.columns, size.rows)
  const content = Math.max(1, size.rows - t.chrome)
  const kpiRows = mode === 'tabs' || mode === 'small' ? 0 : Math.min(t.kpiRows, Math.max(0, content - t.minCard))
  const bodyRows = Math.max(t.minCard, content - kpiRows)
  const inner = Math.max(12, size.columns - 2 * t.inset)
  /** Above 21 body rows a stacked terminal fits all three cards; below it shows the focused one. */
  const stackedThree = mode === 'stacked' && bodyRows >= 21
  const cardHeight = (region: number): number => stackedThree ? (region === 2 ? bodyRows - 2 * Math.floor(bodyRows / 3) : Math.floor(bodyRows / 3)) : bodyRows
  /** Two-line rows for tasks/agents, a one-line feed plus a sparkline for activity. */
  const capacityOf = (region: number): number => Math.max(1, region === 2 ? cardHeight(region) - 4 : Math.floor((cardHeight(region) - 2) / 2))
  ui.useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { if (detail !== undefined) setDetail(undefined); else close(); return }
    if (key.tab && detail === undefined) { setFocus((focus + (key.shift ? 2 : 1)) % 3); return }
    const page = capacityOf(focus)
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
  if (mode === 'small') return h(ui.Box, { flexDirection: 'column', width: size.columns, height: Math.max(1, size.rows) }, text('Too small: resize'), text('Esc: chat'))

  const card = (title: string, opts: { key?: string; width: number; height: number; active?: boolean; accent?: string }, ...rows: unknown[]): unknown =>
    h(ui.Box, {
      key: opts.key, flexDirection: 'column', flexShrink: 1, minWidth: 0, width: opts.width, height: opts.height,
      borderStyle: 'round', borderColor: opts.active === true ? (opts.accent ?? t.focus) : t.card,
      borderText: { content: `─ ${title} `, position: 'top', align: 'start' }, paddingX: t.inset,
    }, ...rows)

  const kpiWidth = Math.max(12, Math.floor(inner / 3))
  const tasks = groups[0] ?? []
  const agents = groups[1] ?? []
  const done = tasks.filter(item => item.status === 'completed').length
  const live = agents.filter(item => running(item.status)).length
  const tokens = view?.tokens
  const input = tokens?.input
  const output = tokens?.output
  const total = input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0)
  const share = total === undefined || total === 0 ? 0 : (input ?? 0) / total
  const buckets = recent(groups[2] ?? [], 20, Date.now())
  const kpi = (label: string, value: string, ratio: number | undefined, meta: string): unknown => {
    const [filled, track] = gauge(ratio ?? 0, Math.max(1, kpiWidth - 4), ratio === undefined ? 0 : ramp)
    return card(label, { width: kpiWidth, height: kpiRows, active: false },
      text(value, { bold: true, color: t.focus }),
      ratio === undefined ? text('— no ratio reported', { color: t.muted }) : runs([[filled, { color: t.focus }], [track, { color: t.card }]]),
      text(ratio === undefined ? meta : `${Math.round(ratio * 100)}% · ${meta}`, { color: t.muted }))
  }

  const regionCard = (region: number, width: number): unknown => {
    const list = groups[region] ?? []
    const active = focus === region
    const cursor = active ? index : Math.max(0, list.findIndex(item => item.id === selected[region]))
    const page = capacityOf(region)
    const start = Math.floor(cursor / page) * page
    const shown = list.slice(start, start + page)
    const count = region === 0 ? `${view?.taskCount ?? '0/0'} done` : `${list.length}`
    const head = `${labels[region]} · ${count} · ${list.length === 0 ? 0 : start + 1}-${Math.min(start + page, list.length)}`
    const rows: unknown[] = []
    if (region === 2) {
      rows.push(text(sparkline(buckets), { color: active ? t.warning : t.muted }))
      for (const [offset, item] of shown.entries()) {
        const selectedRow = active && start + offset === cursor
        rows.push(runs([
          [`${selectedRow ? '>' : ' '}${mark(item.status)} `, { color: tone(item.status), bold: selectedRow }],
          [item.title, { color: t.text }],
          [` · ${item.meta}`, { color: t.muted }],
        ]))
      }
    } else {
      for (const [offset, item] of shown.entries()) {
        const selectedRow = active && start + offset === cursor
        const cursorGlyph = running(item.status) ? spin(offset) : mark(item.status)
        rows.push(runs([
          [`${selectedRow ? '>' : ' '}${cursorGlyph} `, { color: tone(item.status), bold: selectedRow }],
          [item.title, { color: t.text, bold: selectedRow }],
        ]))
        rows.push(runs([
          [`   ${item.status}`, { color: tone(item.status) }],
          [` · ${item.meta}`, { color: t.muted }],
        ]))
      }
    }
    if (list.length === 0) rows.push(text(region === 0 ? 'No native team tasks. Nothing was created.' : region === 1 ? 'No native children in this session.' : 'No public tool/output activity yet.', { color: t.muted }))
    return card(head, { key: labels[region], width, height: cardHeight(region), active, accent: t.focus }, ...rows)
  }

  let body: unknown
  if (detail !== undefined) {
    const lines = [opened?.title ?? 'This run/item is no longer in the native snapshot.', ...(opened?.detail ?? [])]
    body = card(`DETAIL · ${labels[detail.region]}`, { width: inner, height: bodyRows, active: true, accent: t.focus },
      h(ui.ScrollBox, { key: detail.id, ref: scroll, height: Math.max(1, bodyRows - 4), flexDirection: 'column' },
        ...lines.map((line, i) => h(ui.Text, { key: i, color: t.text }, clean(line, 4000)))))
  } else if (mode === 'wide') {
    const tasksWidth = Math.floor(inner * 0.38)
    const agentsWidth = Math.floor(inner * 0.34)
    body = h(ui.Box, { flexDirection: 'row', width: inner, height: bodyRows, flexShrink: 0 },
      regionCard(0, tasksWidth), regionCard(1, agentsWidth), regionCard(2, Math.max(8, inner - tasksWidth - agentsWidth)))
  } else if (stackedThree) {
    body = h(ui.Box, { flexDirection: 'column', width: inner, height: bodyRows, flexShrink: 0 }, regionCard(0, inner), regionCard(1, inner), regionCard(2, inner))
  } else body = regionCard(focus, inner)

  return h(ui.Box, { ref: clockRef, flexDirection: 'column', width: size.columns, height: size.rows, paddingX: t.inset },
    text(`${spinning ? spin() : '·'} CEULEN · Native Agent Dashboard · ${clean(channel.sessionId)}`, { bold: true, color: t.focus }),
    text(view?.lead ?? 'Loading native channel…'),
    text(state.error ?? view?.failure ?? view?.warning ?? 'Live native session · route and execution policy unchanged', { color: state.error === undefined && view?.failure === undefined ? t.warning : t.danger }),
    text(labels.map((label, region) => (region === focus ? `[${label}]` : label)).join(' · '), { color: t.muted }),
    ...(kpiRows === 0 ? [] : [h(ui.Box, { flexDirection: 'row', width: inner, height: kpiRows, flexShrink: 0 },
      kpi('TASKS', `${done}/${tasks.length}`, tasks.length === 0 ? undefined : done / tasks.length, `${tasks.length - done} open`),
      kpi('AGENTS', `${live}/${agents.length}`, agents.length === 0 ? undefined : live / agents.length, `${agents.length} ${agents.length === 1 ? 'child' : 'children'} · ${live} running`),
      kpi('TOKENS', `${compact(input)} / ${compact(output)}`, total === undefined ? undefined : share, `total ${compact(total)}`))]),
    body,
    text('Tab/Shift+Tab: region · arrows/PgUp/PgDn: select/scroll · Enter: detail', { color: t.muted }),
    text(detail ? 'Esc: overview · Esc again: chat' : 'Esc: chat · assign work in the original composer', { color: t.muted }),
    text('Source: DSH channel/team/subagents · usage per source, not summed', { color: t.muted }),
  )
}

/** A rebind remounts local navigation, never reuses another session's snapshot. */
export function createDashboardScene(): (props: SceneProps) => unknown {
  return props => props.React.createElement(DashboardSession, { ...props, key: `${props.channel.sessionId}:${props.channel.agentBindingGeneration ?? 0}` })
}
