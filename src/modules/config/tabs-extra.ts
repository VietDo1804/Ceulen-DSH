import type { CeulenSettings } from '../../core/settings.js'
import { info, number, secret, text, toggle } from './rows.js'
import { planTargets } from './helpers.js'
import type { ConfigContext, ConfigTab } from './types.js'

/** Shell, Tasks, Providers, Tools and Plugins tabs. */
export function buildExtraTabs(
  settings: CeulenSettings,
  context: ConfigContext,
  routes: readonly string[],
  a2aPeers: number,
): ConfigTab[] {
  return [
    {
      id: 'shell',
      label: 'Shell',
      sections: [
        {
          id: 'rtk',
          label: 'RTK',
          rows: [
            toggle('rtk.enabled', 'RTK rewrites', settings.rtk.enabled, value => { settings.rtk.enabled = value }, { description: 'Offer the two-step rtk -> bash rewrite for supported commands.' }),
            info('shell.policy', 'DSH shell policy', 'native', 'Sandbox, approval and filesystem policy live in the native /settings screen, not in this file.'),
          ],
        },
      ],
    },
    {
      id: 'tasks',
      label: 'Tasks',
      sections: [
        {
          id: 'plan',
          label: 'Plan mode',
          rows: [
            text('plan.model', 'Planning model', settings.plan.model, value => { settings.plan.model = value.trim() }, {
              picker: true,
              placeholder: 'client route',
              description: 'provider/model[:effort] answering while plan mode is active. Empty inherits the route the client selected.',
            }),
            text('plan.implement', 'Implementation model', settings.plan.implement, value => { settings.plan.implement = value.trim() }, {
              picker: true,
              placeholder: 'client route',
              description: 'provider/model[:effort] answering once a plan was submitted — approved execution, including a fresh approved session. Empty inherits the client route.',
            }),
            info('plan.resolved', 'Resolves to', planTargets(settings), 'A /model switch during a phase stands the configured route down until the phase changes.'),
          ],
        },
        {
          id: 'cron',
          label: 'Cron',
          rows: [
            toggle('cron.enabled', 'Scheduler', settings.cron.enabled, value => { settings.cron.enabled = value }),
            number('cron.tickMs', 'Tick (ms)', settings.cron.tickMs, value => { settings.cron.tickMs = value }, 5_000, 600_000, { description: 'How often cron checks for a due job.' }),
          ],
        },
        {
          id: 'a2a',
          label: 'A2A',
          rows: [
            info('a2a.peers', 'Peers', `${a2aPeers} configured`, 'Edit a2a.peers as JSON objects in the settings file; there is no peer editor in this panel yet.'),
          ],
        },
      ],
    },
    {
      id: 'providers',
      label: 'Providers',
      sections: [
        {
          id: 'overview',
          label: 'Provider registry',
          rows: [
            info('providers.routes', 'Registered routes', String(context.providers?.length ?? routes.length), 'Providers come from DSH. Manage provider accounts in the native settings; this panel never displays tokens.'),
          ],
        },
        ...(['api-key', 'login', 'unknown'] as const).map(auth => {
          const providers = (context.providers ?? routes.map(id => ({ id, name: id, auth: 'unknown' as const }))).filter(provider => provider.auth === auth)
          return {
            id: `providers-${auth}`,
            label: auth === 'api-key' ? 'API key providers' : auth === 'login' ? 'Sign-in providers · OAuth' : 'Other / custom providers',
            rows: providers.length === 0
              ? [info(`providers.${auth}.empty`, 'Providers', '(none)')]
              : providers.map(provider => info(`providers.account.${provider.id}`, provider.name, provider.id, auth === 'unknown' ? 'Authentication not advertised by the adapter; no assumptions made.' : 'Native authentication reported by DSH; profile credential overrides may differ.')),
          }
        }),
        {
          id: 'provider-credentials',
          label: 'API key credential store',
          rows: [
            secret(context, 'providers.zaiKey', 'Z.AI key', 'ZAI_ANTHROPIC_API_KEY', "Enter saves to the DSH credential store ('-' clears); route it with apiKeyEnv: ZAI_ANTHROPIC_API_KEY."),
          ],
        },
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      sections: [
        {
          id: 'codemode',
          label: 'Codemode',
          rows: [
            toggle('codemode.enabled', 'Codemode tool', settings.codemode.enabled, value => { settings.codemode.enabled = value }, {
              description: 'Run one JavaScript program that calls the other tools; only the script result reaches the model. Applies on the next DSH start.',
              warning: 'The script can call every visible tool with the same authority as a direct call; approvals and guards still apply. The DSH PTC runtime is a Node subprocess, not QuickJS.',
            }),
            info('codemode.runtime', 'Runtime', context.codemodeRuntime === true ? 'mounted (ptcRuntime)' : 'not mounted', 'Needs the dsh-ptc-runtime-node row; the DSH base bundle mounts it.'),
            number('codemode.chainHintAfter', 'Chain hint after', settings.codemode.chainHintAfter, value => { settings.codemode.chainHintAfter = value }, 0, 20, { description: 'Hint after this many consecutive single read-only steps; 0 disables.' }),
          ],
        },
        {
          id: 'gh',
          label: 'GitHub',
          rows: [
            toggle('gh.enabled', 'GitHub tool', settings.gh.enabled, value => { settings.gh.enabled = value }, { description: 'Read-only github tool over the gh CLI; also needs the binary.' }),
          ],
        },
        {
          id: 'web',
          label: 'Web',
          rows: [
            info('web.native', 'Search/extract', 'native DSH web service'),
            secret(context, 'web.brave', 'Brave API key', 'BRAVE_API_KEY', "Registers the Brave search provider for web_search; pin web.searchProvider to brave. Enter saves to the DSH credential store ('-' clears)."),
            info('web.browser', 'Browser capture', 'local Chrome/Chromium', '/web-status reports which backends are ready.'),
          ],
        },
      ],
    },
    {
      id: 'plugins',
      label: 'Plugins',
      sections: [
        {
          id: 'upstream',
          label: 'Upstream',
          rows: [
            toggle('upstream.enabled', 'Release checks', settings.upstream.enabled, value => { settings.upstream.enabled = value }),
            number('upstream.intervalHours', 'Check (hours)', settings.upstream.intervalHours, value => { settings.upstream.intervalHours = value }, 1, 720),
          ],
        },
        {
          id: 'paths',
          label: 'Paths & switches',
          rows: [
            info('plugins.settingsFile', 'Settings file', context.settingsFile),
            info('plugins.killSwitch', 'Module switch', '/ceulen module off <name>'),
            info('plugins.reload', 'Apply', '/reload', 'Module timers and prompt sections need /reload; values read per call apply immediately.'),
            info('plugins.dsh', 'DSH core', '/settings', 'Models, themes, shell, subagents and the rest are native DSH settings.'),
          ],
        },
      ],
    },
  ]
}
