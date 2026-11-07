import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { MessageLike } from '../../core/types.js'
import { clampText } from '../../core/tools.js'
import { isUserPrompt } from './transcript.js'

const execFileAsync = promisify(execFile)

const GIT_OPTIONS = { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 } as const

/** Diff pathspec excludes: lockfiles churn, secrets never belong in a review. */
const EXCLUDE_PATHSPECS = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/*.lock',
  ':(exclude,glob)**/.env*',
  ':(exclude,glob)**/*.pem',
] as const

const UNTRACKED_READ_LIMIT = 3

function toolCallArguments(value: Record<string, unknown>): Record<string, unknown> {
  let args: unknown = value.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = undefined
    }
  }
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

/** File paths this turn's edit/write/apply_patch calls touched. */
export function touchedPaths(messages: readonly MessageLike[]): string[] {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserPrompt(messages[index]!)) {
      start = index + 1
      break
    }
  }
  const paths: string[] = []
  for (const message of messages.slice(start)) {
    for (const block of message.content) {
      const value = block as unknown as Record<string, unknown>
      if (value.type !== 'tool-call') continue
      const name = String(value.name ?? '')
      const args = toolCallArguments(value)
      if (name === 'edit' || name === 'write') {
        const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined
        if (path !== undefined) paths.push(path)
      } else if (name === 'apply_patch') {
        const patch = typeof args.patch === 'string' ? args.patch : ''
        for (const line of patch.split('\n')) {
          const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())
          if (match !== null) paths.push(match[1]!.trim())
        }
      }
    }
  }
  return [...new Set(paths)]
}

function insideCwd(cwd: string, path: string): boolean {
  const absolute = resolve(cwd, path)
  if (!absolute.startsWith(cwd + sep)) return false
  return isAbsolute(absolute)
}

function isSecretPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return /^\.env/.test(base) || base.endsWith('.pem')
}

/**
 * Working-tree evidence for the reviewer: status, stat, and the diff of only
 * the files this turn touched. Old work-in-progress would raise concerns the
 * current request cannot answer, and one wrong concern costs ~7 steps.
 * Never throws; returns '' when there is nothing to show.
 */
export async function gitEvidence(
  cwd: string | undefined,
  touched: readonly string[],
  signal?: AbortSignal,
  maxChars = 6_000,
): Promise<string> {
  if (cwd === undefined || cwd.length === 0) return ''
  const run = async (args: readonly string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd,
        ...GIT_OPTIONS,
        ...(signal === undefined ? {} : { signal }),
      })
      return stdout
    } catch {
      return ''
    }
  }
  const status = clampText((await run(['status', '--short'])).trim(), 1_000)
  const stat = (await run(['diff', '--stat', 'HEAD'])).trim()
  if (status.length === 0 && stat.length === 0) return ''

  const sections: string[] = []
  if (status.length > 0) sections.push(status)
  if (stat.length > 0) sections.push(stat)

  // A pathspec outside the repo makes the whole git diff fail, so drop those
  // (and secrets) before asking for the diff at all.
  const diffable = touched.filter(path => !isSecretPath(path) && insideCwd(cwd, path))
  if (diffable.length > 0) {
    const diff = (await run(['diff', '--unified=1', 'HEAD', '--', ...diffable, ...EXCLUDE_PATHSPECS])).trim()
    if (diff.length > 0) sections.push(diff)
  }

  if (status.length > 0 && diffable.length > 0) {
    const untracked = status
      .split('\n')
      .map(line => line.startsWith('?? ') ? line.slice(3).replace(/^"|"$/g, '') : undefined)
      .filter((path): path is string => path !== undefined)
      .filter(path => diffable.includes(path) && !isSecretPath(path) && insideCwd(cwd, path))
      .slice(0, UNTRACKED_READ_LIMIT)
    const heads: string[] = []
    for (const path of untracked) {
      try {
        const lines = readFileSync(resolve(cwd, path), 'utf8').split('\n').slice(0, 40)
        heads.push(`--- new file: ${path} (first 40 lines) ---\n${lines.join('\n')}`)
      } catch {
        // Unreadable file: status already names it.
      }
    }
    if (heads.length > 0) sections.push(heads.join('\n\n'))
  }

  const body = sections.join('\n\n')
  if (body.length === 0) return ''
  return clampText(`WORKING TREE vs HEAD (evidence only; status and stat may include edits made before this turn):\n${body}`, maxChars)
}
