import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, objectSchema, registerToolSafe } from '../../core/tools.js'
import { ghAvailable, realGh } from '../../vendor/ceulen/gh/gh-cli.js'
import { executeOp, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, type GhParams } from '../../vendor/ceulen/gh/ops.js'
import { logLine } from '../../core/log.js'

const OP_VALUES = [
  'repo_view', 'file_read', 'pr_view', 'pr_diff',
  'search_issues', 'search_prs', 'search_code', 'search_commits', 'search_repos',
  'run_watch',
] as const

const DESCRIPTION = [
  'Interact with GitHub through the `gh` CLI. Read-only operations:',
  '- repo_view: repository metadata (default branch, stars, language, topics).',
  '- file_read: a repository file (text; binary becomes a notice) at an optional branch/ref.',
  '- pr_view: PR metadata, body, files, reviews.',
  '- pr_diff: a PR unified diff.',
  '- search_issues / search_prs / search_code / search_commits / search_repos: GitHub search with repo/org/user scoping and date filters.',
  '- run_watch: poll an Actions run until completion; on failure, tail each failed job log.',
  '',
  'Prefer this over bash gh: repo normalization, prompt-free execution, and capped output. Mutating flows stay on bash gh.',
].join('\n')

export const name = 'ceulen-gh'
export const inject = ['tools']

function cwdOf(exec: { agent?: { session: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session.header?.cwd ?? process.cwd()
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('gh', settings) || !settings.gh.enabled) return
  if (!ghAvailable()) {
    logLine('gh', 'gh binary not found; github tool not registered')
    return
  }

  registerToolSafe(ctx, ceulenTool({
    name: 'github',
    description: DESCRIPTION,
    parameters: objectSchema({
      op: { type: 'string', enum: [...OP_VALUES], description: 'GitHub operation.' },
      repo: { type: 'string', description: '[host/]owner/repo or a full URL; defaults to the cwd checkout.' },
      branch: { type: 'string', description: 'Branch or ref (file_read, repo_view).' },
      path: { type: 'string', description: 'Repository-relative file path (file_read).' },
      pr: { type: 'string', description: 'PR number, URL, or branch (pr_view, pr_diff).' },
      query: { type: 'string', description: 'Search query (search_*).' },
      since: { type: 'string', description: 'Lower date bound: relative (3d, 2w) or ISO (search_*).' },
      until: { type: 'string', description: 'Upper date bound (search_*).' },
      dateField: { type: 'string', enum: ['created', 'updated'], description: 'Date field for since/until (default created).' },
      limit: { type: 'integer', description: `Max results (search_*; default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}).` },
      run: { type: 'string', description: 'Actions run id or URL (run_watch).' },
      tail: { type: 'integer', description: 'Failed-job log tail lines (run_watch; default 15, max 200).' },
    }, ['op']),
    outputSchema: { type: 'string' },
    timeoutMs: 330_000,
    concurrencySafe: false,
    async execute(args, exec) {
      const params = args as Record<string, unknown>
      try {
        const result = await executeOp(String(params.op), realGh, cwdOf(exec), params as GhParams, exec.signal)
        if (result.image !== undefined) {
          return `${result.text}\n\n[image content omitted in DSH; open the repository URL to view it]`
        }
        return result.text
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    },
  }))
}
