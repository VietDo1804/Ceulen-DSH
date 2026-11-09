import type { PluginContext, ToolRunContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, type RuleGuardMode } from '../../core/settings.js'
import { ceulenHome } from '../../core/paths.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerPromptSection, registerToolSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { clearRuleCache, displayPath, loadRules, type LoadedRule, type RuleModel } from '../../vendor/ceulen/rules/rules.js'

export const name = 'ceulen-rules'
export const inject = ['tools', 'commands', 'systemPrompt']

function cwdOf(exec?: ToolRunContext): string {
  return exec?.agent?.session.header?.cwd ?? process.cwd()
}

/**
 * Sticky rules the prompt block had no room for. The vendor renderer drops a
 * rule whole once the block passes its cap and tells only the model, so the
 * owner of RULES.md never learns that a rule stopped applying.
 */
export function droppedSticky(model: RuleModel): string[] {
  const block = model.block
  if (block === undefined) return []
  return model.sticky.filter(rule => !block.includes(`### ${rule.name} (`)).map(rule => rule.name)
}

function statusText(model: RuleModel, cwd: string, mode: RuleGuardMode): string {
  const dropped = droppedSticky(model)
  const names = (rules: { name: string }[]) => rules.map(rule => rule.name).join(', ') || '(none)'
  const sources = model.sources.length === 0
    ? []
    : [
        `Rule sources (${model.sources.length}):`,
        ...model.sources.map((source, index) => `  ${index + 1}. ${displayPath(source.path, cwd)}  [${source.kind}${source.readOnly ? ', read-only' : ''}, ${source.bytes} bytes]`),
      ]
  const guards = model.guards.length === 0
    ? [`Guards (0, mode ${mode}): none — add \`when-tool\`/\`when-match\` to a rule heading.`]
    : [
        `Guards (${model.guards.length}, mode ${mode}):`,
        ...model.guards.map(rule => `  ${rule.name}  ${rule.guard?.tool}  /${rule.guard?.match}/  ${rule.guard?.action}`),
      ]
  if (model.files.length === 0) {
    return [
      'Rule sources: none',
      `  Looked for .dsh/RULES.md from ${cwd} upwards and ${ceulenHome()}/RULES.md.`,
      '  Create one to add sticky rules (always in the prompt) or rulebook rules (read on demand).',
      ...guards,
    ].join('\n')
  }
  return [
    ...sources,
    `Sticky (${model.sticky.length}): ${names(model.sticky)}`,
    ...(dropped.length === 0 ? [] : [`⚠ NOT in the prompt (${dropped.length}): ${dropped.join(', ')} — the sticky block is over its cap. Shorten RULES.md, or give a rule a \`description:\` line to serve it on demand.`]),
    `Rulebook (${model.rulebook.length}): ${names(model.rulebook)}`,
    ...guards,
    `Prompt block: ${model.blockChars} chars${model.block === undefined ? ' (no block)' : ''}`,
    'rule_get returns a rulebook body; sticky rules are already in the system prompt.',
  ].join('\n')
}

/**
 * The string a guard tests: the command for `bash`, the target path for the
 * file editors (apply_patch carries its path inside the patch text), and the
 * JSON arguments for everything else.
 */
export function guardSubject(tool: string, args: unknown): string {
  const record = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  if (tool === 'bash') return typeof record.command === 'string' ? record.command : ''
  if (tool === 'edit' || tool === 'write' || tool === 'apply_patch') {
    for (const key of ['file_path', 'path', 'patch']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }
  try {
    return JSON.stringify(record)
  } catch {
    return ''
  }
}

/** Compiled guard patterns; an invalid pattern never matches and logs once. */
const patterns = new Map<string, RegExp | null>()
const invalidLogged = new Set<string>()

function guardPattern(rule: LoadedRule): RegExp | undefined {
  const source = rule.guard?.match
  if (source === undefined) return undefined
  const cached = patterns.get(source)
  if (cached !== undefined) return cached ?? undefined
  try {
    const compiled = new RegExp(source)
    patterns.set(source, compiled)
    return compiled
  } catch {
    patterns.set(source, null)
    if (!invalidLogged.has(source)) {
      invalidLogged.add(source)
      logLine('rules', `guard "${rule.name}" has an invalid when-match regex: /${source}/`)
    }
    return undefined
  }
}

function denyReason(rule: LoadedRule, tool: string, matched: string): string {
  return [
    `Blocked by rule "${rule.name}" (${rule.guard?.tool} guard in ${rule.source}).`,
    `matched on ${tool}: ${clampText(matched, 300)}`,
    '',
    clampText(rule.body, 1_500),
    '',
    'To unblock: set `rules.guards` to "audit" (log only) or "off" in ~/.dsh/ceulen/settings.json, or change the rule\'s `when-action`.',
  ].join('\n')
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('rules', settings)) return

  let currentCwd = process.cwd()
  ctx.on('session/event', (session: unknown, event: { type?: string; data?: { cwd?: string } }) => {
    if (event?.type === 'working-directory/change' && typeof event.data?.cwd === 'string') currentCwd = event.data.cwd
    const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) currentCwd = cwd
  })

  let lastDropped = ''
  registerPromptSection(ctx, {
    name: 'ceulen:rules',
    order: 55,
    text: () => {
      try {
        const model = loadRules(currentCwd, ceulenHome(), true)
        const dropped = droppedSticky(model).join(', ')
        if (dropped !== lastDropped) {
          lastDropped = dropped
          if (dropped !== '') logLine('rules', `sticky rules dropped from the prompt (block over its cap): ${dropped}`)
        }
        return model.block ?? ''
      } catch {
        return ''
      }
    },
  })

  // Behaviour-scoped guards: a rule with `when-*` directives is checked here
  // instead of costing prompt bytes. `audit` never blocks; `enforce` denies
  // only rules that opted into `when-action: deny`.
  ctx.on('tools/pre-execute', async (exec: { name?: string; arguments?: unknown; agent?: { session?: { header?: { cwd?: string } } } }, next: () => Promise<unknown>) => {
    const mode = loadSettingsSync().rules.guards
    if (mode === 'off') return next()
    const tool = typeof exec?.name === 'string' ? exec.name : ''
    if (tool === '') return next()
    let model: RuleModel
    try {
      model = loadRules(exec.agent?.session?.header?.cwd ?? currentCwd, ceulenHome(), true)
    } catch {
      return next()
    }
    if (model.guards.length === 0) return next()
    const subject = guardSubject(tool, exec.arguments)
    if (subject === '') return next()
    for (const rule of model.guards) {
      const guard = rule.guard
      if (guard === undefined) continue
      if (guard.tool !== '*' && guard.tool !== tool) continue
      const pattern = guardPattern(rule)
      if (pattern === undefined) continue
      const match = pattern.exec(subject)
      if (match === null) continue
      const matched = match[0]
      if (mode === 'enforce' && guard.action === 'deny') {
        logLine('rules', `guard ${rule.name} denied ${tool}: ${clampText(matched, 160)}`)
        return { kind: 'deny', reason: denyReason(rule, tool, matched) }
      }
      logLine('rules', `guard ${rule.name} matched ${tool} (${mode}): ${clampText(matched, 160)}`)
    }
    return next()
  })

  registerToolSafe(ctx, ceulenTool({
    name: 'rule_get',
    description: 'Read the full body of a project rule listed in the <user-rules> rulebook. Sticky rules are already in the system prompt.',
    parameters: objectSchema({
      name: { type: 'string', description: 'Rule name from the rulebook listing.' },
    }, ['name']),
    outputSchema: { type: 'string' },
    async execute(args, exec) {
      const ruleName = String((args as { name?: unknown }).name ?? '').trim()
      if (ruleName.length === 0) throw new Error('name must be a non-empty string')
      const model = loadRules(cwdOf(exec), ceulenHome(), true)
      const rule = model.rulebook.find(entry => entry.name === ruleName)
      if (rule === undefined) {
        const sticky = model.sticky.some(entry => entry.name === ruleName)
        throw new Error(sticky
          ? `"${ruleName}" is a sticky rule; it is already in the system prompt.`
          : `unknown rulebook rule "${ruleName}". Available: ${model.rulebook.map(entry => entry.name).join(', ') || '(none)'}`)
      }
      return `${rule.name} (${displayPath(rule.source, cwdOf(exec))})\n\n${rule.body}`
    },
  }))

  registerCommandSafe(ctx, {
    name: 'rules',
    description: 'Show or reload the sticky RULES.md, rulebook and behaviour guards',
    input: { hint: '[status|reload]' },
    handler({ rawInput }) {
      const action = rawInput.trim().split(/\s+/).filter(Boolean)[0] ?? 'status'
      if (action === 'reload') {
        clearRuleCache()
        return { kind: 'success', text: 'Rule cache cleared; the next assembly re-reads every RULES.md and @import.' }
      }
      if (action !== 'status') return { kind: 'error', text: 'usage: /rules [status|reload]' }
      const model = loadRules(currentCwd, ceulenHome(), true)
      return { kind: 'success', text: clampText(statusText(model, currentCwd, loadSettingsSync().rules.guards)) }
    },
  })
}
