import type { MessageLike } from '../../core/types.js'
import { buildColoredReport, buildPlainReport } from './dashboard.js'

export interface ContextUsage {
  windowTokens?: number
  used: number
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  bufferTokens?: number
  estimated?: boolean
}

export interface CompactionOptions {
  thresholdRatio?: number
  headroomTokens?: number
  reservedOutput?: number
}

/**
 * The dsh-compaction-basic pressure trigger, restated as reserved space:
 * compaction arms at `min(W × ratio, W − reservedOutput − headroom)`, so the
 * buffer is everything above that line. Defaults mirror the plugin
 * (0.8 / 65536; reserved output comes from the resolved model cap).
 */
export function compactionBuffer(windowTokens: number, options: CompactionOptions = {}): number {
  const ratio = Math.min(1, Math.max(0, options.thresholdRatio ?? 0.8))
  const headroom = Math.max(0, options.headroomTokens ?? 65_536)
  const reserved = Math.max(0, options.reservedOutput ?? 0)
  const threshold = Math.min(windowTokens * ratio, windowTokens - reserved - headroom)
  return Math.max(0, Math.min(windowTokens, Math.floor(windowTokens - threshold)))
}



/** Options for the ANSI dashboard. Without `color` the report stays plain. */
export interface ReportOptions {
  /**
   * Emit the Claude Code-style colored dashboard. The TUI strips escape
   * sequences from registry reports; `scripts/tui-context-patch.mjs` asks for
   * this mode and keeps only SGR (color) sequences from the result.
   */
  color?: boolean
  /** Terminal columns for the side-by-side fit; defaults to 120. */
  columns?: number
}

/** The dashboard: ANSI card when asked for color, plain blocks otherwise. */
export function buildReport(
  usage: ContextUsage,
  header: { displayName?: string; route?: string } = {},
  options: ReportOptions = {},
): string {
  if (options.color === true && usage.windowTokens !== undefined) return buildColoredReport(usage, header, options)
  return buildPlainReport(usage, header)
}

/** Role-based fallback split when the breakdown projection is not composed. */
export function estimateBreakdown(messages: readonly MessageLike[]): { systemTokens: number; messageTokens: number } {
  let system = 0
  let other = 0
  for (const message of messages) {
    let chars = 0
    for (const block of message.content) {
      const text = (block as { type?: string; text?: unknown }).text
      if (typeof text === 'string') chars += text.length
    }
    if (message.role === 'system') system += chars
    else other += chars
  }
  const tokens = (chars: number): number => Math.ceil(chars / 4)
  return { systemTokens: tokens(system), messageTokens: tokens(other) }
}
