/**
 * The advisor's reading of an orchestrator lead's plan, before the user sees
 * it. The advisor module registers the reviewer here; the plan gate in
 * ../subagent/orchestrator.ts asks for it. With no advisor loaded there is no
 * reviewer and the plan goes straight to the user.
 *
 * A 2026-11-22 run showed why this sits at the plan and not after the turn: the
 * plan review card opens inside the lead's turn, so the turn-end watcher first
 * ran 29 seconds after the user had approved, and the plan's flaw (new wording
 * for a hint that already existed, no look at a real failure) was left for the
 * user to catch.
 */
import type { AgentLike, MessageLike } from '../../core/types.js'
import { clampText } from '../../core/tools.js'
import { isUserPrompt } from './transcript.js'

export interface PlanAdvice {
  /** One line per point, `[concern] …` or `[nit] …`; empty when the plan stands. */
  readonly notes: readonly string[]
  /** The route that answered, for the card and the log. */
  readonly reviewer: string
}

export interface PlanReviewInput {
  readonly agent: AgentLike
  /** The plan file as it stands. */
  readonly plan: string
  /** The plan the user approved earlier, when this one changes it. */
  readonly approved?: string
  /** The points of the round before, to check against the revision. */
  readonly earlier?: readonly string[]
  readonly signal?: AbortSignal
}

/** Resolves to undefined when the advisor does not review this lead (switched off, or a skipped main model). */
export type PlanAdviser = (input: PlanReviewInput) => Promise<PlanAdvice | undefined>

let registered: PlanAdviser | undefined

/** The advisor module's reviewer, set while that module is loaded. */
export function setPlanAdviser(adviser: PlanAdviser | undefined): void {
  registered = adviser
}

export function planAdviser(): PlanAdviser | undefined {
  return registered
}

export const PLAN_SYSTEM = `You review a team lead's plan before the user is asked to approve it. The lead will hand each task to a subagent that sees only its brief. You cannot use tools: judge the plan against the user's own words and the evidence in the transcript.

Look for what would make the user send the plan back:
- It does not do what the user asked: something asked for is missing, or work nobody asked for was added.
- It guesses: an assumption that is really the user's decision, or a request read one way when it can be read two ways.
- It treats a symptom: no cause is named, or the cause is asserted with no evidence in the transcript (a log, a failing run, the code that raises the error).
- A task is not decision-complete, two tasks of one wave write the same files, or a check would pass without the change.
- A destructive or irreversible step, or a result nobody verifies.

Report only points that would change the plan. Do not restate the plan, praise it or ask for more detail for its own sake. When earlier points are listed, check whether the revised plan resolved or answered each one and report only what is still open.

Answer in this exact shape:
VERDICT: ok
or
VERDICT: revise
- [concern] <what is wrong> -> <what the plan should say instead>
- [nit] <a small improvement>
At most 5 points, one line each, the most important first. "concern" is something the user would reject the plan for; "nit" is worth fixing but would not.`

const REQUEST_CHARS = 3_000
const REQUESTS_BUDGET = 8_000
const MAX_NOTES = 5
const NOTE_CHARS = 600

function promptText(message: MessageLike): string {
  return message.content
    .map(block => {
      const value = block as Record<string, unknown>
      return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
    })
    .filter(part => part.length > 0)
    .join('\n')
}

/** Every prompt the user typed in this session, oldest first; the oldest are dropped when over budget. */
export function userRequests(messages: readonly MessageLike[]): string[] {
  const all = messages.filter(isUserPrompt).map(message => clampText(promptText(message), REQUEST_CHARS))
  let used = 0
  const kept: string[] = []
  for (const text of all.reverse()) {
    if (kept.length > 0 && used + text.length > REQUESTS_BUDGET) break
    kept.unshift(text)
    used += text.length
  }
  return kept
}

export function planReviewPrompt(input: { requests: readonly string[]; transcript: string; plan: string; approved?: string; earlier?: readonly string[] }): string {
  const parts = [
    `WHAT THE USER ASKED (their own messages, oldest first):\n${input.requests.length === 0 ? '(no user message found)' : input.requests.map((text, index) => `${index + 1}. ${text}`).join('\n\n')}`,
    `WHAT THE LEAD DID BEFORE PLANNING (latest turn, clipped):\n${input.transcript}`,
  ]
  if (input.approved !== undefined) parts.push(`THE PLAN THE USER ALREADY APPROVED:\n${input.approved}\n\nThe plan below changes it. Review the change, not the parts the user already approved.`)
  if (input.earlier !== undefined && input.earlier.length > 0) parts.push(`YOUR POINTS ON THE VERSION BEFORE:\n${input.earlier.map(note => `- ${note}`).join('\n')}`)
  parts.push(`THE PLAN TO REVIEW:\n${input.plan}`)
  return parts.join('\n\n---\n\n')
}

const POINT = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/
const TAGGED = /^\[?(concern|nit|blocker)\]?\s*[:\-–]?\s*(.*)$/i

/** The reviewer's answer as points. An answer in no known shape is one concern, so nothing it said is dropped. */
export function parsePlanNotes(text: string): string[] {
  const notes: string[] = []
  for (const line of text.split('\n')) {
    const body = POINT.exec(line)?.[1]
    if (body === undefined) continue
    const tagged = TAGGED.exec(body)
    const kind = tagged === null ? 'concern' : tagged[1]!.toLowerCase() === 'nit' ? 'nit' : 'concern'
    const point = (tagged === null ? body : tagged[2]!).trim()
    if (point !== '') notes.push(`[${kind}] ${clampText(point, NOTE_CHARS)}`)
    if (notes.length === MAX_NOTES) break
  }
  if (notes.length > 0) return notes
  if (/^\s*VERDICT\s*:\s*ok\b/im.test(text)) return []
  const rest = text.replace(/^\s*VERDICT\s*:.*$/im, '').trim()
  return rest === '' ? [] : [`[concern] ${clampText(rest.replace(/\s+/g, ' '), NOTE_CHARS)}`]
}
