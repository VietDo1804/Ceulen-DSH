import { readFileSync } from 'node:fs'
import { packageFile } from './paths.js'

export type ParityStatus = 'port' | 'config' | 'partial' | 'native' | 'na' | 'deferred'

export interface ParityModule {
  name: string
  category: string
  status: ParityStatus
  dsh: string
  phase: number
  notes?: string
  /** Bundle row id when this module is mounted; absent for native/na/deferred. */
  rowId?: string
}

export interface ParityDoc {
  schemaVersion: 1
  upstream: {
    package: string
    repo: string
    version: string
    commit?: string
  }
  modules: ParityModule[]
}

const STATUS_LABELS: Record<ParityStatus, string> = {
  port: 'ported',
  config: 'native config',
  partial: 'partial',
  native: 'native DSH',
  na: 'n/a',
  deferred: 'deferred',
}

export function statusLabel(status: ParityStatus): string {
  return STATUS_LABELS[status] ?? status
}

export function loadParity(): ParityDoc {
  const raw = JSON.parse(readFileSync(packageFile('parity.json'), 'utf8')) as ParityDoc
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.modules)) throw new Error('invalid parity.json')
  return raw
}

export function isImplemented(module: ParityModule): boolean {
  return module.rowId !== undefined
}

export function summary(doc: ParityDoc): { total: number; implemented: number; ported: number; native: number; other: number } {
  let implemented = 0
  let ported = 0
  let native = 0
  let other = 0
  for (const module of doc.modules) {
    if (isImplemented(module)) implemented += 1
    if (module.status === 'port' || module.status === 'config' || module.status === 'partial') ported += 1
    else if (module.status === 'native' || module.status === 'na') native += 1
    else other += 1
  }
  return { total: doc.modules.length, implemented, ported, native, other }
}

/** Grouped status text for `/ceulen`; deliberately compact for a TUI transcript. */
export function formatParity(doc: ParityDoc, disabled: readonly string[], maxChars = 6_000): string {
  const groups = new Map<string, ParityModule[]>()
  for (const module of doc.modules) {
    const list = groups.get(module.category) ?? []
    list.push(module)
    groups.set(module.category, list)
  }
  const lines: string[] = []
  for (const [category, modules] of groups) {
    lines.push(`${category}:`)
    for (const module of modules) {
      const off = disabled.includes(module.name) ? ' (disabled)' : ''
      const mounted = isImplemented(module) ? '' : ` [${statusLabel(module.status)}]`
      lines.push(`  ${module.name.padEnd(12)} ${statusLabel(module.status).padEnd(13)}${mounted}${off}`)
    }
  }
  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… (status truncated)`
}
