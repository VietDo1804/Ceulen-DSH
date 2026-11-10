import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { appendChange, deliver, moveCursor, type ChangeEntry } from './notice.js'

export interface EvoRuntime {
  /** Status-line flash owned by the root activation. */
  flash(text: string): void
}

/** Record a change and deliver the notice to the live session when there is one. */
export function recordChange(runtime: EvoRuntime, exec: ToolRunContext | undefined, summary: string, detail?: string): { entry: ChangeEntry; delivered: boolean } {
  const entry = appendChange(summary, detail)
  const agent = exec?.agent
  const delivered = agent === undefined ? false : deliver(agent, [entry])
  if (delivered) moveCursor(entry.at)
  runtime.flash(`💾 evo · ${clampText(summary, 60)}`)
  logLine('evo', `change recorded: ${clampText(summary, 160)}${delivered ? '' : ' (no live session)'}`)
  return { entry, delivered }
}

export function registerEvoTools(ctx: PluginContext, runtime: EvoRuntime): void {
  registerToolSafe(ctx, ceulenTool({
    name: 'evo_notice',
    description: 'Record a self-improvement change that actually landed (a merged fix from the weekly review, a memory stored) and show it in the session as a "💾 Self-improvement" notice. Call it once per review, after the change is in. A report alone is not a change.',
    parameters: objectSchema({
      summary: { type: 'string', description: 'One line: what changed, e.g. "web tools accept the argument aliases models send (commit 4907165)".' },
      detail: { type: 'string', description: 'Optional evidence: counts, sessions, file paths.' },
    }, ['summary']),
    outputSchema: { type: 'string' },
    async execute(args, exec) {
      const summary = String((args as { summary?: unknown }).summary ?? '').trim()
      if (summary === '') throw new Error('summary is required: one line describing what changed')
      const detail = (args as { detail?: unknown }).detail
      const result = recordChange(runtime, exec, clampText(summary, 240), typeof detail === 'string' && detail.trim() !== '' ? clampText(detail, 400) : undefined)
      return result.delivered
        ? `recorded and shown: ${result.entry.summary}`
        : `recorded (no live session): ${result.entry.summary}`
    },
  }))
}
