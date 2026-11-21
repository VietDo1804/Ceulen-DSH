/**
 * TypeSafe System One decision models (Jev) over OpenRouter.
 *
 * Jev is not a chat model: its output modality is "decisions", and it answers
 * on `POST {base}/systemone` with typed answers instead of streamed text. The
 * question types are the ones `classify` already uses (noul, choice, score),
 * so a route naming a Jev model skips the chat path entirely.
 *
 * `typesafe/jev-router` is excluded: it is a chat router that dispatches to
 * other models, not a decision model.
 *
 * The wire shape follows upstream ceulen's router/lib/systemone.ts.
 */
import { credential } from './credentials.js'
import type { LlmRoute } from './llm.js'

export const SYSTEMONE_DEFAULT_BASE = 'https://openrouter.ai/api/v1'

export interface SystemOneQuestion {
  id: string
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: unknown
}

export interface SystemOneResult {
  /** Answers in the chat classifier's shape: noul → probability, choice → option. */
  answers: Record<string, Record<string, unknown>>
  model: string
  cost?: number
}

/** A route served by the System One endpoint rather than chat. */
export function isSystemOneRoute(route: Pick<LlmRoute, 'model'> | undefined): boolean {
  if (route === undefined) return false
  return /^~?typesafe\/jev(?!-router)(?:-|$)/i.test(route.model)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Map one wire answer to the chat classifier's shape, leaving validation to the caller. */
export function fromWireAnswer(question: SystemOneQuestion, answer: unknown): Record<string, unknown> {
  if (!isRecord(answer)) throw new Error(`System One returned no answer for "${question.id}"`)
  if (question.type === 'noul') return { probability: answer.noul }
  if (question.type === 'choice') {
    return {
      option: answer.choice,
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    }
  }
  return { score: answer.score, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) }
}

/**
 * Ask a Jev model. Rejects on transport, HTTP, or shape errors so the caller
 * can fall through to its next route.
 */
export async function askSystemOne(
  route: LlmRoute,
  state: unknown,
  questions: readonly SystemOneQuestion[],
  signal: AbortSignal,
): Promise<SystemOneResult> {
  const key = credential('OPENROUTER_API_KEY').value
  if (key === undefined) throw new Error('OPENROUTER_API_KEY is not set (env or the DSH credential store)')
  const base = (credential('OPENROUTER_BASE_URL').value ?? SYSTEMONE_DEFAULT_BASE).replace(/\/+$/u, '')
  const wire = Object.fromEntries(questions.map(({ id, ...rest }) => [id, rest]))
  const response = await fetch(`${base}/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: route.model, state, questions: wire }),
    signal,
  })
  if (!response.ok) throw new Error(`System One returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const body: unknown = await response.json()
  if (!isRecord(body) || !isRecord(body.answers)) throw new Error('System One returned an unexpected response')
  const answers: Record<string, Record<string, unknown>> = {}
  for (const question of questions) answers[question.id] = fromWireAnswer(question, body.answers[question.id])
  const usage = isRecord(body.usage) ? body.usage : undefined
  return {
    answers,
    model: typeof body.model === 'string' ? body.model : route.model,
    ...(typeof usage?.cost === 'number' ? { cost: usage.cost } : {}),
  }
}
