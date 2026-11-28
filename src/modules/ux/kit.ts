/**
 * `ux_kit`: the start of UI work as one deterministic call, and a bundler for
 * single-file delivery.
 *
 * Measured over 33 deepseek-v4.1-flash sessions that wrote UI (10–27 Nov 2026):
 * 16 called `ux_audit`, 6 loaded `ux-design`, 5 copied the motion kit. A tool in
 * the list gets used; a recipe inside a skill mostly does not. So the recipe's
 * mechanical half lives here: pick the preset from the request's words, copy
 * `DESIGN.md` and the kit files, write the tokens, and say the next step in the
 * result, where a cheap model acts on it.
 *
 * No model call. Nothing the model would otherwise type by hand (a hex value,
 * a focus rule, a diagram coordinate) is left for it to type.
 */
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { packageFile } from '../../core/paths.js'
import { planActive } from '../../core/plan-mode.js'
import { ceulenTool, cwdOf, objectSchema, registerToolSafe, sessionSandboxPolicy } from '../../core/tools.js'
import { contrastRatio } from '../../vendor/ceulen/ux/audit.js'

export type PresetKind = 'app' | 'page' | 'doc'
export const ROLE_NAMES = ['bg', 'surface', 'text', 'muted', 'accent', 'on-accent', 'link', 'rule'] as const
export type RoleName = (typeof ROLE_NAMES)[number]
type Roles = Partial<Record<RoleName, string>>

interface Manifest {
  kit: string[]
  docKit: string[]
  fallback: string
  routes: Array<{ preset: string; words: string[]; kind?: PresetKind }>
  presets: Record<string, { kind: PresetKind; roles: Roles }>
}

/** A marker in every generated or copied kit file, so a later run knows its own files. */
export const KIT_MARK = 'ceulen-ux kit'

let cached: Manifest | undefined
export function manifest(): Manifest {
  cached ??= JSON.parse(readFileSync(packageFile('skills', 'ux-presets', 'presets.json'), 'utf8')) as Manifest
  return cached
}

const presetFile = (id: string, file: string): string => packageFile('skills', 'ux-presets', 'presets', id, file)
const kitFile = (file: string): string => packageFile('skills', 'ux-design', 'kit', file)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The preset for a request: the first table row with a word in it. Whole words
 * only, any case, so "bar" is not found in "sidebar" nor "kho" in "khoảng".
 */
export function routePreset(request: string): { preset: string; word: string | null; kind?: PresetKind } {
  const text = request.normalize('NFC').toLowerCase()
  const table = manifest()
  for (const row of table.routes) {
    for (const word of row.words) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word.normalize('NFC').toLowerCase())}(?![\\p{L}\\p{N}])`, 'u')
      if (pattern.test(text)) return row.kind === undefined ? { preset: row.preset, word } : { preset: row.preset, word, kind: row.kind }
    }
  }
  return { preset: table.fallback, word: null }
}

export interface Stack {
  framework: 'next' | 'react' | 'html'
  /** A design system already installed, whose tokens are the system. */
  system?: string
}

/** What the folder already is: a framework app, and whether it brings its own design system. */
export function detectStack(dir: string): Stack {
  let deps: Record<string, unknown> = {}
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    deps = { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    // No package.json: a plain page.
  }
  const framework = 'next' in deps ? 'next' : 'react' in deps ? 'react' : 'html'
  let system: string | undefined
  if (existsSync(join(dir, 'components.json'))) system = 'shadcn/ui (components.json)'
  else if ('@mui/material' in deps) system = 'MUI (@mui/material)'
  else if (Object.keys(deps).some(name => name.startsWith('@radix-ui/themes') || name === '@park-ui/panda-preset' || name === '@ark-ui/react')) system = 'Radix/Park/Ark UI'
  else {
    for (const file of ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
      try {
        if (/colors\s*:/.test(readFileSync(join(dir, file), 'utf8'))) system = `Tailwind theme colours (${file})`
      } catch {
        // Absent.
      }
    }
  }
  return system === undefined ? { framework } : { framework, system }
}

/** `name: "#hex"` entries of a DESIGN.md `colors:` block, in file order. */
export function designColours(design: string): Array<[string, string]> {
  const block = /^colors:\s*\n((?:[ \t]+.*\n?)+)/m.exec(design)?.[1] ?? ''
  return [...block.matchAll(/^[ \t]+([A-Za-z0-9_-]+):\s*["']?(#[0-9a-fA-F]{3,8})["']?/gm)].map(match => [match[1]!, match[2]!])
}

const NAMED: Record<Exclude<RoleName, 'on-accent' | 'link'>, RegExp> = {
  bg: /^(bg|background|page|paper|canvas|desk|base)$/i,
  surface: /^(surface|panel|card|tile|sheet|raised?)$/i,
  text: /^(text|ink|fg|foreground|body)$/i,
  muted: /muted|secondary|subtle/i,
  accent: /^(accent|primary|brand)$/i,
  rule: /^(rule|line|border|divider|hairline)$/i,
}

/**
 * Roles for a DESIGN.md that is not one of the presets, from its colour names.
 * A role with no clear owner is left out, and the kit falls back to system
 * colours for it rather than guess a brand colour wrong.
 */
export function guessRoles(colours: Array<[string, string]>): Roles {
  const roles: Roles = {}
  const pick = (role: keyof typeof NAMED): void => {
    const found = colours.find(([name]) => NAMED[role].test(name))
    if (found !== undefined) roles[role] = found[0]
  }
  for (const role of Object.keys(NAMED) as Array<keyof typeof NAMED>) pick(role)
  roles.bg ??= colours[0]?.[0]
  const hex = (name: string | undefined): string | undefined => colours.find(([key]) => key === name)?.[1]
  const bg = hex(roles.bg)
  if (roles.text === undefined && bg !== undefined) {
    // The colour that reads best on the page is its text.
    const best = [...colours].sort((a, b) => (contrastRatio(b[1], bg) ?? 0) - (contrastRatio(a[1], bg) ?? 0))[0]
    if (best !== undefined && (contrastRatio(best[1], bg) ?? 0) >= 7) roles.text = best[0]
  }
  if (roles.accent !== undefined) {
    const on = colours.find(([name]) => name === `on-${roles.accent}`)
    roles['on-accent'] = on?.[0] ?? roles.bg
    const accent = hex(roles.accent)
    roles.link = accent !== undefined && bg !== undefined && (contrastRatio(accent, bg) ?? 0) >= 4.5 ? roles.accent : roles.text
  }
  return roles
}

function roleLines(roles: Roles): string[] {
  const lines = ROLE_NAMES.filter(role => roles[role] !== undefined).map(role => `  --k-${role}: var(--${roles[role]});`)
  // The motion kit's two colours follow the same roles unless the preset set them.
  return lines
}

/** The first `:root { … }` block of a page's stylesheet, brace-matched. */
export function rootBlock(html: string): string | undefined {
  const start = html.search(/:root\s*\{/)
  if (start < 0) return undefined
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) return html.slice(open + 1, i)
  }
  return undefined
}

/**
 * `tokens.css` for a preset: the example page's own `:root` block, which is
 * hand-tuned and already audited, plus the kit's role names.
 */
export function presetTokens(id: string, example: string, roles: Roles): string {
  const body = (rootBlock(example) ?? '').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('--k-')).map(line => `  ${line}`)
  return [
    `/* ${KIT_MARK}: tokens.css. Written by ux_kit from the "${id}" preset.`,
    '   The only place a colour value is written. Change a token here and in DESIGN.md together.',
    '   In your stylesheet use var(--name), never a hex value. */',
    ':root {',
    ...body,
    '  /* roles the kit files read (base.css, diagram.js) */',
    ...roleLines(roles),
    '}',
    '',
  ].join('\n')
}

/** `tokens.css` for a DESIGN.md the project already had. */
export function designTokens(colours: Array<[string, string]>, roles: Roles): string {
  return [
    `/* ${KIT_MARK}: tokens.css. Written by ux_kit from this project's DESIGN.md.`,
    '   Change a token here and in DESIGN.md together. In your stylesheet use var(--name), never a hex value. */',
    ':root {',
    ...colours.map(([name, value]) => `  --${name}: ${value};`),
    '  /* roles the kit files read (base.css, diagram.js) */',
    ...roleLines(roles),
    ...(roles.link === undefined ? [] : ['  --m-accent: var(--k-link);']),
    ...(roles.surface === undefined ? [] : ['  --m-surface: var(--k-surface);']),
    '}',
    '',
  ].join('\n')
}

/** The Google Fonts stylesheet an example page loads, if any. */
export function fontsHref(example: string): string | undefined {
  return /href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/.exec(example)?.[1]
}

const RECIPES: Record<PresetKind, string[]> = {
  doc: [
    'A page to read. One `h1` with `data-words`, a contents list, then sections that each open with an `h2 data-sweep`.',
    'Every diagram is `<figure data-diagram><pre>` + lines such as `User -> Router: prompt` + `</pre><figcaption>…</figcaption></figure>`. Never place a box or an arrow by hand, and never draw a diagram as your own `<svg>`. Add `step: A, B | what happens` lines for a walkthrough.',
    'Key numbers go in `<span data-count>`, a timeline in `<ol data-rail>` with `data-dot` markers, wide tables inside `<div class="scroll-x">`.',
    '`data-load` on the other first-screen blocks, `data-arrive` on every card, row and callout below the first screen.',
  ],
  app: [
    'A screen people work in. One primary action per view; numbers that line up use `tabular-nums`.',
    'Key numbers in `<span data-count>`, bars with `data-fill`, rows and cards with `data-arrive`, filters with `data-filter` and `aria-pressed`.',
    'Every table sits in `<div class="scroll-x">` and has an empty state; every form control has a `<label>`; show loading and error states.',
    'Motion that follows the pointer is off here (`data-pointer="off"` on `<html>`): people work in this screen for hours. Hover and focus states stay.',
  ],
  page: [
    'A page that presents. `data-words` on the headline, `data-load` on the other first-screen blocks, `data-arrive` on every item below the first screen.',
    'One signature element, in the form the preset\'s Signature section describes, made from this subject. Real copy, no placeholder text.',
    'Vary the motion by content: numbers count (`data-count`), bars fill (`data-fill`), lists arrive from a side (`data-arrive="left"`).',
  ],
}

export interface StartOptions {
  request: string
  /** Workspace root: nothing is written outside it. */
  cwd: string
  /** Folder for the page, relative to `cwd` or absolute inside it. */
  dir?: string
  /** A preset id, when the user names one. */
  preset?: string
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false)
}

/** Copy a kit file unless the folder already has one; returns what happened. */
async function place(source: string, target: string, written: string[], kept: string[]): Promise<void> {
  if (await exists(target)) {
    kept.push(target)
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  written.push(target)
}

export async function startKit(options: StartOptions): Promise<string> {
  const request = options.request.trim()
  if (request === '') throw new Error('Pass `request`: the user\'s own words for this UI, verbatim. The preset is chosen from them.')
  const dir = resolvePath(options.cwd, options.dir ?? '.')
  if (!inside(options.cwd, dir)) throw new Error(`\`dir\` must be inside the working directory (${options.cwd}).`)
  const table = manifest()
  if (options.preset !== undefined && table.presets[options.preset] === undefined) {
    throw new Error(`Unknown preset "${options.preset}". Presets: ${Object.keys(table.presets).join(', ')}. Leave \`preset\` out to choose from the request.`)
  }

  const stack = detectStack(dir)
  // A framework app serves static files from public/; a plain page keeps them beside it.
  const assets = stack.framework === 'html' ? dir : join(dir, 'public')
  const designPath = join(dir, 'DESIGN.md')
  const written: string[] = []
  const kept: string[] = []
  const lines: string[] = []
  let kind: PresetKind
  let exampleNote = ''
  let fonts: string | undefined
  let htmlAttributes = 'lang="en"'
  let tokenNames: string[] = []

  const existing = await readFile(designPath, 'utf8').catch(() => undefined)
  const routed = routePreset(request)
  if (existing !== undefined) {
    // The project's contract stands; the request only says what kind of page this is.
    const colours = designColours(existing)
    kind = routed.kind ?? table.presets[routed.preset]?.kind ?? 'page'
    lines.push(`ux_kit: DESIGN.md already exists in ${dir} — it is the design system, kept as it is. Read all of it; no preset was applied.`)
    if (colours.length > 0 && !(await exists(join(assets, 'tokens.css')))) {
      await mkdir(assets, { recursive: true })
      await writeFile(join(assets, 'tokens.css'), designTokens(colours, guessRoles(colours)))
      written.push(join(assets, 'tokens.css'))
    }
    tokenNames = colours.map(([name]) => `--${name}`)
  } else if (stack.system !== undefined && options.preset === undefined) {
    kind = routed.kind ?? table.presets[routed.preset]?.kind ?? 'app'
    lines.push(`ux_kit: ${stack.system} is installed in ${dir} — its tokens are the design system, so no preset was applied.`)
    lines.push('Write those real tokens (colours, radius, type) into DESIGN.md before any markup; never invent new ones.')
  } else {
    const id = options.preset ?? routed.preset
    const preset = table.presets[id]!
    // The row that matched may say what kind of page this is; a named preset speaks for itself.
    kind = (options.preset === undefined ? routed.kind : undefined) ?? preset.kind
    const example = await readFile(presetFile(id, 'example.html'), 'utf8')
    await mkdir(dir, { recursive: true })
    await copyFile(presetFile(id, 'DESIGN.md'), designPath)
    written.push(designPath)
    const tokens = join(assets, 'tokens.css')
    if (await exists(tokens)) kept.push(tokens)
    else {
      await mkdir(assets, { recursive: true })
      await writeFile(tokens, presetTokens(id, example, preset.roles))
      written.push(tokens)
    }
    fonts = fontsHref(example)
    htmlAttributes = /<html([^>]*)>/.exec(example)?.[1]?.trim() ?? htmlAttributes
    tokenNames = [...(rootBlock(example) ?? '').matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(match => match[1]!).filter(name => !name.startsWith('--k-') && !name.startsWith('--m-'))
    const why = options.preset !== undefined ? 'named in the call' : routed.word === null ? 'no table word matched, so the fallback' : `the request says "${routed.word}"`
    lines.push(`ux_kit: preset \`${id}\` (${why}). Kind: ${kind === 'doc' ? 'a page to read' : kind === 'app' ? 'a screen people work in' : 'a page that presents'}.`)
    exampleNote = presetFile(id, 'example.html')
  }

  const kit = [...table.kit, ...(kind === 'doc' ? table.docKit : [])]
  for (const file of kit) await place(kitFile(file), join(assets, file), written, kept)

  const show = (paths: string[]): string => paths.map(path => relative(dir, path) || '.').join(', ')
  if (written.length > 0) lines.push(`Wrote in ${dir}: ${show(written)}.`)
  if (kept.length > 0) lines.push(`Already there, left alone: ${show(kept)}.`)
  lines.push('Do not edit or retype these files. Every colour in your own CSS is `var(--name)` from tokens.css; a hex value outside it fails `ux_audit`.')
  lines.push('')

  const steps: string[] = []
  if (existing === undefined && stack.system === undefined) steps.push('Add your `Direction:` line under the frontmatter of DESIGN.md: `Direction: <concept> · signature: <element> · motion: <load> + <scroll>`. Keep its palette and fonts.')
  if (exampleNote !== '') steps.push(`Read ${exampleNote} once. It shows this preset's layout, states and motion markup working; build your page in that shape with your own content.`)
  if (stack.framework === 'html') {
    const head = [
      `<html ${htmlAttributes}>`,
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>…</title>',
      ...(fonts === undefined ? [] : ['<link rel="preconnect" href="https://fonts.googleapis.com">', `<link rel="stylesheet" href="${fonts}">`]),
      '<link rel="stylesheet" href="tokens.css">',
      '<link rel="stylesheet" href="base.css">',
      '<link rel="stylesheet" href="styles.css">',
      '<link rel="stylesheet" href="motion.css">',
      '</head>',
    ]
    const scripts = kit.filter(file => file.endsWith('.js')).map(file => `<script src="${file}"></script>`).join('')
    steps.push(`Write the page and your own styles.css (layout and components only). Use exactly this head, in this order, and end <body> with ${scripts}:\n${head.join('\n')}`)
  } else {
    steps.push([
      `This is a ${stack.framework === 'next' ? 'Next' : 'React'} app, so the kit is in public/. Link /tokens.css, /base.css and /motion.css in the root layout (or index.html), before your own CSS.`,
      'Load the scripts from one client component at the root, after hydration:',
      `'use client'; import { useEffect } from 'react'; export const Kit = () => { useEffect(() => { for (const src of [${kit.filter(file => file.endsWith('.js')).map(file => `'/${file}'`).join(', ')}]) document.body.append(Object.assign(document.createElement('script'), { src })) }, []); return null }`,
      'Give list rows a stable `key`. `data-words` and `data-count` need one plain string child.',
    ].join('\n'))
  }
  // Seen live: with no pointer to the table, flash read motion.js itself (five reads) to learn the attributes.
  const references = [packageFile('skills', 'ux-design', 'references', 'motion.md'), ...(kind === 'doc' ? [packageFile('skills', 'ux-design', 'references', 'diagram.md')] : [])]
  steps.push(`${RECIPES[kind].join('\n')}\nThe attributes are listed in ${references.join(' and ')}. Read that, not the kit's source.`)
  const page = stack.framework === 'html' ? pathToFileURL(join(dir, 'index.html')).href : 'http://localhost:<port>/'
  steps.push(`When the page renders, call ux_audit { "url": "${page}", "path": "${stack.framework === 'html' ? relative(options.cwd, join(dir, 'styles.css')) || 'styles.css' : '<your stylesheet>'}", "motion": true } and look at the screenshots. Fix every finding and run it again until both verdicts are PASS.`)
  if (stack.framework === 'html') steps.push('If the user wants one file to send or open offline, finish with ux_kit { "action": "bundle", "page": "<the page>" }.')
  for (const [index, step] of steps.entries()) lines.push(`${index + 1}. ${step}`)
  if (tokenNames.length > 0) lines.push('', `Tokens: ${tokenNames.join(' ')}`)
  return lines.join('\n')
}

const LINK_TAG = /<link\b[^>]*>/gi
const SCRIPT_TAG = /<script\b([^>]*)\bsrc=(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi

function isLocal(reference: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)
}

/**
 * One self-contained page: every local stylesheet and script inlined, so the
 * file can be sent or opened offline. Remote URLs (fonts) are left as links.
 */
export async function bundlePage(options: { cwd: string; page: string; out?: string }): Promise<string> {
  const page = resolvePath(options.cwd, options.page)
  if (!inside(options.cwd, page)) throw new Error(`\`page\` must be inside the working directory (${options.cwd}).`)
  const html = await readFile(page, 'utf8').catch(() => undefined)
  if (html === undefined) throw new Error(`Cannot read page: ${page}`)
  const base = dirname(page)
  const inlined: string[] = []
  const missing: string[] = []
  const load = async (reference: string): Promise<string | undefined> => {
    const target = resolvePath(base, reference.replace(/[?#].*$/, ''))
    const text = await readFile(target, 'utf8').catch(() => undefined)
    if (text === undefined) missing.push(reference)
    else inlined.push(reference)
    return text
  }

  let result = html
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (!/\brel=(["'])stylesheet\1/i.test(tag)) continue
    const href = /\bhref=(["'])([^"']+)\1/i.exec(tag)?.[2]
    if (href === undefined || !isLocal(href)) continue
    const css = await load(href)
    // A closing tag inside the text would end the element early.
    if (css !== undefined) result = result.replace(tag, () => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`)
  }
  for (const match of [...html.matchAll(SCRIPT_TAG)]) {
    const src = match[3]!
    if (!isLocal(src)) continue
    const js = await load(src)
    if (js !== undefined) result = result.replace(match[0], () => `<script${match[1]}${match[4]}>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`.replace(/<script\s+>/, '<script>'))
  }

  const extension = extname(page)
  const out = resolvePath(options.cwd, options.out ?? `${page.slice(0, page.length - extension.length)}.single${extension || '.html'}`)
  if (!inside(options.cwd, out)) throw new Error(`\`out\` must be inside the working directory (${options.cwd}).`)
  if (out === page) throw new Error('`out` is the page itself. Pick another name so the source stays editable.')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, result)
  const lines = [`ux_kit bundle: wrote ${out} (${Math.round(Buffer.byteLength(result) / 1024)} KB) with ${inlined.length} file(s) inlined: ${inlined.join(', ') || 'none'}.`]
  if (missing.length > 0) lines.push(`NOT inlined, file not found: ${missing.join(', ')}. The single file is incomplete until these exist.`)
  const remote = [...result.matchAll(/(?:href|src)=(["'])(https?:\/\/[^"']+)\1/gi)].map(match => new URL(match[2]!).host)
  if (remote.length > 0) lines.push(`Still loaded from the network: ${[...new Set(remote)].join(', ')}. Offline, fonts fall back to the stack in tokens.css.`)
  lines.push(`Keep editing ${relative(options.cwd, page) || options.page}, then bundle again. Check the single file once: ux_audit { "url": "${pathToFileURL(out).href}" }.`)
  return lines.join('\n')
}

/** Whether this session may write files: not in plan mode, not in a read-only sandbox. */
function writeRefusal(ctx: PluginContext, exec: ToolRunContext): string | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  if (planActive(ctx, agent)) return 'ux_kit writes files, and this session is in plan mode. Name the call in your plan and run it after the plan is approved.'
  const mode = (sessionSandboxPolicy(ctx, agent.session) as { mode?: unknown } | undefined)?.mode
  if (mode === 'read-only') return 'ux_kit writes files, and this session is read-only. Say in your reply which call should be run.'
  return undefined
}

export function registerKitTool(ctx: PluginContext): void {
  registerToolSafe(ctx, ceulenTool({
    name: 'ux_kit',
    description: 'Start UI work, or bundle a finished page. No model call. `action: "start"` (default): call it FIRST for any new page, screen, explainer or report, before writing markup. Pass the user\'s request verbatim; it picks the design preset from the words, then writes DESIGN.md, tokens.css and the kit files (base.css for focus, disabled and touch-target states; motion.js + motion.css; diagram.js for explainers) into the folder, and returns the head to paste, the token names, a recipe for this kind of page, and the ux_audit call to run next. An existing DESIGN.md or installed design system is kept, never replaced. `action: "bundle"`: inline a page\'s local CSS and JS into one self-contained HTML file to send or open offline.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['start', 'bundle'], description: 'start (default) or bundle.' },
      request: { type: 'string', description: 'start: the user\'s own words for this UI, verbatim, in their language. The preset is chosen from them.' },
      dir: { type: 'string', description: 'start: folder for the page, inside the working directory. Default: the working directory.' },
      preset: { type: 'string', description: 'start: a preset id, ONLY when the user names one. Otherwise leave it out.' },
      page: { type: 'string', description: 'bundle: the HTML page to make self-contained.' },
      out: { type: 'string', description: 'bundle: output path. Default: <page>.single.html beside the page.' },
    }),
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { action?: string; request?: string; dir?: string; preset?: string; page?: string; out?: string }
      const refusal = writeRefusal(ctx, exec)
      if (refusal !== undefined) throw new Error(refusal)
      const cwd = cwdOf(exec)
      if (args.action === 'bundle' || (args.action === undefined && typeof args.page === 'string' && args.request === undefined)) {
        if (typeof args.page !== 'string' || args.page.trim() === '') throw new Error('bundle needs `page`: the HTML file to make self-contained.')
        return bundlePage({ cwd, page: args.page.trim(), ...(typeof args.out === 'string' && args.out.trim() !== '' ? { out: args.out.trim() } : {}) })
      }
      return startKit({
        request: typeof args.request === 'string' ? args.request : '',
        cwd,
        ...(typeof args.dir === 'string' && args.dir.trim() !== '' ? { dir: args.dir.trim() } : {}),
        ...(typeof args.preset === 'string' && args.preset.trim() !== '' ? { preset: args.preset.trim() } : {}),
      })
    },
  }))
}
