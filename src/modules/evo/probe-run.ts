import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  }): Promise<{
    readonly childId: unknown
    readonly result: Promise<{ readonly stopReason: string }>
    dispose(): Promise<void>
  }>
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

/** Exact child identity only: an old session with the same cwd is not evidence. */
function findSessionFile(childId: string): string | undefined {
  const root = join(dshHome(), 'sessions')
  try {
    for (const workspace of readdirSync(root)) {
      const direct = join(root, workspace, childId, 'session.v4.jsonl.zstd')
      if (existsSync(direct)) return direct
    }
  } catch {
    return undefined
  }
  return undefined
}

export function realProbeRunner(agent: AgentLike, subagents: SubagentRuntimeLike, signal: AbortSignal): ProbeRunner {
  const children = new Map<string, Awaited<ReturnType<SubagentRuntimeLike['startActivation']>>>()
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
      const id = String(activation.childId)
      children.set(id, activation)
      void activation.result.catch(() => undefined)
      return id
    },
    async collect(childId, options) {
      const child = children.get(childId)
      if (child === undefined) throw new Error(`unknown probe child ${childId}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: () => void = () => undefined
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error(`probe child ${childId} aborted`))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => reject(new Error(`probe child ${childId} timed out`)), options.timeoutMs)
        })
        const result = await Promise.race([child.result, interrupted])
        if (result.stopReason !== 'completed') throw new Error(`probe child ${childId} ended: ${result.stopReason}`)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        await child.dispose()
        children.delete(childId)
      }
      const file = findSessionFile(childId)
      if (file === undefined) throw new Error(`transcript missing for probe child ${childId}`)
      const metrics = sessionMetrics(transcriptEvents(file))
      if (metrics.steps === 0) throw new Error(`empty transcript for probe child ${childId}`)
      return metrics
    },
    async stop(childId) {
      const child = children.get(childId)
      if (child !== undefined) {
        await child.dispose()
        children.delete(childId)
      }
    },
    async verify(worktree, check, timeoutMs) {
      const [command, ...args] = check
      if (command === undefined) return false
      try {
        await run(command, args, { cwd: worktree, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, signal })
        return true
      } catch (error) {
        if (signal.aborted) throw error
        return false
      }
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
