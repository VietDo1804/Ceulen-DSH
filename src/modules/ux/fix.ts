// Actionable repair for a static audit: the gate says WHAT failed, this says
// what to change it to. Deterministic — no model call, no new dependency.
//
// ponytail: keep the hue and move lightness only, by stepping HSL's L until
// the pair passes. That is the property a designer actually wants preserved
// (the colour's identity) and 100 APCA calls cost microseconds.

import { apcaContrastLc, contrastRatio, parseColor, pixelSize, SECONDARY_MIN_PX, type AuditPairResult, type Rgb } from '../../vendor/ceulen/ux/audit.js'

export interface ColourFix {
  /** Suggested replacement value. */
  color: string
  /** APCA Lc of the suggestion against the same background. */
  apca: number
  /** Existing token that already passes, when one exists. */
  token?: string
}

function rgbToHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    let x = t % 1
    if (x < 0) x += 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const channel = (t: number): number => Math.round(255 * hue(t))
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${hex(channel(h + 1 / 3))}${hex(channel(h))}${hex(channel(h - 1 / 3))}`
}

function passes(fg: string, bg: string, apcaMin: number, wcagMin: number | undefined): number | null {
  const lc = apcaContrastLc(fg, bg)
  if (lc === null) return null
  if (Math.abs(lc) < apcaMin) return null
  if (wcagMin !== undefined) {
    const ratio = contrastRatio(fg, bg)
    if (ratio === null || ratio < wcagMin) return null
  }
  return lc
}

/**
 * Nearest passing colour with the same hue and saturation: walk lightness away
 * from the background, one percent at a time, and stop at the first pass.
 */
export function suggestColour(
  fg: string,
  bg: string,
  apcaMin: number,
  wcagMin?: number,
  tokens?: Map<string, string>,
): ColourFix | null {
  if (passes(fg, bg, apcaMin, wcagMin) !== null) return null

  // Prefer a token that already passes — it belongs to the system.
  for (const [value, names] of tokens ?? []) {
    const lc = passes(value, bg, apcaMin, wcagMin)
    if (lc !== null) {
      const name = names.split(',')[0]
      if (name !== undefined) return { color: value, apca: Math.round(lc * 100) / 100, token: name }
    }
  }

  const fgRgb = parseColor(fg)
  const bgRgb = parseColor(bg)
  if (fgRgb === null || bgRgb === null) return null
  const { h, s, l } = rgbToHsl(fgRgb)
  const bgLuma = rgbToHsl(bgRgb).l
  const away = bgLuma > 0.5 ? -1 : 1
  for (let step = 1; step <= 100; step++) {
    const next = l + away * step * 0.01
    if (next < 0 || next > 1) break
    const hex = hslToHex(h, s, next)
    const lc = passes(hex, bg, apcaMin, wcagMin)
    if (lc !== null) return { color: hex, apca: Math.round(lc * 100) / 100 }
  }
  // Fall back to pure black/white — always maximal contrast, never a guess.
  for (const candidate of ['#000000', '#ffffff']) {
    const lc = passes(candidate, bg, apcaMin, wcagMin)
    if (lc !== null) return { color: candidate, apca: Math.round(lc * 100) / 100 }
  }
  return null
}

function distance(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

/** Closest system token to an off-system value (first name when several share it). */
export function nearestToken(value: string, tokens: Map<string, string>): { name: string; value: string } | null {
  const rgb = parseColor(value)
  if (rgb === null) return null
  let best: { name: string; value: string; d: number } | null = null
  for (const [candidate, names] of tokens) {
    const candidateRgb = parseColor(candidate)
    if (candidateRgb === null) continue
    const d = distance(rgb, candidateRgb)
    if (best === null || d < best.d) best = { name: names.split(',')[0] ?? candidate, value: candidate, d }
  }
  return best === null ? null : { name: best.name, value: best.value }
}

/** One line for a failed pair: what it is, what it needs, what to use. */
/** Says why a secondary pair did or did not get the relaxed bar. */
function roleNote(pair: AuditPairResult): string {
  if (pair.role !== 'secondary') return ''
  const px = pixelSize(pair.size)
  if (px === undefined) return ' (secondary needs `size`, so the body rule applies)'
  return px < SECONDARY_MIN_PX ? ` (secondary under ${SECONDARY_MIN_PX}px keeps the body rule)` : ' (secondary)'
}

export function contrastFixLine(pair: AuditPairResult, tokens?: Map<string, string>): string {
  const label = pair.label ?? `${pair.fg} on ${pair.bg}`
  const lc = pair.apca ?? '?'
  const wcag = pair.ratio === null ? 'n/a' : pair.ratio
  const wcagNeed = pair.min === undefined ? '' : `, WCAG ${wcag} need ${pair.min}`
  const fix = suggestColour(pair.effectiveFg ?? pair.fg, pair.bg, pair.apcaMin, pair.min, tokens)
  const use = fix === null
    ? 'no same-hue replacement passes — change the pairing'
    : `use ${fix.token === undefined ? fix.color : `${fix.color} (= ${fix.token})`} (Lc ${fix.apca})`
  return `${label} ${pair.fg} on ${pair.bg}: Lc ${lc}, need ${pair.apcaMin}${roleNote(pair)}${wcagNeed}. ${use}`
}
