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
export function toolBindings(
  registry: RegistryLike,
  exec: ToolRunContext,
  calls: CodemodeCall[],
  usage: { rawChars: number } = { rawChars: 0 },
): Record<string, BindingFunction> {
  const functions: Record<string, BindingFunction> = Object.create(null) as Record<string, BindingFunction>
  let sequence = 0
  for (const schema of registry.schemas(exec.agent)) {
    if (SELF_NAMES.has(schema.name)) continue
    functions[schema.name] = async args => {
      const startedAt = Date.now()
      const detail = argSummary(args)
      try {
        const batch = await registry.execute({
          calls: [{ id: `${exec.callId ?? 'codemode'}:codemode:${++sequence}`, name: schema.name, arguments: JSON.stringify(args ?? {}) }],
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        const settled = batch?.results?.[0]?.result
        if (settled === undefined) throw new Error(`${schema.name} settled without a result`)
        if (settled.isError) throw new Error(settled.error?.message ?? `${schema.name} failed`)
        calls.push({ name: schema.name, detail, status: 'ok', ms: Date.now() - startedAt })
        usage.rawChars += JSON.stringify(settled.value ?? null)?.length ?? 0
        return settled.value ?? null
      } catch (error) {
        calls.push({ name: schema.name, detail, status: 'error', ms: Date.now() - startedAt, error: errorMessage(error) })
        throw error
      }
    }
  }
  return functions
}

export const STATUS_LINE = /^Script (?:completed|failed) \([\d.]+s\)\n?/

/** Model-only advice: a single unfiltered call should have been a direct call. Lines start with this prefix. */
export const SINGLE_CALL_NOTE = 'Note: one tool call with no real filtering'

function singleCallNote(name: string): string {
  return `${SINGLE_CALL_NOTE}: this script only wrapped \`${name}\` and returned its result whole; call \`${name}\` directly next time and filter in the shell.`
}

const MAX_FAILURE_CALLS = 8

/** Pi's result shape: status line, budgeted return value + console block, then the error. */
export function renderResult(
  result: PtcRunResult,
  wallSeconds: number,
  budget: number,
  calls: readonly CodemodeCall[] = [],
  rawChars = 0,
): { text: string; spillPath?: string } {
  const status = `${result.error === undefined ? 'Script completed' : 'Script failed'} (${wallSeconds.toFixed(1)}s)`
  const valueText = result.value !== undefined
    ? typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
    : ''
  const consoleBlock = result.logs.length > 0 ? `<console_output>\n${result.logs.join('\n')}\n</console_output>` : ''
  // Measured before the budget cut: a script that returns 50k raw chars is the
  // wrapper the note is for, even though the model only sees 6k of it.
  const returnedChars = valueText.length + consoleBlock.length
  const { text: body, spillPath } = applyOutputBudget(valueText, consoleBlock, budget)
  const lines = [status]
  if (body.length > 0) lines.push(body)
  if (result.error !== undefined) lines.push(`Script error (${result.error.kind}): ${result.error.message}`)
  // The model must know which calls already ran so it does not repeat them.
  if (result.error !== undefined && calls.length > 0) lines.push(`Calls before failure:\n${formatCalls(calls.slice(-MAX_FAILURE_CALLS))}`)
  if (result.error === undefined && calls.length === 1 && rawChars > 0 && returnedChars * 2 >= rawChars) lines.push(singleCallNote(calls[0]!.name))
  if (lines.length === 1) lines.push('(no output)')
  return { text: lines.join('\n'), spillPath }
}

/** The card renders its own receipt; drop the model-only notes from its body. */
export function stripModelNotes(body: string): string {
  const kept: string[] = []
  let skippingCalls = false
  for (const line of body.split('\n')) {
    if (line === 'Calls before failure:') {
      skippingCalls = true
      continue
    }
    if (skippingCalls) {
      if (/^[✓×] /.test(line)) continue
      skippingCalls = false
    }
    if (line.startsWith(SINGLE_CALL_NOTE)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/** The script rides last: the collapsed card previews the receipt, not the code. */
const SCRIPT_TAIL_LINES = 40

export function scriptTail(code: string): string {
  const lines = code.split('\n')
  const shown = lines.slice(0, SCRIPT_TAIL_LINES)
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`)
  return ['// script', ...shown].join('\n')
}
