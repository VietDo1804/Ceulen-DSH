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

export function probeLedgerPath(): string {
  return join(evoDir(), 'probe-ledger.jsonl')
}

/** `YYYY-MM-DD` in UTC — the report/proposal file stamp. */
export function stamp(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}
