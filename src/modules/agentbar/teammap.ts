/**
 * The team map: orchestrator mode as one picture, drawn under the Team panel's
 * rows when the panel has room left. Top to bottom, the way the work flows:
 * the lead, the plan's task list (owner, progress, where each task stands),
 * and one box per role with what that role has delivered.
 *
 * The rows above it answer "what happened in each wave"; the map answers
 * "where does every task of the plan stand, and who is busy". Pure: it reads
 * the ledger and the agent store and returns rows.
 */
import { phaseOf, runningEntries, type TeamChild, type TeamEntry, type TeamState, type TeamWave } from '../subagent/team.js'
import type { TodoItem } from '../todoview/index.js'
import type { AgentRow } from './model.js'
import type { PanelRow, Run, Tone } from './panel.js'

/** Narrower than this, a task row has no room for a title next to its state. */
export const MAP_CELLS = 40
/** Wider than this, the boxes stop growing and the map sits in the middle of the panel. */
export const MAP_SPAN = 76
/** How much of the picture is drawn: 0 everything, 1 without the lead box, 2 the task list only. */
export type MapTier = 0 | 1 | 2

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ROLE_ORDER = ['scout', 'planner', 'worker', 'tester', 'reviewer']
const ROLE_WORD = /\b(scout|planner|worker|tester|reviewer|lead)\b/i
const EFFORT: Readonly<Record<string, number>> = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 }
const TASK_ROWS = 10
const STATE_CELLS = 10
const TITLE_CELLS = 16
const MATE_MIN = 18
const MATE_MAX = 24
const MATE_GAP = 1

const zeroWidth = (code: number): boolean => (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)
const wide = (code: number): boolean => (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
  || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
  || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)
const charCells = (char: string): number => {
  const code = char.codePointAt(0)!
  return code < 0x300 ? 1 : zeroWidth(code) ? 0 : wide(code) ? 2 : 1
}

/** Terminal cells a string takes; a box only closes when every row is counted the same way. */
export function cells(text: string): number {
  let total = 0
  for (const char of text) total += charCells(char)
  return total
}

/** At most `width` cells, ending in `…` when cut. */
function clip(text: string, width: number): string {
  const whole = text.normalize('NFC')
  if (cells(whole) <= width) return whole
  let out = ''
  let used = 0
  for (const char of whole) {
    const next = charCells(char)
    if (used + next > width - 1) break
    out += char
    used += next
  }
  return width <= 0 ? '' : `${out}…`
}

const spaces = (count: number): string => ' '.repeat(Math.max(0, count))
/** Exactly `width` cells: cut, then padded on the right. */
const fit = (text: string, width: number): string => {
  const cut = clip(text, width)
  return cut + spaces(width - cells(cut))
}
const runCells = (runs: readonly Run[]): number => runs.reduce((total, run) => total + cells(run[0]), 0)

/** Runs cut to `width` cells; the run that crosses the edge is clipped, later ones are dropped. */
function clipRuns(runs: readonly Run[], width: number): Run[] {
  const out: Run[] = []
  let left = width
  for (const [text, tone] of runs) {
    if (left <= 0) break
    const cut = clip(text, left)
    out.push([cut, tone])
    left -= cells(cut)
  }
  return out
}

const padded = (runs: readonly Run[], width: number): Run[] => {
  const cut = clipRuns(runs, width)
  return [...cut, [spaces(width - runCells(cut)), undefined]]
}

const centered = (runs: readonly Run[], width: number): Run[] => {
  const cut = clipRuns(runs, width)
  const free = width - runCells(cut)
  return [[spaces(Math.floor(free / 2)), undefined], ...cut, [spaces(free - Math.floor(free / 2)), undefined]]
}

/** Neighbouring runs of one tone become one, and empty runs go: fewer cells for the host to lay out. */
function squash(runs: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const [text, tone] of runs) {
    if (text === '') continue
    const last = out[out.length - 1]
    if (last !== undefined && last[1] === tone) out[out.length - 1] = [last[0] + text, tone]
    else out.push([text, tone])
  }
  return out
}

/** A frame around lines that are each exactly `width - 4` cells. */
function boxed(width: number, lines: readonly (readonly Run[])[], tone: Tone, dashed = false): Run[][] {
  const flat = dashed ? '╌' : '─'
  const side = dashed ? '╎' : '│'
  return [
    [[`┌${flat.repeat(width - 2)}┐`, tone]],
    ...lines.map((line): Run[] => [[`${side} `, tone], ...line, [` ${side}`, tone]]),
    [[`└${flat.repeat(width - 2)}┘`, tone]],
  ]
}

/** The first wording that fits, so a narrow box says less and never ends in an ellipsis; the last one is clipped. */
const pick = (width: number, ...wordings: string[]): string => wordings.find(text => cells(text) <= width) ?? wordings[wordings.length - 1]!

const chip = (text: string, tone: Tone): Run[] => [['[ ', 'subtle'], [text, tone], [' ]', 'subtle']]
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
const shortModel = (route: string | undefined): string | undefined => route?.replace(/:[a-z]+$/i, '').split('/').pop()

/** Where one task of the plan stands. */
export interface TaskLine {
  readonly id: string
  readonly title: string
  readonly owner?: string
  readonly label: string
  readonly tone: Tone
  /** How far the bar is filled, 0..1; `undefined` while it runs with no todo list to measure. */
  readonly filled?: number
  readonly running: boolean
  readonly done: boolean
}

/** What one role has been given and has delivered. */
export interface Mate {
  readonly role: string
  readonly model?: string
  readonly total: number
  readonly done: number
  readonly running: number
  readonly review: number
  readonly trouble: number
  readonly corrections: number
}

const roleOf = (owner: string | undefined): string | undefined => {
  if (owner === undefined) return undefined
  return ROLE_WORD.exec(owner)?.[1]?.toLowerCase() ?? owner.split(/[\s(]/)[0]?.toLowerCase()
}

/** A board row or a delegate label without the task id, a `[role]` tag, a `(wave 2)` or a `worker:` in front. */
function tidy(text: string | undefined, id: string): string | undefined {
  if (text === undefined) return undefined
  const rest = text
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(new RegExp(`^\\s*${id}\\b`), '')
    .replace(/^\s*\((?:wave|w)\s*\d+\)/i, '')
    .replace(/^[\s:.)—–-]+/, '')
    .replace(/^(?:scout|planner|worker|tester|reviewer|lead)\s*[:—–-]\s+/i, '')
    .trim()
  return rest === '' ? undefined : rest
}

interface Hit { readonly wave: TeamWave; readonly entry: TeamEntry; readonly child: TeamChild }

/** The newest activation working on each task id. */
function hits(state: TeamState): Map<string, Hit> {
  const latest = new Map<string, Hit>()
  for (const wave of state.waves) {
    for (const entry of wave.entries) {
      const child = state.children.get(entry.childId)
      for (const id of child?.brief.task?.split(' ') ?? []) if (id !== '') latest.set(id, { wave, entry, child: child! })
    }
  }
  return latest
}

type Standing = Pick<TaskLine, 'label' | 'tone' | 'filled' | 'running' | 'done'>
const standing = (label: string, tone: Tone, filled: number | undefined, extra: { running?: boolean; done?: boolean } = {}): Standing =>
  ({ label, tone, ...(filled === undefined ? {} : { filled }), running: extra.running === true, done: extra.done === true })

function entryStanding({ wave, entry, child }: Hit, todos: readonly TodoItem[] | undefined): Standing {
  if (entry.state === 'running') {
    const measured = todos !== undefined && todos.length > 0 ? todos.filter(item => item.status === 'completed').length / todos.length : undefined
    return standing(entry.kind === 'fix' ? 'fixing' : 'running', entry.kind === 'fix' ? 'warning' : 'accent', measured, { running: true })
  }
  if (entry.decision === 'accepted') return standing('done', 'success', 1, { done: true })
  if (entry.decision === 'corrected') return standing('fix sent', 'warning', 0.5)
  if (entry.decision === 'taken over') return standing('taken over', 'warning', 1)
  if (entry.state === 'aborted') return standing('cancelled', 'warning', 0)
  if (entry.state !== 'completed') return standing('failed', 'error', 0)
  if (child.status === 'blocked') return standing('blocked', 'warning', 0.5)
  if (child.status === 'partial') return standing('partial', 'warning', 0.5)
  // Handed off inside a running wave; after the checkpoint it is the lead's to judge.
  return wave.settledAt === undefined ? standing('handed off', 'subtle', 1) : standing('in review', 'accent', 1)
}

/** The plan's tasks with where each stands: from the newest child on it, else from the board. */
export function taskLines(state: TeamState, agent: (id: string) => AgentRow | undefined): TaskLine[] {
  const plan = state.plan
  if (plan === undefined) return []
  const latest = hits(state)
  return plan.tasks.map(id => {
    const row = plan.rows?.find(item => item.id === id)
    const board = state.board?.find(item => new RegExp(`\\b${id}\\b`).test(item.content))
    const hit = latest.get(id)
    const owner = hit?.child.role ?? roleOf(row?.owner)
    const wave = row?.wave ?? Number(/\bwave\s*(\d+)/i.exec(board?.content ?? '')?.[1] ?? Number.NaN)
    const where: Standing = hit !== undefined
      ? entryStanding(hit, agent(hit.entry.childId)?.todos)
      : board?.status === 'completed'
        ? standing('done', 'success', 1, { done: true })
        : board?.status === 'in_progress'
          ? standing('briefing', 'accent', 0)
          : standing(Number.isInteger(wave) ? `wave ${wave}` : 'todo', 'subtle', 0)
    return {
      id,
      // A delegate label is written short; a board row is often a whole sentence.
      title: row?.title ?? tidy(hit?.child.label, id) ?? tidy(board?.content, id) ?? (row?.scope === undefined || /^read.?only$/i.test(row.scope) ? `${owner ?? 'task'} (read-only)` : row.scope),
      ...(owner === undefined ? {} : { owner }),
      ...where,
    }
  })
}

/** One entry per role that has a child or owns a task of the plan. */
export function mates(state: TeamState, agent: (id: string) => AgentRow | undefined): Mate[] {
  const byRole = new Map<string, { model?: string; total: number; done: number; running: number; review: number; trouble: number; corrections: number }>()
  const of = (role: string) => {
    let mate = byRole.get(role)
    if (mate === undefined) {
      mate = { total: 0, done: 0, running: 0, review: 0, trouble: 0, corrections: 0 }
      byRole.set(role, mate)
    }
    return mate
  }
  const newest = new Map<string, Hit>()
  for (const wave of state.waves) {
    for (const entry of wave.entries) {
      const child = state.children.get(entry.childId)
      if (child !== undefined) newest.set(child.id, { wave, entry, child })
    }
  }
  for (const hit of newest.values()) {
    const mate = of(hit.child.role)
    const where = entryStanding(hit, undefined)
    mate.total += 1
    mate.corrections += hit.child.corrections
    mate.model = agent(hit.child.id)?.model ?? mate.model
    if (where.running) mate.running += 1
    else if (where.done) mate.done += 1
    else if (where.label === 'in review' || where.label === 'handed off') mate.review += 1
    else if (where.label !== 'fix sent') mate.trouble += 1
  }
  // A task nobody was dispatched on yet still belongs to the role the plan names.
  const taken = hits(state)
  for (const task of state.plan?.rows ?? []) {
    const role = roleOf(task.owner)
    if (role === undefined || role === 'lead' || taken.has(task.id)) continue
    of(role).total += 1
  }
  const order = (role: string): number => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length)
  return [...byRole.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([role, mate]) => {
      const routed = state.routes?.[role]
      const model = shortModel(mate.model) ?? (routed === undefined || routed === 'parent route' ? shortModel(state.route) : shortModel(routed))
      return { role, ...mate, ...(model === undefined ? {} : { model }) }
    })
}

/** `◆` over `▼`: work flowing down. While it does, a highlight walks from one to the other. */
function link(width: number, tone: Tone, moving: boolean, frame: number): Run[][] {
  const step = Math.floor(frame / 3) % 4
  const top: Tone = !moving ? tone : step === 0 ? 'strong' : step === 1 ? 'accent' : 'subtle'
  const bottom: Tone = !moving ? tone : step === 2 ? 'strong' : step === 1 || step === 3 ? 'accent' : 'subtle'
  return [centered([['◆', top]], width), centered([['▼', bottom]], width)]
}

function leadChip(state: TeamState): Run {
  const phase = phaseOf(state)
  const last = state.waves[state.waves.length - 1]
  if (state.plan?.state === 'review') return ['the plan needs you', 'warning']
  if (state.plan?.state === 'advisor') return ['advisor is reading the plan', 'accent']
  if (phase === 'plan') return state.plan !== undefined ? ['plan draft', state.busy ? 'accent' : 'subtle'] : state.busy ? ['planning', 'accent'] : ['waiting for a task', 'subtle']
  if (phase === 'done') return ['report ready ✓', 'success']
  if (runningEntries(state).length > 0 && last !== undefined) return [`wave ${last.index} running`, 'accent']
  if (phase === 'review' && last !== undefined) return state.review === 'queued' && !state.busy ? [`wave ${last.index} awaits review`, 'accent'] : [`reviewing wave ${last.index}`, 'accent']
  return [`briefing wave ${state.waves.length + 1}`, state.busy ? 'accent' : 'subtle']
}

function leadBox(state: TeamState, width: number): Run[][] {
  const box = Math.min(width, Math.max(34, Math.min(48, width - 8)))
  const inner = box - 4
  const [text, tone] = leadChip(state)
  const frameTone: Tone = tone === 'subtle' ? 'subtle' : tone
  const lines: Run[][] = [
    centered([[shortModel(state.route) ?? 'lead', 'strong'], [' · ', 'subtle'], ['team lead', 'accent']], inner),
    centered(state.takeovers > 0
      ? [['splits the work · ', 'subtle'], [`took over ${plural(state.takenOver.length || state.takeovers, 'file')}`, 'warning']]
      : [[pick(inner, 'splits the work · never writes the code', 'never writes the code', 'does not code'), 'subtle']], inner),
  ]
  if (state.effort !== undefined) {
    const level = EFFORT[state.effort.toLowerCase()]
    lines.push(centered(level === undefined
      ? [['effort ', 'subtle'], [state.effort, undefined]]
      : [['effort ', 'subtle'], ['▮'.repeat(level), 'accent'], ['▯'.repeat(5 - level), 'subtle'], [` ${state.effort}`, undefined]], inner))
  }
  lines.push(centered(chip(text, tone), inner))
  const indent = spaces(Math.floor((width - box) / 2))
  return boxed(box, lines, frameTone, true).map(row => [[indent, undefined], ...row])
}

/** A task's bar: filled as far as it got; a sweep while it runs with nothing to measure. */
function taskBar(task: TaskLine, width: number, frame: number): Run[] {
  if (task.running && task.filled === undefined) {
    const head = frame % (width + 3)
    const from = Math.max(0, head - 3)
    const to = Math.min(width, head)
    return [['─'.repeat(from), 'subtle'], ['━'.repeat(to - from), task.tone], ['─'.repeat(width - to), 'subtle']]
  }
  const share = task.filled ?? 0
  const filled = share <= 0 ? 0 : Math.max(1, Math.round(share * width))
  return [['━'.repeat(filled), task.tone], ['─'.repeat(width - filled), 'subtle']]
}

function taskBox(state: TeamState, tasks: readonly TaskLine[], width: number, frame: number): Run[][] {
  const inner = width - 4
  const done = tasks.filter(task => task.done).length
  const all = done === tasks.length
  const idCells = Math.max(...tasks.map(task => cells(task.id)))
  const owners = Math.max(0, ...tasks.map(task => cells(task.owner ?? '')))
  let ownerCells = Math.min(9, owners)
  let rest = inner - (idCells + 1) - (STATE_CELLS + 1)
  // The owner column goes first when the title would be squeezed, then the bar.
  if (ownerCells > 0 && rest - (ownerCells + 2) < TITLE_CELLS) ownerCells = 0
  if (ownerCells > 0) rest -= ownerCells + 2
  const barCells = rest - 2 - TITLE_CELLS >= 6 ? Math.min(12, rest - 2 - TITLE_CELLS) : 0
  const titleCells = rest - (barCells > 0 ? barCells + 2 : 0)

  const stage = state.plan?.state
  const mark: Run[] = stage === 'review' ? chip('needs you', 'warning') : stage === 'advisor' ? chip('advisor', 'accent') : stage === 'draft' ? chip('draft', 'subtle')
    : all ? chip('✓', 'success') : chip(`${done}/${tasks.length}`, done > 0 ? 'accent' : 'subtle')
  const count: Run = [`tasks ${tasks.length}`, 'subtle']
  const head: Run[] = [['PLAN TASKS', all ? 'success' : 'strong'], ['  ', undefined], ...mark]
  const lines: Run[][] = [[...padded(head, inner - cells(count[0])), count]]

  // Around the first task still open, when the plan is longer than the box should be.
  const open = tasks.findIndex(task => !task.done)
  const start = tasks.length <= TASK_ROWS ? 0 : Math.max(0, Math.min((open < 0 ? tasks.length : open) - 1, tasks.length - TASK_ROWS))
  const shown = tasks.slice(start, start + TASK_ROWS)
  for (const [index, task] of shown.entries()) {
    const quiet = !task.running && !task.done && task.tone === 'subtle'
    const spin = task.running ? `${SPIN[(frame + index * 4) % SPIN.length]} ` : ''
    lines.push([
      [`${fit(task.id, idCells)} `, quiet ? 'subtle' : undefined],
      [fit(task.title, titleCells), quiet ? 'subtle' : undefined],
      ...(ownerCells > 0 ? [[`  ${fit(task.owner ?? '', ownerCells)}`, quiet ? 'subtle' : roleTone(task.owner)] as Run] : []),
      ...(barCells > 0 ? [['  ', undefined] as Run, ...taskBar(task, barCells, frame + index * 5)] : []),
      [` ${fit(`${spin}${task.label}`, STATE_CELLS)}`, task.tone],
    ])
  }
  if (tasks.length > shown.length) lines.push(padded([[`+${tasks.length - shown.length} more`, 'subtle']], inner))
  lines.push(padded([[pick(inner, 'the lead assigns · each wave is reviewed before the next', 'each wave is reviewed before the next', 'reviewed wave by wave'), 'subtle']], inner))
  const trouble = tasks.some(task => task.tone === 'warning' || task.tone === 'error')
  return boxed(width, lines, all ? 'success' : trouble ? 'warning' : tasks.some(task => task.running) ? 'accent' : 'subtle')
}

function roleTone(role: string | undefined): Tone {
  return role === 'worker' ? 'warning' : role === 'tester' || role === 'reviewer' ? 'accent' : undefined
}

function mateBox(mate: Mate, width: number, frame: number): Run[][] {
  const inner = width - 4
  const allDone = mate.total > 0 && mate.done === mate.total
  const state: Run[] = mate.running > 0
    ? chip(`${SPIN[frame % SPIN.length]} ${mate.running} running`, 'accent')
    : mate.trouble > 0
      ? chip(`${mate.trouble} stuck`, 'warning')
      : mate.review > 0
        ? chip('in review', 'accent')
        : mate.total > mate.done ? chip('waiting', 'subtle') : chip('idle', allDone ? 'success' : 'subtle')
  const filled = mate.total === 0 ? 0 : Math.round((mate.done / mate.total) * inner)
  const last: Run[] = mate.trouble > 0
    ? [['! ', 'warning'], [pick(inner - 2, `${mate.trouble} need${mate.trouble === 1 ? 's' : ''} the lead`, 'needs the lead', 'stuck'), 'warning']]
    : mate.corrections > 0
      ? [['↻ ', 'warning'], [plural(mate.corrections, 'correction'), 'subtle']]
      : [['✓ ', mate.done > 0 ? 'success' : 'subtle'], [pick(inner - 2, 'no corrections', 'clean'), 'subtle']]
  const lines: Run[][] = [
    centered([[mate.role, roleTone(mate.role) ?? 'strong']], inner),
    centered([[mate.model ?? 'route unknown', 'subtle']], inner),
    centered(state, inner),
    [['━'.repeat(filled), allDone ? 'success' : 'accent'], ['─'.repeat(inner - filled), 'subtle']],
    centered([[allDone ? `${plural(mate.total, 'task')} done` : `${mate.done}/${mate.total} tasks done`, allDone ? undefined : 'subtle']], inner),
    centered(last, inner),
  ]
  return boxed(width, lines, mate.running > 0 ? 'accent' : mate.trouble > 0 ? 'warning' : allDone ? 'success' : 'subtle')
}

function mateRows(team: readonly Mate[], children: number, width: number, frame: number): Run[][] {
  const per = Math.max(1, Math.min(3, team.length, Math.floor((width + MATE_GAP) / (MATE_MIN + MATE_GAP))))
  const box = Math.min(MATE_MAX, Math.floor((width - MATE_GAP * (per - 1)) / per))
  const size = children > 0 ? plural(children, 'subagent') : `${plural(team.length, 'role')} planned`
  const text: Run[] = [
    ['» ', 'accent'],
    [pick(width - 4, `team · ${size} · own context each · fixes by message`, `team · ${size} · own context each`, `team · ${size}`), 'subtle'],
    [' «', 'accent'],
  ]
  const rows: Run[][] = [centered(text, width), centered([['─'.repeat(Math.min(width, runCells(text))), 'subtle']], width)]
  for (let at = 0; at < team.length; at += per) {
    const group = team.slice(at, at + per)
    const indent = Math.floor((width - (box * group.length + MATE_GAP * (group.length - 1))) / 2)
    // One arrow over the middle of each box.
    const arrows: Run[] = [[spaces(indent), undefined]]
    for (const [index, mate] of group.entries()) {
      const before = Math.floor((box - 1) / 2)
      const moving = mate.running > 0
      const tone: Tone = moving ? (Math.floor(frame / 3) % 2 === 0 ? 'strong' : 'accent') : roleTone(mate.role) ?? 'subtle'
      arrows.push([spaces(before), undefined], ['▼', tone], [spaces(box - 1 - before + (index < group.length - 1 ? MATE_GAP : 0)), undefined])
    }
    rows.push(arrows)
    const boxes = group.map((mate, index) => mateBox(mate, box, frame + index * 4))
    for (let line = 0; line < boxes[0]!.length; line++) {
      const row: Run[] = [[spaces(indent), undefined]]
      for (const [index, lines] of boxes.entries()) {
        if (index > 0) row.push([spaces(MATE_GAP), undefined])
        row.push(...lines[line]!)
      }
      rows.push(row)
    }
  }
  return rows
}

/**
 * The map's rows for one moment, each exactly `width` cells or fewer. Empty
 * when there is nothing to draw yet (no plan and nobody dispatched) or the
 * panel is too narrow for a box.
 */
export function teamMap(state: TeamState | undefined, agent: (id: string) => AgentRow | undefined, panel: number, frame = 0, tier: MapTier = 0): PanelRow[] {
  if (state === undefined || panel < MAP_CELLS) return []
  const width = Math.min(panel, MAP_SPAN)
  const margin = spaces(Math.floor((panel - width) / 2))
  const tasks = taskLines(state, agent)
  const team = mates(state, agent)
  if (tasks.length === 0 && team.length === 0) return []
  const running = runningEntries(state).length > 0
  const done = phaseOf(state) === 'done'
  const flow: Tone = done ? 'success' : 'subtle'
  const rows: Run[][] = []
  if (tier === 0) rows.push(...leadBox(state, width), ...link(width, flow, state.busy, frame))
  if (tasks.length > 0) rows.push(...taskBox(state, tasks, width, frame))
  if (tier < 2 && team.length > 0) {
    if (tasks.length > 0) rows.push(...link(width, flow, running, frame + 2))
    rows.push(...mateRows(team, state.children.size, width, frame))
  }
  return rows.map(row => ({ left: squash([[margin, undefined], ...row]) }))
}
