import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The script's return + console block budget, and its bounds. */
export const DEFAULT_OUTPUT_BUDGET = 6_000
export const MIN_OUTPUT_BUDGET = 200
export const MAX_OUTPUT_BUDGET = 50_000

/** Per-call deadline bounds; the provider caps at maxTimeoutMs (default 600s). */
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 600_000

export interface ScriptOptions {
  timeoutMs?: number
  maxOutputChars?: number
}

const OPTIONS_LINE = /^\/\/\s*@options:\s*(\{.*\})\s*$/

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Pi's `// @options:` first line. Only the first line is honored; a malformed
 * or misplaced line fails the call before the program runs.
 */
export function parseOptionsLine(code: string): ScriptOptions {
  const firstLine = code.split('\n')[0] ?? ''
  // Only a first line that IS an options comment counts; the token inside a
  // string or prose comment is ordinary code.
  if (!/^\s*\/\/\s*@options:/.test(firstLine)) {
    // Pi semantics: an options line anywhere else fails the call.
    const misplaced = code.split('\n').slice(1).some(line => /^\s*\/\/\s*@options:/.test(line))
    if (misplaced) throw new Error('codemode: the @options line must be the first line of the script')
    return {}
  }
  const match = OPTIONS_LINE.exec(firstLine)
  if (match === null) {
    throw new Error('codemode: the @options line must be the first line and hold a JSON object, e.g. // @options: {"timeout_ms": 60000}')
  }
  let raw: unknown
  try {
    raw = JSON.parse(match[1] as string)
  } catch {
    throw new Error('codemode: the @options line is not valid JSON')
  }
  const options: ScriptOptions = {}
  if (raw === null || typeof raw !== 'object') throw new Error('codemode: the @options line must hold a JSON object')
  const record = raw as Record<string, unknown>
  if (typeof record.timeout_ms === 'number' && Number.isFinite(record.timeout_ms)) {
    options.timeoutMs = clamp(Math.round(record.timeout_ms), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  }
  if (typeof record.max_output_chars === 'number' && Number.isFinite(record.max_output_chars)) {
    options.maxOutputChars = clamp(Math.round(record.max_output_chars), MIN_OUTPUT_BUDGET, MAX_OUTPUT_BUDGET)
  }
  return options
}

let spillSequence = 0

/**
 * Pi's max_output_tokens shape: keep the head and tail of an oversized
 * return+console block, note how much was cut, and spill the full text to a
 * temp file whose path stays in the result. The runtime's hard byte cap
 * (output-limit) never fires for a model that stays anywhere near the budget.
 */
export function applyOutputBudget(valueText: string, consoleBlock: string, cap: number): { text: string; spillPath?: string } {
  const full = [valueText, consoleBlock].filter(part => part.length > 0).join('\n')
  if (full.length <= cap) return { text: full }
  const head = Math.floor(cap / 2)
  const tail = Math.ceil(cap / 2)
  const omitted = full.length - head - tail
  const spillPath = join(tmpdir(), `codemode-output-${Date.now()}-${++spillSequence}.txt`)
  writeFileSync(spillPath, full, { mode: 0o600 })
  const marker = `\n… ${omitted} chars omitted; full output: ${spillPath} …\n`
  return { text: full.slice(0, head) + marker + full.slice(full.length - tail), spillPath }
}

/** Cheap bounded Levenshtein: returns true when edit distance is at most 2. */
function withinTwoEdits(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]! <= 2
}

/**
 * Pi ships errors that teach recovery: a `tools.Bash is not a function`
 * message names the close binding match so the script can self-correct in the
 * next call instead of guessing.
 */
export function suggestBinding(message: string, names: readonly string[]): string | undefined {
  const match = /tools(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])\s+is not a function/.exec(message)
  if (match === null) return undefined
  const target = (match[1] ?? match[2]) as string
  const normalize = (value: string): string => value.toLowerCase().replace(/_/g, '')
  const wanted = normalize(target)
  let best: string | undefined
  for (const name of names) {
    if (normalize(name) === wanted) return name
    if (best === undefined && withinTwoEdits(normalize(name), wanted)) best = name
  }
  return best === target ? undefined : best
}

const STRING_METHOD_ON_OBJECT = /\.(?:slice|substring|trim|trimStart|trimEnd|split|match|matchAll|replace|replaceAll|includes|startsWith|endsWith|toLowerCase|toUpperCase) is not a function/

/** A recovery line for the two failure classes the session logs show most. */
export function scriptErrorHint(kind: string, message: string): string | undefined {
  if (kind === 'invalid-output') return 'return only JSON values: no undefined, functions, NaN or Date; use null or a string instead'
  if (kind === 'exception' && STRING_METHOD_ON_OBJECT.test(message)) return 'tool results are objects: bash output is r.stdout.text, read output is r.lines; inspect with Object.keys(r)'
  return undefined
}

/** `codemode.exit()` unwinds by throwing this; the executor turns it into a success. */
export const EXIT_SENTINEL = 'codemode: exit() called'

/**
 * Pi trims a failed script's stack to one frame in its own codemode.js; the PTC
 * runtime sends the whole `error.stack`, which is mostly Node internals that
 * teach the model nothing. Keep the message and the first frame inside the
 * script (`<anonymous>:line:column`) so the model can find the failing line of
 * the code it wrote. A message with no frames passes through unchanged.
 */
export function trimScriptError(message: string): string {
  const lines = message.split('\n')
  const firstFrame = lines.findIndex(line => /^\s+at /.test(line))
  if (firstFrame === -1) return message
  const header = lines.slice(0, firstFrame)
  // The script's own frame, shortened to its line:column — the eval wrapper
  // path inside it is runtime plumbing the model cannot use.
  const frame = lines.slice(firstFrame).map(line => /<anonymous>:(\d+):(\d+)/.exec(line)).find((it): it is RegExpExecArray => it !== null)
  if (frame === undefined) return header.join('\n')
  // V8's AsyncFunction wrapper prepends three lines (params, `) {`, injected
  // 'use strict'), so program line N reports as frame N+3; shift back so the
  // frame names the line the model wrote.
  // ponytail: offset 3 is the wrapper's fixed preamble; re-probe if the PTC runtime changes.
  const line = Math.max(1, Number(frame[1]) - 3)
  return [...header, `    at <anonymous>:${line}:${frame[2]}`].join('\n')
}
