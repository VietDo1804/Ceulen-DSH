/**
 * Public package entry. The bundle has no single `apply`: every module is its
 * own Cordis row (`ceulen-dsh/modules/<name>`) so it can be enabled, disabled
 * and reloaded independently.
 */
export { pluginVersion, upstreamBaseVersion, compareSemver } from './core/version.js'
export { loadParity, formatParity, statusLabel, summary } from './core/parity.js'
export type { ParityDoc, ParityModule, ParityStatus } from './core/parity.js'
export { defaultSettings, loadSettingsSync, normalizeSettings } from './core/settings.js'
export type { CeulenSettings } from './core/settings.js'
export type { PluginContext, ToolDefinition, ToolRunContext } from './core/types.js'
