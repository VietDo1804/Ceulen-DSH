/**
 * Ceulen subagent role presets.
 *
 * Ported from `extensions/modules/subagent/agents/*.md` and
 * `extensions/modules/subagent/lib/roles.ts` (Ceulen, MIT). DSH owns child
 * execution: this file only carries the role persona and resolves the role's
 * provider/model route from the Ceulen settings document.
 *
 * `@fast` / `@coder` / `@smart` are function aliases; an alias expands to an
 * ordered `provider/model[:effort]` chain. `*` or `@default` means "inherit the
 * parent agent's route". A matched candidate's `:effort` suffix wins over the
 * per-role `thinking` setting, which wins over the role's own default.
 */
import { parseRoute } from '../../core/llm.js'
import type { SchemaNode } from './schema.js'
import { REASONING_EFFORTS, type ReasoningEffort } from '../../core/settings.js'

export interface RoleDefinition {
  readonly name: string
  readonly description: string
  /** Function alias (`@fast`, `@coder`, `@smart`); overridable per role. */
  readonly model: string
  readonly thinking: ReasoningEffort
  readonly persona: string
}

export interface RoleSettings {
  readonly roles: Readonly<Record<string, readonly string[]>>
  readonly models: Readonly<Record<string, string>>
  readonly thinking: Readonly<Record<string, ReasoningEffort>>
}

export interface RoleRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffort
}

export interface RoleResolution {
  readonly role: RoleDefinition
  /** Selector that started the chain: the settings override or the role alias. */
  readonly selector: string
  /** Expanded candidate routes, in priority order. */
  readonly candidates: readonly string[]
  /** First valid route; absent means "inherit the parent agent's route". */
  readonly route?: RoleRoute
  readonly thinking: ReasoningEffort
  readonly unresolved: readonly string[]
}

const REASONING = new Set<string>(REASONING_EFFORTS)

/** Split a trailing `:effort`; unknown suffixes (e.g. `:free`) stay in the name. */
export function splitThinkingSuffix(entry: string): { name: string; thinking?: ReasoningEffort } {
  const index = entry.lastIndexOf(':')
  if (index <= 0 || index >= entry.length - 1) return { name: entry }
  const suffix = entry.slice(index + 1)
  if (!REASONING.has(suffix)) return { name: entry }
  return { name: entry.slice(0, index), thinking: suffix as ReasoningEffort }
}

function isParentRef(entry: string): boolean {
  return entry === '*' || entry === '@default'
}

function chainEntries(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  const entries = typeof value === 'string' ? value.split(',') : value
  return entries.map(entry => entry.trim()).filter(entry => entry.length > 0)
}

export interface ExpandedChain {
  readonly candidates: string[]
  readonly thinkingByCandidate: Map<string, ReasoningEffort>
  readonly unresolved: string[]
}

/**
 * Expand function aliases in place (cycle-safe) and drop parent references.
 * An alias's `:effort` suffix applies to every route it expands to; a route's
 * own suffix wins.
 */
export function expandChain(
  entries: readonly string[],
  roles: Readonly<Record<string, readonly string[]>>,
): ExpandedChain {
  const candidates: string[] = []
  const thinkingByCandidate = new Map<string, ReasoningEffort>()
  const unresolved = new Set<string>()
  const seen = new Set<string>()

  const walk = (entry: string, visited: Set<string>, inherited?: ReasoningEffort): void => {
    const { name, thinking: own } = splitThinkingSuffix(entry.trim())
    if (name.length === 0 || isParentRef(name)) return
    if (name.startsWith('@')) {
      const alias = name.slice(1)
      const chain = chainEntries(roles[alias])
      if (chain.length === 0) {
        unresolved.add(name)
        return
      }
      if (visited.has(alias)) {
        unresolved.add(name)
        return
      }
      const next = new Set(visited).add(alias)
      const effective = own ?? inherited
      for (const child of chain) walk(child, next, effective)
      return
    }
    if (seen.has(name)) return
    seen.add(name)
    candidates.push(name)
    const level = own ?? inherited
    if (level !== undefined) thinkingByCandidate.set(name, level)
  }

  for (const entry of entries) walk(entry, new Set())
  return { candidates, thinkingByCandidate, unresolved: [...unresolved] }
}

/** Static role catalog, in upstream order. */
export const ROLES: readonly RoleDefinition[] = [
  {
    name: 'planner',
    description: 'Read-only planning and architecture specialist for consequential design and implementation plans.',
    model: '@smart',
    thinking: 'high',
    persona: `You are a senior software planner. Investigate the repository, identify the smallest complete implementation path, and return a concrete plan with file and symbol anchors.

Do not modify files. Resolve discoverable facts from the codebase before raising questions. Call out material risks, compatibility constraints, and the narrowest verification that proves the change.`,
  },
  {
    name: 'reviewer',
    description: 'Independent code review for correctness, security, regressions, test gaps, and over-engineering.',
    model: '@smart',
    thinking: 'high',
    persona: `You are an independent senior code reviewer. Inspect the requested Git scope with read-only tools.

Focus only on actionable issues introduced by the reviewed change. Return each confirmed finding as one self-contained issue another agent can fix without redoing the review:
1. Correctness and edge cases
2. Security and data loss
3. Regressions and API compatibility
4. Missing tests that allow a likely bug to escape
5. Over-engineering (ponytail discipline): reinvented stdlib, a dependency or code the platform already covers, an abstraction with one implementation, config nobody sets, dead flexibility, logic longer than the problem. Tag each finding \`delete:\`, \`stdlib:\`, \`native:\`, \`yagni:\`, or \`shrink:\` and name what replaces it; the change's best outcome is getting shorter.

Complexity never blocks: report over-engineering as P2 or P3 only, never P0/P1. A smoke test or \`assert\`-based self-check is the ponytail minimum, not bloat — do not flag it for deletion.

Avoid style noise, praise, and speculative redesign. Every finding needs code evidence.

End your reply with exactly one JSON object, and no prose after it:
\`\`\`json
{"verdict": "ship|fix-first|reject", "findings": [{"severity": "P0|P1|P2|P3", "file": "relative/path", "line": 1, "confidence": 0.9}]}
\`\`\`

P0 blocks the change, P1 must be fixed before shipping, P2 should be fixed, P3 is a nit. Use an empty \`findings\` array when clean; the parent validates the reply with \`validate_schema\`. Do not modify files or Git state.`,
  },
  {
    name: 'scout',
    description: 'Fast codebase recon that returns compressed context another agent can use without re-reading everything.',
    model: '@fast',
    thinking: 'off',
    persona: `You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Thoroughness (infer from task, default medium):
- Quick: Targeted lookups, key files only
- Medium: Follow imports, read critical sections
- Thorough: Trace all dependencies, check tests/types

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Evidence
List exact file/symbol anchors and relevant line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description of what's here
2. \`path/to/other.ts\` (lines 100-150) - Description
3. ...

## Key Code
Critical types, interfaces, or functions:

\`\`\`typescript
interface Example {
  // actual code from the files
}
\`\`\`

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.`,
  },
  {
    name: 'tester',
    description: 'Focused verification agent for routine test, typecheck, lint, build, and regression checks.',
    model: '@fast',
    thinking: 'off',
    persona: `You are a focused verification agent. Inspect the requested scope, run the narrowest relevant checks, and report exact commands, outcomes, and actionable failures.

Do not edit repo files. Use scratch files outside the repo (e.g. /tmp) when a check needs a fixture or probe script. Avoid unrelated broad test suites unless the task requires them.`,
  },
  {
    name: 'worker',
    description: 'General-purpose coding agent with full tool access, for isolated implementation work.',
    model: '@coder',
    thinking: 'medium',
    persona: `You are a skilled software engineer. Implement the requested task with care and precision.

Guidelines:
- Read before you edit. Understand existing code first.
- Make minimal, focused changes. Do not refactor unrelated code.
- Follow existing patterns, naming, and formatting.
- Write clear, idiomatic code with appropriate error handling.
- Test your changes when practical (run tests, lint, type-check).
- Explain your approach briefly before making changes.`,
  },
]

/**
 * Default reply schema for the reviewer role (M3-2): a parent reads a verdict
 * and prioritised findings instead of parsing paragraphs. `delegate` appends
 * it to the child prompt and `validate_schema` checks the reply.
 */
export const REVIEWER_SCHEMA: SchemaNode = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: 'number' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}

const ROLE_BY_NAME = new Map(ROLES.map(role => [role.name, role]))

export function roleByName(name: string): RoleDefinition | undefined {
  return ROLE_BY_NAME.get(name.trim())
}

export function roleNames(): string[] {
  return ROLES.map(role => role.name)
}

/** Resolve one role's persona, route, and effort; undefined for an unknown name. */
export function resolveRole(name: string, settings: RoleSettings): RoleResolution | undefined {
  const role = roleByName(name)
  if (role === undefined) return undefined
  const selector = settings.models[role.name] ?? role.model
  const expanded = expandChain([selector], settings.roles)
  const unresolved = [...expanded.unresolved]
  let route: RoleRoute | undefined
  let chosen: string | undefined
  for (const candidate of expanded.candidates) {
    const parsed = parseRoute(candidate)
    if (parsed === undefined) {
      unresolved.push(`${candidate} (expected provider/model)`)
      continue
    }
    chosen = candidate
    route = parsed
    break
  }
  const suffix = chosen === undefined ? undefined : expanded.thinkingByCandidate.get(chosen)
  const thinking = suffix ?? settings.thinking[role.name] ?? role.thinking
  return {
    role,
    selector,
    candidates: expanded.candidates,
    ...(route === undefined ? {} : { route: { ...route, reasoningEffort: thinking } }),
    thinking,
    unresolved,
  }
}

/** `provider/model:effort`, or `parent route` when the role inherits. */
export function describeRoute(resolution: RoleResolution): string {
  if (resolution.route === undefined) return 'parent route'
  return `${resolution.route.provider}/${resolution.route.model}:${resolution.thinking}`
}
