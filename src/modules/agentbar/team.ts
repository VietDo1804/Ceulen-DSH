/**
 * The Team side panel of orchestrator mode. The Subagents panel answers "who
 * is running"; this one answers "how is the lead running the team": its loop,
 * the contract, each wave, what every child was briefed to do, and what the
 * lead decided at the checkpoint. It reads the mode's own ledger, plus the
 * agent store for a running child's model, todo and context.
 */
import { phaseOf, runningEntries, type TeamChild, type TeamEntry, type TeamPhase, type TeamState, type TeamStore, type TeamWave } from '../subagent/team.js'
import { logLine } from '../../core/log.js'
import { duration, type AgentRow, type AgentStore } from './model.js'
import { bar, usageLine, type PanelRow, type RowSource, type Run } from './panel.js'

export const TEAM_PANEL_ID = 'team'

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const STEPS: readonly { phase: TeamPhase; name: string }[] = [
  { phase: 'plan', name: 'Plan' },
  { phase: 'contract', name: 'Contract' },
  { phase: 'dispatch', name: 'Dispatch' },
  { phase: 'review', name: 'Review' },
  { phase: 'done', name: 'Report' },
]
/** The whole rail on one line needs this many cells. */
const RAIL_CELLS = 46
/** Below this a brief's Scope and Accept lines would be mostly ellipsis. */
const BRIEF_CELLS = 36
const NEXT_ROWS = 3

/**
 * Card density, raised until the body fits: 0 full briefs; 1 goal and todo
 * only; 2 also folds reviewed waves into one line; 3 one line per child.
 */
type Density = 0 | 1 | 2 | 3

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
/** `worker · T2 · Receipt options`: the plan task it carries out, when the brief names one. */
const nameOf = (child: TeamChild | undefined): string => (child === undefined
  ? 'subagent'
  : `${child.role} · ${child.brief.task === undefined ? '' : `${child.brief.task} · `}${child.label}`)
const shortRoute = (route: string | undefined): string | undefined => route?.split('/').pop()

/** A step the lead went past without doing: no approved plan, or no contract. */
function skipped(state: TeamState, phase: TeamPhase): boolean {
  if (phase === 'plan') return state.plan?.state !== 'approved'
  if (phase === 'contract') return state.contract === undefined
  return false
}

function rail(state: TeamState, width: number): PanelRow {
  const active = phaseOf(state)
  const at = STEPS.findIndex(step => step.phase === active)
  // Everything settled and the lead's turn over: the report is out too.
  const finished = active === 'done'
  if (width < RAIL_CELLS) {
    const step = STEPS[at]!
    return finished
      ? { left: [['  ', undefined], ['✓ ', 'success'], ['Reported', undefined]], right: [`${STEPS.length}/${STEPS.length}`, 'subtle'] }
      : { left: [['  ', undefined], ['▸ ', 'accent'], [step.name, 'strong']], right: [`${at + 1}/${STEPS.length}`, 'subtle'] }
  }
  const left: Run[] = [['  ', undefined]]
  for (const [index, step] of STEPS.entries()) {
    if (index > 0) left.push(['  ', undefined])
    if (!finished && index === at) left.push(['▸ ', 'accent'], [step.name, 'strong'])
    else if (finished || index < at) left.push([`${step.name} `, 'subtle'], skipped(state, step.phase) ? ['–', 'subtle'] : ['✓', 'success'])
    else left.push([step.name, 'subtle'])
  }
  return { left }
}

/** Reviewed work the lead has not decided on yet. */
const pending = (state: TeamState, wave: TeamWave): TeamEntry[] => wave.entries
  .filter(entry => entry.decision === undefined && entry.state === 'completed' && state.children.get(entry.childId)?.status !== 'blocked')

function waveTitle(state: TeamState, wave: TeamWave, now: number, frame: number): PanelRow {
  const left: Run[] = [[`WAVE ${wave.index}`, 'strong'], [' · ', 'subtle']]
  if (wave.settledAt === undefined) {
    return { left, shimmer: { text: 'running', phase: frame }, right: [duration(now - wave.startedAt), 'subtle'] }
  }
  const right: Run = [duration(wave.settledAt - wave.startedAt), 'subtle']
  if (pending(state, wave).length === 0) return { left: [...left, ['reviewed', 'subtle']], right }
  // Settled, but the lead has not started on it: an advisor pass or a queued message is ahead.
  if (state.review === 'queued' && !state.busy) return { left: [...left, ['awaiting review', 'accent']], right }
  return state.busy ? { left, shimmer: { text: 'in review', phase: frame }, right } : { left: [...left, ['in review', 'accent']], right }
}

const detail = (label: string, text: string, tone: Run[1] = 'subtle'): PanelRow => ({ left: [['    ', undefined], [label.padEnd(8), tone], [text, undefined]] })

function runningCard(state: TeamState, entry: TeamEntry, agent: AgentRow | undefined, now: number, width: number, frame: number, density: Density): PanelRow[] {
  const child = state.children.get(entry.childId)
  const rows: PanelRow[] = [{
    left: [[`${SPIN[frame % SPIN.length]} `, 'accent'], [nameOf(child), 'strong']],
    right: [duration(now - entry.startedAt), 'subtle'],
    agent: true,
  }]
  if (density === 3 || child === undefined) return rows
  // A correction replaces the brief: that is what the child is working on now.
  if (entry.kind === 'fix' && child.note?.kind === 'fix') rows.push(detail('Fix', child.note.text, 'warning'))
  else {
    if (child.brief.goal !== undefined) rows.push(detail('Goal', child.brief.goal))
    if (density === 0 && child.brief.scope !== undefined) rows.push(detail('Scope', child.brief.scope))
    if (density === 0 && child.brief.acceptance !== undefined) rows.push(detail('Accept', child.brief.acceptance))
    if (density === 0 && child.note?.kind === 'answer') rows.push(detail('Lead', child.note.text, 'accent'))
  }
  if (agent?.todos !== undefined && agent.todos.length > 0) {
    const done = agent.todos.filter(item => item.status === 'completed').length
    const cells = Math.max(6, Math.min(20, width - 20))
    rows.push({ left: [['    todo ', 'subtle'], ...bar(done, agent.todos.length, cells), [` ${done}/${agent.todos.length}`, 'subtle']] })
  }
  if (density === 0 && agent !== undefined) {
    const model = agent.model?.split('/').pop()
    const parts = [model === undefined ? undefined : agent.effort === undefined ? model : `${model} · ${agent.effort}`, usageLine(agent)].filter(part => part !== undefined)
    if (parts.length > 0) rows.push({ left: [['    ', undefined], [parts.join(' · '), 'subtle']] })
  }
  return rows
}

/** One settled activation: the lead's decision, or what stands in its way. */
function settledRows(state: TeamState, wave: TeamWave, entry: TeamEntry, density: Density): PanelRow[] {
  const child = state.children.get(entry.childId)
  const row = (mark: Run, outcome: Run): PanelRow => ({ left: [mark, [nameOf(child), 'subtle']], right: outcome, agent: true })
  if (entry.decision === 'accepted') return [row(['✓ ', 'success'], ['accepted', 'subtle'])]
  if (entry.decision === 'corrected') return [row(['↻ ', 'warning'], ['corrected', 'warning'])]
  if (entry.decision === 'taken over') return [row(['→ ', 'warning'], ['lead took over', 'warning'])]
  if (entry.state === 'aborted') return [row(['◌ ', 'warning'], ['cancelled', 'warning'])]
  if (entry.state !== 'completed') return [row(['✗ ', 'error'], ['failed', 'error'])]
  if (child?.status === 'blocked') {
    const rows = [row(['! ', 'warning'], ['blocked', 'warning'])]
    if (density < 3 && child.blocker !== undefined) rows.push(detail('Blocker', child.blocker, 'warning'))
    return rows
  }
  if (child?.status === 'partial') return [row(['◐ ', 'warning'], ['partial', 'warning'])]
  // Still inside a running wave: handed off, the checkpoint has not fired.
  return [wave.settledAt === undefined ? row(['✓ ', 'subtle'], ['handed off', 'subtle']) : row(['◦ ', 'accent'], ['in review', 'accent'])]
}

/** A reviewed wave on one line: `✓ WAVE 1 · 2 accepted · 1 corrected`. */
function foldedWave(wave: TeamWave): PanelRow {
  const count = (decision: TeamEntry['decision']): number => wave.entries.filter(entry => entry.decision === decision).length
  const failed = wave.entries.filter(entry => entry.decision === undefined).length
  const parts = [
    count('accepted') > 0 ? `${count('accepted')} accepted` : undefined,
    count('corrected') > 0 ? `${count('corrected')} corrected` : undefined,
    count('taken over') > 0 ? `${count('taken over')} taken over` : undefined,
    failed > 0 ? `${failed} open` : undefined,
  ].filter(part => part !== undefined)
  const clean = failed === 0 && count('corrected') === 0 && count('taken over') === 0
  return { left: [clean ? ['✓ ', 'success'] : ['◆ ', 'warning'], [`WAVE ${wave.index}`, 'subtle'], [' · ', 'subtle'], [parts.join(' · '), 'subtle']], agent: true }
}

function layout(state: TeamState, agent: (id: string) => AgentRow | undefined, now: number, width: number, frame: number, density: Density): PanelRow[] {
  const body: PanelRow[] = [rail(state, width)]
  if (state.plan !== undefined) {
    const stage: Run = state.plan.state === 'approved' ? ['approved', 'success'] : state.plan.state === 'review' ? ['needs you', 'warning'] : ['draft', 'subtle']
    body.push({ left: [['  plan     ', 'subtle'], [state.plan.title, undefined]], right: stage })
  }
  if (state.contract !== undefined) body.push({ left: [['  contract ', 'subtle'], [state.contract.replace(/\/contract\.md$/, ''), undefined]] })
  if (state.board !== undefined && state.board.length > 0) {
    const done = state.board.filter(item => item.status === 'completed').length
    const cells = Math.max(6, Math.min(20, width - 18))
    body.push({ left: [['  board    ', 'subtle'], ...bar(done, state.board.length, cells), [` ${done}/${state.board.length}`, 'subtle']] })
  }
  const phase = phaseOf(state)
  if (state.waves.length === 0) {
    body.push({ left: [] })
    if (state.plan?.state === 'review') body.push({ left: [['  ▸ ', 'warning'], ['The plan is waiting for your approval.', 'warning']] })
    else if (state.busy) body.push({ left: [['  ', undefined]], shimmer: { text: phase === 'plan' ? 'Planning…' : 'Preparing the first wave…', phase: frame } })
    else body.push({ left: [[phase === 'plan' ? '  Waiting for a task.' : '  Waiting for the lead.', 'subtle']] })
    body.push({ left: [['  The plan, each brief and each review show here.', 'subtle']] })
  }
  const lastClosed = state.waves.filter(wave => wave.settledAt !== undefined).pop()
  let running = 0
  for (const wave of state.waves) {
    const settledWave = wave.settledAt !== undefined && pending(state, wave).length === 0
    if (density >= 2 && settledWave && wave !== lastClosed) {
      body.push(foldedWave(wave))
      continue
    }
    body.push({ left: [] }, waveTitle(state, wave, now, frame))
    for (const entry of wave.entries) {
      if (entry.state === 'running') body.push(...runningCard(state, entry, agent(entry.childId), now, width, frame + running++ * 4, density))
      else body.push(...settledRows(state, wave, entry, density))
    }
  }
  const next = phase === 'done' ? [] : (state.board ?? []).filter(item => item.status === 'pending')
  if (next.length > 0 && state.waves.length > 0) {
    const shown = next.slice(0, density >= 2 ? 1 : NEXT_ROWS)
    body.push({ left: [] }, { left: [['NEXT', 'strong']] })
    for (const item of shown) body.push({ left: [['○ ', 'subtle'], [item.content, 'subtle']] })
    if (next.length > shown.length) body.push({ left: [['  ', undefined], [`+${next.length - shown.length} more`, 'subtle']] })
  }
  if (state.waves.length > 0) {
    body.push({ left: [] })
    for (const file of state.takenOver.slice(0, 2)) body.push({ left: [['→ ', 'warning'], [`lead took over ${file}`, 'warning']] })
    body.push({ left: [[`${plural(state.checkpoints, 'checkpoint')} · ${plural(state.corrections, 'correction')} · ${plural(state.takeovers, 'takeover')}`, 'subtle']] })
    if (phase === 'done') body.push({ left: [['The report is in the chat.', 'subtle']] })
  }
  return body
}

/**
 * Team panel rows for one moment. Given `room`, cards shrink until the body
 * fits if it can. Pure, so tests pin the layout without a host.
 */
export function teamRows(state: TeamState | undefined, agent: (id: string) => AgentRow | undefined, now: number, width: number, frame = 0, room = Number.POSITIVE_INFINITY): { header: PanelRow; body: PanelRow[] } {
  if (state === undefined) {
    return {
      header: { left: [['◆ ', 'subtle'], ['Team', 'strong']] },
      body: [{ left: [['Orchestrator mode is off.', 'subtle']] }, { left: [['/orchestrator on starts a team.', 'subtle']] }],
    }
  }
  const phase = phaseOf(state)
  const trouble = state.waves.some(wave => wave.entries.some(entry => entry.decision === undefined && entry.state !== 'running'
    && (entry.state !== 'completed' || state.children.get(entry.childId)?.status === 'blocked')))
  const openWaves = state.waves.filter(wave => wave.settledAt === undefined)
  const where = state.plan?.state === 'review' ? 'your approval' : phase === 'done' ? 'done' : phase === 'review' ? 'reviewing' : openWaves.length > 0 ? `wave ${openWaves[0]!.index}` : phase === 'plan' ? 'planning' : 'briefing'
  const model = width >= 34 ? shortRoute(state.route) : undefined
  const header: PanelRow = {
    left: [
      trouble || state.plan?.state === 'review' ? ['◆ ', 'warning'] : phase === 'done' ? ['✓ ', 'success'] : ['◆ ', 'accent'],
      ['Team', 'strong'],
      ...(model === undefined ? [] : [[` · ${model} lead`, 'subtle'] as Run]),
    ],
    right: [where, 'subtle'],
  }
  const densities: Density[] = width < BRIEF_CELLS ? [1, 2, 3] : [0, 1, 2, 3]
  let body: PanelRow[] = []
  for (const density of densities) {
    body = layout(state, agent, now, width, frame, density)
    if (body.length <= room) break
  }
  return { header, body }
}

/** The panel's source: the ledger for the session in focus, the agent store for live child detail. */
export function teamSource(teamStore: TeamStore, store: AgentStore, onTouch: () => void = () => {}): RowSource {
  const current = (): TeamState | undefined => teamStore.current(store.focusId)
  return {
    subscribe(listener) {
      const stops = [teamStore.subscribe(listener), store.subscribe(listener)]
      return () => {
        for (const stop of stops) stop()
      }
    },
    // Both counters only grow, so the sum changes whenever either store does.
    getVersion: () => teamStore.getVersion() + store.getVersion(),
    rows: (now, width, frame, room) => teamRows(current(), id => store.row(id), now, width, frame, room),
    animating() {
      const state = current()
      return state !== undefined && (state.busy || runningEntries(state).length > 0)
    },
    setVisible: visible => store.setTeamVisible(visible),
    touch: onTouch,
  }
}

/** The part of `ctx.tuiPanels` this controller needs; `reveal` exists only with scripts/tui-panel-patch.mjs applied. */
export interface TeamPanelService {
  register?(descriptor: Record<string, unknown>): (() => void) | undefined
  list?(): readonly { id: string }[]
  reveal?(id: string): boolean
  close?(id: string): boolean
}

/** The host adds a new panel to its enabled set on its next render; a reveal sent before that is dropped. */
export const REVEAL_DELAY_MS = 300
/** A reveal can be accepted and still not show (the host drops it silently); look again after its rate window. */
export const REVEAL_RETRY_MS = 6000
const REVEAL_TRIES = 3

/**
 * The Team panel exists only while a lead is in orchestrator mode: it is
 * registered when the first lead turns the mode on and removed when the last
 * one leaves. It opens beside the chat without taking focus (given `reveal`)
 * so the planning before the first dispatch is visible, and it is not
 * reopened once the user has put it away.
 */
export function teamAutopilot(teamStore: TeamStore, store: AgentStore, service: TeamPanelService, component: (source: RowSource) => unknown, enabled: () => boolean = () => true): () => void {
  let dispose: (() => void) | undefined
  let id: string | undefined
  let revealed = false
  let seen = false
  let dismissed = false
  let touched = false
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const reveal = (): void => {
    timer = undefined
    if (id === undefined || seen || dismissed || store.teamVisible || teamStore.size === 0 || typeof service.reveal !== 'function' || !enabled()) return
    if (tries >= REVEAL_TRIES) {
      logLine('agentbar', 'team panel did not show (needs fullscreen and a wide terminal); Ctrl+B opens it')
      return
    }
    tries++
    revealed = service.reveal(id) === true || revealed
    logLine('agentbar', `team panel reveal ${tries}: ${revealed ? 'sent' : 'declined (rate limit or no chat)'}`)
    timer = setTimeout(reveal, REVEAL_RETRY_MS)
    timer.unref?.()
  }
  const update = (): void => {
    if (teamStore.size === 0) {
      if (dispose === undefined) return
      clear()
      if (id !== undefined && revealed && !touched) service.close?.(id)
      dispose()
      dispose = undefined
      id = undefined
      logLine('agentbar', 'team panel removed: no lead is in orchestrator mode')
      return
    }
    if (dispose === undefined) {
      revealed = seen = dismissed = touched = false
      tries = 0
      dispose = service.register?.({
        apiVersion: 1, id: TEAM_PANEL_ID, title: 'Team', icon: '◆',
        component: component(teamSource(teamStore, store, () => { touched = true })),
      })
      if (dispose === undefined) {
        logLine('agentbar', 'team panel refused by tuiPanels.register; /orchestrator status still shows the team')
        // Not registered: try again on the next lead, not on every ledger change.
        dispose = () => {}
        return
      }
      id = service.list?.().find(entry => entry.id.endsWith(`:${TEAM_PANEL_ID}`))?.id
      logLine('agentbar', `team panel registered as ${id ?? '(unknown id)'}`)
      timer = setTimeout(reveal, REVEAL_DELAY_MS)
      timer.unref?.()
    }
    if (store.teamVisible) seen = true
    // Shown once and gone again: the user closed it or moved to another panel.
    else if (seen) dismissed = true
  }
  const stops = [teamStore.subscribe(update), store.subscribe(update)]
  update()
  return () => {
    for (const stop of stops) stop()
    clear()
    if (dispose !== undefined) dispose()
    dispose = undefined
  }
}
