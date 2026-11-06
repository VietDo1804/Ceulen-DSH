// Runtime half of the UX gate: opens the page in Chrome (via the repo's own
// CDP client) and checks what stylesheet text cannot — focus indicators by
// actually focusing, accessible names, heading order, tap targets, overflow,
// document meta, and approximate contrast against the inherited background.
//
// ponytail: reuses runInteraction from the web module's vendored CDP client.
// No Playwright, no axe-core, no new dependency.

import { runInteraction } from '../../vendor/ceulen/web/cdp.js'
import { assertCaptureScope } from '../web/index.js'

export type Severity = 'high' | 'medium' | 'low'

export interface RuntimeFinding {
  severity: Severity
  check: string
  message: string
  detail?: string
}

export interface MotionSummary {
  /** Distinct CSS animation names in use. */
  animations: number
  /** Distinct element kinds that declare a transition. */
  transitions: number
  /** Animations tied to scroll position, which have no clock to sample. */
  scrollLinked: number
}

export interface RuntimeAudit {
  url: string
  viewports: number[]
  /** Deduped across viewports; `seenAt` lists the widths where it fired. */
  findings: Array<RuntimeFinding & { seenAt: number[] }>
  /** PNG base64 for the two viewports worth showing the model. */
  shots: Array<{ width: number; base64: string }>
  /** What the stylesheets declare outside the reduced-motion fallback. */
  motion?: MotionSummary
  /** Page-load animation frames, only when `motion` was requested. */
  frames?: Array<{ at: number; base64: string }>
  /** Why no frames came back, when frames were requested. */
  framesNote?: string
  /** Set when the page could not be rendered at all (no PASS is claimed). */
  inconclusive?: string
}

const DEFAULT_VIEWPORTS = [360, 390, 768, 1024, 1440, 1920]
const HEIGHTS: Record<number, number> = { 360: 800, 390: 844, 768: 1024, 1024: 768, 1440: 900, 1920: 1080 }

/** Validates the caller's tier list: 320–3840 px, deduped, ascending, max 6. */
export function resolveViewports(input: unknown): number[] {
  if (input === undefined) return [...DEFAULT_VIEWPORTS]
  if (!Array.isArray(input) || input.length === 0) throw new Error('`viewports` must be a non-empty array of pixel widths.')
  const widths = [...new Set(input.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('`viewports` entries must be numbers.')
    const width = Math.round(value)
    if (width < 320 || width > 3840) throw new Error(`Viewport ${width} is outside 320–3840.`)
    return width
  }))].sort((a, b) => a - b)
  if (widths.length > 6) throw new Error('At most 6 viewports per run.')
  return widths
}

/**
 * Runs in the page, not in Node. `runRuntimeAudit` sends `pageChecks.toString()`
 * through CDP, so this function must stay self-contained: no imports, no
 * module-scope constants.
 */
export function pageChecks(): RuntimeFinding[] {
  const findings: RuntimeFinding[] = []
  const add = (severity: Severity, check: string, message: string, detail?: string): void => {
    findings.push(detail === undefined ? { severity, check, message } : { severity, check, message, detail })
  }
  const vw = window.innerWidth

  const docW = document.documentElement.scrollWidth
  if (docW > vw + 1) {
    const wide = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .slice(0, 5)
      .map((el) => {
        const cls = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/)[0]}` : ''
        return el.tagName.toLowerCase() + cls
      })
    add('high', 'horizontal-overflow', `page is ${docW}px wide — horizontal scroll`, wide.join(', '))
  }

  const imgs = Array.from(document.querySelectorAll('img'))
  const noAlt = imgs.filter((im) => im.getAttribute('alt') === null)
  if (noAlt.length > 0) add('high', 'img-alt', `${noAlt.length}/${imgs.length} <img> missing alt`)
  const unsized = imgs.filter((im) => !im.getAttribute('width') || !im.getAttribute('height'))
  if (unsized.length > 0) add('medium', 'unsized-media', `${unsized.length}/${imgs.length} <img> without width/height (CLS risk)`)

  const controls = Array.from(document.querySelectorAll('button, a[href]'))
  const nameless = controls.filter((el) => {
    const text = (el.textContent ?? '').trim()
    const label = el.getAttribute('aria-label') ?? el.getAttribute('title')
    const imgAlt = el.querySelector('img[alt]:not([alt=""])')
    return text === '' && !label && imgAlt === null
  })
  if (nameless.length > 0) add('high', 'accessible-name', `${nameless.length} of ${controls.length} controls have no accessible name`)

  const h1 = document.querySelectorAll('h1')
  if (h1.length === 0) add('medium', 'headings', 'no <h1> on the page')
  else if (h1.length > 1) add('low', 'headings', `${h1.length} <h1> elements (expected 1)`)

  if (document.querySelector('meta[name=viewport]') === null) add('high', 'viewport-meta', 'missing meta[name=viewport]')
  if (document.documentElement.getAttribute('lang') === null) add('medium', 'html-lang', 'missing lang attribute on <html>')

  if (vw <= 480) {
    const small = Array.from(document.querySelectorAll('a,button,[role=button],input,select')).filter((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      // WCAG 2.5.8 exempts links inline in a sentence: their size is bounded
      // by the line-height of surrounding text, not by the link.
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false
      return rect.width < 44 || rect.height < 44
    })
    if (small.length > 0) add('medium', 'tap-target', `${small.length} targets < 44x44`)
  }

  const fields = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type)
  })
  const labelTargets = new Set(Array.from(document.querySelectorAll('label[for]')).map((label) => label.getAttribute('for')))
  const unlabelled = fields.filter((el) => {
    const id = el.getAttribute('id')
    if ((id !== null && labelTargets.has(id)) || el.closest('label') !== null) return false
    const aria = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? el.getAttribute('title')
    return aria === null || aria.trim() === ''
  })
  if (unlabelled.length > 0) {
    const sample = unlabelled.slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.getAttribute('placeholder') === null ? '' : `(placeholder "${(el.getAttribute('placeholder') ?? '').slice(0, 24)}")`))
    add('medium', 'unlabelled-input', `${unlabelled.length}/${fields.length} fields have no label`, sample.join(', '))
  }

  const clippers = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4, li, td, th, label, button, a, div')).filter((el) => {
    const style = getComputedStyle(el)
    if (!/(?:hidden|clip)/.test(style.overflowX)) return false
    if ((el.textContent ?? '').trim() === '') return false
    return el.scrollWidth > el.clientWidth + 2
  })
  if (clippers.length > 0) {
    const sample = clippers.slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`)
    add('medium', 'clipped-text', `${clippers.length} element(s) clip their text`, sample.join(', '))
  }

  // Wasted space, as a lead (never high): a large block that renders nothing —
  // no text, no replaced content, no background, no border. The owner complaint
  // the deterministic gates could not see.
  const emptyBlocks = Array.from(document.querySelectorAll('main, section, div, aside, footer')).filter((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.height < 480 || rect.width < vw * 0.5) return false
    if ((el.textContent ?? '').trim() !== '') return false
    if (el.querySelector('img, svg, canvas, video, iframe, input, button, select, textarea, table, ul, ol') !== null) return false
    const style = getComputedStyle(el)
    if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') return false
    if (style.backgroundImage !== 'none') return false
    if (style.boxShadow !== 'none') return false
    const border = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const
    return border.every((side) => style[side] === '0px')
  })
  if (emptyBlocks.length > 0) {
    const tallest = emptyBlocks.reduce((max, el) => (el.getBoundingClientRect().height > max.getBoundingClientRect().height ? el : max))
    const rect = tallest.getBoundingClientRect()
    const cls = typeof tallest.className === 'string' && tallest.className.trim() !== '' ? `.${tallest.className.trim().split(/\s+/)[0]}` : ''
    add('low', 'wasted-space', `${emptyBlocks.length} block(s) over 480px tall render nothing; tallest ${Math.round(rect.height)}px`, `${tallest.tagName.toLowerCase()}${cls}`)
  }

  // This pass renders with motion reduced, so anything still running means the
  // fallback does not work; `*{animation:none}` without !important loses to any
  // class selector, and the stylesheet gate cannot see that.
  const stillMoving = document.getAnimations().filter((animation) => animation.playState === 'running')
  if (stillMoving.length > 0) add('medium', 'reduced-motion', `${stillMoving.length} animation(s) keep running with reduced motion on`, 'add !important to the fallback')

  // Wasted space between columns: a side column that stops far above its
  // neighbour leaves a hole no single element owns, so the empty-block check
  // above cannot see it. A sticky column follows the reader, so it is exempt.
  if (vw >= 768) {
    const contentBottom = (el: Element): number => {
      let bottom = 0
      for (const node of Array.from(el.querySelectorAll('*'))) {
        if (node.children.length > 0) continue
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) bottom = Math.max(bottom, rect.bottom)
      }
      return bottom === 0 ? el.getBoundingClientRect().bottom : bottom
    }
    const followsScroll = (el: Element): boolean => [el, el.firstElementChild].some((node) => node !== null && /sticky|fixed/.test(getComputedStyle(node).position))
    let holes = 0
    let worst = 0
    let worstName = ''
    for (const row of Array.from(document.querySelectorAll('main, section, div, article'))) {
      if (!/grid|flex/.test(getComputedStyle(row).display)) continue
      const columns = Array.from(row.children).filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width >= vw * 0.15 && rect.height > 0 && el.tagName !== 'NAV'
      })
      if (columns.length < 2) continue
      const longest = columns.reduce((max, el) => (contentBottom(el) > contentBottom(max) ? el : max))
      const span = longest.getBoundingClientRect()
      const end = contentBottom(longest)
      for (const column of columns) {
        if (column === longest || followsScroll(column)) continue
        const rect = column.getBoundingClientRect()
        const beside = rect.left >= span.right - 1 || rect.right <= span.left + 1
        const sameRow = rect.top < span.bottom && rect.bottom > span.top
        if (!beside || !sameRow) continue
        const gap = end - contentBottom(column)
        if (gap < 320 || gap < (end - span.top) * 0.3) continue
        holes++
        if (gap > worst) {
          worst = gap
          worstName = typeof column.className === 'string' && column.className.trim() !== '' ? `.${column.className.trim().split(/\s+/)[0]}` : column.tagName.toLowerCase()
        }
      }
    }
    if (holes > 0) add('low', 'uneven-columns', `${holes} column(s) end far above their neighbour; largest gap ${Math.round(worst)}px`, `${worstName}: rebalance the columns or make it sticky`)
  }

  const focusables = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    // A control the user cannot focus legitimately shows no focus ring.
    if ((el as HTMLInputElement).disabled) return false
    return el.getAttribute('aria-disabled') !== 'true'
  }).slice(0, 25)
  let noFocus = 0
  for (const el of focusables) {
    ;(el as HTMLElement).focus()
    const style = getComputedStyle(el)
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    const shadow = style.boxShadow !== '' && style.boxShadow !== 'none'
    if (!outline && !shadow) noFocus++
    ;(el as HTMLElement).blur()
  }
  if (noFocus > 0) add('high', 'focus-visible', `${noFocus}/${focusables.length} sampled controls show no focus indicator`)

  const toRgb = (value: string): { r: number; g: number; b: number; a: number } | null => {
    const match = value === '' ? null : value.match(/rgba?\(([^)]+)\)/)
    if (match === null || match[1] === undefined) return null
    const parts = match[1].split(',').map((part) => parseFloat(part))
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] === undefined ? 1 : parts[3]! }
  }
  const luminance = (color: { r: number; g: number; b: number }): number => {
    const channel = (value: number): number => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const ratioOf = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
    const x = luminance(a)
    const y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const backgroundOf = (el: Element): { r: number; g: number; b: number; a: number } => {
    let node: Element | null = el
    while (node !== null) {
      const color = toRgb(getComputedStyle(node).backgroundColor)
      if (color !== null && color.a !== 0) return color
      node = node.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  let lowContrast = 0
  let sample = ''
  const textEls = Array.from(document.querySelectorAll('p,span,a,li,h1,h2,h3,h4,button,label,td'))
    // Decorative type (aria-hidden) is atmosphere; judging it as copy is noise.
    .filter((el) => (el.textContent ?? '').trim().length > 1 && (el as HTMLElement).offsetParent !== null && el.closest('[aria-hidden="true"]') === null)
    .slice(0, 120)
  for (const el of textEls) {
    const style = getComputedStyle(el)
    const fg = toRgb(style.color)
    if (fg === null) continue
    const size = parseFloat(style.fontSize)
    const bold = parseInt(style.fontWeight, 10) >= 700
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
    const ratio = ratioOf(fg, backgroundOf(el))
    if (ratio < need - 0.05) {
      lowContrast++
      if (sample === '') sample = `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className : ''} ${ratio.toFixed(2)}:1, need ${need}`
    }
  }
  if (lowContrast > 0) add('medium', 'contrast', `${lowContrast}/${textEls.length} sampled text nodes below AA`, sample)

  // A value the page failed to format reads as data, so nothing else flags it.
  // "undefined" is an ordinary word in a sentence, so only short text counts.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const broken = new Set<string>()
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').trim()
    const parent = node.parentElement
    if (text === '' || parent === null || parent.closest('script, style, code, pre, kbd, samp, noscript') !== null) continue
    if (text.includes('[object Object]') || (text.length <= 40 && /(^|[^\w])(NaN|undefined)($|[^\w])/.test(text))) broken.add(text.slice(0, 60))
  }
  if (broken.size > 0) add('high', 'broken-text', `${broken.size} text value(s) failed to format`, [...broken].slice(0, 3).join(' | '))

  return findings
}

/** The colours a page really shows, by how much of it they cover. */
export function paletteChecks(): Array<{ hex: string; share: number; kind: 'surface' | 'text' }> {
  const hexOf = (value: string): string | null => {
    const parts = /^rgba?\(([^)]+)\)$/.exec(value)?.[1]?.split(/[,\s/]+/).filter((part) => part !== '').map(Number)
    if (parts === undefined || parts.length < 3 || (parts[3] ?? 1) < 1) return null
    return `#${parts.slice(0, 3).map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`
  }
  const page = Math.max(document.documentElement.scrollWidth * document.documentElement.scrollHeight, 1)
  const surfaces = new Map<string, number>()
  const inks = new Map<string, number>()
  let letters = 0
  for (const el of [document.documentElement, ...document.body.querySelectorAll('*'), document.body]) {
    if (el.closest('svg, script, style') !== null) continue
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const surface = hexOf(style.backgroundColor)
    if (surface !== null) surfaces.set(surface, (surfaces.get(surface) ?? 0) + box.width * box.height)
    const own = [...el.childNodes].reduce((sum, node) => sum + (node.nodeType === Node.TEXT_NODE ? (node.nodeValue ?? '').trim().length : 0), 0)
    const ink = hexOf(style.color)
    if (own > 0 && ink !== null && box.width > 0) {
      inks.set(ink, (inks.get(ink) ?? 0) + own)
      letters += own
    }
  }
  return [
    ...[...surfaces].map(([hex, area]) => ({ hex, share: Math.min(area / page, 1), kind: 'surface' as const })),
    ...[...inks].map(([hex, count]) => ({ hex, share: count / Math.max(letters, 1), kind: 'text' as const })),
  ]
}

/** Colours covering a real part of the page that are nowhere near DESIGN.md. */
export function offPalette(shown: ReturnType<typeof paletteChecks>, design: string): string[] {
  const rgb = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  const allowed = [...new Set([...design.matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase()))].map(rgb)
  if (allowed.length < 3) return []
  const near = (hex: string): boolean => allowed.some((colour) => Math.hypot(...rgb(hex).map((part, i) => part - colour[i]!)) <= 14)
  return shown
    .filter((item) => item.share >= (item.kind === 'surface' ? 0.05 : 0.03) && !near(item.hex))
    .sort((a, b) => b.share - a.share)
    .slice(0, 5)
    .map((item) => `${item.hex} (${item.kind}, ${Math.round(item.share * 100)}%)`)
}

/**
 * Runs in the page, like pageChecks, so it must stay self-contained. Reads
 * computed styles, not stylesheet rules: Chrome throws SecurityError on
 * `sheet.cssRules` for an external stylesheet opened over file://, which would
 * report a page full of motion as static. Needs a load with motion on, so the
 * reduced-motion fallback does not hide what it is meant to measure.
 */
export function motionChecks(): { findings: RuntimeFinding[]; animations: number; transitions: number; scrollLinked: number } {
  const findings: RuntimeFinding[] = []
  const layout = /^(top|left|right|bottom|width|height|min-|max-|margin|padding|font-size|line-height|gap|grid|flex)/
  const seconds = (value: string): number => Math.max(0, ...value.split(',').map((part) => {
    const amount = parseFloat(part)
    if (Number.isNaN(amount)) return 0
    return part.trim().endsWith('ms') ? amount / 1000 : amount
  }))
  const nameOf = (el: Element): string => {
    const cls = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/)[0]}` : ''
    return el.tagName.toLowerCase() + cls
  }
  const names = new Set<string>()
  const moving = new Set<string>()
  const janky = new Set<string>()
  const slow = new Set<string>()
  for (const el of Array.from(document.querySelectorAll('body, body *')).slice(0, 4000)) {
    const style = getComputedStyle(el)
    if (style.transitionProperty !== 'none' && seconds(style.transitionDuration) > 0) {
      const name = nameOf(el)
      moving.add(name)
      const moved = style.transitionProperty.split(',').map((part) => part.trim()).filter((part) => part === 'all' || layout.test(part))
      // A skip link slides in from off-screen on purpose, once, on focus.
      if (moved.length > 0 && !/skip/i.test(name)) janky.add(`${name} (${moved.join(', ')})`)
      if (seconds(style.transitionDuration) > 1.2) slow.add(name)
    }
    if (style.animationName !== 'none') {
      for (const name of style.animationName.split(',')) names.add(name.trim())
      if (style.animationIterationCount !== 'infinite' && seconds(style.animationDuration) > 1.2) slow.add(nameOf(el))
    }
  }
  for (const animation of document.getAnimations()) {
    const label = (animation as Animation & { animationName?: string }).animationName
    if (label === undefined) continue
    const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
    const props = frames.flatMap((frame) => Object.keys(frame)).map((prop) => prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))
    const moved = [...new Set(props.filter((prop) => layout.test(prop)))]
    if (moved.length > 0) janky.add(`@keyframes ${label} (${moved.join(', ')})`)
  }
  // Every other pass renders with motion off, so an element sliding past the
  // edge only shows here: sample the timeline and measure the page at each point.
  // Scroll-driven animations have no clock, and setting currentTime on one throws.
  const all = document.getAnimations()
  const running = all.filter((animation) => animation.timeline === document.timeline)
  const ends = running.map((animation) => animation.effect?.getComputedTiming().endTime).filter((end): end is number => typeof end === 'number' && Number.isFinite(end))
  const span = Math.min(ends.length === 0 ? 1000 : Math.max(...ends), 4000)
  let widest = 0
  for (const animation of running) animation.pause()
  for (const fraction of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
    for (const animation of running) animation.currentTime = span * fraction
    widest = Math.max(widest, document.documentElement.scrollWidth)
  }
  // Left at the end, a `backwards` animation stops being listed, and the frames need it.
  for (const animation of running) animation.currentTime = 0
  if (widest > window.innerWidth + 1) findings.push({ severity: 'medium', check: 'motion-overflow', message: `page grows to ${widest}px wide while animating: clip the moving element's parent` })
  if (janky.size > 0) findings.push({ severity: 'low', check: 'motion-layout', message: `${janky.size} kind(s) of element animate layout properties, which can stutter: use transform and opacity`, detail: [...janky].slice(0, 3).join('; ') })
  if (slow.size > 0) findings.push({ severity: 'low', check: 'motion-slow', message: `${slow.size} animation(s) run longer than 1.2s, which feels sluggish`, detail: [...slow].slice(0, 3).join(', ') })
  return { findings, animations: names.size, transitions: moving.size, scrollLinked: all.length - running.length }
}

/**
 * What only shows with motion on and a reader scrolling: list items that arrive
 * as they come in. Runs last, after the frames, because it scrolls.
 */
export async function arrivalChecks(): Promise<{ findings: RuntimeFinding[]; items: number; arrived: number }> {
  const findings: RuntimeFinding[] = []
  const root = document.documentElement
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  let items: Element[] = []
  if (root.scrollHeight >= window.innerHeight * 2) {
    for (const parent of Array.from(document.querySelectorAll('body *')).slice(0, 4000)) {
      if (parent.children.length < 6 || parent.closest('nav, select, svg') !== null) continue
      const kids = Array.from(parent.children).filter((kid) => {
        const box = kid.getBoundingClientRect()
        return kid.tagName === parent.children[0]?.tagName && box.height >= 24 && box.top + window.scrollY >= window.innerHeight
      })
      if (kids.length >= 6 && kids.length > items.length) items = kids
    }
  }
  const arrived = new Set<Element>()
  if (items.length > 0) {
    const limit = root.scrollHeight - window.innerHeight
    for (let top = 0, steps = 0; top <= limit + 200 && steps < 120; top += 200, steps++) {
      window.scrollTo({ top, behavior: 'instant' })
      await wait(60)
      for (const item of items) {
        const box = item.getBoundingClientRect()
        if (box.bottom <= 0 || box.top >= window.innerHeight) continue
        const moving = item.getAnimations({ subtree: true }).some((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        if (moving || Number(getComputedStyle(item).opacity) < 0.98) arrived.add(item)
      }
    }
    if (arrived.size < items.length / 2) {
      findings.push({ severity: 'low', check: 'motion-arrival', message: `only ${arrived.size} of ${items.length} list items move as they scroll in, so the page goes still below the first screen`, detail: 'put data-arrive on each item (motion kit, references/motion.md in ux-design)' })
    }
  }
  return { findings, items: items.length, arrived: arrived.size }
}

/**
 * Time labels on a drawn chart must agree with each other, and a peak named in
 * the text must sit on the line. No label is trusted alone: the fit that most
 * labels agree on decides. Edges use offsetWidth, because a mark frozen at the
 * start of its arrival is scaled down around its centre.
 */
export function chartChecks(): { findings: RuntimeFinding[] } {
  const findings: RuntimeFinding[] = []
  const clockOf = (hours: string, minutes: string): string => `${hours.padStart(2, '0')}:${minutes}`
  for (const svg of document.querySelectorAll<SVGSVGElement>('svg[data-draw]')) {
    const box = svg.getBoundingClientRect()
    const holder = svg.parentElement
    if (box.width === 0 || holder === null) continue
    const unplaced = [...holder.querySelectorAll<HTMLElement>('[data-time]:not(.m-timed)')].map((el) => el.dataset.time)
    if (unplaced.length > 0) {
      findings.push({
        severity: 'high',
        check: 'chart-time',
        message: `Chart labels were not placed, so they are missing or in the wrong spot: ${unplaced.join(', ')}`,
        detail: 'Each data-time must fall between data-start and data-end on the svg, in the same format, and the page must load motion.js.',
      })
    }
    const labels: Array<{ text: string; at: number; spots: number[] }> = []
    for (const el of holder.querySelectorAll('*')) {
      if (el.children.length > 0 || el.matches('desc, title')) continue
      const match = /^(\d{1,2}):(\d{2})\b/.exec((el.textContent ?? '').trim())
      const rect = el.getBoundingClientRect()
      if (match === null || rect.width === 0 || rect.bottom < box.top - 48 || rect.top > box.bottom + 48) continue
      const centre = (rect.left + rect.right) / 2 - box.left
      const half = (el instanceof HTMLElement ? el.offsetWidth : rect.width) / 2
      labels.push({ text: clockOf(match[1]!, match[2]!), at: Number(match[1]) * 60 + Number(match[2]), spots: [centre, centre - half, centre + half] })
    }
    if (labels.length < 3) continue
    labels.sort((a, b) => a.spots[0]! - b.spots[0]!)
    for (let i = 1; i < labels.length; i++) if (labels[i]!.at < labels[i - 1]!.at - 720) labels[i]!.at += 1440

    const tolerance = box.width * 0.025
    let best = { fits: 0, miss: Infinity, slope: 0, x: 0, at: 0 }
    for (const first of labels) {
      for (const second of labels) {
        if (second.at <= first.at) continue
        for (const x of first.spots) {
          for (const y of second.spots) {
            const slope = (y - x) / (second.at - first.at)
            if (slope <= 0) continue
            let fits = 0
            let miss = 0
            for (const label of labels) {
              const gap = Math.min(...label.spots.map((spot) => Math.abs(spot - (x + slope * (label.at - first.at)))))
              if (gap <= tolerance) fits++
              miss += Math.min(gap, tolerance)
            }
            if (fits > best.fits || (fits === best.fits && miss < best.miss)) best = { fits, miss, slope, x, at: first.at }
          }
        }
      }
    }
    if (best.fits < 2) continue
    const xOf = (at: number): number => best.x + best.slope * (at - best.at)
    const off = labels.filter((label) => Math.min(...label.spots.map((spot) => Math.abs(spot - xOf(label.at)))) > tolerance)
    if (off.length > 0) {
      const worst = off.map((label) => `${label.text} is ${Math.round(Math.abs(label.spots[0]! - xOf(label.at)) / box.width * 100)}% of the width off`)
      findings.push({
        severity: 'high',
        check: 'chart-time',
        message: `Chart time labels do not match the line: ${worst.join(', ')}`,
        detail: 'Do not place them by hand: put data-start and data-end on the svg and data-time on each label, and the motion kit places them.',
      })
    }

    const scope = svg.closest<HTMLElement>('section, article, figure') ?? holder
    const said = /\bpeak\w*\b[\s\S]{0,40}?\b(\d{1,2}):(\d{2})\b/i.exec(scope.innerText)
    const line = svg.querySelector<SVGGeometryElement>('[data-line]') ?? svg.querySelector<SVGGeometryElement>('path, polyline')
    const matrix = svg.getScreenCTM()
    if (said === null || line === null || matrix === null) continue
    const points = Array.from({ length: 400 }, (_, i) => line.getPointAtLength(line.getTotalLength() * i / 399))
    const top = points.reduce((low, point) => (point.y < low.y ? point : low))
    const bottom = Math.max(...points.map((point) => point.y))
    let claimed = Number(said[1]) * 60 + Number(said[2])
    if (claimed < labels[0]!.at - 720) claimed += 1440
    const claimedX = (xOf(claimed) + box.left - matrix.e) / matrix.a
    const reach = tolerance / matrix.a
    const there = Math.min(...points.filter((point) => Math.abs(point.x - claimedX) <= reach).map((point) => point.y), bottom)
    if (there - top.y > (bottom - top.y) * 0.05) {
      const at = Math.round(best.at + ((matrix.a * top.x + matrix.e - box.left) - best.x) / best.slope) % 1440
      // Labels that disagree give no clock worth repeating, so name a time only when they agree.
      const peak = off.length > 0 ? 'the line is not at its top there' : `the line peaks near ${clockOf(String(Math.floor(at / 60)), String(at % 60).padStart(2, '0'))}`
      findings.push({
        severity: 'high',
        check: 'chart-peak',
        message: `The text puts the peak at ${clockOf(said[1]!, said[2]!)}, but ${peak}`,
        detail: 'Read the time off the series and put that in the text.',
      })
    }
  }
  return { findings }
}

/** Freezes every running animation at its start and reports the timeline. */
/**
 * An app paints after load, so a check that runs at load reads an empty page and
 * reports what is missing from it. Waits for visible text, then for the page to
 * stop changing for `quietMs`, capped so a live page cannot hold the audit. A
 * page with no scripts has nothing to wait for.
 */
export const settleStep = (quietMs: number): string => `new Promise((done) => {
  if (document.scripts.length === 0) { done(true); return }
  let timer = 0
  const hasText = () => document.body !== null && document.body.innerText.trim() !== ''
  const finish = () => { watcher.disconnect(); clearTimeout(cap); clearTimeout(timer); done(true) }
  const arm = () => { clearTimeout(timer); if (hasText()) timer = setTimeout(finish, ${quietMs}) }
  const watcher = new MutationObserver(arm)
  const cap = setTimeout(finish, 4000)
  watcher.observe(document.documentElement, { childList: true, subtree: true })
  arm()
})`

const FREEZE_STEP = `(() => {
  const list = document.getAnimations().filter((animation) => animation.timeline === document.timeline);
  list.forEach((animation) => animation.pause());
  window.__uxFrames = list;
  const ends = list.map((animation) => animation.effect?.getComputedTiming().endTime).filter((end) => Number.isFinite(end));
  const end = Math.round(Math.min(ends.length === 0 ? 1000 : Math.max(...ends), 1500));
  list.forEach((animation) => { animation.currentTime = 0; });
  return { count: list.length, end };
})()`

const seekStep = (fraction: number): string => `(() => {
  const list = window.__uxFrames ?? [];
  const ends = list.map((animation) => animation.effect?.getComputedTiming().endTime).filter((end) => Number.isFinite(end));
  const end = Math.min(ends.length === 0 ? 1000 : Math.max(...ends), 1500);
  list.forEach((animation) => { animation.currentTime = end * ${fraction}; });
  return true;
})()`

const FRAME_VIEWPORT = { width: 1280, height: 800 }

interface MotionPass extends Pick<RuntimeAudit, 'frames' | 'framesNote'> {
  palette?: ReturnType<typeof paletteChecks>
  summary?: MotionSummary
  findings: RuntimeFinding[]
}

/**
 * One load with motion on, for the checks and, when asked, the filmstrip.
 * Seeking through the Web Animations API makes the frames exact on any machine,
 * where a wall-clock capture would race the load. CSS and WAAPI only:
 * requestAnimationFrame motion cannot be frozen. Advisory, so a failure here
 * must not cost the audit the findings it already has.
 */
async function motionPass(url: string, wantFrames: boolean, signal?: AbortSignal): Promise<MotionPass> {
  const fractions = [0, 0.4, 1]
  const frameSteps = [
    { evaluate: FREEZE_STEP, label: 'freeze' },
    { screenshot: true as const, label: 'frame-start' },
    { evaluate: seekStep(fractions[1]!), label: 'seek-middle' },
    { screenshot: true as const, label: 'frame-middle' },
    { evaluate: seekStep(fractions[2]!), label: 'seek-end' },
    { screenshot: true as const, label: 'frame-end' },
  ]
  try {
    const result = await runInteraction({
      url,
      viewport: FRAME_VIEWPORT,
      steps: [
        // Text only, not quiet: a page's load animation must still be running for the frames.
        { evaluate: settleStep(0), label: 'first-text' },
        { evaluate: `(${motionChecks.toString()})()`, label: 'motion' },
        ...(wantFrames ? frameSteps : []),
        { evaluate: settleStep(500), label: 'settle' },
        { evaluate: `(${paletteChecks.toString()})()`, label: 'palette' },
        { evaluate: `(${chartChecks.toString()})()`, label: 'charts' },
        { evaluate: `(${arrivalChecks.toString()})()`, label: 'arrivals' },
      ],
      stepTimeoutMs: 30_000,
      signal,
    })
    const checked = result.outcomes[1]?.value as ReturnType<typeof motionChecks> | undefined
    const arrivals = result.outcomes.at(-1)?.value as Awaited<ReturnType<typeof arrivalChecks>> | undefined
    const charts = result.outcomes.at(-2)?.value as ReturnType<typeof chartChecks> | undefined
    const palette = result.outcomes.at(-3)?.value as ReturnType<typeof paletteChecks> | undefined
    const base = {
      findings: [...(checked?.findings ?? []), ...(charts?.findings ?? []), ...(arrivals?.findings ?? [])],
      palette: palette ?? [],
      ...(checked === undefined ? {} : { summary: { animations: checked.animations, transitions: checked.transitions, scrollLinked: checked.scrollLinked } }),
    }
    if (checked === undefined) {
      const reason = result.outcomes[1]?.error ?? 'the page did not answer'
      return { ...base, ...(wantFrames ? { frames: [] } : {}), framesNote: `motion checks did not run: ${reason.slice(0, 160)}` }
    }
    if (!wantFrames) return base
    const timeline = result.outcomes[2]?.value as { count?: number; end?: number } | undefined
    if (timeline?.count === undefined || timeline.count === 0) {
      return { ...base, frames: [], framesNote: 'no CSS or Web Animations motion was running at page load, so there is nothing to film' }
    }
    const end = timeline.end ?? 0
    const images = result.outcomes.filter((outcome) => outcome.image !== undefined).map((outcome) => outcome.image!)
    return { ...base, frames: images.map((base64, index) => ({ at: Math.round(end * (fractions[index] ?? 1)), base64 })) }
  } catch (error) {
    const framesNote = `frames unavailable: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`
    return { findings: [], ...(wantFrames ? { frames: [] } : {}), framesNote }
  }
}

/** The two widths a model should actually look at: smallest phone, widest ≤1440. */
export function screenshotWidths(viewports: number[]): number[] {
  const small = viewports.find((width) => width <= 480)
  const wide = [...viewports].reverse().find((width) => width <= 1440)
  const picked = [small, wide].filter((width): width is number => width !== undefined)
  return [...new Set(picked)]
}

// Scroll-reveal content sits at opacity:0 until observed, so capture it only
// after a pass to the bottom; return to the top so the shot is the real page.
export const SCROLL_STEP = `(async () => {
  const step = window.innerHeight;
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  window.scrollTo(0, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return true;
})()`

/** Opens the page at every tier and merges identical findings across widths. */
export async function runRuntimeAudit(options: { url: string; cwd: string; viewports?: number[]; motion?: boolean; design?: string; signal?: AbortSignal }): Promise<RuntimeAudit> {
  assertCaptureScope(options.url, options.cwd)
  const viewports = resolveViewports(options.viewports)
  const merged = new Map<string, RuntimeFinding & { seenAt: number[] }>()
  const shots: Array<{ width: number; base64: string }> = []
  const wanted = new Set(screenshotWidths(viewports))

  for (const width of viewports) {
    let result: Awaited<ReturnType<typeof runInteraction>>
    try {
      result = await runInteraction({
        url: options.url,
        viewport: { width, height: HEIGHTS[width] ?? 900 },
        reducedMotion: true,
        steps: [
          { evaluate: settleStep(500), label: `settle@${width}` },
          { evaluate: SCROLL_STEP, label: `scroll@${width}` },
          { evaluate: `(${pageChecks.toString()})()`, label: `checks@${width}` },
        ],
        waitForSec: 0.25,
        stepTimeoutMs: 30_000,
        signal: options.signal,
      })
    } catch (error) {
      // No browser is an INCOMPLETE audit, never a passing one.
      const message = error instanceof Error ? error.message : String(error)
      if (/No local Chrome|DevTools websocket|Failed to launch|spawn /i.test(message)) {
        return { url: options.url, viewports, findings: [], shots: [], inconclusive: message }
      }
      throw error
    }
    const step = result.outcomes[2]
    if (step === undefined || !step.ok) {
      throw new Error(`Runtime check failed at ${width}px: ${step?.error ?? 'no result returned'}`)
    }
    const found = Array.isArray(step.value) ? (step.value as RuntimeFinding[]) : []
    for (const finding of found) {
      const key = `${finding.check}|${finding.message}`
      const hit = merged.get(key)
      if (hit === undefined) merged.set(key, { ...finding, seenAt: [width] })
      else hit.seenAt.push(width)
    }
    for (const message of result.consoleErrors ?? []) {
      const key = `console-error|${message}`
      const hit = merged.get(key)
      if (hit === undefined) merged.set(key, { severity: 'medium', check: 'console-error', message, seenAt: [width] })
      else hit.seenAt.push(width)
    }
    if (wanted.has(width) && result.screenshot !== undefined) shots.push({ width, base64: result.screenshot })
  }

  const pass = await motionPass(options.url, options.motion === true, options.signal)
  for (const finding of pass.findings) merged.set(`${finding.check}|${finding.message}`, { ...finding, seenAt: [FRAME_VIEWPORT.width] })
  const off = options.design === undefined ? [] : offPalette(pass.palette ?? [], options.design)
  if (off.length > 0) {
    merged.set('off-palette', {
      severity: 'high',
      check: 'off-palette',
      message: `This page uses colours that are not in DESIGN.md: ${off.join(', ')}`,
      detail: 'Use the tokens in DESIGN.md, and its status colours for a colorful page. A concept keeps them too. Do not finish with this finding unless the request contains the words "new identity", "rebrand", or "ignore DESIGN.md". "Premium", "colors", and "attractive" do not count.',
      seenAt: [FRAME_VIEWPORT.width],
    })
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  const findings = [...merged.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check))
  return {
    url: options.url,
    viewports,
    findings,
    shots,
    ...(pass.summary === undefined ? {} : { motion: pass.summary }),
    ...(pass.frames === undefined ? {} : { frames: pass.frames }),
    ...(pass.framesNote === undefined ? {} : { framesNote: pass.framesNote }),
  }
}

function motionLine(audit: RuntimeAudit): string | undefined {
  if (audit.motion === undefined) return undefined
  const { animations, transitions, scrollLinked } = audit.motion
  if (animations === 0 && transitions === 0 && scrollLinked === 0) return 'motion: none. The page is static: add its motion moment (see references/motion.md in ux-design).'
  const plan = animations === 0 ? ' No load or reveal moment yet.' : ''
  const next = audit.frames === undefined
    ? 'add `motion: true` for load frames, then look.'
    : 'look at the load frames, then check scroll and filters with web_interact.'
  const scroll = scrollLinked === 0 ? '' : `, ${scrollLinked} scroll-linked`
  return `motion: ${animations} animation(s), ${transitions} element kind(s) with transitions${scroll}.${plan} Smoothness is not measured here: ${next}`
}

export function formatRuntimeReport(audit: RuntimeAudit): string {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const finding of audit.findings) counts[finding.severity]++
  const total = audit.findings.length
  const tiers = audit.viewports.join('/')
  const lines: string[] = []
  if (audit.inconclusive !== undefined) {
    lines.push(`UX runtime audit: INCOMPLETE — the page could not be rendered at ${tiers}, so nothing was checked and no PASS is claimed.`)
    lines.push(`reason: ${audit.inconclusive.slice(0, 200)}`)
  } else if (total === 0) {
    lines.push(`UX runtime audit: PASS — no findings at ${tiers}`)
  } else {
    lines.push(`UX runtime audit: FAIL — ${counts.high} high · ${counts.medium} medium · ${counts.low} low (viewports ${tiers})`)
    for (const finding of audit.findings) {
      const detail = finding.detail === undefined || finding.detail === '' ? '' : ` (${finding.detail})`
      lines.push(`${finding.severity.padEnd(6)} ${finding.check} — ${finding.message}${detail} [${finding.seenAt.join(', ')}]`)
    }
  }
  const motion = motionLine(audit)
  if (motion !== undefined) lines.push(motion)
  if (audit.framesNote !== undefined) lines.push(`motion frames: ${audit.framesNote}`)
  // Honesty: these two limits are real, not boilerplate — say them every run.
  lines.push('')
  const motionChecked = audit.motion === undefined ? '' : 'jank-prone motion, overflow during motion, arrivals on scroll, chart time labels, '
  lines.push(`checks: overflow, images, names, headings, meta, tap targets (≤480px), focus, contrast (approximate, inherited background), field labels, clipped text, empty space, uneven columns, ${motionChecked}reduced-motion fallback, broken text values, colours against DESIGN.md, console errors.`)
  lines.push('not checked: keyboard order — drive the page with web_interact to verify it.')
  return lines.join('\n')
}
