/**
 * Detects runs of consecutive steps that each make exactly one read-only call
 * — the pattern the codemode-first rule wants folded into one script or one
 * parallel batch. Pure state machine; the wiring lives in index.ts.
 */
export interface ChainState {
  stepKey?: string
  stepCalls: number
  stepReadOnly: boolean
  /** Short label of the current step's first call, kept for the hint text. */
  stepLabel?: string
  chain: number
  /** Labels of the lone read steps in the current chain, oldest first. */
  chainLabels: string[]
  hintedTurn?: number
  /** The chain that triggered the last hint; index.ts renders it. */
  hintedLabels: string[]
}

const READ_ONLY_TOOLS = new Set(['read', 'read_slice', 'grep', 'glob', 'fff_grep', 'ls', 'jfind'])
// ponytail: `cat a && rm b` counts as read-only; the hint is advice, not a gate.
const READ_ONLY_BASH = /^\s*(?:cd [^&;]+(?:&&|;)\s*)?(cat|sed -n|head|tail|ls|grep|rg|find|wc|git (log|show|diff|status|blame)|nl|tree|stat|file|jq)\b/

export const HINT = 'Put the next independent reads, or the whole grep → read → filter chain, into one codemode script or one parallel tool batch.'

const LABEL_CHARS = 60
const LABEL_KEYS = ['path', 'file_path', 'pattern', 'command', 'query'] as const

export function createChainState(): ChainState {
  return { stepCalls: 0, stepReadOnly: false, chain: 0, chainLabels: [], hintedLabels: [] }
}

export function isReadOnlyCall(name: string, argumentsJson: string | undefined): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true
  if (name !== 'bash') return false
  try {
    return READ_ONLY_BASH.test(JSON.parse(argumentsJson ?? '{}').command ?? '')
  } catch {
    return false
  }
}

/** `read src/a.ts`, `bash git log …`: the call as the model would recognise it. */
export function callLabel(name: string, argumentsJson: string | undefined): string {
  try {
    const args = JSON.parse(argumentsJson ?? '{}') as Record<string, unknown>
    for (const key of LABEL_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) {
        const one = value.replace(/\s+/g, ' ').trim()
        return `${name} ${one.length <= LABEL_CHARS ? one : `${one.slice(0, LABEL_CHARS - 1)}…`}`
      }
    }
  } catch {
    // Unparseable arguments: the bare name still tells the model which step.
  }
  return name
}

/**
 * The injected notice names the steps it is about: a concrete list is acted on
 * more often than a generic reminder. Measured 2026-11-08: the generic hint was
 * followed by a codemode script 4 times out of 14.
 */
export function hintText(labels: readonly string[]): string {
  const list = labels.length > 0 ? ` (${labels.join('; ')})` : ''
  return `${labels.length > 0 ? labels.length : 'Several'} single read steps in a row${list}. ${HINT}`
}

/**
 * Feed every `tool/call` event. Returns true when the chain reached the
 * threshold and a hint should be injected for this turn (at most once a turn);
 * `state.hintedLabels` then holds the steps the hint is about.
 */
export function noteToolCall(
  state: ChainState,
  call: { turn: number; step: number; name: string; arguments?: string },
  threshold: number,
): boolean {
  const stepKey = `${call.turn}/${call.step}`
  if (state.stepKey === stepKey) {
    state.stepCalls += 1
    state.stepReadOnly = state.stepReadOnly && isReadOnlyCall(call.name, call.arguments)
    return false
  }
  // Close the previous step: only a lone read-only call extends the chain.
  if (state.stepKey !== undefined) {
    if (state.stepCalls === 1 && state.stepReadOnly) {
      state.chain += 1
      state.chainLabels.push(state.stepLabel ?? '?')
    } else {
      state.chain = 0
      state.chainLabels = []
    }
  }
  state.stepKey = stepKey
  state.stepCalls = 1
  state.stepReadOnly = isReadOnlyCall(call.name, call.arguments)
  state.stepLabel = callLabel(call.name, call.arguments)
  if (threshold <= 0 || state.chain < threshold) return false
  if (state.hintedTurn === call.turn || call.name === 'codemode') return false
  state.hintedTurn = call.turn
  state.hintedLabels = state.chainLabels
  state.chain = 0
  state.chainLabels = []
  return true
}
