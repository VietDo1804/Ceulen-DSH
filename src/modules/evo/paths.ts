import { join } from 'node:path'
import { ceulenHome } from '../../core/paths.js'

/** `$DSH_HOME/ceulen/self-evo` — evo runtime state (ledger, reports, notices). */
export function evoDir(): string {
  return join(ceulenHome(), 'self-evo')
}

export function reportsDir(): string {
  return join(evoDir(), 'reports')
}

export function changelogPath(): string {
  return join(evoDir(), 'changelog.jsonl')
}

export function cursorPath(): string {
  return join(evoDir(), 'notice-cursor.json')
}
