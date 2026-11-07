/**
 * Detects runs of consecutive steps that each make exactly one read-only call
 * — the pattern the codemode-first rule wants folded into one script or one
 * parallel batch. Pure state machine; the wiring lives in index.ts.
 */
export interface ChainState {
  stepKey?: string
  stepCalls: number
  stepReadOnly: boolean
  chain: number
  hintedTurn?: number
}

const READ_ONLY_TOOLS = new Set(['read', 'read_slice', 'grep', 'glob', 'fff_grep', 'ls', 'jfind'])
// ponytail: `cat a && rm b` counts as read-only; the hint is advice, not a gate.
const READ_ONLY_BASH = /^\s*(?:cd [^&;]+(?:&&|;)\s*)?(cat|sed -n|head|tail|ls|grep|rg|find|wc|git (log|show|diff|status|blame)|nl|tree|stat|file|jq)\b/

export const HINT = 'Several single read steps in a row. Put the next independent reads, or the whole grep → read → filter chain, into one codemode script or one parallel tool batch.'

export function createChainState(): ChainState {
  return { stepCalls: 0, stepReadOnly: false, chain: 0 }
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

/**
 * Feed every `tool/call` event. Returns true when the chain reached the
 * threshold and a hint should be injected for this turn (at most once a turn).
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
    state.chain = state.stepCalls === 1 && state.stepReadOnly ? state.chain + 1 : 0
  }
  state.stepKey = stepKey
  state.stepCalls = 1
  state.stepReadOnly = isReadOnlyCall(call.name, call.arguments)
  if (threshold <= 0 || state.chain < threshold) return false
  if (state.hintedTurn === call.turn || call.name === 'codemode') return false
  state.hintedTurn = call.turn
  state.chain = 0
  return true
}
