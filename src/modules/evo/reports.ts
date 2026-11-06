import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampText } from '../../core/tools.js'
export { reportsDir } from './paths.js'
import { reportsDir } from './paths.js'

/** Newest promotion packet written by `evo-report.mjs --promote`. */
export function newestPacket(): { name: string; text: string } | undefined {
  let names: string[] = []
  try {
    names = readdirSync(reportsDir()).filter(name => name.startsWith('promotion-') && name.endsWith('.md')).sort()
  } catch {
    return undefined
  }
  const name = names[names.length - 1]
  if (name === undefined) return undefined
  try {
    return { name, text: readFileSync(join(reportsDir(), name), 'utf8') }
  } catch {
    return undefined
  }
}

/** Newest proposal written by `evo_pass` (the model's scoped rule lines). */
export function newestProposal(): { name: string; text: string } | undefined {
  let names: string[] = []
  try {
    names = readdirSync(reportsDir()).filter(name => name.startsWith('proposal-') && name.endsWith('.md')).sort()
  } catch {
    return undefined
  }
  const name = names[names.length - 1]
  if (name === undefined) return undefined
  try {
    return { name, text: readFileSync(join(reportsDir(), name), 'utf8') }
  } catch {
    return undefined
  }
}

export interface ProposalLine {
  scope: 'invariant' | 'domain'
  text: string
  destination: string
}

export interface ProposalReport {
  proposed: ProposalLine[]
  errors: { line: string; reason: string }[]
}

/**
 * The scope parser lives in `scripts/evo-report.mjs` (one implementation for
 * the CLI and this command); the script guards its CLI entry, so importing it
 * only exposes pure functions.
 */
export async function scopeParser(): Promise<(text: string, options?: { repoRoot?: string }) => ProposalReport> {
  const module = await import(new URL('../../../scripts/evo-report.mjs', import.meta.url).href) as {
    parseProposal(text: string, options?: { repoRoot?: string }): ProposalReport
  }
  return module.parseProposal
}

/** Group proposal lines by destination and render the reviewable block. */
export function proposalLines(report: ProposalReport): string[] {
  const groups = new Map<string, ProposalLine[]>()
  for (const item of report.proposed) {
    const list = groups.get(item.destination) ?? []
    list.push(item)
    groups.set(item.destination, list)
  }
  return [
    ...[...groups.entries()].flatMap(([destination, items]) => [
      `  ${destination} (${items.length} ${items[0]?.scope ?? 'rule'}):`,
      ...items.map(item => `    - ${clampText(item.text, 200)}`),
    ]),
    ...(report.errors.length === 0
      ? []
      : [
          `  rejected (${report.errors.length}):`,
          ...report.errors.map(error => `    - ${clampText(error.reason, 240)}: ${clampText(error.line, 160)}`),
        ]),
  ]
}

export function readProposalFile(name: string): string | undefined {
  try {
    return readFileSync(join(reportsDir(), name), 'utf8')
  } catch {
    return undefined
  }
}
