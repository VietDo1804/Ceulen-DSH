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
import { resolve } from 'node:path'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, type CeulenSettings } from '../../core/settings.js'
import { asRecord, ceulenTool, cwdOf, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe, errorMessage } from '../../core/tools.js'
import { displayPath, settingsPath } from '../../core/paths.js'
import { logLine } from '../../core/log.js'
import { describeRoute, resolveRole, roleByName, roleNames, REVIEWER_SCHEMA, ROLES, type RoleDefinition } from './roles.js'
import { contractBlock, parseTypedReply, type SchemaNode } from './schema.js'
import { installOrchestrator, type Orchestration } from './orchestrator.js'
import { installNudges } from './nudge.js'
import { runInHerdr, type HerdrPermission, type HerdrRoute } from './herdr.js'
import { herdrEnv } from '../../core/herdr.js'
import { planActive } from '../../core/plan-mode.js'
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

const HERDR_HINT = 'This session runs inside a herdr pane: `delegate` with `runner: "herdr"` runs the child as a headless DSH in a visible pane beside this one and returns its final answer when it ends (it blocks this call). Use it only when the user wants to watch the child work; read the herdr skill before driving panes by hand.'

/** Read-only roles keep a read-only sandbox in a herdr pane; plan mode makes every role read-only. */
const READ_ONLY_ROLES = new Set(['planner', 'reviewer', 'scout'])

const ROLE_HINTS = 'planner (read-only design), reviewer (independent review), scout (codebase recon), tester (verification), worker (isolated implementation)'

/**
 * Inherited policy for delegated children — ports upstream ceulen's
 * ponytail-subagent hook: spawn children load neither extensions nor the
 * session system prompt, so the active ponytail discipline and the sticky
 * RULES.md block are prepended to the task. Fail-open: policy loading can
 * never block a dispatch.
 */
function inheritedPolicy(settings: CeulenSettings, cwd: string): string {
  try {
    const parts: string[] = []
    if (process.env.PONYTAIL_SUBAGENT_SCOPE !== 'off' && settings.ponytail.level !== 'off') {
      parts.push(getPonytailInstructions(settings.ponytail.level))
    }
    // The parent session's project rules, not those of the harness process cwd.
    const rules = composeRulesBlock(loadRules(cwd), cwd)
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

function promptText(): string {
  try {
    const settings = loadSettingsSync()
    if (!isModuleEnabled('subagent', settings)) return ''
    return [
      '## Ceulen subagent roles',
      '',
      `Role-shaped delegation uses \`delegate\`, which starts a fresh-context child with a role persona: ${ROLE_HINTS}. Each role resolves its provider/model route from \`subagent.roles\`, \`subagent.models\`, and \`subagent.thinking\` in the Ceulen settings (\`${displayPath(settingsPath())}\`); a \`*\` chain entry inherits this session's route. The child does not see this conversation, so make the task self-contained. Use native \`subagent\` for plain delegation and \`subagent_fork\` when the child needs this conversation.`,
      ...(herdrEnv() === undefined ? [] : ['', HERDR_HINT]),
    ].join('\n')
  } catch {
    return ''
  }
}

function roleLines(settings: CeulenSettings): string[] {
  return ROLES.map(role => {
    const resolution = resolveRole(role.name, settings.subagent)
    const route = resolution === undefined ? '?' : describeRoute(resolution)
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
    `  route: ${describeRoute(resolution)}`,
    `  thinking: ${resolution.thinking}${resolution.route === undefined ? ' (advisory: an inherited parent route keeps its effort)' : ''}`,
    `  preset: ${settings.subagent.presets[role.name] ?? 'parent composition'}`,
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

function herdrRoute(resolution: NonNullable<ReturnType<typeof resolveRole>>, agent: AgentLike): HerdrRoute | undefined {
  if (resolution.route !== undefined) return { provider: resolution.route.provider, model: resolution.route.model, effort: resolution.thinking }
  const { provider, model } = agent.options
  return provider !== undefined && model !== undefined ? { provider, model, effort: resolution.thinking } : undefined
}

function renderHerdr(role: string, value: Record<string, unknown>) {
  const head = `${role} child in herdr pane ${String(value.pane)} exited ${String(value.exitCode)} after ${String(value.toolCalls)} tool calls (${String(value.permission)}, ${String(value.reason)})${value.paneKept === true ? '; pane kept open for inspection' : ''}. Run files: ${String(value.runDir)}`
  const text = typeof value.text === 'string' && value.text.trim() !== '' ? value.text : '(no final text)'
  return [{ type: 'text' as const, text: `${head}\n\n${text}` }]
}

function delegateTool(service: SubagentRuntimeLike, ctx: PluginContext, herdr: boolean, orchestration: Orchestration) {
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
      ...(herdr ? {
        runner: {
          type: 'string',
          enum: ['native', 'herdr'],
          description: 'native (default): background DSH child. herdr: headless DSH child in a visible herdr pane beside this one; the call waits and returns its final answer. Only when the user wants to watch it.',
        },
      } : {}),
    }, ['role', 'task']),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['activation', 'herdr'] },
        subagentId: { type: 'string' },
        pane: { type: 'string' },
        exitCode: { type: 'number' },
        text: { type: 'string' },
        reason: { type: 'string' },
        toolCalls: { type: 'number' },
        permission: { type: 'string' },
        runDir: { type: 'string' },
        paneKept: { type: 'boolean' },
      },
      required: ['kind', 'subagentId'],
    },
    render(args, value) {
      const role = typeof (args as { role?: unknown }).role === 'string' ? String((args as { role: string }).role) : 'role'
      if ((value as { kind?: unknown }).kind === 'herdr') return renderHerdr(role, value as Record<string, unknown>)
      const id = typeof (value as { subagentId?: unknown }).subagentId === 'string' ? (value as { subagentId: string }).subagentId : '?'
      return [{ type: 'text', text: `started ${role} subagent ${id}` }]
    },
    concurrencySafe: true,
    async execute(args, exec) {
      const input = asRecord(args)
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
      // In team-lead mode the task must be a full brief; it gains the handoff block.
      const briefed = orchestration.brief(agent, task, schema !== undefined)
      // ... and a worker or tester waits for the user's approval of the plan it belongs to.
      await orchestration.admit(agent, role.name, task, exec)
      const prompt = composePrompt(role, briefed, inheritedPolicy(settings, cwdOf(exec)), schema)
      if (input.runner === 'herdr') {
        const cwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0 ? resolve(cwdOf(exec), input.cwd.trim()) : cwdOf(exec)
        const permission: HerdrPermission = READ_ONLY_ROLES.has(role.name) || planActive(ctx, agent) ? 'read-only' : 'workspace-write'
        return runInHerdr({ role: role.name, label: labelFor(input, role), prompt, cwd, route: herdrRoute(resolution, agent), permission, signal: exec.signal })
      }
      const request: Record<string, unknown> = {
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: exec.signal,
      }
      const preset = settings.subagent.presets[role.name]
      if (preset !== undefined) request.agentPreset = preset
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
      orchestration.record(agent, subagentId, role.name, labelFor(input, role), task)
      logLine('subagent', `started ${role.name} ${subagentId} via ${describeRoute(resolution)}`)
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
      'Presets: subagent.presets (<role> -> DSH preset id); omission inherits the parent composition. /subagent <role> shows it.',
      'Native subagent, subagent_fork, and workflow remain for plain, forked, and batch delegation.',
    ].join('\n'),
  }
}

export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('subagent', loadSettingsSync())) return

  const orchestration = installOrchestrator(ctx, {
    routes() {
      const settings = loadSettingsSync()
      return ROLES.map(role => {
        const resolution = resolveRole(role.name, settings.subagent)
        return `${role.name} ${resolution === undefined ? '?' : describeRoute(resolution)}`
      }).join(' · ')
    },
  })
  installNudges(ctx)

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
      const tool = registerToolSafe(child, delegateTool(service, ctx, herdrEnv() !== undefined, orchestration))
      if (tool.actual === 'delegate') registered = true
    })
  } catch {
    // Optional service: a headless composition may not mount delegation.
  }
}
