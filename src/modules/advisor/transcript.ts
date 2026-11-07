import type { ContentBlock, MessageLike } from '../../core/types.js'
import { clampText } from '../../core/tools.js'

export const WATCH_BUDGET = 20_000
export const CONSULT_BUDGET = 16_000
const REQUEST_CHARS = 3_000
const PREVIOUS_REQUEST_CHARS = 800
const RESULT_HEAD = 1_200
const RESULT_TAIL = 400
const SCRIPT_CHARS = 1_500

/** A real human prompt: notices (time-context, approvals, …) never qualify. */
export function isUserPrompt(message: MessageLike): boolean {
  if (message.role !== 'user') return false
  const kind = message.source?.kind
  if (kind !== undefined && kind !== 'user') return false
  return promptText(message).length > 0
}

/**
 * A new prompt or a delivered advisor note starts a fresh unit of work. Both
 * must reset the tool-call counter: a note-only reply after a concern is a
 * settled turn, not a continuation, or the advisor would review its own notes.
 */
export function isTurnBoundary(message: MessageLike): boolean {
  return isUserPrompt(message) || message.source?.kind === 'ceulen-advisor'
}

function promptText(message: MessageLike): string {
  return message.content
    .map(block => {
      const value = block as Record<string, unknown>
      return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
    })
    .filter(part => part.length > 0)
    .join('\n')
}

/** Count tool calls since the last turn boundary. */
export function toolCallsInTurn(messages: readonly MessageLike[]): number {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isTurnBoundary(messages[index]!)) {
      start = index
      break
    }
  }
  let count = 0
  for (const message of messages.slice(start)) {
    for (const block of message.content) if ((block as { type?: string }).type === 'tool-call') count += 1
  }
  return count
}

const NESTED_CALL = /tools(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*\(/g

function codemodeCall(value: Record<string, unknown>): string {
  let args: unknown = value.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = undefined
    }
  }
  const code = args !== null && typeof args === 'object' && typeof (args as { code?: unknown }).code === 'string'
    ? (args as { code: string }).code
    : ''
  const counts = new Map<string, number>()
  for (const match of code.matchAll(NESTED_CALL)) {
    const name = match[1] ?? match[2] ?? ''
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const nested = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(', ')
  const label = nested.length > 0 ? `[tool codemode nested: ${nested}]` : '[tool codemode]'
  return `${label}\n${clampText(code, SCRIPT_CHARS)}`
}

function blockText(block: ContentBlock): string {
  const value = block as unknown as Record<string, unknown>
  if (value.type === 'text') return typeof value.text === 'string' ? value.text : ''
  if (value.type === 'tool-call') {
    if (String(value.name ?? '') === 'codemode') return codemodeCall(value)
    const args = value.arguments === undefined ? '' : JSON.stringify(value.arguments)
    return `[tool ${String(value.name ?? '?')}${args.length > 0 ? ` ${clampText(args, 600)}` : ''}]`
  }
  if (value.type === 'image') return '[image]'
  if (value.type === 'file') return `[file ${String(value.name ?? '')}]`
  return ''
}

/** Tool results keep head and tail: the error sits at the end, the context at the start. */
function clipResult(body: string): string {
  if (body.length <= RESULT_HEAD + RESULT_TAIL) return body
  const omitted = body.length - RESULT_HEAD - RESULT_TAIL
  return `${body.slice(0, RESULT_HEAD)}\n[… ${omitted} chars …]\n${body.slice(-RESULT_TAIL)}`
}

function messageLine(message: MessageLike): string | undefined {
  if (message.role === 'system') return undefined
  if (message.role === 'user') {
    // In-turn user messages are harness notices; only advisor notes are real.
    if (message.source?.kind !== 'ceulen-advisor') return undefined
    const body = promptText(message)
    return body.length > 0 ? `ADVISOR NOTE: ${body}` : undefined
  }
  const body = message.content.map(blockText).filter(part => part.length > 0).join('\n')
  if (body.length === 0) return undefined
  if (message.role === 'tool') return `TOOL: ${clipResult(body)}`
  return `${message.role.toUpperCase()}: ${body}`
}

const OMITTED_TURN = '[…earlier steps of this turn omitted…]'

/**
 * Render the latest turn with the user's request pinned at the top. The turn
 * body is clipped from the front when over budget — the agent's answer is at
 * the end — while the pinned request is never clipped for budget reasons.
 */
export function renderTurn(messages: readonly MessageLike[], budget: number): { text: string; pinned: boolean } {
  let lastPrompt = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserPrompt(messages[index]!)) {
      lastPrompt = index
      break
    }
  }
  let previousPrompt = -1
  for (let index = lastPrompt - 1; index >= 0; index -= 1) {
    if (isUserPrompt(messages[index]!)) {
      previousPrompt = index
      break
    }
  }
  const pinned: string[] = []
  if (lastPrompt >= 0) {
    pinned.push('USER REQUEST (latest, always shown):', clampText(promptText(messages[lastPrompt]!), REQUEST_CHARS))
    if (previousPrompt >= 0) {
      pinned.push('', 'PREVIOUS USER REQUEST (clipped):', clampText(promptText(messages[previousPrompt]!), PREVIOUS_REQUEST_CHARS))
    }
  }
  const pinnedText = pinned.join('\n')

  const lines: string[] = []
  for (const message of messages.slice(lastPrompt + 1)) {
    const line = messageLine(message)
    if (line !== undefined) lines.push(line)
  }
  let turnText = lines.join('\n\n')
  const turnBudget = Math.max(0, budget - pinnedText.length)
  if (turnText.length > turnBudget) {
    const room = turnBudget - OMITTED_TURN.length - 2
    turnText = room > 0 ? `${OMITTED_TURN}\n\n${turnText.slice(-room)}` : OMITTED_TURN
  }

  const sections = [
    ...(pinnedText.length > 0 ? [pinnedText] : []),
    `THIS TURN (oldest first):${turnText.length > 0 ? `\n${turnText}` : ''}`,
  ]
  return { text: sections.join('\n\n'), pinned: lastPrompt >= 0 }
}
