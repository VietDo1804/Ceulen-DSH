import type { PluginContext } from '../../core/types.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe } from '../../core/tools.js'
import { credential } from '../../core/credentials.js'
import { findChromeBinary, capturePdf, captureScreenshot } from '../../vendor/ceulen/web/chrome.js'
import { runInteraction, validateSteps, type InteractStep } from '../../vendor/ceulen/web/cdp.js'
import { chatgptWebChat, describeChatGptError, loadChatGptAuth } from '../../vendor/ceulen/web/chatgpt.js'
import { chatgptChat, describeChatApiError, loadChatConfig } from '../../vendor/ceulen/web/chatapi.js'
import { ignoredNote, normalizeInteractArgs, normalizeScreenshotArgs } from './args.js'
import { assertCaptureScope, IMAGE_RESULT_SCHEMA, imageRender, savePdfFile, saveScreenshot } from './capture.js'
import { FALLBACK_FETCH_PROVIDER_ID, fetchPage, fetchHtmlPage } from './fetch.js'
import { webProviders } from './providers.js'
import { htmlToText } from './text.js'

// Both schemas let undeclared keys through (third argument): the aliases models
// send are mapped in args.ts, and whatever is left is named in the result.
const SCREENSHOT_PARAMETERS = objectSchema({
  url: { type: 'string', description: 'http(s) or workspace file:// URL.' },
  width: { type: 'integer', description: 'Viewport width (default 1280).' },
  height: { type: 'integer', description: 'Viewport height (default 800).' },
  fullPage: { type: 'boolean', description: 'Use a tall 8000px window to approximate a full page.' },
  reducedMotion: { type: 'boolean', description: 'Force prefers-reduced-motion: reduce.' },
  waitForSec: { type: 'number', description: 'Settle time before capture, seconds.' },
}, ['url'], true)

const INTERACT_PARAMETERS = objectSchema({
  url: { type: 'string', description: 'http(s) or workspace file:// URL.' },
  steps: {
    type: 'array',
    description: 'Ordered interaction steps, exactly one action key per step.',
    items: { type: 'object', additionalProperties: true },
  },
  viewport: { type: 'object', additionalProperties: true, description: '{width,height?,device_scale_factor?}.' },
  reducedMotion: { type: 'boolean', description: 'Force prefers-reduced-motion: reduce.' },
  waitForSec: { type: 'number', description: 'Settle time after load, seconds.' },
  stepTimeoutMs: { type: 'integer', description: 'Per-step budget (default 60000).' },
  grant: { type: 'array', items: { type: 'string' }, description: 'Browser permissions to grant, e.g. clipboard-read.' },
}, ['url'], true)

/** The seven model-facing web tools; the command surface stays in index.ts. */
export function registerWebTools(ctx: PluginContext): void {
  registerToolSafe(ctx, ceulenTool({
    name: 'web_extract',
    description: 'Fetch a public URL and return its readable text, title, and status. Use after web_search when the snippet is not enough. HTML is stripped to text; scripts and styles are removed.',
    parameters: objectSchema({
      url: { type: 'string', description: 'Public HTTP(S) URL.' },
      maxChars: { type: 'integer', description: 'Maximum characters returned (default 12000, max 40000).' },
      links: { type: 'boolean', description: 'Include same-page links.' },
    }, ['url']),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { url: string; maxChars?: number; links?: boolean }
      const result = await fetchPage(ctx, args.url, exec.signal)
      if (result.body.kind === 'text') return clampText(result.body.content, args.maxChars ?? 12_000)
      const parsed = htmlToText(result.body.content)
      const limit = Math.max(500, Math.min(args.maxChars ?? 12_000, 40_000))
      const header = [
        `URL: ${result.url}`,
        `Status: ${result.statusCode}${result.truncated ? ' (body truncated by provider)' : ''}`,
        parsed.title.length > 0 ? `Title: ${parsed.title}` : '',
      ].filter(Boolean).join('\n')
      const linkBlock = args.links === true && parsed.links.length > 0
        ? `\n\nLinks:\n${parsed.links.slice(0, 40).map(link => `- ${link}`).join('\n')}`
        : ''
      return `${header}\n\n${clampText(parsed.text, limit)}${linkBlock}`
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_map',
    description: 'List links reachable from one public page (same origin first). Use to discover documentation pages before extracting them.',
    parameters: objectSchema({
      url: { type: 'string', description: 'Public HTTP(S) URL.' },
      limit: { type: 'integer', description: 'Max links (default 60, max 200).' },
    }, ['url']),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { url: string; limit?: number }
      const result = await fetchHtmlPage(ctx, args.url, exec.signal)
      if (result.body.kind !== 'html') throw new Error('web_map needs an HTML page')
      const parsed = htmlToText(result.body.content)
      const base = new URL(result.url)
      const seen = new Set<string>()
      const same: string[] = []
      const other: string[] = []
      for (const link of parsed.links) {
        try {
          const absolute = new URL(link, base).href
          if (!/^https?:/.test(absolute) || seen.has(absolute)) continue
          seen.add(absolute)
          ;(new URL(absolute).origin === base.origin ? same : other).push(absolute)
        } catch {
          // Ignore malformed links.
        }
      }
      const limit = Math.max(1, Math.min(args.limit ?? 60, 200))
      const list = [...same, ...other].slice(0, limit)
      return list.length === 0 ? 'No links found.' : list.join('\n')
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_screenshot',
    description: 'Capture a page with local headless Chrome. Returns the screenshot as an image when the attachment store is mounted, otherwise saves a PNG and returns its path. Supports public http(s) URLs, localhost/private dev servers, and workspace file:// URLs. Images do not pass through codemode — call this directly when you need to see the page.',
    parameters: SCREENSHOT_PARAMETERS,
    contract: { normalize: normalizeScreenshotArgs },
    outputSchema: IMAGE_RESULT_SCHEMA,
    render: imageRender,
    timeoutMs: 60_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { url: string; width?: number; height?: number; fullPage?: boolean; reducedMotion?: boolean; waitForSec?: number }
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      assertCaptureScope(args.url, cwd)
      const capture = await captureScreenshot({
        url: args.url,
        width: args.width,
        height: args.height,
        fullPage: args.fullPage,
        reducedMotion: args.reducedMotion,
        waitForSec: args.waitForSec,
        signal: exec.signal,
        timeoutMs: 45_000,
      })
      const saved = await saveScreenshot(ctx, capture.base64, `screenshot-${new URL(args.url).hostname || 'page'}`)
      const ignored = ignoredNote('web_screenshot', raw, SCREENSHOT_PARAMETERS)
      return ignored === '' ? saved : { ...saved, text: `${saved.text}\n${ignored}` }
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_pdf',
    description: 'Render a page to PDF with local headless Chrome and save it. Returns the PDF file path. Use for reports, invoices, or archiving a rendered page.',
    parameters: objectSchema({
      url: { type: 'string', description: 'http(s) or workspace file:// URL.' },
      reducedMotion: { type: 'boolean', description: 'Force prefers-reduced-motion: reduce.' },
    }, ['url']),
    outputSchema: { type: 'string' },
    timeoutMs: 60_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { url: string; reducedMotion?: boolean }
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      assertCaptureScope(args.url, cwd)
      const capture = await capturePdf({ url: args.url, reducedMotion: args.reducedMotion, signal: exec.signal, timeoutMs: 45_000 })
      const file = await savePdfFile(capture.base64, `page-${new URL(args.url).hostname || 'page'}`)
      return `PDF saved to ${file} (${capture.size} bytes).`
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_interact',
    description: 'Drive a real headless Chrome page: click, type, press keys, evaluate JS, wait, answer dialogs, and capture a final screenshot. One call = one browser lifecycle. Steps use exactly one action key each: {click:"selector"}, {type:{selector,text}}, {press:"Enter"}, {evaluate:"js",label?}, {wait_for:number|selector}, {dialog:"accept"|"dismiss"}, {screenshot:true}. Images do not pass through codemode — call this directly when you need to see the page.',
    parameters: INTERACT_PARAMETERS,
    contract: { normalize: normalizeInteractArgs },
    outputSchema: IMAGE_RESULT_SCHEMA,
    render: imageRender,
    timeoutMs: 120_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as {
        url: string
        steps?: InteractStep[]
        viewport?: { width: number; height?: number; device_scale_factor?: number }
        reducedMotion?: boolean
        waitForSec?: number
        stepTimeoutMs?: number
        grant?: string[]
      }
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      assertCaptureScope(args.url, cwd)
      const steps = args.steps ?? []
      validateSteps(steps)
      const result = await runInteraction({
        url: args.url,
        steps,
        viewport: args.viewport,
        reducedMotion: args.reducedMotion,
        waitForSec: args.waitForSec,
        stepTimeoutMs: args.stepTimeoutMs,
        grant: args.grant,
        signal: exec.signal,
      })
      const lines = result.outcomes.map(outcome => {
        const value = (outcome as { value?: unknown }).value
        const suffix = outcome.error !== undefined
          ? `: ${outcome.error}`
          : value === undefined ? '' : ` = ${JSON.stringify(value)}`
        return `${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.label}${suffix}`
      })
      if (result.navigatedTo !== undefined) lines.push(`navigated to ${result.navigatedTo}`)
      if (result.consoleErrors !== undefined && result.consoleErrors.length > 0) lines.push(`console errors: ${result.consoleErrors.slice(0, 5).join(' | ')}`)
      if (result.dialogs !== undefined && result.dialogs.length > 0) lines.push(`dialogs: ${result.dialogs.join('; ')}`)
      if (result.probe.scrollWidth !== undefined) lines.push(`page width ${result.probe.scrollWidth}px · viewport ${result.probe.innerWidth ?? '?'}px`)
      const ignored = ignoredNote('web_interact', raw, INTERACT_PARAMETERS)
      if (ignored !== '') lines.push(ignored)
      const failed = result.outcomes.some(outcome => !outcome.ok)
      const screenshot = result.screenshot === undefined
        ? { text: 'No screenshot returned.' }
        : await saveScreenshot(ctx, result.screenshot, `interact-${new URL(args.url).hostname || 'page'}`, !failed)
      const text = `${lines.join('\n')}\n\n${screenshot.text}`
      if (failed) throw new Error(text)
      return { text, ...(screenshot.image === undefined ? {} : { image: screenshot.image }) }
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_chat',
    description: 'One-off chat completion via the ChatGPT web tier (default when a credential is configured: codex login / CHATGPT_WEB_AUTH_KEY) or any OpenAI-compatible gateway (WEB_CHAT_API_BASE_URL). Non-streaming Q&A; not a provider switch — use /model for that.',
    parameters: objectSchema({
      prompt: { type: 'string', description: 'The question or instruction.' },
      provider: { type: 'string', enum: ['chatgpt', 'gateway'], description: 'chatgpt = ChatGPT web (codex login / CHATGPT_WEB_AUTH_KEY); gateway = WEB_CHAT_API_BASE_URL. Default: chatgpt when configured, else gateway.' },
      model: { type: 'string', description: 'Model id (chatgpt: defaults to the model in ~/.codex/config.toml; gateway: the gateway default).' },
      system: { type: 'string', description: 'Optional system prompt.' },
      timeout_ms: { type: 'integer', description: 'Request timeout (default 120000, 10s-5min).' },
    }, ['prompt']),
    outputSchema: { type: 'string' },
    timeoutMs: 300_000,
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { prompt: string; provider?: 'chatgpt' | 'gateway'; model?: string; system?: string; timeout_ms?: number }
      const cwd = exec.agent?.session.header?.cwd ?? process.cwd()
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 120_000, 10_000), 300_000)
      const chatGpt = loadChatGptAuth(cwd)
      const wantChatGpt = args.provider === 'chatgpt' || (args.provider === undefined && chatGpt.auth !== null)
      if (wantChatGpt) {
        if (chatGpt.auth === null) {
          throw new Error(`ChatGPT web chat is not configured. ${chatGpt.problem ?? 'Run `codex login` (reads ~/.codex/auth.json) or set CHATGPT_WEB_AUTH_KEY; provider=gateway uses WEB_CHAT_API_BASE_URL instead.'}`)
        }
        try {
          const result = await chatgptWebChat({
            auth: chatGpt.auth,
            prompt: args.prompt,
            ...(args.system === undefined ? {} : { system: args.system }),
            ...(args.model === undefined ? {} : { model: args.model }),
            cwd,
            timeoutMs,
            signal: exec.signal,
          })
          return `Model: ${result.model ?? 'chatgpt default'}\n\n${result.text}`
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw error
          throw new Error(describeChatGptError(error))
        }
      }
      const config = loadChatConfig(cwd)
      if (config === null) {
        throw new Error('web_chat gateway is not configured: set WEB_CHAT_API_BASE_URL (and WEB_CHAT_API_KEY) in the env or the DSH credential store, or run `codex login` for the ChatGPT web tier.')
      }
      try {
        const result = await chatgptChat({
          baseUrl: config.baseUrl,
          ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
          prompt: args.prompt,
          ...(args.system === undefined ? {} : { system: args.system }),
          ...(args.model === undefined ? {} : { model: args.model }),
          timeoutMs,
          signal: exec.signal,
        })
        return `Model: ${result.model ?? 'gateway default'}\n\n${result.text}`
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error
        throw new Error(describeChatApiError(error))
      }
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_status',
    description: 'Show which web backends are configured and whether the native web service is mounted.',
    parameters: objectSchema({}),
    outputSchema: { type: 'string' },
    concurrencySafe: true,
    async execute() {
      const web = ctx.get('web', false) !== undefined
      const brave = credential('BRAVE_API_KEY')
      const braveStatus = brave.value === undefined ? 'unset' : `set (${brave.source === 'dsh-credential' ? 'credential store' : 'env'})`
      const chatGpt = loadChatGptAuth()
      const chatGptStatus = chatGpt.auth === null
        ? `not configured${chatGpt.problem === undefined ? '' : ` (${chatGpt.problem})`}`
        : `ready (${chatGpt.auth.plan ?? 'plan unknown'}${chatGpt.auth.email === undefined ? '' : `, ${chatGpt.auth.email}`})`
      const chatConfig = loadChatConfig()
      return [
        `web service: ${web ? 'mounted (native fetch policy applies)' : 'not mounted (direct fetch with a public-URL guard)'}`,
        `brave provider: ${webProviders.brave ? 'registered' : 'not registered'}`,
        `fetch fallback provider: ${webProviders.fallback ? `registered (${FALLBACK_FETCH_PROVIDER_ID}: DeepSeek Markdown, local HTTP on failure)` : 'not registered'}`,
        `BRAVE_API_KEY: ${braveStatus}`,
        `chat: chatgpt ${chatGptStatus}; gateway ${chatConfig === null ? 'not configured' : chatConfig.baseUrl}`,
        'Pin search with web.searchProvider=brave and fetch with web.fetchProvider=deepseek-fetch-fallback in the profile patch; without a pin a single usable provider auto-selects.',
        'Ceulen extras available here: web_extract, web_map, web_screenshot, web_pdf, web_interact, web_chat, web_status.',
        `Chrome: ${findChromeBinary() ?? 'not found (set CHROME_PATH)'}`,
        'Gemini research and image generation are still gaps.',
      ].join('\n')
    },
  }))

}
