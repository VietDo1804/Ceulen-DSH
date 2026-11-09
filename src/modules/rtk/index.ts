import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, updateSettings } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe } from '../../core/tools.js'
import { compareSemver, parseSemver } from '../../core/version.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-rtk'

export const inject = ['tools', 'commands', 'systemPrompt']

const execFileAsync = promisify(execFile)
const MIN_VERSION = '0.23.0'
const TIMEOUT_MS = 2_000

interface RtkStatus {
  available: boolean
  version: string | null
  reason?: string
}

let cached: { at: number; status: RtkStatus } | undefined

async function rtkStatus(force = false): Promise<RtkStatus> {
  if (!force && cached !== undefined && Date.now() - cached.at < 30_000) return cached.status
  try {
    const { stdout } = await execFileAsync('rtk', ['--version'], { timeout: TIMEOUT_MS })
    const version = stdout.trim().split(/\s+/).at(-1) ?? stdout.trim()
    const parsed = parseSemver(version)
    if (parsed === undefined) {
      const status = { available: false, version: null, reason: `unrecognized rtk version: ${stdout.trim()}` }
      cached = { at: Date.now(), status }
      return status
    }
    const tooOld = compareSemver(version, MIN_VERSION) < 0
    const status: RtkStatus = tooOld
      ? { available: false, version, reason: `rtk ${version} is older than ${MIN_VERSION}; rtk rewrite is unavailable` }
      : { available: true, version }
    cached = { at: Date.now(), status }
    return status
  } catch {
    const status = { available: false, version: null, reason: 'rtk binary not found in PATH' }
    cached = { at: Date.now(), status }
    return status
  }
}

function isEvalCommand(command: string): boolean {
  return /(?:^|\s)(?:node|python|python3|ruby|perl|php|deno|bun|bash|sh|zsh|ksh|fish)\s+(?:-\S+\s+)*(?:-[pecrE]{1,3}|--eval|--print|-c)\b/.test(command)
}

function hasUnquotedChain(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote !== null) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '|' || char === ';' || char === '&') return true
  }
  return false
}

/** Reject rewrites that change the first word or add shell operators. */
export function isSafeRewrite(original: string, rewritten: string): boolean {
  if (isEvalCommand(original) || isEvalCommand(rewritten)) return false
  if (rewritten.includes('\n') || rewritten.includes('\r') || rewritten.includes('`') || rewritten.includes('$(')) return false
  const originalTokens = original.trim().split(/\s+/)
  const rewrittenTokens = rewritten.trim().split(/\s+/)
  const offset = rewrittenTokens[0] === 'rtk' ? 1 : 0
  if (originalTokens[0] !== rewrittenTokens[offset]) return false
  const hasOperators = /[|><;&]/.test(rewritten)
  if (hasOperators) return false
  return true
}

export interface RewriteOutcome {
  status: RtkStatus
  original: string
  rewritten: string | null
  reason?: string
}

/**
 * `--` keeps a command whose first word starts with `-` from parsing as an
 * `rtk rewrite` switch (`rtk rewrite -- ls` behaves like `rtk rewrite ls`).
 */
export function rewriteArgs(command: string): readonly string[] {
  return ['rewrite', '--', command]
}

export async function rewriteCommand(command: string): Promise<RewriteOutcome> {
  const status = await rtkStatus()
  if (!status.available) return { status, original: command, rewritten: null, reason: status.reason }
  if (command.trim().length === 0) return { status, original: command, rewritten: null, reason: 'empty command' }
  if (command.trimStart().startsWith('rtk ')) return { status, original: command, rewritten: null, reason: 'already an rtk command' }
  if (hasUnquotedChain(command)) return { status, original: command, rewritten: null, reason: 'chains and separators pass through' }
  try {
    const { stdout } = await execFileAsync('rtk', [...rewriteArgs(command)], { timeout: TIMEOUT_MS })
    const rewritten = stdout.trim()
    if (rewritten.length === 0) return { status, original: command, rewritten: null, reason: 'no rtk equivalent' }
    if (!isSafeRewrite(command, rewritten)) return { status, original: command, rewritten: null, reason: 'rtk rewrite rejected by the safety gate' }
    return { status, original: command, rewritten }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    // rtk rewrite uses 0 = no rewrite, 3 = successful rewrite, 1 = error.
    if (failure.code === 3 && typeof failure.stdout === 'string') {
      const rewritten = failure.stdout.trim()
      if (rewritten.length > 0 && isSafeRewrite(command, rewritten)) return { status, original: command, rewritten }
      return { status, original: command, rewritten: null, reason: 'rtk rewrite rejected by the safety gate' }
    }
    if (failure.code === 1) return { status, original: command, rewritten: null, reason: 'no rtk equivalent' }
    return { status, original: command, rewritten: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('rtk', settings)) return

  registerPromptSection(ctx, {
    name: 'ceulen:rtk',
    order: 110,
    text: () => loadSettingsSync().rtk.enabled
      ? 'RTK is available for commands you run for their output: git, test runners, linters, builds, docker/kubectl. For one such command, call the `rtk` tool first; if it returns a rewritten command, run that with bash. Reading, searching and listing files is not RTK work: use `read`, `grep` and `glob`, because only `read` lets `edit` and `write` accept the file. Chains, redirects, inline scripts, and unsupported commands pass through unchanged. Never claim a saving you did not measure.'
      : '',
  })

  registerToolSafe(ctx, ceulenTool({
    name: 'rtk',
    description: 'Rewrite one shell command through RTK (token-optimized output) before running it. Returns either a rewritten command to pass to bash, or a reason it passes through unchanged. This tool never executes anything. DSH does not rewrite built-in bash arguments, so this is an explicit two-step: rtk -> bash.',
    parameters: objectSchema({
      command: { type: 'string', description: 'The single shell command to rewrite.' },
    }, ['command']),
    outputSchema: { type: 'string' },
    timeoutMs: 10_000,
    concurrencySafe: true,
    async execute(raw) {
      const command = String((raw as { command?: unknown }).command ?? '')
      if (command.trim().length === 0) throw new Error('command must be non-empty')
      if (!loadSettingsSync().rtk.enabled) return 'RTK is disabled in Ceulen settings. Run the command unchanged with bash.'
      const outcome = await rewriteCommand(command)
      if (outcome.rewritten === null) {
        logLine('rtk', `pass through: ${clampText(outcome.reason ?? 'unsupported', 120)}`)
        return `Pass through unchanged: ${outcome.reason ?? 'unsupported'}.\nRun the original command with bash:\n${command}`
      }
      logLine('rtk', `rewrite: ${clampText(command, 120)} -> ${clampText(outcome.rewritten, 120)}`)
      return `Rewritten by rtk ${outcome.status.version}:\n${outcome.rewritten}\n\nRun that exact command with bash.`
    },
  }))

  registerCommandSafe(ctx, {
    name: 'rtk',
    description: 'RTK status, on/off, or a one-off rewrite',
    input: { hint: '[status|on|off|rewrite <command>|gain]' },
    async handler({ rawInput }) {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const action = args[0] ?? 'status'
      if (action === 'on' || action === 'off') {
        await updateSettings(current => {
          current.rtk.enabled = action === 'on'
        })
        cached = undefined
        return { kind: 'success', text: `RTK ${action === 'on' ? 'enabled' : 'disabled'} in Ceulen settings.` }
      }
      if (action === 'rewrite') {
        const command = args.slice(1).join(' ')
        if (command.length === 0) return { kind: 'error', text: 'usage: /rtk rewrite <command>' }
        const outcome = await rewriteCommand(command)
        return {
          kind: 'success',
          text: outcome.rewritten === null
            ? `Pass through: ${outcome.reason}\n${command}`
            : `${outcome.rewritten}`,
        }
      }
      if (action === 'gain') {
        try {
          const { stdout } = await execFileAsync('rtk', ['gain'], { timeout: 5_000 })
          return { kind: 'success', text: clampText(stdout.trim(), 4_000) }
        } catch (error) {
          return { kind: 'error', text: `rtk gain failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      if (action !== 'status') return { kind: 'error', text: 'usage: /rtk [status|on|off|rewrite <command>|gain]' }
      const status = await rtkStatus(true)
      const settingsNow = loadSettingsSync()
      return {
        kind: 'success',
        text: [
          `rtk: ${status.available ? `available ${status.version}` : `unavailable (${status.reason})`}`,
          `module: ${settingsNow.rtk.enabled ? 'enabled' : 'disabled'}`,
          'DSH does not rewrite bash arguments (by design), so the model uses the explicit rtk -> bash two-step.',
          'Supported: single git/ls/rg/test commands; chains, redirects, inline scripts pass through.',
        ].join('\n'),
      }
    },
  })
}
