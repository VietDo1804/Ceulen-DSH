import { errorMessage } from '../../core/tools.js'
import type { ToolRunContext } from '../../core/types.js'
import { applyOutputBudget } from './script.js'
import { SELF_NAMES, type BindingFunction, type CodemodeCall, type PtcRunResult, type RegistryLike } from './types.js'

/** One short line for a card row; never a multi-line paste. */
export function clipOneLine(value: string, max = 80): string {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/** DSH's own duration format: `8ms`, `1.2s`, `2m5s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

/**
 * The call's arguments the way the receipt shows them: compact JSON with the
 * boilerplate label keys dropped, clipped to one line.
 */
export function argSummary(args: unknown): string {
  if (args === undefined || args === null) return ''
  let value = args
  if (typeof args === 'object' && !Array.isArray(args)) {
    const kept: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(args as Record<string, unknown>)) {
      if (key !== 'description' && key !== 'summary') kept[key] = entry
    }
    value = kept
  }
  try {
    const json = JSON.stringify(value)
    return json === undefined || json === '{}' ? '' : clipOneLine(json, 60)
  } catch {
    return ''
  }
}

/** The nested-call ledger above the script output in the settled card. */
export function formatCalls(calls: readonly CodemodeCall[]): string {
  return calls.map(call => {
    const mark = call.status === 'error' ? '×' : '✓'
    const args = call.detail.length > 0 ? ` ${call.detail}` : ''
    const failure = call.status === 'error' && call.error !== undefined ? ` — ${clipOneLine(call.error, 40)}` : ''
    return `${mark} ${call.name}${args} ${formatMs(call.ms)}${failure}`
  }).join('\n')
}

/**
 * Bind every tool the calling agent can see. Names are passed through
 * unchanged: the model uses bracket access for names that are not identifiers,
 * which avoids the silent alias collisions Pi's `_` normalization can create.
 */
export function toolBindings(registry: RegistryLike, exec: ToolRunContext, calls: CodemodeCall[]): Record<string, BindingFunction> {
  const functions: Record<string, BindingFunction> = Object.create(null) as Record<string, BindingFunction>
  let sequence = 0
  for (const schema of registry.schemas(exec.agent)) {
    if (SELF_NAMES.has(schema.name)) continue
    functions[schema.name] = async args => {
      const startedAt = Date.now()
      const detail = argSummary(args)
      try {
        const result = await registry.execute({
          callId: `${exec.callId ?? 'codemode'}:codemode:${++sequence}`,
          name: schema.name,
          arguments: args ?? {},
          agent: exec.agent,
          signal: exec.signal,
        })
        if (result.isError) throw new Error(result.error?.message ?? `${schema.name} failed`)
        calls.push({ name: schema.name, detail, status: 'ok', ms: Date.now() - startedAt })
        return result.value ?? null
      } catch (error) {
        calls.push({ name: schema.name, detail, status: 'error', ms: Date.now() - startedAt, error: errorMessage(error) })
        throw error
      }
    }
  }
  return functions
}

export const STATUS_LINE = /^Script (?:completed|failed) \([\d.]+s\)\n?/

/** Pi's result shape: status line, budgeted return value + console block, then the error. */
export function renderResult(result: PtcRunResult, wallSeconds: number, budget: number): { text: string; spillPath?: string } {
  const status = `${result.error === undefined ? 'Script completed' : 'Script failed'} (${wallSeconds.toFixed(1)}s)`
  const valueText = result.value !== undefined
    ? typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
    : ''
  const consoleBlock = result.logs.length > 0 ? `<console_output>\n${result.logs.join('\n')}\n</console_output>` : ''
  const { text: body, spillPath } = applyOutputBudget(valueText, consoleBlock, budget)
  const lines = [status]
  if (body.length > 0) lines.push(body)
  if (result.error !== undefined) lines.push(`Script error (${result.error.kind}): ${result.error.message}`)
  if (lines.length === 1) lines.push('(no output)')
  return { text: lines.join('\n'), spillPath }
}

/** The script rides last: the collapsed card previews the receipt, not the code. */
const SCRIPT_TAIL_LINES = 40

export function scriptTail(code: string): string {
  const lines = code.split('\n')
  const shown = lines.slice(0, SCRIPT_TAIL_LINES)
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`)
  return ['// script', ...shown].join('\n')
}
