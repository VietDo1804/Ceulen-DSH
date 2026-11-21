/**
 * Recognise a bash call that only takes one headless-Chrome screenshot
 * (`google-chrome --headless --screenshot=… --window-size=W,H URL`) and name
 * the `web_screenshot` call that does the same and shows the image.
 *
 * Measured 2026-11-01..20: ~400 bash calls drove Chrome or Playwright by hand;
 * since web_screenshot/web_interact left `tools.cold` on 11-10 the rate fell
 * from ~35 to ~8 a day, mostly deepseek-v4.1-flash, and every flag those
 * screenshots used maps onto a web_screenshot argument. Anything else (DOM
 * dumps, PDFs, a device scale factor, scripts, pipes) is left alone.
 */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shellWords, splitUnquoted, type Replacement } from './bash-search.js'

const CHROME = /(?:^|\/)(?:google-chrome(?:-stable|-beta|-safe)?|chromium(?:-browser)?|chrome)$/
/** Flags that change nothing web_screenshot would do differently. */
const INERT = /^--(?:headless(?:=\w+)?|disable-gpu|no-sandbox|hide-scrollbars|no-first-run|no-default-browser-check|mute-audio|disable-dev-shm-usage|disable-extensions|run-all-compositor-stages-before-draw|disable-background-networking|user-data-dir=.+|default-background-color=.+|force-color-profile=.+|log-level=\d+|disable-software-rasterizer)$/

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The page argument as web_screenshot takes it: http(s) and file:// as given, a bare path as file://. */
function pageUrl(target: string, dir: string | undefined): string | undefined {
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) return target
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined
  const absolute = isAbsolute(target) ? target : resolve(dir ?? process.cwd(), target)
  return pathToFileURL(absolute).href
}

/** What may sit next to the screenshots without needing the PNG: a listing or a marker echo. */
const FILLER = /^\s*(?:ls(?:\s+-\w+)*(?:\s+[^\s;&|<>$`]+)*|echo(?:\s+[^;&|<>$`]*)?|true|sleep\s+\d+(?:\.\d+)?)\s*$/

/** One `chrome --headless --screenshot … URL` segment as a web_screenshot call, or undefined. */
function oneScreenshot(segment: string, dir: string | undefined): Replacement | undefined {
  const text = segment.trim()
    // Output plumbing around the capture, not part of it.
    .replace(/\s*2>&1\s*\|\s*tail\s+-n?\s*\d+\s*$/, '')
    .replace(/\s*(?:>\s*\/dev\/null\s*)?2>(?:&1|\s*\/dev\/null)\s*$/, '')
    .replace(/\s*>\s*\/dev\/null\s*$/, '')
    // A throwaway profile (often `/tmp/x-$$`) changes nothing web_screenshot does.
    .replace(/\s--user-data-dir=\S+/g, '')
  if (/\||[<>]/.test(text)) return undefined
  const words = shellWords(text)
  if (words === undefined) return undefined
  if (words[0] === 'timeout' && /^\d+[smh]?$/.test(words[1] ?? '')) words.splice(0, 2)
  if (words.length < 3 || !CHROME.test(words[0]!)) return undefined

  let screenshot = false
  let headless = false
  let width: number | undefined
  let height: number | undefined
  let waitForSec: number | undefined
  let reducedMotion = false
  const targets: string[] = []
  for (const word of words.slice(1)) {
    if (/^--headless(?:=\w+)?$/.test(word)) headless = true
    if (word === '--screenshot' || word.startsWith('--screenshot=')) {
      screenshot = true
      continue
    }
    const size = /^--window-size=(\d+)[,x](\d+)$/.exec(word)
    if (size !== null) {
      width = Number(size[1])
      height = Number(size[2])
      continue
    }
    const budget = /^--virtual-time-budget=(\d+)$/.exec(word)
    if (budget !== null) {
      waitForSec = Math.round(Number(budget[1]) / 100) / 10
      continue
    }
    if (word === '--force-prefers-reduced-motion') {
      reducedMotion = true
      continue
    }
    // web_screenshot renders at scale 1; another factor is not the same capture.
    if (word === '--force-device-scale-factor=1') continue
    if (INERT.test(word)) continue
    if (word.startsWith('-')) return undefined
    targets.push(word)
  }
  if (!screenshot || !headless || targets.length !== 1) return undefined
  const url = pageUrl(targets[0]!, dir)
  if (url === undefined) return undefined
  const args = [
    `url: ${quote(url)}`,
    ...(width === undefined ? [] : [`width: ${width}`]),
    ...(height === undefined ? [] : [`height: ${height}`]),
    ...(reducedMotion ? ['reducedMotion: true'] : []),
    ...(waitForSec === undefined || waitForSec === 0 ? [] : [`waitForSec: ${waitForSec}`]),
  ]
  return { call: `web_screenshot({ ${args.join(', ')} })` }
}

/**
 * The web_screenshot calls for a command that only takes headless-Chrome
 * screenshots (one or several, optionally followed by `ls`/`echo`), or
 * undefined. A command that does anything with the PNGs afterwards (PIL,
 * compare, copy) is not this: it needs the files.
 */
export function chromeScreenshotCalls(command: string): Replacement[] | undefined {
  let text = command.trim()
  let dir: string | undefined
  const cd = /^cd\s+(\S+)\s*&&\s*/.exec(text)
  if (cd !== null) {
    const words = shellWords(cd[1]!)
    if (words?.length !== 1) return undefined
    dir = words[0]
    text = text.slice(cd[0].length)
  }
  if (/<<|\|\|/.test(text)) return undefined
  const segments = splitUnquoted(text, /;|&&|\n/).filter(segment => segment.trim() !== '')
  const calls: Replacement[] = []
  for (const segment of segments) {
    if (FILLER.test(segment)) continue
    const call = oneScreenshot(segment, dir)
    if (call === undefined) return undefined
    calls.push(call)
  }
  return calls.length > 0 ? calls : undefined
}

/** The deny text for redirected screenshots: the exact calls, what they gain, and the escape hatch. */
export function captureRedirectText(command: string, calls: readonly Replacement[]): string {
  const shown = command.length > 160 ? `${command.slice(0, 159)}…` : command
  return [
    `Not run: \`${shown}\` only takes headless-Chrome screenshots, and web_screenshot does that and shows you the image.`,
    calls.length === 1 ? `Call instead: ${calls[0]!.call}` : `Call instead, as ${calls.length} direct calls (images do not pass through codemode):\n${calls.map(call => `- ${call.call}`).join('\n')}`,
    'For clicks, hover, typing or several checks on one page use web_interact (session:"name" keeps the page between calls). If you need the PNG files themselves, send the same bash command again unchanged and it will run.',
  ].join('\n')
}
