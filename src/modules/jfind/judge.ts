import type { AgentLike, PluginContext } from '../../core/types.js'
import { extractJson, streamText, type LlmRoute } from '../../core/llm.js'
import { JUDGE_BUDGET_CHARS, judgeUserMessage, type Judge, type JudgmentResult, type Request } from '../../vendor/ceulen/jfind/questions.js'

const SYSTEM = `You are a semantic code-search judge. Read the supplied state (a tree listing, sketches, or passages) and answer every question with a calibrated probability.

Return exactly one JSON object:
{"answers":{"<question-key>":{"probability":0.0}}}

Rules:
- One entry for every key in "questions". Do not omit keys.
- probability is 0..1: how likely the entry contains substantive implementation, definition, or explanation of the search.
- Mere mentions, imports, declarations, call sites, tests, or configuration score LOW.
- A helper implementing one requested step counts even when other steps are elsewhere.
- JSON only; no prose, no markdown.`

export function createLlmJudge(ctx: PluginContext, route: LlmRoute): Judge {
  return {
    label: `${route.provider}/${route.model}`,
    async judge(request: Request, options?: { signal?: AbortSignal }): Promise<JudgmentResult> {
      const signal = options?.signal ?? new AbortController().signal
      const user = judgeUserMessage(request)
      if (user.length > JUDGE_BUDGET_CHARS) {
        throw new Error(
          `jfind judge request is ${user.length} chars, over the ${JUDGE_BUDGET_CHARS}-char budget; refusing to truncate serialized JSON`,
        )
      }
      const text = await streamText(ctx, route, SYSTEM, user, signal, 2_400)
      const parsed = extractJson(text)
      if (parsed === null || typeof parsed !== 'object') throw new Error('jfind judge returned no JSON object')
      const root = parsed as { answers?: unknown; [key: string]: unknown }
      const answers = (root.answers !== null && typeof root.answers === 'object' ? root.answers : root) as Record<string, unknown>
      const normalized: Record<string, { probability?: number }> = {}
      for (const key of Object.keys(request.questions)) {
        const value = answers[key]
        let probability: number | undefined
        if (typeof value === 'number') probability = value
        else if (value !== null && typeof value === 'object') {
          const record = value as { probability?: unknown; noul?: unknown }
          const raw = record.probability ?? record.noul
          if (typeof raw === 'number') probability = raw
        }
        normalized[key] = { probability: probability !== undefined && Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : undefined }
      }
      return { answers: normalized }
    },
  }
}

export function routeFor(agent: AgentLike | undefined): LlmRoute {
  if (agent?.options.provider !== undefined && agent.options.model !== undefined) {
    return {
      provider: agent.options.provider,
      model: agent.options.model,
      ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort }),
      sessionId: String(agent.session.id),
    }
  }
  throw new Error('jfind needs an agent with a configured provider/model route')
}
