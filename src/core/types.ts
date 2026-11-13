/**
 * Structural views of the DeepSeek Harness services this bundle touches.
 *
 * The plugin deliberately imports no `@deepseek-ai/*` package at runtime:
 * profile-local plugins resolve from the profile tree, where pnpm may not
 * link the harness packages (the dsh-working-activity bare-name failure).
 * `import type` would be erased, but keeping even the types local makes the
 * contract explicit and lets the unit tests use a tiny fake context.
 */

export type TextBlock = { readonly type: 'text'; readonly text: string }
export type ContentBlock = TextBlock | { readonly type: 'image'; readonly [key: string]: unknown }
export type ToolContent = readonly ContentBlock[]

/** One model-facing tool, in the shape `ctx.tools.register()` accepts. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** Raw JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolContent
    /** Tool-private JSON the UI reads back from the settled result. */
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  /** Host-plane card intent for the pending call. */
  presentCall?(args: unknown): unknown
  /** Host-plane card intent for the settled call. */
  presentResult?(args: unknown, result: { readonly content: ToolContent; readonly isError: boolean; readonly meta?: unknown }): unknown
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  readonly timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

/** The execution object handed to a tool body. */
export interface ToolRunContext {
  readonly name: string
  readonly callId?: string
  readonly arguments: unknown
  readonly signal: AbortSignal
  readonly agent?: AgentLike
  /**
   * DSH's step admission (`ResolvedToolSet`), opaque here. A nested dispatcher
   * must pass it on: without it DSH refuses every conditionally registered
   * tool (`web_search`, …) as unknown.
   */
  readonly toolSet?: unknown
  deferContext?(message: UserMessageLike): void
  concludeTurn?(): void
}

export type AgentStatus = string

export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** `agent.model` (DSH 0.2.2): the Agent-owned, durable model choice for the
 * next step to be prepared. A route belongs here, never in `agent/request` —
 * 0.2.2 throws when the waterfall's answer disagrees with the frozen selection. */
export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelSeamLike {
  current?(): Readonly<ModelSelectionLike> | undefined
  select?(selection: Readonly<ModelSelectionLike>): void
}

/** Minimal `Agent` view used by advisor/cron/classifier. */
export interface AgentLike {
  readonly options: AgentOptions
  readonly session: SessionLike
  readonly status: AgentStatus
  readonly model?: ModelSeamLike
  followup(message: UserMessageLike): void
  steer(message: UserMessageLike): void
  inject(message: UserMessageLike): void
  whenIdle?(): Promise<void>
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

export interface SessionHeaderLike {
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly isSeeded?: boolean
}

/** Minimal `Session` view: the durable event log plus derived history. */
export interface SessionLike {
  readonly id: string
  readonly header?: SessionHeaderLike
  readonly seq?: number
  append?(type: string, data: unknown, opts?: unknown): void
  deriveMessages?(): readonly MessageLike[]
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[]
}

export interface MessageLike {
  readonly id?: string
  readonly role: string
  readonly content: readonly ContentBlock[]
  readonly source?: { readonly kind?: string; readonly [key: string]: unknown }
}

export interface SessionEventLike {
  readonly seq?: number
  readonly type: string
  readonly data?: unknown
}

export interface UserMessageLike {
  readonly id?: string
  readonly role: 'user'
  readonly content: ToolContent
  readonly source: { readonly kind: string; readonly [key: string]: unknown }
}

export interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
  readonly sourceEventSeq?: number
}

export interface CommandRegistration {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string }
  readonly recordInput?: boolean
  handler(invocation: { readonly agent?: AgentLike; readonly rawInput: string; readonly signal?: AbortSignal }): CommandResult | Promise<CommandResult>
}

export interface SystemPromptSection {
  readonly name: string
  readonly order?: number
  readonly text: string | (() => string)
  readonly complete?: boolean
  readonly interpolate?: boolean
}

export interface SkillRegistration {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source: string
  readonly whenToUse?: string
  readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly provider?: string
  readonly path?: string
  readonly resourceBase?:
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'opaque'; readonly description: string }
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface LlmStreamOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly unknown[]
  readonly system?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

export interface LlmChunk {
  readonly kind?: string
  readonly type?: string
  readonly text?: string
  readonly delta?: string
  readonly [key: string]: unknown
}

export interface LlmService {
  stream(options: LlmStreamOptions): AsyncIterable<LlmChunk>
  listProviders?(): readonly unknown[]
  /** Public provider-directory metadata; contains no credential values. */
  listConfigurableProviders?(): readonly {
    provider: string
    nativeAuth?: { env: readonly string[]; oauth: boolean }
  }[]
  /** Adapter-advertised models for one registered provider route. */
  listModels?(provider: string): Promise<readonly unknown[]>
}

export interface TuiStatusService {
  set(key: string, text: string | number | boolean | undefined): () => void
}

export interface TuiThemeService {
  register(descriptor: {
    readonly name: string
    readonly displayName?: string
    readonly base: 'light' | 'dark' | 'dark-ansi' | 'claude-dark' | 'claude-paper' | 'codex-lavender' | 'codex-paper'
    readonly colors?: Readonly<Record<string, string>>
  }): () => void
}

export interface ToolRegistryLike {
  register(definition: ToolDefinition): () => void
  get?(name: string, scope?: unknown): ToolDefinition | undefined
  /** Registered schemas, for budget reporting (optional on older hosts). */
  schemas?(scope?: unknown): readonly { name: string; description?: string; parameters?: unknown }[]
}

export interface CommandRegistryLike {
  register(registration: CommandRegistration): () => void
}

export interface SystemPromptLike {
  section(section: SystemPromptSection): () => void
}

export interface SkillRegistryLike {
  register(skill: SkillRegistration): () => void
}

// biome-ignore lint/suspicious/noExplicitAny: DSH emits untyped event payloads
export type EventListener = (...args: any[]) => unknown

/**
 * The slice of `cordis.Context` this bundle uses. Every other DSH service is
 * reached through `get(name, false)` and treated as optional.
 */
export interface PluginContext {
  readonly tools: ToolRegistryLike
  readonly commands: CommandRegistryLike
  readonly systemPrompt: SystemPromptLike
  readonly skills?: SkillRegistryLike
  readonly llm?: LlmService
  on(event: string, listener: EventListener): unknown
  effect(callback: () => void | (() => void), label?: string): unknown
  inject(deps: readonly string[], callback: (ctx: PluginContext) => void): unknown
  // biome-ignore lint/suspicious/noExplicitAny: service shapes differ per name
  get(name: string, strict?: boolean): any
  readonly logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
  readonly baseUrl?: string
}
