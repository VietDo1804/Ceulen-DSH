import { REASONING_EFFORTS, type ReasoningEffort } from './settings.js'
import type { LlmChunk, PluginContext } from './types.js'

export interface LlmRoute {
  provider: string
  model: string
  reasoningEffort?: string
  sessionId?: string
}

export interface ParsedRoute {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffort
}

/**
 * Parse a `provider/model[:effort]` selector.
 *
 * The route is split at the first slash (a model id may carry more); a trailing
 * `:effort` is only honoured when the suffix is a known reasoning level, so ids
 * like `model:free` survive intact.
 */
export function parseRoute(value: string): ParsedRoute | undefined {
  const trimmed = value.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const provider = trimmed.slice(0, slash)
  const rest = trimmed.slice(slash + 1)
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    const suffix = rest.slice(colon + 1)
    if ((REASONING_EFFORTS as readonly string[]).includes(suffix)) {
      return { provider, model: rest.slice(0, colon), reasoningEffort: suffix as ReasoningEffort }
    }
  }
  return { provider, model: rest }
}

/** Streamed text plus the reason the stream ended; `max-tokens` means a cut reply. */
export interface StreamedText {
  readonly text: string
  readonly finish: string
}

/**
 * Stream one auxiliary model call and keep the finish reason. Reasoning models
 * bill their thinking against `maxTokens`, so an empty `text` is ambiguous:
 * `finish: 'max-tokens'` is a truncated reply, `finish: 'stop'` is a clean
 * no-answer (the advisor's explicit no-note signal).
 */
export async function streamTextDetailed(
  ctx: PluginContext,
  route: LlmRoute,
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens = 700,
): Promise<StreamedText> {
  if (ctx.llm === undefined) throw new Error('the llm service is not mounted')
  let text = ''
  let finish = 'stop'
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature: 0,
    signal,
  })) {
    const item = chunk as LlmChunk & {
      block?: { type?: string; text?: string }
      reason?: { kind?: string; failure?: { code?: string; message?: string } }
    }
    if (item.type === 'text-delta' && typeof item.text === 'string') text += item.text
    else if (item.type === 'block-end' && item.block?.type === 'text' && typeof item.block.text === 'string' && text.length === 0) {
      text = item.block.text
    } else if (item.type === 'finish') {
      if (item.reason?.kind === 'error' || item.reason?.kind === 'aborted') {
        const failure = item.reason.failure
        const label = item.reason.kind === 'aborted' ? 'aborted' : 'failed'
        throw new Error(`llm call ${label}${failure?.code === undefined ? '' : ` (${failure.code})`}: ${failure?.message ?? 'no failure details'}`)
      }
      finish = item.reason?.kind ?? 'stop'
    }
  }
  return { text: text.trim(), finish }
}

/** Stream one auxiliary model call and return its visible text. */
export async function streamText(
  ctx: PluginContext,
  route: LlmRoute,
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens = 700,
): Promise<string> {
  return (await streamTextDetailed(ctx, route, system, user, signal, maxTokens)).text
}

/** Extract the first JSON object/array from a model reply. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const objectStart = candidate.indexOf('{')
  const arrayStart = candidate.indexOf('[')
  const starts = [objectStart, arrayStart].filter(index => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(close)
  if (end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}
