import type { PluginContext, TextBlock, ToolContent, ToolDefinition, ToolRunContext } from './types.js'
import { logLine } from './log.js'
import { isModuleEnabled, loadSettingsSync } from './settings.js'
import { coerceBySchema, missingRequired, shapeProblem, withCallShape } from './toolguard.js'

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
 * append the accepted call shape only when the failure is about the shape —
 * the arguments do not fit the schema, or the body died on a TypeError. The
 * body speaks first: its own message for a missing key ("delete needs
 * confirm: true") says more than a generic one. Only a crash on the missing
 * value (`Cannot read properties of undefined`) is replaced by its name.
 * Normalization is best-effort: a throw in there must not be the reason a call
 * fails, so it falls back to the raw arguments.
 */
function contractWrapped(options: CeulenToolOptions): ToolDefinition['execute'] {
  const run = options.execute
  const shape = options.contract?.usage ?? options.parameters
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
      const problem = shapeProblem(repaired, options.parameters)
      const crashed = error instanceof TypeError
      if (!crashed && problem === undefined) throw error
      // A crash on a value that was never sent: name the value, not the stack.
      const message = crashed && missingRequired(repaired, options.parameters).length > 0 ? (problem ?? errorMessage(error)) : errorMessage(error)
      throw new Error(withCallShape(message, shape, options.name), { cause: error })
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

type HeldTool = ToolBudgetEntry & { definition: ToolDefinition }

function budgetEntry(definition: ToolDefinition, name = definition.name): ToolBudgetEntry {
  return {
    name,
    descriptionBytes: Buffer.byteLength(definition.description ?? ''),
    parameterBytes: Buffer.byteLength(JSON.stringify(definition.parameters ?? {})),
  }
}

function hold(held: Map<string, HeldTool>, definition: ToolDefinition): void {
  held.set(definition.name, { ...budgetEntry(definition), definition })
}

function entries(held: Map<string, HeldTool>): readonly ToolBudgetEntry[] {
  return [...held.values()].map(({ name, descriptionBytes, parameterBytes }) => ({ name, descriptionBytes, parameterBytes }))
}

/**
 * Tools held out of the prompt (`tools.cold`) and reachable through
 * `ceulen_tools`. The registry keeps the full definition, so dispatch runs the
 * real body with its own contract and render.
 */
const coldTools = new Map<string, HeldTool>()

export function coldToolEntries(): readonly ToolBudgetEntry[] {
  return entries(coldTools)
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
const nativeColdTools = new Map<string, HeldTool>()

export function holdNativeTool(definition: ToolDefinition): void {
  hold(nativeColdTools, definition)
}

export function nativeTool(name: string): ToolDefinition | undefined {
  return nativeColdTools.get(name)?.definition
}

export function nativeToolEntries(): readonly ToolBudgetEntry[] {
  return entries(nativeColdTools)
}

export function resetNativeTools(): void {
  nativeColdTools.clear()
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
      hold(coldTools, definition)
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
    toolBudget.set(actual, budgetEntry(definition, actual))
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

export interface TuiScenesLike {
  register(descriptor: { id: string; title?: string; component: unknown }, identity?: unknown): () => void
  open(id: string): boolean
}

/** The TUI's full-screen scene registry; absent in headless profiles. */
export function sceneService(ctx: PluginContext): TuiScenesLike | undefined {
  try {
    const service = ctx.get('tuiScenes', false) as TuiScenesLike | undefined
    if (service === undefined || typeof service.register !== 'function' || typeof service.open !== 'function') return undefined
    return service
  } catch {
    return undefined
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

/** Levenshtein distance; used for "did you mean" suggestions on short names. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const insert = (previous[j] ?? 0) + 1
      const remove = (current[j - 1] ?? 0) + 1
      const swap = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(insert, remove, swap)
    }
    previous = current
  }
  return previous[b.length] ?? b.length
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

/** Tool-call `arguments` as an object; providers send it parsed or as a JSON string. */
export function toolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return asRecord(raw)
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** The calling session's working directory, falling back to the process cwd. */
export function cwdOf(exec?: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * The calling session's file policy (mode + workspace roots) from DSH's
 * `sandboxPolicy` service, or undefined when none is mounted. A filesystem
 * mutation must carry it: without it `ctx.fs` falls back to the deployment
 * default, so a `danger-full-access` session was refused outside the
 * workspace and a `read-only` one could still write inside it.
 */
export function sessionSandboxPolicy(ctx: PluginContext, session: unknown): unknown {
  if (session === undefined) return undefined
  try {
    const service = ctx.get('sandboxPolicy', false) as { resolve?(options: { session: unknown }): unknown } | undefined
    if (service === undefined || typeof service.resolve !== 'function') return undefined
    return service.resolve({ session })
  } catch {
    return undefined
  }
}

/** Clamp a command's output so a TUI transcript stays readable. */
export function clampText(value: string, max = 4_000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… (${value.length - max} chars truncated)`
}
