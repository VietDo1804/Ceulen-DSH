import type { AgentLike, PluginContext } from './types.js'

/**
 * Whether the agent's session is in (or entering) DSH plan mode. Reads the
 * kernel planMode service when composed; the TUI plugin host does not expose
 * it, so fall back to the session's latest `plan/mode` event. No plan-mode
 * service and no events (web/headless) means not in plan mode.
 */
export function planActive(ctx: PluginContext, agent: AgentLike): boolean {
  try {
    const service = ctx.get('planMode', false) as { get?(target: unknown): { active?: boolean; pending?: boolean } | undefined } | undefined
    const state = service?.get?.(agent)
    if (state !== undefined) return (state.pending ?? state.active) === true
    return agent.session.snapshotEvents?.().reduce((active, event) => event.type === 'plan/mode'
      ? (event.data as { active?: boolean } | undefined)?.active === true : active, false) ?? false
  } catch {
    return false
  }
}
