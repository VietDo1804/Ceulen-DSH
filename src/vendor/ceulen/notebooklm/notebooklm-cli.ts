// The `notebooklm` CLI runner (notebooklm-py) — the single seam the module and
// its tests go through (gh/sg pattern). Zero deps.
//
// Env contract: NO_COLOR/CLICOLOR_FORCE pinned OFF — the user's
// CLICOLOR_FORCE=1 otherwise colorizes piped `--json` output and breaks parsing.
//
// stdin is /dev/null on purpose: the CLI prompts for confirmation on some
// destructive paths, and a tool call must never be able to block on a prompt.
// With stdin closed, Click's confirm() hits EOF and fails fast.

import { spawn, spawnSync } from 'node:child_process'

/** Default deadline for one notebooklm invocation. */
export const NOTEBOOKLM_TIMEOUT_MS = 60_000
/** Ceiling a caller may request (Studio generation can legitimately be slow). */
export const NOTEBOOKLM_MAX_TIMEOUT_MS = 600_000
/** Captured-output cap per stream. */
export const NOTEBOOKLM_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const TRUNCATION_MARKER = '\n[notebooklm output truncated after 2 MiB]\n'

export interface NotebooklmCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when the deadline fired or the caller aborted. */
  killed: boolean
}

/** The seam every call goes through — swapped for a fake in tests. */
export interface NotebooklmRunner {
  /** Run notebooklm; does NOT throw on non-zero exit. */
  run(cwd: string, args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<NotebooklmCommandResult>
}

/** notebooklm with color forced OFF. */
export function notebooklmEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' }
}

let availableCache: boolean | undefined

/** True when the notebooklm CLI is installed (cached after the first probe). */
export function notebooklmAvailable(): boolean {
  if (availableCache !== undefined) return availableCache
  try {
    const probe = spawnSync('notebooklm', ['--version'], { stdio: 'ignore', timeout: 10_000 })
    availableCache = probe.error === undefined && probe.status === 0
  } catch {
    availableCache = false
  }
  return availableCache
}

/** Test hook: forget the probe (module state outlives a test). */
export function resetNotebooklmAvailability(): void {
  availableCache = undefined
}

export const realNotebooklm: NotebooklmRunner = {
  run(cwd, args, signal, timeoutMs = NOTEBOOKLM_TIMEOUT_MS) {
    if (!notebooklmAvailable()) {
      return Promise.reject(new Error("notebooklm CLI not found in PATH — install with: uv tool install 'notebooklm-py[browser]'"))
    }
    const deadlineMs = Math.min(timeoutMs, NOTEBOOKLM_MAX_TIMEOUT_MS)
    return new Promise<NotebooklmCommandResult>((resolveP, rejectP) => {
      const child = spawn('notebooklm', args, {
        cwd,
        env: notebooklmEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let outTotal = 0
      let errTotal = 0
      let killed = false
      // The child is killed by hand (not through spawn's signal option) so the
      // partial output captured so far still resolves instead of rejecting.
      const kill = (): void => {
        killed = true
        child.kill('SIGTERM')
      }
      const timer = setTimeout(kill, deadlineMs)
      signal?.addEventListener('abort', kill, { once: true })
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', kill)
      }
      child.stdout!.on('data', (chunk: Buffer) => {
        outTotal += chunk.length
        if (outTotal <= NOTEBOOKLM_OUTPUT_LIMIT_BYTES) out.push(chunk)
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        errTotal += chunk.length
        if (errTotal <= NOTEBOOKLM_OUTPUT_LIMIT_BYTES) err.push(chunk)
      })
      child.on('error', error => {
        done()
        rejectP(error)
      })
      child.on('close', code => {
        done()
        const stdout = Buffer.concat(out).toString('utf8') + (outTotal > NOTEBOOKLM_OUTPUT_LIMIT_BYTES ? TRUNCATION_MARKER : '')
        const stderr = Buffer.concat(err).toString('utf8') + (errTotal > NOTEBOOKLM_OUTPUT_LIMIT_BYTES ? TRUNCATION_MARKER : '')
        resolveP({ exitCode: code ?? -1, stdout, stderr, killed })
      })
    })
  },
}
