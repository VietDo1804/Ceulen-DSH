import type { AgentLike, PluginContext } from '../../core/types.js'
import { buildReport, compactionBuffer, estimateBreakdown, type ReportOptions } from './report.js'

/** Structural views of the optional harness services this module reads. */
export interface ResolvedModelInfoLike {
  name?: string
  id?: string
  context?: { contextWindow?: number }
  defaultMaxTokens?: number
}

export interface LlmLike {
  resolveModelInfo?(provider: string, model: string): Promise<ResolvedModelInfoLike>
}

/** Host state of token-meter's `contextPressure` projection unit. */
export interface PressureState {
  contextWindow?: number
  pressureTokens?: number
  surfaceTokens: number
  sampledSurfaceTokens?: number
}

/** Host state of token-meter's `contextBreakdown` projection unit. */
export interface BreakdownState {
  breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number }
}

export interface ProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

export interface MeterLike {
  measure(session: unknown): { totalTokens?: number; surfaceTokens?: number }
}

export interface CompactionConfigLike {
  config?: { thresholdRatio?: number; headroomTokens?: number }
}

interface Collected {
  info?: ResolvedModelInfoLike
  pressure?: PressureState
  breakdown?: BreakdownState
  measure?: { totalTokens?: number; surfaceTokens?: number }
  compaction?: CompactionConfigLike
}

async function collect(ctx: PluginContext, agent: AgentLike): Promise<Collected> {
  const read = (service: string): unknown => {
    try {
      return ctx.get(service, false)
    } catch {
      return undefined
    }
  }
  const collected: Collected = {
    compaction: read('compaction') as CompactionConfigLike | undefined,
  }
  const llm = read('llm') as LlmLike | undefined
  const provider = agent.options.provider
  const model = agent.options.model
  if (llm?.resolveModelInfo !== undefined && provider !== undefined && model !== undefined) {
    // Display name and output cap only; every field is optional.
    try {
      collected.info = await llm.resolveModelInfo(provider, model)
    } catch {
      // Optional display name.
    }
  }
  const projections = read('sessionProjections') as ProjectionsLike | undefined
  if (typeof projections?.stateOf === 'function') {
    try {
      collected.pressure = projections.stateOf(agent.session, 'contextPressure') as PressureState | undefined
      collected.breakdown = projections.stateOf(agent.session, 'contextBreakdown') as BreakdownState | undefined
    } catch {
      // Optional projections.
    }
  }
  const meter = read('tokenMeter') as MeterLike | undefined
  if (typeof meter?.measure === 'function') {
    try {
      collected.measure = meter.measure(agent.session)
    } catch {
      // Optional meter.
    }
  }
  return collected
}

/** The live TUI shares this process's stdout, so it reports the real width. */
export function terminalColumns(): number | undefined {
  const columns = (process.stdout as { columns?: unknown }).columns
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) return Math.floor(columns)
  const fromEnv = Number(process.env.COLUMNS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : undefined
}
export async function reportFor(ctx: PluginContext, agent: AgentLike, options: ReportOptions = {}): Promise<string> {
  const collected = await collect(ctx, agent)
  const pressure = collected.pressure
  const projected = pressure?.pressureTokens === undefined
    ? undefined
    : pressure.pressureTokens + (pressure.surfaceTokens - (pressure.sampledSurfaceTokens ?? pressure.surfaceTokens))
  const used = projected ?? collected.measure?.totalTokens
  if (used === undefined) throw new Error('no token meter or context projection in this composition')

  let systemTokens: number | undefined
  let toolsTokens: number | undefined
  let messageTokens: number | undefined
  let estimated = false
  const breakdown = collected.breakdown?.breakdown
  if (breakdown !== undefined) {
    systemTokens = breakdown.systemTokens
    toolsTokens = breakdown.toolsTokens
    messageTokens = breakdown.messageTokens
  } else {
    const surface = collected.measure?.surfaceTokens
    const estimate = estimateBreakdown(agent.session.deriveMessages?.() ?? [])
    const total = estimate.systemTokens + estimate.messageTokens
    const scale = surface !== undefined && total > 0 ? surface / total : 1
    systemTokens = Math.round(estimate.systemTokens * scale)
    messageTokens = Math.max(0, Math.round(surface ?? total) - systemTokens)
    toolsTokens = 0
    estimated = true
  }

  const windowTokens = pressure?.contextWindow ?? collected.info?.context?.contextWindow
  const displayName = collected.info?.name ?? agent.options.model
  const provider = agent.options.provider
  const model = agent.options.model
  const route = provider === undefined || model === undefined ? undefined : `${provider}/${model}`
  let bufferTokens: number | undefined
  if (windowTokens !== undefined) {
    bufferTokens = compactionBuffer(windowTokens, {
      thresholdRatio: collected.compaction?.config?.thresholdRatio,
      headroomTokens: collected.compaction?.config?.headroomTokens,
      reservedOutput: collected.info?.defaultMaxTokens,
    })
  }
  return buildReport(
    { windowTokens, used, systemTokens, toolsTokens, messageTokens, bufferTokens, estimated },
    { displayName, route },
    options,
  )
}

