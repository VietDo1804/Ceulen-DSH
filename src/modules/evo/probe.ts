/**
 * Evo probe (M4-1): refining a harness without a reference run made agents
 * worse (Harness²: code 73.4 → 63.2). This module runs one candidate rule
 * against a recorded task twice — base vs candidate worktrees — and writes a
 * contrast record. The apply path refuses a proposal that has no record.
 *
 * The orchestration is pure over a `ProbeRunner` so the gate is testable
 * without git, children, or a network; the evo module supplies the real one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProbeMetrics {
  toolErrors: number
  denials: number
  steps: number
  outputTokens: number
  wallMs: number
  diffLines: number
}

export interface ContrastFixture {
  id: string
  base: ProbeMetrics
  cand: ProbeMetrics
}

export type ContrastVerdict = 'adopt' | 'reject' | 'split' | 'inconclusive'

export interface Contrast {
  schemaVersion: 1
  proposal: string
  /** sha256 of the proposal text the probe measured (absent on legacy records). */
  proposalHash?: string
  k: number
  generatedAt: string
  fixtures: ContrastFixture[]
  verdict: ContrastVerdict
}

export interface ProbeFixture {
  id: string
  task: string
}

export interface ProbeRunner {
  /** `git -C cwd <args>` → stdout. */
  git(args: string[], cwd: string): Promise<string>
  /** Start a worker child in `cwd`; resolves with the child id. */
  spawn(task: { label: string; prompt: string; cwd: string }): Promise<string>
  /** Wait for a child to settle and return its measured session. */
  collect(childId: string, options: { cwd: string; timeoutMs: number }): Promise<ProbeMetrics>
  /** Write the candidate rule into the worktree's own rules file. */
  applyCandidate(worktree: string, rule: string): Promise<void>
  now(): number
}

export interface ProbeOptions {
  proposalName: string
  proposalHash?: string
  /** The candidate rule text applied in the `-cand` worktree only. */
  rule: string
  fixtures: readonly ProbeFixture[]
  k: number
  repoRoot: string
  probeRoot?: string
  timeoutMs?: number
}

const emptyMetrics = (): ProbeMetrics => ({ toolErrors: 0, denials: 0, steps: 0, outputTokens: 0, wallMs: 0, diffLines: 0 })

function average(runs: readonly ProbeMetrics[]): ProbeMetrics {
  if (runs.length === 0) return emptyMetrics()
  const sum = (pick: (metrics: ProbeMetrics) => number): number => runs.reduce((total, metrics) => total + pick(metrics), 0)
  return {
    toolErrors: Math.round(sum(metrics => metrics.toolErrors) / runs.length),
    denials: Math.round(sum(metrics => metrics.denials) / runs.length),
    steps: Math.round(sum(metrics => metrics.steps) / runs.length),
    outputTokens: Math.round(sum(metrics => metrics.outputTokens) / runs.length),
    wallMs: Math.round(sum(metrics => metrics.wallMs) / runs.length),
    diffLines: Math.round(sum(metrics => metrics.diffLines) / runs.length),
  }
}

/**
 * Per-fixture comparison, never one blended score: fewer tool errors wins; a
 * tie falls back to denials, then steps. A tie on all three is no signal.
 */
export function compareMetrics(base: ProbeMetrics, cand: ProbeMetrics): -1 | 0 | 1 {
  if (cand.toolErrors !== base.toolErrors) return cand.toolErrors < base.toolErrors ? -1 : 1
  if (cand.denials !== base.denials) return cand.denials < base.denials ? -1 : 1
  if (cand.steps !== base.steps) return cand.steps < base.steps ? -1 : 1
  return 0
}

/** `inconclusive` is a first-class verdict: one contrast is evidence, not proof. */
export function verdictFor(fixtures: readonly ContrastFixture[]): ContrastVerdict {
  if (fixtures.length === 0) return 'inconclusive'
  const signs = fixtures.map(fixture => compareMetrics(fixture.base, fixture.cand))
  if (signs.every(sign => sign === -1)) return 'adopt'
  if (signs.every(sign => sign === 1)) return 'reject'
  if (signs.some(sign => sign === -1) && signs.some(sign => sign === 1)) return 'split'
  return 'inconclusive'
}

/** Pure: transcript events -> the six metrics (same event shapes as evo-distill). */
export function sessionMetrics(events: readonly unknown[]): ProbeMetrics {
  const metrics = emptyMetrics()
  let started = 0
  let ended = 0
  const textOf = (message: unknown): string => {
    const record = message as { content?: unknown; text?: unknown } | null
    const parts = Array.isArray(record?.content) ? record.content : []
    const text = parts
      .filter((part): part is { type?: string; text?: string } => part !== null && typeof part === 'object')
      .filter(part => part.type === 'text')
      .map(part => part.text ?? '')
      .join(' ')
    return text.length > 0 ? text : typeof record?.text === 'string' ? record.text : ''
  }
  for (const raw of events) {
    const event = raw as { type?: string; time?: number; data?: Record<string, unknown> } | null
    if (event === null || typeof event !== 'object') continue
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > 0 && (started === 0 || time < started)) started = time
    if (time > ended) ended = time
    switch (event.type) {
      case 'step/start':
        metrics.steps += 1
        break
      case 'assistant/message': {
        const usage = data.usage as { totalTokens?: number } | undefined
        const total = Number(usage?.totalTokens ?? 0)
        if (Number.isFinite(total) && total > metrics.outputTokens) metrics.outputTokens = total
        break
      }
      case 'tool/result': {
        const meta = data.meta as { ok?: boolean; calls?: { name?: string }[] } | undefined
        const message = data.message as { isError?: boolean } | undefined
        if (meta?.ok === false || message?.isError === true) metrics.toolErrors += 1
        if (/denied|blocked by rule/i.test(textOf(data.message))) metrics.denials += 1
        break
      }
      default:
        break
    }
  }
  metrics.wallMs = started > 0 && ended > started ? ended - started : 0
  return metrics
}

async function worktreeDiffLines(runner: ProbeRunner, worktree: string): Promise<number> {
  try {
    // Intent-to-add so a new (untracked) rule file counts as a change too.
    await runner.git(['add', '-N', '.'], worktree).catch(() => undefined)
    const out = await runner.git(['diff', '--numstat', 'HEAD'], worktree)
    return out
      .split('\n')
      .filter(line => line.trim().length > 0)
      .reduce((total, line) => {
        const [added, removed] = line.split('\t')
        return total + (Number(added) || 0) + (Number(removed) || 0)
      }, 0)
  } catch {
    return 0
  }
}

/**
 * One base/candidate pair per fixture per run. `k` repeats a pair; metrics are
 * averaged, because one contrast is evidence, not proof.
 */
export async function runProbe(options: ProbeOptions, runner: ProbeRunner): Promise<Contrast> {
  const probeRoot = options.probeRoot ?? join(options.repoRoot, '.probe')
  const runs = Math.max(1, Math.floor(options.k))
  const timeoutMs = options.timeoutMs ?? 20 * 60_000
  const fixtures: ContrastFixture[] = []

  for (const fixture of options.fixtures) {
    const baseRuns: ProbeMetrics[] = []
    const candRuns: ProbeMetrics[] = []
    for (let index = 0; index < runs; index += 1) {
      const suffix = runs > 1 ? `-r${index + 1}` : ''
      const baseDir = join(probeRoot, `${fixture.id}-base${suffix}`)
      const candDir = join(probeRoot, `${fixture.id}-cand${suffix}`)
      try {
        await runner.git(['worktree', 'add', '--detach', baseDir, 'HEAD'], options.repoRoot)
        await runner.git(['worktree', 'add', '--detach', candDir, 'HEAD'], options.repoRoot)
        await runner.applyCandidate(candDir, options.rule)
        const [baseId, candId] = await Promise.all([
          runner.spawn({ label: `probe ${fixture.id} base`, prompt: fixture.task, cwd: baseDir }),
          runner.spawn({ label: `probe ${fixture.id} cand`, prompt: fixture.task, cwd: candDir }),
        ])
        const [baseMetrics, candMetrics] = await Promise.all([
          runner.collect(baseId, { cwd: baseDir, timeoutMs }),
          runner.collect(candId, { cwd: candDir, timeoutMs }),
        ])
        baseMetrics.diffLines = await worktreeDiffLines(runner, baseDir)
        candMetrics.diffLines = await worktreeDiffLines(runner, candDir)
        baseRuns.push(baseMetrics)
        candRuns.push(candMetrics)
      } finally {
        await runner.git(['worktree', 'remove', '--force', baseDir], options.repoRoot).catch(() => undefined)
        await runner.git(['worktree', 'remove', '--force', candDir], options.repoRoot).catch(() => undefined)
      }
    }
    fixtures.push({ id: fixture.id, base: average(baseRuns), cand: average(candRuns) })
  }

  return {
    schemaVersion: 1,
    proposal: options.proposalName,
    ...(options.proposalHash === undefined ? {} : { proposalHash: options.proposalHash }),
    k: runs,
    generatedAt: new Date(runner.now()).toISOString(),
    fixtures,
    verdict: verdictFor(fixtures),
  }
}

/** `proposal-2026-10-29.md` → `contrast-proposal-2026-10-29.json`. */
export function contrastName(proposalName: string): string {
  return `contrast-${proposalName.replace(/\.md$/i, '')}.json`
}

export function writeContrast(reportsDir: string, contrast: Contrast): string {
  mkdirSync(reportsDir, { recursive: true })
  const file = join(reportsDir, contrastName(contrast.proposal))
  writeFileSync(file, `${JSON.stringify(contrast, null, 2)}\n`)
  return file
}

export function readContrast(reportsDir: string, proposalName: string): Contrast | undefined {
  const file = join(reportsDir, contrastName(proposalName))
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Contrast
  } catch {
    return undefined
  }
}

/** Compact table for the command output and the ledger line. */
export function formatContrast(contrast: Contrast): string {
  const row = (label: string, metrics: ProbeMetrics): string =>
    `  ${label.padEnd(6)} errors ${String(metrics.toolErrors).padStart(2)} · denials ${String(metrics.denials).padStart(2)} · steps ${String(metrics.steps).padStart(3)} · tokens ${String(metrics.outputTokens).padStart(6)} · wall ${Math.round(metrics.wallMs / 1000)}s · diff ${metrics.diffLines}`
  return [
    `contrast ${contrast.proposal} · k=${contrast.k} · verdict ${contrast.verdict}`,
    ...contrast.fixtures.flatMap(fixture => [
      `fixture ${fixture.id}`,
      row('base', fixture.base),
      row('cand', fixture.cand),
    ]),
  ].join('\n')
}

/** Fixtures are ledger entries that recorded their original task prompt. */
export function readFixtures(ledgerPath: string, ids?: readonly string[]): ProbeFixture[] {
  let text = ''
  try {
    text = readFileSync(ledgerPath, 'utf8')
  } catch {
    return []
  }
  const wanted = ids === undefined || ids.length === 0 ? undefined : new Set(ids)
  const fixtures: ProbeFixture[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry: { session_id?: unknown; task?: unknown }
    try {
      entry = JSON.parse(line) as { session_id?: unknown; task?: unknown }
    } catch {
      continue
    }
    const id = typeof entry.session_id === 'string' ? entry.session_id : ''
    const task = typeof entry.task === 'string' ? entry.task.trim() : ''
    if (id === '' || task === '' || seen.has(id)) continue
    if (wanted !== undefined && !wanted.has(id)) continue
    seen.add(id)
    fixtures.push({ id, task })
  }
  return fixtures
}
