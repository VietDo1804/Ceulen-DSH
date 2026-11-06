import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import {
  NOTEBOOKLM_MAX_TIMEOUT_MS,
  NOTEBOOKLM_TIMEOUT_MS,
  notebooklmAvailable,
  realNotebooklm,
} from '../../vendor/ceulen/notebooklm/notebooklm-cli.js'
import {
  describeCommand,
  isBlockedInteractive,
  isDestructive,
  requiresYesFlag,
  writesFiles,
} from '../../vendor/ceulen/notebooklm/ops.js'

export const name = 'ceulen-notebooklm'
export const inject = ['tools']

const OUTPUT_LIMIT_CHARS = 20_000

const DESCRIPTION = [
  'Run a Google NotebookLM command through the `notebooklm` CLI (notebooklm-py). Covers notebooks, sources, grounded chat (`ask`), research, Studio generation (audio/video/slides/reports/quizzes), artifacts, downloads, notes, labels, collections, and sharing.',
  'Arguments are passed verbatim: args:["list","--json"], args:["ask","summarize","-n","<id>","--json"].',
  'Destructive or privacy-changing calls (delete, share, logout, clear, --force overwrite) need confirm:true, and paths that can prompt need a trailing "--yes".',
  '`login`/`auth login` are blocked here — run them once in a terminal.',
].join('\n')

function cwdOf(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('notebooklm', settings)) return
  if (!notebooklmAvailable()) {
    logLine('notebooklm', 'notebooklm CLI not found; tool not registered')
    return
  }

  registerToolSafe(ctx, ceulenTool({
    name: 'notebooklm',
    description: DESCRIPTION,
    parameters: objectSchema({
      args: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'CLI arguments, excluding the `notebooklm` executable itself.',
      },
      confirm: { type: 'boolean', description: 'Set true only after the user has agreed to a destructive or privacy-changing call.' },
      timeout_ms: {
        type: 'integer',
        minimum: 1_000,
        maximum: NOTEBOOKLM_MAX_TIMEOUT_MS,
        description: `Wall-clock budget (default ${NOTEBOOKLM_TIMEOUT_MS}, max ${NOTEBOOKLM_MAX_TIMEOUT_MS}).`,
      },
    }, ['args']),
    outputSchema: { type: 'string' },
    // Two downloads to the same default filename would race; reads stay parallel.
    concurrencySafe: raw => !writesFiles((raw as { args?: string[] }).args ?? []),
    contract: {
      usage: 'notebooklm({ args: ["list", "--json"] })',
    },
    async execute(raw, exec) {
      const params = raw as { args: string[]; confirm?: boolean; timeout_ms?: number }
      const args = params.args
      if (!Array.isArray(args) || args.length === 0) {
        throw new Error("'args' must be a non-empty array of CLI argument strings, e.g. [\"list\", \"--json\"].")
      }

      const blocked = isBlockedInteractive(args)
      if (blocked) {
        throw new Error('`notebooklm login` needs a terminal for the browser flow. Run `notebooklm login` yourself, then `notebooklm auth check --test --json`.')
      }
      if (isDestructive(args)) {
        if (params.confirm !== true) {
          throw new Error(
            `Destructive or privacy-changing operation requires \`confirm: true\`. Command: notebooklm ${describeCommand(args)}`,
          )
        }
        if (requiresYesFlag(args)) {
          throw new Error(
            `notebooklm ${describeCommand(args)} can prompt for confirmation and hang the call. Append "--yes" to args.`,
          )
        }
      }

      const timeoutMs = Math.min(params.timeout_ms ?? NOTEBOOKLM_TIMEOUT_MS, NOTEBOOKLM_MAX_TIMEOUT_MS)
      const result = await realNotebooklm.run(cwdOf(exec), args, exec.signal, timeoutMs)

      if (result.killed) {
        const hint = args[0] === 'generate'
          ? ' Studio generation keeps running server-side: re-run with a larger timeout_ms, or poll with ["artifact","poll","<task-id>","-n","<notebook-id>","--json"].'
          : ''
        throw new Error(`notebooklm ${describeCommand(args)} was cancelled after ${timeoutMs} ms.${hint}`)
      }
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 2_000)
        throw new Error(
          `notebooklm ${describeCommand(args)} failed (exit ${result.exitCode})\n${detail === '' ? '(no output)' : detail}`,
        )
      }

      return clampText(result.stdout || result.stderr || '(empty response)', OUTPUT_LIMIT_CHARS)
    },
  }))
}
