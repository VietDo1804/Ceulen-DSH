import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { evoDir, probeLedgerPath } from './paths.js'

export interface ProbeRunEntry {
  at: string
  proposal: string
  verdict: string
  /** One probe = one id: start/result/failure entries count as one run. */
  runId?: string
  k?: number
  fixtures?: string[]
  contrast?: string
  evidence?: string
}

export function readProbeRuns(): ProbeRunEntry[] {
  try {
    return readFileSync(probeLedgerPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          const entry = JSON.parse(line) as ProbeRunEntry
          return typeof entry.at === 'string' && typeof entry.proposal === 'string' ? [entry] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function appendProbeRun(entry: ProbeRunEntry): void {
  mkdirSync(evoDir(), { recursive: true })
  appendFileSync(probeLedgerPath(), `${JSON.stringify(entry)}\n`)
}

/**
 * Real runs today, counted once per run id: a run is reserved at start (so two
 * rapid invocations cannot both pass the cap) and its result or failure lands
 * under the same id. A manual `--evidence` override does not consume budget.
 */
export function probesToday(): number {
  const today = new Date().toISOString().slice(0, 10)
  const runs = new Set<string>()
  for (const entry of readProbeRuns()) {
    if (!entry.at.startsWith(today) || entry.verdict === 'override') continue
    runs.add(entry.runId ?? `${entry.at}|${entry.proposal}`)
  }
  return runs.size
}
