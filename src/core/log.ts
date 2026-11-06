import { appendFile, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './fsx.js'
import { logsDir } from './paths.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024

const SECRET_ENV_NAMES = [
  'MUNIN_API_KEY',
  'ROUTER_API_KEY',
  'ZAI_API_KEY',
  'ZAI_ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODE_GO_API_KEY',
  'BRAVE_API_KEY',
  'FIRECRAWL_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'DEEPSEEK_API_KEY',
] as const

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})\b/g,
]

/** Remove token-shaped strings and any live secret env values from a line. */
export function redact(text: string): string {
  let out = text
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined && value.length >= 8) out = out.split(value).join('[redacted]')
  }
  out = out.replace(TOKEN_PATTERNS[0]!, 'sk-[redacted]')
  out = out.replace(TOKEN_PATTERNS[1]!, 'gh_[redacted]')
  out = out.replace(TOKEN_PATTERNS[2]!, '$1[redacted]')
  out = out.replace(TOKEN_PATTERNS[3]!, '[redacted]')
  return out
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const info = await stat(path)
    if (info.size > MAX_LOG_BYTES) await rename(path, `${path}.1`).catch(() => undefined)
  } catch {
    // Missing log is the normal first-write case.
  }
}

/**
 * Append one line to a Ceulen log. Logging must never break a turn: every
 * failure is swallowed. Callers pass a message, never a credential.
 */
export async function appendLog(name: string, message: string): Promise<void> {
  try {
    const dir = logsDir()
    await ensureDir(dir)
    const path = join(dir, `${name}.log`)
    await rotateIfNeeded(path)
    const stamp = new Date().toISOString()
    await appendFile(path, `${stamp} ${redact(message).replace(/\n/g, '\\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Observability is best-effort.
  }
}

const inflight = new Set<Promise<void>>()

/** Fire-and-forget variant for hot paths. */
export function logLine(name: string, message: string): void {
  const write = appendLog(name, message)
  inflight.add(write)
  void write.finally(() => inflight.delete(write))
}

/**
 * Resolve once every fire-and-forget log write has landed. Tests call this
 * before deleting a temp `DSH_HOME`, so a late write cannot recreate the
 * directory mid-removal (`ENOTEMPTY`).
 */
export async function flushLogs(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight])
}

export function logJson(name: string, value: unknown): void {
  logLine(name, JSON.stringify(value))
}
