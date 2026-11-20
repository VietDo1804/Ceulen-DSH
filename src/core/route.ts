import type { AgentLike } from './types.js'

/** `provider/model` the agent is on now: the durable selection first, then its creation options. */
export function agentRoute(agent: Partial<Pick<AgentLike, 'model' | 'options'>> | undefined): string | undefined {
  if (agent === undefined) return undefined
  let current: { provider?: string; model?: string } | undefined
  try {
    current = agent.model?.current?.()
  } catch {
    current = undefined
  }
  const provider = current?.provider ?? agent.options?.provider
  const model = current?.model ?? agent.options?.model
  return provider !== undefined && model !== undefined ? `${provider}/${model}` : undefined
}

/** `models` entries match as substrings of `provider/model`; `*` matches every route; [] matches none. */
export function routeWanted(models: readonly string[], route: string | undefined): boolean {
  if (route === undefined) return false
  return models.some(entry => entry === '*' || (entry.length > 0 && route.includes(entry)))
}
