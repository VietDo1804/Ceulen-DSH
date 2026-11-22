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

/** What the plan says about one task, as far as its row could be read. */
export interface PlanTask {
  readonly id: string
  readonly title?: string
  /** The owner cell as written: a role, often with a route after it. */
  readonly owner?: string
  readonly scope?: string
  readonly wave?: number
}

export interface LeadPlan {
  readonly title: string
  /** Task ids the plan lists: T1, T2, … */
  readonly tasks: readonly string[]
  /** One entry per task id, in the plan's order. */
  readonly rows: readonly PlanTask[]
  /** Required headings the file lacks. */
  readonly missing: readonly string[]
  /** Identity of this exact text: an approval covers one hash. */
  readonly hash: string
}

const heading = (name: string): RegExp => new RegExp(`^#{1,6}[ \\t]*(?:\\d+[.)][ \\t]*)?(?:\\*\\*|__)?${name}\\b`, 'im')
/** A task id opening a list item, a table row or a heading. */
const TASK_ID = /^[\s>*|#-]*(?:\*\*|__|`)?(T\d+)\b/gm

const CELL_CHARS = 120
const plain = (text: string): string => text.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, CELL_CHARS)
const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map(plain)
const COLUMNS: readonly { key: 'title' | 'owner' | 'scope' | 'wave'; name: RegExp }[] = [
  { key: 'owner', name: /owner|role|assignee/i },
  { key: 'wave', name: /wave/i },
  { key: 'scope', name: /scope|files/i },
  { key: 'title', name: /^(?:task|title|name|what|summary|description)$/i },
]

/**
 * What the plan says per task. A table is read by its header (the mode asks
 * for id, owner, write scope, check, wave); any other line that opens with a
 * task id gives the rest of the line as the title. The first reading of an id
 * that has a field wins, so a `### T1 — title` heading can fill in a table row.
 */
export function planTasks(markdown: string, ids: readonly string[]): PlanTask[] {
  const found = new Map<string, { title?: string; owner?: string; scope?: string; wave?: number }>()
  const put = (id: string, key: 'title' | 'owner' | 'scope', value: string | undefined): void => {
    const row = found.get(id) ?? {}
    if (value !== undefined && value !== '' && row[key] === undefined) row[key] = value
    found.set(id, row)
  }
  const wave = (id: string, text: string | undefined): void => {
    const row = found.get(id) ?? {}
    const value = Number(/\d+/.exec(text ?? '')?.[0])
    if (row.wave === undefined && Number.isInteger(value) && value > 0) row.wave = value
    found.set(id, row)
  }
  let columns: Map<number, 'title' | 'owner' | 'scope' | 'wave'> | undefined
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      columns = undefined
      // `T1 · worker · src/a/** · npm test · wave 1`: the mode's columns on one line.
      const dotted = /^[\s>#-]*(?:[*+][ \t]+)?(?:\*\*|__|`)?(T\d+)(?:\*\*|__|`)?[ \t]*·(.+)$/.exec(line)
      if (dotted !== null) {
        const parts = dotted[2]!.split('·').map(plain)
        put(dotted[1]!, 'owner', parts[0])
        put(dotted[1]!, 'scope', parts[1])
        wave(dotted[1]!, parts.find(part => /\bwave\b/i.test(part)))
        continue
      }
      // `T1: title`, `**T1 — title** (files)`, `### T2 (wave 1) - title`; a sentence that only starts with an id is not a title.
      const match = /^[\s>#-]*(?:[*+][ \t]+)?(\*\*|__|`)?(T\d+)(?:\*\*|__|`)?[ \t]*(\([^)]*\))?[ \t]*(?::|[—–-](?=\s)|\.(?=\s))[ \t]*(.+)$/.exec(line)
      if (match === null) continue
      // Inside bold, the title ends where the bold does.
      const rest = match[1] === undefined ? match[4]! : match[4]!.split(match[1])[0]!
      put(match[2]!, 'title', plain(rest))
      wave(match[2]!, /\bwave\s*(\d+)/i.exec(`${match[3] ?? ''} ${rest}`)?.[1])
      continue
    }
    const cells = cellsOf(line)
    if (cells.every(cell => /^:?-+:?$/.test(cell) || cell === '')) continue
    const id = /^T\d+$/.exec(cells[0] ?? '')?.[0]
    if (id === undefined) {
      // A header row: remember which column holds what.
      columns = new Map()
      for (const [index, cell] of cells.entries()) {
        // The first column is the id, whatever its heading says.
        if (index === 0) continue
        const column = COLUMNS.find(entry => entry.name.test(cell))
        if (column !== undefined && ![...columns.values()].includes(column.key)) columns.set(index, column.key)
      }
      continue
    }
    for (const [index, key] of columns ?? []) {
      if (key === 'wave') wave(id, cells[index])
      else put(id, key, cells[index])
    }
  }
  return ids.map(id => ({ id, ...found.get(id) }))
}

export function readPlan(markdown: string): LeadPlan {
  const title = /^#[ \t]+(.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
  const tasks = [...new Set([...markdown.matchAll(TASK_ID)].map(match => match[1]!))]
  const missing: string[] = [
    ...(title === '' ? ['a `# title`'] : []),
    ...PLAN_SECTIONS.filter(name => !heading(name).test(markdown)).map(name => `\`## ${name}\``),
    ...(tasks.length === 0 ? ['task ids (T1, T2, …) under `## Tasks`'] : []),
  ]
  return { title: title === '' ? 'Plan' : title, tasks, rows: planTasks(markdown, tasks), missing, hash: createHash('sha256').update(markdown).digest('hex') }
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
