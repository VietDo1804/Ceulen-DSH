/**
 * Pi's `codemode`, ported onto the DSH PTC runtime.
 *
 * The model writes one JavaScript program; every visible tool is bound as
 * `tools.<name>(args)` and the program's return value plus console output are
 * the only things that reach the model. Execution, isolation, the deadline and
 * the output cap belong to `ctx.ptcRuntime` (dsh-ptc-runtime-node), so this
 * module owns only the tool surface, the bindings and the result text.
 *
 * Nested calls go through `ctx.tools.execute()`, not a ToolDefinition, so
 * pre-execute policy, guards, approvals and output validation still run.
 *
 * The split: types.ts (transport shapes), script.ts (options line, budget,
 * error trimming), bindings.ts (`codemode.exit`, `state.*`), render.ts (the
 * receipt/card text). This file is the registration and the execute pipeline.
 */

import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { ceulenTool, errorMessage, objectSchema, text } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { exitBindings, stateBindings } from './bindings.js'
import { clipOneLine, formatCalls, renderResult, scriptTail, STATUS_LINE, toolBindings } from './render.js'
import { DEFAULT_OUTPUT_BUDGET, EXIT_SENTINEL, parseOptionsLine, suggestBinding, trimScriptError } from './script.js'
import type {
  CodemodeCall,
  CodemodeValue,
  Json,
  PtcRuntimeLike,
  RegistryLike,
  SandboxPolicyLike,
} from './types.js'

export const name = 'ceulen-codemode'
export const inject = ['tools']

const DESCRIPTION = [
  "Run one JavaScript program that calls this session's tools.",
  '',
  '`code` is the body of an async function: top-level `await` and `return` work. `tools.<name>(args)` calls any tool the session can call and resolves to its structured value (for example `bash` → an object whose `stdout` holds the output text); arguments follow that tool\'s declared schema (DSH\'s `bash` also requires `description`). Tool names are exact; use `tools[\'name\']` when the name is not a JavaScript identifier. A failed, blocked or denied call rejects with the tool\'s error text — use `Promise.allSettled()` to keep the calls that succeed, and when a call fails on its arguments retry the fallback shape inside `try { … } catch { … }` so the wrong variant costs no extra model round trip.',
  '',
  'Images do not pass through this return value: a capture tool (`web_screenshot`, `web_interact`, `ux_audit`, `read_image`) called inside the program returns no image to you. Call those tools directly when you need to see the result.',
  '',
  '`await state.store({ key, value })` / `await state.load({ key })` keep small JSON values across codemode calls in this session (≤256k chars per value, ≤1M total); both are async, and writes persist only when the script succeeds. The first line may be `// @options: {"timeout_ms": 60000, "max_output_chars": 4000}` (deadline up to 600s; default 120s).',
  '',
  '`await codemode.exit(null)` ends the script successfully from a nested helper (store writes made before it still commit); always `await` it so it unwinds at the call site. A failed script\'s error is trimmed to the message plus its own `<anonymous>:line:column` frame; Node/PTC stack internals are dropped.',
  '',
  '`console.log(...)` lines come back in a `<console_output>` block after the script output. Only the `return` value and console lines reach the model, so run independent calls in parallel and distill the return: pick fields and slice long strings (~1KB per key) instead of returning or `JSON.stringify`-ing whole results. A return plus console block past ~6k characters is middle-truncated and the full text spills to a file path named in the result. Calls already made are not undone when a script fails; calls still running when the script ends are cancelled. A script cannot start another codemode or run_code program.',
  '',
  'Prefer a direct tool call for one operation; use codemode for fan-out, filtering, or a deterministic loop over tool results.',
].join('\n')

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    ok: { type: 'boolean' },
    seconds: { type: 'number' },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          detail: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'error'] },
          ms: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['name', 'detail', 'status', 'ms'],
      },
    },
  },
  required: ['text', 'ok', 'seconds', 'calls'],
}

function runtimeOf(ctx: PluginContext): PtcRuntimeLike | undefined {
  try {
    return ctx.get('ptcRuntime', false) as PtcRuntimeLike | undefined
  } catch {
    return undefined
  }
}

function registryOf(ctx: PluginContext): RegistryLike | undefined {
  try {
    return ctx.get('tools', false) as RegistryLike | undefined
  } catch {
    return undefined
  }
}

/** Resolve the calling session's file policy; omit it to keep the runtime default. */
function sandboxPolicyOf(ctx: PluginContext, session: unknown): unknown {
  try {
    const service = ctx.get('sandboxPolicy', false) as SandboxPolicyLike | undefined
    if (service === undefined || typeof service.resolve !== 'function') return undefined
    return service.resolve({ session })
  } catch {
    return undefined
  }
}

function codemodeTool(ctx: PluginContext) {
  return ceulenTool({
    name: 'codemode',
    description: DESCRIPTION,
    parameters: objectSchema({
      code: { type: 'string', description: 'The JavaScript program: the body of an async function.' },
    }, ['code']),
    outputSchema: OUTPUT_SCHEMA,
    render: (_args, value) => text((value as CodemodeValue).text),
    presentationMeta: (_args, value) => {
      const output = value as CodemodeValue
      return { calls: output.calls, ok: output.ok }
    },
    // The bare title is the point: `Codemode` plus the host's duration chip is
    // the whole header, the way Pi's block reads. `path` is how the host picks
    // the highlighter for a generic card's body.
    presentCall: raw => {
      const args = raw as { code?: unknown }
      const code = typeof args.code === 'string' ? args.code.replace(/\r/g, '').trimEnd() : ''
      return {
        card: 'generic',
        title: '',
        category: 'exec',
        // ponytail: an undocumented structural key; a TUI that ever validates
        // card shapes renders the script plain instead of highlighted.
        path: 'codemode.js',
        content: code.length === 0 ? [] : [{ type: 'text', text: code }],
      }
    },
    presentResult: (raw, result) => {
      const args = raw as { code?: unknown }
      const meta = result.meta as { calls?: unknown; ok?: unknown } | undefined
      if (meta === null || typeof meta !== 'object') return undefined
      const calls = Array.isArray(meta.calls) ? (meta.calls as CodemodeCall[]) : []
      const ok = meta.ok !== false
      const body = result.content.map(block => block.type === 'text' ? block.text : '').join('\n').trim()
      // A generic card has no exit pill, so a failed script keeps its status
      // line; a completed one drops it — the header already shows the time.
      const status = ok ? '' : (STATUS_LINE.exec(body)?.[0]?.trim() ?? '')
      const code = typeof args.code === 'string' ? args.code.replace(/\r/g, '').trimEnd() : ''
      const parts = [
        status,
        calls.length === 0 ? '' : formatCalls(calls),
        body.replace(STATUS_LINE, '').trim(),
        code.length === 0 ? '' : scriptTail(code),
      ]
      return {
        card: 'generic',
        title: '',
        category: 'exec',
        content: [{ type: 'text', text: parts.filter(part => part.length > 0).join('\n\n') }],
      }
    },
    concurrencySafe: false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { code?: unknown }
      const code = typeof args.code === 'string' ? args.code : ''
      if (code.trim().length === 0) throw new Error('code must be a non-empty JavaScript program')
      const options = parseOptionsLine(code)
      // Re-checked per call so turning the toggle off stops new scripts even
      // before the next restart removes the schema.
      if (!loadSettingsSync().codemode.enabled) {
        throw new Error('codemode is disabled in Ceulen settings; enable it in /ceulen-config and restart DSH')
      }
      const runtime = runtimeOf(ctx)
      if (runtime === undefined) {
        throw new Error('codemode needs the DSH PTC runtime; mount the ptc-runtime row (dsh-ptc-runtime-node)')
      }
      if (runtime.programFormat === 'repl') {
        throw new Error('codemode needs the function-body PTC runtime (executionMode: per-call); the persistent REPL runtime does not support top-level return')
      }
      const registry = registryOf(ctx)
      if (registry === undefined) throw new Error('the DSH tool registry is not mounted')

      const calls: CodemodeCall[] = []
      const session = exec.agent?.session
      const functions = toolBindings(registry, exec, calls)
      const pending = new Map<string, Json>()
      let spec: unknown
      try {
        spec = runtime.resolve({
          program: code,
          bindings: [
            { global: 'tools', functions },
            stateBindings(session, { pending }),
            exitBindings(),
          ],
          cwd: session?.header?.cwd ?? process.cwd(),
          signal: exec.signal,
          sandboxPolicy: session === undefined ? undefined : sandboxPolicyOf(ctx, session),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
      } catch (error) {
        throw new Error(`codemode could not start: ${errorMessage(error)}`)
      }

      const startedAt = Date.now()
      const result = await runtime.run(spec)
      const seconds = (Date.now() - startedAt) / 1000
      // Pi's exit(): a sentinel unwind is a successful end, not a failure.
      if (result.error !== undefined && result.error.kind === 'exception'
        && (result.error.message.split('\n')[0] ?? '').includes(EXIT_SENTINEL)) {
        result.error = undefined
      }
      // Pi's one-frame receipt: drop the PTC/Node internals, keep the script's frame.
      if (result.error !== undefined) {
        result.error = { ...result.error, message: trimScriptError(result.error.message) }
      }
      // Errors that teach recovery: name the close binding for a typo'd call.
      if (result.error !== undefined && result.error.kind === 'exception') {
        const suggestion = suggestBinding(result.error.message, Object.keys(functions))
        if (suggestion !== undefined) {
          result.error = { ...result.error, message: `${result.error.message} — did you mean 'tools.${suggestion}'?` }
        }
      }
      // Pi semantics: store writes commit only when the script succeeded.
      if (result.error === undefined && pending.size > 0) {
        try {
          session?.append?.('codemode-store', { store: Object.fromEntries(pending) })
        } catch (error) {
          logLine('codemode', `store commit failed: ${errorMessage(error)}`)
        }
      }
      const label = code.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? 'script'
      logLine('codemode', `${clipOneLine(label, 100)} -> ${result.error === undefined ? 'ok' : result.error.kind}`)
      const rendered = renderResult(result, seconds, options.maxOutputChars ?? DEFAULT_OUTPUT_BUDGET)
      const value: CodemodeValue = {
        text: rendered.text,
        ok: result.error === undefined,
        seconds,
        calls: calls.map(call => ({ ...call })),
      }
      return value
    },
  })
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('codemode', settings) || !settings.codemode.enabled) return
  if (ctx.tools.get?.('codemode') !== undefined) {
    logLine('codemode', 'a tool named codemode already exists; not registering')
    return
  }
  // Register immediately; `ctx.ptcRuntime` is resolved per call. A load-time
  // lookup races the ptc-runtime row (the headless boot saw it unset here even
  // though the row was composed), and the execute-time error is just as clear.
  ctx.effect(() => ctx.tools.register(codemodeTool(ctx)), 'ceulen codemode tool')
}
