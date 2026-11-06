import { formatTokens } from './dna.js'
import type { ContextUsage, ReportOptions } from './report.js'


const ANSI = { reset: '\u001B[0m', bold: '\u001B[1m' } as const
/** SGR colour escapes; the literal is unavoidable, so the rule is silenced. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences
const ANSI_SGR = /\u001B\[[0-9;]*m/gu

/**
 * Dashboard swatches (dark terminals). The used categories mirror the Claude
 * Code /context palette; the autocompact buffer keeps the brighter warning
 * tone and free cells stay quiet so the free field reads as a surface.
 */
const DASHBOARD_COLORS = {
  system: '\u001B[38;2;215;175;95m',
  tools: '\u001B[38;2;215;135;95m',
  messages: '\u001B[38;2;198;198;198m',
  free: '\u001B[38;2;117;131;154m',
  buffer: '\u001B[38;2;255;167;89m',
  secondary: '\u001B[38;2;208;215;226m',
} as const

const DASHBOARD_GLYPHS = { used: '⛁', free: '⛶', buffer: '⛝' } as const

/** Grid geometry: 10 rows; 20 columns per 1M tokens of window, else 10. */
const DASHBOARD_ROWS = 10
const DASHBOARD_GAP = 2

const GLYPHS = { system: '█', tools: '▓', messages: '▒', free: '·', buffer: '░' } as const

function strong(text: string): string {
  return `${ANSI.bold}${text}${ANSI.reset}`
}

function quiet(text: string): string {
  return `${DASHBOARD_COLORS.secondary}${text}${ANSI.reset}`
}

export function isDashboardGlyph(char: string): boolean {
  return char === DASHBOARD_GLYPHS.used || char === DASHBOARD_GLYPHS.free || char === DASHBOARD_GLYPHS.buffer
}

/** Visible terminal width of a styled line; the draughts glyphs are 2 cells. */
export function visibleWidth(text: string): number {
  let width = 0
  for (const char of text.replace(ANSI_SGR, '')) width += isDashboardGlyph(char) ? 2 : 1
  return width
}

interface DashboardRow {
  key: 'system' | 'tools' | 'messages' | 'free' | 'buffer'
  label: string
  tokens: number
  color: string
  glyph: string
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return '0.0'
  return (Math.min(part, whole) / whole * 100).toFixed(1)
}

export function dashboardRows(usage: ContextUsage, windowTokens: number): DashboardRow[] {
  const buffer = usage.bufferTokens ?? 0
  const free = Math.max(0, windowTokens - usage.used - buffer)
  const rows: DashboardRow[] = [
    { key: 'system', label: 'System prompt:', tokens: usage.systemTokens, color: DASHBOARD_COLORS.system, glyph: DASHBOARD_GLYPHS.used },
    { key: 'tools', label: 'System tools:', tokens: usage.toolsTokens, color: DASHBOARD_COLORS.tools, glyph: DASHBOARD_GLYPHS.used },
    { key: 'messages', label: 'Messages:', tokens: usage.messageTokens, color: DASHBOARD_COLORS.messages, glyph: DASHBOARD_GLYPHS.used },
    { key: 'free', label: 'Free space:', tokens: free, color: DASHBOARD_COLORS.free, glyph: DASHBOARD_GLYPHS.free },
  ]
  if (usage.bufferTokens !== undefined) {
    rows.push({ key: 'buffer', label: 'Autocompact buffer:', tokens: usage.bufferTokens, color: DASHBOARD_COLORS.buffer, glyph: DASHBOARD_GLYPHS.buffer })
  }
  return rows
}

/**
 * The right-hand column. It is exactly ten lines (model, route, total, blank,
 * heading, and the legend), so every line pairs with one grid row and the
 * panel never needs a continuation indent.
 */
export function dashboardPanel(usage: ContextUsage, header: { displayName?: string; route?: string }, windowTokens: number): string[] {
  const lines: string[] = []
  if (header.displayName !== undefined) {
    lines.push(`${ANSI.reset}${strong(header.displayName)} ${quiet(`(${formatTokens(windowTokens)} context)`)}`)
  }
  if (header.route !== undefined && header.route.length > 0) lines.push(`${ANSI.reset}${quiet(header.route)}`)
  lines.push(`${ANSI.reset}${strong(`${formatTokens(usage.used)}/${formatTokens(windowTokens)}`)} ${quiet(`tokens (${percent(usage.used, windowTokens)}%)`)}`)
  lines.push('')
  lines.push(`${ANSI.reset}${quiet(usage.estimated === true ? 'Estimated usage by category (estimated)' : 'Estimated usage by category')}`)
  for (const row of dashboardRows(usage, windowTokens)) {
    lines.push(
      `${ANSI.reset}${row.color}${row.glyph}${ANSI.reset} ${strong(row.label)} ${strong(formatTokens(row.tokens))} ${quiet('tokens')} ${quiet(`(${percent(row.tokens, windowTokens)}%)`)}`,
    )
  }
  return lines
}

/** The widest grid (20/10/5 columns) whose card still fits the terminal. */
export function dashboardColumns(windowTokens: number, panelWidth: number, columns: number | undefined): number {
  const available = Math.max(1, (columns ?? 120) - 2)
  const base = windowTokens >= 1_000_000 ? 20 : 10
  const candidates = base === 20 ? [20, 10, 5] : [10, 5]
  for (const cols of candidates) {
    if (cols * 2 + DASHBOARD_GAP + panelWidth <= available) return cols
  }
  return 0
}

/**
 * Per-category cell counts, rounded independently (a non-empty category keeps
 * one cell). Categories come first, free fills the middle, and the reserved
 * autocompact buffer closes the grid — the buffer is the end of the line.
 */
export function dashboardCells(rows: readonly DashboardRow[], windowTokens: number, total: number): Array<{ color: string; glyph: string }> {
  const cells: Array<{ color: string; glyph: string }> = []
  let remaining = total
  for (const row of rows) {
    if (row.key === 'free' || row.key === 'buffer') continue
    const want = row.tokens > 0 ? Math.max(1, Math.round(row.tokens / windowTokens * total)) : 0
    const count = Math.min(want, remaining)
    remaining -= count
    for (let i = 0; i < count; i += 1) cells.push({ color: row.color, glyph: row.glyph })
  }
  const bufferRow = rows.find(row => row.key === 'buffer')
  if (bufferRow !== undefined && bufferRow.tokens > 0 && remaining > 0) {
    const want = Math.max(1, Math.round(bufferRow.tokens / windowTokens * total))
    const count = Math.min(want, remaining)
    remaining -= count
    const freeRow = rows.find(row => row.key === 'free')
    const freeCount = remaining
    for (let i = 0; i < freeCount; i += 1) cells.push({ color: freeRow?.color ?? DASHBOARD_COLORS.free, glyph: DASHBOARD_GLYPHS.free })
    for (let i = 0; i < count; i += 1) cells.push({ color: bufferRow.color, glyph: bufferRow.glyph })
    return cells
  }
  const freeRow = rows.find(row => row.key === 'free')
  for (let i = 0; i < remaining; i += 1) cells.push({ color: freeRow?.color ?? DASHBOARD_COLORS.free, glyph: DASHBOARD_GLYPHS.free })
  return cells
}

export function dashboardGrid(cells: ReadonlyArray<{ color: string; glyph: string }>, cols: number): string[] {
  const rows: string[] = []
  for (let row = 0; row < DASHBOARD_ROWS; row += 1) {
    const slice = cells.slice(row * cols, (row + 1) * cols)
    let line = ANSI.reset
    let index = 0
    while (index < slice.length) {
      const first = slice[index]!
      let end = index + 1
      while (end < slice.length && slice[end]!.color === first.color && slice[end]!.glyph === first.glyph) end += 1
      line += `${first.color}${first.glyph.repeat(end - index)}${ANSI.reset}`
      index = end
    }
    rows.push(line)
  }
  return rows
}

export function buildColoredReport(usage: ContextUsage, header: { displayName?: string; route?: string }, options: ReportOptions): string {
  const windowTokens = usage.windowTokens!
  const panel = dashboardPanel(usage, header, windowTokens)
  const panelWidth = panel.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0)
  const cols = dashboardColumns(windowTokens, panelWidth, options.columns)
  if (cols === 0) {
    // Too narrow for a side-by-side card: keep the palette, stack the blocks.
    const cells = dashboardCells(dashboardRows(usage, windowTokens), windowTokens, 10 * DASHBOARD_ROWS)
    return [...panel, '', ...dashboardGrid(cells, 10)].join('\n')
  }
  const cells = dashboardCells(dashboardRows(usage, windowTokens), windowTokens, cols * DASHBOARD_ROWS)
  const grid = dashboardGrid(cells, cols)
  const lines = grid.map((line, index) => `${line}${' '.repeat(DASHBOARD_GAP)}${panel[index] ?? ''}`)
  for (let index = DASHBOARD_ROWS; index < panel.length; index += 1) {
    lines.push(`${' '.repeat(cols * 2 + DASHBOARD_GAP)}${panel[index]}`)
  }
  return lines.join('\n')
}

/**
 * The plain dashboard: header, proportional block grid, and the per-category
 * legend. Without a known window there is nothing to be proportional to —
 * the grid and the free/buffer rows are dropped.
 */
export function buildPlainReport(usage: ContextUsage, header: { displayName?: string; route?: string } = {}): string {
  const lines: string[] = []
  const window_ = usage.windowTokens
  if (header.displayName !== undefined) {
    lines.push(window_ === undefined ? header.displayName : `${header.displayName} (${formatTokens(window_)} context)`)
  }
  if (header.route !== undefined && header.route.length > 0) lines.push(header.route)
  if (window_ === undefined) {
    lines.push(`${formatTokens(usage.used)} tokens${usage.estimated === true ? ' (estimated)' : ''}`)
    return lines.join('\n')
  }
  lines.push(`${formatTokens(usage.used)}/${formatTokens(window_)} tokens (${percent(usage.used, window_)}%)`)
  lines.push('')

  const cols = 48
  const rows = 8
  const total = cols * rows
  const cellsFor = (tokens: number): number => Math.max(0, Math.round(tokens / window_ * total))
  const system = Math.min(cellsFor(usage.systemTokens), total)
  const tools = Math.min(cellsFor(usage.toolsTokens), total - system)
  const messages = Math.min(cellsFor(usage.messageTokens), total - system - tools)
  const buffer = Math.min(usage.bufferTokens === undefined ? 0 : cellsFor(usage.bufferTokens), total - system - tools - messages)
  const free = Math.max(0, total - system - tools - messages - buffer)
  const counts: Array<[string, number]> = [
    [GLYPHS.system, system],
    [GLYPHS.tools, tools],
    [GLYPHS.messages, messages],
    [GLYPHS.free, free],
    [GLYPHS.buffer, buffer],
  ]
  let flat = ''
  for (const [glyph, count] of counts) flat += glyph.repeat(count)
  for (let row = 0; row < rows; row += 1) lines.push(flat.slice(row * cols, (row + 1) * cols))
  lines.push('')

  lines.push(usage.estimated === true ? 'Estimated usage by category (estimated)' : 'Estimated usage by category')
  const row = (glyph: string, label: string, tokens: number): string =>
    `${glyph} ${label.padEnd(19)} ${formatTokens(tokens).padStart(5)} tokens (${percent(tokens, window_)}%)`
  lines.push(row(GLYPHS.system, 'System prompt:', usage.systemTokens))
  lines.push(row(GLYPHS.tools, 'System tools:', usage.toolsTokens))
  lines.push(row(GLYPHS.messages, 'Messages:', usage.messageTokens))
  lines.push(row(GLYPHS.free, 'Free space:', Math.max(0, window_ - usage.used - (usage.bufferTokens ?? 0))))
  if (usage.bufferTokens !== undefined) lines.push(row(GLYPHS.buffer, 'Autocompact buffer:', usage.bufferTokens))
  return lines.join('\n')
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '')
}
