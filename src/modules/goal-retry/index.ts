/**
 * goal-retry — keep a same-session goal working across involuntary stops.
 *
 * DSH's own goal-round driver stops for good when a turn dies outside the
 * model's control: it disarms the goal on `agent/error` and pauses a cancelled
 * goal round (Esc) once the agent goes idle. This module adds the missing
 * recovery on top of the public services — it never edits the harness:
 *
 *   - the same active goal is re-armed after 5/10/20/40/60 s, at most 5 times
 *     per consecutive failure streak (one timer per agent, so `agent/error`
 *     and `turn/end` for one turn count as one failure);
 *   - re-arming calls `goals.resume()`, whose `goal/changed` event the native
 *     driver already turns into the next round — no prompt is injected here;
 *   - a completed turn resets the streak and cancels the pending retry;
 *     `/goal pause|edit|complete|block|clear` cancels it and is never undone;
 *   - Esc is recovered: the harness pauses the goal milliseconds after the
 *     cancelled turn, so a pause inside that window is treated as its own;
 *   - after 5 recoveries the active goal is blocked with
 *     `recovery-exhausted` (resumable), never completed; `max-tokens`,
 *     `disposed` and an exhausted round budget still stop the goal.
 *
 * The harness timer is not touched: without this module the behaviour above is
 * exactly what `@deepseek-ai/dsh-goal-round-driver` does on its own.
 */
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { logLine } from '../../core/log.js'
import { errorMessage } from '../../core/tools.js'

export const name = 'ceulen-goal-retry'

/** Consecutive automatic recoveries allowed after one involuntary stop. */
export const MAX_RETRIES = 5
/** Backoff before recovery attempt 1..5, in milliseconds. */
export const DELAYS_MS = [5000, 10000, 20000, 40000, 60000] as const
/**
 * The harness pauses a goal this soon after the turn it cancelled; anything
 * later is a human `/goal pause` and must stay stopped.
 */
export const ESC_PAUSE_WINDOW_MS = 2000
/** An explicit stop this soon before a cancelled turn explains that turn. */
export const EXPLICIT_STOP_WINDOW_MS = 2000

/** Structural view of the DSH `goals` service (see core/types.ts). */
export interface GoalView {
  readonly id: string
  readonly revision: number
  readonly phase: string
  readonly activation?: string
}

export interface GoalRefView {
  readonly id: string
  readonly revision: number
}

export interface GoalService {
  get(agent: object): GoalView | undefined
  resume(agent: object, ref: GoalRefView): GoalView
  block(agent: object, ref: GoalRefView, reason: { code: string; message: string }): GoalView
}

export interface AgentsService {
  get?(id: string): object | undefined
}

interface RetryState {
  timer?: ReturnType<typeof setTimeout>
  /** Recoveries already spent in the current failure streak. */
  count: number
  /** When the last turn was cancelled, for the harness's own Esc pause. */
  abortedAt?: number
  /** When the human last stopped the goal on purpose. */
  stoppedAt?: number
  /** Set while this module re-arms the goal, so its own resume keeps the streak. */
  selfResume?: boolean
}

/** Durable goal mutations that mean "stay stopped". */
const STOP_OPERATIONS = new Set(['create', 'edit', 'pause', 'complete', 'block', 'clear'])

/** Keep a goal at rest: drop the timer without deciding anything else. */
function cancelTimer(state: RetryState): void {
  if (state.timer === undefined) return
  clearTimeout(state.timer)
  state.timer = undefined
}

/** Install automatic goal recovery over the harness events. */
export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('goal-retry', loadSettingsSync())) return

  const states = new Map<object, RetryState>()
  const goals = (): GoalService | undefined => ctx.get('goals', false) as GoalService | undefined
  const agents = (): AgentsService | undefined => ctx.get('agents', false) as AgentsService | undefined
  const stateOf = (agent: object): RetryState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: RetryState = { count: 0 }
    states.set(agent, state)
    return state
  }

  /** True when a human stopped this goal so recently that a stop is theirs. */
  const stoppedByHuman = (state: RetryState, now: number): boolean => {
    if (state.stoppedAt === undefined) return false
    if (now - state.stoppedAt > EXPLICIT_STOP_WINDOW_MS) return false
    state.stoppedAt = undefined
    return true
  }

  const blockExhausted = (agent: object, goal: GoalView): void => {
    const service = goals()
    if (service === undefined || goal.phase !== 'active') {
      // A paused goal is already stopped and cannot block; `/goal resume` stays
      // available, so report instead of forcing a phase transition.
      logLine('goal-retry', `stopped after ${MAX_RETRIES} recovery attempts (goal ${goal.phase})`)
      return
    }
    try {
      service.block(agent, { id: goal.id, revision: goal.revision }, {
        code: 'recovery-exhausted',
        message: `Goal stopped after ${MAX_RETRIES} automatic recovery attempts. Resume it with /goal resume once the provider is healthy.`,
      })
    } catch (error) {
      logLine('goal-retry', `could not record recovery exhaustion: ${errorMessage(error)}`)
    }
  }

  const retry = (agent: object): void => {
    const state = stateOf(agent)
    state.timer = undefined
    const service = goals()
    const goal = service?.get(agent)
    if (goal === undefined || (goal.phase !== 'active' && goal.phase !== 'paused')) {
      state.count = 0
      return
    }
    state.count += 1
    try {
      // resume() is the whole handoff: the driver's goal/changed listener
      // starts the next round in the same session.
      if (goal.phase === 'paused' || goal.activation !== 'armed') {
        state.selfResume = true
        try {
          service?.resume(agent, { id: goal.id, revision: goal.revision })
        } finally {
          state.selfResume = false
        }
      }
    } catch (error) {
      logLine('goal-retry', `recovery ${state.count}/${MAX_RETRIES} could not re-arm: ${errorMessage(error)}`)
    }
  }

  const schedule = (agent: object): void => {
    const goal = goals()?.get(agent)
    if (goal === undefined || (goal.phase !== 'active' && goal.phase !== 'paused')) return
    const state = stateOf(agent)
    if (state.timer !== undefined) return
    if (state.count >= MAX_RETRIES) {
      blockExhausted(agent, goal)
      return
    }
    const timer = setTimeout(() => retry(agent), DELAYS_MS[state.count])
    /* A pending recovery must not keep the host process alive. */
    if (typeof timer.unref === 'function') timer.unref()
    state.timer = timer
  }

  const reset = (agent: object): void => {
    const state = stateOf(agent)
    cancelTimer(state)
    state.count = 0
  }

  ctx.effect(() => () => {
    for (const state of states.values()) cancelTimer(state)
    states.clear()
  }, 'ceulen goal-retry timers')

  ctx.on('agent/error', (payload: { agent?: object }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const state = stateOf(agent)
    if (stoppedByHuman(state, Date.now())) return
    schedule(agent)
  })

  ctx.on('agent/disposed', (payload: { agent?: object }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const state = states.get(agent)
    if (state === undefined) return
    cancelTimer(state)
    states.delete(agent)
  })

  ctx.on('goal/changed', (payload: { agent?: object; change?: { operation?: string } }) => {
    const agent = payload?.agent
    const operation = payload?.change?.operation
    if (agent === undefined || operation === undefined) return
    const state = stateOf(agent)
    if (operation === 'resume') {
      // A human resume is a fresh decision: grant the full recovery budget
      // again. This module's own re-arm keeps the streak, or the cap is void.
      if (state.selfResume !== true) reset(agent)
      return
    }
    const now = Date.now()
    if (operation === 'pause' && state.abortedAt !== undefined && now - state.abortedAt <= ESC_PAUSE_WINDOW_MS) {
      state.abortedAt = undefined
      schedule(agent)
      return
    }
    if (STOP_OPERATIONS.has(operation)) state.stoppedAt = now
    state.abortedAt = undefined
    reset(agent)
  })

  ctx.on('session/event', (session: { id?: string }, event: { type?: string; data?: { reason?: { kind?: string; reason?: { kind?: string } } } }) => {
    if (event?.type !== 'turn/end') return
    const id = session?.id
    const agent = id === undefined ? undefined : agents()?.get?.(id)
    if (agent === undefined) return
    const reason = event.data?.reason
    const kind = reason?.kind
    if (kind === 'completed' || kind === 'max-tokens' || (kind === 'aborted' && reason?.reason?.kind === 'disposed')) {
      reset(agent)
      return
    }
    if (kind !== 'aborted' && kind !== 'error') return
    const state = stateOf(agent)
    // The harness cancels the turn itself for an explicit `/goal pause`; that
    // stop already happened, so this abort must not revive the goal.
    if (stoppedByHuman(state, Date.now())) return
    if (kind === 'aborted') state.abortedAt = Date.now()
    schedule(agent)
  })
}
