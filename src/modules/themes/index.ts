import type { PluginContext, TuiThemeService } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { THEMES as PI_THEMES } from '../../themes/generated.js'
import { NOIR_THEMES } from '../../themes/noir.js'
import { logLine } from '../../core/log.js'
import { errorMessage } from '../../core/tools.js'

// Converted Pi themes plus the noir pair that goes with `/theme style skins`.
const THEMES = [...PI_THEMES, ...NOIR_THEMES]

export const name = 'ceulen-themes'
export const inject = []

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('themes', settings)) return

  let done = false
  const registerAll = (source: PluginContext): void => {
    if (done) return
    const runtime = source.get('tuiThemes', false) as TuiThemeService | undefined
    if (runtime === undefined || typeof runtime.register !== 'function') return
    done = true
    let registered = 0
    for (const theme of THEMES) {
      try {
        runtime.register({ name: theme.name, displayName: theme.displayName, base: theme.base, colors: theme.colors })
        registered += 1
      } catch (error) {
        logLine('themes', `failed to register ${theme.name}: ${errorMessage(error)}`)
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
