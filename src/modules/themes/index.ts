import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { THEMES } from '../../themes/generated.js'
import { logLine } from '../../core/log.js'

export const name = 'ceulen-themes'
export const inject = []

interface ThemeRuntime {
  register(descriptor: {
    name: string
    displayName?: string
    base: 'light' | 'dark' | 'dark-ansi' | 'claude-dark' | 'claude-paper' | 'codex-lavender' | 'codex-paper'
    colors?: Readonly<Record<string, string>>
  }): () => void
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('themes', settings)) return

  let done = false
  const registerAll = (source: PluginContext): void => {
    if (done) return
    const runtime = source.get('tuiThemes', false) as ThemeRuntime | undefined
    if (runtime === undefined || typeof runtime.register !== 'function') return
    done = true
    let registered = 0
    for (const theme of THEMES) {
      try {
        runtime.register({ name: theme.name, displayName: theme.displayName, base: theme.base, colors: theme.colors })
        registered += 1
      } catch (error) {
        logLine('themes', `failed to register ${theme.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    logLine('themes', `registered ${registered}/${THEMES.length} Ceulen themes`)
  }

  registerAll(ctx)
  if (done) return
  // The TUI can mount its theme service after the plugin tree. Without a late
  // subscription the module returned silently and no Ceulen theme was listed.
  try {
    ctx.inject(['tuiThemes'], child => registerAll(child))
  } catch {
    // Optional surface: headless and web profiles have no theme service.
  }
}
