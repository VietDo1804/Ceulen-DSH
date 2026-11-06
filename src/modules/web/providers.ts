import type { PluginContext } from '../../core/types.js'
import { credential } from '../../core/credentials.js'
import { errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { createFallbackFetchProvider, FALLBACK_FETCH_PROVIDER_ID } from './fetch.js'
import type { BraveResponse, WebSearchProviderLike, WebSearchServiceLike } from './types.js'

/** Whether each optional provider registered; web_status reads this. */
export const webProviders = { brave: false, fallback: false }

/** The Brave Search provider: keyed from the credential store, never settings. */
export function createBraveProvider(): WebSearchProviderLike {
  return {
    id: 'brave',
    available: () => credential('BRAVE_API_KEY').value !== undefined,
    async search(request, signal) {
      const key = credential('BRAVE_API_KEY').value
      if (key === undefined) throw new Error('BRAVE_API_KEY is not configured (env or the DSH credential store)')
      if (signal?.aborted === true) throw signal.reason ?? new Error('Brave search aborted')
      const count = Math.min(20, Math.max(1, request.maxResults ?? 8))
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', request.query)
      url.searchParams.set('count', String(count))
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal,
      })
      if (!response.ok) throw new Error(`Brave Search failed: HTTP ${response.status} ${response.statusText}`)
      const data = (await response.json()) as BraveResponse
      const sources = (data.web?.results ?? [])
        .slice(0, count)
        .flatMap(result => {
          if (result.url === undefined || result.url.length === 0) return []
          return [{
            url: result.url,
            ...(result.title ? { title: result.title } : {}),
            ...(result.description ? { snippet: result.description } : {}),
            ...(result.page_age ? { publishedAt: result.page_age } : {}),
          }]
        })
      return { sources, truncated: false }
    },
  }
}

export function registerBrave(ctx: PluginContext): void {
  try {
    const web = ctx.get('web', false) as WebSearchServiceLike | undefined
    if (typeof web?.registerSearchProvider !== 'function') {
      logLine('web', 'web service is not mounted; Brave search provider was not registered')
      return
    }
    ctx.effect(() => web.registerSearchProvider!(createBraveProvider()), 'ceulen brave search provider')
    webProviders.brave = true
    logLine('web', 'brave search provider registered')
  } catch (error) {
    logLine('web', `Brave search provider registration failed: ${errorMessage(error)}`)
  }
}

export function registerFetchFallback(ctx: PluginContext): void {
  try {
    const web = ctx.get('web', false) as WebSearchServiceLike | undefined
    if (typeof web?.registerFetchProvider !== 'function') {
      logLine('web', 'web service is not mounted; fetch fallback provider was not registered')
      return
    }
    ctx.effect(() => web.registerFetchProvider!(createFallbackFetchProvider()), 'ceulen fetch fallback provider')
    webProviders.fallback = true
    logLine('web', `fetch fallback provider registered (${FALLBACK_FETCH_PROVIDER_ID})`)
  } catch (error) {
    logLine('web', `Fetch fallback provider registration failed: ${errorMessage(error)}`)
  }
}

