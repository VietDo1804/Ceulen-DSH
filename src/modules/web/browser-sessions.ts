/**
 * Named browser sessions for `web_interact`: one Chrome page kept alive across
 * calls, so a later call continues where the last one stopped (login, clicks,
 * scroll, SPA state) instead of re-launching and replaying the steps.
 *
 * Measured 2026-11-01..20: 87% of web_interact calls ran in turns with 4+
 * calls; 388 of 470 consecutive pairs reopened the same URL and 79 replayed the
 * previous call's click/type prefix to get back to where it was.
 *
 * Lifetime: per owner (the calling agent session) and name; closed by
 * `close: true`, after IDLE_MS without a call, when the owner's agent is
 * disposed, when MAX_LIVE is exceeded (least recently used goes first), on
 * process exit, and after a call that timed out or was aborted (the renderer
 * may be wedged).
 */
import {
  applyEmulation,
  navigatePage,
  openPage,
  resetCallState,
  runOnPage,
  type InteractStep,
  type InteractionResult,
  type PageHandle,
  type ViewportOpts,
  type WsFactory,
} from '../../vendor/ceulen/web/cdp.js'

export const IDLE_MS = 10 * 60_000
export const MAX_LIVE = 4

interface Live {
  key: string
  name: string
  page: PageHandle
  /** The URL the page was last asked to load; a call naming another one navigates. */
  url: string
  lastUsed: number
  idle?: ReturnType<typeof setTimeout>
}

const LIVE = new Map<string, Live>()

function keyOf(owner: string, name: string): string {
  return `${owner}\u0000${name}`
}

/** Same page for the purpose of reuse: origin, path and query; the hash is client state. */
export function sameDocument(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search
  } catch {
    return a === b
  }
}

function drop(live: Live): void {
  if (live.idle !== undefined) clearTimeout(live.idle)
  if (LIVE.get(live.key) === live) LIVE.delete(live.key)
  live.page.cleanup()
}

function touch(live: Live, idleMs: number): void {
  live.lastUsed = Date.now()
  if (live.idle !== undefined) clearTimeout(live.idle)
  live.idle = setTimeout(() => drop(live), idleMs)
  live.idle.unref?.()
}

let exitHooked = false
function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  // Chrome is a child process: without this it would outlive DSH.
  process.once('exit', closeAllSessions)
}

export interface SessionCall {
  owner: string
  name: string
  url: string
  steps: InteractStep[]
  splitSteps?: number
  viewport?: ViewportOpts
  reducedMotion?: boolean
  waitForSec?: number
  stepTimeoutMs?: number
  grant?: string[]
  screenshot?: boolean
  close?: boolean
  signal?: AbortSignal
  /** Tests only. */
  wsFactory?: WsFactory
  idleMs?: number
}

export interface SessionResult extends InteractionResult {
  session: { name: string; state: 'opened' | 'reused' | 'navigated'; closed: boolean; closedReason?: string }
}

/** Calls on one session key run one at a time, including the call that opens it. */
const QUEUES = new Map<string, Promise<unknown>>()

/** Run one call on the named page, opening it first when it is not live. */
export async function runInSession(call: SessionCall): Promise<SessionResult> {
  const key = keyOf(call.owner, call.name)
  const run = async (): Promise<SessionResult> => {
    call.signal?.throwIfAborted()
    let live = LIVE.get(key)
    let state: SessionResult['session']['state'] = 'reused'
    if (live === undefined) {
      if (LIVE.size >= MAX_LIVE) {
        const oldest = [...LIVE.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (oldest !== undefined) drop(oldest)
      }
      const page = await openPage({ viewport: call.viewport, reducedMotion: call.reducedMotion, wsFactory: call.wsFactory })
      live = { key, name: call.name, page, url: call.url, lastUsed: Date.now() }
      LIVE.set(key, live)
      hookExit()
      state = 'opened'
    }
    const current = live
    const onAbort = () => drop(current)
    call.signal?.addEventListener('abort', onAbort, { once: true })
    let closedReason: string | undefined
    let result: InteractionResult
    try {
      resetCallState(current.page)
      if (state === 'opened') {
        await navigatePage(current.page, call.url, call.waitForSec)
      } else {
        if (call.viewport !== undefined || call.reducedMotion !== undefined) {
          await applyEmulation(current.page, { viewport: call.viewport, reducedMotion: call.reducedMotion })
        }
        if (!sameDocument(current.url, call.url)) {
          await navigatePage(current.page, call.url, call.waitForSec)
          current.url = call.url
          state = 'navigated'
        } else if (call.waitForSec) {
          await new Promise(resolve => setTimeout(resolve, Math.round(call.waitForSec! * 1000)))
        }
      }
      result = await runOnPage(current.page, {
        steps: call.steps,
        splitSteps: call.splitSteps,
        grant: call.grant,
        stepTimeoutMs: call.stepTimeoutMs,
        screenshot: call.screenshot,
        // Sessions exist only on the tuned web_interact.
        extended: true,
        signal: call.signal,
      })
      if (result.outcomes.some(outcome => !outcome.ok && /timed out after/.test(outcome.error ?? ''))) {
        closedReason = 'a step timed out, so the page may be wedged'
      }
    } catch (error) {
      closedReason = 'the call failed before its steps finished'
      throw error
    } finally {
      call.signal?.removeEventListener('abort', onAbort)
      if (call.signal?.aborted) closedReason = 'the call was aborted'
      if (call.close === true || closedReason !== undefined) drop(current)
      else touch(current, call.idleMs ?? IDLE_MS)
    }
    const note = closedReason ?? (call.close === true ? 'close: true' : undefined)
    return { ...result, session: { name: call.name, state, closed: note !== undefined, ...(note === undefined ? {} : { closedReason: note }) } }
  }
  const queued = (QUEUES.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
  QUEUES.set(key, queued)
  try {
    return await queued
  } finally {
    if (QUEUES.get(key) === queued) QUEUES.delete(key)
  }
}

/** Names of the owner's live sessions (for the result line and tests). */
export function liveSessionNames(owner: string): string[] {
  return [...LIVE.values()].filter(live => live.key.startsWith(`${owner}\u0000`)).map(live => live.name)
}

/** Close every session the owner opened; returns how many were closed. */
export function closeOwnerSessions(owner: string): number {
  const mine = [...LIVE.values()].filter(live => live.key.startsWith(`${owner}\u0000`))
  for (const live of mine) drop(live)
  return mine.length
}

export function closeAllSessions(): void {
  for (const live of [...LIVE.values()]) drop(live)
}
