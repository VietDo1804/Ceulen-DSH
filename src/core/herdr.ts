/**
 * Herdr helpers shared by the bundled herdr skill, `/ceulen doctor`, and the
 * `delegate` herdr runner.
 *
 * Herdr (a terminal multiplexer for coding agents) injects HERDR_ENV=1,
 * HERDR_PANE_ID and HERDR_BIN_PATH into every pane it manages. Outside such a
 * pane (ACP/hermes delegation, the web profile, plain terminals) every helper
 * here reports "unavailable" and nothing calls the herdr binary for control.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { packageFile } from './paths.js'

/** Set to `off` in a pane (or a child's env) to keep ceulen from driving herdr. */
export const HERDR_OFF_ENV = 'CEULEN_HERDR'

/** Ceulen-owned blocks inside skills/herdr/SKILL.md; everything else is `herdr --skill` verbatim. */
export const NOTE_BEGIN = '<!-- ceulen-dsh:note -->'
export const NOTE_END = '<!-- /ceulen-dsh:note -->'
export const ADDENDUM_MARK = '<!-- ceulen-dsh:addendum (kept by scripts/herdr-skill-sync.mjs) -->'

export interface HerdrEnv {
  /** herdr binary: HERDR_BIN_PATH when herdr injected it, else `herdr` on PATH. */
  bin: string
  /** The pane this process runs in. */
  paneId: string
}

/** The herdr context this process may drive, or undefined outside a herdr pane / when switched off. */
export function herdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | undefined {
  if (env.HERDR_ENV !== '1' || env[HERDR_OFF_ENV] === 'off') return undefined
  const paneId = env.HERDR_PANE_ID?.trim()
  if (paneId === undefined || paneId === '') return undefined
  const bin = env.HERDR_BIN_PATH?.trim()
  return { bin: bin === undefined || bin === '' ? 'herdr' : bin, paneId }
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type HerdrExec = (file: string, args: readonly string[], timeoutMs?: number) => Promise<ExecResult>

function defaultExec(file: string, args: readonly string[], timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') })
    })
  })
}

/** Test seam: swap `run` to script the herdr CLI. */
export const herdrCli: { run: HerdrExec } = { run: defaultExec }

/**
 * Run one herdr control command and return the `.result` object of its JSON
 * reply. A herdr error (`{"error":{"code","message"}}`) or a non-zero exit
 * throws with herdr's own message.
 */
export async function herdrJson(bin: string, args: readonly string[], timeoutMs?: number): Promise<Record<string, unknown>> {
  const out = await herdrCli.run(bin, args, timeoutMs)
  const label = `herdr ${args.slice(0, 2).join(' ')}`
  let parsed: { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined
  try {
    parsed = JSON.parse(out.stdout) as typeof parsed
  } catch {
    parsed = undefined
  }
  if (parsed?.error !== undefined) {
    throw new Error(`${label}: ${String(parsed.error.message ?? parsed.error.code ?? 'error')}`)
  }
  if (out.code !== 0 || parsed === undefined) {
    throw new Error(`${label} failed: ${(out.stderr || out.stdout).trim().slice(0, 300) || `exit ${out.code}`}`)
  }
  const result = parsed.result
  return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {}
}

/** Bundled skill text with the ceulen note and addendum removed: what `herdr --skill` printed at sync time. */
export function upstreamPart(skill: string): string {
  const cut = skill.indexOf(ADDENDUM_MARK)
  let text = cut === -1 ? skill : skill.slice(0, cut)
  const begin = text.indexOf(NOTE_BEGIN)
  const end = text.indexOf(NOTE_END)
  if (begin !== -1 && end > begin) text = text.slice(0, begin).replace(/\n$/, '') + text.slice(end + NOTE_END.length)
  return text.trim()
}

/** The ceulen-owned note (after the frontmatter) and addendum (at the end) of a bundled skill. */
export function ceulenParts(skill: string): { note: string; addendum: string } {
  const begin = skill.indexOf(NOTE_BEGIN)
  const end = skill.indexOf(NOTE_END)
  const cut = skill.indexOf(ADDENDUM_MARK)
  return {
    note: begin !== -1 && end > begin ? skill.slice(begin + NOTE_BEGIN.length, end).trim() : '',
    addendum: cut === -1 ? '' : skill.slice(cut + ADDENDUM_MARK.length).trim(),
  }
}

/** Rebuild the bundled skill: upstream frontmatter, ceulen note, upstream body, ceulen addendum. */
export function composeSkill(upstream: string, note: string, addendum: string): string {
  const source = upstream.trim()
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)
  const head = frontmatter === null ? '' : frontmatter[0]
  const body = source.slice(head.length)
  const noteBlock = note.trim() === '' ? '' : `\n${NOTE_BEGIN}\n${note.trim()}\n${NOTE_END}`
  const tail = addendum.trim() === '' ? '' : `\n\n${ADDENDUM_MARK}\n\n${addendum.trim()}`
  return `${head}${noteBlock}${body}${tail}\n`
}

export function bundledSkillPath(): string {
  return packageFile('skills', 'herdr', 'SKILL.md')
}

/** `in sync`, a drift notice, or why the check could not run. */
export async function skillState(bin = herdrEnv()?.bin ?? 'herdr'): Promise<string> {
  let bundled: string
  try {
    bundled = readFileSync(bundledSkillPath(), 'utf8')
  } catch {
    return 'skill missing (skills/herdr/SKILL.md)'
  }
  const live = await herdrCli.run(bin, ['--skill'], 5_000)
  if (live.code !== 0 || live.stdout.trim() === '') return 'skill unchecked (herdr --skill unavailable)'
  return upstreamPart(bundled) === live.stdout.trim()
    ? 'skill in sync'
    : 'skill drift (run node scripts/herdr-skill-sync.mjs)'
}

/** Pick `version` under the `client:` / `server:` sections of `herdr status`. */
export function parseStatus(text: string): { client?: string; server?: string; running: boolean } {
  const section = (name: string): string => {
    const match = new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n?)*)`, 'm').exec(text)
    return match?.[1] ?? ''
  }
  const field = (block: string, key: string) => new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'm').exec(block)?.[1]
  const server = section('server')
  return { client: field(section('client'), 'version'), server: field(server, 'version'), running: field(server, 'status') === 'running' }
}

/** One `/ceulen doctor` line: versions, whether this process may drive herdr, skill drift. */
export async function doctorLine(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const context = herdrEnv(env)
  const bin = context?.bin ?? (env.HERDR_BIN_PATH?.trim() || 'herdr')
  const status = await herdrCli.run(bin, ['status'], 5_000)
  if (status.code !== 0 && status.stdout.trim() === '') return 'herdr: not installed (optional)'
  const parsed = parseStatus(status.stdout)
  const where = context !== undefined
    ? `pane ${context.paneId} (delegate runner:"herdr" available)`
    : env[HERDR_OFF_ENV] === 'off' ? `off (${HERDR_OFF_ENV}=off)` : 'not inside a herdr pane'
  const server = parsed.running ? `server ${parsed.server ?? '?'}` : 'server stopped'
  return `herdr: client ${parsed.client ?? '?'} · ${server} · ${where} · ${await skillState(bin)}`
}
