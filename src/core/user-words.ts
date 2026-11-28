/**
 * What the user said in a session, for judges that need the task: the gate
 * and `/ux auto`.
 *
 * Only two sources count, both written by the user (or the delegating agent,
 * for a subagent brief): real inbox messages, and answers to the ask tools.
 * Tool output and file contents never do, so text inside a repo cannot
 * authorize a destructive command.
 */
import { clampText } from './tools.js'

/**
 * DSH closes a subagent brief with a text block of its own, about how the
 * result reaches the parent. Read as the request it made every delegated
 * session look like "send a message", so no child was judged on its task.
 * The wording changed between cores (0.2.2-rc.1: "Your parent agent id is…",
 * rc.5: "Your final answer is delivered automatically if your parent…"), so a
 * session known to be delegated is not matched by wording alone: there, a
 * short last block that speaks of the parent is the harness's.
 */
const DELIVERY_NOTE = /^(?:Your parent agent id is "|Your final answer is delivered automatically)/
const NOTE_LIMIT = 800

function isDeliveryNote(text: string, delegated: boolean): boolean {
  return DELIVERY_NOTE.test(text) || (delegated && text.length < NOTE_LIMIT && /\bparent\b/i.test(text))
}

/**
 * Text of real user messages in an inbox splice; nudges, relays and notices
 * carry another source kind. `delegated` says the session has a parent, so its
 * message is a brief.
 */
export function userTextOf(data: unknown, delegated = false): string | undefined {
  const splice = data as { target?: string; inserted?: Array<{ role?: string; source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }> } | undefined
  if (splice?.target !== 'next-turn' || !Array.isArray(splice.inserted)) return undefined
  // The last text block is the request: a subagent brief opens with its role
  // preamble and closes with the harness's delivery note.
  let text = ''
  for (const message of splice.inserted) {
    if (message.role !== 'user' || message.source?.kind !== 'user') continue
    const blocks = (message.content ?? []).flatMap(block => (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0 ? [block.text.trim()] : []))
    // A brief of one block is all task, whatever it says.
    while (blocks.length > 1 && isDeliveryNote(blocks.at(-1)!, delegated)) blocks.pop()
    if (blocks.length > 0 && !(blocks.length === 1 && DELIVERY_NOTE.test(blocks[0]!))) text = blocks.at(-1)!
  }
  return text.length === 0 ? undefined : text
}

/** Tools whose successful result is the user's own answer. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(['ask_user_question', 'ask_human'])

// The gate fires only on destructive commands and Jev input costs $0.042/M,
// so a long brief fits: a delegated brief can be 40k chars with the one line
// that authorizes a DROP near its end, ahead of an appended roster.
const REQUEST_HEAD = 3_000
const REQUEST_TAIL = 9_000
const ANSWER_LIMIT = 1_000

/** Keep both ends of a long request: the task opens it, the latest ask closes it. */
function ends(text: string): string {
  if (text.length <= REQUEST_HEAD + REQUEST_TAIL) return text
  return `${text.slice(0, REQUEST_HEAD)}\n…(${text.length - REQUEST_HEAD - REQUEST_TAIL} chars omitted)…\n${text.slice(-REQUEST_TAIL)}`
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** The question the model asked and what the user picked, as one compact line. */
export function askAnswerText(args: unknown, value: unknown): string | undefined {
  const answer = stringify(value).trim()
  if (answer.length === 0) return undefined
  const questions = (args as { questions?: Array<{ question?: unknown }>; question?: unknown } | undefined)
  const asked = Array.isArray(questions?.questions)
    ? questions.questions.map(item => (typeof item?.question === 'string' ? item.question : '')).filter(Boolean).join(' | ')
    : typeof questions?.question === 'string' ? questions.question : ''
  return clampText(asked.length > 0 ? `Q: ${asked}\nA: ${answer}` : `A: ${answer}`, ANSWER_LIMIT)
}

interface Words {
  request?: string
  answer?: string
}

/** Per-session record of the latest user request and ask-tool answer. */
export class UserWords {
  private readonly sessions = new Map<string, Words>()

  /** A new request starts a new task: the answer to an older question no longer applies. */
  request(id: string, text: string): void {
    this.sessions.set(id, { request: ends(text) })
  }

  answer(id: string, text: string): void {
    const words = this.sessions.get(id) ?? {}
    words.answer = text
    this.sessions.set(id, words)
  }

  forget(id: string): void {
    this.sessions.delete(id)
  }

  get(id: string | undefined): Words {
    return id === undefined ? {} : { ...(this.sessions.get(id) ?? {}) }
  }
}
