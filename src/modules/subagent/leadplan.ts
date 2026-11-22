/**
 * The lead's plan in orchestrator mode: a markdown file under `.dsh/plans/`
 * that the user approves before anything is built, and that stays the scope
 * of the run. Pure reading of that file; the approval itself is in
 * ./orchestrator.ts.
 *
 * The shape follows DSH's own plan mode (decision-complete, reviewed by the
 * user through the plan review card) plus what a team needs: tasks with ids,
 * so every brief can say which approved task it carries out.
 */
import { createHash } from 'node:crypto'

/** A plan file the lead writes: .dsh/plans/<name>.md. */
export const PLAN_FILE = /(?:^|\/)\.dsh\/plans\/[^/]+\.md$/

/** Headings a plan must have, in the words the mode prompt gives. */
export const PLAN_SECTIONS = ['Goal', 'Scope', 'Tasks', 'Acceptance', 'Assumptions'] as const

export interface LeadPlan {
  readonly title: string
  /** Task ids the plan lists: T1, T2, … */
  readonly tasks: readonly string[]
  /** Required headings the file lacks. */
  readonly missing: readonly string[]
  /** Identity of this exact text: an approval covers one hash. */
  readonly hash: string
}

const heading = (name: string): RegExp => new RegExp(`^#{1,6}[ \\t]*(?:\\d+[.)][ \\t]*)?(?:\\*\\*|__)?${name}\\b`, 'im')
/** A task id opening a list item, a table row or a heading. */
const TASK_ID = /^[\s>*|#-]*(?:\*\*|__|`)?(T\d+)\b/gm

export function readPlan(markdown: string): LeadPlan {
  const title = /^#[ \t]+(.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
  const tasks = [...new Set([...markdown.matchAll(TASK_ID)].map(match => match[1]!))]
  const missing: string[] = [
    ...(title === '' ? ['a `# title`'] : []),
    ...PLAN_SECTIONS.filter(name => !heading(name).test(markdown)).map(name => `\`## ${name}\``),
    ...(tasks.length === 0 ? ['task ids (T1, T2, …) under `## Tasks`'] : []),
  ]
  return { title: title === '' ? 'Plan' : title, tasks, missing, hash: createHash('sha256').update(markdown).digest('hex') }
}

/** What the lead is told when it has no plan, or a plan that is not a plan yet. */
export const PLAN_SHAPE = [
  'Write the plan to .dsh/plans/<task>.md with these headings:',
  '# <title>',
  '## Goal — the outcome and its success criteria',
  '## Scope — what changes, by subsystem; what is out of scope',
  '## Tasks — one row per task: id (T1, T2, …), owner role, write scope, the check that proves it done, its wave',
  '## Acceptance — the checks for the whole result',
  '## Assumptions — everything you inferred and did not ask the user; "none" if there is nothing',
].join('\n')
