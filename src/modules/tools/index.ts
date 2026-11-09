/**
 * Tool-level deferral (M4-2): a tool held out of the prompt costs no schema
 * bytes on any turn, and `ceulen_tools` keeps it one call away.
 *
 * The DSH registry does allow runtime register/unregister (`register()` returns
 * the disposer), but `deferLoading: true` alone does not make a plugin tool
 * callable: on routes with tool updates the model activates a deferred tool
 * only after a `tool-addition` developer block, and no plugin seam writes one.
 * So the cold half is held in-process by `registerToolSafe` and dispatched
 * here instead of registered as a deferred schema.
 */
import type { AgentLike, PluginContext, ToolDefinition } from '../../core/types.js'
import { coldTool, coldToolEntries, ceulenTool, holdNativeTool, jsonText, nativeTool, nativeToolEntries, objectSchema, registerCommandSafe, registerToolSafe, text } from '../../core/tools.js'
import type { ToolBudgetEntry } from '../../core/tools.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { logLine } from '../../core/log.js'
import { missingRequired, synthesizeUsage } from '../../core/toolguard.js'

export const name = 'ceulen-tools'
export const inject = ['tools', 'commands']

const MAX_LISTED = 20

/** Both halves of `tools.cold`: the ceulen tools withheld at register time and
 * the native tools hidden with a scope-local `tools.restrict({ deny })`. */
function entries(): readonly ToolBudgetEntry[] {
  return [...coldToolEntries(), ...nativeToolEntries()]
}

function definitionFor(name: string): ToolDefinition | undefined {
  return coldTool(name) ?? nativeTool(name)
}

/** Full descriptions and argument lists are printed for at most this many tools. */
const MAX_DETAILED = 3

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The way a cold tool is actually called: through `ceulen_tools`, never by its own name. */
function callShape(name: string, argumentsShape?: string): string {
  const definition = definitionFor(name)
  const shape = argumentsShape ?? (definition === undefined ? '{ … }' : synthesizeUsage(definition.parameters))
  return `ceulen_tools({ action: "call", name: "${name}", arguments: ${shape} })`
}

/** One line of description plus the call, for a long listing. */
function describe(name: string): string {
  const definition = definitionFor(name)
  if (definition === undefined) return name
  return `${name} — ${oneLine(definition.description, 160)}\n    call: ${callShape(name)}`
}

/**
 * Everything the model needs to call the tool without guessing: the whole
 * description (argument rules often live in its tail) and every argument with
 * its type. A cold tool has no schema in the prompt, so this is the only place
 * the model can read one.
 */
function describeFully(name: string): string {
  const definition = definitionFor(name)
  if (definition === undefined) return name
  const parameters = (definition.parameters ?? {}) as { properties?: Record<string, { type?: unknown; enum?: unknown; description?: unknown }>; required?: unknown }
  const required = Array.isArray(parameters.required) ? parameters.required : []
  const lines = Object.entries(parameters.properties ?? {}).map(([key, prop]) => {
    const type = Array.isArray(prop?.enum) ? prop.enum.map(entry => JSON.stringify(entry)).join(' | ') : typeof prop?.type === 'string' ? prop.type : 'any'
    const note = typeof prop?.description === 'string' && prop.description.length > 0 ? ` — ${oneLine(prop.description, 240)}` : ''
    return `      ${key} (${type}${required.includes(key) ? ', required' : ''})${note}`
  })
  return [
    `${name} — ${oneLine(definition.description, 1_200)}`,
    `    call: ${callShape(name)}`,
    ...(lines.length === 0 ? [] : ['    arguments:', ...lines]),
  ].join('\n')
}

function render(names: readonly string[]): string[] {
  return names.length <= MAX_DETAILED ? names.map(describeFully) : names.slice(0, MAX_LISTED).map(describe)
}

function search(query: string): string {
  let pattern: RegExp
  try {
    pattern = new RegExp(query, 'i')
  } catch (error) {
    throw new Error(`invalid query regex: ${error instanceof Error ? error.message : String(error)}`)
  }
  const matches = entries().filter(entry => {
    const definition = definitionFor(entry.name)
    // The name alone first, so an anchored `^web_interact$` finds its tool.
    return pattern.test(entry.name) || pattern.test(`${entry.name} ${definition?.description ?? ''}`)
  })
  if (matches.length === 0) return `no cold tool matches /${query}/. ${entries().length} held: ${entries().map(entry => entry.name).join(', ')}`
  return [
    `${matches.length} cold tool(s) matching /${query}/:`,
    ...render(matches.map(entry => entry.name)).map(block => `  ${block}`),
    ...(matches.length > MAX_DETAILED ? ['', `Search for one name (query: "^<name>$") to print its full description and argument types.`] : []),
  ].join('\n')
}

function list(): string {
  const held = entries()
  if (held.length === 0) return 'no cold tools: every tool is in the prompt (tools.cold is empty)'
  return [
    `${held.length} cold tool(s) behind ceulen_tools:`,
    ...held.map(entry => `  ${describe(entry.name)}`),
    '',
    `Search for one name (query: "^<name>$") to print its full description and argument types.`,
  ].join('\n')
}

/**
 * The shape a failed cold call should be retried with. The cold tool's own
 * contract names itself (`web_interact({ url })`), which is not callable, so
 * its argument part is lifted into the `ceulen_tools` form.
 */
function coldCallError(name: string, message: string): string {
  const [body, inner] = message.split('\n\nCall as: ')
  if (inner === undefined) return `${name} failed: ${message}`
  const own = inner.trim()
  const lifted = own.startsWith(`${name}(`) && own.endsWith(')') ? own.slice(name.length + 1, -1) : undefined
  return `${name} failed: ${body}\n\nCall as: ${callShape(name, lifted)}`
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('tools', loadSettingsSync())) return

  registerToolSafe(ctx, ceulenTool({
    name: 'ceulen_tools',
    description: 'Search and call Ceulen tools that are held out of the prompt to save schema bytes (tools.cold). action=search matches a regex over the cold names+descriptions and prints the arguments each match takes; action=list shows them all; action=call runs one by name with its own arguments object. Search before the first call of a tool: its arguments are listed nowhere else.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['search', 'list', 'call'], description: 'search: regex over cold names+descriptions; list: every cold tool; call: run one by name.' },
      query: { type: 'string', description: 'Regex for search, matched against the name and against "<name> <description>".' },
      name: { type: 'string', description: 'Cold tool name (call only).' },
      arguments: { type: 'object', description: "The cold tool's own arguments object (call only)." },
    }, ['action']),
    outputSchema: {},
    render(args, value) {
      const record = args as { action?: unknown; name?: unknown; arguments?: unknown }
      if (record?.action === 'call' && typeof record.name === 'string') {
        const definition = definitionFor(record.name)
        if (definition !== undefined) {
          try {
            return definition.output.render((record.arguments ?? {}) as never, value as never)
          } catch {
            // Fall through to the generic projection.
          }
        }
      }
      return typeof value === 'string' ? text(value) : jsonText(value)
    },
    async execute(raw, exec) {
      const args = raw as { action?: unknown; query?: unknown; name?: unknown; arguments?: unknown }
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('search needs a query regex')
        return search(query)
      }
      if (action === 'list') return list()
      if (action !== 'call') throw new Error('action must be one of: search, list, call')
      const toolName = typeof args.name === 'string' ? args.name.trim() : ''
      if (toolName === '') throw new Error('call needs a name')
      const definition = definitionFor(toolName)
      if (definition === undefined) {
        const held = entries().map(entry => entry.name)
        const registered = (() => {
          try {
            return ctx.tools.get?.(toolName) !== undefined
          } catch {
            return false
          }
        })()
        throw new Error(registered
          ? `${toolName} is not cold; call it directly`
          : `unknown cold tool "${toolName}". Held: ${held.join(', ') || '(none)'}`)
      }
      const toolArgs = args.arguments !== null && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}
      // This dispatch skips the registry's schema check a native tool is
      // written against, so restore it for those. A ceulen tool has its own
      // contract layer and its body may say more about the missing key.
      const missing = coldTool(toolName) === undefined ? missingRequired(toolArgs, definition.parameters ?? {}) : []
      if (missing.length > 0) {
        throw new Error(coldCallError(toolName, `missing required argument${missing.length > 1 ? 's' : ''} ${missing.map(key => `"${key}"`).join(', ')}\n\nCall as: ${toolName}(${synthesizeUsage(definition.parameters ?? {})})`))
      }
      try {
        return await definition.execute(toolArgs, exec)
      } catch (error) {
        throw new Error(coldCallError(toolName, error instanceof Error ? error.message : String(error)), { cause: error })
      }
    },
  }))

  registerCommandSafe(ctx, {
    name: 'cold-tools',
    description: 'List the tools held out of the prompt (tools.cold) and the bytes they save',
    handler() {
      const held = entries()
      const bytes = held.reduce((total, entry) => total + entry.descriptionBytes + entry.parameterBytes, 0)
      return {
        kind: 'success',
        text: [
          `cold tools ${held.length} · ~${(bytes / 1024).toFixed(1)} KB of schema held behind ceulen_tools`,
          ...held.map(entry => `  ${entry.name}  ${((entry.descriptionBytes + entry.parameterBytes) / 1024).toFixed(2)} KB`),
        ].join('\n'),
      }
    },
  })

  // Native half of `tools.cold`. DSH registers those tools itself, so the only
  // seam is a scope-local restriction on the agent: `deny` removes the schema
  // from what the model is offered while the definition stays dispatchable.
  ctx.on('agent/created', (payload: { agent?: AgentLike }) => {
    const agent = payload?.agent as (AgentLike & { ctx?: { inject?: PluginContext['inject'] } }) | undefined
    if (agent === undefined) return
    let names: string[]
    try {
      const settings = loadSettingsSync()
      if (!isModuleEnabled('tools', settings)) return
      // A ceulen tool in the list was already withheld by registerToolSafe.
      names = settings.tools.cold.filter(name => coldTool(name) === undefined)
    } catch {
      return
    }
    if (names.length === 0) return
    const scoped = agent.ctx
    if (scoped === undefined || typeof scoped.inject !== 'function') {
      logLine('plugin', `native cold tools NOT hidden (${names.join(', ')}): the created agent exposes no scoped ctx`)
      return
    }
    scoped.inject(['tools'], (runtime: PluginContext) => {
      const tools = runtime.tools as unknown as {
        get?(name: string, scope?: unknown): ToolDefinition | undefined
        restrict(filter: { deny: readonly string[] }): () => void
      }
      const hidden: string[] = []
      const refused: string[] = []
      for (const name of names) {
        // Look the tool up as this agent sees it. The global view (no scope)
        // misses every tool an app registers in a scoped layer: in the TUI
        // that is all of the native ones, and the lookup used to come back
        // empty and end here without a word.
        let definition: ToolDefinition | undefined
        try {
          definition = tools.get?.(name, agent) ?? tools.get?.(name)
        } catch {
          definition = undefined
        }
        // Not registered for this agent: a disabled module or an absent plugin.
        if (definition === undefined) continue
        // One name per restriction: the registry refuses a whole deny list for
        // a single name it cannot mask, and restrictions intersect anyway.
        try {
          tools.restrict({ deny: [name] })
          holdNativeTool(definition)
          hidden.push(name)
        } catch (error) {
          refused.push(`${name} (${error instanceof Error ? error.message.split(';')[0] : String(error)})`)
        }
      }
      if (hidden.length > 0) logLine('plugin', `native cold tools hidden: ${hidden.join(', ')}`)
      if (refused.length > 0) {
        ctx.logger?.warn?.(`ceulen-tools: could not hide ${refused.join(', ')}`)
        logLine('plugin', `native cold tools NOT hidden: ${refused.join(', ')}`)
      }
    })
  })
}
