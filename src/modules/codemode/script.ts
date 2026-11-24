import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ceulenHome, packageFile } from '../../core/paths.js'
import { editDistance } from '../../core/tools.js'

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

/** Spilled outputs older than this are removed when the next one is written. */
const SPILL_MAX_AGE_MS = 48 * 60 * 60 * 1000

/**
 * Where a spilled output goes: `$DSH_HOME/ceulen/spill`, not the OS temp
 * directory. The workspace-write sandbox gives the shell a private, empty
 * `/tmp` (bwrap `--tmpfs /tmp`), so a file the harness wrote there does not
 * exist for the bash call that is told to read it back. The home directory is
 * bound read-only into every sandbox mode. Old files are dropped here because
 * nothing else cleans this directory. Falls back to the temp directory when
 * the home cannot be written.
 */
export function spillDirectory(now = Date.now()): string {
  const dir = join(ceulenHome(), 'spill')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('codemode-output-')) continue
      const path = join(dir, name)
      if (now - statSync(path).mtimeMs > SPILL_MAX_AGE_MS) rmSync(path, { force: true })
    }
    return dir
  } catch {
    return tmpdir()
  }
}

/** Bounds of one part when a spilled output is read back. */
export const MIN_SPILL_PART = 100
export const MAX_SPILL_PART = 8_000

/** `index`, moved back by one when it would fall between the two halves of a surrogate pair. */
export function safeCut(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index - 1 : index
}

/**
 * Characters per part when a spilled output is read back under budget `cap`.
 * 0.4 of the budget: a part that comes back through codemode again, as a JSON
 * string with every character escaped to two, still fits, so reading a spill
 * can never produce the next spill.
 */
export function spillPartChars(cap: number): number {
  return clamp(Math.floor(cap * 0.4), MIN_SPILL_PART, MAX_SPILL_PART)
}

function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command that prints part `part` (1-based) of a spilled output: scripts/spill-page.mjs. */
export function spillPageCommand(path: string, part: number, chars: number): string {
  return [process.execPath, packageFile('scripts', 'spill-page.mjs'), path, String(part), String(chars)].map(shellArg).join(' ')
}

/**
 * Pi's max_output_tokens shape: keep the head and tail of an oversized
 * return+console block, note how much was cut, and spill the full text to a
 * file (see spillDirectory) whose path stays in the result. The runtime's hard byte cap
 * (output-limit) never fires for a model that stays anywhere near the budget.
 *
 * The notice names a command that reads the cut back, because the obvious
 * moves fail: `read` caps long lines and a JSON result is one line, `cat`
 * returns the whole file over the budget again, and a byte cut splits
 * multi-byte characters. Parts are sized from the active budget.
 */
export function applyOutputBudget(valueText: string, consoleBlock: string, cap: number): string {
  const full = [valueText, consoleBlock].filter(part => part.length > 0).join('\n')
  if (full.length <= cap) return full
  const head = safeCut(full, Math.floor(cap / 2))
  const tailStart = safeCut(full, full.length - Math.ceil(cap / 2))
  const omitted = tailStart - head
  const spillPath = join(spillDirectory(), `codemode-output-${Date.now()}-${++spillSequence}.txt`)
  writeFileSync(spillPath, full, { mode: 0o600 })
  const chars = spillPartChars(cap)
  const first = Math.floor(head / chars) + 1
  const last = Math.floor((tailStart - 1) / chars) + 1
  const marker = [
    '',
    `… ${omitted} chars omitted; full output: ${spillPath}`,
    `The cut is in ${first === last ? `part ${first}` : `parts ${first}-${last}`} of ${Math.ceil(full.length / chars)} (${chars} chars each). Read one part with a direct bash call, not inside codemode: ${spillPageCommand(spillPath, first, chars)}`,
    'Or run the script again and return only what you need. …',
    '',
  ].join('\n')
  return full.slice(0, head) + marker + full.slice(tailStart)
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
    if (best === undefined && editDistance(normalize(name), wanted) <= 2) best = name
  }
  return best === target ? undefined : best
}

const STRING_METHOD_ON_OBJECT = /\.(?:slice|substring|trim|trimStart|trimEnd|split|match|matchAll|replace|replaceAll|includes|startsWith|endsWith|toLowerCase|toUpperCase) is not a function/

const PROPERTY_OF_NOTHING = /Cannot read properties of (?:undefined|null) \(reading '([^']+)'\)/
const LOSSLESS_ARGUMENTS = /binding arguments must be lossless JSON/

/** A recovery line for the failure classes the session logs show most. */
export function scriptErrorHint(kind: string, message: string): string | undefined {
  if (kind === 'invalid-output') return 'return only JSON values: no undefined, functions, NaN or Date; use null or a string instead'
  if (kind !== 'exception') return undefined
  if (STRING_METHOD_ON_OBJECT.test(message)) return 'tool results are objects: bash output is r.stdout.text, read output is r.lines; inspect with Object.keys(r)'
  const property = PROPERTY_OF_NOTHING.exec(message)
  if (property !== null) {
    return `a value has no .${property[1]} where the script expected one: bash output is r.stdout.text, read output is r.lines, a rejected allSettled entry has .reason not .value; console.log(Object.keys(r)) before drilling in`
  }
  if (LOSSLESS_ARGUMENTS.test(message)) return 'tool arguments must be plain JSON: drop undefined fields (spread them conditionally) and pass strings or numbers, never Date, functions or buffers'
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

/**
 * The PTC runtime rejects a completion that is not lossless JSON (an
 * `undefined` field off a tool result, a Date, NaN) and fails the whole script
 * after its work already ran. Sanitizing the completion instead is a JSON
 * round-trip: undefined object fields are dropped, undefined array elements
 * become null, Dates their ISO string, NaN null and bigints strings.
 * An Error keeps its name and message: its own fields are not enumerable, so
 * the round-trip alone turned the reason of a refused call in a
 * `Promise.allSettled` result into `{}` and the script never saw why. Errors
 * are told by shape, since one thrown by a tool binding comes from another realm.
 */
// ponytail: catch returns the raw value, so a circular completion (or Map/Set) still hits the old invalid-output error; upgrade to a drop-cycle walk if that shape shows up in the evo report.
const SANITIZE_PRELUDE = 'const __ceulenCs=v=>{if(v===void 0)return v;try{return JSON.parse(JSON.stringify(v,(k,x)=>typeof x==="bigint"?String(x):x&&typeof x==="object"&&typeof x.message==="string"&&typeof x.stack==="string"?{...x,name:x.name,message:x.message}:x))}catch{return v}};return await (async()=>{const __ceulenV=await (async()=>{'
const SANITIZE_TAIL = '\n})();return __ceulenCs(__ceulenV)})()'

/**
 * Wrap a program so its completion is JSON-safe. The prelude rides on line 1
 * and the tail adds one line below the program, so the model's own line
 * numbers still hold. A throw (including the exit sentinel) passes straight
 * through, and a bare `return` still completes as undefined.
 */
export function wrapCompletion(program: string): string {
  return SANITIZE_PRELUDE + program + SANITIZE_TAIL
}
