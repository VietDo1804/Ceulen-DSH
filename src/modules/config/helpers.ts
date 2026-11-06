import { dedupeRoutes, routeBase, type CeulenSettings, type ReasoningEffort } from '../../core/settings.js'
import { phaseRoute } from '../plan/index.js'
import type { ConfigContext } from './types.js'

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function envValue(context: ConfigContext, name: string): string {
  const env = context.env ?? process.env
  return env[name] !== undefined && env[name] !== '' ? 'set' : 'unset'
}

export function routeText(provider: string | null, model: string | null, effort: ReasoningEffort | null = null): string {
  return provider !== null && model !== null ? `${provider}/${model}${effort === null ? '' : `:${effort}`}` : ''
}export function planTargets(settings: CeulenSettings): string {
  const show = (selector: string): string => {
    const route = phaseRoute(selector)
    return route === undefined
      ? 'client route'
      : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `:${route.reasoningEffort}`}`
  }
  return `plan ${show(settings.plan.model)} · implement ${show(settings.plan.implement)}`
}

/** Parse `provider/model[:effort]`; empty clears the route. */
export function splitRoute(value: string): { provider: string; model: string; effort: ReasoningEffort | null } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error('expected provider/model[:effort]')
  }
  let model = trimmed.slice(slash + 1)
  let effort: ReasoningEffort | null = null
  const colon = model.lastIndexOf(':')
  if (colon > 0 && /^(off|minimal|low|medium|high|xhigh|max)$/.test(model.slice(colon + 1))) {
    effort = model.slice(colon + 1) as ReasoningEffort
    model = model.slice(0, colon)
  }
  return { provider: trimmed.slice(0, slash), model, effort }
}

export function splitList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** Case-insensitive substring filter used by the model picker. */
export function filterRoutes(routes: readonly string[], filter: string): string[] {
  const needle = filter.trim().toLowerCase()
  return needle.length === 0 ? [...routes] : routes.filter(route => route.toLowerCase().includes(needle))
}

/**
 * Route the picker commits: the highlighted catalog entry, else a typed
 * `provider/model` — catalog membership is advisory, so unlisted model ids
 * stay reachable. `-` commits an empty value (clear), and `*` / `@alias` are
 * role selectors the row's own setter validates.
 */
export function pickerRoute(visible: readonly string[], cursor: number, filter: string): string | undefined {
  const highlighted = visible[cursor]
  if (highlighted !== undefined) return highlighted
  const typed = filter.trim()
  if (typed === '-') return ''
  if (typed === '*' || /^@\S+$/.test(typed)) return typed
  return /^[^\s/]+\/\S+$/.test(typed) ? typed : undefined
}

/**
 * Keep the row's existing `:effort` suffix when the picked route has none.
 * A pick that is not a route (`@alias`, `*`, `''`) is returned untouched.
 */
export function keepEffort(picked: string, current: string): string {
  let parsed: ReturnType<typeof splitRoute> = null
  try {
    parsed = splitRoute(picked)
  } catch {
    parsed = null
  }
  if (parsed === null || parsed.effort !== null) return picked
  let effort: ReasoningEffort | null = null
  try {
    effort = splitRoute(current)?.effort ?? null
  } catch {
    effort = null
  }
  return effort === null ? picked : `${picked}:${effort}`
}

/**
 * Append one picked route to a comma-separated list, keeping order and dedupe.
 * A pick without `:effort` never duplicates the same model that is already
 * listed with one — the existing entry (and its effort) wins; a pick that has
 * an effort replaces that entry instead of adding a second copy.
 */
export function appendRouteList(current: string, picked: string): string {
  const list = current.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  const next = picked.trim()
  if (next === '') return ''
  const base = routeBase(next)
  const at = list.findIndex(entry => routeBase(entry) === base)
  if (at < 0) return [...list, next].join(', ')
  if (!next.includes(':')) return list.join(', ')
  return list.map((entry, index) => (index === at ? next : entry)).join(', ')
}

export function routeList(value: string): string[] {
  const entries = splitList(value)
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    if (slash <= 0 || slash === entry.length - 1) throw new Error(`invalid route "${entry}" — expected provider/model`)
  }
  return dedupeRoutes(entries)
}

/**
 * Selector stored in `subagent.models.<role>`: `provider/model[:effort]`,
 * `@alias`, `*`, or empty to clear. Malformed routes throw so the editor stays
 * open instead of writing an entry the resolver silently drops.
 */
export function roleSelector(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '*' || /^@\S+$/.test(trimmed)) return trimmed
  splitRoute(trimmed)
  return trimmed
}

