/**
 * Role-aware delegation for DSH.
 *
 * Ceulen's subagent module ships five role presets (planner, reviewer, scout,
 * tester, worker) plus function-based model routing. DSH already owns child
 * execution, continuation, background notices, and fan-out, so this adapter
 * only adds what the native tools lack: the role persona and the role's
 * provider/model route. `delegate` starts a native spawn child through
 * `ctx.subagents`; `subagent`/`subagent_fork`/`workflow` stay untouched.
 */
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, type CeulenSettings } from '../../core/settings.js'
import { ceulenTool, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe, errorMessage } from '../../core/tools.js'
import { displayPath, settingsPath } from '../../core/paths.js'
import { logLine } from '../../core/log.js'
import { describeRoute, resolveRole, roleByName, roleNames, REVIEWER_SCHEMA, ROLES, type RoleDefinition, type RoleResolution } from './roles.js'
import { contractBlock, parseTypedReply, type SchemaNode } from './schema.js'
import { getPonytailInstructions } from '../../vendor/ceulen/ponytail/instructions.js'
import { composeRulesBlock, loadRules } from '../../vendor/ceulen/rules/rules.js'

export const name = 'ceulen-subagent'
export const inject = ['tools', 'commands', 'systemPrompt']

/**
 * Structural view of the DSH subagent service (`ctx.subagents`). Requests are
 * borrowed from `@deepseek-ai/dsh-subagent`; the bundle imports no harness
 * package at runtime, so only the call shape this adapter uses is declared.
 */
interface SubagentRuntimeLike {
  /** Host depth setting; the native tool applies the same cap per delegation. */
  resolveMaxDepth?(configured?: number | 'provider-managed'): number | undefined
  startActivation(spec: {
    provider: string
    label: string
    request: Record<string, unknown>
    signal: AbortSignal
    delivery: 'parent'
  }): Promise<{ readonly childId: unknown }>
}

const ROLE_HINTS = 'planner (read-only design), reviewer (independent review), scout (codebase recon), tester (verification), worker (isolated implementation)'

/**
 * Inherited policy for delegated children — ports upstream ceulen's
 * ponytail-subagent hook: spawn children load neither extensions nor the
 * session system prompt, so the active ponytail discipline and the sticky
 * RULES.md block are prepended to the task. Fail-open: policy loading can
 * never block a dispatch.
 */
function inheritedPolicy(settings: CeulenSettings): string {
  try {
    const parts: string[] = []
    if (process.env.PONYTAIL_SUBAGENT_SCOPE !== 'off' && settings.ponytail.level !== 'off') {
      parts.push(getPonytailInstructions(settings.ponytail.level))
    }
    const rules = composeRulesBlock(loadRules(), process.cwd())
    if (rules !== undefined) parts.push(rules)
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

function composePrompt(role: RoleDefinition, task: string, policy = '', schema?: SchemaNode): string {
  const contract = schema === undefined ? '' : `\n\n---\n\n${contractBlock(schema)}`
  return `You are the "${role.name}" subagent role.\n\n${role.persona}${policy === '' ? '' : `\n\n---\n\n${policy}`}${contract}\n\n---\n\n${task}`
}

function asSchema(value: unknown): SchemaNode | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('schema must be an object (subset: type, required, properties, items, enum)')
  return value as SchemaNode
}

function labelFor(args: Record<string, unknown>, role: RoleDefinition): string {
  const description = typeof args.description === 'string' ? args.description.trim() : ''
  if (description.length === 0) return `${role.name} delegation`
  return description.length <= 80 ? description : `${description.slice(0, 79)}…`
}

function routeText(resolution: RoleResolution): string {
  return resolution.route === undefined ? 'parent route' : describeRoute(resolution)
}

function promptText(): string {
  try {
    const settings = loadSettingsSync()
    if (!isModuleEnabled('subagent', settings)) return ''
    return [
      '## Ceulen subagent roles',
      '',
      `Role-shaped delegation uses \`delegate\`, which starts a fresh-context child with a role persona: ${ROLE_HINTS}. Each role resolves its provider/model route from \`subagent.roles\`, \`subagent.models\`, and \`subagent.thinking\` in the Ceulen settings (\`${displayPath(settingsPath())}\`); a \`*\` chain entry inherits this session's route. The child does not see this conversation, so make the task self-contained. Use native \`subagent\` for plain delegation and \`subagent_fork\` when the child needs this conversation.`,
    ].join('\n')
  } catch {
    return ''
  }
}

function roleLines(settings: CeulenSettings): string[] {
  return ROLES.map(role => {
    const resolution = resolveRole(role.name, settings.subagent)
    const route = resolution === undefined ? '?' : routeText(resolution)
    return `  ${role.name.padEnd(8)} ${route.padEnd(30)} ${role.description}`
  })
}

function roleDetail(settings: CeulenSettings, role: RoleDefinition): string[] {
  const resolution = resolveRole(role.name, settings.subagent)
  if (resolution === undefined) return [`unknown role ${role.name}`]
  const first = resolution.candidates[0]
  const chain = first === undefined
    ? 'parent route'
    : first === resolution.selector ? first : `${resolution.selector} -> ${resolution.candidates.join(' -> ')}`
  const tools = role.name === 'worker' ? 'full' : role.name === 'tester' ? 'read + scratch writes' : 'read-only'
  const lines = [
    `${role.name}: ${role.description}`,
    `  selector: ${resolution.selector}${resolution.selector === role.model ? ' (role default)' : ''}`,
    `  chain: ${chain}`,
    `  route: ${routeText(resolution)}`,
    `  thinking: ${resolution.thinking}${resolution.route === undefined ? ' (advisory: an inherited parent route keeps its effort)' : ''}`,
  ]
  if (resolution.unresolved.length > 0) lines.push(`  unresolved: ${resolution.unresolved.join(', ')}`)
  lines.push(`  tools (advisory): ${tools}`)
  return lines
}

function parentRoute(agent: AgentLike | undefined): string {
  const provider = agent?.options.provider
  const model = agent?.options.model
  return provider !== undefined && model !== undefined ? `${provider}/${model}` : 'unknown'
}

function delegateTool(service: SubagentRuntimeLike) {
  return ceulenTool({
    name: 'delegate',
    description: `Delegate a self-contained task to a Ceulen role preset running in a fresh context: ${ROLE_HINTS}. The role persona is prepended to the task, and the child's provider/model route comes from the Ceulen subagent settings (an unset route inherits this session). Pass \`schema\` to make the child answer with one JSON object (the reviewer role has a default verdict/findings schema); validate the reply with \`validate_schema\`. This tool starts an independently managed subagent and immediately returns its id; the runtime notifies you when it finishes. Use native \`subagent\` for plain delegation and \`subagent_fork\` when the child needs the current conversation.`,
    parameters: objectSchema({
      role: {
        type: 'string',
        enum: roleNames(),
        description: 'Role preset. planner and reviewer are read-only; worker implements; scout and tester investigate and verify.',
      },
      task: {
        type: 'string',
        description: 'Complete, self-contained task for the child. It does not see this conversation.',
      },
      description: {
        type: 'string',
        description: 'Short 3-5 word label for the delegated task, for display.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
      },
      schema: {
        type: 'object',
        description: 'Optional reply schema (subset: type, required, properties, items, enum). Appended to the child prompt; check the reply with validate_schema.',
      },
    }, ['role', 'task']),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'activation' },
        subagentId: { type: 'string' },
      },
      required: ['kind', 'subagentId'],
    },
    render(args, value) {
      const role = typeof (args as { role?: unknown }).role === 'string' ? String((args as { role: string }).role) : 'role'
      const id = typeof (value as { subagentId?: unknown }).subagentId === 'string' ? (value as { subagentId: string }).subagentId : '?'
      return [{ type: 'text', text: `started ${role} subagent ${id}` }]
    },
    concurrencySafe: true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const role = roleByName(String(input.role ?? ''))
      if (role === undefined) throw new Error(`unknown role; choose one of: ${roleNames().join(', ')}`)
      const task = typeof input.task === 'string' ? input.task.trim() : ''
      if (task.length === 0) throw new Error('task must be a non-empty string')
      const agent = exec.agent
      if (agent === undefined) throw new Error('delegate requires a calling agent')

      const settings = loadSettingsSync()
      const resolution = resolveRole(role.name, settings.subagent)
      if (resolution === undefined) throw new Error(`role ${role.name} is not configured`)
      if (resolution.unresolved.length > 0) {
        logLine('subagent', `role ${role.name} unresolved entries: ${resolution.unresolved.join(', ')}`)
      }

      const schema = asSchema(input.schema) ?? (role.name === 'reviewer' ? REVIEWER_SCHEMA : undefined)
      const request: Record<string, unknown> = {
        prompt: [{ type: 'text', text: composePrompt(role, task, inheritedPolicy(settings), schema) }],
        parent: agent,
        signal: exec.signal,
      }
      if (typeof input.cwd === 'string' && input.cwd.trim().length > 0) request.cwd = input.cwd.trim()
      const maxDepth = typeof service.resolveMaxDepth === 'function' ? service.resolveMaxDepth() : undefined
      if (maxDepth !== undefined) request.maxDepth = maxDepth
      if (resolution.route !== undefined) {
        request.agentOptions = {
          provider: resolution.route.provider,
          model: resolution.route.model,
          reasoningEffort: resolution.thinking,
        }
      }

      const activation = await service.startActivation({
        provider: 'spawn',
        label: labelFor(input, role),
        request,
        signal: exec.signal,
        delivery: 'parent',
      })
      const subagentId = String(activation.childId)
      logLine('subagent', `started ${role.name} ${subagentId} via ${routeText(resolution)}`)
      return { kind: 'activation', subagentId }
    },
  })
}

function commandHandler(settings: CeulenSettings, rawInput: string, agent: AgentLike | undefined) {
  const requested = rawInput.trim().split(/\s+/).filter(Boolean)[0]
  if (requested !== undefined) {
    const role = roleByName(requested)
    if (role === undefined) return { kind: 'error' as const, text: `unknown role "${requested}"; choose one of: ${roleNames().join(', ')}` }
    return { kind: 'success' as const, text: roleDetail(settings, role).join('\n') }
  }
  return {
    kind: 'success' as const,
    text: [
      'Subagent roles (delegate tool):',
      ...roleLines(settings),
      '',
      `Parent route: ${parentRoute(agent)}`,
      `Settings: ${displayPath(settingsPath())}`,
      'Routes: subagent.roles (fast/coder/smart), subagent.models (<role> -> selector), subagent.thinking (<role> -> effort).',
      'Native subagent, subagent_fork, and workflow remain for plain, forked, and batch delegation.',
    ].join('\n'),
  }
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('subagent', loadSettingsSync())) return

  registerPromptSection(ctx, {
    name: 'ceulen:subagent',
    order: 115,
    text: promptText,
  })

  registerCommandSafe(ctx, {
    name: 'subagent',
    description: 'Show Ceulen subagent roles and their model routes',
    input: { hint: '[role]' },
    handler({ rawInput, agent }) {
      try {
        return commandHandler(loadSettingsSync(), rawInput, agent)
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })

  // The reply validator rides the tools service, not the subagent service: a
  // parent can check any child text it received, and the delegate adapter has
  // no final-text hook to validate in place.
  registerToolSafe(ctx, ceulenTool({
    name: 'validate_schema',
    description: 'Validate a delegated child\'s reply against the schema you passed to delegate and return the parsed object. Fails loudly, naming the failing field — never a silent pass.',
    parameters: objectSchema({
      schema: { type: 'object', description: 'The schema passed to delegate (subset: type, required, properties, items, enum).' },
      text: { type: 'string', description: "The child's final reply text." },
    }, ['schema', 'text']),
    outputSchema: { type: 'object' },
    async execute(raw) {
      const args = raw as { schema?: unknown; text?: unknown }
      const schema = asSchema(args.schema)
      if (schema === undefined) throw new Error('schema must be an object (subset: type, required, properties, items, enum)')
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') throw new Error("text must be the child's final reply")
      return parseTypedReply(schema, text)
    },
  }))

  let registered = false
  try {
    ctx.inject(['subagents'], child => {
      if (registered) return
      let service: SubagentRuntimeLike | undefined
      try {
        service = child.get('subagents', false) as SubagentRuntimeLike | undefined
      } catch {
        return
      }
      if (service === undefined || typeof service.startActivation !== 'function') return
      const tool = registerToolSafe(child, delegateTool(service))
      if (tool.actual === 'delegate') registered = true
    })
  } catch {
    // Optional service: a headless composition may not mount delegation.
  }
}
