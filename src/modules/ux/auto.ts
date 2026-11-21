/**
 * `/ux auto`: pick the UX guidance level per user request.
 *
 * Strict guidance on a logic task costs minutes of unrequested redesign
 * (DESIGN.md, theme files, repeated audits); no guidance on a new page costs
 * the look. So each real user message is classified once (off, keep, lite,
 * strict) through the classifier route, which is Jev on System One when
 * configured.
 *
 * Timing: the message is classified when it lands in the inbox, before its
 * turn starts. The `system-prompt/assemble` waterfall then waits for that
 * answer, so the first request of the turn already carries the level.
 *
 * Delivery: a runtime-context entry, not the system prompt. DSH re-sends a
 * changed system prompt in full as a new system message, but projects a
 * runtime context only when its text changes, as a short snapshot next to the
 * conversation. The prompt cache keeps its prefix either way.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { askClassifier, type Question } from '../classifier/index.js'

export const AUTO_LEVELS = ['off', 'keep', 'lite', 'strict'] as const
export type AutoLevel = (typeof AUTO_LEVELS)[number]

export const UX_LEVEL_CONTEXT = 'ceulen:ux-level'
const CLASSIFY_TIMEOUT_MS = 8_000
/** Below this the previous level stands (or `keep` on a first message). */
export const MIN_CONFIDENCE = 0.6

/** Explicit, so it retracts a keep/lite/strict line an earlier turn left in history. */
export const OFF_TEXT = 'UX level: off — this request has no UI work. Skip DESIGN.md, the motion kit, and ux_audit unless the task asks for them.'

export const KEEP_TEXT = `UX MODE ACTIVE — level: keep. This task changes UI inside an existing design. Match what is there: reuse its classes, tokens, and components; add no new colours, fonts, theme files, or layout system. Every control you touch gets its hover, focus-visible, disabled, loading, empty, and error states. Do not write DESIGN.md, copy the motion kit, or restyle pages the task did not name. Check the changed flow once in the browser; run ux_audit only when you added or restyled CSS.`

export const LEVEL_QUESTION: Question = {
  id: 'ux',
  type: 'choice',
  instructions: 'Which UX guidance level does this coding request need? off = no visual UI work (logic, backend, API, tests, docs, CLI, refactor) even when the repo has UI. keep = fix or extend UI inside the existing design (a UI bug fix, a new page or component in the current style), no redesign. lite = new modest UI where no strong design exists yet. strict = new product UI, landing page, redesign, new visual identity, or an explicit request to make it more beautiful or animated. A short follow-up (ok, continue, tiếp tục, fix that) keeps previousLevel.',
  criteria: {
    off: 'no visual UI work',
    keep: 'change UI within the existing design',
    lite: 'new modest UI',
    strict: 'new or redesigned UI, or explicit visual polish',
  },
}

export interface LevelDecision {
  level: AutoLevel
  confidence: number | null
  /** Why this level: the classifier's pick, or the fallback that replaced it. */
  via: 'classifier' | 'low-confidence' | 'unavailable'
}

const UI_EXTENSIONS = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'vendor', 'target'])
const uiCache = new Map<string, { at: number; value: boolean }>()

/** Whether the project has UI source files, three levels deep, cached for a minute. */
export function repoHasUiFiles(cwd: string): boolean {
  const cached = uiCache.get(cwd)
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.value
  let seen = 0
  const walk = (dir: string, depth: number): boolean => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (++seen > 3_000) return false
      if (entry.isFile() && UI_EXTENSIONS.test(entry.name)) return true
    }
    if (depth >= 3) return false
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.') && walk(join(dir, entry.name), depth + 1)) return true
    }
    return false
  }
  const value = walk(cwd, 0)
  uiCache.set(cwd, { at: Date.now(), value })
  return value
}

/** Text of real user messages in an inbox splice; nudges, relays and notices carry another source kind. */
export function userTextOf(data: unknown): string | undefined {
  const splice = data as { target?: string; inserted?: Array<{ role?: string; source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }> } | undefined
  if (splice?.target !== 'next-turn' || !Array.isArray(splice.inserted)) return undefined
  // The last text block is the request: a subagent brief opens with its role preamble.
  let text = ''
  for (const message of splice.inserted) {
    if (message.role !== 'user' || message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) text = block.text.trim()
  }
  return text.length === 0 ? undefined : text
}

/** Turn a classifier answer into a level, falling back to the previous one. */
export function decide(answer: unknown, previous: AutoLevel | undefined): LevelDecision {
  const record = answer as { option?: unknown; confidence?: unknown } | undefined
  const option = record?.option
  const confidence = typeof record?.confidence === 'number' ? record.confidence : null
  if (typeof option !== 'string' || !(AUTO_LEVELS as readonly string[]).includes(option)) {
    return { level: previous ?? 'keep', confidence, via: 'unavailable' }
  }
  if (confidence !== null && confidence < MIN_CONFIDENCE) return { level: previous ?? 'keep', confidence, via: 'low-confidence' }
  return { level: option as AutoLevel, confidence, via: 'classifier' }
}

interface SessionState {
  agent?: AgentLike
  decision?: LevelDecision
  pending?: Promise<void>
}

/**
 * Per-session levels. `text` maps a level to its guidance; `active` says
 * whether auto mode is on right now (the user can switch with /ux).
 */
export class AutoLevels {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly ctx: PluginContext,
    private readonly text: (level: AutoLevel) => string,
    private readonly active: () => boolean,
  ) {}

  private state(id: string): SessionState {
    let state = this.sessions.get(id)
    if (state === undefined) {
      state = {}
      this.sessions.set(id, state)
    }
    return state
  }

  track(agent: AgentLike): void {
    this.state(String(agent.session.id)).agent = agent
  }

  forget(id: string): void {
    this.sessions.delete(id)
  }

  decision(id: string): LevelDecision | undefined {
    return this.sessions.get(id)?.decision
  }

  /** The guidance for this session's current level; empty until a message is classified. */
  textFor(agent: AgentLike | undefined): string {
    if (!this.active() || agent === undefined) return ''
    const decision = this.decision(String(agent.session.id))
    return decision === undefined ? '' : this.text(decision.level)
  }

  /** Start classifying a user message for session `id`; the next assemble waits for it. */
  classify(id: string, request: string, cwd: (agent: AgentLike | undefined) => string): void {
    if (!this.active()) return
    const state = this.state(id)
    const previous = state.decision?.level
    const run = async (): Promise<void> => {
      let answer: unknown
      try {
        const answers = await askClassifier(
          this.ctx,
          state.agent,
          { request: request.length > 3_000 ? `…${request.slice(-3_000)}` : request, repoHasUiFiles: repoHasUiFiles(cwd(state.agent)), previousLevel: previous ?? null },
          [LEVEL_QUESTION],
          Date.now() + CLASSIFY_TIMEOUT_MS,
        )
        answer = answers.ux
      } catch (error) {
        logLine('ux', `auto ${id}: classifier unavailable (${errorMessage(error)})`)
      }
      state.decision = decide(answer, previous)
      const { level, confidence, via } = state.decision
      logLine('ux', `auto ${id} → ${level}${confidence === null ? '' : ` (${confidence.toFixed(2)})`} via ${via}`)
    }
    const pending = run().finally(() => {
      if (state.pending === pending) state.pending = undefined
    })
    state.pending = pending
  }

  /** Wait for an in-flight classification of this session, if any. */
  async settle(id: string): Promise<void> {
    await this.sessions.get(id)?.pending
  }
}
