import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import type { AgentLike } from '../../core/types.js'
import { dshHome } from '../../core/paths.js'
import { sessionMetrics, type ProbeMetrics, type ProbeRunner } from './probe.js'

const run = promisify(execFile)

/** Structural view of the DSH subagent service (same shape the subagent module uses). */
export interface SubagentRuntimeLike {
  startActivation(spec: {
    provider: string
    label: string
    request: Record<string, unknown>
    signal: AbortSignal
    delivery: 'parent'
  }): Promise<{ readonly childId: unknown }>
}

function transcriptEvents(file: string): unknown[] {
  let text: string
  try {
    text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  }
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
}

/** The child's transcript: by session id first, else by the worktree it ran in. */
function findSessionFile(childId: string, cwd: string): string | undefined {
  const root = join(dshHome(), 'sessions')
  try {
    for (const workspace of readdirSync(root)) {
      const direct = join(root, workspace, childId, 'session.v4.jsonl.zstd')
      if (existsSync(direct)) return direct
    }
  } catch {
    return undefined
  }
  try {
    for (const workspace of readdirSync(root)) {
      for (const entry of readdirSync(join(root, workspace))) {
        const file = join(root, workspace, entry, 'session.v4.jsonl.zstd')
        if (!existsSync(file)) continue
        const header = transcriptEvents(file).find(event => (event as { type?: string }).type === 'session') as { cwd?: string } | undefined
        if (header?.cwd === cwd) return file
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function collectSession(childId: string, cwd: string, timeoutMs: number): Promise<ProbeMetrics> {
  const start = Date.now()
  let lastSize = -1
  let stable = 0
  for (;;) {
    const file = findSessionFile(childId, cwd)
    if (file !== undefined) {
      const size = statSync(file).size
      if (size > 0 && size === lastSize) stable += 1
      else {
        stable = 0
        lastSize = size
      }
      // Two stable polls = the child stopped flushing; parse once.
      if (stable >= 2) {
        const metrics = sessionMetrics(transcriptEvents(file))
        if (metrics.steps > 0) return metrics
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`probe child ${childId} did not settle within ${Math.round(timeoutMs / 60_000)} min`)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

export function realProbeRunner(agent: AgentLike, subagents: SubagentRuntimeLike, signal: AbortSignal): ProbeRunner {
  return {
    async git(args, cwd) {
      const { stdout } = await run('git', ['-C', cwd, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      return String(stdout)
    },
    async spawn(task) {
      const request: Record<string, unknown> = {
        prompt: [{ type: 'text', text: task.prompt }],
        parent: agent,
        signal,
        cwd: task.cwd,
      }
      if (agent.options.provider !== undefined && agent.options.model !== undefined) {
        request.agentOptions = { provider: agent.options.provider, model: agent.options.model }
      }
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: task.label,
        request,
        signal,
        delivery: 'parent',
      })
      return String(activation.childId)
    },
    async collect(childId, options) {
      return await collectSession(childId, options.cwd, options.timeoutMs)
    },
    async applyCandidate(worktree, rule) {
      const dir = join(worktree, '.dsh')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'RULES.md')
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
      writeFileSync(file, `${existing}${existing.trim() === '' ? '' : '\n\n'}## Probe candidate\n${rule}\n`)
    },
    now: () => Date.now(),
  }
}
