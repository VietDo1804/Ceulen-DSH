// Decision logic for the `notebooklm` tool call — pure, no I/O (ported from
// pi-notebooklm's extension and re-cut for notebooklm-py 0.8.x).
//
// The gates answer exactly one question each, from the argument vector alone:
//   isDestructive        → needs explicit `confirm: true`
//   requiresYesFlag      → needs a trailing --yes, otherwise the CLI can prompt
//   isBlockedInteractive → cannot run headless at all (browser login)
//   writesFiles          → must not run concurrently with another call
//
// Every scan honours Click's `--` end-of-options marker: after it, tokens are
// positional values, so `ask "--" "--help"` is a question, not a help request.

/** CLI command groups that own subcommands (`notebooklm <group> <cmd>`). */
const COMMAND_GROUPS = new Set([
  'auth', 'source', 'artifact', 'note', 'label', 'collection', 'share', 'research',
  'profile', 'agent', 'skill', 'language', 'mcp', 'generate', 'download',
])

/** Options that consume the following argument, so it is never the command path. */
const VALUE_OPTIONS = new Set([
  // global
  '--storage', '--profile', '-p', '--profile-name', '--backend',
  '--request-timeout', '--timeout', '--browser-timeout', '--browser-cookies',
  '--cdp-url', '--android-id', '--config-path', '--oauth-token', '--master-token',
  // selectors
  '-n', '--notebook', '-o', '--output', '-a', '--account', '-s', '--source',
  '--task-id', '--run-id', '--conversation-id',
  // payloads
  '--name', '--title', '--content', '--note-title', '--prompt-file', '--message',
  '--query', '--persona', '--emoji', '--label', '--type', '--format', '--mode',
  '--scope', '--permission', '--mime-type', '--path', '--paths', '--header',
  '--include-domains', '--max-sources', '--limit', '--interval', '--from', '--to',
  '--seconds', '--response-length', '--target', '--topics', '--save-as-note',
  '-t', '-c',
])

/** Exact command paths that remove, publish, or re-permission state. */
export const DESTRUCTIVE_PATHS: readonly (readonly string[])[] = [
  ['delete'], // top-level notebook delete
  ['source', 'delete'],
  ['source', 'delete-by-title'],
  ['source', 'clean'],
  ['artifact', 'delete'],
  ['note', 'delete'],
  ['label', 'delete'],
  ['label', 'remove'],
  ['collection', 'delete'],
  ['collection', 'remove'],
  ['profile', 'delete'],
  ['skill', 'uninstall'],
  ['research', 'cancel'],
  ['mcp', 'install'],
  ['share', 'remove'],
  ['share', 'public'], // privacy: expose the notebook publicly
  ['share', 'add'], // privacy: add a collaborator
  ['share', 'update'], // privacy: change a collaborator's permission
  ['share', 'view-level'], // privacy: change view access
  ['auth', 'logout'],
  ['clear'],
]

/** Commands where a flag (not a subcommand) triggers destruction. */
export const DESTRUCTIVE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  ask: ['--new'], // discards the current conversation
  history: ['--clear'],
}

/** Paths that accept --yes/-y; without it the CLI can prompt and hang. */
export const REQUIRES_YES: ReadonlySet<string> = new Set([
  'delete',
  'source.delete',
  'source.delete-by-title',
  'source.clean',
  'artifact.delete',
  'note.delete',
  'label.delete',
  'collection.delete',
  'profile.delete',
  'share.remove',
  'ask', // only meaningful with --new
])

/**
 * Destructive paths with no --yes support: they cannot hang on a prompt, so
 * `confirm: true` alone guards them. Drift-guard: every DESTRUCTIVE_PATHS entry
 * is in REQUIRES_YES or this set (see test/notebooklm.test.ts).
 */
export const CONFIRM_ONLY_PATHS: ReadonlySet<string> = new Set([
  'auth.logout',
  'skill.uninstall',
  'clear',
  'share.public',
  'share.add',
  'share.update',
  'share.view-level',
  'label.remove',
  'collection.remove',
  'research.cancel',
  'mcp.install',
])

/** Groups whose --force overwrites workspace files. Prefix-matched. */
const FILE_OVERWRITE_PATHS: readonly (readonly string[])[] = [
  ['download'],
  ['source', 'fulltext'],
  ['skill', 'install'],
]

function arraysMatch(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Split the argument vector into the command path and everything after it,
 * skipping global options (and their values) wherever they appear.
 */
export function extractCommandPath(args: readonly string[]): { path: string[]; rest: string[] } {
  const path: string[] = []
  let i = 0
  let endOfOptions = false
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') {
      endOfOptions = true
      i++
      continue
    }
    if (!endOfOptions && arg.startsWith('-')) {
      i += VALUE_OPTIONS.has(arg) ? 2 : 1
      continue
    }
    path.push(arg)
    i++
    if (path.length === 1 && COMMAND_GROUPS.has(arg)) continue
    break
  }
  return { path, rest: args.slice(i) }
}

/** True when one of `targets` appears as a real option before `--`. */
function hasRealFlag(args: readonly string[], targets: readonly string[]): boolean {
  let endOfOptions = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      endOfOptions = true
      continue
    }
    if (endOfOptions) continue
    if (targets.includes(arg)) return true
    if (VALUE_OPTIONS.has(arg)) i++
  }
  return false
}

function hasHelpFlag(args: readonly string[]): boolean {
  return hasRealFlag(args, ['--help', '-h'])
}

/** True when the call removes state, publishes, re-permissions, or overwrites files. */
export function isDestructive(args: readonly string[]): boolean {
  if (hasHelpFlag(args)) return false

  const { path } = extractCommandPath(args)
  // `source clean --dry-run` only previews.
  if (arraysMatch(path, ['source', 'clean']) && hasRealFlag(args, ['--dry-run'])) return false

  if (DESTRUCTIVE_PATHS.some(candidate => arraysMatch(path, candidate))) return true

  const flagTriggers = DESTRUCTIVE_FLAGS[path[0] ?? '']
  if (flagTriggers !== undefined && hasRealFlag(args, flagTriggers)) return true

  // NOTE: -f is --format in this CLI, not --force; only the long form counts.
  if (hasRealFlag(args, ['--force'])) {
    return FILE_OVERWRITE_PATHS.some(prefix => prefix.length <= path.length && prefix.every((part, index) => path[index] === part))
  }
  return false
}

/** True when a destructive path is missing the --yes that keeps it prompt-free. */
export function requiresYesFlag(args: readonly string[]): boolean {
  const key = extractCommandPath(args).path.join('.')
  if (!REQUIRES_YES.has(key)) return false
  if (key === 'ask' && !hasRealFlag(args, ['--new'])) return false
  return !hasRealFlag(args, ['-y', '--yes'])
}

/** True when the command cannot run without a terminal (browser login). */
export function isBlockedInteractive(args: readonly string[]): boolean {
  if (hasHelpFlag(args)) return false
  const { path } = extractCommandPath(args)
  return path[0] === 'login' || arraysMatch(path, ['auth', 'login'])
}

/** True when the command writes workspace files — serialize those calls. */
export function writesFiles(args: readonly string[]): boolean {
  const { path } = extractCommandPath(args)
  return path[0] === 'download' || arraysMatch(path, ['skill', 'install']) || arraysMatch(path, ['mcp', 'install'])
}

/**
 * The command path only, for error messages: questions, source text, emails and
 * note content never leak through a failure they had nothing to do with.
 */
export function describeCommand(args: readonly string[]): string {
  const command = extractCommandPath(args).path.join(' ')
  if (command === '') return '(no command)'
  return command.length <= 200 ? command : `${command.slice(0, 200)}… [truncated]`
}
