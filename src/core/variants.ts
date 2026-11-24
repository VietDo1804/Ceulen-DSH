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
 * agent's prompt (`steering.cold`) with a scoped `tools.restrict`; a route in
 * `steering.coldModels` gets that hold alone, without the tuned definitions.
 *
 * The route is checked when the agent is created and again on each
 * `model/selection`, so a `/model` switch swaps the definitions before the
 * next step resolves its tools. A child agent's scope inherits its parent's
 * layer, so a child on another route registers the global definition to
 * shadow an inherited variant, and to bring back a tool its lead holds cold:
 * DSH intersects restrictions down the scope chain, and only the child's own
 * registrations are exempt.
 */
import type { AgentLike, PluginContext, ToolDefinition } from './types.js'
import { logLine } from './log.js'
import { agentRoute, routeWanted } from './route.js'
import { isModuleEnabled, loadSettingsSync } from './settings.js'
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
  /** `steered/cold` as last applied; undefined before the first sync. */
  key: string | undefined
  /** `steering.cold` names hidden from this agent by the last sync. */
  held: string[]
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

/**
 * Put the agent's scope in line with its route: tuned definitions when steered,
 * `steering.cold` held when steered or listed in `steering.coldModels`, none otherwise.
 */
export function syncAgent(state: AgentState, route: string | undefined): void {
  const steering = loadSettingsSync().steering
  const steered = routeWanted(steering.models, route)
  const holdsCold = steered || routeWanted(steering.coldModels, route)
  const key = `${steered}/${holdsCold}`
  if (state.key === key) return
  state.key = key
  state.held = []
  for (const dispose of state.disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // A scope the agent already tore down has nothing left to lift.
    }
  }
  const scoped = state.agent.ctx
  if (scoped === undefined || typeof scoped.inject !== 'function') return
  const cold = holdsCold ? steering.cold : []
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
        state.held.push(name)
        done.push(`-${name}`)
      } catch (error) {
        logLine('steering', `steering.cold ${name} not hidden: ${errorMessage(error)}`)
      }
    }
    // A lead that holds these cold hides them from its children too; one on a route that does not gets the global definition back.
    if (!holdsCold) {
      for (const name of steering.cold) {
        let seen: ToolDefinition | undefined
        let global: ToolDefinition | undefined
        try {
          seen = tools.get?.(name, state.agent)
          global = tools.get?.(name)
        } catch {
          continue
        }
        if (seen !== undefined || global === undefined) continue
        try {
          state.disposers.push(tools.register(global))
          done.push(`+${name}`)
        } catch (error) {
          logLine('steering', `steering.cold ${name} not restored: ${errorMessage(error)}`)
        }
      }
    }
    if (done.length > 0) logLine('steering', `${route ?? 'unknown route'} ${steered ? 'tuned' : holdsCold ? 'cold' : 'global'}: ${done.join(', ')}`)
  })
}

/**
 * What an agent is told about the `steering.cold` tools hidden from it: a hidden
 * tool shows no schema, and other prompt text (an MCP server's instructions)
 * still names it, so without this the first call goes to a name that is not
 * there. Names are grouped by MCP server to keep the note short. Empty for an
 * agent that holds nothing.
 */
export function heldToolsNote(agent: unknown): string {
  const id = (agent as Partial<AgentLike> | undefined)?.session?.id
  const held = id === undefined ? undefined : AGENTS.get(String(id))?.held
  if (held === undefined || held.length === 0) return ''
  const settings = loadSettingsSync()
  // Without the dispatcher there is no way in to describe.
  if (!isModuleEnabled('tools', settings)) return ''
  const groups = new Map<string, number>()
  const single: string[] = []
  let sample: { full: string; short: string } | undefined
  for (const name of [...held].sort()) {
    const prefix = /^mcp__.+?__/.exec(name)?.[0]
    if (prefix === undefined) {
      single.push(name)
      continue
    }
    groups.set(prefix, (groups.get(prefix) ?? 0) + 1)
    sample ??= { full: name, short: name.slice(prefix.length) }
  }
  const names = [...[...groups].map(([prefix, count]) => `\`${prefix}*\` (${count} tool${count === 1 ? '' : 's'})`), ...single.map(name => `\`${name}\``)]
  return [
    'Held tools (Ceulen)',
    `These tools work in this session, but their schemas are held out of your tool list to save context: ${names.join(', ')}. None of them can be called by its own name. Read a tool's arguments first with ceulen_tools({ action: "search", query: "<name>" }), then run it with ceulen_tools({ action: "call", name: "<full name>", arguments: { … } }).${settings.codemode.enabled && isModuleEnabled('codemode', settings) ? " Inside a codemode script, tools['<full name>'](args) calls it directly." : ''}${sample === undefined ? '' : ` Other prompt text may use a short name: \`${sample.short}\` is \`${sample.full}\`.`}`,
  ].join('\n')
}

/** Track agents and their route changes; once per process. */
export function installRouteVariants(ctx: PluginContext): void {
  if (installed) return
  installed = true
  ctx.on('agent/created', (payload: { agent?: ScopedAgent } | undefined) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const state: AgentState = { agent, key: undefined, held: [], disposers: [] }
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
