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
import { coldTool, coldToolEntries, ceulenTool, clampText, holdNativeTool, jsonText, nativeTool, nativeToolEntries, objectSchema, registerCommandSafe, registerToolSafe, text } from '../../core/tools.js'
import type { ToolBudgetEntry } from '../../core/tools.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'

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

function describe(name: string): string {
  const definition = definitionFor(name)
  return definition === undefined ? name : `${name} — ${clampText(definition.description, 160)}`
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
    return pattern.test(`${entry.name} ${definition?.description ?? ''}`)
  })
  if (matches.length === 0) return `no cold tool matches /${query}/. ${entries().length} held: ${entries().map(entry => entry.name).join(', ')}`
  return [
    `${matches.length} cold tool(s) matching /${query}/:`,
    ...matches.slice(0, MAX_LISTED).map(entry => `  ${describe(entry.name)}`),
    '',
    'Call one: ceulen_tools { action: "call", name: "<name>", arguments: { ... } }',
  ].join('\n')
}

function list(): string {
  const held = entries()
  if (held.length === 0) return 'no cold tools: every tool is in the prompt (tools.cold is empty)'
  return [
    `${held.length} cold tool(s) behind ceulen_tools:`,
    ...held.map(entry => `  ${describe(entry.name)}`),
  ].join('\n')
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('tools', loadSettingsSync())) return

  registerToolSafe(ctx, ceulenTool({
    name: 'ceulen_tools',
    description: 'Search and call Ceulen tools that are held out of the prompt to save schema bytes (tools.cold). action=search matches a regex over the cold names+descriptions; action=list shows them all; action=call runs one by name with its own arguments object.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['search', 'list', 'call'], description: 'search: regex over cold names+descriptions; list: every cold tool; call: run one by name.' },
      query: { type: 'string', description: 'Regex for search, matched against "<name> <description>".' },
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
      try {
        return await definition.execute(toolArgs, exec)
      } catch (error) {
        throw new Error(`${toolName} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
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
    const scoped = agent?.ctx
    if (scoped === undefined || typeof scoped.inject !== 'function') return
    let names: string[]
    try {
      const settings = loadSettingsSync()
      if (!isModuleEnabled('tools', settings)) return
      // A ceulen tool in the list was already withheld by registerToolSafe.
      names = settings.tools.cold.filter(name => coldTool(name) === undefined)
    } catch {
      return
    }
    const hidden = names.flatMap(name => {
      try {
        const definition = ctx.tools.get?.(name)
        return definition === undefined ? [] : [[name, definition] as const]
      } catch {
        return []
      }
    })
    if (hidden.length === 0) return
    scoped.inject(['tools'], (runtime: PluginContext) => {
      const tools = runtime.tools as unknown as { restrict(filter: { deny: readonly string[] }): () => void }
      try {
        tools.restrict({ deny: hidden.map(([name]) => name) })
      } catch (error) {
        ctx.logger?.warn?.(`ceulen-tools: could not hide ${hidden.map(([name]) => name).join(', ')}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      for (const [, definition] of hidden) holdNativeTool(definition)
    })
  })
}
