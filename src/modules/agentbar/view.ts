import { activity, bandVisible, duration, headline, LINGER_MS, meters, nameOf, shortModel, summarize, type AgentRow, type AgentStore, type Summary } from './model.js'

/** The pointer-only kit `tuiStatus.registerView` hands a component. */
export interface BandProps {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void]
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T
  }
  ui: {
    Box: unknown
    Text: unknown
    useTerminalSize(): { columns: number; rows: number }
  }
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** Spinner cadence; the band's clock runs only while it is visible. */
const TICK_MS = 120
/** Role + label cells: wide terminals keep whole labels. */
const nameCells = (columns: number): number => (columns >= 120 ? 48 : 34)

export type Tone = 'accent' | 'success' | 'error' | 'warning' | 'subtle' | undefined
/** One band line as coloured runs; the last run is the one that truncates. */
export interface Line {
  readonly lead: readonly (readonly [string, Tone, boolean?])[]
  readonly flex: string
  readonly flexTone?: Tone
  readonly tail?: string
}

const clip = (text: string, cells: number): string => (text.length > cells ? `${text.slice(0, cells - 1)}…` : text)

function agentLine(row: AgentRow, now: number, columns: number, frame: number): Line {
  const model = columns >= 110 ? shortModel(row) : undefined
  const tail = columns >= 70 ? meters(row, now).join(' · ') : duration(now - row.startedAt)
  return {
    lead: [
      [`  ${SPIN[frame % SPIN.length]} `, 'accent'],
      [clip(nameOf(row), nameCells(columns)), undefined, true],
      ...(model === undefined ? [] : [[`  ${model}`, 'subtle'] as const]),
      ['  ', undefined],
    ],
    flex: activity(row),
    flexTone: 'subtle',
    tail,
  }
}

/**
 * Band lines for one moment: a headline, then up to two running children (a
 * third and later collapse into "+N more"). After the batch ends, only the
 * headline lingers. Pure, so tests pin the layout without a host.
 */
export function bandLines(summary: Summary, now: number, columns: number, frame = 0): Line[] {
  if (!bandVisible(summary, now)) return []
  const running = summary.running
  const hint = columns >= 90 ? 'Ctrl+B panel · /agentbar' : undefined
  if (running.length === 0) {
    const failed = summary.failed + summary.cancelled > 0
    return [{
      lead: [[failed ? '◆ ' : '✓ ', failed ? 'warning' : 'success'], ['Subagents', undefined, true], ['  ', undefined]],
      flex: `${headline(summary)} · results are in the chat`,
      flexTone: 'subtle',
      ...(hint === undefined ? {} : { tail: hint }),
    }]
  }
  const lines: Line[] = [{
    lead: [['◆ ', 'accent'], ['Subagents', undefined, true], ['  ', undefined]],
    flex: headline(summary),
    ...(hint === undefined ? {} : { tail: hint }),
  }]
  const shown = running.length <= 2 ? running : running.slice(0, 1)
  for (const [index, row] of shown.entries()) lines.push(agentLine(row, now, columns, frame + index * 3))
  if (running.length > 2) {
    const rest = running.slice(1)
    lines.push({
      lead: [['  ', undefined], [`+${rest.length} more running`, 'accent'], ['  ', undefined]],
      flex: rest.map(row => row.role ?? row.label).join(', '),
      flexTone: 'subtle',
    })
  }
  return lines
}

/** The registered component: reads the store, ticks only while visible. */
export function createBand(store: AgentStore): (props: BandProps) => unknown {
  return function CeulenAgentBand({ React: R, ui }: BandProps): unknown {
    const h = R.createElement
    R.useSyncExternalStore(store.subscribe, store.getVersion)
    // The tick only forces a re-render; time is read fresh below.
    const [, setTick] = R.useState(0)
    const { columns } = ui.useTerminalSize()
    const now = Date.now()
    const summary = summarize(store.batch())
    const covered = store.panelVisible || store.teamVisible
    const spinning = summary.running.length > 0 && !covered
    // Lingering summary: one wake-up to hide it, no frames.
    const hideAt = spinning || summary.lastEnd === undefined ? undefined : summary.lastEnd + LINGER_MS
    R.useEffect(() => {
      if (spinning) {
        const timer = setInterval(() => setTick(tick => tick + 1), TICK_MS)
        return () => clearInterval(timer)
      }
      if (hideAt === undefined || hideAt <= Date.now()) return undefined
      const timer = setTimeout(() => setTick(tick => tick + 1), hideAt - Date.now() + 50)
      return () => clearTimeout(timer)
    }, [spinning, hideAt])
    // A side panel (Subagents, or Team in orchestrator mode) shows the same children in full; never both.
    if (covered) return null
    const lines = bandLines(summary, now, columns, Math.floor(now / TICK_MS))
    if (lines.length === 0) return null
    const text = (value: string, tone: Tone, bold = false, key?: number): unknown =>
      h(ui.Text, { key, wrap: 'truncate-end', bold, ...(tone === 'subtle' ? { dimColor: true } : tone === undefined ? {} : { color: tone }) }, value)
    return h(ui.Box, { flexDirection: 'column', flexShrink: 0 }, ...lines.map((line, row) =>
      h(ui.Box, { key: row, flexDirection: 'row', width: '100%', height: 1, overflow: 'hidden' },
        h(ui.Box, { flexShrink: 0 }, ...line.lead.map(([value, tone, bold], index) => text(value, tone, bold, index))),
        h(ui.Box, { flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }, text(line.flex, line.flexTone)),
        ...(line.tail === undefined ? [] : [h(ui.Box, { flexShrink: 0, paddingLeft: 2 }, text(line.tail, 'subtle'))]),
      )))
  }
}
