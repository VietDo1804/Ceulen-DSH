import { REASONING_EFFORTS, type CeulenSettings, type ReasoningEffort } from '../../core/settings.js'
import { ROLES } from '../subagent/roles.js'
import { info, number, option, secret, text, toggle } from './rows.js'
import { roleSelector, routeList, routeText, splitList, splitRoute } from './helpers.js'
import type { ConfigContext, ConfigRow, ConfigTab } from './types.js'

/** Keep fallback order and effort in the existing route strings. */
function fallbackRows(settings: CeulenSettings, owner: 'advisor' | 'classifier'): ConfigRow[] {
  return settings[owner].fallbacks.flatMap((value, index) => [
    text(`${owner}.fallbacks.${index}.model`, `Fallback ${index + 1} model`, value, next => {
      const routes = [...settings[owner].fallbacks]
      if (next.trim() === '') routes.splice(index, 1)
      else {
        splitRoute(next)
        routes[index] = next
      }
      settings[owner].fallbacks = routeList(routes.join(', '))
    }, { picker: true, description: 'Tried in this order. Enter replaces only this fallback; type "-" in the picker to remove it.' }),
    option(`${owner}.fallbacks.${index}.reasoning`, `Fallback ${index + 1} reasoning`, splitRoute(value)?.effort ?? 'auto', ['auto', ...REASONING_EFFORTS], next => {
      const route = splitRoute(settings[owner].fallbacks[index] ?? '')
      if (route === null) return
      settings[owner].fallbacks[index] = routeText(route.provider, route.model, next === 'auto' ? null : next as ReasoningEffort)
    }, { description: 'Reasoning for this fallback only; auto uses its model default.' }),
  ])
}

/** The per-role model/reasoning rows, reused by the Model tab. */
export function buildSubagentRows(settings: CeulenSettings): ConfigRow[] {
  return ROLES.flatMap(role => {
    const label = role.name.slice(0, 1).toUpperCase() + role.name.slice(1)
    return [
      text(`subagent.models.${role.name}`, `${label} model`, settings.subagent.models[role.name] ?? '', value => {
        const selector = roleSelector(value)
        if (selector.length === 0) delete settings.subagent.models[role.name]
        else settings.subagent.models[role.name] = selector
      }, {
        picker: true,
        placeholder: `${role.model} (role default)`,
        description: `provider/model[:effort], ${role.model} alias, or *; '-' restores the role default. Enter filters registered provider models.`,
      }),
      option(`subagent.thinking.${role.name}`, `${label} reasoning`, settings.subagent.thinking[role.name] ?? 'auto', ['auto', ...REASONING_EFFORTS], value => {
        if (value === 'auto') delete settings.subagent.thinking[role.name]
        else settings.subagent.thinking[role.name] = value as ReasoningEffort
      }, { description: `Thinking level for the delegate child; role default ${role.thinking}. A :effort suffix on the model row wins.` }),
    ]
  })
}

/** Appearance, Model, Memory and Context tabs. */
export function buildCoreTabs(settings: CeulenSettings, context: ConfigContext, subagentRows: ConfigRow[]): ConfigTab[] {
  return [
    {
      id: 'appearance',
      label: 'Appearance',
      sections: [
        {
          id: 'discipline',
          label: 'Discipline',
          rows: [
            option('ponytail.level', 'Ponytail mode', settings.ponytail.level, ['off', 'lite', 'full', 'ultra'], value => {
              settings.ponytail.level = value as CeulenSettings['ponytail']['level']
            }, { description: 'Over-engineering discipline injected into every request. New sessions pick it up.' }),
            option('ux.mode', 'UX mode', settings.ux.mode, ['off', 'lite', 'strict'], value => {
              settings.ux.mode = value as CeulenSettings['ux']['mode']
            }, { description: 'Anti-slop UI design discipline; strict adds the full method to the prompt. Guidance only: nothing blocks handoff.' }),
          ],
        },
        {
          id: 'usage',
          label: 'Usage',
          rows: [
            toggle('usage.enabled', 'Usage tracking', settings.usage.enabled, value => { settings.usage.enabled = value }),
            toggle('usage.showStatus', 'Status line', settings.usage.showStatus, value => { settings.usage.showStatus = value }),
            number('usage.intervalMinutes', 'Refresh (minutes)', settings.usage.intervalMinutes, value => { settings.usage.intervalMinutes = value }, 1, 60),
            text('usage.providers', 'Providers', settings.usage.providers.join(', '), value => {
              settings.usage.providers = splitList(value)
            }, { placeholder: 'all configured providers', description: 'Comma-separated provider ids; empty checks every configured provider.' }),
          ],
        },
      ],
    },
    {
      id: 'model',
      label: 'Model',
      sections: [
        {
          id: 'advisor',
          label: 'Advisor',
          rows: [
            text('advisor.route', 'Primary model', routeText(settings.advisor.provider, settings.advisor.model, settings.advisor.reasoningEffort), value => {
              const route = splitRoute(value)
              settings.advisor.provider = route?.provider ?? null
              settings.advisor.model = route?.model ?? null
              settings.advisor.reasoningEffort = route?.effort ?? null
            }, { picker: true, placeholder: 'parent agent route', description: 'provider/model[:effort]; empty uses the parent route. Enter filters the models registered providers advertise.' }),
            option('advisor.reasoningEffort', 'Reasoning', settings.advisor.reasoningEffort ?? 'auto', ['auto', ...REASONING_EFFORTS], value => {
              settings.advisor.reasoningEffort = value === 'auto' ? null : (value as ReasoningEffort)
            }, { description: 'Thinking level sent with the reviewer request; auto uses the model catalog default.' }),
            text('advisor.fallbacks', 'Add fallback', settings.advisor.fallbacks.join(', '), value => {
              settings.advisor.fallbacks = routeList(value)
            }, { picker: true, pickerAppend: true, placeholder: 'none', description: 'provider/model routes tried in order when the primary fails. Enter opens the model list and APPENDS the pick; type freely for an effort suffix; "-" clears the list.' }),
            ...fallbackRows(settings, 'advisor'),
            toggle('advisor.watch', 'Watch turns', settings.advisor.watch, value => { settings.advisor.watch = value }, { description: 'Review settled turns and raise at most one note.' }),
            toggle('advisor.showStatus', 'Status line', settings.advisor.showStatus, value => { settings.advisor.showStatus = value }, { description: 'Show advisor working/done in the status bar.' }),
            number('advisor.minToolCalls', 'Min tool calls', settings.advisor.minToolCalls, value => { settings.advisor.minToolCalls = value }, 0, 100),
          ],
        },
        {
          id: 'classifier',
          label: 'Classifier',
          rows: [
            text('classifier.route', 'Decision model', routeText(settings.classifier.provider, settings.classifier.model), value => {
              const route = splitRoute(value)
              settings.classifier.provider = route?.provider ?? null
              settings.classifier.model = route?.model ?? null
            }, { picker: true, placeholder: 'agent route', description: 'provider/model for typed classify decisions; empty uses the agent route. Enter filters registered provider models.' }),
            toggle('classifier.audit', 'Bash audit', settings.classifier.audit, value => { settings.classifier.audit = value }, { description: 'Log a verdict for every bash call.' }),
            toggle('classifier.enforce', 'Enforce on destructive bash', settings.classifier.enforce, value => { settings.classifier.enforce = value }, { description: 'Deny irreversible bash (rm -rf, reset --hard, clean -xfd, force push, DROP) when the in-code gate scores safe < 0.5.' }),
            text('classifier.fallbacks', 'Add fallback', settings.classifier.fallbacks.join(', '), value => {
              settings.classifier.fallbacks = routeList(value)
            }, { picker: true, pickerAppend: true, description: 'provider/model routes tried in order when the primary classify route fails or returns invalid JSON. Enter opens the model list and APPENDS the pick; "-" clears the list.' }),
            ...fallbackRows(settings, 'classifier'),
          ],
        },
        {
          id: 'subagents',
          label: 'Subagents',
          rows: subagentRows,
        },
      ],
    },
    {
      id: 'memory',
      label: 'Memory',
      sections: [
        {
          id: 'munin',
          label: 'Munin',
          rows: [
            text('munin.project', 'Project', settings.munin.project, value => { settings.munin.project = value }, { placeholder: 'MUNIN_PROJECT', description: 'Project id sent with every memory call.' }),
            text('munin.baseUrl', 'Base URL', settings.munin.baseUrl, value => { settings.munin.baseUrl = value }, { placeholder: 'MUNIN_BASE_URL', description: 'Munin server; empty uses the environment or the default.' }),
            toggle('munin.allowProjectConfig', 'Project config', settings.munin.allowProjectConfig, value => { settings.munin.allowProjectConfig = value }, {
              description: 'Allow <repo>/.dsh/ceulen.json to set the Munin endpoint.',
              warning: 'A checkout can then redirect the endpoint; keep the API key in the environment.',
            }),
            secret(context, 'munin.apiKey', 'API key', 'MUNIN_API_KEY', "Enter to save to the DSH credential store ('-' clears); MUNIN_API_KEY in the environment wins."),
            toggle('munin.brief.enabled', 'First-turn brief', settings.munin.brief.enabled, value => { settings.munin.brief.enabled = value }, {
              description: 'Append pinned + recent memories as evidence, not instructions. Resolved in the background, so it lands from the first re-composed prompt (usually turn 2).',
              warning: 'Stale memories poison every turn; the recency filter and the char cap are the guard.',
            }),
            number('munin.brief.maxChars', 'Brief chars', settings.munin.brief.maxChars, value => { settings.munin.brief.maxChars = value }, 200, 4_000),
            number('munin.brief.recencyDays', 'Brief recency (days)', settings.munin.brief.recencyDays, value => { settings.munin.brief.recencyDays = value }, 1, 365),
          ],
        },
        {
          id: 'agentmem',
          label: 'AgentMem',
          rows: [
            text('agentmem.project', 'Project', settings.agentmem.project, value => { settings.agentmem.project = value }, { placeholder: 'AGENTMEM_PROJECT', description: 'Project id sent with every local-store memory call.' }),
            text('agentmem.baseUrl', 'Base URL', settings.agentmem.baseUrl, value => { settings.agentmem.baseUrl = value }, { placeholder: 'AGENTMEM_BASE_URL', description: 'opimem server (a local Munin-protocol store). Empty means unconfigured: AgentMem refuses to guess an endpoint.' }),
            secret(context, 'agentmem.apiKey', 'API key', 'AGENTMEM_API_KEY', "Enter to save to the DSH credential store ('-' clears); AGENTMEM_API_KEY in the environment wins."),
            toggle('agentmem.brief.enabled', 'First-turn brief', settings.agentmem.brief.enabled, value => { settings.agentmem.brief.enabled = value }, {
              description: 'Append pinned + recent local memories as evidence, not instructions. Resolved in the background, so it lands from the first re-composed prompt (usually turn 2).',
              warning: 'Two briefs cost prompt weight; keep one store brief on unless the stores diverge.',
            }),
            number('agentmem.brief.maxChars', 'Brief chars', settings.agentmem.brief.maxChars, value => { settings.agentmem.brief.maxChars = value }, 200, 4_000),
            number('agentmem.brief.recencyDays', 'Brief recency (days)', settings.agentmem.brief.recencyDays, value => { settings.agentmem.brief.recencyDays = value }, 1, 365),
          ],
        },
        {
          id: 'route',
          label: 'Memory route',
          rows: [
            info('munin.route', 'Route', settings.munin.fallback.baseUrl.trim() === '' ? 'primary only' : 'primary → fallback', 'The primary answers every call. The fallback answers when the primary is unreachable (refused, DNS, timeout, 5xx) and for the next 60s, so a dead primary is not paid for on every call.'),
            text('munin.fallback.baseUrl', 'Fallback base URL', settings.munin.fallback.baseUrl, value => { settings.munin.fallback.baseUrl = value }, { placeholder: 'https://munin.kalera.dev', description: 'Empty turns failover off. MUNIN_FALLBACK_BASE_URL in the environment wins.' }),
            secret(context, 'munin.fallback.apiKey', 'Fallback API key', 'MUNIN_FALLBACK_API_KEY', "Saved to the DSH credential store ('-' clears). Never inherited from the primary — a token is scoped to one server."),
          ],
        },
      ],
    },
    {
      id: 'context',
      label: 'Context',
      sections: [
        {
          id: 'rules',
          label: 'Rules',
          rows: [
            text('rules.projectFile', 'Project file', settings.rules.projectFile, value => { settings.rules.projectFile = value }, { placeholder: '.dsh/RULES.md' }),
            text('rules.userFile', 'User file', settings.rules.userFile, value => { settings.rules.userFile = value }, { placeholder: 'RULES.md' }),
            number('rules.maxBytes', 'Max bytes', settings.rules.maxBytes, value => { settings.rules.maxBytes = value }, 1_000, 200_000),
            option('rules.guards', 'Guards', settings.rules.guards, ['off', 'audit', 'enforce'], value => {
              settings.rules.guards = value as CeulenSettings['rules']['guards']
            }, { description: 'when-* rule guards: audit logs matches, enforce denies when-action: deny.' }),
          ],
        },
      ],
    },
  ]
}
