import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type { PluginContext, ToolContent, ToolRunContext } from '../../core/types.js'
import { readText } from '../../core/fsx.js'
import { isModuleEnabled, loadSettingsSync, updateSettings, type UxMode } from '../../core/settings.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe } from '../../core/tools.js'
import { audit, extractTokens, type AuditPair, type AuditResult } from '../../vendor/ceulen/ux/audit.js'
import { saveScreenshot } from '../web/capture.js'
import { contrastFixLine, nearestToken } from './fix.js'
import { formatRuntimeReport, runRuntimeAudit, type RuntimeAudit } from './review.js'

export const name = 'ceulen-ux'
export const inject = ['tools', 'commands', 'systemPrompt']

const MODES = new Set(['off', 'lite', 'strict'])

// ponytail: same cap as upstream — a model-supplied path can point at a
// bundle far larger than one context window wants.
const MAX_CSS_BYTES = 1024 * 1024

function cwdOf(exec?: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

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
  return text
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

function gateList(failed: boolean[], labels: string[]): string {
  return labels.filter((_, index) => failed[index]).join(', ')
}

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
  const failedGates = [
    gates.contrast.status === 'fail',
    gates.tokens.status === 'fail',
    gates.states.status === 'fail',
    gates.slopTells.status === 'fail',
  ]
  const incompleteGates = [
    gates.contrast.status === 'incomplete',
    gates.tokens.status === 'incomplete',
    gates.states.status === 'incomplete',
    gates.slopTells.status === 'incomplete',
  ]
  const labels = ['contrast', 'tokens', 'states', 'slop tells']

  if (verdict === 'PASS') {
    lines.push('UX audit: PASS — gates passed. Visual review still required.')
  } else if (verdict === 'INCOMPLETE') {
    const missing = gateList(incompleteGates, labels)
    lines.push(`UX audit: INCOMPLETE — ${missing} had nothing to check. No PASS is claimed.`)
  } else {
    lines.push(`UX audit: FAIL — ${gateList(failedGates, labels)} failed${gateList(incompleteGates, labels) === '' ? '' : `; ${gateList(incompleteGates, labels)} not checked`}.`)
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

async function designDriftLine(css: string, stylesheet: string | undefined, cwd: string): Promise<string> {
  const folders = stylesheet === undefined ? [cwd] : [dirname(resolvePath(cwd, stylesheet)), cwd]
  for (const folder of folders) {
    const design = await readFile(join(folder, 'DESIGN.md'), 'utf8').catch(() => null)
    if (design === null) continue
    const stale = staleDesignColours(design, css)
    return stale.length === 0 ? '' : `\ndesign: DESIGN.md lists ${stale.join(', ')}, which this stylesheet does not have. If you changed a token, update DESIGN.md. If it lives in another stylesheet, leave DESIGN.md alone.`
  }
  return ''
}

// The always-on half of the method: a short recipe, not the skill. The
// reported gap was 32/56 UI sessions auditing but only 8/56 loading ux-design,
// so the prompt names the skill and gives the order. Growth is capped in
// test/ux.test.ts (the old strict text was 783 chars).
const INSTRUCTIONS: Record<Exclude<UxMode, 'off'>, string> = {
  lite: `UX MODE ACTIVE — level: lite. Use design tokens, not raw values. Load the \`ux-design\` skill for new or user-facing UI and state one direction line before markup. Give the page rich motion by copying the ux-design motion kit (kit/motion.js and kit/motion.css, attributes in references/motion.md): a load moment, items that arrive as they scroll in, soft state changes, and UI that reacts to the pointer. Implement the full interaction state set (hover, focus-visible, active, disabled, loading, empty, error). Use semantic HTML and accessible names. Run ux_audit on the stylesheet and on the rendered page; look at the screenshots it returns, because a PASS does not end the visual review. No decorative gradients, glassmorphism, giant hero type, or emoji-as-icon unless the existing design uses them.`,
  strict: `UX MODE ACTIVE — level: strict. Tokens only: every color, radius, spacing, shadow, and font size comes from an existing token; no raw hex outside the token file.
Method, in order:
1. Read DESIGN.md. If there is none, load the \`ux-design\` skill; for a starter system load \`ux-presets\` and pick one.
2. Before markup, state one line: \`Direction: <concept> · type <display>+<body> · palette <hex> · signature <element> · motion <load> + <scroll>\`. If DESIGN.md is absent, write it now in the working directory: that line and the tokens, before any markup, even when the request names only other files. A product with its own tokens gets those, never new ones. When a token changes, change DESIGN.md too.
3. Build inside those tokens. Every interactive component defines hover, focus-visible, active, disabled, loading, empty, and error states. A static page is unfinished: copy the ux-design motion kit next to the page, or to public/ in React or Next (cp kit/motion.js kit/motion.css, never retype them) and mark up the page with its attributes (references/motion.md). That gives a load moment, items that arrive as they scroll in, soft state changes, UI that reacts to the pointer, and a reduced-motion fallback.
4. Run ux_audit on the stylesheet (path) and on the rendered page (url). It returns two screenshots when the route accepts images — look at them: hierarchy, dead zones, clipped text, overflow at the target width. A PASS does not end the visual review. Once the motion is built, add \`motion: true\` to see its load frames.
5. Fix every finding, then repeat before claiming UI work done.
No AI-slop tells: no purple-blue gradient on everything, no glass cards, no emoji icons, no centered hero for app UI, no oversized rounded cards. Preserve the product's existing visual language.`,
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('ux', settings)) return

  let mode: UxMode = settings.ux.mode

  registerPromptSection(ctx, {
    name: 'ceulen:ux',
    order: 130,
    text: () => (mode === 'off' ? '' : INSTRUCTIONS[mode]),
  })

  registerToolSafe(ctx, ceulenTool({
    name: 'ux_audit',
    description: 'Deterministic UI audit. Stylesheet mode: APCA/WCAG contrast (with a suggested passing colour), hardcoded colors outside tokens, ad-hoc shadows, per-component interaction states, focus-ring kills, AI-slop tells — supply `path` (preferred), `css`, or only `pairs`. Runtime mode: supply `url` to open the page in Chrome at six viewports, check focus indicators, accessible names, heading order, tap targets, overflow, field labels, clipped text, empty blocks, uneven columns, jank-prone motion, console errors, and inherited-background contrast, and return two screenshots (smallest phone + widest ≤1440). Add `motion: true` for three frames of the page-load animation. Both modes may run in one call: `url` plus `path` gives two labelled verdicts. Verdicts are PASS, FAIL, or INCOMPLETE — INCOMPLETE means a gate had nothing to check and is never reported as a pass. No model call.',
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
        const runtime: RuntimeAudit = await runRuntimeAudit({ url, cwd: cwdOf(exec), viewports: args.viewports, motion: args.motion === true, signal: exec.signal })
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
    description: 'Anti-slop UI discipline: off, lite, or strict',
    input: { hint: '[off|lite|strict|status]' },
    async handler({ rawInput }) {
      const value = rawInput.trim().toLowerCase()
      if (value === '' || value === 'status') {
        return { kind: 'success', text: `UX mode: ${mode}` }
      }
      if (!MODES.has(value)) return { kind: 'error', text: 'usage: /ux off|lite|strict' }
      mode = value as UxMode
      await updateSettings(settings => {
        settings.ux.mode = mode
      })
      return { kind: 'success', text: `UX mode: ${mode}. The prompt guidance applies from the next request.` }
    },
  })
}
