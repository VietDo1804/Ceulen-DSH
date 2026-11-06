import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentLike } from '../../core/types.js'
import { clampText } from '../../core/tools.js'
import { changelogPath, cursorPath, evoDir } from './paths.js'

const MAX_NOTICE_ITEMS = 5

export interface ChangeEntry {
  at: string
  summary: string
  detail?: string
}

export function readChanges(): ChangeEntry[] {
  try {
    return readFileSync(changelogPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          const parsed = JSON.parse(line) as ChangeEntry
          return typeof parsed.summary === 'string' && typeof parsed.at === 'string' ? [parsed] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function cursor(): string {
  try {
    const value = JSON.parse(readFileSync(cursorPath(), 'utf8')) as { at?: string }
    return typeof value.at === 'string' ? value.at : ''
  } catch {
    return ''
  }
}

export function moveCursor(at: string): void {
  mkdirSync(evoDir(), { recursive: true })
  writeFileSync(cursorPath(), JSON.stringify({ at }, null, 2))
}

/** Changes the user has not been shown yet. */
export function pendingChanges(): ChangeEntry[] {
  const seen = cursor()
  return readChanges().filter(entry => entry.at > seen)
}

export function noticeText(entries: readonly ChangeEntry[]): string {
  const shown = entries.slice(0, MAX_NOTICE_ITEMS)
  const more = entries.length - shown.length
  return [
    `💾 Self-improvement · ${entries.length} change${entries.length === 1 ? '' : 's'}${more > 0 ? ` (latest ${shown.length} shown)` : ''}`,
    '',
    ...shown.map(entry => `- ${clampText(entry.summary, 240)}${entry.detail === undefined ? '' : `\n  ${clampText(entry.detail, 400)}`}`),
    '',
    'Details: /evo-status · report: ~/.dsh/ceulen/self-evo/reports/',
  ].join('\n')
}

function noticeMessage(entries: readonly ChangeEntry[]): { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: string; form: string; summary: string } } {
  const first = entries[0]?.summary ?? 'change'
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: noticeText(entries) }],
    source: { kind: 'ceulen-evo', form: 'notice', summary: `💾 evo · ${clampText(first, 100)}` },
  }
}

/** Append the notice to the live session without waking the model. */
export function deliver(agent: AgentLike, entries: readonly ChangeEntry[]): boolean {
  if (entries.length === 0) return false
  const message = noticeMessage(entries)
  try {
    if (typeof agent.session.append === 'function') {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      return true
    }
  } catch {
    // Fall through to the inbox path.
  }
  try {
    agent.followup(message)
    return true
  } catch {
    return false
  }
}

/** Append one change to the changelog (the notice consumer moves the cursor). */
export function appendChange(summary: string, detail?: string): ChangeEntry {
  const entry: ChangeEntry = { at: new Date().toISOString(), summary, ...(detail === undefined ? {} : { detail }) }
  mkdirSync(evoDir(), { recursive: true })
  appendFileSync(changelogPath(), `${JSON.stringify(entry)}\n`)
  return entry
}
