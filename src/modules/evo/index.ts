import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { tuiStatusPublisher } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { deliver, moveCursor, pendingChanges } from './notice.js'
import { registerEvoCommands } from './commands.js'
import { registerEvoTools } from './tools.js'

export const name = 'ceulen-evo'
export const inject = ['tools', 'commands', 'llm']

// Kept as the module's public surface: tests and docs use these two.
export { noticeText, pendingChanges, type ChangeEntry } from './notice.js'

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('evo', loadSettingsSync())) return

  const publish = tuiStatusPublisher(ctx, 'ceulen:evo')
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  const flash = (text: string): void => {
    publish(text)
    clearTimer?.unref?.()
    if (clearTimer !== undefined) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => publish(undefined), 15_000)
    clearTimer.unref?.()
  }
  const runtime = { flash }

  registerEvoTools(ctx, runtime)
  registerEvoCommands(ctx, flash)

  // Show anything the cron pass recorded while the user was away, once per session.
  const shownIn = new Set<string>()
  const seenRunning = new Set<string>()
  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const sessionId = String(agent.session.id)
    if (payload.status === 'running') {
      seenRunning.add(sessionId)
      return
    }
    if (payload.status !== 'idle' || !seenRunning.has(sessionId) || shownIn.has(sessionId)) return
    seenRunning.delete(sessionId)
    const pending = pendingChanges()
    if (pending.length === 0) {
      shownIn.add(sessionId)
      return
    }
    if (!deliver(agent, pending)) return
    moveCursor(pending[pending.length - 1]!.at)
    shownIn.add(sessionId)
    logLine('evo', `delivered ${pending.length} pending change(s) to session ${sessionId}`)
  })
}

export const _test = { pendingChanges }
