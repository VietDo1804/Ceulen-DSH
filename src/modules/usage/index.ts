import { AsyncResource } from 'node:async_hooks'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { registerCommandSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import {
  adapterFor,
  configuredAdapters,
  compactLine,
  detailLines,
  type UsageAdapter,
  type UsageSnapshot,
} from './providers.js'

export const name = 'ceulen-usage'

export const inject = ['commands']

interface TokenMeterLike {
  measure(session: unknown): { totalTokens?: number; surfaceTokens?: number; nodes?: readonly unknown[] }
}

function tokenMeterLine(ctx: PluginContext, agent: AgentLike | undefined): string | undefined {
  if (agent === undefined) return undefined
  let meter: TokenMeterLike | undefined
  try {
    meter = ctx.get('tokenMeter', false) as TokenMeterLike | undefined
  } catch {
    meter = undefined
  }
  if (meter === undefined || typeof meter.measure !== 'function') return undefined
  try {
    const measurement = meter.measure(agent.session)
    return `session tokens: ${measurement.totalTokens ?? '?'} total · ${measurement.surfaceTokens ?? '?'} surface · ${measurement.nodes?.length ?? '?'} context nodes`
  } catch {
    return undefined
  }
}

interface TuiStatusService {
  set(key: string, text?: string): unknown
  /** dsh-tui 0.17.0+ footer slot; absent on 0.16.x. */
  setField?(key: string, text: string | undefined, options?: { slot?: string; tone?: string; maxCells?: number }): unknown
}

function statusService(ctx: PluginContext): TuiStatusService | undefined {
  try {
    const service = ctx.get('tuiStatus', false)
    return service !== undefined && typeof service.set === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

function adapterForAgent(agent: AgentLike | undefined, configured: readonly UsageAdapter[]): UsageAdapter | undefined {
  const byRoute = adapterFor(agent?.options.provider)
  if (byRoute !== undefined && configured.some(adapter => adapter.id === byRoute.id)) return byRoute
  return undefined
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('usage', settings) || !settings.usage.enabled) return

  let snapshot: UsageSnapshot | undefined
  let activeId: string | undefined
  let lastFetchAt = 0
  let inFlight: Promise<UsageSnapshot | undefined> | undefined
  let currentProvider: string | undefined
  let mainSessionId: string | undefined
  let statusCtx: PluginContext | undefined
  let disposeStatus: (() => void) | undefined
  let lastRepaintAt = 0
  let inertDisposer: string | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryCount = 0
  let inChild: ((fn: () => unknown) => unknown) | undefined

  const configured = (): UsageAdapter[] => {
    const all = configuredAdapters()
    const filter = settings.usage.providers
    return filter.length === 0 ? all : all.filter(adapter => filter.includes(adapter.id))
  }

  // dsh-tui accepts a footer field only from inside the writing plugin's own
  // activation (an async-context token). A write that runs in another context,
  // such as the fetch started by `agent/created` at startup, is refused with
  // no error, so the line never appeared until a later event rewrote it. Every
  // write therefore runs through `inChild`, captured in the inject callback.
  // A refused write returns the same inert disposer the host returns for
  // clearing a key that is not set; compare against that and retry.
  const refused = (target: TuiStatusService, disposer: unknown): boolean => {
    if (typeof target.setField !== 'function' || typeof disposer !== 'function') return false
    try {
      if (inertDisposer === undefined) {
        const probe = (): unknown => target.setField?.('ceulen:usage-probe', undefined)
        const inert = inChild === undefined ? probe() : inChild(probe)
        inertDisposer = typeof inert === 'function' ? String(inert) : ''
      }
      return inertDisposer !== '' && String(disposer) === inertDisposer
    } catch {
      return false
    }
  }

  const retryPaint = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    if (snapshot === undefined || activeId === undefined) return
    if (currentProvider !== undefined && adapterFor(currentProvider)?.id !== activeId) return
    setStatus(compactLine(snapshot))
  }

  // Safety net only: a handful of spaced attempts, so a host that keeps
  // refusing (its field cap, say) is not asked again every two seconds forever.
  const scheduleRetry = (): void => {
    if (retryTimer !== undefined || retryCount >= 5) return
    retryCount += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      retryPaint()
    }, 2_000 * 2 ** (retryCount - 1))
    retryTimer.unref?.()
  }

  const setStatus = (text: string | undefined): void => {
    // The TUI rejects a status write from the plugin's composition root and
    // recomposes services when a session starts, so resolve the service from
    // the injected child activation on every write instead of caching one.
    const target = statusCtx === undefined ? undefined : statusService(statusCtx)
    // While the service is recomposing there is nothing to paint into; keep
    // the contribution already on screen rather than releasing it into a hole
    // that only the next composition can refill.
    if (target === undefined) return
    // 0.17.0+ renders plugin fields inside the footer row; older TUIs only have
    // the status line above the prompt. Prefer the host field when it exists.
    // Publish first, then release the previous write: the host clears only the
    // exact write its disposer belongs to, so the old contribution stays on
    // screen if this one is refused, and a long session never accumulates one
    // disposer per poll.
    const previous = disposeStatus
    disposeStatus = undefined
    let wrote = text === undefined
    if (text !== undefined) {
      try {
        const write = (): unknown => typeof target.setField === 'function'
          ? target.setField('ceulen:usage', text, { slot: 'right-head', tone: 'dim', maxCells: 64 })
          : target.set('ceulen:usage', text)
        const disposer = inChild === undefined ? write() : inChild(write)
        if (refused(target, disposer)) {
          // Nothing reached the footer: keep the old contribution and try again.
          scheduleRetry()
        } else {
          if (typeof disposer === 'function') disposeStatus = disposer as () => void
          wrote = true
          retryCount = 0
        }
      } catch {
        // Optional surface.
      }
    }
    if (wrote) {
      try {
        previous?.()
      } catch {
        // Removed composition.
      }
    } else {
      disposeStatus = previous
    }
  }

  // A session swap recomposes the TUI services; the store the first publish
  // reached may already be gone. Repaint the cached snapshot on the events
  // that bracket the new composition (no extra fetch).
  const repaint = (): void => {
    if (snapshot === undefined || activeId === undefined) return
    if (currentProvider !== undefined && adapterFor(currentProvider)?.id !== activeId) return
    if (Date.now() - lastRepaintAt < 1_000) return
    lastRepaintAt = Date.now()
    setStatus(compactLine(snapshot))
  }

  const publish = (selected: UsageAdapter): void => {
    activeId = selected.id
    if (!settings.usage.showStatus || snapshot === undefined) return
    // An explicit `/usage` may inspect any configured provider, but the
    // footer belongs to the session route: never paint another provider's
    // windows next to a model that is not on that subscription.
    if (currentProvider !== undefined && adapterFor(currentProvider)?.id !== selected.id) return
    setStatus(compactLine(snapshot))
  }

  const refresh = async (
    agent: AgentLike | undefined,
    force = false,
    requested?: string,
    strict = false,
  ): Promise<UsageSnapshot | undefined> => {
    if (inFlight !== undefined) await inFlight
    const adapters = configured()
    const route = requested === undefined
      ? adapterForAgent(agent, adapters) ?? (strict ? undefined : adapters[0])
      : adapters.find(adapter => adapter.id === requested) ?? adapterFor(requested)
    const selected = route !== undefined && adapters.some(adapter => adapter.id === route.id) ? route : undefined
    if (selected === undefined) {
      // The status line follows the model: an unsubscribed route shows nothing,
      // while an explicit `/usage` still explains why there is no data.
      activeId = undefined
      if (strict) {
        snapshot = undefined
        setStatus(undefined)
        return undefined
      }
      snapshot = {
        providerDisplayName: requested ?? 'usage',
        accounts: [],
        fetchedAt: Date.now(),
        error: adapters.length === 0
          ? 'no provider credentials found (env or ~/.dsh/.credentials.yaml)'
          : `provider "${requested ?? agent?.options.provider ?? 'unknown'}" is not configured`,
      }
      setStatus(undefined)
      return snapshot
    }
    if (!force && snapshot !== undefined && activeId === selected.id && Date.now() - lastFetchAt < 60_000) return snapshot
    inFlight = (async () => {
      const result = await selected.fetchUsage()
      snapshot = result
      lastFetchAt = Date.now()
      publish(selected)
      logLine('usage', `${selected.id}: ${result.error ?? 'ok'}`)
      return result
    })().finally(() => {
      inFlight = undefined
    })
    return await inFlight
  }

  if (settings.usage.showStatus) {
    // The TUI mounts its status service after the plugin tree; a late
    // subscription repaints the first snapshot instead of waiting one interval.
    try {
      ctx.inject(['tuiStatus'], child => {
        if (statusService(child) === undefined) return
        statusCtx = child
        // Bound here, inside the child activation, so later writes from timers
        // and fetch continuations carry this activation's context.
        inChild = AsyncResource.bind((fn: () => unknown): unknown => fn())
        retryCount = 0
        if (snapshot !== undefined && activeId !== undefined) setStatus(compactLine(snapshot))
      })
    } catch {
      // Optional surface.
    }
  }

  const timer = setInterval(() => {
    if (currentProvider !== undefined) void refresh(undefined, false, currentProvider, true)
  }, Math.max(1, settings.usage.intervalMinutes) * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'ceulen usage timer')
  const initial = setTimeout(() => {
    if (currentProvider !== undefined) void refresh(undefined, false, currentProvider, true)
  }, 1_500)
  initial.unref?.()
  ctx.effect(() => () => clearTimeout(initial), 'ceulen usage initial refresh')
  ctx.effect(() => () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
  }, 'ceulen usage footer retry')
  ctx.on('agent/status', () => repaint())
  ctx.on('session/created', () => repaint())
  ctx.on('agent/created', (payload: { agent?: AgentLike; source?: string }) => {
    const agent = payload?.agent
    if (agent === undefined || agent.session?.header?.parentSession !== undefined) return
    mainSessionId = agent.session?.id
    currentProvider = agent.options.provider
    void refresh(agent, true, undefined, true)
  })
  // A route change is the one event that must move the line immediately;
  // waiting for the next poll would show another provider's windows. Web
  // clients report the live route on every request instead of emitting
  // model/selection, so both events move the line, and only a provider change
  // refetches (request/context repeats each turn).
  ctx.on('session/event', (session: { id?: string } | undefined, event: { type?: string; data?: { provider?: string } } | undefined) => {
    // Any event of the main session (a slash command, a model pick) is a sign
    // the chat is on screen: land a refused footer write now, not on the timer.
    if (retryTimer !== undefined && (mainSessionId === undefined || session?.id === undefined || session.id === mainSessionId)) retryPaint()
    if (event?.type !== 'model/selection' && event?.type !== 'request/context') return
    if (mainSessionId !== undefined && session?.id !== undefined && session.id !== mainSessionId) return
    const provider = event.data?.provider
    if (provider === undefined || provider === currentProvider) return
    currentProvider = provider
    void refresh(undefined, true, currentProvider, true)
  })

  registerCommandSafe(ctx, {
    name: 'usage',
    description: 'Show subscription usage windows, credits, and DSH token/context usage',
    input: { hint: '[--all|provider|refresh]' },
    async handler({ agent, rawInput }) {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const all = args.includes('--all') || args.includes('all')
      const force = args.includes('refresh')
      const requested = args.find(arg => !arg.startsWith('--') && arg !== 'all' && arg !== 'refresh')
      const tokenLine = tokenMeterLine(ctx, agent)
      const lines: string[] = []

      if (all) {
        const adapters = configured()
        if (adapters.length === 0) {
          return {
            kind: 'error',
            text: 'No subscription provider credentials found. Set OPENCODE_GO_API_KEY, ZAI_API_KEY, COMMAND_CODE_API_KEY, or ROUTER_API_KEY/ROUTER_BASE_URL (env or ~/.dsh/.credentials.yaml).',
          }
        }
        for (const adapter of adapters) {
          const result = await adapter.fetchUsage()
          lines.push(...detailLines(result), '')
        }
        if (tokenLine !== undefined) lines.push(tokenLine)
        return { kind: 'success', text: lines.join('\n').trim() }
      }

      const result = await refresh(agent, force, requested)
      if (result === undefined) return { kind: 'error', text: 'usage refresh did not return a snapshot' }
      lines.push(...detailLines(result, tokenLine === undefined ? {} : { tokenLine }))
      const adapters = configured()
      if (adapters.length > 1) lines.push(`configured: ${adapters.map(adapter => adapter.id).join(', ')} · /usage --all for everything`)
      if (result.error !== undefined) lines.push('Check the matching credential in the environment or ~/.dsh/.credentials.yaml.')
      return { kind: result.error === undefined ? 'success' : 'error', text: lines.join('\n') }
    },
  })
}
