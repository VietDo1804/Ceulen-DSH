#!/usr/bin/env node
/**
 * Head-to-head web search benchmark: Brave (Ceulen's native ctx.web provider)
 * against DeepSeek's official web search (the backend `dsh web` ships with).
 *
 * Brave reads BRAVE_API_KEY, DeepSeek reads DEEPSEEK_API_KEY; both resolve from
 * the environment first and then the DSH credential store. DeepSeek answers one
 * query with a full model turn, so keep the query list small.
 *
 *   node scripts/bench-search.mjs
 *   node scripts/bench-search.mjs --queries "q1;q2" --max 10
 *   node scripts/bench-search.mjs --brave-only
 */
import assert from 'node:assert/strict'
import { credential } from '../lib/core/credentials.js'
import { createBraveProvider } from '../lib/modules/web/index.js'

const DEFAULT_QUERIES = [
  'DeepSeek Harness plugin API reference',
  'Renesas RZ/V2H datasheet',
  'Node.js fetch AbortSignal timeout example',
  'Munin memory server kalera.ai',
  'ECONNREFUSED 127.0.0.1:5432 postgres docker',
]

function args() {
  const out = { max: 8, queries: DEFAULT_QUERIES, brave: true, deepseek: true }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--max') out.max = Math.max(1, Number(argv[++i]) || 8)
    else if (flag === '--queries') out.queries = String(argv[++i] ?? '').split(';').map(q => q.trim()).filter(Boolean)
    else if (flag === '--brave-only') out.deepseek = false
    else if (flag === '--deepseek-only') out.brave = false
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: bench-search.mjs [--max N] [--queries "a;b"] [--brave-only|--deepseek-only]')
      process.exit(0)
    }
  }
  return out
}

async function braveSearch(query, maxResults) {
  const provider = createBraveProvider()
  if (!provider.available()) return { error: 'BRAVE_API_KEY is not set (env or credential store)' }
  const started = performance.now()
  try {
    const result = await provider.search({ query, maxResults }, AbortSignal.timeout(30_000))
    return { elapsed: Math.round(performance.now() - started), sources: result.sources }
  } catch (error) {
    return { elapsed: Math.round(performance.now() - started), error: error.message }
  }
}

async function deepseekSearch(query, maxResults) {
  const key = credential('DEEPSEEK_API_KEY').value
  if (key === undefined) return { error: 'DEEPSEEK_API_KEY is not set (env or credential store; sign in or add a key)' }
  const base = (process.env.DEEPSEEK_SEARCH_BASE_URL ?? 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, '')
  const started = performance.now()
  try {
    const response = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_SEARCH_MODEL ?? 'deepseek-v4-flash',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    const elapsed = Math.round(performance.now() - started)
    if (!response.ok) return { elapsed, error: `HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}` }
    const data = await response.json()
    return { elapsed, sources: parseDeepSeekResponse(data, maxResults), model: data.model }
  } catch (error) {
    return { elapsed: Math.round(performance.now() - started), error: error.message }
  }
}

/** Map a DeepSeek Anthropic-Messages response to citeable sources. */
export function parseDeepSeekResponse(data, maxResults) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  const snippets = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      if (citation?.url && citation?.cited_text && !snippets.has(citation.url)) snippets.set(citation.url, citation.cited_text)
    }
  }
  const seen = new Set()
  const sources = []
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippets.get(item.url) ? { snippet: snippets.get(item.url) } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return sources.slice(0, maxResults)
}

function domains(sources) {
  const hosts = new Set()
  for (const source of sources) {
    try { hosts.add(new URL(source.url).hostname.replace(/^www\./, '')) } catch { /* ignore */ }
  }
  return hosts.size
}

function overlap(a, b, n = 5) {
  const top = new Set(a.slice(0, n).map(source => source.url))
  return b.slice(0, n).filter(source => top.has(source.url)).length
}

function line(result) {
  if (result.error !== undefined) {
    return result.elapsed === undefined ? `unavailable — ${result.error}` : `unavailable after ${result.elapsed}ms — ${result.error}`
  }
  return `${result.elapsed}ms · ${result.sources.length} sources · ${domains(result.sources)} domains`
}

function printSources(label, result, limit = 5) {
  if (result.error !== undefined) return
  for (const [index, source] of result.sources.slice(0, limit).entries()) {
    console.log(`  ${label}${index + 1}. ${source.title ?? '(untitled)'} — ${source.url}`)
  }
}

if (process.argv.includes('--self-test')) {
  const parsed = parseDeepSeekResponse({
    content: [
      { type: 'text', citations: [{ url: 'https://a.test/x', cited_text: 'snip' }] },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test/x', title: 'A', page_age: '2026-01-01' },
          { type: 'web_search_result', url: 'https://a.test/x', title: 'dupe' },
          { type: 'web_search_result', url: 'https://b.test/y', title: 'B' },
        ],
      },
    ],
  }, 10)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].snippet, 'snip')
  assert.equal(parsed[0].publishedAt, '2026-01-01')
  assert.equal(overlap(parsed, parsed), 2)
  console.log('bench-search self-test: ok')
  process.exit(0)
}

const options = args()
const rows = []
for (const query of options.queries) {
  console.log(`\n## ${query}`)
  const result = {}
  if (options.brave) {
    result.brave = await braveSearch(query, options.max)
    console.log(`brave:    ${line(result.brave)}`)
    printSources('', result.brave)
  }
  if (options.deepseek) {
    result.deepseek = await deepseekSearch(query, options.max)
    console.log(`deepseek: ${line(result.deepseek)}`)
    printSources('', result.deepseek)
  }
  if (result.brave?.sources && result.deepseek?.sources) {
    console.log(`top-5 URL overlap: ${overlap(result.brave.sources, result.deepseek.sources)}/5`)
  }
  rows.push({ query, ...result })
}

console.log('\n## summary')
for (const row of rows) {
  const brave = row.brave === undefined ? '—' : row.brave.error !== undefined ? 'error' : `${row.brave.elapsed}ms/${domains(row.brave.sources)}d`
  const deepseek = row.deepseek === undefined ? '—' : row.deepseek.error !== undefined ? 'error' : `${row.deepseek.elapsed}ms/${domains(row.deepseek.sources)}d`
  const shared = row.brave?.sources && row.deepseek?.sources ? `${overlap(row.brave.sources, row.deepseek.sources)}/5` : '—'
  console.log(`${brave.padEnd(12)} ${deepseek.padEnd(12)} overlap ${shared.padEnd(5)} ${row.query}`)
}
