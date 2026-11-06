/**
 * DNA mode — the context window as a per-item fingerprint.
 *
 * A text port of the `dsh-context` web visualization (bowenliang123/dsh-context):
 * one band per model-visible item in reading order (system prompt, the tool
 * schemas, then the messages) instead of one band per category, so a fat tool
 * result or a bloated tool schema is visible by name.
 *
 * Pricing mirrors `@deepseek-ai/dsh-token-meter`'s fixed-density estimate
 * (chars/4 plus per-block framing), so the band widths agree with the totals
 * the dashboard already shows. Nothing here imports the host: the collector
 * reads the session's plain event log.
 *
 * Each `request/header` freezes the surface the model saw at that call, and a
 * compaction drops the sequences it shadowed — which is the replay the scene
 * steps through.
 */

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

/** Categories, in the order the model reads them. */
export type DnaCategory = 'system' | 'tools' | 'messages' | 'other'

export interface DnaItem {
  /** Stable across requests (`sys:<seq>`, `tool:<name>`, `msg:<seq>`). */
  key: string
  cat: DnaCategory
  label: string
  tokens: number
}

export interface DnaSnapshot {
  /** Seq of the `request/header` this frame was assembled from. */
  seq: number
  turn: number
  time?: number
  items: DnaItem[]
  total: number
}

/** The subset of a session event the collector reads. */
export interface DnaEvent {
  seq?: number
  type: string
  time?: number
  data?: unknown
  surfaceOp?: string
}

interface BlockLike {
  type?: unknown
  text?: unknown
  name?: unknown
  arguments?: unknown
}

interface MessageLike {
  role?: unknown
  content?: readonly BlockLike[]
  source?: { callId?: unknown }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Content price: fixed density plus per-block structural framing. */
function priceBlocks(blocks: readonly BlockLike[]): number {
  let tokens = 0
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') {
      tokens += Math.ceil(text(block.text).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    } else if (block.type === 'tool-call') {
      tokens += Math.ceil(text(block.name).length / CHARS_PER_TOKEN)
        + Math.ceil(text(block.arguments).length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    } else {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** The system prompt serializes as one plain string, so it prices without block framing. */
function priceSystem(blocks: readonly BlockLike[]): number {
  if (blocks.length === 0) return 0
  let chars = 0
  for (const block of blocks) {
    chars += block.type === 'text' ? text(block.text).length : JSON.stringify(block).length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Price one model-visible message the way the host meter does. */
export function priceMessage(message: MessageLike | undefined): number {
  const content = Array.isArray(message?.content) ? message.content : []
  if (message?.role === 'system') return priceSystem(content)
  return priceBlocks(content) + BLOCK_OVERHEAD
}

/** Price one tool schema on its own (the meter prices the whole array). */
export function priceTool(tool: unknown): number {
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(tool ?? null).length / CHARS_PER_TOKEN)
}

/** `1234` → `1.2K`, `1_000_000` → `1M` — the compact dashboard style. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '?'
  const abs = Math.abs(value)
  const trim = (n: number): string => n.toFixed(1).replace(/\.0$/, '')
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}K`
  return String(Math.round(value))
}

interface SurfaceNode {
  seq: number
  cat: DnaCategory
  label: string
  tokens: number
}

function messageOf(event: DnaEvent): MessageLike | undefined {
  const data = event.data as { message?: MessageLike; content?: readonly BlockLike[]; role?: unknown } | undefined
  if (data === undefined) return undefined
  switch (event.type) {
    case 'user/message':
      return data as MessageLike
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return data.message
    default:
      return undefined
  }
}

const LABELS: Record<string, string> = {
  'user/message': 'you',
  'assistant/message': 'reply',
  'developer/message': 'dev',
  'system/message': 'sys',
}

export interface CollectOptions {
  /** Snapshots kept (the replay window). Defaults to 200. */
  limit?: number
}

/**
 * Walk the session log once and freeze the surface at every `request/header`.
 *
 * A surface event appends its priced node; a `compaction/summary` or
 * `compaction/prune` drops the sequences it shadowed. Events without
 * `surfaceOp` are treated as appends, so pre-v4 logs still replay.
 */
export function collectSnapshots(events: readonly DnaEvent[], options: CollectOptions = {}): DnaSnapshot[] {
  const limit = Math.max(1, Math.floor(options.limit ?? 200))
  const surface: SurfaceNode[] = []
  const callNames = new Map<string, string>()
  const snapshots: DnaSnapshot[] = []
  let turn = 0

  for (const event of events) {
    switch (event.type) {
      case 'tool/call': {
        const data = event.data as { callId?: unknown; name?: unknown } | undefined
        const callId = text(data?.callId)
        const name = text(data?.name)
        if (callId !== '') callNames.set(callId, name === '' ? 'tool' : name)
        continue
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const data = event.data as { shadowedSeqs?: unknown } | undefined
        const shadowed = Array.isArray(data?.shadowedSeqs) ? new Set(data.shadowedSeqs) : undefined
        if (shadowed === undefined) continue
        for (let index = surface.length - 1; index >= 0; index -= 1) {
          const node = surface[index]
          if (node !== undefined && shadowed.has(node.seq)) surface.splice(index, 1)
        }
        continue
      }
      case 'request/header': {
        const data = event.data as { header?: { tools?: unknown } } | undefined
        const tools = Array.isArray(data?.header?.tools) ? data.header.tools : []
        const toolItems: DnaItem[] = tools.map(tool => {
          const name = text((tool as { name?: unknown }).name) || 'tool'
          return { key: `tool:${name}`, cat: 'tools', label: name, tokens: priceTool(tool) }
        })
        const systems = surface.filter(node => node.cat === 'system')
        const messages = surface.filter(node => node.cat !== 'system')
        const items: DnaItem[] = [
          ...systems.map(node => ({ key: `sys:${node.seq}`, cat: 'system' as const, label: node.label, tokens: node.tokens })),
          ...toolItems,
          ...messages.map(node => ({ key: `msg:${node.seq}`, cat: 'messages' as const, label: node.label, tokens: node.tokens })),
        ]
        const snapshot: DnaSnapshot = {
          seq: event.seq ?? 0,
          turn: Math.max(1, turn),
          ...event.time === undefined ? {} : { time: event.time },
          items,
          total: items.reduce((sum, item) => sum + item.tokens, 0),
        }
        snapshots.push(snapshot)
        if (snapshots.length > limit) snapshots.shift()
        continue
      }
      default:
        break
    }

    const message = messageOf(event)
    if (message === undefined) continue
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    const role = text(message.role)
    const callId = text(message.source?.callId)
    const label = event.type === 'tool/result'
      ? `tool:${callNames.get(callId) ?? 'result'}`
      : LABELS[event.type] ?? role
    if (event.type === 'user/message') turn += 1
    surface.push({
      seq: event.seq ?? surface.length,
      cat: event.type === 'system/message' ? 'system' : 'messages',
      label,
      tokens: priceMessage(message),
    })
  }

  return snapshots
}

/**
 * Spread `width` cells across `weights` proportionally: floor first, then hand
 * the remainder to the largest fractional parts. The bar is exactly `width`
 * cells wide, and a tiny item can round to zero (it still shows in the legend).
 */
export function allocate(weights: readonly number[], width: number): number[] {
  const cells = new Array<number>(weights.length).fill(0)
  const budget = Math.max(0, Math.floor(width))
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
  if (budget === 0 || weights.length === 0) return cells
  if (total <= 0) {
    cells[0] = budget
    return cells
  }
  const fractions: Array<{ index: number; rest: number }> = []
  let used = 0
  for (let index = 0; index < weights.length; index += 1) {
    const exact = (Math.max(0, weights[index] ?? 0) / total) * budget
    const base = Math.floor(exact)
    cells[index] = base
    used += base
    fractions.push({ index, rest: exact - base })
  }
  fractions.sort((a, b) => b.rest - a.rest || a.index - b.index)
  let slot = 0
  while (used < budget && fractions.length > 0) {
    const target = fractions[slot % fractions.length]
    slot += 1
    if (target === undefined) break
    cells[target.index] = (cells[target.index] ?? 0) + 1
    used += 1
  }
  return cells
}

export interface GenomeOptions {
  width: number
  /** Bands kept individually; the rest fold into one `other` band. Defaults to 24. */
  maxBands?: number
}

export interface Band {
  key: string
  label: string
  cat: DnaCategory
  tokens: number
  cells: number
}

/** Pick the bands that fit the width, preserving reading order. */
export function layoutGenome(snapshot: DnaSnapshot, options: GenomeOptions): Band[] {
  const width = Math.max(1, Math.floor(options.width))
  const maxBands = Math.max(1, Math.min(options.maxBands ?? 24, width))
  const ordered = snapshot.items
  if (ordered.length === 0) return []

  let bands: Array<Omit<Band, 'cells'>> = ordered.map(item => ({ ...item }))
  if (bands.length > maxBands) {
    const keep = new Set(
      [...ordered]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, Math.max(1, maxBands - 1))
        .map(item => item.key),
    )
    const kept = bands.filter(band => keep.has(band.key))
    const folded = bands.filter(band => !keep.has(band.key))
    const tokens = folded.reduce((sum, band) => sum + band.tokens, 0)
    bands = [...kept, { key: 'other', cat: 'other', label: `+${folded.length} more`, tokens }]
  }

  const cells = allocate(bands.map(band => band.tokens), width)
  return bands.map((band, index) => ({ ...band, cells: cells[index] ?? 0 }))
}

/** Glyph per category, matching the dashboard's block language. */
export const BAND_GLYPHS: Record<DnaCategory, string> = {
  system: '█',
  tools: '▓',
  messages: '▒',
  other: '░',
}

/** Truecolor per category, matching the dashboard palette. */
export const BAND_COLORS: Record<DnaCategory, string> = {
  system: '\u001B[38;2;215;175;95m',
  tools: '\u001B[38;2;215;135;95m',
  messages: '\u001B[38;2;198;198;198m',
  other: '\u001B[38;2;117;131;154m',
}

const RESET = '\u001B[0m'

/** One genome row: a band per item, in the order the model reads them. */
export function renderGenome(snapshot: DnaSnapshot, options: GenomeOptions & { color?: boolean }): string {
  const bands = layoutGenome(snapshot, options)
  const color = options.color === true
  let row = ''
  for (const band of bands) {
    const glyphs = BAND_GLYPHS[band.cat].repeat(band.cells)
    row += color ? `${BAND_COLORS[band.cat]}${glyphs}${RESET}` : glyphs
  }
  return row
}

/** `T3 · 41 items · 128.4K tokens` */
export function describeSnapshot(snapshot: DnaSnapshot, step?: { index: number; count: number }): string {
  const position = step === undefined ? '' : ` · step ${step.index + 1}/${step.count}`
  return `T${snapshot.turn}${position} · ${snapshot.items.length} items · ${formatTokens(snapshot.total)} tokens`
}

/** The biggest items, one line each — the legend beside the bar. */
export function renderItems(
  snapshot: DnaSnapshot,
  options: { limit?: number; focus?: string; color?: boolean } = {},
): string[] {
  const limit = Math.max(1, options.limit ?? 6)
  const share = snapshot.total > 0 ? snapshot.total : 1
  const color = options.color === true
  return [...snapshot.items]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
    .map(item => {
      const marker = options.focus === item.key ? '❯' : ' '
      const swatch = `${BAND_GLYPHS[item.cat]}`
      const glyph = color ? `${BAND_COLORS[item.cat]}${swatch}${RESET}` : swatch
      const percent = ((item.tokens / share) * 100).toFixed(1)
      return `${marker}${glyph} ${item.label.padEnd(16).slice(0, 16)} ${formatTokens(item.tokens).padStart(7)} ${percent.padStart(5)}%`
    })
}

/** A full static frame: header, genome row, legend. Used when no scene is mounted. */
export function renderFrame(
  snapshot: DnaSnapshot,
  options: GenomeOptions & { limit?: number; focus?: string; color?: boolean } = { width: 80 },
): string[] {
  return [
    describeSnapshot(snapshot),
    renderGenome(snapshot, options),
    ...renderItems(snapshot, options),
  ]
}
