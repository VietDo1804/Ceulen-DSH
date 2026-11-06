import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { sgAvailable, realSg } from '../../vendor/ceulen/sg/sg-cli.js'
import { buildRunArgs, formatMatches, mergeMatches, parseSearch } from '../../vendor/ceulen/sg/ops.js'

export const name = 'ceulen-sg'
export const inject = ['tools']

const LANGUAGE = { type: 'string', description: 'Tree-sitter language id when the extension is ambiguous: ts, tsx, py, rust, go, java…' }
const GLOBS = { type: 'array', items: { type: 'string' }, description: 'Glob filter, e.g. ["*.ts", "!*.test.ts"].' }
const PATHS = { type: 'array', items: { type: 'string' }, description: 'Files/directories to search (default ["."]).' }

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('sg', settings)) return
  if (!sgAvailable()) return

  const cwdOf = (exec: { agent?: { session: { header?: { cwd?: string } } } }) => exec.agent?.session.header?.cwd ?? process.cwd()

  registerToolSafe(ctx, ceulenTool({
    name: 'ast_grep',
    description: 'Structural code search through the ast-grep CLI. Patterns are real code with $VAR (one node) and $$$ALL (many nodes) meta-variables; use for syntax-aware searches that regex mangles.',
    parameters: objectSchema({
      pattern: { type: 'string', description: 'ast-grep pattern.' },
      patterns: { type: 'array', items: { type: 'string' }, description: 'Extra OR patterns; results are merged and deduped.' },
      language: LANGUAGE,
      globs: GLOBS,
      paths: PATHS,
    }, ['pattern']),
    outputSchema: { type: 'string' },
    async execute(raw, exec) {
      const args = raw as { pattern: string; patterns?: string[]; language?: string; globs?: string[]; paths?: string[] }
      const all = [args.pattern, ...(args.patterns ?? [])]
      const runs = await Promise.all(all.map(pattern => realSg.run(
        cwdOf(exec),
        buildRunArgs({ pattern, language: args.language, globs: args.globs, paths: args.paths, json: true, cwd: cwdOf(exec) }),
        exec.signal,
      ).then(result => parseSearch(result, pattern))))
      const merged = mergeMatches(runs)
      if (merged.patternError !== undefined) throw new Error(merged.patternError)
      return clampText(formatMatches(merged.matches, all.join(' | ')), 20_000)
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'ast_edit',
    description: 'Structural rewrite through ast-grep. Dry-run by default: returns the affected files and diff. Pass write:true to rewrite files in place. Scope with paths/globs.',
    parameters: objectSchema({
      pattern: { type: 'string', description: 'ast-grep pattern.' },
      rewrite: { type: 'string', description: 'Rewrite template reusing the pattern meta-variables.' },
      language: LANGUAGE,
      globs: GLOBS,
      paths: PATHS,
      write: { type: 'boolean', description: 'false (default) = dry-run; true = rewrite files on disk.' },
    }, ['pattern', 'rewrite']),
    outputSchema: { type: 'string' },
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { pattern: string; rewrite: string; language?: string; globs?: string[]; paths?: string[]; write?: boolean }
      const cwd = cwdOf(exec)
      const before = parseSearch(await realSg.run(cwd, buildRunArgs({ pattern: args.pattern, language: args.language, globs: args.globs, paths: args.paths, json: true, cwd }), exec.signal), args.pattern)
      if (before.patternError !== undefined) throw new Error(before.patternError)
      if (before.matches.length === 0) return `no matches for ${args.pattern} — nothing to rewrite`
      if (args.write !== true) {
        const preview = await realSg.run(cwd, buildRunArgs({ pattern: args.pattern, rewrite: args.rewrite, language: args.language, globs: args.globs, paths: args.paths, cwd }), exec.signal)
        const files = [...new Set(before.matches.map(match => match.file))]
        return clampText(`DRY-RUN — ${before.matches.length} match(es) across ${files.length} file(s) would change:\n${files.map(file => `  ${file}`).join('\n')}\n\n${preview.stdout.trim()}`, 20_000)
      }
      const applied = await realSg.run(cwd, buildRunArgs({ pattern: args.pattern, rewrite: args.rewrite, language: args.language, globs: args.globs, paths: args.paths, update: true, cwd }), exec.signal)
      if (applied.exitCode !== 0) throw new Error(`sg rewrite failed: ${applied.stderr.slice(0, 500) || applied.stdout.slice(0, 500)}`)
      const files = [...new Set(before.matches.map(match => match.file))]
      return `rewrote ${before.matches.length} match(es) across ${files.length} file(s):\n${files.map(file => `  ${file}`).join('\n')}`
    },
  }))
}
