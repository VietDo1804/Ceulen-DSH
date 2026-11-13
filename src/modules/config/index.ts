/**
 * `/ceulen-config` — the central settings panel for every Ceulen module.
 *
 * The bare `/config` name is registered too, but the TUI owns a local command
 * by that name (it prints the dsh-tui configuration source) and local commands
 * win collisions, so `/ceulen-config` is the spelling to document for the TUI.
 *
 * The command opens a full-screen TUI scene (registered through `tuiScenes`)
 * and falls back to a text dump in headless or non-TUI compositions. Values
 * are written to `$DSH_HOME/ceulen/settings.json` on save; modules that read
 * the file per call pick them up immediately, timers and prompt sections need
 * `/reload`.
 */

import type { LlmService, PluginContext } from '../../core/types.js'
import { loadSettingsSync } from '../../core/settings.js'
import { registerCommandSafe, errorMessage } from '../../core/tools.js'
import { displayPath, settingsPath } from '../../core/paths.js'
import { logLine } from '../../core/log.js'
import { buildConfigTabs, summaryLines, type ConfigContext, type ConfigProvider } from './model.js'
import { createConfigScene } from './scene.js'

const SCENE_ID = 'ceulen-config'

interface TuiScenesLike {
  register(descriptor: { id: string; title?: string; component: unknown }, identity?: unknown): () => void
  open(id: string): boolean
}

interface CredentialStoreLike {
  set(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
}

/**
 * The panel's secret rows write through the DSH credential store, where the
 * host already keeps provider keys. Empty input unsets (the store refuses an
 * empty value by design).
 */
function credentialWriter(ctx: PluginContext): { write(ref: string, value: string): Promise<void> } {
  return {
    async write(ref, value) {
      const store = ctx.get('credentials', false) as CredentialStoreLike | undefined
      if (store === undefined || typeof store.set !== 'function') throw new Error('credential store is not mounted')
      if (value.length === 0) {
        if (typeof store.unset === 'function') await store.unset(ref)
        return
      }
      await store.set(ref, value)
    },
  }
}

function sceneService(ctx: PluginContext): TuiScenesLike | undefined {
  try {
    const service = ctx.get('tuiScenes', false) as TuiScenesLike | undefined
    if (service === undefined || typeof service.register !== 'function' || typeof service.open !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * The `llm` seam, read without Cordis's inject requirement: the panel is
 * mounted from the status row, whose context never injects `llm`, and a plain
 * `ctx.llm` read there throws "cannot get property without inject" — which
 * surfaced as an empty model picker.
 */
function llmOf(ctx: PluginContext): LlmService | undefined {
  return ctx.get('llm', false) as LlmService | undefined
}

/** The config panel reports whether codemode can run, without requiring the service. */
function ptcRuntimeMounted(ctx: PluginContext): boolean {
  try {
    return ctx.get('ptcRuntime', false) !== undefined
  } catch {
    return false
  }
}

/** Use adapter authentication metadata, never provider-name guesses or secrets. */
export function collectConfigProviders(ctx: PluginContext): ConfigProvider[] {
  try {
    const llm = llmOf(ctx)
    const list = llm?.listProviders?.() ?? []
    let directory: ReturnType<NonNullable<LlmService['listConfigurableProviders']>> = []
    try {
      directory = llm?.listConfigurableProviders?.() ?? []
    } catch {
      // An older/broken directory must not hide the registered providers.
    }
    return list.map(entry => {
      const record = typeof entry === 'string' ? { id: entry } : entry as { id?: string; name?: string }
      const id = record.id ?? String(entry)
      const auth = directory.find(provider => provider.provider === id)?.nativeAuth
      return {
        id,
        name: record.name ?? id,
        auth: auth?.oauth === true ? 'login' : auth !== undefined && auth.env.length > 0 ? 'api-key' : 'unknown',
      }
    })
  } catch {
    return []
  }
}

/**
 * `provider/model` for every model the registered providers advertise, in
 * registry order. One provider failing discovery must not hide the rest, so
 * each lookup settles independently.
 */
export async function collectModelRoutes(ctx: PluginContext): Promise<string[]> {
  const llm = llmOf(ctx)
  const listModels = llm?.listModels?.bind(llm)
  if (listModels === undefined) return []
  const providers: string[] = []
  for (const entry of llm?.listProviders?.() ?? []) {
    const id = typeof entry === 'string' ? entry : (entry as { id?: string }).id
    if (typeof id === 'string' && id.length > 0) providers.push(id)
  }
  const settled = await Promise.allSettled(providers.map(async provider => {
    const models = await listModels(provider)
    return models.flatMap(model => {
      const id = typeof model === 'string' ? model : (model as { id?: string }).id
      return typeof id === 'string' && id.length > 0 ? [`${provider}/${id}`] : []
    })
  }))
  return [...new Set(settled.flatMap(result => result.status === 'fulfilled' ? result.value : []))]
}

function configContext(ctx: PluginContext): ConfigContext {
  const providers = collectConfigProviders(ctx)
  return {
    settingsFile: displayPath(settingsPath()),
    providers,
    routes: providers.map(provider => provider.id),
    modelRoutes: () => collectModelRoutes(ctx),
    codemodeRuntime: ptcRuntimeMounted(ctx),
    env: process.env,
  }
}

function toast(ctx: PluginContext, text: string): void {
  try {
    const service = ctx.get('tuiToast', false) as { show?(text: string, options?: { color?: string }): unknown } | undefined
    service?.show?.(text, { color: 'success' })
  } catch {
    // A toast is optional; the save already landed.
  }
}

function textSummary(ctx: PluginContext, filter?: string): { kind: 'success' | 'error'; text: string } {
  const tabs = buildConfigTabs(loadSettingsSync(), configContext(ctx))
  if (filter === undefined || filter.length === 0) {
    return { kind: 'success', text: summaryLines(tabs, displayPath(settingsPath())) }
  }
  const key = filter.toLowerCase()
  const selected = tabs.filter(tab => tab.id === key || tab.label.toLowerCase() === key || tab.id.startsWith(key))
  if (selected.length === 0) {
    return { kind: 'error', text: `unknown tab "${filter}". Tabs: ${tabs.map(tab => tab.label).join(', ')}` }
  }
  return { kind: 'success', text: summaryLines(selected, displayPath(settingsPath())) }
}

function helpText(ctx: PluginContext, command = 'ceulen-config'): string {
  const tabs = buildConfigTabs(loadSettingsSync(), configContext(ctx))
  return [
    `Usage: /${command} [show [tab] | <tab> | help]`,
    '',
    `  /${command}            open the full-screen settings panel (TUI)`,
    `  /${command} show       print every effective setting as text`,
    `  /${command} show <tab> print one tab as text`,
    `  /${command} <tab>      same as /${command} show <tab>`,
    `  /${command} help       this text`,
    '',
    `Tabs: ${tabs.map(tab => tab.label).join(', ')}`,
    `File: ${displayPath(settingsPath())} (API keys live in the DSH credential store)`,
    'Esc saves and closes the panel. Module kill switches stay under /ceulen module.',
    '',
    'DSH reserves the bare /config local command, so the TUI spelling is /ceulen-config.',
  ].join('\n')
}

export interface ConfigPanelApi {
  /** Open the scene when a TUI is mounted; false means "use text()". */
  open(): boolean
  text(filter?: string): { kind: 'success' | 'error'; text: string }
  help(command?: string): string
}

/**
 * Register the config panel (scene + commands) and return the handles the
 * status row uses for `/ceulen config`.
 *
 * DSH owns a local `/config` command ("show the dsh-tui configuration
 * source") and local commands win name collisions, so the scene is reachable
 * as `/ceulen-config` in the TUI. The bare `/config` registration still works
 * in compositions that do not ship that local command (headless, web).
 */
export function applyConfig(ctx: PluginContext): ConfigPanelApi {
  let service: TuiScenesLike | undefined
  let registered = false
  let disposer: (() => void) | undefined
  let injectionTried = false

  const registerScene = (context: PluginContext): void => {
    if (registered) return
    const scenes = sceneService(context)
    if (scenes === undefined) return
    try {
      disposer = scenes.register({
        id: SCENE_ID,
        title: 'Ceulen config',
        component: createConfigScene({
          context: () => configContext(ctx),
          onSaved: () => toast(ctx, 'Ceulen settings saved'),
          secret: credentialWriter(ctx),
        }),
      })
      service = scenes
      registered = true
      ctx.effect(() => () => {
        disposer?.()
        disposer = undefined
        registered = false
      }, 'ceulen config scene')
      logLine('config', 'registered the /config scene')
    } catch (error) {
      logLine('config', `scene registration failed: ${errorMessage(error)}`)
    }
  }

  const ensureScene = (): TuiScenesLike | undefined => {
    if (registered) return service
    // `ctx.inject` gives the registration a live child activation, which the
    // tuiScenes guard requires. The callback may run after apply; the direct
    // attempt keeps a non-strict embedder working.
    if (!injectionTried) {
      injectionTried = true
      try {
        ctx.inject(['tuiScenes'], child => {
          registerScene(child)
        })
      } catch (error) {
        injectionTried = false
        logLine('config', `scene injection unavailable: ${errorMessage(error)}`)
      }
    }
    if (!registered) registerScene(ctx)
    return registered ? service : undefined
  }

  const open = (): boolean => {
    const scenes = ensureScene()
    if (scenes === undefined) return false
    try {
      return scenes.open(SCENE_ID)
    } catch (error) {
      logLine('config', `scene open failed: ${errorMessage(error)}`)
      return false
    }
  }

  const panel: ConfigPanelApi = {
    open,
    text: filter => textSummary(ctx, filter),
    help: command => helpText(ctx, command),
  }

  const handler = (command: string) => ({ rawInput }: { rawInput: string }) => {
    const args = rawInput.trim().split(/\s+/).filter(Boolean)
    const head = args[0] ?? ''
    if (head === 'help' || head === '--help' || head === '-h') {
      return { kind: 'success' as const, text: panel.help(command) }
    }
    if (head === 'show') return panel.text(args[1])
    if (head.length > 0) return panel.text(head)
    if (open()) return { kind: 'success' as const, text: '' }
    return panel.text()
  }

  // `/ceulen-config` is the TUI spelling; `/config` covers compositions
  // where DSH does not own the name.
  registerCommandSafe(ctx, {
    name: 'ceulen-config',
    description: 'Ceulen settings panel: edit every bundle setting (full-screen in the TUI)',
    input: { hint: '[show [tab]|<tab>|help]' },
    handler: handler('ceulen-config'),
  })
  registerCommandSafe(ctx, {
    name: 'config',
    description: 'Ceulen settings panel: edit every bundle setting (shadowed by the TUI local /config)',
    input: { hint: '[show [tab]|<tab>|help]' },
    handler: handler('config'),
  })

  ensureScene()
  return panel
}
