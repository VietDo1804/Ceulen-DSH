/**
 * What models send to the Chrome-backed web tools instead of the declared
 * argument names. Every alias below was counted in the session logs of
 * 1–9 Nov 2026 (403 `web_interact` and 48 `web_screenshot` calls): `width` /
 * `height` 50, `timeout_ms` 46, `reduced_motion` 45, `actions` 12, `full_page`
 * 11, `wait_ms` 8, and step objects written as `{ action, selector }`,
 * `{ type: "wait", ms }` or `{ wait: 900 }`.
 *
 * They used to be dropped without a word, so a "390px" capture ran at the
 * default width and an `actions` list ran no steps at all. The two tools
 * therefore accept undeclared keys, map the known ones here, and name the rest
 * in their result (`ignoredNote`). A declared name always wins over its alias.
 */
type Args = Record<string, unknown>

const isRecord = (value: unknown): value is Args => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Chrome needs a width; this is the capture default of `web_screenshot`. */
const DEFAULT_WIDTH = 1280

/** Move `from` to `to`. An alias that cannot be mapped stays, so it is reported as ignored. */
function rename(args: Args, from: string, to: string, map: (value: unknown) => unknown = value => value): void {
  if (!Object.hasOwn(args, from)) return
  if (args[to] !== undefined) {
    delete args[from]
    return
  }
  const mapped = map(args[from])
  if (mapped === undefined) return
  args[to] = mapped
  delete args[from]
}

const seconds = (value: unknown): unknown => (typeof value === 'number' && Number.isFinite(value) ? value / 1000 : undefined)
const numeric = (value: unknown): unknown => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** `"1440x900"` or `"390"` -> a viewport object; anything else is left for the tool to refuse. */
function parseViewport(value: unknown): Args | undefined {
  if (isRecord(value)) return { ...value }
  if (typeof value === 'number' && Number.isFinite(value)) return { width: value }
  if (typeof value !== 'string') return undefined
  const size = /^\s*(\d+)(?:\s*[x×*,]\s*(\d+))?\s*$/i.exec(value)
  if (size === null) return undefined
  return { width: Number(size[1]), ...(size[2] === undefined ? {} : { height: Number(size[2]) }) }
}

const STEP_KEYS = ['click', 'type', 'press', 'evaluate', 'wait_for', 'dialog', 'screenshot']
const WAIT_KEYS = ['wait', 'wait_ms', 'waitMs', 'sleep', 'delay']
/** The action a step names in `action` (or in a string `type`) -> the step key that does it. */
const VERBS: Record<string, string> = {
  click: 'click',
  type: 'type',
  fill: 'type',
  press: 'press',
  evaluate: 'evaluate',
  eval: 'evaluate',
  wait: 'wait_for',
  wait_for: 'wait_for',
  sleep: 'wait_for',
  screenshot: 'screenshot',
}

function pick(step: Args, keys: readonly string[], accept: (value: unknown) => boolean): unknown {
  for (const key of keys) if (accept(step[key])) return step[key]
  return undefined
}

const isText = (value: unknown): boolean => typeof value === 'string' && value.length > 0
const isTextOrNumber = (value: unknown): boolean => isText(value) || (typeof value === 'number' && Number.isFinite(value))

/**
 * One step in the shape the browser driver takes: exactly one action key. A
 * step this cannot read is returned unchanged; the driver's own error then
 * lists the valid keys.
 */
export function normalizeStep(step: unknown): unknown {
  if (!isRecord(step)) return step
  const { label, ...rest } = step
  const labelled = (out: Args): Args => (label === undefined ? out : { ...out, label })
  const keys = Object.keys(rest)

  // { wait: 900 } / { wait_ms: 300 } / { sleep: 500 }
  const only = keys.length === 1 ? keys[0] : undefined
  if (only !== undefined && WAIT_KEYS.includes(only) && isTextOrNumber(rest[only])) return labelled({ wait_for: rest[only] })

  // { action: "click", selector } / { type: "wait", ms }; a real type step carries an object.
  const named = typeof rest.action === 'string' ? rest.action : typeof rest.type === 'string' ? rest.type : undefined
  if (named === undefined || keys.some(key => key !== 'type' && STEP_KEYS.includes(key))) return step
  const verb = VERBS[named.trim().toLowerCase()]
  if (verb === 'screenshot') return labelled({ screenshot: true })
  if (verb === 'click') {
    const selector = pick(rest, ['selector', 'target', 'element'], isText)
    return selector === undefined ? step : labelled({ click: selector })
  }
  if (verb === 'type') {
    const selector = pick(rest, ['selector', 'target', 'element'], isText)
    const text = pick(rest, ['text', 'value'], value => typeof value === 'string')
    return selector === undefined || text === undefined ? step : labelled({ type: { selector, text } })
  }
  if (verb === 'press') {
    const key = pick(rest, ['key', 'value'], isText)
    return key === undefined ? step : labelled({ press: key })
  }
  if (verb === 'evaluate') {
    const code = pick(rest, ['script', 'expression', 'code', 'js', 'value'], value => typeof value === 'string')
    return code === undefined ? step : labelled({ evaluate: code })
  }
  if (verb === 'wait_for') {
    const until = pick(rest, ['ms', 'selector', 'timeout', 'duration', 'value'], isTextOrNumber)
    return until === undefined ? step : labelled({ wait_for: until })
  }
  return step
}

function viewportFromTop(args: Args): void {
  const parsed = parseViewport(args.viewport)
  if (args.viewport !== undefined && parsed === undefined) return
  const viewport: Args = parsed ?? {}
  rename(viewport, 'deviceScaleFactor', 'device_scale_factor', numeric)
  for (const [from, to] of [['width', 'width'], ['height', 'height'], ['device_scale_factor', 'device_scale_factor'], ['deviceScaleFactor', 'device_scale_factor']] as const) {
    if (typeof args[from] !== 'number') continue
    if (viewport[to] === undefined) viewport[to] = args[from]
    delete args[from]
  }
  if (Object.keys(viewport).length === 0) return
  if (viewport.width === undefined) viewport.width = DEFAULT_WIDTH
  args.viewport = viewport
}

/** `web_interact` arguments with the aliases mapped onto the declared names. */
export function normalizeInteractArgs(raw: Args): Args {
  const args: Args = { ...raw }
  rename(args, 'actions', 'steps', value => (Array.isArray(value) ? value : undefined))
  rename(args, 'reduced_motion', 'reducedMotion')
  for (const alias of ['timeout_ms', 'timeoutMs', 'step_timeout_ms']) rename(args, alias, 'stepTimeoutMs', numeric)
  for (const alias of ['wait_ms', 'waitMs']) rename(args, alias, 'waitForSec', seconds)
  viewportFromTop(args)
  // The final screenshot is always taken; asking for it is not an error.
  if (args.screenshot === true) delete args.screenshot
  if (Array.isArray(args.steps)) args.steps = args.steps.map(normalizeStep)
  return args
}

/** `web_screenshot` arguments with the aliases mapped onto the declared names. */
export function normalizeScreenshotArgs(raw: Args): Args {
  const args: Args = { ...raw }
  rename(args, 'full_page', 'fullPage')
  rename(args, 'reduced_motion', 'reducedMotion')
  for (const alias of ['wait_ms', 'waitMs']) rename(args, alias, 'waitForSec', seconds)
  const viewport = parseViewport(args.viewport)
  if (viewport !== undefined) {
    for (const key of ['width', 'height']) if (args[key] === undefined && typeof viewport[key] === 'number') args[key] = viewport[key]
    delete args.viewport
  }
  return args
}

/**
 * One result line naming the arguments the tool did not use, or '' when every
 * key is declared. A dropped argument the model never hears about is how a
 * capture at the wrong size gets reported as verified.
 */
export function ignoredNote(tool: string, args: unknown, parameters: Record<string, unknown>): string {
  const declared = isRecord(parameters.properties) ? parameters.properties : {}
  const ignored = isRecord(args) ? Object.keys(args).filter(key => !Object.hasOwn(declared, key)) : []
  if (ignored.length === 0) return ''
  return `Ignored arguments (not part of ${tool}): ${ignored.join(', ')}. Declared: ${Object.keys(declared).join(', ')}.`
}
