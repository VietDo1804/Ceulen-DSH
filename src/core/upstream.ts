import { readFileSync } from 'node:fs'
import { isNewer, pluginVersion, releaseDistTag, releaseLine, upstreamBaseVersion } from './version.js'
import { readJson, writeJsonAtomic } from './fsx.js'
import { bundleCachePath, upstreamCachePath } from './paths.js'
import { logLine } from './log.js'

export interface UpstreamRelease {
  version: string
  tag?: string
  name?: string
  url?: string
  body?: string
  publishedAt?: string
}

export interface UpstreamState {
  schemaVersion: 1
  checkedAt: string
  source: 'npm' | 'github' | 'cache' | 'fixture' | 'pinned'
  latest: string | null
  pinned: string
  behind: boolean
  release?: UpstreamRelease
  error?: string
}

export interface UpstreamDeps {
  fetcher?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

interface UpstreamLock {
  upstream?: { version?: string; commit?: string }
}

interface NpmLatest {
  version?: string
}

const NPM_LATEST = 'https://registry.npmjs.org/ceulen/latest'
const GITHUB_RELEASE = 'https://api.github.com/repos/ceulen-dev/ceulen/releases/tags/'

/** Pinned upstream version: env override, lock file, then the bundle base. */
export function readPinnedVersion(): string {
  const override = process.env.CEULEN_UPSTREAM_PINNED?.trim()
  if (override !== undefined && override.length > 0) return override
  const lock = readJsonSync<UpstreamLock>('upstream.lock.json')
  const version = lock?.upstream?.version
  if (typeof version === 'string' && version.length > 0) return version
  return upstreamBaseVersion()
}

function readJsonSync<T>(name: string): T | undefined {
  try {
    // Small build-time document; synchronous read keeps status rendering simple.
    return JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')) as T
  } catch {
    return undefined
  }
}

export async function readUpstreamCache(): Promise<UpstreamState | undefined> {
  const cached = await readJson<UpstreamState>(upstreamCachePath())
  if (cached === undefined || cached.schemaVersion !== 1) return undefined
  return cached
}

export function isCacheFresh(state: { checkedAt: string }, intervalHours: number, now = Date.now()): boolean {
  const checked = Date.parse(state.checkedAt)
  if (!Number.isFinite(checked)) return false
  return now - checked < intervalHours * 60 * 60 * 1000
}

async function fetchJson<T>(url: string, deps: UpstreamDeps, headers: Record<string, string> = {}): Promise<T> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? 5_000
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await fetcher(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'ceulen-dsh-upstream-check/1',
      ...headers,
    },
    signal,
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return (await response.json()) as T
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the latest Ceulen release. Network failures never throw: the result
 * carries the cached state (if any) plus an error string.
 */
export async function checkUpstream(
  options: { force?: boolean; offline?: boolean; intervalHours?: number } = {},
  deps: UpstreamDeps = {},
): Promise<UpstreamState> {
  const pinned = readPinnedVersion()
  const now = deps.now?.() ?? Date.now()
  const checkedAt = new Date(now).toISOString()

  const fake = process.env.CEULEN_UPSTREAM_FAKE_LATEST?.trim()
  if (fake !== undefined && fake.length > 0) {
    return {
      schemaVersion: 1,
      checkedAt,
      source: 'fixture',
      latest: fake,
      pinned,
      behind: isNewer(fake, pinned),
      release: { version: fake, tag: `v${fake}`, name: `ceulen ${fake}`, url: `https://github.com/ceulen-dev/ceulen/releases/tag/v${fake}` },
    }
  }

  const cached = await readUpstreamCache()
  if (options.offline === true) {
    if (cached !== undefined) return { ...cached, source: 'cache', error: 'offline mode' }
    return { schemaVersion: 1, checkedAt, source: 'pinned', latest: null, pinned, behind: false, error: 'offline mode and no cache' }
  }

  if (options.force !== true && cached !== undefined && isCacheFresh(cached, options.intervalHours ?? 24, now)) {
    return { ...cached, source: 'cache' }
  }

  try {
    const latestPayload = await fetchJson<NpmLatest>(NPM_LATEST, deps)
    const latest = typeof latestPayload.version === 'string' ? latestPayload.version : undefined
    if (latest === undefined || latest.length === 0) throw new Error('npm registry returned no version')

    let release: UpstreamRelease | undefined
    try {
      const gh = await fetchJson<{ tag_name?: string; name?: string; body?: string; html_url?: string; published_at?: string }>(
        `${GITHUB_RELEASE}v${latest}`,
        { ...deps, timeoutMs: Math.min(deps.timeoutMs ?? 5_000, 3_000) },
        { accept: 'application/vnd.github+json' },
      )
      release = {
        version: latest,
        tag: gh.tag_name,
        name: gh.name,
        url: gh.html_url,
        body: gh.body,
        publishedAt: gh.published_at,
      }
    } catch {
      // Release notes are optional; npm already answered the version question.
    }

    const state: UpstreamState = {
      schemaVersion: 1,
      checkedAt,
      source: 'npm',
      latest,
      pinned,
      behind: isNewer(latest, pinned),
      ...(release === undefined ? {} : { release }),
    }
    await writeJsonAtomic(upstreamCachePath(), state, 0o600).catch(() => undefined)
    return state
  } catch (error) {
    const message = errorText(error)
    logLine('upstream', `check failed: ${message}`)
    if (cached !== undefined) return { ...cached, source: 'cache', error: message }
    return { schemaVersion: 1, checkedAt, source: 'pinned', latest: null, pinned, behind: false, error: message }
  }
}

/** Cheap status read: cache only, falling back to the pinned version. */
export async function currentUpstreamState(): Promise<UpstreamState> {
  const cached = await readUpstreamCache()
  if (cached !== undefined) return cached
  const pinned = readPinnedVersion()
  return { schemaVersion: 1, checkedAt: new Date(0).toISOString(), source: 'pinned', latest: pinned, pinned, behind: false }
}

export function formatAge(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time) || time <= 0) return 'never'
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatUpstream(state: UpstreamState): string {
  const age = formatAge(state.checkedAt)
  if (state.error !== undefined && state.latest === null) return `unknown (${state.error})`
  if (state.latest === null) return `unknown (pinned ${state.pinned})`
  if (state.behind) return `update available: ceulen ${state.latest} (bundle tracks ${state.pinned})`
  if (state.error !== undefined) return `ceulen ${state.latest} (cached; check failed: ${state.error})`
  return `up to date (ceulen ${state.latest}, checked ${age})`
}

/** Status-line text; `undefined` clears the contribution. */
export function statusLine(state: UpstreamState, bundleVersion: string): string | undefined {
  if (!state.behind || state.latest === null) return undefined
  return `ceulen ${bundleVersion} · upstream ${state.latest} available`
}

/**
 * This bundle's own release channel: the `ceulen-dsh` package on npm. Installed
 * copies update with `dsh plugin add`, so the same registry answers both "is a
 * newer bundle out" and "what should the upgrade command pin".
 */
export interface BundleUpdateState {
  schemaVersion: 1
  checkedAt: string
  latest: string | null
  installed: string
  behind: boolean
  error?: string
}

const BUNDLE_LATEST = 'https://registry.npmjs.org/ceulen-dsh/latest'
const BUNDLE_DOC = 'https://registry.npmjs.org/ceulen-dsh'

interface NpmDoc {
  version?: string
  'dist-tags'?: Record<string, string>
}

export async function readBundleCache(): Promise<BundleUpdateState | undefined> {
  const cached = await readJson<BundleUpdateState>(bundleCachePath())
  if (cached === undefined || cached.schemaVersion !== 1) return undefined
  return cached
}

export async function checkBundleUpdate(
  options: { force?: boolean; offline?: boolean; intervalHours?: number } = {},
  deps: UpstreamDeps = {},
): Promise<BundleUpdateState> {
  const installed = pluginVersion()
  const now = deps.now?.() ?? Date.now()
  const checkedAt = new Date(now).toISOString()

  const fake = process.env.CEULEN_BUNDLE_FAKE_LATEST?.trim()
  if (fake !== undefined && fake.length > 0) {
    return { schemaVersion: 1, checkedAt, latest: fake, installed, behind: isNewer(fake, installed) }
  }

  const cached = await readBundleCache()
  if (options.offline === true) {
    if (cached !== undefined) return { ...cached, error: 'offline mode' }
    return { schemaVersion: 1, checkedAt, latest: null, installed, behind: false, error: 'offline mode and no cache' }
  }
  if (options.force !== true && cached !== undefined && isCacheFresh(cached, options.intervalHours ?? 24, now)) {
    return { ...cached }
  }

  try {
    // A release line follows its own npm dist-tag: `latest` may stay on the
    // previous line (0.23.0-dsh.x), so comparing against it would invent a
    // permanent "update available" for a stable line.
    const line = releaseLine()
    const distTag = releaseDistTag()
    let latest: string
    if (line !== undefined && distTag !== undefined) {
      const doc = await fetchJson<NpmDoc>(BUNDLE_DOC, deps)
      const tags = doc['dist-tags'] !== null && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : undefined
      const tagged = tags?.[distTag]
      if (typeof tagged !== 'string' || tagged.length === 0) {
        // Unknown is honest: no tag means no release on this line to compare
        // against, and the tag can appear at any moment, so do not cache it.
        const available = tags === undefined ? 'none' : Object.keys(tags).join(', ') || 'none'
        return {
          schemaVersion: 1,
          checkedAt,
          latest: null,
          installed,
          behind: false,
          error: `dist-tag "${distTag}" is missing on npm (tags: ${available})`,
        }
      }
      latest = tagged
    } else {
      const payload = await fetchJson<NpmLatest>(BUNDLE_LATEST, deps)
      latest = typeof payload.version === 'string' ? payload.version : ''
      if (latest.length === 0) throw new Error('npm registry returned no version')
    }
    const state: BundleUpdateState = { schemaVersion: 1, checkedAt, latest, installed, behind: isNewer(latest, installed) }
    await writeJsonAtomic(bundleCachePath(), state, 0o600).catch(() => undefined)
    return state
  } catch (error) {
    const message = errorText(error)
    logLine('bundle', `update check failed: ${message}`)
    if (cached !== undefined) return { ...cached, error: message }
    return { schemaVersion: 1, checkedAt, latest: null, installed, behind: false, error: message }
  }
}

/** Cheap status read: cache only, falling back to the installed version. */
export async function currentBundleUpdate(): Promise<BundleUpdateState> {
  const installed = pluginVersion()
  const cached = await readBundleCache()
  if (cached !== undefined) return cached
  return { schemaVersion: 1, checkedAt: new Date(0).toISOString(), latest: installed, installed, behind: false }
}

export function formatBundleUpdate(state: BundleUpdateState): string {
  if (state.error !== undefined && state.latest === null) return `unknown (${state.error})`
  if (state.latest === null) return 'unknown'
  if (state.behind) return `update available: ${state.latest} (installed ${state.installed})`
  if (state.error !== undefined) return `${state.latest} (cached; check failed: ${state.error})`
  return `up to date (${state.latest}, checked ${formatAge(state.checkedAt)})`
}

/** Status-line text for a newer bundle; `undefined` when current or unknown. */
export function bundleStatusLine(state: BundleUpdateState): string | undefined {
  if (!state.behind || state.latest === null) return undefined
  return `bundle ${state.latest} available`
}
