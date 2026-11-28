import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type { AgentLike, PluginContext, ToolContent, ToolRunContext } from '../../core/types.js'
import { readText } from '../../core/fsx.js'
import { isModuleEnabled, loadSettingsSync, updateSettings, type UxMode } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe, cwdOf } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { audit, extractTokens, type AuditPair, type AuditResult } from '../../vendor/ceulen/ux/audit.js'
import { saveScreenshot } from '../web/capture.js'
import { contrastFixLine, nearestToken } from './fix.js'
import { formatRuntimeReport, runRuntimeAudit, type RuntimeAudit } from './review.js'
import { AutoLevels, KEEP_TEXT, OFF_TEXT, UX_LEVEL_CONTEXT, userTextOf, type AutoLevel } from './auto.js'
import { KIT_MARK, registerKitTool } from './kit.js'

export const name = 'ceulen-ux'
export const inject = ['tools', 'commands', 'systemPrompt']

const MODES = new Set(['off', 'lite', 'strict', 'auto'])

// ponytail: same cap as upstream — a model-supplied path can point at a
// bundle far larger than one context window wants.
const MAX_CSS_BYTES = 1024 * 1024

/**
 * Resolve the stylesheet to audit: a file `path` read verbatim (preferred —
 * retyped copies drift and produce false passes) or inline `css` text.
 * Exactly one. A run with neither AND no `pairs` would scan nothing and pass
 * three gates vacuously, so it is an error rather than an empty audit.
 * `pairs` alone is a real contrast-only check, not a vacuous run.
 */
export async function resolveAuditCss(
  params: { css?: unknown; path?: unknown; pairs?: unknown },
  cwd: string,
): Promise<string> {
  const css = typeof params.css === 'string' ? params.css : ''
  const file = typeof params.path === 'string' ? params.path.trim() : ''
  if (css.trim() !== '' && file !== '') throw new Error('Pass exactly one of `path` or `css` — not both.')
  if (css.trim() === '' && file === '') {
    const hasPairs = Array.isArray(params.pairs) && params.pairs.length > 0
    if (hasPairs) return ''
    throw new Error('Pass `path` (preferred) or `css`, or `pairs` for a contrast-only check.')
  }
  if (file === '') return css
  const target = resolvePath(cwd, file)
  const size = await stat(target).then(s => s.size, () => -1)
  if (size < 0) throw new Error(`Cannot read stylesheet: ${target}`)
  if (size > MAX_CSS_BYTES) throw new Error(`Stylesheet too large: ${target} (${size} bytes, max ${MAX_CSS_BYTES})`)
  const text = await readText(target)
  if (text === undefined) throw new Error(`Cannot read stylesheet: ${target}`)
  if (/\.html?$/i.test(target)) return pageCss(text, dirname(target))
  return `${await kitSiblings(dirname(target), target)}${text}`
}

/**
 * The kit files beside a stylesheet, read with it. A page built with `ux_kit`
 * keeps its colours in tokens.css and its focus, disabled and reduced-motion
 * rules in base.css, so the page's own sheet alone resolves no `var()` pair
 * and declares no state. Only files that carry the kit's mark count.
 */
async function kitSiblings(folder: string, self: string): Promise<string> {
  let out = ''
  for (const name of ['tokens.css', 'base.css']) {
    const path = join(folder, name)
    if (path === self) continue
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text !== null && text.includes(KIT_MARK) && text.length <= MAX_CSS_BYTES) out += `${text}\n`
  }
  return out
}

/**
 * The CSS of an HTML page: its `<style>` blocks and its local stylesheets, in
 * document order. A single-file page handed to `path` used to be parsed as CSS.
 */
export async function pageCss(html: string, folder: string): Promise<string> {
  const parts: string[] = []
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|<link\b[^>]*>/gi)) {
    if (match[1] !== undefined) {
      parts.push(match[1])
      continue
    }
    if (!/\brel=(["'])stylesheet\1/i.test(match[0])) continue
    const href = /\bhref=(["'])([^"']+)\1/i.exec(match[0])?.[2]
    if (href === undefined || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || /(?:^|\/)motion\.css$/.test(href)) continue
    const text = await readFile(resolvePath(folder, href.replace(/[?#].*$/, '')), 'utf8').catch(() => null)
    if (text !== null && text.length <= MAX_CSS_BYTES) parts.push(text)
  }
  if (parts.length === 0) throw new Error('This HTML page has no <style> block and no local stylesheet to audit. Pass the stylesheet as `path`, or use `url` for the runtime audit.')
  return parts.join('\n')
}

/** A call carries a stylesheet when it names `path`, `css`, or `pairs`. */
export function hasStylesheet(args: { css?: unknown; path?: unknown; pairs?: unknown; url?: unknown }): boolean {
  return (typeof args.css === 'string' && args.css.trim() !== '')
    || (typeof args.path === 'string' && args.path.trim() !== '')
    || (Array.isArray(args.pairs) && args.pairs.length > 0)
}

/**
 * Runtime mode may run on its own or alongside the static gates (two labelled
 * verdicts). Exported for the tool-contract test.
 */
export function runtimeUrlOf(args: { url?: unknown }): string | undefined {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  return url === '' ? undefined : url
}

/** A route with no declared input modalities is treated as image-capable. */
export function modelAcceptsImages(info: { inputModalities?: readonly string[] } | undefined): boolean {
  if (info?.inputModalities === undefined) return true
  return info.inputModalities.includes('image')
}

interface LlmLike {
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
}

/** Whether the active route can receive the captured screenshots. */
export async function routeAcceptsImages(ctx: PluginContext, exec?: Pick<ToolRunContext, 'agent' | 'signal'>): Promise<boolean> {
  let llm: LlmLike | undefined
  try {
    llm = ctx.get('llm', false) as LlmLike | undefined
  } catch {
    llm = undefined
  }
  const provider = exec?.agent?.options.provider
  const model = exec?.agent?.options.model
  if (llm?.resolveModelInfo === undefined || provider === undefined || model === undefined) return true
  try {
    return modelAcceptsImages(await llm.resolveModelInfo(provider, model, exec?.signal))
  } catch {
    return true
  }
}

export interface AuditToolOutput {
  text: string
  images?: unknown[]
}

const MAX_PAIR_LINES = 8
const MAX_TOKEN_LINES = 6

/**
 * Static verdict, one line per finding, and the colour to use instead.
 * No appended JSON: the reported defect was ~1k tokens of duplicated gates.
 */
export function formatStylesheetReport(
  result: AuditResult,
  options: { tokens?: Map<string, string>; contrastOnly?: boolean } = {},
): string {
  const gates = result.gates
  const contrast = gates.contrast
  const tokens = options.tokens ?? new Map<string, string>()
  const lines: string[] = []
  const failedPairs = contrast.results.filter(pair => !pair.pass)

  if (options.contrastOnly === true) {
    const verdict = contrast.status === 'fail' ? 'FAIL' : contrast.status === 'pass' ? 'PASS' : 'INCOMPLETE'
    lines.push(`UX audit: ${verdict} (contrast only — no stylesheet supplied)`)
    for (const pair of failedPairs.slice(0, MAX_PAIR_LINES)) lines.push(`  ${contrastFixLine(pair, tokens)}`)
    if (failedPairs.length > MAX_PAIR_LINES) lines.push(`  … +${failedPairs.length - MAX_PAIR_LINES} more failed pair(s)`)
    if (contrast.status === 'pass') lines.push(`contrast: ${contrast.pairsChecked} pair(s) checked — passed.`)
    return clampText(lines.join('\n'), 2_500)
  }

  const verdict = gates.status === 'fail' ? 'FAIL' : gates.status === 'incomplete' ? 'INCOMPLETE' : 'PASS'
  const gateOrder = [['contrast', gates.contrast], ['tokens', gates.tokens], ['states', gates.states], ['slop tells', gates.slopTells]] as const
  const named = (status: 'fail' | 'incomplete'): string =>
    gateOrder.filter(([, gate]) => gate.status === status).map(([label]) => label).join(', ')

  if (verdict === 'PASS') {
    lines.push('UX audit: PASS — gates passed. Visual review still required.')
  } else if (verdict === 'INCOMPLETE') {
    lines.push(`UX audit: INCOMPLETE — ${named('incomplete')} had nothing to check. No PASS is claimed.`)
  } else {
    lines.push(`UX audit: FAIL — ${named('fail')} failed${named('incomplete') === '' ? '' : `; ${named('incomplete')} not checked`}.`)
  }

  if (contrast.status === 'fail') {
    // The declarable count describes the stylesheet, so it only means coverage
    // for auto-extracted pairs; hand-typed pairs printed nonsense like 15/12.
    const coverage = result.autoPairs && contrast.declarablePairs > 0
      ? `${contrast.pairsChecked}/${contrast.declarablePairs} pair(s) checked, auto-extracted`
      : `${contrast.pairsChecked} pair(s) checked`
    lines.push(`contrast: ${coverage}, ${failedPairs.length} failed.`)
    for (const pair of failedPairs.slice(0, MAX_PAIR_LINES)) lines.push(`  ${contrastFixLine(pair, tokens)}`)
    if (failedPairs.length > MAX_PAIR_LINES) lines.push(`  … +${failedPairs.length - MAX_PAIR_LINES} more failed pair(s)`)
    // Auto pairs carry no size or role, so quiet text is judged as body text.
    if (result.autoPairs) lines.push('  Captions and metadata: pass them as `pairs` with `size` and `role: "secondary"` rather than brightening them.')
  } else if (contrast.status === 'incomplete') {
    const declarable = contrast.declarablePairs
    const why = declarable === 0 ? 'no rule declares both a colour and a background' : `${declarable} declarable pair(s) could not be parsed`
    lines.push(`contrast: not checked — ${why}. Pass \`pairs\` to check explicit pairs.`)
  } else {
    lines.push(`contrast: ${contrast.pairsChecked} pair(s) checked — passed.`)
  }

  if (gates.tokens.status === 'fail') {
    const uses = result.gates.tokens.hexUses
    lines.push(`tokens: ${gates.tokens.hardcodedHex.length} hardcoded value(s), ${gates.tokens.adhocShadow.length} ad-hoc shadow(s).`)
    for (const use of uses.slice(0, MAX_TOKEN_LINES)) {
      const nearest = nearestToken(use.value, tokens)
      lines.push(`  ${use.value} at ${use.selector}${nearest === null ? '' : ` → nearest token ${nearest.name} ${nearest.value}`}`)
    }
    if (uses.length > MAX_TOKEN_LINES) lines.push(`  … +${uses.length - MAX_TOKEN_LINES} more off-system value(s)`)
  } else if (gates.tokens.status === 'incomplete') {
    lines.push('tokens: not checked — no stylesheet supplied.')
  }

  if (gates.states.status !== 'pass') {
    const states = gates.states
    const parts: string[] = []
    if (states.missingFocusVisible.length > 0) parts.push(`focus-visible missing [${states.missingFocusVisible.join(', ')}]`)
    if (states.missingDisabled.length > 0) parts.push(`disabled missing [${states.missingDisabled.join(', ')}]`)
    if (states.focusRingKills.length > 0) parts.push(`focus ring hidden without a replacement [${states.focusRingKills.join(', ')}]`)
    if (states.missingReducedMotion.length > 0) parts.push(`reduced-motion missing [${states.missingReducedMotion.join('; ')}]`)
    lines.push(gates.states.status === 'incomplete' ? 'states: not checked — no interactive elements or motion.' : `states: ${parts.join('; ')}`)
  }

  if (gates.slopTells.status === 'fail') lines.push(`slop tells: ${gates.slopTells.tells.join('; ')}`)

  return clampText(lines.join('\n'), 2_500)
}

/**
 * Colours DESIGN.md lists that the stylesheet no longer has. A stylesheet that
 * lacks half or more of them is only part of the system, so nothing is claimed.
 */
export function staleDesignColours(design: string, css: string): string[] {
  const listed = [...new Set([...design.matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase()))]
  const sheet = css.toLowerCase()
  const stale = listed.filter((colour) => !sheet.includes(colour))
  return stale.length * 2 >= listed.length ? [] : stale
}

async function readDesign(stylesheet: string | undefined, cwd: string): Promise<string | undefined> {
  // The project's file comes first, so a DESIGN.md added beside a concept cannot replace it.
  const folders = stylesheet === undefined ? [cwd] : [cwd, dirname(resolvePath(cwd, stylesheet))]
  for (const folder of folders) {
    const design = await readFile(join(folder, 'DESIGN.md'), 'utf8').catch(() => null)
    if (design !== null) return design
  }
  return undefined
}

async function designDriftLine(css: string, stylesheet: string | undefined, cwd: string): Promise<string> {
  const design = await readDesign(stylesheet, cwd)
  if (design !== undefined) {
    const stale = staleDesignColours(design, css)
    return stale.length === 0 ? '' : `\ndesign: DESIGN.md lists ${stale.join(', ')}, which this stylesheet does not have. If you changed a token, update DESIGN.md. If it lives in another stylesheet, leave DESIGN.md alone.`
  }
  return ''
}

// The always-on half of the method: a short recipe, not the skill. The
// reported gap was 32/56 UI sessions auditing but only 8/56 loading ux-design,
// so the prompt names the skill and gives the order. Growth is capped in
// test/ux.test.ts (the old strict text was 783 chars).
const INSTRUCTIONS: Record<'lite' | 'strict', string> = {
  lite: `UX MODE ACTIVE — level: lite. This request makes new UI or an HTML page a person will read, so how it looks matters.
1. Call \`ux_kit\` first with the user's request, before any markup. It picks the design preset, writes DESIGN.md, tokens.css and the kit files, and returns the head to paste and a recipe for this kind of page. Follow that result.
2. Colours are \`var(--name)\` from tokens.css, never a hex value. Do not retype or edit the kit files. A diagram is lines in \`<figure data-diagram><pre>\`, never hand-placed SVG.
3. Run \`ux_audit\` with \`url\` and \`path\`, look at the screenshots it returns, fix every finding and run it again. A PASS does not end the visual review.
No decorative gradients, glassmorphism, giant hero type, or emoji-as-icon unless the existing design uses them.`,
  strict: `UX MODE ACTIVE — level: strict. Tokens only: every color, radius, spacing, shadow, and font size comes from an existing token; no raw hex outside the token file.
Method, in order:
1. Call \`ux_kit\` with the user's request before any markup. With no DESIGN.md it picks a preset and writes DESIGN.md, tokens.css and the kit files; an existing one is kept. Read all of DESIGN.md. A concept or redesign keeps its tokens, and its colour comes from the ones listed. "Premium", "colors", or "attractive" change nothing; only the words new identity, rebrand, or ignore DESIGN.md do. Never add a second DESIGN.md. The \`ux-design\` skill has the method.
2. Before markup, state one line and add it to DESIGN.md: \`Direction: <concept> · type <display>+<body> · palette <hex> · signature <element> · motion <load> + <scroll>\`. A product with its own tokens gets those, never new ones. When a token changes, change DESIGN.md too.
3. Build inside those tokens, as the \`ux_kit\` result says. Every interactive component defines hover, focus-visible, active, disabled, loading, empty, and error states. A static page is unfinished: mark it up with the motion kit's attributes and never retype the kit; it brings the reduced-motion fallback. A diagram is lines in \`<figure data-diagram><pre>\`, never hand-placed SVG.
4. Run ux_audit on the stylesheet (path) and the rendered page (url). It returns two screenshots when the route accepts images — look at them: hierarchy, dead zones, clipped text, overflow. A PASS does not end the visual review. Once motion is built, add \`motion: true\`.
5. Fix every finding, then repeat before claiming UI work done.
No AI-slop tells: no purple-blue gradient, glass cards, emoji icons, centered hero for app UI, or oversized rounded cards. Preserve the product's existing visual language.`,
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('ux', settings)) return

  let mode: UxMode = settings.ux.mode

  registerPromptSection(ctx, {
    name: 'ceulen:ux',
    order: 130,
    // Auto mode keeps the system prompt fixed and sends its level as runtime context.
    text: () => (mode === 'off' || mode === 'auto' ? '' : INSTRUCTIONS[mode]),
  })

  const levels = new AutoLevels(ctx, autoText, () => mode === 'auto')
  installAutoLevels(ctx, levels)
  registerKitTool(ctx)

  registerToolSafe(ctx, ceulenTool({
    name: 'ux_audit',
    description: 'Deterministic UI audit. Stylesheet mode: APCA/WCAG contrast (with a suggested passing colour), hardcoded colors outside tokens, ad-hoc shadows, per-component interaction states, focus-ring kills, AI-slop tells — supply `path` (a stylesheet, read with the kit files tokens.css and base.css beside it, or an HTML page for its own CSS), `css`, or only `pairs`. Runtime mode: supply `url` to open the page in Chrome at six viewports, check focus indicators, accessible names, heading order, tap targets, overflow, field labels, clipped text, diagrams that failed to draw, empty blocks, uneven columns, jank-prone motion, console errors, and inherited-background contrast, and return two screenshots (smallest phone + widest ≤1440). Add `motion: true` for three frames of the page-load animation. Both modes may run in one call: `url` plus `path` gives two labelled verdicts. Verdicts are PASS, FAIL, or INCOMPLETE — INCOMPLETE means a gate had nothing to check and is never reported as a pass. No model call.',
    parameters: objectSchema({
      path: { type: 'string', description: 'Path to a CSS stylesheet to audit verbatim (absolute or cwd-relative). PREFERRED over retyping `css`. Exactly one of path/css; may be combined with `url` for a static+runtime pair.' },
      css: { type: 'string', description: 'CSS/SCSS text to scan (inline <style>, or a token block). Prefer `path` for on-disk files. Exactly one of path/css.' },
      pairs: {
        type: 'array',
        description: 'Explicit contrast pairs. If omitted, pairs are extracted from rules that declare both color and background.',
        items: {
          type: 'object',
          properties: {
            fg: { type: 'string', description: 'Foreground color.' },
            bg: { type: 'string', description: 'Background color.' },
            label: { type: 'string', description: 'Optional label.' },
            min: { type: 'number', description: 'WCAG ratio floor, enforced alongside APCA (default 4.5; 3 for non-text).' },
            size: { type: 'string', description: 'Font size, e.g. 14px or 0.875rem.' },
            weight: { type: 'string', description: 'Font weight, e.g. 700.' },
            role: { type: 'string', enum: ['secondary'], description: 'Set "secondary" for captions, metadata, and helper text: Lc 60 instead of 75, with WCAG 4.5 as the floor. Needs `size`; text under 12px keeps the body rule. Never use it for paragraphs, instructions, or error messages.' },
          },
          required: ['fg', 'bg'],
          additionalProperties: false,
        },
      },
      url: { type: 'string', description: 'RUNTIME MODE: http(s) or workspace file:// URL. Opens the page in Chrome across viewports and checks what CSS text cannot. Combine with `path` for two labelled verdicts.' },
      viewports: {
        type: 'array',
        description: 'Optional tier widths for runtime mode (320–3840, max 6). Defaults to 360/390/768/1024/1440/1920.',
        items: { type: 'number' },
      },
      motion: { type: 'boolean', description: 'With `url`: also return three frames of the page-load animation (start, middle, end), because the audit otherwise renders with motion off. Use it once the motion is built.' },
    }),
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        images: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['text'],
    },
    render: (_args, value) => {
      const record = value as AuditToolOutput
      const out: Array<{ type: 'text'; text: string } | { type: 'image'; attachment?: unknown }> = []
      for (const image of record?.images ?? []) out.push({ type: 'image', attachment: image })
      out.push({ type: 'text', text: String(record?.text ?? '') })
      return out as unknown as ToolContent
    },
    // ponytail: runtime mode launches Chrome; serialise the tool rather than
    // risk parallel browsers. Static runs are fast enough to pay for it.
    concurrencySafe: false,
    timeoutMs: 180_000,
    async execute(raw, exec) {
      const args = raw as { css?: string; path?: string; pairs?: AuditPair[]; url?: string; viewports?: number[]; motion?: boolean }
      const url = runtimeUrlOf(args)
      const images: unknown[] = []
      let text = ''

      if (hasStylesheet(args)) {
        const css = await resolveAuditCss(args, cwdOf(exec))
        const result = audit({ css, pairs: args.pairs ?? [] })
        text = formatStylesheetReport(result, { tokens: extractTokens(css), contrastOnly: css.trim() === '' })
        if (css.trim() !== '') text += await designDriftLine(css, args.path, cwdOf(exec))
      }

      if (url !== undefined) {
        const design = await readDesign(args.path, cwdOf(exec))
        const runtime: RuntimeAudit = await runRuntimeAudit({ url, cwd: cwdOf(exec), viewports: args.viewports, motion: args.motion === true, design, signal: exec.signal })
        const report = [formatRuntimeReport(runtime)]
        const captured = runtime.shots.length + (runtime.frames?.length ?? 0)
        const allowed = captured > 0 && await routeAcceptsImages(ctx, exec)
        if (captured > 0 && !allowed) {
          report.push(`screenshots skipped — ${exec.agent?.options.provider ?? 'this route'}/${exec.agent?.options.model ?? 'this model'} declares no image input. Use web_screenshot if you need to look.`)
        }
        for (const shot of runtime.shots) {
          if (!allowed) break
          const saved = await saveScreenshot(ctx, shot.base64, `ux-audit-${shot.width}`)
          if (saved.image !== undefined) images.push(saved.image)
          report.push(`shot @${shot.width}px: ${saved.text}`)
        }
        for (const frame of runtime.frames ?? []) {
          if (!allowed) break
          const saved = await saveScreenshot(ctx, frame.base64, `ux-motion-${frame.at}ms`)
          if (saved.image !== undefined) images.push(saved.image)
          report.push(`motion frame @${frame.at}ms: ${saved.text}`)
        }
        const runtimeText = report.join('\n')
        text = text === '' ? runtimeText : `${text}\n\n${runtimeText}`
      }

      if (text === '') throw new Error('Pass `path` (preferred) or `css`, or `url` for the runtime audit, or `pairs` for a contrast-only check.')
      return images.length > 0 ? { text, images } : { text }
    },
  }))

  registerCommandSafe(ctx, {
    name: 'ux',
    description: 'Anti-slop UI discipline: off, lite, strict, or auto (per request)',
    input: { hint: '[off|lite|strict|auto|status]' },
    async handler({ rawInput, agent }) {
      const value = rawInput.trim().toLowerCase()
      if (value === '' || value === 'status') {
        if (mode !== 'auto') return { kind: 'success', text: `UX mode: ${mode}` }
        const decision = agent === undefined ? undefined : levels.decision(String(agent.session.id))
        const detail = decision === undefined
          ? 'no request classified yet in this session'
          : `${decision.level}${decision.confidence === null ? '' : ` (${decision.confidence.toFixed(2)})`}${decision.via === 'classifier' ? '' : `, ${decision.via}`}`
        return { kind: 'success', text: `UX mode: auto → ${detail}` }
      }
      if (!MODES.has(value)) return { kind: 'error', text: 'usage: /ux off|lite|strict|auto' }
      mode = value as UxMode
      await updateSettings(settings => {
        settings.ux.mode = mode
      })
      return { kind: 'success', text: mode === 'auto'
        ? 'UX mode: auto. Each request is classified as off, keep, lite, or strict from your next message.'
        : `UX mode: ${mode}. The prompt guidance applies from the next request.` }
    },
  })
}

/** Guidance per auto level; `lite` and `strict` reuse the fixed-mode text. */
function autoText(level: AutoLevel): string {
  if (level === 'off') return OFF_TEXT
  if (level === 'keep') return KEEP_TEXT
  return INSTRUCTIONS[level]
}

interface AssembleContext {
  agent?: AgentLike
  scope?: AgentLike
}

interface Assembly {
  contexts: Array<{ name: string; text: string; interpolate?: boolean }>
}

/** The session directory the working-directory service committed, else the recorded one. */
function agentCwd(ctx: PluginContext, agent: AgentLike | undefined): string {
  if (agent === undefined) return process.cwd()
  try {
    const service = ctx.get('workingDirectory', false) as { get?(session: unknown): unknown } | undefined
    const dir = service?.get?.(agent.session)
    if (typeof dir === 'string' && dir.length > 0) return dir
  } catch {
    // Not mounted: fall through.
  }
  const recorded = agent.session.header?.cwd
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : process.cwd()
}

function installAutoLevels(ctx: PluginContext, levels: AutoLevels): void {
  const prompt = ctx.systemPrompt as typeof ctx.systemPrompt & {
    context?(entry: { name: string; order: number; interpolate?: boolean; text: (context?: AssembleContext) => string }): () => void
  }
  if (typeof prompt.context !== 'function') return
  try {
    prompt.context({ name: UX_LEVEL_CONTEXT, order: 900, interpolate: false, text: context => levels.textFor(context?.agent ?? context?.scope) })
  } catch (error) {
    logLine('ux', `auto level context not registered: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  ctx.on('agent/created', (payload: { agent?: AgentLike } | undefined) => {
    if (payload?.agent !== undefined) levels.track(payload.agent)
  })
  ctx.on('agent/disposed', (payload: { agent?: AgentLike } | undefined) => {
    if (payload?.agent !== undefined) levels.forget(String(payload.agent.session.id))
  })
  // The inbox splice lands when the message is sent, before its turn starts.
  ctx.on('session/event', (session: { id?: unknown; header?: { parentSession?: string } } | undefined, event: { type?: string; data?: unknown } | undefined) => {
    if (event?.type !== 'agent/inbox/spliced' || session?.id === undefined) return
    const text = userTextOf(event.data, session.header?.parentSession !== undefined)
    if (text !== undefined) levels.classify(String(session.id), text, agent => agentCwd(ctx, agent), session.header?.parentSession)
  })
  // Contexts resolve before this waterfall runs, so the level is patched in after `next()`.
  ctx.on('system-prompt/assemble', async (_assembly: Assembly, context: AssembleContext | undefined, next: () => Promise<Assembly>) => {
    const agent = context?.agent ?? context?.scope
    if (agent === undefined) return next()
    await levels.settle(String(agent.session.id))
    const assembly = await next()
    const text = levels.textFor(agent)
    const entry = assembly.contexts.find(item => item.name === UX_LEVEL_CONTEXT)
    if (entry !== undefined) entry.text = text
    else if (text.length > 0) assembly.contexts.push({ name: UX_LEVEL_CONTEXT, text, interpolate: false })
    return assembly
  })
}
