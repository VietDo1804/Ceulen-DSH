import path from 'node:path'
import type { PluginContext, ToolDefinition } from '../../core/types.js'
import { ceulenTool, clampText, objectSchema, registerToolSafe, cwdOf } from '../../core/tools.js'
import { credential } from '../../core/credentials.js'
import { findChromeBinary, capturePdf, captureScreenshot } from '../../vendor/ceulen/web/chrome.js'
import { PLAIN_STEP_KEYS, prepareSteps, runInteraction, type InteractStep } from '../../vendor/ceulen/web/cdp.js'
import { registerWithVariant } from '../../core/variants.js'
import { IDLE_MS, runInSession, type SessionResult } from './browser-sessions.js'
import { chatgptWebChat, describeChatGptError, loadChatGptAuth } from '../../vendor/ceulen/web/chatgpt.js'
import { chatgptChat, describeChatApiError, loadChatConfig } from '../../vendor/ceulen/web/chatapi.js'
import { loadGeminiWebConfig } from '../../vendor/ceulen/web/gemini.js'
import {
  describeImageApiError,
  generateImageWithFallback,
  loadImageApiConfig,
  loadImageRateConfig,
  type ImageProvider,
} from '../../vendor/ceulen/web/imageapi.js'
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
  screenshot: { type: 'boolean', description: 'false: no final screenshot when every step succeeds (read-only evaluate probes). A failed step still returns one.' },
  session: { type: 'string', description: 'Keep the page alive under this name for later calls (state kept: login, clicks, scroll). Same name + same url continues on the page as it is; another url navigates it. Closes after 10 min idle.' },
  close: { type: 'boolean', description: 'With session: close that page after this call.' },
}, ['url'], true)

/** web_interact's parameters before the flash tuning, for every other route. */
const PLAIN_INTERACT_PARAMETERS = objectSchema({
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
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { url: string; maxChars?: number; links?: boolean }
      const result = await fetchPage(ctx, args.url, exec.signal)
      const limit = Math.max(500, Math.min(args.maxChars ?? 12_000, 40_000))
      if (result.body.kind === 'text') return clampText(result.body.content, limit)
      const parsed = htmlToText(result.body.content)
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
      const cwd = cwdOf(exec)
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
    timeoutMs: 60_000,
    concurrencySafe: false,
    async execute(raw, exec) {
      const args = raw as { url: string; reducedMotion?: boolean }
      const cwd = cwdOf(exec)
      assertCaptureScope(args.url, cwd)
      const capture = await capturePdf({ url: args.url, reducedMotion: args.reducedMotion, signal: exec.signal, timeoutMs: 45_000 })
      const file = await savePdfFile(capture.base64, `page-${new URL(args.url).hostname || 'page'}`)
      return `PDF saved to ${file} (${capture.size} bytes).`
    },
  }))

  registerWithVariant(ctx, interactTool(ctx, false), interactTool(ctx, true))

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
    timeoutMs: 300_000,
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as { prompt: string; provider?: 'chatgpt' | 'gateway'; model?: string; system?: string; timeout_ms?: number }
      const cwd = cwdOf(exec)
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
    name: 'web_image',
    description: 'Generate images from a text prompt and write PNG files. Provider "auto" uses ChatGPT web image generation over the existing OpenAI subscription credential (codex login / CHATGPT_WEB_AUTH_KEY — no API key needed), then Z.AI (ZAI_API_KEY) and any OpenAI-compatible images endpoint (WEB_IMAGE_API_BASE_URL). Returns the written paths.',
    parameters: objectSchema({
      prompt: { type: 'string', description: 'What to draw: subject, setting, style, composition, constraints.' },
      provider: { type: 'string', enum: ['auto', 'chatgpt', 'zai', 'custom', 'gemini'], description: 'Force one backend instead of the auto chain.' },
      model: { type: 'string', description: 'Provider-specific model override.' },
      n: { type: 'integer', description: 'How many images (default 1). The chatgpt leg generates one per call, sequentially.' },
      size: { type: 'string', description: 'WxH for zai/custom (the chatgpt leg ignores it).' },
      out_dir: { type: 'string', description: 'Directory for the PNGs (default <cwd>/output/imagegen).' },
      timeout_ms: { type: 'integer', description: 'Per-provider timeout (default 300000, max 600000).' },
    }, ['prompt']),
    timeoutMs: 600_000,
    concurrencySafe: true,
    async execute(raw, exec) {
      const args = raw as {
        prompt: string
        provider?: 'auto' | ImageProvider
        model?: string
        n?: number
        size?: string
        out_dir?: string
        timeout_ms?: number
      }
      const cwd = cwdOf(exec)
      const outDir = args.out_dir === undefined ? path.join(cwd, 'output', 'imagegen') : path.resolve(cwd, args.out_dir)
      const chatGpt = loadChatGptAuth(cwd)
      try {
        const result = await generateImageWithFallback({
          prompt: args.prompt,
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.n === undefined ? {} : { n: args.n }),
          ...(args.size === undefined ? {} : { size: args.size }),
          outDir,
          provider: args.provider ?? 'auto',
          geminiConfig: loadGeminiWebConfig(cwd),
          apiConfig: loadImageApiConfig(cwd),
          rateConfig: loadImageRateConfig(cwd),
          chatgptAuth: chatGpt.auth,
          chatgptProblem: chatGpt.problem,
          timeoutMs: Math.min(Math.max(args.timeout_ms ?? 300_000, 10_000), 600_000),
          signal: exec.signal,
        })
        const lines = [
          `provider: ${result.provider}${result.model === undefined ? '' : ` (${result.model})`}`,
          ...result.paths.map(file => `file: ${file}`),
        ]
        if (result.note !== undefined) lines.push(`note: ${result.note}`)
        if (result.attempts.length > 0) lines.push(`skipped: ${result.attempts.join('; ')}`)
        return lines.join('\n')
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error
        throw new Error(describeImageApiError(error))
      }
    },
  }))

  registerToolSafe(ctx, ceulenTool({
    name: 'web_status',
    description: 'Show which web backends are configured and whether the native web service is mounted.',
    parameters: objectSchema({}),
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
        'Ceulen extras available here: web_extract, web_map, web_screenshot, web_pdf, web_interact, web_chat, web_image, web_status.',
        `Chrome: ${findChromeBinary() ?? 'not found (set CHROME_PATH)'}`,
        `image: ${chatGptStatus}${loadImageApiConfig().zai === undefined ? '' : ' + zai'}${loadImageApiConfig().custom === undefined ? '' : ' + custom'} via web_image`,
        'Gemini research remains a gap; image generation runs through the chatgpt leg above.',
      ].join('\n')
    },
  }))

}

/** Before the flash tuning; kept word for word for every other route. */
const PLAIN_INTERACT_DESCRIPTION = 'Drive a real headless Chrome page: click, type, press keys, evaluate JS, wait, answer dialogs, and capture a final screenshot. One call = one browser lifecycle. Steps use exactly one action key each: {click:"selector"}, {type:{selector,text}}, {press:"Enter"}, {evaluate:"js",label?}, {wait_for:number|selector}, {dialog:"accept"|"dismiss"}, {screenshot:true}. Images do not pass through codemode — call this directly when you need to see the page.'

const TUNED_INTERACT_DESCRIPTION = [
  'Drive a real headless Chrome page: click, hover, type, press keys, evaluate JS, wait, answer dialogs, and capture a final screenshot.',
  'Steps use exactly one action key each: {click:"selector"}, {hover:"selector"}, {type:{selector,text}}, {press:"Enter"}, {evaluate:"js",label?}, {wait_for:number|selector}, {dialog:"accept"|"dismiss"}, {screenshot:true}. A selector is CSS or text=Label (the deepest visible element containing that text).',
  'Without `session` one call = one browser lifecycle and nothing survives it. For several checks on one page, pass `session:"name"`: the next call with that name continues on the same page (state kept, no re-navigation for the same url); end with `close:true`.',
  'Only reading values? Pass `screenshot:false` to skip the image, e.g. {url, session:"app", screenshot:false, steps:[{evaluate:"document.title"}]}.',
  'Images do not pass through codemode — call this directly when you need to see the page.',
].join(' ')

/**
 * `web_interact` as every route sees it (`tuned` false: the description,
 * schema and behaviour from before the flash tuning) or as the steered routes
 * see it (`tuned`: named sessions, hover, `text=`, `screenshot:false`, and a
 * pointer move before each click). See core/variants.ts.
 */
function interactTool(ctx: PluginContext, tuned: boolean): ToolDefinition {
  const parameters = tuned ? INTERACT_PARAMETERS : PLAIN_INTERACT_PARAMETERS
  return ceulenTool({
    name: 'web_interact',
    description: tuned ? TUNED_INTERACT_DESCRIPTION : PLAIN_INTERACT_DESCRIPTION,
    parameters,
    contract: { normalize: raw => normalizeInteractArgs(raw, tuned) },
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
        screenshot?: boolean
        session?: string
        close?: boolean
      }
      const cwd = cwdOf(exec)
      assertCaptureScope(args.url, cwd)
      // Validated before Chrome launches, so a bad step costs no browser.
      const { steps, splitSteps } = prepareSteps(args.steps ?? [], tuned ? undefined : PLAIN_STEP_KEYS)
      const name = tuned && typeof args.session === 'string' ? args.session.trim() : ''
      const common = {
        url: args.url,
        steps,
        viewport: args.viewport,
        reducedMotion: args.reducedMotion,
        waitForSec: args.waitForSec,
        stepTimeoutMs: args.stepTimeoutMs,
        grant: args.grant,
        ...(tuned ? { screenshot: args.screenshot, extended: true } : {}),
        signal: exec.signal,
      }
      const owner = String(exec.agent?.session?.id ?? 'process')
      const result = name === ''
        ? await runInteraction(common)
        : await runInSession({ ...common, splitSteps, owner, name, close: args.close === true })
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
      if ('session' in result) {
        const live = (result as SessionResult).session
        const how = live.state === 'opened' ? 'opened' : live.state === 'navigated' ? 'reused, navigated to the new url' : 'reused, page state kept'
        lines.push(live.closed
          ? `session "${live.name}": ${how}; now closed (${live.closedReason})`
          : `session "${live.name}": ${how}; stays open ${IDLE_MS / 60_000} min idle (close:true ends it)`)
      }
      const ignored = ignoredNote('web_interact', raw, parameters)
      if (ignored !== '') lines.push(ignored)
      const failed = result.outcomes.some(outcome => !outcome.ok)
      const screenshot = result.screenshot === undefined
        ? { text: tuned && args.screenshot === false ? 'No screenshot (screenshot: false).' : 'No screenshot returned.' }
        : await saveScreenshot(ctx, result.screenshot, `interact-${new URL(args.url).hostname || 'page'}`, !failed)
      const text = `${lines.join('\n')}\n\n${screenshot.text}`
      if (failed) throw new Error(text)
      return { text, ...(screenshot.image === undefined ? {} : { image: screenshot.image }) }
    },
  })
}
