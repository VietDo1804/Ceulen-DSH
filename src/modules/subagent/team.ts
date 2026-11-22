/**
 * The team ledger of orchestrator mode: who the lead dispatched, in which
 * wave, with which brief, and what the lead decided at each checkpoint. One
 * ledger serves the mode itself (checkpoints, `/orchestrator status`) and the
 * Team side panel, so the panel never shows a second opinion. Pure: no host,
 * no timers.
 */
import { parseTodos, type TodoItem } from '../todoview/index.js'

/** What the lead decided about one activation after its wave's checkpoint. */
export type Decision = 'accepted' | 'corrected' | 'taken over'

/** One run of a child inside a wave: its first brief, or a correction. */
export interface TeamEntry {
  readonly childId: string
  kind: 'brief' | 'fix'
  /** `running`, or the stop reason of this activation. */
  state: string
  readonly startedAt: number
  endedAt?: number
  decision?: Decision
}

/** Children dispatched or resumed between two checkpoints. */
export interface TeamWave {
  readonly index: number
  readonly startedAt: number
  readonly entries: TeamEntry[]
  /** When its checkpoint fired; the lead reviews from then on. */
  settledAt?: number
}

/** The lead's plan file and where it stands with the user. */
export interface TeamPlan {
  /** Relative to the lead's working directory. */
  readonly path: string
  readonly title: string
  /** Task ids the plan lists (T1, T2, …). */
  readonly tasks: readonly string[]
  /** `draft` until the user approves it; `advisor` while the advisor reads it; `review` while the approval card is open. */
  readonly state: 'draft' | 'advisor' | 'review' | 'approved'
}

export interface TeamBrief {
  /** The plan task(s) this child carries out. */
  readonly task?: string
  readonly goal?: string
  readonly scope?: string
  readonly acceptance?: string
}

export interface TeamChild {
  readonly id: string
  readonly role: string
  readonly label: string
  readonly brief: TeamBrief
  corrections: number
  /** The lead's last message to it: a correction to settled work, or an answer mid-run. */
  note?: { readonly kind: 'fix' | 'answer'; readonly text: string }
  /** From the handoff report the child sent back. */
  status?: 'done' | 'partial' | 'blocked'
  blocker?: string
}

export interface TeamState {
  readonly leadId: string
  readonly route?: string
  readonly startedAt: number
  /** The lead's own turn is running. */
  busy: boolean
  /**
   * A checkpoint the lead still owes a review: `queued` while its notice waits
   * for the lead's next turn, `seen` once a turn has it. The lead can sit idle
   * for a while in between (an advisor pass, a queued message).
   */
  review: 'none' | 'queued' | 'seen'
  plan?: TeamPlan
  board?: readonly TodoItem[]
  /** The contract file, relative to the lead's working directory. */
  contract?: string
  readonly children: Map<string, TeamChild>
  readonly waves: TeamWave[]
  checkpoints: number
  corrections: number
  takeovers: number
  /** Files the lead took over, as it named them. */
  readonly takenOver: string[]
}

export type TeamPhase = 'plan' | 'contract' | 'dispatch' | 'review' | 'done'

const FIELD = (name: string): RegExp => new RegExp(`^[\\s>*#-]*(?:\\*\\*|__)?${name}(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?[ \\t]*(.*)$`, 'im')
const PLAN = FIELD('Plan')
const GOAL = FIELD('Goal')
const SCOPE = FIELD('Scope')
const ACCEPTANCE = FIELD('Acceptance')
const STATUS = /^[\s>*#-]*(?:\*\*|__)?STATUS(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(done|partial|blocked)\b/gim
const BLOCKERS = FIELD('BLOCKERS')
/** A correction usually opens with a courtesy line; the gap it names is what the panel should show. */
const GAP = FIELD('(?:Gap|Fix|Problem|Issue)')
const LINE_CELLS = 160

function firstLine(text: string): string | undefined {
  const line = text.split('\n').map(part => part.replace(/[*_`]+/g, '').trim()).find(part => part !== '')
  return line === undefined ? undefined : line.slice(0, LINE_CELLS)
}

/** A labelled field's text: the rest of its line, or the next non-empty line. */
function field(pattern: RegExp, text: string): string | undefined {
  const match = pattern.exec(text)
  if (match === null) return undefined
  return firstLine(match[1] ?? '') ?? firstLine(text.slice(match.index + match[0].length))
}

/** Plan task ids named on a brief's `Plan:` line. */
export function briefTasks(task: string): string[] {
  const match = PLAN.exec(task)
  return match === null ? [] : [...new Set((match[1] ?? '').match(/\bT\d+\b/g) ?? [])]
}

export function parseBrief(task: string): TeamBrief {
  const tasks = briefTasks(task)
  const goal = field(GOAL, task)
  const scope = field(SCOPE, task)
  const acceptance = field(ACCEPTANCE, task)
  return {
    ...(tasks.length === 0 ? {} : { task: tasks.join(' ') }),
    ...(goal === undefined ? {} : { goal }),
    ...(scope === undefined ? {} : { scope }),
    ...(acceptance === undefined ? {} : { acceptance }),
  }
}

/** STATUS and BLOCKERS of a handoff report; the last STATUS line wins. */
export function parseReport(text: string): { status?: TeamChild['status']; blocker?: string } {
  let status: TeamChild['status']
  for (const match of text.matchAll(STATUS)) status = match[1]!.toLowerCase() as TeamChild['status']
  const raw = field(BLOCKERS, text)
  const blocker = raw === undefined || /^(?:none\b|no\b|n\/a|[-—]\s*$)/i.test(raw) ? undefined : raw
  return { ...(status === undefined ? {} : { status }), ...(blocker === undefined ? {} : { blocker }) }
}

const openWave = (state: TeamState): TeamWave | undefined => {
  const last = state.waves[state.waves.length - 1]
  return last === undefined || last.settledAt !== undefined ? undefined : last
}

const lastEntry = (state: TeamState, childId: string): TeamEntry | undefined => {
  for (let wave = state.waves.length - 1; wave >= 0; wave--) {
    const entries = state.waves[wave]!.entries
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.childId === childId) return entries[index]
  }
  return undefined
}

/** `running`, or the stop reason of the child's latest activation. */
export const childState = (state: TeamState, childId: string): string => lastEntry(state, childId)?.state ?? 'running'

export const runningEntries = (state: TeamState): TeamEntry[] => state.waves.flatMap(wave => wave.entries.filter(entry => entry.state === 'running'))

/** Where the lead is in its loop; `done` once everything settled, was reviewed, and its turn ended. */
export function phaseOf(state: TeamState): TeamPhase {
  // Scouts sent out before the plan is approved are part of planning.
  if (state.plan !== undefined && state.plan.state !== 'approved') return 'plan'
  if (runningEntries(state).length > 0) return 'dispatch'
  if (state.waves.length > 0) return state.busy || state.review !== 'none' ? 'review' : 'done'
  if (state.plan === undefined) return 'plan'
  return state.contract === undefined ? 'contract' : 'dispatch'
}

export class TeamStore {
  private readonly leads = new Map<string, TeamState>()
  private readonly owners = new Map<string, TeamState>()
  private readonly listeners = new Set<() => void>()
  private latest: string | undefined
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Changes on every mutation; `useSyncExternalStore` snapshot. */
  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A broken view must not stop the ledger.
      }
    }
  }

  get size(): number {
    return this.leads.size
  }

  get(leadId: string | undefined): TeamState | undefined {
    return leadId === undefined ? undefined : this.leads.get(leadId)
  }

  /** The team of the session the user is on, else the newest one. */
  current(focus?: string): TeamState | undefined {
    return this.get(focus) ?? this.get(this.latest)
  }

  leadOfChild(childId: string): TeamState | undefined {
    return this.owners.get(childId)
  }

  open(leadId: string, route: string | undefined, now: number): TeamState {
    let state = this.leads.get(leadId)
    if (state === undefined) {
      state = {
        leadId, ...(route === undefined ? {} : { route }), startedAt: now, busy: false, review: 'none',
        children: new Map(), waves: [], checkpoints: 0, corrections: 0, takeovers: 0, takenOver: [],
      }
      this.leads.set(leadId, state)
    }
    this.latest = leadId
    this.emit()
    return state
  }

  close(leadId: string): void {
    const state = this.leads.get(leadId)
    if (state === undefined) return
    this.leads.delete(leadId)
    for (const childId of state.children.keys()) this.owners.delete(childId)
    if (this.latest === leadId) this.latest = [...this.leads.keys()].pop()
    this.emit()
  }

  reset(): void {
    this.leads.clear()
    this.owners.clear()
    this.latest = undefined
    this.emit()
  }

  /** Work the lead neither corrected nor took over is accepted once it moves on. */
  private accept(state: TeamState): void {
    for (const wave of state.waves) {
      if (wave.settledAt === undefined) continue
      for (const entry of wave.entries) {
        if (entry.decision !== undefined || entry.state !== 'completed') continue
        // A blocker the lead never answered is not an accepted result.
        if (state.children.get(entry.childId)?.status === 'blocked') continue
        entry.decision = 'accepted'
      }
    }
  }

  private enter(state: TeamState, childId: string, kind: TeamEntry['kind'], now: number): void {
    let wave = openWave(state)
    if (wave === undefined) {
      // Dispatching again is moving on from the last checkpoint.
      this.accept(state)
      state.review = 'none'
      wave = { index: state.waves.length + 1, startedAt: now, entries: [] }
      state.waves.push(wave)
    }
    const entry = wave.entries.find(item => item.childId === childId)
    if (entry === undefined) wave.entries.push({ childId, kind, state: 'running', startedAt: now })
    else if (entry.state !== 'running') {
      // Resumed before its wave's checkpoint: the same row, now a fix.
      entry.kind = kind
      entry.state = 'running'
      entry.endedAt = undefined
      entry.decision = undefined
    }
  }

  /** A new child joins the open wave. `ended` is set when it stopped before its id came back. */
  dispatch(leadId: string, childId: string, role: string, label: string, task: string, now: number, ended?: string): void {
    const state = this.leads.get(leadId)
    if (state === undefined) return
    state.children.set(childId, { id: childId, role, label, brief: parseBrief(task), corrections: 0 })
    this.owners.set(childId, state)
    this.enter(state, childId, 'brief', now)
    if (ended !== undefined) this.settle(childId, ended, now)
    else this.emit()
  }

  /** A settled child runs again (a `send_message` reached it). */
  resume(childId: string, now: number): boolean {
    const state = this.owners.get(childId)
    if (state === undefined) return false
    this.enter(state, childId, 'fix', now)
    this.emit()
    return true
  }

  settle(childId: string, stop: string, now: number): TeamState | undefined {
    const state = this.owners.get(childId)
    const entry = state === undefined ? undefined : lastEntry(state, childId)
    if (state === undefined || entry === undefined) return undefined
    entry.state = stop
    entry.endedAt = now
    this.emit()
    return state
  }

  /** Close the open wave once nothing in it runs; returns its roster for the notice. */
  checkpoint(leadId: string, now: number): { role: string; label: string; state: string; id: string }[] | undefined {
    const state = this.leads.get(leadId)
    const wave = state === undefined ? undefined : openWave(state)
    if (state === undefined || wave === undefined || wave.entries.length === 0) return undefined
    if (wave.entries.some(entry => entry.state === 'running')) return undefined
    wave.settledAt = now
    state.checkpoints += 1
    state.review = state.busy ? 'seen' : 'queued'
    this.emit()
    return wave.entries.map(entry => {
      const child = state.children.get(entry.childId)!
      return { role: child.role, label: child.label, state: entry.state, id: entry.childId }
    })
  }

  /** The plan file as it stands: a draft, under the user's review, or approved. */
  setPlan(leadId: string, plan: TeamPlan | undefined): void {
    const state = this.leads.get(leadId)
    if (state === undefined) return
    const old = state.plan
    if (old?.path === plan?.path && old?.title === plan?.title && old?.state === plan?.state && old?.tasks.join() === plan?.tasks.join()) return
    state.plan = plan
    this.emit()
  }

  board(leadId: string, raw: unknown): void {
    const state = this.leads.get(leadId)
    const todos = parseTodos(raw)
    if (state === undefined || todos === undefined) return
    state.board = todos
    this.emit()
  }

  contract(leadId: string, path: string): void {
    const state = this.leads.get(leadId)
    if (state === undefined || state.contract === path) return
    state.contract = path
    this.emit()
  }

  setBusy(leadId: string, busy: boolean): void {
    const state = this.leads.get(leadId)
    if (state === undefined || state.busy === busy) return
    state.busy = busy
    if (busy && state.review === 'queued') state.review = 'seen'
    else if (!busy && state.review === 'seen') {
      // The turn that had the checkpoint is over: what it left alone is accepted.
      this.accept(state)
      state.review = 'none'
    }
    this.emit()
  }

  /** The lead wrote to a child: a correction when its work had settled, an answer while it runs. */
  message(leadId: string, childId: string, text: string): void {
    const state = this.leads.get(leadId)
    const child = state?.children.get(childId)
    const entry = state === undefined ? undefined : lastEntry(state, childId)
    if (state === undefined || child === undefined || entry === undefined) return
    const line = field(GAP, text) ?? firstLine(text) ?? ''
    if (entry.state === 'running') {
      child.note = { kind: 'answer', text: line }
    } else {
      child.note = { kind: 'fix', text: line }
      child.corrections += 1
      state.corrections += 1
      entry.decision = 'corrected'
      // The old report described the work that is now being redone.
      child.status = undefined
      child.blocker = undefined
    }
    this.emit()
  }

  /** The result a child sent back. */
  report(childId: string, text: string): void {
    const child = this.owners.get(childId)?.children.get(childId)
    if (child === undefined) return
    const { status, blocker } = parseReport(text)
    if (status === undefined && blocker === undefined) return
    child.status = status ?? child.status
    child.blocker = blocker
    this.emit()
  }

  /** The lead declared a takeover; a child whose Scope names one of the files is marked. */
  takeover(leadId: string, files: readonly string[]): void {
    const state = this.leads.get(leadId)
    if (state === undefined) return
    state.takeovers += 1
    for (const file of files) if (!state.takenOver.includes(file)) state.takenOver.push(file)
    for (const child of state.children.values()) {
      const scope = child.brief.scope
      if (scope === undefined || !files.some(file => scope.includes(file))) continue
      const entry = lastEntry(state, child.id)
      if (entry !== undefined && entry.state !== 'running') entry.decision = 'taken over'
    }
    this.emit()
  }
}

/** Shared by the mode (writer) and the Team panel (reader); both live in this bundle. */
export const team = new TeamStore()
