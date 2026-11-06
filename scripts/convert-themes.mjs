#!/usr/bin/env node
/**
 * Convert Ceulen's Pi theme JSON files into DSH runtime theme descriptors.
 *
 * Pi themes use `vars` plus a `colors` map with Pi-specific keys. DSH accepts a
 * base palette and a partial color map. We map the overlapping semantic keys,
 * keep empty values absent, and prefix names with `ceulen-` so they cannot
 * shadow built-ins or user themes.
 *
 * Usage: node scripts/convert-themes.mjs [--from <ceulen-root>]
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const fromIndex = args.indexOf('--from')
const from = fromIndex >= 0 ? resolve(args[fromIndex + 1]) : join(process.env.HOME ?? '', '.pi', 'agent', 'npm', 'node_modules', 'ceulen')
const themesDir = join(from, 'themes')
const out = join(root, 'src', 'themes', 'generated.ts')

if (!existsSync(themesDir)) {
  console.error(`convert-themes: no themes directory at ${themesDir}`)
  process.exit(1)
}

/** DSH key -> ordered Pi keys (first defined wins). */
const KEY_MAP = {
  accent: ['accent'],
  accentShimmer: ['borderAccent'],
  promptBorder: ['border'],
  promptBorderShimmer: ['borderMuted'],
  text: ['text'],
  inactive: ['muted'],
  subtle: ['dim'],
  success: ['success'],
  error: ['error'],
  warning: ['warning'],
  selectionBg: ['selectedBg'],
  userMessageBackground: ['userMessageBg'],
  memoryBackgroundColor: ['customMessageBg'],
  toolCardBackground: ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg'],
  toolCardBackgroundDim: ['customMessageBg'],
  toolNameMutate: ['toolTitle'],
  diffAdded: ['toolDiffAdded'],
  diffRemoved: ['toolDiffRemoved'],
  diffAddedDimmed: ['toolDiffAdded'],
  diffRemovedDimmed: ['toolDiffRemoved'],
  syntaxKeyword: ['syntaxKeyword'],
  syntaxString: ['syntaxString'],
  syntaxComment: ['syntaxComment'],
  syntaxNumber: ['syntaxNumber'],
  syntaxFunction: ['syntaxFunction'],
  syntaxType: ['syntaxType'],
  syntaxVariable: ['syntaxVariable'],
  syntaxOperator: ['syntaxOperator'],
  syntaxPunctuation: ['syntaxPunctuation'],
  syntaxConstant: ['syntaxConstant'],
  bashBorder: ['bashMode'],
  memoryBackgroundColor2: [],
}

const EXTRA_MAP = {
  mdHeading: 'text',
  mdLink: 'accent',
  mdCode: 'syntaxString',
  mdCodeBlock: 'text',
  mdCodeBlockBorder: 'promptBorder',
  mdQuote: 'subtle',
  mdQuoteBorder: 'promptBorder',
  mdHr: 'subtle',
  mdListBullet: 'accent',
  customMessageLabel: 'accent',
  toolOutput: 'subtle',
  thinkingText: 'inactive',
}

function resolveColor(value, vars) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (Object.hasOwn(vars, trimmed)) return resolveColor(vars[trimmed], vars)
  return trimmed
}

function luminance(hex) {
  if (typeof hex !== 'string') return undefined
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (match === null) return undefined
  let raw = match[1]
  if (raw.length === 3) raw = raw.split('').map(char => char + char).join('')
  const channels = [0, 2, 4].map(offset => parseInt(raw.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function convert(file, raw) {
  const vars = raw.vars && typeof raw.vars === 'object' ? raw.vars : {}
  const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : {}
  const mapped = {}
  for (const [dshKey, piKeys] of Object.entries(KEY_MAP)) {
    if (dshKey.endsWith('2')) continue
    for (const piKey of piKeys) {
      const value = resolveColor(colors[piKey], vars)
      if (value !== undefined) {
        mapped[dshKey] = value
        break
      }
    }
  }
  for (const [piKey, dshKey] of Object.entries(EXTRA_MAP)) {
    const value = resolveColor(colors[piKey], vars)
    if (value !== undefined) mapped[dshKey] = value
  }
  const explicitText = resolveColor(colors.text, vars)
  const backgroundSignal = resolveColor(colors.userMessageBg ?? colors.customMessageBg ?? colors.selectedBg, vars)
  if (mapped.text === undefined) mapped.text = explicitText ?? '#d8d8d8'
  const lum = luminance(explicitText ?? backgroundSignal)
  const ansi = /ansi/i.test(raw.name ?? file)
  const base = ansi ? 'dark-ansi' : lum !== undefined && lum > 0.55 ? 'light' : 'dark'
  const name = `ceulen-${String(raw.name ?? file.replace(/\.json$/, '')).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`
  return { name, displayName: `Ceulen · ${raw.name ?? file}`, base, colors: mapped }
}

const files = (await readdir(themesDir)).filter(file => file.endsWith('.json')).sort()
const themes = []
for (const file of files) {
  try {
    const raw = JSON.parse(await readFile(join(themesDir, file), 'utf8'))
    themes.push(convert(file, raw))
  } catch (error) {
    console.error(`skip ${file}: ${error.message}`)
  }
}

const lines = []
lines.push('/** Generated by scripts/convert-themes.mjs from Ceulen Pi themes. Do not edit. */')
lines.push('export interface BundledTheme {')
lines.push('  readonly name: string')
lines.push('  readonly displayName: string')
lines.push("  readonly base: 'light' | 'dark' | 'dark-ansi'")
lines.push('  readonly colors: Readonly<Record<string, string>>')
lines.push('}')
lines.push('')
lines.push(`export const THEMES: readonly BundledTheme[] = ${JSON.stringify(themes, null, 2)}`)
lines.push('')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, lines.join('\n'), 'utf8')
console.log(`convert-themes: ${themes.length} theme(s) -> ${out}`)
