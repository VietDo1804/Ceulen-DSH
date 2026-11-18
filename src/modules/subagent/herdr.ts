/**
 * `delegate` runner "herdr": the child runs as a one-shot headless DSH in a
 * visible herdr pane next to the caller.
 *
 * Herdr has no `dsh` agent kind, and an interactive DSH TUI renders on the
 * alternate screen, so the child is `dsh --profile headless --json` driven by
 * scripts/herdr-child.mjs inside the pane. That script prints progress for the
 * user, keeps the NDJSON events, and writes result.json, the only completion
 * evidence this side trusts (pane state is never treated as completion).
 *
 * The headless bundle disables the credential store and declares no
 * providers, so the run overlay re-enables `credentials`, copies the parent
 * profile's `llm-pi-ai` row, and pins the role route on `agent-default-model`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HERDR_OFF_ENV, herdrCli, herdrEnv, herdrJson } from '../../core/herdr.js'
import { ceulenHome, dshHome, packageFile } from '../../core/paths.js'
import { logLine } from '../../core/log.js'

export type HerdrPermission = 'read-only' | 'workspace-write'

export interface HerdrRoute {
  provider: string
  model: string
  effort?: string
}

export interface HerdrRunOptions {
  role: string
  label: string
  /** Full child prompt (persona, inherited policy, reply contract, task). */
  prompt: string
  cwd: string
  route: HerdrRoute | undefined
  permission: HerdrPermission
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  pollMs?: number
}

export interface HerdrRunResult {
  kind: 'herdr'
  subagentId: string
  pane: string
  exitCode: number
  text: string
  reason: string
  toolCalls: number
  permission: HerdrPermission
  runDir: string
  paneKept: boolean
}

interface ChildResult {
  exitCode?: number
  text?: string
  reason?: string
  error?: string
  toolCalls?: number
  aborted?: boolean
}

/** Panes of runs still in flight: the first split goes right of the caller, later ones stack below the last. */
const activePanes: string[] = []
let splitLock: Promise<unknown> = Promise.resolve()

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The profile this DSH process booted: `dsh --profile <name>` or `dsh <name>`. */
export function parentProfile(argv: readonly string[] = process.argv): string {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1]!
  const positional = argv[2]
  return positional !== undefined && !positional.startsWith('-') ? positional : 'tui'
}

/** The DSH launcher this process runs under, so the child uses the same install. */
function dshBinary(argv: readonly string[]): string {
  const script = argv[1]
  return script !== undefined && basename(script) === 'dsh' && existsSync(script) ? script : 'dsh'
}

/** Top-level `- id: <id>` rows of a patch file, verbatim (comments and `!!js` tags kept). */
export function patchRows(text: string, ids: readonly string[]): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^- id:\s*['"]?([\w-]+)['"]?\s*$/.exec(lines[i]!)
    if (head === null || !ids.includes(head[1]!)) continue
    out.push(lines[i]!)
    while (i + 1 < lines.length && !/^(- |\S)/.test(lines[i + 1]!)) out.push(lines[++i]!)
  }
  return out.join('\n').trimEnd()
}

export function overlayText(profilePatch: string, route: HerdrRoute | undefined): string {
  const parts = ['- id: credentials\n  disabled: false']
  const providers = patchRows(profilePatch, ['llm-pi-ai'])
  if (providers !== '') parts.push(providers)
  if (route !== undefined) {
    const effort = route.effort === undefined ? '' : `\n    reasoningEffort: ${JSON.stringify(route.effort)}`
    parts.push(`- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: ${JSON.stringify(route.provider)}\n    model: ${JSON.stringify(route.model)}${effort}`)
  }
  return `# ceulen delegate runner:"herdr" overlay over the headless profile\n${parts.join('\n')}\n`
}

function readProfilePatch(profile: string): string {
  try {
    return readFileSync(join(dshHome(), 'profiles', profile, 'cordis.patch.yml'), 'utf8')
  } catch {
    return ''
  }
}

function readResult(file: string): ChildResult | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ChildResult
  } catch {
    return undefined
  }
}

async function splitPane(bin: string, caller: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const run = splitLock.then(async () => {
    const anchor = activePanes.at(-1)
    const args = ['pane', 'split', anchor ?? caller, '--direction', anchor === undefined ? 'right' : 'down', '--cwd', cwd, '--no-focus', '--env', `${HERDR_OFF_ENV}=off`]
    const home = env.DSH_HOME?.trim()
    if (home !== undefined && home !== '') args.push('--env', `DSH_HOME=${home}`)
    const result = await herdrJson(bin, args)
    const pane = (result.pane as { pane_id?: unknown } | undefined)?.pane_id
    if (typeof pane !== 'string' || pane === '') throw new Error('herdr pane split returned no pane id')
    activePanes.push(pane)
    return pane
  })
  splitLock = run.catch(() => undefined)
  return run
}

function release(pane: string): void {
  const index = activePanes.indexOf(pane)
  if (index !== -1) activePanes.splice(index, 1)
}

async function paneAlive(bin: string, pane: string): Promise<boolean> {
  const out = await herdrCli.run(bin, ['pane', 'get', pane], 5_000)
  return !/pane_not_found/.test(out.stdout + out.stderr)
}

export async function runInHerdr(options: HerdrRunOptions): Promise<HerdrRunResult> {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const context = herdrEnv(env)
  if (context === undefined) {
    throw new Error('runner "herdr" needs this DSH to run inside a herdr pane (HERDR_ENV=1, not CEULEN_HERDR=off); omit runner to delegate natively')
  }
  const id = `${options.role}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const runDir = join(ceulenHome(), 'herdr-runs', id)
  mkdirSync(runDir, { recursive: true })
  const files = {
    assignment: join(runDir, 'assignment.md'),
    overlay: join(runDir, 'overlay.yml'),
    events: join(runDir, 'events.jsonl'),
    stderr: join(runDir, 'stderr.log'),
    result: join(runDir, 'result.json'),
  }
  writeFileSync(files.assignment, options.prompt)
  writeFileSync(files.overlay, overlayText(readProfilePatch(parentProfile(argv)), options.route))
  const route = options.route === undefined ? 'headless default' : `${options.route.provider}/${options.route.model}`
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({
    id,
    role: options.role,
    label: options.label,
    route,
    dsh: dshBinary(argv),
    cwd: options.cwd,
    permission: options.permission,
    ...files,
  }, null, 2)}\n`)

  const pane = await splitPane(context.bin, context.paneId, options.cwd, env)
  let finished = false
  try {
    await herdrCli.run(context.bin, ['pane', 'rename', pane, `ceulen:${options.role}`], 5_000)
    const command = [process.execPath, packageFile('scripts', 'herdr-child.mjs'), runDir].map(shellQuote).join(' ')
    // `pane run` prints nothing on success, so its reply is never JSON: check the exit code only.
    const admitted = await herdrCli.run(context.bin, ['pane', 'run', pane, command])
    if (admitted.code !== 0) throw new Error(`herdr pane run failed: ${(admitted.stderr || admitted.stdout).trim().slice(0, 300) || `exit ${admitted.code}`}`)
    logLine('subagent', `herdr ${id} started in ${pane} via ${route} (${options.permission})`)

    const pollMs = options.pollMs ?? 1_000
    let polls = 0
    let result: ChildResult | undefined
    for (;;) {
      result = readResult(files.result)
      if (result !== undefined) break
      if (options.signal?.aborted === true) {
        await herdrCli.run(context.bin, ['pane', 'send-keys', pane, 'ctrl+c'], 5_000)
        for (let i = 0; i < 20 && readResult(files.result) === undefined; i++) await sleep(250)
        throw new Error(`herdr child ${id} aborted (pane ${pane} left open)`)
      }
      polls++
      if (polls % 15 === 0 && !(await paneAlive(context.bin, pane))) {
        throw new Error(`herdr pane ${pane} closed before child ${id} finished; events in ${files.events}`)
      }
      await sleep(polls > 30 ? pollMs * 2 : pollMs)
    }
    finished = true
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1
    const ok = exitCode === 0 && result.error === undefined
    if (ok) await herdrCli.run(context.bin, ['pane', 'close', pane], 5_000)
    logLine('subagent', `herdr ${id} finished exit ${exitCode} in ${pane}${ok ? '' : ' (pane kept)'}`)
    return {
      kind: 'herdr',
      subagentId: id,
      pane,
      exitCode,
      text: result.text || result.error || '',
      reason: result.error === undefined ? (result.reason ?? 'completed') : `error: ${result.error}`,
      toolCalls: result.toolCalls ?? 0,
      permission: options.permission,
      runDir,
      paneKept: !ok,
    }
  } finally {
    release(pane)
    if (!finished) logLine('subagent', `herdr ${id} did not finish; pane ${pane} kept`)
  }
}
