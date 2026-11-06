import type { PluginContext } from '../../core/types.js'
import { credential } from '../../core/credentials.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { registerCommandSafe } from '../../core/tools.js'

export const name = 'ceulen-providers'
export const inject = ['commands', 'llm']

interface ProvidersConfig {
  target?: 'router' | 'zai'
}

/**
 * Compat fields a thinking-plus-tools loop needs. The DeepSeek API returns a
 * 400 without them, and the 400 reads as a model failure: pin them here so
 * `/ceulen doctor` can name the missing field instead of costing a session.
 */
export const TOOL_LOOP_COMPAT_FIELDS = [
  'supportsToolChoice',
  'requiresReasoningContentForToolCalls',
  'requiresAssistantContentForToolCalls',
] as const

export const DEEPSEEK_COMPAT: Record<(typeof TOOL_LOOP_COMPAT_FIELDS)[number], boolean> = {
  supportsToolChoice: false,
  requiresReasoningContentForToolCalls: true,
  requiresAssistantContentForToolCalls: true,
}

export interface ProviderRecipe {
  id: string
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
  compat: Record<string, boolean>
}

/** Pinned recipes: a route names one by provider id. */
export const RECIPES: Record<string, ProviderRecipe> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    compat: { ...DEEPSEEK_COMPAT },
  },
}

export interface CompatReport {
  route: string
  provider: string
  model?: string
  /** Declared flags (a boolean is present even when false). */
  present: string[]
  /** Required flags the recipe does not declare. */
  missing: string[]
  /** False when no recipe is pinned for the provider. */
  known: boolean
}

function splitRoute(route: string): { provider: string; model?: string } {
  const slash = route.indexOf('/')
  if (slash <= 0) return { provider: route.trim() }
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

/**
 * Missing compat fields for one route. `compat` is injectable so a doctor test
 * (or a hand-written profile recipe) can check an incomplete set.
 */
export function compatReport(route: string, compat: Record<string, unknown> | undefined = RECIPES[splitRoute(route).provider]?.compat): CompatReport {
  const { provider, model } = splitRoute(route)
  const present = TOOL_LOOP_COMPAT_FIELDS.filter(field => typeof compat?.[field] === 'boolean')
  const missing = TOOL_LOOP_COMPAT_FIELDS.filter(field => typeof compat?.[field] !== 'boolean')
  return { route, provider, ...(model === undefined ? {} : { model }), present, missing, known: compat !== undefined }
}

/** One doctor line: route, flags present, flags missing (named). */
export function formatCompat(report: CompatReport): string {
  if (!report.known) return `compat: ${report.route}  no pinned recipe (expected: ${TOOL_LOOP_COMPAT_FIELDS.join(', ')})`
  const flags = `${report.present.length}/${TOOL_LOOP_COMPAT_FIELDS.length}`
  return report.missing.length === 0
    ? `compat: ${report.route}  flags ${flags}  missing: (none)`
    : `compat: ${report.route}  flags ${flags}  missing: ${report.missing.join(', ')}`
}

function routes(ctx: PluginContext): string[] {
  try {
    const list = ctx.llm?.listProviders?.() ?? []
    return list.map(entry => {
      if (typeof entry === 'string') return entry
      const record = entry as { id?: string; name?: string }
      return record.id !== undefined ? `${record.id}${record.name !== undefined && record.name !== record.id ? ` (${record.name})` : ''}` : String(entry)
    })
  } catch {
    return []
  }
}

function deepseekText(): string {
  return [
    'DeepSeek provider recipe (configuration, not a ported adapter)',
    'The thinking-plus-tools loop needs three compat fields or the API returns 400:',
    ...TOOL_LOOP_COMPAT_FIELDS.map(field => `  ${field}: ${String(DEEPSEEK_COMPAT[field])}`),
    '',
    'Declare the route in the profile patch (then /reload):',
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      deepseek:',
    '        api: openai-completions',
    `        baseURL: ${RECIPES.deepseek?.baseURL}`,
    `        apiKeyEnv: ${RECIPES.deepseek?.apiKeyEnv}`,
    '        compat:',
    ...TOOL_LOOP_COMPAT_FIELDS.map(field => `          ${field}: ${String(DEEPSEEK_COMPAT[field])}`),
    '',
    'Use /provider-compat <provider/model> to check a route; /ceulen doctor prints every route.',
  ].join('\n')
}

function routerText(ctx: PluginContext): string {
  const configured = process.env.ROUTER_BASE_URL !== undefined || process.env.ROUTER_API_KEY !== undefined
  const env = [
    `ROUTER_BASE_URL=${process.env.ROUTER_BASE_URL !== undefined ? 'set' : 'unset'}`,
    `ROUTER_API_KEY=${process.env.ROUTER_API_KEY !== undefined ? 'set' : 'unset'}`,
  ].join(' · ')
  return [
    'Router provider (configuration, not a ported adapter)',
    `env: ${env}`,
    `registered routes: ${routes(ctx).join(', ') || '(none)'}`,
    '',
    'Declare a DSH route in the profile patch (then /reload):',
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      router:',
    '        displayName: Router',
    '        api: openai-completions',
    '        baseURL: https://your-router.example/v1',
    '        apiKeyEnv: ROUTER_API_KEY',
    '        models:',
    '          - id: your-model-id',
    '            contextWindow: 262144',
    '',
    configured
      ? 'Use /model to select the router route; /router-model lists the registered routes.'
      : 'Set ROUTER_BASE_URL/ROUTER_API_KEY or paste the concrete URL above.',
  ].join('\n')
}

function zaiText(ctx: PluginContext): string {
  const key = credential('ZAI_ANTHROPIC_API_KEY', 'ZAI_API_KEY')
  return [
    'Z.AI provider (configuration, not a ported adapter)',
    `ZAI key: ${key.value !== undefined ? `set (${key.source === 'dsh-credential' ? 'credential store' : 'env'})` : 'unset'}`,
    `registered routes: ${routes(ctx).join(', ') || '(none)'}`,
    '',
    'Declare the pi-ai catalog route in the profile patch (then restart dsh):',
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      zai:',
    '        apiKeyEnv: ZAI_ANTHROPIC_API_KEY',
    '',
    'The installed pi-ai catalog supplies the GLM models, endpoint and reasoning levels, so /model lists them without a models: list.',
    'DSH does not expose ZCode request signing or an explicit prompt-cache switch; use the route as-is.',
  ].join('\n')
}

export function apply(ctx: PluginContext, config: ProvidersConfig = {}): void {
  const settings = loadSettingsSync()
  const target = config.target === 'zai' ? 'zai' : 'router'
  if (!isModuleEnabled(target, settings)) return
  if (target === 'router') {
    registerCommandSafe(ctx, {
      name: 'router-status',
      description: 'Show the router route/env and the llm-pi-ai recipe',
      handler() {
        return { kind: 'success', text: routerText(ctx) }
      },
    })
    registerCommandSafe(ctx, {
      name: 'provider-compat',
      description: 'Show the tool-loop compat flags for a route (default: the session route)',
      input: { hint: '[provider/model]' },
      handler({ rawInput, agent }) {
        const requested = rawInput.trim()
        const route = requested.length > 0
          ? requested
          : agent?.options.provider !== undefined && agent.options.model !== undefined
            ? `${agent.options.provider}/${agent.options.model}`
            : 'deepseek'
        return { kind: 'success', text: `${formatCompat(compatReport(route))}\n\n${deepseekText()}` }
      },
    })
    registerCommandSafe(ctx, {
      name: 'router-model',
      description: 'List registered LLM routes',
      handler() {
        const list = routes(ctx)
        return { kind: list.length > 0 ? 'success' : 'error', text: list.length > 0 ? list.join('\n') : 'No LLM routes are registered.' }
      },
    })
    return
  }
  registerCommandSafe(ctx, {
    name: 'zai',
    description: 'Show the Z.AI route/env and the llm-pi-ai recipe',
    handler() {
      return { kind: 'success', text: zaiText(ctx) }
    },
  })
}
