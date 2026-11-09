import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { appendChange, deliver, moveCursor, type ChangeEntry } from './notice.js'
import { newestPacket, reportsDir } from './reports.js'
import { askEvo, routesFor } from './cycle.js'
import { stamp } from './paths.js'

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
    description: 'Record a self-improvement change (rule promoted, skill updated, memory stored) and show it in the session as a "💾 Self-improvement" notice. Call it once per evo pass, after the change actually landed.',
    parameters: objectSchema({
      summary: { type: 'string', description: 'One line: what changed, e.g. "promoted 2 rules: read-before-edit, apply_patch anchors".' },
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

  registerToolSafe(ctx, ceulenTool({
    name: 'evo_pass',
    description: 'Run the evo improvement pass: feed the newest promotion packet (the signatures still occurring this week) to the configured Evo model (ceulen-config → Model → Evo) and write reports/proposal-<date>.md. Never edits RULES.md — the caller reviews and applies it.',
    parameters: objectSchema({}),
    outputSchema: { type: 'string' },
    async execute(_args, exec) {
      const packet = newestPacket()
      if (packet === undefined) throw new Error('no promotion packet: run the evo-report script with --promote first')
      const routes = routesFor(exec.agent)
      if (routes.length === 0) throw new Error('no evo route: set evo.provider/model in /ceulen-config → Model → Evo, or run inside a session with a provider')
      // The packet states its own work list; an empty one is not worth a model call.
      const work = /^Work list: (\d+)/m.exec(packet.text)
      if (work !== null && Number(work[1]) === 0) return `nothing to draft: ${packet.name} lists no signature that is still occurring this week and raised inside this repo`
      const draft = await askEvo(ctx, routes, packet.text, exec.signal)
      const note = draft.truncated ? '> Cut at the token limit: the unfinished last line was dropped and the list may be incomplete.\n\n' : ''
      mkdirSync(reportsDir(), { recursive: true })
      const file = join(reportsDir(), `proposal-${stamp()}.md`)
      writeFileSync(file, `# evo proposal — ${stamp()}\n\nSource: ${packet.name}\n\n${note}${draft.text}\n`)
      runtime.flash('💾 evo · proposal ready')
      logLine('evo', `proposal written from ${packet.name} via ${draft.route.provider}/${draft.route.model}${draft.truncated ? ' (cut at the token limit)' : ''}`)
      return `proposal: ${file}${draft.truncated ? ' (cut at the token limit; may be incomplete)' : ''}\n\n${clampText(draft.text, 1_600)}`
    },
  }))
}
