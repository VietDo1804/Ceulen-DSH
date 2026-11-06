export interface WebFetchResult {
  url: string
  statusCode: number
  body: { kind: 'html' | 'text'; content: string }
  truncated: boolean
}

export interface WebLike {
  fetch(request: { url: string; signal?: AbortSignal }): Promise<WebFetchResult>
}

export interface WebSearchProviderLike {
  readonly id: string
  available(): boolean
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{
    sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>
    truncated: boolean
  }>
}

export interface WebFetchProviderLike {
  readonly id: string
  available(): boolean
  fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResult>
}

export interface WebSearchServiceLike extends WebLike {
  registerSearchProvider?(provider: WebSearchProviderLike): () => void
  registerFetchProvider?(provider: WebFetchProviderLike): () => void
}

export interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> }
}
