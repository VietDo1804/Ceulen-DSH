import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from 'node:path'
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { formatBytes } from '../../vendor/ceulen/jfind/format.js'
import { runCascade, FIND_TIMEOUT_MS } from '../../vendor/ceulen/jfind/cascade.js'
import { rankedHeat } from '../../vendor/ceulen/jfind/tree.js'
import { createLlmJudge, routeFor } from './judge.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-jfind'

export const inject = ['tools', 'llm']

const RANGES_SHOWN = 3

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('jfind', settings)) return

  registerToolSafe(ctx, ceulenTool({
    name: 'jfind',
    description: 'Semantic code find: describe a BEHAVIOR ("where do we parse CLI flags", "retry with backoff around provider calls") and get files and line ranges implementing it, strongest first. A lexical scan ranks candidates, then the configured agent model judges filenames, sketches, and passages in three waves. Slower than grep; use when grep cannot express the search as a literal pattern. The path scope must stay inside the workspace.',
    parameters: objectSchema({
      query: { type: 'string', description: 'What the code does, e.g. "parse cron expressions into next-fire times".' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Extra literal keywords for the lexical prior.' },
      path: { type: 'string', description: 'Search scope: a directory (default the session cwd) or a single file inside the workspace.' },
    }, ['query']),
    outputSchema: { type: 'string' },
    timeoutMs: 60_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { query: string; keywords?: string[]; path?: string }
      const query = args.query.trim()
      if (query.length === 0) throw new Error('query must be a non-empty description')
      const cwd = resolvePath(exec.agent?.session.header?.cwd ?? process.cwd())
      const scope = typeof args.path === 'string' ? args.path.trim() : ''
      let root = cwd
      if (scope.length > 0) {
        root = resolvePath(cwd, scope)
        const rel = relativePath(cwd, root)
        if (root !== cwd && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
          throw new Error(`path must be inside the workspace: ${scope}`)
        }
        if (!existsSync(root)) throw new Error(`path not found: ${scope}`)
        const stat = lstatSync(root)
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`path is neither a file nor a directory: ${scope}`)
      }

      const route = routeFor(exec.agent)
      const judge = createLlmJudge(ctx, route)
      const timeout = AbortSignal.timeout(FIND_TIMEOUT_MS)
      const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
      let result: Awaited<ReturnType<typeof runCascade>>
      try {
        result = await runCascade({
          root,
          query,
          extraKeywords: args.keywords ?? [],
          judge,
          signal,
        })
      } catch (error) {
        if (timeout.aborted && exec.signal?.aborted !== true) {
          throw new Error(`jfind timed out after ${Math.round(FIND_TIMEOUT_MS / 1000)}s — narrow the query or scope`)
        }
        throw error
      }
      if (result.stats.listed === 0 && scope.length > 0 && lstatSync(root).isFile()) {
        return `not searchable: ${scope} (deny-listed, binary, secret, or empty by jfind eligibility rules)`
      }
      const where = scope.length > 0 ? ` in ${scope}` : ''
      const lines: string[] = []
      if (result.hits.length === 0) {
        lines.push(`no hits for "${query}"${where} (τ ${result.threshold.toFixed(2)})`)
      } else {
        lines.push(`${result.hits.length} hit(s) for "${query}"${where} (τ ${result.threshold.toFixed(2)}), strongest first`, '')
        for (const hit of result.hits) {
          const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`
          lines.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`)
          for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
            const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`
            lines.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`)
          }
        }
      }
      lines.push(
        '',
        `listed ${result.stats.listed} · judged ${result.stats.judged} · read ${result.stats.filesRead} files (${formatBytes(result.stats.fileBytes)}) · ${result.stats.requests} requests · ${result.stats.inputTokens + result.stats.outputTokens} tokens · keywords: ${result.keywords.join(', ')}`,
      )
      if (result.stats.failures.length > 0) {
        lines.push(`${result.stats.errors} of ${result.stats.requests} requests failed:`, ...result.stats.failures.map(failure => `  ${failure}`))
      }
      const text = clampText(lines.join('\n'), 20_000)
      if (result.stats.requests > 0 && result.stats.errors === result.stats.requests) throw new Error(text)
      logLine('jfind', `${query} -> ${result.hits.length} hit(s), ${result.stats.requests} requests`)
      return text
    },
  }))
}
