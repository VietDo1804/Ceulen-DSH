import { randomUUID } from 'node:crypto'
import type { AgentLike, PluginContext } from '../../core/types.js'
import { isModuleEnabled, loadSettingsSync, updateSettings, type ReasoningEffort } from '../../core/settings.js'
import { parseRoute, streamText, type LlmRoute } from '../../core/llm.js'
import { ceulenTool, clampText, objectSchema, registerCommandSafe, registerToolSafe, tuiStatusPublisher } from '../../core/tools.js'
import { createGuard, guardCheck, nextCycle, parseReviewOutput, type GuardState, type Severity } from '../../vendor/ceulen/advisor/emission-guard.js'
import { sessionMovedOn, shelveLateNote } from '../steering/index.js'
import { SYSTEM } from '../../vendor/ceulen/advisor/system-prompt.js'
import { logLine } from '../../core/log.js'
import { gitEvidence, touchedPaths } from './evidence.js'
import { CONSULT_BUDGET, renderTurn, toolCallsInTurn, WATCH_BUDGET } from './transcript.js'

export const name = 'ceulen-advisor'
export const inject = ['tools', 'commands', 'llm']

type Route = Omit<LlmRoute, 'reasoningEffort'> & { reasoningEffort?: ReasoningEffort }

interface DeliveredNote {
  severity: Severity
  note: string
  at: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** How many turns a delivered note may be re-delivered in (vendored guard). */
const REDELIVERY_WINDOW = 2

function routeListFor(agent: AgentLike | undefined, settings: ReturnType<typeof loadSettingsSync>): Route[] {
  const sessionId = agent === undefined ? undefined : String(agent.session.id)
  const withSession = (route: Route): Route => sessionId === undefined ? route : { ...route, sessionId }
  const routes: Route[] = []
  if (settings.advisor.provider !== null && settings.advisor.model !== null) {
    routes.push(withSession({
      provider: settings.advisor.provider,
      model: settings.advisor.model,
      ...(settings.advisor.reasoningEffort === null ? {} : { reasoningEffort: settings.advisor.reasoningEffort }),
    }))
  }
  for (const candidate of settings.advisor.fallbacks) {
    const route = parseRoute(candidate)
    if (route !== undefined) routes.push(withSession(route))
  }
  if (routes.length === 0 && agent?.options.provider !== undefined && agent.options.model !== undefined) {
    routes.push(withSession({
      provider: agent.options.provider,
      model: agent.options.model,
      ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort as ReasoningEffort }),
    }))
  }
  const seen = new Set<string>()
  return routes.filter(route => {
    const key = `${route.provider}/${route.model}:${route.reasoningEffort ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Try each route in order until one returns text; failures are collected, not thrown.
 *
 * ponytail: max-effort reasoning burns thousands of hidden tokens before the first
 * visible character, and on zai's openai-completions path those count against
 * max_tokens (pi-ai only adds thinking headroom on anthropic/bedrock). The old
 * 700-token cap ended the completion inside thinking ("empty response") and the
 * 30s abort killed slower runs. 18k = pi-ai's 16384 "max" thinking budget + answer
 * room; 300s covers a measured 295s max-effort review of a heavy transcript.
 */
async function streamChain(
  ctx: PluginContext,
  routes: Route[],
  system: string,
  user: string,
  signal?: AbortSignal,
  timeoutMs = 300_000,
  maxTokens = 18_000,
): Promise<{ text: string; route: Route }> {
  const failures: string[] = []
  for (const route of routes) {
    // A cancelled review must not fall through to the next route.
    if (signal?.aborted) throw new Error('aborted before a route answered')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
    try {
      const text = await streamText(ctx, route, system, user, combined, maxTokens)
      if (text.length > 0) return { text, route }
      failures.push(`${route.provider}/${route.model}: empty response`)
    } catch (error) {
      if (signal?.aborted) throw error
      failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
    // A silent fall-through hid an expired primary credential for a whole day:
    // every skipped route leaves a line, even when a later one answers.
    logLine('advisor', `route failed ${failures[failures.length - 1]}`)
  }
  throw new Error(`no reviewer route answered (${failures.join('; ')})`)
}

function deliver(agent: AgentLike, severity: Severity, note: string, reviewer: string, reviewedSeq?: number): void {
  const summary = `${severity}: ${clampText(note, 120)}`
  const instruction = severity === 'blocker'
    ? 'Fix this before continuing.'
    : severity === 'concern'
      ? 'Address this or state why it does not apply.'
      : 'Consider whether this applies; no response needed if it does not.'
  const text = `[${reviewer.toUpperCase()} advisor · ${severity}] ${note}\n\n${instruction}`
  const message = {
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'ceulen-advisor', form: 'notice', summary },
  }
  // The review is slow; the user may have sent a new prompt while it ran.
  // Injecting a nit mid-task buries it under the new work, so a note about a
  // superseded turn parks as a harness follow-up: delivered after the agent
  // finishes the current task, then the agent comes back to the note.
  if (severity === 'nit' && sessionMovedOn(agent, reviewedSeq)) {
    if (shelveLateNote(agent, message, summary)) {
      logLine('advisor', `shelved late nit (seq ${reviewedSeq} → ${agent.session.seq})`)
      return
    }
    // Shelf unavailable: fall through to the immediate path below.
  }
  // ponytail: a nit lands as a plain tail-append, not an inbox inject — an
  // inject parks in the next-step queue and the TUI shows nothing until the
  // next prompt claims it; a direct append renders the block the moment the
  // review lands and the model still reads it on its next request. No wake,
  // no extra turn.
  if (severity === 'nit' && typeof agent.session.append === 'function') {
    try {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      return
    } catch {
      // Older harness or rejected append: fall through to the inbox path.
    }
  }
  try {
    if (severity === 'nit') agent.inject(message)
    else agent.followup(message)
  } catch (error) {
    // Never fall back to source.kind 'user': renderTurn would pin the note as
    // the user's own request at the next review. Losing one note is cheaper.
    logLine('advisor', `note not delivered: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx: PluginContext): void {
  const settings = loadSettingsSync()
  if (!isModuleEnabled('advisor', settings)) return

  const guard: GuardState = createGuard()
  const reviewing = new Set<string>()
  const seenRunning = new Set<string>()
  const lastReviewed = new Map<string, number>()
  let delivered: DeliveredNote | undefined

  // Root-activation status writes are rejected by the TUI; publish through an
  // injected child activation (same fix as the usage module).
  const publish = tuiStatusPublisher(ctx, 'ceulen:advisor')
  const publishStatus = (text: string | undefined): void => {
    if (!loadSettingsSync().advisor.showStatus && text !== undefined) return
    publish(text)
  }

  let clearTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleClear = (ms: number): void => {
    clearTimer?.unref?.()
    if (clearTimer !== undefined) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => publishStatus(undefined), ms)
    clearTimer.unref?.()
  }

  const review = async (agent: AgentLike, signal?: AbortSignal): Promise<void> => {
    const current = loadSettingsSync()
    if (!current.advisor.watch) return
    const session = agent.session
    const key = String(session.id)
    if (reviewing.has(key)) return
    if (session.header?.parentSession !== undefined) return
    const messages = session.deriveMessages?.() ?? []
    if (messages.length === 0) return
    const toolCalls = toolCallsInTurn(messages)
    if (toolCalls < current.advisor.minToolCalls) return
    const lastIndex = messages.length - 1
    const seq = typeof session.seq === 'number' ? session.seq : lastIndex
    if (lastReviewed.get(key) === seq) return

    const routes = routeListFor(agent, current)
    if (routes.length === 0) {
      logLine('advisor', 'no reviewer route configured; review skipped')
      return
    }
    reviewing.add(key)
    const startedAt = Date.now()
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000)
    const abort = (): boolean => {
      if (signal?.aborted !== true) return false
      logLine('advisor', 'review aborted')
      publishStatus(undefined)
      return true
    }
    try {
      guard.reviewIndex += 1
      nextCycle(guard)
      publishStatus('advisor · reviewing…')
      const transcript = renderTurn(messages, WATCH_BUDGET)
      const evidence = await gitEvidence(session.header?.cwd, touchedPaths(messages), signal)
      const userPrompt = `Transcript of the latest turn:\n\n${transcript.text}${evidence.length > 0 ? `\n\n${evidence}` : ''}\n\nReturn exactly one JSON line, or nothing.`
      logLine('advisor', `review start seq=${seq} chars=${userPrompt.length} pinned=${transcript.pinned} evidence=${evidence.length}`)
      const { text: raw, route } = await streamChain(ctx, routes, SYSTEM, userPrompt, signal)
      if (abort()) return
      const routeLabel = `${route.provider}/${route.model}`
      lastReviewed.set(key, seq)
      const parsed = parseReviewOutput(raw)
      if (parsed === undefined) {
        logLine('advisor', `review done ${elapsed()}s route=${routeLabel} result=silent`)
        publishStatus('advisor · done — no issues')
        scheduleClear(5_000)
        return
      }
      const verdict = guardCheck(guard, parsed.severity, parsed.note, REDELIVERY_WINDOW)
      if (!verdict.accepted) {
        logLine('advisor', `review done ${elapsed()}s route=${routeLabel} result=suppressed`)
        logLine('advisor', `note suppressed (${verdict.reason})`)
        publishStatus('advisor · done — no note')
        scheduleClear(5_000)
        return
      }
      if (abort()) return
      delivered = { severity: verdict.severity, note: verdict.note, at: Date.now() }
      const label = `${verdict.severity}: ${clampText(verdict.note, 120)}`
      publishStatus(`advisor · ${label}`)
      scheduleClear(15_000)
      deliver(agent, verdict.severity, verdict.note, route.model, seq)
      logLine('advisor', `review done ${elapsed()}s route=${routeLabel} result=note`)
      logLine('advisor', `delivered ${verdict.severity}: ${clampText(verdict.note, 200)}`)
    } catch (error) {
      if (signal?.aborted) {
        logLine('advisor', 'review aborted')
      } else {
        logLine('advisor', `review failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      publishStatus(undefined)
    } finally {
      reviewing.delete(key)
    }
  }

  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string }) => {
    if (payload?.agent === undefined) return
    const key = String(payload.agent.session.id)
    if (payload.status === 'running') {
      seenRunning.add(key)
      return
    }
    if (payload.status !== 'idle' || !seenRunning.has(key)) return
    seenRunning.delete(key)
    setTimeout(() => {
      const run = async () => {
        try {
          if (typeof payload.agent!.runMaintenance === 'function') {
            await payload.agent!.runMaintenance(async signal => review(payload.agent!, signal))
          } else {
            await review(payload.agent!)
          }
        } catch {
          await sleep(0)
        }
      }
      void run()
    }, 150).unref?.()
  })

  registerCommandSafe(ctx, {
    name: 'advisor',
    description: 'Second-model reviewer: on/off/status/models, or set a model chain',
    input: { hint: '[on|off|status|models|model <provider/model,...>]' },
    async handler({ rawInput }) {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const action = args[0] ?? 'status'
      const current = loadSettingsSync()
      if (action === 'on') {
        await updateSettings(settings => {
          settings.advisor.watch = true
        })
        return { kind: 'success', text: 'Advisor enabled. It reviews settled work with a second model and may inject one note.' }
      }
      if (action === 'off') {
        await updateSettings(settings => {
          settings.advisor.watch = false
        })
        return { kind: 'success', text: 'Advisor disabled for this profile. The on-demand `advisor` tool keeps working.' }
      }
      if (action === 'model') {
        const chain = args.slice(1).join(' ').split(',').map(entry => entry.trim()).filter(Boolean)
        const parsed = chain.map(parseRoute).filter((route): route is Route => route !== undefined)
        if (parsed.length === 0) return { kind: 'error', text: 'usage: /advisor model provider/model[, provider/model…]' }
        await updateSettings(settings => {
          settings.advisor.provider = parsed[0]!.provider
          settings.advisor.model = parsed[0]!.model
          settings.advisor.reasoningEffort = parsed[0]!.reasoningEffort ?? null
          settings.advisor.fallbacks = chain.slice(1)
          settings.advisor.watch = true
        })
        return { kind: 'success', text: `Advisor chain: ${chain.join(' → ')}` }
      }
      if (action === 'models') {
        const primary = current.advisor.provider !== null && current.advisor.model !== null
          ? `${current.advisor.provider}/${current.advisor.model}${current.advisor.reasoningEffort === null ? '' : `:${current.advisor.reasoningEffort}`}`
          : '(parent route)'
        const chain = [primary, ...current.advisor.fallbacks]
        return { kind: 'success', text: `Advisor chain: ${chain.join(' → ')}\nwatch: ${current.advisor.watch}` }
      }
      if (action !== 'status') return { kind: 'error', text: 'usage: /advisor [on|off|status|models|model …]' }
      const last = delivered === undefined ? 'none this session' : `${delivered.severity} at ${new Date(delivered.at).toLocaleTimeString()}: ${clampText(delivered.note, 180)}`
      return {
        kind: 'success',
        text: [
          `Advisor: ${current.advisor.watch ? 'watching' : 'off'}${reviewing.size > 0 ? ' (reviewing…)' : ''}`,
          `status line: ${current.advisor.showStatus ? 'on' : 'off'}`,
          `route: ${current.advisor.provider !== null && current.advisor.model !== null ? `${current.advisor.provider}/${current.advisor.model}` : 'parent agent route'}`,
          `reasoning: ${current.advisor.reasoningEffort ?? 'auto'}`,
          `fallbacks: ${current.advisor.fallbacks.join(', ') || '(none)'}`,
          `min tool calls: ${current.advisor.minToolCalls}`,
          `last note: ${last}`,
          `guard: delivered ${guard.counts.delivered}, suppressed ${guard.counts.suppressed}`,
        ].join('\n'),
      }
    },
  })

  registerToolSafe(ctx, ceulenTool({
    name: 'advisor',
    description: 'Consult a second reviewer model on demand. Use for a second opinion on a risky change, a failed verification, or a design decision. The reviewer sees the recent transcript and returns one short note.',
    parameters: objectSchema({
      focus: { type: 'string', description: 'What to review or the question to ask. Defaults to the latest turn.' },
    }),
    outputSchema: { type: 'string' },
    concurrencySafe: false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('advisor needs an agent context')
      const current = loadSettingsSync()
      const routes = routeListFor(agent, current)
      if (routes.length === 0) throw new Error('no reviewer route: set /advisor model provider/model')
      const focus = String((args as { focus?: unknown }).focus ?? '').trim()
      const messages = agent.session.deriveMessages?.() ?? []
      const transcript = renderTurn(messages, CONSULT_BUDGET)
      const evidence = await gitEvidence(agent.session.header?.cwd, touchedPaths(messages), exec.signal)
      publishStatus('advisor · reviewing…')
      const startedAt = Date.now()
      try {
        const { text, route } = await streamChain(
          ctx,
          routes,
          'You are a second-opinion reviewer for a coding agent. You cannot use tools. Be concise: at most 5 sentences, evidence-based, no restating the question.',
          `${focus.length > 0 ? `Focus: ${focus}\n\n` : ''}Recent transcript:\n\n${transcript.text}${evidence.length > 0 ? `\n\n${evidence}` : ''}`,
          exec.signal,
        )
        publishStatus('advisor · done')
        scheduleClear(5_000)
        // The model cannot tell which route served it; name it so a smoke test
        // can check the configured primary actually answered.
        const routeLabel = `${route.provider}/${route.model}`
        logLine('advisor', `consult done ${Math.round((Date.now() - startedAt) / 1000)}s route=${routeLabel}`)
        return `${text}\n\n(reviewer: ${routeLabel})`
      } catch (error) {
        publishStatus(undefined)
        throw error
      }
    },
  }))

  logLine('advisor', `loaded (watch=${settings.advisor.watch}, route=${routeListFor(undefined, settings)[0]?.provider ?? 'parent'})`)
}
