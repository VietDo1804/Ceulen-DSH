import type { PluginContext } from '../../core/types.js'
import { credential } from '../../core/credentials.js'
import { errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { assertPublicUrl } from './url-guard.js'
import type { WebFetchProviderLike, WebFetchResult, WebLike } from './types.js'

export async function fetchPage(ctx: PluginContext, url: string, signal: AbortSignal, options?: { direct?: boolean }): Promise<WebFetchResult> {
  // A markdown-provider pin (`deepseek-fetch-api`) makes ctx.web.fetch return
  // `kind: 'text'`; callers that need raw HTML pass `direct` to bypass it.
  const service = options?.direct === true ? undefined : ctx.get('web', false) as WebLike | undefined
  if (service !== undefined && typeof service.fetch === 'function') {
    return await service.fetch({ url, signal })
  }
  return await fetchDirectPublic(url, signal)
}

/** DeepSeek Fetch API endpoint; mirrors the native provider's default base. */
const DEEPSEEK_FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch'
const DEEPSEEK_FETCH_TIMEOUT_MS = 20_000
/** Local leg caps, matching the native `http` fetch provider's body limit. */
const FETCH_MAX_CHARS = 100_000
const FETCH_MAX_REDIRECTS = 5
export const FALLBACK_FETCH_PROVIDER_ID = 'deepseek-fetch-fallback'

/** Page Markdown from the DeepSeek Fetch API; throws on any non-usable reply. */
export async function fetchDeepSeekMarkdown(url: string, key: string, signal?: AbortSignal): Promise<WebFetchResult> {
  const timeout = AbortSignal.timeout(DEEPSEEK_FETCH_TIMEOUT_MS)
  const response = await fetch(DEEPSEEK_FETCH_ENDPOINT, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ url }),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  const payload = await response.json().catch(() => undefined) as { content?: unknown } | undefined
  if (!response.ok || typeof payload?.content !== 'string') {
    throw new Error(`DeepSeek fetch failed: HTTP ${response.status}`)
  }
  return { url, statusCode: 200, body: { kind: 'text', content: payload.content }, truncated: false }
}

/**
 * Local HTTP fetch for the fallback leg and the service-less path. Redirects
 * are followed by hand so every hop is re-checked against {@link assertPublicUrl}
 * (the native `http` provider pins connections; this is the cheap equivalent).
 */
export async function fetchDirectPublic(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
  let current = url
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    current = await assertPublicUrl(current)
    const response = await fetch(current, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ceulen-dsh web)' },
      ...(signal === undefined ? {} : { signal }),
      redirect: 'manual',
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel()
      current = new URL(location, current).href
      continue
    }
    const text = await response.text()
    const type = response.headers.get('content-type') ?? ''
    return {
      url: response.url || current,
      statusCode: response.status,
      body: { kind: type.includes('html') ? 'html' : 'text', content: text.slice(0, FETCH_MAX_CHARS) },
      truncated: text.length > FETCH_MAX_CHARS,
    }
  }
  throw new Error('too many redirects')
}

/**
 * DeepSeek Fetch API (clean page Markdown) with a local HTTP fallback,
 * registered as a native fetch provider so `web_fetch`, `web_extract`, and
 * `web_map` all degrade to the local fetcher when the API fails — 401/429, a
 * timeout, or a page its extractor cannot handle (e.g. reddit returns 404).
 */
export function createFallbackFetchProvider(): WebFetchProviderLike {
  return {
    id: FALLBACK_FETCH_PROVIDER_ID,
    // The local leg always works, so provider selection never fails.
    available: () => true,
    async fetch(request, signal) {
      const key = credential('DEEPSEEK_API_KEY').value
      if (key !== undefined) {
        try {
          return await fetchDeepSeekMarkdown(request.url, key, signal)
        } catch (error) {
          logLine('web', `DeepSeek fetch failed (${errorMessage(error)}); falling back to local HTTP`)
        }
      }
      return await fetchDirectPublic(request.url, signal)
    },
  }
}

/**
 * web_map needs raw HTML, but a markdown fetch pin (`deepseek-fetch-api`)
 * returns `kind: 'text'` from the service. Only then re-fetch directly, so the
 * native validation/redirect policy still governs the normal `http` pin.
 */
export async function fetchHtmlPage(ctx: PluginContext, url: string, signal: AbortSignal): Promise<WebFetchResult> {
  const result = await fetchPage(ctx, url, signal)
  if (result.body.kind === 'html') return result
  return await fetchPage(ctx, url, signal, { direct: true })
}


/**
 * Capture tools (screenshot, PDF, interact, runtime UX audit) take http(s) URLs
 * and any file:// inside the workspace. `assertCaptureUrl` is only the
 * argv-injection guard (the URL becomes a spawn argument); `captureUrlProblem`
 * adds the network boundary for link-local/metadata ranges, while loopback and
 * LAN dev servers stay auditable.
 */
