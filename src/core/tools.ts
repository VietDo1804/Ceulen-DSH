import type { PluginContext, TextBlock, ToolContent, ToolDefinition, ToolRunContext } from './types.js'
import { logLine } from './log.js'
import { isModuleEnabled, loadSettingsSync } from './settings.js'
import { coerceBySchema, withCallShape } from './toolguard.js'

/** One text-only tool result. */
export function text(value: string): readonly TextBlock[] {
  return [{ type: 'text', text: value }]
}

export function jsonText(value: unknown): readonly TextBlock[] {
  return text(JSON.stringify(value, null, 2))
}

/** Per-tool repair of the literal mistakes models make in the arguments object. */
export interface ToolContract {
  /** Overrides the derived one-line call shape shown on an error. */
  usage?: string
  /** Extra normalization after schema coercion; must not invent a required value. */
  normalize?(args: Record<string, unknown>): Record<string, unknown>
}

export interface CeulenToolOptions {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Argument repair and the call-shape hint shown when the body rejects a call. */
  contract?: ToolContract
  /** Canonical output schema; defaults to a string. */
  outputSchema?: Record<string, unknown>
  /** Optional custom content projection (e.g. image + text). */
  render?: (args: unknown, value: unknown) => ToolContent
  /** Tool-private JSON the UI reads back from the settled result. */
  presentationMeta?: ToolDefinition['output']['presentationMeta']
  /** Host-plane card intent for the pending call. */
  presentCall?: ToolDefinition['presentCall']
  /** Host-plane card intent for the settled call. */
  presentResult?: ToolDefinition['presentResult']
  timeoutMs?: number
  concurrencySafe?: boolean | ((args: unknown) => boolean)
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/**
 * Build a plain `ToolDefinition`. We intentionally avoid `defineTool` so the
 * package carries no runtime import from the harness; the registry accepts the
 * same structural shape.
 */
export function ceulenTool(options: CeulenToolOptions): ToolDefinition {
  const definition: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema ?? { type: 'string' },
      render: options.render ?? ((_args, value) => (typeof value === 'string' ? text(value) : jsonText(value))),
      ...(options.presentationMeta === undefined ? {} : { presentationMeta: options.presentationMeta }),
    },
    ...(options.presentCall === undefined ? {} : { presentCall: options.presentCall }),
    ...(options.presentResult === undefined ? {} : { presentResult: options.presentResult }),
    execute: contractWrapped(options),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.concurrencySafe === undefined
      ? {}
      : { isConcurrencySafe: typeof options.concurrencySafe === 'function' ? options.concurrencySafe : () => options.concurrencySafe === true }),
  }
  return definition
}

/**
 * Wrap the body with the contract layer: coerce what models actually send, then
 * — only when the body still refuses the call — append the accepted call shape.
 * Normalization is best-effort: a throw in there must not be the reason a call
 * fails, so it falls back to the raw arguments.
 */
function contractWrapped(options: CeulenToolOptions): ToolDefinition['execute'] {
  const run = options.execute
  const usage = options.contract?.usage
  const normalize = options.contract?.normalize
  return async (args, exec) => {
    let repaired: unknown = args
    try {
      const coerced = coerceBySchema(args, options.parameters)
      repaired = normalize === undefined ? coerced : (normalize(coerced) ?? coerced)
    } catch {
      repaired = args
    }
    try {
      return await run(repaired, exec)
    } catch (error) {
      throw new Error(withCallShape(errorMessage(error), usage ?? options.parameters), { cause: error })
    }
  }
}

export interface RegisteredTool {
  readonly requested: string
  readonly actual: string
  readonly renamed: boolean
}

/**
 * Prompt-budget ledger: every registered schema is prompt bytes on every turn,
 * and a budget cannot be kept for a surface nobody counted. Process-local, no
 * I/O; `/ceulen tools` reads it (with the live registry as the count source).
 */
export interface ToolBudgetEntry {
  name: string
  descriptionBytes: number
  parameterBytes: number
}

const toolBudget = new Map<string, ToolBudgetEntry>()

export function toolBudgetEntries(): readonly ToolBudgetEntry[] {
  return [...toolBudget.values()]
}

/** Clear the ledger (`session/created`, tests). */
export function resetToolBudget(): void {
  toolBudget.clear()
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Tools held out of the prompt (`tools.cold`) and reachable through
 * `ceulen_tools`. The registry keeps the full definition, so dispatch runs the
 * real body with its own contract and render.
 */
const coldTools = new Map<string, ToolBudgetEntry & { definition: ToolDefinition }>()

export function coldToolEntries(): readonly ToolBudgetEntry[] {
  return [...coldTools.values()].map(entry => ({
    name: entry.name,
    descriptionBytes: entry.descriptionBytes,
    parameterBytes: entry.parameterBytes,
  }))
}

export function coldTool(name: string): ToolDefinition | undefined {
  return coldTools.get(name)?.definition
}

export function resetColdTools(): void {
  coldTools.clear()
}

/**
 * The native half of `tools.cold`: DSH owns those registrations, so a plugin
 * cannot withhold them at register time. The tools module hides each name with
 * a scope-local `tools.restrict({ deny })` — the schema stops being declared —
 * and captures the definition here so `ceulen_tools` still runs the real body.
 */
const nativeColdTools = new Map<string, ToolBudgetEntry & { definition: ToolDefinition }>()

export function holdNativeTool(definition: ToolDefinition): void {
  nativeColdTools.set(definition.name, {
    name: definition.name,
    descriptionBytes: byteLength(definition.description ?? ''),
    parameterBytes: byteLength(JSON.stringify(definition.parameters ?? {})),
    definition,
  })
}

export function nativeTool(name: string): ToolDefinition | undefined {
  return nativeColdTools.get(name)?.definition
}

export function nativeToolEntries(): readonly ToolBudgetEntry[] {
  return [...nativeColdTools.values()].map(entry => ({
    name: entry.name,
    descriptionBytes: entry.descriptionBytes,
    parameterBytes: entry.parameterBytes,
  }))
}

export function resetNativeTools(): void {
  nativeColdTools.clear()
}

function holdColdTool(definition: ToolDefinition): void {
  coldTools.set(definition.name, {
    name: definition.name,
    descriptionBytes: byteLength(definition.description ?? ''),
    parameterBytes: byteLength(JSON.stringify(definition.parameters ?? {})),
    definition,
  })
}

function recordToolBudget(definition: ToolDefinition, actual: string): void {
  toolBudget.set(actual, {
    name: actual,
    descriptionBytes: byteLength(definition.description ?? ''),
    parameterBytes: byteLength(JSON.stringify(definition.parameters ?? {})),
  })
}

/**
 * Register a tool, avoiding duplicate names. A collision is not fatal: the tool
 * is exposed as `ceulen_<name>` when that alias is free, so the module remains
 * usable alongside a native tool with the same name.
 */
export function registerToolSafe(ctx: PluginContext, definition: ToolDefinition): RegisteredTool {
  // A cold tool costs no schema bytes: it is held in-process and reachable
  // through `ceulen_tools` (search by regex, then call by name).
  try {
    const settings = loadSettingsSync()
    // The dispatcher is the tools module: without it a cold tool would be lost.
    if (isModuleEnabled('tools', settings) && settings.tools.cold.includes(definition.name)) {
      holdColdTool(definition)
      logLine('plugin', `tool ${definition.name} held behind ceulen_tools (tools.cold)`)
      return { requested: definition.name, actual: definition.name, renamed: false }
    }
  } catch {
    // Unreadable settings must not hide a tool.
  }
  let actual = definition.name
  let renamed = false
  try {
    const existing = ctx.tools.get?.(actual)
    if (existing !== undefined) {
      actual = `ceulen_${definition.name}`
      renamed = true
      if (ctx.tools.get?.(actual) !== undefined) {
        logLine('plugin', `tool ${definition.name} and alias ${actual} already exist; skipped`)
        return { requested: definition.name, actual: definition.name, renamed: false }
      }
    }
    ctx.tools.register({ ...definition, name: actual })
    // Keyed by the registered name, so a collision alias is one entry.
    recordToolBudget(definition, actual)
    if (renamed) logLine('plugin', `tool ${definition.name} collided; registered as ${actual}`)
  } catch (error) {
    logLine('plugin', `failed to register tool ${actual}: ${errorMessage(error)}`)
  }
  return { requested: definition.name, actual, renamed }
}

/** Register a command, logging rather than throwing on a duplicate. */
export function registerCommandSafe(ctx: PluginContext, registration: Parameters<PluginContext['commands']['register']>[0]): boolean {
  try {
    ctx.commands.register(registration)
    return true
  } catch (error) {
    logLine('plugin', `failed to register command /${registration.name}: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Publish one keyed TUI status line. The TUI rejects writes made from the
 * plugin's composition root ("requires a live non-root plugin activation"),
 * so the service is resolved through an injected child activation instead;
 * a root-context write silently no-ops (the usage module's finding).
 */
export function tuiStatusPublisher(ctx: PluginContext, key: string): (text: string | undefined) => void {
  let statusCtx: PluginContext | undefined
  try {
    ctx.inject(['tuiStatus'], child => {
      try {
        const service = child.get('tuiStatus', false)
        if (service !== undefined && typeof (service as { set?: unknown }).set === 'function') statusCtx = child
      } catch {
        // Optional surface.
      }
    })
  } catch {
    // Optional surface.
  }
  return text => {
    if (statusCtx === undefined) return
    try {
      const service = statusCtx.get('tuiStatus', false) as { set?(key: string, text?: string): unknown } | undefined
      service?.set?.(key, text)
    } catch {
      // Optional surface.
    }
  }
}

/** Register a system-prompt section, tolerating an absent prompt service. */
export function registerPromptSection(ctx: PluginContext, section: Parameters<PluginContext['systemPrompt']['section']>[0]): boolean {
  try {
    ctx.systemPrompt.section(section)
    return true
  } catch (error) {
    logLine('plugin', `failed to register prompt section ${section.name}: ${errorMessage(error)}`)
    return false
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Build an object JSON Schema with no additional properties by default. */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties = false,
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Clamp a command's output so a TUI transcript stays readable. */
export function clampText(value: string, max = 4_000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… (${value.length - max} chars truncated)`
}

/** Render a simple aligned key/value block for command output. */
export function renderPairs(pairs: readonly [string, string][]): string {
  const width = pairs.reduce((max, [key]) => Math.max(max, key.length), 0)
  return pairs.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n')
}
