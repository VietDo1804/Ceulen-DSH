import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type { AgentLike, PluginContext, ToolContent } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { logLine } from '../../core/log.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'

export const name = 'ceulen-repair'
export const inject = ['tools']

interface Hunk {
  before: string[]
  after: string[]
  added: number
  removed: number
}

interface FileOp {
  kind: 'add' | 'update' | 'delete'
  path: string
  content?: string
  hunks?: Hunk[]
}

interface ParsedPatch {
  ops: FileOp[]
}

function parsePatch(patch: string): ParsedPatch {
  const lines = patch.replace(/\r\n/g, '\n').trim().split('\n')
  if (lines[0]?.trim() !== '*** Begin Patch') throw new Error('invalid patch at line 1: expected *** Begin Patch')
  if (lines.at(-1)?.trim() !== '*** End Patch') throw new Error(`invalid patch at line ${lines.length}: expected *** End Patch`)
  const ops: FileOp[] = []
  let index = 1
  let current: FileOp | undefined
  let hunk: Hunk | undefined
  const invalid = (message: string): never => { throw new Error(`invalid patch at line ${index + 1}: ${message}`) }
  const flushHunk = () => {
    if (hunk !== undefined && current !== undefined) {
      if (hunk.added + hunk.removed === 0) invalid(`hunk in ${current.path} has no changes`)
      current.hunks = current.hunks ?? []
      current.hunks.push(hunk)
      hunk = undefined
    }
  }
  for (; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? ''
    const add = /^\*\*\* Add File:\s*(\S.*)$/.exec(line)
    if (add !== null) {
      flushHunk()
      current = { kind: 'add', path: add[1]!.trim(), content: '' }
      ops.push(current)
      const content: string[] = []
      while (index + 1 < lines.length - 1 && !(lines[index + 1] ?? '').startsWith('*** ')) {
        index += 1
        const next = lines[index] ?? ''
        if (!next.startsWith('+')) invalid('added file lines must start with +')
        content.push(next.slice(1))
      }
      current.content = content.length === 0 ? '' : `${content.join('\n')}\n`
      current = undefined
      continue
    }
    const del = /^\*\*\* Delete File:\s*(\S.*)$/.exec(line)
    if (del !== null) {
      flushHunk()
      ops.push({ kind: 'delete', path: del[1]!.trim() })
      current = undefined
      continue
    }
    const update = /^\*\*\* Update File:\s*(\S.*)$/.exec(line)
    if (update !== null) {
      flushHunk()
      current = { kind: 'update', path: update[1]!.trim(), hunks: [] }
      ops.push(current)
      continue
    }
    if (line.startsWith('@@') && current !== undefined) {
      flushHunk()
      hunk = { before: [], after: [], added: 0, removed: 0 }
      continue
    }
    if (hunk !== undefined) {
      if (line.startsWith(' ')) {
        hunk.before.push(line.slice(1))
        hunk.after.push(line.slice(1))
      } else if (line.startsWith('-')) {
        hunk.before.push(line.slice(1))
        hunk.removed += 1
      } else if (line.startsWith('+')) {
        hunk.after.push(line.slice(1))
        hunk.added += 1
      } else if (line.length === 0) {
        hunk.before.push('')
        hunk.after.push('')
      } else {
        invalid(`unsupported line ${JSON.stringify(line)}`)
      }
    } else if (line.trim().length > 0) {
      invalid(`unsupported line ${JSON.stringify(line)}`)
    }
  }
  flushHunk()
  for (const op of ops) {
    if (op.kind === 'update' && op.hunks?.length === 0) invalid(`update in ${op.path} has no hunks`)
  }
  return { ops }
}

function countMatches(lines: string[], pattern: string[]): number[] {
  const hits: number[] = []
  for (let index = 0; index + pattern.length <= lines.length; index += 1) {
    let match = true
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[index + offset] !== pattern[offset]) {
        match = false
        break
      }
    }
    if (match) hits.push(index)
  }
  return hits
}

function applyHunks(text: string, hunks: Hunk[], path: string): { text: string; added: number; removed: number } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (eol === '\r\n' && /(^|[^\r])\n/.test(text)) throw new Error(`mixed line endings in ${path}; normalize them before patching`)
  const trailing = text.endsWith('\n')
  let lines = text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n')
  if (trailing) lines = lines.slice(0, -1)
  let added = 0
  let removed = 0
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.before.length === 0 && lines.length > 0) throw new Error(`hunk in ${path} has no context or removed lines`)
    const hits = countMatches(lines, hunk.before)
    if (hits.length === 0) throw new Error(`hunk does not match ${path}: ${JSON.stringify(hunk.before.slice(0, 3))}`)
    // V4D hunks in one file op are ordered top-to-bottom: when the context
    // repeats, a match at/after the previous hunk disambiguates the patch.
    const forward = hits.filter(hit => hit >= cursor)
    if (hits.length > 1 && forward.length !== 1) throw new Error(`hunk is ambiguous in ${path} (${hits.length} matches); add more context`)
    const at = (hits.length > 1 ? forward[0] : hits[0])!
    lines = [...lines.slice(0, at), ...hunk.after, ...lines.slice(at + hunk.before.length)]
    added += hunk.added
    removed += hunk.removed
    cursor = at + hunk.after.length
  }
  return { text: `${lines.join(eol)}${trailing ? eol : ''}`, added, removed }
}

interface FsLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
}

function fsService(ctx: PluginContext): FsLike {
  const service = ctx.get('fs', false) as FsLike | undefined
  if (service === undefined) throw new Error('the filesystem service is not mounted')
  return service
}

/**
 * `tools/execute` annotations: append the missing context (a sibling path, the
 * current file region, the accepted tool name) to an error the model can retry.
 * Everything here is read-only and best-effort — a throw returns the original
 * result, an error never becomes a success.
 */
interface ExecuteHook {
  readonly name?: string
  readonly arguments?: unknown
  readonly agent?: AgentLike
}

interface HookResult {
  readonly content: ToolContent
  readonly isError: boolean
}

interface Repair {
  readonly kind: 'candidates' | 'region' | 'tool'
  readonly text: string
}

/** Contract §3: an annotation marker is appended at most once. */
const REPAIR_MARKERS: Record<Repair['kind'], string> = { candidates: 'Candidates:', region: 'Current region:', tool: 'Call as:' }

function hookText(result: HookResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
}

function argText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const insert = (previous[j] ?? 0) + 1
      const remove = (current[j - 1] ?? 0) + 1
      const swap = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(insert, remove, swap)
    }
    previous = current
  }
  return previous[b.length] ?? b.length
}

function similarity(a: string, b: string): number {
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1)
}

/** True when `target` resolves inside the session workspace. */
function insideCwd(target: string, cwd: string): boolean {
  const rel = relative(resolvePath(cwd), target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read through the mounted fs service so the session sandbox applies to paths
 * the model supplied. No raw fallback: without a service this repair is
 * skipped, because an unsandboxed read would echo content the sandbox refused.
 */
async function readLines(ctx: PluginContext, path: string, cwd: string): Promise<string[] | undefined> {
  try {
    const service = ctx.get('fs', false) as FsLike | undefined
    if (service === undefined) return undefined
    const text = await service.readText(await service.resolve(path, { cwd }))
    const flat = text.replace(/\r\n/g, '\n')
    return (flat.endsWith('\n') ? flat.slice(0, -1) : flat).split('\n')
  } catch {
    return undefined
  }
}

/** Up to 12 lines: the anchor plus three lines either side, or the file head. */
function currentRegion(lines: string[], anchor: string | undefined): string {
  const index = anchor === undefined ? -1 : lines.findIndex(line => line === anchor || line.trim() === anchor.trim())
  const start = index >= 0 ? Math.max(0, index - 3) : 0
  const body = lines
    .slice(start, start + 11)
    .map((line, offset) => `${start + offset + 1}: ${line}`)
    .join('\n')
  return `Current region:\n${body}`
}

/** Up to 3 real paths in the same directory, closest basename first. */
async function candidatePaths(path: string, cwd: string): Promise<string | undefined> {
  const target = isAbsolute(path) ? path : resolvePath(cwd, path)
  // Listing siblings outside the workspace would leak names the sandbox hides.
  if (!insideCwd(target, cwd)) return undefined
  let names: string[]
  try {
    names = await readdir(dirname(target))
  } catch {
    return undefined
  }
  const wanted = basename(target).toLowerCase()
  const ranked = names
    .map(entry => ({ name: entry, score: similarity(wanted, entry.toLowerCase()) }))
    .filter(entry => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3)
  if (ranked.length === 0) return undefined
  const displayDir = dirname(path)
  return `Candidates: ${ranked.map(entry => join(displayDir, entry.name)).join('  ')}`
}

function registeredToolNames(ctx: PluginContext): string[] {
  const registry = ctx.get('tools', false) as { schemas?(): readonly { name?: string }[] } | undefined
  return (registry?.schemas?.() ?? []).map(entry => String(entry.name ?? '')).filter(name => name.length > 0)
}

function closestToolName(wanted: string, names: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const name of names) {
    const score = similarity(wanted.toLowerCase(), name.toLowerCase())
    if (score < 0.6) continue
    if (best === undefined || score > best.score || (score === best.score && name < best.name)) best = { name, score }
  }
  return best?.name
}

async function repair(ctx: PluginContext, exec: ExecuteHook, result: HookResult): Promise<Repair | undefined> {
  const tool = exec.name ?? ''
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
  const message = hookText(result)
  const path = argText(args, 'path') ?? argText(args, 'file_path')

  // A V4D hunk that no longer matches: show the file around the first line of
  // the failing hunk that still exists. Reuses the parser above.
  if (tool === 'apply_patch' && /hunk does not match/i.test(message)) {
    const patch = argText(args, 'patch')
    if (patch === undefined) return undefined
    for (const op of parsePatch(patch).ops) {
      if (op.kind !== 'update') continue
      const lines = await readLines(ctx, op.path, cwd)
      if (lines === undefined) continue
      for (const hunk of op.hunks ?? []) {
        if (hunk.before.length === 0 || countMatches(lines, hunk.before).length > 0) continue
        const anchor = hunk.before.find(line => line.trim().length > 0 && countMatches(lines, [line]).length > 0)
        if (anchor !== undefined) return { kind: 'region', text: currentRegion(lines, anchor) }
      }
    }
    return undefined
  }

  // Stale edit/write: show what the file says now around the model's anchor.
  if ((tool === 'edit' || tool === 'write') && /changed since it was read|has not been read|modified since/i.test(message)) {
    if (path === undefined) return undefined
    const lines = await readLines(ctx, path, cwd)
    if (lines === undefined) return undefined
    return { kind: 'region', text: currentRegion(lines, argText(args, 'old_string') ?? argText(args, 'old_text')) }
  }

  // Missing path: name the nearest real siblings instead of letting the model guess.
  if ((tool === 'read' || tool === 'edit' || tool === 'write') && /\bnot found\b|no such file|does not exist|ENOENT/i.test(message)) {
    if (path === undefined) return undefined
    const text = await candidatePaths(path, cwd)
    return text === undefined ? undefined : { kind: 'candidates', text }
  }

  // Unknown tool: name the registered tool the model probably meant.
  if (/unknown tool/i.test(message)) {
    const wanted = /unknown tool[:\s]+["'`]?([\w.:/-]+)/i.exec(message)?.[1]
    if (wanted === undefined) return undefined
    const closest = closestToolName(wanted, registeredToolNames(ctx))
    return closest === undefined || closest === wanted ? undefined : { kind: 'tool', text: `Call as: ${closest}` }
  }

  return undefined
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('repair', settings)) return

  registerToolSafe(ctx, ceulenTool({
    name: 'apply_patch',
    description: 'Apply a Codex-style V4D patch. Format: "*** Begin Patch", then "*** Add File: path" with + lines, or "*** Update File: path" with @@ hunks of context, -removed, +added lines, then "*** End Patch". Hunks must match uniquely. Deletes are not supported; use bash rm when appropriate.',
    parameters: objectSchema({
      patch: { type: 'string', description: 'The complete V4D patch text.' },
    }, ['patch']),
    outputSchema: { type: 'string' },
    concurrencySafe: false,
    async execute(raw, exec) {
      const patch = String((raw as { patch?: unknown }).patch ?? '')
      if (patch.trim().length === 0) throw new Error('patch must be non-empty')
      const parsed = parsePatch(patch)
      if (parsed.ops.length === 0) throw new Error('patch contains no file operations')
      const fs = fsService(ctx)
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      const results: string[] = []
      const staged = new Map<string, { target: unknown; path: string; text: string }>()
      for (const op of parsed.ops) {
        exec.signal.throwIfAborted()
        if (op.kind === 'delete') throw new Error(`delete is not supported by apply_patch: ${op.path}`)
        const target = await fs.resolve(op.path, { cwd, signal: exec.signal })
        const key = resolvePath(cwd, op.path)
        if (op.kind === 'add') {
          staged.set(key, { target, path: op.path, text: op.content ?? '' })
          results.push(`Added ${op.path}`)
          continue
        }
        const original = staged.get(key)?.text ?? await fs.readText(target, exec.signal)
        const applied = applyHunks(original, op.hunks ?? [], op.path)
        staged.set(key, { target, path: op.path, text: applied.text })
        results.push(`Updated ${op.path} (+${applied.added} -${applied.removed})`)
      }
      // ponytail: preflight prevents invalid-patch partial writes; I/O is not a multi-file transaction.
      const writes = [...staged.values()]
      let completed = 0
      try {
        for (const entry of writes) {
          exec.signal.throwIfAborted()
          await fs.writeText(entry.target, entry.text, undefined, exec.signal)
          completed += 1
        }
      } catch (error) {
        const written = writes.slice(0, completed).map(entry => entry.path).join(', ') || '(none)'
        const pending = writes.slice(completed).map(entry => entry.path).join(', ')
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nWritten: ${written}\nNot confirmed written: ${pending}`, { cause: error })
      }
      return results.join('\n')
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'read_slice',
    description: 'Read a line range of a text file with line numbers. Use for large files, tail reads, or a range named in a test failure.',
    parameters: objectSchema({
      path: { type: 'string', description: 'File path (absolute or relative to the session cwd).' },
      start: { type: 'integer', description: 'First line (1-based). Default 1.' },
      end: { type: 'integer', description: 'Last line (inclusive). Omit with tail.' },
      tail: { type: 'integer', description: 'Return the last N lines instead of start/end.' },
    }, ['path']),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { path: string; start?: number; end?: number; tail?: number }
      const fs = fsService(ctx)
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      const target = await fs.resolve(args.path, { cwd, signal: exec.signal })
      const text = await fs.readText(target, exec.signal)
      const lines = text.replace(/\r\n/g, '\n').split('\n')
      if (lines.at(-1) === '') lines.pop()
      let start = Math.max(1, args.start ?? 1)
      let end = Math.min(lines.length, args.end ?? lines.length)
      if (args.tail !== undefined) {
        const count = Math.max(1, Math.min(args.tail, lines.length))
        start = lines.length - count + 1
        end = lines.length
      }
      if (start > end) throw new Error(`empty range: start ${start} is after end ${end} (file has ${lines.length} lines)`)
      const width = String(end).length
      const body = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width)}: ${line}`).join('\n')
      return `${target && typeof target === 'object' && 'displayPath' in target ? String((target as { displayPath?: string }).displayPath) : args.path} (lines ${start}-${end} of ${lines.length})\n${body}`
    },
  }))

  // Around-wrapper for every tool, native included: annotate failures with the
  // context the retry needs. Never replaces content, never touches a success.
  ctx.on('tools/execute', async (exec: ExecuteHook, next: () => Promise<HookResult>) => {
    const result = await next()
    if (result?.isError !== true || !Array.isArray(result.content)) return result
    let extra: Repair | undefined
    try {
      extra = await repair(ctx, exec, result)
    } catch {
      return result
    }
    if (extra === undefined) return result
    if (hookText(result).includes(REPAIR_MARKERS[extra.kind])) return result
    logLine('toolguard', `${exec.name ?? '?'} ${extra.kind}`)
    return { ...result, content: [...result.content, { type: 'text' as const, text: clampText(extra.text, 900) }] }
  })
}
