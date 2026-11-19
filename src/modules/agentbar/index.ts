import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, updateSettings } from '../../core/settings.js'
import { errorMessage, registerCommandSafe } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { AgentStore, LINGER_MS, rosterText, summarize, type SessionEvent, type SessionInfo } from './model.js'
import { createPanel } from './panel.js'
import { createBand } from './view.js'

export const name = 'ceulen-agentbar'
export const inject = ['commands']
export const VIEW_KEY = 'ceulen:agentbar'

interface StatusViews {
  registerView?(descriptor: { key: string; maxRows: 1 | 2 | 3; component: unknown }): (() => void) | undefined
}

/** `ctx.tuiPanels`; `reveal` exists only with scripts/tui-panel-patch.mjs applied. */
export interface PanelService {
  register?(descriptor: Record<string, unknown>): (() => void) | undefined
  list?(): readonly { id: string }[]
  reveal?(id: string): boolean
  close?(id: string): boolean
}

export const PANEL_ID = 'subagents'

/**
 * Open the Subagents panel when a batch starts and close it LINGER_MS after the
 * batch ends — only when this controller opened it and the user never focused
 * it. Needs `reveal` (open without taking focus): a stock `open` would pull the
 * keyboard out of the prompt mid-sentence, so without the patch nothing opens.
 */
export function panelAutopilot(store: AgentStore, service: PanelService, id: string, now: () => number = Date.now, enabled: () => boolean = () => true): () => void {
  let running = false
  let opened = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const update = (): void => {
    const summary = summarize(store.batch())
    const active = summary.running.length > 0
    if (active && !running) {
      clear()
      if (!store.panelVisible && enabled()) {
        store.panelTouched = false
        opened = service.reveal?.(id) === true
        logLine('agentbar', opened ? 'panel revealed for a new batch' : 'panel reveal declined (rate limit or no chat)')
      }
    } else if (!active && running && opened && summary.lastEnd !== undefined) {
      clear()
      timer = setTimeout(() => {
        timer = undefined
        if (opened && !store.panelTouched && summarize(store.batch()).running.length === 0) service.close?.(id)
        opened = false
      }, Math.max(0, summary.lastEnd + LINGER_MS - now()))
    }
    running = active
  }
  const unsubscribe = store.subscribe(update)
  return () => {
    unsubscribe()
    clear()
  }
}

/**
 * Subagent progress, after the savvy-progress mod for Claude Code. A delegated
 * child otherwise shows only as a transcript card that scrolls away. Every
 * child session's events feed one store, drawn two ways:
 * - the Subagents side panel (`tuiPanels`): a card per running child with a
 *   moving "Working…", its todo list, context window and cache hit. It opens
 *   beside the chat when a batch starts and closes LINGER_MS after it ends,
 *   but only with scripts/tui-panel-patch.mjs applied (open without focus);
 * - a band of up to 3 rows above the prompt (`tuiStatus`), for inline mode,
 *   narrow terminals or a closed panel. It hides while the panel shows.
 * `/agentbar` prints the whole roster. Headless/ACP/web have neither seam,
 * so only the command is live there.
 */
export function apply(ctx: PluginContext): void {
  if (!isModuleEnabled('agentbar', loadSettingsSync())) return
  const store = new AgentStore()

  ctx.on('session/event', (session: SessionInfo | undefined, event: SessionEvent | undefined) => {
    try {
      store.onEvent(session, event)
    } catch (error) {
      logLine('agentbar', `event skipped: ${errorMessage(error)}`)
    }
  })
  // Backstops for a child that stops without a `turn/end` in its log.
  ctx.on('subagent/end', (info: { id?: unknown; stopReason?: unknown } | undefined) => {
    store.finish(info?.id, typeof info?.stopReason === 'string' ? info.stopReason : undefined)
  })
  ctx.on('agent/disposed', (payload: { agent?: { session?: { id?: unknown } } } | undefined) => {
    store.finish(payload?.agent?.session?.id, 'aborted')
  })

  // Root-activation registrations are refused; register from an injected child.
  try {
    ctx.inject(['tuiStatus'], child => {
      const service = child.get('tuiStatus', false) as StatusViews | undefined
      if (typeof service?.registerView !== 'function') return
      const dispose = service.registerView({ key: VIEW_KEY, maxRows: 3, component: createBand(store) })
      if (dispose === undefined) {
        logLine('agentbar', 'band refused by tuiStatus.registerView (row budget or key in use); /agentbar still works')
        return
      }
      child.effect(() => dispose, 'ceulen agentbar view')
      logLine('agentbar', 'band registered above the prompt')
    })
  } catch {
    // No TUI in this composition.
  }

  // The side panel: a full card per running child next to the chat.
  let revealable = false
  try {
    ctx.inject(['tuiPanels'], child => {
      const service = child.get('tuiPanels', false) as PanelService | undefined
      if (typeof service?.register !== 'function') return
      // Default minColumns (28) = the host's narrowest split, so a split never shows "too narrow".
      const dispose = service.register({ apiVersion: 1, id: PANEL_ID, title: 'Subagents', icon: '◆', component: createPanel(store) })
      if (dispose === undefined) {
        logLine('agentbar', 'panel refused by tuiPanels.register; the band still works')
        return
      }
      child.effect(() => dispose, 'ceulen agentbar panel')
      // The host prefixes '<pluginId>:'; open/close take the full id.
      const id = service.list?.().find(entry => entry.id.endsWith(`:${PANEL_ID}`))?.id
      const canReveal = id !== undefined && typeof service.reveal === 'function'
      revealable = canReveal
      // The setting is read per batch, so `/agentbar auto off` applies without a restart.
      if (canReveal) child.effect(() => panelAutopilot(store, service, id, Date.now, () => loadSettingsSync().agentbar.autoOpen), 'ceulen agentbar panel autopilot')
      logLine('agentbar', `panel registered as ${id ?? '(unknown id)'}; auto-open ${canReveal ? 'available' : 'off (run scripts/tui-panel-patch.mjs apply)'}`)
    })
  } catch {
    // No side-panel seam in this composition.
  }

  registerCommandSafe(ctx, {
    name: 'agentbar',
    description: 'Show every subagent of this session, or turn the Subagents panel auto-open on/off',
    input: { hint: '[auto on|off]' },
    async handler({ rawInput }) {
      const args = (rawInput ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (args[0] !== 'auto') return { kind: 'success', text: rosterText(store.list(), Date.now()) }
      const want = args[1]
      if (want === 'on' || want === 'off') {
        await updateSettings(settings => {
          settings.agentbar.autoOpen = want === 'on'
        })
      } else if (want !== undefined) {
        return { kind: 'error', text: 'Usage: /agentbar auto [on|off]' }
      }
      const on = loadSettingsSync().agentbar.autoOpen
      const note = revealable ? '' : ' It needs `node scripts/tui-panel-patch.mjs apply` (then restart) before it can open without taking focus; until then the panel stays on Ctrl+B.'
      return { kind: 'success', text: `Subagents panel auto-open is ${on ? 'on' : 'off'}.${note}` }
    },
  })

  ctx.effect(() => () => store.reset(), 'ceulen agentbar store')
  logLine('agentbar', 'loaded (/agentbar; the band needs the TUI status seam)')
}
