/**
 * Row model behind `/config` — the DSH port of Ceulen's central settings panel.
 *
 * The model is deliberately React-free: every tab/section/row is data over one
 * working `CeulenSettings` object, so the full-screen scene and the text
 * fallback share exactly the same rows and the same defaults.
 *
 * The split: types.ts (row/tab shapes), rows.ts (row builders), helpers.ts
 * (value and route helpers), tabs-core.ts (Appearance/Model/Memory/Context),
 * tabs-extra.ts (Shell/Tasks/Providers/Tools/Plugins), edit.ts (value display,
 * parsing and the text summary). This file composes them and is the module's
 * public surface.
 */
import type { CeulenSettings } from '../../core/settings.js'
import type { ConfigContext, ConfigTab } from './types.js'
import { buildCoreTabs, buildSubagentRows } from './tabs-core.js'
import { buildExtraTabs } from './tabs-extra.js'

export * from './types.js'
export { appendRouteList, clampNumber, filterRoutes, keepEffort, pickerRoute } from './helpers.js'
export { displayValue, parseEditValue, summaryLines } from './edit.js'

/** Build every tab from the current settings values. Rows mutate `settings`. */
export function buildConfigTabs(settings: CeulenSettings, context: ConfigContext): ConfigTab[] {
  const routes = context.routes ?? []
  const a2aPeers = Array.isArray(settings.a2a.peers) ? settings.a2a.peers.length : 0
  return [
    ...buildCoreTabs(settings, context, buildSubagentRows(settings)),
    ...buildExtraTabs(settings, context, routes, a2aPeers),
  ]
}
