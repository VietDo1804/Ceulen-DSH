/**
 * Ceulen web module: providers, the model-facing web tools and the status
 * command. The split keeps the seams readable:
 *
 * - types.ts     service shapes and provider interfaces
 * - text.ts      HTML → text
 * - fetch.ts     fetch page (DeepSeek Markdown) + local public-URL fetch leg
 * - capture.ts   headless-Chrome capture scope, screenshot/PDF persistence
 * - providers.ts Brave search + fetch-fallback registration
 * - tools.ts     web_extract/map/screenshot/pdf/interact/chat/status
 * - url-guard.ts the public-URL and capture-target guard
 */
import type { PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync } from '../../core/settings.js'
import { credential } from '../../core/credentials.js'
import { registerCommandSafe } from '../../core/tools.js'
import { loadChatGptAuth } from '../../vendor/ceulen/web/chatgpt.js'
import { registerBrave, registerFetchFallback, webProviders } from './providers.js'
import { registerWebTools } from './tools.js'

export const name = 'ceulen-web'
export const inject = ['tools', 'commands']

// Public surface kept on the module entry: tests and other adapters use these.
export { htmlToText } from './text.js'
export { createBraveProvider } from './providers.js'
export { createFallbackFetchProvider, FALLBACK_FETCH_PROVIDER_ID } from './fetch.js'
export { assertCaptureScope } from './capture.js'

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('web', settings)) return

  registerBrave(ctx)
  registerFetchFallback(ctx)
  registerWebTools(ctx)

  registerCommandSafe(ctx, {
    name: 'web-status',
    description: 'Show web backend/tool status',
    handler() {
      const web = ctx.get('web', false) !== undefined
      const brave = credential('BRAVE_API_KEY').value === undefined ? 'unset' : 'set'
      const chatGpt = loadChatGptAuth()
      const chat = chatGpt.auth === null ? 'chatgpt not configured' : `chatgpt ready (${chatGpt.auth.plan ?? 'plan unknown'})`
      return { kind: 'success', text: `web service: ${web ? 'mounted' : 'not mounted'}\nbrave provider: ${webProviders.brave ? 'registered' : 'not registered'} (key ${brave})\n${chat}\nextras: web_extract, web_map, web_chat` }
    },
  })
}
