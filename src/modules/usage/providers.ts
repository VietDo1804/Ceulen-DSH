import { credential } from '../../core/credentials.js'

export interface UsageWindow {
  percent?: number
  remaining?: number
  remainingLabel?: string
  resetLabel?: string
}

export interface UsageAccount {
  id?: string
  isActive?: boolean
  accountLabel?: string
  plan?: string
  fiveHour?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
  monthlyCredits?: number
  creditsCurrency?: string
  mcpMonthly?: UsageWindow
  usageBreakdown?: string
  lastActivity?: string
}

export interface UsageSnapshot {
  providerDisplayName: string
  accounts: UsageAccount[]
  activeAccount?: UsageAccount
  fetchedAt: number
  error?: string
}

export interface UsageAdapter {
  id: string
  displayName: string
  fetchUsage(signal?: AbortSignal): Promise<UsageSnapshot>
}

const OPC_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const ZAI_USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'
const ZAI_CN_USAGE_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const COMMAND_CODE_USAGE_URL = 'https://api.commandcode.ai/alpha/billing/credits'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const REQUEST_TIMEOUT_MS = 7_000

export function formatRemainingTime(resetAtSec: number | undefined): string | undefined {
  if (resetAtSec === undefined || !Number.isFinite(resetAtSec)) return undefined
  const remainingSec = resetAtSec - Date.now() / 1000
  if (remainingSec <= 0) return '0M'
  const minutes = Math.ceil(remainingSec / 60)
  if (minutes < 60) return `${minutes}M`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}H`
  return `${Math.ceil(remainingSec / 86_400)}D`
}

export function formatReset(timestampSeconds: number | undefined): string | undefined {
  if (timestampSeconds === undefined || !Number.isFinite(timestampSeconds)) return undefined
  const date = new Date(timestampSeconds * 1000)
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === now.toDateString()) return time
  const day = date.toLocaleDateString(undefined, { day: 'numeric' })
  const month = date.toLocaleDateString(undefined, { month: 'short' })
  return `${time} on ${day} ${month}`
}

function windowFromPercent(percent: number | undefined, resetAtSec: number | undefined): UsageWindow | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined
  const used = Math.max(0, Math.min(100, Math.round(percent)))
  return {
    percent: used,
    remaining: 100 - used,
    remainingLabel: formatRemainingTime(resetAtSec),
    resetLabel: formatReset(resetAtSec),
  }
}

function windowFromRemaining(remainingPct: number | undefined, resetAtSec: number | undefined): UsageWindow | undefined {
  if (remainingPct === undefined || !Number.isFinite(remainingPct)) return undefined
  const remaining = Math.max(0, Math.min(100, Math.round(remainingPct)))
  return {
    percent: 100 - remaining,
    remaining,
    remainingLabel: formatRemainingTime(resetAtSec),
    resetLabel: formatReset(resetAtSec),
  }
}

function redactedError(error: unknown, provider: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/\b(?:sk-|ghp_|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .slice(0, 300)
  return `${provider}: ${cleaned}`
}

function combinedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

async function requestJson(url: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ceulen-dsh-usage/1', ...headers }, signal: combinedSignal(signal) })
  if (!response.ok) throw new Error(`usage request failed with HTTP ${response.status}`)
  return await response.json()
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return undefined
}

function keySource(refs: string[]): string {
  const resolved = credential(...refs)
  return resolved.value === undefined ? 'missing' : `${resolved.source}${resolved.ref === undefined ? '' : ` (${resolved.ref})`}`
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

export function opcWindowToUsageWindow(window: { percent?: number; resetsAt?: string } | undefined): UsageWindow | undefined {
  if (window === undefined || typeof window.percent !== 'number') return undefined
  const resetAtSec = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt) / 1000
  return windowFromPercent(window.percent, resetAtSec)
}

export const openCodeGoAdapter: UsageAdapter = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  async fetchUsage(signal) {
    try {
      const resolved = credential('OPENCODE_GO_API_KEY')
      if (resolved.value === undefined) throw new Error('missing OPENCODE_GO_API_KEY (env or DSH credential)')
      const body = (await requestJson(OPC_USAGE_URL, { Authorization: `Bearer ${resolved.value}` }, signal)) as {
        usage?: { rolling?: { percent?: number; resetsAt?: string }; weekly?: { percent?: number; resetsAt?: string }; monthly?: { percent?: number; resetsAt?: string } }
      }
      const fiveHour = opcWindowToUsageWindow(body.usage?.rolling)
      const weekly = opcWindowToUsageWindow(body.usage?.weekly)
      const monthly = opcWindowToUsageWindow(body.usage?.monthly)
      if (fiveHour === undefined && weekly === undefined && monthly === undefined) throw new Error('no usage windows in the response')
      const account: UsageAccount = {
        id: resolved.ref,
        isActive: true,
        accountLabel: keySource(['OPENCODE_GO_API_KEY']),
        plan: 'Go',
        fiveHour,
        weekly,
        monthly,
      }
      return { providerDisplayName: 'OpenCode Go', accounts: [account], activeAccount: account, fetchedAt: Date.now() }
    } catch (error) {
      return { providerDisplayName: 'OpenCode Go', accounts: [], fetchedAt: Date.now(), error: redactedError(error, 'OpenCode Go') }
    }
  },
}

// ---------------------------------------------------------------------------
// Z.AI
// ---------------------------------------------------------------------------

interface ZaiLimit {
  type?: string
  percentage?: number
  nextResetTime?: number
}

interface ZaiResponse {
  data?: { limits?: ZaiLimit[]; planName?: string; plan?: string; plan_type?: string; packageName?: string; level?: string }
  code?: number
  msg?: string
  success?: boolean
}

function zaiLimitToWindow(limit: ZaiLimit | undefined): UsageWindow | undefined {
  if (limit === undefined || typeof limit.percentage !== 'number') return undefined
  const resetAtSec = typeof limit.nextResetTime === 'number' ? limit.nextResetTime / 1000 : undefined
  return windowFromPercent(limit.percentage, resetAtSec)
}

function zaiPlan(response: ZaiResponse): string | undefined {
  const data = response.data
  return firstString(data?.planName, data?.plan, data?.plan_type, data?.packageName, data?.level)
}

function makeZaiAdapter(id: string, url: string, displayName: string, keyRefs: string[]): UsageAdapter {
  return {
    id,
    displayName,
    async fetchUsage(signal) {
      try {
        const resolved = credential(...keyRefs)
        if (resolved.value === undefined) throw new Error(`missing ${keyRefs.join(' or ')} (env or DSH credential)`)
        const body = (await requestJson(url, { Authorization: `Bearer ${resolved.value}` }, signal)) as ZaiResponse
        if ((typeof body.code === 'number' && body.code >= 400) || body.success === false || (typeof body.msg === 'string' && body.msg.length > 0 && body.success === undefined)) {
          throw new Error(`API error: ${body.msg ?? `HTTP status ${body.code ?? 'unknown'}`}`)
        }
        const limits = body.data?.limits ?? []
        const tokenLimits = limits
          .filter(limit => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT')
          .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0))
        if (tokenLimits.length === 0) throw new Error('no usage-limit entries in the response')
        const timeLimit = limits.find(limit => limit.type === 'TIME_LIMIT')
        const account: UsageAccount = {
          id: resolved.ref,
          isActive: true,
          accountLabel: keySource(keyRefs),
          plan: zaiPlan(body),
          fiveHour: zaiLimitToWindow(tokenLimits[0]),
          weekly: tokenLimits.length >= 2 ? zaiLimitToWindow(tokenLimits[1]) : undefined,
          mcpMonthly: zaiLimitToWindow(timeLimit),
        }
        return { providerDisplayName: displayName, accounts: [account], activeAccount: account, fetchedAt: Date.now() }
      } catch (error) {
        return { providerDisplayName: displayName, accounts: [], fetchedAt: Date.now(), error: redactedError(error, displayName) }
      }
    },
  }
}

export const zaiAdapter = makeZaiAdapter('zai', ZAI_USAGE_URL, 'Z.AI', ['ZAI_ANTHROPIC_API_KEY', 'ZAI_API_KEY'])
export const zaiCodingCnAdapter = makeZaiAdapter('zai-coding-cn', ZAI_CN_USAGE_URL, 'Z.AI Coding CN', ['ZAI_CODING_CN_API_KEY'])

// ---------------------------------------------------------------------------
// Command Code
// ---------------------------------------------------------------------------

interface CommandCodeWindow {
  used?: number
  cap?: number
  resetAt?: number
}

function commandCodeWindow(window: CommandCodeWindow | undefined): UsageWindow | undefined {
  if (window === undefined || typeof window.used !== 'number' || typeof window.cap !== 'number' || window.cap <= 0) return undefined
  const resetAtSec = typeof window.resetAt === 'number' ? window.resetAt / 1000 : undefined
  return windowFromPercent((window.used / window.cap) * 100, resetAtSec)
}

export const commandCodeAdapter: UsageAdapter = {
  id: 'commandcode',
  displayName: 'Command Code',
  async fetchUsage(signal) {
    try {
      const refs = ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY']
      const resolved = credential(...refs)
      if (resolved.value === undefined) throw new Error('missing COMMAND_CODE_API_KEY (env or DSH credential)')
      const body = (await requestJson(COMMAND_CODE_USAGE_URL, { Authorization: `Bearer ${resolved.value}` }, signal)) as {
        credits?: { monthlyCredits?: number }
        windowLimits?: { fiveHour?: CommandCodeWindow; weekly?: CommandCodeWindow }
      }
      const fiveHour = commandCodeWindow(body.windowLimits?.fiveHour)
      const weekly = commandCodeWindow(body.windowLimits?.weekly)
      const monthlyCredits = typeof body.credits?.monthlyCredits === 'number' ? body.credits.monthlyCredits : undefined
      const account: UsageAccount = {
        id: resolved.ref,
        isActive: true,
        accountLabel: keySource(refs),
        fiveHour,
        weekly,
        monthlyCredits,
        usageBreakdown: monthlyCredits === undefined ? undefined : `Monthly: $${monthlyCredits.toFixed(2)} remaining`,
      }
      return { providerDisplayName: 'Command Code', accounts: [account], activeAccount: account, fetchedAt: Date.now() }
    } catch (error) {
      return { providerDisplayName: 'Command Code', accounts: [], fetchedAt: Date.now(), error: redactedError(error, 'Command Code') }
    }
  },
}

// ---------------------------------------------------------------------------
// OpenAI Codex (OAuth access token from env/DSH credential)
// ---------------------------------------------------------------------------

function codexWindow(window: { used_percent?: number; reset_at?: number } | undefined): UsageWindow | undefined {
  if (window === undefined || typeof window.used_percent !== 'number') return undefined
  return windowFromPercent(window.used_percent, window.reset_at)
}

export const codexAdapter: UsageAdapter = {
  id: 'openai-codex',
  displayName: 'Codex',
  async fetchUsage(signal) {
    try {
      const token = credential('OPENAI_CODEX_ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN')
      const accountId = credential('OPENAI_CODEX_ACCOUNT_ID', 'CODEX_ACCOUNT_ID')
      if (token.value === undefined) throw new Error('missing OPENAI_CODEX_ACCESS_TOKEN (env or DSH credential)')
      const headers: Record<string, string> = { Authorization: `Bearer ${token.value}`, 'User-Agent': 'ceulen-dsh-usage/1' }
      if (accountId.value !== undefined) headers['chatgpt-account-id'] = accountId.value
      const body = (await requestJson(CODEX_USAGE_URL, headers, signal)) as {
        rate_limit?: { primary_window?: { used_percent?: number; reset_at?: number }; secondary_window?: { used_percent?: number; reset_at?: number } }
        plan_type?: string
      }
      const fiveHour = codexWindow(body.rate_limit?.primary_window)
      const weekly = codexWindow(body.rate_limit?.secondary_window)
      const account: UsageAccount = {
        id: accountId.value,
        isActive: true,
        accountLabel: 'Codex',
        plan: firstString(body.plan_type),
        fiveHour,
        weekly,
      }
      return { providerDisplayName: 'Codex', accounts: [account], activeAccount: account, fetchedAt: Date.now() }
    } catch (error) {
      return { providerDisplayName: 'Codex', accounts: [], fetchedAt: Date.now(), error: redactedError(error, 'Codex') }
    }
  },
}

// ---------------------------------------------------------------------------
// Router (generic /usage JSON)
// ---------------------------------------------------------------------------

export const routerAdapter: UsageAdapter = {
  id: 'router',
  displayName: 'Router',
  async fetchUsage(signal) {
    try {
      const base = process.env.ROUTER_BASE_URL ?? process.env.NINE_ROUTER_BASE_URL
      const key = credential('ROUTER_API_KEY', 'NINE_ROUTER_API_KEY')
      if (base === undefined || base.trim().length === 0) throw new Error('missing ROUTER_BASE_URL')
      if (key.value === undefined) throw new Error('missing ROUTER_API_KEY (env or DSH credential)')
      const tenant = base.replace(/\/$/, '')
      const body = (await requestJson(`${tenant}/usage`, { Authorization: `Bearer ${key.value}` }, signal)) as {
        windows?: Record<string, { remaining_pct?: number; reset_at?: number }>
        credits?: { balance?: number; currency?: string }
        plan?: string
      }
      const toWindow = (entry: { remaining_pct?: number; reset_at?: number } | undefined) => windowFromRemaining(entry?.remaining_pct, entry?.reset_at)
      const account: UsageAccount = {
        id: tenant,
        isActive: true,
        accountLabel: tenant.replace(/^https?:\/\//, ''),
        plan: firstString(body.plan) ?? 'Router usage',
        fiveHour: toWindow(body.windows?.session),
        weekly: toWindow(body.windows?.weekly),
        monthly: toWindow(body.windows?.monthly),
        monthlyCredits: typeof body.credits?.balance === 'number' ? body.credits.balance : undefined,
        creditsCurrency: firstString(body.credits?.currency),
      }
      if (account.fiveHour === undefined && account.weekly === undefined && account.monthly === undefined && account.monthlyCredits === undefined) {
        throw new Error('router /usage returned no windows or credits')
      }
      return { providerDisplayName: 'Router', accounts: [account], activeAccount: account, fetchedAt: Date.now() }
    } catch (error) {
      return { providerDisplayName: 'Router', accounts: [], fetchedAt: Date.now(), error: redactedError(error, 'Router') }
    }
  },
}

export const ADAPTERS: readonly UsageAdapter[] = [
  openCodeGoAdapter,
  zaiAdapter,
  zaiCodingCnAdapter,
  commandCodeAdapter,
  codexAdapter,
  routerAdapter,
]

export function adapterFor(providerId: string | undefined): UsageAdapter | undefined {
  if (providerId === undefined) return undefined
  const normalized = providerId.toLowerCase()
  if (normalized === 'opencode-go' || normalized === 'opencode') return openCodeGoAdapter
  if (normalized === 'zai' || normalized === 'zai-anthropic') return zaiAdapter
  if (normalized === 'zai-coding-cn') return zaiCodingCnAdapter
  if (normalized === 'commandcode' || normalized === 'command-code') return commandCodeAdapter
  if (normalized === 'openai-codex' || normalized === 'codex') return codexAdapter
  if (normalized === 'router') return routerAdapter
  return undefined
}

export function configuredAdapters(): UsageAdapter[] {
  return ADAPTERS.filter(adapter => {
    switch (adapter.id) {
      case 'opencode-go': return credential('OPENCODE_GO_API_KEY').value !== undefined
      case 'zai': return credential('ZAI_ANTHROPIC_API_KEY', 'ZAI_API_KEY').value !== undefined
      case 'zai-coding-cn': return credential('ZAI_CODING_CN_API_KEY').value !== undefined
      case 'commandcode': return credential('COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY').value !== undefined
      case 'openai-codex': return credential('OPENAI_CODEX_ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN').value !== undefined
      case 'router': return credential('ROUTER_API_KEY', 'NINE_ROUTER_API_KEY').value !== undefined
      default: return false
    }
  })
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatMonthlyCredits(amount: number, currency?: string): string {
  return currency === 'CNY' ? `¥${amount.toFixed(2)} CNY` : `$${amount.toFixed(2)}`
}

function formatWindow(label: string, window: UsageWindow | undefined): string | undefined {
  if (window === undefined || window.remaining === undefined) return undefined
  const reset = window.resetLabel === undefined ? '' : ` · reset ${window.resetLabel}`
  return `${label}: ${window.remaining}% remaining${reset}`
}

export function detailLines(snapshot: UsageSnapshot, options: { tokenLine?: string } = {}): string[] {
  const lines: string[] = []
  lines.push(`Usage · ${snapshot.providerDisplayName}`)
  if (snapshot.error !== undefined) {
    lines.push(`  error: ${snapshot.error}`)
  }
  const account = snapshot.activeAccount ?? snapshot.accounts[0]
  if (account !== undefined) {
    const meta = [account.plan, account.accountLabel].filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (meta.length > 0) lines.push(`  ${meta.join(' · ')}`)
    const windows = [
      formatWindow('5-hour', account.fiveHour),
      formatWindow('weekly', account.weekly),
      formatWindow('monthly', account.monthly),
      formatWindow('MCP monthly', account.mcpMonthly),
    ].filter((value): value is string => value !== undefined)
    for (const line of windows) lines.push(`  ${line}`)
    if (account.monthlyCredits !== undefined) lines.push(`  credits: ${formatMonthlyCredits(account.monthlyCredits, account.creditsCurrency)}`)
    if (account.usageBreakdown !== undefined) lines.push(`  ${account.usageBreakdown.split('\n').join('\n  ')}`)
  }
  if (options.tokenLine !== undefined) lines.push(`  ${options.tokenLine}`)
  if (snapshot.fetchedAt > 0) lines.push(`  fetched ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`)
  return lines
}

export function compactLine(snapshot: UsageSnapshot): string | undefined {
  const account = snapshot.activeAccount ?? snapshot.accounts[0]
  if (snapshot.error !== undefined && account === undefined) return `${snapshot.providerDisplayName}: unavailable`
  if (account === undefined) return undefined
  const parts: string[] = [snapshot.providerDisplayName.replace(/^OpenCode Go$/, 'Go')]
  if (account.fiveHour?.remaining !== undefined) parts.push(`5h ${account.fiveHour.remaining}%`)
  if (account.weekly?.remaining !== undefined) parts.push(`W ${account.weekly.remaining}%`)
  if (account.monthly?.remaining !== undefined) parts.push(`M ${account.monthly.remaining}%`)
  if (account.monthlyCredits !== undefined) parts.push(formatMonthlyCredits(account.monthlyCredits, account.creditsCurrency))
  if (parts.length === 1) parts.push('no windows')
  return parts.join(' · ')
}
