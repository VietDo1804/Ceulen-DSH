/**
 * Team-lead mode. `/orchestrator` turns the live lead into a coordinator: it
 * plans, briefs, dispatches in parallel, reviews at checkpoints and advises;
 * execution belongs to the children.
 *
 * A 2026-11-15 gpt-6-astra session under the earlier prompt-only mode read the
 * same files as its scout, drove the smoke test by hand, patched a reviewer's
 * findings itself and let the todo list go stale. So the three habits that
 * matter are held by the harness, not by wording:
 * - brief: `delegate` refuses a task without Goal / Scope / Acceptance and
 *   appends the handoff report every child must end with;
 * - checkpoint: when every child of a wave has settled, the lead gets one
 *   notice with the roster and the review steps;
 * - takeover: the lead's own edit outside its coordination files is refused
 *   once; re-issuing the same call declares a takeover of those files. The
 *   reasons are a blocked child, work still wrong after one correction, or a
 *   direct order from the user (astra otherwise refused even that).
 * The plan is read twice before anything is built: by the advisor, whose
 * points go back to the lead once, and then by the user on the review card,
 * with whatever the advisor still holds open. The lead submits the plan by
 * mirroring it on the board (\`todo_write\`), a call that costs nothing to
 * repeat: when the review only ran at the first dispatch, a lead in a
 * 2026-11-22 run wrote its briefs again after every rejection, 11 \`delegate\`
 * calls for 4 children.
 * The contract a lead writes is its own: a child's edit inside that contract
 * directory is refused. Everything the mode learns goes into the team ledger
 * (./team.ts), which the Team side panel draws.
 * DSH still owns child execution, delivery and the dashboard.
 */
import { AsyncResource } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { cwdOf, errorMessage, registerCommandSafe, registerPromptSection } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { agentRoute } from '../../core/route.js'
import { EDITING, editedPaths } from './nudge.js'
import { briefTasks, childState, runningEntries, team } from './team.js'
import { PLAN_FILE, PLAN_SHAPE, readPlan, type LeadPlan, type PlanTask } from './leadplan.js'
import { planAdviser } from '../advisor/plan-review.js'

/** The lead models this mode targets; a lead on any other route is told so when it turns the mode on. */
const TUNED_LEADS = ['gpt-6.2-astra', 'gpt-6.2-sol']

const INSTRUCTIONS = `ORCHESTRATOR MODE ACTIVE
The user chose team-lead mode. You lead a team of subagents: you plan, brief, dispatch, review and advise. Execution is theirs, not yours. What you produce is the plan, the briefs, the review decisions and the integrated result.
This choice overrides any standing rule to keep small work local or to delegate only when it pays. Rules about a child's scope, budget and evidence still apply to every brief.

Team: \`delegate\` roles on their configured routes: scout (recon), planner (design of a consequential change), worker (implementation), tester (running checks), reviewer (independent review). A child starts with a fresh context and sees only your brief. The scout and the reviewer run in a read-only sandbox and cannot write anywhere: a check that writes files (a build, coverage, a test that creates fixtures) belongs to a tester, and a fix belongs to a worker.

Loop
1. Orient. Read only enough to plan: a few targeted reads, or scouts in parallel for an unfamiliar area. Never read what a child is already reading. Do not guess what the user meant: what reading can settle, settle by reading; a choice only the user can make, or a request you can read two ways, is a question. Ask it with \`ask_user_question\` before you plan, with your recommendation.
2. Plan. Write the plan to .dsh/plans/<task>.md, as detailed as a \`/plan\` plan: decision-complete, so that a child can carry out its task without making a design decision. Required headings: \`# <title>\`; \`## Goal\` (the outcome and its success criteria); \`## Scope\` (what changes, by subsystem, with API, schema and data-flow changes, edge cases and failure modes; and what is out of scope); \`## Tasks\` (one row per task: id T1, T2, …, owner role, write scope, the check that proves it done, its wave: independent tasks share a wave, dependent ones wait); \`## Acceptance\` (the checks for the whole result); \`## Assumptions\` (everything you inferred and did not ask, or "none"). Then submit it: mirror the tasks on the board with \`todo_write\`, one row per task starting with its id (a row has only content and status), every worker and tester row \`pending\`: nothing starts before the approval, and a row turns \`in_progress\` when you dispatch its task. That call puts the plan in front of the user on the review card, so do not ask "shall I proceed" yourself, and write no brief and no contract before it has gone through. When an advisor is configured it reads the plan before the user does. Feedback from either comes back as the tool's error: for the advisor's points, fix the plan or answer a point that does not apply in one line under a \`## Advisor review\` heading in the plan; for the user's, revise the plan. Then call \`todo_write\` again. A contract write, a worker or tester dispatch, or a message to a child on a plan the user has not approved runs the same review. Progress belongs on the board, not in the plan file: every edit of an approved plan is a change the user is asked to approve.
3. Contract. When two or more tasks must fit together (shared types, API shapes, file formats, naming, units), pin that interface before dispatch: load the \`contract-first\` skill and write contracts/<task>/contract.md. You own that file; children read it.
4. Brief and dispatch. Send every task of a wave in ONE step as parallel \`delegate\` calls with disjoint write scopes. Each \`task\` is a brief with these labelled lines; the tool rejects a brief without Goal, Scope and Acceptance, and a worker or tester brief without Plan:
   Plan: the id of the plan task this child carries out, e.g. T2.
   Goal: the outcome and how it fits the whole.
   Context: what you already know: files, decisions, the plan and contract paths.
   Scope: the paths this child may write, or "read-only". Add exclusions and a tool-call budget when they matter.
   Acceptance: the checks it must run and the conditions that must hold.
   The harness appends the handoff report (STATUS, CHANGED, CHECKS, DEVIATIONS, BLOCKERS); do not restate it.
5. Wait. While children run, do only coordination that needs no child output. If only waiting remains, end the turn with one line on what you are waiting for: settlement notices resume you. Do not poll and do not start a child's work.
6. Checkpoint. When a wave settles you get a checkpoint notice. Read every report, confirm the evidence cheaply (the diff, one command), update the board, and decide per child: accept, correct, reassign or take over. Then dispatch the next wave or integrate. A long verification run belongs to a tester; a risky or behaviour-changing result gets a reviewer. Start a review or test of a wave's result only after that wave's checkpoint.
7. Report to the user after the last checkpoint: what each child delivered, which checks passed, what failed or is still open.

The user stays in the loop
- The approved plan is the scope of the run. A new task, a wider write scope, a changed requirement, or a destructive or irreversible step is the user's decision, not yours: edit the plan file (the change goes back to the user for approval before the next dispatch) or ask with \`ask_user_question\`. Never do either silently, and never widen a task through a correction.
- A child's blocker that needs a product decision, or shows the request was understood wrongly, goes to the user. Do not answer it with your best guess.
- Technical choices inside the approved plan are yours: make them, and say what you chose.

When a child has a problem
- It asks, or reports a blocker: answer that child with \`send_message\`. If the contract is wrong, fix the contract first and tell every child it affects.
- Its result is wrong or incomplete: one \`send_message\` correction naming the exact gap and the check that must pass. Reassign with a new brief when it needs another role or a fresh start.
- Still wrong after that correction, or the child cannot finish: take that piece over and do it yourself, then say which child, why, and what you changed.
- The user tells you to do a specific piece yourself: that is a takeover too. Do it and say so.
Your own edit outside contracts/, .dsh/plans/ and .scratch/ is refused once; re-issuing the refused call declares the takeover. Bash is for verification and git, never a way around that.

Limits
One bounded task per child; children do not delegate further. Respect the delegation budget. A failed dispatch or an exhausted budget is not blanket permission to bypass approval policy, permissions or safety requirements: report the limit instead. This mode changes coordination only: keep the lead model, approval policy, permissions, and safety requirements unchanged. /dashboard shows the checklist and the native workflow (Lead plus current-session children) with no tool arguments, raw results, or thinking; Esc returns to chat.`

const BRIEF_FIELDS = ['Goal', 'Scope', 'Acceptance'].map(name => ({
  name,
  // A labelled line, with or without list or emphasis markers: `Goal:`, `- **Goal:**`.
  pattern: new RegExp(`^[\\s>*#-]*(?:\\*\\*|__)?${name}(?:\\*\\*|__)?\\s*:`, 'im'),
}))

const HANDOFF_RULES = `Team handoff. Your lead sees only the result you send back.
- Stay inside Scope. Do not delegate further.
- If the brief is unclear, contradicts what you find, or Acceptance cannot be met: do not guess and do not widen the scope. Finish what is unaffected and report the rest as a blocker.
- Run the Acceptance checks yourself and report their real outcome; never report a check you did not run.`

const HANDOFF_REPORT = `End that result with this report:
STATUS: done | partial | blocked
CHANGED: the files you wrote, or none
CHECKS: each Acceptance check with pass or fail (or "not run" and why)
DEVIATIONS: anything done differently from the brief, or none
BLOCKERS: questions or issues for the lead, or none`

/** Files the lead writes as coordinator: the contract, the plan, scratch checks, a route override. */
const LEAD_OWNED = /(?:^|\/)(?:contracts|\.scratch|\.dsh\/plans)\/|\/\.dsh\/ceulen\/settings\.json$/

/** Anything under a contracts/ directory: writing there starts the build, so it waits for the plan. */
const CONTRACT_PATH = /(?:^|\/)contracts\//

/** Roles that build or run things; the read-only ones (scout, planner, reviewer) may help before the plan. */
const NEEDS_PLAN = new Set(['worker', 'tester'])

const APPROVE = 'Approve'
const KEEP_PLANNING = 'Keep planning'
/** A plan file that exists but lacks a required part. */
const PLAN_INCOMPLETE = 'PLAN_INCOMPLETE'
const REVIEW_ID = 'plan-review'

/**
 * Advisor passes before a plan reaches the user: the first may send the lead
 * back to revise, the second only reports. More rounds would be two models
 * arguing while the user waits; what they cannot settle is the user's call.
 */
const MAX_ADVISOR_ROUNDS = 2

/** The advisor's reading of the lead's plan. */
interface Advice {
  /** Advisor passes used since the user last answered a review card. */
  readonly rounds: number
  /** The plan text the advisor last read. */
  readonly hash?: string
  /** What it still has to say about that text. */
  readonly notes: readonly string[]
  /** Points of the version before, which this version was checked against. */
  readonly raised?: number
  readonly reviewer?: string
  /** Why the advisor could not read the plan. */
  readonly failed?: string
}

const points = (count: number): string => `${count} ${count === 1 ? 'point' : 'points'}`

/**
 * One line for the card's question. A plan longer than the screen scrolls the
 * top of the card away, and the question is the part that always shows.
 */
export function adviceSummary(advice: Advice): string {
  if (advice.failed !== undefined) return 'Advisor review: not available.'
  const who = advice.reviewer === undefined ? 'Advisor' : `Advisor (${advice.reviewer})`
  return advice.notes.length === 0 ? `${who}: no open points.` : `${who}: ${points(advice.notes.length)} still open, listed at the top of the plan.`
}

/** What the review card says about the advisor, above the plan. */
export function adviceBlock(advice: Advice): string {
  if (advice.failed !== undefined) return `> **Advisor review:** not available (${advice.failed.replace(/\s+/g, ' ').slice(0, 160)}). Only the lead has read this plan.`
  const who = advice.reviewer === undefined ? '' : ` (${advice.reviewer})`
  if (advice.notes.length === 0) {
    const before = advice.raised === undefined || advice.raised === 0 ? '' : ` (${points(advice.raised)} on the version before, settled in this one)`
    return `> **Advisor review**${who}: no open points${before}.`
  }
  return [
    `> **Advisor review**${who}: ${points(advice.notes.length)} still open. Choose "${KEEP_PLANNING}" to have the lead deal with ${advice.notes.length === 1 ? 'it' : 'them'}; add a note to say what matters to you.`,
    ...advice.notes.map(note => `> - ${note}`),
  ].join('\n')
}

/** A lead's contract file: contracts/<task>/contract.md. */
const CONTRACT_FILE = /(?:^|\/)contracts\/[^/]+\/contract\.md$/

interface Lead {
  readonly agent: AgentLike
  /** Hands-on calls refused once; the same call again is a declared takeover. */
  readonly refused: Set<string>
  /** Files the lead took over from a child. */
  readonly takenOver: Set<string>
  /** Directories of the contracts this lead wrote; its children may not edit there. */
  readonly contractDirs: Set<string>
  /** The plan file this lead last wrote under .dsh/plans/. */
  planPath?: string
  /** Hash of the plan text the user approved. An edited plan is a new plan. */
  approved?: string
  /** Task ids of that approved plan, to tell the user what a change adds or drops. */
  approvedTasks?: readonly string[]
  /** The text of that approved plan: the advisor reviews a later change against it. */
  approvedText?: string
  /** A plan under review, by the advisor and then on the user's card; parallel dispatches wait on the same one. */
  review?: { readonly hash: string; done: Promise<void>; withUser: boolean }
  /** Where the advisor stands on the plan. */
  advice: Advice
}

/** The part of a tool execution the plan review needs. */
interface ExecLike {
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
  readonly callId?: string
  concludeTurn?(): void
}

interface LoadedPlan {
  readonly plan: LeadPlan
  readonly text: string
  /** The plan path relative to the lead's working directory. */
  readonly shown: string
}

export interface Orchestration {
  /** The task to send: unchanged outside the mode; a checked brief plus the handoff block inside it. Throws on an incomplete brief. */
  brief(agent: AgentLike, task: string, typedReply: boolean): string
  /**
   * In the mode, a worker or tester starts only on a plan the user approved,
   * for a task that plan lists. Shows the plan review card when the plan is new
   * or changed; throws with what is missing, or with the user's feedback.
   */
  admit(agent: AgentLike, role: string, task: string, exec: ExecLike): Promise<void>
  /** Track a child the lead dispatched, so its wave can close with a checkpoint. */
  record(agent: AgentLike, childId: string, role: string, label: string, task: string): void
}

export interface OrchestratorOptions {
  /** One line of resolved role routes for the mode prompt; empty when unknown. */
  routes?(): string
}

export function checkpointText(children: readonly { role: string; label: string; state: string; id: string }[]): string {
  return [
    `Checkpoint: this wave has settled (${children.length} ${children.length === 1 ? 'child' : 'children'}).`,
    ...children.map(child => `- ${child.role} · ${child.label} · ${child.state} · ${child.id}`),
    'Before any new dispatch or report to the user:',
    '1. Read each handoff report: STATUS, CHECKS, DEVIATIONS, BLOCKERS.',
    '2. Confirm the evidence cheaply yourself (the diff, one command). A child that did not end with `completed` has unfinished work.',
    '3. Update the todo board.',
    '4. Decide per child: accept · one `send_message` correction · reassign with a new brief · take over.',
    '5. Dispatch the next wave in one step, or integrate and report.',
  ].join('\n')
}

function sessionId(agent: unknown): string | undefined {
  const id = (agent as Partial<AgentLike> | undefined)?.session?.id
  return id === undefined ? undefined : String(id)
}

/** Roles that only read: they may run before the user has approved the plan. */
const EARLY_ROLES = new Set(['scout', 'planner', 'reviewer'])

/**
 * Plan tasks a board marks as started or done, among those that wait for the
 * user's approval (every owner but the read-only roles). Rows that name no
 * plan task are the lead's own notes.
 */
export function startedEarly(todos: unknown, rows: readonly PlanTask[]): string[] {
  if (!Array.isArray(todos)) return []
  const started = new Set<string>()
  for (const todo of todos as { content?: unknown; status?: unknown }[]) {
    if (typeof todo?.content !== 'string' || todo.status === undefined || todo.status === 'pending') continue
    const id = /\bT\d+\b/.exec(todo.content)?.[0]
    const task = id === undefined ? undefined : rows.find(row => row.id === id)
    // The owner cell is a role, often with its route after it.
    if (task !== undefined && !EARLY_ROLES.has(/[a-z]+/.exec((task.owner ?? '').toLowerCase())?.[0] ?? '')) started.add(task.id)
  }
  return [...started]
}

function toolInput(raw: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return undefined
  }
}

export function installOrchestrator(ctx: PluginContext, options: OrchestratorOptions = {}): Orchestration {
  // Keyed by lead session id; `agent/disposed`, `off` and plugin disposal clear it.
  const leads = new Map<string, Lead>()
  // A child can end before `startActivation` hands its id back.
  const endedEarly = new Map<string, string>()
  // Footer indicator: the same native tuiStatus seam /agent-mode uses.
  let paintFooter = (_on: boolean): void => {}
  // Only the lead whose state the footer reflects may clear it.
  let shown: string | undefined
  ctx.inject(['tuiStatus'], child => {
    paintFooter = AsyncResource.bind((on: boolean) => {
      try {
        child.get('tuiStatus', false)?.setField?.('ceulen:orchestrator', on ? 'Orchestrator' : undefined, {
          slot: 'left-tail', tone: 'accent',
        })
      } catch {
        // Optional display: coordination also works in headless profiles.
      }
    })
  })
  const leadOf = (agent: unknown): Lead | undefined => {
    const id = sessionId(agent)
    return id === undefined ? undefined : leads.get(id)
  }
  const deactivate = (agent: unknown): void => {
    const id = sessionId(agent)
    if (id === undefined || !leads.delete(id)) return
    team.close(id)
    if (shown !== id) return
    shown = undefined
    paintFooter(false)
  }
  const checkpoint = (id: string): void => {
    const lead = leads.get(id)
    const wave = lead === undefined ? undefined : team.checkpoint(id, Date.now())
    if (lead === undefined || wave === undefined) return
    const count = team.get(id)?.checkpoints ?? 0
    try {
      lead.agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: checkpointText(wave) }],
        // Never source.kind 'user': that would fake a human prompt.
        source: { kind: 'ceulen-orchestrator', form: 'notice', summary: `checkpoint: ${wave.length} settled` },
      })
      logLine('subagent', `orchestrator checkpoint ${count}: ${wave.map(child => `${child.role} ${child.state}`).join(', ')}`)
    } catch (error) {
      logLine('subagent', `orchestrator checkpoint failed: ${errorMessage(error)}`)
    }
  }
  // The plan file as it stands, mirrored into the ledger for the panel and `status`.
  const syncPlan = (lead: Lead, id: string, cwd: string): void => {
    if (lead.planPath === undefined) return
    let text: string
    try {
      text = readFileSync(lead.planPath, 'utf8')
    } catch {
      team.setPlan(id, undefined)
      return
    }
    const plan = readPlan(text)
    team.setPlan(id, {
      path: relative(cwd, lead.planPath) || lead.planPath,
      title: plan.title,
      tasks: plan.tasks,
      rows: plan.rows,
      state: lead.approved === plan.hash ? 'approved' : lead.review?.hash !== plan.hash ? 'draft' : lead.review.withUser ? 'review' : 'advisor',
    })
  }
  /** The lead's plan, complete enough to show the user. Throws with what to write. */
  const loadPlan = (lead: Lead, cwd: string, what: string): LoadedPlan => {
    const none = `Orchestrator mode: ${what} needs a plan the user has approved, and there is no plan file yet.\n${PLAN_SHAPE}\nThen do this step again: the plan is shown to the user for approval.`
    if (lead.planPath === undefined) throw new Error(none)
    let text: string
    try {
      text = readFileSync(lead.planPath, 'utf8')
    } catch {
      throw new Error(none)
    }
    const plan = readPlan(text)
    const shown = relative(cwd, lead.planPath) || lead.planPath
    if (plan.missing.length > 0) throw Object.assign(new Error(`The plan at ${shown} is not ready to show the user: it lacks ${plan.missing.join(', ')}.\n${PLAN_SHAPE}`), { code: PLAN_INCOMPLETE })
    return { plan, text, shown }
  }
  /**
   * The advisor reads the plan before the user does. Its points on the first
   * pass go back to the lead as the refusal; after that they ride on the card.
   * No advisor, or one that does not review this lead: undefined.
   */
  const advise = async (lead: Lead, loaded: LoadedPlan, exec: ExecLike): Promise<Advice | undefined> => {
    const adviser = planAdviser()
    if (adviser === undefined) return undefined
    const { plan, text, shown } = loaded
    const last = lead.advice
    // The same text again: the lead chose not to revise, so the user decides.
    if (last.hash === plan.hash) return last
    const round = last.rounds + 1
    let result: Awaited<ReturnType<typeof adviser>>
    try {
      result = await adviser({
        agent: lead.agent,
        plan: text,
        ...(lead.approvedText === undefined ? {} : { approved: lead.approvedText }),
        ...(last.notes.length === 0 ? {} : { earlier: last.notes }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
    } catch (error) {
      if (exec.signal?.aborted === true) throw error
      // A reviewer that is down must not keep the plan from the user.
      lead.advice = { rounds: round, hash: plan.hash, notes: [], failed: errorMessage(error) }
      logLine('subagent', `orchestrator plan advisor round ${round}: unavailable (${errorMessage(error)})`)
      return lead.advice
    }
    if (result === undefined) return undefined
    lead.advice = { rounds: round, hash: plan.hash, notes: result.notes, raised: last.notes.length, reviewer: result.reviewer }
    logLine('subagent', `orchestrator plan advisor round ${round}: ${result.notes.length === 0 ? 'no open points' : points(result.notes.length)} (${shown})`)
    // The card is not kept anywhere: without these lines nobody can tell later what the user was shown.
    for (const note of result.notes) logLine('subagent', `orchestrator plan advisor point: ${note.replace(/\s+/g, ' ').slice(0, 400)}`)
    if (result.notes.length === 0 || round >= MAX_ADVISOR_ROUNDS) return lead.advice
    throw new Error([
      `The advisor read the plan at ${shown} before the user sees it and has ${points(result.notes.length)}:`,
      ...result.notes.map(note => `- ${note}`),
      'Nothing was dispatched, and the user has not been asked yet. Take each point: revise the plan file, or, where a point does not apply, say why in one line under a `## Advisor review` heading in the plan. Then do this step again: the advisor reads the plan once more, and it goes to the user with whatever is still open.',
    ].join('\n'))
  }
  /** Have this exact plan text approved, once: read by the advisor, then by the user on the native plan review card. */
  const approve = (lead: Lead, id: string, loaded: LoadedPlan, exec: ExecLike, cwd: string): Promise<void> => {
    const { plan, text, shown } = loaded
    if (lead.approved === plan.hash) return Promise.resolve()
    if (lead.review?.hash === plan.hash) return lead.review.done
    const questions = ctx.get('userQuestions', false) as {
      ask?(request: unknown): Promise<{ answers?: { id?: string; selected?: string[]; custom?: string }[] }>
    } | undefined
    if (typeof questions?.ask !== 'function') {
      return Promise.reject(new Error(`The plan at ${shown} is not approved, and this session has no review card. Present the plan in your reply and end the turn: the user approves it with /orchestrator approve.`))
    }
    const before = lead.approvedTasks
    const changed = before !== undefined
    const added = plan.tasks.filter(name => before?.includes(name) !== true)
    const dropped = (before ?? []).filter(name => !plan.tasks.includes(name))
    const delta = [added.length > 0 ? `adds ${added.join(', ')}` : '', dropped.length > 0 ? `drops ${dropped.join(', ')}` : ''].filter(part => part !== '').join('; ')
    const ask = questions.ask.bind(questions)
    const review: NonNullable<Lead['review']> = { hash: plan.hash, done: Promise.resolve(), withUser: false }
    review.done = (async (): Promise<void> => {
      const advice = await advise(lead, loaded, exec)
      review.withUser = true
      syncPlan(lead, id, cwd)
      let answer: { answers?: { id?: string; selected?: string[]; custom?: string }[] }
      try {
        answer = await ask({
          questions: [{
            id: REVIEW_ID,
            header: changed ? 'Plan change' : 'Plan review',
            question: `${changed ? `The lead changed the plan you approved (${delta === '' ? 'same tasks, edited text' : delta}). Approve the new plan?` : 'Approve this plan and let the lead start the team?'}${advice === undefined ? '' : ` ${adviceSummary(advice)}`}`,
            detail: advice === undefined ? text : `${adviceBlock(advice)}\n\n${text}`,
            options: [
              { label: APPROVE, description: 'The lead dispatches the team on this plan.' },
              { label: KEEP_PLANNING, description: (advice?.notes.length ?? 0) > 0 ? 'Nothing is dispatched; the advisor\'s open points and your feedback go back to the lead.' : 'Nothing is dispatched; your feedback goes back to the lead.' },
            ],
            // The intent every DSH client draws as its plan review card.
            intent: { kind: 'plan-review', approve: APPROVE, ...(exec.callId === undefined ? {} : { callId: exec.callId }) },
          }],
          agent: lead.agent,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      } catch (cause) {
        if ((cause as { code?: unknown } | undefined)?.code !== 'ASK_CANCELLED') throw cause
        // The user closed the card to answer in their own words: their message is next.
        exec.concludeTurn?.()
        throw new Error('The user dismissed the plan review to reply in their own words. Nothing is approved and nothing was dispatched; wait for their message.')
      }
      const items = (answer.answers ?? []).filter(entry => entry.id === REVIEW_ID)
      const item = items.length === 1 ? items[0] : answer.answers?.[0]
      if (item?.selected?.length === 1 && item.selected[0] === APPROVE && item.custom === undefined) {
        lead.approved = plan.hash
        lead.approvedTasks = plan.tasks
        lead.approvedText = text
        lead.advice = { rounds: MAX_ADVISOR_ROUNDS - 1, notes: [] }
        logLine('subagent', `orchestrator plan approved: ${shown} (${plan.tasks.join(' ')})`)
        return
      }
      const feedback = item?.custom?.trim() ?? ''
      const open = advice?.notes ?? []
      logLine('subagent', `orchestrator plan not approved: ${shown}${feedback === '' ? '' : ' (with feedback)'}`)
      if (feedback === '' && open.length > 0) {
        throw new Error(`The user sent the plan at ${shown} back with the advisor's open ${open.length === 1 ? 'point' : 'points'} and no note of their own. Nothing was dispatched.\n${open.map(note => `- ${note}`).join('\n')}\nRevise the plan file for each, then do this step again.`)
      }
      throw new Error(feedback === ''
        ? `The user did not approve the plan at ${shown} and left no feedback. Nothing was dispatched. Ask them what to change with \`ask_user_question\`; do not guess.`
        : `The user did not approve the plan at ${shown}. Nothing was dispatched. Their feedback: ${feedback}\nRevise the plan file, then do this step again.`)
    })().finally(() => {
      // Once the user has answered a card, the advisor reads each later version once and only reports.
      if (review.withUser && lead.approved !== plan.hash) lead.advice = { ...lead.advice, rounds: MAX_ADVISOR_ROUNDS - 1 }
      if (lead.review === review) delete lead.review
      syncPlan(lead, id, cwd)
    })
    lead.review = review
    syncPlan(lead, id, cwd)
    return review.done
  }
  const routeLine = (): string => {
    try {
      return options.routes?.() ?? ''
    } catch {
      // A broken settings file must not take the mode prompt with it.
      return ''
    }
  }
  /** The lead's route and effort and every role's route, for the Team panel's map. */
  const describe = (lead: Lead, id: string): void => {
    let effort: string | undefined
    try {
      effort = lead.agent.model?.current?.()?.reasoningEffort ?? lead.agent.options?.reasoningEffort
    } catch {
      effort = lead.agent.options?.reasoningEffort
    }
    const routes: Record<string, string> = {}
    for (const part of routeLine().split(' · ')) {
      const [role, ...route] = part.trim().split(' ')
      if (role !== undefined && role !== '' && route.length > 0) routes[role] = route.join(' ')
    }
    team.describe(id, { route: agentRoute(lead.agent), ...(effort === undefined ? {} : { effort }), routes })
  }
  const prompt = (): string => {
    const routes = routeLine()
    return routes === '' ? INSTRUCTIONS : `${INSTRUCTIONS}\n\nRoutes\nEach role runs on this route right now: ${routes}. Say which routes a wave uses when you dispatch it; do not look them up again. The user changes a route in the Ceulen settings (\`subagent.models\`, \`subagent.thinking\`), and an edit applies to the next dispatch.`
  }

  if (!registerPromptSection(ctx, {
    name: 'ceulen:orchestrator',
    order: 126,
    interpolate: false,
    text: (context = {}) => leadOf(context.scope) === undefined ? '' : prompt(),
  })) throw new Error('Orchestrator requires the system prompt service')
  ctx.effect(() => () => {
    leads.clear()
    team.reset()
    endedEarly.clear()
    shown = undefined
    paintFooter(false)
  })
  ctx.on('agent/disposed', (payload: { agent?: object } | undefined) => deactivate(payload?.agent))

  // A `send_message` correction resumes a settled child: it joins the open wave again.
  ctx.on('subagent/start', (info: { id?: unknown } | undefined) => {
    team.resume(String(info?.id ?? ''), Date.now())
  })
  ctx.on('subagent/end', (info: { id?: unknown; stopReason?: unknown; lastAssistantMessage?: unknown } | undefined) => {
    const id = String(info?.id ?? '')
    const stop = typeof info?.stopReason === 'string' ? info.stopReason : 'ended'
    if (typeof info?.lastAssistantMessage === 'string') team.report(id, info.lastAssistantMessage)
    const state = team.settle(id, stop, Date.now())
    if (state === undefined) {
      if (leads.size === 0 || id === '') return
      if (endedEarly.size >= 64) endedEarly.clear()
      endedEarly.set(id, stop)
      return
    }
    checkpoint(state.leadId)
  })

  // The ledger's other feeds: the lead's board and turns, and each child's handoff report.
  ctx.on('session/event', (session: { id?: unknown } | undefined, event: { type?: unknown; data?: unknown } | undefined) => {
    const id = session?.id === undefined ? undefined : String(session.id)
    const type = event?.type
    if (id === undefined || typeof type !== 'string') return
    const data = (event?.data !== null && typeof event?.data === 'object' ? event.data : {}) as { name?: unknown; arguments?: unknown; isError?: unknown }
    const called = type === 'tool/call' || (type === 'tool/ptc-dispatch' && data.isError !== true) ? data.name : undefined
    if (leads.has(id)) {
      if (type === 'turn/start') {
        // The user may have changed the lead's model, its effort or a role's route since the last turn.
        describe(leads.get(id)!, id)
        team.setBusy(id, true)
      }
      else if (type === 'turn/end') team.setBusy(id, false)
      else if (type === 'todo/write') team.board(id, data)
      else if (called === 'todo_write') team.board(id, data.arguments)
      return
    }
    if (called !== 'send_message' || team.leadOfChild(id) === undefined) return
    const message = toolInput(data.arguments)?.message
    if (typeof message === 'string') team.report(id, message)
  })

  // The lead's own edits: refused once outside its coordination files, then a
  // declared takeover. Nested codemode calls pass through here too.
  ctx.on('tools/pre-execute', async (exec: ExecLike & { name?: string; arguments?: unknown }, next: () => Promise<unknown>) => {
    const id = sessionId(exec?.agent)
    if (id === undefined || typeof exec.name !== 'string') return next()
    const lead = leads.get(id)
    if (lead === undefined) {
      // A child of a lead: the contract directory is its lead's.
      const owner = EDITING.has(exec.name) ? leads.get(team.leadOfChild(id)?.leadId ?? '') : undefined
      if (owner === undefined || owner.contractDirs.size === 0) return next()
      const input = toolInput(exec.arguments)
      if (input === undefined) return next()
      const hit = editedPaths(exec.name, input).map(path => resolve(cwdOf(exec), path))
        .find(path => [...owner.contractDirs].some(dir => path === dir || path.startsWith(`${dir}/`)))
      if (hit === undefined) return next()
      logLine('subagent', `orchestrator contract guard: ${exec.name} ${hit}`)
      return {
        kind: 'deny',
        reason: `${relative(cwdOf(exec), dirname(hit)) || dirname(hit)}/ is your lead's contract and only the lead changes it. If the contract is wrong or unclear, keep working on what does not depend on it and report the problem under BLOCKERS.`,
      }
    }
    if (exec.name === 'send_message') {
      // A correction is the other way to hand out work. After the lead has
      // edited an approved plan, the change goes to the user before the team
      // hears of it.
      if (lead.approved !== undefined) {
        const cwd = cwdOf(exec)
        try {
          const loaded = loadPlan(lead, cwd, 'a message to the team')
          if (lead.approved !== loaded.plan.hash) await approve(lead, id, loaded, exec, cwd)
        } catch (error) {
          return { kind: 'deny', reason: errorMessage(error) }
        }
      }
      const input = toolInput(exec.arguments)
      if (typeof input?.agent_id === 'string' && typeof input.message === 'string') team.message(id, input.agent_id, input.message)
      return next()
    }
    if (exec.name === 'todo_write') {
      // Mirroring the plan on the board submits it. A checklist written before
      // there is a plan file is just a checklist.
      const cwd = cwdOf(exec)
      let loaded: LoadedPlan
      try {
        loaded = loadPlan(lead, cwd, 'the board')
      } catch (error) {
        // A plan file that is not a plan yet: say what it lacks now, not at the first dispatch.
        return (error as { code?: unknown }).code === PLAN_INCOMPLETE ? { kind: 'deny', reason: errorMessage(error) } : next()
      }
      // Any edit of an approved plan is a change the user has not seen, also
      // one that keeps the task list: a lead widened a task's write scope that
      // way and took the board call for the approval.
      if (lead.approved === loaded.plan.hash) return next()
      // A first plan: the board that submits it cannot show work under way.
      const early = lead.approved === undefined ? startedEarly(toolInput(exec.arguments)?.todos, loaded.plan.rows) : []
      if (early.length > 0) {
        logLine('subagent', `orchestrator board refused: ${early.join(' ')} marked started before approval`)
        return { kind: 'deny', reason: `Orchestrator mode: the user has not approved this plan, so none of its tasks has started, but the board marks ${early.join(', ')} as started. Call \`todo_write\` again with ${early.length === 1 ? 'that row' : 'those rows'} \`pending\`; mark a row \`in_progress\` when you dispatch its task.` }
      }
      try {
        await approve(lead, id, loaded, exec, cwd)
      } catch (error) {
        return { kind: 'deny', reason: errorMessage(error) }
      }
      return next()
    }
    if (!EDITING.has(exec.name)) return next()
    const input = toolInput(exec.arguments)
    if (input === undefined) return next()
    const cwd = cwdOf(exec)
    const paths = editedPaths(exec.name, input).map(path => resolve(cwd, path))
    if (paths.length > 0 && paths.every(path => LEAD_OWNED.test(path) || lead.takenOver.has(path))) {
      // The contract is the first thing built on the plan: the user approves the plan before it.
      if (paths.some(path => CONTRACT_PATH.test(path))) {
        try {
          await approve(lead, id, loadPlan(lead, cwd, 'writing a contract'), exec, cwd)
        } catch (error) {
          return { kind: 'deny', reason: errorMessage(error) }
        }
      }
      for (const path of paths) {
        if (!CONTRACT_FILE.test(path)) continue
        lead.contractDirs.add(dirname(path))
        team.contract(id, relative(cwd, path))
      }
      const plan = paths.find(path => PLAN_FILE.test(path))
      if (plan === undefined) return next()
      // The file exists once the write has run: then the ledger can read it.
      const result = await next()
      lead.planPath = plan
      syncPlan(lead, id, cwd)
      return result
    }
    const target = paths.length === 0 ? 'this change' : paths.join(', ')
    const key = `${exec.name}\n${typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(input)}`
    if (lead.refused.delete(key)) {
      for (const path of paths) lead.takenOver.add(path)
      team.takeover(id, paths.map(path => relative(cwd, path)))
      logLine('subagent', `orchestrator takeover ${team.get(id)?.takeovers ?? 0}: ${exec.name} ${target}`)
      return next()
    }
    lead.refused.add(key)
    logLine('subagent', `orchestrator refused ${exec.name}: ${target}`)
    return {
      kind: 'deny',
      reason: [
        `Orchestrator mode: you are the lead, and \`${exec.name}\` on ${target} is execution work.${(team.get(id)?.children.size ?? 0) === 0 ? ' Nothing has been delegated in this mode yet.' : ''}`,
        '- Not delegated yet, or its owner is still working: brief a worker with `delegate` (Goal, Scope, Acceptance), or `send_message` the owner.',
        '- Take it over only if a child reported a blocker, a child\'s work is still wrong after one `send_message` correction, or the user told you to do this piece yourself. Then re-issue this exact call: it runs, and later edits to the same files run too. Name the reason in your report.',
        'Your own files (contracts/, .dsh/plans/, .scratch/) are never refused. Do not route around this with bash.',
      ].join('\n'),
    }
  })

  registerCommandSafe(ctx, {
    name: 'orchestrator',
    description: 'Lead a team of subagents: plan, brief, dispatch, review; optionally submit a task (on, off, status)',
    input: { hint: '[on|off|status|approve|<task>]' },
    handler({ agent, rawInput }) {
      if (agent === undefined) return { kind: 'error', text: 'Orchestrator needs a session context.' }
      if (agent.session.header?.parentSession !== undefined) return { kind: 'error', text: 'Use /orchestrator in the lead session, not a child.' }
      const target = rawInput.trim()
      const action = target.toLowerCase()
      const current = leadOf(agent)
      if (action === 'status') {
        const lines = [`Orchestrator: ${current === undefined ? 'off' : 'on'} (this live session).`]
        const state = current === undefined ? undefined : team.get(String(agent.session.id))
        if (state !== undefined) {
          const children = [...state.children.values()]
          const running = new Set(runningEntries(state).map(entry => entry.childId))
          lines.push(`Team: ${children.length} dispatched · ${running.size} running · ${children.length - running.size} settled · ${state.checkpoints} checkpoints · ${state.corrections} corrections · ${state.takeovers} lead takeovers`)
          if (state.plan === undefined) lines.push('Plan: none yet (the lead writes it under .dsh/plans/; you approve it before anything is built)')
          else lines.push(`Plan: ${state.plan.path} · ${state.plan.state === 'approved' ? 'approved by you' : state.plan.state === 'review' ? 'waiting for your approval' : state.plan.state === 'advisor' ? 'with the advisor, then you' : 'draft, not approved'} · ${state.plan.tasks.join(' ') || 'no tasks'}`)
          if (state.contract !== undefined) lines.push(`Contract: ${state.contract}`)
          for (const child of children) lines.push(`  ${child.role} · ${child.label} · ${childState(state, child.id)}${child.status === undefined || child.status === 'done' ? '' : ` · reported ${child.status}`}`)
        }
        lines.push('Use /dashboard for the session checklist and native workflow; Esc returns to chat. /subagent shows worker routes.')
        return { kind: 'success', text: lines.join('\n') }
      }
      if (action === 'approve') {
        if (current === undefined) return { kind: 'error', text: 'Orchestrator is off: there is no plan to approve.' }
        const id = String(agent.session.id)
        const cwd = agent.session.header?.cwd ?? process.cwd()
        try {
          const { plan, shown, text } = loadPlan(current, cwd, 'approval')
          current.approved = plan.hash
          current.approvedTasks = plan.tasks
          current.approvedText = text
          current.advice = { rounds: MAX_ADVISOR_ROUNDS - 1, notes: [] }
          syncPlan(current, id, cwd)
          logLine('subagent', `orchestrator plan approved by command: ${shown}`)
          return { kind: 'success', text: `Plan approved: ${plan.title} (${shown}; ${plan.tasks.join(' ')}). Tell the lead to go on.` }
        } catch (error) {
          return { kind: 'error', text: errorMessage(error) }
        }
      }
      if (action === 'off') {
        deactivate(agent)
        return { kind: 'success', text: 'Orchestrator off. Existing children are not cancelled; permissions unchanged.' }
      }
      const runtime = ctx.get('subagents', false) as { startActivation?: unknown } | undefined
      if (typeof runtime?.startActivation !== 'function' || ctx.tools.get?.('delegate', agent) === undefined) {
        return { kind: 'error', text: 'Orchestrator unavailable: the native subagent runtime and delegate tool are required.' }
      }
      const id = String(agent.session.id)
      const route = agentRoute(agent)
      if (current === undefined) {
        // A ledger left by an earlier activation of this module is not this lead's.
        team.close(id)
        leads.set(id, { agent, refused: new Set(), takenOver: new Set(), contractDirs: new Set(), advice: { rounds: 0, notes: [] } })
      }
      team.open(id, route, Date.now())
      describe(leads.get(id)!, id)
      shown = id
      paintFooter(true)
      if (target !== '' && action !== 'on') {
        try {
          agent.followup({ role: 'user', content: [{ type: 'text', text: target }], source: { kind: 'user' } })
        } catch (error) {
          if (current === undefined) deactivate(agent)
          return { kind: 'error', text: `Task was not queued: ${errorMessage(error)}` }
        }
      }
      const tuned = route === undefined || TUNED_LEADS.some(model => route.includes(model)) ? '' : `\nLead route is ${route}; this mode is tuned for ${TUNED_LEADS.join(' and ')} (/model to switch).`
      return { kind: 'success', text: `Orchestrator on for this live session: the lead plans, briefs and reviews; children execute.${target !== '' && action !== 'on' ? ' Task queued for the lead to plan and delegate.' : ' Send your task in chat, or use /orchestrator <task>.'}${tuned}\nMonitor /dashboard (Tasks/Workflow); Esc returns to chat. /orchestrator status shows the team; /orchestrator off exits the mode.` }
    },
  })

  return {
    brief(agent, task, typedReply) {
      if (leadOf(agent) === undefined) return task
      const missing = BRIEF_FIELDS.filter(field => !field.pattern.test(task)).map(field => field.name)
      if (missing.length > 0) {
        throw new Error(`Orchestrator brief is missing ${missing.map(name => `\`${name}:\``).join(', ')}. Write the task as labelled lines: Goal: (the outcome), Context: (what you already know), Scope: (paths the child may write, or "read-only"), Acceptance: (checks it must run). The child sees nothing else.`)
      }
      // A typed reply keeps its JSON contract; the report format would contradict it.
      return `${task}\n\n---\n\n${typedReply ? HANDOFF_RULES : `${HANDOFF_RULES}\n${HANDOFF_REPORT}`}`
    },
    async admit(agent, role, task, exec) {
      const id = sessionId(agent)
      const lead = id === undefined ? undefined : leads.get(id)
      if (id === undefined || lead === undefined || !NEEDS_PLAN.has(role)) return
      const cwd = cwdOf(exec)
      const loaded = loadPlan(lead, cwd, `dispatching a ${role}`)
      const named = briefTasks(task)
      const unknown = named.filter(name => !loaded.plan.tasks.includes(name))
      if (named.length === 0 || unknown.length > 0) {
        throw new Error([
          named.length === 0
            ? `Orchestrator brief for a ${role} is missing its \`Plan:\` line: name the plan task it carries out (the plan at ${loaded.shown} lists ${loaded.plan.tasks.join(', ')}).`
            : `Orchestrator brief names ${unknown.join(', ')}, which the plan at ${loaded.shown} does not list (it has ${loaded.plan.tasks.join(', ')}).`,
          'Work that is not a task of the plan is the user\'s decision: add the task to the plan file, which goes back to them for approval, or ask with `ask_user_question`.',
        ].join('\n'))
      }
      await approve(lead, id, loaded, exec, cwd)
    },
    record(agent, childId, role, label, task) {
      const id = sessionId(agent)
      if (id === undefined || !leads.has(id)) return
      const ended = endedEarly.get(childId)
      endedEarly.delete(childId)
      team.dispatch(id, childId, role, label, task, Date.now(), ended)
      if (ended !== undefined) checkpoint(id)
    },
  }
}
