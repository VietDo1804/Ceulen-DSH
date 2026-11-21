/**
 * Per-route tool variants: tuning for one model family without touching what
 * the others are sent.
 *
 * A tool's description and schema are one global registration, so a line
 * written for DeepSeek flash would be read by gpt-6.1-terra as well. DSH lets
 * an agent shadow a global tool with a registration in its own scope
 * (`agent.ctx` → `tools.register`), so an agent on a steered route gets the
 * tuned definition and every other agent keeps the global one, which stays as
 * it was before the tuning. The same seam holds tools out of a steered
 * agent's prompt (`steering.cold`) with a scoped `tools.restrict`.
 *
 * The route is checked when the agent is created and again on each
 * `model/selection`, so a `/model` switch swaps the definitions before the
 * next step resolves its tools. A child agent's scope inherits its parent's
 * layer, so a child on another route registers the global definition to
 * shadow an inherited variant.
 */
import type { AgentLike, PluginContext, ToolDefinition } from './types.js'
import { logLine } from './log.js'
import { agentRoute, routeWanted } from './route.js'
import { loadSettingsSync } from './settings.js'
import { coldTool, errorMessage, holdNativeTool, registerToolSafe } from './tools.js'

interface Variant {
  global: ToolDefinition
  tuned: ToolDefinition
}

interface ScopedTools {
  get?(name: string, scope?: unknown): ToolDefinition | undefined
  register(definition: ToolDefinition): () => void
  restrict(filter: { deny: readonly string[] }): () => void
}

type ScopedAgent = AgentLike & { ctx?: { inject?: PluginContext['inject'] } }

interface AgentState {
  agent: ScopedAgent
  steered: boolean | undefined
  disposers: Array<() => void>
}

/** Keyed by tool name. */
const VARIANTS = new Map<string, Variant>()
const AGENTS = new Map<string, AgentState>()
let installed = false

/**
 * Offer `tuned` instead of `global` to agents on a steered route. `global` must
 * be the definition registered for everyone, so a non-steered child can shadow
 * an inherited variant with it.
 */
export function addRouteVariant(global: ToolDefinition, tuned: ToolDefinition): void {
  VARIANTS.set(global.name, { global, tuned: { ...tuned, name: global.name } })
}

/**
 * Register `global` for every route and `tuned` for the steered ones. A tool
 * held cold or renamed on a collision gets no variant: the variant would put
 * a hot `name` back into a steered agent's prompt.
 */
export function registerWithVariant(ctx: PluginContext, global: ToolDefinition, tuned: ToolDefinition): void {
  const registered = registerToolSafe(ctx, global)
  if (registered.renamed || registered.actual !== global.name || coldTool(global.name) !== undefined) return
  addRouteVariant(global, tuned)
}

/** The tuned definition offered to steered routes, if `name` has one. */
export function routeVariant(name: string): ToolDefinition | undefined {
  return VARIANTS.get(name)?.tuned
}

/** Tests only. */
export function resetRouteVariants(): void {
  VARIANTS.clear()
  AGENTS.clear()
  installed = false
}

export function steeredRouteName(route: string | undefined): boolean {
  return routeWanted(loadSettingsSync().steering.models, route)
}

function isVariant(definition: ToolDefinition | undefined): boolean {
  return definition !== undefined && [...VARIANTS.values()].some(variant => variant.tuned === definition)
}

/** Put the agent's scope in line with its route: tuned definitions and cold names when steered, none otherwise. */
export function syncAgent(state: AgentState, route: string | undefined): void {
  const steered = steeredRouteName(route)
  if (state.steered === steered) return
  state.steered = steered
  for (const dispose of state.disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // A scope the agent already tore down has nothing left to lift.
    }
  }
  const scoped = state.agent.ctx
  if (scoped === undefined || typeof scoped.inject !== 'function') return
  const cold = steered ? loadSettingsSync().steering.cold : []
  scoped.inject(['tools'], (runtime: PluginContext) => {
    const tools = runtime.tools as unknown as ScopedTools
    const done: string[] = []
    for (const [name, variant] of VARIANTS) {
      let definition: ToolDefinition | undefined
      if (steered) definition = variant.tuned
      else {
        // Only to undo an inherited variant; otherwise the global one is already what this agent sees.
        let seen: ToolDefinition | undefined
        try {
          seen = tools.get?.(name, state.agent)
        } catch {
          seen = undefined
        }
        if (isVariant(seen)) definition = variant.global
      }
      if (definition === undefined) continue
      try {
        state.disposers.push(tools.register(definition))
        done.push(name)
      } catch (error) {
        logLine('steering', `route variant ${name} not registered: ${errorMessage(error)}`)
      }
    }
    for (const name of cold) {
      let definition: ToolDefinition | undefined
      try {
        definition = tools.get?.(name, state.agent) ?? tools.get?.(name)
      } catch {
        definition = undefined
      }
      if (definition === undefined) continue
      try {
        state.disposers.push(tools.restrict({ deny: [name] }))
        holdNativeTool(definition)
        done.push(`-${name}`)
      } catch (error) {
        logLine('steering', `steering.cold ${name} not hidden: ${errorMessage(error)}`)
      }
    }
    if (done.length > 0) logLine('steering', `${route ?? 'unknown route'} ${steered ? 'tuned' : 'global'}: ${done.join(', ')}`)
  })
}

/** Track agents and their route changes; once per process. */
export function installRouteVariants(ctx: PluginContext): void {
  if (installed) return
  installed = true
  ctx.on('agent/created', (payload: { agent?: ScopedAgent } | undefined) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const state: AgentState = { agent, steered: undefined, disposers: [] }
    AGENTS.set(String(agent.session.id), state)
    // A non-steered agent with nothing inherited needs no registration at all,
    // but the first sync also records its state for a later switch.
    syncAgent(state, agentRoute(agent))
  })
  ctx.on('agent/disposed', (payload: { agent?: AgentLike } | undefined) => {
    if (payload?.agent !== undefined) AGENTS.delete(String(payload.agent.session.id))
  })
  ctx.on('session/event', (session: { id?: unknown } | undefined, event: { type?: string; data?: { provider?: string; model?: string } } | undefined) => {
    if (event?.type !== 'model/selection' || session?.id === undefined) return
    const state = AGENTS.get(String(session.id))
    const { provider, model } = event.data ?? {}
    if (state === undefined || provider === undefined || model === undefined) return
    syncAgent(state, `${provider}/${model}`)
  })
}
