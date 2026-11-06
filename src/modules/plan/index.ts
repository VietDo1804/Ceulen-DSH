/**
 * plan — persistence and approval handoff over DSH's native plan mode.
 *
 * DSH owns `/plan`, the plan guidance section, and the `exit_plan_mode`
 * review card; this module adds the two ceulen pieces the harness lacks:
 *
 *   - Plans on disk: the markdown submitted through `exit_plan_mode` is
 *     written to `<cwd>/.dsh/plans/<timestamp>-<slug>.md` the moment the
 *     call lands — while the review card is still on screen — and re-checked
 *     at turn end (same-title refinement overwrites the same file).
 *   - `/plan-approve [current|new|stay]`: ceulen's 3-option approval — implement
 *     here, clear context and implement (a fresh session when the client
 *     honours the question's intent, native `compactNow` + execute otherwise),
 *     or keep planning — over the native userQuestions service.
 *   - Per-phase routes: `plan.model` answers requests while plan mode is
 *     active, `plan.implement` answers them once a plan was submitted (the
 *     approved plan, or a fresh session seeded with the execution handoff).
 *
 * The transcript is scanned on the `tool/call` session event (earliest
 * moment the draft exists) and again at turn boundaries: DSH exposes no
 * per-tool-call plugin event with the agent attached.
 */
import { dirname, join, relative } from 'node:path'
import type { AgentLike, MessageLike, PluginContext, SessionLike, UserMessageLike } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, type CeulenSettings, type ReasoningEffort } from '../../core/settings.js'
import { ensureDir, writeAtomic } from '../../core/fsx.js'
import { parseRoute } from '../../core/llm.js'
import { registerCommandSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-plan'
export const inject = ['commands']

export const PLANS_DIR = '.dsh/plans'
const EXIT_PLAN_TOOL = 'exit_plan_mode'

export const CURRENT_OPTION = 'Implement in current session'
export const NEW_SESSION_OPTION = 'Clear context and implement in new session'
export const STAY_OPTION = 'Continue planning'

/** The no-plan-mode prompt every approved execution starts with. */
const HANDOFF_MARK = 'Execute the approved plan at '

export interface DraftPlan {
  readonly plan: string
  readonly title: string
}

interface SavedPlan {
  readonly path: string
  readonly title: string
  readonly content: string
}

/** The newest `exit_plan_mode` call wins; its `plan` argument is the markdown.
 * The paired tool result is not inspected — a call that failed outside plan
 * mode still carries the draft, and saving it is harmless (last write wins). */
export function latestPlan(messages: readonly MessageLike[]): DraftPlan | undefined {
  let found: DraftPlan | undefined
  for (const message of messages) {
    for (const block of message.content) {
      const record = block as { type?: string; name?: string; arguments?: unknown }
      if (record.type !== 'tool-call' || typeof record.name !== 'string') continue
      const bare = record.name.startsWith('ceulen_') ? record.name.slice('ceulen_'.length) : record.name
      if (bare !== EXIT_PLAN_TOOL) continue
      const plan = readPlanArgument(record.arguments)
      if (plan !== undefined) found = plan
    }
  }
  return found
}

function readPlanArgument(raw: unknown): DraftPlan | undefined {
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  const plan = (args as { plan?: unknown } | null | undefined)?.plan
  if (typeof plan !== 'string' || plan.trim().length === 0) return undefined
  const title = plan.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan'
  return { plan: plan.endsWith('\n') ? plan : `${plan}\n`, title }
}

/** Ceulen's slug: lowercase, non-alphanumerics collapsed, trimmed to 60. */
export function planSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan'
}

export function planFileName(title: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${planSlug(title)}.md`
}

/** Same title → refine the existing file; new title → a fresh timestamped one. */
export function planPathFor(cwd: string, title: string, previous?: SavedPlan): string {
  if (previous !== undefined && previous.title === title) return previous.path
  return join(cwd, PLANS_DIR, planFileName(title))
}

/** Port of ceulen's buildExecutionPrompt. */
export function executionPrompt(relativePlan: string, mode: 'current' | 'new'): string {
  const prefix = mode === 'new' ? 'This is a fresh session created from an approved plan. ' : ''
  return `${prefix}Execute the approved plan at ${relativePlan}. Read the plan file if needed, keep the implementation scoped to the plan, update it if reality differs materially, and run the verification described there.`
}

interface PhaseRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffort
}

interface AgentHooks {
  on(event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

type AgentWithCtx = AgentLike & { ctx?: AgentHooks }

/** A configured phase route: `provider/model[:effort]`, or undefined for inherit. */
export function phaseRoute(selector: string): PhaseRoute | undefined {
  const parsed = parseRoute(selector)
  if (parsed === undefined) return undefined
  return {
    provider: parsed.provider,
    model: parsed.model,
    ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }),
  }
}

function routeKey(route: { readonly provider?: unknown; readonly model?: unknown } | undefined): string {
  const provider = typeof route?.provider === 'string' ? route.provider : ''
  const model = typeof route?.model === 'string' ? route.model : ''
  return provider === '' && model === '' ? '' : `${provider}/${model}`
}

/** Whether this session holds a submitted plan — an `exit_plan_mode` draft or
 * the execution handoff a fresh approved session starts with. */
export function hasApprovedPlan(session: SessionLike | undefined): boolean {
  const messages = session?.deriveMessages?.() ?? []
  if (latestPlan(messages) !== undefined) return true
  return messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes(HANDOFF_MARK)))
}

function planActive(ctx: PluginContext, agent: AgentLike): boolean {
  try {
    const service = ctx.get('planMode', false) as { get?(target: unknown): { active?: boolean } | undefined } | undefined
    return service?.get?.(agent)?.active === true
  } catch {
    // No plan-mode service composed (web/headless): stay on the client route.
    return false
  }
}

/**
 * Override the request route by phase, as the outermost `agent/request`
 * listener (prepend: cordis runs the first-registered listener outermost, so
 * this wins over the host's own selection wrapper).
 * A client model switch during a phase stands the override down until the
 * phase flips, so `/model` is never silently undone by a stale config.
 */
function installPhaseRoutes(ctx: PluginContext, agent: AgentWithCtx, hooks: AgentHooks): void {
  let baseline: string | undefined
  let suppressed: 'plan' | 'implement' | undefined

  hooks.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
    const resolved = await next()
    // Read per request (a ~2 KB sync read) so a /ceulen-config edit applies to
    // the running session instead of the next one.
    const settings: CeulenSettings = loadSettingsSync()
    // None of the feature's config: keep the host result byte-identical and
    // skip the transcript scan entirely.
    if (settings.plan.model === '' && settings.plan.implement === '') return resolved
    const active = planActive(ctx, agent)
    const phase = active ? 'plan' : hasApprovedPlan(agent.session) ? 'implement' : undefined
    const target = phase === 'plan'
      ? phaseRoute(settings.plan.model)
      : phase === 'implement'
        ? phaseRoute(settings.plan.implement)
        : undefined
    const key = routeKey(resolved)
    if (phase === undefined || target === undefined) {
      baseline = key
      return resolved
    }
    // The client resolved a different route than last request: a human model
    // switch, not a stale config — stand down until the phase changes.
    if (suppressed !== phase && baseline !== undefined && key !== baseline && key !== routeKey(target)) suppressed = phase
    baseline = key
    if (suppressed === phase) return resolved
    const { reasoningEffort: _inherited, ...rest } = resolved
    return {
      ...rest,
      provider: target.provider,
      model: target.model,
      ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
    }
  }, { prepend: true })
}

function deliver(agent: AgentLike, text: string): void {
  const message: UserMessageLike = {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'ceulen-plan', form: 'execution' },
  }
  try {
    agent.followup(message)
  } catch {
    agent.followup({ ...message, source: { kind: 'user' } })
  }
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('plan', loadSettingsSync())) return

  let saved: SavedPlan | undefined

  const toast = (text: string): void => {
    try {
      const service = ctx.get('tuiToast', false) as { show?(text: string): unknown } | undefined
      service?.show?.(text)
    } catch {
      // Optional surface.
    }
  }

  /** Write the newest transcript plan to disk (no-op without one). Returns the
   * current saved state either way, so `/plan-approve` also works after a
   * process restart re-lost the in-memory copy. */
  const persist = async (session: SessionLike | undefined): Promise<SavedPlan | undefined> => {
    const draft = latestPlan(session?.deriveMessages?.() ?? [])
    if (draft !== undefined && draft.plan !== saved?.content) {
      const cwd = session?.header?.cwd ?? process.cwd()
      const path = planPathFor(cwd, draft.title, saved)
      try {
        await ensureDir(dirname(path), 0o755)
        await writeAtomic(path, draft.plan, 0o644)
        saved = { path, title: draft.title, content: draft.plan }
        toast(`Plan saved: ${relative(cwd, path) || path} — /plan-approve to execute`)
      } catch (error) {
        logLine('plan', `failed to save plan: ${String(error)}`)
      }
    }
    return saved
  }

  // Earliest save: the tool call landing means the draft exists and the
  // review card is about to show — the file must already be there to open.
  ctx.on('session/event', (session: SessionLike | undefined, event: { type?: string; data?: { name?: string } } | undefined) => {
    if (event?.type !== 'tool/call') return
    const name = event.data?.name ?? ''
    const bare = name.startsWith('ceulen_') ? name.slice('ceulen_'.length) : name
    if (bare !== EXIT_PLAN_TOOL) return
    if (session !== undefined) void persist(session)
  })

  // Belt and braces: also settle at turn end (covers a missed live event,
  // e.g. a plugin reload mid-turn).
  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string }) => {
    if (payload?.status === 'idle' && payload.agent !== undefined) void persist(payload.agent.session)
  })

  // Phase routes apply to top-level sessions only: a subagent inherits the
  // decision its parent is already running under.
  ctx.on('agent/created', (payload: { agent?: AgentWithCtx }) => {
    const agent = payload?.agent
    if (agent === undefined || agent.session?.header?.parentSession !== undefined) return
    const hooks = agent.ctx
    if (hooks === undefined || typeof hooks.on !== 'function') return
    installPhaseRoutes(ctx, agent, hooks)
  })

  registerCommandSafe(ctx, {
    name: 'plan-approve',
    description: 'Approve the saved plan: execute here, clear context and execute, or keep planning',
    input: { hint: 'current|new|stay' },
    async handler({ agent, rawInput, signal }) {
      if (agent === undefined) return { kind: 'error', text: 'plan-approve needs a session context' }

      // Ensure the file exists before promising its path (restart re-save).
      await persist(agent.session)
      const draft: DraftPlan | undefined = saved !== undefined
        ? { plan: saved.content, title: saved.title }
        : latestPlan(agent.session?.deriveMessages?.() ?? [])
      if (draft === undefined) {
        return { kind: 'error', text: 'No plan found yet — the agent must call exit_plan_mode before /plan-approve.' }
      }
      const cwd = agent.session?.header?.cwd ?? process.cwd()
      const relativePlan = saved !== undefined ? relative(cwd, saved.path) || saved.path : `<${PLANS_DIR}>`

      let mode = rawInput.trim().toLowerCase()
      if (mode === '') {
        const questions = ctx.get('userQuestions', false) as {
          ask?(request: unknown): Promise<{ answers?: { selected?: string[] }[] }>
        } | undefined
        if (typeof questions?.ask !== 'function') {
          return { kind: 'error', text: 'Usage: /plan-approve current|new|stay' }
        }
        try {
          const answer = await questions.ask({
            questions: [{
              id: 'approve',
              header: 'Plan approval',
              question: `Execute "${draft.title}"?`,
              detail: `Plan: ${relativePlan}`,
              options: [
                { label: CURRENT_OPTION, description: 'Execute in this session with the current context.' },
                { label: NEW_SESSION_OPTION, description: `Start a fresh session and execute from the plan at ${relativePlan}.` },
                { label: STAY_OPTION, description: 'Keep planning; refine the plan and it re-saves.' },
              ],
              // A TUI that understands this intent starts the fresh session and
              // seeds it with the execution prompt; every other surface still
              // gets the 3-option answer and the compaction fallback below.
              // `approve` is required by the user-questions protocol for ANY
              // intent (it is checked, not the tag): name the option it means.
              intent: {
                kind: 'plan-approve',
                approve: CURRENT_OPTION,
                fresh: NEW_SESSION_OPTION,
                stay: STAY_OPTION,
                prompt: executionPrompt(relativePlan, 'new'),
              },
            }],
            agent,
            signal,
          })
          const label = answer?.answers?.[0]?.selected?.[0]
          mode = label === CURRENT_OPTION ? 'current' : label === NEW_SESSION_OPTION ? 'new' : label === STAY_OPTION ? 'stay' : ''
        } catch {
          mode = ''
        }
      }
      if (mode === 'stay') return { kind: 'success', text: 'Continuing in plan mode.' }
      if (mode !== 'current' && mode !== 'new') {
        return { kind: 'error', text: 'Usage: /plan-approve current|new|stay' }
      }

      // Leaving plan mode is shared by both execution paths; failures here are
      // non-fatal (`/plan off` remains the manual escape).
      try {
        const planMode = ctx.get('planMode', false) as { set?(agent: unknown, active: boolean): unknown } | undefined
        planMode?.set?.(agent, false)
      } catch {
        // Optional surface.
      }

      if (mode === 'current') {
        deliver(agent, executionPrompt(relativePlan, 'current'))
        return { kind: 'success', text: `Approved — executing in this session (plan: ${relativePlan}).` }
      }
      // 'new' without a client that starts the fresh session (web, plain REPL):
      // compact the history through the native manual-compaction seam, then
      // execute from the plan in this session.
      const compaction = ctx.get('compaction', false) as {
        compactNow?(agent: unknown, signal: AbortSignal): Promise<unknown>
      } | undefined
      if (typeof compaction?.compactNow === 'function') {
        try {
          // The command contract makes signal optional; compactNow requires one.
          await compaction.compactNow(agent, signal ?? new AbortController().signal)
          deliver(agent, executionPrompt(relativePlan, 'new'))
          return { kind: 'success', text: `Approved — context compacted, executing from the plan (${relativePlan}).` }
        } catch (error) {
          logLine('plan', `manual compaction failed: ${String(error)}`)
          // Fall through to the handoff text below.
        }
      }
      // ponytail: fallback when no compaction backend is composed (or it
      // failed) — the plan file is the cross-session handoff artifact.
      return {
        kind: 'success',
        text: `Approved — plan saved at ${relativePlan}. Start a fresh session and open with:\n  ${executionPrompt(relativePlan, 'new')}`,
      }
    },
  })

  logLine('plan', `loaded (plans in ${PLANS_DIR}/ + /plan-approve)`)
}
