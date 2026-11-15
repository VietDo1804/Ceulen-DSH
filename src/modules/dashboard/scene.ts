import { clean, project, watch, type Dashboard, type DashboardChannel, type Item } from './model.js'
import { tokens as t } from './tokens.js'

interface Key {
  escape?: boolean; tab?: boolean; shift?: boolean; return?: boolean
  upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean
  home?: boolean; end?: boolean; ctrl?: boolean
}
interface Scroll { scrollBy(n: number): void; scrollTo(n: number): void; scrollToBottom(): void }
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
  }
  channel: DashboardChannel
  close(): void
}

export function layout(columns: number, rows: number): 'small' | 'tabs' | 'stacked' | 'wide' {
  return columns < t.minColumns || rows < t.minRows ? 'small' : columns < t.stacked || rows < 24 ? 'tabs' : columns < t.wide ? 'stacked' : 'wide'
}
const labels = ['Tasks', 'Agents', 'Activity'] as const
function color(status: string): string {
  return status === 'failed' || status === 'error' || status === 'cancelled' ? t.danger : status === 'completed' || status === 'ok' ? t.success : t.text
}

function DashboardSession({ React: R, ui, channel, close }: SceneProps): unknown {
  const h = R.createElement
  const [state, setState] = R.useState<{ view?: Dashboard; error?: string }>({})
  const [focus, setFocus] = R.useState(0)
  const [selected, setSelected] = R.useState<readonly string[]>(['', '', ''])
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
  const groups: readonly (readonly Item[])[] = [view?.tasks ?? [], view?.agents ?? [], view?.activity ?? []]
  const items = groups[focus] ?? []
  const index = Math.max(0, items.findIndex(item => item.id === selected[focus]))
  const opened = detail === undefined ? undefined : groups[detail.region]?.find(item => item.id === detail.id)
  const mode = layout(size.columns, size.rows)
  const contentRows = Math.max(1, size.rows - 9)
  const capacity = Math.max(1, Math.floor((mode === 'stacked' ? contentRows / 3 : contentRows) - 3) / 2)
  const page = Math.max(1, Math.floor(capacity))
  ui.useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { if (detail !== undefined) setDetail(undefined); else close(); return }
    if (key.tab && detail === undefined) { setFocus((focus + (key.shift ? 2 : 1)) % 3); return }
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
  if (mode === 'small') return h(ui.Box, { flexDirection: 'column', width: size.columns, height: Math.max(1, size.rows) }, text('Too small: resize'), text('Esc: chat'))
  const panel = (region: number, width?: string): unknown => {
    const list = groups[region] ?? []
    const active = focus === region
    const cursor = active ? index : Math.max(0, list.findIndex(item => item.id === selected[region]))
    const start = Math.floor(cursor / page) * page
    return h(ui.Box, { key: labels[region], flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, width, borderStyle: 'single', borderColor: active ? t.lead : t.border, paddingX: t.inset },
      text((active ? '> ' : '  ') + labels[region] + ' ' + (region === 0 ? view?.taskCount ?? '0/0' : list.length) + ' [' + (list.length ? start + 1 : 0) + '-' + Math.min(start + page, list.length) + ']', { bold: active, color: active ? t.lead : t.muted }),
      ...(list.length ? list.slice(start, start + page).flatMap((item, offset) => [
        text((active && start + offset === cursor ? '> ' : '  ') + '[' + item.status + '] ' + item.title, { key: item.id + ':title', color: color(item.status), bold: active && start + offset === cursor }),
        text('  ' + item.meta, { key: item.id + ':meta', color: t.muted }),
      ]) : [text(region === 0 ? 'No native team tasks. Nothing was created.' : region === 1 ? 'No native children in this session.' : 'No public tool/output activity yet.', { key: 'empty', color: t.muted })]),
    )
  }
  let content: unknown
  if (detail !== undefined) {
    content = h(ui.ScrollBox, { key: detail.id, ref: scroll, height: contentRows, flexDirection: 'column' },
      ...[opened?.title ?? 'This run/item is no longer in the native snapshot.', ...(opened?.detail ?? [])].map((line, i) => h(ui.Text, { key: i, color: t.text }, clean(line, 4000))),
    )
  } else if (mode === 'tabs') content = panel(focus)
  else content = h(ui.Box, { flexDirection: mode === 'wide' ? 'row' : 'column', height: contentRows, flexShrink: 1 }, ...labels.map((_, region) => panel(region, mode === 'wide' ? region === 2 ? '34%' : '33%' : undefined)))
  return h(ui.Box, { flexDirection: 'column', width: size.columns, height: size.rows, backgroundColor: t.page, paddingX: t.inset },
    text('Native Agent Dashboard · session ' + clean(channel.sessionId), { bold: true, color: t.lead }),
    text(view?.lead ?? 'Loading native channel…'),
    text(state.error ?? view?.failure ?? view?.warning ?? 'Live native session · route and execution policy unchanged', { color: state.error || view?.failure ? t.danger : t.warning }),
    text(labels.map((label, region) => (focus === region ? '[' + label + ']' : label)).join(' · '), { color: t.muted }),
    content,
    text('Tab/Shift+Tab: region · arrows/PgUp/PgDn: select/scroll · Enter: detail', { color: t.muted }),
    text(detail ? 'Esc: overview · Esc again: chat' : 'Esc: chat · assign work in the original composer', { color: t.muted }),
    text('Source: DSH channel/team/subagents · usage per source, not summed', { color: t.muted }),
  )
}

/** A rebind remounts local navigation, never reuses another session's snapshot. */
export function createDashboardScene(): (props: SceneProps) => unknown {
  return props => props.React.createElement(DashboardSession, { ...props, key: props.channel.sessionId + ':' + (props.channel.agentBindingGeneration ?? 0) })
}
