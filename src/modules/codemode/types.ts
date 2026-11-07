/** Lossless JSON is the only value shape the PTC bridge transports. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type BindingFunction = (args: unknown) => Promise<Json>

export interface BindingNamespace {
  global: string
  functions: Record<string, BindingFunction>
}

export interface PtcRunResult {
  value?: Json
  logs: string[]
  error?: { kind: string; message: string }
}

export interface PtcRuntimeLike {
  readonly programFormat?: 'function-body' | 'repl'
  resolve(request: {
    program: string
    bindings: BindingNamespace[]
    cwd?: string
    signal?: AbortSignal
    sandboxPolicy?: unknown
  }): unknown
  run(spec: unknown): Promise<PtcRunResult>
}

export interface NestedToolResult {
  isError: boolean
  value?: Json
  error?: { message?: string }
}

/**
 * DSH 0.2.2 `tools.execute()` takes a batch (`calls`), not one call, and settles
 * every call into `results`; both the native and the PTC executor share it.
 */
export interface NestedToolCall {
  id: string
  name: string
  /** Raw JSON text, exactly like a model tool call carries it. */
  arguments: string
}

export interface NestedToolBatch {
  results: readonly { callId: string; result: NestedToolResult }[]
  additionalContexts?: readonly unknown[]
  concluded?: boolean
}

export interface CodemodeCall {
  name: string
  detail: string
  status: 'ok' | 'error'
  ms: number
  error?: string
}

export interface CodemodeValue {
  text: string
  ok: boolean
  seconds: number
  calls: CodemodeCall[]
}

export interface ToolSchemaLike {
  name: string
}

export interface RegistryLike {
  schemas(agent?: unknown): readonly ToolSchemaLike[]
  execute(request: {
    calls: readonly NestedToolCall[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<NestedToolBatch>
}

export interface SandboxPolicyLike {
  resolve(request: { session: unknown }): unknown
}

/** Names a script can never bind: a codemode calling itself is not a tool. */
export const SELF_NAMES: ReadonlySet<string> = new Set(['codemode', 'ceulen_codemode', 'run_code'])
