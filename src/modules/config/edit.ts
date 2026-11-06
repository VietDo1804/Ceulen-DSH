
import { clampNumber } from './helpers.js'
import type { ConfigRow, ConfigTab, ConfigValue } from './types.js'

export function displayValue(row: ConfigRow): string {
  if (row.kind === 'toggle') return row.value === true ? 'on' : 'off'
  if (row.kind === 'secret') return String(row.value)
  if (row.kind === 'text') {
    const value = String(row.value)
    return value.length > 0 ? value : (row.placeholder ?? '(empty)')
  }
  if (row.kind === 'enum') return String(row.value)
  return String(row.value)
}

/**
 * Turn inline-editor text into a typed value. `undefined` means the draft is
 * not a value this row accepts (the editor stays open and says why).
 */
export function parseEditValue(row: ConfigRow, text: string): ConfigValue | undefined {
  if (row.kind === 'secret') return text.trim()
  if (row.kind === 'number') {
    const trimmed = text.trim()
    if (trimmed.length === 0) return undefined
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return undefined
    return clampNumber(parsed, row.min ?? -Infinity, row.max ?? Infinity)
  }
  if (row.kind === 'enum') {
    return row.values?.includes(text) === true ? text : undefined
  }
  if (row.kind === 'text') return text
  return undefined
}

/** Plain-text rendering used headlessly and by `/config show`. */
export function summaryLines(tabs: readonly ConfigTab[], settingsFile: string): string {
  const lines = [`Ceulen config — ${settingsFile}`]
  for (const tab of tabs) {
    lines.push('', `[${tab.label}]`)
    for (const section of tab.sections) {
      lines.push(`  ${section.label}`)
      for (const row of section.rows) lines.push(`    ${row.label}: ${displayValue(row)}`)
    }
  }
  lines.push(
    '',
    '/config opens the full-screen panel in the TUI; /config show prints this text.',
    'Module kill switch: /ceulen module off <name> (apply with /reload).',
  )
  return lines.join('\n')
}
